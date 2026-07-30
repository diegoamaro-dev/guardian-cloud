# BASELINE_FEA160C_2026-07-30

Registro de la baseline funcional `baseline-fea160c-android11-20260730`.

Este documento registra **únicamente hechos comprobados**. Distingue de forma
estricta lo validado con **esta** APK concreta de lo que sigue sin validar.

> **Lectura estricta de la frase del tag.** El tag dice *«Core application works
> on the tested device»*. Eso significa exactamente tres cosas y ninguna más:
> **la APK se instaló**, **la aplicación arrancó** y **se usó en ese dispositivo
> sin cierre inmediato**. No significa que la resiliencia esté validada, ni que
> la Reliability Card esté validada, ni que el veredicto `NO APTO` de la
> auditoría 2026-07-28 quede levantado.

---

## 1. Identidad

### Git

| | |
|---|---|
| Commit | `fea160ccc5a7bb53997d60c901711106176fe9b5` |
| Árbol | `effe8435c3f2861f1028917a9cd67353871db6e4` |
| Mensaje | `fix(reliability): harden background guidance` |
| Padre | `b87eb5b295295e3a3b9c98c79768cbeb1878a67d` (`origin/main`) |
| Rama publicada | `feat/reliability-card` → `refs/heads/feat/reliability-card` @ `fea160c` |
| Tag | `baseline-fea160c-android11-20260730` (anotado) |
| Objeto del tag | `9aa832803891635ba9243c5637a1c9959a2789d9` → desreferencia a `fea160c` |
| Worktree de origen | `D:\guardian-cloud-worktrees\reliability-card-integration` |

El tag `v0.3.0-rc.1` (`dc7de26`) **no fue modificado**. `main` sigue en `b87eb5b`.

### Artefacto

```
APK_PATH=D:\guardian-cloud-fea160c-reliability-preview.apk
APK_SIZE_BYTES=110405886
APK_SHA256=cb8120af483a66a99e5a5fab711f4e1094f883dd56e458e51440a17dcbf24301
SIGNER_SHA256=6aa7fa91a0d28c897ce008be184a1b9b7b98761283e035f605a8e33b126c921a
SIGNER_SHA1=8ca520a4b377ecd61225e517dee34be67f513daa
EAS_CREDENTIALS_ID=mdzaYNbPtv
EAS_BUILD_ID=0986770d-0f52-4eaf-956a-8811c8fc9122
EAS_COMMIT=fea160ccc5a7bb53997d60c901711106176fe9b5
EAS_FINGERPRINT=c4605ec6d2f415e711b990ab800d84c988117250
```

### Firma

El bloque `release` de `mobile/android/app/build.gradle` declara
`signingConfig signingConfigs.debug`. **EAS lo sobrescribe durante la
compilación** — el log registra `PREPARE_CREDENTIALS | Injecting signing config
into build.gradle` — de modo que la APK **no está firmada con la clave de
depuración**.

Contrastado contra el almacén de credenciales de Expo, no inferido:

| | Extraído del bloque de firma v2 de la APK | Almacenado en EAS |
|---|---|---|
| SHA-256 | `6aa7fa91a0d28c897ce008be184a1b9b7b98761283e035f605a8e33b126c921a` | idéntico |
| SHA-1 | `8ca520a4b377ecd61225e517dee34be67f513daa` | idéntico |

```
Credencial : Build Credentials mdzaYNbPtv (default)
  id       : 948bdc60-d877-4ba4-9bc5-5253ba9565e9
  keystore : 6026d55d-aa11-4cfc-8a67-28ece1f2d491
  alias    : 9f38803e10f22c86096f905b5d217da3   tipo JKS
```

Esquemas de firma presentes: **solo v2** (sin v1/JAR, sin v3). El DN del
certificado está vacío, algo normal en keystores generados por EAS. **Esa
huella es la identidad de la aplicación** en cualquier dispositivo donde se
instale.

> Custodia pendiente: la clave existe únicamente en el almacén de Expo, sin
> copia de seguridad bajo control propio. Queda anotada aquí como deuda
> independiente; **todavía no está registrada en
> [`KNOWN_DEBT.md`](../KNOWN_DEBT.md)**.

### Compilación

