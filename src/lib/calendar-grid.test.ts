/**
 * Pruebas de la retícula sobre meses reales de 2026, elegidos porque son los dos
 * casos que rompen cualquier implementación ingenua:
 *   - septiembre 2026 empieza en MARTES y cabe en 5 filas;
 *   - octubre 2026 empieza en JUEVES y necesita una SEXTA fila, porque su última
 *     semana anclada (viernes 30 de octubre) cierra el 5 de noviembre.
 */

import { describe, expect, it } from "vitest";

import {
  addDaysISO,
  agruparDiasEnRangos,
  availabilitiesInGrid,
  buildMonthGrid,
  gridWeekRange,
  dayCellAriaLabel,
  segmentLabel,
  weekRangeText,
  weekStartOf,
  type Availability,
  type CalRow,
  type WeekView,
} from "./calendar-grid";

/** Todas las semanas (viernes) que tocan un mes, con el estado que se le pase. */
function weeksAround(
  monthFirstISO: string,
  availability: Availability = "RESERVABLE",
): WeekView[] {
  const out: WeekView[] = [];
  let cursor = addDaysISO(weekStartOf(monthFirstISO), -7);
  for (let i = 0; i < 8; i++) {
    out.push({
      startDate: cursor,
      endDate: addDaysISO(cursor, 6),
      availability,
    });
    cursor = addDaysISO(cursor, 7);
  }
  return out;
}

function allDates(rows: CalRow[]): string[] {
  return rows.flatMap((r) => r.segments.flatMap((s) => s.days.map((d) => d.date)));
}

describe("buildMonthGrid — forma de la retícula", () => {
  it("septiembre 2026 (empieza martes) da 5 filas, del 30 ago al 3 oct", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: weeksAround("2026-09-01"),
    });

    expect(rows).toHaveLength(5);
    const dates = allDates(rows);
    expect(dates[0]).toBe("2026-08-30"); // domingo anterior al día 1
    expect(dates.at(-1)).toBe("2026-10-03"); // sábado que cierra la retícula
    expect(dates).toHaveLength(35);
  });

  it("octubre 2026 (empieza jueves) da 6 filas: la semana del 30 debe verse entera", () => {
    const rows = buildMonthGrid({
      month: "2026-10",
      weeks: weeksAround("2026-10-01"),
    });

    expect(rows).toHaveLength(6);
    const dates = allDates(rows);
    expect(dates[0]).toBe("2026-09-27");
    expect(dates.at(-1)).toBe("2026-11-07");
    expect(dates).toHaveLength(42);
  });

  it.each(["2026-09", "2026-10", "2026-02", "2026-05", "2027-01"])(
    "toda fila de %s suma exactamente 7 columnas y 7 celdas",
    (month) => {
      const rows = buildMonthGrid({
        month,
        weeks: weeksAround(`${month}-01`),
      });

      for (const row of rows) {
        const columnas = row.segments.reduce((n, s) => n + s.span, 0);
        const celdas = row.segments.reduce((n, s) => n + s.days.length, 0);
        expect(columnas).toBe(7);
        expect(celdas).toBe(7);
        // Siempre dos tramos: 5 (domingo→jueves) + 2 (viernes→sábado).
        expect(row.segments.map((s) => s.span)).toEqual([5, 2]);
      }
    },
  );

  it("las fechas van consecutivas y sin huecos entre tramos y filas", () => {
    const dates = allDates(
      buildMonthGrid({ month: "2026-10", weeks: weeksAround("2026-10-01") }),
    );
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]).toBe(addDaysISO(dates[i - 1]!, 1));
    }
  });

  it("la primera y la última fila traen días de meses vecinos marcados", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: weeksAround("2026-09-01"),
    });

    const primera = rows[0]!.segments[0]!;
    expect(primera.days[0]).toMatchObject({
      date: "2026-08-30",
      dayOfMonth: 30,
      isAdjacentMonth: true,
    });
    expect(primera.days[2]).toMatchObject({
      date: "2026-09-01",
      isAdjacentMonth: false,
    });

    const ultima = rows.at(-1)!.segments.at(-1)!;
    expect(ultima.days.map((d) => d.isAdjacentMonth)).toEqual([true, true]);
  });
});

