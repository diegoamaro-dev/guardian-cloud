/**
 * GC-AUTH-SESSION-RECOVERY-001 · D2-C — the refresh rate-limit classifier.
 *
 * ## The defect this closes
 *
 * `auth-js` decides whether a failed refresh destroys the persisted session
 * by asking ONE question: `isAuthRetryableFetchError(error)`, which is
 * `error.name === 'AuthRetryableFetchError'` and nothing more. That class
 * is built only for a non-Response failure or a status in
 * `NETWORK_ERROR_CODES`. A `429` is neither, so it becomes `AuthApiError`,
 * and `_callRefreshToken` calls `_removeSession()` — deleting the access
 * AND refresh token, which live under one key.
 *
 * 2.112.3 softened this: a refresh that fails while the access token is
 * still valid preserves the session ("proactive-preserve"). But once the
 * access token has expired — the state a device reaches after any long
 * offline window — the deletion stands. Guardian Cloud has an anonymous
 * identity and therefore NO re-authentication flow, so that deletion is
 * terminal: the evidence on disk can never be uploaded.
 *
 * A `429` says the server wants fewer requests. It says NOTHING about
 * whether the credential is valid.
 *
 * ## Why the discrimination is the server's, not ours
 *
 * GoTrue already distinguishes these cases in its own vocabulary, and
 * `handleError` already extracts it — `auth-js` simply never consults it
 * when deciding to delete:
 *
 *   over_request_rate_limit      rate limit. Says nothing about the token.
 *   refresh_token_not_found      the credential is gone.
 *   refresh_token_already_used   the credential was spent.
 *   session_expired              the session is over.
 *   session_not_found            the session is over.
 *
 * So this module does not classify by HTTP status alone, and does not
 * guess. The rule is `status 429` AND `error_code over_request_rate_limit`
 * — both, or nothing happens.
 *
 * ## Why throwing, and why that is not a lie
 *
 * `createClient({ global: { fetch } })` is the only extension point
 * `GoTrueClientOptions` exposes — there is no `shouldRetry`, no
 * `retryPolicy`, no error hook. A fetch may do exactly two things: return
 * a Response, or throw. Returning the 429 destroys the credential;
 * returning a different status would be a fabricated HTTP status. So the
 * remaining move is to decline to hand over a response at all, which
 * `_handleRequest` encodes as status **0** — "there was no response" —
 * and which its own comment describes as the network/aborted case:
 *
 *     catch (e) { throw new AuthRetryableFetchError(_getErrorMessage(e), 0) }
 *
 * Status 0 is not a fake HTTP status. It is the absence of one. The real
 * 429 is not hidden: it is logged, with its code, on every occurrence.
 *
 * ## What this module deliberately does NOT contain
 *
 * No retry. No counter. No budget. No `setTimeout`, no sleep, no jitter,
 * no `Retry-After` wait, no persistent state, no shadow copy of any token.
 *
 * That emptiness is a measured decision, not an omission. `auth-js` calls
 * this wrapper ONCE PER ATTEMPT of its own `retryable()` loop, so any wait
 * added here is multiplied by the attempt count (8 for a persistent
 * failure). Honouring `Retry-After` with a 5 s sleep would add up to 40 s
 * to a path `startRecording` awaits. The exponential backoff that spaces
 * these attempts already exists, is already bounded at 30 s, and is
 * already followed by a 60 s failure cooldown. A second retry machine
 * inside the first would buy nothing and cost START latency.
 *
 * Cost of this module to `startRecording`: **0 ms of intentional
 * sleep/backoff**. It contains no scheduling primitive at all. It is NOT
 * computationally free — on the classified path it runs one
 * `Response.clone().json()` and one log line — and that distinction is
 * kept deliberately rather than rounded to "zero cost".
 *
 * ## Fail-closed, in the direction of auth-js
 *
 * Anything not matched — a 429 with no code, an unrecognised code, a body
 * that will not parse, a different endpoint, a different status, or an
 * exception thrown by this classifier itself — returns the ORIGINAL
 * Response, untouched, and `auth-js` behaves exactly as it would without
 * this module. A failure of ours must never become a decision to preserve
 * a credential.
 */

/** The one code that means "slow down" and nothing about the credential. */
const RATE_LIMIT_CODE = 'over_request_rate_limit';

/**
 * Thrown to decline handing a rate-limit response to auth-js.
 *
 * A plain `Error`, deliberately: `_handleRequest` only needs it to NOT be
 * a Response. It never reaches application code — auth-js catches it and
 * substitutes `AuthRetryableFetchError`.
 */
export class RefreshRateLimitedError extends Error {
  constructor() {
    super('refresh rate limited');
    this.name = 'RefreshRateLimitedError';
  }
}

