/**
 * Contratos del módulo de notificaciones.
 *
 * Este archivo no depende de Prisma ni de ningún proveedor: define el
 * vocabulario que comparten la cola (dispatch), el worker, las plantillas y los
 * adaptadores de canal. Así un canal nuevo se escribe sin tocar nada más.
 *
 * Regla transversal (docs/diseno-wellbros.html §08): el contenido de un aviso
 * debe poder reconstruirse ENTERO a partir de su `payload`. Nada de fechas
 * calculadas en el momento del render: si el texto cambia entre reintentos,
 * Resend detecta la clave de idempotencia repetida con otro cuerpo y responde
 * error en lugar de reenviar. Por eso los payloads llevan las fechas ya
 * formateadas por quien encola, no los datos crudos para formatear después.
 */

/** Espejo del enum `NotifChannel` del esquema. */
export type NotificationChannelKey = "EMAIL" | "WHATSAPP";

/** Espejo del enum `OutboxStatus` del esquema. */
export type OutboxStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "DEAD";

/** Eventos de negocio que generan aviso. Se guarda como texto en la columna. */
export type NotificationEventType =
  | "RESERVATION_CREATED"
  | "RESERVATION_CANCELLED"
  | "GRANT_CREATED"
  | "GRANT_REVOKED"
  | "SLOTS_OPENED"
  | "MONTH_WINDOW_OPENED"
  | "USER_INVITED";

const EVENT_TYPES: readonly NotificationEventType[] = [
  "RESERVATION_CREATED",
  "RESERVATION_CANCELLED",
  "GRANT_CREATED",
  "GRANT_REVOKED",
  "SLOTS_OPENED",
  "MONTH_WINDOW_OPENED",
  "USER_INVITED",
];

/** Valida el `event_type` que vuelve de la base, que es texto libre. */
export function isNotificationEventType(
  value: unknown,
): value is NotificationEventType {
  return (
    typeof value === "string" &&
    (EVENT_TYPES as readonly string[]).includes(value)
  );
}

// ───────────────────────────────────────────────────────────── payloads
//
// Todos los payloads se declaran con `type` y no con `interface` a propósito:
// TypeScript solo da firma de índice implícita a los alias de tipo, y sin ella
// Prisma rechaza asignarlos a una columna Json (`InputJsonValue`).

/**
 * Una semana, ya resuelta y formateada por quien encola.
 * El render nunca recalcula fechas (ver nota de determinismo arriba).
 */
export type WeekRef = {
  slotId: string;
  propertyName: string;
  /** Viernes de inicio, `yyyy-MM-dd`. */
  startDate: string;
  /** Jueves final, `yyyy-MM-dd`. */
  endDate: string;
  /** Etiqueta en español, p. ej. «viernes 2 al jueves 8 de octubre de 2026». */
  label: string;
};

/** Un día cedido, ya formateado. */
export type GrantedDay = {
  grantId: string;
  /** `yyyy-MM-dd`. */
  date: string;
  /** Etiqueta en español, p. ej. «sábado 3 de octubre». */
  label: string;
};

export type ReservationCreatedPayload = {
  reservationId: string;
  ownerUserId: string;
  ownerName: string;
  week: WeekRef;
  /** Ruta relativa dentro de la app; se vuelve absoluta con APP_BASE_URL. */
  path: string;
  /** La creó el superusuario saltándose la ventana de apertura (§07). */
  windowOverride?: boolean;
};

export type ReservationCancelledPayload = {
  reservationId: string;
  ownerUserId: string;
  ownerName: string;
  cancelledByName: string;
  cancelReason?: string;
  week: WeekRef;
  path: string;
  /**
   * Cuándo vuelve a poder tomarse. Si la semana pertenece a un mes que aún no
   * abre, el aviso se programa para el instante de apertura (§07) y este texto
   * lo explica.
   */
  availableFromLabel?: string;
};

export type GrantChangedPayload = {
  /**
   * Identificador del lote de cesión: una misma acción puede ceder varios
   * días, y todos viajan en un solo aviso. Es la entidad de la clave de
   * deduplicación.
   */
  grantBatchId: string;
  reservationId: string;
  grantorUserId: string;
  grantorName: string;
  granteeUserId: string;
  granteeName: string;
  week: WeekRef;
  days: GrantedDay[];
  path: string;
};

export type SlotsOpenedPayload = {
  /** Identificador de la tanda de apertura; entidad de la clave. */
  batchId: string;
  propertyName: string;
  weeks: WeekRef[];
  path: string;
  /**
   * Cómo describir la ventana de apertura, YA REDACTADO por quien encola
   * («quince días antes de que empiece», «el día 15 de cada mes»…). No se
   * escribe en la plantilla porque la anticipación es configurable
   * (bookingWindowDays y el modo FIXED_DAY): con otra política, un texto fijo
   * mentiría. Se omite si no se quiere mencionar la regla.
   */
  windowRuleLabel?: string;
};

