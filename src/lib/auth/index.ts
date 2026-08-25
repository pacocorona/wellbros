/**
 * Punto de entrada de la capa de autenticación.
 *
 * Importa siempre desde `@/lib/auth`, no desde los módulos internos: así el
 * día que cambie el reparto de archivos no hay que tocar a quien la usa.
 *
 * Solo servidor: depende de `node:crypto`, Prisma y `next/headers`.
 */

export { hashPassword, verifyPassword, verifyDummyPassword } from "./password";

export {
  // Constantes
  SESSION_COOKIE_NAME,
  SESSION_TTL_DAYS,
  SESSION_TTL_MS,
  // Ciclo de vida
  createSession,
  getSessionFromToken,
  destroySession,
  destroyAllSessions,
  purgeExpiredSessions,
  // Cookie
  getSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  // Petición actual
  getCurrentSession,
  getCurrentUser,
  requireUser,
  requireSuperuser,
  // Errores
  AuthError,
  isAuthError,
} from "./session";

export type {
  AuthErrorCode,
  SessionUser,
  SessionContext,
  SessionOrigin,
  CreatedSession,
} from "./session";
