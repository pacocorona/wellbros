"use client";

/**
 * El calendario en vivo, visto desde el navegador.
 *
 * Abre el flujo de `/api/events`, escucha los avisos de «cambió la propiedad X»
 * y, cuando el aviso es de la propiedad que se está mirando, llama a `onCambio`
 * —que en la práctica es un `router.refresh()`—. Nada de datos viaja por el
 * flujo: el aviso solo dice QUÉ mirar otra vez, y los datos llegan por el
 * camino de siempre, con los permisos de quien mira ya aplicados.
 *
 * TRES REDES DE SEGURIDAD, PORQUE UNA SOLA NO AGUANTA UN TELÉFONO:
 *
 *  1. RESPALDO POR CONSULTA. Si el flujo falla de forma persistente —nginx sin
 *     `proxy_buffering off`, un proxy corporativo que no entiende SSE, una red
 *     de invitados— se pasa a preguntar cada 30 s. Lento, pero el calendario
 *     nunca se queda muerto. El respaldo se apaga solo en cuanto el flujo
 *     vuelve a abrir.
 *
 *  2. AL RECUPERAR EL FOCO. iOS y Android congelan las conexiones de las
 *     pestañas en segundo plano. Al volver, el EventSource puede parecer vivo y
 *     estar dormido, o haberse perdido los avisos de la última media hora. La
 *     única lectura fiable es preguntar de nuevo en cuanto la pantalla vuelve.
 *
 *  3. AL VOLVER LA CONEXIÓN. Igual, para el metro y el ascensor.
 *
 * La conexión NO depende de `propertyId`: cambiar de propiedad en el selector
 * no reabre nada, solo cambia por cuál se filtra. Reconectar en cada cambio
 * gastaría una petición y dejaría una ventana ciega de varios segundos justo
 * cuando el usuario está mirando.
 */

import { useEffect, useRef, useState } from "react";

/** Ruta del flujo. Debe coincidir con `src/app/api/events/route.ts`. */
const RUTA_EVENTOS = "/api/events";

/** Cada cuánto se pregunta cuando el flujo en vivo no está disponible (§04). */
const RESPALDO_MS = 30_000;

/**
 * Errores seguidos que se le toleran al flujo antes de rendirse.
 *
 * EventSource reintenta solo, y un error suelto es lo normal cuando el servidor
 * se reinicia en un despliegue: rendirse al primero condenaría a media hora de
 * consultas a quien simplemente pilló el reinicio. Tres errores sin un solo
 * `open` de por medio ya no son un tropiezo, son que esto no funciona aquí.
 */
const MAX_FALLOS = 3;

/**
 * Ventana para no revalidar dos veces por el mismo regreso: al volver a una
 * pestaña, `visibilitychange` y `focus` se disparan casi a la vez.
 */
const ANTIRREBOTE_MS = 2_000;

export interface UseLiveCalendarOptions {
  /** Propiedad que se está mirando. `null` = ninguna: no se filtra nada dentro. */
  propertyId: string | null;
  /**
   * Qué hacer cuando algo cambió. Se le llama sin argumentos y puede llamarse
   * varias veces seguidas: debe ser barata e idempotente (`router.refresh()`).
   */
  onCambio: () => void;
}

export interface UseLiveCalendarResult {
  /**
   * `true` mientras el flujo en vivo está abierto. En `false` el hook sigue
   * funcionando por respaldo: sirve para pintar un indicador, no para decidir
   * si los datos son buenos.
   */
  conectado: boolean;
}

/** Lo que manda el servidor. Se valida en el cliente: es texto de la red. */
interface CambioEnVivo {
  propertyId: string;
  ts: number;
}

function leerCambio(bruto: unknown): CambioEnVivo | null {
  if (typeof bruto !== "string") return null;

  let datos: unknown;
  try {
    datos = JSON.parse(bruto);
  } catch {
    // Un bloque a medias o un proxy que inyectó algo. Se ignora sin ruido: el
    // respaldo y el regreso de foco cubren lo que se pierda.
    return null;
  }

  if (typeof datos !== "object" || datos === null) return null;
  const { propertyId, ts } = datos as { propertyId?: unknown; ts?: unknown };
  if (typeof propertyId !== "string" || propertyId === "") return null;

  return { propertyId, ts: typeof ts === "number" ? ts : Date.now() };
}

