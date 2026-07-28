# Guardian Cloud — Plan de remediación (adjudicado)

**Fecha:** 2026-07-28 · **Base:** [`GUARDIAN_CLOUD_FULL_AUDIT_2026-07-28.md`](./GUARDIAN_CLOUD_FULL_AUDIT_2026-07-28.md) · **Matriz:** [`GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md`](./GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md)

**Veredicto vigente: NO APTO.**

---

## Decisiones vinculantes que gobiernan este plan

Una versión anterior de este plan proponía contener el modo vídeo y diferir la captura en vivo a `v1.1`. **Esa propuesta queda retirada.** Rigen estas decisiones:

1. **v0.3 incluye audio y vídeo.**
2. **Ambos modos deben sacar evidencia del dispositivo DURANTE la grabación.**
3. **Ocultar el vídeo es contención temporal; NO hace liberable v0.3.**
4. **Vídeo post-stop con aviso NO es remediación aceptable.**
5. **La captura segmentada de vídeo en vivo es causa raíz P0.**
6. **Se introduce un productor de captura segmentada.** **No se crea un segundo pipeline de subida:** `GC_QUEUE`, worker y retry **se reutilizan**. El spike determina si el vídeo exige cambios **mínimos y compatibles** en la capa multimedia (metadata de segmento, códec/contenedor, timestamps, segmento de inicialización, manifest, export/muxing). Adaptar la capa multimedia es aceptable; duplicar el transporte no lo es.
7. **La promesa de 10 s queda condicionada a conectividad suficiente** y al resto de precondiciones operativas (backend operativo, destino conectado, credenciales válidas), con comportamiento offline definido. El perfil concreto es **hipótesis inicial de prueba**, no contrato demostrado: se fija tras medir el primer fragmento real.
8. **`completed_at` no es prueba de captura completa.** Se separan cuatro dimensiones y se exige `capture_end_reason`.
9. **Una sesión interrumpida nunca es «Protegido correctamente»** por tener subidos todos los chunks *conocidos*.
10. **`scanOrphans` sobre `cacheDirectory` es mitigación**, no garantía de recuperar un MP4 interrumpido.
11. **El tope de 70 s deja de ser solución principal**; sólo contención mientras el vídeo esté oculto.
12. **El foreground service se divide en cinco cambios independientes (F-1…F-5)**, con el tipo correspondiendo al trabajo real: `microphone` (audio), `camera`+`microphone` (vídeo con audio), `dataSync` o mecanismo compatible (subida). Permisos concedidos antes de arrancar el servicio. **Sin arrancar `camera`, `microphone` ni `dataSync` desde `BOOT_COMPLETED` en Android 15**; el recovery tras reinicio usa un mecanismo permitido. **No se asume un único servicio con todos los tipos: el spike decide los límites.**
13. **OAuth se replantea:** canje en el callback HTTPS del backend, `state` verificado y ligado al usuario, código fuera de `guardiancloud://`.
14. **Correcciones de IDs y recuentos aplicadas** (§7bis del informe).
15. **Los resultados bajo Node 24 son evidencia válida** (`node >=20` incluye 24). Deben **repetirse bajo la versión exacta del runtime de producción** para establecer paridad y baseline de remediación. **Los fallos actuales no se atribuyen a la versión de Node.**

**Estimaciones:** S = cambio localizado · M = varios ficheros o una decisión de producto · L = trabajo de proyecto. Sin horas: no las conozco.

**Regla transversal** (`DEBUGGING_RULES.md:64-76`, `BETA_STABLE_BASELINE.md:131-140`): un cambio, una capa, suite verde antes y después. Varias acciones tocan `startRecording`/`stopRecording`/recovery, explícitamente protegidos. No se agrupan en un commit.

---

# Orden de ejecución

Las fases son secuenciales salvo donde se indique.

```
A. Contención y verdad de producto
B. Baseline verde bajo el runtime de producción
C. Spike aislado de captura segmentada de vídeo
D. Integración del productor con GC_QUEUE existente
E. Semántica de captura interrumpida y recovery
F. Android, OAuth, firma, NAS y seguridad de release   ← solape PARCIAL (ver tabla)
G. Validación física en build release con Metro apagado
H. Actualización documental posterior a evidencia real
```

**Solape de F — sólo las tareas sin conflicto de ficheros.** La versión anterior decía «F puede solaparse con C/D/E» sin más; es incorrecto, porque parte de F toca exactamente los mismos ficheros que el pipeline de captura.

| Tareas F | ¿Solape con C/D/E? | Motivo |
|---|---|---|
| **F-1 … F-5** (foreground service) | **NO — secuenciar** | Tocan `startRecording` y el ciclo de vida de captura, los mismos puntos que D-1/D-2 |
| **F-20** (extraer el worker) y **F-21** (head-of-line) | **NO — secuenciar** | Mueven y modifican `uploadDrainLoop`, que D usa como destino de los fragmentos nuevos |
| **F-6 … F-19** (OAuth, firma, NAS, timeouts, logs, permisos, backup, `targetSdk`) | **Sí** | Backend, configuración Android y ficheros que el pipeline de captura no toca |

Por qué este orden: **A** deja de mentir hoy, sin esperar a nada. **B** es el instrumento de medida — sin él no se puede saber si C/D/E rompen algo. **C** aísla la única incógnita técnica real antes de tocar código protegido. **D** integra sin duplicar pipeline. **E** arregla la semántica que C/D dejan al descubierto. **G** mide el sistema ya estabilizado, no uno que va a cambiar. **H** documenta lo que se demostró, no lo que se espera.

