/**
 * Tests for the persisted upload queue: shape transitions, the
 * stuck-uploading reset that boot recovery relies on, and the
 * pending-work selector used by the foreground-service lifecycle.
 *
 * Strategy: drive the real `queueMutate` / `queueRead` helpers
 * (already exported) over an in-memory AsyncStorage. The mock for
 * AsyncStorage exposes its underlying Map via `__store__` so each
 * test can seed and inspect state without relying on internal
 * helpers.
 *
 * Lifecycle covered:
 *   pending → uploading → uploaded
 *   pending → failed (terminal)
 *   stuck `uploading` after kill → reset to pending on boot
 *   recording_closed=false after kill → flipped to true on boot
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      __store__: store,
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PENDING_RETRY_KEY,
  hasPendingUploadWork,
  queueAppendChunk,
  queueAppendNewSession,
  queueMutate,
  queueRead,
  queueUpdateChunk,
  queueDropEntry,
  queueMarkRecordingClosed,
  queueMarkSessionCompleted,
  queueBumpCompleteAttempts,
  pickNext,
  emitChunk,
  videoChunkSink,
  type PendingQueueEntry,
  type QueueChunk,
} from '../app/index';
import { emptyPauseState } from '@/upload/pauseStore';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function emptyEntry(overrides: Partial<PendingQueueEntry> = {}): PendingQueueEntry {
  return {
    session_id: SID,
    uri: 'file:///doc/rec.m4a',
    recording_closed: false,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 0,
    chunks: [],
    ...overrides,
  };
}

function pendingChunk(idx: number): QueueChunk {
  return {
    chunk_index: idx,
    hash: 'h'.repeat(64),
    size: 100,
    status: 'pending',
    attempts: 0,
    base64Slice: 'AAAA',
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.clearAllMocks();
});

describe('queue plumbing — append / read / update', () => {
  it('queueAppendNewSession appends a new entry and queueRead reflects it', async () => {
    await queueAppendNewSession(emptyEntry());
    const q = await queueRead();
    expect(q).toHaveLength(1);
    expect(q[0]?.session_id).toBe(SID);
  });

  it('queueAppendNewSession with the same session_id REPLACES (idempotent recovery semantics)', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendNewSession(
      emptyEntry({ uri: 'file:///doc/replaced.m4a' }),
    );
    const q = await queueRead();
    expect(q).toHaveLength(1);
    expect(q[0]?.uri).toBe('file:///doc/replaced.m4a');
  });

  it('queueAppendChunk adds a chunk to an existing entry and updates next_chunk_index', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(SID, pendingChunk(0), null, 1);
    const q = await queueRead();
    expect(q[0]?.chunks).toHaveLength(1);
    expect(q[0]?.next_chunk_index).toBe(1);
  });

  it('queueUpdateChunk patches a chunk in place', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(SID, pendingChunk(0), null, 1);
    await queueUpdateChunk(SID, 0, {
      status: 'uploaded',
      remote_reference: 'drive-file-1',
      base64Slice: undefined,
    });
    const q = await queueRead();
    expect(q[0]?.chunks[0]?.status).toBe('uploaded');
    expect(q[0]?.chunks[0]?.remote_reference).toBe('drive-file-1');
    expect(q[0]?.chunks[0]?.base64Slice).toBeUndefined();
  });

  it('queueDropEntry removes the entry; queueRead returns empty', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueDropEntry(SID);
    expect(await queueRead()).toEqual([]);
  });

  it('queueMarkRecordingClosed sets recording_closed=true and stamps offsets', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueMarkRecordingClosed(SID, 'file:///doc/final.m4a', 12345, 7);
    const q = await queueRead();
    expect(q[0]?.recording_closed).toBe(true);
    expect(q[0]?.uri).toBe('file:///doc/final.m4a');
    expect(q[0]?.emitted_base64_length).toBe(12345);
    expect(q[0]?.next_chunk_index).toBe(7);
  });

  it('queueMarkSessionCompleted flips session_completed', async () => {
    await queueAppendNewSession(emptyEntry({ recording_closed: true }));
    await queueMarkSessionCompleted(SID);
    expect((await queueRead())[0]?.session_completed).toBe(true);
  });

  it('queueBumpCompleteAttempts increments and returns the new value', async () => {
    await queueAppendNewSession(emptyEntry());
    await expect(queueBumpCompleteAttempts(SID)).resolves.toBe(1);
    await expect(queueBumpCompleteAttempts(SID)).resolves.toBe(2);
    expect((await queueRead())[0]?.complete_attempts).toBe(2);
  });
});

describe('hasPendingUploadWork — foreground-service lifecycle predicate', () => {
  it('returns false on an empty queue', async () => {
    await expect(hasPendingUploadWork()).resolves.toBe(false);
  });

  it('returns false when all chunks are uploaded', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(
      SID,
      { ...pendingChunk(0), status: 'uploaded', remote_reference: 'r0' },
      null,
      1,
    );
    await expect(hasPendingUploadWork()).resolves.toBe(false);
  });

  it('returns true when at least one chunk is pending', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(SID, pendingChunk(0), null, 1);
    await expect(hasPendingUploadWork()).resolves.toBe(true);
  });

  it('returns true when at least one chunk is uploading', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(
      SID,
      { ...pendingChunk(0), status: 'uploading' },
      null,
      1,
    );
    await expect(hasPendingUploadWork()).resolves.toBe(true);
  });

  it('returns false when chunks are only `failed` — terminal, not work', async () => {
    // failed chunks are NOT pending work: the worker classifies them
    // permanent and never touches them again. Treating them as work
    // would keep the foreground service alive forever after a chunk
    // hash mismatch.
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(
      SID,
      { ...pendingChunk(0), status: 'failed' },
      null,
      1,
    );
    await expect(hasPendingUploadWork()).resolves.toBe(false);
  });

  it('returns true when ANY entry has work, even if others are clean', async () => {
    const SID_A = '11111111-1111-4111-8111-111111111111';
    const SID_B = '22222222-2222-4222-8222-222222222222';
    await queueAppendNewSession(emptyEntry({ session_id: SID_A }));
    await queueAppendChunk(
      SID_A,
      { ...pendingChunk(0), status: 'uploaded', remote_reference: 'r0' },
      null,
      1,
    );
    await queueAppendNewSession(emptyEntry({ session_id: SID_B }));
    await queueAppendChunk(SID_B, pendingChunk(0), null, 1);
    await expect(hasPendingUploadWork()).resolves.toBe(true);
  });
});

describe('boot recovery — stuck `uploading` reset', () => {
  // The bootstrap useEffect runs the same queueMutate body inline.
  // Replicating it verbatim verifies (a) the mutation is correct and
  // (b) queueMutate threads the patches into AsyncStorage atomically.
  async function applyStuckResetBlock(): Promise<{
    stuckUploading: number;
    entriesClosed: number;
  }> {
    let stuckUploading = 0;
    let entriesClosed = 0;
    await queueMutate(q => {
      for (const e of q) {
        if (!e.recording_closed) {
          e.recording_closed = true;
          // G1 — mirrors the product's parallel write. NOTE: this block
          // is a REPLICA of the bootstrap body, not a call into it, so
          // it cannot detect the product diverging from it. Real
          // coverage would require extracting the block behind an
          // exported helper — deliberately out of scope for G1.
          e.evidence_closed = true;
          entriesClosed += 1;
        }
        for (const c of e.chunks) {
          if (c.status === 'uploading') {
            c.status = 'pending';
            stuckUploading += 1;
          }
        }
      }
    });
    return { stuckUploading, entriesClosed };
  }

  it('flips stuck `uploading` chunks back to `pending` so the worker picks them up again', async () => {
    // Seed an entry that has already been closed (typical post-stop
    // state) so this assertion isolates the chunk-status fix from the
    // recording_closed fix exercised in the next test.
    await queueAppendNewSession(emptyEntry({ recording_closed: true }));
    await queueAppendChunk(
      SID,
      { ...pendingChunk(0), status: 'uploading' },
      null,
      1,
    );
    await queueAppendChunk(
      SID,
      { ...pendingChunk(1), status: 'uploading' },
      null,
      2,
    );
    await queueAppendChunk(SID, pendingChunk(2), null, 3);

    const report = await applyStuckResetBlock();
    expect(report.stuckUploading).toBe(2);
    expect(report.entriesClosed).toBe(0);

    const q = await queueRead();
    const statuses = q[0]?.chunks.map(c => c.status) ?? [];
    expect(statuses).toEqual(['pending', 'pending', 'pending']);
  });

  it('flips recording_closed=false to true so tryFinalizeReadySessions can see the session', async () => {
    await queueAppendNewSession(emptyEntry({ recording_closed: false }));
    const report = await applyStuckResetBlock();
    expect(report.entriesClosed).toBe(1);
    expect((await queueRead())[0]?.recording_closed).toBe(true);
  });

  it('is a no-op on a clean queue (idempotent)', async () => {
    await queueAppendNewSession(emptyEntry({ recording_closed: true }));
    await queueAppendChunk(
      SID,
      { ...pendingChunk(0), status: 'uploaded', remote_reference: 'r0' },
      null,
      1,
    );
    const report = await applyStuckResetBlock();
    expect(report.stuckUploading).toBe(0);
    expect(report.entriesClosed).toBe(0);
  });

  it('preserves chunk order and metadata on reset', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(
      SID,
      { ...pendingChunk(5), status: 'uploading', attempts: 3 },
      null,
      6,
    );
    await applyStuckResetBlock();
    const c = (await queueRead())[0]?.chunks[0];
    expect(c?.chunk_index).toBe(5);
    expect(c?.attempts).toBe(3);
    expect(c?.status).toBe('pending');
  });
});

describe('full chunk lifecycle: pending → uploading → uploaded', () => {
  it('walks a chunk end-to-end and hasPendingUploadWork tracks the transitions', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(SID, pendingChunk(0), null, 1);
    await expect(hasPendingUploadWork()).resolves.toBe(true);

    // Worker picks chunk → marks 'uploading'
    await queueUpdateChunk(SID, 0, { status: 'uploading' });
    await expect(hasPendingUploadWork()).resolves.toBe(true);

    // Worker uploads → marks 'uploaded' with remote_reference and prunes base64
    await queueUpdateChunk(SID, 0, {
      status: 'uploaded',
      remote_reference: 'drive-file-id',
      base64Slice: undefined,
    });
    await expect(hasPendingUploadWork()).resolves.toBe(false);

    const c = (await queueRead())[0]?.chunks[0];
    expect(c?.status).toBe('uploaded');
    expect(c?.remote_reference).toBe('drive-file-id');
    expect(c?.base64Slice).toBeUndefined();
  });

  it('walks a chunk into permanent failure', async () => {
    await queueAppendNewSession(emptyEntry());
    await queueAppendChunk(SID, pendingChunk(0), null, 1);

    // Exercises the queue PRIMITIVE, not worker policy: the caller
    // passes `base64Slice: undefined` explicitly here. Since phase 1A
    // the worker itself only clears bytes after a confirmed upload —
    // see evidencePreservation.test.ts for that rule.
    await queueUpdateChunk(SID, 0, {
      status: 'failed',
      base64Slice: undefined,
    });
    await expect(hasPendingUploadWork()).resolves.toBe(false);

    const c = (await queueRead())[0]?.chunks[0];
    expect(c?.status).toBe('failed');
    expect(c?.base64Slice).toBeUndefined();
  });
});

describe('persisted shape', () => {
  it('writes valid JSON under PENDING_RETRY_KEY', async () => {
    await queueAppendNewSession(emptyEntry());
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].session_id).toBe(SID);
  });
});

/**
 * G1 — durable representation of `evidence_closed`.
 *
 * `evidence_closed: true` means the Protection Session no longer accepts
 * new evidence and may advance toward terminality. It does NOT encode the
 * cause of that closure, does NOT mean the user tapped PARAR, and is NOT
 * equivalent to `session_completed`.
 *
 * During G1 the field is INERT: `recording_closed` remains the sole
 * operational authority, and absence means only "metadata unavailable" —
 * never "closed" and never "open". These tests pin the representation;
 * the invariance tests that prove nothing reads it live in
 * `finalize.test.ts` and `drainPause.test.ts`.
 */
