#!/usr/bin/env bash
set -euo pipefail
BK=/srv/wellbros/backups
STAMP=$(date +%Y-%m-%d)
DOW=$(date +%u)   # 1=lunes ... 7=domingo
DOM=$(date +%d)

mkdir -p "$BK/daily" "$BK/weekly" "$BK/monthly"
# Formato -Fc (custom): permite restauracion selectiva con pg_restore.
pg_dump -Fc wellbros > "$BK/daily/wellbros-$STAMP.dump"

[ "$DOW" = "7" ]  && cp "$BK/daily/wellbros-$STAMP.dump" "$BK/weekly/"  || true
[ "$DOM" = "01" ] && cp "$BK/daily/wellbros-$STAMP.dump" "$BK/monthly/" || true

find "$BK/daily"   -name '*.dump' -mtime +14  -delete
find "$BK/weekly"  -name '*.dump' -mtime +60  -delete
find "$BK/monthly" -name '*.dump' -mtime +370 -delete

# PENDIENTE: sincronizar a un destino FUERA del servidor. Un respaldo que vive
# en la misma maquina que la base no protege contra la perdida de la maquina.
#   rclone sync "$BK" remoto:wellbros-backups
