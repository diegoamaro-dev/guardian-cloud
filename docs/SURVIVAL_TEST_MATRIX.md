# Guardian Cloud — Survival Test Matrix

## 1. Propósito

Esta matriz NO es QA exhaustivo.

Es la validación mínima de que **los invariantes reales de supervivencia** se cumplen bajo estrés Android real. Cada test responde a una sola pregunta:

> ¿La evidencia llega fuera del dispositivo aunque pase esto?

Si un test pasa pero un invariante de `BETA_STABLE_BASELINE.md` se rompe, gana el invariante. El veredicto del test es FAIL.

---

## 2. Invariantes que esta matriz valida

Tomados literalmente de `BETA_STABLE_BASELINE.md` y `CLAUDE.md`:

1. **Subida durante grabación** — la evidencia sale del dispositivo mientras la grabación sigue activa.
2. **Cola persistente** — `GC_QUEUE` es fuente de verdad y sobrevive a reinicios.
3. **Recovery automático** — al reabrir, los chunks pendientes terminan de subir y las sesiones se cierran.
4. **Background upload** — el foreground service mantiene la subida con app minimizada o pantalla apagada.
5. **Export usable** — el usuario puede recuperar evidencia exportable, parcial o completa, siempre que haya al menos un chunk subido.

Si cualquier test FAILa, identificar **cuál de estos cinco** se rompió. Esa es la información operacional, no el número de chunks.

---

## 3. Cómo usar esta matriz

1. Antes de la tanda: abrir `docs/SURVIVAL_TEST_RESULTS.md`, rellenar la cabecera de la sesión de validación (device, build, commit, red, battery saver).
2. Por cada test:
   - Leer **precondiciones**. Si no se cumplen, marcar `BLOCKED` y saltar.
   - Ejecutar **pasos** sin desviarse del orden.
   - Mientras corre, capturar logcat con el filtro indicado.
   - Anotar **campos a rellenar** en `SURVIVAL_TEST_RESULTS.md`.
   - Aplicar **criterio PASS/FAIL** mecánicamente. No interpretar.
3. Tras la tanda: revisar la sección "patrones detectados" en results y anotar tendencias entre tests.

**Regla operacional clave**: si dudas si un test pasó, FAILa. No hay puntos por casi-cumplir.

---

## 4. Logs de referencia (los que esta matriz cita)

Todos existen ya en el código bajo el tag `audio-engine-layer-stable`. Esta matriz NO requiere logs nuevos.

| Log key | Origen | Significado |
|---|---|---|
| `GC_QUEUE chunk emitted` | chunker (mobile/app/index.tsx) | Un chunk acaba de persistirse en cola con `status='pending'` |
| `GC_QUEUE chunk uploaded` | worker | Un chunk acaba de pasar a `status='uploaded'` en backend |
| `GC_PERF_RECORDER_START_START` / `GC_PERF_RECORDER_STARTED` | startRecording | Wall-clock antes/después de arrancar el recorder |
| `REC START — manual trigger` | startRecording | El usuario tocó GRABAR |
| `GC_DIAG: STOP_AND_UNLOAD_RETURNED` | stopRecording (audio) | `recorder.stop()` resolvió, archivo flushed |
| `REC MOVED TO DOCDIR` | stopRecording | Recording movido de cache a documentDirectory |
| `GC_BACKGROUND_UPLOAD_START` / `GC_BACKGROUND_UPLOAD_STARTED` | backgroundService | FG service arrancando / arrancado |
| `GC_BACKGROUND_UPLOAD_TICK` | backgroundService tick body | Heartbeat del loop |
| `GC_BACKGROUND_SERVICE_KEEPALIVE { reason: 'recording_active' \| 'pending_uploads' }` | backgroundService | Tick decidió mantener vivo |
| `GC_BACKGROUND_SERVICE_STOP { reason: 'no_pending_work' \| 'rec_stopped_no_pending_work' }` | backgroundService | Service se para |
| `GC_BACKGROUND_STATE_CHANGE { next, recording }` | AppState listener | Foreground ↔ background transición |
| `GC_BACKGROUND_RECORDING_CONTINUE` | AppState listener | Vamos a background CON recorder vivo |
| `GC_BOOT_DIRTY_STATE_DETECTED` | boot effect | Mount detectó chunker o recorder huérfano |
| `GC_BOOT_DIRTY_STATE_SESSION_CLOSED` | boot effect | Una sesión huérfana se cerró durante recovery |
| `GC_BOOT_DIRTY_STATE_RECORDER_STOP_FAILED` | audioEngine | Stop del recorder huérfano falló (best-effort, log + continuar) |
| `GC_BOOT_DIRTY_STATE_CHUNKER_STOP_FAILED` | boot effect | Stop del chunker huérfano falló |
| `GC_BOOT_BACKGROUND_SERVICE_START` | boot effect | Recovery vio cola con pendientes y arrancó el FG service |
| `GC_BOOT_STUCK_UPLOAD_RESET` | boot effect | Algún chunk en `uploading` quedó stuck y se reseteó a `pending` |
| `GC_EXPORT_DIAG_RAW` | exportSession | Resultado crudo del export (phase, extension, stoppedAt, stopReason) |
| `GC_EXPORT_DIAG_VERDICT` | session/[id].tsx | Causa discriminada del export (pending_upload, all_present, gap_before_export, hash_mismatch, download_failed, etc.) |

