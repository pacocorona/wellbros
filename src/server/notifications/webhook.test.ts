/**
 * Pruebas del webhook de Resend.
 *
 * Tres bloques, con propósitos distintos:
 *
 *  1. EL MAPEO es aritmética pura —de un JSON a un estado— y se prueba sin
 *     base: es donde de verdad se puede uno equivocar (un evento mal traducido,
 *     un rebote transitorio tratado como definitivo) y donde una prueba rápida
 *     paga sola.
 *
 *  2. LOS EFECTOS van CONTRA LA BASE REAL, como el resto de los servicios del
 *     proyecto. Lo que se comprueba aquí no es JavaScript: es que el índice
 *     único de `webhook_events.svix_id` deduplica de verdad, que la marca del
 *     usuario aguanta el segundo evento y que el barrido de la cola deja en pie
 *     exactamente lo que debe. Con un cliente simulado se probaría el simulador.
 *
 *  3. LA FIRMA se prueba con un secreto INVENTADO AQUÍ, no con uno de Resend.
 *     Se puede porque la verificación es local y determinista (HMAC-SHA256 de
 *     `<id>.<timestamp>.<cuerpo>` según Standard Webhooks): el secreto real
 *     solo cambia la clave del HMAC, no el procedimiento. Así queda cubierto lo
 *     que de verdad se rompe en producción —el nombre de las cabeceras y la
 *     exigencia del cuerpo CRUDO— sin depender de ninguna credencial.
 *
 * Cada prueba trabaja con SU PROPIO usuario (correo con sufijo aleatorio) para
 * que las marcas de rebote y queja de una no contaminen a la siguiente, y todo
 * se limpia al final.
 */

import "dotenv/config";

import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { Resend } from "resend";
import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";

import {
  applyDeliveryEvent,
  deliveryStateOf,
  isPermanentBounce,
  parseDeliveryEvent,
  recordWebhookEvent,
  supersedes,
} from "./webhook";

const marca = randomUUID().slice(0, 8);

/** Todo lo creado, para barrerlo en `afterAll`. */
const usuariosCreados: string[] = [];
const svixIdsCreados: string[] = [];

// ────────────────────────────────────────────────────────────── utilería

/**
 * Usuario de prueba, creado INACTIVO a propósito.
 *
 * `enqueueNotification` reparte los avisos entre los usuarios ACTIVOS: un
 * usuario de prueba activo acabaría recibiendo las filas que encolan las
 * pruebas de reservas o de apertura de semanas, y esas filas chocarían con la
 * FK del outbox al borrarlo. Inactivo no le llega nada, y nada de lo que se
 * prueba aquí mira `is_active`.
 */
async function crearUsuario(): Promise<{ id: string; email: string }> {
  const email = `webhook.${marca}.${randomUUID().slice(0, 8)}@ejemplo.invalid`;
  const usuario = await prisma.user.create({
    data: {
      email,
      // No es un hash de Argon2 y no hace falta que lo sea: nadie inicia sesión
      // en estas pruebas y ninguna contraseña puede verificar contra esto.
      passwordHash: "sin-contrasena-de-prueba",
      fullName: `Prueba Webhook ${marca}`,
      isActive: false,
    },
    select: { id: true, email: true },
  });
  usuariosCreados.push(usuario.id);
  return usuario;
}

type AvisoInput = {
  usuarioId: string;
  direccion: string;
  eventType?: string;
  status?: "PENDING" | "SENDING" | "SENT" | "FAILED" | "DEAD";
  providerMessageId?: string | null;
};

async function crearAviso(input: AvisoInput): Promise<string> {
  const fila = await prisma.notificationOutbox.create({
    data: {
      channel: "EMAIL",
      recipientUserId: input.usuarioId,
      recipientAddress: input.direccion,
      eventType: input.eventType ?? "RESERVATION_CREATED",
      payload: {},
      dedupeKey: `prueba-webhook/${marca}/${randomUUID()}`,
      status: input.status ?? "SENT",
      providerMessageId: input.providerMessageId ?? null,
      sentAt: new Date(),
    },
    select: { id: true },
  });
  return fila.id;
}

