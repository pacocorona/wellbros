/**
 * Tokens de acceso de un solo uso: emitir, verificar y canjear.
 *
 * Función pura de framework, como el resto de `src/server/**`: estas funciones
 * reciben el cliente de Prisma (o el de una transacción en curso) y el actor;
 * no llaman a `cookies()`, ni a `headers()`, ni a `requireUser()`. Quien
 * resuelve la sesión y escribe la cookie es la página o la Server Action.
 *
 * ─── POR QUÉ ESTO NO ES UN MÓDULO DE «INVITACIONES» ───────────────────────
 * El primer uso es la invitación de alta. El siguiente encargo —recuperar la
 * contraseña— necesita el mismo mecanismo hasta el último detalle: 32 bytes
 * aleatorios, en la base solo el hash, caducidad corta, un solo uso, y los
 * anteriores invalidados al emitir uno nuevo. Lo único que cambia es el
 * PROPÓSITO, que es una columna. Por eso ni la tabla se llama `invitations` ni
 * este archivo `invitations.ts`: dos copias de un mecanismo de seguridad
 * divergen siempre, y suelen hacerlo en la copia que menos se mira.
 *
 * ─── LAS REGLAS DEL TOKEN, QUE SON DE SEGURIDAD ──────────────────────────
 *  1. 32 bytes de `node:crypto` en base64url. 256 bits: no hay diccionario ni
 *     fuerza bruta que llegue.
 *  2. En la base vive SOLO el SHA-256 del token, nunca el token. Mismo criterio
 *     que las sesiones (`@/lib/auth/session`): un volcado de `access_tokens` no
 *     debe permitir suplantar a nadie ni fabricar un enlace válido. Y basta
 *     SHA-256 —no Argon2— porque esto no es una contraseña elegida por una
 *     persona sino un valor aleatorio: lo que se busca es que el hash robado no
 *     sea reutilizable, no encarecer el intento de adivinarlo.
 *  3. Caduca a las 48 horas.
 *  4. UN SOLO USO. El canje marca la fila como usada DENTRO de la misma
 *     transacción que escribe la contraseña, con un UPDATE condicional que es
 *     al mismo tiempo la comprobación: dos canjes simultáneos del mismo enlace
 *     no pueden ganar los dos.
 *  5. Emitir uno nuevo invalida los anteriores de esa persona y propósito. Y no
 *     solo aquí: la base lo impone con un índice único parcial (ver la
 *     migración `20260827100000_tokens_de_acceso`).
 *
 * ─── LO QUE ESTO **NO** RESUELVE, Y HAY QUE SABERLO ──────────────────────
 * `access_tokens` no guarda el token, pero `notification_outbox` SÍ: el aviso
 * encolado lleva la ruta entera en su `payload`, y una vez enviado la lleva
 * también en `rendered_html`. Es inevitable con el patrón outbox —para mandar
 * un correo hay que guardar el correo— y renderizar en el momento del envío no
 * es alternativa: rompería la reproducibilidad byte a byte que exige la
 * idempotencia del proveedor (§08).
 *
 * Así que el enlace vive en claro en esa tabla mientras la fila exista. Lo que
 * acota el daño es que caduca en 48 horas y que muere al usarse. PARA EL
 * INTEGRADOR: hoy no hay ninguna limpieza de filas SENT del outbox; cuando la
 * haya, los avisos de tipo USER_INVITED son los primeros que deberían barrerse,
 * y con menos margen que el resto.
 */

import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import type { AccessTokenPurpose } from "@/generated/prisma/enums";
import { writeAudit } from "@/lib/audit";
import type { Db } from "@/lib/db";

// ═══════════════════════════════════════════════════════════ constantes

/** 32 bytes = 256 bits, igual que el token de sesión. */
const TOKEN_BYTES = 32;

/** Vida del enlace. */
export const TOKEN_TTL_HORAS = 48;
export const TOKEN_TTL_MS = TOKEN_TTL_HORAS * 60 * 60 * 1000;

/**
 * Cómo se dice la caducidad en el correo.
 *
 * Es TEXTO y no un cálculo hecho al renderizar: los avisos deben poder
 * reconstruirse byte a byte años después (§08), y una plantilla que restara
 * fechas en el momento del envío daría un cuerpo distinto en cada reintento.
 */
export const TOKEN_CADUCIDAD_ETIQUETA = `${TOKEN_TTL_HORAS} horas`;

