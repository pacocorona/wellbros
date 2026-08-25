/**
 * Pruebas de la capa de consulta CONTRA LA BASE REAL (localhost:5434).
 *
 * Se prueba contra PostgreSQL y no contra un doble porque lo que aquí puede
 * romperse no es la lógica de JavaScript: es la frontera con la base —cómo
 * vuelve una columna `date`, si el rango de viernes trae las semanas del borde,
 * si el trigger de la ventana deja insertar los datos de prueba—. Un mock
 * repetiría mis suposiciones y pasaría siempre.
 *
 * CADA prueba siembra sus propios datos dentro de una transacción que TERMINA
 * EN ROLLBACK, así que no toca «Casa del Lago», ni «Departamento Playa», ni la
 * superusuaria, y no deja una sola fila detrás aunque falle a la mitad.
 *
 * El reloj de la aplicación se inyecta fijo (24 de agosto de 2026, mediodía en
 * México) para que los estados no dependan del día en que se corran las
 * pruebas. El reloj de la BASE, en cambio, es el real: el trigger de la ventana
 * usa `now()` de PostgreSQL, y por eso la reserva de una semana pasada se
 * inserta al final, con el bypass explícito.
 */

// Antes que nada: @/lib/db exige DATABASE_URL al evaluarse, y los módulos ESM
// se evalúan en el orden en que se importan.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

import { loadBookingPolicy } from "./policy";
import { getMonthCalendar, initialsOf } from "./queries";

/** Mediodía del 24 de agosto de 2026 en México (UTC-6, sin horario de verano). */
const AHORA = new Date("2026-08-24T18:00:00.000Z");

/**
 * Viernes que se abren en la propiedad de prueba: de julio a noviembre de 2026.
 * Se escriben a mano, uno por uno, en vez de generarlos: si la aritmética de
 * fechas de la aplicación se rompiera, una lista calculada se rompería con ella
 * y la prueba seguiría en verde. Además el CHECK de la base (ISODOW = 5)
 * rechaza la lista entera si alguno no fuera viernes.
 */
const VIERNES = [
  "2026-07-24",
  "2026-07-31",
  "2026-08-07",
  "2026-08-14",
  "2026-08-21",
  "2026-08-28",
  "2026-09-04",
  "2026-09-11",
  "2026-09-18",
  "2026-09-25",
  "2026-10-02",
  "2026-10-09",
  "2026-10-16",
  "2026-10-23",
  "2026-10-30",
  "2026-11-06",
] as const;

interface Contexto {
  propiedadId: string;
  /** Quien mira el calendario en las pruebas. */
  ana: { id: string; nombre: string; correo: string };
  /** La otra copropietaria: sus semanas deben salir como RESERVADA. */
  beto: { id: string; nombre: string; correo: string };
  /** id del slot por su viernes de inicio. */
  slotPorViernes: Map<string, string>;
}