---

# FASE A — Contención y verdad de producto

**Objetivo:** que el sistema deje de afirmar falsedades **hoy**, antes de cualquier trabajo de fondo. Ninguna acción de esta fase hace liberable v0.3.

| # | Acción | Hallazgo | Cambio mínimo | Archivos | Aceptación | Regresión | Est. |
|---|---|---|---|---|---|---|---|
| **A-0** | **Aviso de estado en la documentación de entrada** | GC-AUD-018 | Antes de programar nada: bloque breve al principio de `docs/START_HERE.md` y `docs/IMPLEMENTATION_STATUS.md` — «**NO APTO** — auditoría 2026-07-28; validación anterior retirada; vídeo no protege durante la grabación», enlazando los tres informes | `docs/START_HERE.md`, `docs/IMPLEMENTATION_STATUS.md` | Quien abra el proyecto ve el estado real antes de leer afirmaciones de validación sin respaldo | Ninguna — sólo documentación | S |
| **A-1** | El recovery deja de mentir | GC-AUD-033 | `verdictFor` deja de decidir sólo con `result.status` y **nombra los dos hechos por separado**: interrumpida + ≥1 remoto ⇒ «Hay evidencia protegida fuera del dispositivo; la grabación está incompleta»; interrumpida + 0 remotos ⇒ «Grabación incompleta; nada protegido fuera del dispositivo». **Sin regla general «interrupted_* ⇒ parcial»** y **sin usar `completed_at` como prueba de captura completa** | `mobile/app/recover/[id].tsx:225-251` | Un manifest sin cierre limpio con el 100 % de chunks conocidos verificados **no** rinde «Protegido», **y tampoco se presenta como pérdida total** | Muy baja — pantalla de detalle, sin tocar cola/worker/export | S |
| **A-2** | La UI deja de mentir durante la grabación | GC-AUD-004 | **Regla única, idéntica en ambos modos:** afirmar protección **sólo** cuando `uploadedCount > 0`; en caso contrario, «Todavía no protegido fuera del dispositivo». Con `uploadedCount > 0`, «N/M protegidos». `deriveGuardianStatus` ya recibe `uploadedCount`/`totalCount` | `mobile/src/recording/deriveGuardianStatus.ts`, `mobile/app/index.tsx:1582-1598` | La condición **no ramifica por modo**. Audio y vídeo con `uploadedCount = 0` producen el mismo texto. Tests ampliados con ambos modos | Baja — función pura ya testeada | S |
| **A-3** | Ocultar el modo vídeo (contención) | GC-AUD-001 | Retirar `ModeToggle` de Home; `mode` fijado a `'audio'` | `mobile/app/index.tsx:7322`, `:3556` | El modo vídeo no es alcanzable | Baja — el camino de audio no se toca | S |
| **A-4** | Tope de vídeo alineado (contención, sólo mientras A-3 esté vigente) | GC-AUD-003 | Alinear `VIDEO_MAX_DURATION_S` con `VIDEO_MAX_SIZE_BYTES` para que el camino post-stop nunca produzca cero chunks | `mobile/app/index.tsx:357` | `VIDEO_TOO_LARGE_FOR_MVP` inalcanzable por uso normal | Baja | S |
| **A-5** | No completar sesiones de cero chunks | GC-AUD-002 | En `tryFinalizeReadySessions`, no llamar a `completeSession` si `expectedChunks === 0` | `mobile/app/index.tsx:2279-2467` | Kill durante grabación → **no** aparece `GC_QUEUE session completed`. Caso nuevo en `finalize.test.ts` | **Media** — toca la puerta de finalización, protegida y con 19 tests | S |
| **A-6** | Mapear `DRIVE_NOT_CONNECTED` | GC-AUD-019 | Entrada con `recoverable: false` y CTA a Configuración | `mobile/src/errors/humanError.ts` | Con Drive desconectado no aparece «Reintentar» | Ninguna | S |
| **A-7** | Copy contradictorio del export | GC-AUD-042 | Condicionar los párrafos a `verdict.integrity` | `mobile/app/session/[id].tsx:1650-1652`, `:1748-1756` | «Evidencia dañada» nunca convive con «es íntegra» | Ninguna | S |

> **A-3 y A-4 son andamiaje.** Se retiran en la fase D, cuando el vídeo pase a subir en vivo. Dejarlas puestas y declarar la release lista sería exactamente lo que la decisión 3 prohíbe.

---

# FASE B — Baseline verde bajo el runtime de producción

**Objetivo:** disponer de un instrumento de medida fiable **en paridad con producción**. Sin esto no se puede afirmar que C/D/E no rompen nada.

> **Precisión sobre Node.** Los resultados de la auditoría se obtuvieron bajo **Node v24.11.1**, versión que **satisface** el `node >=20` de `backend/package.json:8`: son evidencia válida, no un dato a descartar. Lo que falta es **paridad con el runtime de producción**. Y los 4 fallos de backend **no se atribuyen a la versión**: tres son diferencias de aserción de contrato y el cuarto un mock incompleto.

