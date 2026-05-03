/**
 * Tests for `tryFinalizeReadySessions`, `reapEntry`, and
 * `reapAlreadyDoneEntries`.
 *
 * `tryFinalizeReadySessions` walks every queue entry and decides whether
 * the worker should call `POST /sessions/:id/complete` (the backend
 * lifecycle terminator) and/or reap the entry from the local queue.
 * The completion-gate is the safety rail: it MUST NOT call complete
 * if any chunk_index in 0..next_chunk_index-1 is missing or not
 * uploaded, otherwise the backend marks a session "done" with gaps.
 *
 * Lifecycle covered:
 *   - skip: recording_closed=false (worker may still be emitting)
 *   - skip: any chunk pending/uploading (still in motion)
 *   - block: missing chunk_index in 0..next-1 → no complete, no reap
 *   - happy path: all uploaded → completeSession called → marked
 *     completed → reaped
 *   - already-completed: session_completed=true → reap directly
 *   - give up: complete_attempts >= MAX → reap with give-up log
 *   - completeSession fails → bumpCompleteAttempts, no reap
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
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

// `tryFinalizeReadySessions` reads a token via getFreshAccessToken and
// then calls completeSession, which uses global `fetch`. We control
// both so each test asserts the exact decision branch.
vi.mock('@/auth/store', () => ({
  useAuthStore: { setState: vi.fn(), getState: vi.fn(() => ({ status: 'loading' })) },
  getFreshAccessToken: vi.fn(async () => 'test-token'),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFreshAccessToken } from '@/auth/store';
import {
  MAX_COMPLETE_ATTEMPTS,
  PENDING_RETRY_KEY,
  queueAppendNewSession,
  queueRead,
  reapAlreadyDoneEntries,
  reapEntry,
  tryFinalizeReadySessions,
  type PendingQueueEntry,
  type QueueChunk,
} from '../app/index';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function entry(overrides: Partial<PendingQueueEntry> = {}): PendingQueueEntry {
  return {
    session_id: SID,
    uri: 'file:///doc/rec.m4a',
    recording_closed: true,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 0,
    chunks: [],
    ...overrides,
  };
}

function uploadedChunk(idx: number): QueueChunk {
  return {
    chunk_index: idx,
    hash: ('h' + idx).repeat(32).slice(0, 64),
    size: 100,
    status: 'uploaded',
    attempts: 0,
    remote_reference: `drive-${idx}`,
  };
}

function pendingChunk(idx: number): QueueChunk {
  return {
    chunk_index: idx,
    hash: ('h' + idx).repeat(32).slice(0, 64),
    size: 100,
    status: 'pending',
    attempts: 0,
    base64Slice: 'AAAA',
  };
}

function failedChunk(idx: number): QueueChunk {
  return {
    chunk_index: idx,
    hash: ('h' + idx).repeat(32).slice(0, 64),
    size: 100,
    status: 'failed',
    attempts: 5,
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.clearAllMocks();
  vi.mocked(getFreshAccessToken).mockResolvedValue('test-token');
  // Default fetch — will be overridden per test.
  vi.stubGlobal('fetch', vi.fn());
});

describe('tryFinalizeReadySessions — skip conditions', () => {
  it('skips entries where recording_closed=false (worker may still emit)', async () => {
    await queueAppendNewSession(
      entry({
        recording_closed: false,
        next_chunk_index: 1,
        chunks: [uploadedChunk(0)],
      }),
    );
    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    // Entry untouched.
    expect(await queueRead()).toHaveLength(1);
  });

  it('skips entries with at least one pending chunk', async () => {
    await queueAppendNewSession(
      entry({
        recording_closed: true,
        next_chunk_index: 2,
        chunks: [uploadedChunk(0), pendingChunk(1)],
      }),
    );
    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips entries with at least one uploading chunk', async () => {
    await queueAppendNewSession(
      entry({
        recording_closed: true,
        next_chunk_index: 2,
        chunks: [uploadedChunk(0), { ...pendingChunk(1), status: 'uploading' }],
      }),
    );
    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('tryFinalizeReadySessions — completion gate', () => {
  it('blocks completeSession when an expected chunk_index has no `uploaded` row', async () => {
    // next_chunk_index=3 means chunks 0..2 must each be `uploaded`.
    // chunk_index=1 is `failed` → gate blocks the complete call.
    await queueAppendNewSession(
      entry({
        next_chunk_index: 3,
        chunks: [uploadedChunk(0), failedChunk(1), uploadedChunk(2)],
      }),
    );
    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    // Entry stays in queue (no reap) for manual reconciliation.
    expect(await queueRead()).toHaveLength(1);
  });

  it('blocks completeSession when an expected chunk_index is absent from chunks[]', async () => {
    // next_chunk_index=3 expects {0,1,2} but chunks[] has only {0,2}.
    // The "absent" diagnostic in the function should kick in.
    await queueAppendNewSession(
      entry({
        next_chunk_index: 3,
        chunks: [uploadedChunk(0), uploadedChunk(2)],
      }),
    );
    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await queueRead()).toHaveLength(1);
  });

  it('blocks completeSession when an uploaded chunk has NO remote_reference', async () => {
    // uploaded but no remote_reference is treated as "not really uploaded"
    // by the gate — completeSession would mark a session done with a
    // chunk pointing at nothing in Drive.
    const noRef: QueueChunk = { ...uploadedChunk(1), remote_reference: null };
    await queueAppendNewSession(
      entry({
        next_chunk_index: 2,
        chunks: [uploadedChunk(0), noRef],
      }),
    );
    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('tryFinalizeReadySessions — happy path', () => {
  it('calls completeSession, marks session_completed, then reaps the entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ session_id: SID, status: 'completed' }),
      })),
    );

    await queueAppendNewSession(
      entry({
        next_chunk_index: 2,
        chunks: [uploadedChunk(0), uploadedChunk(1)],
      }),
    );

    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const callUrl = vi.mocked(global.fetch).mock.calls[0]?.[0];
    expect(String(callUrl)).toContain(`/sessions/${SID}/complete`);

    // Reaped → queue empty.
    expect(await queueRead()).toEqual([]);
  });

  it('with session_completed=true already, REAPS without calling complete again', async () => {
    await queueAppendNewSession(
      entry({
        session_completed: true,
        next_chunk_index: 1,
        chunks: [uploadedChunk(0)],
      }),
    );

    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await queueRead()).toEqual([]);
  });

  it('with complete_attempts >= MAX_COMPLETE_ATTEMPTS, gives up and reaps without calling complete', async () => {
    await queueAppendNewSession(
      entry({
        complete_attempts: MAX_COMPLETE_ATTEMPTS,
        next_chunk_index: 1,
        chunks: [uploadedChunk(0)],
      }),
    );
    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await queueRead()).toEqual([]);
  });
});

describe('tryFinalizeReadySessions — completeSession failure', () => {
  it('bumps complete_attempts and leaves the entry on a 5xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: 'upstream' }),
      })),
    );
    await queueAppendNewSession(
      entry({
        next_chunk_index: 1,
        chunks: [uploadedChunk(0)],
      }),
    );

    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const q = await queueRead();
    expect(q).toHaveLength(1);
    expect(q[0]?.complete_attempts).toBe(1);
    // Not marked completed.
    expect(q[0]?.session_completed).toBe(false);
  });

  it('bumps complete_attempts and leaves the entry when getFreshAccessToken returns null', async () => {
    vi.mocked(getFreshAccessToken).mockResolvedValue(null);
    await queueAppendNewSession(
      entry({
        next_chunk_index: 1,
        chunks: [uploadedChunk(0)],
      }),
    );

    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    const q = await queueRead();
    expect(q[0]?.complete_attempts).toBe(1);
  });

  it('repeats failures across calls until complete_attempts hits the cap → then reaps with give-up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })),
    );
    await queueAppendNewSession(
      entry({
        next_chunk_index: 1,
        chunks: [uploadedChunk(0)],
      }),
    );

    // Call MAX_COMPLETE_ATTEMPTS times — each fails, complete_attempts
    // bumps from 0→1→2→…→MAX. At the next call, the give-up branch
    // triggers and reaps without calling fetch.
    for (let i = 0; i < MAX_COMPLETE_ATTEMPTS; i++) {
      await tryFinalizeReadySessions();
    }
    const q = await queueRead();
    expect(q[0]?.complete_attempts).toBe(MAX_COMPLETE_ATTEMPTS);

    const finalized = await tryFinalizeReadySessions();
    expect(finalized).toBe(true);
    expect(await queueRead()).toEqual([]);
  });
});

describe('reapEntry — drops the entry from the queue', () => {
  it('removes the entry by session_id', async () => {
    await queueAppendNewSession(entry());
    await reapEntry(SID, 'file:///doc/rec.m4a');
    expect(await queueRead()).toEqual([]);
  });

  it('is a no-op when the entry is already gone', async () => {
    // Should not throw.
    await expect(reapEntry(SID, 'file:///doc/missing.m4a')).resolves.toBeUndefined();
  });
});

describe('reapAlreadyDoneEntries — boot-time pre-reap', () => {
  it('reaps entries where session_completed=true AND no chunks pending', async () => {
    await queueAppendNewSession(
      entry({
        session_completed: true,
        chunks: [uploadedChunk(0)],
      }),
    );
    const { reaped } = await reapAlreadyDoneEntries();
    expect(reaped).toBe(1);
    expect(await queueRead()).toEqual([]);
  });

  it('does NOT reap entries where session_completed=false', async () => {
    await queueAppendNewSession(
      entry({
        session_completed: false,
        chunks: [uploadedChunk(0)],
      }),
    );
    const { reaped } = await reapAlreadyDoneEntries();
    expect(reaped).toBe(0);
    expect(await queueRead()).toHaveLength(1);
  });

  it('does NOT reap entries with at least one pending chunk (invariant violation visible)', async () => {
    await queueAppendNewSession(
      entry({
        session_completed: true,
        chunks: [uploadedChunk(0), pendingChunk(1)],
      }),
    );
    const { reaped } = await reapAlreadyDoneEntries();
    expect(reaped).toBe(0);
    expect(await queueRead()).toHaveLength(1);
  });

  it('reaps multiple in the same pass and returns the count', async () => {
    const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await queueAppendNewSession(
      entry({
        session_id: SID_A,
        session_completed: true,
        chunks: [uploadedChunk(0)],
      }),
    );
    await queueAppendNewSession(
      entry({
        session_id: SID_B,
        session_completed: true,
        chunks: [uploadedChunk(0)],
      }),
    );
    const { reaped } = await reapAlreadyDoneEntries();
    expect(reaped).toBe(2);
    expect(await queueRead()).toEqual([]);
  });
});

describe('persistence sanity', () => {
  it('reapEntry leaves the AsyncStorage value as a valid JSON array', async () => {
    await queueAppendNewSession(entry());
    await reapEntry(SID, 'file:///doc/rec.m4a');
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    expect(raw).not.toBeNull();
    expect(Array.isArray(JSON.parse(raw as string))).toBe(true);
  });
});
