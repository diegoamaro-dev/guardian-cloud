# IMPLEMENTATION_STATUS.md

⛔ NO APTO PARA RELEASE — por cifrado local, recovery `I5c`, export `.mp4`, cobertura de dispositivos **y findings de identidad/destino todavía no cerrados**. **Ya no por `GC-AUD-001`.**

| Qué | Cuándo / sobre qué |
|---|---|
| Estado documental vigente | **2026-10-03** |
| Producto usado para la revalidación de `GC-DEST-PAUSE-001` | **`22a9b26`** (APK release `2b3be062…`) |
| Producto usado para la validación de `GC-START-LATENCY-001` | **`e643b01`** (APK release `1cb80fea…`) |
| Producto usado para la validación de **D3 local segment salvage** | **`cb59c7e`** (APK release `8151c338…`) |
| Producto usado para la **revalidación S1 BENCH** (G-R1 + H1 + R1 presentes) | **`3a68699`** (APK de banco, build EAS `5999431a-d487-4330-8692-84ad00c23c62`) |
| Última suite automática registrada | **2026-10-04**, anclada a **`d9bf343158e04c0d7779332baea60d2ad9033a78`** — **1102/1102 en 49 ficheros** · typecheck **12 errores heredados, cero nuevos**, por tanto **NO** verde. Cortes anteriores ya anclados: **1094/1094 en 49 ficheros** sobre **`8ea3fea`**, **1072/1072 en 48 ficheros** sobre **`ee53962`**, **1040/1040 en 48 ficheros** sobre **`39d6d05`**, **1021/1021 en 47 ficheros** el 2026-10-03 sobre el árbol del gate **E1-BENCH-OAUTH-SCHEME** medido antes de commitearlo, 1014/1014 tras **`b1f73aa`** y 1007/1007 tras **`ccbf4fa`** |
| Aislamiento de build y de proyecto Supabase | **`ccbf4fa`** — ver [la sección propia](#aislamiento-de-build-e1--android-y-proyecto-supabase) |

> Las fechas y los commits son distintos a propósito, y no deben fundirse. La
> suite vigente —1102/1102 en 49 ficheros— se midió sobre el árbol de
> `d9bf343`; las tres validaciones de hardware se hicieron en dispositivo, no
> corriendo la suite, y cada una sobre **su propio APK**:
> `GC-DEST-PAUSE-001` sobre `22a9b26`, `GC-START-LATENCY-001` sobre `e643b01` y
> **D3** sobre `cb59c7e`. **Ninguna cifra de tests describe un APK.**

> **Corte anterior: 2026-08-20.** Entre el 20/08 y el 23/08 la rama
> `fix/gc-auth-001-main-integration` incorporó seis commits que este documento
> no reflejaba. La sección
> [Findings abiertos](#findings-abiertos-de-identidad-destino-y-herramientas)
> los recoge con su estado exacto.

Fuentes de continuidad y evidencia:

* [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) — límites vigentes y findings;
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
| Continuous Protection — continuidad `VIDEO_AUDIO → AUDIO_ONLY` al perder el primer plano | **Capacidad: no implementada ni validada.** Contrato aceptado el 2026-08-25. **Infraestructura parcial y precondiciones ya publicadas**, sin cambio de comportamiento observable: `8983bad` añadió la metadata durable `evidence_closed`, `6c6489c` desacopló el camino de **lectura** de terminalidad hacia `/complete`, `fc9a20e` añadió `media` por chunk y la clasificación **fail-closed** de D3, y `142c1f9` publicó el contrato de `media` por chunk en backend y manifiesto. La **escritura** sigue acoplada y la transición no existe: minimizar durante vídeo cierra la sesión igual que antes. Decide [`decisions/ADR-CONTINUOUS-PROTECTION.md`](./decisions/ADR-CONTINUOUS-PROTECTION.md); su criterio de prueba es el escenario 18 de [`TEST_SCENARIOS.md`](./TEST_SCENARIOS.md), que sigue `DEFINIDO` |

> **`fc9a20e` es una precondición de INTEGRIDAD, no Continuous Protection
> funcionando.** Retira un modo de fallo de D3 —habría podido copiar bytes de
> audio como `segment_NNNNNN.mp4` y acreditarlos por `sha256`— haciendo que la
> elegibilidad se decida **por chunk** y exigiendo la firma estructural
> `segments/<session_id>/segment_NNNNNN.mp4`. **D3 no soporta sesiones mixtas:
> las rechaza.** Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5.
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

### Endurecimiento previo a recovery — R1 y precondición A (2026-10-04)

Dos cambios de código que **preparan** la recuperación de identidad sin
habilitarla. Ninguno es una capacidad de producto y ninguno está validado en
hardware.

| Pieza | Estado | Publicado en |
|---|---|---|
| **R1 · veto de anclaje no verificable** | `IMPLEMENTED / TESTED` · `NOT HARDWARE VALIDATED` | `3a68699` |
| **Precondición A · barrera de recovery** | `IMPLEMENTED / TESTED` · `NOT HARDWARE VALIDATED` | `8ea3fea` |

**R1.** Una ranura de marker vacía no siempre es una primera identidad: puede
ser una identidad que existió y cuyo marker nunca aterrizó. Donde el
dispositivo conserva prueba durable de que **alguna** identidad ya puso
evidencia en la nube desde esta instalación, `markIdentityInitialized()`
**rechaza crear un ancla** —`prior_identity_unverifiable`— en lugar de adoptar
la sesión viva. Es un **veto y sólo un veto**: la prueba acredita que existió
una identidad, **nunca cuál**, y no autoriza a nadie. Una instalación limpia no
puede activarlo, porque la dependencia es circular —subir exige token, el token
exige marker durable—, así que `FIRST_IDENTITY` queda intacto.

**Alcance y límite de R1.** No cierra el caso de los dispositivos cuya prueba
local **ya fue cosechada**: el reap del camino feliz borra la entrada de cola y
con ella el veto, y esos vuelven a la conducta anterior. **R1 estrecha el
agujero, no lo cierra.** Es una limitación registrada, no un finding con
seguimiento propio.

**Precondición A.** `RECOVERY_ENTRY_IMPLEMENTED` pasó a su propio módulo,
`mobile/src/auth/recoveryEntry.ts`, cuya única responsabilidad es declarar la
capacidad. El motivo no es de estilo: un `const` leído dentro de su propio
módulo es un binding directo, así que la rama `true` de la barrera era
**inejecutable en test**. Separada, se ejecuta de verdad.

**Estado productivo: `RECOVERY_ENTRY_IMPLEMENTED = false`.** Es la única
declaración del repositorio, sin configuración en runtime, sin variable de
entorno y sin inyección. La rama `true` **está ejercitada automáticamente y NO
está activa en producción**: el único sitio que la pone en `true` es el mock de
`mobile/tests/recoveryBarrier.test.ts`.

Lo que esa cobertura demuestra, con la barrera activa: el back-fill rechaza con
`recovery_entry_exists` **sin escribir**, la continuidad posterior es
`continuity_unverifiable`, no se emite `OwnershipToken`, el ancla **no se mueve**
ante un mismatch, y ninguna ruta de bloqueo borra, reasigna ni re-keyea
`GC_QUEUE` ni la evidencia local. Y un test de acoplamiento fija la obligación
futura: **si aparece una ruta de sesión por recovery, el flag debe ser `true`**
— el commit que introduzca OTP y el que apague el back-fill tienen que ser el
mismo.

#### La regla de ownership, ya decidida

Una instalación **sin ancla histórica demostrable queda no recuperable
automáticamente**. No se permiten heurísticas para atribuir ownership: ni
`sub_prefix`, ni identificadores de sesión, ni el contenido de `GC_QUEUE`, ni
ninguna otra correlación. Ante identidad no demostrable o discrepancia se falla
cerrado, **preservando `GC_QUEUE` y la evidencia local**.

#### Lo que NO cambia

- **`GC-AUTH-SESSION-RECOVERY-001` sigue `OPEN`.**
- **El recovery por OTP sigue `NOT IMPLEMENTED`**: no existen `signInWithOtp`,
  `verifyOtp` ni `setSession` en el código.
- **La precondición B sigue pendiente, y exclusivamente por la secuencia
  operacional de releases:**

  ```
  release con G-R1/anclaje → ventana de anclaje → release posterior con OTP
                                                  + RECOVERY_ENTRY_IMPLEMENTED=true
  ```

  La ventana de anclaje **todavía no ha empezado**: ningún artefacto
  distribuido contiene G-R1.
- **Ninguno de los dos añade validación en hardware**, ni adversarial ni de
  ningún otro tipo. S1 sólo acreditó el camino legítimo de primera identidad.
- **El veredicto de producto sigue siendo `NO APTO PARA RELEASE`.**

#### H-1 · el acoplamiento ya no depende de una lista escrita a mano

**`FIXED IN TESTS / AUTOMATED VALIDATION` · `NOT HARDWARE VALIDATED`**, corregido
en `d9bf343158e04c0d7779332baea60d2ad9033a78`.

El test de acoplamiento tenía dos huecos, y los dos habrían afectado al primer
commit de G-R3:

- **falso negativo**: escaneaba una lista de siete ficheros escrita a mano, así
  que una ruta de recovery en una pantalla nueva —que es exactamente donde
  viviría— le resultaba invisible. Ahora recorre **los árboles completos** de
  `mobile/src` y `mobile/app`, sólo ficheros de producción. Se justificó en su
  primera ejecución: encontró un identificador en un fichero que la lista
  anterior no cubría;
- **falso positivo**: se apoyaba en el identificador `verifyOtp`, que **no se
  puede clasificar por su nombre**. Con `type: 'email_change'` confirma un
  cambio sobre la sesión ya viva —la Fase 1 de G-R3, vincular un email de
  recuperación— y no puede producir sesión para otra identidad.
  **`verifyOtp(type:'email_change')` no se considera recovery**, y el tipo se
  lee como token entrecomillado completo para que `email_change` no case como
  subcadena de `email`.

**Las rutas capaces de crear o restaurar una sesión sí exigen la barrera**:
`signInWithOtp`, `exchangeCodeForSession`, `signInWithOAuth`,
`signInWithIdToken`, `verifyOtp` con cualquier tipo que devuelva sesión, y
`setSession` cuando la llamada va sobre un objeto `auth`. `signInAnonymously`
queda fuera: es el acuñado legítimo, no una recuperación.

**Los casos ambiguos fallan cerrado**: un `verifyOtp` cuyo `type` no se puede
leer cuenta como recovery. Ante la duda, exigir la barrera.

Los límites del barrido de texto —un alias desestructurado se escaparía, y
`signInWithPassword` queda fuera de la lista a propósito— están escritos en el
propio test y quedan como **limitación aceptada**, no como trabajo pendiente.

**`RECOVERY_ENTRY_IMPLEMENTED = false` sigue siendo el estado productivo** y la
única declaración del repositorio; el único sitio que la pone en `true` es el
mock del fichero de test. **G-R3 / OTP sigue `NOT IMPLEMENTED`**,
**`GC-AUTH-SESSION-RECOVERY-001` sigue `OPEN`** y el veredicto de producto no se
mueve: **`NO APTO PARA RELEASE`**.

### Revalidación hardware S1 — BENCH, 2026-10-04

Artefacto: APK de banco construido desde
**`3a68699c6e8c19bae00ec2a5404e9a0db972b966`**, build EAS
`5999431a-d487-4330-8692-84ad00c23c62`, package `com.guariacloud.app.bench`.
Dispositivo: **OnePlus A6000 · Android 11 · API 30**. Backend de banco local en
`:3101`, Supabase de banco, destino Google Drive conectado en banco.

**Es el primer artefacto que contiene G-R1, H1 y R1.** Todos los anteriores son
previos a `39d6d05`, así que ninguna validación de hardware anterior cubre esta
ruta de identidad: por §13 del `CLAUDE.md`, una validación no se hereda a un
artefacto nuevo.

En el primer arranque posterior al borrado controlado de datos de banco se
observó **`FIRST_IDENTITY`** seguido de autenticación anónima correcta y
**marker durable**; esta corrida valida únicamente el **camino legítimo de
primera identidad**, no las ramas adversariales de G-R1/H1/R1.

#### Dos resultados, con alcances distintos

| Propiedad | Estado | Evidencia observada |
|---|---|---|
| **Subida durante la grabación** | `HARDWARE_VALIDATED` 2026-10-04 | sesión nueva: el backend registró `DRIVE_CHUNK_UPLOAD_SUCCESS` **antes** de `/sessions/{id}/complete`; la sesión cerró y produjo manifiesto final de **19 chunks** |
| **Recovery post-fallo de red/destino** | `HARDWARE_VALIDATED` 2026-10-04 | sesión anterior: **16 chunks** quedaron pendientes por red y destino no resuelto, **sobrevivieron en `GC_QUEUE`**, se evacuaron automáticamente al restaurar la red y conectar Drive, y la sesión se completó con manifiesto de **16 chunks** |

Son **dos corridas distintas y no se funden**: la primera demuestra que la
evidencia sale del dispositivo mientras la captura sigue viva; la segunda, que
lo que quedó varado no se pierde y drena solo. **Ninguna de las dos demuestra la
otra.**

#### Lo que esta corrida NO demuestra

No está validado en hardware, y no se declara como tal:

- **el back-fill de un marker pre-G-R1** sin propiedad `user_id`;
- **la discrepancia de `user_id`** — la rama `continuity_mismatch` de G-R1;
- **el marker corrupto o ilegible** — las ramas de H1;
- **`prior_identity_unverifiable`** — el veto de R1;
- **la recuperación de una identidad perdida.**

Ninguno de esos estados se indujo. Su cobertura sigue siendo **exclusivamente
automática**.

Y no se mueve nada de lo siguiente:

- **`GC-AUTH-SESSION-RECOVERY-001` sigue `OPEN`**: aquí no se recuperó ninguna
  identidad, y el recovery por OTP sigue **`NOT IMPLEMENTED`**.
- **Las precondiciones A y B siguen `OPEN`.**
- **`I5c` sigue sin validar**: recovery autónomo tras reinicio sin abrir la app.
- **El veredicto de producto sigue siendo `NO APTO PARA RELEASE`.**

Lo que sí añade, y es lo que se buscaba para la beta: los tres cambios de la
ruta de identidad **no rompen el camino normal en hardware**, y los dos
invariantes operativos que esa ruta podía haber comprometido —evidencia fuera
del dispositivo durante la captura, y supervivencia de la cola— se observaron
funcionando sobre el artefacto que los contiene.

### Aislamiento de build (E1) — Android y proyecto Supabase

Publicado en **`ccbf4fa999545da075d21921937d70f0e9b12d99`** (2026-10-03). No es
una capacidad de producto: es la separación entre un build de **banco** y uno de
**producción**. Se registra aquí porque es la fuente canónica de qué está
implementado y con qué evidencia.

```
ANDROID INSTALL ISOLATION        = HARDWARE VALIDATED   OnePlus A6000, 2026-10-03
BENCH DEEP-LINK SCHEME ISOLATION = HARDWARE VALIDATED   OnePlus A6000, 2026-10-03
EAS ENVIRONMENT ISOLATION        = IMPLEMENTED / TESTED / OBSERVED
SUPABASE PROJECT CONFIGURATION (BENCH artifact) = OBSERVED
JWT CROSS-PROJECT ISOLATION  BENCH → PROD       = DYNAMICALLY VALIDATED
JWT CROSS-PROJECT ISOLATION  PROD  → BENCH      = NOT EXECUTED / INFERRED
```

> **`SUPABASE PROJECT ISOLATION` deja de existir como etiqueta única.** Agrupaba
> tres cosas de evidencia muy distinta —qué proyecto configura el artefacto, qué
> entorno entrega EAS, y si la frontera de autenticación rechaza una credencial
> ajena—, y mantenerlas bajo un solo nombre invitaba a atribuir a una lo
> demostrado por otra. Las tres últimas líneas la sustituyen. Registro
> reconstruible de E2 en
> [`VALIDATIONS/E2_SUPABASE_PROJECT_ISOLATION_2026-10-03.md`](./VALIDATIONS/E2_SUPABASE_PROJECT_ISOLATION_2026-10-03.md).
>
> **Qué observó E2.** En el APK instalado —verificado por `sha256`— la única URL
> Supabase configurada es la de `rgbsofvycynhabycetel` y la API es
> `http://192.168.178.21:3101`; el ref de producción aparece **sólo como
> constante de la tabla de guarda**, nunca como URL configurada. Y con un JWT
> **real** emitido por `guaria-auth-test`: `GET /recovery/manifests` contra el
> backend de banco dio **200** con `drive_not_connected: true` —el
> `authMiddleware` se superó—, y **el mismo token** contra
> `api.guardiancloud.app` dio **401 `UNAUTHORIZED`**, antes del handler.
>
> **Lo que esa observación no dice.** El `401` es opaco por diseño, así que
> **no determina** si el rechazo lo produjo el issuer fijado o la verificación de
> firma; el código señala ambos como mecanismos, y no se atribuye causalidad.
> **No hay aislamiento bidireccional dinámicamente validado**: el sentido
> producción → banco **no se ejecutó**, porque exigiría un JWT de producción, y
> permanece inferido por identidad de código. Nada de E2 es `HARDWARE VALIDATED`:
> no ejercita dispositivo, ni captura, ni cola, ni subida, ni recovery, ni export.

> **Las dos primeras se validaron en hardware el 2026-10-03.** Registro completo
> y reconstruible en
> [`VALIDATIONS/E1_BENCH_ISOLATION_2026-10-03.md`](./VALIDATIONS/E1_BENCH_ISOLATION_2026-10-03.md).
> Procedencia del artefacto probado:
>
> ```
> commit        77bef24a1f9d544dba3cc1da2c882fff8497c914
> EAS build     5c86cd00-8a75-40ba-99ff-0e93b7bec748
> APK sha256    402e9b85f5ab12b9e99ba22d3a01afbafda46210c1cb037888c1a9fcc0a927cf
> package       com.guariacloud.app.bench      label  Guardian Cloud BANCO
> keystore      Build Credentials d5yCcmQnkP (default) — reutilizado, no generado
> dispositivo   OnePlus A6000 · Android 11 · API 30
> ```
>
> **Qué se observó**, en este orden: el manifest **empaquetado** del APK registra
> `guardiancloudbench`, **no** registra `guardiancloud` y conserva
> `exp+guardian-cloud`; `adb install -r` dio `Success` y la actualización
> **conservó `firstInstallTime`** —2026-10-03 10:40:39— moviendo sólo
> `lastUpdateTime`, y el `sha256` del `base.apk` instalado es el del artefacto
> validado; **los tres packages coexisten** —`com.guardiancloud.app`,
> `com.guariacloud.app` y `com.guariacloud.app.bench`— sin que las marcas de
> tiempo de los dos primeros cambiaran; el Package Manager resuelve
> `guardiancloudbench://oauth/drive` a **un único** candidato, banco, y
> `guardiancloud://oauth/drive` a los **dos** packages no-banco, sin banco entre
> ellos; y el lanzamiento real del deep link, con banco **vivo en segundo
> plano**, dio `Status: ok` · `LaunchState: HOT` ·
> `Activity: com.guariacloud.app.bench/com.guardiancloud.app.MainActivity`, con
> transición launcher → banco y **ninguna otra aplicación de la familia en
> foreground**.
>
> Como todo `HARDWARE VALIDATED` de este documento, significa **validado en ese
> dispositivo**. No implica cobertura multi-dispositivo ni Android 13+.

> **Qué significa `TESTED` y qué añade `OBSERVED`.** `TESTED` acredita pruebas
> automáticas sobre configuración estática; **no** es `UNIT_TESTED` de lógica de
> producto y **no** equivale a `HARDWARE VALIDATED`. `OBSERVED` añade que la
> configuración se leyó en el artefacto o en una corrida real del CLI, no sólo en
> el repositorio. El reparto de entornos de EAS **sigue sin ejercitarse en un
> dispositivo**, y por eso no pasa de ahí.

> **Lo que la validación del 2026-10-03 NO acredita.** **OAuth real y Drive en
> banco siguen SIN VALIDAR**: no se ejecutó ningún flujo, no se conectó Drive y
> no se tocó Google ni el backend; la URI de prueba no llevaba `code` ni
> `state`, y el `MOBILE_OAUTH_REDIRECT` del backend de banco sigue en
> `unused://bench`. **`GC-OAUTH-SCHEME-COLLISION-001` sigue `OPEN`** —lo
> validado es la exclusividad entre **nuestros** builds, no el finding, y un
> tercero puede seguir registrando `guardiancloud://`— y
> **`GC-OAUTH-NOSTATE-001` sigue `OPEN`** y sin tocar. Tampoco se ejercitó
> captura, `GC_QUEUE`, worker, subida, recovery, cleanup ni export.

| | production | bench |
|---|---|---|
| `applicationId` | `com.guariacloud.app` | `com.guariacloud.app.bench` |
| Nombre visible | `Guardian Cloud` | `Guardian Cloud BANCO` |
| Scheme de producto | `guardiancloud` | `guardiancloudbench` |
| Proyecto Supabase | `nahksdkcvhveoctpjrea` | `rgbsofvycynhabycetel` (`guaria-auth-test`) |

> **Scheme del deep link, por variante — OBSERVADO el 2026-10-03.** El
> `<intent-filter>` de `src/main/AndroidManifest.xml` usa el placeholder
> `${gcDeepLinkScheme}` y cada `productFlavor` declara su valor; `buildVariant`
> es la única fuente y `app.config.ts` deriva de ella el `scheme` que lee
> `expo-linking`. Comprobado en los manifests **combinados** que generan
> `processProductionReleaseManifest` y `processBenchReleaseManifest`: producción
> queda con `guardiancloud` y banco con `guardiancloudbench`, los dos con
> `exp+guardian-cloud` —el scheme del Dev Client, compartido por decisión
> explícita—. **Banco ya no registra `guardiancloud`.**
>
> No se eligió un `AndroidManifest.xml` en `src/bench/` porque un
> `<intent-filter>` de flavor **se suma** al de `main` en vez de reemplazarlo:
> banco habría registrado los dos schemes, que es el defecto a evitar.
>
> El `linkingURI` del foreground service dejó de ser un literal y sale de la
> misma fuente: con un valor fijo, pulsar la notificación de banco habría
> abierto la aplicación de producción, la única que registra ese scheme.
>
> **Qué acredita y qué no.** Elimina la colisión de deep link **entre nuestros
> dos builds** — [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §8—. **No cierra
> `GC-OAUTH-SCHEME-COLLISION-001`**, que sigue `OPEN` porque un tercero puede
> registrar `guardiancloud://`; **no toca `GC-OAUTH-NOSTATE-001`**, también
> `OPEN`; **no es validación en hardware**; y **no afirma que Google Drive
> funcione en banco**, que sigue bloqueado por la configuración de OAuth en
> Google.

**Dónde vive el aislamiento Android, y dónde NO.** En los `productFlavors` de
`mobile/android/app/build.gradle` —cada flavor declara su `applicationId`
**completo**, y `defaultConfig` ya no declara ninguno— y en el source set
`mobile/android/app/src/bench/`, que aporta su propio `app_name`. **No** en `app.config.ts`: `android.package` y `name` del config de
Expo sólo llegarían al nativo a través de `expo prebuild`, que no es un paso de
build de este repositorio —ver [`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md) §3.1—.
Un mecanismo apoyado en el config de Expo no habría tenido efecto en la ruta
real, y antes de `ccbf4fa` no lo tenía: un build de banco se instalaba con el
`applicationId` y el nombre de producción, encima de ella.

> **Por qué `applicationId` completo y no un sufijo.** La primera versión de
> este mecanismo usaba `applicationIdSuffix '.bench'`. **EAS CLI 24.10.0 lo
> rechazó antes de llegar a construir nada**, al resolver la versión remota del
> perfil `bench`: *«"applicationIdSuffix" in app/build.gradle is not supported,
> configure the full application ID under productFlavors»*. Expo lo documenta en
> `build-reference/variants` —«EAS CLI supports only the `applicationId`
> field»—, y falla cerrado en vez de resolver un identificador equivocado, que
> es el comportamiento correcto: un identificador mal leído es exactamente la
> barrera que impide que banco se instale encima de producción. Se sustituyó por
> el `applicationId` completo en cada flavor, que es la forma que documenta Expo
> para este caso. **En la misma corrida, EAS confirmó por escrito que
> `android.package` de `app.config.ts` se ignora por existir el directorio
> `android/`**: manda Gradle, como decía §3.1 del checklist.
>
> **Verificado tras la corrección**, con una segunda corrida del mismo comando
> read-only: el error de `applicationIdSuffix` desaparece y
> `build:version:get` ya no falla. Eso acredita que EAS **lee** la
> configuración de flavors; **no** acredita qué `applicationId` acaba dentro de
> un APK, porque no se ha construido ninguno.
>
> `defaultConfig` dejó de declarar `applicationId` para que exista **una sola
> fuente por flavor**. Con el valor en los dos sitios Gradle resolvería bien
> —el flavor gana—, pero cualquier herramienta que leyera `defaultConfig`
> primero vería el id de producción también para banco, y en silencio.

**`namespace 'com.guardiancloud.app'` permanece deliberadamente intacto**, junto
con los paquetes Kotlin `com.guardiancloud.*`. Un flavor sólo modifica
`applicationId`, así que la divergencia que decide
[`decisions/ADR-ANDROID-APPLICATION-ID.md`](./decisions/ADR-ANDROID-APPLICATION-ID.md)
se conserva por construcción, no por cuidado.

**El proyecto Supabase está anclado 1:1 y de fallo cerrado.** `src/config/projectRefs.ts`
declara un único proyecto autorizado por entorno y `src/config/env.ts` rehúsa
arrancar si el proyecto alcanzado no es ése. Un entorno sin proyecto declarado
también se rechaza: ausencia significa «no declarado», nunca un valor por
defecto. No existe variable ni flag que relaje la comprobación en un build; el
único sustituto de la tabla es el import, es decir las pruebas. El project ref
no es un secreto —viaja en cada APK— y las claves no están ahí.

Evidencia de este corte:

* suite **1007/1007 en 47 ficheros**; typecheck en los **12 errores heredados**,
  sin añadir ninguno;
* 25 pruebas nuevas: 13 del contrato nativo, 12 de la guarda, incluidos los
  cruces `production ↔ bench` en ambos sentidos y el tercer proyecto;
* `./gradlew :app:assembleBenchRelease --dry-run` y
  `:app:assembleProductionRelease --dry-run` = **PASS**, los dos
  `BUILD SUCCESSFUL`, sin generar artefactos.

Lo que **falta**:

* **el cruce `PROD → BENCH`**: no ejecutado, inferido por identidad de código;
* **el reparto de entornos de EAS** no se ha ejercitado en un dispositivo;
* **OAuth real y Drive en banco**: sin validar.

El contacto real con Supabase **ya está acreditado** desde E2: un JWT emitido por
`guaria-auth-test` superó el backend de banco y fue rechazado por el de
producción. Ver
[`VALIDATIONS/E2_SUPABASE_PROJECT_ISOLATION_2026-10-03.md`](./VALIDATIONS/E2_SUPABASE_PROJECT_ISOLATION_2026-10-03.md).

Lo que **ya no falta**, desde el 2026-10-03: existe un APK BENCH construido,
instalado y actualizado en sitio, y la coexistencia de las tres aplicaciones en
el dispositivo **está observada**. Ver
[`VALIDATIONS/E1_BENCH_ISOLATION_2026-10-03.md`](./VALIDATIONS/E1_BENCH_ISOLATION_2026-10-03.md).

La configuración remota de banco **ya no es un bloqueo**: se creó el 2026-10-03
y EAS CLI confirmó que la carga. Detalle y alcance exacto en la subsección
siguiente.

**Deuda inmediata, de una línea de alcance.** El docstring de
`mobile/src/config/buildVariant.js` conserva un bloque «KNOWN LIMIT» que
describe como abierta la rendija que `ccbf4fa` cerró: dice que un build lanzado
directamente por Gradle conserva el `applicationId` de producción «regardless of
this module», que era cierto antes de los flavors. Es un comentario, no
comportamiento, y se corrige en un gate propio para que este corte quede
estrictamente documental. Su sitio canónico sería
[`KNOWN_DEBT.md`](./KNOWN_DEBT.md); se registra aquí porque ese fichero quedó
fuera del alcance autorizado de esta reconciliación.

Esto no toca Auth funcional, ni `GC_QUEUE`, worker, retry, uploader, recovery o
cleanup, ni el backend. **`GC-AUTH-SESSION-RECOVERY-001` sigue `OPEN`** y el
producto sigue **`NO APTO PARA RELEASE`**.

#### Entornos de EAS — reparto explícito, sin selección automática

**Corrección de una afirmación anterior de este documento.** Se dijo que el
perfil `bench` no declaraba `environment` «deliberadamente, para que no herede
las variables de producción». **Era falso.** Omitir `environment` no deja un
perfil sin entorno: EAS **elige uno** —`production` cuando `distribution` es
`store`, `development` cuando `developmentClient` es `true`, y **`preview` para
todo lo demás**—. El perfil `bench` es `internal` y no es dev client, así que
habría seleccionado **`preview`**, que es donde viven hoy las variables de
producción. La omisión no protegía: exponía.

Lo que sí sostenía el fallo cerrado en ese escenario era, y sigue siendo, la
guarda 1:1 de `projectRefs`: con `GC_ENV=bench` y una URL de producción, la app
rehúsa arrancar.

El plan de EAS de esta cuenta ofrece **sólo los tres entornos estándar**
—comprobado en el dashboard el 2026-10-03—, y los entornos personalizados
requieren plan Enterprise o Production. La separación se consigue por tanto
repartiendo los tres en dos mundos, con `environment` **escrito en los cuatro
perfiles**:

| Perfil | Entorno EAS | `EXPO_PUBLIC_GC_ENV` | Variante Gradle | Mundo |
|---|---|---|---|---|
| `development` | `development` | `bench` | `assembleBenchDebug` | BANCO |
| `bench` | `development` | `bench` | `assembleBenchRelease` | BANCO |
| `preview` | `preview` | `production` | `assembleProductionRelease` | real |
| `production` | `production` | `production` | `bundleProductionRelease` | real |

Dos consecuencias que no dependen de disciplina. **Ningún perfil queda a merced
de la selección automática**, de modo que la trampa de arriba no puede repetirse
con un perfil nuevo. Y **el único consumidor del entorno `development` construye
el flavor de banco**, así que ningún `applicationId` de producción puede leer el
proyecto de banco; el perfil del dev client pasó a `assembleBenchDebug` por esa
razón, y con ello un dev client ya no puede apuntar a producción.

`EXPO_PUBLIC_GC_ENV` vive **sólo en `eas.json`**: una fuente, versionada y
visible en el diff. No se declara en ningún entorno remoto, lo que además evita
depender de la precedencia entre ambos sitios, que la documentación de Expo no
define.

Nivel de evidencia, que es estrecho:

```
EAS ENVIRONMENT ISOLATION = IMPLEMENTED / TESTED / OBSERVED
```

Lo acreditan pruebas estáticas sobre `eas.json` —los cuatro mapeos y las dos
invariantes cruzadas— y, para las variantes nativas, que Gradle resuelve
`assembleBenchDebug` y `assembleBenchRelease` en `--dry-run`.

**OBSERVADO (2026-10-03), con EAS CLI 24.10.0.** Una corrida de
`build:version:get --platform android --profile bench --json --non-interactive`
—read-only, sin construir nada— mostró que EAS carga las **tres** variables del
proyecto de banco desde el entorno `development` y `EXPO_PUBLIC_GC_ENV` junto a
`NPM_CONFIG_LEGACY_PEER_DEPS` desde el `env` del perfil `bench`. El reparto de
entornos de A2 **se interpreta como se diseñó**, y eso ya no está pendiente de
una build. La misma corrida devolvió `{}`, que se registra como **ausencia de
versión remota inicializada para este target** —el estado esperado— y **no**
como error.

**Lo que esa corrida NO acredita.** Nada sobre el artefacto: no se ha construido
ningún APK, así que **no se afirma que ningún APK contenga
`com.guariacloud.app.bench`**. El primer APK real sigue siendo el gate que
permitirá validar el artefacto, su identificador, su nombre visible y la
coexistencia en el dispositivo.

**Deuda que este reparto crea:** el entorno se llama `development` y contiene
banco. Quien añada una variable ahí pensando «esto es mi portátil» alimentará el
build de banco. Se mitiga con la descripción de cada variable, con esta tabla y
con las pruebas que la fijan; desaparecería sólo con un entorno personalizado,
es decir con un cambio de plan.

**Configuración remota de banco: CONFIGURADA · OBSERVADA POR EAS CLI.** Las tres
variables del proyecto de banco —`EXPO_PUBLIC_SUPABASE_URL`,
`EXPO_PUBLIC_SUPABASE_ANON_KEY` y `EXPO_PUBLIC_API_URL`— **ya existen en el
entorno `development`**, y **EAS CLI 24.10.0 confirmó que las carga** al
resolver con `--profile bench` el 2026-10-03. Las tres de producción siguen
exclusivamente en `preview`. `EXPO_PUBLIC_GC_ENV` **no se creó en ningún entorno
remoto**: sigue viviendo exclusivamente en `eas.json`, una sola fuente,
versionada, lo que además evita depender de una precedencia que Expo no
documenta.

> Esta entrada decía que las tres variables de banco **no existían todavía** y
> que la configuración remota bloqueaba el primer APK. **Dejó de ser cierto el
> 2026-10-03**, cuando se crearon y se observó su carga. El bloqueo que
> describía ya no existe; lo que queda pendiente es otra cosa, el artefacto.

La visibilidad de las tres debe ser `plaintext` o `sensitive`: una variable
`secret` no es legible fuera de los servidores de EAS y rompería la resolución
de la config y el bundle.

**Configurada y observada no es construida ni validada.** Nada de lo anterior
implicaba que existiera un APK, y por sí sola no eleva ninguna clasificación:
poner variables en EAS no construye, no instala y no ejercita nada.

> **Esta frase decía que «el siguiente gate pendiente es el primer APK BENCH
> real».** Dejó de ser cierta el 2026-10-03, cuando ese APK se construyó, se
> instaló y se validó en hardware (E1), y E2 añadió después la configuración
> efectiva del artefacto y el cruce de JWT. Las clasificaciones vigentes son las
> del bloque de arriba.

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

**Nueve findings.** Los **ocho** originales se registraron entre el 20/08 y el
24/08. El **noveno** —`GC-AUTH-ANCHOR-MALFORMED-001`— se registró el
**2026-10-04**, durante la revisión adversarial de G-R1, **fuera de esa
ventana**. **Ninguno está CLOSED salvo donde se indica explícitamente.**
Esta tabla es la **única** fuente de estado de los nueve: no existe una
segunda tabla ni un registro paralelo. Los estados de §1–§6 son los de
[`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md). `GC-START-LATENCY-001` **ya tiene
registro propio** desde el 24/08 —§6—; sólo `GC-DEST-STATUS-001` sigue
proviniendo de una ficha de evidencia congelada fuera del repositorio.

### Vocabulario de estado

| Etiqueta | Significa |
|---|---|
| `FIXED IN CODE` | La corrección está en la rama y cubierta por pruebas. **No** dice nada sobre dispositivo |
| `CLOSED IN HARDWARE` | Reproducido y verificado corregido en dispositivo, con evidencia fechada |
| `HARDWARE REVALIDATED` | Una corrección ya implementada ha sido **reejecutada y revalidada con éxito en dispositivo real**, con evidencia fechada. Se escribe junto a `FIXED IN CODE`, no en su lugar |
| `OPEN` | Observado y caracterizado. **Sin corregir** |
| `IMPLEMENTED / TESTED` | Capacidad implementada y cubierta por pruebas automáticas. **No** implica validación en hardware, ni cierre del finding o del producto asociado. **No es `FIXED IN CODE`**: se reserva para una capacidad o garantía **añadida**, no para la corrección de un finding |
| `NOT HARDWARE VALIDATED` | La implementación o corrección dispone de evidencia automatizada, pero **esa conducta concreta todavía no se ha demostrado físicamente en dispositivo**. Se escribe junto a `FIXED IN CODE` o a `IMPLEMENTED / TESTED`, no en su lugar |
| `HARDWARE REVALIDATION REQUIRED` | Existe una **razón explícita** para repetir o realizar una validación física antes de elevar el estado correspondiente |

> **`NOT HARDWARE VALIDATED` no es `HARDWARE REVALIDATION REQUIRED`.** La
> primera es una **ausencia**: nadie ha demostrado esa conducta en un
> dispositivo. La segunda es una **obligación**: hay una razón concreta para
> hacer o repetir una corrida física antes de mover el estado. Pueden
> coexistir, y a menudo deben. Ninguna etiqueta histórica se renombra por
> esto.

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
| **GC-AUTH-SESSION-RECOVERY-001** | **`OPEN`** · prevención **validada en banco** · **evidencia incidental en hardware** · **validación dirigida en dispositivo PENDIENTE**; supervivencia (D3) **`HARDWARE FUNCTIONAL PASS`**; primitiva de identidad recuperable **`PASS / OBSERVADO EN PoC DESECHABLE`** (2026-09-16), **integración PARCIAL**: `2cef552` publicó la vinculación diferida de email (E1); la **entrada por OTP y la reconexión con la evidencia pendiente siguen NO IMPLEMENTADAS**; continuidad de ownership **`IMPLEMENTED / TESTED`** / **`NOT HARDWARE VALIDATED`** desde el 2026-10-04 | D0 `02551a1`+`34412a0` · D2-B `08e3cd2` · D2-C `22a9b26` · D3 `cb59c7e` · continuidad `39d6d05` | Tras una ventana offline prolongada la sesión de Supabase desaparecía y 87 chunks quedaron sin poder subirse (22/08). **D2-B** (upgrade a 2.112.3) corrige la destrucción ante `500` / `502` / `525-529` y añade proactive-preserve y un cooldown de 60 s. **D2-C** clasifica `429` en el refresh como reintentable; todo lo demás hace pass-through fail-closed. **D3** es de otra naturaleza: no previene nada, da **salida local** a la evidencia de vídeo nativo segmentado que ya quedó varada. Validado en hardware el 24/08 (OnePlus A6000, modo avión, 12/12 segmentos, `status: complete`). **Ninguna de las tres cierra el finding**: la identidad sigue sin recuperarse, la subida sigue sin reanudarse y el ownership sigue sin restaurarse. El 2026-09-16 pasó, en un proyecto Supabase desechable, la **primitiva** de la prevención elegida: un usuario anónimo con email vinculado y sin ninguna sesión vuelve a entrar por OTP y recupera **el mismo `user.id`**. **Tampoco cierra el finding**: lo único integrado en la app es pedir y enviar la vinculación del email —`2cef552`, implementado y con pruebas unitarias, **nunca validado**—; no hay entrada por OTP, no se ha probado contra producción y no recupera identidades ya perdidas. El 2026-10-04, `39d6d059ee4d55ae307d96f29be75913bdcb3ecd` añadió la **puerta de continuidad de ownership**: `gc.identity.v1` gana `user_id` —el `user.id` completo, write-once— y `getOwnershipToken()` no emite ningún `OwnershipToken` si el `user.id` de la sesión viva no es byte a byte el anclado; la **ausencia de ancla NO es coincidencia**, y `sub_prefix` no decide nada. Queda **`IMPLEMENTED / TESTED`** —suite 1040/1040 en 48 ficheros, medida el 2026-10-04 sobre `39d6d05`, que es el corte de ESTE cambio y no la corrida vigente— y **`NOT HARDWARE VALIDATED`**. **No cierra este finding, ni total ni parcialmente**: es una **precondición de seguridad para la futura recuperación**, no recuperación. La identidad perdida **sigue sin poder recuperarse** y el recovery por OTP sigue **NOT IMPLEMENTED**. Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5 |
| **GC-START-LATENCY-001** | `FIXED IN CODE` / **`HARDWARE VALIDATED`** | producto `e643b01` · guardas de test `3c10994` | `startRecording` esperaba a `getOwnershipAccessToken()` antes de abrir la grabadora, y esa ruta de auth **no lleva timeout en ninguna capa**. La lectura se movió dentro de `sessionCreatePromise`, que no se espera antes del productor. Validado en hardware el 24/08 en dos escenarios: **remoto vivo** — 531 ms tap→productor, 163 ms de lógica propia, 28/29 fragmentos confirmados **antes** de PARAR — y **token caducado + modo avión** — 243 ms tap→productor, 102 ms de lógica propia, con auth resolviendo **10,72 s después** de que el productor ya grababa. **auth no se volvió rápida: dejó de bloquear START.** Recuperación tras restaurar red: mismo `localSessionId`, 1 `POST /sessions`, 77/77 confirmados, cleanup posterior a `http_200`. Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §6 |
| **GC-DEST-STATUS-001** | **`OPEN`** · defecto de **backend** | — | Ningún camino de código escribe `revoked` ni `error`. Un destino Drive con refresh token revocado sigue reportándose `connected`. Ver [`API_SPEC.md`](./API_SPEC.md#estado-de-los-destinos--defecto-abierto) |
| **GC-AUTH-RETRY-CLASSIFICATION-001** | **causa suficiente demostrada** · relación causal con el 22/08 **no probada** | banco `9d682bc` · D2-B `08e3cd2` · D2-C `22a9b26` | Dejó de ser estático: el banco reproduce de forma determinista que un `429` / `500` en el refresh destruye una credencial **intacta** (`refresh_present: true`). Corregido para `500` por D2-B y para `429` por D2-C. **Sigue sin demostrarse** que el incidente del 22/08 fuera uno de esos dos: la respuesta nunca se capturó |
| **GC-AUTH-ANCHOR-MALFORMED-001** | **`FIXED IN CODE`** / **`TESTED`** / **`NOT HARDWARE VALIDATED`** · `PREEXISTING` | `ee539629b61e8a186e1eb5b52812cf79115b31ba` | **Noveno finding, registrado el 2026-10-04** en la revisión adversarial de G-R1, no en la ventana 20/08–24/08, y **corregido ese mismo día** en `ee53962`. El defecto —histórico— era que `readIdentityMarker()` colapsaba un marker ilegible en el mismo `null` que una ranura vacía y `markIdentityInitialized()` lo **sustituía**, fabricando desde G-R1 un `user_id` anclado a la sesión del momento; y que la guarda write-once del back-fill no distinguía un `user_id` **presente pero inválido** de uno ausente. Ahora la validez se decide sólo en `readIdentityMarkerState()`, que responde cuatro hechos: **`absent` únicamente para `null`** —la única ausencia real—, `unreadable` para un `getItem` que lanza, `corrupt` para bytes que no son un marker válido —`version` desconocida o futura incluida, y `user_id` presente e inválido también—, y `present` con el esquema completo. **`setItem` ocurre si y sólo si el estado es `absent`**; `corrupt` y `unreadable` rechazan sin tocar un byte, y **negarse a escribir es la preservación**: ninguna clave durable nueva, ningún salvage. Un marker pre-G-R1 válido **sin la propiedad** `user_id` conserva el back-fill mientras la entrada de recuperación no esté habilitada. La **corrupción posterior a abrir el latch tampoco emite token**: el latch de durabilidad sigue abierto y la continuidad, releída del disco en cada emisión, niega con `continuity_unverifiable`. **No tocó `GC_QUEUE`, worker, recovery ni evidencia**, y `RECOVERY_ENTRY_IMPLEMENTED` sigue en `false`. Evidencia: 1072/1072 en 48 ficheros sobre `ee53962`, 51 tests en `identityContinuity.test.ts` de los que **29** fijan este finding; **sin validación en hardware**. La precondición H1 queda satisfecha y **eso no autoriza** abrir la entrada de recuperación: siguen pendientes la ordenación/atomicidad de la barrera y las instalaciones pre-G-R1 sin ancla. Detalle en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5 |

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

Ejecutada el **2026-10-04** sobre el árbol de
`d9bf343158e04c0d7779332baea60d2ad9033a78`.

| Comprobación | Resultado |
|---|---|
| Suite completa | **1102/1102**, en **49 ficheros** |
| Typecheck | **12 errores TypeScript heredados, cero nuevos** — typecheck **NO** verde |
| `git diff --check` | Limpio |

> **Lo atribuible y lo no atribuible.** El salto desde el corte anterior no es
> de un solo commit, y este documento sólo acredita la parte que midió:
>
> ```
>  958 / 43   corte del 2026-08-31, tras eb86340
> 1007        medido tras ccbf4fa          ← cortes que este documento
> 1014        medido tras b1f73aa            ya tenía anclados
> 1021 / 47   medido el 2026-10-03, árbol del gate E1-BENCH-OAUTH-SCHEME
>  +19 / +1   39d6d05 — identityContinuity.test.ts, la aportación COMPLETA
>             de G-R1: la actualización de los dos contratos antiguos
>             (identityBootstrap, ownershipGate) sustituyó aserciones y
>             NO añadió ningún test
> 1040 / 48   medido el 2026-10-04 sobre 39d6d05
>  +32 / +0   ee53962 — GC-AUTH-ANCHOR-MALFORMED-001, todos en el MISMO
>             fichero identityContinuity.test.ts (19 → 51). Cero ficheros
>             nuevos: los otros tres del commit cambiaron aserciones
> 1072 / 48   medido el 2026-10-04 sobre ee53962
>  +13 / +0   3a68699 — R1, en identityContinuity.test.ts (51 → 64)
>   +9 / +1   8ea3fea — precondición A, fichero nuevo
>             recoveryBarrier.test.ts
> 1094 / 49   medido el 2026-10-04 sobre 8ea3fea
>   +8 / +0   d9bf343 — H-1, en recoveryBarrier.test.ts (9 → 17)
> 1102 / 49   medido el 2026-10-04 sobre d9bf343
> ```
>
> Del tramo 958 → 1021 este documento conserva los cortes intermedios que ya
> había anclado, pero **no atribuye esos incrementos a commits concretos**:
> «medido tras X» significa medido después de X, no aportado por X. Los
> incrementos atribuidos a un commit concreto son los cuatro marcados con
> `+`: G-R1, H1, R1, la precondición A y H-1.

> **El corte de 958/43 reconciliaba a su vez dos incrementos, no uno**, y esa
> cuenta se conserva tal como se registró el 2026-08-31:
>
> ```
> 936 / 42   corte anterior de este documento, tras fc9a20e
> +11 / +1   26c0966 — recoveryCompactList.test.ts, no documentado en su momento
> +11 / +0   eb86340 — GC-QUEUE-PARSE-WIPE-001, en queue.test.ts
> 958 / 43   medido el 2026-08-31
> ```

> Cortes anteriores: **360/360** el 20/08, **781/781 en 40 ficheros** el 23/08
> sobre `34412a0`, **792/792 en 41 ficheros** el 24/08 tras `3c10994` y
> **958/958 en 43 ficheros** el 2026-08-31 sobre `eb86340`. El
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


## Findings abiertos de evidencia y OAuth

Registrados el 2026-08-27. Su ficha completa vive en
[`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §7–§9; aquí sólo consta su estado.

| Finding | Estado |
|---|---|
| `GC-MANIFEST-BESTEFFORT-001` | **`OPEN`** — consecuencia ensayada en hardware el 27/08 para el manifiesto final; el caso sin ningún manifiesto **no** está validado. Sin severidad asignada |
| `GC-OAUTH-SCHEME-COLLISION-001` | **`OPEN`** — hecho de código verificable; el desvío del deep link se observó en `G3''` **sin artefacto congelado**; explotabilidad no ensayada. Sin severidad asignada |
| `GC-OAUTH-NOSTATE-001` | **`OPEN`** — trazado en código: `state` no se genera, no se valida y no se usa. El riesgo asociado es **inferido y no validado**. Sin severidad asignada |

---

## Findings de durabilidad de la cola

Su ficha completa vive en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §6; aquí sólo
consta su estado.

| Finding | Estado |
|---|---|
| `GC-QUEUE-PARSE-WIPE-001` | **`FIXED IN CODE / AUTOMATED TESTS`** — corregido en `eb8634045d8da8fe219120ec671ca12c8f54e1f6`. Un valor de cola ilegible se **preserva verbatim y verificado** en `gc.queue.salvage.v1` antes de reiniciar la cola, en vez de ser sobrescrito por el array vacío; los mismos bytes ya salvados permiten reintentar sin reescribir la ranura. **NO `CLOSED`: validación en hardware pendiente.** Limitación principal: una corrupción con bytes **distintos** y la ranura ocupada **falla cerrado** y bloquea las mutaciones de cola hasta intervención |

> Este finding no figuraba en este documento mientras estuvo `OPEN`. La omisión
> era una asimetría documental, corregida aquí al existir implementación real.
> `gc.queue.salvage.v1` **no es una cola ni una segunda fuente de verdad**:
> `GC_QUEUE` sigue siendo la única.

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

Estado: VALIDADO EN CONDICIONES REALES el 2026-05-14 (`045f9d9`), sobre
`guardian-cloud.manifest.v1`. Esa validación **no acredita**
`guardian-cloud.manifest.v2`, introducido posteriormente con `142c1f9`.

Capacidades:
- discovery cross-device
- reconstruction from manifest
- partial recovery
- export from recovered evidence

---

## Incremental manifests and partial cross-device recovery (v0.3.4)

Status: ✅ validated on real device — 2026-05-18 (`ec7c289`), on
`guardian-cloud.manifest.v1`. This validation does **not** cover
`guardian-cloud.manifest.v2`.

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
- recovery can show them as partial — **en el contrato histórico del endpoint;
  ver la nota siguiente sobre dónde lo hace la app**
- uploaded evidence can be exported even if the original app install is gone

> **Dónde se distingue parcial de completa, desde `GC-RECOVERY-COMPACT-DISCOVERY-001`.**
> El endpoint **sigue emitiendo `protection_status`** en su respuesta por
> defecto, así que la frase de arriba sigue siendo cierta a nivel de API. Lo que
> cambia es el cliente: la app pide `?view=compact`, cuya respuesta se construye
> sólo con metadata de Drive y **no** clasifica. En la app, esa distinción se
> determina **al abrir la sesión**, donde el manifiesto sí se descarga y valida.
>
> Lo que **no** cambia: la sesión sigue siendo igual de descubrible, y el export
> sigue reconstruyendo desde los chunks que existan. Es información que cambia
> de sitio dentro de la app, no que se pierda. Contrato en
> [`API_SPEC.md`](./API_SPEC.md) §Recovery.
>
> **Nada de esto está validado en dispositivo:** el cambio está commiteado, no
> desplegado ni instalado. Ver el registro de más abajo.

### Architecture

- Backend writes partial manifests fire-and-forget after chunk upload registration.
- Chunk upload response is not blocked by manifest generation.
- `GC_QUEUE` is unchanged.
- Mobile worker is unchanged.
- Export pipeline is unchanged.
- Drive OAuth is unchanged.
- On `/complete`, the final manifest overwrites the partial manifest **when
  the final write succeeds**. If that best-effort write fails, the last
  incremental manifest remains — see
  [`VALIDATIONS/GC_MANIFEST_BESTEFFORT_ARMB_2026-08-27.md`](./VALIDATIONS/GC_MANIFEST_BESTEFFORT_ARMB_2026-08-27.md).

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

This **narrows, but does not close**, the gap where evidence chunks survive
remotely but are not discoverable after local state loss. Once an
incremental manifest exists, the session can be discovered from that saved
state; however, a surviving incremental manifest does **not** guarantee
coverage of every uploaded chunk if the final manifest write fails. This
limitation was validated on hardware in
[`VALIDATIONS/GC_MANIFEST_BESTEFFORT_ARMB_2026-08-27.md`](./VALIDATIONS/GC_MANIFEST_BESTEFFORT_ARMB_2026-08-27.md).

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

---

## `GC-RECOVERY-COMPACT-DISCOVERY-001` — descubrimiento compacto opt-in

Commit **`26c09660b7fb49f74f4e63d0130ac8b134bf1831`**, sobre `main`.

**Estado: `IMPLEMENTADO / PROBADO EN SOFTWARE`. Sin ninguna validación en
Drive real, en dispositivo ni en despliegue.**

### Qué problema aborda

`GET /recovery/manifests` descargaba y parseaba **todos** los manifiestos de la
carpeta, en serie, para rellenar campos que la pantalla de listado no pinta. El
coste crecía con la carpeta —serie observada en el log del backend: 1 manifiesto
→ 1,2 s; 10 → 7,6 s; 19 → 12,8 s; 75 → 56–65 s— frente al timeout fijo de 10 s
del cliente móvil, de modo que la lista **dejaba de cargarse** una vez la
carpeta pasaba de una docena larga de ficheros. Registrado como
`GC-RECOVERY-MANIFEST-LIST-LATENCY-001`; **sin severidad asignada**.

### Implementado y probado en software

| | |
|---|---|
| `?view=compact` opt-in | Devuelve `session_id`, `manifest_file_id`, `reference_date` |
| Contrato por defecto | **Conservado sin cambios**: sin `view` se sigue devolviendo la forma histórica de siete campos, descargando y parseando cuerpos |
| `view` desconocido | **Contrato: `400 INVALID_VIEW`**, sin fallback silencioso. Evidencia **parcial**: `parseDiscoveryView` está cubierta por pruebas unitarias que demuestran que ningún valor desconocido cae a la forma histórica; el mapeo de `null` a HTTP `400` está implementado en la ruta y **verificado por inspección**, no por prueba. **No hay cobertura HTTP extremo a extremo con JWT válido** — ver riesgos abiertos |
| Cero descargas en compact | Demostrado **con mocks**: 75 ficheros, `downloadFile` no invocado ni una vez |
| Tests backend | `recoveryCompactDiscovery.test.ts` — 19, incluidos los del contrato histórico y su clasificación `partial`/`complete` |
| Tests móvil | `recoveryCompactList.test.ts` — 11, a nivel de fuente |
| UX compact | La fila no afirma protección, integridad ni validación; muestra fecha de referencia y una sola acción |
| Validación dura | **Intacta**: `getManifestByFileId` y la verificación `sha256` de la descarga de chunks no se tocan |

### NO validado — nada de esto se ha ejecutado

```
Drive real                                    no ejecutado
latencia real tras el cambio                  no medida
nº real de requests paginadas de files.list
  sobre el dataset real                       no medido
APK nueva en dispositivo                      no construida ni instalada
APK antigua contra el backend nuevo           no probado
rollout                                       no realizado
ausencia de 1ce18e76-… en el descubrimiento   no observada
```

**Ninguna cifra de las de arriba es un `PASS` de hardware o de staging.** La
serie de latencias citada es la del comportamiento **anterior**, medida en el
log del backend; no hay ninguna medición del comportamiento nuevo.

### Relación con ARMA C

La **premisa 11** de `ARMA C` —que la sesión `1ce18e76-…` esté **ausente** del
descubrimiento— quedó establecida estructuralmente pero **no observada**, porque
la lista no cargaba. Su cierre depende de ejecutar el rollout y mirar la lista;
hasta entonces `ARMA C` sigue en `NEEDS_MORE_EVIDENCE`.

### Riesgos que siguen abiertos

* el camino histórico **`O(N)` sigue vivo** por compatibilidad;
* el patrón de nombre histórico admite nombres degenerados de 36 caracteres,
  que en compact se publicarían como `session_id` no canónico;
* compact puede listar un candidato cuyo nombre no coincida con el `session_id`
  del cuerpo — los dos caminos pueden divergir en ese caso;
* un candidato inválido aparece y falla al abrirse, por diseño;
* `400 INVALID_VIEW` **no** tiene cobertura HTTP con JWT válido: probarlo exige
  que `authMiddleware` busque el JWKS por red, que es lo que hace fallar por
  timeout a los cuatro tests de integración preexistentes.

**Este registro no mueve el veredicto `NO APTO PARA RELEASE`.**