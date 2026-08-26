"use client";

/**
 * La pantalla del calendario: barra de control, retícula y paneles.
 *
 * Es el único componente con estado de toda la vista. Reparte trabajo así:
 *   · `page.tsx` (servidor) resuelve datos y construye las filas;
 *   · `MonthGrid` pinta y avisa qué semana se tocó;
 *   · aquí se decide qué panel abrir, se llama a la Server Action y se
 *     interpreta la respuesta.
 *
 * Tres decisiones que conviene entender antes de tocarlo:
 *
 * 1. LA SEMANA SELECCIONADA SE GUARDA COMO CLAVE, NO COMO OBJETO. Si se
 *    guardara el `WeekView` del clic, tras cederle un día a alguien el panel
 *    seguiría enseñando la semana vieja: el servidor ya devolvió datos frescos
 *    pero el estado local tendría una copia congelada. Guardando el viernes de
 *    la semana y volviéndola a buscar en las filas, el panel siempre refleja lo
 *    último que dijo el servidor.
 *
 * 2. LA ACTUALIZACIÓN OPTIMISTA SE APLICA COMO CAPA, NO REESCRIBIENDO LAS
 *    FILAS. `overrides` es un diccionario semana → estado provisional que se
 *    superpone al pintar; cuando llegan filas nuevas del servidor se vacía
 *    solo. Así revertir es borrar una entrada, no reconstruir nada.
 *
 * 3. EL RELOJ QUE MANDA ES EL DEL SERVIDOR. La cuenta regresiva de una semana
 *    programada mide el desfase con el navegador al cargar y trabaja con él. Un
 *    portátil con la hora adelantada no puede decir "ya abrió" antes de tiempo
 *    (§07).
 *
 * 4. EL CALENDARIO ESCUCHA. `useLiveCalendar` avisa de que algo cambió en la
 *    propiedad en pantalla y aquí se responde con `router.refresh()`: el evento
 *    solo dice "mira otra vez", nunca trae datos. Así el servidor sigue siendo
 *    la única fuente de la verdad y no hay dos formas de pintar una semana.
 *
 * (La conmutación entre la retícula y las tarjetas de móvil NO se decide aquí:
 * es CSS dentro de `MonthGrid`. Ver el encabezado de month-grid.tsx.)
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { CalendarRange } from "lucide-react";
import { toast } from "sonner";

// El <Toaster> ya no se monta aquí: vive en src/app/(app)/layout.tsx, para que
// cualquier pantalla del grupo autenticado pueda avisar. Dos Toaster montados a
// la vez pintan cada aviso por duplicado.
import { MonthGrid } from "@/components/calendar/month-grid";
import {
  segmentLabel,
  type Availability,
  type CalRow,
  type MaintenanceView,
  type Segment,
  type WeekView,
} from "@/lib/calendar-grid";
import {
  DEFAULT_PROPERTY_COLOR,
  propertyColorStyle,
} from "@/lib/property-color";
// El hook del canal en vivo lo entrega otro agente con esta firma exacta:
//   useLiveCalendar({ propertyId, onCambio }) => { conectado }
import { useLiveCalendar } from "@/lib/use-live-calendar";
import { cn } from "@/lib/utils";
import {
  cancelarReserva,
  cederDias,
  reservarSemana,
  revocarDias,
} from "@/server/actions/calendar-actions";

import { MonthNav } from "./month-nav";
import { PropertySelect, type PropiedadOpcion } from "./property-select";
import {
  ReserveDialog,
  etiquetaDiaCorto,
  etiquetaRangoExacto,
  unirConY,
} from "./reserve-dialog";
import {
  ReservationSheet,
  type UsuarioOpcion,
  type VisorCalendario,
} from "./reservation-sheet";
// Las dos listas viven en `./types` —junto a la tabla de estados— porque el
// selector de acción de la superusuaria necesita las mismas: si cada componente
// tuviera la suya, un día dejarían de coincidir y el menú ofrecería reservar
// una semana que el diálogo se niega a abrir.
import {
  ESTADOS_CON_DUENIO as ESTADOS_HOJA,
  ESTADOS_RESERVABLES as ESTADOS_DIALOGO,
} from "./types";
import { WeekActionDialog } from "./week-action-dialog";

/** Última propiedad elegida. Comodidad, no estado: la URL sigue mandando. */
const CLAVE_PROPIEDAD = "wellbros-propiedad";

