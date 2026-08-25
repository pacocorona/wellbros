/**
 * Cliente de Prisma: una sola instancia para todo el proceso.
 *
 * Prisma 7 ya no lee la URL desde schema.prisma: la conexión entra por el
 * driver adapter (@prisma/adapter-pg), que es quien construye el pool de `pg`.
 *
 * El singleton colgado de `globalThis` existe por el hot reload de Next en
 * desarrollo: cada recarga vuelve a evaluar este módulo y, sin la caché
 * global, cada evaluación abriría un pool nuevo hasta agotar las conexiones de
 * PostgreSQL. En producción el módulo se evalúa una sola vez, así que ahí no
 * se guarda nada en el global.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Fallar aquí y no en la primera consulta: el error es mucho más claro.
  throw new Error(
    "Falta DATABASE_URL. Copia .env.example a .env y configura la conexión.",
  );
}

function createPrismaClient() {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    // Solo avisos y errores: `query` inundaría la consola en desarrollo.
    log: ["warn", "error"],
  });
}

/** Tipo real del cliente, con las opciones que le pasamos arriba. */
export type Db = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
  wellbrosPrisma?: Db;
};

export const prisma: Db = globalForPrisma.wellbrosPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.wellbrosPrisma = prisma;
}
