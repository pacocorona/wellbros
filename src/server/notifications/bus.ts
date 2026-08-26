/**
 * Bus de cambios del calendario — EN PROCESO.
 *
 * Su único trabajo es que alguien pueda decir «algo cambió en la propiedad X» y
 * que los flujos SSE abiertos se enteren en el acto (`/api/events`). Nada más:
 * no lleva datos del calendario, no consulta la base y no decide quién ve qué.
 *
 * QUÉ VIAJA Y POR QUÉ TAN POCO
 * El evento es `{ propertyId, ts }` y punto. Mandar aquí el estado de la semana
 * obligaría a resolver, en el momento de publicar, qué puede ver cada uno de los
 * suscriptores conectados —y el bus no sabe quién está al otro lado—. Con un
 * aviso mudo, cada cliente revalida por su cuenta contra las consultas de
 * siempre, que sí aplican los permisos. El bus no puede filtrar lo que no tiene.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LIMITACIÓN QUE HAY QUE TENER PRESENTE: ESTO VIVE EN LA MEMORIA DE UN PROCESO.
 *
 * Wellbros corre hoy como UNA sola instancia de Node (un servicio systemd, un
 * puerto interno, §04 del diseño), así que quien publica y quien escucha están
 * en el mismo proceso y esto basta y sobra.
 *
 * El día que haya MÁS DE UNA INSTANCIA —dos réplicas detrás de nginx, un
 * despliegue azul/verde con ambas encendidas, o cualquier plataforma que escale
 * sola— esto DEJA DE FUNCIONAR, y falla de la peor manera posible: sin error.
 * Cada proceso tendría su propio Set de oyentes, y una reserva atendida por la
 * instancia A no llegaría jamás a los navegadores conectados a la instancia B;
 * esos usuarios se quedarían con el calendario viejo hasta el respaldo de 30 s
 * del cliente. Nadie vería una excepción en ningún registro.
 *
 * La solución entonces es un bus COMPARTIDO —`LISTEN`/`NOTIFY` de PostgreSQL,
 * que ya está ahí, o Redis pub/sub— y solo hay que sustituir las dos funciones
 * de este archivo: `publicarCambio` pasaría a hacer NOTIFY y la suscripción se
 * colgaría de un LISTEN. Ni la ruta SSE ni los servicios de negocio cambian.
 * HOY NO HACE FALTA y meterlo sería infraestructura que mantener sin motivo.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** Lo que se emite. Deliberadamente pobre: un identificador y un instante. */
export interface CambioDeCalendario {
  /** Propiedad cuyo calendario cambió. */
  propertyId: string;
  /** Momento del cambio en milisegundos. Sirve para depurar y para ordenar. */
  ts: number;
}

export type OyenteDeCambios = (cambio: CambioDeCalendario) => void;

/**
 * El conjunto de oyentes cuelga de `globalThis`, igual que el cliente de Prisma
 * en `@/lib/db`, y por el mismo motivo con un matiz más:
 *
 *   · en desarrollo, cada recarga en caliente vuelve a evaluar este módulo; sin
 *     la caché global habría un bus nuevo por recarga y los avisos publicados
 *     desde un módulo recompilado no llegarían a los flujos ya abiertos;
 *   · en producción, Next compila la ruta y las Server Actions en entradas
 *     distintas. Apoyarse en que ambas comparten la misma instancia del módulo
 *     es una apuesta sobre el empaquetador. `globalThis` es del proceso, no del
 *     empaquetador: mientras haya UN proceso, hay UN bus.
 *
 * Por eso se guarda siempre, no solo fuera de producción.
 */
const globalParaBus = globalThis as unknown as {
  wellbrosCalendarBus?: Set<OyenteDeCambios>;
};

const oyentes: Set<OyenteDeCambios> =
  globalParaBus.wellbrosCalendarBus ?? new Set<OyenteDeCambios>();

globalParaBus.wellbrosCalendarBus = oyentes;

/**
 * Se apunta a los cambios y devuelve la función para DARSE DE BAJA.
 *
 * Quien se suscribe está OBLIGADO a llamarla cuando termina. Este es un
 * servicio de vida larga: un oyente que nadie retira sobrevive para siempre,
 * retiene por clausura el flujo SSE muerto al que pertenecía y se le sigue
 * llamando en cada publicación. Diez pestañas cerradas mal son diez fugas.
 *
 * La baja es idempotente: llamarla dos veces no hace nada la segunda.
 */
export function suscribirseACambios(oyente: OyenteDeCambios): () => void {
  oyentes.add(oyente);

  let activo = true;
  return () => {
    if (!activo) return;
    activo = false;
    oyentes.delete(oyente);
  };
}

/**
 * Anuncia que el calendario de una propiedad cambió.
 *
 * SÍNCRONA Y SIN ERRORES A PROPÓSITO. Se la llama justo después de confirmar
 * una transacción de negocio, y ahí el trabajo YA ESTÁ HECHO: si avisar
 * fallara y la excepción subiera, el usuario vería un error por una reserva que
 * de verdad quedó guardada. Lo peor que puede pasar aquí es que alguien tarde
 * 30 segundos de más en ver el cambio, y eso es exactamente lo que cubre el
 * respaldo por consulta periódica del cliente.
 *
 * @param ts Instante del cambio. Inyectable solo para las pruebas.
 */
export function publicarCambio(propertyId: string, ts: number = Date.now()): void {
  // Sin propiedad no hay a quién filtrar en el cliente: el aviso sería ruido
  // que despertaría a todas las pestañas abiertas para nada.
  if (!propertyId) return;

  const cambio: CambioDeCalendario = { propertyId, ts };

  // Se recorre una COPIA: un oyente puede darse de baja mientras se le avisa
  // —la ruta SSE lo hace en cuanto detecta que el flujo ya estaba cerrado— y
  // mutar el Set durante su propio recorrido es pedir problemas.
  for (const oyente of [...oyentes]) {
    try {
      oyente(cambio);
    } catch (error) {
      // Un oyente roto NO puede impedir que los demás se enteren. Se anota y se
      // sigue: el resto de las pestañas no tiene la culpa de que una fallara.
      console.error("[bus] un oyente del calendario falló", error);
    }
  }
}

/**
 * Cuántos flujos hay escuchando ahora mismo.
 *
 * Es la sonda de la fuga descrita arriba: en reposo, sin nadie conectado, tiene
 * que valer 0. Lo usan las pruebas y sirve para diagnosticar en producción.
 */
export function contarOyentes(): number {
  return oyentes.size;
}
