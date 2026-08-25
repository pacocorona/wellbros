/**
 * Batería de pruebas de la ventana de apertura de reservas.
 *
 * Todo corre con reloj fijo: `isWeekBookable` recibe `now` inyectado, así que no
 * se toca ningún reloj falso global. Los instantes se escriben en UTC (`...Z`)
 * porque es la única forma inequívoca de fijar un punto en la línea del tiempo.
 *
 * México eliminó el horario de verano en 2022 (DOF 27-oct-2022): la zona de
 * negocio America/Mexico_City es UTC-6 TODO el año. Por eso la conversión
 * "hora de pared → UTC" es una suma fija de 6 horas y no depende de la estación.
 * Si algún día se reinstaura el horario de verano, el helper `enMexico` es el
 * único punto que hay que tocar (y estas pruebas empezarán a fallar, que es
 * justo lo que se quiere).
 */

import { TZDate } from "@date-fns/tz";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOOKING_WINDOW,
  businessToday,
  isWeekBookable,
  maxOpenAnchorMonth,
  maxVisibleMonth,
  monthReleaseAt,
  toISODate,
  weekAnchorMonth,
  weekReleaseAt,
  type BookingWindowConfig,
} from "@/lib/booking-window";

const ZONA = "America/Mexico_City";

/** Desfase fijo de la zona de negocio, en horas. Ver cabecera. */
const DESFASE_MX = 6;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hora de pared de México → instante absoluto.
 * `enMexico("2026-08-17")` es exactamente `new Date("2026-08-17T06:00:00.000Z")`.
 */
function enMexico(
  fechaISO: string,
  hora = 0,
  minuto = 0,
  segundo = 0,
  ms = 0,
): Date {
  const [y, m, d] = fechaISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hora + DESFASE_MX, minuto, segundo, ms));
}

/** Instante como cadena UTC, para comparar en los `expect` de forma legible. */
function utc(d: Date): string {
  return new Date(d.getTime()).toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Fecha civil `yyyy-MM-dd` a partir de un Date interpretado en UTC. */
function isoUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Genera `cantidad` viernes consecutivos a partir de uno dado.
 * La aritmética va en UTC puro: aquí solo interesa el calendario, no la hora.
 */
function viernesConsecutivos(primerViernesISO: string, cantidad: number): string[] {
  const [y, m, d] = primerViernesISO.split("-").map(Number);
  const semilla = new Date(Date.UTC(y, m - 1, d));
  if (semilla.getUTCDay() !== 5) {
    throw new Error(`${primerViernesISO} no es viernes; la prueba está mal escrita`);
  }
  return Array.from({ length: cantidad }, (_, i) =>
    isoUTC(new Date(Date.UTC(y, m - 1, d + i * 7))),
  );
}

/** Primer día del mes en la zona de negocio, listo para `monthReleaseAt`. */
function inicioDeMes(anio: number, mes: number): TZDate {
  return new TZDate(anio, mes - 1, 1, 0, 0, 0, 0, ZONA);
}

/** Número de días del mes anterior a (anio, mes). */
function diasDelMesAnterior(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes - 1, 0)).getUTCDate();
}

function diasDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/** Instante en que termina una semana: el viernes siguiente a las 00:00. */
function finDeSemana(viernesISO: string): Date {
  return new Date(enMexico(viernesISO).getTime() + 7 * 86_400_000);
}

function cfg(parcial: Partial<BookingWindowConfig>): BookingWindowConfig {
  return { ...DEFAULT_BOOKING_WINDOW, ...parcial };
}

/**
 * Cierra un barrido de propiedad.
 *
 * En los barridos grandes (decenas de miles de iteraciones) pagar un `expect`
 * por iteración domina el tiempo de la suite, así que se acumulan los fallos
 * como texto y se afirma una sola vez. Se muestran los primeros para que el
 * diagnóstico siga siendo inmediato.
 */
function sinFallos(fallos: string[], iteraciones: number, minimo: number): void {
  expect(fallos.slice(0, 8)).toEqual([]);
  // Guarda contra un filtro mal escrito que deje el barrido vacío.
  expect(iteraciones).toBeGreaterThanOrEqual(minimo);
}

