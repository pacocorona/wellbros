"use client";

/**
 * La retícula del mes: cabecera domingo→sábado, filas de tramos y leyenda.
 *
 * No trae combo de propiedad ni navegación de mes: recibe las filas ya
 * construidas con `buildMonthGrid` y avisa hacia arriba con `onSelectWeek`.
 *
 * Dos decisiones que conviene no deshacer:
 *
 * 1. El resaltado de la semana vive AQUÍ, no en cada tramo. Los dos tramos de
 *    una semana están en filas distintas y no son hermanos en el DOM; con el
 *    estado elevado se iluminan juntos sin que nadie tenga que ir a buscar al
 *    otro con querySelector.
 *
 * 2. La retícula es un `grid` ARIA de verdad: fila → celda, con foco itinerante
 *    y flechas, como cualquier calendario. Los tramos quedan como
 *    `presentation` en medio, porque su partición es una decisión de dibujo.
 *
 * 3. Todo esto vive dentro de una TARJETA —fondo, borde, esquinas y sombra—,
 *    como la maqueta del documento de diseño (clase `.cal`). Sin ella el
 *    calendario se derrama contra el fondo de la página y en móvil parece no
 *    tener lados. El desplazamiento horizontal va DENTRO de la tarjeta, nunca
 *    envolviéndola: si envolviera, las esquinas redondeadas se perderían en
 *    cuanto la retícula desbordara.
 *
 * 4. DENTRO DE ESA MISMA TARJETA VIVEN LAS DOS VISTAS: la retícula de siete
 *    columnas de 768 px para arriba y las tarjetas de semana (`WeekCards`) por
 *    debajo. La conmutación es CSS —`hidden md:block` / `md:hidden`— y no
 *    JavaScript que mida la ventana: el servidor pinta las dos, el navegador
 *    enseña la que toca y no hay ni parpadeo ni desajuste al hidratar.
 *
 *    Que las dos cuelguen de aquí no es capricho de organización: el riel de
 *    color, el marco y la LEYENDA se pintan UNA sola vez, fuera de la
 *    conmutación. Si cada vista trajera la suya, tarde o temprano una diría
 *    algo que la otra no.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import {
  availabilitiesInGrid,
  gridHighlights,
  monthTitle,
  WEEKDAY_HEADINGS,
  FRIDAY_COLUMN,
} from "@/lib/calendar-grid";
import {
  DEFAULT_PROPERTY_COLOR,
  propertyColorStyle,
  type PropertyColor,
} from "@/lib/property-color";
import { cn } from "@/lib/utils";

import { Legend } from "./legend";
import { NON_ACTIONABLE, type MonthGridProps, type WeekView } from "./types";
import { WeekCards } from "./week-cards";
import { WeekSegment } from "./week-segment";

const COLUMNS = 7;

/**
 * Lo que este componente añade al contrato compartido de `./types`.
 *
 * Se extiende AQUÍ y no en `MonthGridProps` porque el color es asunto del
 * dibujo de la tarjeta, no del contrato de datos de la retícula: quien
 * consuma `MonthGridProps` para otra cosa no tiene por qué enterarse.
 */
export interface MonthGridColorProps extends MonthGridProps {
  /**
   * Color de identidad de la propiedad en pantalla. Tiñe el riel superior y
   * el borde de la tarjeta —el cromo—, jamás los estados de la semana.
   * Si no llega, índigo: el mismo valor por omisión de `properties.color`.
   */
  color?: PropertyColor;
}

