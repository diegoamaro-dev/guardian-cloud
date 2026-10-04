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
// Leaf module with no imports of its own, so this cannot form a cycle.
// `isChunkConfirmedOffDevice` is THE definition of "this fragment is
// outside the device" and is already the predicate the export and
// finalize paths use. Reusing it means the identity layer and the
// protection layer cannot drift apart about what counts as proof.
import { isChunkConfirmedOffDevice } from '@/recording/deriveGuardianStatus';

export const IDENTITY_KEY = 'gc.identity.v1';

/** Bumped only if the MEANING of an existing marker changes. */
export const IDENTITY_MARKER_VERSION = 1;

/**
 * GC-AUTH-MIGRATION-001 — the durable answer to the migration question.
 *
 * SEPARATE KEY ON PURPOSE. This is NOT a second opinion about identity.
 * `gc.identity.v1` remains the sole authority on whether an identity has
 * been established; this record answers one different, historical
 * question, exactly once:
 *
 *   "At the moment this device first ran a build that asks, did it carry
 *    any trace of an identity that predates the migration boundary?"
 */
export const LEGACY_PROBE_KEY = 'gc.legacy_probe.v1';

/**
 * Generation of the PROBE SEMANTICS — the meaning of the signal set in
 * `LEGACY_IDENTITY_EVIDENCE_KEYS`. Bump only when that meaning changes,
 * never for a refactor. A seal written by a different generation is not
 * silently reinterpreted: see `readLegacyProbeSeal`.
 */
export const LEGACY_PROBE_VERSION = 1;

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
  /**
   * G-R1 — THE ANCHOR. Full Supabase `user.id` of the historical identity.
   *
   * This is the ONLY field in this module that any security decision reads:
   * `checkIdentityContinuity` compares a candidate session against it, and
   * `getOwnershipToken` refuses to mint an `OwnershipToken` when they
   * disagree. `sub_prefix` stays what it has always been — diagnostic — and
   * is NEVER consulted for that decision: 8 truncated characters are a
   * correlation aid, not an identity, and they are structurally `null` on
   * every marker the legacy probe wrote.
   *
   * OPTIONAL ON PURPOSE, and `version` stays 1. Markers written before this
   * field existed remain valid and parse unchanged — the meaning of nothing
   * already stored has changed, which is the only thing a version bump is
   * for. Absence means **not verifiable**, never "matches".
   *
   * WRITE-ONCE. Once present it is never rewritten, not even by a later
   * observation and not even when a candidate disagrees. A disagreement is
   * resolved by refusing the session, never by moving the anchor to it —
   * that would make the check circular and silently adopt the wrong user.
   */
  user_id?: string;
}

/**
 * G-R1 — whether THIS BUILD can bring a session into existence by any route
 * other than the one anonymous mint: email + OTP recovery.
 *
 * It gates the anchor back-fill, and the reasoning is the whole point of the
 * flag. The back-fill trusts a live session to BE the historical identity.
 * That inference holds only while no other route can produce a session:
 * `IDENTITY_DEGRADED` never mints, and nothing else signs in. The moment a
 * recovery entry exists, a live session may be the candidate itself, and
 * anchoring it would make the continuity check compare the candidate against
 * itself — a check that always passes and proves nothing.
 *
 * G-R3 flips this to `true` and, by doing so, turns the back-fill off. A
 * device that reaches that build without an anchor is `RECOVERY_NOT_VERIFIABLE`
 * and stays that way: a durable `recovery_attempted` record, decided before
 * G-R3, is what will allow anything finer.
 */
export const RECOVERY_ENTRY_IMPLEMENTED = false;

/**
 * The sealed result of the one-shot legacy migration probe.
 *
 * READ THE SEMANTICS BEFORE USING THIS ANYWHERE:
 *
 *   - It records the outcome of ONE historical migration, answered once.
 *   - It says NOTHING about whether an identity exists right now.
 *   - `gc.identity.v1` stays the authority for established identity; this
 *     value feeds `initialized` ONLY when no marker exists at all.
 *   - `legacy_identity_evidence: false` means exactly "at the migration
 *     boundary this install carried no trace of a prior identity". It does
 *     NOT mean "no identity exists", "nothing was ever minted", or
 *     "minting is safe".
 */
