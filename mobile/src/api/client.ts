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
import { getFreshAccessToken } from '@/auth/store';

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
  /** Per-call timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Optional AbortSignal wired in from a caller (e.g. a screen unmount). */
  signal?: AbortSignal;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const { method = 'GET', body, auth = true, timeoutMs = 10_000, signal } = init;

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
    const token = await getFreshAccessToken();
    if (!token) {
      throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
    }
    headers.Authorization = `Bearer ${token}`;
  }

  // Compose the abort signal: our own timeout + any caller signal.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const composedSignal = composeSignals(timeoutController.signal, signal);

  let response: Response;
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: composedSignal,
    });
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
