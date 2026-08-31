## Guardian Cloud — Known Technical Limits

Este documento registra límites técnicos REALES ya observados y validados en producción/beta.

Objetivo:
- evitar repetir debugging circular,
- proteger invariantes críticas,
- documentar límites de librerías/frameworks,
- impedir fixes peligrosos sobre recovery/upload pipeline.

---

# 1. expo-av orphaned Audio.Recording after swipe-close

## Estado

VALIDADO EN DEVICE REAL.

No es hipótesis.

---

## Escenario exacto

1. Usuario inicia grabación audio.
2. Audio.Recording queda activo con:
   - `staysActiveInBackground=true`
   - foreground service activo
3. Usuario hace swipe-close desde recientes SIN pulsar PARAR.
4. JS context muere.
5. `recordingRef.current` se pierde.
6. El recorder nativo puede seguir vivo internamente.
7. Recovery sube correctamente los chunks pendientes.
8. La sesión se completa correctamente.
9. Nueva grabación audio falla con:

```txt
Only one Recording object can be prepared at a given time.

Video sigue funcionando.

Causa real

expo-av NO expone API pública para liberar un Audio.Recording
cuando el objeto JS original ya no existe.

Las APIs siguientes NO solucionan el problema:

Audio.setIsEnabledAsync(false)
Audio.setAudioModeAsync(...)

Solo afectan futuras operaciones.

NO destruyen el recorder huérfano.

Lo importante

El problema NO es:

GC_QUEUE
recovery
upload worker
chunking
foreground upload
Drive upload
session completion

Todo eso funciona correctamente.

El límite está en la implementación interna de expo-av.

Recovery NO debe modificarse

El recovery actual es correcto:

reabre cola
resetea chunks stuck uploading
finaliza sesiones pendientes
sube chunks restantes
completa sesión

Modificar recovery intentando "matar" el recorder rompió:

subida
quick start
flujo de audio
estabilidad general
Decisión estratégica

NO intentar hacks agresivos sobre expo-av.

NO:

resets múltiples
stop en AppState background
destruir audio subsystem repetidamente
inventar locks artificiales
tocar recovery para arreglar audio huérfano

Eso rompe invariantes críticas.

Invariantes protegidas

Estas prioridades son MÁS IMPORTANTES que reiniciar audio:

evidencia subida
recovery funcional
cola persistente
chunking estable
export usable
Comportamiento aceptado actualmente

Si ocurre swipe-close durante grabación audio:

recovery debe sobrevivir
chunks deben subirse
sesión debe completarse

Aunque:

siguiente grabación audio pueda requerir force-stop manual

Esto es preferible a romper recovery global.

Video

Video NO comparte este límite exacto.

expo-camera usa pipeline distinta.

Durante las pruebas:

video siguió funcionando
recovery siguió funcionando
Lecciones aprendidas

Error cometido:

intentar arreglar un límite estructural de librería
desde lógica JS/recovery.

Consecuencia:

se introdujeron regressions
aparecieron estados inconsistentes
chunks "fantasma"
quick-start roto
riesgo real sobre supervivencia
Regla futura

Si recovery funciona:
→ NO tocar recovery de noche.

Primero:

logs
aislamiento
reproducibilidad

Después:

fix mínimo

Nunca:

múltiples fixes simultáneos sobre start/stop/recovery/chunker.
Solución real futura

La solución REAL requiere:

Opción A — migración a expo-audio

o

Opción B — módulo nativo custom

Probablemente:

Kotlin/Java Android
control explícito del recorder lifecycle
foreground service integrado
ownership nativo del audio pipeline
Estado oficial actual

ACEPTADO COMO KNOWN LIMITATION.

NO bloquear release beta por esto.

El producto sigue cumpliendo:

supervivencia de evidencia
subida en background
recovery
export
persistencia

Que son las invariantes reales del sistema.

---

# 2. GC-AUTH-MIGRATION-001 — la legacy probe leía rastros de captura local-first

## Estado

VALIDADO EN DEVICE REAL (OnePlus A6000, 2026-08-21).
Corregido por código. El dispositivo de pruebas sigue contaminado a propósito,
como evidencia física del defecto.

---

## Escenario exacto

1. Instalación nueva. No existe `gc.identity.v1`.
2. `FIRST_IDENTITY` → `signInAnonymously()` falla por indisponibilidad remota.
   No se escribe marker: un sign-in fallido no creó ninguna identidad.
3. 4C permite la captura local-first sin token. Aparecen rastros durables:
   `test.pending_retry`, `guardian.pending_session_registrations`,
   `history.sessions` y `export.last_session_id`.
4. Kill / restart.
5. La legacy probe lee esos rastros como prueba de una identidad histórica.
6. Escribe `gc.identity.v1` con `migrated_from_legacy: true`, `sub_prefix: null`.
7. La instalación queda marcada como previamente inicializada **sin haber
   tenido nunca una identidad** → `IDENTITY_DEGRADED` permanente → la única
   puerta de acuñación queda cerrada para siempre.

Resultado: el dispositivo captura localmente sin límite y nunca puede subir
nada, porque nunca podrá obtener su primera identidad.

---

## Causa raíz

No era un conjunto de señales equivocado. Era una **asimetría de sellado**.

`resolveIdentityInitialized` sellaba el veredicto POSITIVO (escribiendo el
marker) y no sellaba absolutamente nada para el negativo. La sonda volvía a
ejecutarse en cada arranque, esperando a que apareciera algo. La captura
local-first hizo que apareciera.

La premisa original de la sonda —«`startRecording` se niega a empezar sin
token, luego cualquier rastro de grabación prueba que existió identidad»— es
correcta, pero **acotada en el tiempo**. La guarda `TOKEN_MISSING_AT_START`
está presente de forma continua desde `22d3f5e` hasta `45357c4`, en todos los
tags de release, y cubre audio y vídeo nativo con una única comprobación
unificada. Solo `8615ba6` (4C) la elimina.

---

## Corrección

Clave nueva `gc.legacy_probe.v1`, separada del marker:

```
{ version, probe_version, evaluated_at, legacy_identity_evidence }
```

Se sellan **ambos** veredictos. La primera evaluación del seal es la
**frontera de migración**: todo rastro presente en ese instante fue escrito
necesariamente por un build con la guarda del token, así que la implicación
de la sonda se sostiene exactamente ahí y nunca más se vuelve a preguntar.

Semántica obligatoria:

- Registra el resultado de UNA migración histórica.
- NO representa el estado actual de identidad.
- `gc.identity.v1` sigue siendo la autoridad sobre identidad establecida.
- `legacy_identity_evidence: false` significa únicamente «en la frontera de
  migración no había rastros de identidad histórica». NO significa «no existe
  identidad» ni «es seguro acuñar».
- `evaluated_at` es exclusivamente diagnóstico. **Nunca** se compara: el
  dispositivo de pruebas corre 21 693 s adelantado.

Orden crash-safe fijado: **probe → seal → mint → marker**.

### Tres reglas de durabilidad, todas de fallo cerrado

**1. Un veredicto negativo solo cuenta si es durable.** Si la escritura del
seal falla, la sonda sabe la respuesta pero el siguiente arranque no: volverá a
preguntar, y para entonces una captura local-first puede haber escrito los
rastros que la sonda lee como identidad histórica. Acuñar sobre un negativo no
sellado es apostar a que el proceso sobreviva lo bastante para persistirlo. No
se apuesta: `boundaryUnsealed` cierra la puerta y `decideIdentityState`
devuelve `IDENTITY_DEGRADED / boundary_unsealed`. `initialized` sigue siendo
honesto (`false`); lo que se retiene es el permiso para actuar sobre él.

**2. La captura no puede adelantar a la RESOLUCIÓN de la frontera.** El hoist
al inicio del efecto **no basta**: React commitea el render —y pinta un GRABAR
AHORA habilitado— antes de ejecutar effects. La garantía es estructural y vive
en `startRecording`, que espera a `ensureMigrationBoundary()` antes de su
primera escritura durable. Ambos caminos comparten un latch single-flight, así
que el primero que llega hace el trabajo y el otro se une a la misma promesa.
Depende **solo de almacenamiento local**: ninguna red puede retener una
grabación.

La propiedad, formulada con precisión —la versión corta no es cierta—:

> Antes de que una captura local-first cree una señal legacy, la **resolución**
> de la frontera de migración **ha corrido**. Si el veredicto negativo no puede
> hacerse durable, la captura puede continuar, y `FIRST_IDENTITY` permanece
> cerrado.

**NO** «la frontera está decidida de forma durable». Se decide en memoria; si
esa decisión llegó a disco lo informa `sealed`, y cuando no llegó, lo que
mantiene cerrada la puerta es `boundaryUnsealed`. Se acepta conscientemente:
la supervivencia de la evidencia va por delante de la higiene de migración.

**3. Una identidad establecida cuyo marker no persiste retira el seal.** La
forma peligrosa es un `legacy_identity_evidence: false` durable junto a un
marker ausente: en un arranque posterior sin sesión eso se lee como
`FIRST_IDENTITY` y acuña una **segunda** identidad, huerfanando en silencio
todo lo que subió la primera. Cuando `markIdentityInitialized` informa de que
no pudo persistir, se **invalida el seal** para que la frontera se decida de
nuevo; cualquier rastro que dejara la identidad establecida hará que la sonda
responda «sí» → `IDENTITY_DEGRADED` → ownership preservado. No se hace
`signOut`, no se acuña otra, no se toca un solo byte de evidencia.

**4. La regla 3 no puede depender de que borrar funcione (R4).** Invalidar el
seal es también una escritura y puede fallar. Con las dos fallando —marker no
persistido **y** seal obsoleto no borrado— la instalación volvía a quedar en la
forma exacta que acuña una segunda identidad. Una protección que asume «borrar
normalmente funciona» no es una protección.

La defensa que no depende de ninguna escritura: antes de actuar sobre un seal
negativo se consulta `hasProvenIdentityEvidence()`, que lee lo que el propio
camino de subida ya escribió — un chunk `uploaded` con `remote_reference` no
vacío, o una sesión con `session_completed: true`. Ambos son **inalcanzables
sin token**: `uploadChunkBytes` aborta con `NO_TOKEN`.

Es una implicación de un solo sentido y **solo se usa en ese sentido**:

- `true` ⇒ existió una identidad → se rechaza acuñar.
- `false` ⇒ no se sabe nada → se cae al seal, como antes.

No puede resucitar el defecto: una captura 4C produce chunks `pending` sin
`remote_reference` —medido en hardware, 0 de 43—, así que un dispositivo que
nunca tuvo identidad jamás satisface el predicado. Reutiliza
`isChunkConfirmedOffDevice`, la definición canónica de «esto está fuera del
dispositivo», para que la capa de identidad y la de protección no puedan
divergir. **No se creó ninguna clave nueva** y `gc.identity.v1` sigue siendo la
autoridad.

Alcance honesto: si A acuñó pero no llegó a subir nada, no hay prueba local y
se acuñaría B — pero entonces A no poseía nada, así que no se abandona
ownership. Es el límite que el propio requisito acota: «mientras el sistema
siga teniendo evidencia local suficiente para saber que A existió».

**5. La prueba no puede depender de GC_QUEUE, porque el reap la borra (R5).**
`reapEntry` hace `queueDropEntry` y `journal.drop` hace `entries.splice`: en el
camino feliz —subida → `/complete` → reap → cleanup— **toda** prueba local de
que existió una identidad desaparece. Ninguna de las 12 claves durables de la
app sobrevive al reap probando identidad.

En vez de buscar una prueba que sobreviva al cleanup, se invierte el orden:

> **Una identidad no adquiere ownership remoto hasta que el dispositivo puede
> probar localmente que esa identidad existe.**

Los dos estados quedan mutuamente excluyentes —marker no durable ⇒ A no posee
nada; A posee algo ⇒ el marker es durable—, así que `gc.identity.v1`, que
ningún reap toca, siempre basta. **Sin tumba y sin clave nueva:** dos claves en
el mismo AsyncStorage no son dos dominios de durabilidad.

Autoridad única: `getOwnershipToken()` en `src/auth/store.ts`. No hay
comprobaciones repartidas por endpoint. Toda mutación autenticada toma su token
de ahí —incluida la caché del *hot path* del worker, que si no rodearía la
puerta— y las lecturas siguen usando `getAccessToken`.

Inventario gateado: `POST /sessions`, `POST /chunks`,
`POST /destinations/{type}/chunks`, `POST /sessions/:id/complete`,
`/destinations/drive/connect` (start y exchange) y
`/destinations/drive/test-upload`. Los `GET` de destinations, chunks, recovery,
export y health no crean nada que poseer y no se gatean.

Diferimiento sin mecanismo nuevo: sin token de ownership, `POST /sessions` toma
la ruta de 4B (`schedulePendingSessionRegistration`, mismo `localSessionId`) y
los chunks se quedan `pending` con el 401 que el worker ya trata como
transitorio. Cadencia, backoff y `localSessionId` **sin cambios**.

Reintento del marker en puntos que ya existen —`init()`,
`onAuthStateChange` (`SIGNED_IN` / `TOKEN_REFRESHED`) y el propio
`getOwnershipToken`— con latch en memoria. **Cero polling nuevo.**

UX: las tres acciones de Drive son del usuario, así que el rechazo **no es
silencioso**. No se envía la petición, no se toca la sesión, no se crea
identidad, no se toca evidencia; el error lleva el código `IDENTITY_NOT_READY`
y Settings muestra «Preparando conexión segura… Inténtalo de nuevo en unos
segundos.» Sin pantallas ni pasos nuevos, y **sin reproducir OAuth solo**.

Marker ausente y marker ilegible **dejan de colapsarse**. Un byte presente en
el slot del marker prueba que algo escribió un marker alguna vez, y eso basta
para negarse a acuñar. Un seal negativo no puede atravesar un marker corrupto.

---

## FIXED BY CODE

- Contaminación de `FIRST_IDENTITY` causada por rastros post-4C.
- Marker corrupto interpretado como marker ausente.
- Sonda re-ejecutándose indefinidamente en instalaciones nuevas.
- Veredicto negativo no durable abriendo la puerta de acuñación.
- Captura escribiendo señales legacy antes de decidirse la frontera.
- Identidad acuñada con éxito reemplazada más tarde por un fallo de
  persistencia de `gc.identity.v1`.
- Lo mismo cuando **además** falla el borrado del seal obsoleto (R4), siempre
  que quede prueba local de subida.
- Prueba de identidad destruida por el reap de GC_QUEUE en el camino feliz (R5):
  cerrado invirtiendo el orden — sin marker durable no hay ownership remoto.

## NOT FIXED — deudas independientes, no tocar desde aquí

- `RELEASE_BLOCKER`: no existe ruta de recuperación desde un
  `IDENTITY_DEGRADED` ya establecido.
- **El dispositivo actual ya contaminado.** El seal NO repara marcadores
  retroactivamente y no debe usarse para afirmar que lo hace.
- Downgrade a una versión que desconoce el seal: reabre la ventana.
- **Fallo de escritura PERSISTENTE del seal.** Si el seal nunca puede
  escribirse, la frontera nunca se cierra y unos rastros escritos entretanto se
  leerán como identidad previa en un arranque posterior. El resultado es
  `IDENTITY_DEGRADED` —la instalación queda retenida, no acuñada en silencio—,
  así que no se pierde ownership ni evidencia. En campo la forma es en gran
  medida autolimitada: un dispositivo que no puede escribir el seal tampoco
  puede escribir la entrada de cola. Un fallo **transitorio** sí se recupera:
  `ensureMigrationBoundary` reintenta el sellado en la puerta de captura.
- Retry sin backoff ni tope (`runPendingRegistrationLoop`, ~5,03 s medidos).
- Boot recovery diferido en degradado (`EVIDENCE_PRESERVED / RECOVERY_DEFERRED`).
- UX sin aviso de que la evidencia no ha salido del dispositivo.
- Foreground service superviviente con `recording_closed: true`.
- Copy de notificación engañoso («protegiendo tu evidencia» con 0 referencias
  remotas).
- Ownership backend entre identidades.
- Validación de export `.mp4`.
- Diagnóstico del error concreto de refresh.

---

## Estados intrínsecamente ambiguos — NO resolver automáticamente

Un marker con `migrated_from_legacy: true` y `sub_prefix: null`, sin ninguna
`remote_reference` en el estado durable, es **indistinguible** entre:

- una instalación que nunca tuvo identidad y fue contaminada, y
- una instalación que sí la tuvo y perdió la sesión.

La asimetría es real y solo va en un sentido: la presencia de una
`remote_reference` **demuestra** que existió identidad (`uploadChunkBytes`
aborta con `NO_TOKEN` sin token); su ausencia **no demuestra nada**.

Regla: **nunca acuñar automáticamente para resolver un estado ambiguo.** La
recuperación explícita y consentida pertenece a otra fase.

---

## Validación de instalación nueva

`pm clear` (o desinstalar). **Nunca `hardResetAppState`**, que preserva
marker, seal y sesión de Supabase a propósito. Ni siquiera un borrado total de
AsyncStorage es del todo «fresh»: el usuario anónimo sigue existiendo en el
servidor.

---

# 3. GC-DEST-PAUSE-001 — una pausa de destino sobrevivía a la recuperación del destino

## Estado

**FIXED IN CODE / HARDWARE REVALIDATED.**

Observado en hardware el 2026-08-21 (OnePlus A6000) durante la Vía 2 desde
instalación limpia. **Revalidado en hardware el 2026-08-24** sobre el mismo
dispositivo. La corrida del 21/08 quedó anulada por
[`GC-DEV-RESET-001`](#4-gc-dev-reset-001--una-herramienta-dev-podía-destruir-evidencia-pendiente);
la del 24/08 es la que cuenta.

---

## Revalidación en hardware — 2026-08-24

**Cross-build durable-state recovery validation.** No es una reproducción
intra-build, y eso es parte de la provenance: **la pausa la escribió un build
anterior** (era `34412a0`, sin D2-B ni D2-C, APK `ab3a638e…`, pausa sellada el
2026-08-23T01:20:47Z) y **la retirada la ejecutó producto `22a9b26`** desde un
APK release autónomo distinto (`2b3be062…`). El estado durable sobrevivió a la
sustitución del paquete: `adb install -r` conservó `firstInstallTime`, así que
`/data` no se borró en ningún momento.

Precondición congelada y hasheada antes de instalar: sesión
`3c86e4e2`, 10 chunks `pending`, `uploading 0`, `remote_reference` nulo,
`gc.pause.global.v1` con `destinations.drive = DRIVE_NOT_CONNECTED`, backend
con **0 de 10**. La pausa llevaba ~20 h en vigor.

Cadena causal observada, en orden atribuible:

| Hora (dispositivo) | Evento |
|---|---|
| 03:50:03 | `POST /destinations/drive/connect` — inicio del OAuth real |
| 03:50:13 | vuelta del navegador; `POST …/connect` de cierre |
| 03:50:13 – 03:50:17 | `drain exit — all remaining entries paused` — **la pausa todavía aguanta** |
| 03:50:18.868 | `GC_QUEUE destination pause cleared { destinations: ['drive'] }` |
| 03:50:18.921 | primer `POST /destinations/drive/chunks` — el drain vuelve a elegir |
| 03:50:22 – 03:50:49 | 10 × `GC_PERF_DRAIN_POST_CHUNKS`; `pending` 10 → 0 |
| 03:50:49.653 | `completion gate` `expected=10 uploaded=10 missing=[]` |
| 03:50:49.654 | `POST /sessions/3c86e4e2…/complete` — **solo después** |
| 03:50:52.569 | `GC_CLEANUP_AUTHORIZED { authorization: 'http_200' }` |
| 03:50:52.594 | borrado del `.aac` — **después** de la autorización, nunca antes |

10 `remote_reference` **distintas** para 10 chunks. Identidad estable durante
todo el proceso: un único `user_prefix` (`08c0875e`), con `GC_ANON_SIGNIN`,
`SIGNED_OUT` y `removeItem(primary_session)` a **cero**.

**Lo que la prueba NO demuestra**, dicho explícitamente:

- El campo `attempts` **no se emite** en esta ruta del drain. No existe registro
  literal de «`attempts` deja de ser 0». Lo que sí consta —y es más fuerte— son
  10 POST reales y 10 referencias remotas distintas.
- El APK es release y por tanto **no** `debuggable`: sin `run-as` no se leyó
  ningún estado privado posterior a la corrida. El veredicto se apoya en
  logcat, en la respuesta del backend y en la baseline preservada.
- `GC-DEST-STATUS-001` sigue abierto y no queda invalidado por esto: aquí Drive
  se reconectó **explícitamente** por OAuth, así que un `connected` inmediatamente
  posterior es atribuible al flujo real.

Paquete de evidencia congelado, con barrido de secretos y `SHA256SUMS`
verificado, en `2026-08-24-gc-dest-pause-001-revalidation` (fuera del
repositorio).

---

## Causa original

El store de pausas tiene tres ámbitos. Solo uno tenía ruta de limpieza.

| Ámbito | Códigos que la crean | Limpieza |
|---|---|---|
| `client_auth` | `CLIENT_SESSION_EXPIRED` (401 / NO_TOKEN) | sí — `notifyClientAuth` desde el ciclo de vida de Supabase, con handler propio |
| `systemic` | `BODY_TOO_LARGE` (413) | no, **deliberado**: es un defecto de configuración en tiempo de compilación |
| `destinations[type]` | `DRIVE_NOT_CONNECTED`, `DRIVE_REFRESH_FAILED` | **no, y NO era deliberado** |

`client_auth` recibió una señal positiva de recuperación y algo que actuara sobre
ella. `destinations` nunca recibió la suya, **aunque esa señal ya se calculaba**.

Consecuencia medida: `pending: 54, uploading: 0` indefinidamente. Conectar Drive
no la levantaba. Un arranque en frío tampoco: la clave se rehidrata intacta.
**La evidencia nunca se perdió** —permanece durable y local— pero no podía salir
del dispositivo.

---

## Corrección

`clearRecoveredDestinationPauses(connected)`: retira `destinations[T]` para cada
T confirmado, dentro del `queueMutate` existente, releyendo el estado y
considerando realizada la transición **solo si la pausa concreta seguía
presente**. Dos invocaciones concurrentes pueden observar `connected`; solo una
gana `paused → unpaused` y pide el re-kick. Es la misma disciplina del handler de
`client_auth`.

Invocada desde `refreshDestination`, que ya corre en el bootstrap y en el focus
de Home — **sin polling nuevo**. Volver del navegador tras el OAuth es un focus.
No convierte a `refreshDestination` en propietario del upload: retira un bloqueo
provablemente obsoleto y pide el drenaje que ya existe (`uploadDrainLoop` es
single-flight).

---

## Qué autoriza el clear

**Solo esto:** `listDestinations()` devuelve una fila con
`type === T && status === 'connected'`. Es la negación directa del 409
`DRIVE_NOT_CONNECTED` («No connected Google Drive destination for this user»)
que creó la pausa.

## Qué NO lo autoriza

**`destinationResolved`.** Es un *race guard* que significa «el enrutado ya se
conoce», no «hay un destino conectado». `refreshDestination` lo pone a `true`
incluso con **cero** destinos conectados: la línea de enrutado cae al valor por
defecto `'drive'`. En hardware se observó `destinationResolved: true`
coexistiendo con una pausa de Drive activa y Drive desconectado. Limpiar con esa
señal desbloquearía un destino roto.

**El tiempo transcurrido.** El campo `at` no se lee nunca.

**Cualquier otro ámbito.** Una reconexión de Drive no toca `client_auth`, ni
`systemic`, ni una pausa de NAS, ni ninguna pausa de entrada.

---

## Residuales

- `listDestinations()` es una lectura autenticada: si el backend no responde, la
  pausa permanece. Correcto, pero la recuperación depende de una llamada de red.
  Nunca limpia por ausencia de datos.
- `status: 'connected'` es la palabra del backend. Un `connected` con refresh
  token muerto limpiaría y el siguiente chunk volvería a pausar. Autolimitado y
  sin pérdida de evidencia.
- **`systemic` sigue sin ruta de limpieza**, fuera de alcance por diseño.
- **El cableado `refreshDestination → clearRecoveredDestinationPauses` sigue sin
  cobertura de tests**: `refreshDestination` es un closure de componente. La
  función está probada con 17 tests y tres mutation tests; que el componente la
  invoque con las filas `status === 'connected'` —y no con
  `destinationResolved`— es una propiedad de orden de código, verificable
  leyendo el callsite. Es la misma limitación declarada para el hoist de R5.
  > La revalidación del 24/08 **ejercitó ese cableado en hardware** y lo
  > encontró correcto: la pausa se mantuvo mientras `destinationResolved` ya era
  > `true` y sólo se retiró tras la reconexión real. Es una observación, no
  > cobertura: la deuda de test sigue viva.

---

# 4. GC-DEV-RESET-001 — una herramienta DEV podía destruir evidencia pendiente

## Estado

**RELEASE BLOCKER · FIXED IN CODE / HARDWARE REVALIDATION NOT REQUIRED.**

Redacción factual del incidente:

> **Una acción manual accidental sobre una herramienta DEV permitió destruir
> evidencia pendiente no confirmada remotamente.**

No fue GC-DEST-PAUSE-001. El sistema **no** borró la evidencia por su cuenta:
la borró una herramienta al ser activada.

---

## El incidente

2026-08-21, OnePlus A6000, durante la Vía 2. Un long-press accidental sobre el
control de reset de la pantalla Home destruyó:

```
54 chunks .b64          remote_reference 0 / 54
1 776 751 bytes .aac    nunca subidos
localSessionId aee2cd23-7320-44c2-86c8-0198f4eb47a5
```

El logcat lo registra sin ambigüedad: `GC_RESET start` / `GC_RESET done`, con
**0** subidas a destino, **0** `remote_reference`, **0** `/complete` y **0**
reap en todo el buffer. No fue una convergencia: fue un borrado.

Contaminó la corrida de revalidación de GC-DEST-PAUSE-001, que quedó anulada.

---

## Causa raíz

El control combinaba las tres peores propiedades a la vez:

1. **Gesto accidental** — long-press de 800 ms sobre un objetivo de 10 px con
   `opacity: 0.15`.
2. **Sin confirmación** — ejecutaba al soltar.
3. **Sin comprobación de evidencia** — la única guarda era «no mientras grabas».

Y `hardResetAppState` borra `documentDirectory` y `cacheDirectory` **enteros y
de forma recursiva**: se lleva chunks, segmentos nativos, audio y staging sin
enumerar ni distinguir sesiones.

Existía además una segunda superficie, `clearGuardianQueueDev`, cuyo docblock
afirmaba que «el gate de la UI de Settings impone DEV-only» — **falso**:
`app/settings.tsx` no contenía ninguna ocurrencia de `__DEV__`. Su componente
(`DevQueueWipeBlock`) resultó no estar renderizado en ningún sitio, así que el
riesgo era **latente, no vivo**; pero el gate se ha puesto igualmente.

---

## Corrección

**Una única política de rechazo**, en `src/dev/reset.ts`, con dos mitades —
GC_QUEUE y filesystem — y ninguna herramienta destructiva la puede eludir. La
mitad de cola:

```
inspectPendingEvidence()
  → hay algún chunk que NO es isChunkConfirmedOffDevice
  → RECHAZO. No se borra ni un byte ni una clave.
