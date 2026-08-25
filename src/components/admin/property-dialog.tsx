"use client";

/**
 * Diálogos de propiedades: alta/edición y encendido/apagado.
 *
 * El nombre es TEXTO LIBRE y es lo único que la gente lee en el combo del
 * calendario, así que editarlo es una operación de primera clase y no un detalle
 * escondido en un menú. Junto a él va el COLOR de identidad, que es lo que hace
 * que el calendario entero cambie de aspecto al cambiar de propiedad.
 *
 * Una propiedad nunca se borra: se desactiva. Sus semanas, reservas y notas son
 * historia y el esquema las protege con claves foráneas RESTRICT.
 */

import { useMemo, useState, useTransition } from "react";
import { Check, Info, Loader2, TriangleAlert } from "lucide-react";

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
import {
  PROPERTY_COLOR_SPEC,
  PROPERTY_COLORS,
  propertyColorStyle,
  type PropertyColor,
} from "@/lib/property-color";
import { cn } from "@/lib/utils";
import {
  actualizarPropiedadAction,
  cambiarActivacionPropiedadAction,
  crearPropiedadAction,
} from "@/server/actions/admin-actions";
import type { PropertyRow } from "@/server/admin/properties";

export interface PropertyDialogProps {
  /** `null` = alta. Con propiedad = edición. */
  propiedad: PropertyRow | null;
  /**
   * Las demás propiedades, para avisar de un color repetido. Vale pasar la
   * lista entera: la que se está editando se descarta por id.
   */
  otras: PropertyRow[];
  abierto: boolean;
  onAbiertoChange: (abierto: boolean) => void;
}

