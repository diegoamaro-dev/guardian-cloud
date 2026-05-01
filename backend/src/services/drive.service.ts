/**
 * Google Drive integration (MVP, REST-only).
 *
 * Scope: the minimum viable path to put a real file in the user's Drive.
 *   - build an OAuth authorisation URL
 *   - exchange an authorisation code for tokens
 *   - mint a fresh access_token from a stored refresh_token
 *   - ensure a root folder exists under `My Drive`
 *   - upload a single file (simple multipart upload)
 *
 * Deliberate non-goals for MVP (do NOT add without a new spec):
 *   - resumable uploads
 *   - file moves/renames
 *   - shared-drive support
 *   - watch notifications
 *
 * Dependencies: native `fetch` (Node 20+). We intentionally do NOT pull
 * `googleapis` — it's 40+ MB and we need four endpoints.
 *
 * Error shape: every failure throws an `AppError` the route layer can
 * translate into a stable error code for the client. No secret values
 * (tokens, codes) ever appear in thrown messages or logs.
 */

import { AppError } from '../errors/AppError.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/** Scopes we request. `drive.file` is the narrowest scope that still lets
 *  the app read/write the files it creates (including the root folder),
 *  without ever seeing the user's other Drive content. */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Requested alongside `drive.file` so we can record which account the
 *  user connected, for display in the app's settings screen. */
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

/** Default root folder name under the user's Drive. */
export const ROOT_FOLDER_NAME = 'GuardianCloud';

/** Small I/O timeout for every Google call. We never want a hung request
 *  from Google to hang our HTTP handler — callers always see a deterministic
 *  error, never an open socket. */
const GOOGLE_TIMEOUT_MS = 10_000;

function assertGoogleConfigured(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new AppError(
      503,
      'DRIVE_NOT_CONFIGURED',
      'Google Drive OAuth is not configured on the backend',
    );
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  };
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = GOOGLE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Build the Google OAuth authorisation URL. Client opens this in a
 *  browser/custom tab; Google redirects back to `redirect_uri` with
 *  `?code=<auth_code>` on success. */
export function buildAuthUrl(state?: string, redirectUriOverride?: string): string {
  const { clientId, redirectUri } = assertGoogleConfigured();
  const effectiveRedirect = redirectUriOverride ?? redirectUri;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: effectiveRedirect,
    response_type: 'code',
    // `offline` is what makes Google return a refresh_token.
    // `consent` forces the refresh_token to be re-issued even if the
    // user has granted access before (otherwise Google only returns it
    // on the first consent, which is a recipe for pain in testing).
    access_type: 'offline',
    prompt: 'consent',
    scope: `${DRIVE_SCOPE} ${EMAIL_SCOPE}`,
    include_granted_scopes: 'true',
  });
  if (state) params.set('state', state);

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

/** Exchange the auth code for tokens. `refresh_token` is present on the
 *  first exchange after a fresh consent; we persist it. */
export async function exchangeCodeForTokens(
  code: string,
  redirectUriOverride?: string,
): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret, redirectUri } = assertGoogleConfigured();
  const effectiveRedirect = redirectUriOverride ?? redirectUri;

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: effectiveRedirect,
    grant_type: 'authorization_code',
  });

  const res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    logger.warn(
      { op: 'exchangeCodeForTokens', status: res.status, detail: detail.substring(0, 200) },
      'Google token exchange failed',
    );
    throw new AppError(
      400,
      'DRIVE_CODE_EXCHANGE_FAILED',
      'Failed to exchange authorisation code',
    );
  }

  return (await res.json()) as GoogleTokenResponse;
}

/**
 * Small bounded retry for token refresh.
 *
 * Motivation: right after an OS reboot (recovery path), the first
 * outbound request from the backend can race against the host's
 * network re-establishing — Google's token endpoint occasionally
 * returns 5xx / times out on that first hit, and a second attempt a
 * few hundred ms later succeeds. Failing the whole recovery over a
 * transient glitch forces users to reconnect Drive when nothing is
 * actually wrong.
 *
 * What is retried (transient):
 *   - fetch itself throws (abort/timeout/DNS/TCP reset)
 *   - HTTP 5xx
 *   - HTTP 429
 *
 * What is NOT retried (permanent — retrying hides real problems):
 *   - HTTP 400: `invalid_grant` — refresh_token revoked. MUST surface
 *     so the UI can prompt a reconnect.
 *   - HTTP 401/403: bad client credentials or unauthorized.
 *   - HTTP 2xx with no `access_token` field (malformed response).
 *
 * Bounded on purpose: 3 attempts with 250 / 750 ms backoff. We never
 * want this loop to extend a request's latency budget beyond what the
 * mobile client will wait for.
 */