| # | Acción | Hallazgo | Cambio mínimo | Aceptación | Est. |
|---|---|---|---|---|---|
| **B-0** | **Determinar la versión exacta del runtime de producción** | decisión 15 | Comprobar qué Node ejecuta realmente el backend desplegado. Si no está fijada, fijarla | Versión de producción documentada y fijada | S |
| **B-1** | **Re-ejecutar todo bajo esa versión** | decisión 15 | Repetir `tsc --noEmit` y `vitest run` en `mobile/` y `backend/` bajo el runtime de B-0 | Cifras registradas y **comparadas con las de Node 24**; cualquier divergencia documentada como hallazgo nuevo | S |
| **B-2** | `tsc --noEmit` limpio en mobile | GC-AUD-011 | Resolver en un punto el desajuste `Uint8Array<ArrayBufferLike>` → `BufferSource` y los tipos de plugin de `app.config.ts` | Sin salida. **Sin tocar el runtime** de `Crypto.digest` ni de `fetch` | S |
| **B-3** | Suite de backend en verde | GC-AUD-007 | (a) exportar `CONFIGURED_ISSUER` en el mock de `jwtVerifier.js`; (b) alinear las tres aserciones de contrato (200/201, `status:'active'`); (c) **test directo de `verifySupabaseJwt` sin mock** | 0 fallos, 0 unhandled errors. El test nuevo falla si se quita `issuer` o la lista blanca de `alg` | M |
| **B-4** | `npm audit` | §4 del informe | Ejecutar donde haya `npm` (aquí no lo había) | Informe de vulnerabilidades registrado | S |
| **B-5** | Configurar lint | §6 del informe | No existe script de lint en ningún `package.json` | `npm run lint` existe y pasa | S |

---

# FASE C — Spike aislado de captura segmentada de vídeo

**Objetivo:** resolver la **única incógnita técnica real** de todo el plan sin tocar una línea de código protegido.

**Regla de la fase:** el spike vive fuera del camino de producción. No modifica `startRecording`, ni `stopRecording`, ni `GC_QUEUE`, ni el worker, ni el recovery. Su salida es un **productor** que cumple el contrato `ChunkProducer` ya existente (`mobile/src/recording/chunkProducer.ts`), **más una decisión documentada sobre qué cambios mínimos exige la capa multimedia**.

**Alternativas a evaluar** (el spike decide con datos, no por preferencia):
- segmentación nativa del `MediaRecorder` con rotación de fichero por intervalo;
- rotación de `recordAsync` en el nivel de `expo-camera`;
- formato fragmentado que permita leer prefijos válidos;
- módulo nativo propio, si ninguna de las anteriores sostiene la invariante.

**Preguntas de diseño que el spike debe cerrar** (ver GC-AUD-001 en el informe): metadata de segmento · códec y contenedor · timestamps y duración · segmento de inicialización · manifest · export/muxing. Los cambios que resulten deben ser **mínimos, compatibles hacia atrás con las sesiones de audio existentes y justificados por medición**.

## Perfil de red — hipótesis inicial, no contrato

El perfil de §3bis del informe (**≥1 Mbit/s de subida sostenida, RTT ≤300 ms**) es una **hipótesis de partida para poder empezar a medir**, no una condición demostrada. Junto a la red, la promesa exige estas precondiciones operativas, que deben registrarse en cada ejecución:

- backend operativo y alcanzable;
- destino (Drive/NAS) conectado;
- credenciales válidas y no caducadas.

**El perfil definitivo se fija después de medir el primer fragmento real**, en función del tamaño de segmento que el spike acabe eligiendo. Publicar hoy un umbral como si estuviera validado repetiría el patrón que esta auditoría reprocha al proyecto.

## Pruebas de aceptación del spike — observables y falsables

Ninguna se da por buena por lectura de código. **Todas se miden en dispositivo real**, en build release, registrando perfil de red y precondiciones.

| # | Prueba | Criterio de aceptación | Cómo se observa |
|---|---|---|---|
| **C-AC1** | **Primer fragmento durable remoto < 10 s** | Bajo el perfil de prueba, el destino confirma ≥1 fragmento de vídeo **antes de los 10 s**. **El cronómetro arranca en el instante en que el usuario pulsa GRABAR y se detiene con la confirmación remota** — no antes | Cronómetro principal: **tap en GRABAR → confirmación remota del `chunk_index 0`**, contrastado contra el fichero presente en Drive. `GC_PERF_UI_RECORDING_VISIBLE` se conserva como **marca intermedia de diagnóstico** (permite separar latencia de arranque de latencia de subida), **nunca como inicio de la medición** |
| **C-AC2** | **Kill a 10 / 20 / 60 / 90 s** | En los cuatro cortes queda **evidencia remota utilizable**: reconstruible y **reproducible** hasta el punto de corte | Matar el proceso en cada marca; exportar desde otro dispositivo; **abrir el fichero en un reproductor real** |
| **C-AC3** | **Orden e integridad verificables** | Los fragmentos se reconstruyen en orden y cada uno supera la verificación SHA-256 contra el hash registrado | Export normal + export de recovery; sin `GC_EXPORT_HASH_MISMATCH` |
| **C-AC4** | **Sin huecos temporales silenciosos** | Ningún tramo de la captura se pierde entre segmentos. Un hueco debe ser **detectable y señalizado**, nunca silencioso | Grabar una fuente con marca temporal continua (cronómetro en pantalla + tono); verificar continuidad en el fichero reconstruido |
| **C-AC5** | **Export sin el dispositivo original** | La sesión se reconstruye desde otro dispositivo con la misma cuenta y el mismo destino | Reinstalar en dispositivo B; recovery cross-device; reproducir |
| **C-AC6** | **Cero regresión del pipeline de audio** | El camino de audio se comporta igual antes y después: mismos tiempos, misma cola, mismo recovery, misma suite verde | Suite completa bajo el runtime de referencia + una sesión de audio medida antes y después |
| **C-AC7** | **Segmentos reproducibles o muxing probado** | O bien cada segmento es independientemente reproducible, o bien existe un mecanismo de reconstrucción/muxing **probado** que produce un fichero válido a partir de ellos | Abrir un segmento suelto en un reproductor; y ejecutar la reconstrucción sobre un subconjunto |
| **C-AC8** | **Export final reproducible** | El fichero que el usuario obtiene se abre y se reproduce en reproductores estándar, no sólo «se genera» | VLC y el reproductor nativo de Android, sobre sesión completa y sobre sesión truncada |
| **C-AC9** | **Audio conservado y sincronizado** | El vídeo segmentado **mantiene su pista de audio** y la sincronía A/V se preserva a través de las fronteras de segmento | Fuente con claqueta audiovisual; medir desfase A/V al inicio, a mitad y al final del fichero reconstruido |
| **C-AC10** | **Primer segmento vs segmentos posteriores** | Queda documentado si el segmento 0 es especial (cabecera / segmento de inicialización) y qué necesitan los posteriores. **No se exige que ambos casos sean reproducibles:** si el segmento 0 contiene inicialización indispensable, su ausencia debe producir un **resultado explícito de evidencia incompleta / no reproducible** — nunca corrupción silenciosa ni falso éxito | Exportar una sesión que empieza en el segmento 0 y otra a la que le falta. Con el 0 ausente, comprobar que el sistema **lo declara** en vez de entregar un fichero roto presentado como válido |
| **C-AC11** | **Validez de concatenar bytes** | **Prueba explícita** de que concatenar los bytes de los segmentos produce un fichero válido. **Si no lo es, el spike documenta el mecanismo mínimo correcto** (remux, reescritura de índice, cabecera separada) y lo demuestra | Concatenación directa → abrir en reproductor. Si falla, implementar y probar el mecanismo mínimo |

