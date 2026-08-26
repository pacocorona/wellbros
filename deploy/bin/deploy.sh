#!/usr/bin/env bash
# Despliegue de Wellbros.
#
# Se ejecuta COMO EL USUARIO wellbros. Desde root:
#     sudo -u wellbros /srv/wellbros/bin/deploy.sh
#
# NO sirve para la primera instalación: da por hecho que ya existen el clon,
# el .env y la base con sus migraciones. Para instalar de cero, deploy/README.md.
#
# Orden deliberado: respaldo → código → compilación → migraciones → reinicio →
# comprobación. La compilación va ANTES de tocar la base y antes de reiniciar,
# así que un error de compilación deja el sitio en pie con la versión anterior.
set -euo pipefail

APP=/srv/wellbros/app
ENV_FILE=/srv/wellbros/shared/.env
# Los volcados previos van a su PROPIA carpeta, no a la raíz de backups/:
# backup.sh purga daily/, weekly/, monthly/ y pre-deploy/, y lo que quedaba
# suelto en la raíz no lo borraba nadie. Con un despliegue por semana eso son
# decenas de volcados acumulándose hasta llenar el disco.
BK=/srv/wellbros/backups/pre-deploy
INTENTOS_SALUD=15
# SALUD no se define aquí: el puerto sale de PORT, que vive en el .env y todavía
# no está cargado. Se arma más abajo, después de leerlo.

# ───────────────────────────────────────────── comprobaciones previas

if [ ! -d "$APP/.git" ]; then
  echo "ERROR: no hay ningún clon del repositorio en $APP." >&2
  echo "       Esto es una primera instalación: sigue deploy/README.md §4" >&2
  echo "       (clonar COMO EL USUARIO wellbros) antes de usar este script." >&2
  exit 1
fi

if [ ! -r "$ENV_FILE" ]; then
  echo "ERROR: falta $ENV_FILE, o el usuario wellbros no puede leerlo." >&2
  echo "       Contenido listo para pegar en deploy/README.md §5.2." >&2
  echo "       Debe quedar: chown wellbros:wellbros y chmod 600." >&2
  exit 1
fi

cd "$APP"

# El .env lo leen DOS lectores con reglas distintas: systemd (EnvironmentFile=)
# y este script (con `.`). Un valor con espacios o con «<» y «>» —RESEND_FROM
# los lleva— tiene que ir ENTRE COMILLAS: systemd se las quita al leerlo, y sin
# ellas el shell trata «<» como una redirección y el archivo ni siquiera se
# puede cargar. Se comprueba antes para poder explicarlo, en vez de morir con
# un "syntax error near unexpected token" a secas.
if ! bash -n "$ENV_FILE" 2>/dev/null; then
  echo "ERROR: $ENV_FILE no se puede cargar como archivo de variables." >&2
  echo "       Causa típica: un valor con espacios o con < > sin comillas." >&2
  echo '       Debe quedar así:  RESEND_FROM="Wellbros <notificaciones@...>"' >&2
  exit 1
fi

# `set -a` exporta todo lo que se defina a continuación: las variables tienen
# que llegar a npm, a prisma y a next, no solo a este shell.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: $ENV_FILE no define DATABASE_URL." >&2
  echo '       Sin ella "prisma generate" (que corre en el postinstall de' >&2
  echo '       npm ci) aborta y no se llega ni a compilar.' >&2
  exit 1
fi

# El puerto sale del MISMO sitio que lo usa la unidad de systemd para arrancar
# la aplicación. Tenerlo escrito aquí a mano fue un fallo real: en un servidor
# donde el 3000 ya estaba ocupado por otra aplicación, la comprobación
# preguntaba en el puerto equivocado y daba por caído un despliegue correcto.
PUERTO_APP="${PORT:-3000}"
SALUD="http://127.0.0.1:${PUERTO_APP}/api/health"

# Conexión de pg_dump. No se deriva de DATABASE_URL a propósito: esa cadena
# lleva parámetros de Prisma (?schema=public) que libpq rechaza. La contraseña
# vive en el .pgpass (chmod 600), nunca en la línea de comandos.
export PGPASSFILE="${PGPASSFILE:-/srv/wellbros/.pgpass}"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-wellbros_user}"
export PGDATABASE="${PGDATABASE:-wellbros}"

if [ ! -r "$PGPASSFILE" ]; then
  echo "ERROR: falta $PGPASSFILE (o no se puede leer)." >&2
  echo "       Sin él pg_dump pide contraseña por teclado: en un despliegue" >&2
  echo "       desatendido eso es un cuelgue o un fallo sin explicación." >&2
  echo "       Se crea en deploy/README.md §5.3." >&2
  exit 1
fi

