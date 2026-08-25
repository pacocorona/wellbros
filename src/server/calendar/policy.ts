/**
 * Política de ventana vigente para una propiedad (tabla `booking_policy`).
 *
 * La tabla está VERSIONADA: nunca se corrige una fila, se inserta otra con un
 * `effective_from` posterior. La fila que manda es, en este orden:
 *   1. la específica de la propiedad, si existe;
 *   2. si no, la global (`property_id IS NULL`);
 *   y entre varias del mismo tipo, la de mayor `effective_from <= now()`.
 *
 * Es EXACTAMENTE el criterio de la función `wb_effective_policy()` de la
 * migración, de la que dependen el trigger de reservas y la vista
 * `v_week_slot_availability`. Si las dos versiones divergieran, el calendario
 * pintaría una semana como reservable y la base la rechazaría al insertar: por
 * eso el ORDER BY de abajo replica el de la función, y no "el que parezca".
 *
 * El módulo es de SERVIDOR pero no de Next: recibe el cliente de Prisma y no
 * toca cookies() ni headers(). Así una futura app nativa puede exponerlo por
 * /api/v1 sin reescribirlo.
 */

import { cache } from "react";

import type { Prisma } from "@/generated/prisma/client";
import {
  DEFAULT_BOOKING_WINDOW,
  type BookingWindowConfig,
} from "@/lib/booking-window";
import type { Db } from "@/lib/db";

/**
 * Cliente capaz de leer la política: sirve el global y el de una transacción.
 * Se pide justo el delegado que se usa para que ambos encajen sin castings,
 * igual que hace `AuditClient` en @/lib/audit.
 */
export type PolicyDb =
  | Pick<Db, "bookingPolicy">
  | Pick<Prisma.TransactionClient, "bookingPolicy">;

export interface EffectiveBookingPolicy extends BookingWindowConfig {
  /**
   * Fila de `booking_policy` que se aplicó, para poder congelarla en
   * `reservations.policy_id` y explicar años después bajo qué regla se reservó.
   *
   * Es NULO cuando la base todavía no tiene ninguna política cargada: ahí se
   * devuelven los valores confirmados con el cliente (DEFAULT_BOOKING_WINDOW),
   * que es lo mismo que hace la vista `v_week_slot_availability` con sus
   * `coalesce`. Se prefiere eso a reventar porque esto es un camino de LECTURA:
   * una base a medio poblar debe poder pintar el calendario. La columna
   * `reservations.policy_id` también es nula, así que el nulo encaja tal cual.
   */
  policyId: string | null;
}

/**
 * Lee la política vigente. No cachea: la caché se aplica al exportarla.
 *
 * `effective_from <= new Date()` usa el reloj del proceso y no un `now`
 * inyectado, a propósito: el versionado de la política es un hecho del
 * presente ("¿qué regla rige hoy?"), no algo que las pruebas de calendario
 * quieran mover. El reloj que sí se inyecta es el de `getMonthCalendar`, que
 * decide si una semana ya abrió. Además, un parámetro `Date` rompería la
 * caché de abajo: cada llamada traería un objeto nuevo y ninguna acertaría.
 */
async function readBookingPolicy(
  db: PolicyDb,
  propertyId: string,
): Promise<EffectiveBookingPolicy> {
  const row = await db.bookingPolicy.findFirst({
    where: {
      // La global también es candidata: la específica solo gana si existe.
      OR: [{ propertyId }, { propertyId: null }],
      effectiveFrom: { lte: new Date() },
    },
    // `nulls: "last"` es imprescindible: en PostgreSQL un ORDER BY ... DESC
    // pone los NULL PRIMERO, así que sin esto la política global le ganaría
    // siempre a la de la propiedad, justo al revés de la regla.
    orderBy: [
      { propertyId: { sort: "desc", nulls: "last" } },
      { effectiveFrom: "desc" },
    ],
    select: {
      id: true,
      timeZone: true,
      mode: true,
      bookingWindowDays: true,
      releaseDayOfMonth: true,
      releaseHour: true,
      releaseMinute: true,
      anchorOffsetDays: true,
      allowInProgressWeek: true,
      visibleHorizonMonths: true,
      superuserOverride: true,
    },
  });

  if (!row) return { ...DEFAULT_BOOKING_WINDOW, policyId: null };

  // Campo por campo y no `...row`: los enums de la base (ReleaseMode,
  // SuperuserOverride) coinciden hoy con los de BookingWindowConfig, y
  // enumerarlos hace que el día que dejen de coincidir lo diga el compilador
  // en vez de colarse un valor desconocido hasta el cálculo de la ventana.
  return {
    policyId: row.id,
    timeZone: row.timeZone,
    mode: row.mode,
    bookingWindowDays: row.bookingWindowDays,
    releaseDayOfMonth: row.releaseDayOfMonth,
    releaseHour: row.releaseHour,
    releaseMinute: row.releaseMinute,
    anchorOffsetDays: row.anchorOffsetDays,
    allowInProgressWeek: row.allowInProgressWeek,
    visibleHorizonMonths: row.visibleHorizonMonths,
    superuserOverride: row.superuserOverride,
  };
}

/**
 * Política vigente, memorizada POR PETICIÓN.
 *
 * Una sola pantalla la pide varias veces (la retícula, la navegación de meses,
 * el panel de la semana), y sin caché serían tres viajes a la base para leer
 * la misma fila.
 *
 * ¿Por qué es seguro fuera de un render? Porque `cache()` de React 19 degrada
 * solo: en la compilación `react-server` empieza con
 * `if (!dispatcher) return fn.apply(null, arguments)` y en la compilación
 * normal (la que cargan tsx, vitest o el worker de avisos) es directamente un
 * paso a través sin memoria. Es decir: dentro de un render memoriza, fuera
 * simplemente llama. Se verificó en node_modules/react/cjs/react.*.js.
 *
 * La clave de la caché son los ARGUMENTOS por identidad. `prisma` es un
 * singleton, así que dos llamadas con la misma propiedad aciertan; el cliente
 * de una transacción es un objeto nuevo, así que una lectura dentro de una
 * transacción nunca reutiliza lo leído fuera —que es justo lo que se quiere.
 */
export const loadBookingPolicy = cache(readBookingPolicy);
