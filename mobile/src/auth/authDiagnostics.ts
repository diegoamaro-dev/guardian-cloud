/**
 * GC-AUTH-SESSION-RECOVERY-001 · D0 — OBSERVABILITY ONLY.
 *
 * On 2026-08-22 a device holding 87 chunks of unuploaded evidence lost its
 * Supabase session: the key `sb-<ref>-auth-token` vanished from
 * AsyncStorage, `getSession()` began answering `{session: null, error:
 * null}`, and — correctly — the identity marker stopped a replacement
 * identity from being minted. The evidence became unuploadable.
 *
 * Six places inside auth-js 2.103.3 call `_removeSession()`. THREE OF
 * THEM ARE SILENT, `_debug()` is a no-op unless `debug` is set, and our
 * own `onAuthStateChange` handler discarded the event name. So the run
 * could not say which path fired, nor whether the refresh token had
 * actually been invalidated server-side. That is what this module fixes:
 * it makes the next reproduction diagnosable. It does NOT fix the defect.
 *
 * ## Nothing here changes behaviour
 *
 *   - the storage adapter is value- and effect-transparent: same values,
 *     same order of writes and deletions, same rejections. It is NOT a
 *     bare passthrough — deleting the session key costs one extra
 *     `getItem` first, so the log can say whether the refresh token was
 *     still there. That read is the only added operation in the module,
 *     it never blocks the deletion, and nothing else observes it;
 *   - the debug logger cannot throw (auth-js calls it inside its own hot
 *     paths, and a throwing logger would break the auth client);
 *   - no session is written, restored, or repaired;
 *   - no identity is created;
 *   - the retryable/non-retryable classification used by auth-js is
 *     untouched — `classifyAuthError` below is a REPORTING label, read by
 *     nothing.
 *
 * ## Why `debug: true` is NOT used
 *
 * It is unsafe in this version. `debug` accepts `boolean | fn`, and with
 * `true` the logger is `console.log`, which receives whole session
 * objects:
 *
 *   #getSession()      'session from storage', maybeSession   ← tokens
 *   _recoverAndRefresh 'session from storage', currentSession ← tokens
 *   _notifyAllSubscribers 'begin', session                    ← tokens
 *   #_saveSession()    session                                ← tokens
 *
 * and `_callRefreshToken` builds its debug name from
 * `refreshToken.substring(0, 5)` — five characters of the live refresh
 * token in every line it emits.
 *
 * So we pass a FUNCTION instead. It never forwards an argument by value:
 * every one is reduced to shape metadata, and the message string itself
 * is scrubbed before emission.
 */

/** Emitted for every diagnostic line. One prefix, easy to grep. */
const TAG_DEBUG = 'GC_AUTH_DEBUG';
const TAG_EVENT = 'GC_AUTH_EVENT';
const TAG_STORAGE = 'GC_AUTH_STORAGE';

/**
 * A JWT is three base64url segments separated by dots. Supabase refresh
 * tokens are shorter opaque strings, so length alone is also treated as
 * suspicious. Both collapse to a length, never a prefix: five characters
 * of a secret are still five characters of a secret.
 */
const JWT_SHAPED = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_OPAQUE = /\b[A-Za-z0-9_-]{20,}\b/g;

/**
 * The one leak the generic rules CANNOT catch, and the reason this exists
 * as its own pattern:
 *
 *   `#_callRefreshToken(${refreshToken.substring(0, 5)}...)`
 *
 * Five characters is too short for `LONG_OPAQUE` and has no dots for
 * `JWT_SHAPED`, so a length threshold will never see it — and auth-js
 * stamps that name on EVERY debug line of the refresh path, which is
 * precisely the path this investigation is about. Five characters of a
 * live refresh token are still five characters of a live refresh token.
 * The whole parenthesised span goes.
 */
const REFRESH_DEBUG_NAME = /(_callRefreshToken\()[^)]*(\))/g;

/** Redacts a string for logging. Never returns any part of a secret. */
export function scrubString(input: string): string {
  return input
    .replace(REFRESH_DEBUG_NAME, '$1<redacted>$2')
    .replace(JWT_SHAPED, (m) => `<jwt:len=${m.length}>`)
    .replace(LONG_OPAQUE, (m) => `<opaque:len=${m.length}>`);
}

/**
 * Reduces any value to metadata safe to print.
 *
 * Objects never contribute VALUES, only the SHAPE: which keys exist. An
 * `Error` contributes its class, code and status — the three fields that
 * distinguish the auth-js failure modes — and nothing else. This is the
 * single choke point; if a future caller wants richer output it must
 * change here, where the rule is visible.
 */
