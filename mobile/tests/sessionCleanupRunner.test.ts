/**
 * Cleanup runner — resumability, idempotency and the refusal to invent work.
 *
 * The runner has no criterion of its own. Its only input is the journal, so a
 * directory nobody authorized is invisible to it. Several cases below assert
 * exactly that: after a give-up, a no_capture or an adoption_failed close, no
 * cleanup function is ever called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyCompletion,
  createSessionCleanupJournal,
  type JournalStorage,
  type SessionCleanupJournal,
} from '@/video/sessionCleanupJournal';
import {
  createSessionCleanupRunner,
  type CleanupOutcome,
  type CleanupResultCode,
} from '@/video/sessionCleanupRunner';

const SID = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
const SID_C = '33333333-3333-4333-8333-333333333333';

function makeStorage(): JournalStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v);
    },
  };
}

function outcome(result: CleanupResultCode, removed = 0, remaining = 0): CleanupOutcome {
  return { result, removed, remaining };
}

interface LoggedCall {
  event: string;
  fields?: Record<string, unknown>;
}

interface Harness {
  journal: SessionCleanupJournal;
  native: ReturnType<typeof vi.fn>;
  stable: ReturnType<typeof vi.fn>;
  runner: ReturnType<typeof createSessionCleanupRunner>;
  storage: ReturnType<typeof makeStorage>;
  /** Everything both the journal and the runner logged, in order. */
  logs: LoggedCall[];
}

function makeHarness(overrides?: { maxEntriesPerCycle?: number }): Harness {
  const storage = makeStorage();
  const logs: LoggedCall[] = [];
  const logger = {
    log: (event: string, fields?: Record<string, unknown>) => {
      logs.push(fields === undefined ? { event } : { event, fields });
    },
  };
  const journal = createSessionCleanupJournal({
    storage,
    clock: { now: () => 1_000 },
    logger,
  });
  const native = vi.fn(async () => outcome('CLEANED', 3, 0));
  const stable = vi.fn(async () => outcome('ALREADY_ABSENT'));
  const runner = createSessionCleanupRunner({
    journal,
    cleanNativeCache: native as never,
    cleanStableSegments: stable as never,
    logger,
    ...(overrides?.maxEntriesPerCycle !== undefined
      ? { maxEntriesPerCycle: overrides.maxEntriesPerCycle }
      : {}),
  });
  return { journal, native, stable, runner, storage, logs };
}

const auth = () => classifyCompletion({ kind: 'resolved' })!;

describe('sessionCleanupRunner — nothing without authorization', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('does nothing at all on an empty journal', async () => {
    const report = await h.runner.reconcile();
    expect(report.considered).toBe(0);
    expect(h.native).not.toHaveBeenCalled();
    expect(h.stable).not.toHaveBeenCalled();
  });

  it('ignores a session that was reaped without authorization', async () => {
    // This is the shape left by the give-up after MAX_COMPLETE_ATTEMPTS, by a
    // no_capture close and by an adoption_failed close: the queue entry is gone
    // and no journal entry was ever written.
    const report = await h.runner.reconcile();
    expect(report.considered).toBe(0);
    expect(h.native).not.toHaveBeenCalled();
    expect(h.stable).not.toHaveBeenCalled();
  });

  it('never invents work for a directory it was not told about', async () => {
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();

    expect(h.native).toHaveBeenCalledTimes(1);
    expect(h.native).toHaveBeenCalledWith(SID);
    expect(h.native).not.toHaveBeenCalledWith(SID_B);
  });
});

