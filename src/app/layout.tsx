/**
 * Raíz de la aplicación: idioma, tipografía, tema y nada más.
 *
 * Aquí NO se protege ninguna ruta: este layout también envuelve /login,
 * que es público. La protección del grupo autenticado vive en
 * src/app/(app)/layout.tsx.
 */

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { RegistrarSW } from "@/components/registrar-sw";
import { ThemeProvider, type Theme } from "@/components/theme-provider";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

import "./globals.css";

/**
 * La variable se llama `--font-sans` porque es el nombre que globals.css
 * mapea en `@theme inline` (`--font-sans: var(--font-sans)`). Con el nombre
 * anterior (`--font-geist-sans`) la utilidad `font-sans` de Tailwind se
 * quedaba sin valor y el navegador caía a su tipografía por omisión.
 */
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * El `<link rel="manifest">` NO se declara aquí: lo inyecta Next por la
 * convención de archivo `src/app/manifest.ts`. Añadirlo a mano duplicaría la
 * etiqueta.
 */
export const metadata: Metadata = {
  title: "Wellbros",
  description: "Reserva de semanas en las propiedades compartidas.",

  // Nombre de la aplicación instalada para los navegadores de escritorio.
  applicationName: "Wellbros",

  /**
   * iOS: el caso restrictivo.
   *
   * Safari no lee el manifiesto para decidir cómo se abre lo que hay en la
   * pantalla de inicio. Necesita SUS etiquetas, y sin ellas «Añadir a inicio»
   * crea un acceso directo que abre el sitio en una pestaña normal, con barra
   * de direcciones incluida: la aplicación no se ve instalada, se ve como un
   * marcador. `title` es lo que se lee debajo del icono —de ahí que sea el
   * nombre corto y no el largo— y `statusBarStyle: "default"` deja el
   * contenido por debajo de la barra de estado; `black-translucent` lo metería
   * por debajo del reloj y de la muesca, y esta interfaz no está preparada
   * para eso (nada usa `env(safe-area-inset-top)`).
   */
  appleWebApp: {
    capable: true,
    title: "Wellbros",
    statusBarStyle: "default",
  },

  icons: {
    // El icono de la pantalla de inicio en iOS. No sale del manifiesto: Safari
    // solo mira `apple-touch-icon`, y si no lo encuentra usa una captura de la
    // página, que queda ilegible. 180×180 sería el tamaño exacto de iOS; se le
    // da el de 192, que iOS reescala sin problema, para no cargar el proyecto
    // con un cuarto archivo casi idéntico. Va a sangre y opaco a propósito:
    // iOS le pone él mismo las esquinas redondeadas.
    apple: [{ url: "/icono-192.png", sizes: "192x192", type: "image/png" }],
  },

  other: {
    // Next 16 solo emite `mobile-web-app-capable`, que es el nombre moderno.
    // Safari lo entiende a partir de iOS 17; los iPhone que se quedaron en
    // iOS 15 o 16 —que en un grupo familiar los hay— siguen necesitando el
    // nombre antiguo. Duplicar la etiqueta no molesta a nadie.
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F4EE" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1621" },
  ],
};

/**
 * Clave de localStorage con la preferencia de quien aún no ha entrado.
 *
 * Duplicada a propósito en `@/components/theme-provider`: ese módulo es
 * "use client" y todos sus exports se vuelven referencias de cliente, así que
 * este archivo —que corre en el servidor— no puede leer su constante. Si
 * cambia allá, cambia aquí.
 */
const THEME_STORAGE_KEY = "wellbros-theme";

function esTema(valor: string | undefined): valor is Theme {
  return valor === "light" || valor === "dark" || valor === "system";
}

/**
 * Script que decide el tema ANTES del primer pintado.
 *
 * Por qué va en línea y no en un archivo: un `<script src>` —incluso con
 * next/script y `beforeInteractive`— es una petición aparte; el navegador
 * pintaría la primera pantalla con el tema equivocado y el cambio se vería
 * como un fogonazo blanco al entrar de noche. En línea y síncrono dentro del
 * <head>, el navegador lo ejecuta antes de construir el <body>, de modo que
 * la clase `dark` ya está puesta cuando se pinta el primer píxel. Es la misma
 * razón por la que <html> lleva `suppressHydrationWarning`: este script toca
 * el DOM antes de que React hidrate y sin eso React avisaría de la diferencia.
 *
 * Prioridad: la preferencia guardada en el servidor (users.theme) manda sobre
 * localStorage. Quien tiene sesión ve su tema en cualquier navegador; quien no
 * la tiene conserva el que eligió en este.
 */
function scriptDeTema(temaDelServidor: Theme | null): string {
  return `(function(){try{
var s=${JSON.stringify(temaDelServidor)};
var g=null;try{g=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}
var p=s||(g==="light"||g==="dark"||g==="system"?g:"system");
if(s){try{localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)},s)}catch(e){}}
var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);
var r=document.documentElement;
r.classList.toggle("dark",d);
r.setAttribute("data-theme",p);
}catch(e){}})();`;
}

/**
 * Guarda la preferencia de tema de quien tiene sesión.
 *
 * Es una acción de servidor y por tanto un endpoint público: resuelve la
 * sesión por su cuenta y no se fía de nada que venga del cliente. Sin sesión
 * no hace nada —el navegador ya guardó el valor en localStorage— y sin valor
 * válido tampoco: `users.theme` es varchar(10) y solo admite estas tres.
 *
 * No se anota en la bitácora: es una preferencia visual, no un hecho
 * auditable, y un USER_UPDATED por cada clic ahogaría el registro. Cuando
 * exista /perfil, esta escritura debería mudarse a src/server/users/.
 */
async function guardarTema(tema: string): Promise<void> {
  "use server";

  if (!esTema(tema)) return;

  const usuario = await getCurrentUser();
  if (!usuario) return;

  // Un fallo aquí no puede tumbar la interfaz: el tema ya se aplicó en el
  // navegador y lo peor que pasa es que no sobreviva al próximo inicio.
  await prisma.user
    .update({ where: { id: usuario.id }, data: { theme: tema } })
    .catch(() => undefined);
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Lectura barata: `getCurrentSession` va envuelta en `cache` de React, así
  // que el layout del grupo autenticado no vuelve a consultar la base.
  const usuario = await getCurrentUser();
  const temaGuardado = usuario?.theme;
  const temaDelServidor: Theme | null = esTema(temaGuardado)
    ? temaGuardado
    : null;

  return (
    <html
      lang="es"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script
          // Contenido generado aquí mismo, sin datos de nadie salvo el tema.
          dangerouslySetInnerHTML={{ __html: scriptDeTema(temaDelServidor) }}
        />
      </head>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <ThemeProvider
          temaInicial={temaDelServidor}
          haySesion={usuario !== null}
          guardarTema={guardarTema}
        >
          {children}
        </ThemeProvider>
        {/* No pinta nada; registra el service worker (y en desarrollo lo
            retira). Va al final del <body> porque su trabajo empieza después
            de la carga y no debe competir con la primera pintada. */}
        <RegistrarSW />
      </body>
    </html>
  );
}
