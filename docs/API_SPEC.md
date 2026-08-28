# Guardian Cloud — API Spec v1

> **Aviso de estado — reconciliado el 2026-08-23 contra `34412a0`.**
>
> Este documento describía una API que en parte **nunca existió**. La versión
> anterior documentaba `POST /auth/login`, `POST /auth/logout`, `POST /alerts`
> y `GET /alerts`; ninguno de los cuatro está montado en `backend/src/app.ts`.
> También declaraba `user_id` en el cuerpo de `POST /sessions`, que el backend
> **rechaza como fuente de identidad** por diseño.
>
> **Alcance de esta reconciliación:** el inventario de endpoints, el mecanismo
> de autenticación y los tamaños de chunk se han derivado leyendo los routers
> y los esquemas reales, y son verificables. Los **esquemas campo a campo de
> petición y respuesta no están documentados aquí** salvo donde ya se habían
> verificado: inventarlos sería repetir el defecto que este documento acaba de
> corregir. La fuente de verdad de cada contrato es su `zod` schema.
>
> Rutas: `backend/src/routes/` · montaje: `backend/src/app.ts:118-134`.

## Objetivo

Definir la API mínima del MVP.

---

## Auth

**No hay endpoints de autenticación.** El backend no emite, refresca ni revoca
sesiones: sólo las verifica.

| | |
|---|---|
| Mecanismo | `Authorization: Bearer <JWT de Supabase>` |
| Verificación | JWKS público de Supabase Auth (`utils/jwtVerifier.ts`) |
| Identidad | **anónima** (`signInAnonymously`), sin login de usuario |
| `user_id` | **siempre** del claim `sub` del JWT, **nunca** del cuerpo |
| Fallo | `401 UNAUTHORIZED` con mensaje opaco — no distingue expirado, firma inválida, issuer incorrecto ni JWKS inalcanzable |
| Timeout | 4000 ms sobre la fase de verificación (`AUTH_TIMEOUT_MS`) |

Fuente: `backend/src/middleware/auth.ts`.

> Un `401` **no** es un error estructural de la petición. El cliente lo trata
> como reintentable — la identidad puede estar refrescándose o degradada — y
> cae a captura local-first en lugar de abortar. Ver `GC-AUTH-001` en
> [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md).

El único endpoint bajo el prefijo `/auth` es el callback de OAuth de Drive:

### GET /auth/drive/callback
Recibe el `code` de Google tras la autorización del usuario y lo reenvía al
deep link del móvil. **No autentica**: no lleva `authMiddleware` y **no valida
`state`** — hoy `state` no se genera. La autenticación del flujo ocurre después,
en `POST /destinations/drive/connect` con `action: 'exchange'`, que sí exige
`authMiddleware` y ancla el destino a `req.user.id`.

> Que este flujo no correlacione la respuesta con la petición que la originó
> está registrado como `GC-OAUTH-NOSTATE-001` en
> [`KNOWN_LIMITS.md`](./KNOWN_LIMITS.md) §9.

---

## Inventario real de endpoints

Verificado sobre `34412a0`. Todos exigen `authMiddleware` salvo donde se indica.

### Salud

| Método | Ruta | Auth |
|---|---|---|
| `GET` | `/health` | no |

### Sesiones

| Método | Ruta | Auth |
|---|---|---|
| `POST` | `/sessions` | sí |
| `GET` | `/sessions/:id` | sí |
| `GET` | `/sessions/:id/chunks` | sí |
| `POST` | `/sessions/:id/complete` | sí |
| `GET` | `/sessions/:id/chunks/:index/download` | sí |

### Chunks

| Método | Ruta | Auth |
|---|---|---|
| `POST` | `/chunks` | sí |

### Destinos

| Método | Ruta | Auth |
|---|---|---|
| `GET` | `/destinations` | sí |
| `POST` | `/destinations` | sí |
| `POST` | `/destinations/drive/connect` | sí |
| `POST` | `/destinations/drive/test-upload` | sí |
| `POST` | `/destinations/drive/chunks` | sí |
| `POST` | `/destinations/nas` | sí |
| `POST` | `/destinations/nas/test-upload` | sí |
| `POST` | `/destinations/nas/chunks` | sí |

### Recovery

| Método | Ruta | Auth |
|---|---|---|
| `GET` | `/recovery/manifests` | sí |
| `GET` | `/recovery/manifests/:manifest_file_id` | sí |
| `GET` | `/recovery/chunks/:manifest_file_id/:chunk_index/download` | sí |

---

## Contratos verificados

### POST /sessions

Crea —o **readopta**— una sesión de grabación.

Body (`schemas/sessions.schema.ts`):

