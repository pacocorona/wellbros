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
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Mail,
  MailCheck,
  Send,
  TriangleAlert,
} from "lucide-react";

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
  reenviarInvitacionAction,
  type CrearUsuarioSalida,
} from "@/server/actions/admin-actions";
import type {
  AdminUserRow,
  FutureReservationRef,
  UserDelivery,
} from "@/server/admin/users";

const ROLES: ReadonlyArray<{ label: string; value: UserRole }> = [
  { label: "Usuaria o usuario", value: "USER" },
  { label: "Superusuaria", value: "SUPERUSER" },
];

/**
 * Las dos formas de entregar la primera llave, con la diferencia explicada
 * donde se elige y no en la documentación.
 *
 * El orden importa: la invitación va primera y es la marcada por omisión
 * porque es la buena. La contraseña temporal sigue existiendo para el caso real
 * —alguien sin correo, un envío que rebota— pero obliga a dictar por teléfono o
 * WhatsApp una contraseña que a partir de ese momento conocen dos personas.
 */
const ENTREGAS: ReadonlyArray<{
  value: UserDelivery;
  titulo: string;
  detalle: string;
  Icono: typeof Mail;
}> = [
  {
    value: "INVITACION",
    titulo: "Enviar invitación por correo",
    detalle:
      "Recibe un enlace que caduca en 48 horas y sirve una sola vez. Elige su propia contraseña: nadie más llega a conocerla.",
    Icono: Mail,
  },
  {
    value: "CONTRASENA_TEMPORAL",
    titulo: "Generar contraseña temporal",
    detalle:
      "La verás una sola vez y tendrás que dictarla. Hasta que la cambie, la conocen dos personas. Úsalo solo si no tiene correo o el envío falla.",
    Icono: KeyRound,
  },
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

  const [entrega, setEntrega] = useState<UserDelivery>("INVITACION");

  const [error, setError] = useState<string | null>(null);
  /**
   * Resultado del alta. Mientras no sea nulo, el diálogo deja de ser un
   * formulario y pasa a ser el acuse de recibo: o la contraseña temporal —que
   * no vuelve a mostrarse jamás— o la confirmación del correo enviado.
   */
  const [creada, setCreada] = useState<CrearUsuarioSalida | null>(null);
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
          delivery: entrega,
        });

        if (!resultado.ok) {
          setError(resultado.message);
          return;
        }

        // Nunca se cierra solo tras un alta: la contraseña temporal no vuelve a
        // mostrarse nunca, y la confirmación del correo es la única señal de si
        // el aviso salió de verdad o se quedó en la cola.
        setCreada(resultado.data);
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
        {creada ? (
          <AltaHecha
            resultado={creada}
            nombre={nombre}
            correo={correo}
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
              <ElectorDeEntrega valor={entrega} onCambio={setEntrega} />
            ) : (
              <Acceso usuario={usuario} />
            )}

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

/**
 * Elección de cómo recibe la cuenta su primera llave.
 *
 * Va con radios nativos y no con un combo: son dos opciones que hay que
 * comparar, y un combo esconde la que no está seleccionada justo cuando la
 * diferencia entre las dos es lo único que hay que entender. El texto de cada
 * una dice lo que de verdad cambia —quién acaba conociendo la contraseña—, no
 * cómo funciona por dentro.
 */
