/**
 * Pruebas de los tokens de acceso contra la BASE REAL.
 *
 * No hay dobles, y aquí menos que en ningún sitio: la mitad de las garantías de
 * este mecanismo NO viven en TypeScript sino en PostgreSQL —el índice único
 * parcial que impide dos enlaces vigentes, el CHECK del formato del hash, el
 * `UPDATE ... WHERE` que hace del canje una operación atómica—. Con un cliente
 * simulado se probaría el simulador.
 *
 * Cada prueba trabaja con datos PROPIOS (sufijo aleatorio) y se limpian todos
 * al final, incluidos los avisos que el alta encola. La superusuaria sembrada
 * NO se toca.
 */

import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createUser, reinviteUser, type AdminActor } from "@/server/admin/users";

import { login, reiniciarIntentosDeLogin } from "./login";
import {
  consumeAccessToken,
  issueAccessToken,
  purgeDeadAccessTokens,
  redeemInvitation,
  TOKEN_TTL_MS,
  verifyAccessToken,
} from "./tokens";

const marca = randomUUID().slice(0, 8);

/** Contraseña de prueba, por encima del mínimo de 12 caracteres. */
const CONTRASENA_BUENA = "mi perro duerme en el sillon";

let jefa: AdminActor;

/** Todo lo creado aquí, para barrerlo al final. */
const usuariosCreados: string[] = [];

const HORA_MS = 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════ andamiaje

/**
 * Usuario suelto, sin pasar por `createUser`: para las pruebas del token en sí,
 * donde el alta no aporta nada y sí cuesta un Argon2 y un aviso encolado.
 */
async function usuarioSuelto(etiqueta: string): Promise<{ id: string; email: string }> {
  const usuario = await prisma.user.create({
    data: {
      email: `${etiqueta}.${marca}@prueba.wellbros`,
      // Hash de mentira a propósito: ninguna de estas pruebas verifica
      // contraseñas contra él, y Argon2 real cuesta decenas de milisegundos.
      passwordHash: "hash-de-prueba",
      fullName: `Prueba ${etiqueta} ${marca}`,
    },
    select: { id: true, email: true },
  });
  usuariosCreados.push(usuario.id);
  return usuario;
}

/**
 * El enlace tal como llega al correo.
 *
 * Es la ÚNICA forma de conocer el token de un alta, y así debe ser: `createUser`
 * no lo devuelve. Leerlo del outbox es exactamente lo que hace el worker.
 */
