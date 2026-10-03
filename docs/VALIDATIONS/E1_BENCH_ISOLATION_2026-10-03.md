# E1 — Aislamiento del build de BANCO · validación en hardware

## Identidad del gate

| | |
|---|---|
| **Gate** | `E1-BENCH-APK-REBUILD` + `E1 DEEP-LINK HARDWARE ROUTING` |
| **Fecha** | 2026-10-03 |
| **Resultado** | **`PASS`** |
| **Alcance validado** | identidad de instalación y enrutado del deep link **entre nuestros propios builds** |
| **Dispositivo** | OnePlus A6000 · Android 11 · API 30 · `arm64-v8a` · serial `d8a378fb` |

> **El alcance de este PASS es literal.** Acredita que un build de banco se
> instala, se actualiza y recibe su deep link como una aplicación distinta de
> producción. **No acredita nada de OAuth**: no se ejecutó ningún flujo real, no
> se conectó Drive, no se tocó Google ni el backend, y la URI de prueba no
> llevaba `code` ni `state`. Tampoco acredita captura, cola, subida, recovery ni
> export, que no se ejercitaron.

---

## Procedencia del artefacto validado

```
commit              77bef24a1f9d544dba3cc1da2c882fff8497c914
                    "feat(build): give bench its own deep link scheme"
EAS build ID        5c86cd00-8a75-40ba-99ff-0e93b7bec748   · FINISHED
perfil              bench · distribution INTERNAL
entorno EAS         development   (EXPO_PUBLIC_API_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY,
                                  EXPO_PUBLIC_SUPABASE_URL — cargadas por nombre)
env del perfil      NPM_CONFIG_LEGACY_PEER_DEPS · EXPO_PUBLIC_GC_ENV
APK sha256          402e9b85f5ab12b9e99ba22d3a01afbafda46210c1cb037888c1a9fcc0a927cf
                    110.589.330 bytes
keystore            Build Credentials d5yCcmQnkP (default) — REUTILIZADO, no generado
dispositivo         OnePlus A6000 · Android 11 · API 30
```

El build no abrió ningún prompt. El log declara literalmente
`√ Using Keystore from configuration: Build Credentials d5yCcmQnkP (default)`, y
el certificado del artefacto coincide con el del APK de banco anterior, lo que
es la condición para poder actualizar en sitio.

**Artefacto anterior, conservado como contraste:** build
`9d592ae9-b0c6-4420-8bd5-5419352ceab8`, commit `faf014f5…`, sha256
`123c463dd3339339de47503e877d03f37587c5131b623f88c92a0ed1a85b245d`. Es el mismo
producto **sin** el scheme de banco, y por eso sirve de control.

---

## 1 · Validación offline del artefacto — 7/7

Leído del APK con `aapt2 dump badging`, `apksigner verify` y `sha256sum`, antes
de instalar:

```
package           com.guariacloud.app.bench
application-label Guardian Cloud BANCO
versionCode       1          versionName 0.1.0
minSdk 24 · targetSdk 36
certificado       SHA-256 f5f06b9252a8d988b93e792ea9724cf9572a04231c66428802e11620b87f9aba
                  SHA-1   3235efd6d8059afc2f9a36677e8791bc893df7c3
firma             apksigner: "Verifies" · v2 scheme · exit 0
```

El certificado es **el mismo** que el del APK de banco anterior, y **distinto**
del de producción, cuyos dos artefactos históricos comparten
`SHA-256 6aa7fa91a0d28c897ce008be184a1b9b7b98761283e035f605a8e33b126c921a`.

### Manifest EMPAQUETADO dentro del APK

Leído con `aapt2 dump xmltree --file AndroidManifest.xml`, es decir del binario
del artefacto y **no** del intermedio de Gradle:

```
APK de banco  (77bef24)   guardiancloudbench · exp+guardian-cloud · https
APK anterior  (faf014f)   guardiancloud      · exp+guardian-cloud · https
```

* banco **registra `guardiancloudbench`**;
* banco **NO registra `guardiancloud`**;
* **conserva `exp+guardian-cloud`**, compartido por decisión explícita — es el
  scheme del Dev Client de Expo, no del producto.