const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_BACKOFFS_MS = [250, 750];

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Swap a stored refresh_token for a short-lived access_token. */
export async function getAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = assertGoogleConfigured();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      // Network error / timeout / abort. Always transient from our
      // point of view — retry if budget remains.
      lastError = err;
      logger.warn(
        {
          op: 'getAccessToken',
          attempt,
          reason: err instanceof Error ? err.message : String(err),
        },
        'Google token refresh network error; will retry if attempts remain',
      );
      if (attempt < REFRESH_MAX_ATTEMPTS) {
        await sleep(REFRESH_BACKOFFS_MS[attempt - 1] ?? 0);
        continue;
      }
      break;
    }

    if (res.ok) {
      const json = (await res.json()) as { access_token?: string };
      if (!json.access_token) {
        logger.warn(
          {
            op: 'getAccessToken',
            attempt,
            status: res.status,
            reason: 'no_access_token_in_2xx_body',
            refresh_token_length: refreshToken.length,
          },
          'DRIVE_TOKEN_REFRESH_FAILED_DETAIL',
        );
        throw new AppError(
          502,
          'DRIVE_REFRESH_FAILED',
          'Google returned no access token',
        );
      }
      return json.access_token;
    }

    // Non-2xx: decide retryable vs terminal.
    const detail = await res.text().catch(() => '<no body>');
    const transient = isTransientStatus(res.status);

    logger.warn(
      {
        op: 'getAccessToken',
        attempt,
        status: res.status,
        transient,
        detail: detail.substring(0, 200),
      },
      'Google token refresh failed',
    );

    if (!transient) {
      // 400 from Google on refresh usually means the refresh_token was
      // revoked (user removed access). Surface as a distinct code so
      // the UI can prompt a reconnect.
      logger.warn(
        {
          op: 'getAccessToken',
          attempt,
          status: res.status,
          transient: false,
          detail: detail.substring(0, 200),
          refresh_token_length: refreshToken.length,
        },
        'DRIVE_TOKEN_REFRESH_FAILED_DETAIL',
      );
      throw new AppError(
        res.status === 400 ? 401 : 502,
        'DRIVE_REFRESH_FAILED',
        'Failed to refresh Drive access token',
      );
    }

    // Transient: retry unless we've exhausted attempts.
    lastError = new Error(`Google token refresh transient ${res.status}`);
    if (attempt < REFRESH_MAX_ATTEMPTS) {
      await sleep(REFRESH_BACKOFFS_MS[attempt - 1] ?? 0);
      continue;
    }
  }

  // Exhausted retries on transient errors.
  logger.warn(
    {
      op: 'getAccessToken',
      attempts: REFRESH_MAX_ATTEMPTS,
      reason: lastError instanceof Error ? lastError.message : String(lastError),
    },
    'Google token refresh failed after retries',
  );
  logger.warn(
    {
      op: 'getAccessToken',
      attempts: REFRESH_MAX_ATTEMPTS,
      transient: true,
      exhausted: true,
      reason: lastError instanceof Error ? lastError.message : String(lastError),
      refresh_token_length: refreshToken.length,
    },
    'DRIVE_TOKEN_REFRESH_FAILED_DETAIL',
  );
  throw new AppError(
    502,
    'DRIVE_REFRESH_FAILED',
    'Failed to refresh Drive access token',
  );
}

interface UserInfo {
  email?: string;
  sub?: string;
}

/** Best-effort: retrieve the email for display. Failure here is NOT fatal
 *  for the connect flow — we just store `null` and move on. */