/**
 * The request URL, for each of the three shapes `fetch` accepts.
 *
 * `String(request)` yields `"[object Request]"`, which contains neither
 * `/token` nor the grant type — a `Request` argument would therefore never
 * be classified, and a rate-limited refresh issued that way would still
 * destroy the session. auth-js passes a string today; this does not depend
 * on that staying true.
 */
function readRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input); // URL
}

/**
 * The refresh endpoint's path, derived from the client rather than guessed.
 *
 * `SupabaseClient` builds `authUrl = new URL('auth/v1', baseUrl)` and
 * `_refreshAccessToken` requests `${authUrl}/token?grant_type=refresh_token`,
 * so for a hosted project URL the pathname is exactly this. No hostname and
 * no project ref appear here — only the path the client itself constructs.
 *
 * A self-hosted deployment under a sub-path would produce
 * `/sub/auth/v1/token` and therefore NOT match. That is deliberate: an
 * unrecognised shape falls through to auth-js untouched, which is the safe
 * direction. Widening this would mean matching loosely, and matching
 * loosely on the one rule that can preserve a credential is the mistake
 * this correction exists to remove.
 */
const REFRESH_PATHNAME = '/auth/v1/token';
const REFRESH_GRANT_TYPE = 'refresh_token';

/**
 * True only for `POST {authUrl}/token?grant_type=refresh_token`.
 *
 * Parsed, never substring-matched. `includes('/token')` also accepts
 * `/auth/v1/token-extra` and `/auth/v1/not-token`, and
 * `includes('grant_type=refresh_token')` also accepts it appearing inside
 * an unrelated query value. Both would let this module intervene on
 * traffic it was never authorised to touch.
 */
function isRefreshRequest(url: string, method: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable, or relative. Fail-closed: auth-js decides.
    return false;
  }

  if (parsed.pathname !== REFRESH_PATHNAME) return false;
  return parsed.searchParams.get('grant_type') === REFRESH_GRANT_TYPE;
}

/**
 * The error code GoTrue sent, or null.
 *
 * Mirrors `handleError`'s own extraction: newer API versions carry it in
 * `code`, older ones in `error_code`. Both are accepted, and both must be
 * strings — `code` is also used for a numeric HTTP echo in some bodies,
 * and a number must never match.
 */
function readErrorCode(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as { code?: unknown; error_code?: unknown };
  if (typeof body.code === 'string') return body.code;
  if (typeof body.error_code === 'string') return body.error_code;
  return null;
}

/**
 * Wraps a fetch implementation for `createClient({ global: { fetch } })`.
 *
 * Value- and effect-transparent everywhere except the single case named
 * above. The delegate is always called exactly once; this wrapper never
 * issues a request of its own and never suppresses one.
 */
export function instrumentRefreshFetch(delegate: typeof fetch): typeof fetch {
  return async function refreshAwareFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const res = await delegate(input, init);

    // Everything below is classification. It may not change the outcome of
    // the request in any way other than the one documented throw, so the
    // whole of it sits inside a try that falls back to the original.
    try {
      if (res.status !== 429) return res;

      const url = readRequestUrl(input);
      // Same guard as `readRequestUrl`, for consistency — NOT because a
      // live path needs it, and the difference is worth stating.
      //
      // An unguarded `instanceof` against a missing global throws, and the
      // catch below would hand back the original response. But that never
      // changes an outcome: with `init.method` present the `??`
      // short-circuits and the `instanceof` is not evaluated; with it
      // absent, the guarded form yields 'GET', which is not a refresh POST
      // and passes through anyway. And a `Request` instance cannot exist
      // where the global does not. Verified by mutation: removing this
      // guard kills no test.
      //
      // It stays because it costs nothing and because a future refactor
      // that drops the `??` short-circuit would make it load-bearing.
      const method =
        init?.method ??
        (typeof Request !== 'undefined' && input instanceof Request
          ? input.method
          : 'GET');
      if (!isRefreshRequest(url, method)) return res;

      // `clone()` is what keeps the pass-through honest: the body of `res`
      // is never consumed here, so auth-js still reads it in full. Reading
      // `res` directly would leave a spent stream for `handleError`.
      const payload = await res.clone().json();
      const errorCode = readErrorCode(payload);

      if (errorCode !== RATE_LIMIT_CODE) {
        // Includes: no code, an unrecognised code, and every explicit
        // credential-invalid code. auth-js decides, unmodified.
        return res;
      }

      // Metadata only. No token, no body, no URL (it carries the project
      // ref), no headers.
      console.log('GC_AUTH_RATE_LIMIT', {
        observed_status: 429,
        error_code: errorCode,
        exit_reason: 'classified_retryable',
      });
      throw new RefreshRateLimitedError();
    } catch (err) {
      // The one throw that must survive this catch.
      if (err instanceof RefreshRateLimitedError) throw err;
      // Anything else — a body that will not parse, a missing `clone`, a
      // bug of ours — is OUR failure, and our failures do not get to
      // preserve credentials. Hand auth-js the response it would have had.
      return res;
    }
  };
}