Filtro recomendado para logcat:

```
adb logcat -s ReactNativeJS:V | grep -E "GC_|REC " | tee survival.log
```

---

## 5. Tests

### SURVIVAL_S01 — Pantalla apagada 15 min durante grabación

**Objetivo**: validar invariante 4 (background upload con pantalla apagada).

**Precondiciones**:
- App fresca, sin sesiones pendientes (cola vacía, status `Listo`).
- Wi-Fi estable.
- Battery saver OFF.
- Destination Drive conectado y validado.
- Device cargado a >50% para descartar Doze por batería baja.

**Pasos**:
1. Tocar GRABAR (audio).
2. Verificar `Grabando` visible y subida progresando (`GC_QUEUE chunk uploaded` en logcat).
3. Bloquear pantalla (botón de encendido, no swipe-close).
4. Mantener pantalla apagada 15 minutos sin tocar el device.
5. Desbloquear pantalla.
6. Tocar PARAR.
7. Esperar a que `guardianStatus` pase de `subiendo` a `protegido` o `listo`.

**Resultado esperado**:
- Durante los 15 min: chunks siguen emitiéndose y subiéndose. El tick del FG service emite `GC_BACKGROUND_SERVICE_KEEPALIVE { reason: 'recording_active' }` periódicamente.
- Tras PARAR: drain completa sin pérdidas. `validChunks === totalChunks` en `GC_EXPORT_DIAG_RAW`.

**Logs esperados (deben aparecer)**:
- `GC_PERF_RECORDER_STARTED { mode: 'audio' }` al inicio.
- `GC_QUEUE chunk emitted` con frecuencia regular durante todo el test.
- `GC_BACKGROUND_SERVICE_KEEPALIVE { reason: 'recording_active' }` varias veces (al menos uno cada 5 s aprox.).
- `GC_DIAG: STOP_AND_UNLOAD_RETURNED` al parar.
- `GC_BACKGROUND_SERVICE_STOP` con `reason: 'no_pending_work'` tras drain.

**Logs prohibidos (FAIL si aparecen)**:
- `GC_BACKGROUND_SERVICE_STOP` durante la grabación (significaría que el service se durmió con recorder vivo).
- Cualquier `ERROR REC` mid-grabación.

**Criterio PASS**:
- Chunks emitidos crece de forma aproximadamente lineal durante los 15 min (gap > 30 s entre emisiones = FAIL).
- Tras PARAR, en menos de 60 s de drain post-stop la cola queda vacía.
- Export posterior produce `cause='all_present'`.

**Criterio FAIL**:
- Pausa > 30 s sin nuevos `chunk emitted`.
- Recorder muere silenciosamente (no `ERROR REC` pero la sesión termina con menos chunks de los esperados por la duración).
- Cualquier chunk en `status='failed'` permanente al final del drain.

**Campos a rellenar en SURVIVAL_TEST_RESULTS.md**:
- chunks_emitidos
- chunks_subidos
- duración_real_grabación_min
- gap_máximo_entre_emisiones_s
- recovery_ok: N/A
- export_ok
- reproducible
- observaciones