```

Es un **rechazo**, no un diálogo. **No existe «borrar de todas formas».**
`isChunkConfirmedOffDevice` se reutiliza tal cual: es el mismo predicado del
export gate, del finalize gate y del banner de Home. Una segunda definición de
«protegido» sería una segunda cosa que se puede equivocar.

La regla es **prueba positiva**, no recuento de chunks. Una entrada solo es
descartable si se puede demostrar que **no** contiene evidencia local que haga
falta conservar. Y prueba de seguridad hay exactamente una forma: un array
`chunks` **no vacío** en el que **todos** satisfagan `isChunkConfirmedOffDevice`.

### Por qué cero chunks BLOQUEA

Una versión anterior de este guard razonaba «sin chunks ⇒ sin bytes ⇒ seguro».
Es falso en este código, y `tryFinalizeReadySessions` **ya lo decía con todas
las letras**:

> *«The empty set is fully uploaded» is true arithmetic and a catastrophic
> operational rule. A zero-chunk entry is not proof of complete remote evidence
> — it is proof of nothing at all.*

**Toda captura nace con `chunks: []`**, escrita durablemente por 4A antes de que
el chunker emita nada:

| forma | `uri` al crearse |
|---|---|
| audio / vídeo legacy | la grabación real en `cacheDirectory` |
| vídeo segmentado nativo | **`''`** — los segmentos viven en `files/segments/{id}/` y se adoptan como chunks más tarde |

Así que **`uri` tampoco puede ser el discriminador**: el vídeo nativo lleva uno
vacío legítimamente mientras ya existen bytes reales en disco. Una entrada de
cero chunks puede ser una captura en curso, una tras un kill, un chunker que
falló, o una captura demasiado corta para emitir.

**Bloquean:** cualquier chunk no confirmado · **cero chunks, por el motivo que
sea** · `chunks` ausente o no-array — **nunca** degradar a `[]` · una entrada
que no es objeto · cola ilegible o no-array.

**Superan esta comprobación:** cola realmente vacía (`[]`) · **toda** la
evidencia confirmada fuera del dispositivo, que es cuando la copia local es
redundante. Superar esta comprobación **no autoriza borrar ficheros** — ver la
sección siguiente.

---

## La cola vacía NO es prueba suficiente: evidencia fuera de GC_QUEUE

`hardResetAppState` borra `documentDirectory` **entero**, y una cola vacía no
demuestra que ese directorio no contenga nada. El producto tiene una ruta que
**produce exactamente ese estado a propósito**:

```
abandonUnregisteredSession()
  1. mueve la captura a documentDirectory/guardian_recording_*
  2. y DESPUÉS retira la entrada de GC_QUEUE
