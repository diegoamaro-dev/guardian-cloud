/**
 * Phase 1A — persisted global blocking state for the upload worker.
 *
 * What this is:
 *   A single AsyncStorage key that answers one question — "may the
 *   worker issue network requests right now, and for whom?".
 *
 * What this is NOT:
 *   It is NOT a second queue and NOT a second source of truth. It holds
 *   no chunks, no sessions, no ordering, no evidence and no work items.
 *   `GC_QUEUE` (`test.pending_retry`) remains the only queue and the
 *   only source of truth for evidence. Removing this key entirely would
 *   lose no evidence — it would only lose the memory of "we are
 *   blocked", which is precisely why it must be persisted separately.
 *
 * Why a dedicated key rather than a field on the entries:
 *   A global pause has to survive the case where the queue holds ZERO
 *   entries. `test.pending_retry` stores an array; with `[]` there is no
 *   row on which to hang a global flag. Duplicating the pause across
 *   entries also creates an inheritance race for entries appended while
 *   paused. A dedicated key removes both problems: nothing is inherited
 *   because nothing is copied — the worker consults this key directly.
 *
 * Serialization contract:
 *   This module deliberately owns NO write chain. `readState` /
 *   `writeState` are plain reads and writes; the caller is responsible
 *   for running them inside the existing `queueMutate` chain in
 *   `app/index.tsx` so that queue mutations and pause mutations remain
 *   totally ordered against each other. Introducing a second chain here
 *   would create exactly the split-brain this phase is meant to avoid.
 *
 * Hydration contract:
 *   `ensureReady()` is a single-flight promise. Every drain path must
 *   await it BEFORE any network request, so a restarted app cannot fire
 *   a request against a pause it has not read from disk yet. The
 *   background drain gets this for free: it calls the same
 *   `uploadDrainLoop`, which awaits `ensureReady()` at its entry.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const GLOBAL_PAUSE_KEY = 'gc.pause.global.v1';

/**
 * Bumped only when the MEANING of an existing pause changes in a way a
 * newer build must re-evaluate. Phase 1A ships version 1 and never
 * re-evaluates: `SYSTEMIC_CONFIG_PAUSE` pauses and preserves, and the
 * compatible-probe/migration design is explicitly deferred.
 */
export const PAUSE_POLICY_VERSION = 1;

export interface GlobalPauseState {
  version: 1;
  /** Supabase session unusable (401 / NO_TOKEN). Blocks everything. */
  client_auth: { at: number; code: string } | null;
  /** Compile-time config defect (413). Blocks everything. */
  systemic: { at: number; code: string; policy_version: number } | null;
  /** Per-destination auth block (Drive OAuth). Keyed by destination type. */
  destinations: Record<string, { at: number; code: string } | undefined>;
}

export function emptyPauseState(): GlobalPauseState {
  return {
    version: 1,
    client_auth: null,
    systemic: null,
    destinations: {},
  };
}

// ----- hydration ------------------------------------------------------

let cache: GlobalPauseState | null = null;
let hydration: Promise<GlobalPauseState> | null = null;

/**
 * Parse defensively. A corrupt or partially-written value must NOT be
 * interpreted as "no pause" silently in a way that loses a block —
 * but it also must not brick the worker forever. We rebuild the known
 * fields and drop anything unrecognised. A value we cannot parse at all
 * yields an empty state (fail-open), which is the same position a fresh
 * install is in; the underlying error will re-pause on the next attempt
 * because the failing request will fail again and re-classify.
 */
function parse(raw: string | null): GlobalPauseState {
  if (!raw) return emptyPauseState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return emptyPauseState();
    const o = parsed as Partial<GlobalPauseState>;
    const out = emptyPauseState();
    if (o.client_auth && typeof o.client_auth.at === 'number') {
      out.client_auth = {
        at: o.client_auth.at,
        code: String(o.client_auth.code ?? 'NO_TOKEN'),
      };
    }
    if (o.systemic && typeof o.systemic.at === 'number') {
      out.systemic = {
        at: o.systemic.at,
        code: String(o.systemic.code ?? 'BODY_TOO_LARGE'),
        policy_version:
          typeof o.systemic.policy_version === 'number'
            ? o.systemic.policy_version
            : PAUSE_POLICY_VERSION,
      };
    }
    if (o.destinations && typeof o.destinations === 'object') {
      for (const [k, v] of Object.entries(o.destinations)) {
        if (v && typeof v.at === 'number') {
          out.destinations[k] = { at: v.at, code: String(v.code ?? 'UNKNOWN') };
        }
      }
    }
    return out;
  } catch {
    return emptyPauseState();
  }
}

