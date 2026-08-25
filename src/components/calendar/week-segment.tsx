"use client";

/**
 * Un TRAMO de semana: 5 celdas (domingo→jueves) o 2 (viernes→sábado).
 *
 * Los dos tramos de una semana son una sola cosa partida por el salto de fila,
 * así que el lado del corte va con esquinas rectas y una marca «›» que dice que
 * sigue abajo — la convención de Google Calendar para un evento que cruza el fin
 * de semana. El resaltado conjunto NO se hace buscando el tramo hermano en el
 * DOM: el estado vive en month-grid y aquí solo llega `highlighted`.
 *
 * Accesibilidad: el tramo es `presentation` y las celdas son los `gridcell`, de
 * modo que la retícula sigue siendo fila → celda para un lector de pantalla. La
 * partición en dos tramos es puramente visual y no debe aparecer en el árbol.
 */

import type { CSSProperties } from "react";

import { dayCellAriaLabel } from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";

import { MaintenanceMarker } from "./maintenance-marker";
import {
  AVAILABILITY_SKIN,
  CEDED_SKIN,
  HIGHLIGHT_RING,
  type WeekSegmentProps,
} from "./types";

/** El ancho del tramo viaja como variable CSS, no como clase generada. */
interface SpanStyle extends CSSProperties {
  "--n": number;
}

export function WeekSegment({
  segment,
  highlighted,
  focusedDate,
  actionable,
  onHoverWeek,
  onSelect,
  onCellKeyDown,
  registerCell,
}: WeekSegmentProps) {
  const skin = AVAILABILITY_SKIN[segment.availability];
  const Icon = skin.icon;

  const activar = () => {
    if (actionable) onSelect(segment.week);
  };

  return (
    <div
      role="presentation"
      data-week={segment.weekKey}
      data-availability={segment.availability}
      style={{ "--n": segment.span } as SpanStyle}
      onMouseEnter={() => onHoverWeek(segment.weekKey)}
      onMouseLeave={() => onHoverWeek(null)}
      className={cn(
        "relative grid rounded-[9px] transition-shadow",
        // Una sola variable en línea gobierna el ancho del tramo y sus columnas.
        "[grid-column:span_var(--n,7)]",
        "[grid-template-columns:repeat(var(--n,7),minmax(0,1fr))]",
        skin.container,
        skin.text,
        // Del lado del corte no hay ni esquina ni borde: la banda continúa.
        segment.openLeft && "rounded-l-none border-l-0",
        segment.openRight && "rounded-r-none border-r-0",
        highlighted && `z-10 ${HIGHLIGHT_RING}`,
        actionable ? "cursor-pointer" : "cursor-default",
      )}
    >
      {/* Rayado de CERRADA en su propia capa: así no compite con el fondo. */}
      {skin.striped ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,var(--wb-closed-stripe,rgba(161,98,7,0.20))_5px,var(--wb-closed-stripe,rgba(161,98,7,0.20))_10px)]"
        />
      ) : null}

      {/* Icono de estado. Va en AMBOS tramos: el corto no lleva etiqueta y sin
          esto quedaría distinguido solo por color. */}
      <Icon
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 left-2 size-3.5 opacity-70"
      />

      {/* Marca de continuación hacia la fila de abajo. */}
      {segment.openRight ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 right-1.5 text-base leading-none opacity-50"
        >
          ›
        </span>
      ) : null}

      {segment.label ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-2 bottom-1.5 z-[1] max-w-[95%] truncate rounded-full px-2 py-[0.1rem]",
            "font-mono text-[0.62rem] tracking-wider",
            skin.chip,
          )}
        >
          {segment.label}
        </span>
      ) : null}

      {segment.days.map((cell) => (
        <div
          key={cell.date}
          ref={(el) => {
            registerCell(cell.date, el);
          }}
          role="gridcell"
          tabIndex={focusedDate === cell.date ? 0 : -1}
          aria-label={dayCellAriaLabel(cell, segment)}
          aria-disabled={actionable ? undefined : true}
          data-date={cell.date}
          onFocus={() => onHoverWeek(segment.weekKey)}
          onBlur={() => onHoverWeek(null)}
          onClick={activar}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activar();
              return;
            }
            onCellKeyDown(event, cell.date);
          }}
          className={cn(
            "relative min-h-[4.3rem] px-2 pt-6 pb-6 text-left",
            "outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-[var(--wb-accent,#0E7490)] dark:focus-visible:outline-[var(--wb-accent,#3FC1D3)]",
            cell.ceded && `rounded-[7px] ${CEDED_SKIN.cell}`,
          )}
        >
          <span
            className={cn(
              "block text-[0.82rem] tabular-nums",
              // Los días del mes vecino se atenúan, no se ocultan: son parte
              // real de la semana y su estado sigue siendo el mismo.
              cell.isAdjacentMonth && "opacity-45",
              cell.isToday &&
                "-ml-1 inline-block rounded-full bg-current px-1.5 font-semibold text-[var(--wb-today-ink,#FFFFFF)] dark:text-[var(--wb-today-ink,#0B1116)]",
            )}
          >
            {cell.dayOfMonth}
          </span>

          {cell.ceded ? (
            <span
              className={cn(
                "mt-1 inline-block rounded-full px-1.5 py-[0.05rem] font-mono text-[0.6rem]",
                CEDED_SKIN.pill,
              )}
              title={`Cedido a ${cell.ceded.granteeName}`}
            >
              {cell.ceded.granteeInitials}
            </span>
          ) : null}

          {/* El punto de mantenimiento ya no es un adorno con `title` nativo:
              es un botón con su globo, alcanzable con el dedo y con el
              tabulador. Ver maintenance-marker.tsx. */}
          {cell.maintenance ? (
            <MaintenanceMarker notas={cell.maintenance} />
          ) : null}
        </div>
      ))}
    </div>
  );
}
