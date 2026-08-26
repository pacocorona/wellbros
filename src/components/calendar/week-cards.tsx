"use client";

/**
 * La vista de MÓVIL del calendario: una tarjeta vertical por semana.
 *
 * En un teléfono la retícula de siete columnas obliga a arrastrar de lado justo
 * en el aparato donde más se consulta el calendario. Aquí desaparece la
 * partición en dos tramos —que existe solo porque una semana viernes→jueves
 * cabalga entre dos filas domingo→sábado— y la semana vuelve a ser UNA PIEZA
 * (§04, «Móvil y temas»).
 *
 * Tres cosas que conviene no deshacer:
 *
 * 1. UNA TARJETA POR SEMANA, NO POR FILA. Los dos tramos de una misma semana
 *    comparten `weekKey`, así que se agrupan por esa clave. Sin la agrupación,
 *    septiembre saldría con diez tarjetas para cinco semanas.
 *
 * 2. ESTO ES UNA LISTA, NO UNA RETÍCULA. No se copian los `role="grid"` y
 *    `role="gridcell"` de la vista de escritorio: aquí no hay dos ejes que
 *    recorrer, y anunciar una retícula que no existe le miente a quien la oye.
 *    Cada tarjeta es un `<li>` con un botón encima; el recorrido es el del
 *    tabulador, sin foco itinerante ni flechas.
 *
 * 3. LOS COLORES SALEN DE `AVAILABILITY_SKIN`, igual que los tramos y la
 *    leyenda. Si esta vista tuviera su propia paleta, un día el verde de aquí y
 *    el de allá dejarían de ser el mismo verde.
 *
 * La conmutación entre las dos vistas es CSS puro (`hidden md:block` /
 * `md:hidden`, ver month-grid.tsx) y no JavaScript que mire el ancho: así el
 * servidor puede pintar las dos, no hay parpadeo al hidratar y nadie tiene que
 * adivinar el tamaño de la ventana antes del primer render.
 */

import { User } from "lucide-react";

import {
  addDaysISO,
  dayOfWeekISO,
  monthOfISO,
  monthTitle,
  segmentLabel,
  weekRangeText,
  AVAILABILITY_TEXT,
  WEEKDAY_HEADINGS,
} from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";

import { MaintenanceMarker } from "./maintenance-marker";
import {
  AVAILABILITY_SKIN,
  CEDED_SKIN,
  NON_ACTIONABLE,
  type CalRow,
  type DayCell,
  type SemanaEnTarjeta,
  type WeekCardsProps,
  type WeekView,
} from "./types";

/** Días de una semana reservable: viernes → jueves. */
const DIAS_POR_SEMANA = 7;

/* -------------------------------------------------------------------------- */
/* Textos                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Tablas propias y no importadas a propósito: ni `MESES_CORTOS` de
 * reserve-dialog ni `MONTH_ABBR` de calendar-grid están exportadas, y ninguno
 * de esos dos archivos es mío en esta entrega. Si el integrador quiere una sola
 * casa para los nombres de mes, exportar una de las dos y borrar esta es un
 * cambio de tres líneas.
 *
 * Lo que NO se hace es resolverlo con `Intl.DateTimeFormat`: su salida cambia
 * con la versión de ICU («sep» contra «sept.»), y servidor y navegador pintarían
 * textos distintos justo en el HTML que React compara al hidratar.
 */
const DIA_CORTO = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;

