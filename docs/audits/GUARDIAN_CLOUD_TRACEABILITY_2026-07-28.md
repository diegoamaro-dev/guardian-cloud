# Guardian Cloud — Matriz de trazabilidad documentación ↔ implementación

**Fecha:** 2026-07-28
**Commit HEAD:** `dea0ed0` (rama `main`)
**Método:** lectura de código, ejecución de suites de test, inspección de manifests y configuración. Sin dispositivo físico, sin credenciales de producción, sin acceso a Drive/Supabase reales.

> **Adjudicado 2026-07-28.** Decisiones vinculantes de producto aplicadas a esta matriz:
> **v0.3 incluye audio Y vídeo**, y **ambos deben sacar evidencia del dispositivo DURANTE la grabación**. Por tanto la invariante I1 se evalúa contra los dos modos sin excepción, y el vídeo post-stop no es una implementación parcialmente conforme: es **incumplimiento**. Ocultar el modo vídeo es contención temporal y **no** convierte v0.3 en liberable.
> Los resultados de test y typecheck de §6 se obtuvieron bajo **Node 24**, versión que **satisface** el `node >=20` declarado en `backend/package.json:8`: son **evidencia de auditoría válida**. Deben repetirse bajo la **versión exacta del runtime de producción** para establecer paridad y baseline de remediación.

---

## 0. Cómo leer esta matriz

### Estados

| Estado | Significado |
|---|---|
| **VERIFICADA** | Existe código ejecutable Y evidencia reproducida en esta auditoría (test verde ejecutado por mí, o lectura de código determinista sin ambigüedad). |
| **PARCIAL** | Implementado para una parte del dominio (p.ej. sólo audio, sólo un modo, sólo camino feliz). |
| **NO IMPLEMENTADA** | La documentación la declara y el código no la contiene. |
| **NO DEMOSTRADA** | Hay código plausible, pero su corrección depende de comportamiento de dispositivo/red/OS que no puedo ejercitar aquí. |
| **CONTRADICTORIA** | Dos o más documentos afirman cosas incompatibles, o un documento contradice al código. |

### Niveles de evidencia (usados en la columna «Prueba»)

1. **`código`** — el código existe y lo he leído.
2. **`test`** — cubierto por un test automático que **he ejecutado** en esta auditoría.
3. **`manual-doc`** — existe una prueba manual *documentada* en el repo (con fecha/evidencia).
4. **`reproducido`** — validado por mí durante esta auditoría.

> Nota importante: **ningún ítem de esta matriz alcanza el nivel 4 para comportamiento de dispositivo.** No hay dispositivo Android en este entorno. El nivel 4 aquí sólo aplica a comprobaciones estáticas y suites de test.

---

## 1. Invariantes del sistema

Fuente: `docs/SYSTEM_INVARIANTS.md`, `docs/BETA_STABLE_BASELINE.md:81-113`, `CLAUDE.md §6`.

| # | Invariante | Documentación | Implementación | Prueba | Evidencia | Estado | Riesgo |
|---|---|---|---|---|---|---|---|
| **I1** | Subida durante grabación — **exigible a audio y vídeo** | `SYSTEM_INVARIANTS.md:15-16`; `START_HERE.md:26-27`; `ARCHITECTURE.md:241` | **AUDIO:** `startChunkerForSession` → `runAudioChunkerTick` cada 1.5 s (`mobile/app/index.tsx:5096-5098`, `:2689-2722`) ⇒ **conforme**. **VÍDEO:** ninguna. `mobile/app/index.tsx:5096` sólo arranca el chunker `if (recordingMode === 'audio')`; `videoFileProducer.ts:77-79` «THIS PRODUCER DOES NOT TOUCH THAT FILE DURING RECORDING» ⇒ **incumplimiento** | código | `index.tsx:5092-5098`, `videoFileProducer.ts:77-79`, `index.tsx:5347-5349` | **NO IMPLEMENTADA en vídeo** (no «parcial»: en el modo vídeo la invariante no existe) | **CRÍTICO** — GC-AUD-001 |
| **I2** | Cola persistente = fuente de verdad | `ARCHITECTURE.md:26-29`; `BETA_STABLE_BASELINE.md:88-91` | `queueMutate` sobre AsyncStorage, clave única `test.pending_retry`, serializada con `writeChain` (`index.tsx:722-819`) | test (`tests/queue.test.ts`, 21 tests verdes) | ejecutado 2026-07-28: 138/138 mobile verdes | **VERIFICADA** | Bajo |
| **I3** | Worker single-flight | `PLAN.md:70`; `STATE_v0.2…:50-56` | Guard `isDraining` a nivel de módulo (`index.tsx:1932-1950`, `:2247-2249`) | código | `index.tsx:1934-1937` | **VERIFICADA** (dentro de un único contexto JS) | Medio — bloqueo head-of-line, GC-AUD-010 |
| **I4** | Reintentos seguros con backoff | `STATE_v0.2…:50-56` | `classifyError` transient/permanent; backoff `min(2^n·1000, 30 000)` (`index.tsx:2216-2242`) | test (`tests/classifyError.test.ts`, 17 verdes) | ejecutado | **VERIFICADA** | Medio (GC-AUD-010) |
| **I5a** | **Normalización de cola al arrancar la app** | `STATE_v0.2…:74-85` | Secuencia ejecutada al montar Home: `migrateLegacyPendingState` → `normalizeQueueOnRecovery` → reset `uploading`→`pending` → `recording_closed=true` → `reapAlreadyDoneEntries` → `reconcileStaleSessionsWithBackend` → `scanOrphans` → `uploadDrainLoop` (`index.tsx:4492-4700`) | test (`queue.test.ts` «stuck uploading reset», `normalize.test.ts`, `finalize.test.ts`) | ejecutado 2026-07-28 | **VERIFICADA como lógica** — los tests prueban rehidratación y transiciones de estado, **no** comportamiento del sistema operativo | Bajo |
| **I5b** | **Recovery tras kill de la app** | `IMPLEMENTATION_STATUS.md:15`; `TEST_RESULTS.md:6` «PASS» | Misma secuencia de I5a, disparada la próxima vez que **el usuario abre la app** | test unitario **de la lógica**, no del escenario | — | **NO DEMOSTRADA** — requiere matar el proceso en un dispositivo y reabrir. Para **vídeo**, además, la lógica es incorrecta (GC-AUD-002) | **CRÍTICO** para vídeo — GC-AUD-002 |
| **I5c** | **Recovery automático tras reinicio del dispositivo** | `IMPLEMENTATION_STATUS.md:16` «Recovery after device reboot»; `TEST_RESULTS.md:7` «Reboot mid-upload: PASS» | **No existe ningún receptor de `BOOT_COMPLETED` ni scheduler de trabajo diferido** (verificado sobre las 40 líneas de `AndroidManifest.xml`). Tras un reinicio, la cola **no se drena hasta que el usuario abre la app** | **ninguna** | manifest inspeccionado | **NO IMPLEMENTADA** — no «verificada». Lo que existe es I5a, que exige apertura manual; eso no es *automático* | **ALTO** — GC-AUD-008 (F-4) |

