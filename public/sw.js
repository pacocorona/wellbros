/* eslint-disable */
/**
 * Service worker de Wellbros.
 *
 * QUÉ HACE Y, SOBRE TODO, QUÉ NO HACE
 *
 * Este archivo existe para que la aplicación instalada arranque rápido y para
 * que, sin cobertura, muestre una explicación decente en vez de el dinosaurio
 * del navegador. NO existe para que la aplicación «funcione sin conexión»: en
 * un sistema de reservas eso es una trampa. La disponibilidad de una semana
 * cambia en cuanto otra persona reserva, y una copia guardada de hace media
 * hora enseñaría como libre una semana ya tomada. Por eso:
 *
 *   · El calendario NUNCA se sirve de la caché. Si no hay red, sale la página
 *     de cortesía; nunca datos viejos disfrazados de datos.
 *   · Las mutaciones (POST, y con ellas las Server Actions de Next) no pasan
 *     siquiera por aquí. Una reserva hecha sin conexión debe FALLAR de forma
 *     visible, no quedarse en una cola silenciosa que haga creer que está
 *     confirmada.
 *   · Solo se guarda lo que no puede mentir: el armazón (iconos y la propia
 *     página de cortesía) y los estáticos de /_next/static, cuyos nombres
 *     llevan huella de contenido y por tanto jamás cambian de significado.
 *
 * REGISTRO: lo hace `src/components/registrar-sw.tsx`, y solo en producción.
 *
 * DESPLIEGUE: este archivo NO DEBE quedar cacheado por nginx. Ver el bloque
 * `location = /sw.js` de `deploy/nginx/wellbros.conf` —hoy comentado—. Un
 * sw.js congelado en una caché intermedia es la peor avería posible de una
 * PWA: los navegadores seguirían ejecutando esta versión para siempre y no
 * habría forma de corregirlo desde el servidor.
 */

/**
 * Versión del service worker. SÚBELA A MANO cada vez que cambies este archivo.
 *
 * Es lo que da nombre a las cachés: al activarse una versión nueva se borran
 * todas las de las versiones anteriores. Si no la subes, las cachés viejas
 * sobreviven a los despliegues y acaban ocupando cuota sin que nadie las use.
 */
const VERSION = "1";

const CACHE_ARMAZON = "wellbros-armazon-v" + VERSION;
const CACHE_ESTATICOS = "wellbros-estaticos-v" + VERSION;
const CACHE_API = "wellbros-api-v" + VERSION;

const CACHES_VIGENTES = [CACHE_ARMAZON, CACHE_ESTATICOS, CACHE_API];

/**
 * Prefijo de TODAS nuestras cachés. La limpieza del `activate` solo borra las
 * que empiezan así: en el mismo origen puede haber almacenamiento de otras
 * cosas y borrar a ciegas todo lo que devuelve `caches.keys()` sería un
 * destrozo colateral.
 */
const PREFIJO_CACHE = "wellbros-";

/**
 * URL interna de la página de cortesía.
 *
 * No corresponde a ninguna ruta del servidor y no debe corresponder nunca: es
 * solo la clave con la que se guarda en la caché. El doble guion bajo del
 * principio es para que se note a simple vista que es un invento nuestro.
 * Nadie navega a ella; su contenido se devuelve como respuesta de la URL que
 * la persona pidió de verdad, así que la barra de direcciones conserva el
 * destino y el botón de reintentar vuelve a pedir esa misma página.
 */
const RUTA_SIN_CONEXION = "/__sin-conexion";

/** Armazón mínimo. Iconos, porque la página de cortesía los usa. */
const ARMAZON = ["/icono-192.png", "/icono-512.png", "/icono-maskable.png"];

/** Búsqueda rápida para decidir si una ruta se sirve del armazón. */
const RUTAS_ARMAZON = new Set(ARMAZON);

/**
 * Cuánto vale una respuesta de /api guardada.
 *
 * Un minuto. Pasado ese plazo la copia se tira y la petición falla como si no
 * hubiera red, que es justo lo que se quiere: en este producto un error
 * visible es preferible a una disponibilidad mentirosa. La caché de /api solo
 * sirve para tapar el bache de una red que va y viene, no para trabajar sin
 * conexión.
 */
const API_VIDA_MAXIMA_MS = 60 * 1000;

/** Cabecera propia con el instante en que se guardó una respuesta de /api. */
const CABECERA_GUARDADA = "x-wellbros-guardada-en";

