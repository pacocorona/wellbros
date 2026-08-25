/**
 * Administración de usuarios (solo SUPERUSER).
 *
 * Funciones PURAS de framework: reciben el actor y el cliente de Prisma; nunca
 * llaman a `cookies()` ni a `requireUser()`. Quien resuelve la sesión es la
 * Server Action (o mañana `/api/v1`), no esto.
 *
 * Este archivo hospeda además el NÚCLEO COMPARTIDO de los servicios de
 * administración —actor, errores, utilidades de fecha y de zod—: el reparto de
 * archivos de esta tarea no contempla un módulo aparte y duplicarlo en cinco
 * sitios sería peor. Si crece, mudarlo a `src/server/admin/shared.ts` es un
 * refactor mecánico (solo cambian los `import`).
 */

import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { UserRole } from "@/generated/prisma/enums";
import { writeAudit } from "@/lib/audit";
import {
  AuthError,
  destroyAllSessions,
  hashPassword,
  verifyPassword,
} from "@/lib/auth";
import { businessToday, DEFAULT_BOOKING_WINDOW } from "@/lib/booking-window";
import type { Db } from "@/lib/db";
import { enqueueNotification } from "@/lib/notifications/dispatch";

// ═══════════════════════════════════════════════ núcleo compartido

/**
 * Quien ejecuta la operación. Es un subconjunto de `SessionUser` a propósito:
 * pedir el tipo entero ataría estos servicios a la capa de sesión de Next, y la
 * idea es poder invocarlos desde un futuro `/api/v1` con un actor reconstruido
 * a partir de un token.
 */
export interface AdminActor {
  id: string;
  role: UserRole;
  fullName: string;
  email: string;
}

export type AdminErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "EMAIL_TAKEN"
  | "NAME_TAKEN"
  | "LAST_SUPERUSER"
  | "SELF_DEACTIVATION"
  | "WRONG_PASSWORD"
  | "PROPERTY_INACTIVE"
  | "BATCH_TOO_LARGE"
  | "SLOT_HAS_ACTIVE_RESERVATION"
  | "SLOT_NOT_CLOSED";

/**
 * Error de negocio con código estable. La interfaz decide el texto y el estado
 * HTTP a partir del código; el mensaje que viaja aquí ya está en español y es
 * apto para mostrarse tal cual.
 */
export class AdminError extends Error {
  readonly code: AdminErrorCode;

  constructor(code: AdminErrorCode, message: string) {
    super(message);
    this.name = "AdminError";
    this.code = code;
  }
}

export function isAdminError(error: unknown): error is AdminError {
  return error instanceof AdminError;
}

/**
 * Puerta de rol. Se comprueba DENTRO de cada servicio y no solo en la página:
 * una acción de servidor mal enrutada, una prueba o una futura ruta de API no
 * pasan por el layout que protege /admin.
 */
export function assertSuperuser(actor: AdminActor): void {
  if (actor.role !== "SUPERUSER") {
    throw new AuthError("FORBIDDEN", "No tienes permiso para esta acción.");
  }
}

/** Valida con zod y traduce el fallo a `AdminError`, que es lo que la interfaz sabe mostrar. */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const resultado = schema.safeParse(value);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new AdminError("INVALID_INPUT", detalle);
  }
  return resultado.data;
}

/**
 * `yyyy-MM-dd` → `Date` para una columna `@db.Date`.
 *
 * Prisma trata las columnas DATE como medianoche UTC: construirlas con
 * `new Date(y, m, d)` (hora local del servidor) desplazaría el día entero en
 * cualquier despliegue que no corra en UTC.
 */
