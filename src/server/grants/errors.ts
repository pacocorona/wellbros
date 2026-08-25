/**
 * Errores del módulo de cesiones.
 *
 * Son errores de NEGOCIO, no de programación: la interfaz los traduce a un
 * mensaje para la persona que cede. Por eso llevan un `code` estable —el texto
 * puede reescribirse sin romper a quien lo consume— y la lista de días
 * conflictivos, que es lo único que permite señalar en el calendario *cuáles*
 * fallaron en vez de tumbar la operación entera con un "no se pudo".
 *
 * La base de datos valida lo mismo por trigger (ver la migración: WB001, WB002,
 * WB003 y el índice único parcial `day_grants_reservation_id_grant_date_active_key`).
 * Esa es la garantía; esto es la explicación. Cuando el trigger gana la carrera
 * —una cancelación concurrente, otro navegador cediendo el mismo día—
 * `translateDatabaseError` convierte el error crudo de PostgreSQL en el mismo
 * código que habría producido la comprobación en la aplicación, para que quien
 * llama no tenga dos vocabularios distintos según quién detectó el problema.
 */

import { Prisma } from "@/generated/prisma/client";

export type GrantErrorCode =
  /** No se recibió ninguna fecha que ceder o revocar. */
  | "NO_DATES"
  /** Alguna fecha no es un `yyyy-MM-dd` real. */
  | "INVALID_DATE"
  | "RESERVATION_NOT_FOUND"
  /** La reserva está cancelada: sus cesiones ya cayeron con ella. */
  | "RESERVATION_NOT_ACTIVE"
  /** Solo el dueño cede o revoca; la superusuaria tampoco lo hace en su nombre. */
  | "NOT_RESERVATION_OWNER"
  | "GRANTEE_NOT_FOUND"
  | "GRANTEE_INACTIVE"
  /** Cederse a uno mismo no es una cesión (CHECK en la base). */
  | "GRANTEE_IS_GRANTOR"
  /** El día no cae dentro del viernes→jueves de la semana. */
  | "DATE_OUT_OF_WEEK"
  /** El día ya transcurrió: ni se cede ni se retira lo que ya pasó. */
  | "GRANT_DATE_PAST"
  /** Ese día ya está cedido de forma ACTIVE. */
  | "DAY_ALREADY_GRANTED"
  /** No hay cesión viva que revocar en ese día. */
  | "GRANT_NOT_FOUND";

export class GrantError extends Error {
  readonly code: GrantErrorCode;
  /** Días implicados, `yyyy-MM-dd` y en orden. Vacío si el fallo no es de fechas. */
  readonly dates: readonly string[];

  constructor(code: GrantErrorCode, message: string, dates: readonly string[] = []) {
    super(message);
    this.name = "GrantError";
    this.code = code;
    this.dates = dates;
  }
}

export function isGrantError(error: unknown): error is GrantError {
  return error instanceof GrantError;
}

/** Atajo legible para lanzar desde los servicios. */
export function grantError(
  code: GrantErrorCode,
  message: string,
  dates: readonly string[] = [],
): GrantError {
  return new GrantError(code, message, dates);
}

// ───────────────────────────────────────── traducción de errores de la base

/**
 * Causa que el adaptador de driver adjunta al error de Prisma.
 *
 * Se lee de forma defensiva y no con un cast: la forma exacta de `meta` es un
 * detalle interno de Prisma, y si cambia prefiero perder el mensaje bonito a
 * reventar con un TypeError encima del error original.
 */
function driverErrorCode(error: Prisma.PrismaClientKnownRequestError): string | null {
  const meta: unknown = error.meta;
  if (typeof meta !== "object" || meta === null) return null;

  const adapterError: unknown = (meta as Record<string, unknown>).driverAdapterError;
  if (typeof adapterError !== "object" || adapterError === null) return null;

  const cause: unknown = (adapterError as Record<string, unknown>).cause;
  if (typeof cause !== "object" || cause === null) return null;

  const code: unknown = (cause as Record<string, unknown>).originalCode;
  return typeof code === "string" ? code : null;
}

/**
 * Convierte un error de PostgreSQL en un `GrantError` equivalente.
 *
 * Devuelve `null` cuando el error no es de los nuestros: en ese caso hay que
 * relanzar el original tal cual, porque disfrazar un fallo de conexión de
 * "día ya cedido" haría perder horas a quien lo depure.
 *
 * `dates` es el lote que se intentaba escribir. El índice único no dice *qué*
 * fila chocó cuando el INSERT lleva varias, así que se informa el lote entero:
 * es impreciso, pero honesto. La comprobación previa en la aplicación resuelve
 * el caso normal con la lista exacta; aquí solo llegan las carreras.
 */
export function translateDatabaseError(
  error: unknown,
  dates: readonly string[] = [],
): GrantError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;

  // P2002: índice único parcial (reservation_id, grant_date) WHERE status = 'ACTIVE'.
  if (error.code === "P2002") {
    return new GrantError(
      "DAY_ALREADY_GRANTED",
      "Alguno de esos días ya estaba cedido cuando se guardó la cesión. Vuelve a intentarlo.",
      dates,
    );
  }

  // P2039: error de base propagado por el adaptador. Los WB0xx son los del
  // trigger `wb_day_grant_validate`.
  switch (driverErrorCode(error)) {
    case "WB001":
      return new GrantError(
        "RESERVATION_NOT_ACTIVE",
        "La reserva ya no está activa: no se pueden ceder sus días.",
      );
    case "WB002":
      return new GrantError(
        "DATE_OUT_OF_WEEK",
        "Alguno de esos días no pertenece a la semana de la reserva.",
        dates,
      );
    case "WB003":
      return new GrantError(
        "NOT_RESERVATION_OWNER",
        "Solo quien tiene la reserva puede ceder sus días.",
      );
    default:
      return null;
  }
}