async function enlaceDelCorreo(userId: string): Promise<string> {
  const aviso = await prisma.notificationOutbox.findFirst({
    where: { recipientUserId: userId, eventType: "USER_INVITED" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  const payload = aviso?.payload as { path?: string } | null;
  return payload?.path ?? "";
}

/** `/invitacion/<token>` → `<token>`. */
function tokenDeLaRuta(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Mueve una fila al pasado. El CHECK exige `expires_at > created_at`. */
async function envejecerToken(tokenId: string, horas: number): Promise<void> {
  const nacimiento = new Date(Date.now() - (horas + 1) * HORA_MS);
  await prisma.accessToken.update({
    where: { id: tokenId },
    data: {
      createdAt: nacimiento,
      expiresAt: new Date(nacimiento.getTime() + HORA_MS),
    },
  });
}

beforeAll(async () => {
  const usuaria = await prisma.user.create({
    data: {
      email: `jefa.tokens.${marca}@prueba.wellbros`,
      passwordHash: "hash-de-prueba",
      fullName: `Jefa tokens ${marca}`,
      role: "SUPERUSER",
    },
    select: { id: true, email: true, fullName: true, role: true },
  });
  usuariosCreados.push(usuaria.id);
  jefa = usuaria;
});

afterAll(async () => {
  if (usuariosCreados.length === 0) return;

  // Orden obligado por las claves foráneas. `access_tokens` cae solo con el
  // usuario (ON DELETE CASCADE en `user_id`), pero NO por `created_by`, que es
  // RESTRICT: los enlaces que emitió la jefa hay que borrarlos a mano antes.
  await prisma.accessToken.deleteMany({
    where: { OR: [{ userId: { in: usuariosCreados } }, { createdById: { in: usuariosCreados } }] },
  });
  await prisma.notificationOutbox.deleteMany({
    where: { recipientUserId: { in: usuariosCreados } },
  });
  await prisma.session.deleteMany({ where: { userId: { in: usuariosCreados } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: usuariosCreados } },
        { entityId: { in: usuariosCreados } },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { id: { in: usuariosCreados } } });

  await prisma.$disconnect();
});

// ═════════════════════════════════════════════════════════════ emisión

describe("issueAccessToken", () => {
  it("devuelve el token en claro y guarda SOLO su hash, con 48 horas de vida", async () => {
    const usuario = await usuarioSuelto("emision");
    const antes = Date.now();

    const enlace = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
      createdById: jefa.id,
    });

    // 32 bytes en base64url son 43 caracteres del alfabeto seguro para una URL.
    expect(enlace.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(enlace.path).toBe(`/invitacion/${enlace.token}`);
    expect(enlace.expiresInLabel).toBe("48 horas");
    expect(enlace.supersededCount).toBe(0);

    const margen = enlace.expiresAt.getTime() - (antes + TOKEN_TTL_MS);
    expect(Math.abs(margen)).toBeLessThan(5_000);

    const fila = await prisma.accessToken.findUniqueOrThrow({
      where: { id: enlace.id },
      select: { tokenHash: true, userId: true, purpose: true, usedAt: true, supersededAt: true },
    });

    // LO IMPORTANTE DE TODA ESTA PRUEBA: en la base no está el token. Ni
    // entero, ni como prefijo, ni de ninguna otra forma.
    expect(fila.tokenHash).not.toBe(enlace.token);
    expect(fila.tokenHash).not.toContain(enlace.token);
    expect(fila.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fila.userId).toBe(usuario.id);
    expect(fila.purpose).toBe("INVITACION");
    expect(fila.usedAt).toBeNull();
    expect(fila.supersededAt).toBeNull();
  });

  it("emitir uno nuevo deja inservible el anterior", async () => {
    const usuario = await usuarioSuelto("reemplazo");

    const viejo = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
      createdById: jefa.id,
    });
    const nuevo = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
      createdById: jefa.id,
    });

    expect(nuevo.supersededCount).toBe(1);
    expect(nuevo.token).not.toBe(viejo.token);

    const comprobarViejo = await verifyAccessToken(prisma, {
      token: viejo.token,
      purpose: "INVITACION",
    });
    expect(comprobarViejo).toEqual({ ok: false, reason: "REEMPLAZADO" });

    const comprobarNuevo = await verifyAccessToken(prisma, {
      token: nuevo.token,
      purpose: "INVITACION",
    });
    expect(comprobarNuevo.ok).toBe(true);

    // La invariante de la base: como mucho una fila vigente por persona y
    // propósito. Es lo que impide que un enlace filtrado siga abriendo la
    // cuenta después de haber pedido otro.
    const vigentes = await prisma.accessToken.count({
      where: { userId: usuario.id, purpose: "INVITACION", usedAt: null, supersededAt: null },
    });
    expect(vigentes).toBe(1);

    // Y el viejo tampoco se puede canjear, no solo «verificar».
    const canje = await consumeAccessToken(prisma, {
      token: viejo.token,
      purpose: "INVITACION",
    });
    expect(canje).toEqual({ ok: false, reason: "REEMPLAZADO" });
  });

  it("los propósitos no se pisan: cada uno tiene su enlace vigente", async () => {
    const usuario = await usuarioSuelto("propositos");

    const invitacion = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
    });
    const restablecer = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "RESTABLECER_CONTRASENA",
    });

    // Emitir el de restablecer NO anula el de invitación: son cerraduras
    // distintas.
    expect(restablecer.supersededCount).toBe(0);
    expect(restablecer.path).toBe(`/restablecer/${restablecer.token}`);

    // Y un token no sirve para el propósito ajeno, aunque exista y esté vivo.
    const cruzado = await verifyAccessToken(prisma, {
      token: restablecer.token,
      purpose: "INVITACION",
    });
    expect(cruzado).toEqual({ ok: false, reason: "NO_EXISTE" });

    const propio = await verifyAccessToken(prisma, {
      token: invitacion.token,
      purpose: "INVITACION",
    });
    expect(propio.ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════ verificación

describe("verifyAccessToken", () => {
  it("un token inventado no existe, y uno con otra forma ni se consulta", async () => {
    const inventado = randomBytes(32).toString("base64url");

    expect(await verifyAccessToken(prisma, { token: inventado, purpose: "INVITACION" })).toEqual({
      ok: false,
      reason: "NO_EXISTE",
    });

    // Basura de cualquier tamaño: se rechaza por la forma, sin tocar la base.
    for (const basura of ["", "hola", "../../etc/passwd", "a".repeat(500)]) {
      expect(await verifyAccessToken(prisma, { token: basura, purpose: "INVITACION" })).toEqual({
        ok: false,
        reason: "MAL_FORMADO",
      });
    }
  });

  it("un enlace caducado deja de servir", async () => {
    const usuario = await usuarioSuelto("caducado");
    const enlace = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
    });

    // 72 horas atrás: nació y murió antes de que nadie lo abriera.
    await envejecerToken(enlace.id, 72);

    expect(await verifyAccessToken(prisma, { token: enlace.token, purpose: "INVITACION" })).toEqual(
      { ok: false, reason: "CADUCADO" },
    );

    const canje = await redeemInvitation({
      db: prisma,
      token: enlace.token,
      fullName: "Nombre Nuevo",
      passwordHash: "no-debe-guardarse",
    });
    expect(canje).toEqual({ ok: false, reason: "CADUCADO" });

    // Y no ha tocado nada: la contraseña sigue siendo la de antes.
    const fila = await prisma.user.findUniqueOrThrow({
      where: { id: usuario.id },
      select: { passwordHash: true, fullName: true },
    });
    expect(fila.passwordHash).toBe("hash-de-prueba");
    expect(fila.fullName).not.toBe("Nombre Nuevo");
  });

  it("una cuenta desactivada cierra también la puerta del enlace", async () => {
    const usuario = await usuarioSuelto("inactiva");
    const enlace = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
    });

    await prisma.user.update({ where: { id: usuario.id }, data: { isActive: false } });

    expect(await verifyAccessToken(prisma, { token: enlace.token, purpose: "INVITACION" })).toEqual(
      { ok: false, reason: "CUENTA_INACTIVA" },
    );
    expect(
      await consumeAccessToken(prisma, { token: enlace.token, purpose: "INVITACION" }),
    ).toEqual({ ok: false, reason: "CUENTA_INACTIVA" });
  });
});

