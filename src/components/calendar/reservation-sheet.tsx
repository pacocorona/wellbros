"use client";

/**
 * Hoja lateral de una semana ya reservada.
 *
 * Atiende los dos casos en que la semana tiene dueño, porque comparten
 * encabezado y lista de días cedidos y solo difieren en lo que se puede hacer:
 *
 *   · MIA       → cancelar la reserva y repartir sus días.
 *   · RESERVADA → solo lectura con el nombre; la superusuaria puede además
 *                 cancelarla, con motivo obligatorio, y eso queda en bitácora.
 *
 * Por qué la cancelación se confirma EN LÍNEA y no con otro diálogo encima:
 * anidar dos capas modales pelea por el foco y en móvil deja la hoja
 * inutilizable si la segunda se cierra mal. Un botón que se convierte en
 * "¿Seguro?" es igual de explícito y no puede dejar la pantalla bloqueada.
 *
 * Que aquí no se pinte un botón NO es el control de acceso: quien decide si una
 * cancelación procede es src/server/reservations dentro de la transacción.
 */

import { useState } from "react";
import { CalendarX2, Lock, Star, Trash2, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { type WeekView } from "@/lib/calendar-grid";

import { GrantForm, type UsuarioOpcion } from "./grant-form";
import { etiquetaDiaCorto, etiquetaRangoExacto, unirConY } from "./reserve-dialog";

export type { UsuarioOpcion };

/** Quién mira. `esSuperusuaria` viene del servidor, nunca del navegador. */
export interface VisorCalendario {
  id: string;
  fullName: string;
  esSuperusuaria: boolean;
}

export interface ReservationSheetProps {
  semana: WeekView | null;
  abierta: boolean;
  onAbiertaChange: (abierta: boolean) => void;
  visor: VisorCalendario;
  usuarios: UsuarioOpcion[];
  /** Hoy en la zona de negocio, `yyyy-MM-dd`. */
  hoyISO: string;
  pendiente: boolean;
  /** El motivo es obligatorio al cancelar una reserva ajena. */
  onCancelar: (motivo: string | null) => void;
  onCeder: (granteeUserId: string, dias: string[]) => void;
  onRevocar: (dias: string[]) => void;
}

export function ReservationSheet({
  semana,
  abierta,
  onAbiertaChange,
  visor,
  usuarios,
  hoyISO,
  pendiente,
  onCancelar,
  onCeder,
  onRevocar,
}: ReservationSheetProps) {
  const [confirmando, setConfirmando] = useState(false);
  const [motivo, setMotivo] = useState("");

  // Ni la confirmación a medias ni el motivo escrito pueden viajar de una
  // semana a otra: son la explicación de ESTA cancelación. El ajuste se hace
  // comparando durante el render y no en un efecto, para que no llegue a
  // pintarse un fotograma con el texto de la semana anterior.
  const claveActual = abierta ? (semana?.startDate ?? null) : null;
  const [claveVista, setClaveVista] = useState(claveActual);
  if (claveVista !== claveActual) {
    setClaveVista(claveActual);
    if (confirmando) setConfirmando(false);
    if (motivo !== "") setMotivo("");
  }

  if (!semana) return null;

  const esMia = semana.availability === "MIA";
  const rango = etiquetaRangoExacto(semana.startDate, semana.endDate);
  const cesiones = semana.grants ?? [];
  const puedeCancelar = esMia || visor.esSuperusuaria;
  // La superusuaria cancelando lo ajeno tiene que decir por qué; el dueño no.
  const motivoObligatorio = !esMia;
  const motivoListo = !motivoObligatorio || motivo.trim().length > 0;
  // Una semana que ya terminó no se cancela: no queda nada que liberar.
  const semanaTerminada = semana.endDate < hoyISO;

  return (
    <Sheet open={abierta} onOpenChange={onAbiertaChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-1 border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            {esMia ? (
              <Star className="size-4 text-[var(--wb-mine-bd,#2563eb)]" aria-hidden />
            ) : (
              <User className="size-4 text-[var(--wb-other-bd,#7c5cd6)]" aria-hidden />
            )}
            {esMia ? "Tu semana" : `Semana de ${semana.reservedByName ?? "otra persona"}`}
          </SheetTitle>
          <SheetDescription className="text-foreground">{rango}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 p-4">
          {esMia ? (
            <GrantForm
              semana={semana}
              usuarios={usuarios}
              hoyISO={hoyISO}
              pendiente={pendiente}
              onCeder={onCeder}
              onRevocar={onRevocar}
            />
          ) : (
            <section className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Esta semana ya tiene dueño. Solo{" "}
                {semana.reservedByName ?? "quien la reservó"} puede ceder sus
                días.
              </p>
              {cesiones.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Días cedidos:{" "}
                  <span className="text-foreground">
                    {unirConY(
                      cesiones.map(
                        (c) => `${etiquetaDiaCorto(c.date)} a ${c.granteeName}`,
                      ),
                    )}
                    .
                  </span>
                </p>
              ) : null}
            </section>
          )}

          {puedeCancelar && !semanaTerminada ? (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-medium">
                {esMia ? "Liberar la semana" : "Cancelar como administración"}
              </h3>
              <p className="text-sm text-muted-foreground">
                {esMia
                  ? "La semana vuelve a quedar disponible para todos y las cesiones que hayas hecho se cancelan con ella."
                  : "La semana vuelve a quedar disponible y la cancelación queda registrada en la bitácora con tu nombre y tu motivo."}
              </p>

              {motivoObligatorio ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="motivo-cancelacion">Motivo (obligatorio)</Label>
                  <Textarea
                    id="motivo-cancelacion"
                    value={motivo}
                    onChange={(evento) => setMotivo(evento.target.value)}
                    maxLength={500}
                    rows={2}
                    placeholder="Por qué se cancela esta reserva"
                    disabled={pendiente}
                  />
                </div>
              ) : null}

              {cesiones.length > 0 && esMia ? (
                <p className="text-sm text-muted-foreground">
                  Se cancelarán también{" "}
                  {unirConY(cesiones.map((c) => etiquetaDiaCorto(c.date)))}, que
                  tenías cedidos.
                </p>
              ) : null}

              {confirmando ? (
                <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-sm font-medium">
                    {esMia
                      ? "¿Seguro que quieres cancelar tu reserva?"
                      : `¿Seguro que quieres cancelar la reserva de ${semana.reservedByName ?? "esta persona"}?`}
                  </p>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      className="sm:flex-1"
                      disabled={pendiente}
                      onClick={() => setConfirmando(false)}
                    >
                      No, dejarla
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="lg"
                      className="sm:flex-1"
                      disabled={pendiente || !motivoListo}
                      onClick={() => onCancelar(motivo.trim() || null)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      {pendiente ? "Cancelando…" : "Sí, cancelar"}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  size="lg"
                  disabled={pendiente || !motivoListo}
                  onClick={() => setConfirmando(true)}
                >
                  <CalendarX2 className="size-4" aria-hidden />
                  {esMia
                    ? "Cancelar reserva"
                    : "Cancelar (quedará en la bitácora)"}
                </Button>
              )}
            </section>
          ) : null}

          {semanaTerminada ? (
            <p className="flex items-start gap-2 border-t border-border pt-4 text-sm text-muted-foreground">
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
              Esta semana ya terminó: no hay nada que cancelar ni que ceder.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
