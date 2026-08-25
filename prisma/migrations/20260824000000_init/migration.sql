-- ═══════════════════════════════════════════════════════════════════════════
-- Wellbros — migración inicial (PostgreSQL 17)
--
-- Escrita a mano porque contiene TODO lo que prisma/schema.prisma no puede
-- expresar y que, sin embargo, es la parte que de verdad protege las reglas de
-- negocio:
--   · columnas generadas (end_date, anchor_month)
--   · CHECK de coherencia (viernes, rangos, estados)
--   · índices únicos PARCIALES ("un slot, una reserva ACTIVA")
--   · triggers que validan cesiones y ventana de apertura dentro de la misma
--     transacción que la escritura
--   · una vista de disponibilidad para que la interfaz no reimplemente la regla
--
-- Convención: la base habla snake_case; el cliente Prisma expone camelCase
-- gracias a los @map del esquema. Los nombres de índice siguen la convención
-- de Prisma (<tabla>_<columnas>_idx / _key) para que la introspección no chille.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────── extensiones
-- citext: users.email debe comparar sin distinguir mayúsculas SIN que cada
-- consulta tenga que acordarse de aplicar lower(). El índice único lo hereda.
CREATE EXTENSION IF NOT EXISTS citext;

-- gen_random_uuid() es nativo desde PostgreSQL 13: no hace falta pgcrypto.

-- ───────────────────────────────────────────────────────────────── enums
-- Los nombres son los @map del esquema Prisma.

CREATE TYPE user_role           AS ENUM ('SUPERUSER', 'USER');
CREATE TYPE slot_status         AS ENUM ('OPEN', 'RESERVED', 'CLOSED');
CREATE TYPE reservation_status  AS ENUM ('ACTIVE', 'CANCELLED');
CREATE TYPE grant_status        AS ENUM ('ACTIVE', 'REVOKED', 'CANCELLED');
CREATE TYPE notif_channel       AS ENUM ('EMAIL', 'WHATSAPP');
CREATE TYPE outbox_status       AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD');
CREATE TYPE release_mode        AS ENUM ('OFFSET_DAYS', 'FIXED_DAY');
CREATE TYPE superuser_override  AS ENUM ('ALWAYS_EXEMPT', 'AUDITED', 'NEVER');

-- ══════════════════════════════════════════════════════════════ tablas
-- El orden es el de las claves foráneas:
--   users → sessions → properties → booking_policy → week_slots →
--   reservations → day_grants → maintenance_notes → audit_log →
--   notification_channels → notification_outbox → webhook_events

-- ─────────────────────────────────────────────────────────────── users

CREATE TABLE users (
    id              uuid          NOT NULL DEFAULT gen_random_uuid(),
    email           citext        NOT NULL,
    password_hash   text          NOT NULL,
    full_name       text          NOT NULL,
    -- E.164 (+52...). Nulo mientras no haya número para WhatsApp.
    phone           varchar(20),
    whatsapp_opt_in boolean       NOT NULL DEFAULT false,
    role            user_role     NOT NULL DEFAULT 'USER',
    theme           varchar(10)   NOT NULL DEFAULT 'system',
    is_active       boolean       NOT NULL DEFAULT true,
    created_at      timestamptz(6) NOT NULL DEFAULT now(),
    -- @updatedAt lo escribe el cliente Prisma; el DEFAULT existe para que las
    -- inserciones en SQL crudo (migraciones, respaldos) no fallen.
    updated_at      timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_theme_check CHECK (theme IN ('light', 'dark', 'system'))
);

CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_is_active_idx ON users (is_active);

-- ──────────────────────────────────────────────────────────── sessions
-- Sólo vive el HASH del token opaco; el token viaja en la cookie httpOnly.

