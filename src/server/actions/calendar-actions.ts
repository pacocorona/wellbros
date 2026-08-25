"use server";

/**
 * Server Actions del calendario.
 *
 * Son la ÚNICA capa que conoce a la vez la sesión (cookies) y los servicios de
 * negocio. Su trabajo es exactamente tres cosas y ninguna más:
 *
 *   1. resolver quién actúa con `requireUser()`;
 *   2. validar la forma de lo que llega —una Server Action es un endpoint
 *      público: cualquiera puede llamarla con el cuerpo que se le antoje—;
 *   3. delegar en `@/server/**` y traducir el resultado a algo que el cliente
 *      pueda pintar.
 *
 * La regla que no se rompe: NUNCA se lanza el error crudo al cliente. Un
 * `throw` dentro de una Server Action llega al navegador como "An error
 * occurred in the Server Components render" y, en producción, sin mensaje
 * alguno. Por eso todas devuelven un resultado TIPADO `{ ok }` y el catch de
 * abajo es el único sitio donde un error inesperado toca la consola del
 * servidor.
 *
 * Sobre `revalidatePath("/")`: el calendario vive en la raíz (el grupo (app) no
 * añade segmento). Next re-renderiza la ruta en el MISMO viaje de la acción y
 * devuelve el payload nuevo junto con el resultado, así que el cliente no
 * necesita pedir un refresco extra cuando la operación sale bien.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import {
  isAuthError,
  requireSuperuser,
  requireUser,
  type SessionUser,
} from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createMaintenanceNotesForDays } from "@/server/admin/maintenance";
import { isAdminError } from "@/server/admin/users";
import { clientIpFromHeaders } from "@/server/auth/login";
import { createDayGrants, isGrantError, revokeDayGrants } from "@/server/grants";
import {
  cancelReservation,
  createReservation,
  isReservationError,
} from "@/server/reservations";

/* -------------------------------------------------------------------------- */
/* Resultado                                                                   */
/* -------------------------------------------------------------------------- */

export interface AccionOk<T> {
  ok: true;
  datos: T;
}

export interface AccionFallo {
  ok: false;
  /**
   * Código estable. Vale el del error de negocio (`SLOT_TAKEN`,
   * `DAY_ALREADY_GRANTED`, …) o uno de los de esta capa. El cliente decide con
   * él, no con el texto: los textos se corrigen y las tildes se mueven.
   */
  code: string;
  /** Mensaje ya listo para enseñar, en español y sin jerga. */
  message: string;
}

export type Resultado<T> = AccionOk<T> | AccionFallo;

export interface ReservaCreada {
  reservationId: string;
  startDate: string;
  endDate: string;
  /** Se tomó saltándose la ventana (solo la superusuaria, con motivo). */
  windowOverride: boolean;
}

export interface ReservaCancelada {
  reservationId: string;
  /** Cesiones que cayeron en cascada; el aviso lo dice y la interfaz también. */
  cesionesCanceladas: number;
}

export interface CesionHecha {
  granteeName: string;
  /** Días efectivamente cedidos. */
  dias: string[];
}

export interface CesionRetirada {
  dias: string[];
}

export interface MantenimientoCreado {
  /**
   * Una nota por TRAMO CONTINUO de los días elegidos: si se marcaron el sábado
   * y el martes, aquí vienen dos. La interfaz lo dice en el aviso para que
   * nadie se sorprenda al ver dos entradas en Configuración → Propiedades.
   */
  notas: { id: string; startDate: string; endDate: string }[];
  /** Días marcados, ya sin repetidos y en orden. */
  dias: string[];
}

/* -------------------------------------------------------------------------- */
/* Validación de entrada                                                       */
/* -------------------------------------------------------------------------- */

const uuid = z.uuid("Identificador inválido.");
const fechaISO = z.iso.date("Fecha inválida.");

/** Una semana son 7 días: más de 7 fechas no es un lote, es un error o un abuso. */
const diasDeUnaSemana = z.array(fechaISO).min(1).max(7);

const esquemaReservar = z.object({
  slotId: uuid,
  motivoExcepcion: z.string().trim().max(500).optional(),
});

const esquemaCancelar = z.object({
  reservationId: uuid,
  motivo: z.string().trim().max(500).optional(),
});

const esquemaCeder = z.object({
  reservationId: uuid,
  granteeUserId: uuid,
  dates: diasDeUnaSemana,
});

const esquemaRevocar = z.object({
  reservationId: uuid,
  dates: diasDeUnaSemana,
});

const esquemaMantenimiento = z.object({
  propertyId: uuid,
  // El selector de fichas ya limita a una semana; que las fechas caigan de
  // verdad dentro de ella lo revalida el servicio, no esta capa.
  fechas: diasDeUnaSemana,
  nota: z
    .string()
    .trim()
    .min(3, "La nota necesita al menos 3 caracteres.")
    .max(500, "La nota no puede pasar de 500 caracteres."),
});

