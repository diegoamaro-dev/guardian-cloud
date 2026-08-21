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
