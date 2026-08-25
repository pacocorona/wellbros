/**
 * Adaptador de correo real, sobre el SDK oficial de Resend.
 *
 * Dos particularidades del SDK que condicionan todo este archivo:
 *
 *  1. NO lanza excepciones ante un error de la API: devuelve `{ data, error }`
 *     y hay que mirar `error` explícitamente. Un `try/catch` solo alrededor de
 *     la llamada dejaría pasar todos los fallos como si fueran éxitos.
 *  2. La clave de idempotencia va en el SEGUNDO argumento, no en el cuerpo.
 *
 * VENTANA DE IDEMPOTENCIA — 24 HORAS. Resend recuerda una `Idempotency-Key`
 * durante 24 h: dentro de ese plazo, repetir la petición devuelve la respuesta
 * original sin volver a enviar el correo. Pasado ese plazo la clave se olvida y
 * el mismo reintento SÍ generaría un correo duplicado. De ahí que el worker
 * abandone la fila antes de las 24 h (a las 20) en lugar de reintentar a
 * ciegas. Corolario: el cuerpo debe ser idéntico byte a byte entre reintentos
 * —el worker lo congela en la fila—; si difiere, Resend responde
 * `invalid_idempotent_request` en vez de reenviar.
 */

import { Resend } from "resend";

import type {
  ChannelResult,
  NotificationChannel,
  SendableMessage,
} from "../types";

/** Cliente perezoso: el worker vive horas, no conviene rehacerlo por envío. */
let cliente: Resend | null = null;

function getCliente(apiKey: string): Resend {
  if (!cliente) cliente = new Resend(apiKey);
  return cliente;
}

function replyTo(): string | undefined {
  const valor = process.env.RESEND_REPLY_TO?.trim();
  return valor ? valor : undefined;
}

/**
 * Códigos de error de Resend que merecen otro intento.
 *
 * Criterio: reintentable = el mismo envío puede salir bien más tarde sin
 * cambiar nada. Los errores de validación (remitente inválido, campo faltante)
 * no mejoran con el tiempo y solo gastarían intentos.
 */
const CODIGOS_REINTENTABLES: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "internal_server_error",
  "application_error",
  // Otra petición con la misma clave está en vuelo: esperar y repetir es
  // exactamente lo correcto.
  "concurrent_idempotent_requests",
]);

function esReintentable(statusCode: number | null, name: string): boolean {
  if (CODIGOS_REINTENTABLES.has(name)) return true;
  // 429 (límite de 10 peticiones por segundo) y cualquier 5xx del proveedor.
  if (statusCode === 429) return true;
  if (statusCode !== null && statusCode >= 500) return true;
  // Sin código: el SDK no llegó a hablar con la API (DNS, red, timeout).
  // Se reintenta porque probablemente el correo no salió, y si salió, la clave
  // de idempotencia evita el duplicado.
  if (statusCode === null) return true;
  return false;
}

export const resendEmailChannel: NotificationChannel = {
  key: "EMAIL",

  /**
   * Solo se considera activo con driver `resend` y credenciales completas.
   * Sin remitente verificado Resend responde 403 a cualquier destinatario que
   * no sea el dueño de la cuenta (§08), así que encolar sería tirar avisos.
   */
  isEnabled(): boolean {
    return (
      process.env.EMAIL_DRIVER === "resend" &&
      Boolean(process.env.RESEND_API_KEY?.trim()) &&
      Boolean(process.env.RESEND_FROM?.trim())
    );
  },

  async send(msg: SendableMessage): Promise<ChannelResult> {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.RESEND_FROM?.trim();
    if (!apiKey || !from) {
      return {
        ok: false,
        retryable: false,
        error: "Faltan RESEND_API_KEY o RESEND_FROM",
      };
    }

    try {
      const { data, error } = await getCliente(apiKey).emails.send(
        {
          from,
          to: [msg.recipientAddress],
          replyTo: replyTo(),
          subject: msg.renderedSubject,
          html: msg.renderedHtml,
          text: msg.renderedText,
          headers: {
            // Gmail agrupa (y llega a ocultar) mensajes con asunto repetido;
            // esta cabecera los mantiene como conversaciones separadas.
            "X-Entity-Ref-ID": msg.dedupeKey,
          },
        },
        // Clave de idempotencia: la misma que identifica la fila en la cola.
        { idempotencyKey: msg.dedupeKey },
      );

      if (error) {
        return {
          ok: false,
          retryable: esReintentable(error.statusCode, error.name),
          error: `${error.name}${error.statusCode === null ? "" : ` (${error.statusCode})`}: ${error.message}`,
        };
      }

      if (!data) {
        // No debería ocurrir: el contrato es `data` o `error`, nunca ninguno.
        return {
          ok: false,
          retryable: true,
          error: "Resend respondió sin datos ni error",
        };
      }

      return { ok: true, providerMessageId: data.id };
    } catch (error) {
      // El SDK no lanza por errores de la API, pero sí puede propagar fallos
      // del entorno (fetch abortado, DNS). Se tratan como reintentables.
      return {
        ok: false,
        retryable: true,
        error: `Fallo de red hablando con Resend: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};
