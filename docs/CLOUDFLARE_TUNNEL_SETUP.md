# Cloudflare Tunnel Setup — Guardian Cloud Beta

## Estado

Cloudflare Tunnel queda configurado como endpoint público estable para el backend de Guardian Cloud durante la beta.

Sustituye a ngrok para evitar URLs efímeras y problemas con OAuth de Google Drive.

---

## Objetivo

Exponer el backend del homelab mediante un dominio fijo:

```txt
https://api.guardiancloud.app

Este endpoint se usará para:

API móvil
OAuth callback de Google Drive
subida de chunks a NAS / Drive
exportación de evidencias
Topología actual
Mobile App
   ↓
https://api.guardiancloud.app
   ↓
Cloudflare Tunnel
   ↓
Homelab Ubuntu
   ↓
Node backend Guardian Cloud
   ↓
http://192.168.178.79:3001
Dominio público
api.guardiancloud.app

Estado validado:

curl https://api.guardiancloud.app/health

Respuesta esperada:

{
  "status": "ok",
  "uptime_s": 0,
  "version": "0.1.0"
}
Tunnel usado

Se reutiliza el túnel Cloudflare ya existente del homelab.

Tunnel ID observado:

1a0df79d-18f0-4fd0-ba16-e51739a54c30

El túnel ya servía la web pública:

app.guardiancloud.app → guardian-web:80

Se añadió un nuevo Public Hostname:

api.guardiancloud.app → http://192.168.178.79:3001
Backend target

El backend real de Guardian Cloud escucha en:

0.0.0.0:3001

Validado en homelab:

curl http://127.0.0.1:3001/health

Respuesta:

{
  "status": "ok",
  "version": "0.1.0"
}
Ubicación del backend
/mnt/storage/projects/guardian-cloud/backend

Archivo de entorno:

/mnt/storage/projects/guardian-cloud/backend/.env
Variables necesarias en backend
GOOGLE_REDIRECT_URI=https://api.guardiancloud.app/auth/drive/callback
MOBILE_OAUTH_REDIRECT=guardiancloud://oauth/drive
PORT=3001

No volver a usar ngrok como redirect OAuth para beta externa.

Variable necesaria en mobile

En el entorno usado para compilar la APK:

EXPO_PUBLIC_API_URL=https://api.guardiancloud.app

Importante: esta variable se inyecta en build-time.
Después de cambiarla hay que reconstruir la APK/dev build.

Google Cloud Console

En el OAuth Client de Google debe existir este Authorized Redirect URI:

https://api.guardiancloud.app/auth/drive/callback

La URL antigua de ngrok solo debe mantenerse mientras se valida la migración:

https://subsiding-substance-lagged.ngrok-free.dev/auth/drive/callback

Tras validar la beta con api.guardiancloud.app, eliminar ngrok del OAuth client.

Docker / Cloudflared

Cloudflared corre como contenedor Docker existente.

Docker compose localizado en:

/home/diego/webs/cloudflared/docker-compose.yml

Container observado:

cloudflared

Imagen:

cloudflare/cloudflared:latest

Modo:

token-managed

Esto significa que los hostnames públicos se gestionan desde Cloudflare Zero Trust, no editando un config.yml local.

Ruta en Cloudflare:

Cloudflare One Dashboard
→ Networks
→ Tunnels
→ guardian-cloud tunnel
→ Configure
→ Public Hostname
Public Hostnames actuales
app.guardiancloud.app
  → http://guardian-web:80

api.guardiancloud.app
  → http://192.168.178.79:3001

No tocar app.guardiancloud.app al modificar la API.

Validación mínima

Desde el homelab:

curl -i https://api.guardiancloud.app/health

Desde móvil con datos 4G/5G:

https://api.guardiancloud.app/health

Debe responder el backend, no una página de Cloudflare ni un 502.

Validación OAuth Drive

Checklist mínimo:

App apunta a:
https://api.guardiancloud.app
Usuario pulsa conectar Google Drive.
Backend genera auth URL con:
redirect_uri=https://api.guardiancloud.app/auth/drive/callback
Google redirige al backend.
Backend recibe:
/auth/drive/callback?code=...
Backend redirige al deep link:
guardiancloud://oauth/drive?code=...
Mobile completa exchange.
Drive queda conectado.
Test upload crea archivo en el Drive del usuario.
Motivo de abandonar ngrok

Ngrok no es válido para beta externa porque:

el endpoint gratuito puede estar ya ocupado
el dominio puede cambiar
introduce pantalla intersticial
obliga a actualizar Google Cloud Console si cambia la URL
rompe confianza en OAuth
no es una URL estable para testers

Cloudflare Tunnel aporta URL fija y HTTPS estable sin abrir puertos del router.

Riesgos actuales

Este setup sigue dependiendo del homelab.

Si el miniservidor se apaga, el backend cae.

Esto es aceptable para beta técnica, pero no para producción.

Para producción futura se deberá migrar el backend a infraestructura más estable o montar redundancia.

Invariantes que NO cambia esta migración

No se toca:

GC_QUEUE
upload worker
chunking
recovery
foreground service Android
export
NAS / WebDAV
Drive upload logic
schema de base de datos

Cloudflare Tunnel solo cambia la entrada pública al backend.

Estado de validación

Validado:

api.guardiancloud.app/health → HTTP 200

Validación pendiente antes de beta externa:

OAuth completo desde móvil fuera de la WiFi
test upload a Drive de tester
grabación real con chunks
recovery tras kill app
exportación de sesión NAS / Drive