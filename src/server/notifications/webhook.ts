/**
 * Webhook de Resend: qué pasó con el correo DESPUÉS de que lo aceptaran.
 *
 * Cierra la cadena del aviso. Hasta aquí la cola sabía llegar a SENT, que solo
 * significa «Resend nos lo aceptó»; si la dirección no existía, si el buzón
 * estaba lleno o si la persona marcaba el aviso como correo no deseado, nadie
 * se enteraba. Este módulo convierte esos avisos del proveedor en dos hechos
 * que la aplicación sí sabe usar: el desenlace de la fila (`delivery_state`) y
 * el estado de la dirección de esa persona (`users.email_bounced_at`,
 * `users.email_complained_at`).
 *
 * FUNCIÓN PURA DE FRAMEWORK, igual que el resto de src/server: recibe el
 * cliente de Prisma y un evento YA VERIFICADO. No sabe nada de `Request`, ni de
 * cabeceras, ni de firmas — eso es cosa de la ruta. Así el mapeo se prueba sin
 * levantar un servidor y, si mañana el mismo evento llega por otro camino
 * (una reconciliación nocturna, un reenvío manual), se aplica igual.
 *
 * IDEMPOTENTE POR CONSTRUCCIÓN. La deduplicación por `svix-id` evita el trabajo
 * repetido, pero no se confía en ella para la corrección: aplicar dos veces el
 * mismo evento no cambia nada (ver `supersedes` y los `updateMany` con la
 * condición «todavía nulo»). Eso es lo que permite REPARAR a mano: el cuerpo
 * íntegro de cada evento queda en `webhook_events.payload`, así que un fallo al
 * aplicar los efectos siempre se puede volver a intentar desde ahí sin miedo a
 * duplicar marcas ni entradas de bitácora.
 */

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import type { DeliveryState } from "@/generated/prisma/enums";
import type { AuditAction, AuditDetails } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import type { Db } from "@/lib/db";
import type { NotificationEventType } from "@/lib/notifications/types";

// ─────────────────────────────────────────────────────── eventos tratados

/**
 * Los cinco eventos de correo que cambian algo por aquí.
 *
 * Resend manda muchos más (`email.sent`, `email.opened`, `email.clicked`,
 * `contact.*`, `domain.*`…). Se ignoran a propósito y sin ruido: apertura y
 * clic exigirían píxel de rastreo y enlaces reescritos, que es justo lo que
 * este proyecto NO hace con el correo de una familia.
 */
export const DELIVERY_EVENT_TYPES = [
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
] as const;

export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

/** El evento del proveedor reducido a lo que esta capa necesita. */
export type DeliveryEvent = {
  type: DeliveryEventType;
  /** `data.email_id`: lo que el worker guardó en `provider_message_id`. */
  emailId: string;
  /** Primer destinatario según el proveedor. Solo se usa si no hay fila. */
  address: string | null;
  /** `Permanent` | `Transient` | `Undetermined`, tal cual lo manda Resend. */
  bounceType: string | null;
  /** Motivo en palabras del proveedor, ya recortado. */
  detail: string | null;
};

/** Lo que `delivery_detail` admite sin volverse ilegible en la pantalla. */
const MAX_DETALLE = 500;

/**
 * Forma del cuerpo, comprobada en tiempo de ejecución.
 *
 * El SDK de Resend TIPA el resultado de `webhooks.verify()` como
 * `WebhookEventPayload`, pero por dentro solo hace `JSON.parse`: el tipo es una
 * promesa del compilador sobre datos que llegan de la red. La firma garantiza
 * el ORIGEN del cuerpo, no su FORMA —y una versión nueva del proveedor puede
 * cambiarla—. Por eso se valida aquí antes de tocar la base.
 */
const ESQUEMA_EVENTO = z.object({
  type: z.enum(DELIVERY_EVENT_TYPES),
  data: z.object({
    email_id: z.string().trim().min(1),
    to: z.array(z.string()).optional(),
    // Solo viene en `email.bounced`.
    bounce: z
      .object({
        type: z.string().optional(),
        subType: z.string().optional(),
        message: z.string().optional(),
      })
      .optional(),
    // Solo viene en `email.failed`.
    failed: z.object({ reason: z.string().optional() }).optional(),
  }),
});

function recorta(texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === "") return null;
  return limpio.slice(0, MAX_DETALLE);
}

/**
 * Traduce el cuerpo verificado a un `DeliveryEvent`, o devuelve `null`.
 *
 * `null` NO es un error: significa «este evento no es de los nuestros», que es
 * el caso de la mayoría (cada correo genera al menos un `email.sent`). La ruta
 * responde 200 igual, porque el evento llegó bien; lo que no hay es nada que
 * hacer con él.
 */
