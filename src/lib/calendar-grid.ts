/**
 * Retícula del calendario: de un mes + una lista de semanas a filas de segmentos.
 *
 * El mes se dibuja como un calendario NORMAL, de domingo a sábado, porque es lo
 * que cualquiera sabe leer. La unidad de negocio, en cambio, va de viernes a
 * jueves. Sobre una fila domingo→sábado eso cae siempre igual:
 *
 *     DOM LUN MAR MIÉ JUE | VIE SÁB
 *     └─── cola de la ───┘ └ cabeza ┘
 *       semana anterior     de la siguiente
 *
 * De ahí que TODA fila tenga exactamente dos segmentos: uno de 5 celdas
 * (domingo→jueves, cierre de la semana que arrancó el viernes de la fila de
 * arriba) y uno de 2 (viernes→sábado, arranque de la semana que termina en la
 * fila de abajo). No hay más casos: no es una heurística, es aritmética.
 *
 * Este módulo es PURO: sin React, sin acceso a datos, sin reloj. `todayISO` se
 * inyecta. Toda la aritmética de fechas se hace sobre fechas CIVILES ancladas a
 * UTC: si usáramos la zona del entorno, el servidor y el navegador podrían
 * discrepar en qué día es "hoy" y la hidratación de React reventaría. La zona de
 * negocio solo aparece para traducir `releaseAt`, que sí es un instante.
 */

import { TZDate } from "@date-fns/tz";

/** Zona de negocio (§07). Solo se usa para instantes, no para la retícula. */
const DEFAULT_TIME_ZONE = "America/Mexico_City";

/** Tramo domingo→jueves: es el que tiene espacio para la etiqueta. */
const TAIL_SPAN = 5;
/** Tramo viernes→sábado. */
const HEAD_SPAN = 2;

/** Día de la semana en que arranca la unidad reservable (0 = domingo). */
const FRIDAY = 5;

export type Availability =
  | "RESERVABLE"
  | "EN_CURSO"
  | "PROGRAMADA"
  | "RESERVADA"
  | "MIA"
  | "CERRADA"
  | "SIN_APERTURA"
  | "PASADA";

/** Un día cedido dentro de una semana reservada. */
export interface GrantView {
  /** `yyyy-MM-dd`, siempre dentro de la semana. */
  date: string;
  granteeInitials: string;
  granteeName: string;
}

/**
 * Una semana reservable tal como la resolvió el servidor.
 * `availability` ya viene decidida: aquí no se aplica la ventana de apertura.
 */
export interface WeekView {
  /** Viernes de inicio, `yyyy-MM-dd`. Es también la identidad de la semana. */
  startDate: string;
  /** Jueves de cierre, `yyyy-MM-dd`. */
  endDate: string;
  availability: Availability;
  /** Instante ISO en que la semana se habilita; solo en PROGRAMADA. */
  releaseAt?: string;
  /** Nombre visible del titular; solo en RESERVADA. */
  reservedByName?: string;
  grants?: GrantView[];
  slotId?: string;
  reservationId?: string;
}

/**
 * Nota de mantenimiento. No bloquea reservas: solo se señala en el día.
 *
 * Lleva `id` porque el globo del calendario tiene que distinguir una nota de
 * otra —listarlas por separado, y mañana poder editarlas desde ahí— y
 * `authorName` porque en una casa compartida «obra en el baño» significa cosas
 * distintas según quién lo anotó.
 */
export interface MaintenanceView {
  id: string;
  startDate: string;
  endDate: string;
  note: string;
  /** Nombre visible de quien la escribió. Ausente si no se resolvió. */
  authorName?: string;
}

export interface DayCell {
  /** `yyyy-MM-dd`. */
  date: string;
  dayOfMonth: number;
  /** Pertenece al mes anterior o al siguiente: se pinta atenuado. */
  isAdjacentMonth: boolean;
  isToday: boolean;
  ceded?: { granteeInitials: string; granteeName: string };
  /**
   * Notas que cubren el día, en el orden en que llegaron. Es un ARREGLO y no un
   * texto unido: dos notas del mismo día son dos hechos distintos, cada uno con
   * su rango y su autor, y concatenarlos con « · » perdía esa identidad justo
   * cuando el globo necesita mostrarlas por separado. Ausente si no hay ninguna
   * (nunca un arreglo vacío: `if (cell.maintenance)` debe significar «hay»).
   */
  maintenance?: MaintenanceView[];
}