Perfil `preview`, distribución `INTERNAL`, APK, Expo SDK 54.
`appVersion 0.1.0`, `appBuildVersion 1`. Estado `FINISHED` el 2026-07-30
(08:49:42 → 09:04:42 UTC). El artefacto en EAS caduca el 2026-08-13.

### Dispositivo de prueba

| | |
|---|---|
| Modelo | OnePlus 6 (`ONEPLUS_A6000`) |
| Serie ADB | `d8a378fb` |
| Android | 11 |
| API level | 30 |
| ABI | `arm64-v8a` |
| Espacio libre en `/data` | 41 GB de 49 GB |

### Instalación limpia

Antes de instalar se comprobó por tres vías que el paquete **no existía**:
`pm list packages` sin salida, `pm path` vacío y `dumpsys package` sin bloque
`Package [com.guardiancloud.app]`. Tampoco había datos residuales:
`/data/data/com.guardiancloud.app` y `/sdcard/Android/data/com.guardiancloud.app`
inexistentes.

Instalado con `adb install -r`, sin `-d`, sin `-t` y sin opciones adicionales.

```
versionName     = 0.1.0
versionCode     = 1
minSdk          = 24     targetSdk = 36
primaryCpuAbi   = arm64-v8a
firstInstallTime= 2026-07-30 11:43:06
lastUpdateTime  = 2026-07-30 11:43:06
```

`firstInstallTime` igual a `lastUpdateTime` confirma instalación nueva, no
actualización.

> **Salvedad sobre «limpia».** La aplicación tiene `ALLOW_BACKUP` activo y
> figura en el gestor de copias de Android (`dumpsys backup` la lista). El
> sistema de ficheros estaba limpio antes de instalar, pero **Android pudo
> restaurar datos de aplicación desde la copia en la nube** durante la
> instalación. Limpia a nivel de disco no equivale a limpia a nivel de estado de
> aplicación. Esto afecta a cualquier prueba de persistencia posterior.

---

## 2. Validado específicamente con esta APK

Todo lo de esta sección se verificó por instrumentación sobre el dispositivo
`d8a378fb`, salvo donde se indique explícitamente otra procedencia.

### Instalación correcta

```
$ adb install -r "D:\guardian-cloud-fea160c-reliability-preview.apk"
Performing Streamed Install
Success
```

Integridad de lo instalado, comprobada extrayendo el APK del propio dispositivo:

| | Bytes | SHA-256 |
|---|---|---|
| APK en el dispositivo | 110 405 886 | `cb8120af…dcbf24301` |
| APK local instalada | 110 405 886 | `cb8120af…dcbf24301` |

Idénticos byte a byte. Lo instalado es exactamente el artefacto identificado en
§1, luego su firmante es el allí demostrado.

### Paquete iniciado en dispositivo real

```
$ adb shell am start -n com.guardiancloud.app/.MainActivity
Starting: Intent { cmp=com.guardiancloud.app/.MainActivity }

proceso  : u0_a293  7407  com.guardiancloud.app
resumida : ActivityRecord{e8cba33 u0 com.guardiancloud.app/.MainActivity t747}
enfocada : mFocusedWindow=Window{8aafef8 .../MainActivity}
```

### Interfaz renderizada sin cierre inmediato

- `logcat` sin entradas `FATAL` ni `AndroidRuntime`.
- El motor JS de React Native ejecuta y realiza llamadas reales de red:
  `GET https://api.guardiancloud.app/destinations` con `authed: true`, y
  `DEST_TYPE { activeDestinationType: 'drive', destinationResolved: true }`.
- Captura de pantalla del dispositivo: pantalla principal completa, con estado
  «Evidencia protegida / Guardada fuera de tu móvil», indicador «Protegido»,
  destino Google Drive resuelto, selector Audio/Vídeo y botón «GRABAR AHORA».

La aplicación permaneció en primer plano y con proceso vivo durante toda la
comprobación.

### Funcionamiento observado por el usuario

El propietario del dispositivo utilizó la aplicación instalada y observó su
funcionamiento. **Procedencia: informe del propietario, no instrumentación.**
No se registró ninguna prueba concreta bajo esta categoría; no debe leerse como
validación de ningún escenario de la matriz.

### Comprobaciones estáticas del commit

Ejecutadas en el worktree, no en el dispositivo:

| Comprobación | Resultado |
|---|---|
| Pruebas automáticas | 263/263 en verde (198 previas + 65 nuevas) |
| TypeScript | 12 errores preexistentes, **cero nuevos** → typecheck **NO verde** |
| `git diff --check` | limpio |
| Lint | **no disponible** — el proyecto no tiene configuración de lint |

---

## 3. NO validado específicamente con esta APK

Ninguno de estos puntos fue ejecutado. No deben presentarse como superados.

### Android 13+ y `POST_NOTIFICATIONS`

**Estructuralmente inalcanzable en este dispositivo.** El OnePlus 6 corre
Android 11 (API 30) y la lógica corregida actúa a partir de API 33. En este
móvil `getPostNotificationsStatus()` devuelve siempre `not_applicable` y el
botón «Activar notificaciones» nunca se muestra.

Sin ejecutar, por tanto:

- Android 13+ con permiso concedido.
- Android 13+ con permiso denegado.
- Android 13+ con la constante `POST_NOTIFICATIONS` ausente del bundle.

Estas tres ramas están cubiertas por pruebas unitarias en
`mobile/tests/reliabilityNotifications.test.ts`, pero **prueba unitaria no es
validación en dispositivo**.

### Matriz completa de resiliencia

Sin ejecutar con esta APK: mala red, segundo plano prolongado, cierre forzado
de la aplicación, reinicio del dispositivo, recovery automático y exportación
de evidencia.

### Actualización conservando datos previos

No verificable: esta fue una instalación limpia, sin instalación anterior sobre
la que actualizar y sin datos previos que preservar.

### Múltiples dispositivos

Un solo dispositivo (`d8a378fb`). Sin cobertura de otros fabricantes, versiones
de Android ni configuraciones OEM.

### Usuarios externos

Ninguno. La APK se instaló únicamente en un dispositivo propio.

### Publicación en Play Store

No procede. No hay AAB de producción, ni Closed Testing, ni distribución. El
tag lo dice explícitamente: *«Not a Play Store release»*.

### Motivo por el que la Reliability Card no apareció en Home

**Cuestión abierta, sin investigar.** En la captura del dispositivo, la
Reliability Card no se muestra en la pantalla principal, en la posición donde
se monta (entre el selector Audio/Vídeo y el botón de grabar).

Según la lógica implementada debería ser visible: Drive conectado, sin
grabación en curso, y aunque en Android 11 el permiso de notificaciones sea
`not_applicable` —sin botón, correcto—, la recomendación de batería sí debería
mostrarse.

Dos hipótesis, ninguna comprobada:

1. Android Auto Backup restauró `gc.reliability.dismissed_at` desde la copia en
   la nube, de modo que la tarjeta se considera descartada de una instalación
   anterior.
2. Un defecto en la propia tarjeta.

Distinguirlas requiere leer las dos claves de AsyncStorage en el dispositivo.
**Mientras esta cuestión siga abierta, la Reliability Card no puede
considerarse validada en dispositivo en ningún grado.**

---

## 4. Relación con el veredicto de auditoría

Esta baseline **no levanta** el veredicto `NO APTO` de la auditoría 2026-07-28.
Siguen abiertas todas las causas registradas en
[`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md), en particular
`GC-AUD-001` (el vídeo no saca evidencia del dispositivo durante la grabación).

Lo que esta baseline aporta es un punto de retorno reproducible con artefacto
identificado y firma demostrada, más la constancia de que la aplicación
instala, arranca y se usa en el dispositivo probado.

---

## 5. Advertencias de compilación

183 líneas de advertencia en el log de EAS. **Ninguna procede de los archivos
del commit**: 162 de `node_modules` y el resto de la plantilla nativa de Expo
(`MainApplication.kt`, fusión de manifiestos). Cero advertencias en
`mobile/app`, `mobile/src` y `mobile/tests`.

`expo doctor`: 15 de 18 comprobaciones superadas. Las tres restantes, todas sin
resolver y ninguna bloqueante:

1. Campos de `app.config.ts` no sincronizados por existir directorio `android/`
   (proyecto no-CNG).
2. `react-native-background-actions` sin probar en la New Architecture.
3. Tres paquetes de Expo con versión de parche por detrás: `expo 54.0.34`,
   `expo-file-system 19.0.22`, `expo-router 6.0.23`.

No se ejecutó `npm audit fix` ni se actualizó ninguna dependencia.