> **Por qué se separan.** La fila única anterior las daba por «VERIFICADA para audio», y eso mezclaba tres cosas distintas: una lógica probada con tests unitarios (I5a), un escenario físico nunca reproducido (I5b) y una capacidad que **no está implementada** (I5c). Los tests unitarios prueban que la rehidratación de la cola es correcta; **no prueban que el sistema operativo devuelva el control a la app**, que es lo que «recovery automático tras reinicio» afirma.
>
> **Nota terminológica:** en el código, los logs `GC_BOOT_*` se refieren al **arranque de la app**, no al arranque del dispositivo. En esta matriz se dice «arranque de la app» cuando es eso, para que la ambigüedad no vuelva a producir la lectura de `TEST_RESULTS.md:7` como si el reinicio del dispositivo estuviera cubierto.
| **I6** | Evidencia fuera del dispositivo lo antes posible | `START_HERE.md:76`; `MVP_SCOPE.md:33` | Audio: 1er chunk a ~4.5 s (32 KB @ 64 kbps = 4 s + tick). Vídeo: sólo tras STOP | código | `audioEngine.ts:80-90` (64 kbps), `index.tsx:310` (32 KB), `:669` (tick 1.5 s) | **PARCIAL** | **CRÍTICO** — GC-AUD-001 |
| **I7** | Export usable | `MVP_SCOPE.md:39`; `IMPLEMENTATION_STATUS.md:19` | `export.ts` — prefijo contiguo válido desde índice 0, verificación SHA-256, corte en el primer hueco (`export.ts:684-790`) | test (`exportFromChunkRefs.test.ts` 17 + `exportRunner.test.ts` 15 verdes) | ejecutado | **VERIFICADA** (lógica) / **NO DEMOSTRADA** (reproducibilidad del fichero) | Medio |
| **I8** | La UI no contiene lógica de negocio | `ANTI_PATTERNS.md:18-24`; `CLAUDE.md §4` | `mobile/app/index.tsx` = **7 376 líneas** conteniendo cola, worker, chunkers, recovery, reconciliación y UI en el mismo fichero/componente | código | `wc -l mobile/app/index.tsx` → 7376 | **CONTRADICTORIA** | Medio — GC-AUD-021 |
| **I9** | El usuario no decide antes de grabar | `SYSTEM_INVARIANTS.md:50`; `UI_SCREENS.md:231`; `ANTI_PATTERNS.md:45-47` | Login anónimo automático (`index.tsx:4166`), sin pantalla de login. **Pero** hay selector audio/vídeo previo (`ModeToggle`, `index.tsx:7322`) y los dos modos NO son equivalentes en supervivencia | código | `index.tsx:4166`, `:7322-7340`, `:3556` | **PARCIAL / CONTRADICTORIA** (`UI_SCREENS.md:22-24` pide el selector; `:231` lo prohíbe) | **ALTO** — GC-AUD-004 |
| **I10** | El backend no es almacén permanente del vídeo final | `START_HERE.md:44`; `PRODUCT_PRINCIPLES.md:83` | Proxy de bytes hacia Drive; sin persistencia de payload | código | `backend/src/services/drive.service.ts` | **VERIFICADA** (ver §5) | Bajo |

---

## 2. Capacidades declaradas en `IMPLEMENTATION_STATUS.md`

