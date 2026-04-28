# Guardian Cloud — Validation Matrix (MVP)

## Estado general

| Escenario | Resultado | Notas |
|----------|--------|------|
| 1 — Grabación corta | PASS | |
| 2 — Pérdida de conexión | ? | |
| 3 — Cierre forzado | ? | |
| 4 — Reinicio dispositivo | ? | |
| 5 — Permisos denegados | ? | |
| 6 — Drive desconectado | ? | |
| 7 — Chunk duplicado | ? | |
| 8 — Batería baja | ? | |
| 9 — Historial | ? | |
| 10 — Modo Kids | ? | |
| 11 — Chunk corrupto intermedio | PASS | AAC reproducible |
| 12 — Chunk inicial corrupto | PASS (limitación) | .bin, no reproducible |
| 13 — Sin chunks válidos | ? | |
| 14 — UI bajo fallo | PASS | UI clara |

---

## Conclusión

- El sistema:
  - ☐ cumple objetivo MVP
  - ☐ no cumple aún

- Riesgos detectados:
  - chunk 0 crítico para reproducibilidad
  - export parcial no siempre usable

- Decisión:
  - ☐ avanzar
  - ☐ bloquear y corregir