export type MonthWindowOpenedPayload = {
  /**
   * La política de reserva es POR PROPIEDAD, así que dos propiedades pueden
   * abrir el mismo mes en instantes distintos. Sin la propiedad en la clave de
   * deduplicación, el segundo aviso chocaría con el primero y se descartaría en
   * silencio, devolviendo cero encolados sin error.
   */
  propertyId: string;
  /** `yyyy-MM` del mes habilitado. */
  anchorMonth: string;
  /** «octubre de 2026». */
  monthLabel: string;
  weeks: WeekRef[];
  path: string;
};

export type UserInvitedPayload = {
  /**
   * Entidad de la clave: la INVITACIÓN, no el usuario. Deduplicar por usuario
   * haría que reinvitar a alguien cuyo enlace caducó no enviara nada — y la
   * propia plantilla le dice que pida uno nuevo.
   */
  invitationId: string;
  userId: string;
  fullName: string;
  invitedByName: string;
  /** Ruta con el token de alta de contraseña. */
  path: string;
  /** «48 horas»: texto, nunca un cálculo hecho al renderizar. */
  expiresInLabel: string;
};

/** Payload propio de cada evento, tal como lo entrega quien encola. */
export type NotificationPayloadMap = {
  RESERVATION_CREATED: ReservationCreatedPayload;
  RESERVATION_CANCELLED: ReservationCancelledPayload;
  GRANT_CREATED: GrantChangedPayload;
  GRANT_REVOKED: GrantChangedPayload;
  SLOTS_OPENED: SlotsOpenedPayload;
  MONTH_WINDOW_OPENED: MonthWindowOpenedPayload;
  USER_INVITED: UserInvitedPayload;
};

export type EventPayload<E extends NotificationEventType> =
  NotificationPayloadMap[E];

/** Cualquier payload de evento, sin el contexto del destinatario. */
export type AnyEventPayload = NotificationPayloadMap[NotificationEventType];

/**
 * Lo que `dispatch` añade a cada fila: es lo único que cambia entre los
 * destinatarios de un mismo evento. Permite el saludo por nombre y que la
 * plantilla sepa si quien lee es el cedente, el receptor o un tercero, sin que
 * el llamador tenga que armar un payload distinto por persona.
 */
export type RecipientContext = {
  recipientUserId: string;
  recipientName: string;
};

/** Payload tal como llega al render: el del evento más el del destinatario. */
export type RenderPayload<E extends NotificationEventType> = EventPayload<E> &
  RecipientContext;

export type AnyRenderPayload = {
  [E in NotificationEventType]: RenderPayload<E>;
}[NotificationEventType];

// ───────────────────────────────────────────────────────── mensajes y canal

/** Contenido ya renderizado y listo para congelarse en la fila. */
export type RenderedMessage = {
  subject: string;
  html: string;
  text: string;
};

/** Reflejo del modelo `NotificationOutbox` con los tipos ya estrechados. */
export type OutboxMessage = {
  id: string;
  channel: NotificationChannelKey;
  recipientUserId: string;
  /** Snapshot de la dirección al encolar: si el usuario la cambia, este aviso
   *  sigue saliendo a donde se prometió. */
  recipientAddress: string;
  eventType: NotificationEventType;
  payload: AnyRenderPayload;
  renderedSubject: string | null;
  renderedHtml: string | null;
  renderedText: string | null;
  /** Clave de idempotencia: `<evento>/<entidad>/<usuario>`. */
  dedupeKey: string;
  status: OutboxStatus;
  attempts: number;
  scheduledFor: Date;
  nextAttemptAt: Date;
  lastError: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
};

/**
 * Fila lista para salir: el contenido ya está congelado en la base, así que los
 * tres campos renderizados dejan de ser opcionales. Es lo único que ve un canal.
 */
export type SendableMessage = Omit<
  OutboxMessage,
  "renderedSubject" | "renderedHtml" | "renderedText"
> & {
  renderedSubject: string;
  renderedHtml: string;
  renderedText: string;
};

/**
 * Resultado de un intento de envío.
 *
 * `retryable` solo tiene sentido cuando `ok` es falso, y es la decisión más
 * importante del adaptador: el worker no sabe nada del proveedor y se limita a
 * obedecerla. Ante la duda, un fallo es reintentable — la idempotencia del
 * proveedor evita el duplicado, mientras que darlo por perdido pierde el aviso.
 */
export type ChannelResult = {
  ok: boolean;
  providerMessageId?: string;
  retryable?: boolean;
  error?: string;
};

export interface NotificationChannel {
  readonly key: NotificationChannelKey;
  /** Se consulta al encolar y al enviar: un canal apagado no genera filas. */
  isEnabled(): boolean;
  send(msg: SendableMessage): Promise<ChannelResult>;
}