| Capacidad declarada | Línea | Implementación | Prueba | Estado | Nota |
|---|---|---|---|---|---|
| Google Drive OAuth connection | `:7` | `backend/src/routes/destinations.routes.ts`; `mobile/app/oauth/drive.tsx` | código | **NO DEMOSTRADA** | Requiere credenciales reales |
| Backend callback to mobile deep link | `:8` | esquema `guardiancloud://` (`AndroidManifest.xml:36`) | código | **NO DEMOSTRADA** | Ver GC-AUD-036 (esquema custom interceptable; `state` sin validar) |
| Session creation | `:9` | `createSessionRequest` (`index.tsx:3378`); `POST /sessions` | test (backend `sessions.test.ts` — **2 fallos**) | **PARCIAL** | Tests rojos, ver §6 |
| Audio recording | `:10` | `audioEngine.ts` (expo-audio, AAC ADTS, 64 kbps mono) | código | **VERIFICADA** (config) / **NO DEMOSTRADA** (captura) | — |
| Chunk generation | `:11` | `emitChunk` / `emitVideoChunk` / `videoChunkSink` | test (`queue.test.ts`) | **VERIFICADA** | — |
| Real chunk upload to Google Drive | `:12` | `uploadChunkBytes` → backend → Drive | código | **NO DEMOSTRADA** | Requiere Drive real |
| Chunk metadata registration | `:13` | `postChunk` → `POST /chunks` | test (backend `chunks.test.ts` — **1 fallo**) | **PARCIAL** | ver §6 |
| Persistent pending recovery state | `:14` | `test.pending_retry` | test | **VERIFICADA** | — |
| Recovery after app kill | `:15` | reset `uploading`→`pending` **al arrancar la app** (`index.tsx:4527-4556`) | test **de la rehidratación de la cola**, no del escenario físico | **NO DEMOSTRADA** (ver I5b) | Requiere matar el proceso en dispositivo y reabrir. Vídeo, además: GC-AUD-002 |
| Recovery after device reboot | `:16` | **mismo camino que el anterior — exige que el usuario abra la app.** No hay receptor ni scheduler | — | **NO IMPLEMENTADA** (ver I5c) | `VALIDATION_MATRIX.md:10` lo marca «?» pese a `TEST_RESULTS.md:7` «PASS» |
| Session completion | `:17` | `tryFinalizeReadySessions` (`index.tsx:2279`) | test (`finalize.test.ts`, 19 verdes) | **VERIFICADA** | Pero completa sesiones de 0 chunks: GC-AUD-002 |
| Local cleanup after success | `:18` | `reapEntry` (`index.tsx:2469-2488`) | test | **VERIFICADA** | — |
| Evidence export (sha256 + concat + parcial) | `:19` | `export.ts` | test (32 verdes) | **VERIFICADA** (lógica) | — |
| «Validated under app kill / network loss / background / restart» | `:29-34` | — | **ninguna** | **NO DEMOSTRADA** | `VALIDATION_MATRIX.md:8-10` marca esos tres escenarios como «?» |
| «Guardian Cloud fulfills its core promise» | `:38` | — | **ninguna** | **CONTRADICTORIA** | Falsa para vídeo: GC-AUD-001 |
| `VIDEO_FILE_CHUNK_SIZE` = 128 KB | `:200` | `videoFileProducer.ts:40` = 128 KB **pero** `index.tsx:311` `CHUNK_SIZE_VIDEO = 256 KB` | código | **CONTRADICTORIA** | Dos constantes de tamaño de chunk de vídeo distintas y coexistentes |
| Incremental manifests «validated on real device» | `:122` | `backend/src/services/manifest.service.ts` | test unitario (19 verdes) | **PARCIAL** | Sin registro de la prueba de dispositivo |
| Cross-device recovery «VALIDADO EN CONDICIONES REALES» | `:110` | `backend/src/services/recovery.service.ts`; `mobile/src/api/recovery.ts` | test unitario (42 verdes) | **PARCIAL** | Sin registro de la prueba de dispositivo |

---

## 3. Cifrado local — el hueco más grande entre documentación y sistema

| Documento | Línea | Afirmación |
|---|---|---|
| `MVP_SCOPE.md` | `:8` | «cifrado local básico» — **dentro** del MVP |
| `START_HERE.md` | `:53` | «Cifra localmente» |
| `ARCHITECTURE.md` | `:16` | «- cifrar» (responsabilidad de la app) |
| `ARCHITECTURE.md` | `:89` | «4. se cifran localmente» (flujo de datos) |
| `docs/README.md` | `:3` | «chunking, cifrado local y subida» |
| `SECURITY.md` | `:49-51` | «### Obligatorio en MVP / - cifrado local antes de subida» |

**Implementación real:** ninguna.

```
mobile/app/index.tsx:541-542
  // TODO(chunk-encryption): cipher each base64Slice client-side (Argon2 KDF +
  //   AES-GCM, key sealed in keystore). Out of scope for this brick — chunks
  //   are uploaded in clear today, same as before.
```

Búsqueda en `mobile/src` + `mobile/app` de `encrypt|AES|cipher|SecureStore|Argon2|keystore`: **una única coincidencia**, la del TODO anterior. La única criptografía en cliente es SHA-256 para integridad (`export.ts:528`, `index.tsx:2827`).

**Estado: NO IMPLEMENTADA.** Seis documentos —incluido el que la declara *obligatoria*— afirman una capacidad ausente. No figura en `KNOWN_DEBT.md`, que es el fichero cuya función es registrar exactamente esto.

