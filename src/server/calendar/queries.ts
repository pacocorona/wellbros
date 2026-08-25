/**
 * Capa de consulta del calendario: de la base a `WeekView[]`, listo para
 * `buildMonthGrid`.
 *
 * Aquí se decide el ESTADO de cada semana. Es el único sitio donde se cruzan
 * las tres fuentes que lo determinan —el slot, su reserva activa y la ventana
 * de apertura de @/lib/booking-window— y por eso ni la página ni los
 * componentes vuelven a razonar sobre ello: reciben el estado ya resuelto.
 *
 * El módulo es PURO de framework: recibe el cliente de Prisma, el actor y el
 * reloj; no llama a cookies() ni a requireUser(). Una futura app nativa puede
 * exponerlo por /api/v1 sin tocar una línea.
 */

import type { Prisma, UserRole } from "@/generated/prisma/client";
import {
  isWeekBookable,
  businessToday,
  maxVisibleMonth,
} from "@/lib/booking-window";
import {
  gridWeekRange,
  type Availability,
  type GrantView,
  type MaintenanceView,
  type WeekView,
} from "@/lib/calendar-grid";
import type { Db } from "@/lib/db";

import { loadBookingPolicy, type EffectiveBookingPolicy } from "./policy";

/**
 * Cliente capaz de leer el calendario: sirve el global y el de una
 * transacción. Se piden justo los delegados que se usan, como en @/lib/audit.
 */
export type CalendarDb =
  | Pick<Db, "weekSlot" | "maintenanceNote" | "bookingPolicy">
  | Pick<
      Prisma.TransactionClient,
      "weekSlot" | "maintenanceNote" | "bookingPolicy"
    >;

/**
 * Quién mira. Solo se usa su `id`, para distinguir MIA de RESERVADA.
 *
 * `role` se acepta (así un `SessionUser` entra tal cual) pero NO cambia lo que
 * se ve: la exención de ventana de la superusuaria afecta a lo que PUEDE
 * hacer, no a lo que la semana ES. Una semana de octubre en agosto está
 * PROGRAMADA para todo el mundo; que ella pueda tomarla igualmente lo decide
 * quien pinta el botón (`isWeekActionable` de <MonthGrid />) y lo revalida
 * src/server/reservations dentro de la transacción.
 */
export interface CalendarViewer {
  id: string;
  role?: UserRole;
}

export interface GetMonthCalendarInput {
  db: CalendarDb;
  propertyId: string;
  /** Mes a pintar, `yyyy-MM`. */
  month: string;
  viewer: CalendarViewer;
  /**
   * Reloj. Se inyecta para poder probar con reloj fijo; si se omite se usa el
   * del proceso. Una página debe resolverlo UNA vez y pasar el mismo valor a
   * todo el render, o dos consultas podrían caer a distintos lados de una
   * apertura de mes.
   */
  now?: Date;
}

export interface MonthCalendar {
  /** El mes pedido, tal cual, para que quien lo reciba no tenga que llevarlo aparte. */
  month: string;
  /**
   * Semanas con slot en la retícula, de la más antigua a la más nueva. Las que
   * no tienen slot NO se rellenan aquí: `buildMonthGrid` las sintetiza como
   * SIN_APERTURA (o PASADA si ya terminaron), que es su trabajo.
   */
  weeks: WeekView[];
  maintenance: MaintenanceView[];
  policy: EffectiveBookingPolicy;
  canNavigatePrev: boolean;
  canNavigateNext: boolean;
  /** Hoy en la zona de negocio, `yyyy-MM-dd`. `buildMonthGrid` lo necesita. */
  todayISO: string;
}

/* -------------------------------------------------------------------------- */
/* Fechas: el punto donde es fácil correr el calendario un día                 */
/* -------------------------------------------------------------------------- */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * `@db.Date` de Prisma → `yyyy-MM-dd`.
 *
 * ATENCIÓN, aquí se corre el calendario un día si se descuida: una columna
 * `date` vuelve como un `Date` a MEDIANOCHE UTC (`2026-09-11T00:00:00.000Z`),
 * no como una fecha local. Leerla con `getDate()`/`getMonth()` la interpreta en
 * la zona del servidor y en cualquier huso al oeste de Greenwich devuelve el
 * DÍA ANTERIOR (comprobado en esta máquina, America/Mexico_City: `getDate()`
 * dice 23 donde la base dice 24). `toISOString().slice(0,10)` acierta con estos
 * valores, pero es una trampa: en cuanto alguien construya la fecha en local
 * empieza a mentir. Por eso se leen siempre los componentes UTC.
 */
function toISODateUTC(value: Date): string {
  return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
}

/**
 * `yyyy-MM-dd` → `Date` a medianoche UTC, que es lo que Prisma espera para
 * comparar contra una columna `@db.Date` (una cadena la rechaza de plano).
 * Es la operación inversa exacta de `toISODateUTC`.
 */
