# Guardian Cloud — Architecture

## Visión general

Guardian Cloud se compone de cuatro bloques:

1. app móvil
2. backend ligero
3. base de datos gestionada
4. destino de almacenamiento del usuario

## 1. App móvil

Responsabilidades:
- capturar audio/vídeo
- fragmentar
- cifrar
- encolar
- subir
- reintentar
- recuperar estado tras fallo
- mantener subida activa con la app minimizada (Android foreground service)

Tecnologías reales (MVP actual):
- React Native / Expo (Dev Client, prebuild)
- AsyncStorage (`@react-native-async-storage/async-storage`) como cola
  persistente. Una sola clave `test.pending_retry` guarda un array de
  entries `PendingQueueEntry` (sesión + chunks + status). Lectura/escritura
  serializada con un `writeChain` para evitar carreras.
- expo-file-system para los archivos de grabación y los chunks en disco
- expo-av (audio) y expo-camera (vídeo)
- react-native-background-actions para el foreground service Android
  (notificación persistente "Guardian Cloud está protegiendo tu evidencia")

> SQLite NO se usa. Se evaluó al inicio y se descartó: AsyncStorage cubre
> el volumen real (chunks por sesión cuentan en decenas o cientos, no
> miles), elimina una dependencia nativa, y la cola es array-of-array sin
> joins. Si en el futuro el volumen exige SQLite la migración es local —
> el resto de la arquitectura no la nota.

## 2. Backend

Responsabilidades:
- auth auxiliar
- sesiones
- metadatos
- estado
- alertas
- health endpoints

Tecnologías previstas:
- Node.js
- Express
- Docker
- despliegue en homelab

## 3. Base de datos

Responsabilidades:
- usuarios
- relaciones familiares
- sesiones
- estados
- configuración

Tecnología:
- Supabase

## 4. Almacenamiento final

Destino del MVP actual:
- Google Drive (vía OAuth `drive.file`, carpeta `/GuardianCloud`)

Destinos futuros (NO en MVP):
- NAS del usuario (WebDAV sobre HTTPS — ver `NAS_DESTINATION_PLAN.md`)
- otros conectores cloud

> El MVP actual entrega Google Drive completo: subida proxied por el
> backend, dedup en dos capas (DB + nombre de archivo determinista),
> recovery tras kill, export por descarga inversa. NAS y otros destinos
> son una segunda iteración, no parte de v0.3.

## Flujo de datos

1. el usuario pulsa grabar
2. la app crea sesión
3. se generan chunks
4. se cifran localmente
5. se suben al destino
6. se actualiza estado en backend
7. al cerrar se completa la sesión

## Principios de arquitectura

- desacoplar app y backend
- no mezclar backend con almacenamiento final
- backend liviano
- reintento y tolerancia a fallo
- portabilidad futura a cloud

## Decisión clave

> El homelab aloja lógica y control, no el peso del almacenamiento.

## 5. Evidence Export & Reconstruction

### Objetivo

Permitir que la evidencia generada por el sistema pueda ser utilizada fuera de la app, sin depender de Guardian Cloud.

---

### Nivel 1 — Export (MVP actual)

El cliente es responsable de reconstruir la evidencia final:

* descarga chunks desde el destino (Drive)
* verifica integridad (hash)
* ordena por `chunk_index`
* concatena en orden
* genera archivo final (`.m4a` / `.mp4`)

Este flujo está implementado en cliente y forma parte del MVP validado.

---

### Nivel 2 — Forensic Reconstruction (futuro)

Se introduce un modo de reconstrucción externa basado en:

#### Manifest

Archivo `manifest.json` asociado a cada sesión:

* lista de chunks
* orden (`index`)
* hash
* tamaño
* metadata básica (modo, formato)

#### Chunks

Archivos binarios independientes:

* no reproducibles individualmente
* diseñados para supervivencia, no reproducción

---

### Herramienta externa

Se definirá una CLI externa:

```bash
guardian-rebuild ./folder
```

Responsabilidades:

* leer manifest
* validar hashes
* ordenar chunks
* concatenar
* generar archivo final reproducible

---

### Decisión arquitectónica clave

> Los chunks NO son archivos reproducibles por diseño.

Motivo:

* priorizar resiliencia
* permitir subida incremental
* tolerar pérdida parcial

---

### Implicaciones

* la reproducción siempre pasa por reconstrucción
* el sistema es tolerante a pérdida de chunks
* el archivo final puede ser parcial en escenarios extremos

---

### Limitaciones conocidas

* vídeo parcial puede no ser reproducible (estructura MP4)
* export actual carga en memoria (mejora futura: streaming incremental)

---

### Regla de diseño

> La evidencia debe poder usarse fuera del sistema, aunque el dispositivo original no exista
