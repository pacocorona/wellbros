/**
 * Pruebas de los servicios de reserva CONTRA LA BASE REAL.
 *
 * No hay dobles ni simulaciones a propósito: la mitad de las garantías de este
 * módulo viven en PostgreSQL (el índice único parcial, el trigger de ventana,
 * los CHECK de cancelación). Una prueba con un cliente falso las daría por
 * buenas sin haberlas ejecutado nunca, que es justo lo contrario de lo que hace
 * falta aquí.
 *
 * Aislamiento: cada caso trabaja sobre SU PROPIA propiedad y su propio slot, y
 * los usuarios son de un solo uso. Nada de lo sembrado se toca, y todo lo
 * creado se borra al final (incluidas las filas de bitácora y de la cola de
 * avisos que generan las operaciones).
 *
 * Las fechas se calculan RELATIVAS a hoy y nunca se escriben a mano: una prueba
 * con «2026-10-02» quemado empieza a mentir en cuanto pasa esa fecha.
 */

import "dotenv/config";

import { randomUUID } from "node:crypto";

import { TZDate } from "@date-fns/tz";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { cancelReservation } from "@/server/reservations/cancel";
import { createReservation } from "@/server/reservations/create";
import {
  ReservationError,
  isReservationError,
} from "@/server/reservations/errors";
import type { ReservationActor } from "@/server/reservations/create";

const ZONA = "America/Mexico_City";
const SUFIJO = randomUUID().slice(0, 8);

/* ------------------------------------------------------------------ */
/* Fechas                                                              */
/* ------------------------------------------------------------------ */

/** Hoy en la zona de negocio, como fecha civil anclada a medianoche UTC. */
function hoyCivil(): Date {
  const z = new TZDate(Date.now(), ZONA);
  return new Date(Date.UTC(z.getFullYear(), z.getMonth(), z.getDate()));
}

/**
 * Viernes de la semana `n` contando desde la semana en curso.
 *
 *   viernes(1)  → la semana que viene. SIEMPRE dentro de ventana: si cae en el
 *                 mes siguiente, ese mes abrió 15 días antes de su día 1 y hoy
 *                 estamos a menos de 7 días de él.
 *   viernes(10) → unos 70 días vista. SIEMPRE fuera de ventana: su mes empieza
 *                 al menos 40 días después de hoy, así que abre en 25 o más.
 */
function viernes(semanas: number): string {
  const hoy = hoyCivil();
  // getUTCDay(): 0 = domingo … 5 = viernes.
  const retroceso = (hoy.getUTCDay() - 5 + 7) % 7;
  const dia = new Date(hoy.getTime() + (semanas * 7 - retroceso) * 86_400_000);
  return dia.toISOString().slice(0, 10);
}

