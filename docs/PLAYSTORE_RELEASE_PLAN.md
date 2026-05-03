# Guardian Cloud — Play Store Release Plan (v1)

## 1. Objetivo

Lanzar una versión mínima funcional en Play Store que:

- funcione de verdad
- cumpla políticas
- sea entendible
- no rompa nada crítico

---

## 2. Qué incluye v1

- Grabación manual (botón) — audio y vídeo
- División en chunks
- Subida automática a Google Drive
- Cola persistente en AsyncStorage (clave `test.pending_retry`,
  array de `PendingQueueEntry`)
- Reintentos automáticos con backoff (transient vs permanent)
- Foreground service Android — la subida sigue viva al minimizar
  - notificación persistente: "Guardian Cloud está protegiendo tu evidencia"
  - lifecycle gobernado por trabajo real (recording activo o cola con
    chunks pending/uploading)
- Recovery tras kill: al reabrir la app, la cola se rehidrata, los
  chunks `uploading` stuck pasan a `pending`, y el worker drena.
- Modo offline: la grabación se inicia y los chunks se encolan aunque
  no haya red. Cuando vuelve la conexión, sube todo automáticamente.
- Integración con Google Drive (OAuth `drive.file`, carpeta `/GuardianCloud`)
- Autenticación Supabase
- Estado de subida visible (Listo / Grabando / Subiendo X/Y / Protegido / Error)
- Export local fallback cuando no hay red (comparte el archivo del
  dispositivo si los chunks no han llegado al cloud)
- App shortcut Android "Grabar evidencia" (long-press del icono)

---

## 3. Qué NO incluye v1

- ❌ Guardian Cloud Kids completo
- ❌ múltiples destinos
- ❌ NAS
- ❌ sistema de pagos
- ❌ alertas avanzadas
- ❌ UI compleja
- ❌ IA
- ❌ modo offline avanzado

---

## 4. Permisos Android necesarios

Declarados en `mobile/android/app/src/main/AndroidManifest.xml`:

- `CAMERA`
- `RECORD_AUDIO`
- `INTERNET`
- `MODIFY_AUDIO_SETTINGS`
- `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` (legacy)
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_MICROPHONE` (Android 14+ exige el tipo)
- `POST_NOTIFICATIONS` (Android 13+ — DEBE pedirse en runtime via
  `PermissionsAndroid.request(POST_NOTIFICATIONS)` antes de arrancar
  el foreground service, o la notificación queda invisible aunque el
  service sí arranque)
- `WAKE_LOCK`
- `VIBRATE` (haptic feedback en start/stop)
- `SYSTEM_ALERT_WINDOW`

Servicio declarado:
```xml
<service
  android:name="com.asterinet.react.bgactions.RNBackgroundActionsTask"
  android:foregroundServiceType="microphone"/>
```

App shortcut (long-press del icono) declarado en
`res/xml/shortcuts.xml` con intent `guardiancloud:///?panic=1`.

---

## 5. Requisitos técnicos

- La grabación debe iniciarse por acción del usuario
- No grabar en background sin interacción clara
- Mostrar indicador visible de grabación
- Manejar correctamente permisos runtime

---

## 6. Data Safety (Play Console)

Declarar:

- Qué datos se usan
- Qué datos se almacenan
- Qué datos se comparten
- Uso de Drive del usuario
- No almacenamiento de vídeo en servidor propio

---

## 7. Testing obligatorio

### 7.1 Tests automáticos
- `cd mobile && npm test` (Vitest, 99 tests sobre cola, worker,
  classifyError, migrate, normalize, finalize, deriveGuardianStatus,
  localEvidence — todos verdes en CI antes de release).
- `cd mobile && npx tsc --noEmit` limpio.
- `cd backend && npm test` y `npx tsc --noEmit`.

### 7.2 Test manual sin Metro (release build)

Imprescindible: probar el AAB / APK release exactamente como llegará
al usuario, sin Metro corriendo. Metro Dev Client esconde bugs reales
(sources cargados desde tu host, sin minify, sin Hermes optimizado).

```bash
cd mobile
# Build local de debug (rebuild necesario tras cambios de manifest):
npx expo run:android --variant release
# O build de release con keystore configurado:
cd android && ./gradlew assembleRelease
adb install app/build/outputs/apk/release/app-release.apk
```

Tras instalar el release:
- desinstala el dev client.
- abre la app SIN Metro corriendo.
- valida los flujos críticos (sección 7.3).

### 7.3 Flujos críticos a validar manualmente

- Grabar audio + minimizar 30 s + restaurar → ningún chunk perdido.
- Grabar vídeo + parar + minimizar mientras la cola drena → vídeo
  termina de subir en background (foreground service ON con KEEPALIVE
  pending_uploads).
- Grabar vídeo + parar + force-stop con cola pendiente + reabrir +
  esperar → la subida sigue sola.
- Modo offline: poner avión, grabar, parar, esperar, quitar avión →
  POST /sessions se reintenta y los chunks suben.
- Long-press del icono → "Grabar evidencia" → app abre Home con texto
  "Listo para grabar". NO debe arrancar grabación sola.
- POST_NOTIFICATIONS denied → la app graba pero no muestra
  notificación. Verificar que la subida sigue funcionando en
  foreground (background lifetime se pierde — documentado).
- Test en al menos:
  - Wi-Fi
  - 4G/5G
  - red flaky (toggle WiFi durante upload)
  - sin red (cold start con avión activado)

### 7.4 Closed Testing (Play Console)
- 12 testers mínimo
- 14 días de prueba interna en Closed Testing

---

## 8. UX mínima

- 1 pantalla principal
- 1 botón grande (grabar/parar)
- indicador de subida
- estado simple

---

## 9. Mensaje en Play Store

NO usar:

- “seguridad total”
- “garantía legal”
- “protección absoluta”

Usar:

- “preservar evidencia”
- “envío rápido”
- “control del usuario”

---

## 10. Objetivo de v1

> Validar que el sistema funciona en condiciones reales

NO escalar  
NO monetizar aún  
NO complicar