/**
 * /api/health — sonda de vida para el monitor externo y para deploy.sh.
 *
 * Comprueba lo único que no se puede fingir: que la base responde. Un proceso
 * de Next vivo con PostgreSQL caído sirve páginas de error, y para el monitor
 * eso debe ser "abajo", no "arriba".
 *
 * El cuerpo es deliberadamente pobre —{"status":"ok"} o {"status":"error"}—
 * porque esta ruta es pública: no lleva versión, ni nombre de host, ni el
 * mensaje del driver. Un fallo de conexión suele traer usuario, base y puerto
 * dentro del texto del error, y esto se responde a cualquiera que lo pida.
 * El detalle va al registro del servidor, que sí es privado.
 *
 * OJO — INTEGRACIÓN: hoy `src/proxy.ts` NO tiene "/api/health" entre sus
 * rutas públicas, así que una petición sin cookie de sesión recibe 401 antes
 * de llegar aquí. Hay que añadirlo a `PUBLIC_PATHS` para que el monitor
 * funcione.
 */

import { prisma } from "@/lib/db";

/**
 * Nunca se cachea: una sonda que devuelve la respuesta de hace diez minutos
 * no es una sonda.
 */
export const dynamic = "force-dynamic";

const SIN_CACHE = {
  "cache-control": "no-store, no-cache, must-revalidate",
} as const;

export async function GET(): Promise<Response> {
  try {
    // `SELECT 1` va y vuelve por el pool: verifica la conexión sin depender
    // de ninguna tabla ni de que las migraciones estén al día.
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok" }, { status: 200, headers: SIN_CACHE });
  } catch (error) {
    console.error("[health] la base no respondió", error);
    // 503 y no 500: el servicio existe, lo que falta es su dependencia. Es lo
    // que esperan los reintentos del monitor y el balanceador.
    return Response.json(
      { status: "error" },
      { status: 503, headers: SIN_CACHE },
    );
  }
}
