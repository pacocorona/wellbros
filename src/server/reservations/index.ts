/**
 * Servicios de reserva.
 *
 * Punto de entrada único: las Server Actions y la futura /api/v1 importan desde
 * `@/server/reservations`, nunca de los módulos internos. Así el reparto de
 * archivos puede cambiar sin tocar a quien los usa.
 *
 * Recordatorio para quien integre: estas funciones NO resuelven la sesión. Se
 * les pasa el actor ya autenticado (`requireUser()` / `requireSuperuser()`) y el
 * cliente de Prisma. Ese es justamente el motivo de que puedan reutilizarse
 * desde una app nativa sin reescribirlas.
 */

export {
  createReservation,
  type CreateReservationInput,
  type CreatedReservation,
  type ReservationActor,
} from "./create";

export {
  cancelReservation,
  type CancelReservationInput,
  type CancelledReservation,
  type CancelledGrant,
} from "./cancel";

export {
  ReservationError,
  isReservationError,
  RESERVATION_ERROR_MESSAGES,
  type ReservationErrorCode,
  type ReservationErrorOptions,
} from "./errors";