---

### SURVIVAL_S02 — App en background 15 min durante grabación

**Objetivo**: validar invariante 4 (background upload con app minimizada, NO swipe-closed).

**Precondiciones**: idénticas a S01.

**Pasos**:
1. Tocar GRABAR (audio).
2. Verificar `Grabando` y subida progresando.
3. Pulsar HOME (no recientes, no swipe). La app queda en background pero su actividad sigue viva.
4. Mantener app en background 15 minutos. Pantalla puede quedarse encendida en home o apagarse — anotar cuál.
5. Volver a la app desde el launcher.
6. Tocar PARAR.
7. Esperar drain completo.

**Resultado esperado**:
- Durante background: chunks siguen emitiéndose. Tras minimizar aparece `GC_BACKGROUND_STATE_CHANGE { next: 'background' | 'inactive', recording: true }` y `GC_BACKGROUND_RECORDING_CONTINUE`.
- Drain post-stop completa.

**Logs esperados (deben aparecer)**:
- `GC_BACKGROUND_STATE_CHANGE { next: 'background', recording: true }` al pulsar HOME.
- `GC_BACKGROUND_RECORDING_CONTINUE { mode: 'audio', session_id: ... }`.
- `GC_QUEUE chunk emitted` siguiendo durante los 15 min.
- `GC_BACKGROUND_SERVICE_KEEPALIVE { reason: 'recording_active' }` periódico.
- Al volver: `GC_BACKGROUND_STATE_CHANGE { next: 'active' }`.

**Logs prohibidos (FAIL si aparecen)**:
- `GC_BACKGROUND_SERVICE_STOP` durante la grabación.
- `ERROR REC` mid-grabación.

**Criterio PASS**:
- Mismo criterio que S01.
- Adicional: al volver a foreground no se observa `GC_BOOT_DIRTY_STATE_DETECTED` (no era un reinicio; la actividad nunca se destruyó).

**Criterio FAIL**:
- Mismo que S01.
- Adicional: si al volver a foreground se observa `GC_BOOT_DIRTY_STATE_DETECTED`, significa que Android destruyó la actividad sin que el FG service la protegiera → FAIL (rompe invariante 4).

**Campos a rellenar**:
- chunks_emitidos
- chunks_subidos
- pantalla_durante_test: encendida | apagada
- gap_máximo_entre_emisiones_s
- export_ok
- reproducible
- observaciones

---

### SURVIVAL_S03 — Swipe-close durante grabación

**Objetivo**: validar invariante 3 (recovery) bajo el caso documentado en `KNOWN_LIMITS.md` (expo-audio + swipe-close).

**Precondiciones**: cola vacía, Wi-Fi estable, destination conectado.

**Pasos**:
1. Tocar GRABAR (audio).
2. Esperar a que se hayan emitido al menos 3 chunks (`GC_QUEUE chunk emitted` × 3).
3. Abrir recientes y hacer swipe-close de Guardian Cloud.
4. Esperar 30 s sin abrir la app.
5. Reabrir Guardian Cloud desde launcher.
6. Esperar a que el boot effect termine. **No tocar nada hasta que `guardianStatus` se estabilice**.
7. Esperar drain completo si quedan pendientes.

**Resultado esperado**:
- Al reabrir, boot effect detecta estado sucio y lo limpia. La sesión previa queda cerrada y los chunks pendientes terminan de subir sin intervención del usuario.

**Logs esperados (deben aparecer)**:
- Antes del swipe: `GC_PERF_RECORDER_STARTED`, varios `GC_QUEUE chunk emitted`.
- Al reabrir: `GC_BOOT_DIRTY_STATE_DETECTED { chunker_state_ids: [...], has_active_recorder: true|false }`.
- `GC_BOOT_DIRTY_STATE_SESSION_CLOSED { session_id }` para la sesión.
- `GC_BOOT_BACKGROUND_SERVICE_START { pending_chunks: N }` si quedaron pendientes.
- Eventualmente: drain completa, `GC_BACKGROUND_SERVICE_STOP { reason: 'no_pending_work' }`.