/** Todos los meses `[anio, mes]` de un rango inclusivo. */
function mesesEntre(
  desde: [number, number],
  hasta: [number, number],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let [y, m] = desde;
  while (y < hasta[0] || (y === hasta[0] && m <= hasta[1])) {
    out.push([y, m]);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 0. Cimientos: que el propio andamio de la prueba sea correcto       */
/* ------------------------------------------------------------------ */

describe("cimientos de la propia batería", () => {
  it("la zona de negocio es UTC-6 fija: medianoche civil = 06:00Z en enero y en julio", () => {
    expect(utc(enMexico("2026-01-15"))).toBe("2026-01-15T06:00:00.000Z");
    expect(utc(enMexico("2026-07-15"))).toBe("2026-07-15T06:00:00.000Z");
    // El módulo debe coincidir con el helper: si México reinstaura el DST,
    // esta comparación es la que revienta primero.
    expect(utc(monthReleaseAt(inicioDeMes(2026, 7)))).toBe(
      utc(enMexico("2026-06-16")),
    );
  });

  it("la configuración por defecto refleja las decisiones confirmadas", () => {
    expect(DEFAULT_BOOKING_WINDOW).toMatchObject({
      timeZone: ZONA,
      mode: "OFFSET_DAYS",
      bookingWindowDays: 15,
      anchorOffsetDays: 0,
      allowInProgressWeek: true,
      superuserOverride: "ALWAYS_EXEMPT",
    });
  });
});

/* ------------------------------------------------------------------ */
/* 1. Fechas de apertura en modo OFFSET_DAYS                           */
/* ------------------------------------------------------------------ */

describe("1. apertura en modo OFFSET_DAYS (15 días exactos antes del día 1)", () => {
  const casos: Array<{
    mes: string;
    anio: number;
    numeroMes: number;
    abre: string;
    instanteUTC: string;
    viernesDeMuestra: string;
  }> = [
    {
      mes: "septiembre 2026",
      anio: 2026,
      numeroMes: 9,
      abre: "2026-08-17",
      instanteUTC: "2026-08-17T06:00:00.000Z",
      viernesDeMuestra: "2026-09-04",
    },
    {
      mes: "octubre 2026",
      anio: 2026,
      numeroMes: 10,
      abre: "2026-09-16",
      instanteUTC: "2026-09-16T06:00:00.000Z",
      viernesDeMuestra: "2026-10-02",
    },
    {
      mes: "noviembre 2026",
      anio: 2026,
      numeroMes: 11,
      abre: "2026-10-17",
      instanteUTC: "2026-10-17T06:00:00.000Z",
      viernesDeMuestra: "2026-11-06",
    },
    {
      mes: "diciembre 2026",
      anio: 2026,
      numeroMes: 12,
      abre: "2026-11-16",
      instanteUTC: "2026-11-16T06:00:00.000Z",
      viernesDeMuestra: "2026-12-04",
    },
    {
      mes: "marzo 2027 (febrero de 28 días)",
      anio: 2027,
      numeroMes: 3,
      abre: "2027-02-14",
      instanteUTC: "2027-02-14T06:00:00.000Z",
      viernesDeMuestra: "2027-03-05",
    },
    {
      mes: "marzo 2028 (febrero bisiesto, 29 días)",
      anio: 2028,
      numeroMes: 3,
      abre: "2028-02-15",
      instanteUTC: "2028-02-15T06:00:00.000Z",
      viernesDeMuestra: "2028-03-03",
    },
  ];

  it.each(casos)(
    "$mes abre el $abre a las 00:00 de México",
    ({ anio, numeroMes, abre, instanteUTC }) => {
      const release = monthReleaseAt(inicioDeMes(anio, numeroMes));
      expect(toISODate(release)).toBe(abre);
      expect(utc(release)).toBe(instanteUTC);
      // Redundante a propósito: el instante literal `...Z` deja claro el desfase.
      expect(release.getTime()).toBe(new Date(instanteUTC).getTime());
    },
  );

  it.each(casos)(
    "una semana de $mes hereda la apertura de su mes ancla",
    ({ abre, instanteUTC, viernesDeMuestra }) => {
      expect(utc(weekReleaseAt(viernesDeMuestra))).toBe(instanteUTC);
      expect(toISODate(weekReleaseAt(viernesDeMuestra))).toBe(abre);
    },
  );

  it("las fechas de muestra son realmente viernes", () => {
    for (const { viernesDeMuestra } of casos) {
      const [y, m, d] = viernesDeMuestra.split("-").map(Number);
      expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay(), viernesDeMuestra).toBe(5);
    }
  });

  it("el día de apertura es SIEMPRE 'longitud del mes anterior menos 14' (2026-2028)", () => {
    for (const [anio, mes] of mesesEntre([2026, 2], [2028, 12])) {
      const release = monthReleaseAt(inicioDeMes(anio, mes));
      const diaEsperado = diasDelMesAnterior(anio, mes) - 14;
      const mesAnterior = mes === 1 ? 12 : mes - 1;
      const anioAnterior = mes === 1 ? anio - 1 : anio;
      const etiqueta = `apertura de ${anio}-${pad2(mes)}`;

      expect(release.getDate(), etiqueta).toBe(diaEsperado);
      expect(release.getMonth() + 1, etiqueta).toBe(mesAnterior);
      expect(release.getFullYear(), etiqueta).toBe(anioAnterior);
      // El rango 14..17 no es casual: es 28..31 menos 14.
      expect(diaEsperado).toBeGreaterThanOrEqual(14);
      expect(diaEsperado).toBeLessThanOrEqual(17);
    }
  });

  it("la apertura cae siempre DENTRO del mes anterior, nunca dos meses antes", () => {
    for (const [anio, mes] of mesesEntre([2026, 1], [2028, 12])) {
      const inicio = inicioDeMes(anio, mes);
      const release = monthReleaseAt(inicio);
      expect(release.getTime()).toBeLessThan(inicio.getTime());
      // 15 días exactos: nunca se sale al antepenúltimo mes porque ningún mes
      // tiene menos de 28 días.
      expect(inicio.getTime() - release.getTime()).toBe(15 * 86_400_000);
    }
  });

  it("respeta releaseHour y releaseMinute", () => {
    const conHora = cfg({ releaseHour: 9, releaseMinute: 30 });
    expect(utc(monthReleaseAt(inicioDeMes(2026, 9), conHora))).toBe(
      "2026-08-17T15:30:00.000Z",
    );
  });

  it("un bookingWindowDays distinto mueve la apertura de forma proporcional", () => {
    const treintaDias = cfg({ bookingWindowDays: 30 });
    expect(toISODate(monthReleaseAt(inicioDeMes(2026, 9), treintaDias))).toBe(
      "2026-08-02",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. Modo FIXED_DAY                                                   */
/* ------------------------------------------------------------------ */

describe("2. modo FIXED_DAY: el día fijo se recorta con LEAST(día, longitud del mes)", () => {
  const dia31 = cfg({ mode: "FIXED_DAY", releaseDayOfMonth: 31 });

  it("con releaseDayOfMonth=31, marzo 2027 abre el 28-feb-2027 (febrero de 28 días)", () => {
    const release = monthReleaseAt(inicioDeMes(2027, 3), dia31);
    expect(toISODate(release)).toBe("2027-02-28");
    expect(utc(release)).toBe("2027-02-28T06:00:00.000Z");
  });

  it("con releaseDayOfMonth=31, marzo 2028 abre el 29-feb-2028 (bisiesto)", () => {
    const release = monthReleaseAt(inicioDeMes(2028, 3), dia31);
    expect(toISODate(release)).toBe("2028-02-29");
    expect(utc(release)).toBe("2028-02-29T06:00:00.000Z");
  });

  it("con releaseDayOfMonth=31 nunca desborda al mes siguiente en ningún mes de 2026-2028", () => {
    for (const [anio, mes] of mesesEntre([2026, 1], [2028, 12])) {
      const release = monthReleaseAt(inicioDeMes(anio, mes), dia31);
      const mesAnterior = mes === 1 ? 12 : mes - 1;
      const anioAnterior = mes === 1 ? anio - 1 : anio;
      const etiqueta = `FIXED_DAY 31 para ${anio}-${pad2(mes)}`;

      expect(release.getMonth() + 1, etiqueta).toBe(mesAnterior);
      expect(release.getFullYear(), etiqueta).toBe(anioAnterior);
      expect(release.getDate(), etiqueta).toBe(
        diasDelMes(anioAnterior, mesAnterior),
      );
    }
  });

  it("con un día fijo que sí cabe (15) la fecha es estable mes a mes", () => {
    const dia15 = cfg({ mode: "FIXED_DAY", releaseDayOfMonth: 15 });
    expect(toISODate(monthReleaseAt(inicioDeMes(2027, 3), dia15))).toBe("2027-02-15");
    expect(toISODate(monthReleaseAt(inicioDeMes(2027, 4), dia15))).toBe("2027-03-15");
    expect(toISODate(monthReleaseAt(inicioDeMes(2027, 1), dia15))).toBe("2026-12-15");
  });

  it("FIXED_DAY también mantiene la apertura dentro del mes anterior", () => {
    for (const [anio, mes] of mesesEntre([2026, 1], [2028, 12])) {
      const inicio = inicioDeMes(anio, mes);
      expect(
        monthReleaseAt(inicio, dia31).getTime(),
        `${anio}-${pad2(mes)}`,
      ).toBeLessThan(inicio.getTime());
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. El teorema del mes corriente                                     */
/* ------------------------------------------------------------------ */

describe("3. teorema del mes corriente: toda semana del mes en curso ya está abierta", () => {
  // 3 años de viernes: suficiente para cubrir con holgura el rango muestreado.
  const VIERNES = viernesConsecutivos("2026-01-02", 160);

  it("para cualquier instante de 2026-2027, ninguna semana del mes corriente está BEFORE_WINDOW", () => {
    const fallos: string[] = [];
    let comprobaciones = 0;

    for (const [anio, mes] of mesesEntre([2026, 1], [2027, 12])) {
      const ultimoDia = diasDelMes(anio, mes);
      const muestras: Date[] = [
        enMexico(`${anio}-${pad2(mes)}-01`, 0, 0, 0, 0),
        enMexico(`${anio}-${pad2(mes)}-01`, 0, 0, 0, 1),
        enMexico(`${anio}-${pad2(mes)}-14`, 12, 0),
        enMexico(`${anio}-${pad2(mes)}-${pad2(ultimoDia)}`, 23, 59, 59, 999),
      ];

      const delMes = VIERNES.filter((v) => `${anio}-${pad2(mes)}` === mesAncla(v));
      expect(delMes.length, `viernes anclados en ${anio}-${pad2(mes)}`).toBeGreaterThan(
        3,
      );

      for (const ahora of muestras) {
        for (const viernes of delMes) {
          const r = isWeekBookable(viernes, ahora);
          const etiqueta = `semana ${viernes} evaluada en ${utc(ahora)}`;
          if (r.reason === "BEFORE_WINDOW") fallos.push(`${etiqueta}: BEFORE_WINDOW`);
          if (r.releaseAt.getTime() > ahora.getTime()) {
            fallos.push(`${etiqueta}: releaseAt ${utc(r.releaseAt)} > ahora`);
          }
          comprobaciones += 1;
        }
      }
    }

    sinFallos(fallos, comprobaciones, 300);
  });

  it("además, toda semana del mes corriente que no haya terminado es reservable", () => {
    for (const [anio, mes] of mesesEntre([2026, 1], [2027, 12])) {
      const ahora = enMexico(`${anio}-${pad2(mes)}-01`, 8, 0);
      for (const viernes of VIERNES.filter((v) => mesAncla(v) === `${anio}-${pad2(mes)}`)) {
        const r = isWeekBookable(viernes, ahora);
        const noHaTerminado = ahora.getTime() < finDeSemana(viernes).getTime();
        expect(r.bookable, `semana ${viernes} en ${utc(ahora)}`).toBe(noHaTerminado);
      }
    }
  });

  it("el teorema sobrevive a bookingWindowDays pequeños (1 día de anticipación)", () => {
    const apretado = cfg({ bookingWindowDays: 1 });
    for (const [anio, mes] of mesesEntre([2026, 1], [2026, 12])) {
      const ahora = enMexico(`${anio}-${pad2(mes)}-01`, 0, 0, 0, 0);
      for (const viernes of VIERNES.filter((v) => mesAncla(v, apretado) === `${anio}-${pad2(mes)}`)) {
        expect(
          isWeekBookable(viernes, ahora, apretado).reason,
          `semana ${viernes} en ${utc(ahora)}`,
        ).not.toBe("BEFORE_WINDOW");
      }
    }
  });
});

/** Mes ancla en formato `yyyy-MM`, tal como lo expone `Bookability`. */
function mesAncla(
  viernesISO: string,
  configuracion: BookingWindowConfig = DEFAULT_BOOKING_WINDOW,
): string {
  const a = weekAnchorMonth(viernesISO, configuracion);
  return `${a.getFullYear()}-${pad2(a.getMonth() + 1)}`;
}

/* ------------------------------------------------------------------ */
/* 4. Anclaje: la "rendija" del puente de fin de mes                   */
/* ------------------------------------------------------------------ */

describe("4. anclaje de la semana que cruza el cambio de mes (la rendija)", () => {
  // Viernes 30-oct-2026: 30 y 31 de octubre + 1..5 de noviembre.
  // 5 de sus 7 días caen en noviembre, pero su viernes de inicio es de octubre.
  const SEMANA_PUENTE = "2026-10-30";
  const SEMANA_NOVIEMBRE = "2026-11-06";

  it("la semana puente tiene efectivamente 5 de sus 7 días en noviembre", () => {
    const dias = Array.from({ length: 7 }, (_, i) =>
      isoUTC(new Date(Date.UTC(2026, 9, 30 + i))),
    );
    expect(dias[0]).toBe("2026-10-30");
    expect(dias[6]).toBe("2026-11-05");
    expect(dias.filter((d) => d.startsWith("2026-11")).length).toBe(5);
  });

  it("con anchorOffsetDays=0 ancla en OCTUBRE y abre el 16-sep-2026", () => {
    expect(mesAncla(SEMANA_PUENTE)).toBe("2026-10");
    expect(toISODate(weekReleaseAt(SEMANA_PUENTE))).toBe("2026-09-16");
    expect(utc(weekReleaseAt(SEMANA_PUENTE))).toBe("2026-09-16T06:00:00.000Z");
  });

  it("con anchorOffsetDays=3 ancla en NOVIEMBRE y abre el 17-oct-2026", () => {
    const conMayoria = cfg({ anchorOffsetDays: 3 });
    expect(mesAncla(SEMANA_PUENTE, conMayoria)).toBe("2026-11");
    expect(toISODate(weekReleaseAt(SEMANA_PUENTE, conMayoria))).toBe("2026-10-17");
    expect(utc(weekReleaseAt(SEMANA_PUENTE, conMayoria))).toBe(
      "2026-10-17T06:00:00.000Z",
    );
  });

  it("la rendija es real: un mes entero de ventaja sobre el resto de noviembre", () => {
    const puente = weekReleaseAt(SEMANA_PUENTE).getTime();
    const noviembre = weekReleaseAt(SEMANA_NOVIEMBRE).getTime();
    expect(puente).toBeLessThan(noviembre);
    expect(noviembre - puente).toBe(31 * 86_400_000); // 16-sep → 17-oct
  });

  it("en un instante intermedio (1-oct-2026) la rendija está abierta y el resto de noviembre no", () => {
    const ahora = enMexico("2026-10-01", 10, 0);
    expect(isWeekBookable(SEMANA_PUENTE, ahora).bookable).toBe(true);
    const resto = isWeekBookable(SEMANA_NOVIEMBRE, ahora);
    expect(resto.bookable).toBe(false);
    expect(resto.reason).toBe("BEFORE_WINDOW");
  });

  it("anchorOffsetDays=3 cierra la rendija: ambas semanas abren el mismo día", () => {
    const conMayoria = cfg({ anchorOffsetDays: 3 });
    const ahora = enMexico("2026-10-01", 10, 0);
    expect(isWeekBookable(SEMANA_PUENTE, ahora, conMayoria).reason).toBe(
      "BEFORE_WINDOW",
    );
    expect(weekReleaseAt(SEMANA_PUENTE, conMayoria).getTime()).toBe(
      weekReleaseAt(SEMANA_NOVIEMBRE, conMayoria).getTime(),
    );
  });

  it("anchorOffsetDays=6 exige que la semana ENTERA esté habilitada", () => {
    const semanaCompleta = cfg({ anchorOffsetDays: 6 });
    // El jueves de cierre (5-nov-2026) es de noviembre: ancla en noviembre.
    expect(mesAncla(SEMANA_PUENTE, semanaCompleta)).toBe("2026-11");
    // Una semana que termina dentro de octubre sigue anclada en octubre.
    expect(mesAncla("2026-10-23", semanaCompleta)).toBe("2026-10");
  });

  it("el mes ancla que devuelve Bookability coincide con weekAnchorMonth", () => {
    for (const viernes of viernesConsecutivos("2026-01-02", 60)) {
      const r = isWeekBookable(viernes, enMexico("2026-01-01"));
      expect(r.anchorMonth, viernes).toBe(mesAncla(viernes));
      expect(r.anchorMonth).toMatch(/^\d{4}-\d{2}$/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. Corte inclusivo                                                  */
/* ------------------------------------------------------------------ */

describe("5. el corte de apertura es inclusivo", () => {
  const SEMANA = "2026-09-04"; // abre el 17-ago-2026 00:00 México
  const RELEASE = new Date("2026-08-17T06:00:00.000Z");

  it("en el instante EXACTO de releaseAt la semana ya es reservable", () => {
    const r = isWeekBookable(SEMANA, RELEASE);
    expect(r.bookable).toBe(true);
    expect(r.reason).toBe("OK");
  });

  it("un milisegundo antes todavía no lo es", () => {
    const r = isWeekBookable(SEMANA, new Date(RELEASE.getTime() - 1));
    expect(r.bookable).toBe(false);
    expect(r.reason).toBe("BEFORE_WINDOW");
  });

  it("un milisegundo después sigue siéndolo", () => {
    expect(isWeekBookable(SEMANA, new Date(RELEASE.getTime() + 1)).bookable).toBe(
      true,
    );
  });

  it("releaseAt es idéntico antes y después del corte (no depende de `now`)", () => {
    const antes = isWeekBookable(SEMANA, new Date(RELEASE.getTime() - 1)).releaseAt;
    const despues = isWeekBookable(SEMANA, new Date(RELEASE.getTime() + 1)).releaseAt;
    expect(antes.getTime()).toBe(RELEASE.getTime());
    expect(despues.getTime()).toBe(RELEASE.getTime());
  });

  it("el corte es inclusivo para todas las semanas de un barrido largo", () => {
    for (const viernes of viernesConsecutivos("2026-01-02", 80)) {
      const release = weekReleaseAt(viernes);
      const enElCorte = isWeekBookable(viernes, new Date(release.getTime()));
      const unMsAntes = isWeekBookable(viernes, new Date(release.getTime() - 1));
      expect(enElCorte.reason, viernes).not.toBe("BEFORE_WINDOW");
      expect(unMsAntes.reason, viernes).toBe("BEFORE_WINDOW");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. Semana en curso                                                  */
/* ------------------------------------------------------------------ */

describe("6. semana en curso", () => {
  const SEMANA = "2026-09-04"; // viernes 4-sep, jueves de cierre 10-sep

  describe("con allowInProgressWeek = true (valor por defecto)", () => {
    it("el viernes de inicio a las 00:00 es reservable", () => {
      expect(isWeekBookable(SEMANA, enMexico("2026-09-04", 0, 0, 0, 0))).toMatchObject(
        { bookable: true, reason: "OK" },
      );
    });

    it("a media semana sigue siendo reservable", () => {
      expect(isWeekBookable(SEMANA, enMexico("2026-09-07", 15, 30)).bookable).toBe(
        true,
      );
    });

    it("el jueves a las 23:59:59.999 todavía es reservable", () => {
      const r = isWeekBookable(SEMANA, enMexico("2026-09-10", 23, 59, 59, 999));
      expect(r.bookable).toBe(true);
      expect(r.reason).toBe("OK");
    });

    it("el viernes siguiente a las 00:00:00.000 deja de serlo, con motivo PAST (pasada)", () => {
      const r = isWeekBookable(SEMANA, enMexico("2026-09-11", 0, 0, 0, 0));
      expect(r.bookable).toBe(false);
      expect(r.reason).toBe("PAST");
    });

    it("mucho después sigue siendo PAST", () => {
      expect(isWeekBookable(SEMANA, enMexico("2027-01-01")).reason).toBe("PAST");
    });

    it("el corte de fin de semana es exactamente el viernes 00:00 de México, no el de UTC", () => {
      // 2026-09-11T00:00Z son todavía las 18:00 del jueves 10 en México: la
      // semana debe seguir viva. Si el módulo comparase en UTC, aquí fallaría.
      const r = isWeekBookable(SEMANA, new Date("2026-09-11T00:00:00.000Z"));
      expect(r.bookable).toBe(true);
      expect(utc(finDeSemana(SEMANA))).toBe("2026-09-11T06:00:00.000Z");
    });
  });

  describe("con allowInProgressWeek = false", () => {
    const estricto = cfg({ allowInProgressWeek: false });

    it("un milisegundo antes del viernes de inicio todavía es reservable", () => {
      const r = isWeekBookable(
        SEMANA,
        enMexico("2026-09-03", 23, 59, 59, 999),
        estricto,
      );
      expect(r.bookable).toBe(true);
      expect(r.reason).toBe("OK");
    });

    it("desde el viernes de inicio 00:00 el motivo es IN_PROGRESS", () => {
      const r = isWeekBookable(SEMANA, enMexico("2026-09-04", 0, 0, 0, 0), estricto);
      expect(r.bookable).toBe(false);
      expect(r.reason).toBe("IN_PROGRESS");
    });

    it("sigue siendo IN_PROGRESS hasta el jueves 23:59:59.999", () => {
      expect(
        isWeekBookable(SEMANA, enMexico("2026-09-10", 23, 59, 59, 999), estricto)
          .reason,
      ).toBe("IN_PROGRESS");
    });

    it("al llegar el viernes siguiente pasa a PAST (PAST gana a IN_PROGRESS)", () => {
      expect(
        isWeekBookable(SEMANA, enMexico("2026-09-11", 0, 0, 0, 0), estricto).reason,
      ).toBe("PAST");
    });
  });

  it("BEFORE_WINDOW y la semana en curso no pueden coexistir: la apertura siempre precede al inicio", () => {
    for (const viernes of viernesConsecutivos("2026-01-02", 80)) {
      const r = isWeekBookable(viernes, enMexico(viernes, 0, 0, 0, 0));
      expect(r.reason, viernes).not.toBe("BEFORE_WINDOW");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 7. Invariantes de propiedad sobre un barrido de viernes             */
/* ------------------------------------------------------------------ */

describe("7. invariantes de propiedad", () => {
  const VIERNES = viernesConsecutivos("2026-01-02", 90); // ~1 año y 9 meses
  const CONFIGS: Array<[string, BookingWindowConfig]> = [
    ["por defecto (anchorOffsetDays=0)", DEFAULT_BOOKING_WINDOW],
    ["mayoría de días (anchorOffsetDays=3)", cfg({ anchorOffsetDays: 3 })],
    ["semana completa (anchorOffsetDays=6)", cfg({ anchorOffsetDays: 6 })],
    ["día fijo 31", cfg({ mode: "FIXED_DAY", releaseDayOfMonth: 31 })],
  ];

  describe.each(CONFIGS)("configuración: %s", (_nombre, configuracion) => {
    it("anticipación positiva: releaseAt es siempre anterior al inicio de la semana", () => {
      const fallos = VIERNES.filter(
        (v) => weekReleaseAt(v, configuracion).getTime() >= enMexico(v).getTime(),
      ).map((v) => `${v} abre después de empezar`);
      sinFallos(fallos, VIERNES.length, 80);
    });

    it("monotonía de calendario: start1 < start2 implica releaseAt1 <= releaseAt2", () => {
      const fallos: string[] = [];
      for (let i = 1; i < VIERNES.length; i += 1) {
        const anterior = weekReleaseAt(VIERNES[i - 1], configuracion).getTime();
        const actual = weekReleaseAt(VIERNES[i], configuracion).getTime();
        if (anterior > actual) {
          fallos.push(`${VIERNES[i - 1]} abre después que ${VIERNES[i]}`);
        }
      }
      sinFallos(fallos, VIERNES.length - 1, 80);
    });

    it("monotonía temporal: si es reservable en t, lo sigue siendo hasta el fin de la semana", () => {
      const fallos: string[] = [];
      let iteraciones = 0;

      for (const viernes of VIERNES) {
        const release = weekReleaseAt(viernes, configuracion).getTime();
        const fin = finDeSemana(viernes).getTime();
        // Muestreo desde la apertura hasta el último milisegundo de la semana.
        const pasos = 12;
        for (let i = 0; i <= pasos; i += 1) {
          const t = release + Math.floor(((fin - 1 - release) * i) / pasos);
          if (!isWeekBookable(viernes, new Date(t), configuracion).bookable) {
            fallos.push(`${viernes} dejó de ser reservable en ${utc(new Date(t))}`);
          }
          iteraciones += 1;
        }
      }

      sinFallos(fallos, iteraciones, VIERNES.length * 13);
    });

    it("el estado nunca retrocede: BEFORE_WINDOW → OK → PAST, sin volver atrás", () => {
      const orden: Record<string, number> = {
        BEFORE_WINDOW: 0,
        OK: 1,
        IN_PROGRESS: 1,
        PAST: 2,
      };
      const fallos: string[] = [];
      let iteraciones = 0;

      for (const viernes of VIERNES.slice(0, 24)) {
        const release = weekReleaseAt(viernes, configuracion).getTime();
        const fin = finDeSemana(viernes).getTime();
        let previo = -1;
        for (let t = release - 2 * 86_400_000; t <= fin + 86_400_000; t += 86_400_000) {
          const fase = orden[isWeekBookable(viernes, new Date(t), configuracion).reason];
          if (fase < previo) {
            fallos.push(`${viernes} retrocedió de fase ${previo} a ${fase} en ${utc(new Date(t))}`);
          }
          previo = fase;
          iteraciones += 1;
        }
      }

      sinFallos(fallos, iteraciones, 300);
    });

    it("releaseAt es un Date propio (mutarlo no contamina el módulo)", () => {
      const a = isWeekBookable(VIERNES[0], enMexico("2026-01-01"), configuracion);
      const b = isWeekBookable(VIERNES[0], enMexico("2026-01-01"), configuracion);
      expect(a.releaseAt).not.toBe(b.releaseAt);
      a.releaseAt.setFullYear(1999);
      expect(b.releaseAt.getTime()).toBe(
        weekReleaseAt(VIERNES[0], configuracion).getTime(),
      );
    });
  });

  it("cobertura sin huecos: reservable == 'lo que queda del mes corriente' + 'el mes siguiente si ya abrió'", () => {
    // Barrido propio: basta con que los viernes rebasen el tope de cada
    // instante muestreado (70 semanas llegan hasta mayo de 2027).
    const SEMANAS = viernesConsecutivos("2026-01-02", 70);
    const fallos: string[] = [];
    let comprobaciones = 0;

    for (const [anio, mes] of mesesEntre([2026, 1], [2026, 12])) {
      const ultimoDia = diasDelMes(anio, mes);
      const siguiente = inicioDeMes(mes === 12 ? anio + 1 : anio, mes === 12 ? 1 : mes + 1);
      const aperturaSiguiente = monthReleaseAt(siguiente).getTime();
      const muestras: Date[] = [
        enMexico(`${anio}-${pad2(mes)}-01`, 0, 0, 0, 0),
        enMexico(`${anio}-${pad2(mes)}-10`, 9, 0),
        // Justo antes y justo después de la apertura del mes siguiente.
        new Date(aperturaSiguiente - 1),
        new Date(aperturaSiguiente),
        enMexico(`${anio}-${pad2(mes)}-${pad2(ultimoDia)}`, 23, 59, 59, 999),
      ];

      for (const ahora of muestras) {
        const tope = maxOpenAnchorMonth(ahora);
        for (const viernes of SEMANAS) {
          const r = isWeekBookable(viernes, ahora);
          const noHaTerminado = ahora.getTime() < finDeSemana(viernes).getTime();
          const dentroDelTope = `${r.anchorMonth}-01` <= tope;
          if (r.bookable !== (noHaTerminado && dentroDelTope)) {
            fallos.push(
              `semana ${viernes} (ancla ${r.anchorMonth}) en ${utc(ahora)}, tope ${tope}: ` +
                `bookable=${r.bookable} esperado=${noHaTerminado && dentroDelTope}`,
            );
          }
          comprobaciones += 1;
        }
      }
    }

    sinFallos(fallos, comprobaciones, 4_000);
  });

  it("no hay huecos: entre la primera y la última semana reservable, todas lo son", () => {
    const fallos: string[] = [];
    let iteraciones = 0;

    // El rango se detiene en 2027-06 porque VIERNES llega hasta septiembre de
    // 2027: más allá el barrido no contendría ninguna semana reservable y la
    // prueba se volvería vacua.
    for (const [anio, mes] of mesesEntre([2026, 1], [2027, 6])) {
      const ahora = enMexico(`${anio}-${pad2(mes)}-20`, 12, 0);
      const estados = VIERNES.map((v) => isWeekBookable(v, ahora).bookable);
      const primera = estados.indexOf(true);
      const ultima = estados.lastIndexOf(true);
      expect(primera, `${anio}-${pad2(mes)}`).toBeGreaterThanOrEqual(0);
      for (let i = primera; i <= ultima; i += 1) {
        if (!estados[i]) {
          fallos.push(`hueco en ${VIERNES[i]} evaluado en ${utc(ahora)}`);
        }
        iteraciones += 1;
      }
    }

    sinFallos(fallos, iteraciones, 100);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Cruce de año                                                     */
/* ------------------------------------------------------------------ */

describe("8. cruce de año", () => {
  it("la semana del viernes 1-ene-2027 abre el 17-dic-2026", () => {
    expect(new Date(Date.UTC(2027, 0, 1)).getUTCDay()).toBe(5); // es viernes
    expect(mesAncla("2027-01-01")).toBe("2027-01");
    expect(toISODate(weekReleaseAt("2027-01-01"))).toBe("2026-12-17");
    expect(utc(weekReleaseAt("2027-01-01"))).toBe("2026-12-17T06:00:00.000Z");
  });

  it("el 16-dic-2026 aún no está abierta; el 17-dic-2026 a las 00:00 sí", () => {
    expect(
      isWeekBookable("2027-01-01", enMexico("2026-12-16", 23, 59, 59, 999)).reason,
    ).toBe("BEFORE_WINDOW");
    expect(
      isWeekBookable("2027-01-01", enMexico("2026-12-17", 0, 0, 0, 0)).reason,
    ).toBe("OK");
  });

  it("la semana del 25-dic-2026 (aún de diciembre) abrió un mes antes, el 16-nov", () => {
    expect(mesAncla("2026-12-25")).toBe("2026-12");
    expect(toISODate(weekReleaseAt("2026-12-25"))).toBe("2026-11-16");
  });

  it("la semana puente 2026-12-25 → 2026-12-31 no cruza el año; la del 2027-01-01 sí abre después", () => {
    expect(weekReleaseAt("2026-12-25").getTime()).toBeLessThan(
      weekReleaseAt("2027-01-01").getTime(),
    );
  });

  it("en modo FIXED_DAY el cruce de año también retrocede al mes de diciembre", () => {
    const dia31 = cfg({ mode: "FIXED_DAY", releaseDayOfMonth: 31 });
    expect(toISODate(weekReleaseAt("2027-01-01", dia31))).toBe("2026-12-31");
  });
});

/* ------------------------------------------------------------------ */
/* 9. maxOpenAnchorMonth y maxVisibleMonth                             */
/* ------------------------------------------------------------------ */

describe("9. escalares para filtrar en SQL", () => {
  describe("maxOpenAnchorMonth", () => {
    it("el 16-ago-2026 el tope sigue siendo agosto", () => {
      expect(maxOpenAnchorMonth(enMexico("2026-08-16", 23, 59, 59, 999))).toBe(
        "2026-08-01",
      );
    });

    it("un milisegundo antes de la apertura de septiembre el tope es agosto", () => {
      expect(maxOpenAnchorMonth(new Date("2026-08-17T05:59:59.999Z"))).toBe(
        "2026-08-01",
      );
    });

    it("el 17-ago-2026 a las 00:00 exactas el tope pasa a septiembre", () => {
      expect(maxOpenAnchorMonth(new Date("2026-08-17T06:00:00.000Z"))).toBe(
        "2026-09-01",
      );
    });

    it("el último día del mes con el siguiente ya abierto sigue apuntando al mes siguiente", () => {
      expect(maxOpenAnchorMonth(enMexico("2026-08-31", 23, 59, 59, 999))).toBe(
        "2026-09-01",
      );
    });

    it("cruza el año correctamente: el 17-dic-2026 el tope es enero de 2027", () => {
      expect(maxOpenAnchorMonth(enMexico("2026-12-16", 12, 0))).toBe("2026-12-01");
      expect(maxOpenAnchorMonth(enMexico("2026-12-17", 0, 0, 0, 0))).toBe(
        "2027-01-01",
      );
    });

    it("siempre devuelve el formato yyyy-MM-01 y solo puede ser el mes actual o el siguiente", () => {
      for (const [anio, mes] of mesesEntre([2026, 1], [2027, 12])) {
        for (const dia of [1, 14, 17, 28]) {
          const ahora = enMexico(`${anio}-${pad2(mes)}-${pad2(dia)}`, 12, 0);
          const tope = maxOpenAnchorMonth(ahora);
          expect(tope).toMatch(/^\d{4}-\d{2}-01$/);
          const siguiente = mes === 12 ? `${anio + 1}-01-01` : `${anio}-${pad2(mes + 1)}-01`;
          expect([`${anio}-${pad2(mes)}-01`, siguiente]).toContain(tope);
        }
      }
    });

    it("coincide con isWeekBookable: el tope es exactamente el mayor mes ancla abierto", () => {
      // El barrido de viernes solo necesita rebasar el tope: 60 semanas cubren
      // más de un año por delante de cualquier instante muestreado.
      const viernes = viernesConsecutivos("2026-01-02", 60);
      const fallos: string[] = [];
      let iteraciones = 0;

      for (const [anio, mes] of mesesEntre([2026, 2], [2026, 12])) {
        for (const dia of [1, 13, 16, 18, 27]) {
          const ahora = enMexico(`${anio}-${pad2(mes)}-${pad2(dia)}`, 12, 0);
          const tope = maxOpenAnchorMonth(ahora);
          let mayor = "0000-00-01";
          for (const v of viernes) {
            const r = isWeekBookable(v, ahora);
            const ancla = `${r.anchorMonth}-01`;
            if (r.reason !== "BEFORE_WINDOW" && ancla > mayor) mayor = ancla;
          }
          if (mayor !== tope) {
            fallos.push(`en ${utc(ahora)}: mayor abierto ${mayor} != tope ${tope}`);
          }
          iteraciones += 1;
        }
      }

      sinFallos(fallos, iteraciones, 50);
    });
  });

  describe("maxVisibleMonth", () => {
    it("con horizonte de 6 meses, el 16 y el 17-ago-2026 devuelven febrero de 2027", () => {
      expect(maxVisibleMonth(enMexico("2026-08-16", 12, 0))).toBe("2027-02-01");
      expect(maxVisibleMonth(enMexico("2026-08-17", 0, 0, 0, 0))).toBe("2027-02-01");
    });

    it("no depende del día del mes, solo del mes", () => {
      expect(maxVisibleMonth(enMexico("2026-08-01", 0, 0, 0, 0))).toBe("2027-02-01");
      expect(maxVisibleMonth(enMexico("2026-08-31", 23, 59, 59, 999))).toBe(
        "2027-02-01",
      );
    });

    it("cruza el año: en noviembre de 2026 el horizonte llega a mayo de 2027", () => {
      expect(maxVisibleMonth(enMexico("2026-11-05", 12, 0))).toBe("2027-05-01");
    });

    it("respeta visibleHorizonMonths", () => {
      expect(maxVisibleMonth(enMexico("2026-08-20", 12, 0), cfg({ visibleHorizonMonths: 1 }))).toBe(
        "2026-09-01",
      );
      expect(maxVisibleMonth(enMexico("2026-08-20", 12, 0), cfg({ visibleHorizonMonths: 12 }))).toBe(
        "2027-08-01",
      );
    });

    it("el horizonte visible nunca queda por detrás del tope abierto", () => {
      for (const [anio, mes] of mesesEntre([2026, 1], [2027, 12])) {
        const ahora = enMexico(`${anio}-${pad2(mes)}-20`, 12, 0);
        expect(maxVisibleMonth(ahora) >= maxOpenAnchorMonth(ahora), utc(ahora)).toBe(
          true,
        );
      }
    });
  });
});

/* ------------------------------------------------------------------ */
/* 10. Zona horaria de negocio                                         */
/* ------------------------------------------------------------------ */

describe("10. businessToday respeta la zona de negocio", () => {
  it("un instante que en UTC ya es día 18 pero en México sigue siendo día 17", () => {
    // 2026-08-18T03:00Z = 2026-08-17 21:00 en México.
    expect(businessToday(new Date("2026-08-18T03:00:00.000Z"))).toBe("2026-08-17");
  });

  it("el corte de medianoche civil ocurre a las 06:00Z", () => {
    expect(businessToday(new Date("2026-08-17T05:59:59.999Z"))).toBe("2026-08-16");
    expect(businessToday(new Date("2026-08-17T06:00:00.000Z"))).toBe("2026-08-17");
  });

  it("también funciona en invierno (sin horario de verano desde 2022)", () => {
    expect(businessToday(new Date("2027-01-01T05:59:59.999Z"))).toBe("2026-12-31");
    expect(businessToday(new Date("2027-01-01T06:00:00.000Z"))).toBe("2027-01-01");
  });

  it("cruza el año y el mes correctamente", () => {
    expect(businessToday(new Date("2027-03-01T04:00:00.000Z"))).toBe("2027-02-28");
    expect(businessToday(new Date("2028-03-01T04:00:00.000Z"))).toBe("2028-02-29");
  });

  it("con otra zona el mismo instante puede ser otro día", () => {
    const instante = new Date("2026-08-18T03:00:00.000Z");
    expect(businessToday(instante, cfg({ timeZone: "UTC" }))).toBe("2026-08-18");
    expect(businessToday(instante, cfg({ timeZone: "America/Mexico_City" }))).toBe(
      "2026-08-17",
    );
  });

  it("toISODate rellena mes y día a dos dígitos", () => {
    expect(toISODate(new TZDate(2026, 0, 5, 0, 0, 0, 0, ZONA))).toBe("2026-01-05");
    expect(toISODate(new TZDate(2026, 11, 31, 23, 0, 0, 0, ZONA))).toBe("2026-12-31");
  });

  it("la zona afecta a la ventana, no solo al formato: el corte de apertura es hora de México", () => {
    // A las 00:00 UTC del 17-ago en México son todavía las 18:00 del 16: no abre.
    expect(
      isWeekBookable("2026-09-04", new Date("2026-08-17T00:00:00.000Z")).reason,
    ).toBe("BEFORE_WINDOW");
    expect(
      isWeekBookable("2026-09-04", new Date("2026-08-17T06:00:00.000Z")).reason,
    ).toBe("OK");
  });
});

/* ------------------------------------------------------------------ */
/* Entradas inválidas                                                  */
/* ------------------------------------------------------------------ */

describe("entradas inválidas", () => {
  it.each(["", "2026-09", "no-es-fecha", "0000-00-00"])(
    "rechaza %j con RangeError",
    (entrada) => {
      expect(() => weekAnchorMonth(entrada)).toThrow(RangeError);
    },
  );
});

/* ------------------------------------------------------------------ */
/* Hallazgos: comportamientos que el integrador debe decidir           */
/* ------------------------------------------------------------------ */

describe("HALLAZGO: maxOpenAnchorMonth solo mira un mes hacia adelante", () => {
  /*
   * `maxOpenAnchorMonth` compara `now` únicamente contra la apertura del MES
   * SIGUIENTE. Con la configuración confirmada (15 días) es correcto, porque
   * ningún mes dura menos de 28 días y la apertura de mes+2 nunca cae dentro
   * del mes corriente. Pero si algún día se sube `bookingWindowDays` por encima
   * de ~28, `isWeekBookable` declara reservables semanas de mes+2 que el
   * escalar deja fuera del filtro SQL: la reserva sería válida pero el
   * calendario no mostraría la semana. No lo corrijo (el archivo no es mío);
   * lo dejo documentado y comprobado.
   */
  const holgado = cfg({ bookingWindowDays: 45 });

  it("con 15 días (configuración real) NO hay incoherencia en 2026-2027", () => {
    const viernes = viernesConsecutivos("2026-01-02", 110);
    const fallos: string[] = [];
    let iteraciones = 0;

    for (const [anio, mes] of mesesEntre([2026, 1], [2027, 12])) {
      const ahora = enMexico(`${anio}-${pad2(mes)}-20`, 12, 0);
      const tope = maxOpenAnchorMonth(ahora);
      for (const v of viernes) {
        const r = isWeekBookable(v, ahora);
        if (r.reason !== "BEFORE_WINDOW" && `${r.anchorMonth}-01` > tope) {
          fallos.push(`${v} (ancla ${r.anchorMonth}) abierta pero fuera del tope ${tope} en ${utc(ahora)}`);
        }
        iteraciones += 1;
      }
    }

    sinFallos(fallos, iteraciones, 2_000);
  });

  // REGRESIÓN: antes, `maxOpenAnchorMonth` solo miraba UN mes hacia adelante,
  // así que con una ventana larga declaraba reservable una semana (mes+2) que el
  // filtro SQL dejaba fuera: la reserva era válida pero el calendario no la
  // mostraba. Ahora avanza mientras haya meses ya abiertos.
  it("con bookingWindowDays=45 el escalar alcanza mes+2 (regresión)", () => {
    const ahora = enMexico("2026-08-20", 12, 0);
    // Octubre abre 45 días antes del 1-oct = 17-ago: ya está abierto.
    expect(isWeekBookable("2026-10-02", ahora, holgado).reason).toBe("OK");
    // Y el escalar debe reflejarlo, o el calendario ocultaría esa semana.
    expect(maxOpenAnchorMonth(ahora, holgado)).toBe("2026-10-01");
  });

  it("el escalar concuerda con el predicado para ventanas de 0 a 60 días", () => {
    const viernes = viernesConsecutivos("2026-01-02", 60);
    const fallos: string[] = [];
    let iteraciones = 0;

    // El barrido se muestrea (meses alternos, tres días por mes) porque cada
    // comprobación construye varios TZDate y el producto completo tardaba más
    // de 30 s. Sigue cubriendo los dos bordes que importan: el día anterior y
    // el posterior a la apertura, en ventanas cortas, medias y largas.
    for (const dias of [0, 1, 7, 15, 28, 31, 45, 60]) {
      const c = cfg({ bookingWindowDays: dias });
      for (const [anio, mes] of mesesEntre([2026, 1], [2027, 6]).filter(
        (_, i) => i % 2 === 0,
      )) {
        for (const dia of [1, 16, 28]) {
          const ahora = enMexico(`${anio}-${pad2(mes)}-${pad2(dia)}`, 12, 0);
          const tope = maxOpenAnchorMonth(ahora, c);
          for (const v of viernes) {
            const r = isWeekBookable(v, ahora, c);
            if (r.reason !== "BEFORE_WINDOW" && `${r.anchorMonth}-01` > tope) {
              fallos.push(
                `ventana=${dias}d · ${v} (ancla ${r.anchorMonth}) abierta pero fuera del tope ${tope} en ${utc(ahora)}`,
              );
            }
            iteraciones += 1;
          }
        }
      }
    }

    // 8 ventanas × 9 meses × 3 días × 60 viernes = 12 960 comprobaciones.
    sinFallos(fallos, iteraciones, 12_000);
  });
});
