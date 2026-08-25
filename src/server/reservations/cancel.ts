/**
 * Cancelar una reserva.
 *
 * Cancelar no es «borrar una fila»: es deshacer un compromiso del que cuelgan
 * cesiones de días, un slot que debe volver a estar libre y varias personas que
 * tienen que enterarse. Todo eso ocurre en UNA transacción — o se confirma
 * entero, o no ocurre nada.
 *
 * Dos decisiones que conviene tener a la vista:
 *
 *   · Una cesión NUNCA sobrevive a su reserva. Las cesiones ACTIVE caen a
 *     CANCELLED en cascada dentro de la misma transacción; el trigger
 *     `wb_day_grant_validate` bloquea la reserva antes de insertar una cesión,
 *     así que una cesión concurrente con esta cancelación espera y falla limpio
 *     en vez de quedar colgando de una reserva muerta.
 *   · Si la semana pertenece a un mes que TODAVÍA NO ABRE, el aviso de
 *     liberación no sale ya: se programa para el instante de apertura.
 *     Anunciar algo que nadie puede tomar solo da ventaja a quien lea el correo
 *     a deshoras (§07).
 *
 * Función PURA DE FRAMEWORK, igual que `createReservation`.
 */

import type { Prisma } from "@/generated/prisma/client";
import type { AuditDetails } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { isWeekBookable } from "@/lib/booking-window";
import type { Db } from "@/lib/db";
import { activeUserIds, enqueueNotification } from "@/lib/notifications/dispatch";

import {
  assertUuid,
  buildWeekRef,
  calendarPath,
  effectivePolicy,
  releaseLabel,
  type ReservationActor,
} from "./create";
import { ReservationError } from "./errors";

export interface CancelReservationInput {
  db: Db;
  reservationId: string;
  actor: ReservationActor;
  /** Motivo de la cancelación. Se guarda en la reserva y en la bitácora. */
  reason?: string | null;
  ip?: string | null;
}

/** Cesión arrastrada por la cancelación. */
export interface CancelledGrant {
  grantId: string;
  /** `yyyy-MM-dd`. */
  date: string;
  granteeUserId: string;
  granteeName: string;
}

export interface CancelledReservation {
  reservationId: string;
  slotId: string;
  propertyId: string;
  propertyName: string;
  startDate: string;
  endDate: string;
  ownerUserId: string;
  ownerName: string;
  /** La canceló alguien que no era el dueño (siempre el superusuario). */
  byAdmin: boolean;
  cancelledGrants: CancelledGrant[];
  /** Cuándo saldrá el aviso: futuro si el mes de la semana aún no abre. */
  notifyAt: Date;
  notificationsQueued: number;
}

const TX_TIMEOUT_MS = 15_000;

interface FilaReserva {
  id: string;
  status: string;
  user_id: string;
  owner_name: string;
  owner_email: string;
  slot_id: string;
  slot_status: string;
  property_id: string;
  property_name: string;
  start_date: string;
  end_date: string;
}

export async function cancelReservation(
  input: CancelReservationInput,
): Promise<CancelledReservation> {
  const { db, reservationId } = input;

  assertUuid(reservationId, new ReservationError("RESERVATION_NOT_FOUND"));

  return db.$transaction(async (tx) => cancelarEnTransaccion(tx, input), {
    timeout: TX_TIMEOUT_MS,
  });
}