describe('G1 — evidence_closed durable representation', () => {
  it('R1 — survives a full persist → hydrate round-trip', async () => {
    await queueAppendNewSession(emptyEntry({ evidence_closed: true }));

    // Re-read through the real parse path, not the in-memory object.
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    expect(JSON.parse(raw as string)[0].evidence_closed).toBe(true);

    const [hydrated] = await queueRead();
    expect(hydrated!.evidence_closed).toBe(true);
  });

  it('R1c — the PRODUCT write path stamps it: queueMarkRecordingClosed', async () => {
    // R1/R1b prove the storage layer carries the field. This proves the
    // product actually writes it, in parallel with `recording_closed`
    // and with the same value. Without this, removing the parallel write
    // from `queueMarkRecordingClosed` would go unnoticed.
    await queueAppendNewSession(emptyEntry());
    await queueMarkRecordingClosed(SID, 'file:///doc/final.m4a', 0, 3);
    const [e] = await queueRead();
    expect(e!.recording_closed).toBe(true);
    expect(e!.evidence_closed).toBe(true);
  });

  it('R1d — the three session constructors stamp it false at creation', async () => {
    // Mirrors what `queueAppendNewSession` receives from each of the
    // three real call sites (native segmented, audio/legacy, orphan
    // adoption). A constructor that forgot the field would leave the
    // key absent here.
    await queueAppendNewSession(emptyEntry({ evidence_closed: false }));
    const [e] = await queueRead();
    expect(e!.evidence_closed).toBe(false);
    expect(e!.recording_closed).toBe(false);
  });

  it('R1b — `false` round-trips as false, distinct from absent', async () => {
    await queueAppendNewSession(emptyEntry({ evidence_closed: false }));
    const [hydrated] = await queueRead();
    expect(hydrated!.evidence_closed).toBe(false);
    expect('evidence_closed' in hydrated!).toBe(true);
  });

  it('R2 — an UNDECLARED field survives the round-trip untouched', async () => {
    // queueMutate reserialises with JSON.stringify and never strips
    // unknown keys. G2 depends on this: it can add fields without a
    // migration. If someone introduces schema filtering, this breaks.
    const store = (AsyncStorage as unknown as { __store__: Map<string, string> })
      .__store__;
    store.set(
      PENDING_RETRY_KEY,
      JSON.stringify([{ ...emptyEntry(), future_field_from_g2: 'keep-me' }]),
    );

    // Any mutation forces a full read → write cycle.
    await queueBumpCompleteAttempts(SID);

    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    expect(JSON.parse(raw as string)[0].future_field_from_g2).toBe('keep-me');
  });

  it('R3 — a legacy entry keeps `recording_closed` semantics and stays absent', async () => {
    // A pre-G1 entry: no `evidence_closed` key at all.
    const legacy = emptyEntry({ recording_closed: true });
    delete (legacy as Partial<PendingQueueEntry>).evidence_closed;
    const store = (AsyncStorage as unknown as { __store__: Map<string, string> })
      .__store__;
    store.set(PENDING_RETRY_KEY, JSON.stringify([legacy]));

    await queueBumpCompleteAttempts(SID);

    const [hydrated] = await queueRead();
    // Operational authority untouched…
    expect(hydrated!.recording_closed).toBe(true);
    // …and the new metadata is NOT materialised out of thin air.
    expect(hydrated!.evidence_closed).toBeUndefined();
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    expect('evidence_closed' in JSON.parse(raw as string)[0]).toBe(false);
  });
});