| Campo | Tipo | Obligatorio |
|---|---|---|
| `mode` | `'audio' \| 'video'` | sí |
| `destination_type` | `'drive' \| 'nas' \| 'none'` | sí |
| `id` | `uuid` | no |

**`user_id` NO se envía.** Se extrae del JWT.

`id` es el identificador generado por el cliente. Existe para que la app pueda
empezar a grabar sin red usando un UUID local y registrar **ese mismo id** más
tarde. El handler es idempotente: reenviar el mismo `id` + `user_id` devuelve
la fila existente en lugar de fallar.

Respuesta `201`:

```json
{
  "session_id": "uuid",
  "status": "...",
  "mode": "audio",
  "destination_type": "drive"
}
```

### POST /chunks

Registra el metadato de un chunk. **No transporta bytes** — los bytes van por
`POST /destinations/drive/chunks` o `/nas/chunks`.

Body (`chunkBodySchema`, `routes/chunks.routes.ts:41-48`):

| Campo | Tipo | Restricción |
|---|---|---|
| `session_id` | `uuid` | — |
| `chunk_index` | `int` | `>= 0` |
| `hash` | `string` | `^[a-f0-9]{64}$` (sha256) |
| `size` | `int` | `> 0`, máx. `20 MB` |
| `status` | `'pending' \| 'uploaded' \| 'failed'` | — |
| `remote_reference` | `string \| null` | opcional |
| `media` | `'video' \| 'audio'` | **opcional** — ver abajo |

> **`media` — versionado, desplegado y en servicio.** Integrado en `main` con
> `142c1f9`, publicado en `f3bb913`; la migración `0005` está aplicada y el
> backend que atiende peticiones persiste el campo. Esta fila describe el
> contrato que está sirviendo.
>
> **Validado funcionalmente sólo para `media='audio'`**: 17 chunks, todos
> persistidos con ese valor —
> [`VALIDATIONS/G3II_PER_CHUNK_MEDIA_2026-08-26.md`](./VALIDATIONS/G3II_PER_CHUNK_MEDIA_2026-08-26.md).
> **`media='video'` no se ejercitó** en esa validación.
>
> El medio es una propiedad **de la unidad de evidencia**, no de la sesión:
> `sessions.mode` declara con qué medio **empezó** la captura, y eso no basta
> para describir cada chunk.
>
> **Ausencia = medio no declarado**, que se persiste como `NULL`. Nunca se
> infiere: ni de `session.mode`, ni de la extensión, ni de la ruta. Un chunk
> sin medio declarado no puede describirse, y el escritor del manifiesto se
> niega a construir un documento con él antes que adivinarlo.

> `status === 'uploaded'` **con `remote_reference` no vacío** es el único
> predicado que acredita que un fragmento está fuera del dispositivo. Lo
> comparten el export gate, el finalize gate, el banner de Home y el guard de
> reset. Ver `isChunkConfirmedOffDevice`.

**Idempotencia:** `UNIQUE(session_id, chunk_index)` en base de datos más
reconciliación en aplicación ante violación `23505`. Mismo hash → replay `200`;
hash distinto → rechazo. La transición a `uploaded` es terminal.

### Tamaños de chunk

Definidos en el cliente (`mobile/app/index.tsx:392-397`):

| Modo | Bytes crudos | Constante |
|---|---|---|
| Audio | **32 768** (32 KB) | `CHUNK_SIZE_AUDIO` |
| Vídeo | **262 144** (256 KB) | `CHUNK_SIZE_VIDEO` |

El transporte es base64, así que la longitud emitida es la del bloque base64
alineado a 4 (`CHUNK_SIZE_BASE64_*`). El campo `size` del contrato admite
hasta 20 MB; el límite real lo fija el cliente, no la API.

> La cifra **16384** que aparecía en este documento nunca correspondió al
> código en producción. Estaba registrada como defecto `D3` en
> [`GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md`](./audits/GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md).

### POST /sessions/:id/complete

Marca la sesión como completada. Como efecto secundario **best-effort**
intenta generar el manifest cross-device (`tryGenerateManifest`, que nunca
lanza). El fallo del manifest no altera la respuesta al cliente.

### GET /sessions/:id/chunks/:index/download

Contrapartida de lectura del pipeline de subida. El backend hace de proxy: el
cliente **nunca** recibe un access token de Drive. Exige `status='uploaded'` y
`remote_reference` no nulo. Devuelve bytes crudos con
`Content-Type: application/octet-stream` y cabecera `X-Chunk-Hash` para que el
cliente verifique el sha256 localmente.

---

## Estado de los destinos — defecto abierto

El esquema permite `status ∈ {connected, revoked, error}`, pero **ningún camino
de código escribe `revoked` ni `error`**. Un destino Drive sigue reportándose
`connected` después de que su refresh token haya sido revocado.

