/**
 * Pruebas de la vista de móvil: la parte que NO es dibujo.
 *
 * Lo que se comprueba aquí es la traducción de filas a semanas, que es donde
 * está el riesgo de verdad: la retícula parte cada semana en dos tramos y una
 * tarjeta por tramo sería el doble de tarjetas, todas a medias. Se prueba la
 * función pura; el aspecto de la tarjeta se mira con los ojos.
 */

import { describe, expect, it } from "vitest";

import {
  addDaysISO,
  buildMonthGrid,
  dayOfWeekISO,
  gridWeekRange,
  type WeekView,
} from "@/lib/calendar-grid";

import { rangoSemanaCorto, semanasDeLaRejilla } from "./week-cards";

const MES = "2026-09";

describe("semanasDeLaRejilla — una tarjeta por semana", () => {
  it("deduplica los dos tramos: hay una semana por cada viernes de la retícula", () => {
    const filas = buildMonthGrid({ month: MES, weeks: [] });
    const semanas = semanasDeLaRejilla(filas, { month: MES });

    // Cada fila aporta su cabeza; la primera aporta además la cola de la
    // semana que venía de antes. Con dos tramos por fila y sin deduplicar
    // saldrían `filas.length * 2` tarjetas.
    expect(semanas).toHaveLength(filas.length + 1);

    const claves = semanas.map((s) => s.weekKey);
    expect(new Set(claves).size).toBe(claves.length);
    for (const clave of claves) expect(dayOfWeekISO(clave)).toBe(5);
  });

  it("las devuelve en orden cronológico", () => {
    const semanas = semanasDeLaRejilla(
      buildMonthGrid({ month: MES, weeks: [] }),
      { month: MES },
    );
    const claves = semanas.map((s) => s.weekKey);
    expect(claves).toEqual([...claves].sort());
  });

  it("cada tarjeta trae los siete días, de viernes a jueves", () => {
    const semanas = semanasDeLaRejilla(
      buildMonthGrid({ month: MES, weeks: [] }),
      { month: MES },
    );

    for (const semana of semanas) {
      expect(semana.days).toHaveLength(7);
      semana.days.forEach((dia, i) => {
        expect(dia.date).toBe(addDaysISO(semana.weekKey, i));
      });
      expect(dayOfWeekISO(semana.days[6]!.date)).toBe(4); // jueves
    }
  });
});

describe("semanasDeLaRejilla — la semana del borde del mes", () => {
  /** La última fila enseña solo el viernes y el sábado de esta semana. */
  const { lastWeekStart } = gridWeekRange(MES);

  const semanaDelBorde: WeekView = {
    startDate: lastWeekStart,
    endDate: addDaysISO(lastWeekStart, 6),
    availability: "MIA",
    grants: [
      {
        // Lunes: cae FUERA de la retícula de septiembre.
        date: addDaysISO(lastWeekStart, 3),
        granteeInitials: "MG",
        granteeName: "María G.",
      },
    ],
  };

  const ultima = () => {
    const filas = buildMonthGrid({ month: MES, weeks: [semanaDelBorde] });
    return semanasDeLaRejilla(filas, { month: MES }).at(-1)!;
  };

  it("completa los cinco días que la retícula no pinta", () => {
    const semana = ultima();
    expect(semana.weekKey).toBe(lastWeekStart);
    expect(semana.days).toHaveLength(7);
    expect(semana.days.at(-1)!.date).toBe(addDaysISO(lastWeekStart, 6));
  });

  it("recupera de la semana las cesiones de esos días", () => {
    // Sin esto, una tarjeta enseñaría el día como libre porque su celda no
    // existe en ninguna fila: el dato está en `week.grants`, no en la retícula.
    expect(ultima().days[3]!.ceded).toEqual({
      granteeInitials: "MG",
      granteeName: "María G.",
    });
  });

  it("le calcula la etiqueta que su tramo largo se llevó fuera", () => {
    // El tramo de dos celdas nunca trae `label`; sin el respaldo, esta tarjeta
    // —y solo esta, una por mes— saldría con el chip vacío.
    expect(ultima().label).toBe("Tu reserva");
  });
});

describe("rangoSemanaCorto", () => {
  it("dice el mes una vez cuando la semana no lo cruza", () => {
    expect(rangoSemanaCorto("2026-09-18", "2026-09-24")).toBe(
      "Vie 18 – Jue 24 sep",
    );
  });

  it("dice los dos meses cuando la semana cambia de mes", () => {
    expect(rangoSemanaCorto("2026-08-28", "2026-09-03")).toBe(
      "Vie 28 ago – Jue 3 sep",
    );
  });
});
