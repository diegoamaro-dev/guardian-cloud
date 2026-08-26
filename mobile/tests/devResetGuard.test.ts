/**
 * GC-DEV-RESET-001 — a dev tool may not destroy unconfirmed evidence.
 *
 * On 2026-08-21 a manual action on a dev reset destroyed 54 chunks and
 * 1 776 751 bytes of audio whose `remote_reference` was 0 of 54 — none of
 * it had ever left the device. The only guard was "not while recording".
 * `hardResetAppState` deletes `documentDirectory` and `cacheDirectory`
 * wholesale, so it takes chunks, native segments, audio and staging with
 * it; `clearGuardianQueueDev` drops `test.pending_retry`, which orphans
 * every chunk on disk — the files survive but nothing references them,
 * which is unrecoverable from inside the app.
 *
 * The policy is a REFUSAL, not a confirmation. There is deliberately no
 * "delete anyway": a dev convenience may not be the thing that loses
 * someone's evidence. Controlled destruction for lab work stays outside
 * the app, via `pm clear` over ADB.
 *
 * "Pending" reuses `isChunkConfirmedOffDevice` — the same predicate the
 * export gate, the finalize gate and the home banner use. A second
 * definition of "protected" would be a second thing to get wrong.
 *
 * ── What is NOT proven here ──────────────────────────────────────────
 * The `__DEV__` gate on the Settings block and the confirm dialog on the
 * Home long-press are React render paths; these tests drive the two
 * destructive functions, which is where the refusal actually lives. That
 * placement is the point: a screen must not be the thing standing
 * between a dev tool and someone's evidence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL(..., import.meta.url)` resolves to the DOM `URL` under this
// tsconfig's lib, which `readFileSync` will not accept. Going through
// the string form keeps the structural tests below typechecking.
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Deterministic suspension point. A test arms `gate.pending` with a key;
 * the next `getItem` for that key signals that it has been entered and
 * then waits on a barrier the test releases by hand. No timers, no
 * sleeps — the interleaving is exact and reproducible.
 */
const gate: {
  pending: { key: string; onEnter: () => void; barrier: Promise<void> } | null;
} = { pending: null };

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      __store__: store,
      getItem: vi.fn(async (k: string) => {
        const armed = gate.pending;
        if (armed !== null && armed.key === k) {
          gate.pending = null;
          armed.onEnter();
          await armed.barrier;
        }
        return store.get(k) ?? null;
      }),
      setItem: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      removeItem: vi.fn(async (k: string) => {
        store.delete(k);
      }),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const k of keys) store.delete(k);
      }),
      getAllKeys: vi.fn(async () => Array.from(store.keys())),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

const deleteAsync = vi.fn(async () => undefined);
const makeDirectoryAsync = vi.fn(async () => undefined);
const readDirectoryAsync = vi.fn(async (_dir: string): Promise<string[]> => []);
const getInfoAsync = vi.fn(
  async (_uri: string): Promise<Record<string, unknown>> => ({ exists: false }),
);
const moveAsync = vi.fn(async (_args: { from: string; to: string }) => undefined);
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  getInfoAsync: (...a: unknown[]) =>
    (getInfoAsync as unknown as (...x: unknown[]) => unknown)(...a),
  readAsStringAsync: vi.fn(async () => ''),
  writeAsStringAsync: vi.fn(),
  deleteAsync: (...a: unknown[]) =>
    (deleteAsync as unknown as (...x: unknown[]) => unknown)(...a),
  moveAsync: (...a: unknown[]) =>
    (moveAsync as unknown as (...x: unknown[]) => unknown)(...a),
  readDirectoryAsync: (...a: unknown[]) =>
    (readDirectoryAsync as unknown as (...x: unknown[]) => unknown)(...a),
  makeDirectoryAsync: (...a: unknown[]) =>
    (makeDirectoryAsync as unknown as (...x: unknown[]) => unknown)(...a),
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
// `tests/setup.ts` stubs `@/dev/reset` for every suite. This file is the
// one that must exercise the REAL refusal policy — a guard tested against
// a stub of itself proves nothing.
vi.mock('@/dev/reset', async () => await vi.importActual('@/dev/reset'));

import {
  hardResetAppState,
  inspectLocalArtifacts,
  inspectPendingEvidence,
} from '@/dev/reset';
// The REAL promotion path, so the `queue=[] + bytes on disk` scenario is
// produced by the product rather than described by a fixture. And the
// REAL 4A durable write, so "the producer never got to create evidence"
// is a statement about the product's own function.
import {
  abandonUnregisteredSession,
  clearGuardianQueueDev,
  queueAppendNewSession,
} from '../app/index';
import {
  acquireDestructiveExclusion,
  acquireProducerSlot,
  evidenceExclusionSnapshot,
  releaseDestructiveExclusion,
  releaseProducerSlot,
  __resetEvidenceExclusionForTests,
} from '@/recording/evidenceExclusion';
// Canonical: this file never writes the `guardian_recording_` literal.
import { ORPHAN_FILENAME_PREFIX } from '@/recording/orphanScan';
import { SESSION_CLEANUP_KEY } from '@/video/sessionCleanupJournal';

const store = (
  AsyncStorage as unknown as { __store__: Map<string, string> }
).__store__;

