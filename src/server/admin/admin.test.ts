/**
 * Pruebas de los servicios de administración contra la BASE REAL.
 *
 * No hay dobles: lo interesante de estos servicios vive en PostgreSQL —el CHECK
 * de los viernes, la unicidad (propiedad, fecha) que hace idempotente la
 * apertura, el índice parcial de una sola reserva activa y los triggers de
 * ventana y de cesión—. Con un cliente simulado se probaría el simulador.
 *
 * Cada prueba trabaja sobre datos PROPIOS (propiedad y usuarios con sufijo
 * aleatorio) y se limpian todos al final, incluidos los avisos que la apertura
 * encola para los usuarios que ya estaban en la base.
 */

import "dotenv/config";

import { randomUUID } from "node:crypto";

import { TZDate } from "@date-fns/tz";
import { addDays } from "date-fns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isAuthError } from "@/lib/auth";
import { DEFAULT_BOOKING_WINDOW, toISODate } from "@/lib/booking-window";
import { prisma } from "@/lib/db";

import { listAuditEntries } from "./audit-queries";
import { createMaintenanceNote, deleteMaintenanceNote } from "./maintenance";
import { closeWeek, openWeeks, reopenWeek } from "./slots";
import {
  AdminError,
  type AdminActor,
  fechaCivil,
  isoDeFecha,
  setUserActive,
} from "./users";

const marca = randomUUID().slice(0, 8);

let propiedadId = "";
let superActor: AdminActor;
let usuarioActor: AdminActor;

/** Entidades cuyos avisos hay que barrer al terminar (van en la clave de dedupe). */
const entidadesConAviso: string[] = [];

/**
 * Borra los avisos que generó una operación, EN CUANTO se comprueban.
 *
 * Un aviso de apertura sale para todos los usuarios activos, incluidos los que
 * crean otros archivos de prueba que corren en paralelo contra esta misma base.
 * Si esas filas se quedaran hasta el final, la limpieza del OTRO archivo se
 * estrellaría contra la FK del outbox al borrar sus usuarios. Se barren aquí
 * mismo y el barrido de `afterAll` queda solo como red.
 */
async function limpiarAvisosDe(entidadId: string): Promise<void> {
  entidadesConAviso.push(entidadId);
  await prisma.notificationOutbox.deleteMany({
    where: { dedupeKey: { contains: entidadId } },
  });
}

/** Viernes de la semana en curso, en la zona de negocio. */
function viernesEnCurso(): TZDate {
  const hoy = new TZDate(Date.now(), DEFAULT_BOOKING_WINDOW.timeZone);
  // getDay(): 0 = domingo … 5 = viernes.
  const retroceso = (hoy.getDay() - 5 + 7) % 7;
  return addDays(hoy, -retroceso) as TZDate;
}

function masDias(base: TZDate, dias: number): string {
  return toISODate(addDays(base, dias) as TZDate);
}

async function crearSlot(startDateISO: string): Promise<string> {
  const slot = await prisma.weekSlot.create({
    data: {
      propertyId: propiedadId,
      startDate: fechaCivil(startDateISO),
      createdById: superActor.id,
    },
    select: { id: true },
  });
  return slot.id;
}

beforeAll(async () => {
  const propiedad = await prisma.property.create({
    data: { name: `Prueba admin ${marca}` },
    select: { id: true },
  });
  propiedadId = propiedad.id;

  // El hash es de mentira a propósito: ninguna prueba verifica contraseñas y
  // argon2 con parámetros reales cuesta decenas de milisegundos por usuario.
  const [jefa, vecino] = await Promise.all([
    prisma.user.create({
      data: {
        email: `jefa.${marca}@prueba.wellbros`,
        passwordHash: "hash-de-prueba",
        fullName: `Jefa ${marca}`,
        role: "SUPERUSER",
      },
      select: { id: true, email: true, fullName: true, role: true },
    }),
    prisma.user.create({
      data: {
        email: `vecino.${marca}@prueba.wellbros`,
        passwordHash: "hash-de-prueba",
        fullName: `Vecino ${marca}`,
        role: "USER",
      },
      select: { id: true, email: true, fullName: true, role: true },
    }),
  ]);

  superActor = jefa;
  usuarioActor = vecino;
});

