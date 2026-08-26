-- Estados de entrega del correo: lo que cuenta el webhook de Resend.
--
-- El problema que resuelve: hasta hoy la cadena del correo terminaba en SENT,
-- que solo significa «Resend nos aceptó el mensaje». Si la dirección no existe,
-- si el buzón está lleno o si la persona marca el aviso como correo no deseado,
-- nadie se entera: para la aplicación ese aviso sigue estando «enviado» y la
-- superusuaria no tiene forma de responder a la única pregunta que importa
-- cuando alguien se queja de que no le llegó nada, que es por qué.
--
--
-- POR QUÉ COLUMNAS NUEVAS Y NO VALORES NUEVOS EN `outbox_status`
--
-- `outbox_status` describe NUESTRO intento de envío: PENDING → SENDING →
-- SENT/FAILED/DEAD. Es el ciclo de vida de la fila en la cola y es lo que
-- consulta el worker, tanto para tomar lote (`status = 'PENDING'`) como para
-- rescatar las filas que quedaron colgadas en SENDING.
--
-- Lo que informa el webhook está en OTRO eje. Cuando llega un rebote, «lo
-- enviamos» sigue siendo verdad —y hay que poder seguir sabiéndolo: es lo que
-- distingue «Resend nunca lo aceptó» de «Resend lo aceptó y el destino lo
-- rechazó»—. Si BOUNCED fuera un valor de `outbox_status`, esa distinción se
-- perdería al sobrescribir SENT, y el worker acabaría filtrando por estados que
-- no son suyos. Además `email.delivery_delayed` no es un estado de cola en
-- absoluto: es una nota informativa que no cambia nada de lo nuestro.
--
-- Dos ejes, dos columnas: `status` sigue siendo nuestro, `delivery_state` es
-- del proveedor. Y como el propio enum del proveedor puede crecer (hoy son
-- cinco eventos, mañana otro), tocarlo no obliga a repasar el worker.

CREATE TYPE delivery_state AS ENUM ('DELIVERED', 'DELAYED', 'BOUNCED', 'COMPLAINED', 'FAILED');

-- ──────────────────────────────────────────────── notification_outbox

ALTER TABLE notification_outbox
    ADD COLUMN delivery_state      delivery_state,
    ADD COLUMN delivery_detail     text,
    ADD COLUMN delivery_updated_at timestamptz(6);

-- Las tres nacen nulas y así se quedan en las filas viejas, que es lo correcto:
-- de un aviso enviado antes de que existiera el webhook no sabemos si llegó, y
-- eso es distinto de saber que no llegó. Nulo significa «no consta», no «bien».

-- La pantalla de «avisos que no llegaron» filtra exactamente por esta columna.
-- El índice no es parcial a propósito: `delivery_state` es nulo en la mayoría
-- de las filas, y PostgreSQL ya no indexa esos nulos en un índice B-tree de una
-- sola columna cuando la consulta pide valores concretos, así que el índice
-- normal ya sale barato y además sirve para contar entregados.
CREATE INDEX notification_outbox_delivery_state_idx
    ON notification_outbox (delivery_state);

-- ──────────────────────────────────────────────────────────────── users
--
-- Dos marcas, no una: rebotar y quejarse son hechos distintos con
-- consecuencias distintas.
--
--   · Un rebote PERMANENTE significa que a esa dirección no se le puede
--     escribir: no llega nada, ni siquiera lo imprescindible.
--   · Una queja significa que sí llega, pero que la persona no quiere recibir
--     esto. Se le dejan de mandar los avisos NO ESENCIALES; seguir insistiendo
--     con el movimiento de la casa quema la reputación del dominio para todos
--     los demás copropietarios.
--
-- Son timestamps y no booleanos porque la pregunta real no es «¿rebota?» sino
-- «¿desde cuándo?»: con la fecha delante, la superusuaria puede comparar el día
-- en que empezó el problema con el aviso que esa persona dice no haber
-- recibido. Un booleano obliga a cruzar la bitácora para averiguar lo mismo.
--
-- Nulo = se le puede escribir con normalidad, que es el caso de todas las filas
-- que ya existen.

ALTER TABLE users
    ADD COLUMN email_bounced_at    timestamptz(6),
    ADD COLUMN email_complained_at timestamptz(6);

-- No se añade índice: son columnas que se leen SIEMPRE por usuario ya
-- localizado (al encolar un aviso ya se tiene el id) y la tabla de una casa
-- compartida tiene una docena de filas. Un índice aquí solo sería trabajo extra
-- en cada alta.
