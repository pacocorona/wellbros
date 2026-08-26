-- ═══════════════════════════════════════════════════════════════════════════
-- Tokens de acceso de un solo uso.
--
-- EL PROBLEMA QUE RESUELVE
-- Hasta hoy, dar de alta a alguien significaba que la pantalla mostrara una
-- contraseña temporal y que la administradora se la dictara por teléfono o por
-- WhatsApp. Esa contraseña viaja por un canal que no controla nadie, queda
-- escrita en el historial del mensaje y, mientras no se cambie, la conocen al
-- menos dos personas. En su lugar sale un correo con un enlace que caduca, que
-- solo sirve una vez y que no contiene contraseña alguna: la primera que existe
-- en esa cuenta la escribe su dueña.
--
-- POR QUÉ LA TABLA NO SE LLAMA `invitations`
-- Porque el siguiente encargo —la recuperación de contraseña— necesita
-- exactamente el mismo mecanismo: 32 bytes aleatorios, en la base solo el hash,
-- caducidad corta, un solo uso y los anteriores invalidados al emitir uno nuevo.
-- Con una tabla de invitaciones habría que escribir una segunda tabla gemela,
-- con su segunda copia de la generación, el hasheo, el canje y sus pruebas; y
-- dos copias de un mecanismo de seguridad divergen siempre, normalmente en el
-- detalle que peor se ve desde fuera. Lo que cambia entre los dos casos es UNA
-- COLUMNA (`purpose`), no el modelo.
--
-- QUÉ SE GUARDA Y QUÉ NO
-- El token NUNCA se guarda. Solo su SHA-256, igual que en `sessions`: un
-- volcado de esta tabla no permite entrar como nadie ni reconstruir un enlace.
-- Y basta SHA-256 en vez de Argon2 por el mismo motivo que allá: no es una
-- contraseña elegida por una persona sino 256 bits aleatorios, contra los que
-- no existe diccionario. Lo que se busca aquí es que el valor robado de la base
-- no sea reutilizable, no encarecer la fuerza bruta.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────── enum
-- Los valores van en español, como los pide la tarea, y a diferencia del resto
-- de los enums del esquema. Es deliberado: son vocabulario de producto —lo que
-- la administración llama «invitación» y «restablecer contraseña»— y no
-- estados técnicos como OPEN o PENDING.

CREATE TYPE access_token_purpose AS ENUM ('INVITACION', 'RESTABLECER_CONTRASENA');

-- ─────────────────────────────────────────────────────────── access_tokens

CREATE TABLE access_tokens (
    id            uuid                 NOT NULL DEFAULT gen_random_uuid(),
    user_id       uuid                 NOT NULL,
    purpose       access_token_purpose NOT NULL,
    -- SHA-256 en hexadecimal: 64 caracteres exactos. El CHECK está para que un
    -- error de código no pueda meter aquí el token en claro sin que se note.
    token_hash    text                 NOT NULL,
    expires_at    timestamptz(6)       NOT NULL,
    -- Alguien lo canjeó. A partir de aquí el token está muerto para siempre.
    used_at       timestamptz(6),
    -- Lo dejamos obsoleto al emitir otro para la misma persona y propósito.
    superseded_at timestamptz(6),
    -- Quién lo emitió. Nulo cuando no hay actor: una recuperación de contraseña
    -- la inicia la propia persona desde la pantalla de acceso.
    created_by    uuid,
    ip            varchar(64),
    created_at    timestamptz(6)       NOT NULL DEFAULT now(),

    CONSTRAINT access_tokens_pkey PRIMARY KEY (id),

    CONSTRAINT access_tokens_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE,
    -- RESTRICT y no CASCADE: quién emitió un enlace es parte de la historia y
    -- no debe desaparecer sin que alguien lo decida. Los usuarios además no se
    -- borran, se desactivan.
    CONSTRAINT access_tokens_created_by_fkey FOREIGN KEY (created_by)
        REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT access_tokens_token_hash_check
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    -- Un token que nace caducado no es un token, es un error de reloj.
    CONSTRAINT access_tokens_expires_check
        CHECK (expires_at > created_at)
);

-- La búsqueda del canje es siempre por hash: es la clave real de acceso.
CREATE UNIQUE INDEX access_tokens_token_hash_key ON access_tokens (token_hash);

CREATE INDEX access_tokens_user_id_purpose_idx ON access_tokens (user_id, purpose);
CREATE INDEX access_tokens_expires_at_idx ON access_tokens (expires_at);

-- ──────────────────────────────────────── UN SOLO TOKEN VIGENTE A LA VEZ
--
-- La invariante que de verdad importa: emitir un enlace nuevo tiene que dejar
-- inservibles los anteriores. Si no, un enlace filtrado hace meses seguiría
-- abriendo la cuenta, y «pedir uno nuevo» no serviría para cerrarle la puerta a
-- nadie.
--
-- Se expresa como índice único PARCIAL y no como comprobación en el código
-- porque el código se puede olvidar: cualquier `INSERT` futuro que no invalide
-- primero los anteriores choca contra esta restricción en vez de dejar dos
-- enlaces buenos circulando en silencio.
--
-- El predicado NO menciona `expires_at`: los índices parciales exigen
-- predicados inmutables y `now()` no lo es. No hace falta — la función de
-- emisión marca `superseded_at` en TODOS los anteriores dentro de su misma
-- transacción, caducados incluidos, así que la fila nueva siempre encuentra el
-- hueco libre.
CREATE UNIQUE INDEX access_tokens_vigente_key
    ON access_tokens (user_id, purpose)
 WHERE used_at IS NULL AND superseded_at IS NULL;

-- ─────────────────────────────────────────────────────────────── nota
--
-- No se toca `users.password_hash` ni su tipo. Las cuentas creadas por
-- invitación nacen con un CENTINELA en esa columna: una cadena que no es un
-- hash de Argon2 y contra la que ninguna contraseña puede verificar (el
-- verificador trata una cadena ilegible como fallo de autenticación, nunca como
-- acierto). No es una columna nueva porque «no tiene contraseña» y «tiene una
-- que nadie sabe» son el mismo estado a efectos de acceso, y un NULL ahí
-- obligaría a comprobarlo en cada punto que hoy da por hecho que hay texto.
-- Ver SIN_CONTRASENA en src/server/admin/users.ts.