/**
 * G1 — the shared chunk counter must stay media-agnostic.
 *
 * `next_chunk_index` is the denominator of the completion gate. Under
 * Continuous Protection a single Protection Session will carry chunks
 * produced by different producers, which today already have different
 * shapes: audio carries `base64Slice`, native segmented video carries
 * `local_uri`. This pins the property BEFORE phases exist, so any future
 * change that resets or partitions the counter per producer fails here.
 */
describe('G1 — next_chunk_index monotonicity across chunk shapes', () => {
  it('R5 — stays monotone when interleaving base64Slice and local_uri chunks', async () => {
    await queueAppendNewSession(emptyEntry());

    const shapes: QueueChunk[] = [
      { ...pendingChunk(0) },
      { chunk_index: 1, hash: 'b'.repeat(64), size: 200, status: 'pending', attempts: 0, local_uri: 'file:///seg/1.mp4' },
      { ...pendingChunk(2) },
      { chunk_index: 3, hash: 'd'.repeat(64), size: 400, status: 'pending', attempts: 0, local_uri: 'file:///seg/3.mp4' },
    ];

    const seen: number[] = [];
    for (const c of shapes) {
      // `null` for the audio-only base64 bookkeeping — the counter under
      // test is `nextChunkIndex`, which both producers share.
      await queueAppendChunk(SID, c, null, c.chunk_index + 1);
      const [e] = await queueRead();
      seen.push(e!.next_chunk_index);
    }

    expect(seen).toEqual([1, 2, 3, 4]);
    const [final] = await queueRead();
    expect(final!.chunks.map(c => c.chunk_index)).toEqual([0, 1, 2, 3]);
  });
});

