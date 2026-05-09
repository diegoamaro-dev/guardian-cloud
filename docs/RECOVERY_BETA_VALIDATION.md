# Guardian Cloud — Recovery Beta Validation

Matriz operativa para validar el APK release antes de mandarlo a testers externos.
Cada escenario es **físico** y debe ejecutarse contra el APK firmado, NO contra Expo Dev Client.

---

## Cómo se usa

1. Construir APK release (`eas build --profile preview --platform android` o `assembleRelease`).
2. Desinstalar dev client si lo hubiera.
3. Instalar APK en al menos **dos** dispositivos: uno Pixel/Android-stock y uno OEM agresivo (Xiaomi/Huawei/OPPO si está a mano).
4. Por cada escenario abajo: ejecutar pasos al pie de la letra, anotar PASS/FAIL en una copia con fecha + dispositivo + Android version.
5. Un único FAIL en severidad 🔴 BLOCKER → **no hay APK beta**.

## Severidades

- 🔴 **BLOCKER** — invariante crítico. Falla → no salir a testers.
- 🟡 **IMPORTANTE** — degradación notable. Falla → mitigar antes de release o documentar limitación.
- ⚪ **EDGE** — caso poco frecuente. Falla → ticket post-beta.

## Pre-requisitos por sesión de validación

- Cuenta Supabase de tester con sesión iniciada.
- Drive del tester conectado (`/GuardianCloud` accesible).
- (Opcional, solo R10) NAS conectado.
- adb conectado para `adb logcat | grep -E "GC_|guardian"` (no obligatorio pero acelera diagnóstico).
- Acceso a Drive web del tester en otro dispositivo para verificación cruzada.

---

## Índice de escenarios

| ID | Escenario | Severidad | Cobertura tests automáticos |
|---|---|---|---|
| R1  | Kill app durante upload | 🔴 BLOCKER | parcial |
| R2  | Force stop Android (Settings → Apps → Force stop) | 🔴 BLOCKER | parcial |
| R3  | Modo avión activado antes de grabar | 🔴 BLOCKER | parcial |
| R4  | Pérdida intermitente de red | 🔴 BLOCKER | parcial |
| R5  | Pantalla bloqueada durante grabación | 🔴 BLOCKER | nula |
| R6  | Background prolongado (>5 min) | 🟡 IMPORTANTE | nula |
| R7  | Reinicio del móvil con cola pendiente | 🔴 BLOCKER | parcial |
| R8  | OAuth de Drive expirado / revocado | 🔴 BLOCKER | parcial |
| R9  | Drive del tester lleno | 🟡 IMPORTANTE | nula |
| R10 | NAS desconectado a mitad de subida | 🟡 IMPORTANTE | parcial |
| R11 | Cierre de app durante chunking de vídeo | 🔴 BLOCKER | parcial |
| R12 | Reopen cold boot sin cola pendiente | 🟡 IMPORTANTE | parcial |
| R13 | Export post-recovery | 🔴 BLOCKER | parcial |
| R14 | Recovery tras múltiples failed chunks (botón Reintentar) | 🔴 BLOCKER | parcial |

"Cobertura parcial" = la **lógica** está cubierta por tests vitest. Los **mecanismos del sistema operativo** (force stop, foreground service, deep linking, Doze, intent de boot) **no** se pueden simular en tests JS — siempre hay que validar físicamente.

---

## R1 — Kill app durante upload

**Severidad:** 🔴 BLOCKER
**Cobertura tests automáticos:** parcial — `queue.test.ts` (rehidratación), `normalize.test.ts` (stuck `uploading` → `pending`)

**Precondición:**
- App abierta en Home, "Listo".
- Drive conectado.
- Sin cola residual (cola vacía).

**Pasos exactos:**
1. Pulsar GRABAR.
2. Esperar 30 segundos.
3. Pulsar PARAR.
4. **Inmediatamente**, mientras pill muestra "Subiendo evidencia (X / Y)" con X < Y, abrir el switcher (gesto de tareas recientes) y deslizar la app hacia arriba para matarla.
5. Esperar 60 segundos sin tocar el dispositivo.
6. Reabrir Guardian Cloud desde el lanzador.