echo "==> Respaldo previo"
mkdir -p "$BK"
DUMP="$BK/pre-deploy-$(date +%Y%m%d-%H%M%S).dump"
# Se escribe a un nombre .parcial y se renombra al terminar: si pg_dump muere a
# la mitad, no queda un archivo con pinta de respaldo válido.
pg_dump -Fc -f "$DUMP.parcial" "$PGDATABASE"
mv "$DUMP.parcial" "$DUMP"
echo "    $DUMP"

echo "==> Codigo"
# La etiqueta se lee ANTES de mover nada: es la del último despliegue que sí
# arrancó (solo se etiqueta al final, tras la comprobación de salud), y es la
# que hay que indicar si esto sale mal.
ANTERIOR="$(git tag --list 'deploy-*' --sort=-creatordate | head -n 1 || true)"
git fetch origin --prune
git reset --hard origin/main

echo "==> Dependencias y compilacion"
# --include=dev NO es decorativo: `next build` necesita typescript, tailwind y
# los @types, que viven en devDependencies. Si NODE_ENV=production llegara a
# colarse en el entorno, npm ci las omitiría y la compilación moriría con un
# "Cannot find module 'typescript'" que no dice nada de la causa real.
npm ci --include=dev
# Redundante con el postinstall de npm ci, y barato: cubre el caso de que
# alguien haya instalado con --ignore-scripts.
npx prisma generate
npm run build

echo "==> Migraciones"
npx prisma migrate deploy

echo "==> Reinicio"
# `-n` (non-interactive): si falta la entrada de sudoers, sudo falla al
# instante en vez de quedarse esperando una contraseña que nadie va a teclear
# —el usuario wellbros ni siquiera tiene una.
if ! sudo -n /usr/bin/systemctl restart wellbros wellbros-worker; then
  cat >&2 <<'AYUDA'
ERROR: no se pudieron reiniciar los servicios.

La causa casi siempre es que falta la entrada de sudoers. Como root:

  printf '%s\n' \
    'wellbros ALL=(root) NOPASSWD: /usr/bin/systemctl restart wellbros wellbros-worker' \
    'wellbros ALL=(root) NOPASSWD: /usr/bin/systemctl restart wellbros' \
    'wellbros ALL=(root) NOPASSWD: /usr/bin/systemctl restart wellbros-worker' \
    > /etc/sudoers.d/wellbros
  chmod 440 /etc/sudoers.d/wellbros
  visudo -cf /etc/sudoers.d/wellbros

OJO: el código y las migraciones YA se aplicaron; lo único que falta es el
reinicio, así que los servicios siguen corriendo la compilación anterior.
Arregla el sudoers y vuelve a lanzar este script (es seguro repetirlo).
AYUDA
  exit 1
fi

echo "==> Verificacion"
for _ in $(seq 1 "$INTENTOS_SALUD"); do
  if curl -fsS "$SALUD" >/dev/null 2>&1; then
    echo "OK: la aplicacion responde en $SALUD"
    git tag -f "deploy-$(date +%Y%m%d-%H%M%S)" >/dev/null
    exit 0
  fi
  sleep 2
done

# ─────────────────────────────────────────────────── fracaso: qué hacer
{
  echo
  echo "ERROR: la aplicacion no respondio en $SALUD tras $((INTENTOS_SALUD * 2)) segundos."
  echo
  echo "1) Mira primero POR QUÉ. Casi siempre lo dice la primera línea:"
  echo "     journalctl -u wellbros -n 80 --no-pager"
  echo "     journalctl -u wellbros-worker -n 40 --no-pager"
  echo
  echo "2) REVERSIÓN — copia y pega, en este orden:"
  if [ -n "$ANTERIOR" ]; then
    echo "   (etiqueta del último despliegue que sí arrancó: $ANTERIOR)"
    echo
    echo "     sudo -u wellbros -H git -C $APP reset --hard $ANTERIOR"
    echo "     sudo -u wellbros -H bash -c 'set -a; . $ENV_FILE; set +a; cd $APP && npm ci --include=dev && npm run build'"
    echo "     systemctl restart wellbros wellbros-worker"
    echo
  else
    echo
    echo "     No hay ninguna etiqueta deploy-* previa: este parece el primer"
    echo "     despliegue, así que no hay versión anterior a la que volver."
    echo "     Arregla el fallo y repite el despliegue."
    echo
  fi
  echo "3) Si el fallo vino de una MIGRACIÓN (y solo entonces), restaura el"
  echo "   volcado previo. Esto BORRA los datos escritos desde el respaldo:"
  echo
  echo "     sudo -u wellbros -H pg_restore --clean --if-exists \\"
  echo "       -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE \\"
  echo "       $DUMP"
  echo
} >&2

exit 1
