/**
 * Sesiones de servidor con token opaco.
 *
 * Decisión (ver la tarea del proyecto): no usamos Auth.js. Su proveedor de
 * credenciales obliga a sesiones JWT y el diseño pide sesiones en base de
 * datos —revocables al instante y auditables—, así que la capa es propia y
 * mínima.
 *
 * Cómo funciona:
 *   - Se generan 32 bytes aleatorios (256 bits) y se envían al navegador en
 *     una cookie httpOnly.
 *   - En la base solo se guarda el SHA-256 del token, nunca el token. Un
 *     volcado de `sessions` no permite suplantar a nadie.
 *   - Basta SHA-256 (y no Argon2): el token no es una contraseña elegida por
 *     una persona sino un valor aleatorio de 256 bits, no hay diccionario que
 *     lo alcance. Lo que se busca aquí es que el valor robado no sea
 *     reutilizable, no frenar la fuerza bruta.
 *
 * Este módulo solo corre en el servidor: usa `node:crypto`, Prisma y
 * `next/headers`. No lo importes desde componentes de cliente.
 */

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";

import { prisma } from "@/lib/db";
import type { UserRole } from "@/generated/prisma/enums";

// ───────────────────────────────────────────────────────── constantes

/** Nombre de la cookie de sesión. */
export const SESSION_COOKIE_NAME = "wellbros_session";

/** Duración de la sesión: 30 días. */
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Cada cuánto se refresca `last_seen_at`. Escribirlo en cada petición
 * convertiría toda navegación —incluida cada imagen o carga parcial— en un
 * UPDATE, con su bloqueo de fila y su entrada en el WAL. Una hora de
 * resolución sobra para saber si una sesión sigue viva.
 */
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

/** `sessions.ip` es varchar(64) y `user_agent` texto: recortamos por higiene. */
const MAX_IP_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;

// ───────────────────────────────────────────────────────────── errores

export type AuthErrorCode = "UNAUTHENTICATED" | "FORBIDDEN";

/**
 * Error tipado para que las rutas y acciones distingan "no hay sesión" (401,
 * mandar a /login) de "el rol no alcanza" (403, no revelar más).
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = code === "UNAUTHENTICATED" ? 401 : 403;
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

// ────────────────────────────────────────────────────────────── tipos

/**
 * Usuario tal como lo ve la aplicación. Nunca incluye `passwordHash`: la
 * selección de columnas es explícita justo para que no se cuele por descuido.
 */
export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  whatsappOptIn: boolean;
  role: UserRole;
  theme: string;
}

export interface SessionContext {
  user: SessionUser;
  sessionId: string;
  expiresAt: Date;
}

export interface SessionOrigin {
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  /** Token EN CLARO: solo existe aquí y en la cookie. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

const SESSION_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  whatsappOptIn: true,
  role: true,
  theme: true,
  isActive: true,
} as const;

// ──────────────────────────────────────────────────────────── internos

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

// ─────────────────────────────────────────────── ciclo de vida de sesión

/**
 * Crea una sesión y devuelve el token en claro, que el llamador debe poner en
 * la cookie con `setSessionCookie`. El token no vuelve a estar disponible.
 */
export async function createSession(
  userId: string,
  origin: SessionOrigin = {},
): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: truncate(origin.ip, MAX_IP_LENGTH),
      userAgent: truncate(origin.userAgent, MAX_USER_AGENT_LENGTH),
    },
    select: { id: true },
  });

  return { token, sessionId: session.id, expiresAt };
}

/**
 * Resuelve un token a su sesión y usuario, o `null` si no vale.
 *
 * Descarta la sesión caducada (y la borra, para que la tabla no crezca) y
 * también la de un usuario desactivado: dar de baja a alguien debe cortarle el
 * acceso de inmediato, sin esperar a que caduque la cookie.
 */