```

Ese orden es deliberado — una muerte de proceso entre los dos pasos deja una
referencia de más, nunca ninguna — y la promoción **existe precisamente** para
que `orphanScan()` pueda recuperar los bytes cuando ya nada en la cola apunta a
ellos. Bajo la regla anterior, el reset destruía justo la evidencia que la
promoción se había hecho para salvar.

**Regla correcta: prueba positiva GLOBAL.** El reset procede solo si
`inspectPendingEvidence()` **y** `inspectLocalArtifacts()` devuelven `null`.
Cualquiera de las dos que falle, o que no se pueda determinar, rechaza.

### Inventario de superficies locales

**Evidencia local recuperable / no confirmada — BLOQUEA:**

| Superficie | Por qué |
|---|---|
| `guardian_recording_*` recuperables (`orphanResult.orphans`) | Es lo que `orphanScan` existe para recuperar |
| `orphanResult.oversized` | Que esta versión **no pueda** trocearlos no los hace seguros de destruir: es lo contrario — los bytes están atrapados en el dispositivo y el dispositivo es el único sitio donde existen |
| `skipped_too_old` (> 7 días) | La antigüedad no es prueba de que no valgan. El scanner los oculta del banner; eso no es permiso para triturarlos |
| `skipped_unknown_ext` | Un `guardian_recording_*` que no sabemos clasificar |
| `skipped_zero_size` | El scanner cuenta aquí **tanto** los de 0 bytes **como** los fallos de `stat`, y el informe no los distingue: es un desconocido, no un cero |
| `segments/<sid>/` sin autorización de limpieza | `segmentAdopter` los coloca **fuera** de `chunks/<sid>/` justamente para que **sobrevivan a la entrada de cola**. «No hay entrada» no dice nada de ellos |
| `documentDirectory` ilegible | Desconocido nunca es vacío |
| Diario de limpieza ilegible | Una autorización que no se puede interpretar no es una autorización |

**Residuos localmente borrables con autorización durable — NO bloquean:**

| Superficie | Por qué |
|---|---|
| `skipped_already_queued` | Su `uri` pertenece a una entrada viva, sobre la que la regla 1 ya ha bloqueado o ha demostrado confirmación completa. Si cada chunk troceado de ese fichero lleva `remote_reference`, el original local es redundante por la misma regla que autoriza reapear la entrada |
| `segments/<sid>/` **con** entrada en `guardian.segment_cleanup.v1` | Es constancia durable de que el **backend** autorizó borrar la evidencia local de esa sesión. El runner tiene permiso y simplemente aún no ha llegado. Bloquear aquí atascaría la herramienta con basura inocua |
| `documentDirectory/chunks/<sid>/` | Trozos siempre **derivados** de una fuente que sí está protegida (`entry.uri` mientras la entrada vive, `guardian_recording_*` tras la promoción). Sin entrada de cola ninguna ruta de recovery puede leerlos, y `reapEntry` borra el directorio solo tras una finalización confirmada, así que un resto es residuo post-autorización |
| Ficheros no-`guardian_*` en `documentDirectory` | Bundles del dev-launcher, cachés de expo-router, scratch |

**Staging nativo (`cacheDir/gc-segmented-recorder/<sid>/`)** queda cubierto de
forma **transitiva**, y tiene que ser así: la ruta la posee el lado Kotlin y no
es enumerable desde JS. La adopción es *COPY, VERIFY, KEEP BOTH*, de modo que un
staging adoptado tiene contrapartida en `segments/<sid>/` (comprobado), y uno no
adoptado conserva su entrada 4A en la cola (comprobado, y bloquea por cero
chunks).

### Por qué `scanOrphans()` se reutiliza pero no basta

Se importa tal cual: el prefijo `guardian_recording_`, el conjunto de
extensiones y el límite de tamaño se declaran **una sola vez**, en el módulo
cuya razón de ser es encontrarlos. La herramienta DEV **no** inventa su propio
concepto de orphan. Es un módulo hoja (solo FileSystem + AsyncStorage),
read-only por contrato: ni ciclo ni efectos.

Pero `scanOrphans()` responde a *«qué le OFREZCO al usuario para recuperar»*, y
un guard de destrucción pregunta *«hay algo aquí»*. De ahí dos ajustes:

1. **Se cuentan también las categorías que el scanner descarta** (tabla
   anterior), leídas de su propio `report`.
2. **Sonda de legibilidad independiente.** `scanOrphans()` devuelve un informe
   **todo a cero** cuando `readDirectoryAsync` falla o no hay
   `documentDirectory`. Para un banner es correcto; para un guard destructivo
   está **invertido**: un informe a cero se lee como «no hay nada que
   proteger», que es exactamente cómo un listado fallido autorizaría borrarlo
   todo. Por eso el directorio se sondea antes, y uno ilegible rechaza.

El diario de limpieza se lee reutilizando sus constantes exportadas y
`isValidJournalEntry`, respetando su propia doctrina literal: **un documento es
o completamente válido o inutilizable**. Una entrada malformada envenena el
documento entero. Y su regla de autorización tampoco se relaja: *ni la edad, ni
la ausencia de GC_QUEUE, ni un directorio vacío* cuentan jamás — solo una
autorización durable, que solo produce un 200/409 real del backend. Un
`segments/<sid>/` **vacío** sin autorización bloquea, misma forma que la regla
de cero chunks.

---

## La inspección y la destrucción no estaban serializadas (TOCTOU)

Inspeccionar bien no basta si entre el veredicto y el borrado puede empezar una
captura. `reset.ts` llevaba el contrato escrito en prosa:

> *Caller must ensure no recording is in flight.*

Un comentario no es un mecanismo de exclusión, y menos para una operación que
destruye evidencia.

### Por qué no había nada reutilizable

| Mecanismo | Ámbito | ¿Cubre el reset? | ¿Cubre al productor? |
|---|---|---|---|
| `writeChain` / `queueMutate` | módulo (`index.tsx`) | **No** — el reset usa `removeItem`/`deleteAsync` en crudo, por debajo de la cadena | Sí, pero solo por mutación, no a lo largo de un check→delete; y en audio el **recorder arranca antes** de la escritura 4A |
| `isStartingRef` | `useRef` de componente | **No** — invisible desde `src/dev/reset.ts` | solo start-vs-start |
| `hasActiveAudioRecording()` | módulo (`audioEngine`) | solo lectura | solo **después** de que el recorder ya esté vivo; ciego al vídeo segmentado nativo |
| `isDraining`, latch de ownership, `inFlightResolution` | módulo | otro asunto | otro asunto |
| `chunkerStates`, `inFlightAdoptions` | módulo | — | por sesión, **post-4A** |

De ahí `src/recording/evidenceExclusion.ts`: módulo hoja, **cero imports**, que
es justo lo que permite que dependan de él `app/index.tsx` y `src/dev/reset.ts`
sin ciclo.

### La garantía

Todo `acquire` es **síncrono**. No hay `await` entre leer el estado y
reclamarlo, así que en el hilo único de JS ninguna intercalación puede observar
un estado a medio reclamar.

```
lease vivo      ⇒ acquireProducerSlot() = null
algún slot vivo ⇒ acquireDestructiveExclusion() = null
```

**Prioridad en la colisión: gana la captura.** El destructor nunca espera, nunca
cancela, nunca expropia. Un slot filtrado falla en la dirección **segura** — el
reset se niega para siempre, que cuesta un `pm clear`; el fallo inverso cuesta
la grabación de alguien.

### La puerta

El slot se toma en el **punto de compromiso** de `startRecording`, que precede a
todo efecto irreversible **en los dos órdenes**:

```
audio / vídeo legacy      recorder primero  → 4A después
vídeo segmentado nativo   4A primero        → cámara después
```

Rechazar **ahí** no cuesta nada: no se ha escrito un byte. Es la única razón por
la que es aceptable rechazar una captura. En cualquier punto posterior, negarse
sería destruir evidencia en vez de declinar crearla.

**El lock NO se mantiene durante la grabación.** Cubre exactamente la ventana en
la que la evidencia aún no es visible para `inspectResetSafety`; pasada 4A, la
propia entrada bloquea. Lock e inspección son totales **solo juntos**.

La vida del slot es idéntica a la de `isStartingRef` y se libera en el mismo
`finally` — éxito, `return` anticipado del vídeo nativo, o excepción.

### Productores auditados

`abandonUnregisteredSession` y la recuperación de orphans **no necesitan lock**:
en ambos, en todo instante, o existe la entrada de cola o existe el fichero en
disco (la promoción mueve antes de retirar; la recuperación nunca borra el
fichero antes de encolar). El chunker y la adopción operan sobre una entrada que
ya existe. `startRecording` es el único productor de evidencia desde cero.

---

## Alcance por herramienta

| Herramienta | Qué destruye | Prueba que exige |
|---|---|---|
| `clearGuardianQueueDev` | solo referencias de cola | exclusión **+** `inspectPendingEvidence()` |
| `hardResetAppState` | `documentDirectory` + `cacheDirectory` | exclusión **+** `inspectResetSafety()` = cola **+** filesystem |

La exclusión se toma **antes** de inspeccionar en ambas. Tomarla después dejaría
el TOCTOU intacto.

**Gesto:** el long-press ya no ejecuta nada. Comprueba (global), y si hay
evidencia muestra el rechazo; si no, pide confirmación explícita. La herramienta
vuelve a comprobar al confirmar, por si el diálogo estuvo abierto mientras una
captura escribía.

**Release:** el bloque de Settings devuelve `null` fuera de `__DEV__`.

---

## Coherencia de claves tras un reset autorizado

**Se borra ahora también** `guardian.pending_session_registrations`. Un registro
pendiente solo puede apuntar a una sesión que tuvo entrada en la cola (4A la
escribe antes que nada), así que dejarlos tras borrar la cola producía
**registros fantasma**: el bucle de replay reintentando `POST /sessions` para
sesiones inexistentes. Esa era la incoherencia real.

**Se conservan, por semántica y no por pulcritud:**

| Clave | Por qué |
|---|---|
| `gc.identity.v1` | El reset no es un reset de identidad. Borrarla recrea GC-AUTH-001 |
| `gc.legacy_probe.v1` | Ídem: recrearía GC-AUTH-MIGRATION-001 |
| `gc.pause.global.v1` | Una pausa registra una condición real observada contra el backend. Borrarla **fingiría una recuperación**, que es justo lo que GC-DEST-PAUSE-001 prohíbe: solo una prueba positiva retira una pausa |
| `guardian.segment_cleanup.v1` | Cada entrada es constancia durable de una autorización **del backend** para borrar evidencia local. El runner es idempotente y retira sus propias entradas, así que una entrada obsoleta se autolimpia |
| preferencias de usuario | No son estado ni evidencia |

**El reset DEV sigue sin equivaler a un fresh install.** El fresh install
controlado se hace con `pm clear` por ADB, fuera de la aplicación. **No se ha
creado ninguna tercera superficie destructiva dentro de Guardian Cloud.**

---

## Residuales

- **El gate `__DEV__` y el diálogo de confirmación no están cubiertos por
  tests**: son rutas de render de React. Los 62 tests conducen las funciones
  destructivas, que es donde vive el rechazo — y esa colocación es
  deliberada: una pantalla no debe ser lo único que separa una herramienta DEV
  de la evidencia de alguien.
- **La puerta de `startRecording` se verifica de forma estructural**, no
  ejecutándola: vive en un componente React que la suite no renderiza. Tres
  tests leen el fuente y comprueban el orden (`acquireProducerSlot` antes del
  recorder y antes de 4A; liberación en el mismo `finally`; exclusión antes de
  inspeccionar). Reordenarla sería silencioso sin ellos. El comportamiento del
  primitivo sí se ejecuta, con barreras deterministas.
- **Si algo lanza entre el punto de compromiso y el `try` de
  `startRecording`, el slot se filtra** — exactamente la misma ventana en la
  que hoy ya se filtra `isStartingRef`. La consecuencia es que el reset se
  niega, que es la dirección segura.
- `DevQueueWipeBlock` sigue existiendo sin renderizarse. Se ha gateado en lugar
  de eliminarse, para no ampliar el alcance.
- **Bytes grabados que aún no han sido troceados ni promovidos** no aparecen ni
  en la cola ni bajo `guardian_recording_*`. La entrada 4A los cubre mientras
  existe, y la guarda «no mientras grabas» cubre la ventana de captura; pero
  una captura de vídeo cuya cola se borre externamente a mitad deja trozos en
  `chunks/<sid>/` y el mp4 en `cacheDirectory`, y ninguna ruta de recovery los
  ve. Es un hueco **preexistente** de recovery, no creado por este guard, y no
  se ha ampliado el alcance para cerrarlo.
- **`skipped_zero_size` bloquea de más**: un `guardian_recording_*` de 0 bytes
  genuino es inofensivo, pero el informe no lo distingue de un `stat` fallido.
  Se prefiere el falso positivo; se sale con `pm clear`.
- El staging nativo **no se enumera directamente** (ruta propiedad de Kotlin).
  La cobertura es transitiva y depende de que la adopción siga siendo *COPY,
  VERIFY, KEEP BOTH*. Si esa regla cambiara a un movimiento destructivo, esta
  cobertura dejaría de ser válida.

---

# 5. GC-AUTH-SESSION-RECOVERY-001 — un fallo transitorio del refresh destruía la credencial

## Estado

**OPEN.** Mitigado en tres entregas de **dos naturalezas distintas**, que no
deben confundirse: D2-B y D2-C **previenen** que la credencial se destruya; D3
**no previene nada**, da salida local a la evidencia que ya quedó varada.

```
D2-B = IMPLEMENTED / VALIDATED IN TEST BENCH   upgrade a @supabase/supabase-js 2.112.3
D2-C = IMPLEMENTED / VALIDATED IN TEST BENCH   clasificador de rate limit del refresh
D3   = IMPLEMENTED / HARDWARE FUNCTIONAL PASS  salvage local de segmentos (2026-08-24)
GC-AUTH-SESSION-RECOVERY-001 = OPEN
GC-START-LATENCY-001         = FIXED IN CODE / HARDWARE VALIDATED   (2026-08-24, §6)
```

La prevención (D2-B, D2-C) **no** se declara `HARDWARE_VALIDATED`. No se declara
cerrado ningún release blocker. **No se declara demostrada la causa histórica
del incidente del 2026-08-22.**

**D3 no cierra este finding**, ni siquiera habiendo pasado en hardware: no
recupera la identidad, no restaura ownership, no reanuda la subida y no produce
un `.mp4` final reconstruido.

---

## El incidente

2026-08-22, OnePlus A6000, sobre `e289dcb`. Un dispositivo con **87 chunks**
de evidencia sin subir perdió su sesión de Supabase: la clave
`sb-<ref>-auth-token` desapareció de AsyncStorage y `getSession()` pasó a
responder `{session: null, error: null}` —una resolución limpia, no un fallo de
red—. El marker de identidad, **correctamente**, se negó a acuñar una identidad
de reemplazo.

Con identidad anónima no existe flujo de re-autenticación. No hay pantalla de
login que ofrecer. La evidencia quedó íntegra en el dispositivo y sin poder
salir de él.

---

## Causa mecánica demostrada

`@supabase/auth-js` decide si un refresh fallido destruye la sesión con **una
sola pregunta**: `isAuthRetryableFetchError(error)`, que es
`error.name === 'AuthRetryableFetchError'` y nada más. Esa clase se construye
únicamente para un fallo sin `Response` o para un status en
`NETWORK_ERROR_CODES`. En 2.103.3 esa lista era:

```js
[502, 503, 504, 520, 521, 522, 523, 524, 530]
```

Un `429` o un `500` quedaban fuera → `AuthApiError` → `_removeSession()`, que
borra la clave entera: **access token y refresh token viven bajo una sola
clave**. El borrado es irreversible desde el dispositivo.

Un `429` dice que el servidor quiere menos peticiones. **No dice nada sobre si
la credencial es válida.**

### Banco causal — commit `9d682bc`

`mobile/tests/authSessionLossCausality.test.ts` reproduce la cadena de forma
determinista, con un `fetch` sintético en proceso de pruebas: sin tocar
Supabase, sin castigar el endpoint real, sin dispositivo. Firma observada bajo
2.103.3:

```
GC_AUTH_DEBUG    error_class 'other'  error_status 429
GC_AUTH_STORAGE  op 'removeItem'  kind 'primary_session'
                 session_loss true   refresh_present TRUE   ← la credencial estaba intacta
