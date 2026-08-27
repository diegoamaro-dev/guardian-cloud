# IMPLEMENTATION_STATUS.md

⛔ NO APTO PARA RELEASE — por cifrado local, recovery `I5c`, export `.mp4`, cobertura de dispositivos **y findings de identidad/destino todavía no cerrados**. **Ya no por `GC-AUD-001`.**

| Qué | Cuándo / sobre qué |
|---|---|
| Estado documental vigente | **2026-08-26** |
| Producto usado para la revalidación de `GC-DEST-PAUSE-001` | **`22a9b26`** (APK release `2b3be062…`) |
| Producto usado para la validación de `GC-START-LATENCY-001` | **`e643b01`** (APK release `1cb80fea…`) |
| Producto usado para la validación de **D3 local segment salvage** | **`cb59c7e`** (APK release `8151c338…`) |
| Última suite automática registrada | **2026-08-26**, tras **`fc9a20e`** — 936/936 en 42 ficheros · typecheck 12, sin drift |

> Las fechas y los commits son distintos a propósito, y no deben fundirse. La
> suite vigente —936/936 en 42 ficheros— se midió sobre el árbol posterior a
> `fc9a20e`; las tres validaciones de hardware se hicieron en dispositivo, no
> corriendo la suite, y cada una sobre **su propio APK**:
> `GC-DEST-PAUSE-001` sobre `22a9b26`, `GC-START-LATENCY-001` sobre `e643b01` y
> **D3** sobre `cb59c7e`. **Ninguna cifra de tests describe un APK.**

