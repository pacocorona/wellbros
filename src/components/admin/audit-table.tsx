"use client";

/**
 * Bitácora, en cristiano.
 *
 * La tabla `audit_log` guarda un snapshot JSON por evento. Volcarlo tal cual
 * sería fiel pero ilegible: quien abre esta pantalla —una sola persona, la
 * superusuaria— quiere leer «Ivonne canceló la reserva de Marta», no un
 * objeto con doce claves. Así que aquí se hacen dos cosas y en este orden:
 *
 *   1. Cada entrada se traduce a UNA frase en español (`describir`).
 *   2. El JSON crudo queda intacto detrás de un desplegable, porque la frase
 *      es una interpretación y la evidencia es el snapshot.
 *
 * La traducción es DEFENSIVA a propósito: `details` es JSON libre y esta
 * pantalla debe seguir leyéndose dentro de dos años, cuando alguna clave haya
 * cambiado de nombre o una acción nueva no tenga aún su frase. Nunca se
 * confía en que una clave exista; si falta, la frase se degrada y el
 * desplegable sigue teniendo la verdad completa.
 *
 * Cuando el snapshot ya trae una etiqueta redactada (`weekLabel`, `rango`) se
 * prefiere a recalcularla: es lo que se escribió el día del hecho.
 */

import { useState, useTransition } from "react";
import { AlertTriangle, ChevronDown, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditEntryRow, AuditPage } from "@/server/admin/audit-queries";
import { cn } from "@/lib/utils";

// ═══════════════════════════════════════════════ fechas y nombres

/** Zona de negocio. La bitácora se lee en hora de México, no en UTC. */
const ZONA = "America/Mexico_City";

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

const MESES_CORTOS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Se piden PARTES numéricas y la frase se arma a mano.
 *
 * `dateStyle`/`timeStyle` producen texto que cambia entre versiones de ICU, y
 * este componente se pinta primero en el servidor (Node) y luego se hidrata en
 * el navegador: cualquier diferencia entre los dos ICU sería un desajuste de
 * hidratación. Un número es un número en todas partes.
 */
const RELOJ = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONA,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  // h23 y no `hour12: false`: este último devuelve "24" a medianoche en
  // algunas implementaciones.
  hourCycle: "h23",
});

function marcaDeTiempo(valor: Date): { dia: string; hora: string } {
  const partes: Record<string, string> = {};
  for (const parte of RELOJ.formatToParts(new Date(valor))) {
    partes[parte.type] = parte.value;
  }

  const mes = MESES_CORTOS[Number(partes.month) - 1] ?? "";
  return {
    dia: `${Number(partes.day)} ${mes} ${partes.year}`,
    hora: `${(partes.hour ?? "").padStart(2, "0")}:${partes.minute ?? ""}`,
  };
}

/**
 * `yyyy-MM-dd` → `Date` en UTC. Las fechas de semana son fechas civiles, no
 * instantes: interpretarlas en la hora local del navegador correría el día.
 */
function fechaCivil(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** «4 al 10 de septiembre de 2026»; con cambio de mes, «28 de agosto al 3 de septiembre de 2026». */
function rangoSemana(inicioISO: string, finISO: string): string {
  if (!ISO_FECHA.test(inicioISO) || !ISO_FECHA.test(finISO)) return "";

  const inicio = fechaCivil(inicioISO);
  const fin = fechaCivil(finISO);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime())) return "";

  const mismoMes =
    inicio.getUTCMonth() === fin.getUTCMonth() &&
    inicio.getUTCFullYear() === fin.getUTCFullYear();

  const cabeza = mismoMes
    ? `${inicio.getUTCDate()}`
    : `${inicio.getUTCDate()} de ${MESES[inicio.getUTCMonth()]}`;

  return `${cabeza} al ${fin.getUTCDate()} de ${MESES[fin.getUTCMonth()]} de ${fin.getUTCFullYear()}`;
}