**Qué observar:**
- En el primer segundo tras reabrir: pill brevemente "Recuperando".
- Luego cambia a "Subiendo evidencia (X / Y)" donde X avanza.
- Acaba en "Evidencia protegida" (banner verde 4s) y luego "Listo".
- En Drive web: aparecen exactamente Y archivos en `/GuardianCloud/<session_id>/`.

**PASS:**
- Todos los chunks llegan a Drive sin duplicados ni huecos.
- Pill final = "Listo".
- Sin crash al reabrir.

**FAIL:**
- Algún chunk se queda en "pending" indefinidamente (>3 min).
- App crashea al reabrir.
- Drive web muestra menos chunks que Y, o duplicados con sufijos.
- Pill se queda en "Error" sin recuperar.

---

## R2 — Force stop Android

**Severidad:** 🔴 BLOCKER
**Cobertura tests automáticos:** parcial — misma que R1; el OS-level kill solo se valida físicamente.

**Precondición:** misma que R1.

**Pasos exactos:**
1. Pulsar GRABAR. Esperar 30s. Pulsar PARAR.
2. Mientras la cola tiene pending: ir a Settings de Android → Apps → Guardian Cloud → **Force stop** (botón).
3. Confirmar el force stop.
4. Esperar 60 segundos.
5. Reabrir Guardian Cloud desde el lanzador.

**Qué observar:**
- Force stop mata el proceso Y el foreground service sin notificar a la app (más agresivo que swipe-up).
- Notif "Guardian Cloud está protegiendo tu evidencia" desaparece inmediatamente.
- Al reabrir: pill brevemente "Recuperando" → "Subiendo" → "Evidencia protegida".

**PASS:**
- Misma que R1.

**FAIL:**
- Misma que R1, plus: app crashea con `Application not responding` al reabrir.

---

## R3 — Modo avión activado antes de grabar

**Severidad:** 🔴 BLOCKER (offline-first es invariante)
**Cobertura tests automáticos:** parcial — `classifyError.test.ts` cubre `SESSION_NOT_FOUND` como transient; el replay físico de POST /sessions tras volver red no se simula.

**Precondición:**
- App abierta en Home, "Listo".
- Drive conectado.

**Pasos exactos:**
1. Activar **modo avión** (panel rápido del sistema).
2. Verificar que el icono de avión está visible en la status bar.
3. Pulsar GRABAR. (Debe iniciar pese a no haber red).
4. Esperar 30s.
5. Pulsar PARAR.
6. Esperar 30s con avión todavía activo.
7. Desactivar **modo avión**.
8. Esperar 90 segundos.

**Qué observar:**
- La grabación arranca normal aunque no haya red.
- Pill muestra "Grabando" → "Subiendo evidencia (0 / Y)" durante el avión (chunks encolados, no enviados).
- Tras desactivar avión: el contador X / Y avanza hasta Y / Y.
- Pill llega a "Evidencia protegida".
- En Drive: Y chunks presentes.

**PASS:**
- Sesión llega a "Evidencia protegida" tras restaurar red.
- Sin chunks failed.
- POST /sessions se reintenta automáticamente (verificable en logcat: `pending session register` reintenta).

**FAIL:**
- Pill queda en "Error" tras restaurar red.
- Algún chunk `failed` permanente.
- App crashea al pulsar GRABAR sin red.

---

## R4 — Pérdida intermitente de red

**Severidad:** 🔴 BLOCKER
**Cobertura tests automáticos:** parcial — `classifyError.test.ts` valida que 5xx y network errors son transient.

**Precondición:**
- App en Home, "Listo".
- WiFi conectada (NO datos móviles).

**Pasos exactos:**
1. Pulsar GRABAR.
2. A los 10s, desactivar WiFi (panel rápido).
3. Seguir grabando 10s más.
4. A los 20s, reactivar WiFi.
5. A los 25s, desactivar WiFi de nuevo.
6. A los 35s, pulsar PARAR (con WiFi off).
7. Reactivar WiFi.
8. Esperar 60s.

