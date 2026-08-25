/**
 * Adaptador de correo para DESARROLLO.
 *
 * No llama a Resend ni consume cuota (el plan gratuito tope 100 correos al día,
 * §08): imprime un resumen en la terminal y deja el HTML en disco para abrirlo
 * en el navegador y ver el correo tal como lo recibirá el usuario.
 *
 * Este es el ÚNICO archivo del proyecto donde se permite `console.log`: su
 * salida ES el producto del adaptador.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ChannelResult,
  NotificationChannel,
  SendableMessage,
} from "../types";

/** Carpeta del buzón de pruebas, relativa a la raíz del proyecto. */
const BUZON = path.join(".tmp", "emails");

export const consoleEmailChannel: NotificationChannel = {
  key: "EMAIL",

  /**
   * Siempre disponible: es el adaptador de reserva cuando no hay Resend
   * configurado, así que nunca debe apagar la cola en desarrollo.
   */
  isEnabled(): boolean {
    return true;
  },

  async send(msg: SendableMessage): Promise<ChannelResult> {
    const carpeta = path.resolve(process.cwd(), BUZON);
    const archivo = path.join(carpeta, `${msg.id}.html`);

    try {
      await mkdir(carpeta, { recursive: true });
      // Se guarda el HTML EXACTO que saldría por Resend, sin añadir cabeceras
      // de depuración: lo que se ve en el navegador es lo que recibiría el
      // usuario.
      await writeFile(archivo, msg.renderedHtml, "utf8");
    } catch (error) {
      // Un fallo de disco sí es reintentable: no se perdió ningún envío real.
      return {
        ok: false,
        retryable: true,
        error: `No se pudo escribir ${archivo}: ${errorToString(error)}`,
      };
    }

    console.log(
      [
        "",
        "───────────────────────────── correo (desarrollo) ─────────────────────────────",
        `  Para    : ${msg.recipientAddress}`,
        `  Asunto  : ${msg.renderedSubject}`,
        `  Evento  : ${msg.eventType}`,
        `  Clave   : ${msg.dedupeKey}`,
        `  HTML    : ${archivo}`,
        "───────────────────────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );

    // Identificador con prefijo para que sea evidente en la bitácora que ese
    // aviso nunca salió del equipo.
    return { ok: true, providerMessageId: `console:${msg.id}` };
  },
};

function errorToString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
