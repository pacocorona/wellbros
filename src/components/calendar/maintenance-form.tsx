"use client";

/**
 * Anotar mantenimiento en los días de UNA semana, desde el propio calendario.
 *
 * Sigue el patrón del formulario de cesión (`grant-form.tsx`) porque es el
 * mismo gesto: la semana se despliega en siete fichas viernes→jueves y se tocan
 * las que hacen falta. Ahí acaba el parecido; lo que cambia es qué se guarda.
 *
 * DÍAS SALTEADOS. Si se eligen días no contiguos —sábado y martes— NO se crea
 * una sola nota del sábado al martes: se crean DOS, una por tramo continuo. El
 * modelo guarda rangos, así que una nota del sábado al martes pintaría también
 * domingo y lunes en el calendario de todo el mundo, anunciando una obra que
 * esos días no existe. El resumen de abajo lo dice con todas las letras antes
 * de guardar, para que ver dos entradas en Configuración no sorprenda a nadie.
 *
 * Las fichas de los días que YA tienen nota se muestran marcadas y con su nota
 * a la vista al posarse encima: es la única defensa contra anotar dos veces la
 * misma obra sin darse cuenta.
 *
 * Este formulario NO reemplaza a Configuración → Propiedades, que sigue siendo
 * donde las notas se editan y se borran. Es un atajo.
 */

import { useMemo, useState } from "react";
import { Check, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  addDaysISO,
  agruparDiasEnRangos,
  type RangoDeDias,
} from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";
import { crearMantenimientoDesdeCalendarioAction } from "@/server/actions/calendar-actions";

import { NotasGlobo } from "./maintenance-marker";
import { etiquetaDiaCorto, unirConY } from "./reserve-dialog";
import { MAINTENANCE_SKIN, type MaintenanceView, type WeekView } from "./types";

/**
 * Límites del texto. Son los del servicio (`textoNotaSchema` en
 * src/server/admin/maintenance.ts), copiados aquí para poder avisar ANTES del
 * viaje; quien manda sigue siendo el servidor, que los revalida.
 */
const NOTA_MINIMA = 3;
const NOTA_MAXIMA = 500;

/** Días de una semana: el selector no puede salirse de la semana elegida. */
const DIAS_POR_SEMANA = 7;

/** «sáb 5» o «sáb 5 al lun 7»: cómo se llamará cada nota que se va a crear. */
function etiquetaTramo(tramo: RangoDeDias): string {
  return tramo.startDate === tramo.endDate
    ? etiquetaDiaCorto(tramo.startDate)
    : `${etiquetaDiaCorto(tramo.startDate)} al ${etiquetaDiaCorto(tramo.endDate)}`;
}

interface Dia {
  iso: string;
  /** Notas que ya cubren el día. Vacío si está limpio. */
  notas: MaintenanceView[];
}

export interface MaintenanceFormProps {
  /** Propiedad en pantalla: de ella cuelga la nota. */
  propiedadId: string;
  /** Semana que acota el selector. Sus siete días son los únicos elegibles. */
  semana: WeekView;
  /**
   * Notas ya visibles en la retícula. Solo sirven para marcar fichas; el
   * calendario del mes puede no traer las de una semana que asoma por el borde,
   * y eso no rompe nada: como mucho no se avisa de una duplicidad.
   */
  notas: MaintenanceView[];
  /** Vuelve al selector de acción sin guardar nada. */
  onVolver: () => void;
  /** Se guardó bien: quien nos monta cierra el diálogo. */
  onGuardado: () => void;
}

