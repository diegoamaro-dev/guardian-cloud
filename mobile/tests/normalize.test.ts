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
    // Seed real bytes. The previous version of this test asserted that
    // `base64Slice` came back undefined, but its `chunk()` helper never
    // set one — so the assertion was vacuous and silently blessed a
    // recovery path that destroyed unconfirmed evidence.
    await seed([
      entry({
        chunks: [
          { ...chunk(0, 'a'.repeat(64)), base64Slice: 'AAAA' },
          { ...chunk(0, 'b'.repeat(64)), base64Slice: 'BBBB' }, // same idx, other hash → corrupt
          { ...chunk(1, 'c'.repeat(64)), base64Slice: 'CCCC' },
        ],
      }),
    ]);
    const report = await normalizeQueueOnRecovery();
    expect(report.sessions_marked_corrupt).toBe(1);
    expect(report.chunks_marked_failed).toBeGreaterThan(0);

    const e = (await queueRead())[0]!;
    expect(e.chunks.every(c => c.status === 'failed')).toBe(true);
    expect(e.chunks[0]?.last_error?.code).toBe('CORRUPT_HASH_DIVERGENCE');

    // PHASE 1A — expectation deliberately INVERTED. None of these
    // chunks carries a `remote_reference`, so none was ever confirmed
    // off-device. Recovery may flag them corrupt, but it may not
    // destroy the only copy of the evidence. Bytes, hash and index all
    // survive.
    expect(e.chunks.every(c => c.base64Slice !== undefined)).toBe(true);
    expect(e.chunks.map(c => c.base64Slice).sort()).toEqual(['AAAA', 'BBBB', 'CCCC']);
    expect(e.chunks.every(c => c.hash.length === 64)).toBe(true);
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

/**
 * G1 — `evidence_closed` merge under duplicate collapse.
 *
 * Three-valued OR, mirroring the direction the existing boolean merge
 * already uses (`true` wins) while treating absence as the neutral
 * element. A plain `||` would collapse `undefined || false` into
 * `false`, materialising the key on an entry that never carried it —
 * which would hand G2 a queue full of synthetic `false` values
 * indistinguishable from genuinely open sessions.
 */
describe('G1 — evidence_closed merge on duplicate collapse', () => {
  it('R4a — any true wins', async () => {
    await seed([
      entry({ evidence_closed: false }),
      entry({ evidence_closed: true }),
    ]);
    await normalizeQueueOnRecovery();
    const [merged] = await queueRead();
    expect(merged!.evidence_closed).toBe(true);
  });

  it('R4b — true wins even when the other side is absent', async () => {
    const absent = entry();
    delete (absent as Partial<PendingQueueEntry>).evidence_closed;
    await seed([absent, entry({ evidence_closed: true })]);
    await normalizeQueueOnRecovery();
    const [merged] = await queueRead();
    expect(merged!.evidence_closed).toBe(true);
  });

  it('R4c — no true, one false → false', async () => {
    const absent = entry();
    delete (absent as Partial<PendingQueueEntry>).evidence_closed;
    await seed([absent, entry({ evidence_closed: false })]);
    await normalizeQueueOnRecovery();
    const [merged] = await queueRead();
    expect(merged!.evidence_closed).toBe(false);
  });

  it('R4d — all absent STAYS absent: the key is never materialised', async () => {
    const a = entry();
    const b = entry();
    delete (a as Partial<PendingQueueEntry>).evidence_closed;
    delete (b as Partial<PendingQueueEntry>).evidence_closed;
    await seed([a, b]);
    await normalizeQueueOnRecovery();
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    const persisted = JSON.parse(raw as string) as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect('evidence_closed' in persisted[0]!).toBe(false);
  });
});

/**
 * G2' — the merge must combine EFFECTIVE terminality, not the raw field.
 *
 * Precondition of the new read path. Under G1's rule (three-valued OR
 * over `evidence_closed` alone) collapsing a legacy entry with a G1 open
 * one produced `evidence_closed=false` alongside `recording_closed=true`
 * — a divergence no writer can produce, which the new
 * `canAdvanceToTerminality` would read as BLOCKED on a session that
 * completes today.
 */
describe("G2' — effective-value merge on duplicate collapse", () => {
  it('T7 — legacy(absent/true) + G1 open(false/false) → true, matching recording_closed', async () => {
    const legacy = entry({ recording_closed: true });
    delete (legacy as Partial<PendingQueueEntry>).evidence_closed;
    await seed([legacy, entry({ recording_closed: false, evidence_closed: false })]);

    await normalizeQueueOnRecovery();

    const [merged] = await queueRead();
    // `recording_closed` merges to true (OR). The effective merge must
    // agree, or the entry would stop finalising after G2'.
    expect(merged!.recording_closed).toBe(true);
    expect(merged!.evidence_closed).toBe(true);
  });

  it('T7b — each side falls back to its OWN recording_closed', async () => {
    // target: absent / false  → effective false
    // dup:    absent / true   → effective true
    // Using the already-combined `recording_closed` for both operands
    // would give the same answer here, so the discriminating part is
    // that the target's own `false` is not overwritten before use.
    const a = entry({ recording_closed: false, evidence_closed: false });
    const b = entry({ recording_closed: true });
    delete (b as Partial<PendingQueueEntry>).evidence_closed;
    await seed([a, b]);

    await normalizeQueueOnRecovery();

    const [merged] = await queueRead();
    expect(merged!.evidence_closed).toBe(true);
    expect(merged!.recording_closed).toBe(true);
  });

  it('T7c — two open G1 entries stay open', async () => {
    await seed([
      entry({ recording_closed: false, evidence_closed: false }),
      entry({ recording_closed: false, evidence_closed: false }),
    ]);
    await normalizeQueueOnRecovery();
    const [merged] = await queueRead();
    expect(merged!.evidence_closed).toBe(false);
    expect(merged!.recording_closed).toBe(false);
  });

  it('T8 — both keys absent → key STAYS absent, recording_closed still authoritative', async () => {
    const a = entry({ recording_closed: true });
    const b = entry({ recording_closed: false });
    delete (a as Partial<PendingQueueEntry>).evidence_closed;
    delete (b as Partial<PendingQueueEntry>).evidence_closed;
    await seed([a, b]);

    await normalizeQueueOnRecovery();

    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    const persisted = JSON.parse(raw as string) as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect('evidence_closed' in persisted[0]!).toBe(false);
    expect(persisted[0]!.recording_closed).toBe(true);
  });
});
