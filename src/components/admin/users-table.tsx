"use client";

/**
 * Tabla de usuarios de /config/usuarios.
 *
 * El filtrado y la búsqueda se hacen EN EL CLIENTE a propósito, aunque
 * `listUsers` acepte filtros: son un puñado de cuentas familiares, caben de
 * sobra en una respuesta y así escribir en la caja de búsqueda no cuesta un
 * viaje al servidor por letra. Si algún día esto creciera a cientos de filas,
 * hay que mover el filtro a la consulta y paginar.
 *
 * En pantalla ancha es una tabla; en móvil, tarjetas. Son dos marcados para los
 * mismos datos porque una tabla de seis columnas en 375 px o se corta o se
 * vuelve ilegible, y el objetivo táctil de los botones importa más aquí que la
 * pureza del marcado.
 */

import { useMemo, useState } from "react";
import { Pencil, Search, UserPlus, UserRoundCheck, UserRoundX } from "lucide-react";

import { UserActivationDialog, UserDialog } from "@/components/admin/user-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminUserRow } from "@/server/admin/users";

export interface UsersTableProps {
  usuarios: AdminUserRow[];
  /** Id de quien está usando la pantalla: nadie puede darse de baja a sí misma. */
  actorId: string;
}

type Dialogo =
  | { tipo: "editar"; usuario: AdminUserRow | null }
  | { tipo: "estado"; usuario: AdminUserRow }
  | null;