**Matiz que hay que registrar, no ocultar:** `ANTI_PATTERNS.md:68-69` prohíbe «cifrado complejo que ralentiza» y «validaciones que bloquean subida». Es defendible como decisión de producto (supervivencia > confidencialidad). Lo que no es defendible es que seis documentos la den por hecha. → GC-AUD-005.

---

## 4. Contradicciones documentación ↔ documentación

Verificadas por lectura directa de ambos extremos.

| ID | Tema | Doc A | Doc B | Naturaleza |
|---|---|---|---|---|
| D1 | Librería de audio | `ARCHITECTURE.md:31` «expo-av»; `KNOWN_LIMITS.md` completo; `CLAUDE.md:269`; `KNOWN_DEBT.md:7` «should later migrate to expo-audio» | `audioEngine.ts:40-47` importa **`expo-audio`**; `docs/future/NATIVE_AUDIO_SPIKE.md:8` | La migración que `KNOWN_LIMITS.md:171` propone como futura **ya se hizo**. `KNOWN_LIMITS.md` —documento de contexto obligatorio según `CLAUDE.md`— describe una limitación de una librería que ya no está en el camino de grabación |
| D2 | Tamaño de chunk de vídeo | `IMPLEMENTATION_STATUS.md:200` «128 KB» | `index.tsx:311` `256 * 1024` y `videoFileProducer.ts:40` `128 * 1024` | Doc obsoleto **y** dos constantes distintas conviviendo en el código |
| D3 | Tamaño de chunk de audio | `IMPLEMENTATION_STATUS.md:88-91` «32 KB» | `API_SPEC.md:99` `"size": 16384` | API_SPEC dos generaciones obsoleto |
| D4 | Unidad de chunk | `START_HERE.md:52` «chunks (2–5s)» | `IMPLEMENTATION_STATUS.md:86-91` (bytes) | Unidad distinta; nadie reconcilia |
| D5 | Vídeo: ¿durante o después? | `SYSTEM_INVARIANTS.md:15-16`; `START_HERE.md:26-27`; `README.md:33` | `STATE_v0.2…:36` «vídeo → chunking post-stop»; `PLAN.md:184-186` «v1.1 — Vídeo live» | El invariante se escribe sin excepción; la excepción existe y es la que rompe la promesa |
| D6 | Cifrado local | 6 docs (§3) | `index.tsx:541` TODO | Ver §3 |
| D7 | NAS en v0.3 | `MVP_SCOPE.md:22` «NAS» excluido; `ARCHITECTURE.md:80-81`; `NAS_WEBDAV_DESIGN.md:3` «Ningún código escrito todavía» | `backend/src/adapters/webdav.adapter.ts` existe; `VALIDATIONS/NAS_UPLOAD.md` validación fechada; `RECOVERY_BETA_VALIDATION.md:484-489` R14 es **BLOCKER de release y exige NAS conectado** | Implementado y bloqueando release mientras cinco docs lo declaran fuera de alcance |
| D8 | Manifests | `API_SPEC.md:82` «(futuro)», `:110` «NO es necesario para el MVP»; `ARCHITECTURE.md:127` «(futuro)» | `ARCHITECTURE.md:198` «Recovery source of truth: Drive manifests»; `manifest.service.ts` | `ARCHITECTURE.md` **se contradice a sí mismo** entre las líneas 127 y 198 |
| D9 | Jerarquía documental | `CLAUDE.md:62-68` «1. /docs 2. /playbook 3. /strategy» | `START_HERE.md:226-234` «1. PRODUCT_PRINCIPLES 2. MVP_SCOPE 3. ARCHITECTURE/API_SPEC…» | Dos órdenes de resolución de conflictos incompatibles. **Afecta a esta auditoría**: he aplicado la de `CLAUDE.md` por ser instrucción de proyecto |
| D10 | Ubicación del playbook | `CLAUDE.md:41-44` sitúa 3 ficheros en `/playbook` | Están en `docs/`. `/playbook` contiene otros 8 | El mapa de directorios del fichero rector es incorrecto |
| D11 | Reinicio de dispositivo validado | `IMPLEMENTATION_STATUS.md:17`; `TEST_RESULTS.md:7` «PASS» | `VALIDATION_MATRIX.md:10` «?»; `SURVIVAL_TEST_MATRIX.md` no lo incluye | PASS afirmado donde la propia matriz lo marca sin evaluar |
| D12 | Pérdida de red / cierre forzado validados | `TEST_RESULTS.md:6`, `PLAN.md:83-85` | `VALIDATION_MATRIX.md:8-9` «?» | Igual que D11 |
| D13 | Extensión del export | `IMPLEMENTATION_STATUS.md:19` `.m4a`; `README.md:38` `.m4a` | `IMPLEMENTATION_STATUS.md:174` `.aac`; `SURVIVAL_TEST_MATRIX.md:523` `.aac`; `TEST_SCENARIOS.md:80` `.bin` | Cuatro extensiones para la misma ruta; criterios PASS dependen de cuál se elija |
| D14 | Pantalla de Historial | `KNOWN_DEBT.md:10` «no entry point from the home screen yet» | `mobile/app/history.tsx` existe (382 líneas) y `index.tsx:6351` enlaza a `/history` | KNOWN_DEBT obsoleto |
| D15 | Baseline estable | `BETA_STABLE_BASELINE.md:19-23` / `CLAUDE.md:291` → `beta-preview-v0.3.1` (`a9e6e23`) | `AUDIO_ENGINE_STATUS.md:1-2` → `audio-engine-layer-stable`; `table-nas-routing` → `stable-nas-routing` | Tres «baselines actuales». El objetivo de rollback obligatorio en `CLAUDE.md` es el más antiguo de los tres |
| D16 | `/auth/*` y `/alerts` | `API_SPEC.md:9-13`, `:65-69`; `SECURITY.md:86-88` | No existen rutas de auth ni alerts en `backend/src/routes/` | La spec de API y la de seguridad gobiernan un subsistema inexistente |
| D17 | Selector de modo en Home | `UI_SCREENS.md:22-24` lo especifica | `UI_SCREENS.md:231` «el usuario no debe tomar decisiones antes de grabar»; `ANTI_PATTERNS.md:45-47` | El mismo documento pide y prohíbe la misma cosa |
| D18 | ngrok | `KNOWN_DEBT.md:5` «ngrok is temporary» | `CLOUDFLARE_TUNNEL_SETUP.md:5-7` «Sustituye a ngrok» | Deuda ya resuelta sigue abierta |
| D19 | `MVP_SCOPE.md` duplicado | `:35-45` | `:46-56` | Bloque «## Aclaración» pegado dos veces en el mismo fichero |
| D20 | `playbook/UX_STRESS_RULES.md` | 1 082 bytes en `docs/` | **0 bytes** en `playbook/` | Verificado con `wc -c`. Quien siga la convención del playbook abre un fichero vacío |

