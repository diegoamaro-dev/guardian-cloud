# Guardian Cloud — Test Scenarios

## Objetivo

Validar el producto bajo condiciones reales, no solo en demo feliz.

## Estado de validación vigente

* La grabación nativa segmentada y la subida durante captura fueron validadas
  físicamente el 13/08 en el alcance del
  [informe de integración](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_INTEGRATION_VALIDATION_2026-08-13.md).
* El durable cleanup/scheduler está
  `IMPLEMENTED / UNIT_TESTED / HARDWARE_VALIDATION_PENDING`.
* Validación automática actual: 360/360 tests; 12 errores TypeScript
  históricos y cero nuevos; Kotlin
  `:gc-segmented-recorder:compileDebugKotlin` con `BUILD SUCCESSFUL`;
  `git diff --check` limpio.
* No se declara físicamente validado el scheduler, el recovery completo de
  vídeo ni un export final `.mp4`.

El siguiente gate es la **validación hardware del vídeo nativo segmentado con
durable cleanup/scheduler integrado**. El
[handoff vigente](./audits/GUARDIAN_CLOUD_DURABLE_CLEANUP_SCHEDULER_HANDOFF_2026-08-20.md)
define su alcance y debe prevalecer para esta fase.

## Escenario 1 — Grabación corta
- iniciar grabación
- esperar 10 segundos
- verificar supervivencia de al menos un fragmento

## Escenario 2 — Pérdida de conexión
- grabar
- cortar red
- seguir grabando
- restaurar red
- verificar reintento y subida

## Escenario 3 — Cierre forzado
- grabar
- cerrar app de golpe
- reabrir
- verificar recuperación de cola

## Escenario 4 — Reinicio del dispositivo
- grabar
- dejar pendientes
- reiniciar
- reabrir
- verificar persistencia

## Escenario 5 — Permisos denegados
- denegar cámara o micro
- comprobar mensaje claro y controlado

## Escenario 6 — Drive desconectado
- iniciar flujo sin destino válido
- verificar error explicable

## Escenario 7 — Chunk duplicado
- reenviar chunk
- verificar idempotencia o manejo consistente

## Escenario 8 — Batería baja
- simular energía reducida
- validar que no se corrompe la sesión

## Escenario 9 — Historial
- finalizar sesión
- comprobar visibilidad en historial
- comprobar estado correcto

## Escenario 10 — Modo Kids
- activar desde perfil vinculado
- generar alerta al padre
- comprobar lenguaje no alarmista

## Escenario 11 — Chunk corrupto (intermedio)

- exportar una sesión válida
- simular corrupción de un chunk intermedio (ej: index 2)
- verificar:
  - el hash no coincide
  - el chunk se marca como corrupto
  - NO se concatena
  - el export devuelve estado parcial
  - el archivo resultante sigue siendo reproducible (AAC)

Resultado esperado:
> la evidencia parcial sigue siendo utilizable aunque falte un fragmento
## Escenario 12 — Chunk inicial corrupto

- exportar una sesión válida
- simular corrupción del chunk 0
- verificar:
  - el chunk 0 se marca como corrupto
  - NO se concatena
  - el export devuelve estado parcial
  - el archivo generado NO es reproducible como AAC
  - se genera archivo técnico (.bin)

Resultado esperado:
> el sistema detecta correctamente la corrupción pero no puede reconstruir un archivo reproducible

Nota:
> limitación actual del formato: sin el primer chunk, el stream AAC puede no ser interpretable

## Escenario 13 — Export sin chunks válidos

- simular que todos los chunks fallan o están corruptos
- ejecutar export

verificar:
- no se genera archivo útil
- estado = error
- mensaje claro al usuario

Resultado esperado:
> el sistema no devuelve basura como si fuera válida
## Escenario 14 — UI de export bajo fallo

- provocar:
  - chunk corrupto intermedio
  - chunk inicial corrupto

verificar:
- el número de chunks corruptos es correcto
- los índices afectados se muestran claramente
- si el chunk 0 está afectado:
  - se muestra advertencia clara
- si el archivo es .bin:
  - se informa como archivo técnico no confirmado

Resultado esperado:
> el usuario entiende exactamente qué ha pasado sin ambigüedades
## Criterio final

Si pasa en demo pero falla con cierres, mala red o estrés, no está listo.

## Escenario 15 — Uso bajo estrés (crítico)

* dar la app a un usuario sin explicación
* pedirle:
  "imagina que pasa algo raro, usa la app"

verificar:

* tiempo de reacción
* dudas
* errores de uso
* claridad del estado

resultado esperado:

> el usuario es capaz de grabar sin instrucciones

---

## Escenario 16 — Recuperación por usuario

* el usuario graba una sesión
* después se le pide:
  "recupera la evidencia"

verificar:

* encuentra la sesión
* entiende el estado
* exporta sin ayuda

resultado esperado:

> el usuario puede usar el sistema completo sin asistencia

Añadir:

Esperado:
- sesión visible
- fecha correcta
- icono correcto
- estado Protegido

---

### Caso 2 — Recovery A → B

1. móvil A graba
2. móvil B inicia sesión
3. conectar mismo Drive
4. abrir recovery
5. reconstruir

Esperado:
- archivo reproducible
- save/share operativo

---

### Caso 3 — Partial recovery

1. borrar chunk manualmente en Drive
2. ejecutar recovery

Esperado:
- estado Protección parcial
- archivo truncado
- save/share habilitado

---

### Caso 4 — Manifest missing

1. borrar manifest
2. abrir recovery detail

Esperado:
- error claro
- no crash

---

### Caso 5 — Export regression

1. grabar sesión normal
2. exportar desde History

Esperado:
- mismo comportamiento previo
- mismo filename
- mismo pipeline

---

### Caso 6 — Drive disconnected

1. desconectar Drive
2. abrir recovery

Esperado:
- drive_not_connected
- CTA a configuración

---

### Caso 7 — Save/share

1. recovery completo
2. guardar en dispositivo
3. compartir

Esperado:
- archivo accesible
- Android SAF operativo
- share sheet operativo

---

## Escenario 17 — Vídeo nativo con durable cleanup/scheduler integrado

Estado: `HARDWARE_VALIDATION_PENDING`.

Este escenario no se considera superado por la validación física del 13/08,
porque journal, runner y scheduler todavía no estaban integrados.

En hardware real:

1. iniciar y finalizar una captura nativa segmentada;
2. comprobar que se producen, adoptan y suben segmentos MP4 válidos durante la
   captura;
3. confirmar completion y autorización durable;
4. comprobar que `finalized` permite retirar `GC_QUEUE` y ejecutar cleanup
   sin reiniciar la app;
5. comprobar que boot sigue siendo no bloqueante;
6. provocar una reconciliación stale y comprobar el trigger
   `stale_reconciled`;
7. reproducir un fallo de reap posterior a completion confirmada y comprobar
   que no aumenta `complete_attempts` ni se repite `completeSession`;
8. permitir un reap posterior exitoso y comprobar que retira `GC_QUEUE` y
   solicita `requestCleanup('finalized')`;
9. comprobar que una sesión o directorio sin journal permanece invisible al
   runner.

Resultado esperado:

> La captura nativa sigue protegiendo segmentos durante la grabación y el
> durable cleanup integrado converge sin degradar ni repetir una completion
> remota confirmada.

Registrar commit exacto, dispositivo, versión Android, resultados observables y
evidencias antes de cambiar el estado de
`HARDWARE_VALIDATION_PENDING`.