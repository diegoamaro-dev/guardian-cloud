# Guardian Cloud — Auditoría integral

**Fecha:** 2026-07-28
**Rama:** `main` · **HEAD:** `dea0ed0` · **Working tree al inicio:** 2 ficheros modificados, 4 sin rastrear (no alterados por esta auditoría)
**Documentos complementarios:** [`GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md`](./GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md) · [`GUARDIAN_CLOUD_REMEDIATION_PLAN_2026-07-28.md`](./GUARDIAN_CLOUD_REMEDIATION_PLAN_2026-07-28.md)

---

## 0. Adjudicación (2026-07-28)

Este informe ha pasado por una fase de adjudicación. Las siguientes decisiones de producto son **vinculantes** y prevalecen sobre cualquier recomendación anterior de este documento:

1. **v0.3 incluye audio y vídeo.** El vídeo no es opcional ni diferible.
2. **Ambos modos deben sacar evidencia del dispositivo DURANTE la grabación.** La invariante I1 no admite excepción por modo.
3. **Ocultar el modo vídeo es contención temporal.** Reduce el daño mientras se trabaja; **no** convierte v0.3 en liberable.
4. **Mantener vídeo post-stop con un aviso NO es remediación aceptable.** Un aviso honesto corrige la mentira, no el incumplimiento.
5. **La captura segmentada de vídeo en vivo deja de ser «v1.1 / NO HACER AHORA» y pasa a ser causa raíz P0.**
6. **La solución introduce únicamente un productor de captura segmentada.** Reutiliza `GC_QUEUE`, worker, retry, backend y recovery **sin crear un segundo pipeline de subida**.
7. **La promesa de los 10 s queda condicionada a conectividad suficiente**, con comportamiento offline definido explícitamente (§3).
8. **`completed_at` no es prueba de captura completa.** Se separan cuatro dimensiones y se exige un estado persistente `capture_end_reason` (§3bis y matriz §10).
9. **Una sesión interrumpida nunca puede mostrarse como «Protegido correctamente»** por el mero hecho de que todos los chunks *conocidos* estén subidos.
10. **`scanOrphans` sobre `cacheDirectory` es mitigación**, nunca garantía de recuperar un MP4 interrumpido.
11. **El tope de 70 s de vídeo deja de ser solución principal.** Sólo sobrevive como contención mientras el vídeo esté oculto.
12. **El trabajo de foreground service se divide en cinco cambios independientes** (§7, GC-AUD-008/034/035).
13. **El flujo OAuth se replantea**: el canje se completa en el callback HTTPS del backend y el `authorization code` deja de viajar por `guardiancloud://` (GC-AUD-036).
14. Correcciones de referencias e inconsistencias aplicadas (§7bis).
15. **Los resultados de test y typecheck de §6 son evidencia de auditoría válida**, obtenida bajo Node 24 —versión que **satisface** `node >=20`—. Deben **repetirse bajo la versión exacta del runtime de producción** para establecer paridad y baseline de remediación.

El veredicto **NO APTO** se mantiene.

---

## 1. Resumen ejecutivo

Guardian Cloud tiene un núcleo de supervivencia de evidencia **genuinamente bien construido para audio**, y **no lo tiene para vídeo**. Esa es la conclusión central y todo lo demás es secundario respecto a ella.

Lo que está bien, con evidencia:

- La cola persistente, el worker single-flight, la clasificación transitorio/permanente con backoff, la normalización de duplicados, la puerta de finalización y el reap están implementados con cuidado real y cubiertos por **138 tests que he ejecutado y están verdes**.
- La autenticación del backend verifica firma de verdad (JWKS / HS256), fija el `issuer`, aplica `exp` y devuelve 401 opacos. **No he encontrado ningún IDOR**: cada consulta a sesiones, chunks y destinos está filtrada por `user_id`, y «no existe» y «no es tuya» se colapsan en un 404 para impedir enumeración.
- El backend **no persiste bytes de evidencia en disco**. No hay `fs`, ni `multer`, ni ficheros temporales en todo `backend/src`. La promesa «el servidor no almacena vídeos» se sostiene.
- El export reconstruye el **prefijo contiguo válido más largo desde el índice 0**, verifica SHA-256 chunk a chunk y se detiene en el primer hueco en lugar de producir un fichero disperso. Es la decisión correcta y está bien implementada.

Lo que no está bien:

En **modo vídeo no se sube absolutamente nada mientras se graba**. El chunker en vivo se arranca sólo para audio (`mobile/app/index.tsx:5096-5098`) y el productor de vídeo declara explícitamente que no toca el fichero durante la grabación (`videoFileProducer.ts:77-79`). Toda la evidencia de vídeo vive únicamente en el dispositivo hasta que el usuario pulsa PARAR. Si el dispositivo se pierde, se confisca o se destruye durante una grabación de vídeo, **sobrevive cero evidencia**. Esto no es un matiz: es exactamente el escenario para el que existe el producto.

Peor: si la app muere durante una grabación de vídeo, el recovery de arranque marca la entrada como `recording_closed = true` con `next_chunk_index = 0`, la puerta de finalización no encuentra ningún índice ausente (porque no se esperaba ninguno), y el sistema **llama a `/complete` y marca la sesión como completada en el backend con cero chunks**. El `.mp4` queda en `cacheDirectory`, que `scanOrphans` no escanea. El resultado es pérdida total y silenciosa de evidencia presentada al usuario como una sesión cerrada.

Y mientras eso ocurre, la interfaz dice literalmente **«Protegiendo evidencia»** (`mobile/app/index.tsx:1583-1584`).

Hay un segundo caso de evidencia falsa, independiente del anterior y igual de grave. En el recovery **cross-device** —el camino que se usa precisamente cuando el dispositivo original ya no existe, es decir el escenario de máxima gravedad— una sesión cortada al 20 % se reconstruye y se presenta en verde como **«Protegido / Evidencia recuperada correctamente»** (`mobile/app/recover/[id].tsx:230-234`). La causa es que el manifest guarda `chunk_count: uploaded.length` (`backend/src/services/manifest.service.ts:209`), es decir el número de chunks que **sí** subieron, no el que debería haber habido; el export deriva el total de esa misma lista truncada, no encuentra ningún hueco, y devuelve `complete`. El backend **sí** calcula `protection_status: 'partial'` y el payload **sí** trae `completed_at: null` — la pantalla de detalle simplemente los ignora.

A esto se suma que las tres afirmaciones de validación más repetidas del proyecto —«validado bajo kill, pérdida de red, background y reinicio», «el sistema ya no es un prototipo», «cumple su promesa central»— **no tienen ni un solo registro de prueba detrás**. `SURVIVAL_TEST_RESULTS.md` dice textualmente «Sin sesiones registradas todavía». `RECOVERY_BETA_VALIDATION.md` tiene 14 escenarios, 9 marcados BLOCKER, cero resultados. `VALIDATION_MATRIX.md` marca con «?» precisamente los tres escenarios que `IMPLEMENTATION_STATUS.md` declara validados. **En todo el repositorio no hay una sola casilla de checklist marcada** (`grep -rn "\[x\]"` → 0 resultados, verificado).

Y la suite de tests del backend **está roja**: 4 fallos de 106, incluido —esto importa— el test que demuestra que se rechazan los JWT con firma inválida, expirados o de emisor incorrecto.

---

## 2. Veredicto

# NO APTO

No «apto con bloqueantes». **No apto.**

El criterio no es mío: es el del propio proyecto. `SYSTEM_INVARIANTS.md:75` dice «Si alguna de estas invariantes falla, el producto deja de cumplir su propósito». La invariante nº 1 —«los chunks deben empezar a subirse mientras se graba, no sólo al final»— está rota por diseño en uno de los dos modos de captura que la aplicación ofrece al usuario en igualdad de condiciones, sin ninguna advertencia.

`CLAUDE.md §14` es aún más directo: «El sistema es incorrecto si pierde datos». En modo vídeo pierde el 100 % de los datos ante kill, ante crash, ante paso a background, y ante cualquier grabación de más de ~80 segundos.

**Corrección adjudicada.** Una versión anterior de este informe sostenía que deshabilitar el modo vídeo bastaría para pasar a «APTO CON BLOQUEANTES». Esa lectura queda retirada: v0.3 incluye vídeo (decisión 1), y ocultarlo es contención, no remediación (decisión 3). Mientras el vídeo no saque evidencia del dispositivo durante la grabación, **v0.3 no es liberable, esté el modo visible u oculto**.

Lo que sí sostengo: el problema **no está repartido por todo el sistema**, sino concentrado en un punto — no existe un productor de captura segmentada de vídeo. Aguas abajo de ese punto, **`GC_QUEUE`, worker, retry, backend, recovery y export ya existen y tienen cobertura parcial; su comportamiento end-to-end sigue sin demostrarse en dispositivo real.** La corrección probablemente sea **añadir un productor** más los ajustes multimedia que ese productor exija, no reescribir el pipeline — pero eso es una hipótesis que debe confirmar el spike, no una conclusión de esta auditoría.

---

## 3. ¿Está demostrada la promesa central de Guardian Cloud?

> «Si el usuario graba durante aproximadamente 10 segundos y pierde el dispositivo, al menos una parte de la evidencia ya debe haber sobrevivido fuera de él.»

**En modo AUDIO: es plausible por construcción, pero NO está demostrada.**

La aritmética del código la respalda. AAC a 64 kbps mono (`audioEngine.ts:80-90`) = 8 KB/s. El chunk son 32 KB (`index.tsx:310`), es decir 4 segundos de audio. El chunker corre cada 1,5 s (`index.tsx:669`). El primer chunk se emite hacia t≈4,5 s, se persiste en disco antes de tocar la cola, y el worker se despierta inmediatamente (`index.tsx:2915`). Con red razonable, el primer chunk debería estar fuera del dispositivo entre los 5 y los 7 segundos. Queda margen sobre los 10.

Pero eso es un cálculo, no una demostración. Depende de que la red esté disponible, de que el backend responda, de que Drive esté conectado y de que el token sea válido. **No he podido ejecutar ni un solo segundo de grabación real**: no hay dispositivo Android, ni credenciales de Supabase, ni Drive conectado en este entorno. Y el repositorio no contiene ningún registro que lo demuestre — el único fichero de validación fechado de todo el proyecto es `docs/VALIDATIONS/NAS_UPLOAD.md` (2026-05-04), y no cubre este escenario.

El propio proyecto define el estándar en `DEBUGGING_RULES.md:189-205`: *«La validación real NO es: TypeScript verde / Vitest verde / build OK. La validación real es: kill app / mala red / background / reopen / recovery / uploads reales / Drive real.»* Por ese estándar —el suyo— la promesa no está demostrada en audio.

**En modo VÍDEO: está demostradamente FALSA.**

Esto no requiere dispositivo para afirmarlo. Es una propiedad estática del código:

```
mobile/app/index.tsx:5092-5098
      // Gate on audio: video uses post-stop chunking (see stopRecording
      // → controller.chunkVideoFile) and intentionally has NO live
      // chunker.
      if (recordingMode === 'audio') {
        startChunkerForSession(sessionId, cacheUri, recordingMode);
      }
```

```
mobile/src/recording/videoFileProducer.ts:77-79
 * The recorder writes a single .mp4 file in `cacheDirectory` while
 * recording; THIS PRODUCER DOES NOT TOUCH THAT FILE DURING RECORDING.
```

A los 10 segundos de una grabación de vídeo hay exactamente **cero** bytes fuera del dispositivo. La promesa central del producto es falsa en la mitad de su superficie de captura.

### 3bis. La promesa, correctamente enunciada (adjudicado)

La formulación actual —«si grabas 10 segundos, parte ya está fuera»— es incondicional y por tanto indefendible: ninguna app puede garantizar una subida sin red. La promesa debe enunciarse **condicionada**, y el sistema debe comportarse de forma definida cuando la condición no se cumple.

**Enunciado adjudicado:**

> **Con conectividad suficiente**, a los ~10 segundos de empezar a grabar —en audio **y en vídeo**— al menos un fragmento de evidencia ha sido confirmado por el destino remoto.
> **Sin conectividad suficiente**, cada fragmento **se persiste localmente en almacenamiento durable y se sube automáticamente al recuperar la conexión**, sin intervención del usuario; el usuario ve en todo momento cuánto está protegido fuera del dispositivo y cuánto no.

**Lo que «persistido localmente» NO significa, dicho sin ambigüedad:** un fragmento que sólo existe en el dispositivo **no es evidencia protegida**. Mientras no haya confirmación remota, perder el dispositivo —confiscación, destrucción, robo— **implica perder esa evidencia local**. La persistencia durable protege contra el cierre de la app, el reinicio y la purga de caché por el sistema operativo; **no protege contra la pérdida del dispositivo**, que es precisamente la amenaza que define el producto.

De ahí la exigencia sobre la UI: mientras no exista confirmación remota de al menos un fragmento, la pantalla debe decir **«Todavía no protegido fuera del dispositivo»**. No «guardado», no «asegurado», no «protegiendo»: el usuario tiene que poder distinguir «lo tengo en el móvil» de «ya está fuera de mi móvil», porque es la única distinción que cambia lo que puede hacer a continuación.

**«Conectividad suficiente» debe ser un perfil medible, no un adjetivo.** Sin un perfil escrito, «cumple la promesa» no es falsable — y ese es justo el problema que esta auditoría encontró en toda la documentación de validación del proyecto.

> ⚠️ **Los valores que siguen son una HIPÓTESIS INICIAL DE PRUEBA, no un contrato demostrado.** No los he medido ni podía medirlos: sirven para poder empezar a instrumentar, y **el perfil definitivo se fija después de medir el primer fragmento real**, en función del tamaño de segmento que el spike acabe eligiendo. Publicarlos como umbral validado repetiría exactamente el patrón que este informe reprocha al proyecto.

**Hipótesis de partida — red:** ≥1 Mbit/s de subida sostenida y RTT ≤300 ms al backend.

**Precondiciones operativas, igual de necesarias y hoy no enunciadas en ninguna parte** — la promesa no se sostiene sin ellas, por buena que sea la red:

- **backend operativo y alcanzable** (todo el tráfico de evidencia va proxied);
- **destino conectado** (Drive/NAS con conexión vigente);
- **credenciales válidas y no caducadas** (sesión de Supabase y token del destino).

Las tres deben registrarse en cada ejecución de las pruebas: un fallo de cualquiera de ellas invalida la medición de la promesa igual que lo haría una red insuficiente.

**Comportamiento offline exigido** (parte es ya el comportamiento actual del camino de audio, y funciona bien):

