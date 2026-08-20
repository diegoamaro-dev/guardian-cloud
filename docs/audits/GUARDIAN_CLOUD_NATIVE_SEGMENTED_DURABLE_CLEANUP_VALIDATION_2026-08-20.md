# Guardian Cloud — Validación física: vídeo nativo segmentado con durable cleanup/scheduler

Fecha: 2026-08-20
Rama: `feat/native-segmented-recording`
Commit validado: `07e42846c822ce7465d0ede3067fd1f7d96e60de`
APK SHA-256: `E54C1E3B27A6EDEB01DD9D67448E34449978D50B0CA8A8E6E8AE0FDB2519E7D7`
Dispositivo: OnePlus A6000 · Android 11 · API 30 · `arm64-v8a` · build `RKQ1.201217.002`

## Resultado

`HARDWARE_VALIDATED` para la ruta normal del vídeo nativo segmentado con durable
cleanup integrado, y para el recovery real de una sesión pendiente tras
restaurar la autorización de Google Drive.

El requisito crítico de producto queda demostrado físicamente:

> **la evidencia de vídeo sale del dispositivo DURANTE la grabación.**

`GC-AUD-001` deja de ser un defecto vigente.

Esta validación cubre **un solo dispositivo**. No valida multi-dispositivo,
Android 13+, recovery completo de vídeo ni export final `.mp4`.

---

## Cronología

La sesión de validación se desarrolló en tres fases sobre el mismo commit y el
mismo APK, sin reconstruir el artefacto entre fases.

### Fase 1 inicial — `FAIL_EXTERNAL_DEPENDENCY`

Primera captura productiva sobre el commit validado.

La captura nativa funcionó de forma impecable:

| Medida | Valor |
|---|---|
| Segmentos observados | 12, índices 0–11 |
| `observed_contiguous_from_zero` | `true` |
| Adopciones asentadas | 12/12 |
| Latencia cierre → cola | 189–262 ms |
| `outcome` | `closed` |

Tres segmentos cerrados se copiaron del dispositivo durante la propia captura y
se verificaron con `ffprobe`:

| Fichero | Contenedor | Vídeo | Audio | Duración | Decodificación |
|---|---|---|---|---|---|
| `seg_000.mp4` | MP4 | H.264 640×480 | AAC 44,1 kHz | 3,274 s | sin error |
| `seg_001.mp4` | MP4 | H.264 640×480 | AAC 44,1 kHz | 6,575 s | sin error |
| `seg_002.mp4` | MP4 | H.264 640×480 | AAC 44,1 kHz | 6,070 s | sin error |

Las duraciones confirman la cadencia configurada: `rotateAtMs 3000` para el
primer segmento y `rotationIntervalMs 6000` para los siguientes.

**La subida falló por completo:** 6 intentos, 12 respuestas
`DRIVE_REFRESH_FAILED`, cero subidas correctas.

Consecuencia en cadena: sin subida no hubo completion, sin completion no hubo
autorización durable, y sin autorización el runner no tuvo nada que ver. El
journal nunca llegó a crearse.

Dos comportamientos que merecen registrarse como correctos, no como suerte:

- **no se llamó a `/complete` en ningún momento** — la compuerta de completion
  rechazó una sesión cuyos chunks no estaban subidos, negándose a declarar
  completa una sesión con lagunas;
- **`complete_attempts` permaneció en 0** — el fallo era anterior a la
  completion, así que no se contabilizó como intento fallido de completion.

### Preservación de la evidencia

La sesión `0c5de74e` quedó congelada como evidencia legítima, sin manipulación
manual de ningún tipo:

| Estado preservado | Valor |
|---|---|
| Segmentos en `cache/gc-segmented-recorder/<sid>/` | 12 MP4 |
| Segmentos en `files/segments/<sid>/` | 12 MP4 |
| `recording_closed` | `true` |
| `session_completed` | `false` |
| `complete_attempts` | `0` |
| `remote_reference` | ninguno |
| Journal | **ausente** |

La clasificación transitoria del error impidió marcar los chunks como `failed`
y podar sus payloads. El sistema protegió la evidencia en lugar de descartarla.

### Causa — caducidad del refresh token bajo OAuth `External + Testing`

El código del backend produce `DRIVE_REFRESH_FAILED` por tres caminos distintos,
y el status HTTP los discrimina sin ambigüedad:

| Camino | Status al cliente |
|---|---|
| 2xx de Google sin `access_token` | 502 |
| 5xx/429 de Google con reintentos agotados | 502 |
| **No transitorio: `res.status === 400`** | **401** |

Se observó **401 en las 24 líneas de fallo**, sin excepción. Por tanto Google
devolvió **HTTP 400** al endpoint de refresh.

> **Límite de la evidencia.** El cuerpo exacto de esa respuesta —que el backend
> registra como `DRIVE_TOKEN_REFRESH_FAILED_DETAIL` y que contendría el campo
> `error` devuelto por Google— **no se obtuvo**: el backend corre en el homelab
> y no hubo acceso de solo lectura a sus logs durante la validación. Lo
> demostrado es el status `400`, no un código de error concreto.

Evidencia complementaria que acota la causa:

- **existía un refresh token almacenado**: si faltara, la guardia previa habría
  devuelto `409 DRIVE_NOT_CONNECTED` antes de contactar con Google;
- **la configuración OAuth del backend estaba completa**: si faltara alguna
  variable, la respuesta habría sido `503 DRIVE_NOT_CONFIGURED`;
- **el código no había cambiado**: sin commits en `backend/` desde el 12/08, y
  el flujo de Drive sin tocar desde el 18/05. El código que funcionó el 13/08
  era idéntico al que falló el 20/08.

Comprobación manual en Google Auth Platform:

- `Publishing status: Testing`
- `User type: External`
- scopes declarados: **ninguno**

Con la aplicación OAuth en estado `Testing`, Google caduca los refresh tokens a
los **7 días**. La última subida correcta a Drive fue el **13/08** y el fallo se
produjo el **20/08**: exactamente 7 días.

### Conclusión sobre la causa, y su grado de certeza

**Lo demostrado por observación directa:**

1. existía un refresh token almacenado;
2. Google devolvió `HTTP 400` durante el refresh;
3. la aplicación OAuth estaba en `External + Testing`;
4. el último funcionamiento correcto fue el 13/08 y el fallo el 20/08;
5. tras pasar a `In production` y reconectar, Drive volvió a funcionar y las 12
   subidas pendientes se completaron sin un solo fallo.

**Lo no obtenido:** el cuerpo de la respuesta de Google
(`DRIVE_TOKEN_REFRESH_FAILED_DETAIL`) y, con él, el campo `error` exacto. No se
observó `invalid_grant` directamente.

**Conclusión.** La causa es la **caducidad del refresh token**, sustentada de
forma fuerte por la configuración —`External + Testing` caduca refresh tokens a
los 7 días— y por una correlación temporal exacta de 7 días entre el último uso
correcto y el fallo, con el código del backend sin cambios en ese intervalo y
con la recuperación posterior a la corrección. Es una inferencia sólida, no una
lectura directa del código de error de Google.

### Corrección aplicada manualmente

Realizada por el propietario del proyecto en la consola de Google, sin cambios
de código:

1. scopes declarados en «Acceso a los datos»:
   `https://www.googleapis.com/auth/drive.file` y
   `https://www.googleapis.com/auth/userinfo.email`;
2. ambos aparecen clasificados por Google Auth Platform como **no sensibles**;
3. `Publishing status` cambiado a **`In production`**;
4. redirect de producción confirmado:
   `https://api.guardiancloud.app/auth/drive/callback`.

Detalle de configuración en
[`OAUTH_DRIVE_CONFIGURATION.md`](../OAUTH_DRIVE_CONFIGURATION.md).

### Fase 2 — recovery real de la sesión preservada · `PASS`

Objetivo: comprobar que una sesión pendiente sobrevive a una caída de
credenciales y converge cuando la autorización se restaura.

Orden de ejecución: logging activo **antes** de abrir la app, sin manipular
`GC_QUEUE`, journal ni segmentos en ningún momento.

Estado al arrancar:

| Evento | Valor |
|---|---|
| `GC_BOOT_QUEUE_PENDING` | `entries 1 · pending 11 · uploading 1 · failed 0` |
| `GC_BOOT_STUCK_UPLOAD_RESET` | **`count: 1`** — el chunk en vuelo devuelto a `pending` |
| `GC_CLEANUP_REQUESTED` | `boot` |

La reconciliación de sesiones stale consultó al backend y **se negó a segar la
sesión**: `backend_uploaded: 0`, `expected: 12`,
`reason: "backend_count_below_expected"`, con `reconciled: 0`. En consecuencia
el trigger `stale_reconciled` no se disparó, que es el comportamiento correcto.