**Logs aceptables (no son FAIL)**:
- `GC_BOOT_DIRTY_STATE_RECORDER_STOP_FAILED`: best-effort, el engine sigue. Esperado en el caso documentado de `KNOWN_LIMITS.md` cuando expo-audio dejó el recorder en estado terminal.

**Logs prohibidos (FAIL si aparecen)**:
- Sesión NO se cierra (queda con `recording_closed=false` indefinidamente).
- Chunks emitidos antes del swipe nunca llegan a `uploaded`.

**Criterio PASS**:
- Sesión cerrada (visible en historial como `Cerrada` o `Parcial`).
- Todos los chunks emitidos antes del swipe acaban subidos.
- Export devuelve `cause='all_present'` o `'gap_before_export'` solo si realmente algunos chunks fallaron transporte; nunca `'pending_upload'` indefinido.

**Criterio FAIL**:
- Sesión queda abierta indefinidamente.
- Drain no termina aunque haya red.
- Nueva grabación posterior bloqueada por estado sucio no resuelto.

**Campos a rellenar**:
- chunks_emitidos_antes_swipe
- chunks_subidos_al_final
- recovery_ok: SÍ | NO
- segundos_hasta_drain_completo
- export_ok
- reproducible
- observaciones

---

### SURVIVAL_S04 — Swipe-close durante upload pendiente (post-stop)

**Objetivo**: validar invariante 3 (recovery) en el caso "el usuario paró pero la cola aún no drenó".

**Precondiciones**: cola vacía, Wi-Fi estable.

**Pasos**:
1. Tocar GRABAR (audio).
2. Grabar 30 s para asegurar varios chunks.
3. Tocar PARAR.
4. Antes de que `guardianStatus` cambie a `protegido` o `listo` (es decir, mientras hay pendientes subiendo), hacer swipe-close.
5. Esperar 30 s.
6. Reabrir Guardian Cloud.
7. Esperar a que drain complete.

**Resultado esperado**:
- Al reabrir, la sesión ya estaba cerrada (PARAR completó el `recording_closed=true` antes del swipe). Recovery solo necesita arrancar el FG service para drenar los chunks restantes.

**Logs esperados**:
- Pre-swipe: `GC_DIAG: STOP_AND_UNLOAD_RETURNED`, sesión flipped a `recording_closed=true`.
- Post-reopen: posiblemente `GC_BOOT_DIRTY_STATE_DETECTED` si el chunker quedó vivo en memoria; o solo `GC_BOOT_BACKGROUND_SERVICE_START { pending_chunks: N>0 }` si fue clean kill.
- Drain completa: chunks pasan a `uploaded`, sesión queda `Cerrada`.

**Logs prohibidos**:
- Cualquier `ERROR REC` o crash de la nueva mount.
- Chunks que se quedan en `pending` indefinidamente.

**Criterio PASS**:
- Drain completa dentro de los 60 s posteriores al reopen (asumiendo red OK).
- Export posterior: `cause='all_present'`.

**Criterio FAIL**:
- Chunks quedan en `pending` o `failed` permanentemente.
- Drain inactivo (no aparece `GC_QUEUE chunk uploaded` tras el reopen).

**Campos a rellenar**:
- chunks_pendientes_al_swipe
- segundos_hasta_drain_completo_tras_reopen
- recovery_ok
- export_ok
- observaciones

---

### SURVIVAL_S05 — Pérdida de red 5 min durante grabación

**Objetivo**: validar invariantes 1 y 4 (grabación + background) cuando el upload está temporalmente imposible.

**Precondiciones**: cola vacía, Wi-Fi conectado, destination Drive.

**Pasos**:
1. Tocar GRABAR (audio).
2. Esperar a que se hayan subido al menos 2 chunks (`GC_QUEUE chunk uploaded` × 2).
3. Activar modo avión.
4. Mantener grabación corriendo 5 minutos.
5. Desactivar modo avión.
6. Esperar a que la red se restablezca y los chunks pendientes empiecen a subir.
7. Tocar PARAR.
8. Esperar drain completo.

**Resultado esperado**:
- Durante modo avión: chunks **siguen emitiéndose y persistiendo en cola** (invariante 1 no requiere red, solo persistencia).
- Worker reintenta y falla con `NETWORK_ERROR`. Esos errores son **esperados** y no rompen nada.
- Al volver la red: drain reanuda y vacía la cola.

