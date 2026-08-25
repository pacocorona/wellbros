"use client";

/**
 * Formulario de acceso.
 *
 * Vive en un archivo aparte de page.tsx porque necesita `useActionState`
 * —un hook, y por tanto cliente— mientras que la página tiene que seguir
 * siendo de servidor para resolver la sesión y definir la acción.
 *
 * El mensaje de error es SIEMPRE el mismo, venga de un correo que no existe,
 * de una contraseña equivocada, de una cuenta desactivada o de demasiados
 * intentos. Decir cuál de los cuatro fue equivale a regalar una lista de
 * correos válidos.
 */

import { useActionState } from "react";
import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface LoginFormState {
  /** Nulo mientras no haya fallado nada. */
  error: string | null;
  /** Se devuelve para no obligar a reescribirlo. La contraseña nunca vuelve. */
  email: string;
}

export const ESTADO_INICIAL: LoginFormState = { error: null, email: "" };

export interface LoginFormProps {
  action: (
    estadoPrevio: LoginFormState,
    formData: FormData,
  ) => Promise<LoginFormState>;
  /** Ruta a la que volver tras entrar, ya validada en el servidor. */
  destino: string;
}

export function LoginForm({ action, destino }: LoginFormProps) {
  const [estado, enviar, pendiente] = useActionState(action, ESTADO_INICIAL);

  return (
    <form action={enviar} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={destino} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Correo</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={estado.email}
          aria-invalid={estado.error ? true : undefined}
          className="h-10"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Contraseña</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={estado.error ? true : undefined}
          className="h-10"
        />
      </div>

      {/* `aria-live` para que el lector de pantalla lo anuncie sin que la
          persona tenga que ir a buscarlo. */}
      <p
        role="alert"
        aria-live="polite"
        className="min-h-5 text-sm text-destructive"
      >
        {estado.error}
      </p>

      <Button type="submit" size="lg" disabled={pendiente} className="h-10">
        <LogIn className="size-4" aria-hidden />
        {pendiente ? "Entrando…" : "Entrar"}
      </Button>
    </form>
  );
}
