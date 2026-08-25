"use client";

/**
 * /perfil: los tres bloques que la persona puede tocar sobre sí misma.
 *
 *   1. Datos    — nombre y teléfono.
 *   2. Acceso   — cambio de contraseña.
 *   3. Apariencia — tema Claro / Oscuro / Sistema.
 *
 * Son tres formularios independientes y no uno solo con tres secciones: cada
 * uno falla, se valida y confirma por su cuenta. Un error tecleando la
 * contraseña no debe tirar el cambio de nombre que ya estaba bien.
 *
 * Los dos primeros van por `useActionState`, que es lo que obliga a este
 * archivo a ser de cliente. El tercero NO tiene formulario: se apoya en
 * `useTheme()`, el mismo estado que usa el selector de la barra superior, para
 * que los dos enseñen siempre lo mismo. Ese proveedor ya escribe `users.theme`
 * en el servidor (ver src/app/layout.tsx).
 */

import { useActionState } from "react";
import {
  Check,
  Info,
  Loader2,
  Monitor,
  Moon,
  Sun,
  type LucideIcon,
} from "lucide-react";

import { useTheme, type Theme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  actualizarPerfilAction,
  cambiarContrasenaAction,
  type ContrasenaFormState,
  type PerfilFormState,
} from "@/server/actions/profile-actions";

/**
 * Mismo mínimo que `changeOwnPassword` (src/server/admin/users.ts). Se repite
 * aquí porque un módulo "use server" solo puede exportar funciones asíncronas,
 * así que la constante no puede viajar. Si cambia allá, cambia aquí.
 */
const MIN_CONTRASENA = 12;

export interface ProfileFormProps {
  fullName: string;
  /** E.164 o cadena vacía. */
  phone: string;
  email: string;
  esSuperusuaria: boolean;
}

export function ProfileForm({ fullName, phone, email, esSuperusuaria }: ProfileFormProps) {
  return (
    <div className="flex flex-col gap-5">
      <DatosPersonales fullName={fullName} phone={phone} email={email} esSuperusuaria={esSuperusuaria} />
      <CambioDeContrasena />
      <Apariencia />
    </div>
  );
}

// ═══════════════════════════════════════════════════ 1. datos