/** Identificador de mensaje con la forma que devuelve Resend. */
function idDeCorreo(): string {
  return randomUUID();
}

/** Cuerpo de un evento tal como lo manda Resend, con lo que nos interesa. */
function cuerpoEvento(
  type: string,
  emailId: string,
  destinatario: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    created_at: "2026-08-27T12:00:00.000Z",
    data: {
      created_at: "2026-08-27T12:00:00.000Z",
      email_id: emailId,
      message_id: `<${emailId}@wellbrosproperties.lat>`,
      from: "Wellbros <notificaciones@wellbrosproperties.lat>",
      to: [destinatario],
      subject: "Aviso de Wellbros",
      ...extra,
    },
  };
}

/** El evento ya traducido; falla ruidosamente si el mapeo lo descartó. */
function entregaDe(cuerpo: unknown) {
  const evento = parseDeliveryEvent(cuerpo);
  if (evento === null) throw new Error("El cuerpo de prueba no se pudo mapear");
  return evento;
}

async function estadoDelAviso(id: string) {
  return prisma.notificationOutbox.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      deliveryState: true,
      deliveryDetail: true,
      deliveryUpdatedAt: true,
      lastError: true,
    },
  });
}

async function bitacoraDe(usuarioId: string) {
  return prisma.auditLog.findMany({
    where: {
      entityId: usuarioId,
      action: { in: ["EMAIL_BOUNCED", "EMAIL_COMPLAINED", "EMAIL_DELIVERY_FAILED"] },
    },
    orderBy: { createdAt: "asc" },
    select: { action: true, details: true, entityType: true, actorUserId: true },
  });
}

afterAll(async () => {
  if (svixIdsCreados.length > 0) {
    await prisma.webhookEvent.deleteMany({
      where: { svixId: { in: svixIdsCreados } },
    });
  }
  if (usuariosCreados.length > 0) {
    await prisma.notificationOutbox.deleteMany({
      where: { recipientUserId: { in: usuariosCreados } },
    });
    // Las entradas que escribe el webhook no tienen actor: se localizan por la
    // entidad, que es la persona que dejó de recibir correo.
    await prisma.auditLog.deleteMany({
      where: { entityId: { in: usuariosCreados } },
    });
    await prisma.user.deleteMany({ where: { id: { in: usuariosCreados } } });
  }
  await prisma.$disconnect();
});

// ═════════════════════════════════════════════════════════════ 1. mapeo

describe("parseDeliveryEvent — qué se traduce y qué se ignora", () => {
  it("traduce los cinco eventos de correo al estado que les toca", () => {
    const casos = [
      ["email.delivered", "DELIVERED"],
      ["email.delivery_delayed", "DELAYED"],
      ["email.bounced", "BOUNCED"],
      ["email.complained", "COMPLAINED"],
      ["email.failed", "FAILED"],
    ] as const;

    for (const [tipo, esperado] of casos) {
      const evento = entregaDe(cuerpoEvento(tipo, "abc-123", "quien@ejemplo.invalid"));
      expect(evento.type).toBe(tipo);
      expect(evento.emailId).toBe("abc-123");
      expect(evento.address).toBe("quien@ejemplo.invalid");
      expect(deliveryStateOf(evento.type)).toBe(esperado);
    }
  });

  it("ignora los eventos que no cambian nada por aquí", () => {
    // `email.sent` sale con CADA correo: tratarlo sería trabajo por nada.
    expect(parseDeliveryEvent(cuerpoEvento("email.sent", "x", "a@b.invalid"))).toBeNull();
    expect(parseDeliveryEvent(cuerpoEvento("email.opened", "x", "a@b.invalid"))).toBeNull();
    expect(parseDeliveryEvent(cuerpoEvento("contact.created", "x", "a@b.invalid"))).toBeNull();
  });

  it("rechaza un cuerpo con la forma equivocada en vez de escribir basura", () => {
    expect(parseDeliveryEvent(null)).toBeNull();
    expect(parseDeliveryEvent("email.delivered")).toBeNull();
    expect(parseDeliveryEvent({})).toBeNull();
    // Sin `email_id` no hay forma de saber de qué aviso habla.
    expect(parseDeliveryEvent({ type: "email.delivered", data: {} })).toBeNull();
    expect(
      parseDeliveryEvent({ type: "email.delivered", data: { email_id: "  " } }),
    ).toBeNull();
  });

  it("compone el motivo del rebote con tipo, subtipo y mensaje", () => {
    const evento = entregaDe(
      cuerpoEvento("email.bounced", "id-1", "nadie@ejemplo.invalid", {
        bounce: {
          type: "Permanent",
          subType: "General",
          message: "smtp; 550 5.1.1 user unknown",
        },
      }),
    );
    expect(evento.bounceType).toBe("Permanent");
    expect(evento.detail).toBe("Permanent/General: smtp; 550 5.1.1 user unknown");
  });

  it("guarda la razón de un fallo de envío", () => {
    const evento = entregaDe(
      cuerpoEvento("email.failed", "id-2", "nadie@ejemplo.invalid", {
        failed: { reason: "El dominio del remitente no está verificado" },
      }),
    );
    expect(evento.detail).toBe("El dominio del remitente no está verificado");
  });
});

