"use client";

/**
 * Registra (o retira) el service worker de la PWA.
 *
 * No pinta nada: se monta en el layout raíz y su único trabajo son los efectos.
 *
 * ── POR QUÉ SOLO EN PRODUCCIÓN ──────────────────────────────────────────────
 *
 * Un service worker en desarrollo es una fuente inagotable de horas perdidas.
 * `next dev` recompila y cambia los archivos de /_next/static a cada guardado,
 * mientras que el service worker sirve de su caché los que guardó antes. El
 * resultado es que el cambio que acabas de escribir no aparece, recargar no lo
 * arregla —la recarga también la atiende el service worker— y uno se pasa
 * media tarde buscando el fallo en un código que ya estaba bien. Peor aún: la
 * página de cortesía puede saltar por un error de compilación pasajero y hacer
 * creer que se ha caído la red.
 *
 * Y no basta con no registrarlo en desarrollo. Un service worker sobrevive al
 * cierre del navegador y sigue controlando el origen hasta que alguien lo
 * retira: quien haya probado una vez `npm run build && npm start` en
 * localhost:3000 se lo lleva puesto a la siguiente sesión de `npm run dev`,
 * porque el origen (esquema + host + puerto) es el mismo. Por eso en
 * desarrollo esto no se limita a callarse: BUSCA Y RETIRA activamente
 * cualquier registro y borra sus cachés.
 */

import { useEffect } from "react";

/** Mismo archivo que sirve Next desde public/. */
const RUTA_SW = "/sw.js";

/** Prefijo de las cachés que crea el service worker (ver public/sw.js). */
const PREFIJO_CACHE = "wellbros-";

/**
 * Cada cuánto se le pregunta al servidor si hay un service worker nuevo.
 *
 * Instalada en el teléfono, la aplicación puede pasar días sin cerrarse del
 * todo, y el navegador solo comprueba por su cuenta en la navegación. Una hora
 * es un punto razonable: no genera tráfico apreciable —la petición es un
 * archivo de unos pocos kilobytes, y si no cambió el servidor responde 304— y
 * evita que una corrección tarde una semana en llegar.
 */
const INTERVALO_ACTUALIZACION_MS = 60 * 60 * 1000;

export function RegistrarSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      void retirarEnDesarrollo();
      return;
    }

    let intervalo: ReturnType<typeof setInterval> | undefined;
    let registro: ServiceWorkerRegistration | undefined;

    // El registro descarga y arranca el service worker, así que se aplaza
    // hasta que la página haya cargado: compitiendo con la primera pintada
    // solo conseguiría retrasar lo que el usuario está esperando ver.
    const registrar = () => {
      navigator.serviceWorker
        .register(RUTA_SW, {
          scope: "/",
          // CLAVE. Sin esto el navegador puede resolver la petición de /sw.js
          // con su propia caché HTTP y no llegar a enterarse de que hay una
          // versión nueva. Es la mitad del cinturón: la otra mitad es que
          // nginx envíe `Cache-Control: no-store` para /sw.js (el bloque
          // `location = /sw.js` de deploy/nginx/wellbros.conf).
          updateViaCache: "none",
        })
        .then((resultado) => {
          registro = resultado;
          intervalo = setInterval(() => {
            // `update()` rechaza si el servidor no responde: sin conexión es
            // lo normal y no hay nada que informar.
            void resultado.update().catch(() => undefined);
          }, INTERVALO_ACTUALIZACION_MS);
        })
        .catch(() => {
          // Un fallo aquí no rompe nada: la aplicación funciona igual, solo
          // que sin instalar ni pantalla de cortesía. No se molesta a nadie
          // con un aviso por algo que no puede resolver.
        });
    };

    if (document.readyState === "complete") {
      registrar();
    } else {
      window.addEventListener("load", registrar, { once: true });
    }

    return () => {
      window.removeEventListener("load", registrar);
      if (intervalo !== undefined) clearInterval(intervalo);
      // El registro NO se retira al desmontar: debe sobrevivir a la navegación
      // y a cerrar la pestaña. Esta línea solo existe para que quede claro que
      // la omisión es deliberada y no un descuido.
      void registro;
    };
  }, []);

  return null;
}

/**
 * Deja el origen limpio de service workers en desarrollo.
 *
 * Retira todos los registros de este ámbito y borra las cachés que hubiera
 * dejado una compilación de producción anterior. Con esto, un `npm run dev`
 * basta para recuperar el comportamiento normal del navegador.
 */
async function retirarEnDesarrollo(): Promise<void> {
  try {
    const registros = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registros.map((registro) => registro.unregister()));

    if (!("caches" in window)) return;

    const nombres = await caches.keys();
    await Promise.all(
      nombres
        .filter((nombre) => nombre.startsWith(PREFIJO_CACHE))
        .map((nombre) => caches.delete(nombre)),
    );
  } catch {
    // Modo privado, permisos de almacenamiento restringidos… nada que hacer,
    // y nada que se rompa por no hacerlo.
  }
}
