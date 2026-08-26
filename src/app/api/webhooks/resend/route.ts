/**
 * POST /api/webhooks/resend — lo que Resend cuenta de nuestros correos.
 *
 * Es la última pieza de la cadena del aviso: la cola sabe llegar a SENT («el
 * proveedor nos lo aceptó»), y de aquí en adelante alguien tiene que escuchar
 * si aquello se entregó, rebotó o acabó en la carpeta de correo no deseado.
 *
 * Esta ruta hace SOLO tres cosas —autenticar el mensaje, deduplicarlo y
 * responder—; el significado de cada evento vive en
 * `@/server/notifications/webhook`, que no sabe nada de HTTP y por eso se puede
 * probar sin levantar un servidor.
 *
 * LA RUTA ES PÚBLICA. `src/proxy.ts` deja pasar todo `/api/webhooks/` sin
 * cookie, porque quien llama es una máquina de fuera. Lo que autentica aquí es
 * la FIRMA del cuerpo, no la sesión: sin firma válida no se registra nada, no
 * se consulta la base y no se devuelve ninguna pista.
 */

import { after } from "next/server";
import { Resend } from "resend";

import { prisma } from "@/lib/db";
import { clientIpFromHeaders } from "@/server/auth/login";
import {
  applyDeliveryEvent,
  parseDeliveryEvent,
  recordWebhookEvent,
} from "@/server/notifications/webhook";

/**
 * Node, no Edge: se escribe en PostgreSQL con Prisma y se verifica un HMAC.
 */
export const runtime = "nodejs";

/** Un webhook no se cachea jamás. */
export const dynamic = "force-dynamic";

const SIN_CACHE = {
  "cache-control": "no-store, no-cache, must-revalidate",
} as const;

/**
 * Cliente de Resend usado SOLO para verificar firmas.
 *
 * `webhooks.verify()` es una operación local —HMAC-SHA256 del cuerpo con el
 * secreto DEL WEBHOOK, según el estándar de Standard Webhooks— que no llama a
 * la API ni toca la clave de envío. El constructor del SDK, en cambio, exige
 * una clave y revienta sin ella, así que se le da la que haya en el entorno o
 * un relleno. Ese valor nunca sale de este objeto.
 */
let verificador: Resend | null = null;

function clienteVerificador(): Resend {
  if (verificador === null) {
    verificador = new Resend(
      process.env.RESEND_API_KEY?.trim() || "re_solo_para_verificar_firmas",
    );
  }
  return verificador;
}

/**
 * Respuesta a un cuerpo que no viene de Resend.
 *
 * Vacía y sin explicación a propósito: distinguir «falta la cabecera» de «la
 * firma no cuadra» de «el sello de tiempo caducó» le regala a quien prueba
 * cuerpos al azar el mapa exacto de qué le falta. Y no se registra el cuerpo:
 * cualquiera puede mandar aquí lo que quiera, y guardarlo convertiría esta
 * ruta pública en un buzón de basura ajena dentro de nuestra base.
 */
function firmaInvalida(): Response {
  return new Response(null, { status: 400, headers: SIN_CACHE });
}

function recibido(resultado: string): Response {
  return Response.json({ status: resultado }, { status: 200, headers: SIN_CACHE });
}

/** `type` del cuerpo ya verificado, para guardarlo tal cual en la tabla. */
function tipoDeEvento(evento: unknown): string {
  if (typeof evento === "object" && evento !== null && "type" in evento) {
    const tipo = (evento as { type: unknown }).type;
    if (typeof tipo === "string" && tipo.trim() !== "") return tipo.trim().slice(0, 100);
  }
  return "desconocido";
}

export async function POST(request: Request): Promise<Response> {
  const secreto = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secreto) {
    // 503 y no 500: la ruta existe y el código está bien; lo que falta es
    // configuración del servidor. Además es el código ante el que Resend
    // reintenta, así que en cuanto se ponga el secreto los eventos de estas
    // horas entran solos.
    //
    // El detalle va al registro del servidor —que es privado—, nunca al
    // cuerpo: decirle a quien llama QUÉ variable falta es decirle cómo estamos
    // configurados.
    console.error(
      "[webhooks/resend] falta RESEND_WEBHOOK_SECRET: no se puede verificar la firma",
    );
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: SIN_CACHE },
    );
  }

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) return firmaInvalida();

  // EL CUERPO CRUDO, TAL CUAL LLEGÓ. La firma se calcula sobre estos bytes
  // exactos: pasar por `request.json()` y volver a serializar reordena claves,
  // cambia el escapado de los acentos y recorta espacios, y a partir de ahí la
  // firma no cuadra NUNCA aunque el secreto sea el correcto.
  const cuerpo = await request.text();

  let evento: unknown;
  try {
    evento = clienteVerificador().webhooks.verify({
      payload: cuerpo,
      headers: {
        id: svixId,
        timestamp: svixTimestamp,
        signature: svixSignature,
      },
      webhookSecret: secreto,
    });
  } catch {
    // El error se traga entero: su mensaje distingue los motivos del fallo y
    // no queremos ni devolverlo ni escribirlo con el cuerpo al lado.
    return firmaInvalida();
  }

  // DEDUPLICACIÓN. Resend entrega al menos una vez, así que un evento repetido
  // significa casi siempre que nuestra respuesta anterior se perdió por el
  // camino. Eso no es un error: se responde 200 y no se vuelve a aplicar nada.
  let registro: "nuevo" | "duplicado";
  try {
    registro = await recordWebhookEvent(prisma, {
      svixId,
      eventType: tipoDeEvento(evento),
      payload: evento,
    });
  } catch (error) {
    // Aquí sí conviene fallar: si no se pudo dejar constancia del evento, hay
    // que pedirle a Resend que lo repita. Un 500 provoca justo eso.
    console.error("[webhooks/resend] no se pudo registrar el evento", error);
    return Response.json(
      { status: "error" },
      { status: 500, headers: SIN_CACHE },
    );
  }

  if (registro === "duplicado") return recibido("duplicado");

  const entrega = parseDeliveryEvent(evento);
  // La mayoría de los eventos no son de los nuestros (`email.sent` sale con
  // cada correo, y están además los de contactos y dominios). Se responde 200:
  // el evento llegó perfectamente, simplemente no hay nada que hacer con él.
  if (entrega === null) return recibido("ignorado");

  const ip = clientIpFromHeaders(request.headers);

  // LOS EFECTOS, DESPUÉS DE RESPONDER.
  //
  // Lo único que se hace antes del 200 es guardar el evento crudo, que es UN
  // INSERT. El resto —buscar la fila, marcar al usuario, barrer la cola,
  // anotar en la bitácora— se aplica con la respuesta ya enviada, porque
  // Resend reintenta durante horas si tardamos y una tormenta de rebotes
  // llegaría entonces multiplicada por sus propios reintentos.
  //
  // No se pierde nada aunque esto falle: `webhook_events.payload` guarda el
  // cuerpo íntegro y `applyDeliveryEvent` es idempotente, así que el evento
  // siempre se puede volver a aplicar desde esa fila.
  after(async () => {
    try {
      await applyDeliveryEvent(prisma, entrega, { ip });
    } catch (error) {
      console.error(
        `[webhooks/resend] evento ${svixId} registrado pero SIN aplicar (${entrega.type}); se puede reaplicar desde webhook_events`,
        error,
      );
    }
  });

  return recibido("recibido");
}
