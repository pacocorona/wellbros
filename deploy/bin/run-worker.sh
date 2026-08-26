#!/usr/bin/env bash
#
# Lanzador del worker de notificaciones. Lo ejecuta wellbros-worker.service.
#
# El porqué de este archivo está explicado en run-app.sh: systemd no expande
# variables en la posición del ejecutable de ExecStart, y necesitamos que el
# binario de Node sea configurable para no depender del que usan las otras
# aplicaciones del servidor.

set -euo pipefail

cd /srv/wellbros/app

NODE="${WELLBROS_NODE:-/usr/bin/node}"

if [ ! -x "$NODE" ]; then
    echo "wellbros-worker: no se puede ejecutar '$NODE' (WELLBROS_NODE en el .env)" >&2
    exit 1
fi

# tsx transpila TypeScript al vuelo. El coste es de un segundo al arrancar, y a
# cambio el worker corre exactamente el mismo código que se lee en el repo.
exec "$NODE" node_modules/tsx/dist/cli.mjs src/lib/notifications/worker.ts