const QUEUE_KEY = 'test.pending_retry';
const PENDING_SESSIONS_KEY = 'guardian.pending_session_registrations';
const HISTORY_KEY = 'history.sessions';
const LAST_EXPORT_KEY = 'export.last_session_id';
const IDENTITY_KEY = 'gc.identity.v1';
const SEAL_KEY = 'gc.legacy_probe.v1';
const PAUSE_KEY = 'gc.pause.global.v1';
const CLEANUP_KEY = 'guardian.segment_cleanup.v1';

const SID = 'aee2cd23-7320-44c2-86c8-0198f4eb47a5';

/** Chunks exactly as a local-first capture leaves them: nothing uploaded. */
function pendingChunks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    chunk_index: i,
    hash: 'h'.repeat(64),
    size: 32769,
    status: 'pending' as const,
    attempts: 0,
    local_uri: `file:///doc/chunks/${SID}/${i}.b64`,
  }));
}
/** Chunks that are provably outside the device. */
function confirmedChunks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    chunk_index: i,
    hash: 'h'.repeat(64),
    size: 32769,
    status: 'uploaded' as const,
    attempts: 0,
    remote_reference: `1AbC${i}`,
  }));
}
function seedQueue(chunks: unknown[], extra: Record<string, unknown> = {}) {
  store.set(
    QUEUE_KEY,
    JSON.stringify([
      {
        session_id: SID,
        uri: 'file:///cache/Audio/recording-5d02df4b.aac',
        recording_closed: true,
        session_completed: false,
        complete_attempts: 0,
        emitted_base64_length: 0,
        next_chunk_index: chunks.length,
        destination_type: 'drive',
        chunks,
        ...extra,
      },
    ]),
  );
}
function seedSurroundingState() {
  store.set(
    PENDING_SESSIONS_KEY,
    JSON.stringify([{ session_id: SID, mode: 'audio', destination_type: 'drive' }]),
  );
  store.set(HISTORY_KEY, JSON.stringify([{ session_id: SID, mode: 'audio' }]));
  store.set(LAST_EXPORT_KEY, SID);
  store.set(
    IDENTITY_KEY,
    JSON.stringify({
      version: 1,
      initialized_at: 1787359982741,
      sub_prefix: '31776ad5',
      migrated_from_legacy: false,
    }),
  );
  store.set(
    SEAL_KEY,
    JSON.stringify({
      version: 1,
      probe_version: 1,
      evaluated_at: 1787359016334,
      legacy_identity_evidence: false,
    }),
  );
  store.set(
    PAUSE_KEY,
    JSON.stringify({
      version: 1,
      client_auth: null,
      systemic: null,
      destinations: { drive: { at: 1787359989465, code: 'DRIVE_NOT_CONNECTED' } },
    }),
  );
  store.set(CLEANUP_KEY, JSON.stringify({ version: 1, entries: [] }));
}

// ─── fake filesystem ──────────────────────────────────────────────────
// Only what the guard actually reads: a flat listing of documentDirectory,
// per-file size + mtime, and the `segments/` tree.
const DOC = 'file:///doc/';
const SEGMENTS_ROOT = `${DOC}segments/`;
type FakeFile = { size: number; mtime_s: number };
let docFiles: Record<string, FakeFile> = {};
let segmentSessionDirs: string[] | null = null;
let listFailsFor: string | null = null;

function putRecording(suffix: string, size: number, ageDays = 0): string {
  // Name built from the CANONICAL prefix, never a literal.
  const name = `${ORPHAN_FILENAME_PREFIX}${1787359000000 + Object.keys(docFiles).length}${suffix}`;
  docFiles[name] = {
    size,
    mtime_s: Math.floor((Date.now() - ageDays * 86_400_000) / 1000),
  };
  return DOC + name;
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  deleteAsync.mockClear();
  makeDirectoryAsync.mockClear();
  docFiles = {};
  segmentSessionDirs = null;
  listFailsFor = null;
  gate.pending = null;
  // Module state outlives a test file's beforeEach otherwise.
  __resetEvidenceExclusionForTests();
  deleteAsync.mockImplementation(async () => undefined);

  readDirectoryAsync.mockImplementation(async (dir: string) => {
    if (listFailsFor !== null && dir === listFailsFor) throw new Error('EIO');
    if (dir === DOC) {
      return [...Object.keys(docFiles), ...(segmentSessionDirs ? ['segments'] : [])];
    }
    if (dir === SEGMENTS_ROOT) return segmentSessionDirs ?? [];
    return [];
  });
  getInfoAsync.mockImplementation(async (uri: string) => {
    if (uri === SEGMENTS_ROOT) return { exists: segmentSessionDirs !== null };
    const name = uri.startsWith(DOC) ? uri.slice(DOC.length) : null;
    const file = name === null ? undefined : docFiles[name];
    if (!file) return { exists: false };
    return { exists: true, size: file.size, modificationTime: file.mtime_s };
  });
  // A move that actually moves: `abandonUnregisteredSession` promotes a
  // capture into documentDirectory, and the guard must then see it.
  moveAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
    docFiles[to.slice(DOC.length)] = {
      size: 1_776_751,
      mtime_s: Math.floor(Date.now() / 1000),
    };
    return undefined;
  });
});

/** A journal that authorises cleaning exactly these session ids. */
function seedCleanupAuthorizations(sessionIds: string[]) {
  store.set(
    SESSION_CLEANUP_KEY,
    JSON.stringify({
      version: 1,
      entries: sessionIds.map((sid) => ({
        session_id: sid,
        authorized_at_ms: 1787359982741,
        authorization: 'http_200',
        resources: { native_cache: 'pending', stable_segments: 'pending' },
        attempts: 0,
        last_result: null,
      })),
    }),
  );
}

