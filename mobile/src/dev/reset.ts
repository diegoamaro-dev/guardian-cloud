/** DEV-only hard reset. Removes Guardian Cloud volatile testing keys and
 *  recreates documentDirectory and cacheDirectory. Preserves Supabase auth
 *  tokens (so the user stays signed in) and Drive config (server-side, not
 *  in AsyncStorage). Caller must ensure no recording is in flight.
 *  Best-effort: per-step failures are logged and execution continues. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
// GC-DEV-RESET-001 — THE definition of "this fragment is outside the
// device", shared with the export gate, the finalize gate and the home
// banner. Leaf module with no imports of its own, so this cannot form a
// cycle. Reused rather than restated: a second definition of "protected"
// is a second thing to get wrong.
import { isChunkConfirmedOffDevice } from '@/recording/deriveGuardianStatus';
// GC-DEV-RESET-001 (second gap) — THE canonical definition of "a file on
// disk that recovery still treats as evidence". This guard does NOT get
// its own idea of what an orphan is: the `guardian_recording_*` prefix,
// the extension set and the oversize rule are declared once, in the
// module whose whole purpose is finding them. Leaf module (FileSystem +
// AsyncStorage only), read-only by contract, so no cycle and no effects.
import { scanOrphans } from '@/recording/orphanScan';
// GC-DEV-RESET-001 (third gap) — the check and the delete must be atomic
// with respect to capture starts. Zero-import leaf, so no cycle.
import {
  acquireDestructiveExclusion,
  releaseDestructiveExclusion,
} from '@/recording/evidenceExclusion';
// The ONLY thing that authorizes deleting a completed session's local
// evidence. Zero imports of its own, so no cycle. Constants and the
// entry validator are reused rather than restated, for the same reason.
import {
  SESSION_CLEANUP_KEY,
  SESSION_CLEANUP_VERSION,
  isValidJournalEntry,
  type JournalDocument,
} from '@/video/sessionCleanupJournal';

// Mirrors literals defined in:
//   mobile/app/index.tsx       PENDING_RETRY_KEY      'test.pending_retry'
//   mobile/app/index.tsx       LAST_SESSION_ID_KEY    'export.last_session_id'
//   mobile/src/api/history.ts  HISTORY_KEY            'history.sessions'
// Anything else in AsyncStorage (notably the Supabase `sb-*-auth-token`
// entries) is left untouched.
//
// DELIBERATELY ABSENT: `gc.identity.v1` (see src/auth/identityMarker.ts).
// This reset preserves the Supabase session on purpose, so it is not an
// identity reset — and the marker records a historical fact ("an identity
// has existed on this device") that wiping volatile state does not undo.
// Adding it here would mean a reset followed by a lost session mints a
// fresh anonymous user and silently orphans everything already uploaded,
// which is exactly the GC-AUTH-001 failure. Leave it out.
//
// ALSO DELIBERATELY ABSENT: `gc.legacy_probe.v1` (GC-AUTH-MIGRATION-001).
// Same reasoning, one step removed. The seal records the answer to a
// historical migration question — "did this install carry traces of an
// identity older than the migration boundary?" — and this reset is not a
// migration. Worse, it deletes three of the four signals the probe reads
// (they are the volatile keys below), so clearing the seal here would
// re-ask the question against a store this function just emptied and
// re-seal a negative that was never true.
//
// WHAT THIS MEANS FOR TESTING, AND IT MATTERS:
//
//   This reset does NOT produce a fresh install, and must never be used
//   to claim one. It leaves behind the marker, the seal and the Supabase
//   session. A "fresh install" run on hardware is `pm clear` (or an
//   uninstall) — nothing else. Even that is only fresh on the device:
//   the anonymous user still exists server-side.
//
//   Migration states (traces without a marker, a marker without a seal,
//   a corrupt seal) are constructed in the test fixtures, not by this
//   function. Do not grow a dev tool for them here.
//
// GC-DEV-RESET-001 — `guardian.pending_session_registrations` is listed
// here because this reset removes the queue, and a pending registration
// can only ever point at a session that HAD a queue entry (4A writes the
// entry before anything else). Leaving them behind after an authorised
// reset produces phantom registrations: the replay loop would keep
// retrying `POST /sessions` for sessions that no longer exist anywhere.
// That is the incoherence this key's absence used to create.
const VOLATILE_KEYS = [
  'test.pending_retry',
  'export.last_session_id',
  'history.sessions',
  'guardian.pending_session_registrations',
];

// DELIBERATELY NOT VOLATILE — decided by semantics, not by tidiness:
//
//   gc.pause.global.v1
//     A pause records a real condition observed against the backend
//     (a dead session, an unconnected destination, a config defect).
//     Clearing it here would FAKE a recovery, which is precisely what
//     GC-DEST-PAUSE-001 forbids: only positive proof that the cause is
//     gone may retire a pause. A dev reset is not proof of anything.
//
//   guardian.segment_cleanup.v1
//     Each entry is a durable record that the BACKEND authorised
//     deleting a session's local evidence. Dropping it would discard the
//     memory of an authorisation we were granted. The cleanup runner is
//     idempotent and drops its own entries once the resources are gone,
//     so a stale entry after a reset is self-healing and costs nothing.
//
//   guardian.preferred_destination, guardian.quick_start,
//   gc.reliability.dismissed_at, guardian.beta_welcome_seen
//     User preferences. Not state, not evidence.

/** Why a destructive dev tool refused to run. */
export interface ResetRefusal {
  ok: false;
  reason:
    // ── GC_QUEUE ──────────────────────────────────────────────────────
    /** At least one chunk is not provably outside the device. */
    | 'pending_evidence'
    /** An entry we cannot prove is safe to discard. See below. */
    | 'undecidable_entry'
    /** The queue could not be read or parsed at all. */
    | 'unreadable_queue'
    // ── local filesystem, OUTSIDE GC_QUEUE ────────────────────────────
    /** `guardian_recording_*` files a recovery route would still adopt. */
    | 'local_orphan_evidence'
    /** `segments/<sid>/` with no durable cleanup authorization. */
    | 'unauthorized_segments'
    /** documentDirectory could not be listed. Unknown ≠ empty. */
    | 'unreadable_filesystem'
    /** The cleanup journal exists but cannot be interpreted. */
    | 'unreadable_journal'
    // ── concurrency ───────────────────────────────────────────────────
    /** A capture is starting, or another destructive op is in flight. */
    | 'producer_active';
  /** Queue entries blocking the operation. 0 for filesystem reasons. */
  sessions: number;
  /** Chunks not provably outside the device. 0 unless `pending_evidence`. */
  unconfirmed_chunks: number;
  /** Local files/directories outside GC_QUEUE that still hold evidence. */
  local_artifacts: number;
  /** Subset of `local_artifacts` the scanner classed `oversized`. */
  oversized_artifacts: number;
}
export type ResetOutcome = { ok: true } | ResetRefusal;