function fromISODateUTC(dateISO: string): Date {
  const m = ISO_DATE_RE.exec(dateISO);
  if (!m) {
    throw new RangeError(`Fecha inválida: ${dateISO} (se esperaba yyyy-MM-dd)`);
  }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * Iniciales para el chip del día cedido: primera letra del nombre y primera
 * del último apellido, en mayúsculas. Con un solo término da una sola letra;
 * en el chip cabe igual y es mejor que inventar una segunda.
 */
export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  // toLocaleUpperCase con locale explícito: en turco `i` mayúscula no es `I`,
  // y el nombre de un invitado no tiene por qué venir en español.
  return `${first}${last}`.toLocaleUpperCase("es-MX");
}

/* -------------------------------------------------------------------------- */
/* Consulta                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Todo lo que hace falta para decidir el estado de una semana, en una sola
 * consulta. Sin el `include` anidado harían falta tres viajes por mes.
 */
const SLOT_SELECT = {
  id: true,
  startDate: true,
  endDate: true,
  status: true,
  reservations: {
    // La reserva CANCELLED sigue en la tabla (nada se borra): sin este filtro
    // una semana liberada seguiría pintándose ocupada.
    where: { status: "ACTIVE" },
    // Un índice único PARCIAL garantiza que no hay dos activas; el `take`
    // solo lo hace explícito para quien lea la consulta.
    take: 1,
    select: {
      id: true,
      userId: true,
      // Solo el nombre visible: el calendario lo ve toda la familia y ahí no
      // pintan ni el correo ni el teléfono de nadie.
      user: { select: { fullName: true } },
      dayGrants: {
        where: { status: "ACTIVE" },
        orderBy: { grantDate: "asc" },
        select: {
          grantDate: true,
          grantee: { select: { fullName: true } },
        },
      },
    },
  },
} as const;

/**
 * Calendario de un mes para una propiedad.
 *
 * Nota sobre el RANGO consultado: se pide por `start_date` entre el primer y el
 * último viernes que TOCAN la retícula (`gridWeekRange`), no por `anchor_month`.
 * La retícula siempre asoma dos semanas más de las que el mes ancla —la cola de
 * la primera fila y la cabeza de la última—; filtrando por `anchor_month` esas
 * dos no vendrían y `buildMonthGrid` las sintetizaría como SIN_APERTURA, o sea
 * que una semana realmente reservada saldría vacía en el borde de cada mes.
 */
export async function getMonthCalendar({
  db,
  propertyId,
  month,
  viewer,
  now = new Date(),
}: GetMonthCalendarInput): Promise<MonthCalendar> {
  const policy = await loadBookingPolicy(db, propertyId);
  const { gridStart, gridEnd, firstWeekStart, lastWeekStart } =
    gridWeekRange(month);
  const todayISO = businessToday(now, policy);

  const [slots, notes, oldest] = await Promise.all([
    db.weekSlot.findMany({
      where: {
        propertyId,
        startDate: {
          gte: fromISODateUTC(firstWeekStart),
          lte: fromISODateUTC(lastWeekStart),
        },
      },
      orderBy: { startDate: "asc" },
      select: SLOT_SELECT,
    }),
    db.maintenanceNote.findMany({
      // Solapamiento de intervalos: empieza antes de que acabe la retícula y
      // acaba después de que empiece. Una nota de varios días entra aunque
      // ninguno de sus extremos caiga dentro del mes.
      where: {
        propertyId,
        startDate: { lte: fromISODateUTC(gridEnd) },
        endDate: { gte: fromISODateUTC(gridStart) },
      },
      orderBy: { startDate: "asc" },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        note: true,
        // Solo el nombre visible, igual que en la reserva: el globo lo ve toda
        // la familia y ahí no pinta el correo ni el teléfono de nadie.
        createdBy: { select: { fullName: true } },
      },
    }),
    // Para la flecha «◀»: la semana más antigua que existe en la propiedad.
    // Se prefiere preguntárselo a los datos y no fijar un tope arbitrario de
    // meses hacia atrás, porque el historial de la casa es justo lo que se
    // quiere poder recorrer. Es una sola fila y la tabla crece 52 al año.
    db.weekSlot.findFirst({
      where: { propertyId },
      orderBy: { startDate: "asc" },
      select: { startDate: true },
    }),
  ]);

  const weeks = slots.map((slot) =>
    toWeekView(slot, viewer, policy, now, todayISO),
  );

  const maintenance: MaintenanceView[] = notes.map((n) => ({
    id: n.id,
    // `startDate` y `endDate` son columnas `@db.Date`: se formatean con
    // componentes UTC (ver `toISODateUTC`) o el globo anuncia el día anterior.
    startDate: toISODateUTC(n.startDate),
    endDate: toISODateUTC(n.endDate),
    note: n.note,
    authorName: n.createdBy.fullName,
  }));

  return {
    month,
    weeks,
    maintenance,
    policy,
    // Se DESHABILITAN, no se ocultan: una flecha que desaparece deja al usuario
    // buscando dónde estaba en vez de entender que llegó al límite (§04).
    canNavigatePrev: oldest
      ? toISODateUTC(oldest.startDate).slice(0, 7) < month
      : false,
    // maxVisibleMonth devuelve `yyyy-MM-01`; el mes navegable es su prefijo.
    canNavigateNext: month < maxVisibleMonth(now, policy).slice(0, 7),
    todayISO,
  };
}

