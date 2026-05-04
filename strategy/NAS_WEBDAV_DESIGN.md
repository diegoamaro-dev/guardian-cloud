# Guardian Cloud — NAS WebDAV MVP (Diseño técnico)

> Estado: **diseño**. Ningún código escrito todavía. Este documento
> describe los cambios mínimos para añadir NAS WebDAV como destino
> paralelo a Google Drive **sin tocar** GC_QUEUE, upload worker,
> chunking, export ni Drive.

Complementa `NAS_DESTINATION_PLAN.md` (que cubre el "qué" y el "por
qué" de WebDAV vs SMB/SFTP). Aquí va el "cómo" y el "en qué orden".

---

## 1. Análisis de la arquitectura actual

### 1.1 Persistencia de destino (`destinations` table)

`backend/migrations/0003_init_destinations.sql`:

```sql
CREATE TABLE destinations (
  id, user_id,
  type            text NOT NULL CHECK (type IN ('drive')),  -- ← bloqueado a 'drive'
  status          text NOT NULL DEFAULT 'connected'
                  CHECK (status IN ('connected', 'revoked', 'error')),
  refresh_token   text,    -- Google OAuth refresh token
  folder_id       text,    -- Drive folder id (/GuardianCloud)
  account_email   text,    -- display only
  ...
  UNIQUE (user_id, type)
);
```

Una destination por (user, type). RLS habilitada sin policies — todo
acceso vía service role desde el backend.

### 1.2 Esquema zod del endpoint de save

`backend/src/schemas/destinations.schema.ts` actualmente `type:
z.literal('drive')`. El comentario ya admite expansión futura.

### 1.3 Servicio de destination

`backend/src/services/destinations.service.ts` ya es genérico
(`type: DestinationType`). Solo el `type` declarado limita.

### 1.4 Camino del chunk upload

```
mobile uploadChunkBytes
   │
   └──► POST /destinations/drive/chunks   ← URL hardcoded
            │
            ├── header validation (X-Session-Id, X-Chunk-Index, X-Hash)
            ├── body integrity (sha256 == X-Hash)
            ├── session ownership check (active + owned)
            ├── DB-layer dedupe (chunks row exists con remote_reference)
            ├── destination lookup (getDestinationWithSecretForUser('drive'))
            ├── token refresh (getAccessToken)
            ├── Drive-layer dedupe (filename determinista en Drive)
            ├── upload (Google Drive simple multipart)
            └── 200 { remote_reference, dedup }
```

`uploadChunkBytes` (mobile) nunca conoce el provider — es el `URL`
quien decide. Para añadir NAS, el cambio fundamental es: **a la hora de
subir un chunk, mobile elige el URL según el tipo de destination
conectado del usuario**.

### 1.5 Queue independiente del destino

`PendingQueueEntry` no guarda `destination_type`. La cola es
destination-agnóstica. Esto es bueno: NAS no obliga a tocar la cola.

### 1.6 Export

`exportSession` lee chunk metadata vía `GET /sessions/:id/chunks` y
descarga vía `GET /sessions/:id/chunks/:index/download`. La ruta de
download HOY hace `getAccessToken(refresh_token)` + `downloadFile` de
Drive. Para NAS hay que añadir un branch en el download proxy.

---

## 2. Diseño mínimo NAS WebDAV

### 2.1 Principios

1. **Destino paralelo**, no sustituto. Drive queda intacto; NAS se
   añade al lado.
2. **Una destination activa por usuario** en MVP. El usuario tiene
   Drive O NAS, no ambos a la vez. (Migrar a multi-destination en
   v0.4+ no requiere romper esto.)
3. **Cero cambios** en GC_QUEUE, worker, chunking, export client.
4. **Mismo contrato wire** para chunks: `X-Session-Id`,
   `X-Chunk-Index`, `X-Hash`, body raw octet-stream. El backend ya
   tiene esa pieza con Drive — la copiamos casi verbatim para NAS.
5. **Credenciales NAS nunca llegan al cliente**. El backend las guarda
   y proxia las subidas igual que hoy con Drive.

### 2.2 Adapter pattern en backend

Backend gana un módulo `destinations/adapters/` con dos
implementaciones de la misma interfaz:

```ts
interface DestinationAdapter {
  uploadChunk(opts: {
    userId: string;
    sessionId: string;
    chunkIndex: number;
    hash: string;
    body: Buffer;
  }): Promise<{ remote_reference: string; dedup: 'db' | 'remote' | null }>;

  downloadChunk(opts: {
    userId: string;
    remote_reference: string;
  }): Promise<Buffer>;

  testConnection(userId: string): Promise<{ ok: true; details?: string }>;
}
```

- `DriveAdapter` = el código actual envuelto.
- `WebDavAdapter` = nuevo.

Los routes existentes de chunks/export delegan al adapter del tipo de
destination del usuario. Esto NO refactoriza `drive.service.ts` —
`DriveAdapter` simplemente lo invoca.

### 2.3 Selección de adapter

Una sola función: `resolveDestinationAdapter(userId)` lee la única
destination conectada del usuario y devuelve el adapter correcto.
Rechaza con 409 `MULTIPLE_ACTIVE_DESTINATIONS` si en el futuro hay más
de una.

---

## 3. Backend endpoints

### 3.1 Migración DB (nueva)

`backend/migrations/0004_destinations_nas.sql`:

```sql
-- Añade NAS al CHECK constraint y nuevos campos opcionales.
ALTER TABLE destinations DROP CONSTRAINT IF EXISTS destinations_type_check;
ALTER TABLE destinations ADD CONSTRAINT destinations_type_check
  CHECK (type IN ('drive', 'nas'));

-- Campos NAS. Todos nullable para no romper filas Drive existentes.
ALTER TABLE destinations
  ADD COLUMN webdav_base_url       text,         -- p.ej. https://nas.example.com/guardian-cloud
  ADD COLUMN webdav_username       text,
  ADD COLUMN webdav_password_enc   text,         -- AES-256-GCM, key del backend env
  ADD COLUMN webdav_folder_path    text;         -- subcarpeta opcional dentro del base_url
```

`refresh_token`, `folder_id`, `account_email` quedan nullable y solo
se usan para Drive. Cero migración de datos — solo schema.

### 3.2 Endpoints nuevos

| Método + path | Propósito |
|---|---|
| `POST /destinations/nas/connect` | Body: `{ base_url, username, password, folder_path? }`. Hace test de conexión (PROPFIND) + cifra password + upserta la fila. Devuelve `PublicDestination` (sin credenciales). |
| `POST /destinations/nas/test-upload` | Análogo a `/destinations/drive/test-upload`. Sube un fichero `guardian-cloud-test-<ts>.txt` al WebDAV. Confirma plumbing extremo-a-extremo. |
| `POST /destinations/nas/chunks` | **MISMO contrato** que `/destinations/drive/chunks` (mismos headers, mismo body, mismo response shape). Internamente usa `WebDavAdapter`. |
| `DELETE /destinations/nas` | Desconecta NAS (status='revoked' + borra credenciales cifradas). |

### 3.3 Endpoints modificados (mínimamente)

| Endpoint | Cambio |
|---|---|
| `GET /destinations` | Sin cambios de contrato, ya devuelve array genérico. La proyección `PublicDestination` añade campos `webdav_base_url`, `webdav_folder_path`, `webdav_username` (no password). |
| `GET /sessions/:id/chunks/:index/download` | Branch nuevo: si la destination es NAS, usa `WebDavAdapter.downloadChunk()` con la URL absoluta como `remote_reference`. Si es Drive, código actual sin tocar. |

**NO se toca** `/destinations/drive/connect`, `/destinations/drive/chunks`,
`/destinations/drive/test-upload`. Drive intocable.

### 3.4 OAuth callback

NAS NO tiene OAuth. El callback `/auth/drive/callback` queda intacto y
no aplica a NAS.

---

## 4. Campos de configuración

### 4.1 Inputs del usuario en mobile

Settings → "Configurar NAS WebDAV":

| Campo | Tipo | Validación cliente |
|---|---|---|
| URL del servidor | text | `https://...` o `http://...` (loopback only); valid URL |
| Usuario | text | non-empty, ≤ 256 chars |
| Contraseña | secure text | non-empty, ≤ 1024 chars |
| Carpeta destino | text optional | si vacía → raíz del WebDAV; si presente, usa subcarpeta |
| Botón "Probar conexión" | — | dispara `POST /destinations/nas/test-upload` |

### 4.2 Storage server-side

- `webdav_password_enc`: cifrado **AES-256-GCM** con clave del env
  `WEBDAV_ENCRYPTION_KEY` (32 bytes, base64). Nonce aleatorio por
  fila guardado **al inicio del campo** (`<nonce_b64>.<ciphertext_b64>`).
- Nueva env var `WEBDAV_ENCRYPTION_KEY` añadida a `env.ts` schema
  (opcional, requerida solo si NAS está habilitado).
- `getDestinationWithSecretForUser` extiende su shape para devolver
  password descifrado **solo cuando se llama desde el adapter**.
  La proyección `toPublic` jamás expone el cifrado ni el plaintext.

### 4.3 `remote_reference` para NAS

Para Drive es el `file_id` de Google. Para NAS, la URL absoluta del
recurso en el servidor:

```
https://nas.example.com/guardian-cloud/<sessionId>/<chunkIndex>.chunk
```

Almacenada en `chunks.remote_reference` exactamente como hoy. `chunks`
table no se toca.

---

## 5. Errores y retries

### 5.1 Mapeo de errores WebDAV → AppError

| WebDAV / red | Status | Code | Clasificación cliente |
|---|---|---|---|
| Timeout / DNS / TCP fail | 0 | `NETWORK_ERROR` | transient (worker retries) |
| 401 Unauthorized | 401 | `NAS_AUTH_FAILED` | transient en MVP (token refresh no aplica; user re-conecta) |
| 403 Forbidden | 403 | `NAS_FORBIDDEN` | permanent (permisos NAS mal) |
| 404 (PROPFIND a recurso) | 404 | `NAS_FOLDER_NOT_FOUND` | permanent en upload, transient en download (file gone) |
| 409 Conflict (carpeta ya existe en MKCOL) | — | manejar internamente, no propagar |
| 413 Payload Too Large | 413 | `NAS_BODY_TOO_LARGE` | permanent |
| 5xx | 5xx | `NAS_API_FAILED` | transient |
| Cert TLS inválido | — | `NAS_TLS_INVALID` | permanent (user revisa cert) |

`classifyError` en mobile **ya cubre** la mayoría — el código nuevo
`NAS_AUTH_FAILED` se añade a la rama transient junto a `SESSION_NOT_FOUND`.

### 5.2 Dedupe NAS (dos capas, igual que Drive)

1. **DB layer**: `findExistingChunkRemoteReference` ya existe y es
   provider-agnóstico. Lo reutilizamos sin tocar.
2. **WebDAV layer**: PROPFIND al filename determinista
   `<sessionId>/<chunkIndex>.chunk`. Si responde 200 con el mismo
   tamaño → return existente. Si 404 → upload.

### 5.3 Recovery

`reapEntry` borra el chunk localmente. NAS NO necesita lógica de
limpieza específica — la cola y el worker son destination-agnósticos.

### 5.4 Refresh token / sesión

NAS usa Basic auth o digest sobre HTTPS. No hay token a refrescar.
`getAccessToken` (Drive-only) no se toca.

---

## 6. Cambios exactos en mobile

### 6.1 `mobile/src/api/destinations.ts`

Añade (sin tocar lo de Drive):

```ts
export interface NasConnectInput {
  base_url: string;
  username: string;
  password: string;
  folder_path?: string;
}
export function connectNas(input: NasConnectInput): Promise<{ destination: PublicDestination }>;
export function nasTestUpload(): Promise<DriveTestUploadResponse>;  // mismo shape
export function disconnectNas(): Promise<void>;
```

### 6.2 `mobile/app/index.tsx` — `uploadChunkBytes` selector

**Cambio mínimo**: en lugar de hardcoded `/destinations/drive/chunks`,
el helper recibe el tipo de destination. La función ya tiene acceso al
sessionId; ahora también necesita saber a qué provider apuntar.

Dos opciones:

**Opción A** (preferida — cero cambio en upload worker):
- El worker llama `uploadChunkBytes(sessionId, chunkIndex, hash, base64Slice)`
  exactamente igual que hoy.
- Internamente `uploadChunkBytes` lee la destination conectada del
  usuario UNA vez por proceso (cache en memoria) y elige el path:
  `/destinations/drive/chunks` o `/destinations/nas/chunks`.
- Cache se invalida cuando el usuario cambia destination en Settings
  (un evento simple en el auth store o un `clearDestinationCache()`
  llamado desde Settings tras connect/disconnect).

**Opción B** (más explícita, mismo resultado):
- Un nuevo endpoint backend `/destinations/chunks` (sin sufijo de
  provider) que internamente dispatcha al adapter del usuario.
- Mobile siempre POSTea ahí. Cero lógica en cliente.
- Tiene la ventaja de que añadir destinos futuros (S3, iCloud) NO
  toca mobile en absoluto.

**Recomendación**: B. El cambio de URL es trivial, y a futuro paga.
Drive route `/destinations/drive/chunks` queda como **alias deprecated
pero funcional** para no romper builds antiguos durante despliegue.

### 6.3 Settings UI — nueva sección

Pantalla `mobile/app/settings.tsx` gana una sección "NAS (avanzado)"
**colapsada por defecto**. Cuando el usuario la despliega:

- Si destination actual es Drive → texto "Cambiar a NAS desconectará Drive".
- Form con los 4 campos + "Probar conexión".
- Si test pasa → "Conectar NAS" guarda + cambia destination activo.

NO toca el flujo OAuth de Drive. NO mezcla en la misma pantalla los
dos providers. UI conservadora.

### 6.4 Cero cambio en

- `mobile/app/index.tsx` excepto `uploadChunkBytes` URL (Opción B = una línea).
- `mobile/src/api/export.ts` — el contrato de download es el mismo.
- `mobile/src/recording/*` — chunking, foreground service, queue, recovery.
- `mobile/src/recording/deriveGuardianStatus.ts`.
- `mobile/src/recording/localEvidence.ts`.

---

## 7. Tests obligatorios

### 7.1 Backend (vitest, mismo pattern que `chunks.test.ts`)

`backend/tests/integration/destinations-nas.test.ts`:

- [ ] `POST /destinations/nas/connect` con creds válidas → 200 + fila en DB.
- [ ] `POST /destinations/nas/connect` con URL inválida → 400.
- [ ] `POST /destinations/nas/connect` cuando WebDAV server responde 401
      en PROPFIND → 401 NAS_AUTH_FAILED.
- [ ] `POST /destinations/nas/test-upload` happy path → 200 con
      `remote_reference`.
- [ ] `POST /destinations/nas/chunks` happy path → 200 + remote_reference
      es URL absoluta WebDAV.
- [ ] `POST /destinations/nas/chunks` con HASH_MISMATCH → 400 (mismo
      check que Drive).
- [ ] `POST /destinations/nas/chunks` con `X-Session-Id` no propio →
      404 SESSION_NOT_FOUND.
- [ ] `POST /destinations/nas/chunks` con backend WebDAV inalcanzable
      → 502 NAS_API_FAILED.
- [ ] `GET /sessions/:id/chunks/:index/download` cuando destination es
      NAS → 200 con bytes correctos.
- [ ] DB-layer dedupe: replay del mismo chunk → 200 `dedup: 'db'`.
- [ ] WebDAV-layer dedupe: file ya en NAS, sin DB row → 200
      `dedup: 'remote'`.
- [ ] `WEBDAV_ENCRYPTION_KEY` ausente → boot crash claro (zod schema).
- [ ] Encryption: password en BD nunca está en plaintext (test directo
      sobre la fila).

`backend/tests/unit/webdavAdapter.test.ts`:

- [ ] WebDAV PROPFIND parsing.
- [ ] PUT de archivo → URL devuelta correcta.
- [ ] MKCOL idempotente (409 conflict tratado como ok).
- [ ] DELETE para limpieza.

### 7.2 Mobile (vitest)

`mobile/tests/uploadChunkBytes-routing.test.ts`:

- [ ] Cuando destination es Drive → POST a `/destinations/drive/chunks`
      (o `/destinations/chunks` con header destino si Opción B).
- [ ] Cuando destination es NAS → POST a `/destinations/nas/chunks`.
- [ ] Cache de destination type se respeta entre llamadas.
- [ ] `clearDestinationCache()` fuerza re-lookup.

`mobile/tests/classifyError.test.ts` (extender):

- [ ] `NAS_AUTH_FAILED` → transient (consistente con SESSION_NOT_FOUND).
- [ ] `NAS_TLS_INVALID` → permanent.
- [ ] `NAS_FOLDER_NOT_FOUND` → permanent en upload.

### 7.3 E2E manual (RELEASE_CHECKLIST)

- [ ] Usuario conecta NAS desde Settings → test upload OK.
- [ ] Cambia desde Drive a NAS sin romper sesiones en cola.
- [ ] Graba audio + minimiza → chunks suben al NAS, no a Drive.
- [ ] Recovery tras kill → cola sigue subiendo al NAS.
- [ ] Export → `.m4a`/`.mp4` reconstruido descargando del NAS.
- [ ] Modo offline → chunks se encolan, suben al NAS al volver red.

---

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Mobile cliente accede al WebDAV sin proxy backend | Ya descartado: el backend proxia igual que con Drive. Las creds NAS no llegan a mobile. |
| Cifrado de password en BD se rompe (cambio de key) | Documentar `WEBDAV_ENCRYPTION_KEY` como rotación coordinada con re-encrypt batch. MVP: clave fija en env. |
| Self-signed certs / TLS de NAS doméstico | NO permitir TLS inválido en MVP. El usuario configura su NAS con cert válido (Let's Encrypt) o lo expone vía proxy. Documentado en `NAS_DESTINATION_PLAN.md`. |
| Cola con chunks ya en cliente cuando usuario cambia de Drive a NAS | El chunk va al destino actual al subir. Si el chunk fue emitido bajo Drive y nunca subió, al cambiar a NAS se intentará subir al NAS (URL distinta). NO duplicación porque dedup DB layer detecta `remote_reference=null` y permite reupload. La advertencia UI en Settings debe ser explícita. |
| Latencia LAN-only del NAS y subidas desde 4G fuera de casa | El usuario debe exponer el NAS por HTTPS público o VPN. Documentado. Fuera del alcance del producto. |
| Tamaño máximo de subida WebDAV varía por servidor | El backend ya tiene `RAW_CHUNK_LIMIT_BYTES = 25 MB`. Si el NAS rechaza por tamaño, surface 413 NAS_BODY_TOO_LARGE → permanent. |
| Recovery atrapa entries con destinos mezclados | Como la cola no guarda destination_type, todos los chunks pending se intentan al destino activo actual. Aceptable para MVP — caso de borde infrecuente. |
| Rendimiento: PROPFIND por chunk para dedup en WebDAV | Cache local en backend de "este chunk ya existe" indexado por (sessionId, chunkIndex). Invalidación trivial. |

---

## 9. Orden de implementación

Implementación incremental, cada paso commit-able y revertible.

### Fase 0 — preparación (backend, sin tocar mobile)
1. Migración `0004_destinations_nas.sql` (CHECK + columnas nullable).
2. `WEBDAV_ENCRYPTION_KEY` añadido a `env.ts` (opcional).
3. Helper de cifrado/descifrado AES-256-GCM en `backend/src/utils/encryption.ts` (nuevo).
4. Tests unitarios del helper.

### Fase 1 — adapter abstraction
5. Definir `DestinationAdapter` interface.
6. Refactor mínimo: extraer la lógica de Drive de `destinations.routes.ts` a `DriveAdapter` (puro move, cero cambio de comportamiento). Tests existentes de chunks deben seguir pasando.
7. Función `resolveDestinationAdapter(userId)` que devuelve el adapter para la destination conectada.

### Fase 2 — WebDavAdapter
8. `webdav.service.ts`: PROPFIND, MKCOL, PUT, GET, DELETE sobre HTTPS con Basic auth. Solo bytes y status; sin lógica de negocio.
9. `WebDavAdapter`: `uploadChunk`, `downloadChunk`, `testConnection`. Tests unitarios contra un fake WebDAV (puede ser un Express mounted en el test).

### Fase 3 — backend routes
10. `POST /destinations/nas/connect` + schema zod.
11. `POST /destinations/nas/test-upload`.
12. `POST /destinations/nas/chunks` (clon literal de `/destinations/drive/chunks` con adapter inyectado).
13. `DELETE /destinations/nas`.
14. Branch en `GET /sessions/:id/chunks/:index/download` para NAS.
15. Tests integración listados en §7.1.

### Fase 4 — mobile
16. Tipos + helpers `connectNas`, `nasTestUpload`, `disconnectNas` en `api/destinations.ts`.
17. Selector de URL en `uploadChunkBytes` (Opción A o B según decisión).
18. Sección colapsada "NAS (avanzado)" en Settings con 4 inputs + test button.
19. Cache invalidation cuando cambia destination.
20. Tests `uploadChunkBytes-routing.test.ts` + extensión de `classifyError.test.ts`.

### Fase 5 — release
21. Documento `RELEASE_CHECKLIST_v0.4.md` con sección E2E manual NAS.
22. Closed Testing 14 días con al menos 3 testers que tengan NAS real
    (Synology / QNAP / Nextcloud / Apache mod_dav).

---

## 10. Lo que NO cambia

- `mobile/app/index.tsx` GC_QUEUE: formato `PendingQueueEntry`, key
  `test.pending_retry`, helpers (`queueMutate`, `queueRead`,
  `queueAppendChunk`, `queueUpdateChunk`, `queueMarkRecordingClosed`,
  `reapEntry`, `migrateLegacyPendingState`, `normalizeQueueOnRecovery`,
  `tryFinalizeReadySessions`, `hasPendingUploadWork`).
- Upload worker (`uploadDrainLoop`, `pickNext`, `processNextChunk`,
  `classifyError` salvo añadir 1-2 codes nuevos al set transient).
- Chunking (`audioChunkProducer`, `videoFileProducer`,
  `recordingController`).
- `mobile/src/api/export.ts` (`exportSession`, `listSessionChunks`,
  `downloadChunk`, `verifyHash`). El contract wire es idéntico — el
  branch nuevo vive solo en backend.
- Foreground service (`mobile/src/recording/backgroundService.ts`).
- `mobile/src/recording/deriveGuardianStatus.ts`.
- `mobile/src/recording/localEvidence.ts`.
- OAuth de Google (todo lo de `/destinations/drive/connect`,
  `/auth/drive/callback`, refresh-token flow).
- Drive routes y `drive.service.ts` (salvo el move de Fase 1, que es
  cero cambio de comportamiento — solo reorganización para que ambos
  adapters convivan).

---

## 11. Decisiones explícitas para revisar antes de implementar

| Decisión | Recomendación | Necesita tu OK |
|---|---|---|
| Opción A vs B en mobile selector | **B** (endpoint unificado backend) | sí |
| Multi-destination en MVP | **No** (una activa por usuario) | sí |
| Cifrado server-side con clave única | **Sí** (AES-256-GCM env key) | sí — implica gestión de secret en deploy |
| Permitir HTTP puro (no HTTPS) para LAN-only | **No** (HTTPS only) | sí |
| Permitir self-signed certs | **No** | sí |
| Versioning de la API: `/v1/destinations/...` | **No** en MVP, mantener compat | sí |

---

## 12. Estimación

Asumiendo el orden de §9 sin imprevistos y con el setup de tests
existente:

- Fase 0 + 1: ~1 día
- Fase 2: ~2 días (mock WebDAV server en tests es la pieza más lenta)
- Fase 3: ~1 día
- Fase 4: ~1 día
- Fase 5: depende del Closed Testing real

**Total código + tests: ~5 días de trabajo enfocado.** Closed Testing
añade el tiempo de validación con usuarios reales con NAS.
