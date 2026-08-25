/**
 * Worker de la cola de notificaciones.
 *
 * Corre como servicio aparte (wellbros-worker.service, §10): la aplicación web
 * solo encola; enviar correo es lento y falla, y eso no puede colgarse de la
 * petición del usuario.
 *
 * Cuatro decisiones que sostienen el resto del archivo:
 *
 *  1. RESERVA ATÓMICA. Cada lote se toma con `SELECT … FOR UPDATE SKIP LOCKED`
 *     envuelto en un `UPDATE … RETURNING`, así que la fila queda marcada
 *     SENDING y con el intento ya contado antes de soltar el candado. Dos
 *     workers (o un despliegue solapado) nunca se pisan, y el envío —una
 *     llamada de red— ocurre FUERA de cualquier transacción abierta.
 *
 *  2. CONTENIDO CONGELADO. El asunto y el cuerpo se renderizan UNA vez y se
 *     guardan en la propia fila. Los reintentos reenvían exactamente esos
 *     bytes, nunca vuelven a renderizar. Si el cuerpo cambiara, Resend
 *     rechazaría la clave de idempotencia repetida en lugar de reenviar.
 *
 *  3. ABANDONO ANTES DE LAS 24 HORAS. La ventana de idempotencia de Resend dura
 *     24 h: dentro de ese plazo un reintento devuelve la respuesta original sin
 *     duplicar el correo; pasado el plazo, la clave se olvidó y el mismo
 *     reintento SÍ generaría un segundo correo. Por eso una fila que lleva más
 *     de 20 h viva se marca DEAD en vez de insistir: mejor un aviso que no
 *     salió y se ve en el panel, que dos copias en el buzón de todos.
 *
 *  4. ESTRANGULAMIENTO. Resend admite 10 peticiones por segundo por equipo; el
 *     worker se queda por debajo a propósito, porque agotar el límite convierte
 *     envíos buenos en 429 que hay que reintentar.
 */

import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

import { getChannel } from "./dispatch";
import { render } from "./templates";
import type {
  AnyRenderPayload,
  NotificationChannelKey,
  NotificationEventType,
  RenderedMessage,
  SendableMessage,
} from "./types";
import { isNotificationEventType } from "./types";

// ────────────────────────────────────────────────────────────── ajustes

/**
 * Espera antes de cada reintento, en minutos. Con `MAX_ATTEMPTS = 5` solo se
 * usan las cuatro primeras (cinco intentos dejan cuatro huecos); la quinta
 * queda escrita para cuando se suba el tope sin tener que recalcular nada.
 */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 480] as const;

export const MAX_ATTEMPTS = 5;

/** Ver decisión 3 de la cabecera. La ventana de Resend es de 24 h. */
export const ABANDON_AFTER_MS = 20 * 60 * 60 * 1000;

/** ≈8.3 envíos por segundo: por debajo del límite de 10/s de Resend. */
const MIN_INTERVAL_MS = 120;

/** Cuánto puede quedarse una fila en SENDING antes de darla por huérfana. */
const LEASE_MINUTES = 10;

const DEFAULT_BATCH_SIZE = 25;

/** Pausa cuando la cola queda vacía. */
const DEFAULT_POLL_MS = 5_000;

// ──────────────────────────────────────────────────────────────── apoyo

/**
 * El worker escribe en stdout y systemd lo recoge en journald. Se emite JSON
 * por línea —y no `console.log`, prohibido en el proyecto— para que los logs se
 * puedan filtrar sin parsear prosa.
 */
