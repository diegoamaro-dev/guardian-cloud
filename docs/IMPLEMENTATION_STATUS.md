# IMPLEMENTATION_STATUS.md

⛔ NO APTO — pendiente la validación hardware del vídeo nativo segmentado con durable cleanup/scheduler integrado

Estado vigente a 2026-08-20. Fuentes de continuidad y evidencia:

* [handoff vigente de durable cleanup/scheduler](./audits/GUARDIAN_CLOUD_DURABLE_CLEANUP_SCHEDULER_HANDOFF_2026-08-20.md);
* [validación física de la integración nativa segmentada del 13/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_INTEGRATION_VALIDATION_2026-08-13.md).

La validación física del 13/08 cubre el productor nativo segmentado existente
entonces. No cubre el journal, runner y scheduler integrados después.

---

## Capacidades por nivel (referencia canónica)

Esta tabla es la **fuente única** para saber qué está implementado y qué está
validado, y con qué alcance. Cualquier afirmación en otro documento que la
contradiga es incorrecta.

### Nivel 1 — Implementado con validación disponible

| Capacidad | Matiz |
|---|---|
| Grabación de audio | — |
| Fragmentación de audio | En vivo cada 1,5 s |
| Subida de audio durante la grabación | Validada en el alcance histórico del MVP |
| Grabación nativa segmentada de vídeo | Implementada y validada físicamente el 13/08 en OnePlus 6 / Android 11; segmentos MP4 independientes H.264/AAC |
| Adopción y subida del vídeo durante la captura | Implementada y validada físicamente el 13/08; primer upload observado durante la captura y productor Expo no activo en paralelo |
| `GC_QUEUE` como fuente de verdad | — |
| Cola persistente | AsyncStorage; sobrevive a cierre forzado y a reinicio |
| Worker single-flight con reintentos | — |
| Recovery automático | Tras kill y al abrir la app. **No** tras reinicio sin abrirla (`I5c`) |
| Evidencia fuera del dispositivo durante la captura | Audio y vídeo nativo segmentado; la afirmación de vídeo se limita a la validación física del 13/08 |
| Exportación utilizable en `.m4a` | — |

### Nivel 2 — Implementado, pendiente de validación completa

| Capacidad | Qué falta |
|---|---|
| Durable cleanup journal/runner/scheduler | `IMPLEMENTED / UNIT_TESTED / HARDWARE_VALIDATION_PENDING`; falta validar en dispositivo la integración completa con vídeo nativo |
| Reliability Card | No se observó en Home durante la instalación de validación y la causa sigue sin determinar. Cubierta por pruebas unitarias, sin validación en dispositivo |
| Comportamiento y permisos en Android 13+ | `POST_NOTIFICATIONS` es SDK 33+ y el único dispositivo probado es API 30. Las tres ramas están cubiertas por pruebas unitarias, pero **prueba unitaria no es validación en dispositivo** |
| Matriz completa de resiliencia | Mala red, segundo plano prolongado, cierre forzado, reinicio, recovery y export, sin reejecutar con el artefacto vigente |

### Nivel 3 — Planificado: no implementado ni validado

| Capacidad | Estado |
|---|---|
| Recuperación completa del vídeo nativo | No consta validación integrada; no se declara implementada o validada por la evidencia actual |
| Exportación `.mp4` | No implementada ni validada |

> **Criterio de incompatibilidad.** Cualquier propuesta de «vídeo post-stop»
> —fragmentar y encolar **después** de detener la captura— es **incompatible
> con el principio central del producto**: «si grabas unos segundos, al menos
> una parte ya está fuera del dispositivo». La ruta nativa vigente sí genera,
> adopta y sube segmentos durante la captura. Esto no demuestra recovery
> completo, export `.mp4` ni durable cleanup en hardware.

Fuera de estos tres niveles, y explícitamente **no** capacidades actuales:
cifrado local de chunks (sólo `TODO` en el código), recovery autónomo tras
reinicio sin abrir la app (`I5c`), `capture_end_reason`, Closed Testing,
usuarios externos y publicación en Play Store.

### Problema 8 — Durable cleanup scheduler

Estado: `IMPLEMENTED / UNIT_TESTED / HARDWARE_VALIDATION_PENDING`.

La implementación demuestra por pruebas automáticas:

