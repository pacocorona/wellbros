/**
 * Caso de uso: iniciar sesión.
 *
 * Función pura de framework (ver ARQUITECTURA del proyecto): recibe el
 * cliente de Prisma y los datos ya extraídos de la petición —incluida la IP—
 * y no toca `cookies()` ni `headers()`. Quien la llama decide qué hacer con
 * el token: la página de /login lo pone en la cookie, y una futura /api/v1
 * podría devolverlo de otra forma sin reescribir nada de esto.
 *
 * Lo que NO se filtra nunca: si el fallo fue por correo desconocido, por
 * contraseña equivocada, por cuenta desactivada o por exceso de intentos.
 * El motivo se guarda en la bitácora —que solo lee la superusuaria— y hacia
 * fuera siempre viaja el mismo mensaje. Por eso `LoginResult` distingue
 * causas: son para el registro, no para la pantalla.
 */

import { z } from "zod";

import {
  createSession,
  verifyDummyPassword,
  verifyPassword,
  type CreatedSession,
  type SessionUser,
} from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import type { Db } from "@/lib/db";

// ────────────────────────────────────────────────────────────── entrada

const ESQUEMA = z.object({
  // El correo se normaliza aquí: la columna es `citext` y ya compara sin
  // distinguir mayúsculas, pero la clave del limitador y lo que se guarda en
  // la bitácora deben ser estables.
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  // Solo se exige que no venga vacía: las reglas de longitud son cosa del
  // alta y del cambio de contraseña, no del login. Un máximo generoso evita
  // que alguien nos haga calcular Argon2 sobre un megabyte de basura.
  password: z.string().min(1).max(200),
});