| Situación | Comportamiento requerido | Estado hoy |
|---|---|---|
| Sin red al pulsar GRABAR | La grabación arranca igual. `POST /sessions` se difiere y se reintenta solo | ✔ implementado (`index.tsx:4888-4923`, `GC_LOCAL_FIRST session deferred`) |
| Sin red durante la captura | Los fragmentos se siguen produciendo y se persisten en disco durable, no en memoria | ✔ audio (`emitChunk` escribe a disco antes de tocar la cola) · ✘ **vídeo: no se produce ningún fragmento** |
| Vuelve la red | El worker drena sin que el usuario toque nada | ✔ implementado |
| Estado visible | El usuario distingue «todavía no protegido fuera del dispositivo» de «N fragmentos protegidos fuera» | ✘ **hoy dice «Protegiendo evidencia» en ambos casos** (GC-AUD-004) |
| Nunca vuelve la red | La evidencia sobrevive localmente y es exportable desde el dispositivo — **y la UI no la presenta como protegida** | ✔ fallback local implementado (`session/[id].tsx:811-827`) · ✘ la etiqueta no distingue |

La conclusión que importa: **el comportamiento offline del audio es correcto en su mecánica** —los fragmentos se producen, se persisten en disco durable y drenan solos— y no hay que inventarlo. Faltan dos cosas: que el vídeo produzca fragmentos para que esa mecánica se le aplique, y que la UI deje de presentar lo local como protegido.

### 3ter. Dos hechos distintos que la UI colapsa hoy en una sola etiqueta (adjudicado)

Son independientes y ninguno implica al otro. Colapsarlos es el error común a GC-AUD-004 y GC-AUD-033.

| Hecho | Pregunta | Fuente de verdad |
|---|---|---|
| **A. Integridad / completitud de la grabación** | ¿La captura llegó hasta el final, o se cortó? | `capture_end_reason` (§3bis y matriz §10) |
| **B. Fragmentos protegidos fuera del dispositivo** | ¿Cuántos fragmentos tienen confirmación remota? | `status='uploaded'` + `remote_reference` |

Las cinco combinaciones son reales y necesitan mensajes distintos:

| A · Captura | B · Fragmentos remotos confirmados | Lo que la UI debe transmitir |
|---|---|---|
| **Completa** (`user_stop`) | todos | **«Protegido»** |
| **Completa** (`user_stop`) | **parcial (N de M)** | **«N/M protegidos»** — sin declarar protección completa |
| **Completa** (`user_stop`) | **0** | **«Grabación completa; todavía no protegida fuera del dispositivo»** |
| **Interrumpida** | **≥1** | **«Hay evidencia protegida fuera del dispositivo; la grabación está incompleta»** |
| **Interrumpida** | **0** | **«Grabación incompleta; nada protegido fuera del dispositivo»** |

**No existe una regla general del tipo «todo `interrupted_*` ⇒ Protección parcial».** Sería otra forma de colapsar los dos hechos. Una captura interrumpida sin nada subido y una captura interrumpida con veinte fragmentos remotos confirmados son situaciones **radicalmente distintas** para quien tiene que decidir qué hacer a continuación, y merecen mensajes distintos.

La cuarta fila es la que hoy se pinta en verde (GC-AUD-033). Merece decirse con precisión: **una captura interrumpida puede contener fragmentos remotos perfectamente protegidos y utilizables.** El veredicto correcto no es «no protegido» —eso también sería mentir, en la dirección contraria— sino nombrar los dos hechos. Degradar todo lo interrumpido a «fallo» destruiría valor real: en el escenario que define el producto, esos fragmentos remotos pueden ser toda la evidencia que exista.

---

## 4. Alcance y limitaciones

### Lo que he hecho

- Lectura completa de `mobile/app/index.tsx` (7 376 líneas) en sus rutas críticas, y de los 30 módulos de `mobile/src`, `backend/src` (27 ficheros), migraciones, manifests y configuración.
- Lectura de los 40 documentos de `/docs`, 8 de `/playbook`, 7 de `/strategy`, `AGENTS.md`, `CLAUDE.md`, `REBUILD.md`.
- Ejecución de las suites de test y typecheck de ambos paquetes (§6).
- Verificación estática de manifest Android, tipos de foreground service, permisos, deep links y esquema OAuth.
- Búsqueda de secretos en árbol de trabajo e historial de git.

### Lo que NO he podido hacer — y por tanto no afirmo

| Limitación | Consecuencia |
|---|---|
| **No hay dispositivo Android** | Ningún comportamiento de ciclo de vida, foreground service, cámara, micrófono, Doze, OEM killer o reinicio está reproducido. Todo lo marcado «requiere prueba física» es exactamente eso. |
| **No hay credenciales reales** | Ni Supabase, ni Google Drive, ni NAS. Ninguna subida real ha ocurrido. OAuth end-to-end no verificado. |
| **`npm` no está disponible** | `npm audit` **no se ha ejecutado**. No hago ninguna afirmación sobre vulnerabilidades de dependencias. |
| **Node no está en el `PATH`** | Usé un binario `node` v24.11.1 ya presente en el sistema. `backend/package.json:8` declara `node >=20`, rango que **Node 24 satisface**, así que la ejecución es conforme al motor declarado. Lo que desconozco es la versión **exacta** del runtime de producción; si allí está fijada otra, hay que repetir la medición para establecer paridad. |
| **Sin ESLint configurado** | No hay script de lint en ninguno de los dos `package.json`. No se ha ejecutado lint. |
| **Git requiere excepción de propiedad** | Todos los comandos git se ejecutaron con `-c safe.directory=...` en línea. No se modificó configuración global. |

**No he modificado, borrado ni descartado ningún fichero existente.** Los únicos ficheros creados son los tres informes de `docs/audits/`.

---

## 5. Mapa del sistema real

```
D:\guardian-cloud
├── mobile/                    Expo SDK 54 · RN 0.81.5 · React 19 · expo-router
│   ├── app/
│   │   ├── index.tsx          ★ 7 376 líneas — cola + worker + chunkers +
│   │   │                        recovery + reconciliación + UI de Home
│   │   ├── session/[id].tsx    2 186 — detalle + export
│   │   ├── settings.tsx        1 059 — destinos, Drive, diagnósticos
│   │   ├── recover/            recovery cross-device (índice + detalle)
│   │   ├── history.tsx         382
│   │   ├── oauth/drive.tsx     293 — callback deep link
│   │   └── debug-camera-probe/ 780 (duplicado en dos rutas anidadas)
│   ├── src/
│   │   ├── api/               client, export (1 673), exportRunner, history,
│   │   │                      destinations, recovery, recoveryExport, health
│   │   ├── recording/         audioChunkProducer, backgroundService (489),
│   │   │                      chunkProducer, deriveGuardianStatus,
│   │   │                      localEvidence, orphanScan (396),
│   │   │                      recordingController, videoFileProducer (204)
│   │   ├── audio/audioEngine.ts   única frontera con expo-audio
│   │   ├── auth/              store (zustand) + supabase
│   │   ├── oauth/exchangeGuard.ts
│   │   ├── permissions/       notifications, battery, store, reliability
│   │   └── dev/reset.ts
│   ├── tests/                 10 ficheros · 138 tests
│   └── android/               prebuild materializado (manifest en árbol)
│
├── backend/                   Node ≥20 · Express 4 · Supabase · zod · pino
│   ├── src/routes/            sessions, chunks, destinations (1 166),
│   │                          recovery, health
│   ├── src/services/          drive (1 164), recovery (895), manifest (590),
│   │                          chunks (411), sessions (312), destinations
│   ├── src/adapters/          webdav.adapter.ts (341)
│   ├── src/middleware/        auth, rateLimit, validate, errorHandler
│   ├── src/security/          webdavCredentials.ts (AES-256-GCM)
│   ├── migrations/            0001 sessions · 0002 chunks · 0003 destinations
│   │                          · 0004 destinations_nas
│   └── tests/                 9 ficheros · 106 tests
│
├── docs/                      40 ficheros (fuente de verdad)
├── playbook/                  8 (UX_STRESS_RULES.md está VACÍO)
├── strategy/                  7
└── [ruido en la raíz]         app/, build.gradle.kts, gradlew*, gradle/,
                               settings.gradle.kts  → proyecto Gradle vestigial
                               _deltas/             → copia obsoleta de la app
                               "Pagina web"/        → assets de marketing
                               recovered_evidence/  → vacío
                               "tash push -u -m …"  → 147 KB, TRACKEADO en git
                               "tash show --stat"   → 20 KB, TRACKEADO en git
                               table-nas-routing    → salida de git log, TRACKEADO
```

### Flujo real de la evidencia

**AUDIO** — la invariante se cumple:

```
GRABAR
 └─ signInAnonymously (si no hay sesión)        index.tsx:4166
 └─ Crypto.randomUUID() local-first            index.tsx:4805
 └─ startBackgroundProtection() [paralelo]     index.tsx:4848
 └─ POST /sessions [paralelo, no bloquea]      index.tsx:4888
 └─ startAudioRecording() → cacheUri           audioEngine.ts:174
 └─ queueAppendNewSession()                    index.tsx:5063
 └─ startChunkerForSession()                   index.tsx:5097
 └─ UI: "Grabando"                             index.tsx:5108
     │
     ├─ cada 1 500 ms: runAudioChunkerTick     index.tsx:2689
     │   └─ lee TODO el fichero como base64  ⚠ O(fichero) por tick
     │   └─ mientras queden ≥32 KB → emitChunk
     │       ├─ sha256 sobre bytes decodificados   index.tsx:2827
     │       ├─ escribe base64 A DISCO primero     index.tsx:2876
     │       │   documentDirectory/chunks/{sid}/{idx}.b64
     │       ├─ queueAppendChunk (metadata sólo)   index.tsx:2888
     │       └─ uploadDrainLoop() [fire&forget]    index.tsx:2915
     │
     └─ worker (single-flight, isDraining):    index.tsx:1932
         pickNext → menor índice 'pending'     index.tsx:1901
         → status='uploading'                  index.tsx:2036
         → uploadChunkBytes → backend → Drive
         → postChunk → POST /chunks (metadata)
         → status='uploaded' + poda + borra .b64
PARAR
 └─ stopAudioRecording → mueve a documentDirectory
 └─ stopChunkerForSession (pasada final, emite la cola)
 └─ queueMarkRecordingClosed
 └─ tryFinalizeReadySessions → puerta: TODO índice 0..n-1
                               debe estar 'uploaded' con remote_reference
 └─ completeSession → reapEntry (borra fichero + directorio)
```

**VÍDEO** — la invariante no existe:

```
GRABAR
 └─ ... idéntico hasta ...
 └─ cameraRef.recordAsync()                    index.tsx:4992
 └─ cacheUri = ''                              index.tsx:5005   ⚠ URI vacía en cola
 └─ if (mode === 'audio') startChunker         index.tsx:5096   ⚠ NO se ejecuta
 └─ UI: "Grabando" / "Protegiendo evidencia"                    ⚠ falso
     │
     └─ ────── NADA. Cero chunks. Cero red. ──────
        El .mp4 crece en cacheDirectory, sólo local.
PARAR
 └─ stopRecording → recordAsync resuelve con la URI
 └─ mueve a documentDirectory
 └─ chunkVideoFile(finalUri)                   index.tsx:5349
     ├─ if (size > 5 MB) throw VIDEO_TOO_LARGE_FOR_MVP  ⚠ CERO chunks
     ├─ lee TODO el fichero como base64  (~6,7 MB en JS para 5 MB)
     └─ trocea en 128 KB → videoChunkSink → cola
 └─ (a partir de aquí, idéntico al camino de audio)
```

---

## 6. Resultados de comandos y pruebas

Todos los comandos son de sólo lectura. Ninguno modifica lockfiles, cachés, dependencias ni infraestructura.

> **ADJUDICADO — sobre la versión de Node.** Se usó un binario **Node v24.11.1** ya presente en el sistema, porque Node no estaba en el `PATH`. `backend/package.json:8` declara `node >=20`, **rango que Node 24 satisface**: la ejecución es conforme al motor declarado y **estos resultados son evidencia de auditoría válida**.
>
> Lo que sí procede: **repetirlos bajo la versión exacta del runtime de producción** —Node 20 si es la que realmente está fijada allí— para establecer **paridad y baseline de remediación**. Es la fase B del plan, y su función es dar un punto de comparación fiable contra el que medir las regresiones de las fases C-F, no invalidar lo ya medido.
>
> **No atribuyo los fallos actuales a la versión de Node**, porque la evidencia apunta a otra cosa: los tres fallos de contrato son diferencias de aserción (`200` esperado / `201` devuelto; campo `status: 'active'` no contemplado) y el cuarto es un mock incompleto (`No "CONFIGURED_ISSUER" export is defined on the mock`). Ninguno tiene relación con el motor. Afirmar lo contrario sin evidencia sería exactamente el tipo de suposición que esta auditoría reprocha a la documentación del proyecto.

| # | Comando | Resultado |
|---|---|---|
| 1 | `pwd` | `/d/guardian-cloud` ✔ raíz confirmada |
| 2 | `git branch -a` | 12 ramas locales, 14 remotas. Activa: `main` |
| 3 | `git status --short` | 2 modificados (`mobile/app/index.tsx`, `mobile/app/settings.tsx`), 4 sin rastrear. **No alterados.** |
| 4 | `git log --oneline -25` | HEAD `dea0ed0`; 21 tags |
| 5 | `mobile: tsc --noEmit` | ❌ **13 errores** |
| 6 | `mobile: vitest run` | ✅ **138/138 verdes** · 10 ficheros · 1,40 s |
| 7 | `backend: tsc --noEmit` | ❌ **1 error** (`rateLimit.ts:25`) — el conocido y aceptado |
| 8 | `backend: vitest run` | ❌ **4 fallos / 102 pasan (106)** + 1 unhandled error |
| 9 | `npm audit` | ⛔ **NO EJECUTADO** — `npm` no disponible |
| 10 | lint | ⛔ **NO EXISTE** script de lint en ningún `package.json` |
| 11 | `grep -rn "\[x\]"` en docs/playbook/strategy | **0 resultados** — ningún checklist marcado nunca |
| 12 | búsqueda de secretos (árbol + historial, `-S`) | Sin secretos vivos. 1 hallazgo INFO (§9) |
| 13 | `wc -c playbook/UX_STRESS_RULES.md` | **0 bytes** |
| 14 | `diff CLAUDE.md AGENTS.md` | Difieren sólo en la línea 1 (título) |
| 15 | `wc -c docs/EVIDENCE_EXPORT_AND_FORENSIC.md` | **0 bytes** |
| 16 | `ls README.md` | **No existe** README en la raíz (sólo `docs/README.md`) |

