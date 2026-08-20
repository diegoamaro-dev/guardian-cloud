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
- **No hay CI.** Los 198 tests corren sólo en la máquina del desarrollador.
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

- ngrok is temporary and not valid for production.
- Backend proxy Drive upload is acceptable for MVP, but should be reviewed before production.
- expo-av is deprecated and should later migrate to expo-audio / expo-video.
- Existing failing tests need review after the recovery flow is stabilized.
- Logs should be reduced before release.
- Export flow has no entry point from the home screen yet (reachable only via direct route `/session/:id`). A Historial brick should list past sessions and link in (see `TODO(export-history)`).
- Export accumulates the full session bytes in memory before writing. Acceptable for MVP-size recordings but will OOM on large files — switch to an incremental append (see `TODO(export-large)`).
- A partial export missing the last chunk loses the MP4 `moov` atom and the resulting .m4a is generally unplayable. File is still produced as forensic output; moov-patching is out of scope (see `TODO(export-headerless-partial)`).