export function redactForLog(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) {
    const e = value as Error & { code?: unknown; status?: unknown };
    return {
      error_class: e.name,
      error_code: typeof e.code === 'string' ? e.code : null,
      error_status: typeof e.status === 'number' ? e.status : null,
    };
  }
  if (Array.isArray(value)) return { array_len: value.length };
  if (typeof value === 'object') {
    // Shape only. A session object reports THAT it has an access_token,
    // never the token.
    return { keys: Object.keys(value as Record<string, unknown>).sort() };
  }
  return { type: typeof value };
}

/**
 * auth-js emits a debug line for nearly every internal step, including
 * `_useSession begin/end` on every `getSession()`. The worker calls that
 * several times a minute during a capture, so forwarding everything would
 * bury the signal and flood logcat.
 *
 * These are the messages that distinguish the six `_removeSession` paths
 * and the refresh outcome — the exact questions the last run could not
 * answer. Matching is on the SANITISED message, so a token can never
 * reach the filter either.
 */
const INTERESTING = [
  '_removeSession',
  '_saveSession',
  '_callRefreshToken',
  '_recoverAndRefresh',
  '_autoRefreshTokenTick',
  'session is not valid',
  'session from storage is not valid',
  'refresh failed',
  'removing the session',
  'expired',
];

function isInteresting(sanitised: string): boolean {
  return INTERESTING.some((needle) => sanitised.includes(needle));
}

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

let sink: LogFn = (event, fields) => {
  if (fields === undefined) console.log(event);
  else console.log(event, fields);
};

/** Test seam. Production never calls this. */
export function __setAuthDiagnosticsSink(fn: LogFn | null): void {
  sink =
    fn ??
    ((event, fields) => {
      if (fields === undefined) console.log(event);
      else console.log(event, fields);
    });
}

function emit(event: string, fields: Record<string, unknown>): void {
  try {
    sink(event, fields);
  } catch {
    // Diagnostics may never break the caller. auth-js invokes the logger
    // inside its own lock; a throw here would take the auth client down.
  }
}

/**
 * The function handed to `createClient({ auth: { debug } })`.
 *
 * Signature is auth-js's: `(message: string, ...args: any[]) => void`.
 * Every argument is redacted; the message is scrubbed. Cannot throw.
 */
export function authDebugLogger(message: string, ...args: unknown[]): void {
  try {
    const sanitised = scrubString(String(message ?? ''));
    // The message auth-js passes is a PREFIX; the interesting part is
    // usually the second argument, so both are checked.
    const detail = args.length > 0 ? scrubString(String(args[0] ?? '')) : '';
    if (!isInteresting(sanitised) && !isInteresting(detail)) return;
    emit(TAG_DEBUG, {
      at: Date.now(),
      msg: sanitised,
      args: args.map(redactForLog),
    });
  } catch {
    /* never break auth-js */
  }
}

// ---------------------------------------------------------------- errors

export type AuthErrorClass =
  | 'retryable_network'
  | 'timeout'
  | 'invalid_grant'
  | 'invalid_session'
  | 'other'
  | 'none';

/**
 * REPORTING ONLY. auth-js keeps its own verdict — `isAuthRetryableFetchError`,
 * which is `error.name === 'AuthRetryableFetchError'` and nothing else. This
 * label is never read by any decision in this app; it exists so a log line
 * says which failure mode was in play without printing the error body.
 */
