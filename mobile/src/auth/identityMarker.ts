/**
 * GC-AUTH-001 — durable proof that this device has already had an identity.
 *
 * Guardian Cloud identifies itself with an ANONYMOUS Supabase user. There
 * is no login, so an identity that is lost cannot be signed back into: the
 * sessions it uploaded become unreachable from the app forever.
 *
 * The defect this module exists to prevent: the bootstrap used to read
 * `session == null` as "this device has never had an identity" and answer
 * it by minting a new anonymous user, which overwrites the persisted one.
 * A dropped packet, a failed token refresh, or any transient storage
 * hiccup was therefore enough to permanently orphan every session the
 * device had already protected. It happened twice in one evening.
 *
 * The rule this module enforces:
 *
 *   A new anonymous identity may only be minted when Guardian Cloud can
 *   PROVE no identity has ever existed on this device.
 *   `session == null` is not that proof.
 *
 * ## Why this is not a second source of truth for the session
 *
 * The state machine reads exactly ONE bit out of this marker: whether the
 * record exists. Nothing here is ever used to authenticate, to build a
 * request, or to reconstruct a session — supabase-js remains the sole
 * owner of the session itself. `sub_prefix` is diagnostics only: eight hex
 * characters, enough to see in a log that the identity changed, useless
 * for anything else. No JWT, no refresh token, no credential of any kind
 * is stored here, and none ever should be.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const IDENTITY_KEY = 'gc.identity.v1';

/** Bumped only if the MEANING of an existing marker changes. */
export const IDENTITY_MARKER_VERSION = 1;

export interface IdentityMarker {
  version: 1;
  /** Epoch ms of the first moment we observed an identity on this device. */
  initialized_at: number;
  /**
   * First 8 characters of the Supabase user id. DIAGNOSTIC ONLY — never
   * read by any decision in this module or its callers. Null when the id
   * was unavailable at write time, which is not an error.
   */
  sub_prefix: string | null;
  /** True when the marker was inferred by `probeLegacyIdentity`, not observed. */
  migrated_from_legacy: boolean;
}

export type IdentityState =
  /** No identity has ever existed here. Minting is allowed — only here. */
  | 'FIRST_IDENTITY'
  /** A usable session exists. Normal operation. */
  | 'IDENTITY_OK'
  /** An identity existed (or may have), but Supabase cannot produce a
   *  session. Minting is FORBIDDEN. */
  | 'IDENTITY_DEGRADED';

export type IdentityReason =
  | 'session_present'
  | 'no_prior_identity'
  | 'prior_identity_no_session'
  | 'session_error';

export interface IdentityDecision {
  state: IdentityState;
  reason: IdentityReason;
}

/**
 * The whole rule, as one pure function.
 *
 * Kept free of I/O so the transition table can be tested exhaustively
 * without standing up AsyncStorage or supabase-js.
 *
 * The row that matters most is the last one: an ERROR never opens the
 * minting gate, not even when no marker is present. A `getSession()` that
 * failed cannot demonstrate that no identity has ever existed — it only
 * demonstrates that we could not find out. Treating "I don't know" as
 * "there is nothing" is precisely the mistake that caused GC-AUTH-001.
 */
export function decideIdentityState(input: {
  hasSession: boolean;
  hasError: boolean;
  initialized: boolean;
}): IdentityDecision {
  if (input.hasSession) {
    return { state: 'IDENTITY_OK', reason: 'session_present' };
  }
  if (input.hasError) {
    return { state: 'IDENTITY_DEGRADED', reason: 'session_error' };
  }
  if (input.initialized) {
    return { state: 'IDENTITY_DEGRADED', reason: 'prior_identity_no_session' };
  }
  return { state: 'FIRST_IDENTITY', reason: 'no_prior_identity' };
}

/** Reads the marker. A malformed or unreadable record is reported as
 *  absent — see `probeLegacyIdentity`, which is the safety net. */
