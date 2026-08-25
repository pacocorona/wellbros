"use client";

/**
 * El GLOBO de las notas de mantenimiento. Lo ve todo el mundo, no solo la
 * superusuaria: la nota existe para que nadie llegue a la casa sin saber que
 * hay obra.
 *
 * Sustituye al atributo `title` nativo que llevaba antes el punto ámbar. Aquel
 * globo del sistema era lento y sin estilo, pero sobre todo era INEXISTENTE en
 * una pantalla táctil: en un teléfono no hay «pasar por encima», así que la
 * nota quedaba invisible justo en el aparato donde más se consulta el
 * calendario. De ahí que aquí haya DOS mecanismos y no uno:
 *
 *   · con puntero fino (ratón, lápiz) → `Tooltip`, que abre al pasar el cursor
 *     y también al llegar con el tabulador;
 *   · sin él (dedo) → `Popover`, que abre al TOCAR el punto.
 *
 * La rama se elige con `matchMedia("(hover: hover)")` y no con el ancho de la
 * ventana: lo que decide es el aparato, no cuánto se estiró el navegador. La
 * lectura pasa por `useSyncExternalStore` —con `true` como respuesta del
 * servidor— porque es la única forma de que la hidratación no reviente: el
 * servidor no puede saber si hay ratón, así que pinta la variante de escritorio
 * y el navegador corrige después, sin fotograma intermedio ni advertencia.
 *
 * El punto es un BOTÓN de verdad, con nombre accesible y un área de toque de
 * 24 px alrededor del círculo de 8. Y detiene la propagación del clic y de
 * Enter/Espacio: sin eso, consultar la nota abriría además el panel de la
 * semana, que es lo último que quiere quien solo iba a leer.
 */

