/**
 * GC-AUTH-SESSION-RECOVERY-001 · D0 — observability, and nothing else.
 *
 * Two properties are load-bearing and both are adversarial:
 *
 *   1. NO SECRET IS EVER EMITTED. Not a token, not a JWT, not five
 *      characters of a refresh token. auth-js 2.103.3 hands whole session
 *      objects to its logger and names `_callRefreshToken` after the first
 *      five characters of the live refresh token, so the redactor is what
 *      stands between that and logcat.
 *
 *   2. NOTHING CHANGES. The wrapper must be indistinguishable from the
 *      delegate in values, ordering and rejections. It is not a bare
 *      passthrough — deleting a session key costs one extra `getItem`
 *      first — so the tests pin that added read precisely, in both what
 *      it must do and what it must never affect.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  authDebugLogger,
  classifyAuthError,
  describeSession,
  instrumentAuthStorage,
  isSupabaseSessionKey,
  logAuthStateChange,
  redactSessionKey,
  redactForLog,
  scrubString,
  __setAuthDiagnosticsSink,
  type AuthStorage,
} from '@/auth/authDiagnostics';

/** Every line the module emitted during a test. */
interface Emitted {
  event: string;
  fields: Record<string, unknown>;
}
let emitted: Emitted[] = [];

/** Indexed access under `noUncheckedIndexedAccess`, asserted once here. */
function at(i: number): Emitted {
  const row = emitted[i];
  if (row === undefined) throw new Error(`no log line at index ${i}`);
  return row;
}

/** One serialized blob of everything logged — what a log scraper sees. */
function allLoggedText(): string {
  return emitted.map((e) => `${e.event} ${JSON.stringify(e.fields)}`).join('\n');
}

const SESSION_KEY = 'sb-nahksdkcvhveoctpjrea-auth-token';

/** A realistic JWT: three base64url segments. Values are fake. */
const ACCESS_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
  '.eyJzdWIiOiJiMzhhNTRjYi0wMDAwLTQwMDAtOD' +
  '.dBjftJeZ4CVPmB92K27uhbUJU1p1r1wEE4vLLe';
/** Supabase refresh tokens are shorter opaque strings. */
const REFRESH_TOKEN = 'v1n4mfk2xq7zpldc3rtb';
const USER_ID = 'b38a54cb-1111-4222-8333-444455556666';

function realSession() {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_at: 1787423400,
    token_type: 'bearer',
    user: { id: USER_ID, is_anonymous: true },
  };
}

/** In-memory storage that records the exact call order it received. */
function makeDelegate(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const calls: string[] = [];
  const delegate: AuthStorage & { __map: Map<string, string>; __calls: string[] } = {
    __map: map,
    __calls: calls,
    async getItem(k: string) {
      calls.push(`getItem:${k}`);
      return map.get(k) ?? null;
    },
    async setItem(k: string, v: string) {
      calls.push(`setItem:${k}`);
      map.set(k, v);
    },
    async removeItem(k: string) {
      calls.push(`removeItem:${k}`);
      map.delete(k);
    },
  };
  return delegate;
}

beforeEach(() => {
  emitted = [];
  __setAuthDiagnosticsSink((event, fields) => {
    emitted.push({ event, fields: fields ?? {} });
  });
});

