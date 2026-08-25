"use client";

/**
 * Gestor de semanas: abrir en lote, cerrar y reabrir.
 *
 * Es la pantalla que más se usa del módulo de administración, así que la
 * apertura en lote va primero y el resumen previo se calcula EN EL CLIENTE, sin
 * pedir permiso al servidor: quien mueve una fecha ve al instante cuántas
 * semanas caen y cuántas ya estaban. El servidor vuelve a hacer la misma cuenta
 * al recibir la orden —es él quien manda—, pero para elegir el rango no hace
 * falta esperar un viaje por cada tecla.
 *
 * Toda la aritmética de fechas se hace sobre fechas CIVILES ancladas a UTC
 * (`2026-09-04T00:00:00Z`), nunca con `new Date(y, m, d)`. Si se usara la zona
 * del navegador, la misma cadena daría un día distinto según dónde esté quien
 * mira, y el resumen no coincidiría con lo que abre el servidor.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Ban,
  CalendarPlus,
  CircleCheck,
  Loader2,
  LockOpen,
  TriangleAlert,
  User,
  type LucideIcon,
} from "lucide-react";

import { AVAILABILITY_SKIN } from "@/components/calendar/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SlotStatus } from "@/generated/prisma/enums";
import { monthTitle } from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";
import {
  abrirSemanasAction,
  cerrarSemanaAction,
  reabrirSemanaAction,
} from "@/server/actions/admin-actions";

/**
 * Semana tal como la ve esta pantalla. La arma el servidor (ver la página) para
 * que las etiquetas en español se generen una sola vez y del mismo modo que en
 * los correos.
 */
export interface SemanaAdmin {
  slotId: string;
  /** Viernes de inicio, `yyyy-MM-dd`. */
  startDate: string;
  /** Jueves final, `yyyy-MM-dd`. */
  endDate: string;
  /** «viernes 2 al jueves 8 de octubre de 2026». */
  label: string;
  status: SlotStatus;
  /** Nombre de quien tiene la reserva ACTIVA, si la hay. */
  reservedByName: string | null;
}

export interface PropiedadElegible {
  id: string;
  name: string;
  isActive: boolean;
}

export interface SlotManagerProps {
  propiedades: PropiedadElegible[];
  /** Propiedad elegida, tomada de `?propiedad=` en la URL. */
  seleccionada: PropiedadElegible | null;
  /** TODAS las semanas de la propiedad elegida, de la más antigua a la más nueva. */
  semanas: SemanaAdmin[];
  /** Hoy en la zona de negocio, `yyyy-MM-dd`. Llega del servidor: nunca del reloj local. */
  hoyISO: string;
}

/**
 * Tope por tanda. Es el mismo número que aplica `openWeeks`: se repite aquí solo
 * para poder avisar ANTES de enviar, no para decidir nada. Si cambia allá, cambia
 * aquí (el servidor sigue siendo quien rechaza).
 */
const MAX_SEMANAS_POR_TANDA = 104;

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