/**
 * 32 bytes en base64url son 43 caracteres del alfabeto `A-Za-z0-9-_`.
 *
 * Se comprueba ANTES de tocar la base: lo que llega es un segmento de URL, o
 * sea cualquier cosa que alguien haya querido escribir, y no tiene sentido
 * gastar una consulta —ni escribir en el registro— por una cadena que no puede
 * ser un token nuestro.
 */
const FORMA_DEL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A dónde lleva el enlace de cada propósito. Ruta RELATIVA siempre: una URL
 * absoluta escrita aquí sería el vector clásico de phishing en un correo de
 * alta, y el worker ya antepone `APP_BASE_URL`.
 */
const RUTA_DE_CANJE: Readonly<Record<AccessTokenPurpose, (token: string) => string>> = {
  INVITACION: (token) => `/invitacion/${token}`,
  // La pantalla todavía no existe: es el siguiente encargo. Vive aquí desde ya
  // para que emitir un token de ese propósito no obligue a tocar este mapa a
  // última hora, con el enlace ya redactado en la plantilla del correo.
  RESTABLECER_CONTRASENA: (token) => `/restablecer/${token}`,
};

// ═════════════════════════════════════════════════════════════════ tipos

/**
 * Cliente capaz de trabajar con la tabla: sirve el global y el de una
 * transacción interactiva. Se pide justo lo que se usa, igual que `AuditClient`,
 * para que ambos encajen sin castings.
 */
export type TokenClient =
  | Pick<Db, "accessToken">
  | Pick<Prisma.TransactionClient, "accessToken">;

export interface IssuedAccessToken {
  /**
   * Identificador de la FILA, que es también el `invitationId` del aviso: la
   * clave de deduplicación del outbox se ancla al enlace y no al usuario, para
   * que reinvitar a alguien vuelva a enviar de verdad.
   */
  id: string;
  /**
   * El token EN CLARO. Solo existe aquí y en el enlace del correo; en la base
   * nunca entra. Si se pierde, no hay forma de recuperarlo: se emite otro.
   */
  token: string;
  userId: string;
  purpose: AccessTokenPurpose;
  expiresAt: Date;
  /** Ruta relativa lista para el correo, p. ej. `/invitacion/<token>`. */
  path: string;
  /** «48 horas». */
  expiresInLabel: string;
  /** Cuántos enlaces anteriores quedaron inservibles al emitir este. */
  supersededCount: number;
}

/**
 * Por qué no sirve un token.
 *
 * Se distinguen para la BITÁCORA y para las pruebas, no para la pantalla: a
 * quien llega con un enlace muerto se le dice lo mismo en los cinco casos —el
 * enlace ya no sirve, pide otro— porque afinar el mensaje convertiría la
 * pantalla en un oráculo para averiguar qué cuentas existen y cuáles tienen
 * invitación pendiente.
 */
export type TokenFailureReason =
  | "MAL_FORMADO"
  | "NO_EXISTE"
  | "CADUCADO"
  | "YA_USADO"
  | "REEMPLAZADO"
  | "CUENTA_INACTIVA";

/** Lo que hace falta saber del sujeto del token para pintar la pantalla. */
export interface TokenSubject {
  userId: string;
  email: string;
  fullName: string;
}

export type VerifyTokenResult =
  | { ok: true; tokenId: string; purpose: AccessTokenPurpose; expiresAt: Date; subject: TokenSubject }
  | { ok: false; reason: TokenFailureReason };

// ═══════════════════════════════════════════════════════════ internos

/**
 * SHA-256 en hexadecimal. Idéntico a `hashToken` de `@/lib/auth/session`, y
 * duplicado a propósito: aquella es privada de ese módulo y exportarla ataría
 * dos ciclos de vida distintos —el de la cookie y el del enlace— a la misma
 * función solo por parecerse.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `access_tokens.ip` es varchar(64). */
const MAX_IP = 64;

function recortarIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return ip.length > MAX_IP ? ip.slice(0, MAX_IP) : ip;
}

// ═════════════════════════════════════════════════════════════ emisión

export interface IssueAccessTokenInput {
  userId: string;
  purpose: AccessTokenPurpose;
  /** Quién lo emite. Nulo cuando no hay actor (una recuperación la pide su dueño). */
  createdById?: string | null;
  ip?: string | null;
  now?: Date;
}

