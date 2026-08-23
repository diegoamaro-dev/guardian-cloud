/**
 * GC-AUTH-SESSION-RECOVERY-001 — CAUSALITY BENCH. Laboratory only.
 *
 * On 2026-08-22 a device holding 87 chunks of unuploaded evidence lost its
 * Supabase session. `getSession()` began answering `{session: null, error:
 * null}` — a clean resolve, not a network failure — and the identity
 * marker correctly refused to mint a replacement. The evidence became
 * unuploadable, and with an anonymous identity there is no
 * re-authentication flow to offer.
 *
 * `GC-AUTH-RETRY-CLASSIFICATION-001` names a candidate: `auth-js` deletes
 * the persisted session for any auth error that is not exactly
 * `AuthRetryableFetchError`, and that class is constructed for only two
 * things — a non-fetch-response failure, or a status in
 * `NETWORK_ERROR_CODES = [502,503,504,520,521,522,523,524,530]`. A 429 or
 * a 500 therefore becomes `AuthApiError` and destroys the credential,
 * while a 502 is retried. Neither 429 nor 500 says the credential is bad.
 *
 * This bench answers ONE question: is that status SUFFICIENT, by that
 * route, in this exact dependency version?
 *
 * ── WHAT A PASS DOES NOT SAY ─────────────────────────────────────────
 * It does NOT say the 2026-08-22 incident was a 429 or a 500. That
 * response was never captured — D0.1 did not exist yet — and no later
 * experiment can recover it. A PASS promotes the candidate from
 * "mechanically possible" to "demonstrated sufficient". Nothing more.
 *
 * A FAIL refutes THIS MECHANISM — `_callRefreshToken` deleting on a
 * transient status — and not every conceivable relation between those
 * statuses and the incident.
 *
 * ── WHY THIS IS A BENCH AND NOT A DEVICE RUN ─────────────────────────
 * The chain is destructive by construction: the 429 deletes the session,
 * after which `gc.identity.v1` exists with no session, so minting is
 * forbidden and no second session can be obtained. Four scenarios on
 * hardware would cost four `pm clear`. The chain itself is pure
 * JavaScript inside auth-js plus our own instrumentation — it does not
 * touch Android, the filesystem, or the app lifecycle — so it is provable
 * here, exactly, with no device state at risk.
 *
 * ── WHAT THIS FILE DOES NOT TOUCH ────────────────────────────────────
 * No production module is modified. No recording, chunking, GC_QUEUE,
 * durable cleanup, foreground service, recovery or export code is
 * imported. `@/auth/supabase` is deliberately NOT imported, so the app's
 * own client is never constructed here.
 *
 * The property this file actually establishes is narrower than "one
 * client in the process", and stating the narrow one is the point:
 * EXACTLY ONE BENCH-CREATED `GoTrueClient` EXISTS PER SCENARIO. It holds
 * structurally, not by convention —
 *
 *   `createClient` appears ONCE in this file, inside `makeClient`;
 *   `makeClient()` is invoked ONCE, from `beforeEach`;
 *   no scenario constructs a second instance.
 *
 * That is what makes an observed deletion attributable: there is only one
 * client that could have produced it. Nothing is claimed about other test
 * files or other vitest workers in the same process — this bench does not
 * observe them, and does not need to.
 *
 * Metro never packages `tests/`, so none of this can reach an artifact —
 * the injector is not a flag that could be left on, it is code that does
 * not exist in any bundle.
 *
 * Deliberately NOT gated on `__DEV__`: the validation artifact with the
 * embedded bundle (`5fa8d10`) runs with `__DEV__ === false`, so such a
 * gate would disable the injector precisely where it would be needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  authDebugLogger,
  classifySessionKey,
  describeSession,
  instrumentAuthStorage,
  logAuthStateChange,
  __resetAuthDiagnosticsStateForTests,
  __setAuthDiagnosticsSink,
} from '@/auth/authDiagnostics';

// `sb-${hostname.split('.')[0]}-auth-token` is how supabase-js derives the
// default storage key, and `new URL('auth/v1', baseUrl)` the auth origin.
// Both are read from the dependency, not guessed.
const SUPABASE_URL = 'https://gcbench.supabase.co';
const SUPABASE_ANON_KEY = 'bench-anon-key-not-a-secret-000000000000';
const STORAGE_KEY = 'sb-gcbench-auth-token';

/**
 * `_request` appends a query string only when `options.query` is set, and
 * the refresh call does not set it. The URL handed to the fetcher is
 * therefore this literal — see `GoTrueClient._refreshAccessToken`.
 */