function log(
  level: "info" | "warn" | "error",
  fields: Record<string, string | number>,
): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, ...fields })}\n`,
  );
}

function errorToString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Espaciado entre envíos. El estado es de módulo porque el worker es un solo
 * proceso; si algún día se levantan varias réplicas, el límite de 10/s es del
 * EQUIPO y habría que repartirlo (o coordinarlo en la base), no multiplicarlo.
 */
let ultimoEnvio = 0;

async function throttle(): Promise<void> {
  const espera = ultimoEnvio + MIN_INTERVAL_MS - Date.now();
  if (espera > 0) await sleep(espera);
  ultimoEnvio = Date.now();
}

/** Espera del reintento número `attempts`, con ±15 % de dispersión. */
export function backoffMs(attempts: number): number {
  const indice = Math.min(
    Math.max(attempts, 1) - 1,
    BACKOFF_MINUTES.length - 1,
  );
  const base = BACKOFF_MINUTES[indice] * 60_000;
  // El jitter evita que un lote que falló junto vuelva junto y repita el 429.
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

// ─────────────────────────────────────────────────────── acceso a la cola

/** Fila reservada. Los nombres vienen ya en camelCase desde el SQL. */
type ClaimedRow = {
  id: string;
  channel: string;
  recipientUserId: string;
  recipientAddress: string;
  eventType: string;
  payload: unknown;
  renderedSubject: string | null;
  renderedHtml: string | null;
  renderedText: string | null;
  dedupeKey: string;
  attempts: number;
  scheduledFor: Date;
  nextAttemptAt: Date;
  createdAt: Date;
};

/**
 * Devuelve a la cola las filas que quedaron en SENDING porque el worker murió
 * a mitad de un envío. El intento ya está contado, así que una caída en bucle
 * no reintenta para siempre: se le acaban los intentos igual.
 */
async function reclaimStale(prisma: PrismaClient): Promise<number> {
  // Los literales de enum van escritos en el SQL, no como parámetros: un
  // parámetro viaja como texto y PostgreSQL no lo compara con `outbox_status`.
  return prisma.$executeRaw`
    UPDATE notification_outbox
       SET status = 'PENDING'
     WHERE status = 'SENDING'
       AND next_attempt_at <= now()
  `;
}

/**
 * Reserva hasta `batchSize` avisos listos para salir.
 *
 * `SKIP LOCKED` es lo que permite varios workers sin colas de espera: quien
 * llega segundo salta las filas ya tomadas en vez de bloquearse tras ellas.
 */
async function claimBatch(
  prisma: PrismaClient,
  batchSize: number,
): Promise<ClaimedRow[]> {
  return prisma.$queryRaw<ClaimedRow[]>`
    UPDATE notification_outbox AS o
       SET status = 'SENDING',
           attempts = o.attempts + 1,
           next_attempt_at = now() + make_interval(mins => ${LEASE_MINUTES})
     WHERE o.id IN (
       SELECT c.id
         FROM notification_outbox AS c
        WHERE c.status = 'PENDING'
          AND c.scheduled_for <= now()
          AND c.next_attempt_at <= now()
        ORDER BY c.scheduled_for ASC, c.created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING o.id::text                AS "id",
              o.channel::text           AS "channel",
              o.recipient_user_id::text AS "recipientUserId",
              o.recipient_address       AS "recipientAddress",
              o.event_type              AS "eventType",
              o.payload                 AS "payload",
              o.rendered_subject        AS "renderedSubject",
              o.rendered_html           AS "renderedHtml",
              o.rendered_text           AS "renderedText",
              o.dedupe_key              AS "dedupeKey",
              o.attempts                AS "attempts",
              o.scheduled_for           AS "scheduledFor",
              o.next_attempt_at         AS "nextAttemptAt",
              o.created_at              AS "createdAt"
  `;
}

// ─────────────────────────────────────────────────────── proceso de envío

type Outcome = "sent" | "retried" | "failed" | "dead";

function isChannelKey(value: string): value is NotificationChannelKey {
  return value === "EMAIL" || value === "WHATSAPP";
}

/**
 * El payload guardado es JSON libre para PostgreSQL. Se comprueba lo mínimo
 * —que sea un objeto— y el resto lo verifica el render, que fallará ruidosamente
 * si falta un campo. Ese fallo es permanente, no reintentable: el JSON no va a
 * arreglarse solo.
 */
function asRenderPayload(value: unknown): AnyRenderPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("El payload del aviso no es un objeto JSON");
  }
  return value as AnyRenderPayload;
}

async function markSent(
  prisma: PrismaClient,
  id: string,
  providerMessageId: string | undefined,
): Promise<void> {
  await prisma.notificationOutbox.update({
    where: { id },
    data: {
      status: "SENT",
      sentAt: new Date(),
      providerMessageId: providerMessageId ?? null,
      lastError: null,
    },
  });
}

async function markTerminal(
  prisma: PrismaClient,
  id: string,
  status: "FAILED" | "DEAD",
  motivo: string,
): Promise<void> {
  await prisma.notificationOutbox.update({
    where: { id },
    data: { status, lastError: motivo.slice(0, 2000) },
  });
}

async function scheduleRetry(
  prisma: PrismaClient,
  id: string,
  cuando: Date,
  motivo: string,
): Promise<void> {
  await prisma.notificationOutbox.update({
    where: { id },
    data: {
      status: "PENDING",
      nextAttemptAt: cuando,
      lastError: motivo.slice(0, 2000),
    },
  });
}

/** Renderiza y congela el contenido, o recupera el ya congelado. */
async function freezeContent(
  prisma: PrismaClient,
  row: ClaimedRow,
  eventType: NotificationEventType,
): Promise<RenderedMessage> {
  if (
    row.renderedSubject !== null &&
    row.renderedHtml !== null &&
    row.renderedText !== null
  ) {
    return {
      subject: row.renderedSubject,
      html: row.renderedHtml,
      text: row.renderedText,
    };
  }

  const rendered = render(eventType, asRenderPayload(row.payload));

  await prisma.notificationOutbox.update({
    where: { id: row.id },
    data: {
      renderedSubject: rendered.subject,
      renderedHtml: rendered.html,
      renderedText: rendered.text,
    },
  });

  return rendered;
}

async function processOne(
  prisma: PrismaClient,
  row: ClaimedRow,
): Promise<Outcome> {
  const ahora = Date.now();
  // La ventana de idempotencia se cuenta desde el PRIMER instante en que el
  // aviso pudo salir, no desde que se encoló: un aviso diferido (§07, semana
  // liberada de un mes que aún no abre) espera semanas por diseño y medirlo
  // desde `createdAt` lo mataría sin haberlo intentado ni una vez.
  const desde = Math.max(row.createdAt.getTime(), row.scheduledFor.getTime());
  const edadMs = ahora - desde;

  // Se comprueba ANTES de enviar: una fila vieja no debe salir siquiera, porque
  // ya no hay forma de saber si un intento anterior llegó a entregarse.
  if (edadMs >= ABANDON_AFTER_MS) {
    await markTerminal(
      prisma,
      row.id,
      "DEAD",
      `Abandonado tras ${Math.round(edadMs / 3_600_000)} h: fuera de la ventana de idempotencia de 24 h del proveedor`,
    );
    return "dead";
  }

  if (!isNotificationEventType(row.eventType)) {
    await markTerminal(
      prisma,
      row.id,
      "FAILED",
      `Evento desconocido: ${row.eventType}`,
    );
    return "failed";
  }

  if (!isChannelKey(row.channel)) {
    await markTerminal(
      prisma,
      row.id,
      "FAILED",
      `Canal desconocido: ${row.channel}`,
    );
    return "failed";
  }

  let contenido: RenderedMessage;
  try {
    contenido = await freezeContent(prisma, row, row.eventType);
  } catch (error) {
    // Un payload que no se puede renderizar no mejora con el tiempo.
    await markTerminal(
      prisma,
      row.id,
      "FAILED",
      `No se pudo renderizar: ${errorToString(error)}`,
    );
    return "failed";
  }

  const mensaje: SendableMessage = {
    id: row.id,
    channel: row.channel,
    recipientUserId: row.recipientUserId,
    recipientAddress: row.recipientAddress,
    eventType: row.eventType,
    payload: asRenderPayload(row.payload),
    renderedSubject: contenido.subject,
    renderedHtml: contenido.html,
    renderedText: contenido.text,
    dedupeKey: row.dedupeKey,
    status: "SENDING",
    attempts: row.attempts,
    scheduledFor: row.scheduledFor,
    nextAttemptAt: row.nextAttemptAt,
    lastError: null,
    providerMessageId: null,
    sentAt: null,
    createdAt: row.createdAt,
  };

  await throttle();
  const resultado = await getChannel(row.channel).send(mensaje);

  if (resultado.ok) {
    await markSent(prisma, row.id, resultado.providerMessageId);
    return "sent";
  }

  const motivo = resultado.error ?? "fallo sin descripción";

  if (resultado.retryable !== true || row.attempts >= MAX_ATTEMPTS) {
    await markTerminal(
      prisma,
      row.id,
      "FAILED",
      `Intento ${row.attempts}/${MAX_ATTEMPTS}: ${motivo}`,
    );
    log("error", {
      msg: "aviso descartado",
      id: row.id,
      evento: row.eventType,
      intentos: row.attempts,
      error: motivo,
    });
    return "failed";
  }

  const proximo = new Date(Date.now() + backoffMs(row.attempts));

  // Si el siguiente intento caería ya fuera de la ventana, no tiene sentido
  // programarlo: se abandona ahora y se ve antes en el panel de no entregados.
  if (proximo.getTime() - desde >= ABANDON_AFTER_MS) {
    await markTerminal(
      prisma,
      row.id,
      "DEAD",
      `Sin margen para otro intento dentro de la ventana de idempotencia: ${motivo}`,
    );
    return "dead";
  }

  await scheduleRetry(prisma, row.id, proximo, motivo);
  return "retried";
}

// ────────────────────────────────────────────────────────────── ejecución

export type WorkerRunSummary = {
  reclaimed: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  dead: number;
};

export type RunWorkerOptions = {
  /** Cliente a usar. Si no se pasa, el worker abre el suyo. */
  prisma?: PrismaClient;
  batchSize?: number;
};

let clientePropio: PrismaClient | null = null;

/**
 * Cliente propio del worker: es un proceso independiente de Next.js, con su
 * propio pool. Se construye con el driver adapter porque en Prisma 7 la URL ya
 * no vive en el esquema.
 */
function getPrisma(): PrismaClient {
  if (clientePropio) return clientePropio;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Falta DATABASE_URL para el worker de notificaciones");
  }
  clientePropio = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  return clientePropio;
}

/**
 * Procesa un lote y termina. Es el punto de entrada para pruebas y para un
 * disparo puntual desde un script.
 */
export async function runWorkerOnce(
  options: RunWorkerOptions = {},
): Promise<WorkerRunSummary> {
  const prisma = options.prisma ?? getPrisma();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const resumen: WorkerRunSummary = {
    reclaimed: await reclaimStale(prisma),
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    dead: 0,
  };

  const filas = await claimBatch(prisma, batchSize);
  resumen.claimed = filas.length;

  // En serie, no en paralelo: es lo que hace efectivo el estrangulamiento y
  // mantiene el orden de la cola.
  for (const fila of filas) {
    try {
      const desenlace = await processOne(prisma, fila);
      resumen[desenlace] += 1;
    } catch (error) {
      // Un fallo inesperado (la base se cayó a mitad) no debe tumbar el lote:
      // la fila se queda en SENDING y `reclaimStale` la recupera al vencer el
      // arrendamiento.
      log("error", {
        msg: "fallo inesperado procesando aviso",
        id: fila.id,
        error: errorToString(error),
      });
    }
  }

  return resumen;
}

/**
 * Bucle del servicio. Vacía la cola tan rápido como el estrangulamiento
 * permite y solo duerme cuando no queda nada por enviar.
 */
export async function main(): Promise<void> {
  const prisma = getPrisma();
  const batchSize = Number(process.env.WORKER_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  const pollMs = Number(process.env.WORKER_POLL_MS ?? DEFAULT_POLL_MS);

  let activo = true;
  const detener = (senal: string) => {
    // Parada ordenada: se termina el lote en curso y se sale. systemd espera.
    log("info", { msg: "deteniendo worker", senal });
    activo = false;
  };
  process.on("SIGINT", () => detener("SIGINT"));
  process.on("SIGTERM", () => detener("SIGTERM"));

  log("info", { msg: "worker de notificaciones iniciado", batchSize, pollMs });

  try {
    while (activo) {
      try {
        const resumen = await runWorkerOnce({ prisma, batchSize });
        if (resumen.claimed > 0 || resumen.reclaimed > 0) {
          log("info", { msg: "lote procesado", ...resumen });
        }
        // Lote lleno = probablemente queda más: seguir sin dormir.
        if (resumen.claimed < batchSize) await sleep(pollMs);
      } catch (error) {
        // Se registra y se espera: una caída de la base no debe convertirse en
        // un bucle de reinicios de systemd.
        log("error", { msg: "fallo del ciclo", error: errorToString(error) });
        await sleep(pollMs);
      }
    }
  } finally {
    await prisma.$disconnect();
    log("info", { msg: "worker detenido" });
  }
}

/**
 * Ejecución directa:
 *   tsx --env-file=.env src/lib/notifications/worker.ts
 * En el servidor, systemd aporta las variables de entorno y arranca el archivo
 * ya compilado; por eso aquí no se carga dotenv (es dependencia de desarrollo).
 *
 * La detección se hace por el nombre del archivo de entrada y no con
 * `import.meta.url`: el proyecto no declara `"type": "module"`, así que tsx
 * transpila este archivo a CommonJS, donde `import.meta` no existe y la
 * comparación nunca se cumpliría. Importar el módulo (una prueba, un script)
 * no dispara nada.
 */
const entrada = process.argv[1] ? path.resolve(process.argv[1]) : "";
const ejecutadoDirecto = /[\\/]worker\.(?:[cm]?ts|[cm]?js)$/.test(entrada);

if (ejecutadoDirecto) {
  main().catch((error: unknown) => {
    log("error", { msg: "worker abortado", error: errorToString(error) });
    process.exitCode = 1;
  });
}
