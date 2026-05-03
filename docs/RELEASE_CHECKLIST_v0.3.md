# Guardian Cloud — Release Checklist v0.3

## Alcance

Primera release MVP funcional. Validar que el flujo completo aguanta
producción real: grabar, chunkear, subir en background, recuperar tras
kill, exportar.

---

## 1. Pre-flight (código)

### Mobile
- [ ] `cd mobile && npx tsc --noEmit` limpio.
- [ ] `cd mobile && npm test` → 99/99 verdes.
- [ ] `mobile/package.json` versión actualizada a `0.3.x`.
- [ ] `mobile/app.config.ts` `version` actualizada.
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

```bash
cd mobile
# Si cambió manifest / dep nativa:
npx expo prebuild --clean   # ojo: REGENERA AndroidManifest — reaplica
                            # los permisos custom + el <service> + el
                            # meta-data de shortcuts si los borra.

npx expo run:android --variant release
# o:
cd android && ./gradlew assembleRelease
```

- [ ] AAB / APK firmado con keystore de release (NO con el debug.keystore).
- [ ] `applicationId` = `com.guardiancloud.app`.
- [ ] `versionCode` incrementado respecto a la release anterior.

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

### 4.9 Launcher shortcut
- [ ] Long-press del icono → menú con "Grabar evidencia".
- [ ] Tap → app abre Home con texto verde "Listo para grabar".
- [ ] **NO** debe arrancar grabación sola (Play Store policy).

---

## 5. Closed Testing en Play Console

- [ ] Subir AAB a Closed Testing.
- [ ] 12 testers mínimo invitados.
- [ ] 14 días de prueba interna sin regresiones.
- [ ] Feedback recogido en `TEST_RESULTS.md`.

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
## 4.10 Test con usuarios reales (obligatorio)

* [ ] 3 personas sin contexto técnico usan la app
* [ ] No se les explica cómo funciona
* [ ] Se les pide: "usa esto si te pasa algo raro"

Verificar:

* [ ] Tiempo hasta empezar a grabar < 2 segundos
* [ ] No hay dudas durante grabación
* [ ] El usuario entiende que está protegido
* [ ] El usuario puede recuperar la evidencia sin ayuda

Si falla:

> NO lanzar release
