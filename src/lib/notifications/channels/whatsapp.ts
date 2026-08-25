/**
 * Canal de WhatsApp: PREPARADO, NO ACTIVO (decisión confirmada, §08).
 *
 * Implementa la interfaz completa para que el resto del sistema —cola, worker,
 * plantillas— ya lo contemple. Mientras `WHATSAPP_ENABLED` no valga "true",
 * `isEnabled()` devuelve false y `dispatch` ni siquiera crea filas para este
 * canal, así que `send()` no debería ejecutarse jamás en producción.
 *
 * QUÉ HACE FALTA PARA ACTIVARLO (es configuración, no desarrollo, salvo el
 * cuerpo de `send()`):
 *
 *  1. Número de empresa dado de alta en WhatsApp Business Cloud API (Meta) y
 *     verificado, con su `WHATSAPP_PHONE_NUMBER_ID` (el identificador del
 *     número emisor, no el número en sí).
 *  2. `WHATSAPP_WABA_ID`: identificador de la cuenta de WhatsApp Business, que
 *     es donde viven las plantillas.
 *  3. `WHATSAPP_ACCESS_TOKEN`: token PERMANENTE de un System User de Meta
 *     Business con permisos `whatsapp_business_messaging` y
 *     `whatsapp_business_management`. Los tokens de usuario normales caducan a
 *     las 24 h o 60 días y no sirven para un servicio desatendido.
 *  4. Plantillas PREAPROBADAS por Meta, una por evento: los mensajes que inicia
 *     el negocio (fuera de la ventana de 24 h de conversación) solo pueden ser
 *     plantillas aprobadas, con sus variables posicionales. Hará falta un mapa
 *     evento → { nombre de plantilla, idioma, orden de variables }; la
 *     configuración no sensible cabe en `notification_channels.config`, las
 *     credenciales solo en variables de entorno.
 *  5. Consentimiento por usuario: `users.whatsapp_opt_in` y `users.phone` en
 *     E.164. `dispatch` ya excluye a quien no los tenga.
 *  6. Endpoint de webhooks para estados de entrega, equivalente al de Resend, y
 *     verificación de firma.
 *
 * Costo de referencia en México: del orden de US$0.01–0.05 por mensaje de
 * utilidad, así que conviene decidir qué eventos lo merecen antes de encender.
 */

import type { ChannelResult, NotificationChannel } from "../types";

export const whatsappChannel: NotificationChannel = {
  key: "WHATSAPP",

  isEnabled(): boolean {
    return process.env.WHATSAPP_ENABLED === "true";
  },

  // Sin parámetro: no hay nada que mirar mientras el canal esté apagado, y la
  // firma sigue siendo compatible con `NotificationChannel`.
  async send(): Promise<ChannelResult> {
    // No reintentable a propósito: si una fila de WhatsApp llegó hasta aquí es
    // porque se encoló con el canal encendido y se apagó después. Reintentar no
    // la va a arreglar; que quede FAILED y visible en el panel de no
    // entregados.
    return { ok: false, retryable: false, error: "canal deshabilitado" };
  },
};
