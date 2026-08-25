/**
 * Leyenda del calendario.
 *
 * Solo lista los estados que de verdad aparecen en el mes: una leyenda con ocho
 * chips fijos, seis de ellos ausentes de la pantalla, es ruido. Cada chip lleva
 * muestra de color E icono, los mismos que el tramo, porque la leyenda es lo que
 * hace legible el calendario para quien no distingue los colores.
 */

import type { LucideIcon } from "lucide-react";

import { AVAILABILITY_TEXT } from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";

import {
  AVAILABILITY_SKIN,
  CEDED_SKIN,
  MAINTENANCE_SKIN,
  type LegendProps,
} from "./types";

interface ChipProps {
  swatch: string;
  icon: LucideIcon;
  text: string;
}

function Chip({ swatch, icon: Icon, text }: ChipProps) {
  return (
    <span className="border-border text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.72rem]">
      <i aria-hidden="true" className={cn("size-2.5 rounded-[3px]", swatch)} />
      <Icon aria-hidden className="size-3 opacity-70" />
      {text}
    </span>
  );
}

export function Legend({
  availabilities,
  hasGrants = false,
  hasMaintenance = false,
  className,
}: LegendProps) {
  if (availabilities.length === 0 && !hasGrants && !hasMaintenance) return null;

  return (
    <div
      className={cn("flex flex-wrap gap-1.5", className)}
      aria-label="Leyenda del calendario"
    >
      {availabilities.map((availability) => (
        <Chip
          key={availability}
          swatch={AVAILABILITY_SKIN[availability].swatch}
          icon={AVAILABILITY_SKIN[availability].icon}
          text={AVAILABILITY_TEXT[availability]}
        />
      ))}

      {/* No son estados de semana sino marcas de día, por eso van al final. */}
      {hasGrants ? (
        <Chip
          swatch={CEDED_SKIN.swatch}
          icon={CEDED_SKIN.icon}
          text={CEDED_SKIN.text}
        />
      ) : null}
      {hasMaintenance ? (
        <Chip
          swatch={MAINTENANCE_SKIN.swatch}
          icon={MAINTENANCE_SKIN.icon}
          text={MAINTENANCE_SKIN.text}
        />
      ) : null}
    </div>
  );
}
