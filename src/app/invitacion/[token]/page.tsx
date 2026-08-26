/**
 * /invitacion/[token] — la puerta de entrada de quien acaba de ser dado de alta.
 *
 * Es PÚBLICA: quien llega aquí no tiene cuenta abierta todavía, y el token del
 * enlace es su única credencial.
 *
 * ⚠ PARA EL INTEGRADOR — `src/proxy.ts` NO ES DE ESTE AGENTE Y HAY QUE TOCARLO.
 * Ese filtro redirige a /login todo lo que no esté en su lista blanca, así que
 * hoy este enlace rebota antes de llegar aquí. Hace falta añadir el PREFIJO
 * (no una ruta exacta: el token cambia en cada enlace) a `PUBLIC_PREFIXES`:
 *
 *     const PUBLIC_PREFIXES = ["/api/webhooks/", "/invitacion/"];
 *
 * Sin eso la funcionalidad entera queda muerta, y el síntoma es engañoso: el
 * correo llega bien, el enlace existe y aun así todo el mundo aterriza en la
 * pantalla de acceso.
 *
 * POR QUÉ ESTÁ FUERA DEL GRUPO (app): ese layout exige sesión y manda a /login
 * a quien no la tenga, que es exactamente todo el mundo aquí.
 *
 * A QUIEN YA TIENE SESIÓN NO SE LE ECHA. Sería lo aparentemente prudente, pero
 * el caso normal de un enlace clicado desde el correo del teléfono es que la
 * persona a la que va dirigido lo abra; y rebotarla a un calendario que no es
 * suyo sería incomprensible. El canje escribe la cookie de sesión de la cuenta
 * del token, así que quien lo abra acaba dentro de esa cuenta y de ninguna otra.
 *
 * El token viaja en la RUTA y no en un campo oculto: es lo que permite que el
 * enlace del correo funcione con un solo clic. Está en la URL, sí —como en
 * cualquier flujo de este tipo— y por eso dura 48 horas, sirve una sola vez y
 * muere en cuanto se canjea.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { KeyRound, LogIn, MailQuestion } from "lucide-react";

import {
  AceptarInvitacionForm,
  type EstadoInvitacion,
} from "@/components/aceptar-invitacion-form";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { hashPassword, setSessionCookie, createSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { clientIpFromHeaders } from "@/server/auth/login";
import {
  redeemInvitation,
  verifyAccessToken,
  type TokenFailureReason,
} from "@/server/auth/tokens";
import { z } from "zod";

/** Depende del estado del token en la base: jamás de caché. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Crea tu acceso · Wellbros" };

/**
 * Mismas reglas que el resto del proyecto: `MIN_CONTRASENA` de
 * src/server/admin/users.ts y el nombre de `nombreSchema`. Se repiten aquí
 * porque aquellos son privados de su módulo; si cambian allá, cambian aquí.
 */
const MIN_CONTRASENA = 12;

const canjeSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3, "Escribe tu nombre completo (al menos 3 caracteres)")
      .max(120, "El nombre no puede pasar de 120 caracteres"),
    password: z
      .string()
      .min(MIN_CONTRASENA, `Necesita al menos ${MIN_CONTRASENA} caracteres`)
      // Argon2 hashea lo que le den; el tope evita que un cuerpo enorme se
      // convierta en trabajo de CPU gratis para quien lo mande.
      .max(200, "No puede pasar de 200 caracteres"),
    confirmPassword: z.string().min(1, "Repite la contraseña"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Las dos contraseñas no coinciden",
  });

type Campo = "fullName" | "password" | "confirmPassword";

/** Primer mensaje de cada campo; con dos en el mismo campo basta el primero. */
function erroresPorCampo(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): Partial<Record<Campo, string>> {
  const campos: readonly Campo[] = ["fullName", "password", "confirmPassword"];
  const salida: Partial<Record<Campo, string>> = {};
  for (const issue of issues) {
    const clave = issue.path[0];
    if (typeof clave !== "string") continue;
    const campo = campos.find((c) => c === clave);
    if (campo && salida[campo] === undefined) salida[campo] = issue.message;
  }
  return salida;
}

// ═══════════════════════════════════════════════════════════════ página

