# Wellbros — runbook de despliegue

Servidor: **Debian 13 (trixie)** · IP **72.62.164.198** · Dominio **wellbrosproperties.lat**
Base de datos: **PostgreSQL 17 nativo** en el mismo host · Correo: **Resend**

Este documento se lee **de arriba abajo**, una sola vez, en un servidor recién
entregado. Cada comando está listo para copiar y pegar.

**Convenciones**

- Todo se ejecuta **como `root`** por SSH, salvo donde diga expresamente
  `sudo -u wellbros` o `sudo -iu wellbros`.
- Los bloques largos se pegan enteros. Si un paso falla, **para ahí**: casi
  todos los pasos siguientes dan por bueno el anterior.
- Al final de cada sección hay una comprobación. Si no da lo que dice, no sigas.

**Ten a mano antes de empezar**

1. La clave de API de Resend (se crea en su panel; **su valor no se puede
   volver a consultar** después de crearla).
2. Un rato tranquilo: son unos 40 minutos, y el paso de `certbot` toca DNS
   público.

---

## 1. DNS — ya está hecho, no hay que tocar nada

Verificado el 24 de agosto de 2026: la zona propagó y se ve igual desde Google,
Cloudflare, Quad9 y OpenDNS. El dominio se dio de alta en Resend **en su raíz**
(`wellbrosproperties.lat`), no en un subdominio.

### Sitio

| Tipo | Nombre | Valor           |
| ---- | ------ | --------------- |
| `A`  | `@`    | `72.62.164.198` |
| `A`  | `www`  | `72.62.164.198` |

### Correo

| Propósito                    | Tipo  | Nombre               | Valor                                  |
| ---------------------------- | ----- | -------------------- | -------------------------------------- |
| Retorno de rebotes           | `MX`  | `send`               | `feedback.forge.rmta.net` (prioridad 10) |
| SPF del subdominio de envío  | `TXT` | `send`               | `v=spf1 include:_spf.forge.rmta.net ~all` |
| Firma DKIM                   | `TXT` | `resend._domainkey`  | `p=…` (RSA 1024 bits)                  |
| Política DMARC               | `TXT` | `_dmarc`             | `v=DMARC1; p=none;`                    |

Resend ya **no** usa la infraestructura de Amazon SES para dominios nuevos
(`feedback-smtp.*.amazonses.com` / `include:amazonses.com`): usa la suya en
`forge.rmta.net`. Si alguna guía menciona `amazonses.com`, está desactualizada.

Comprobación (desde cualquier máquina, en cualquier momento):

```bash
dig +short A wellbrosproperties.lat
dig +short TXT resend._domainkey.wellbrosproperties.lat
dig +short TXT _dmarc.wellbrosproperties.lat
dig +short MX send.wellbrosproperties.lat
```

> El DMARC actual no pide informes (`rua`). Es correcto dejarlo así por ahora;
> el porqué está en **§13, Pendiente**.

---

## 2. Verificación previa — **empieza SIEMPRE por aquí**

Este servidor está en producción y ya tiene cosas instaladas. Instalar a ciegas
lo que el runbook pide no es inofensivo:

- En Debian, `apt install postgresql` sobre una instalación existente **no la
  reemplaza**: añade otra versión en paralelo, con su propio clúster en otro
  puerto. Acabarías con dos y sin saber cuál usa la aplicación.
- Si nginx ya sirve otros sitios, un `server_name` repetido o una configuración
  que ya venía rota hacen fallar el `reload` y **tiran los sitios que
  funcionaban**.
- Y el peor de todos: **`ufw enable` puede dejarte fuera del servidor** si tu
  SSH no escucha en el puerto 22.

Antes de instalar nada, ejecuta la verificación. **Solo lee**: no instala, no
modifica, no arranca ni detiene nada, y puedes repetirla las veces que quieras.

```bash
cd /tmp && rm -rf wellbros-check
git clone --depth 1 https://github.com/pacocorona/wellbros.git wellbros-check
bash wellbros-check/deploy/bin/preflight.sh
```

Comprueba el sistema, Node, PostgreSQL (versión, clústeres, puertos, `citext`,
si el rol y la base ya existen), nginx y sus sitios, los puertos 80/443/3000,
el cortafuegos, certbot y sus certificados, el usuario y los directorios de
Wellbros, y el DNS. Cada línea termina en uno de cuatro veredictos:

| Veredicto | Significa |
|---|---|
| `[ OK ]` | Está y sirve. **No hagas nada.** |
| `[ FALTA ]` | No está. Hay que instalarlo. |
| `[ REVISAR ]` | Está pero no encaja, o hay algo que decidir. **Resuélvelo antes de seguir.** |
| `[ AVISO ]` | No bloquea, pero conviene saberlo. |

Al final imprime dos listas: lo que hay que resolver antes de continuar y lo
que falta por instalar. **Instala solo lo que aparezca en esa segunda lista.**

Si todo sale en verde, salta directo a la §5 (primera instalación).

### Qué hacer con los casos más probables

**PostgreSQL ya existe.** Es lo normal en un servidor en uso. No lo instales de
nuevo. Fíjate en dos cosas del informe:

- **El puerto del clúster activo.** Si no es el 5432, tu `DATABASE_URL` debe
  llevar ese puerto.
- **La versión.** El esquema necesita la 13 o superior (usa `gen_random_uuid()`
  nativo y columnas generadas `STORED`). De la 13 en adelante, todo bien.

Y comprueba que `citext` aparezca como disponible: la migración la crea y sin
ella se detiene a mitad. En Debian viene dentro del propio paquete del servidor,
así que si PostgreSQL está, casi seguro que está.

**Nginx ya sirve otros sitios.** Wellbros añade su propio archivo y no toca los
demás. Antes de recargar, `nginx -t` tiene que pasar limpio — si ya venía con
errores, arréglalos primero o el `reload` tirará todo.

**ufw ya está activo.** No lo actives de nuevo ni reinicies sus reglas: añade
solo lo que falte.

```bash
ufw allow 80/tcp && ufw allow 443/tcp
```

**El usuario o los directorios ya existen.** Habrá un despliegue previo. No
vuelvas a clonar: actualiza con `deploy.sh` (§12).

---

## 3. Paquetes del sistema

> Salta lo que la verificación haya marcado como `[ OK ]`. Este bloque instala
> todo de golpe y solo sirve para un servidor recién hecho.

```bash
apt update && apt -y full-upgrade
apt install -y curl ca-certificates gnupg git dnsutils ufw fail2ban \
               unattended-upgrades nginx certbot python3-certbot-nginx postgresql
```

`git` no viene en una instalación mínima de Debian y hace falta para clonar el
repositorio; instálalo aunque parezca obvio. `dnsutils` trae `dig`, que es lo
que usan las comprobaciones de §1.

### Node.js 22