function ElectorDeEntrega({
  valor,
  onCambio,
}: {
  valor: UserDelivery;
  onCambio: (valor: UserDelivery) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-sm font-medium">Cómo entra por primera vez</legend>

      {ENTREGAS.map(({ value, titulo, detalle, Icono }) => {
        const marcada = valor === value;
        return (
          <label
            key={value}
            data-marcada={marcada}
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 transition-colors data-[marcada=true]:border-[var(--wb-accent-ink)] data-[marcada=true]:bg-[var(--wb-accent-soft)] has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            {/* El nombre y la descripción se enlazan EXPLÍCITAMENTE por id: con
                solo la etiqueta envolvente, el lector de pantalla anuncia el
                valor crudo del radio («INVITACION») en vez de la frase, y la
                explicación —que es lo único que distingue una opción de otra—
                no se lee en absoluto. */}
            <input
              type="radio"
              name="entrega"
              value={value}
              checked={marcada}
              onChange={() => onCambio(value)}
              aria-labelledby={`entrega-${value}-titulo`}
              aria-describedby={`entrega-${value}-detalle`}
              className="mt-0.5 size-4 shrink-0 accent-[var(--wb-accent-ink)]"
            />
            <span className="grid gap-0.5">
              <span
                id={`entrega-${value}-titulo`}
                className="flex items-center gap-1.5 text-sm font-medium"
              >
                <Icono className="size-4 shrink-0" aria-hidden />
                {titulo}
              </span>
              <span
                id={`entrega-${value}-detalle`}
                className="text-xs text-muted-foreground"
              >
                {detalle}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * Estado del acceso de una cuenta que ya existe, con el reenvío de invitación.
 *
 * Solo aparece cuando la persona todavía no ha canjeado su enlace. A quien ya
 * tiene contraseña propia no se le reinvita —el servidor lo rechaza— porque un
 * enlace de alta sobre una cuenta abierta es, sin decirlo, un cambio de
 * contraseña hecho por otra persona. Eso será la recuperación de contraseña,
 * cuando exista, y tendrá su propio nombre.
 */
function Acceso({ usuario }: { usuario: AdminUserRow }) {
  const [estado, setEstado] = useState<
    | { tipo: "ocioso" }
    | { tipo: "listo"; notificados: number; caducaEn: string }
    | { tipo: "error"; mensaje: string }
  >({ tipo: "ocioso" });
  const [enviando, iniciar] = useTransition();

  if (!usuario.pendingInvitation) {
    return (
      <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        Esta persona ya eligió su contraseña y entra por su cuenta. Nadie más la
        conoce, tampoco nosotros. Todavía no hay forma de recuperarla desde aquí:
        la recuperación de contraseña está por hacerse.
      </p>
    );
  }

  function reenviar() {
    iniciar(async () => {
      const resultado = await reenviarInvitacionAction(usuario.id);
      setEstado(
        resultado.ok
          ? {
              tipo: "listo",
              notificados: resultado.data.notified,
              caducaEn: resultado.data.expiresInLabel,
            }
          : { tipo: "error", mensaje: resultado.message },
      );
    });
  }

  return (
    <div className="grid gap-2 rounded-lg bg-muted/60 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">
        <strong className="font-medium text-foreground">
          Todavía no ha entrado.
        </strong>{" "}
        Se le envió una invitación y aún no la ha canjeado. Si el enlace caducó o
        el correo se perdió, envíale uno nuevo: el anterior deja de servir en ese
        mismo momento.
      </p>

      {estado.tipo === "listo" ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <MailCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {estado.notificados > 0
              ? `Enlace nuevo en camino a ${usuario.email}. Caduca en ${estado.caducaEn}.`
              : "El enlace se generó, pero el canal de correo está apagado y no salió ningún mensaje. Enciéndelo en la configuración de avisos."}
          </span>
        </p>
      ) : null}

      {estado.tipo === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          {estado.mensaje}
        </p>
      ) : null}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={enviando}
          onClick={reenviar}
        >
          {enviando ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
          {estado.tipo === "listo" ? "Enviar otro enlace" : "Reenviar invitación"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Acuse de recibo del alta. Es la única pantalla donde se ve la contraseña
 * temporal, y la única que dice si el correo salió de verdad.
 */
function AltaHecha({
  resultado,
  nombre,
  correo,
  onListo,
}: {
  resultado: CrearUsuarioSalida;
  nombre: string;
  correo: string;
  onListo: () => void;
}) {
  if (resultado.temporaryPassword) {
    return (
      <ContrasenaTemporal
        nombre={nombre}
        contrasena={resultado.temporaryPassword}
        onListo={onListo}
      />
    );
  }

  // Cero avisos encolados con entrega por invitación significa que el canal de
  // correo está apagado en la configuración. La cuenta existe y el enlace
  // también, pero NADIE lo va a recibir: callarlo dejaría a la administración
  // esperando a alguien que no puede entrar.
  const salioElCorreo = resultado.notified > 0;

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {salioElCorreo ? "Invitación enviada" : "Cuenta creada, correo sin enviar"}
        </DialogTitle>
        <DialogDescription>
          {salioElCorreo ? (
            <>
              {nombre} recibirá en <strong>{correo}</strong> un enlace para elegir
              su contraseña. Caduca en 48 horas y sirve una sola vez; si se le
              pasa, puedes reenviárselo desde esta misma pantalla.
            </>
          ) : (
            <>
              La cuenta de {nombre} quedó creada, pero el canal de correo está
              apagado y no salió ningún mensaje. Enciéndelo en la configuración de
              avisos y reenvíale la invitación desde la ficha de la cuenta.
            </>
          )}
        </DialogDescription>
      </DialogHeader>

      {salioElCorreo ? null : (
        <p className="flex items-start gap-2 rounded-lg border border-[var(--wb-closed-bd)] bg-[var(--wb-closed-bg)] p-3 text-sm text-[var(--wb-closed-fg)]">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Hasta que reciba el enlace, esta persona no puede entrar: su cuenta
            nace sin contraseña.
          </span>
        </p>
      )}

      <DialogFooter>
        <Button type="button" onClick={onListo}>
          Listo
        </Button>
      </DialogFooter>
    </div>
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