// ═══════════════════════════════════════════════════════════════ canje

describe("redeemInvitation", () => {
  it("fija la contraseña, mata el enlace y deja rastro, todo junto", async () => {
    const usuario = await usuarioSuelto("canje");
    const enlace = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
      createdById: jefa.id,
    });

    // Una sesión abierta de antes: fijar contraseña tiene que cerrarla.
    await prisma.session.create({
      data: {
        userId: usuario.id,
        tokenHash: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * HORA_MS),
      },
    });

    const canje = await redeemInvitation({
      db: prisma,
      token: enlace.token,
      fullName: `Canjeada ${marca}`,
      // Hash de mentira: lo que se comprueba aquí es que se guarda EXACTAMENTE
      // lo que se le pasó. Que el hash sea bueno lo prueba el alta completa.
      passwordHash: "hash-elegido-por-su-duena",
    });

    expect(canje.ok).toBe(true);
    if (!canje.ok) return;
    expect(canje.userId).toBe(usuario.id);
    expect(canje.sessionsClosed).toBe(1);

    const fila = await prisma.user.findUniqueOrThrow({
      where: { id: usuario.id },
      select: { passwordHash: true, fullName: true, mustChangePassword: true },
    });
    expect(fila.passwordHash).toBe("hash-elegido-por-su-duena");
    expect(fila.fullName).toBe(`Canjeada ${marca}`);
    expect(fila.mustChangePassword).toBe(false);

    const token = await prisma.accessToken.findUniqueOrThrow({
      where: { id: enlace.id },
      select: { usedAt: true },
    });
    expect(token.usedAt).not.toBeNull();

    expect(await prisma.session.count({ where: { userId: usuario.id } })).toBe(0);

    const bitacora = await prisma.auditLog.findFirst({
      where: { entityId: usuario.id, action: "USER_PASSWORD_CHANGED" },
      select: { details: true, actorUserId: true },
    });
    expect(bitacora?.actorUserId).toBe(usuario.id);
    expect((bitacora?.details as { motivo?: string })?.motivo).toBe("INVITACION_CANJEADA");
    // La bitácora la lee una persona en pantalla: ni el token ni el hash pueden
    // asomar por ahí.
    expect(JSON.stringify(bitacora?.details)).not.toContain(enlace.token);
  });

  it("el mismo enlace NO sirve dos veces", async () => {
    const usuario = await usuarioSuelto("dosveces");
    const enlace = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
    });

    const primero = await redeemInvitation({
      db: prisma,
      token: enlace.token,
      fullName: "Primera Vez",
      passwordHash: "hash-de-la-primera",
    });
    expect(primero.ok).toBe(true);

    const segundo = await redeemInvitation({
      db: prisma,
      token: enlace.token,
      fullName: "Segunda Vez",
      passwordHash: "hash-de-la-segunda",
    });
    expect(segundo).toEqual({ ok: false, reason: "YA_USADO" });

    // El segundo intento no reescribió nada: si lo hubiera hecho, cualquiera
    // con el enlace del correo podría cambiar la contraseña cuando quisiera.
    const fila = await prisma.user.findUniqueOrThrow({
      where: { id: usuario.id },
      select: { passwordHash: true, fullName: true },
    });
    expect(fila.passwordHash).toBe("hash-de-la-primera");
    expect(fila.fullName).toBe("Primera Vez");
  });

  it("dos canjes SIMULTÁNEOS del mismo enlace: gana uno solo", async () => {
    const usuario = await usuarioSuelto("carrera");
    const enlace = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
    });

    // El doble clic de verdad, o la petición reintentada por un móvil con mala
    // cobertura. Si el canje leyera y escribiera por separado, aquí ganarían
    // los dos.
    const resultados = await Promise.allSettled([
      redeemInvitation({
        db: prisma,
        token: enlace.token,
        fullName: "Carrera A",
        passwordHash: "hash-a",
      }),
      redeemInvitation({
        db: prisma,
        token: enlace.token,
        fullName: "Carrera B",
        passwordHash: "hash-b",
      }),
    ]);

    // Un fallo por bloqueo de fila (dos transacciones sobre el mismo usuario)
    // cuenta como derrota, no como empate: lo que no puede pasar es que los dos
    // canjes salgan bien.
    const ganadores = resultados.filter(
      (r) => r.status === "fulfilled" && r.value.ok,
    );
    expect(ganadores).toHaveLength(1);

    expect(
      await prisma.accessToken.count({
        where: { id: enlace.id, usedAt: { not: null } },
      }),
    ).toBe(1);
  });
});

