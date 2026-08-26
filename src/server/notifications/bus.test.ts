/**
 * Pruebas del bus de cambios del calendario.
 *
 * No tocan la base ni la red: el bus es memoria pura. Lo que se comprueba aquí
 * son las tres cosas de las que depende que el calendario en vivo no se rompa
 * ni se coma el servidor:
 *
 *   · que el aviso llegue a TODOS los suscriptores y solo lleve `{propertyId, ts}`;
 *   · que darse de baja lo retire DE VERDAD —esa es la fuga de memoria que
 *     mataría un servicio de vida larga—;
 *   · que un oyente roto no deje sordos a los demás.
 *
 * OJO al montaje: el bus es un singleton colgado de `globalThis`, así que las
 * suscripciones sobreviven entre pruebas si nadie las retira. Cada prueba se
 * apunta a `bajas` y el `afterEach` las cierra; la última prueba comprueba que
 * el recuento vuelve a cero, que es la misma sonda que se usaría en producción.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  contarOyentes,
  publicarCambio,
  suscribirseACambios,
  type CambioDeCalendario,
} from "./bus";

const PROPIEDAD_A = "11111111-1111-4111-8111-111111111111";
const PROPIEDAD_B = "22222222-2222-4222-8222-222222222222";

/** Bajas pendientes de la prueba en curso. */
let bajas: Array<() => void> = [];

/** Se suscribe recordando la baja, para que ninguna prueba deje basura. */
function escuchar(): { recibidos: CambioDeCalendario[]; baja: () => void } {
  const recibidos: CambioDeCalendario[] = [];
  const baja = suscribirseACambios((cambio) => {
    recibidos.push(cambio);
  });
  bajas.push(baja);
  return { recibidos, baja };
}

beforeEach(() => {
  bajas = [];
  // Si una prueba anterior dejó algo colgando, se sabe aquí y no tres pruebas
  // más adelante con un recuento que no cuadra.
  expect(contarOyentes()).toBe(0);
});

afterEach(() => {
  for (const baja of bajas) baja();
  bajas = [];
});

describe("publicarCambio", () => {
  it("entrega el cambio a todos los suscriptores", () => {
    const uno = escuchar();
    const dos = escuchar();

    publicarCambio(PROPIEDAD_A, 1_700_000_000_000);

    expect(uno.recibidos).toEqual([
      { propertyId: PROPIEDAD_A, ts: 1_700_000_000_000 },
    ]);
    expect(dos.recibidos).toEqual(uno.recibidos);
  });

  it("no manda nada más que la propiedad y el instante", () => {
    const { recibidos } = escuchar();

    publicarCambio(PROPIEDAD_A);

    // El contrato de ligereza, hecho aserción: si alguien añade el estado de la
    // semana al evento, el bus pasaría a filtrar información y esto se cae.
    expect(Object.keys(recibidos[0]!).sort()).toEqual(["propertyId", "ts"]);
    expect(recibidos[0]!.ts).toBeGreaterThan(0);
  });

  it("distingue una propiedad de otra", () => {
    const { recibidos } = escuchar();

    publicarCambio(PROPIEDAD_A, 1);
    publicarCambio(PROPIEDAD_B, 2);

    expect(recibidos.map((c) => c.propertyId)).toEqual([
      PROPIEDAD_A,
      PROPIEDAD_B,
    ]);
  });

  it("ignora una propiedad vacía en vez de despertar a todo el mundo", () => {
    const { recibidos } = escuchar();

    publicarCambio("");

    expect(recibidos).toHaveLength(0);
  });

  it("sin suscriptores no lanza", () => {
    expect(contarOyentes()).toBe(0);
    expect(() => publicarCambio(PROPIEDAD_A)).not.toThrow();
  });
});

describe("suscribirseACambios — la baja", () => {
  it("deja de entregar en cuanto se da de baja", () => {
    const { recibidos, baja } = escuchar();

    publicarCambio(PROPIEDAD_A, 1);
    baja();
    publicarCambio(PROPIEDAD_A, 2);

    expect(recibidos.map((c) => c.ts)).toEqual([1]);
    expect(contarOyentes()).toBe(0);
  });

  it("darse de baja dos veces no arrastra a otro suscriptor", () => {
    const uno = escuchar();
    const dos = escuchar();

    uno.baja();
    // La segunda llamada tiene que ser inocua. Sin la guarda de idempotencia,
    // un `delete` repetido sobre el Set no haría daño, pero cualquier
    // implementación por índice sí se llevaría por delante al vecino.
    uno.baja();

    publicarCambio(PROPIEDAD_A, 1);

    expect(uno.recibidos).toHaveLength(0);
    expect(dos.recibidos).toHaveLength(1);
    expect(contarOyentes()).toBe(1);
  });

  it("un oyente que se da de baja mientras se le avisa no rompe el reparto", () => {
    const vistos: string[] = [];

    // Es exactamente lo que hace la ruta SSE cuando descubre, al escribir, que
    // el cliente ya se había ido: se cierra a sí misma en plena entrega.
    // El tipo se anota a mano: sin él, TypeScript no puede inferirlo porque la
    // propia función se referencia dentro de su inicializador.
    const bajaPrimero: () => void = suscribirseACambios(() => {
      vistos.push("primero");
      bajaPrimero();
    });
    bajas.push(bajaPrimero);

    const segundo = escuchar();

    publicarCambio(PROPIEDAD_A, 1);

    expect(vistos).toEqual(["primero"]);
    expect(segundo.recibidos).toHaveLength(1);
    expect(contarOyentes()).toBe(1);

    publicarCambio(PROPIEDAD_A, 2);
    expect(vistos).toEqual(["primero"]);
    expect(segundo.recibidos).toHaveLength(2);
  });
});

describe("aislamiento entre oyentes", () => {
  it("un oyente que lanza no impide que los demás reciban", () => {
    const registro = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const roto = suscribirseACambios(() => {
        throw new Error("flujo cerrado");
      });
      bajas.push(roto);

      const sano = escuchar();

      expect(() => publicarCambio(PROPIEDAD_A, 1)).not.toThrow();
      expect(sano.recibidos).toHaveLength(1);
      expect(registro).toHaveBeenCalledTimes(1);
    } finally {
      registro.mockRestore();
    }
  });
});

describe("contarOyentes — la sonda de fugas", () => {
  it("vuelve a cero cuando todos se dan de baja", () => {
    const a = escuchar();
    const b = escuchar();
    expect(contarOyentes()).toBe(2);

    a.baja();
    b.baja();

    // En reposo, sin pestañas abiertas, el bus tiene que estar vacío. Si esto
    // empieza a crecer en producción, hay flujos SSE que no se están limpiando.
    expect(contarOyentes()).toBe(0);
  });
});