/** `yyyy-MM-dd` → medianoche UTC, que es como Prisma escribe un `@db.Date`. */
function fechaUTC(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Inversa de `fechaUTC`, leyendo componentes UTC (nunca los locales). */
function isoDeFecha(fecha: Date): string {
  const mes = String(fecha.getUTCMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getUTCDate()).padStart(2, "0");
  return `${fecha.getUTCFullYear()}-${mes}-${dia}`;
}

async function sembrar(tx: Prisma.TransactionClient): Promise<Contexto> {
  // Marca única: si dos corridas se solaparan, no chocarían por el nombre.
  const marca = randomUUID().slice(0, 8);

  const propiedad = await tx.property.create({
    data: { name: `Prueba calendario ${marca}` },
    select: { id: true },
  });

  const crearUsuario = async (nombre: string, alias: string) => {
    const correo = `${alias}.${marca}@prueba.invalid`;
    const fila = await tx.user.create({
      // El hash no se verifica en ninguna de estas pruebas: no hay login.
      data: { email: correo, fullName: nombre, passwordHash: "sin-hash" },
      select: { id: true },
    });
    return { id: fila.id, nombre, correo };
  };

  const ana = await crearUsuario("Ana Ruiz", "ana");
  const beto = await crearUsuario("Beto Sosa", "beto");

  // SQL crudo y no tx.weekSlot.create(): end_date y anchor_month son COLUMNAS
  // GENERADAS y PostgreSQL rechaza (428C9) cualquier INSERT que las mencione.
  // Es el mismo motivo por el que prisma/seed.ts las abre así.
  for (const inicio of VIERNES) {
    await tx.$executeRaw`
      INSERT INTO week_slots (property_id, start_date, created_by)
      VALUES (${propiedad.id}::uuid, ${inicio}::date, ${ana.id}::uuid)
    `;
  }

  const slots = await tx.weekSlot.findMany({
    where: { propertyId: propiedad.id },
    select: { id: true, startDate: true },
  });
  const slotPorViernes = new Map<string, string>(
    slots.map((s) => [isoDeFecha(s.startDate), s.id]),
  );

  const slot = (viernes: string): string => {
    const id = slotPorViernes.get(viernes);
    if (!id) throw new Error(`Falta el slot del ${viernes} en la siembra`);
    return id;
  };

  // Semana de otra persona → debe salir RESERVADA con su nombre.
  await tx.reservation.create({
    data: { slotId: slot("2026-09-11"), userId: beto.id },
  });

  // Semana propia → MIA, con un día cedido a Beto (sábado 19).
  const mia = await tx.reservation.create({
    data: { slotId: slot("2026-09-18"), userId: ana.id },
    select: { id: true },
  });
  await tx.dayGrant.create({
    data: {
      reservationId: mia.id,
      grantorUserId: ana.id,
      granteeUserId: beto.id,
      grantDate: fechaUTC("2026-09-19"),
    },
  });

  // Semana cerrada por la superusuaria.
  await tx.weekSlot.update({
    where: { id: slot("2026-09-25") },
    data: { status: "CLOSED" },
  });

  // Nota que CRUZA el cambio de mes: tiene que verse en septiembre y en octubre.
  await tx.maintenanceNote.create({
    data: {
      propertyId: propiedad.id,
      startDate: fechaUTC("2026-09-30"),
      endDate: fechaUTC("2026-10-02"),
      note: "Pintura de la terraza",
      createdById: ana.id,
    },
  });

  // AL FINAL, y no antes: reservar una semana ya terminada infringe la ventana,
  // así que hay que abrir el bypass del trigger. El GUC es local a la
  // transacción, pero una vez encendido vale para todo lo que venga después;
  // dejándolo de último, las reservas de arriba se validan de verdad.
  await tx.$executeRaw`SELECT set_config('wellbros.window_override', 'on', true)`;
  await tx.reservation.create({
    data: {
      slotId: slot("2026-08-07"),
      userId: ana.id,
      overrideReason: "Datos de prueba: semana pasada",
    },
  });

  return { propiedadId: propiedad.id, ana, beto, slotPorViernes };
}

/** Señal para deshacer la transacción sin que parezca un fallo de la prueba. */
const DESHACER = Symbol("rollback");

/**
 * Siembra, ejecuta el cuerpo con el cliente de la transacción y DESHACE todo.
 *
 * Pasar `tx` como `db` no es un atajo de las pruebas: es el contrato de
 * `getMonthCalendar`, que acepta tanto el cliente global como el de una
 * transacción para poder leer dentro de la misma transacción que muta.
 */
async function conDatos(
  cuerpo: (tx: Prisma.TransactionClient, ctx: Contexto) => Promise<void>,
): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const ctx = await sembrar(tx);
        await cuerpo(tx, ctx);
        throw DESHACER;
      },
      // La siembra son ~25 sentencias; los 5 s por defecto se quedan cortos
      // en una máquina fría.
      { maxWait: 10_000, timeout: 30_000 },
    );
  } catch (error) {
    if (error !== DESHACER) throw error;
  }
}