export interface LegacyProbeSeal {
  version: 1;
  /** Generation of the probe semantics that produced this answer. */
  probe_version: number;
  /**
   * Epoch ms when the question was answered. DIAGNOSTICS ONLY — never
   * compared against anything. Guardian Cloud has measured a test device
   * running 21 693 s ahead of real time; a decision about identity
   * ownership must never rest on this clock.
   */
  evaluated_at: number;
  /** The historical answer. See the semantics note above. */
  legacy_identity_evidence: boolean;
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
  | 'session_error'
  /**
   * The legacy probe answered "no prior identity" but that answer could
   * not be written to disk. We know what the answer IS and still refuse
   * to act on it — see `decideIdentityState`.
   */
  | 'boundary_unsealed';

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
  /**
   * GC-AUTH-MIGRATION-001 — the negative verdict exists only in memory.
   *
   * A `false` from the legacy probe is worth acting on ONLY once it is on
   * disk. If the seal write failed, this boot knows the answer but the
   * next boot will not: it will re-run the probe, and by then a
   * local-first capture may have written the very traces the probe reads
   * as proof of a historical identity. Minting on an unsealed negative is
   * therefore a bet that the process survives long enough to persist it.
   *
   * We do not take that bet. Same principle as the `hasError` row: an
   * answer we cannot record is not an answer we may act on. Defaults to
   * `false` so callers that never reach the probe are unaffected.
   */
  boundaryUnsealed?: boolean;
}): IdentityDecision {
  if (input.hasSession) {
    return { state: 'IDENTITY_OK', reason: 'session_present' };
  }
  if (input.hasError) {
    return { state: 'IDENTITY_DEGRADED', reason: 'session_error' };
  }
  if (input.boundaryUnsealed === true) {
    return { state: 'IDENTITY_DEGRADED', reason: 'boundary_unsealed' };
  }
  if (input.initialized) {
    return { state: 'IDENTITY_DEGRADED', reason: 'prior_identity_no_session' };
  }
  return { state: 'FIRST_IDENTITY', reason: 'no_prior_identity' };
}

/**
 * What the marker slot actually holds.
 *
 * GC-AUTH-MIGRATION-001 — `absent` and `malformed` USED TO BE THE SAME
 * ANSWER, and collapsing them was safe only while the legacy probe was
 * the safety net behind both. Once a sealed negative verdict can carry
 * `initialized: false` past the probe, that collapse becomes an ownership
 * bug: a marker that rotted in storage would look exactly like a device
 * that never had one, and the seal would wave it through to a mint.
 *
 * A byte present in this slot is proof that something once wrote a
 * marker here, and only an established identity (or a completed legacy
 * migration) ever writes one. That is enough to refuse minting.
 *
 * GC-AUTH-ANCHOR-MALFORMED-001 — A STORAGE READ THAT THROWS AND BROKEN
 * BYTES ARE NOT THE SAME FACT, and reporting both as one `malformed`
 * answer is what hid the defect. A throw observed NO BYTES and says
 * nothing about the marker; it is retryable. Corrupt bytes ARE the
 * marker, broken; no retry fixes them. Both refuse to mint for the same
 * reason `decideIdentityState` refuses on `hasError` — not being able to
 * find out is not the same as finding nothing — but only one of them can
 * come right on the next read, and a caller that cannot tell them apart
 * cannot say why it refused.
 *
 * VALIDITY IS DECIDED HERE AND NOWHERE ELSE. `present` guarantees the
 * whole schema, `user_id` included: either the property is absent — a
 * valid pre-G-R1 marker, eligible for the anchor back-fill — or it is a
 * non-empty string, and the marker is anchored. A `user_id` that is
 * PRESENT BUT INVALID (`''`, null, a number) is `corrupt`, never
 * `present`: "present but invalid" is not "absent", and collapsing the
 * two is what let a live session overwrite an anchor it could not read.
 * Writers therefore carry no validity guard of their own — there is one
 * authority on what a valid marker is, and this is it.
 */
export type IdentityMarkerRead =
  | { kind: 'present'; marker: IdentityMarker }
  | { kind: 'absent' }
  /**
   * `getItem` threw: no bytes were observed. Says nothing about the
   * marker, and the next read may well succeed.
   */
  | { kind: 'unreadable' }
  /**
   * Bytes were observed and are not a valid marker. NEVER overwritten:
   * they are the only remaining trace of the identity this device held,
   * and inventing a replacement would invent its owner.
   */
  | { kind: 'corrupt' };

export async function readIdentityMarkerState(): Promise<IdentityMarkerRead> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(IDENTITY_KEY);
  } catch {
    return { kind: 'unreadable' };
  }
  // ONLY `null` means absence. An empty string is a slot that EXISTS and
  // does not hold a marker, which is a corruption and not an absence —
  // `JSON.parse('')` throws, so it lands in `corrupt` below. Nothing in
  // this app can write one: every write here is `JSON.stringify` of a
  // marker object.
  if (raw === null) return { kind: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as IdentityMarker).version !== IDENTITY_MARKER_VERSION ||
    typeof (parsed as IdentityMarker).initialized_at !== 'number'
  ) {
    // An unknown or FUTURE `version` lands here, never in `absent`: a
    // marker this build cannot interpret is still a marker, and a
    // rollback from a later schema must not look like a fresh install.
    return { kind: 'corrupt' };
  }
  // The anchor, if the property is there at all. `in` and not
  // `=== undefined`, because JSON cannot encode `undefined`: a parsed
  // object either carries the key or it does not, and that difference is
  // the contract — absent means "pre-G-R1, back-fillable", invalid means
  // "broken, hands off".
  if ('user_id' in (parsed as object)) {
    const anchor = (parsed as IdentityMarker).user_id;
    if (typeof anchor !== 'string' || anchor.length === 0) {
      return { kind: 'corrupt' };
    }
  }
  return { kind: 'present', marker: parsed as IdentityMarker };
}