* scheduler single-flight;
* `pending=false` antes de `reconcile`;
* coalescencia de solicitudes del mismo tick;
* una solicitud durante una pasada provoca exactamente otra pasada;
* triggers cerrados `boot`, `finalized` y `stale_reconciled`;
* boot cleanup no bloqueante;
* errores del scheduler contenidos fuera del completion flow;
* una sesión sin journal permanece invisible al runner;
* un fallo local posterior a completion y autorización durable no incrementa
  `complete_attempts`, no repite `completeSession` y no degrada la
  finalización confirmada;
* un reap diferido exitoso retira `GC_QUEUE` y vuelve a solicitar cleanup con
  motivo `finalized`.

### Validación automática actual

| Comprobación | Resultado |
|---|---|
| Suite completa | **360/360** |
| Typecheck | **12 errores TypeScript históricos, cero nuevos** |
| `:gc-segmented-recorder:compileDebugKotlin` | **BUILD SUCCESSFUL** |
| `git diff --check` | Limpio |

El siguiente gate es la **validación hardware del vídeo nativo segmentado con
durable cleanup/scheduler integrado**. El trabajo no está cerrado hasta
superarlo.

---

## Baseline técnica congelada — `v0.3.0-rc.1` (2026-07-30)

Registro completo: [`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md).

| | |
|---|---|
| Commit construido | `5ac4a0314a9bfb62dcd97685ecb3295ae8257392` |
| Build EAS | `e98dd3a2-1448-43b5-a675-9116b5fa5ca3` (perfil `preview`, APK) |
| SHA-256 del APK | `A3A51604AE207D9DFA0C25241EF438C321065C758722C3794DE8860C208E0F2A` |
| Dispositivo de validación | OnePlus 6, Android 11 (SDK 30), `arm64-v8a` |
| Tests automáticos | **198/198 verdes** |
| TypeScript | **12 errores heredados**, cero nuevos → typecheck NO verde |

### Qué contiene

- **A-0 · A-1 · A-2** fusionadas (base `origin/main` @ `e656ea44`).
- **ReliabilityCard** (+538 líneas): petición contextual de `POST_NOTIFICATIONS`
  y exención de optimización de batería. Aislada — no importa nada de
  `recording`, `queue`, `worker`, `recovery` ni `export`, y usa clave propia de
  AsyncStorage (`gc.reliability.dismissed_at`).
- Configuración EAS repuntada a `@amarus/guardian-cloud`.

### Qué es y qué no es

**Es** un punto de retorno reproducible. **No es** una release pública: no hay
AAB de producción, ni Closed Testing, ni usuarios externos. Ver
[`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md).

### El veredicto `NO APTO` sigue vigente

La baseline **no levanta** el veredicto de la auditoría. Siguen abiertas:

- el **vídeo no saca evidencia del dispositivo durante la grabación**
  (GC-AUD-001);
- no existe `capture_end_reason`: no se puede probar finalización limpia;
- recovery **I5c** (tras reinicio del dispositivo, sin abrir la app) no
  implementado;
- cifrado local no implementado.

A-1 y A-2 fueron **contención semántica**: cambiaron lo que el sistema afirma,
no lo que hace.

### Validación por nivel de evidencia

| Nivel | Alcance |
|---|---|
| **Verificado por instrumentación** | instalación, arranque estable, ausencia de excepciones fatales, `ENV READY`, `GC_BOOT_*`, worker en bucle, firma del APK, contenido del bundle, casos T2/T5/T9/T11/T12 |
| **Atestiguado manualmente** | grabación **de audio** y grabación **de vídeo** (ambas ejecutadas a mano); **subida de audio durante la grabación**; segundo plano y bloqueo; mala red; cierre forzado; reinicio con cola pendiente; recovery; exportación |
| **No ejecutado** | rama Android 13+ de `POST_NOTIFICATIONS`, T1/T3/T4/T6/T7/T8/T10, Closed Testing, usuarios externos |

> **Sólo el audio saca fragmentos del dispositivo durante la grabación.** El
> chunker en vivo corre cada 1,5 s únicamente en modo audio. **El vídeo se
> fragmenta y se encola DESPUÉS de detener la captura** (`chunkVideoFile` se
> ejecuta post-`stop()`), así que durante una grabación de vídeo **no sale nada
> del dispositivo**.
>
> Esta limitación es **`GC-AUD-001`**. Su consecuencia directa: **el vídeo
> todavía no cumple el principio central de supervivencia** del producto —«si
> grabas unos segundos, al menos una parte ya está fuera del dispositivo»—.
> Ante kill, crash o pérdida del dispositivo mientras se graba vídeo puede
> perderse toda la evidencia.
>
> «Grabación de vídeo atestiguada» significa que la captura, el chunking
> post-stop, la subida posterior y la exportación funcionaron. **No** significa
> que hubiera subida durante la captura. Resolverlo corresponde a la **fase D**.

