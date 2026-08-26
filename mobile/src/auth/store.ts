/**
 * Auth store (Zustand).
 *
 * Single source of truth for "am I signed in?" in the app.
 * - `init()` reads any persisted session from AsyncStorage (via supabase-js)
 *   and subscribes to auth changes (SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED).
 * - `signIn` / `signOut` delegate to supabase-js; the subscription keeps
 *   the store in sync so UI re-renders automatically.
 * - `accessToken` is exposed so the API client can attach it as Bearer.
 *
 * We do NOT cache the token separately — supabase-js owns refresh. When
 * the API client needs a token, it reads it from here, which reflects
 * the latest refreshed value.
 */

import { create } from 'zustand';
import {
  isAuthApiError,
  isAuthRetryableFetchError,
  type Session,
  type User,
} from '@supabase/supabase-js';
import { supabase } from './supabase';
// GC-AUTH-SESSION-RECOVERY-001 · D0 — observability. Zero-import leaf.
import { logAuthStateChange } from './authDiagnostics';
// R5 — the marker is the durable proof the ownership gate consults. Leaf
// module; importing it here cannot form a cycle.
import { markIdentityInitialized } from './identityMarker';
// PHASE 1A: the upload queue pauses globally on `401 NO_TOKEN`. Only a
// usable Supabase session may lift that pause, so auth transitions have
// to be observable by the worker. We notify a leaf module rather than
// importing the queue directly — `app/index.tsx` imports THIS file, so
// the reverse import would be a cycle.
import { notifyClientAuth } from '@/upload/pauseStore';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  accessToken: string | null;

  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

function applySession(session: Session | null): Partial<AuthState> {
  if (!session) {
    return { status: 'signed-out', user: null, accessToken: null };
  }
  return {
    status: 'signed-in',
    user: session.user,
    accessToken: session.access_token,
  };
}

let subscribed = false;

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  user: null,
  accessToken: null,

  init: async () => {
    console.log('SESSION_LOAD_START');

    // getSession() pulls whatever supabase-js has already hydrated from
    // AsyncStorage (or null if this is a fresh install / signed-out user).
    //
    // GC-AUTH-001: `error` here is NOT proof that the persisted session is
    // unusable. `getSession()` also surfaces a transient network failure
    // raised by the inline refresh it performs, and supabase-js already
    // wipes the stored session by itself (`_removeSession`) whenever the
    // refresh fails with a genuinely non-retryable auth error.
    //
    // The previous implementation answered any error with `signOut()`,
    // which clears AsyncStorage unconditionally. Since this app has no
    // login — identity is an anonymous Supabase user — destroying the
    // stored session destroys the only handle on every session the device
    // has already uploaded. A dropped Wi-Fi packet must never cost the
    // user their evidence.
    //
    // So: report the error, leave the store signed-out for this process,
    // and leave storage strictly alone. Recovering (or not) is
    // supabase-js's decision to make, not ours.
    const { data, error } = await supabase.auth.getSession();

    if (error) {
      console.log('SESSION_LOAD_ERROR', { name: error.name });
      set({ status: 'signed-out', user: null, accessToken: null });
    } else {
      console.log('SESSION_LOAD_RESULT', data.session ? 'signed-in' : 'no session');
      set(applySession(data.session));
    }

    // PHASE 1A: notify the SETTLED result of getSession() directly.
    //
    // A cold start with a valid persisted session is the exact case
    // where the queue may hold a CLIENT_SESSION_EXPIRED pause from the
    // previous process. Relying on supabase-js to also emit
    // INITIAL_SESSION afterwards would make pause recovery depend on
    // an event we do not control and have not verified. We notify
    // here, unconditionally, from the value we actually observed.
    //
    // A later INITIAL_SESSION / SIGNED_IN for the same session is
    // harmless: the restore handler only requests a drain when its own
    // invocation performed the pause transition, so the duplicate is
    // absorbed rather than producing a second drain.
    notifyClientAuth(!error && !!data?.session?.access_token);

    // R5 — an observed session is an observed identity, so record it.
    // Retries a marker write that failed on a previous attempt; the
    // in-memory latch makes this free once it has landed. No new timer:
    // this runs where the session was already being read.
    if (!error && data.session) {
      void ensureIdentityMarkerDurable(data.session.user?.id ?? null).catch(
        () => {
          /* never break the bootstrap over a marker retry */
        },
      );
    }

    if (!subscribed) {
      supabase.auth.onAuthStateChange((event, session) => {
        // GC-AUTH-SESSION-RECOVERY-001 · D0 — this used to be `_event`.
        // Discarding the name meant the SIGNED_OUT that `_removeSession()`
        // raises left no trace, so a run could not tell a session that was
        // deleted from one that never loaded. Metadata only; no tokens.
        logAuthStateChange(event, session);
        set(applySession(session));
        // "Usable" means a session that actually carries an access
        // token — a null session, or one without a token, must never
        // clear the pause. The handler on the other side is idempotent.
        notifyClientAuth(!!session?.access_token);
        // R5 — SIGNED_IN and TOKEN_REFRESHED are the natural retry points
        // for a marker whose write failed. TOKEN_REFRESHED alone fires
        // roughly hourly, which is well inside the window between a mint
        // and the reap that used to destroy the only other proof.
        if (session) {
          void ensureIdentityMarkerDurable(session.user?.id ?? null).catch(
            () => {
              /* diagnostics must never break the auth subscription */
            },
          );
        }
      });
      subscribed = true;
    }
  },

  signIn: async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    set(applySession(data.session));
  },

  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    set({ status: 'signed-out', user: null, accessToken: null });
  },
}));