/**
 * Tope de estáticos guardados.
 *
 * Cada despliegue de Next cambia la huella de los archivos de /_next/static,
 * así que sin un tope la caché crecería en cada despliegue hasta que el
 * navegador decidiera desalojar TODO el almacenamiento del origen de golpe
 * —incluida la página de cortesía—. `cache.keys()` devuelve las entradas en el
 * orden en que se insertaron, de modo que recortar por el principio elimina
 * las más antiguas.
 */
const MAX_ESTATICOS = 150;

// ───────────────────────────────────────────────────── página de cortesía

/**
 * Página que se ve sin conexión. Va aquí dentro, en una constante, y no en un
 * archivo de public/: así no depende de que una petición previa la haya
 * guardado y no puede quedarse desincronizada del service worker que la sirve.
 *
 * Se acompaña de una hoja de estilo en línea con los colores del producto
 * (globals.css) y respeta el tema: primero el que la persona eligió en la
 * aplicación —guardado en localStorage, mismo origen— y si no hay ninguno, el
 * del sistema.
 */
const HTML_SIN_CONEXION = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Sin conexión · Wellbros</title>
<style>
  :root {
    color-scheme: light dark;
    --fondo: #f6f4ee;
    --tinta: #202b36;
    --tinta-suave: #63707d;
    --tarjeta: #ffffff;
    --borde: #e0dcd0;
    --acento: #0e7490;
    --acento-tinta: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fondo: #0e1621;
      --tinta: #e6edf4;
      --tinta-suave: #8da0b2;
      --tarjeta: #16212e;
      --borde: #27384a;
      --acento: #3fc1d3;
      --acento-tinta: #06222b;
    }
  }
  /* El tema elegido a mano manda sobre el del sistema. Lo aplica el script
     del final leyendo la misma clave de localStorage que usa la aplicación. */
  html.tema-claro {
    color-scheme: light;
    --fondo: #f6f4ee; --tinta: #202b36; --tinta-suave: #63707d;
    --tarjeta: #ffffff; --borde: #e0dcd0;
    --acento: #0e7490; --acento-tinta: #ffffff;
  }
  html.tema-oscuro {
    color-scheme: dark;
    --fondo: #0e1621; --tinta: #e6edf4; --tinta-suave: #8da0b2;
    --tarjeta: #16212e; --borde: #27384a;
    --acento: #3fc1d3; --acento-tinta: #06222b;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--fondo);
    color: var(--tinta);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 24rem;
    text-align: center;
    background: var(--tarjeta);
    border: 1px solid var(--borde);
    border-radius: 14px;
    padding: 32px 24px;
  }
  img {
    width: 56px;
    height: 56px;
    border-radius: 14px;
    display: block;
    margin: 0 auto 20px;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  p { margin: 0 0 12px; font-size: 0.9rem; color: var(--tinta-suave); }
  p.ultima { margin-bottom: 24px; }
  button {
    width: 100%;
    padding: 10px 16px;
    font: inherit;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--acento-tinta);
    background: var(--acento);
    border: 0;
    border-radius: 9px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: progress; }
  small { display: block; margin-top: 14px; font-size: 0.75rem; color: var(--tinta-suave); }
</style>
</head>
<body>
<main>
  <img src="/icono-192.png" alt="" width="56" height="56">
  <h1>Sin conexión</h1>
  <p>El calendario necesita internet. La disponibilidad de las semanas cambia
     en cuanto alguien reserva, así que preferimos no enseñarte una copia
     guardada antes que enseñarte una semana libre que ya no lo está.</p>
  <p class="ultima">Si estabas reservando o cediendo una semana, no se ha
     enviado nada: tendrás que repetirlo cuando vuelvas a tener señal.</p>
  <button id="reintentar" type="button">Reintentar</button>
  <small id="aviso">Lo intentaremos solos en cuanto vuelva la conexión.</small>
</main>
<script>
  (function () {
    // Mismo tema que la aplicación. La clave la fija src/app/layout.tsx.
    try {
      var tema = localStorage.getItem("wellbros-theme");
      if (tema === "dark") document.documentElement.className = "tema-oscuro";
      else if (tema === "light") document.documentElement.className = "tema-claro";
    } catch (e) { /* almacenamiento bloqueado: se queda el tema del sistema */ }

    var boton = document.getElementById("reintentar");
    var aviso = document.getElementById("aviso");

    function reintentar() {
      boton.disabled = true;
      aviso.textContent = "Reintentando…";
      // Recarga la URL real que se pidió, no esta página: el navegador
      // conserva la dirección de destino aunque el contenido venga de aquí.
      location.reload();
    }

    boton.addEventListener("click", reintentar);
    // Volver a intentarlo solo cuando el sistema avise de que hay red. Es una
    // pista, no una certeza (puede haber wifi sin salida a internet), pero si
    // falla se vuelve a esta misma página y no se pierde nada.
    window.addEventListener("online", reintentar);
  })();