**Qué observar:**
- La grabación nunca se interrumpe pese a los toggles.
- El contador X / Y avanza solo cuando hay red.
- Tras 60s post-WiFi: pill llega a "Evidencia protegida".

**PASS:**
- Y chunks únicos en Drive (no duplicados, idempotencia OK).
- "Evidencia protegida".

**FAIL:**
- Chunks duplicados en Drive con mismo `chunk_index`.
- Algún chunk failed.
- Crash o congelación al toggle.

---

## R5 — Pantalla bloqueada durante grabación

**Severidad:** 🔴 BLOCKER
**Cobertura tests automáticos:** **nula** — la supervivencia del recorder al lock es OS-level, no se simula.

**Precondición:**
- App en Home, "Listo".
- POST_NOTIFICATIONS concedido (verificar que NO aparece pill amarillo "Sin notificación de fondo").
- Battery optimization concedida (Settings → Subida en segundo plano → Abrir ajustes → permitir Guardian Cloud).

**Pasos exactos:**
1. Pulsar GRABAR.
2. A los 10s, pulsar el botón de power (apagar pantalla, NO apagar móvil).
3. Esperar 90s con pantalla apagada.
4. Pulsar power para desbloquear (sin entrar al PIN — solo encender pantalla).
5. Verificar la notif "Guardian Cloud está protegiendo tu evidencia" en lockscreen.
6. Desbloquear con PIN/biométrico.
7. Pulsar PARAR.

**Qué observar:**
- Notif persistente visible durante todo el lock.
- Cronómetro de la notif crece (si está expuesto) o al menos no desaparece.
- Tras desbloquear: la app está en "Grabando", contador de tiempo coherente con los segundos transcurridos.
- Tras parar: pill llega a "Evidencia protegida".

**PASS:**
- Recorder sobrevive el lock entero (chunks generados durante el lock están en Drive).
- Notif visible todo el rato.

**FAIL:**
- Recorder muere durante lock (chunks de los segundos 10-100 ausentes en Drive).
- Notif desaparece a mitad.
- App crashea al desbloquear.

---

## R6 — Background prolongado (>5 min)

**Severidad:** 🟡 IMPORTANTE
**Cobertura tests automáticos:** **nula** — Doze es OS-level.

**Precondición:**
- App en Home, "Listo".
- Battery optimization permitida.

**Pasos exactos:**
1. Pulsar GRABAR.
2. Pulsar PARAR a los 30s.
3. Mientras la cola muestra "Subiendo evidencia (X / Y)" con X < Y: pulsar HOME (app a background, NO matar).
4. **Bloquear pantalla con power**.
5. **Dejar el dispositivo intacto 5 minutos exactos** (poner timer).
6. Encender pantalla, desbloquear, abrir la app.

**Qué observar:**
- Notif visible los 5 minutos.
- Al volver: pill ya en "Evidencia protegida" o casi (con cola residual mínima).
- Drive web: Y chunks presentes.

**PASS:**
- Pill final "Evidencia protegida" o "Listo" tras volver.
- Y chunks en Drive.

**FAIL:**
- Pill atascado en "Subiendo X / Y" con X igual a cuando se backgrounded (Doze throttled).
- Chunks ausentes en Drive.
- Notif desaparece sin que la cola haya drenado.

**Nota:** si falla en OEM agresivo (Xiaomi, etc.) pero pasa en Pixel → degrade a "limitación documentada", no bloqueador. Anotar fabricante.

---

## R7 — Reinicio del móvil con cola pendiente

**Severidad:** 🔴 BLOCKER
**Cobertura tests automáticos:** parcial — `queue.test.ts` cubre rehidratación de AsyncStorage; el cold boot OS-level no.

**Precondición:**
- App en Home, "Listo".
- Drive conectado.

