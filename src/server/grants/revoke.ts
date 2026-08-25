/**
 * Revocación de días cedidos.
 *
 * El dueño de la semana retira días que había cedido y que todavía no han
 * transcurrido. La cesión no se borra: pasa a REVOKED con su `endedAt`, porque
 * la historia de quién tuvo qué día importa tanto como el estado actual.
 *
 * REVOKED y CANCELLED no son sinónimos y no deben confundirse nunca:
 *   · REVOKED   = el dueño la retiró a propósito (esto).
 *   · CANCELLED = cayó en cascada al cancelarse la reserva entera.
 * Por eso este servicio exige que la reserva siga ACTIVE y bloquea su fila: si
 * una cancelación concurrente ya marcó las cesiones como CANCELLED, revocarlas
 * encima reescribiría el motivo y el aviso mentiría al receptor.
 */

import { writeAudit } from "@/lib/audit";
import { DEFAULT_BOOKING_WINDOW } from "@/lib/booking-window";
import type { Db } from "@/lib/db";
import {
  enqueueNotification,
  superuserIds,
} from "@/lib/notifications/dispatch";
import type { GrantedDay } from "@/lib/notifications/types";

import {
  assertOwnerCanManage,
  businessTodayISO,
  calendarPath,
  formatDayLabel,
  loadReservationContext,
  normalizeDates,
  pastDates,
  toISODate,
  toUtcDate,
  weekRefOf,
  type GrantActor,
  type GrantSummary,
} from "./create";
import { grantError } from "./errors";

export interface RevokeDayGrantsInput {
  db: Db;
  reservationId: string;
  actor: GrantActor;
  /** Días a retirar, `yyyy-MM-dd`. Se ordenan y se deduplican. */
  dates: readonly string[];
  now?: Date;
  timeZone?: string;
  ip?: string | null;
}

/**
 * Un lote de revocación: los días retirados a UNA misma persona.
 *
 * La operación puede tocar días cedidos a receptores distintos —nada impide
 * repartir la semana entre dos personas—, y el aviso de cesión habla de un solo
 * receptor. Así que se agrupa: un lote, una entrada de bitácora y un aviso por
 * cada persona afectada.
 */
export interface RevokedBatch {
  grantBatchId: string;
  granteeUserId: string;
  granteeName: string;
  /** `yyyy-MM-dd`, en orden. */
  dates: string[];
}

export interface RevokeDayGrantsResult {
  batches: RevokedBatch[];
  grants: GrantSummary[];
  notified: number;
}

export async function revokeDayGrants(
  input: RevokeDayGrantsInput,
): Promise<RevokeDayGrantsResult> {
  const {
    db,
    reservationId,
    actor,
    now = new Date(),
    timeZone = DEFAULT_BOOKING_WINDOW.timeZone,
    ip = null,
  } = input;

  const fechas = normalizeDates(input.dates);
  const hoy = businessTodayISO(now, timeZone);

  return db.$transaction(async (tx) => {
    const ctx = await loadReservationContext(tx, reservationId);
    assertOwnerCanManage(ctx, actor);

    const pasados = pastDates(fechas, hoy);
    if (pasados.length > 0) {
      throw grantError(
        "GRANT_DATE_PAST",
        `Estos días ya pasaron y no se pueden revocar: ${pasados.join(", ")}.`,
        pasados,
      );
    }

    const vivas = await tx.dayGrant.findMany({
      where: {
        reservationId,
        status: "ACTIVE",
        grantDate: { in: fechas.map(toUtcDate) },
      },
      select: {
        id: true,
        grantDate: true,
        granteeUserId: true,
        grantee: { select: { fullName: true } },
      },
      orderBy: { grantDate: "asc" },
    });

    const encontradas = new Set(vivas.map((g) => toISODate(g.grantDate)));
    const faltantes = fechas.filter((f) => !encontradas.has(f));
    if (faltantes.length > 0) {
      throw grantError(
        "GRANT_NOT_FOUND",
        `Estos días no están cedidos ahora mismo: ${faltantes.join(", ")}.`,
        faltantes,
      );
    }

    const ids = vivas.map((g) => g.id);
    const { count } = await tx.dayGrant.updateMany({
      // El filtro por estado repite la condición a propósito: es la que hace
      // que una cancelación que se colara entre la lectura y esta escritura
      // deje `count` corto en vez de pisar su CANCELLED con un REVOKED.
      where: { id: { in: ids }, status: "ACTIVE" },
      data: { status: "REVOKED", endedAt: now },
    });
    if (count !== ids.length) {
      throw grantError(
        "GRANT_NOT_FOUND",
        "Alguna de esas cesiones cambió de estado mientras se revocaba. Vuelve a intentarlo.",
        fechas,
      );
    }

    // Agrupación por receptor, conservando el orden por fecha que trae `vivas`.
    const lotes = new Map<
      string,
      { granteeName: string; days: GrantedDay[]; ids: string[] }
    >();
    for (const g of vivas) {
      const fecha = toISODate(g.grantDate);
      const lote = lotes.get(g.granteeUserId) ?? {
        granteeName: g.grantee.fullName,
        days: [],
        ids: [],
      };
      lote.days.push({ grantId: g.id, date: fecha, label: formatDayLabel(fecha) });
      lote.ids.push(g.id);
      lotes.set(g.granteeUserId, lote);
    }

    const week = weekRefOf(ctx);
    const path = calendarPath(ctx.propertyId, ctx.startDate);
    const superusuarias = await superuserIds(tx);

    const batches: RevokedBatch[] = [];
    const grants: GrantSummary[] = [];
    let notified = 0;

    for (const [granteeUserId, lote] of lotes) {
      // Misma regla que al ceder: el id de la primera cesión del lote ordenada
      // por fecha. Estable entre reintentos y distinto para cada operación, que
      // es lo que la clave de deduplicación necesita para funcionar.
      const grantBatchId = lote.ids[0];
      const dates = lote.days.map((d) => d.date);

      await writeAudit(tx, {
        action: "GRANT_REVOKED",
        entityType: "DAY_GRANT",
        entityId: grantBatchId,
        actorUserId: actor.id,
        ip,
        details: {
          grantBatchId,
          grantIds: lote.ids,
          reservationId,
          slotId: ctx.slotId,
          propertyName: ctx.propertyName,
          weekStartDate: ctx.startDate,
          weekEndDate: ctx.endDate,
          grantorUserId: ctx.ownerUserId,
          grantorName: ctx.ownerName,
          granteeUserId,
          granteeName: lote.granteeName,
          dates,
        },
      });

      notified += await enqueueNotification(tx, {
        eventType: "GRANT_REVOKED",
        payload: {
          grantBatchId,
          reservationId,
          grantorUserId: ctx.ownerUserId,
          grantorName: ctx.ownerName,
          granteeUserId,
          granteeName: lote.granteeName,
          week,
          days: lote.days,
          path,
        },
        recipientUserIds: [ctx.ownerUserId, granteeUserId, ...superusuarias],
      });

      batches.push({
        grantBatchId,
        granteeUserId,
        granteeName: lote.granteeName,
        dates,
      });

      for (const day of lote.days) {
        grants.push({
          id: day.grantId,
          reservationId,
          grantorUserId: ctx.ownerUserId,
          granteeUserId,
          granteeName: lote.granteeName,
          date: day.date,
        });
      }
    }

    return { batches, grants, notified };
  });
}