export async function getSessionFromToken(
  token: string,
): Promise<SessionContext | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      lastSeenAt: true,
      user: { select: SESSION_USER_SELECT },
    },
  });

  if (!session) return null;

  const now = new Date();

  if (session.expiresAt.getTime() <= now.getTime()) {
    // El borrado es limpieza, no autorización: la sesión ya caducó y se devuelve
    // null pase lo que pase. Si el DELETE falla (permisos, bloqueo, réplica de
    // solo lectura), tumbar la petición convertiría un «tu sesión caducó, entra
    // de nuevo» en un error 500. La fila la barrerá purgeExpiredSessions.
    await prisma.session
      .deleteMany({ where: { id: session.id } })
      .catch(() => undefined);
    return null;
  }

  if (!session.user.isActive) return null;

  if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
    // Un fallo aquí no debe tumbar la petición: `last_seen_at` es telemetría,
    // no autorización. Además esto puede ocurrir durante el render de un
    // componente de servidor, donde una excepción rompería la página.
    await prisma.session
      .updateMany({ where: { id: session.id }, data: { lastSeenAt: now } })
      .catch(() => undefined);
  }

  // Se construye campo a campo (en vez de propagar el registro) para que
  // añadir una columna al modelo nunca la exponga aquí sin querer.
  const user: SessionUser = {
    id: session.user.id,
    email: session.user.email,
    fullName: session.user.fullName,
    phone: session.user.phone,
    whatsappOptIn: session.user.whatsappOptIn,
    role: session.user.role,
    theme: session.user.theme,
  };

  return { user, sessionId: session.id, expiresAt: session.expiresAt };
}

/** Cierra una sesión concreta (logout). Idempotente. */
export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/**
 * Cierra todas las sesiones de un usuario. Se usa al cambiar la contraseña y
 * al desactivar la cuenta.
 */
export async function destroyAllSessions(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}

/** Limpieza de sesiones caducadas, pensada para una tarea programada. */
export async function purgeExpiredSessions(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  return count;
}

// ───────────────────────────────────────────────────────────── cookie

/**
 * `secure` solo en producción: en desarrollo la aplicación va por http y una
 * cookie `secure` nunca llegaría a viajar.
 *
 * `sameSite: "lax"` deja que la cookie acompañe la navegación normal desde
 * enlaces externos (por ejemplo el enlace de un correo) pero no las peticiones
 * cruzadas que escriben, que es la defensa básica contra CSRF.
 */
function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  } as const;
}

/** Lee el token de la cookie. Válido en cualquier contexto de servidor. */
export async function getSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}

/**
 * Escribe la cookie de sesión.
 * Solo puede llamarse desde una Server Action o un Route Handler: Next no
 * permite escribir cookies durante el render de un componente de servidor.
 */
export async function setSessionCookie(
  token: string,
  expiresAt: Date,
): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(expiresAt));
}

/** Borra la cookie de sesión. Mismas restricciones que `setSessionCookie`. */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

// ──────────────────────────────────────────────── sesión de la petición

/**
 * Sesión de la petición actual, resuelta desde la cookie.
 *
 * Va envuelta en `cache` de React para que, aunque la llamen el layout, la
 * página y tres componentes, la consulta a la base ocurra una sola vez por
 * petición.
 */
export const getCurrentSession = cache(
  async (): Promise<SessionContext | null> => {
    const token = await getSessionCookie();
    if (!token) return null;
    return getSessionFromToken(token);
  },
);

/** Usuario de la petición actual, o `null` si no hay sesión válida. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}

/** Exige sesión. Lanza `AuthError("UNAUTHENTICATED")` si no la hay. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthError("UNAUTHENTICATED", "Necesitas iniciar sesión.");
  }
  return user;
}

/**
 * Exige sesión de superusuario.
 * Distingue 401 de 403 a propósito: quien no ha entrado va a /login; quien ha
 * entrado y no le alcanza el rol recibe un 403 sin más detalle.
 */
export async function requireSuperuser(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "SUPERUSER") {
    throw new AuthError("FORBIDDEN", "No tienes permiso para esta acción.");
  }
  return user;
}
