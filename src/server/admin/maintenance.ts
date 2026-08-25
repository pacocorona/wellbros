/**
 * Notas de mantenimiento (solo SUPERUSER).
 *
 * Son informativas: se ven en el calendario de TODOS y NO bloquean reservas
 * (decisión de producto, §05). Por eso no tocan `week_slots` ni disparan
 * avisos: quien reserve una semana con mantenimiento anunciado lo hace sabiendo.
 *
 * Las tres escrituras —crear, editar y borrar— dejan rastro en la bitácora con
 * su propia acción. Cada una va DENTRO de la transacción que hace el cambio: o
 * quedan las dos filas, o no queda ninguna.
 */

import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { writeAudit, type AuditDetails } from "@/lib/audit";
import { addDaysISO, agruparDiasEnRangos, weekStartOf } from "@/lib/calendar-grid";
import type { Db } from "@/lib/db";

import {
  AdminError,
  type AdminActor,
  assertSuperuser,
  etiquetaDia,
  fechaCivil,
  isoDeFecha,
  parseOrThrow,
} from "./users";

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

const fechaISOSchema = z
  .string()
  .trim()
  .regex(ISO_FECHA, "La fecha debe ir en formato yyyy-MM-dd")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), "Fecha inexistente");

const textoNotaSchema = z
  .string()
  .trim()
  .min(3, "La nota necesita al menos 3 caracteres")
  .max(500, "La nota no puede pasar de 500 caracteres");

const crearNotaSchema = z
  .object({
    propertyId: z.uuid("Identificador de propiedad inválido"),
    startDate: fechaISOSchema,
    endDate: fechaISOSchema,
    note: textoNotaSchema,
  })
  // Mismo CHECK que la base (`maintenance_notes_date_range_check`), pero aquí
  // el error se puede mostrar en el formulario en vez de reventar la consulta.
  .refine((v) => v.startDate <= v.endDate, {
    message: "La nota termina antes de empezar",
    path: ["endDate"],
  });