**Pasos exactos:**
1. Pulsar GRABAR. 30s. Pulsar PARAR.
2. Mientras pill muestra "Subiendo evidencia (X / Y)" con X < Y:
3. Mantener pulsado el botón de power → **Reiniciar** (no apagar).
4. Esperar a que el móvil arranque completamente y se desbloquee.
5. Abrir Guardian Cloud desde el lanzador.

**Qué observar:**
- Tras reabrir: brevemente pill "Recuperando" → "Subiendo evidencia" → "Evidencia protegida".
- Drive web: Y chunks únicos.

**PASS:**
- Y chunks en Drive.
- Pill final "Listo".
- Sin chunks failed ni duplicados.

**FAIL:**
- Cola perdida (pill en "Listo" sin acabar de subir).
- App crashea al primer abrir post-reboot.
- Chunks faltantes o duplicados en Drive.

---

## R8 — OAuth de Drive expirado / revocado

**Severidad:** 🔴 BLOCKER
**Cobertura tests automáticos:** parcial — `classifyError.test.ts` valida 401 como transient; el flujo de reconexión es físico.

**Precondición:**
- App en Home con Drive conectado.

**Pasos exactos (sub-escenario A — token expirado):**
1. Esperar a que el access token caduque naturalmente (>1h sin actividad de la app).
2. Iniciar grabación 30s. Parar.

**Pasos exactos (sub-escenario B — refresh revocado):**
1. En el navegador del móvil o de un PC, ir a `myaccount.google.com/permissions` con la cuenta del tester.
2. Buscar "Guardian Cloud" → **Quitar acceso**.
3. Volver a la app.
4. Iniciar grabación 30s. Parar.

**Qué observar (A):**
- El primer chunk dispara un 401 → token refresh inline → succeeds → resto fluye normal.
- Pill nunca toca rojo.
- Drive: Y chunks.

**Qué observar (B):**
- El refresh inline falla (`DRIVE_REFRESH_FAILED`).
- Worker reintenta como transient varias veces.
- Tras saturar reintentos, pill rojo "Error".
- Mensaje humano debajo: "No se pudo enviar un fragmento. Lo demás se sigue intentando." + botón Reintentar.
- Tester va a Settings → Reconectar Google Drive → completa OAuth.
- Vuelve a Home → pulsa Reintentar.
- Chunks fluyen.

**PASS (A):** Y chunks en Drive sin pill rojo intermedio.
**PASS (B):** Tras reconectar + Reintentar, Y chunks en Drive. Sin códigos técnicos visibles en pantalla.

**FAIL:** Códigos como `DRIVE_REFRESH_FAILED` aparecen en UI. Loop infinito de reintentos sin surface error. App crash.

---

## R9 — Drive del tester lleno

**Severidad:** 🟡 IMPORTANTE
**Cobertura tests automáticos:** **nula** — depende de la respuesta real de Google Drive ante cuota llena.

**Precondición:**
- Drive conectado pero con la cuota saturada (subir archivos hasta llenarla, o usar una cuenta de test sin espacio).

**Pasos exactos:**
1. Verificar `/GuardianCloud` accesible en Drive web.
2. Iniciar grabación 30s. Parar.

**Qué observar:**
- Backend recibe error de Drive → AppError con status 4xx o 5xx.
- Si 5xx: worker reintenta indefinidamente como transient.
- Si 4xx genérico: pill rojo + "No se pudo enviar un fragmento. Lo demás se sigue intentando." + botón Reintentar.
- Tester libera espacio en Drive (borrar archivos).
- Pulsa Reintentar.
- Chunks fluyen.

**PASS:** Mensaje humano sin códigos. Tras liberar + Reintentar, chunks llegan a Drive.

**FAIL:** Mensaje técnico visible (e.g. "DRIVE_UPLOAD_FAILED"). App no expone el problema. Crash.

---

## R10 — NAS desconectado a mitad de subida

**Severidad:** 🟡 IMPORTANTE
**Cobertura tests automáticos:** parcial — backend tests cubren `NAS_NOT_CONFIGURED` y `NAS_AUTH_FAILED`; el flujo end-to-end mobile no.