**Logs esperados**:
- `GC_QUEUE chunk emitted` siguiendo durante toda la grabación, incluso con modo avión.
- Errores de subida con código de red durante el modo avión (no FAIL).
- `GC_BACKGROUND_SERVICE_KEEPALIVE { reason: 'recording_active' }` periódico.
- Al volver la red: `GC_QUEUE chunk uploaded` reanuda.

**Logs prohibidos**:
- `GC_QUEUE chunk emitted` se detiene por culpa de la red.
- Pérdida de chunks emitidos durante modo avión.

**Criterio PASS**:
- Cantidad de `chunk emitted` durante los 5 min consistente con la cadencia de la grabación.
- Tras drain post-restore, todos los chunks emitidos llegan a `uploaded`.

**Criterio FAIL**:
- Chunker se detiene cuando no hay red.
- Algún chunk emitido durante modo avión queda en `failed` permanente tras la restauración.

**Campos a rellenar**:
- chunks_emitidos_durante_modo_avión
- chunks_subidos_total
- segundos_hasta_reanudación_drain
- observaciones (anotar cualquier error de subida visto)

---

### SURVIVAL_S06 — Cambio WiFi → datos móviles durante upload

**Objetivo**: el worker tolera cambios de interfaz de red sin perder chunks.

**Precondiciones**: cola vacía, Wi-Fi y datos móviles ambos disponibles. Destination Drive.

**Pasos**:
1. Tocar GRABAR (audio).
2. Esperar 30 s para tener varios chunks pendientes / subiendo.
3. Desactivar Wi-Fi (el device cambia automáticamente a datos móviles).
4. Esperar 1 minuto.
5. Reactivar Wi-Fi (el device vuelve a Wi-Fi).
6. Tocar PARAR.
7. Esperar drain completo.

**Resultado esperado**:
- La grabación no se interrumpe.
- Algunas subidas pueden fallar en el switch y reintentar; ningún chunk se pierde.

**Logs esperados**:
- `GC_QUEUE chunk emitted` continuo.
- Posibles `NETWORK_ERROR` aislados en el momento del switch.
- `GC_QUEUE chunk uploaded` continúa tras estabilizarse cada red.

**Criterio PASS**:
- Drain final completa.
- Todos los chunks emitidos llegan a `uploaded`.

**Criterio FAIL**:
- Algún chunk queda en `failed` permanente.
- Grabación se interrumpe.

**Campos a rellenar**:
- chunks_emitidos
- chunks_subidos
- errores_de_red_observados (count)
- observaciones

---

### SURVIVAL_S07 — Modo ahorro batería activo durante grabación

**Objetivo**: validar que Doze / battery saver no mata el FG service.

**Precondiciones**: cola vacía, Wi-Fi. **Battery saver ON antes de empezar**. Anotar fabricante del device (relevante: algunos OEM aplican restricciones extra sobre el toggle estándar).

**Pasos**:
1. Activar battery saver desde ajustes del sistema.
2. Tocar GRABAR (audio).
3. Bloquear pantalla.
4. Mantener pantalla apagada 10 minutos.
5. Desbloquear, abrir Guardian Cloud.
6. Tocar PARAR.
7. Esperar drain completo.

**Resultado esperado**:
- Mismo comportamiento que S01.
- Si el OEM permite la grabación en battery saver, los chunks fluyen.
- Si el OEM mata el FG service de forma agresiva, esto es una **limitación documentada** del battery saver, no un bug de Guardian Cloud — anotar y marcar como **BLOCKED**, no FAIL, indicando el ROM.

**Logs esperados**:
- Igual que S01.

**Criterio PASS**:
- Igual que S01.

**Criterio BLOCKED (no FAIL)**:
- FG service muere antes de los 10 minutos por agresividad OEM. Anotar el fabricante y la versión de Android.

**Criterio FAIL**:
- FG service muere pero el OEM no es notoriamente agresivo (ROM stock, AOSP). Eso sí es regresión.

**Campos a rellenar**:
- fabricante_y_rom
- chunks_emitidos
- chunks_subidos
- duración_real_antes_de_matar (si aplica)
- observaciones (anotar si Doze visiblemente intervino)