GC_AUTH_EVENT    event 'SIGNED_OUT'
```

`refresh_present: true` es el dato decisivo: la credencial **estaba intacta en
el instante en que se destruyó**.

> **Causa suficiente demostrada ≠ causa histórica demostrada.**
> Queda probado que un `429` o un `500` bastan para producir exactamente la
> firma terminal del 22/08. **No** queda probado que aquello fuera un `429` o
> un `500`: esa respuesta nunca se capturó —D0.1 no existía aún— y ningún
> experimento posterior puede recuperarla. La distinción no se debe borrar en
> revisiones futuras.

---

## D2-B — upgrade a 2.112.3

Dentro del rango semver ya declarado; sólo cambió el lockfile y el mínimo
declarado. Tres correcciones de upstream, **verificadas observablemente en el
banco**, no aceptadas por changelog:

| | |
|---|---|
| **Lista ampliada** | `[500, 501, 502, 503, 504, 520…530]`. Un `500` y un `525` ahora se reintentan y la sesión sobrevive |
| **proactive-preserve** | Un refresh fallido con el **access token todavía válido** ya no destruye nada. `_callRefreshToken` lee `expires_at` antes de decidir |
| **`REFRESH_FAILURE_COOLDOWN_MS`** | 60 000 ms. Caché del último fallo indexada por refresh token: las llamadas siguientes no hacen red |

### Lo que el upgrade NO cerró

**`429` con el access token ya caducado sigue destruyendo la credencial.** El
`429` no entró en `NETWORK_ERROR_CODES`, y proactive-preserve sólo salva
mientras el access token siga vivo. Ése es precisamente el estado al que llega
un dispositivo tras cualquier ventana offline prolongada.

### Hallazgo colateral, no previsto por la lectura del diff

**`401` con el access token todavía válido también preserva la sesión.**
proactive-preserve no pregunta si el rechazo fue genuino: un refresh token que
el servidor rechaza de plano sobrevive mientras el access token no caduque.
Defendible en los términos de upstream —el access token sigue funcionando—
pero significa que **«un 401 limpia» es ahora una afirmación sobre sesiones
caducadas, no una regla general**. Cualquier política que asuma limpieza
inmediata ante un `401` es incorrecta aquí.

---

## D2-C — clasificador de rate limit

`mobile/src/auth/refreshRateLimit.ts`, integrado por el único punto de
extensión que ofrece `GoTrueClientOptions`: `createClient({ global: { fetch } })`.
No existe ningún hook de reintento ni de clasificación de errores.

### La regla completa

Interviene **sólo** si se cumplen todas:

```
method                        POST
pathname                      /auth/v1/token        (comparación exacta, no substring)
searchParams.get('grant_type') === 'refresh_token'  (parseado, no substring)
status                        429
error_code                    over_request_rate_limit
```

En ese único caso **lanza**, y `_handleRequest` lo convierte en
`AuthRetryableFetchError` con **status 0** — que significa *no hubo respuesta*,
no un status HTTP inventado. El `429` real no se oculta: se registra con su
código en `GC_AUTH_RATE_LIMIT`.

### Todo lo demás: pass-through fail-closed

Devuelve la `Response` original intacta, y auth-js se comporta como si el
módulo no existiera:

```
429 sin error_code                     → pass-through → borra
429 con código desconocido             → pass-through → borra
429 con cuerpo ilegible                → pass-through → borra
429 con `code` numérico                → pass-through → borra
refresh_token_not_found                → pass-through → borra   (correcto)
refresh_token_already_used             → pass-through → borra   (correcto)
session_expired · session_not_found    → pass-through → borra   (correcto)
400 / 401 / 403                        → pass-through, sin mirar
500 / 502 / 525-529                    → ni se miran; D2-B ya los cubre
cualquier otro endpoint o método       → pass-through
excepción del propio clasificador      → pass-through
```

**«HTTP 429» por sí solo nunca preserva nada.** Preserva la combinación de
status y código explícito del servidor. Un fallo nuestro jamás se convierte en
una decisión de conservar una credencial.

### Lo que D2-C NO contiene, deliberadamente

**Ni retry, ni contador, ni presupuesto, ni `setTimeout`, ni sleep, ni jitter,
ni espera por `Retry-After`, ni estado persistente, ni copia en la sombra de
ningún token.**

El motivo es aritmético, no estético: auth-js invoca el wrapper **una vez por
intento** de su propio bucle `retryable`, así que cualquier espera añadida aquí
se multiplica por el número de intentos. Respetar `Retry-After` con 5 s de
sueño añadiría hasta 40 s a un camino que `startRecording` espera. El backoff
exponencial que espacia esos intentos ya existe, ya está acotado a 30 s, y ya
va seguido de un cooldown de 60 s.

Coste de D2-C sobre `startRecording`: **0 ms de sleep/backoff intencional.** No
es computacionalmente gratis —en la ruta clasificada ejecuta un
`Response.clone().json()` y una línea de log—, y la distinción se mantiene en
vez de redondearla a «coste cero».

---

## Cotas del `429` persistente

Constantes leídas del código, no supuestas: `sleep(200 · 2^(intento−1))`,
reintento mientras `transcurrido + 200 · 2^intento < 30 000`.

```
peticiones HTTP reales      8
reintentos de auth-js       7
tiempo total del episodio   25 400 ms   (backoff de auth-js, no nuestro)
tiempo añadido por D2-C     0 ms de sleep intencional
durante el cooldown (60 s)  0 peticiones
régimen estacionario        8 peticiones / 85,4 s ≈ 5,6 por minuto
```

Es la misma forma de tráfico que un `502` ya producía antes de D2-C.

---

## Lo demostrado en banco

43 pruebas en `authSessionLossCausality.test.ts`. Recuperación completa, con
reloj controlado:

```
sesión válida, access token caducado
→ 429 over_request_rate_limit persistente
→ 8 peticiones acotadas · 0 removeItem · refresh token preservado
→ durante el cooldown: 0 peticiones
→ el cooldown expira
→ nuevo refresh, 200
→ setItem, nunca removeItem
→ MISMO user.id (uuid completo, no prefijo)
→ refresh token rotado
→ SIGNED_OUT = 0
```

Con teeth check en ambas direcciones: sin avanzar el reloj el baseline no
recibe ninguna petición, y sin el clasificador el mismo `429` vuelve a
destruir la credencial.

---

## D3 — `LOCAL SEGMENT SALVAGE`

Implementado en `cb59c7e`. **`HARDWARE FUNCTIONAL PASS` el 2026-08-24.**

### El hueco que cubre, que es más estrecho de lo que parece

Un dispositivo cuya sesión de Supabase fue destruida no puede subir —la pausa
`client_auth` exige `access_token` real— ni exportar —`src/api/export.ts` es una
ruta de **descarga** y también necesita token—.

**Audio y legacy ya tenían salida local**: su entrada de cola lleva
`uri: cacheUri` y `findLocalRecordingUri` la sirve desde la pantalla de sesión.
**Vídeo nativo segmentado no la tenía**: escribe `uri: ''`, esa búsqueda devuelve
`null` y la captura quedaba sin ninguna salida. Ése es el hueco exacto, y el
único, que D3 cubre.

### Qué produce y qué NO produce

Copia los **segmentos MP4 originales** del sandbox a una carpeta que elige el
usuario por Storage Access Framework, con nombres de seis dígitos y un manifest
que se relee y valida antes de acreditar nada:

```
segment_000000.mp4 … segment_NNNNNN.mp4
guardian-export-manifest.json          escrito AL FINAL
```

Cada segmento es un contenedor MP4 independiente y reproducible. **No se
concatenan**: unir contenedores MP4 byte a byte no produce un MP4 válido.

```
NO recupera la identidad
NO reanuda ownership ni subida
NO es el export final .mp4  (sigue NO IMPLEMENTADO)
NO produce «vídeo reconstruido», «MP4 final» ni «grabación completa»
```

### Qué se NIEGA a exportar — restricción publicada en `fc9a20e`

Esto **no amplía** lo que D3 hace: acota lo que acepta. Antes de `fc9a20e`, D3
decidía la elegibilidad **por entrada** —`uri === ''` probaba que la sesión venía
del vídeo nativo segmentado— y escribía como segmento **cualquier** chunk con
`local_uri`. Eso era suficiente sólo mientras cada sesión tuviera un único medio.
Desde `fc9a20e` la elegibilidad se decide **por chunk**:

```
video  + firma estructural válida    → puede continuar
video  + firma inválida              → RECHAZA
audio  (uno solo basta)              → RECHAZA
valor de `media` desconocido         → RECHAZA
unos chunks con `media`, otros sin    → RECHAZA
ninguno con `media` + TODAS las firmas válidas   → continúa (entradas legacy)
ninguno con `media` + cualquier firma inválida   → RECHAZA
```

Un chunk que vaya a tratarse como segmento nativo debe corresponder **exactamente**
a `segments/<session_id>/segment_NNNNNN.mp4`: directorio `segments`, el
`session_id` literal de la sesión que se exporta, y nombre `segment_` más seis
dígitos y `.mp4`. No es coincidencia textual —rechaza travesía, separadores
duplicados, otra sesión, nombres parciales o temporales— y **se exige tanto a los
chunks con `media: 'video'` como a los que no la llevan**.

```
★ `media: 'video'` por sí solo NO basta.
```

La razón es concreta: el vídeo **legacy** post-stop escribe `media: 'video'` sobre
fragmentos base64 alojados en `chunks/<sid>/N.b64`, que no son segmentos. Sin la
firma, esos bytes se habrían copiado como `segment_NNNNNN.mp4` y el manifest los
habría acreditado por `sha256`. Verificados, y falsos.

**La ausencia de `media` significa «metadata no disponible», nunca «vídeo».** Las
entradas escritas antes de `fc9a20e` no llevan la clave, y sólo continúan porque
cada uno de sus chunks acredita la firma nativa — nunca por deducirlo de la
entrada.

> **D3 no soporta ni exporta sesiones mixtas: las rechaza.** Esta restricción es
> una precondición de integridad, no una capacidad nueva. Cuando una Protection
> Session pueda contener vídeo y audio, D3 necesitará su propio gate; hasta
> entonces prefiere no exportar nada antes que exportar bytes con un tipo falso.

### La validación en hardware

OnePlus A6000 · Android 11 / API 30 · `arm64-v8a` · APK release
`8151c338…` desde `cb59c7e`.

Precondición construida a propósito: captura de vídeo nativo segmentado con el
dispositivo en **modo avión**, sin ruta por defecto y con DNS fallando para
backend y para Drive.

```
productor         vídeo nativo segmentado · rotación 6 s
outcome           closed
segments_observed 12 · índices 0–11 contiguos · next_chunk_index 12
remote_reference  0        uploaded  0