export interface LoginInput {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

/** Causa del rechazo. Para la bitácora; jamás para el mensaje al usuario. */
export type LoginFailureReason =
  | "INVALID_INPUT"
  | "UNKNOWN_EMAIL"
  | "BAD_PASSWORD"
  | "INACTIVE_USER"
  | "RATE_LIMITED";

export type LoginResult =
  | { ok: true; user: SessionUser; session: CreatedSession }
  | { ok: false; reason: LoginFailureReason };

// ──────────────────────────────────────────────── límite de intentos

/**
 * Máximo de fallos por correo+IP dentro de la ventana.
 *
 * OJO — esto es un cerrojo POR PROCESO, en memoria: se reinicia con cada
 * despliegue y no se comparte entre instancias. No es la defensa contra
 * fuerza bruta distribuida; ese límite lo pone nginx por IP
 * (`limit_req_zone`, ver deploy/). Lo que sí resuelve, y por eso está aquí,
 * es el caso concreto de alguien probando contraseñas contra UNA cuenta:
 * cada intento cuesta ~200 ms de Argon2, y sin este freno cinco hilos
 * bastarían para tener el CPU ocupado indefinidamente.
 *
 * La clave incluye la IP para que un atacante no pueda dejar fuera a una
 * persona real solo con fallar cinco veces con su correo.
 */
const MAX_FALLOS = 5;
const VENTANA_MS = 15 * 60 * 1000;

/** A partir de aquí se barre el mapa; sin esto crecería sin techo. */
const LIMITE_ENTRADAS = 1_000;

interface Cubeta {
  fallos: number;
  /** Instante en que la cubeta deja de contar. */
  expiraEn: number;
  /** El bloqueo ya se anotó una vez en la bitácora en esta ventana. */
  bloqueoAnotado: boolean;
}

const intentos = new Map<string, Cubeta>();

function clave(email: string, ip: string | null | undefined): string {
  return `${email}|${ip ?? "sin-ip"}`;
}

function barrer(ahora: number): void {
  if (intentos.size < LIMITE_ENTRADAS) return;
  for (const [k, cubeta] of intentos) {
    if (cubeta.expiraEn <= ahora) intentos.delete(k);
  }
}

function cubetaVigente(k: string, ahora: number): Cubeta | null {
  const cubeta = intentos.get(k);
  if (!cubeta) return null;
  if (cubeta.expiraEn <= ahora) {
    intentos.delete(k);
    return null;
  }
  return cubeta;
}

function anotarFallo(k: string, ahora: number): void {
  const cubeta = cubetaVigente(k, ahora);
  if (cubeta) {
    cubeta.fallos += 1;
    return;
  }
  barrer(ahora);
  intentos.set(k, {
    fallos: 1,
    expiraEn: ahora + VENTANA_MS,
    bloqueoAnotado: false,
  });
}

/** Se llama al entrar bien: quien acierta no arrastra sus fallos previos. */
function limpiar(k: string): void {
  intentos.delete(k);
}

/**
 * Vacía el contador. Solo para las pruebas: sin esto, un caso que agota los
 * intentos contaminaría al siguiente dentro del mismo proceso de vitest.
 */
export function reiniciarIntentosDeLogin(): void {
  intentos.clear();
}

// ───────────────────────────────────────────────────────────── IP real

/**
 * IP de quien llama, leída de las cabeceras que pone el proxy.
 *
 * Recibe un `Headers` en vez de llamar a `headers()` para no atar este
 * módulo a Next. Solo es de fiar detrás de nginx —cualquiera puede mandar un
 * `X-Forwarded-For` a mano—, y por eso se toma el PRIMER valor de la lista,
 * que es el que nginx antepone. Se usa para la bitácora y para el limitador,
 * nunca para autorizar.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const reenviada = headers.get("x-forwarded-for");
  if (reenviada) {
    const primera = reenviada.split(",")[0]?.trim();
    if (primera) return primera;
  }
  return headers.get("x-real-ip")?.trim() || null;
}

// ──────────────────────────────────────────────────────── caso de uso

/**
 * Verifica las credenciales y, si son válidas, crea la sesión.
 *
 * Devuelve el token en claro dentro de `session`: es la ÚNICA vez que
 * existe. El llamador debe pasarlo a `setSessionCookie` de inmediato.
 *
 * Nota para el integrador: la creación de la sesión y su entrada de bitácora
 * NO comparten transacción, a diferencia del resto de las mutaciones del
 * proyecto. `createSession` es del contrato de @/lib/auth y usa el cliente
 * global, no admite un `tx`. El orden es deliberado —primero la sesión,
 * después la anotación—: si la anotación falla, queda una fila de sesión
 * huérfana cuyo token nunca llegó a ninguna cookie, que es el fallo barato.
 * Al revés tendríamos un LOGIN_SUCCEEDED de un acceso que no ocurrió.
 */
export async function login(db: Db, input: LoginInput): Promise<LoginResult> {
  const ip = input.ip ?? null;
  const analizado = ESQUEMA.safeParse({
    email: input.email,
    password: input.password,
  });

  if (!analizado.success) {
    // Ni bitácora ni contador: sin un correo bien formado no hay cuenta que
    // proteger, y anotarlo solo daría a un robot la forma de llenar el
    // registro. Además se responde rápido, cosa que no revela nada: la
    // pregunta interesante —¿existe este correo?— sigue costando lo mismo.
    return { ok: false, reason: "INVALID_INPUT" };
  }

  const { email, password } = analizado.data;
  const ahora = Date.now();
  const k = clave(email, ip);
  const cubeta = cubetaVigente(k, ahora);

  if (cubeta && cubeta.fallos >= MAX_FALLOS) {
    // Se anota UNA vez por ventana. Anotar cada intento bloqueado convertiría
    // el ataque en una forma cómoda de inundar la bitácora.
    if (!cubeta.bloqueoAnotado) {
      cubeta.bloqueoAnotado = true;
      await writeAudit(db, {
        action: "LOGIN_FAILED",
        entityType: "USER",
        details: { email, motivo: "DEMASIADOS_INTENTOS", maxFallos: MAX_FALLOS },
        ip,
      });
    }
    // Se corta ANTES de tocar la base y antes de Argon2: ese ahorro es justo
    // el objetivo del cerrojo.
    return { ok: false, reason: "RATE_LIMITED" };
  }

  const usuario = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      whatsappOptIn: true,
      role: true,
      theme: true,
      mustChangePassword: true,
      isActive: true,
      passwordHash: true,
    },
  });

  // `verifyDummyPassword` gasta el mismo tiempo que una verificación real.
  // Sin él, un correo inexistente respondería en microsegundos y el reloj
  // delataría qué cuentas existen.
  if (!usuario) {
    await verifyDummyPassword(password);
    anotarFallo(k, ahora);
    await writeAudit(db, {
      action: "LOGIN_FAILED",
      entityType: "USER",
      details: { email, motivo: "CORREO_DESCONOCIDO" },
      ip,
    });
    return { ok: false, reason: "UNKNOWN_EMAIL" };
  }

  if (!usuario.isActive) {
    // Misma pausa que arriba: dar de baja una cuenta no debe volverla
    // detectable por lo rápido que responde.
    await verifyDummyPassword(password);
    anotarFallo(k, ahora);
    await writeAudit(db, {
      action: "LOGIN_FAILED",
      entityType: "USER",
      entityId: usuario.id,
      details: { email, motivo: "CUENTA_DESACTIVADA" },
      ip,
    });
    return { ok: false, reason: "INACTIVE_USER" };
  }

  const correcta = await verifyPassword(usuario.passwordHash, password);

  if (!correcta) {
    anotarFallo(k, ahora);
    await writeAudit(db, {
      action: "LOGIN_FAILED",
      entityType: "USER",
      entityId: usuario.id,
      // `actorUserId` se queda nulo a propósito: un intento fallido no
      // acredita a nadie. Quien buscaba la cuenta va en `entityId`.
      details: { email, motivo: "CONTRASENA_INCORRECTA" },
      ip,
    });
    return { ok: false, reason: "BAD_PASSWORD" };
  }

  limpiar(k);

  const session = await createSession(usuario.id, {
    ip,
    userAgent: input.userAgent ?? null,
  });

  await writeAudit(db, {
    action: "LOGIN_SUCCEEDED",
    entityType: "SESSION",
    entityId: session.sessionId,
    actorUserId: usuario.id,
    details: { email: usuario.email, nombre: usuario.fullName },
    ip,
  });

  // Se copia campo a campo, igual que en @/lib/auth: así una columna nueva
  // (y `passwordHash`, sobre todo) nunca sale de aquí por descuido.
  const user: SessionUser = {
    id: usuario.id,
    email: usuario.email,
    fullName: usuario.fullName,
    phone: usuario.phone,
    whatsappOptIn: usuario.whatsappOptIn,
    role: usuario.role,
    theme: usuario.theme,
    // Quien entra con una contraseña que le dictaron llega aquí con el
    // indicador encendido; la puerta que lo lee es src/app/(app)/layout.tsx.
    mustChangePassword: usuario.mustChangePassword,
  };

  return { ok: true, user, session };
}
