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
 *   every scenario obtains its client through `provokeRefresh`, which
 *   calls `makeClient()` exactly once;
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
import { instrumentRefreshFetch } from '@/auth/refreshRateLimit';

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
function writeSession(expiresAtSec: number): void {
  memory.set(
    STORAGE_KEY,
    JSON.stringify({
      access_token: 'aaaa.bbbb.cccc',
      refresh_token: 'rrrrrrrrrrrrrrrrrrrr',
      expires_at: expiresAtSec,
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: '11111111-2222-3333-4444-555555555555', aud: 'authenticated' },
    }),
  );
}

/** Access token ALREADY EXPIRED. The refresh token is the only credential left. */
function seedValidSession(): void {
  writeSession(Math.floor(Date.now() / 1000) - 60);
}

/**
 * Access token STILL VALID, but inside `EXPIRY_MARGIN_MS` (90 s), which is
 * what makes auth-js refresh proactively.
 *
 * 2.112.3 discriminates these two seedings and 2.103.3 did not — see
 * `_callRefreshToken`, which now reads the stored `expires_at` before
 * deciding whether a failed refresh should destroy anything. 30 s in the
 * future is comfortably inside the margin and comfortably not expired.
 */
function seedSessionExpiringSoon(): void {
  writeSession(Math.floor(Date.now() / 1000) + 30);
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
const BODY_525 = JSON.stringify({ code: 525, error_code: 'ssl_handshake_failed', msg: 'ssl handshake failed' });

// ───────────────────────────────────────────────────────── capture

interface Emitted {
  event: string;
  fields: Record<string, unknown>;
}

let emitted: Emitted[] = [];

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
function makeClient(withWrapper = true): SupabaseClient {
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
    global: {
      // The REAL classifier sits between auth-js and the injector, exactly
      // as in `src/auth/supabase.ts`. `withWrapper: false` is the teeth
      // check: without it the 429 scenario must go back to deleting.
      fetch: (withWrapper
        ? instrumentRefreshFetch(injectorFetch as unknown as typeof fetch)
        : injectorFetch) as unknown as typeof fetch,
    },
  });
  c.auth.onAuthStateChange((event, session) => {
    logAuthStateChange(event, session);
  });
  return c;
}

/** Lets auth-js finish whatever it started. No fake timers, no polling. */
async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs ONE refresh against an armed injector, deterministically.
 *
 * Ordering here is load-bearing, and it is a behaviour change of 2.112.3
 * that forced it: subscribing via `onAuthStateChange` now kicks off an
 * async `initialize()` → `_recoverAndRefresh`, which sees the expired
 * seeded session and fires a `POST /token` OF ITS OWN — with no explicit
 * `getSession()` call at all. Verified by probe: one unrequested refresh
 * per client construction.
 *
 * Under 2.103.3 the bench armed the injector after the client existed,
 * and got away with it. Here that is a race: whether the background
 * refresh lands before or after `armed` is set decides whether the
 * scenario measures a synthetic response or a live 200 that silently
 * refreshes the seeded session into a valid one. A bench that can be
 * decided by timing measures nothing.
 *
 * So the injector is armed FIRST and the client is built after. Whichever
 * refresh fires — background or explicit — meets the armed injector, and
 * the budget governs how many synthetic responses it gets. One
 * bench-created client per scenario still holds: this is the only place
 * that constructs one.
 */
async function provokeRefresh(
  status: number,
  body: string,
  budget = 1,
  withWrapper = true,
): Promise<{ session: unknown; error: unknown }> {
  armed = { status, body, budget, served: 0 };
  const c = makeClient(withWrapper);
  await settle();
  const { data, error } = await c.auth.getSession();
  return { session: data.session, error };
}

/**
 * Same as `provokeRefresh`, on a CONTROLLED clock.
 *
 * A refresh that auth-js treats as retryable costs ~25.4 s of real
 * backoff — 200, 400, 800 … 12 800 ms across eight attempts. Three such
 * scenarios took the bench from 3 s to 82 s, which is a real cost paid on
 * every suite run for no extra information.
 *
 * Fake timers also mock `Date.now()`, which matters: auth-js bounds its
 * retry loop with `Date.now() + nextBackOff - startedAt < 30 000`, so the
 * virtual clock has to advance for the LOOP TO TERMINATE, not merely for
 * the sleeps to resolve. Advancing past 30 s reproduces the real cut-off
 * exactly, and the attempt count it produces is the assertion.
 *
 * `advanceTimersByTimeAsync` flushes microtasks between timers, so the
 * promise chain progresses as it would on a real clock.
 */