export interface MaintenanceNoteRow {
  id: string;
  propertyId: string;
  propertyName: string;
  startDate: string;
  endDate: string;
  note: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

const SELECCION_NOTA = {
  id: true,
  propertyId: true,
  startDate: true,
  endDate: true,
  note: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  property: { select: { name: true } },
} as const;

type FilaNota = {
  id: string;
  propertyId: string;
  startDate: Date;
  endDate: Date;
  note: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  property: { name: string };
};

function aFila(nota: FilaNota): MaintenanceNoteRow {
  return {
    id: nota.id,
    propertyId: nota.propertyId,
    propertyName: nota.property.name,
    startDate: isoDeFecha(nota.startDate),
    endDate: isoDeFecha(nota.endDate),
    note: nota.note,
    createdById: nota.createdById,
    createdAt: nota.createdAt,
    updatedAt: nota.updatedAt,
  };
}

/**
 * Notas de una propiedad que se solapan con el rango pedido.
 * El solape es `inicio <= hasta AND fin >= desde`: una nota de tres semanas
 * debe aparecer también en el mes que solo la cruza.
 */
export async function listMaintenanceNotes({
  db,
  actor,
  propertyId,
  from,
  to,
}: {
  db: Db;
  actor: AdminActor;
  propertyId?: string;
  from?: string;
  to?: string;
}): Promise<MaintenanceNoteRow[]> {
  assertSuperuser(actor);

  const notas = await db.maintenanceNote.findMany({
    where: {
      ...(propertyId ? { propertyId } : {}),
      ...(to ? { startDate: { lte: fechaCivil(parseOrThrow(fechaISOSchema, to)) } } : {}),
      ...(from ? { endDate: { gte: fechaCivil(parseOrThrow(fechaISOSchema, from)) } } : {}),
    },
    select: SELECCION_NOTA,
    orderBy: { startDate: "asc" },
  });

  return notas.map(aFila);
}

/** Propiedad a la que se cuelga la nota, o `NOT_FOUND`. */
async function exigirPropiedad(
  db: Db,
  propertyId: string,
): Promise<{ id: string; name: string }> {
  const propiedad = await db.property.findUnique({
    where: { id: propertyId },
    select: { id: true, name: true },
  });
  if (!propiedad) throw new AdminError("NOT_FOUND", "La propiedad no existe.");
  return propiedad;
}

/** Cliente que basta para crear una nota y anotarla: encaja `prisma` y un `tx`. */
type ClienteNota = Pick<Prisma.TransactionClient, "maintenanceNote" | "auditLog">;

/**
 * Fila + bitácora, DENTRO de la transacción que se le pase.
 *
 * Es el cuerpo compartido de `createMaintenanceNote` y de
 * `createMaintenanceNotesForDays`: una nota suelta y un lote de tramos son la
 * misma escritura repetida, y la entrada de bitácora tiene que salir idéntica
 * en los dos casos o el historial contaría dos historias distintas del mismo
 * hecho. Quien llama ya validó las fechas y comprobó la propiedad.
 */
async function crearNotaEnTx(
  tx: ClienteNota,
  {
    actor,
    propiedad,
    startDate,
    endDate,
    note,
    ip,
    detallesExtra,
  }: {
    actor: AdminActor;
    propiedad: { id: string; name: string };
    startDate: string;
    endDate: string;
    note: string;
    ip?: string | null;
    /** Contexto del lote, cuando la nota nace de una selección de días. */
    detallesExtra?: AuditDetails;
  },
): Promise<FilaNota> {
  const fila = await tx.maintenanceNote.create({
    data: {
      propertyId: propiedad.id,
      startDate: fechaCivil(startDate),
      endDate: fechaCivil(endDate),
      note,
      createdById: actor.id,
    },
    select: SELECCION_NOTA,
  });

  await writeAudit(tx, {
    action: "MAINTENANCE_NOTE_CREATED",
    entityType: "MAINTENANCE_NOTE",
    entityId: fila.id,
    actorUserId: actor.id,
    ip,
    details: {
      propertyId: propiedad.id,
      propertyName: propiedad.name,
      startDate,
      endDate,
      // Etiqueta legible: la bitácora se lee dentro de dos años, cuando nadie
      // querrá traducir fechas ISO de cabeza.
      rango: `${etiquetaDia(startDate)} — ${etiquetaDia(endDate)}`,
      note,
      ...detallesExtra,
    },
  });

  return fila;
}

export async function createMaintenanceNote({
  db,
  actor,
  propertyId,
  startDate,
  endDate,
  note,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  propertyId: string;
  startDate: string;
  endDate: string;
  note: string;
  ip?: string | null;
}): Promise<MaintenanceNoteRow> {
  assertSuperuser(actor);
  const datos = parseOrThrow(crearNotaSchema, { propertyId, startDate, endDate, note });

  const propiedad = await exigirPropiedad(db, datos.propertyId);

  const creada = await db.$transaction((tx) =>
    crearNotaEnTx(tx, {
      actor,
      propiedad,
      startDate: datos.startDate,
      endDate: datos.endDate,
      note: datos.note,
      ip,
    }),
  );

  return aFila(creada);
}

/** Una semana son siete días: más fichas que eso no es una selección, es basura. */
const DIAS_POR_SEMANA = 7;

const notasPorDiasSchema = z.object({
  propertyId: z.uuid("Identificador de propiedad inválido"),
  dates: z
    .array(fechaISOSchema)
    .min(1, "Elige al menos un día")
    .max(DIAS_POR_SEMANA, "No puedes elegir más de 7 días: son los de una semana"),
  note: textoNotaSchema,
});

/**
 * Notas de mantenimiento a partir de los DÍAS elegidos en el calendario.
 *
 * El atajo de la superusuaria: marca fichas sueltas de una semana y aquí se
 * convierten en notas. La regla que le da sentido está en
 * `agruparDiasEnRangos`: los días no contiguos producen VARIAS notas, una por
 * tramo continuo. Una sola nota del primer día al último abarcaría días que
 * nadie eligió y anunciaría en el calendario de todos una obra que esos días no
 * existe.
 *
 * Las notas se crean en UNA transacción con su bitácora: o quedan todos los
 * tramos anotados, o no queda ninguno. Media selección guardada sería peor que
 * ninguna, porque nadie sabría qué falta.
 */
export async function createMaintenanceNotesForDays({
  db,
  actor,
  propertyId,
  dates,
  note,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  propertyId: string;
  /** Días elegidos, en cualquier orden y con repetidos: se normalizan aquí. */
  dates: string[];
  note: string;
  ip?: string | null;
}): Promise<MaintenanceNoteRow[]> {
  assertSuperuser(actor);
  const datos = parseOrThrow(notasPorDiasSchema, { propertyId, dates, note });

  const dias = [...new Set(datos.dates)].sort();

  // Todos los días tienen que caer en la MISMA semana, que es la que el
  // selector acota. La semana se deduce del primer día; como `dias` está
  // ordenado y su viernes es por construcción el más temprano, basta con mirar
  // que el último no pase del jueves de cierre.
  const viernes = weekStartOf(dias[0]!);
  const jueves = addDaysISO(viernes, 6);
  if (dias[dias.length - 1]! > jueves) {
    throw new AdminError(
      "INVALID_INPUT",
      `Los días elegidos deben caer todos en la misma semana (${etiquetaDia(viernes)} — ${etiquetaDia(jueves)}).`,
    );
  }

  const propiedad = await exigirPropiedad(db, datos.propertyId);
  const tramos = agruparDiasEnRangos(dias);

  const creadas = await db.$transaction(async (tx) => {
    const filas: FilaNota[] = [];
    // En serie y no con Promise.all: una transacción interactiva de Prisma tiene
    // una sola conexión y las consultas en paralelo se pisan.
    for (const tramo of tramos) {
      filas.push(
        await crearNotaEnTx(tx, {
          actor,
          propiedad,
          startDate: tramo.startDate,
          endDate: tramo.endDate,
          note: datos.note,
          ip,
          detallesExtra: {
            // Sin esto, dos notas salteadas parecen dos decisiones sueltas: lo
            // que se eligió de verdad fue una semana con huecos.
            semana: viernes,
            diasElegidos: dias,
            tramos: tramos.length,
          },
        }),
      );
    }
    return filas;
  });

  return creadas.map(aFila);
}

export interface UpdateMaintenanceNoteInput {
  startDate?: string;
  endDate?: string;
  note?: string;
}

const actualizarNotaSchema = z.object({
  startDate: fechaISOSchema.optional(),
  endDate: fechaISOSchema.optional(),
  note: textoNotaSchema.optional(),
});

export async function updateMaintenanceNote({
  db,
  actor,
  noteId,
  input,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  noteId: string;
  input: UpdateMaintenanceNoteInput;
  ip?: string | null;
}): Promise<MaintenanceNoteRow> {
  assertSuperuser(actor);
  const patch = parseOrThrow(actualizarNotaSchema, input);

  const actual = await db.maintenanceNote.findUnique({
    where: { id: noteId },
    select: SELECCION_NOTA,
  });
  if (!actual) throw new AdminError("NOT_FOUND", "La nota no existe.");

  const inicio = patch.startDate ?? isoDeFecha(actual.startDate);
  const fin = patch.endDate ?? isoDeFecha(actual.endDate);
  if (inicio > fin) {
    throw new AdminError("INVALID_INPUT", "La nota termina antes de empezar.");
  }

  const actualizada = await db.$transaction(async (tx) => {
    const fila = await tx.maintenanceNote.update({
      where: { id: noteId },
      data: {
        startDate: fechaCivil(inicio),
        endDate: fechaCivil(fin),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      },
      select: SELECCION_NOTA,
    });

    await writeAudit(tx, {
      action: "MAINTENANCE_NOTE_UPDATED",
      entityType: "MAINTENANCE_NOTE",
      entityId: fila.id,
      actorUserId: actor.id,
      ip,
      details: {
        propertyId: fila.propertyId,
        propertyName: fila.property.name,
        // El antes Y el después: una edición sin el valor anterior no explica
        // nada dentro de dos años, que es cuando se lee la bitácora.
        antes: {
          startDate: isoDeFecha(actual.startDate),
          endDate: isoDeFecha(actual.endDate),
          note: actual.note,
        },
        startDate: inicio,
        endDate: fin,
        rango: `${etiquetaDia(inicio)} — ${etiquetaDia(fin)}`,
        note: fila.note,
      },
    });

    return fila;
  });

  return aFila(actualizada);
}

/**
 * Borra la nota de verdad. Es la única entidad del modelo que se elimina
 * físicamente: no tiene estado ni la referencia nadie, y una nota vieja de
 * mantenimiento no es historia que haya que conservar.
 */
export async function deleteMaintenanceNote({
  db,
  actor,
  noteId,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  noteId: string;
  ip?: string | null;
}): Promise<MaintenanceNoteRow> {
  assertSuperuser(actor);

  const actual = await db.maintenanceNote.findUnique({
    where: { id: noteId },
    select: SELECCION_NOTA,
  });
  if (!actual) throw new AdminError("NOT_FOUND", "La nota no existe.");

  await db.$transaction(async (tx) => {
    await tx.maintenanceNote.delete({ where: { id: noteId } });

    // La fila desaparece de `maintenance_notes`, así que el retrato COMPLETO
    // se guarda en los detalles: es lo único que quedará de esta nota.
    // `entityId` apunta a un id que ya no existe en ninguna tabla, y está
    // bien: `audit_log.entity_id` es un uuid suelto, sin clave foránea.
    await writeAudit(tx, {
      action: "MAINTENANCE_NOTE_DELETED",
      entityType: "MAINTENANCE_NOTE",
      entityId: actual.id,
      actorUserId: actor.id,
      ip,
      details: {
        propertyId: actual.propertyId,
        propertyName: actual.property.name,
        startDate: isoDeFecha(actual.startDate),
        endDate: isoDeFecha(actual.endDate),
        rango: `${etiquetaDia(isoDeFecha(actual.startDate))} — ${etiquetaDia(
          isoDeFecha(actual.endDate),
        )}`,
        note: actual.note,
      },
    });
  });

  // Se devuelve el retrato de lo borrado para que la interfaz pueda decir qué
  // desapareció sin volver a consultar.
  return aFila(actual);
}
