/**
 * Pruebas de los servicios de cesión CONTRA LA BASE REAL.
 *
 * No hay dobles: media regla vive en PostgreSQL (el índice único parcial y el
 * trigger `wb_day_grant_validate`), así que una prueba con un cliente simulado
 * daría verde sobre código que la base rechazaría. Necesita la base local
 * levantada (`npm run db:up`) y migrada.
 *
 * Cada prueba crea sus PROPIOS datos —una propiedad nueva, usuarios nuevos y
 * una semana por caso— y `afterAll` los borra. Nunca toca la semilla: si una
 * prueba rompiera los datos de desarrollo, dejaría de ser una prueba y pasaría
 * a ser un problema.
 */

// Debe ir ANTES que cualquier import que evalúe `@/lib/db`: ese módulo lanza si
// no encuentra DATABASE_URL, y vitest no carga .env por su cuenta.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
// La cancelación se hace con el servicio real, no con SQL a mano: lo que se
// prueba aquí es que la cascada CANCELLED y la revocación convivan bien, y con
// SQL propio sólo se probaría el SQL propio.
import { cancelReservation } from "@/server/reservations";
import {
  createDayGrants,
  isGrantError,
  revokeDayGrants,
  type GrantErrorCode,
} from "@/server/grants";

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                  */
/* -------------------------------------------------------------------------- */

const MS_DIA = 86_400_000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sumaDias(dateISO: string, dias: number): string {
  return iso(new Date(new Date(`${dateISO}T00:00:00.000Z`).getTime() + dias * MS_DIA));
}

/**
 * Un viernes muy por delante de hoy, distinto para cada índice.
 *
 * Se calcula en UTC y no en la zona de negocio a propósito: al estar a más de
 * tres meses vista, ningún huso puede cambiar de qué viernes se trata, y así la
 * prueba no depende de la aritmética que precisamente está probando.
 */
function viernesDePrueba(indice: number): string {
  const hoy = new Date();
  const base = new Date(
    Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()),
  );
  // 5 = viernes.
  const alViernes = (5 - base.getUTCDay() + 7) % 7;
  return iso(new Date(base.getTime() + (alViernes + (12 + indice) * 7) * MS_DIA));
}

/** Mediodía UTC del día indicado: en México son las 6 de la mañana, sin ambigüedad. */
function mediodiaDe(dateISO: string): Date {
  return new Date(`${dateISO}T12:00:00.000Z`);
}

/** Comprueba que la promesa falla con un `GrantError` del código esperado. */
async function esperarFallo(
  promesa: Promise<unknown>,
  code: GrantErrorCode,
): Promise<{ code: GrantErrorCode; dates: readonly string[] }> {
  try {
    await promesa;
  } catch (error) {
    if (!isGrantError(error)) throw error;
    expect(error.code).toBe(code);
    return { code: error.code, dates: error.dates };
  }
  throw new Error(`Se esperaba GrantError ${code} y no falló nada.`);
}

/* -------------------------------------------------------------------------- */
/* Montaje                                                                     */
/* -------------------------------------------------------------------------- */

const sufijo = randomUUID().slice(0, 8);

interface Semana {
  reservationId: string;
  slotId: string;
  /** Los siete días de la semana, viernes → jueves. */
  dias: string[];
}

let propertyId = "";
let duenioId = "";
let receptorId = "";
let terceroId = "";
let superusuariaId = "";
/** ¿Hay algún canal encendido? Sin él, el outbox no recibe nada y no hay qué medir. */
let hayCanales = false;

const usuariosCreados: string[] = [];
const reservasCreadas: string[] = [];
let contadorSemanas = 0;

async function crearUsuario(nombre: string): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `prueba-cesiones-${sufijo}-${nombre}@wellbros.test`,
      // No es un hash real: estas pruebas no inician sesión, reciben el actor.
      passwordHash: "no-aplica",
      fullName: `Prueba ${nombre} ${sufijo}`,
    },
    select: { id: true },
  });
  usuariosCreados.push(u.id);
  return u.id;
}

