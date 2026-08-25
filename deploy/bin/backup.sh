#!/usr/bin/env bash
# Respaldo de la base de Wellbros. Lo lanza cron COMO EL USUARIO wellbros
# (ver /etc/cron.d/wellbros-backup en deploy/README.md §8).
set -euo pipefail

BK=/srv/wellbros/backups
STAMP=$(date +%Y-%m-%d)
DOW=$(date +%u)   # 1=lunes ... 7=domingo
DOM=$(date +%d)

# Conexión. No se lee de DATABASE_URL a propósito: esa cadena lleva parámetros
# de Prisma (?schema=public) que libpq rechaza, y este script debe seguir
# funcionando aunque el .env de la aplicación cambie. La contraseña vive en el
# .pgpass (chmod 600), nunca en la línea de comandos ni en el entorno de cron.
export PGPASSFILE="${PGPASSFILE:-/srv/wellbros/.pgpass}"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-wellbros_user}"
export PGDATABASE="${PGDATABASE:-wellbros}"

if [ ! -r "$PGPASSFILE" ]; then
  echo "ERROR: falta $PGPASSFILE. Sin él pg_dump pide contraseña, y en cron" >&2
  echo "       eso significa que no se hace ni un solo respaldo." >&2
  exit 1
fi

mkdir -p "$BK/daily" "$BK/weekly" "$BK/monthly" "$BK/pre-deploy"

# Formato -Fc (custom): permite restauración selectiva con pg_restore.
# Se escribe a .parcial y se renombra al final: si el volcado se interrumpe,
# no queda un archivo a medias con nombre de respaldo bueno.
DEST="$BK/daily/wellbros-$STAMP.dump"
pg_dump -Fc -f "$DEST.parcial" "$PGDATABASE"
mv "$DEST.parcial" "$DEST"

[ "$DOW" = "7" ]  && cp "$DEST" "$BK/weekly/"  || true
[ "$DOM" = "01" ] && cp "$DEST" "$BK/monthly/" || true

find "$BK/daily"   -name '*.dump' -mtime +14  -delete
find "$BK/weekly"  -name '*.dump' -mtime +60  -delete
find "$BK/monthly" -name '*.dump' -mtime +370 -delete

# Volcados previos a cada despliegue (los escribe deploy.sh). Sin esta línea no
# los purgaba NADIE: se acumulaban uno por despliegue hasta llenar el disco, y
# un disco lleno tumba PostgreSQL, no solo los respaldos. 30 días es de sobra:
# pasado ese plazo, el volcado diario cubre lo mismo.
find "$BK/pre-deploy" -name '*.dump' -mtime +30 -delete

# Restos de volcados interrumpidos.
find "$BK" -name '*.parcial' -mtime +1 -delete

echo "$(date +%FT%T) respaldo OK: $DEST ($(du -h "$DEST" | cut -f1))"

# PENDIENTE: sincronizar a un destino FUERA del servidor. Un respaldo que vive
# en la misma maquina que la base no protege contra la perdida de la maquina.
#   rclone sync "$BK" remoto:wellbros-backups
