/**
 * WebDAV adapter — NAS chunk upload.
 *
 * Single responsibility: PUT one chunk onto a WebDAV server and return
 * the canonical remote_reference for that chunk. Knows nothing about
 * sessions, DB rows, or the broader upload flow.
 *
 * Credential contract:
 *   encryptedPassword must be an AES-256-GCM payload produced by
 *   security/webdavCredentials.ts. It is decrypted in-process and never
 *   logged or exposed beyond this call.
 *
 * Path contract (deterministic, idempotent):
 *   {basePath}/GuardianCloud/{sessionId}/{chunkIndex}.chunk
 *
 * Directory creation:
 *   Before PUT, MKCOL is issued for each path segment:
 *     {basePath}/GuardianCloud
 *     {basePath}/GuardianCloud/{sessionId}
 *   Acceptable MKCOL responses: 201 (created), 405 (already exists —
 *   most WebDAV servers), 409 (conflict / already exists on some servers).
 *
 * Error mapping (mirrors drive.service.ts conventions):
 *   401/403 → AppError 409 NAS_AUTH_FAILED   (fatal, user must reconnect)
 *   network/timeout/5xx → AppError 502 NAS_UPLOAD_FAILED  (retryable)
 *   bad credentials config → AppError 503 NAS_CREDENTIAL_ERROR (fatal)
 */

import { AppError } from '../errors/AppError.js';
import { decryptWebdavPassword } from '../security/webdavCredentials.js';
import { logger } from '../utils/logger.js';

const WEBDAV_TIMEOUT_MS = 15_000;
const ROOT_DIR = 'GuardianCloud';

export interface WebDavUploadParams {
  sessionId: string;
  chunkIndex: number;
  buffer: Buffer;
  hash: string;
  destination: {
    /** Base URL of the WebDAV server, e.g. https://nas.example.com:5006 */
    host: string;
    username: string;
    /** AES-256-GCM encrypted password (v1:iv:authTag:ciphertext) */
    encryptedPassword: string;
    /** Optional path prefix on the WebDAV server, e.g. /dav or /remote.php/webdav */
    basePath: string;
  };
}

export interface WebDavUploadResult {
  remote_reference: string;
}

/**
 * Issue a WebDAV MKCOL (make collection) request.
 * Treats 201, 405, 409 (and 200/204) as "directory exists or was created".
 * Throws AppError on auth failure or unexpected server error.
 */
async function mkcol(url: string, authHeader: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBDAV_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'MKCOL',
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new AppError(502, 'NAS_UPLOAD_FAILED', 'WebDAV MKCOL failed: network error');
  }
  clearTimeout(timer);

  // 201 = created, 200/204 = OK, 405 = method not allowed (dir already exists
  // on most WebDAV servers), 409 = conflict (already exists on some servers).
  if (
    res.status === 200 ||
    res.status === 201 ||
    res.status === 204 ||
    res.status === 405 ||
    res.status === 409
  ) {
    return;
  }

  if (res.status === 401 || res.status === 403) {
    throw new AppError(
      409,
      'NAS_AUTH_FAILED',
      `WebDAV MKCOL authentication failed (${res.status})`,
    );
  }

  const detail = await res.text().catch(() => '<no body>');
  logger.warn(
    { op: 'webdav.mkcol', url, status: res.status, detail: detail.substring(0, 200) },
    'NAS_MKCOL_FAILED',
  );
  throw new AppError(502, 'NAS_UPLOAD_FAILED', `WebDAV MKCOL failed (${res.status})`);
}

