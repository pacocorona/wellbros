"use client";

/**
 * Lista de propiedades: crear, editar y activar o desactivar.
 *
 * Es deliberadamente simple. Una propiedad es un nombre, un color y poco más; todo el peso
 * de la administración está en sus semanas, que viven en el gestor de abajo. Por
 * eso cada tarjeta lleva el atajo «Gestionar semanas», que es lo que se hace el
 * 90 % de las veces que se entra a esta pantalla.
 */

import { useState } from "react";
import Link from "next/link";
import { CalendarRange, Pencil, Plus, Power, PowerOff } from "lucide-react";

import {
  PropertyActivationDialog,
  PropertyDialog,
} from "@/components/admin/property-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { propertyColorLabel, propertyColorStyle } from "@/lib/property-color";
import { cn } from "@/lib/utils";
import type { PropertyRow } from "@/server/admin/properties";

export interface PropertiesListProps {
  propiedades: PropertyRow[];
  /** Propiedad que el gestor de semanas tiene abierta, para marcarla. */
  seleccionadaId: string | null;
}

type Dialogo =
  | { tipo: "editar"; propiedad: PropertyRow | null }
  | { tipo: "estado"; propiedad: PropertyRow }
  | null;

export function PropertiesList({ propiedades, seleccionadaId }: PropertiesListProps) {
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  /** Ver el comentario homónimo en users-table: fuerza formulario limpio. */
  const [apertura, setApertura] = useState(0);

  function abrir(siguiente: NonNullable<Dialogo>) {
    setApertura((n) => n + 1);
    setDialogo(siguiente);
  }

  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => abrir({ tipo: "editar", propiedad: null })}
          className="h-9"
        >
          <Plus aria-hidden />
          Nueva propiedad
        </Button>
      </div>

      {propiedades.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Todavía no hay propiedades. Crea la primera para poder abrir semanas.
        </p>
      ) : (
        <ul className="grid gap-2">
          {propiedades.map((propiedad) => (
            <li
              key={propiedad.id}
              className={cn(
                "grid gap-3 rounded-xl border bg-card p-3 sm:flex sm:items-center sm:justify-between",
                propiedad.id === seleccionadaId
                  ? "border-[var(--wb-accent)] ring-1 ring-[var(--wb-accent)]"
                  : "border-border",
              )}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {/* El punto identifica la propiedad de un vistazo, igual que en
                      el combo del calendario. Como señal SOLA no serviría —hay
                      quien no distingue turquesa de esmeralda—, así que el nombre
                      del color va escrito en la línea de abajo y en el título. */}
                  <span
                    aria-hidden
                    title={propertyColorLabel(propiedad.color)}
                    style={propertyColorStyle(propiedad.color)}
                    className="size-2.5 shrink-0 rounded-full bg-[var(--wb-prop-light)] dark:bg-[var(--wb-prop-dark)]"
                  />
                  <span className="truncate">{propiedad.name}</span>
                  {propiedad.isActive ? null : (
                    <Badge variant="destructive">Desactivada</Badge>
                  )}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {propertyColorLabel(propiedad.color)} ·{" "}
                  {propiedad.openFutureSlots}{" "}
                  {propiedad.openFutureSlots === 1
                    ? "semana abierta por venir"
                    : "semanas abiertas por venir"}
                  {propiedad.futureReservations > 0
                    ? ` · ${propiedad.futureReservations} con reserva`
                    : ""}
                </p>
              </div>

              <div className="flex flex-wrap gap-1 sm:shrink-0">
                <Button
                  render={
                    <Link
                      href={`/config/propiedades?propiedad=${propiedad.id}`}
                      scroll={false}
                    />
                  }
                  variant={propiedad.id === seleccionadaId ? "secondary" : "outline"}
                  size="sm"
                >
                  <CalendarRange aria-hidden />
                  Gestionar semanas
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => abrir({ tipo: "editar", propiedad })}
                >
                  <Pencil aria-hidden />
                  Editar
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => abrir({ tipo: "estado", propiedad })}
                >
                  {propiedad.isActive ? (
                    <>
                      <PowerOff aria-hidden />
                      Desactivar
                    </>
                  ) : (
                    <>
                      <Power aria-hidden />
                      Reactivar
                    </>
                  )}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <PropertyDialog
        key={`editar-${dialogo?.tipo === "editar" ? (dialogo.propiedad?.id ?? "nueva") : "off"}-${apertura}`}
        propiedad={dialogo?.tipo === "editar" ? dialogo.propiedad : null}
        // La lista entera: el diálogo necesita saber qué colores están en uso
        // para avisar de un repetido, y descarta por su cuenta la que se edita.
        otras={propiedades}
        abierto={dialogo?.tipo === "editar"}
        onAbiertoChange={(abierto) => {
          if (!abierto) setDialogo(null);
        }}
      />

      <PropertyActivationDialog
        key={`estado-${dialogo?.tipo === "estado" ? dialogo.propiedad.id : "off"}-${apertura}`}
        propiedad={dialogo?.tipo === "estado" ? dialogo.propiedad : null}
        abierto={dialogo?.tipo === "estado"}
        onAbiertoChange={(abierto) => {
          if (!abierto) setDialogo(null);
        }}
      />
    </div>
  );
}
