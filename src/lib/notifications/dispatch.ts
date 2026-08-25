/**
 * Encolado de avisos (patrón outbox).
 *
 * La regla de oro: `enqueueNotification` NO envía nada, solo inserta filas —y
 * lo hace con la transacción que recibe, la misma en la que se creó la reserva
 * o la cesión. Si el negocio se deshace, los avisos se deshacen con él; si el
 * negocio se confirma, los avisos están garantizados aunque el proveedor de
 * correo esté caído. Un worker aparte (worker.ts) los envía después.
 *
 * UN CORREO POR PERSONA, NUNCA COPIA OCULTA (§08). Cuesta una fila por
 * destinatario en vez de una sola, y se paga con gusto:
 *   · Privacidad estructural — cada mensaje lleva una única dirección, así que
 *     no existe la posibilidad de filtrar la lista de correos de los
 *     copropietarios.
 *   · Enlaces y saludo propios — cada aviso puede llevar el nombre de quien lo
 *     lee y el enlace a lo que le toca a esa persona (su cesión, su semana).
 *     Con copia oculta el cuerpo es idéntico para todos.
 *   · Seguimiento real — las notificaciones de entrega y rebote llegan por
 *     mensaje. Con copia oculta hay un solo identificador y no se sabe a quién
 *     le rebotó.
 *   · Reintentos limpios — si falla el envío a una persona se reintenta solo el
 *     suyo, no el de todos.
 */

import type { Prisma } from "@/generated/prisma/client";

import { consoleEmailChannel } from "./channels/email-console";
import { resendEmailChannel } from "./channels/email-resend";
import { whatsappChannel } from "./channels/whatsapp";
import type {
  AnyEventPayload,
  EventPayload,
  NotificationChannel,
  NotificationChannelKey,
  NotificationEventType,
} from "./types";

// ──────────────────────────────────────────────────────── canales activos

/**
 * Qué adaptador de correo se usa. En desarrollo el de consola: no gasta cuota
 * de Resend y deja los mensajes en disco para revisarlos.
 */
export function resolveEmailChannel(): NotificationChannel {
  return process.env.EMAIL_DRIVER === "resend"
    ? resendEmailChannel
    : consoleEmailChannel;
}

export function getChannel(key: NotificationChannelKey): NotificationChannel {
  return key === "EMAIL" ? resolveEmailChannel() : whatsappChannel;
}

/**
 * Canales encendidos ahora mismo.
 *
 * Manda la tabla `notification_channels`, no las variables de entorno: apagar
 * un canal desde la configuración debe surtir efecto sin reiniciar el servicio,
 * que es justo lo que promete §08. El adaptador conserva su propio
 * `isEnabled()` como segundo filtro — de nada sirve que la base diga que
 * WhatsApp está encendido si no hay credenciales cargadas.
 *
 * Se consulta con la misma transacción del caso de uso para no abrir una
 * conexión aparte dentro de una transacción en curso.
 */
export async function enabledChannels(
  tx: Prisma.TransactionClient,
): Promise<NotificationChannel[]> {
  const filas = await tx.notificationChannelConfig.findMany({
    where: { isEnabled: true },
    select: { channel: true },
  });

  const encendidosEnBase = new Set(filas.map((f) => f.channel));

  return [resolveEmailChannel(), whatsappChannel].filter(
    (canal) => encendidosEnBase.has(canal.key) && canal.isEnabled(),
  );
}

// ─────────────────────────────────────────────────────── clave de dedupe

/**
 * Entidad a la que se refiere el aviso. Es la parte central de la clave de
 * deduplicación, así que tiene que ser estable: dos encolados del mismo hecho
 * deben producir exactamente la misma clave.
 */
function entityIdOf(
  eventType: NotificationEventType,
  payload: AnyEventPayload,
): string {
  switch (eventType) {
    case "RESERVATION_CREATED":
    case "RESERVATION_CANCELLED":
      return (payload as EventPayload<"RESERVATION_CREATED">).reservationId;
    case "GRANT_CREATED":
    case "GRANT_REVOKED":
      return (payload as EventPayload<"GRANT_CREATED">).grantBatchId;
    case "SLOTS_OPENED":
      return (payload as EventPayload<"SLOTS_OPENED">).batchId;
    case "MONTH_WINDOW_OPENED": {
      // Propiedad + mes: la política es por propiedad, así que el mismo mes
      // puede abrirse en instantes distintos para cada una.
      const p = payload as EventPayload<"MONTH_WINDOW_OPENED">;
      return `${p.propertyId}:${p.anchorMonth}`;
    }
    case "USER_INVITED":
      // La invitación, no el usuario: reinvitar debe volver a enviar.
      return (payload as EventPayload<"USER_INVITED">).invitationId;
    default: {
      // Exhaustividad comprobada por el compilador: si mañana se añade un
      // evento y no se le da entidad, esto deja de compilar.
      const _exhaustivo: never = eventType;
      throw new Error(`Evento sin entidad definida: ${String(_exhaustivo)}`);
    }
  }
}

/**
 * Clave de idempotencia, formato `<evento>/<entidad>/<usuario>`
 * (p. ej. `RESERVATION_CREATED/6f0e…/9a12…`).
 *
 * Para EMAIL se respeta el formato tal cual porque esta misma cadena viaja a
 * Resend como `Idempotency-Key`. Los demás canales llevan prefijo: la columna
 * `dedupe_key` es única en toda la tabla, y sin él la fila de WhatsApp y la de
 * correo del mismo aviso chocarían entre sí.
 */
