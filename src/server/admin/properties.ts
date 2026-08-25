/**
 * Administración de propiedades (solo SUPERUSER).
 *
 * Una propiedad nunca se borra: se desactiva. Sus semanas, reservas y notas son
 * historia y el esquema las protege con FK RESTRICT.
 *
 * Cada propiedad lleva además un COLOR de identidad, de una lista cerrada de
 * ocho (`src/lib/property-color.ts`). No es decoración: al cambiar de propiedad
 * en el combo, el cromo del calendario cambia entero y eso es lo que evita
 * reservar la semana de la casa equivocada. De ahí que el alta sin color no se
 * quede en el valor por defecto de la columna, sino que busque uno libre.
 */

import { z } from "zod";

import { writeAudit, type AuditDetails } from "@/lib/audit";
import type { Db } from "@/lib/db";
import {
  coercePropertyColor,
  isPropertyColor,
  PROPERTY_COLORS,
  type PropertyColor,
} from "@/lib/property-color";

import {
  AdminError,
  type AdminActor,
  assertSuperuser,
  fechaCivil,
  hoyDeNegocio,
  parseOrThrow,
} from "./users";

const nombreSchema = z
  .string()
  .trim()
  .min(3, "El nombre debe tener al menos 3 caracteres")
  .max(80, "El nombre no puede pasar de 80 caracteres");

/**
 * Puerta de entrada del color.
 *
 * Se construye con `z.enum` sobre la MISMA tupla que exporta el tipo
 * `PropertyColor` —la misma que lee `isPropertyColor`—, así que validación y
 * tipo no pueden divergir: el día que se añada un noveno color se enteran los
 * dos a la vez o ninguno. Basta el esquema porque además ESTRECHA el tipo de
 * salida; comprobar antes con `isPropertyColor` sería recorrer la lista dos
 * veces para llegar a lo mismo.
 *
 * Sin esta puerta el valor llegaría al CHECK de `properties.color` y volvería
 * como error crudo de PostgreSQL: un 500 con traza en el registro por lo que en
 * realidad es un dato mal escrito. `parseOrThrow` lo convierte en INVALID_INPUT
 * con el valor culpable dentro del mensaje.
 */
const colorSchema = z.enum(PROPERTY_COLORS, {
  error: (incidencia) =>
    `«${String(incidencia.input)}» no es un color de propiedad. Elige uno de los ocho de la paleta.`,
});

export interface PropertyRow {
  id: string;
  name: string;
  /** Uno de los ocho de `src/lib/property-color.ts`. Tiñe el cromo, no los estados. */
  color: PropertyColor;
  isActive: boolean;
  createdAt: Date;
  /** Semanas OPEN que todavía no terminan: lo que se ofrece hoy en el calendario. */
  openFutureSlots: number;
  /** Semanas futuras con reserva ACTIVE. */
  futureReservations: number;
}

const SELECCION_PROPIEDAD = {
  id: true,
  name: true,
  color: true,
  isActive: true,
  createdAt: true,
} as const;

/** Lo que devuelve la base: `color` viaja como texto hasta que se estrecha. */
interface FilaCruda {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  createdAt: Date;
}

export async function listProperties({
  db,
  actor,
  includeInactive = true,
  now = new Date(),
}: {
  db: Db;
  actor: AdminActor;
  includeInactive?: boolean;
  now?: Date;
}): Promise<PropertyRow[]> {
  assertSuperuser(actor);

  const propiedades = await db.property.findMany({
    where: includeInactive ? {} : { isActive: true },
    select: SELECCION_PROPIEDAD,
    orderBy: { name: "asc" },
  });
  if (propiedades.length === 0) return [];

  const impacto = await impactoPorPropiedad(
    db,
    propiedades.map((p) => p.id),
    hoyDeNegocio(now),
  );

  return propiedades.map((p) =>
    aFila(p, impacto.get(p.id) ?? sinImpacto()),
  );
}

export async function createProperty({
  db,
  actor,
  name,
  color,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  name: string;
  /**
   * Opcional. Se declara como texto y no como `PropertyColor` porque quien
   * llama es una Server Action: lo que trae es entrada del cliente y el tipo
   * de TypeScript ahí no garantiza nada. Sin color, lo elige el servicio.
   */
  color?: string | null;
  ip?: string | null;
}): Promise<PropertyRow> {
  assertSuperuser(actor);
  const nombre = parseOrThrow(nombreSchema, name);
  const elegido =
    color == null ? await colorSugerido(db) : parseOrThrow(colorSchema, color);

  await asegurarNombreLibre(db, nombre, null);

  const creada = await db.$transaction(async (tx) => {
    const fila = await tx.property.create({
      data: { name: nombre, color: elegido },
      select: SELECCION_PROPIEDAD,
    });

    await writeAudit(tx, {
      action: "PROPERTY_CREATED",
      entityType: "PROPERTY",
      entityId: fila.id,
      actorUserId: actor.id,
      ip,
      // `propertyId` en los detalles porque el filtro por propiedad de la
      // bitácora lee justo esa clave del JSON (ver audit-queries.ts).
      details: {
        propertyId: fila.id,
        propertyName: fila.name,
        propertyColor: fila.color,
      },
    });

    return fila;
  });

  return aFila(creada, sinImpacto());
}