export default async function InvitacionPage({
  params,
}: {
  /** En Next 16 los params de la ruta son una PROMESA: hay que esperarlos. */
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const comprobacion = await verifyAccessToken(prisma, {
    token,
    purpose: "INVITACION",
  });

  if (!comprobacion.ok) {
    return <EnlaceMuerto motivo={comprobacion.reason} />;
  }

  const { subject } = comprobacion;

  /**
   * Canje. Es una acción de servidor y por tanto un endpoint público: no se fía
   * de nada de lo que llegue en el formulario y vuelve a exigir el token, que
   * NO viaja en un campo sino cerrado sobre esta función (Next lo cifra junto
   * con el resto de argumentos ligados). Ni siquiera el correo llega del
   * cliente: la cuenta la decide el token y solo el token.
   */
  async function aceptar(
    _previo: EstadoInvitacion,
    formData: FormData,
  ): Promise<EstadoInvitacion> {
    "use server";

    const fullName = String(formData.get("fullName") ?? "");
    const entrada = {
      fullName,
      password: String(formData.get("password") ?? ""),
      confirmPassword: String(formData.get("confirmPassword") ?? ""),
    };

    const analizado = canjeSchema.safeParse(entrada);
    if (!analizado.success) {
      return {
        ok: false,
        mensaje: "Revisa los campos marcados.",
        errores: erroresPorCampo(analizado.error.issues),
        fullName,
      };
    }

    const cabeceras = await headers();
    const ip = clientIpFromHeaders(cabeceras);

    // Argon2 ANTES de abrir la transacción: cuesta unos 200 ms y tenerla
    // abierta ese rato sostendría bloqueos para nada.
    const passwordHash = await hashPassword(analizado.data.password);

    const canje = await redeemInvitation({
      db: prisma,
      token,
      fullName: analizado.data.fullName,
      passwordHash,
      ip,
    });

    if (!canje.ok) {
      // El enlace murió entre que se pintó la pantalla y se envió el
      // formulario: caducó mientras se escribía, o alguien lo canjeó antes, o
      // la administración mandó uno nuevo. Se dice, no se disimula.
      return {
        ok: false,
        mensaje: `${textoDelFallo(canje.reason)} Vuelve a abrir el enlace más reciente o pide uno nuevo a la administración.`,
        errores: {},
        fullName,
      };
    }

    // La sesión se crea DESPUÉS y fuera de la transacción del canje:
    // `createSession` trabaja con el cliente global de Prisma y no admite un
    // `tx`. El orden es el mismo que en `login()` y por el mismo motivo: si
    // esto fallara, la contraseña ya está puesta y la persona entra por /login;
    // al revés quedaría una sesión abierta de una cuenta sin contraseña.
    const sesion = await createSession(canje.userId, {
      ip,
      userAgent: cabeceras.get("user-agent"),
    });
    await setSessionCookie(sesion.token, sesion.expiresAt);

    // `redirect` funciona lanzando una excepción de control: tiene que quedar
    // fuera de cualquier try/catch o se tragaría la navegación.
    redirect("/");
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>

      <main className="flex flex-1 items-start justify-center px-4 pb-16 sm:items-center">
        <div className="w-full max-w-sm">
          <header className="mb-6 flex flex-col items-center gap-3 text-center">
            <span
              className="flex size-11 items-center justify-center rounded-full bg-[var(--wb-accent-soft)] text-[var(--wb-accent-ink)]"
              aria-hidden
            >
              <KeyRound className="size-5" />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">
              Bienvenido a Wellbros
            </h1>
            <p className="text-sm text-muted-foreground">
              Ya tienes cuenta para reservar las semanas de las propiedades
              compartidas. Solo falta que elijas tu contraseña:{" "}
              <strong className="font-medium">nadie más la conocerá</strong>, ni
              siquiera quien te dio de alta.
            </p>
          </header>

          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <AceptarInvitacionForm
              action={aceptar}
              nombreInicial={subject.fullName}
              correo={subject.email}
            />
          </div>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            Este enlace sirve una sola vez y caduca a las 48 horas de haberse
            enviado.
          </p>
        </div>
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════════════════ enlace muerto

/**
 * Qué se le dice a quien llega con un enlace que ya no sirve.
 *
 * SE DISTINGUEN LOS MOTIVOS, y es una decisión meditada. En una pantalla de
 * acceso normal jamás se detalla el fallo, porque el mensaje se convierte en un
 * oráculo para averiguar qué correos existen. Aquí no hay tal riesgo: para ver
 * cualquiera de estos textos hay que tener ya en la mano un token de 256 bits,
 * que no se adivina ni se enumera. Quien lo tiene es, casi con certeza, su
 * dueña — y decirle «ya lo usaste, entra con tu contraseña» en vez de un muro
 * genérico le ahorra una llamada a la administración.
 *
 * Lo que NO se distingue es la cuenta desactivada: eso sí es información sobre
 * otra persona y cae en el mensaje neutro.
 */
function textoDelFallo(motivo: TokenFailureReason): string {
  switch (motivo) {
    case "YA_USADO":
      return "Este enlace ya se usó: la cuenta está abierta y tiene contraseña.";
    case "CADUCADO":
      return "Este enlace caducó. Los enlaces de alta duran 48 horas.";
    case "REEMPLAZADO":
      return "Este enlace quedó anulado porque se envió otro más reciente.";
    default:
      return "Este enlace no sirve para entrar.";
  }
}

function EnlaceMuerto({ motivo }: { motivo: TokenFailureReason }) {
  const yaEntro = motivo === "YA_USADO";

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>

      <main className="flex flex-1 items-start justify-center px-4 pb-16 sm:items-center">
        <div className="w-full max-w-sm">
          <header className="mb-6 flex flex-col items-center gap-3 text-center">
            <span
              className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
              aria-hidden
            >
              <MailQuestion className="size-5" />
            </span>
            {/* Ni una palabra que suene a reproche: quien llega aquí no ha
                hecho nada mal. Un enlace caduca por el paso del tiempo, y que
                el correo tardara en leerse no es culpa de nadie. */}
            <h1 className="text-2xl font-semibold tracking-tight">
              {yaEntro ? "Tu cuenta ya está lista" : "Este enlace ya no sirve"}
            </h1>
            <p className="text-sm text-muted-foreground">{textoDelFallo(motivo)}</p>
          </header>

          <div className="rounded-xl border border-border bg-card p-6 text-sm shadow-sm">
            {yaEntro ? (
              <p className="text-muted-foreground">
                Entra con tu correo y la contraseña que elegiste. Si no la
                recuerdas, pídele a la administración que te mande un enlace
                nuevo.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Pídele a la administración que te envíe uno nuevo: desde la
                pantalla de cuentas puede reenviarte la invitación en un clic, y
                te llegará al mismo correo.
              </p>
            )}

            <Button
              render={<Link href="/login" />}
              // De verdad es un ENLACE y no un botón: navega a otra página, y
              // como tal debe poder abrirse en pestaña nueva o copiarse. Sin
              // `nativeButton={false}`, Base UI avisa de que le están quitando
              // la semántica nativa a un <button> que en realidad es un <a>.
              nativeButton={false}
              size="lg"
              className="mt-4 h-10 w-full"
            >
              <LogIn className="size-4" aria-hidden />
              Ir a la pantalla de acceso
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