Subidas antes y después de reconectar Drive:

| | Intentos | Éxitos | `DRIVE_REFRESH_FAILED` |
|---|---|---|---|
| Antes | 4 | 0 | 8 |
| Después | 12 | **12** | **0** |

Secuencia de finalización observada, sin reiniciar la app:

```
POST /sessions/<sid>/complete            <- único
GC_CLEANUP_AUTHORIZED      http_200
GC_CLEANUP_REQUESTED       finalized
GC_QUEUE session completed               <- mark + reap correctos
GC_CLEANUP_RECONCILE_START candidates 1 · cap 8
GC_CLEANUP_RESULT          native_cache      CLEANED · removed 12
GC_CLEANUP_RESULT          stable_segments   CLEANED · removed 0
GC_CLEANUP_DROPPED
GC_CLEANUP_RECONCILE_DONE  cleaned 1 · dropped 1 · blocked 0 · tombstones 0
```

`stable_segments removed: 0` no es una anomalía: el worker borra cada fichero
local en cuanto el chunk queda confirmado en backend y en Drive, así que el
cleanup solo tuvo que retirar el directorio ya vacío, con `remaining: 0`.

### Fase 1 limpia — `PASS`

Captura nueva sobre el mismo commit y el mismo APK, con Drive sano, `GC_QUEUE`
vacía y journal sin entradas activas.

**Evidencia del requisito crítico:**

| Medida | Valor |
|---|---|
| Primer segmento cerrado y adoptado | **+9,724 s** |
| **Primera subida confirmada** | **+14,619 s** |
| **PARAR** | **+75,514 s** |
| **Margen** | **60,895 s** |
| Chunks confirmados **antes** de PARAR | **11 de 12** (índices 0–10) |

La última confirmación previa a la parada, el chunk 10, llegó a **+75,382 s** —
132 ms antes de PARAR. Solo el chunk 11, cerrado por la propia pulsación, subió
después.

Línea temporal completa:

```
   +9.724s  segmento cerrado + adoptado   seg 0
  +14.619s  SUBIDA CONFIRMADA             chunk 0
  +15.610s  segmento cerrado + adoptado   seg 1
  +20.708s  SUBIDA CONFIRMADA             chunk 1
     ...    cadencia regular ~6 s         seg 2..10 / chunk 2..9
  +70.498s  segmento cerrado + adoptado   seg 10
  +75.382s  SUBIDA CONFIRMADA             chunk 10
  +75.382s  segmento cerrado + adoptado   seg 11
  +75.514s  =========== PARAR ===========
  +79.634s  SUBIDA CONFIRMADA             chunk 11
  +79.663s  POST /sessions/<sid>/complete
  +80.533s  GC_CLEANUP_AUTHORIZED         http_200
  +80.533s  requestCleanup                finalized
  +80.533s  mark + reap OK
  +80.533s  reconcile START               candidates 1 · cap 8
  +80.533s  cleanup CLEANED               native_cache      removed 12
  +80.533s  cleanup CLEANED               stable_segments   removed 0
  +80.533s  journal DROPPED
  +80.533s  reconcile DONE                cleaned 1 · dropped 1 · blocked 0
```

Cifras exactas:

| Métrica | Valor |
|---|---|
| Segmentos totales | 12, `observed_contiguous_from_zero: true` |
| Subidas antes de PARAR | 11 |
| Subidas totales | 12, índices 0–11 |
| Fallos de subida | 0 |
| `/complete` | **1** |
| `RECONCILE_START` / `DONE` | 1 / 1 — sin pasadas concurrentes |
| `requestCleanup` | 2 (`boot` + `finalized`), 0 coalesced |
| `SCHEDULER_FAILED` · `AUTHORIZE_REJECTED` · give-ups | 0 · 0 · 0 |

---

### Prueba dirigida — frontera de borrado exclusiva por journal · `PASS`

Las fases anteriores demuestran que el cleanup converge, pero no que el runner
**discrimine activamente**: sólo que nada indebido se borró. Esta prueba cierra
esa diferencia.

**Diseño.** Colocar dos directorios indistinguibles de una sesión real —UUID
canónico v4, un `seg_000.mp4` dentro— pero **sin entrada en el journal**, y
ejecutar acto seguido una pasada real provocada por una sesión sí autorizada. Si
el runner los ignora mientras borra la sesión autorizada, la frontera queda
demostrada por discriminación, no por inacción.