### 6.1 Los 13 errores de typecheck de mobile

`app.config.ts` ×6 (tipos de plugin Expo y `ManifestService`), `app/index.tsx` ×4, `src/api/destinations.ts` ×1, `src/api/export.ts` ×1. Diez de ellos son la misma causa: `Uint8Array<ArrayBufferLike>` no asignable a `BufferSource` — un cambio de las librerías de TypeScript, **no un defecto de runtime**. Pero `RELEASE_CHECKLIST_v0.3.md:14` exige `tsc --noEmit` limpio. Por su propio criterio, la release está bloqueada.

### 6.2 Los 4 fallos de backend — detalle

| Test | Síntoma | Lectura honesta |
|---|---|---|
| `auth.test.ts` › «401 cuando el verificador rechaza (firma mala, expirado, issuer erróneo)» | **timeout a 5 000 ms**; causa raíz `No "CONFIGURED_ISSUER" export is defined on the mock` | El test que demuestra el rechazo de JWT inválidos **no pasa**. He leído `auth.ts` y `jwtVerifier.ts` y la verificación **sí es real** (§9). Pero la garantía está sostenida por mi lectura, no por la suite. |
| `chunks.test.ts` › «200 en pending → uploaded» | espera 200, recibe **201** | Drift de contrato entre test y ruta. |
| `sessions.test.ts` › «201 con body y JWT válidos» | el insert lleva `status: 'active'` no esperado | Drift de contrato. |
| `sessions.test.ts` › «ignora user_id del body» | ídem | La aserción de seguridad relevante (`user_id: 'user-real'` viene del JWT) **sí se cumple** en la salida observada. Falla por el campo extra. |

### 6.3 Qué cubren realmente los 138 tests verdes de mobile — y qué no

**Cubierto:** cola completa (append/read/update/drop/mark/bump), predicado del foreground service, reset de `uploading` al arrancar la app, ciclo de vida de un chunk, puerta de finalización con sus tres condiciones de bloqueo, reap, `reapAlreadyDoneEntries`, normalización (colapso de entradas duplicadas, dedup exacto, divergencia de hash), migración legacy, clasificación de errores, export desde chunk refs, runner de export, evidencia local, guard de OAuth, derivación de estado.

Es cobertura de calidad real, no de fachada.

**Sin ningún test automático:** `uploadDrainLoop` (**el worker**, no exportado y por tanto no testeable), `runAudioChunkerTick`, `runVideoChunkerTick`, `emitChunk`, `emitVideoChunk`, `VideoFileChunkProducer` (**todo el camino de vídeo**), `backgroundService.ts`, `orphanScan.ts`, `reconcileStaleSessionsWithBackend` (que **borra el fichero local**), `startRecording`, `stopRecording`.

En backend, además: **Supabase está mockeado en todos los tests**. Ningún test ejercita un `.eq('user_id', …)` real. Un refactor que eliminara un filtro de propiedad dejaría la suite entera en verde.

---

## 7. Hallazgos por severidad

### Recuento (verificado en la adjudicación)

| Severidad | Nº | IDs |
|---|---|---|
| **CRÍTICO** | **4** | 001, 002, 003, 033 |
| **ALTO** | **10** | 004, 005, 006, 007, 008, 009, 034, 035, 036, 037 |
| **MEDIO** | **17** | 010, 011, 012, 013, 014, 015, 016, 017, 018, 019, 020, 021, 038, 039, 040, 041, 042 |
| **BAJO** | **12** | 022, 023, 024, 025, 026, 027, 028, 029, 030, 031, 032, 043 |
| **Total** | **43** | GC-AUD-001 … GC-AUD-043, sin huecos ni duplicados |

> Corrección: el resumen verbal entregado al cierre de la primera fase citó «9 ALTO / 13 BAJO». La cifra correcta, y la que refleja el cuerpo de este informe, es **10 ALTO / 12 BAJO**. El total (43) y los CRÍTICO (4) y MEDIO (17) no cambian.


### CRÍTICO

---

#### GC-AUD-001 — Modo vídeo: cero subida durante la grabación

- **Severidad:** CRÍTICO · **Confianza:** alta · **Estado:** confirmado
- **Invariante afectado:** I1 (subida durante grabación), I6 (evidencia fuera del dispositivo ASAP), promesa central
- **Evidencia:** `mobile/app/index.tsx:5092-5098`; `mobile/src/recording/videoFileProducer.ts:77-79`; `mobile/app/index.tsx:5347-5349`
- **Impacto real:** durante toda una grabación de vídeo la evidencia existe **únicamente** en el dispositivo. Confiscación, destrucción, robo o batería agotada durante la grabación ⇒ pérdida del 100 %. El producto no cumple su función en el modo que un usuario elegiría precisamente cuando la prueba visual importa.
- **Reproducción mínima:** poner modo Vídeo → GRABAR → esperar 60 s sin parar → observar que no se emite ningún `GC_QUEUE chunk emitted` y que la cola tiene `chunks: []`.
- **Recomendación adjudicada — ESTA ES LA CAUSA RAÍZ P0.** No hay remediación por copy ni por ocultación:
  - **Contención inmediata (no es la solución):** ocultar el modo vídeo y hacer que la UI deje de mentir (GC-AUD-004). Reduce el daño mientras se construye la solución. **No hace liberable v0.3.**
  - **Solución:** introducir un **productor de captura segmentada de vídeo** que emita fragmentos durables *durante* la grabación, y **conectarlo al pipeline existente**. El contrato ya existe: `ChunkProducer` / `ChunkPayload` (`mobile/src/recording/chunkProducer.ts`) y el sumidero `videoChunkSink` (`index.tsx:3052`) ya escriben a disco y llaman a `queueAppendChunk`. El productor nuevo se registra igual que `VideoFileChunkProducer`, pero emite mientras la cámara graba en lugar de después.
  - **Restricción de diseño vinculante:** **no se crea un segundo pipeline de subida.** `GC_QUEUE`, el worker y el retry/backoff **se reutilizan**, no se duplican ni se bifurcan por modo.
  - **Lo que NO se afirma:** que un fragmento de vídeo sea *indistinguible* de uno de audio desde `queueAppendChunk` en adelante. **Eso hay que demostrarlo, no suponerlo.** Un fragmento de vídeo no es una rebanada de bytes arbitraria: puede necesitar segmento de inicialización, cabeceras de contenedor, marcas temporales y una pista de audio sincronizada. El spike debe determinar si el vídeo exige **cambios mínimos y compatibles** en:

    | Dimensión | Pregunta que el spike debe responder |
    |---|---|
    | Metadata de segmento | ¿Basta `{chunk_index, hash, size}` o hace falta duración, offset temporal o marca de inicialización? |
    | Códec y contenedor | ¿Qué contenedor permite prefijos válidos? ¿Se puede replicar para vídeo la propiedad que AAC ADTS da al audio? |
    | Timestamps y duración | ¿Cómo se preserva la línea temporal entre segmentos? |
    | Segmento de inicialización | ¿Existe una cabecera que todo segmento posterior necesita? ¿Se sube una vez o va en cada uno? |
    | Manifest | ¿Necesita campos nuevos para que la reconstrucción sea posible sin el dispositivo original? |
    | Export / muxing | ¿Concatenar bytes sigue siendo válido, o hace falta un paso de remux? |

    Cualquier cambio en estas capas debe ser **mínimo, compatible hacia atrás con las sesiones de audio existentes, y justificado por una medición del spike**. Adaptar la capa multimedia es aceptable; duplicar la capa de transporte no lo es.
  - **La decisión técnica real** —segmentación nativa del `MediaRecorder`, rotación de ficheros por intervalo, o formato fragmentado— es lo que debe resolver el spike aislado (fase C del plan de remediación) **antes** de tocar `startRecording`.
- **¿Añade complejidad?** Sí, y **está justificada**: es la única forma de que el producto cumpla su propósito en un modo que v0.3 incluye. La complejidad se acota al **productor nuevo más los ajustes multimedia mínimos que éste exija** (§7 · GC-AUD-001, restricción de reutilización). `GC_QUEUE`, worker, retry, backend, recovery y export **ya existen y tienen cobertura parcial**; su comportamiento end-to-end **sigue sin demostrarse en dispositivo real**, y el spike es quien debe medirlo.
- **Nota de método:** `DEBUGGING_RULES.md:64-76` prohíbe tocar varias capas a la vez. Eso no bloquea este trabajo: lo ordena. Por eso el plan lo separa en spike aislado (C) → integración (D) → semántica de interrupción (E), y no en un único cambio.

---

#### GC-AUD-002 — Sesión de vídeo interrumpida: pérdida total silenciosa + sesión marcada «completada» con 0 chunks

- **Severidad:** CRÍTICO · **Confianza:** alta · **Estado:** confirmado (por análisis estático; el efecto sobre el backend requiere prueba física)
- **Invariante afectado:** I5 (recovery automático), integridad de estado
- **Evidencia:** cadena completa —
  1. `index.tsx:5005` — la entrada de cola de vídeo se crea con `uri: ''` y `chunks: []`.
  2. `index.tsx:4530-4543` — el recovery de arranque marca **todas** las entradas `recording_closed = true`.
  3. `index.tsx:2301-2310` — `expectedChunks = entry.next_chunk_index` = **0** ⇒ el bucle `for (i=0; i<0; i++)` no encuentra ningún índice ausente ⇒ `missingUploadedIndexes` vacío.
  4. `index.tsx:2427-2434` — se llama a `completeSession()` y a continuación a `reapEntry()`.
  5. `orphanScan.ts:224-270` — escanea **sólo `documentDirectory`** y **sólo** ficheros con prefijo `guardian_recording_`. El `.mp4` en vuelo está en `cacheDirectory` con el nombre que le puso expo-camera ⇒ **invisible**.
- **Impacto real:** el usuario graba vídeo, la app muere (swipe-close, crash, OOM, force-stop, OEM killer, batería), reabre la app, y el sistema **le informa de que la sesión está completa**. No hay evidencia en Drive, no hay banner de huérfanos, no hay error. El backend queda con una sesión `completed` de cero chunks. Es la peor combinación posible: pérdida de datos presentada como éxito.
- **Reproducción mínima:** grabar vídeo 30 s → force-stop desde Ajustes de Android → reabrir → observar `GC_QUEUE completion gate {expectedChunks: 0, missingUploadedIndexes: []}` seguido de `GC_QUEUE session completed`.
- **Recomendación adjudicada:** tres piezas, y hay que ser claro sobre qué resuelve cada una.
  - **(a) Guarda de completitud.** En `tryFinalizeReadySessions`, **no llamar a `completeSession` cuando `expectedChunks === 0`**. Deja la entrada visible en lugar de fabricar una sesión «completa» vacía. *Resuelve el estado falso.*
  - **(b) Estado explícito de terminación.** Persistir `capture_end_reason` (ver §3bis y matriz §10): una entrada recuperada al **arrancar la app** sin cierre previo es **`process_terminated` / `interrupted_unknown`** —**no** `interrupted_kill`, porque la causa no se conoce— y eso debe propagarse a la sesión y al manifest. *Resuelve la causa: hoy el sistema no sabe distinguir «no faltaba ninguno» de «no llegué a emitir ninguno».*
  - **(c) `scanOrphans` sobre `cacheDirectory` — MITIGACIÓN, no garantía.** Hace visible el fichero, y eso es mejor que nada. Pero **un `.mp4` interrumpido carece del átomo `moov`** —MediaRecorder lo escribe al cerrar— y por tanto **no es reproducible**. Presentarlo como «recuperación de la evidencia de vídeo» sería cometer exactamente el error que este informe denuncia. La recuperación real de vídeo interrumpido **sólo llega con GC-AUD-001**.
- **¿Añade complejidad?** (a) es una condición y **reduce** riesgo. (b) es un campo persistido y su propagación: complejidad moderada y plenamente justificada, porque sin él la UI no puede decir la verdad. (c) es un directorio más en un escáner existente.

---

#### GC-AUD-003 — Vídeo de más de 5 MB: cero chunks, evidencia perdida al parar

- **Severidad:** CRÍTICO · **Confianza:** alta · **Estado:** confirmado
- **Invariante afectado:** I6, tolerancia a fallo
- **Evidencia:** `videoFileProducer.ts:72` `VIDEO_MAX_SIZE_BYTES = 5 * 1024 * 1024`; `:146-157` lanza `VIDEO_TOO_LARGE_FOR_MVP` **antes** de leer o emitir nada. Con `videoBitrate = 500 000` (`index.tsx:374`, aplicado en el `CameraView` en `:6340`) más audio, 5 MB ≈ **75-80 segundos** de grabación.
- **Impacto real:** cualquier grabación de vídeo de más de ~80 s produce **cero** evidencia. El usuario sólo se entera al pulsar PARAR, cuando ya es tarde. `VIDEO_MAX_DURATION_S` está fijado en **una hora** (`index.tsx:357`), de modo que la UI invita explícitamente a grabaciones que el pipeline no puede procesar.
- **Reproducción mínima:** grabar vídeo 2 minutos → PARAR → `VIDEO_TOO_LARGE_FOR_MVP` en logs, `VIDEO_CHUNKS_ENQUEUED` nunca aparece, sesión sin chunks.
- **Recomendación adjudicada:** el tope de 70 s **queda retirado como solución principal**. Grabar 70 segundos como máximo no es un producto de evidencia; es una limitación disfrazada de característica.
  - **Contención temporal, admisible SÓLO mientras el modo vídeo esté oculto:** alinear `VIDEO_MAX_DURATION_S` con `VIDEO_MAX_SIZE_BYTES` para que el camino post-stop nunca pueda producir cero chunks. Si el vídeo vuelve a ser visible con el pipeline post-stop, esta contención **no basta**.
  - **Solución:** la captura segmentada de GC-AUD-001 elimina el problema de raíz. Un productor que emite fragmentos durante la grabación nunca lee el fichero entero, nunca depende de un tope de tamaño y no tiene techo de duración por OOM.
- **¿Añade complejidad?** La contención: ninguna. La solución es la misma que GC-AUD-001 — **no es trabajo adicional**, es el mismo trabajo resolviendo dos hallazgos.

---

### ALTO

---

#### GC-AUD-004 — La UI afirma «Protegiendo evidencia» cuando no hay nada protegido