describe('GC_AUTH_D0_NO_SECRET_EVER_REACHES_A_LOG', () => {
  it('a JWT anywhere in a message is replaced by its length', () => {
    const out = scrubString(`token is ${ACCESS_TOKEN} ok`);
    expect(out).not.toContain(ACCESS_TOKEN);
    expect(out).toContain('<jwt:len=');
  });

  it('THE auth-js trap: `_callRefreshToken(v1n4m...)` leaks 5 chars — we do not', () => {
    // auth-js builds `#_callRefreshToken(${refreshToken.substring(0, 5)}...)`
    // and puts it in EVERY debug line of that function.
    const authJsStyle = `#_callRefreshToken(${REFRESH_TOKEN.substring(0, 5)}...)`;
    authDebugLogger(authJsStyle, 'begin');

    const text = allLoggedText();
    expect(text).not.toContain(REFRESH_TOKEN.substring(0, 5));
    expect(text).toContain('_callRefreshToken');
  });

  it('a whole session object passed as an argument yields KEYS ONLY', () => {
    // This is what `#_saveSession()` and `#getSession() session from
    // storage` hand to the logger.
    authDebugLogger('#_saveSession()', realSession());

    const text = allLoggedText();
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).not.toContain(USER_ID);
    expect(text).toContain('access_token'); // the key name, not the value
  });

  it('SWEEP: no logged line contains a JWT-shaped or long-opaque string', () => {
    // Drive every emitter with hostile input, then scan everything at once.
    authDebugLogger('#_removeSession()', realSession());
    authDebugLogger(`#_callRefreshToken(${REFRESH_TOKEN.substring(0, 5)}...)`, 'begin');
    authDebugLogger('#_recoverAndRefresh()', 'session from storage', realSession());
    logAuthStateChange('SIGNED_OUT', null);
    logAuthStateChange('TOKEN_REFRESHED', realSession());

    const text = allLoggedText();
    expect(text).not.toMatch(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/);
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, USER_ID, 'nahksdkcvhveoctpjrea']) {
      expect(text).not.toContain(secret);
    }
    // ...and the sweep has teeth: the secrets really were fed in.
    expect(emitted.length).toBeGreaterThan(3);
  });

  it('the user id survives only as an 8-character prefix', () => {
    logAuthStateChange('SIGNED_IN', realSession());
    const f = at(0).fields;
    expect(f.user_prefix).toBe('b38a54cb');
    expect(allLoggedText()).not.toContain(USER_ID);
  });

  it('an Error contributes class, code and status — never a message body', () => {
    const err = Object.assign(new Error(`bad token ${REFRESH_TOKEN}`), {
      name: 'AuthApiError',
      code: 'invalid_grant',
      status: 400,
    });
    expect(redactForLog(err)).toEqual({
      error_class: 'AuthApiError',
      error_code: 'invalid_grant',
      error_status: 400,
    });
  });
});

describe('GC_AUTH_D0_STORAGE_IS_VALUE_AND_EFFECT_TRANSPARENT', () => {
  it('get/set/remove return and mutate exactly like the delegate', async () => {
    const delegate = makeDelegate({ 'some.key': 'some-value' });
    const wrapped = instrumentAuthStorage(delegate);

    expect(await wrapped.getItem('some.key')).toBe('some-value');
    expect(await wrapped.getItem('missing')).toBeNull();
    await wrapped.setItem('some.key', 'new-value');
    expect(delegate.__map.get('some.key')).toBe('new-value');
    await wrapped.removeItem('some.key');
    expect(delegate.__map.has('some.key')).toBe(false);
  });

  it('a session value round-trips byte-identically', async () => {
    const delegate = makeDelegate();
    const wrapped = instrumentAuthStorage(delegate);
    const raw = JSON.stringify(realSession());

    await wrapped.setItem(SESSION_KEY, raw);

    expect(delegate.__map.get(SESSION_KEY)).toBe(raw);
    expect(await wrapped.getItem(SESSION_KEY)).toBe(raw);
    // ...and the bytes did not leak on the way through.
    expect(allLoggedText()).not.toContain(ACCESS_TOKEN);
  });

  it('non-session keys are not instrumented at all', async () => {
    const delegate = makeDelegate({ 'test.pending_retry': '[]' });
    const wrapped = instrumentAuthStorage(delegate);

    await wrapped.getItem('test.pending_retry');
    await wrapped.setItem('test.pending_retry', '[1]');
    await wrapped.removeItem('test.pending_retry');

    expect(emitted).toHaveLength(0);
    expect(delegate.__calls).toEqual([
      'getItem:test.pending_retry',
      'setItem:test.pending_retry',
      'removeItem:test.pending_retry',
    ]);
  });

  it('a rejecting delegate rejects identically through the wrapper', async () => {
    const boom = new Error('EIO');
    const wrapped = instrumentAuthStorage({
      getItem: async () => {
        throw boom;
      },
      setItem: async () => {
        throw boom;
      },
      removeItem: async () => {
        throw boom;
      },
    });

    await expect(wrapped.getItem('x')).rejects.toBe(boom);
    await expect(wrapped.setItem('x', 'y')).rejects.toBe(boom);
    await expect(wrapped.removeItem('x')).rejects.toBe(boom);
  });

  it('a failing pre-read does NOT stop the deletion', async () => {
    // Diagnostics may never change what the store does.
    let removed = false;
    const wrapped = instrumentAuthStorage({
      getItem: async () => {
        throw new Error('probe failed');
      },
      setItem: async () => {},
      removeItem: async () => {
        removed = true;
      },
    });

    await wrapped.removeItem(SESSION_KEY);

    expect(removed).toBe(true);
    expect(at(0).fields.stored_present).toBeNull();
  });

  it('a throwing SINK cannot break storage', async () => {
    __setAuthDiagnosticsSink(() => {
      throw new Error('log sink exploded');
    });
    const delegate = makeDelegate({ [SESSION_KEY]: JSON.stringify(realSession()) });
    const wrapped = instrumentAuthStorage(delegate);

    await expect(wrapped.removeItem(SESSION_KEY)).resolves.toBeUndefined();
    expect(delegate.__map.has(SESSION_KEY)).toBe(false);
  });
});