export async function getUserInfo(accessToken: string): Promise<UserInfo> {
  try {
    const res = await fetchWithTimeout(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return {};
    return (await res.json()) as UserInfo;
  } catch {
    return {};
  }
}

async function driveGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetchWithTimeout(`${DRIVE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new AppError(
      502,
      'DRIVE_API_FAILED',
      `Drive API GET ${path} failed (${res.status}): ${detail.substring(0, 120)}`,
    );
  }
  return (await res.json()) as T;
}

async function drivePost<T>(
  accessToken: string,
  path: string,
  json: unknown,
): Promise<T> {
  const res = await fetchWithTimeout(`${DRIVE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(json),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    throw new AppError(
      502,
      'DRIVE_API_FAILED',
      `Drive API POST ${path} failed (${res.status}): ${detail.substring(0, 120)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Ensure `folderName` exists in the user's Drive root. Returns its id.
 * Re-finding a previous folder on reconnect is the expected case; we
 * match by name + mimeType among `drive.file`-scoped items (i.e. only
 * folders this app created) and fall back to creating a new one if
 * nothing is found.
 */
export async function ensureRootFolder(
  accessToken: string,
  folderName = ROOT_FOLDER_NAME,
): Promise<string> {
  // Escape single quotes in the folder name for the q parameter.
  const safeName = folderName.replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `mimeType = 'application/vnd.google-apps.folder' and name = '${safeName}' and trashed = false`,
  );

  const list = await driveGet<{ files?: Array<{ id: string; name: string }> }>(
    accessToken,
    `/files?q=${q}&fields=files(id,name)&pageSize=10&spaces=drive`,
  );
  const existing = list.files?.[0];
  if (existing?.id) return existing.id;

  const created = await drivePost<{ id: string }>(accessToken, '/files', {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  });
  if (!created.id) {
    throw new AppError(502, 'DRIVE_API_FAILED', 'Drive folder creation returned no id');
  }
  return created.id;
}

/**
 * Look up a file by exact name inside a specific folder. Used to dedupe
 * chunk uploads: if the same deterministic name already exists in Drive
 * (e.g. because a previous attempt uploaded bytes before our DB row for
 * that chunk was persisted and the app was killed in between), return the
 * existing file_id instead of creating a duplicate.
 *
 * Scope-safe: our `drive.file` scope only sees files the app created, so
 * this query never surfaces unrelated user content.
 *
 * Returns `null` if not found.
 */
export async function findFileByName(
  accessToken: string,
  folderId: string,
  fileName: string,
): Promise<string | null> {
  const safeName = fileName.replace(/'/g, "\\'");
  const safeFolder = folderId.replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `name = '${safeName}' and '${safeFolder}' in parents and trashed = false`,
  );

  const list = await driveGet<{ files?: Array<{ id: string }> }>(
    accessToken,
    `/files?q=${q}&fields=files(id)&pageSize=1&spaces=drive`,
  );
  return list.files?.[0]?.id ?? null;
}

export interface DriveUploadResult {
  file_id: string;
  web_view_link?: string;
  name: string;
  size: number;
}

/**
 * Upload `content` to Drive under `folderId` as `fileName` using the
 * simple multipart upload path (Drive's "one shot" upload, suitable for
 * small files — which is exactly what our chunks are at 16 KB).
 *
 * `content` may be a `Buffer` or `Uint8Array`. The caller is responsible
 * for any client-side encoding (we do not re-hash here — the backend is
 * NOT on the binary path for chunks in Phase 1).
 */
export async function uploadFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  content: Uint8Array | Buffer,
  mimeType = 'application/octet-stream',
): Promise<DriveUploadResult> {
  // Drive's multipart upload is a standard RFC 2387 multipart/related
  // body: metadata JSON part + binary part, with a shared boundary.
  const boundary = `guardian-cloud-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;

  const metadata = {
    name: fileName,
    parents: [folderId],
  };

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const body = Buffer.concat([preamble, contentBuffer, closing]);

  const res = await fetchWithTimeout(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,size,webViewLink`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length.toString(),
      },
      body,
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    logger.warn(
      {
        op: 'drive.uploadFile',
        status: res.status,
        size: contentBuffer.length,
        detail: detail.substring(0, 200),
      },
      'Drive upload failed',
    );
    throw new AppError(
      502,
      'DRIVE_UPLOAD_FAILED',
      `Drive upload failed (${res.status})`,
    );
  }

  const json = (await res.json()) as {
    id?: string;
    name?: string;
    size?: string;
    webViewLink?: string;
  };
  if (!json.id) {
    throw new AppError(502, 'DRIVE_UPLOAD_FAILED', 'Drive upload returned no file id');
  }

  return {
    file_id: json.id,
    name: json.name ?? fileName,
    size: Number(json.size ?? contentBuffer.length),
    web_view_link: json.webViewLink,
  };
}

/**
 * Download the bytes of a Drive file by file_id.
 *
 * Inverse of `uploadFile`. Used by the export pipeline
 * (GET /sessions/:id/chunks/:index/download) to stream a chunk's bytes
 * back to the client. The returned Buffer is the exact body that was
 * uploaded — no re-encoding, no transformation.
 *
 * Endpoint: GET /drive/v3/files/{fileId}?alt=media — Drive's documented
 * "media download" path for non-Google-Doc files. `drive.file` scope is
 * sufficient because the proxy only ever uploads (and now downloads)
 * files THIS app created, never user-owned content outside that set.
 *
 * Errors:
 *   - 404 from Drive (file deleted server-side) → DRIVE_FILE_NOT_FOUND
 *     so the route can return a stable 404 to the client. The client
 *     will mark that chunk_index as corrupt in the export result.
 *   - any other non-2xx → DRIVE_DOWNLOAD_FAILED (502). Network/timeout
 *     errors propagate from `fetchWithTimeout` and surface the same way.
 *
 * Memory: holds the full file in memory as a Buffer. Chunks are ~16 KB
 * in the MVP, so this is fine; the same trade-off is documented for
 * `uploadFile`.
 */
export async function downloadFile(
  accessToken: string,
  fileId: string,
): Promise<Buffer> {
  const safeId = encodeURIComponent(fileId);
  const res = await fetchWithTimeout(
    `${DRIVE_API_BASE}/files/${safeId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (res.status === 404) {
    throw new AppError(
      404,
      'DRIVE_FILE_NOT_FOUND',
      'Drive file not found for the given remote_reference',
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    logger.warn(
      {
        op: 'drive.downloadFile',
        status: res.status,
        detail: detail.substring(0, 200),
      },
      'Drive download failed',
    );
    throw new AppError(
      502,
      'DRIVE_DOWNLOAD_FAILED',
      `Drive download failed (${res.status})`,
    );
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
