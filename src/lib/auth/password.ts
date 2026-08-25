/**
 * Contraseñas: hash y verificación con Argon2id.
 *
 * Argon2id es el algoritmo recomendado por OWASP: mezcla la resistencia a GPU
 * de Argon2d con la resistencia a canales laterales de Argon2i. El costo va
 * explícito y no por defecto, porque estos números son una decisión de
 * seguridad que debe poder auditarse y subirse con el tiempo.
 *
 * El hash resultante es una cadena PHC (`$argon2id$v=19$m=...,t=...,p=...$sal$hash`)
 * que lleva dentro sus propios parámetros y la sal: al verificar NO hay que
 * pasarle las opciones, se leen de la cadena almacenada. Por eso subir los
 * costes en el futuro no invalida las contraseñas ya guardadas.
 */

import { hash, verify, type Algorithm, type Options } from "@node-rs/argon2";

/**
 * Argon2id, escrito por su valor numérico.
 *
 * `Algorithm` es un `const enum` ambiental y el proyecto compila con
 * `isolatedModules`, que prohíbe leer su valor en tiempo de ejecución
 * (TS2748). El tipo sí se puede usar, así que la anotación mantiene la
 * comprobación: si el valor no correspondiera a un miembro del enum, no
 * compilaría.
 */
const ARGON2ID: Algorithm = 2;

/**
 * Perfil de coste (referencia 2026).
 *
 * OWASP fija como mínimo m=19 MiB, t=2, p=1. Aquí subimos a 64 MiB y 3 pasadas
 * porque esta aplicación tiene pocos usuarios y logins esporádicos: podemos
 * pagar ~200 ms por intento, que es justo lo que encarece un ataque por
 * diccionario. Si algún día hubiera logins concurrentes masivos, lo primero a
 * revisar es `memoryCost` (cada verificación reserva ese bloque de memoria).
 */
const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2ID,
  /** 64 MiB por hash. Es el parámetro que más encarece el hardware del atacante. */
  memoryCost: 65_536,
  /** Pasadas sobre la memoria. */
  timeCost: 3,
  /** Un solo hilo: el paralelismo forma parte del hash, subirlo cambia el resultado. */
  parallelism: 1,
  /** Bytes de salida antes de codificar en base64. */
  outputLen: 32,
};

/**
 * Hash con los mismos parámetros que el resto, sobre una contraseña que no
 * existe. Sirve para gastar el mismo tiempo cuando el correo no está
 * registrado: sin esto, un login contra un usuario inexistente respondería en
 * microsegundos y el tiempo de respuesta delataría qué correos existen.
 *
 * No es un secreto: es un hash público de una cadena descartada.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$/5Z1DwFWgvc4pFnp+VPWuw$KKc/xT5pM2e0CybLKw/NkMeWC9sr2tlBu5OezNCSwBM";

/** Calcula el hash a guardar en `users.password_hash`. */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Compara la contraseña recibida contra el hash almacenado.
 *
 * Nunca lanza: un hash corrupto o de otro formato cuenta como fallo de
 * autenticación, no como error del servidor. Así un registro dañado no
 * convierte un login en un 500 que revela información.
 */
export async function verifyPassword(
  hashStored: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(hashStored, plain, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Consume el mismo tiempo que una verificación real y siempre falla.
 * Úsalo en el caso de uso de login cuando el correo no existe o el usuario
 * está desactivado, para no filtrar por tiempo qué cuentas existen.
 */
export async function verifyDummyPassword(plain: string): Promise<false> {
  await verifyPassword(DUMMY_HASH, plain);
  return false;
}