describe('GC_AUTH_D0_THE_QUESTIONS_THE_LAST_RUN_COULD_NOT_ANSWER', () => {
  it('removeItem records whether the refresh token was still there', async () => {
    // Question 7: was the credential present immediately before deletion?
    const delegate = makeDelegate({ [SESSION_KEY]: JSON.stringify(realSession()) });
    const wrapped = instrumentAuthStorage(delegate);

    await wrapped.removeItem(SESSION_KEY);

    const f = at(0).fields;
    expect(at(0).event).toBe('GC_AUTH_STORAGE');
    expect(f.op).toBe('removeItem');
    expect(f.stored_present).toBe(true);
    expect(f.refresh_present).toBe(true);
    expect(f.token_present).toBe(true);
    expect(f.expires_at).toBe(1787423400);
    expect(f.user_prefix).toBe('b38a54cb');
  });

  it('the pre-read happens BEFORE the delegate deletes', async () => {
    // Question 8: ordering. If the probe ran after the delete it would
    // report `stored_present: false` and prove nothing.
    const order: string[] = [];
    const wrapped = instrumentAuthStorage({
      getItem: async () => {
        order.push('probe');
        return JSON.stringify(realSession());
      },
      setItem: async () => {},
      removeItem: async () => {
        order.push('delete');
      },
    });

    await wrapped.removeItem(SESSION_KEY);

    expect(order).toEqual(['probe', 'delete']);
  });

  it('removeItem carries a caller trail that distinguishes the auth-js paths', async () => {
    // Question 4/5: WHICH of the six `_removeSession` sites fired.
    const delegate = makeDelegate({ [SESSION_KEY]: '{}' });
    const wrapped = instrumentAuthStorage(delegate);

    async function _recoverAndRefresh() {
      await wrapped.removeItem(SESSION_KEY);
    }
    await _recoverAndRefresh();

    const caller = at(0).fields.caller as string[];
    expect(Array.isArray(caller)).toBe(true);
    expect(caller.join(' ')).toContain('_recoverAndRefresh');
  });

  it('a corrupt stored session is reported as unparseable, not as absent', async () => {
    // `_isValidSession` failing is one of the three SILENT removal paths.
    const delegate = makeDelegate({ [SESSION_KEY]: '{{{ truncated' });
    const wrapped = instrumentAuthStorage(delegate);

    await wrapped.removeItem(SESSION_KEY);

    const f = at(0).fields;
    expect(f.stored_present).toBe(true);
    expect(f.stored_parseable).toBe(false);
    expect(f.refresh_present).toBeUndefined();
  });

  it('a session missing its refresh token is distinguishable from a whole one', async () => {
    const partial = { ...realSession(), refresh_token: undefined };
    const delegate = makeDelegate({ [SESSION_KEY]: JSON.stringify(partial) });
    const wrapped = instrumentAuthStorage(delegate);

    await wrapped.removeItem(SESSION_KEY);

    const f = at(0).fields;
    expect(f.token_present).toBe(true);
    expect(f.refresh_present).toBe(false);
  });

  it('the event NAME survives, which is what the old handler threw away', () => {
    // Questions 1-3.
    for (const ev of ['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED', 'SIGNED_OUT']) {
      logAuthStateChange(ev, ev === 'SIGNED_OUT' ? null : realSession());
    }
    expect(emitted.map((e) => e.fields.event)).toEqual([
      'INITIAL_SESSION',
      'SIGNED_IN',
      'TOKEN_REFRESHED',
      'SIGNED_OUT',
    ]);
    // SIGNED_OUT reports an absent session rather than omitting the field.
    expect(at(3).fields.session_present).toBe(false);
    expect(at(3).fields.refresh_present).toBe(false);
  });

  it('classifies the failure modes that decide whether the credential died', () => {
    // Question 6. REPORTING ONLY — auth-js keeps its own verdict.
    expect(classifyAuthError({ name: 'AuthRetryableFetchError' })).toBe('retryable_network');
    expect(classifyAuthError({ name: 'AuthApiError', code: 'invalid_grant' })).toBe('invalid_grant');
    expect(classifyAuthError({ name: 'AuthApiError', code: 'refresh_token_already_used' })).toBe(
      'invalid_grant',
    );
    expect(classifyAuthError({ name: 'AuthSessionMissingError' })).toBe('invalid_session');
    expect(classifyAuthError({ name: 'AbortError' })).toBe('timeout');
    expect(classifyAuthError({ name: 'TypeError' })).toBe('other');
    expect(classifyAuthError(null)).toBe('none');
  });

  it('the session-key matcher accepts the real key and rejects neighbours', () => {
    expect(isSupabaseSessionKey(SESSION_KEY)).toBe(true);
    expect(isSupabaseSessionKey(`${SESSION_KEY}-code-verifier`)).toBe(true);
    expect(isSupabaseSessionKey(`${SESSION_KEY}-user`)).toBe(true);
    expect(isSupabaseSessionKey('test.pending_retry')).toBe(false);
    expect(isSupabaseSessionKey('gc.identity.v1')).toBe(false);
  });

  it('the logged key name never carries the project ref, but keeps the suffix', async () => {
    // The ref identifies the backend project. The `-user` /
    // `-code-verifier` suffix carries nothing and IS diagnostic:
    // `_removeSession` deletes all three, and telling them apart is part
    // of reconstructing what happened.
    expect(redactSessionKey(SESSION_KEY)).toBe('sb-<redacted>-auth-token');
    expect(redactSessionKey(`${SESSION_KEY}-user`)).toBe('sb-<redacted>-auth-token-user');
    expect(redactSessionKey('gc.identity.v1')).toBe('<non-session-key>');

    const delegate = makeDelegate({ [SESSION_KEY]: JSON.stringify(realSession()) });
    const wrapped = instrumentAuthStorage(delegate);
    await wrapped.setItem(SESSION_KEY, JSON.stringify(realSession()));
    await wrapped.removeItem(SESSION_KEY);

    const text = allLoggedText();
    expect(text).not.toContain('nahksdkcvhveoctpjrea');
    expect(text).toContain('sb-<redacted>-auth-token');
  });
});

