/**
 * Cesión de días de una semana propia.
 *
 * Ceder es automático: no hay aceptación del receptor ni aprobación de nadie
 * (docs/diseno-wellbros.html §06). El día simplemente pasa a aparecer con sus
 * iniciales en el calendario de todos.
 *
 * El servicio es PURO de framework: recibe el actor y el cliente de Prisma, no
 * llama a `cookies()` ni a `requireUser()`. Eso lo hace la Server Action que lo
 * envuelve, y permite que mañana un `/api/v1` exponga exactamente esta función
 * sin reescribir la regla.
 *
 * Todo ocurre en UNA transacción: las cesiones, la bitácora y el encolado de
 * avisos. Si algo falla, no queda ni la cesión ni el correo prometiendo la
 * cesión.
 *
 * Este archivo también aloja las piezas compartidas con `revoke.ts` (contexto
 * de la reserva, aritmética de fechas civiles y etiquetas en español). Están
 * aquí y no en un módulo aparte para no multiplicar los archivos del módulo;
 * son internas al paquete `@/server/grants`.
 */

import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { DEFAULT_BOOKING_WINDOW, businessToday } from "@/lib/booking-window";
import type { Db } from "@/lib/db";
import {
  enqueueNotification,
  superuserIds,
} from "@/lib/notifications/dispatch";
import type { GrantedDay, WeekRef } from "@/lib/notifications/types";

import { grantError, translateDatabaseError } from "./errors";

/**
 * Quién actúa. Se pide explícito —nunca se deduce de la sesión aquí dentro— y
 * se declara como un subconjunto de `SessionUser` para que la Server Action
 * pueda pasar el usuario tal cual.
 */
export type GrantActor = Pick<SessionUser, "id" | "role">;

/** Una cesión ya resuelta, lista para devolver a la interfaz. */
export interface GrantSummary {
  id: string;
  reservationId: string;
  grantorUserId: string;
  granteeUserId: string;
  granteeName: string;
  /** `yyyy-MM-dd`. */
  date: string;
}

export interface CreateDayGrantsInput {
  db: Db;
  reservationId: string;
  actor: GrantActor;
  granteeUserId: string;
  /** Días a ceder, `yyyy-MM-dd`. Se ordenan y se deduplican. */
  dates: readonly string[];
  /** Reloj inyectable: las pruebas fijan el "hoy" del negocio. */
  now?: Date;
  /** Zona de negocio. Solo decide qué día es "hoy" para el rechazo de pasados. */
  timeZone?: string;
  /** IP de origen, para la bitácora. */
  ip?: string | null;
}

export interface CreateDayGrantsResult {
  /** Identificador del lote: la entidad de la clave de deduplicación del aviso. */
  grantBatchId: string;
  grants: GrantSummary[];
  /** Filas encoladas en el outbox (destinatarios × canales activos). */
  notified: number;
}

/* -------------------------------------------------------------------------- */
/* Fechas civiles                                                              */
/* -------------------------------------------------------------------------- */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `yyyy-MM-dd` → `Date` a medianoche UTC.
 *
 * Las columnas `date` de PostgreSQL no tienen hora ni zona, y el driver las
 * devuelve así. Fijar UTC evita que el huso del servidor corra el día uno
 * arriba o abajo, que es el error clásico de este tipo de columnas.
 */
export function toUtcDate(dateISO: string): Date {
  const m = ISO_DATE_RE.exec(dateISO);
  if (!m) {
    throw grantError("INVALID_DATE", `Fecha inválida: ${dateISO}`, [dateISO]);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rechaza el 31 de febrero y compañía, que `Date.UTC` normalizaría en silencio.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw grantError("INVALID_DATE", `Fecha inexistente: ${dateISO}`, [dateISO]);
  }
  return d;
}