---

## 5. Backend ↔ `API_SPEC.md`

| Endpoint en spec | Línea | ¿Existe? | Observación |
|---|---|---|---|
| `POST /auth/login` | `:9` | **NO** | Sin rutas de auth. La app usa Supabase directamente (`signInAnonymously`) |
| `POST /auth/logout` | `:12` | **NO** | Ídem |
| `POST /sessions` | `:17` | Sí | `sessions.routes.ts`. `user_id` se toma del JWT, **no** del body — más seguro que la spec |
| `GET /sessions/:id` | `:30` | Sí | — |
| `POST /sessions/:id/complete` | `:33` | Sí | — |
| `POST /chunks` | `:38` | Sí | Devuelve **201**; el test espera 200 → fallo. Ver §6 |
| `GET /sessions/:id/chunks` | `:49` | Sí | — |
| `GET /destinations` | `:54` | Sí | — |
| `POST /destinations/drive/connect` | `:57` | Sí | — |
| `POST /destinations` | `:60` | — | Verificar contra `destinations.routes.ts` |
| `POST /alerts` | `:65` | **NO** | Modo Kids no implementado (0 coincidencias de `kids` en el código) |
| `GET /alerts` | `:68` | **NO** | Ídem |
| `GET /health` | `:73` | Sí | test verde (2/2) |
| `GET /sessions/:id/manifest` | `:84` | «futuro» en spec | `manifest.service.ts` existe |
| `GET /recovery/manifests` | `:146` | Sí | `recovery.routes.ts` |
| **No documentados pero en uso** | — | — | `POST /destinations/drive/chunks`, `POST /destinations/nas/chunks`, `GET /sessions/:id/chunks/:index/download` |

**Autorización.** `getOwnedSession` filtra por `.eq('user_id', userId)` y colapsa «no existe» y «no es tuya» en un único 404 para impedir enumeración (`chunks.service.ts:10-14`, `:103-109`). El JWT se verifica de verdad —firma contra JWKS o HS256, `issuer` fijado, `exp` aplicado por `jose`, 401 opaco, sin logging del token— (`jwtVerifier.ts:84-119`, `auth.ts:90-139`). **VERIFICADA.** No se comprueba `aud`; con `issuer` fijado el riesgo es bajo.

**Idempotencia.** Doble capa documentada y presente: `UNIQUE(session_id, chunk_index)` en BD + reconciliación en aplicación ante violación 23505; mismo hash → replay 200, hash distinto → rechazo (`chunks.service.ts:22-36`). Transición `uploaded` es terminal. **VERIFICADA** por lectura; el test que la cubre está **rojo** por drift 200/201.

---

## 6. Pruebas — resultado real de esta auditoría

Comandos ejecutados el 2026-07-28. Node no está en el `PATH`; se usó un binario `node` v24.11.1 ya presente en el sistema, sin instalar nada.

> **Sobre la versión de Node.** Las suites se ejecutaron bajo **Node v24.11.1**, que **satisface** el `node >=20` de `backend/package.json:8`. Son resultados válidos como evidencia de auditoría. Para usarlos como **baseline de remediación** hay que repetirlos bajo la **versión exacta del runtime de producción** y comprobar la paridad (fase B del plan).
> **Los 4 fallos de backend no se atribuyen a la versión de Node:** tres son diferencias de aserción de contrato (`200`/`201`, campo `status` extra) y el cuarto es un mock incompleto. Ninguno guarda relación con el motor.