</script>
</body>
</html>
`;

/** Construye la respuesta de la página de cortesía. */
function respuestaSinConexion() {
  return new Response(HTML_SIN_CONEXION, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Que ninguna caché intermedia ni el navegador la conserven asociada a
      // la URL real que se pidió: en cuanto vuelva la red debe verse la página
      // de verdad.
      "Cache-Control": "no-store",
    },
  });
}

// ──────────────────────────────────────────────────────────── instalación

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_ARMAZON);

      // La página de cortesía primero: es lo único imprescindible.
      await cache.put(RUTA_SIN_CONEXION, respuestaSinConexion());

      // Los iconos, uno a uno y tolerando fallos. Con `cache.addAll` un solo
      // 404 —un despliegue a medias, por ejemplo— aborta la instalación
      // entera y el service worker no llega a activarse nunca: nos quedaríamos
      // sin página de cortesía por no poder guardar un icono.
      await Promise.all(
        ARMAZON.map((ruta) =>
          // `cache: "reload"` salta la caché HTTP del navegador; si no, el
          // precacheo podría estar guardando una copia ya rancia.
          cache
            .add(new Request(ruta, { cache: "reload" }))
            .catch(() => undefined),
        ),
      );

      // Tomar el relevo sin esperar a que se cierren todas las pestañas.
      //
      // El riesgo habitual de `skipWaiting` —una página del despliegue viejo
      // servida por el service worker nuevo— aquí no aplica: lo único que se
      // sirve de caché son archivos de /_next/static, cuyo nombre lleva huella
      // de contenido y por tanto nunca significa dos cosas distintas. A cambio,
      // una corrección de este archivo llega a todo el mundo en la siguiente
      // carga y no cuando le apetezca al navegador.
      await self.skipWaiting();
    })(),
  );
});

// ───────────────────────────────────────────────────────────── activación

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    (async () => {
      const nombres = await caches.keys();

      await Promise.all(
        nombres
          .filter(
            (nombre) =>
              nombre.startsWith(PREFIJO_CACHE) &&
              !CACHES_VIGENTES.includes(nombre),
          )
          .map((nombre) => caches.delete(nombre)),
      );

      // Hacerse cargo de las pestañas ya abiertas, que si no seguirían sin
      // service worker hasta la próxima navegación.
      await self.clients.claim();
    })(),
  );
});

// ─────────────────────────────────────────────────────────────── mensajes

self.addEventListener("message", (evento) => {
  const datos = evento.data;
  if (!datos || datos.tipo !== "wellbros:limpiar-caches") return;

  // GANCHO PARA EL CIERRE DE SESIÓN. La caché de /api puede contener, durante
  // un minuto, respuestas de la persona que tenía la sesión abierta. En un
  // teléfono compartido eso no debería sobrevivir a un «cerrar sesión», así
  // que basta con enviar este mensaje desde el manejador de salida:
  //
  //   navigator.serviceWorker.controller?.postMessage({
  //     tipo: "wellbros:limpiar-caches",
  //   });
  //
  // No se tocan ni el armazón ni los estáticos: no son de nadie.
  evento.waitUntil(caches.delete(CACHE_API));
});

// ────────────────────────────────────────────────────────── intercepción

self.addEventListener("fetch", (evento) => {
  const peticion = evento.request;

  // ── 1. SOLO GET ──────────────────────────────────────────────────────
  //
  // ESTA LÍNEA ES LA MÁS IMPORTANTE DEL ARCHIVO. Deja fuera POST, PUT, PATCH,
  // DELETE y, con ellos, TODAS las Server Actions de Next —que viajan como
  // POST a la propia página con la cabecera `Next-Action`—. Al no llamar a
  // `respondWith`, el navegador hace la petición él mismo, exactamente como si
  // no hubiera service worker.
  //
  // Una mutación no se guarda, no se reintenta y no se encola. Si alguien
  // reserva una semana sin cobertura, la acción tiene que fallar y decirlo. La
  // alternativa —una cola de fondo que la envíe «cuando se pueda»— haría creer
  // que la semana está apartada y la enviaría minutos después, quizá contra un
  // calendario en el que ya no está libre.
  if (peticion.method !== "GET") return;

  const url = new URL(peticion.url);

  // ── 2. Solo nuestro propio origen ────────────────────────────────────
  // Descarta de paso los esquemas raros (chrome-extension:, data:…), que
  // rompen la Cache API.
  if (url.origin !== self.location.origin) return;

  // ── 3. El propio service worker jamás se intercepta ──────────────────
  // Si esta versión guardara /sw.js, la siguiente no podría reemplazarla.
  if (url.pathname === "/sw.js") return;

  // ── 4. Peticiones parciales ──────────────────────────────────────────
  // Con `Range` la respuesta es un 206, que la Cache API no admite.
  if (peticion.headers.has("range")) return;

  // ── 5. Navegación: primero la red, y si no, la cortesía ───────────────
  if (peticion.mode === "navigate") {
    evento.respondWith(navegacion(peticion));
    return;
  }

  // ── 6. Cargas del enrutador de Next (RSC) ────────────────────────────
  //
  // Las navegaciones «blandas» y las precargas del App Router no son
  // documentos: son peticiones con la cabecera `RSC` o el parámetro `_rsc`, y
  // su respuesta es el árbol del servidor con los datos del calendario dentro.
  // Ni se guardan ni se les da la página de cortesía: devolver HTML donde el
  // enrutador espera un flujo RSC lo dejaría en un estado incoherente. Se
  // dejan pasar a la red; si fallan, Next hace una navegación completa y esa
  // sí acaba en el punto 5.
  if (peticion.headers.has("RSC") || url.searchParams.has("_rsc")) return;

  // ── 7. Flujos de eventos (SSE) ───────────────────────────────────────
  //
  // `/api/events` es un flujo `text/event-stream` que no termina nunca: es lo
  // que mantiene el calendario al día sin recargar. Si cayera en el manejador
  // de /api del punto 9, este service worker haría `clone()` de la respuesta y
  // se quedaría leyéndola en memoria para guardarla, esperando un final que no
  // llega: memoria creciendo sin parar y, en algunos navegadores, el flujo
  // retenido y los avisos del calendario llegando tarde o no llegando.
  //
  // Se mira la cabecera `Accept` y no la ruta a propósito: así queda protegido
  // cualquier flujo que se añada mañana, sin tener que acordarse de este
  // archivo.
  const acepta = peticion.headers.get("Accept") || "";
  if (acepta.includes("text/event-stream")) return;

  // ── 8. Estáticos con huella de contenido ─────────────────────────────
  if (url.pathname.startsWith("/_next/static/")) {
    evento.respondWith(primeroLaCache(peticion, CACHE_ESTATICOS, true));
    return;
  }

  // ── 9. API: primero la red, siempre ──────────────────────────────────
  if (url.pathname.startsWith("/api/")) {
    evento.respondWith(primeroLaRedEnApi(peticion));
    return;
  }

  // ── 10. Armazón precacheado ──────────────────────────────────────────
  if (RUTAS_ARMAZON.has(url.pathname)) {
    evento.respondWith(primeroLaCache(peticion, CACHE_ARMAZON, false));
    return;
  }

  // ── 11. Todo lo demás, sin tocar ─────────────────────────────────────
  // Sin `respondWith` el navegador se encarga. Interceptar por interceptar
  // solo añade una capa donde puede fallar algo.
});

// ────────────────────────────────────────────────────────── estrategias

/**
 * Navegación: primero la red; si no hay red, la página de cortesía.
 *
 * NO SE GUARDA NINGUNA RESPUESTA DE NAVEGACIÓN, y no es un olvido. El HTML de
 * este producto trae el calendario ya renderizado: quién tiene cada semana y
 * cuáles quedan libres. Servir esa página desde la caché sería enseñar la
 * disponibilidad del día que se guardó. Mejor la pantalla de cortesía, que al
 * menos no miente.
 *
 * Solo se cae a la cortesía cuando `fetch` LANZA, es decir cuando no hay red.
 * Un 500 o un 502 del servidor se devuelven tal cual: son un problema
 * distinto y taparlos con «sin conexión» despistaría a quien lo diagnostique.
 */
async function navegacion(peticion) {
  try {
    return await fetch(peticion);
  } catch {
    const cache = await caches.open(CACHE_ARMAZON);
    const guardada = await cache.match(RUTA_SIN_CONEXION);
    // El respaldo del respaldo: si la caché se vació (cuota, modo privado),
    // la página se construye aquí mismo.
    return guardada || respuestaSinConexion();
  }
}

/**
 * Primero la caché y, si no está, la red.
 *
 * Solo para cosas inmutables. En /_next/static el nombre del archivo lleva la
 * huella de su contenido: si cambia el contenido, cambia la URL, así que una
 * copia guardada no puede quedarse obsoleta.
 *
 * @param {boolean} recortar Si hay que aplicar el tope de entradas.
 */
async function primeroLaCache(peticion, nombreCache, recortar) {
  const cache = await caches.open(nombreCache);

  const guardada = await cache.match(peticion);
  if (guardada) return guardada;

  const respuesta = await fetch(peticion);

  // `type === "basic"` descarta respuestas opacas; `status === 200` descarta
  // redirecciones y errores, que no tiene sentido inmortalizar.
  if (respuesta.status === 200 && respuesta.type === "basic") {
    // Sin `await`: guardar no debe retrasar la entrega del archivo.
    cache
      .put(peticion, respuesta.clone())
      .then(() => (recortar ? recortarCache(cache, MAX_ESTATICOS) : undefined))
      .catch(() => undefined);
  }

  return respuesta;
}

/**
 * Primero la red para /api; la copia guardada solo si la red falla Y no ha
 * caducado.
 *
 * Con red, la respuesta es siempre la del servidor: nunca se sirve una copia
 * teniendo la de verdad a mano. Sin red, se acepta una copia de menos de un
 * minuto —lo justo para sobrevivir a un túnel o a un cambio de antena— y nada
 * más viejo que eso. Si no hay copia utilizable se devuelve un 503 con el
 * mismo formato de error que usa el resto de la aplicación, para que quien
 * llame reciba JSON y no un fallo de red sin explicación.
 */
async function primeroLaRedEnApi(peticion) {
  const cache = await caches.open(CACHE_API);

  try {
    const respuesta = await fetch(peticion);

    if (
      respuesta.status === 200 &&
      respuesta.type === "basic" &&
      sePuedeGuardar(respuesta)
    ) {
      const copia = await conMarcaDeTiempo(respuesta.clone());
      cache.put(peticion, copia).catch(() => undefined);
    }

    return respuesta;
  } catch {
    const guardada = await cache.match(peticion);

    if (guardada && !haCaducado(guardada)) return guardada;

    // Una copia caducada no vuelve a servir jamás: fuera de la caché.
    if (guardada) await cache.delete(peticion);

    return new Response(
      JSON.stringify({
        error: "SIN_CONEXION",
        message: "No hay conexión. Inténtalo de nuevo cuando vuelva la red.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────── apoyos

/** Respeta un `Cache-Control: no-store` del servidor. */
function sePuedeGuardar(respuesta) {
  const control = respuesta.headers.get("Cache-Control") || "";
  return !control.includes("no-store");
}

/**
 * Copia la respuesta añadiéndole la marca de tiempo.
 *
 * Hay que reconstruirla entera porque las cabeceras de una respuesta recibida
 * son de solo lectura. No se usa la cabecera `Date` del servidor: puede venir
 * de un intermediario, tiene resolución de segundos y depende de que el reloj
 * del servidor y el del teléfono coincidan. Aquí solo interesa cuánto tiempo
 * lleva guardada según el propio dispositivo.
 */
async function conMarcaDeTiempo(respuesta) {
  const cabeceras = new Headers(respuesta.headers);
  cabeceras.set(CABECERA_GUARDADA, String(Date.now()));

  return new Response(await respuesta.blob(), {
    status: respuesta.status,
    statusText: respuesta.statusText,
    headers: cabeceras,
  });
}

/** Una copia sin marca legible se considera caducada: en la duda, no vale. */
function haCaducado(respuesta) {
  const marca = Number(respuesta.headers.get(CABECERA_GUARDADA));
  if (!Number.isFinite(marca) || marca <= 0) return true;
  return Date.now() - marca > API_VIDA_MAXIMA_MS;
}

/** Deja la caché en `maximo` entradas, borrando las más antiguas. */
async function recortarCache(cache, maximo) {
  const claves = await cache.keys();
  if (claves.length <= maximo) return;

  // `keys()` conserva el orden de inserción, así que el principio del array
  // son las entradas más viejas.
  await Promise.all(
    claves.slice(0, claves.length - maximo).map((clave) => cache.delete(clave)),
  );
}
