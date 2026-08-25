"use client";

/**
 * Notas de mantenimiento de una propiedad: crear, editar y borrar.
 *
 * Son informativas y NO bloquean reservas (decisión de producto): quien reserve
 * una semana con mantenimiento anunciado lo hace sabiéndolo. Por eso el diálogo
 * no advierte de conflictos ni pide confirmaciones raras — solo un rango y un
 * texto—, y por eso tampoco disparan avisos por correo.
 *
 * Es la única entidad del modelo que se borra de verdad: una nota vieja no es
 * historia que haya que conservar.
 */

import { useState, useTransition } from "react";
import { Loader2, Pencil, Plus, Trash2, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
  actualizarNotaMantenimientoAction,
  borrarNotaMantenimientoAction,
  crearNotaMantenimientoAction,
} from "@/server/actions/admin-actions";
import type { MaintenanceNoteRow } from "@/server/admin/maintenance";

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

export interface MaintenanceNotesProps {
  propiedad: { id: string; name: string };
  notas: MaintenanceNoteRow[];
}

/** Sección con la lista de notas y sus dos diálogos. */
export function MaintenanceNotes({ propiedad, notas }: MaintenanceNotesProps) {
  const [editando, setEditando] = useState<MaintenanceNoteRow | null>(null);
  const [creando, setCreando] = useState(false);
  const [borrando, setBorrando] = useState<MaintenanceNoteRow | null>(null);
  const [apertura, setApertura] = useState(0);

  function abrirAlta() {
    setApertura((n) => n + 1);
    setEditando(null);
    setCreando(true);
  }

  function abrirEdicion(nota: MaintenanceNoteRow) {
    setApertura((n) => n + 1);
    setCreando(false);
    setEditando(nota);
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Se ven en el calendario de todo el mundo y no impiden reservar.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={abrirAlta}>
          <Plus aria-hidden />
          Nueva nota
        </Button>
      </div>

      {notas.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Sin notas de mantenimiento en esta propiedad.
        </p>
      ) : (
        <ul className="grid gap-2">
          {notas.map((nota) => (
            <li
              key={nota.id}
              className="grid gap-2 rounded-xl border border-border bg-card p-3 sm:flex sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--wb-maint-fg)]">
                  <Wrench className="size-3.5" aria-hidden />
                  {rangoCorto(nota.startDate, nota.endDate)}
                </p>
                <p className="mt-0.5 text-sm break-words">{nota.note}</p>
              </div>

              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => abrirEdicion(nota)}
                >
                  <Pencil aria-hidden />
                  Editar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setBorrando(nota)}
                >
                  <Trash2 aria-hidden />
                  Borrar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <MaintenanceDialog
        key={`nota-${editando?.id ?? "nueva"}-${apertura}`}
        propiedad={propiedad}
        nota={editando}
        abierto={creando || editando !== null}
        onAbiertoChange={(abierto) => {
          if (!abierto) {
            setCreando(false);
            setEditando(null);
          }
        }}
      />

      <BorrarNotaDialog
        key={`borrar-${borrando?.id ?? "off"}`}
        nota={borrando}
        onAbiertoChange={(abierto) => {
          if (!abierto) setBorrando(null);
        }}
      />
    </div>
  );
}

export interface MaintenanceDialogProps {
  propiedad: { id: string; name: string };
  /** `null` = nota nueva. */
  nota: MaintenanceNoteRow | null;
  abierto: boolean;
  onAbiertoChange: (abierto: boolean) => void;
}

export function MaintenanceDialog({
  propiedad,
  nota,
  abierto,
  onAbiertoChange,
}: MaintenanceDialogProps) {
  const esAlta = nota === null;

  const [desde, setDesde] = useState(nota?.startDate ?? "");
  const [hasta, setHasta] = useState(nota?.endDate ?? "");
  const [texto, setTexto] = useState(nota?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [enviando, iniciar] = useTransition();

  // Comprobación de cortesía: el mismo CHECK existe en la base y el mismo
  // rechazo en el servicio. Aquí solo evita gastar un viaje.
  const rangoInvertido = Boolean(desde && hasta && desde > hasta);

  function enviar() {
    setError(null);

    iniciar(async () => {
      const resultado = esAlta
        ? await crearNotaMantenimientoAction({
            propertyId: propiedad.id,
            startDate: desde,
            endDate: hasta,
            note: texto,
          })
        : await actualizarNotaMantenimientoAction(nota.id, {
            startDate: desde,
            endDate: hasta,
            note: texto,
          });

      if (!resultado.ok) {
        setError(resultado.message);
        return;
      }
      onAbiertoChange(false);
    });
  }

  return (
    <Dialog open={abierto} onOpenChange={onAbiertoChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(evento) => {
            evento.preventDefault();
            enviar();
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{esAlta ? "Nueva nota" : "Editar nota"}</DialogTitle>
            <DialogDescription>
              Mantenimiento en «{propiedad.name}». La nota informa, no bloquea la
              semana.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="nota-desde">Desde</Label>
              <Input
                id="nota-desde"
                type="date"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
                required
                className="h-9 w-40"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nota-hasta">Hasta</Label>
              <Input
                id="nota-hasta"
                type="date"
                value={hasta}
                onChange={(e) => setHasta(e.target.value)}
                required
                aria-invalid={rangoInvertido || undefined}
                className="h-9 w-40"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="nota-texto">Nota</Label>
            <Textarea
              id="nota-texto"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={3}
              required
              minLength={3}
              maxLength={500}
              placeholder="Pintan la fachada; el acceso principal estará cerrado."
            />
          </div>

          <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
            {rangoInvertido ? "La nota termina antes de empezar." : error}
          </p>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button type="submit" disabled={enviando || rangoInvertido}>
              {enviando ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {esAlta ? "Crear nota" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BorrarNotaDialog({
  nota,
  onAbiertoChange,
}: {
  nota: MaintenanceNoteRow | null;
  onAbiertoChange: (abierto: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [enviando, iniciar] = useTransition();

  if (!nota) return null;

  function confirmar() {
    if (!nota) return;
    setError(null);

    iniciar(async () => {
      const resultado = await borrarNotaMantenimientoAction(nota.id);

      if (!resultado.ok) {
        setError(resultado.message);
        return;
      }
      onAbiertoChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onAbiertoChange}>
      <DialogContent>
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Borrar la nota</DialogTitle>
            <DialogDescription>
              {rangoCorto(nota.startDate, nota.endDate)} · {nota.note}
            </DialogDescription>
          </DialogHeader>

          <p className="text-sm text-muted-foreground">
            Se borra de verdad y no se puede deshacer. Dejará de verse en el
            calendario de inmediato.
          </p>

          <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
            {error}
          </p>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button type="button" variant="destructive" disabled={enviando} onClick={confirmar}>
              {enviando ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Borrar
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * «3 – 9 oct 2026». Fechas CIVILES ancladas a UTC: con hora local, la misma
 * cadena `yyyy-MM-dd` daría un día distinto según dónde esté quien mira.
 */
function rangoCorto(inicioISO: string, finISO: string): string {
  const inicio = new Date(`${inicioISO}T00:00:00.000Z`);
  const fin = new Date(`${finISO}T00:00:00.000Z`);

  const mismoMes =
    inicio.getUTCFullYear() === fin.getUTCFullYear() &&
    inicio.getUTCMonth() === fin.getUTCMonth();

  const cabeza = mismoMes
    ? `${inicio.getUTCDate()}`
    : `${inicio.getUTCDate()} ${MESES_CORTOS[inicio.getUTCMonth()]}`;

  return `${cabeza} – ${fin.getUTCDate()} ${MESES_CORTOS[fin.getUTCMonth()]} ${fin.getUTCFullYear()}`;
}