| Comando | Resultado |
|---|---|
| `mobile: tsc --noEmit` | **FALLA — 13 errores** (`app.config.ts` ×6, `app/index.tsx` ×4, `src/api/destinations.ts` ×1, `src/api/export.ts` ×1). Mayoría `Uint8Array<ArrayBufferLike>` vs `BufferSource` (cambio de lib de TS), no defectos de runtime |
| `mobile: vitest run` | **VERDE — 138/138** en 10 ficheros |
| `backend: tsc --noEmit` | **FALLA — 1 error** (`rateLimit.ts:25`). Es el error conocido y aceptado en `KNOWN_DEBT.md` / `RELEASE_CHECKLIST_v0.3.md:25-27` |
| `backend: vitest run` | **ROJO — 4 fallos / 102 pasan (106)** + 1 unhandled error |
| `npm audit` | **NO EJECUTABLE** — no hay `npm` en este entorno |

### Detalle de los 4 fallos de backend

| Test | Fallo | Lectura |
|---|---|---|
| `auth.test.ts` › «401 cuando el verificador rechaza (firma mala, expirado, issuer erróneo)» | **Timeout a 5 000 ms** + `No "CONFIGURED_ISSUER" export is defined on the mock` | El test que demuestra que se rechazan JWT inválidos **no pasa**. El defecto está en el mock, no necesariamente en `auth.ts` (que sí verifica de verdad, §5) — pero la garantía **no está demostrada por la suite** |
| `chunks.test.ts` › «200 en transición pending → uploaded» | espera 200, recibe **201** | Drift de contrato |
| `sessions.test.ts` › «201 con body y JWT válidos» | el insert incluye `status: 'active'` no esperado | Drift de contrato |
| `sessions.test.ts` › «ignora user_id del body» | ídem | La aserción de seguridad relevante (`user_id` viene del JWT) **sí se cumple** en la salida observada; falla por el campo extra |

`RELEASE_CHECKLIST_v0.3.md:15` exige «`npm test` → 99/99 verdes» (hoy son 138) y `:28` «`npm test` verde» en backend (hoy rojo). `:14` exige `tsc --noEmit` limpio en mobile (hoy 13 errores).

---

## 7. Cobertura de test — qué está y qué no

**Cubierto y ejecutado (138 tests mobile)** — todo ello **lógica de rehidratación y transición de estado de la cola**, no escenarios físicos: cola (append/read/update/drop/mark), predicado del foreground service, reset de `uploading` al arrancar la app, ciclo completo de un chunk, puerta de finalización, reap, normalización/dedup/divergencia de hash, migración legacy, clasificación de errores, export desde chunk refs, runner de export, evidencia local, guard de OAuth, derivación de estado.

**Sin ningún test automático:**

| Módulo | Fichero | Por qué importa |
|---|---|---|
| `uploadDrainLoop` | `index.tsx:1932` | Es **el worker**. No está exportado, por lo que no es testeable tal cual |
| `runAudioChunkerTick` / `runVideoChunkerTick` | `index.tsx:2689`, `:2748` | Producción de chunks |
| `emitChunk` / `emitVideoChunk` | `index.tsx:2820`, `:2942` | Persistencia de payload + hash |
| `VideoFileChunkProducer` | `videoFileProducer.ts` | Todo el camino de vídeo |
| `backgroundService.ts` | — | Supervivencia en background |
| `orphanScan.ts` | — | Última red de seguridad ante pérdida de cola |
| `reconcileStaleSessionsWithBackend` | `index.tsx:1385` | Puede **borrar el fichero local** |
| `startRecording` / `stopRecording` | `index.tsx:4780`, `:5180` | Ciclo de vida completo |

---

## 8. Registros de validación existentes en el repo

| Fichero | Qué contiene realmente |
|---|---|
| `docs/VALIDATIONS/NAS_UPLOAD.md` | **Único registro fechado** (2026-05-04), con claves de log citadas y rutas de fichero. Sin modelo de dispositivo, versión de Android, tester ni commit |
| `docs/TEST_RESULTS.md` | 9 líneas «PASS». Sin fecha, dispositivo, versión, tester, commit ni log |
| `docs/SURVIVAL_TEST_RESULTS.md` | `:233` «(Sin sesiones registradas todavía…)». La suite de 10 pruebas **nunca se ha registrado como ejecutada** |
| `docs/RECOVERY_BETA_VALIDATION.md` | 14 escenarios, 9 marcados BLOCKER, **cero resultados** |
| `docs/BETA_TEST_MATRIX.md` | Plantilla vacía |
| `docs/VALIDATION_MATRIX.md` | 10 de 14 filas «?»; todas las casillas de conclusión sin marcar |
| `docs/EVIDENCE_EXPORT_AND_FORENSIC.md` | **0 bytes** (verificado con `wc -c`) |
| Todos los checklists | **0 casillas marcadas** en todo el repo (`grep -rn "\[x\]"` → 0 resultados, verificado) |

---

## 8bis. Android, OAuth y recovery — trazabilidad adicional