- **Severidad:** ALTO · **Confianza:** alta · **Estado:** confirmado
- **Invariante afectado:** claridad y confianza; `UI_SCREENS.md:237-240`
- **Evidencia:** `index.tsx:1583-1584` — `case 'grabando': return 'Protegiendo evidencia';`. `deriveGuardianStatus.ts:64` hace que `isRecording` domine sobre todo lo demás, así que el mensaje es idéntico en audio y en vídeo, y desde el segundo cero.
- **Impacto real:** es exactamente la pregunta que el brief plantea —«¿comunica certeza donde sólo existe un estado parcial?»— y la respuesta es sí. En vídeo la afirmación es falsa durante toda la grabación. En audio es falsa durante los primeros ~5-7 segundos. Un usuario en riesgo que lee «Protegiendo evidencia» toma decisiones sobre esa base.
- **Reproducción mínima:** abrir la app, GRABAR en modo vídeo, leer la pantalla.
- **Recomendación mínima:** derivar el texto del estado real de la cola en vez de sólo de `isRecording`: sin chunks subidos → «Grabando · aún nada protegido»; con ≥1 subido → «Grabando · N fragmentos protegidos». `deriveGuardianStatus` ya recibe `uploadedCount` y `totalCount`, así que la información está disponible sin tocar nada más.
- **¿Añade complejidad?** Mínima, y aislada en una función pura ya cubierta por 11 tests. Justificada: es la diferencia entre informar y engañar.

---

#### GC-AUD-005 — Cifrado local declarado obligatorio en seis documentos; no existe

- **Severidad:** ALTO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** declarado en `MVP_SCOPE.md:8`, `START_HERE.md:53`, `ARCHITECTURE.md:16` y `:89`, `docs/README.md:3`, y **`SECURITY.md:49-51` bajo el epígrafe «Obligatorio en MVP»**. Implementación: `index.tsx:541-542`, un `TODO` que dice literalmente *«chunks are uploaded in clear today»*. Búsqueda de `encrypt|AES|cipher|SecureStore|Argon2|keystore` en `mobile/src` + `mobile/app`: **una única coincidencia**, ese TODO.
- **Impacto real:** los chunks viajan en claro desde el móvil, pasan por un backend intermedio que los ve en memoria, y se depositan en Drive sin cifrar por la app. Para un producto dirigido a activistas y situaciones de riesgo, la diferencia entre «cifrado localmente» y «en claro a través de un proxy» es material. No figura en `KNOWN_DEBT.md`, que es exactamente el fichero encargado de registrar esto.
- **Matiz que registro en lugar de esconder:** `ANTI_PATTERNS.md:68-69` prohíbe «cifrado complejo que ralentiza» y «validaciones que bloquean subida». Omitir el cifrado es **defendible como decisión de producto** (supervivencia > confidencialidad). Lo que no es defendible es que seis documentos lo den por hecho.
- **Recomendación mínima:** **decidir y documentar**, no implementar a ciegas. Si se mantiene fuera del MVP: corregir los seis documentos y añadir la entrada a `KNOWN_DEBT.md`. Si entra: es un proyecto en sí mismo, no un parche.
- **¿Añade complejidad?** Corregir los documentos: cero. Implementar cifrado: mucha, y **no la recomiendo ahora** — chocaría con `ANTI_PATTERNS.md` y con la prioridad «subir > perfeccionar».

---

#### GC-AUD-006 — SSRF autenticado a través de la superficie NAS/WebDAV

- **Severidad:** ALTO · **Confianza:** media-alta · **Estado:** probable (cadena verificada en código; explotación no ejecutada)
- **Evidencia (cadena de 4 eslabones, todos verificados por lectura directa):**
  1. `backend/src/routes/destinations.routes.ts:135-149` — el usuario elige libremente `webdav_url` (sólo se exige `https:` en producción).
  2. `backend/src/routes/chunks.routes.ts:47` — `remote_reference: z.string().nullable().optional()` — **sin restricción de formato, esquema ni longitud**.
  3. `backend/src/routes/sessions.routes.ts:305` — la guarda es `chunk.remote_reference.startsWith(expectedPrefix)`, y `expectedPrefix` se **deriva del propio valor que el usuario escribió**. `startsWith` se satisface con `…/GuardianCloud/{sid}/../../ruta`, que `fetch` normaliza.
  4. `backend/src/adapters/webdav.adapter.ts:279-283` → `sessions.routes.ts:376` — el backend hace el GET y **devuelve el cuerpo al llamante**.
- **Impacto real:** GET arbitrario desde la posición de red del backend (homelab) con el cuerpo devuelto al atacante, más un oráculo de host/puerto por los códigos de error distintos. El lado de escritura (`MKCOL` + `PUT`) es igualmente alcanzable.
- **Atenuantes que registro con honestidad:** requiere cuenta autenticada; HTTPS obligatorio en producción bloquea el objetivo clásico `http://169.254.169.254/`; las credenciales Basic filtradas al host elegido son **las del propio atacante**, no de otro inquilino. No hay lista de bloqueo de RFC1918/loopback/link-local en ninguna parte del código.
- **Reproducción mínima:** conectar un NAS apuntando al host objetivo, registrar un chunk con `remote_reference` que use `..`, llamar a `GET /sessions/:id/chunks/:index/download`.
- **Recomendación mínima:** normalizar la URL antes de comparar (`new URL(ref)` y comparar `origin` + `pathname` normalizado, no `startsWith` sobre la cadena cruda) y restringir `remote_reference` en el esquema. Adicionalmente: lista de bloqueo de rangos privados.
- **¿Añade complejidad?** Poca y bien acotada. Justificada. **Pero ver GC-AUD-013**: la respuesta más simple y más alineada con el proyecto es que NAS no debería estar activo en v0.3.

---

#### GC-AUD-007 — La suite de backend está roja, incluido el test de rechazo de JWT

- **Severidad:** ALTO · **Confianza:** alta · **Estado:** confirmado (ejecutado)
- **Evidencia:** §6.2. `RELEASE_CHECKLIST_v0.3.md:28` exige «`npm test` verde».
- **Impacto real:** el control de seguridad más importante del backend —rechazar tokens con firma inválida, expirados o de otro emisor— **no está demostrado por la suite**. He leído el código y la verificación es real (`jwtVerifier.ts:84-119`), así que no afirmo que exista un fallo de seguridad; afirmo que **la red de seguridad que lo detectaría está caída**. Los otros tres fallos son drift de contrato (200 vs 201, campo `status` extra), baratos de arreglar.
- **Recomendación mínima:** arreglar el mock (`CONFIGURED_ISSUER` debe exportarse desde el mock de `jwtVerifier.js`) y alinear las tres aserciones de contrato. Añadir un test directo de `verifySupabaseJwt` **sin mock**, que hoy no existe.
- **¿Añade complejidad?** Ninguna. Es reparación de tests.

---

#### GC-AUD-008 — Foreground service tipado sólo como `microphone`, usado también en fases de sólo subida

- **Severidad:** ALTO · **Confianza:** media · **Estado:** **requiere prueba física**
- **Invariante afectado:** I5, subida en background
- **Evidencia:** `backgroundService.ts:176` `foregroundServiceType: ['microphone']`; `AndroidManifest.xml:26` `android:foregroundServiceType="microphone"`; `app.config.ts:100-139` declara `FOREGROUND_SERVICE_MICROPHONE` pero **no** `FOREGROUND_SERVICE_DATA_SYNC`. El servicio se arranca también en el arranque de la app con cola pendiente y se mantiene vivo durante `KEEPALIVE pending_uploads`, es decir, **cuando el micrófono no está en uso** (`backgroundService.ts:136-139`).
- **Impacto real:** en Android 14+ los servicios en primer plano están tipados y sujetos a precondiciones por tipo. Un FGS de tipo `microphone` mantenido para drenar la cola sin micrófono activo, o arrancado desde el arranque de la app con cola pendiente, es el patrón que Android 14/15 restringe. Si el SO lo rechaza o lo mata, se pierde exactamente la capacidad que sostiene «subir aunque cierres la app». El tipo correcto para trabajo de subida es `dataSync`.
- **Por qué no lo afirmo como confirmado:** depende del `targetSdkVersion` efectivo, de la versión de Android y del OEM. **No tengo dispositivo.** El propio código ya sospecha de esto: hay una batería de logs `GC_OEM_BG_*` (`backgroundService.ts:384-489`) construida para diagnosticar precisamente este escenario.
- **Reproducción mínima:** build release, Android 14 o 15, grabar audio → parar antes de que drene → minimizar → comprobar si la notificación sobrevive y si la cola termina de drenar. Repetir arrancando la app con cola pendiente (arranque de la app con cola pendiente).
- **Recomendación adjudicada — el trabajo de foreground service se divide en CINCO cambios independientes**, cada uno con su propia prueba y su propio rollback. Agruparlos es exactamente lo que `DEBUGGING_RULES.md:64-76` prohíbe:

  | # | Cambio | Hallazgo | Verificable sin dispositivo |
  |---|---|---|---|
  | **FGS-1** | **Permiso antes del servicio.** Esperar a `requestAudioPermissions()` antes de `startBackgroundProtection` | GC-AUD-035 | Sí (orden en el código); el crash, no |
  | **FGS-2** | **Tipos por escenario** (tabla siguiente). Declarar `FOREGROUND_SERVICE_CAMERA` y `FOREGROUND_SERVICE_DATA_SYNC` además del ya presente `FOREGROUND_SERVICE_MICROPHONE` | GC-AUD-008 | Sí (manifest + opciones) |
  | **FGS-3** | **Observabilidad real del arranque.** Dejar de tratar la resolución de `start()` como prueba; latido desde el cuerpo de la tarea que JS pueda leer; retirar la telemetría que no puede medir lo que dice | GC-AUD-034 | Sí (es lógica JS) |
  | **FGS-4** | **Recovery tras reinicio del dispositivo por un mecanismo permitido que actúe SIN intervención del usuario.** **No arrancar `camera`, `microphone` ni `dataSync` desde `BOOT_COMPLETED` en Android 15.** Hoy no existe receptor ni scheduler: tras reiniciar, la cola no drena hasta que el usuario abre la app — ese drenaje es el fallback existente y **no satisface** esta capacidad | GC-AUD-008 | Parcialmente (el mecanismo, sí; su eficacia, no) |
  | **FGS-5** | **Límites de Android 14/15.** Restricciones de arranque desde background, timeout acumulado de `dataSync` en Android 15, comportamiento OEM | GC-AUD-008 | **No — requiere dispositivo** |

  **Tipo según el trabajo real que el servicio esté haciendo:**

  | Escenario | Tipo requerido |
  |---|---|
  | Captura de **audio** | `microphone` |
  | Captura de **vídeo con audio** | `camera` **+** `microphone` |
  | **Sólo subida** (drenaje post-parada, drenaje al abrir la app) | `dataSync` **o un mecanismo permitido** equivalente |

  **No se asume que un único servicio deba declarar todos los tipos.** Concentrarlo todo en uno obliga a sostener permisos y tipos que no corresponden al trabajo en curso — que es el defecto actual (`microphone` durante subidas, con indicador de micrófono encendido). **El spike decide los límites**: uno o varios servicios, con qué ciclo de vida y qué transiciones.

  FGS-2 obliga a `expo prebuild` y por tanto a reaplicar el manifest (`RELEASE_CHECKLIST_v0.3.md:56-58` ya lo advierte). FGS-3 debería ir **antes** que FGS-5: sin observabilidad real del arranque, cualquier prueba física mide un sistema que no sabe informar de sus propios fallos.
- **¿Añade complejidad?** FGS-1 ninguna (reordenar). FGS-2 baja, y es lo que Android exige. FGS-3 **reduce** complejidad: parte de la telemetría actual puede retirarse porque no mide nada. FGS-4 es la única que añade una pieza nueva, y es la que hace que «recovery tras reinicio» deje de ser una afirmación sin implementación. FGS-5 es medición, no código.

---

#### GC-AUD-009 — `reconcileStaleSessionsWithBackend` compara CUENTAS, no conjuntos de índices, antes de borrar el fichero local

- **Severidad:** ALTO · **Confianza:** media · **Estado:** probable
- **Invariante afectado:** integridad, «no borrar antes de confirmación durable»
- **Evidencia:** `index.tsx:1437-1455` —
  ```ts
  const backendUploaded = backendChunks.filter(
    c => c.status === 'uploaded' && !!c.remote_reference).length;
  if (backendUploaded < expected) { … no reconciliar … }
  ```
  y si pasa, `index.tsx:1496` llama a `reapEntry`, que **borra el fichero de grabación local** (`index.tsx:2473`).
- **Impacto real:** la comparación es `count >= expected`. Si el backend tiene los índices `{0,1,2,4,5}` (5 subidos) y `expected = 5`, la condición se cumple pese a faltar el índice 3. Se marca la sesión completa y **se borra la única copia local**, dejando una evidencia con un hueco irrecuperable. Nótese el contraste: `tryFinalizeReadySessions` (`index.tsx:2301-2310`) sí construye un **conjunto de índices** y lo hace bien. La asimetría entre ambas es el defecto.
- **Por qué «probable»:** que el backend tenga índices fuera de rango requiere un camino previo poco común (reemisión, recovery de huérfano creando otra sesión). No lo he reproducido.
- **Reproducción mínima:** cola local con `next_chunk_index = 5`; backend con los índices 0,1,2,4,5 subidos; arrancar la app.
- **Recomendación mínima:** reutilizar la misma lógica de conjunto que ya usa la puerta de finalización: exigir que `{0..expected-1}` ⊆ índices subidos en backend.
- **¿Añade complejidad?** Ninguna — **reduce** la duplicación, porque unifica dos criterios que hoy divergen. Justificada.

---

### MEDIO

---

#### GC-AUD-010 — El worker bloquea toda la cola durante el backoff de un único chunk

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `index.tsx:2241` — `await sleep(backoff)` ocurre **dentro** del bucle `while(true)` y con `isDraining = true`. `pickNext` (`index.tsx:1901-1906`) recorre las entradas en orden y devuelve siempre el menor índice `pending` de la primera entrada que tenga alguno.
- **Impacto real:** un chunk que falla de forma transitoria de manera persistente (red mala, backend caído, 429) **detiene el progreso de todos los demás chunks y de todas las demás sesiones**, con esperas de hasta 30 s por intento y sin límite de reintentos. Bajo mala red —el escenario que el producto declara prioritario— la cola avanza al ritmo del peor chunk. No es pérdida de datos, pero sí retraso de la supervivencia.
- **Recomendación mínima:** no dormir dentro del lock. Registrar un `next_attempt_at` por chunk y hacer que `pickNext` salte los chunks aún en backoff; el bucle sigue con el siguiente candidato elegible.
- **¿Añade complejidad?** Un campo en el chunk y un filtro en `pickNext`. Moderada pero **justificada por supervivencia**: hoy un chunk envenenado retrasa toda la evidencia.

