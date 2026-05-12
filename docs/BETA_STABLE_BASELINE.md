# BETA_STABLE_BASELINE.md

# Guardian Cloud — Stable Beta Baseline

Este documento define el punto estable oficial de la beta.

Objetivo:
- tener un estado reproducible,
- evitar debugging destructivo,
- permitir rollback rápido,
- proteger el pipeline crítico.

---

# ESTADO OFICIAL ESTABLE

## Tag estable

```txt id="c8a3ud"
beta-preview-v0.3.1
Commit estable
a9e6e23
Estado Git esperado
git status

Debe devolver:

nothing to commit, working tree clean
VALIDADO EN DEVICE REAL
Audio

Validado:

grabación
chunking
subida incremental
recovery
background upload
Video

Validado:

grabación
subida post-stop
export
recovery
Recovery

Validado:

reopen tras kill
subida de chunks pendientes
recuperación de cola
cierre de sesiones
retries
Upload

Validado:

Google Drive
mala red
reopen
foreground service
uploads pendientes
Export

Validado:

exportación local
limpieza posterior
apertura de evidencia
UX

Validado:

onboarding inicial
historial
configuración
placeholder NAS deshabilitado
countdown quick-start
INVARIANTES CRÍTICAS

Estas reglas NO deben romperse:

1. Subida durante grabación

La evidencia debe salir del dispositivo DURANTE la grabación.

2. Cola persistente

GC_QUEUE es fuente de verdad.

Nunca:

mover lógica crítica a UI
depender de estado React para supervivencia
3. Recovery automático

Recovery debe:

continuar uploads
cerrar sesiones
sobrevivir a reopen
4. Background upload

Foreground service Android debe:

mantener subida
mantener recovery
sobrevivir minimizado
5. Export usable

El usuario debe poder recuperar evidencia exportable.

LIMITACIÓN CONOCIDA
expo-av orphaned Audio.Recording

Ver:

docs/KNOWN_LIMITS.md

Resumen:

swipe-close durante grabación audio puede dejar recorder nativo huérfano
recovery sigue funcionando
video sigue funcionando
nueva grabación audio puede requerir force-stop manual

NO tocar recovery para intentar arreglar esto.

PROHIBIDO TOCAR DIRECTAMENTE

Sin branch temporal:

recovery
upload worker
chunkers
foreground service
startRecording
stopRecording
PROCEDIMIENTO ANTES DE DEBUGGING
Crear branch temporal
git checkout -b debug/nombre-del-problema
Verificar baseline limpio
git status
git log --oneline --decorate -n 5
Si algo se rompe

Rollback inmediato:

git reset --hard beta-preview-v0.3.1
git clean -fd
TESTS MÍNIMOS OBLIGATORIOS

Antes de considerar algo "estable":

TEST 1 — audio normal
grabar
emitir chunk
upload OK
stop OK
TEST 2 — background
minimizar app
seguir grabando
chunks continúan
TEST 3 — reopen recovery
grabar
swipe-close
reopen
recovery completa uploads
TEST 4 — export
exportar evidencia
abrir archivo exportado
TEST 5 — red mala
modo avión
reconexión
retry automático
COMANDOS IMPORTANTES
Ver baseline actual
git describe --tags
Volver al baseline estable
git fetch origin
git reset --hard beta-preview-v0.3.1
git clean -fd
Verificar sincronización
git status
git log --oneline --decorate -n 5
LECCIÓN IMPORTANTE

La estabilidad conseguida en beta vale más que fixes agresivos.

Guardian Cloud no necesita:

hacks complejos
lifecycle mágico
sobreingeniería

Necesita:

supervivencia
previsibilidad
simplicidad
rollback rápido
REGLA FINAL

Si una mejora pone en riesgo:

recovery
uploads
cola
chunking
foreground service

→ NO entra en beta.