/** Reads the marker, collapsing every non-`present` answer into `null`.
 *
 *  GC-AUTH-ANCHOR-MALFORMED-001 — NO PRODUCTION CODE CALLS THIS, and none
 *  may. The collapse it performs IS the defect: it made `corrupt` and
 *  `unreadable` indistinguishable from `absent`, and its one caller —
 *  `markIdentityInitialized` — read that `null` as an empty slot and
 *  overwrote the bytes, fabricating an anchor for whatever session was
 *  live. That caller now reads `readIdentityMarkerState` directly.
 *
 *  Kept for diagnostics and for tests that only want the happy path. Any
 *  decision about writing, minting or ownership uses
 *  `readIdentityMarkerState`, which keeps the four answers apart. */
export async function readIdentityMarker(): Promise<IdentityMarker | null> {
  const read = await readIdentityMarkerState();
  return read.kind === 'present' ? read.marker : null;
}

/**
 * The outcome of a marker write, as a discriminated union.
 *
 * GC-AUTH-ANCHOR-MALFORMED-001 — a union and not a struct, because a
 * REFUSAL HAS NO MARKER TO REPORT and must not be able to pretend
 * otherwise. Returning a fabricated marker object alongside
 * `persisted: false` would be the same category error this finding is
 * about, one layer up.
 *
 * `persisted` keeps its exact previous meaning, so the only consumer that
 * reads it — `ensureIdentityMarkerDurable` — needs no change: a refusal
 * reports `false` and the ownership gate stays shut. With corrupt bytes an
 * identity demonstrably existed, but WHICH one is unknown, so the marker
 * is not usable as the authority and `false` is the honest answer.
 *
 * What `persisted` means, and why the caller has to be able to see it:
 *
 *   `false` means an identity exists but nothing on disk records it.
 *
 *   GC-AUTH-MIGRATION-001 — this used to be swallowed. The comment that
 *   stood here said a failed write "is not fatal for THIS run" because
 *   "the back-fill will retry on the next boot". That is only true while
 *   the session survives to the next boot. Once a durable negative seal
 *   exists, the combination
 *
 *     mint succeeds → marker write fails → session later lost
 *
 *   reads, on the next boot, as marker-absent + seal-false + no session,
 *   i.e. FIRST_IDENTITY — and mints a SECOND identity, silently orphaning
 *   everything the first one uploaded. The caller has to be able to see
 *   this and act on it.
 */
export type IdentityMarkWrite =
  | {
      persisted: true;
      marker: IdentityMarker;
      /** `created` wrote it just now; `existing` found it already there. */
      source: 'created' | 'existing';
    }
  | {
      persisted: false;
      /** The marker we TRIED to write: storage refused it, we did not. */
      marker: IdentityMarker;
      reason: 'write_failed';
    }
  | {
      persisted: false;
      /**
       * Nothing was read and NOTHING WAS WRITTEN. There is no marker to
       * return and inventing one would repeat the defect.
       */
      marker: null;
      reason: 'marker_corrupt' | 'marker_unreadable';
    };

/**
 * Records that an identity exists on this device.
 *
 * IDEMPOTENT, AND NOW LITERALLY SO. An existing marker is never
 * overwritten, so `initialized_at` keeps pointing at the FIRST identity we
 * ever saw and `migrated_from_legacy` is not rewritten by a later
 * observation.
 *
 * GC-AUTH-ANCHOR-MALFORMED-001 — that promise used to hold only for a
 * marker this build could PARSE. The read went through
 * `readIdentityMarker`, which collapsed `corrupt` and `unreadable` into
 * the same `null` an empty slot produces, so unreadable bytes were
 * replaced by a brand-new marker anchored to whatever session happened to
 * be live — and since G-R1 that replacement fabricated the very field
 * ownership depends on.
 *
 * SO THE RULE IS NOW EXACT: `setItem` happens if and only if the observed
 * state is `absent`. `present` returns what is already there; `corrupt`
 * and `unreadable` refuse without touching a byte.
 *
 * REFUSING IS THE PRESERVATION. Nothing in this app deletes the key, so
 * declining to write leaves the original bytes verbatim — no salvage slot,
 * no second durable key, nothing new to keep consistent.
 *
 * Called from the success paths where a session is already in hand: right
 * after a successful `signInAnonymously()`, after any `getSession()` that
 * yields one, and from the legacy stamp in
 * `resolveIdentityInitializedUncached`.
 */

