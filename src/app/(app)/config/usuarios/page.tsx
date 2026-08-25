import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { UsersTable } from "@/components/admin/users-table";
import { isAuthError, requireSuperuser, type SessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { listUsers } from "@/server/admin/users";

export const metadata: Metadata = {
  title: "Usuarios · Wellbros",
};

/**
 * /config/usuarios — alta, edición y baja de cuentas. Solo la superusuaria.
 *
 * El layout de (app) exige sesión, pero no rol: quien entre aquí con una cuenta
 * normal tiene sesión válida y llegaría hasta esta función. Por eso la puerta se
 * cierra en la propia página, y otra vez dentro de cada Server Action —que es un
 * endpoint aparte al que no protege ninguna página—.
 *
 * Se responde 404 y no 403: la ruta no aparece en el menú de un usuario normal y
 * confirmarle que existe solo le diría dónde insistir.
 */
export default async function UsuariosPage() {
  const actor = await exigirSuperusuaria();

  // Con las desactivadas incluidas: la tabla las esconde por omisión y las
  // enseña con un interruptor, sin volver al servidor.
  const usuarios = await listUsers({
    db: prisma,
    actor: {
      id: actor.id,
      role: actor.role,
      fullName: actor.fullName,
      email: actor.email,
    },
    filters: { includeInactive: true },
  });

  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--wb-accent-ink)]">
            Configuración
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cuentas, propiedades y semanas del calendario.
          </p>
        </div>

        {/* Subnavegación de /config. Va escrita en cada página en lugar de en un
            componente compartido para no tocar archivos de otras tareas. */}
        <nav aria-label="Configuración">
          <ul className="flex gap-1 rounded-lg bg-muted/60 p-1 text-sm">
            <li>
              <span
                aria-current="page"
                className="inline-flex rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
              >
                Usuarios
              </span>
            </li>
            <li>
              <Link
                href="/config/propiedades"
                className="inline-flex rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                Propiedades y semanas
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <section className="grid gap-3">
        <div>
          <h2 className="text-base font-semibold">Usuarios</h2>
          <p className="text-sm text-muted-foreground">
            No existe registro público: todas las cuentas se crean aquí. Las
            cuentas no se borran, se desactivan.
          </p>
        </div>

        <UsersTable usuarios={usuarios} actorId={actor.id} />
      </section>
    </div>
  );
}

/**
 * Exige rol de superusuaria y, si falta, desaparece la página.
 *
 * `notFound()` se llama desde el catch y nunca desde dentro del try: funciona
 * lanzando una excepción de control, y si saliera del bloque vigilado este mismo
 * catch se la tragaría y la convertiría en un 500.
 */
async function exigirSuperusuaria(): Promise<SessionUser> {
  let usuario: SessionUser;
  try {
    usuario = await requireSuperuser();
  } catch (error) {
    if (isAuthError(error)) notFound();
    throw error;
  }
  return usuario;
}