// ══════════════════════════════════════════════════════ alta de punta a punta

describe("createUser por invitación", () => {
  it("crea la cuenta sin contraseña utilizable, emite el enlace y encola el correo", async () => {
    const correo = `invitada.${marca}@prueba.wellbros`;

    const alta = await createUser({
      db: prisma,
      actor: jefa,
      input: { email: correo, fullName: `Invitada ${marca}` },
    });
    usuariosCreados.push(alta.user.id);

    expect(alta.delivery).toBe("INVITACION");
    // Lo que ya no ocurre: nadie ve una contraseña que después haya que dictar.
    expect(alta.temporaryPassword).toBeUndefined();
    expect(alta.user.pendingInvitation).toBe(true);
    expect(alta.invitation?.expiresInLabel).toBe("48 horas");
    expect(alta.notified).toBeGreaterThan(0);

    // La cuenta nace cerrada: ninguna contraseña abre esa puerta.
    const fila = await prisma.user.findUniqueOrThrow({
      where: { id: alta.user.id },
      select: { passwordHash: true, mustChangePassword: true },
    });
    expect(await verifyPassword(fila.passwordHash, "")).toBe(false);
    expect(await verifyPassword(fila.passwordHash, CONTRASENA_BUENA)).toBe(false);
    expect(await verifyPassword(fila.passwordHash, fila.passwordHash)).toBe(false);
    // Y no se le obliga a cambiar nada: la primera que tenga ya será suya.
    expect(fila.mustChangePassword).toBe(false);

    const path = await enlaceDelCorreo(alta.user.id);
    expect(path.startsWith("/invitacion/")).toBe(true);

    // El aviso encolado es el único sitio donde vive el token. La bitácora, en
    // cambio, solo guarda el identificador de la fila.
    const creacion = await prisma.auditLog.findFirst({
      where: { entityId: alta.user.id, action: "USER_CREATED" },
      select: { details: true },
    });
    const detalles = creacion?.details as { entrega?: string; invitationId?: string };
    expect(detalles.entrega).toBe("INVITACION");
    expect(detalles.invitationId).toBe(alta.invitation?.id);
    expect(JSON.stringify(creacion?.details)).not.toContain(tokenDeLaRuta(path));
  });

  it("del correo al calendario: canjear el enlace deja entrar con la contraseña elegida", async () => {
    const correo = `redonda.${marca}@prueba.wellbros`;

    const alta = await createUser({
      db: prisma,
      actor: jefa,
      input: { email: correo, fullName: `Redonda ${marca}` },
    });
    usuariosCreados.push(alta.user.id);

    const token = tokenDeLaRuta(await enlaceDelCorreo(alta.user.id));

    // Antes de canjear, ni con la contraseña buena se entra.
    reiniciarIntentosDeLogin();
    const antes = await login(prisma, { email: correo, password: CONTRASENA_BUENA });
    expect(antes.ok).toBe(false);

    const { hashPassword } = await import("@/lib/auth");
    const canje = await redeemInvitation({
      db: prisma,
      token,
      fullName: `Redonda Apellido ${marca}`,
      passwordHash: await hashPassword(CONTRASENA_BUENA),
    });
    expect(canje.ok).toBe(true);

    reiniciarIntentosDeLogin();
    const despues = await login(prisma, { email: correo, password: CONTRASENA_BUENA });
    expect(despues.ok).toBe(true);
    if (!despues.ok) return;
    // Entra directo al calendario: no hay pantalla de cambio obligatorio, porque
    // la contraseña la eligió ella.
    expect(despues.user.mustChangePassword).toBe(false);
    expect(despues.user.fullName).toBe(`Redonda Apellido ${marca}`);

    await prisma.session.deleteMany({ where: { userId: alta.user.id } });
  });

  it("la contraseña temporal sigue disponible como alternativa explícita", async () => {
    const correo = `temporal.${marca}@prueba.wellbros`;

    const alta = await createUser({
      db: prisma,
      actor: jefa,
      input: {
        email: correo,
        fullName: `Temporal ${marca}`,
        delivery: "CONTRASENA_TEMPORAL",
      },
    });
    usuariosCreados.push(alta.user.id);

    expect(alta.delivery).toBe("CONTRASENA_TEMPORAL");
    expect(alta.temporaryPassword).toBeTruthy();
    expect(alta.notified).toBe(0);
    expect(alta.invitation).toBeUndefined();
    // No hay enlace que emitir: esta vía no genera token.
    expect(await prisma.accessToken.count({ where: { userId: alta.user.id } })).toBe(0);
    // Y como la contraseña la eligió otra persona, hay que cambiarla al entrar.
    expect(alta.user.pendingInvitation).toBe(false);

    reiniciarIntentosDeLogin();
    const acceso = await login(prisma, {
      email: correo,
      password: alta.temporaryPassword ?? "",
    });
    expect(acceso.ok).toBe(true);
    if (!acceso.ok) return;
    expect(acceso.user.mustChangePassword).toBe(true);

    await prisma.session.deleteMany({ where: { userId: alta.user.id } });
  });
});