> **Corte anterior: 2026-08-20.** Entre el 20/08 y el 23/08 la rama
> `fix/gc-auth-001-main-integration` incorporó seis commits que este documento
> no reflejaba. La sección
> [Findings abiertos](#findings-abiertos-de-identidad-destino-y-herramientas)
> los recoge con su estado exacto.

Fuentes de continuidad y evidencia:

* [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) — límites vigentes y findings §1–§6;
* [`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md) §0 — invariante de migración de identidad, bloqueante;
* [validación física del vídeo nativo con durable cleanup del 20/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md);
* [validación física de la integración nativa segmentada del 13/08](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_INTEGRATION_VALIDATION_2026-08-13.md);
* [configuración OAuth de Drive](./OAUTH_DRIVE_CONFIGURATION.md).

La validación del 20/08 cubre el conjunto integrado —vídeo nativo segmentado
más journal, runner y scheduler— en **un solo dispositivo**: OnePlus A6000 /
Android 11 / API 30 / `arm64-v8a`. La del 13/08 cubre el productor nativo
existente entonces y se conserva como registro fechado.

Todo `HARDWARE_VALIDATED` de este documento significa **validado en ese
dispositivo**. No implica cobertura multi-dispositivo ni Android 13+.

---

## Capacidades por nivel (referencia canónica)

Esta tabla es la **fuente única** para saber qué está implementado y qué está
validado, y con qué alcance. Cualquier afirmación en otro documento que la
contradiga es incorrecta.

### Nivel 1 — Implementado con validación disponible

| Capacidad | Matiz |
|---|---|
| Grabación de audio | — |
| Fragmentación de audio | En vivo cada 1,5 s |
| Subida de audio durante la grabación | Validada en el alcance histórico del MVP |
| Grabación nativa segmentada de vídeo | `HARDWARE_VALIDATED` 20/08; segmentos MP4 independientes H.264/AAC verificados con `ffprobe` |
| Adopción del vídeo durante la captura | `HARDWARE_VALIDATED` 20/08; 12/12 adopciones, latencia cierre → cola 189–262 ms |
| **Subida de vídeo durante la captura** | `HARDWARE_VALIDATED` 20/08; primera subida confirmada a `+14,619 s`, PARAR a `+75,514 s`, **11 de 12 chunks confirmados antes de parar** |
| Durable cleanup journal/runner/scheduler, **ruta normal** | `HARDWARE_VALIDATED` 20/08; `finalized` con reconcile y borrado de ambos recursos sin reiniciar la app |
| Completion sin repetición | `HARDWARE_VALIDATED` 20/08; exactamente un `/complete` en los dos escenarios observados |
| Recovery de una sesión pendiente tras restaurar Drive | `HARDWARE_VALIDATED` 20/08; 12 chunks preservados durante una caída de credencial y drenados al restaurarla |
| **Frontera de borrado exclusiva por journal** | `HARDWARE_VALIDATED` 20/08 por prueba dirigida: durante una pasada real con `considered: 1`, la sesión autorizada se borró y dos directorios centinela de UUID canónico **sin** entrada en el journal quedaron byte-identical |
| `GC_QUEUE` como fuente de verdad | — |
| Cola persistente | AsyncStorage; sobrevive a cierre forzado y a reinicio |
| Worker single-flight con reintentos | — |
| Recovery automático | Tras kill y al abrir la app. **No** tras reinicio sin abrirla (`I5c`) |
| Evidencia fuera del dispositivo durante la captura | Audio y vídeo nativo segmentado, ambos con evidencia física |
| Exportación utilizable en `.m4a` | — |

### Nivel 2 — Implementado, pendiente de validación completa

| Capacidad | Qué falta |
|---|---|
| Durable cleanup/scheduler, **rutas artificiales de fallo** | `HARDWARE_HARDENING_PENDING`. Cubiertas por pruebas unitarias; falta ejercitarlas en dispositivo con failpoints: boot con trabajo durable real, caso positivo de `stale_reconciled`, fallo de reap posterior a completion y reap diferido exitoso. **No bloquean la integración de la rama** |
| Reliability Card | No se observó en Home durante la instalación de validación y la causa sigue sin determinar. Cubierta por pruebas unitarias, sin validación en dispositivo |
| Comportamiento y permisos en Android 13+ | `POST_NOTIFICATIONS` es SDK 33+ y el único dispositivo probado es API 30. Las tres ramas están cubiertas por pruebas unitarias, pero **prueba unitaria no es validación en dispositivo** |
| Matriz completa de resiliencia | Mala red, segundo plano prolongado, cierre forzado, reinicio, recovery y export, sin reejecutar con el artefacto vigente |

### Nivel 3 — Planificado: no implementado ni validado

| Capacidad | Estado |
|---|---|
| Recuperación completa del vídeo nativo | No consta validación integrada; no se declara implementada o validada por la evidencia actual |
| Exportación `.mp4` | No implementada ni validada |
| Continuous Protection — continuidad `VIDEO_AUDIO → AUDIO_ONLY` al perder el primer plano | **Capacidad: no implementada ni validada.** Contrato aceptado el 2026-08-25. **Infraestructura parcial y precondiciones ya publicadas**, sin cambio de comportamiento observable: `8983bad` añadió la metadata durable `evidence_closed`, `6c6489c` desacopló el camino de **lectura** de terminalidad hacia `/complete`, y `fc9a20e` añadió `media` por chunk y la clasificación **fail-closed** de D3. La **escritura** sigue acoplada y la transición no existe: minimizar durante vídeo cierra la sesión igual que antes. Decide [`decisions/ADR-CONTINUOUS-PROTECTION.md`](./decisions/ADR-CONTINUOUS-PROTECTION.md); su criterio de prueba es el escenario 18 de [`TEST_SCENARIOS.md`](./TEST_SCENARIOS.md), que sigue `DEFINIDO` |

> **`fc9a20e` es una precondición de INTEGRIDAD, no Continuous Protection
> funcionando.** Retira un modo de fallo de D3 —habría podido copiar bytes de
> audio como `segment_NNNNNN.mp4` y acreditarlos por `sha256`— haciendo que la
> elegibilidad se decida **por chunk** y exigiendo la firma estructural
> `segments/<session_id>/segment_NNNNNN.mp4`. **D3 no soporta sesiones mixtas:
> las rechaza.** Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §D3.
>
> `G3''` —descripción de la evidencia en backend y manifiesto— está
> **implementado, versionado, desplegado y validado**, pero **las cuatro cosas
> son distintas** y la última tiene un alcance estrecho:
>
> ```
> IMPLEMENTADO              sí
> VERSIONADO / PUBLICADO    sí — 142c1f9, integrado en main con f3bb913
> DESPLEGADO                sí — migración 0005 aplicada · PostgREST reconoce
>                                media · el backend en servicio escribe
>                                guardian-cloud.manifest.v2
> VALIDADO FUNCIONALMENTE   sí, EXCLUSIVAMENTE para media='audio'
>                                17/17 chunks · manifiesto v2 observado
>                                ver VALIDATIONS/G3II_PER_CHUNK_MEDIA_2026-08-26.md
> ```
>
> **`media='video'` NO fue validado funcionalmente.** Tampoco background, kill,
> pérdida de red, reinicio, export, ni la integridad de los bytes en Drive
> contra sus hashes. El registro de validación acota lo comprobado; **desplegado
> no equivale a validado**.
>
> Qué contiene lo desplegado: `media` opcional por chunk en `POST /chunks`,
> persistencia nullable donde la ausencia significa «no declarado» y nunca se
> infiere, `guardian-cloud.manifest.v2` con `chunks[].media` obligatorio y sin
> `mode` ni `format` de sesión, lectura read-only de v1 —cuyo `mode` histórico
> se propaga a los chunks porque toda sesión v1 es homogénea—, recovery que
> deriva el medio de los chunks, y `409 MANIFEST_HETEROGENEOUS` en lugar de un
> artefacto falsamente etiquetado. `mode` se conserva en `POST /sessions` y en
> la fila de sesión, donde significa el medio con el que se **inició** la
> captura.
>
> Qué **no** hace: no habilita evidencia mixta —ningún productor puede crearla—,
> no implementa `VIDEO_AUDIO → AUDIO_ONLY`, no implementa el export heterogéneo
> —una sesión mixta se **rechaza**—, y no toca D3, `/complete`, terminalidad,
> background, worker ni cleanup.
>
> **`G4` sigue BLOQUEADO.** La condición que lo bloqueaba antes —que `G3''` no
> estuviera versionado ni desplegado— **ya no aplica**, pero el bloqueo persiste
> por su otra causa, la que este gate nunca abordó: **`VIDEO_AUDIO → AUDIO_ONLY`
> sigue sin implementarse**, ningún productor puede crear evidencia mixta, y §7
> del ADR continúa prohibiendo producirla.
> Contrato en [`API_SPEC.md`](./API_SPEC.md) §Manifiesto de evidencia.

> **D3 `LOCAL SEGMENT SALVAGE` no pertenece a este nivel y no es un export
> `.mp4`.** Es una capacidad distinta, implementada en `cb59c7e` y con
> **`HARDWARE FUNCTIONAL PASS`** el 2026-08-24: cuando una captura de vídeo
> nativo segmentado queda sin salida cloud, permite copiar del sandbox los
> **segmentos MP4 originales**, ordenados y verificados por `sha256` en destino,
> a una carpeta que elige el usuario vía Storage Access Framework.
>
> Los segmentos son contenedores MP4 **independientes**; no se concatenan,
> porque unir contenedores MP4 byte a byte no produce un MP4 válido. D3 **no
> produce** vídeo reconstruido, MP4 final ni grabación completa. El export final
> `.mp4` sigue **no implementado**, exactamente como dice la fila de arriba.
>
> Alcance y evidencia en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5.

> **`POST-SALVAGE NETWORK RECOVERY` = `PASS`, gate independiente del anterior.**
> El 2026-08-24, sobre la misma sesión y el mismo APK, se restauró la
> conectividad después del salvage y la sesión convergió con normalidad: mismo
> `localSessionId`, 1 `POST /sessions` efectivo, 12/12 chunks con 12
> `remote_reference` únicas, `missing []`, `/complete` posterior al 12/12,
> `GC_CLEANUP_AUTHORIZED` con `http_200`, cleanup, y `GC_QUEUE` sin la sesión —
> con el export SAF **intacto**, 13/13 por `sha256`.
>
> Autoriza una sola afirmación nueva: **D3 es aditivo** —el salvage local no
> impide el registro, la subida, la completion ni el cleanup normales
> posteriores de la misma sesión—. **No** es el mismo gate que el
> `HARDWARE FUNCTIONAL PASS` de arriba y no debe fundirse con él: aquél probó
> que el salvage funciona, éste que no estorba. **No** reproduce el escenario de
> `GC-AUTH-SESSION-RECOVERY-001`, que sigue `OPEN`. Detalle en
> [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5.

> **`GC-SEGMENT-CONTINUITY-001` = `OBSERVATION / INVESTIGATION OPEN`.** De esa
> misma corrida salió una observación temporal —`capture_ms` 72,551 s frente a
> 66,765 s de suma `ffprobe` de los 12 segmentos, 5,786 s de diferencia— que
> **no es un defecto confirmado ni un release blocker**, no tiene causa
> atribuida y no afirma pérdida de evidencia. Deliberadamente **no** figura en
> la tabla de findings de este documento. Registro único en
> [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5.

> **Criterio de incompatibilidad.** Cualquier propuesta de «vídeo post-stop»
> —fragmentar y encolar **después** de detener la captura— es **incompatible
> con el principio central del producto**: «si grabas unos segundos, al menos
> una parte ya está fuera del dispositivo». La ruta nativa vigente genera,
> adopta y sube segmentos durante la captura, y eso quedó **demostrado en
> hardware el 20/08**. Sigue sin demostrar recovery completo de vídeo, export
> `.mp4` ni cobertura de otros dispositivos.

Fuera de estos tres niveles, y explícitamente **no** capacidades actuales:
cifrado local de chunks (sólo `TODO` en el código), recovery autónomo tras
reinicio sin abrir la app (`I5c`), `capture_end_reason`, Closed Testing,
usuarios externos y publicación en Play Store.

### Problema 8 — Durable cleanup scheduler

Estado: `IMPLEMENTED / UNIT_TESTED / HARDWARE_VALIDATED` **en la ruta normal**;
`HARDWARE_HARDENING_PENDING` en las rutas artificiales de fallo.

Demostrado **en dispositivo** el 20/08, en dos escenarios independientes
—recovery de una sesión pendiente y captura limpia—:

* `GC_CLEANUP_AUTHORIZED` posterior a una completion confirmada `http_200`;
* trigger `finalized` tras mark y reap correctos;
* `RECONCILE_START` / `RECONCILE_DONE` 1 / 1, sin pasadas concurrentes;
* borrado de `native_cache` y `stable_segments` con `remaining: 0`;
* `GC_CLEANUP_DROPPED` y journal convergido sin entradas activas;
* cleanup completado **sin reiniciar la aplicación**;
* exactamente un `/complete`, sin incremento de `complete_attempts`;
* cero `GC_CLEANUP_SCHEDULER_FAILED` y cero `AUTHORIZE_REJECTED`;
* **discriminación activa de la frontera de borrado**: en una pasada con
  `considered: 1`, la sesión autorizada se eliminó y dos directorios centinela
  de UUID canónico sin entrada en el journal quedaron byte-identical.

Demostrado **sólo por pruebas automáticas**, pendiente de hardware:

* scheduler single-flight;
* `pending=false` antes de `reconcile`;
* coalescencia de solicitudes del mismo tick;
* una solicitud durante una pasada provoca exactamente otra pasada;
* triggers cerrados `boot`, `finalized` y `stale_reconciled`;
* boot cleanup no bloqueante;
* errores del scheduler contenidos fuera del completion flow;
* una sesión sin journal permanece invisible al runner;
* un fallo local posterior a completion y autorización durable no incrementa
  `complete_attempts`, no repite `completeSession` y no degrada la
  finalización confirmada;
* un reap diferido exitoso retira `GC_QUEUE` y vuelve a solicitar cleanup con
  motivo `finalized`.

## Findings abiertos de identidad, destino y herramientas

Ocho findings registrados entre el 20/08 y el 24/08. **Ninguno está CLOSED
salvo donde se indica explícitamente.** Los estados de §1–§6 son los de
[`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md). `GC-START-LATENCY-001` **ya tiene
registro propio** desde el 24/08 —§6—; sólo `GC-DEST-STATUS-001` sigue
proviniendo de una ficha de evidencia congelada fuera del repositorio.

### Vocabulario de estado

| Etiqueta | Significa |
|---|---|
| `FIXED IN CODE` | La corrección está en la rama y cubierta por pruebas. **No** dice nada sobre dispositivo |
| `CLOSED IN HARDWARE` | Reproducido y verificado corregido en dispositivo, con evidencia fechada |
| `HARDWARE REVALIDATION REQUIRED` | Corregido en código; la corrida física que lo cerraría no se ha completado |
| `HARDWARE REVALIDATED` | Una corrección ya implementada ha sido **reejecutada y revalidada con éxito en dispositivo real**, con evidencia fechada. Se escribe junto a `FIXED IN CODE`, no en su lugar |
| `OPEN` | Observado y caracterizado. **Sin corregir** |

> **`HARDWARE REVALIDATED` no es `CLOSED IN HARDWARE`.** En el segundo, el
> dispositivo **reprodujo** el fallo y luego verificó su corrección: el ciclo
> completo ocurrió allí. En el primero, el fallo se había caracterizado antes y
> lo que el dispositivo acredita es que la corrección **funciona**. Es una
> acreditación más débil en origen, no en rigor, y por eso el estado conserva
> `FIXED IN CODE` delante. Ninguna etiqueta histórica se renombra por esto.

### Tabla

| Finding | Estado | Corregido en | Alcance de la validación |
|---|---|---|---|
| **GC-AUTH-MIGRATION-001** | **CLOSED IN HARDWARE** | `3f14063` | Único cierre en hardware del bloque. OnePlus A6000, 21/08, desde `pm clear`: la sonda selló el veredicto negativo en disco antes de que existiera un byte de captura |
| **GC-DEV-RESET-001** | RELEASE BLOCKER · `FIXED IN CODE` / revalidación hardware **no requerida** | `e289dcb` | El defecto es de política de borrado, demostrable en pruebas. 62 tests en `devResetGuard.test.ts` |
| **GC-DEST-PAUSE-001** | `FIXED IN CODE` / **`HARDWARE REVALIDATED`** | `3fae4f6` | Revalidado el 24/08 como **cross-build durable-state recovery validation**: la pausa la escribió el build `34412a0`-era y la retiró producto `22a9b26`. Reconexión real por OAuth → pausa retirada → 10/10 chunks con referencias remotas distintas → `/complete` → cleanup, en ese orden. Identidad estable (`08c0875e`). La corrida del 21/08 había quedado **anulada** por GC-DEV-RESET-001. Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §3 |
| **GC-AUTH-001** | `FIXED IN CODE` · ruta de identidad **PASS en hardware** · flujo extremo a extremo **no alcanzado** | `ad8756b`…`8615ba6`, integrados en `e215e5c` | La Vía 2 del 21/08 dio `Identity PASS` y `Registration PASS`, pero `Upload BLOCKED`, `Completion NOT REACHED` y `Cleanup NOT EXECUTED`. **No es un cierre** |
| **GC-AUTH-SESSION-RECOVERY-001** | **`OPEN`** · prevención **validada en banco** · **evidencia incidental en hardware** · **validación dirigida en dispositivo PENDIENTE**; supervivencia (D3) **`HARDWARE FUNCTIONAL PASS`** | D0 `02551a1`+`34412a0` · D2-B `08e3cd2` · D2-C `22a9b26` · D3 `cb59c7e` | Tras una ventana offline prolongada la sesión de Supabase desaparecía y 87 chunks quedaron sin poder subirse (22/08). **D2-B** (upgrade a 2.112.3) corrige la destrucción ante `500` / `502` / `525-529` y añade proactive-preserve y un cooldown de 60 s. **D2-C** clasifica `429` en el refresh como reintentable; todo lo demás hace pass-through fail-closed. **D3** es de otra naturaleza: no previene nada, da **salida local** a la evidencia de vídeo nativo segmentado que ya quedó varada. Validado en hardware el 24/08 (OnePlus A6000, modo avión, 12/12 segmentos, `status: complete`). **Ninguna de las tres cierra el finding**: la identidad sigue sin recuperarse, la subida sigue sin reanudarse y el ownership sigue sin restaurarse. Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5 |
| **GC-START-LATENCY-001** | `FIXED IN CODE` / **`HARDWARE VALIDATED`** | producto `e643b01` · guardas de test `3c10994` | `startRecording` esperaba a `getOwnershipAccessToken()` antes de abrir la grabadora, y esa ruta de auth **no lleva timeout en ninguna capa**. La lectura se movió dentro de `sessionCreatePromise`, que no se espera antes del productor. Validado en hardware el 24/08 en dos escenarios: **remoto vivo** — 531 ms tap→productor, 163 ms de lógica propia, 28/29 fragmentos confirmados **antes** de PARAR — y **token caducado + modo avión** — 243 ms tap→productor, 102 ms de lógica propia, con auth resolviendo **10,72 s después** de que el productor ya grababa. **auth no se volvió rápida: dejó de bloquear START.** Recuperación tras restaurar red: mismo `localSessionId`, 1 `POST /sessions`, 77/77 confirmados, cleanup posterior a `http_200`. Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §6 |
| **GC-DEST-STATUS-001** | **`OPEN`** · defecto de **backend** | — | Ningún camino de código escribe `revoked` ni `error`. Un destino Drive con refresh token revocado sigue reportándose `connected`. Ver [`API_SPEC.md`](./API_SPEC.md#estado-de-los-destinos--defecto-abierto) |
| **GC-AUTH-RETRY-CLASSIFICATION-001** | **causa suficiente demostrada** · relación causal con el 22/08 **no probada** | banco `9d682bc` · D2-B `08e3cd2` · D2-C `22a9b26` | Dejó de ser estático: el banco reproduce de forma determinista que un `429` / `500` en el refresh destruye una credencial **intacta** (`refresh_present: true`). Corregido para `500` por D2-B y para `429` por D2-C. **Sigue sin demostrarse** que el incidente del 22/08 fuera uno de esos dos: la respuesta nunca se capturó |

### Consecuencia sobre el veredicto

`GC-DEV-RESET-001` es **release blocker** por derecho propio: así lo declara
[`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §4. `GC-DEST-PAUSE-001` **no** lleva esa
etiqueta en §3 y este documento no se la añade; su revalidación física, que el
21/08 había quedado anulada, **se completó el 24/08**.
`GC-AUTH-SESSION-RECOVERY-001`
es el más grave de los abiertos: reproduce el modo de fallo que da nombre a
`GC-AUTH-001` —evidencia que no puede salir del dispositivo— por una causa
distinta y todavía sin corregir.

Desde el 2026-08-24 ese modo de fallo tiene una **salida parcial**, no una
corrección: D3 permite sacar del sandbox los segmentos MP4 de una captura de
vídeo nativo segmentado varada. La evidencia puede llegar a manos del usuario;
**no puede llegar a la nube**, y la identidad sigue sin recuperarse. El finding
continúa `OPEN` y sigue siendo el más grave del bloque.

### Dónde vive la evidencia

`GC-AUTH-SESSION-RECOVERY-001` y `GC-AUTH-RETRY-CLASSIFICATION-001` **ya
tienen registro en el repositorio**: [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5,
escrito al cerrar D2-B y D2-C.

`GC-START-LATENCY-001` **dejó de ser una ficha externa el 2026-08-24**: su
registro completo, con la evidencia de las dos corridas de hardware, vive en
[`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §6.

La ficha de `GC-DEST-STATUS-001` sigue **fuera del repositorio**, en el archivo
de evidencia congelada. No hay ningún documento en `docs/` que la contenga. Esa
asimetría es deuda documental conocida, no un descuido de este documento.

---

### Validación automática actual

Ejecutada el 2026-08-26 sobre el árbol posterior a `fc9a20e`.

| Comprobación | Resultado |
|---|---|
| Suite completa | **936/936**, en **42 ficheros** |
| Typecheck | **12 errores TypeScript históricos, cero nuevos** — typecheck **NO** verde |
| `git diff --check` | Limpio |

> Cortes anteriores: **360/360** el 20/08, **781/781 en 40 ficheros** el 23/08
> sobre `34412a0` y **792/792 en 41 ficheros** el 24/08 tras `3c10994`. El
> fichero 41 es `startLatencyDecoupling.test.ts`, que aportó 11 tests entre
> `e643b01` y `3c10994`. El fichero 42 es `localAssembly.test.ts`, que aportó
> los 108 tests de D3 en `cb59c7e`. Del resto de incrementos históricos **no hay
> recuento acreditado**, y este documento no se los atribuye a ningún cambio
> concreto.

> **`:gc-segmented-recorder:compileDebugKotlin` no se ha reejecutado.** Su
> `BUILD SUCCESSFUL` es del 20/08 y ningún commit posterior toca el módulo
> Kotlin; aun así, este documento no lo declara como resultado actual porque no
> se ha vuelto a compilar.

### Estado del gate

El gate de **validación hardware del vídeo nativo segmentado con durable
cleanup/scheduler integrado** quedó superado el 20/08 en su ruta normal, y la
**prueba dirigida de la frontera de borrado exclusiva por journal** (Escenario
17, punto 9) se superó ese mismo día con directorios centinela.

**No queda ningún gate bloqueante del Escenario 17 antes de integrar la rama.**

Los puntos 5 a 8 del Escenario 17 quedan como `HARDWARE_HARDENING_PENDING`: su
peor caso es limpieza diferida, no pérdida de evidencia, porque el journal es
durable y el siguiente arranque recoge el trabajo. No bloquean la integración.

Los bloqueos que siguen abiertos son de release y ajenos al Escenario 17:
cifrado local, recovery `I5c`, export `.mp4`, cobertura multi-dispositivo y
Android 13+.

---

## Baseline técnica congelada — `v0.3.0-rc.1` (2026-07-30)

Registro completo: [`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md).

| | |
|---|---|
| Commit construido | `5ac4a0314a9bfb62dcd97685ecb3295ae8257392` |
| Build EAS | `e98dd3a2-1448-43b5-a675-9116b5fa5ca3` (perfil `preview`, APK) |
| SHA-256 del APK | `A3A51604AE207D9DFA0C25241EF438C321065C758722C3794DE8860C208E0F2A` |
| Dispositivo de validación | OnePlus 6, Android 11 (SDK 30), `arm64-v8a` |
| Tests automáticos | **198/198 verdes** |
| TypeScript | **12 errores heredados**, cero nuevos → typecheck NO verde |

### Qué contiene

- **A-0 · A-1 · A-2** fusionadas (base `origin/main` @ `e656ea44`).
- **ReliabilityCard** (+538 líneas): petición contextual de `POST_NOTIFICATIONS`
  y exención de optimización de batería. Aislada — no importa nada de
  `recording`, `queue`, `worker`, `recovery` ni `export`, y usa clave propia de
  AsyncStorage (`gc.reliability.dismissed_at`).
- Configuración EAS repuntada a `@amarus/guardian-cloud`.

### Qué es y qué no es

**Es** un punto de retorno reproducible. **No es** una release pública: no hay
AAB de producción, ni Closed Testing, ni usuarios externos. Ver
[`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md).

### El veredicto `NO APTO` sigue vigente

La baseline **no levanta** el veredicto de la auditoría. Quedaban abiertas **en
esa baseline**:

- el **vídeo no saca evidencia del dispositivo durante la grabación**
  (GC-AUD-001) — **resuelto después** en `feat/native-segmented-recording` y
  demostrado en hardware el 20/08; no describe la rama actual;
- no existe `capture_end_reason`: no se puede probar finalización limpia;
- recovery **I5c** (tras reinicio del dispositivo, sin abrir la app) no
  implementado;
- cifrado local no implementado.

Las tres últimas siguen abiertas hoy.

A-1 y A-2 fueron **contención semántica**: cambiaron lo que el sistema afirma,
no lo que hace.

### Validación por nivel de evidencia

| Nivel | Alcance |
|---|---|
| **Verificado por instrumentación** | instalación, arranque estable, ausencia de excepciones fatales, `ENV READY`, `GC_BOOT_*`, worker en bucle, firma del APK, contenido del bundle, casos T2/T5/T9/T11/T12 |
| **Atestiguado manualmente** | grabación **de audio** y grabación **de vídeo** (ambas ejecutadas a mano); **subida de audio durante la grabación**; segundo plano y bloqueo; mala red; cierre forzado; reinicio con cola pendiente; recovery; exportación |
| **No ejecutado** | rama Android 13+ de `POST_NOTIFICATIONS`, T1/T3/T4/T6/T7/T8/T10, Closed Testing, usuarios externos |

> **En esta baseline, sólo el audio sacaba fragmentos del dispositivo durante la
> grabación.** El chunker en vivo corría cada 1,5 s únicamente en modo audio, y
> **el vídeo se fragmentaba y encolaba DESPUÉS de detener la captura**
> (`chunkVideoFile` post-`stop()`), así que durante una grabación de vídeo no
> salía nada del dispositivo.
>
> Esa limitación era **`GC-AUD-001`**, y su consecuencia era que el vídeo no
> cumplía el principio central de supervivencia del producto —«si grabas unos
> segundos, al menos una parte ya está fuera del dispositivo»—.
>
> «Grabación de vídeo atestiguada» significa, **para esta baseline**, que la
> captura, el chunking post-stop, la subida posterior y la exportación
> funcionaron. **No** significa que hubiera subida durante la captura.
>
> **`GC-AUD-001` quedó resuelto en `feat/native-segmented-recording`** mediante
> el productor nativo segmentado, y se demostró en hardware el 20/08. Este
> párrafo describe la baseline `v0.3.0-rc.1`, no el estado actual.

**Discrepancia de versión conocida:** la etiqueta se llama `v0.3.0-rc.1` pero la
aplicación declara `0.1.0` / `versionCode 1`. La etiqueta marca un punto de git,
no una versión de aplicación. Ver §7.1 del registro de baseline.

---

## Baseline funcional — `baseline-fea160c-android11-20260730` (2026-07-30)

Registro completo:
[`baselines/BASELINE_FEA160C_2026-07-30.md`](./baselines/BASELINE_FEA160C_2026-07-30.md).

| | |
|---|---|
| Commit | `fea160ccc5a7bb53997d60c901711106176fe9b5` |
| Rama publicada | `feat/reliability-card` |
| Build EAS | `0986770d-0f52-4eaf-956a-8811c8fc9122` (perfil `preview`, APK) |
| SHA-256 del APK | `cb8120af483a66a99e5a5fab711f4e1094f883dd56e458e51440a17dcbf24301` |
| Firmante (SHA-256) | `6aa7fa91a0d28c897ce008be184a1b9b7b98761283e035f605a8e33b126c921a` |
| Dispositivo | OnePlus 6, Android 11 (SDK 30), `arm64-v8a` |

### Dos cosas distintas que no deben mezclarse

**1 · Validaciones históricas del sistema.** Todo lo registrado en el resto de
este documento —incluida la tabla «Validación por nivel de evidencia» de la
baseline `v0.3.0-rc.1` y los apartados de audio, recovery y export— corresponde
a artefactos **anteriores**. No fue reejecutado con la APK de esta baseline.

**2 · Validación concreta de esta APK.** Se limita a: **instalación limpia
correcta**, **arranque del paquete en dispositivo real**, **interfaz renderizada
sin cierre inmediato** y **uso observado por el propietario**. Nada más.

La frase del tag *«Core application works on the tested device»* se interpreta
de forma estricta con ese alcance: instalación, arranque y uso observado en ese
dispositivo. **No** es validación de resiliencia.

### Qué sigue sin validar con esta APK

Android 13+ y `POST_NOTIFICATIONS`; la matriz completa de mala red, segundo
plano, cierre forzado, reinicio, recovery y export; actualización conservando
datos previos; múltiples dispositivos; usuarios externos; publicación en Play
Store; y el motivo por el que la Reliability Card no apareció en Home
—cuestión abierta que impide considerarla validada en dispositivo—.

Esta baseline **no levanta** el veredicto `NO APTO` de la auditoría 2026-07-28.
En su momento `GC-AUD-001` seguía abierto; se resolvió después en
`feat/native-segmented-recording`.

---

## Current MVP status

The MVP currently supports:

- Google Drive OAuth connection
- Backend callback to mobile deep link
- Session creation
- Audio recording
- Native segmented video recording
- Native MP4 segment adoption and upload during capture
- Chunk generation
- Real chunk upload to Google Drive
- Chunk metadata registration
- Persistent pending recovery state
- Recovery after app kill
- Recovery after device reboot
- Session completion
- Durable cleanup journal, runner and single-flight scheduler — hardware
  validated on 2026-08-20 for the normal path; artificial failure paths still
  pending
- Audio evidence export from a given session (download chunks via backend
  proxy, verify sha256, concatenate in order, write `.m4a` to
  `documentDirectory`, produce a partial result when chunks are
  missing/corrupt)

## Current validated criterion

The validated audio path can record, generate chunks, upload them to Drive,
recover pending chunks after failure, complete the session, clean local state,
and export evidence as a single `.m4a`.

Separately, native segmented video generation, adoption and **upload during
capture** were physically validated on 2026-08-20, together with the durable
cleanup scheduler on its normal path and with recovery of a pending session
after a Drive credential outage. First confirmed upload at `+14.619 s` against a
stop at `+75.514 s`, with 11 of 12 chunks confirmed before the user stopped
recording.

That validation covers a single device — OnePlus A6000 / Android 11 / API 30 /
`arm64-v8a`. Complete native-video recovery, final `.mp4` export,
multi-device coverage and the scheduler's artificial failure paths are **not**
declared physically validated.

## Product status — HISTÓRICO / SUPERSEDED

> **HISTÓRICO / SUPERSEDED — NO representa el veredicto actual.**
>
> Este apartado es el veredicto de una baseline anterior, previo a la auditoría
> del 2026-07-28. Se conserva como registro; **contradice** la cabecera de este
> mismo documento, y en ese conflicto **gana la cabecera**.
>
> El veredicto vigente es `NO APTO PARA RELEASE`, y el estado por capacidad se
> lee en [Capacidades por nivel](#capacidades-por-nivel-referencia-canónica) y
> en [Findings abiertos](#findings-abiertos-de-identidad-destino-y-herramientas).

Lo que aquella baseline afirmaba, en sus propios términos:

> The system is no longer a prototype.
>
> The historical audio/legacy MVP path has been validated under:
>
> * app kill
> * network loss
> * background execution
> * recovery after restart
>
> This confirms:
>
> > Guardian Cloud fulfills its core promise: evidence survival under real conditions

**Por qué no se sostiene hoy.** La auditoría del 2026-07-28 retiró
explícitamente esas tres afirmaciones —«validado bajo kill, pérdida de red,
background y reinicio», «el sistema ya no es un prototipo» y «cumple su promesa
central»— por no tener ni un registro de prueba detrás.

Y hay una razón vigente, no sólo histórica: **`GC-AUTH-SESSION-RECOVERY-001`
sigue `OPEN`.** El 2026-08-22, en hardware, un dispositivo con 87 chunks de
evidencia sin subir perdió su sesión de Supabase y la evidencia quedó sin poder
salir del dispositivo. Mientras ese defecto siga abierto, este repositorio **no
afirma** que Guardian Cloud cumpla su promesa central de forma general.

---

## Current focus

* usability under stress
* fast activation
* user validation

Not:

* new features
* advanced security
* system expansion
---

## Audio pipeline updates (v0.3.3)

### Audio chunk persistence migration

Audio chunks no longer persist inline `base64Slice` payloads inside GC_QUEUE.

Current behavior:
- audio chunks are written to disk under:
  `documentDirectory/chunks/{sessionId}/{chunk_index}.b64`
- GC_QUEUE stores metadata + `local_uri`
- upload worker rehydrates payloads from disk

Reason:
Long audio sessions (~200+ chunks) exceeded the Android SQLite
CursorWindow per-row limit when chunk payloads accumulated directly
inside AsyncStorage.

Result:
- stable queue performance during long recordings
- recovery preserved
- export preserved
- upload worker unchanged
- legacy queue entries remain compatible

Validated:
- long recordings (300+ chunks)
- backend crash + restart
- app restart during drain
- recovery after interruption
- export reconstruction

### Audio chunk size

Audio chunk size increased:

- previous: 16 KB
- current: 32 KB

Reason:
Reduce request overhead and improve sustained upload throughput during
long-running recordings.

Tradeoff accepted:
- first protected chunk slightly slower
  (~3 s → ~4.5 s)
- lower request count
- better sustained draining stability

Compatibility safeguard:
Legacy rehydration fallback now derives stride from `chunk.size`
instead of the global chunk constant to avoid HASH_MISMATCH risks after
the migration.

## Cross-device recovery

Estado: VALIDADO EN CONDICIONES REALES

Capacidades:
- discovery cross-device
- reconstruction from manifest
- partial recovery
- export from recovered evidence

---

## Incremental manifests and partial cross-device recovery (v0.3.4)

Status: ✅ validated on real device

Guardian Cloud now writes incremental Drive manifests during recording/upload, not only after session completion.

### What changed

Partial manifests are generated:
- after the first uploaded chunk
- every 10 uploaded chunks
- once more as final manifest when the session completes

The manifest keeps the same deterministic filename:

`{sessionId}_manifest.json`

and is overwritten as the session progresses.

### Why

Previously, chunks could survive in Google Drive while the session was still undiscoverable from another device.

Failure case fixed:
1. start recording
2. upload some chunks
3. lose connection / enable airplane mode
4. uninstall the app
5. reinstall on another device
6. open recovery

Before this change:
- uploaded chunks existed in Drive
- but no manifest existed yet
- recovery only showed older completed sessions

Now:
- partial manifests make interrupted sessions discoverable
- recovery can show them as partial
- uploaded evidence can be exported even if the original app install is gone

### Architecture

- Backend writes partial manifests fire-and-forget after chunk upload registration.
- Chunk upload response is not blocked by manifest generation.
- `GC_QUEUE` is unchanged.
- Mobile worker is unchanged.
- Export pipeline is unchanged.
- Drive OAuth is unchanged.
- Final complete manifest still overwrites the partial manifest on `/complete`.

### Partial recovery behavior

Audio:
- partial `.aac` recovery is usable because AAC ADTS frames are self-framing.

Video, para la ruta histórica que trocea un único archivo después de detener:
- partial `.mp4` recovery may not be directly playable if the MP4 metadata/moov atom was not written yet.
- It is still preserved as forensic partial evidence.

Los segmentos producidos por la ruta nativa actual son MP4 independientes y
fueron reproducibles en la validación del 13/08. Esa evidencia no demuestra el
recovery completo de una sesión nativa ni un export final `.mp4`.

### Validated scenario

Real-device test passed:

- started recording
- waited for chunks + partial manifest
- enabled airplane mode
- uninstalled app
- reinstalled APK
- opened recovery
- partial session appeared
- partial recovery/export worked

This closes the gap where evidence chunks survived remotely but were not discoverable after local state loss.

### Legacy post-stop video upload pipeline optimization (validated)

Status: ✅ validated on real device

Changes:
- Increased `VIDEO_FILE_CHUNK_SIZE` from 32 KB → 128 KB.
- Reduced POST/upload request count ~4× for typical MVP-sized videos.
- Preserved:
  - disk-backed queue
  - recovery flow
  - export compatibility
  - completion gate
  - cleanup/reap behaviour
  - background draining

Why:
The previous 32 KB strategy generated excessive request overhead for
video uploads (~150-160 chunks for ~5 MB recordings). Real-device
testing showed the bottleneck was request count, not local disk IO.

Result:
- Faster drain throughput.
- Smaller queue metadata pressure.
- Less post-stop waiting time before protection completes.
- Stable exports and playback after upload.

Real-device validation completed:
- short recording
- near-MVP-cap recording
- upload completion
- export playback
- recovery after restart

Important:
This optimization only affects the post-stop video chunking pipeline.
It is a historical validation of that legacy path, not evidence for complete
native-video recovery, final `.mp4` export or the integrated durable cleanup
scheduler.

Audio live-stream chunking remains independent and optimized separately
(32 KB disk-backed audio chunks).