/**
 * Abre una semana y la reserva a nombre de `duenio`.
 *
 * El INSERT del slot va en SQL crudo porque `end_date` y `anchor_month` son
 * columnas GENERADAS y PostgreSQL rechaza cualquier INSERT que las mencione,
 * que es lo que haría `prisma.weekSlot.create()`.
 *
 * La reserva usa la puerta de la ventana de apertura (§07): las semanas de
 * prueba están a tres meses vista, muy fuera de ventana. El trigger exige
 * motivo cuando esa puerta se usa de verdad, así que se le da uno.
 */
async function nuevaSemanaReservada(duenio: string): Promise<Semana> {
  const inicio = viernesDePrueba(contadorSemanas++);

  const filas = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO week_slots (property_id, start_date, created_by)
    VALUES (${propertyId}::uuid, ${inicio}::date, ${duenio}::uuid)
    RETURNING id
  `;
  const slotId = filas[0].id;

  const reservationId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('wellbros.window_override', 'on', true)`;
    const r = await tx.reservation.create({
      data: {
        slotId,
        userId: duenio,
        windowOverride: true,
        overrideReason: "Datos de prueba automatizada",
      },
      select: { id: true },
    });
    return r.id;
  });
  reservasCreadas.push(reservationId);

  return {
    reservationId,
    slotId,
    dias: Array.from({ length: 7 }, (_, i) => sumaDias(inicio, i)),
  };
}


beforeAll(async () => {
  const canales = await prisma.notificationChannelConfig.count({
    where: { isEnabled: true },
  });
  hayCanales = canales > 0;

  const su = await prisma.user.findFirst({
    where: { role: "SUPERUSER", isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!su) {
    throw new Error("La base no tiene superusuaria: corre `npm run db:seed`.");
  }
  superusuariaId = su.id;

  duenioId = await crearUsuario("duenio");
  receptorId = await crearUsuario("receptor");
  terceroId = await crearUsuario("tercero");

  const propiedad = await prisma.property.create({
    data: { name: `Propiedad de prueba ${sufijo}` },
    select: { id: true },
  });
  propertyId = propiedad.id;
});

afterAll(async () => {
  // Orden dictado por las claves foráneas, todas ON DELETE RESTRICT: nada se
  // borra antes que lo que le apunta.
  for (const reservationId of reservasCreadas) {
    await prisma.$executeRaw`
      DELETE FROM notification_outbox WHERE payload->>'reservationId' = ${reservationId}
    `;
  }
  if (usuariosCreados.length > 0) {
    await prisma.notificationOutbox.deleteMany({
      where: { recipientUserId: { in: usuariosCreados } },
    });
    // La bitácora es append-only por convención (los REVOKE están comentados en
    // la migración como paso manual de despliegue), así que en desarrollo sí se
    // puede limpiar lo que la propia prueba escribió.
    await prisma.auditLog.deleteMany({
      where: { actorUserId: { in: usuariosCreados } },
    });
  }
  if (reservasCreadas.length > 0) {
    await prisma.dayGrant.deleteMany({
      where: { reservationId: { in: reservasCreadas } },
    });
    await prisma.reservation.deleteMany({
      where: { id: { in: reservasCreadas } },
    });
  }
  if (propertyId) {
    await prisma.weekSlot.deleteMany({ where: { propertyId } });
    await prisma.property.deleteMany({ where: { id: propertyId } });
  }
  if (usuariosCreados.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: usuariosCreados } } });
  }
  await prisma.$disconnect();
});

/* -------------------------------------------------------------------------- */
/* Ceder                                                                       */
/* -------------------------------------------------------------------------- */

