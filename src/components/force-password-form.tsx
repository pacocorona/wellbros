"use client";

/**
 * Las dos piezas de cliente del cambio OBLIGATORIO de contraseña:
 *
 *   · `ForcePasswordForm`          — el formulario de /cambiar-contrasena.
 *   · `AvisoDeContrasenaCambiada`  — el aviso que lo remata, ya en el calendario.
 *
 * Viven juntas porque son los dos extremos del mismo trayecto y la señal que
 * las une —el parámetro de la URL— tiene que decir lo mismo en las dos.
 *
 * El formulario no reimplementa nada: llama a
 * `cambiarContrasenaPrimerAccesoAction`, que envuelve a la MISMA acción que usa
 * /perfil y que acaba en `changeOwnPassword`, quien apaga `mustChangePassword`
 * dentro de su transacción. Duplicar la operación para esta pantalla habría
 * significado dos sitios donde recordar apagar el indicador, y uno de los dos
 * se habría quedado sin apagarlo tarde o temprano.
 *
 * Las reglas de la contraseña se enuncian ARRIBA, antes de que la persona
 * escriba. Descubrir el mínimo de caracteres a base de rechazos es exactamente
 * lo que empuja a inventar `Verano2026!` al tercer intento.
 */

import { useActionState, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Info, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cambiarContrasenaPrimerAccesoAction,
  type ContrasenaFormState,
} from "@/server/actions/profile-actions";

/**
 * Mismo mínimo que `changeOwnPassword` (src/server/admin/users.ts), que es
 * quien manda de verdad. Se repite aquí —igual que en profile-form.tsx— porque
 * un módulo "use server" solo puede exportar funciones asíncronas y la
 * constante no puede viajar. Si cambia allá, cambia aquí.
 */
const MIN_CONTRASENA = 12;

/**
 * Señal que la acción deja en la URL del calendario al terminar el cambio.
 *
 * Duplicadas a propósito desde `@/server/actions/profile-actions`, que es quien
 * las escribe: aquel módulo es "use server" y solo puede exportar funciones
 * asíncronas, así que sus constantes no pueden viajar hasta aquí. Si cambian
 * allá, cambian aquí.
 */
const PARAM_AVISO = "aviso";
const AVISO_CONTRASENA_CAMBIADA = "contrasena-cambiada";

const ESTADO_INICIAL: ContrasenaFormState = {
  ok: null,
  mensaje: null,
  errores: {},
  sesionesCerradas: 0,
};

export function ForcePasswordForm() {
  const [estado, enviar, pendiente] = useActionState(
    cambiarContrasenaPrimerAccesoAction,
    ESTADO_INICIAL,
  );

  return (
    <>
      <div className="mb-5 flex gap-2.5 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <p>
            Debe tener <strong>{MIN_CONTRASENA} caracteres o más</strong> y ser distinta de la
            que estás usando.
          </p>
          <p>
            No pedimos mayúsculas ni símbolos: una frase larga que recuerdes —«mi perro duerme
            en el sillón»— protege más que <code>Verano2026!</code>.
          </p>
        </div>
      </div>

      <form action={enviar} className="flex flex-col gap-4">
        <Campo
          id="currentPassword"
          etiqueta="La contraseña con la que acabas de entrar"
          autoComplete="current-password"
          error={estado.errores.currentPassword}
        />
        <Campo
          id="newPassword"
          etiqueta="Tu contraseña nueva"
          autoComplete="new-password"
          minLength={MIN_CONTRASENA}
          error={estado.errores.newPassword}
        />
        <Campo
          id="confirmPassword"
          etiqueta="Repite la contraseña nueva"
          autoComplete="new-password"
          minLength={MIN_CONTRASENA}
          error={estado.errores.confirmPassword}
        />

        {/* Solo los fallos: el éxito lo cuenta el aviso del calendario, y un
            mensaje verde que aparece medio segundo antes de navegar es ruido.
            Altura mínima fija para que el texto no empuje el botón bajo el dedo. */}
        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
          {estado.ok === false ? estado.mensaje : null}
        </p>

        <Button type="submit" size="lg" disabled={pendiente} className="h-10">
          {pendiente ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {pendiente ? "Cambiando…" : "Cambiar contraseña y entrar"}
        </Button>
      </form>
    </>
  );
}

/**
 * Remate del trayecto: ya en el calendario, anuncia que la contraseña cambió.
 *
 * Va montado en el layout del grupo (app) —donde vive el `<Toaster>`— porque la
 * pantalla de cambio está FUERA de ese grupo y no tiene ninguno: un aviso
 * lanzado allí no lo pintaría nadie.
 *
 * Y en cuanto lo lanza, borra el parámetro de la URL. Sin eso, recargar la
 * página, volver atrás o compartir el enlace repetiría el anuncio de algo que
 * pasó una vez y hace rato.
 *
 * No pinta nada: solo el efecto.
 */
export function AvisoDeContrasenaCambiada() {
  const parametros = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const hayAviso = parametros.get(PARAM_AVISO) === AVISO_CONTRASENA_CAMBIADA;

  useEffect(() => {
    if (!hayAviso) return;

    toast.success("Contraseña cambiada", {
      description: "Ya es solo tuya: nadie más la conoce.",
      // Con `id` fijo, un segundo lanzamiento REEMPLAZA al primero en vez de
      // apilar un duplicado. Hace falta: en desarrollo el modo estricto de
      // React monta cada efecto dos veces y sin esto salían dos avisos
      // idénticos, uno encima del otro.
      id: AVISO_CONTRASENA_CAMBIADA,
    });

    // `replace` y no `push`: el paso por la URL con el parámetro no es un sitio
    // al que tenga sentido volver con el botón de atrás.
    router.replace(pathname, { scroll: false });
  }, [hayAviso, router, pathname]);

  return null;
}

function Campo({
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