export async function updateProperty({
  db,
  actor,
  propertyId,
  name,
  color,
  ip,
  now = new Date(),
}: {
  db: Db;
  actor: AdminActor;
  propertyId: string;
  name: string;
  /** Opcional: sin él, el color no se toca. Ver la nota de `createProperty`. */
  color?: string | null;
  ip?: string | null;
  now?: Date;
}): Promise<PropertyRow> {
  assertSuperuser(actor);
  const nombre = parseOrThrow(nombreSchema, name);
  const colorPedido = color == null ? null : parseOrThrow(colorSchema, color);

  const actual = await db.property.findUnique({
    where: { id: propertyId },
    select: SELECCION_PROPIEDAD,
  });
  if (!actual) throw new AdminError("NOT_FOUND", "La propiedad no existe.");

  const colorActual = coercePropertyColor(actual.color);
  const cambiaNombre = actual.name !== nombre;
  const cambiaColor = colorPedido !== null && colorPedido !== colorActual;

  // Sin cambios reales no se escribe nada: una entrada de bitácora que dice
  // «cambió» sin que cambiara nada es ruido que estorba a quien la lee.
  if (!cambiaNombre && !cambiaColor) return conImpacto(db, actual, now);

  if (cambiaNombre) await asegurarNombreLibre(db, nombre, propertyId);

  const actualizada = await db.$transaction(async (tx) => {
    const fila = await tx.property.update({
      where: { id: propertyId },
      data: {
        ...(cambiaNombre ? { name: nombre } : {}),
        ...(cambiaColor ? { color: colorPedido } : {}),
      },
      select: SELECCION_PROPIEDAD,
    });

    // Antes y después de cada campo tocado. El color entra en la MISMA
    // transacción que la escritura: si el cambio se guarda, su rastro también;
    // si algo falla, no queda ninguno de los dos.
    const cambios: AuditDetails = {};
    if (cambiaNombre) cambios.name = { antes: actual.name, ahora: fila.name };
    if (cambiaColor) {
      cambios.color = { antes: colorActual, ahora: coercePropertyColor(fila.color) };
    }

    await writeAudit(tx, {
      action: "PROPERTY_UPDATED",
      entityType: "PROPERTY",
      entityId: fila.id,
      actorUserId: actor.id,
      ip,
      details: {
        propertyId: fila.id,
        propertyName: fila.name,
        cambios,
      },
    });

    return fila;
  });

  return conImpacto(db, actualizada, now);
}

export interface SetPropertyActiveResult {
  property: PropertyRow;
  /**
   * Lo que queda colgando al desactivar. NO se cancela nada: apagar una
   * propiedad la saca del calendario, pero decidir qué pasa con las semanas ya
   * tomadas es de la superusuaria, no un efecto colateral.
   */
  impact: { openFutureSlots: number; futureReservations: number };
}

export async function setPropertyActive({
  db,
  actor,
  propertyId,
  isActive,
  ip,
  now = new Date(),
}: {
  db: Db;
  actor: AdminActor;
  propertyId: string;
  isActive: boolean;
  ip?: string | null;
  now?: Date;
}): Promise<SetPropertyActiveResult> {
  assertSuperuser(actor);

  const actual = await db.property.findUnique({
    where: { id: propertyId },
    select: SELECCION_PROPIEDAD,
  });
  if (!actual) throw new AdminError("NOT_FOUND", "La propiedad no existe.");

  const impacto =
    (await impactoPorPropiedad(db, [propertyId], hoyDeNegocio(now))).get(propertyId) ??
    sinImpacto();

  if (actual.isActive === isActive) {
    return { property: aFila(actual, impacto), impact: impacto };
  }

  const actualizada = await db.$transaction(async (tx) => {
    const fila = await tx.property.update({
      where: { id: propertyId },
      data: { isActive },
      select: SELECCION_PROPIEDAD,
    });

    await writeAudit(tx, {
      // No hay acción propia de baja de propiedad en la lista cerrada de
      // audit.ts: se anota como edición con el detalle explícito.
      action: "PROPERTY_UPDATED",
      entityType: "PROPERTY",
      entityId: fila.id,
      actorUserId: actor.id,
      ip,
      details: {
        propertyId: fila.id,
        propertyName: fila.name,
        cambios: { isActive: { antes: actual.isActive, ahora: isActive } },
        // Snapshot de lo que quedó vivo al apagarla: sin esto, dentro de un año
        // nadie sabrá si la baja dejó semanas reservadas por medio.
        semanasAbiertasFuturas: impacto.openFutureSlots,
        reservasFuturas: impacto.futureReservations,
      },
    });

    return fila;
  });

  return { property: aFila(actualizada, impacto), impact: impacto };
}

// ══════════════════════════════════════════════════════ internos

