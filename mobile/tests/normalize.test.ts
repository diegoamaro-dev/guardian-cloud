/**
 * Tests for `normalizeQueueOnRecovery`.
 *
 * Three cleanup steps run in order on the persisted queue:
 *
 *   1. Multiple entries with the same session_id → merged into the
 *      first (chunks concatenated; flags merged via OR/max).
 *   2. Within an entry, exact (chunk_index, hash) duplicates → keep
 *      one; prefer status='uploaded' so we don't lose remote_reference.
 *   3. Within an entry, same chunk_index BUT different hash → mark
 *      every chunk in the entry as `failed` with code
 *      `CORRUPT_HASH_DIVERGENCE`.
 *
 * Idempotent: re-running on a clean queue returns an all-zero report.
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PENDING_RETRY_KEY,
  normalizeQueueOnRecovery,
  queueRead,
  type PendingQueueEntry,
  type QueueChunk,
} from '../app/index';

const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function entry(overrides: Partial<PendingQueueEntry> = {}): PendingQueueEntry {
  return {
    session_id: SID_A,
    uri: 'file:///doc/x.m4a',
    recording_closed: false,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 0,
    chunks: [],
    ...overrides,
  };
}

function chunk(idx: number, hash: string, status: QueueChunk['status'] = 'pending'): QueueChunk {
  return {
    chunk_index: idx,
    hash,
    size: 100,
    status,
    attempts: 0,
  };
}

async function seed(q: PendingQueueEntry[]): Promise<void> {
  await AsyncStorage.setItem(PENDING_RETRY_KEY, JSON.stringify(q));
}

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.clearAllMocks();
});

describe('normalizeQueueOnRecovery — idempotency', () => {
  it('returns an all-zero report on an empty queue', async () => {
    const report = await normalizeQueueOnRecovery();
    expect(report).toEqual({
      entries_collapsed: 0,
      exact_duplicates_dropped: 0,
      sessions_marked_corrupt: 0,
      chunks_marked_failed: 0,
    });
  });

  it('returns all-zero on a clean queue (no duplicates, no divergence)', async () => {
    await seed([
      entry({
        chunks: [chunk(0, 'a'.repeat(64)), chunk(1, 'b'.repeat(64))],
      }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report).toEqual({
      entries_collapsed: 0,
      exact_duplicates_dropped: 0,
      sessions_marked_corrupt: 0,
      chunks_marked_failed: 0,
    });
    expect((await queueRead())[0]?.chunks).toHaveLength(2);
  });
});

describe('normalizeQueueOnRecovery — Step 1: collapse duplicate session_id entries', () => {
  it('merges chunks from a duplicate entry into the first occurrence', async () => {
    await seed([
      entry({
        chunks: [chunk(0, 'a'.repeat(64))],
      }),
      entry({
        chunks: [chunk(1, 'b'.repeat(64))],
      }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report.entries_collapsed).toBe(1);

    const q = await queueRead();
    expect(q).toHaveLength(1);
    expect(q[0]?.chunks).toHaveLength(2);
    expect(q[0]?.chunks.map(c => c.chunk_index).sort()).toEqual([0, 1]);
  });

  it('merges flags via OR (recording_closed, session_completed)', async () => {
    await seed([
      entry({ recording_closed: false, session_completed: false }),
      entry({ recording_closed: true, session_completed: true }),
    ]);
    await normalizeQueueOnRecovery();
    const e = (await queueRead())[0]!;
    expect(e.recording_closed).toBe(true);
    expect(e.session_completed).toBe(true);
  });

  it('merges offsets via max (emitted_base64_length, next_chunk_index, complete_attempts)', async () => {
    await seed([
      entry({
        emitted_base64_length: 100,
        next_chunk_index: 5,
        complete_attempts: 2,
      }),
      entry({
        emitted_base64_length: 200,
        next_chunk_index: 3,
        complete_attempts: 4,
      }),
    ]);
    await normalizeQueueOnRecovery();
    const e = (await queueRead())[0]!;
    expect(e.emitted_base64_length).toBe(200);
    expect(e.next_chunk_index).toBe(5);
    expect(e.complete_attempts).toBe(4);
  });

  it('does NOT merge entries that have different session_ids', async () => {
    await seed([
      entry({ session_id: SID_A }),
      entry({ session_id: SID_B }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report.entries_collapsed).toBe(0);
    expect(await queueRead()).toHaveLength(2);
  });
});

describe('normalizeQueueOnRecovery — Step 2: exact-duplicate chunks', () => {
  it('drops exact (chunk_index, hash) duplicates and keeps one', async () => {
    const h = 'a'.repeat(64);
    await seed([
      entry({ chunks: [chunk(0, h), chunk(0, h), chunk(1, 'b'.repeat(64))] }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report.exact_duplicates_dropped).toBe(1);
    expect(report.sessions_marked_corrupt).toBe(0);

    const q = await queueRead();
    expect(q[0]?.chunks).toHaveLength(2);
    expect(q[0]?.chunks.map(c => c.chunk_index)).toEqual([0, 1]);
  });

  it('prefers `uploaded` over other statuses so remote_reference survives', async () => {
    const h = 'a'.repeat(64);
    const pendingDup: QueueChunk = {
      ...chunk(0, h, 'pending'),
      attempts: 5,
    };
    const uploadedDup: QueueChunk = {
      ...chunk(0, h, 'uploaded'),
      remote_reference: 'drive-file-0',
    };
    await seed([entry({ chunks: [pendingDup, uploadedDup] })]);

    const report = await normalizeQueueOnRecovery();
    expect(report.exact_duplicates_dropped).toBe(1);

    const kept = (await queueRead())[0]?.chunks[0];
    expect(kept?.status).toBe('uploaded');
    expect(kept?.remote_reference).toBe('drive-file-0');
  });

  it('chunks across different chunk_index are independent (not deduped)', async () => {
    await seed([
      entry({
        chunks: [
          chunk(0, 'a'.repeat(64)),
          chunk(1, 'a'.repeat(64)), // same hash, DIFFERENT index → kept
        ],
      }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report.exact_duplicates_dropped).toBe(0);
    expect((await queueRead())[0]?.chunks).toHaveLength(2);
  });
});

describe('normalizeQueueOnRecovery — Step 3: hash divergence at same chunk_index', () => {
  it('marks every chunk in the entry as `failed` with CORRUPT_HASH_DIVERGENCE', async () => {
    await seed([
      entry({
        chunks: [
          chunk(0, 'a'.repeat(64)),
          chunk(0, 'b'.repeat(64)), // same idx, different hash → corrupt
          chunk(1, 'c'.repeat(64)),
        ],
      }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report.sessions_marked_corrupt).toBe(1);
    expect(report.chunks_marked_failed).toBeGreaterThan(0);

    const e = (await queueRead())[0]!;
    expect(e.chunks.every(c => c.status === 'failed')).toBe(true);
    expect(e.chunks[0]?.last_error?.code).toBe('CORRUPT_HASH_DIVERGENCE');
    // base64Slice purged on failed.
    expect(e.chunks.every(c => c.base64Slice === undefined)).toBe(true);
  });

  it('preserves chunks server-side: corrupt entry is NOT deleted from the queue', async () => {
    await seed([
      entry({
        chunks: [
          chunk(0, 'a'.repeat(64)),
          chunk(0, 'b'.repeat(64)),
        ],
      }),
    ]);
    await normalizeQueueOnRecovery();
    expect(await queueRead()).toHaveLength(1);
  });

  it('sorts the failed chunks by chunk_index in the corrupted entry', async () => {
    await seed([
      entry({
        chunks: [
          chunk(2, 'c'.repeat(64)),
          chunk(0, 'a'.repeat(64)),
          chunk(0, 'b'.repeat(64)),
          chunk(1, 'd'.repeat(64)),
        ],
      }),
    ]);
    await normalizeQueueOnRecovery();
    const e = (await queueRead())[0]!;
    const idxs = e.chunks.map(c => c.chunk_index);
    // Sorted ascending — see Step 3 sort step.
    for (let i = 1; i < idxs.length; i++) {
      expect((idxs[i] ?? 0) >= (idxs[i - 1] ?? 0)).toBe(true);
    }
  });

  it('only the corrupt entry is marked, others stay clean', async () => {
    await seed([
      entry({
        session_id: SID_A,
        chunks: [chunk(0, 'a'.repeat(64)), chunk(0, 'b'.repeat(64))],
      }),
      entry({
        session_id: SID_B,
        chunks: [chunk(0, 'x'.repeat(64))],
      }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report.sessions_marked_corrupt).toBe(1);

    const q = await queueRead();
    const a = q.find(e => e.session_id === SID_A)!;
    const b = q.find(e => e.session_id === SID_B)!;
    expect(a.chunks.every(c => c.status === 'failed')).toBe(true);
    expect(b.chunks[0]?.status).toBe('pending');
  });
});

describe('normalizeQueueOnRecovery — combined scenarios', () => {
  it('collapses duplicate session entries AND then dedupes exact chunks across them', async () => {
    const h = 'a'.repeat(64);
    await seed([
      entry({ chunks: [chunk(0, h)] }),
      entry({ chunks: [chunk(0, h), chunk(1, 'b'.repeat(64))] }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report.entries_collapsed).toBe(1);
    expect(report.exact_duplicates_dropped).toBe(1);

    const q = await queueRead();
    expect(q).toHaveLength(1);
    expect(q[0]?.chunks).toHaveLength(2);
  });
});
