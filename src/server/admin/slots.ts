/**
 * Apertura y cierre de semanas (solo SUPERUSER).
 *
 * Es la operación más frecuente del producto: la superusuaria abre en lote los
 * viernes de un rango y, de vez en cuando, cierra una semana concreta.
 *
 * Dos invariantes mandan aquí:
 *   · `week_slots.start_date` SIEMPRE es viernes (CHECK en la base). Las fechas
 *     se generan en la zona de negocio, no en la del servidor: en un despliegue
 *     en UTC, «el viernes» del servidor puede ser el jueves de la familia.
 *   · Abrir es IDEMPOTENTE. La unicidad (property_id, start_date) lo garantiza
 *     en la base; aquí solo se cuenta cuántas se crearon y cuántas ya estaban,
 *     para poder decírselo a quien pulsó el botón.
 */

import { randomUUID } from "node:crypto";

import { TZDate } from "@date-fns/tz";
import { addDays } from "date-fns";
import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { writeAudit } from "@/lib/audit";
import { DEFAULT_BOOKING_WINDOW, toISODate } from "@/lib/booking-window";
import type { Db } from "@/lib/db";
import {
  activeUserIds,
  enqueueNotification,
} from "@/lib/notifications/dispatch";
import type { WeekRef } from "@/lib/notifications/types";

import {
  AdminError,
  type AdminActor,
  assertSuperuser,
  etiquetaSemana,
  fechaCivil,
  isoDeFecha,
  parseOrThrow,
} from "./users";

/**
 * Tope por tanda: dos años de semanas. No es una limitación técnica sino un
 * seguro contra el dedo resbalado (un `to` con el año equivocado abriría
 * décadas de calendario y mandaría un correo con miles de líneas).
 */
const MAX_SEMANAS_POR_TANDA = 104;

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

const fechaISOSchema = z
  .string()
  .trim()
  .regex(ISO_FECHA, "La fecha debe ir en formato yyyy-MM-dd")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)), "Fecha inexistente");

const uuidSchema = z.uuid("Identificador inválido");

const abrirSemanasSchema = z
  .object({
    propertyId: uuidSchema,
    from: fechaISOSchema,
    to: fechaISOSchema,
  })
  .refine((v) => v.from <= v.to, {
    message: "El rango termina antes de empezar",
    path: ["to"],
  });

// ═════════════════════════════════════════════════════ abrir en lote

/** Semana recién abierta, ya con su etiqueta en español. */
export interface OpenedWeek {
  slotId: string;
  startDate: string;
  endDate: string;
  label: string;
}

export interface OpenWeeksResult {
  /** Identificador de la tanda: agrupa la bitácora y es la clave del aviso. */
  batchId: string;
  propertyId: string;
  propertyName: string;
  /** Semanas creadas en esta llamada. */
  created: number;
  /** Viernes del rango que ya existían: la idempotencia hecha número. */
  alreadyOpen: number;
  weeks: OpenedWeek[];
  /** Filas encoladas en el outbox. */
  notified: number;
  /** Cómo se le explicó la ventana a la gente en el correo. */
  windowRuleLabel: string;
}

/**
 * Abre todos los viernes comprendidos en `[from, to]`.
 *
 * Los extremos pueden ser cualquier día: se toma el primer viernes a partir de
 * `from` y se avanza de siete en siete hasta pasar `to`.
 */
