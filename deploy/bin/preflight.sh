#!/usr/bin/env bash
#
# Wellbros — verificación previa al despliegue.
#
# SOLO LEE. No instala, no modifica, no arranca ni detiene nada. Se puede
# ejecutar tantas veces como haga falta y en un servidor en producción con otras
# cosas corriendo.
#
# Para qué sirve: el runbook manda instalar paquetes, pero en un servidor que ya
# está en uso muchos existirán. Instalar a ciegas no es inofensivo —en Debian,
# `apt install postgresql` sobre una instalación previa añade OTRA versión en
# paralelo, con su propio clúster en otro puerto— así que primero se mira.
#
#   bash deploy/bin/preflight.sh
#
# Cada comprobación termina en uno de estos veredictos:
#
#   [ OK ]      está y sirve: no hay que hacer nada
#   [ FALTA ]   no está: hay que instalarlo
#   [ REVISAR ] está pero no encaja, o hay algo que decidir antes de seguir
#   [ AVISO ]   no bloquea, pero conviene saberlo

set -uo pipefail   # sin -e: una comprobación que falla no debe abortar el resto

DOMINIO="wellbrosproperties.lat"
PUERTO_APP=3000
ROL_BD="wellbros_user"
NOMBRE_BD="wellbros"
USUARIO_SISTEMA="wellbros"
RAIZ="/srv/wellbros"

# ── presentación ──────────────────────────────────────────────────────

if [ -t 1 ]; then
    VERDE=$'\033[32m'; ROJO=$'\033[31m'; AMBAR=$'\033[33m'; AZUL=$'\033[36m'; FIN=$'\033[0m'
else
    VERDE=""; ROJO=""; AMBAR=""; AZUL=""; FIN=""
fi

ACCIONES=()
BLOQUEOS=()

titulo()  { printf '\n%s─── %s %s\n' "$AZUL" "$1" "$FIN"; }
ok()      { printf '  %s[ OK ]%s      %s\n' "$VERDE" "$FIN" "$1"; }
falta()   { printf '  %s[ FALTA ]%s   %s\n' "$ROJO" "$FIN" "$1"; ACCIONES+=("$2"); }
revisar() { printf '  %s[ REVISAR ]%s %s\n' "$ROJO" "$FIN" "$1"; BLOQUEOS+=("$2"); }
aviso()   { printf '  %s[ AVISO ]%s   %s\n' "$AMBAR" "$FIN" "$1"; }
nota()    { printf '                %s\n' "$1"; }

hay() { command -v "$1" >/dev/null 2>&1; }

printf '%s\n' "════════════════════════════════════════════════════════════════"
printf '  Wellbros — verificación previa (solo lectura)\n'
printf '  %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
printf '%s\n' "════════════════════════════════════════════════════════════════"

# ── 1. sistema ────────────────────────────────────────────────────────

titulo "1. Sistema"

if [ -r /etc/os-release ]; then
    . /etc/os-release
    printf '  Distribución: %s\n' "${PRETTY_NAME:-desconocida}"
    case "${VERSION_ID:-}" in
        13*) ok "Debian 13, que es para lo que está escrito el runbook" ;;
        *)   aviso "El runbook se escribió para Debian 13; aquí hay ${VERSION_ID:-?}"
             nota "Los nombres de paquete y las versiones pueden diferir." ;;
    esac
fi

printf '  Arquitectura: %s · Núcleo: %s\n' "$(uname -m)" "$(uname -r)"

LIBRE_KB=$(df -Pk / | awk 'NR==2 {print $4}')
LIBRE_GB=$(( LIBRE_KB / 1024 / 1024 ))
if [ "$LIBRE_GB" -ge 5 ]; then
    ok "Espacio libre en /: ${LIBRE_GB} GB"
else
    revisar "Solo quedan ${LIBRE_GB} GB libres en /" \
            "Liberar espacio: node_modules y .next ocupan ~1 GB, más los respaldos."
fi

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -ge 1800 ]; then
    ok "Memoria: ${MEM_MB} MB"
else
    aviso "Memoria: ${MEM_MB} MB — 'npm run build' puede quedarse sin memoria"
    nota "Si el build muere sin mensaje, casi siempre es esto. Añadir swap lo resuelve."
fi