CREATE TABLE sessions (
    id           uuid           NOT NULL DEFAULT gen_random_uuid(),
    user_id      uuid           NOT NULL,
    token_hash   text           NOT NULL,
    expires_at   timestamptz(6) NOT NULL,
    created_at   timestamptz(6) NOT NULL DEFAULT now(),
    last_seen_at timestamptz(6) NOT NULL DEFAULT now(),
    ip           varchar(64),
    user_agent   text,

    CONSTRAINT sessions_pkey PRIMARY KEY (id),
    CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
-- El barrido de sesiones caducadas es un DELETE ... WHERE expires_at < now().
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ────────────────────────────────────────────────────────── properties

CREATE TABLE properties (
    id         uuid           NOT NULL DEFAULT gen_random_uuid(),
    name       text           NOT NULL,
    is_active  boolean        NOT NULL DEFAULT true,
    created_at timestamptz(6) NOT NULL DEFAULT now(),
    updated_at timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT properties_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX properties_name_key ON properties (name);
CREATE INDEX properties_is_active_idx ON properties (is_active);

-- ────────────────────────────────────────────────────── booking_policy
-- Versionada: nunca se hace UPDATE destructivo. La fila vigente es la de mayor
-- effective_from <= now(), prefiriendo la de la propiedad sobre la global
-- (property_id IS NULL). Ver wb_effective_policy().

CREATE TABLE booking_policy (
    id                     uuid               NOT NULL DEFAULT gen_random_uuid(),
    property_id            uuid,
    time_zone              text               NOT NULL DEFAULT 'America/Mexico_City',
    mode                   release_mode       NOT NULL DEFAULT 'OFFSET_DAYS',
    booking_window_days    integer            NOT NULL DEFAULT 15,
    release_day_of_month   integer            NOT NULL DEFAULT 15,
    release_hour           integer            NOT NULL DEFAULT 0,
    release_minute         integer            NOT NULL DEFAULT 0,
    -- 0 = la semana cuenta en el mes de su viernes de inicio (confirmado).
    anchor_offset_days     integer            NOT NULL DEFAULT 0,
    allow_in_progress_week boolean            NOT NULL DEFAULT true,
    visible_horizon_months integer            NOT NULL DEFAULT 6,
    superuser_override     superuser_override NOT NULL DEFAULT 'ALWAYS_EXEMPT',
    effective_from         timestamptz(6)     NOT NULL DEFAULT now(),
    updated_by             uuid,
    created_at             timestamptz(6)     NOT NULL DEFAULT now(),

    CONSTRAINT booking_policy_pkey PRIMARY KEY (id),
    -- RESTRICT y no SET NULL: property_id NULL significa "política GLOBAL".
    -- Con SET NULL, borrar una propiedad ascendería su política particular a
    -- regla de toda la plataforma en silencio. Las propiedades se DESACTIVAN.
    CONSTRAINT booking_policy_property_id_fkey FOREIGN KEY (property_id)
        REFERENCES properties (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT booking_policy_updated_by_fkey FOREIGN KEY (updated_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,

    -- Rangos defensivos: una política corrupta rompería la ventana en silencio.
    CONSTRAINT booking_policy_window_days_check
        CHECK (booking_window_days BETWEEN 0 AND 366),
    CONSTRAINT booking_policy_release_day_check
        CHECK (release_day_of_month BETWEEN 1 AND 31),
    CONSTRAINT booking_policy_release_time_check
        CHECK (release_hour BETWEEN 0 AND 23 AND release_minute BETWEEN 0 AND 59),
    -- El anclaje sólo tiene sentido dentro de la propia semana.
    CONSTRAINT booking_policy_anchor_offset_check
        CHECK (anchor_offset_days BETWEEN 0 AND 6),
    CONSTRAINT booking_policy_horizon_check
        CHECK (visible_horizon_months BETWEEN 1 AND 60)
);

CREATE INDEX booking_policy_property_id_effective_from_idx
    ON booking_policy (property_id, effective_from);

-- ────────────────────────────────────────────────────────── week_slots
-- La semana es la unidad de reserva: viernes 00:00 → jueves 23:59, guardada
-- como FECHAS DE CALENDARIO (no timestamps): inmune a husos y horario de verano.

CREATE TABLE week_slots (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    property_id uuid        NOT NULL,
    start_date  date        NOT NULL,

    -- Jueves. Derivada: nadie puede escribir una semana de 5 u 8 días.
    end_date    date GENERATED ALWAYS AS (start_date + 6) STORED,

    -- Mes al que pertenece la semana para la ventana de apertura.
    --
    -- ATENCIÓN — ANCLAJE CONGELADO EN EL ESQUEMA: una columna generada exige una
    -- expresión IMMUTABLE, así que NO puede leer booking_policy.anchor_offset_days.
    -- Aquí queda grabado el valor confirmado con el cliente: 0, es decir, la
    -- semana pertenece al mes de su VIERNES DE INICIO. Cambiar la política a 3
    -- (mes con más días) o a 6 (semana completa) NO basta: obliga a una migración
    -- que redefina esta columna, por ejemplo
    --     ALTER TABLE week_slots DROP COLUMN anchor_month;
    --     ALTER TABLE week_slots ADD COLUMN anchor_month date
    --       GENERATED ALWAYS AS ((date_trunc('month', (start_date + 3)::timestamp))::date) STORED;
    -- Esta columna existe para poder FILTRAR CON ÍNDICE (anchor_month <= $1).
    -- Quien decide de verdad es wb_effective_policy(), que sí lee la política
    -- vigente: el trigger de reservas y la vista de disponibilidad la usan.
    anchor_month date GENERATED ALWAYS AS ((date_trunc('month', (start_date + 0)::timestamp))::date) STORED,

    status      slot_status    NOT NULL DEFAULT 'OPEN',
    created_by  uuid           NOT NULL,
    created_at  timestamptz(6) NOT NULL DEFAULT now(),
    updated_at  timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT week_slots_pkey PRIMARY KEY (id),
    CONSTRAINT week_slots_property_id_fkey FOREIGN KEY (property_id)
        REFERENCES properties (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT week_slots_created_by_fkey FOREIGN KEY (created_by)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,

    -- ISODOW: 1 = lunes … 5 = viernes. Invariante de todo el producto.
    CONSTRAINT week_slots_starts_on_friday_check
        CHECK (EXTRACT(ISODOW FROM start_date) = 5)
);

CREATE UNIQUE INDEX week_slots_property_id_start_date_key
    ON week_slots (property_id, start_date);
CREATE INDEX week_slots_property_id_anchor_month_start_date_idx
    ON week_slots (property_id, anchor_month, start_date);
CREATE INDEX week_slots_property_id_status_start_date_idx
    ON week_slots (property_id, status, start_date);

-- ──────────────────────────────────────────────────────── reservations

CREATE TABLE reservations (
    id              uuid               NOT NULL DEFAULT gen_random_uuid(),
    slot_id         uuid               NOT NULL,
    user_id         uuid               NOT NULL,
    status          reservation_status NOT NULL DEFAULT 'ACTIVE',
    -- Política vigente al crearla: permite explicar años después bajo qué regla
    -- se reservó. El trigger la rellena si la aplicación no la manda.
    policy_id       uuid,
    -- La creó el superusuario saltándose la ventana de apertura.
    window_override boolean            NOT NULL DEFAULT false,
    override_reason text,
    cancelled_at    timestamptz(6),
    cancelled_by    uuid,
    cancel_reason   text,
    created_at      timestamptz(6)     NOT NULL DEFAULT now(),

    CONSTRAINT reservations_pkey PRIMARY KEY (id),
    CONSTRAINT reservations_slot_id_fkey FOREIGN KEY (slot_id)
        REFERENCES week_slots (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT reservations_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT reservations_cancelled_by_fkey FOREIGN KEY (cancelled_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT reservations_policy_id_fkey FOREIGN KEY (policy_id)
        REFERENCES booking_policy (id) ON DELETE SET NULL ON UPDATE CASCADE,

    -- Una reserva cancelada SIEMPRE dice cuándo y quién: sin esto la bitácora
    -- quedaría cotejando contra filas mudas.
    CONSTRAINT reservations_cancellation_complete_check
        CHECK (
            status = 'ACTIVE'
            OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
        ),

    -- Saltarse la ventana exige justificarlo por escrito.
    CONSTRAINT reservations_override_reason_check
        CHECK (NOT window_override OR override_reason IS NOT NULL)
);

-- El corazón del producto: un slot admite UNA sola reserva ACTIVA. Parcial, para
-- que las canceladas puedan acumularse sin estorbar. Resuelve la carrera de dos
-- clics simultáneos sin bloqueos explícitos.
CREATE UNIQUE INDEX reservations_slot_id_active_key
    ON reservations (slot_id) WHERE status = 'ACTIVE';

CREATE INDEX reservations_user_id_status_idx ON reservations (user_id, status);
CREATE INDEX reservations_slot_id_idx ON reservations (slot_id);

-- ────────────────────────────────────────────────────────── day_grants
-- Cesión de días: automática, sin aceptación del receptor.

CREATE TABLE day_grants (
    id              uuid           NOT NULL DEFAULT gen_random_uuid(),
    reservation_id  uuid           NOT NULL,
    -- Dueño de la reserva al momento de ceder (snapshot).
    grantor_user_id uuid           NOT NULL,
    grantee_user_id uuid           NOT NULL,
    grant_date      date           NOT NULL,
    -- REVOKED = el dueño la retiró. CANCELLED = cayó al cancelar la reserva.
    status          grant_status   NOT NULL DEFAULT 'ACTIVE',
    ended_at        timestamptz(6),
    created_at      timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT day_grants_pkey PRIMARY KEY (id),
    CONSTRAINT day_grants_reservation_id_fkey FOREIGN KEY (reservation_id)
        REFERENCES reservations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT day_grants_grantor_user_id_fkey FOREIGN KEY (grantor_user_id)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT day_grants_grantee_user_id_fkey FOREIGN KEY (grantee_user_id)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,

    -- Cederse a uno mismo no es una cesión.
    CONSTRAINT day_grants_distinct_parties_check
        CHECK (grantee_user_id <> grantor_user_id)
);

-- Un día no se cede dos veces (mientras la cesión siga viva).
CREATE UNIQUE INDEX day_grants_reservation_id_grant_date_active_key
    ON day_grants (reservation_id, grant_date) WHERE status = 'ACTIVE';

CREATE INDEX day_grants_grantee_user_id_status_grant_date_idx
    ON day_grants (grantee_user_id, status, grant_date);
CREATE INDEX day_grants_reservation_id_idx ON day_grants (reservation_id);

-- ─────────────────────────────────────────────────── maintenance_notes
-- Visibles para todos; NO bloquean reservas (decisión de producto).

CREATE TABLE maintenance_notes (
    id          uuid           NOT NULL DEFAULT gen_random_uuid(),
    property_id uuid           NOT NULL,
    start_date  date           NOT NULL,
    end_date    date           NOT NULL,
    note        text           NOT NULL,
    created_by  uuid           NOT NULL,
    created_at  timestamptz(6) NOT NULL DEFAULT now(),
    updated_at  timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT maintenance_notes_pkey PRIMARY KEY (id),
    CONSTRAINT maintenance_notes_property_id_fkey FOREIGN KEY (property_id)
        REFERENCES properties (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT maintenance_notes_created_by_fkey FOREIGN KEY (created_by)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT maintenance_notes_date_range_check CHECK (end_date >= start_date)
);

CREATE INDEX maintenance_notes_property_id_start_date_idx
    ON maintenance_notes (property_id, start_date);

-- ─────────────────────────────────────────────────────────── audit_log
-- Append-only. Sólo la ve el superusuario. Ver la nota de permisos al final.

CREATE TABLE audit_log (
    id             bigserial      NOT NULL,
    actor_user_id  uuid,
    action         text           NOT NULL,
    entity_type    text           NOT NULL,
    entity_id      uuid,
    details        jsonb          NOT NULL DEFAULT '{}',
    ip             varchar(64),
    created_at     timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT audit_log_pkey PRIMARY KEY (id),
    -- RESTRICT y no SET NULL: borrar un usuario reescribiría la bitácora, que es
    -- justo lo que esta tabla existe para impedir. Los usuarios se DESACTIVAN.
    CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_entity_type_entity_id_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_user_id_idx ON audit_log (actor_user_id);

-- ─────────────────────────────────────────────── notification_channels
-- Datos NO sensibles. Las credenciales viven en variables de entorno.

CREATE TABLE notification_channels (
    channel    notif_channel  NOT NULL,
    is_enabled boolean        NOT NULL,
    config     jsonb          NOT NULL DEFAULT '{}',
    updated_at timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT notification_channels_pkey PRIMARY KEY (channel)
);

-- ──────────────────────────────────────────────── notification_outbox
-- Patrón outbox: el aviso se encola en la MISMA transacción que el evento de
-- negocio; un worker aparte lo envía con reintentos.

CREATE TABLE notification_outbox (
    id                  uuid           NOT NULL DEFAULT gen_random_uuid(),
    channel             notif_channel  NOT NULL,
    recipient_user_id   uuid           NOT NULL,
    -- Snapshot de la dirección al encolar.
    recipient_address   text           NOT NULL,
    event_type          text           NOT NULL,
    payload             jsonb          NOT NULL,
    -- Asunto y cuerpo CONGELADOS en el primer intento: los reintentos deben
    -- mandar exactamente lo mismo o Resend responde 409 al deduplicar.
    rendered_subject    text,
    rendered_html       text,
    rendered_text       text,
    dedupe_key          text           NOT NULL,
    status              outbox_status  NOT NULL DEFAULT 'PENDING',
    attempts            integer        NOT NULL DEFAULT 0,
    scheduled_for       timestamptz(6) NOT NULL DEFAULT now(),
    next_attempt_at     timestamptz(6) NOT NULL DEFAULT now(),
    last_error          text,
    provider_message_id text,
    sent_at             timestamptz(6),
    created_at          timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT notification_outbox_pkey PRIMARY KEY (id),
    CONSTRAINT notification_outbox_recipient_user_id_fkey FOREIGN KEY (recipient_user_id)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT notification_outbox_attempts_check CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX notification_outbox_dedupe_key_key
    ON notification_outbox (dedupe_key);
-- El worker consulta exactamente por esta terna.
CREATE INDEX notification_outbox_status_scheduled_for_next_attempt_at_idx
    ON notification_outbox (status, scheduled_for, next_attempt_at);
CREATE INDEX notification_outbox_provider_message_id_idx
    ON notification_outbox (provider_message_id);

-- ─────────────────────────────────────────────────────── webhook_events
-- Deduplicación de webhooks de Resend, que se entregan al menos una vez.

CREATE TABLE webhook_events (
    id          uuid           NOT NULL DEFAULT gen_random_uuid(),
    svix_id     text           NOT NULL,
    event_type  text           NOT NULL,
    payload     jsonb          NOT NULL,
    received_at timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT webhook_events_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX webhook_events_svix_id_key ON webhook_events (svix_id);

-- ═══════════════════════════════════════════════════════════ funciones
--
-- Códigos SQLSTATE propios (clase 'WB', libre según la documentación de
-- PostgreSQL) para que la aplicación distinga el motivo sin leer el mensaje:
--   WB001  la reserva no existe o no está ACTIVE
--   WB002  el día cedido cae fuera de la semana
--   WB003  quien cede no es el dueño de la reserva
--   WB010  la semana aún no abre / ya pasó / está en curso  (ventana)
--   WB011  el slot referido no existe

-- ─────────────────────────────────────────────── wb_month_release_at()
-- Instante exacto en que se habilita un mes, dado su primer día.
-- Gemela SQL de monthReleaseAt() en src/lib/booking-window.ts: si una cambia,
-- la otra también.
--
-- STABLE y no IMMUTABLE a propósito: `AT TIME ZONE` depende de la base tzdata
-- del servidor, que se actualiza sin avisar. Marcarla IMMUTABLE permitiría
-- indexarla y guardaría resultados obsoletos tras un cambio de reglas horarias.
CREATE FUNCTION wb_month_release_at(
    p_month_start date,
    p_mode        text,
    p_window_days integer,
    p_release_day integer,
    p_release_time time,
    p_tz          text
) RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_month date := (date_trunc('month', p_month_start::timestamp))::date;
    v_prev  date;
    v_day   integer;
    v_base  date;
BEGIN
    IF p_mode = 'FIXED_DAY' THEN
        v_prev := (v_month - interval '1 month')::date;
        -- Recorte: con día 31, febrero abre el 28 (o 29), no revienta.
        v_day  := least(
            p_release_day,
            EXTRACT(DAY FROM (v_prev + interval '1 month - 1 day'))::integer
        );
        v_base := v_prev + (v_day - 1);
    ELSE
        -- OFFSET_DAYS: la anticipación es lo constante, no la fecha. El día de
        -- apertura se mueve cada mes (17, 16, 15 o 14) y es correcto.
        v_base := v_month - p_window_days;
    END IF;

    -- La hora es hora de PARED en la zona de negocio.
    RETURN (v_base + p_release_time) AT TIME ZONE p_tz;
END;
$$;

COMMENT ON FUNCTION wb_month_release_at(date, text, integer, integer, time, text)
    IS 'Instante de apertura de un mes. Gemela de monthReleaseAt() en src/lib/booking-window.ts.';

-- ────────────────────────────────────────────── wb_effective_policy()
-- Política vigente para una propiedad: la de mayor effective_from <= now(),
-- prefiriendo la específica de la propiedad sobre la global (property_id NULL).
-- Devuelve 0 filas si todavía no hay ninguna política cargada.
CREATE FUNCTION wb_effective_policy(p_property_id uuid)
RETURNS TABLE (
    policy_id              uuid,
    time_zone              text,
    mode                   release_mode,
    booking_window_days    integer,
    release_day_of_month   integer,
    release_hour           integer,
    release_minute         integer,
    anchor_offset_days     integer,
    allow_in_progress_week boolean,
    visible_horizon_months integer,
    superuser_override     superuser_override
)
LANGUAGE sql
STABLE
AS $$
    SELECT p.id, p.time_zone, p.mode, p.booking_window_days, p.release_day_of_month,
           p.release_hour, p.release_minute, p.anchor_offset_days,
           p.allow_in_progress_week, p.visible_horizon_months, p.superuser_override
      FROM booking_policy p
     WHERE (p.property_id = p_property_id OR p.property_id IS NULL)
       AND p.effective_from <= now()
     -- La específica gana a la global; entre iguales, la más reciente.
     ORDER BY (p.property_id IS NOT NULL) DESC, p.effective_from DESC
     LIMIT 1;
$$;

-- ═══════════════════════════════════════════ triggers de reglas duras

-- ─────────────────────────────── day_grants: validación de la cesión
-- Comprueba, en la misma transacción del INSERT, que la reserva está ACTIVE,
-- que el día cae dentro de la semana y que quien cede es el dueño.
CREATE FUNCTION wb_day_grant_validate() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_status reservation_status;
    v_owner  uuid;
    v_start  date;
    v_end    date;
BEGIN
    -- FOR UPDATE OF r: toma el bloqueo de fila de la RESERVA (no del slot). Sin
    -- esto, una cancelación concurrente podría colarse entre esta lectura y el
    -- INSERT y dejar una cesión viva colgando de una reserva cancelada. Con el
    -- bloqueo, la cancelación espera y la cascada a CANCELLED alcanza esta fila.
    SELECT r.status, r.user_id, s.start_date, s.end_date
      INTO v_status, v_owner, v_start, v_end
      FROM reservations r
      JOIN week_slots s ON s.id = r.slot_id
     WHERE r.id = NEW.reservation_id
       FOR UPDATE OF r;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La reserva % no existe', NEW.reservation_id
            USING ERRCODE = 'WB001';
    END IF;

    IF v_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'No se pueden ceder días de una reserva % (estado %)',
                        NEW.reservation_id, v_status
            USING ERRCODE = 'WB001';
    END IF;

    IF NEW.grant_date < v_start OR NEW.grant_date > v_end THEN
        RAISE EXCEPTION 'El día % queda fuera de la semana % → %',
                        NEW.grant_date, v_start, v_end
            USING ERRCODE = 'WB002';
    END IF;

    IF NEW.grantor_user_id <> v_owner THEN
        RAISE EXCEPTION 'El usuario % no es el dueño de la reserva %',
                        NEW.grantor_user_id, NEW.reservation_id
            USING ERRCODE = 'WB003';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_day_grants_validate
    BEFORE INSERT ON day_grants
    FOR EACH ROW EXECUTE FUNCTION wb_day_grant_validate();

-- ──────────────────────── reservations: ventana de apertura (servidor)
-- Última línea de defensa. src/lib/booking-window.ts decide en la aplicación;
-- esto impide que un script, una consola psql o un bug se salten la regla.
--
-- BYPASS del superusuario: la aplicación abre la excepción con
--     SELECT set_config('wellbros.window_override', 'on', true);
-- dentro de la MISMA transacción (el tercer argumento, true = local, hace que
-- muera con la transacción).
--
-- El bypass NO es una puerta silenciosa: cuando se usa Y la reserva realmente
-- infringía la ventana, este trigger FUERZA window_override = true en la fila y
-- exige override_reason. Así la decisión confirmada («cada uso queda marcado en
-- la reserva y registrado en la bitácora») se cumple aunque quien inserte se
-- olvide de marcarla. Si la reserva estaba dentro de ventana, el GUC no marca
-- nada: no queremos etiquetar como excepción lo que no lo fue.
CREATE FUNCTION wb_reservation_window_check() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_property   uuid;
    v_start      date;
    v_pol        record;
    v_anchor     date;
    v_release    timestamptz;
    v_now        timestamptz := now();
    v_week_end   timestamptz;
    v_week_begin timestamptz;
    v_bypass     boolean;
    v_violacion  text := NULL;
BEGIN
    SELECT s.property_id, s.start_date
      INTO v_property, v_start
      FROM week_slots s
     WHERE s.id = NEW.slot_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El slot % no existe', NEW.slot_id USING ERRCODE = 'WB011';
    END IF;

    SELECT * INTO v_pol FROM wb_effective_policy(v_property);

    -- Sin política cargada no hay regla que aplicar: la migración siembra la
    -- global, así que esto sólo ocurre en una base a medio poblar.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Se rellena aunque luego haya bypass: la reserva debe poder explicarse.
    IF NEW.policy_id IS NULL THEN
        NEW.policy_id := v_pol.policy_id;
    END IF;

    -- Una reserva insertada ya cancelada (importaciones, respaldos) no se juzga.
    IF NEW.status <> 'ACTIVE' THEN
        RETURN NEW;
    END IF;

    v_bypass := coalesce(current_setting('wellbros.window_override', true), '') = 'on';

    -- Las semanas son días civiles; `now()` es un instante. Aquí se cruzan.
    v_week_begin := (v_start::timestamp) AT TIME ZONE v_pol.time_zone;
    -- El viernes siguiente a las 00:00 = fin del jueves 23:59:59.
    v_week_end   := ((v_start + 7)::timestamp) AT TIME ZONE v_pol.time_zone;

    -- El anclaje SÍ se lee de la política aquí (a diferencia de la columna
    -- generada week_slots.anchor_month, congelada en 0): así un cambio de
    -- política surte efecto sin migrar, y con el valor confirmado ambos coinciden.
    v_anchor := (date_trunc('month', (v_start + v_pol.anchor_offset_days)::timestamp))::date;

    v_release := wb_month_release_at(
        v_anchor,
        v_pol.mode::text,
        v_pol.booking_window_days,
        v_pol.release_day_of_month,
        make_time(v_pol.release_hour, v_pol.release_minute, 0),
        v_pol.time_zone
    );

    -- Se evalúa SIEMPRE, con bypass o sin él: hay que saber si hubo infracción
    -- para poder marcarla.
    IF v_now >= v_week_end THEN
        v_violacion := format('La semana del %s ya terminó', v_start);
    ELSIF NOT v_pol.allow_in_progress_week AND v_now >= v_week_begin THEN
        v_violacion := format('La semana del %s ya está en curso', v_start);
    ELSIF v_now < v_release THEN
        v_violacion := format('La semana del %s abre hasta %s', v_start, v_release);
    END IF;

    IF v_violacion IS NOT NULL THEN
        IF NOT v_bypass THEN
            RAISE EXCEPTION '%', v_violacion USING ERRCODE = 'WB010';
        END IF;

        -- Excepción consentida: queda marcada en la propia fila, siempre.
        NEW.window_override := true;

        IF NEW.override_reason IS NULL OR btrim(NEW.override_reason) = '' THEN
            RAISE EXCEPTION
                'Reserva fuera de ventana sin motivo (override_reason). %', v_violacion
                USING ERRCODE = 'WB012';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_reservations_window_check
    BEFORE INSERT ON reservations
    FOR EACH ROW EXECUTE FUNCTION wb_reservation_window_check();

-- ═════════════════════════════════════════════════════════════ vistas

-- ─────────────────────────────────────────── v_week_slot_availability
-- Traduce la regla completa a UNA columna para que el calendario no la
-- reimplemente. Espeja isWeekBookable() de src/lib/booking-window.ts:
--
--   PASADA     la semana ya terminó (jueves 23:59 pasado)
--   RESERVADA  existe una reserva ACTIVE
--   CERRADA    el superusuario cerró el slot
--   EN_CURSO   empezó y la política NO permite tomarla empezada
--              (con allow_in_progress_week = true —el valor confirmado— este
--               caso no aparece nunca: una semana en curso es RESERVABLE)
--   PROGRAMADA abre más adelante (release_at en el futuro)
--   RESERVABLE
--
-- El estado RESERVED del slot es denormalización de conveniencia: la verdad es
-- la existencia de una reserva ACTIVE, y por eso aquí manda el LEFT JOIN.
CREATE VIEW v_week_slot_availability AS
SELECT
    s.id,
    s.property_id,
    s.start_date,
    s.end_date,
    s.status,
    anc.anchor_month,
    rel.release_at,
    CASE
        WHEN v_now.t >= (((s.start_date + 7)::timestamp) AT TIME ZONE pol.time_zone)
            THEN 'PASADA'
        WHEN r.id IS NOT NULL
            THEN 'RESERVADA'
        WHEN s.status = 'CLOSED'
            THEN 'CERRADA'
        WHEN NOT pol.allow_in_progress_week
             AND v_now.t >= ((s.start_date::timestamp) AT TIME ZONE pol.time_zone)
            THEN 'EN_CURSO'
        WHEN v_now.t < rel.release_at
            THEN 'PROGRAMADA'
        ELSE 'RESERVABLE'
    END::text AS availability
FROM week_slots s
CROSS JOIN LATERAL (SELECT now() AS t) v_now
LEFT JOIN LATERAL wb_effective_policy(s.property_id) p ON true
-- Si la base aún no tiene política, se usan los valores confirmados con el
-- cliente en vez de dejar la disponibilidad en NULL.
CROSS JOIN LATERAL (
    SELECT coalesce(p.time_zone, 'America/Mexico_City')     AS time_zone,
           coalesce(p.mode::text, 'OFFSET_DAYS')            AS mode,
           coalesce(p.booking_window_days, 15)              AS booking_window_days,
           coalesce(p.release_day_of_month, 15)             AS release_day_of_month,
           coalesce(p.release_hour, 0)                      AS release_hour,
           coalesce(p.release_minute, 0)                    AS release_minute,
           coalesce(p.anchor_offset_days, 0)                AS anchor_offset_days,
           coalesce(p.allow_in_progress_week, true)         AS allow_in_progress_week
) pol
CROSS JOIN LATERAL (
    SELECT (date_trunc('month', (s.start_date + pol.anchor_offset_days)::timestamp))::date
           AS anchor_month
) anc
CROSS JOIN LATERAL (
    SELECT wb_month_release_at(
               anc.anchor_month,
               pol.mode,
               pol.booking_window_days,
               pol.release_day_of_month,
               make_time(pol.release_hour, pol.release_minute, 0),
               pol.time_zone
           ) AS release_at
) rel
LEFT JOIN reservations r
       ON r.slot_id = s.id AND r.status = 'ACTIVE';

COMMENT ON VIEW v_week_slot_availability
    IS 'Disponibilidad calculada por slot. Espeja isWeekBookable() de src/lib/booking-window.ts.';

-- ══════════════════════════════════════════════════ datos de arranque

-- Política global por defecto (property_id NULL), con los valores confirmados:
-- 15 días exactos de anticipación, anclaje al mes del viernes de inicio,
-- semana en curso permitida y superusuario exento (pero auditado en la reserva).
INSERT INTO booking_policy (
    property_id, time_zone, mode, booking_window_days, release_day_of_month,
    release_hour, release_minute, anchor_offset_days, allow_in_progress_week,
    visible_horizon_months, superuser_override, effective_from
)
SELECT NULL, 'America/Mexico_City', 'OFFSET_DAYS', 15, 15,
       0, 0, 0, true,
       6, 'ALWAYS_EXEMPT', now()
WHERE NOT EXISTS (SELECT 1 FROM booking_policy WHERE property_id IS NULL);

-- Canales de notificación: correo activo, WhatsApp preparado pero apagado.
INSERT INTO notification_channels (channel, is_enabled, config, updated_at)
VALUES
    ('EMAIL',    true,  '{}'::jsonb, now()),
    ('WHATSAPP', false, '{}'::jsonb, now())
ON CONFLICT (channel) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCCIÓN — bitácora append-only
--
-- audit_log sólo es de verdad inmutable si el rol con el que se conecta la
-- aplicación NO puede modificarla. Esto NO se hace aquí porque la migración
-- corre como DUEÑO de las tablas, y a un dueño los REVOKE no le aplican: hay
-- que crear un rol aparte para la aplicación y ejecutar, como superusuario de
-- la base y una sola vez por entorno:
--
--   -- 1) rol de la aplicación, distinto del dueño del esquema
--   CREATE ROLE wellbros_app LOGIN PASSWORD '...';
--   GRANT CONNECT ON DATABASE wellbros TO wellbros_app;
--   GRANT USAGE ON SCHEMA public TO wellbros_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wellbros_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wellbros_app;
--
--   -- 2) la bitácora se escribe, nunca se corrige ni se borra
--   REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM wellbros_app;
--   GRANT  SELECT, INSERT                ON TABLE audit_log TO wellbros_app;
--
--   -- 3) y que las tablas futuras nazcan con las mismas reglas
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wellbros_app;
--
-- DATABASE_URL debe apuntar entonces a wellbros_app, no al dueño. Las
-- migraciones siguen corriendo con el dueño (una URL distinta, fuera de la app).
-- ═══════════════════════════════════════════════════════════════════════════
