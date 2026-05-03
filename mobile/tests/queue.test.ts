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
  type PendingQueueEntry,
  type QueueChunk,
} from '../app/index';

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

    // Worker marks failed (permanent) → base64Slice purged → no longer work
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
