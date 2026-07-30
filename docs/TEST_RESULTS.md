# TEST_RESULTS.md

> ⚠️ **Registro histórico de resultados. No es el veredicto actual.**
>
> Estas líneas son un registro de pruebas manuales anterior a la auditoría del
> 2026-07-28. **No llevan fecha, entorno, dispositivo ni build asociados**, así
> que no son reproducibles ni auditables. La auditoría comprobó que
> `VALIDATION_MATRIX.md` marca con «?» los mismos escenarios que aquí constan
> como `PASS`.
>
> **Veredicto vigente: `NO APTO`.** Existe una baseline técnica reproducible,
> [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md), pero **permanece `NO APTO` para
> publicación**.
>
> Dos límites que este documento no refleja:
> - **el vídeo no sube evidencia durante la captura** (`GC-AUD-001`): se
>   fragmenta y encola después de detenerse;
> - **el recovery autónomo tras reiniciar el dispositivo (`I5c`) no está
>   implementado**.
>
> Fuentes vigentes: [`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md) ·
> [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) ·
> [`audits/GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md`](./audits/GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md)

## Validated flows

- Happy path multi-chunk: PASS
- Kill mid-upload: PASS
- Reboot mid-upload: PASS

  > **Acotación obligatoria.** Lo que esta línea probó: con la cola persistida
  > en `GC_QUEUE`, tras reiniciar el dispositivo **y volver a abrir la
  > aplicación manualmente**, los fragmentos pendientes seguían ahí y el drenaje
  > se completó. Eso es la capacidad **`I5a`** (normalización y drenaje al
  > arrancar la app).
  >
  > **Lo que NO demuestra:** que el recovery arranque **por sí solo** después de
  > reiniciar. Eso es **`I5c`**, y **no está implementado** — no existe receptor
  > de `BOOT_COMPLETED` ni planificador de trabajo diferido. Sin abrir la app,
  > la cola no drena.
  >
  > Los logs `GC_BOOT_*` del código se refieren al **arranque de la
  > aplicación**, no al del dispositivo. Esa ambigüedad es la que permitía leer
  > esta línea como si `I5c` estuviera cubierto.

- Recovery Phase 2 with remaining chunks: PASS
- Google Drive chunk upload: PASS
- Metadata registration with remote_reference: PASS
- Session completion: PASS
- Pending state cleanup: PASS
- Local recording cleanup: PASS

## Current conclusion

Guardian Cloud now survives forced app closure and device reboot during upload, preserving pending chunks and completing recovery after restart.

> **Acotación de esta conclusión.** «Completing recovery after restart» describe
> el drenaje que ocurre **al reabrir la aplicación** (`I5a`), no un arranque
> autónomo del recovery (`I5c`, no implementado). Y «survives … during upload»
> aplica a fragmentos ya encolados: en modo vídeo no hay fragmentos encolados
> hasta después de detener la captura (`GC-AUD-001`).