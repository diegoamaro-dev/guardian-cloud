# Guardian Cloud — Test Scenarios

## Objetivo

Validar el producto bajo condiciones reales, no solo en demo feliz.

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