describe("buildMonthGrid — la semana partida en dos tramos", () => {
  it("la semana del viernes 30-oct-2026 se parte entre la fila de octubre y la de noviembre", () => {
    const rows = buildMonthGrid({
      month: "2026-10",
      weeks: weeksAround("2026-10-01"),
    });

    const cabeza = rows[4]!.segments[1]!; // viernes 30 y sábado 31 de octubre
    const cola = rows[5]!.segments[0]!; // domingo 1 a jueves 5 de noviembre

    expect(cabeza.weekKey).toBe("2026-10-30");
    expect(cola.weekKey).toBe("2026-10-30");
    expect(cabeza.week).toBe(cola.week); // misma semana, misma identidad

    expect(cabeza.days.map((d) => d.date)).toEqual([
      "2026-10-30",
      "2026-10-31",
    ]);
    expect(cola.days.map((d) => d.date)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);

    // El corte: recto por dentro, redondeado por fuera.
    expect(cabeza.openLeft).toBe(false);
    expect(cabeza.openRight).toBe(true);
    expect(cola.openLeft).toBe(true);
    expect(cola.openRight).toBe(false);

    // Los cinco días de noviembre siguen siendo de la semana de octubre,
    // pero se pintan atenuados porque no son del mes en pantalla.
    expect(cola.days.every((d) => d.isAdjacentMonth)).toBe(true);
  });

  it.each(["2026-09", "2026-10"])(
    "en %s los dos tramos de una misma semana comparten weekKey",
    (month) => {
      const rows = buildMonthGrid({ month, weeks: weeksAround(`${month}-01`) });

      for (let i = 0; i < rows.length - 1; i++) {
        const cabeza = rows[i]!.segments[1]!;
        const cola = rows[i + 1]!.segments[0]!;
        expect(cola.weekKey).toBe(cabeza.weekKey);
        expect(cola.availability).toBe(cabeza.availability);
      }
    },
  );

  it("la etiqueta va en el tramo de 5 celdas, nunca en el de 2", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: weeksAround("2026-09-01"),
    });

    for (const row of rows) {
      expect(row.segments[0]!.label).toBe("Disponible");
      expect(row.segments[1]!.label).toBeUndefined();
    }
  });

  it("el weekKey es siempre un viernes", () => {
    const rows = buildMonthGrid({
      month: "2026-10",
      weeks: weeksAround("2026-10-01"),
    });
    for (const row of rows) {
      for (const seg of row.segments) {
        expect(weekStartOf(seg.weekKey)).toBe(seg.weekKey);
      }
    }
  });
});