afterAll(async () => {
  if (!propiedadId) return;
  const usuarios = [superActor?.id, usuarioActor?.id].filter(Boolean) as string[];

  await prisma.dayGrant.deleteMany({
    where: { reservation: { slot: { propertyId: propiedadId } } },
  });
  await prisma.reservation.deleteMany({ where: { slot: { propertyId: propiedadId } } });
  await prisma.weekSlot.deleteMany({ where: { propertyId: propiedadId } });
  await prisma.maintenanceNote.deleteMany({ where: { propertyId: propiedadId } });

  // Los avisos de apertura salen para TODOS los usuarios activos, incluidos los
  // que ya vivían en la base: se barren por la clave de deduplicación, que
  // lleva dentro el identificador de la tanda o de la reserva.
  await prisma.notificationOutbox.deleteMany({
    where: {
      OR: [
        { recipientUserId: { in: usuarios } },
        ...entidadesConAviso.map((id) => ({ dedupeKey: { contains: id } })),
      ],
    },
  });

  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: usuarios } } });
  await prisma.session.deleteMany({ where: { userId: { in: usuarios } } });
  await borrarUsuarios(usuarios);
  await prisma.property.delete({ where: { id: propiedadId } });
  await prisma.$disconnect();
});

/**
 * Baja definitiva de los usuarios de prueba.
 *
 * Se desactivan ANTES de borrarlos porque otro archivo de pruebas corriendo en
 * paralelo contra esta misma base consulta `activeUserIds()` para repartir
 * avisos: mientras estos usuarios figuren activos, otra transacción puede
 * encolarles una fila y chocar con la FK RESTRICT del outbox. Desactivar cierra
 * esa puerta; el reintento cubre lo que ya estuviera en vuelo.
 */
async function borrarUsuarios(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.user.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
  // Respiro para que cierre lo que ya estaba en vuelo antes de la desactivación.
  await espera(300);

  let ultimoError: unknown = null;
  for (let intento = 0; intento < 8; intento++) {
    try {
      // Barrer y borrar en UNA transacción: entre dos sentencias sueltas cabe
      // el aviso que otro archivo acaba de encolarles, y la FK volvería a
      // impedir el borrado.
      await prisma.$transaction(async (tx) => {
        await tx.notificationOutbox.deleteMany({ where: { recipientUserId: { in: ids } } });
        await tx.user.deleteMany({ where: { id: { in: ids } } });
      });
      return;
    } catch (error) {
      ultimoError = error;
      await espera(200 * (intento + 1));
    }
  }
  throw ultimoError;
}

function espera(ms: number): Promise<void> {
  return new Promise((listo) => setTimeout(listo, ms));
}

describe("openWeeks", () => {
  it("abre solo los viernes del rango y repetirlo no duplica nada", async () => {
    const base = addDays(viernesEnCurso(), 56) as TZDate; // ocho semanas por delante
    // El rango empieza en miércoles y acaba en sábado: los extremos NO son
    // viernes justamente para comprobar que se ignoran.
    const desde = masDias(base, -2);
    const hasta = masDias(base, 22);

    const primera = await openWeeks({
      db: prisma,
      actor: superActor,
      propertyId: propiedadId,
      from: desde,
      to: hasta,
    });
    await limpiarAvisosDe(primera.batchId);

    expect(primera.created).toBe(4);
    expect(primera.alreadyOpen).toBe(0);
    expect(primera.weeks.map((s) => s.startDate)).toEqual([
      toISODate(base),
      masDias(base, 7),
      masDias(base, 14),
      masDias(base, 21),
    ]);
    // Invariante del producto: toda semana empieza en viernes.
    for (const semana of primera.weeks) {
      expect(fechaCivil(semana.startDate).getUTCDay()).toBe(5);
      expect(fechaCivil(semana.endDate).getUTCDay()).toBe(4);
    }
    // La regla de ventana se redacta desde la política vigente (15 días).
    expect(primera.windowRuleLabel).toBe("quince días antes de que empiece");
    expect(primera.notified).toBeGreaterThan(0);

    // Idempotencia: mismo rango, cero altas, todas contadas como ya abiertas.
    const segunda = await openWeeks({
      db: prisma,
      actor: superActor,
      propertyId: propiedadId,
      from: desde,
      to: hasta,
    });
    await limpiarAvisosDe(segunda.batchId);

    expect(segunda.created).toBe(0);
    expect(segunda.alreadyOpen).toBe(4);
    expect(segunda.notified).toBe(0);

    const enBase = await prisma.weekSlot.findMany({
      where: { propertyId: propiedadId },
      select: { startDate: true },
    });
    expect(enBase).toHaveLength(4);
    for (const slot of enBase) {
      expect(isoDeFecha(slot.startDate).length).toBe(10);
      expect(slot.startDate.getUTCDay()).toBe(5);
    }

    const bitacora = await prisma.auditLog.findMany({
      where: { action: "SLOT_OPENED", actorUserId: superActor.id },
      select: { entityId: true },
    });
    expect(bitacora).toHaveLength(4);
  });

  it("rechaza a un usuario normal", async () => {
    await expect(
      openWeeks({
        db: prisma,
        actor: usuarioActor,
        propertyId: propiedadId,
        from: masDias(viernesEnCurso(), 63),
        to: masDias(viernesEnCurso(), 63),
      }),
    ).rejects.toSatisfy((e: unknown) => isAuthError(e) && e.code === "FORBIDDEN");
  });
});

