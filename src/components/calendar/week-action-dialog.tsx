"use client";

/**
 * El SELECTOR DE ACCIÓN de la superusuaria.
 *
 * Para cualquier otra persona el calendario no cambia: tocar una semana lleva
 * directo a reservarla o a su hoja. La superusuaria, en cambio, puede hacer dos
 * cosas distintas con el mismo gesto —reservar o anotar mantenimiento—, así que
 * antes de actuar se le pregunta cuál.
 *
 * Se abre en CUALQUIER semana, también en PASADA, CERRADA, PROGRAMADA y
 * SIN_APERTURA. No es un descuido: el mantenimiento cae justo ahí. Se anota una
 * obra en una semana cerrada porque se cerró por la obra, y se registra en una
 * semana pasada lo que ya se hizo. Cuando reservar no procede, la acción no se
 * pinta y se dice en una línea POR QUÉ, que es distinto de dejar un botón
 * apagado sin explicación.
 *
 * Si la semana ya tiene dueño, la acción de reservar se sustituye por la de
 * abrir su hoja —ceder días, o cancelarla como administración—, que es el
 * comportamiento que el calendario ya tenía y que aquí no se pierde.
 *
 * El formulario de mantenimiento vive DENTRO de este diálogo, como segundo
 * paso, y no en una segunda capa modal encima: dos modales anidados pelean por
 * el foco y en móvil dejan la pantalla bloqueada si la de arriba se cierra mal.
 */

