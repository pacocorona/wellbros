"use client";

/**
 * Diálogo de la semana no reservada: confirmar la reserva o explicar por qué
 * todavía no se puede.
 *
 * Dos modos en un solo componente porque son la misma conversación vista desde
 * dos momentos: "esta semana está libre, ¿la tomas?" y "esta semana está libre
 * pero aún no abre". Separarlos duplicaría el encabezado, el rango y el aviso
 * de correo sin ganar nada.
 *
 * Este archivo es además la CASA DE LOS TEXTOS DE FECHA de la vista de
 * calendario: `reservation-sheet` y `grant-form` importan de aquí sus etiquetas.
 * Viven en este módulo y no en el orquestador (`calendar-view`) para que las
 * dependencias vayan siempre en un sentido —vista → hoja → formulario →
 * etiquetas— y no haya ciclos de importación entre componentes de cliente.
 */

import { useEffect, useState } from "react";
import { TZDate } from "@date-fns/tz";
import { AlertTriangle, CalendarCheck, Clock, Lock, Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { diffDaysISO, type WeekView } from "@/lib/calendar-grid";

/* -------------------------------------------------------------------------- */
/* Etiquetas de fecha (compartidas con la hoja y el formulario de cesión)       */
/* -------------------------------------------------------------------------- */

const DIAS = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
] as const;

const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

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

const MESES_CORTOS = [
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

/**
 * `yyyy-MM-dd` como fecha CIVIL anclada a UTC.
 *
 * Nunca `new Date("2026-09-04")` interpretado en local: al oeste de Greenwich
 * eso devuelve el día anterior y el diálogo diría "jueves 3" donde la base dice
 * "viernes 4". Es el mismo criterio que sigue @/lib/calendar-grid.
 */
function civil(dateISO: string): Date {
  const [anio, mes, dia] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(anio, mes - 1, dia));
}

function dos(n: number): string {
  return String(n).padStart(2, "0");
}

/** «Viernes 4 sep 00:00 → Jueves 10 sep 23:59». El rango exacto, sin ambigüedad. */
export function etiquetaRangoExacto(inicioISO: string, finISO: string): string {
  const i = civil(inicioISO);
  const f = civil(finISO);
  return (
    `${DIAS[i.getUTCDay()]} ${i.getUTCDate()} ${MESES_CORTOS[i.getUTCMonth()]} 00:00` +
    ` → ${DIAS[f.getUTCDay()]} ${f.getUTCDate()} ${MESES_CORTOS[f.getUTCMonth()]} 23:59`
  );
}

/** «sáb 12», para los chips de días. */
export function etiquetaDiaCorto(dateISO: string): string {
  const d = civil(dateISO);
  return `${DIAS_CORTOS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/**
 * «16 de septiembre de 2026 a las 00:00 h».
 *
 * `releaseAt` es un INSTANTE, no una fecha civil: hay que llevarlo a la zona de
 * negocio o en un navegador con otro huso la apertura parecería otro día.
 */
export function etiquetaInstante(instanteISO: string, zonaHoraria: string): string {
  const z = new TZDate(new Date(instanteISO).getTime(), zonaHoraria);
  return (
    `${z.getDate()} de ${MESES[z.getMonth()]} de ${z.getFullYear()} ` +
    `a las ${dos(z.getHours())}:${dos(z.getMinutes())} h`
  );
}

/** «sáb 12 y dom 13» · «sáb 12, dom 13 y lun 14». */
export function unirConY(partes: readonly string[]): string {
  if (partes.length === 0) return "";
  if (partes.length === 1) return partes[0];
  return `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}

/* -------------------------------------------------------------------------- */
/* Cuenta regresiva                                                            */
/* -------------------------------------------------------------------------- */

/** Menos de esto y la apertura deja de ser una fecha para volverse una espera. */
const UMBRAL_CUENTA_REGRESIVA_MS = 48 * 60 * 60 * 1000;

function textoRestante(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const segundos = total % 60;
  if (horas > 0) return `${horas} h ${dos(minutos)} min ${dos(segundos)} s`;
  if (minutos > 0) return `${minutos} min ${dos(segundos)} s`;
  return `${segundos} s`;
}

