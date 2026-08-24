# KNOWN_DEBT.md

## Deuda registrada en la baseline `v0.3.0-rc.1` (2026-07-30)

Detalle completo en [`releases/v0.3.0-rc.1.md`](./releases/v0.3.0-rc.1.md) §7.

### Versionado — bloquea cualquier release pública

- La etiqueta `v0.3.0-rc.1` marca un punto de git, **no** una versión de app: la
  aplicación declara `0.1.0` con `versionCode 1` en `package.json`,
  `app.config.ts` y `build.gradle`. La casilla del checklist «versión
  actualizada a `0.3.x`» sigue sin cumplir.
- `eas.json` declara `appVersionSource: "remote"` pero **no hay versiones
  remotas configuradas**. Hay que decidir el esquema antes de publicar.

### TypeScript y CI

- **12 errores heredados**; el typecheck **no** está verde. 6 en `app.config.ts`
  (tipos de `ExpoConfig`/`ManifestService`), 4 en `app/index.tsx` y 2 en
  `src/api/*` (`Uint8Array<ArrayBufferLike>` vs `BufferSource`/`BodyInit`).
- **No hay CI.** Los tests corren sólo en la máquina del desarrollador — **781
  el 2026-08-23**, sobre `34412a0`. *(Esta línea decía «los 198 tests»: la
  cifra era del corte de `v0.3.0-rc.1`; la deuda de CI no ha cambiado.)*
- `npm ci` **falla** sin `--legacy-peer-deps`: el lockfile no materializa los
  peers `react-dom` y `scheduler`.
- 29 vulnerabilidades de `npm audit` (1 baja, 17 moderadas, 8 altas, 3
  críticas). Sin resolver.

### Cobertura de pruebas

- La rama **Android 13+** de `POST_NOTIFICATIONS` —la mitad del propósito de la
  ReliabilityCard— **nunca se ha ejercitado**. Requiere un dispositivo con
  SDK ≥ 33; la validación se hizo en Android 11.
- Sin Closed Testing y sin usuarios externos.

### Ambigüedades UX residuales de A-2

- **Banner verde genérico**: dos vías de activación producen el mismo resultado
  visual, y el texto no identifica la sesión. Puede aparecer mientras se graba
  otra captura.
- **Carrera polling ↔ `reap`**: Home lee `GC_QUEUE` cada 500 ms; el worker puede
  reapar una entrada antes de que un tick la observe. Protección lógica y
  observación por polling no son equivalentes.
- **Sesión cerrada, asentada e incompleta** (fragmentos `uploaded` sin
  `remote_reference`) cae en `Listo` sin informar de que queda evidencia sin
  confirmar.
- La ReliabilityCard **desplaza el botón principal** hacia abajo en Home.
- El botón legacy de exención de batería en Ajustes coexiste a propósito con la
  tarjeta; su retirada está diferida.
- **`Subiendo evidencia` con la cola pausada** *(UX observation, 2026-08-24 — no
  es finding abierto)*. Con `uploading: 0` y el drain saliendo por
  `all remaining entries paused`, Home rotula en ámbar **«Subiendo evidencia»**:
  afirma una actividad que no está ocurriendo. Las dos líneas de apoyo sí eran
  exactas —«Todavía no protegido fuera del dispositivo» y «Sin destino
  conectado»—, así que el usuario no queda engañado sobre el riesgo, sólo sobre
  el mecanismo. Observado durante la revalidación de `GC-DEST-PAUSE-001`, en 261
  ciclos consecutivos de drain pausado. **Sin investigar y sin corregir**: se
  registra para no perderlo. Es claridad de estado, no integridad — no se pierde
  evidencia.

### Repositorio

- Tres ficheros basura versionados en la raíz: `table-nas-routing`,
  `tash push -u -m wip remaining mobile assets docs`, `tash show --stat`.
  Restos de comandos `git stash` mal tecleados.
- El proyecto EAS anterior (`65029e8e-1af4-4070-80ce-4d6a1b4baa01`) quedó
  inaccesible y fue abandonado.
- `expo prebuild --clean` **destruye** las personalizaciones de
  `mobile/android/` versionadas. No es un paso rutinario; ver
  `RELEASE_CHECKLIST_v0.3.md` §3.1.

---

## Deuda descubierta durante hardware validation (2026-08-20)

### `DRIVE_REFRESH_FAILED` se clasifica como transitorio sin avisar al usuario

**Qué ocurre.** El cliente móvil clasifica **cualquier** `401` como transitorio
antes de mirar el código de error específico. El backend emite `401` con código
`DRIVE_REFRESH_FAILED` precisamente para que la interfaz pida reconectar Drive,
pero el cliente decide por status antes que por código, así que ese propósito
nunca se cumple.

**Consecuencia observada** durante la validación del 20/08:

- la evidencia queda **preservada** — transitorio es la clasificación segura,
  ya que permanente habría marcado los chunks como `failed` y podado sus
  payloads;
- los reintentos continúan indefinidamente, con backoff acotado a 30 s;
- **el usuario no recibe ninguna señal** de que debe reconectar Drive.

Se registraron 12 reintentos consecutivos con cero progreso y ningún aviso.

**Naturaleza.** Es un defecto de observabilidad, **no de integridad**: no se
pierde evidencia. Por eso es deuda y no un bloqueo.

**Corrección mínima prevista, no implementada:** comprobar
`code === 'DRIVE_REFRESH_FAILED'` antes que el status y exponer un estado de
reconexión, conservando la reintentabilidad para no poner en riesgo la
evidencia ya encolada.

Deuda **separada** del durable cleanup scheduler. Diagnóstico completo en
[`audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md`](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md);
configuración implicada en [`OAUTH_DRIVE_CONFIGURATION.md`](./OAUTH_DRIVE_CONFIGURATION.md).

---

## Known technical debt

> **Convención.** Una entrada nunca se borra. Cuando deja de ser cierta se
> antepone `**RESOLVED**` o `**RECLASSIFIED**` con la fecha y lo que la
> acredita, y el texto original se conserva. Saber que algo fue deuda y por qué
> dejó de serlo vale más que una lista corta.

- ngrok is temporary and not valid for production.
  **RESOLVED (2026-07-28)** — sustituido por Cloudflare Tunnel; ver
  [`CLOUDFLARE_TUNNEL_SETUP.md`](./CLOUDFLARE_TUNNEL_SETUP.md).
- Backend proxy Drive upload is acceptable for MVP, but should be reviewed before production.
- expo-av is deprecated and should later migrate to expo-audio / expo-video.
  **RECLASSIFIED (2026-08-23)** — la migración del **camino de grabación** ya se
  hizo: `mobile/src/audio/audioEngine.ts:47` importa de `expo-audio`. Lo que
  queda es distinto y menor: `expo-av` sigue en `package.json`
  (`~16.0.8`) y sólo lo importan las dos rutas `app/debug-camera-probe/`. La
  deuda vigente es **retirar esas rutas y la dependencia**, no migrar el motor.
  Registrado como `F-15` en el plan de remediación, sin ejecutar.
  > Cuidado: [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §1 documenta una limitación
  > real de `expo-av` con `Audio.Recording` huérfano. **Sigue siendo contexto
  > obligatorio** — describe el motor histórico y el porqué de varias guardas.
- Existing failing tests need review after the recovery flow is stabilized.
  **RESOLVED (2026-08-23)** — la suite está en 781/781 sin tests saltados. El
  typecheck sigue en 12 errores heredados, que es deuda aparte y está arriba.
- Logs should be reduced before release.
- Export flow has no entry point from the home screen yet (reachable only via direct route `/session/:id`). A Historial brick should list past sessions and link in (see `TODO(export-history)`).
  **RESOLVED** — `mobile/app/history.tsx` existe (382 líneas) y
  `mobile/app/index.tsx:8094` navega con `router.push('/history')`. La
  auditoría de trazabilidad ya lo había marcado obsoleto como defecto `D14`.
- Export accumulates the full session bytes in memory before writing. Acceptable for MVP-size recordings but will OOM on large files — switch to an incremental append (see `TODO(export-large)`).
- A partial export missing the last chunk loses the MP4 `moov` atom and the resulting .m4a is generally unplayable. File is still produced as forensic output; moov-patching is out of scope (see `TODO(export-headerless-partial)`).

---

## Lo que NO es deuda y no vive aquí

Los findings del bloque de identidad, destino y herramientas (21/08 – 23/08)
**no son deuda técnica**: unos son release blockers y otros defectos abiertos.
Se registran en otro sitio y no deben duplicarse aquí.

| Dónde | Qué contiene |
|---|---|
| [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §1–§5 | `GC-AUTH-MIGRATION-001`, `GC-DEST-PAUSE-001`, `GC-DEV-RESET-001`, `GC-AUTH-SESSION-RECOVERY-001` y el límite de `expo-av` |
| [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md#findings-abiertos-de-identidad-destino-y-herramientas) | Tabla de estado de los ocho findings |
| [`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md) §0 | Invariante bloqueante de migración de identidad |

`GC-AUTH-SESSION-RECOVERY-001` y `GC-AUTH-RETRY-CLASSIFICATION-001` pasaron a
tener registro propio en [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §5 al cerrar
D2-B y D2-C.

`GC-START-LATENCY-001` y `GC-DEST-STATUS-001` **siguen sin documento propio en
`docs/`**; sus fichas están congeladas fuera del repositorio. Esa asimetría es
la deuda documental vigente más relevante.