describe('sessionCleanupRunner — execution', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('cleans both resources and drops the entry', async () => {
    await h.journal.authorize(SID, auth());
    const report = await h.runner.reconcile();

    expect(h.native).toHaveBeenCalledTimes(1);
    expect(h.stable).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ considered: 1, cleaned: 1, dropped: 1, blocked: 0 });
    expect(await h.journal.listReconcileCandidates()).toHaveLength(0);
  });

  it('keeps a PARTIAL resource pending and retries on the next pass', async () => {
    h.native.mockResolvedValueOnce(outcome('PARTIAL', 2, 1));
    await h.journal.authorize(SID, auth());

    const first = await h.runner.reconcile();
    expect(first.dropped).toBe(0);
    expect(first.blocked).toBe(1);
    expect(await h.journal.listReconcileCandidates()).toHaveLength(1);

    h.native.mockResolvedValueOnce(outcome('CLEANED', 1, 0));
    const second = await h.runner.reconcile();
    expect(second.dropped).toBe(1);
    expect(await h.journal.listReconcileCandidates()).toHaveLength(0);
  });

  it('does not redo a resource already finished', async () => {
    h.stable.mockResolvedValueOnce(outcome('DIR_UNAVAILABLE', 0, -1));
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();

    expect(h.native).toHaveBeenCalledTimes(1);
    h.stable.mockResolvedValueOnce(outcome('CLEANED', 1, 0));
    await h.runner.reconcile();

    // Native was done on the first pass; the second pass must not touch it.
    expect(h.native).toHaveBeenCalledTimes(1);
    expect(h.stable).toHaveBeenCalledTimes(2);
  });

  it('keeps SESSION_ACTIVE blocked and never downgrades it to done', async () => {
    h.native.mockResolvedValue(outcome('SESSION_ACTIVE', 0, -1));
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();

    const doc = await h.journal.read();
    expect(doc!.entries[0]!.resources.native_cache).toBe('blocked');
    expect(await h.journal.listReconcileCandidates()).toHaveLength(1);
  });

  it('treats a throw as blocked, not as done', async () => {
    h.native.mockRejectedValueOnce(new Error('bridge exploded'));
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();

    const doc = await h.journal.read();
    expect(doc!.entries[0]!.resources.native_cache).toBe('blocked');
    expect(await h.journal.listReconcileCandidates()).toHaveLength(1);
  });

  it('rejects every malformed bridge result and stays blocked', async () => {
    const malformed: unknown[] = [
      undefined,
      null,
      'CLEANED',
      42,
      {},
      { result: 'WHAT_IS_THIS', removed: 0, remaining: 0 },
      { result: 'CLEANED' },
      { result: 'CLEANED', removed: '3', remaining: 0 },
      { result: 'CLEANED', removed: 0, remaining: '0' },
      { result: 'CLEANED', removed: Number.NaN, remaining: 0 },
      { result: 'CLEANED', removed: 0, remaining: Number.NaN },
      { result: 'CLEANED', removed: Number.POSITIVE_INFINITY, remaining: 0 },
      { result: 'CLEANED', removed: 0, remaining: Number.POSITIVE_INFINITY },
      { result: 'CLEANED', removed: 1.5, remaining: 0 },
      { result: 'CLEANED', removed: -1, remaining: 0 },
      // -1 means "not determined"; CLEANED claims the opposite, so it is a lie.
      { result: 'CLEANED', removed: 0, remaining: -1 },
      { result: 'ALREADY_ABSENT', removed: 0, remaining: -1 },
      { result: 'CLEANED', removed: 0, remaining: -2 },
    ];

    for (const bad of malformed) {
      const h2 = makeHarness();
      h2.native.mockResolvedValueOnce(bad as never);
      await h2.journal.authorize(SID, auth());
      await h2.runner.reconcile();

      const doc = await h2.journal.read();
      expect(doc!.entries[0]!.resources.native_cache).toBe('blocked');
      expect(h2.logs.some((l) => l.event === 'GC_CLEANUP_INVALID_RESULT')).toBe(true);
      // The document must remain valid v1, or the next boot would declare the
      // whole journal unusable and block every healthy session too.
      expect(await h2.journal.listReconcileCandidates()).toHaveLength(1);
    }
  });

  it('persists the closed literal when both sinks return garbage', async () => {
    const garbage = { result: 'NOPE', removed: null, remaining: {} };
    h.native.mockResolvedValueOnce(garbage as never);
    h.stable.mockResolvedValueOnce(garbage as never);
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();

    const doc = await h.journal.read();
    expect(doc!.entries[0]!.last_result).toBe('invalid_cleanup_result');
    expect(doc!.entries[0]!.resources).toEqual({
      native_cache: 'blocked',
      stable_segments: 'blocked',
    });
    // Still a document its own strict parser accepts.
    expect(await h.journal.listReconcileCandidates()).toHaveLength(1);
  });

  it('accepts remaining=-1 only where "not determined" is truthful', async () => {
    // `last_result` is per entry, not per resource, and the stable sink runs
    // second — so the state of `native_cache` is what proves the outcome was
    // accepted rather than rejected as malformed.
    const expected = {
      SESSION_ACTIVE: 'blocked',
      DIR_UNAVAILABLE: 'blocked',
      PARTIAL: 'pending',
    } as const;

    for (const result of ['SESSION_ACTIVE', 'DIR_UNAVAILABLE', 'PARTIAL'] as const) {
      const h2 = makeHarness();
      h2.native.mockResolvedValueOnce({ result, removed: 0, remaining: -1 } as never);
      await h2.journal.authorize(SID, auth());
      await h2.runner.reconcile();

      const doc = await h2.journal.read();
      expect(doc!.entries[0]!.resources.native_cache).toBe(expected[result]);
      expect(h2.logs.some((l) => l.event === 'GC_CLEANUP_INVALID_RESULT')).toBe(false);
    }
  });

  it('leaks nothing from a malformed bridge result into the log', async () => {
    const leaky = `/data/user/0/cache/${SID}/seg_000.mp4`;
    h.native.mockResolvedValueOnce({
      result: 'MYSTERY',
      removed: 'lots',
      path: leaky,
      uuid: SID,
    } as never);
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();

    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain(leaky);
    expect(dump).not.toContain(SID);
    expect(dump).not.toContain('MYSTERY');
    expect(dump).not.toContain('lots');

    const invalid = h.logs.find((l) => l.event === 'GC_CLEANUP_INVALID_RESULT');
    expect(invalid?.fields).toEqual({
      sid_prefix: SID.slice(0, 8),
      resource: 'native_cache',
      reason: 'invalid_cleanup_result',
    });
  });

  it('leaks nothing from a thrown error into the log', async () => {
    // A real filesystem or bridge failure looks like this: an absolute path,
    // the full session id and a filename, all inside the message.
    const leakyPath = `/data/user/0/com.guariacloud.app/cache/gc-segmented-recorder/${SID}/seg_000.mp4`;
    h.native.mockRejectedValueOnce(
      new Error(`ENOENT: failed to delete ${leakyPath} (uuid ${SID})`),
    );
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();

    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain(leakyPath);
    expect(dump).not.toContain(SID);
    expect(dump).not.toContain('seg_000.mp4');
    expect(dump).not.toContain('/data/user/0');
    expect(dump).not.toContain('ENOENT');

    // What survives is the closed, actionable part.
    const threw = h.logs.find((l) => l.event === 'GC_CLEANUP_THREW');
    expect(threw?.fields).toEqual({
      sid_prefix: SID.slice(0, 8),
      resource: 'native_cache',
      reason: 'cleanup_threw',
    });
  });

  it('records ALREADY_ABSENT as terminal', async () => {
    h.native.mockResolvedValueOnce(outcome('ALREADY_ABSENT'));
    await h.journal.authorize(SID, auth());
    const report = await h.runner.reconcile();

    expect(report.dropped).toBe(1);
    expect(await h.journal.listReconcileCandidates()).toHaveLength(0);
  });

  it('bumps attempts per pass without dropping anything', async () => {
    h.native.mockResolvedValue(outcome('SESSION_ACTIVE', 0, -1));
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();
    await h.runner.reconcile();

    const doc = await h.journal.read();
    expect(doc!.entries[0]!.attempts).toBe(2);
    expect(doc!.entries).toHaveLength(1);
  });

  it('caps a cycle without dropping or authorizing anything', async () => {
    const capped = makeHarness({ maxEntriesPerCycle: 1 });
    await capped.journal.authorize(SID, auth());
    await capped.journal.authorize(SID_B, auth());

    const report = await capped.runner.reconcile();
    expect(report.considered).toBe(2);
    expect(report.skippedByCap).toBe(1);
    expect(capped.native).toHaveBeenCalledTimes(1);
    expect(await capped.journal.listReconcileCandidates()).toHaveLength(1);
  });

  it('S8→S9: a kill after the second resource, before drop, is recovered', async () => {
    // First boot: both cleanups succeed and both resources are persisted as
    // terminal. The process dies before `drop` — simulated by dropping the
    // entry's removal, which is what the crash would have prevented.
    await h.journal.authorize(SID, auth());
    await h.journal.markResource(SID, 'native_cache', 'done', 'CLEANED');
    await h.journal.markResource(SID, 'stable_segments', 'absent', 'ALREADY_ABSENT');

    const before = await h.journal.read();
    expect(before!.entries).toHaveLength(1);

    // Second boot: the entry is still a candidate, needs no cleanup at all, and
    // the drop is retried.
    const report = await h.runner.reconcile();

    expect(h.native).not.toHaveBeenCalled();
    expect(h.stable).not.toHaveBeenCalled();
    expect(report).toMatchObject({ considered: 1, tombstones: 1, dropped: 1 });
    expect((await h.journal.read())!.entries).toHaveLength(0);
  });

  it('recovers every done/absent combination without touching the bridge', async () => {
    const combos = [
      ['done', 'done'],
      ['done', 'absent'],
      ['absent', 'done'],
      ['absent', 'absent'],
    ] as const;

    for (const [native, stable] of combos) {
      const h2 = makeHarness();
      await h2.journal.authorize(SID, auth());
      await h2.journal.markResource(SID, 'native_cache', native);
      await h2.journal.markResource(SID, 'stable_segments', stable);

      const report = await h2.runner.reconcile();

      expect(h2.native).not.toHaveBeenCalled();
      expect(h2.stable).not.toHaveBeenCalled();
      expect(report.tombstones).toBe(1);
      expect(report.dropped).toBe(1);
      expect((await h2.journal.read())!.entries).toHaveLength(0);
    }
  });

  it('keeps the entry when the drop write throws, and converges on the next pass', async () => {
    const storage = makeStorage();
    let failNextWrite = false;
    const logs: LoggedCall[] = [];
    const logger = {
      log: (event: string, fields?: Record<string, unknown>) => {
        logs.push(fields === undefined ? { event } : { event, fields });
      },
    };
    const journal = createSessionCleanupJournal({
      storage: {
        getItem: storage.getItem,
        setItem: async (k, v) => {
          if (failNextWrite) throw new Error('setItem exploded');
          await storage.setItem(k, v);
        },
      },
      clock: { now: () => 1_000 },
      logger,
    });
    const native = vi.fn(async () => outcome('CLEANED', 1, 0));
    const stable = vi.fn(async () => outcome('ALREADY_ABSENT'));
    const runner = createSessionCleanupRunner({
      journal,
      cleanNativeCache: native as never,
      cleanStableSegments: stable as never,
      logger,
    });

    await journal.authorize(SID, auth());
    await journal.markResource(SID, 'native_cache', 'done');
    await journal.markResource(SID, 'stable_segments', 'done');

    failNextWrite = true;
    const first = await runner.reconcile();
    expect(first.dropped).toBe(0);
    // Not claimed as dropped, because the persistence never completed.
    expect(first.blocked).toBe(1);
    expect((await journal.read())!.entries).toHaveLength(1);
    expect(logs.some((l) => l.event === 'GC_CLEANUP_DROP_THREW')).toBe(true);

    failNextWrite = false;
    const second = await runner.reconcile();
    expect(second.dropped).toBe(1);
    expect((await journal.read())!.entries).toHaveLength(0);
  });

  it('serves a session holding bytes before a stuck tombstone', async () => {
    // Stored order puts the tombstone FIRST, which is the arrangement that
    // starves the other entry if the cap is spent in stored order.
    const storage = makeStorage();
    const logs: LoggedCall[] = [];
    const logger = {
      log: (event: string, fields?: Record<string, unknown>) => {
        logs.push(fields === undefined ? { event } : { event, fields });
      },
    };
    // Fails exactly the write that would remove SID — that is, its drop — and
    // keeps failing, pass after pass.
    const guarded: JournalStorage = {
      getItem: storage.getItem,
      setItem: async (k, v) => {
        const before = await storage.getItem(k);
        if (before?.includes(SID) && !v.includes(SID)) {
          throw new Error('drop write failed');
        }
        await storage.setItem(k, v);
      },
    };
    const journal = createSessionCleanupJournal({
      storage: guarded,
      clock: { now: () => 1_000 },
      logger,
    });
    const native = vi.fn(async () => outcome('CLEANED', 2, 0));
    const stable = vi.fn(async () => outcome('ALREADY_ABSENT'));
    const runner = createSessionCleanupRunner({
      journal,
      cleanNativeCache: native as never,
      cleanStableSegments: stable as never,
      logger,
      maxEntriesPerCycle: 1,
    });

    await journal.authorize(SID, auth());
    await journal.markResource(SID, 'native_cache', 'done');
    await journal.markResource(SID, 'stable_segments', 'done');
    await journal.authorize(SID_B, auth());

    const first = await runner.reconcile();

    // The byte-holding session went first, despite being stored second.
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith(SID_B);
    expect(first.considered).toBe(2);
    expect(first.skippedByCap).toBe(1);
    expect(first.tombstones).toBe(0);

    // The stuck tombstone is still there, waiting, not blocking.
    const doc = await journal.read();
    expect(doc!.entries.map((e) => e.session_id)).toEqual([SID]);

    // With no byte-holding work left, it finally gets its turn.
    const second = await runner.reconcile();
    expect(second.tombstones).toBe(1);
    expect(second.dropped).toBe(0);
    expect((await journal.read())!.entries).toHaveLength(1);
  });

  it('keeps stable order among sessions that hold bytes', async () => {
    const capped = makeHarness({ maxEntriesPerCycle: 1 });
    await capped.journal.authorize(SID, auth());
    await capped.journal.authorize(SID_B, auth());
    await capped.journal.authorize(SID_C, auth());

    await capped.runner.reconcile();
    expect(capped.native).toHaveBeenCalledTimes(1);
    expect(capped.native).toHaveBeenCalledWith(SID);

    await capped.runner.reconcile();
    expect(capped.native).toHaveBeenNthCalledWith(2, SID_B);
  });

  it('keeps stable order among tombstones', async () => {
    const capped = makeHarness({ maxEntriesPerCycle: 1 });
    for (const sid of [SID, SID_B, SID_C]) {
      await capped.journal.authorize(sid, auth());
      await capped.journal.markResource(sid, 'native_cache', 'done');
      await capped.journal.markResource(sid, 'stable_segments', 'absent');
    }

    await capped.runner.reconcile();
    expect((await capped.journal.read())!.entries.map((e) => e.session_id)).toEqual([
      SID_B,
      SID_C,
    ]);

    await capped.runner.reconcile();
    expect((await capped.journal.read())!.entries.map((e) => e.session_id)).toEqual([
      SID_C,
    ]);
  });

  it('counts terminal tombstones against the cycle cap', async () => {
    const capped = makeHarness({ maxEntriesPerCycle: 1 });
    // One tombstone and one entry that may still hold bytes. Three things hold
    // at once here: tombstones count against the budget, so `considered` is 2
    // and `skippedByCap` is 1; entries that may still hold bytes are served
    // first, so the first pass spends the budget on SID_B rather than on the
    // tombstone stored ahead of it; and the tombstone then takes whatever
    // budget is left, which is the next pass.
    await capped.journal.authorize(SID, auth());
    await capped.journal.markResource(SID, 'native_cache', 'done');
    await capped.journal.markResource(SID, 'stable_segments', 'done');
    await capped.journal.authorize(SID_B, auth());

    const report = await capped.runner.reconcile();
    expect(report.considered).toBe(2);
    expect(report.skippedByCap).toBe(1);
    expect((await capped.journal.read())!.entries).toHaveLength(1);

    const second = await capped.runner.reconcile();
    expect(second.considered).toBe(1);
    expect((await capped.journal.read())!.entries).toHaveLength(0);
  });

  it('is idempotent across repeated passes once finished', async () => {
    await h.journal.authorize(SID, auth());
    await h.runner.reconcile();
    h.native.mockClear();
    h.stable.mockClear();

    const again = await h.runner.reconcile();
    expect(again.considered).toBe(0);
    expect(h.native).not.toHaveBeenCalled();
    expect(h.stable).not.toHaveBeenCalled();
  });
});