describe("isPermanentBounce — solo lo definitivo quema la dirección", () => {
  it("un rebote permanente sí, y da igual la caja", () => {
    expect(isPermanentBounce("Permanent")).toBe(true);
    expect(isPermanentBounce("permanent")).toBe(true);
  });

  it("un buzón lleno o un rebote sin clasificar NO", () => {
    // Es la diferencia entre «esta persona cambió de correo» y «esta persona
    // se fue de vacaciones»: tratar el segundo como el primero la deja sin
    // enterarse de nada para siempre.
    expect(isPermanentBounce("Transient")).toBe(false);
    expect(isPermanentBounce("Undetermined")).toBe(false);
    expect(isPermanentBounce(null)).toBe(false);
  });
});

describe("supersedes — los eventos no llegan ordenados", () => {
  it("lo primero que se sepa se escribe", () => {
    expect(supersedes(null, "DELAYED")).toBe(true);
    expect(supersedes(null, "DELIVERED")).toBe(true);
  });

  it("un retraso que llega tarde no pisa una entrega ya confirmada", () => {
    expect(supersedes("DELIVERED", "DELAYED")).toBe(false);
    expect(supersedes("DELAYED", "DELIVERED")).toBe(true);
  });

  it("el desenlace peor gana al mejor, nunca al revés", () => {
    expect(supersedes("DELIVERED", "BOUNCED")).toBe(true);
    expect(supersedes("DELIVERED", "COMPLAINED")).toBe(true);
    expect(supersedes("BOUNCED", "DELIVERED")).toBe(false);
    expect(supersedes("COMPLAINED", "BOUNCED")).toBe(false);
  });

  it("repetir el mismo estado no escribe nada: de ahí sale la idempotencia", () => {
    expect(supersedes("BOUNCED", "BOUNCED")).toBe(false);
    expect(supersedes("DELIVERED", "DELIVERED")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════ 2. deduplicación

describe("recordWebhookEvent — Resend entrega al menos una vez", () => {
  it("el segundo envío del MISMO svix-id se reconoce como duplicado", async () => {
    const svixId = `msg_${marca}_${randomUUID().slice(0, 8)}`;
    svixIdsCreados.push(svixId);
    const cuerpo = cuerpoEvento("email.delivered", idDeCorreo(), "a@b.invalid");

    expect(
      await recordWebhookEvent(prisma, {
        svixId,
        eventType: "email.delivered",
        payload: cuerpo,
      }),
    ).toBe("nuevo");

    expect(
      await recordWebhookEvent(prisma, {
        svixId,
        eventType: "email.delivered",
        payload: cuerpo,
      }),
    ).toBe("duplicado");

    expect(await prisma.webhookEvent.count({ where: { svixId } })).toBe(1);
  });

  it("dos entregas simultáneas del mismo evento dejan UNA sola fila", async () => {
    // La deduplicación es el índice único, no una consulta previa: entre un
    // SELECT y un INSERT caben dos peticiones a la vez, y solo la base resuelve
    // esa carrera. Aquí se provoca.
    const svixId = `msg_${marca}_${randomUUID().slice(0, 8)}`;
    svixIdsCreados.push(svixId);
    const cuerpo = cuerpoEvento("email.bounced", idDeCorreo(), "a@b.invalid");

    const resultados = await Promise.all([
      recordWebhookEvent(prisma, { svixId, eventType: "email.bounced", payload: cuerpo }),
      recordWebhookEvent(prisma, { svixId, eventType: "email.bounced", payload: cuerpo }),
    ]);

    expect(resultados.filter((r) => r === "nuevo")).toHaveLength(1);
    expect(resultados.filter((r) => r === "duplicado")).toHaveLength(1);
    expect(await prisma.webhookEvent.count({ where: { svixId } })).toBe(1);
  });

  it("guarda el cuerpo íntegro, que es lo que permite reaplicarlo a mano", async () => {
    const svixId = `msg_${marca}_${randomUUID().slice(0, 8)}`;
    svixIdsCreados.push(svixId);
    const emailId = idDeCorreo();
    const cuerpo = cuerpoEvento("email.complained", emailId, "a@b.invalid");

    await recordWebhookEvent(prisma, {
      svixId,
      eventType: "email.complained",
      payload: cuerpo,
    });

    const fila = await prisma.webhookEvent.findUniqueOrThrow({ where: { svixId } });
    expect(fila.eventType).toBe("email.complained");
    expect(parseDeliveryEvent(fila.payload)?.emailId).toBe(emailId);
  });
});

// ══════════════════════════════════════════════════════════ 3. efectos

describe("applyDeliveryEvent — entrega y retraso", () => {
  it("una entrega marca la fila y no molesta a nadie más", async () => {
    const usuario = await crearUsuario();
    const emailId = idDeCorreo();
    const avisoId = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      providerMessageId: emailId,
    });

    const resultado = await applyDeliveryEvent(
      prisma,
      entregaDe(cuerpoEvento("email.delivered", emailId, usuario.email)),
    );

    expect(resultado.applied).toBe(true);
    expect(resultado.outboxId).toBe(avisoId);

    const fila = await estadoDelAviso(avisoId);
    expect(fila.deliveryState).toBe("DELIVERED");
    // `status` NO se toca: sigue siendo verdad que se envió.
    expect(fila.status).toBe("SENT");
    expect(fila.deliveryUpdatedAt).not.toBeNull();

    const persona = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(persona.emailBouncedAt).toBeNull();
    expect(persona.emailComplainedAt).toBeNull();
    // Una entrega correcta no se anota: sería una línea por aviso y por
    // persona, y ahogaría la bitácora.
    expect(await bitacoraDe(usuario.id)).toHaveLength(0);
  });

  it("un retraso que llega después de la entrega no borra la entrega", async () => {
    const usuario = await crearUsuario();
    const emailId = idDeCorreo();
    const avisoId = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      providerMessageId: emailId,
    });

    await applyDeliveryEvent(
      prisma,
      entregaDe(cuerpoEvento("email.delivered", emailId, usuario.email)),
    );
    const segundo = await applyDeliveryEvent(
      prisma,
      entregaDe(cuerpoEvento("email.delivery_delayed", emailId, usuario.email)),
    );

    expect(segundo.applied).toBe(false);
    expect((await estadoDelAviso(avisoId)).deliveryState).toBe("DELIVERED");
  });
});

describe("applyDeliveryEvent — rebote", () => {
  it("un rebote permanente quema la dirección y vacía lo que quedaba en cola", async () => {
    const usuario = await crearUsuario();
    const emailId = idDeCorreo();
    const avisoId = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      providerMessageId: emailId,
    });
    const pendiente = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      status: "PENDING",
    });
    // A una dirección que no existe no llega NADA, ni siquiera la invitación.
    const invitacion = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      status: "PENDING",
      eventType: "USER_INVITED",
    });

    const resultado = await applyDeliveryEvent(
      prisma,
      entregaDe(
        cuerpoEvento("email.bounced", emailId, usuario.email, {
          bounce: { type: "Permanent", subType: "General", message: "550 no existe" },
        }),
      ),
      { ip: "3.3.3.3" },
    );

    expect(resultado.markedUndeliverable).toBe(true);
    expect(resultado.suppressed).toBe(2);

    expect((await estadoDelAviso(avisoId)).deliveryState).toBe("BOUNCED");
    expect((await estadoDelAviso(avisoId)).deliveryDetail).toContain("Permanent/General");
    expect((await estadoDelAviso(pendiente)).status).toBe("DEAD");
    expect((await estadoDelAviso(invitacion)).status).toBe("DEAD");
    expect((await estadoDelAviso(pendiente)).lastError).toContain("rebotó de forma permanente");

    const persona = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(persona.emailBouncedAt).not.toBeNull();

    const bitacora = await bitacoraDe(usuario.id);
    expect(bitacora).toHaveLength(1);
    expect(bitacora[0].action).toBe("EMAIL_BOUNCED");
    expect(bitacora[0].entityType).toBe("USER");
    // Nadie de la casa hizo esto: lo cuenta el proveedor.
    expect(bitacora[0].actorUserId).toBeNull();
    expect(bitacora[0].details).toMatchObject({ permanente: true, tipoRebote: "Permanent" });
  });

  it("un rebote transitorio se anota pero NO deja a nadie incomunicado", async () => {
    const usuario = await crearUsuario();
    const emailId = idDeCorreo();
    const avisoId = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      providerMessageId: emailId,
    });
    const pendiente = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      status: "PENDING",
    });

    const resultado = await applyDeliveryEvent(
      prisma,
      entregaDe(
        cuerpoEvento("email.bounced", emailId, usuario.email, {
          bounce: { type: "Transient", subType: "MailboxFull", message: "buzón lleno" },
        }),
      ),
    );

    expect(resultado.markedUndeliverable).toBe(false);
    expect(resultado.suppressed).toBe(0);
    expect((await estadoDelAviso(avisoId)).deliveryState).toBe("BOUNCED");
    // Lo que quedaba en cola sigue en pie: mañana puede salir perfectamente.
    expect((await estadoDelAviso(pendiente)).status).toBe("PENDING");

    const persona = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(persona.emailBouncedAt).toBeNull();

    // Pero la superusuaria tiene que poder verlo: es la pista de que a esa
    // persona le está costando recibir.
    const bitacora = await bitacoraDe(usuario.id);
    expect(bitacora).toHaveLength(1);
    expect(bitacora[0].details).toMatchObject({ permanente: false, tipoRebote: "Transient" });
  });

  it("repetir el mismo rebote no duplica la marca ni la bitácora", async () => {
    const usuario = await crearUsuario();
    const emailId = idDeCorreo();
    await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      providerMessageId: emailId,
    });
    const cuerpo = cuerpoEvento("email.bounced", emailId, usuario.email, {
      bounce: { type: "Permanent", subType: "General", message: "550" },
    });

    const primero = await applyDeliveryEvent(prisma, entregaDe(cuerpo));
    const primeraFecha = (
      await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })
    ).emailBouncedAt;

    const segundo = await applyDeliveryEvent(prisma, entregaDe(cuerpo));

    expect(primero.applied).toBe(true);
    expect(segundo.applied).toBe(false);
    expect(await bitacoraDe(usuario.id)).toHaveLength(1);
    // La fecha que se guarda es la del PRIMER rebote: es la que responde
    // «¿desde cuándo?».
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } })).emailBouncedAt,
    ).toEqual(primeraFecha);
  });

  it("sin fila en la cola, todavía se protege a la persona por su dirección", async () => {
    const usuario = await crearUsuario();
    const pendiente = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      status: "PENDING",
    });

    // `email_id` que no corresponde a ningún aviso: un correo enviado por fuera
    // de la cola, o una fila ya purgada.
    const resultado = await applyDeliveryEvent(
      prisma,
      entregaDe(
        cuerpoEvento("email.bounced", idDeCorreo(), usuario.email, {
          bounce: { type: "Permanent", subType: "General", message: "550" },
        }),
      ),
    );

    expect(resultado.outboxId).toBeNull();
    expect(resultado.userId).toBe(usuario.id);
    expect(resultado.markedUndeliverable).toBe(true);
    expect((await estadoDelAviso(pendiente)).status).toBe("DEAD");
  });
});