---

#### GC-AUD-011 — `tsc --noEmit` de mobile falla (13 errores); el checklist exige que esté limpio

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado (ejecutado)
- **Evidencia:** §6.1. `RELEASE_CHECKLIST_v0.3.md:14`.
- **Impacto real:** bloqueante de release por criterio propio. Diez de los trece son el mismo desajuste de librería de TS y no son defectos de runtime, pero mientras el comando falle nadie puede distinguir un error nuevo de este ruido de fondo.
- **Recomendación mínima:** resolver el desajuste `Uint8Array`/`BufferSource` en un punto (helper de conversión o ajuste de `lib`) y los tipos de plugin de `app.config.ts`.
- **¿Añade complejidad?** Ninguna.

---

#### GC-AUD-012 — Once de doce llamadas a Supabase no tienen timeout

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `backend/src/config/supabase.ts:16-29` construye el cliente sin timeout. Sólo `sessions.service.ts:57` añade uno (8 s). `getOwnedSession`, `listChunksForSession`, insert/update de chunks, `completeSession`, `getDestinationForUser` y `upsertDestination` no lo tienen. El comentario de `sessions.service.ts:52-56` diagnostica el problema correctamente; la corrección se aplicó a un solo sitio.
- **Impacto real:** ante un PostgREST inalcanzable o pausado, los handlers se cuelgan indefinidamente. Es la causa más probable de un bloqueo en producción, y afecta directamente a la ruta de registro de chunks.
- **Recomendación mínima:** aplicar el mismo patrón de timeout ya existente al resto de llamadas.
- **¿Añade complejidad?** Baja; **reduce** el riesgo de cuelgue. Justificada.

---

#### GC-AUD-013 — Un fallo de Drive durante el recovery se presenta como «no hay evidencia»

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `backend/src/services/recovery.service.ts:429-440` — cualquier fallo de listado o descarga de Drive devuelve `{ drive_not_connected: false, manifests: [] }`.
- **Impacto real:** una caída de Drive, un token revocado o una cuota agotada se le muestran al usuario como *«no tienes evidencia recuperable»*. Para un producto cuya promesa entera es la supervivencia de la evidencia, «vacío» y «roto» **no pueden ser la misma pantalla**. Este es el hallazgo que corregiría primero después de los CRÍTICOS, porque es barato y afecta a la confianza en el peor momento posible.
- **Recomendación mínima:** distinguir el estado de error del estado vacío en la respuesta y en la UI.
- **¿Añade complejidad?** Un campo en la respuesta y una rama en la UI. Justificada.

---

#### GC-AUD-014 — NAS/WebDAV está fuera de `MVP_SCOPE` y sin embargo bloquea la release

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `MVP_SCOPE.md:20-22` excluye «múltiples destinos» y «NAS». `ARCHITECTURE.md:80-81` dice «no parte de v0.3». `strategy/NAS_WEBDAV_DESIGN.md:3` dice «Ningún código escrito todavía». Implementado: migración `0004`, `webdav.adapter.ts` (341 líneas), `webdavCredentials.ts`, tres rutas, la rama NAS del endpoint de descarga. Y `RECOVERY_BETA_VALIDATION.md:484-489` convierte R14 en un **BLOCKER de release que exige un NAS conectado**.
- **Impacto real:** una superficie completa fuera de alcance documentado, ausente de `API_SPEC.md`, sin tests en sus caminos de riesgo, y que además alberga el único hallazgo ALTO de seguridad (GC-AUD-006). Según `CLAUDE.md §3`, `/docs` manda: esto es una violación de alcance documentado.
- **Recomendación mínima:** decidir explícitamente. O se pone tras un flag y sale de la ruta de release de v0.3, o se enmienda `MVP_SCOPE.md` y se le añaden los controles que su alcance exige. Lo que no debe sostenerse es el estado actual: activo, indocumentado y sin guardas.
- **¿Añade complejidad?** Un flag **reduce** superficie. Justificada.

---

#### GC-AUD-015 — El export acumula toda la sesión en memoria (~3× el tamaño del fichero)

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `export.ts:785` acumula cada chunk en `accumulated: Uint8Array[]`; `:202` concatena todo en un único `Uint8Array`; `:1021` lo convierte a **cadena base64** (`bytesToBase64`); `:1022` escribe. Ya registrado en `KNOWN_DEBT.md:11`.
- **Contradicción de estimación, resuelta explícitamente.** Durante la auditoría se produjeron dos cifras de pico de memoria para el mismo código y no deben conciliarse en silencio:

  | Estimación | Qué contabiliza | Cifra |
  |---|---|---|
  | **Conservadora (~3,3×)** | Sólo los búferes JS visibles en el código: `accumulated[]` (N) + `fullBytes` (N) + `fullBase64` (~1,33N) | **≈ 3,3N** |
  | **Pesimista (~8×)** | Lo anterior **más** la cadena latin1 intermedia de `bytesToBase64` (~2N si Hermes la almacena en UTF-16) y la copia al cruzar el puente JNI hacia el `String` de Java (~2,67N) | **≈ 8N** |

  **Ninguna de las dos está medida.** La diferencia depende por completo de dos cosas que no puedo verificar sin dispositivo: cómo representa Hermes internamente una cadena latin1 construida con `String.fromCharCode`, y si `writeAsStringAsync` copia o comparte el búfer al cruzar el puente. **El rango honesto es ~3,3N–8N**, y la cifra que importa —la real— sólo se obtiene con un perfilado en dispositivo. Se registra como tal, no como dato.
- **Impacto real:** una sesión de audio de 30 min (~14 MB) alcanza ~46 MB de pico. En gama baja el export puede fallar por OOM justo cuando el usuario necesita la evidencia. La deuda está reconocida, pero afecta a un camino que el MVP declara dentro de alcance.
- **Recomendación mínima:** escritura incremental por chunk (append) en lugar de concatenar y codificar de una vez. **No para v0.3** salvo que se observe en pruebas reales.
- **¿Añade complejidad?** Media. Justificada sólo después de v0.3.

---

#### GC-AUD-016 — Identidad anónima ligada al dispositivo: perder AsyncStorage es perder el acceso vía backend

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `index.tsx:4166` `supabase.auth.signInAnonymously()`. No hay pantalla de login. La sesión de Supabase se persiste vía AsyncStorage.
- **Impacto real:** es una decisión **excelente para la activación** (cumple I9: nada que decidir antes de grabar) y quiero reconocerlo. Pero tiene una consecuencia que ningún documento registra: si el dispositivo se pierde o se borran los datos de la app, el usuario **no puede recuperar sus sesiones a través del backend**, porque su identidad era el dispositivo. La única vía superviviente es el recovery cross-device vía manifests de Drive, que exige reconectar la misma cuenta de Google. La app no se lo explica en ningún momento.
- **Recomendación mínima:** documentar la propiedad y, en la UI, dejar claro que conectar Drive es lo que hace la evidencia recuperable desde otro dispositivo. No hace falta añadir login.
- **¿Añade complejidad?** Ninguna: es documentación y copy.

---

#### GC-AUD-017 — Inyección de HTML reflejado en el callback OAuth no autenticado

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `backend/src/routes/destinations.routes.ts:1104` — ``res.status(400).send(`OAuth error from Google: ${oauthError}`)`` con `oauthError` tomado sin escapar de `req.query.error`. La ruta no tiene ni auth ni rate limit.
- **Impacto real:** Express marca las respuestas de cadena como `text/html`, así que se renderiza marcado del atacante en el origen del backend. `helmet()` (`app.ts:89`) aplica CSP con `script-src 'self'`, lo que bloquea JS inline; queda HTML no-script (formularios, enlaces, phishing en el dominio propio). **Efecto secundario relevante:** esa misma CSP mata el redirect inline `<script>` de la propia página (`:1146`), de modo que uno de los tres mecanismos de redirección está muerto en cualquier navegador que respete CSP.
- **Recomendación mínima:** escapar la salida o devolver un mensaje fijo.
- **¿Añade complejidad?** Ninguna.

---

#### GC-AUD-018 — Contradicciones que impiden que la release pase su propio checklist

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:**
  - `RELEASE_CHECKLIST_v0.3.md:47` exige `<meta-data android:name="android.app.shortcuts">` en el manifest. **No está** (verificado sobre las 40 líneas de `AndroidManifest.xml`). El punto §4.9 (shortcut del lanzador) no puede pasar.
  - §4.9 exige además que el shortcut **NO** arranque grabación sola. Pero `index.tsx:6252-6260` dispara `startCountdown()` automáticamente en arranque en frío para usuarios recurrentes con quick-start armado, lo que acaba iniciando la grabación. Es *opt-in*, visible y cancelable —lo registro en su favor—, pero contradice el criterio escrito.
  - `:15` exige «99/99 verdes»; hoy hay 138 tests. El checklist no se ha actualizado.
- **Impacto real:** el gate de release está desalineado con el sistema que gobierna.
- **Recomendación mínima:** actualizar el checklist y decidir explícitamente la postura sobre el auto-inicio frente a la política de Play Store.
- **¿Añade complejidad?** Ninguna.

---

#### GC-AUD-019 — `DRIVE_NOT_CONNECTED` no está mapeado: el usuario recibe un botón «Reintentar» placebo

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `humanError.ts:46-89` mapea `HASH_MISMATCH`, `BODY_TOO_LARGE`, `SESSION_NOT_ACTIVE`, `INVALID_HEADERS`, `NAS_NOT_CONFIGURED`, `NAS_AUTH_FAILED`. **No mapea `DRIVE_NOT_CONNECTED`**, que cae al caso por defecto con `recoverable: true`.
- **Impacto real:** con Drive desconectado —el destino principal del MVP— el usuario ve «No se pudo enviar un fragmento / Lo demás se sigue intentando» y un botón que volverá a fallar igual. El propio módulo advierte contra esto en su cabecera (`:16-19`, «para que el usuario no pulse un placebo»). Los códigos de NAS —que están fuera de alcance— sí están cubiertos; el de Drive no.
- **Recomendación mínima:** añadir la entrada de `DRIVE_NOT_CONNECTED` con `recoverable: false` y CTA a Configuración.
- **¿Añade complejidad?** Ninguna: es una rama más en un `switch` existente.

---

#### GC-AUD-020 — El sistema no puede encolar si AsyncStorage supera el límite de CursorWindow

- **Severidad:** MEDIO · **Confianza:** media · **Estado:** probable (mitigado, no eliminado)
- **Evidencia:** `index.tsx:729-755` — si `getItem` lanza `Row too big`/`CursorWindow`, se registra `GC_QUEUE_CORRUPT_TOO_LARGE` y **se relanza** (decisión correcta: no se borra la cola). Pero a partir de ese momento **toda** `queueMutate` falla, de modo que la grabación continúa mientras nada se persiste.
- **Impacto real:** la migración a payloads en disco (`local_uri`) redujo mucho la exposición —la fila de la cola ya es sólo metadatos— y eso es un acierto real. Queda el crecimiento por número de chunks: una sesión muy larga sigue acumulando filas. El modo de fallo es silencioso desde el punto de vista del usuario.
- **Recomendación mínima:** el log de alta marca (`GC_QUEUE_PERSIST_HIGH_WATER_BYTES`, `:720`) ya existe; falta que el fallo de persistencia sea **visible en la UI** en lugar de sólo en logcat.
- **¿Añade complejidad?** Baja. Justificada por claridad.

---

#### GC-AUD-021 — La lógica de negocio vive dentro del componente de UI

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Invariante afectado:** I8 («la UI no debe contener lógica de negocio»), `ANTI_PATTERNS.md:18-24`, `CLAUDE.md §4`
- **Evidencia:** `mobile/app/index.tsx` tiene **7 376 líneas** e incluye la cola, el worker, los chunkers, el recovery, la reconciliación con backend, la migración y la pantalla Home.
- **Impacto real:** consecuencia concreta y medible, no estética: **`uploadDrainLoop` no está exportado y por eso no tiene ni un test**. El componente más crítico del sistema es intestable por su ubicación. Es también la razón por la que `DEBUGGING_RULES.md:64-76` («nunca tocar muchas capas a la vez») es tan difícil de cumplir aquí: todas las capas están en el mismo fichero.
- **Recomendación mínima:** **no refactorizar ahora.** Extraer únicamente `uploadDrainLoop` y los chunkers a `src/recording/` para poder testearlos, en un cambio aislado y con la suite verde antes y después.
- **¿Añade complejidad?** Un refactor amplio sí, y **no está justificado** — chocaría con `BETA_STABLE_BASELINE.md:131-140`. La extracción quirúrgica del worker sí lo está, porque compra cobertura de test sobre el componente más crítico.

---

### BAJO

| ID | Hallazgo | Evidencia | Confianza |
|---|---|---|---|
| **GC-AUD-022** | Tres ficheros basura **trackeados en git**: `tash push -u -m wip remaining mobile assets docs` (147 KB), `tash show --stat` (20 KB) y `table-nas-routing` — salidas de `git stash`/`git log` guardadas por errores de tecleo. Verificado que **no contienen secretos**. | `git ls-files` raíz | alta |
| **GC-AUD-023** | `_deltas/` contiene una copia obsoleta de la app (app.config, index.tsx, package.canonical.json…). Confunde búsquedas y auditorías. | `_deltas/` | alta |
| **GC-AUD-024** | Email personal hardcodeado en el código de producción: `HARDCODED_LEGACY_EMAIL = 'diego@hotmail.com'` | `index.tsx:4142` | alta |
| **GC-AUD-025** | `/debug-ping` sin auth ni rate limit, con comentario que pide eliminarlo; `cors()` totalmente abierto con TODO sin resolver | `backend/src/app.ts:113`, `:90` | alta |
| **GC-AUD-026** | Permisos Android sensibles sin uso evidente ni mención en el checklist: `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` — atraerán escrutinio de Play Store | `AndroidManifest.xml:8,11,14` | alta |
| **GC-AUD-027** | `DevQueueWipeBlock` definido y nunca renderizado (código muerto); `clearGuardianQueueDev` accesible desde Settings sin gate `__DEV__` por diseño explícito | `settings.tsx:924`, `index.tsx:1286` | alta |
| **GC-AUD-028** | Dos constantes distintas y coexistentes para el tamaño de chunk de vídeo: `CHUNK_SIZE_VIDEO = 256 KB` (`index.tsx:311`, camino en vivo muerto) y `VIDEO_FILE_CHUNK_SIZE_BYTES = 128 KB` (`videoFileProducer.ts:40`, camino real) | ambos ficheros | alta |
| **GC-AUD-029** | `docs/EVIDENCE_EXPORT_AND_FORENSIC.md` = 0 bytes; `playbook/UX_STRESS_RULES.md` = 0 bytes; 9 ficheros con vallas de código sin cerrar que rompen el renderizado (incluido `KNOWN_LIMITS.md`, contexto obligatorio); `MVP_SCOPE.md` duplica un bloque entero | verificado con `wc -c` | alta |
| **GC-AUD-030** | Todo el código usa `expo-file-system/legacy`. Funciona hoy; es un acantilado de deprecación para el siguiente SDK | 10 ficheros | alta |
| **GC-AUD-031** | `runAudioChunkerTick` lee **el fichero entero** como base64 en cada tick (cada 1,5 s) → coste O(fichero) por tick, cuadrático en la duración de la sesión | `index.tsx:2694-2696` | alta |
| **GC-AUD-032** | `KNOWN_LIMITS.md` —contexto obligatorio según `CLAUDE.md`— describe una limitación de **expo-av**, librería que el camino de grabación **ya no usa** (migrado a `expo-audio`). Su «Opción A — migración a expo-audio» ya está hecha. | `KNOWN_LIMITS.md` vs `audioEngine.ts:40-47` | alta |

