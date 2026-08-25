"use server";

/**
 * Server Actions de administración: la capa DELGADA entre las pantallas de
 * /config y los servicios de `src/server/admin/**`.
 *
 * Cada acción hace exactamente cuatro cosas y ninguna más:
 *   1. resuelve la sesión con `requireSuperuser()` —aquí, arriba, nunca dentro
 *      del servicio— y arma el `AdminActor`;
 *   2. delega en el servicio, que es quien valida y escribe;
 *   3. `revalidatePath` de lo que quedó desactualizado;
 *   4. traduce cualquier fallo a un resultado TIPADO.
 *
 * Por qué la comprobación de rol se repite aquí aunque el servicio ya la haga:
 * una Server Action es un endpoint público (un POST contra la ruta que la
 * renderizó). Que la página exija superusuaria no protege a la acción, y que la
 * acción lo exija no protege al servicio si mañana lo llama `/api/v1`. Las dos
 * puertas son la misma cerradura vista desde lados distintos.
 *
 * NUNCA sale un error crudo hacia el cliente: `Resultado` lleva un código
 * estable y un mensaje ya redactado en español. Lo inesperado se registra en el
 * servidor y se responde con una frase genérica; un `message` de Prisma puede
 * llevar dentro nombres de columna, valores de otra fila o la consulta entera.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import type { UserRole } from "@/generated/prisma/enums";
import { isAuthError, requireSuperuser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { PropertyColor } from "@/lib/property-color";
import {
  createMaintenanceNote,
  deleteMaintenanceNote,
  updateMaintenanceNote,
  type MaintenanceNoteRow,
} from "@/server/admin/maintenance";
import {
  createProperty,
  setPropertyActive,
  updateProperty,
  type PropertyRow,
  type SetPropertyActiveResult,
} from "@/server/admin/properties";
import {
  closeWeek,
  openWeeks,
  reopenWeek,
  type CloseWeekResult,
  type OpenWeeksResult,
  type ReopenWeekResult,
} from "@/server/admin/slots";
import {
  AdminError,
  createUser,
  etiquetaSemana,
  fechaCivil,
  hoyDeNegocio,
  isAdminError,
  isoDeFecha,
  setUserActive,
  updateUser,
  type AdminActor,
  type AdminErrorCode,
  type AdminUserRow,
  type FutureReservationRef,
  type SetUserActiveResult,
} from "@/server/admin/users";
import { clientIpFromHeaders } from "@/server/auth/login";

// ═════════════════════════════════════════════════ contrato de salida

/**
 * Códigos que puede devolver una acción. Los de negocio vienen tal cual del
 * servicio; los tres últimos los pone esta capa.
 */
export type CodigoFallo =
  | AdminErrorCode
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "UNEXPECTED";

/**
 * Resultado discriminado: la interfaz hace `if (!r.ok)` y muestra `r.message`
 * sin tener que adivinar nada. Se prefiere esto a lanzar excepciones porque un
 * throw dentro de una Server Action llega al cliente como un error genérico de
 * React —sin mensaje útil— o, peor, revienta el árbol con un error boundary.
 */
export type Resultado<T> =
  | { ok: true; data: T }
  | { ok: false; code: CodigoFallo; message: string };

const MENSAJE_INESPERADO =
  "No pudimos completar la operación. Vuelve a intentarlo en un momento.";

const RUTA_USUARIOS = "/config/usuarios";
const RUTA_PROPIEDADES = "/config/propiedades";
/** El calendario cambia cuando cambian propiedades, semanas o mantenimiento. */
const RUTA_CALENDARIO = "/";

// ═════════════════════════════════════════════════════════ andamiaje

interface Contexto {
  actor: AdminActor;
  ip: string | null;
}

/**
 * Envoltura común: sesión, actor, ip y traducción de errores.
 *
 * `revalidatePath` se deja en manos de cada acción (y no aquí) porque las rutas
 * afectadas dependen de lo que se tocó, y revalidar de más obliga al navegador
 * a rehacer pantallas que no cambiaron.
 */
async function ejecutar<T>(
  operacion: (ctx: Contexto) => Promise<T>,
): Promise<Resultado<T>> {
  try {
    const usuario = await requireSuperuser();
    const cabeceras = await headers();

    const datos = await operacion({
      actor: {
        id: usuario.id,
        role: usuario.role,
        fullName: usuario.fullName,
        email: usuario.email,
      },
      ip: clientIpFromHeaders(cabeceras),
    });

    return { ok: true, data: datos };
  } catch (error) {
    return traducirFallo(error);
  }
}