describe("applyDeliveryEvent — queja", () => {
  it("deja de mandarle lo prescindible y respeta lo esencial", async () => {
    const usuario = await crearUsuario();
    const emailId = idDeCorreo();
    const avisoId = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      providerMessageId: emailId,
    });
    const reserva = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      status: "PENDING",
      eventType: "RESERVATION_CREATED",
    });
    const apertura = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      status: "PENDING",
      eventType: "MONTH_WINDOW_OPENED",
    });
    // El enlace para entrar a la cuenta NO es movimiento de la casa: silenciarlo
    // dejaría a esa persona fuera sin que nadie lo supiera.
    const invitacion = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      status: "PENDING",
      eventType: "USER_INVITED",
    });

    const resultado = await applyDeliveryEvent(
      prisma,
      entregaDe(cuerpoEvento("email.complained", emailId, usuario.email)),
    );

    expect(resultado.markedComplained).toBe(true);
    expect(resultado.suppressed).toBe(2);

    expect((await estadoDelAviso(avisoId)).deliveryState).toBe("COMPLAINED");
    expect((await estadoDelAviso(reserva)).status).toBe("DEAD");
    expect((await estadoDelAviso(apertura)).status).toBe("DEAD");
    expect((await estadoDelAviso(invitacion)).status).toBe("PENDING");

    const persona = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(persona.emailComplainedAt).not.toBeNull();
    // Quejarse no es rebotar: a esa dirección sigue llegando el correo.
    expect(persona.emailBouncedAt).toBeNull();

    const bitacora = await bitacoraDe(usuario.id);
    expect(bitacora).toHaveLength(1);
    expect(bitacora[0].action).toBe("EMAIL_COMPLAINED");
  });

  it("no toca los avisos que ya salieron ni los de otras direcciones", async () => {
    const usuario = await crearUsuario();
    const otro = await crearUsuario();
    const emailId = idDeCorreo();
    await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      providerMessageId: emailId,
    });
    const yaEnviado = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      status: "SENT",
    });
    const deOtro = await crearAviso({
      usuarioId: otro.id,
      direccion: otro.email,
      status: "PENDING",
    });

    await applyDeliveryEvent(
      prisma,
      entregaDe(cuerpoEvento("email.complained", emailId, usuario.email)),
    );

    expect((await estadoDelAviso(yaEnviado)).status).toBe("SENT");
    expect((await estadoDelAviso(deOtro)).status).toBe("PENDING");
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: otro.id } })).emailComplainedAt,
    ).toBeNull();
  });
});

