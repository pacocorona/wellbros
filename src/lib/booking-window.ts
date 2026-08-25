/**
 * Ventana de apertura de reservas.
 *
 * Regla (docs/diseno-wellbros.html §07): aunque el superusuario haya abierto un
 * slot, las semanas del mes siguiente solo se vuelven reservables 15 días exactos
 * antes del día 1 de ese mes. Las del mes corriente siempre lo son.
 *
 * "El mes corriente siempre está disponible" NO se programa aparte: es una
 * consecuencia de la regla. La apertura de cualquier mes cae siempre dentro del
 * mes anterior, así que al llegar su día 1 ya lleva medio mes abierta. Por eso
 * aquí hay un solo predicado, no dos.
 *
 * Todo se calcula en la ZONA DE NEGOCIO y sobre fechas civiles: las semanas son
 * días de calendario, no instantes. Las comparaciones con `now`, en cambio, son
 * entre instantes absolutos.
 *
 * Este módulo es PURO: `now` se inyecta para poder probar con reloj fijo, y no
 * consulta la base ni conoce permisos. Quien decide es el servidor
 * (src/server/reservations), que además revalida dentro de la transacción.
 */

import { TZDate } from "@date-fns/tz";
import {
  addDays,
  addMonths,
  getDaysInMonth,
  isBefore,
  startOfMonth,
} from "date-fns";

export type ReleaseMode = "OFFSET_DAYS" | "FIXED_DAY";

export type SuperuserOverrideMode = "ALWAYS_EXEMPT" | "AUDITED" | "NEVER";

/** Por qué una semana no es reservable (o `OK` si lo es). */
export type BlockReason = "OK" | "BEFORE_WINDOW" | "IN_PROGRESS" | "PAST";

export interface BookingWindowConfig {
  /** Zona de negocio. Define el corte "viernes 00:00" y qué día es hoy. */
  timeZone: string;
  /** OFFSET_DAYS = N días exactos antes del día 1. FIXED_DAY = día fijo del mes. */
  mode: ReleaseMode;
  /** Días de anticipación en modo OFFSET_DAYS. */
  bookingWindowDays: number;
  /** Día del mes en modo FIXED_DAY (se recorta si el mes es más corto). */
  releaseDayOfMonth: number;
  releaseHour: number;
  releaseMinute: number;
  /**
   * A qué mes pertenece una semana que cruza el cambio de mes.
   *   0 = el mes de su viernes de inicio  (decisión confirmada del cliente)
   *   3 = el mes donde caen más días      (cierra la rendija del puente)
   *   6 = exige que la semana entera esté habilitada
   */
  anchorOffsetDays: number;
  /** Permitir tomar una semana ya empezada, hasta el jueves 23:59. */
  allowInProgressWeek: boolean;
  /** Cuántos meses hacia adelante se puede navegar el calendario. */
  visibleHorizonMonths: number;
  /** Si el superusuario puede reservar fuera de ventana. */
  superuserOverride: SuperuserOverrideMode;
}

/** Refleja las decisiones confirmadas con el cliente. */
export const DEFAULT_BOOKING_WINDOW: BookingWindowConfig = {
  timeZone: "America/Mexico_City",
  mode: "OFFSET_DAYS",
  bookingWindowDays: 15,
  releaseDayOfMonth: 15,
  releaseHour: 0,
  releaseMinute: 0,
  anchorOffsetDays: 0,
  allowInProgressWeek: true,
  visibleHorizonMonths: 6,
  superuserOverride: "ALWAYS_EXEMPT",
};

export interface Bookability {
  bookable: boolean;
  reason: BlockReason;
  /** Instante exacto en que la semana se habilita (o se habilitó). */
  releaseAt: Date;
  /** Mes ancla en formato `yyyy-MM`, útil para agrupar en la interfaz. */
  anchorMonth: string;
}

