# E2 — Aislamiento del proyecto Supabase y del entorno · registro

## Identidad del gate

| | |
|---|---|
| **Gate** | `E2-A` · `E2-B` · `E2 JWT CROSS-PROJECT` |
| **Fecha** | **2026-10-03** (E2-A y E2-B). Los cruces de JWT se ejecutaron al final de la misma sesión continua, con el reloj del PC ya en **2026-10-04**; no se registró marca de tiempo propia de esas peticiones |
| **Resultado** | E2-A `PASS` · E2-B `NO COMPLETADA` · P1 `PASS` · N1 `PASS` · N2 `NOT EXECUTED` |
| **Artefacto** | APK de banco `402e9b85…`, el instalado en el OnePlus A6000 |

> **Qué NO es este registro.** No es una validación en hardware: E2 no ejercita
> captura, cola, subida, recovery ni export, y los cruces de JWT son una prueba
> de frontera **entre servicios**, no de dispositivo. Tampoco acredita
> aislamiento **bidireccional**: un sentido quedó sin ejecutar.

---

## E2-A · configuración efectiva del artefacto instalado — `PASS`

Verificado que el artefacto inspeccionado es el que está en el dispositivo,
antes de inspeccionarlo:

```
base.apk instalado   /data/app/~~SvVrmAZqTTaYTfkvecRIIA==/com.guariacloud.app.bench-…/base.apk
sha256 en dispositivo    402e9b85f5ab12b9e99ba22d3a01afbafda46210c1cb037888c1a9fcc0a927cf
sha256 esperado          402e9b85f5ab12b9e99ba22d3a01afbafda46210c1cb037888c1a9fcc0a927cf
sha256 copia inspeccionada  idéntico  ⇒ inspeccionar la copia es inspeccionar lo instalado
```

**`assets/app.config` embebido** (1.569 bytes, JSON):

```
name     Guardian Cloud BANCO
scheme   guardiancloudbench
package  com.guariacloud.app.bench
version  0.1.0
```

Esto es además **prueba por construcción del entorno efectivo**: los tres
valores los produce `resolveBuildVariant()`, que rehúsa cualquier literal que no
sea `production` o `bench` y sólo devuelve esa terna para `'bench'`.

**`assets/index.android.bundle`** (2.298.536 bytes):

```
URLs Supabase configuradas        1x  https://rgbsofvycynhabycetel.supabase.co
cualquier otra URL Supabase       ninguna
API configurada                   http://192.168.178.21:3101
literal 'nahksdkcvhveoctpjrea'    1 ocurrencia
  …en forma de URL Supabase       0 ocurrencias
literal 'rgbsofvycynhabycetel'    1 ocurrencia
  …en forma de URL Supabase       1 ocurrencia
```

**El ref de producción aparece en el bundle únicamente como constante de la
tabla de guarda de `projectRefs.ts`, nunca como URL Supabase configurada.** Esa
distinción es el núcleo de E2-A: un recuento ingenuo del literal «encuentra
producción» y concluye lo contrario de la verdad.

> **Nota de método, por si alguien repite esta prueba.** El bundle es **bytecode
> de Hermes** —magic `c6 1f bc 03 c1 03 19 1f`—, no texto JS: las cadenas viven
> en una tabla **concatenada y sin delimitadores**. Una expresión codiciosa
> `:\d+` sobre la API leyó `:31017`, que **no existe**: era `:3101` seguido de la
> cadena siguiente, que empieza por `7`. El contexto lo resolvió:
> `…AccessibilityInfo │ ntWeight │ http://192.168.178.21:3101 │ 7bc6ba3f… │ Failed to e…`.
> Sin esa comprobación se habría reportado una errata de puerto inexistente.

Ningún secreto impreso: las búsquedas fueron por forma y todo contexto pasó por
un filtro que depura cadenas tipo `eyJ…`.

---

## E2-B · configuración del proceso en ejecución — **NO COMPLETADA**

**No se obtuvo**, y la razón no es un defecto del producto:

```
proceso de banco      VIVO y preexistente (mismo pid antes y después de relanzar)
env.ts                emite GC_ENV / ENV READY UNA VEZ por proceso, al primer import
logcat -c + relanzar  no reinicia el proceso ⇒ no hay nada nuevo que leer
canal de logs         funciona: 790 líneas con tag ReactNativeJS del propio proceso
```