> **C-AC11 es la que más puede cambiar el plan.** Todo el pipeline de export actual se apoya en que concatenar el prefijo contiguo de bytes produce algo reproducible — cierto para AAC ADTS por ser auto-delimitado (`index.tsx:321-341`), **no necesariamente cierto para vídeo**. Si resulta falso, el mecanismo mínimo correcto forma parte del alcance de la fase D, y hay que decirlo antes de integrar, no después.

**Criterio de salida de la fase C:** las once pasan. Si C-AC1, C-AC2 u C-AC11 no pasan con ninguna alternativa, **la conclusión es del spike, no del plan**: hay que reevaluar el alcance de v0.3 con esa evidencia sobre la mesa, no forzar la integración.

**Estimación:** L. Es la pieza de mayor incertidumbre de todo el plan y la única que no puede acotarse por adelantado con honestidad.

---

# FASE D — Integración del productor con `GC_QUEUE` existente

**Objetivo:** conectar el productor validado al pipeline **que ya existe**, sin duplicarlo.

**Restricción vinculante:** **no se crea un segundo pipeline de subida.** `GC_QUEUE`, el worker y el retry/backoff se reutilizan tal cual: si la integración necesita una cola paralela, un worker propio o una política de reintento distinta para vídeo, **la integración está mal planteada**.

**Lo que sí puede cambiar, si el spike lo demuestra necesario:** la capa multimedia. Cambios **mínimos y compatibles hacia atrás** en metadata de segmento, contenedor, timestamps, segmento de inicialización, manifest o export/muxing son aceptables cuando C-AC7…C-AC11 los justifiquen. Lo que no se acepta es asumir sin prueba que un fragmento de vídeo es indistinguible de uno de audio.

| # | Acción | Cambio mínimo | Archivos | Aceptación | Regresión | Est. |
|---|---|---|---|---|---|---|
| **D-1** | Registrar el productor | `RecordingController` instala el productor segmentado para `mode==='video'`, igual que hoy instala `VideoFileChunkProducer` | `mobile/src/recording/recordingController.ts`, productor nuevo en `mobile/src/recording/` | `PRODUCER_SELECTED` refleja el productor nuevo | Baja — el dispatch ya existe | M |
| **D-2** | Emitir durante la captura | El productor emite por el sumidero existente `videoChunkSink`, que ya escribe a disco y llama a `queueAppendChunk` | `mobile/app/index.tsx:3052` (sin cambios de contrato) | `GC_QUEUE chunk emitted` aparece **durante** la grabación de vídeo | **Media** — toca `startRecording` | M |
| **D-3** | Retirar el andamiaje de contención | Quitar A-3 (modo oculto) y A-4 (tope de 70 s) | `mobile/app/index.tsx:357`, `:7322` | El modo vídeo es alcanzable y no tiene tope artificial de duración | Media | S |
| **D-4** | Verificar que no hay segundo pipeline | Revisión explícita: ninguna cola, worker ni política de reintento paralelos atribuibles al vídeo | — | Diff revisado contra esta restricción | — | S |
| **D-5** | Aplicar los cambios multimedia que el spike haya justificado | Sólo los que C-AC7…C-AC11 demuestren necesarios, mínimos y compatibles con las sesiones de audio existentes | según resultado del spike (posibles: `videoChunkSink`, `manifest.service.ts`, `export.ts`) | Sesiones de audio anteriores siguen exportando igual; suite verde | **Media-alta** — puede tocar export/manifest | M |
| **D-6** | Unificar constantes de chunk de vídeo | Hoy conviven 256 KB (camino muerto) y 128 KB (real) | `mobile/app/index.tsx:311`, `mobile/src/recording/videoFileProducer.ts:40` | Una sola constante viva | Baja | S |

---