describe('GC_AUTH_D0_CHANGES_NOTHING', () => {
  it('the debug logger drops auth-js noise and keeps the removal signal', () => {
    authDebugLogger('#_useSession', 'begin');
    authDebugLogger('#_useSession', 'end');
    authDebugLogger('#getSession()', 'session from storage', realSession());
    expect(emitted).toHaveLength(0);

    authDebugLogger('#_removeSession()');
    authDebugLogger('#_recoverAndRefresh()', 'session from storage is not valid');
    expect(emitted).toHaveLength(2);
  });

  it('the logger never throws, whatever it is handed', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => authDebugLogger('#_removeSession()', cyclic)).not.toThrow();
    expect(() =>
      authDebugLogger(undefined as unknown as string, null, 1, Symbol('s')),
    ).not.toThrow();
  });

  it('describeSession never invents a session, and never carries one', () => {
    expect(describeSession(null)).toMatchObject({
      session_present: false,
      token_present: false,
      refresh_present: false,
      user_prefix: null,
    });
    const d = describeSession(realSession());
    expect(Object.values(d).join(' ')).not.toContain(ACCESS_TOKEN);
  });

  it('D0 exports no way to write, restore or repair a session', async () => {
    const mod = await import('@/auth/authDiagnostics');
    const forbidden = ['setSession', 'restoreSession', 'shadow', 'recover', 'signIn', 'mint'];
    for (const name of Object.keys(mod)) {
      for (const bad of forbidden) {
        expect(name.toLowerCase()).not.toContain(bad.toLowerCase());
      }
    }
  });
});

describe('GC_AUTH_D0_TEETH', () => {
  it('the removeItem test really goes through the adapter, not the delegate', async () => {
    // Guards every "passthrough" assertion above: if the wrapper were
    // returning the delegate unchanged, no diagnostic line would exist
    // and the questions D0 exists to answer would stay unanswered.
    const delegate = makeDelegate({ [SESSION_KEY]: JSON.stringify(realSession()) });
    const wrapped = instrumentAuthStorage(delegate);

    expect(wrapped).not.toBe(delegate);
    await wrapped.removeItem(SESSION_KEY);

    // The adapter read before deleting — the delegate saw BOTH calls, in
    // that order. A passthrough that skipped instrumentation would show
    // only the removeItem.
    expect(delegate.__calls).toEqual([`getItem:${SESSION_KEY}`, `removeItem:${SESSION_KEY}`]);
    expect(emitted).toHaveLength(1);
    expect(at(0).event).toBe('GC_AUTH_STORAGE');
  });

  it('the redaction sweep would FAIL if the redactor were a no-op', () => {
    // Proves the sweep is not vacuous: the raw text it is scanning for
    // really does match the pattern when unredacted.
    const raw = `#_saveSession() ${JSON.stringify(realSession())}`;
    expect(raw).toMatch(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/);
    expect(scrubString(raw)).not.toMatch(
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    );
  });
});