function DatosPersonales({ fullName, phone, email, esSuperusuaria }: ProfileFormProps) {
  const estadoInicial: PerfilFormState = {
    ok: null,
    mensaje: null,
    errores: {},
    valores: { fullName, phone },
  };

  const [estado, enviar, pendiente] = useActionState(actualizarPerfilAction, estadoInicial);

  return (
    <Seccion
      titulo="Tus datos"
      descripcion="Tu nombre es lo que ven los demás en el calendario y en los avisos."
    >
      <form action={enviar} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fullName">Nombre completo</Label>
          <Input
            id="fullName"
            name="fullName"
            autoComplete="name"
            required
            maxLength={120}
            defaultValue={estado.valores.fullName}
            aria-invalid={estado.errores.fullName ? true : undefined}
            aria-describedby={estado.errores.fullName ? "error-fullName" : undefined}
            className="h-10"
          />
          {estado.errores.fullName ? (
            <p id="error-fullName" className="text-xs text-destructive">
              {estado.errores.fullName}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="phone">
            Teléfono <span className="font-normal text-muted-foreground">(opcional)</span>
          </Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+5219981234567"
            maxLength={20}
            defaultValue={estado.valores.phone}
            aria-invalid={estado.errores.phone ? true : undefined}
            aria-describedby={estado.errores.phone ? "error-phone ayuda-phone" : "ayuda-phone"}
            className="h-10"
          />
          <p id="ayuda-phone" className="text-xs text-muted-foreground">
            Formato internacional, con el código de país: <code>+5219981234567</code>. Hoy no
            se usa para nada; queda guardado para cuando se activen los avisos por WhatsApp.
            Déjalo en blanco si prefieres no darlo.
          </p>
          {estado.errores.phone ? (
            <p id="error-phone" className="text-xs text-destructive">
              {estado.errores.phone}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Correo</Label>
          {/* Deshabilitado y sin `name`: el correo es la identidad de la cuenta
              y la clave de todo lo anotado en la bitácora. Solo lo cambia la
              superusuaria, desde Configuración. */}
          <Input id="email" type="email" value={email} disabled readOnly className="h-10" />
          <p className="text-xs text-muted-foreground">
            {esSuperusuaria
              ? "Para cambiar un correo, entra a Configuración › Usuarios."
              : "Si necesitas cambiarlo, pídeselo a Ivonne."}
          </p>
        </div>

        <Aviso estado={estado.ok} mensaje={estado.mensaje} />

        <div>
          <Button type="submit" size="lg" disabled={pendiente} className="h-10">
            {pendiente ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {pendiente ? "Guardando…" : "Guardar cambios"}
          </Button>
        </div>
      </form>
    </Seccion>
  );
}

// ═══════════════════════════════════════════════ 2. contraseña

const ESTADO_CONTRASENA: ContrasenaFormState = {
  ok: null,
  mensaje: null,
  errores: {},
  sesionesCerradas: 0,
};

function CambioDeContrasena() {
  const [estado, enviar, pendiente] = useActionState(
    cambiarContrasenaAction,
    ESTADO_CONTRASENA,
  );

  return (
    <Seccion
      titulo="Contraseña"
      descripcion="Cambiarla cierra tu sesión en los demás dispositivos. Esta ventana sigue abierta."
    >
      {/* Las reglas ANTES de escribir, no después de fallar: nadie debería
          descubrir el mínimo de caracteres a base de rechazos. */}
      <div className="mb-4 flex gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <p>
            Debe tener <strong>{MIN_CONTRASENA} caracteres o más</strong> y ser distinta de la
            actual.
          </p>
          <p>
            No pedimos mayúsculas ni símbolos: una frase larga que recuerdes —«mi perro duerme
            en el sillón»— protege más que <code>Verano2026!</code>.
          </p>
        </div>
      </div>

      {/* `key` con el resultado: tras un cambio con éxito el formulario se
          vuelve a montar vacío, para no dejar la contraseña nueva escrita en
          pantalla. */}
      <form
        key={estado.ok === true ? "limpio" : "en-curso"}
        action={enviar}
        className="flex flex-col gap-4"
      >
        <CampoContrasena
          id="currentPassword"
          etiqueta="Contraseña actual"
          autoComplete="current-password"
          error={estado.errores.currentPassword}
        />
        <CampoContrasena
          id="newPassword"
          etiqueta="Contraseña nueva"
          autoComplete="new-password"
          minLength={MIN_CONTRASENA}
          error={estado.errores.newPassword}
        />
        <CampoContrasena
          id="confirmPassword"
          etiqueta="Repite la contraseña nueva"
          autoComplete="new-password"
          minLength={MIN_CONTRASENA}
          error={estado.errores.confirmPassword}
        />

        <Aviso estado={estado.ok} mensaje={estado.mensaje} />

        <div>
          <Button type="submit" size="lg" disabled={pendiente} className="h-10">
            {pendiente ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {pendiente ? "Cambiando…" : "Cambiar contraseña"}
          </Button>
        </div>
      </form>
    </Seccion>
  );
}

function CampoContrasena({
  id,
  etiqueta,
  autoComplete,
  minLength,
  error,
}: {
  id: string;
  etiqueta: string;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{etiqueta}</Label>
      <Input
        id={id}
        name={id}
        type="password"
        autoComplete={autoComplete}
        required
        minLength={minLength}
        maxLength={200}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `error-${id}` : undefined}
        className="h-10"
      />
      {error ? (
        <p id={`error-${id}`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ═══════════════════════════════════════════════ 3. apariencia

const TEMAS: ReadonlyArray<{ valor: Theme; texto: string; icono: LucideIcon }> = [
  { valor: "light", texto: "Claro", icono: Sun },
  { valor: "dark", texto: "Oscuro", icono: Moon },
  { valor: "system", texto: "Sistema", icono: Monitor },
];

function Apariencia() {
  const { theme, setTheme, isReady } = useTheme();

  return (
    <Seccion
      titulo="Apariencia"
      descripcion="Se guarda en tu cuenta, así que te sigue a cualquier navegador donde entres."
    >
      {/* Grupo de radios de verdad (`role`+`aria-checked`) y no tres botones
          sueltos: así el lector de pantalla anuncia «1 de 3» y cuál está
          elegido, y las flechas del teclado funcionan como se espera. */}
      <div role="radiogroup" aria-label="Tema de la interfaz" className="flex flex-wrap gap-2">
        {TEMAS.map((opcion) => {
          // `isReady` es falso en el primer render del cliente: el servidor no
          // sabe qué eligió un navegador sin sesión, y marcar antes de tiempo
          // provocaría un desajuste de hidratación.
          const elegido = isReady && theme === opcion.valor;
          const Icono = opcion.icono;
          return (
            <button
              key={opcion.valor}
              type="button"
              role="radio"
              aria-checked={elegido}
              onClick={() => setTheme(opcion.valor)}
              className={cn(
                "flex h-10 flex-1 min-w-28 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                elegido
                  ? "border-[var(--wb-accent)] bg-[var(--wb-accent-soft)] text-[var(--wb-accent-ink)]"
                  : "border-input text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icono className="size-4" aria-hidden />
              {opcion.texto}
              {/* El color no basta como señal: la opción activa lleva palomita. */}
              {elegido ? <Check className="size-4" aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        «Sistema» sigue lo que tenga configurado tu teléfono o computadora, incluido el cambio
        automático de noche.
      </p>
    </Seccion>
  );
}

// ═══════════════════════════════════════════════════ compartido

function Seccion({
  titulo,
  descripcion,
  children,
}: {
  titulo: string;
  descripcion: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-base font-semibold tracking-tight">{titulo}</h2>
      <p className="mt-0.5 mb-4 text-sm text-muted-foreground">{descripcion}</p>
      {children}
    </section>
  );
}

/**
 * Resultado del envío. `role="status"` con `aria-live` para que el lector de
 * pantalla lo anuncie sin que haya que ir a buscarlo, y altura mínima fija
 * para que la aparición del mensaje no empuje el botón bajo el dedo.
 */
function Aviso({ estado, mensaje }: { estado: boolean | null; mensaje: string | null }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "min-h-5 text-sm",
        estado === false ? "text-destructive" : "text-[var(--wb-open-fg)]",
      )}
    >
      {mensaje}
    </p>
  );
}
