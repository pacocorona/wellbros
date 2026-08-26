/**
 * /api/events — el calendario en vivo (SSE).
 *
 * Mantiene abierta una conexión por pestaña y le va soltando avisos de «algo
 * cambió en la propiedad X». El cliente (`@/lib/use-live-calendar`) revalida su
 * vista cuando el aviso es de la propiedad que está mirando.
 *
 * POR QUÉ SSE Y NO WEBSOCKET (§04 del diseño). El flujo es de ida: el servidor
 * avisa y ya está; todo lo que hace el usuario —reservar, ceder, cancelar—
 * viaja por peticiones normales. Un WebSocket daría la misma latencia a cambio
 * de otro protocolo que configurar en nginx, otro camino que autenticar y una
 * reconexión que habría que escribir a mano. SSE es HTTP: la cookie de sesión
 * viaja sola, nginx solo necesita dejar de bufferizar y el navegador reconecta
 * él solito.
 *
 * LO QUE VIAJA ES `{ propertyId, ts }` Y NADA MÁS. Ni el estado de la semana,
 * ni quién reservó, ni las cesiones. Dos razones, y la segunda es la de peso:
 *   · el cliente revalida por su cuenta y recibe los datos por el camino de
 *     siempre, que ya aplica los permisos de quien mira;
 *   · si el flujo llevara datos, habría que decidir aquí —con la conexión ya
 *     abierta y sin saber qué está mirando cada quien— qué puede ver cada
 *     suscriptor. Un aviso mudo no puede filtrar nada.
 *
 * ⚠ PRODUCCIÓN — nginx: el bloque `location /api/events` de
 * `deploy/nginx/wellbros.conf` está COMENTADO. Sin él, nginx bufferiza la
 * respuesta y corta a los 60 s: los eventos se quedan retenidos y el calendario
 * parece muerto aunque este código funcione. La cabecera `X-Accel-Buffering: no`
 * que se manda abajo cubre el buffering, pero NO el `proxy_read_timeout`. Hay
 * que descomentar ese bloque y recargar nginx.
 */

import { getCurrentUser } from "@/lib/auth";
import {
  suscribirseACambios,
  type CambioDeCalendario,
} from "@/server/notifications/bus";

/**
 * Node explícito. La ruta vive de un `ReadableStream` de larga duración, del
 * bus en memoria del proceso y de la sesión resuelta contra PostgreSQL: nada de
 * eso funciona en un entorno de vida corta.
 */
export const runtime = "nodejs";

/** Un flujo de eventos jamás se prerrenderiza ni se cachea. */
export const dynamic = "force-dynamic";

/**
 * Latido cada 25 s.
 *
 * No es para el navegador —EventSource aguanta el silencio sin problema— sino
 * para todo lo que hay en medio. nginx corta a los 60 s de inactividad con su
 * `proxy_read_timeout` por defecto, y las NAT de las operadoras móviles suelen
 * ser aún menos pacientes. Cualquier byte reinicia esos relojes; se manda un
 * comentario SSE (una línea que empieza por `:`), que el cliente ignora por
 * especificación y no dispara ningún evento.
 *
 * 25 s deja margen de sobra bajo cualquiera de esos límites.
 */
const LATIDO_MS = 25_000;

/**
 * Cuánto espera el navegador antes de reconectar tras una caída. Va en el
 * primer bloque del flujo (`retry:`) y el navegador lo recuerda entre intentos.
 * Cinco segundos: rápido para que una recarga del servidor pase inadvertida,
 * lento para que cien pestañas no lo tumben al arrancar.
 */
const REINTENTO_MS = 5_000;

const CABECERAS_SSE = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Connection: "keep-alive",
  /**
   * La que de verdad importa detrás de nginx: sin ella el proxy acumula la
   * respuesta en su búfer y no suelta nada hasta llenarlo o hasta que el flujo
   * termine —que es nunca—. Es una instrucción para nginx, no para el
   * navegador, y por eso no basta con configurar solo el `location`.
   */
  "X-Accel-Buffering": "no",
} as const;

