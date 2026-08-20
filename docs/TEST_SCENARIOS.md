# Guardian Cloud — Test Scenarios

## Objetivo

Validar el producto bajo condiciones reales, no solo en demo feliz.

## Estado de validación vigente

* La grabación nativa segmentada, la **subida de vídeo durante la captura** y
  el durable cleanup/scheduler en su ruta normal están `HARDWARE_VALIDATED`
  desde el 20/08 en OnePlus A6000 / Android 11 / API 30 / `arm64-v8a`. Alcance
  y métricas exactas en la
  [validación del 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md).
* También está `HARDWARE_VALIDATED` el recovery real de una sesión pendiente
  tras restaurar la autorización de Drive.
* Validación automática actual: 360/360 tests; 12 errores TypeScript
  históricos y cero nuevos; Kotlin
  `:gc-segmented-recorder:compileDebugKotlin` con `BUILD SUCCESSFUL`;
  `git diff --check` limpio.
* **No** se declaran validados: recovery completo de vídeo, export final
  `.mp4`, cobertura multi-dispositivo, Android 13+ ni las rutas artificiales de
  fallo del scheduler.

* La **frontera de borrado exclusiva por journal** está `HARDWARE_VALIDATED`
  desde el 20/08 por prueba dirigida con directorios centinela.

**No queda ningún gate bloqueante del Escenario 17 antes de integrar la rama.**
Los puntos 5–8 siguen en `HARDWARE_HARDENING_PENDING` y no bloquean.

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

Estado por punto tras la
[validación del 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md),
ejecutada sobre el commit `07e4284` en OnePlus A6000 / Android 11 / API 30 /
`arm64-v8a`:

| # | Punto | Estado |
|---|---|---|
| 1 | iniciar y finalizar una captura nativa segmentada | `HARDWARE_VALIDATED` |
| 2 | producir, adoptar y **subir** segmentos MP4 válidos **durante** la captura | `HARDWARE_VALIDATED` |
| 3 | confirmar completion y autorización durable | `HARDWARE_VALIDATED` |
| 4 | `finalized` retira `GC_QUEUE` y ejecuta cleanup sin reiniciar la app | `HARDWARE_VALIDATED` |
| 5 | boot no bloqueante **con trabajo durable real** | `HARDWARE_HARDENING_PENDING` |
| 6 | provocar una reconciliación stale y comprobar el trigger `stale_reconciled` | `HARDWARE_HARDENING_PENDING` |
| 7 | fallo de reap posterior a completion confirmada, sin aumentar `complete_attempts` ni repetir `completeSession` | `HARDWARE_HARDENING_PENDING` |
| 8 | reap posterior exitoso que retira `GC_QUEUE` y vuelve a solicitar `requestCleanup('finalized')` | `HARDWARE_HARDENING_PENDING` |
| 9 | una sesión o directorio **sin journal** permanece invisible al runner | `HARDWARE_VALIDATED` |

Evidencia decisiva del punto 2: primera subida confirmada a `+14,619 s` frente a
un PARAR en `+75,514 s` —margen de `60,895 s`— con **11 de 12 chunks confirmados
antes de detener la captura**.

Sobre el punto 5: se observó dos veces `GC_CLEANUP_REQUESTED {reason:"boot"}` sin
que el arranque se bloqueara, pero en ambas el journal estaba sin candidatos, así
que la no-bloqueancia no llegó a someterse a esfuerzo real.

Sobre el punto 6: sólo está validado el **caso negativo**. La reconciliación
stale consultó al backend, obtuvo `backend_uploaded: 0` frente a `expected: 12`,
se negó a segar la sesión y, con `reconciled: 0`, no disparó el trigger — que es
el comportamiento correcto. Falta el caso positivo.

Sobre el punto 9: cerrado con **prueba dirigida**. Se colocaron dos directorios
centinela con UUID canónico v4 y un `seg_000.mp4` dentro, sin entrada en el
journal, verificando por lectura lógica de SQLite —no por coincidencia binaria—
que ni `GC_QUEUE` ni el journal contenían nada. Una captura corta generó después
una sesión realmente autorizada, y en esa misma pasada:

- `GC_CLEANUP_RECONCILE_DONE {considered: 1}` — de tres directorios de
  apariencia idéntica, el runner consideró **uno**;
- la sesión autorizada fue eliminada de ambos recursos;
- los dos centinelas quedaron **byte-identical**, mismo nombre, tamaño y
  SHA-256;
- cero eventos de cleanup para el prefijo centinela;
- los 4 + 12 históricos, intactos.

Eso demuestra discriminación activa, no ausencia de ejecución. Como contraste
registrado, un arranque previo con journal vacío emitió `GC_CLEANUP_REQUESTED`
con **cero** `RECONCILE_START`: sin candidatos el runner retorna antes de
enumerar.

Resultado esperado:

> La captura nativa sigue protegiendo segmentos durante la grabación y el
> durable cleanup integrado converge sin degradar ni repetir una completion
> remota confirmada.

Cumplido en la ruta normal, y con la frontera de borrado cerrada por prueba
dirigida. Los puntos 5–8 no bloquean el principio crítico de producto ni la
integración de la rama: su peor caso es limpieza diferida, no pérdida de
evidencia.

Registrar commit exacto, dispositivo, versión Android, resultados observables y
evidencias antes de cambiar cualquiera de estos estados.