describe("applyDeliveryEvent — fallo de envío", () => {
  it("se anota con su motivo y no marca la dirección", async () => {
    const usuario = await crearUsuario();
    const emailId = idDeCorreo();
    const avisoId = await crearAviso({
      usuarioId: usuario.id,
      direccion: usuario.email,
      providerMessageId: emailId,
    });

    const resultado = await applyDeliveryEvent(
      prisma,
      entregaDe(
        cuerpoEvento("email.failed", emailId, usuario.email, {
          failed: { reason: "El dominio del remitente no está verificado" },
        }),
      ),
    );

    expect(resultado.markedUndeliverable).toBe(false);
    expect(resultado.suppressed).toBe(0);

    const fila = await estadoDelAviso(avisoId);
    expect(fila.deliveryState).toBe("FAILED");
    expect(fila.deliveryDetail).toContain("no está verificado");

    const persona = await prisma.user.findUniqueOrThrow({ where: { id: usuario.id } });
    expect(persona.emailBouncedAt).toBeNull();

    const bitacora = await bitacoraDe(usuario.id);
    expect(bitacora).toHaveLength(1);
    expect(bitacora[0].action).toBe("EMAIL_DELIVERY_FAILED");
  });
});

// ═══════════════════════════════════════════════════════════ 4. firma