export async function openWeeks({
  db,
  actor,
  propertyId,
  from,
  to,
  notify = true,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  propertyId: string;
  from: string;
  to: string;
  notify?: boolean;
  ip?: string | null;
}): Promise<OpenWeeksResult> {
  assertSuperuser(actor);
  const datos = parseOrThrow(abrirSemanasSchema, { propertyId, from, to });

  const propiedad = await db.property.findUnique({
    where: { id: datos.propertyId },
    select: { id: true, name: true, isActive: true },
  });
  if (!propiedad) throw new AdminError("NOT_FOUND", "La propiedad no existe.");
  if (!propiedad.isActive) {
    // Abrir semanas de una propiedad apagada solo produce calendario muerto.
    throw new AdminError(
      "PROPERTY_INACTIVE",
      `«${propiedad.name}» está desactivada: actívala antes de abrir semanas.`,
    );
  }

  const viernes = viernesEnRango(datos.from, datos.to, DEFAULT_BOOKING_WINDOW.timeZone);
  if (viernes.length === 0) {
    return {
      batchId: randomUUID(),
      propertyId: propiedad.id,
      propertyName: propiedad.name,
      created: 0,
      alreadyOpen: 0,
      weeks: [],
      notified: 0,
      windowRuleLabel: await etiquetaDeVentana(db, propiedad.id),
    };
  }
  if (viernes.length > MAX_SEMANAS_POR_TANDA) {
    throw new AdminError(
      "BATCH_TOO_LARGE",
      `El rango cubre ${viernes.length} semanas y el máximo por tanda es ${MAX_SEMANAS_POR_TANDA}. Ábrelas en varios tramos.`,
    );
  }

  const windowRuleLabel = await etiquetaDeVentana(db, propiedad.id);
  const batchId = randomUUID();
  const fechas = viernes.map(fechaCivil);

  return db.$transaction(async (tx) => {
    const existentes = await tx.weekSlot.findMany({
      where: { propertyId: propiedad.id, startDate: { in: fechas } },
      select: { startDate: true },
    });
    const yaAbiertas = new Set(existentes.map((s) => isoDeFecha(s.startDate)));
    const faltantes = viernes.filter((v) => !yaAbiertas.has(v));

    if (faltantes.length === 0) {
      return {
        batchId,
        propertyId: propiedad.id,
        propertyName: propiedad.name,
        created: 0,
        alreadyOpen: viernes.length,
        weeks: [],
        notified: 0,
        windowRuleLabel,
      };
    }

    // `skipDuplicates` es el cinturón sobre los tirantes: la lectura anterior ya
    // filtró, pero entre ella y este INSERT cabe otra tanda. Con él, repetir la
    // operación no revienta la transacción entera por una clave duplicada.
    await tx.weekSlot.createMany({
      data: faltantes.map((iso) => ({
        propertyId: propiedad.id,
        startDate: fechaCivil(iso),
        createdById: actor.id,
      })),
      skipDuplicates: true,
    });

    // Relectura: `createMany` no devuelve filas y el aviso necesita el id de
    // cada slot (`WeekRef.slotId`), además de `end_date`, que es una columna
    // GENERADA por la base.
    const creados = await tx.weekSlot.findMany({
      where: { propertyId: propiedad.id, startDate: { in: faltantes.map(fechaCivil) } },
      select: { id: true, startDate: true, endDate: true },
      orderBy: { startDate: "asc" },
    });

    const semanas: OpenedWeek[] = creados.map((s) => {
      const inicio = isoDeFecha(s.startDate);
      const fin = isoDeFecha(s.endDate);
      return { slotId: s.id, startDate: inicio, endDate: fin, label: etiquetaSemana(inicio, fin) };
    });

    // Una entrada por semana: la bitácora se consulta por entidad («qué pasó
    // con esta semana»), y una sola fila con un array dentro no respondería esa
    // pregunta. `batchId` las vuelve a agrupar cuando hace falta.
    for (const semana of semanas) {
      await writeAudit(tx, {
        action: "SLOT_OPENED",
        entityType: "WEEK_SLOT",
        entityId: semana.slotId,
        actorUserId: actor.id,
        ip,
        details: {
          batchId,
          propertyId: propiedad.id,
          propertyName: propiedad.name,
          startDate: semana.startDate,
          endDate: semana.endDate,
        },
      });
    }

    // UN correo por tanda, no uno por semana: quien recibe quiere saber «se
    // abrieron seis semanas», no seis avisos idénticos.
    const notified =
      notify && semanas.length > 0
        ? await enqueueNotification(tx, {
            eventType: "SLOTS_OPENED",
            payload: {
              batchId,
              propertyName: propiedad.name,
              weeks: semanas.map((s) => refDeSemana(s, propiedad.name)),
              path: rutaCalendario(propiedad.id),
              windowRuleLabel,
            },
            recipientUserIds: await activeUserIds(tx),
          })
        : 0;

    return {
      batchId,
      propertyId: propiedad.id,
      propertyName: propiedad.name,
      created: semanas.length,
      alreadyOpen: viernes.length - semanas.length,
      weeks: semanas,
      notified,
      windowRuleLabel,
    };
  });
}