export function buildDedupeKey(
  eventType: NotificationEventType,
  entityId: string,
  recipientUserId: string,
  channel: NotificationChannelKey,
): string {
  const base = `${eventType}/${entityId}/${recipientUserId}`;
  return channel === "EMAIL" ? base : `${channel.toLowerCase()}:${base}`;
}

// ────────────────────────────────────────────────────────────── encolado

export type EnqueueInput<E extends NotificationEventType> = {
  eventType: E;
  payload: EventPayload<E>;
  /** A quién se avisa. Se filtran los inactivos y los repetidos. */
  recipientUserIds: string[];
  /**
   * Envío diferido. Se usa para no anunciar una semana liberada de un mes que
   * todavía no abre: el aviso se programa para el instante de apertura, porque
   * anunciar algo que nadie puede tomar solo da ventaja a quien lea el correo a
   * deshoras (§07).
   */
  scheduledFor?: Date;
};

type DestinatarioFila = {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  whatsappOptIn: boolean;
};

/** Dirección de contacto para un canal, o null si esa persona no lo tiene. */
function addressFor(
  channel: NotificationChannelKey,
  user: DestinatarioFila,
): string | null {
  if (channel === "EMAIL") return user.email;
  // WhatsApp exige teléfono en E.164 y consentimiento explícito.
  return user.whatsappOptIn && user.phone ? user.phone : null;
}

/**
 * Inserta un aviso por destinatario y canal activo dentro de la transacción
 * recibida. Devuelve cuántas filas se crearon.
 *
 * No encola para canales apagados ni para usuarios inactivos: un usuario dado
 * de baja no debe seguir recibiendo el movimiento de la casa.
 */
export async function enqueueNotification<E extends NotificationEventType>(
  tx: Prisma.TransactionClient,
  input: EnqueueInput<E>,
): Promise<number> {
  const canales = await enabledChannels(tx);
  if (canales.length === 0) return 0;

  const ids = [...new Set(input.recipientUserIds)];
  if (ids.length === 0) return 0;

  const usuarios: DestinatarioFila[] = await tx.user.findMany({
    where: { id: { in: ids }, isActive: true },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      whatsappOptIn: true,
    },
  });
  if (usuarios.length === 0) return 0;

  const entityId = entityIdOf(input.eventType, input.payload);
  const cuando = input.scheduledFor ?? new Date();

  const filas: Prisma.NotificationOutboxCreateManyInput[] = [];
  for (const usuario of usuarios) {
    for (const canal of canales) {
      const direccion = addressFor(canal.key, usuario);
      if (!direccion) continue;

      filas.push({
        channel: canal.key,
        recipientUserId: usuario.id,
        recipientAddress: direccion,
        eventType: input.eventType,
        // El payload guardado incluye el contexto del destinatario: es lo único
        // que distingue un aviso de otro dentro del mismo evento, y va en la
        // fila para que el render siga siendo reproducible años después.
        payload: toJsonObject({
          ...input.payload,
          recipientUserId: usuario.id,
          recipientName: usuario.fullName,
        }),
        dedupeKey: buildDedupeKey(
          input.eventType,
          entityId,
          usuario.id,
          canal.key,
        ),
        scheduledFor: cuando,
        // Igual que `scheduledFor`: un aviso diferido no debe ser elegible
        // antes de tiempo aunque solo se mirara este campo.
        nextAttemptAt: cuando,
      });
    }
  }

  if (filas.length === 0) return 0;

  // `skipDuplicates` hace que reencolar el MISMO hecho sea inofensivo en vez de
  // abortar la transacción de negocio con una violación del índice único de
  // `dedupe_key`. Es justo la semántica del outbox: la clave significa «este
  // aviso ya está en la cola».
  const { count } = await tx.notificationOutbox.createMany({
    data: filas,
    skipDuplicates: true,
  });
  return count;
}

// ───────────────────────────────────────────────────────── destinatarios

/**
 * Todos los usuarios activos: el destinatario por defecto de los avisos de
 * reserva, cancelación y apertura de semanas (§08).
 */
export async function activeUserIds(
  tx: Prisma.TransactionClient,
  options: { exclude?: string[] } = {},
): Promise<string[]> {
  const excluidos = new Set(options.exclude ?? []);
  const usuarios = await tx.user.findMany({
    where: { isActive: true },
    select: { id: true },
    // Orden estable para que las pruebas no dependan del plan de consulta.
    orderBy: { createdAt: "asc" },
  });
  return usuarios
    .map((u: { id: string }) => u.id)
    .filter((id: string) => !excluidos.has(id));
}

/** El superusuario (o los que haya), para los avisos que solo le competen. */
export async function superuserIds(
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const usuarios = await tx.user.findMany({
    where: { isActive: true, role: "SUPERUSER" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return usuarios.map((u: { id: string }) => u.id);
}

/**
 * Normaliza el payload a JSON puro antes de guardarlo.
 *
 * Dos motivos: Prisma tipa la columna `Json` como `InputJsonValue`, que no
 * admite `undefined` en las propiedades opcionales; y el viaje por
 * JSON.stringify garantiza que lo guardado es exactamente lo que el worker
 * volverá a leer, sin instancias ni getters escondidos.
 */
function toJsonObject(value: object): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
