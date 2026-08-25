"use client";

/**
 * Navegación de mes: ◀ título ▶.
 *
 * La flecha del límite se DESHABILITA, no se oculta (§04). Una flecha que
 * desaparece deja a la persona buscando dónde estaba en lugar de entender que
 * llegó al final de lo que hay; deshabilitada sigue ahí, con su `title`
 * explicando por qué no responde.
 *
 * La aritmética de meses vive aquí y no en el orquestador porque es de este
 * control: sumar y restar un mes sobre `yyyy-MM` es exactamente lo que hacen
 * sus dos botones.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { monthTitle } from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";

const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Desplaza un mes `yyyy-MM`.
 *
 * Se hace con aritmética entera sobre el índice absoluto de mes y no con
 * `Date`: `new Date(2026, 0, 31)` más un mes da el 3 de marzo, y aquí el día no
 * existe. Con meses no hay desbordes que arrastrar.
 */
export function desplazarMes(mes: string, delta: number): string {
  const m = MES_RE.exec(mes);
  if (!m) throw new RangeError(`Mes inválido: ${mes} (se esperaba yyyy-MM)`);
  const indice = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const anio = Math.floor(indice / 12);
  const numero = (indice % 12) + 1;
  return `${String(anio).padStart(4, "0")}-${String(numero).padStart(2, "0")}`;
}

export const mesAnterior = (mes: string): string => desplazarMes(mes, -1);
export const mesSiguiente = (mes: string): string => desplazarMes(mes, 1);

/** "septiembre de 2026" → "Septiembre de 2026". */
function conMayuscula(texto: string): string {
  return texto.charAt(0).toLocaleUpperCase("es-MX") + texto.slice(1);
}

export interface MonthNavProps {
  /** Mes en pantalla, `yyyy-MM`. */
  mes: string;
  puedeAnterior: boolean;
  puedeSiguiente: boolean;
  onCambiarMes: (mes: string) => void;
  pendiente?: boolean;
  className?: string;
}

export function MonthNav({
  mes,
  puedeAnterior,
  puedeSiguiente,
  onCambiarMes,
  pendiente = false,
  className,
}: MonthNavProps) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Mes anterior"
        title={
          puedeAnterior
            ? "Mes anterior"
            : "No hay semanas registradas antes de este mes"
        }
        disabled={!puedeAnterior || pendiente}
        onClick={() => onCambiarMes(mesAnterior(mes))}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </Button>

      {/* `aria-live` para que al cambiar de mes el lector lo anuncie: el resto
          de la pantalla cambia entera y sin esto no hay pista de qué pasó. */}
      <h2
        aria-live="polite"
        className="min-w-40 text-center text-sm font-semibold tracking-tight"
      >
        {conMayuscula(monthTitle(mes))}
      </h2>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Mes siguiente"
        title={
          puedeSiguiente
            ? "Mes siguiente"
            : "Todavía no se puede ver más allá de este mes"
        }
        disabled={!puedeSiguiente || pendiente}
        onClick={() => onCambiarMes(mesSiguiente(mes))}
      >
        <ChevronRight className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