export function UsersTable({ usuarios, actorId }: UsersTableProps) {
  const [busqueda, setBusqueda] = useState("");
  const [verInactivas, setVerInactivas] = useState(false);
  const [dialogo, setDialogo] = useState<Dialogo>(null);
  /**
   * Contador de aperturas: forma parte de la `key` del diálogo para que cada
   * vez que se abre nazca un formulario limpio, incluso sobre la misma fila.
   */
  const [apertura, setApertura] = useState(0);

  const visibles = useMemo(() => {
    const aguja = busqueda.trim().toLowerCase();
    return usuarios.filter((usuario) => {
      if (!verInactivas && !usuario.isActive) return false;
      if (!aguja) return true;
      return (
        usuario.fullName.toLowerCase().includes(aguja) ||
        usuario.email.toLowerCase().includes(aguja) ||
        (usuario.phone ?? "").includes(aguja)
      );
    });
  }, [usuarios, busqueda, verInactivas]);

  const inactivas = usuarios.filter((u) => !u.isActive).length;

  function abrir(siguiente: NonNullable<Dialogo>) {
    setApertura((n) => n + 1);
    setDialogo(siguiente);
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="usuarios-busqueda" className="text-xs text-muted-foreground">
            Buscar
          </Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="usuarios-busqueda"
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Nombre, correo o teléfono"
              className="h-9 w-64 max-w-full pl-8"
            />
          </div>
        </div>

        <Button type="button" onClick={() => abrir({ tipo: "editar", usuario: null })} className="h-9">
          <UserPlus aria-hidden />
          Nueva cuenta
        </Button>
      </div>

      {inactivas > 0 ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id="usuarios-inactivas"
            checked={verInactivas}
            onCheckedChange={(marcado) => setVerInactivas(marcado)}
          />
          <Label htmlFor="usuarios-inactivas" className="font-normal text-muted-foreground">
            Mostrar cuentas desactivadas ({inactivas})
          </Label>
        </div>
      ) : null}

      {visibles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No hay cuentas que coincidan con la búsqueda.
        </p>
      ) : (
        <>
          {/* Escritorio */}
          <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Correo</TableHead>
                  <TableHead>Teléfono</TableHead>
                  <TableHead>Rol</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibles.map((usuario) => (
                  <TableRow key={usuario.id} data-inactiva={!usuario.isActive}>
                    <TableCell className="font-medium">
                      {usuario.fullName}
                      {usuario.id === actorId ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">(tú)</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{usuario.email}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {usuario.phone ?? "—"}
                    </TableCell>
                    <TableCell>
                      <EtiquetaRol rol={usuario.role} />
                    </TableCell>
                    <TableCell>
                      <EtiquetaEstado usuario={usuario} />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Acciones
                        usuario={usuario}
                        esYo={usuario.id === actorId}
                        onEditar={() => abrir({ tipo: "editar", usuario })}
                        onEstado={() => abrir({ tipo: "estado", usuario })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Móvil */}
          <ul className="grid gap-2 md:hidden">
            {visibles.map((usuario) => (
              <li
                key={usuario.id}
                className="grid gap-2 rounded-xl border border-border bg-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {usuario.fullName}
                      {usuario.id === actorId ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">(tú)</span>
                      ) : null}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{usuario.email}</p>
                    {usuario.phone ? (
                      <p className="text-sm text-muted-foreground">{usuario.phone}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <EtiquetaRol rol={usuario.role} />
                    <EtiquetaEstado usuario={usuario} />
                  </div>
                </div>

                <div className="flex justify-end">
                  <Acciones
                    usuario={usuario}
                    esYo={usuario.id === actorId}
                    onEditar={() => abrir({ tipo: "editar", usuario })}
                    onEstado={() => abrir({ tipo: "estado", usuario })}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <UserDialog
        key={`editar-${dialogo?.tipo === "editar" ? (dialogo.usuario?.id ?? "nuevo") : "off"}-${apertura}`}
        usuario={dialogo?.tipo === "editar" ? dialogo.usuario : null}
        abierto={dialogo?.tipo === "editar"}
        onAbiertoChange={(abierto) => {
          if (!abierto) setDialogo(null);
        }}
      />

      <UserActivationDialog
        key={`estado-${dialogo?.tipo === "estado" ? dialogo.usuario.id : "off"}-${apertura}`}
        usuario={dialogo?.tipo === "estado" ? dialogo.usuario : null}
        abierto={dialogo?.tipo === "estado"}
        onAbiertoChange={(abierto) => {
          if (!abierto) setDialogo(null);
        }}
      />
    </div>
  );
}

function Acciones({
  usuario,
  esYo,
  onEditar,
  onEstado,
}: {
  usuario: AdminUserRow;
  esYo: boolean;
  onEditar: () => void;
  onEstado: () => void;
}) {
  return (
    <div className="inline-flex gap-1">
      <Button type="button" variant="ghost" size="sm" onClick={onEditar}>
        <Pencil aria-hidden />
        Editar
      </Button>

      <Button
        type="button"
        variant={usuario.isActive ? "ghost" : "outline"}
        size="sm"
        // La cuenta propia no se desactiva: sin esto, la única superusuaria
        // podría dejarse fuera de su propia casa. El servidor lo rechaza
        // igualmente (SELF_DEACTIVATION); aquí solo se evita el intento.
        disabled={esYo && usuario.isActive}
        title={
          esYo && usuario.isActive ? "No puedes desactivar tu propia cuenta." : undefined
        }
        onClick={onEstado}
      >
        {usuario.isActive ? (
          <>
            <UserRoundX aria-hidden />
            Desactivar
          </>
        ) : (
          <>
            <UserRoundCheck aria-hidden />
            Reactivar
          </>
        )}
      </Button>
    </div>
  );
}

function EtiquetaRol({ rol }: { rol: AdminUserRow["role"] }) {
  return rol === "SUPERUSER" ? (
    <Badge variant="secondary">Superusuaria</Badge>
  ) : (
    <Badge variant="outline">Usuario</Badge>
  );
}

/**
 * Estado de la cuenta. El color no va solo: cada estado lleva su palabra, que
 * es lo que leen tanto quien no distingue colores como el lector de pantalla.
 */
function EtiquetaEstado({ usuario }: { usuario: AdminUserRow }) {
  if (!usuario.isActive) return <Badge variant="destructive">Desactivada</Badge>;

  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="outline">Activa</Badge>
      {usuario.activeReservations > 0 ? (
        <span className="text-xs text-muted-foreground">
          {usuario.activeReservations}{" "}
          {usuario.activeReservations === 1 ? "reserva" : "reservas"}
        </span>
      ) : null}
    </span>
  );
}
