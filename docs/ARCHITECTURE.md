# Guardian Cloud — Architecture

> **Aviso de estado.** Este documento describe la **arquitectura de destino**,
> no un informe de implementación. Partes de lo descrito aquí no están
> implementadas o no están validadas. El estado real por niveles está en
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#capacidades-por-nivel-referencia-canónica),
> que es la referencia canónica y prevalece sobre este texto.
>
> El cifrado local **no** está implementado. La grabación nativa segmentada, la
> subida durante la captura y el durable cleanup/scheduler en su ruta normal
> están `HARDWARE_VALIDATED` desde el 20/08 en un OnePlus A6000 con Android 11.
> Esa evidencia **no** valida el recovery completo de vídeo, un export final
> `.mp4`, otros dispositivos ni las rutas artificiales de fallo del scheduler.
> Véase la
> [validación física del 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md).

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
- expo-av para audio
- módulo nativo Android `gc-segmented-recorder` para vídeo segmentado;
  expo-camera permanece como fallback y ambos productores son mutuamente
  excluyentes
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
3. se generan chunks de audio o segmentos MP4 nativos independientes de vídeo
4. *(previsto, **no implementado en `v0.3.0-rc.1`**)* se cifran localmente
5. los chunks de audio se encolan y los segmentos nativos se adoptan; ambos se
   suben al destino durante la captura
6. se actualiza estado en backend
7. al cerrar se completa la sesión

> **El paso 4 no se ejecuta hoy.** El cifrado local está previsto en el diseño
> —ver `MVP_SCOPE.md` y `SECURITY.md`— pero **no está implementado**: en el
> código sólo existe un `TODO`. En `v0.3.0-rc.1` los chunks se encolan y se
> suben **sin cifrado en el cliente**. El transporte sí va sobre TLS.

En vídeo, el productor nativo genera segmentos MP4 H.264/AAC independientes.
La validación física del 13/08 comprobó su reproducción individual, adopción,
integridad y subida durante la captura. El fallback Expo no corre en paralelo
con el productor nativo y conserva la ruta histórica post-stop cuando se usa.

## Durable cleanup local

El cleanup local exige autorización durable y sigue esta secuencia:

1. el backend confirma completion;
2. la autorización de cleanup se persiste en el journal;
3. `GC_QUEUE` se marca con `session_completed=true`;
4. se intenta el reap local;
5. el runner reconcilia únicamente sesiones visibles en el journal.

Una sesión sin journal permanece fuera del alcance del runner. El scheduler no
concede autorización; sólo solicita reconcile para entradas ya autorizadas.

El scheduler es single-flight:

* coalesce solicitudes del mismo tick;
* establece `pending=false` antes de `reconcile`;
* una solicitud durante una pasada produce exactamente una pasada adicional;
* contiene sus errores para que no alcancen el completion flow.

Los únicos triggers son:

* `boot`, de forma no bloqueante;
* `finalized`, después de un reap autorizado exitoso, incluido uno diferido;
* `stale_reconciled`, cuando se reconcilia al menos una sesión stale.

Después de completion y autorización durable, un fallo de mantenimiento local
no incrementa `complete_attempts`, no repite `completeSession` y no degrada
la finalización confirmada. Un reap diferido exitoso retira `GC_QUEUE` y
vuelve a solicitar cleanup con motivo `finalized`.

Esta arquitectura está implementada, cubierta por pruebas unitarias y
`HARDWARE_VALIDATED` en su ruta normal desde el 20/08: autorización tras
completion confirmada, trigger `finalized`, una única pasada de reconcile y
borrado de ambos recursos sin reiniciar la aplicación.

La **frontera de borrado exclusiva por journal** también está
`HARDWARE_VALIDATED`: en una pasada real con `considered: 1`, el runner eliminó
la sesión autorizada y dejó byte-identical dos directorios centinela de UUID
canónico sin entrada en el journal. `authorized → eligible for cleanup`,
`no journal → invisible`, demostrado por discriminación y no por inacción.

Las rutas artificiales de fallo —boot con trabajo durable real, caso positivo de
`stale_reconciled`, fallo de reap posterior a completion y reap diferido— siguen
en `HARDWARE_HARDENING_PENDING` y **no bloquean la integración de la rama**.

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
parte del export validado**. Ya existen segmentos MP4 nativos independientes,
pero la evidencia disponible no demuestra recovery completo de vídeo ni la
generación de un export final `.mp4`.

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

En el modelo histórico de chunks binarios de audio y del fichero de vídeo
post-stop:

* no reproducibles individualmente
* diseñados para supervivencia, no reproducción

Esta regla no se aplica a los segmentos de vídeo del productor nativo: son MP4
independientes y su reproducción individual fue validada físicamente el 13/08.

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

> Los chunks binarios de audio y de la ruta post-stop requieren reconstrucción;
> los segmentos MP4 del productor nativo son reproducibles individualmente.

Motivo:

* priorizar resiliencia
* permitir subida incremental
* tolerar pérdida parcial

---

### Implicaciones

* la reproducción de audio y de chunks post-stop pasa por reconstrucción
* cada segmento de vídeo nativo puede inspeccionarse de forma independiente
* el sistema es tolerante a pérdida de chunks
* un archivo reconstruido final puede ser parcial en escenarios extremos

---

### Limitaciones conocidas

* un fragmento parcial de un único MP4 de la ruta post-stop puede no ser
  reproducible por su estructura; esto no describe los segmentos MP4 nativos
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