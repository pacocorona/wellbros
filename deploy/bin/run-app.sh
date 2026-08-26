#!/usr/bin/env bash
#
# Lanzador de la aplicación web. Lo ejecuta wellbros.service.
#
# POR QUÉ EXISTE ESTE ARCHIVO, en vez de poner el comando en ExecStart:
# systemd expande ${VARIABLES} en los ARGUMENTOS de ExecStart, pero NO en la
# posición del ejecutable — ahí el valor tiene que ser una ruta literal. Un
# `ExecStart=${WELLBROS_NODE} ...` falla con status=203/EXEC, porque intenta
# ejecutar un programa que se llama, literalmente, "${WELLBROS_NODE}".
#
# Y necesitamos que sea variable: este servidor comparte máquina con otras
# aplicaciones, así que Wellbros usa su propio Node en /opt/node22 sin tocar el
# del sistema, del que dependen los demás.
#
# `exec` no es decorativo: reemplaza este shell por el proceso de node, de modo
# que systemd siga al proceso real y no a un envoltorio. Sin él, la parada y el
# reinicio del servicio dejarían huérfano al hijo.

set -euo pipefail

cd /srv/wellbros/app

NODE="${WELLBROS_NODE:-/usr/bin/node}"
PUERTO="${PORT:-3000}"

if [ ! -x "$NODE" ]; then
    echo "wellbros: no se puede ejecutar '$NODE' (WELLBROS_NODE en el .env)" >&2
    exit 1
fi

# -H 127.0.0.1: solo loopback. Quien expone la aplicación al mundo es nginx,
# que es también quien pone el HTTPS.
exec "$NODE" node_modules/next/dist/bin/next start -p "$PUERTO" -H 127.0.0.1