describe("createDayGrants", () => {
  it("cede varios días de una semana propia en una sola operación", async () => {
    const semana = await nuevaSemanaReservada(duenioId);
    // A propósito en desorden: el servicio debe ordenarlos.
    const dates = [semana.dias[3], semana.dias[1]];

    const resultado = await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor: { id: duenioId, role: "USER" },
      granteeUserId: receptorId,
      dates,
    });

    expect(resultado.grants.map((g) => g.date)).toEqual([
      semana.dias[1],
      semana.dias[3],
    ]);
    // El lote es el id de la PRIMERA cesión por fecha: estable y reproducible.
    expect(resultado.grantBatchId).toBe(resultado.grants[0].id);

    const enBase = await prisma.dayGrant.findMany({
      where: { reservationId: semana.reservationId },
      orderBy: { grantDate: "asc" },
    });
    expect(enBase).toHaveLength(2);
    expect(enBase.every((g) => g.status === "ACTIVE")).toBe(true);
    expect(enBase.every((g) => g.endedAt === null)).toBe(true);
    expect(enBase.every((g) => g.grantorUserId === duenioId)).toBe(true);
    expect(enBase.every((g) => g.granteeUserId === receptorId)).toBe(true);

    const bitacora = await prisma.auditLog.findMany({
      where: { action: "GRANT_CREATED", entityId: resultado.grantBatchId },
    });
    expect(bitacora).toHaveLength(1);
    expect(bitacora[0].entityType).toBe("DAY_GRANT");
    expect(bitacora[0].actorUserId).toBe(duenioId);

    if (hayCanales) {
      const avisos = await prisma.notificationOutbox.findMany({
        where: { dedupeKey: { contains: resultado.grantBatchId } },
      });
      expect(avisos.every((a) => a.eventType === "GRANT_CREATED")).toBe(true);
      expect(resultado.notified).toBe(avisos.length);

      // Los involucrados y la superusuaria. Se comprueba por inclusión y no por
      // igualdad porque otras pruebas pueden estar creando superusuarios en
      // paralelo, y ésos entran legítimamente en la lista de destinatarios.
      const destinatarios = [...new Set(avisos.map((a) => a.recipientUserId))];
      expect(destinatarios).toEqual(
        expect.arrayContaining([duenioId, receptorId, superusuariaId]),
      );

      // UN aviso por persona y canal, no uno por día cedido: se cedieron dos
      // días y aun así nadie recibe dos filas del mismo canal.
      const porPersonaYCanal = avisos.map((a) => `${a.recipientUserId}|${a.channel}`);
      expect(new Set(porPersonaYCanal).size).toBe(porPersonaYCanal.length);
    }
  });

  it("rechaza ceder dos veces el mismo día y dice cuál", async () => {
    const semana = await nuevaSemanaReservada(duenioId);
    const actor = { id: duenioId, role: "USER" } as const;

    await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      granteeUserId: receptorId,
      dates: [semana.dias[2]],
    });

    const fallo = await esperarFallo(
      createDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor,
        // Uno nuevo y uno repetido: debe señalar solo el repetido.
        granteeUserId: terceroId,
        dates: [semana.dias[2], semana.dias[4]],
      }),
      "DAY_ALREADY_GRANTED",
    );
    expect(fallo.dates).toEqual([semana.dias[2]]);

    // Y la operación entera se deshizo: el día nuevo tampoco se guardó.
    const enBase = await prisma.dayGrant.findMany({
      where: { reservationId: semana.reservationId },
    });
    expect(enBase).toHaveLength(1);
  });

  it("rechaza un día que no pertenece a la semana", async () => {
    const semana = await nuevaSemanaReservada(duenioId);
    const fuera = sumaDias(semana.dias[0], 8);

    const fallo = await esperarFallo(
      createDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor: { id: duenioId, role: "USER" },
        granteeUserId: receptorId,
        dates: [semana.dias[5], fuera],
      }),
      "DATE_OUT_OF_WEEK",
    );
    expect(fallo.dates).toEqual([fuera]);

    const enBase = await prisma.dayGrant.count({
      where: { reservationId: semana.reservationId },
    });
    expect(enBase).toBe(0);
  });

  it("no deja cederse días a uno mismo", async () => {
    const semana = await nuevaSemanaReservada(duenioId);

    await esperarFallo(
      createDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor: { id: duenioId, role: "USER" },
        granteeUserId: duenioId,
        dates: [semana.dias[1]],
      }),
      "GRANTEE_IS_GRANTOR",
    );
  });

  it("solo cede el dueño: ni un tercero ni la superusuaria", async () => {
    const semana = await nuevaSemanaReservada(duenioId);

    await esperarFallo(
      createDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor: { id: terceroId, role: "USER" },
        granteeUserId: receptorId,
        dates: [semana.dias[1]],
      }),
      "NOT_RESERVATION_OWNER",
    );

    // La superusuaria puede cancelar una reserva ajena, pero no repartir sus días.
    await esperarFallo(
      createDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor: { id: superusuariaId, role: "SUPERUSER" },
        granteeUserId: receptorId,
        dates: [semana.dias[1]],
      }),
      "NOT_RESERVATION_OWNER",
    );

    const enBase = await prisma.dayGrant.count({
      where: { reservationId: semana.reservationId },
    });
    expect(enBase).toBe(0);
  });

  it("no cede días que ya transcurrieron", async () => {
    const semana = await nuevaSemanaReservada(duenioId);
    // Reloj fijo en el miércoles de esa semana: lunes y martes ya pasaron.
    const ahora = mediodiaDe(semana.dias[5]);

    const fallo = await esperarFallo(
      createDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor: { id: duenioId, role: "USER" },
        granteeUserId: receptorId,
        dates: [semana.dias[3], semana.dias[6]],
        now: ahora,
      }),
      "GRANT_DATE_PAST",
    );
    expect(fallo.dates).toEqual([semana.dias[3]]);

    // El día EN CURSO sí se puede ceder: todavía no termina.
    const ok = await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor: { id: duenioId, role: "USER" },
      granteeUserId: receptorId,
      dates: [semana.dias[5]],
      now: ahora,
    });
    expect(ok.grants).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Revocar                                                                     */
