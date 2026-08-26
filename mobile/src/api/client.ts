/**
 * Backend API client.
 *
 * Single `apiFetch` wrapper used by every resource module (sessions,
 * chunks, health). Centralises:
 *   - base URL from env
 *   - `Authorization: Bearer <access_token>` when we have one
 *   - JSON body + response handling
 *   - uniform error shape (`ApiError`) so callers don't have to care
 *     whether a failure was network, HTTP 4xx, or HTTP 5xx.
 *
 * Intentionally thin. No retries, no queue, no backoff here — that lives
 * in `queue/worker.ts` (next brick). API failures from authenticated
 * screens should NOT auto-sign-out the user either; that decision belongs
 * to higher layers once we have real retry semantics.
 */

import { env } from '@/config/env';
import { getAccessToken, getOwnershipToken } from '@/auth/store';

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(status: number, code: string | undefined, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface ApiFetchInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Set to false for endpoints that don't need auth (e.g. /health). */
  auth?: boolean;
  /**
   * R5 — set on every endpoint that CREATES OR MUTATES remote state owned
   * by this user. The token then comes from `getOwnershipToken`, which
   * refuses to hand one out until `gc.identity.v1` is durable.
   *
   * Reads leave this off: listing destinations or fetching chunk state
   * creates nothing to own. Getting this wrong on a new mutating endpoint
   * is the one way to slip past the gate, so the rule is simple — if the
   * server keeps anything afterwards, set it.
   */
  ownership?: boolean;
  /** Per-call timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Optional AbortSignal wired in from a caller (e.g. a screen unmount). */
  signal?: AbortSignal;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const {
    method = 'GET',
    body,
    auth = true,
    ownership = false,
    timeoutMs = 10_000,
    signal,
  } = init;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (auth) {
    // Pull the latest access token from supabase-js rather than the
    // Zustand snapshot: supabase-js refreshes inline on getSession()
    // when the persisted token has expired (the store snapshot can
    // be stale after a background window where the auto-refresh
    // timer didn't fire on time).
    const result = ownership
      ? await getOwnershipToken()
      : await getAccessToken();
    if (!result.ok) {
      // GC-AUTH-001: `reason` is the whole point of this line. Without it
      // a lost network packet and a server-revoked session produce the
      // same log, and a device flooding thousands of these tells you
      // nothing about which. `name` is a class name, never a message.
      console.log('AUTH MISSING', {
        path,
        reason: result.reason,
        name: result.name,
      });
      // R5 — a refused OWNERSHIP token is not a missing session. The user
      // is signed in; the device just cannot yet prove locally that this
      // identity exists, which is transient and self-healing. Give it a
      // distinct code so a screen can say "one moment" instead of
      // "you need to sign in", which would be false and alarming.
      if (result.reason === 'marker_not_durable') {
        throw new ApiError(
          401,
          'IDENTITY_NOT_READY',
          'Identity not durably recorded yet',
          null,
        );
      }
      throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
    }
    headers.Authorization = `Bearer ${result.token}`;
  }

  // Compose the abort signal: our own timeout + any caller signal.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const composedSignal = composeSignals(timeoutController.signal, signal);

  // Build RequestInit step-by-step so `body` is only set when defined —
  // exactOptionalPropertyTypes forbids assigning `undefined` to an
  // optional `body` field, which the previous inline object literal did.
  const requestInit: RequestInit = {
    method,
    headers,
    signal: composedSignal,
  };
  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  const url = `${env.apiUrl}${path}`;
  // `authed` reflects the INTENT (auth was requested for this call).
  // `auth_header_set` reflects the OUTCOME (the header was actually
  // composed onto the outgoing request). Both must be true for the
  // request to reach the backend with a Bearer; if `authed=true` but
  // `auth_header_set=false` we'd have aborted with AUTH MISSING above
  // and never reached this log line — so they should always agree at
  // this point. Keeping both makes diagnostics in `adb logcat` trivial:
  // a backend `authorization_present:false` paired with a client
  // `auth_header_set:true` proves the bytes were dropped between
  // device and server (proxy, ngrok, stale APK), not in the client.
  console.log('API CALL', {
    method,
    url,
    authed: auth,
    auth_header_set: 'Authorization' in headers,
  });
  let response: Response;
  try {
    response = await fetch(url, requestInit);
  } catch (e) {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      e instanceof Error ? e.message : 'Network request failed',
      null,
    );
  } finally {
    clearTimeout(timer);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const parsed: unknown =
    contentType.includes('application/json') ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const errBody = (parsed as ApiErrorBody) ?? {};
    throw new ApiError(
      response.status,
      errBody.error?.code,
      errBody.error?.message ?? `HTTP ${response.status}`,
      parsed,
    );
  }

  return parsed as T;
}

/**
 * Combine multiple AbortSignals into one. `AbortSignal.any` exists in
 * modern runtimes but is not guaranteed across React Native versions,
 * so we do it by hand.
 */
function composeSignals(
  a: AbortSignal,
  b: AbortSignal | undefined,
): AbortSignal {
  if (!b) return a;
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', forward, { once: true });
  b.addEventListener('abort', forward, { once: true });
  return controller.signal;
}