export function parseDeliveryEvent(raw: unknown): DeliveryEvent | null {
  const resultado = ESQUEMA_EVENTO.safeParse(raw);
  if (!resultado.success) return null;

  const { type, data } = resultado.data;

  const partes = [data.bounce?.type, data.bounce?.subType]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));
  const cabecera = partes.join("/");
  const mensaje = data.bounce?.message?.trim() ?? "";

  const detalle =
    type === "email.bounced"
      ? recorta(cabecera && mensaje ? `${cabecera}: ${mensaje}` : cabecera || mensaje)
      : type === "email.failed"
        ? recorta(data.failed?.reason ?? "")
        : null;

  return {
    type,
    emailId: data.email_id.trim(),
    address: data.to?.[0]?.trim() || null,
    bounceType: data.bounce?.type?.trim() || null,
    detail: detalle,
  };
}

// ───────────────────────────────────────────────────────────── el mapeo

/** Evento del proveedor → estado de entrega de la fila. */
const ESTADO_POR_EVENTO: Readonly<Record<DeliveryEventType, DeliveryState>> = {
  "email.delivered": "DELIVERED",
  "email.delivery_delayed": "DELAYED",
  "email.bounced": "BOUNCED",
  "email.complained": "COMPLAINED",
  "email.failed": "FAILED",
};

export function deliveryStateOf(type: DeliveryEventType): DeliveryState {
  return ESTADO_POR_EVENTO[type];
}

/**
 * Gravedad de cada desenlace. Es lo que decide qué gana cuando llegan varios.
 *
 * Hace falta porque los webhooks NO llegan ordenados: un `email.delivery_delayed`
 * emitido antes puede entregarse después del `email.delivered`, y sin esta
 * escala el aviso de un correo que sí llegó acabaría marcado como «retrasado»
 * para siempre. La escala refleja el orden natural de la vida de un correo:
 * primero se retrasa, luego se entrega, y solo después de entregarse puede
 * llegar una queja.
 */
const GRAVEDAD: Readonly<Record<DeliveryState, number>> = {
  DELAYED: 1,
  DELIVERED: 2,
  FAILED: 3,
  BOUNCED: 4,
  COMPLAINED: 5,
};

/**
 * ¿El estado nuevo debe sustituir al que ya había?
 *
 * Estrictamente mayor, no «mayor o igual»: repetir el MISMO evento no escribe
 * nada, y de ahí sale la idempotencia del módulo entero —ni segunda fila de
 * bitácora, ni segunda fecha— sin depender de la deduplicación por `svix-id`.
 */
export function supersedes(
  actual: DeliveryState | null,
  nuevo: DeliveryState,
): boolean {
  if (actual === null) return true;
  return GRAVEDAD[nuevo] > GRAVEDAD[actual];
}

/**
 * ¿El rebote quema la dirección?
 *
 * Solo los PERMANENTES. Un rebote transitorio —buzón lleno, servidor de destino
 * caído— se arregla solo, y tratarlo como definitivo dejaría a esa persona sin
 * enterarse de nada para siempre por una semana de vacaciones con el buzón a
 * tope. `Undetermined` tampoco quema la dirección: ante la duda se sigue
 * escribiendo, porque el error caro aquí es el silencio, no el correo de más.
 *
 * En los dos casos el rebote SÍ se anota en la fila y en la bitácora, con su
 * tipo: es lo que permite a la superusuaria decidir a mano si esa dirección
 * está muerta de verdad.
 */
export function isPermanentBounce(bounceType: string | null): boolean {
  return bounceType?.trim().toLowerCase() === "permanent";
}

// ────────────────────────────────────────── qué avisos son prescindibles

/**
 * Avisos que se dejan de mandar a quien se quejó: el movimiento de la casa.
 *
 * Está escrita la lista de los PRESCINDIBLES y no la de los esenciales a
 * propósito. Los dos fallos posibles no cuestan lo mismo: si mañana aparece un
 * evento nuevo y esta lista se queda corta, el error es mandar un correo de más
 * a alguien que se quejó —molesto y visible—; con la lista al revés, el error
 * sería tragarse en silencio el enlace para entrar a la cuenta o el de
 * recuperar la contraseña, y esa persona se quedaría fuera sin que nadie lo
 * supiera. Por omisión, un aviso nuevo se considera esencial y sale.
 */
export const NON_ESSENTIAL_EVENT_TYPES: ReadonlySet<NotificationEventType> =
  new Set<NotificationEventType>([
    "RESERVATION_CREATED",
    "RESERVATION_CANCELLED",
    "GRANT_CREATED",
    "GRANT_REVOKED",
    "SLOTS_OPENED",
    "MONTH_WINDOW_OPENED",
  ]);