/* -------------------------------------------------------------------------- */

describe("revokeDayGrants", () => {
  it("retira la cesión dejándola en REVOKED con su fecha de fin", async () => {
    const semana = await nuevaSemanaReservada(duenioId);
    const actor = { id: duenioId, role: "USER" } as const;

    const cedidas = await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      granteeUserId: receptorId,
      dates: [semana.dias[1], semana.dias[2]],
    });

    const resultado = await revokeDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      dates: [semana.dias[1]],
    });

    expect(resultado.batches).toHaveLength(1);
    expect(resultado.batches[0].granteeUserId).toBe(receptorId);
    expect(resultado.batches[0].dates).toEqual([semana.dias[1]]);

    const enBase = await prisma.dayGrant.findMany({
      where: { reservationId: semana.reservationId },
      orderBy: { grantDate: "asc" },
    });
    expect(enBase[0].status).toBe("REVOKED");
    expect(enBase[0].endedAt).not.toBeNull();
    // El otro día sigue cedido: se retira lo pedido, no la cesión entera.
    expect(enBase[1].status).toBe("ACTIVE");
    expect(enBase[1].endedAt).toBeNull();

    const bitacora = await prisma.auditLog.findMany({
      where: { action: "GRANT_REVOKED", entityId: resultado.batches[0].grantBatchId },
    });
    expect(bitacora).toHaveLength(1);

    // Revocado el día, vuelve a poder cederse: el índice único solo mira ACTIVE.
    const otraVez = await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      granteeUserId: terceroId,
      dates: [semana.dias[1]],
    });
    expect(otraVez.grants).toHaveLength(1);
    expect(otraVez.grantBatchId).not.toBe(cedidas.grantBatchId);
  });

  it("agrupa la revocación por receptor: un aviso a cada quien", async () => {
    const semana = await nuevaSemanaReservada(duenioId);
    const actor = { id: duenioId, role: "USER" } as const;

    await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      granteeUserId: receptorId,
      dates: [semana.dias[1]],
    });
    await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      granteeUserId: terceroId,
      dates: [semana.dias[2]],
    });

    const resultado = await revokeDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      dates: [semana.dias[1], semana.dias[2]],
    });

    expect(resultado.batches).toHaveLength(2);
    expect(new Set(resultado.batches.map((b) => b.granteeUserId))).toEqual(
      new Set([receptorId, terceroId]),
    );
    // Lotes distintos: un aviso hablando de dos receptores sería mentira.
    expect(resultado.batches[0].grantBatchId).not.toBe(
      resultado.batches[1].grantBatchId,
    );
  });

  it("no revoca un día que no está cedido", async () => {
    const semana = await nuevaSemanaReservada(duenioId);

    const fallo = await esperarFallo(
      revokeDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor: { id: duenioId, role: "USER" },
        dates: [semana.dias[1]],
      }),
      "GRANT_NOT_FOUND",
    );
    expect(fallo.dates).toEqual([semana.dias[1]]);
  });

  it("no revoca un día ya transcurrido", async () => {
    const semana = await nuevaSemanaReservada(duenioId);
    const actor = { id: duenioId, role: "USER" } as const;

    await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      granteeUserId: receptorId,
      dates: [semana.dias[1]],
    });

    await esperarFallo(
      revokeDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor,
        dates: [semana.dias[1]],
        now: mediodiaDe(semana.dias[4]),
      }),
      "GRANT_DATE_PAST",
    );

    const enBase = await prisma.dayGrant.findFirstOrThrow({
      where: { reservationId: semana.reservationId },
    });
    expect(enBase.status).toBe("ACTIVE");
  });

  it("tampoco revoca un tercero ni la superusuaria", async () => {
    const semana = await nuevaSemanaReservada(duenioId);

    await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor: { id: duenioId, role: "USER" },
      granteeUserId: receptorId,
      dates: [semana.dias[1]],
    });

    await esperarFallo(
      revokeDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor: { id: superusuariaId, role: "SUPERUSER" },
        dates: [semana.dias[1]],
      }),
      "NOT_RESERVATION_OWNER",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Cancelación de la reserva                                                   */