**Discrepancia de versión conocida:** la etiqueta se llama `v0.3.0-rc.1` pero la
aplicación declara `0.1.0` / `versionCode 1`. La etiqueta marca un punto de git,
no una versión de aplicación. Ver §7.1 del registro de baseline.

---

## Baseline funcional — `baseline-fea160c-android11-20260730` (2026-07-30)

Registro completo:
[`baselines/BASELINE_FEA160C_2026-07-30.md`](./baselines/BASELINE_FEA160C_2026-07-30.md).

| | |
|---|---|
| Commit | `fea160ccc5a7bb53997d60c901711106176fe9b5` |
| Rama publicada | `feat/reliability-card` |
| Build EAS | `0986770d-0f52-4eaf-956a-8811c8fc9122` (perfil `preview`, APK) |
| SHA-256 del APK | `cb8120af483a66a99e5a5fab711f4e1094f883dd56e458e51440a17dcbf24301` |
| Firmante (SHA-256) | `6aa7fa91a0d28c897ce008be184a1b9b7b98761283e035f605a8e33b126c921a` |
| Dispositivo | OnePlus 6, Android 11 (SDK 30), `arm64-v8a` |

### Dos cosas distintas que no deben mezclarse

**1 · Validaciones históricas del sistema.** Todo lo registrado en el resto de
este documento —incluida la tabla «Validación por nivel de evidencia» de la
baseline `v0.3.0-rc.1` y los apartados de audio, recovery y export— corresponde
a artefactos **anteriores**. No fue reejecutado con la APK de esta baseline.

**2 · Validación concreta de esta APK.** Se limita a: **instalación limpia
correcta**, **arranque del paquete en dispositivo real**, **interfaz renderizada
sin cierre inmediato** y **uso observado por el propietario**. Nada más.

La frase del tag *«Core application works on the tested device»* se interpreta
de forma estricta con ese alcance: instalación, arranque y uso observado en ese
dispositivo. **No** es validación de resiliencia.

### Qué sigue sin validar con esta APK

Android 13+ y `POST_NOTIFICATIONS`; la matriz completa de mala red, segundo
plano, cierre forzado, reinicio, recovery y export; actualización conservando
datos previos; múltiples dispositivos; usuarios externos; publicación en Play
Store; y el motivo por el que la Reliability Card no apareció en Home
—cuestión abierta que impide considerarla validada en dispositivo—.

Esta baseline **no levanta** el veredicto `NO APTO` de la auditoría 2026-07-28.
`GC-AUD-001` sigue abierto.

---

## Current MVP status

The MVP currently supports:

- Google Drive OAuth connection
- Backend callback to mobile deep link
- Session creation
- Audio recording
- Native segmented video recording
- Native MP4 segment adoption and upload during capture
- Chunk generation
- Real chunk upload to Google Drive
- Chunk metadata registration
- Persistent pending recovery state
- Recovery after app kill
- Recovery after device reboot
- Session completion
- Durable cleanup journal, runner and single-flight scheduler, implemented and
  unit tested with hardware validation pending
- Audio evidence export from a given session (download chunks via backend
  proxy, verify sha256, concatenate in order, write `.m4a` to
  `documentDirectory`, produce a partial result when chunks are
  missing/corrupt)

## Current validated criterion

The validated audio path can record, generate chunks, upload them to Drive,
recover pending chunks after failure, complete the session, clean local state,
and export evidence as a single `.m4a`.

Separately, native segmented video generation, adoption and upload during
capture were physically validated on 2026-08-13. That execution did not include
the current durable cleanup scheduler. Complete native-video recovery and final
`.mp4` export are not declared physically validated.

## Product status

The system is no longer a prototype.

The historical audio/legacy MVP path has been validated under:

* app kill
* network loss
* background execution
* recovery after restart

This confirms:

> Guardian Cloud fulfills its core promise: evidence survival under real conditions

---

## Current focus

* usability under stress
* fast activation
* user validation

Not:

* new features
* advanced security
* system expansion
---

## Audio pipeline updates (v0.3.3)

### Audio chunk persistence migration

Audio chunks no longer persist inline `base64Slice` payloads inside GC_QUEUE.

Current behavior:
- audio chunks are written to disk under:
  `documentDirectory/chunks/{sessionId}/{chunk_index}.b64`
- GC_QUEUE stores metadata + `local_uri`
- upload worker rehydrates payloads from disk