export async function uploadChunk(params: WebDavUploadParams): Promise<WebDavUploadResult> {
  const { sessionId, chunkIndex, buffer, destination } = params;

  // --- 1) Decrypt credentials. Failure here is fatal (bad key / bad payload).
  let password: string;
  try {
    password = decryptWebdavPassword(destination.encryptedPassword);
  } catch (err) {
    logger.error(
      {
        op: 'webdav.uploadChunk',
        sessionId,
        chunkIndex,
        reason: err instanceof Error ? err.message : String(err),
      },
      'NAS_CREDENTIAL_DECRYPT_FAILED',
    );
    throw new AppError(503, 'NAS_CREDENTIAL_ERROR', 'Failed to decrypt NAS credentials');
  }

  // --- 2) Build base and deterministic remote path.
  const host = destination.host.replace(/\/$/, '');
  const base = destination.basePath ? `${host}${destination.basePath.replace(/\/$/, '')}` : host;
  const dirRoot = `${base}/${ROOT_DIR}`;
  const dirSession = `${dirRoot}/${sessionId}`;
  const url = `${dirSession}/${chunkIndex}.chunk`;

  const authHeader = `Basic ${Buffer.from(`${destination.username}:${password}`).toString('base64')}`;

  // --- 3) Ensure directories exist before PUT.
  await mkcol(dirRoot, authHeader);
  await mkcol(dirSession, authHeader);

  // --- 4) PUT with timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBDAV_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buffer.length),
      },
      // Buffer extends Uint8Array but TS 5 generics make Buffer<ArrayBufferLike>
      // unassignable to BodyInit without an explicit cast. At runtime this is
      // the correct type (native fetch accepts Uint8Array subclasses).
      body: buffer as unknown as BodyInit,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    logger.warn(
      {
        op: 'webdav.uploadChunk',
        sessionId,
        chunkIndex,
        url,
        reason: err instanceof Error ? err.message : String(err),
      },
      'NAS_UPLOAD_NETWORK_ERROR',
    );
    throw new AppError(502, 'NAS_UPLOAD_FAILED', 'WebDAV PUT failed: network error');
  }
  clearTimeout(timer);

  // --- 5) Map HTTP status to AppError.
  // WebDAV PUT success: 200 (replaced), 201 (created), 204 (no content).
  if (res.status === 200 || res.status === 201 || res.status === 204) {
    logger.info(
      { op: 'webdav.uploadChunk', sessionId, chunkIndex, status: res.status, url },
      'NAS_CHUNK_UPLOAD_SUCCESS',
    );
    return { remote_reference: url };
  }

  const detail = await res.text().catch(() => '<no body>');
  logger.warn(
    {
      op: 'webdav.uploadChunk',
      sessionId,
      chunkIndex,
      url,
      status: res.status,
      detail: detail.substring(0, 200),
    },
    'NAS_CHUNK_UPLOAD_FAILED',
  );

  if (res.status === 401 || res.status === 403) {
    throw new AppError(409, 'NAS_AUTH_FAILED', `WebDAV authentication failed (${res.status})`);
  }

  throw new AppError(502, 'NAS_UPLOAD_FAILED', `WebDAV PUT failed (${res.status})`);
}

/**
 * Inputs for {@link downloadChunk}.
 *
 * `url` is the full `remote_reference` that {@link uploadChunk} returned at
 * upload time (deterministic shape:
 * `${host}${basePath}/GuardianCloud/${sessionId}/${chunkIndex}.chunk`).
 * The CALLER is responsible for validating that this URL still belongs to
 * the user's currently-connected NAS — see the prefix check in
 * `routes/sessions.routes.ts`. This adapter intentionally does NOT
 * re-validate: passing an unverified URL through this function would
 * allow SSRF if the route layer ever forgot to check, so the contract
 * is "url is already proven safe by the route".
 */
export interface WebDavDownloadParams {
  url: string;
  destination: {
    username: string;
    /** AES-256-GCM encrypted password (v1:iv:authTag:ciphertext) */
    encryptedPassword: string;
  };
}

export interface WebDavDownloadResult {
  bytes: Buffer;
}