export async function readIdentityMarker(): Promise<IdentityMarker | null> {
  try {
    const raw = await AsyncStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as IdentityMarker).version === IDENTITY_MARKER_VERSION &&
      typeof (parsed as IdentityMarker).initialized_at === 'number'
    ) {
      return parsed as IdentityMarker;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Records that an identity exists on this device. Idempotent: an existing
 * marker is never overwritten, so `initialized_at` keeps pointing at the
 * FIRST identity we ever saw and `migrated_from_legacy` is not rewritten
 * by a later observation.
 *
 * Called from two places, both on the success path: right after a
 * successful `signInAnonymously()`, and after any `getSession()` that
 * yields a session (the back-fill that covers devices which already had a
 * live identity when this code shipped).
 */
export async function markIdentityInitialized(
  subPrefix: string | null,
  opts: { migratedFromLegacy?: boolean } = {},
): Promise<IdentityMarker> {
  const existing = await readIdentityMarker();
  if (existing) return existing;

  const marker: IdentityMarker = {
    version: IDENTITY_MARKER_VERSION,
    initialized_at: Date.now(),
    sub_prefix: subPrefix ? subPrefix.slice(0, 8) : null,
    migrated_from_legacy: opts.migratedFromLegacy === true,
  };
  try {
    await AsyncStorage.setItem(IDENTITY_KEY, JSON.stringify(marker));
  } catch (err) {
    // A failed write is not fatal for THIS run — the session is fine and
    // the back-fill will retry on the next boot. It is logged because a
    // device that can never persist the marker would keep re-minting.
    console.log('GC_IDENTITY_MARK_FAILED', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return marker;
}

/**
 * Keys that can only be non-empty if this device once held an identity.
 *
 * Literals are mirrored here on purpose rather than imported: this is a
 * leaf module and `app/index.tsx` imports it, so importing back would be
 * a cycle. Same idiom already used by `src/recording/localEvidence.ts`
 * and `src/recording/orphanScan.ts`.
 *
 *   history.sessions                       a recording finished
 *   test.pending_retry                     a session reached the queue
 *   guardian.pending_session_registrations  a session was created
 *   export.last_session_id                 an export ran
 */
const LEGACY_IDENTITY_EVIDENCE_KEYS = [
  'history.sessions',
  'test.pending_retry',
  'guardian.pending_session_registrations',
  'export.last_session_id',
] as const;

/**
 * One-shot migration probe for installs that predate the marker.
 *
 * The inference is not a heuristic — it is an implication of the code as
 * it stands: `startRecording` refuses to begin without a token, so ANY
 * durable trace of a recording proves a token, and therefore an identity,
 * once existed here.
 *
 * TIMING MATTERS. This probe is only meaningful while that implication
 * holds, i.e. before capture-under-degraded-identity ships. It runs once,
 * during bootstrap, before any new recording can exist — and from then on
 * the marker is written whenever a session is observed, so the probe is
 * never consulted again. If you move this call later in the boot sequence,
 * re-read this paragraph first.
 *
 * KNOWN AND ACCEPTED LIMIT: a device that installed the app, never
 * recorded anything, and then lost its session is indistinguishable from
 * a fresh install. It will be treated as FIRST_IDENTITY and mint. That
 * failure mode is benign — there is no evidence to lose — and closing it
 * would require a durable signal that does not exist today. Do not invent
 * one here.
 */
export async function probeLegacyIdentity(): Promise<boolean> {
  for (const key of LEGACY_IDENTITY_EVIDENCE_KEYS) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      // `export.last_session_id` is a bare string; the rest are JSON
      // arrays, and '[]' must not count as evidence.
      if (key === 'export.last_session_id') {
        if (raw.trim().length > 0) return true;
        continue;
      }
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return true;
    } catch {
      // An unreadable key proves nothing either way. Keep looking.
    }
  }
  return false;
}

/**
 * Resolves `initialized` for the state machine, running the legacy probe
 * exactly once when no marker is present.
 *
 * Returns the value the caller should feed to `decideIdentityState`, plus
 * whether it came from the probe (so the caller can log it and so the
 * marker, if later written, records how it was established).
 */
export async function resolveIdentityInitialized(): Promise<{
  initialized: boolean;
  fromLegacyProbe: boolean;
  marker: IdentityMarker | null;
}> {
  const marker = await readIdentityMarker();
  if (marker) {
    return { initialized: true, fromLegacyProbe: false, marker };
  }

  const legacy = await probeLegacyIdentity();
  if (!legacy) {
    return { initialized: false, fromLegacyProbe: false, marker: null };
  }

  // Durable evidence of a prior identity, but no marker: this install
  // predates the marker. Stamp it now so the probe never has to run
  // again, and so the state survives even if the evidence keys are later
  // trimmed. `sub_prefix` is null — we genuinely do not know which
  // identity it was, and guessing would be worse than admitting it.
  const written = await markIdentityInitialized(null, {
    migratedFromLegacy: true,
  });
  return { initialized: true, fromLegacyProbe: true, marker: written };
}
