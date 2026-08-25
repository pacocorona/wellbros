/**
 * Bitácora (audit_log).
 *
 * Está pensada como append-only y solo la ve el superusuario.
 *
 * OJO — hoy esa garantía es una CONVENCIÓN, no una restricción: los REVOKE de
 * UPDATE y DELETE están escritos pero COMENTADOS al final de la migración, como
 * paso manual de despliegue, y además `DATABASE_URL` se conecta con el dueño
 * del esquema, a quien los REVOKE no le aplicarían. Mientras no se cree un rol
 * de aplicación sin esos privilegios y se ejecute ese bloque, un error de
 * código sí podría reescribir la historia. Ver deploy/README.md.
 *
 * `writeAudit` acepta tanto `prisma` como el cliente de una transacción
 * interactiva. Escribir DENTRO de la transacción del caso de uso es lo
 * importante: si la reserva se guarda, su entrada de bitácora se guarda; si
 * algo falla, ninguna de las dos queda. Nunca se anota un hecho que no ocurrió
 * ni ocurre un hecho sin anotar.
 */

import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

/**
 * Acciones registrables. Es una lista cerrada a propósito: si mañana hace
 * falta un evento nuevo, se añade aquí y el compilador obliga a nombrarlo
 * igual en todas partes. Los filtros de /bitacora dependen de esa constancia.
 */
export const AUDIT_ACTIONS = [
  // Reservas
  "RESERVATION_CREATED",
  "RESERVATION_CANCELLED",
  "RESERVATION_CANCELLED_BY_ADMIN",
  /** El superusuario reservó usando su exención de ventana. */
  "RESERVATION_OUT_OF_WINDOW",
  /** Intento rechazado por caer fuera de la ventana de apertura. */
  "RESERVATION_REJECTED_WINDOW",
  // Semanas
  "SLOT_OPENED",
  "SLOT_CLOSED",
  /** Cierre de una semana que tenía reserva activa: caso delicado, se anota aparte. */
  "SLOT_CLOSED_WITH_ACTIVE_RESERVATION",
  // Cesiones
  "GRANT_CREATED",
  "GRANT_REVOKED",
  // Administración
  "USER_CREATED",
  "USER_UPDATED",
  "USER_DEACTIVATED",
  // Cambiar la contraseña cierra todas las sesiones (destroyAllSessions), así
  // que es un hecho auditable por sí mismo: explica por qué alguien fue
  // expulsado de sus dispositivos.
  "USER_PASSWORD_CHANGED",
  "USER_REINVITED",
  "PROPERTY_CREATED",
  "PROPERTY_UPDATED",
  "MAINTENANCE_NOTE_CREATED",
  // Editar o borrar una nota es tan visible para todos como crearla —la nota
  // se pinta en el calendario de cualquiera—, así que las tres dejan rastro.
  // Sin estas dos, una nota podía aparecer y desaparecer sin que la bitácora
  // supiera quién la movió.
  "MAINTENANCE_NOTE_UPDATED",
  "MAINTENANCE_NOTE_DELETED",
  "BOOKING_POLICY_UPDATED",
  // Acceso
  "LOGIN_SUCCEEDED",
  "LOGIN_FAILED",
  "LOGOUT",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Entidad afectada. Coincide con las tablas del modelo. */
export type AuditEntityType =
  | "USER"
  | "SESSION"
  | "PROPERTY"
  | "WEEK_SLOT"
  | "RESERVATION"
  | "DAY_GRANT"
  | "MAINTENANCE_NOTE"
  | "BOOKING_POLICY";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Datos del evento. Es un snapshot para leer dentro de dos años: guarda
 * valores ya resueltos (correo, nombre de la propiedad, fecha de la semana),
 * no solo identificadores que obliguen a cruzar tablas.
 *
 * NO metas aquí contraseñas, hashes ni tokens.
 */
export type AuditDetails = Record<string, JsonValue>;

/**
 * Cliente capaz de escribir en la bitácora: sirve el cliente global y también
 * el de una transacción. Se pide justo lo que se usa para que ambos encajen
 * sin castings.
 */
export type AuditClient = Pick<Db, "auditLog"> | Pick<Prisma.TransactionClient, "auditLog">;

export interface AuditEntry {
  action: AuditAction;
  entityType: AuditEntityType;
  /**
   * Identificador de la entidad. La columna es UUID en la base: debe ser un
   * uuid válido o quedarse sin valor (por ejemplo en un LOGIN_FAILED donde no
   * se sabe de quién se trata).
   */
  entityId?: string | null;
  /** Quién lo hizo. Nulo solo cuando el actor es anónimo o desconocido. */
  actorUserId?: string | null;
  details?: AuditDetails;
  ip?: string | null;
}

/** `audit_log.ip` es varchar(64). */
const MAX_IP_LENGTH = 64;

/**
 * Escribe una entrada de bitácora.
 *
 * No captura errores a propósito: si la anotación falla dentro de una
 * transacción, la operación entera debe fallar con ella. Un sistema que
 * ejecuta cambios sin poder registrarlos no está funcionando.
 */
export async function writeAudit(
  db: AuditClient,
  entry: AuditEntry,
): Promise<void> {
  const ip = entry.ip ? entry.ip.slice(0, MAX_IP_LENGTH) : null;

  await db.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      actorUserId: entry.actorUserId ?? null,
      details: (entry.details ?? {}) as Prisma.InputJsonObject,
      ip,
    },
    select: { id: true },
  });
}