export function MonthGrid({
  month,
  rows,
  onSelectWeek,
  isWeekActionable,
  showLegend = true,
  hoyISO,
  zonaHoraria,
  color = DEFAULT_PROPERTY_COLOR,
  className,
}: MonthGridColorProps) {
  const [hoveredWeekKey, setHoveredWeekKey] = useState<string | null>(null);
  const [focusedDate, setFocusedDate] = useState<string | null>(null);

  const cells = useRef(new Map<string, HTMLDivElement>());
  // Mover el foco obliga a tocar el DOM: es la única forma de que las flechas
  // funcionen. Se hace tras el render para no pelear con React por el foco.
  const pendingFocus = useRef<string | null>(null);

  const dates = useMemo(
    () => rows.flatMap((row) => row.segments.flatMap((s) => s.days.map((d) => d.date))),
    [rows],
  );

  // Celda que recibe el tab: la de hoy si está en el mes, si no la primera.
  const defaultDate = useMemo(() => {
    for (const row of rows) {
      for (const segment of row.segments) {
        for (const cell of segment.days) {
          if (cell.isToday) return cell.date;
        }
      }
    }
    for (const row of rows) {
      for (const segment of row.segments) {
        for (const cell of segment.days) {
          if (!cell.isAdjacentMonth) return cell.date;
        }
      }
    }
    return dates[0] ?? null;
  }, [rows, dates]);

  // Si cambia el mes, la celda enfocada anterior ya no existe.
  const rovingDate =
    focusedDate && dates.includes(focusedDate) ? focusedDate : defaultDate;

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    cells.current.get(target)?.focus();
  }, [focusedDate]);

  const moveFocus = (from: string, delta: number) => {
    const index = dates.indexOf(from);
    if (index < 0) return;
    const next = dates[index + delta];
    if (!next) return; // los bordes de la retícula no dan la vuelta
    pendingFocus.current = next;
    setFocusedDate(next);
  };

  const handleCellKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    date: string,
  ) => {
    const index = dates.indexOf(date);
    if (index < 0) return;
    const columna = index % COLUMNS;

    switch (event.key) {
      case "ArrowRight":
        moveFocus(date, 1);
        break;
      case "ArrowLeft":
        moveFocus(date, -1);
        break;
      case "ArrowDown":
        moveFocus(date, COLUMNS);
        break;
      case "ArrowUp":
        moveFocus(date, -COLUMNS);
        break;
      case "Home":
        moveFocus(date, -columna);
        break;
      case "End":
        moveFocus(date, COLUMNS - 1 - columna);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const registerCell = (date: string, element: HTMLDivElement | null) => {
    if (element) cells.current.set(date, element);
    else cells.current.delete(date);
  };

  const actionable = (week: WeekView): boolean =>
    isWeekActionable
      ? isWeekActionable(week)
      : !NON_ACTIONABLE.includes(week.availability);

  const { hasGrants, hasMaintenance } = useMemo(
    () => gridHighlights(rows),
    [rows],
  );
  const availabilities = useMemo(() => availabilitiesInGrid(rows), [rows]);

  return (
    // `overflow-hidden` en la tarjeta es lo que recorta el riel por las
    // esquinas: sin él, la banda de color asomaría cuadrada sobre el borde
    // redondeado. Las variables van en línea y la hoja de estilos elige la
    // variante clara u oscura (ver la CAPA WELLBROS de globals.css).
    <div
      data-wb-prop=""
      style={propertyColorStyle(color)}
      className={cn(
        "w-full overflow-hidden rounded-xl border border-[var(--wb-prop-border)] bg-card text-card-foreground shadow-sm transition-colors",
        className,
      )}
    >
      {/* Riel de identidad: 4px pegados al borde de arriba. Es la señal
          principal de "estás mirando ESTA propiedad" y la primera que cambia
          al mover el combo. Decorativo puro: el nombre y el color ya viajan
          en el texto accesible del combo. */}
      <div
        aria-hidden
        className="h-1 w-full bg-[var(--wb-prop)] transition-colors"
      />

      <div className="p-3 sm:p-4">
        {/* LA RETÍCULA — de 768 px para arriba. Debajo de ese ancho la partición
            en dos tramos obliga a arrastrar de lado, así que cede el sitio a las
            tarjetas. `hidden` es display:none, o sea que tampoco la anuncian los
            lectores de pantalla: nunca hay dos calendarios a la vez en el árbol
            de accesibilidad. */}
        <div className="hidden md:block">
          <div className="overflow-x-auto">
            <div className="min-w-[40rem]">
              <div
                role="grid"
                aria-label={`Calendario de ${monthTitle(month)}`}
                aria-rowcount={rows.length + 1}
                aria-colcount={COLUMNS}
              >
                <div role="row" className="mb-1.5 grid grid-cols-7">
                  {WEEKDAY_HEADINGS.map((dia, i) => (
                    <div
                      key={dia}
                      role="columnheader"
                      className={cn(
                        "py-1 text-center font-mono text-[0.66rem] tracking-[0.08em]",
                        i === FRIDAY_COLUMN
                          ? // El viernes abre la semana reservable: se marca.
                            "font-semibold text-[var(--wb-accent,#0E7490)] dark:text-[var(--wb-accent,#3FC1D3)]"
                          : "text-muted-foreground",
                      )}
                    >
                      {dia}
                    </div>
                  ))}
                </div>

                {rows.map((row, i) => (
                  <div
                    key={row.segments[0]?.days[0]?.date ?? i}
                    role="row"
                    className="mb-[0.45rem] grid grid-cols-7"
                  >
                    {row.segments.map((segment) => (
                      <WeekSegment
                        // El tramo largo y el corto de una misma semana comparten
                        // weekKey, así que la clave lleva también el span.
                        key={`${segment.weekKey}-${segment.span}`}
                        segment={segment}
                        highlighted={hoveredWeekKey === segment.weekKey}
                        focusedDate={rovingDate}
                        actionable={actionable(segment.week)}
                        onHoverWeek={setHoveredWeekKey}
                        onSelect={onSelectWeek}
                        onCellKeyDown={handleCellKeyDown}
                        registerCell={registerCell}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* LAS TARJETAS — por debajo de 768 px. Mismas filas, misma tabla de
            colores y el mismo `onSelectWeek`: lo que cambia es la forma, no la
            conversación con el padre. */}
        <WeekCards
          month={month}
          rows={rows}
          onSelectWeek={onSelectWeek}
          isWeekActionable={isWeekActionable}
          hoyISO={hoyISO}
          zonaHoraria={zonaHoraria}
          className="md:hidden"
        />

        {/* La leyenda va DENTRO de la tarjeta pero FUERA de la conmutación y del
            desplazamiento horizontal: explica las DOS vistas y debe poder
            reflowar en móvil en lugar de irse a buscar a la derecha. */}
        {showLegend ? (
          <Legend
            availabilities={availabilities}
            hasGrants={hasGrants}
            hasMaintenance={hasMaintenance}
            className="mt-3"
          />
        ) : null}
      </div>
    </div>
  );
}
