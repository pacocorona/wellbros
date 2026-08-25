#!/usr/bin/env bash
# Despliegue de Wellbros. Ejecutar como el usuario `wellbros`.
set -euo pipefail

APP=/srv/wellbros/app
BK=/srv/wellbros/backups
cd "$APP"
set -a; . /srv/wellbros/shared/.env; set +a

echo "==> Respaldo previo"
pg_dump -Fc wellbros > "$BK/pre-deploy-$(date +%Y%m%d%H%M).dump"

echo "==> Codigo"
git fetch origin
git reset --hard origin/main

echo "==> Dependencias y compilacion"
npm ci
npx prisma generate
# Si la compilacion falla se aborta AQUI, antes de tocar la base o reiniciar.
npm run build

echo "==> Migraciones"
npx prisma migrate deploy

echo "==> Reinicio"
sudo /usr/bin/systemctl restart wellbros wellbros-worker

echo "==> Verificacion"
for i in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "OK: la aplicacion responde"
    git tag -f "deploy-$(date +%Y%m%d-%H%M)"
    exit 0
  fi
  sleep 2
done
echo "ERROR: la aplicacion no respondio tras el reinicio" >&2
exit 1