function refuse(
  reason: ResetRefusal['reason'],
  detail: Partial<Omit<ResetRefusal, 'ok' | 'reason'>> = {},
): ResetRefusal {
  return {
    ok: false,
    reason,
    sessions: 0,
    unconfirmed_chunks: 0,
    local_artifacts: 0,
    oversized_artifacts: 0,
    ...detail,
  };
}

/**
 * The refusal every destructive tool returns when it cannot obtain
 * exclusion. Exported so `clearGuardianQueueDev` reports the same shape
 * from the same source rather than assembling its own.
 */
export function producerActiveRefusal(): ResetRefusal {
  return refuse('producer_active');
}

/** Plain-language reason, so no screen has to restate the taxonomy. */
export function describeResetRefusal(r: ResetRefusal): string {
  switch (r.reason) {
    case 'pending_evidence':
      return (
        `Hay ${r.unconfirmed_chunks} fragmentos sin subir en ` +
        `${r.sessions} grabación(es). Súbelos antes de resetear.`
      );
    case 'undecidable_entry':
      return (
        `Hay ${r.sessions} grabación(es) cuyo contenido no se puede dar ` +
        `por subido. No se borra nada.`
      );
    case 'unreadable_queue':
      return 'No se puede leer la cola. Por seguridad no se borra nada.';
    case 'local_orphan_evidence':
      return (
        `Quedan ${r.local_artifacts} grabación(es) en el almacenamiento ` +
        `local pendientes de recuperar. No se borra nada.`
      );
    case 'unauthorized_segments':
      return (
        `Quedan segmentos de ${r.local_artifacts} grabación(es) sin ` +
        `confirmación del servidor. No se borra nada.`
      );
    case 'unreadable_filesystem':
      return 'No se puede leer el almacenamiento local. No se borra nada.';
    case 'unreadable_journal':
      return 'No se puede leer el registro de limpieza. No se borra nada.';
    case 'producer_active':
      return 'Hay una captura iniciándose o un reset en curso. No se borra nada.';
  }
}