Para observarlo haría falta un proceso nuevo, y el único camino era
`force-stop`. **Se rechazó deliberadamente**, dos veces y por motivos distintos:

```
ServiceRecord{…/RNBackgroundActionsTask}  isForeground=true  foregroundId=92901
NotificationRecord  id=92901  (ACTIVA, no un canal registrado)
'GC_BACKGROUND_STATE_CHANGE', { next: 'active', recording: false }
líneas con  recording: true  →  0
```

**No hay grabación activa** —observado— pero **sí un servicio en primer plano
vivo**, y matar el proceso que lo sostiene no es un precio aceptable por leer
tres líneas de configuración.

### `GC_QUEUE` — contenido NO OBSERVADO

No existe canal de lectura:

```
run-as com.guariacloud.app.bench …    "package not debuggable"
ls /data/data/com.guariacloud.app.bench   "Permission denied"
pkgFlags del instalado                [ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]  sin DEBUGGABLE
```

Queda `ALLOW_BACKUP`, descartado: `adb backup` exige confirmación en pantalla y
extraería los datos **en bloque**, incluida la sesión de Supabase que vive en
AsyncStorage. Sacar credenciales del dispositivo para contar entradas de una cola
es desproporcionado.

```
¿GC_QUEUE existe?             NO DETERMINABLE read-only
¿tiene entradas pendientes?   NO DETERMINABLE read-only
nº de entradas                NO DETERMINABLE read-only
```

### Motivo del servicio en primer plano = **INFERRED**

**No se afirma `pending_uploads` como hecho.** A favor: el contrato del módulo
dice que la puerta de ciclo de vida **para** el servicio si no hay grabación ni
trabajo pendiente, y `recording: false` está observado. En contra, y es
indistinguible desde fuera: que la puerta **no se esté autoterminando**, lo que
sería otro defecto.

Y el motivo no es observable **por diseño**: `backgroundService.ts` lo registra
con `log()`, que `src/utils/log.ts` define como **no-op en release**. Por eso 790
líneas no contienen ni un `KEEPALIVE`.

Una lectura precipitada propia quedó corregida en el proceso: el repetido
`GC_QUEUE blocked: destination not resolved` **no implica entradas pendientes**.
Lo emite `drainBody()` en `app/index.tsx:2466`, **antes** de inspeccionar la
cola, como aplazamiento puro que no muta estado.

> **E2-B no se usa como evidencia de aislamiento.** No aporta nada a la
> clasificación de E2.

---

## E2 JWT · cruce entre proyectos

### Preflight

```
backend en 3101        nuestro código, pid 25500, lanzado desde …\main-apk-validation\backend
/health                200  {"status":"ok","uptime_s":31761,"version":"0.0.0"}
orden de middleware    router.get('/manifests', authMiddleware, userRateLimiter(10), handler)
                       authMiddleware PRIMERO; sin limitador global previo en app.ts
binding del backend    confirmado por el propietario (directorio + proyecto de banco);
                       NO verificable read-only: llegó por variables de sesión
par del lado móvil     mobile_project_ref = rgbsofvycynhabycetel
                       api authority      = 192.168.178.21:3101
                       derivados por el propio script de las variables que entregó EAS
```

### P1 — BENCH JWT → backend BENCH · `PASS`

```
identidad    signInAnonymously() en guaria-auth-test   is_anonymous=true
petición     GET http://192.168.178.21:3101/recovery/manifests   Bearer <token de banco>
respuesta    200
cuerpo       { drive_not_connected: true, manifests: … }
```

**Un JWT real emitido por `guaria-auth-test` superó el `authMiddleware` del
backend de banco.** El `200` prueba que el handler se ejecutó, y el cuerpo es el
contrato documentado para banco sin Drive, lo que confirma que cortocircuitó
**sin** llamar a Drive.

### N1 — el MISMO JWT → backend de PRODUCCIÓN · `PASS`

```
petición     GET https://api.guardiancloud.app/recovery/manifests   Bearer <el MISMO token>
redirects    NO seguidos (redirect: 'manual')
respuesta    401
cuerpo       { error: { code: 'UNAUTHORIZED' } }
```