// ═════════════════════════════════════════════════════ cerrar semana

export interface CloseWeekResult {
  slotId: string;
  propertyId: string;
  propertyName: string;
  startDate: string;
  endDate: string;
  /** Ya estaba cerrada: la llamada no cambió nada. */
  alreadyClosed: boolean;
  /** Reserva cancelada por el cierre forzado, si la había. */
  cancelledReservation: {
    reservationId: string;
    ownerUserId: string;
    ownerName: string;
    cancelledGrants: number;
  } | null;
  notified: number;
}

const cerrarSemanaSchema = z.object({
  slotId: uuidSchema,
  force: z.boolean().default(false),
  reason: z.string().trim().min(5, "Explica el motivo del cierre").max(500).optional(),
});

/**
 * Cierra una semana: OPEN → CLOSED, directo.
 *
 * Si tiene reserva ACTIVA hace falta `force` y un motivo: se cancela la reserva
 * (con su cascada de cesiones) y el slot queda CLOSED, NO OPEN. Volver a
 * dejarlo abierto sería regalar la semana al primero que refresque, que es
 * exactamente lo que la superusuaria quiso evitar al cerrarla.
 */
export async function closeWeek({
  db,
  actor,
  slotId,
  force = false,
  reason,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  slotId: string;
  force?: boolean;
  reason?: string;
  ip?: string | null;
}): Promise<CloseWeekResult> {
  assertSuperuser(actor);
  const datos = parseOrThrow(cerrarSemanaSchema, { slotId, force, reason });

  return db.$transaction(async (tx) => {
    // Bloqueo de la fila del slot: serializa dos cierres simultáneos y el par
    // cerrar/reabrir. OJO: no basta contra una reserva concurrente, porque el
    // INSERT en `reservations` no toca esta fila; el servicio de reservas debe
    // tomar este mismo bloqueo antes de insertar para que la exclusión sea real.
    await tx.$executeRaw`SELECT id FROM week_slots WHERE id = ${datos.slotId}::uuid FOR UPDATE`;

    const slot = await tx.weekSlot.findUnique({
      where: { id: datos.slotId },
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        property: { select: { id: true, name: true } },
        reservations: {
          where: { status: "ACTIVE" },
          select: {
            id: true,
            createdAt: true,
            user: { select: { id: true, fullName: true, email: true } },
            dayGrants: {
              where: { status: "ACTIVE" },
              select: {
                id: true,
                grantDate: true,
                granteeUserId: true,
                grantee: { select: { fullName: true } },
              },
            },
          },
        },
      },
    });
    if (!slot) throw new AdminError("NOT_FOUND", "La semana no existe.");

    const inicio = isoDeFecha(slot.startDate);
    const fin = isoDeFecha(slot.endDate);
    const base = {
      slotId: slot.id,
      propertyId: slot.property.id,
      propertyName: slot.property.name,
      startDate: inicio,
      endDate: fin,
    };

    if (slot.status === "CLOSED") {
      return { ...base, alreadyClosed: true, cancelledReservation: null, notified: 0 };
    }

    const reserva = slot.reservations[0] ?? null;

    if (reserva && !datos.force) {
      throw new AdminError(
        "SLOT_HAS_ACTIVE_RESERVATION",
        `La semana está reservada por ${reserva.user.fullName}. Para cerrarla de todos modos hace falta confirmarlo con un motivo.`,
      );
    }
    if (reserva && !datos.reason) {
      throw new AdminError(
        "INVALID_INPUT",
        "Cerrar una semana reservada exige un motivo por escrito.",
      );
    }

    await tx.weekSlot.update({ where: { id: slot.id }, data: { status: "CLOSED" } });

    if (!reserva) {
      await writeAudit(tx, {
        action: "SLOT_CLOSED",
        entityType: "WEEK_SLOT",
        entityId: slot.id,
        actorUserId: actor.id,
        ip,
        details: {
          propertyId: slot.property.id,
          propertyName: slot.property.name,
          startDate: inicio,
          endDate: fin,
          motivo: datos.reason ?? null,
        },
      });
      // Sin reserva no hay a quién avisar: la semana simplemente deja de
      // ofrecerse en el calendario.
      return { ...base, alreadyClosed: false, cancelledReservation: null, notified: 0 };
    }

    const motivo = datos.reason as string;
    const ahora = new Date();

    await tx.reservation.update({
      where: { id: reserva.id },
      data: {
        status: "CANCELLED",
        cancelledAt: ahora,
        cancelledById: actor.id,
        cancelReason: motivo,
      },
    });

    // Cascada: una cesión no puede sobrevivir a la reserva que la sostiene.
    const { count: cesionesCanceladas } = await tx.dayGrant.updateMany({
      where: { reservationId: reserva.id, status: "ACTIVE" },
      data: { status: "CANCELLED", endedAt: ahora },
    });

    const snapshot = {
      propertyId: slot.property.id,
      propertyName: slot.property.name,
      startDate: inicio,
      endDate: fin,
      motivo,
      reservation: {
        id: reserva.id,
        ownerUserId: reserva.user.id,
        ownerName: reserva.user.fullName,
        ownerEmail: reserva.user.email,
        createdAt: reserva.createdAt.toISOString(),
      },
      cesiones: reserva.dayGrants.map((g) => ({
        id: g.id,
        date: isoDeFecha(g.grantDate),
        granteeUserId: g.granteeUserId,
        granteeName: g.grantee.fullName,
      })),
    };

    await writeAudit(tx, {
      action: "SLOT_CLOSED_WITH_ACTIVE_RESERVATION",
      entityType: "WEEK_SLOT",
      entityId: slot.id,
      actorUserId: actor.id,
      ip,
      details: snapshot,
    });

    // Segunda entrada, esta colgada de la RESERVA: quien busque por la reserva
    // en la bitácora debe encontrar su cancelación, no solo el cierre del slot.
    await writeAudit(tx, {
      action: "RESERVATION_CANCELLED_BY_ADMIN",
      entityType: "RESERVATION",
      entityId: reserva.id,
      actorUserId: actor.id,
      ip,
      details: { ...snapshot, slotId: slot.id, porCierreDeSemana: true },
    });

    // Solo a los afectados —dueña y receptores de días—, NO a todo el mundo: el
    // aviso de cancelación anuncia que la semana vuelve a estar libre, y aquí
    // NO lo está. Ver el riesgo anotado en el resumen: falta un evento propio
    // de «semana cerrada» en @/lib/notifications/types.
    const afectados = [
      reserva.user.id,
      ...reserva.dayGrants.map((g) => g.granteeUserId),
    ];

    const notified = await enqueueNotification(tx, {
      eventType: "RESERVATION_CANCELLED",
      payload: {
        reservationId: reserva.id,
        ownerUserId: reserva.user.id,
        ownerName: reserva.user.fullName,
        cancelledByName: actor.fullName,
        // El prefijo va dentro del motivo porque es lo único de este aviso que
        // la plantilla muestra literal: sin él, el correo diría que la semana
        // quedó libre.
        cancelReason: `La semana quedó CERRADA por administración y no vuelve a ofrecerse. Motivo: ${motivo}`,
        week: refDeSemana({ slotId: slot.id, startDate: inicio, endDate: fin }, slot.property.name),
        path: rutaCalendario(slot.property.id),
      },
      recipientUserIds: afectados,
    });

    return {
      ...base,
      alreadyClosed: false,
      cancelledReservation: {
        reservationId: reserva.id,
        ownerUserId: reserva.user.id,
        ownerName: reserva.user.fullName,
        cancelledGrants: cesionesCanceladas,
      },
      notified,
    };
  });
}