const REFRESH_URL_FRAGMENT = '/auth/v1/token?grant_type=refresh_token';

// ───────────────────────────────────────────────────────── storage

const memory = new Map<string, string>();

const memoryStorage = {
  getItem: async (key: string): Promise<string | null> => memory.get(key) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    memory.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    memory.delete(key);
  },
};

/**
 * A structurally complete session, already expired.
 *
 * `expires_at` in the past forces `__loadSession` down its refresh branch:
 * it computes `expires_at * 1000 - Date.now() < EXPIRY_MARGIN_MS` (90 000)
 * and calls `_callRefreshToken` when true. That is the ONE route this
 * bench is about.
 *
 * The three fields are also exactly what `_isValidSession` requires. A
 * session missing any of them would be deleted by `__loadSession` at a
 * DIFFERENT call site (`GoTrueClient.js:2322`) before the refresh ever
 * ran — which would look like a pass and prove nothing. The precondition
 * below exists to make that substitution impossible.
 */
function seedValidSession(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  memory.set(
    STORAGE_KEY,
    JSON.stringify({
      access_token: 'aaaa.bbbb.cccc',
      refresh_token: 'rrrrrrrrrrrrrrrrrrrr',
      expires_at: nowSec - 60,
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: '11111111-2222-3333-4444-555555555555', aud: 'authenticated' },
    }),
  );
}

/** A successful refresh, as GoTrue would answer it. */
function freshSessionBody(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    access_token: 'dddd.eeee.ffff',
    refresh_token: 'ssssssssssssssssssss',
    expires_at: nowSec + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: '11111111-2222-3333-4444-555555555555', aud: 'authenticated' },
  });
}

// ───────────────────────────────────────────────────────── injector

interface Armed {
  status: number;
  body: string;
  /** How many matching requests the synthetic response is served for. */
  budget: number;
  served: number;
}

interface Intercept {
  method: string;
  /** Route class, never the URL: the URL carries the project ref. */
  route: 'refresh_token' | 'other_auth';
  synthetic: boolean;
  status: number | null;
}

let armed: Armed | null = null;
let intercepts: Intercept[] = [];

/**
 * Stands in for the network. Every non-injected request resolves here, so
 * the bench never reaches Supabase and never punishes the real endpoint.
 * Returning a successful refresh is what makes the 502 control meaningful:
 * it proves auth-js RETRIED past the synthetic failures rather than
 * deleting, which a single 502 could not distinguish.
 */
const baselineFetch = vi.fn(
  async (): Promise<Response> =>
    new Response(freshSessionBody(), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
);

function isRefreshCall(url: string): boolean {
  return url.includes(REFRESH_URL_FRAGMENT);
}

/**
 * THE injector.
 *
 * Returns a synthetic `Response`; it NEVER throws. That distinction is
 * load-bearing, not stylistic: `_handleRequest` wraps a throwing fetcher
 * in `AuthRetryableFetchError(msg, 0)`, which is the retryable class. A
 * bench that threw would push every scenario down the branch it is
 * supposed to be testing against, and 429 would "prove" it does not
 * delete.
 *
 * The response must also satisfy `looksLikeFetchResponse` (status / ok /
 * json) and carry parseable JSON, because `handleError` does
 * `await error.json()` before classifying.
 */
async function injectorFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string' ? input : String(input);
  const method = (init?.method ?? 'GET').toUpperCase();

  if (!isRefreshCall(url)) {
    // Not our route. No record, no interference.
    return baselineFetch();
  }

  if (armed === null || armed.served >= armed.budget) {
    // Budget spent, or never armed: the latch disarms itself here and the
    // real path takes over for the rest of the process.
    armed = null;
    intercepts.push({ method, route: 'refresh_token', synthetic: false, status: 200 });
    return baselineFetch();
  }

  armed.served += 1;
  const { status, body } = armed;
  intercepts.push({ method, route: 'refresh_token', synthetic: true, status });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Error bodies GoTrue would return.
 *
 * `error_code` matters: `handleError` diverts to `AuthSessionMissingError`
 * when it reads `session_not_found`, which is a DIFFERENT class and a
 * different question. None of these bodies carry it, so each scenario
 * lands on the class it is meant to measure.
 */
const BODY_429 = JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'rate limited' });
const BODY_500 = JSON.stringify({ code: 500, error_code: 'unexpected_failure', msg: 'internal error' });
const BODY_502 = JSON.stringify({ code: 502, error_code: 'bad_gateway', msg: 'bad gateway' });
const BODY_401 = JSON.stringify({ code: 401, error_code: 'invalid_grant', msg: 'invalid refresh token' });