D3   status = complete · written = 12 · manifest = true
     12/12 segmentos exportados
     tamaños y sha256 coincidentes: manifest == bytes en dispositivo == copia
     manifest JSON válido, export_completed = true
     MP4 independientes decodificables (ffprobe + decodificación completa)
```

Invariantes verificados durante y después de la ejecución:

```
D3 no produjo tráfico propio        las únicas llamadas en su ventana fueron
                                    reintentos del worker, con su cadencia de
                                    ~5,05 s inalterada
D3 no mutó GC_QUEUE                 la cola siguió en pending 12 · entries 1
D3 no ejecutó cleanup               cero eventos sobre la sesión bajo prueba
D3 no borró ni modificó las fuentes el worker seguía leyendo el chunk 0 con
                                    size 200040 cinco minutos después
```

Evidencia congelada fuera del repositorio, con `26/26` hashes verificados y
barrido de secretos limpio:
`2026-08-24-d3-local-segment-salvage-hardware/PROVENANCE.md`.

### `POST-SALVAGE NETWORK RECOVERY` — segundo gate, independiente

**`PASS` el 2026-08-24.** Es un gate **distinto** del anterior y no debe fundirse
con él: aquél probó que el salvage funciona; éste prueba que **no estorba**.

Continuación de la misma corrida, misma sesión
(`14363043-307e-49c6-815d-90fbb142ade4`), mismo APK `8151c338…`, mismo proceso
sin reiniciar. Tras el export local se restauró la conectividad y se observó la
convergencia normal:

```
D3 export local complete
→ los 12 chunks originales siguen pendientes en la cola
→ vuelve la conectividad
→ se registra el MISMO localSessionId          1 POST /sessions efectivo
→ 12/12 chunks confirmados, índices 0–11
→ 12 remote_reference únicas                   mapa 1↔1
→ missingUploadedIndexes = []
→ /complete DESPUÉS del 12/12
→ GC_CLEANUP_AUTHORIZED con http_200
→ cleanup local DESPUÉS de la autorización
→ GC_QUEUE queda sin la sesión                 entries 0 · pending 0
→ el export SAF permanece intacto              13/13 por sha256
```

Sin índices nuevos, sin chunks duplicados, sin `uploaded` falsos, sin una
segunda sesión remota y sin `hash mismatch`.

**Lo que autoriza a afirmar:**

> **D3 es aditivo**: el salvage local no impide el registro, la subida, la
> completion ni el cleanup normales posteriores de la misma sesión cuando
> vuelve la conectividad.

Consecuencia forense, y no menor: tras converger **coexisten las dos copias**
—la evidencia remota subida con normalidad y el export SAF independiente del
usuario—. El cleanup eliminó las fuentes correspondientes del sandbox **sin
tocar** el export SAF, que es almacenamiento distinto y queda fuera del alcance
del journal de limpieza.

**Lo que NO autoriza a afirmar.** Esta corrida **no reproduce el escenario del
finding**: la credencial nunca se destruyó, así que lo que convergió fue una
sesión offline con token caducado, no una sesión huérfana de identidad.
`GC-AUTH-SESSION-RECOVERY-001` sigue `OPEN` y su escenario sigue sin
demostrarse recuperable.

Paquete independiente, `8/8` hashes verificados y barrido de secretos limpio:
`2026-08-24-d3-post-salvage-network-recovery-hardware/PROVENANCE.md`. El paquete
anterior **no se modificó**; sus `26/26` hashes siguen intactos.

> **`INCIDENTAL HARDWARE EVIDENCE` — `NOT A DIRECTED D2-B/D2-C VALIDATION`.**
> Durante el tramo, la credencial sobrevivió ~52 min de fallo de refresh
> (37 fallos clasificados `retryable_network`; `SIGNED_OUT`, `removeItem`,
> `_removeSession` y `GC_ANON_SIGNIN` todos a cero) y la pausa `client_auth` se
> retiró sola al volver la red. **Esto no asciende ningún estado**: la corrida
> ejercitó un fallo de red, no los casos dirigidos de D2-B (`500` / `502` /
> `525-529`) ni el de D2-C (`429 over_request_rate_limit`). D2-B y D2-C siguen
> **validados en banco, con hardware dirigido pendiente**.

### `GC-SEGMENT-CONTINUITY-001` — observación temporal abierta

```
GC-SEGMENT-CONTINUITY-001 = OBSERVATION / INVESTIGATION OPEN
```

**No es un defecto confirmado. No es un release blocker.** El identificador
existe para que la observación sea rastreable, no para afirmar que haya algo
roto.

Hecho observado, en la corrida de D3 del 2026-08-24:

```
capture_ms del grabador                72,551 s
suma ffprobe de los 12 segmentos       66,765 s
diferencia                              5,786 s
```

Eso es todo lo que se afirma: dos magnitudes medidas y su resta. **No se
atribuye causa.** No se afirma pérdida de evidencia. No se afirma que la
rotación de segmentos sea responsable. No se ha modificado código ni tests por
esta observación.

Lo que sí está establecido, y acota el alcance de la investigación: los 12
índices son contiguos desde 0 (`observed_contiguous_from_zero: true`), los bytes
exportados son idénticos a los que el grabador produjo, y **D3 no interviene**
—copia los ficheros que existen y no puede inventar tiempo de reloj que el
grabador no capturó—.

Investigar exigirá su propio escenario reproducible y su propia
instrumentación; hasta entonces este documento no va más allá de las tres
cifras de arriba.

---

## Lo que sigue abierto

- **Validación DIRIGIDA en hardware de la prevención.** El banco prueba la
  mecánica de `auth-js` y de nuestro clasificador; no prueba el comportamiento
  del producto bajo estrés real. El 24/08, de forma **incidental**, el
  clasificador sí corrió en dispositivo —37 fallos de refresh, todos
  `retryable_network`, sin destruir la credencial—, pero eso fue un fallo de
  **red**: no reproduce los casos que corrige D2-B (`500` / `502` / `525-529`)
  ni el que corrige D2-C (`429 over_request_rate_limit`). Sigue faltando la
  corrida dirigida por código de estado. Los dos gates de D3 del 24/08 son de
  supervivencia y de no-interferencia, y **no acreditan nada sobre la
  prevención**.
- **D3 no sube nada.** Saca los bytes del sandbox; no los pone en la nube. Que
  la sesión de la corrida del 24/08 acabara convergiendo **no lo hizo D3**: lo
  hizo el pipeline normal cuando volvió la red, con la credencial intacta. En el
  escenario propio de este finding —identidad destruida— la subida **sigue sin
  reanudarse**, y eso es justo lo que sigue abierto.
- **`GC-START-LATENCY-001`** — **cerrado el 2026-08-24**, ver §6. Cuando se
  escribió esta línea el camino de `auth-js` podía consumir **~25,4 s de
  backoff** y `startRecording` esperaba a `getOwnershipAccessToken()`. Esa
  exposición **la introdujo D2-B** al hacer reintentable el `500`; D2-C no la
  agravó ni la corrigió. Lo que la cerró fue sacar esa espera del camino
  crítico, no acelerar `auth-js`: **el backoff sigue existiendo y sigue
  tardando** — en hardware se midieron 25,76 s — pero ya no retiene al
  productor.
- **Rate limit sostenido.** El dispositivo conservaría la credencial sin poder
  usarla. Es evidencia preservada, no recuperación.
- **La causa histórica del 22/08 sigue sin demostrar**, y ninguna prueba futura
  puede demostrarla.

---

## Lo que NO hay que volver a intentar

- **No reclasificar por status a secas.** GoTrue ya distingue semánticamente
  `over_request_rate_limit` de `refresh_token_not_found`; el status HTTP no.
- **No reescribir el `429` como `503`.** Falsea el status observado y convierte
  1 petición en 8 contra un endpoint que acaba de pedir menos tráfico.
- **No guardar una copia en la sombra del refresh token.** Duplica una
  credencial en una segunda clave, exige bendición de `SECURITY.md`, y con un
  token realmente revocado entra en bucle restaurar → 401 → borrar → restaurar.
- **No vetar el borrado desde el adaptador de storage.** `_removeSession` limpia
  `lastRefreshFailure` **antes** de tocar storage, así que el veto desactivaría
  el cooldown de 60 s que es justo la protección anti-storm que trajo D2-B.

---

# 6. GC-START-LATENCY-001 — el arranque de la captura esperaba a la red

## Estado

**FIXED IN CODE / HARDWARE VALIDATED.**

Corregido en `e643b01`; guardas de test alineadas en `3c10994`. Validado en
hardware el **2026-08-24** sobre OnePlus A6000 / Android 11, en dos escenarios
independientes, con APK release
`1cb80feae1e7991b08d3293e5172423c5e4c5e712ded3157213f34a2f7da06a9` construido
desde producto puro.

---

## El defecto

`startRecording` hacía `await getOwnershipAccessToken()` **antes** de abrir la
grabadora. Esa llamada pasa por `supabase.auth.getSession()`, que renueva por
red en cuanto el access token ha caducado, y **nada en ese camino lleva
timeout**: ni `auth-js`, ni el wrapper de fetch. El cliente de nuestro propio
backend sí lo tiene —10 s por defecto en `src/api/client.ts`—, y esa asimetría
era el defecto.

Con el remoto inalcanzable, el usuario pulsaba GRABAR y no se capturaba nada
mientras la petición seguía viva. Invierte la promesa del producto: el backend
es a dónde **va** la evidencia, no el permiso para recogerla.

> El valor esperado nunca hizo falta ahí. Sus únicos consumidores viven dentro
> de `sessionCreatePromise`, que deliberadamente **no** se espera antes del
> productor.

---

## La corrección

Mover esa lectura al interior de `sessionCreatePromise`. Nada más: la misma
llamada, el mismo log, la misma rama `!token` hacia
`schedulePendingSessionRegistration`. R5 no se toca — el gate de ownership
protege el `POST /sessions`, no la captura, y sigue delante del POST.

---

## Evidencia en hardware — 2026-08-24

### H2 · remoto vivo

```
tap → productor vivo      531 ms
  − SO / permisos         130 ms   (automático, sin diálogo humano)
  − hardware              238 ms   (abrir la grabadora)
  = lógica Guardian Cloud 163 ms