# FASE E — Semántica de captura interrumpida y recovery

**Objetivo:** que el sistema **sepa** y **diga** si una captura terminó limpiamente. Es la fase que impide que se repita el patrón de GC-AUD-002 y GC-AUD-033 en el pipeline nuevo.

| # | Acción | Hallazgo | Cambio mínimo | Archivos | Aceptación | Est. |
|---|---|---|---|---|---|---|
| **E-1** | Introducir `capture_end_reason` | GC-AUD-002, 033 | Campo persistente en la entrada de cola. **Cada valor exige su señal; ninguno se infiere:** `user_stop` sólo si el grabador **cerró y finalizó correctamente** (pulsar PARAR no basta) · `interrupted_limit` e `interrupted_error` **sólo con señal explícita** en el momento del fallo · `process_terminated` / `interrupted_unknown` cuando se recupera una entrada sin cierre y **la causa no puede demostrarse** · `unknown` para entradas legacy. **No usar `interrupted_kill`**: afirmaría una causa no observada. Ver §10 de la matriz | `mobile/app/index.tsx` (`PendingQueueEntry`, `stopRecording`, normalización al arrancar la app) | Una entrada recuperada sin cierre previo queda como `process_terminated`, **no** como `interrupted_kill`. Un `stopAudioRecording` que lanza **no** produce `user_stop` | M |
| **E-2** | Propagar a sesión y manifest | GC-AUD-033 | El backend registra el motivo y el **número de chunks esperado**, no `uploaded.length` | `backend/src/services/manifest.service.ts:209`, `sessions.service.ts` | El manifest de una sesión truncada es distinguible de uno completo **desde otro dispositivo** | M |
| **E-3** | Veredicto de UI con **dos hechos separados** | GC-AUD-033, 004 | La UI expone por separado **(A)** completitud de la grabación (`capture_end_reason`) y **(B)** fragmentos confirmados fuera del dispositivo, **sin colapsarlos**. **Cinco estados:** completa + todos ⇒ «Protegido» · completa + parcial ⇒ «N/M protegidos» · **completa + 0 remotos ⇒ «Grabación completa; todavía no protegida fuera del dispositivo»** · interrumpida + ≥1 remoto ⇒ «Hay evidencia protegida fuera del dispositivo; la grabación está incompleta» · interrumpida + 0 remotos ⇒ «Grabación incompleta; nada protegido fuera del dispositivo». **Sin regla general «interrupted_* ⇒ parcial»** | `mobile/app/recover/[id].tsx`, `mobile/app/session/[id].tsx`, `mobile/src/recording/deriveGuardianStatus.ts` | Las cinco combinaciones de §3ter del informe rinden mensajes distintos. Interrumpida-con-remotos e interrumpida-sin-remotos **no** comparten texto | S |
| **E-4** | `scanOrphans` sobre `cacheDirectory` | GC-AUD-002 | Escanear también `cacheDirectory` con los filtros de extensión existentes | `mobile/src/recording/orphanScan.ts` | El fichero en vuelo aparece como huérfano | S |
| **E-5** | Reconciliación por conjunto, no por conteo | GC-AUD-009 | Exigir `{0..expected-1} ⊆ índices subidos`, igual que la puerta de finalización | `mobile/app/index.tsx:1437-1455` | Con backend `{0,1,2,4,5}` y `expected=5` no se reconcilia ni se borra el fichero local | S |
| **E-6** | Etiqueta honesta para lo aún no subido | decisión 1 | Mientras no exista confirmación remota, la UI dice **«Todavía no protegido fuera del dispositivo»**. Persistido localmente ≠ protegido | `mobile/src/recording/deriveGuardianStatus.ts`, `mobile/app/index.tsx:1582-1598` | Sin red y con fragmentos en disco, la pantalla no usa la palabra «protegido» en afirmativo | S |

> **E-4 se documenta como mitigación.** Un `.mp4` interrumpido carece del átomo `moov` y **no es reproducible**. La recuperación real de vídeo interrumpido la aporta la fase D, no ésta. Presentar E-4 como garantía sería repetir el error que esta auditoría denuncia.

---

# FASE F — Android, OAuth, firma, NAS y seguridad de release

*Solape parcial con C/D/E: **F-1…F-5, F-20 y F-21 se secuencian** con el pipeline de captura porque comparten ficheros; el resto puede ir en paralelo.*

## F.1 Foreground service — cinco cambios independientes

**Tipos por escenario.** El tipo debe corresponder al trabajo real que el servicio está haciendo en cada momento:

| Escenario | Tipo requerido |
|---|---|
| Captura de **audio** | `microphone` |
| Captura de **vídeo con audio** | `camera` **+** `microphone` |
| **Sólo subida** (drenaje post-parada, drenaje al arrancar la app) | `dataSync` **o un mecanismo compatible** (p. ej. trabajo diferido gestionado por el sistema) |

**No se asume que un único servicio deba declarar todos los tipos.** Concentrarlo todo en uno obliga a mantener permisos y tipos que no corresponden al trabajo en curso — que es justo el defecto actual (`microphone` durante subidas). **El spike decide los límites**: uno o varios servicios, con qué ciclo de vida y qué transiciones.