export function MaintenanceForm({
  propiedadId,
  semana,
  notas,
  onVolver,
  onGuardado,
}: MaintenanceFormProps) {
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [texto, setTexto] = useState("");
  const [guardando, setGuardando] = useState(false);

  const dias = useMemo<Dia[]>(
    () =>
      Array.from({ length: DIAS_POR_SEMANA }, (_, i) => {
        const iso = addDaysISO(semana.startDate, i);
        return {
          iso,
          notas: notas.filter((n) => n.startDate <= iso && iso <= n.endDate),
        };
      }),
    [semana.startDate, notas],
  );

  // Los tramos se calculan con la MISMA función que usa el servicio, así que el
  // resumen no puede prometer un número de notas distinto del que se creará.
  const tramos = useMemo(
    () => (seleccion.length > 0 ? agruparDiasEnRangos(seleccion) : []),
    [seleccion],
  );

  const alternar = (iso: string) => {
    setSeleccion((previa) =>
      previa.includes(iso)
        ? previa.filter((d) => d !== iso)
        : [...previa, iso].sort(),
    );
  };

  const notaLista = texto.trim().length >= NOTA_MINIMA;
  const puedeGuardar = !guardando && seleccion.length > 0 && notaLista;

  const guardar = async () => {
    if (!puedeGuardar) return;

    setGuardando(true);
    try {
      const resultado = await crearMantenimientoDesdeCalendarioAction(
        propiedadId,
        seleccion,
        texto.trim(),
      );

      if (resultado.ok) {
        const creadas = resultado.datos.notas.length;
        toast.success(
          creadas === 1
            ? "Nota de mantenimiento creada"
            : `${creadas} notas de mantenimiento creadas`,
          {
            description: `${unirConY(
              resultado.datos.notas.map(etiquetaTramo),
            )}. Se ven en el calendario de toda la casa.`,
          },
        );
        onGuardado();
        return;
      }

      toast.error(resultado.message);
    } catch {
      // Falló el viaje, no la regla: no se guardó nada y se puede reintentar.
      toast.error("No pudimos guardar la nota", {
        description: "Revisa tu conexión y vuelve a intentarlo.",
      });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="mantenimiento-titulo">
      <div>
        <h3 id="mantenimiento-titulo" className="text-sm font-medium">
          Días con mantenimiento
        </h3>
        <p className="text-sm text-muted-foreground">
          Marca los días de esta semana. La nota se ve en el calendario de todos
          y no bloquea reservas.
        </p>
      </div>

      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label="Días de la semana"
      >
        {dias.map((dia) => {
          const elegido = seleccion.includes(dia.iso);
          const tieneNota = dia.notas.length > 0;

          const ficha = (
            <button
              key={dia.iso}
              type="button"
              disabled={guardando}
              aria-pressed={elegido}
              aria-label={
                tieneNota
                  ? `${etiquetaDiaCorto(dia.iso)}, ya tiene ${
                      dia.notas.length === 1
                        ? "una nota de mantenimiento"
                        : `${dia.notas.length} notas de mantenimiento`
                    }`
                  : undefined
              }
              onClick={() => alternar(dia.iso)}
              className={cn(
                "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
                elegido
                  ? "border-transparent bg-primary text-primary-foreground"
                  : tieneNota
                    ? MAINTENANCE_SKIN.chip
                    : "border-input hover:bg-muted",
              )}
            >
              {/* Dos marcas distintas y no un color más (§04): la palomita dice
                  «lo estás eligiendo» y la llave «esto ya estaba anotado». Un
                  día puede llevar las dos. */}
              {elegido ? <Check className="size-3.5" aria-hidden /> : null}
              {tieneNota ? <Wrench className="size-3.5" aria-hidden /> : null}
              {etiquetaDiaCorto(dia.iso)}
            </button>
          );

          if (!tieneNota) return ficha;

          // Mismo globo que el punto del calendario, así que la nota que ya
          // existe también se lee con el dedo, no solo con el ratón.
          return (
            <NotasGlobo key={dia.iso} disparador={ficha} notas={dia.notas} />
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="nota-mantenimiento">Nota</Label>
          <span
            aria-hidden
            className={cn(
              "font-mono text-xs text-muted-foreground",
              texto.length >= NOTA_MAXIMA && "text-foreground",
            )}
          >
            {texto.length}/{NOTA_MAXIMA}
          </span>
        </div>
        <Textarea
          id="nota-mantenimiento"
          value={texto}
          onChange={(evento) => setTexto(evento.target.value)}
          maxLength={NOTA_MAXIMA}
          rows={3}
          placeholder="Qué se va a hacer esos días"
          disabled={guardando}
        />
      </div>

      {/* El resumen es la última oportunidad de darse cuenta de un toque
          equivocado, y el único sitio donde se explica por qué a veces salen
          varias notas. `aria-live` lo anuncia sin ir a buscarlo. */}
      <div aria-live="polite" className="flex min-h-5 flex-col gap-1">
        {tramos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Elige al menos un día de la semana.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {tramos.length === 1
              ? `Se creará 1 nota: ${etiquetaTramo(tramos[0])}.`
              : `Se crearán ${tramos.length} notas: ${unirConY(
                  tramos.map(etiquetaTramo),
                )}.`}
          </p>
        )}
        {tramos.length > 1 ? (
          <p className="text-sm text-muted-foreground">
            Elegiste días salteados: cada tramo va en su propia nota para no
            anunciar obra en los días que dejaste fuera.
          </p>
        ) : null}
        {seleccion.length > 0 && !notaLista ? (
          <p className="text-sm text-muted-foreground">
            Escribe la nota: al menos {NOTA_MINIMA} caracteres.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={guardando}
          onClick={onVolver}
        >
          Volver
        </Button>
        <Button type="button" size="lg" disabled={!puedeGuardar} onClick={guardar}>
          {guardando ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Wrench className="size-4" aria-hidden />
          )}
          {guardando
            ? "Guardando…"
            : tramos.length > 1
              ? `Guardar ${tramos.length} notas`
              : "Guardar nota"}
        </Button>
      </div>
    </section>
  );
}