describe("buildMonthGrid — estados, cesiones y mantenimiento", () => {
  it("una semana ausente de la lista se sintetiza como SIN_APERTURA", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: [
        {
          startDate: "2026-09-04",
          endDate: "2026-09-10",
          availability: "RESERVADA",
          reservedByName: "Ivonne B.",
        },
      ],
    });

    const conReserva = rows
      .flatMap((r) => r.segments)
      .filter((s) => s.weekKey === "2026-09-04");
    expect(conReserva).toHaveLength(2);
    expect(conReserva.every((s) => s.availability === "RESERVADA")).toBe(true);
    expect(conReserva.find((s) => s.span === 5)!.label).toBe("Ivonne B.");
    expect(conReserva.find((s) => s.span === 2)!.label).toBeUndefined();

    const sinSlot = rows[0]!.segments[0]!;
    expect(sinSlot.availability).toBe("SIN_APERTURA");
    expect(sinSlot.label).toBe("Sin apertura");
  });

  it("una semana ausente y ya terminada se sintetiza como PASADA, no SIN_APERTURA", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: [],
      todayISO: "2026-09-20",
    });

    const terminada = rows
      .flatMap((r) => r.segments)
      .find((s) => s.weekKey === "2026-09-04")!;
    const futura = rows
      .flatMap((r) => r.segments)
      .find((s) => s.weekKey === "2026-09-25")!;

    expect(terminada.availability).toBe("PASADA");
    expect(futura.availability).toBe("SIN_APERTURA");
  });

  it("marca hoy, los días cedidos y las notas de mantenimiento", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: [
        {
          startDate: "2026-09-11",
          endDate: "2026-09-17",
          availability: "MIA",
          grants: [
            {
              date: "2026-09-12",
              granteeInitials: "MG",
              granteeName: "Marta García",
            },
            {
              date: "2026-09-13",
              granteeInitials: "MG",
              granteeName: "Marta García",
            },
          ],
        },
      ],
      maintenance: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          startDate: "2026-09-08",
          endDate: "2026-09-08",
          note: "Servicio de aire acondicionado",
          authorName: "Ivonne B.",
        },
      ],
      todayISO: "2026-09-14",
    });

    const celdas = rows.flatMap((r) => r.segments.flatMap((s) => s.days));
    const buscar = (date: string) => celdas.find((c) => c.date === date)!;

    // Las dos cesiones quedan a un lado y otro del corte de fila.
    expect(buscar("2026-09-12").ceded?.granteeInitials).toBe("MG");
    expect(buscar("2026-09-13").ceded?.granteeName).toBe("Marta García");
    expect(buscar("2026-09-14").ceded).toBeUndefined();

    expect(buscar("2026-09-08").maintenance).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        startDate: "2026-09-08",
        endDate: "2026-09-08",
        note: "Servicio de aire acondicionado",
        authorName: "Ivonne B.",
      },
    ]);
    // Sin notas se deja en `undefined`, nunca en un arreglo vacío: la interfaz
    // pregunta `if (cell.maintenance)` para decidir si dibuja el punto ámbar.
    expect(buscar("2026-09-09").maintenance).toBeUndefined();

    expect(buscar("2026-09-14").isToday).toBe(true);
    expect(celdas.filter((c) => c.isToday)).toHaveLength(1);
  });

  it("un día con dos notas las conserva SEPARADAS, no unidas en un texto", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: [],
      maintenance: [
        {
          id: "aaaaaaaa-0000-4000-8000-000000000001",
          startDate: "2026-09-07",
          endDate: "2026-09-09",
          note: "Pintura de la terraza",
          authorName: "Ivonne B.",
        },
        {
          id: "aaaaaaaa-0000-4000-8000-000000000002",
          startDate: "2026-09-08",
          endDate: "2026-09-08",
          note: "Servicio de aire acondicionado",
        },
      ],
    });

    const celdas = rows.flatMap((r) => r.segments.flatMap((s) => s.days));
    const buscar = (date: string) => celdas.find((c) => c.date === date)!;

    // El 8 lo cubren las dos; el 7 y el 9, solo la larga.
    expect(buscar("2026-09-08").maintenance?.map((n) => n.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
    ]);
    expect(buscar("2026-09-07").maintenance).toHaveLength(1);
    expect(buscar("2026-09-09").maintenance).toHaveLength(1);
    expect(buscar("2026-09-10").maintenance).toBeUndefined();

    // Cada nota conserva su rango y su autor: son datos del globo, no adorno.
    const [larga, corta] = buscar("2026-09-08").maintenance!;
    expect(larga).toMatchObject({ endDate: "2026-09-09", authorName: "Ivonne B." });
    expect(corta!.authorName).toBeUndefined();
  });

  it("una cesión solo se aplica a la semana que la declara", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: [
        {
          startDate: "2026-09-11",
          endDate: "2026-09-17",
          availability: "MIA",
          // Fecha fuera de su propia semana: la retícula la ignora en silencio,
          // porque quien valida el rango es el trigger de la base.
          grants: [
            { date: "2026-09-25", granteeInitials: "XX", granteeName: "Otro" },
          ],
        },
      ],
    });

    const celdas = rows.flatMap((r) => r.segments.flatMap((s) => s.days));
    expect(celdas.find((c) => c.date === "2026-09-25")!.ceded).toBeUndefined();
  });

  it("la leyenda solo lista los estados presentes, en orden estable", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: [
        {
          startDate: "2026-09-11",
          endDate: "2026-09-17",
          availability: "MIA",
        },
        {
          startDate: "2026-09-18",
          endDate: "2026-09-24",
          availability: "RESERVABLE",
        },
      ],
    });

    expect(availabilitiesInGrid(rows)).toEqual([
      "RESERVABLE",
      "MIA",
      "SIN_APERTURA",
    ]);
  });
});