Registrado como `GC-DEST-STATUS-001` (`OPEN`). Consumir `status` como prueba
de que un destino funciona es incorrecto hoy.

---

## Evidence Manifest

### GET /sessions/:id/manifest — NO IMPLEMENTADO

Este endpoint **no existe**. Se documentó como futuro y sigue siéndolo.

El manifest sí se genera, pero por otra vía: como efecto secundario de
`POST /sessions/:id/complete`, y se consume desde `/recovery/manifests*`.

Diseño previsto, sin implementar:

```json
{
  "session_id": "...",
  "mode": "audio",
  "format": "m4a",
  "chunks": [
    { "index": 0, "hash": "...", "size": 32768, "remote_reference": "drive_file_id" }
  ]
}
```

Restricciones de diseño que siguen vigentes:

* el manifest es una **vista derivada**, no una entidad nueva;
* se genera desde la tabla de chunks más la metadata de sesión;
* debe ser idempotente, no duplicar datos y no introducir estado adicional;
* no es necesario para el MVP.

---

## Recovery

### GET /recovery/manifests

Lista manifests recuperables del usuario.

**Sin el parámetro `view`**, el contrato es el de siempre, sin cambios. Se
conserva así por compatibilidad con las APK ya instaladas, que parsean esta
forma. Sigue devolviendo los siete campos históricos, y sigue construyéndose
descargando y parseando el cuerpo de cada manifiesto:

```json
{
  "drive_not_connected": false,
  "manifests": [
    {
      "session_id": "uuid",
      "mode": "audio",
      "created_at": "2026-05-14T10:00:00.000Z",
      "completed_at": "2026-05-14T10:05:00.000Z",
      "chunk_count": 5,
      "protection_status": "complete",
      "manifest_file_id": "drive_file_id"
    }
  ]
}
```

> **`mode` en esta respuesta es DERIVADO, no reafirmado** *(desplegado; este
> endpoint **no se ejercitó** en la validación de `G3''`)*. Sale del medio
> de los chunks cuando todos coinciden. Si no coincidieran se **omite** y la
> sesión **sigue listándose**: aquí el medio dibuja un icono, y ocultar una
> sesión cuyos bytes existen sería peor que no dibujarlo. La negativa dura vive
> en el endpoint siguiente, donde una respuesta equivocada produciría un
> artefacto falso en lugar de un glifo equivocado.

### GET /recovery/manifests?view=compact

Variante **opt-in**, añadida por `GC-RECOVERY-COMPACT-DISCOVERY-001`
(commit `26c0966`). Es **descubrimiento de candidatos**: responde qué
sesiones tienen un manifiesto en Drive, no qué contiene cada uno.

```json
{
  "drive_not_connected": false,
  "manifests": [
    {
      "session_id": "uuid-derivado-del-nombre-de-fichero",
      "manifest_file_id": "drive_file_id",
      "reference_date": "modifiedTime de Drive"
    }
  ]
}
```

| campo | origen |
|---|---|
| `session_id` | del **nombre** del fichero, `{session_id}_manifest.json` |
| `manifest_file_id` | `id` de la entrada de Drive · opaco para la UI |
| `reference_date` | `modifiedTime` de la entrada de Drive |

**Qué NO implica una fila de esta respuesta:**

* **no** implica que el manifiesto se haya leído;
* **no** implica integridad verificada;
* **no** implica que todos los chunks estén disponibles;
* **no** implica recuperabilidad demostrada.

Afirma exactamente dos cosas, ambas ciertas por construcción porque salen del
propio listado: **existe un fichero con ese nombre, y ésta es la última vez que
se escribió**.

`reference_date` **no es `completed_at`**: para una sesión aún en curso es su
último manifiesto incremental. Debe presentarse etiquetado como fecha de
referencia. Es además la clave de orden —descendente— y el criterio de
desempate cuando dos ficheros de Drive comparten nombre, cosa que Drive permite.

`manifest_file_id` es la identidad con la que se abre el detalle. **La
validación del manifiesto sigue en `getManifestByFileId`**, y la validación
efectiva de la evidencia —presencia de chunks y `sha256`— permanece donde
estaba, en el flujo de recuperación/export. Compact no cambia ninguno de los dos.

Consecuencia deliberada: un fichero con nombre válido y contenido inválido
**aparece** como candidato, en lugar de omitirse en silencio; al abrirlo,
`GET /recovery/manifests/:manifest_file_id` responde `404 MANIFEST_INVALID`.

**Coste.** Consulta **paginada** de metadata de Drive, con **cero descargas de
cuerpos de manifiesto**. En detalle: una invocación a `listFilesInFolder`, que
internamente pagina hasta `maxPages`, de modo que `files.list` puede realizar
**varias** requests según el tamaño de la carpeta; lo que sí es invariante del
camino compact es que **no ejecuta ningún `downloadFile` de manifiesto**.

