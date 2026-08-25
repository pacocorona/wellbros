"use server";

/**
 * Acciones de /perfil.
 *
 * Reparto de responsabilidades, igual que en el resto del proyecto: la ACCIÓN
 * resuelve la sesión (es la única que puede: `cookies()` solo existe aquí) y
 * el NÚCLEO —`aplicarCambiosDePerfil`, más abajo— recibe el actor y el cliente
 * de Prisma explícitos y no sabe nada de Next. El día que exista `/api/v1`,
 * ese núcleo se expone tal cual y estas funciones se quedan como el envoltorio
 * web que son.
 *
 * Cada acción es un endpoint público: que la página ya haya comprobado la
 * sesión no protege nada aquí dentro. Por eso todas empiezan resolviéndola.
 *
 * El TEMA no se guarda desde aquí. Lo escribe `guardarTema`, la acción del
 * layout raíz que ya usa `ThemeProvider`: el selector de /perfil y el del
 * encabezado comparten ese estado, y duplicar la escritura los desincronizaría
 * (uno de los dos se quedaría enseñando el valor viejo). Es preferencia
 * visual, no hecho auditable: no va a la bitácora.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import { getCurrentSession } from "@/lib/auth";
import type { Db } from "@/lib/db";
import { prisma } from "@/lib/db";
import { changeOwnPassword, isAdminError } from "@/server/admin/users";
import { clientIpFromHeaders } from "@/server/auth/login";

// ═════════════════════════════════════════════════════ contratos

export interface PerfilFormState {
  /** `null` mientras no se haya enviado nada; luego true/false. */
  ok: boolean | null;
  /** Mensaje general, ya redactado en español y apto para mostrarse tal cual. */
  mensaje: string | null;
  /** Errores por campo, para marcar el control con `aria-invalid`. */
  errores: Partial<Record<"fullName" | "phone", string>>;
  /** Lo escrito: vuelve al formulario para no obligar a reteclear tras un fallo. */
  valores: { fullName: string; phone: string };
}

export interface ContrasenaFormState {
  ok: boolean | null;
  mensaje: string | null;
  errores: Partial<
    Record<"currentPassword" | "newPassword" | "confirmPassword", string>
  >;
  /** Sesiones cerradas en OTROS dispositivos. La interfaz lo anuncia. */
  sesionesCerradas: number;
}

// ═════════════════════════════════════════════════════ validación

/**
 * E.164: `+`, país sin ceros a la izquierda y de 8 a 15 dígitos en total.
 * Mismo criterio que `src/server/admin/users.ts`; si cambia allá, cambia aquí.
 */
const TELEFONO_E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Longitud mínima de contraseña. Debe coincidir con la de
 * `changeOwnPassword` (users.ts), que es quien manda de verdad: aquí se
 * valida antes solo para dar un mensaje por campo en vez de uno genérico.
 */
const MIN_CONTRASENA = 12;

const nombreSchema = z
  .string()
  .trim()
  .min(3, "El nombre debe tener al menos 3 caracteres")
  .max(120, "El nombre no puede pasar de 120 caracteres");

/**
 * Teléfono opcional.
 *
 * Se limpian antes espacios, guiones, puntos y paréntesis: «+52 999 123 4567»
 * es lo que la gente teclea y rechazarlo por la separación sería puro
 * pedantismo. Lo que se guarda siempre es E.164 canónico.
 */
const telefonoSchema = z
  .string()
  .trim()
  .transform((valor) => valor.replace(/[\s.()-]/g, ""))
  .transform((valor) => (valor === "" ? null : valor))
  .refine(
    (valor) => valor === null || TELEFONO_E164.test(valor),
    "Escríbelo en formato internacional, p. ej. +5219981234567",
  );

const perfilSchema = z.object({
  fullName: nombreSchema,
  phone: telefonoSchema,
});

const contrasenaSchema = z
  .object({
    currentPassword: z.string().min(1, "Escribe tu contraseña actual"),
    newPassword: z
      .string()
      .min(MIN_CONTRASENA, `Necesita al menos ${MIN_CONTRASENA} caracteres`)
      .max(200, "No puede pasar de 200 caracteres"),
    confirmPassword: z.string().min(1, "Repite la contraseña nueva"),
  })
  .refine((datos) => datos.newPassword === datos.confirmPassword, {
    path: ["confirmPassword"],
    message: "Las dos contraseñas no coinciden",
  })
  .refine((datos) => datos.newPassword !== datos.currentPassword, {
    path: ["newPassword"],
    message: "La contraseña nueva debe ser distinta de la actual",
  });