# ── 2. node ───────────────────────────────────────────────────────────

titulo "2. Node.js"

if hay node; then
    NODE_V=$(node -v | tr -d 'v')
    NODE_MAYOR=${NODE_V%%.*}
    RUTA_NODE=$(command -v node)
    printf '  Instalado: v%s en %s\n' "$NODE_V" "$RUTA_NODE"

    if [ "$NODE_MAYOR" -ge 22 ]; then
        ok "Versión suficiente (se desarrolló con la 22)"
    elif [ "$NODE_MAYOR" -ge 20 ]; then
        revisar "Node $NODE_MAYOR arranca la aplicación, pero llegó a fin de vida en abril de 2026" \
                "Actualizar a Node 22 con NodeSource (§2 del runbook)."
    else
        revisar "Node $NODE_MAYOR es demasiado antiguo (Next 16 exige 20.9 o superior)" \
                "Instalar Node 22 con NodeSource (§2 del runbook)."
    fi

    # Las unidades de systemd apuntan a la ruta absoluta /usr/bin/node.
    if [ "$RUTA_NODE" != "/usr/bin/node" ]; then
        revisar "node NO está en /usr/bin/node, sino en $RUTA_NODE" \
                "Los servicios systemd apuntan a /usr/bin/node y no arrancarían. Si es nvm, instalar Node por NodeSource; si no, ajustar ExecStart en las dos unidades."
        case "$RUTA_NODE" in
            *"/.nvm/"*) nota "Es nvm: systemd no puede verlo (User=wellbros + ProtectHome)." ;;
        esac
    else
        ok "Está en /usr/bin/node, que es donde lo buscan los servicios"
    fi
else
    falta "Node no está instalado" "Instalar Node 22 con NodeSource (§2 del runbook)."
fi

if hay npm; then ok "npm $(npm -v)"; else falta "npm no está instalado" "Viene con Node."; fi

# ── 3. postgresql ─────────────────────────────────────────────────────

titulo "3. PostgreSQL"