const MES_CORTO = [
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

/** «Vie 18». El día del mes se lee del propio ISO: sin husos, sin sorpresas. */
function diaEnPalabras(fechaISO: string): string {
  return `${DIA_CORTO[dayOfWeekISO(fechaISO)]} ${Number(fechaISO.slice(8, 10))}`;
}

function mesEnPalabras(fechaISO: string): string {
  return MES_CORTO[Number(fechaISO.slice(5, 7)) - 1]!;
}

/**
 * El rango de la semana en palabras: «Vie 18 – Jue 24 sep».
 *
 * El mes se dice UNA vez cuando los dos extremos caen en el mismo; cuando la
 * semana cruza de mes se dicen los dos («Vie 28 ago – Jue 3 sep»), que es
 * exactamente el caso en el que quien mira necesita el dato.
 */
export function rangoSemanaCorto(inicioISO: string, finISO: string): string {
  const inicio = diaEnPalabras(inicioISO);
  const fin = `${diaEnPalabras(finISO)} ${mesEnPalabras(finISO)}`;
  return monthOfISO(inicioISO) === monthOfISO(finISO)
    ? `${inicio} – ${fin}`
    : `${inicio} ${mesEnPalabras(inicioISO)} – ${fin}`;
}

/**
 * Texto del chip de estado.
 *
 * Es la etiqueta contextual del tramo largo —la misma frase que la retícula:
 * «Abre el 16 sep», «En curso · quedan 3 días»— con UNA excepción: en RESERVADA
 * el tramo pone ahí el nombre del titular porque no le cabe en otro sitio. La
 * tarjeta sí tiene sitio y lo dice completo abajo («La tiene Ivonne B.»), así
 * que el chip se queda con el texto genérico de la tabla en vez de repetir el
 * nombre dos veces en cinco centímetros.
 */
function etiquetaChip(semana: SemanaEnTarjeta): string {
  return semana.availability === "RESERVADA"
    ? AVAILABILITY_TEXT.RESERVADA
    : semana.label;
}

/**
 * Nombre accesible de la tarjeta: «Semana del 18 al 24 de septiembre,
 * disponible, 2 días cedidos».
 *
 * El texto visible está abreviado («Vie 18 – Jue 24 sep») porque tiene que caber
 * en un teléfono; hablado, esas abreviaturas suenan a ruido. De ahí que el botón
 * lleve su propio nombre, construido con `weekRangeText`, el mismo que ya usan
 * las celdas de la retícula.
 */
function nombreAccesible(semana: SemanaEnTarjeta): string {
  const estado =
    semana.availability === "RESERVADA" && semana.week.reservedByName
      ? `reservada por ${semana.week.reservedByName}`
      : // El « · » de «En curso · quedan 3 días» se lee como una pausa rara.
        semana.label.replace(" · ", ", ").toLowerCase();

  const partes = [`Semana ${weekRangeText(semana.week)}`, estado];

  const cedidos = semana.days.filter((dia) => dia.ceded).length;
  if (cedidos > 0) {
    partes.push(cedidos === 1 ? "1 día cedido" : `${cedidos} días cedidos`);
  }
  return partes.join(", ");
}

/** «Viernes 18 de septiembre» hablado, para el texto oculto de una cesión. */
function diaHablado(fechaISO: string): string {
  return `${DIA_CORTO[dayOfWeekISO(fechaISO)]} ${Number(fechaISO.slice(8, 10))} de ${mesEnPalabras(fechaISO)}`;
}

/* -------------------------------------------------------------------------- */
/* De filas a semanas                                                          */
/* -------------------------------------------------------------------------- */

export interface OpcionesDeSemanas {
  /** Mes en pantalla, `yyyy-MM`; marca los días del mes vecino. */
  month?: string;
  /** Hoy en la zona de negocio, `yyyy-MM-dd`. */
  hoyISO?: string;
  zonaHoraria?: string;
}

/**
 * Las semanas de la retícula, UNA vez cada una y en orden.
 *
 * Además de deduplicar hace algo que la retícula no necesita: COMPLETAR la
 * semana. En los bordes del mes siempre hay una semana partida por la propia
 * retícula —la última fila enseña el viernes y el sábado de una semana cuyo
 * domingo→jueves ya cae fuera—, y una tarjeta que enseñara dos días de siete
 * sería justo lo contrario de «la semana vuelve a ser una sola pieza». Los días
 * que faltan se sintetizan a partir de la propia semana; sus cesiones vienen de
 * `week.grants`, que sí las trae todas.
 *
 * Lo que NO se inventa es el mantenimiento: las notas viajan pegadas a las
 * celdas que la retícula pintó, así que un día fuera de la retícula sale sin
 * punto. Preferible a fabricar una nota que nadie escribió.
 */
export function semanasDeLaRejilla(
  rows: CalRow[],
  { month, hoyISO, zonaHoraria }: OpcionesDeSemanas = {},
): SemanaEnTarjeta[] {
  interface Acumulado {
    week: WeekView;
    /** Solo el tramo de 5 celdas trae etiqueta; el de 2 no. */
    label?: string;
    days: Map<string, DayCell>;
  }

  const porSemana = new Map<string, Acumulado>();

  for (const fila of rows) {
    for (const segmento of fila.segments) {
      let acumulado = porSemana.get(segmento.weekKey);
      if (!acumulado) {
        acumulado = { week: segmento.week, days: new Map() };
        porSemana.set(segmento.weekKey, acumulado);
      }
      if (segmento.label !== undefined) acumulado.label = segmento.label;
      for (const dia of segmento.days) acumulado.days.set(dia.date, dia);
    }
  }

  // Sobre `yyyy-MM-dd` el orden alfabético ES el cronológico. Las filas ya
  // llegan en orden, pero ordenar aquí hace que la lista no dependa de ello.
  return [...porSemana.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekKey, { week, label, days }]) => {
      const completos: DayCell[] = [];
      for (let i = 0; i < DIAS_POR_SEMANA; i++) {
        const fecha = addDaysISO(week.startDate, i);
        const existente = days.get(fecha);
        if (existente) {
          completos.push(existente);
          continue;
        }
        const cesion = week.grants?.find((g) => g.date === fecha);
        completos.push({
          date: fecha,
          dayOfMonth: Number(fecha.slice(8, 10)),
          isAdjacentMonth: month ? monthOfISO(fecha) !== month : false,
          isToday: hoyISO === fecha,
          ceded: cesion
            ? {
                granteeInitials: cesion.granteeInitials,
                granteeName: cesion.granteeName,
              }
            : undefined,
        });
      }

      return {
        weekKey,
        week,
        availability: week.availability,
        days: completos,
        label: label ?? segmentLabel(week, hoyISO, zonaHoraria),
      };
    });
}

