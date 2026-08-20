# Guardian Cloud — Durable cleanup scheduler handoff

Fecha: 2026-08-20
Rama: `feat/native-segmented-recording`
Base conocida antes de los cambios locales: `6476ec270866dacf2c570cb4c4a45527b24e5217`

## Estado ejecutivo

El problema 8 queda en este estado:

- `IMPLEMENTED`
- `UNIT_TESTED`
- `HARDWARE_VALIDATION_PENDING`

La grabación nativa segmentada tuvo una validación física anterior, documentada el 2026-08-13. Esa validación precede a la integración del durable cleanup y de su scheduler; por tanto, no valida físicamente el sistema integrado descrito en este handoff.

No se debe declarar `HARDWARE_VALIDATED`, `DEVICE_VALIDATED` ni producción validada para durable cleanup/scheduler hasta superar el gate indicado al final de este documento.

## Alcance implementado

### Journal y visibilidad del runner

- La autorización de cleanup queda persistida en un journal durable después de una confirmación remota válida de completion.
- El runner sólo puede ver sesiones que tengan una entrada en ese journal.
- Una sesión sin journal continúa siendo invisible al runner, aunque existan directorios históricos o residuos locales con un identificador reconocible.
- El scheduler no amplía esa autoridad: únicamente solicita que el runner reconcilie las entradas ya autorizadas.

### Scheduler single-flight

El scheduler de cleanup implementa estas propiedades:

- Las solicitudes realizadas en el mismo tick se coalescen.
- Antes de iniciar el drenaje espera una microtarea mediante `Promise.resolve()`.
- `pending=false` se establece antes de invocar `reconcile`.
- Una solicitud recibida durante una pasada activa provoca exactamente una pasada adicional.
- Nunca existen dos pasadas de reconcile concurrentes dentro del scheduler.
- Los errores del runner quedan contenidos en el scheduler y no alcanzan el flujo de completion.
- Los motivos admitidos están cerrados a:
  - `boot`
  - `finalized`
  - `stale_reconciled`

### Triggers conectados

- `boot`: solicita cleanup de forma no bloqueante; el arranque no espera a que termine reconcile.
- `finalized`: se solicita después de un reap normal exitoso y también después de que un reap previamente diferido termine con éxito.
- `stale_reconciled`: se solicita cuando la reconciliación de sesiones stale informa al menos una sesión reconciliada.

## Completion confirmada y mantenimiento local

La frontera durable queda establecida cuando concurren:

1. backend confirma completion con una respuesta válida;
2. la autorización de cleanup queda persistida;
3. `queueMarkSessionCompleted` termina correctamente.

A partir de esa frontera, un fallo de reap o de mantenimiento local:

- no incrementa `complete_attempts`;
- no repite `completeSession`;
- no degrada la completion remota confirmada;
- no devuelve la sesión a un estado de completion fallida.

Si el primer reap falla, la entrada permanece con `session_completed=true`. En una pasada posterior, esa marca evita una nueva llamada a `completeSession`. Cuando el reap posterior termina correctamente, se retira la entrada de `GC_QUEUE` y se solicita `requestCleanup('finalized')`, sin depender del siguiente boot.

## Defectos acotados corregidos

### A. Cleanup no solicitado tras un reap posterior

Causa: la rama que procesa una entrada ya marcada con `session_completed=true` retiraba `GC_QUEUE` al completar un reap posterior, pero no solicitaba una nueva pasada de cleanup.

Corrección: después del reap exitoso en esa rama se solicita `requestCleanup('finalized')`. El trigger permanece fuera de `reapEntry`, porque esa función también participa en rutas que no implican autorización durable.

### B. Un fallo de reap incrementaba `complete_attempts`

Causa: el reap inicial se ejecutaba dentro del ámbito del `catch` exterior del flujo de completion. Aunque completion, autorización y `queueMarkSessionCompleted` ya hubieran terminado correctamente, el error local alcanzaba ese `catch`, que trataba la operación como completion fallida e intentaba incrementar `complete_attempts`.