/** `yyyy-MM-dd` → Date de medianoche UTC, que es como Prisma envía un @db.Date. */
function fecha(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/* ------------------------------------------------------------------ */
/* Utilidades de prueba                                                */
/* ------------------------------------------------------------------ */

/**
 * Ejecuta la promesa esperando que falle con un error de negocio y lo devuelve.
 * Si tiene éxito, la prueba falla con un mensaje que dice qué se esperaba.
 */
async function capturarError(promesa: Promise<unknown>): Promise<ReservationError> {
  try {
    await promesa;
  } catch (error) {
    if (isReservationError(error)) return error as ReservationError;
    throw error;
  }
  throw new Error("Se esperaba un ReservationError, pero la operación tuvo éxito.");
}

const propiedadesCreadas: string[] = [];
const semanasCreadas: string[] = [];
const usuariosCreados: string[] = [];
const reservasCreadas: string[] = [];

async function crearUsuario(etiqueta: string): Promise<ReservationActor> {
  const usuario = await prisma.user.create({
    data: {
      email: `zz-pruebas-${etiqueta}-${SUFIJO}@wellbros.test`,
      // No es un hash real: estas pruebas nunca inician sesión.
      passwordHash: "sin-hash-solo-pruebas",
      fullName: `ZZ Pruebas ${etiqueta}`,
      role: "USER",
      isActive: true,
    },
    select: { id: true, fullName: true, role: true },
  });
  usuariosCreados.push(usuario.id);
  return { id: usuario.id, role: usuario.role, fullName: usuario.fullName };
}

/**
 * Propiedad + slot recién creados para un único caso.
 *
 * Una propiedad por caso (y no una compartida) porque `week_slots` es único por
 * propiedad y fecha: compartirla obligaría a repartir semanas entre pruebas y a
 * que unas dependieran del estado que dejan otras.
 */
async function nuevaSemana(
  viernesISO: string,
  creadaPor: string,
): Promise<{ slotId: string; propertyId: string }> {
  const propiedad = await prisma.property.create({
    data: { name: `ZZ Pruebas ${SUFIJO} · ${propiedadesCreadas.length + 1}` },
    select: { id: true },
  });
  propiedadesCreadas.push(propiedad.id);

  const slot = await prisma.weekSlot.create({
    data: {
      propertyId: propiedad.id,
      startDate: fecha(viernesISO),
      createdById: creadaPor,
      status: "OPEN",
    },
    select: { id: true },
  });
  semanasCreadas.push(slot.id);

  return { slotId: slot.id, propertyId: propiedad.id };
}

/** Registra la reserva para poder limpiar sus avisos al final. */
function anotar<T extends { reservationId: string }>(resultado: T): T {
  reservasCreadas.push(resultado.reservationId);
  return resultado;
}

/* ------------------------------------------------------------------ */
/* Actores                                                             */
/* ------------------------------------------------------------------ */

let dueno: ReservationActor;
let tercero: ReservationActor;
let cesionario: ReservationActor;
let admin: ReservationActor;

beforeAll(async () => {
  dueno = await crearUsuario("dueno");
  tercero = await crearUsuario("tercero");
  cesionario = await crearUsuario("cesionario");

  // Se REUSA la superusuaria sembrada en vez de crear otra. Crear un segundo
  // SUPERUSER activo cambia el resultado de `superuserIds()` para todo el
  // proceso, y las pruebas de otros módulos que corren en paralelo contra esta
  // misma base empezarían a ver un destinatario de más.
  const superusuaria = await prisma.user.findFirst({
    where: { role: "SUPERUSER", isActive: true },
    select: { id: true, fullName: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  if (!superusuaria) {
    throw new Error("La base no tiene superusuaria: corre `npm run db:seed`.");
  }
  admin = {
    id: superusuaria.id,
    role: superusuaria.role,
    fullName: superusuaria.fullName,
  };
});

afterAll(async () => {
  // La limpieza se ancla a lo CREADO (propiedades, semanas, reservas) y no solo
  // a los usuarios de prueba: la superusuaria sembrada actúa en varios casos y
  // deja bitácora y reservas a su nombre que también hay que retirar.
  for (const reservationId of reservasCreadas) {
    await prisma.notificationOutbox.deleteMany({
      where: { dedupeKey: { contains: reservationId } },
    });
  }
  if (usuariosCreados.length > 0) {
    await prisma.notificationOutbox.deleteMany({
      where: { recipientUserId: { in: usuariosCreados } },
    });
  }

  const entidades = [...reservasCreadas, ...semanasCreadas];
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: usuariosCreados } },
        { entityId: { in: entidades } },
      ],
    },
  });

  if (reservasCreadas.length > 0) {
    await prisma.dayGrant.deleteMany({
      where: { reservationId: { in: reservasCreadas } },
    });
  }
  if (semanasCreadas.length > 0) {
    await prisma.reservation.deleteMany({
      where: { slotId: { in: semanasCreadas } },
    });
  }
  if (propiedadesCreadas.length > 0) {
    await prisma.weekSlot.deleteMany({
      where: { propertyId: { in: propiedadesCreadas } },
    });
    await prisma.property.deleteMany({ where: { id: { in: propiedadesCreadas } } });
  }
  if (usuariosCreados.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: usuariosCreados } } });
  }

  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* Reservar                                                            */
/* ------------------------------------------------------------------ */