/** «3 de octubre de 2026». */
function diaLargo(iso: string): string {
  if (!ISO_FECHA.test(iso)) return "";
  const d = fechaCivil(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

/**
 * «Ivonne Buenfil» → «Ivonne B.».
 *
 * La frase se lee mejor con el nombre corto; la identidad completa (nombre y
 * correo) vive en la columna «quién» y en el snapshot, así que no se pierde
 * nada.
 */
function nombreCorto(nombre: string | null): string | null {
  if (!nombre) return null;
  const partes = nombre.trim().split(/\s+/);
  if (partes.length === 0 || partes[0] === "") return null;
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[1].charAt(0).toUpperCase()}.`;
}

// ═══════════════════════════════════════════════ lectura del JSON

type Detalles = Readonly<Record<string, unknown>>;

function comoObjeto(valor: unknown): Detalles {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return {};
  }
  return valor as Detalles;
}

function texto(d: Detalles, clave: string): string | null {
  const v = d[clave];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function entero(d: Detalles, clave: string): number | null {
  const v = d[clave];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bandera(d: Detalles, clave: string): boolean {
  return d[clave] === true;
}

function arreglo(d: Detalles, clave: string): readonly unknown[] {
  const v = d[clave];
  return Array.isArray(v) ? v : [];
}

/** La semana tal como se redactó el día del hecho; si no la hay, se recompone. */
function semanaDe(d: Detalles): string {
  const redactada = texto(d, "weekLabel");
  if (redactada) return redactada;

  const inicio = texto(d, "startDate") ?? texto(d, "weekStartDate");
  const fin = texto(d, "endDate") ?? texto(d, "weekEndDate");
  if (!inicio || !fin) return "";
  return rangoSemana(inicio, fin);
}

// ═══════════════════════════════════════════════ catálogo de acciones

/**
 * Etiqueta corta de cada acción, la del distintivo de la fila.
 *
 * Es también la fuente de las opciones «acción concreta» del filtro (ver
 * `FiltrosBitacora`): una sola lista, un solo español.
 */
const ETIQUETA_ACCION: Readonly<Record<string, string>> = {
  RESERVATION_CREATED: "Reserva creada",
  RESERVATION_CANCELLED: "Reserva cancelada",
  RESERVATION_CANCELLED_BY_ADMIN: "Cancelación por administración",
  RESERVATION_OUT_OF_WINDOW: "Reserva fuera de ventana",
  RESERVATION_REJECTED_WINDOW: "Reserva rechazada por ventana",
  SLOT_OPENED: "Semana abierta",
  SLOT_CLOSED: "Semana cerrada",
  SLOT_CLOSED_WITH_ACTIVE_RESERVATION: "Cierre de semana reservada",
  GRANT_CREATED: "Días cedidos",
  GRANT_REVOKED: "Cesión retirada",
  USER_CREATED: "Alta de usuario",
  USER_UPDATED: "Usuario editado",
  USER_DEACTIVATED: "Baja de usuario",
  USER_PASSWORD_CHANGED: "Contraseña cambiada",
  USER_REINVITED: "Invitación reenviada",
  PROPERTY_CREATED: "Propiedad creada",
  PROPERTY_UPDATED: "Propiedad editada",
  MAINTENANCE_NOTE_CREATED: "Nota de mantenimiento",
  MAINTENANCE_NOTE_UPDATED: "Nota de mantenimiento editada",
  MAINTENANCE_NOTE_DELETED: "Nota de mantenimiento borrada",
  BOOKING_POLICY_UPDATED: "Ventana de apertura editada",
  LOGIN_SUCCEEDED: "Acceso",
  LOGIN_FAILED: "Acceso fallido",
  LOGOUT: "Cierre de sesión",
};

/**
 * Orden de presentación de las acciones dentro del filtro, agrupadas igual
 * que en `/bitacora` (page.tsx). Las CLAVES de grupo (`reservas`, `semanas`…)
 * son un contrato con esa página: allí se traducen a listas de acciones.
 */
const FAMILIAS: ReadonlyArray<{
  clave: string;
  titulo: string;
  acciones: readonly string[];
}> = [
  {
    clave: "reservas",
    titulo: "Reservas",
    acciones: [
      "RESERVATION_CREATED",
      "RESERVATION_CANCELLED",
      "RESERVATION_CANCELLED_BY_ADMIN",
      "RESERVATION_OUT_OF_WINDOW",
      "RESERVATION_REJECTED_WINDOW",
    ],
  },
  {
    clave: "semanas",
    titulo: "Semanas",
    acciones: [
      "SLOT_OPENED",
      "SLOT_CLOSED",
      "SLOT_CLOSED_WITH_ACTIVE_RESERVATION",
    ],
  },
  { clave: "cesiones", titulo: "Cesiones", acciones: ["GRANT_CREATED", "GRANT_REVOKED"] },
  {
    clave: "usuarios",
    titulo: "Usuarios",
    acciones: [
      "USER_CREATED",
      "USER_UPDATED",
      "USER_DEACTIVATED",
      "USER_PASSWORD_CHANGED",
      "USER_REINVITED",
    ],
  },
  {
    clave: "propiedades",
    titulo: "Propiedades y política",
    acciones: [
      "PROPERTY_CREATED",
      "PROPERTY_UPDATED",
      "MAINTENANCE_NOTE_CREATED",
      "MAINTENANCE_NOTE_UPDATED",
      "MAINTENANCE_NOTE_DELETED",
      "BOOKING_POLICY_UPDATED",
    ],
  },
  {
    clave: "accesos",
    titulo: "Accesos",
    acciones: ["LOGIN_SUCCEEDED", "LOGIN_FAILED", "LOGOUT"],
  },
];

/**
 * Lo que hay que poder encontrar sin buscarlo: alguien cancelando una reserva
 * ajena o entrando por encima de la ventana de apertura. Son decisiones
 * legítimas, pero son EXCEPCIONES y el producto prometió que ninguna quedara
 * disimulada entre cien accesos correctos.
 */
const ACCIONES_SENSIBLES: ReadonlySet<string> = new Set([
  "RESERVATION_CANCELLED_BY_ADMIN",
  "RESERVATION_OUT_OF_WINDOW",
  "RESERVATION_REJECTED_WINDOW",
  "SLOT_CLOSED_WITH_ACTIVE_RESERVATION",
]);

const ETIQUETA_ENTIDAD: Readonly<Record<string, string>> = {
  USER: "Usuario",
  SESSION: "Sesión",
  PROPERTY: "Propiedad",
  WEEK_SLOT: "Semana",
  RESERVATION: "Reserva",
  DAY_GRANT: "Cesión",
  MAINTENANCE_NOTE: "Mantenimiento",
  BOOKING_POLICY: "Ventana de apertura",
};

/** Campos de usuario, con el nombre que la persona ve en pantalla. */
const ETIQUETA_CAMPO: Readonly<Record<string, string>> = {
  fullName: "nombre",
  phone: "teléfono",
  role: "rol",
  whatsappOptIn: "avisos por WhatsApp",
  isActive: "estado",
  name: "nombre",
  theme: "tema",
};

/**
 * Artículo del campo para cuando va dentro de la frase («cambió EL teléfono»).
 * Aparte de la etiqueta porque la línea de detalle («teléfono: vacío → …») lo
 * quiere sin artículo.
 */
const ARTICULO_CAMPO: Readonly<Record<string, string>> = {
  whatsappOptIn: "los",
};

/** Motivos de `LOGIN_FAILED`, tal como los escribe src/server/auth/login.ts. */
const MOTIVO_FALLO: Readonly<Record<string, string>> = {
  DEMASIADOS_INTENTOS: "demasiados intentos seguidos",
  CORREO_DESCONOCIDO: "ese correo no existe",
  CUENTA_DESACTIVADA: "la cuenta está desactivada",
  CONTRASENA_INCORRECTA: "contraseña incorrecta",
};

/** Motivos de rechazo de `isWeekBookable`. */
const MOTIVO_VENTANA: Readonly<Record<string, string>> = {
  BEFORE_WINDOW: "su mes todavía no abría",
  IN_PROGRESS: "la semana ya había empezado",
  PAST: "la semana ya había pasado",
};

// ═══════════════════════════════════════════════ traducción

interface Descripcion {
  /** Frase principal, con el actor al frente. */
  frase: string;
  /** Sobre qué recae: propiedad y semana, correo, nombre de propiedad… */
  sobreQue: string;
  /** Motivo, nota o matiz que merece una segunda línea. */
  nota: string | null;
}

function describir(entrada: AuditEntryRow): Descripcion {
  const d = comoObjeto(entrada.details);
  const actor = nombreCorto(entrada.actor?.fullName ?? null);
  const quien = actor ?? "Alguien";

  const propiedad = texto(d, "propertyName");
  const semana = semanaDe(d);
  const correo = texto(d, "email");

  // Referencia por omisión: propiedad y semana, que es lo que identifica casi
  // todo en este producto.
  const propiedadYSemana = [propiedad, semana ? `semana del ${semana}` : null]
    .filter((parte): parte is string => parte !== null)
    .join(" · ");

  switch (entrada.action) {
    case "RESERVATION_CREATED": {
      const dueno = nombreCorto(texto(d, "ownerName"));
      const aNombreDeOtro = bandera(d, "onBehalfOfOther") && dueno !== null;
      return {
        frase: aNombreDeOtro
          ? `${quien} reservó una semana a nombre de ${dueno}`
          : `${quien} reservó una semana`,
        sobreQue: propiedadYSemana,
        nota: bandera(d, "windowOverride")
          ? "Con excepción de la ventana de apertura."
          : null,
      };
    }

    case "RESERVATION_CANCELLED":
      return {
        frase: `${quien} canceló su reserva`,
        sobreQue: propiedadYSemana,
        nota: notaDeCancelacion(d),
      };

    case "RESERVATION_CANCELLED_BY_ADMIN": {
      const dueno = nombreCorto(texto(d, "ownerName")) ?? "otra persona";
      const porCierre = bandera(d, "porCierreDeSemana");
      return {
        frase: porCierre
          ? `${quien} canceló la reserva de ${dueno} al cerrar la semana`
          : `${quien} canceló la reserva de ${dueno}`,
        sobreQue: propiedadYSemana,
        nota: notaDeCancelacion(d),
      };
    }

    case "RESERVATION_OUT_OF_WINDOW": {
      const motivo = texto(d, "reason");
      const explicacion = motivo ? MOTIVO_VENTANA[motivo] : null;
      return {
        frase: `${quien} reservó saltándose la ventana de apertura`,
        sobreQue: propiedadYSemana,
        nota: [
          explicacion ? `Al reservar, ${explicacion}.` : null,
          texto(d, "overrideReason")
            ? `Motivo: «${texto(d, "overrideReason")}»`
            : null,
        ]
          .filter((p): p is string => p !== null)
          .join(" "),
      };
    }

    case "RESERVATION_REJECTED_WINDOW": {
      const dueno = nombreCorto(texto(d, "ownerName"));
      const motivo = texto(d, "reason");
      const explicacion = motivo ? MOTIVO_VENTANA[motivo] : null;
      // Este hecho no guarda `onBehalfOfOther`: hay que comparar el dueño con
      // el actor o la frase diría «X reservó a nombre de X».
      const paraOtro =
        dueno !== null &&
        entrada.actor !== null &&
        texto(d, "ownerUserId") !== entrada.actor.id;
      return {
        frase: paraOtro
          ? `Se rechazó el intento de ${quien} de reservar a nombre de ${dueno}`
          : `Se rechazó el intento de reserva de ${quien}`,
        sobreQue: propiedadYSemana,
        nota: bandera(d, "missingOverrideReason")
          ? "La excepción de ventana necesita un motivo escrito."
          : explicacion
            ? `Fuera de ventana: ${explicacion}.`
            : "Fuera de la ventana de apertura.",
      };
    }

    case "SLOT_OPENED":
      return {
        frase: `${quien} abrió una semana a reservas`,
        sobreQue: propiedadYSemana,
        nota: texto(d, "batchId") ? "Parte de una apertura en lote." : null,
      };

    case "SLOT_CLOSED":
      return {
        frase: `${quien} cerró una semana`,
        sobreQue: propiedadYSemana,
        nota: texto(d, "motivo") ? `Motivo: «${texto(d, "motivo")}»` : null,
      };

    case "SLOT_CLOSED_WITH_ACTIVE_RESERVATION": {
      const reserva = comoObjeto(d.reservation);
      const dueno = nombreCorto(texto(reserva, "ownerName")) ?? "alguien";
      const cesiones = arreglo(d, "cesiones").length;
      return {
        frase: `${quien} cerró una semana que ${dueno} tenía reservada y canceló esa reserva`,
        sobreQue: propiedadYSemana,
        nota: [
          texto(d, "motivo") ? `Motivo: «${texto(d, "motivo")}»` : null,
          cesiones > 0
            ? `Arrastró ${cesiones} ${cesiones === 1 ? "día cedido" : "días cedidos"}.`
            : null,
        ]
          .filter((p): p is string => p !== null)
          .join(" "),
      };
    }

    case "GRANT_CREATED": {
      const cedente = nombreCorto(texto(d, "grantorName"));
      const receptor = nombreCorto(texto(d, "granteeName")) ?? "otra persona";
      const dias = arreglo(d, "dates");
      const cuantos = `${dias.length} ${dias.length === 1 ? "día" : "días"}`;
      const enNombreDeOtro =
        cedente !== null &&
        entrada.actor !== null &&
        texto(d, "grantorUserId") !== entrada.actor.id;
      return {
        frase: enNombreDeOtro
          ? `${quien} cedió ${cuantos} de la semana de ${cedente} a ${receptor}`
          : `${quien} cedió ${cuantos} a ${receptor}`,
        sobreQue: propiedadYSemana,
        nota: listaDeDias(dias),
      };
    }

    case "GRANT_REVOKED": {
      const receptor = nombreCorto(texto(d, "granteeName")) ?? "otra persona";
      const dias = arreglo(d, "dates");
      const cuantos = `${dias.length} ${dias.length === 1 ? "día" : "días"}`;
      return {
        frase: `${quien} retiró ${cuantos} que había cedido a ${receptor}`,
        sobreQue: propiedadYSemana,
        nota: listaDeDias(dias),
      };
    }

    case "USER_CREATED": {
      const nombre = texto(d, "fullName") ?? correo ?? "una persona";
      const entrega = texto(d, "entrega");
      return {
        frase: `${quien} dio de alta a ${nombre}`,
        sobreQue: correo ?? "",
        nota:
          entrega === "INVITACION"
            ? "Se envió invitación por correo."
            : entrega === "CONTRASENA_TEMPORAL"
              ? "Se entregó con contraseña temporal."
              : null,
      };
    }

    case "USER_UPDATED": {
      const campos = camposCambiados(d);
      // `propio` lo escribe /perfil; el resto se deduce comparando actor y
      // entidad, que es como quedan las ediciones hechas desde Configuración.
      const propio =
        bandera(d, "propio") ||
        (entrada.entityId !== null && entrada.entityId === entrada.actor?.id);
      const sujeto = propio ? "sus datos" : `los datos de ${correo ?? "un usuario"}`;
      return {
        frase: campos
          ? `${quien} cambió ${campos} en ${sujeto}`
          : `${quien} editó ${sujeto}`,
        sobreQue: correo ?? "",
        nota: detalleDeCambios(d),
      };
    }

    case "USER_DEACTIVATED": {
      const futuras = arreglo(d, "reservasFuturas").length;
      return {
        frase: `${quien} dio de baja a ${correo ?? "un usuario"}`,
        sobreQue: correo ?? "",
        nota: [
          texto(d, "motivo") ? `Motivo: «${texto(d, "motivo")}»` : null,
          futuras > 0
            ? `Quedaron ${futuras} ${futuras === 1 ? "reserva futura" : "reservas futuras"} sin cancelar.`
            : null,
        ]
          .filter((p): p is string => p !== null)
          .join(" "),
      };
    }

    case "USER_PASSWORD_CHANGED": {
      const cerradas = entero(d, "sesionesCerradas");
      return {
        frase: `${quien} cambió su contraseña`,
        sobreQue: correo ?? "",
        nota:
          cerradas !== null && cerradas > 0
            ? `Se cerraron ${cerradas} ${cerradas === 1 ? "sesión" : "sesiones"} en otros dispositivos.`
            : null,
      };
    }

    case "USER_REINVITED":
      return {
        frase: `${quien} reenvió la invitación a ${correo ?? "un usuario"}`,
        sobreQue: correo ?? "",
        nota: null,
      };

    case "PROPERTY_CREATED":
      return {
        frase: `${quien} creó la propiedad ${propiedad ?? ""}`.trim(),
        sobreQue: propiedad ?? "",
        nota: null,
      };

    case "PROPERTY_UPDATED": {
      const cambios = comoObjeto(d.cambios);
      const activa = comoObjeto(cambios.isActive);
      if ("ahora" in activa) {
        const encendida = activa.ahora === true;
        const abiertas = entero(d, "semanasAbiertasFuturas") ?? 0;
        const reservas = entero(d, "reservasFuturas") ?? 0;
        return {
          frase: `${quien} ${encendida ? "reactivó" : "desactivó"} la propiedad ${propiedad ?? ""}`.trim(),
          sobreQue: propiedad ?? "",
          nota:
            !encendida && (abiertas > 0 || reservas > 0)
              ? `Quedaron ${abiertas} semanas abiertas y ${reservas} reservas futuras.`
              : null,
        };
      }

      const nombre = comoObjeto(cambios.name);
      const antes = typeof nombre.antes === "string" ? nombre.antes : null;
      const ahora = typeof nombre.ahora === "string" ? nombre.ahora : null;
      return {
        frase:
          antes && ahora
            ? `${quien} renombró la propiedad «${antes}» a «${ahora}»`
            : `${quien} editó la propiedad ${propiedad ?? ""}`.trim(),
        sobreQue: propiedad ?? "",
        nota: null,
      };
    }

    // Las tres comparten forma de detalles (propertyName, rango, note), así
    // que comparten caso: solo cambia el verbo.
    case "MAINTENANCE_NOTE_CREATED":
    case "MAINTENANCE_NOTE_UPDATED":
    case "MAINTENANCE_NOTE_DELETED": {
      const nota = texto(d, "note");
      const rango =
        texto(d, "rango") ??
        [texto(d, "startDate"), texto(d, "endDate")]
          .filter((p): p is string => p !== null)
          .map(diaLargo)
          .join(" — ");
      const verbo =
        entrada.action === "MAINTENANCE_NOTE_CREATED"
          ? "anotó un mantenimiento"
          : entrada.action === "MAINTENANCE_NOTE_UPDATED"
            ? "editó una nota de mantenimiento"
            : "borró una nota de mantenimiento";
      return {
        frase: `${quien} ${verbo}`,
        sobreQue: [propiedad, rango].filter((p) => p).join(" · "),
        nota: nota ? `«${nota}»` : null,
      };
    }

    case "BOOKING_POLICY_UPDATED":
      return {
        frase: `${quien} cambió los parámetros de la ventana de apertura`,
        sobreQue: propiedad ?? "Todas las propiedades",
        nota: "Revisa el detalle: afecta a qué semanas puede reservar todo el mundo.",
      };

    case "LOGIN_SUCCEEDED": {
      const nombre = nombreCorto(texto(d, "nombre")) ?? quien;
      return { frase: `${nombre} entró a la aplicación`, sobreQue: correo ?? "", nota: null };
    }

    case "LOGIN_FAILED": {
      const motivo = texto(d, "motivo");
      const explicacion = motivo ? MOTIVO_FALLO[motivo] : null;
      return {
        frase: `Intento de acceso fallido con ${correo ?? "un correo desconocido"}`,
        sobreQue: correo ?? "",
        nota: explicacion ? `Causa: ${explicacion}.` : null,
      };
    }

    case "LOGOUT":
      return { frase: `${quien} cerró sesión`, sobreQue: correo ?? "", nota: null };

    default:
      // Acción nueva todavía sin frase. Se dice lo que se sabe y el
      // desplegable enseña el resto: mejor eso que una fila en blanco.
      return {
        frase: `${quien} · ${ETIQUETA_ACCION[entrada.action] ?? entrada.action}`,
        sobreQue: propiedadYSemana || (correo ?? ""),
        nota: null,
      };
  }
}

function notaDeCancelacion(d: Detalles): string | null {
  const motivo = texto(d, "cancelReason");
  const arrastradas = arreglo(d, "cancelledGrants").length;
  const partes = [
    motivo ? `Motivo: «${motivo}»` : null,
    arrastradas > 0
      ? `Se cancelaron ${arrastradas} ${arrastradas === 1 ? "día cedido" : "días cedidos"} en cascada.`
      : null,
  ].filter((p): p is string => p !== null);

  return partes.length > 0 ? partes.join(" ") : null;
}

function listaDeDias(dias: readonly unknown[]): string | null {
  const fechas = dias.filter((v): v is string => typeof v === "string" && ISO_FECHA.test(v));
  if (fechas.length === 0) return null;
  return fechas.map(diaLargo).join(", ");
}

/** «el nombre y el teléfono» a partir del objeto `cambios` de USER_UPDATED. */
function camposCambiados(d: Detalles): string | null {
  const claves = Object.keys(comoObjeto(d.cambios));
  if (claves.length === 0) return null;

  const nombres = claves.map(
    (c) => `${ARTICULO_CAMPO[c] ?? "el"} ${ETIQUETA_CAMPO[c] ?? c}`,
  );
  if (nombres.length === 1) return nombres[0];
  return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
}

/** «nombre: "Ana" → "Ana María"» para los cambios que se pueden leer de un vistazo. */
function detalleDeCambios(d: Detalles): string | null {
  const cambios = comoObjeto(d.cambios);
  const lineas: string[] = [];

  for (const clave of Object.keys(cambios)) {
    const par = comoObjeto(cambios[clave]);
    if (!("antes" in par) || !("ahora" in par)) continue;
    lineas.push(
      `${ETIQUETA_CAMPO[clave] ?? clave}: ${valorLegible(par.antes)} → ${valorLegible(par.ahora)}`,
    );
  }

  return lineas.length > 0 ? lineas.join(" · ") : null;
}

function valorLegible(valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "vacío";
  if (valor === true) return "sí";
  if (valor === false) return "no";
  if (typeof valor === "string" || typeof valor === "number") return `«${valor}»`;
  return JSON.stringify(valor);
}

// ═══════════════════════════════════════════════ filtros

export interface OpcionPropiedad {
  id: string;
  name: string;
}

export interface ValoresFiltro {
  desde: string;
  hasta: string;
  accion: string;
  propiedad: string;
}

/** Mismas medidas que `Input`, para que la barra de filtros no baile. */
const CLASE_CAMPO =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/**
 * Barra de filtros.
 *
 * Es un formulario GET normal: los filtros terminan en la URL, así que se
 * pueden guardar en marcadores y compartir, la página se vuelve a pintar en el
 * servidor con el filtro aplicado, y todo esto funciona sin JavaScript. Es un
 * componente de cliente solo porque vive en este archivo, no porque lo
 * necesite.
 */
export function FiltrosBitacora({
  propiedades,
  valores,
}: {
  propiedades: readonly OpcionPropiedad[];
  valores: ValoresFiltro;
}) {
  const hayFiltro =
    valores.desde !== "" ||
    valores.hasta !== "" ||
    valores.accion !== "" ||
    valores.propiedad !== "";

  return (
    <form
      method="get"
      className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="f-desde" className="text-xs font-medium text-muted-foreground">
          Desde
        </label>
        <input
          id="f-desde"
          name="desde"
          type="date"
          defaultValue={valores.desde}
          className={CLASE_CAMPO}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="f-hasta" className="text-xs font-medium text-muted-foreground">
          Hasta
        </label>
        <input
          id="f-hasta"
          name="hasta"
          type="date"
          defaultValue={valores.hasta}
          className={CLASE_CAMPO}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="f-accion" className="text-xs font-medium text-muted-foreground">
          Acción
        </label>
        <select
          id="f-accion"
          name="accion"
          defaultValue={valores.accion}
          className={CLASE_CAMPO}
        >
          <option value="">Todas las acciones</option>
          <option value="sensibles">Solo entradas sensibles</option>
          {FAMILIAS.map((familia) => (
            <optgroup key={familia.clave} label={familia.titulo}>
              <option value={familia.clave}>Todo: {familia.titulo.toLowerCase()}</option>
              {familia.acciones.map((accion) => (
                <option key={accion} value={accion}>
                  {ETIQUETA_ACCION[accion] ?? accion}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="f-propiedad" className="text-xs font-medium text-muted-foreground">
          Propiedad
        </label>
        <select
          id="f-propiedad"
          name="propiedad"
          defaultValue={valores.propiedad}
          className={CLASE_CAMPO}
        >
          <option value="">Todas las propiedades</option>
          {propiedades.map((propiedad) => (
            <option key={propiedad.id} value={propiedad.id}>
              {propiedad.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-end gap-2">
        <Button type="submit" size="lg" className="h-9 flex-1">
          Filtrar
        </Button>
        {hayFiltro ? (
          // Enlace y no botón: «limpiar» es navegar a /bitacora sin parámetros,
          // y así funciona igual con el JavaScript aún sin cargar.
          <a
            href="/bitacora"
            className={cn(buttonVariants({ variant: "ghost", size: "lg" }), "h-9")}
          >
            Limpiar
          </a>
        ) : null}
      </div>
    </form>
  );
}

// ═══════════════════════════════════════════════ tabla

export interface AuditTableProps {
  entradas: readonly AuditEntryRow[];
  cursorInicial: string | null;
  /**
   * Trae la página siguiente. La define /bitacora, que es quien conoce los
   * filtros vigentes y vuelve a exigir el rol antes de leer nada.
   */
  cargarMas: (cursor: string) => Promise<AuditPage>;
}

export function AuditTable({ entradas, cursorInicial, cargarMas }: AuditTableProps) {
  const [filas, setFilas] = useState<readonly AuditEntryRow[]>(entradas);
  const [cursor, setCursor] = useState<string | null>(cursorInicial);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  function pedirMas() {
    if (cursor === null) return;
    setError(null);
    iniciar(async () => {
      try {
        const pagina = await cargarMas(cursor);
        // Se concatena en vez de reemplazar: «Cargar más» es un registro que
        // crece hacia abajo, no una paginación que salta.
        setFilas((previas) => [...previas, ...pagina.entries]);
        setCursor(pagina.nextCursor);
      } catch {
        setError("No pudimos traer más entradas. Inténtalo de nuevo.");
      }
    });
  }

  if (filas.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        No hay entradas que cumplan estos filtros.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-32 whitespace-nowrap">Cuándo</TableHead>
              <TableHead className="w-48">Quién</TableHead>
              <TableHead>Qué</TableHead>
              <TableHead className="w-64">Sobre qué</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((entrada) => (
              <FilaBitacora key={entrada.id} entrada={entrada} />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col items-center gap-2">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {cursor !== null ? (
          <Button type="button" variant="outline" size="lg" onClick={pedirMas} disabled={pendiente}>
            {pendiente ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ChevronDown className="size-4" aria-hidden />
            )}
            {pendiente ? "Cargando…" : "Cargar más"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            No hay más entradas anteriores con estos filtros.
          </p>
        )}
      </div>
    </div>
  );
}

function FilaBitacora({ entrada }: { entrada: AuditEntryRow }) {
  const { frase, sobreQue, nota } = describir(entrada);
  const { dia, hora } = marcaDeTiempo(entrada.createdAt);
  const sensible = ACCIONES_SENSIBLES.has(entrada.action);
  const etiqueta = ETIQUETA_ACCION[entrada.action] ?? entrada.action;

  return (
    <TableRow className={cn("align-top", sensible && "bg-destructive/5")}>
      <TableCell className="whitespace-nowrap tabular-nums">
        <span className="block text-sm">{dia}</span>
        <span className="block text-xs text-muted-foreground">{hora}</span>
      </TableCell>

      <TableCell>
        {entrada.actor ? (
          <>
            <span className="block text-sm">{entrada.actor.fullName}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {entrada.actor.email}
            </span>
          </>
        ) : (
          // Sin actor: un intento de acceso fallido no acredita a nadie.
          <span className="text-sm text-muted-foreground">Sin identificar</span>
        )}
      </TableCell>

      <TableCell className="min-w-64">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* El distintivo lleva icono y texto, no solo color: el color nunca
              es el único portador de significado (§04). */}
          {sensible ? (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle aria-hidden />
              Revisar
            </Badge>
          ) : null}
          <Badge variant="outline">{etiqueta}</Badge>
        </div>

        <p className="mt-1 text-sm">{frase}</p>
        {nota ? <p className="mt-0.5 text-xs text-muted-foreground">{nota}</p> : null}

        {/* La frase es una interpretación; esto es la evidencia. Va en un
            <details> nativo: se abre sin JavaScript y no arrastra estado. */}
        <details className="group mt-1.5">
          <summary className="cursor-pointer list-none text-xs text-muted-foreground underline-offset-2 hover:underline">
            <span className="group-open:hidden">Ver detalle</span>
            <span className="hidden group-open:inline">Ocultar detalle</span>
          </summary>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>Acción</dt>
            <dd className="font-mono">{entrada.action}</dd>
            <dt>Entidad</dt>
            <dd className="font-mono break-all">
              {ETIQUETA_ENTIDAD[entrada.entityType] ?? entrada.entityType}
              {entrada.entityId ? ` · ${entrada.entityId}` : ""}
            </dd>
            <dt>Origen</dt>
            <dd className="font-mono">{entrada.ip ?? "—"}</dd>
          </dl>
          <pre className="mt-1.5 max-h-72 overflow-auto rounded-lg bg-muted p-2 font-mono text-[0.7rem] leading-relaxed break-words whitespace-pre-wrap">
            {JSON.stringify(entrada.details, null, 2)}
          </pre>
        </details>
      </TableCell>

      <TableCell className="text-sm text-muted-foreground">
        {sobreQue !== "" ? (
          sobreQue
        ) : (
          <span>{ETIQUETA_ENTIDAD[entrada.entityType] ?? entrada.entityType}</span>
        )}
      </TableCell>
    </TableRow>
  );
}