/**
 * GC-DEV-RESET-001 — the GC_QUEUE half of the protection policy. It is
 * the whole answer for a tool that only drops queue references
 * (`clearGuardianQueueDev`); a tool that deletes FILES needs
 * `inspectResetSafety`, which adds the filesystem half.
 *
 * On 2026-08-21 a manual action on a dev reset destroyed 54 chunks and
 * 1 776 751 bytes of audio whose `remote_reference` was 0 of 54 — none of
 * it had ever left the device. There was no guard of any kind: the only
 * check was "not while recording".
 *
 * ## The rule is POSITIVE PROOF, not chunk counting
 *
 * An entry may be discarded ONLY when we can prove it holds no local
 * evidence worth keeping. Anything we cannot prove safe, blocks.
 *
 * Proof of safety is exactly one shape: a NON-EMPTY `chunks` array in
 * which every chunk satisfies `isChunkConfirmedOffDevice` — uploaded AND
 * carrying a real `remote_reference`. Same predicate the export gate, the
 * finalize gate and the home banner use.
 *
 * ## Why zero chunks BLOCKS
 *
 * An earlier version of this guard reasoned "no chunks ⇒ no bytes ⇒ safe".
 * That is false in this codebase, and `tryFinalizeReadySessions` already
 * says so in as many words: "the empty set is fully uploaded" is true
 * arithmetic and a catastrophic operational rule. EVERY capture is born
 * with `chunks: []`, written durably by 4A before the chunker has emitted
 * anything:
 *
 *   audio / legacy video   uri = the real cacheDirectory recording
 *   native segmented video uri = '' — the segments live on disk under
 *                          files/segments/{id}/ and are adopted as chunks
 *                          later
 *
 * So `uri` cannot be the discriminator either: native video legitimately
 * carries an empty one while real bytes already exist. A zero-chunk entry
 * is proof of nothing at all, and the bytes it points at may be a capture
 * the chunker had not reached yet — after a kill, after a chunker failure,
 * after a capture too short to emit, or simply during recording.
 *
 * ## What blocks
 *
 *   - any chunk not confirmed off-device        → pending_evidence
 *   - zero chunks, for any reason               → undecidable_entry
 *   - `chunks` missing or not an array          → undecidable_entry
 *   - an entry that is not an object            → undecidable_entry
 *   - the queue unreadable or not an array      → unreadable_queue
 *
 * A genuinely empty queue (`[]`) clears THIS check: there is no entry to
 * be wrong about. It does NOT authorise deleting files — evidence
 * survives outside the queue on purpose. See `inspectLocalArtifacts`.
 *
 * Returns `null` only when the queue itself is provably safe.
 */
