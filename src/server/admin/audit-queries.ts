/**
 * Lectura de la bitácora (solo SUPERUSER).
 *
 * La bitácora es «oculta»: ni la ruta ni el menú existen para un usuario
 * normal. Eso es interfaz, y la interfaz no es una defensa — por eso el rol se
 * exige AQUÍ DENTRO. Quien llame a esta función desde una acción de servidor
 * mal protegida, desde una futura ruta de API o desde una prueba, se topa con
 * el mismo 403.
 *
 * Solo lee: `audit_log` es append-only y nada en este archivo escribe.
 */

import { TZDate } from "@date-fns/tz";
import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import type { AuditAction, AuditEntityType } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { DEFAULT_BOOKING_WINDOW } from "@/lib/booking-window";
import type { Db } from "@/lib/db";

import { type AdminActor, assertSuperuser, parseOrThrow } from "./users";

/** Tope duro: la bitácora crece sin límite y la pantalla se pagina. */
const LIMITE_MAXIMO = 200;
const LIMITE_POR_DEFECTO = 50;

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export interface AuditFilters {
  /** Desde (incluido). `yyyy-MM-dd` se interpreta en la zona de negocio. */
  from?: string | Date;
  /** Hasta (incluido). Con `yyyy-MM-dd` entra el día COMPLETO. */
  to?: string | Date;
  actions?: AuditAction[];
  actorUserId?: string;
  /**
   * Filtra por la propiedad implicada. `audit_log` no tiene columna de
   * propiedad: se busca `details->>'propertyId'`, así que TODO el que escriba
   * un hecho de una propiedad debe incluir esa clave en los detalles (los
   * servicios de administración ya lo hacen).
   */
  propertyId?: string;
  entityType?: AuditEntityType;
  entityId?: string;
}

export interface AuditEntryRow {
  /** `bigint` de la base convertido a texto: JSON no sabe serializar BigInt. */
  id: string;
  createdAt: Date;
  /** Se guarda como texto libre; casi siempre es un `AuditAction`. */
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; fullName: string; email: string } | null;
  details: Prisma.JsonValue;
  ip: string | null;
}

export interface AuditPage {
  entries: AuditEntryRow[];
  /** Pásalo tal cual como `cursor` para la página siguiente. `null` = no hay más. */
  nextCursor: string | null;
}

const fechaEntradaSchema = z.union([
  z.date(),
  z
    .string()
    .trim()
    .refine(
      (v) => ISO_FECHA.test(v) || !Number.isNaN(Date.parse(v)),
      "Fecha inválida: usa yyyy-MM-dd o una marca de tiempo ISO",
    ),
]);

const filtrosSchema = z.object({
  from: fechaEntradaSchema.optional(),
  to: fechaEntradaSchema.optional(),
  actions: z.array(z.enum(AUDIT_ACTIONS)).min(1).optional(),
  actorUserId: z.uuid("Identificador de actor inválido").optional(),
  propertyId: z.uuid("Identificador de propiedad inválido").optional(),
  entityType: z
    .enum([
      "USER",
      "SESSION",
      "PROPERTY",
      "WEEK_SLOT",
      "RESERVATION",
      "DAY_GRANT",
      "MAINTENANCE_NOTE",
      "BOOKING_POLICY",
    ])
    .optional(),
  entityId: z.uuid("Identificador de entidad inválido").optional(),
});

const cursorSchema = z.string().trim().regex(/^\d+$/, "Cursor inválido");

/**
 * Página de bitácora, de lo más nuevo a lo más viejo.
 *
 * El paginado va por CURSOR sobre `id` y no por OFFSET: `audit_log` recibe
 * escrituras mientras alguien la lee, y con OFFSET una entrada nueva desplaza
 * la ventana y hace que la página siguiente repita o se salte filas. `id` es
 * `bigserial`, así que ordenar por él descendente es exactamente el orden de
 * inserción, sin empates que romper.
 */
export async function listAuditEntries({
  db,
  actor,
  filters = {},
  cursor,
  limit = LIMITE_POR_DEFECTO,
}: {
  db: Db;
  actor: AdminActor;
  filters?: AuditFilters;
  cursor?: string | null;
  limit?: number;
}): Promise<AuditPage> {
  // La regla del producto en una línea: la bitácora SOLO la ve la superusuaria.
  assertSuperuser(actor);

  const f = parseOrThrow(filtrosSchema, filters);
  const tope = Math.min(Math.max(Math.trunc(limit) || LIMITE_POR_DEFECTO, 1), LIMITE_MAXIMO);
  const desde = cursor ? BigInt(parseOrThrow(cursorSchema, cursor)) : null;

  const rango: Prisma.DateTimeFilter<"AuditLog"> = {};
  if (f.from !== undefined) rango.gte = instanteDesde(f.from, false);
  if (f.to !== undefined) rango.lt = instanteDesde(f.to, true);

  const where: Prisma.AuditLogWhereInput = {
    ...(desde !== null ? { id: { lt: desde } } : {}),
    ...(rango.gte !== undefined || rango.lt !== undefined ? { createdAt: rango } : {}),
    ...(f.actions ? { action: { in: f.actions } } : {}),
    ...(f.actorUserId ? { actorUserId: f.actorUserId } : {}),
    ...(f.entityType ? { entityType: f.entityType } : {}),
    ...(f.entityId ? { entityId: f.entityId } : {}),
    ...(f.propertyId
      ? { details: { path: ["propertyId"], equals: f.propertyId } }
      : {}),
  };

  // Se pide una fila de más para saber si hay página siguiente sin gastar un
  // COUNT sobre una tabla que solo crece.
  const filas = await db.auditLog.findMany({
    where,
    select: {
      id: true,
      createdAt: true,
      action: true,
      entityType: true,
      entityId: true,
      details: true,
      ip: true,
      actor: { select: { id: true, fullName: true, email: true } },
    },
    orderBy: { id: "desc" },
    take: tope + 1,
  });

  const hayMas = filas.length > tope;
  const visibles = hayMas ? filas.slice(0, tope) : filas;

  return {
    entries: visibles.map((fila) => ({
      id: fila.id.toString(),
      createdAt: fila.createdAt,
      action: fila.action,
      entityType: fila.entityType,
      entityId: fila.entityId,
      actor: fila.actor,
      details: fila.details,
      ip: fila.ip,
    })),
    nextCursor: hayMas ? visibles[visibles.length - 1].id.toString() : null,
  };
}

/**
 * Un día civil `yyyy-MM-dd` no es un instante: hay que decidir cuál de sus 24
 * horas. Se resuelve en la ZONA DE NEGOCIO, porque «el 3 de octubre» significa
 * el 3 de octubre en México, no en UTC — con `to` se toma el inicio del día
 * SIGUIENTE y se compara con `<`, que es la forma correcta de incluir el día
 * entero sin perder los últimos milisegundos.
 */
function instanteDesde(valor: string | Date, finDeDia: boolean): Date {
  if (valor instanceof Date) return valor;
  if (!ISO_FECHA.test(valor)) return new Date(valor);

  const [y, m, d] = valor.split("-").map(Number);
  const zona = DEFAULT_BOOKING_WINDOW.timeZone;
  const base = new TZDate(y, m - 1, d + (finDeDia ? 1 : 0), 0, 0, 0, 0, zona);
  return new Date(base.getTime());
}
