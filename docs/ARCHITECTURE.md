# Guardian Cloud — Architecture

> **Aviso de estado.** Este documento describe la **arquitectura de destino**,
> no un informe de implementación. Partes de lo descrito aquí no están
> implementadas o no están validadas. El estado real por niveles está en
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica),
> que es la referencia canónica y prevalece sobre este texto.
>
> En particular: el cifrado local **no** está implementado, y todo el vídeo
> —segmentación, subida durante la grabación, recuperación y export `.mp4`— es
> nivel 3, **no implementado ni validado** (`GC-AUD-001`).

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
- cifrar — **previsto, no implementado en `v0.3.0-rc.1`** (ver «Flujo de datos»)
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
4. *(previsto, **no implementado en `v0.3.0-rc.1`**)* se cifran localmente
5. se suben al destino
6. se actualiza estado en backend
7. al cerrar se completa la sesión

> **El paso 4 no se ejecuta hoy.** El cifrado local está previsto en el diseño
> —ver `MVP_SCOPE.md` y `SECURITY.md`— pero **no está implementado**: en el
> código sólo existe un `TODO`. En `v0.3.0-rc.1` los chunks se encolan y se
> suben **sin cifrado en el cliente**. El transporte sí va sobre TLS.

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
* genera archivo final:
  * **`.m4a` (audio) — implementado y validado**
  * **`.mp4` (vídeo) — planificado, no implementado ni validado**

El flujo está implementado en cliente. **Sólo la ruta de audio (`.m4a`) forma
parte del MVP validado**; la de vídeo depende de que primero exista vídeo
segmentado con subida durante la grabación, que es nivel 3.

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
## Cross-device recovery architecture

Recovery source of truth:
- Drive manifests
- Drive chunks

Recovery NO depende del estado local del dispositivo.

El dispositivo original puede:
- perderse
- destruirse
- resetearse
- desinstalar la app

Mientras:
- el manifest exista
- los chunks existan
- el usuario conecte el mismo Drive

la evidencia puede reconstruirse.

### Flujo

Device A
→ upload realtime
→ manifest generation
→ Drive

Device B
→ discovery
→ manifest validation
→ chunk reconstruction
→ export local

### Importante

Recovery cross-device es aditivo.

NO reemplaza:
- recovery local
- GC_QUEUE
- upload worker
- background persistence

El objetivo sigue siendo:

> subir evidencia DURANTE la grabación