async function cancelarEnTransaccion(
  tx: Prisma.TransactionClient,
  input: CancelReservationInput,
): Promise<CancelledReservation> {
  const { reservationId, actor } = input;

  // ── 0. Bloqueo del SLOT, ANTES que el de la reserva.
  //
  // El orden importa y no es cosmético: `createReservation` y `closeWeek` toman
  // primero el slot y después la reserva. Cancelar al revés (reserva → slot)
  // produce un interbloqueo real —cancelar y cerrar con `force` la misma semana
  // a la vez lo provoca sistemáticamente— y PostgreSQL lo resuelve abortando una
  // de las dos con 40P01, que llega a la interfaz como error crudo en lugar de
  // como error de negocio. Con el mismo orden en los tres servicios, la
  // competencia se resuelve esperando.
  //
  // `FOR UPDATE OF s` bloquea SOLO la fila del slot: la reserva se lee aquí sin
  // bloquear (su `slot_id` no cambia nunca) y se bloquea en la consulta
  // siguiente, que es la que decide.
  await tx.$executeRaw`
    SELECT s.id
      FROM week_slots s
      JOIN reservations r ON r.slot_id = s.id
     WHERE r.id = ${reservationId}::uuid
       FOR UPDATE OF s
  `;

  // ── 1. Bloqueo de la RESERVA: es el mismo bloqueo que toma el trigger de
  // cesiones, así que ceder y cancelar a la vez se ordena solo.
  const filas = await tx.$queryRaw<FilaReserva[]>`
    SELECT r.id,
           r.status::text AS status,
           r.user_id,
           u.full_name    AS owner_name,
           u.email::text  AS owner_email,
           s.id           AS slot_id,
           s.status::text AS slot_status,
           s.property_id,
           p.name         AS property_name,
           to_char(s.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(s.end_date,   'YYYY-MM-DD') AS end_date
      FROM reservations r
      JOIN week_slots s  ON s.id = r.slot_id
      JOIN properties p  ON p.id = s.property_id
      JOIN users u       ON u.id = r.user_id
     WHERE r.id = ${reservationId}::uuid
       FOR UPDATE OF r
  `;

  const reserva = filas[0];
  if (!reserva) throw new ReservationError("RESERVATION_NOT_FOUND");

  // ── 2. Permisos. Solo el dueño o el superusuario; cualquier otro, ni siquiera
  // se entera de si la reserva existía o no más allá de este punto.
  const esDueno = reserva.user_id === actor.id;
  const esAdmin = actor.role === "SUPERUSER";
  if (!esDueno && !esAdmin) {
    throw new ReservationError("NOT_ALLOWED", {
      message: "Solo quien reservó la semana (o la administración) puede cancelarla.",
    });
  }

  if (reserva.status !== "ACTIVE") {
    throw new ReservationError("RESERVATION_ALREADY_CANCELLED");
  }

  const ahora = new Date();
  const motivo = input.reason?.trim() || null;

  // ── 3. La reserva pasa a CANCELLED. El CHECK de la base exige que una
  // cancelada diga siempre cuándo y quién.
  await tx.reservation.update({
    where: { id: reserva.id },
    data: {
      status: "CANCELLED",
      cancelledAt: ahora,
      cancelledById: actor.id,
      cancelReason: motivo,
    },
    select: { id: true },
  });

  // ── 4. Cascada de cesiones. Se leen ANTES de tocarlas: hay que saber a quién
  // avisar y qué guardar en el snapshot de la bitácora.
  const cesionesVivas = await tx.dayGrant.findMany({
    where: { reservationId: reserva.id, status: "ACTIVE" },
    select: {
      id: true,
      grantDate: true,
      granteeUserId: true,
      grantee: { select: { fullName: true } },
    },
    orderBy: { grantDate: "asc" },
  });

  const cancelledGrants: CancelledGrant[] = cesionesVivas.map((c) => ({
    grantId: c.id,
    date: c.grantDate.toISOString().slice(0, 10),
    granteeUserId: c.granteeUserId,
    granteeName: c.grantee.fullName,
  }));

  if (cancelledGrants.length > 0) {
    await tx.dayGrant.updateMany({
      where: { reservationId: reserva.id, status: "ACTIVE" },
      data: { status: "CANCELLED", endedAt: ahora },
    });
  }

  // ── 5. La semana vuelve a quedar disponible.
  //
  // Solo si estaba RESERVED: un slot CLOSED llegó ahí porque el superusuario lo
  // cerró (cierre forzado de una semana reservada), y reabrirlo aquí desharía
  // en silencio esa decisión.
  if (reserva.slot_status === "RESERVED") {
    await tx.weekSlot.update({
      where: { id: reserva.slot_id },
      data: { status: "OPEN" },
    });
  }

  // ── 6. Bitácora con snapshot completo. Si canceló alguien que no es el dueño
  // se escribe la acción de administración: es un hecho distinto y así se filtra.
  const semana = buildWeekRef({
    id: reserva.slot_id,
    propertyName: reserva.property_name,
    startDate: reserva.start_date,
    endDate: reserva.end_date,
  });

  const detalles: AuditDetails = {
    reservationId: reserva.id,
    slotId: reserva.slot_id,
    propertyId: reserva.property_id,
    propertyName: reserva.property_name,
    startDate: reserva.start_date,
    endDate: reserva.end_date,
    weekLabel: semana.label,
    ownerUserId: reserva.user_id,
    ownerName: reserva.owner_name,
    ownerEmail: reserva.owner_email,
    cancelledByUserId: actor.id,
    cancelledByName: actor.fullName,
    cancelReason: motivo,
    cancelledGrants: cancelledGrants.map((c) => ({
      grantId: c.grantId,
      date: c.date,
      granteeUserId: c.granteeUserId,
      granteeName: c.granteeName,
    })),
  };

  await writeAudit(tx, {
    action: esDueno ? "RESERVATION_CANCELLED" : "RESERVATION_CANCELLED_BY_ADMIN",
    entityType: "RESERVATION",
    entityId: reserva.id,
    actorUserId: actor.id,
    details: detalles,
    ip: input.ip ?? null,
  });

  // ── 7. Avisos: al dueño, a los cesionarios afectados y a todos los activos.
  // Si el mes de la semana aún no abre, el aviso se PROGRAMA para la apertura.
  const { config } = await effectivePolicy(tx, reserva.property_id);
  const veredicto = isWeekBookable(reserva.start_date, ahora, config);
  const diferido = veredicto.reason === "BEFORE_WINDOW";
  const notifyAt = diferido ? veredicto.releaseAt : ahora;

  const destinatarios = [
    reserva.user_id,
    ...cancelledGrants.map((c) => c.granteeUserId),
    ...(await activeUserIds(tx)),
  ];

  const notificationsQueued = await enqueueNotification(tx, {
    eventType: "RESERVATION_CANCELLED",
    payload: {
      reservationId: reserva.id,
      ownerUserId: reserva.user_id,
      ownerName: reserva.owner_name,
      cancelledByName: actor.fullName,
      ...(motivo ? { cancelReason: motivo } : {}),
      week: semana,
      path: calendarPath(reserva.property_id, reserva.start_date),
      ...(diferido
        ? { availableFromLabel: releaseLabel(veredicto.releaseAt, config.timeZone) }
        : {}),
    },
    recipientUserIds: destinatarios,
    ...(diferido ? { scheduledFor: veredicto.releaseAt } : {}),
  });

  return {
    reservationId: reserva.id,
    slotId: reserva.slot_id,
    propertyId: reserva.property_id,
    propertyName: reserva.property_name,
    startDate: reserva.start_date,
    endDate: reserva.end_date,
    ownerUserId: reserva.user_id,
    ownerName: reserva.owner_name,
    byAdmin: !esDueno,
    cancelledGrants,
    notifyAt,
    notificationsQueued,
  };
}