**UUID centinela:** `ad5a9231-05a3-49d0-8d18-dfb0e61f7156`, generado para esta
prueba y sin haber pertenecido nunca a ninguna sesión.

**Precondiciones, verificadas por lectura lógica.** Con la aplicación detenida y
sin ficheros WAL/SHM presentes, se copió `RKStorage` al host y se consultó con
SQLite el valor vigente de cada clave —no por coincidencia binaria, que puede
devolver residuos de páginas liberadas—:

| Clave | Lectura lógica |
|---|---|
| `test.pending_retry` | array, **0 entradas** |
| `guardian.segment_cleanup.v1` | version 1, **0 entradas** |

Como comprobación complementaria, la búsqueda binaria del UUID sobre el fichero
completo —incluidas páginas liberadas— devolvió **0 coincidencias**: nunca había
aparecido.

**Centinelas colocados:**

| Ruta | Tamaño | SHA-256 |
|---|---|---|
| `cache/gc-segmented-recorder/<uuid>/seg_000.mp4` | 39 B | `fd964672…f61ccbe0` |
| `files/segments/<uuid>/seg_000.mp4` | 42 B | `35bdedd8…cd804dc2` |

Contenido: texto plano identificable, deliberadamente no multimedia. Los hashes
se calcularon en el host sobre el contenido leído del dispositivo.

**Contraste previo.** Un arranque con los centinelas ya colocados y el journal
vacío emitió `GC_CLEANUP_REQUESTED {reason:"boot"}` y **cero**
`GC_CLEANUP_RECONCILE_START`: sin candidatos, el runner retorna antes de
enumerar directorio alguno. Ese arranque, por sí solo, no demostraría
discriminación.

**Pasada real.** Una captura corta generó la sesión `ffabe3a1` con 5 segmentos
contiguos, que completó y autorizó cleanup:

```
GC_CLEANUP_AUTHORIZED       http_200 · ffabe3a1
GC_CLEANUP_REQUESTED        finalized
GC_CLEANUP_RECONCILE_START  candidates 1 · cap 8
GC_CLEANUP_RESULT           native_cache      CLEANED · removed 5
GC_CLEANUP_RESULT           stable_segments   CLEANED · removed 0
GC_CLEANUP_DROPPED          ffabe3a1
GC_CLEANUP_RECONCILE_DONE   considered 1 · cleaned 1 · dropped 1 · blocked 0
```

**Resultado.**

| Criterio | Resultado |
|---|---|
| **A** · el runner elimina los recursos de la sesión autorizada | ✅ `ffabe3a1` retirada de ambos recursos |
| **B** · centinelas sin journal byte-identical | ✅ mismo nombre, mismo tamaño, **mismo SHA-256** en ambos |
| **C** · históricos intactos | ✅ `diff` idéntico; la única diferencia era el propio centinela |

Cero menciones del prefijo `ad5a9231` en todo el tramo de log: ni
`GC_CLEANUP_AUTHORIZED`, ni `GC_CLEANUP_RESULT`, ni `GC_CLEANUP_DROPPED`, ni
ninguna otra.

**La evidencia decisiva es `considered: 1`.** Durante esa pasada existían tres
directorios de apariencia idéntica: la sesión real y los dos centinelas. El
runner consideró **uno**. No es que no se ejecutara —se ejecutó, enumeró
candidatos desde el journal— sino que sólo el autorizado era visible:

```
authorized  -> eligible for cleanup
no journal  -> invisible
```

**Retirada.** Tras registrar PASS se eliminaron exclusivamente los dos
directorios creados por la prueba. Estado final: **4 y 12 directorios**, con
`diff` idéntico a la baseline, y `GC_QUEUE` y journal de nuevo con 0 entradas
por lectura lógica.

Como observación adicional, `GC_ORPHAN_SCAN_DONE {found: 0, scanned: 0}`
confirmó en dispositivo que el escaneo de huérfanos no recursa y no pudo adoptar
los centinelas.

---

## Convergencia y preservación

En las dos fases que alcanzaron completion, el estado final fue idéntico:

| Marcador | Resultado |
|---|---|
| `chunk_index` en `GC_QUEUE` | 0 — cola convergida |
| `session_completed` · `complete_attempts` | entrada retirada |
| Journal | convergido vía `GC_CLEANUP_DROPPED`, sin entradas activas |
| Directorios de la sesión | retirados en ambos recursos |