describe("createReservation", () => {
  it("reserva una semana dentro de ventana, marca el slot y avisa a todos", async () => {
    const { slotId, propertyId } = await nuevaSemana(viernes(1), admin.id);

    const resultado = anotar(
      await createReservation({ db: prisma, slotId, actor: dueno }),
    );

    expect(resultado.ownerUserId).toBe(dueno.id);
    expect(resultado.windowOverride).toBe(false);
    expect(resultado.startDate).toBe(viernes(1));
    expect(resultado.propertyId).toBe(propertyId);
    // Un aviso por usuario activo: al menos el dueño está entre ellos.
    expect(resultado.notificationsQueued).toBeGreaterThan(0);

    const slot = await prisma.weekSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: { status: true },
    });
    expect(slot.status).toBe("RESERVED");

    const reserva = await prisma.reservation.findUniqueOrThrow({
      where: { id: resultado.reservationId },
      select: { status: true, policyId: true, windowOverride: true },
    });
    expect(reserva.status).toBe("ACTIVE");
    expect(reserva.windowOverride).toBe(false);
    // La política vigente queda congelada en la reserva: sin ella no se puede
    // explicar años después bajo qué regla se reservó.
    expect(reserva.policyId).not.toBeNull();

    const anotacion = await prisma.auditLog.findFirst({
      where: { action: "RESERVATION_CREATED", entityId: resultado.reservationId },
      select: { actorUserId: true, details: true },
    });
    expect(anotacion?.actorUserId).toBe(dueno.id);

    const avisos = await prisma.notificationOutbox.count({
      where: {
        eventType: "RESERVATION_CREATED",
        dedupeKey: { contains: resultado.reservationId },
      },
    });
    expect(avisos).toBe(resultado.notificationsQueued);
  });

  it("rechaza el segundo intento sobre el mismo slot con SLOT_TAKEN", async () => {
    const { slotId } = await nuevaSemana(viernes(1), admin.id);

    anotar(await createReservation({ db: prisma, slotId, actor: dueno }));

    const error = await capturarError(
      createReservation({ db: prisma, slotId, actor: tercero }),
    );
    expect(error.code).toBe("SLOT_TAKEN");
  });

  it("traduce la violación del índice único a SLOT_TAKEN aunque el slot diga OPEN", async () => {
    const { slotId } = await nuevaSemana(viernes(1), admin.id);
    anotar(await createReservation({ db: prisma, slotId, actor: dueno }));

    // Se fuerza la incoherencia que el estado del slot podría esconder: la
    // verdad es la reserva ACTIVE, y quien la defiende es el índice parcial.
    await prisma.weekSlot.update({
      where: { id: slotId },
      data: { status: "OPEN" },
    });

    const error = await capturarError(
      createReservation({ db: prisma, slotId, actor: tercero }),
    );
    expect(error.code).toBe("SLOT_TAKEN");
  });

  it("niega a un usuario normal una semana fuera de ventana y lo deja anotado", async () => {
    const { slotId } = await nuevaSemana(viernes(10), admin.id);

    const error = await capturarError(
      createReservation({ db: prisma, slotId, actor: dueno }),
    );

    expect(error.code).toBe("WEEK_NOT_YET_BOOKABLE");
    // La interfaz necesita la fecha exacta para reintentar sola, no un texto.
    expect(error.releaseAt).toBeInstanceOf(Date);
    expect(error.releaseAt!.getTime()).toBeGreaterThan(Date.now());

    // El rechazo se anota FUERA de la transacción: si se hubiera escrito dentro,
    // el rollback se habría llevado la evidencia.
    const anotacion = await prisma.auditLog.findFirst({
      where: { action: "RESERVATION_REJECTED_WINDOW", entityId: slotId },
      select: { actorUserId: true },
    });
    expect(anotacion?.actorUserId).toBe(dueno.id);

    // Y nada quedó a medias.
    const reservas = await prisma.reservation.count({ where: { slotId } });
    expect(reservas).toBe(0);
    const slot = await prisma.weekSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: { status: true },
    });
    expect(slot.status).toBe("OPEN");
  });

  it("exige motivo al superusuario que reserva fuera de ventana", async () => {
    const { slotId } = await nuevaSemana(viernes(10), admin.id);

    const sinMotivo = await capturarError(
      createReservation({ db: prisma, slotId, actor: admin }),
    );
    expect(sinMotivo.code).toBe("OVERRIDE_REASON_REQUIRED");

    // Un motivo en blanco no es un motivo.
    const enBlanco = await capturarError(
      createReservation({
        db: prisma,
        slotId,
        actor: admin,
        override: { reason: "   " },
      }),
    );
    expect(enBlanco.code).toBe("OVERRIDE_REASON_REQUIRED");
  });

  it("deja reservar al superusuario fuera de ventana con motivo, marcado y auditado", async () => {
    const { slotId } = await nuevaSemana(viernes(10), admin.id);

    const resultado = anotar(
      await createReservation({
        db: prisma,
        slotId,
        actor: admin,
        override: { reason: "Ocupación acordada por teléfono con la familia." },
      }),
    );

    expect(resultado.windowOverride).toBe(true);

    const reserva = await prisma.reservation.findUniqueOrThrow({
      where: { id: resultado.reservationId },
      select: { windowOverride: true, overrideReason: true, status: true },
    });
    // Lo marca el TRIGGER, no la aplicación: la excepción nunca es silenciosa.
    expect(reserva.windowOverride).toBe(true);
    expect(reserva.overrideReason).toContain("Ocupación acordada");
    expect(reserva.status).toBe("ACTIVE");

    const excepcion = await prisma.auditLog.findFirst({
      where: {
        action: "RESERVATION_OUT_OF_WINDOW",
        entityId: resultado.reservationId,
      },
      select: { actorUserId: true },
    });
    expect(excepcion?.actorUserId).toBe(admin.id);
  });

  it("solo el superusuario reserva a nombre de otra persona", async () => {
    const propio = await nuevaSemana(viernes(1), admin.id);
    const error = await capturarError(
      createReservation({
        db: prisma,
        slotId: propio.slotId,
        actor: dueno,
        forUserId: tercero.id,
      }),
    );
    expect(error.code).toBe("NOT_ALLOWED");

    const ajeno = await nuevaSemana(viernes(1), admin.id);
    const resultado = anotar(
      await createReservation({
        db: prisma,
        slotId: ajeno.slotId,
        actor: admin,
        forUserId: tercero.id,
      }),
    );
    expect(resultado.ownerUserId).toBe(tercero.id);
    expect(resultado.ownerName).toBe(tercero.fullName);
  });

  it("rechaza un slot inexistente sin reventar por el casteo a uuid", async () => {
    const inventado = await capturarError(
      createReservation({ db: prisma, slotId: randomUUID(), actor: dueno }),
    );
    expect(inventado.code).toBe("SLOT_NOT_FOUND");

    const basura = await capturarError(
      createReservation({ db: prisma, slotId: "no-soy-un-uuid", actor: dueno }),
    );
    expect(basura.code).toBe("SLOT_NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ */
/* Cancelar                                                            */
/* ------------------------------------------------------------------ */

describe("cancelReservation", () => {
  it("no deja cancelar a un tercero", async () => {
    const { slotId } = await nuevaSemana(viernes(1), admin.id);
    const reserva = anotar(
      await createReservation({ db: prisma, slotId, actor: dueno }),
    );

    const error = await capturarError(
      cancelReservation({
        db: prisma,
        reservationId: reserva.reservationId,
        actor: tercero,
      }),
    );
    expect(error.code).toBe("NOT_ALLOWED");

    // Y la reserva sigue viva: negar no puede tener efectos colaterales.
    const sigue = await prisma.reservation.findUniqueOrThrow({
      where: { id: reserva.reservationId },
      select: { status: true },
    });
    expect(sigue.status).toBe("ACTIVE");
  });

  it("arrastra las cesiones activas y libera la semana", async () => {
    const viernesISO = viernes(1);
    const { slotId } = await nuevaSemana(viernesISO, admin.id);
    const reserva = anotar(
      await createReservation({ db: prisma, slotId, actor: dueno }),
    );

    // Dos días cedidos dentro de la semana (sábado y domingo).
    const dias = [
      new Date(fecha(viernesISO).getTime() + 86_400_000),
      new Date(fecha(viernesISO).getTime() + 2 * 86_400_000),
    ];
    for (const dia of dias) {
      await prisma.dayGrant.create({
        data: {
          reservationId: reserva.reservationId,
          grantorUserId: dueno.id,
          granteeUserId: cesionario.id,
          grantDate: dia,
        },
        select: { id: true },
      });
    }

    const resultado = await cancelReservation({
      db: prisma,
      reservationId: reserva.reservationId,
      actor: dueno,
      reason: "Cambio de planes.",
    });

    expect(resultado.byAdmin).toBe(false);
    expect(resultado.cancelledGrants).toHaveLength(2);
    expect(resultado.cancelledGrants[0]?.granteeUserId).toBe(cesionario.id);

    const cesiones = await prisma.dayGrant.findMany({
      where: { reservationId: reserva.reservationId },
      select: { status: true, endedAt: true },
    });
    expect(cesiones).toHaveLength(2);
    // Una cesión no sobrevive a su reserva, y su final queda fechado.
    for (const cesion of cesiones) {
      expect(cesion.status).toBe("CANCELLED");
      expect(cesion.endedAt).not.toBeNull();
    }

    const reservaFinal = await prisma.reservation.findUniqueOrThrow({
      where: { id: reserva.reservationId },
      select: { status: true, cancelledById: true, cancelReason: true },
    });
    expect(reservaFinal.status).toBe("CANCELLED");
    expect(reservaFinal.cancelledById).toBe(dueno.id);
    expect(reservaFinal.cancelReason).toBe("Cambio de planes.");

    const slot = await prisma.weekSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: { status: true },
    });
    expect(slot.status).toBe("OPEN");

    // La semana queda otra vez tomable de verdad, no solo en apariencia.
    const otra = anotar(
      await createReservation({ db: prisma, slotId, actor: tercero }),
    );
    expect(otra.ownerUserId).toBe(tercero.id);
  });

  it("registra RESERVATION_CANCELLED_BY_ADMIN cuando cancela el superusuario", async () => {
    const { slotId } = await nuevaSemana(viernes(1), admin.id);
    const reserva = anotar(
      await createReservation({ db: prisma, slotId, actor: dueno }),
    );

    const resultado = await cancelReservation({
      db: prisma,
      reservationId: reserva.reservationId,
      actor: admin,
      reason: "Mantenimiento urgente.",
    });
    expect(resultado.byAdmin).toBe(true);

    const anotacion = await prisma.auditLog.findFirst({
      where: {
        action: "RESERVATION_CANCELLED_BY_ADMIN",
        entityId: reserva.reservationId,
      },
      select: { actorUserId: true, details: true },
    });
    expect(anotacion?.actorUserId).toBe(admin.id);

    // El snapshot tiene que servir para leerlo dentro de dos años sin cruzar tablas.
    const detalles = anotacion?.details as Record<string, unknown>;
    expect(detalles.ownerUserId).toBe(dueno.id);
    expect(detalles.ownerName).toBe(dueno.fullName);
    expect(detalles.cancelReason).toBe("Mantenimiento urgente.");
    expect(typeof detalles.weekLabel).toBe("string");

    // Y NO se escribe la variante del dueño: son hechos distintos.
    const comoDueno = await prisma.auditLog.count({
      where: {
        action: "RESERVATION_CANCELLED",
        entityId: reserva.reservationId,
      },
    });
    expect(comoDueno).toBe(0);
  });

  it("no cancela dos veces la misma reserva", async () => {
    const { slotId } = await nuevaSemana(viernes(1), admin.id);
    const reserva = anotar(
      await createReservation({ db: prisma, slotId, actor: dueno }),
    );

    await cancelReservation({
      db: prisma,
      reservationId: reserva.reservationId,
      actor: dueno,
    });

    const error = await capturarError(
      cancelReservation({
        db: prisma,
        reservationId: reserva.reservationId,
        actor: dueno,
      }),
    );
    expect(error.code).toBe("RESERVATION_ALREADY_CANCELLED");
  });

  it("programa el aviso para la apertura si el mes todavía no abre", async () => {
    const { slotId } = await nuevaSemana(viernes(10), admin.id);
    const reserva = anotar(
      await createReservation({
        db: prisma,
        slotId,
        actor: admin,
        override: { reason: "Se registra una ocupación ya acordada." },
      }),
    );

    const resultado = await cancelReservation({
      db: prisma,
      reservationId: reserva.reservationId,
      actor: admin,
    });

    // Anunciar una semana que nadie puede tomar solo da ventaja a quien lea el
    // correo a deshoras (§07): el aviso espera al minuto de apertura.
    expect(resultado.notifyAt.getTime()).toBeGreaterThan(Date.now());

    const aviso = await prisma.notificationOutbox.findFirst({
      where: {
        eventType: "RESERVATION_CANCELLED",
        dedupeKey: { contains: reserva.reservationId },
      },
      select: { scheduledFor: true, nextAttemptAt: true, payload: true },
    });
    expect(aviso).not.toBeNull();
    expect(aviso!.scheduledFor.getTime()).toBe(resultado.notifyAt.getTime());
    // También el siguiente intento: mirar solo un campo lo habría dejado elegible.
    expect(aviso!.nextAttemptAt.getTime()).toBe(resultado.notifyAt.getTime());

    const payload = aviso!.payload as Record<string, unknown>;
    expect(typeof payload.availableFromLabel).toBe("string");
  });

  it("rechaza una reserva inexistente", async () => {
    const error = await capturarError(
      cancelReservation({
        db: prisma,
        reservationId: randomUUID(),
        actor: admin,
      }),
    );
    expect(error.code).toBe("RESERVATION_NOT_FOUND");
  });
});