28 de 29 fragmentos confirmados remotamente ANTES de pulsar PARAR
primer remote_reference 104 s antes del cierre
```

**El fix no compró velocidad de arranque a costa de la subida durante la
grabación.** Ésa era la forma de fallo que habría invalidado el cambio aunque
el arranque fuera instantáneo.

### H1 · token caducado + modo avión

```
tap → productor vivo      243 ms
  − SO / permisos          79 ms
  − hardware               62 ms
  = lógica Guardian Cloud 102 ms

auth resolvió (a null)    10,72 s DESPUÉS de que el productor ya grababa
```

Condiciones reales, sin fabricar nada: el token caducó **solo**, con el
dispositivo ya en modo avión; ni se tocó el reloj, ni el almacenamiento, ni la
sesión. El refresh proactivo falló a los 25,76 s con `AuthRetryableFetchError`
—lo que confirma en hardware el techo de backoff de `auth-js`— y la sesión
sobrevivió: `removeItem` 0, `SIGNED_OUT` 0, `GC_ANON_SIGNIN` 0.

> **Redacción que importa: auth no se volvió rápida.** Siguió tardando 10,72 s
> en resolver, y su backoff sigue midiendo decenas de segundos. Lo que cambió
> es que **dejó de bloquear el arranque**. Cualquier lectura futura que
> convierta esto en «auth ahora es rápida» es falsa.

### Recuperación tras restaurar la red

```
mismo localSessionId      eb6c456b-7156-48e2-b232-79795d6e9c5f
POST /sessions            1        (una sola sesión remota)
chunks confirmados        77 / 77
remote_reference          77 únicas
completion gate           77 / 77 · missingUploadedIndexes []
cleanup                   posterior a la autorización http_200
identidad                 08c0875e, estable en toda la corrida
```

Once segundos desde que vuelve la red hasta que hay token; 37 ms más hasta
retirar la pausa `client_auth: NO_TOKEN`. Un `404` en el primer fragmento
—salió 83 ms antes de que existiera la fila remota— se clasificó **transitorio**
y se reintentó con éxito: es el comportamiento diseñado, no un defecto.

---

## Durabilidad de la cola: las dos ramas NO son iguales

Esto se documenta aquí porque el primer intento de proteger la corrección con
tests impuso a audio una propiedad que sólo es cierta en vídeo.

```
native segmented video    GC_QUEUE durable  →  productor

