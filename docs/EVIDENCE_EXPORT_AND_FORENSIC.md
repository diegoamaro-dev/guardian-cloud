# Evidencia: exportación y uso forense

**Estado: pendiente.**

Este fichero existía con **0 bytes** desde antes de la auditoría del 2026-07-28,
que lo registró como defecto **`GC-AUD-029`**. El plan de remediación pide
repararlo en **`H-10`**, no eliminarlo; por eso se conserva como documento
mínimo en lugar de borrarse.

**No contiene todavía una especificación.** No se ha inventado ninguna: cuando
`H-10` se ejecute, este documento deberá escribirse a partir del comportamiento
real, no de intenciones.

---

## Alcance previsto

Cubrirá lo que hoy está repartido o sin escribir:

- qué garantiza y qué no garantiza un export respecto a la **integridad** de la
  evidencia;
- **cadena de custodia**: qué metadatos acompañan al artefacto exportado y qué
  se puede afirmar sobre su procedencia;
- **verificación por terceros**: cómo comprobar los hashes SHA-256 de los
  fragmentos sin la aplicación;
- límites de los **exports parciales**, incluido el caso de vídeo sin átomo
  `moov`, no reproducible;
- qué significa exactamente un veredicto de export y qué **no** demuestra sobre
  la completitud de la grabación — pendiente de `capture_end_reason`, fases
  E-1/E-2/E-3.

---

## Documentación vigente de exportación

Mientras este documento siga pendiente, las fuentes reales son:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) §5 «Evidence Export & Reconstruction» —
  el pipeline actual de export y reconstrucción
- [`CROSS_DEVICE_RECOVERY.md`](./CROSS_DEVICE_RECOVERY.md) — recuperación y
  export desde otro dispositivo
- [`UI_SCREENS.md`](./UI_SCREENS.md) — textos exactos de los veredictos de
  recovery, y qué **no** afirman
- [`PROTECTION_MODEL.md`](./PROTECTION_MODEL.md) — cuándo un fragmento está
  confirmado fuera del dispositivo
- [`KNOWN_DEBT.md`](./KNOWN_DEBT.md) — límites conocidos del export: consumo de
  memoria, exports parciales sin cabecera, ausencia de punto de entrada desde
  Home
- [`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md) — estado de validación
  vigente

---

## Contexto

**Baseline vigente:** [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md) — técnica y
reproducible, pero **`NO APTO`** para publicación.

Dos límites que condicionan cualquier afirmación forense futura:

- **el vídeo no sube evidencia durante la captura** (`GC-AUD-001`): se fragmenta
  y encola después de detenerse;
- **el recovery autónomo tras reiniciar el dispositivo (`I5c`) no está
  implementado**.