---

### SURVIVAL_S08 — Reinicio violento de la app con cola pendiente

**Objetivo**: validar invariante 2 (cola persistente) y 3 (recovery) bajo el caso más violento: Force Stop desde ajustes.

**Precondiciones**: cola vacía, Wi-Fi.

**Pasos**:
1. Tocar GRABAR (audio).
2. Grabar 1 minuto.
3. Tocar PARAR.
4. Inmediatamente: Ajustes → Apps → Guardian Cloud → **Force Stop**.
5. Esperar 30 s.
6. Reabrir Guardian Cloud desde launcher.
7. Esperar drain completo.

**Resultado esperado**:
- Force Stop mata el proceso JS y el FG service sin orden.
- Al reabrir, el boot effect ve la cola con `recording_closed=true` (PARAR ya lo flippó antes del Force Stop) y chunks pendientes.
- Recovery arranca FG service y drena.

**Logs esperados**:
- Pre-Force-Stop: secuencia normal de PARAR (`GC_DIAG: STOP_AND_UNLOAD_RETURNED`).
- Post-reopen: `GC_BOOT_BACKGROUND_SERVICE_START { pending_chunks: N>0 }`.
- Posible `GC_BOOT_STUCK_UPLOAD_RESET` si algún chunk quedó en `status='uploading'` cuando murió el proceso.
- Drain completa.

**Criterio PASS**:
- Drain completo dentro de 90 s del reopen.
- Cola queda vacía.
- Export posterior `cause='all_present'`.

**Criterio FAIL**:
- Algún chunk queda en `failed` permanente.
- Recovery loop infinito o no detecta los pendientes.

**Campos a rellenar**:
- chunks_pendientes_al_force_stop
- chunks_subidos_tras_recovery
- recovery_ok
- export_ok
- observaciones

---

### SURVIVAL_S09 — Grabar nueva sesión mientras una antigua aún sube

**Objetivo**: validar que el flip a `recording_closed=true` libera GRABAR aunque el drain siga.

**Precondiciones**: cola vacía, Wi-Fi razonable (no demasiado rápida — interesa que la sesión A tenga drain pendiente cuando arranca B).

**Pasos**:
1. Tocar GRABAR (audio). Sesión A.
2. Grabar 30 s.
3. Tocar PARAR.
4. **Antes** de que `guardianStatus` cambie a `protegido` o `listo` (debe seguir `subiendo`), tocar GRABAR de nuevo. Sesión B.
5. Verificar que la sesión B arranca sin error y sin esperar a que A termine.
6. Grabar 20 s en B.
7. Tocar PARAR.
8. Esperar drain completo de ambas.

**Resultado esperado**:
- Sesión B arranca limpia.
- Ambas sesiones drenan en paralelo (worker tiene cola con entries de ambas).
- Ninguna se pisa.

**Logs esperados**:
- `GC_PERF_RECORDER_STARTED` dos veces (una por sesión).
- `GC_QUEUE chunk emitted` para ambos `session_id`.
- `GC_QUEUE chunk uploaded` para ambos.
- Eventualmente: `GC_BACKGROUND_SERVICE_STOP { reason: 'no_pending_work' }`.

**Logs prohibidos**:
- "REC START ignored — already starting or recording" cuando tocas GRABAR para sesión B.
- Mezcla de chunks entre sesiones (`chunk emitted` con `session_id` cruzado).

**Criterio PASS**:
- Ambas sesiones aparecen en historial como `Cerrada`.
- Export de A devuelve `all_present`. Export de B devuelve `all_present`.
- Cero chunks intercambiados.

**Criterio FAIL**:
- Sesión B no arranca o arranca tras retraso visible.
- Cualquier chunk de A acaba en B o viceversa.

**Campos a rellenar**:
- chunks_emitidos_A
- chunks_subidos_A
- chunks_emitidos_B
- chunks_subidos_B
- delay_inicio_B_observado_s
- observaciones

---

### SURVIVAL_S10 — Export antes y después de completion

**Objetivo**: validar invariante 5 (export usable) y que el verdor de UI distingue `pending_upload` de `all_present`.

**Precondiciones**: cola vacía, Wi-Fi.