async function provokeRefreshOnFakeClock(
  status: number,
  body: string,
  budget: number,
  withWrapper = true,
): Promise<{ session: unknown; error: unknown }> {
  vi.useFakeTimers();
  try {
    armed = { status, body, budget, served: 0 };
    const c = makeClient(withWrapper);
    const pending = (async () => {
      await settle();
      return c.auth.getSession();
    })();
    // Past the 30 s bound, so `retryable` gives up inside this window.
    await vi.advanceTimersByTimeAsync(40_000);
    const { data, error } = await pending;
    return { session: data.session, error };
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  memory.clear();
  emitted = [];
  intercepts = [];
  armed = null;
  baselineFetch.mockClear();
  __resetAuthDiagnosticsStateForTests();
  installSink();
  seedValidSession();
});

afterEach(() => {
  // The latch is disarmed unconditionally, whatever the test did.
  armed = null;
  __setAuthDiagnosticsSink(null);
  __resetAuthDiagnosticsStateForTests();
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

// ══════════════════════════════════════════════════════ the scenarios
//
// Every expectation below was WRITTEN AFTER OBSERVING 2.112.3, not
// transcribed from the changelog. Two of them contradict what a reading
// of the upstream diff would have predicted, and those two are the most
// valuable lines in this file.

describe('GC_AUTH_CAUSALITY_429', () => {
  it('STILL destroys the credential when the access token has expired — the residual gap', async () => {
    assertSeededSessionIsStructurallyValid();
    // withWrapper:false — this measures the PRE-D2-C baseline. With the
    // classifier in place the same input is preserved instead; that is
    // GC_D2C_TRANSIENT_RATE_LIMIT_PRESERVES. Keeping the measurement makes
    // the delta explicit and doubles as a second teeth check.
    const { session, error } = await provokeRefresh(429, BODY_429, 1, false);
    const rec = report('429/expired/no-wrapper');

    // One attempt, no retry: 429 is NOT in NETWORK_ERROR_CODES, in 2.112.3
    // either. It is still `AuthApiError`.
    expect(rec.intercepted_synthetic).toBe(1);
    expect(rec.intercepted_passthrough).toBe(0);
    expect(observedErrors().some((e) => e.statuses.includes(429))).toBe(true);

    // THE CHAIN, unchanged from 2.103.3.
    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.session_loss_flags).toEqual([true]);
    expect(rec.refresh_present_before_removal).toEqual([true]);
    expect(rec.signed_out_events).toBe(1);
    expect(rec.final_key_present).toBe(false);
    expect(session).toBeNull();
  }, 30_000);

  it('PRESERVES the credential when the access token is still valid — proactive-preserve', async () => {
    // Same 429, same body, same budget. The ONLY difference is that the
    // access token has not expired yet, and 2.112.3 reads exactly that
    // before deciding. 2.103.3 destroyed both.
    memory.clear();
    seedSessionExpiringSoon();
    assertSeededSessionIsStructurallyValid();

    const { session } = await provokeRefresh(429, BODY_429, 1, false);
    const rec = report('429/still-valid/no-wrapper');

    expect(rec.intercepted_synthetic).toBe(1);
    expect(observedErrors().some((e) => e.statuses.includes(429))).toBe(true);

    // Nothing destroyed, and nothing written either: the stored session is
    // left exactly as it was.
    expect(primaryRemovals()).toHaveLength(0);
    expect(rec.primary_session_ops).toEqual([]);
    expect(rec.signed_out_events).toBe(0);
    expect(rec.final_key_present).toBe(true);
    expect(rec.final_refresh_present).toBe(true);
    expect(session).not.toBeNull();
  }, 30_000);
});

describe('GC_AUTH_CAUSALITY_500_NO_LONGER_DELETES', () => {
  it('a 500 is now retried and the credential survives — this expectation INVERTED on the upgrade', async () => {
    // Under 2.103.3 this scenario asserted deletion, and the bench proved
    // it. `NETWORK_ERROR_CODES` now contains 500, so the same input takes
    // the retry path instead. The inversion is the measurement.
    assertSeededSessionIsStructurallyValid();

    const { session, error } = await provokeRefresh(500, BODY_500, 1);
    const rec = report('500/expired');

    // It retried past the synthetic failure and reached the baseline.
    expect(rec.intercepted_synthetic).toBe(1);
    expect(rec.intercepted_passthrough).toBeGreaterThanOrEqual(1);
    expect(baselineFetch).toHaveBeenCalled();

    expect(primaryRemovals()).toHaveLength(0);
    expect(rec.signed_out_events).toBe(0);
    // Replaced with a refreshed session, never deleted.
    expect(rec.primary_session_ops).toContain('setItem');
    expect(rec.final_key_present).toBe(true);
    expect(rec.final_refresh_present).toBe(true);
    expect(session).not.toBeNull();
    expect(error).toBeNull();
  }, 30_000);
});

describe('GC_AUTH_CAUSALITY_525_CLOUDFLARE_RANGE', () => {
  it('a 525 is retried and the credential survives — the widened infrastructure range', async () => {
    // 525-529 were `AuthApiError` in 2.103.3 and destroyed the session.
    // Asserting one of them keeps the widened range honest: if a future
    // upgrade narrows it back, this fails.
    assertSeededSessionIsStructurallyValid();

    const { session } = await provokeRefresh(525, BODY_525, 3);
    const rec = report('525/expired');

    expect(rec.intercepted_synthetic).toBe(3);
    expect(rec.intercepted_passthrough).toBeGreaterThanOrEqual(1);
    expect(primaryRemovals()).toHaveLength(0);
    expect(rec.signed_out_events).toBe(0);
    expect(rec.final_key_present).toBe(true);
    expect(session).not.toBeNull();
  }, 30_000);
});

describe('GC_AUTH_CAUSALITY_502_MUST_NOT_DELETE', () => {
  it('a 502 is retried and the credential survives — the control, unchanged across the upgrade', async () => {
    assertSeededSessionIsStructurallyValid();

    const { session, error } = await provokeRefresh(502, BODY_502, 3);
    const rec = report('502/expired');

    expect(rec.intercepted_synthetic).toBe(3);
    expect(baselineFetch).toHaveBeenCalled();
    // D0.1 records no error: the retry succeeded, so `_callRefreshToken`
    // never reached its catch. Same absence as under 2.103.3.
    expect(observedErrors()).toHaveLength(0);
    expect(primaryRemovals()).toHaveLength(0);
    expect(rec.signed_out_events).toBe(0);
    expect(rec.primary_session_ops).toContain('setItem');
    expect(rec.final_key_present).toBe(true);
    expect(rec.final_refresh_present).toBe(true);
    expect(session).not.toBeNull();
    expect(error).toBeNull();
  }, 30_000);
});

describe('GC_AUTH_CAUSALITY_401', () => {
  it('destroys the credential when the access token has expired — the behaviour that must not regress', async () => {
    assertSeededSessionIsStructurallyValid();

    const { session } = await provokeRefresh(401, BODY_401, 1);
    const rec = report('401/expired');

    expect(rec.intercepted_synthetic).toBe(1);
    expect(rec.intercepted_passthrough).toBe(0);
    expect(observedErrors().some((e) => e.statuses.includes(401))).toBe(true);
    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.session_loss_flags).toEqual([true]);
    expect(rec.refresh_present_before_removal).toEqual([true]);
    expect(rec.signed_out_events).toBe(1);
    expect(rec.final_key_present).toBe(false);
    expect(session).toBeNull();
  }, 30_000);

  it('PRESERVES a rejected credential while the access token is still valid — observed, and worth knowing', async () => {
    // Not what a reading of the upstream diff predicts. Proactive-preserve
    // does not ask whether the rejection was genuine: a 401 — a refresh
    // token the server has rejected outright — leaves the session in place
    // as long as the access token has not expired.
    //
    // Defensible on upstream's own terms: the access token still works, so
    // the session remains usable until its real expiry, at which point the
    // next refresh deletes it. But it means "401 deletes" is now a
    // statement about EXPIRED sessions only, and any policy built on
    // "a 401 cleans up immediately" is wrong here.
    memory.clear();
    seedSessionExpiringSoon();
    assertSeededSessionIsStructurallyValid();

    const { session } = await provokeRefresh(401, BODY_401, 1);
    const rec = report('401/still-valid');

    expect(rec.intercepted_synthetic).toBe(1);
    expect(observedErrors().some((e) => e.statuses.includes(401))).toBe(true);
    expect(primaryRemovals()).toHaveLength(0);
    expect(rec.signed_out_events).toBe(0);
    expect(rec.final_key_present).toBe(true);
    expect(session).not.toBeNull();
  }, 30_000);
});