if hay psql || hay pg_lsclusters; then
    hay psql && printf '  Cliente: %s\n' "$(psql --version)"

    if hay pg_lsclusters; then
        printf '  Clústeres presentes:\n'
        pg_lsclusters 2>/dev/null | sed 's/^/    /'

        N_CLUSTERS=$(pg_lsclusters 2>/dev/null | tail -n +2 | grep -c . || echo 0)
        if [ "$N_CLUSTERS" -gt 1 ]; then
            revisar "Hay $N_CLUSTERS clústeres de PostgreSQL" \
                    "Decidir en CUÁL va Wellbros y usar SU puerto en DATABASE_URL. NO ejecutes 'apt install postgresql': añadiría otro más."
            nota "La columna 'Port' de arriba es la que debe ir en DATABASE_URL."
        fi

        EN_LINEA=$(pg_lsclusters 2>/dev/null | tail -n +2 | awk '$4=="online"' | head -1)
        if [ -n "$EN_LINEA" ]; then
            VER_PG=$(echo "$EN_LINEA" | awk '{print $1}')
            PUERTO_PG=$(echo "$EN_LINEA" | awk '{print $3}')
            ok "Clúster activo: PostgreSQL $VER_PG en el puerto $PUERTO_PG"

            if [ "${VER_PG%%.*}" -ge 13 ]; then
                ok "Versión suficiente (el esquema exige 13 o superior)"
            else
                revisar "PostgreSQL $VER_PG es anterior a la 13" \
                        "El esquema usa gen_random_uuid() nativo y columnas generadas STORED. Hace falta 13 o superior."
            fi

            if [ "$PUERTO_PG" != "5432" ]; then
                aviso "El puerto NO es el 5432 sino el $PUERTO_PG"
                nota "DATABASE_URL debe llevar :$PUERTO_PG, no :5432."
            fi
        else
            revisar "PostgreSQL está instalado pero ningún clúster está en línea" \
                    "Arrancarlo: systemctl start postgresql"
        fi
    fi

    # citext, el rol y la base: solo se pueden mirar con acceso al servidor.
    if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
        CITEXT=$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_available_extensions WHERE name='citext'\"" 2>/dev/null)
        if [ "$CITEXT" = "1" ]; then
            ok "La extensión citext está disponible"
        else
            revisar "citext NO aparece entre las extensiones disponibles" \
                    "La migración hace CREATE EXTENSION citext y fallaría. En Debian viene dentro del paquete postgresql-NN."
        fi

        ROL=$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$ROL_BD'\"" 2>/dev/null)
        if [ "$ROL" = "1" ]; then
            aviso "El rol '$ROL_BD' YA EXISTE"
            nota "No lo vuelvas a crear. Si no recuerdas su contraseña:"
            nota "  ALTER ROLE $ROL_BD WITH PASSWORD 'nueva';"
        else
            printf '  El rol %s no existe todavía: se creará en §3.\n' "$ROL_BD"
        fi

        BD=$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$NOMBRE_BD'\"" 2>/dev/null)
        if [ "$BD" = "1" ]; then
            DUENIO=$(su - postgres -c "psql -tAc \"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='$NOMBRE_BD'\"" 2>/dev/null)
            aviso "La base '$NOMBRE_BD' YA EXISTE (dueño: ${DUENIO:-?})"
            if [ "$DUENIO" != "$ROL_BD" ]; then
                revisar "La base '$NOMBRE_BD' no pertenece a '$ROL_BD' sino a '${DUENIO:-?}'" \
                        "CREATE EXTENSION citext fallará. Corregir con: ALTER DATABASE $NOMBRE_BD OWNER TO $ROL_BD;"
            fi
            TABLAS=$(su - postgres -c "psql -d $NOMBRE_BD -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'\"" 2>/dev/null)
            nota "Tiene ${TABLAS:-?} tablas. Si no es una instalación previa de Wellbros, elige otro nombre."
        else
            printf '  La base %s no existe todavía: se creará en §3.\n' "$NOMBRE_BD"
        fi

        # Otras bases en el mismo servidor: no las vamos a tocar, pero conviene saberlo.
        OTRAS=$(su - postgres -c "psql -tAc \"SELECT count(*) FROM pg_database WHERE datistemplate=false AND datname NOT IN ('postgres','$NOMBRE_BD')\"" 2>/dev/null)
        if [ "${OTRAS:-0}" -gt 0 ]; then
            aviso "Hay $OTRAS base(s) más en este servidor"
            nota "Wellbros no las toca, pero tenlo presente al hacer respaldos o al reiniciar el servicio."
        fi
    else
        aviso "Sin privilegios de root: no se pudo comprobar citext, el rol ni la base"
    fi
else
    falta "PostgreSQL no está instalado" "apt install postgresql (§2 del runbook)."
fi

# ── 4. nginx ──────────────────────────────────────────────────────────

titulo "4. Nginx"

if hay nginx; then
    printf '  %s\n' "$(nginx -v 2>&1)"

    if nginx -t >/dev/null 2>&1; then
        ok "La configuración actual es válida"
    else
        revisar "La configuración actual de nginx YA tiene errores" \
                "Arreglarlos ANTES de añadir Wellbros: 'nginx -t' debe pasar limpio o el reload fallará y tirarás los sitios que ya funcionan."
    fi

    if [ -d /etc/nginx/sites-enabled ]; then
        SITIOS=$(find /etc/nginx/sites-enabled -type l -o -type f 2>/dev/null | wc -l)
        if [ "$SITIOS" -gt 0 ]; then
            aviso "Ya hay $SITIOS sitio(s) habilitado(s) — este servidor sirve otras cosas"
            find /etc/nginx/sites-enabled \( -type l -o -type f \) -printf '                  %f\n' 2>/dev/null
            nota "Wellbros añade un archivo propio y no toca los demás."
        else
            ok "No hay otros sitios habilitados"
        fi

        if grep -rl "$DOMINIO" /etc/nginx/sites-enabled/ >/dev/null 2>&1; then
            revisar "Ya hay una configuración de nginx que menciona $DOMINIO" \
                    "Revisarla antes de copiar la de Wellbros: dos server_name iguales hacen que nginx ignore uno de los dos."
        fi

        if grep -rl "default_server" /etc/nginx/sites-enabled/ >/dev/null 2>&1; then
            aviso "Algún sitio usa 'default_server'"
            nota "Es correcto y no estorba: Wellbros responde por server_name."
        fi
    fi

    if grep -rq "wellbros_login" /etc/nginx/ 2>/dev/null; then
        aviso "Ya existe una zona 'wellbros_login' — parece un despliegue previo"
        nota "Definirla dos veces hace fallar 'nginx -t'."
    fi
