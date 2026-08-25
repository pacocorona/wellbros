/**
 * Plantillas de los avisos, en español y con un diseño sobrio común.
 *
 * DETERMINISMO — la regla que gobierna este archivo (§08 del documento de
 * diseño): `render()` es una función PURA del par (evento, payload). No usa
 * `new Date()`, ni `Math.random()`, ni formatea fechas al vuelo, ni lee nada
 * que pueda cambiar entre dos llamadas. Motivo: la `dedupeKey` de cada fila
 * viaja a Resend como clave de idempotencia y su ventana dura 24 horas; si un
 * reintento enviara un cuerpo distinto bajo la misma clave, Resend rechaza la
 * petición (`invalid_idempotent_request`) en vez de reenviar. Todo lo variable
 * —fechas, nombres, etiquetas— llega ya formateado dentro del payload.
 *
 * (El worker además CONGELA el resultado en la propia fila en el primer
 * intento, así que ni siquiera un cambio de plantilla afecta a los avisos ya
 * encolados. La pureza de aquí es el segundo cinturón, no el único.)
 *
 * HTML pensado para clientes de correo: tablas, estilos en línea, sin fuentes
 * externas ni imágenes. Cada versión HTML tiene su gemela en texto plano.
 */

import type {
  GrantChangedPayload,
  MonthWindowOpenedPayload,
  NotificationEventType,
  RenderPayload,
  RenderedMessage,
  ReservationCancelledPayload,
  ReservationCreatedPayload,
  SlotsOpenedPayload,
  UserInvitedPayload,
  WeekRef,
} from "./types";

/** Nombre visible de la plataforma (pendiente de confirmar, §12). */
const NOMBRE_APP = "Wellbros";

const COLOR = {
  fondo: "#f4f4f2",
  tarjeta: "#ffffff",
  borde: "#e3e3df",
  texto: "#1c1c1a",
  suave: "#6b6b64",
  acento: "#2f5d50",
} as const;

// ─────────────────────────────────────────────────────────────── utilidades

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convierte una ruta relativa en enlace absoluto.
 *
 * APP_BASE_URL se lee en el render, no en el envío: el cuerpo se congela justo
 * después, así que un cambio posterior de dominio no altera avisos ya
 * renderizados (y por tanto no rompe la idempotencia de los reintentos).
 */
function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Primer nombre, para el saludo: «Hola Ivonne,» y no «Hola Ivonne Pérez,». */
function firstName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[0] ?? fullName;
}

type DetailRow = { label: string; value: string };

type Section = {
  /** Resumen que muchos clientes muestran junto al asunto. */
  preheader: string;
  heading: string;
  /** Párrafos de texto plano; se escapan al pasarlos a HTML. */
  paragraphs: string[];
  details?: DetailRow[];
  /** Lista de viñetas (semanas abiertas, días cedidos…). */
  bullets?: string[];
  cta?: { label: string; path: string };
  /** Aclaración final en letra pequeña. */
  note?: string;
};

function detailsHtml(rows: DetailRow[]): string {
  const cells = rows
    .map(
      (row) => `
            <tr>
              <td style="padding:4px 12px 4px 0;color:${COLOR.suave};font-size:14px;white-space:nowrap;vertical-align:top;">${esc(row.label)}</td>
              <td style="padding:4px 0;color:${COLOR.texto};font-size:14px;vertical-align:top;">${esc(row.value)}</td>
            </tr>`,
    )
    .join("");
  return `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;border-collapse:collapse;">
            <tbody>${cells}
            </tbody>
          </table>`;
}

function bulletsHtml(items: string[]): string {
  const lis = items
    .map(
      (item) =>
        `\n            <li style="margin:0 0 6px;color:${COLOR.texto};font-size:15px;line-height:1.5;">${esc(item)}</li>`,
    )
    .join("");
  return `
          <ul style="margin:18px 0 0;padding-left:20px;">${lis}
          </ul>`;
}

function ctaHtml(label: string, url: string): string {
  return `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;">
            <tbody>
              <tr>
                <td style="background:${COLOR.acento};border-radius:6px;">
                  <a href="${esc(url)}" style="display:inline-block;padding:11px 22px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${esc(label)}</a>
                </td>
              </tr>
            </tbody>
          </table>`;
}