// ════════════════════════════════════════════════════ reabrir semana

export interface ReopenWeekResult {
  slotId: string;
  propertyId: string;
  propertyName: string;
  startDate: string;
  endDate: string;
  /** Ya estaba abierta: la llamada no cambió nada. */
  alreadyOpen: boolean;
  notified: number;
}

/** CLOSED → OPEN. La semana vuelve al calendario con su ventana de siempre. */
export async function reopenWeek({
  db,
  actor,
  slotId,
  notify = true,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  slotId: string;
  notify?: boolean;
  ip?: string | null;
}): Promise<ReopenWeekResult> {
  assertSuperuser(actor);
  const id = parseOrThrow(uuidSchema, slotId);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM week_slots WHERE id = ${id}::uuid FOR UPDATE`;

    const slot = await tx.weekSlot.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        property: { select: { id: true, name: true } },
      },
    });
    if (!slot) throw new AdminError("NOT_FOUND", "La semana no existe.");

    const inicio = isoDeFecha(slot.startDate);
    const fin = isoDeFecha(slot.endDate);
    const base = {
      slotId: slot.id,
      propertyId: slot.property.id,
      propertyName: slot.property.name,
      startDate: inicio,
      endDate: fin,
    };

    if (slot.status !== "CLOSED") {
      // RESERVED es denormalización histórica del esquema: la verdad es la
      // reserva ACTIVE, no el estado del slot. Solo se reabre lo CERRADO.
      return { ...base, alreadyOpen: true, notified: 0 };
    }

    await tx.weekSlot.update({ where: { id: slot.id }, data: { status: "OPEN" } });

    const batchId = randomUUID();
    await writeAudit(tx, {
      action: "SLOT_OPENED",
      entityType: "WEEK_SLOT",
      entityId: slot.id,
      actorUserId: actor.id,
      ip,
      details: {
        batchId,
        propertyId: slot.property.id,
        propertyName: slot.property.name,
        startDate: inicio,
        endDate: fin,
        reapertura: true,
      },
    });

    const windowRuleLabel = await etiquetaDeVentana(tx, slot.property.id);

    const notified = notify
      ? await enqueueNotification(tx, {
          eventType: "SLOTS_OPENED",
          payload: {
            batchId,
            propertyName: slot.property.name,
            weeks: [
              refDeSemana(
                { slotId: slot.id, startDate: inicio, endDate: fin },
                slot.property.name,
              ),
            ],
            path: rutaCalendario(slot.property.id),
            windowRuleLabel,
          },
          recipientUserIds: await activeUserIds(tx),
        })
      : 0;

    return { ...base, alreadyOpen: false, notified };
  });
}

// ══════════════════════════════════════════════════════ internos

/**
 * Viernes civiles comprendidos en `[desde, hasta]`, en la zona de negocio.
 *
 * Se usa TZDate y no `Date`: la aritmética de date-fns sobre TZDate trabaja con
 * la hora de pared de la zona, que es donde «viernes» significa algo. El
 * `getDay() === 5` no es paranoia decorativa — es la misma invariante que el
 * CHECK de la base, comprobada antes de llegar a ella.
 */
function viernesEnRango(desde: string, hasta: string, timeZone: string): string[] {
  const inicio = tzMedianoche(desde, timeZone);
  const fin = tzMedianoche(hasta, timeZone);

  // getDay(): 0 = domingo … 5 = viernes.
  const avance = (5 - inicio.getDay() + 7) % 7;
  let cursor = addDays(inicio, avance) as TZDate;

  const salida: string[] = [];
  while (cursor.getTime() <= fin.getTime() && salida.length <= MAX_SEMANAS_POR_TANDA) {
    if (cursor.getDay() !== 5) {
      throw new AdminError(
        "INVALID_INPUT",
        `Error interno de fechas: ${toISODate(cursor)} no es viernes.`,
      );
    }
    salida.push(toISODate(cursor));
    cursor = addDays(cursor, 7) as TZDate;
  }
  return salida;
}

function tzMedianoche(iso: string, timeZone: string): TZDate {
  const [y, m, d] = iso.split("-").map(Number);
  return new TZDate(y, m - 1, d, 0, 0, 0, 0, timeZone);
}

function refDeSemana(
  semana: { slotId: string; startDate: string; endDate: string },
  propertyName: string,
): WeekRef {
  return {
    slotId: semana.slotId,
    propertyName,
    startDate: semana.startDate,
    endDate: semana.endDate,
    label: etiquetaSemana(semana.startDate, semana.endDate),
  };
}

/** El calendario vive en `/` con la propiedad seleccionada por query. */
function rutaCalendario(propertyId: string): string {
  return `/?propiedad=${propertyId}`;
}

const NUMEROS_EN_LETRAS: Record<number, string> = {
  1: "un",
  2: "dos",
  3: "tres",
  4: "cuatro",
  5: "cinco",
  6: "seis",
  7: "siete",
  8: "ocho",
  9: "nueve",
  10: "diez",
  11: "once",
  12: "doce",
  13: "trece",
  14: "catorce",
  15: "quince",
  16: "dieciséis",
  17: "diecisiete",
  18: "dieciocho",
  19: "diecinueve",
  20: "veinte",
  21: "veintiún",
  25: "veinticinco",
  30: "treinta",
};

type ClientePrisma = Db | Prisma.TransactionClient;

/**
 * Redacta la regla de ventana vigente («quince días antes de que empiece»).
 *
 * Va al payload del aviso y NO a la plantilla porque la anticipación es
 * configurable: con `bookingWindowDays = 30` o en modo FIXED_DAY, un texto
 * quemado en la plantilla mentiría a todo el mundo.
 */
async function etiquetaDeVentana(db: ClientePrisma, propertyId: string): Promise<string> {
  const politica = await politicaVigente(db, propertyId);
  const cfg = politica ?? DEFAULT_BOOKING_WINDOW;

  const hora =
    cfg.releaseHour === 0 && cfg.releaseMinute === 0
      ? ""
      : `, a las ${String(cfg.releaseHour).padStart(2, "0")}:${String(cfg.releaseMinute).padStart(2, "0")}`;

  if (cfg.mode === "FIXED_DAY") {
    return `el día ${cfg.releaseDayOfMonth} del mes anterior${hora}`;
  }

  const dias = cfg.bookingWindowDays;
  if (dias === 0) return `el día en que empieza el mes${hora}`;
  if (dias === 1) return `un día antes de que empiece${hora}`;

  const enLetras = NUMEROS_EN_LETRAS[dias] ?? String(dias);
  return `${enLetras} días antes de que empiece${hora}`;
}

type PoliticaVigente = {
  mode: "OFFSET_DAYS" | "FIXED_DAY";
  bookingWindowDays: number;
  releaseDayOfMonth: number;
  releaseHour: number;
  releaseMinute: number;
};

/**
 * Espejo en TypeScript de `wb_effective_policy()`: gana la específica de la
 * propiedad sobre la global y, entre iguales, la más reciente ya vigente.
 *
 * El desempate se hace en memoria y no en el ORDER BY porque en PostgreSQL
 * `ORDER BY property_id DESC` pone los NULL PRIMERO, que es justo lo contrario
 * de lo que hace falta aquí.
 */
async function politicaVigente(
  db: ClientePrisma,
  propertyId: string,
): Promise<PoliticaVigente | null> {
  const filas = await db.bookingPolicy.findMany({
    where: {
      OR: [{ propertyId }, { propertyId: null }],
      effectiveFrom: { lte: new Date() },
    },
    select: {
      propertyId: true,
      mode: true,
      bookingWindowDays: true,
      releaseDayOfMonth: true,
      releaseHour: true,
      releaseMinute: true,
    },
    orderBy: { effectiveFrom: "desc" },
  });

  const elegida = filas.find((f) => f.propertyId === propertyId) ?? filas.find((f) => f.propertyId === null);
  if (!elegida) return null;

  return {
    mode: elegida.mode,
    bookingWindowDays: elegida.bookingWindowDays,
    releaseDayOfMonth: elegida.releaseDayOfMonth,
    releaseHour: elegida.releaseHour,
    releaseMinute: elegida.releaseMinute,
  };
}