describe("closeWeek", () => {
  it("sin force no puede cerrar una semana reservada; con force cancela en cascada y deja rastro", async () => {
    // La semana EN CURSO siempre es reservable: su mes ancla abrió hace tiempo
    // y el jueves todavía no ha pasado. Así el trigger de ventana no estorba.
    const inicio = toISODate(viernesEnCurso());
    const slotId = await crearSlot(inicio);

    const reserva = await prisma.reservation.create({
      data: { slotId, userId: usuarioActor.id },
      select: { id: true },
    });
    entidadesConAviso.push(reserva.id);

    // Un día cedido para comprobar la cascada al cancelar.
    await prisma.dayGrant.create({
      data: {
        reservationId: reserva.id,
        grantorUserId: usuarioActor.id,
        granteeUserId: superActor.id,
        grantDate: fechaCivil(masDias(viernesEnCurso(), 2)),
      },
    });

    await expect(
      closeWeek({ db: prisma, actor: superActor, slotId }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AdminError && e.code === "SLOT_HAS_ACTIVE_RESERVATION",
    );

    // El intento fallido no dejó nada a medias.
    const intacto = await prisma.weekSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: { status: true },
    });
    expect(intacto.status).toBe("OPEN");
    expect(
      (await prisma.reservation.findUniqueOrThrow({
        where: { id: reserva.id },
        select: { status: true },
      })).status,
    ).toBe("ACTIVE");

    // Forzar exige motivo; sin él tampoco pasa.
    await expect(
      closeWeek({ db: prisma, actor: superActor, slotId, force: true }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof AdminError && e.code === "INVALID_INPUT",
    );

    const cerrada = await closeWeek({
      db: prisma,
      actor: superActor,
      slotId,
      force: true,
      reason: "Fuga de agua: la casa no es habitable esa semana",
    });

    expect(cerrada.cancelledReservation?.reservationId).toBe(reserva.id);
    expect(cerrada.cancelledReservation?.cancelledGrants).toBe(1);
    // Solo a los afectados —dueño y receptor del día cedido—, no a toda la casa.
    expect(cerrada.notified).toBeGreaterThan(0);
    await limpiarAvisosDe(reserva.id);

    // El slot queda CERRADO, no abierto: cerrar no es liberar.
    expect(
      (await prisma.weekSlot.findUniqueOrThrow({
        where: { id: slotId },
        select: { status: true },
      })).status,
    ).toBe("CLOSED");

    const trasCierre = await prisma.reservation.findUniqueOrThrow({
      where: { id: reserva.id },
      select: { status: true, cancelledById: true, cancelReason: true },
    });
    expect(trasCierre.status).toBe("CANCELLED");
    expect(trasCierre.cancelledById).toBe(superActor.id);
    expect(trasCierre.cancelReason).toContain("Fuga de agua");

    const cesiones = await prisma.dayGrant.findMany({
      where: { reservationId: reserva.id },
      select: { status: true, endedAt: true },
    });
    expect(cesiones).toHaveLength(1);
    expect(cesiones[0].status).toBe("CANCELLED");
    expect(cesiones[0].endedAt).not.toBeNull();

    const anotacion = await prisma.auditLog.findFirst({
      where: {
        action: "SLOT_CLOSED_WITH_ACTIVE_RESERVATION",
        entityId: slotId,
        actorUserId: superActor.id,
      },
      select: { details: true },
    });
    expect(anotacion).not.toBeNull();
    const detalles = anotacion?.details as {
      reservation?: { ownerName?: string };
      cesiones?: unknown[];
      motivo?: string;
    };
    // Snapshot legible dentro de dos años, no solo identificadores.
    expect(detalles.reservation?.ownerName).toBe(usuarioActor.fullName);
    expect(detalles.cesiones).toHaveLength(1);
    expect(detalles.motivo).toContain("Fuga de agua");

    expect(
      await prisma.auditLog.count({
        where: { action: "RESERVATION_CANCELLED_BY_ADMIN", entityId: reserva.id },
      }),
    ).toBe(1);

    // Reabrir la devuelve al calendario.
    const reabierta = await reopenWeek({ db: prisma, actor: superActor, slotId, notify: false });
    expect(reabierta.alreadyOpen).toBe(false);
    expect(
      (await prisma.weekSlot.findUniqueOrThrow({
        where: { id: slotId },
        select: { status: true },
      })).status,
    ).toBe("OPEN");
  });

  it("cerrar una semana libre no avisa a nadie y es idempotente", async () => {
    const slotId = await crearSlot(masDias(viernesEnCurso(), 112));

    const primera = await closeWeek({ db: prisma, actor: superActor, slotId });
    expect(primera.alreadyClosed).toBe(false);
    expect(primera.cancelledReservation).toBeNull();
    expect(primera.notified).toBe(0);

    const segunda = await closeWeek({ db: prisma, actor: superActor, slotId });
    expect(segunda.alreadyClosed).toBe(true);
  });
});

