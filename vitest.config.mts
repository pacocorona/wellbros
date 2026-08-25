import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Extensión .mts: Vite lo carga como ESM sin depender de "type": "module"
// en package.json, que rompería la configuración de Next. Por eso aquí sí
// existe import.meta.url y no __dirname.
const raiz = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    // `globals` queda DESACTIVADO a propósito: con él, una prueba escrita sin
    // importar `describe`/`it` corre en verde pero rompe `npm run typecheck`
    // (TS2582), porque tsconfig no declara "vitest/globals" — y declararlo
    // desactivaría la inclusión automática del resto de @types, que Next necesita.
    // Todas las pruebas importan explícitamente desde "vitest".
    globals: false,
    // .tsx incluido: las pruebas de los componentes del calendario habrían
    // quedado fuera en silencio, que es peor que fallar.
    include: ["src/**/*.test.{ts,tsx}"],
    // Las pruebas de propiedad de la ventana de apertura barren miles de
    // instantes con TZDate; los 5 s por defecto se quedan cortos en máquinas
    // de integración continua.
    testTimeout: 30_000,
    // UN ARCHIVO A LA VEZ. Las pruebas de servicios corren contra la base
    // PostgreSQL de verdad —no hay dobles— y todas comparten la MISMA base.
    //
    // No es una precaución teórica: reservar, cancelar y abrir semanas encolan
    // un aviso para CADA usuario activo (`activeUserIds`, src/lib/notifications/
    // dispatch.ts). Con los archivos en paralelo, las reservas de
    // reservations.test.ts insertaban filas en `notification_outbox` apuntando a
    // los usuarios de prueba de grants.test.ts, y el `afterAll` de este último
    // —que ya había borrado sus propios avisos— moría al borrar los usuarios con
    // «Foreign key constraint violated: notification_outbox_recipient_user_id_fkey».
    // El archivo que perdía la carrera cambiaba de una corrida a otra.
    //
    // En serie, el montaje y el desmontaje de cada archivo no se solapan con los
    // de ningún otro. Cuesta unos segundos de reloj; a cambio la corrida completa
    // da el mismo resultado que cada archivo por separado, que es lo mínimo que
    // se le pide a una suite.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(raiz, "./src"),
    },
  },
});