describe("textos", () => {
  it("la semana a caballo nombra los dos meses", () => {
    expect(
      weekRangeText({
        startDate: "2026-10-30",
        endDate: "2026-11-05",
        availability: "RESERVABLE",
      }),
    ).toBe("del 30 de octubre al 5 de noviembre");

    expect(
      weekRangeText({
        startDate: "2026-09-11",
        endDate: "2026-09-17",
        availability: "MIA",
      }),
    ).toBe("del 11 al 17 de septiembre");
  });

  it("PROGRAMADA dice cuándo abre, en la zona de negocio", () => {
    const semana: WeekView = {
      startDate: "2026-10-02",
      endDate: "2026-10-08",
      availability: "PROGRAMADA",
      // 16 de septiembre 00:00 en México = 06:00 UTC.
      releaseAt: "2026-09-16T06:00:00.000Z",
    };
    expect(segmentLabel(semana, "2026-08-24")).toBe("Abre el 16 sep");
  });

  it("EN_CURSO cuenta los días que quedan, para no prometer siete", () => {
    const semana: WeekView = {
      startDate: "2026-09-11",
      endDate: "2026-09-17",
      availability: "EN_CURSO",
    };
    expect(segmentLabel(semana, "2026-09-15")).toBe("En curso · quedan 3 días");
    expect(segmentLabel(semana, "2026-09-17")).toBe("En curso · queda 1 día");
  });

  it("cada celda anuncia a qué semana pertenece, aunque el tramo esté partido", () => {
    const rows = buildMonthGrid({
      month: "2026-09",
      weeks: [
        {
          startDate: "2026-09-11",
          endDate: "2026-09-17",
          availability: "MIA",
          grants: [
            {
              date: "2026-09-13",
              granteeInitials: "MG",
              granteeName: "Marta García",
            },
          ],
        },
      ],
    });

    const segmento = rows
      .flatMap((r) => r.segments)
      .find((s) => s.weekKey === "2026-09-11" && s.span === 5)!;
    const celda = segmento.days.find((d) => d.date === "2026-09-13")!;

    expect(dayCellAriaLabel(celda, segmento)).toBe(
      "domingo 13 de septiembre, semana del 11 al 17 de septiembre, tu reserva, día cedido a Marta García",
    );
  });

  it("la etiqueta hablada lee el mantenimiento, y con varias notas dice cuántas", () => {
    const construir = (notas: { id: string; note: string }[]) => {
      const rows = buildMonthGrid({
        month: "2026-09",
        weeks: [
          {
            startDate: "2026-09-11",
            endDate: "2026-09-17",
            availability: "RESERVABLE",
          },
        ],
        maintenance: notas.map((n) => ({
          ...n,
          startDate: "2026-09-13",
          endDate: "2026-09-13",
        })),
      });
      const segmento = rows
        .flatMap((r) => r.segments)
        .find((s) => s.weekKey === "2026-09-11" && s.span === 5)!;
      return dayCellAriaLabel(
        segmento.days.find((d) => d.date === "2026-09-13")!,
        segmento,
      );
    };

    expect(construir([{ id: "n1", note: "Cambio de boiler" }])).toBe(
      "domingo 13 de septiembre, semana del 11 al 17 de septiembre, disponible, mantenimiento: Cambio de boiler",
    );

    // Con dos, el número va DELANTE: sin él no se sabe si es una frase larga
    // o dos hechos distintos.
    expect(
      construir([
        { id: "n1", note: "Cambio de boiler" },
        { id: "n2", note: "Fumigación" },
      ]),
    ).toBe(
      "domingo 13 de septiembre, semana del 11 al 17 de septiembre, disponible, 2 notas de mantenimiento: Cambio de boiler; Fumigación",
    );
  });
});

