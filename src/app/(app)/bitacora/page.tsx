/**
 * /bitacora — el registro auditable, SOLO para la superusuaria.
 *
 * «Oculta» significa que ni el menú ni la ruta existen para el resto, pero eso
 * es cortesía de interfaz. La defensa real son dos puertas, y las dos están en
 * el servidor: `requireSuperuser()` aquí y `assertSuperuser()` dentro de
 * `listAuditEntries`. Un usuario normal que teclee la URL recibe un 404, no un
 * 403: confirmar que la página existe ya sería contar de más.
 *
 * Los filtros viajan en la URL (formulario GET), de modo que una consulta se
 * puede guardar en marcadores y compartir, y la página se vuelve a pintar en
 * el servidor con el filtro aplicado. El «Cargar más» es lo único que necesita
 * cliente, y va por cursor: `audit_log` recibe escrituras mientras alguien la
 * lee y un OFFSET repetiría o se saltaría filas (ver audit-queries.ts).
 */

import { notFound, redirect } from "next/navigation";

import {
  AuditTable,
  FiltrosBitacora,
  type OpcionPropiedad,
  type ValoresFiltro,
} from "@/components/admin/audit-table";
import type { AuditAction } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { isAuthError, requireSuperuser, type SessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  listAuditEntries,
  type AuditFilters,
  type AuditPage,
} from "@/server/admin/audit-queries";
import { listProperties } from "@/server/admin/properties";

/** La bitácora es una lectura viva: nunca se sirve de caché. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Bitácora · Wellbros" };

/** Cuántas entradas por tirada. Suficiente para una pantalla larga sin ahogar el JSON. */
const POR_PAGINA = 40;

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Atajos del filtro de acción.
 *
 * Las CLAVES son un contrato con `FiltrosBitacora` (audit-table.tsx), que
 * pinta una opción por cada una. Si añades un grupo, añádelo en los dos sitios.
 * Los valores que no sean una de estas claves se tratan como una acción suelta
 * y se validan contra `AUDIT_ACTIONS`.
 */
const GRUPOS: Readonly<Record<string, readonly AuditAction[]>> = {
  // Lo que el producto prometió no dejar disimulado: cancelaciones ajenas y
  // reservas por encima de la ventana de apertura.
  sensibles: [
    "RESERVATION_CANCELLED_BY_ADMIN",
    "RESERVATION_OUT_OF_WINDOW",
    "RESERVATION_REJECTED_WINDOW",
    "SLOT_CLOSED_WITH_ACTIVE_RESERVATION",
  ],
  reservas: [
    "RESERVATION_CREATED",
    "RESERVATION_CANCELLED",
    "RESERVATION_CANCELLED_BY_ADMIN",
    "RESERVATION_OUT_OF_WINDOW",
    "RESERVATION_REJECTED_WINDOW",
  ],
  semanas: ["SLOT_OPENED", "SLOT_CLOSED", "SLOT_CLOSED_WITH_ACTIVE_RESERVATION"],
  cesiones: ["GRANT_CREATED", "GRANT_REVOKED"],
  usuarios: [
    "USER_CREATED",
    "USER_UPDATED",
    "USER_DEACTIVATED",
    "USER_PASSWORD_CHANGED",
    "USER_REINVITED",
  ],
  propiedades: [
    "PROPERTY_CREATED",
    "PROPERTY_UPDATED",
    "MAINTENANCE_NOTE_CREATED",
    "MAINTENANCE_NOTE_UPDATED",
    "MAINTENANCE_NOTE_DELETED",
    "BOOKING_POLICY_UPDATED",
  ],
  accesos: ["LOGIN_SUCCEEDED", "LOGIN_FAILED", "LOGOUT"],
};

function esAccion(valor: string): valor is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(valor);
}

/**
 * Grupo por su clave, o `null`.
 *
 * `hasOwnProperty` y no `in`: `GRUPOS` es un objeto literal y hereda del
 * prototipo, así que `?accion=constructor` haría que `GRUPOS[clave]` devolviera
 * una función y el `[...acciones]` de abajo reventara con un 500. Un parámetro
 * de URL nunca debe poder alcanzar el prototipo.
 */
function grupoDe(clave: string): readonly AuditAction[] | null {
  return Object.prototype.hasOwnProperty.call(GRUPOS, clave) ? GRUPOS[clave] : null;
}

function primerValor(valor: string | string[] | undefined): string {
  const bruto = Array.isArray(valor) ? valor[0] : valor;
  return typeof bruto === "string" ? bruto.trim() : "";
}