/**
 * Returns the currently-valid access token, refreshing it if the
 * persisted session has expired.
 *
 * Why not read `useAuthStore.getState().accessToken` directly: that
 * value is a snapshot updated only when supabase-js fires an auth
 * state change event (SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT).
 * supabase-js schedules the refresh ~60s before the JWT's `exp`, but
 * that timer is best-effort — if the app was backgrounded, the JS
 * thread was paused, or the device slept through the refresh window,
 * the store will keep the expired token until the next scheduled tick
 * lands.
 *
 * `supabase.auth.getSession()`, unlike a plain store read, checks
 * `expires_at` against the current time and performs an inline refresh
 * (using the persisted refresh_token) when the access token has
 * expired. On success the client emits `TOKEN_REFRESHED`, which our
 * existing `onAuthStateChange` listener catches to keep the store in
 * sync. On failure (no refresh_token, network error, revoked refresh
 * token) it returns `{ session: null }` and we propagate that as a
 * null token — callers then surface the 401 path.
 *
 * GC-AUTH-001: the failure REASON used to be thrown away here, and the
 * only trace left in the logs was `AUTH MISSING`. That made four very
 * different situations indistinguishable after the fact — no session at
 * all, a refresh that could not reach the network, a refresh the server
 * rejected outright, and an unexpected auth error — which is why the
 * original diagnosis took a full log replay to pin down. `getAccessToken`
 * now reports which one it was; `getFreshAccessToken` is the unchanged
 * convenience wrapper for callers that only need the token.
 */
export type TokenFailureReason =
  /** No session in storage, and no error either. Genuinely signed out. */
  | 'no_session'
  /** The inline refresh could not reach Supabase. Retryable. */
  | 'network'
  /** Supabase answered and rejected the refresh (e.g. a revoked token). */
  | 'auth_non_retryable'
  /** An auth error we could not classify further. */
  | 'refresh_failed'
  /**
   * R5 — the session is fine, but `gc.identity.v1` is not durable, so this
   * identity may not create remote ownership yet. Transient by nature:
   * every observed session retries the write. Only `getOwnershipToken`
   * ever returns this; read paths are unaffected.
   */
  | 'marker_not_durable';

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: TokenFailureReason; name: string | null };

export async function getAccessToken(): Promise<TokenResult> {
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    const reason: TokenFailureReason = isAuthRetryableFetchError(error)
      ? 'network'
      : isAuthApiError(error)
        ? 'auth_non_retryable'
        : 'refresh_failed';
    // `name` is a class name (AuthApiError, AuthRetryableFetchError…),
    // never a message and never a token.
    return { ok: false, reason, name: error.name ?? null };
  }

  const token = data.session?.access_token ?? null;
  if (!token) return { ok: false, reason: 'no_session', name: null };
  return { ok: true, token };
}