/* -------------------------------------------------------------------------- */
/* Utilidades comunes                                                          */
/* -------------------------------------------------------------------------- */

interface Contexto {
  actor: SessionUser;
  ip: string | null;
}

/**
 * Sesión + origen de la petición.
 *
 * La sesión se resuelve AQUÍ y no dentro de los servicios: ese es justo el
 * corte que permite que `@/server/reservations` y `@/server/grants` se expongan
 * mañana por /api/v1 sin arrastrar `next/headers`.
 */
async function contexto(): Promise<Contexto> {
  const actor = await requireUser();
  return { actor, ip: clientIpFromHeaders(await headers()) };
}

/**
 * Igual que `contexto()`, pero exigiendo rol de superusuaria.
 *
 * La puerta se cierra AQUÍ además de dentro del servicio: una Server Action es
 * un endpoint público —un POST contra la ruta que la renderizó—, así que que el
 * calendario solo pinte el botón para ella no protege nada. Un USER normal que
 * llame a mano recibe FORBIDDEN antes de tocar la base.
 */
async function contextoSuperusuaria(): Promise<Contexto> {
  const actor = await requireSuperuser();
  return { actor, ip: clientIpFromHeaders(await headers()) };
}

const FALLO_ENTRADA: AccionFallo = {
  ok: false,
  code: "ENTRADA_INVALIDA",
  message: "Esa petición no es válida. Recarga la página y vuelve a intentarlo.",
};

/**
 * Traduce cualquier cosa que se haya lanzado a un fallo presentable.
 *
 * Los errores de negocio ya traen su mensaje escrito para el usuario final
 * (ver RESERVATION_ERROR_MESSAGES y los textos de GrantError), así que se pasan
 * tal cual. Lo demás se registra en el servidor y sale como un mensaje genérico:
 * un fallo de conexión a la base no tiene por qué contarle a nadie cómo se llama
 * nuestra tabla.
 */
function traducirError(error: unknown): AccionFallo {
  if (isAuthError(error)) {
    // 401 y 403 no son lo mismo y no se arreglan igual: a quien perdió la
    // sesión hay que mandarlo a entrar; a quien no le alcanza el rol, no.
    return error.code === "UNAUTHENTICATED"
      ? {
          ok: false,
          code: "NO_AUTENTICADO",
          message: "Tu sesión terminó. Vuelve a entrar para continuar.",
        }
      : {
          ok: false,
          code: "SIN_PERMISO",
          message: "No tienes permiso para esta acción.",
        };
  }
  if (isReservationError(error)) {
    return { ok: false, code: error.code, message: error.message };
  }
  if (isGrantError(error)) {
    return { ok: false, code: error.code, message: error.message };
  }
  // Los servicios de administración (las notas de mantenimiento) hablan con
  // `AdminError`, y su mensaje ya viene escrito para el usuario final.
  if (isAdminError(error)) {
    return { ok: false, code: error.code, message: error.message };
  }

  console.error("[calendario] error inesperado en una acción", error);
  return {
    ok: false,
    code: "ERROR_INESPERADO",
    message: "Algo salió mal de nuestro lado. Vuelve a intentarlo en un momento.",
  };
}

/* -------------------------------------------------------------------------- */
/* Reservar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Toma una semana para quien está en sesión.
 *
 * `motivoExcepcion` solo tiene efecto para la superusuaria y solo cuando la
 * semana está fuera de la ventana de apertura; el servicio lo revalida con el
 * reloj del SERVIDOR dentro de la transacción y deja la excepción en la
 * bitácora (RESERVATION_OUT_OF_WINDOW). Que aquí llegue un motivo no concede
 * ningún permiso: si quien lo manda no es la superusuaria, el servicio lo
 * rechaza igual.
 */
