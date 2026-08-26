/**
 * Pruebas del filtro de direcciones quemadas al encolar.
 *
 * Cubren la costura entre DOS piezas que se escribieron por separado: el
 * webhook de Resend marca la ficha del usuario (`email_bounced_at`,
 * `email_complained_at`) y `enqueueNotification` es quien tiene que hacer caso
 * de esas marcas. Mientras nadie las leyera, el webhook escribía en una columna
 * que no cambiaba el comportamiento de nada: se seguía encolando correo a
 * buzones inexistentes, quemando la reputación del dominio rebote a rebote.
 *
 * Va contra la BASE REAL, como el resto de los servicios: lo que se comprueba
 * no es aritmética de JavaScript sino qué filas quedan en `notification_outbox`
 * después de encolar, que es exactamente lo que el trabajador va a intentar
 * enviar.
 *
 * El canal de correo tiene que estar encendido para que esto pruebe algo. En
 * desarrollo `EMAIL_DRIVER=console` lo garantiza (el adaptador de consola
 * siempre está disponible); si un día alguien corre la suite con el canal
 * apagado, la primera prueba —la que espera que SÍ se encole— fallaría y
 * avisaría, en vez de dejar pasar las demás en verde por vacuidad.
 */

import "dotenv/config";

import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";

import { enqueueNotification } from "./dispatch";

const marca = randomUUID().slice(0, 8);

/** Todo lo creado, para barrerlo en `afterAll`. */
const usuariosCreados: string[] = [];

/**
 * Usuario de prueba ACTIVO.
 *
 * Aquí sí tiene que estarlo —al revés que en `webhook.test.ts`—: `
 * enqueueNotification` descarta a los inactivos antes de mirar ninguna otra
 * cosa, así que un usuario de baja daría cero filas por el motivo equivocado y
 * la prueba pasaría sin probar nada.
 *
 * Que esté activo lo hace visible para los encolados de OTROS archivos, pero la
 * suite corre con `fileParallelism: false`: mientras este archivo vive, ninguno
 * más está encolando. Aun así se borran sus filas de la cola antes que él.
 */
async function crearUsuario(marcas?: {
  emailBouncedAt?: Date | null;
  emailComplainedAt?: Date | null;
}): Promise<{ id: string; email: string }> {
  const email = `dispatch.${marca}.${randomUUID().slice(0, 8)}@ejemplo.invalid`;
  const usuario = await prisma.user.create({
    data: {
      email,
      passwordHash: "sin-contrasena-de-prueba",
      fullName: `Prueba Dispatch ${marca}`,
      isActive: true,
      emailBouncedAt: marcas?.emailBouncedAt ?? null,
      emailComplainedAt: marcas?.emailComplainedAt ?? null,
    },
    select: { id: true, email: true },
  });
  usuariosCreados.push(usuario.id);
  return usuario;
}

/** Encola un aviso PRESCINDIBLE (el movimiento de la casa). */
async function encolarNoEsencial(usuarioId: string): Promise<number> {
  return prisma.$transaction((tx) =>
    enqueueNotification(tx, {
      eventType: "RESERVATION_CREATED",
      recipientUserIds: [usuarioId],
      payload: {
        reservationId: randomUUID(),
        ownerUserId: usuarioId,
        ownerName: "Quien Sea",
        week: {
          slotId: randomUUID(),
          propertyName: "Casa de prueba",
          startDate: "2026-10-02",
          endDate: "2026-10-08",
          label: "viernes 2 al jueves 8 de octubre de 2026",
        },
        path: "/",
      },
    }),
  );
}

/** Encola un aviso ESENCIAL (sin él, la persona no entra a su cuenta). */
async function encolarEsencial(usuarioId: string): Promise<number> {
  return prisma.$transaction((tx) =>
    enqueueNotification(tx, {
      eventType: "USER_INVITED",
      recipientUserIds: [usuarioId],
      payload: {
        invitationId: randomUUID(),
        userId: usuarioId,
        fullName: "Quien Sea",
        invitedByName: "La administración",
        path: `/invitacion/${randomUUID()}`,
        expiresInLabel: "48 horas",
      },
    }),
  );
}

/** Cuántas filas de correo quedaron encoladas para esa persona. */
async function filasDeCorreo(usuarioId: string): Promise<number> {
  return prisma.notificationOutbox.count({
    where: { recipientUserId: usuarioId, channel: "EMAIL" },
  });
}

afterAll(async () => {
  if (usuariosCreados.length > 0) {
    // La cola primero: tiene clave foránea al usuario.
    await prisma.notificationOutbox.deleteMany({
      where: { recipientUserId: { in: usuariosCreados } },
    });
    await prisma.user.deleteMany({ where: { id: { in: usuariosCreados } } });
  }
  await prisma.$disconnect();
});

describe("enqueueNotification y las direcciones quemadas", () => {
  it("encola con normalidad a quien no tiene ninguna marca", async () => {
    const usuario = await crearUsuario();

    const creadas = await encolarNoEsencial(usuario.id);

    // Si esto falla, lo más probable es que el canal EMAIL esté apagado y no
    // que la lógica esté mal: sin esta fila el resto de las pruebas no
    // distinguiría «se filtró» de «no había canal».
    expect(creadas).toBeGreaterThan(0);
    expect(await filasDeCorreo(usuario.id)).toBeGreaterThan(0);
  });

  it("no encola NADA a una dirección con rebote permanente, ni siquiera lo esencial", async () => {
    const usuario = await crearUsuario({ emailBouncedAt: new Date() });

    await encolarNoEsencial(usuario.id);
    await encolarEsencial(usuario.id);

    // El buzón no existe: guardar la fila solo aplazaría el fallo.
    expect(await filasDeCorreo(usuario.id)).toBe(0);
  });

  it("a quien se quejó no se le manda el movimiento de la casa", async () => {
    const usuario = await crearUsuario({ emailComplainedAt: new Date() });

    await encolarNoEsencial(usuario.id);

    expect(await filasDeCorreo(usuario.id)).toBe(0);
  });

  it("a quien se quejó SÍ se le siguen mandando los avisos esenciales", async () => {
    const usuario = await crearUsuario({ emailComplainedAt: new Date() });

    const creadas = await encolarEsencial(usuario.id);

    // Tragarse la invitación dejaría a esa persona fuera de su propia cuenta
    // sin que nadie se entere: es el fallo caro de los dos posibles.
    expect(creadas).toBeGreaterThan(0);
    expect(await filasDeCorreo(usuario.id)).toBeGreaterThan(0);
  });

  it("el rebote pesa más que la queja: marcado con las dos, no recibe ni lo esencial", async () => {
    const usuario = await crearUsuario({
      emailBouncedAt: new Date(),
      emailComplainedAt: new Date(),
    });

    await encolarEsencial(usuario.id);

    expect(await filasDeCorreo(usuario.id)).toBe(0);
  });
});