export function SlotManager({
  propiedades,
  seleccionada,
  semanas,
  hoyISO,
}: SlotManagerProps) {
  const router = useRouter();

  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [verPasadas, setVerPasadas] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [cerrando, setCerrando] = useState<SemanaAdmin | null>(null);
  /** Slot con una operación en vuelo: solo se bloquean sus propios botones. */
  const [enCurso, setEnCurso] = useState<string | null>(null);
  const [abriendo, iniciarApertura] = useTransition();
  const [cambiando, iniciarCambio] = useTransition();

  const abiertas = useMemo(
    () => new Set(semanas.map((s) => s.startDate)),
    [semanas],
  );

  const resumen = useMemo(
    () => calcularResumen(desde, hasta, abiertas),
    [desde, hasta, abiertas],
  );

  const visibles = useMemo(
    () => (verPasadas ? semanas : semanas.filter((s) => s.endDate >= hoyISO)),
    [semanas, verPasadas, hoyISO],
  );

  const porMes = useMemo(() => agruparPorMes(visibles), [visibles]);
  const pasadas = semanas.length - semanas.filter((s) => s.endDate >= hoyISO).length;

  function abrirLote() {
    if (!seleccionada || !resumen || resumen.tipo !== "listo") return;
    setAviso(null);

    iniciarApertura(async () => {
      const resultado = await abrirSemanasAction(seleccionada.id, desde, hasta);

      if (!resultado.ok) {
        setAviso({ tono: "error", texto: resultado.message });
        return;
      }

      const { created, alreadyOpen, notified } = resultado.data;
      setAviso({
        tono: created > 0 ? "exito" : "neutro",
        texto:
          created === 0
            ? `No había nada que abrir: los ${alreadyOpen} viernes del rango ya estaban abiertos.`
            : `Se ${created === 1 ? "abrió 1 semana" : `abrieron ${created} semanas`}` +
              (alreadyOpen > 0 ? `; ${alreadyOpen} ya estaban abiertas` : "") +
              `. Avisos encolados: ${notified}.`,
      });
      setDesde("");
      setHasta("");
    });
  }

  function cerrarDirecto(semana: SemanaAdmin) {
    setAviso(null);
    setEnCurso(semana.slotId);

    iniciarCambio(async () => {
      const resultado = await cerrarSemanaAction(semana.slotId);
      setEnCurso(null);

      if (!resultado.ok) {
        // Si entre el render y el clic alguien reservó la semana, el servidor
        // responde con este código en vez de cancelar por sorpresa: se pide
        // confirmación con motivo, que es lo que exige el producto.
        if (resultado.code === "SLOT_HAS_ACTIVE_RESERVATION") {
          setCerrando(semana);
          return;
        }
        setAviso({ tono: "error", texto: resultado.message });
        return;
      }

      setAviso({
        tono: "neutro",
        texto: `Semana cerrada: ${semana.label}. Ya no se ofrece en el calendario.`,
      });
    });
  }

  function reabrir(semana: SemanaAdmin) {
    setAviso(null);
    setEnCurso(semana.slotId);

    iniciarCambio(async () => {
      const resultado = await reabrirSemanaAction(semana.slotId);
      setEnCurso(null);

      if (!resultado.ok) {
        setAviso({ tono: "error", texto: resultado.message });
        return;
      }

      setAviso({
        tono: "exito",
        texto: `Semana reabierta: ${semana.label}. Avisos encolados: ${resultado.data.notified}.`,
      });
    });
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="gestor-propiedad">Propiedad</Label>
        <Select
          items={propiedades.map((p) => ({ label: p.name, value: p.id }))}
          value={seleccionada?.id ?? null}
          onValueChange={(valor) => {
            if (!valor) return;
            // La elección viaja en la URL para que el servidor pueda traer las
            // semanas de esa propiedad y para que el enlace sea compartible.
            router.push(`/config/propiedades?propiedad=${valor}`, { scroll: false });
          }}
        >
          <SelectTrigger id="gestor-propiedad" className="h-9 w-full sm:w-80">
            <SelectValue placeholder="Elige una propiedad" />
          </SelectTrigger>
          <SelectContent>
            {propiedades.map((propiedad) => (
              <SelectItem key={propiedad.id} value={propiedad.id}>
                {propiedad.name}
                {propiedad.isActive ? "" : " (desactivada)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!seleccionada ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Elige una propiedad para abrir, cerrar y reabrir sus semanas.
        </p>
      ) : (
        <>
          {!seleccionada.isActive ? (
            <p className="flex items-start gap-2 rounded-lg border border-[var(--wb-closed-bd)] bg-[var(--wb-closed-bg)] px-3 py-2 text-sm text-[var(--wb-closed-fg)]">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                «{seleccionada.name}» está desactivada: no se pueden abrir semanas
                hasta reactivarla, porque no aparece en el calendario de nadie.
              </span>
            </p>
          ) : null}

          <section className="grid gap-3 rounded-xl border border-border bg-card p-4">
            <div>
              <h3 className="text-sm font-semibold">Abrir semanas en lote</h3>
              <p className="text-sm text-muted-foreground">
                Se abren todos los viernes comprendidos en el rango. Repetir un
                rango no rompe nada: los que ya existen se dejan como están.
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lote-desde">Desde</Label>
                <Input
                  id="lote-desde"
                  type="date"
                  value={desde}
                  onChange={(e) => setDesde(e.target.value)}
                  className="h-9 w-44"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lote-hasta">Hasta</Label>
                <Input
                  id="lote-hasta"
                  type="date"
                  value={hasta}
                  onChange={(e) => setHasta(e.target.value)}
                  className="h-9 w-44"
                />
              </div>

              <Button
                type="button"
                onClick={abrirLote}
                disabled={
                  abriendo || !seleccionada.isActive || resumen?.tipo !== "listo"
                }
                className="h-9"
              >
                {abriendo ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <CalendarPlus aria-hidden />
                )}
                Abrir semanas
              </Button>
            </div>

            <ResumenPrevio resumen={resumen} />
          </section>

          {aviso ? <MensajeAviso aviso={aviso} /> : null}

          <section className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                Semanas de {seleccionada.name}
              </h3>

              {pasadas > 0 ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="ver-pasadas"
                    checked={verPasadas}
                    onCheckedChange={(marcado) => setVerPasadas(marcado)}
                  />
                  <Label htmlFor="ver-pasadas" className="font-normal text-muted-foreground">
                    Mostrar semanas pasadas ({pasadas})
                  </Label>
                </div>
              ) : null}
            </div>

            {porMes.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                {semanas.length === 0
                  ? "Esta propiedad todavía no tiene semanas abiertas."
                  : "No queda ninguna semana por venir. Marca «Mostrar semanas pasadas» para ver las que ya terminaron."}
              </p>
            ) : (
              porMes.map((grupo) => (
                <div key={grupo.mes} className="grid gap-2">
                  <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {monthTitle(grupo.mes)}
                  </h4>

                  <ul className="grid gap-1.5">
                    {grupo.semanas.map((semana) => (
                      <li
                        key={semana.slotId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p
                            className={cn(
                              "text-sm",
                              semana.endDate < hoyISO && "text-muted-foreground",
                            )}
                          >
                            {semana.label}
                          </p>
                          <EstadoSemana semana={semana} pasada={semana.endDate < hoyISO} />
                        </div>

                        <div className="flex shrink-0 gap-1">
                          {semana.status === "CLOSED" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={cambiando && enCurso === semana.slotId}
                              onClick={() => reabrir(semana)}
                            >
                              <LockOpen aria-hidden />
                              Reabrir
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={cambiando && enCurso === semana.slotId}
                              onClick={() =>
                                semana.reservedByName
                                  ? setCerrando(semana)
                                  : cerrarDirecto(semana)
                              }
                            >
                              <Ban aria-hidden />
                              Cerrar
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </>
      )}

      <CerrarConReservaDialog
        key={cerrando?.slotId ?? "off"}
        semana={cerrando}
        onCerrado={(texto) => {
          setCerrando(null);
          setAviso({ tono: "neutro", texto });
        }}
        onAbiertoChange={(abierto) => {
          if (!abierto) setCerrando(null);
        }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════ resumen previo

type Resumen =
  | { tipo: "error"; texto: string }
  | { tipo: "nada"; texto: string }
  | {
      tipo: "listo";
      nuevas: number;
      yaAbiertas: number;
      primera: string;
      ultima: string;
    };

/**
 * Cuenta los viernes del rango y los reparte entre nuevos y ya existentes.
 *
 * El conjunto `abiertas` trae TODOS los viernes de la propiedad (la página no
 * recorta por fechas), así que «ya estaban abiertas» es exacto incluso cuando
 * el rango cae fuera de lo que se está mostrando en la lista.
 */
function calcularResumen(
  desde: string,
  hasta: string,
  abiertas: ReadonlySet<string>,
): Resumen | null {
  if (!desde || !hasta) return null;
  if (desde > hasta) {
    return { tipo: "error", texto: "El rango termina antes de empezar." };
  }

  const viernes = viernesEnRango(desde, hasta);
  if (viernes.length === 0) {
    return { tipo: "nada", texto: "No hay ningún viernes dentro de ese rango." };
  }
  if (viernes.length > MAX_SEMANAS_POR_TANDA) {
    return {
      tipo: "error",
      texto: `El rango cubre ${viernes.length} semanas y el máximo por tanda es ${MAX_SEMANAS_POR_TANDA}. Ábrelas en varios tramos.`,
    };
  }

  const nuevas = viernes.filter((v) => !abiertas.has(v));
  if (nuevas.length === 0) {
    return {
      tipo: "nada",
      texto: `Los ${viernes.length} viernes de ese rango ya están abiertos.`,
    };
  }

  return {
    tipo: "listo",
    nuevas: nuevas.length,
    yaAbiertas: viernes.length - nuevas.length,
    primera: nuevas[0],
    ultima: nuevas[nuevas.length - 1],
  };
}

function ResumenPrevio({ resumen }: { resumen: Resumen | null }) {
  if (!resumen) {
    return (
      <p className="text-sm text-muted-foreground">
        Elige las dos fechas para ver cuántas semanas se abrirían.
      </p>
    );
  }

  if (resumen.tipo === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        {resumen.texto}
      </p>
    );
  }

  if (resumen.tipo === "nada") {
    return <p className="text-sm text-muted-foreground">{resumen.texto}</p>;
  }

  return (
    <p aria-live="polite" className="text-sm">
      Se {resumen.nuevas === 1 ? "abrirá 1 semana" : `abrirán ${resumen.nuevas} semanas`},
      del <strong>{fechaCorta(resumen.primera)}</strong> al{" "}
      <strong>{fechaCorta(resumen.ultima)}</strong>
      {resumen.yaAbiertas > 0 ? (
        <span className="text-muted-foreground">
          ; {resumen.yaAbiertas}{" "}
          {resumen.yaAbiertas === 1 ? "ya estaba abierta" : "ya estaban abiertas"}
        </span>
      ) : null}
      .
    </p>
  );
}

// ═════════════════════════════════════ cerrar con reserva ACTIVA

function CerrarConReservaDialog({
  semana,
  onCerrado,
  onAbiertoChange,
}: {
  semana: SemanaAdmin | null;
  onCerrado: (texto: string) => void;
  onAbiertoChange: (abierto: boolean) => void;
}) {
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, iniciar] = useTransition();

  if (!semana) return null;

  const motivoLimpio = motivo.trim();

  function confirmar() {
    if (!semana) return;
    setError(null);

    iniciar(async () => {
      const resultado = await cerrarSemanaAction(semana.slotId, {
        forzar: true,
        motivo: motivoLimpio,
      });

      if (!resultado.ok) {
        setError(resultado.message);
        return;
      }

      const cancelada = resultado.data.cancelledReservation;
      onCerrado(
        cancelada
          ? `Semana cerrada y reserva de ${cancelada.ownerName} cancelada. Queda registrado en la bitácora.`
          : `Semana cerrada: ${semana.label}.`,
      );
    });
  }

  return (
    <Dialog open onOpenChange={onAbiertoChange}>
      <DialogContent className="sm:max-w-lg">
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Cerrar una semana reservada</DialogTitle>
            <DialogDescription>{semana.label}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 rounded-lg border border-[var(--wb-closed-bd)] bg-[var(--wb-closed-bg)] p-3 text-sm text-[var(--wb-closed-fg)]">
            <p className="flex items-start gap-2 font-medium">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {semana.reservedByName
                  ? `Esta semana la tiene reservada ${semana.reservedByName}.`
                  : "Esta semana tiene una reserva activa."}
              </span>
            </p>
            <ul className="ml-6 list-disc space-y-1 text-xs">
              <li>La reserva se cancelará y también los días ya cedidos.</li>
              <li>Se avisará por correo a quien la tenía y a quien recibió días.</li>
              <li>
                La semana quedará <strong>cerrada</strong>, no libre: no vuelve a
                ofrecerse hasta que la reabras.
              </li>
              <li>Todo queda en la bitácora con tu nombre y el motivo.</li>
            </ul>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="cierre-motivo">Motivo</Label>
            <Textarea
              id="cierre-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={3}
              maxLength={500}
              required
              aria-invalid={error ? true : undefined}
              placeholder="Por ejemplo: fumigación urgente de toda la casa."
            />
            <p className="text-xs text-muted-foreground">
              Obligatorio, al menos 5 caracteres. Lo leerá quien pierde la semana.
            </p>
          </div>

          <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
            {error}
          </p>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={enviando || motivoLimpio.length < 5}
              onClick={confirmar}
            >
              {enviando ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Cerrar y cancelar la reserva
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ══════════════════════════════════════════════════════ presentación

/**
 * Estado de la semana, con el mismo vocabulario visual del calendario: se
 * reutiliza `AVAILABILITY_SKIN` para que un chip «Reservada» aquí y allá tengan
 * el mismo color, el mismo icono y la misma palabra.
 */
function EstadoSemana({ semana, pasada }: { semana: SemanaAdmin; pasada: boolean }) {
  if (semana.status === "CLOSED") {
    return (
      <Chip clase={AVAILABILITY_SKIN.CERRADA.chip} Icono={Ban}>
        Cerrada
      </Chip>
    );
  }

  if (semana.reservedByName) {
    return (
      <Chip clase={AVAILABILITY_SKIN.RESERVADA.chip} Icono={User}>
        Reservada por {semana.reservedByName}
      </Chip>
    );
  }

  if (pasada) {
    return (
      <Chip clase={AVAILABILITY_SKIN.PASADA.chip} Icono={CircleCheck}>
        Pasada, sin reservar
      </Chip>
    );
  }

  return (
    <Chip clase={AVAILABILITY_SKIN.RESERVABLE.chip} Icono={CircleCheck}>
      Abierta
    </Chip>
  );
}

function Chip({
  clase,
  Icono,
  children,
}: {
  clase: string;
  Icono: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        clase,
      )}
    >
      <Icono className="size-3" aria-hidden />
      {children}
    </span>
  );
}

interface Aviso {
  tono: "exito" | "error" | "neutro";
  texto: string;
}

function MensajeAviso({ aviso }: { aviso: Aviso }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        aviso.tono === "error" && "border-destructive/40 text-destructive",
        aviso.tono === "exito" &&
          "border-[var(--wb-open-bd)] bg-[var(--wb-open-bg)] text-[var(--wb-open-fg)]",
        aviso.tono === "neutro" && "border-border bg-muted/60 text-muted-foreground",
      )}
    >
      {aviso.texto}
    </p>
  );
}

// ═════════════════════════════════════════════════ fechas civiles

/** `yyyy-MM-dd` → `Date` anclada a medianoche UTC. Nunca hora local. */
function civil(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function aISO(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/** «4 sep»: suficiente para un resumen; el año va aparte cuando hace falta. */
function fechaCorta(iso: string): string {
  const d = civil(iso);
  return `${d.getUTCDate()} ${MESES_CORTOS[d.getUTCMonth()]}`;
}

/**
 * Viernes comprendidos en `[desde, hasta]`, ambos incluidos.
 *
 * `getUTCDay() === 5` es viernes. Se avanza de siete en siete desde el primer
 * viernes: la misma cuenta que hace el servidor, que a su vez respeta el CHECK
 * de la base (`week_slots.start_date` siempre es viernes).
 */
function viernesEnRango(desde: string, hasta: string): string[] {
  const fin = civil(hasta).getTime();
  const cursor = civil(desde);
  cursor.setUTCDate(cursor.getUTCDate() + ((5 - cursor.getUTCDay() + 7) % 7));

  const salida: string[] = [];
  // El tope evita que un año mal tecleado («2926») cuelgue el navegador
  // recorriendo siglos: pasado el máximo, el resumen ya solo sirve para avisar.
  while (cursor.getTime() <= fin && salida.length <= MAX_SEMANAS_POR_TANDA) {
    salida.push(aISO(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return salida;
}

/** Agrupa por mes del viernes de inicio, conservando el orden de entrada. */
function agruparPorMes(
  semanas: SemanaAdmin[],
): Array<{ mes: string; semanas: SemanaAdmin[] }> {
  const grupos: Array<{ mes: string; semanas: SemanaAdmin[] }> = [];

  for (const semana of semanas) {
    const mes = semana.startDate.slice(0, 7);
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.mes === mes) ultimo.semanas.push(semana);
    else grupos.push({ mes, semanas: [semana] });
  }

  return grupos;
}
