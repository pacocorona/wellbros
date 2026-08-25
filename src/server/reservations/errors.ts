/**
 * Errores de negocio de las reservas.
 *
 * Son errores TIPADOS y no cadenas sueltas porque quien los consume no es una
 * persona sino la capa de interfaz: la Server Action los traduce a un aviso
 * concreto («esta semana ya fue reservada», «abre el 16 de septiembre») y la
 * futura API los mapeará a un código HTTP. Con un `Error` genérico esa decisión
 * habría que tomarla comparando textos, que se rompen al corregir una tilde.
 *
 * `releaseAt` viaja dentro del error a propósito: cuando el rechazo es por
 * ventana, la interfaz necesita la fecha exacta de apertura para poder
 * reintentar sola en lugar de mostrar un error crudo (docs §07).
 *
 * Este módulo no importa Prisma ni Next: es el vocabulario compartido entre el
 * servicio y cualquier transporte que lo exponga.
 */

/** Motivos por los que una operación sobre reservas no procede. */
export type ReservationErrorCode =
  /** El slot no existe (o el identificador no es un UUID). */
  | "SLOT_NOT_FOUND"
  /** El slot existe pero no admite reservas: cerrado o propiedad desactivada. */
  | "SLOT_NOT_OPEN"
  /** Alguien más se quedó con la semana. */
  | "SLOT_TAKEN"
  /** La semana pertenece a un mes que todavía no abre (§07). */
  | "WEEK_NOT_YET_BOOKABLE"
  /** La semana ya terminó, o ya empezó y la política no permite tomarla. */
  | "WEEK_PAST"
  /** El actor no tiene permiso para esta operación. */
  | "NOT_ALLOWED"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_ALREADY_CANCELLED"
  /** Saltarse la ventana exige justificarlo por escrito. */
  | "OVERRIDE_REASON_REQUIRED";

/**
 * Mensaje por defecto de cada código, en español y dirigido al usuario final:
 * la interfaz puede mostrarlos tal cual sin mantener su propio diccionario.
 */
export const RESERVATION_ERROR_MESSAGES: Record<ReservationErrorCode, string> = {
  SLOT_NOT_FOUND: "Esa semana ya no existe en el calendario.",
  SLOT_NOT_OPEN: "Esa semana no está disponible para reservar.",
  SLOT_TAKEN: "Esa semana ya fue reservada.",
  WEEK_NOT_YET_BOOKABLE: "Esa semana todavía no se habilita.",
  WEEK_PAST: "Esa semana ya no se puede reservar.",
  NOT_ALLOWED: "No tienes permiso para hacer esto.",
  RESERVATION_NOT_FOUND: "Esa reserva ya no existe.",
  RESERVATION_ALREADY_CANCELLED: "Esa reserva ya estaba cancelada.",
  OVERRIDE_REASON_REQUIRED:
    "Reservar fuera de la ventana de apertura exige escribir un motivo.",
};

export interface ReservationErrorOptions {
  /** Sustituye al mensaje por defecto cuando se puede ser más concreto. */
  message?: string;
  /** Solo en `WEEK_NOT_YET_BOOKABLE`: instante exacto en que la semana abre. */
  releaseAt?: Date;
  cause?: unknown;
}

export class ReservationError extends Error {
  readonly code: ReservationErrorCode;
  /** Instante de apertura de la semana, cuando el rechazo es por ventana. */
  readonly releaseAt?: Date;

  constructor(code: ReservationErrorCode, options: ReservationErrorOptions = {}) {
    super(options.message ?? RESERVATION_ERROR_MESSAGES[code], {
      cause: options.cause,
    });
    // `name` se fija a mano: la minificación de producción renombra la clase y
    // sin esto el error llegaría a los registros como "Error".
    this.name = "ReservationError";
    this.code = code;
    if (options.releaseAt) this.releaseAt = new Date(options.releaseAt.getTime());
  }
}

/**
 * Discrimina un error de negocio de uno de infraestructura.
 *
 * No usa `instanceof` a secas: en desarrollo el recargado en caliente de Next
 * puede dejar dos copias del módulo vivas, y entonces `instanceof` falla para
 * un error perfectamente legítimo. La comprobación estructural sobrevive a eso.
 */
export function isReservationError(error: unknown): error is ReservationError {
  if (error instanceof ReservationError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidato = error as { name?: unknown; code?: unknown };
  return (
    candidato.name === "ReservationError" &&
    typeof candidato.code === "string" &&
    candidato.code in RESERVATION_ERROR_MESSAGES
  );
}