/** `yyyy-MM-dd` → medianoche civil de ese día en la zona de negocio. */
function civilMidnight(dateISO: string, timeZone: string): TZDate {
  const [y, m, d] = dateISO.split("-").map(Number);
  if (!y || !m || !d) {
    throw new RangeError(`Fecha inválida: ${dateISO} (se esperaba yyyy-MM-dd)`);
  }
  return new TZDate(y, m - 1, d, 0, 0, 0, 0, timeZone);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Formatea un TZDate como `yyyy-MM-dd` en su propia zona. */
export function toISODate(d: TZDate): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Mes al que pertenece la semana para efectos de la ventana.
 * Con anchorOffsetDays = 0 es simplemente el mes del viernes de inicio.
 */
export function weekAnchorMonth(
  startDateISO: string,
  cfg: BookingWindowConfig = DEFAULT_BOOKING_WINDOW,
): TZDate {
  const start = civilMidnight(startDateISO, cfg.timeZone);
  return startOfMonth(addDays(start, cfg.anchorOffsetDays)) as TZDate;
}

/**
 * Instante en que se habilita un mes, dado su primer día.
 *
 * En modo OFFSET_DAYS el día de apertura se mueve cada mes: es siempre
 * "longitud del mes anterior menos 14" (17, 16, 15 o 14). Es correcto: lo
 * constante es la anticipación, no la fecha.
 */
export function monthReleaseAt(
  monthStart: TZDate,
  cfg: BookingWindowConfig = DEFAULT_BOOKING_WINDOW,
): TZDate {
  let base: TZDate;

  if (cfg.mode === "OFFSET_DAYS") {
    base = addDays(monthStart, -cfg.bookingWindowDays) as TZDate;
  } else {
    const prev = addMonths(monthStart, -1) as TZDate;
    // Recorte: con releaseDayOfMonth = 31, febrero abre el 28 (o 29), no falla.
    const day = Math.min(cfg.releaseDayOfMonth, getDaysInMonth(prev));
    base = addDays(prev, day - 1) as TZDate;
  }

  // La hora se fija reconstruyendo la fecha civil: `set` de date-fns sobre un
  // TZDate es correcto, pero reconstruir deja explícito que trabajamos con la
  // hora de pared de la zona de negocio.
  return new TZDate(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    cfg.releaseHour,
    cfg.releaseMinute,
    0,
    0,
    cfg.timeZone,
  );
}

/** Instante de apertura de una semana concreta. */
export function weekReleaseAt(
  startDateISO: string,
  cfg: BookingWindowConfig = DEFAULT_BOOKING_WINDOW,
): TZDate {
  return monthReleaseAt(weekAnchorMonth(startDateISO, cfg), cfg);
}

/**
 * Única fuente de verdad de la regla.
 *
 * No evalúa el estado del slot ni los permisos: eso es responsabilidad del
 * servicio que la invoca.
 */
export function isWeekBookable(
  startDateISO: string,
  now: Date,
  cfg: BookingWindowConfig = DEFAULT_BOOKING_WINDOW,
): Bookability {
  const start = civilMidnight(startDateISO, cfg.timeZone);
  // El viernes siguiente a las 00:00 = fin del jueves 23:59:59.
  const endExclusive = addDays(start, 7) as TZDate;
  const anchor = weekAnchorMonth(startDateISO, cfg);
  const releaseAt = monthReleaseAt(anchor, cfg);
  const anchorMonth = `${anchor.getFullYear()}-${pad2(anchor.getMonth() + 1)}`;

  const out = (bookable: boolean, reason: BlockReason): Bookability => ({
    bookable,
    reason,
    releaseAt: new Date(releaseAt.getTime()),
    anchorMonth,
  });

  if (!isBefore(now, endExclusive)) return out(false, "PAST");
  if (!cfg.allowInProgressWeek && !isBefore(now, start)) {
    return out(false, "IN_PROGRESS");
  }
  if (isBefore(now, releaseAt)) return out(false, "BEFORE_WINDOW");
  return out(true, "OK");
}

/**
 * Reduce toda la regla a un solo escalar para poder filtrar en SQL con índice:
 * el mayor mes ancla actualmente abierto, como `yyyy-MM-01`.
 *
 * La consulta del calendario queda entonces en `anchor_month <= $1`.
 */
export function maxOpenAnchorMonth(
  now: Date,
  cfg: BookingWindowConfig = DEFAULT_BOOKING_WINDOW,
): string {
  const tzNow = new TZDate(now.getTime(), cfg.timeZone);
  let open = startOfMonth(tzNow) as TZDate;

  // Avanza mientras el mes siguiente YA se haya abierto. Con los 15 días
  // confirmados esto itera una vez como mucho, pero con una ventana más larga
  // (más de ~28 días) puede haber más de un mes abierto por delante. Mirar solo
  // un mes dejaría fuera del filtro SQL semanas que isWeekBookable sí acepta:
  // la reserva sería válida pero el calendario no la mostraría.
  // El tope de 240 es un seguro contra una configuración absurda, no un límite real.
  for (let i = 0; i < 240; i++) {
    const next = addMonths(open, 1) as TZDate;
    if (isBefore(now, monthReleaseAt(next, cfg))) break;
    open = next;
  }

  return `${open.getFullYear()}-${pad2(open.getMonth() + 1)}-01`;
}

/**
 * Último mes navegable en el calendario, como `yyyy-MM-01`.
 * Más allá, la flecha de "mes siguiente" se deshabilita (no se oculta).
 */
export function maxVisibleMonth(
  now: Date,
  cfg: BookingWindowConfig = DEFAULT_BOOKING_WINDOW,
): string {
  const tzNow = new TZDate(now.getTime(), cfg.timeZone);
  const limit = addMonths(
    startOfMonth(tzNow) as TZDate,
    cfg.visibleHorizonMonths,
  ) as TZDate;
  return `${limit.getFullYear()}-${pad2(limit.getMonth() + 1)}-01`;
}

/** Hoy, como fecha civil `yyyy-MM-dd` en la zona de negocio. */
export function businessToday(
  now: Date,
  cfg: BookingWindowConfig = DEFAULT_BOOKING_WINDOW,
): string {
  return toISODate(new TZDate(now.getTime(), cfg.timeZone));
}