describe('GC_DEV_RESET_001_PENDING_EVIDENCE_REFUSES', () => {
  it('THE INCIDENT, as executable documentation: 54 pending, 0/54 remote_reference', async () => {
    seedQueue(pendingChunks(54));
    seedSurroundingState();
    const queueBefore = store.get(QUEUE_KEY);
    const pendingBefore = store.get(PENDING_SESSIONS_KEY);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('pending_evidence');
      expect(outcome.unconfirmed_chunks).toBe(54);
      expect(outcome.sessions).toBe(1);
    }
    // GC_QUEUE byte-identical.
    expect(store.get(QUEUE_KEY)).toBe(queueBefore);
    // Chunks, audio, segments and staging untouched: not one delete ran.
    expect(deleteAsync).not.toHaveBeenCalled();
    expect(makeDirectoryAsync).not.toHaveBeenCalled();
    // Pending registrations untouched.
    expect(store.get(PENDING_SESSIONS_KEY)).toBe(pendingBefore);
    // Nothing else went either.
    expect(store.get(HISTORY_KEY)).toBeDefined();
    expect(store.get(LAST_EXPORT_KEY)).toBe(SID);
  });

  it('a single unconfirmed chunk among many confirmed still refuses', async () => {
    seedQueue([...confirmedChunks(53), ...pendingChunks(1)]);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.unconfirmed_chunks).toBe(1);
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('uploaded WITHOUT a remote_reference is not protected — same rule as export', async () => {
    seedQueue([
      { chunk_index: 0, hash: 'h'.repeat(64), size: 4, status: 'uploaded', attempts: 0 },
      {
        chunk_index: 1,
        hash: 'h'.repeat(64),
        size: 4,
        status: 'uploaded',
        attempts: 0,
        remote_reference: '   ',
      },
    ]);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.unconfirmed_chunks).toBe(2);
  });

  it('an unreadable queue refuses: not being able to tell is not permission', async () => {
    store.set(QUEUE_KEY, '{{{ not json');

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('there is no bypass: repeated calls keep refusing, nothing accumulates', async () => {
    seedQueue(pendingChunks(54));
    const before = store.get(QUEUE_KEY);

    for (let i = 0; i < 5; i += 1) {
      expect((await hardResetAppState()).ok).toBe(false);
    }

    expect(store.get(QUEUE_KEY)).toBe(before);
    expect(deleteAsync).not.toHaveBeenCalled();
  });
});

describe('GC_DEV_RESET_001_AUTHORISED_RESET', () => {
  it('an empty queue lets the reset proceed', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    seedSurroundingState();
    store.set(QUEUE_KEY, JSON.stringify([]));

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(true);
    expect(store.get(QUEUE_KEY)).toBeUndefined();
    // documentDirectory + cacheDirectory, deleted and recreated.
    expect(deleteAsync).toHaveBeenCalledTimes(2);
    expect(makeDirectoryAsync).toHaveBeenCalledTimes(2);
  });

  it('no queue key at all lets the reset proceed', async () => {
    seedSurroundingState();
    store.delete(QUEUE_KEY);

    expect((await hardResetAppState()).ok).toBe(true);
    expect(deleteAsync).toHaveBeenCalledTimes(2);
  });

  it('FULLY PROTECTED evidence: the reset proceeds — the bytes are already off-device', async () => {
    // Defined explicitly: every chunk uploaded AND carrying a real
    // remote_reference means the evidence exists outside the phone, so
    // deleting the local copy loses nothing. This is the same predicate
    // the finalize gate uses to authorise cleanup.
    seedQueue(confirmedChunks(54));
    seedSurroundingState();

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(true);
    expect(store.get(QUEUE_KEY)).toBeUndefined();
  });

  it('an authorised reset leaves NO phantom pending registrations', async () => {
    seedSurroundingState();
    store.set(QUEUE_KEY, JSON.stringify([]));

    expect((await hardResetAppState()).ok).toBe(true);

    // The incoherence this fixes: the queue was dropped while the
    // registrations that could only point at it survived, so the replay
    // loop kept retrying POST /sessions for sessions that no longer
    // existed anywhere.
    expect(store.get(PENDING_SESSIONS_KEY)).toBeUndefined();
    expect(store.get(QUEUE_KEY)).toBeUndefined();
    expect(store.get(HISTORY_KEY)).toBeUndefined();
    expect(store.get(LAST_EXPORT_KEY)).toBeUndefined();
  });

  it('identity marker and legacy seal SURVIVE an authorised reset', async () => {
    seedSurroundingState();
    store.set(QUEUE_KEY, JSON.stringify([]));

    expect((await hardResetAppState()).ok).toBe(true);

    // A dev reset is not a fresh install. Wiping these would re-create
    // GC-AUTH-001 (orphaned identity) and GC-AUTH-MIGRATION-001.
    expect(JSON.parse(store.get(IDENTITY_KEY)!).sub_prefix).toBe('31776ad5');
    expect(JSON.parse(store.get(SEAL_KEY)!).legacy_identity_evidence).toBe(false);
  });

  it('pause state and cleanup journal SURVIVE, by semantics not tidiness', async () => {
    seedSurroundingState();
    store.set(QUEUE_KEY, JSON.stringify([]));

    expect((await hardResetAppState()).ok).toBe(true);

    // Clearing a pause here would fake a recovery — exactly what
    // GC-DEST-PAUSE-001 forbids: only positive proof retires a pause.
    expect(JSON.parse(store.get(PAUSE_KEY)!).destinations.drive.code).toBe(
      'DRIVE_NOT_CONNECTED',
    );
    // The journal records a backend authorisation we were granted.
    expect(store.get(CLEANUP_KEY)).toBeDefined();
  });
});