/**
 * Emite un token nuevo e invalida los anteriores de esa persona y propósito.
 *
 * Las dos cosas tienen que ocurrir juntas, y por eso esta función NO abre
 * transacción propia: recibe la del caso de uso (`createUser` la llama dentro
 * de la suya, junto con el alta y el encolado del correo). Si el llamador pasa
 * el cliente global, el `updateMany` y el `create` van sueltos —aceptable solo
 * si no hay nada más que coordinar—; el índice único parcial de la base impide
 * de todos modos que queden dos vigentes.
 *
 * `supersededAt` y no un DELETE: un enlace emitido y anulado es historia, y la
 * bitácora de una cuenta con tres reenvíos se lee mucho mejor si las tres filas
 * siguen ahí.
 */
export async function issueAccessToken(
  db: TokenClient,
  { userId, purpose, createdById, ip, now = new Date() }: IssueAccessTokenInput,
): Promise<IssuedAccessToken> {
  // Se invalidan TODOS los anteriores que sigan vivos, caducados incluidos: el
  // índice parcial de la base no mira `expires_at` (un predicado con `now()` no
  // sería inmutable), así que dejar una fila caducada sin marcar bloquearía la
  // inserción de la nueva.
  const { count: supersededCount } = await db.accessToken.updateMany({
    where: { userId, purpose, usedAt: null, supersededAt: null },
    data: { supersededAt: now },
  });

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

  const fila = await db.accessToken.create({
    data: {
      userId,
      purpose,
      // Lo único que entra en la base. El token se queda en memoria y sale de
      // aquí hacia el correo.
      tokenHash: hashToken(token),
      expiresAt,
      createdById: createdById ?? null,
      ip: recortarIp(ip),
      // `createdAt` explícito para que el CHECK `expires_at > created_at` compare
      // contra el mismo reloj que calculó la caducidad, y no contra el `now()`
      // del servidor de base de datos, que puede ir unos milisegundos por
      // delante.
      createdAt: now,
    },
    select: { id: true },
  });

  return {
    id: fila.id,
    token,
    userId,
    purpose,
    expiresAt,
    path: RUTA_DE_CANJE[purpose](token),
    expiresInLabel: TOKEN_CADUCIDAD_ETIQUETA,
    supersededCount,
  };
}

// ═══════════════════════════════════════════════════════════ verificación

export interface VerifyAccessTokenInput {
  token: string;
  purpose: AccessTokenPurpose;
  now?: Date;
}

/**
 * ¿Sirve este token? Solo LEE: no marca nada.
 *
 * Es lo que usa la página de canje para decidir si pinta el formulario o el
 * mensaje de enlace muerto. NO es la autorización final: entre este `SELECT` y
 * el envío del formulario pasan minutos, y quien manda de verdad es el UPDATE
 * condicional de `consumeAccessToken`.
 */
export async function verifyAccessToken(
  db: TokenClient,
  { token, purpose, now = new Date() }: VerifyAccessTokenInput,
): Promise<VerifyTokenResult> {
  if (!FORMA_DEL_TOKEN.test(token)) return { ok: false, reason: "MAL_FORMADO" };

  const fila = await db.accessToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      purpose: true,
      expiresAt: true,
      usedAt: true,
      supersededAt: true,
      // Selección explícita y no `user: true`: así una columna nueva en `users`
      // (o `password_hash`, sobre todo) no se cuela aquí por descuido.
      user: { select: { id: true, email: true, fullName: true, isActive: true } },
    },
  });

  if (!fila) return { ok: false, reason: "NO_EXISTE" };
  // Un token de recuperación no debe servir para canjear una invitación ni al
  // revés: el propósito es parte de la identidad del enlace, no una etiqueta.
  if (fila.purpose !== purpose) return { ok: false, reason: "NO_EXISTE" };
  if (fila.usedAt !== null) return { ok: false, reason: "YA_USADO" };
  if (fila.supersededAt !== null) return { ok: false, reason: "REEMPLAZADO" };
  if (fila.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "CADUCADO" };
  // Dar de baja una cuenta corta el acceso de inmediato; un enlace emitido antes
  // no puede ser la rendija por la que se vuelve a entrar.
  if (!fila.user.isActive) return { ok: false, reason: "CUENTA_INACTIVA" };

  return {
    ok: true,
    tokenId: fila.id,
    purpose: fila.purpose,
    expiresAt: fila.expiresAt,
    subject: {
      userId: fila.user.id,
      email: fila.user.email,
      fullName: fila.user.fullName,
    },
  };
}

// ═══════════════════════════════════════════════════════════════ canje

export type ConsumeAccessTokenResult =
  | { ok: true; tokenId: string; userId: string }
  | { ok: false; reason: TokenFailureReason };