import {
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { Wrench } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { MAINTENANCE_SKIN, type MaintenanceView } from "./types";

/* -------------------------------------------------------------------------- */
/* Texto del rango                                                             */
/* -------------------------------------------------------------------------- */

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

/** `yyyy-MM-dd` como fecha CIVIL anclada a UTC (mismo criterio que el resto). */
function civil(fechaISO: string): Date {
  const [anio, mes, dia] = fechaISO.split("-").map(Number);
  return new Date(Date.UTC(anio, mes - 1, dia));
}

/**
 * «8 de septiembre», «4 al 6 de septiembre», «30 de octubre al 5 de noviembre».
 *
 * En lenguaje natural y no en ISO: el globo lo lee cualquiera de la casa desde
 * el teléfono, no un administrador delante de una consola.
 */
export function rangoEnPalabras(inicioISO: string, finISO: string): string {
  const i = civil(inicioISO);
  const f = civil(finISO);
  if (inicioISO === finISO) {
    return `${i.getUTCDate()} de ${MESES[i.getUTCMonth()]}`;
  }
  if (i.getUTCMonth() === f.getUTCMonth()) {
    return `${i.getUTCDate()} al ${f.getUTCDate()} de ${MESES[f.getUTCMonth()]}`;
  }
  return (
    `${i.getUTCDate()} de ${MESES[i.getUTCMonth()]}` +
    ` al ${f.getUTCDate()} de ${MESES[f.getUTCMonth()]}`
  );
}

/* -------------------------------------------------------------------------- */
/* ¿Hay ratón?                                                                 */
/* -------------------------------------------------------------------------- */

const CONSULTA_PUNTERO_FINO = "(hover: hover)";

/** Se crea una sola vez: `matchMedia` en cada render sería tirar objetos. */
let consultaPuntero: MediaQueryList | null = null;

function consulta(): MediaQueryList {
  consultaPuntero ??= window.matchMedia(CONSULTA_PUNTERO_FINO);
  return consultaPuntero;
}

function suscribirPuntero(alCambiar: () => void): () => void {
  const mq = consulta();
  mq.addEventListener("change", alCambiar);
  return () => mq.removeEventListener("change", alCambiar);
}

function leerPunteroFino(): boolean {
  return consulta().matches;
}

/**
 * ¿El aparato tiene un puntero capaz de posarse encima?
 *
 * En el servidor se responde que sí. No es una suposición perezosa: es el único
 * valor que no cambia el HTML de la primera pintura para la mayoría de visitas,
 * y el táctil se corrige en cuanto React toma el control.
 *
 * El nombre arranca en inglés (`use…`) porque es la regla de React —y la que
 * comprueba `react-hooks/rules-of-hooks`—, no un descuido del español: igual
 * que `useTheme` en theme-provider.
 */
function usePunteroFino(): boolean {
  return useSyncExternalStore(suscribirPuntero, leerPunteroFino, () => true);
}

/* -------------------------------------------------------------------------- */
/* Contenido                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Lo que dice el globo, igual en las dos ramas.
 *
 * Los tonos secundarios van con `opacity` y no con `text-muted-foreground`:
 * el globo del ratón se pinta sobre `bg-foreground` (fondo invertido) y el del
 * dedo sobre `bg-popover`, así que cualquier color fijo se rompería en uno de
 * los dos. La opacidad funciona en ambos y en los dos temas.
 */
function ContenidoNotas({ notas }: { notas: MaintenanceView[] }) {
  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <p className="flex items-center gap-1.5 font-medium">
        <Wrench className="size-3.5 shrink-0" aria-hidden />
        {notas.length === 1
          ? MAINTENANCE_SKIN.text
          : `${notas.length} notas de mantenimiento`}
      </p>

      <ul className="flex flex-col gap-2">
        {notas.map((nota) => (
          <li key={nota.id} className="flex flex-col gap-0.5">
            {/* `break-words` porque una nota puede traer una palabra larguísima
                (un número de serie) y sin esto desbordaría el globo. */}
            <span className="break-words whitespace-pre-line">{nota.note}</span>
            <span className="opacity-75">
              {rangoEnPalabras(nota.startDate, nota.endDate)}
              {nota.authorName ? ` · ${nota.authorName}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Globo y punto                                                               */
/* -------------------------------------------------------------------------- */

export interface NotasGloboProps {
  /**
   * Lo que abre el globo. Tiene que ser un BOTÓN: los dos disparadores de Base
   * UI lo esperan, y de él salen el nombre accesible y el foco de teclado.
   */
  disparador: ReactElement;
  notas: MaintenanceView[];
}

/**
 * El globo en sí, sin decidir a qué se engancha.
 *
 * Se separa del punto del calendario porque el formulario de mantenimiento
 * cuelga el MISMO globo de sus fichas de día, para enseñar la nota que ya
 * existe antes de anotar otra encima. Si cada uno tuviera el suyo, el que
 * funciona con el dedo acabaría existiendo solo en uno de los dos sitios.
 */
export function NotasGlobo({ disparador, notas }: NotasGloboProps) {
  const punteroFino = usePunteroFino();

  if (notas.length === 0) return null;

  // Ancho máximo atado al de la ventana: en un teléfono estrecho un globo de
  // 18 rem se saldría por el lado. El posicionador ya voltea y desplaza solo.
  if (punteroFino) {
    return (
      <Tooltip>
        <TooltipTrigger render={disparador} />
        <TooltipContent
          side="top"
          className="max-w-[min(20rem,calc(100vw-2rem))] flex-col items-stretch p-2.5 text-left"
        >
          <ContenidoNotas notas={notas} />
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger render={disparador} />
      <PopoverContent
        side="top"
        className="w-[min(18rem,calc(100vw-2rem))] text-left"
      >
        <ContenidoNotas notas={notas} />
      </PopoverContent>
    </Popover>
  );
}

export interface MaintenanceMarkerProps {
  /** Notas que cubren el día. Nunca vacío: quien no tiene, no pinta punto. */
  notas: MaintenanceView[];
  className?: string;
}

export function MaintenanceMarker({ notas, className }: MaintenanceMarkerProps) {
  if (notas.length === 0) return null;

  // El nombre accesible es corto a propósito: el texto de las notas ya viaja en
  // el `aria-label` de la celda (dayCellAriaLabel) y como descripción del
  // globo. Repetirlo aquí obligaría a oírlo tres veces.
  const etiqueta =
    notas.length === 1
      ? "Nota de mantenimiento"
      : `${notas.length} notas de mantenimiento`;

  /** Sin esto, leer la nota abriría también el panel de la semana. */
  const detenerClic = (evento: MouseEvent<HTMLButtonElement>) => {
    evento.stopPropagation();
  };

  const detenerTeclas = (evento: KeyboardEvent<HTMLButtonElement>) => {
    // Solo las teclas que ACTIVAN. Las flechas siguen subiendo a la retícula
    // para que el recorrido con el teclado no se quede atrapado en el punto.
    if (evento.key === "Enter" || evento.key === " ") evento.stopPropagation();
  };

  const punto = (
    <button
      type="button"
      aria-label={etiqueta}
      onClick={detenerClic}
      onKeyDown={detenerTeclas}
      className={cn(
        // El relleno es el área de toque: el círculo mide 8 px y el dedo
        // necesita 24. Sin `p-2` el punto es inalcanzable en un teléfono.
        "absolute top-0 right-0 inline-flex items-center justify-center rounded-full p-2",
        "outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-[var(--wb-accent,#0E7490)] dark:focus-visible:outline-[var(--wb-accent,#3FC1D3)]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("block size-2 rounded-full", MAINTENANCE_SKIN.dot)}
      />
    </button>
  );

  return <NotasGlobo disparador={punto} notas={notas} />;
}