/* -------------------------------------------------------------------------- */
/* La tira de siete días                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Los siete días de la semana dentro de la tarjeta.
 *
 * `pointer-events-none` en toda la tira: el toque tiene que llegar al botón que
 * hay debajo, que es el que abre la semana. Las únicas islas que vuelven a
 * recibir el dedo son los puntos de mantenimiento (`pointer-events-auto` y
 * `z-10`), porque leer una nota no es lo mismo que reservar la semana.
 */
function TiraDeDias({ semana }: { semana: SemanaEnTarjeta }) {
  return (
    <div className="pointer-events-none grid grid-cols-7 gap-0.5 px-2 pb-2">
      {semana.days.map((dia) => (
        <div
          key={dia.date}
          data-date={dia.date}
          className={cn(
            "relative flex min-h-12 flex-col items-center gap-0.5 rounded-md py-1",
            dia.ceded && CEDED_SKIN.cell,
          )}
        >
          {/* El día ya viaja en el nombre del botón de la tarjeta; repetir aquí
              siete números y siete abreviaturas solo alargaría la escucha. */}
          <span
            aria-hidden="true"
            className="font-mono text-[0.55rem] leading-none tracking-[0.06em] opacity-60"
          >
            {WEEKDAY_HEADINGS[dayOfWeekISO(dia.date)]}
          </span>

          <span
            aria-hidden="true"
            className={cn(
              "text-[0.8rem] leading-tight tabular-nums",
              dia.isAdjacentMonth && "opacity-45",
              dia.isToday &&
                "rounded-full bg-current px-1.5 font-semibold text-[var(--wb-today-ink,#FFFFFF)] dark:text-[var(--wb-today-ink,#0B1116)]",
            )}
          >
            {dia.dayOfMonth}
          </span>

          {dia.ceded ? (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "rounded-full px-1 font-mono text-[0.55rem] leading-tight",
                  CEDED_SKIN.pill,
                )}
              >
                {dia.ceded.granteeInitials}
              </span>
              <span className="sr-only">
                {diaHablado(dia.date)}: cedido a {dia.ceded.granteeName}.
              </span>
            </>
          ) : null}

          {dia.maintenance ? (
            <MaintenanceMarker
              notas={dia.maintenance}
              // Aquí el punto NO va pegado a la esquina como en la retícula:
              // una columna de tarjeta mide unos 40 px y el punto se comería la
              // abreviatura del día. Baja al flujo, debajo del número, y de
              // paso todas las columnas crecen igual porque la fila las estira.
              //
              // `pointer-events-auto` le devuelve el toque que la tira apagó y
              // `z-10` lo levanta por encima de la capa que abre la semana: leer
              // una nota no es reservar. El relleno se queda: es el área de toque.
              className="pointer-events-auto relative top-auto right-auto z-10 p-1.5"
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* La tarjeta                                                                  */
/* -------------------------------------------------------------------------- */

interface TarjetaSemanaProps {
  semana: SemanaEnTarjeta;
  accionable: boolean;
  onSelect: (week: WeekView) => void;
}

function TarjetaSemana({ semana, accionable, onSelect }: TarjetaSemanaProps) {
  const skin = AVAILABILITY_SKIN[semana.availability];
  const Icon = skin.icon;
  const titular =
    semana.availability === "RESERVADA" ? semana.week.reservedByName : undefined;

  const cabecera = (
    <>
      <Icon aria-hidden="true" className="size-4 shrink-0 opacity-70" />
      {/* El rango no se abrevia nunca: es lo que identifica la tarjeta. Si algo
          tiene que ceder es el chip, que primero baja de línea y solo entonces
          se corta. */}
      <span className="shrink-0 text-[0.95rem] font-medium">
        {rangoSemanaCorto(semana.week.startDate, semana.week.endDate)}
      </span>
      <span
        className={cn(
          "ml-auto max-w-full min-w-0 truncate rounded-full px-2 py-0.5",
          "font-mono text-[0.62rem] tracking-wider",
          skin.chip,
        )}
      >
        {etiquetaChip(semana)}
      </span>
    </>
  );

  // `min-h-11` son los 44 px de objetivo táctil, y el `after:absolute inset-0`
  // estira ese objetivo a la TARJETA ENTERA sin anidar un botón dentro de otro
  // —imposible con los puntos de mantenimiento, que ya son botones—. El
  // pseudoelemento se ancla al `<li>` porque el propio botón no está posicionado.
  const claseCabecera =
    "flex w-full min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-left";

  return (
    <li
      data-week={semana.weekKey}
      data-availability={semana.availability}
      className={cn("relative rounded-xl", skin.container, skin.text)}
    >
      {/* Rayado de CERRADA en su propia capa, como en el tramo. */}
      {skin.striped ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,var(--wb-closed-stripe,rgba(161,98,7,0.20))_5px,var(--wb-closed-stripe,rgba(161,98,7,0.20))_10px)]"
        />
      ) : null}

      {accionable ? (
        <button
          type="button"
          aria-label={nombreAccesible(semana)}
          onClick={() => onSelect(semana.week)}
          className={cn(
            claseCabecera,
            "cursor-pointer rounded-[inherit]",
            "after:absolute after:inset-0 after:content-['']",
            "outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-[var(--wb-accent,#0E7490)] dark:focus-visible:outline-[var(--wb-accent,#3FC1D3)]",
          )}
        >
          {cabecera}
        </button>
      ) : (
        // Sin acción no hay botón: un botón que no hace nada es una promesa
        // rota, y con el tabulador además estorba. El texto sigue leyéndose.
        <div className={claseCabecera}>{cabecera}</div>
      )}

      <div aria-hidden="true" className="mx-3 h-px bg-current opacity-15" />

      <TiraDeDias semana={semana} />

      {titular ? (
        <p className="flex items-center gap-1.5 px-3 pb-2.5 text-[0.78rem]">
          <User aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
          {/* El nombre y el «La tiene» van en el MISMO hijo: sueltos serían dos
              cajas del flex y el `gap` los separaría como si fueran dos datos. */}
          <span>
            La tiene <span className="font-medium">{titular}</span>
          </span>
        </p>
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* La lista                                                                    */
/* -------------------------------------------------------------------------- */

export function WeekCards({
  month,
  rows,
  onSelectWeek,
  isWeekActionable,
  hoyISO,
  zonaHoraria,
  className,
}: WeekCardsProps) {
  // Sin `useMemo`: la lista se recalcula solo cuando el padre vuelve a pintar
  // —cambio de mes, de propiedad o una acción— y recorrer seis filas es más
  // barato que guardar y comparar.
  const semanas = semanasDeLaRejilla(rows, { month, hoyISO, zonaHoraria });

  const accionable = (week: WeekView): boolean =>
    isWeekActionable
      ? isWeekActionable(week)
      : !NON_ACTIONABLE.includes(week.availability);

  return (
    <ul
      aria-label={`Semanas de ${monthTitle(month)}`}
      className={cn("flex flex-col gap-2", className)}
    >
      {semanas.map((semana) => (
        <TarjetaSemana
          key={semana.weekKey}
          semana={semana}
          accionable={accionable(semana.week)}
          onSelect={onSelectWeek}
        />
      ))}
    </ul>
  );
}