// ───────────────────────────────────────────────────────── capture

interface Emitted {
  event: string;
  fields: Record<string, unknown>;
}

let emitted: Emitted[] = [];
let client: SupabaseClient | null = null;

function storageOps(kind: string): Emitted[] {
  return emitted.filter(
    (e) => e.event === 'GC_AUTH_STORAGE' && e.fields.kind === kind,
  );
}
function primaryRemovals(): Emitted[] {
  return storageOps('primary_session').filter((e) => e.fields.op === 'removeItem');
}
function signedOutEvents(): Emitted[] {
  return emitted.filter(
    (e) => e.event === 'GC_AUTH_EVENT' && e.fields.event === 'SIGNED_OUT',
  );
}
/** Error classes and statuses D0.1 observed, from the debug channel. */
function observedErrors(): { error_class: unknown; statuses: number[] }[] {
  return emitted
    .filter((e) => e.event === 'GC_AUTH_DEBUG' && e.fields.error_class !== 'none')
    .map((e) => {
      const args = Array.isArray(e.fields.args) ? e.fields.args : [];
      const statuses = args
        .map((a) => (a as { error_status?: unknown })?.error_status)
        .filter((s): s is number => typeof s === 'number');
      return { error_class: e.fields.error_class, statuses };
    });
}