**Precondición:**
- NAS WebDAV conectado y validado (test-upload OK desde Settings).
- Selector de destino apunta a NAS.

**Pasos exactos:**
1. Iniciar grabación. 30s. Parar.
2. Mientras la cola sube (X < Y): apagar el NAS físicamente o desconectar el cable Ethernet del NAS.
3. Esperar 30s.
4. Volver a la app.

**Qué observar:**
- Pill rojo "Error".
- Línea humana: "Tu NAS está desconectado." + "Reconéctalo en Configuración para que reciba las nuevas grabaciones."
- Botón Reintentar visible.
- Tester reactiva NAS.
- Pulsa Reintentar.
- Chunks restantes suben.

**PASS:** Mensaje humano correcto. Tras reactivar + Reintentar, Y archivos en NAS.

**FAIL:** Mensaje genérico no diferencia NAS de Drive. Códigos visibles. App crash.

---

## R11 — Cierre de app durante chunking de vídeo

**Severidad:** 🔴 BLOCKER
**Cobertura tests automáticos:** parcial — `normalize.test.ts` cubre stuck `uploading` reset; el chunking incompleto físico no.

**Precondición:**
- App en Home. Modo VÍDEO seleccionado en el ModeToggle.
- Drive conectado.

**Pasos exactos:**
1. Pulsar GRABAR.
2. Esperar 20 segundos (vídeo activo).
3. **Sin pulsar PARAR**: matar la app desde el switcher (swipe-up).
4. Esperar 30s.
5. Reabrir.

**Qué observar:**
- En el cierre forzado, el chunking POST-stop no se ejecuta (la app murió durante la grabación).
- Recovery al reabrir detecta entry con `recording_closed=false` y descarta o cierra correctamente.
- No deben subir chunks corruptos / parciales / con hash mismatch.
- Si hay archivo de vídeo a medias en cacheDirectory, se descarta o se procesa parcial sin contaminar Drive.

**PASS:**
- Pill final "Listo" o "Evidencia protegida parcialmente" sin chunks `failed` con HASH_MISMATCH.
- En Drive: 0 chunks o algunos chunks válidos (todos con sha256 correcto).
- App no crashea al reabrir.

**FAIL:**
- Chunks failed con HASH_MISMATCH masivo.
- Archivo .m4a/.mp4 huérfano en cacheDirectory (verificable con adb).
- Crash al reabrir.

---

## R12 — Reopen cold boot sin cola pendiente

**Severidad:** 🟡 IMPORTANTE (UX bug sutil)
**Cobertura tests automáticos:** parcial — `queue.test.ts` cubre cola vacía.

**Precondición:**
- Sesión completa anterior, todos los chunks subidos, cola reapeada.

**Pasos exactos:**
1. Verificar pill "Listo".
2. Cerrar app desde switcher (swipe).
3. Esperar 5s.
4. Reabrir desde lanzador.

**Qué observar:**
- App abre directamente en "Listo".
- NO debe mostrar "Recuperando" (no hay nada que recuperar).
- Botón GRABAR habilitado en <2s desde tap del icono.

**PASS:** Pill = "Listo" desde el primer frame visible. Sin spinner spurious "Recuperando".

**FAIL:** Pill arranca en "Recuperando" pese a cola vacía. Spinner durante varios segundos. Botón GRABAR deshabilitado más de 2s.

---

## R13 — Export post-recovery

**Severidad:** 🔴 BLOCKER (export es invariante)
**Cobertura tests automáticos:** parcial — `localEvidence.test.ts` cubre la lógica de concatenación + sha256; la descarga real desde Drive no.

**Precondición:**
- Sesión completa, todos los chunks en Drive.
- App en Home, "Listo".

**Pasos exactos:**
1. Cerrar app desde switcher.
2. Reabrir.
3. Navegar a la última sesión (vía deep link `/session/<id>` si lo tienes a mano, o histórico futuro).
4. Pulsar **Exportar**.
5. Esperar a que termine.