// ═══════════════════════════════════════════════════════════ reenvío

describe("reinviteUser", () => {
  it("manda un enlace nuevo y anula el anterior", async () => {
    const alta = await createUser({
      db: prisma,
      actor: jefa,
      input: { email: `reenvio.${marca}@prueba.wellbros`, fullName: `Reenvío ${marca}` },
    });
    usuariosCreados.push(alta.user.id);

    const primerToken = tokenDeLaRuta(await enlaceDelCorreo(alta.user.id));
    // Se le pasó el plazo, que es justo el caso para el que existe el reenvío.
    await envejecerToken(alta.invitation?.id ?? "", 72);

    const reenvio = await reinviteUser({ db: prisma, actor: jefa, userId: alta.user.id });

    expect(reenvio.supersededCount).toBe(1);
    expect(reenvio.notified).toBeGreaterThan(0);
    expect(reenvio.invitation.id).not.toBe(alta.invitation?.id);

    const segundoToken = tokenDeLaRuta(await enlaceDelCorreo(alta.user.id));
    expect(segundoToken).not.toBe(primerToken);

    // El viejo sigue muerto y el nuevo abre.
    expect(
      await verifyAccessToken(prisma, { token: primerToken, purpose: "INVITACION" }),
    ).toEqual({ ok: false, reason: "REEMPLAZADO" });
    expect(
      (await verifyAccessToken(prisma, { token: segundoToken, purpose: "INVITACION" })).ok,
    ).toBe(true);

    const anotado = await prisma.auditLog.count({
      where: { entityId: alta.user.id, action: "USER_REINVITED" },
    });
    expect(anotado).toBe(1);
  });

  it("no se reinvita a quien ya eligió su contraseña", async () => {
    const alta = await createUser({
      db: prisma,
      actor: jefa,
      input: { email: `yaentro.${marca}@prueba.wellbros`, fullName: `Ya entró ${marca}` },
    });
    usuariosCreados.push(alta.user.id);

    const token = tokenDeLaRuta(await enlaceDelCorreo(alta.user.id));
    await redeemInvitation({
      db: prisma,
      token,
      fullName: `Ya entró ${marca}`,
      passwordHash: "hash-propio",
    });

    // Reinvitar aquí sería un cambio de contraseña hecho por otra persona sin
    // llamarlo por su nombre. Eso es la recuperación de contraseña, y todavía
    // no existe.
    await expect(
      reinviteUser({ db: prisma, actor: jefa, userId: alta.user.id }),
    ).rejects.toThrow(/ya tiene contraseña propia/i);
  });

  it("no se reinvita a una cuenta desactivada", async () => {
    const alta = await createUser({
      db: prisma,
      actor: jefa,
      input: { email: `baja.${marca}@prueba.wellbros`, fullName: `Baja ${marca}` },
    });
    usuariosCreados.push(alta.user.id);

    await prisma.user.update({ where: { id: alta.user.id }, data: { isActive: false } });

    await expect(
      reinviteUser({ db: prisma, actor: jefa, userId: alta.user.id }),
    ).rejects.toThrow(/desactivada/i);
  });
});

// ═════════════════════════════════════════════════════════ mantenimiento

describe("purgeDeadAccessTokens", () => {
  it("barre los enlaces muertos y viejos, y respeta los vivos", async () => {
    const usuario = await usuarioSuelto("purga");

    const antiguo = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "RESTABLECER_CONTRASENA",
    });
    // Cuarenta días atrás: caducado y fuera del margen de conservación.
    await envejecerToken(antiguo.id, 40 * 24);

    const reciente = await issueAccessToken(prisma, {
      userId: usuario.id,
      purpose: "INVITACION",
    });

    const barridos = await purgeDeadAccessTokens(prisma);
    expect(barridos).toBeGreaterThanOrEqual(1);

    expect(await prisma.accessToken.count({ where: { id: antiguo.id } })).toBe(0);
    // El vivo no se toca aunque comparta dueño.
    expect(await prisma.accessToken.count({ where: { id: reciente.id } })).toBe(1);
  });
});