/**
 * Hydrate once per process. Concurrent callers share one read; later
 * callers get the cached state without touching AsyncStorage.
 */
export function ensureReady(): Promise<GlobalPauseState> {
  if (cache) return Promise.resolve(cache);
  if (hydration) return hydration;
  hydration = (async () => {
    let raw: string | null = null;
    try {
      raw = await AsyncStorage.getItem(GLOBAL_PAUSE_KEY);
    } catch {
      // Storage unavailable. Treat as empty rather than throwing —
      // throwing here would take the whole drain down, and the pause
      // will be re-established by the next classified failure.
      raw = null;
    }
    cache = parse(raw);
    return cache;
  })();
  return hydration;
}

/**
 * Synchronous read of the hydrated state. Returns null when
 * `ensureReady()` has not resolved yet — callers must treat null as
 * "not safe to send network" rather than "no pause".
 */
export function getSnapshot(): GlobalPauseState | null {
  return cache;
}

/** Read-through. Hydrates first if necessary. */
export async function readState(): Promise<GlobalPauseState> {
  return ensureReady();
}

/**
 * Persist. The caller MUST already be inside the queue write chain.
 * Updates the in-memory cache only after the write lands, so a failed
 * write cannot leave the process believing it is unpaused.
 */
export async function writeState(next: GlobalPauseState): Promise<void> {
  await AsyncStorage.setItem(GLOBAL_PAUSE_KEY, JSON.stringify(next));
  cache = next;
}

/** True when nothing may talk to the network at all. */
export function isGloballyBlocked(state: GlobalPauseState): boolean {
  return state.client_auth !== null || state.systemic !== null;
}

/** True when this destination specifically may not talk to the network. */
export function isDestinationBlocked(
  state: GlobalPauseState,
  destination: string,
): boolean {
  return state.destinations[destination] !== undefined;
}

// ----- client-auth restoration latch ----------------------------------
//
// `auth/store.ts` observes Supabase auth transitions. It must be able to
// report "the session is usable again" WITHOUT importing the queue (that
// would couple a leaf auth module to the 6k-line screen and create an
// import cycle). It calls `notifyClientAuth` here instead.
//
// The race this latch closes (handoff §13): supabase-js can restore a
// persisted session during module init, before `app/index.tsx` has
// registered its handler. Without retention that event is simply lost
// and the queue stays paused forever with a perfectly valid session.
//
// Retention semantics: we keep only the LAST notification, and it is
// delivered exactly once when a handler registers. Post-registration
// notifications pass straight through. The handler itself is idempotent
// (it no-ops when no client-auth pause is set), which is what keeps
// repeated TOKEN_REFRESHED events from requesting repeated drains.

type AuthRestoreHandler = (usable: boolean) => void;

let handler: AuthRestoreHandler | null = null;
let retained: { usable: boolean } | null = null;

/**
 * Called by `auth/store.ts` on every Supabase auth state change.
 * `usable` is true only when there is a session carrying an access
 * token — a null session or a session without a token is NOT usable and
 * must not clear a pause.
 */
export function notifyClientAuth(usable: boolean): void {
  if (handler) {
    handler(usable);
    return;
  }
  retained = { usable };
}

/**
 * Called once by `app/index.tsx` at module scope. Any notification that
 * arrived before registration is delivered here, exactly once.
 */
export function registerAuthRestoreHandler(fn: AuthRestoreHandler): void {
  handler = fn;
  if (retained) {
    const { usable } = retained;
    retained = null;
    fn(usable);
  }
}

/**
 * Test-only seam: full reset, including the registered handler.
 * Models a cold process start. Never called by production code.
 */
export function _resetPauseStoreForTests(): void {
  cache = null;
  hydration = null;
  handler = null;
  retained = null;
}

/**
 * Test-only seam: drop the hydration cache ONLY, keeping whatever
 * handler `app/index.tsx` registered at import time. Needed by tests
 * that exercise the restore path, because a full reset would
 * unregister a handler that can only be re-registered by re-importing
 * the module. Never called by production code.
 */
export function _resetPauseCacheForTests(): void {
  cache = null;
  hydration = null;
}
