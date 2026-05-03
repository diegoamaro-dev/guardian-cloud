# Guardian Cloud — STATE v0.2 (Background + Recovery Stable)

## 🧠 Estado actual del sistema

Este punto marca la primera versión **realmente robusta** del sistema.

El flujo completo funciona bajo condiciones reales:

- grabación
- chunking
- subida en paralelo
- recuperación tras kill
- subida en background
- finalización automática

---

## 🔥 Principio validado

> La evidencia se protege incluso si:
- se pierde conexión
- se minimiza la app
- se mata el proceso
- el usuario vuelve más tarde

Si esto falla → el producto NO es válido.

En esta versión → **funciona**.

---

## ⚙️ Arquitectura (resumen real)

### 1. Grabación
- audio → chunking en tiempo real
- vídeo → chunking post-stop

### 2. Cola persistente (GC_QUEUE)
Estados:
- `pending`
- `uploading`
- `uploaded`
- `failed` (terminal)

Persistida en AsyncStorage.

---

### 3. Upload Worker
- single-flight
- retry con backoff
- errores clasificados:
  - transient → vuelve a `pending`
  - permanent → `failed`

---

### 4. Background Service (Android)

Controlado por:

```ts
isRecordingActive()
hasPendingUploadWork()

Reglas:

recording activo      → KEEPALIVE
chunks pendientes     → KEEPALIVE
nada pendiente        → STOP

NO depende de AppState.

5. Recovery en arranque

Orden:

migrateLegacyPendingState
normalizeQueueOnRecovery
reset uploading → pending
marcar recording_closed = true
reap sesiones completadas
runPendingRegistrationLoop
uploadDrainLoop
startBackgroundProtection (si hay pending)
🧪 Escenarios TEST VALIDADOS
✅ Test 1 — Grabación normal
grabar
subir
completar

✔️ OK

✅ Test 2 — Modo avión durante grabación
grabar
cortar red
parar
restaurar red

✔️ Subida se reanuda

✅ Test 3 — Kill app con cola pendiente
grabar
parar con red cortada
matar app
abrir app

✔️ Recovery automático

✅ Test 4 — Background (audio)
grabar
minimizar

✔️ Sigue subiendo

✅ Test 5 — Background (vídeo FIX CRÍTICO)

Problema previo:

race entre stop y chunking

Solución:

postStopChunkingInFlightRef

✔️ Service no muere antes de encolar chunks

✅ Test 6 — Stop final correcto

Logs esperados:

GC_QUEUE session completed
HAS_PENDING_UPLOAD_WORK result: false
GC_BACKGROUND_SERVICE_STOP no_pending_work

✔️ Service se apaga solo

📊 Logs clave
Background
GC_BACKGROUND_UPLOAD_START
GC_BACKGROUND_UPLOAD_TICK
GC_BACKGROUND_SERVICE_KEEPALIVE
GC_BACKGROUND_SERVICE_STOP
Recovery
GC_BOOT_RECOVERY_START
GC_BOOT_QUEUE_PENDING
GC_BOOT_UPLOAD_DRAIN_START
GC_BOOT_BACKGROUND_SERVICE_START
Diagnóstico
HAS_PENDING_UPLOAD_WORK
VIDEO_CHUNKS_ENQUEUED
❗ Decisiones importantes
❌ NO reconstruir vídeo parcial
❌ NO tocar GC_QUEUE
❌ NO lógica en UI
✅ UI solo observa estado
✅ prioridad: subida > grabación perfecta
⚠️ Limitaciones actuales
1. Vídeo en background (durante grabación)
NO funciona (limitación Android + Expo)
2. Foreground service depende de permiso notificaciones
requerido en Android 13+
🎯 Estado del producto
MVP CORE: VALIDADO

Esto ya no es un prototipo.

Es un sistema que:

sobrevive a fallos reales
protege datos
tiene comportamiento determinista
🚀 Siguientes pasos (orden correcto)
UX mínima (estado real)
Botón pánico / acceso rápido
Pulido de export
Tests agresivos (red mala, kill repetido)
Publicación inicial
🧱 Regla de oro

Si algo no funciona en:

mala red
background
cierre forzado

👉 NO entra en el producto