---

### Hallazgos adicionales (segunda pasada)

---

#### GC-AUD-033 — El recovery cross-device presenta una sesión truncada como «Protegido / Evidencia recuperada correctamente»

- **Severidad:** CRÍTICO · **Confianza:** alta · **Estado:** confirmado
- **Invariante afectado:** claridad, confianza, integridad de la evidencia
- **Evidencia (cadena verificada eslabón a eslabón):**
  1. `backend/src/services/manifest.service.ts:209` — `chunk_count: uploaded.length`. El manifest registra los chunks que **sí** subieron, **no** los que debería haber. No existe ninguna verdad de referencia sobre el total esperado.
  2. `mobile/src/api/export.ts:606-607` — `totalChunks = chunks[chunks.length-1].chunk_index + 1`, derivado de esa misma lista truncada ⇒ `missingIndexes = []`.
  3. Todos los chunks descargan y verifican correctamente ⇒ `status = 'complete'`.
  4. `mobile/app/recover/[id].tsx:230-234` — `verdictFor` devuelve, **sin comprobar `completed_at` ni `protection_status`**:
     ```ts
     if (result.status === 'complete') {
       return { label: 'Protegido', color: '#3ddc84',
                hint: 'Evidencia recuperada correctamente.' };
     }
     ```
- **Impacto real:** una grabación interrumpida —app matada, batería agotada, teléfono confiscado a mitad— se reconstruye y se le presenta al usuario en **verde**, con la palabra «correctamente». En modo vídeo, además, el `.mp4` resultante carecerá del átomo `moov` y no será reproducible, pero la pantalla ya ha afirmado que está protegido. Es el peor lugar posible para esta mentira: el usuario está en recovery precisamente porque perdió el dispositivo, y este es el único juicio que va a recibir sobre su evidencia.
- **Contraste que agrava el hallazgo:** el camino de export normal **sí** se defiende de esto, mediante `expectedLocalChunks` (`session/[id].tsx:1470-1482`). El camino de recovery —el de mayor riesgo— no tiene ninguna defensa equivalente. Y la señal correcta ya existe y ya viaja en el payload: el backend calcula `protection_status: 'partial'` cuando `completed_at === null` (`recovery.service.ts:224-228`), la pantalla de **lista** la pinta como badge (`recover/index.tsx:310`), y la pantalla de **detalle** la descarta.
- **Reproducción mínima:** grabar, dejar subir unos chunks, cortar la red y matar la app antes de completar; reinstalar en otro dispositivo; abrir recovery; exportar. La sesión aparece como «Protegido».
- **Recomendación adjudicada.** Atención al matiz, porque la solución evidente es insuficiente:
  - **`completed_at` NO puede usarse como prueba de captura completa.** Sólo registra que se llamó a `/complete`, es decir **confirmación remota** (dimensión 4 de §10 de la matriz). Usarlo para responder «¿terminó bien la captura?» es el mismo error de categoría que causó el fallo, con otro campo. Peor aún: GC-AUD-002 hace que una sesión de vídeo interrumpida **sí** obtenga `completed_at`, con lo que este arreglo la seguiría pintando de verde.
  - **Contención inmediata:** que `verdictFor` deje de decidir sólo con `result.status`, y que nombre **los dos hechos por separado** (§3ter). **Regla dura: una sesión interrumpida nunca es «Protegido correctamente» por el mero hecho de que todos los chunks conocidos estén subidos**, porque la lista de chunks conocidos es precisamente lo que puede estar truncado. Estados exigidos:
    - captura interrumpida **con ≥1 fragmento remoto confirmado** ⇒ **«Hay evidencia protegida fuera del dispositivo; la grabación está incompleta»**;
    - captura interrumpida **sin ningún fragmento remoto** ⇒ **«Grabación incompleta; nada protegido fuera del dispositivo»**;
    - captura completa **con subida parcial** ⇒ **«N/M protegidos»**, sin declarar protección completa.

    **No** se aplica una regla general «todo `interrupted_*` ⇒ Protección parcial»: eso volvería a colapsar los dos hechos en una etiqueta.
  - **Solución de raíz:** propagar `capture_end_reason` al manifest y que el manifest registre el número de chunks **esperado**, no `uploaded.length`. Sólo entonces el cliente puede detectar un truncamiento sin depender del dispositivo original.
- **¿Añade complejidad?** La contención, casi ninguna. La raíz añade un campo al manifest y su propagación: justificada, porque sin ella el recovery cross-device **no puede** distinguir una sesión completa de una truncada — y el recovery cross-device es, por definición, el camino que se usa cuando ya no queda otra fuente de verdad.

---

#### GC-AUD-034 — Un arranque rechazado del foreground service es invisible a JS, y la telemetría construida para detectarlo no puede hacerlo

- **Severidad:** ALTO · **Confianza:** alta · **Estado:** confirmado (por lectura de la librería nativa; no requiere dispositivo)
- **Invariante afectado:** I5, subida en background
- **Evidencia:**
  1. `node_modules/react-native-background-actions/android/.../BackgroundActionsModule.java:53-54` — `ContextCompat.startForegroundService(...)` y **`promise.resolve(null)` en la línea siguiente**, antes de que `onStartCommand` llegue a ejecutarse.
  2. `node_modules/react-native-background-actions/src/index.js:84-85` — `await RNBackgroundActions.start(...)` seguido de `this._isRunning = true;` **incondicional**.
  3. `node_modules/react-native-background-actions/src/index.js:67-69` — `isRunning() { return this._isRunning; }` — devuelve ese booleano de JS, **no** el estado nativo.
  4. `RNBackgroundActionsTask.java:107-113` — un `ForegroundServiceStartNotAllowedException` (Android 12+, arranque desde background) se traga con `stopSelf()`; **ninguna excepción llega a JS**.
- **Impacto real:** si Android rechaza el arranque, la tarea headless nunca corre, el bucle de tick de `backgroundService.ts:103` nunca se ejecuta, y **el drenaje nunca ocurre**. Pero `isRunning` queda en `true` para siempre, así que la siguiente llamada entra por `backgroundService.ts:288-291` (`skipped: 'already_running'`) y **la protección en background queda muerta durante todo el resto de la vida del proceso JS, mientras todos los logs dicen que está sana**.
  El guard de «detección de deriva» de `backgroundService.ts:288-297` compara dos booleanos de JS que se escriben juntos: es una tautología. Y el comentario de `:326-328` —«si `bg_lib_isRunning_post` es false pese a que `start()` resolvió, el OEM rechazó el arranque en silencio»— describe algo **estructuralmente imposible**. Toda la batería de diagnósticos `GC_OEM_BG_*` está construida sobre una premisa falsa y **no puede detectar el fallo para el que se escribió**.
- **Recomendación mínima:** dejar de tratar la resolución de `start()` como prueba de nada. Verificar el arranque de forma indirecta y observable: comprobar en el siguiente tick que el cuerpo de la tarea llegó a ejecutarse (p. ej. un latido con marca de tiempo que JS pueda leer) y, si no, reintentar en vez de dar por bueno `already_running`.
- **¿Añade complejidad?** Baja. Y **elimina** complejidad inútil: buena parte de la telemetría OEM actual puede retirarse porque no mide lo que dice medir. Justificada.

---

#### GC-AUD-035 — El FGS de tipo `microphone` se arranca ANTES de conceder `RECORD_AUDIO`: `SecurityException` relanzada ⇒ crash nativo

- **Severidad:** ALTO · **Confianza:** media-alta · **Estado:** **requiere prueba física**
- **Evidencia:**
  - `mobile/app/index.tsx:4848` — `startBackgroundProtection({...})` se lanza **sin await**.
  - `mobile/app/index.tsx:4933` — `await requestAudioPermissions()` ocurre **después**.
  - `RNBackgroundActionsTask.java:100-115` — el `catch (RuntimeException e)` sólo neutraliza `ForegroundServiceStartNotAllowedException`; **cualquier otra se relanza** (`throw e`). Una `SecurityException` relanzada dentro de `onStartCommand` es un **crash nativo del proceso**, invisible para el `try/catch` de `backgroundService.ts:319-348` y para `installGlobalErrorHandler`.
  - En API 34+, `startForeground(..., FOREGROUND_SERVICE_TYPE_MICROPHONE)` lanza `SecurityException` si `RECORD_AUDIO` no está concedido.
- **Impacto real:** en la **primera grabación de la vida del usuario** —el momento más importante del producto— existe una carrera entre el arranque del servicio y el diálogo de permiso de micrófono. La misma ruta existe en el arranque de la app con cola pendiente (`index.tsx:4713-4732`): un usuario que haya revocado el micrófono y tenga cola pendiente puede hacer crashear la app **al abrirla**.
- **Por qué no lo doy por confirmado:** el desenlace exacto depende del tiempo del diálogo, de la versión de Android y del OEM. **No tengo dispositivo.** La ordenación insegura, en cambio, sí está confirmada por lectura.
- **Reproducción mínima:** instalación limpia, Android 14+, conceder notificaciones pero **no** micrófono todavía, pulsar GRABAR.
- **Recomendación mínima:** esperar a `requestAudioPermissions()` antes de arrancar el servicio, y/o declarar y usar `dataSync` para la fase de sólo subida (ver GC-AUD-008). El coste en latencia de activación es el de un permiso ya concedido en el caso común: prácticamente nulo tras la primera vez.
- **¿Añade complejidad?** Ninguna: es reordenar dos llamadas.

---

#### GC-AUD-036 — OAuth sin PKCE y con `state` nunca validado sobre un esquema reclamable: vinculación de cuenta ajena

- **Severidad:** ALTO · **Confianza:** media-alta · **Estado:** probable
- **Evidencia:**
  - Búsqueda de `code_challenge|code_verifier|PKCE` en `backend/src/services/drive.service.ts` y `mobile/src/api/destinations.ts`: **cero coincidencias**. No hay PKCE.
  - `backend/src/routes/destinations.routes.ts:293-294` — `state` se limita a viajar hacia `buildAuthUrl` y a devolverse en el JSON; `:1115` lo reinyecta en el redirect. **Nunca se compara con nada** en la rama de intercambio.
  - `mobile/app/settings.tsx:356-362` llama a `startDriveConnect(redirectUri)` **sin argumento de `state`**.
  - `AndroidManifest.xml:32-38` — esquema personalizado `guardiancloud://`, **sin `android:autoVerify`**, sin App Link HTTPS. Los esquemas personalizados no son reclamables en exclusiva en Android.
- **Impacto real:** el `code` de autorización se entrega a un esquema que cualquier app instalada puede registrar. Una app maliciosa que lo capture puede enviarlo al backend **de Guardian** bajo **su propio** token de Supabase; el backend, que es quien tiene el `client_secret`, lo canjea y **persiste el refresh token de Drive de la víctima asociado al `user_id` del atacante**. El atacante obtiene acceso persistente al Drive de la víctima. La mitigación estándar —`state` generado en servidor, ligado al usuario y **verificado** en el canje— es exactamente lo que falta.
- **Lo que sí está bien, y lo registro:** el `code` no se registra nunca en logs (`destinations.routes.ts:1088-1098` sólo loguea booleanos), y los refresh tokens de Drive **no se guardan en el dispositivo** (`mobile/src/api/destinations.ts:14-15`). `exchangeGuard.ts` es un guard de llamada duplicada, no un control de seguridad, y su propia cabecera lo dice.
- **Recomendación adjudicada — replanteamiento del flujo, no un parche sobre el actual.** El problema no es sólo que falte validar `state`: es que **el `authorization code` viaja por un esquema que cualquier app puede reclamar**. Validar `state` sin quitar el código de ese canal deja la mitad del ataque en pie.
  1. **Transacción `state` verificada en servidor.** El backend genera el `state`, lo liga al `user_id` autenticado, lo persiste con TTL corto y **lo verifica antes de canjear**. Un `state` ausente, caducado, ya consumido o de otro usuario ⇒ rechazo.
  2. **El canje se completa en el callback HTTPS del backend.** `GET /auth/drive/callback` ya recibe el `code` directamente de Google sobre HTTPS (`destinations.routes.ts:1086`). Ahí es donde debe canjearse, resolviendo el `user_id` desde la transacción `state`. **El `code` deja de reenviarse a `guardiancloud://`.** El deep link pasa a transportar únicamente un resultado no sensible («conectado / falló»), o nada, y la app confirma el estado con `getConnectedDrive`. Esto elimina el material sensible del canal interceptable en lugar de intentar protegerlo dentro de él.
  3. **PKCE y App Links: evaluar, no descartar.** PKCE es barato y defiende en profundidad aunque el cliente sea confidencial; con (2) deja de ser imprescindible, pero no hay razón para excluirlo. **App Links con `autoVerify` + `assetlinks.json`** eliminarían la reclamabilidad del esquema y ya hay dominio propio (`api.guardiancloud.app`), así que el coste es moderado. Ninguna de las dos debe descartarse por defecto; deben decidirse con criterio y dejar constancia.
- **¿Añade complejidad?** (1) un almacén efímero; (2) **mueve** lógica que ya existe al callback, sin crear un camino nuevo; (3) es configuración. Justificada: sin esto existe una vía de toma de control del Drive de la víctima.

---

#### GC-AUD-037 — Las builds de release se firman con el keystore de depuración

- **Severidad:** ALTO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `mobile/android/app/build.gradle:112-115`
  ```groovy
  release {
      // Caution! In production, you need to generate your own keystore file.
      signingConfig signingConfigs.debug
  }
  ```
  con `storePassword 'android'`, `keyAlias 'androiddebugkey'` (`:101-106`).