export async function inspectPendingEvidence(): Promise<ResetRefusal | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem('test.pending_retry');
  } catch {
    // Cannot find out ⇒ refuse. Same principle as the identity layer:
    // "I do not know" is never treated as "there is nothing".
    return refuse('unreadable_queue');
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse('unreadable_queue');
  }
  if (!Array.isArray(parsed)) {
    return refuse('unreadable_queue');
  }

  let blocking = 0;
  let unconfirmed = 0;
  let undecidable = 0;
  for (const entry of parsed as unknown[]) {
    // An entry we cannot even read is not an entry we may delete.
    if (typeof entry !== 'object' || entry === null) {
      blocking += 1;
      undecidable += 1;
      continue;
    }
    const chunks = (entry as Record<string, unknown>).chunks;
    // Missing / malformed `chunks` must NOT degrade to `[]`. Silently
    // treating a broken entry as empty is how a real capture gets
    // deleted for looking tidy.
    if (!Array.isArray(chunks) || chunks.length === 0) {
      blocking += 1;
      undecidable += 1;
      continue;
    }
    const bad = (chunks as Array<Record<string, unknown>>).filter(
      (c) =>
        typeof c !== 'object' ||
        c === null ||
        !isChunkConfirmedOffDevice({
          status: String(c?.status ?? ''),
          remote_reference: c?.remote_reference as string | null | undefined,
        }),
    ).length;
    if (bad > 0) {
      blocking += 1;
      unconfirmed += bad;
    }
  }

  if (blocking === 0) return null;
  return refuse(unconfirmed > 0 ? 'pending_evidence' : 'undecidable_entry', {
    sessions: blocking,
    unconfirmed_chunks: unconfirmed,
  });
}

/**
 * Session ids the backend has authorized us to clean locally, or `null`
 * when that cannot be determined.
 *
 * Mirrors the journal's own doctrine, which is stated at the top of
 * `sessionCleanupJournal.ts` and is not negotiable here: A DOCUMENT IS
 * EITHER FULLY VALID OR UNUSABLE. One malformed entry makes the whole
 * journal unreadable — repairing it in place would mean guessing which
 * authorizations were real, and this caller is about to delete files on
 * the strength of the answer.
 *
 * An ABSENT journal is not an error: it means no authorization has ever
 * been granted, which is an empty set, and every segment directory then
 * blocks. That is the correct reading.
 */
async function readCleanupAuthorizations(): Promise<Set<string> | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(SESSION_CLEANUP_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === '') return new Set();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const doc = parsed as Partial<JournalDocument>;
  if (doc.version !== SESSION_CLEANUP_VERSION) return null;
  if (!Array.isArray(doc.entries)) return null;

  const authorized = new Set<string>();
  for (const entry of doc.entries) {
    if (!isValidJournalEntry(entry)) return null;
    authorized.add(entry.session_id);
  }
  return authorized;
}

/**
 * `documentDirectory/segments/<sid>/` — the verified stable copies of
 * native video segments.
 *
 * These exist SPECIFICALLY to outlive the queue entry: `segmentAdopter`
 * puts them outside `chunks/<sid>/` so the evidence can still be hashed
 * after the session completes and the entry is reaped. So "no queue
 * entry" says nothing at all about them, and neither does an empty
 * directory — the journal's own words: not age, not absence from
 * GC_QUEUE, not an empty directory, ever counts.
 *
 * The one thing that counts is a durable cleanup authorization, which
 * only a real backend 200/409 can produce.
 */
async function inspectStableSegments(docDir: string): Promise<ResetRefusal | null> {
  const root = `${docDir}segments/`;
  let sessionDirs: string[];
  try {
    const info = await FileSystem.getInfoAsync(root);
    if (!info.exists) return null;
    sessionDirs = await FileSystem.readDirectoryAsync(root);
  } catch {
    return refuse('unreadable_filesystem');
  }
  if (sessionDirs.length === 0) return null;

  const authorized = await readCleanupAuthorizations();
  if (authorized === null) return refuse('unreadable_journal');

  const unauthorized = sessionDirs.filter((sid) => !authorized.has(sid));
  if (unauthorized.length > 0) {
    return refuse('unauthorized_segments', { local_artifacts: unauthorized.length });
  }
  return null;
}