export async function markIdentityInitialized(
  /**
   * G-R1 — the FULL `user.id`, not a prefix. Callers already passed the
   * whole value and this function truncated it; the parameter was merely
   * named after what it kept. It now keeps both: the full id as the
   * continuity anchor, and the 8-character prefix for diagnostics.
   */
  userId: string | null,
  opts: { migratedFromLegacy?: boolean } = {},
): Promise<IdentityMarkWrite> {
  const read = await readIdentityMarkerState();
  if (read.kind === 'present') {
    return { persisted: true, marker: read.marker, source: 'existing' };
  }
  if (read.kind === 'unreadable' || read.kind === 'corrupt') {
    // The one thing this function must never do. Metadata only: a reason,
    // never the bytes, never an id.
    console.log('GC_IDENTITY_MARK_REFUSED', { reason: read.kind });
    return {
      persisted: false,
      marker: null,
      reason:
        read.kind === 'corrupt' ? 'marker_corrupt' : 'marker_unreadable',
    };
  }

  // `absent`, and only `absent`, may create a marker.
  const marker: IdentityMarker = {
    version: IDENTITY_MARKER_VERSION,
    initialized_at: Date.now(),
    sub_prefix: userId ? userId.slice(0, 8) : null,
    migrated_from_legacy: opts.migratedFromLegacy === true,
    // Absent rather than `undefined`: `exactOptionalPropertyTypes` forbids
    // assigning undefined to an optional field, and an absent key is also
    // what every pre-G-R1 marker looks like.
    ...(userId ? { user_id: userId } : {}),
  };
  try {
    await AsyncStorage.setItem(IDENTITY_KEY, JSON.stringify(marker));
  } catch (err) {
    console.log('GC_IDENTITY_MARK_FAILED', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { persisted: false, marker, reason: 'write_failed' };
  }
  return { persisted: true, marker, source: 'created' };
}

export type AnchorBackfillResult =
  | { anchored: true; source: 'already_present' | 'written' }
  | {
      anchored: false;
      reason:
        | 'no_marker'
        /** `getItem` threw: no bytes observed. */
        | 'marker_unreadable'
        /** Bytes observed that are not a valid marker — `user_id` present
         *  but invalid among them. Never overwritten. */
        | 'marker_corrupt'
        | 'migrated_from_legacy'
        | 'no_session_id'
        | 'recovery_entry_exists'
        | 'write_failed';
    };

/**
 * G-R1 — gives an existing marker its anchor, once, and only where that is
 * demonstrably safe.
 *
 * The justification, because "a live session must be the historical one" is
 * NOT true in general and must not be assumed: it is true exactly while no
 * route other than the first anonymous mint can produce a session. Today
 * none can — `IDENTITY_DEGRADED` refuses to mint and nothing else signs in —
 * so a device presenting a valid marker AND a live session is presenting the
 * identity that has been operating all along.
 *
 * Every state where that argument fails is refused instead:
 *
 *   no marker            nothing to augment; creation handles that case
 *   unreadable           the slot could not be read at all; no bytes were
 *                        observed, so nothing here is known
 *   corrupt              "an identity existed, we cannot say which" — writing
 *                        an anchor here would invent the answer. A `user_id`
 *                        that is PRESENT BUT INVALID lands here too, decided
 *                        by `readIdentityMarkerState`: present-but-invalid is
 *                        not absent, so it is not eligible and not
 *                        overwritable
 *   migrated_from_legacy the probe INFERRED the identity from traces and
 *                        recorded `sub_prefix: null` precisely because it did
 *                        not know which one. A later session does not prove
 *                        it is the same one
 *   no session id        nothing to anchor to
 *   recovery exists      the live session may BE the unverified candidate
 *
 * STRICTLY ADDITIVE: it writes `user_id` and copies every other field
 * verbatim. `initialized_at`, `sub_prefix` and `migrated_from_legacy` keep
 * their meaning and their values, so the marker's immutability survives
 * except for the field that did not exist before.
 *
 * FAIL CLOSED: a failed write leaves the device without an anchor, which the
 * gate reads as not verifiable. It never throws — the capture path must not
 * acquire a new way to break.
 */
export async function backfillIdentityAnchor(
  sessionUserId: string | null,
): Promise<AnchorBackfillResult> {
  if (RECOVERY_ENTRY_IMPLEMENTED) {
    return { anchored: false, reason: 'recovery_entry_exists' };
  }
  if (!sessionUserId) return { anchored: false, reason: 'no_session_id' };

  const read = await readIdentityMarkerState();
  if (read.kind === 'absent') return { anchored: false, reason: 'no_marker' };
  if (read.kind === 'unreadable') {
    return { anchored: false, reason: 'marker_unreadable' };
  }
  if (read.kind === 'corrupt') {
    return { anchored: false, reason: 'marker_corrupt' };
  }

  const marker = read.marker;
  // WRITE-ONCE. An anchor that disagrees with this session is NOT corrected
  // here; the gate refuses the session instead.
  //
  // GC-AUTH-ANCHOR-MALFORMED-001 — this test is now exactly right without
  // changing a character of it, because `present` guarantees the anchor is
  // either an absent PROPERTY or a non-empty string. So `true` means
  // genuinely anchored (and `anchored: true` is honest), while `false` can
  // only mean the property is absent, i.e. a valid pre-G-R1 marker. An
  // invalid value never reaches here: it is `corrupt` above.
  if (typeof marker.user_id === 'string' && marker.user_id.length > 0) {
    return { anchored: true, source: 'already_present' };
  }
  if (marker.migrated_from_legacy === true) {
    return { anchored: false, reason: 'migrated_from_legacy' };
  }

  const next: IdentityMarker = { ...marker, user_id: sessionUserId };
  try {
    await AsyncStorage.setItem(IDENTITY_KEY, JSON.stringify(next));
  } catch (err) {
    console.log('GC_IDENTITY_ANCHOR_BACKFILL_FAILED', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { anchored: false, reason: 'write_failed' };
  }
  console.log('GC_IDENTITY_ANCHOR_BACKFILLED', {
    sub_prefix: sessionUserId.slice(0, 8),
  });
  return { anchored: true, source: 'written' };
}

export type ContinuityCheck =
  | { ok: true }
  | { ok: false; reason: 'unverifiable' | 'mismatch' };

/**
 * G-R1 — the continuity POLICY, in one place.
 *
 * Answers one question: may this session act for the identity this device
 * historically held? `getOwnershipToken` is the authority that acts on the
 * answer; this function is the only thing that decides it.
 *
 * `sub_prefix` is deliberately not consulted. A matching prefix cannot
 * rescue a mismatching `user_id`, and a mismatching prefix cannot condemn a
 * matching one: the anchor is the authority and the prefix is a comment.
 */
export async function checkIdentityContinuity(
  sessionUserId: string | null,
): Promise<ContinuityCheck> {
  if (!sessionUserId) return { ok: false, reason: 'unverifiable' };

  const read = await readIdentityMarkerState();
  if (read.kind !== 'present') return { ok: false, reason: 'unverifiable' };

  const anchor = read.marker.user_id;
  if (typeof anchor !== 'string' || anchor.length === 0) {
    return { ok: false, reason: 'unverifiable' };
  }
  return anchor === sessionUserId ? { ok: true } : { ok: false, reason: 'mismatch' };
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
 * The inference was an implication of the code, not a heuristic:
 * `startRecording` refused to begin without a token, so ANY durable trace
 * of a recording proved a token, and therefore an identity, once existed
 * here. That gate (`TOKEN_MISSING_AT_START`) is present continuously from
 * `22d3f5e` through `45357c4`, in every release tag, and covers audio and
 * native video through one unified check.
 *
 * GC-AUTH-MIGRATION-001 — THE IMPLICATION IS NOW BOUNDED IN TIME. Commit
 * `8615ba6` (local-first capture while identity is degraded) removed that
 * gate, so from that commit onwards all four signals below can be written
 * with no identity whatsoever. The probe answers a question that is only
 * true on one side of that line.
 *
 * This is why the probe is no longer allowed to run whenever it feels
 * like it. `resolveIdentityInitialized` asks it EXACTLY ONCE per install
 * and seals the answer — positive or negative — in `gc.legacy_probe.v1`.
 * The first evaluation of that seal IS the migration boundary: every
 * trace present at that instant was necessarily written by a gated build.
 *
 * RELEASE INVARIANT, NOT A SUGGESTION:
 *
 *   `8615ba6` MUST NOT ship in any build that does not also contain
 *   GC-AUTH-MIGRATION-001 and the seal.
 *
 * The boundary proof is conditional on that. Ship local-first capture
 * without the seal and installs start accumulating in the ambiguous
 * window, where a device that never had an identity is indistinguishable
 * from one that had it and lost it — permanently, from local state alone.
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
 * PROOF-GRADE evidence that an identity once existed on this device.
 *
 * GC-AUTH-MIGRATION-001 / R4 — this is NOT the legacy probe and must never
 * be confused with it. The probe asks a weak, historical question and its
 * signals stopped implying identity at `8615ba6`. This asks a strong one
 * with a one-way answer:
 *
 *   TRUE  ⇒ an identity existed here. `uploadChunkBytes` throws NO_TOKEN
 *           without a token, and `session_completed` is only set after an
 *           authorized completion, so neither state is reachable without
 *           an authenticated call having succeeded.
 *   FALSE ⇒ nothing is known. Chunks are deleted once uploaded, so an
 *           absence proves nothing at all.
 *
 * Only the TRUE direction is ever used, and only to REFUSE minting. Using
 * the false direction to permit anything would be the original defect
 * wearing a new hat.
 *
 * Why it cannot resurrect the defect: a local-first capture under 4C
 * produces chunks with `status: 'pending'` and no `remote_reference`
 * whatsoever — measured on hardware, 0 of 43 — so a device that never had
 * an identity can never satisfy this predicate.
 *
 * Why it exists: the protection against a second mint must not depend on
 * a write succeeding. If `gc.identity.v1` could not be persisted AND the
 * stale negative seal could not be removed, both defences are gone, and
 * the only thing left is evidence that the upload path itself already
 * wrote. That is exactly the evidence that establishes the ownership at
 * risk, so where there is something to lose, there is something to read.
 */
export async function hasProvenIdentityEvidence(): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem('test.pending_retry');
  } catch {
    // Cannot find out. Callers treat this as "no proof", which only ever
    // means "fall through to the seal" — never "mint".
    return false;
  }
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    for (const entry of parsed as Array<Record<string, unknown>>) {
      if (entry?.session_completed === true) return true;
      const chunks = entry?.chunks;
      if (!Array.isArray(chunks)) continue;
      for (const chunk of chunks as Array<Record<string, unknown>>) {
        if (
          isChunkConfirmedOffDevice({
            status: String(chunk?.status ?? ''),
            remote_reference: chunk?.remote_reference as
              | string
              | null
              | undefined,
          })
        ) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Reads the sealed migration answer.
 *
 * A seal from a DIFFERENT `probe_version` is reported as absent rather
 * than reinterpreted: its `legacy_identity_evidence` was produced by a
 * signal set whose meaning this build does not know. Re-asking is the
 * honest response, and it is safe — see `resolveIdentityInitialized` for
 * why a re-ask can never mint over an identity.
 *
 * Malformed, unreadable and version-mismatched all collapse to `null`
 * here. That is deliberate, and it is allowed because every one of those
 * outcomes leads to the same conservative action: ask the probe again.
 *
 * This docstring used to claim it was "the ONLY place in this module where
 * a collapse like that is allowed". That was already false when it was
 * written — `readIdentityMarker` collapses the same way 400 lines above —
 * and GC-AUTH-ANCHOR-MALFORMED-001 is what the contradiction was hiding:
 * the collapse up there fed a WRITE decision, where the outcomes do NOT
 * lead to the same action, and an unreadable marker got replaced. The
 * difference is not the collapse, it is what the caller does with it.
 * Here the answer is "re-ask", which is safe for all of them. There it
 * was "write", which was not.
 */
export async function readLegacyProbeSeal(): Promise<LegacyProbeSeal | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(LEGACY_PROBE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as LegacyProbeSeal).version === 1 &&
      (parsed as LegacyProbeSeal).probe_version === LEGACY_PROBE_VERSION &&
      typeof (parsed as LegacyProbeSeal).legacy_identity_evidence === 'boolean'
    ) {
      return parsed as LegacyProbeSeal;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Seals the migration answer. Overwrites on purpose — unlike the identity
 * marker, this record is the answer THIS build's probe generation gave,
 * so a re-ask (corrupt seal, bumped `probe_version`) must be allowed to
 * replace it. Otherwise a single corrupt byte would make the install
 * re-probe on every boot forever.
 *
 * NEVER THROWS into the bootstrap, but the caller is told whether the
 * write landed. A negative verdict that is not on disk must not open the
 * minting gate — see `decideIdentityState`'s `boundaryUnsealed` input.
 */
export async function writeLegacyProbeSeal(
  legacyIdentityEvidence: boolean,
): Promise<{ seal: LegacyProbeSeal; persisted: boolean }> {
  const seal: LegacyProbeSeal = {
    version: 1,
    probe_version: LEGACY_PROBE_VERSION,
    evaluated_at: Date.now(),
    legacy_identity_evidence: legacyIdentityEvidence,
  };
  try {
    await AsyncStorage.setItem(LEGACY_PROBE_KEY, JSON.stringify(seal));
  } catch (err) {
    console.log('GC_LEGACY_PROBE_SEAL_FAILED', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { seal, persisted: false };
  }
  return { seal, persisted: true };
}

/**
 * Drops the sealed migration answer so the boundary is decided again on
 * the next boot.
 *
 * GC-AUTH-MIGRATION-001 — used for exactly one situation: an identity was
 * established (minted or observed) but `gc.identity.v1` could not be
 * persisted. A durable `legacy_identity_evidence: false` sitting next to
 * an absent marker is the precise shape that mints a second identity, so
 * once we know the marker is missing for a device that DOES have an
 * identity, that seal has to stop being trusted.
 *
 * Removing it is strictly safer than leaving it: the next boot re-runs
 * the probe, and any trace the established identity left behind — a queue
 * entry, a history row — makes the probe answer "yes", which yields
 * IDENTITY_DEGRADED and preserves ownership. On a device that truly left
 * no trace the probe answers "no" again and re-seals; nothing is lost.
 */
export async function invalidateLegacyProbeSeal(): Promise<boolean> {
  try {
    await AsyncStorage.removeItem(LEGACY_PROBE_KEY);
    return true;
  } catch (err) {
    console.log('GC_LEGACY_PROBE_SEAL_INVALIDATE_FAILED', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // R5-K — a delete and a write are different operations against the same
  // store, and one can fail while the other succeeds. Since leaving an
  // actionable negative seal next to an absent marker is the shape that
  // mints a replacement identity, try the second door before giving up:
  // stamp a seal this build cannot act on. `readLegacyProbeSeal` refuses
  // any `probe_version` it does not recognise, so the boundary is simply
  // re-decided on the next boot — and by then the capture traces an
  // established identity left behind make the probe answer "yes", which
  // yields IDENTITY_DEGRADED and keeps ownership.
  try {
    await AsyncStorage.setItem(
      LEGACY_PROBE_KEY,
      JSON.stringify({
        version: 1,
        probe_version: -1,
        evaluated_at: Date.now(),
        legacy_identity_evidence: false,
      }),
    );
    console.log('GC_LEGACY_PROBE_SEAL_POISONED');
    return true;
  } catch (err) {
    console.log('GC_LEGACY_PROBE_SEAL_POISON_FAILED', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Where `initialized` came from. Diagnostics — the decision is the same
 *  regardless, but telling these apart in a log is the difference between
 *  reading a boot trace and guessing at one. */
export type IdentityInitializedSource =
  /** A well-formed marker. The authority. */
  | 'marker'
  /**
   * Bytes in the marker slot that are not a valid marker. Conservative:
   * an identity existed here and we cannot say which, so minting stays
   * shut. GC-AUTH-ANCHOR-MALFORMED-001 split this from `marker_unreadable`.
   */
  | 'marker_corrupt'
  /**
   * The marker slot could not be read at all. Same conservative answer,
   * different fact: no bytes were observed, and the next read may work.
   */
  | 'marker_unreadable'
  /** No marker; a sealed migration answer decided it. */
  | 'seal'
  /**
   * No marker and a NEGATIVE seal, overridden because the device still
   * holds proof that an identity once existed here — a chunk confirmed
   * off-device, or a completed session. Refuses to mint. R4.
   */
  | 'proven_identity'
  /** No marker and no usable seal; the probe ran and the answer was sealed. */
  | 'probe';

/**
 * Resolves `initialized` for the state machine.
 *
 * GC-AUTH-MIGRATION-001 — the defect this ordering fixes:
 *
 * The previous implementation sealed only the POSITIVE verdict. When the
 * probe found nothing it returned `initialized: false` and wrote nothing
 * at all, so the probe re-ran on every subsequent boot, waiting for
 * something to appear. Local-first capture (`8615ba6`) then made
 * something appear: a device whose very first mint failed would record,
 * produce a queue entry and a history row, and the NEXT boot would read
 * its own capture traces as proof of an identity it never had — writing
 * `migrated_from_legacy: true`, entering IDENTITY_DEGRADED, and closing
 * the only minting gate permanently. Demonstrated on hardware.
 *
 * The asymmetry was the whole bug. Both verdicts are sealed now.
 *
 * Precedence, and why each step is where it is:
 *
 *   1. Marker present    → an identity was established. The authority.
 *   2. Corrupt or        → something wrote a marker once, or we could not
 *      unreadable          find out. Either way, refuse to mint. Checked
 *                          BEFORE the seal so a sealed negative can never
 *                          wave a rotted marker through.
 *   3. Seal usable       → the migration question is already answered.
 *                          The probe is never consulted again.
 *   4. Otherwise         → ask the probe, seal the answer immediately.
 *
 * On a re-ask (step 4 reached because the seal was corrupt or written by
 * another `probe_version`) the worst case is a false positive, which
 * yields IDENTITY_DEGRADED — evidence intact, ownership intact, no mint.
 * A re-ask can never abandon an identity, only decline to mint one.
 */
export interface IdentityResolution {
  initialized: boolean;
  fromLegacyProbe: boolean;
  marker: IdentityMarker | null;
  source: IdentityInitializedSource;
  /**
   * The probe answered "no prior identity" and the seal did NOT persist.
   * Feed this straight into `decideIdentityState`: it closes the minting
   * gate for this boot.
   */
  boundaryUnsealed: boolean;
}

/**
 * Single-flight latch.
 *
 * GC-AUTH-MIGRATION-001 — the bootstrap effect and `startRecording` both
 * need the boundary resolved, and whoever arrives first must do the work
 * while the other joins the SAME execution. Two concurrent probes could
 * otherwise interleave their reads and writes around the seal.
 *
 * Only the in-flight promise is memoised, never the result: each boot is
 * a fresh question, and caching the answer across a process would hide
 * exactly the state changes these tests need to observe.
 */
let inFlightResolution: Promise<IdentityResolution> | null = null;

export async function resolveIdentityInitialized(): Promise<IdentityResolution> {
  if (inFlightResolution) return inFlightResolution;
  const run = resolveIdentityInitializedUncached();
  inFlightResolution = run;
  try {
    return await run;
  } finally {
    inFlightResolution = null;
  }
}

/**
 * Blocks until the migration boundary is decided, and — when the answer
 * was a negative that failed to persist — tries once more to make it
 * durable.
 *
 * GC-AUTH-MIGRATION-001 — this is what the capture path awaits before its
 * FIRST durable side effect. `startRecording` writes a queue entry, a
 * history row, a pending registration and a last-session id, and all four
 * are signals the legacy probe reads. If any of them can land before the
 * boundary is decided, a fresh install can manufacture its own false
 * "prior identity" — which is the defect.
 *
 * It waits on LOCAL storage only. No network, no session, no token. The
 * user may tap GRABAR the instant the screen paints; the cost here is the
 * few milliseconds AsyncStorage needs, and by then the bootstrap has
 * usually resolved it already and this just joins the settled promise.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: refuse the capture. If the seal
 * still cannot be persisted after the retry, we record that and let the
 * recording start anyway. Evidence survival outranks migration hygiene.
 *
 * So state the property precisely, because the loose version is not true:
 *
 *   Before a local-first capture creates a legacy signal,
 *   migration-boundary RESOLUTION HAS RUN. If the negative verdict cannot
 *   be made durable, capture may proceed — and the minting gate stays
 *   closed.
 *
 * NOT "the boundary is durably decided". It is decided in memory; whether
 * that decision reached disk is reported by `sealed`, and when it did not,
 * `boundaryUnsealed` is what keeps FIRST_IDENTITY shut.
 */
export async function ensureMigrationBoundary(): Promise<{ sealed: boolean }> {
  const resolution = await resolveIdentityInitialized();
  if (!resolution.boundaryUnsealed) return { sealed: true };

  const retry = await writeLegacyProbeSeal(false);
  if (!retry.persisted) {
    console.log('GC_LEGACY_PROBE_BOUNDARY_UNSEALED', {
      note: 'capture proceeding; minting stays closed until the seal lands',
    });
  }
  return { sealed: retry.persisted };
}

async function resolveIdentityInitializedUncached(): Promise<IdentityResolution> {
  const read = await readIdentityMarkerState();
  if (read.kind === 'present') {
    return {
      initialized: true,
      fromLegacyProbe: false,
      marker: read.marker,
      source: 'marker',
      boundaryUnsealed: false,
    };
  }
  if (read.kind === 'corrupt' || read.kind === 'unreadable') {
    // Conservative on purpose, and identically for both. We cannot say
    // WHICH identity this was, and we will not mint a replacement to make
    // the unknown go away. `initialized: true` is what keeps
    // FIRST_IDENTITY — and therefore `signInAnonymously()` — shut.
    return {
      initialized: true,
      fromLegacyProbe: false,
      marker: null,
      source:
        read.kind === 'corrupt' ? 'marker_corrupt' : 'marker_unreadable',
      boundaryUnsealed: false,
    };
  }

  const seal = await readLegacyProbeSeal();
  if (seal) {
    if (seal.legacy_identity_evidence) {
      return {
        initialized: true,
        fromLegacyProbe: false,
        marker: null,
        source: 'seal',
        boundaryUnsealed: false,
      };
    }
    // R4 — the seal says "no prior identity", and normally that is the
    // end of it. But this exact shape (negative seal + absent marker + no
    // session) is the one that mints a SECOND identity, and it is
    // reachable without any prior identity ever existing OR with one that
    // simply could not be written down: mint succeeds, the marker write
    // fails, and the removal of this now-stale seal fails too. Two failed
    // writes and the device forgets who it is.
    //
    // So before acting on a negative, ask the one question whose positive
    // answer cannot be faked by a local-first capture. It needs no write
    // to have succeeded — the upload path already wrote it.
    if (await hasProvenIdentityEvidence()) {
      return {
        initialized: true,
        fromLegacyProbe: false,
        marker: null,
        source: 'proven_identity',
        boundaryUnsealed: false,
      };
    }
    return {
      initialized: false,
      fromLegacyProbe: false,
      marker: null,
      source: 'seal',
      boundaryUnsealed: false,
    };
  }

  // The migration boundary. Everything present right now was written by a
  // build that required a token, so the probe's implication holds — but
  // only at this instant, which is why the answer is sealed before
  // anything else can run.
  const legacy = await probeLegacyIdentity();
  const sealWrite = await writeLegacyProbeSeal(legacy);

  if (!legacy) {
    // FAIL CLOSED. `initialized` stays honest — the probe really did find
    // nothing — but `boundaryUnsealed` withholds the minting gate until
    // that finding is on disk. Acting on a verdict we could not record is
    // how GC-AUTH-MIGRATION-001 reproduces: mint fails, capture writes
    // traces, restart re-probes, traces read as a prior identity, walled
    // off forever. The seal is retried by `ensureMigrationBoundary` and,
    // failing that, by the next boot.
    return {
      initialized: false,
      fromLegacyProbe: false,
      marker: null,
      source: 'probe',
      boundaryUnsealed: !sealWrite.persisted,
    };
  }

  // Durable evidence of a prior identity, but no marker: this install
  // predates the marker. Stamp it now so the probe never has to run
  // again, and so the state survives even if the evidence keys are later
  // trimmed. `sub_prefix` is null — we genuinely do not know which
  // identity it was, and guessing would be worse than admitting it.
  const written = await markIdentityInitialized(null, {
    migratedFromLegacy: true,
  });
  return {
    initialized: true,
    fromLegacyProbe: true,
    marker: written.marker,
    source: 'probe',
    // A positive verdict never opens the gate, so an unpersisted seal
    // cannot cause harm here: the next boot re-probes the same traces and
    // reaches the same answer.
    boundaryUnsealed: false,
  };
}