/** The record required for every scenario. Printed AND asserted on. */
function report(label: string): Record<string, unknown> {
  const raw = memory.get(STORAGE_KEY) ?? null;
  const removals = primaryRemovals();
  const rec = {
    scenario: label,
    intercepted_total: intercepts.length,
    intercepted_synthetic: intercepts.filter((i) => i.synthetic).length,
    intercepted_passthrough: intercepts.filter((i) => !i.synthetic).length,
    routes: intercepts.map((i) => `${i.method} ${i.route}${i.synthetic ? ` [${i.status}]` : ' [real]'}`),
    d01_errors: observedErrors(),
    primary_session_ops: storageOps('primary_session').map((e) => e.fields.op),
    // `refresh_present` as recorded by the PRE-READ that D0.1 performs
    // immediately before delegating the delete. This is the field that
    // says the credential was intact at the moment it was destroyed.
    refresh_present_before_removal: removals.map((e) => e.fields.refresh_present),
    session_loss_flags: removals.map((e) => e.fields.session_loss),
    signed_out_events: signedOutEvents().length,
    final_key_present: raw !== null,
    final_refresh_present:
      raw === null ? null : describeSession(JSON.parse(raw)).refresh_present,
  };
  // `tests/setup.ts:27` silences `console.log` for every suite. The record
  // is the deliverable of this bench, so it is written to stdout directly.
  process.stdout.write(`\nBENCH_REPORT ${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

// ───────────────────────────────────────────────────── preconditions

/**
 * Proves the stored session is structurally valid BEFORE the refresh is
 * provoked.
 *
 * Without this the bench has a silent alternative explanation: a session
 * missing `access_token`, `refresh_token` or `expires_at` fails
 * `_isValidSession` and is deleted by `__loadSession` at
 * `GoTrueClient.js:2322` — a removal that looks identical in the log but
 * never went near `_callRefreshToken`. Asserting validity first is what
 * makes the observed deletion attributable to the refresh route.
 */
function assertSeededSessionIsStructurallyValid(): void {
  const raw = memory.get(STORAGE_KEY) ?? null;
  expect(raw, 'primary session key must be present before the refresh').not.toBeNull();

  let parsed: Record<string, unknown> | null = null;
  expect(() => {
    parsed = JSON.parse(raw as string) as Record<string, unknown>;
  }, 'stored session must be parseable JSON').not.toThrow();
  const s = parsed as unknown as Record<string, unknown>;

  expect(typeof s.access_token, 'access_token must be present').toBe('string');
  expect((s.access_token as string).length).toBeGreaterThan(0);
  expect(typeof s.refresh_token, 'refresh_token must be present').toBe('string');
  expect((s.refresh_token as string).length).toBeGreaterThan(0);
  expect(typeof s.expires_at, 'expires_at must be present').toBe('number');

  // The predicate auth-js itself applies, replicated exactly. If this is
  // true, `__loadSession` cannot take its invalid-session removal branch.
  expect(
    'access_token' in s && 'refresh_token' in s && 'expires_at' in s,
    '_isValidSession must accept this session',
  ).toBe(true);

  // And D0.1 must be able to SEE the credential, or `refresh_present`
  // would be a vacuous field in every report below.
  expect(describeSession(s).refresh_present, 'D0.1 must observe refresh_present:true').toBe(true);

  // Nothing may have been deleted before the refresh is even provoked.
  expect(primaryRemovals(), 'no primary_session removal may precede the refresh').toHaveLength(0);
}

// ───────────────────────────────────────────────────────── lifecycle

function installSink(): void {
  __setAuthDiagnosticsSink((event, fields) => {
    emitted.push({ event, fields: fields ?? {} });
  });
}

/**
 * Builds the client with the SAME wiring production uses.
 *
 * The `onAuthStateChange` subscription is not decoration. `_removeSession`
 * deletes the key and THEN calls `_notifyAllSubscribers('SIGNED_OUT')`, so
 * with no subscriber the event exists but nothing records it — which is
 * exactly the blindness D0 was built to remove (`store.ts:126-131`, where
 * the handler used to discard the event name). Subscribing here is what
 * makes the last link of the chain observable at all.
 */
function makeClient(): SupabaseClient {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Same shape as `src/auth/supabase.ts`, with the storage in memory
      // and the ticker off so no refresh fires except the one we provoke.
      storage: instrumentAuthStorage(memoryStorage),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      debug: authDebugLogger,
    },
    global: { fetch: injectorFetch as unknown as typeof fetch },
  });
  c.auth.onAuthStateChange((event, session) => {
    logAuthStateChange(event, session);
  });
  return c;
}

beforeEach(() => {
  memory.clear();
  emitted = [];
  intercepts = [];
  armed = null;
  baselineFetch.mockClear();
  __resetAuthDiagnosticsStateForTests();
  installSink();
  client = makeClient();
  seedValidSession();
});

afterEach(() => {
  // The latch is disarmed unconditionally, whatever the test did.
  armed = null;
  __setAuthDiagnosticsSink(null);
  __resetAuthDiagnosticsStateForTests();
  client = null;
});

// ═════════════════════════════════════════════ the injector has teeth

describe('GC_AUTH_CAUSALITY_INJECTOR_TEETH', () => {
  it('serves the synthetic response exactly `budget` times and then restores the real path', async () => {
    armed = { status: 429, body: BODY_429, budget: 1, served: 0 };

    // Three direct calls to the same route.
    await injectorFetch(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'POST' });
    await injectorFetch(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'POST' });
    await injectorFetch(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'POST' });

    expect(intercepts.filter((i) => i.synthetic)).toHaveLength(1);
    expect(intercepts.filter((i) => !i.synthetic)).toHaveLength(2);
    expect(armed).toBeNull();
    expect(baselineFetch).toHaveBeenCalledTimes(2);
  });

  it('an unarmed injector delegates — so an inert injector cannot pass a scenario', async () => {
    armed = null;
    const res = await injectorFetch(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(intercepts.every((i) => !i.synthetic)).toBe(true);
    expect(baselineFetch).toHaveBeenCalledTimes(1);
  });

  it('leaves every non-refresh route untouched and unrecorded', async () => {
    armed = { status: 429, body: BODY_429, budget: 1, served: 0 };
    await injectorFetch(`${SUPABASE_URL}/auth/v1/user`, { method: 'GET' });
    await injectorFetch(`${SUPABASE_URL}/auth/v1/logout`, { method: 'POST' });

    expect(intercepts).toHaveLength(0);
    expect(armed?.served).toBe(0);
    expect(baselineFetch).toHaveBeenCalledTimes(2);
  });

  it('records the route class, never the URL', () => {
    // The URL carries the project ref. Nothing in the record may contain it.
    const serialised = JSON.stringify(intercepts);
    expect(serialised).not.toContain('gcbench');
    expect(serialised).not.toContain('supabase.co');
  });
});

// ═══════════════════════════════════════════════════ the four scenarios

describe('GC_AUTH_CAUSALITY_429_MUST_DELETE', () => {
  it('a 429 on the refresh destroys a structurally intact credential', async () => {
    assertSeededSessionIsStructurallyValid();
    armed = { status: 429, body: BODY_429, budget: 1, served: 0 };

    const { data, error } = await client!.auth.getSession();
    const rec = report('429');

    // The refresh ran, once, and was not retried: 429 is AuthApiError.
    expect(rec.intercepted_synthetic).toBe(1);
    expect(baselineFetch).not.toHaveBeenCalled();

    // D0.1 saw the class and the status.
    expect(
      observedErrors().some((e) => e.statuses.includes(429)),
    ).toBe(true);

    // THE CHAIN.
    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.session_loss_flags).toEqual([true]);
    // The credential was intact at the moment it was destroyed.
    expect(rec.refresh_present_before_removal).toEqual([true]);
    expect(rec.signed_out_events).toBeGreaterThanOrEqual(1);

    // Terminal state: the key is gone, and so is the way back.
    expect(rec.final_key_present).toBe(false);
    expect(data.session).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe('GC_AUTH_CAUSALITY_500_MUST_DELETE', () => {
  it('a 500 on the refresh destroys a structurally intact credential', async () => {
    assertSeededSessionIsStructurallyValid();
    armed = { status: 500, body: BODY_500, budget: 1, served: 0 };

    const { data } = await client!.auth.getSession();
    const rec = report('500');

    expect(rec.intercepted_synthetic).toBe(1);
    expect(baselineFetch).not.toHaveBeenCalled();
    expect(observedErrors().some((e) => e.statuses.includes(500))).toBe(true);

    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.session_loss_flags).toEqual([true]);
    expect(rec.refresh_present_before_removal).toEqual([true]);
    expect(rec.signed_out_events).toBeGreaterThanOrEqual(1);
    expect(rec.final_key_present).toBe(false);
    expect(data.session).toBeNull();
  });
});

describe('GC_AUTH_CAUSALITY_502_MUST_NOT_DELETE', () => {
  it('a 502 is retried and the credential survives — the control that makes the bench meaningful', async () => {
    assertSeededSessionIsStructurallyValid();
    // Served for three attempts, then the baseline answers 200. Proving
    // auth-js RETRIED is stronger than proving one 502 did not delete.
    armed = { status: 502, body: BODY_502, budget: 3, served: 0 };

    const { data, error } = await client!.auth.getSession();
    const rec = report('502');

    // It kept trying past every synthetic failure.
    expect(rec.intercepted_synthetic).toBe(3);
    expect(baselineFetch).toHaveBeenCalled();

    // D0.1 records NO error for this path, and that absence is the
    // discriminating fact — not an oversight. `_callRefreshToken` only
    // logs from its catch, and with 502 the retry SUCCEEDED, so the catch
    // was never reached. Compare the other three scenarios, where D0.1
    // reports an `AuthApiError` carrying the status.
    expect(observedErrors()).toHaveLength(0);
    // The session was REPLACED with a refreshed one, never deleted.
    expect(rec.primary_session_ops).toEqual(['setItem']);

    // NOTHING was destroyed, at any point.
    expect(primaryRemovals()).toHaveLength(0);
    expect(rec.signed_out_events).toBe(0);
    expect(rec.final_key_present).toBe(true);
    expect(rec.final_refresh_present).toBe(true);

    // And it recovered.
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
  }, 20_000);
});

describe('GC_AUTH_CAUSALITY_401_MUST_DELETE', () => {
  it('a 401 destroys the credential — the correct behaviour, which must not regress', async () => {
    assertSeededSessionIsStructurallyValid();
    armed = { status: 401, body: BODY_401, budget: 1, served: 0 };

    const { data } = await client!.auth.getSession();
    const rec = report('401');

    expect(rec.intercepted_synthetic).toBe(1);
    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.session_loss_flags).toEqual([true]);
    expect(rec.refresh_present_before_removal).toEqual([true]);
    expect(rec.signed_out_events).toBeGreaterThanOrEqual(1);
    expect(rec.final_key_present).toBe(false);
    expect(data.session).toBeNull();
  });
});

// ═══════════════════════════════════════ the discrimination, stated once

describe('GC_AUTH_CAUSALITY_THE_DISCRIMINATION', () => {
  /**
   * A test lived here that ran 500 and then 502 inside ONE case, building a
   * second client to reset the world between halves. It was removed: two
   * bench-created `GoTrueClient` instances inside one scenario breaks the
   * property this bench rests on — exactly one bench-created client per
   * scenario — and without it an observed deletion could belong to either.
   *
   * Nothing was lost. `GC_AUTH_CAUSALITY_500_MUST_DELETE` and
   * `GC_AUTH_CAUSALITY_502_MUST_NOT_DELETE` already establish the
   * discrimination, each in its own scenario with its own fresh client and
   * its own structural precondition. Asserting it a third time by
   * comparison added no evidence and cost the invariant.
   */
  it('classifySessionKey names the one deletion that matters', () => {
    expect(classifySessionKey(STORAGE_KEY)).toBe('primary_session');
    expect(classifySessionKey(`${STORAGE_KEY}-code-verifier`)).toBe('code_verifier_suffix');
    expect(classifySessionKey(`${STORAGE_KEY}-user`)).toBe('user_suffix');
  });
});