describe("verificación de firma (con un secreto inventado aquí)", () => {
  const claveBruta = randomBytes(32);
  const secreto = `whsec_${claveBruta.toString("base64")}`;
  const resend = new Resend("re_clave_de_prueba_no_se_usa");

  function firmar(id: string, sello: string, cuerpo: string): string {
    const mac = createHmac("sha256", claveBruta)
      .update(`${id}.${sello}.${cuerpo}`)
      .digest("base64");
    return `v1,${mac}`;
  }

  function ahoraEnSegundos(): string {
    return Math.floor(Date.now() / 1000).toString();
  }

  it("acepta el cuerpo crudo firmado con el secreto correcto", () => {
    const id = "msg_2abc";
    const sello = ahoraEnSegundos();
    const cuerpo = JSON.stringify(
      cuerpoEvento("email.delivered", "id-firma", "a@b.invalid"),
    );

    const evento = resend.webhooks.verify({
      payload: cuerpo,
      headers: { id, timestamp: sello, signature: firmar(id, sello, cuerpo) },
      webhookSecret: secreto,
    });

    expect(evento.type).toBe("email.delivered");
  });

  it("RECHAZA el mismo evento si se reserializa: por eso la ruta lee req.text()", () => {
    // Es el error clásico de este webhook. El cuerpo firmado lleva espacios; al
    // pasar por JSON.parse y volver a JSON.stringify se pierden, y la firma
    // deja de cuadrar aunque el evento sea idéntico y el secreto el correcto.
    const id = "msg_2def";
    const sello = ahoraEnSegundos();
    const original = `{ "type": "email.delivered", "data": { "email_id": "x" } }`;
    const firma = firmar(id, sello, original);
    const reserializado = JSON.stringify(JSON.parse(original));

    expect(reserializado).not.toBe(original);
    expect(() =>
      resend.webhooks.verify({
        payload: reserializado,
        headers: { id, timestamp: sello, signature: firma },
        webhookSecret: secreto,
      }),
    ).toThrow();
  });

  it("rechaza otra clave, otro identificador y un sello de tiempo viejo", () => {
    const id = "msg_2ghi";
    const sello = ahoraEnSegundos();
    const cuerpo = JSON.stringify(cuerpoEvento("email.bounced", "id-x", "a@b.invalid"));
    const firma = firmar(id, sello, cuerpo);

    const otroSecreto = `whsec_${randomBytes(32).toString("base64")}`;
    expect(() =>
      resend.webhooks.verify({
        payload: cuerpo,
        headers: { id, timestamp: sello, signature: firma },
        webhookSecret: otroSecreto,
      }),
    ).toThrow();

    // El identificador entra en el HMAC: cambiarlo invalida la firma, que es lo
    // que impide reutilizar una firma buena para otro mensaje.
    expect(() =>
      resend.webhooks.verify({
        payload: cuerpo,
        headers: { id: "msg_otro", timestamp: sello, signature: firma },
        webhookSecret: secreto,
      }),
    ).toThrow();

    // Sello de hace una hora: fuera de la tolerancia de cinco minutos del
    // estándar. Es lo que impide repetir una petición capturada.
    const viejo = (Math.floor(Date.now() / 1000) - 3600).toString();
    expect(() =>
      resend.webhooks.verify({
        payload: cuerpo,
        headers: { id, timestamp: viejo, signature: firmar(id, viejo, cuerpo) },
        webhookSecret: secreto,
      }),
    ).toThrow();
  });
});
