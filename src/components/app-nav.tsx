"use client";

/**
 * Navegación del grupo autenticado.
 *
 * Dos formas para el mismo conjunto de destinos, como pide §04: barra
 * superior en escritorio y barra inferior en móvil, donde el pulgar llega.
 * La lista de destinos se arma UNA vez y las dos barras la recorren, para
 * que nunca se desincronicen.
 *
 * Este componente es de cliente por una sola razón: `usePathname` es la
 * única forma de saber en qué ruta estamos para marcar el elemento activo
 * (un layout de servidor no recibe la ruta). Todo lo que necesita servidor
 * —quién es la persona y el cierre de sesión— llega como props desde
 * src/app/(app)/layout.tsx.
 *
 * Quién ve qué NO se decide aquí: `esSuperusuaria` viene del servidor y las
 * páginas de /config y /bitacora vuelven a comprobar el rol por su cuenta.
 * Ocultar un enlace es cortesía, no seguridad.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  LogOut,
  ScrollText,
  Settings,
  User as UserIcon,
  type LucideIcon,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Destino {
  href: string;
  texto: string;
  icono: LucideIcon;
  /** Prefijo que también cuenta como "estoy aquí" (p. ej. /config/usuarios). */
  prefijo?: string;
}

export interface AppNavProps {
  nombre: string;
  esSuperusuaria: boolean;
  /** Acción de servidor: borra la sesión, anota LOGOUT y manda a /login. */
  cerrarSesion: () => Promise<void>;
}

function destinos(esSuperusuaria: boolean): Destino[] {
  const lista: Destino[] = [
    { href: "/", texto: "Calendario", icono: CalendarDays },
  ];

  if (esSuperusuaria) {
    lista.push(
      {
        href: "/config/usuarios",
        texto: "Configuración",
        icono: Settings,
        prefijo: "/config",
      },
      { href: "/bitacora", texto: "Bitácora", icono: ScrollText },
    );
  }

  lista.push({ href: "/perfil", texto: "Perfil", icono: UserIcon });
  return lista;
}

function estaActivo(pathname: string, destino: Destino): boolean {
  const base = destino.prefijo ?? destino.href;
  // "/" solo casa consigo mismo: si no, sería el activo en todas las rutas.
  if (base === "/") return pathname === "/";
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function AppNav({ nombre, esSuperusuaria, cerrarSesion }: AppNavProps) {
  const pathname = usePathname();
  const lista = destinos(esSuperusuaria);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <Link
            href="/"
            className="text-base font-semibold tracking-tight text-[var(--wb-accent-ink)]"
          >
            Wellbros
          </Link>

          <nav aria-label="Principal" className="hidden md:block">
            <ul className="flex items-center gap-1">
              {lista.map((destino) => {
                const activo = estaActivo(pathname, destino);
                const Icono = destino.icono;
                return (
                  <li key={destino.href}>
                    <Link
                      href={destino.href}
                      aria-current={activo ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
                        activo
                          ? "bg-[var(--wb-accent-soft)] text-[var(--wb-accent-ink)]"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Icono className="size-4" aria-hidden />
                      {destino.texto}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <span className="hidden max-w-40 truncate text-sm text-muted-foreground sm:inline">
              {nombre}
            </span>
            <ThemeToggle />
            {/* Formulario y no un botón con onClick: cerrar sesión es una
                escritura (borra la fila y anota en bitácora) y así funciona
                aunque el JavaScript aún no haya cargado. */}
            <form action={cerrarSesion}>
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
              >
                <LogOut className="size-4" aria-hidden />
              </Button>
            </form>
          </div>
        </div>
      </header>

      {/* Barra inferior: solo en móvil. `pb-[env(safe-area-inset-bottom)]`
          evita que el iPhone la meta debajo de su barra de gestos. */}
      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="flex items-stretch">
          {lista.map((destino) => {
            const activo = estaActivo(pathname, destino);
            const Icono = destino.icono;
            return (
              <li key={destino.href} className="flex-1">
                <Link
                  href={destino.href}
                  aria-current={activo ? "page" : undefined}
                  className={cn(
                    "flex h-14 flex-col items-center justify-center gap-1 text-[0.7rem] font-medium transition-colors",
                    activo
                      ? "text-[var(--wb-accent-ink)]"
                      : "text-muted-foreground",
                  )}
                >
                  <Icono className="size-5" aria-hidden />
                  {destino.texto}
                  {/* El color no basta como señal (§04): el activo lleva
                      además una barra bajo el icono. */}
                  <span
                    aria-hidden
                    className={cn(
                      "h-0.5 w-6 rounded-full",
                      activo ? "bg-[var(--wb-accent)]" : "bg-transparent",
                    )}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
