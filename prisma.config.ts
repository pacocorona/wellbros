import "dotenv/config";
import path from "node:path";
import { defineConfig, env } from "prisma/config";

// Prisma 7: la URL de conexión ya no vive en schema.prisma.
// Aquí la usan los comandos de migración; en tiempo de ejecución el cliente
// la recibe a través del driver adapter (ver src/lib/db.ts).
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
