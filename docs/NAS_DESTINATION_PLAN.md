# Guardian Cloud — NAS Destination Plan

## Estado

NAS NO forma parte del MVP actual.

El MVP validado usa:

- Google Drive como destino inicial
- backend ligero para auth/metadatos
- cola persistente local
- subida resiliente por chunks

NAS queda definido como destino futuro.

---

## Objetivo futuro

Permitir que el usuario use su propio NAS como destino de evidencia.

La filosofía sigue siendo:

> Tus datos son tuyos. Guardian Cloud solo los protege.

---

## Protocolo recomendado para MVP NAS

### Opción recomendada

WebDAV sobre HTTPS.

Motivos:

- más simple que SMB en móvil
- compatible con muchos NAS
- fácil de probar
- funciona bien detrás de reverse proxy/VPN
- permite subida de archivos por HTTP

---

## Protocolos NO recomendados para primera versión

### SMB

No usar en v1 NAS.

Problemas:

- peor soporte móvil
- más fricción de red local
- más problemas de permisos
- peor experiencia fuera de casa

### SFTP

Viable más adelante, pero no como primera opción.

---

## Configuración mínima

Campos:

- URL WebDAV
- usuario
- contraseña/token
- carpeta destino
- botón “Probar conexión”

Ejemplo:

```txt
https://nas.midominio.com/guardian-cloud
```

---

## Cómo encajaría en la arquitectura actual

Sin tocar el contrato `PendingQueueEntry`, el destino vive a nivel
backend:

- `destinations` table añade `type: 'nas'` (hoy solo acepta `'drive'`).
- Backend gana una nueva ruta (paralela a `/destinations/drive/chunks`)
  que recibe los mismos headers (`X-Session-Id`, `X-Chunk-Index`,
  `X-Hash`) y los proxia al WebDAV del usuario en lugar de a Drive.
- El cliente sigue subiendo igual: solo cambia el endpoint según
  `destination.type`. Cero cambios en el upload worker.
- Recovery, dedup y completion gate son los mismos — el destino solo
  cambia el `remote_reference` (URL absoluta WebDAV en vez de Drive
  file_id).

---

## Decisiones diferidas a v1 NAS

- Cifrado opcional en el cliente antes de enviar al NAS del usuario.
- Verificación de tamaño/integridad post-subida vía PROPFIND.
- UI para descubrimiento mDNS/Avahi en LAN (probablemente no — el
  usuario teclea la URL como con Drive teclea su cuenta).

---

## Lo que NO cambia con NAS

- GC_QUEUE format (campos del entry, key de AsyncStorage).
- Upload worker (clasificación de errores, retries, backoff).
- Chunking (audio live, vídeo post-stop).
- Foreground service (lifecycle predicate-driven).
- Export client (descarga inversa por chunk_index).

NAS añade UN endpoint, UN tipo de destination, UN selector. Nada más.