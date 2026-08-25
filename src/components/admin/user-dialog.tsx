"use client";

/**
 * Diálogos de la pantalla de usuarios: alta/edición y cambio de estado.
 *
 * Los dos viven en el mismo archivo porque comparten el mismo sujeto y el mismo
 * vocabulario de errores; separarlos obligaría a duplicar el mapa de mensajes y
 * el tratamiento del `Resultado`.
 *
 * Ninguno decide nada: la validación real (correo repetido, teléfono E.164,
 * última superusuaria) la hace el servidor y aquí solo se muestra lo que
 * responde. Cualquier comprobación de este lado es cortesía para no gastar un
 * viaje, nunca la que manda.
 */

import { useEffect, useState, useTransition } from "react";
import { Check, Copy, Loader2, TriangleAlert } from "lucide-react";

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
import type { UserRole } from "@/generated/prisma/enums";
import {
  actualizarUsuarioAction,
  cambiarActivacionUsuarioAction,
  crearUsuarioAction,
  listarReservasFuturasAction,
} from "@/server/actions/admin-actions";
import type { AdminUserRow, FutureReservationRef } from "@/server/admin/users";

const ROLES: ReadonlyArray<{ label: string; value: UserRole }> = [
  { label: "Usuaria o usuario", value: "USER" },
  { label: "Superusuaria", value: "SUPERUSER" },
];

// ═════════════════════════════════════════════════════ alta y edición

export interface UserDialogProps {
  /** `null` = alta. Con usuario = edición (el correo ya no se puede cambiar). */
  usuario: AdminUserRow | null;
  abierto: boolean;
  onAbiertoChange: (abierto: boolean) => void;
}

/**
 * Alta y edición de cuenta.
 *
 * Quien lo usa debe darle una `key` distinta por usuario (o remontarlo al
 * cerrar): el estado del formulario se inicializa en el primer render y no
 * escucha cambios de props, que es justo lo que hace falta para que no se
 * borre lo escrito mientras la acción está en vuelo.
 */