export function fechaCivil(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** `Date` de una columna `@db.Date` → `yyyy-MM-dd`. */
export function isoDeFecha(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/** Hoy en la zona de negocio, como `yyyy-MM-dd`. */
export function hoyDeNegocio(now: Date = new Date()): string {
  return businessToday(now, DEFAULT_BOOKING_WINDOW);
}

const NOMBRES_MES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

const NOMBRES_DIA = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

/** «sábado 3 de octubre de 2026». Solo aritmética civil: nada de husos. */
export function etiquetaDia(iso: string): string {
  const d = fechaCivil(iso);
  return `${NOMBRES_DIA[d.getUTCDay()]} ${d.getUTCDate()} de ${NOMBRES_MES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

/**
 * «viernes 2 al jueves 8 de octubre de 2026»: la etiqueta de semana que viaja
 * en los avisos. Se redacta aquí, al encolar, porque el render debe ser
 * reproducible byte a byte años después (§08).
 */
export function etiquetaSemana(inicioISO: string, finISO: string): string {
  const inicio = fechaCivil(inicioISO);
  const fin = fechaCivil(finISO);
  const mismoMes = inicio.getUTCMonth() === fin.getUTCMonth();
  const cabeza = mismoMes
    ? `${NOMBRES_DIA[inicio.getUTCDay()]} ${inicio.getUTCDate()}`
    : `${NOMBRES_DIA[inicio.getUTCDay()]} ${inicio.getUTCDate()} de ${NOMBRES_MES[inicio.getUTCMonth()]}`;
  return `${cabeza} al ${NOMBRES_DIA[fin.getUTCDay()]} ${fin.getUTCDate()} de ${NOMBRES_MES[fin.getUTCMonth()]} de ${fin.getUTCFullYear()}`;
}

// ═════════════════════════════════════════════════════════ usuarios

/** E.164: `+` país sin ceros a la izquierda y de 8 a 15 dígitos en total. */
const TELEFONO_E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Longitud mínima de contraseña. Se apuesta por longitud y no por reglas de
 * composición (NIST SP 800-63B): las reglas empujan a `Verano2026!` y una frase
 * larga resiste mucho más.
 */
const MIN_CONTRASENA = 12;

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Correo electrónico inválido"));

const nombreSchema = z
  .string()
  .trim()
  .min(3, "El nombre debe tener al menos 3 caracteres")
  .max(120, "El nombre no puede pasar de 120 caracteres");

const telefonoSchema = z
  .string()
  .trim()
  .regex(TELEFONO_E164, "El teléfono debe ir en formato E.164, p. ej. +5219981234567");

const rolSchema = z.enum(["SUPERUSER", "USER"]);

/**
 * Entrega por invitación.
 *
 * El token y su caducidad NO se generan aquí: la base no tiene tabla de
 * invitaciones (ver esquema), así que quien tenga ese mecanismo pasa la ruta ya
 * construida. Preferimos exigirla a inventar un enlace que el correo prometería
 * y que no llevaría a ninguna parte.
 */
export interface InvitationDelivery {
  /** Identificador del ENLACE (no del usuario): es la entidad de la clave de deduplicación. */
  invitationId: string;
  /** Ruta relativa con el token de alta de contraseña, p. ej. `/invitacion/<token>`. */
  path: string;
  /** «48 horas»: texto ya redactado, nunca un cálculo hecho al renderizar. */
  expiresInLabel: string;
}

const invitacionSchema = z.object({
  invitationId: z.uuid("El identificador de invitación debe ser un uuid"),
  path: z
    .string()
    .trim()
    // Relativa a la aplicación: una URL absoluta en un correo de alta es el
    // vector clásico de phishing, y el worker ya antepone APP_BASE_URL.
    .regex(/^\/[^\s]*$/, "La ruta de invitación debe ser relativa y empezar con /"),
  expiresInLabel: z.string().trim().min(1, "Falta el texto de caducidad"),
});

export interface CreateUserInput {
  email: string;
  fullName: string;
  phone?: string | null;
  whatsappOptIn?: boolean;
  role?: UserRole;
  /** Si se omite, se genera una contraseña temporal y se devuelve UNA vez. */
  invitation?: InvitationDelivery;
}

const crearUsuarioSchema = z
  .object({
    email: emailSchema,
    fullName: nombreSchema,
    phone: telefonoSchema.nullish(),
    whatsappOptIn: z.boolean().default(false),
    role: rolSchema.default("USER"),
    invitation: invitacionSchema.optional(),
  })
  .refine((v) => !v.whatsappOptIn || Boolean(v.phone), {
    message: "Para avisos por WhatsApp hace falta un teléfono en E.164",
    path: ["phone"],
  });

export interface AdminUserRow {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  whatsappOptIn: boolean;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  /** Reservas ACTIVE (pasadas y futuras): lo que se pierde al dar de baja. */
  activeReservations: number;
}

const SELECCION_USUARIO = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  whatsappOptIn: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

export interface ListUsersInput {
  db: Db;
  actor: AdminActor;
  filters?: {
    /** Busca en nombre y correo, sin distinguir mayúsculas. */
    search?: string;
    includeInactive?: boolean;
    role?: UserRole;
  };
}

/** Listado para la pantalla de administración. Ordenado por nombre. */
export async function listUsers({
  db,
  actor,
  filters = {},
}: ListUsersInput): Promise<AdminUserRow[]> {
  assertSuperuser(actor);

  const busqueda = filters.search?.trim();

  const usuarios = await db.user.findMany({
    where: {
      ...(filters.includeInactive ? {} : { isActive: true }),
      ...(filters.role ? { role: filters.role } : {}),
      ...(busqueda
        ? {
            OR: [
              { fullName: { contains: busqueda, mode: "insensitive" as const } },
              // `email` es citext: la comparación ya ignora mayúsculas, pero el
              // modo insensible no estorba y deja la intención explícita.
              { email: { contains: busqueda, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: SELECCION_USUARIO,
    orderBy: { fullName: "asc" },
  });

  if (usuarios.length === 0) return [];

  // Un solo GROUP BY en vez de un `_count` por fila: la lista es corta pero la
  // consulta con relación agregada de Prisma cuesta un subselect por usuario.
  const conteos = await db.reservation.groupBy({
    by: ["userId"],
    where: { status: "ACTIVE", userId: { in: usuarios.map((u) => u.id) } },
    _count: { _all: true },
  });
  const porUsuario = new Map(conteos.map((c) => [c.userId, c._count._all]));

  return usuarios.map((u) => ({ ...u, activeReservations: porUsuario.get(u.id) ?? 0 }));
}

export interface CreateUserResult {
  user: AdminUserRow;
  /**
   * Contraseña temporal EN CLARO. Solo existe en esta respuesta: nunca se
   * guarda ni se manda por correo (§seguridad: debe viajar por gestor de
   * contraseñas). Ausente cuando la entrega fue por invitación.
   */
  temporaryPassword?: string;
  /** Filas encoladas en el outbox (0 si no hubo invitación). */
  notified: number;
}

/**
 * Alta de usuario. No hay registro público: siempre la crea la superusuaria.
 */
export async function createUser({
  db,
  actor,
  input,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  input: CreateUserInput;
  ip?: string | null;
}): Promise<CreateUserResult> {
  assertSuperuser(actor);
  const datos = parseOrThrow(crearUsuarioSchema, input);

  const yaExiste = await db.user.findUnique({
    where: { email: datos.email },
    select: { id: true },
  });
  if (yaExiste) {
    throw new AdminError("EMAIL_TAKEN", `Ya hay una cuenta con el correo ${datos.email}.`);
  }

  // Con invitación, la contraseña inicial es un valor aleatorio que NADIE
  // conoce: la cuenta solo se abre por el enlace. Sin invitación, se genera una
  // temporal y se devuelve una sola vez.
  const temporal = datos.invitation ? null : contrasenaTemporal();
  const passwordHash = await hashPassword(temporal ?? randomBytes(32).toString("base64url"));

  const { usuario, notificados } = await db.$transaction(async (tx) => {
    const creado = await tx.user.create({
      data: {
        email: datos.email,
        passwordHash,
        fullName: datos.fullName,
        phone: datos.phone ?? null,
        whatsappOptIn: datos.whatsappOptIn,
        role: datos.role,
      },
      select: SELECCION_USUARIO,
    });

    await writeAudit(tx, {
      action: "USER_CREATED",
      entityType: "USER",
      entityId: creado.id,
      actorUserId: actor.id,
      ip,
      details: {
        email: creado.email,
        fullName: creado.fullName,
        role: creado.role,
        entrega: datos.invitation ? "INVITACION" : "CONTRASENA_TEMPORAL",
        invitationId: datos.invitation?.invitationId ?? null,
      },
    });

    const notificados = datos.invitation
      ? await enqueueNotification(tx, {
          eventType: "USER_INVITED",
          payload: {
            invitationId: datos.invitation.invitationId,
            userId: creado.id,
            fullName: creado.fullName,
            invitedByName: actor.fullName,
            path: datos.invitation.path,
            expiresInLabel: datos.invitation.expiresInLabel,
          },
          recipientUserIds: [creado.id],
        })
      : 0;

    return { usuario: creado, notificados };
  });

  return {
    user: { ...usuario, activeReservations: 0 },
    ...(temporal ? { temporaryPassword: temporal } : {}),
    notified: notificados,
  };
}

/**
 * Reenvía la invitación con un enlace nuevo. El token lo genera quien llama
 * (ver `InvitationDelivery`); aquí solo se encola y se deja constancia.
 */
export async function reinviteUser({
  db,
  actor,
  userId,
  invitation,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  userId: string;
  invitation: InvitationDelivery;
  ip?: string | null;
}): Promise<{ notified: number }> {
  assertSuperuser(actor);
  const datos = parseOrThrow(invitacionSchema, invitation);

  const usuario = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, fullName: true, email: true, isActive: true },
  });
  if (!usuario) throw new AdminError("NOT_FOUND", "El usuario no existe.");
  if (!usuario.isActive) {
    throw new AdminError(
      "INVALID_INPUT",
      "La cuenta está desactivada: reactívala antes de reinvitarla.",
    );
  }

  return db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "USER_REINVITED",
      entityType: "USER",
      entityId: usuario.id,
      actorUserId: actor.id,
      ip,
      details: { email: usuario.email, invitationId: datos.invitationId },
    });

    const notified = await enqueueNotification(tx, {
      eventType: "USER_INVITED",
      payload: {
        invitationId: datos.invitationId,
        userId: usuario.id,
        fullName: usuario.fullName,
        invitedByName: actor.fullName,
        path: datos.path,
        expiresInLabel: datos.expiresInLabel,
      },
      recipientUserIds: [usuario.id],
    });

    return { notified };
  });
}

export interface UpdateUserInput {
  fullName?: string;
  /** `null` borra el teléfono. */
  phone?: string | null;
  role?: UserRole;
  whatsappOptIn?: boolean;
}

const actualizarUsuarioSchema = z.object({
  fullName: nombreSchema.optional(),
  phone: telefonoSchema.nullish(),
  role: rolSchema.optional(),
  whatsappOptIn: z.boolean().optional(),
});

/**
 * Edita nombre, teléfono, rol y consentimiento de WhatsApp.
 * El correo NO se toca: es la identidad de la cuenta y la clave de todo lo
 * anotado en la bitácora.
 */
export async function updateUser({
  db,
  actor,
  userId,
  input,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  userId: string;
  input: UpdateUserInput;
  ip?: string | null;
}): Promise<AdminUserRow> {
  assertSuperuser(actor);
  const patch = parseOrThrow(actualizarUsuarioSchema, input);

  const actualUsuario = await db.user.findUnique({
    where: { id: userId },
    select: SELECCION_USUARIO,
  });
  if (!actualUsuario) throw new AdminError("NOT_FOUND", "El usuario no existe.");

  // Solo lo que cambia de verdad: así la bitácora no se llena de entradas que
  // no dicen nada y el `updatedAt` conserva significado.
  const cambios: Record<string, { antes: string | boolean | null; ahora: string | boolean | null }> =
    {};
  const data: {
    fullName?: string;
    phone?: string | null;
    role?: UserRole;
    whatsappOptIn?: boolean;
  } = {};

  if (patch.fullName !== undefined && patch.fullName !== actualUsuario.fullName) {
    data.fullName = patch.fullName;
    cambios.fullName = { antes: actualUsuario.fullName, ahora: patch.fullName };
  }
  if (patch.phone !== undefined) {
    const nuevo = patch.phone ?? null;
    if (nuevo !== actualUsuario.phone) {
      data.phone = nuevo;
      cambios.phone = { antes: actualUsuario.phone, ahora: nuevo };
    }
  }
  if (patch.role !== undefined && patch.role !== actualUsuario.role) {
    data.role = patch.role;
    cambios.role = { antes: actualUsuario.role, ahora: patch.role };
  }
  if (patch.whatsappOptIn !== undefined && patch.whatsappOptIn !== actualUsuario.whatsappOptIn) {
    data.whatsappOptIn = patch.whatsappOptIn;
    cambios.whatsappOptIn = { antes: actualUsuario.whatsappOptIn, ahora: patch.whatsappOptIn };
  }

  const telefonoFinal = data.phone !== undefined ? data.phone : actualUsuario.phone;
  const optInFinal =
    data.whatsappOptIn !== undefined ? data.whatsappOptIn : actualUsuario.whatsappOptIn;
  if (optInFinal && !telefonoFinal) {
    throw new AdminError(
      "INVALID_INPUT",
      "Para avisos por WhatsApp hace falta un teléfono en E.164.",
    );
  }

  if (Object.keys(data).length === 0) {
    const [conteo] = await conteosDeReservas(db, [actualUsuario.id]);
    return { ...actualUsuario, activeReservations: conteo ?? 0 };
  }

  if (data.role === "USER" && actualUsuario.role === "SUPERUSER") {
    await asegurarQuedaOtroSuperusuario(db, actualUsuario.id);
  }

  const actualizado = await db.$transaction(async (tx) => {
    const fila = await tx.user.update({
      where: { id: userId },
      data,
      select: SELECCION_USUARIO,
    });

    await writeAudit(tx, {
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: fila.id,
      actorUserId: actor.id,
      ip,
      details: { email: fila.email, cambios },
    });

    return fila;
  });

  const [conteo] = await conteosDeReservas(db, [actualizado.id]);
  return { ...actualizado, activeReservations: conteo ?? 0 };
}

/** Reserva futura de alguien a quien se está dando de baja. */
export interface FutureReservationRef {
  reservationId: string;
  slotId: string;
  propertyId: string;
  propertyName: string;
  startDate: string;
  endDate: string;
  label: string;
}

export interface SetUserActiveResult {
  user: AdminUserRow;
  /** Sesiones cerradas al desactivar. */
  sessionsClosed: number;
  /**
   * Reservas ACTIVE que aún no terminan. NO se cancelan: qué hacer con la
   * semana de alguien que se da de baja es una decisión de la superusuaria, no
   * un efecto colateral de pulsar un botón.
   */
  futureReservations: FutureReservationRef[];
}

export async function setUserActive({
  db,
  actor,
  userId,
  isActive,
  reason,
  ip,
  now = new Date(),
}: {
  db: Db;
  actor: AdminActor;
  userId: string;
  isActive: boolean;
  reason?: string;
  ip?: string | null;
  now?: Date;
}): Promise<SetUserActiveResult> {
  assertSuperuser(actor);

  const usuario = await db.user.findUnique({
    where: { id: userId },
    select: SELECCION_USUARIO,
  });
  if (!usuario) throw new AdminError("NOT_FOUND", "El usuario no existe.");

  if (!isActive && userId === actor.id) {
    // Sin esto, la única superusuaria puede dejarse fuera de su propia casa.
    throw new AdminError("SELF_DEACTIVATION", "No puedes desactivar tu propia cuenta.");
  }
  if (!isActive && usuario.role === "SUPERUSER") {
    await asegurarQuedaOtroSuperusuario(db, usuario.id);
  }

  const futuras = isActive ? [] : await reservasFuturasDe(db, userId, hoyDeNegocio(now));

  if (usuario.isActive === isActive) {
    return {
      user: { ...usuario, activeReservations: (await conteosDeReservas(db, [userId]))[0] ?? 0 },
      sessionsClosed: 0,
      futureReservations: futuras,
    };
  }

  const actualizado = await db.$transaction(async (tx) => {
    const fila = await tx.user.update({
      where: { id: userId },
      data: { isActive },
      select: SELECCION_USUARIO,
    });

    await writeAudit(tx, {
      // Reactivar no es "desactivar al revés": se anota como edición para que
      // el filtro de bajas de la bitácora signifique exactamente eso.
      action: isActive ? "USER_UPDATED" : "USER_DEACTIVATED",
      entityType: "USER",
      entityId: fila.id,
      actorUserId: actor.id,
      ip,
      details: {
        email: fila.email,
        isActive,
        motivo: reason ?? null,
        // Snapshot: dentro de dos años nadie podrá reconstruir qué semanas
        // tenía tomadas esta persona el día que se le dio de baja.
        reservasFuturas: futuras.map((r) => ({
          reservationId: r.reservationId,
          propertyName: r.propertyName,
          startDate: r.startDate,
        })),
      },
    });

    return fila;
  });

  // Fuera de la transacción porque `destroyAllSessions` usa el cliente global.
  // El orden es seguro: `getSessionFromToken` ya rechaza al usuario inactivo,
  // así que el acceso muere con el COMMIT y este borrado es solo higiene.
  const sessionsClosed = isActive ? 0 : await destroyAllSessions(userId);

  return {
    user: { ...actualizado, activeReservations: (await conteosDeReservas(db, [userId]))[0] ?? 0 },
    sessionsClosed,
    futureReservations: futuras,
  };
}

const cambioContrasenaSchema = z.object({
  currentPassword: z.string().min(1, "Escribe tu contraseña actual"),
  newPassword: z
    .string()
    .min(MIN_CONTRASENA, `La contraseña nueva debe tener al menos ${MIN_CONTRASENA} caracteres`)
    // argon2 hashea lo que le den; el tope evita que un cuerpo enorme se
    // convierta en trabajo de CPU gratis para quien lo mande.
    .max(200, "La contraseña no puede pasar de 200 caracteres"),
});

/**
 * Cambio de contraseña propio. NO exige SUPERUSER: cualquiera la cambia, pero
 * solo la suya —el actor es el sujeto de la operación—.
 */
export async function changeOwnPassword({
  db,
  actor,
  currentPassword,
  newPassword,
  keepSessionId,
  ip,
}: {
  db: Db;
  actor: AdminActor;
  currentPassword: string;
  newPassword: string;
  /**
   * Sesión que sobrevive: la del navegador donde se hizo el cambio. Sin esto,
   * cambiar la contraseña te echaría de la pantalla en la que estás.
   */
  keepSessionId?: string;
  ip?: string | null;
}): Promise<{ sessionsClosed: number }> {
  const datos = parseOrThrow(cambioContrasenaSchema, { currentPassword, newPassword });

  const usuario = await db.user.findUnique({
    where: { id: actor.id },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!usuario) throw new AdminError("NOT_FOUND", "El usuario no existe.");

  const correcta = await verifyPassword(usuario.passwordHash, datos.currentPassword);
  if (!correcta) {
    throw new AdminError("WRONG_PASSWORD", "La contraseña actual no es correcta.");
  }
  if (datos.currentPassword === datos.newPassword) {
    throw new AdminError("INVALID_INPUT", "La contraseña nueva debe ser distinta de la actual.");
  }

  const passwordHash = await hashPassword(datos.newPassword);

  return db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: usuario.id }, data: { passwordHash } });

    // El borrado va en la MISMA transacción (y no por `destroyAllSessions`, que
    // usa el cliente global y las cerraría todas): si el UPDATE se deshace, las
    // sesiones no deben quedar cerradas con la contraseña vieja aún vigente.
    const { count } = await tx.session.deleteMany({
      where: {
        userId: usuario.id,
        ...(keepSessionId ? { NOT: { id: keepSessionId } } : {}),
      },
    });

    await writeAudit(tx, {
      action: "USER_PASSWORD_CHANGED",
      entityType: "USER",
      entityId: usuario.id,
      actorUserId: actor.id,
      ip,
      details: { email: usuario.email, sesionesCerradas: count },
    });

    return { sessionsClosed: count };
  });
}

// ══════════════════════════════════════════════════════ internos

/** 18 bytes ≈ 144 bits: de sobra para una contraseña de un solo uso. */
function contrasenaTemporal(): string {
  return randomBytes(18).toString("base64url");
}

async function conteosDeReservas(db: Db, userIds: string[]): Promise<number[]> {
  const filas = await db.reservation.groupBy({
    by: ["userId"],
    where: { status: "ACTIVE", userId: { in: userIds } },
    _count: { _all: true },
  });
  const mapa = new Map(filas.map((f) => [f.userId, f._count._all]));
  return userIds.map((id) => mapa.get(id) ?? 0);
}

/**
 * Impide quedarse sin ninguna superusuaria activa: sería un sistema sin quien
 * abra semanas, dé de alta gente ni vea la bitácora, y sin forma de arreglarlo
 * desde la propia aplicación.
 */
async function asegurarQuedaOtroSuperusuario(db: Db, excluidoId: string): Promise<void> {
  const otros = await db.user.count({
    where: { role: "SUPERUSER", isActive: true, id: { not: excluidoId } },
  });
  if (otros === 0) {
    throw new AdminError(
      "LAST_SUPERUSER",
      "Es la única superusuaria activa: nombra a otra antes de quitarle el rol o darla de baja.",
    );
  }
}

/** Reservas ACTIVE cuya semana todavía no termina. */
async function reservasFuturasDe(
  db: Db,
  userId: string,
  hoyISO: string,
): Promise<FutureReservationRef[]> {
  const filas = await db.reservation.findMany({
    where: {
      userId,
      status: "ACTIVE",
      // `endDate` y no `startDate`: la semana en curso todavía se está usando.
      slot: { endDate: { gte: fechaCivil(hoyISO) } },
    },
    select: {
      id: true,
      slot: {
        select: {
          id: true,
          startDate: true,
          endDate: true,
          property: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { slot: { startDate: "asc" } },
  });

  return filas.map((r) => {
    const inicio = isoDeFecha(r.slot.startDate);
    const fin = isoDeFecha(r.slot.endDate);
    return {
      reservationId: r.id,
      slotId: r.slot.id,
      propertyId: r.slot.property.id,
      propertyName: r.slot.property.name,
      startDate: inicio,
      endDate: fin,
      label: etiquetaSemana(inicio, fin),
    };
  });
}
