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

## Criterio final

Si pasa en demo pero falla con cierres, mala red o estrés, no está listo.