/** Un bloque SSE con nombre de evento. La línea en blanco final es obligatoria. */
function bloqueSSE(evento: string, datos: unknown): string {
  return `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
}

export async function GET(request: Request): Promise<Response> {
  /**
   * SESIÓN OBLIGATORIA. `src/proxy.ts` ya rebota lo que llega sin cookie, pero
   * eso solo comprueba que la cookie EXISTA: cualquiera puede fabricarse una
   * con ese nombre. La comprobación de verdad es esta, y es la que decide que
   * un anónimo no reciba ni un latido.
   */
  const usuario = await getCurrentUser();
  if (!usuario) {
    return Response.json(
      { error: "UNAUTHENTICATED", message: "Necesitas iniciar sesión." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const codificador = new TextEncoder();

  /**
   * La limpieza se guarda fuera del `start` para que `cancel` —que se dispara
   * cuando quien consume el flujo lo suelta— pueda ejecutar exactamente la
   * misma rutina. Hay dos caminos por los que se puede ir un cliente y ninguno
   * puede quedarse sin desmontar la suscripción.
   */
  let limpiar: () => void = () => {};

  const flujo = new ReadableStream<Uint8Array>({
    start(controller) {
      let vivo = true;
      let desuscribir: (() => void) | null = null;
      let latido: ReturnType<typeof setInterval> | null = null;

      /**
       * Cierra TODO: la suscripción al bus, el latido y el flujo.
       *
       * Es la pieza crítica de esta ruta. Sin ella, cada pestaña que se cierra
       * deja un oyente vivo en el bus reteniendo por clausura su controlador
       * muerto, y a cada publicación se le vuelve a llamar. En un servicio que
       * lleva semanas en pie eso es una fuga de memoria que crece sola y no
       * avisa. Es idempotente: se la puede llamar tantas veces como haga falta.
       */
      const cerrar = () => {
        if (!vivo) return;
        vivo = false;

        if (desuscribir) {
          desuscribir();
          desuscribir = null;
        }
        if (latido) {
          clearInterval(latido);
          latido = null;
        }
        request.signal.removeEventListener("abort", cerrar);

        try {
          controller.close();
        } catch {
          // Ya estaba cerrado: es el caso normal cuando el cliente colgó
          // primero. No hay nada que registrar.
        }
      };

      const enviar = (texto: string) => {
        if (!vivo) return;
        try {
          controller.enqueue(codificador.encode(texto));
        } catch {
          // Escribir en un flujo que el cliente ya abandonó lanza. Es la señal
          // más fiable de que se fue —a veces llega antes que el abort— así que
          // se aprovecha para soltar la suscripción en el acto.
          cerrar();
        }
      };

      // El cliente pudo colgar mientras se resolvía la sesión. Se comprueba
      // antes de suscribirse: si no, el oyente se registraría para nadie y solo
      // lo retiraría un evento de abort que ya pasó.
      if (request.signal.aborted) {
        cerrar();
        return;
      }

      request.signal.addEventListener("abort", cerrar);

      desuscribir = suscribirseACambios((cambio: CambioDeCalendario) => {
        enviar(bloqueSSE("cambio", cambio));
      });

      latido = setInterval(() => {
        // Comentario SSE: mantiene viva la conexión sin generar un evento.
        enviar(`: latido ${Date.now()}\n\n`);
      }, LATIDO_MS);

      // Primer bloque, inmediato. Cumple tres cosas de golpe: fija el tiempo de
      // reconexión, dispara el `onopen` del cliente (que es como sabe que está
      // en vivo y puede apagar su respaldo) y fuerza el envío de cabeceras, con
      // lo que cualquier proxy que fuera a bufferizar se delata ya.
      enviar(`retry: ${REINTENTO_MS}\n\n`);
      enviar(bloqueSSE("listo", { ts: Date.now() }));

      limpiar = cerrar;
    },

    cancel() {
      limpiar();
    },
  });

  return new Response(flujo, { status: 200, headers: CABECERAS_SSE });
}
