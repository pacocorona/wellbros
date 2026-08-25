/**
 * Servicios de cesión de días.
 *
 * Importa siempre desde `@/server/grants`: los módulos internos comparten
 * ayudantes entre sí y ese reparto puede cambiar sin previo aviso.
 *
 * Ninguna de estas funciones resuelve la sesión: reciben el actor y el cliente
 * de Prisma. La Server Action que las envuelve es quien llama a `requireUser()`
 * y quien traduce `GrantError` a un mensaje en pantalla.
 */

export { createDayGrants } from "./create";
export type {
  CreateDayGrantsInput,
  CreateDayGrantsResult,
  GrantActor,
  GrantSummary,
} from "./create";

export { revokeDayGrants } from "./revoke";
export type {
  RevokeDayGrantsInput,
  RevokeDayGrantsResult,
  RevokedBatch,
} from "./revoke";

export { GrantError, isGrantError } from "./errors";
export type { GrantErrorCode } from "./errors";