/* -------------------------------------------------------------------------- */

describe("cancelación de la reserva", () => {
  it("deja las cesiones en CANCELLED, no en REVOKED, y la revocación las respeta", async () => {
    const semana = await nuevaSemanaReservada(duenioId);
    const actor = { id: duenioId, role: "USER" } as const;

    await createDayGrants({
      db: prisma,
      reservationId: semana.reservationId,
      actor,
      granteeUserId: receptorId,
      dates: [semana.dias[1], semana.dias[2]],
    });

    const cancelada = await cancelReservation({
      db: prisma,
      reservationId: semana.reservationId,
      actor: { id: duenioId, role: "USER", fullName: `Prueba duenio ${sufijo}` },
      reason: "Prueba de cascada",
    });
    expect(cancelada.cancelledGrants.map((g) => g.date)).toEqual([
      semana.dias[1],
      semana.dias[2],
    ]);

    const trasCancelar = await prisma.dayGrant.findMany({
      where: { reservationId: semana.reservationId },
    });
    expect(trasCancelar).toHaveLength(2);
    expect(trasCancelar.every((g) => g.status === "CANCELLED")).toBe(true);
    expect(trasCancelar.every((g) => g.endedAt !== null)).toBe(true);

    // Revocar después no debe reescribir el motivo: CANCELLED explica que la
    // semana entera se soltó; REVOKED diría que el dueño retiró el día, que es
    // una historia distinta.
    await esperarFallo(
      revokeDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor,
        dates: [semana.dias[1]],
      }),
      "RESERVATION_NOT_ACTIVE",
    );

    // Y tampoco se pueden ceder días de una semana ya soltada.
    await esperarFallo(
      createDayGrants({
        db: prisma,
        reservationId: semana.reservationId,
        actor,
        granteeUserId: terceroId,
        dates: [semana.dias[3]],
      }),
      "RESERVATION_NOT_ACTIVE",
    );

    const alFinal = await prisma.dayGrant.findMany({
      where: { reservationId: semana.reservationId },
    });
    expect(alFinal.every((g) => g.status === "CANCELLED")).toBe(true);
  });
});