/**
 * Todas las notas de mantenimiento que asoman por la retícula, sin repetir.
 *
 * Se recogen de las celdas y se deduplican por `id` porque una nota de tres
 * días aparece en tres celdas y es UNA. Sirven para que el formulario marque
 * los días que ya están anotados y no se dupliquen sin querer.
 */
function notasDeLaRejilla(filas: CalRow[]): MaintenanceView[] {
  const porId = new Map<string, MaintenanceView>();
  for (const fila of filas) {
    for (const segmento of fila.segments) {
      for (const celda of segmento.days) {
        for (const nota of celda.maintenance ?? []) porId.set(nota.id, nota);
      }
    }
  }
  return [...porId.values()];
}

/* -------------------------------------------------------------------------- */
/* Capa optimista                                                              */
/* -------------------------------------------------------------------------- */

interface Override {
  availability: Availability;
  reservedByName?: string;
  /** Cancelar se lleva por delante las cesiones de la semana. */
  sinCesiones?: boolean;
}

function buscarSemana(filas: CalRow[], clave: string | null): WeekView | null {
  if (!clave) return null;
  for (const fila of filas) {
    for (const segmento of fila.segments) {
      if (segmento.weekKey === clave) return segmento.week;
    }
  }
  return null;
}

function aplicarOverrides(
  filas: CalRow[],
  overrides: Record<string, Override>,
  hoyISO: string,
  zonaHoraria: string,
): CalRow[] {
  if (Object.keys(overrides).length === 0) return filas;

  // Los dos tramos de una semana tienen que compartir el MISMO objeto, igual
  // que hace `buildMonthGrid`: de ahí depende que el resaltado conjunto y las
  // comparaciones por identidad sigan funcionando.
  const memoria = new Map<string, WeekView>();

  return filas.map((fila) => ({
    segments: fila.segments.map((segmento): Segment => {
      const override = overrides[segmento.weekKey];
      if (!override) return segmento;

      let semana = memoria.get(segmento.weekKey);
      if (!semana) {
        semana = {
          ...segmento.week,
          availability: override.availability,
          reservedByName: override.reservedByName,
          grants: override.sinCesiones ? undefined : segmento.week.grants,
        };
        memoria.set(segmento.weekKey, semana);
      }

      return {
        ...segmento,
        availability: semana.availability,
        week: semana,
        // Solo el tramo de 5 celdas lleva etiqueta; en el de 2 no cabe.
        label:
          segmento.label === undefined
            ? undefined
            : segmentLabel(semana, hoyISO, zonaHoraria),
      };
    }),
  }));
}

/* -------------------------------------------------------------------------- */
/* Componente                                                                  */
/* -------------------------------------------------------------------------- */

export interface CalendarViewProps {
  /** Mes en pantalla, `yyyy-MM`. */
  mes: string;
  /** Filas ya construidas en el servidor con `buildMonthGrid`. */
  filas: CalRow[];
  propiedades: PropiedadOpcion[];
  propiedadId: string;
  /** La propiedad venía en la URL: un enlace compartido gana a lo recordado. */
  propiedadDesdeUrl: boolean;
  puedeMesAnterior: boolean;
  puedeMesSiguiente: boolean;
  visor: VisorCalendario;
  /** Personas activas a las que se les puede ceder días (sin el propio visor). */
  usuarios: UsuarioOpcion[];
  /** Hoy en la zona de negocio, `yyyy-MM-dd`. */
  hoyISO: string;
  zonaHoraria: string;
  /** Instante del servidor al renderizar, en ISO. Base del reloj de referencia. */
  ahoraServidorISO: string;
}