**Pasos**:
1. Tocar GRABAR (audio).
2. Grabar 1 minuto.
3. Tocar PARAR.
4. **Inmediatamente** (mientras `guardianStatus === 'subiendo'`), navegar al detalle de la sesión y tocar Exportar.
5. Anotar el verdor mostrado (Integridad / Reproducible) y el log `GC_EXPORT_DIAG_VERDICT`.
6. Volver a Home. Esperar a que `guardianStatus` pase a `protegido` o `listo`.
7. Volver al detalle de la misma sesión. Tocar Exportar de nuevo.
8. Anotar verdor y log.

**Resultado esperado**:
- **Primer export**: `cause='pending_upload'`, UI muestra `Reproducible: Sí` + `Integridad: Parcial` + mensaje "Aún faltan fragmentos por subir…". Archivo `.aac` generado y compartible.
- **Segundo export**: `cause='all_present'`, UI muestra `Reproducible: Sí` + `Integridad: Completa`. Archivo `.aac` completo y compartible.

**Logs esperados**:
- Primer export: `GC_EXPORT_DIAG_RAW { extension: '.aac', validChunks: N, totalChunks: N }` + `GC_EXPORT_DIAG_VERDICT { cause: 'pending_upload', expectedLocalChunks: M, totalChunks: N }` con `M > N`.
- Segundo export: ambos logs con `cause: 'all_present'` y `expectedLocalChunks` igual a `totalChunks` (o `null` si la entry ya fue reapada).

**Criterio PASS**:
- Verdor del primer export es `Reproducible: Sí` + `Integridad: Parcial`.
- Archivo del primer export se reproduce en cualquier player (aunque sea más corto).
- Verdor del segundo export es `Integridad: Completa`.
- Archivo del segundo export se reproduce y es estrictamente más largo o igual que el primero.

**Criterio FAIL**:
- Primer export marcado como `Reproducible: No` siendo AAC contiguo (regresión de Pasada B).
- Segundo export marcado como `Parcial` cuando todo subió correctamente.
- Cualquier archivo `.aac` no reproducible.

**Campos a rellenar**:
- chunks_subidos_al_primer_export
- chunks_subidos_al_segundo_export
- verdor_primero (texto literal mostrado)
- verdor_segundo (texto literal mostrado)
- reproducible_primero
- reproducible_segundo
- observaciones

---

## 6. Tabla resumen

| ID | Test | Invariante validado | Duración mínima |
|---|---|---|---|
| S01 | Pantalla apagada 15 min | 4 background | 18 min |
| S02 | App en background 15 min | 4 background | 18 min |
| S03 | Swipe-close durante grabación | 3 recovery | 5 min |
| S04 | Swipe-close durante upload pendiente | 3 recovery | 4 min |
| S05 | Pérdida de red 5 min | 1 grabación + 2 cola | 8 min |
| S06 | Cambio WiFi → datos | 1 + 4 | 5 min |
| S07 | Battery saver ON | 4 | 13 min |
| S08 | Force Stop con cola pendiente | 2 + 3 | 5 min |
| S09 | Grabar mientras otra sube | 1 + 2 | 6 min |
| S10 | Export pre/post completion | 5 | 5 min |

Total tanda completa: aproximadamente **90 minutos** de tests reales. Se puede ejecutar parcialmente (subconjunto S01-S04-S10 cubre los invariantes principales en ~30 min).

---

## 7. Cuándo ejecutar esta matriz

- Antes de cualquier release / tag.
- Después de tocar `app/index.tsx`, `audioEngine.ts`, `backgroundService.ts`, `app.config.ts` o el manifest Android.
- Tras cualquier cambio en el plugin de expo-audio o react-native-background-actions.
- **NO** después de cambios solo en docs, export UI, backend, o quickstart.

---

## 8. Cómo reaccionar a un FAIL

1. Marcar el test en results como FAIL con la observación exacta.
2. Identificar qué invariante de la sección 2 se rompió.
3. **No** intentar fix sobre la marcha — primero rollback al último tag estable.
4. Reproducir en device limpio.
5. Solo entonces, abrir un branch específico y aplicar el fix más mínimo posible.

Vale más rollback rápido que parche encima de un FAIL.