describe('GC_AUTH_CAUSALITY_REFRESH_FAILURE_COOLDOWN', () => {
  it('a failed refresh is cached: later calls with the same token make NO network request', async () => {
    // `REFRESH_FAILURE_COOLDOWN_MS = 2 * AUTO_REFRESH_TICK_DURATION_MS`
    // = 60 000. Proving it observably rather than by reading the constant:
    // the storm is what turns one transient failure into a spiral, and the
    // clock-skew finding measured 4 refreshes/min instead of 1/hour.
    //
    // Driven with a 401 rather than a 429 on purpose. This test measures
    // AUTH-JS's cooldown; a 429 now goes through the D2-C classifier and
    // would measure that instead. The access token is still valid, so
    // proactive-preserve keeps the session and the failure gets cached —
    // which is exactly the state the cooldown governs.
    memory.clear();
    seedSessionExpiringSoon();
    assertSeededSessionIsStructurallyValid();

    armed = { status: 401, body: BODY_401, budget: 1, served: 0 };
    const c = makeClient();
    await settle();
    await c.auth.getSession();
    const afterFirst = intercepts.length;

    // Two more reads, same refresh token, well inside the cooldown.
    await c.auth.getSession();
    await c.auth.getSession();
    const afterThird = intercepts.length;

    report('cooldown');
    expect(afterFirst).toBe(1);
    // THE assertion: not one extra request left the client.
    expect(afterThird).toBe(afterFirst);
    expect(baselineFetch).not.toHaveBeenCalled();
    // And the session was never destroyed along the way.
    expect(primaryRemovals()).toHaveLength(0);
  }, 30_000);
});