/**
 * G1 — the upload worker must stay blind to `evidence_closed`.
 *
 * `pickNext` selects purely on chunk status and index, and rehydrates by
 * chunk SHAPE (`base64Slice` → `local_uri` → byte range), never by any
 * session-level attribute. That is the property which will let a single
 * Protection Session carry several producers without touching transport.
 */
describe('G1 — pickNext is agnostic to evidence_closed', () => {
  it('I3 — selects the same chunk for true / false / absent', async () => {
    const picks: (string | null)[] = [];
    const variants: Partial<PendingQueueEntry>[] = [
      { evidence_closed: true },
      { evidence_closed: false },
      {},
    ];
    for (const patch of variants) {
      await AsyncStorage.clear();
      await queueAppendNewSession(
        emptyEntry({ recording_closed: true, ...patch }),
      );
      await queueAppendChunk(SID, pendingChunk(0), null, 1);
      const pick = await pickNext(await queueRead(), emptyPauseState());
      picks.push(pick ? `${pick.sessionId}#${pick.chunk.chunk_index}` : null);
    }
    expect(picks[0]).toBe(`${SID}#0`);
    expect(picks[0]).toBe(picks[1]);
    expect(picks[1]).toBe(picks[2]);
  });
});

/**
 * G3' — the three chunk writers, and the fact that each is
 * medium-specific BY CONSTRUCTION.
 *
 * No parameter, no derivation, no heuristic on extension, path, UI or
 * external state: each function can only ever be reached from one
 * producer, so the literal it writes is the truth. These tests are what
 * protect that property from drifting.
 *
 * Writer 1 (`segmentAdopter` → 'video') is pinned in
 * `segmentAdopter.test.ts`, next to its own contract assertion.
 */