/** `Date` de una columna `date` → `yyyy-MM-dd`. */
export function toISODate(value: Date): string {
  const year = String(value.getUTCFullYear()).padStart(4, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Valida, deduplica y ordena las fechas recibidas.
 *
 * El orden es parte del contrato: de él sale el `grantBatchId` (ver abajo), así
 * que ceder «sábado y domingo» y «domingo y sábado» tienen que producir el
 * mismo lote.
 */
export function normalizeDates(dates: readonly string[]): string[] {
  const unicas = [...new Set(dates)];
  if (unicas.length === 0) {
    throw grantError("NO_DATES", "No se indicó ningún día.");
  }
  // Valida el formato de todas antes de seguir.
  for (const d of unicas) toUtcDate(d);
  // `yyyy-MM-dd` ordena lexicográficamente igual que cronológicamente.
  return unicas.sort();
}

/* -------------------------------------------------------------------------- */
/* Etiquetas en español                                                        */
/* -------------------------------------------------------------------------- */

const WEEKDAY_NAMES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

const MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

/** «sábado 3 de octubre». */
export function formatDayLabel(dateISO: string): string {
  const d = toUtcDate(dateISO);
  return `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTH_NAMES[d.getUTCMonth()]}`;
}

/**
 * «viernes 2 al jueves 8 de octubre de 2026».
 *
 * El mes y el año se repiten solo cuando la semana los cruza, que es justo el
 * caso que confunde: «viernes 30 de octubre al jueves 5 de noviembre de 2026».
 */
export function formatWeekLabel(startISO: string, endISO: string): string {
  const start = toUtcDate(startISO);
  const end = toUtcDate(endISO);

  const inicio = `${WEEKDAY_NAMES[start.getUTCDay()]} ${start.getUTCDate()}`;
  const fin = `${WEEKDAY_NAMES[end.getUTCDay()]} ${end.getUTCDate()}`;
  const mesInicio = MONTH_NAMES[start.getUTCMonth()];
  const mesFin = MONTH_NAMES[end.getUTCMonth()];
  const anioInicio = start.getUTCFullYear();
  const anioFin = end.getUTCFullYear();

  if (anioInicio !== anioFin) {
    return `${inicio} de ${mesInicio} de ${anioInicio} al ${fin} de ${mesFin} de ${anioFin}`;
  }
  if (start.getUTCMonth() !== end.getUTCMonth()) {
    return `${inicio} de ${mesInicio} al ${fin} de ${mesFin} de ${anioFin}`;
  }
  return `${inicio} al ${fin} de ${mesFin} de ${anioFin}`;
}

/**
 * Enlace al calendario en la propiedad y el mes de la semana.
 *
 * El calendario vive en la raíz y conserva la propiedad seleccionada en la URL
 * (§04), así que el aviso puede llevar a la semana concreta en vez de a la
 * portada.
 */
export function calendarPath(propertyId: string, weekStartISO: string): string {
  const params = new URLSearchParams({
    propiedad: propertyId,
    mes: weekStartISO.slice(0, 7),
  });
  return `/?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Contexto de la reserva                                                      */
/* -------------------------------------------------------------------------- */

export interface ReservationContext {
  reservationId: string;
  status: "ACTIVE" | "CANCELLED";
  ownerUserId: string;
  ownerName: string;
  propertyId: string;
  propertyName: string;
  slotId: string;
  /** Viernes, `yyyy-MM-dd`. */
  startDate: string;
  /** Jueves, `yyyy-MM-dd`. */
  endDate: string;
}

/**
 * Carga la reserva bloqueando su fila.
 *
 * El `FOR UPDATE` no es decorativo: es el mismo bloqueo que toma el trigger
 * `wb_day_grant_validate`. Sin él, una cancelación concurrente podría colarse
 * entre esta lectura y la escritura y dejar una cesión viva colgando de una
 * reserva cancelada —o, al revés, que una revocación pisara con REVOKED lo que
 * la cancelación ya había marcado como CANCELLED, borrando el motivo real.
 */
export async function loadReservationContext(
  tx: Prisma.TransactionClient,
  reservationId: string,
): Promise<ReservationContext> {
  await tx.$executeRaw`SELECT id FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;

  const reserva = await tx.reservation.findUnique({
    where: { id: reservationId },
    select: {
      id: true,
      status: true,
      userId: true,
      user: { select: { fullName: true } },
      slot: {
        select: {
          id: true,
          startDate: true,
          endDate: true,
          propertyId: true,
          property: { select: { name: true } },
        },
      },
    },
  });

  if (!reserva) {
    throw grantError("RESERVATION_NOT_FOUND", "La reserva no existe.");
  }

  return {
    reservationId: reserva.id,
    status: reserva.status,
    ownerUserId: reserva.userId,
    ownerName: reserva.user.fullName,
    propertyId: reserva.slot.propertyId,
    propertyName: reserva.slot.property.name,
    slotId: reserva.slot.id,
    startDate: toISODate(reserva.slot.startDate),
    endDate: toISODate(reserva.slot.endDate),
  };
}

/** Semana ya resuelta para el payload del aviso. */
export function weekRefOf(ctx: ReservationContext): WeekRef {
  return {
    slotId: ctx.slotId,
    propertyName: ctx.propertyName,
    startDate: ctx.startDate,
    endDate: ctx.endDate,
    label: formatWeekLabel(ctx.startDate, ctx.endDate),
  };
}

/**
 * Comprueba que quien actúa puede tocar las cesiones de esta reserva.
 *
 * Ceder es un acto del DUEÑO, no una operación administrativa: la superusuaria
 * puede cancelar una reserva ajena, pero no repartir los días de otra persona.
 * Si algún día hiciera falta, sería una regla nueva y una entrada de bitácora
 * distinta, no un `if` más aquí.
 */
export function assertOwnerCanManage(
  ctx: ReservationContext,
  actor: GrantActor,
): void {
  if (ctx.status !== "ACTIVE") {
    throw grantError(
      "RESERVATION_NOT_ACTIVE",
      "La reserva está cancelada: sus días ya no se pueden ceder ni revocar.",
    );
  }
  if (ctx.ownerUserId !== actor.id) {
    throw grantError(
      "NOT_RESERVATION_OWNER",
      actor.role === "SUPERUSER"
        ? "Los días de una semana solo los cede quien la reservó, ni siquiera la administración."
        : "Solo quien tiene la reserva puede ceder o revocar sus días.",
    );
  }
}

/** Días de `dates` que ya transcurrieron respecto de `todayISO`. */
export function pastDates(
  dates: readonly string[],
  todayISO: string,
): string[] {
  // El día EN CURSO sigue siendo cedible y revocable: todavía no termina, y
  // quien llega esa tarde aún puede usarlo. Solo se congela lo ya vivido.
  return dates.filter((d) => d < todayISO);
}

/** "Hoy" en la zona de negocio, que es la única que importa para las semanas. */
export function businessTodayISO(now: Date, timeZone: string): string {
  return businessToday(now, { ...DEFAULT_BOOKING_WINDOW, timeZone });
}

/* -------------------------------------------------------------------------- */
/* Caso de uso                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Cede uno o varios días de una semana propia a otro usuario.
 *
 * Lanza `GrantError` con un código estable ante cualquier infracción; la
 * transacción entera se deshace, así que no hay cesiones a medias.
 */
export async function createDayGrants(
  input: CreateDayGrantsInput,
): Promise<CreateDayGrantsResult> {
  const {
    db,
    reservationId,
    actor,
    granteeUserId,
    now = new Date(),
    timeZone = DEFAULT_BOOKING_WINDOW.timeZone,
    ip = null,
  } = input;

  const fechas = normalizeDates(input.dates);
  const hoy = businessTodayISO(now, timeZone);

  // Se comprueba antes de abrir la transacción: no hace falta ir a la base para
  // saber que nadie se cede días a sí mismo (la base lo repite con un CHECK).
  if (granteeUserId === actor.id) {
    throw grantError(
      "GRANTEE_IS_GRANTOR",
      "No puedes cederte días a ti misma: la semana ya es tuya.",
    );
  }

  return db.$transaction(async (tx) => {
    const ctx = await loadReservationContext(tx, reservationId);
    assertOwnerCanManage(ctx, actor);

    const receptor = await tx.user.findUnique({
      where: { id: granteeUserId },
      select: { id: true, fullName: true, isActive: true },
    });
    if (!receptor) {
      throw grantError("GRANTEE_NOT_FOUND", "La persona a la que quieres ceder no existe.");
    }
    if (!receptor.isActive) {
      throw grantError(
        "GRANTEE_INACTIVE",
        `${receptor.fullName} ya no tiene acceso a Wellbros: no se le pueden ceder días.`,
      );
    }

    const fuera = fechas.filter((d) => d < ctx.startDate || d > ctx.endDate);
    if (fuera.length > 0) {
      throw grantError(
        "DATE_OUT_OF_WEEK",
        `Estos días no pertenecen a tu semana (${ctx.startDate} → ${ctx.endDate}): ${fuera.join(", ")}.`,
        fuera,
      );
    }

    const pasados = pastDates(fechas, hoy);
    if (pasados.length > 0) {
      throw grantError(
        "GRANT_DATE_PAST",
        `Estos días ya pasaron y no se pueden ceder: ${pasados.join(", ")}.`,
        pasados,
      );
    }

    // Comprobación explícita para poder decir QUÉ días chocan. El índice único
    // parcial de la base es quien lo garantiza de verdad; esto solo existe para
    // dar un mensaje útil en el caso normal, sin carrera de por medio.
    const yaCedidos = await tx.dayGrant.findMany({
      where: {
        reservationId,
        status: "ACTIVE",
        grantDate: { in: fechas.map(toUtcDate) },
      },
      select: { grantDate: true },
    });
    if (yaCedidos.length > 0) {
      const conflictos = yaCedidos.map((g) => toISODate(g.grantDate)).sort();
      throw grantError(
        "DAY_ALREADY_GRANTED",
        `Estos días ya están cedidos: ${conflictos.join(", ")}. Revócalos antes de volver a cederlos.`,
        conflictos,
      );
    }

    // Los identificadores se generan aquí, y no se dejan al DEFAULT de la base,
    // porque `createMany` no devuelve filas y el aviso necesita el id de cada
    // cesión (`GrantedDay.grantId`) además del del lote.
    const nuevas = fechas.map((fecha) => ({ id: randomUUID(), fecha }));

    try {
      await tx.dayGrant.createMany({
        data: nuevas.map((n) => ({
          id: n.id,
          reservationId,
          grantorUserId: actor.id,
          granteeUserId,
          grantDate: toUtcDate(n.fecha),
        })),
      });
    } catch (error) {
      // El trigger o el índice único ganaron la carrera: se traduce a nuestro
      // vocabulario. Si no es un error nuestro, se relanza intacto.
      throw translateDatabaseError(error, fechas) ?? error;
    }

    /**
     * Identificador del lote.
     *
     * `day_grants` no tiene columna de lote, pero el aviso sí necesita uno: es
     * la entidad de la clave de deduplicación del outbox
     * (`GRANT_CREATED/<lote>/<usuario>`). Se usa el id de la PRIMERA cesión del
     * lote una vez ordenadas por fecha, que es estable y reproducible.
     *
     * Las dos alternativas obvias fallan:
     *  · un uuid aleatorio haría que reintentar la misma operación encolara un
     *    segundo aviso idéntico — la deduplicación no serviría de nada;
     *  · el id de la reserva haría lo contrario: una SEGUNDA cesión distinta
     *    sobre la misma semana produciría la misma clave y `skipDuplicates` la
     *    descartaría en silencio, sin error y sin correo.
     */
    const grantBatchId = nuevas[0].id;

    const week = weekRefOf(ctx);
    const days: GrantedDay[] = nuevas.map((n) => ({
      grantId: n.id,
      date: n.fecha,
      label: formatDayLabel(n.fecha),
    }));
    const path = calendarPath(ctx.propertyId, ctx.startDate);

    await writeAudit(tx, {
      action: "GRANT_CREATED",
      entityType: "DAY_GRANT",
      entityId: grantBatchId,
      actorUserId: actor.id,
      ip,
      details: {
        grantBatchId,
        grantIds: nuevas.map((n) => n.id),
        reservationId,
        slotId: ctx.slotId,
        propertyName: ctx.propertyName,
        weekStartDate: ctx.startDate,
        weekEndDate: ctx.endDate,
        grantorUserId: ctx.ownerUserId,
        grantorName: ctx.ownerName,
        granteeUserId: receptor.id,
        granteeName: receptor.fullName,
        dates: fechas,
      },
    });

    // Un solo aviso por operación, no uno por día: el payload lleva la lista.
    // Los involucrados y la superusuaria, que ve todo el movimiento de la casa.
    const notified = await enqueueNotification(tx, {
      eventType: "GRANT_CREATED",
      payload: {
        grantBatchId,
        reservationId,
        grantorUserId: ctx.ownerUserId,
        grantorName: ctx.ownerName,
        granteeUserId: receptor.id,
        granteeName: receptor.fullName,
        week,
        days,
        path,
      },
      recipientUserIds: [ctx.ownerUserId, receptor.id, ...(await superuserIds(tx))],
    });

    const grants: GrantSummary[] = nuevas.map((n) => ({
      id: n.id,
      reservationId,
      grantorUserId: ctx.ownerUserId,
      granteeUserId: receptor.id,
      granteeName: receptor.fullName,
      date: n.fecha,
    }));

    return { grantBatchId, grants, notified };
  });
}