describe('GC_AUTH_CAUSALITY_KEY_CLASSIFICATION', () => {
  it('classifySessionKey names the one deletion that matters', () => {
    expect(classifySessionKey(STORAGE_KEY)).toBe('primary_session');
    expect(classifySessionKey(`${STORAGE_KEY}-code-verifier`)).toBe('code_verifier_suffix');
    expect(classifySessionKey(`${STORAGE_KEY}-user`)).toBe('user_suffix');
  });
});

// ══════════════════════════════════════════ D2-C · the classifier itself
//
// Everything above measures what auth-js does. Everything below measures
// what `instrumentRefreshFetch` changes about it — and, just as important,
// what it refuses to change.

/** Bodies that differ ONLY in `error_code`. The status is 429 in all of them. */
const B429 = (code: string | null): string =>
  JSON.stringify(
    code === null
      ? { code: 429, msg: 'rate limited' }
      : { code: 429, error_code: code, msg: 'rate limited' },
  );

/** Captures the classifier's own log line. `tests/setup.ts` stubs console.log. */
function rateLimitLogs(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .filter((c) => c[0] === 'GC_AUTH_RATE_LIMIT')
    .map((c) => c[1] as Record<string, unknown>);
}

describe('GC_D2C_TRANSIENT_RATE_LIMIT_PRESERVES', () => {
  it('429 over_request_rate_limit + expired access token → the credential survives', async () => {
    assertSeededSessionIsStructurallyValid();
    const logSpy = vi.spyOn(console, 'log');

    const { session } = await provokeRefreshOnFakeClock(429, B429('over_request_rate_limit'), 99);
    const rec = report('D2C/429-rate-limit/expired');

    // THE point of D2-C: this was `removeItem = 1` before the classifier.
    expect(primaryRemovals()).toHaveLength(0);
    expect(rec.signed_out_events).toBe(0);
    expect(rec.final_key_present).toBe(true);
    // The refresh token — the only credential left once the access token
    // expired — is still there to retry with.
    expect(rec.final_refresh_present).toBe(true);

    // The 429 is not hidden. It is logged, with its code.
    const logs = rateLimitLogs(logSpy);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatchObject({
      observed_status: 429,
      error_code: 'over_request_rate_limit',
      exit_reason: 'classified_retryable',
    });
    // getSession() reports no usable session; the identity is NOT gone.
    expect(session).toBeNull();
  }, 60_000);

  it('429 over_request_rate_limit + still-valid access token → also survives', async () => {
    memory.clear();
    seedSessionExpiringSoon();
    assertSeededSessionIsStructurallyValid();

    await provokeRefreshOnFakeClock(429, B429('over_request_rate_limit'), 99);
    const rec = report('D2C/429-rate-limit/still-valid');

    expect(primaryRemovals()).toHaveLength(0);
    expect(rec.final_key_present).toBe(true);
    expect(rec.final_refresh_present).toBe(true);
  }, 60_000);
});

describe('GC_D2C_INVALID_CREDENTIAL_PASSES_THROUGH', () => {
  // Case H. Each of these codes is GoTrue saying the credential is gone.
  // The classifier must not touch them: preserving here would manufacture
  // a session that can never work again.
  const invalidCodes = [
    'refresh_token_not_found',
    'refresh_token_already_used',
    'session_expired',
  ] as const;

  for (const code of invalidCodes) {
    it(`429 ${code} → pass-through, deletion allowed`, async () => {
      assertSeededSessionIsStructurallyValid();
      const logSpy = vi.spyOn(console, 'log');

      await provokeRefresh(429, B429(code), 99);
      const rec = report(`D2C/429-${code}`);

      expect(primaryRemovals()).toHaveLength(1);
      expect(rec.session_loss_flags).toEqual([true]);
      expect(rec.signed_out_events).toBe(1);
      expect(rec.final_key_present).toBe(false);
      // The classifier stayed out of it entirely.
      expect(rateLimitLogs(logSpy)).toHaveLength(0);
    }, 60_000);
  }

  it('429 session_not_found → pass-through; auth-js takes its own branch', async () => {
    // `handleError` diverts this one to `AuthSessionMissingError` rather
    // than `AuthApiError`, which is a different class and a different
    // deletion site. Asserted separately so the distinction stays visible.
    assertSeededSessionIsStructurallyValid();
    const logSpy = vi.spyOn(console, 'log');

    await provokeRefresh(429, B429('session_not_found'), 99);
    const rec = report('D2C/429-session_not_found');

    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.final_key_present).toBe(false);
    expect(rateLimitLogs(logSpy)).toHaveLength(0);
  }, 60_000);
});