| Requisito | Documentación | Implementación | Prueba | Estado | Riesgo |
|---|---|---|---|---|---|
| Foreground service Android 14+ tipado | `RELEASE_CHECKLIST_v0.3.md:42,45-46` exige `FOREGROUND_SERVICE_MICROPHONE` y `foregroundServiceType="microphone"` | Ambos presentes (`AndroidManifest.xml:4,26`; `backgroundService.ts:176`). `FOREGROUND_SERVICE_DATA_SYNC` **no** declarado | código | **PARCIAL** | ALTO (GC-AUD-008) |
| El arranque del FGS es observable | `backgroundService.ts:326-328` afirma poder detectar un rechazo del OEM | `BackgroundActionsModule.java:53-54` resuelve la promesa antes de `onStartCommand`; `src/index.js:84-85` fija `_isRunning = true` incondicional; `isRunning()` devuelve ese booleano JS | código | **CONTRADICTORIA** — la telemetría no puede medir lo que dice medir | ALTO (GC-AUD-034) |
| Orden permiso de micrófono → FGS | — | `index.tsx:4848` arranca el FGS **antes** de `index.tsx:4933` (`requestAudioPermissions`) | código | **NO DEMOSTRADA** (riesgo de `SecurityException`) | ALTO (GC-AUD-035) |
| Shortcut del lanzador | `RELEASE_CHECKLIST_v0.3.md:47` exige `<meta-data android:name="android.app.shortcuts">` | **Ausente** del manifest (40 líneas, verificado) | código | **NO IMPLEMENTADA** | MEDIO (GC-AUD-018) |
| El shortcut NO debe iniciar grabación sola | `RELEASE_CHECKLIST_v0.3.md:149` | `index.tsx:6252-6260` dispara `startCountdown()` en arranque en frío (opt-in, visible, cancelable) | código | **CONTRADICTORIA** | MEDIO (GC-AUD-018) |
| Firma de release | `RELEASE_CHECKLIST_v0.3.md:65` «NO con el debug.keystore» | `android/app/build.gradle:112-115` `release { signingConfig signingConfigs.debug }` | código | **CONTRADICTORIA** | ALTO (GC-AUD-037) |
| OAuth Drive seguro | `SECURITY.md` (flujo `drive.file`) | Sin PKCE (0 coincidencias de `code_challenge`); `state` se propaga y **nunca se valida** (`destinations.routes.ts:293-294`, `:1115`); esquema custom sin `autoVerify` | código | **PARCIAL** | ALTO (GC-AUD-036) |
| Tokens no expuestos | `SECURITY.md` | Refresh token de Drive **no** en cliente ✔ (`destinations.ts:14-15`). Sesión de Supabase en AsyncStorage plano + `allowBackup="true"` ✘ | código | **PARCIAL** | MEDIO (GC-AUD-038) |
| Export parcial honesto (camino normal) | `TEST_SCENARIOS.md:58-115` | Prefijo contiguo, corte en el primer hueco, `.bin` marcado «Reproducible: No», defensa por `expectedLocalChunks` | test (32) | **VERIFICADA** | Bajo |
| Export parcial honesto (recovery cross-device) | `CROSS_DEVICE_RECOVERY.md:87-92` «✅ partial recovery» | `verdictFor` (`recover/[id].tsx:230-234`) devuelve «Protegido» mirando sólo `result.status`; `manifest.service.ts:209` `chunk_count = uploaded.length` | **ninguna** (`recoveryExport.ts` sin fichero de test) | **CONTRADICTORIA** | **CRÍTICO** (GC-AUD-033) |
| **Estado de terminación de captura** | Ningún documento lo define | **No existe.** El sistema no persiste en ninguna parte por qué terminó la captura. `completed_at` sólo registra que se llamó a `/complete`, es decir **confirmación remota**, no finalización limpia de la captura | — | **NO IMPLEMENTADA** | **CRÍTICO** (GC-AUD-033, GC-AUD-002) |
| Distinción de las 4 dimensiones de completitud | — | Colapsadas en dos señales insuficientes (`recording_closed`, `completed_at`). Ver §10 | — | **NO IMPLEMENTADA** | **CRÍTICO** |
| Chunk 0 ausente → sin fichero | `TEST_SCENARIOS.md:71-86` espera archivo `.bin` | `export.ts:725` corta con `validChunks=0` → `status:'failed'`, `filePath: null` — **no** genera `.bin` | test parcial (cubre el fallo por hash, no la ausencia) | **CONTRADICTORIA** doc↔código | Bajo |
| Sin flags de depuración en release | `RELEASE_CHECKLIST_v0.3.md:20-22` | Todas las flags en estado de release ✔. Pero rutas `debug-camera-probe` (×2) viajan sin gate `__DEV__` y `perfLog` emite `console.log` incondicional | código | **PARCIAL** | MEDIO (GC-AUD-039/040) |

---

## 9. Resumen por estado

| Estado | Nº | Ítems |
|---|---|---|
| **VERIFICADA** | 12 | Cola persistente, single-flight, backoff, **I5a normalización de cola al arrancar la app (como lógica)**, completion gate, reap, dedup/normalización, lógica de export (camino normal), verificación JWT, autorización por propietario, idempotencia de chunks, ausencia de retención de bytes en backend |
| **PARCIAL** | 11 | I1/I6 (audio sí, vídeo no), I9 (activación), registro de sesión, registro de metadata, manifests, cross-device recovery, Android FGS tipado, OAuth Drive, almacenamiento de tokens, export parcial en recovery, ausencia de flags de depuración |
| **NO IMPLEMENTADA** | 7 | Cifrado local, `POST /auth/*`, `/alerts`, modo Kids, `meta-data` de shortcuts, **I5c recovery automático tras reinicio del dispositivo**, estado de terminación de captura (`capture_end_reason`) |
| **NO DEMOSTRADA** | 12 | Subida real a Drive, OAuth end-to-end, **I5b recovery tras kill**, background prolongado, red mala real, batería baja, almacenamiento lleno, reproducibilidad del export, FGS en Android 14/15, orden permiso→FGS, interceptación del deep link, promesa de los 10 s |
| **CONTRADICTORIA** | 27 | D1–D20 de §4, más I1, I8, y las 5 filas contradictorias de §8bis (telemetría del FGS, shortcut/auto-inicio, firma de release, veredicto de recovery, chunk 0 → `.bin`) |