Corrección: el fallo de reap posterior a la frontera durable se convierte en el resultado confirmado `confirmed_reap_pending`. El llamador conserva la finalización confirmada, no incrementa intentos y deja el reap para una pasada posterior.

## Ficheros de implementación locales

El estado de implementación previo a esta fase documental está contenido en:

- `mobile/app/index.tsx`
- `mobile/src/video/sessionCleanupScheduler.ts`
- `mobile/tests/cleanupTriggers.test.ts`
- `mobile/tests/sessionCleanupScheduler.test.ts`

Estos cambios eran locales y deliberados antes de crear este handoff. No deben descartarse mediante reset, restore, clean o stash.

## Validación automática disponible

Resultados registrados después de implementar los dos defectos acotados:

- Pruebas dirigidas de journal, runner, scheduler y triggers: 66/66.
- Suite completa: 360/360.
- Typecheck: exactamente 12 errores históricos conocidos y cero errores nuevos.
- `:gc-segmented-recorder:compileDebugKotlin`: `BUILD SUCCESSFUL`.
- `git diff --check`: limpio.

Las pruebas específicas demuestran que:

- las solicitudes del mismo tick se coalescen;
- una solicitud durante una pasada produce exactamente una pasada adicional;
- boot no bloquea;
- los errores del scheduler no llegan al completion flow;
- una sesión sin journal no se hace visible;
- tras completion 200, autorización y mark completed, un reap fallido no aumenta `complete_attempts`;
- la siguiente pasada no repite `completeSession`;
- el reap posterior retira `GC_QUEUE` y solicita cleanup con motivo `finalized`.

## Validación física disponible

La integración nativa segmentada fue validada físicamente el 2026-08-13 en un OnePlus 6 con Android 11. Aquella validación comprobó, entre otros resultados:

- dos capturas con 29 y 14 segmentos MP4 independientes;
- vídeo H.264 y audio AAC;
- cero segmentos perdidos;
- adopción y upload de todos los segmentos;
- integridad frente a los objetos almacenados en Drive;
- primer upload durante la captura;
- exclusividad del productor, sin `expo-camera` activo en paralelo.

Esta evidencia sólo valida la integración nativa existente en aquel momento. No incluye el journal durable, el runner y el scheduler actuales.

## Validación física pendiente

No se ha ejecutado en dispositivo la combinación actual de:

- grabación nativa segmentada;
- autorización durable de cleanup;
- journal y runner;
- scheduler single-flight;
- triggers `boot`, `finalized` y `stale_reconciled`;
- reap diferido posterior a una completion confirmada.

Por ello, el estado obligatorio sigue siendo:

`HARDWARE_VALIDATION_PENDING`

## Siguiente gate

El siguiente gate es:

**validación hardware del vídeo nativo segmentado con durable cleanup/scheduler integrado.**

Como mínimo, la validación deberá comprobar en hardware real que:

1. la captura nativa sigue generando y subiendo segmentos válidos;
2. el trigger `finalized` permite completar cleanup sin reiniciar la app;
3. boot sigue siendo no bloqueante;
4. la ruta `stale_reconciled` solicita cleanup cuando corresponde;
5. un fallo local posterior a completion confirmada no repite `completeSession` ni aumenta `complete_attempts`;
6. un reap diferido exitoso retira `GC_QUEUE` y vuelve a solicitar cleanup;
7. las sesiones o directorios sin journal permanecen fuera del alcance del runner.

El trabajo no debe declararse cerrado hasta superar y documentar este gate.

## Restricciones de continuidad

Hasta recibir autorización expresa:

- no hacer commit, push, tag ni PR;
- no modificar evidencias históricas;
- no reescribir los handoffs o informes de validación fechados el 2026-08-13 y el 2026-08-14;
- no ampliar el alcance a preview, background, `GateHarnessOptions`, reentrada o recuperación tras cinco intentos;
- no inferir validación física del scheduler a partir de la validación nativa anterior.