describe('GC_D2C_UNKNOWN_RESPONSE_IS_FAIL_CLOSED', () => {
  // Case G. "HTTP 429" on its own never preserves anything. Only the
  // server's explicit code does.

  it('429 with NO error_code → pass-through', async () => {
    assertSeededSessionIsStructurallyValid();
    const logSpy = vi.spyOn(console, 'log');

    await provokeRefresh(429, B429(null), 99);
    const rec = report('D2C/429-no-code');

    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.final_key_present).toBe(false);
    expect(rateLimitLogs(logSpy)).toHaveLength(0);
  }, 60_000);

  it('429 with an unrecognised code → pass-through', async () => {
    assertSeededSessionIsStructurallyValid();
    const logSpy = vi.spyOn(console, 'log');

    await provokeRefresh(429, B429('some_future_code_we_do_not_know'), 99);
    const rec = report('D2C/429-unknown-code');

    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.final_key_present).toBe(false);
    expect(rateLimitLogs(logSpy)).toHaveLength(0);
  }, 60_000);

  it('429 with an unparseable body → pass-through, and OUR failure never preserves', async () => {
    // The classifier throws inside its own `json()`. That is a failure of
    // ours, and a failure of ours must not become a decision to keep a
    // credential. It hands back the original response.
    assertSeededSessionIsStructurallyValid();
    const logSpy = vi.spyOn(console, 'log');

    await provokeRefresh(429, '<html>429 Too Many Requests</html>', 99);
    const rec = report('D2C/429-unparseable');

    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.final_key_present).toBe(false);
    expect(rateLimitLogs(logSpy)).toHaveLength(0);
  }, 60_000);

  it('a numeric `code` field never matches — only a string code counts', async () => {
    // `handleError` requires `typeof code === 'string'`; a body echoing the
    // HTTP status as a number must not be read as an error code.
    assertSeededSessionIsStructurallyValid();
    const logSpy = vi.spyOn(console, 'log');

    await provokeRefresh(
      429,
      JSON.stringify({ code: 429, msg: 'rate limited' }),
      99,
    );
    report('D2C/429-numeric-code');

    expect(primaryRemovals()).toHaveLength(1);
    expect(rateLimitLogs(logSpy)).toHaveLength(0);
  }, 60_000);
});