describe("agruparDiasEnRangos: de fichas sueltas a notas guardables", () => {
  it("un solo día da un tramo de un día", () => {
    expect(agruparDiasEnRangos(["2026-09-12"])).toEqual([
      { startDate: "2026-09-12", endDate: "2026-09-12" },
    ]);
  });

  it("días contiguos se funden en UN tramo", () => {
    expect(
      agruparDiasEnRangos(["2026-09-11", "2026-09-12", "2026-09-13"]),
    ).toEqual([{ startDate: "2026-09-11", endDate: "2026-09-13" }]);
  });

  it("días salteados dan VARIOS tramos, nunca uno que cubra el hueco", () => {
    // Sábado y martes de la misma semana: dos notas. Una sola del 12 al 15
    // pintaría domingo y lunes en el calendario de todos, anunciando una obra
    // que esos días no existe.
    expect(agruparDiasEnRangos(["2026-09-12", "2026-09-15"])).toEqual([
      { startDate: "2026-09-12", endDate: "2026-09-12" },
      { startDate: "2026-09-15", endDate: "2026-09-15" },
    ]);
  });

  it("mezcla de tramos y días sueltos, en desorden y con repetidos", () => {
    expect(
      agruparDiasEnRangos([
        "2026-09-15",
        "2026-09-11",
        "2026-09-12",
        "2026-09-15",
        "2026-09-17",
        "2026-09-11",
      ]),
    ).toEqual([
      { startDate: "2026-09-11", endDate: "2026-09-12" },
      { startDate: "2026-09-15", endDate: "2026-09-15" },
      { startDate: "2026-09-17", endDate: "2026-09-17" },
    ]);
  });

  it("un día repetido no alarga el tramo ni lo parte", () => {
    expect(agruparDiasEnRangos(["2026-09-12", "2026-09-12"])).toEqual([
      { startDate: "2026-09-12", endDate: "2026-09-12" },
    ]);
  });

  it("la continuidad se mide en días reales: cruza el fin de mes y el año bisiesto", () => {
    expect(agruparDiasEnRangos(["2026-10-31", "2026-11-01"])).toEqual([
      { startDate: "2026-10-31", endDate: "2026-11-01" },
    ]);
    // 2028 es bisiesto: el 29 de febrero existe y encadena.
    expect(
      agruparDiasEnRangos(["2028-02-28", "2028-03-01", "2028-02-29"]),
    ).toEqual([{ startDate: "2028-02-28", endDate: "2028-03-01" }]);
    // 2026 no lo es: entre el 28 de febrero y el 1 de marzo no hay hueco.
    expect(agruparDiasEnRangos(["2026-02-28", "2026-03-01"])).toEqual([
      { startDate: "2026-02-28", endDate: "2026-03-01" },
    ]);
  });

  it("sin días no hay tramos", () => {
    expect(agruparDiasEnRangos([])).toEqual([]);
  });

  it("rechaza fechas mal formadas o inexistentes, esté donde esté la mala", () => {
    expect(() => agruparDiasEnRangos(["2026-09-12", "12/09/2026"])).toThrow(
      /Fecha inválida/,
    );
    expect(() => agruparDiasEnRangos(["2026-02-30"])).toThrow(/inexistente/);
    // La validación va ANTES de ordenar: una fecha que quedaría al final
    // también revienta.
    expect(() => agruparDiasEnRangos(["2026-13-01", "2026-09-12"])).toThrow(
      RangeError,
    );
  });
});