`https` no es un scheme de la aplicación: está en el bloque `<queries>` del
manifest, que es lo que permite a `Linking.canOpenURL` consultar si hay
navegador. Aparece igual en los dos artefactos.

---

## 2 · Actualización in-place — `PASS`

Línea base leída por `dumpsys package` **antes** de instalar:

```
com.guariacloud.app.bench   vc=1  0.1.0  first 2026-10-03 10:40:39  last 2026-10-03 10:40:39
```

Instalación con `adb install -r <apk>`, sin `-d`, `-t`, `-g` ni ninguna otra
opción:

```
Performing Streamed Install
Success
```

Estado posterior:

```
com.guariacloud.app.bench   vc=1  0.1.0  first 2026-10-03 10:40:39  last 2026-10-03 16:30:06
                                         ↑ INTACTO                  ↑ CAMBIÓ
```

`firstInstallTime` intacto junto a `lastUpdateTime` nuevo es la firma de una
**actualización**: una reinstalación habría movido el primero. Los datos de la
aplicación se conservan.

**Y los bytes instalados son los validados**, no sólo «hubo actualización»:

```
/data/app/~~SvVrmAZqTTaYTfkvecRIIA==/com.guariacloud.app.bench-…/base.apk
sha256 en dispositivo    402e9b85f5ab12b9e99ba22d3a01afbafda46210c1cb037888c1a9fcc0a927cf
sha256 del APK validado  402e9b85f5ab12b9e99ba22d3a01afbafda46210c1cb037888c1a9fcc0a927cf
```

### Coexistencia observada — tres packages

```
com.guardiancloud.app       vc=1  first 2026-07-31 15:06:33  last 2026-08-24 16:08:28
com.guariacloud.app         vc=1  first 2026-08-25 10:27:01  last 2026-08-26 13:42:04
com.guariacloud.app.bench   vc=1  first 2026-10-03 10:40:39  last 2026-10-03 16:30:06
```

Las marcas de tiempo de los dos primeros **no cambiaron** con la instalación de
banco. No se desinstaló ni reinstaló ningún package, no se borraron datos y no
se tocó producción.

---

## 3 · Fase 1 — resolución del Package Manager, sin lanzar nada

`cmd package query-activities` y `cmd package resolve-activity`, con y sin
`CATEGORY_BROWSABLE`. Son consultas: no abren actividades ni fijan defaults.

```
guardiancloudbench://oauth/drive
  query-activities (VIEW)             → com.guariacloud.app.bench      [candidato ÚNICO]
  query-activities (VIEW+BROWSABLE)   → com.guariacloud.app.bench      [candidato ÚNICO]
  resolve-activity                    → com.guariacloud.app.bench
                                         com.guardiancloud.app.MainActivity

guardiancloud://oauth/drive
  query-activities (VIEW)             → com.guardiancloud.app
                                      → com.guariacloud.app            [DOS candidatos]
  query-activities (VIEW+BROWSABLE)   → idénticos
  resolve-activity                    → com.guardiancloud.app
```

* el scheme de banco tiene **un solo** candidato, así que no hay desambiguación
  posible;
* **banco no aparece** entre los candidatos de `guardiancloud://`.

> **Observación registrada, no investigada en este gate.** `guardiancloud://`
> tiene **dos** candidatos —el identificador histórico y el de producción
> vigente, ambos instalados en este dispositivo— y el preferido que Android
> elige es el **histórico**. Es el modo de fallo que describe
> [`KNOWN_LIMITS.md`](../KNOWN_LIMITS.md) §8, vivo entre las dos instalaciones
> de producción. Queda documentado y sin corregir.

En todas las resoluciones la clase es `com.guardiancloud.app.MainActivity`
mientras el package es el `applicationId` correspondiente: la divergencia
intencional `namespace ≠ applicationId` de
[`ADR-ANDROID-APPLICATION-ID`](../decisions/ADR-ANDROID-APPLICATION-ID.md),
visible en el enrutado real del sistema operativo.

---

## 4 · Fase 2A — entrega real del scheme de banco

Precondición: banco estaba en **foreground** al empezar, lo que habría hecho
ambigua la observación. Se mandó al fondo con `input keyevent KEYCODE_HOME`
—sin force-stop, sin borrar datos, sin cerrar el proceso— y se verificó:

```
antes del intent   mCurrentFocus = net.oneplus.launcher/.Launcher
                   proceso de banco VIVO en background
```

Lanzamiento:

```
adb shell am start -W -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE -d "guardiancloudbench://oauth/drive"

Starting: Intent { act=android.intent.action.VIEW cat=[android.intent.category.BROWSABLE]
                   dat=guardiancloudbench://oauth/drive }
Warning: Activity not started, its current task has been brought to the front
Status: ok
LaunchState: HOT
Activity: com.guariacloud.app.bench/com.guardiancloud.app.MainActivity
TotalTime: 90
WaitTime: 95
Complete
```

Estado posterior:

```
mCurrentFocus   = com.guariacloud.app.bench/com.guardiancloud.app.MainActivity
ResumedActivity = com.guariacloud.app.bench/com.guardiancloud.app.MainActivity  t961
topDisplayFocusedStack = Task #961  A=10225:com.guariacloud.app.bench  visible=true
procesos de la familia = sólo com.guariacloud.app.bench
```

* el sistema resolvió y entregó la URI al componente exigido;
* la transición **launcher → banco** ocurrió como consecuencia del intent;
* **ninguna de las otras dos aplicaciones pasó a foreground**: no tienen proceso
  en ejecución ni tarea visible.

`LaunchState: HOT` y el aviso `its current task has been brought to the front`
describen una instancia existente en segundo plano que recibe el deep link por
`onNewIntent` y recupera el foco. **No es un error**: es el camino real de un
retorno de OAuth, con el navegador delante y el deep link arrebatándole el foco.

La URI no llevaba `code` ni `state` y **no se inspeccionó logcat**: no era
necesario para determinar el enrutado, que era el objeto del gate. Si la ruta
`oauth/drive` mostró algún estado en pantalla, no está observado aquí.

---

## Clasificación

```
ANDROID INSTALL ISOLATION        = HARDWARE VALIDATED   OnePlus A6000, 2026-10-03
BENCH DEEP-LINK SCHEME ISOLATION = HARDWARE VALIDATED   OnePlus A6000, 2026-10-03
```

Como todo `HARDWARE VALIDATED` de este repositorio, significa **validado en ese
dispositivo**: OnePlus A6000 / Android 11 / API 30 / `arm64-v8a`. No implica
cobertura multi-dispositivo ni Android 13+.

---

## Lo que este PASS no acredita

* **`GC-OAUTH-SCHEME-COLLISION-001` sigue `OPEN`.** Lo validado es que el scheme
  de banco es exclusivo de banco y que el de producción no alcanza a banco. El
  finding es más amplio: una aplicación de **terceros** puede seguir registrando
  `guardiancloud://` y competir con producción. Y en este mismo dispositivo ese
  scheme sigue teniendo dos candidatos de producción.
* **`GC-OAUTH-NOSTATE-001` sigue `OPEN`** y sin tocar: `state` no se genera, no
  se valida y no se usa.
* **OAuth real y Drive en banco: NO VALIDADOS.** No se ejecutó ningún flujo, no
  se conectó Drive, no se tocó Google Cloud ni el backend. Habilitar Drive en
  banco sigue bloqueado por la configuración de OAuth en Google y por el
  `MOBILE_OAUTH_REDIRECT` del backend de banco, que sigue en `unused://bench`.
* **Nada sobre el producto**: ni captura, ni `GC_QUEUE`, ni worker, ni subida,
  ni recovery, ni cleanup, ni export. Ninguno se ejercitó.
* **Nada sobre producción**: no se construyó, no se instaló y no se lanzó.
* `GC-AUTH-SESSION-RECOVERY-001` sigue `OPEN` y el producto sigue
  **`NO APTO PARA RELEASE`**.

## Deuda que este gate deja abierta

* **Custodia del keystore de banco.** `Build Credentials d5yCcmQnkP`, certificado
  `f5f06b92…`, **sin copia offline**. Si se pierde, la instalación de banco deja
  de ser actualizable.
* **`com.guariacloud.app` instalado desde el 2026-08-25** con el identificador de
  producción vigente, mientras las credenciales de EAS sólo listan
  `com.guardiancloud.app`. De dónde salió ese artefacto **no está determinado**.
  No afecta a banco; habrá que resolverlo antes de la primera release de
  producción.