describe("getMonthCalendar — estados de la semana", () => {
  it("una semana reservada por otra persona sale RESERVADA con su nombre y sin datos de contacto", async () => {
    await conDatos(async (tx, ctx) => {
      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-09",
        viewer: { id: ctx.ana.id, role: "USER" },
        now: AHORA,
      });

      const semana = cal.weeks.find((w) => w.startDate === "2026-09-11");
      expect(semana?.availability).toBe("RESERVADA");
      expect(semana?.reservedByName).toBe("Beto Sosa");
      expect(semana?.reservationId).toBeTruthy();
      // Ya abrió: `releaseAt` solo tiene sentido en PROGRAMADA.
      expect(semana?.releaseAt).toBeUndefined();

      // El calendario lo ve toda la familia: ni correo ni teléfono, en ningún
      // rincón del objeto.
      expect(JSON.stringify(semana)).not.toContain(ctx.beto.correo);
    });
  });

  it("la semana propia sale MIA, sin repetir el nombre, y con sus días cedidos", async () => {
    await conDatos(async (tx, ctx) => {
      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-09",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });

      const semana = cal.weeks.find((w) => w.startDate === "2026-09-18");
      expect(semana?.availability).toBe("MIA");
      expect(semana?.reservedByName).toBeUndefined();
      expect(semana?.grants).toEqual([
        {
          date: "2026-09-19",
          granteeName: "Beto Sosa",
          granteeInitials: "BS",
        },
      ]);
    });
  });

  it("la MISMA semana es RESERVADA para quien no la reservó", async () => {
    await conDatos(async (tx, ctx) => {
      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-09",
        viewer: { id: ctx.beto.id },
        now: AHORA,
      });

      const semana = cal.weeks.find((w) => w.startDate === "2026-09-18");
      expect(semana?.availability).toBe("RESERVADA");
      expect(semana?.reservedByName).toBe("Ana Ruiz");
      // La cesión se ve igual: quién usa cada día es información de todos.
      expect(semana?.grants?.[0]?.granteeInitials).toBe("BS");
    });
  });

  it("una semana de octubre vista el 24 de agosto sale PROGRAMADA con su fecha de apertura", async () => {
    await conDatos(async (tx, ctx) => {
      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-10",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });

      const semana = cal.weeks.find((w) => w.startDate === "2026-10-09");
      expect(semana?.availability).toBe("PROGRAMADA");
      // Octubre abre 15 días exactos antes del día 1: el 16 de septiembre a las
      // 00:00 de México, que en UTC son las 06:00. Es un INSTANTE, no una fecha.
      expect(semana?.releaseAt).toBe("2026-09-16T06:00:00.000Z");
    });
  });

  it("PASADA gana a RESERVADA: una semana terminada no muestra titular", async () => {
    await conDatos(async (tx, ctx) => {
      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-08",
        viewer: { id: ctx.beto.id },
        now: AHORA,
      });

      // La reservó Ana (con bypass, ver la siembra), pero ya terminó.
      const semana = cal.weeks.find((w) => w.startDate === "2026-08-07");
      expect(semana?.availability).toBe("PASADA");
      expect(semana?.reservedByName).toBeUndefined();
    });
  });

  it("la semana en curso sale EN_CURSO y la cerrada, CERRADA", async () => {
    await conDatos(async (tx, ctx) => {
      const agosto = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-08",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });
      // El 24 de agosto cae dentro de la semana del viernes 21.
      expect(
        agosto.weeks.find((w) => w.startDate === "2026-08-21")?.availability,
      ).toBe("EN_CURSO");

      const septiembre = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-09",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });
      expect(
        septiembre.weeks.find((w) => w.startDate === "2026-09-25")
          ?.availability,
      ).toBe("CERRADA");
    });
  });
});