/**
 * Primer mensaje de cada campo. Con dos errores en el mismo campo basta el
 * primero: la persona corrige uno y vuelve a enviar.
 *
 * El parámetro se describe por su FORMA y no con el tipo de zod: así una
 * subida de versión que renombre `$ZodIssue` no rompe este archivo.
 */
function erroresPorCampo<C extends string>(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  campos: readonly C[],
): Partial<Record<C, string>> {
  const salida: Partial<Record<C, string>> = {};
  for (const issue of issues) {
    const clave = issue.path[0];
    if (typeof clave !== "string") continue;
    const campo = campos.find((c) => c === clave);
    if (campo && salida[campo] === undefined) salida[campo] = issue.message;
  }
  return salida;
}

// ═════════════════════════════════════════════════════ núcleo

export interface PerfilActor {
  id: string;
  email: string;
}

/** Campos que de verdad cambiaron, con el nombre que la persona ve en pantalla. */
const ETIQUETA_CAMPO: Readonly<Record<string, string>> = {
  fullName: "el nombre",
  phone: "el teléfono",
  whatsappOptIn: "los avisos por WhatsApp",
};

/**
 * Escribe el perfil de quien actúa. Puro de framework: recibe el cliente y el
 * actor, jamás los deduce.
 *
 * Devuelve las claves modificadas para que la interfaz pueda decir «guardamos
 * el nombre» en vez de un «listo» que no distingue de un envío sin cambios.
 *
 * NO es `updateUser` de admin/users.ts a propósito: aquella exige SUPERUSER y
 * también toca el rol. Aquí el sujeto es el propio actor y el rol no se roza.
 */
async function aplicarCambiosDePerfil({
  db,
  actor,
  input,
  ip,
}: {
  db: Db;
  actor: PerfilActor;
  input: { fullName: string; phone: string | null };
  ip?: string | null;
}): Promise<{ camposCambiados: string[] }> {
  const actual = await db.user.findUnique({
    where: { id: actor.id },
    select: { id: true, email: true, fullName: true, phone: true, whatsappOptIn: true },
  });
  if (!actual) throw new Error("La cuenta ya no existe.");

  const data: { fullName?: string; phone?: string | null; whatsappOptIn?: boolean } = {};
  const cambios: Record<string, { antes: string | boolean | null; ahora: string | boolean | null }> =
    {};

  if (input.fullName !== actual.fullName) {
    data.fullName = input.fullName;
    cambios.fullName = { antes: actual.fullName, ahora: input.fullName };
  }
  if (input.phone !== actual.phone) {
    data.phone = input.phone;
    cambios.phone = { antes: actual.phone, ahora: input.phone };
  }

  // Sin número no puede haber consentimiento de WhatsApp: dejarlo encendido
  // guardaría un «sí» que no se podría cumplir el día que se active el canal.
  if (input.phone === null && actual.whatsappOptIn) {
    data.whatsappOptIn = false;
    cambios.whatsappOptIn = { antes: true, ahora: false };
  }

  const claves = Object.keys(data);
  if (claves.length === 0) return { camposCambiados: [] };

  // Una sola transacción con el cambio y su anotación: si la bitácora falla,
  // el cambio no queda. Nunca un hecho sin registrar.
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: actual.id }, data, select: { id: true } });

    await writeAudit(tx, {
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: actual.id,
      actorUserId: actual.id,
      ip,
      // `propio: true` distingue en la bitácora una edición de uno mismo de
      // una edición hecha por la superusuaria sobre la cuenta de otro.
      details: { email: actual.email, propio: true, cambios },
    });
  });

  return { camposCambiados: claves };
}

// ═════════════════════════════════════════════════════ acciones

const SESION_CADUCADA = "Tu sesión terminó. Vuelve a entrar para guardar los cambios.";

