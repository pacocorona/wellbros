"use client";

/**
 * Ceder días de una semana propia.
 *
 * La semana se despliega como siete chips —uno por día— porque ceder es una
 * decisión día a día, no de rango: lo normal es "el sábado y el domingo", no
 * "del sábado al martes". Con chips el gesto es un toque por día y el resumen
 * de abajo dice en voz alta lo que va a pasar antes de que pase.
 *
 * Los tres estados de un chip no se distinguen SOLO por color (§04):
 *   · libre      → contorno; al elegirlo aparece una marca ✓
 *   · cedido     → relleno teal con las iniciales de quien lo recibió y una ×
 *   · ya pasado  → apagado y sin foco; ni se cede ni se retira lo ya vivido
 *
 * Retirar una cesión no pide confirmación: es reversible en el acto (basta
 * volver a cederla) y a quien la tenía se le avisa por correo. Cancelar la
 * semana entera sí la pide, porque eso no se deshace.
 */

import { useMemo, useState } from "react";
import { Check, Undo2, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addDaysISO, type GrantView, type WeekView } from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";

import { etiquetaDiaCorto, unirConY } from "./reserve-dialog";

/** Persona a la que se le pueden ceder días: activa y distinta del dueño. */
export interface UsuarioOpcion {
  id: string;
  fullName: string;
}

export interface GrantFormProps {
  semana: WeekView;
  usuarios: UsuarioOpcion[];
  /** Hoy en la zona de negocio, `yyyy-MM-dd`. */
  hoyISO: string;
  pendiente: boolean;
  onCeder: (granteeUserId: string, dias: string[]) => void;
  onRevocar: (dias: string[]) => void;
}

interface Dia {
  iso: string;
  cesion: GrantView | undefined;
  /** Ya transcurrió: el servicio lo rechazaría y el chip no debe invitar. */
  pasado: boolean;
}

export function GrantForm({
  semana,
  usuarios,
  hoyISO,
  pendiente,
  onCeder,
  onRevocar,
}: GrantFormProps) {
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [destino, setDestino] = useState<string | null>(null);

  const dias = useMemo<Dia[]>(() => {
    const cesiones = new Map((semana.grants ?? []).map((g) => [g.date, g]));
    return Array.from({ length: 7 }, (_, i) => {
      const iso = addDaysISO(semana.startDate, i);
      return { iso, cesion: cesiones.get(iso), pasado: iso < hoyISO };
    });
  }, [semana.grants, semana.startDate, hoyISO]);

  // Cuando el servidor devuelve la semana ya modificada, la selección anterior
  // deja de tener sentido: los días recién cedidos ya no son elegibles. Se
  // ajusta durante el render (patrón recomendado de React) y no con un efecto,
  // que dejaría un fotograma con chips marcados que ya no existen.
  const [cesionesVistas, setCesionesVistas] = useState(semana.grants);
  if (cesionesVistas !== semana.grants) {
    setCesionesVistas(semana.grants);
    if (seleccion.length > 0) setSeleccion([]);
  }

  const alternar = (iso: string) => {
    setSeleccion((previa) =>
      previa.includes(iso)
        ? previa.filter((d) => d !== iso)
        : [...previa, iso].sort(),
    );
  };

  const nombreDestino = usuarios.find((u) => u.id === destino)?.fullName ?? "";
  const puedeCeder =
    !pendiente && seleccion.length > 0 && destino !== null && usuarios.length > 0;

  // `items` hace que el disparador muestre el NOMBRE y no el uuid.
  const opcionesDestino = useMemo(
    () => Object.fromEntries(usuarios.map((u) => [u.id, u.fullName])),
    [usuarios],
  );

  return (
    <section className="flex flex-col gap-3" aria-labelledby="ceder-titulo">
      <div>
        <h3 id="ceder-titulo" className="text-sm font-medium">
          Ceder días
        </h3>
        <p className="text-sm text-muted-foreground">
          Quien reciba un día aparece con sus iniciales en el calendario de
          todos. No hace falta que acepte.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Días de la semana">
        {dias.map((dia) => {
          const elegido = seleccion.includes(dia.iso);

          if (dia.cesion) {
            const texto = `${etiquetaDiaCorto(dia.iso)} · ${dia.cesion.granteeInitials}`;
            // Un día cedido que ya pasó es historia: se muestra, no se toca.
            if (dia.pasado) {
              return (
                <span
                  key={dia.iso}
                  title={`Cedido a ${dia.cesion.granteeName}`}
                  className="inline-flex h-8 items-center gap-1 rounded-full border border-transparent bg-[var(--wb-ceded-bg,#cdf2ea)] px-3 text-sm text-muted-foreground opacity-60 dark:bg-[var(--wb-ceded-bg,#062f2b)]"
                >
                  {texto}
                </span>
              );
            }
            return (
              <button
                key={dia.iso}
                type="button"
                disabled={pendiente}
                onClick={() => onRevocar([dia.iso])}
                aria-label={`Retirar la cesión de ${etiquetaDiaCorto(dia.iso)} a ${dia.cesion.granteeName}`}
                title={`Cedido a ${dia.cesion.granteeName}. Toca para retirarlo.`}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--wb-ceded-chip,#0f766e)] px-3 text-sm text-white transition-opacity outline-none hover:opacity-85 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-[var(--wb-ceded-bd,#23bba7)] dark:text-[#022a26]"
              >
                {texto}
                <Undo2 className="size-3.5" aria-hidden />
              </button>
            );
          }

          return (
            <button
              key={dia.iso}
              type="button"
              disabled={pendiente || dia.pasado}
              aria-pressed={elegido}
              onClick={() => alternar(dia.iso)}
              className={cn(
                "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                elegido
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-input hover:bg-muted",
                dia.pasado && "cursor-not-allowed opacity-45 hover:bg-transparent",
              )}
            >
              {elegido ? <Check className="size-3.5" aria-hidden /> : null}
              {etiquetaDiaCorto(dia.iso)}
            </button>
          );
        })}
      </div>

      {usuarios.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No hay nadie más con acceso a quien ceder días.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="destino-cesion">Ceder a</Label>
            <Select
              items={opcionesDestino}
              value={destino}
              onValueChange={(valor) =>
                setDestino(typeof valor === "string" ? valor : null)
              }
              disabled={pendiente}
            >
              <SelectTrigger id="destino-cesion" className="w-full">
                <SelectValue placeholder="Elige a quién" />
              </SelectTrigger>
              <SelectContent>
                {usuarios.map((usuario) => (
                  <SelectItem key={usuario.id} value={usuario.id}>
                    {usuario.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* El resumen es la última oportunidad de darse cuenta de un toque
              equivocado, así que se escribe con las mismas palabras que usaría
              una persona. `aria-live` lo anuncia sin ir a buscarlo. */}
          <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
            {seleccion.length > 0 && nombreDestino
              ? `Cedes ${unirConY(seleccion.map(etiquetaDiaCorto))} a ${nombreDestino}.`
              : seleccion.length > 0
                ? "Elige a quién le cedes esos días."
                : null}
          </p>

          <Button
            type="button"
            size="lg"
            disabled={!puedeCeder}
            onClick={() => {
              if (destino) onCeder(destino, seleccion);
            }}
          >
            <UserPlus className="size-4" aria-hidden />
            {pendiente
              ? "Cediendo…"
              : seleccion.length === 0
                ? "Ceder días"
                : seleccion.length === 1
                  ? "Ceder 1 día"
                  : `Ceder ${seleccion.length} días`}
          </Button>
        </>
      )}
    </section>
  );
}
