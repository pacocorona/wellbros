/**
 * Crear una reserva.
 *
 * Es el código más delicado del sistema: dos personas pueden pulsar «Reservar»
 * sobre la misma semana en el mismo segundo, y a las 00:00 del día de apertura
 * eso deja de ser hipotético (§07). La estrategia tiene tres capas y ninguna
 * sobra:
 *
 *   1. `SELECT ... FOR UPDATE` sobre el slot: serializa a los competidores. El
 *      segundo espera al primero y ve el estado YA actualizado, así que recibe
 *      un error de negocio limpio en lugar de una violación de índice.
 *   2. La revalidación de la ventana DENTRO de la transacción: el reloj que
 *      manda es el del servidor, nunca el del navegador.
 *   3. El índice único parcial `reservations_slot_id_active_key`: si aun así
 *      dos escrituras llegaran a la vez, la base rechaza la segunda. La base es
 *      la última línea de defensa, nunca la validación de la interfaz.
 *
 * Función PURA DE FRAMEWORK: recibe el actor y el cliente de Prisma; no llama a
 * `cookies()` ni a `requireUser()`. Así una futura app nativa puede exponerla
 * por /api/v1 sin reescribir nada.
 */

import { TZDate } from "@date-fns/tz";

import { Prisma } from "@/generated/prisma/client";
import type { AuditDetails, AuditEntry } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import {
  DEFAULT_BOOKING_WINDOW,
  isWeekBookable,
  type BookingWindowConfig,
} from "@/lib/booking-window";
import type { Db } from "@/lib/db";
import { activeUserIds, enqueueNotification } from "@/lib/notifications/dispatch";
import type { WeekRef } from "@/lib/notifications/types";

import { ReservationError } from "./errors";

/**
 * Quien ejecuta la acción. Estructuralmente compatible con `SessionUser`, pero
 * declarado aquí para que src/server no dependa de la capa de autenticación
 * (que a su vez depende de `next/headers`).
 */
export interface ReservationActor {
  id: string;
  role: "SUPERUSER" | "USER";
  fullName: string;
}

export interface CreateReservationInput {
  db: Db;
  slotId: string;
  actor: ReservationActor;
  /** Reservar a nombre de otro. Exclusivo del superusuario. */
  forUserId?: string | null;
  /** Motivo para saltarse la ventana de apertura. Solo lo usa el superusuario. */
  override?: { reason?: string | null } | null;
  /** Origen de la petición, para la bitácora. */
  ip?: string | null;
}

export interface CreatedReservation {
  reservationId: string;
  slotId: string;
  propertyId: string;
  propertyName: string;
  /** Viernes de inicio, `yyyy-MM-dd`. */
  startDate: string;
  /** Jueves final, `yyyy-MM-dd`. */
  endDate: string;
  ownerUserId: string;
  ownerName: string;
  /** Se creó saltándose la ventana de apertura. */
  windowOverride: boolean;
  /** Filas de aviso encoladas en la misma transacción. */
  notificationsQueued: number;
}

/** Tiempo de la transacción interactiva: el trabajo son 6 consultas cortas. */
const TX_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------ */
/* Utilidades compartidas con cancel.ts                                */
/* ------------------------------------------------------------------ */
// Viven aquí y no en un módulo aparte para no ampliar la superficie de archivos
// acordada con el integrador. `cancel.ts` las importa desde este módulo.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MESES = [
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

const DIAS_SEMANA = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