/**
 * GC-DEV-RESET-001 (second gap) — evidence that lives OUTSIDE GC_QUEUE.
 *
 * `hardResetAppState` deletes `documentDirectory` wholesale, and an
 * empty queue is NOT proof that the directory holds nothing. The product
 * has a route that produces exactly that state on purpose:
 *
 *   `abandonUnregisteredSession` moves the capture to
 *   `documentDirectory/guardian_recording_*` and THEN drops the queue
 *   entry — in that order, so a process death errs towards a redundant
 *   reference rather than none. The promotion exists so `orphanScan` can
 *   still recover the bytes once no queue entry refers to them.
 *
 * So `queue === []` + a real `.aac`/`.mp4` on disk is a designed,
 * reachable state, and deleting the directory there destroys the very
 * evidence the promotion was performed to save.
 *
 * ## Everything the scanner drops still blocks
 *
 * `scanOrphans` is tuned for a RECOVERY BANNER: it answers "what should
 * we offer the user". A destruction guard asks a different question —
 * "is there anything here at all" — so the categories the scanner
 * deliberately drops are counted too:
 *
 *   orphans + oversized  surfaced for recovery, or too large for this
 *                        version to chunk. Not auto-recoverable is not
 *                        the same as safe to destroy.
 *   skipped_too_old      >7 days. Age is not proof of worthlessness.
 *   skipped_unknown_ext  a `guardian_recording_*` we cannot classify.
 *   skipped_zero_size    0 bytes OR a stat failure — the scanner counts
 *                        both here and they are indistinguishable in the
 *                        report, so this is an unknown, not a zero.
 *
 * NOT counted: `skipped_already_queued`. That file's uri belongs to a
 * live queue entry, which `inspectPendingEvidence` has already either
 * blocked on or proven fully confirmed off-device — and if every chunk
 * sliced from it carries a `remote_reference`, the local original is
 * redundant by the same rule that authorises reaping it.
 *
 * ## Why the readability probe is not redundant
 *
 * `scanOrphans` returns an ALL-ZERO report when `readDirectoryAsync`
 * throws or `documentDirectory` is null. For a banner that is right —
 * do not hide files behind an error. For a destruction guard it is
 * inverted: an all-zero report reads as "nothing to protect", which is
 * exactly how a failed listing would authorise deleting everything. So
 * the directory is probed independently first, and an unreadable one
 * refuses. Unknown is never treated as empty.
 */
export async function inspectLocalArtifacts(): Promise<ResetRefusal | null> {
  const docDir = FileSystem.documentDirectory;
  if (!docDir) return refuse('unreadable_filesystem');

  try {
    await FileSystem.readDirectoryAsync(docDir);
  } catch {
    return refuse('unreadable_filesystem');
  }

  const scan = await scanOrphans();
  const r = scan.report;
  const artifacts =
    scan.orphans.length +
    scan.oversized.length +
    r.skipped_too_old +
    r.skipped_unknown_ext +
    r.skipped_zero_size;
  if (artifacts > 0) {
    return refuse('local_orphan_evidence', {
      local_artifacts: artifacts,
      oversized_artifacts: scan.oversized.length,
    });
  }

  return await inspectStableSegments(docDir);
}