| # | Acción | Hallazgo | Aceptación | Est. |
|---|---|---|---|---|
| **F-1** | **Permisos concedidos ANTES de arrancar el servicio.** Todos los que el tipo declarado exija: `RECORD_AUDIO` para `microphone`, `CAMERA` para `camera` | GC-AUD-035 | Instalación limpia, Android 14+, notificaciones concedidas y micrófono/cámara no: pulsar GRABAR **no** crashea. Medir el impacto en el objetivo «<2 s» | M |
| **F-2** | **Tipos correctos por escenario** según la tabla anterior. Declarar los permisos de tipo correspondientes (`FOREGROUND_SERVICE_CAMERA`, `FOREGROUND_SERVICE_DATA_SYNC`) | GC-AUD-008 | Manifest y opciones coherentes con el trabajo real. Durante el drenaje post-parada **no** se muestra el indicador de micrófono ni el de cámara | M |
| **F-3** | **Observabilidad real del arranque.** Dejar de tratar la resolución de `start()` como prueba. Latido con marca de tiempo desde el cuerpo de la tarea. Retirar la telemetría que no puede medir lo que dice | GC-AUD-034 | Con el arranque rechazado, el sistema lo detecta y reintenta en vez de devolver `already_running` | M |
| **F-4** | **Recovery de subidas tras reinicio del dispositivo por un mecanismo permitido que actúe SIN intervención del usuario.** **No arrancar `camera`, `microphone` ni `dataSync` desde `BOOT_COMPLETED` en Android 15.** El candidato es trabajo diferido gestionado por el sistema. **El drenaje al abrir la app (I5a) NO satisface esta acción**: es el fallback que ya existe, y exige que el usuario abra la app | GC-AUD-008 | Tras reiniciar el dispositivo con cola pendiente, la evidencia sube **sin que el usuario abra la app ni intervenga**, y **sin** arrancar un FGS prohibido desde el arranque del sistema | M |
| **F-5** | **Límites de Android 14/15.** Restricción de arranque desde background, timeout acumulado de `dataSync` en Android 15, comportamiento OEM | GC-AUD-008 | **Requiere dispositivo** — se valida en la fase G | L |

> F-2 obliga a `expo prebuild` y a reaplicar el manifest (`RELEASE_CHECKLIST_v0.3.md:56-58`). **F-3 antes que F-5:** sin observabilidad real, cualquier medición de F-5 se hace sobre un sistema que no sabe informar de sus fallos.
>
> **Nota sobre F-4 y el estado actual:** hoy no existe ningún receptor de `BOOT_COMPLETED` (verificado en el manifest), así que la prohibición no está incumplida — pero tampoco hay recovery tras reinicio salvo que el usuario abra la app. `IMPLEMENTATION_STATUS.md:16` afirma «Recovery after device reboot» y `VALIDATION_MATRIX.md:10` lo marca «?». F-4 debe cerrar esa ambigüedad con un mecanismo real y permitido, no con un receptor prohibido.

## F.2 OAuth — replanteamiento

| # | Acción | Hallazgo | Aceptación | Est. |
|---|---|---|---|---|
| **F-6** | **Transacción `state` verificada en servidor.** Generada por el backend, ligada al `user_id`, persistida con TTL corto, **verificada antes del canje** | GC-AUD-036 | `state` ausente, caducado, ya consumido o de otro usuario ⇒ rechazo. Test de integración nuevo | M |
| **F-7** | **Canje en el callback HTTPS del backend.** `GET /auth/drive/callback` canjea el código resolviendo el usuario desde la transacción `state`. **El `code` deja de reenviarse a `guardiancloud://`**; el deep link transporta sólo un resultado no sensible | GC-AUD-036 | Inspección del redirect: no contiene `code`. La app confirma el estado con `getConnectedDrive` | M |
| **F-8** | **Evaluar PKCE y App Links.** Decidir con criterio y **dejar constancia de la decisión**; no descartarlos por defecto. Hay dominio propio (`api.guardiancloud.app`), así que App Links con `autoVerify` es viable | GC-AUD-036 | Decisión escrita con su justificación | S |

## F.3 Resto

| # | Acción | Hallazgo | Aceptación | Est. |
|---|---|---|---|---|
| **F-9** | Firma de release: `signingConfigs.release` real, o el checklist deja de ofrecer la ruta gradle local | GC-AUD-037 | El APK entregado a testers no está firmado con `androiddebugkey` | S |
| **F-10** | NAS tras flag (preferido) o asegurado: normalizar URL antes de comparar, restringir `remote_reference`, bloquear rangos privados | GC-AUD-006, 014 | Con flag, `POST /destinations/nas*` → 404. Sin él, un `remote_reference` con `..` se rechaza, con test que lo demuestre. **Actualizar R14 de `RECOVERY_BETA_VALIDATION.md`** en el mismo cambio | M |
| **F-11** | Timeouts en las 11 llamadas a Supabase sin él | GC-AUD-012 | Con PostgREST inalcanzable, los handlers devuelven error acotado | M |
| **F-12** | Distinguir «error de Drive» de «no hay evidencia» | GC-AUD-013 | Con Drive caído, la pantalla dice que falló, no que no hay nada | S |
| **F-13** | Escapar la salida del callback OAuth | GC-AUD-017 | `?error=<img …>` no renderiza marcado | S |
| **F-14** | Quitar `/debug-ping`; acotar CORS | GC-AUD-025 | La ruta devuelve 404 | S |
| **F-15** | Borrar las rutas `debug-camera-probe` (×2) y retirar `expo-av` | GC-AUD-039 | La ruta no existe; `expo-av` ya no es dependencia | S |
| **F-16** | Silenciar los logs de diagnóstico en release | GC-AUD-040 | En release no aparecen UUID de sesión ni URI en logcat | M |
| **F-17** | Excluir el almacén de auth del backup (`dataExtractionRules`) | GC-AUD-038 | El respaldo no incluye el refresh token | S |
| **F-18** | Retirar permisos declarados y no usados | GC-AUD-026 | `SYSTEM_ALERT_WINDOW` y `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` fuera; `WRITE_EXTERNAL_STORAGE` acotado | S |
| **F-19** | Fijar `targetSdkVersion` explícitamente | GC-AUD-043 | Una subida de RN no cambia el `targetSdk` en silencio | S |
| **F-20** | Extraer el worker para poder testearlo | GC-AUD-021 | Mover **sólo** `uploadDrainLoop` y los chunkers a `src/recording/`. Tests nuevos de `uploadDrainLoop` | M |
| **F-21** | Eliminar el bloqueo head-of-line del worker | GC-AUD-010 | `next_attempt_at` por chunk; `pickNext` salta los que están en backoff; no dormir dentro del lock. **Requiere F-20 antes** | M |