export interface ConsumeAccessTokenInput {
  token: string;
  purpose: AccessTokenPurpose;
  now?: Date;
}

/**
 * Marca el token como usado, y solo lo consigue si de verdad servía.
 *
 * ES LA COMPROBACIÓN Y LA ESCRITURA A LA VEZ, a propósito. El `updateMany`
 * lleva en su `where` todas las condiciones de validez —no usado, no
 * reemplazado, no caducado, del propósito correcto— y devuelve cuántas filas
 * cambió. Si devuelve 1, este llamador es el único que lo canjeó; si devuelve
 * 0, alguien se le adelantó o el enlace ya no valía. Leer primero y escribir
 * después dejaría entre las dos sentencias el hueco exacto por el que dos
 * peticiones simultáneas con el mismo enlace entrarían las dos.
 *
 * Debe llamarse DENTRO de la transacción que escribe la contraseña: si esa
 * escritura se deshace, el token tiene que volver a estar disponible, o la
 * persona se quedaría sin enlace y sin cuenta abierta. Por eso recibe el
 * cliente de la transacción y no abre una propia.
 *
 * Cuando falla, hace una segunda consulta —ya sin condiciones— solo para poder
 * decir POR QUÉ. Ese detalle no llega nunca a la pantalla (ver
 * `TokenFailureReason`); sirve para la bitácora y para las pruebas.
 */
export async function consumeAccessToken(
  db: TokenClient,
  { token, purpose, now = new Date() }: ConsumeAccessTokenInput,
): Promise<ConsumeAccessTokenResult> {
  if (!FORMA_DEL_TOKEN.test(token)) return { ok: false, reason: "MAL_FORMADO" };

  const tokenHash = hashToken(token);

  const { count } = await db.accessToken.updateMany({
    where: {
      tokenHash,
      purpose,
      usedAt: null,
      supersededAt: null,
      expiresAt: { gt: now },
      user: { isActive: true },
    },
    data: { usedAt: now },
  });

  if (count === 1) {
    const fila = await db.accessToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    });
    // Imposible en la práctica: acabamos de escribir esa fila dentro de esta
    // misma transacción. Se trata como fallo en vez de con un `!` para que un
    // día raro devuelva «no sirve» y no un error de tipos en tiempo de ejecución.
    if (!fila) return { ok: false, reason: "NO_EXISTE" };
    return { ok: true, tokenId: fila.id, userId: fila.userId };
  }

  return { ok: false, reason: await motivoDelFallo(db, tokenHash, purpose, now) };
}

/** Diagnóstico del canje fallido. Solo para el registro. */
async function motivoDelFallo(
  db: TokenClient,
  tokenHash: string,
  purpose: AccessTokenPurpose,
  now: Date,
): Promise<TokenFailureReason> {
  const fila = await db.accessToken.findUnique({
    where: { tokenHash },
    select: {
      purpose: true,
      expiresAt: true,
      usedAt: true,
      supersededAt: true,
      user: { select: { isActive: true } },
    },
  });

  if (!fila || fila.purpose !== purpose) return "NO_EXISTE";
  if (fila.usedAt !== null) return "YA_USADO";
  if (fila.supersededAt !== null) return "REEMPLAZADO";
  if (fila.expiresAt.getTime() <= now.getTime()) return "CADUCADO";
  if (!fila.user.isActive) return "CUENTA_INACTIVA";
  return "NO_EXISTE";
}

// ══════════════════════════════════════════════ caso de uso: canjear alta

export interface RedeemInvitationInput {
  db: Db;
  token: string;
  /** Nombre confirmado por su dueña; llega prellenado con el que puso el alta. */
  fullName: string;
  /** Contraseña YA HASHEADA. Ver la nota de abajo sobre por qué no en claro. */
  passwordHash: string;
  ip?: string | null;
  now?: Date;
}

export type RedeemInvitationResult =
  | {
      ok: true;
      userId: string;
      email: string;
      fullName: string;
      tokenId: string;
      /** Sesiones que se cerraron al fijar la contraseña. */
      sessionsClosed: number;
    }
  | { ok: false; reason: TokenFailureReason };