export async function getFreshAccessToken(): Promise<string | null> {
  const result = await getAccessToken();
  return result.ok ? result.token : null;
}

// ------------------------------------------------------- ownership gate
/**
 * R5 — THE SINGLE AUTHORITY ON WHETHER THIS IDENTITY MAY CREATE REMOTE
 * OWNERSHIP. There is no second opinion and no per-endpoint `if (marker)`.
 *
 * The defect it closes: `hasProvenIdentityEvidence` looked for proof of a
 * past identity inside GC_QUEUE, and GC_QUEUE is deleted by `reapEntry`
 * once a session uploads and completes. The proof therefore vanished on
 * the HAPPY PATH — upload, /complete, reap, journal drop — leaving marker
 * absent + negative seal + no session, which mints a replacement identity
 * and orphans everything the first one owned.
 *
 * Rather than hunt for a proof that outlives cleanup, invert it: never let
 * an identity acquire remote ownership until the device can prove locally
 * that the identity exists. The two states become mutually exclusive —
 *
 *   marker not durable ⇒ A owns nothing remote
 *   A owns something remote ⇒ marker is durable
 *
 * — so `gc.identity.v1`, which no reap touches, is always sufficient. No
 * tombstone, no second key: a second key in the same AsyncStorage is not a
 * second durability domain.
 *
 * Read paths are untouched. Listing destinations, fetching chunk state,
 * recovery manifests and export downloads keep using `getAccessToken`:
 * reading creates nothing to own.
 */

/**
 * R6 — a token that has been through the ownership gate.
 *
 * The brand exists because the rule "this token must come from the
 * ownership authority" was previously a COMMENT, and a comment is not a
 * property. Every raw mutating helper took `token: string`, so any string
 * — a read token, a cached one, `tokenRef.current` — satisfied it and went
 * to the network.
 *
 * Same idiom the codebase already uses for `CompletionAuthorization` in
 * `src/video/sessionCleanupJournal.ts`, and for the same reason: the brand
 * field is a `unique symbol` that is declared and never exported, so no
 * caller outside this module can construct the type. `getOwnershipToken`
 * is the only producer.
 *
 * KNOWN LIMIT, stated rather than papered over: types are erased at
 * runtime, so a deliberate `as OwnershipToken` defeats the compiler. That
 * is what `assertOwnershipGateOpen` is for — it costs one boolean read and
 * catches exactly the case the brand cannot.
 */
declare const ownershipBrand: unique symbol;
export type OwnershipToken = string & { readonly [ownershipBrand]: true };

export type OwnershipTokenResult =
  | { ok: true; token: OwnershipToken }
  | { ok: false; reason: TokenFailureReason; name: string | null };

/**
 * Process-scoped latch. Once the marker is known durable it cannot become
 * undurable, so every later call is free. Deliberately NOT persisted —
 * this is a cache of a durable fact, never a substitute for it.
 */
let markerKnownDurable = false;

/** Thrown by `assertOwnershipGateOpen`. A plain Error on purpose:
 *  `classifyError` treats an Error with no HTTP status as TRANSIENT, so a
 *  blocked chunk stays `pending` and retries instead of being burned. */
export class OwnershipGateClosedError extends Error {
  constructor(path: string) {
    super(`ownership gate closed for ${path}`);
    this.name = 'OwnershipGateClosedError';
  }
}

/**
 * THE runtime half of the ownership authority. O(1): one boolean, no
 * AsyncStorage, no `getSession`, safe to call per chunk.
 *
 * Raw paths that bypass `apiFetch({ ownership: true })` call this
 * immediately before they can emit a mutation. The POLICY lives here and
 * only here — callers do not read the latch, do not re-derive the rule,
 * and cannot disagree with it. They ask, once, at the last moment.
 */
export function assertOwnershipGateOpen(path: string): void {
  if (markerKnownDurable) return;
  console.log('GC_OWNERSHIP_GATE_BLOCKED', { path });
  throw new OwnershipGateClosedError(path);
}