describe("setUserActive", () => {
  it("al desactivar avisa de las reservas futuras pero NO las cancela", async () => {
    // Trece semanas por delante: fuera del rango que abre la primera prueba,
    // para no chocar con la unicidad (propiedad, fecha).
    const slotId = await crearSlot(masDias(viernesEnCurso(), 91));

    // Reserva fuera de ventana: se usa el bypass documentado (GUC local a la
    // transacción), que además exige motivo. Así la prueba no depende de qué
    // mes esté abierto el día que se ejecute.
    const reserva = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('wellbros.window_override', 'on', true)`;
      return tx.reservation.create({
        data: {
          slotId,
          userId: usuarioActor.id,
          overrideReason: "Alta de datos de prueba",
        },
        select: { id: true },
      });
    });

    const resultado = await setUserActive({
      db: prisma,
      actor: superActor,
      userId: usuarioActor.id,
      isActive: false,
      reason: "Se va de la familia",
    });

    expect(resultado.user.isActive).toBe(false);
    expect(resultado.futureReservations.map((r) => r.reservationId)).toContain(reserva.id);
    expect(resultado.futureReservations[0].label).toContain("viernes");

    // La reserva sigue viva: cancelarla es decisión de la superusuaria.
    expect(
      (await prisma.reservation.findUniqueOrThrow({
        where: { id: reserva.id },
        select: { status: true },
      })).status,
    ).toBe("ACTIVE");

    await setUserActive({
      db: prisma,
      actor: superActor,
      userId: usuarioActor.id,
      isActive: true,
    });
  });
});

describe("listAuditEntries", () => {
  it("rechaza a un USER normal aunque la ruta no lo haga", async () => {
    await expect(
      listAuditEntries({ db: prisma, actor: usuarioActor }),
    ).rejects.toSatisfy((e: unknown) => isAuthError(e) && e.code === "FORBIDDEN");
  });

  it("pagina por cursor y filtra por propiedad", async () => {
    const nota = await createMaintenanceNote({
      db: prisma,
      actor: superActor,
      propertyId: propiedadId,
      startDate: masDias(viernesEnCurso(), 70),
      endDate: masDias(viernesEnCurso(), 72),
      note: "Pintura del porche",
    });

    const primera = await listAuditEntries({
      db: prisma,
      actor: superActor,
      filters: { propertyId: propiedadId },
      limit: 2,
    });
    expect(primera.entries).toHaveLength(2);
    expect(primera.nextCursor).not.toBeNull();
    // Descendente: lo más reciente primero.
    expect(Number(primera.entries[0].id)).toBeGreaterThan(Number(primera.entries[1].id));

    const segunda = await listAuditEntries({
      db: prisma,
      actor: superActor,
      filters: { propertyId: propiedadId },
      limit: 2,
      cursor: primera.nextCursor,
    });
    const idsPrimera = primera.entries.map((e) => e.id);
    for (const entrada of segunda.entries) {
      expect(idsPrimera).not.toContain(entrada.id);
    }

    // El filtro por propiedad lee details->>'propertyId': todo lo devuelto es mío.
    const todas = await listAuditEntries({
      db: prisma,
      actor: superActor,
      filters: { propertyId: propiedadId },
      limit: 200,
    });
    for (const entrada of todas.entries) {
      const detalles = entrada.details as { propertyId?: string };
      expect(detalles.propertyId).toBe(propiedadId);
    }
    expect(todas.entries.some((e) => e.action === "MAINTENANCE_NOTE_CREATED")).toBe(true);

    // Filtro por acción y por actor.
    const soloAperturas = await listAuditEntries({
      db: prisma,
      actor: superActor,
      filters: { actions: ["SLOT_OPENED"], actorUserId: superActor.id, propertyId: propiedadId },
    });
    expect(soloAperturas.entries.length).toBeGreaterThan(0);
    for (const entrada of soloAperturas.entries) {
      expect(entrada.action).toBe("SLOT_OPENED");
      expect(entrada.actor?.id).toBe(superActor.id);
    }

    await deleteMaintenanceNote({ db: prisma, actor: superActor, noteId: nota.id });
  });
});
