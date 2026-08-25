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

Límites que condicionan cualquier afirmación forense futura:

- **el recovery autónomo tras reiniciar el dispositivo (`I5c`) no está
  implementado**;
- **no existe export final `.mp4`**: una sesión de vídeo sube fragmentos
  verificables, pero no hay reconstrucción utilizable como pieza única;
- **el cifrado local no está implementado**.

> **Salvage local de segmentos (D3), desde el 2026-08-24.** Existe una salida
> local para el vídeo nativo segmentado que quedó sin poder subir: copia los
> **segmentos MP4 originales** del sandbox a una carpeta elegida por el usuario,
> con `sha256` verificado en destino y un manifest releído y validado.
> `HARDWARE FUNCTIONAL PASS` en OnePlus A6000 el 24/08.
>
> **No cambia el límite de arriba.** Los segmentos son piezas independientes, no
> una reconstrucción: el export final `.mp4` sigue sin existir. Forense y
> pericialmente, lo que D3 entrega es **un conjunto de MP4 con su manifest de
> integridad**, no una grabación única, y así debe describirse. D3 tampoco toca
> la ruta de audio/legacy, que ya tenía su propia salida local por
> `findLocalRecordingUri` y **no ha sido modificada**.
>
> Alcance y evidencia en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5.

> **Las dos copias coexisten, y conviene saberlo antes de peritar.** Un segundo
> gate del 2026-08-24 —`POST-SALVAGE NETWORK RECOVERY`, `PASS`— demostró en
> hardware que, si la conectividad vuelve después del salvage, la misma sesión
> se registra, sube sus fragmentos y completa con normalidad. Al terminar
> conviven **dos artefactos independientes**: la evidencia remota subida por el
> pipeline, y el export SAF en poder del usuario. El cleanup borró las fuentes
> del sandbox **sin tocar** el export SAF, que es almacenamiento distinto y cae
> fuera del journal de limpieza.
>
> Para un peritaje eso significa que ambos deben poder cotejarse, y que **el
> export SAF no es una copia derivada de lo subido**: son los mismos bytes de
> origen, verificados por `sha256` por dos caminos distintos.

`GC-AUD-001` —el vídeo no subía durante la captura— **ya no es un límite
vigente**: la ruta nativa segmentada sube durante la grabación y quedó
demostrado en hardware el 20/08. Ver la
[validación del 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md).