audio / legacy            productor (es lo que produce el cacheUri)
                          →  GC_QUEUE durable
                          →  primer chunk
```

Audio **no puede** escribir la entrada primero: la entrada lleva `cacheUri`, y
esa ruta no existe hasta que la grabadora ha abierto el fichero. La propiedad
que protege la evidencia en esa rama no es «durable antes del productor» sino
**«durable antes de que exista ningún fragmento»**. Medida dos veces ese día:
5,04 s de margen con el remoto vivo, 12,28 s con el remoto inalcanzable. La
ventana productor→persistencia fue de 13 ms y 9 ms respectivamente, con cero
bytes producidos.

No generalizar una rama a la otra. `devResetGuard.test.ts` ya lo decía —«audio
y vídeo legacy abren la grabadora primero; el vídeo segmentado nativo escribe
4A primero»— y `startLatencyDecoupling.test.ts` lo protege desde `3c10994` con
aserciones acotadas por rama.

---

## Residuales

- **La ruta de auth de Supabase sigue sin timeout.** Este finding la sacó del
  camino crítico del arranque; **no la acotó**. Cualquier otro llamante —el
  drain, por ejemplo— sigue expuesto a una petición que sólo la plataforma
  decide cuándo abandonar. Es un defecto por derecho propio y no se cierra
  aquí.
- **La cifra «~4 min 30 s» del 22/08 nunca se reprodujo ni se explicó.** No hay
  ninguna constante en el código que la produzca: el bucle de reintentos de
  `auth-js` está acotado a 30 s. Lo que quedó demostrado es la clase de fallo,
  no aquella duración concreta, cuya medición nunca se capturó.
- **Sin `run-as`**: el APK es release y no `debuggable`, así que no se leyó
  ningún estado privado posterior a la corrida. El veredicto se apoya en
  logcat, en las respuestas del backend y en la baseline preservada.
- **Un solo dispositivo.** OnePlus A6000 / Android 11 / API 30. No implica
  cobertura multi-dispositivo ni Android 13+.

---

## `GC-QUEUE-PARSE-WIPE-001` — un JSON ilegible sustituye la cola por un array vacío

**Estado: `FIXED IN CODE / AUTOMATED TESTS`.** Corregido en
`eb8634045d8da8fe219120ec671ca12c8f54e1f6`. Descubierto por lectura estática
durante el preflight de G1 (2026-08-25).

> **NO está `CLOSED`.** La validación en hardware sigue **pendiente**: el
> defecto nació de lectura estática y su activación no se ha observado nunca en
> dispositivo, ni antes ni después de la corrección.

### Ruta exacta — comportamiento HISTÓRICO, ya corregido

`mobile/app/index.tsx`, dentro de `queueMutate`:

```
try  { const parsed: unknown = JSON.parse(raw); … }
catch { queue = []; }
```

seguido, en el mismo cuerpo y sin condición intermedia, de:

```
await AsyncStorage.setItem(PENDING_RETRY_KEY, JSON.stringify(queue));
```

### Condición de activación

El valor almacenado bajo la clave de la cola no es JSON parseable en el momento
de una invocación de `queueMutate`.

### Consecuencia

La cola en memoria pasa a ser un array vacío y ese array vacío **se persiste**,
reemplazando el valor anterior. Toda entrada que contuviera —incluidas sesiones
con chunks aún no confirmados fuera del dispositivo— deja de estar referenciada
por la fuente de verdad.

### Invariante afectado

`cola persistente` y `GC_QUEUE como fuente de verdad`, y por dependencia
`recovery automático`.

### La asimetría que lo hace visible

La rama vecina —fallo de `getItem`, unas líneas antes— **re-lanza
deliberadamente**, con un comentario que documenta que una versión anterior
borraba la cola ahí y que eso destruía evidencia a mitad de emisión. La rama de
`parse` nunca recibió el mismo tratamiento.

### Grado de certeza

**Lectura estática del código.** No se ha observado la activación en ningún
dispositivo, no se ha reproducido, y **no se afirma probabilidad, frecuencia ni
impacto real**. Lo verificado es la estructura del código, no que haya ocurrido.

### Corrección

Se decidió **aislar**: preservar los bytes ilegibles antes de reiniciar la cola,
nunca sobrescribirlos. `queueMutate` sólo alcanza `queue = []` tras una
preservación **nueva y verificada**, o tras reconocer exactamente los mismos
bytes ya preservados. Tres ramas:

```
salvage vacío      preservar literal en gc.queue.salvage.v1 · releer ·
                   comparar · sólo entonces continuar
