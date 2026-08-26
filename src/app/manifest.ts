/**
 * Manifiesto de la aplicación web (PWA).
 *
 * Convención de archivo de Next 16: `app/manifest.ts` se publica en
 * `/manifest.webmanifest` y Next inyecta solo el `<link rel="manifest">` en
 * todas las páginas. No hay que declararlo en `metadata`, y hacerlo duplicaría
 * la etiqueta.
 *
 * NO LO CIERRA `src/proxy.ts`, y es a propósito: su `matcher` excluye toda
 * ruta con extensión, y `.webmanifest` la tiene. Importa, porque el navegador
 * pide el manifiesto SIN credenciales; si el filtro lo redirigiera a /login, la
 * respuesta sería HTML, el navegador la descartaría y no habría manera de
 * instalar la aplicación —sin ningún error visible salvo un aviso en la
 * consola—. Si algún día se toca ese `matcher`, hay que añadir
 * `/manifest.webmanifest` a PUBLIC_PATHS.
 *
 * Esta ruta no lee cookies ni cabeceras, así que Next la genera estáticamente.
 */

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // `id` ancla la identidad de la instalación. Sin él, el navegador la
    // deriva de `start_url`: el día que esa ruta cambie, Android trataría la
    // aplicación como una distinta y dejaría el icono viejo huérfano en el
    // escritorio de quien ya la tenía instalada.
    id: "/",

    name: "Wellbros — Propiedades compartidas",
    // Lo que cabe bajo el icono en el escritorio del teléfono. Doce
    // caracteres es el límite práctico antes de que Android lo recorte.
    short_name: "Wellbros",
    description:
      "Reserva de semanas en las propiedades compartidas: consulta la disponibilidad, aparta tu semana y cede las que no vayas a usar.",

    lang: "es",
    dir: "ltr",

    start_url: "/",
    // Todo el sitio entra en la aplicación instalada. Sin `scope`, el
    // navegador lo deduce de `start_url` y saldría igual, pero declararlo
    // evita que un cambio futuro de `start_url` encoja el alcance sin querer
    // y abra /login en una pestaña del navegador en vez de en la aplicación.
    scope: "/",

    // Sin barra de direcciones: es lo que hace que parezca una aplicación.
    display: "standalone",
    // Si el sistema no admite `standalone`, antes de caer al navegador que
    // pruebe con la barra mínima, que al menos conserva el aspecto instalado.
    display_override: ["standalone", "minimal-ui"],

    // El calendario es una retícula de siete columnas pensada para el móvil en
    // vertical. En horizontal cabe, pero no es la orientación de trabajo.
    orientation: "portrait",

    // Acento de la marca (--wb-accent). Lo usan Android para el fondo de la
    // pantalla de arranque y el conmutador de tareas.
    theme_color: "#0E7490",
    // Fondo de la pantalla de arranque. Es el `--background` del tema claro:
    // así el salto entre la pantalla de arranque y la primera pintada de la
    // aplicación no es un fogonazo blanco. El manifiesto no admite variante
    // oscura —no existe en la especificación—, y de los dos fondos el claro es
    // el que más gente ve.
    background_color: "#F6F4EE",

    icons: [
      // `any`: se muestran tal cual, a sangre. iOS los redondea por su cuenta.
      {
        src: "/icono-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icono-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // `maskable`: Android lo recorta con la forma que use el lanzador
      // (círculo, cuadrado redondeado, gota) y solo respeta el círculo
      // interior del 80 %. Por eso este archivo lleva la W encogida con
      // margen de seguridad. Sin una entrada `maskable`, Android encaja el
      // icono `any` dentro de un cuadrado blanco con sombra, que se ve mal.
      {
        src: "/icono-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],

    categories: ["productivity", "travel", "lifestyle"],
  };
}
