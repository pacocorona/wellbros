"use client";

/**
 * Estado del tema en el cliente.
 *
 * El primer pintado NO depende de este componente: de eso se encarga el
 * script en línea del <head> (ver src/app/layout.tsx), que ya dejó puesta la
 * clase `dark` y el atributo `data-theme` antes de que React existiera. Este
 * proveedor solo se encarga de lo que pasa DESPUÉS: recordar qué eligió la
 * persona, aplicar el cambio sin recargar y guardarlo donde corresponda.
 *
 * Dónde vive la preferencia:
 *   · con sesión  → users.theme (servidor), para que viaje entre navegadores.
 *   · sin sesión  → localStorage de este navegador.
 * Se escriben las dos: así el tema sobrevive al cierre de sesión.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

export type Theme = "light" | "dark" | "system";

/** Debe coincidir con la del script en línea de src/app/layout.tsx. */
const THEME_STORAGE_KEY = "wellbros-theme";

const MEDIA_OSCURO = "(prefers-color-scheme: dark)";

export interface ThemeContextValue {
  /** Lo que la persona eligió: puede ser "system". */
  theme: Theme;
  /** Lo que realmente se está pintando: nunca "system". */
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
  /**
   * Falso durante el primer render del cliente. Cualquier interfaz que
   * dependa del tema (una marca de "elegido", por ejemplo) debe esperar a
   * que sea verdadero, o el HTML del servidor y el del cliente diferirán.
   */
  isReady: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function esTema(valor: string | null): valor is Theme {
  return valor === "light" || valor === "dark" || valor === "system";
}

function prefiereOscuro(): boolean {
  return window.matchMedia(MEDIA_OSCURO).matches;
}

function resolver(theme: Theme): "light" | "dark" {
  if (theme === "system") return prefiereOscuro() ? "dark" : "light";
  return theme;
}

/** Aplica el tema al documento. Misma operación que hace el script del <head>. */
function pintar(theme: Theme): "light" | "dark" {
  const resuelto = resolver(theme);
  const raiz = document.documentElement;
  raiz.classList.toggle("dark", resuelto === "dark");
  raiz.setAttribute("data-theme", theme);
  return resuelto;
}

/* ────────────────────────────────────────────────────────────────────────────
   El <html> ES el almacén.

   No hay `useState` con el tema: la verdad ya vive en el documento —el script
   en línea del <head> escribió `data-theme` y la clase `dark` antes de que
   React existiera— y duplicarla en estado de React obligaba a copiarla dentro
   de un efecto, que es justo el patrón de renders en cascada que React
   desaconseja (y que `react-hooks/set-state-in-effect` marca como error).

   `useSyncExternalStore` es la herramienta para exactamente esto: se lee el
   DOM, y `getServerSnapshot` da el valor con el que se pinta en el servidor y
   se hidrata. React compara los dos al montar y vuelve a renderizar solo si
   difieren, sin desajuste de hidratación. `isReady` sale gratis: es la
   suscripción cuyo valor de servidor es `false` y el de cliente `true`.
   ──────────────────────────────────────────────────────────────────────────── */

const oyentes = new Set<() => void>();

function suscribir(alCambiar: () => void): () => void {
  oyentes.add(alCambiar);
  return () => {
    oyentes.delete(alCambiar);
  };
}

/** Avisa a React de que el documento cambió de tema. */
function notificar(): void {
  for (const avisar of oyentes) avisar();
}

function leerTema(): Theme {
  const valor = document.documentElement.getAttribute("data-theme");
  return esTema(valor) ? valor : "system";
}

function leerResuelto(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const listoEnCliente = () => true;
const listoEnServidor = () => false;
/** El servidor no puede resolver "system": pinta claro y el script corrige. */
const resueltoEnServidor = (): "light" | "dark" => "light";

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** users.theme de quien tiene sesión; nulo para visitantes. */
  temaInicial: Theme | null;
  haySesion: boolean;
  /** Acción de servidor que escribe users.theme. No se llama sin sesión. */
  guardarTema: (theme: string) => Promise<void>;
}

export function ThemeProvider({
  children,
  temaInicial,
  haySesion,
  guardarTema,
}: ThemeProviderProps) {
  // Antes de hidratar se usa el valor del servidor; ya en el navegador, el
  // que el script del <head> dejó puesto en el documento —que para un
  // visitante sin sesión es el de localStorage, que el servidor no ve—.
  const temaDelServidor = useCallback(
    (): Theme => temaInicial ?? "system",
    [temaInicial],
  );

  const theme = useSyncExternalStore(suscribir, leerTema, temaDelServidor);
  const resolvedTheme = useSyncExternalStore(
    suscribir,
    leerResuelto,
    resueltoEnServidor,
  );
  const isReady = useSyncExternalStore(
    suscribir,
    listoEnCliente,
    listoEnServidor,
  );

  /** Escribe el tema en el documento, en localStorage y avisa a React. */
  const aplicar = useCallback((nuevo: Theme) => {
    pintar(nuevo);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nuevo);
    } catch {
      // localStorage lanza en modo privado de algunos navegadores y cuando
      // las cookies de terceros están bloqueadas dentro de un iframe. Sin él
      // el tema dura lo que dure la pestaña; no es motivo para romper nada.
    }
    notificar();
  }, []);

  // El script del <head> solo corre en una carga completa. Tras iniciar
  // sesión —que es una navegación blanda— el servidor empieza a mandar
  // `users.theme` y hay que aplicarlo aquí, o quien entrara con un tema
  // guardado en su cuenta seguiría viendo el del navegador.
  useEffect(() => {
    if (!temaInicial) return;
    if (leerTema() === temaInicial) return;
    aplicar(temaInicial);
  }, [temaInicial, aplicar]);

  // Con "system" el tema lo decide el sistema operativo y puede cambiar
  // mientras la pestaña está abierta (modo nocturno automático).
  useEffect(() => {
    if (theme !== "system") return;

    const media = window.matchMedia(MEDIA_OSCURO);
    const alCambiar = () => {
      pintar("system");
      notificar();
    };
    media.addEventListener("change", alCambiar);
    return () => media.removeEventListener("change", alCambiar);
  }, [theme]);

  const setTheme = useCallback(
    (nuevo: Theme) => {
      aplicar(nuevo);

      // El servidor es la fuente de verdad de quien tiene sesión, pero la
      // interfaz no espera a la respuesta: el cambio ya se pintó.
      if (haySesion) void guardarTema(nuevo);
    },
    [aplicar, guardarTema, haySesion],
  );

  const valor = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, isReady }),
    [theme, resolvedTheme, setTheme, isReady],
  );

  return <ThemeContext value={valor}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const contexto = useContext(ThemeContext);
  if (!contexto) {
    throw new Error("useTheme necesita estar dentro de <ThemeProvider>.");
  }
  return contexto;
}