/**
 * Canjea una invitación: fija la contraseña que su dueña acaba de elegir y mata
 * el enlace, todo en la MISMA transacción.
 *
 * Ese «en la misma» es el punto entero de la función. Si el token se marcara
 * fuera, cualquier fallo entre las dos escrituras dejaría una de estas dos
 * ruinas: un enlace quemado sin contraseña puesta (la persona no puede entrar y
 * su único enlace ya no sirve) o una contraseña puesta con el enlace todavía
 * vivo (cualquiera que lo tenga vuelve a cambiarla).
 *
 * RECIBE LA CONTRASEÑA YA HASHEADA. Argon2 con los parámetros del proyecto
 * cuesta unos 200 ms, y calcularlo dentro de la transacción la tendría abierta
 * —con sus bloqueos de fila— todo ese rato para nada. Es el mismo reparto que
 * hace `changeOwnPassword`.
 *
 * NO crea la sesión: `createSession` trabaja con el cliente global de Prisma y
 * no admite un `tx`, así que atarla aquí sería mentir sobre la atomicidad.
 * Quien llama la crea después, con el `userId` que devuelve esto. El orden es
 * deliberado y es el mismo de `login()`: si la sesión fallara, la contraseña ya
 * está puesta y la persona entra por /login; al revés tendríamos una sesión
 * abierta de una cuenta que no llegó a abrirse.
 */
export async function redeemInvitation({
  db,
  token,
  fullName,
  passwordHash,
  ip,
  now = new Date(),
}: RedeemInvitationInput): Promise<RedeemInvitationResult> {
  return db.$transaction(async (tx) => {
    const canje = await consumeAccessToken(tx, {
      token,
      purpose: "INVITACION",
      now,
    });
    if (!canje.ok) return canje;

    const usuario = await tx.user.update({
      where: { id: canje.userId },
      data: {
        fullName,
        passwordHash,
        // Se apaga aquí y no en otra escritura: la contraseña que acaba de
        // guardarse la eligió su dueña, que es exactamente lo que este
        // indicador significa. Normalmente ya venía apagado —una cuenta creada
        // por invitación nace así—, pero el día que este canje sirva también
        // para restablecer, la cuenta puede llegar con él encendido.
        mustChangePassword: false,
      },
      select: { id: true, email: true, fullName: true },
    });

    // Higiene: no debería haber ninguna sesión abierta de una cuenta que
    // todavía no tenía contraseña, pero fijar una contraseña siempre cierra lo
    // que hubiera. Va en la transacción —y no por `destroyAllSessions`, que usa
    // el cliente global— para que deshacer el canje no deje sesiones cerradas
    // con la cuenta intacta.
    const { count: sessionsClosed } = await tx.session.deleteMany({
      where: { userId: usuario.id },
    });

    await writeAudit(tx, {
      // NOTA PARA EL INTEGRADOR: la acción exacta sería
      // `USER_INVITATION_ACCEPTED`, pero `AUDIT_ACTIONS` (src/lib/audit.ts) es
      // una unión cerrada y ese archivo es de otro agente en esta tanda. Se usa
      // la que describe el hecho principal —quedó una contraseña nueva y se
      // cerraron las sesiones— y el motivo va en el detalle.
      action: "USER_PASSWORD_CHANGED",
      entityType: "USER",
      entityId: usuario.id,
      // El actor es la propia persona: nadie más interviene en el canje.
      actorUserId: usuario.id,
      ip,
      details: {
        email: usuario.email,
        motivo: "INVITACION_CANJEADA",
        tokenId: canje.tokenId,
        sesionesCerradas: sessionsClosed,
      },
    });

    return {
      ok: true as const,
      userId: usuario.id,
      email: usuario.email,
      fullName: usuario.fullName,
      tokenId: canje.tokenId,
      sessionsClosed,
    };
  });
}

// ═══════════════════════════════════════════════════════════ mantenimiento

/**
 * Barre los tokens que ya no pueden servir a nadie. Pensado para una tarea
 * programada, igual que `purgeExpiredSessions`.
 *
 * Se conserva un margen (por omisión 30 días) porque estas filas son historia
 * útil mientras alguien pueda preguntar «¿le llegó el enlace?, ¿lo usó?»;
 * pasado ese plazo ya nadie lo pregunta y la tabla no tiene por qué crecer.
 */
export async function purgeDeadAccessTokens(
  db: TokenClient,
  { now = new Date(), retentionDays = 30 }: { now?: Date; retentionDays?: number } = {},
): Promise<number> {
  const corte = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await db.accessToken.deleteMany({
    where: {
      createdAt: { lt: corte },
      OR: [
        { usedAt: { not: null } },
        { supersededAt: { not: null } },
        { expiresAt: { lt: now } },
      ],
    },
  });
  return count;
}