function toHtml(section: Section): string {
  const url = section.cta ? absoluteUrl(section.cta.path) : null;
  const paragraphs = section.paragraphs
    .map(
      (p) =>
        `\n          <p style="margin:0 0 12px;color:${COLOR.texto};font-size:15px;line-height:1.6;">${esc(p)}</p>`,
    )
    .join("");

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${esc(section.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:${COLOR.fondo};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(section.preheader)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${COLOR.fondo};padding:32px 16px;">
      <tbody>
        <tr>
          <td align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:${COLOR.tarjeta};border:1px solid ${COLOR.borde};border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <tbody>
                <tr>
                  <td style="padding:26px 28px 0;">
                    <div style="color:${COLOR.suave};font-size:12px;letter-spacing:1.4px;text-transform:uppercase;">${esc(NOMBRE_APP)}</div>
                    <h1 style="margin:10px 0 16px;color:${COLOR.texto};font-size:20px;line-height:1.35;font-weight:600;">${esc(section.heading)}</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 28px 28px;">${paragraphs}${section.details ? detailsHtml(section.details) : ""}${section.bullets ? bulletsHtml(section.bullets) : ""}${section.cta && url ? ctaHtml(section.cta.label, url) : ""}${
                    section.note
                      ? `\n          <p style="margin:22px 0 0;color:${COLOR.suave};font-size:13px;line-height:1.5;">${esc(section.note)}</p>`
                      : ""
                  }
                  </td>
                </tr>
              </tbody>
            </table>
            <p style="margin:18px 0 0;color:${COLOR.suave};font-size:12px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              Recibes este aviso porque tienes cuenta en ${esc(NOMBRE_APP)}. Puedes responder a este correo para escribir a la administraci&oacute;n.
            </p>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;
}

function toText(section: Section): string {
  const lines: string[] = [NOMBRE_APP.toUpperCase(), "", section.heading, ""];
  lines.push(...section.paragraphs, "");

  if (section.details) {
    for (const row of section.details) lines.push(`${row.label}: ${row.value}`);
    lines.push("");
  }
  if (section.bullets) {
    for (const item of section.bullets) lines.push(`- ${item}`);
    lines.push("");
  }
  if (section.cta) {
    lines.push(`${section.cta.label}: ${absoluteUrl(section.cta.path)}`, "");
  }
  if (section.note) lines.push(section.note, "");

  lines.push(
    `Recibes este aviso porque tienes cuenta en ${NOMBRE_APP}. Puedes responder a este correo para escribir a la administración.`,
  );

  // Nunca más de un renglón en blanco seguido: el texto plano también se
  // compara byte a byte entre reintentos.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function weekLine(week: WeekRef): string {
  return `${week.propertyName} — ${week.label}`;
}

// ───────────────────────────────────────────────────────────── plantillas

function reservationCreated(
  p: RenderPayload<"RESERVATION_CREATED">,
): Section {
  const suyo = p.recipientUserId === p.ownerUserId;
  const details: DetailRow[] = [
    { label: "Propiedad", value: p.week.propertyName },
    { label: "Semana", value: p.week.label },
    { label: "Reserva a nombre de", value: p.ownerName },
  ];

  return {
    preheader: `${p.week.propertyName}: ${p.week.label}`,
    heading: suyo ? "Tu semana quedó reservada" : "Semana reservada",
    paragraphs: [
      `Hola ${firstName(p.recipientName)},`,
      suyo
        ? `Confirmamos tu reserva de ${p.week.propertyName} para la semana del ${p.week.label}.`
        : `${p.ownerName} reservó ${p.week.propertyName} para la semana del ${p.week.label}. Esa semana ya no está disponible.`,
    ],
    details,
    cta: { label: "Ver el calendario", path: p.path },
    note: p.windowOverride
      ? "La administración creó esta reserva antes de la apertura habitual de la ventana."
      : undefined,
  };
}

function reservationCancelled(
  p: RenderPayload<"RESERVATION_CANCELLED">,
): Section {
  const suyo = p.recipientUserId === p.ownerUserId;
  const details: DetailRow[] = [
    { label: "Propiedad", value: p.week.propertyName },
    { label: "Semana", value: p.week.label },
    { label: "Reserva era de", value: p.ownerName },
    { label: "Canceló", value: p.cancelledByName },
  ];
  if (p.cancelReason) details.push({ label: "Motivo", value: p.cancelReason });

  return {
    preheader: `${p.week.propertyName}: ${p.week.label} vuelve a estar libre`,
    heading: suyo ? "Tu reserva quedó cancelada" : "Semana liberada",
    paragraphs: [
      `Hola ${firstName(p.recipientName)},`,
      suyo
        ? `Tu reserva de ${p.week.propertyName} para la semana del ${p.week.label} quedó cancelada.`
        : `Se canceló la reserva de ${p.ownerName} en ${p.week.propertyName} para la semana del ${p.week.label}.`,
      p.availableFromLabel
        ? `La semana podrá reservarse a partir del ${p.availableFromLabel}.`
        : "La semana vuelve a estar disponible para quien quiera tomarla.",
    ],
    details,
    cta: { label: "Ver el calendario", path: p.path },
    note: "Si había días cedidos en esa semana, también quedaron sin efecto.",
  };
}

/** Qué papel juega quien lee en una cesión: cambia el tono, no los datos. */
function grantRole(p: GrantChangedPayload & { recipientUserId: string }) {
  if (p.recipientUserId === p.granteeUserId) return "GRANTEE" as const;
  if (p.recipientUserId === p.grantorUserId) return "GRANTOR" as const;
  return "OBSERVER" as const;
}

function grantCreated(p: RenderPayload<"GRANT_CREATED">): Section {
  const role = grantRole(p);
  const dias = p.days.map((d) => d.label);
  const cuantos = p.days.length === 1 ? "un día" : `${p.days.length} días`;

  const paragraphs: string[] = [`Hola ${firstName(p.recipientName)},`];
  if (role === "GRANTEE") {
    paragraphs.push(
      `${p.grantorName} te cedió ${cuantos} de su semana en ${p.week.propertyName}. No tienes que aceptar nada: los días ya son tuyos.`,
    );
  } else if (role === "GRANTOR") {
    paragraphs.push(
      `Cediste ${cuantos} de tu semana en ${p.week.propertyName} a ${p.granteeName}.`,
    );
  } else {
    paragraphs.push(
      `${p.grantorName} cedió ${cuantos} de su semana en ${p.week.propertyName} a ${p.granteeName}.`,
    );
  }

  return {
    preheader: `${p.week.propertyName}: ${cuantos} en la semana del ${p.week.label}`,
    heading:
      role === "GRANTEE" ? "Te cedieron días" : "Días cedidos",
    paragraphs,
    details: [
      { label: "Propiedad", value: p.week.propertyName },
      { label: "Semana", value: p.week.label },
      { label: "Cede", value: p.grantorName },
      { label: "Recibe", value: p.granteeName },
    ],
    bullets: dias,
    cta: { label: "Ver el calendario", path: p.path },
    note:
      role === "GRANTOR"
        ? "Puedes revocar la cesión mientras el día no haya llegado."
        : "El dueño de la semana puede revocar la cesión antes de la fecha.",
  };
}

function grantRevoked(p: RenderPayload<"GRANT_REVOKED">): Section {
  const role = grantRole(p);
  const dias = p.days.map((d) => d.label);
  const cuantos = p.days.length === 1 ? "un día" : `${p.days.length} días`;

  const paragraphs: string[] = [`Hola ${firstName(p.recipientName)},`];
  if (role === "GRANTEE") {
    paragraphs.push(
      `${p.grantorName} revocó ${cuantos} que te había cedido en ${p.week.propertyName}. Esos días vuelven a ser suyos.`,
    );
  } else if (role === "GRANTOR") {
    paragraphs.push(
      `Revocaste ${cuantos} que le habías cedido a ${p.granteeName} en ${p.week.propertyName}.`,
    );
  } else {
    paragraphs.push(
      `${p.grantorName} revocó ${cuantos} que le había cedido a ${p.granteeName} en ${p.week.propertyName}.`,
    );
  }

  return {
    preheader: `Cesión revocada en ${p.week.propertyName}`,
    heading: "Cesión revocada",
    paragraphs,
    details: [
      { label: "Propiedad", value: p.week.propertyName },
      { label: "Semana", value: p.week.label },
      { label: "Cedía", value: p.grantorName },
      { label: "Recibía", value: p.granteeName },
    ],
    bullets: dias,
    cta: { label: "Ver el calendario", path: p.path },
  };
}

function slotsOpened(p: RenderPayload<"SLOTS_OPENED">): Section {
  const cuantas =
    p.weeks.length === 1 ? "una semana nueva" : `${p.weeks.length} semanas nuevas`;

  return {
    preheader: `${cuantas} en ${p.propertyName}`,
    heading: "Nuevas semanas en el calendario",
    paragraphs: [
      `Hola ${firstName(p.recipientName)},`,
      `Se ${p.weeks.length === 1 ? "abrió" : "abrieron"} ${cuantas} en ${p.propertyName}.`,
      // La anticipación es configurable, así que el texto viene del payload y
      // no de la plantilla: quemarlo aquí haría mentir al correo en cuanto
      // alguien cambie la política.
      p.windowRuleLabel
        ? `Recuerda que una semana solo puede reservarse cuando su mes ya abrió: las del mes siguiente se habilitan ${p.windowRuleLabel}.`
        : "Recuerda que una semana solo puede reservarse cuando su mes ya abrió.",
    ],
    bullets: p.weeks.map((w) => w.label),
    cta: { label: "Ver el calendario", path: p.path },
  };
}

function monthWindowOpened(
  p: RenderPayload<"MONTH_WINDOW_OPENED">,
): Section {
  return {
    preheader: `Ya puedes reservar ${p.monthLabel}`,
    heading: `Ya puedes reservar ${p.monthLabel}`,
    paragraphs: [
      `Hola ${firstName(p.recipientName)},`,
      `Se abrió la ventana de reservas de ${p.monthLabel}. Las semanas de ese mes ya pueden tomarse, por orden de llegada.`,
    ],
    bullets:
      p.weeks.length > 0 ? p.weeks.map((w) => weekLine(w)) : undefined,
    cta: { label: `Reservar en ${p.monthLabel}`, path: p.path },
    note: "Todas las semanas libres del mes están disponibles para cualquiera; no hay apartados previos.",
  };
}

function userInvited(p: RenderPayload<"USER_INVITED">): Section {
  return {
    preheader: `Tu acceso a ${NOMBRE_APP} está listo`,
    heading: `Bienvenido a ${NOMBRE_APP}`,
    paragraphs: [
      `Hola ${firstName(p.fullName)},`,
      `${p.invitedByName} te dio de alta en ${NOMBRE_APP}, donde se reservan las semanas de las propiedades compartidas.`,
      "Para entrar por primera vez necesitas definir tu contraseña.",
    ],
    cta: { label: "Definir mi contraseña", path: p.path },
    note: `El enlace caduca en ${p.expiresInLabel}. Si expira, pide uno nuevo a la administración respondiendo a este correo.`,
  };
}

// ─────────────────────────────────────────────────────────────── fachada

type Renderer<E extends NotificationEventType> = (
  payload: RenderPayload<E>,
) => Section;

const SECCIONES: { [E in NotificationEventType]: Renderer<E> } = {
  RESERVATION_CREATED: reservationCreated,
  RESERVATION_CANCELLED: reservationCancelled,
  GRANT_CREATED: grantCreated,
  GRANT_REVOKED: grantRevoked,
  SLOTS_OPENED: slotsOpened,
  MONTH_WINDOW_OPENED: monthWindowOpened,
  USER_INVITED: userInvited,
};

const ASUNTOS: {
  [E in NotificationEventType]: (payload: RenderPayload<E>) => string;
} = {
  RESERVATION_CREATED: (p: RenderPayload<"RESERVATION_CREATED">) =>
    `Semana reservada — ${p.week.propertyName}, ${p.week.label}`,
  RESERVATION_CANCELLED: (p: RenderPayload<"RESERVATION_CANCELLED">) =>
    `Semana liberada — ${p.week.propertyName}, ${p.week.label}`,
  GRANT_CREATED: (p: RenderPayload<"GRANT_CREATED">) =>
    p.recipientUserId === p.granteeUserId
      ? `${p.grantorName} te cedió días en ${p.week.propertyName}`
      : `Días cedidos — ${p.week.propertyName}, ${p.week.label}`,
  GRANT_REVOKED: (p: RenderPayload<"GRANT_REVOKED">) =>
    p.recipientUserId === p.granteeUserId
      ? `${p.grantorName} revocó los días que te había cedido`
      : `Cesión revocada — ${p.week.propertyName}, ${p.week.label}`,
  SLOTS_OPENED: (p: RenderPayload<"SLOTS_OPENED">) =>
    `Nuevas semanas disponibles en ${p.propertyName}`,
  MONTH_WINDOW_OPENED: (p: RenderPayload<"MONTH_WINDOW_OPENED">) =>
    `Ya puedes reservar ${p.monthLabel}`,
  USER_INVITED: () => `Tu acceso a ${NOMBRE_APP}`,
};

/**
 * Renderiza un aviso. Función pura: mismas entradas, mismos bytes de salida.
 */
export function render<E extends NotificationEventType>(
  eventType: E,
  payload: RenderPayload<E>,
): RenderedMessage {
  const section = SECCIONES[eventType](payload);
  return {
    subject: ASUNTOS[eventType](payload),
    html: toHtml(section),
    text: toText(section),
  };
}

// Reexportados para que las pruebas puedan construir payloads sin importar de
// dos sitios distintos.
export type {
  GrantChangedPayload,
  MonthWindowOpenedPayload,
  ReservationCancelledPayload,
  ReservationCreatedPayload,
  SlotsOpenedPayload,
  UserInvitedPayload,
};