export interface Segment {
  /** Viernes de inicio de la semana: los dos tramos comparten este valor. */
  weekKey: string;
  /** 5 (domingo→jueves) o 2 (viernes→sábado). */
  span: number;
  days: DayCell[];
  availability: Availability;
  /** La semana empieza en una fila anterior: esquinas rectas a la izquierda. */
  openLeft: boolean;
  /** La semana sigue en la fila siguiente: esquinas rectas y marca «›». */
  openRight: boolean;
  /** Solo en el tramo de 5 celdas; en el de 2 no cabe. */
  label?: string;
  week: WeekView;
}

export interface CalRow {
  segments: Segment[];
}

export interface BuildMonthGridInput {
  /** Mes a dibujar, `yyyy-MM`. */
  month: string;
  weeks: WeekView[];
  maintenance?: MaintenanceView[];
  /** Hoy en la zona de negocio, `yyyy-MM-dd`. Sin él ningún día se marca. */
  todayISO?: string;
  timeZone?: string;
}

/* -------------------------------------------------------------------------- */
/* Aritmética civil                                                            */
/* -------------------------------------------------------------------------- */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH_RE = /^(\d{4})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `yyyy-MM-dd` → Date anclado a UTC. Rechaza fechas inexistentes (31 de feb). */
function civil(dateISO: string): Date {
  const m = ISO_DATE_RE.exec(dateISO);
  if (!m) {
    throw new RangeError(`Fecha inválida: ${dateISO} (se esperaba yyyy-MM-dd)`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new RangeError(`Fecha inexistente: ${dateISO}`);
  }
  return d;
}

function toISO(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Suma días a una fecha civil. */
export function addDaysISO(dateISO: string, days: number): string {
  return toISO(new Date(civil(dateISO).getTime() + days * MS_PER_DAY));
}

/** Días entre dos fechas civiles (b - a). */
export function diffDaysISO(a: string, b: string): number {
  return Math.round((civil(b).getTime() - civil(a).getTime()) / MS_PER_DAY);
}

/** Día de la semana, 0 = domingo. */
export function dayOfWeekISO(dateISO: string): number {
  return civil(dateISO).getUTCDay();
}

/** Mes de una fecha civil, `yyyy-MM`. */
export function monthOfISO(dateISO: string): string {
  return dateISO.slice(0, 7);
}

/** El viernes que abre la semana a la que pertenece una fecha cualquiera. */
export function weekStartOf(dateISO: string): string {
  return addDaysISO(dateISO, -((dayOfWeekISO(dateISO) - FRIDAY + 7) % 7));
}

/** Tramo continuo de días, tal como se guarda una nota de mantenimiento. */
export interface RangoDeDias {
  startDate: string;
  endDate: string;
}

/**
 * Días sueltos → tramos CONTINUOS.
 *
 * Es la pieza que convierte una selección de fichas («sábado y martes») en
 * notas guardables. Y el motivo de que devuelva VARIOS tramos en vez de uno
 * solo del primero al último es de verdad, no de estilo: el modelo guarda
 * rangos, así que una única nota del sábado al martes pintaría también domingo
 * y lunes en el calendario de todo el mundo, anunciando una obra que esos días
 * no existe.
 *
 * Ordena y deduplica antes de agrupar: quien elige fichas no lo hace en orden y
 * el mismo día puede llegar dos veces. Sobre `yyyy-MM-dd` el orden alfabético y
 * el cronológico son el mismo, por eso basta con `sort()`.
 *
 * Valida todas las fechas primero, de modo que una malformada falle siempre
 * igual (RangeError) y no según dónde quedara al ordenar.
 */
export function agruparDiasEnRangos(fechas: string[]): RangoDeDias[] {
  for (const fecha of fechas) civil(fecha);

  const unicas = [...new Set(fechas)].sort();

  const tramos: RangoDeDias[] = [];
  for (const fecha of unicas) {
    const ultimo = tramos.at(-1);
    if (ultimo && diffDaysISO(ultimo.endDate, fecha) === 1) {
      ultimo.endDate = fecha;
    } else {
      tramos.push({ startDate: fecha, endDate: fecha });
    }
  }
  return tramos;
}

/* -------------------------------------------------------------------------- */
/* Textos                                                                      */
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

/** Cabecera de la retícula, de domingo a sábado. El viernes se destaca aparte. */
export const WEEKDAY_HEADINGS = [
  "DOM",
  "LUN",
  "MAR",
  "MIÉ",
  "JUE",
  "VIE",
  "SÁB",
] as const;

/** Índice de la columna del viernes en la cabecera: ahí arranca la semana. */
export const FRIDAY_COLUMN = FRIDAY;

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

const MONTH_ABBR = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

/** Texto de la etiqueta genérica de cada estado (leyenda y respaldo del chip). */
export const AVAILABILITY_TEXT: Record<Availability, string> = {
  RESERVABLE: "Disponible",
  EN_CURSO: "En curso",
  PROGRAMADA: "Programada",
  RESERVADA: "Reservada",
  MIA: "Tu reserva",
  CERRADA: "Cerrada",
  SIN_APERTURA: "Sin apertura",
  PASADA: "Pasada",
};

/** Misma información en minúsculas, para encajar dentro de una frase hablada. */
const AVAILABILITY_SPOKEN: Record<Availability, string> = {
  RESERVABLE: "disponible",
  EN_CURSO: "en curso",
  PROGRAMADA: "programada, aún no reservable",
  RESERVADA: "reservada",
  MIA: "tu reserva",
  CERRADA: "cerrada",
  SIN_APERTURA: "sin apertura",
  PASADA: "pasada",
};

/** `yyyy-MM` → "septiembre de 2026". */
export function monthTitle(month: string): string {
  const m = ISO_MONTH_RE.exec(month);
  if (!m) throw new RangeError(`Mes inválido: ${month} (se esperaba yyyy-MM)`);
  return `${MONTH_NAMES[Number(m[2]) - 1]} de ${m[1]}`;
}

/**
 * `releaseAt` es un INSTANTE, así que para decir "abre el 16 sep" hay que
 * llevarlo a la zona de negocio. Si llega ya como fecha civil se respeta tal
 * cual: convertirla sería restarle horas y correrla un día.
 */
function releaseDayLabel(releaseAt: string, timeZone: string): string | null {
  if (ISO_DATE_RE.test(releaseAt)) {
    const d = civil(releaseAt);
    return `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]}`;
  }
  const ms = new Date(releaseAt).getTime();
  if (Number.isNaN(ms)) return null;
  const z = new TZDate(ms, timeZone);
  return `${z.getDate()} ${MONTH_ABBR[z.getMonth()]}`;
}

/**
 * Etiqueta contextual del tramo largo. No es solo el estado: en PROGRAMADA dice
 * cuándo abre y en EN_CURSO cuántos días quedan, que es justo lo que evita el
 * malentendido de creer que se reciben siete.
 */
export function segmentLabel(
  week: WeekView,
  todayISO?: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  switch (week.availability) {
    case "RESERVADA":
      return week.reservedByName ?? AVAILABILITY_TEXT.RESERVADA;
    case "PROGRAMADA": {
      const day = week.releaseAt
        ? releaseDayLabel(week.releaseAt, timeZone)
        : null;
      return day ? `Abre el ${day}` : AVAILABILITY_TEXT.PROGRAMADA;
    }
    case "EN_CURSO": {
      if (!todayISO) return AVAILABILITY_TEXT.EN_CURSO;
      const left = diffDaysISO(todayISO, week.endDate) + 1;
      if (left < 1) return AVAILABILITY_TEXT.EN_CURSO;
      return left === 1 ? "En curso · queda 1 día" : `En curso · quedan ${left} días`;
    }
    default:
      return AVAILABILITY_TEXT[week.availability];
  }
}

/** "del 11 al 17 de septiembre" / "del 30 de octubre al 5 de noviembre". */
export function weekRangeText(week: WeekView): string {
  const start = civil(week.startDate);
  const end = civil(week.endDate);
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const endMonth = MONTH_NAMES[end.getUTCMonth()];
  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `del ${startDay} al ${endDay} de ${endMonth}`;
  }
  return `del ${startDay} de ${MONTH_NAMES[start.getUTCMonth()]} al ${endDay} de ${endMonth}`;
}

/**
 * Etiqueta hablada de una celda.
 *
 * La partición en dos tramos es PURAMENTE VISUAL: quien no la ve necesita que
 * cada día diga a qué semana pertenece, o el calendario se vuelve ilegible.
 */
export function dayCellAriaLabel(cell: DayCell, segment: Segment): string {
  const d = civil(cell.date);
  const parts: string[] = [
    `${WEEKDAY_NAMES[d.getUTCDay()]} ${cell.dayOfMonth} de ${MONTH_NAMES[d.getUTCMonth()]}`,
  ];
  if (cell.isToday) parts.push("hoy");
  parts.push(`semana ${weekRangeText(segment.week)}`);

  const state = AVAILABILITY_SPOKEN[segment.availability];
  parts.push(
    segment.availability === "RESERVADA" && segment.week.reservedByName
      ? `reservada por ${segment.week.reservedByName}`
      : state,
  );

  if (cell.ceded) parts.push(`día cedido a ${cell.ceded.granteeName}`);

  // Con varias notas se dice cuántas ANTES de leerlas: sin ese número, quien
  // escucha no sabe si está oyendo una sola frase larga o tres seguidas.
  const notas = cell.maintenance ?? [];
  if (notas.length === 1) {
    parts.push(`mantenimiento: ${notas[0]!.note}`);
  } else if (notas.length > 1) {
    parts.push(
      `${notas.length} notas de mantenimiento: ${notas.map((n) => n.note).join("; ")}`,
    );
  }
  return parts.join(", ");
}

/* -------------------------------------------------------------------------- */
/* Construcción de la retícula                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Filas de un mes, listas para pintar.
 *
 * Límites de la retícula:
 *  - arranca en el domingo anterior (o igual) al día 1;
 *  - termina en el sábado posterior (o igual) al jueves de la ÚLTIMA semana
 *    anclada al mes, es decir la del último viernes. Por eso octubre de 2026
 *    necesita una sexta fila: su semana del viernes 30 cierra el 5 de noviembre
 *    y hay que verla entera; es exactamente el caso que más confunde de la regla
 *    de anclaje (la semana pesa más en noviembre pero abre con octubre).
 *
 * Un tramo suelto en el borde es NORMAL y no es un error de cálculo: el tramo de
 * 5 celdas de la primera fila cierra una semana que empezó antes de la retícula,
 * y el de 2 celdas de la última fila abre una que termina después. Se pintan con
 * su estado real y con el lado del corte abierto, igual que los demás.
 */
export interface GridWeekRange {
  /** Primer día pintado en la retícula (siempre domingo). */
  gridStart: string;
  /** Último día pintado (siempre sábado). */
  gridEnd: string;
  /** `start_date` (viernes) de la PRIMERA semana que toca la retícula. */
  firstWeekStart: string;
  /** `start_date` (viernes) de la ÚLTIMA semana que toca la retícula. */
  lastWeekStart: string;
}

/**
 * Qué semanas hay que traer de la base para pintar un mes.
 *
 * IMPORTANTE para quien consulte los datos: la retícula NO se conforma con las
 * semanas ancladas al mes. Siempre asoman dos más — el último viernes del mes
 * anterior (cola de la primera fila) y el primer viernes del siguiente (cabeza
 * de la última). Consultar solo `WHERE anchor_month = '2026-09-01'` deja esas
 * dos fuera y `buildMonthGrid` las sintetiza como SIN_APERTURA: una semana
 * realmente reservada se pintaría vacía en el borde de cada mes.
 *
 * Con esto, la consulta correcta es:
 *   WHERE property_id = $1 AND start_date BETWEEN $firstWeekStart AND $lastWeekStart
 */
export function gridWeekRange(month: string): GridWeekRange {
  const m = ISO_MONTH_RE.exec(month);
  if (!m) throw new RangeError(`Mes inválido: ${month} (se esperaba yyyy-MM)`);
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;

  const firstISO = `${month}-01`;
  // Día 0 del mes siguiente = último día de este mes.
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const lastISO = `${month}-${pad2(daysInMonth)}`;

  const gridStart = addDaysISO(firstISO, -dayOfWeekISO(firstISO));
  // El último viernes del mes siempre cierra en o después del último día,
  // así que su jueves basta para fijar el final de la retícula.
  const lastAnchoredThursday = addDaysISO(weekStartOf(lastISO), 6);
  const gridEnd = addDaysISO(
    lastAnchoredThursday,
    6 - dayOfWeekISO(lastAnchoredThursday),
  );

  return {
    gridStart,
    gridEnd,
    firstWeekStart: weekStartOf(gridStart),
    lastWeekStart: weekStartOf(gridEnd),
  };
}

export function buildMonthGrid({
  month,
  weeks,
  maintenance = [],
  todayISO,
  timeZone = DEFAULT_TIME_ZONE,
}: BuildMonthGridInput): CalRow[] {
  const { gridStart, gridEnd } = gridWeekRange(month);
  const rowCount = (diffDaysISO(gridStart, gridEnd) + 1) / 7;

  const byStart = new Map<string, WeekView>();
  for (const w of weeks) byStart.set(w.startDate, w);

  // Se memorizan las semanas sintetizadas para que los dos tramos de una misma
  // semana compartan el mismo objeto y React pueda comparar por identidad.
  const resolved = new Map<string, WeekView>();
  const grantsByWeek = new Map<string, Map<string, GrantView>>();

  const weekFor = (startDate: string): WeekView => {
    const cached = resolved.get(startDate);
    if (cached) return cached;
    const found = byStart.get(startDate);
    const week: WeekView = found ?? {
      startDate,
      endDate: addDaysISO(startDate, 6),
      // Sin slot y ya terminada no es "sin apertura": no puede abrirse nunca.
      // Decirlo así evita la falsa esperanza de que la superusuaria la abra.
      availability:
        todayISO && addDaysISO(startDate, 6) < todayISO
          ? "PASADA"
          : "SIN_APERTURA",
    };
    resolved.set(startDate, week);
    const index = new Map<string, GrantView>();
    for (const g of week.grants ?? []) index.set(g.date, g);
    grantsByWeek.set(startDate, index);
    return week;
  };

  const maintenanceFor = (date: string): MaintenanceView[] | undefined => {
    const notes = maintenance.filter(
      (n) => n.startDate <= date && date <= n.endDate,
    );
    // `undefined` y no `[]`: así `if (cell.maintenance)` sigue significando
    // «este día tiene algo que contar», sin obligar a mirar la longitud.
    return notes.length > 0 ? notes : undefined;
  };

  const buildDays = (from: string, count: number, week: WeekView): DayCell[] => {
    const grants = grantsByWeek.get(week.startDate);
    const cells: DayCell[] = [];
    for (let i = 0; i < count; i++) {
      const date = addDaysISO(from, i);
      const grant = grants?.get(date);
      cells.push({
        date,
        dayOfMonth: civil(date).getUTCDate(),
        isAdjacentMonth: monthOfISO(date) !== month,
        isToday: todayISO === date,
        ceded: grant
          ? {
              granteeInitials: grant.granteeInitials,
              granteeName: grant.granteeName,
            }
          : undefined,
        maintenance: maintenanceFor(date),
      });
    }
    return cells;
  };

  const rows: CalRow[] = [];
  for (let r = 0; r < rowCount; r++) {
    const rowStart = addDaysISO(gridStart, r * 7);

    // Cola domingo→jueves: su viernes cae dos días antes, en la fila de arriba.
    const tailWeek = weekFor(addDaysISO(rowStart, -2));
    const tail: Segment = {
      weekKey: tailWeek.startDate,
      span: TAIL_SPAN,
      days: buildDays(rowStart, TAIL_SPAN, tailWeek),
      availability: tailWeek.availability,
      openLeft: true,
      openRight: false,
      label: segmentLabel(tailWeek, todayISO, timeZone),
      week: tailWeek,
    };

    // Cabeza viernes→sábado: aquí sí empieza la semana.
    const headStart = addDaysISO(rowStart, TAIL_SPAN);
    const headWeek = weekFor(headStart);
    const head: Segment = {
      weekKey: headWeek.startDate,
      span: HEAD_SPAN,
      days: buildDays(headStart, HEAD_SPAN, headWeek),
      availability: headWeek.availability,
      openLeft: false,
      openRight: true,
      week: headWeek,
    };

    rows.push({ segments: [tail, head] });
  }

  return rows;
}

/** Estados presentes en la retícula, en orden estable, para armar la leyenda. */
export function availabilitiesInGrid(rows: CalRow[]): Availability[] {
  const order = Object.keys(AVAILABILITY_TEXT) as Availability[];
  const present = new Set<Availability>();
  for (const row of rows) {
    for (const seg of row.segments) present.add(seg.availability);
  }
  return order.filter((a) => present.has(a));
}

/** ¿Hay días cedidos o notas de mantenimiento visibles? (chips de la leyenda) */
export function gridHighlights(rows: CalRow[]): {
  hasGrants: boolean;
  hasMaintenance: boolean;
} {
  let hasGrants = false;
  let hasMaintenance = false;
  for (const row of rows) {
    for (const seg of row.segments) {
      for (const cell of seg.days) {
        if (cell.ceded) hasGrants = true;
        if (cell.maintenance && cell.maintenance.length > 0) hasMaintenance = true;
      }
    }
  }
  return { hasGrants, hasMaintenance };
}
