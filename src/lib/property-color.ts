/**
 * Color de identidad de cada propiedad.
 *
 * PARA QUÉ SIRVE: al cambiar de propiedad en el combo, el calendario entero
 * cambia de identidad visual. No es adorno — es una defensa contra el error de
 * reservar la semana de la casa equivocada, que en una plataforma donde todas
 * las propiedades comparten la misma retícula es fácil de cometer.
 *
 * DÓNDE SE APLICA Y DÓNDE NO:
 *   · SÍ en el "cromo": el riel superior de la tarjeta, su borde, el punto del
 *     combo y el nombre de la propiedad.
 *   · NO en los estados de la semana. Verde = disponible, azul = tuya,
 *     violeta = de otro son significados APRENDIDOS que deben valer igual en
 *     todas las propiedades. Si el color de la propiedad los pisara, el usuario
 *     perdería la única señal que le dice si puede reservar.
 *
 * Es una lista CERRADA de ocho colores, no un selector libre de hex. Un color
 * elegido a mano rompería el contraste en tema oscuro; estos ocho están
 * verificados a 4.5:1 o mejor contra las dos superficies y con texto blanco
 * encima.
 */

export const PROPERTY_COLORS = [
  "indigo",
  "teal",
  "ambar",
  "rosa",
  "esmeralda",
  "cielo",
  "violeta",
  "naranja",
] as const;

export type PropertyColor = (typeof PROPERTY_COLORS)[number];

export const DEFAULT_PROPERTY_COLOR: PropertyColor = "indigo";

export function isPropertyColor(value: unknown): value is PropertyColor {
  return (
    typeof value === "string" &&
    (PROPERTY_COLORS as readonly string[]).includes(value)
  );
}

/** Devuelve un color válido siempre: nunca deja la interfaz sin identidad. */
export function coercePropertyColor(value: unknown): PropertyColor {
  return isPropertyColor(value) ? value : DEFAULT_PROPERTY_COLOR;
}

export interface PropertyColorSpec {
  /** Nombre en español para el selector y el texto accesible. */
  label: string;
  /** Acento en tema claro. Contraste >= 4.5:1 con blanco y con la tarjeta. */
  light: string;
  /** Acento en tema oscuro. */
  dark: string;
  /** Tinte suave para fondos, tema claro. */
  softLight: string;
  /** Tinte suave para fondos, tema oscuro. */
  softDark: string;
}

/**
 * Los valores viven aquí y no en globals.css porque el selector de color del
 * diálogo de propiedades necesita pintarlos en JavaScript. La hoja de estilos
 * los consume a través de `propertyColorStyle`.
 */
export const PROPERTY_COLOR_SPEC: Record<PropertyColor, PropertyColorSpec> = {
  indigo: {
    label: "Índigo",
    light: "#4338CA",
    dark: "#A5B4FC",
    softLight: "#EEF2FF",
    softDark: "#1E1B4B",
  },
  teal: {
    label: "Turquesa",
    light: "#0F766E",
    dark: "#5EEAD4",
    softLight: "#F0FDFA",
    softDark: "#042F2E",
  },
  ambar: {
    label: "Ámbar",
    light: "#B45309",
    dark: "#FCD34D",
    softLight: "#FFFBEB",
    softDark: "#3B2A06",
  },
  rosa: {
    label: "Rosa",
    light: "#BE185D",
    dark: "#F9A8D4",
    softLight: "#FDF2F8",
    softDark: "#3F0A25",
  },
  esmeralda: {
    label: "Esmeralda",
    light: "#047857",
    dark: "#6EE7B7",
    softLight: "#ECFDF5",
    softDark: "#052E20",
  },
  cielo: {
    label: "Cielo",
    light: "#0369A1",
    dark: "#7DD3FC",
    softLight: "#F0F9FF",
    softDark: "#082F49",
  },
  violeta: {
    label: "Violeta",
    light: "#6D28D9",
    dark: "#C4B5FD",
    softLight: "#F5F3FF",
    softDark: "#2A1065",
  },
  naranja: {
    label: "Naranja",
    light: "#C2410C",
    dark: "#FDBA74",
    softLight: "#FFF7ED",
    softDark: "#3A1A05",
  },
};

/**
 * Variables CSS en línea para el contenedor del calendario.
 *
 * Se emiten las cuatro variantes y es la hoja de estilos la que elige cuál usar
 * según el tema (`.dark`). Hacerlo así evita tener que saber en el servidor qué
 * tema tiene el usuario, que es justo lo que provocaría un parpadeo al cargar.
 */
export function propertyColorStyle(
  color: PropertyColor,
): Record<string, string> {
  const spec = PROPERTY_COLOR_SPEC[color];
  return {
    "--wb-prop-light": spec.light,
    "--wb-prop-dark": spec.dark,
    "--wb-prop-soft-light": spec.softLight,
    "--wb-prop-soft-dark": spec.softDark,
  };
}

export function propertyColorLabel(color: PropertyColor): string {
  return PROPERTY_COLOR_SPEC[color].label;
}