---

---

## 10. Las cuatro dimensiones de la completitud (adjudicado)

El sistema colapsa hoy cuatro hechos independientes en dos señales, y de ahí nacen GC-AUD-002 y GC-AUD-033. Ninguna de las dos señales existentes sirve como prueba de que la captura terminó limpiamente.

| Dimensión | Pregunta que responde | Señal actual | ¿Sirve? |
|---|---|---|---|
| **1. Finalización limpia de captura** | ¿El usuario pulsó PARAR y el grabador cerró el fichero ordenadamente? | **ninguna** | — |
| **2. Captura interrumpida** | ¿Murió la app, se agotó la batería, mató el OEM, se cortó por límite? | **ninguna** | — |
| **3. Totalidad de chunks emitidos** | ¿Se emitieron todos los fragmentos que la captura produjo? | `next_chunk_index` | **No.** En vídeo interrumpido vale `0` y el sistema lo interpreta como «no faltaba ninguno» |
| **4. Confirmación remota** | ¿El destino confirmó la recepción de los fragmentos conocidos? | `chunk.status='uploaded'` + `remote_reference`; `sessions.completed_at` | Sí, **pero sólo para esto**. `completed_at` prueba que se llamó a `/complete`, nada más |

**Regla adjudicada:** `completed_at` **no puede usarse como prueba de captura completa**. Es una señal de dimensión 4 empleada hoy para responder a la 1.

**Estado persistente requerido:** un `capture_end_reason` explícito en la entrada de cola y propagado a la sesión y al manifest. **Cada valor exige la señal que lo justifica; ninguno se infiere.**

| Valor | Cuándo se asigna | Señal requerida |
|---|---|---|
| `user_stop` | El usuario paró **y** el grabador cerró y finalizó correctamente | Retorno con éxito de `stopAudioRecording` / `recordAsync`, más la pasada final ejecutada. **Pulsar PARAR no basta**: si el cierre falla, no es `user_stop` |
| `interrupted_limit` | Cortado por tope de duración o tamaño | Señal explícita del propio tope (`maxDuration` alcanzado, `VIDEO_TOO_LARGE_FOR_MVP`) |
| `interrupted_error` | El grabador o el chunker fallaron a mitad | Excepción capturada y registrada en el momento del fallo |
| `process_terminated` / `interrupted_unknown` | Entrada recuperada al **arrancar la app** sin cierre previo registrado | Ninguna. Es la ausencia de cierre, y **la causa no puede demostrarse** |
| `unknown` | Entradas legacy anteriores al campo | — |

> **Por qué no `interrupted_kill`.** Encontrar una entrada abierta al arrancar la app demuestra que **no hubo cierre limpio**, nada más. No distingue un *force-stop* del usuario, de un OOM, de un crash, de una batería agotada o de un OEM killer. Etiquetarlo `interrupted_kill` afirmaría una causa que el sistema no observó — el mismo defecto de método que esta auditoría reprocha en otras partes del proyecto. `process_terminated` (o `interrupted_unknown`) dice exactamente lo que se sabe. `interrupted_limit` e `interrupted_error` **sólo** cuando exista señal explícita en el momento del fallo.

### Estados de evidencia que la UI debe distinguir

«Protegido» exige **dimensión 1 (`user_stop`) Y dimensión 4 completa**. Pero lo contrario no colapsa en una sola etiqueta: **no existe una regla general de que todo `interrupted_*` rinda «Protección parcial»**. Los estados son estos, y cada uno dice algo distinto:

Cinco combinaciones, coherentes con §3ter del informe:

| Captura | Fragmentos remotos confirmados | Estado a mostrar |
|---|---|---|
| **Completa** (`user_stop`) | **todos** | «Protegido» |
| **Completa** (`user_stop`) | **parcial (N de M)** | **«N/M protegidos»** — sin declarar protección completa |
| **Completa** (`user_stop`) | **0** | **«Grabación completa; todavía no protegida fuera del dispositivo»** |
| **Interrumpida** | **≥1** | **«Hay evidencia protegida fuera del dispositivo; la grabación está incompleta»** |
| **Interrumpida** | **0** | **«Grabación incompleta; nada protegido fuera del dispositivo»** |

Que todos los chunks *conocidos* estén subidos no basta para «Protegido» cuando la lista de chunks conocidos puede estar truncada — que es exactamente GC-AUD-033.

**Nota sobre `scanOrphans` en `cacheDirectory`:** es una **mitigación**, no una garantía. Recupera el fichero, pero un `.mp4` interrumpido carece del átomo `moov` —que MediaRecorder escribe al final— y por tanto **no es reproducible**. Presentarlo como recuperación de la evidencia de vídeo sería repetir el error que esta auditoría denuncia. La garantía real sólo llega con captura segmentada en vivo (GC-AUD-001).

---

*Documento generado durante la auditoría integral del 2026-07-28 y adjudicado el mismo día. No modifica ningún fichero del sistema.*