**Preservación de sesiones sin journal.** Los 4 directorios de
`cache/gc-segmented-recorder/` y los 12 de `files/segments/` anteriores a esta
validación sobrevivieron intactos a **cuatro** pasadas completas de cleanup. Se
verificó por comparación exacta de listados contra la línea base tomada antes de
la Fase 1: **idénticos en ambos casos**.

Esa evidencia es pasiva. La prueba dirigida con centinelas, descrita más arriba,
la eleva a discriminación activa demostrada.

---

## Alcance de esta validación

Queda `HARDWARE_VALIDATED` en OnePlus A6000 / Android 11 / API 30 / `arm64-v8a`:

- grabación nativa segmentada;
- segmentos MP4 independientes y válidos;
- adopción durante la captura;
- **subida de vídeo durante la captura**;
- completion normal;
- autorización durable posterior a completion confirmada;
- durable cleanup/scheduler en la ruta normal;
- `finalized` con cleanup sin reiniciar la app;
- **frontera de borrado exclusiva por journal**, demostrada por discriminación
  activa con directorios centinela;
- recovery real de una sesión pendiente tras restaurar Drive;
- una única llamada `/complete` en los escenarios observados.

**No queda validado por estas pruebas:**

- recovery completo de vídeo;
- export final `.mp4`;
- validación multi-dispositivo;
- Android 13+;
- las rutas artificiales de fallo del scheduler.

---

## Pendiente

Reclasificación del Escenario 17 tras esta validación:

| Punto | Estado |
|---|---|
| 1–4 · captura, MP4 válidos, adopción, completion, autorización, `finalized` sin reinicio | `HARDWARE_VALIDATED` |
| 5 · boot no bloqueante **con trabajo durable real** | `HARDWARE_HARDENING_PENDING` |
| 6 · trigger `stale_reconciled` (caso positivo) | `HARDWARE_HARDENING_PENDING` |
| 7–8 · fallo de reap posterior a completion y reap diferido exitoso | `HARDWARE_HARDENING_PENDING` |
| 9 · frontera de borrado exclusiva por journal | **`HARDWARE_VALIDATED`** |

Los puntos 5–8 comparten un rasgo: su peor caso es limpieza diferida, no pérdida
de evidencia. El journal es durable, de modo que un trigger que no se dispara o
un reap que falla dejan el trabajo pendiente para el siguiente arranque. No
bloquean el principio crítico de producto, ni la validación de la ruta normal,
ni la integración de esta rama.

**No queda ningún gate bloqueante del Escenario 17 antes de integrar la rama.**
El punto 9 era el único cuyo fallo habría borrado datos del usuario en lugar de
retrasar una limpieza, y quedó cerrado con la prueba dirigida de centinelas.

---

## Deuda descubierta durante esta validación

`DRIVE_REFRESH_FAILED` se clasifica en el cliente como transitorio por coincidir
con `status === 401`, antes de considerar el código específico. El backend emite
ese 401 con la intención explícita de que la interfaz solicite reconectar, pero
el cliente decide por status antes que por código.

Observado: 12 reintentos con backoff creciente, cero progreso y ninguna señal al
usuario. La evidencia queda protegida —transitorio es la clasificación segura,
ya que permanente habría podado los payloads— pero el usuario no recibe
indicación de que debe reconectar Drive.

Registrada en [`KNOWN_DEBT.md`](../KNOWN_DEBT.md). Es deuda **separada** del
durable cleanup scheduler y no se ha corregido.

---

## Desviaciones de protocolo

1. **JDK 17 en lugar de JDK 21.** No existe ningún JDK 21 en la máquina de
   construcción; JDK 17 es el entorno con el que este commit obtuvo
   `BUILD SUCCESSFUL` previamente. Documentado antes de construir.
2. **Duraciones de captura de ~69 s y ~75,5 s** frente a los ~60 s nominales.
   La duración la controló manualmente el operador por decisión de protocolo,
   para no situar la temporización del asistente en el camino crítico. No afecta
   a ningún criterio.
3. **Timeout del dev client al cargar el bundle** en el primer intento de la
   Fase 2, resuelto precompilando el bundle. Sin impacto: cero eventos JS, la
   aplicación no llegó a acceder a `GC_QUEUE`.