/** `event_type` es texto libre en la base: se compara como tal. */
export function isEssentialNotification(eventType: string): boolean {
  return !NON_ESSENTIAL_EVENT_TYPES.has(eventType as NotificationEventType);
}

// ───────────────────────────────────────────── fase 1: registrar el hecho

export type RecordResult = "nuevo" | "duplicado";

/** Cliente capaz de escribir: sirve el global y el de una transacción. */
type WebhookDb = Pick<Db, "webhookEvent"> | Pick<Prisma.TransactionClient, "webhookEvent">;

/**
 * Guarda el evento crudo y dice si ya se había visto.
 *
 * Resend entrega AL MENOS UNA VEZ: el mismo evento puede llegar dos veces
 * porque nuestra respuesta se perdió, no porque haya pasado dos veces. El
 * índice único de `webhook_events.svix_id` es el que decide, y no una consulta
 * previa: entre el SELECT y el INSERT caben dos entregas simultáneas, y solo la
 * base sabe resolver esa carrera.
 *
 * `P2002` es por tanto un resultado NORMAL, no un fallo: se traduce a
 * «duplicado» y quien llama responde 200.
 */
export async function recordWebhookEvent(
  db: WebhookDb,
  input: { svixId: string; eventType: string; payload: unknown },
): Promise<RecordResult> {
  try {
    await db.webhookEvent.create({
      data: {
        svixId: input.svixId,
        eventType: input.eventType,
        // Viene de un `JSON.parse` del cuerpo firmado: ya es JSON puro.
        payload: input.payload as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return "nuevo";
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return "duplicado";
    }
    throw error;
  }
}

// ──────────────────────────────────────────── fase 2: aplicar los efectos

export type ApplyResult = {
  /** Falso cuando el estado nuevo no supera al que ya tenía la fila. */
  applied: boolean;
  /** Fila de la cola que corresponde a ese `email_id`, si se encontró. */
  outboxId: string | null;
  /** Estado al que traduce ESTE evento; con `applied` falso no se escribió. */
  deliveryState: DeliveryState;
  /** A quién le pasó, si se pudo determinar. */
  userId: string | null;
  /** Se marcó la dirección como no entregable (rebote permanente). */
  markedUndeliverable: boolean;
  /** Se marcó la queja. */
  markedComplained: boolean;
  /** Avisos que seguían en cola y se descartaron por no poder o deber salir. */
  suppressed: number;
};

export type ApplyOptions = {
  /** IP de origen del webhook, para la bitácora. */
  ip?: string | null;
  /** Reloj inyectable; las pruebas fijan un instante. */
  now?: Date;
};

/**
 * Aplica un evento de entrega: estado de la fila, marca en el usuario, barrido
 * de la cola y bitácora. Todo dentro de UNA transacción.
 *
 * Que sea una sola transacción no es adorno: marcar a alguien como no
 * entregable y no dejar constancia en la bitácora produce exactamente el
 * misterio que este trabajo venía a resolver —una persona que deja de recibir
 * avisos sin que nadie sepa por qué—. O las dos cosas, o ninguna.
 */
export async function applyDeliveryEvent(
  db: Db,
  event: DeliveryEvent,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const ahora = options.now ?? new Date();
  const estado = deliveryStateOf(event.type);

  return db.$transaction(async (tx) => {
    // La fila se busca por `provider_message_id`, que el worker escribió con
    // el id que devolvió Resend al aceptar el envío. No es único —un id
    // repetido sería un fallo del proveedor—, así que se toma la más reciente.
    const fila = await tx.notificationOutbox.findFirst({
      where: { providerMessageId: event.emailId },
      select: {
        id: true,
        recipientUserId: true,
        recipientAddress: true,
        deliveryState: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const resultado: ApplyResult = {
      applied: false,
      outboxId: fila?.id ?? null,
      deliveryState: estado,
      userId: fila?.recipientUserId ?? null,
      markedUndeliverable: false,
      markedComplained: false,
      suppressed: 0,
    };

    // Sin fila no hay estado anterior con el que comparar, así que se aplica:
    // el evento sigue diciendo algo de una dirección aunque el aviso que lo
    // provocó ya no esté en la cola.
    if (fila !== null && !supersedes(fila.deliveryState, estado)) {
      return resultado;
    }
    resultado.applied = true;

    if (fila !== null) {
      await tx.notificationOutbox.update({
        where: { id: fila.id },
        data: {
          deliveryState: estado,
          deliveryDetail: event.detail,
          deliveryUpdatedAt: ahora,
        },
      });
    }

    // Un retraso o una entrega no tienen más consecuencias: ni marca, ni
    // barrido, ni bitácora. Solo el estado de la fila.
    if (estado === "DELIVERED" || estado === "DELAYED") return resultado;

    // La dirección de la FILA es la que se usó de verdad al enviar (es un
    // snapshot del momento de encolar). La del evento solo entra en juego
    // cuando la fila ya no existe.
    const direccion = fila?.recipientAddress ?? event.address;

    if (resultado.userId === null && direccion !== null) {
      // Respaldo: un correo que salió por fuera de la cola, o cuya fila se
      // purgó. El cuerpo viene firmado por Resend, así que su dirección es
      // tan fiable como la nuestra.
      const usuario = await tx.user.findUnique({
        where: { email: direccion },
        select: { id: true },
      });
      resultado.userId = usuario?.id ?? null;
    }

    const permanente = estado === "BOUNCED" && isPermanentBounce(event.bounceType);

    if (resultado.userId !== null && (permanente || estado === "COMPLAINED")) {
      // `updateMany` con la fecha todavía nula: gana el PRIMER rebote (o la
      // primera queja), que es la fecha que responde «¿desde cuándo?». Un
      // segundo evento no la mueve hacia adelante ni borra el historial.
      const { count } = await tx.user.updateMany({
        where:
          estado === "COMPLAINED"
            ? { id: resultado.userId, emailComplainedAt: null }
            : { id: resultado.userId, emailBouncedAt: null },
        data:
          estado === "COMPLAINED"
            ? { emailComplainedAt: ahora }
            : { emailBouncedAt: ahora },
      });
      if (estado === "COMPLAINED") resultado.markedComplained = count > 0;
      else resultado.markedUndeliverable = count > 0;
    }

    // Barrido de la cola: lo que sigue PENDING para esa dirección y ya no debe
    // salir. Se descarta como DEAD —el estado de «no salió y se ve en el
    // panel»— con el motivo escrito, en vez de borrarlo: un aviso que nunca
    // llegó a nadie tiene que poder explicarse.
    //
    // El alcance es la DIRECCIÓN y no la persona: si alguien cambió de correo,
    // lo que está quemado es la dirección vieja, y sus avisos nuevos deben
    // seguir saliendo. La comparación es insensible a mayúsculas porque
    // `recipient_address` es `text` (el `citext` está en `users.email`) y el
    // proveedor no promete devolver la dirección con la misma caja.
    if (direccion !== null && (permanente || estado === "COMPLAINED")) {
      const { count } = await tx.notificationOutbox.updateMany({
        where: {
          channel: "EMAIL",
          status: "PENDING",
          recipientAddress: { equals: direccion, mode: "insensitive" },
          // Un rebote permanente no deja pasar nada: la dirección no recibe.
          // Una queja solo silencia lo prescindible; el enlace para entrar a
          // la cuenta sigue saliendo.
          ...(estado === "COMPLAINED"
            ? { eventType: { in: [...NON_ESSENTIAL_EVENT_TYPES] } }
            : {}),
        },
        data: {
          status: "DEAD",
          lastError: permanente
            ? "Descartado: la dirección rebotó de forma permanente"
            : "Descartado: el destinatario marcó los avisos como correo no deseado",
        },
      });
      resultado.suppressed = count;
    }

    // Solo se anota lo que la superusuaria necesita para entender un silencio.
    // La entrega correcta y el retraso ya salieron por arriba sin escribir nada.
    const accion: AuditAction =
      estado === "BOUNCED"
        ? "EMAIL_BOUNCED"
        : estado === "COMPLAINED"
          ? "EMAIL_COMPLAINED"
          : "EMAIL_DELIVERY_FAILED";

    const detalles: AuditDetails = {
      evento: event.type,
      providerMessageId: event.emailId,
      direccion,
      outboxId: resultado.outboxId,
      motivo: event.detail,
      tipoRebote: event.bounceType,
      /** Verdadero solo si la dirección quedó marcada como no entregable. */
      permanente,
      avisosDescartados: resultado.suppressed,
    };

    await writeAudit(tx, {
      action: accion,
      entityType: "USER",
      // Quién dejó de recibir: es como se busca esto en /bitacora. Nulo cuando
      // la dirección no corresponde a ningún usuario (un correo de prueba).
      entityId: resultado.userId,
      // Nadie de la casa hizo esto: lo cuenta el proveedor.
      actorUserId: null,
      details: detalles,
      ip: options.ip ?? null,
    });

    return resultado;
  });
}