---

# FASE G — Validación física en build release con Metro apagado

**Objetivo:** medir el sistema **ya estabilizado**. Nada de esta fase puede adelantarse: mediría un sistema que va a cambiar.

**Condición de entrada:** A, B, C, D, E y F aplicadas.

| # | Escenario | Criterio |
|---|---|---|
| **G-1** | Promesa de los 10 s — **audio y vídeo** | Con el perfil de red definido, ≥1 fragmento confirmado remotamente antes de los 10 s en ambos modos |
| **G-2** | Comportamiento offline — ambos modos | Sin red: la captura arranca, los fragmentos se persisten en disco durable, drenan solos al volver la red, y el estado visible nunca afirma protección inexistente |
| **G-3** | Kill a 10 / 20 / 60 / 90 s — ambos modos | Evidencia remota utilizable en los cuatro cortes. **El operador sabe que mató el proceso; el sistema no.** El estado persistido debe ser `process_terminated` / `interrupted_unknown` —**nunca** `interrupted_kill`, que afirmaría una causa no observada— y la UI debe reflejar ese estado **más los fragmentos remotos realmente confirmados** (§3ter del informe) |
| **G-4** | Foreground service en Android 14 y 15 (conjunto F-1…F-5) | La notificación sobrevive; la cola drena minimizada; sin crash por `SecurityException` |
| **G-5** | Recovery automático tras reinicio del dispositivo (F-4) | Con cola pendiente, reiniciar el dispositivo y **NO abrir la app**: la evidencia sube igualmente, por un mecanismo permitido y sin ninguna intervención del usuario. Que drene al abrirla es el fallback I5a y **no cuenta como aprobado**. `VALIDATION_MATRIX.md:10` lo marca «?» pese a `TEST_RESULTS.md:7` «PASS» |
| **G-6** | Recovery cross-device de sesión truncada | Con **≥1 fragmento remoto confirmado** rinde «Hay evidencia protegida fuera del dispositivo; la grabación está incompleta». Con **0 fragmentos remotos** rinde «Grabación incompleta; nada protegido fuera del dispositivo». **Nunca «Protegido»**, y los dos casos **no comparten texto** |
| **G-7** | Subida real a Drive end-to-end + OAuth reformado | Chunks presentes en `/GuardianCloud`; el redirect no transporta `code` |
| **G-8** | Red intermitente y muy lenta | La cola avanza; ningún chunk envenenado bloquea a los demás (F-21) |
| **G-9** | Almacenamiento lleno, batería baja | Sin corrupción de sesión |
| **G-10** | Reproducibilidad del fichero exportado | Abrir `.aac` y `.mp4` en un reproductor real |
| **G-11** | `RELEASE_CHECKLIST_v0.3.md` §4.10 | 3 usuarios sin contexto: <2 s hasta grabar, sin dudas, entienden el estado, recuperan sin ayuda |
| **G-12** | Captura completa con subida parcial | Muestra «N/M protegidos» sin declarar protección completa |

**Registro obligatorio:** cada resultado se escribe en `docs/SURVIVAL_TEST_RESULTS.md` con **fecha, modelo de dispositivo, versión de Android, commit y resultado**. Hoy ese fichero dice «Sin sesiones registradas todavía», y **en todo el repositorio no hay una sola casilla de checklist marcada**.

**Estimación:** L. Es trabajo de campo, no de código.

---

# FASE H — Actualización documental posterior a evidencia real

**Objetivo:** que la documentación describa lo demostrado, no lo esperado. **Va después de G a propósito**: documentar antes de medir es cómo el proyecto llegó a tener 24 afirmaciones de «VALIDADO EN DEVICE REAL» sin un solo registro detrás.