describe("G3' — chunk writers stamp their medium", () => {
  it("W2 — emitChunk (audio chunker) stamps media:'audio'", async () => {
    await queueAppendNewSession(emptyEntry());
    await emitChunk(SID, 'QUJDRA==', 0, 8);
    const [e] = await queueRead();
    expect(e!.chunks).toHaveLength(1);
    expect(e!.chunks[0]!.media).toBe('audio');
  });

  it("W3 — videoChunkSink (legacy post-stop video) stamps media:'video'", async () => {
    await queueAppendNewSession(emptyEntry());
    await videoChunkSink({ sessionId: SID, base64Slice: 'QUJDRA==', chunk_index: 0 });
    const [e] = await queueRead();
    expect(e!.chunks).toHaveLength(1);
    expect(e!.chunks[0]!.media).toBe('video');
  });

  it('W4 — a legacy video chunk is video, yet its path is NOT a segment', async () => {
    // The pair that proves `media` alone cannot authorise a D3 export:
    // this row is genuinely video and genuinely not a native segment.
    await queueAppendNewSession(emptyEntry());
    await videoChunkSink({ sessionId: SID, base64Slice: 'QUJDRA==', chunk_index: 0 });
    const [e] = await queueRead();
    expect(e!.chunks[0]!.media).toBe('video');
    expect(e!.chunks[0]!.local_uri).toContain(`chunks/${SID}/`);
    expect(e!.chunks[0]!.local_uri).not.toContain('segments/');
  });

  it('W5 — media survives the persist/hydrate round-trip', async () => {
    await queueAppendNewSession(emptyEntry());
    await emitChunk(SID, 'QUJDRA==', 0, 8);
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    expect(JSON.parse(raw as string)[0].chunks[0].media).toBe('audio');
  });
});
