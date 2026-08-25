/**
 * El calendario: la pantalla principal tras entrar (§04).
 *
 * Es un Server Component y hace exactamente cuatro cosas —resolver quién mira,
 * qué propiedad y qué mes, traer el calendario y construir la retícula— para
 * entregárselo todo ya masticado a `<CalendarView />`. Ninguna decisión de
 * negocio se toma aquí: el estado de cada semana lo resuelve
 * `getMonthCalendar` y la retícula la arma `buildMonthGrid`.
 *
 * EL RELOJ SE RESUELVE UNA SOLA VEZ (`ahora`) y se pasa a todo lo que lo
 * necesita. Con dos llamadas a `new Date()` separadas por unos milisegundos,
 * dos consultas podrían caer a distintos lados de una apertura de mes y la
 * pantalla se contradiría a sí misma justo en el momento más delicado.
 *
 * Las listas de propiedades y de personas se leen con Prisma aquí mismo, sin
 * pasar por `@/server/admin`: aquellas funciones exigen superusuaria
 * (`assertSuperuser`) porque sirven al panel de administración, y esto es la
 * portada de cualquiera. Son dos SELECT de dos columnas sobre tablas de
 * decenas de filas; no hay regla de negocio que extraer a un servicio.
 */

import { redirect } from "next/navigation";
import { CalendarOff } from "lucide-react";

import { CalendarView } from "@/components/calendar/calendar-view";
import { getCurrentUser } from "@/lib/auth";
import { businessToday } from "@/lib/booking-window";
import { buildMonthGrid } from "@/lib/calendar-grid";
import { prisma } from "@/lib/db";
import { coercePropertyColor } from "@/lib/property-color";
import { loadBookingPolicy } from "@/server/calendar/policy";
import { getMonthCalendar } from "@/server/calendar/queries";

/** `yyyy-MM` con mes real. El año se acota para no aceptar basura infinita. */
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

interface PaginaProps {
  /** En Next 16 los searchParams son una PROMESA: hay que esperarlos. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Un parámetro repetido (`?mes=a&mes=b`) se queda con el primero. */
function primerValor(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

function mesValido(valor: string | undefined): string | undefined {
  if (!valor) return undefined;
  const m = MES_RE.exec(valor);
  if (!m) return undefined;
  const anio = Number(m[1]);
  return anio >= 2000 && anio <= 2999 ? valor : undefined;
}

export default async function CalendarioPage({ searchParams }: PaginaProps) {
  const usuario = await getCurrentUser();
  // El layout del grupo (app) ya rechaza a quien no tiene sesión. Esto no es
  // redundancia decorativa: una página es su propia puerta y mañana puede
  // moverse de grupo.
  if (!usuario) redirect("/login");

  const parametros = await searchParams;
  const ahora = new Date();

  // `color` es el color de identidad de cada propiedad: tiñe el cromo del
  // calendario para que se note al instante en qué casa se está mirando. La
  // columna tiene CHECK y valor por omisión en la base, pero se normaliza
  // igualmente con `coercePropertyColor`: la interfaz trabaja con la unión
  // cerrada de ocho valores, no con el `string` que devuelve Prisma, y así una
  // fila con un valor inesperado sale índigo en lugar de dejar el cromo sin
  // color.
  const propiedades = (
    await prisma.property.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    })
  ).map((p) => ({
    id: p.id,
    name: p.name,
    color: coercePropertyColor(p.color),
  }));

  if (propiedades.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border p-10 text-center">
        <CalendarOff className="size-6 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">Todavía no hay propiedades</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {usuario.role === "SUPERUSER"
            ? "Da de alta una propiedad en Configuración y abre sus primeras semanas."
            : "Cuando la administración dé de alta una propiedad, sus semanas aparecerán aquí."}
        </p>
      </div>
    );
  }

  const propiedadPedida = primerValor(parametros.propiedad);
  // Una propiedad desconocida (o desactivada) no es un error que merezca una
  // pantalla en blanco: se cae a la primera y la interfaz corrige la URL.
  const propiedad =
    propiedades.find((p) => p.id === propiedadPedida) ?? propiedades[0];

  // La política se lee ANTES que el calendario a propósito: `loadBookingPolicy`
  // está memorizada por petición y con los mismos argumentos, así que la
  // llamada interna de `getMonthCalendar` reutiliza esta lectura.
  const politica = await loadBookingPolicy(prisma, propiedad.id);

  // `?semana=` es el enlace profundo que llevan los correos: apunta al viernes
  // de una semana concreta, cuyo mes es el que hay que abrir.
  const semanaPedida = primerValor(parametros.semana);
  const mes =
    mesValido(primerValor(parametros.mes)) ??
    mesValido(semanaPedida?.slice(0, 7)) ??
    businessToday(ahora, politica).slice(0, 7);

  const calendario = await getMonthCalendar({
    db: prisma,
    propertyId: propiedad.id,
    month: mes,
    viewer: usuario,
    now: ahora,
  });

  const filas = buildMonthGrid({
    month: mes,
    weeks: calendario.weeks,
    maintenance: calendario.maintenance,
    todayISO: calendario.todayISO,
    timeZone: calendario.policy.timeZone,
  });

  // Candidatos a recibir días cedidos. Se traen siempre —son pocos— para que
  // abrir el panel de una semana propia no dispare otra consulta.
  const usuarios = await prisma.user.findMany({
    where: { isActive: true, NOT: { id: usuario.id } },
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true },
  });

  return (
    <CalendarView
      mes={mes}
      filas={filas}
      propiedades={propiedades}
      propiedadId={propiedad.id}
      propiedadDesdeUrl={propiedad.id === propiedadPedida}
      puedeMesAnterior={calendario.canNavigatePrev}
      puedeMesSiguiente={calendario.canNavigateNext}
      visor={{
        id: usuario.id,
        fullName: usuario.fullName,
        esSuperusuaria: usuario.role === "SUPERUSER",
      }}
      usuarios={usuarios}
      hoyISO={calendario.todayISO}
      zonaHoraria={calendario.policy.timeZone}
      ahoraServidorISO={ahora.toISOString()}
    />
  );
}