describe("entradas inválidas", () => {
  it("rechaza un mes mal formado", () => {
    expect(() => buildMonthGrid({ month: "2026-9", weeks: [] })).toThrow(
      /Mes inválido/,
    );
  });

  it("rechaza una fecha inexistente", () => {
    expect(() => addDaysISO("2026-02-30", 1)).toThrow(/inexistente/);
  });
});

describe("gridWeekRange: qué semanas hay que traer de la base", () => {
  /*
   * Este es el punto que más fácil rompe la integración. La retícula NO se
   * conforma con las semanas ancladas al mes: siempre asoman dos más, la del
   * último viernes del mes anterior y la del primer viernes del siguiente.
   * Si el contenedor consulta solo por anchor_month, esas dos llegan vacías y
   * una semana realmente reservada se pinta "Sin apertura" en el borde.
   */
  it("septiembre 2026 abarca del viernes 28-ago al viernes 2-oct", () => {
    const r = gridWeekRange("2026-09");
    expect(r.gridStart).toBe("2026-08-30"); // domingo
    expect(r.gridEnd).toBe("2026-10-03"); // sábado
    expect(r.firstWeekStart).toBe("2026-08-28");
    expect(r.lastWeekStart).toBe("2026-10-02");
  });

  it("octubre 2026 llega hasta la semana del 30-oct, que cierra en noviembre", () => {
    const r = gridWeekRange("2026-10");
    expect(r.firstWeekStart).toBe("2026-09-25");
    // La sexta fila (1-7 nov) cierra la semana del 30-oct y ADEMÁS abre la del
    // 6-nov con sus dos primeras celdas: la retícula toca más semanas de las
    // que el mes ancla, que es justo lo que este helper existe para revelar.
    expect(r.lastWeekStart).toBe("2026-11-06");
  });

  it("el rango cubre TODAS las semanas que la retícula llega a pintar", () => {
    for (let anio = 2024; anio <= 2032; anio++) {
      for (let mes = 1; mes <= 12; mes++) {
        const month = `${anio}-${String(mes).padStart(2, "0")}`;
        const rango = gridWeekRange(month);
        const filas = buildMonthGrid({ month, weeks: [] });

        const usadas = new Set<string>();
        for (const fila of filas) {
          for (const seg of fila.segments) usadas.add(seg.week.startDate);
        }

        for (const inicio of usadas) {
          expect(
            inicio >= rango.firstWeekStart && inicio <= rango.lastWeekStart,
            `${month}: la semana ${inicio} se pinta pero queda fuera del rango ${rango.firstWeekStart}…${rango.lastWeekStart}`,
          ).toBe(true);
        }

        // Y al revés: el rango no debe pedir semanas que nadie pinta.
        expect(usadas.has(rango.firstWeekStart)).toBe(true);
        expect(usadas.has(rango.lastWeekStart)).toBe(true);
      }
    }
  });

  it("todos los límites son viernes, domingo y sábado como corresponde", () => {
    for (let mes = 1; mes <= 12; mes++) {
      const r = gridWeekRange(`2027-${String(mes).padStart(2, "0")}`);
      expect(weekStartOf(r.firstWeekStart)).toBe(r.firstWeekStart);
      expect(weekStartOf(r.lastWeekStart)).toBe(r.lastWeekStart);
      expect(new Date(`${r.gridStart}T00:00:00Z`).getUTCDay()).toBe(0);
      expect(new Date(`${r.gridEnd}T00:00:00Z`).getUTCDay()).toBe(6);
    }
  });

  it("rechaza un mes con formato inválido", () => {
    expect(() => gridWeekRange("2026-13")).toThrow(RangeError); // no se normaliza a enero
    expect(() => gridWeekRange("septiembre")).toThrow(RangeError);
    expect(() => gridWeekRange("2026-9")).toThrow(RangeError);
  });
});
