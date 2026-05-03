/**
 * Tests for `migrateLegacyPendingState`.
 *
 * The bootstrap reads `PENDING_RETRY_KEY` and may find it written by a
 * previous build of the app in the legacy single-session shape:
 *
 *   { session_id, remaining: [{chunk_index, hash, size}], uri? }
 *
 * `queueMutate` lifts a non-array value into `[obj]` on read (see
 * its inline comment), so the migration sees that single-object case
 * as a length-1 array of legacy-shaped entries. The migration upgrades
 * each legacy entry into the modern `PendingQueueEntry` shape WITHOUT
 * losing chunk identity. Idempotent: running over an already-migrated
 * queue is a no-op.
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
  migrateLegacyPendingState,
  queueRead,
} from '../app/index';

const SID = '11111111-1111-4111-8111-111111111111';

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.clearAllMocks();
});

describe('migrateLegacyPendingState', () => {
  it('upgrades a legacy single-session object to the array shape with chunks', async () => {
    // Legacy persisted shape: ONE object (not an array) with `remaining`.
    const legacy = {
      session_id: SID,
      uri: 'file:///doc/legacy.m4a',
      remaining: [
        { chunk_index: 0, hash: 'h0'.repeat(32), size: 100 },
        { chunk_index: 1, hash: 'h1'.repeat(32), size: 110 },
        { chunk_index: 2, hash: 'h2'.repeat(32), size: 120 },
      ],
    };
    await AsyncStorage.setItem(PENDING_RETRY_KEY, JSON.stringify(legacy));

    await migrateLegacyPendingState();

    const q = await queueRead();
    expect(q).toHaveLength(1);
    const e = q[0]!;
    expect(e.session_id).toBe(SID);
    expect(e.uri).toBe('file:///doc/legacy.m4a');
    // Legacy → recording_closed is true (state was written after STOP).
    expect(e.recording_closed).toBe(true);
    expect(e.session_completed).toBe(false);
    expect(e.complete_attempts).toBe(0);
    expect(e.emitted_base64_length).toBe(0);
    // next_chunk_index = max(chunk_index) + 1
    expect(e.next_chunk_index).toBe(3);
    // Chunks carried over with status='pending' and attempts=0.
    expect(e.chunks).toHaveLength(3);
    expect(e.chunks[0]).toEqual({
      chunk_index: 0,
      hash: 'h0'.repeat(32),
      size: 100,
      status: 'pending',
      attempts: 0,
    });
  });

  it('handles legacy entry with empty `remaining`', async () => {
    const legacy = {
      session_id: SID,
      uri: 'file:///doc/empty.m4a',
      remaining: [],
    };
    await AsyncStorage.setItem(PENDING_RETRY_KEY, JSON.stringify(legacy));

    await migrateLegacyPendingState();

    const q = await queueRead();
    expect(q).toHaveLength(1);
    expect(q[0]?.chunks).toEqual([]);
    expect(q[0]?.next_chunk_index).toBe(0);
    expect(q[0]?.recording_closed).toBe(true);
  });

  it('handles legacy entry with no `uri` (very old build)', async () => {
    const legacy = {
      session_id: SID,
      remaining: [{ chunk_index: 0, hash: 'h0'.repeat(32), size: 50 }],
    };
    await AsyncStorage.setItem(PENDING_RETRY_KEY, JSON.stringify(legacy));

    await migrateLegacyPendingState();

    const q = await queueRead();
    expect(q[0]?.uri).toBe('');
  });

  it('is idempotent on an already-migrated queue (no-op)', async () => {
    const modern = [
      {
        session_id: SID,
        uri: 'file:///doc/modern.m4a',
        recording_closed: true,
        session_completed: false,
        complete_attempts: 0,
        emitted_base64_length: 1234,
        next_chunk_index: 2,
        chunks: [
          {
            chunk_index: 0,
            hash: 'h0'.repeat(32),
            size: 100,
            status: 'uploaded',
            attempts: 0,
            remote_reference: 'drive-0',
          },
          {
            chunk_index: 1,
            hash: 'h1'.repeat(32),
            size: 110,
            status: 'pending',
            attempts: 1,
          },
        ],
      },
    ];
    await AsyncStorage.setItem(PENDING_RETRY_KEY, JSON.stringify(modern));

    await migrateLegacyPendingState();

    const q = await queueRead();
    expect(q).toEqual(modern);
  });

  it('is a no-op on an empty queue', async () => {
    await migrateLegacyPendingState();
    const q = await queueRead();
    expect(q).toEqual([]);
  });

  it('migration of legacy preserves chunk_index ordering for next_chunk_index', async () => {
    // Out-of-order chunk_index in `remaining` should not break the
    // max+1 calculation. Real legacy entries can be unsorted.
    const legacy = {
      session_id: SID,
      remaining: [
        { chunk_index: 5, hash: 'h5'.repeat(32), size: 100 },
        { chunk_index: 0, hash: 'h0'.repeat(32), size: 100 },
        { chunk_index: 3, hash: 'h3'.repeat(32), size: 100 },
      ],
    };
    await AsyncStorage.setItem(PENDING_RETRY_KEY, JSON.stringify(legacy));

    await migrateLegacyPendingState();

    const q = await queueRead();
    expect(q[0]?.next_chunk_index).toBe(6);
    expect(q[0]?.chunks).toHaveLength(3);
  });
});
