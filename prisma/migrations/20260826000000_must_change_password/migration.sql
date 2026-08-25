-- Cambio de contraseña obligatorio en el primer acceso.
--
-- El problema que resuelve: hay dos formas de entrar por primera vez a Wellbros
-- —la superusuaria que crea la semilla y el alta desde Configuración con
-- contraseña temporal— y en las dos la contraseña la elige OTRA persona y viaja
-- por un canal que no controlamos (un mensaje, una llamada, un papel). Una
-- contraseña que alguien te dictó no debería sobrevivir al primer día: mientras
-- siga viva, la sabe al menos una persona de más y queda escrita donde se envió.
--
-- La marca es una columna y no un cálculo (por ejemplo «created_at = updated_at»
-- o «nunca ha iniciado sesión»): esos heurísticos se equivocan en cuanto alguien
-- edita su teléfono o vuelve a entrar sin cambiar nada, y equivocarse aquí
-- significa o dejar pasar una contraseña dictada o encerrar a alguien en una
-- pantalla que no le toca.
--
-- El valor por omisión es `false` porque es lo correcto para el caso normal
-- —quien cambia su contraseña la elige él— y porque hace que la columna se
-- añada sin reescribir la tabla.

ALTER TABLE users
    ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Las filas que ya existían NO se marcan.
--
-- Podría parecer prudente marcarlas todas por si acaso, pero sería una alarma
-- falsa: de una cuenta ya creada no hay forma de saber si su contraseña la
-- eligió su dueño o se la dictaron, y obligar a cambiarla a quien ya la eligió
-- enseña justo lo contrario de lo que esta pantalla quiere enseñar. Quien deba
-- cambiarla se marca en el momento de recibir una contraseña ajena: la semilla
-- (prisma/seed.ts) y `createUser` (src/server/admin/users.ts).
--
-- En el servidor de producción esto es además indiferente: la base nace con
-- esta migración ya aplicada y sin un solo usuario previo.