- **Impacto real:** es el valor por defecto de la plantilla de React Native, y las builds de EAS usan credenciales gestionadas por EAS, así que **no afecta a la ruta EAS**. Pero `RELEASE_CHECKLIST_v0.3.md:60-62` instruye explícitamente `cd android && ./gradlew assembleRelease` —que produce un APK firmado con una clave pública y conocida— y `:65` exige «AAB/APK firmado con keystore de release (**NO** con el debug.keystore)». **La configuración actual no puede satisfacer el requisito de su propio checklist.** Un APK así es suplantable por cualquiera.
- **Recomendación mínima:** o se añade un `signingConfigs.release` real, o el checklist deja de ofrecer la ruta gradle local y remite sólo a EAS.
- **¿Añade complejidad?** Ninguna.

---

#### GC-AUD-038 — Refresh token de Supabase en AsyncStorage plano con `allowBackup="true"`

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `mobile/src/auth/supabase.ts:20-27` usa `storage: AsyncStorage` con `persistSession: true`. `expo-secure-store` **no es dependencia** (ausente de `package.json`). `AndroidManifest.xml:22` declara `android:allowBackup="true"` y **no** hay `android:dataExtractionRules` ni `fullBackupContent`.
- **Impacto real:** AsyncStorage en Android es una base SQLite sin cifrar en almacenamiento privado. Con Auto Backup activo, esa base —incluido el refresh token de larga vida— puede copiarse a la copia de seguridad de Google del usuario. Para una app de custodia de evidencia es el valor por defecto equivocado.
- **Recomendación mínima:** excluir el almacén de auth del backup vía `dataExtractionRules`. Migrar a `SecureStore` es deseable pero mayor.
- **¿Añade complejidad?** La exclusión de backup: un fichero XML. Justificada.

---

#### GC-AUD-039 — Dos rutas de diagnóstico de cámara viajan en release y son alcanzables por deep link

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `mobile/app/debug-camera-probe/index.tsx` y `mobile/app/debug-camera-probe/debug-camera-probe/index.tsx` (**duplicada**, 390 líneas cada una). Son rutas reales de expo-router **sin gate `__DEV__`**. Piden cámara y micrófono, escriben ficheros y muestran logs crudos. Su propia cabecera dice «TEMPORARY … Delete this file once results are reported». No se borraron. Son además el **único** consumidor que queda de `expo-av`, cuya retirada desbloquearían.
- **Recomendación mínima:** borrar ambas rutas. Elimina superficie, elimina una dependencia deprecada y elimina un duplicado.
- **¿Añade complejidad?** Negativa: **quita** código.

---

#### GC-AUD-040 — El flujo completo de logs `GC_*` llega a logcat en release

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `src/utils/log.ts:32-34` silencia `log`/`warn` en release — bien diseñado, pero **sólo lo usan dos módulos** (`export.ts` y `backgroundService.ts`). `mobile/app/index.tsx` (7 376 líneas) usa `console.log` crudo, y `perfLog` (`:190-197`) envuelve `console.log` **incondicionalmente**. `backgroundService.ts:248,311,329` también usa `console.log` crudo a propósito. No hay plugin `transform-remove-console` en `babel.config.js`.
- **Impacto real:** en release se emiten UUID de sesión, URI de ficheros, recuentos de chunks y huella del dispositivo (`getOemFingerprint`). Cualquiera con acceso adb —o cualquier app con `READ_LOGS`— puede perfilar la actividad de grabación del usuario. `KNOWN_DEBT.md:9` ya lo anota como «logs should be reduced before release»; sigue pendiente.
- **Recomendación mínima:** enrutar `perfLog` y los `console.log` de diagnóstico a través de `log()`, que ya sabe silenciarse en release.
- **¿Añade complejidad?** Ninguna: es sustitución mecánica.

---

#### GC-AUD-041 — El export etiqueta un vídeo como `.m4a` / `audio/mp4` si se perdió la entrada de historial

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** el override a `.mp4` depende de `mode`, que se lee del índice **local** de historial (`session/[id].tsx:683-711` → `readHistory()`), limitado a `MAX_HISTORY_ENTRIES = 50` (`src/api/history.ts:35`). Si la entrada se desalojó —o el dispositivo es otro— `mode` es `null`, el sniff detecta `ftyp` y el fichero se escribe como **`.m4a` con MIME `audio/mp4`**.
- **Impacto real:** el usuario comparte un vídeo que el sistema operativo presenta como audio. `export.ts:654-655` ya identifica la causa raíz: `TODO(recording-format): guardar formato/extensión por sesión en el backend`.
- **Recomendación mínima:** persistir el formato en la sesión del backend, que es lo que el propio TODO propone.
- **¿Añade complejidad?** Una columna y su lectura. Justificada.

---

#### GC-AUD-042 — Copy contradictorio en la pantalla donde se juzga la evidencia

- **Severidad:** MEDIO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `session/[id].tsx:1748-1756` — cuando la cabecera pasa a rojo «**Evidencia dañada**», el párrafo de debajo es **incondicional** y sigue afirmando «…la parte recuperada es **íntegra**». Igual en la rama completa: `:1650-1652` imprime «Archivo generado correctamente» bajo la misma cabecera roja.
- **Impacto real:** es exactamente la pantalla en la que un usuario decide si entrega el fichero a un abogado o a la policía. Es técnicamente defendible (el chunk corrupto se excluye), pero la yuxtaposición es contradictoria.
- **Recomendación mínima:** condicionar ambos párrafos a `verdict.integrity`.
- **¿Añade complejidad?** Ninguna.

---

#### GC-AUD-043 — `targetSdkVersion` no está fijado: lo hereda del catálogo de React Native

- **Severidad:** BAJO · **Confianza:** alta · **Estado:** confirmado
- **Evidencia:** `android/app/build.gradle:93-94` lee `rootProject.ext.targetSdkVersion`, poblado desde `node_modules/react-native/gradle/libs.versions.toml` (hoy `compileSdk = 36`, `targetSdk = 36`, `minSdk = 24`). No hay ningún pin en el proyecto.
- **Impacto real:** una subida de `react-native` cambia en silencio el `targetSdk` de la app y, con él, **todo el régimen de aplicación de las reglas de foreground service** — que es justo donde vive el riesgo de GC-AUD-008 y GC-AUD-035.
- **Recomendación mínima:** fijar el valor explícitamente en `android/build.gradle`.
- **¿Añade complejidad?** Ninguna.

---

## 7bis. Correcciones aplicadas en la adjudicación

Errores de la primera fase, corregidos aquí y en la matriz de trazabilidad. Se listan en lugar de arreglarse en silencio.

| Corrección | Dónde estaba mal | Valor correcto |
|---|---|---|
| Recuento de severidades | Resumen verbal de cierre: «9 ALTO / 13 BAJO» | **10 ALTO / 12 BAJO** (§7). Total 43, CRÍTICO 4 y MEDIO 17 sin cambio |
| Riesgo de I3 (single-flight) | Matriz §1 apuntaba a `GC-AUD-006` (SSRF) | **GC-AUD-010** (bloqueo head-of-line) |
| Riesgo de I4 (retry/backoff) | Matriz §1 apuntaba a `GC-AUD-006` | **GC-AUD-010** |
| Riesgo de I8 (UI sin lógica) | Matriz §1 apuntaba a `GC-AUD-014` (alcance NAS) | **GC-AUD-021** (lógica en el componente de UI) |
| Deep link / callback OAuth | Matriz §2 apuntaba a `GC-AUD-011` (typecheck) | **GC-AUD-036** (OAuth: esquema reclamable, `state` sin validar) |
| Cifrado local | Matriz §3 cerraba con `GC-AUD-003` (vídeo >5 MB) | **GC-AUD-005** (cifrado declarado y ausente) |
| Pico de memoria del export | Convivían «≈3,3×» y «≈8×» sin reconciliar | **Rango ~3,3N–8N, ninguna cifra medida** (GC-AUD-015) |
| Veredicto condicional | «Si el vídeo se deshabilitara, sería APTO CON BLOQUEANTES» | Retirado: ocultar el vídeo es contención, no remediación (§2) |
| Clasificación del vídeo en vivo | «v1.1 / NO HACER AHORA» | **Causa raíz P0** (§0, GC-AUD-001) |
| Estado de I1 en la matriz | «PARCIAL» | **NO IMPLEMENTADA en vídeo** — en ese modo la invariante no existe |

---

## 8. Riesgos que afectan directamente a la supervivencia

Ordenados por cuánto reducen la probabilidad de que la evidencia sobreviva:

1. **Vídeo sin subida en vivo (GC-AUD-001).** Probabilidad de pérdida ante incidente durante la grabación: **100 %**.
2. **Vídeo interrumpido marcado como completado (GC-AUD-002).** Pérdida total *y* señal falsa de éxito. El usuario ni siquiera sabe que debe reintentar.
3. **Recovery cross-device que declara «Protegido» una sesión truncada (GC-AUD-033).** La evidencia sí sobrevivió, pero el usuario recibe un veredicto falso sobre ella en el momento de mayor gravedad.
4. **Vídeo > ~80 s (GC-AUD-003).** Pérdida total en un caso de uso obvio y esperable.
5. **Arranque del FGS rechazado e invisible (GC-AUD-034).** La protección en background muere para todo el proceso y los logs siguen diciendo que está sana. Es el peor perfil posible: fallo silencioso con telemetría que lo enmascara.
6. **Foreground service mal tipado (GC-AUD-008) y arrancado antes del permiso de micrófono (GC-AUD-035).** Si Android 14/15 lo mata o lo rechaza, la evidencia deja de salir en cuanto la pantalla se apaga. **Sin verificar — requiere dispositivo.**
7. **Bloqueo head-of-line del worker (GC-AUD-010).** Bajo mala red, la evidencia sale al ritmo del peor chunk.
8. **Borrado local por reconciliación con conteo (GC-AUD-009).** Puede eliminar la única copia local dejando un hueco remoto.
9. **Sin timeouts en Supabase (GC-AUD-012).** Un handler colgado detiene el registro de chunks.
10. **CursorWindow (GC-AUD-020) y OOM del export (GC-AUD-015).** La evidencia sobrevivió pero no se puede encolar o no se puede recuperar.

---

## 9. Seguridad y privacidad

### Lo que está genuinamente bien

- **Verificación de JWT real.** `jwtVerifier.ts:84-119`: firma verificada contra JWKS remoto (ES256/RS256) o HMAC (HS256), `alg` en lista blanca por rama —lo que bloquea `alg: none` y la confusión HS/RS—, `issuer` fijado a `${SUPABASE_URL}/auth/v1`, `exp`/`nbf` aplicados por `jose`. 401 opacos, sin filtrar la causa al cliente (`auth.ts:136`).
- **Sin IDOR.** Las 13 llamadas a `supabase.from(...)` están filtradas por `user_id` o precedidas de `getOwnedSession` en la misma petición. «No existe» y «no es tuya» se colapsan en 404 (`chunks.service.ts:10-14`) para impedir enumeración. `user_id` sale **siempre** del JWT, nunca del cuerpo.
- **El backend no retiene evidencia.** Cero `fs`, `multer`, `busboy`, `writeFile` o `/tmp` en todo `backend/src`. La única caché de módulo guarda tokens de Google, indexada por SHA-256 truncado del refresh token — nunca bytes.
- **Idempotencia real en dos capas.** `UNIQUE(session_id, chunk_index)` en BD (`migrations/0002:29`) + reconciliación de la violación 23505 en aplicación, con `uploaded` como estado terminal.
- **Credenciales WebDAV bien cifradas.** AES-256-GCM, IV aleatorio de 12 bytes por operación, payload versionado, `setAuthTag` para descifrado autenticado. Nunca se proyectan al cliente.
- **Logs sin secretos.** `logger.ts:19-32` redacta `authorization`, `cookie`, `password`, `token`, `access_token`, `refresh_token`, `service_role_key`, `jwt_secret`. El callback OAuth registra sólo `hasCode`/`hasState`. Los bytes de chunk no se registran nunca.
- **Ventana «Drive aceptó, respuesta perdida» resuelta.** El reintento acierta en el dedup de nombre determinista y **no re-sube bytes**; el `POST /chunks` posterior devuelve 200 de replay. Sin duplicados ni pérdida.

### Lo que no

Ya detallado: GC-AUD-006 (SSRF), GC-AUD-036 (OAuth sin PKCE ni validación de `state`), GC-AUD-037 (release firmada con debug.keystore), GC-AUD-038 (refresh token en claro + `allowBackup`), GC-AUD-017 (HTML reflejado), GC-AUD-039 (rutas de depuración en release), GC-AUD-040 (logs en release), GC-AUD-025 (`/debug-ping`, CORS abierto), GC-AUD-005 (cifrado local inexistente).

Adicionalmente:

- **`aud` y `role` no se comprueban** (`jwtVerifier.ts:103-115`). Con el `issuer` fijado el riesgo es limitado, pero conviene notar que **la propia app usa sign-in anónimo**, luego cualquiera puede obtener un token válido de ese proyecto y una cuenta funcional. Es coherente con el diseño del producto; conviene que sea una decisión consciente y no un descuido.
- **Permisos declarados y nunca usados, que viajan en release:** `SYSTEM_ALERT_WINDOW` (dibujar sobre otras apps — mala señal en una app de grabación y riesgo de revisión), `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (el propio código lo evita a propósito: `batteryOptimization.ts:32` usa `Linking.sendIntent`, que no lo necesita) y `READ_/WRITE_EXTERNAL_STORAGE` sin `maxSdkVersion`. Ninguno tiene código que los ejerza.
- **URLs completas de NAS en logs** (`webdav.adapter.ts:99,165,177,…`), mientras la capa de ruta sí tiene cuidado de registrar sólo el origen. Inconsistente.
- **Búsqueda de secretos:** sin secretos vivos en el árbol. Un hallazgo **INFO**: una clave anon de Supabase (pública por diseño) estuvo en `mobile/src/config/env.ts:28` en el commit `a930d02` y se eliminó en `68e312a`; sigue siendo recuperable del historial. Las claves anon viajan en el bundle de todos modos; sólo rotar si la postura de RLS dependió alguna vez de su secreto. **No se reproduce ningún valor en este informe.**

---

## 10. Contradicciones documentación ↔ código

Resumen; el detalle con 20 entradas está en el documento de trazabilidad, §4.

| Tema | Doc dice | Código hace |
|---|---|---|
| Cifrado local | «Obligatorio en MVP» (`SECURITY.md:51`) + 5 docs más | TODO, chunks en claro (`index.tsx:541`) |
| Chunking en vivo | «los chunks deben empezar a subirse mientras se graba» (`SYSTEM_INVARIANTS.md:15`) | Sólo audio (`index.tsx:5096`) |
| Librería de audio | «expo-av» (`ARCHITECTURE.md:31`, todo `KNOWN_LIMITS.md`, `CLAUDE.md:269`) | `expo-audio` (`audioEngine.ts:40`) |
| Chunk de vídeo | 128 KB (`IMPLEMENTATION_STATUS.md:200`) | 128 KB **y** 256 KB coexistiendo |
| Chunk de audio | 16 384 B (`API_SPEC.md:99`) | 32 KB (`index.tsx:310`) |
| Unidad de chunk | «2–5 s» (`START_HERE.md:52`) | bytes |
| NAS | «no entra en el MVP», «ningún código escrito» | 341 líneas de adaptador + 3 rutas + migración |
| Manifests | «futuro», «NO es necesario para el MVP» (`API_SPEC.md:82,110`) | Implementados y **fuente de verdad del recovery** (`ARCHITECTURE.md:198` se contradice con su propia línea 127) |
| `/auth/*`, `/alerts` | Especificados (`API_SPEC.md:9,12,65,68`) | No existen |
| Modo Kids | Especificado en 5 docs, presente en `START_HERE.md:100-112` | 0 coincidencias de `kids` en el código |
| Historial | «no entry point from the home screen yet» (`KNOWN_DEBT.md:10`) | `history.tsx` existe y está enlazado (`index.tsx:6351`) |
| ngrok | «temporal, no válido para producción» (`KNOWN_DEBT.md:5`) | Sustituido por Cloudflare Tunnel |
| Guard de `(authed)` | «bounce them back to the login route» | El layout no contiene ningún guard |
| Selector de modo | `UI_SCREENS.md:22-24` lo pide | `UI_SCREENS.md:231` y `ANTI_PATTERNS.md:45-47` lo prohíben |
| Jerarquía documental | `CLAUDE.md:62` vs `START_HERE.md:226` | Dos órdenes incompatibles |
| Baseline de rollback | `beta-preview-v0.3.1` vs `audio-engine-layer-stable` vs `stable-nas-routing` | Tres «actuales» |

---

## 11. Capacidades que necesitan prueba física

Ninguna de estas puede resolverse leyendo código. Requieren un dispositivo Android real con build release y Metro apagado.

| # | Capacidad | Por qué no basta el código | Prioridad |
|---|---|---|---|
| 1 | **Promesa de los 10 s en audio** | Depende de red real, backend real y Drive real | **P0** |
| 2 | **Foreground service en Android 14/15** (GC-AUD-008) | Política del SO + comportamiento OEM | **P0** |
| 3 | **Crash por `SecurityException` en la primera grabación** (GC-AUD-035) | Carrera entre el arranque del FGS y el diálogo de micrófono | **P0** |
| 4 | **Recovery tras reinicio del dispositivo** | `VALIDATION_MATRIX.md:10` lo marca «?» pese a `TEST_RESULTS.md:7` «PASS» | **P0** |
| 5 | Subida real a Drive end-to-end | Requiere OAuth y cuota reales | P0 |
| 6 | Kill durante grabación de vídeo (GC-AUD-002) | Confirma la sesión completada con 0 chunks | P0 |
| 7 | Recovery cross-device de sesión truncada (GC-AUD-033) | Confirma la etiqueta «Protegido» sobre evidencia incompleta | P0 |
| 8 | Background prolongado y Doze; rechazo silencioso del FGS (GC-AUD-034) | Comportamiento del SO | P1 |
| 9 | Red intermitente / muy lenta real | Los tests no ejercitan `uploadDrainLoop` | P1 |
| 10 | Interceptación del deep link OAuth (GC-AUD-036) | Requiere una segunda app que registre el esquema | P1 |
| 11 | Almacenamiento lleno, batería baja | Condiciones del SO | P1 |
| 12 | Reproducibilidad del `.aac`/`.mp4` exportado | Hay que abrir el fichero en un reproductor | P1 |
| 13 | OOM del export en gama baja (GC-AUD-015) | Depende del dispositivo | P2 |
| 14 | CursorWindow en sesiones muy largas (GC-AUD-020) | Depende del volumen real | P2 |

---

## 12. Fortalezas comprobadas

Sólo lo que puedo respaldar con evidencia. Esto no es cortesía: es un sistema con partes hechas con criterio, y confundirlas con las rotas sería tan poco útil como suavizar los defectos.

| Fortaleza | Evidencia |
|---|---|
| Cola persistente correcta y bien probada | `index.tsx:722-1053`; 21 tests **ejecutados y verdes** |
| Puerta de finalización que exige **conjunto completo** de índices `uploaded` con `remote_reference` | `index.tsx:2301-2310`; 19 tests verdes. Impide sesiones «completas» con huecos |
| Reset de chunks atascados en `uploading` al arrancar | `index.tsx:4527-4556`; probado. Cierra el modo de fallo clásico post-kill |
| Reconciliación con backend deliberadamente estricta, con reap sólo tras confirmación | `index.tsx:1385-1506`. El diseño es correcto (ver GC-AUD-009 para el matiz de conteo) |
| Normalización de duplicados y detección de divergencia de hash | `index.tsx:1129-1275`; 14 tests verdes |
| Escáner de huérfanos nacido de un incidente real de pérdida (2026-05-15) y de sólo lectura | `orphanScan.ts` |
| Export que reconstruye **el prefijo contiguo válido más largo** y se detiene en el primer hueco en vez de fabricar un fichero disperso | `export.ts:684-790`; 32 tests verdes |
| Verificación SHA-256 en tres puntos del recorrido (emisión, proxy del backend, export) | `index.tsx:2827`, `destinations.routes.ts:622-636`, `export.ts:756` |
| Auth del backend con verificación criptográfica real, issuer fijado y 401 opacos | `jwtVerifier.ts:84-119` |
| Ausencia de IDOR en las 13 rutas de acceso a datos | `chunks.service.ts:103-109`, `sessions.service.ts:198-203`, etc. |
| Idempotencia en dos capas, con dedup por nombre de fichero determinista en Drive | `migrations/0002:29`, `chunks.service.ts:331-342`, `destinations.routes.ts:729-749` |
| Backend que **no** persiste bytes de evidencia | verificado por búsqueda exhaustiva en `backend/src` |
| Credenciales WebDAV con AES-256-GCM y descifrado autenticado | `webdavCredentials.ts`; 5 tests |
| Copy de error genuinamente humano, sin jerga técnica | `humanError.ts:46-89` (ver GC-AUD-019 para el hueco de Drive) |
| Activación sin decisiones previas: sign-in anónimo, sin login | `index.tsx:4166` |
| Elección de AAC ADTS sobre MP4 **precisamente** para que un prefijo truncado siga siendo reproducible | `index.tsx:321-341`. Es la decisión correcta para supervivencia y está bien razonada |
| Arranque paralelizado: servicio, sesión y grabadora no se bloquean entre sí | `index.tsx:4823-4927` |
| Local-first: UUID generado en cliente, la grabación no espera al backend | `index.tsx:4805` |

---

## 13. Los 10 riesgos principales

| # | Riesgo | ID | Sev. | Estado |
|---|---|---|---|---|
| 1 | El vídeo no sube nada durante la grabación: promesa central falsa | GC-AUD-001 | CRÍTICO | confirmado |
| 2 | Vídeo interrumpido: pérdida total + sesión marcada completa con 0 chunks | GC-AUD-002 | CRÍTICO | confirmado |
| 3 | Recovery cross-device declara «Protegido» una sesión truncada | GC-AUD-033 | CRÍTICO | confirmado |
| 4 | Vídeo > ~80 s: cero chunks al parar | GC-AUD-003 | CRÍTICO | confirmado |
| 5 | Arranque del FGS rechazado, invisible a JS; la telemetría no puede detectarlo | GC-AUD-034 | ALTO | confirmado |
| 6 | La UI dice «Protegiendo evidencia» sin evidencia protegida | GC-AUD-004 | ALTO | confirmado |
| 7 | FGS `microphone` antes del permiso de micrófono ⇒ crash; y tipo erróneo para subida | GC-AUD-035 + 008 | ALTO | **requiere prueba física** |
| 8 | OAuth sin PKCE y `state` sin validar ⇒ vinculación del Drive ajeno | GC-AUD-036 | ALTO | probable |
| 9 | Suite de backend roja, incl. el test de rechazo de JWT | GC-AUD-007 | ALTO | confirmado |
| 10 | SSRF autenticado en la superficie NAS | GC-AUD-006 | ALTO | probable |

*Justo por debajo, y no por poco margen:* GC-AUD-005 (cifrado ausente), GC-AUD-037 (release firmada con debug.keystore), GC-AUD-009 (reconciliación por conteo) y GC-AUD-018 (cero registros de validación).

---

## 14. Condiciones mínimas para considerar v0.3 liberable

Deliberadamente cortas. Todo lo que no bloquea la supervivencia, la claridad o la confianza queda fuera.

### Bloqueantes absolutos

1. **GC-AUD-001 — captura segmentada de vídeo en vivo, funcionando.** Es la condición que define la release. v0.3 incluye vídeo y el vídeo debe sacar evidencia durante la grabación. **Ocultar el modo no cumple esta condición; un aviso tampoco.** Debe superar las pruebas de aceptación del spike (fase C del plan) sobre dispositivo real.
2. **GC-AUD-002 + estado de terminación.** No completar sesiones de cero chunks, y persistir `capture_end_reason` distinguiendo cierre limpio de interrupción — **con `process_terminated` / `interrupted_unknown` cuando la causa no pueda demostrarse**, y `interrupted_limit` / `interrupted_error` sólo con señal explícita. `scanOrphans` sobre `cacheDirectory` cuenta como mitigación, **no** satisface esta condición por sí solo.
3. **GC-AUD-033:** ninguna sesión interrumpida puede mostrarse como «Protegido correctamente» porque todos los chunks conocidos estén subidos. Sin usar `completed_at` como prueba de captura completa.
4. **GC-AUD-004 + separación de los dos hechos (§3ter):** que la UI no afirme protección que no existe, en ninguno de los dos modos. Mientras no haya confirmación remota debe decir **«Todavía no protegido fuera del dispositivo»**, y debe exponer por separado la **completitud de la grabación** y los **fragmentos protegidos fuera del dispositivo** — sin colapsarlos en una sola etiqueta, y sin degradar a «fallo» una captura interrumpida que sí tiene fragmentos remotos utilizables.
5. **Foreground service — los cinco cambios.** FGS-1 (permisos concedidos antes de arrancar el servicio), FGS-2 (tipos por escenario: `microphone` para audio, `camera`+`microphone` para vídeo con audio, `dataSync` o mecanismo permitido para subida), FGS-3 (observabilidad real del arranque) y FGS-4 (recovery tras reinicio por un mecanismo permitido, **sin** arrancar `camera`/`microphone`/`dataSync` desde `BOOT_COMPLETED` en Android 15) aplicados; FGS-5 validado en dispositivo. **Sin asumir un único servicio con todos los tipos.**
6. **GC-AUD-036:** canje de OAuth completado en el callback HTTPS del backend con transacción `state` verificada, y el `authorization code` fuera de `guardiancloud://`.
7. **GC-AUD-007 + paridad de runtime:** suite de backend en verde **bajo la versión exacta de Node que ejecuta producción**, con el test de rechazo de JWT pasando de verdad, y el verde de mobile reconfirmado en esa misma versión.
8. **GC-AUD-011:** `tsc --noEmit` limpio en mobile bajo el runtime de referencia (lo exige su propio checklist).
9. **GC-AUD-037:** o hay `signingConfigs.release` real, o el checklist deja de ofrecer la ruta gradle local.
10. **NAS fuera de la ruta de release** (flag) o con GC-AUD-006 corregido. No puede seguir siendo un BLOCKER de release algo que `MVP_SCOPE.md` excluye.

### Validación física obligatoria — sin esto no hay release

11. Escenarios 1-7 de §11, ejecutados **en build release con Metro apagado**, y sus resultados **escritos** en `SURVIVAL_TEST_RESULTS.md` con fecha, dispositivo, versión de Android y commit. Hoy ese fichero dice «Sin sesiones registradas todavía».
12. `RELEASE_CHECKLIST_v0.3.md` §4.10 (3 usuarios reales sin contexto). Es **obligatorio por el propio checklist**, que remata con «> NO lanzar release». Sigue sin marcar, como los otros 71 ítems.

### Honestidad documental — barato y no negociable

13. Corregir las afirmaciones de validación no respaldadas en `IMPLEMENTATION_STATUS.md`, `START_HERE.md` y `docs/README.md`, o aportar los registros que las respalden.
14. Corregir la contradicción del cifrado (GC-AUD-005): o se implementa, o los seis documentos dicen la verdad y entra en `KNOWN_DEBT.md`.

### Explícitamente NO bloqueante

Export en streaming, refactor de `index.tsx`, migración fuera de `expo-file-system/legacy`, limpieza de ficheros basura, migración a `SecureStore`, cifrado local. Son deuda real y están en el plan de remediación con su prioridad — pero convertirlos en bloqueantes del MVP sería exactamente el error que `PRODUCT_PRINCIPLES.md §5` («no sobreingeniería») advierte.

> **Retirado de esta lista en la adjudicación:** la *captura segmentada de vídeo en vivo*, que una versión anterior de este informe clasificaba como no bloqueante y diferible a `v1.1`. Es **causa raíz P0** y bloquea v0.3 (decisiones 1, 2, 5). El resto de la lista se mantiene.

---

## 15. Nota de cierre

La distancia entre lo que este proyecto hace y lo que dice que hace es el hallazgo estructural de esta auditoría. El código de audio es mejor que su documentación: cuidadoso, comentado con razones y no con descripciones, y con decisiones difíciles bien tomadas (AAC ADTS para supervivencia del prefijo, disco antes que cola, puerta de finalización estricta). El código de vídeo es peor que su documentación: no cumple la invariante nº 1 y nadie lo ha escrito junto a esa invariante.

`DEBUGGING_RULES.md:189-205` ya contiene el estándar correcto: *«La validación real es: kill app / mala red / background / reopen / recovery / uploads reales / Drive real.»* El proyecto sabe cómo debe validarse. Lo que falta es haberlo hecho y haberlo anotado.

---

*Auditoría de sólo lectura. No se ha modificado, borrado ni descartado ningún fichero existente. No se ha hecho commit ni push.*