Reason:
Long audio sessions (~200+ chunks) exceeded the Android SQLite
CursorWindow per-row limit when chunk payloads accumulated directly
inside AsyncStorage.

Result:
- stable queue performance during long recordings
- recovery preserved
- export preserved
- upload worker unchanged
- legacy queue entries remain compatible

Validated:
- long recordings (300+ chunks)
- backend crash + restart
- app restart during drain
- recovery after interruption
- export reconstruction

### Audio chunk size

Audio chunk size increased:

- previous: 16 KB
- current: 32 KB

Reason:
Reduce request overhead and improve sustained upload throughput during
long-running recordings.

Tradeoff accepted:
- first protected chunk slightly slower
  (~3 s → ~4.5 s)
- lower request count
- better sustained draining stability

Compatibility safeguard:
Legacy rehydration fallback now derives stride from `chunk.size`
instead of the global chunk constant to avoid HASH_MISMATCH risks after
the migration.

## Cross-device recovery

Estado: VALIDADO EN CONDICIONES REALES

Capacidades:
- discovery cross-device
- reconstruction from manifest
- partial recovery
- export from recovered evidence

---

## Incremental manifests and partial cross-device recovery (v0.3.4)

Status: ✅ validated on real device

Guardian Cloud now writes incremental Drive manifests during recording/upload, not only after session completion.

### What changed

Partial manifests are generated:
- after the first uploaded chunk
- every 10 uploaded chunks
- once more as final manifest when the session completes

The manifest keeps the same deterministic filename:

`{sessionId}_manifest.json`

and is overwritten as the session progresses.

### Why

Previously, chunks could survive in Google Drive while the session was still undiscoverable from another device.

Failure case fixed:
1. start recording
2. upload some chunks
3. lose connection / enable airplane mode
4. uninstall the app
5. reinstall on another device
6. open recovery

Before this change:
- uploaded chunks existed in Drive
- but no manifest existed yet
- recovery only showed older completed sessions

Now:
- partial manifests make interrupted sessions discoverable
- recovery can show them as partial
- uploaded evidence can be exported even if the original app install is gone

### Architecture

- Backend writes partial manifests fire-and-forget after chunk upload registration.
- Chunk upload response is not blocked by manifest generation.
- `GC_QUEUE` is unchanged.
- Mobile worker is unchanged.
- Export pipeline is unchanged.
- Drive OAuth is unchanged.
- Final complete manifest still overwrites the partial manifest on `/complete`.

### Partial recovery behavior

Audio:
- partial `.aac` recovery is usable because AAC ADTS frames are self-framing.

Video, para la ruta histórica que trocea un único archivo después de detener:
- partial `.mp4` recovery may not be directly playable if the MP4 metadata/moov atom was not written yet.
- It is still preserved as forensic partial evidence.

Los segmentos producidos por la ruta nativa actual son MP4 independientes y
fueron reproducibles en la validación del 13/08. Esa evidencia no demuestra el
recovery completo de una sesión nativa ni un export final `.mp4`.

### Validated scenario

Real-device test passed:

- started recording
- waited for chunks + partial manifest
- enabled airplane mode
- uninstalled app
- reinstalled APK
- opened recovery
- partial session appeared
- partial recovery/export worked

This closes the gap where evidence chunks survived remotely but were not discoverable after local state loss.

### Legacy post-stop video upload pipeline optimization (validated)

Status: ✅ validated on real device

Changes:
- Increased `VIDEO_FILE_CHUNK_SIZE` from 32 KB → 128 KB.
- Reduced POST/upload request count ~4× for typical MVP-sized videos.
- Preserved:
  - disk-backed queue
  - recovery flow
  - export compatibility
  - completion gate
  - cleanup/reap behaviour
  - background draining

Why:
The previous 32 KB strategy generated excessive request overhead for
video uploads (~150-160 chunks for ~5 MB recordings). Real-device
testing showed the bottleneck was request count, not local disk IO.

Result:
- Faster drain throughput.
- Smaller queue metadata pressure.
- Less post-stop waiting time before protection completes.
- Stable exports and playback after upload.

Real-device validation completed:
- short recording
- near-MVP-cap recording
- upload completion
- export playback
- recovery after restart

Important:
This optimization only affects the post-stop video chunking pipeline.
It is a historical validation of that legacy path, not evidence for complete
native-video recovery, final `.mp4` export or the integrated durable cleanup
scheduler.

Audio live-stream chunking remains independent and optimized separately
(32 KB disk-backed audio chunks).