describe('GC_DEV_RESET_001_THE_PREDICATE', () => {
  it('inspectPendingEvidence returns null exactly when a reset may run', async () => {
    seedQueue(confirmedChunks(3));
    expect(await inspectPendingEvidence()).toBeNull();

    seedQueue(pendingChunks(3));
    expect(await inspectPendingEvidence()).not.toBeNull();
  });

  it('counts across multiple sessions', async () => {
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        { session_id: 'a', chunks: pendingChunks(2) },
        { session_id: 'b', chunks: confirmedChunks(5) },
        { session_id: 'c', chunks: pendingChunks(3) },
      ]),
    );

    const r = await inspectPendingEvidence();

    expect(r?.sessions).toBe(2);
    expect(r?.unconfirmed_chunks).toBe(5);
  });

  it('TEETH: the reset really does delete when permitted', async () => {
    // Guards every "nothing was deleted" assertion above. If the reset
    // never deleted anything under any condition, those would all pass
    // for the wrong reason.
    store.set(QUEUE_KEY, JSON.stringify([]));
    store.set(HISTORY_KEY, JSON.stringify([{ session_id: SID }]));

    expect((await hardResetAppState()).ok).toBe(true);

    expect(store.get(HISTORY_KEY)).toBeUndefined();
    expect(deleteAsync).toHaveBeenCalledTimes(2);
  });
});

describe('GC_DEV_RESET_001_ZERO_CHUNKS_IS_NOT_PROOF_OF_ANYTHING', () => {
  /**
   * The hole an earlier version of this guard had: it reasoned
   * "no chunks ⇒ no bytes ⇒ safe". EVERY capture is born with `chunks: []`
   * — 4A writes the durable entry before the chunker emits anything — so
   * that rule deletes live captures. `tryFinalizeReadySessions` already
   * refuses zero-chunk entries for exactly this reason.
   */
  it('1. zero chunks + recording_closed:false + real uri → REFUSE', async () => {
    // Audio/legacy video mid-capture, or after a kill: the .aac is on
    // disk and growing, and not one chunk exists yet.
    seedQueue([], { recording_closed: false });
    const before = store.get(QUEUE_KEY);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('undecidable_entry');
    expect(store.get(QUEUE_KEY)).toBe(before);
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('2. zero chunks + recording_closed:true + real uri → REFUSE', async () => {
    // Chunker failed, capture too short to emit, or an abandoned session.
    // Nothing here proves the file is not evidence.
    seedQueue([], { recording_closed: true });

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('undecidable_entry');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('2b. native video shape: zero chunks + EMPTY uri → REFUSE', async () => {
    // `uri` cannot be the discriminator: the native segmented recorder
    // creates its entry with `uri: ''` while real segments already exist
    // under files/segments/{id}/, adopted as chunks only later.
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        {
          session_id: SID,
          uri: '',
          recording_closed: false,
          session_completed: false,
          complete_attempts: 0,
          emitted_base64_length: 0,
          next_chunk_index: 0,
          destination_type: 'drive',
          chunks: [],
        },
      ]),
    );

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('3. entry with `chunks` ABSENT but a uri → REFUSE, never degrade to []', async () => {
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        { session_id: SID, uri: 'file:///cache/Audio/rec.aac', recording_closed: true },
      ]),
    );

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('undecidable_entry');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('4. partially malformed entries → REFUSE', async () => {
    for (const shape of [
      [null],
      ['not an object'],
      [{ session_id: SID, chunks: 'nope' }],
      [{ session_id: SID, chunks: {} }],
      [{ session_id: SID, chunks: [null] }],
    ]) {
      store.clear();
      deleteAsync.mockClear();
      store.set(QUEUE_KEY, JSON.stringify(shape));

      const outcome = await hardResetAppState();

      expect(outcome.ok, JSON.stringify(shape)).toBe(false);
      expect(deleteAsync).not.toHaveBeenCalled();
    }
  });

  it('5. a genuinely empty queue [] permits the reset', async () => {
    seedSurroundingState();
    store.set(QUEUE_KEY, JSON.stringify([]));

    expect((await hardResetAppState()).ok).toBe(true);
    expect(deleteAsync).toHaveBeenCalledTimes(2);
  });

  it('6. all chunks confirmed off-device → permitted, explicitly', async () => {
    // The one shape that is positive proof: a NON-EMPTY chunks array
    // where every chunk is uploaded AND carries a real remote_reference.
    // The bytes exist outside the phone, so the local copy is redundant.
    seedQueue(confirmedChunks(54));
    seedSurroundingState();

    expect((await hardResetAppState()).ok).toBe(true);
    expect(store.get(QUEUE_KEY)).toBeUndefined();
  });

  it('a mix of one safe session and one zero-chunk session still refuses', async () => {
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        { session_id: 'safe', chunks: confirmedChunks(3) },
        { session_id: 'live', uri: 'file:///cache/Audio/rec.aac', chunks: [] },
      ]),
    );

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.sessions).toBe(1);
    expect(deleteAsync).not.toHaveBeenCalled();
  });
});

