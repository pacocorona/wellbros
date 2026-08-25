/**
 * /perfil — lo que cada quien puede cambiar sobre sí mismo.
 *
 * La página solo resuelve la sesión y reparte datos; toda la interacción vive
 * en `<ProfileForm>` (cliente, por `useActionState`) y toda la escritura en
 * `@/server/actions/profile-actions`, que vuelve a resolver la sesión por su
 * cuenta: una acción de servidor es un endpoint público y no se fía de que la
 * página ya hubiera comprobado nada.
 *
 * El layout de (app) ya exige sesión; `requireUser()` se repite aquí porque
 * esa comprobación es del layout, no de esta ruta, y mañana la página podría
 * moverse de grupo.
 */

import { redirect } from "next/navigation";

import { ProfileForm } from "@/components/profile-form";
import { Badge } from "@/components/ui/badge";
import { isAuthError, requireUser, type SessionUser } from "@/lib/auth";

/** Datos de la sesión en curso: nunca de caché. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Perfil · Wellbros" };

async function usuarioOLogin(): Promise<SessionUser> {
  try {
    return await requireUser();
  } catch (error) {
    if (isAuthError(error)) redirect("/login?next=%2Fperfil");
    throw error;
  }
}

export default async function PerfilPage() {
  const usuario = await usuarioOLogin();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Tu perfil</h1>
          {usuario.role === "SUPERUSER" ? (
            <Badge variant="secondary">Superusuaria</Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Tus datos, tu contraseña y cómo se ve Wellbros para ti.
        </p>
      </header>

      <ProfileForm
        fullName={usuario.fullName}
        phone={usuario.phone ?? ""}
        email={usuario.email}
        esSuperusuaria={usuario.role === "SUPERUSER"}
      />
    </div>
  );
}