import { useState } from "react";
import { CalendarCheck, CalendarRange, Star, User, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { MaintenanceForm } from "./maintenance-form";
import { etiquetaRangoExacto } from "./reserve-dialog";
import {
  ESTADOS_CON_DUENIO,
  ESTADOS_RESERVABLES,
  type Availability,
  type MaintenanceView,
  type WeekView,
} from "./types";

/**
 * Por qué esta semana no se puede reservar. Una línea, en voz de persona.
 * Solo se consulta cuando la semana no es reservable ni tiene dueño.
 */
const MOTIVO_SIN_RESERVA: Partial<Record<Availability, string>> = {
  PASADA: "Esa semana ya terminó: no queda nada que reservar.",
  CERRADA: "La semana está cerrada: se retiró de la oferta.",
  SIN_APERTURA:
    "Esa semana no tiene apertura. Se abre en Configuración → Propiedades.",
};

/* -------------------------------------------------------------------------- */
/* Acción                                                                      */
/* -------------------------------------------------------------------------- */

function AccionGrande({
  icono: Icono,
  tono,
  titulo,
  descripcion,
  disabled,
  onClick,
}: {
  icono: LucideIcon;
  /** Color de la pastilla del icono; nunca el único portador de significado. */
  tono: string;
  titulo: string;
  descripcion: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border border-border bg-background p-3 text-left transition-colors outline-none",
        "hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
          tono,
        )}
      >
        <Icono className="size-4" aria-hidden />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{titulo}</span>
        <span className="text-sm text-muted-foreground">{descripcion}</span>
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Diálogo                                                                     */
/* -------------------------------------------------------------------------- */

export interface WeekActionDialogProps {
  /** Semana tocada; `null` cuando no hay ninguna. */
  semana: WeekView | null;
  abierto: boolean;
  onAbiertoChange: (abierto: boolean) => void;
  /** Propiedad en pantalla: de ella cuelga la nota de mantenimiento. */
  propiedadId: string;
  /** Notas ya visibles en la retícula, para marcar los días ya anotados. */
  notas: MaintenanceView[];
  /** Hay una reserva o una cancelación en vuelo. */
  pendiente: boolean;
  /** Sigue al diálogo de reserva de siempre. */
  onReservar: () => void;
  /** Sigue a la hoja de la reserva: ceder días o cancelarla. */
  onAbrirReserva: () => void;
}

export function WeekActionDialog({
  semana,
  abierto,
  onAbiertoChange,
  propiedadId,
  notas,
  pendiente,
  onReservar,
  onAbrirReserva,
}: WeekActionDialogProps) {
  const [paso, setPaso] = useState<"acciones" | "mantenimiento">("acciones");

  // El paso no puede sobrevivir a la semana: quedaría el formulario abierto
  // sobre otra distinta. Se ajusta comparando DURANTE EL RENDER —el patrón que
  // React recomienda para reaccionar a un cambio de props— y no con un efecto,
  // que pintaría un fotograma con el formulario de la semana anterior.
  const claveActual = abierto ? (semana?.startDate ?? null) : null;
  const [claveVista, setClaveVista] = useState(claveActual);
  if (claveVista !== claveActual) {
    setClaveVista(claveActual);
    if (paso !== "acciones") setPaso("acciones");
  }

  if (!semana) return null;

  const rango = etiquetaRangoExacto(semana.startDate, semana.endDate);
  const tieneDuenio = ESTADOS_CON_DUENIO.includes(semana.availability);
  const esMia = semana.availability === "MIA";
  const puedeReservar = ESTADOS_RESERVABLES.includes(semana.availability);
  const motivo = MOTIVO_SIN_RESERVA[semana.availability];
  const enMantenimiento = paso === "mantenimiento";

  return (
    <Dialog open={abierto} onOpenChange={onAbiertoChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {enMantenimiento ? (
              <Wrench className="size-4 text-muted-foreground" aria-hidden />
            ) : (
              <CalendarRange className="size-4 text-muted-foreground" aria-hidden />
            )}
            {enMantenimiento
              ? "Nota de mantenimiento"
              : "¿Qué quieres hacer con esta semana?"}
          </DialogTitle>
          <DialogDescription className="text-base font-medium text-foreground">
            {rango}
          </DialogDescription>
        </DialogHeader>

        {enMantenimiento ? (
          <MaintenanceForm
            propiedadId={propiedadId}
            semana={semana}
            notas={notas}
            onVolver={() => setPaso("acciones")}
            onGuardado={() => onAbiertoChange(false)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {tieneDuenio ? (
              <AccionGrande
                icono={esMia ? Star : User}
                tono={
                  esMia
                    ? "bg-[var(--wb-mine-bg,#DBEAFE)] text-[var(--wb-mine-fg,#1E40AF)] dark:bg-[var(--wb-mine-bg,#102C5C)] dark:text-[var(--wb-mine-fg,#A3C6FB)]"
                    : "bg-[var(--wb-other-bg,#ECE7F9)] text-[var(--wb-other-fg,#55349E)] dark:bg-[var(--wb-other-bg,#291B4E)] dark:text-[var(--wb-other-fg,#CBB8F8)]"
                }
                titulo={esMia ? "Abrir tu reserva" : "Abrir la reserva"}
                descripcion={
                  esMia
                    ? "Ceder días de la semana o cancelarla."
                    : `Semana de ${semana.reservedByName ?? "otra persona"}. Puedes cancelarla como administración, con motivo.`
                }
                disabled={pendiente}
                onClick={onAbrirReserva}
              />
            ) : puedeReservar ? (
              <AccionGrande
                icono={CalendarCheck}
                tono="bg-[var(--wb-open-bg,#DCF5E3)] text-[var(--wb-open-fg,#1B6B3C)] dark:bg-[var(--wb-open-bg,#0B3320)] dark:text-[var(--wb-open-fg,#8FE7B4)]"
                titulo="Reservar esta semana"
                descripcion={
                  semana.availability === "PROGRAMADA"
                    ? "Todavía no abre: podrás tomarla como excepción, con motivo."
                    : semana.availability === "EN_CURSO"
                      ? "La semana ya empezó: no quedan los siete días."
                      : "Se avisará por correo a toda la casa."
                }
                disabled={pendiente}
                onClick={onReservar}
              />
            ) : (
              <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                {motivo ?? "Esta semana no se puede reservar."}
              </p>
            )}

            {/* Mantenimiento SIEMPRE, sea cual sea el estado de la semana: la
                obra no espera a que la semana esté disponible. */}
            <AccionGrande
              icono={Wrench}
              tono="bg-[var(--wb-closed-bg,#FCEEC8)] text-[var(--wb-closed-fg,#7A4A05)] dark:bg-[var(--wb-closed-bg,#392A08)] dark:text-[var(--wb-closed-fg,#EFC257)]"
              titulo="Crear nota de mantenimiento"
              descripcion="Marca los días con obra. Se ve en el calendario de todos y no bloquea reservas."
              onClick={() => setPaso("mantenimiento")}
            />

            <Button
              type="button"
              variant="outline"
              size="lg"
              className="mt-1 self-end"
              onClick={() => onAbiertoChange(false)}
            >
              Cerrar
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