describe('GC_DEV_RESET_001_EVIDENCE_SURVIVES_OUTSIDE_GC_QUEUE', () => {
  /**
   * The second hole. `queue === []` was treated as sufficient, and it is
   * not: the product has a route that deliberately produces an empty
   * queue with real evidence still on disk.
   *
   *   `abandonUnregisteredSession` MOVES the capture to
   *   `documentDirectory/guardian_recording_*` and THEN drops the queue
   *   entry — in that order, so a process death errs towards a redundant
   *   reference rather than none. The promotion exists precisely so
   *   `orphanScan` can recover the bytes once nothing in the queue points
   *   at them.
   *
   * `hardResetAppState` deletes `documentDirectory` wholesale, so under
   * the old rule it destroyed the evidence the promotion was performed
   * to save.
   */

  it('1. queue [] + a recoverable .aac orphan -> REFUSE', async () => {
    seedSurroundingState();
    store.set(QUEUE_KEY, JSON.stringify([]));
    putRecording('.aac', 1_776_751);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('local_orphan_evidence');
      expect(outcome.local_artifacts).toBe(1);
      expect(outcome.oversized_artifacts).toBe(0);
    }
    expect(deleteAsync).not.toHaveBeenCalled();
    expect(makeDirectoryAsync).not.toHaveBeenCalled();
    // Nothing in AsyncStorage went either.
    expect(store.get(HISTORY_KEY)).toBeDefined();
  });

  it('2. queue [] + a recoverable .mp4 orphan -> REFUSE', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    putRecording('.mp4', 8_400_000);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('local_orphan_evidence');
      // Video has no oversize ceiling — the cap exists because the AUDIO
      // chunker stores base64 inline. So this is recoverable, not oversized.
      expect(outcome.oversized_artifacts).toBe(0);
    }
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('3. queue [] + an OVERSIZED audio orphan -> REFUSE', async () => {
    // Above AUDIO_ORPHAN_MAX_BYTES the scanner surfaces the file but
    // never auto-recovers it. "This version cannot chunk it" is not "it
    // is safe to destroy" — it is the opposite: the bytes are stuck on
    // the device and the device is the only place they exist.
    store.set(QUEUE_KEY, JSON.stringify([]));
    putRecording('.aac', 12 * 1024 * 1024);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('local_orphan_evidence');
      expect(outcome.local_artifacts).toBe(1);
      expect(outcome.oversized_artifacts).toBe(1);
    }
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('4. THE REAL ROUTE: abandonUnregisteredSession -> promoted, entry dropped -> REFUSE', async () => {
    // Driven through the product function, not a fixture of its output.
    seedQueue([], { recording_closed: true });
    const cacheUri = 'file:///cache/Audio/recording-5d02df4b.aac';

    const promotion = await abandonUnregisteredSession(SID, cacheUri);

    // Preconditions of the scenario, asserted rather than assumed.
    expect(promotion.entry_dropped).toBe(true);
    expect(promotion.moved_to).not.toBeNull();
    expect(promotion.moved_to!.startsWith(DOC + ORPHAN_FILENAME_PREFIX)).toBe(true);
    expect(JSON.parse(store.get(QUEUE_KEY)!)).toEqual([]);

    // The old rule said: empty queue => delete everything.
    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('local_orphan_evidence');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('5. a fully-confirmed queue + an orphan present -> still REFUSE', async () => {
    // Rule 1 passing is not rule 2 passing. The orphan is a different
    // capture, and nothing about the confirmed one says anything about it.
    seedQueue(confirmedChunks(54));
    putRecording('.aac', 900_000);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('local_orphan_evidence');
      expect(outcome.unconfirmed_chunks).toBe(0);
    }
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('6. queue [] + genuinely nothing on disk -> the reset proceeds', async () => {
    seedSurroundingState();
    store.set(QUEUE_KEY, JSON.stringify([]));

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(true);
    expect(deleteAsync).toHaveBeenCalledTimes(2);
    expect(makeDirectoryAsync).toHaveBeenCalledTimes(2);
  });

  it('7. documentDirectory unreadable -> REFUSE, never assume empty', async () => {
    // `scanOrphans` returns an ALL-ZERO report when the listing throws:
    // right for a banner, inverted for a destruction guard, where zero
    // reads as "nothing to protect". Hence the independent probe.
    store.set(QUEUE_KEY, JSON.stringify([]));
    listFailsFor = DOC;

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unreadable_filesystem');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('8. REGRESSION: the 54-chunk incident still refuses, on the queue rule', async () => {
    seedQueue(pendingChunks(54));
    seedSurroundingState();

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('pending_evidence');
      expect(outcome.unconfirmed_chunks).toBe(54);
    }
    expect(deleteAsync).not.toHaveBeenCalled();
  });
});

describe('GC_DEV_RESET_001_WHAT_THE_SCANNER_DROPS_STILL_BLOCKS', () => {
  /**
   * `scanOrphans` answers "what should we OFFER the user to recover".
   * A destruction guard asks "is there anything here at all". Every
   * category the scanner deliberately drops is still evidence, so the
   * guard counts the report's skip counters too.
   */
  it('an orphan older than the 7-day recovery window still blocks', async () => {
    // Age is not proof of worthlessness. The scanner hides it from the
    // banner; that is not permission to shred it.
    store.set(QUEUE_KEY, JSON.stringify([]));
    putRecording('.aac', 500_000, 40);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('local_orphan_evidence');
      expect(outcome.local_artifacts).toBe(1);
    }
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('a guardian_recording_* with an unclassifiable extension still blocks', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    putRecording('.mkv', 700_000);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('local_orphan_evidence');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('a zero-size / unstattable orphan blocks: the report cannot tell them apart', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    putRecording('.aac', 0);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('local_orphan_evidence');
  });

  it('a file whose uri belongs to a PROVEN queue entry does NOT block', async () => {
    // The one category that must not block, or the guard would wedge on
    // the ordinary case. Every chunk sliced from this file carries a
    // remote_reference, which is the same proof that authorises reaping
    // the entry and deleting the local original.
    const uri = putRecording('.aac', 1_000_000);
    seedSurroundingState();
    seedQueue(confirmedChunks(54), { uri });

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(true);
    expect(deleteAsync).toHaveBeenCalledTimes(2);
  });

  it('a NON-guardian file in documentDirectory does not block', async () => {
    // Expo dev-launcher bundles, router caches, scratch dirs. Innocuous
    // garbage must not wedge the tool.
    store.set(QUEUE_KEY, JSON.stringify([]));
    docFiles['ExponentExperienceData'] = { size: 4096, mtime_s: 1787359000 };
    docFiles['RCTAsyncLocalStorage'] = { size: 8192, mtime_s: 1787359000 };

    expect((await hardResetAppState()).ok).toBe(true);
  });
});

describe('GC_DEV_RESET_001_STABLE_SEGMENTS_NEED_REMOTE_AUTHORISATION', () => {
  /**
   * `segments/<sid>/` holds the verified copies of native video
   * segments, and `segmentAdopter` puts them OUTSIDE `chunks/<sid>/`
   * specifically so they outlive the queue entry. So "no queue entry"
   * says nothing at all about them.
   *
   * The journal's own doctrine decides: not age, not absence from
   * GC_QUEUE, not an empty directory — only a durable authorization,
   * which only a real backend 200/409 produces.
   */
  const SID_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

  it('segments with NO cleanup authorisation -> REFUSE', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    segmentSessionDirs = [SID, SID_B];

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unauthorized_segments');
      expect(outcome.local_artifacts).toBe(2);
    }
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('segments the BACKEND authorised cleaning -> the reset proceeds', async () => {
    // The "innocuous residue" case: the cleanup runner has permission and
    // simply has not got there yet. Blocking here would wedge the tool.
    store.set(QUEUE_KEY, JSON.stringify([]));
    segmentSessionDirs = [SID, SID_B];
    seedCleanupAuthorizations([SID, SID_B]);

    expect((await hardResetAppState()).ok).toBe(true);
    expect(deleteAsync).toHaveBeenCalledTimes(2);
  });

  it('PARTIAL authorisation refuses: one unauthorised session is enough', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    segmentSessionDirs = [SID, SID_B];
    seedCleanupAuthorizations([SID]);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unauthorized_segments');
      expect(outcome.local_artifacts).toBe(1);
    }
  });

  it('an EMPTY segments/<sid>/ still blocks — emptiness is not authorisation', async () => {
    // Stated verbatim in the journal: not age, not absence from GC_QUEUE,
    // not an empty directory. Same shape as the zero-chunks rule.
    store.set(QUEUE_KEY, JSON.stringify([]));
    segmentSessionDirs = [SID];

    expect((await hardResetAppState()).ok).toBe(false);
  });

  it('an UNUSABLE journal refuses: one malformed entry poisons the document', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    segmentSessionDirs = [SID];
    store.set(
      SESSION_CLEANUP_KEY,
      JSON.stringify({
        version: 1,
        entries: [{ session_id: SID, authorization: 'nope' }],
      }),
    );

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unreadable_journal');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('a journal from a FUTURE version refuses: an unreadable grant is not a grant', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    segmentSessionDirs = [SID];
    store.set(SESSION_CLEANUP_KEY, JSON.stringify({ version: 99, entries: [] }));

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unreadable_journal');
  });

  it('an unreadable segments/ listing -> REFUSE', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    segmentSessionDirs = [SID];
    listFailsFor = SEGMENTS_ROOT;

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unreadable_filesystem');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('no segments/ directory at all is fine', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    segmentSessionDirs = null;

    expect(await inspectLocalArtifacts()).toBeNull();
  });
});

