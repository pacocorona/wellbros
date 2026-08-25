"use client";

/**
 * Combo de propiedades, fijo sobre el calendario (§04).
 *
 * Con una sola propiedad no se pinta un desplegable que no despliega nada: se
 * muestra su nombre. Un control que no hace nada al pulsarlo es peor que no
 * tener control, y en esta casa lo habitual es empezar con una propiedad e ir
 * sumando.
 *
 * Cada opción lleva el PUNTO con el color de identidad de su propiedad —el
 * mismo que tiñe el riel y el borde de la tarjeta del calendario—, para que al
 * abrir la lista se vea de un golpe cuál es cuál y a qué va a cambiar la
 * pantalla. El punto NUNCA va solo: el nombre del color viaja en el texto
 * accesible ("Casa del Lago (Índigo)"), porque quien no lo distingue —o no lo
 * ve— necesita exactamente la misma información que quien sí.
 */

import { Home } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_PROPERTY_COLOR,
  propertyColorLabel,
  propertyColorStyle,
  type PropertyColor,
} from "@/lib/property-color";
import { cn } from "@/lib/utils";

export interface PropiedadOpcion {
  id: string;
  name: string;
  /**
   * Color de identidad (`properties.color`), ya normalizado en el servidor con
   * `coercePropertyColor`: aquí no se acepta nada que no esté en la lista.
   */
  color: PropertyColor;
}

export interface PropertySelectProps {
  propiedades: PropiedadOpcion[];
  valor: string;
  onCambiar: (propiedadId: string) => void;
  /** Hay una navegación en vuelo: el combo se congela para no encadenar saltos. */
  pendiente?: boolean;
  className?: string;
}

/** "Casa del Lago (Índigo)": lo que oye quien no ve el punto. */
function textoAccesible(propiedad: PropiedadOpcion): string {
  return `${propiedad.name} (${propertyColorLabel(propiedad.color)})`;
}

/**
 * El punto de color de una propiedad.
 *
 * Trae SUS PROPIAS variables en línea en vez de heredar las del calendario por
 * dos razones: el desplegable se dibuja en un portal, fuera del contenedor que
 * las lleva, y además cada opción tiene que lucir la suya —que es justo lo que
 * permite compararlas—. El anillo lo despega de fondos que casi coinciden con
 * el color; sin él, un punto ámbar sobre papel cálido se desdibuja.
 */
function PuntoColor({
  color,
  className,
}: {
  color: PropertyColor;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-wb-prop=""
      style={propertyColorStyle(color)}
      className={cn(
        "size-2.5 shrink-0 rounded-full bg-[var(--wb-prop)] ring-1 ring-black/15 transition-colors dark:ring-white/20",
        className,
      )}
    />
  );
}

export function PropertySelect({
  propiedades,
  valor,
  onCambiar,
  pendiente = false,
  className,
}: PropertySelectProps) {
  const actual = propiedades.find((p) => p.id === valor);
  const colorActual = actual?.color ?? DEFAULT_PROPERTY_COLOR;

  if (propiedades.length <= 1) {
    return (
      <p
        className={cn(
          "flex h-8 items-center gap-1.5 text-sm font-medium",
          className,
        )}
      >
        <Home className="size-4 text-muted-foreground" aria-hidden />
        <PuntoColor color={colorActual} />
        {actual?.name ?? "Sin propiedad"}
        {actual ? (
          <span className="sr-only">
            {` (${propertyColorLabel(colorActual)})`}
          </span>
        ) : null}
      </p>
    );
  }

  return (
    <Select
      // `items` es lo que hace que el disparador muestre el NOMBRE de la
      // propiedad y no su uuid, que es el valor real del control. Sigue
      // haciendo falta aunque abajo se dibuje el valor a mano: de aquí salen
      // las etiquetas que usa la búsqueda por teclado.
      items={Object.fromEntries(propiedades.map((p) => [p.id, p.name]))}
      value={valor}
      onValueChange={(nuevo) => {
        if (typeof nuevo === "string" && nuevo !== valor) onCambiar(nuevo);
      }}
      disabled={pendiente}
    >
      <SelectTrigger
        aria-label={
          actual ? `Propiedad: ${textoAccesible(actual)}` : "Propiedad"
        }
        className={cn("max-w-56 min-w-40 font-medium", className)}
      >
        <Home className="size-4 text-muted-foreground" aria-hidden />
        {/* Con función como hija, el valor se pinta aquí en vez de dejar que
            `items` resuelva solo el texto: es la única forma de meter el punto
            junto al nombre. El `aria-label` del disparador ya dice ambas cosas,
            así que lo de dentro es puro dibujo. */}
        <SelectValue>
          {(seleccionado: unknown) => {
            const elegida =
              typeof seleccionado === "string"
                ? propiedades.find((p) => p.id === seleccionado)
                : undefined;
            return (
              <>
                <PuntoColor color={elegida?.color ?? DEFAULT_PROPERTY_COLOR} />
                <span className="truncate">
                  {elegida?.name ?? "Sin propiedad"}
                </span>
              </>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {propiedades.map((propiedad) => (
          <SelectItem
            key={propiedad.id}
            value={propiedad.id}
            aria-label={textoAccesible(propiedad)}
          >
            <PuntoColor color={propiedad.color} />
            {propiedad.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