/**
 * Cuenta atrás hasta la apertura.
 *
 * EL RELOJ QUE MANDA ES EL DEL SERVIDOR: el punto de partida es lo que faltaba
 * en el instante que el servidor puso en el render. Lo único que aporta el
 * navegador es cuánto tiempo ha PASADO desde entonces, y para eso se usa
 * `performance.now()` —milisegundos desde que se cargó la página— en lugar de
 * `Date.now()`: es monótono y no lo mueve un reloj de sistema mal puesto ni un
 * cambio de horario a media espera.
 *
 * Importa porque el error tiene un lado peligroso: si la cuenta dijera "ya
 * abrió" antes de tiempo, quien pulsara se llevaría un rechazo del servidor —lo
 * peor que puede pasar a las 00:00 de un día de apertura (§07)—. Con este
 * cálculo el sesgo es el contrario: incluye el viaje de red, así que la cuenta
 * se queda unos milisegundos larga.
 *
 * La primera corrección se programa a 0 ms y no en el cuerpo del efecto para
 * cubrir el caso de la pestaña abierta desde hace rato: el valor inicial
 * heredaría la antigüedad del render y aquí se pone al día en el siguiente
 * ciclo, antes de que se vea.
 */
function CuentaRegresiva({
  objetivoMs,
  ahoraServidorMs,
}: {
  objetivoMs: number;
  ahoraServidorMs: number;
}) {
  const [restanteMs, setRestanteMs] = useState(objetivoMs - ahoraServidorMs);

  useEffect(() => {
    const base = objetivoMs - ahoraServidorMs;
    const actualizar = () => setRestanteMs(base - performance.now());
    const inmediato = window.setTimeout(actualizar, 0);
    const id = window.setInterval(actualizar, 1000);
    return () => {
      window.clearTimeout(inmediato);
      window.clearInterval(id);
    };
  }, [objetivoMs, ahoraServidorMs]);

  if (restanteMs <= 0) {
    return (
      <span className="font-medium text-foreground">
        Ya abrió. Recarga la página para tomarla.
      </span>
    );
  }

  return (
    <span aria-live="off" className="font-mono font-medium text-foreground">
      {textoRestante(restanteMs)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Diálogo                                                                     */
/* -------------------------------------------------------------------------- */

export interface ReserveDialogProps {
  /** Semana a la que se refiere el diálogo; `null` cuando no hay ninguna. */
  semana: WeekView | null;
  abierto: boolean;
  onAbiertoChange: (abierto: boolean) => void;
  /** Confirma la reserva. El motivo solo viaja en el modo excepción. */
  onConfirmar: (motivoExcepcion?: string) => void;
  /** Hay una operación en vuelo: se bloquea el botón para no duplicarla. */
  pendiente: boolean;
  /**
   * El visor puede saltarse la ventana de apertura (superusuaria). No es una
   * decisión de la interfaz: el servicio la revalida y exige el motivo.
   */
  puedeExcepcion: boolean;
  /** Hoy en la zona de negocio, `yyyy-MM-dd`. */
  hoyISO: string;
  zonaHoraria: string;
  /** Instante del servidor al renderizar la página, en ISO. */
  ahoraServidorISO: string;
}

export function ReserveDialog({
  semana,
  abierto,
  onAbiertoChange,
  onConfirmar,
  pendiente,
  puedeExcepcion,
  hoyISO,
  zonaHoraria,
  ahoraServidorISO,
}: ReserveDialogProps) {
  const [motivo, setMotivo] = useState("");

  // El motivo no puede sobrevivir a la semana: escribirlo para una y que
  // aparezca en otra sería un accidente esperando a pasar en la bitácora.
  // Se ajusta comparando DURANTE EL RENDER —el patrón que React recomienda para
  // reaccionar a un cambio de props— y no con un efecto, que provocaría un
  // render extra con el texto viejo todavía en pantalla.
  const claveActual = abierto ? (semana?.startDate ?? null) : null;
  const [claveVista, setClaveVista] = useState(claveActual);
  if (claveVista !== claveActual) {
    setClaveVista(claveActual);
    if (motivo !== "") setMotivo("");
  }

  if (!semana) return null;

  const programada = semana.availability === "PROGRAMADA";
  const enCurso = semana.availability === "EN_CURSO";
  const rango = etiquetaRangoExacto(semana.startDate, semana.endDate);
  const diasRestantes = diffDaysISO(hoyISO, semana.endDate) + 1;

  // La distancia hasta la apertura se mide contra el reloj del SERVIDOR, no
  // contra `Date.now()`: además de ser la hora buena, mantiene el render puro.
  const ahoraServidorMs = Date.parse(ahoraServidorISO);
  const aperturaMs = semana.releaseAt ? Date.parse(semana.releaseAt) : null;
  const faltaPoco =
    aperturaMs !== null &&
    aperturaMs - ahoraServidorMs < UMBRAL_CUENTA_REGRESIVA_MS;

  // Con excepción, el motivo es obligatorio: es lo que la bitácora guardará
  // como explicación de por qué se tomó una semana que aún no abría.
  const excepcionLista = motivo.trim().length > 0;
  const puedeConfirmar =
    !pendiente && (!programada || (puedeExcepcion && excepcionLista));

  return (
    <Dialog open={abierto} onOpenChange={onAbiertoChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {programada ? (
              <Lock className="size-4 text-muted-foreground" aria-hidden />
            ) : (
              <CalendarCheck className="size-4 text-muted-foreground" aria-hidden />
            )}
            {programada ? "Esta semana todavía no abre" : "Reservar esta semana"}
          </DialogTitle>
          <DialogDescription className="text-base font-medium text-foreground">
            {rango}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {programada && semana.releaseAt ? (
            <div className="flex flex-col gap-1 rounded-lg bg-muted/60 p-3">
              <p className="text-muted-foreground">
                Se habilita el{" "}
                <span className="font-medium text-foreground">
                  {etiquetaInstante(semana.releaseAt, zonaHoraria)}
                </span>
                .
              </p>
              {faltaPoco && aperturaMs !== null ? (
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="size-3.5" aria-hidden />
                  Abre en{" "}
                  <CuentaRegresiva
                    objetivoMs={aperturaMs}
                    ahoraServidorMs={ahoraServidorMs}
                  />
                </p>
              ) : null}
            </div>
          ) : null}

          {enCurso ? (
            <p className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-muted-foreground">
              <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                La semana ya empezó:{" "}
                <span className="font-medium text-foreground">
                  {diasRestantes === 1
                    ? "queda 1 día"
                    : `quedan ${diasRestantes} días`}
                </span>
                , no los siete completos.
              </span>
            </p>
          ) : null}

          {!programada ? (
            <p className="flex items-start gap-2 text-muted-foreground">
              <Mail className="mt-0.5 size-4 shrink-0" aria-hidden />
              Al confirmar se avisará por correo a todas las personas de la casa.
            </p>
          ) : null}

          {programada && puedeExcepcion ? (
            <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-[var(--wb-closed-bd,#a16207)] p-3">
              <p className="flex items-start gap-2 text-muted-foreground">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-[var(--wb-closed-fg,#7a4a05)] dark:text-[var(--wb-closed-fg,#efc257)]"
                  aria-hidden
                />
                Puedes tomarla antes de la apertura. La excepción y su motivo
                quedan en la bitácora.
              </p>
              <Label htmlFor="motivo-excepcion" className="mt-1">
                Motivo (obligatorio)
              </Label>
              <Textarea
                id="motivo-excepcion"
                value={motivo}
                onChange={(evento) => setMotivo(evento.target.value)}
                maxLength={500}
                rows={2}
                placeholder="Por qué se reserva antes de tiempo"
                disabled={pendiente}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => onAbiertoChange(false)}
            disabled={pendiente}
          >
            {programada && !puedeExcepcion ? "Entendido" : "Cancelar"}
          </Button>
          {!programada || puedeExcepcion ? (
            <Button
              type="button"
              size="lg"
              onClick={() => onConfirmar(programada ? motivo.trim() : undefined)}
              disabled={!puedeConfirmar}
            >
              {pendiente
                ? "Reservando…"
                : programada
                  ? "Reservar de todos modos"
                  : "Confirmar reserva"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
