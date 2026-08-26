# Guardian Cloud — Release Checklist v0.3

## Alcance

Primera release MVP funcional. Validar que el flujo completo aguanta
producción real: grabar, chunkear, subir en background, recuperar tras
kill, exportar.

> **Este checklist gobierna la RELEASE PÚBLICA, no la baseline técnica.**
> Existe una baseline congelada — [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md) —
> que es un punto de retorno reproducible, **no** una release. Ninguna casilla
> de este documento se marca por el hecho de que esa baseline exista.

### Tres artefactos distintos, no confundir

| Artefacto | Para qué | Estado |
|---|---|---|
| **Build local** (`expo run:android`) | iteración rápida durante el desarrollo | no sirve como evidencia de release |
| **EAS `preview`** (`buildType: apk`, `distribution: internal`) | candidatas y validación en dispositivo propio | la baseline `v0.3.0-rc.1` es de este tipo |
| **Release de Play Store** (AAB, perfil `production`) | publicación | **no construida nunca todavía** |

---

## 0. Invariante de migración de identidad — BLOQUEANTE

> **El commit `8615ba6` (4C — captura local-first con identidad degradada) NO
> PUEDE publicarse en ningún build que no contenga también la corrección
> GC-AUTH-MIGRATION-001 y el seal `gc.legacy_probe.v1`.**

No es una preferencia de orden de merge. Es la condición de la que depende la
demostración de seguridad de la migración.

La legacy probe deduce «existió una identidad aquí» a partir de rastros
durables de captura. Esa deducción es válida porque la guarda
`TOKEN_MISSING_AT_START` está presente de forma continua desde `22d3f5e` hasta
`45357c4` y en todos los tags de release, cubriendo audio y vídeo nativo. 4C
elimina esa guarda: desde `8615ba6`, las cuatro señales pueden escribirse sin
identidad alguna.

El seal cierra la ventana respondiendo la pregunta **una sola vez**, en un
instante en el que todo rastro presente procede necesariamente de un build con
guarda. Si 4C se publica sin el seal, las instalaciones empiezan a acumularse
dentro de la ventana ambigua, donde un dispositivo que nunca tuvo identidad es
**indistinguible** de uno que la tuvo y la perdió — de forma permanente y a
partir del estado local. Ya hay un ejemplar en hardware.

- [ ] Verificar que el build a publicar contiene `gc.legacy_probe.v1`:
      `git log --oneline -S 'gc.legacy_probe.v1' -- mobile/src/auth/identityMarker.ts`
- [ ] Si el build contiene `8615ba6` y la comprobación anterior sale vacía:
      **detener la release.**

Detalle completo en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §2.

---

## 1. Pre-flight (código)

