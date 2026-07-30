# Guardian Cloud — Implementation Order

> ⚠️ **Plan de fases ya ejecutado en su primer tramo. No es un certificado de
> validación.** «Fase completada» describe qué se construyó, no qué quedó
> demostrado: la auditoría del 2026-07-28 retiró las afirmaciones de validación
> asociadas.
>
> **Baseline vigente: [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md)** — técnica y
> reproducible, pero **`NO APTO` para publicación**.
>
> Dos entradas de la lista de abajo necesitan matiz:
> - **«subida resiliente»** funciona durante la grabación **sólo en audio**. El
>   vídeo se fragmenta y encola tras detenerse (`GC-AUD-001`), así que todavía no
>   cumple el principio central de supervivencia;
> - **«recovery tras kill»** es correcto, pero el recovery autónomo tras
>   reiniciar el dispositivo (`I5c`) **no está implementado**: la cola drena al
>   reabrir la app (`I5a`).
>
> El orden real de trabajo pendiente está en el plan de remediación de la
> auditoría (fases A–H); la siguiente prioridad funcional es la **fase D**
> (`GC-AUD-001`).
>
> Fuentes vigentes: [`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md) ·
> [`audits/GUARDIAN_CLOUD_REMEDIATION_PLAN_2026-07-28.md`](./audits/GUARDIAN_CLOUD_REMEDIATION_PLAN_2026-07-28.md) ·
> [`DEVELOPMENT_WORKFLOW.md`](./DEVELOPMENT_WORKFLOW.md)

## Fase completada (MVP Core)

* backend mínimo
* sesiones
* chunking
* cola persistente
* subida resiliente
* recovery tras kill
* subida en background
* integración con Drive
* export básico

---

## Fase actual (Consolidación)

* botón pánico
* UX bajo estrés
* export robusto
* test con usuarios reales

---

## Siguiente fase

* historial usable
* modo kids (alertas)
* metadata básica

---

## Fase futura

* múltiples destinos
* redundancia
* integridad avanzada
* modo forense

---

## Regla

> no avanzar de fase sin validación real