describe('GC_D2C_NON_REFRESH_TRAFFIC_UNTOUCHED', () => {
  it('a 429 on a DIFFERENT endpoint is never classified', async () => {
    // The classifier is scoped to POST /token?grant_type=refresh_token.
    // Driving the wrapper directly is the only way to reach another route
    // without inventing a second client.
    const logSpy = vi.spyOn(console, 'log');
    const wrapped = instrumentRefreshFetch(
      (async () =>
        new Response(B429('over_request_rate_limit'), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    const res = await wrapped(`${SUPABASE_URL}/auth/v1/user`, { method: 'GET' });
    expect(res.status).toBe(429);
    expect(rateLimitLogs(logSpy)).toHaveLength(0);
  });

  it('a GET to the token path is never classified', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const wrapped = instrumentRefreshFetch(
      (async () =>
        new Response(B429('over_request_rate_limit'), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    const res = await wrapped(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'GET' });
    expect(res.status).toBe(429);
    expect(rateLimitLogs(logSpy)).toHaveLength(0);
  });

  it('a Request object POSTing to the refresh route IS classified', async () => {
    // `String(request)` is `"[object Request]"`, which contains neither
    // `/token` nor the grant type. Reading the URL off `String(input)`
    // would silently skip every `Request`-shaped call — and a rate-limited
    // refresh issued that way would still destroy the session. auth-js
    // passes a string today; this test does not rely on that.
    const wrapped = instrumentRefreshFetch(
      (async () =>
        new Response(B429('over_request_rate_limit'), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    const req = new Request(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'POST' });
    await expect(wrapped(req)).rejects.toThrow(/rate limited/);
  });

  it('a Request object with GET to the same route is NOT classified', async () => {
    // Same body, same URL, same wrapper. Only the method differs, and the
    // method alone must decide.
    const wrapped = instrumentRefreshFetch(
      (async () =>
        new Response(B429('over_request_rate_limit'), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    const req = new Request(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'GET' });
    const res = await wrapped(req);
    expect(res.status).toBe(429);
    expect(res.bodyUsed).toBe(false);
  });

  it('classification survives a runtime with NO `Request` global', async () => {
    // ── WHAT THIS TEST DOES NOT PROVE ─────────────────────────────────
    // It does NOT prove the `typeof Request !== 'undefined'` guard on the
    // METHOD read is load-bearing. Removing that guard kills no test, and
    // that was verified by mutation rather than assumed. The reason is
    // structural:
    //
    //   `init?.method ?? (input instanceof Request ? … : 'GET')`
    //
    //   - when `init.method` is present the `??` short-circuits and the
    //     `instanceof` is never evaluated;
    //   - when it is absent the guarded form yields 'GET', which is not a
    //     refresh POST, so the call passes through — and the UNguarded
    //     form throws into the catch, which also passes through. Same
    //     outcome;
    //   - a `Request` instance cannot exist in a runtime with no `Request`
    //     global, so "missing global + Request argument" is unreachable.
    //
    // The guard is kept for consistency with `readRequestUrl` and because
    // it costs nothing, not because a live path needs it. Said plainly
    // rather than dressed up as coverage.
    //
    // What this test DOES prove: the classifier still classifies for a
    // shape that never needed the global.
    vi.stubGlobal('Request', undefined);
    try {
      const wrapped = instrumentRefreshFetch(
        (async () =>
          new Response(B429('over_request_rate_limit'), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          })) as unknown as typeof fetch,
      );

      await expect(
        wrapped(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'POST' }),
      ).rejects.toThrow(/rate limited/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pass-through also survives a runtime with NO `Request` global', async () => {
    // The other half of the same property, and the one that matters more:
    // a missing global must never turn a credential-invalid response into
    // a preserved session. Same caveat as above — this documents the
    // behaviour, it is not a teeth check for the guard.
    vi.stubGlobal('Request', undefined);
    try {
      const wrapped = instrumentRefreshFetch(
        (async () =>
          new Response(B429('refresh_token_not_found'), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          })) as unknown as typeof fetch,
      );

      const res = await wrapped(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, {
        method: 'POST',
      });
      expect(res.status).toBe(429);
      expect(res.bodyUsed).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ── endpoint identification is exact, not substring ──────────────────
  //
  // `includes('/token')` also accepts `/auth/v1/token-extra`;
  // `includes('grant_type=refresh_token')` also accepts that text sitting
  // inside an unrelated query VALUE. Either would let D2-C intervene on
  // traffic it was never authorised to touch — and intervening means
  // deciding a credential survives.
  const rateLimited = () =>
    instrumentRefreshFetch(
      (async () =>
        new Response(B429('over_request_rate_limit'), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    );

  it('POST /auth/v1/token?grant_type=refresh_token → classified', async () => {
    await expect(
      rateLimited()(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
      }),
    ).rejects.toThrow(/rate limited/);
  });

  it('POST /auth/v1/token?foo=grant_type%3Drefresh_token → NOT classified', async () => {
    // The literal `grant_type=refresh_token` appears in the URL, but as the
    // VALUE of `foo`. `searchParams.get('grant_type')` is null.
    const res = await rateLimited()(
      `${SUPABASE_URL}/auth/v1/token?foo=grant_type%3Drefresh_token`,
      { method: 'POST' },
    );
    expect(res.status).toBe(429);
    expect(res.bodyUsed).toBe(false);
  });

  it('POST /auth/v1/token?grant_type=refresh_token_extra → NOT classified', async () => {
    // The raw URL DOES contain the literal `grant_type=refresh_token`, as a
    // prefix of a longer value. This is the case that gives the exact
    // comparison teeth: `includes()` accepts it, `=== 'refresh_token'`
    // rejects it. Added after a mutation showed the `%3D` case above does
    // not catch it — the encoded `=` never matches the literal either way.
    const res = await rateLimited()(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token_extra`,
      { method: 'POST' },
    );
    expect(res.status).toBe(429);
    expect(res.bodyUsed).toBe(false);
  });

  it('POST /auth/v1/token?x=grant_type=refresh_token → NOT classified', async () => {
    // The literal sits inside another parameter's VALUE, unencoded.
    // `URLSearchParams` splits on the first `=`, so `x` holds
    // `grant_type=refresh_token` and `get('grant_type')` is null.
    const res = await rateLimited()(
      `${SUPABASE_URL}/auth/v1/token?x=grant_type=refresh_token`,
      { method: 'POST' },
    );
    expect(res.status).toBe(429);
  });

  it('POST /auth/v1/token-extra?grant_type=refresh_token → NOT classified', async () => {
    const res = await rateLimited()(
      `${SUPABASE_URL}/auth/v1/token-extra?grant_type=refresh_token`,
      { method: 'POST' },
    );
    expect(res.status).toBe(429);
  });

  it('POST /auth/v1/not-token?grant_type=refresh_token → NOT classified', async () => {
    const res = await rateLimited()(
      `${SUPABASE_URL}/auth/v1/not-token?grant_type=refresh_token`,
      { method: 'POST' },
    );
    expect(res.status).toBe(429);
  });

  it('POST /auth/v1/token?grant_type=other → NOT classified', async () => {
    const res = await rateLimited()(`${SUPABASE_URL}/auth/v1/token?grant_type=other`, {
      method: 'POST',
    });
    expect(res.status).toBe(429);
  });

  it('an unparseable URL → pass-through, fail-closed', async () => {
    // `new URL()` throws on a relative or malformed input. The classifier
    // must not fall back to a looser match; it must decline to classify.
    const res = await rateLimited()('not-a-url/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
    });
    expect(res.status).toBe(429);
    expect(res.bodyUsed).toBe(false);
  });

  it('a URL object POSTing to the refresh route IS classified', async () => {
    // The third shape `fetch` accepts. `String(url)` is the full href, so
    // this one already worked — asserted so a future refactor of
    // `readRequestUrl` cannot regress it unnoticed.
    const wrapped = instrumentRefreshFetch(
      (async () =>
        new Response(B429('over_request_rate_limit'), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    const url = new URL(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`);
    await expect(wrapped(url, { method: 'POST' })).rejects.toThrow(/rate limited/);
  });

  it('the pass-through body is intact — clone() never consumed it', async () => {
    // If the classifier read `res` instead of `res.clone()`, auth-js would
    // receive a spent stream and `handleError` would fail to parse it.
    const wrapped = instrumentRefreshFetch(
      (async () =>
        new Response(B429('refresh_token_not_found'), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    const res = await wrapped(`${SUPABASE_URL}${REFRESH_URL_FRAGMENT}`, { method: 'POST' });
    expect(res.bodyUsed).toBe(false);
    await expect(res.json()).resolves.toMatchObject({
      error_code: 'refresh_token_not_found',
    });
  });
});

describe('GC_D2C_BOUNDED_REQUESTS', () => {
  it('a persistent 429 costs exactly 8 requests and 7 retries, then nothing during cooldown', async () => {
    // Case E. The arithmetic, from auth-js's own constants:
    //   sleep before attempt n>0 = 200 * 2**(n-1)
    //   retry while  elapsed + 200 * 2**attempt  <  AUTO_REFRESH_TICK_DURATION_MS (30 000)
    //   cumulative: 200,600,1400,3000,6200,12600,25400 → attempt 7 is the last
    // giving 8 attempts and 25 400 ms of backoff.
    //
    // The classifier contributes ZERO to this: it holds no counter and no
    // timer. If a budget or a sleep were ever added here, this count would
    // move and this test would fail.
    memory.clear();
    seedValidSession();
    assertSeededSessionIsStructurallyValid();

    vi.useFakeTimers();
    let c: SupabaseClient;
    let data: { session: unknown };
    try {
      armed = { status: 429, body: B429('over_request_rate_limit'), budget: 99, served: 0 };
      c = makeClient();
      const pending = (async () => {
        await settle();
        return c.auth.getSession();
      })();
      await vi.advanceTimersByTimeAsync(40_000);
      ({ data } = await pending);
    } finally {
      vi.useRealTimers();
    }
    const rec = report('D2C/bounded');

    expect(rec.intercepted_synthetic).toBe(8);
    expect(rec.intercepted_passthrough).toBe(0);
    // 8 attempts = 1 initial + 7 retries.
    expect((rec.intercepted_synthetic as number) - 1).toBe(7);
    expect(primaryRemovals()).toHaveLength(0);
    expect(data.session).toBeNull();

    // Cooldown: `lastRefreshFailure` is cached for 60 s, keyed by refresh
    // token, so further reads make NO network call at all.
    const before = intercepts.length;
    await c.auth.getSession();
    await c.auth.getSession();
    expect(intercepts.length).toBe(before);
  }, 120_000);
});

describe('GC_D2C_TEETH', () => {
  it('without the wrapper, the same 429 goes back to destroying the credential', async () => {
    // The whole file passes trivially if `instrumentRefreshFetch` were a
    // passthrough. This is the test that would notice.
    assertSeededSessionIsStructurallyValid();

    await provokeRefresh(429, B429('over_request_rate_limit'), 99, /* withWrapper */ false);
    const rec = report('D2C/teeth-no-wrapper');

    expect(primaryRemovals()).toHaveLength(1);
    expect(rec.session_loss_flags).toEqual([true]);
    expect(rec.refresh_present_before_removal).toEqual([true]);
    expect(rec.final_key_present).toBe(false);
  }, 60_000);
});

describe('GC_D2C_RECOVERY_AFTER_COOLDOWN', () => {
  /** The stored session, parsed. Fails loudly rather than returning null. */
  function storedSession(): Record<string, unknown> {
    const raw = memory.get(STORAGE_KEY);
    expect(raw, 'the primary session key must still exist').toBeDefined();
    return JSON.parse(raw as string) as Record<string, unknown>;
  }

  it('survives a rate-limit episode and then recovers with THE SAME identity', async () => {
    // This is the claim D2-C exists to support, end to end: a device that
    // meets a persistent 429 with an expired access token keeps its
    // credential, waits, and comes back as the same user — the user that
    // owns every session already uploaded. Preserving the key would be
    // worth little if the identity behind it did not survive with it.
    //
    // Entirely on a controlled clock. The cooldown is 60 s and the backoff
    // 25.4 s; on a real clock this test would cost 85 s and prove exactly
    // the same thing.
    vi.useFakeTimers();
    try {
      memory.clear();
      seedValidSession();
      const seeded = storedSession();
      const seededUserId = (seeded.user as { id: string }).id;
      const seededRefreshToken = seeded.refresh_token as string;
      assertSeededSessionIsStructurallyValid();

      // ── 2 · a persistent 429, until auth-js gives up ─────────────────
      armed = { status: 429, body: B429('over_request_rate_limit'), budget: 99, served: 0 };
      const c = makeClient();
      const episode = (async () => {
        await settle();
        return c.auth.getSession();
      })();
      await vi.advanceTimersByTimeAsync(40_000);
      await episode;

      // ── 3 · the episode is bounded and destroyed nothing ─────────────
      report('D2C/recovery/after-episode');
      expect(intercepts.length).toBe(8);
      expect(primaryRemovals()).toHaveLength(0);
      expect(signedOutEvents()).toHaveLength(0);
      expect(storedSession().refresh_token).toBe(seededRefreshToken);

      // ── 4 · inside the cooldown, nothing leaves the client ───────────
      const afterEpisode = intercepts.length;
      await c.auth.getSession();
      await c.auth.getSession();
      expect(intercepts.length).toBe(afterEpisode);
      // And the baseline has still never been reached: every one of those
      // 8 requests met the armed injector, none fell through.
      expect(baselineFetch).not.toHaveBeenCalled();

      // ── 5 · past REFRESH_FAILURE_COOLDOWN_MS (60 000) ────────────────
      await vi.advanceTimersByTimeAsync(70_000);

      // ── 6 · the rate limit is over; the baseline answers 200 ─────────
      armed = null;

      // ── 7 · the recovery ─────────────────────────────────────────────
      const { data, error } = await c.auth.getSession();
      const rec = report('D2C/recovery/after-cooldown');

      // A real request went out again.
      expect(intercepts.length).toBeGreaterThan(afterEpisode);
      expect(baselineFetch).toHaveBeenCalled();

      // The session was WRITTEN, never removed.
      expect(rec.primary_session_ops).toContain('setItem');
      expect(primaryRemovals()).toHaveLength(0);
      expect(signedOutEvents()).toHaveLength(0);

      // Usable again.
      expect(error).toBeNull();
      expect(data.session).not.toBeNull();

      // THE assertion: same identity, rotated credential. Compared on the
      // full uuid, not a prefix — a prefix could collide and this is the
      // property that decides whether uploaded evidence is still ours.
      const recovered = storedSession();
      expect((recovered.user as { id: string }).id).toBe(seededUserId);
      expect(data.session?.user.id).toBe(seededUserId);
      expect(typeof recovered.refresh_token).toBe('string');
      expect((recovered.refresh_token as string).length).toBeGreaterThan(0);
      expect(recovered.refresh_token).not.toBe(seededRefreshToken);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('teeth: without advancing past the cooldown, the baseline is never reached', async () => {
    // The recovery above could pass for the wrong reason — if the cooldown
    // were not actually holding, the retry would reach the baseline
    // regardless of the clock. Same flow, same disarm, no advance.
    vi.useFakeTimers();
    try {
      memory.clear();
      seedValidSession();
      assertSeededSessionIsStructurallyValid();

      armed = { status: 429, body: B429('over_request_rate_limit'), budget: 99, served: 0 };
      const c = makeClient();
      const episode = (async () => {
        await settle();
        return c.auth.getSession();
      })();
      await vi.advanceTimersByTimeAsync(40_000);
      await episode;

      const afterEpisode = intercepts.length;
      expect(afterEpisode).toBe(8);

      // Rate limit over — but the clock has NOT left the cooldown window.
      armed = null;
      await c.auth.getSession();
      await c.auth.getSession();

      // The cached failure answers; nothing reaches the network.
      expect(intercepts.length).toBe(afterEpisode);
      expect(baselineFetch).not.toHaveBeenCalled();
      expect(primaryRemovals()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});