/**
 * GET one chunk from a WebDAV server using HTTP Basic auth.
 *
 * Mirror of {@link uploadChunk}'s I/O contract:
 *   - same timeout (`WEBDAV_TIMEOUT_MS`)
 *   - same Basic-auth construction
 *   - same credential-decrypt path (failure → 503 NAS_CREDENTIAL_ERROR)
 *   - same error mapping shape (401/403 → 409 NAS_AUTH_FAILED, 5xx /
 *     network → 502 NAS_DOWNLOAD_FAILED)
 *
 * Distinct error code for "not on the NAS": 404 NAS_FILE_NOT_FOUND, so
 * the export client can treat it as a per-chunk download failure (and
 * cut the partial export at that index) rather than as a hard failure
 * for the whole session.
 *
 * Memory: holds the full chunk in memory as a Buffer. Chunks are
 * ~16 KB in the MVP (audio) up to a few MB (video segments); the
 * upload adapter holds them similarly. Streaming is out of scope.
 *
 * The password is decrypted in-process and never logged.
 */
export async function downloadChunk(
  params: WebDavDownloadParams,
): Promise<WebDavDownloadResult> {
  const { url, destination } = params;

  // --- 1) Decrypt credentials. Failure here is fatal (bad key / bad payload).
  let password: string;
  try {
    password = decryptWebdavPassword(destination.encryptedPassword);
  } catch (err) {
    logger.error(
      {
        op: 'webdav.downloadChunk',
        url,
        reason: err instanceof Error ? err.message : String(err),
      },
      'NAS_CREDENTIAL_DECRYPT_FAILED',
    );
    throw new AppError(503, 'NAS_CREDENTIAL_ERROR', 'Failed to decrypt NAS credentials');
  }

  const authHeader = `Basic ${Buffer.from(`${destination.username}:${password}`).toString('base64')}`;

  // --- 2) GET with timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBDAV_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    logger.warn(
      {
        op: 'webdav.downloadChunk',
        url,
        reason: err instanceof Error ? err.message : String(err),
      },
      'NAS_DOWNLOAD_NETWORK_ERROR',
    );
    throw new AppError(502, 'NAS_DOWNLOAD_FAILED', 'WebDAV GET failed: network error');
  }
  clearTimeout(timer);

  // --- 3) Map HTTP status to AppError.
  // WebDAV GET success: 200 (full body), 206 (partial — we don't request
  // ranges so this should not happen, but accept it defensively).
  if (res.status === 200 || res.status === 206) {
    const ab = await res.arrayBuffer();
    const bytes = Buffer.from(ab);
    logger.info(
      { op: 'webdav.downloadChunk', url, status: res.status, size: bytes.length },
      'NAS_CHUNK_DOWNLOAD_SUCCESS',
    );
    return { bytes };
  }

  if (res.status === 401 || res.status === 403) {
    logger.warn(
      { op: 'webdav.downloadChunk', url, status: res.status },
      'NAS_AUTH_FAILED',
    );
    throw new AppError(409, 'NAS_AUTH_FAILED', `WebDAV authentication failed (${res.status})`);
  }

  if (res.status === 404) {
    // Distinct from a network error: the NAS spoke to us, the chunk
    // simply isn't there. Mirrors DRIVE_FILE_NOT_FOUND so the route /
    // client treat it as a per-chunk failure (partial export).
    logger.warn(
      { op: 'webdav.downloadChunk', url, status: res.status },
      'NAS_FILE_NOT_FOUND',
    );
    throw new AppError(404, 'NAS_FILE_NOT_FOUND', 'NAS file not found for the given remote_reference');
  }

  const detail = await res.text().catch(() => '<no body>');
  logger.warn(
    {
      op: 'webdav.downloadChunk',
      url,
      status: res.status,
      detail: detail.substring(0, 200),
    },
    'NAS_CHUNK_DOWNLOAD_FAILED',
  );
  throw new AppError(502, 'NAS_DOWNLOAD_FAILED', `WebDAV GET failed (${res.status})`);
}
