/**
 * /login — única ruta pública de la aplicación (no hay registro).
 *
 * La página resuelve la sesión y define la acción; el formulario en sí es un
 * componente de cliente (./login-form) porque necesita `useActionState` para
 * mostrar el error sin recargar.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { ThemeToggle } from "@/components/theme-toggle";
import { getCurrentUser, setSessionCookie } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { clientIpFromHeaders, login } from "@/server/auth/login";

import { LoginForm, type LoginFormState } from "./login-form";

/**
 * Un único mensaje para todos los fallos posibles. Ver el comentario de
 * `login()`: distinguirlos revelaría qué correos existen y cuáles están
 * desactivados.
 */
const MENSAJE_GENERICO =
  "No pudimos iniciar sesión con esos datos. Revísalos e inténtalo de nuevo.";

/**
 * Convierte el `?next=` recibido en una ruta interna segura.
 *
 * Sin esto tendríamos un open redirect de manual: un correo con
 * `/login?next=https://sitio-falso.example` mandaría a la persona fuera del
 * sitio justo después de escribir su contraseña. Se exige que empiece por una
 * sola barra; `//otro-sitio` y `/\otro-sitio` son URLs con host para el
 * navegador, no rutas.
 */
function destinoSeguro(valor: string | undefined): string {
  if (!valor || !valor.startsWith("/")) return "/";
  if (valor.startsWith("//") || valor.startsWith("/\\")) return "/";
  return valor;
}

function primerValor(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parametros = await searchParams;
  const destino = destinoSeguro(primerValor(parametros.next));

  // Quien ya entró no tiene nada que hacer aquí.
  const usuario = await getCurrentUser();
  if (usuario) redirect(destino);

  async function iniciarSesion(
    _estadoPrevio: LoginFormState,
    formData: FormData,
  ): Promise<LoginFormState> {
    "use server";

    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    // El destino se revalida aquí: llega en un campo oculto y por tanto es
    // dato del cliente, manipulable.
    const aDonde = destinoSeguro(String(formData.get("next") ?? ""));

    const cabeceras = await headers();
    const resultado = await login(prisma, {
      email,
      password,
      ip: clientIpFromHeaders(cabeceras),
      userAgent: cabeceras.get("user-agent"),
    });

    if (!resultado.ok) {
      // El motivo real ya quedó en la bitácora; hacia fuera, siempre lo mismo.
      return { error: MENSAJE_GENERICO, email };
    }

    await setSessionCookie(
      resultado.session.token,
      resultado.session.expiresAt,
    );

    // `redirect` funciona lanzando una excepción de control: tiene que quedar
    // fuera de cualquier try/catch o se tragaría la navegación.
    redirect(aDonde);
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>

      <main className="flex flex-1 items-start justify-center px-4 pb-16 sm:items-center">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--wb-accent-ink)]">
              Wellbros
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Reserva de semanas en las propiedades compartidas.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <LoginForm action={iniciarSesion} destino={destino} />
          </div>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            ¿Sin acceso? La administración crea las cuentas.
          </p>
        </div>
      </main>
    </div>
  );
}
