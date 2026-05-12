## Guardian Cloud — Known Technical Limits

Este documento registra límites técnicos REALES ya observados y validados en producción/beta.

Objetivo:
- evitar repetir debugging circular,
- proteger invariantes críticas,
- documentar límites de librerías/frameworks,
- impedir fixes peligrosos sobre recovery/upload pipeline.

---

# 1. expo-av orphaned Audio.Recording after swipe-close

## Estado

VALIDADO EN DEVICE REAL.

No es hipótesis.

---

## Escenario exacto

1. Usuario inicia grabación audio.
2. Audio.Recording queda activo con:
   - `staysActiveInBackground=true`
   - foreground service activo
3. Usuario hace swipe-close desde recientes SIN pulsar PARAR.
4. JS context muere.
5. `recordingRef.current` se pierde.
6. El recorder nativo puede seguir vivo internamente.
7. Recovery sube correctamente los chunks pendientes.
8. La sesión se completa correctamente.
9. Nueva grabación audio falla con:

```txt
Only one Recording object can be prepared at a given time.

Video sigue funcionando.

Causa real

expo-av NO expone API pública para liberar un Audio.Recording
cuando el objeto JS original ya no existe.

Las APIs siguientes NO solucionan el problema:

Audio.setIsEnabledAsync(false)
Audio.setAudioModeAsync(...)

Solo afectan futuras operaciones.

NO destruyen el recorder huérfano.

Lo importante

El problema NO es:

GC_QUEUE
recovery
upload worker
chunking
foreground upload
Drive upload
session completion

Todo eso funciona correctamente.

El límite está en la implementación interna de expo-av.

Recovery NO debe modificarse

El recovery actual es correcto:

reabre cola
resetea chunks stuck uploading
finaliza sesiones pendientes
sube chunks restantes
completa sesión

Modificar recovery intentando "matar" el recorder rompió:

subida
quick start
flujo de audio
estabilidad general
Decisión estratégica

NO intentar hacks agresivos sobre expo-av.

NO:

resets múltiples
stop en AppState background
destruir audio subsystem repetidamente
inventar locks artificiales
tocar recovery para arreglar audio huérfano

Eso rompe invariantes críticas.

Invariantes protegidas

Estas prioridades son MÁS IMPORTANTES que reiniciar audio:

evidencia subida
recovery funcional
cola persistente
chunking estable
export usable
Comportamiento aceptado actualmente

Si ocurre swipe-close durante grabación audio:

recovery debe sobrevivir
chunks deben subirse
sesión debe completarse

Aunque:

siguiente grabación audio pueda requerir force-stop manual

Esto es preferible a romper recovery global.

Video

Video NO comparte este límite exacto.

expo-camera usa pipeline distinta.

Durante las pruebas:

video siguió funcionando
recovery siguió funcionando
Lecciones aprendidas

Error cometido:

intentar arreglar un límite estructural de librería
desde lógica JS/recovery.

Consecuencia:

se introdujeron regressions
aparecieron estados inconsistentes
chunks "fantasma"
quick-start roto
riesgo real sobre supervivencia
Regla futura

Si recovery funciona:
→ NO tocar recovery de noche.

Primero:

logs
aislamiento
reproducibilidad

Después:

fix mínimo

Nunca:

múltiples fixes simultáneos sobre start/stop/recovery/chunker.
Solución real futura

La solución REAL requiere:

Opción A — migración a expo-audio

o

Opción B — módulo nativo custom

Probablemente:

Kotlin/Java Android
control explícito del recorder lifecycle
foreground service integrado
ownership nativo del audio pipeline
Estado oficial actual

ACEPTADO COMO KNOWN LIMITATION.

NO bloquear release beta por esto.

El producto sigue cumpliendo:

supervivencia de evidencia
subida en background
recovery
export
persistencia

Que son las invariantes reales del sistema.