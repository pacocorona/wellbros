/**
 * Contrato compartido de la vista de calendario: tipos de props y la tabla que
 * traduce cada estado a color, icono y texto.
 *
 * Por qué la tabla vive aquí y no en cada componente: la leyenda y los tramos
 * TIENEN que decir lo mismo. Si el chip de un tramo y su muestra en la leyenda
 * salieran de dos listas distintas, tarde o temprano dejarían de coincidir.
 *
 * Sobre los colores: cada valor se pide como una variable CSS con un respaldo
 * literal — `var(--wb-open-bg,#DCF5E3)`. Así el componente funciona hoy sin
 * tocar globals.css, y el día que el integrador declare esas variables (ver el
 * resumen de entrega) toman el control sin cambiar una sola clase. La variante
 * `dark:` repite la misma variable con el respaldo oscuro, de modo que el tema
 * oscuro también funciona antes de que existan las variables.
 *
 * Regla firme (§04): el color NUNCA es el único portador de significado. Cada
 * estado lleva además icono y, en el tramo largo, etiqueta de texto.
 */

import type { KeyboardEvent } from "react";
import {
  Ban,
  Check,
  Clock,
  Hourglass,
  Lock,
  Minus,
  Star,
  User,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type {
  Availability,
  CalRow,
  Segment,
  WeekView,
} from "@/lib/calendar-grid";

// `MaintenanceView` se reexporta como los demás porque desde que `DayCell.maintenance`
// es un ARREGLO de notas —cada una con su id, su rango y su autor— los componentes
// del calendario manejan la nota suelta, no un texto ya unido.
export type {
  Availability,
  CalRow,
  DayCell,
  MaintenanceView,
  Segment,
  WeekView,
} from "@/lib/calendar-grid";

/** Apariencia de un estado: fondo y borde del tramo, chip, muestra e icono. */
export interface AvailabilitySkin {
  /** Fondo y borde del tramo. */
  container: string;
  /** Color del número de día y de la marca de continuación. */
  text: string;
  /** Chip de la etiqueta (solo en el tramo de 5 celdas). */
  chip: string;
  /** Muestra de color de la leyenda. */
  swatch: string;
  icon: LucideIcon;
  /** Rayado diagonal encima del fondo (CERRADA). */
  striped?: boolean;
}

const BORDER = "border-[1.5px]";

export const AVAILABILITY_SKIN: Record<Availability, AvailabilitySkin> = {
  // Verde con borde discontinuo: "hueco por llenar", igual que en la maqueta.
  RESERVABLE: {
    container: `bg-[var(--wb-open-bg,#DCF5E3)] dark:bg-[var(--wb-open-bg,#0B3320)] ${BORDER} border-dashed border-[var(--wb-open-bd,#2F9E5B)] dark:border-[var(--wb-open-bd,#34C56F)]`,
    text: "text-[var(--wb-open-fg,#1B6B3C)] dark:text-[var(--wb-open-fg,#8FE7B4)]",
    chip: "bg-[var(--wb-open-chip,#166534)] dark:bg-[var(--wb-open-bd,#34C56F)] text-white dark:text-[#04220F]",
    swatch:
      "bg-[var(--wb-open-bg,#DCF5E3)] dark:bg-[var(--wb-open-bg,#0B3320)] border border-dashed border-[var(--wb-open-bd,#2F9E5B)] dark:border-[var(--wb-open-bd,#34C56F)]",
    icon: Check,
  },
  // Misma familia que RESERVABLE (sigue siendo tomable) pero borde sólido y
  // reloj: la semana ya arrancó y no se reciben siete días.
  EN_CURSO: {
    container: `bg-[var(--wb-open-bg,#DCF5E3)] dark:bg-[var(--wb-open-bg,#0B3320)] ${BORDER} border-[var(--wb-open-bd,#2F9E5B)] dark:border-[var(--wb-open-bd,#34C56F)]`,
    text: "text-[var(--wb-open-fg,#1B6B3C)] dark:text-[var(--wb-open-fg,#8FE7B4)]",
    chip: "bg-[var(--wb-open-chip,#166534)] dark:bg-[var(--wb-open-bd,#34C56F)] text-white dark:text-[#04220F]",
    swatch:
      "bg-[var(--wb-open-bg,#DCF5E3)] dark:bg-[var(--wb-open-bg,#0B3320)] border border-[var(--wb-open-bd,#2F9E5B)] dark:border-[var(--wb-open-bd,#34C56F)]",
    icon: Clock,
  },
  // Gris pizarra + candado: existe, está abierta, pero todavía no es tomable.
  PROGRAMADA: {
    container: `bg-[var(--wb-sched-bg,#E9EDF3)] dark:bg-[var(--wb-sched-bg,#172230)] ${BORDER} border-[var(--wb-sched-bd,#90A0B4)] dark:border-[var(--wb-sched-bd,#46586D)]`,
    text: "text-[var(--wb-sched-fg,#4E5F76)] dark:text-[var(--wb-sched-fg,#93A6BC)]",
    chip: "bg-[var(--wb-sched-chip,#52627A)] dark:bg-[var(--wb-sched-bd,#46586D)] text-white",
    swatch:
      "bg-[var(--wb-sched-bg,#E9EDF3)] dark:bg-[var(--wb-sched-bg,#172230)] border border-[var(--wb-sched-bd,#90A0B4)] dark:border-[var(--wb-sched-bd,#46586D)]",
    icon: Lock,
  },
  RESERVADA: {
    container: `bg-[var(--wb-other-bg,#ECE7F9)] dark:bg-[var(--wb-other-bg,#291B4E)] ${BORDER} border-[var(--wb-other-bd,#7C5CD6)] dark:border-[var(--wb-other-bd,#9B7BF0)]`,
    text: "text-[var(--wb-other-fg,#55349E)] dark:text-[var(--wb-other-fg,#CBB8F8)]",
    chip: "bg-[var(--wb-other-bd,#7C5CD6)] dark:bg-[var(--wb-other-bd,#9B7BF0)] text-white dark:text-[#1B0F3A]",
    swatch:
      "bg-[var(--wb-other-bg,#ECE7F9)] dark:bg-[var(--wb-other-bg,#291B4E)] border border-[var(--wb-other-bd,#7C5CD6)] dark:border-[var(--wb-other-bd,#9B7BF0)]",
    icon: User,
  },
  MIA: {
    container: `bg-[var(--wb-mine-bg,#DBEAFE)] dark:bg-[var(--wb-mine-bg,#102C5C)] ${BORDER} border-[var(--wb-mine-bd,#2563EB)] dark:border-[var(--wb-mine-bd,#4C8DF6)]`,
    text: "text-[var(--wb-mine-fg,#1E40AF)] dark:text-[var(--wb-mine-fg,#A3C6FB)]",
    chip: "bg-[var(--wb-mine-bd,#2563EB)] dark:bg-[var(--wb-mine-bd,#4C8DF6)] text-white dark:text-[#06183C]",
    swatch:
      "bg-[var(--wb-mine-bg,#DBEAFE)] dark:bg-[var(--wb-mine-bg,#102C5C)] border border-[var(--wb-mine-bd,#2563EB)] dark:border-[var(--wb-mine-bd,#4C8DF6)]",
    icon: Star,
  },
  // Ámbar rayado: la superusuaria la retiró de la oferta.
  CERRADA: {
    container: `bg-[var(--wb-closed-bg,#FCEEC8)] dark:bg-[var(--wb-closed-bg,#392A08)] ${BORDER} border-[var(--wb-closed-bd,#A16207)] dark:border-[var(--wb-closed-bd,#EFC257)]`,
    text: "text-[var(--wb-closed-fg,#7A4A05)] dark:text-[var(--wb-closed-fg,#EFC257)]",
    chip: "bg-[var(--wb-closed-bd,#A16207)] dark:bg-[var(--wb-closed-bd,#EFC257)] text-white dark:text-[#241900]",
    swatch:
      "bg-[var(--wb-closed-bg,#FCEEC8)] dark:bg-[var(--wb-closed-bg,#392A08)] border border-[var(--wb-closed-bd,#A16207)] dark:border-[var(--wb-closed-bd,#EFC257)]",
    icon: Ban,
    striped: true,
  },
  SIN_APERTURA: {
    container: `bg-[var(--wb-noslot-bg,#F0EDE4)] dark:bg-[var(--wb-noslot-bg,#131D29)] ${BORDER} border-[var(--wb-noslot-bd,#DAD5C6)] dark:border-[var(--wb-noslot-bd,#232E3B)]`,
    text: "text-[var(--wb-noslot-fg,#8C9184)] dark:text-[var(--wb-noslot-fg,#55636F)]",
    // Contorno punteado en vez de relleno: nada que ofrecer todavía.
    chip: "border border-dashed border-current bg-transparent text-[var(--wb-noslot-fg,#8C9184)] dark:text-[var(--wb-noslot-fg,#55636F)]",
    swatch:
      "bg-[var(--wb-noslot-bg,#F0EDE4)] dark:bg-[var(--wb-noslot-bg,#131D29)] border border-[var(--wb-noslot-fg,#8C9184)] dark:border-[var(--wb-noslot-fg,#55636F)]",
    icon: Minus,
  },
  PASADA: {
    container: `bg-[var(--wb-past-bg,#F3F2EF)] dark:bg-[var(--wb-past-bg,#12171D)] ${BORDER} border-[var(--wb-past-bd,#DEDCD6)] dark:border-[var(--wb-past-bd,#222A33)]`,
    text: "text-[var(--wb-past-fg,#8E8E87)] dark:text-[var(--wb-past-fg,#5C6670)]",
    chip: "border border-current bg-transparent text-[var(--wb-past-fg,#8E8E87)] dark:text-[var(--wb-past-fg,#5C6670)]",
    swatch:
      "bg-[var(--wb-past-bg,#F3F2EF)] dark:bg-[var(--wb-past-bg,#12171D)] border border-[var(--wb-past-bd,#DEDCD6)] dark:border-[var(--wb-past-bd,#222A33)]",
    icon: Hourglass,
  },
};

/** Día cedido: teal, distinto de todos los estados de semana. */
export const CEDED_SKIN = {
  cell: "bg-[var(--wb-ceded-bg,#CDF2EA)] dark:bg-[var(--wb-ceded-bg,#062F2B)] ring-[1.5px] ring-inset ring-[var(--wb-ceded-bd,#0D9488)] dark:ring-[var(--wb-ceded-bd,#23BBA7)]",
  pill: "bg-[var(--wb-ceded-chip,#0F766E)] dark:bg-[var(--wb-ceded-bd,#23BBA7)] text-white dark:text-[#022A26]",
  swatch:
    "bg-[var(--wb-ceded-bg,#CDF2EA)] dark:bg-[var(--wb-ceded-bg,#062F2B)] border border-[var(--wb-ceded-bd,#0D9488)] dark:border-[var(--wb-ceded-bd,#23BBA7)]",
  icon: User,
  text: "Día cedido",
} as const;

/**
 * Mantenimiento: punto ámbar. Informa, no bloquea.
 *
 * OJO: este ámbar es SUYO y no tiene nada que ver con el color de la propiedad
 * (`--wb-prop`), que tiñe el cromo del calendario. Si el mantenimiento tomara
 * el color de la casa, dejaría de significar lo mismo al cambiar de propiedad.
 */
export const MAINTENANCE_SKIN = {
  dot: "bg-[var(--wb-maint-fg,#A16207)] dark:bg-[var(--wb-maint-fg,#EFC257)]",
  /**
   * Ficha de un día que YA tiene nota, en el formulario del calendario. Reusa
   * los fondos de CERRADA porque son el mismo ámbar de la familia, y el borde
   * fuerte del propio mantenimiento para que no se confundan entre sí.
   */
  chip: "border-[var(--wb-maint-fg,#A16207)] bg-[var(--wb-closed-bg,#FCEEC8)] text-[var(--wb-closed-fg,#7A4A05)] dark:bg-[var(--wb-closed-bg,#392A08)] dark:text-[var(--wb-closed-fg,#EFC257)]",
  swatch:
    "bg-[var(--wb-maint-fg,#A16207)] dark:bg-[var(--wb-maint-fg,#EFC257)] rounded-full",
  icon: Wrench,
  text: "Mantenimiento",
} as const;

/** Anillo de resaltado que une visualmente los dos tramos de una semana. */
export const HIGHLIGHT_RING =
  "ring-2 ring-[var(--wb-accent,#0E7490)] dark:ring-[var(--wb-accent,#3FC1D3)]";

/**
 * Estados en los que un clic no hace nada por omisión.
 *
 * PROGRAMADA es enfocable pero no accionable (§07): la semana existe y aún no
 * se puede tomar. SIN_APERTURA tampoco tiene destino… salvo para la
 * superusuaria, que abre semanas desde el propio calendario: para eso está
 * `isWeekActionable` en las props, no un rol codificado aquí.
 */
export const NON_ACTIONABLE: readonly Availability[] = [
  "PROGRAMADA",
  "SIN_APERTURA",
  // PASADA y CERRADA son motivos de bloqueo, igual que las dos anteriores: una
  // semana terminada no se reserva, y una cerrada es un slot que la superusuaria
  // retiró de la oferta. Sin ellas aquí, un clic abría el modal de confirmación
  // sobre una semana imposible. La superusuaria conserva sus acciones aparte
  // (isWeekActionable), que no dependen de esta lista.
  "PASADA",
  "CERRADA",
];

/**
 * Estados en los que la semana todavía se puede tomar (o explicar por qué no).
 * Son los que abren el diálogo de reserva; PROGRAMADA entra porque el diálogo
 * es también donde se cuenta cuándo abre y donde la superusuaria puede
 * saltarse la ventana con motivo.
 */
export const ESTADOS_RESERVABLES: readonly Availability[] = [
  "RESERVABLE",
  "EN_CURSO",
  "PROGRAMADA",
];

/** Estados en los que la semana YA tiene dueño: abren la hoja de la reserva. */
export const ESTADOS_CON_DUENIO: readonly Availability[] = ["MIA", "RESERVADA"];

export interface WeekSegmentProps {
  segment: Segment;
  /** El cursor o el foco están en cualquiera de los dos tramos de la semana. */
  highlighted: boolean;
  /** Celda que hoy tiene tabIndex=0 dentro de la retícula (foco itinerante). */
  focusedDate: string | null;
  actionable: boolean;
  onHoverWeek: (weekKey: string | null) => void;
  onSelect: (week: WeekView) => void;
  onCellKeyDown: (event: KeyboardEvent<HTMLDivElement>, date: string) => void;
  /** Registro de nodos para poder mover el foco con las flechas. */
  registerCell: (date: string, element: HTMLDivElement | null) => void;
}

export interface MonthGridProps {
  /** Mes en pantalla, `yyyy-MM`. Solo se usa para el nombre accesible. */
  month: string;
  /** Filas ya construidas con `buildMonthGrid`. */
  rows: CalRow[];
  onSelectWeek: (week: WeekView) => void;
  /** Sobrescribe qué semanas responden al clic (p. ej. la superusuaria). */
  isWeekActionable?: (week: WeekView) => boolean;
  /** Oculta la leyenda cuando la página ya la muestra en otro sitio. */
  showLegend?: boolean;
  className?: string;
}

export interface LegendProps {
  /** Estados presentes en el mes; se calculan con `availabilitiesInGrid`. */
  availabilities: Availability[];
  hasGrants?: boolean;
  hasMaintenance?: boolean;
  className?: string;
}