export async function reservarSemana(entrada: {
  slotId: string;
  motivoExcepcion?: string;
}): Promise<Resultado<ReservaCreada>> {
  const validada = esquemaReservar.safeParse(entrada);
  if (!validada.success) return FALLO_ENTRADA;

  try {
    const { actor, ip } = await contexto();
    const motivo = validada.data.motivoExcepcion;

    const reserva = await createReservation({
      db: prisma,
      slotId: validada.data.slotId,
      actor,
      override: motivo ? { reason: motivo } : null,
      ip,
    });

    revalidatePath("/");

    return {
      ok: true,
      datos: {
        reservationId: reserva.reservationId,
        startDate: reserva.startDate,
        endDate: reserva.endDate,
        windowOverride: reserva.windowOverride,
      },
    };
  } catch (error) {
    return traducirError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Cancelar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cancela una reserva. Solo el dueño o la superusuaria; lo comprueba el
 * servicio, no esta capa.
 *
 * El motivo es OBLIGATORIO cuando se cancela la reserva de otra persona, y se
 * exige aquí además de en la interfaz: ocultar el campo en pantalla no impide
 * llamar a la acción sin él, y una cancelación ajena sin explicación es
 * exactamente lo que la bitácora existe para evitar.
 */
export async function cancelarReserva(entrada: {
  reservationId: string;
  motivo?: string;
}): Promise<Resultado<ReservaCancelada>> {
  const validada = esquemaCancelar.safeParse(entrada);
  if (!validada.success) return FALLO_ENTRADA;

  try {
    const { actor, ip } = await contexto();
    const motivo = validada.data.motivo?.trim() || null;

    // Lectura barata (una fila por clave primaria) para poder exigir el motivo
    // antes de tocar nada. Si la reserva no existe se deja pasar: el servicio
    // devolverá RESERVATION_NOT_FOUND, que es el mensaje correcto.
    const reserva = await prisma.reservation.findUnique({
      where: { id: validada.data.reservationId },
      select: { userId: true },
    });
    if (reserva && reserva.userId !== actor.id && motivo === null) {
      return {
        ok: false,
        code: "MOTIVO_REQUERIDO",
        message:
          "Cancelar la reserva de otra persona exige escribir un motivo: quedará en la bitácora.",
      };
    }

    const cancelada = await cancelReservation({
      db: prisma,
      reservationId: validada.data.reservationId,
      actor,
      reason: motivo,
      ip,
    });

    revalidatePath("/");

    return {
      ok: true,
      datos: {
        reservationId: cancelada.reservationId,
        cesionesCanceladas: cancelada.cancelledGrants.length,
      },
    };
  } catch (error) {
    return traducirError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Ceder y revocar días                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Cede días de una semana propia. Sin aceptación del receptor (§06).
 *
 * No se pasa `timeZone`: el servicio usa la zona de negocio por omisión
 * (America/Mexico_City), que es la misma de la política vigente. Si algún día
 * una propiedad tuviera otra zona, habría que resolverla aquí y pasarla.
 */
export async function cederDias(entrada: {
  reservationId: string;
  granteeUserId: string;
  dates: string[];
}): Promise<Resultado<CesionHecha>> {
  const validada = esquemaCeder.safeParse(entrada);
  if (!validada.success) return FALLO_ENTRADA;

  try {
    const { actor, ip } = await contexto();

    const resultado = await createDayGrants({
      db: prisma,
      reservationId: validada.data.reservationId,
      actor,
      granteeUserId: validada.data.granteeUserId,
      dates: validada.data.dates,
      ip,
    });

    revalidatePath("/");

    return {
      ok: true,
      datos: {
        granteeName: resultado.grants[0]?.granteeName ?? "",
        dias: resultado.grants.map((g) => g.date),
      },
    };
  } catch (error) {
    return traducirError(error);
  }
}

/** Retira días cedidos que todavía no han transcurrido. */
export async function revocarDias(entrada: {
  reservationId: string;
  dates: string[];
}): Promise<Resultado<CesionRetirada>> {
  const validada = esquemaRevocar.safeParse(entrada);
  if (!validada.success) return FALLO_ENTRADA;

  try {
    const { actor, ip } = await contexto();

    const resultado = await revokeDayGrants({
      db: prisma,
      reservationId: validada.data.reservationId,
      actor,
      dates: validada.data.dates,
      ip,
    });

    revalidatePath("/");

    return { ok: true, datos: { dias: resultado.grants.map((g) => g.date) } };
  } catch (error) {
    return traducirError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Mantenimiento desde el calendario                                           */
/* -------------------------------------------------------------------------- */

/**
 * Atajo de la superusuaria: marcar días de una semana y anotarles mantenimiento
 * sin salir del calendario.
 *
 * No sustituye a Configuración → Propiedades, que sigue siendo donde se editan
 * y se borran las notas. Y no bloquea nada: las notas son informativas (§05),
 * así que esta acción puede caer sobre CUALQUIER semana —pasada, cerrada,
 * programada o sin apertura—, que es justo donde suele haber obra.
 *
 * Los días no contiguos producen VARIAS notas, una por tramo continuo; el
 * porqué está en `agruparDiasEnRangos`.
 */
export async function crearMantenimientoDesdeCalendarioAction(
  propertyId: string,
  fechas: string[],
  nota: string,
): Promise<Resultado<MantenimientoCreado>> {
  const validada = esquemaMantenimiento.safeParse({ propertyId, fechas, nota });
  if (!validada.success) return FALLO_ENTRADA;

  try {
    const { actor, ip } = await contextoSuperusuaria();

    const notas = await createMaintenanceNotesForDays({
      db: prisma,
      actor,
      propertyId: validada.data.propertyId,
      dates: validada.data.fechas,
      note: validada.data.nota,
      ip,
    });

    revalidatePath("/");
    // La misma nota aparece en la gestión de la propiedad: si no se revalida,
    // ahí seguiría faltando hasta el siguiente refresco completo.
    revalidatePath("/config/propiedades");

    return {
      ok: true,
      datos: {
        notas: notas.map((n) => ({
          id: n.id,
          startDate: n.startDate,
          endDate: n.endDate,
        })),
        dias: [...new Set(validada.data.fechas)].sort(),
      },
    };
  } catch (error) {
    return traducirError(error);
  }
}
