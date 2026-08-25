# Despliegue de Wellbros

Servidor: **Debian 13** · Dominio: **wellbrosproperties.lat** · Base: PostgreSQL nativo en el host.

---

## 1. DNS — estado

> **Verificado el 24 de agosto de 2026.** La zona ya existe y propagó: los cuatro
> registros de correo se ven desde Google, Cloudflare, Quad9 y OpenDNS.
> El dominio se dio de alta en Resend **en su raíz** (no en un subdominio).

### Correo — LISTO

| Propósito | Tipo | Nombre | Valor observado |
|---|---|---|---|
| Retorno de rebotes | `MX` | `send` | `feedback.forge.rmta.net` (prioridad 10) |
| SPF del subdominio de envío | `TXT` | `send` | `v=spf1 include:_spf.forge.rmta.net ~all` |
| Firma DKIM | `TXT` | `resend._domainkey` | `p=…` (RSA 1024 bits) |
| Política DMARC | `TXT` | `_dmarc` | `v=DMARC1; p=none;` |

Nota: Resend ya **no** usa la infraestructura de Amazon SES para dominios nuevos
(`feedback-smtp.*.amazonses.com` / `include:amazonses.com`), sino la suya propia en
`forge.rmta.net`. Los valores de arriba son los que entrega su panel hoy; si alguna
guía antigua menciona `amazonses.com`, está desactualizada.

### Sitio — LISTO

| Tipo | Nombre | Valor |
|---|---|---|
| `A` | `@` | `72.62.164.198` |
| `A` | `www` | `72.62.164.198` |

El servidor (`srv1561619.hstgr.cloud`, VPS de Hostinger) responde en los puertos
80, 443 y 22. Con esto `certbot` ya puede emitir el certificado para ambos nombres.

### Único pendiente: informes DMARC

La política actual (`v=DMARC1; p=none;`) es válida pero **no pide informes**, así que
nadie recibirá datos sobre qué correo pasa o falla la autenticación — y sin ellos no
se puede endurecer la política con criterio. Conviene cambiarla a:

```
v=DMARC1; p=none; rua=mailto:dmarc@wellbrosproperties.lat;
```

y revisar los informes durante dos a cuatro semanas antes de pasar a `quarantine`
y después a `reject`.

Comprobación rápida en cualquier momento:

```bash
nslookup -type=TXT resend._domainkey.wellbrosproperties.lat 8.8.8.8
```

---

## 2. Preparación del servidor

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx ufw fail2ban unattended-upgrades postgresql

sudo adduser --system --group --home /srv/wellbros wellbros
sudo -u postgres psql -c "CREATE ROLE wellbros LOGIN PASSWORD 'CAMBIAR';"
sudo -u postgres psql -c "CREATE DATABASE wellbros OWNER wellbros;"
```

Estructura en el servidor:

```
/srv/wellbros/
├── app/          # clon del repositorio
├── shared/.env   # variables de entorno (chmod 600, dueño wellbros)
├── backups/{daily,weekly,monthly}/
└── bin/{deploy.sh,backup.sh}
```

---

## 3. Variables de entorno

Copiar `.env.example` a `/srv/wellbros/shared/.env`, `chmod 600`, y completar:

- `DATABASE_URL` con la contraseña real del rol `wellbros`.
- `SESSION_SECRET` generado con `openssl rand -base64 32`.
- `RESEND_API_KEY` — con permiso de **solo envío** y restringida al dominio.
  Su valor **no se puede volver a consultar** tras crearla.
- `EMAIL_DRIVER="resend"` (en desarrollo queda en `console` y no llama a Resend).

---

## 4. Servicios

```bash
sudo cp deploy/systemd/wellbros.service        /etc/systemd/system/
sudo cp deploy/systemd/wellbros-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wellbros wellbros-worker
```

Son **dos** servicios: la aplicación web y el worker que vacía la cola de correo.
Separarlos evita que un fallo de envío afecte a las peticiones de los usuarios.

---

## 5. Nginx y certificado

```bash
sudo cp deploy/nginx/wellbros.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/wellbros.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d wellbrosproperties.lat -d www.wellbrosproperties.lat --redirect
```

Certbot deja la renovación automática por temporizador de systemd.
HTTPS es obligatorio: sin él el navegador no registra el service worker ni ofrece
instalar la aplicación en el teléfono.

---

## 6. Respaldos

```bash
sudo cp deploy/bin/backup.sh /srv/wellbros/bin/ && sudo chmod +x /srv/wellbros/bin/backup.sh
echo '30 3 * * * wellbros /srv/wellbros/bin/backup.sh >> /var/log/wellbros-backup.log 2>&1' | sudo tee /etc/cron.d/wellbros-backup
```

Retención: 14 diarios, 8 semanales, 12 mensuales. **Falta lo importante**: sincronizar
`/srv/wellbros/backups/` a un destino fuera del servidor (`rclone`). Un respaldo que
vive en la misma máquina no es un respaldo.

Probar una restauración cada trimestre: `pg_restore -d wellbros_test archivo.dump`.

---

## 7. Cortafuegos

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

En `/etc/ssh/sshd_config`: `PasswordAuthentication no` y `PermitRootLogin no`.
PostgreSQL con `listen_addresses = 'localhost'` — nunca expuesto.

Si el cortafuegos filtra entrada de forma estricta, permitir las IP de los webhooks
de Resend: `44.228.126.217`, `50.112.21.217`, `52.24.126.164`, `54.148.139.208`,
`2600:1f24:64:8000::/52`.

---

## 8. Despliegue

```bash
sudo -u wellbros /srv/wellbros/bin/deploy.sh
```

El script respalda antes de migrar, aborta si la compilación falla (**antes** de tocar
la base o reiniciar) y verifica el arranque contra `/api/health`.

Reversión: `git reset --hard <etiqueta-anterior> && npm ci && npm run build && sudo systemctl restart wellbros`.
Si el problema fue una migración, restaurar el volcado previo con `pg_restore --clean`.