/** Read-only view of the same authority, for diagnostics and tests. */
export function isOwnershipGateOpen(): boolean {
  return markerKnownDurable;
}

/**
 * Records an observed identity, retrying a write that previously failed.
 *
 * Called from the natural points where a session is already in hand —
 * `init()`, `onAuthStateChange`, and the ownership gate itself. NO NEW
 * POLLING: every one of those already runs for other reasons, and the
 * latch makes repeats free.
 */
export async function ensureIdentityMarkerDurable(
  subPrefix: string | null,
): Promise<boolean> {
  if (markerKnownDurable) return true;
  let persisted = false;
  try {
    ({ persisted } = await markIdentityInitialized(subPrefix));
  } catch {
    // P2: a storage failure must not become an exception in the capture
    // path. Not durable is the honest answer; the gate stays shut.
    persisted = false;
  }
  if (persisted) {
    markerKnownDurable = true;
    return true;
  }
  console.log('GC_IDENTITY_MARKER_NOT_DURABLE_YET');
  return false;
}

/** Test seam. Never called by product code. */
export function __resetOwnershipLatchForTests(): void {
  markerKnownDurable = false;
}

/**
 * A token that may be used to CREATE OR MUTATE remote state owned by this
 * user. Every mutating endpoint takes its token from here and nowhere
 * else — including the upload worker's cached hot-path token, which would
 * otherwise walk straight around the gate.
 */
export async function getOwnershipToken(): Promise<OwnershipTokenResult> {
  // R6 — ONE authoritative read. The previous version called
  // `getAccessToken()` (which reads the session) and then read the session
  // AGAIN for the user id, returning the token from the first read and the
  // identity from the second. Between them the session could refresh,
  // disappear, or the call could reject — so the token and the identity
  // that opened the gate came from two different moments. Everything below
  // derives from this single snapshot.
  let data: { session: Session | null } | null = null;
  let error: unknown = null;
  try {
    const probe = await supabase.auth.getSession();
    data = probe.data;
    error = probe.error;
  } catch (err) {
    // R6 / P2 — `getSession()` REJECTING is not the same as returning an
    // error, and it used to propagate straight out of here into
    // `startRecording`, which awaits this outside any catch. A failure to
    // resolve ownership must never abort a recording.
    return {
      ok: false,
      reason: 'refresh_failed',
      name: err instanceof Error ? err.name : null,
    };
  }

  if (error) {
    const reason: TokenFailureReason = isAuthRetryableFetchError(error)
      ? 'network'
      : isAuthApiError(error)
        ? 'auth_non_retryable'
        : 'refresh_failed';
    const name =
      error && typeof error === 'object' && 'name' in error
        ? String((error as { name?: unknown }).name ?? '')
        : null;
    return { ok: false, reason, name: name || null };
  }

  const session = data?.session ?? null;
  const token = session?.access_token ?? null;
  if (!token) return { ok: false, reason: 'no_session', name: null };

  if (!markerKnownDurable) {
    // Same snapshot: the identity we try to record is the one whose token
    // we are about to hand out.
    const durable = await ensureIdentityMarkerDurable(
      session?.user?.id ?? null,
    );
    if (!durable) {
      return { ok: false, reason: 'marker_not_durable', name: null };
    }
  }

  // The ONLY place this cast appears. Everything downstream receives an
  // `OwnershipToken` and cannot manufacture one.
  return { ok: true, token: token as OwnershipToken };
}

/**
 * Convenience mirror of `getFreshAccessToken` for ownership callers.
 *
 * NEVER REJECTS. `startRecording` awaits this before its first durable
 * write and outside any try/catch: a throw here would abort a capture,
 * which is precisely the outcome P2 forbids. Any failure — auth, storage,
 * network — resolves to `null`, which routes to the deferral 4B already
 * built and leaves the evidence untouched.
 */
export async function getOwnershipAccessToken(): Promise<OwnershipToken | null> {
  try {
    const result = await getOwnershipToken();
    return result.ok ? result.token : null;
  } catch {
    return null;
  }
}
