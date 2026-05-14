# CROSS_DEVICE_RECOVERY.md

## Objetivo

Permitir reconstruir evidencia desde otro dispositivo usando únicamente:
- misma cuenta Supabase
- mismo Google Drive

Incluso si:
- el móvil original desaparece
- AsyncStorage se pierde
- la app se reinstala

---

## Filosofía

La recuperación NO depende del estado local.

La fuente de verdad de recovery es:
1. manifest en Drive
2. chunks en Drive

NO:
- GC_QUEUE
- AsyncStorage
- estado local del móvil original

---

## Flujo completo

### COMMIT 1 — Manifest generation

Explicar:
- cuándo se genera
- naming
- estructura
- por qué existe

### COMMIT 2 — Discovery

Explicar:
- GET /recovery/manifests
- dedup
- validación
- drive_not_connected
- por qué el móvil no toca Drive directamente

### COMMIT 3 — Reconstruction/export

Explicar:
- exportFromChunkRefs
- pipeline compartido
- guardian_export_* vs guardian_recovered_*
- verificación hash
- partial recovery
- save/share

---

## Invariantes

NO romper:
- exportSession existente
- logs existentes
- GC_QUEUE
- worker
- upload realtime
- recovery local
- background upload

---

## Limitaciones actuales

- recovery depende de Google Drive conectado
- no streaming reconstruction
- export sigue memory-bound
- manifest v1 únicamente
- no NAS recovery todavía

---

## Casos validados

✅ móvil A → móvil B
✅ audio
✅ vídeo
✅ partial recovery
✅ save/share
✅ export normal sigue funcionando

---

## Casos NO validados aún

- sesiones enormes
- Drive rate limiting extremo
- recovery con NAS
- manifests v2