export function classifyAuthError(err: unknown): AuthErrorClass {
  if (err === null || err === undefined) return 'none';
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';

  if (name === 'AuthRetryableFetchError') return 'retryable_network';
  if (name === 'AuthSessionMissingError') return 'invalid_session';
  if (code === 'invalid_grant' || message.includes('invalid_grant')) return 'invalid_grant';
  if (
    code === 'refresh_token_not_found' ||
    code === 'refresh_token_already_used' ||
    message.includes('refresh token')
  ) {
    return 'invalid_grant';
  }
  if (name === 'AbortError' || message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  return 'other';
}

// ------------------------------------------------------------ auth events

interface SessionLike {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  user?: { id?: unknown } | null;
}

/** Booleans and an 8-char prefix. Never a token, never a full id. */
export function describeSession(session: unknown): Record<string, unknown> {
  const s = (session ?? null) as SessionLike | null;
  const userId = s?.user?.id;
  return {
    session_present: s !== null,
    token_present: typeof s?.access_token === 'string' && s.access_token.length > 0,
    refresh_present: typeof s?.refresh_token === 'string' && s.refresh_token.length > 0,
    expires_at: typeof s?.expires_at === 'number' ? s.expires_at : null,
    // Same convention as `gc.identity.v1`: eight characters, diagnostic
    // only, never a decision input anywhere.
    user_prefix: typeof userId === 'string' ? userId.slice(0, 8) : null,
  };
}

/**
 * Records an `onAuthStateChange` firing.
 *
 * The previous handler was `(_event, session) => …`: the event NAME was
 * thrown away, so a `SIGNED_OUT` raised by `_removeSession()` left no
 * trace at all. Ordering matters as much as the name — `_removeSession`
 * deletes the key BEFORE notifying, so a storage line stamped earlier
 * than this one is the proof of that ordering.
 */
export function logAuthStateChange(event: string, session: unknown): void {
  emit(TAG_EVENT, { at: Date.now(), event, ...describeSession(session) });
}

// ---------------------------------------------------------------- storage

/** The three methods auth-js needs. Matches its `SupportedStorage`. */
export interface AuthStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

/** True for the `sb-<ref>-auth-token` family, and nothing else. */
export function isSupabaseSessionKey(key: string): boolean {
  return /^sb-.+-auth-token(-.+)?$/.test(key);
}

/**
 * The key name carries the Supabase project ref, so it is never logged
 * verbatim. The SUFFIX is kept because it is diagnostic and carries
 * nothing: `-user` and `-code-verifier` are separate keys that
 * `_removeSession` deletes alongside the session, and telling them apart
 * is part of reconstructing what happened.
 */
export function redactSessionKey(key: string): string {
  const m = /^sb-.+-auth-token(-.+)?$/.exec(key);
  if (m === null) return '<non-session-key>';
  return `sb-<redacted>-auth-token${m[1] ?? ''}`;
}

/**
 * Caller trail for a `removeItem`, with no absolute paths and no argument
 * values — enough to tell `__loadSession` from `_recoverAndRefresh` from
 * `_callRefreshToken`, which is the whole question D0 exists to answer.
 */
function callerTrail(limit = 6): string[] {
  const raw = new Error().stack ?? '';
  return raw
    .split('\n')
    .slice(2)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): string => {
      const fn = /^at\s+([^\s(]+)/.exec(line);
      return fn?.[1] ?? '<anonymous>';
    })
    .filter((fn) => fn !== '<anonymous>')
    .slice(0, limit);
}

/** Shape of the stored session, derived WITHOUT logging its bytes. */
function describeStoredValue(raw: string | null): Record<string, unknown> {
  if (raw === null) return { stored_present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { stored_present: true, stored_parseable: false, stored_len: raw.length };
  }
  return {
    stored_present: true,
    stored_parseable: true,
    stored_len: raw.length,
    ...describeSession(parsed),
  };
}

/**
 * Value- and effect-transparent wrapper around the real storage.
 *
 * NOT a bare passthrough, and the difference is deliberate — say it
 * plainly rather than let the word "passthrough" hide it:
 *
 *   getItem     delegates, unchanged.
 *   setItem     delegates, unchanged; logs metadata for session keys.
 *   removeItem  for a SESSION KEY, performs one extra `getItem` first,
 *               then delegates. For every other key, delegates directly
 *               with no added call and no log.
 *
 * That pre-read is the one operation this module adds. It exists because
 * "was the refresh token still there immediately before the deletion?"
 * is the question that decides whether the credential was ever
 * recoverable, and it cannot be answered after the fact.
 *
 * What stays exactly as before: the values returned, the order of writes
 * and deletions, and the rejections. The pre-read is best-effort — if it
 * throws, the deletion proceeds regardless — so it cannot change what the
 * store ends up holding.
 *
 * NO SHADOW COPY. D0 observes; it does not preserve anything.
 */
export function instrumentAuthStorage(delegate: AuthStorage): AuthStorage {
  return {
    getItem(key: string) {
      return delegate.getItem(key);
    },

    setItem(key: string, value: string) {
      if (isSupabaseSessionKey(key)) {
        emit(TAG_STORAGE, {
          at: Date.now(),
          op: 'setItem',
          key: redactSessionKey(key),
          ...describeStoredValue(value),
        });
      }
      return delegate.setItem(key, value);
    },

    async removeItem(key: string) {
      if (!isSupabaseSessionKey(key)) {
        return await delegate.removeItem(key);
      }
      let before: Record<string, unknown>;
      try {
        before = describeStoredValue(await delegate.getItem(key));
      } catch (err) {
        before = { stored_present: null, probe_error: classifyAuthError(err) };
      }
      emit(TAG_STORAGE, {
        at: Date.now(),
        op: 'removeItem',
        key: redactSessionKey(key),
        ...before,
        caller: callerTrail(),
      });
      return await delegate.removeItem(key);
    },
  };
}