#### Valores de `view`

| valor | comportamiento |
|---|---|
| ausente | contrato histórico, arriba |
| `compact` | esta variante |
| cualquier otro | **`400 INVALID_VIEW`** |

Un valor desconocido **no hace fallback silencioso**: devolver la forma
histórica ante `?view=compat` le entregaría a un cliente que espera la compacta
una respuesta distinta, y el desajuste aparecería como campos ausentes en lugar
de como error.

### GET /recovery/manifests/:manifest_file_id

Devuelve un manifest concreto.

> **Fallo cerrado ante evidencia heterogénea** *(desplegado; **sin ejercitar** —
> ver la nota final de este bloque)*. Cuando los chunks de la sesión no
> comparten un solo medio, el endpoint responde:
>
> ```
> 409 MANIFEST_HETEROGENEOUS
> ```
>
> y **no** devuelve el manifiesto. Servirlo sería peor que un error: el cliente
> leería un medio ausente, caería a su rama de olfateo de bytes, encontraría una
> caja `ftyp` al principio del primer segmento MP4 y nombraría la concatenación
> `.m4a` — un artefacto falso producido en silencio a partir de bytes ciertos.
>
> Los bytes siguen en Drive y la sesión sigue siendo descubrible; lo único que se
> retira es el export en un fichero único, que es precisamente la operación que
> no puede realizarse con honestidad.
>
> **Hoy es inalcanzable**: ningún productor puede mezclar medios en una sesión
> mientras `VIDEO_AUDIO → AUDIO_ONLY` siga sin implementarse. Existe para que el
> día que pueda, el fallo sea ruidoso.

---

## Manifiesto de evidencia — v1 y v2

*Versionado en `142c1f9`, publicado en `f3bb913` y **desplegado**: el backend en
servicio escribe `guardian-cloud.manifest.v2`. Su escritura fue **observada** en
la validación de `G3''` — un manifiesto v2 real, con 17 entradas y `media` en
todas. **La lectura de v1 y el fallo cerrado ante evidencia heterogénea no se
ejercitaron.***

El manifiesto es un fichero en el Drive del usuario, `{session_id}_manifest.json`.
**No es contrato con el cliente**: la app nunca lo parsea — consume la respuesta
ya validada de `/recovery/manifests*`. Es contrato del backend consigo mismo, y
entre dispositivos.

| | `guardian-cloud.manifest.v1` | `guardian-cloud.manifest.v2` |
|---|---|---|
| lo escribe | backend **histórico, anterior a `f3bb913`** | **backend desplegado, desde `f3bb913`** |
| se lee | sí, read-only | sí |
| `mode` de sesión | presente y autoritativo | **ausente** |
| `format` | `'mp4'` si `mode==='video'` | **ausente** |
| `chunks[].media` | ausente | **obligatorio** |

**Por qué v2 retira `mode` y `format`.** Un medio a nivel de sesión no puede
describir una sesión que contenga más de uno, y mantenerlo junto a
`chunks[].media` daría dos fuentes para el mismo hecho, capaces de contradecirse.
`format` se derivaba de `mode` y **no tenía ningún lector** en el sistema.

**Por qué v1 sigue leyéndose, y por qué su `mode` es válido ahí.** Todo documento
v1 describe una sesión con un único productor: nunca ha existido un cliente capaz
de mezclar medios. Al parsearlo, su `mode` se **propaga** a cada chunk. Esa
propagación es correcta para v1 y **sólo** para v1.

`mode` **se conserva** en `POST /sessions` y en la fila de sesión, con el
significado que siempre tuvo: el medio con el que se inició la captura.

### GET /recovery/chunks/:manifest_file_id/:chunk_index/download

Descarga un chunk referenciado por un manifest, sin necesidad de que la sesión
exista localmente. Es la ruta de reconstrucción desde otro dispositivo.

---

## Retirado de este documento

Cuatro endpoints documentados que **nunca estuvieron montados**:

| Endpoint retirado | Realidad |
|---|---|
| `POST /auth/login` | No existe. La identidad es anónima y la emite Supabase, no este backend |
| `POST /auth/logout` | No existe. No hay sesión de servidor que cerrar |
| `POST /alerts` | No existe. El modo alertas es post-MVP — ver [`POST_MVP_ROADMAP.md`](../strategy/POST_MVP_ROADMAP.md) |
| `GET /alerts` | Ídem |

Queda una referencia a `/alerts` en un comentario de
`backend/src/middleware/auth.ts:9`, dentro del alcance de código y por tanto
fuera del alcance de esta reconciliación documental.

---

## Notas

- la API v1 no debe ser enorme
- primero debe ser estable
- la fuente de verdad crítica es el estado de sesión y chunk
