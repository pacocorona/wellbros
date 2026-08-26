"use client";

/**
 * Formulario de canje de la invitación: la primera pantalla que ve alguien de
 * Wellbros, y la única en la que elige su contraseña sin conocer ninguna otra.
 *
 * Es de cliente porque necesita `useActionState` para enseñar los errores por
 * campo sin recargar; la acción la define la página (`/invitacion/[token]`),
 * que es de servidor y es quien tiene el token. Mismo reparto que /login.
 *
 * Aquí NO se valida nada de verdad: la longitud mínima y la coincidencia se
 * repiten en el servidor, que es quien manda. Lo de este lado sirve para no
 * gastar un viaje y para que el navegador ayude con `minLength`.
 *
 * Las reglas se enuncian ARRIBA, antes de escribir. Descubrir el mínimo a base
 * de rechazos es justo lo que empuja a inventar `Verano2026!` al tercer intento.
 */

import { useActionState } from "react";
import { Info, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Mismo mínimo que el servidor (`MIN_CONTRASENA` en src/server/admin/users.ts,
 * y el esquema de la propia página). Se repite aquí —igual que en
 * force-password-form.tsx y profile-form.tsx— porque un módulo "use server"
 * solo puede exportar funciones asíncronas y la constante no puede viajar. Si
 * cambia allá, cambia aquí.
 */
const MIN_CONTRASENA = 12;

type Campo = "fullName" | "password" | "confirmPassword";

export interface EstadoInvitacion {
  /** `null` mientras no se haya enviado nada. Nunca es `true`: el éxito navega. */
  ok: boolean | null;
  /** Mensaje general, ya redactado en español y apto para mostrarse tal cual. */
  mensaje: string | null;
  errores: Partial<Record<Campo, string>>;
  /** Lo escrito en el nombre: vuelve para no obligar a reteclearlo tras un fallo. */
  fullName: string;
}

export function estadoInicialInvitacion(fullName: string): EstadoInvitacion {
  return { ok: null, mensaje: null, errores: {}, fullName };
}

export interface AceptarInvitacionFormProps {
  action: (
    estadoPrevio: EstadoInvitacion,
    formData: FormData,
  ) => Promise<EstadoInvitacion>;
  /** Nombre con el que la administración dio de alta la cuenta. Se puede corregir. */
  nombreInicial: string;
  /** Solo se muestra: el correo es la identidad de la cuenta y no se cambia aquí. */
  correo: string;
}

export function AceptarInvitacionForm({
  action,
  nombreInicial,
  correo,
}: AceptarInvitacionFormProps) {
  const [estado, enviar, pendiente] = useActionState(
    action,
    estadoInicialInvitacion(nombreInicial),
  );

  return (
    <>
      <div className="mb-5 flex gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <p>
            La contraseña debe tener <strong>{MIN_CONTRASENA} caracteres o más</strong>.
          </p>
          <p>
            No pedimos mayúsculas ni símbolos: una frase larga que recuerdes —«mi perro duerme
            en el sillón»— protege más que <code>Verano2026!</code>.
          </p>
        </div>
      </div>

      <form action={enviar} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="correo-invitacion">Tu correo</Label>
          {/* Deshabilitado y sin `name`: se enseña para que se vea a qué cuenta
              pertenece el enlace, pero no viaja ni se puede tocar. Quien manda
              es el token, no este campo. */}
          <Input
            id="correo-invitacion"
            type="email"
            value={correo}
            disabled
            readOnly
            className="h-10"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fullName">Tu nombre completo</Label>
          <Input
            id="fullName"
            name="fullName"
            type="text"
            autoComplete="name"
            required
            minLength={3}
            maxLength={120}
            defaultValue={estado.fullName}
            aria-invalid={estado.errores.fullName ? true : undefined}
            aria-describedby={estado.errores.fullName ? "error-fullName" : undefined}
            className="h-10"
          />
          {estado.errores.fullName ? (
            <p id="error-fullName" className="text-xs text-destructive">
              {estado.errores.fullName}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Es el nombre que verá el resto de la familia en el calendario.
            </p>
          )}
        </div>

        <Campo
          id="password"
          etiqueta="Elige tu contraseña"
          error={estado.errores.password}
        />
        <Campo
          id="confirmPassword"
          etiqueta="Repite la contraseña"
          error={estado.errores.confirmPassword}
        />

        {/* Solo los fallos: el éxito no se anuncia aquí porque para entonces ya
            estamos en el calendario. Altura mínima fija para que el texto no
            empuje el botón bajo el dedo. */}
        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
          {estado.ok === false ? estado.mensaje : null}
        </p>

        <Button type="submit" size="lg" disabled={pendiente} className="h-10">
          {pendiente ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {pendiente ? "Creando tu acceso…" : "Crear mi contraseña y entrar"}
        </Button>
      </form>
    </>
  );
}

function Campo({
  id,
  etiqueta,
  error,
}: {
  id: "password" | "confirmPassword";
  etiqueta: string;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{etiqueta}</Label>
      <Input
        id={id}
        name={id}
        type="password"
        // `new-password` en los dos: es lo que hace que el gestor de
        // contraseñas ofrezca generar una y guardarla, en vez de intentar
        // rellenar con alguna vieja.
        autoComplete="new-password"
        required
        minLength={MIN_CONTRASENA}
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