### Mobile
- [ ] `cd mobile && npx tsc --noEmit`.
      **Requisito de release: cero errores.**
      **Estado actual: 12 errores heredados → typecheck NO verde → bloquea la
      release pública.** Distribución exacta en
      [`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md) §6.
      Comparar contra esa lista: **cero errores nuevos** es condición mínima
      para seguir; cero absolutos es el requisito de release.
- [ ] `cd mobile && npm test` → **suite completa verde, sin tests saltados**,
      y registrar el total observado (`___ / ___`).
      **La condición es «toda la suite actual pasa», no alcanzar una cifra.**
      Resultados históricos, sólo como referencia: **198/198** en
      `v0.3.0-rc.1` y **263/263** en `baseline-fea160c-android11-20260730`.
      No fijar la cifra como requisito en este documento: las cifras `99` y
      `138` que aparecían antes quedaron obsoletas (99 era anterior a la
      auditoría, 138 el baseline previo a A-1/A-2) y empujaban a «arreglar» el
      checklist en vez del código.
      Los tests se ejecutan **en local, sin CI**: ningún resultado es
      reproducible de forma independiente todavía.
- [ ] `mobile/package.json` versión actualizada a `0.3.x`.
      **SIN CUMPLIR.** Declara `0.1.0`. Ver §7.1 del registro de baseline: la
      etiqueta `v0.3.0-rc.1` marca un punto de git, **no** la versión de la
      aplicación.
- [ ] `mobile/app.config.ts` `version` actualizada. **SIN CUMPLIR** (`0.1.0`).
- [ ] `mobile/android/app/build.gradle` `versionName` / `versionCode`
      coherentes con lo anterior, y **`versionCode` incrementado respecto a la
      release anterior**. **SIN CUMPLIR** (`0.1.0` / `1`).
      Requiere decidir el esquema: `eas.json` declara
      `appVersionSource: "remote"` pero no hay versiones remotas configuradas.
      **Ésta es la única exigencia operativa de versionado del documento**; §3.2
      remite aquí en lugar de duplicarla.
- [ ] No hay `console.log` con secretos (los logs `TOKEN`, `SUB`,
      `ACCESS_TOKEN` solo loguean longitud + prefijo, nunca el valor).
- [ ] `DEBUG_QUEUE`, `DEBUG_INJECT_CHUNK1_FAILURE`, `DEBUG_DUPLICATE_SUBMISSION`,
      `DEBUG_CORRUPT_EXPORT_CHUNK_INDEX`, `MID_DRAIN_DELAY_MS`
      → todos en estado de release (false / -1 / 0).

### Backend
- [ ] `cd backend && npx tsc --noEmit` (verificar que el único error
      pre-existente es `rateLimit.ts:25` — documentado en
      `KNOWN_DEBT.md`).
- [ ] `cd backend && npm test` verde.
- [ ] Variables de entorno reales en el host de release:
      `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
      `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
      `MOBILE_OAUTH_REDIRECT`.

---

## 2. Manifest Android

`mobile/android/app/src/main/AndroidManifest.xml` debe tener:

- [ ] `RECORD_AUDIO`, `CAMERA`, `INTERNET`
- [ ] `FOREGROUND_SERVICE`
- [ ] `FOREGROUND_SERVICE_MICROPHONE` (Android 14+)
- [ ] `POST_NOTIFICATIONS` (Android 13+)
- [ ] `WAKE_LOCK`, `VIBRATE`
- [ ] `<service android:name="com.asterinet.react.bgactions.RNBackgroundActionsTask"
      android:foregroundServiceType="microphone"/>`
- [ ] `<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts"/>`

---

## 3. Build release

### 3.1 ⛔ `expo prebuild --clean` NO es un paso rutinario

El directorio `mobile/android/` está **versionado** y contiene
personalizaciones nativas que el prebuild **destruye**: permisos custom del
manifest, el `<service>` de `RNBackgroundActionsTask` con su
`foregroundServiceType`, el `meta-data` de shortcuts y la configuración de
seguridad de red.

Además, EAS ignora `android.package` de `app.config.ts` precisamente porque
detecta ese directorio: **el paquete real sale del nativo versionado**.

> **No ejecutar `prebuild --clean` como parte de un flujo normal de build.**
> Sólo de forma consciente, cuando sea imprescindible (p. ej. al subir de SDK
> mayor), y en ese caso:
>
> 1. partir de árbol limpio y con el diff de `mobile/android/` a mano;
> 2. ejecutarlo en una rama dedicada, nunca junto a otros cambios;
> 3. **reaplicar y verificar una a una** las personalizaciones de §2;
> 4. comparar `AndroidManifest.xml` y `build.gradle` contra la versión anterior
>    antes de commitear.

### 3.2 Build

```bash
cd mobile
npx expo run:android --variant release
# o:
cd android && ./gradlew assembleRelease
```

- [ ] AAB / APK firmado con keystore de release (NO con el debug.keystore).
- [ ] `applicationId` = `com.guardiancloud.app`.

> **Versionado:** el requisito completo —incluido el incremento de `versionCode`
> respecto a la release anterior— vive en **§1 · Pre-flight (código)**. No se
> repite aquí para que exista una sola exigencia operativa.

### 3.3 Comprobaciones obligatorias en toda build de EAS

Antes de aceptar cualquier artefacto de EAS, verificar **las cinco** en su log.
Si falta una, el artefacto no vale:

- [ ] Las tres variables cargadas del entorno correspondiente:
      `Environment variables … loaded from the "<env>" environment on EAS:
      EXPO_PUBLIC_API_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_SUPABASE_URL`.
      **Si aparece `No environment variables found`, detener**: el bundle
      llevará `undefined` y la app abortará al arrancar con
      `[env] Invalid EXPO_PUBLIC_* configuration`.
- [ ] Proyecto y Project ID esperados (`eas project:info`).
- [ ] `Using Keystore from configuration: Build Credentials <id>` —
      **reutilizado, no regenerado**. Un keystore nuevo rompe `install -r`
      sobre instalaciones previas.
- [ ] Paquete Android procedente del nativo, no de `app.config.ts`.
- [ ] **Arranque del APK real con Metro APAGADO**, sin `FATAL EXCEPTION` ni
      `JavascriptException`, con `ENV READY` mostrando valores reales y la
      secuencia `GC_BOOT_RECOVERY_START` → `GC_BOOT_QUEUE_PENDING` →
      `GC_PERF_DRAIN_PICK` en Logcat.

---

## 4. Test manual sin Metro

**Crítico**: probar el AAB / APK release exactamente como llega al
usuario, con Metro APAGADO. Metro Dev Client esconde bugs reales
(sources cargados desde el host, sin minify, sin Hermes optimizado).

Desinstalar el dev client antes:
```bash
adb uninstall com.guardiancloud.app
adb install mobile/android/app/build/outputs/apk/release/app-release.apk
```

### 4.1 Camino feliz audio
- [ ] Conectar Drive desde Settings → consent flow completo → "Conectado".
- [ ] Grabar audio 30 s → ver "Grabando" + dot rojo.
- [ ] Parar → "Subiendo evidencia (X / Y)" → "Protegido".
- [ ] Comprobar carpeta `/GuardianCloud` en Drive del usuario → chunks
      presentes y completos.
- [ ] Vibración en start (Heavy) y en stop (Success).

### 4.2 Camino feliz vídeo
- [ ] Cambiar a modo Vídeo → grabar 20 s → parar.
- [ ] Logs muestran `VIDEO_CHUNKS_ENQUEUED { count: N }`.
- [ ] Subida llega al 100 %; `Protegido` aparece.
- [ ] Notificación foreground service "Guardian Cloud está protegiendo
      tu evidencia" visible mientras la cola drena.
- [ ] Notificación desaparece al vaciarse la cola
      (`GC_BACKGROUND_SERVICE_STOP { reason: 'no_pending_work' }`).

### 4.3 Background durante grabación audio
- [ ] Grabar audio + minimizar app + esperar 30 s + restaurar.
- [ ] Logs muestran `GC_BACKGROUND_RECORDING_CONTINUE` +
      `GC_BACKGROUND_CHUNK_EMITTED` durante la ventana de minimización.
- [ ] Al restaurar, `GC_BACKGROUND_SERVICE_KEEPALIVE recording_active`.
- [ ] Parar → la subida termina sin huecos.

### 4.4 Background tras stop de vídeo
- [ ] Grabar vídeo + parar + minimizar inmediatamente.
- [ ] Logs muestran `KEEPALIVE pending_uploads` cada 5 s.
- [ ] Restaurar tras 1 minuto → cola drenada al 100 %.

### 4.5 Recovery tras kill
- [ ] Grabar vídeo + parar (sin esperar a que suba) + force-stop por
      Settings de Android.
- [ ] Reabrir app → logs:
  - `GC_BOOT_RECOVERY_START`
  - `GC_BOOT_QUEUE_PENDING { entries, pending, uploading, failed }`
  - `GC_BOOT_STUCK_UPLOAD_RESET { count }`
  - `GC_BOOT_PENDING_SESSION_REGISTRATION_START`
  - `GC_BOOT_UPLOAD_DRAIN_START`
  - `GC_BOOT_BACKGROUND_SERVICE_START` (si pending > 0)
- [ ] Subida sigue sola sin que el usuario pulse nada.

### 4.6 Modo offline
- [ ] Activar avión → grabar audio 20 s → parar.
- [ ] Logs `GC_LOCAL_FIRST session deferred` aparecen.
- [ ] Cola permanece con chunks pending.
- [ ] Quitar avión → `POST /sessions` se reintenta y los chunks suben
      sin intervención.

### 4.7 Export
- [ ] Abrir `/session/<id>` con sesión completa → "Exportar evidencia"
      → archivo se genera, status "Evidencia lista", "Compartir archivo"
      funciona.
- [ ] Sesión parcial vídeo → "🟡 Evidencia parcial protegida", sin
      botón "Compartir".
- [ ] Sesión sin chunks cloud pero con archivo local → fallback local
      → "Exportando desde el dispositivo…" → "Evidencia local lista".

### 4.8 Permisos Android 13+
- [ ] Primera grabación: el SO pide `POST_NOTIFICATIONS`. Otorgar.
- [ ] Verificar notificación visible.
- [ ] Reinstalar y denegar. Verificar que la app graba pero sin
      notificación. Documentado.
- [ ] **ReliabilityCard en Android 13+**: el botón «Activar notificaciones»
      aparece cuando el estado es `denied`/`unknown`, y desaparece al conceder.
      **NO VALIDADO.** La baseline `v0.3.0-rc.1` se probó en un OnePlus 6 con
      Android 11 (SDK 30 < 33), donde `POST_NOTIFICATIONS` resuelve a
      `not_applicable` y el botón queda oculto por diseño. **La rama Android
      13+ del código nuevo no ha sido ejercitada nunca.** Requiere un
      dispositivo con SDK ≥ 33.

### 4.9 Launcher shortcut
- [ ] Long-press del icono → menú con "Grabar evidencia".
- [ ] Tap → app abre Home con texto verde "Listo para grabar".
- [ ] **NO** debe arrancar grabación sola (Play Store policy).

### 4.10 Test con usuarios reales (obligatorio)

> **NO REALIZADO.** Ningún usuario externo ha usado la aplicación. La baseline
> `v0.3.0-rc.1` sólo se ha ejecutado en un dispositivo del desarrollador.

* [ ] 3 personas sin contexto técnico usan la app. **NO REALIZADO.**
* [ ] No se les explica cómo funciona
* [ ] Se les pide: "usa esto si te pasa algo raro"

Verificar:

* [ ] Tiempo hasta empezar a grabar < 2 segundos
* [ ] No hay dudas durante grabación
* [ ] El usuario **distingue** grabación, subida y protección confirmada — y no
      asume que grabar equivale a estar protegido
* [ ] El usuario puede recuperar la evidencia sin ayuda

Si falla:

> NO lanzar release

---

## 5. Closed Testing en Play Console

> **NADA DE ESTA SECCIÓN ESTÁ INICIADO.** No existe AAB de producción, no hay
> ficha en Play Console y no ha habido testers externos. La baseline
> `v0.3.0-rc.1` es un APK `preview` instalado en un único dispositivo propio.

- [ ] Subir AAB a Closed Testing. **NO INICIADO** — nunca se ha construido un
      AAB con el perfil `production`.
- [ ] 12 testers mínimo invitados. **NO INICIADO.**
- [ ] 14 días de prueba interna sin regresiones. **NO INICIADO.**
- [ ] Feedback recogido en `TEST_RESULTS.md`. **NO INICIADO.**

---

## 6. Data Safety form

- [ ] Audio: collected, not shared, used for app functionality.
- [ ] Video: collected, not shared, used for app functionality.
- [ ] Email del usuario: collected, encrypted in transit, not shared.
- [ ] Aclarar: el contenido de la grabación NO se almacena en servidor
      propio. Va al Drive del usuario.
- [ ] Permiso `drive.file` (no `drive.readonly` ni `drive`): la app
      solo ve los archivos que ella misma crea.

---

## 7. Mensajes prohibidos en la ficha

NO usar:
- "seguridad total"
- "garantía legal"
- "protección absoluta"
- "indetectable"
- "automático en background" (sin acción del usuario)

Usar:
- "preservar evidencia"
- "subir aunque cierres la app"
- "control del usuario"
- "tu Drive, tus datos"

---

## 8. Post-release

- [ ] Tag git `v0.3.0`.
- [ ] Cambios reflejados en `IMPLEMENTATION_STATUS.md`.
- [ ] Bugs reportados en testing → entradas en `KNOWN_DEBT.md` o
      issues si aplica.
- [ ] No iniciar v0.4 hasta tener métricas de uso real (al menos
      30 días de instalación).

---

## 9. Rollback plan

Si una métrica clave se rompe en producción:
- Pausar Closed Testing.
- Revisar logs de Sentry / equivalente (TBD).
- Hotfix en branch `release/v0.3.x`.
- Re-promote.

NUNCA force-push a main.

**Punto de retorno técnico disponible hoy:** la baseline
[`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md), con criterios de rollback y
comandos de reversión por commit en su §8.