/**
 * Los parámetros llegan de la URL, o sea del teclado de cualquiera. Un valor
 * que no encaje se DESCARTA en silencio en vez de reventar la página: una URL
 * a medio editar no debería devolver un error, solo dejar de filtrar por eso.
 */
function saneados(crudos: Record<string, string | string[] | undefined>): ValoresFiltro {
  const desde = primerValor(crudos.desde);
  const hasta = primerValor(crudos.hasta);
  const accion = primerValor(crudos.accion);
  const propiedad = primerValor(crudos.propiedad);

  return {
    desde: ISO_FECHA.test(desde) && !Number.isNaN(Date.parse(`${desde}T00:00:00Z`)) ? desde : "",
    hasta: ISO_FECHA.test(hasta) && !Number.isNaN(Date.parse(`${hasta}T00:00:00Z`)) ? hasta : "",
    accion: grupoDe(accion) !== null || esAccion(accion) ? accion : "",
    propiedad: UUID.test(propiedad) ? propiedad : "",
  };
}

function aFiltros(valores: ValoresFiltro): AuditFilters {
  const acciones: readonly AuditAction[] | null =
    valores.accion === ""
      ? null
      : (grupoDe(valores.accion) ?? (esAccion(valores.accion) ? [valores.accion] : null));

  return {
    ...(valores.desde !== "" ? { from: valores.desde } : {}),
    ...(valores.hasta !== "" ? { to: valores.hasta } : {}),
    ...(acciones && acciones.length > 0 ? { actions: [...acciones] } : {}),
    ...(valores.propiedad !== "" ? { propertyId: valores.propiedad } : {}),
  };
}

/**
 * Rango invertido. No es un error del sistema —es un dedo resbalado— así que
 * se avisa en la pantalla en vez de lanzar.
 */
function rangoInvertido(valores: ValoresFiltro): boolean {
  return valores.desde !== "" && valores.hasta !== "" && valores.desde > valores.hasta;
}

async function superusuariaOFuera(): Promise<SessionUser> {
  try {
    return await requireSuperuser();
  } catch (error) {
    if (isAuthError(error) && error.code === "UNAUTHENTICATED") {
      redirect("/login?next=%2Fbitacora");
    }
    // Para quien no es la superusuaria, esta ruta sencillamente no existe.
    notFound();
  }
}

export default async function BitacoraPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const usuario = await superusuariaOFuera();
  const valores = saneados(await searchParams);
  const invertido = rangoInvertido(valores);
  const filtros = aFiltros(valores);

  const [propiedades, pagina] = await Promise.all([
    listProperties({ db: prisma, actor: usuario }),
    invertido
      ? Promise.resolve<AuditPage>({ entries: [], nextCursor: null })
      : listAuditEntries({
          db: prisma,
          actor: usuario,
          filters: filtros,
          limit: POR_PAGINA,
        }),
  ]);

  /**
   * Página siguiente. Vuelve a exigir el rol: una acción de servidor es un
   * endpoint público con su propia puerta, y que la página ya lo comprobara no
   * protege a nadie aquí. Los filtros llegan por cierre —van firmados por
   * Next— y aun así `listAuditEntries` los revalida.
   */
  async function cargarMas(cursor: string): Promise<AuditPage> {
    "use server";

    const actor = await requireSuperuser();
    return listAuditEntries({
      db: prisma,
      actor,
      filters: filtros,
      cursor,
      limit: POR_PAGINA,
    });
  }

  const opciones: OpcionPropiedad[] = propiedades.map((p) => ({ id: p.id, name: p.name }));

  // La firma de los filtros como `key`: al cambiarlos, la tabla se vuelve a
  // montar y tira las páginas que ya había acumulado en su estado. Sin esto,
  // «Cargar más» seguiría añadiendo debajo de un listado que ya no corresponde.
  const firma = `${valores.desde}|${valores.hasta}|${valores.accion}|${valores.propiedad}`;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Bitácora</h1>
        <p className="text-sm text-muted-foreground">
          Todo lo que ha pasado en Wellbros, en orden, de lo más reciente a lo más
          antiguo. Solo tú ves esta pantalla y nada de lo que hay aquí se puede editar
          ni borrar.
        </p>
      </header>

      <FiltrosBitacora propiedades={opciones} valores={valores} />

      {invertido ? (
        <p role="alert" className="text-sm text-destructive">
          La fecha «desde» es posterior a la de «hasta»: corrige el rango para ver
          resultados.
        </p>
      ) : null}

      <AuditTable
        key={firma}
        entradas={pagina.entries}
        cursorInicial={pagina.nextCursor}
        cargarMas={cargarMas}
      />
    </div>
  );
}
