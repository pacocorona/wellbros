"use client";

/**
 * Selector de tema: Claro / Oscuro / Sistema.
 *
 * El icono del disparador se decide con CSS (`dark:`), no con el estado de
 * React. Es a propósito: el servidor no sabe qué tema tiene guardado el
 * navegador de un visitante, así que cualquier icono elegido en JavaScript
 * durante el primer render provocaría un desajuste de hidratación. La clase
 * `dark` del <html> —que puso el script en línea— sí está bien desde el
 * primer píxel, y CSS la lee sin ayuda de nadie.
 *
 * El menú, en cambio, solo se monta al abrirlo: ahí ya es seguro marcar la
 * opción activa a partir del estado.
 */

import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme, type Theme } from "@/components/theme-provider";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const OPCIONES: ReadonlyArray<{ valor: Theme; texto: string }> = [
  { valor: "light", texto: "Claro" },
  { valor: "dark", texto: "Oscuro" },
  { valor: "system", texto: "Sistema" },
];

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Cambiar tema"
        title="Tema"
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          className,
        )}
      >
        <Sun className="size-4 dark:hidden" aria-hidden />
        <Moon className="hidden size-4 dark:block" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(valor) => setTheme(valor as Theme)}
        >
          {OPCIONES.map((opcion) => (
            <DropdownMenuRadioItem key={opcion.valor} value={opcion.valor}>
              {opcion.valor === "light" ? (
                <Sun className="size-4" aria-hidden />
              ) : opcion.valor === "dark" ? (
                <Moon className="size-4" aria-hidden />
              ) : (
                <Monitor className="size-4" aria-hidden />
              )}
              {opcion.texto}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
