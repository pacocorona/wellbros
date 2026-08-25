import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MaintenanceNotes } from "@/components/admin/maintenance-dialog";
import { PropertiesList } from "@/components/admin/properties-list";
import { SlotManager, type SemanaAdmin } from "@/components/admin/slot-manager";
import { isAuthError, requireSuperuser, type SessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { listMaintenanceNotes } from "@/server/admin/maintenance";
import { listProperties } from "@/server/admin/properties";
import {
  etiquetaSemana,
  hoyDeNegocio,
  isoDeFecha,
  type AdminActor,
} from "@/server/admin/users";

export const metadata: Metadata = {
  title: "Propiedades y semanas · Wellbros",
};

/**
 * /config/propiedades — propiedades, gestor de semanas y notas de mantenimiento.
 * Solo la superusuaria (ver la nota de la página de usuarios sobre el 404).
 *
 * La propiedad elegida viaja en `?propiedad=` para que el enlace sea compartible
 * y para que este componente de servidor pueda traer SUS semanas: sin recargar
 * no habría de dónde sacarlas, porque el gestor no consulta la base por su
 * cuenta.
 */
export default async function PropiedadesPage({
  searchParams,
}: {
  // En Next 16 los `searchParams` de una página son una promesa.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const usuario = await exigirSuperusuaria();
  const actor: AdminActor = {
    id: usuario.id,
    role: usuario.role,
    fullName: usuario.fullName,
    email: usuario.email,
  };

  const parametros = await searchParams;
  const pedida = primerValor(parametros.propiedad);
  const hoyISO = hoyDeNegocio();

  const propiedades = await listProperties({ db: prisma, actor });

  // Si la URL trae una propiedad que no existe (enlace viejo, id inventado) se
  // cae a la primera activa en vez de dejar la pantalla en blanco.
  const seleccionada =
    propiedades.find((p) => p.id === pedida) ??
    propiedades.find((p) => p.isActive) ??
    propiedades[0] ??
    null;

  const [semanas, notas] = seleccionada
    ? await Promise.all([
        semanasDe(seleccionada.id),
        listMaintenanceNotes({ db: prisma, actor, propertyId: seleccionada.id }),
      ])
    : [[], []];

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

        {/* Ver la nota de la página de usuarios: la subnavegación se repite en
            lugar de vivir en un componente compartido. */}
        <nav aria-label="Configuración">
          <ul className="flex gap-1 rounded-lg bg-muted/60 p-1 text-sm">
            <li>
              <Link
                href="/config/usuarios"
                className="inline-flex rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                Usuarios
              </Link>
            </li>
            <li>
              <span
                aria-current="page"
                className="inline-flex rounded-md bg-background px-3 py-1.5 font-medium shadow-sm"
              >
                Propiedades y semanas
              </span>
            </li>
          </ul>
        </nav>
      </header>

      <section className="grid gap-3">
        <div>
          <h2 className="text-base font-semibold">Propiedades</h2>
          <p className="text-sm text-muted-foreground">
            El nombre es el que aparece en el combo del calendario. Las
            propiedades no se borran, se desactivan.
          </p>
        </div>

        <PropertiesList
          propiedades={propiedades}
          seleccionadaId={seleccionada?.id ?? null}
        />
      </section>

      <section className="grid gap-3">
        <div>
          <h2 className="text-base font-semibold">Gestor de semanas</h2>
          <p className="text-sm text-muted-foreground">
            Cada semana va de viernes 00:00 a jueves 23:59. Abrirlas no las
            reserva: solo las pone a disposición según la ventana vigente.
          </p>
        </div>

        <SlotManager
          propiedades={propiedades.map((p) => ({
            id: p.id,
            name: p.name,
            isActive: p.isActive,
          }))}
          seleccionada={
            seleccionada
              ? {
                  id: seleccionada.id,
                  name: seleccionada.name,
                  isActive: seleccionada.isActive,
                }
              : null
          }
          semanas={semanas}
          hoyISO={hoyISO}
        />
      </section>

      {seleccionada ? (
        <section className="grid gap-3">
          <div>
            <h2 className="text-base font-semibold">
              Notas de mantenimiento · {seleccionada.name}
            </h2>
          </div>

          <MaintenanceNotes
            propiedad={{ id: seleccionada.id, name: seleccionada.name }}
            notas={notas}
          />
        </section>
      ) : null}
    </div>
  );
}

/**
 * Semanas de una propiedad, con el nombre de quien la tiene reservada.
 *
 * Se traen TODAS y no solo un tramo: el resumen previo de la apertura en lote
 * necesita saber qué viernes existen ya, incluso fuera del rango en pantalla, y
 * partir la consulta obligaría a decir «3 ya estaban abiertas» sin poder
 * garantizarlo. Con dos propiedades y unas decenas de semanas al año esto son
 * unos cientos de filas; el día que sean miles, hay que filtrar por fecha aquí y
 * consultar aparte los viernes existentes del rango elegido.
 *
 * Para el integrador: esta lectura debería vivir como `listWeekSlots()` en
 * `src/server/admin/slots.ts`; está aquí porque ese archivo pertenece a otra
 * tarea y no se toca desde esta.
 */
async function semanasDe(propertyId: string): Promise<SemanaAdmin[]> {
  const filas = await prisma.weekSlot.findMany({
    where: { propertyId },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      status: true,
      // El índice único parcial garantiza como mucho UNA reserva ACTIVE por
      // slot, así que este arreglo trae cero o un elemento.
      reservations: {
        where: { status: "ACTIVE" },
        select: { user: { select: { fullName: true } } },
      },
    },
    orderBy: { startDate: "asc" },
  });

  return filas.map((slot) => {
    const inicio = isoDeFecha(slot.startDate);
    const fin = isoDeFecha(slot.endDate);
    return {
      slotId: slot.id,
      startDate: inicio,
      endDate: fin,
      // La etiqueta se redacta en el servidor y con la misma función que usan
      // los correos: así la semana se llama igual en todas partes.
      label: etiquetaSemana(inicio, fin),
      status: slot.status,
      reservedByName: slot.reservations[0]?.user.fullName ?? null,
    };
  });
}

function primerValor(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

/** Ver la nota homónima en /config/usuarios: `notFound()` fuera del try. */
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
