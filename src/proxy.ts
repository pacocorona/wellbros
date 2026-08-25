/**
 * Filtro de rutas (antes «middleware»).
 *
 * ATENCIÓN — ESTO NO AUTENTICA A NADIE.
 * Lo único que hace es comprobar que EXISTE la cookie de sesión. No mira si el
 * token es válido, ni si la sesión caducó, ni qué rol tiene el usuario, ni si
 * la cuenta sigue activa. Cualquiera puede fabricarse una cookie con ese
 * nombre y pasar de aquí. La autenticación real ocurre siempre en el servidor,
 * con `requireUser()` / `requireSuperuser()` de `@/lib/auth`, y toda página o
 * ruta protegida DEBE llamarlas. Esto es solo un atajo para redirigir pronto a
 * /login y evitar el parpadeo de cargar una página que igual va a rebotar.
 *
 * Por qué no valida de verdad: este archivo se ejecuta en la frontera de red,
 * antes del render, y la propia documentación de Next pide no apoyarlo en
 * módulos compartidos ni en estado global. Abrir aquí una conexión a
 * PostgreSQL significaría una consulta por cada petición —incluidas las de
 * recursos— y un cliente de Prisma viviendo en la capa equivocada. Por eso ni
 * siquiera se importa `@/lib/auth`: arrastraría Prisma a este bundle.
 *
 * Nota de versión: en Next.js 16 `middleware.ts` quedó obsoleto y se renombró
 * a `proxy.ts` (misma funcionalidad, otro nombre de archivo y de función).
 * Tener los dos archivos a la vez rompe la compilación: si alguien recupera un
 * `middleware.ts`, hay que borrar este.
 */

import { NextResponse, type NextRequest } from "next/server";

/**
 * Duplicado a propósito de `SESSION_COOKIE_NAME` en `@/lib/auth/session`:
 * importarlo traería Prisma y `node:crypto` a este archivo. Si cambia allá,
 * cambia aquí.
 */
const SESSION_COOKIE_NAME = "wellbros_session";

/** Rutas accesibles sin sesión (coincidencia exacta). */
// `/api/health` lo consultan el monitor externo y deploy.sh, que no tienen
// cookie. Sin él aquí, ambos verían la plataforma caída justo cuando está sana.
// Su manejador ya cuida de no filtrar detalles internos en la respuesta.
const PUBLIC_PATHS = new Set(["/login", "/api/health"]);

/**
 * Prefijos públicos. Los webhooks de Resend llegan de fuera, sin cookie: se
 * autentican con la firma de Svix en su propio manejador.
 */
const PUBLIC_PREFIXES = ["/api/webhooks/"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const hasSessionCookie = Boolean(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );

  if (hasSessionCookie) return NextResponse.next();

  // A una API se le responde 401; redirigir un fetch a una página HTML solo
  // produce errores de parseo confusos en el cliente.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "UNAUTHENTICATED", message: "Necesitas iniciar sesión." },
      { status: 401 },
    );
  }

  const loginUrl = new URL("/login", request.url);
  // Se conserva el destino para volver tras el login. Siempre es una ruta
  // relativa de este sitio; aun así la página de /login debe validar que
  // empiece por "/" y no por "//" antes de redirigir, o sería un open redirect.
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", `${pathname}${search}`);
  }

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /**
     * Todo salvo los estáticos de Next, el favicon y cualquier archivo con
     * extensión (imágenes, fuentes, manifiestos). Sin esta exclusión, la
     * redirección a /login también se llevaría por delante el CSS y el JS.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)",
  ],
};