describe("getMonthCalendar — rango de la retícula", () => {
  it("septiembre trae las DOS semanas del borde, las de agosto y octubre", async () => {
    await conDatos(async (tx, ctx) => {
      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-09",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });

      // La retícula de septiembre va del domingo 30 de agosto al sábado 3 de
      // octubre: la primera semana arranca el viernes 28 de AGOSTO y la última
      // el viernes 2 de OCTUBRE. Consultando por anchor_month faltarían las dos.
      expect(cal.weeks.map((w) => w.startDate)).toEqual([
        "2026-08-28",
        "2026-09-04",
        "2026-09-11",
        "2026-09-18",
        "2026-09-25",
        "2026-10-02",
      ]);

      // Y no vienen mudas: la del borde de octubre trae su estado real.
      const bordeAgosto = cal.weeks[0];
      const bordeOctubre = cal.weeks[cal.weeks.length - 1];
      expect(bordeAgosto.availability).toBe("RESERVABLE");
      expect(bordeOctubre.availability).toBe("PROGRAMADA");
    });
  });

  it("octubre trae desde el 25 de septiembre hasta el 6 de noviembre (seis filas)", async () => {
    await conDatos(async (tx, ctx) => {
      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-10",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });

      expect(cal.weeks[0].startDate).toBe("2026-09-25");
      expect(cal.weeks[cal.weeks.length - 1].startDate).toBe("2026-11-06");
    });
  });

  it("las notas de mantenimiento que cruzan el cambio de mes salen en ambos meses", async () => {
    await conDatos(async (tx, ctx) => {
      const comun = {
        db: tx,
        propertyId: ctx.propiedadId,
        viewer: { id: ctx.ana.id },
        now: AHORA,
      };

      const septiembre = await getMonthCalendar({ ...comun, month: "2026-09" });
      const octubre = await getMonthCalendar({ ...comun, month: "2026-10" });

      // El `id` y el nombre de quien la escribió viajan con la nota: el globo
      // del calendario los necesita para separar una nota de otra y decir de
      // quién es cada una.
      const esperada = {
        id: expect.any(String),
        startDate: "2026-09-30",
        endDate: "2026-10-02",
        note: "Pintura de la terraza",
        authorName: ctx.ana.nombre,
      };
      expect(septiembre.maintenance).toEqual([esperada]);
      expect(octubre.maintenance).toEqual([esperada]);

      // Julio no la toca: su retícula termina el 8 de agosto.
      const julio = await getMonthCalendar({ ...comun, month: "2026-07" });
      expect(julio.maintenance).toEqual([]);
    });
  });
});

describe("getMonthCalendar — las fechas no se corren un día", () => {
  it("cada fecha coincide, carácter por carácter, con el texto que guarda PostgreSQL", async () => {
    await conDatos(async (tx, ctx) => {
      // `::text` lo formatea la propia base: es la verdad, sin husos horarios
      // de por medio. Si se leyera el `Date` de Prisma con getDate() en vez de
      // getUTCDate(), en México saldría el día anterior.
      const crudas = await tx.$queryRaw<
        { id: string; inicio: string; fin: string }[]
      >`
        SELECT id::text AS id, start_date::text AS inicio, end_date::text AS fin
          FROM week_slots
         WHERE property_id = ${ctx.propiedadId}::uuid
      `;
      const porId = new Map(crudas.map((f) => [f.id, f]));

      for (const mes of ["2026-08", "2026-09", "2026-10"]) {
        const cal = await getMonthCalendar({
          db: tx,
          propertyId: ctx.propiedadId,
          month: mes,
          viewer: { id: ctx.ana.id },
          now: AHORA,
        });

        expect(cal.weeks.length).toBeGreaterThan(0);
        for (const semana of cal.weeks) {
          const cruda = porId.get(semana.slotId ?? "");
          expect(cruda).toBeDefined();
          expect(semana.startDate).toBe(cruda?.inicio);
          expect(semana.endDate).toBe(cruda?.fin);
          // Y sigue siendo viernes → jueves después del viaje de ida y vuelta.
          expect(new Date(`${semana.startDate}T00:00:00Z`).getUTCDay()).toBe(5);
          expect(new Date(`${semana.endDate}T00:00:00Z`).getUTCDay()).toBe(4);
        }
      }

      // El día cedido corre el mismo riesgo y también se compara contra el texto.
      const cesiones = await tx.$queryRaw<{ dia: string }[]>`
        SELECT g.grant_date::text AS dia
          FROM day_grants g
          JOIN reservations r ON r.id = g.reservation_id
          JOIN week_slots s ON s.id = r.slot_id
         WHERE s.property_id = ${ctx.propiedadId}::uuid
      `;
      expect(cesiones.map((c) => c.dia)).toEqual(["2026-09-19"]);

      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-09",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });
      const mia = cal.weeks.find((w) => w.startDate === "2026-09-18");
      expect(mia?.grants?.[0]?.date).toBe("2026-09-19");
    });
  });
});