/* -------------------------------------------------------------------------- */
/* Estado de una semana                                                        */
/* -------------------------------------------------------------------------- */

/** Fila de `week_slots` con su reserva activa, tal como la trae SLOT_SELECT. */
type SlotRow = {
  id: string;
  startDate: Date;
  endDate: Date;
  status: "OPEN" | "RESERVED" | "CLOSED";
  reservations: {
    id: string;
    userId: string;
    user: { fullName: string };
    dayGrants: { grantDate: Date; grantee: { fullName: string } }[];
  }[];
};

function toWeekView(
  slot: SlotRow,
  viewer: CalendarViewer,
  policy: EffectiveBookingPolicy,
  now: Date,
  todayISO: string,
): WeekView {
  const startDate = toISODateUTC(slot.startDate);
  // `end_date` es columna GENERADA (start_date + 6): no se recalcula aquí para
  // que la base siga siendo la única dueña de "cuánto dura una semana".
  const endDate = toISODateUTC(slot.endDate);

  const bookability = isWeekBookable(startDate, now, policy);
  const reservation = slot.reservations[0];

  /*
   * PRIORIDAD DE ESTADOS (el orden importa y no es arbitrario):
   *
   *   1. PASADA        — el jueves 23:59 ya quedó atrás. Manda sobre todo lo
   *                      demás: una semana reservada Y pasada es PASADA, porque
   *                      lo que el calendario debe comunicar es que ahí ya no
   *                      hay nada que hacer, no de quién fue.
   *   2. RESERVADA/MIA — existe reserva ACTIVE. La verdad es la reserva, no
   *                      `slot.status`, que es denormalización de conveniencia.
   *   3. CERRADA       — la superusuaria cerró el slot. Va DESPUÉS de la
   *                      reserva: cerrar un slot con reserva activa es un caso
   *                      excepcional (existe SLOT_CLOSED_WITH_ACTIVE_RESERVATION
   *                      en la bitácora) y ahí importa que se vea el titular.
   *   4. PROGRAMADA    — abre más adelante (BEFORE_WINDOW).
   *   5. EN_CURSO      — ya empezó y todavía se puede tomar.
   *   6. RESERVABLE    — el resto.
   *
   * El mismo orden que la vista `v_week_slot_availability` de la migración,
   * con una diferencia deliberada: allí EN_CURSO solo aparece cuando la
   * política PROHÍBE tomar la semana empezada, y aquí marca simplemente que la
   * semana ya arrancó. Es lo que la interfaz necesita —la etiqueta dice
   * «En curso · quedan 3 días», que es justo el malentendido que hay que
   * evitar— y si además es tomable o no lo resuelve `isWeekActionable`.
   */
  let availability: Availability;
  if (bookability.reason === "PAST") {
    availability = "PASADA";
  } else if (reservation) {
    availability = reservation.userId === viewer.id ? "MIA" : "RESERVADA";
  } else if (slot.status === "CLOSED") {
    availability = "CERRADA";
  } else if (bookability.reason === "BEFORE_WINDOW") {
    availability = "PROGRAMADA";
  } else if (startDate <= todayISO) {
    // Cubre también reason === "IN_PROGRESS" (política que no permite tomar la
    // semana empezada): la condición de instante de isWeekBookable y esta
    // comparación de fechas civiles son la misma frontera, el viernes 00:00 de
    // la zona de negocio.
    availability = "EN_CURSO";
  } else {
    availability = "RESERVABLE";
  }

  const grants: GrantView[] =
    reservation?.dayGrants.map((g) => ({
      date: toISODateUTC(g.grantDate),
      granteeName: g.grantee.fullName,
      granteeInitials: initialsOf(g.grantee.fullName),
    })) ?? [];

  return {
    startDate,
    endDate,
    availability,
    // Solo donde significa algo: en RESERVABLE la fecha de apertura ya pasó y
    // en PASADA no interesa. Es un INSTANTE (ISO con zona), no una fecha civil:
    // `segmentLabel` lo traduce a la zona de negocio para decir «Abre el 16 sep».
    releaseAt:
      availability === "PROGRAMADA"
        ? bookability.releaseAt.toISOString()
        : undefined,
    // Nunca en MIA: ahí la interfaz dice «Tu reserva», no el propio nombre.
    reservedByName:
      availability === "RESERVADA" ? reservation?.user.fullName : undefined,
    grants: grants.length > 0 ? grants : undefined,
    slotId: slot.id,
    // Se entrega también en semanas ajenas: la superusuaria puede cancelarlas y
    // el panel necesita el identificador. No es un dato sensible (un UUID) y
    // quien decide si la acción procede es src/server/reservations, no la vista.
    reservationId: reservation?.id,
  };
}