describe('GC_DEV_RESET_001_TOCTOU_PRODUCERS_VS_DESTRUCTION', () => {
  /**
   * The third hole. The guard decided what to inspect; it did not
   * serialise the inspection against the producers. `hardResetAppState`
   * checked, then deleted, and a capture could start in between — its
   * bytes destroyed by a verdict that never saw them.
   *
   * `reset.ts` even carried the contract in prose: "Caller must ensure
   * no recording is in flight." A comment is not an exclusion mechanism.
   *
   * The interleaving below is driven by an explicit barrier, never by
   * timing: `gate` suspends the reset INSIDE its inspection, the test
   * acts while it is suspended, and then releases it by hand.
   */

  /** Suspend the next queue read; resolve `entered` when it happens. */
  function armGate(key: string): { entered: Promise<void>; release: () => void } {
    let onEnter!: () => void;
    const entered = new Promise<void>((r) => {
      onEnter = r;
    });
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    gate.pending = { key, onEnter, barrier };
    return { entered, release };
  }

  it('1. reset is INSPECTING and a capture tries to start -> only one may mutate', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    const { entered, release } = armGate(QUEUE_KEY);

    const resetInFlight = hardResetAppState();
    await entered; // the reset now holds exclusion and is mid-inspection

    // The window that used to be open. It is not any more.
    const slot = acquireProducerSlot('capture');
    expect(slot).toBeNull();
    expect(evidenceExclusionSnapshot().destructive).toBe('hardResetAppState');
    // And nothing has been deleted yet, so this really is the middle.
    expect(deleteAsync).not.toHaveBeenCalled();

    release();
    expect((await resetInFlight).ok).toBe(true);

    // Exclusion is handed back the moment the destruction is over.
    const after = acquireProducerSlot('capture');
    expect(after).not.toBeNull();
    releaseProducerSlot(after);
  });

  it('2. a capture that already crossed its durable boundary -> reset REFUSES', async () => {
    // Past 4A the slot is released, and protection is handed to the
    // inspection: the entry itself is what refuses now.
    seedQueue([], { recording_closed: false });
    expect(evidenceExclusionSnapshot().producers).toBe(0);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('undecidable_entry');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('2b. a capture still INSIDE its start window -> reset REFUSES, capture wins', async () => {
    // Before 4A there is nothing durable to inspect, which is exactly
    // why the slot has to exist. The reset is the one told no.
    store.set(QUEUE_KEY, JSON.stringify([]));
    const slot = acquireProducerSlot('startRecording');
    expect(slot).not.toBeNull();

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('producer_active');
    expect(deleteAsync).not.toHaveBeenCalled();
    // The capture was never interrupted, cancelled or preempted.
    expect(evidenceExclusionSnapshot().producers).toBe(1);
    releaseProducerSlot(slot);
  });

  it('3. reset HOLDS exclusion -> a capture creates neither GC_QUEUE nor bytes', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    const { entered, release } = armGate(QUEUE_KEY);
    const resetInFlight = hardResetAppState();
    await entered;

    // Faithful model of the door in `startRecording`: acquire first, and
    // do NOTHING irreversible if it is refused. The durable write below
    // is the product's own `queueAppendNewSession`, not a stand-in.
    let recorderStarted = false;
    const slot = acquireProducerSlot('startRecording');
    if (slot !== null) {
      recorderStarted = true;
      await queueAppendNewSession({
        session_id: SID,
        uri: 'file:///cache/Audio/rec.aac',
        recording_closed: false,
        session_completed: false,
        complete_attempts: 0,
        emitted_base64_length: 0,
        next_chunk_index: 0,
        chunks: [],
        destination_type: 'drive',
      });
    }

    expect(slot).toBeNull();
    expect(recorderStarted).toBe(false);
    expect(JSON.parse(store.get(QUEUE_KEY)!)).toEqual([]);

    release();
    expect((await resetInFlight).ok).toBe(true);

    // TEETH. Without this the assertions above would pass even if
    // `queueAppendNewSession` were inert: run the identical producer now
    // that exclusion is free and prove the write really does land.
    const after = acquireProducerSlot('startRecording');
    expect(after).not.toBeNull();
    await queueAppendNewSession({
      session_id: SID,
      uri: 'file:///cache/Audio/rec.aac',
      recording_closed: false,
      session_completed: false,
      complete_attempts: 0,
      emitted_base64_length: 0,
      next_chunk_index: 0,
      chunks: [],
      destination_type: 'drive',
    });
    expect(JSON.parse(store.get(QUEUE_KEY)!)).toHaveLength(1);
    releaseProducerSlot(after);
  });

  it('4. an authorised reset releases exclusion even when deleteAsync FAILS', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    deleteAsync.mockImplementation(async () => {
      throw new Error('EACCES');
    });

    const outcome = await hardResetAppState();
    expect(outcome.ok).toBe(true); // per-step failures are best-effort

    // The invariant that matters: a wedged lease would lock every future
    // capture out at the door.
    expect(evidenceExclusionSnapshot().destructive).toBeNull();
    const slot = acquireProducerSlot('startRecording');
    expect(slot).not.toBeNull();
    releaseProducerSlot(slot);
  });

  it('4b. a REFUSED reset releases exclusion too', async () => {
    seedQueue(pendingChunks(54));

    expect((await hardResetAppState()).ok).toBe(false);

    expect(evidenceExclusionSnapshot().destructive).toBeNull();
    const slot = acquireProducerSlot('startRecording');
    expect(slot).not.toBeNull();
    releaseProducerSlot(slot);
  });

  it('5. two concurrent resets -> exactly one destroys', async () => {
    seedSurroundingState();
    store.set(QUEUE_KEY, JSON.stringify([]));
    const { entered, release } = armGate(QUEUE_KEY);

    const first = hardResetAppState();
    await entered; // A holds the lease and is mid-inspection

    const second = await hardResetAppState();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('producer_active');

    release();
    expect((await first).ok).toBe(true);

    // documentDirectory + cacheDirectory, once. Not twice.
    expect(deleteAsync).toHaveBeenCalledTimes(2);
    expect(makeDirectoryAsync).toHaveBeenCalledTimes(2);
  });

  it('5b. clearGuardianQueueDev shares the SAME exclusion as the reset', async () => {
    // Both drop durable references without going through `queueMutate`,
    // so both need the lease — and they must not run at the same time.
    store.set(QUEUE_KEY, JSON.stringify([]));
    const { entered, release } = armGate(QUEUE_KEY);

    const resetInFlight = hardResetAppState();
    await entered;

    const cleared = await clearGuardianQueueDev();
    expect(cleared.removed).toEqual([]);
    expect(cleared.refused?.reason).toBe('producer_active');

    release();
    expect((await resetInFlight).ok).toBe(true);
  });

  it('5c. a starting capture blocks clearGuardianQueueDev as well', async () => {
    seedQueue(confirmedChunks(3));
    const slot = acquireProducerSlot('startRecording');

    const cleared = await clearGuardianQueueDev();

    // Fully confirmed evidence, so the queue check alone would have
    // allowed it. The exclusion is what refuses.
    expect(cleared.refused?.reason).toBe('producer_active');
    expect(store.get(QUEUE_KEY)).toBeDefined();
    releaseProducerSlot(slot);
  });

  it('6. REGRESSION: the 54 chunks of the incident are still protected', async () => {
    seedQueue(pendingChunks(54));
    seedSurroundingState();

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('pending_evidence');
      expect(outcome.unconfirmed_chunks).toBe(54);
    }
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('7. REGRESSION: an orphan outside GC_QUEUE is still protected', async () => {
    store.set(QUEUE_KEY, JSON.stringify([]));
    putRecording('.aac', 1_776_751);

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('local_orphan_evidence');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('8. REGRESSION: native-video zero-chunk is still protected', async () => {
    store.set(
      QUEUE_KEY,
      JSON.stringify([{ session_id: SID, uri: '', chunks: [], next_chunk_index: 0 }]),
    );

    const outcome = await hardResetAppState();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('undecidable_entry');
    expect(deleteAsync).not.toHaveBeenCalled();
  });
});

describe('GC_DEV_RESET_001_EXCLUSION_PRIMITIVE', () => {
  it('several producers coexist; the reset waits for the LAST one', () => {
    const a = acquireProducerSlot('a');
    const b = acquireProducerSlot('b');
    expect(acquireDestructiveExclusion('reset')).toBeNull();

    releaseProducerSlot(a);
    expect(acquireDestructiveExclusion('reset')).toBeNull();

    releaseProducerSlot(b);
    const lease = acquireDestructiveExclusion('reset');
    expect(lease).not.toBeNull();
    releaseDestructiveExclusion(lease);
  });

  it('a double release cannot free another producer slot', () => {
    const a = acquireProducerSlot('a');
    const b = acquireProducerSlot('b');
    releaseProducerSlot(a);
    releaseProducerSlot(a); // repeated — must not touch b
    expect(evidenceExclusionSnapshot().producers).toBe(1);
    expect(acquireDestructiveExclusion('reset')).toBeNull();
    releaseProducerSlot(b);
  });

  it('a stale lease cannot release the current holder', () => {
    const first = acquireDestructiveExclusion('first');
    releaseDestructiveExclusion(first);
    const second = acquireDestructiveExclusion('second');

    releaseDestructiveExclusion(first); // stale — must be ignored

    expect(evidenceExclusionSnapshot().destructive).toBe('second');
    expect(acquireProducerSlot('capture')).toBeNull();
    releaseDestructiveExclusion(second);
  });

  it('the acquire is SYNCHRONOUS: no suspension point between check and claim', () => {
    // This is the whole reason a plain counter is sufficient on the JS
    // single thread. If either acquire ever became async, an interleaving
    // could observe a half-claimed state and this test should be revisited.
    expect(acquireProducerSlot('x')).toBeInstanceOf(Object);
    expect(acquireDestructiveExclusion('y')).toBeNull();
  });
});

describe('GC_DEV_RESET_001_THE_DOOR_IS_WHERE_IT_CLAIMS_TO_BE', () => {
  /**
   * Structural, and deliberately so: the door only works if it sits
   * before the first irreversible effect, and that ordering lives in a
   * React component this suite cannot render. Reordering it would be
   * silent otherwise.
   */
  const source = readFileSync(join(HERE, '..', 'app', 'index.tsx'), 'utf8');

  it('startRecording acquires the slot before the recorder and before 4A', () => {
    const door = source.indexOf("acquireProducerSlot('startRecording')");
    const recorder = source.indexOf('await startAudioRecording()');
    const durable = source.indexOf('await queueAppendNewSession(');

    expect(door).toBeGreaterThan(-1);
    expect(recorder).toBeGreaterThan(-1);
    expect(durable).toBeGreaterThan(-1);
    // Audio/legacy video open the recorder first; native segmented video
    // writes 4A first. The door precedes BOTH orderings.
    expect(door).toBeLessThan(recorder);
    expect(door).toBeLessThan(durable);
  });

  it('the slot is released in the same finally that clears isStartingRef', () => {
    expect(source).toMatch(
      /isStartingRef\.current = false;[\s\S]{0,600}releaseProducerSlot\(producerSlot\)/,
    );
  });

  it('both destructive tools acquire exclusion BEFORE inspecting', () => {
    const reset = readFileSync(
      join(HERE, '..', 'src', 'dev', 'reset.ts'),
      'utf8',
    );
    const lease = reset.indexOf("acquireDestructiveExclusion('hardResetAppState')");
    const inspect = reset.indexOf('await inspectResetSafety()');
    expect(lease).toBeGreaterThan(-1);
    expect(inspect).toBeGreaterThan(-1);
    // Acquiring after the inspection would leave the TOCTOU wide open.
    expect(lease).toBeLessThan(inspect);
  });
});