describe("getMonthCalendar — navegación y política", () => {
  it("la flecha de mes siguiente se apaga al llegar al horizonte visible", async () => {
    await conDatos(async (tx, ctx) => {
      const comun = {
        db: tx,
        propertyId: ctx.propiedadId,
        viewer: { id: ctx.ana.id },
        now: AHORA,
      };

      // Horizonte por defecto: 6 meses desde agosto de 2026 → febrero de 2027.
      const septiembre = await getMonthCalendar({ ...comun, month: "2026-09" });
      expect(septiembre.canNavigateNext).toBe(true);

      const enero = await getMonthCalendar({ ...comun, month: "2027-01" });
      expect(enero.canNavigateNext).toBe(true);

      const febrero = await getMonthCalendar({ ...comun, month: "2027-02" });
      expect(febrero.canNavigateNext).toBe(false);
    });
  });

  it("la flecha de mes anterior se apaga cuando ya no hay semanas más atrás", async () => {
    await conDatos(async (tx, ctx) => {
      const comun = {
        db: tx,
        propertyId: ctx.propiedadId,
        viewer: { id: ctx.ana.id },
        now: AHORA,
      };

      // La semana más antigua de la propiedad empieza el 24 de julio de 2026.
      const agosto = await getMonthCalendar({ ...comun, month: "2026-08" });
      expect(agosto.canNavigatePrev).toBe(true);

      const julio = await getMonthCalendar({ ...comun, month: "2026-07" });
      expect(julio.canNavigatePrev).toBe(false);
    });
  });

  it("devuelve la política vigente y hoy en la zona de negocio", async () => {
    await conDatos(async (tx, ctx) => {
      const cal = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-09",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });

      expect(cal.policy.timeZone).toBe("America/Mexico_City");
      expect(cal.policy.bookingWindowDays).toBe(15);
      expect(cal.policy.policyId).toBeTruthy();
      expect(cal.todayISO).toBe("2026-08-24");
    });
  });

  it("una propiedad sin política propia hereda la global", async () => {
    await conDatos(async (tx, ctx) => {
      const global = await tx.bookingPolicy.findFirst({
        where: { propertyId: null },
        orderBy: { effectiveFrom: "desc" },
        select: { id: true },
      });

      const politica = await loadBookingPolicy(tx, ctx.propiedadId);
      expect(politica.policyId).toBe(global?.id);
    });
  });

  it("la política específica de la propiedad le gana a la global", async () => {
    await conDatos(async (tx, ctx) => {
      // El ORDER BY debe poner los NULL al final; si no, ganaría la global.
      const propia = await tx.bookingPolicy.create({
        data: {
          propertyId: ctx.propiedadId,
          bookingWindowDays: 30,
          visibleHorizonMonths: 2,
          // Fecha de vigencia ANTERIOR a la de la global sembrada por la
          // migración: si el criterio fuera solo "la más reciente", perdería.
          effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
        },
        select: { id: true },
      });

      const politica = await loadBookingPolicy(tx, ctx.propiedadId);
      expect(politica.policyId).toBe(propia.id);
      expect(politica.bookingWindowDays).toBe(30);

      // Y la ventana ampliada se NOTA en el calendario: con 30 días de
      // anticipación octubre abre el 1 de septiembre, no el 16. Sigue
      // PROGRAMADA el 24 de agosto, pero con otra fecha de apertura.
      const octubre = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-10",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });
      const semana = octubre.weeks.find((w) => w.startDate === "2026-10-09");
      expect(semana?.availability).toBe("PROGRAMADA");
      expect(semana?.releaseAt).toBe("2026-09-01T06:00:00.000Z");

      // Horizonte de 2 meses desde agosto → octubre es el último navegable.
      expect(octubre.canNavigateNext).toBe(false);
      const septiembre = await getMonthCalendar({
        db: tx,
        propertyId: ctx.propiedadId,
        month: "2026-09",
        viewer: { id: ctx.ana.id },
        now: AHORA,
      });
      expect(septiembre.canNavigateNext).toBe(true);
    });
  });
});

describe("initialsOf", () => {
  it("toma la primera letra del nombre y la del último apellido", () => {
    expect(initialsOf("Marta González")).toBe("MG");
    expect(initialsOf("Ana María Ruiz Palacios")).toBe("AP");
    expect(initialsOf("  Ivonne   Buenfil  ")).toBe("IB");
  });

  it("con un solo término devuelve una sola letra en vez de inventar la segunda", () => {
    expect(initialsOf("Ivonne")).toBe("I");
    expect(initialsOf("")).toBe("");
  });
});