function traducirFallo(error: unknown): { ok: false; code: CodigoFallo; message: string } {
  if (isAdminError(error)) {
    // El mensaje del servicio ya viene en español y pensado para leerse.
    return { ok: false, code: error.code, message: error.message };
  }

  if (isAuthError(error)) {
    return error.code === "UNAUTHENTICATED"
      ? {
          ok: false,
          code: "UNAUTHENTICATED",
          message: "Tu sesión terminó. Vuelve a entrar.",
        }
      : {
          ok: false,
          code: "FORBIDDEN",
          message: "No tienes permiso para esta acción.",
        };
  }

  // Lo que llegue aquí es un fallo nuestro (Prisma, red, un bug): queda en el
  // registro del servidor con su traza y hacia fuera va una frase neutra.
  console.error("[admin-actions] fallo no contemplado", error);
  return { ok: false, code: "UNEXPECTED", message: MENSAJE_INESPERADO };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guarda para los identificadores que el servicio de destino NO valida.
 *
 * Sin esto, un id mal formado llega a PostgreSQL y vuelve como error de sintaxis
 * de uuid: un `UNEXPECTED` con traza en el registro por lo que en realidad es
 * una entrada inválida.
 */
function exigirUuid(valor: string, queEs: string): string {
  if (!UUID.test(valor)) {
    throw new AdminError("INVALID_INPUT", `El identificador de ${queEs} no es válido.`);
  }
  return valor;
}

// ═════════════════════════════════════════════════════════ usuarios

export interface EntradaCrearUsuario {
  email: string;
  fullName: string;
  phone?: string | null;
  whatsappOptIn?: boolean;
  role?: UserRole;
}

export interface CrearUsuarioSalida {
  user: AdminUserRow;
  /**
   * Contraseña temporal en claro. Viaja UNA vez, en esta respuesta, para que la
   * superusuaria la copie y la entregue por un canal seguro. No se guarda ni se
   * envía por correo.
   */
  temporaryPassword: string | null;
}

/**
 * Alta de usuario con contraseña temporal.
 *
 * La entrega por invitación (`InvitationDelivery` en el servicio) NO se ofrece:
 * exige un identificador y una ruta con token de alta, y en el modelo de datos
 * todavía no existe tabla de invitaciones que los emita ni pantalla que los
 * canjee. Construir aquí un enlace inventado mandaría un correo con una promesa
 * que no lleva a ninguna parte. Ver el resumen de la tarea.
 */
export async function crearUsuarioAction(
  entrada: EntradaCrearUsuario,
): Promise<Resultado<CrearUsuarioSalida>> {
  return ejecutar(async ({ actor, ip }) => {
    const resultado = await createUser({
      db: prisma,
      actor,
      ip,
      input: {
        email: entrada.email,
        fullName: entrada.fullName,
        phone: entrada.phone ?? null,
        whatsappOptIn: entrada.whatsappOptIn ?? false,
        role: entrada.role ?? "USER",
        // Deliberadamente sin `invitation`: aceptar una ruta que viene del
        // cliente sería dejar que quien haga el POST decida a dónde apunta el
        // enlace del correo de alta.
      },
    });

    revalidatePath(RUTA_USUARIOS);
    // También el calendario: la cuenta nueva tiene que aparecer en el combo de
    // destinatarios de «ceder días».
    revalidatePath(RUTA_CALENDARIO);

    return {
      user: resultado.user,
      temporaryPassword: resultado.temporaryPassword ?? null,
    };
  });
}

export interface EntradaActualizarUsuario {
  fullName?: string;
  phone?: string | null;
  role?: UserRole;
  whatsappOptIn?: boolean;
}

/** Edita nombre, teléfono, rol y consentimiento. El correo no se toca. */
export async function actualizarUsuarioAction(
  userId: string,
  entrada: EntradaActualizarUsuario,
): Promise<Resultado<AdminUserRow>> {
  return ejecutar(async ({ actor, ip }) => {
    const fila = await updateUser({
      db: prisma,
      actor,
      ip,
      userId: exigirUuid(userId, "usuario"),
      input: entrada,
    });

    revalidatePath(RUTA_USUARIOS);
    // El nombre de quien reserva sale en el calendario de todos.
    revalidatePath(RUTA_CALENDARIO);

    return fila;
  });
}

/**
 * Activa o desactiva una cuenta.
 *
 * Las reservas futuras NO se cancelan: el servicio las devuelve para que la
 * pantalla las muestre y la superusuaria decida qué hacer con cada una.
 */
export async function cambiarActivacionUsuarioAction(
  userId: string,
  isActive: boolean,
  motivo?: string,
): Promise<Resultado<SetUserActiveResult>> {
  return ejecutar(async ({ actor, ip }) => {
    const resultado = await setUserActive({
      db: prisma,
      actor,
      ip,
      userId: exigirUuid(userId, "usuario"),
      isActive,
      reason: motivo?.trim() ? motivo.trim() : undefined,
    });

    revalidatePath(RUTA_USUARIOS);
    revalidatePath(RUTA_CALENDARIO);

    return resultado;
  });
}

/**
 * Reservas ACTIVE de una persona cuya semana todavía no termina.
 *
 * Es una LECTURA y vive aquí solo porque `src/server/admin/users.ts` mantiene
 * su equivalente (`reservasFuturasDe`) como función privada: sin ella, el
 * diálogo de baja tendría que desactivar primero para poder avisar después, que
 * es justo al revés de lo que pide el producto. Para el integrador: mudar esto
 * a `listFutureReservations()` en el servicio y borrar la copia.
 */
export async function listarReservasFuturasAction(
  userId: string,
): Promise<Resultado<FutureReservationRef[]>> {
  return ejecutar(async () => {
    const id = exigirUuid(userId, "usuario");
    const hoy = fechaCivil(hoyDeNegocio());

    const filas = await prisma.reservation.findMany({
      where: {
        userId: id,
        status: "ACTIVE",
        // `endDate` y no `startDate`: la semana en curso sigue en uso.
        slot: { endDate: { gte: hoy } },
      },
      select: {
        id: true,
        slot: {
          select: {
            id: true,
            startDate: true,
            endDate: true,
            property: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { slot: { startDate: "asc" } },
    });

    return filas.map((r) => {
      const inicio = isoDeFecha(r.slot.startDate);
      const fin = isoDeFecha(r.slot.endDate);
      return {
        reservationId: r.id,
        slotId: r.slot.id,
        propertyId: r.slot.property.id,
        propertyName: r.slot.property.name,
        startDate: inicio,
        endDate: fin,
        label: etiquetaSemana(inicio, fin),
      };
    });
  });
}

// ══════════════════════════════════════════════════════ propiedades

/**
 * Alta de propiedad.
 *
 * El `color` es opcional y su tipo aquí es una AYUDA, no una garantía: una
 * Server Action es un endpoint público y lo que llega puede ser cualquier cosa.
 * Por eso no se comprueba en esta capa —sería una comprobación que se puede
 * saltar— sino en el servicio, que traduce un color inválido a INVALID_INPUT.
 * Sin color, el servicio elige uno que no esté en uso.
 */
export async function crearPropiedadAction(
  nombre: string,
  color?: PropertyColor,
): Promise<Resultado<PropertyRow>> {
  return ejecutar(async ({ actor, ip }) => {
    const fila = await createProperty({
      db: prisma,
      actor,
      ip,
      name: nombre,
      color: color ?? null,
    });

    revalidatePath(RUTA_PROPIEDADES);
    // El combo del calendario se alimenta de esta lista.
    revalidatePath(RUTA_CALENDARIO);

    return fila;
  });
}

/**
 * Edita nombre y color.
 *
 * Antes se llamaba «renombrar»: ahora el color viaja con el nombre en el mismo
 * diálogo y en la misma escritura, así que un solo viaje deja las dos cosas
 * guardadas —o ninguna— y la bitácora anota un único cambio en vez de dos.
 * Omitir `color` deja el que ya tenía.
 */
export async function actualizarPropiedadAction(
  propertyId: string,
  nombre: string,
  color?: PropertyColor,
): Promise<Resultado<PropertyRow>> {
  return ejecutar(async ({ actor, ip }) => {
    const fila = await updateProperty({
      db: prisma,
      actor,
      ip,
      propertyId: exigirUuid(propertyId, "propiedad"),
      name: nombre,
      color: color ?? null,
    });

    revalidatePath(RUTA_PROPIEDADES);
    revalidatePath(RUTA_CALENDARIO);

    return fila;
  });
}

/**
 * Enciende o apaga una propiedad. Apagarla la saca del calendario pero no
 * cancela nada: el resultado trae el recuento de lo que quedó vivo.
 */
export async function cambiarActivacionPropiedadAction(
  propertyId: string,
  isActive: boolean,
): Promise<Resultado<SetPropertyActiveResult>> {
  return ejecutar(async ({ actor, ip }) => {
    const resultado = await setPropertyActive({
      db: prisma,
      actor,
      ip,
      propertyId: exigirUuid(propertyId, "propiedad"),
      isActive,
    });

    revalidatePath(RUTA_PROPIEDADES);
    revalidatePath(RUTA_CALENDARIO);

    return resultado;
  });
}

// ════════════════════════════════════════════════════════ semanas

/**
 * Abre en lote todos los viernes de `[desde, hasta]`.
 *
 * Es idempotente: los viernes que ya existían se cuentan en `alreadyOpen` y no
 * producen error, de modo que repetir el rango por accidente no rompe nada.
 */
export async function abrirSemanasAction(
  propertyId: string,
  desde: string,
  hasta: string,
): Promise<Resultado<OpenWeeksResult>> {
  return ejecutar(async ({ actor, ip }) => {
    const resultado = await openWeeks({
      db: prisma,
      actor,
      ip,
      propertyId,
      from: desde,
      to: hasta,
    });

    revalidatePath(RUTA_PROPIEDADES);
    revalidatePath(RUTA_CALENDARIO);

    return resultado;
  });
}

/**
 * Cierra una semana.
 *
 * Sin `forzar`, una semana con reserva ACTIVA devuelve
 * `SLOT_HAS_ACTIVE_RESERVATION` y no se toca nada: la pantalla usa ese código
 * para pedir confirmación explícita y motivo antes de volver a llamar. El
 * motivo es obligatorio en ese caso y queda en la bitácora con el retrato
 * completo de la reserva cancelada.
 */
export async function cerrarSemanaAction(
  slotId: string,
  opciones?: { forzar?: boolean; motivo?: string },
): Promise<Resultado<CloseWeekResult>> {
  return ejecutar(async ({ actor, ip }) => {
    const resultado = await closeWeek({
      db: prisma,
      actor,
      ip,
      slotId,
      force: opciones?.forzar ?? false,
      reason: opciones?.motivo?.trim() ? opciones.motivo.trim() : undefined,
    });

    revalidatePath(RUTA_PROPIEDADES);
    revalidatePath(RUTA_CALENDARIO);

    return resultado;
  });
}

/** CLOSED → OPEN. La semana vuelve al calendario con su ventana de siempre. */
export async function reabrirSemanaAction(
  slotId: string,
): Promise<Resultado<ReopenWeekResult>> {
  return ejecutar(async ({ actor, ip }) => {
    const resultado = await reopenWeek({ db: prisma, actor, ip, slotId });

    revalidatePath(RUTA_PROPIEDADES);
    revalidatePath(RUTA_CALENDARIO);

    return resultado;
  });
}

// ═══════════════════════════════════════════════════ mantenimiento

export async function crearNotaMantenimientoAction(entrada: {
  propertyId: string;
  startDate: string;
  endDate: string;
  note: string;
}): Promise<Resultado<MaintenanceNoteRow>> {
  return ejecutar(async ({ actor, ip }) => {
    const fila = await createMaintenanceNote({
      db: prisma,
      actor,
      ip,
      propertyId: entrada.propertyId,
      startDate: entrada.startDate,
      endDate: entrada.endDate,
      note: entrada.note,
    });

    revalidatePath(RUTA_PROPIEDADES);
    // Las notas se ven en el calendario de todo el mundo.
    revalidatePath(RUTA_CALENDARIO);

    return fila;
  });
}

export async function actualizarNotaMantenimientoAction(
  noteId: string,
  entrada: { startDate?: string; endDate?: string; note?: string },
): Promise<Resultado<MaintenanceNoteRow>> {
  return ejecutar(async ({ actor, ip }) => {
    const fila = await updateMaintenanceNote({
      db: prisma,
      actor,
      ip,
      noteId: exigirUuid(noteId, "nota"),
      input: entrada,
    });

    revalidatePath(RUTA_PROPIEDADES);
    revalidatePath(RUTA_CALENDARIO);

    return fila;
  });
}

/** La nota se borra de verdad: es la única entidad del modelo sin historia. */
export async function borrarNotaMantenimientoAction(
  noteId: string,
): Promise<Resultado<MaintenanceNoteRow>> {
  return ejecutar(async ({ actor, ip }) => {
    const fila = await deleteMaintenanceNote({
      db: prisma,
      actor,
      ip,
      noteId: exigirUuid(noteId, "nota"),
    });

    revalidatePath(RUTA_PROPIEDADES);
    revalidatePath(RUTA_CALENDARIO);

    return fila;
  });
}