export function useLiveCalendar({
  propertyId,
  onCambio,
}: UseLiveCalendarOptions): UseLiveCalendarResult {
  const [conectado, setConectado] = useState(false);

  /**
   * `onCambio` y `propertyId` se leen por referencia, no por dependencia.
   *
   * Es lo que permite que el efecto de abajo se monte UNA vez y no se
   * desmonte nunca hasta salir de la pantalla. Si fueran dependencias, cada
   * render con una función nueva —lo normal— cerraría y reabriría el flujo, y
   * el calendario pasaría la vida reconectando en lugar de escuchando.
   *
   * Se sincronizan en un efecto y no durante el render: escribir en una `ref`
   * mientras se renderiza rompe con el render concurrente de React 19.
   */
  const onCambioRef = useRef(onCambio);
  const propertyIdRef = useRef(propertyId);

  useEffect(() => {
    onCambioRef.current = onCambio;
  }, [onCambio]);

  useEffect(() => {
    propertyIdRef.current = propertyId;
  }, [propertyId]);

  useEffect(() => {
    // Sin ventana no hay nada que abrir (render en servidor, pruebas en Node).
    if (typeof window === "undefined") return;

    /** Momento del montaje: sirve para no revalidar lo que se acaba de pintar. */
    const montado = Date.now();

    let desmontado = false;
    let fuente: EventSource | null = null;
    let respaldo: ReturnType<typeof setInterval> | null = null;
    let fallos = 0;
    let ultimoRegreso = montado;

    const avisar = () => {
      if (desmontado) return;
      onCambioRef.current();
    };

    const pararRespaldo = () => {
      if (respaldo !== null) {
        clearInterval(respaldo);
        respaldo = null;
      }
    };

    const arrancarRespaldo = () => {
      if (desmontado || respaldo !== null) return;
      respaldo = setInterval(avisar, RESPALDO_MS);
      // Una consulta YA: se acaba de perder el hilo en vivo y la vista puede
      // llevar rato vieja. Esperar 30 s para la primera sería regalar el peor
      // caso justo en el momento en que se sabe que hay que mirar.
      //
      // La excepción es el respaldo que arranca en el propio montaje (navegador
      // sin EventSource): la pantalla acaba de pintarse con datos recién
      // traídos del servidor y refrescarla sería trabajo regalado.
      if (Date.now() - montado > ANTIRREBOTE_MS) avisar();
    };

    const cerrarFuente = () => {
      if (fuente !== null) {
        fuente.close();
        fuente = null;
      }
    };

    const conectar = () => {
      if (desmontado || fuente !== null) return;

      // Navegador sin EventSource: se vive de respaldo y ya.
      if (typeof EventSource === "undefined") {
        arrancarRespaldo();
        return;
      }

      let es: EventSource;
      try {
        es = new EventSource(RUTA_EVENTOS);
      } catch {
        arrancarRespaldo();
        return;
      }
      fuente = es;

      es.onopen = () => {
        if (desmontado) return;
        fallos = 0;
        // El hilo en vivo manda: mientras esté abierto, sobra preguntar.
        pararRespaldo();
        setConectado(true);
      };

      // El oyente se tipa como `Event` porque un nombre de evento propio cae en
      // la sobrecarga genérica de `addEventListener`, que no sabe que esto es
      // un `MessageEvent`. `leerCambio` valida el contenido de todas formas: lo
      // que llega es texto de la red y no se da nada por bueno.
      es.addEventListener("cambio", (evento: Event) => {
        if (desmontado) return;

        const cambio = leerCambio((evento as MessageEvent<unknown>).data);
        if (cambio === null) return;

        // El filtro por propiedad: el flujo lleva los cambios de TODAS, porque
        // el servidor no sabe cuál se está mirando. Sin propiedad
        // seleccionada no hay ninguna vista que revalidar.
        const mirando = propertyIdRef.current;
        if (mirando === null || cambio.propertyId !== mirando) return;

        avisar();
      });

      es.onerror = () => {
        if (desmontado) return;
        setConectado(false);
        fallos += 1;

        // CLOSED = el navegador se rindió y no va a reintentar; hay que asumir
        // el relevo. CONNECTING = lo volverá a intentar solo, y se le deja
        // hacerlo mientras el contador de fallos aguante.
        if (es.readyState === EventSource.CLOSED || fallos >= MAX_FALLOS) {
          cerrarFuente();
          arrancarRespaldo();
        }
      };
    };

    /**
     * Volvimos: la pantalla se encendió, la pestaña recuperó el foco o volvió
     * la red. Se revalida siempre —el estado en pantalla puede ser de hace
     * horas— y, si el flujo se había caído, se aprovecha para reintentarlo.
     *
     * El respaldo NO se apaga aquí: se apaga en `onopen`, cuando conste que el
     * flujo abrió de verdad. Apagarlo antes dejaría al usuario sin ninguna de
     * las dos vías si el reintento también falla.
     */
    const regresar = () => {
      if (desmontado) return;

      const ahora = Date.now();
      if (ahora - ultimoRegreso < ANTIRREBOTE_MS) return;
      ultimoRegreso = ahora;

      avisar();

      if (fuente === null) {
        fallos = 0;
        conectar();
      }
    };

    /** Con la pestaña oculta no se revalida: no hay nadie mirando. */
    const alVolverAlFrente = () => {
      if (document.visibilityState === "hidden") return;
      regresar();
    };

    window.addEventListener("focus", alVolverAlFrente);
    document.addEventListener("visibilitychange", alVolverAlFrente);
    // `online` sí actúa aunque la pestaña esté oculta: recuperar la conexión es
    // justo el momento de reabrir el flujo, para que ya esté listo al volver.
    window.addEventListener("online", regresar);

    conectar();

    return () => {
      desmontado = true;
      window.removeEventListener("focus", alVolverAlFrente);
      document.removeEventListener("visibilitychange", alVolverAlFrente);
      window.removeEventListener("online", regresar);
      pararRespaldo();
      cerrarFuente();
    };
    // Sin dependencias A PROPÓSITO: todo lo variable se lee por `ref`. Ver el
    // comentario de `onCambioRef` arriba.
  }, []);

  return { conectado };
}