| # | Acción | Hallazgo |
|---|---|---|
| **H-1** | Corregir las afirmaciones de validación sin respaldo en `IMPLEMENTATION_STATUS.md`, `START_HERE.md`, `docs/README.md`, `BETA_STABLE_BASELINE.md`, `PLAN.md` | GC-AUD-018 |
| **H-2** | Resolver la contradicción del cifrado: implementarlo, o corregir los seis documentos y registrarlo en `KNOWN_DEBT.md` | GC-AUD-005 |
| **H-3** | Reescribir la promesa en `START_HERE.md:76` y `MVP_SCOPE.md:33` **condicionada a conectividad**, con el comportamiento offline explícito | decisión 7 |
| **H-4** | Documentar `capture_end_reason` y las cuatro dimensiones de completitud en `ARCHITECTURE.md` | decisión 8 |
| **H-5** | Actualizar `SYSTEM_INVARIANTS.md` para que I1 diga explícitamente «audio **y** vídeo» | decisiones 1-2 |
| **H-6** | Reconciliar `KNOWN_LIMITS.md` con `expo-audio`; su «Opción A» ya está hecha | GC-AUD-032 |
| **H-7** | Actualizar `API_SPEC.md`: quitar `/auth/*` y `/alerts`, añadir las rutas reales en uso | D16 |
| **H-8** | Actualizar `RELEASE_CHECKLIST_v0.3.md`: 99→138 tests, `meta-data` de shortcuts, postura sobre el auto-inicio, ruta de firma | GC-AUD-018 |
| **H-9** | Enmendar `MVP_SCOPE.md` sobre NAS y cross-device recovery, o dejarlos fuera de release | GC-AUD-014 |
| **H-10** | Reparar los documentos rotos: `playbook/UX_STRESS_RULES.md` (0 bytes), `EVIDENCE_EXPORT_AND_FORENSIC.md` (0 bytes), 9 ficheros con vallas de código sin cerrar, bloque duplicado en `MVP_SCOPE.md` | GC-AUD-029 |
| **H-11** | Limpieza del repositorio: ficheros basura trackeados, `_deltas/`, email personal hardcodeado, código muerto | GC-AUD-022/023/024/027 |

---

# Deuda posterior al MVP

No bloquea v0.3. Se aborda cuando haya uso real.

| # | Acción | Hallazgo |
|---|---|---|
| **P2-1** | Export incremental (escritura por chunk). **Antes, medir el pico real en dispositivo**: la estimación honesta es un rango ~3,3N–8N, no un dato | GC-AUD-015 |
| **P2-2** | Persistir formato/extensión por sesión en el backend; elimina el sniff binario y el mislabel de vídeo como audio | GC-AUD-041 |
| **P2-3** | Visibilizar en UI el fallo de persistencia de cola | GC-AUD-020 |
| **P2-4** | Salir de `expo-file-system/legacy` | GC-AUD-030 |
| **P2-5** | Tests de `exportSession` y `recoveryExport.ts` (hoy sin fichero de test; los de export mockean crypto y filesystem) | §6.3 del informe |
| **P2-6** | Comprobar `aud`/`role` en el verificador de JWT | §9 del informe |
| **P2-7** | Chunker de audio: deja de leer el fichero entero en cada tick (coste cuadrático) | GC-AUD-031 |
| **P2-8** | Documentar que la identidad anónima está ligada al dispositivo, y que conectar Drive es lo que hace la evidencia recuperable | GC-AUD-016 |

---

# NO HACER AHORA

| Idea | Por qué no |
|---|---|
| **Refactor amplio de `mobile/app/index.tsx`** | 7 376 líneas lo piden, y `ANTI_PATTERNS.md` lo respalda. Pero un refactor de cola + worker + recovery mientras se integra un productor nuevo es la receta de regresión que `BETA_STABLE_BASELINE.md:131-140` prohíbe. F-20 extrae **sólo** el worker, y sólo porque compra cobertura de test |
| **Migrar la cola a SQLite** | `ARCHITECTURE.md:35-39` documenta bien la decisión de no hacerlo. La migración a payloads en disco ya eliminó la causa principal del problema de CursorWindow. No hay evidencia de que AsyncStorage sea hoy el cuello de botella |
| **Implementar cifrado local** | Es un proyecto, no un parche, y choca con `ANTI_PATTERNS.md:68-69` y con «subir > perfeccionar». **Lo urgente no es cifrar: es dejar de decir en seis documentos que ya se cifra** (H-2) |
| **Migrar a `SecureStore`** | Deseable, pero F-17 captura la mayor parte del riesgo por una fracción del coste |
| **Health check profundo (`/ready`)** | Añade superficie y modos de fallo. `/health` como liveness es correcto para un homelab |
| **Endpoints `/auth/*` y `/alerts`** | Están en `API_SPEC.md` pero no existen, y Kids está fuera del MVP. **Corregir la spec, no escribir el código** (H-7) |
| **Herramienta externa `guardian-rebuild`** | `ARCHITECTURE.md:150-164` la propone como futura. Correcto que siga siéndolo |
| **Retirar toda la telemetría OEM** | Tentador tras GC-AUD-034, pero parte de ella (permisos de notificación, huella de dispositivo) sí mide cosas reales. Retirar sólo lo que descansa sobre `isRunning()`, dentro de F-3 |

> **Retirado de esta lista en la adjudicación:** la *captura segmentada de vídeo en vivo*, que la versión anterior clasificaba aquí. Es la fase C/D de este plan.

---

## Nota de cierre

La forma del plan cambió con la adjudicación, no sólo su contenido. Antes proponía **contener** el problema del vídeo; ahora lo **resuelve**, y la contención queda reducida a lo que es: andamiaje que se retira en la fase D.

Dos cosas conviene no perderlas de vista. La primera: **la fase A entera son siete cambios de tamaño S** y entre ellos eliminan los dos casos en que el sistema afirma falsamente que la evidencia está protegida — sin tocar cola, worker ni recovery. La segunda, enunciada con la precisión que merece: **`GC_QUEUE`, worker, retry, backend, recovery y export ya existen y tienen cobertura parcial; su comportamiento end-to-end sigue sin demostrarse en dispositivo real.** Existir con cobertura parcial no es lo mismo que estar probado, y la fase G está en este plan precisamente porque esa demostración todavía no se ha hecho — ni para vídeo, ni para audio.

---

*Plan derivado de una auditoría de sólo lectura y adjudicado el 2026-07-28. Ninguna de estas acciones ha sido aplicada.*