existing === raw   ya acreditado en un intento anterior cuyo callback o
                   persistencia final no completó → transición idempotente,
                   SIN reescribir la ranura
existing !== raw   corrupción distinta con la ranura ocupada → fail closed:
                   ni se sobrescribe el salvage ni se toca PENDING_RETRY_KEY
```

Si la escritura del salvage o su relectura fallan, se re-lanza y
`PENDING_RETRY_KEY` queda intacto — la misma postura de fallo cerrado que la
rama vecina de `getItem` ya practicaba ante `CursorWindow`.

**`gc.queue.salvage.v1` no es una cola ni una segunda fuente de verdad.**
Worker, retry y recovery no la consumen; una prueba de fuente lo verifica
barriendo `mobile/src` y `mobile/app`. `GC_QUEUE` sigue siendo la única fuente
operativa del trabajo pendiente.

Evidencia, en su nivel exacto y sin ascender: **44/44** pruebas focalizadas de
`queue.test.ts`, **958/958** en la suite móvil (43 ficheros) y typecheck en
**12** errores heredados, sin drift. Son dimensiones de *implementación* y
*pruebas automáticas*; ninguna acredita validación.

### Lo que sigue abierto

1. **Nada vacía la ranura.** No existe mecanismo normal que limpie
   `gc.queue.salvage.v1` tras una corrupción preservada.
2. **Una corrupción con bytes distintos y la ranura ocupada falla cerrado**, y
   bloquea las mutaciones de cola hasta que alguien intervenga. Es el coste
   aceptado de la política de ranura única.
3. **El DEV reset no limpia la clave** — `mobile/src/dev/reset.ts` no la conoce.
   Deuda de tooling, no de producto.
4. **El salvage preserva, no recupera.** Saca los bytes del camino de
   destrucción; no los reinyecta en la cola ni los sube.
5. **Sin validación en hardware.**

---

# 7. GC-MANIFEST-BESTEFFORT-001 — el fallo del manifiesto no llega al cliente

## Estado

**OPEN.** Sin corregir. Sin decisión de release.

## Hecho demostrado

La generación del manifiesto es *best-effort* por contrato explícito
(`backend/src/services/manifest.service.ts:9-11`): su fallo **no** impide
`/complete`, **no** altera la respuesta al cliente y sólo deja un `warn` en el
log del servidor.

Ensayado en hardware el 2026-08-27 —
[`VALIDATIONS/GC_MANIFEST_BESTEFFORT_ARMB_2026-08-27.md`](./VALIDATIONS/GC_MANIFEST_BESTEFFORT_ARMB_2026-08-27.md):
una sesión con 635 chunks subidos y registrados de forma continua (0..634)
completó con `200`, sin señal alguna al cliente, mientras el manifiesto
superviviente representaba únicamente 630 (0..629). Los chunks 630..634 están
subidos y registrados, y quedan fuera de ese manifiesto.

## Grado de certeza

El fallo del manifiesto final se **indujo** mediante instrumentación temporal
acotada a esa sesión, retirada y verificada después. Lo demostrado es la
**consecuencia**; **no** se ha demostrado con qué frecuencia un fallo real de
Drive la produciría.

**No se ha validado** el caso sin ningún manifiesto —chunks remotos existentes
y sesión no descubrible—. Ese escenario está definido como `Caso 8` en
[`TEST_SCENARIOS.md`](./TEST_SCENARIOS.md) con estado `DEFINIDO — NO VALIDADO`.

## Impacto

Afecta al descubrimiento cross-device: una sesión completa puede representarse
como parcial. En ARMA B los bytes no se perdieron: los chunks 630..634
permanecieron en Drive y registrados en la base de datos. Esto no demuestra el
resultado de otros modos de fallo. **No se asigna severidad ni carácter
release-blocking**: no hay ensayo que lo sustente.

## Por qué sigue abierto

Su remediación exige decidir qué debe ocurrir cuando la escritura del
manifiesto falla, y eso es una decisión de producto con su propio criterio de
validación. Requiere gate propio.

---

# 8. GC-OAUTH-SCHEME-COLLISION-001 — el scheme del deep link no es exclusivo

## Estado

**OPEN.** Sin corregir.

## Hecho demostrado

`mobile/app.config.ts:61` declara `scheme: 'guardiancloud'` mientras `:72`
declara `package: 'com.guariacloud.app'`. El scheme **no** se renombró al
cambiar el identificador de aplicación, de modo que cualquier aplicación
instalada que registre `guardiancloud://` compite por el deep link con el que
el backend entrega el `code` de Google
(`backend/src/routes/destinations.routes.ts:1113-1117`).

Es un hecho de código, verificable hoy en ambos ficheros.

## Grado de certeza

Durante el gate de `G3''` (2026-08-26) se observó que, con dos aplicaciones
instaladas registrando el mismo scheme, el deep link se entregó a la aplicación
antigua y el intercambio se completó bajo una identidad distinta de la que
inició el flujo. **Esa observación no tiene artefacto congelado**: el logcat de
`G3''` está filtrado por el PID de la aplicación nueva y el log del backend por
`session_id`, de modo que ninguno la contiene.

**No se ha ensayado** que una aplicación de terceros pueda capturar el `code`
en un dispositivo de usuario final. **No se asigna severidad ni carácter
release-blocking.**

## Impacto

En la observación de `G3''`, la aplicación que inició la conexión quedó sin ese
destino Drive. Si no existe otro destino operativo, esto puede impedir que la
evidencia salga del dispositivo por esa ruta — afectando al invariante §1 de
[`PRODUCT_PRINCIPLES`](./PRODUCT_PRINCIPLES.md). El alcance de ese impacto
fuera del escenario de dos aplicaciones propias no está caracterizado.

## Relación con GC-OAUTH-NOSTATE-001

Son findings **independientes**, con causas distintas y vectores opuestos: aquí
el `code` de quien inicia el flujo puede llegar a otra aplicación; en §9 un
`code` ajeno puede llegar a esta aplicación. **Pueden amplificarse mutuamente.**
Una correlación de respuestas —§9— podría mitigar parte del impacto de esta
colisión, pero **no la elimina**: no impide que el sistema operativo entregue el
deep link a otra aplicación. Cualquier afirmación sobre mitigación conjunta
requiere diseño y validación propios.

---

# 9. GC-OAUTH-NOSTATE-001 — el flujo OAuth no correlaciona la respuesta

## Estado

**OPEN.** Sin corregir.

## Hecho demostrado

Trazado completo del flujo, verificable en el código actual:

```
mobile/app/settings.tsx:382          startDriveConnect(redirectUri)  — sin `state`
backend/src/routes/destinations.routes.ts:293
                                     buildAuthUrl(input.state, …)    — undefined
backend/src/services/drive.service.ts:106
                                     if (state) params.set('state', …) — no se pone
backend/src/routes/destinations.routes.ts:1088-1117
                                     el callback reenvía el `code` al deep link
                                     y NO valida `state`
rama `exchange` de /destinations/drive/connect
                                     NUNCA lee `input.state`
backend/src/schemas/destinations.schema.ts:31
                                     state: z.string().max(128).optional()
tests que cubran `state` en este flujo:  ninguno
```

El gate de `G3''` observó `hasState: false` en el log del callback, que es el
comportamiento esperado de este código, no una anomalía.

`mobile/app/oauth/drive.tsx:117` reenvía un `state` si lo recibe, pero el
backend lo ignora: la tubería existe y está inerte.

La autenticación del flujo ocurre en el intercambio, bajo `authMiddleware`, y
ancla el destino a `req.user.id`
(`backend/src/routes/destinations.routes.ts:283-289`).

## Grado de certeza

Todo lo anterior es **lectura del código y observación de log**. Lo que sigue
**no** lo es.

**Riesgo inferido, no validado.** Sin correlación entre la respuesta y la
petición que la originó, un `code` no correlacionado podría ser aceptado por el
cliente. Eso abre la posibilidad de un CSRF de OAuth o de una sustitución del
destino. **No se ha ensayado**, **no se ha reproducido** y **no se ha
demostrado** que el Drive de un tercero pueda quedar vinculado a la cuenta de
una víctima. **No se asigna severidad ni carácter release-blocking.**
Comprobarlo requiere un ensayo controlado con su propio gate.

## Discrepancia documental asociada

[`API_SPEC.md`](./API_SPEC.md) afirma que «la autenticación viaja en el `state`
del flujo OAuth». Esa descripción es falsa respecto a la implementación:
`state` ni siquiera se genera. Su corrección tiene gate propio.

## Relación con GC-OAUTH-SCHEME-COLLISION-001

Ver §8. Findings independientes, causas distintas, mitigaciones
potencialmente relacionadas pero **no demostradas como suficientes**.
