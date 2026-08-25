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

import { redirect } from "next/navigation";

import { AppNav } from "@/components/app-nav";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  clearSessionCookie,
  destroySession,
  getCurrentSession,
  getSessionCookie,
} from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { clientIpFromHeaders } from "@/server/auth/login";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * Cierra la sesión de este dispositivo (no las demás) y anota LOGOUT.
 *
 * Se anota ANTES de borrar: si la bitácora falla, no ha pasado nada y no hay
 * hecho sin registrar. No comparten transacción porque `destroySession` es
 * del contrato de @/lib/auth y trabaja con el cliente global; borrar la fila
 * a mano aquí exigiría duplicar el hash del token, que es interno a ese
 * módulo.
 *
 * La cookie se borra pase lo que pase con la fila: quien pulsó "salir" queda
 * fuera, y una sesión huérfana la barre `purgeExpiredSessions`.
 */
async function cerrarSesion(): Promise<void> {
  "use server";

  const token = await getSessionCookie();
  const sesion = await getCurrentSession();

  if (token && sesion) {
    const cabeceras = await headers();
    await writeAudit(prisma, {
      action: "LOGOUT",
      entityType: "SESSION",
      entityId: sesion.sessionId,
      actorUserId: sesion.user.id,
      details: { email: sesion.user.email },
      ip: clientIpFromHeaders(cabeceras),
    });
    await destroySession(token);
  }

  await clearSessionCookie();
  redirect("/login");
}

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
          cerrarSesion={cerrarSesion}
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
      </div>
    </TooltipProvider>
  );
}
