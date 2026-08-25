/**
 * /cambiar-contrasena — la pantalla del primer acceso.
 *
 * A quien recibió una contraseña puesta por otra persona (la superusuaria que
 * siembra la base, o un alta desde Configuración con contraseña temporal) se le
 * trae aquí y no se le deja salir hasta que elija la suya. Quien la dictó la
 * sabe, y muy probablemente quedó escrita en el mensaje donde se envió.
 *
 * POR QUÉ ESTÁ FUERA DEL GRUPO (app), que es donde vive todo lo demás:
 * el layout de ese grupo es justo la puerta que manda aquí. Si esta página
 * colgara de él, el layout se ejecutaría también al renderizarla, volvería a
 * ver el indicador encendido y redirigiría a sí misma sin fin. Al quedar fuera,
 * ese layout no la envuelve y el bucle no existe.
 *
 * El precio de estar fuera es que aquí no hay sesión resuelta por nadie: la
 * página la resuelve por su cuenta, como hace /login. `src/proxy.ts` sí la
 * cubre —no es ruta pública— pero eso solo comprueba que la cookie EXISTA, que
 * no autentica a nadie.
 *
 * La pantalla es deliberadamente pobre: sin barra de navegación y sin más
 * botones que el cambio y «Cerrar sesión». Si hubiera un enlace al calendario,
 * llevaría a un rebote inmediato.
 */

import { redirect } from "next/navigation";
import { LogOut, ShieldAlert } from "lucide-react";

import { ForcePasswordForm } from "@/components/force-password-form";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth";
import { cerrarSesionAction } from "@/server/actions/profile-actions";

/** Depende de la sesión en curso: nunca de caché. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Cambia tu contraseña · Wellbros" };

export default async function CambiarContrasenaPage() {
  const usuario = await getCurrentUser();

  if (!usuario) {
    // Sin `?next=`: no hace falta conservar el destino. Al entrar, la puerta del
    // grupo (app) vuelve a ver el indicador y trae aquí de nuevo por su cuenta.
    redirect("/login");
  }

  if (!usuario.mustChangePassword) {
    // Llegó a mano —un enlace guardado, el botón de atrás tras cambiarla— y no
    // hay nada que obligar. Se le manda a /perfil y no al calendario porque es
    // el sitio donde SÍ puede cambiar la contraseña cuando quiera: quien teclea
    // esta dirección casi siempre viene buscando eso.
    redirect("/perfil");
  }

  return (
    <div className="flex min-h-full flex-1 items-start justify-center px-4 py-10 sm:items-center sm:py-16">
      <div className="w-full max-w-sm">
        <header className="mb-6 flex flex-col items-center gap-3 text-center">
          <span
            className="flex size-11 items-center justify-center rounded-full bg-[var(--wb-accent-soft)] text-[var(--wb-accent-ink)]"
            aria-hidden
          >
            <ShieldAlert className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Cambia tu contraseña</h1>
          {/* El porqué, en una línea. Sin esto, la pantalla parece un trámite
              arbitrario y lo que se aprende es a odiarla, no a cuidarse. */}
          <p className="text-sm text-muted-foreground">
            Entraste con una contraseña que te dio otra persona, así que ahora mismo no eres
            la única que la conoce. Elige la tuya y lo serás.
          </p>
        </header>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <ForcePasswordForm />
        </div>

        {/* Única salida alternativa. No es un escape del cambio —al volver a
            entrar se cae aquí otra vez— sino la respuesta a «me equivoqué de
            cuenta» o «esta no es mi computadora». */}
        <form action={cerrarSesionAction} className="mt-4 flex justify-center">
          <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
            <LogOut className="size-4" aria-hidden />
            Cerrar sesión
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Entraste como <strong className="font-medium">{usuario.email}</strong>.
        </p>
      </div>
    </div>
  );
}