export async function actualizarPerfilAction(
  _previo: PerfilFormState,
  formData: FormData,
): Promise<PerfilFormState> {
  const fullName = String(formData.get("fullName") ?? "");
  const phone = String(formData.get("phone") ?? "");
  const valores = { fullName, phone };

  const sesion = await getCurrentSession();
  if (!sesion) {
    return { ok: false, mensaje: SESION_CADUCADA, errores: {}, valores };
  }

  const analizado = perfilSchema.safeParse({ fullName, phone });
  if (!analizado.success) {
    return {
      ok: false,
      mensaje: "Revisa los campos marcados.",
      errores: erroresPorCampo(analizado.error.issues, ["fullName", "phone"] as const),
      valores,
    };
  }

  const cabeceras = await headers();

  // El try envuelve SOLO la escritura. Si abarcara también lo de después,
  // un fallo al revalidar se reportaría como «no pudimos guardar» aunque el
  // cambio ya estuviera en la base: el peor mensaje posible.
  let camposCambiados: string[];
  try {
    const resultado = await aplicarCambiosDePerfil({
      db: prisma,
      actor: { id: sesion.user.id, email: sesion.user.email },
      input: analizado.data,
      ip: clientIpFromHeaders(cabeceras),
    });
    camposCambiados = resultado.camposCambiados;
  } catch (error) {
    // El detalle real se queda en el registro del servidor —sin esta línea no
    // quedaba en ninguna parte— y hacia fuera va un mensaje que no filtra nada
    // del estado de la base.
    console.error("[perfil] no se pudo guardar el perfil", error);
    return {
      ok: false,
      mensaje: "No pudimos guardar los cambios. Inténtalo de nuevo.",
      errores: {},
      valores,
    };
  }

  // Valores ya canónicos: si escribió «+52 999 123 4567», el campo debe
  // quedarse enseñando lo que de verdad se guardó.
  const guardados = {
    fullName: analizado.data.fullName,
    phone: analizado.data.phone ?? "",
  };

  if (camposCambiados.length === 0) {
    return { ok: true, mensaje: "No había nada que cambiar.", errores: {}, valores: guardados };
  }

  // "layout" y no "page": el nombre también se pinta en la barra superior,
  // que vive en el layout del grupo autenticado.
  revalidatePath("/perfil", "layout");

  const nombres = camposCambiados.map((c) => ETIQUETA_CAMPO[c] ?? c);
  const lista =
    nombres.length === 1
      ? nombres[0]
      : `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;

  return { ok: true, mensaje: `Guardamos ${lista}.`, errores: {}, valores: guardados };
}

export async function cambiarContrasenaAction(
  _previo: ContrasenaFormState,
  formData: FormData,
): Promise<ContrasenaFormState> {
  const entrada = {
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  };

  const sesion = await getCurrentSession();
  if (!sesion) {
    return { ok: false, mensaje: SESION_CADUCADA, errores: {}, sesionesCerradas: 0 };
  }

  const analizado = contrasenaSchema.safeParse(entrada);
  if (!analizado.success) {
    return {
      ok: false,
      mensaje: "Revisa los campos marcados.",
      errores: erroresPorCampo(analizado.error.issues, [
        "currentPassword",
        "newPassword",
        "confirmPassword",
      ] as const),
      sesionesCerradas: 0,
    };
  }

  const cabeceras = await headers();

  try {
    const { sessionsClosed } = await changeOwnPassword({
      db: prisma,
      actor: sesion.user,
      currentPassword: analizado.data.currentPassword,
      newPassword: analizado.data.newPassword,
      // La sesión de este navegador sobrevive: cambiar la contraseña no debe
      // echar a la persona de la pantalla en la que está.
      keepSessionId: sesion.sessionId,
      ip: clientIpFromHeaders(cabeceras),
    });

    return {
      ok: true,
      mensaje:
        sessionsClosed > 0
          ? `Contraseña cambiada. Cerramos ${sessionsClosed} ${
              sessionsClosed === 1 ? "sesión abierta" : "sesiones abiertas"
            } en otros dispositivos; esta sigue activa.`
          : "Contraseña cambiada. No había sesiones abiertas en otros dispositivos.",
      errores: {},
      sesionesCerradas: sessionsClosed,
    };
  } catch (error) {
    if (isAdminError(error) && error.code === "WRONG_PASSWORD") {
      return {
        ok: false,
        mensaje: null,
        errores: { currentPassword: "La contraseña actual no es correcta" },
        sesionesCerradas: 0,
      };
    }
    if (isAdminError(error) && error.code === "INVALID_INPUT") {
      return {
        ok: false,
        mensaje: error.message,
        errores: {},
        sesionesCerradas: 0,
      };
    }
    return {
      ok: false,
      mensaje: "No pudimos cambiar la contraseña. Inténtalo de nuevo.",
      errores: {},
      sesionesCerradas: 0,
    };
  }
}
