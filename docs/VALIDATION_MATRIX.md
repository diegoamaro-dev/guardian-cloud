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
| 17 — Vídeo nativo con durable cleanup/scheduler | **PASS** | Puntos 1–4 y 9 `HARDWARE_VALIDATED` el 20/08; puntos 5–8 `HARDWARE_HARDENING_PENDING`, sin bloquear la integración. Ningún gate bloqueante pendiente |

Los escenarios marcados con «?» no han sido reejecutados con el artefacto
vigente. El 17 es el único con evidencia física fechada y trazable: ver la
[validación del 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md).

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