export function CalendarView({
  mes,
  filas,
  propiedades,
  propiedadId,
  propiedadDesdeUrl,
  puedeMesAnterior,
  puedeMesSiguiente,
  visor,
  usuarios,
  hoyISO,
  zonaHoraria,
  ahoraServidorISO,
}: CalendarViewProps) {
  const router = useRouter();
  const [navegando, iniciarNavegacion] = useTransition();

  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [claveDialogo, setClaveDialogo] = useState<string | null>(null);
  const [claveHoja, setClaveHoja] = useState<string | null>(null);
  // Solo la superusuaria: el paso previo donde elige entre reservar y anotar
  // mantenimiento. Para USER normal se queda en null para siempre.
  const [claveAccion, setClaveAccion] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Filas nuevas del servidor = la verdad ya llegó; lo provisional sobra. El
  // descarte se hace comparando DURANTE EL RENDER —el patrón que React
  // recomienda para reaccionar a un cambio de props— y no en un efecto, que
  // pintaría un fotograma con el estado optimista encima del real.
  const [filasVistas, setFilasVistas] = useState(filas);
  if (filasVistas !== filas) {
    setFilasVistas(filas);
    if (Object.keys(overrides).length > 0) setOverrides({});
  }

  const filasVisibles = useMemo(
    () => aplicarOverrides(filas, overrides, hoyISO, zonaHoraria),
    [filas, overrides, hoyISO, zonaHoraria],
  );

  // Un panel no se queda abierto sobre una semana que cambió de estado (la
  // cancelé, alguien la tomó) o que desapareció al cambiar de mes: la búsqueda
  // devuelve null y el panel se cierra solo, sin efecto de por medio.
  const semanaDialogo = useMemo(() => {
    const semana = buscarSemana(filasVisibles, claveDialogo);
    return semana && ESTADOS_DIALOGO.includes(semana.availability) ? semana : null;
  }, [filasVisibles, claveDialogo]);

  const semanaHoja = useMemo(() => {
    const semana = buscarSemana(filasVisibles, claveHoja);
    return semana && ESTADOS_HOJA.includes(semana.availability) ? semana : null;
  }, [filasVisibles, claveHoja]);

  // Sin filtro por estado, al contrario que los dos anteriores: el selector de
  // acción vale para CUALQUIER semana, porque el mantenimiento se anota también
  // en las pasadas, cerradas y sin apertura.
  const semanaAccion = useMemo(
    () => buscarSemana(filasVisibles, claveAccion),
    [filasVisibles, claveAccion],
  );

  // De `filas` y no de `filasVisibles`: la capa optimista solo toca el estado de
  // las semanas, nunca las notas, y así el cálculo no se rehace por una reserva.
  const notasVisibles = useMemo(() => notasDeLaRejilla(filas), [filas]);

  /* ----------------------------------------------------------------- URL */

  /**
   * Propiedad y mes viajan en la URL para que el enlace se pueda compartir y
   * para que "atrás" haga lo que se espera. `replace` y no `push`: pasear por
   * los meses no debería llenar el historial de escalones.
   */
  const irA = useCallback(
    (cambios: { propiedad?: string; mes?: string }) => {
      const params = new URLSearchParams();
      params.set("propiedad", cambios.propiedad ?? propiedadId);
      params.set("mes", cambios.mes ?? mes);
      // Cerrar los paneles antes de saltar: la semana que muestran puede no
      // existir en el destino.
      setClaveDialogo(null);
      setClaveHoja(null);
      setClaveAccion(null);
      iniciarNavegacion(() => {
        router.replace(`/?${params.toString()}`, { scroll: false });
      });
    },
    [router, propiedadId, mes],
  );

  /**
   * Recuerda la última propiedad elegida y la restaura al entrar sin
   * parámetros.
   *
   * Un solo efecto —y no uno por cosa— porque el orden importa: si se guardara
   * antes de leer, la lectura vería siempre lo que se acaba de escribir. La
   * navegación de restauración va con `router.replace` a pelo y no con `irA`:
   * un efecto debe hablar con el mundo exterior (la URL, el almacenamiento),
   * no empujar estado de React.
   */
  useEffect(() => {
    let guardada: string | null = null;
    try {
      guardada = window.localStorage.getItem(CLAVE_PROPIEDAD);
    } catch {
      // Navegación privada o almacenamiento bloqueado: se sigue sin memoria.
    }

    // La URL manda siempre: un enlace compartido no puede acabar en la casa
    // que quien lo abre miró por última vez.
    if (
      !propiedadDesdeUrl &&
      guardada &&
      guardada !== propiedadId &&
      propiedades.some((p) => p.id === guardada)
    ) {
      const params = new URLSearchParams({ propiedad: guardada, mes });
      router.replace(`/?${params.toString()}`, { scroll: false });
      return;
    }

    try {
      window.localStorage.setItem(CLAVE_PROPIEDAD, propiedadId);
    } catch {
      // Idem.
    }
  }, [propiedadDesdeUrl, propiedadId, propiedades, mes, router]);

  /* -------------------------------------------------------------- acciones */

  const quitarOverride = (clave: string) => {
    setOverrides((previo) => {
      if (!(clave in previo)) return previo;
      const copia = { ...previo };
      delete copia[clave];
      return copia;
    });
  };

  const refrescar = useCallback(() => {
    iniciarNavegacion(() => router.refresh());
  }, [router]);

  /* ---------------------------------------------------------------- en vivo */

  /**
   * Lo ocupado que está esto, en un ref.
   *
   * `alCambiarEnVivo` tiene que ser ESTABLE: no sé si el hook guarda la función
   * en un ref o la mete en las dependencias de su efecto, y si es lo segundo,
   * una identidad nueva en cada render reabriría la conexión en cada render.
   * Estable y leyendo el ref, la función no caduca y la conexión no se toca.
   */
  const ocupadoRef = useRef(ocupado);
  useEffect(() => {
    ocupadoRef.current = ocupado;
  }, [ocupado]);

  /**
   * Llega un aviso de que algo cambió en esta propiedad: se vuelve a pedir la
   * página. El evento no trae datos —solo dice "mira otra vez"— y así el
   * calendario nunca se pinta con dos verdades distintas.
   *
   * Con una acción en vuelo se ignora: refrescar en ese momento borraría la
   * capa optimista y la semana parpadearía a su estado anterior justo antes de
   * confirmarse. No se pierde nada, porque toda acción termina con su propio
   * `revalidatePath("/")`.
   */
  const alCambiarEnVivo = useCallback(() => {
    if (ocupadoRef.current) return;
    refrescar();
  }, [refrescar]);

  const { conectado } = useLiveCalendar({
    propertyId: propiedadId,
    onCambio: alCambiarEnVivo,
  });

  const confirmarReserva = async (motivoExcepcion?: string) => {
    const semana = semanaDialogo;
    if (!semana?.slotId || ocupado) return;

    const clave = semana.startDate;
    const rango = etiquetaRangoExacto(semana.startDate, semana.endDate);

    setOcupado(true);
    // Optimista: la semana se pinta como propia ANTES de que el servidor
    // conteste. Es lo que hace que el calendario se sienta inmediato.
    setOverrides((previo) => ({ ...previo, [clave]: { availability: "MIA" } }));
    setClaveDialogo(null);

    try {
      const resultado = await reservarSemana({
        slotId: semana.slotId,
        ...(motivoExcepcion ? { motivoExcepcion } : {}),
      });

      if (resultado.ok) {
        toast.success("Semana reservada", {
          description: `${rango}. Avisamos por correo a toda la casa.`,
        });
        return;
      }

      quitarOverride(clave);
      if (resultado.code === "SLOT_TAKEN") {
        // El caso que justifica todo el mecanismo: dos personas pulsando a la
        // vez el día de la apertura. Se nombra sin rodeos y se refresca.
        toast.error("Otra persona tomó esa semana primero", {
          description: "Actualizamos el calendario para que veas cómo quedó.",
        });
      } else {
        toast.error(resultado.message);
      }
      refrescar();
    } catch {
      // Falló el viaje, no la regla: nada se guardó y hay que deshacer.
      quitarOverride(clave);
      toast.error("No pudimos completar la reserva", {
        description: "Revisa tu conexión y vuelve a intentarlo.",
      });
    } finally {
      setOcupado(false);
    }
  };

  const cancelar = async (motivo: string | null) => {
    const semana = semanaHoja;
    if (!semana?.reservationId || ocupado) return;

    const clave = semana.startDate;
    const eraMia = semana.availability === "MIA";

    setOcupado(true);
    setOverrides((previo) => ({
      ...previo,
      [clave]: {
        // Una semana ya empezada vuelve a EN_CURSO, no a RESERVABLE: sigue
        // siendo tomable, pero no ofrece los siete días.
        availability: clave <= hoyISO ? "EN_CURSO" : "RESERVABLE",
        sinCesiones: true,
      },
    }));
    setClaveHoja(null);

    try {
      const resultado = await cancelarReserva({
        reservationId: semana.reservationId,
        ...(motivo ? { motivo } : {}),
      });

      if (resultado.ok) {
        const cesiones = resultado.datos.cesionesCanceladas;
        toast.success(
          eraMia ? "Reserva cancelada" : "Reserva cancelada por administración",
          {
            description:
              cesiones > 0
                ? `La semana vuelve a estar disponible. Se cancelaron ${cesiones} ${cesiones === 1 ? "día cedido" : "días cedidos"}.`
                : "La semana vuelve a estar disponible y avisamos a la casa.",
          },
        );
        return;
      }

      quitarOverride(clave);
      toast.error(resultado.message);
      refrescar();
    } catch {
      quitarOverride(clave);
      toast.error("No pudimos cancelar la reserva", {
        description: "Revisa tu conexión y vuelve a intentarlo.",
      });
    } finally {
      setOcupado(false);
    }
  };

  const ceder = async (granteeUserId: string, dias: string[]) => {
    const semana = semanaHoja;
    if (!semana?.reservationId || ocupado) return;

    setOcupado(true);
    try {
      // Sin capa optimista: una cesión cambia iniciales dentro de las celdas,
      // no el estado de la semana, y el ida y vuelta ya devuelve la retícula
      // pintada. Inventarla aquí sería copiar la lógica del servidor.
      const resultado = await cederDias({
        reservationId: semana.reservationId,
        granteeUserId,
        dates: dias,
      });

      if (resultado.ok) {
        toast.success("Días cedidos", {
          description: `Cediste ${unirConY(resultado.datos.dias.map(etiquetaDiaCorto))} a ${resultado.datos.granteeName}.`,
        });
        return;
      }

      toast.error(resultado.message);
      refrescar();
    } catch {
      toast.error("No pudimos ceder esos días", {
        description: "Revisa tu conexión y vuelve a intentarlo.",
      });
    } finally {
      setOcupado(false);
    }
  };

  const revocar = async (dias: string[]) => {
    const semana = semanaHoja;
    if (!semana?.reservationId || ocupado) return;

    setOcupado(true);
    try {
      const resultado = await revocarDias({
        reservationId: semana.reservationId,
        dates: dias,
      });

      if (resultado.ok) {
        const retirados = resultado.datos.dias;
        toast.success("Cesión retirada", {
          description: `${unirConY(retirados.map(etiquetaDiaCorto))} ${retirados.length === 1 ? "vuelve a ser tuyo" : "vuelven a ser tuyos"}.`,
        });
        return;
      }

      toast.error(resultado.message);
      refrescar();
    } catch {
      toast.error("No pudimos retirar la cesión", {
        description: "Revisa tu conexión y vuelve a intentarlo.",
      });
    } finally {
      setOcupado(false);
    }
  };

  /* ----------------------------------------------------------- interacción */

  /**
   * Para la superusuaria TODA semana responde al clic, incluidas PASADA,
   * CERRADA, PROGRAMADA y SIN_APERTURA: en ellas no se reserva, pero sí se
   * anota mantenimiento, que es justo donde suele haber obra. Para USER normal
   * no cambia nada.
   */
  const semanaAccionable = (semana: WeekView): boolean =>
    visor.esSuperusuaria ||
    ESTADOS_DIALOGO.includes(semana.availability) ||
    ESTADOS_HOJA.includes(semana.availability);

  const seleccionarSemana = (semana: WeekView) => {
    if (ocupado) return;

    // La superusuaria pasa primero por el selector: desde el calendario puede
    // reservar o anotar mantenimiento, y el clic solo no dice cuál de las dos.
    if (visor.esSuperusuaria) {
      setClaveDialogo(null);
      setClaveHoja(null);
      setClaveAccion(semana.startDate);
      return;
    }

    if (ESTADOS_HOJA.includes(semana.availability)) {
      setClaveDialogo(null);
      setClaveHoja(semana.startDate);
      return;
    }
    if (ESTADOS_DIALOGO.includes(semana.availability)) {
      setClaveHoja(null);
      setClaveDialogo(semana.startDate);
    }
  };

  const ocupadoONavegando = ocupado || navegando;

  // Identidad de la propiedad en pantalla. Se resuelve de la lista y no de una
  // prop aparte para que no puedan discrepar: el color siempre es el de la
  // propiedad que el combo está mostrando.
  const colorPropiedad =
    propiedades.find((p) => p.id === propiedadId)?.color ??
    DEFAULT_PROPERTY_COLOR;

  return (
    // Las cuatro variantes del color se emiten AQUÍ, en el contenedor común de
    // la barra fija y el calendario, para que ambos cambien a la vez al mover
    // el combo. Cuál se usa —clara u oscura— lo decide globals.css, no el
    // servidor: ver la CAPA WELLBROS de esa hoja.
    <div
      data-wb-prop=""
      style={propertyColorStyle(colorPropiedad)}
      className="flex flex-col gap-3"
    >
      {/* Barra de control fija: al recorrer meses largos el combo y las flechas
          tienen que seguir a mano. `top-14` la deja justo bajo la cabecera.
          Lleva un tinte muy suave de la propiedad —fondo y borde— para que la
          identidad no se corte donde empieza el calendario. */}
      <div className="sticky top-14 z-30 -mx-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--wb-prop-border)] bg-[var(--wb-prop-bar)] px-4 py-2 backdrop-blur transition-colors">
        <PropertySelect
          propiedades={propiedades}
          valor={propiedadId}
          onCambiar={(nueva) => irA({ propiedad: nueva })}
          pendiente={ocupadoONavegando}
        />
        {/* El título del mes toma el color de la propiedad. Se le pasa por la
            clase del contenedor en vez de abrir una prop en MonthNav: es un
            detalle de esta pantalla, no del control de navegación. */}
        <MonthNav
          mes={mes}
          puedeAnterior={puedeMesAnterior}
          puedeSiguiente={puedeMesSiguiente}
          onCambiarMes={(nuevo) => irA({ mes: nuevo })}
          pendiente={ocupadoONavegando}
          className="[&_h2]:text-[var(--wb-prop)] [&_h2]:transition-colors"
        />
      </div>

      <MonthGrid
        month={mes}
        rows={filasVisibles}
        onSelectWeek={seleccionarSemana}
        isWeekActionable={semanaAccionable}
        // Los dos datos que la vista de tarjetas necesita para etiquetar la
        // semana del borde del mes, la única cuyo tramo largo cae fuera.
        hoyISO={hoyISO}
        zonaHoraria={zonaHoraria}
        color={colorPropiedad}
        className={ocupadoONavegando ? "opacity-70 transition-opacity" : undefined}
      />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarRange className="size-3.5 shrink-0" aria-hidden />
          <span>
            Cada semana va de viernes 00:00 a jueves 23:59.{" "}
            {/* La frase cambia con la vista, y por las mismas clases que la
                cambian a ella: en móvil no hay dos tramos que tocar. */}
            <span className="hidden md:inline">
              Toca cualquiera de los dos tramos para actuar sobre la semana
              entera.
            </span>
            <span className="md:hidden">
              Toca una tarjeta para actuar sobre la semana entera.
            </span>
          </span>
        </p>

        {/* Señal de que el calendario se está actualizando solo. Discreta a
            propósito: un punto y dos palabras. Sin `aria-live`, porque una
            reconexión no es una noticia que merezca interrumpir a nadie. */}
        <p className="flex shrink-0 items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          <i
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              conectado
                ? "bg-[var(--wb-open-bd,#2F9E5B)] dark:bg-[var(--wb-open-bd,#34C56F)]"
                : "bg-current opacity-40",
            )}
          />
          {conectado ? "En vivo" : "Sin conexión en vivo"}
        </p>
      </div>

      {/* Solo para la superusuaria: para USER normal este diálogo no se monta
          siquiera, y su clic sigue yendo directo a reservar o a la hoja. */}
      {visor.esSuperusuaria ? (
        <WeekActionDialog
          semana={semanaAccion}
          abierto={semanaAccion !== null}
          onAbiertoChange={(abierto) => {
            if (!abierto) setClaveAccion(null);
          }}
          propiedadId={propiedadId}
          notas={notasVisibles}
          pendiente={ocupado}
          onReservar={() => {
            const clave = claveAccion;
            setClaveAccion(null);
            if (clave) setClaveDialogo(clave);
          }}
          onAbrirReserva={() => {
            const clave = claveAccion;
            setClaveAccion(null);
            if (clave) setClaveHoja(clave);
          }}
        />
      ) : null}

      <ReserveDialog
        semana={semanaDialogo}
        abierto={semanaDialogo !== null}
        onAbiertoChange={(abierto) => {
          if (!abierto) setClaveDialogo(null);
        }}
        onConfirmar={confirmarReserva}
        pendiente={ocupado}
        // La superusuaria está exenta de la ventana (§07); el servicio se lo
        // vuelve a preguntar y exige el motivo por escrito.
        puedeExcepcion={visor.esSuperusuaria}
        hoyISO={hoyISO}
        zonaHoraria={zonaHoraria}
        ahoraServidorISO={ahoraServidorISO}
      />

      <ReservationSheet
        semana={semanaHoja}
        abierta={semanaHoja !== null}
        onAbiertaChange={(abierta) => {
          if (!abierta) setClaveHoja(null);
        }}
        visor={visor}
        usuarios={usuarios}
        hoyISO={hoyISO}
        pendiente={ocupado}
        onCancelar={cancelar}
        onCeder={ceder}
        onRevocar={revocar}
      />
    </div>
  );
}
