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

import { createHash } from 'node:crypto';

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

/**
 * Network refresh of a Google access token. Internal — callers should use
 * the cached `getAccessToken` below, which falls back to this on miss /
 * expiry / explicit invalidation. The retry/backoff for transient Google
 * failures is owned here, NOT by the cache layer (the cache must not add
 * another retry tier on top).
 */
async function _refreshFromGoogle(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
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
      const json = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
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
      return {
        access_token: json.access_token,
        // Default to 3600s if Google omits the field — same as observed
        // production behaviour. The cache layer applies its own safety
        // margin AND a hard ceiling on top, so a missing value cannot
        // make us cache for longer than is safe.
        expires_in: typeof json.expires_in === 'number' ? json.expires_in : 3600,
      };
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

// ===== Access-token cache (in-memory, per-process) ===========================
//
// Why this cache exists:
//   `_refreshFromGoogle` makes an outbound HTTP call to oauth2.googleapis.com
//   that typically takes 150-400 ms. The chunk-upload hot path
//   (POST /destinations/drive/chunks) used to invoke it on every chunk —
//   30+ token refreshes for a 1-minute audio session, 100% redundant since
//   Google access_tokens live ~1 hour.
//
// Strict isolation contract (matches the project rules):
//   - in-memory only, no DB, no Redis, no migrations
//   - never persisted across process restarts
//   - never logs the access_token or the raw refresh_token (the cache key
//     is the truncated SHA-256 of the refresh_token, sized so it identifies
//     the entry in logs but cannot be inverted to recover the secret)
//   - if any cache operation throws, callers fall back to the uncached path
//     transparently — the cache is a pure latency optimisation, never a
//     correctness gate
//   - external HTTP behaviour (status codes, response bodies, error codes)
//     is byte-identical to the previous uncached path
//
// TTL strategy:
//   Google's `expires_in` typically returns 3600 (1 hour). We subtract a
//   5-minute safety margin so the cached token is always returned with
//   meaningful runway before Google rejects it. We additionally cap the
//   cached lifetime at 55 minutes regardless of how long Google says the
//   token is good for — defence against an upstream change that returns
//   a much longer lifetime than we are prepared to validate.
//
// Concurrency:
//   Two requests from the same user racing on a cache miss would both
//   refresh against Google, wasting one network round-trip. The slot
//   stores either a resolved CachedToken or an in-flight Promise; the
//   second arrival awaits the first's promise instead of starting its
//   own. If the in-flight refresh rejects, the slot is cleared and any
//   waiter falls through to start a fresh attempt.

interface CachedToken {
  access_token: string;
  /** Epoch ms past which the entry is considered stale and must refresh. */
  expires_at: number;
}

interface InFlightToken {
  in_flight: Promise<CachedToken>;
}

type CacheValue = CachedToken | InFlightToken;

const TOKEN_CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_CACHE_MAX_TTL_MS = 55 * 60 * 1000; // hard ceiling
const tokenCache = new Map<string, CacheValue>();

function isCachedToken(v: CacheValue): v is CachedToken {
  return 'access_token' in v;
}

/**
 * Cache key: truncated SHA-256 of the refresh_token. Hashing makes the
 * key safe to put in logs and prevents accidental token leakage; truncating
 * keeps log lines short while leaving enough entropy that collisions are
 * astronomically unlikely for any realistic user count.
 */
function tokenCacheKey(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex').substring(0, 32);
}

/**
 * Public cache-aware wrapper around `_refreshFromGoogle`. Same external
 * signature as the previous uncached `getAccessToken` so call sites do
 * not change. On any cache failure (key computation throw, Map.set/get
 * throw, slot found in unexpected state) this falls back to a direct
 * `_refreshFromGoogle` call so a buggy cache layer can never block the
 * chunk-upload path.
 */
export async function getAccessToken(refreshToken: string): Promise<string> {
  let key: string;
  try {
    key = tokenCacheKey(refreshToken);
  } catch (err) {
    // Cache key computation failed — fall back to the uncached path.
    logger.warn(
      { op: 'getAccessToken', reason: err instanceof Error ? err.message : String(err) },
      'DRIVE_TOKEN_CACHE_FALLBACK',
    );
    const fresh = await _refreshFromGoogle(refreshToken);
    return fresh.access_token;
  }
  const keyShort = key.substring(0, 12);

  // Cache lookup. Wrapped in try/catch so a Map error cannot drag the
  // request down.
  let cached: CacheValue | undefined;
  try {
    cached = tokenCache.get(key);
  } catch {
    cached = undefined;
  }

  if (cached) {
    if (isCachedToken(cached)) {
      if (cached.expires_at > Date.now()) {
        logger.info(
          { op: 'getAccessToken', cache: 'hit', key_short: keyShort },
          'DRIVE_TOKEN_CACHE',
        );
        return cached.access_token;
      }
      // Expired — fall through to refresh; clean the stale slot first
      // so a concurrent caller does not also see it.
      try {
        tokenCache.delete(key);
      } catch {
        /* swallow */
      }
    } else {
      // Concurrent in-flight refresh — share its promise.
      logger.info(
        { op: 'getAccessToken', cache: 'in_flight', key_short: keyShort },
        'DRIVE_TOKEN_CACHE',
      );
      try {
        const shared = await cached.in_flight;
        return shared.access_token;
      } catch {
        // The in-flight refresh failed. Fall through to start a fresh
        // attempt; the original promise's catch already cleared the slot.
      }
    }
  }

  // Cache miss / expired / failed in-flight. Start a refresh and install
  // the in-flight slot synchronously (no awaits between this `set` and
  // the caller's await) so concurrent callers see it.
  const t_start = Date.now();
  const promise = (async (): Promise<CachedToken> => {
    const fresh = await _refreshFromGoogle(refreshToken);
    const expires_in_ms = Math.max(0, fresh.expires_in * 1000);
    const ttl_ms = Math.min(
      Math.max(0, expires_in_ms - TOKEN_CACHE_SAFETY_MARGIN_MS),
      TOKEN_CACHE_MAX_TTL_MS,
    );
    return {
      access_token: fresh.access_token,
      expires_at: Date.now() + ttl_ms,
    };
  })();
  try {
    tokenCache.set(key, { in_flight: promise });
  } catch {
    // If the set throws we still await our own promise — the
    // single-flight benefit is lost for this call but correctness holds.
  }

  let result: CachedToken;
  try {
    result = await promise;
  } catch (err) {
    // Refresh failed. Clean up the in-flight slot so subsequent calls
    // retry from scratch. We only delete OUR slot — concurrent callers
    // that arrive after the failure will install their own.
    try {
      const current = tokenCache.get(key);
      if (current && !isCachedToken(current) && current.in_flight === promise) {
        tokenCache.delete(key);
      }
    } catch {
      /* swallow */
    }
    throw err;
  }

  // Promote in-flight → resolved value. Guard against the slot having
  // been overwritten or invalidated while we were awaiting (rare).
  try {
    const current = tokenCache.get(key);
    if (current && !isCachedToken(current) && current.in_flight === promise) {
      tokenCache.set(key, result);
    }
  } catch {
    /* swallow */
  }

  logger.info(
    {
      op: 'getAccessToken',
      cache: 'miss',
      key_short: keyShort,
      refresh_ms: Date.now() - t_start,
      ttl_ms: result.expires_at - Date.now(),
    },
    'DRIVE_TOKEN_CACHE',
  );

  return result.access_token;
}

/**
 * Drop any cached entry for `refreshToken`. Called by `withDriveRetry`
 * after Drive responds 401, on the assumption that the cached
 * access_token has been invalidated server-side (token revoked, scope
 * changed, etc.). The next `getAccessToken` for the same refresh_token
 * will refresh against Google.
 *
 * Idempotent and silent: deleting a missing entry is a no-op. Logged so
 * an operator can trace cause/effect when chasing a 401 storm.
 */
export function invalidateAccessToken(refreshToken: string): void {
  let key: string;
  try {
    key = tokenCacheKey(refreshToken);
  } catch {
    return;
  }
  let had = false;
  try {
    had = tokenCache.delete(key);
  } catch {
    /* swallow */
  }
  if (had) {
    logger.info(
      { op: 'invalidateAccessToken', key_short: key.substring(0, 12), reason: '401' },
      'DRIVE_TOKEN_INVALIDATE',
    );
  }
}

/**
 * True if `err` is the synthetic `DRIVE_AUTH_EXPIRED` AppError raised by
 * the Drive helpers below when Google returns 401. Used by
 * `withDriveRetry` to decide whether to invalidate + retry vs propagate.
 */
export function isDriveAuthExpired(err: unknown): boolean {
  return err instanceof AppError && err.code === 'DRIVE_AUTH_EXPIRED';
}

/**
 * Diagnostic metrics populated by `withDriveRetry` for the route-level
 * timing log. Optional — passing `undefined` means the wrapper still
 * works, callers just lose the per-leg timings.
 */
export interface DriveRetryMetrics {
  /** Wall-clock ms spent inside the FIRST `getAccessToken` call. */
  token_ms: number;
  /** True if the closure was retried after a `DRIVE_AUTH_EXPIRED`. */
  retried: boolean;
  /**
   * Wall-clock ms spent inside the SECOND `getAccessToken` call, only
   * populated when `retried === true`. Useful for telling apart "cached
   * token went stale" (small ms) from "refresh_token was revoked
   * server-side" (full Google round-trip ms).
   */
  retry_token_ms?: number;
}

/**
 * Run `fn(accessToken)` against a freshly-resolved access token. If the
 * Drive call inside throws `DRIVE_AUTH_EXPIRED` (Google 401), invalidate
 * the cache, refresh once, and retry exactly once with the new token.
 * Any further failure — including a second `DRIVE_AUTH_EXPIRED` —
 * propagates unchanged. There is no third attempt, no exponential
 * backoff, no loop. Comportamiento externo idéntico al flujo previo en
 * todo lo demás.
 */
export async function withDriveRetry<T>(
  refreshToken: string,
  fn: (accessToken: string) => Promise<T>,
  metrics?: DriveRetryMetrics,
): Promise<T> {
  const t_token = Date.now();
  let token = await getAccessToken(refreshToken);
  if (metrics) {
    metrics.token_ms = Date.now() - t_token;
    metrics.retried = false;
  }
  try {
    return await fn(token);
  } catch (err) {
    if (!isDriveAuthExpired(err)) throw err;
    invalidateAccessToken(refreshToken);
    const t_retry = Date.now();
    token = await getAccessToken(refreshToken);
    if (metrics) {
      metrics.retried = true;
      metrics.retry_token_ms = Date.now() - t_retry;
    }
    logger.info(
      { op: 'withDriveRetry', retried_after_401: true },
      'DRIVE_TOKEN_RETRY',
    );
    return await fn(token);
  }
}

/** Test-only seam: clear the entire cache. Intentionally NOT used by
 *  production code paths. Exported so unit tests can isolate cases
 *  across `vi.resetModules` boundaries when needed. */
export function _resetAccessTokenCacheForTests(): void {
  try {
    tokenCache.clear();
  } catch {
    /* swallow */
  }
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
    if (res.status === 401) {
      // 401 from Drive means the access_token has been invalidated
      // server-side. Distinct code so `withDriveRetry` can detect this
      // exact failure mode and refresh+retry once instead of propagating.
      throw new AppError(
        401,
        'DRIVE_AUTH_EXPIRED',
        `Drive API GET ${path} 401 (access token rejected)`,
      );
    }
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
    if (res.status === 401) {
      throw new AppError(
        401,
        'DRIVE_AUTH_EXPIRED',
        `Drive API POST ${path} 401 (access token rejected)`,
      );
    }
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
 * Lightweight projection of a Drive file returned by `files.list`. Only
 * the fields actually consumed by `recovery.service.ts` are surfaced;
 * adding more here just requires extending the `fields` query string.
 */
export interface DriveFileListing {
  id: string;
  name: string;
  modifiedTime: string;
}

export interface ListFilesOptions {
  /** Drive `q` parameter — filters by name. Substring match, not regex. */
  nameContains?: string | undefined;
  /** Page size cap per Drive request. Defaults to 100 (Drive max 1000). */
  pageSize?: number | undefined;
  /** Hard cap on pages followed to bound the call. Defaults to 10. */
  maxPages?: number | undefined;
}

/**
 * List files under `folderId` that this app created, optionally filtered
 * by a name substring. Paginates with `nextPageToken` up to `maxPages` to
 * bound the worst case, then stops. Returns the raw Drive projection;
 * callers do their own regex / shape validation.
 *
 * Scope-safe: `drive.file` only ever surfaces files the app created, so
 * this query cannot enumerate user content outside that set.
 *
 * The only Drive primitive this helper exposes beyond what `findFileByName`
 * already does is pagination + multi-result return — kept narrow so future
 * callers do not start synthesising arbitrary Drive queries from outside
 * the service module.
 */
export async function listFilesInFolder(
  accessToken: string,
  folderId: string,
  options: ListFilesOptions = {},
): Promise<DriveFileListing[]> {
  const { nameContains, pageSize = 100, maxPages = 10 } = options;

  const safeFolder = folderId.replace(/'/g, "\\'");
  let qParts = [`'${safeFolder}' in parents`, 'trashed = false'];
  if (nameContains) {
    const safeNeedle = nameContains.replace(/'/g, "\\'");
    qParts.push(`name contains '${safeNeedle}'`);
  }
  const q = encodeURIComponent(qParts.join(' and '));
  const fields = encodeURIComponent('files(id,name,modifiedTime),nextPageToken');

  const all: DriveFileListing[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const tokenParam = pageToken
      ? `&pageToken=${encodeURIComponent(pageToken)}`
      : '';
    const path =
      `/files?q=${q}&fields=${fields}` +
      `&pageSize=${pageSize}&spaces=drive${tokenParam}`;
    const res = await driveGet<{
      files?: DriveFileListing[];
      nextPageToken?: string;
    }>(accessToken, path);
    if (Array.isArray(res.files)) all.push(...res.files);
    if (!res.nextPageToken) return all;
    pageToken = res.nextPageToken;
  }
  return all;
}

/**
 * Replace the content bytes of an existing Drive file by `fileId`. Uses
 * Drive's "simple media upload" PATCH path (no metadata change, just
 * content). Atomic per file — interrupting this call leaves either the
 * old content intact OR the new content fully written; partial mid-write
 * states are not observable through Drive's API.
 *
 * Returns the same `DriveUploadResult` shape as `uploadFile` so the two
 * functions are interchangeable through `uploadOrReplaceFile` (which
 * picks one based on whether a file with the same name already exists).
 *
 * Used by the manifest pipeline so a session ends up with exactly ONE
 * manifest file in Drive across all incremental writes + the final
 * write at /complete. Without this, repeated `uploadFile` calls under
 * the same `fileName` would create duplicate Drive files (Drive permits
 * dup names per folder); discovery's most-recent-modifiedTime dedup
 * would still pick the latest, but Drive clutter would grow linearly.
 *
 * Failure modes mirror `uploadFile`:
 *   - 401 → DRIVE_AUTH_EXPIRED (caller's withDriveRetry will refresh)
 *   - 404 → DRIVE_FILE_NOT_FOUND (the file_id is no longer valid)
 *   - any other non-2xx → DRIVE_UPLOAD_FAILED (502)
 */
export async function updateFileContent(
  accessToken: string,
  fileId: string,
  content: Uint8Array | Buffer,
  mimeType = 'application/octet-stream',
): Promise<DriveUploadResult> {
  const safeId = encodeURIComponent(fileId);
  // `Buffer.concat([x])` returns `Buffer<ArrayBuffer>` (concrete) where
  // a direct `Buffer.from(Uint8Array)` returns `Buffer<ArrayBufferLike>`
  // — the former is assignable to DOM `BodyInit`, the latter is not.
  // Mirrors the pattern the existing `uploadFile` uses for its body.
  const contentBuffer = Buffer.concat([
    Buffer.isBuffer(content) ? content : Buffer.from(content),
  ]);
  const res = await fetchWithTimeout(
    `${DRIVE_UPLOAD_BASE}/files/${safeId}?uploadType=media&fields=id,name,size,webViewLink`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': mimeType,
        'Content-Length': contentBuffer.length.toString(),
      },
      body: contentBuffer,
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>');
    logger.warn(
      {
        op: 'drive.updateFileContent',
        status: res.status,
        size: contentBuffer.length,
        detail: detail.substring(0, 200),
      },
      'Drive update content failed',
    );
    if (res.status === 401) {
      throw new AppError(
        401,
        'DRIVE_AUTH_EXPIRED',
        'Drive update 401 (access token rejected)',
      );
    }
    if (res.status === 404) {
      throw new AppError(
        404,
        'DRIVE_FILE_NOT_FOUND',
        'Drive update target file no longer exists',
      );
    }
    throw new AppError(
      502,
      'DRIVE_UPLOAD_FAILED',
      `Drive update failed (${res.status})`,
    );
  }

  const json = (await res.json()) as {
    id?: string;
    name?: string;
    size?: string;
    webViewLink?: string;
  };
  if (!json.id) {
    throw new AppError(502, 'DRIVE_UPLOAD_FAILED', 'Drive update returned no file id');
  }

  return {
    file_id: json.id,
    name: json.name ?? '',
    size: Number(json.size ?? contentBuffer.length),
    web_view_link: json.webViewLink,
  };
}

/**
 * Find-or-create write semantics. If a file with `fileName` already
 * exists under `folderId`, replace its content via `updateFileContent`;
 * otherwise create a new file via `uploadFile`. Returns the same
 * `DriveUploadResult` either way.
 *
 * This keeps the manifest path deterministic: exactly ONE manifest
 * file per session in Drive across incremental writes + the final
 * write at /complete. Adheres to the "no multi-manifest" project rule.
 *
 * Race: if two concurrent calls race past the `findFileByName` check
 * before either uploads, BOTH create new files (Drive permits dup
 * names). Discovery dedups by session_id + most recent modifiedTime,
 * so end-user behaviour is correct. This is an acceptable race because
 * the only caller is fire-and-forget from the chunk upload handler.
 */
export async function uploadOrReplaceFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  content: Uint8Array | Buffer,
  mimeType = 'application/octet-stream',
): Promise<DriveUploadResult> {
  const existingId = await findFileByName(accessToken, folderId, fileName);
  if (existingId) {
    return await updateFileContent(accessToken, existingId, content, mimeType);
  }
  return await uploadFile(accessToken, folderId, fileName, content, mimeType);
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
    if (res.status === 401) {
      throw new AppError(
        401,
        'DRIVE_AUTH_EXPIRED',
        'Drive upload 401 (access token rejected)',
      );
    }
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
    if (res.status === 401) {
      throw new AppError(
        401,
        'DRIVE_AUTH_EXPIRED',
        'Drive download 401 (access token rejected)',
      );
    }
    throw new AppError(
      502,
      'DRIVE_DOWNLOAD_FAILED',
      `Drive download failed (${res.status})`,
    );
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
