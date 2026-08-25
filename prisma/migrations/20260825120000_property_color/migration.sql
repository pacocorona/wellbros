-- Color de identidad por propiedad.
--
-- Sirve para que el usuario reconozca de un vistazo en qué propiedad está y no
-- reserve la semana de la casa equivocada: al cambiar el combo, el cromo del
-- calendario cambia de color. Los ESTADOS de la semana (disponible, tuya, de
-- otro) conservan sus colores semánticos en todas las propiedades.
--
-- Es una lista cerrada, no un hex libre: un color elegido a mano rompería el
-- contraste en tema oscuro. Los ocho están verificados a 4.5:1 o mejor.
-- La lista viva está en src/lib/property-color.ts; el CHECK la replica para que
-- la base no acepte un valor que la interfaz no sabría pintar.

ALTER TABLE properties
    ADD COLUMN color varchar(20) NOT NULL DEFAULT 'indigo';

ALTER TABLE properties
    ADD CONSTRAINT properties_color_check
    CHECK (color IN ('indigo','teal','ambar','rosa','esmeralda','cielo','violeta','naranja'));

-- Reparto inicial: se asigna un color distinto a cada propiedad existente en
-- orden de creación, en vez de dejarlas todas en índigo. Con dos propiedades
-- sembradas, quedan visiblemente distintas desde el primer arranque, que es
-- justo el punto de la funcionalidad.
WITH numeradas AS (
    SELECT id,
           (row_number() OVER (ORDER BY created_at, id) - 1) % 8 AS posicion
      FROM properties
)
UPDATE properties p
   SET color = (ARRAY['indigo','teal','ambar','rosa','esmeralda','cielo','violeta','naranja'])[n.posicion + 1]
  FROM numeradas n
 WHERE p.id = n.id;
