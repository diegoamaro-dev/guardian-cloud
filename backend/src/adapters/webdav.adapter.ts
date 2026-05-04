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
