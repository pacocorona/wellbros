/**
 * Grupo autenticado: todo lo que cuelga de (app) exige sesión.
 *
 * Este es el control REAL de acceso. `src/proxy.ts` solo mira que exista la
 * cookie —no puede consultar la base sin arrastrar Prisma a la frontera de
 * red— así que una cookie inventada, caducada o de una cuenta desactivada
 * llega hasta aquí y es aquí donde se rechaza. Aun así, cada página y cada
 * acción vuelven a comprobar lo suyo: un layout no protege una Server Action,
 * que es un endpoint público con su propia puerta.
 *
 * El grupo (app) no añade segmento a la URL: "/" sigue siendo "/".
 */

import { Suspense } from "react";
import { redirect } from "next/navigation";

import { AppNav } from "@/components/app-nav";
import { AvisoDeContrasenaCambiada } from "@/components/force-password-form";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getCurrentSession } from "@/lib/auth";
// El cierre de sesión vive en @/server/actions/profile-actions y no aquí porque
// /cambiar-contrasena —que está FUERA de este grupo, ver más abajo— también lo
// necesita, y era la única salida de esa pantalla: dos copias de «anota LOGOUT,
// borra la sesión, borra la cookie» habrían acabado divergiendo.
import { cerrarSesionAction } from "@/server/actions/profile-actions";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sesion = await getCurrentSession();

  if (!sesion) {
    // Sin `?next=`: un layout de servidor no sabe en qué ruta está (no recibe
    // params ni pathname, y `usePathname` es de cliente). El caso frecuente
    // —entrar sin cookie a una ruta profunda— ya lo resuelve proxy.ts, que sí
    // ve la URL y conserva el destino. Aquí solo caen las cookies inválidas o
    // caducadas, donde volver a la portada es aceptable.
    redirect("/login");
  }

  const { user } = sesion;

  // Puerta del primer acceso. Quien entró con una contraseña que le dictaron no
  // navega a ninguna parte hasta cambiarla.
  //
  // No hace falta comprobar en qué ruta estamos —cosa que un layout de servidor
  // ni siquiera puede saber— porque /cambiar-contrasena vive FUERA del grupo
  // (app): este layout no la envuelve y por tanto nunca se ejecuta durante su
  // render. Si la página estuviera dentro del grupo, esta línea se redirigiría
  // a sí misma en un bucle infinito.
  if (user.mustChangePassword) {
    redirect("/cambiar-contrasena");
  }

  return (
    // Un ÚNICO TooltipProvider para todo el grupo autenticado, igual que el
    // Toaster. Es lo que hace que los globos compartan el retardo de apertura:
    // montado por componente, cada punto del calendario tendría su propio
    // temporizador y recorrer una fila con el ratón sería un parpadeo continuo.
    <TooltipProvider>
      <div className="flex min-h-full flex-1 flex-col">
        <AppNav
          nombre={user.fullName}
          esSuperusuaria={user.role === "SUPERUSER"}
          cerrarSesion={cerrarSesionAction}
        />

        {/* El relleno inferior en móvil deja sitio a la barra fija; en
            escritorio esa barra no existe y sobra. */}
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-24 md:pb-8">
          {children}
        </main>

        {/* Un único Toaster para todo el grupo autenticado. Arriba y centrado:
            en móvil la barra de navegación ocupa el borde inferior y un aviso
            ahí quedaría medio tapado. */}
        <Toaster position="top-center" />

        {/* Después del Toaster, que es quien lo pinta. Lee `?aviso=` de la URL
            y no dibuja nada; el `Suspense` lo exige Next para cualquier
            componente que use `useSearchParams`. */}
        <Suspense fallback={null}>
          <AvisoDeContrasenaCambiada />
        </Suspense>
      </div>
    </TooltipProvider>
  );
}