**Qué observar:**
- Indicador de progreso de descarga.
- Tras finalizar: comparte sheet de Android con el archivo `.m4a` (audio) o `.mp4` (vídeo).
- Compartir el archivo a Google Drive personal o Files.
- Verificar que el archivo se reproduce correctamente en un reproductor externo (VLC).

**PASS:**
- Archivo generado, compartible, reproducible.
- Duración del archivo coherente con la grabación original (±1s).

**FAIL:**
- Export crashea.
- Archivo se genera pero no se reproduce.
- Tamaño 0 bytes.
- Sha256 mismatch reportado en logs (`localEvidence` lo loguea).

---

## R14 — Recovery tras múltiples failed chunks (botón Reintentar)

**Severidad:** 🔴 BLOCKER (F3 acaba de añadir esto)
**Cobertura tests automáticos:** parcial — `queue.test.ts` valida `queueMutate` mass-flip; la UI Reintentar es físico.

**Precondición:**
- App en Home, "Listo".
- NAS conectado y elegido como destino (necesario para forzar fallos permanentes recoverable).

**Pasos exactos:**
1. Apagar NAS antes de grabar.
2. Iniciar grabación. 30s. Parar.
3. Esperar a que los chunks intenten subir y fallen.
4. Verificar pill rojo + "Tu NAS está desconectado." + botón Reintentar.
5. **Reactivar NAS** (encender o reconectar red).
6. Esperar 10s para que el NAS responda.
7. Pulsar **Reintentar**.

**Qué observar:**
- Tras pulsar Reintentar: pill rojo desaparece, vuelve a "Subiendo evidencia (X / Y)" con X creciendo.
- En logcat: `GC_QUEUE requeue_failed { flipped: N }` con N > 0.
- Llega a "Evidencia protegida".

**PASS:**
- Y archivos en NAS al final.
- Pill final "Listo".
- Sin chunks failed residuales.

**FAIL:**
- Tras Reintentar, pill vuelve a rojo en <5s con mismo error → indicaría que el flip no funcionó O que NAS no estaba realmente reconectado.
- Botón Reintentar no responde.
- Crash al pulsar Reintentar.

---

## Cobertura por tests automáticos — resumen

| Cubierto bien por tests | Cubierto parcial | NO cubierto (solo físico) |
|---|---|---|
| Migración de cola legacy → array (`migrate.test.ts`) | Stuck `uploading` reset (`normalize.test.ts`) | Force stop OS-level (R2) |
| Dedup de chunks duplicados (`normalize.test.ts`) | Rehidratación AsyncStorage (`queue.test.ts`) | Pantalla bloqueada (R5) |
| Detección de hash divergence → `CORRUPT_HASH_DIVERGENCE` (`normalize.test.ts`) | Clasificación transient/permanent (`classifyError.test.ts`) | Doze / background largo (R6) |
| Completion gate (`finalize.test.ts`) | Cola sin pending (R12) | Reboot del móvil (R7) |
| Reapping (`finalize.test.ts`, `queue.test.ts`) | Lógica `requeueFailedChunks` flips (`queue.test.ts`) | Drive lleno real (R9) |
| Estado machine (`deriveGuardianStatus.test.ts`) | Concatenación export (`localEvidence.test.ts`) | NAS físicamente caído (R10) |
| Idempotencia recovery (`queue.test.ts`) | OAuth 401 transient (`classifyError.test.ts`) | Modo avión / red intermitente (R3, R4) |

## Escenarios que SOLO se pueden validar físicamente

Sin tests automáticos posibles. Cada release **debe** ejecutarlos a mano:

- R5 (pantalla bloqueada — recorder + foreground service)
- R6 (background prolongado — Doze)
- R9 (Drive lleno real — depende de Google Drive API)

## Escenarios obligatorios antes de mandar APK a tester externo

Subset que actúa como **release gate**. Si cualquiera falla → no se manda el APK.

R1, R2, R3, R5, R7, R8, R11, R13, R14 — los nueve 🔴 BLOCKER del índice.

R4, R6, R9, R10, R12 (🟡) → ejecutar pero degradar a "limitación conocida" si OEM-específico y no afecta Pixel + 1 OEM más.