else
    falta "Nginx no está instalado" "apt install nginx (§2 del runbook)."
fi

# ── 5. puertos ────────────────────────────────────────────────────────

titulo "5. Puertos"

quien_escucha() {
    if hay ss; then ss -lntp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $NF; exit}'
    elif hay netstat; then netstat -lntp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $NF; exit}'
    fi
}

for P in 80 443; do
    Q=$(quien_escucha "$P")
    if [ -n "$Q" ]; then ok "Puerto $P ocupado por $Q (se espera que sea nginx)"
    else aviso "Nadie escucha en el puerto $P todavía"; fi
done

Q3000=$(quien_escucha "$PUERTO_APP")
if [ -n "$Q3000" ]; then
    revisar "El puerto $PUERTO_APP YA ESTÁ OCUPADO por $Q3000" \
            "Es el puerto de la aplicación. O liberas ese puerto, o cambias el -p en deploy/systemd/wellbros.service y el proxy_pass de nginx."
else
    ok "Puerto $PUERTO_APP libre para la aplicación"
fi

# ── 6. cortafuegos ────────────────────────────────────────────────────

titulo "6. Cortafuegos"

PUERTO_SSH=$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/ {print $2}' /etc/ssh/sshd_config 2>/dev/null | tail -1)
PUERTO_SSH=${PUERTO_SSH:-22}
printf '  SSH escucha en el puerto %s\n' "$PUERTO_SSH"

if hay ufw; then
    ESTADO=$(ufw status 2>/dev/null | head -1)
    printf '  ufw: %s\n' "$ESTADO"
    if echo "$ESTADO" | grep -qi "inactive"; then
        if [ "$PUERTO_SSH" != "22" ]; then
            revisar "ufw está inactivo y tu SSH NO usa el puerto 22, sino el $PUERTO_SSH" \
                    "El runbook abre el 22. Si activas ufw sin abrir el $PUERTO_SSH te quedas FUERA del servidor. Ejecuta antes: ufw allow $PUERTO_SSH/tcp"
        else
            aviso "ufw está inactivo; el runbook lo activa en §10"
            nota "Comprueba que 'ufw allow 22/tcp' esté puesto ANTES del 'ufw enable'."
        fi
    else
        ok "ufw ya está activo — no hace falta activarlo de nuevo"
        ufw status 2>/dev/null | tail -n +2 | sed 's/^/                  /'
        nota "Verifica que 80 y 443 estén permitidos; si no, añádelos sin tocar el resto."
    fi
else
    aviso "ufw no está instalado"
    if hay nft && nft list ruleset 2>/dev/null | grep -q 'chain input'; then
        revisar "No hay ufw pero SÍ hay reglas nftables activas" \
                "Este servidor ya tiene cortafuegos. NO instales ufw encima: añade las reglas para 80 y 443 con la herramienta que ya se usa."
    fi
fi

# ── 7. certbot y certificados ─────────────────────────────────────────

titulo "7. Certbot"

if hay certbot; then
    printf '  %s\n' "$(certbot --version 2>&1)"
    if certbot certificates 2>/dev/null | grep -q "$DOMINIO"; then
        aviso "YA existe un certificado para $DOMINIO"
        certbot certificates 2>/dev/null | grep -A2 "$DOMINIO" | sed 's/^/                  /'
        nota "No hace falta volver a emitirlo. Ojo con el límite de Let's Encrypt: 5 por semana y dominio."
    else
        printf '  No hay certificado para %s todavía.\n' "$DOMINIO"
    fi
    if [ -d /etc/nginx ] && ! dpkg -l python3-certbot-nginx 2>/dev/null | grep -q '^ii'; then
        falta "Falta el complemento python3-certbot-nginx" "apt install python3-certbot-nginx"
    fi
else
    falta "Certbot no está instalado" "apt install certbot python3-certbot-nginx (§2 del runbook)."
fi

# ── 8. herramientas y usuario ─────────────────────────────────────────

titulo "8. Herramientas"