Debian 13 trae Node **20**, que llegó a **fin de vida en abril de 2026**: ya no
recibe parches de seguridad. Se instala el 22 desde NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
apt install -y nodejs
node -v          # debe imprimir v22.x
command -v node  # debe imprimir /usr/bin/node
```

> **Si el script falla con un error de firma** (`NO_PUBKEY`, `sha1`,
> `signature ... is not supported`, o un `apt update` que se queja de la clave
> de NodeSource): la causa es que **Debian 13 rechaza SHA-1 desde febrero de
> 2026** y NodeSource rotó sus claves por ese motivo. **La cura es volver a
> ejecutar el mismo script**: la segunda pasada instala el llavero nuevo.
> No busques recetas de `apt-key`: `apt-key` está retirado y solo enredará más.

> **NO USES `nvm`.** Las unidades de systemd arrancan con `/usr/bin/node`
> (ver `deploy/systemd/*.service`). Con nvm, node vive dentro del `$HOME` de
> quien lo instaló y `/usr/bin/node` no existe: los dos servicios fallarían al
> arrancar con `status=203/EXEC`, un error que no menciona a nvm por ningún
> lado y que se busca durante horas.

### PostgreSQL

```bash
psql --version                    # debe imprimir 17.x
systemctl is-active postgresql    # active
```

Debian 13 trae PostgreSQL **17**, la misma versión que se usó en desarrollo, así
que `apt install postgresql` **basta**. **`postgresql-contrib` NO hace falta**:
en Debian los módulos adicionales —`citext` entre ellos, que la aplicación
necesita para que los correos no distingan mayúsculas— viajan dentro del paquete
del servidor.

---

## 4. Usuario de sistema, rol y base de datos

```bash
adduser --system --group --home /srv/wellbros --shell /bin/bash wellbros
```

`--system` crea una cuenta de servicio (sin caducidad de contraseña, UID bajo).
Le damos `/bin/bash` para poder hacer `sudo -iu wellbros` en los pasos
siguientes; la cuenta **no tiene contraseña ni clave SSH**, así que nadie puede
entrar como ella desde fuera.

Genera la contraseña del rol de la base y **apúntala**: la vas a necesitar dos
veces (en el `.env` y en el `.pgpass`).

```bash
DBPASS="$(openssl rand -base64 24 | tr -d '/+=')"
echo "$DBPASS"
```

> Se le quitan `/`, `+` y `=` a propósito: esa contraseña va dentro de una URL
> (`DATABASE_URL`) y esos caracteres habría que codificarlos a mano. Quitarlos
> es más corto que explicar el `%2F`.

```bash
test -n "$DBPASS" && sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE wellbros_user LOGIN PASSWORD '$DBPASS';
CREATE DATABASE wellbros OWNER wellbros_user;
SQL
```

> El `test -n` está ahí porque `$DBPASS` solo vive en **esta** terminal. Si la
> sesión SSH se cortó entre un paso y el otro, la variable está vacía y sin esa
> guarda crearías el rol **con contraseña vacía** sin enterarte. Si no imprime
> `CREATE ROLE`, vuelve a generar la contraseña.

> **El `OWNER` no es opcional.** La primera migración empieza con
> `CREATE EXTENSION IF NOT EXISTS citext;` y la ejecuta `wellbros_user`, no el
> superusuario de PostgreSQL. `citext` es una extensión *trusted* desde
> PostgreSQL 13, lo que permite crearla sin ser superusuario **siempre que se
> tenga permiso `CREATE` sobre la base** — y eso lo da ser su dueño. Si la base
> se crea con dueño `postgres`, `prisma migrate deploy` muere en su primera
> línea con `permission denied to create extension "citext"` y no se instala
> nada.

Comprobación (debe conectar por TCP y responder con el rol y la base):

```bash
PGPASSWORD="$DBPASS" psql -h localhost -U wellbros_user -d wellbros \
  -c 'SELECT current_user, current_database();'
```

---

## 5. Primera instalación

### 5.1 Directorios

```bash
mkdir -p /srv/wellbros/{app,shared,bin,backups/{daily,weekly,monthly,pre-deploy}}
chown -R wellbros:wellbros /srv/wellbros
chmod 750 /srv/wellbros
```

```
/srv/wellbros/
├── app/                 clon del repositorio
├── shared/.env          variables de entorno (chmod 600)
├── .pgpass              contraseña para pg_dump/pg_restore (chmod 600)
├── bin/                 deploy.sh y backup.sh
└── backups/
    ├── daily/ weekly/ monthly/   respaldos programados
    └── pre-deploy/               volcado previo a cada despliegue
```

### 5.2 El archivo `.env`

> **SIN COMENTARIOS AL FINAL DE LÍNEA. NUNCA.**
>
> systemd lee este archivo con `EnvironmentFile=` y su lector **solo ignora las
> líneas que EMPIEZAN por `#`**. Un comentario al final de una línea con valor
> queda **dentro del valor**. Es decir, esto:
>
> ```
> EMAIL_DRIVER=resend   # console|resend
> ```
>
> hace que la aplicación reciba `resend   # console|resend`, que no es igual a
> `resend`, así que **cae al adaptador de consola**: los avisos se escriben en
> `/srv/wellbros/app/.tmp/emails/`, **no sale ni un solo correo, y la cola marca
> todo como enviado**. No hay ningún error en ningún registro. Nadie se entera
> hasta que alguien pregunta por qué no le llegó su aviso.
>
> En desarrollo no se nota, porque `bash` sí recorta el comentario al hacer
> `source .env`. Solo revienta en el servidor.

Pega esto tal cual (el `<<'EOF'` con comillas evita que el shell toque nada):

```bash
cat > /srv/wellbros/shared/.env <<'EOF'
# ─── Base de datos ───────────────────────────────────────────────────
# Puerto 5432: PostgreSQL nativo del servidor.
# (El 5434 que aparece en la documentación es el del contenedor Docker de
# desarrollo, y aquí no existe.)
DATABASE_URL=postgresql://wellbros_user:PON_AQUI_LA_CONTRASENA_DE_LA_BASE@localhost:5432/wellbros?schema=public

# ─── Aplicación ──────────────────────────────────────────────────────
APP_BASE_URL=https://wellbrosproperties.lat

# Generar con:  openssl rand -base64 32
# Cambiarlo cierra todas las sesiones abiertas.
SESSION_SECRET=PON_AQUI_EL_SECRETO_DE_SESION

# ─── Correo (Resend) ─────────────────────────────────────────────────
# resend  = envío real
# console = escribe los correos en .tmp/emails/ y no llama a Resend
EMAIL_DRIVER=resend

# Clave con permiso de SOLO ENVÍO, restringida al dominio.
RESEND_API_KEY=PON_AQUI_LA_CLAVE_DE_RESEND

# El dominio verificado en Resend es la RAÍZ. Un subdominio
# (notificaciones.wellbrosproperties.lat) sería OTRO dominio a efectos de
# Resend, habría que verificarlo aparte, y usarlo sin verificar devuelve 403.
# Las comillas SÍ hacen falta aquí, y solo aquí: el valor lleva "<" y ">", que
# en shell son redirecciones, y deploy.sh carga este archivo con ". .env".
# systemd quita las comillas al leerlo.
RESEND_FROM="Wellbros <notificaciones@wellbrosproperties.lat>"

# Sin Reply-To, por decisión del cliente: los correos avisan en su pie de que
# no se responda y a quién acudir. Una respuesta a este remitente se pierde.
RESEND_REPLY_TO=

# La ruta /api/webhooks/resend todavía no existe: no hay webhook que registrar
# ni secreto que poner. Ver §13.
RESEND_WEBHOOK_SECRET=

# ─── Semilla ─────────────────────────────────────────────────────────
# Se deja vacío: la contraseña inicial se pasa en la línea del comando de
# siembra, para que no quede escrita en un archivo que leen los dos servicios.
SEED_SUPERUSER_PASSWORD=
SEED_SUPERUSER_EMAIL=
SEED_SUPERUSER_NAME=

# Datos de ejemplo (propiedades y semanas de prueba). VACÍO en este servidor:
# la superusuaria crea las propiedades reales desde la aplicación.
SEED_DEMO_DATA=

# ─── WhatsApp: preparado, NO activo ──────────────────────────────────
WHATSAPP_ENABLED=false
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_WABA_ID=
WHATSAPP_API_VERSION=v23.0
EOF

chown wellbros:wellbros /srv/wellbros/shared/.env
chmod 600 /srv/wellbros/shared/.env
```

Ahora rellena los tres marcadores:

```bash
nano /srv/wellbros/shared/.env
```

- `PON_AQUI_LA_CONTRASENA_DE_LA_BASE` → la que generaste en §4 (`echo "$DBPASS"`).
- `PON_AQUI_EL_SECRETO_DE_SESION` → `openssl rand -base64 32` (ejecútalo en otra
  terminal y pega el resultado).
- `PON_AQUI_LA_CLAVE_DE_RESEND` → la clave del panel de Resend.

Comprobación de que no quedó ningún marcador ni ningún comentario en línea:

```bash
grep -n 'PON_AQUI' /srv/wellbros/shared/.env          # no debe imprimir nada
grep -nE '^[A-Z_]+=.*[^ ]\s+#' /srv/wellbros/shared/.env   # no debe imprimir nada
```

### 5.3 El archivo `.pgpass`

Los respaldos (`backup.sh`, `deploy.sh`) usan `pg_dump`, que **no entiende
`DATABASE_URL`**: esa cadena lleva el parámetro `?schema=public`, que es de
Prisma, y libpq lo rechaza. Además el usuario del sistema se llama `wellbros`
y el rol de la base `wellbros_user`, así que tampoco sirve la autenticación
`peer`. Sin este archivo, `pg_dump` pide contraseña por teclado y desde cron eso
significa **cero respaldos, en silencio**.

```bash
printf '%s\n' 'localhost:5432:wellbros:wellbros_user:PON_AQUI_LA_CONTRASENA_DE_LA_BASE' \
  > /srv/wellbros/.pgpass
chown wellbros:wellbros /srv/wellbros/.pgpass
chmod 600 /srv/wellbros/.pgpass
nano /srv/wellbros/.pgpass     # sustituye el marcador por la contraseña real
```

> El `chmod 600` es obligatorio: si el archivo tiene más permisos, libpq **lo
> ignora sin decir nada** y vuelves al problema de la contraseña por teclado.

Comprobación (la base aún está vacía; lo que se prueba es la conexión):

```bash
sudo -u wellbros -H env PGHOST=localhost PGUSER=wellbros_user \
  pg_dump -Fc -f /tmp/prueba.dump wellbros && echo "pg_dump OK" && rm -f /tmp/prueba.dump
```

### 5.4 Clonar el repositorio **como el usuario `wellbros`**

```bash
sudo -u wellbros -H git clone https://github.com/pacocorona/wellbros.git /srv/wellbros/app
```

> **No lo clones como root.** Si `.git` acaba siendo de root, cualquier orden de
> git ejecutada después como `wellbros` —incluido todo `deploy.sh`— aborta con
> `detected dubious ownership in repository at '/srv/wellbros/app'`. Si ya
> ocurrió, la solución correcta es devolver la propiedad, no añadir excepciones
> con `safe.directory`:
>
> ```bash
> chown -R wellbros:wellbros /srv/wellbros/app
> ```

> Si el clon pide usuario y contraseña, el repositorio es privado: crea una
> *deploy key* de solo lectura en GitHub, guárdala en
> `/srv/wellbros/.ssh/id_ed25519` (dueño `wellbros`, `chmod 600`) y clona por
> SSH (`git@github.com:pacocorona/wellbros.git`).

### 5.5 Instalar, migrar, sembrar y compilar

Todo esto va **como `wellbros` y con el `.env` ya cargado en el entorno**:

```bash
sudo -iu wellbros
```

Y dentro de esa sesión:

```bash
cd /srv/wellbros/app
set -a; . /srv/wellbros/shared/.env; set +a

npm ci --include=dev
npx prisma migrate deploy
SEED_SUPERUSER_PASSWORD='WellBros_2026.' npm run db:seed
npm run build

exit
```

Por qué cada línea:

- **`set -a; . .env; set +a`** — carga y **exporta** las variables. Va primero
  porque `npm ci` dispara el `postinstall`, que es `prisma generate`, y
  `prisma.config.ts` resuelve `env("DATABASE_URL")` al arrancar: **sin
  `DATABASE_URL`, `prisma generate` muere y con él todo `npm ci`**, dejando un
  error de "postinstall script failed" que no menciona la variable que falta.
- **`npm ci --include=dev`** — `next build` necesita `typescript`, `tailwindcss`
  y los `@types`, que son `devDependencies`. Si algún día `NODE_ENV=production`
  se cuela en el entorno, `npm ci` las omitiría y la compilación moriría con un
  `Cannot find module 'typescript'`.
- **`npx prisma migrate deploy`** — aplica las migraciones. `deploy` y no `dev`:
  `dev` puede decidir **recrear la base** si detecta divergencias, y en
  producción eso es la pérdida total de los datos.
- **`npm run db:seed`** — crea **solo a la superusuaria** (Ivonne Buenfil,
  `ibuenfil@hotmail.com`) con la contraseña indicada, marcada para **cambio
  obligatorio en el primer acceso**. `SEED_DEMO_DATA` está vacío, así que **no**
  se crean propiedades ni semanas de ejemplo. La variable va **en la misma
  línea** del comando a propósito: así gana sobre la del `.env` (que está
  vacía) y la contraseña no queda escrita en un archivo permanente.
- **`npm run build`** — compila. Es el paso más pesado; si el proceso muere sin
  mensaje, casi siempre es falta de memoria (el núcleo mata a node): añade
  memoria de intercambio y repite.

Comprobación —debe haber **1 usuario, 0 propiedades y 0 semanas**—:

```bash
sudo -u wellbros -H env PGHOST=localhost PGUSER=wellbros_user psql -d wellbros -c \
  "SELECT (SELECT count(*) FROM users) AS usuarios,
          (SELECT count(*) FROM properties) AS propiedades,
          (SELECT count(*) FROM week_slots) AS semanas;"
sudo -u wellbros -H env PGHOST=localhost PGUSER=wellbros_user psql -d wellbros -c \
  "SELECT email, role, is_active FROM users;"
```

> Si aparecieran propiedades o semanas de ejemplo, bórralas antes de seguir
> (es seguro: en un servidor recién instalado no hay ninguna reserva real):
>
> ```bash
> sudo -u wellbros -H env PGHOST=localhost PGUSER=wellbros_user psql -d wellbros \
>   -c "DELETE FROM week_slots;" -c "DELETE FROM properties;"
> ```

---

## 6. Scripts de operación y entrada de sudoers

```bash
install -m 750 -o wellbros -g wellbros /srv/wellbros/app/deploy/bin/deploy.sh /srv/wellbros/bin/
install -m 750 -o wellbros -g wellbros /srv/wellbros/app/deploy/bin/backup.sh /srv/wellbros/bin/
install -m 750 -o wellbros -g wellbros /srv/wellbros/app/deploy/bin/run-app.sh /srv/wellbros/bin/
install -m 750 -o wellbros -g wellbros /srv/wellbros/app/deploy/bin/run-worker.sh /srv/wellbros/bin/
```

Los dos  son los lanzadores que ejecuta systemd. Existen porque
systemd **no expande variables en la posición del ejecutable** de :
un  falla con . El lanzador sí
lee  y  del entorno, que es lo que permite usar un Node
propio sin tocar el del sistema.

 reinicia los dos servicios, y para eso el usuario `wellbros`
necesita permiso — que **hoy no existe en ninguna parte**. Sin esta entrada, el
despliegue llega hasta el final y falla justo en el reinicio:

```bash
printf '%s\n' \
  'wellbros ALL=(root) NOPASSWD: /usr/bin/systemctl restart wellbros wellbros-worker' \
  'wellbros ALL=(root) NOPASSWD: /usr/bin/systemctl restart wellbros' \
  'wellbros ALL=(root) NOPASSWD: /usr/bin/systemctl restart wellbros-worker' \
  > /etc/sudoers.d/wellbros
chmod 440 /etc/sudoers.d/wellbros
visudo -cf /etc/sudoers.d/wellbros     # debe decir: parsed OK
```

Detalles que importan:

- El nombre del archivo **no puede llevar puntos**: `sudo` ignora en silencio
  los archivos de `/etc/sudoers.d/` que tengan `.` en el nombre. Nada de
  `wellbros.conf`.
- `visudo -cf` **no es opcional**. Un archivo mal escrito en `/etc/sudoers.d/`
  puede dejar `sudo` inservible para todo el mundo. Si dice algo distinto de
  `parsed OK`, borra el archivo y vuelve a escribirlo.
- Las tres líneas son **literales**: sudo compara la orden completa con sus
  argumentos. `deploy.sh` ejecuta los dos servicios en una sola orden (primera
  línea); las otras dos están para reinicios manuales.
- El permiso es exactamente ese y nada más: `wellbros` no puede parar, ni
  deshabilitar, ni tocar ninguna otra unidad.

La comprobación de verdad —ejecutar la orden— va en §6, cuando los servicios ya
existan.

---

## 7. Servicios

```bash
install -m 644 /srv/wellbros/app/deploy/systemd/wellbros.service        /etc/systemd/system/
install -m 644 /srv/wellbros/app/deploy/systemd/wellbros-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wellbros wellbros-worker
```

Son **dos**: la aplicación web y el worker que vacía la cola de correo. Van
separados para que un fallo de envío no afecte a las peticiones de los usuarios,
ni al revés.

Comprobación:

```bash
systemctl status wellbros wellbros-worker --no-pager
curl -fsS http://127.0.0.1:3000/api/health     # {"status":"ok"}
```

`/api/health` no solo dice que el proceso vive: consulta la base. Si responde
`{"status":"error"}` con código 503, node está en pie y PostgreSQL no.

Y ahora sí, la prueba del sudoers de §5 — **la orden exacta que ejecuta
`deploy.sh`**, ni una letra distinta:

```bash
sudo -u wellbros -H sudo -n /usr/bin/systemctl restart wellbros wellbros-worker && echo "sudoers OK"
```

Si responde `sudo: a password is required`, la entrada de `/etc/sudoers.d/`
falta o no coincide con la orden.

### Comprobar que las variables llegaron enteras

```bash
systemctl show wellbros-worker -p Environment
```

Qué mirar en esa salida:

- `EMAIL_DRIVER=resend`, **exactamente eso**. Si ves `resend # console|resend`
  o cualquier cosa después de la palabra, tienes el problema de §5.2: no saldrá
  ningún correo y la cola dirá que todo se envió.
- `RESEND_FROM=Wellbros <notificaciones@wellbrosproperties.lat>`, **sin comillas
  alrededor** (systemd las quita al leer el archivo; si las ves, sobran en el
  `.env`).
- `DATABASE_URL` apuntando a `localhost:5432` (el **5434** es el de desarrollo:
  si aparece, la aplicación no encontrará ninguna base).

> Esa salida imprime **la clave de Resend y la contraseña de la base en claro**.
> No la pegues en un correo, un chat ni un ticket.

---

## 8. Nginx y certificado

```bash
cp /srv/wellbros/app/deploy/nginx/wellbros.conf /etc/nginx/sites-available/wellbros.conf
ln -sf /etc/nginx/sites-available/wellbros.conf /etc/nginx/sites-enabled/wellbros.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Comprobación antes de pedir el certificado (debe devolver la pantalla de acceso
o una redirección, no el "Welcome to nginx"):

```bash
curl -sI http://wellbrosproperties.lat/login | head -n 1
```

Ahora sí, el certificado:

```bash
certbot --nginx -d wellbrosproperties.lat -d www.wellbrosproperties.lat --redirect
```

La primera vez pregunta un correo de contacto (avisos de caducidad) y pide
aceptar sus condiciones; responde en la propia terminal.

El orden importa: **primero solo HTTP**, y certbot añade el bloque 443 y la
redirección. Escribir a mano un `listen 443 ssl` antes de que exista el
certificado hace que nginx no arranque.

**Hasta que este paso termine, nadie puede entrar a la aplicación**, y no por un
capricho de seguridad: la cookie de sesión se emite con `secure: true` en
producción (`src/lib/auth/session.ts`), y una cookie `secure` **no viaja por
HTTP**. Sobre HTTP se ve la pantalla de acceso, se escribe la contraseña
correcta y la aplicación devuelve a `/login` una y otra vez, sin ningún mensaje
de error.

Comprobación final:

```bash
curl -sI https://wellbrosproperties.lat/login | head -n 1     # HTTP/2 200
systemctl list-timers 'certbot*' --no-pager                   # renovación automática
certbot renew --dry-run
```

> HSTS queda **desactivado a propósito**. La línea está comentada en
> `wellbros.conf` con la explicación de cuándo activarla (§14).

> **A partir de aquí, `/etc/nginx/sites-available/wellbros.conf` ya NO es igual
> al del repositorio**: certbot le añadió el bloque 443 y la redirección.
> `deploy.sh` no toca nginx, así que los despliegues no lo pisan. Pero si algún
> día vuelves a copiar el archivo desde el repositorio, **borrarás lo que
> escribió certbot** y el sitio se quedará sin HTTPS. En ese caso, revisa el
> archivo a mano y vuelve a ejecutar el mismo `certbot --nginx …` de arriba.

---

## 9. Respaldos automáticos

```bash
printf '%s\n' \
  'MAILTO=""' \
  '30 3 * * * wellbros /srv/wellbros/bin/backup.sh >> /srv/wellbros/backups/backup.log 2>&1' \
  > /etc/cron.d/wellbros-backup
chmod 644 /etc/cron.d/wellbros-backup
```

> El registro va **dentro de `/srv/wellbros/backups/`**, no a `/var/log/`. En
> `/var/log/` escribe root, y este trabajo corre como `wellbros`: cron no puede
> crear ahí el archivo, la redirección falla **antes** de ejecutar el script y
> **no se hace ni un solo respaldo**. Sin errores visibles, porque `MAILTO=""`
> —y porque nadie lee el correo local de un VPS.

> El archivo de `/etc/cron.d/` **no puede llevar punto en el nombre** (cron
> ignora `wellbros-backup.cron`), necesita el **campo de usuario** (`wellbros`,
> entre la hora y la orden) y debe terminar en salto de línea. `printf` con
> `%s\n` se ocupa de lo último.

Prueba ahora mismo, sin esperar a las 3:30:

```bash
sudo -u wellbros -H /srv/wellbros/bin/backup.sh
ls -lh /srv/wellbros/backups/daily/
```

Retención: 14 días de diarios, 60 de semanales, 370 de mensuales y 30 días de
los volcados previos a cada despliegue (`pre-deploy/`, que antes no purgaba
nadie y llenaban el disco poco a poco).

Prueba de restauración, **cada trimestre** (sobre una base aparte, nunca sobre
la de producción):

```bash
sudo -u postgres createdb wellbros_prueba -O wellbros_user
sudo -u wellbros -H env PGHOST=localhost PGUSER=wellbros_user \
  pg_restore -d wellbros_prueba /srv/wellbros/backups/daily/wellbros-AAAA-MM-DD.dump
sudo -u postgres dropdb wellbros_prueba
```

Un respaldo que nunca se ha restaurado no es un respaldo: es un archivo.

---

## 10. Cortafuegos y endurecimiento

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

> **Abre el 22 ANTES de `ufw enable`.** Al revés te quedas fuera del servidor y
> hay que entrar por la consola del panel de Hostinger.

En `/etc/ssh/sshd_config`: `PasswordAuthentication no` y `PermitRootLogin
prohibit-password` (o `no`, si ya hay otro usuario con `sudo`). Después
`systemctl restart ssh`, y **antes de cerrar la sesión actual**, comprueba desde
otra terminal que sigues pudiendo entrar.

PostgreSQL no debe salir del servidor:

```bash
grep -E "^listen_addresses" /etc/postgresql/17/main/postgresql.conf   # 'localhost'
ss -ltnp | grep 5432                                                  # solo 127.0.0.1
```

---

## 11. Primer acceso y prueba de correo de extremo a extremo

### 11.1 Entrar

1. Abre `https://wellbrosproperties.lat/login`.
2. Correo `ibuenfil@hotmail.com`, contraseña `WellBros_2026.`
3. La aplicación **debe exigir el cambio de contraseña** antes de dejar hacer
   nada más. Si no lo pide, avisa: algo no se sembró como debía.

### 11.2 Enviar un correo de verdad, sin molestar a nadie

Resend tiene **direcciones de simulación** que aceptan el envío y fingen el
desenlace, sin buzón real detrás:

| Dirección              | Qué simula                       |
| ---------------------- | -------------------------------- |
| `delivered@resend.dev` | entrega correcta                 |
| `bounced@resend.dev`   | rebote duro                      |
| `complained@resend.dev`| marcado como correo no deseado   |

**Paso 1.** Como Ivonne, crea desde la aplicación un usuario de prueba llamado
*Prueba Entrega* con el correo `delivered@resend.dev`. Te mostrará una
contraseña temporal; da igual, no vamos a usarla.

> Crear una cuenta **todavía no manda ningún correo**: la propia pantalla lo
> dice («el alta por invitación con enlace de correo aún no está disponible»).
> Por eso el aviso de prueba se encola a mano en el paso 2. No es un truco: es
> exactamente la misma fila que insertará la aplicación cuando esa función
> exista, y recorre el mismo camino (worker → plantilla → Resend).

**Paso 2.** Encola un aviso real para esa dirección:

```bash
sudo -u wellbros -H env PGHOST=localhost PGUSER=wellbros_user psql -d wellbros -c "
INSERT INTO notification_outbox
  (channel, recipient_user_id, recipient_address, event_type, payload, dedupe_key)
SELECT 'EMAIL', u.id, u.email, 'USER_INVITED',
       jsonb_build_object(
         'invitationId',    gen_random_uuid()::text,
         'userId',          u.id::text,
         'fullName',        u.full_name,
         'invitedByName',   'Prueba de despliegue',
         'path',            '/login',
         'expiresInLabel',  '48 horas',
         'recipientUserId', u.id::text,
         'recipientName',   u.full_name
       ),
       'PRUEBA-DESPLIEGUE/' || gen_random_uuid()::text
  FROM users u
 WHERE u.email = 'delivered@resend.dev';"
```

**Paso 3.** Mira la cola (el worker la revisa cada 5 segundos):

```bash
sudo -u wellbros -H env PGHOST=localhost PGUSER=wellbros_user psql -d wellbros -c \
  "SELECT event_type, recipient_address, status, attempts, provider_message_id, last_error
     FROM notification_outbox ORDER BY created_at DESC LIMIT 5;"
```

Qué debe verse:

- `status` pasa de `PENDING` a **`SENT`** en unos segundos.
- `provider_message_id` deja de estar vacío: ese identificador es el que aparece
  en el panel de Resend (*Logs*).
- `last_error` vacío y `attempts` en 1.

Y en el registro del worker (una línea JSON por suceso):

```bash
journalctl -u wellbros-worker -n 30 --no-pager
```

**Paso 4.** Repite los pasos 1 a 3 con un segundo usuario, *Prueba Rebote*,
`bounced@resend.dev` (cambia también la dirección del `WHERE` del paso 2).

Ojo con lo que significa el resultado: Resend **acepta** el envío —la fila queda
igualmente en `SENT`, con identificador— y el rebote ocurre **después**. **La
aplicación no se entera**, porque el webhook todavía no existe (§14): el rebote
se ve en el panel de Resend, no aquí. Es el comportamiento esperado hoy, y
conviene verlo una vez para no confundirlo con un fallo.

**Paso 5.** Al terminar, **desactiva** los dos usuarios de prueba desde la
aplicación. No los borres: la fila del aviso apunta a ellos con una clave
foránea `ON DELETE RESTRICT`, así que el borrado fallaría —y el historial de
envíos debe conservarse.

### 11.3 Si algo no cuadra

| Síntoma | Causa casi segura |
| --- | --- |
| La fila se queda en `PENDING` | El worker no está corriendo: `systemctl status wellbros-worker`. |
| `status = SENT` pero no llega nada, ni aparece en el panel de Resend | `EMAIL_DRIVER` no vale exactamente `resend` (§5.2). Compruébalo con `systemctl show wellbros-worker -p Environment` y mira si hay archivos en `/srv/wellbros/app/.tmp/emails/`: si los hay, está usando el adaptador de consola. |
| `last_error` con `403` | El remitente no está verificado. `RESEND_FROM` tiene que ir en el dominio **raíz** (`@wellbrosproperties.lat`), que es el que está dado de alta. |
| `last_error` con `422` | El `RESEND_FROM` está mal formado (comillas de más, `<` o `>` perdidos). |
| `last_error` con `429` o `daily_quota_exceeded` | Límite del plan gratuito (100 correos al día). El worker lo reintenta solo, con espera creciente. |
| `status = DEAD` | Se agotaron los intentos o la fila llevaba más de 20 horas viva. No se reintenta a ciegas a propósito: la ventana de idempotencia de Resend dura 24 h y pasado ese plazo el reintento enviaría un **duplicado**. |

---

## 12. Despliegues posteriores

```bash
sudo -u wellbros /srv/wellbros/bin/deploy.sh
```

El script, en este orden: vuelca la base a `backups/pre-deploy/`, trae el código,
instala, **compila** (si falla, se aborta aquí, sin tocar la base ni reiniciar
nada: el sitio sigue en pie con la versión anterior), migra, reinicia y espera a
que `/api/health` responda. Al terminar bien deja una etiqueta `deploy-…`.

Si la comprobación de salud falla, **el propio script imprime la orden exacta de
reversión con la etiqueta del último despliegue que sí arrancó**. No hay que
buscarla a mano.

---

## 13. Diagnóstico rápido

```bash
systemctl status wellbros wellbros-worker --no-pager
journalctl -u wellbros -n 80 --no-pager
journalctl -u wellbros-worker -n 80 --no-pager
journalctl -u nginx -n 40 --no-pager
curl -fsS http://127.0.0.1:3000/api/health
tail -n 20 /srv/wellbros/backups/backup.log
df -h /srv                       # el disco lleno tumba PostgreSQL
```

Cola de correo atascada:

```bash
sudo -u wellbros -H env PGHOST=localhost PGUSER=wellbros_user psql -d wellbros -c \
  "SELECT status, count(*) FROM notification_outbox GROUP BY status;"
```

---

## 14. Pendiente — **no hacer todavía**

### Webhook de Resend

**No lo registres.** La ruta `/api/webhooks/resend` **no existe** en la
aplicación: `src/proxy.ts` ya la declara pública, pero no hay ningún manejador
detrás. Registrarlo hoy solo produciría **404 en cada suceso** y Resend
reintentaría durante horas, ensuciando su panel sin aportar nada.

Cuando la ruta exista, entonces sí: crear el webhook en Resend, poner su secreto
en `RESEND_WEBHOOK_SECRET` y —solo si el cortafuegos se endurece más de lo que
está— permitir la entrada desde `44.228.126.217`, `50.112.21.217`,
`52.24.126.164`, `54.148.139.208` y `2600:1f24:64:8000::/52`.

Hasta entonces, los rebotes y las quejas se consultan en el panel de Resend.

### Informes DMARC (`rua`)

La política actual (`v=DMARC1; p=none;`) es válida pero no pide informes. Lo
lógico sería añadir `rua=mailto:dmarc@wellbrosproperties.lat`, **pero esa
dirección tiene que poder RECIBIR correo** y el dominio no tiene registro `MX`
en su raíz (el único `MX` es el de `send`, que es de Resend y sirve para los
rebotes). Hoy, los informes irían a un buzón inexistente y rebotarían.

Requisito previo: un buzón real (correo alojado, o un servicio de análisis DMARC
que dé una dirección propia). Después, dos a cuatro semanas leyendo informes
antes de pasar la política a `quarantine`, y más tarde a `reject`.

### Respaldos fuera del servidor

`backup.sh` deja todo en `/srv/wellbros/backups/`, **en la misma máquina que la
base**. Eso protege de un borrado accidental, no de perder el servidor. Falta
sincronizar a un destino externo:

```bash
# rclone sync /srv/wellbros/backups remoto:wellbros-backups
```

Requisito previo: decidir el destino y quién paga y custodia esa cuenta.

### HSTS

Activarlo (descomentar la línea en `wellbros.conf`, dentro del bloque 443 que
escribió certbot) **solo después** de comprobar durante unos días que HTTPS y la
renovación automática funcionan. La cabecera queda guardada en el navegador de
cada visitante durante un año y no se puede retirar desde el servidor: si el
certificado llegara a caducar, el sitio quedaría inaccesible para quien ya la
recibió.

### Reply-To

Hoy no hay, por decisión del cliente. Ponerlo exige un buzón real y un `MX` en
el dominio; si no, cada respuesta se pierde en silencio, que es justo lo que se
quiso evitar.