/** `yyyy-MM-dd` leído como fecha CIVIL (mediodía UTC evita cualquier corrimiento). */
function civil(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function dosDigitos(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * «viernes 2 al jueves 8 de octubre de 2026».
 *
 * El texto se congela en el payload del aviso y NO se recalcula al renderizar:
 * si cambiara entre reintentos, Resend vería la misma clave de idempotencia con
 * otro cuerpo y respondería error en lugar de reenviar (§08).
 */
export function weekLabel(startDateISO: string, endDateISO: string): string {
  const ini = civil(startDateISO);
  const fin = civil(endDateISO);
  const diaIni = `${DIAS_SEMANA[ini.getUTCDay()]} ${ini.getUTCDate()}`;
  const diaFin = `${DIAS_SEMANA[fin.getUTCDay()]} ${fin.getUTCDate()}`;
  const mesFin = MESES[fin.getUTCMonth()];
  const anioFin = fin.getUTCFullYear();

  if (ini.getUTCFullYear() !== anioFin) {
    return `${diaIni} de ${MESES[ini.getUTCMonth()]} de ${ini.getUTCFullYear()} al ${diaFin} de ${mesFin} de ${anioFin}`;
  }
  if (ini.getUTCMonth() !== fin.getUTCMonth()) {
    return `${diaIni} de ${MESES[ini.getUTCMonth()]} al ${diaFin} de ${mesFin} de ${anioFin}`;
  }
  return `${diaIni} al ${diaFin} de ${mesFin} de ${anioFin}`;
}

/**
 * Instante de apertura como texto en la zona de negocio:
 * «16 de septiembre de 2026 a las 00:00 h».
 */
export function releaseLabel(releaseAt: Date, timeZone: string): string {
  const z = new TZDate(releaseAt.getTime(), timeZone);
  return (
    `${z.getDate()} de ${MESES[z.getMonth()]} de ${z.getFullYear()} ` +
    `a las ${dosDigitos(z.getHours())}:${dosDigitos(z.getMinutes())} h`
  );
}

/**
 * Ruta profunda al calendario, ya apuntando a la propiedad y la semana.
 * Es el enlace que llevan los correos; se vuelve absoluta con APP_BASE_URL.
 */
export function calendarPath(propertyId: string, startDateISO: string): string {
  return `/calendario?propiedad=${encodeURIComponent(propertyId)}&semana=${startDateISO}`;
}

/** Semana ya resuelta tal como la esperan las plantillas de aviso. */
export function buildWeekRef(slot: {
  id: string;
  propertyName: string;
  startDate: string;
  endDate: string;
}): WeekRef {
  return {
    slotId: slot.id,
    propertyName: slot.propertyName,
    startDate: slot.startDate,
    endDate: slot.endDate,
    label: weekLabel(slot.startDate, slot.endDate),
  };
}

/** Identificador que la base pueda castear a uuid sin reventar con 22P02. */
export function assertUuid(value: string, error: ReservationError): void {
  if (!UUID_RE.test(value)) throw error;
}

export interface EffectivePolicy {
  /** Fila concreta que se guarda en `reservations.policy_id`. */
  policyId: string | null;
  config: BookingWindowConfig;
}

interface FilaPolitica {
  policy_id: string;
  time_zone: string;
  mode: string;
  booking_window_days: number;
  release_day_of_month: number;
  release_hour: number;
  release_minute: number;
  anchor_offset_days: number;
  allow_in_progress_week: boolean;
  visible_horizon_months: number;
  superuser_override: string;
}

/**
 * Política vigente para una propiedad.
 *
 * La resuelve `wb_effective_policy()`, la MISMA función que usa el trigger de la
 * base: si la aplicación eligiera la fila por su cuenta, podría juzgar con una
 * política distinta a la que aplica la última línea de defensa y el rechazo
 * llegaría como error crudo de Postgres en vez de como error de negocio.
 */
export async function effectivePolicy(
  tx: Prisma.TransactionClient,
  propertyId: string,
): Promise<EffectivePolicy> {
  const filas = await tx.$queryRaw<FilaPolitica[]>`
    SELECT policy_id,
           time_zone,
           mode::text                AS mode,
           booking_window_days,
           release_day_of_month,
           release_hour,
           release_minute,
           anchor_offset_days,
           allow_in_progress_week,
           visible_horizon_months,
           superuser_override::text  AS superuser_override
      FROM wb_effective_policy(${propertyId}::uuid)
  `;

  const fila = filas[0];
  // Sin política cargada se usan los valores confirmados con el cliente, que
  // son exactamente los que la vista y el trigger toman por defecto.
  if (!fila) return { policyId: null, config: DEFAULT_BOOKING_WINDOW };

  return {
    policyId: fila.policy_id,
    config: {
      timeZone: fila.time_zone,
      mode: fila.mode === "FIXED_DAY" ? "FIXED_DAY" : "OFFSET_DAYS",
      bookingWindowDays: fila.booking_window_days,
      releaseDayOfMonth: fila.release_day_of_month,
      releaseHour: fila.release_hour,
      releaseMinute: fila.release_minute,
      anchorOffsetDays: fila.anchor_offset_days,
      allowInProgressWeek: fila.allow_in_progress_week,
      visibleHorizonMonths: fila.visible_horizon_months,
      superuserOverride:
        fila.superuser_override === "NEVER"
          ? "NEVER"
          : fila.superuser_override === "AUDITED"
            ? "AUDITED"
            : "ALWAYS_EXEMPT",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rechazo por ventana                                                 */
/* ------------------------------------------------------------------ */

/**
 * Envoltorio interno para sacar del `$transaction` dos cosas a la vez: el error
 * de negocio que verá el usuario y la anotación de bitácora que hay que dejar.
 *
 * Existe por una razón concreta: la anotación del RECHAZO no puede escribirse
 * dentro de la transacción, porque la transacción termina en rollback y se
 * llevaría la evidencia con ella. Se escribe fuera, ya sin transacción, y por
 * eso hay que transportarla hasta allí.
 */
class RechazoDeVentana extends Error {
  constructor(
    readonly entrada: AuditEntry,
    readonly error: ReservationError,
  ) {
    super(error.message);
    this.name = "RechazoDeVentana";
  }
}

interface FilaSlot {
  id: string;
  property_id: string;
  property_name: string;
  property_active: boolean;
  start_date: string;
  end_date: string;
  status: string;
}

/* ------------------------------------------------------------------ */
/* Caso de uso                                                         */
/* ------------------------------------------------------------------ */

export async function createReservation(
  input: CreateReservationInput,
): Promise<CreatedReservation> {
  const { db, slotId, actor } = input;

  assertUuid(slotId, new ReservationError("SLOT_NOT_FOUND"));

  // Reservar a nombre de otro es privilegio del superusuario. Se comprueba
  // antes de abrir la transacción: no hay por qué tomar bloqueos para negar.
  const ownerUserId = input.forUserId?.trim() || actor.id;
  if (ownerUserId !== actor.id && actor.role !== "SUPERUSER") {
    throw new ReservationError("NOT_ALLOWED", {
      message: "Solo la administración puede reservar a nombre de otra persona.",
    });
  }
  assertUuid(ownerUserId, new ReservationError("NOT_ALLOWED"));

  try {
    return await db.$transaction(
      async (tx) => crearEnTransaccion(tx, input, ownerUserId),
      { timeout: TX_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof RechazoDeVentana) {
      // La transacción ya hizo rollback: esta anotación se escribe sola y
      // sobrevive. Si fallara, el fallo sale a la superficie a propósito —
      // quedarse sin evidencia de un rechazo es un problema real, no ruido.
      await writeAudit(db, error.entrada);
      throw error.error;
    }
    throw traducirErrorDeBase(error);
  }
}

async function crearEnTransaccion(
  tx: Prisma.TransactionClient,
  input: CreateReservationInput,
  ownerUserId: string,
): Promise<CreatedReservation> {
  const { slotId, actor } = input;

  // ── 1. Bloqueo del slot: aquí se serializan los competidores.
  // FOR UPDATE OF s bloquea la fila del slot, no la de la propiedad: no hay
  // motivo para congelar una propiedad entera por una reserva.
  const filas = await tx.$queryRaw<FilaSlot[]>`
    SELECT s.id,
           s.property_id,
           p.name      AS property_name,
           p.is_active AS property_active,
           to_char(s.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(s.end_date,   'YYYY-MM-DD') AS end_date,
           s.status::text AS status
      FROM week_slots s
      JOIN properties p ON p.id = s.property_id
     WHERE s.id = ${slotId}::uuid
       FOR UPDATE OF s
  `;

  const slot = filas[0];
  if (!slot) throw new ReservationError("SLOT_NOT_FOUND");

  if (slot.status === "RESERVED") {
    throw new ReservationError("SLOT_TAKEN");
  }
  if (slot.status !== "OPEN") {
    throw new ReservationError("SLOT_NOT_OPEN", {
      message: "Esa semana está cerrada.",
    });
  }
  if (!slot.property_active) {
    throw new ReservationError("SLOT_NOT_OPEN", {
      message: `${slot.property_name} ya no admite reservas.`,
    });
  }

  // ── 2. Dueño de la reserva. Un usuario dado de baja no puede aparecer como
  // titular de una semana futura: la baja es una decisión, no un descuido.
  const dueno = await tx.user.findUnique({
    where: { id: ownerUserId },
    select: { id: true, fullName: true, email: true, isActive: true },
  });
  if (!dueno || !dueno.isActive) {
    throw new ReservationError("NOT_ALLOWED", {
      message: "Esa persona no puede tener reservas a su nombre.",
    });
  }

  // ── 3. Ventana de apertura, revalidada con el reloj del servidor.
  const { policyId, config } = await effectivePolicy(tx, slot.property_id);
  const ahora = new Date();
  const veredicto = isWeekBookable(slot.start_date, ahora, config);

  const semana = buildWeekRef({
    id: slot.id,
    propertyName: slot.property_name,
    startDate: slot.start_date,
    endDate: slot.end_date,
  });

  const motivoOverride = input.override?.reason?.trim() ?? "";
  let windowOverride = false;

  if (!veredicto.bookable) {
    // El superusuario está exento salvo que la política lo prohíba (NEVER).
    // AUDITED se trata igual que ALWAYS_EXEMPT en cuanto al permiso: lo que
    // cambia entre ambos es la vigilancia, y aquí SIEMPRE se vigila.
    const puedeSaltarse =
      actor.role === "SUPERUSER" && config.superuserOverride !== "NEVER";

    const detallesRechazo: AuditDetails = {
      slotId: slot.id,
      propertyId: slot.property_id,
      propertyName: slot.property_name,
      startDate: slot.start_date,
      endDate: slot.end_date,
      ownerUserId,
      ownerName: dueno.fullName,
      actorRole: actor.role,
      reason: veredicto.reason,
      releaseAt: veredicto.releaseAt.toISOString(),
      anchorMonth: veredicto.anchorMonth,
    };

    if (!puedeSaltarse) {
      // Los rechazos por ventana se anotan: son la evidencia de que la regla
      // funciona y delatan a quien insista a deshoras.
      throw new RechazoDeVentana(
        {
          action: "RESERVATION_REJECTED_WINDOW",
          entityType: "WEEK_SLOT",
          entityId: slot.id,
          actorUserId: actor.id,
          details: detallesRechazo,
          ip: input.ip ?? null,
        },
        errorDeVentana(veredicto.reason, veredicto.releaseAt, config.timeZone),
      );
    }

    if (motivoOverride === "") {
      // Sin motivo no hay excepción. También se anota: un intento de saltarse
      // la ventana es información aunque no llegue a consumarse.
      throw new RechazoDeVentana(
        {
          action: "RESERVATION_REJECTED_WINDOW",
          entityType: "WEEK_SLOT",
          entityId: slot.id,
          actorUserId: actor.id,
          details: { ...detallesRechazo, missingOverrideReason: true },
          ip: input.ip ?? null,
        },
        new ReservationError("OVERRIDE_REASON_REQUIRED"),
      );
    }

    windowOverride = true;

    // La excepción se abre en la MISMA transacción; el tercer argumento (local)
    // hace que muera con ella. El trigger, al verla, fuerza window_override en
    // la fila y exige el motivo: la excepción nunca es silenciosa.
    await tx.$executeRaw`SELECT set_config('wellbros.window_override', 'on', true)`;
  }

  // ── 4. Inserción. El índice único parcial es quien decide de verdad.
  //
  // El fallo NO se captura aquí: cualquier error deja la transacción abortada y
  // el siguiente comando fallaría con 25P02 enmascarando la causa real. Se
  // traduce arriba, ya fuera de la transacción.
  const reserva = await tx.reservation.create({
    data: {
      slotId: slot.id,
      userId: ownerUserId,
      policyId,
      overrideReason: windowOverride ? motivoOverride : null,
    },
    select: { id: true, windowOverride: true, policyId: true },
  });

  if (windowOverride) {
    // Se cierra la excepción en cuanto deja de hacer falta: si mañana esta
    // transacción insertara una segunda reserva, no debe heredarla.
    await tx.$executeRaw`SELECT set_config('wellbros.window_override', 'off', true)`;
  }

  // ── 5. El estado del slot es denormalización de conveniencia; la verdad es
  // la existencia de una reserva ACTIVE. Aun así se mantiene coherente.
  await tx.weekSlot.update({
    where: { id: slot.id },
    data: { status: "RESERVED" },
  });

  // ── 6. Bitácora, en la misma transacción: si la reserva se guarda, su
  // entrada se guarda; si algo falla, ninguna de las dos queda.
  const detalles: AuditDetails = {
    reservationId: reserva.id,
    slotId: slot.id,
    propertyId: slot.property_id,
    propertyName: slot.property_name,
    startDate: slot.start_date,
    endDate: slot.end_date,
    weekLabel: semana.label,
    ownerUserId,
    ownerName: dueno.fullName,
    ownerEmail: dueno.email,
    onBehalfOfOther: ownerUserId !== actor.id,
    policyId: reserva.policyId,
    windowOverride: reserva.windowOverride,
  };

  await writeAudit(tx, {
    action: "RESERVATION_CREATED",
    entityType: "RESERVATION",
    entityId: reserva.id,
    actorUserId: actor.id,
    details: detalles,
    ip: input.ip ?? null,
  });

  if (reserva.windowOverride) {
    await writeAudit(tx, {
      action: "RESERVATION_OUT_OF_WINDOW",
      entityType: "RESERVATION",
      entityId: reserva.id,
      actorUserId: actor.id,
      details: {
        ...detalles,
        overrideReason: motivoOverride,
        reason: veredicto.reason,
        releaseAt: veredicto.releaseAt.toISOString(),
      },
      ip: input.ip ?? null,
    });
  }

  // ── 7. Aviso a TODOS los usuarios activos (requisito confirmado, §08).
  const destinatarios = await activeUserIds(tx);
  const notificationsQueued = await enqueueNotification(tx, {
    eventType: "RESERVATION_CREATED",
    payload: {
      reservationId: reserva.id,
      ownerUserId,
      ownerName: dueno.fullName,
      week: semana,
      path: calendarPath(slot.property_id, slot.start_date),
      windowOverride: reserva.windowOverride,
    },
    recipientUserIds: destinatarios,
  });

  return {
    reservationId: reserva.id,
    slotId: slot.id,
    propertyId: slot.property_id,
    propertyName: slot.property_name,
    startDate: slot.start_date,
    endDate: slot.end_date,
    ownerUserId,
    ownerName: dueno.fullName,
    windowOverride: reserva.windowOverride,
    notificationsQueued,
  };
}

/* ------------------------------------------------------------------ */
/* Traducción de errores                                               */
/* ------------------------------------------------------------------ */

function errorDeVentana(
  reason: "BEFORE_WINDOW" | "IN_PROGRESS" | "PAST" | "OK",
  releaseAt: Date,
  timeZone: string,
): ReservationError {
  switch (reason) {
    case "BEFORE_WINDOW":
      return new ReservationError("WEEK_NOT_YET_BOOKABLE", {
        message: `Esa semana se habilita el ${releaseLabel(releaseAt, timeZone)}.`,
        releaseAt,
      });
    case "IN_PROGRESS":
      // No hay código propio para «ya empezó»: con la política confirmada
      // (allowInProgressWeek = true) este caso no existe, y cuando se apague, el
      // mensaje correcto es el mismo que el de una semana fuera de alcance.
      return new ReservationError("WEEK_PAST", {
        message: "Esa semana ya empezó y no puede reservarse.",
      });
    default:
      return new ReservationError("WEEK_PAST", {
        message: "Esa semana ya terminó.",
      });
  }
}

/**
 * Convierte lo que devuelve la base en un error de negocio cuando corresponde.
 *
 * P2002 es el caso importante: la violación del índice único parcial significa
 * que otro se quedó con la semana entre el bloqueo y la inserción. Los códigos
 * WB0xx son los del trigger de ventana, que solo pueden aparecer si el reloj de
 * la aplicación y el de la base discrepan; se traducen igual para que el usuario
 * vea un mensaje y no una traza de PostgreSQL.
 */
function traducirErrorDeBase(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return new ReservationError("SLOT_TAKEN", { cause: error });
  }

  const mensaje = error instanceof Error ? error.message : "";
  if (mensaje.includes("WB012")) {
    return new ReservationError("OVERRIDE_REASON_REQUIRED", { cause: error });
  }
  if (mensaje.includes("WB010")) {
    return new ReservationError("WEEK_NOT_YET_BOOKABLE", {
      message: "Esa semana todavía no se habilita.",
      cause: error,
    });
  }
  if (mensaje.includes("WB011")) {
    return new ReservationError("SLOT_NOT_FOUND", { cause: error });
  }

  return error;
}