/**
 * Color para una propiedad que llega sin él.
 *
 * NO se deja caer en el índigo por defecto de la columna: dos propiedades nuevas
 * saldrían idénticas y el color dejaría de distinguir nada, que es justo el
 * error que esta funcionalidad existe para evitar. Se toma el primero de
 * PROPERTY_COLORS que no use ninguna propiedad ACTIVA; las apagadas no cuentan
 * porque no salen en el calendario y su color no confunde a nadie. Con los ocho
 * tomados se reparte por orden: gana el menos usado y, a igualdad, el primero de
 * la lista.
 *
 * Es una PREFERENCIA, no una restricción —dos propiedades pueden compartir color
 * si la superusuaria lo elige a mano, y el diálogo avisa antes—, así que se
 * calcula fuera de la transacción igual que el control de nombre repetido: dos
 * altas simultáneas como mucho repiten un color, que es exactamente lo que ya
 * está permitido hacer a propósito.
 */
async function colorSugerido(db: Db): Promise<PropertyColor> {
  const activas = await db.property.findMany({
    where: { isActive: true },
    select: { color: true },
  });

  const usos = new Map<PropertyColor, number>(PROPERTY_COLORS.map((c) => [c, 0]));
  for (const { color } of activas) {
    if (isPropertyColor(color)) usos.set(color, (usos.get(color) ?? 0) + 1);
  }

  // Un solo barrido resuelve los dos casos: con `<` estricto gana el primer
  // mínimo de la tupla, que con algún color libre es el primero sin usar.
  let elegido: PropertyColor = PROPERTY_COLORS[0];
  for (const candidato of PROPERTY_COLORS) {
    if ((usos.get(candidato) ?? 0) < (usos.get(elegido) ?? 0)) elegido = candidato;
  }
  return elegido;
}

async function asegurarNombreLibre(
  db: Db,
  nombre: string,
  exceptoId: string | null,
): Promise<void> {
  // `properties.name` es texto único (no citext): la unicidad de la base
  // distingue mayúsculas y dejaría pasar «Casa del lago» junto a «Casa del
  // Lago». Para el combo del calendario son la misma casa.
  const choque = await db.property.findFirst({
    where: {
      name: { equals: nombre, mode: "insensitive" },
      ...(exceptoId ? { id: { not: exceptoId } } : {}),
    },
    select: { id: true, name: true },
  });
  if (choque) {
    throw new AdminError("NAME_TAKEN", `Ya hay una propiedad llamada «${choque.name}».`);
  }
}

type Impacto = { openFutureSlots: number; futureReservations: number };

/** Función y no constante: el objeto viaja hacia fuera y no debe compartirse. */
function sinImpacto(): Impacto {
  return { openFutureSlots: 0, futureReservations: 0 };
}

/**
 * Fila de la base → fila de dominio.
 *
 * El color se estrecha con `coercePropertyColor` en vez de castearse: el CHECK
 * de la columna ya impide guardar basura, pero una fila creada a mano por SQL o
 * heredada de una migración futura no debe dejar la pantalla sin identidad
 * visual. Ante lo desconocido, índigo y a seguir.
 */
function aFila(fila: FilaCruda, impacto: Impacto): PropertyRow {
  return {
    ...fila,
    color: coercePropertyColor(fila.color),
    ...impacto,
  };
}

/**
 * Semanas abiertas y reservas vivas por propiedad, contando solo lo que aún no
 * termina: el pasado no se ve afectado por desactivar nada.
 */
async function impactoPorPropiedad(
  db: Db,
  propertyIds: string[],
  hoyISO: string,
): Promise<Map<string, Impacto>> {
  const hoy = fechaCivil(hoyISO);
  const mapa = new Map<string, Impacto>(
    propertyIds.map((id) => [id, { openFutureSlots: 0, futureReservations: 0 }]),
  );

  const abiertas = await db.weekSlot.groupBy({
    by: ["propertyId"],
    where: { propertyId: { in: propertyIds }, status: "OPEN", endDate: { gte: hoy } },
    _count: { _all: true },
  });
  for (const fila of abiertas) {
    const actual = mapa.get(fila.propertyId);
    if (actual) actual.openFutureSlots = fila._count._all;
  }

  // Se agrupa por SLOT y no por reserva: `reservations` no tiene propertyId, y
  // el índice único parcial garantiza como mucho una reserva ACTIVE por slot,
  // así que contar slots con reserva viva cuenta reservas.
  const reservadas = await db.weekSlot.groupBy({
    by: ["propertyId"],
    where: {
      propertyId: { in: propertyIds },
      endDate: { gte: hoy },
      reservations: { some: { status: "ACTIVE" } },
    },
    _count: { _all: true },
  });
  for (const fila of reservadas) {
    const actual = mapa.get(fila.propertyId);
    if (actual) actual.futureReservations = fila._count._all;
  }

  return mapa;
}

async function conImpacto(
  db: Db,
  propiedad: FilaCruda,
  now: Date,
): Promise<PropertyRow> {
  const impacto =
    (await impactoPorPropiedad(db, [propiedad.id], hoyDeNegocio(now))).get(propiedad.id) ??
    sinImpacto();
  return aFila(propiedad, impacto);
}