export function UserDialog({ usuario, abierto, onAbiertoChange }: UserDialogProps) {
  const esAlta = usuario === null;

  const [nombre, setNombre] = useState(usuario?.fullName ?? "");
  const [correo, setCorreo] = useState(usuario?.email ?? "");
  const [telefono, setTelefono] = useState(usuario?.phone ?? "");
  const [whatsapp, setWhatsapp] = useState(usuario?.whatsappOptIn ?? false);
  const [rol, setRol] = useState<UserRole>(usuario?.role ?? "USER");

  const [error, setError] = useState<string | null>(null);
  /** Contraseña temporal recién creada: se ve una sola vez, aquí. */
  const [temporal, setTemporal] = useState<string | null>(null);
  const [enviando, iniciar] = useTransition();

  // El consentimiento de WhatsApp sin teléfono no significa nada, y el servidor
  // lo rechaza. Se apaga en cuanto se borra el número para que el formulario no
  // muestre un estado que no puede guardarse.
  const telefonoLimpio = telefono.trim();
  const puedeWhatsapp = telefonoLimpio.length > 0;

  function enviar() {
    setError(null);

    iniciar(async () => {
      // Las dos ramas van separadas y no en un ternario: cada acción devuelve un
      // `data` distinto y unirlas obligaría a estrechar el tipo a mano.
      if (esAlta) {
        const resultado = await crearUsuarioAction({
          email: correo,
          fullName: nombre,
          phone: telefonoLimpio || null,
          whatsappOptIn: puedeWhatsapp && whatsapp,
          role: rol,
        });

        if (!resultado.ok) {
          setError(resultado.message);
          return;
        }

        if (resultado.data.temporaryPassword) {
          // No se cierra: la contraseña temporal no vuelve a mostrarse nunca.
          setTemporal(resultado.data.temporaryPassword);
          return;
        }

        onAbiertoChange(false);
        return;
      }

      const resultado = await actualizarUsuarioAction(usuario.id, {
        fullName: nombre,
        phone: telefonoLimpio || null,
        whatsappOptIn: puedeWhatsapp && whatsapp,
        role: rol,
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
        {temporal ? (
          <ContrasenaTemporal
            nombre={nombre}
            contrasena={temporal}
            onListo={() => onAbiertoChange(false)}
          />
        ) : (
          <form
            onSubmit={(evento) => {
              evento.preventDefault();
              enviar();
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>{esAlta ? "Nueva cuenta" : "Editar cuenta"}</DialogTitle>
              <DialogDescription>
                {esAlta
                  ? "No hay registro público: las cuentas se crean desde aquí."
                  : "El correo es la identidad de la cuenta y no se puede cambiar."}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-1.5">
              <Label htmlFor="usuario-nombre">Nombre completo</Label>
              <Input
                id="usuario-nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                autoComplete="off"
                required
                minLength={3}
                maxLength={120}
                className="h-9"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="usuario-correo">Correo</Label>
              <Input
                id="usuario-correo"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                value={correo}
                onChange={(e) => setCorreo(e.target.value)}
                required
                disabled={!esAlta}
                autoComplete="off"
                className="h-9"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="usuario-telefono">
                Teléfono <span className="font-normal text-muted-foreground">(opcional)</span>
              </Label>
              <Input
                id="usuario-telefono"
                type="tel"
                inputMode="tel"
                placeholder="+5219981234567"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                autoComplete="off"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Formato internacional E.164, con el signo + y la clave de país.
              </p>
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="usuario-whatsapp"
                checked={puedeWhatsapp && whatsapp}
                disabled={!puedeWhatsapp}
                onCheckedChange={(marcado) => setWhatsapp(marcado)}
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <Label htmlFor="usuario-whatsapp" className="font-normal">
                  Acepta avisos por WhatsApp
                </Label>
                <p className="text-xs text-muted-foreground">
                  {puedeWhatsapp
                    ? "El canal está preparado pero todavía no envía nada."
                    : "Hace falta un teléfono para poder activarlo."}
                </p>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="usuario-rol">Rol</Label>
              <Select
                items={ROLES}
                value={rol}
                onValueChange={(valor) => {
                  if (valor) setRol(valor);
                }}
              >
                <SelectTrigger id="usuario-rol" className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((opcion) => (
                    <SelectItem key={opcion.value} value={opcion.value}>
                      {opcion.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                La superusuaria administra todo y queda exenta de la ventana de
                apertura.
              </p>
            </div>

            {esAlta ? (
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                Se generará una <strong>contraseña temporal</strong> que verás una
                sola vez al guardar. Entrégala por un canal seguro. El alta por
                invitación con enlace de correo aún no está disponible.
              </p>
            ) : null}

            <MensajeError texto={error} />

            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={enviando}>
                {enviando ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {esAlta ? "Crear cuenta" : "Guardar cambios"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Panel de un solo uso con la contraseña recién generada. */
function ContrasenaTemporal({
  nombre,
  contrasena,
  onListo,
}: {
  nombre: string;
  contrasena: string;
  onListo: () => void;
}) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(contrasena);
      setCopiado(true);
    } catch {
      // El portapapeles falla sin HTTPS o sin permiso: el campo de al lado es
      // seleccionable, así que siempre queda la vía manual.
      setCopiado(false);
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Cuenta creada</DialogTitle>
        <DialogDescription>
          Esta contraseña temporal para {nombre} no vuelve a mostrarse. Cópiala
          ahora y entrégala por un canal seguro (nunca por correo).
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={contrasena}
          aria-label="Contraseña temporal"
          onFocus={(e) => e.currentTarget.select()}
          className="h-9 font-mono text-sm"
        />
        <Button type="button" variant="outline" onClick={copiar} className="h-9 shrink-0">
          {copiado ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copiado ? "Copiada" : "Copiar"}
        </Button>
      </div>

      <DialogFooter>
        <Button type="button" onClick={onListo}>
          Listo
        </Button>
      </DialogFooter>
    </div>
  );
}

// ══════════════════════════════════════════════ activar y desactivar

export interface UserActivationDialogProps {
  usuario: AdminUserRow | null;
  abierto: boolean;
  onAbiertoChange: (abierto: boolean) => void;
}

/**
 * Cambio de estado de una cuenta.
 *
 * Al desactivar se consultan ANTES las reservas futuras y se listan una por
 * una. Desactivar NO las cancela —el servidor tampoco lo hace— y el diálogo lo
 * dice con todas las letras: qué pasa con la semana de quien se va es una
 * decisión, no un efecto colateral de pulsar un botón.
 */
/** Consulta de reservas futuras: una sola variable para los cuatro estados. */
type ConsultaFuturas =
  | { tipo: "ocioso" }
  | { tipo: "cargando" }
  | { tipo: "listo"; reservas: FutureReservationRef[] }
  | { tipo: "error"; mensaje: string };

export function UserActivationDialog({
  usuario,
  abierto,
  onAbiertoChange,
}: UserActivationDialogProps) {
  const activando = usuario ? !usuario.isActive : false;
  const usuarioId = usuario?.id ?? null;
  // Solo interesa al dar de baja: al reactivar no hay nada que advertir.
  const debeConsultar = abierto && usuarioId !== null && !activando;

  // El estado arranca ya en «cargando» en lugar de encenderlo desde el efecto:
  // un setState síncrono dentro del efecto provoca un render en cascada, y aquí
  // no hace falta porque quien usa este diálogo lo remonta en cada apertura.
  const [consulta, setConsulta] = useState<ConsultaFuturas>(
    debeConsultar ? { tipo: "cargando" } : { tipo: "ocioso" },
  );
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, iniciar] = useTransition();

  useEffect(() => {
    if (!debeConsultar || usuarioId === null) return;

    let vigente = true;

    void listarReservasFuturasAction(usuarioId).then((resultado) => {
      if (!vigente) return;
      setConsulta(
        resultado.ok
          ? { tipo: "listo", reservas: resultado.data }
          : { tipo: "error", mensaje: resultado.message },
      );
    });

    // El testigo evita pintar la respuesta de un usuario que ya no es el que
    // está abierto (dos clics rápidos en filas distintas).
    return () => {
      vigente = false;
    };
  }, [debeConsultar, usuarioId]);

  if (!usuario) return null;

  function confirmar() {
    if (!usuario) return;
    setError(null);

    iniciar(async () => {
      const resultado = await cambiarActivacionUsuarioAction(
        usuario.id,
        activando,
        motivo,
      );

      if (!resultado.ok) {
        setError(resultado.message);
        return;
      }
      onAbiertoChange(false);
    });
  }

  return (
    <Dialog open={abierto} onOpenChange={onAbiertoChange}>
      <DialogContent className="sm:max-w-lg">
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {activando ? "Reactivar cuenta" : "Desactivar cuenta"}
            </DialogTitle>
            <DialogDescription>
              {activando
                ? `${usuario.fullName} volverá a poder entrar y reservar.`
                : `${usuario.fullName} dejará de poder entrar. Sus sesiones abiertas se cierran de inmediato.`}
            </DialogDescription>
          </DialogHeader>

          {!activando ? (
            <ReservasFuturas consulta={consulta} nombre={usuario.fullName} />
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="usuario-motivo">
              Motivo <span className="font-normal text-muted-foreground">(opcional)</span>
            </Label>
            <Textarea
              id="usuario-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Queda anotado en la bitácora."
            />
          </div>

          <MensajeError texto={error} />

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button
              type="button"
              variant={activando ? "default" : "destructive"}
              // Al dar de baja no se confirma nada hasta tener delante la lista
              // de reservas futuras: ese es justo el dato que hay que ver antes.
              disabled={enviando || consulta.tipo === "cargando"}
              onClick={confirmar}
            >
              {enviando ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {activando ? "Reactivar" : "Desactivar de todos modos"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReservasFuturas({
  consulta,
  nombre,
}: {
  consulta: ConsultaFuturas;
  nombre: string;
}) {
  if (consulta.tipo === "cargando") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Buscando reservas futuras…
      </p>
    );
  }

  if (consulta.tipo === "error") {
    // Si no se pudo consultar, se dice: dar de baja «a ciegas» sin avisar de que
    // la comprobación falló sería exactamente lo que este diálogo evita.
    return (
      <p role="alert" className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-destructive">
        No pudimos revisar sus reservas futuras ({consulta.mensaje}). Compruébalas
        en el calendario antes de continuar.
      </p>
    );
  }

  if (consulta.tipo === "ocioso") return null;

  const reservas = consulta.reservas;

  if (reservas.length === 0) {
    return (
      <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
        No tiene semanas reservadas de aquí en adelante.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--wb-closed-bd)] bg-[var(--wb-closed-bg)] p-3 text-[var(--wb-closed-fg)]">
      <p className="flex items-start gap-2 text-sm font-medium">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          {nombre} tiene {reservas.length}{" "}
          {reservas.length === 1 ? "semana reservada" : "semanas reservadas"} que
          todavía no termina{reservas.length === 1 ? "" : "n"}.
        </span>
      </p>

      <ul className="mt-2 grid gap-1 text-sm">
        {reservas.map((reserva) => (
          <li key={reserva.reservationId} className="flex flex-wrap gap-x-2">
            <span className="font-medium">{reserva.propertyName}</span>
            <span>· {reserva.label}</span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs">
        Desactivar la cuenta <strong>no las cancela</strong>: seguirán ocupando
        esas semanas. Si quieres liberarlas, cancélalas antes desde el
        calendario.
      </p>
    </div>
  );
}

/** Mensaje de error con hueco reservado: evita que el diálogo dé un salto. */
function MensajeError({ texto }: { texto: string | null }) {
  return (
    <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
      {texto}
    </p>
  );
}