/**
 * The whole safety question for a tool that deletes local files.
 *
 * GLOBAL positive proof, not queue-local: the reset may proceed only
 * when GC_QUEUE is demonstrably safe AND no artifact outside it is still
 * evidence to a recovery route. Either check failing, or being unable to
 * answer, refuses.
 *
 * ## Surfaces deliberately NOT protected, and why
 *
 *   documentDirectory/chunks/<sid>/
 *     Slices, always DERIVED from a source that is itself protected —
 *     `entry.uri` while the entry lives, `guardian_recording_*` after
 *     promotion. With no queue entry no recovery route can read them
 *     (`rehydrateChunkSlice` needs the entry), and `reapEntry` removes
 *     the directory only after a confirmed completion, so a leftover is
 *     post-authorization residue. Blocking on it would wedge the tool
 *     permanently on genuinely innocuous garbage with no way to clear
 *     it from inside the app.
 *
 *   cacheDirectory native staging (`gc-segmented-recorder/<sid>/`)
 *     Covered transitively, and it has to be: the path is owned by the
 *     Kotlin side and is not enumerable from JS. Adoption is COPY,
 *     VERIFY, KEEP BOTH — so staging that was adopted has a counterpart
 *     under `segments/<sid>/` (checked above), and staging that was not
 *     still has its 4A queue entry (checked by `inspectPendingEvidence`,
 *     which blocks on zero chunks). See docs/KNOWN_LIMITS.md §4.
 */
export async function inspectResetSafety(): Promise<ResetRefusal | null> {
  const queue = await inspectPendingEvidence();
  if (queue) return queue;
  return await inspectLocalArtifacts();
}

export async function hardResetAppState(): Promise<ResetOutcome> {
  // GC-DEV-RESET-001 — REFUSAL, not a confirmation dialog. There is no
  // "delete anyway": a dev convenience may not be the thing that loses a
  // user's evidence. Nothing below runs, and not one byte or key is
  // touched, while anything is unconfirmed.
  //
  // GLOBAL proof: GC_QUEUE *and* the local filesystem. An empty queue is
  // not permission — `abandonUnregisteredSession` produces an empty
  // queue with real evidence still on disk, by design.
  //
  // EXCLUSION FIRST, and this order is the whole point. Acquiring after
  // the inspection would leave the original TOCTOU untouched: a capture
  // could start between the verdict and the first delete, and the delete
  // would take bytes the inspection never saw. The acquire is
  // synchronous, so nothing can interleave between the check and the
  // claim. If a capture is already starting, the CAPTURE WINS — this
  // returns null and the reset is the one told no.
  const lease = acquireDestructiveExclusion('hardResetAppState');
  if (lease === null) {
    console.log('GC_RESET refused', { reason: 'producer_active' });
    return refuse('producer_active');
  }

  try {
    const refusal = await inspectResetSafety();
    if (refusal) {
      console.log('GC_RESET refused', {
        reason: refusal.reason,
        sessions: refusal.sessions,
        unconfirmed_chunks: refusal.unconfirmed_chunks,
        local_artifacts: refusal.local_artifacts,
        oversized_artifacts: refusal.oversized_artifacts,
      });
      return refusal;
    }

    console.log('GC_RESET start');

    for (const key of VOLATILE_KEYS) {
      try {
        await AsyncStorage.removeItem(key);
      } catch (err) {
        console.log('GC_RESET asyncstorage remove failed', { key, err });
      }
    }

    const docDir = FileSystem.documentDirectory;
    if (docDir) {
      try {
        await FileSystem.deleteAsync(docDir, { idempotent: true });
      } catch (err) {
        console.log('GC_RESET docdir delete failed', err);
      }
      try {
        await FileSystem.makeDirectoryAsync(docDir, { intermediates: true });
      } catch (err) {
        console.log('GC_RESET docdir recreate failed', err);
      }
    }

    const cacheDir = FileSystem.cacheDirectory;
    if (cacheDir) {
      try {
        await FileSystem.deleteAsync(cacheDir, { idempotent: true });
      } catch (err) {
        console.log('GC_RESET cachedir delete failed', err);
      }
      try {
        await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
      } catch (err) {
        console.log('GC_RESET cachedir recreate failed', err);
      }
    }

    console.log('GC_RESET done');
    return { ok: true };
  } finally {
    // A leaked lease would wedge every future capture at the door, so
    // this release is unconditional — refusal, success, or a delete step
    // that threw past its own catch.
    releaseDestructiveExclusion(lease);
  }
}
