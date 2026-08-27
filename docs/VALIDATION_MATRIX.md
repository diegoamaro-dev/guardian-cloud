> ⚠️ **Documento histórico. No es el estado de validación vigente.**
>
> Fotografía de la matriz de escenarios tal como estaba el **2026-08-20**
> (`6990fb6`). No se mantiene: sus `?`, sus `PASS` y su bloque «Conclusión»
> describen aquel corte y no deben interpretarse como el estado actual.
>
> Los `PASS` conservados en esta matriz no incluyen por sí mismos fecha,
> dispositivo ni artefacto de evidencia asociado. La auditoría del
> 2026-07-28 ya documentó problemas de desalineación entre esta matriz y
> otros registros del proyecto.
>
> **Fuentes vigentes:**
> - [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) — estado por
>   capacidad y referencia canónica;
> - [`TEST_SCENARIOS.md`](./TEST_SCENARIOS.md) — definición vigente de
>   escenarios;
> - `docs/VALIDATIONS/` — registros de validación fechados y evidencia
>   asociada;
> - [`START_HERE.md`](./START_HERE.md) — estado general y veredicto de
>   release.
>
> Este fichero se conserva para mantener la trazabilidad histórica de
> auditorías que lo citaron.

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