for H in git curl openssl; do
    if hay "$H"; then ok "$H presente"; else falta "$H no está" "apt install $H"; fi
done

titulo "9. Usuario y directorios de Wellbros"

if id "$USUARIO_SISTEMA" >/dev/null 2>&1; then
    aviso "El usuario de sistema '$USUARIO_SISTEMA' YA EXISTE"
    nota "$(getent passwd "$USUARIO_SISTEMA")"
    nota "No lo vuelvas a crear; el 'adduser' de §3 fallaría."
else
    printf '  El usuario %s no existe: se creará en §3.\n' "$USUARIO_SISTEMA"
fi

if [ -d "$RAIZ" ]; then
    aviso "$RAIZ YA EXISTE — parece haber un despliegue previo"
    ls -la "$RAIZ" 2>/dev/null | sed 's/^/                  /' | head -8
    if [ -d "$RAIZ/app/.git" ]; then
        nota "Hay un clon de git. Para actualizar usa deploy.sh, no vuelvas a clonar."
    fi
else
    printf '  %s no existe: se creará en §4.\n' "$RAIZ"
fi

for U in wellbros wellbros-worker; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^$U.service"; then
        aviso "El servicio $U.service YA está instalado ($(systemctl is-active "$U" 2>/dev/null))"
    fi
done

# ── 10. DNS ───────────────────────────────────────────────────────────

titulo "10. DNS"

if hay dig; then
    IP_PUBLICA=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
    IP_DOMINIO=$(dig +short A "$DOMINIO" @8.8.8.8 2>/dev/null | tail -1)
    printf '  %s resuelve a: %s\n' "$DOMINIO" "${IP_DOMINIO:-nada}"
    [ -n "$IP_PUBLICA" ] && printf '  IP pública de este servidor: %s\n' "$IP_PUBLICA"

    if [ -n "$IP_DOMINIO" ] && [ -n "$IP_PUBLICA" ]; then
        if [ "$IP_DOMINIO" = "$IP_PUBLICA" ]; then
            ok "El dominio apunta a ESTE servidor"
        else
            revisar "El dominio apunta a $IP_DOMINIO, pero este servidor es $IP_PUBLICA" \
                    "Certbot fallará: no puede validar un dominio que apunta a otra máquina."
        fi
    fi

    if [ -n "$(dig +short TXT "resend._domainkey.$DOMINIO" @8.8.8.8 2>/dev/null)" ]; then
        ok "El DKIM de Resend está publicado"
    else
        revisar "No se ve el DKIM de Resend" "Sin él, Resend no puede enviar desde el dominio."
    fi
else
    aviso "dig no está instalado; no se pudo comprobar el DNS"
    nota "apt install dnsutils"
fi

# ── resumen ───────────────────────────────────────────────────────────

printf '\n%s\n' "════════════════════════════════════════════════════════════════"
printf '  RESUMEN\n'
printf '%s\n' "════════════════════════════════════════════════════════════════"

if [ ${#BLOQUEOS[@]} -eq 0 ] && [ ${#ACCIONES[@]} -eq 0 ]; then
    printf '\n  %sTodo listo.%s Puedes ir directo a la §4 (primera instalación).\n\n' "$VERDE" "$FIN"
    exit 0
fi

if [ ${#BLOQUEOS[@]} -gt 0 ]; then
    printf '\n  %sResolver ANTES de seguir (%d):%s\n\n' "$ROJO" "${#BLOQUEOS[@]}" "$FIN"
    for b in "${BLOQUEOS[@]}"; do printf '    · %s\n' "$b"; done
fi

if [ ${#ACCIONES[@]} -gt 0 ]; then
    printf '\n  %sInstalar lo que falta (%d):%s\n\n' "$AMBAR" "${#ACCIONES[@]}" "$FIN"
    for a in "${ACCIONES[@]}"; do printf '    · %s\n' "$a"; done
    printf '\n  Instala SOLO lo listado. No ejecutes el apt install completo del\n'
    printf '  runbook: en Debian, "apt install postgresql" sobre una instalación\n'
    printf '  previa añade OTRA versión en paralelo, con su propio clúster.\n'
fi

printf '\n  Ninguna comprobación modificó nada. Puedes volver a ejecutarlo.\n\n'
exit 1