export function PropertyDialog({
  propiedad,
  otras,
  abierto,
  onAbiertoChange,
}: PropertyDialogProps) {
  const esAlta = propiedad === null;

  /**
   * Color → nombre de la primera propiedad ACTIVA que ya lo usa.
   *
   * Solo las activas: una propiedad apagada no sale en el calendario y su color
   * no puede confundir a nadie, así que reservarlo sería quitar una opción sin
   * motivo.
   */
  const duenoPorColor = useMemo(() => {
    const mapa = new Map<PropertyColor, string>();
    for (const otra of otras) {
      if (!otra.isActive || otra.id === propiedad?.id) continue;
      if (!mapa.has(otra.color)) mapa.set(otra.color, otra.name);
    }
    return mapa;
  }, [otras, propiedad?.id]);

  const [nombre, setNombre] = useState(propiedad?.name ?? "");
  // En un alta se propone el primer color libre en vez de dejar el formulario
  // con la muestra por defecto: dos propiedades nuevas seguidas saldrían
  // iguales. Es la misma regla que aplica el servidor cuando el color no viaja
  // (`colorSugerido`); aquí solo se adelanta para que se vea marcada.
  const [color, setColor] = useState<PropertyColor>(
    propiedad?.color ?? primerColorLibre(duenoPorColor),
  );
  const [error, setError] = useState<string | null>(null);
  const [enviando, iniciar] = useTransition();

  function enviar() {
    setError(null);

    iniciar(async () => {
      const resultado = esAlta
        ? await crearPropiedadAction(nombre, color)
        : await actualizarPropiedadAction(propiedad.id, nombre, color);

      if (!resultado.ok) {
        setError(resultado.message);
        return;
      }
      onAbiertoChange(false);
    });
  }

  return (
    <Dialog open={abierto} onOpenChange={onAbiertoChange}>
      <DialogContent>
        <form
          onSubmit={(evento) => {
            evento.preventDefault();
            enviar();
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{esAlta ? "Nueva propiedad" : "Editar propiedad"}</DialogTitle>
            <DialogDescription>
              El nombre es el que aparece en el combo sobre el calendario; el color
              identifica a esta propiedad en toda la pantalla.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="propiedad-nombre">Nombre</Label>
            <Input
              id="propiedad-nombre"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              required
              minLength={3}
              maxLength={80}
              autoComplete="off"
              placeholder="Casa del lago"
              className="h-9"
            />
          </div>

          <SelectorDeColor
            valor={color}
            onChange={setColor}
            duenoPorColor={duenoPorColor}
          />

          <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
            {error}
          </p>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button type="submit" disabled={enviando}>
              {enviando ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {esAlta ? "Crear" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ══════════════════════════════════════════════ selector de color

/** Primer color que no use ninguna propiedad activa; si están los ocho, el primero. */
function primerColorLibre(duenoPorColor: Map<PropertyColor, string>): PropertyColor {
  return PROPERTY_COLORS.find((c) => !duenoPorColor.has(c)) ?? PROPERTY_COLORS[0];
}

/**
 * Las ocho muestras de la paleta.
 *
 * Es una lista CERRADA y no un `<input type="color">`: un color a mano rompería
 * el contraste en tema oscuro. Los ocho de `property-color.ts` están medidos.
 */
function SelectorDeColor({
  valor,
  onChange,
  duenoPorColor,
}: {
  valor: PropertyColor;
  onChange: (color: PropertyColor) => void;
  duenoPorColor: Map<PropertyColor, string>;
}) {
  const duenoDelElegido = duenoPorColor.get(valor) ?? null;

  return (
    <div className="grid gap-1.5">
      <span id="propiedad-color-etiqueta" className="text-sm font-medium">
        Color
      </span>
      <p id="propiedad-color-ayuda" className="text-xs text-muted-foreground">
        Tiñe el marco del calendario para que se note de un vistazo qué propiedad
        estás mirando. Los colores de las semanas —libre, tuya, de otra persona—
        no cambian nunca.
      </p>

      {/* Radios NATIVOS escondidos dentro de cada etiqueta. Así el grupo entero
          es una sola parada de tabulador y las flechas del teclado se mueven de
          muestra en muestra sin una línea de JavaScript; con botones sueltos
          habría que reimplementar ese comportamiento a mano. El nombre
          accesible de cada opción sale del texto de su etiqueta, o sea que
          incluye el nombre del color y no depende de verlo. */}
      <div
        role="radiogroup"
        aria-labelledby="propiedad-color-etiqueta"
        aria-describedby="propiedad-color-ayuda"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {PROPERTY_COLORS.map((candidato) => {
          const elegido = candidato === valor;
          const dueno = duenoPorColor.get(candidato) ?? null;

          return (
            <label
              key={candidato}
              // Las cuatro variables del color viven en la propia muestra, así
              // que las clases de abajo son las mismas para las ocho.
              style={propertyColorStyle(candidato)}
              title={dueno ? `Ya lo usa «${dueno}»` : undefined}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors",
                "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                elegido
                  ? "border-[var(--wb-prop-light)] bg-[var(--wb-prop-soft-light)] font-medium text-foreground dark:border-[var(--wb-prop-dark)] dark:bg-[var(--wb-prop-soft-dark)]"
                  : "border-input text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <input
                type="radio"
                name="propiedad-color"
                value={candidato}
                checked={elegido}
                onChange={() => onChange(candidato)}
                className="sr-only"
              />
              <span
                aria-hidden
                className="size-4 shrink-0 rounded-full bg-[var(--wb-prop-light)] dark:bg-[var(--wb-prop-dark)]"
              />
              <span className="truncate">{PROPERTY_COLOR_SPEC[candidato].label}</span>
              {/* Solo para lectores de pantalla: quien ve la lista tiene el aviso
                  de abajo y el título al pasar el ratón. */}
              {dueno ? <span className="sr-only">(ya lo usa {dueno})</span> : null}
              {/* El color no puede ser la única señal de qué está elegido. */}
              {elegido ? <Check className="ml-auto size-4 shrink-0" aria-hidden /> : null}
            </label>
          );
        })}
      </div>

      {/* Repetir color está PERMITIDO —la superusuaria manda—, pero va en contra
          de para qué existe la funcionalidad, así que se dice y no se impide. */}
      {duenoDelElegido ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            «{duenoDelElegido}» ya usa {PROPERTY_COLOR_SPEC[valor].label}. Puedes
            dejarlo, pero dos propiedades del mismo color se distinguen peor en el
            calendario.
          </span>
        </p>
      ) : null}
    </div>
  );
}

export interface PropertyActivationDialogProps {
  propiedad: PropertyRow | null;
  abierto: boolean;
  onAbiertoChange: (abierto: boolean) => void;
}

/**
 * Encender o apagar una propiedad.
 *
 * Apagarla la saca del calendario de todos, pero NO cancela reservas ni cierra
 * semanas: el diálogo enseña cuántas quedarían colgando para que la decisión se
 * tome con el número delante.
 */
export function PropertyActivationDialog({
  propiedad,
  abierto,
  onAbiertoChange,
}: PropertyActivationDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [enviando, iniciar] = useTransition();

  if (!propiedad) return null;

  const activando = !propiedad.isActive;
  const colgando = propiedad.openFutureSlots + propiedad.futureReservations;

  function confirmar() {
    if (!propiedad) return;
    setError(null);

    iniciar(async () => {
      const resultado = await cambiarActivacionPropiedadAction(propiedad.id, activando);

      if (!resultado.ok) {
        setError(resultado.message);
        return;
      }
      onAbiertoChange(false);
    });
  }

  return (
    <Dialog open={abierto} onOpenChange={onAbiertoChange}>
      <DialogContent>
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {activando ? "Reactivar propiedad" : "Desactivar propiedad"}
            </DialogTitle>
            <DialogDescription>
              {activando
                ? `«${propiedad.name}» volverá a aparecer en el calendario.`
                : `«${propiedad.name}» dejará de aparecer en el calendario y no se le podrán abrir semanas.`}
            </DialogDescription>
          </DialogHeader>

          {!activando && colgando > 0 ? (
            <div className="rounded-lg border border-[var(--wb-closed-bd)] bg-[var(--wb-closed-bg)] p-3 text-sm text-[var(--wb-closed-fg)]">
              <p className="flex items-start gap-2 font-medium">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>Queda cosa viva en esta propiedad.</span>
              </p>
              <ul className="mt-2 ml-6 list-disc space-y-1">
                {propiedad.openFutureSlots > 0 ? (
                  <li>
                    {propiedad.openFutureSlots}{" "}
                    {propiedad.openFutureSlots === 1
                      ? "semana abierta que aún no termina"
                      : "semanas abiertas que aún no terminan"}
                  </li>
                ) : null}
                {propiedad.futureReservations > 0 ? (
                  <li>
                    {propiedad.futureReservations}{" "}
                    {propiedad.futureReservations === 1
                      ? "semana reservada por alguien"
                      : "semanas reservadas por alguien"}
                  </li>
                ) : null}
              </ul>
              <p className="mt-2 text-xs">
                Desactivar <strong>no cancela nada</strong>: solo esconde la
                propiedad. Si quieres liberar esas semanas, ciérralas o cancela las
                reservas antes.
              </p>
            </div>
          ) : null}

          <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
            {error}
          </p>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button
              type="button"
              variant={activando ? "default" : "destructive"}
              disabled={enviando}
              onClick={confirmar}
            >
              {enviando ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {activando ? "Reactivar" : "Desactivar"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