**Producción rechazó dinámicamente una credencial de banco**, y lo hizo **antes
del handler**: por el orden verificado, `authMiddleware` precede al limitador por
usuario y al handler, así que ninguna lógica de negocio pudo ejecutarse. Fue un
`GET`, de modo que ni en el caso imposible de que la autenticación hubiera
pasado habría habido mutación.

> **Lo que la observación demuestra, y nada más:**
> `JWT BENCH válido → backend de producción → 401 UNAUTHORIZED`.
>
> El código señala el **issuer fijado** y la **verificación de firma** como los
> mecanismos de aislamiento, pero el `401` es **opaco por diseño** —el middleware
> no distingue expiración, firma ni issuer en la respuesta—, así que **no se
> puede determinar cuál de los dos produjo concretamente el rechazo**. No se
> atribuye causalidad interna.

### N2 — PRODUCTION JWT → backend BENCH · **NOT EXECUTED**

```
N2 = NOT EXECUTED / INFERRED
```

**No se obtuvo ni manipuló ningún JWT de producción.** Exigiría autenticarse
contra el Supabase de producción, que no está autorizado y no es necesario.

No hay atajo honesto: un token con el `iss` alterado fallaría por **firma**, de
modo que no probaría nada sobre el issuer. Su comportamiento permanece
**INFERRED por identidad de código** —el backend de banco ejecuta el mismo
`jwtVerifier` con `ISSUER` fijado a su propio proyecto—, **no validado**.

---

## Higiene de la corrida

```
identidad creada           UNA, anónima, exclusivamente en guaria-auth-test
signOut()                  ok  (sesión revocada)
fila anónima residual      aceptable y esperada: signOut no borra el usuario
JWT impreso                NO        refresh token impreso      NO
anon key impresa           NO        secreto impreso            NINGUNO
credenciales en disco      NINGUNA   (sin .env, sin fichero de script: `node -e`)
service_role               NO USADO  (habría fabricado el resultado, no demostrado)
peticiones a producción     UNA, negativa, sin seguir redirects
lógica de negocio de producción ejecutada   NINGUNA
SQL · Drive · OAuth · OTP · build · deployment · hardware adicional   NADA
repositorio                 limpio, sin ficheros nuevos ni sin seguimiento
```

Los tres valores del entorno `development` de EAS se capturaron en variables de
proceso con `eas env:get` y **nunca se mostraron**; de ellos sólo se derivaron
etiquetas no sensibles —project ref y host:puerto—.

---

## Clasificación

```
EAS ENVIRONMENT ISOLATION                        = IMPLEMENTED / TESTED / OBSERVED
SUPABASE PROJECT CONFIGURATION (BENCH artifact)  = OBSERVED
JWT CROSS-PROJECT ISOLATION  BENCH → PROD        = DYNAMICALLY VALIDATED
JWT CROSS-PROJECT ISOLATION  PROD → BENCH        = NOT EXECUTED / INFERRED
```

**Deliberadamente conservadora.** No se usa `HARDWARE VALIDATED` para ninguna
parte de E2: no es una validación en dispositivo. **No se declara aislamiento
bidireccional dinámicamente validado**: un sentido no se ejecutó.

## Lo que E2 no cambia

* **`GC-AUTH-SESSION-RECOVERY-001` sigue `OPEN`.** E2 no recupera ninguna
  identidad, no reanuda ninguna subida y no restaura ningún ownership.
* **El producto sigue `NO APTO PARA RELEASE`.**
* Los findings OAuth —`GC-OAUTH-SCHEME-COLLISION-001` y
  `GC-OAUTH-NOSTATE-001`— siguen `OPEN` y sin tocar.
* Drive en banco sigue sin habilitar.

## Candidata a deuda, no abierta como finding

En un APK release es **imposible saber desde fuera por qué sigue vivo el
servicio en primer plano**: `log()` silencia el motivo y `GC_QUEUE` no es
inspeccionable sin extraer credenciales. Para un producto cuya promesa es sacar
evidencia del dispositivo, no poder responder «¿queda algo pendiente?» es un
hueco de diagnóstico. Lo mismo que lo hace seguro —no ser debuggable— lo hace
opaco. **Queda registrado como candidata; no se abre finding ni implementación.**
