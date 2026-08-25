/**
 * Native segmented session — wiring, drain gate and close protocol.
 *
 * Every collaborator is injected, so these tests run with no Expo runtime, no
 * filesystem and no real time. Three properties are worth stating up front,
 * because they are what the suite exists to defend:
 *
 *   - the drain gate is asserted against the INJECTED `queue.drain`. It holds
 *     back kicks raised by this wiring and nothing else; the foreground-service
 *     tick and the boot/foreground kicks drain the whole queue and are
 *     deliberately out of scope (SESSION_NOT_FOUND is already transient for
 *     exactly that reason).
 *
 *   - `next_chunk_index` is read back from the queue, never counted in memory.
 *     Case C2 appends out of order on purpose.
 *
 *   - a close either writes with proof or refuses to write. Four of the five
 *     outcomes touch nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createNativeSegmentedSession,
  deriveIndexes,
  type CloseReport,
  type Clock,
  type NativeRecorderApi,
  type NativeSegmentedSession,
  type QueueEntrySnapshot,
  type QueueGateway,
  type SessionLogger,
} from '@/video/nativeSegmentedSession';
import type {
  AdoptionRecord,
  ClosedSegment,
  QueueSink,
} from '@/video/segmentAdopter';
import type {
  CaptureReleasedEvent,
  GCSegmentedRecorderEvents,
  SegmentClosedEvent,
} from '../modules/gc-segmented-recorder/src/GCSegmentedRecorder.types';

// ------------------------------------------------------------------- fixtures

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER_SID = '22222222-2222-4222-8222-222222222222';
const OPTIONS = { rotateAtMs: 3_000, rotationIntervalMs: 6_000, sessionMs: 3_600_000 };

/** Lets every queued microtask and `setTimeout(0)` run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function segEvent(index: number, sessionId = SID): SegmentClosedEvent {
  return {
    sessionId,
    segmentIndex: index,
    path: `/cache/gc-segmented-recorder/${sessionId}/seg_${index}.mp4`,
    sizeBytes: 1000 + index,
    cutPtsUs: 0,
    audioTailUs: 0,
    audioLeadUs: 0,
    keyframeWaitMs: 0,
    muxerStopMs: 0,
    queuePeakEntries: 0,
    queuePeakBytes: 0,
    audioFramesDropped: 0,
    audioFramesDuplicated: 0,
    videoFramesDropped: 0,
    rebaseNegativeCount: 0,
  };
}

function releasedEvent(sessionId = SID): CaptureReleasedEvent {
  return { sessionId, resourcesFreed: true, leaked: [] };
}

function makeRecord(
  ev: ClosedSegment,
  outcome: AdoptionRecord['outcome'],
  closedAtMs: number,
): AdoptionRecord {
  const enqueued = outcome === 'adopted' || outcome === 'already_adopted';
  return {
    outcome,
    sessionId: ev.sessionId,
    segmentIndex: ev.segmentIndex,
    sourcePath: ev.path,
    sourceUri: `file://${ev.path}`,
    stableUri: `file:///doc/segments/${ev.sessionId}/segment_${ev.segmentIndex}.mp4`,
    sizeBytes: ev.sizeBytes,
    sha256: outcome === 'failed' ? null : 'a'.repeat(64),
    eventSizeBytes: ev.sizeBytes,
    closedAtMs,
    enqueuedAtMs: enqueued ? closedAtMs + 1 : null,
    timings: {
      hashSourceMs: 0,
      copyMs: 0,
      hashCopyMs: 0,
      enqueueMs: 0,
      closedToEnqueueMs: 1,
      totalMs: 1,
    },
  };
}

// --------------------------------------------------------------------- doubles

type Listener = (event: never) => void;

class FakeRecorder implements NativeRecorderApi {
  startCalls: { sessionId: string }[] = [];
  stopCalls = 0;
  removeCalls = 0;
  startRejectsWith: Error | null = null;
  private listeners = new Map<string, Set<Listener>>();

  async startSegmentedCapture(sessionId: string): Promise<void> {
    this.startCalls.push({ sessionId });
    if (this.startRejectsWith) throw this.startRejectsWith;
  }

  async stopSegmentedCapture(): Promise<void> {
    this.stopCalls += 1;
  }

  addListener<K extends keyof GCSegmentedRecorderEvents>(
    event: K,
    listener: GCSegmentedRecorderEvents[K],
  ): { remove(): void } {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener as unknown as Listener);
    this.listeners.set(event, set);
    return {
      remove: () => {
        this.removeCalls += 1;
        set.delete(listener as unknown as Listener);
      },
    };
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  emitSegment(event: SegmentClosedEvent): void {
    for (const l of this.listeners.get('onSegmentClosed') ?? []) {
      (l as unknown as (e: SegmentClosedEvent) => void)(event);
    }
  }

  emitReleased(event: CaptureReleasedEvent): void {
    for (const l of this.listeners.get('onCaptureReleased') ?? []) {
      (l as unknown as (e: CaptureReleasedEvent) => void)(event);
    }
  }
}

class FakeClock implements Clock {
  private t = 1_000;
  private pending: { fn: () => void; at: number; cancelled: boolean }[] = [];

  now(): number {
    return this.t;
  }

  schedule(fn: () => void, ms: number): () => void {
    const item = { fn, at: this.t + ms, cancelled: false };
    this.pending.push(item);
    return () => {
      item.cancelled = true;
    };
  }

  advance(ms: number): void {
    this.t += ms;
    const due = this.pending.filter((p) => !p.cancelled && p.at <= this.t);
    this.pending = this.pending.filter((p) => p.cancelled || p.at > this.t);
    for (const p of due) p.fn();
  }
}

class FakeQueue implements QueueGateway {
  entries: { session_id: string; chunks: { chunk_index: number }[] }[] = [];
  markCalls: {
    sessionId: string;
    finalUri: string;
    emitted: number;
    next: number;
  }[] = [];
  dropCalls: string[] = [];
  drainCalls = 0;
  readThrows: Error | null = null;

  async read(): Promise<readonly QueueEntrySnapshot[]> {
    if (this.readThrows) throw this.readThrows;
    return this.entries;
  }

  async markRecordingClosed(
    sessionId: string,
    finalUri: string,
    emitted: number,
    next: number,
  ): Promise<void> {
    this.markCalls.push({ sessionId, finalUri, emitted, next });
  }

  async dropEntry(sessionId: string): Promise<void> {
    this.dropCalls.push(sessionId);
    this.entries = this.entries.filter((e) => e.session_id !== sessionId);
  }

  drain(): void {
    this.drainCalls += 1;
  }

  seed(sessionId: string): void {
    this.entries.push({ session_id: sessionId, chunks: [] });
  }
}

/** Writes into the fake queue, exactly like the productive sink does. */
function makeProductionSink(queue: FakeQueue): QueueSink & { calls: number } {
  const sink = {
    calls: 0,
    appendChunk: async (sessionId: string, chunk: { chunk_index: number }) => {
      sink.calls += 1;
      const entry = queue.entries.find((e) => e.session_id === sessionId);
      if (!entry) return;
      if (entry.chunks.some((c) => c.chunk_index === chunk.chunk_index)) return;
      entry.chunks.push({ chunk_index: chunk.chunk_index });
    },
  };
  return sink as unknown as QueueSink & { calls: number };
}

/** Records the call and writes nothing. */
function makePreservationSink(): QueueSink & { calls: number[] } {
  const sink = {
    calls: [] as number[],
    appendChunk: async (_sessionId: string, chunk: { chunk_index: number }) => {
      sink.calls.push(chunk.chunk_index);
    },
  };
  return sink as unknown as QueueSink & { calls: number[] };
}

interface AdoptDouble {
  fn: (ev: ClosedSegment, closedAtMs: number, sink: QueueSink) => Promise<AdoptionRecord>;
  calls: { ev: ClosedSegment; sink: QueueSink }[];
  outcome: AdoptionRecord['outcome'];
  /** When set, every adoption waits on it before touching the sink. */
  gate: Promise<void> | null;
  /** Optional per-index append order override for the out-of-order case. */
  delayByIndex: Map<number, number>;
}

function makeAdopt(): AdoptDouble {
  const double: AdoptDouble = {
    outcome: 'adopted',
    gate: null,
    delayByIndex: new Map(),
    calls: [],
    fn: async (ev, closedAtMs, sink) => {
      double.calls.push({ ev, sink });
      if (double.gate) await double.gate;
      const hops = double.delayByIndex.get(ev.segmentIndex) ?? 0;
      for (let i = 0; i < hops; i++) await Promise.resolve();
      const record = makeRecord(ev, double.outcome, closedAtMs);
      if (record.outcome === 'adopted' || record.outcome === 'already_adopted') {
        await sink.appendChunk(
          ev.sessionId,
          {
            chunk_index: ev.segmentIndex,
            hash: record.sha256 ?? '',
            size: ev.sizeBytes,
            status: 'pending',
            attempts: 0,
            local_uri: record.stableUri,
            // G3' — the real adopter stamps this literally; the double
            // mirrors it so the two cannot drift apart silently.
            media: 'video',
          },
          null,
          ev.segmentIndex + 1,
        );
      }
      return record;
    },
  };
  return double;
}

// ------------------------------------------------------------------- harness

interface Harness {
  session: NativeSegmentedSession;
  recorder: FakeRecorder;
  queue: FakeQueue;
  clock: FakeClock;
  adopt: AdoptDouble;
  production: QueueSink & { calls: number };
  preservation: QueueSink & { calls: number[] };
  logs: { event: string; fields?: Record<string, unknown> }[];
  /** Stand-in for `sessionCreatePromise`: resolves with the id, rejects on 4xx. */
  remote: Promise<string>;
  resolveRemote: () => void;
  rejectRemote: (err: Error) => void;
}

function makeHarness(): Harness {
  const recorder = new FakeRecorder();
  const queue = new FakeQueue();
  const clock = new FakeClock();
  const adopt = makeAdopt();
  const production = makeProductionSink(queue);
  const preservation = makePreservationSink();
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const logger: SessionLogger = {
    log: (event, fields) => {
      logs.push(fields === undefined ? { event } : { event, fields });
    },
  };
  const session = createNativeSegmentedSession({
    recorder,
    adopt: adopt.fn,
    productionSink: production,
    preservationSink: preservation,
    queue,
    clock,
    logger,
  });

  let resolveRemote!: () => void;
  let rejectRemote!: (err: Error) => void;
  const remote = new Promise<string>((resolve, reject) => {
    resolveRemote = () => resolve(SID);
    rejectRemote = reject;
  });
  // Never let an unhandled rejection escape the test runner.
  remote.catch(() => undefined);

  return {
    session,
    recorder,
    queue,
    clock,
    adopt,
    production,
    preservation,
    logs,
    remote,
    resolveRemote,
    rejectRemote,
  };
}

async function startSession(h: Harness): Promise<void> {
  h.queue.seed(SID);
  await h.session.start(SID, OPTIONS, h.remote);
}

function eventNames(h: Harness): string[] {
  return h.logs.map((l) => l.event);
}

// --------------------------------------------------------------------- cases

describe('nativeSegmentedSession · drain gate', () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await startSession(h);
  });

  it('G1 · adoptions run while the remote session is still pending', async () => {
    h.recorder.emitSegment(segEvent(0));
    h.recorder.emitSegment(segEvent(1));
    h.recorder.emitSegment(segEvent(2));
    await flush();

    expect(h.adopt.calls).toHaveLength(3);
    expect(h.production.calls).toBe(3);
    expect(h.adopt.calls.every((c) => c.sink === h.production)).toBe(true);
  });

  it('G2 · GC_QUEUE accumulates the chunks meanwhile', async () => {
    h.recorder.emitSegment(segEvent(0));
    h.recorder.emitSegment(segEvent(1));
    h.recorder.emitSegment(segEvent(2));
    await flush();

    expect(h.queue.entries[0]!.chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2]);
  });

  it('G3 · this wiring raises no drain kick before the signal settles', async () => {
    h.recorder.emitSegment(segEvent(0));
    h.recorder.emitSegment(segEvent(1));
    h.recorder.emitSegment(segEvent(2));
    await flush();

    expect(h.queue.drainCalls).toBe(0);
  });

  it('G4 · settling the signal fires exactly one kick for everything accumulated', async () => {
    h.recorder.emitSegment(segEvent(0));
    h.recorder.emitSegment(segEvent(1));
    h.recorder.emitSegment(segEvent(2));
    await flush();

    h.resolveRemote();
    await flush();

    expect(h.queue.drainCalls).toBe(1);
    expect(h.queue.entries[0]!.chunks).toHaveLength(3);
    expect(eventNames(h)).toContain('GC_SEGMENT_DRAIN_RELEASED');
  });

  it('G5 · after the signal, each adoption kicks normally', async () => {
    h.resolveRemote();
    await flush();
    expect(h.queue.drainCalls).toBe(0);

    h.recorder.emitSegment(segEvent(0));
    await flush();
    expect(h.queue.drainCalls).toBe(1);

    h.recorder.emitSegment(segEvent(1));
    await flush();
    expect(h.queue.drainCalls).toBe(2);
  });

  it('G6 · a remote rejection alone stops nothing and drains nothing', async () => {
    h.recorder.emitSegment(segEvent(0));
    await flush();

    h.rejectRemote(new Error('HTTP 403'));
    await flush();

    expect(h.recorder.stopCalls).toBe(0);
    expect(h.queue.drainCalls).toBe(0);
    expect(h.queue.markCalls).toHaveLength(0);
    expect(eventNames(h)).toContain('GC_SEGMENT_DRAIN_SUPPRESSED');
  });
});

describe('nativeSegmentedSession · close', () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await startSession(h);
    h.resolveRemote();
    await flush();
  });

  it('C1 · waits for in-flight adoptions before closing the entry', async () => {
    let openGate!: () => void;
    h.adopt.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    h.recorder.emitSegment(segEvent(0));
    await flush();
    // The adoption is parked inside the gate; the queue has nothing yet.
    expect(h.queue.entries[0]!.chunks).toHaveLength(0);

    h.recorder.emitReleased(releasedEvent());
    await flush();
    expect(h.queue.markCalls).toHaveLength(0);

    openGate();
    await flush();

    expect(h.queue.markCalls).toHaveLength(1);
    expect(h.queue.markCalls[0]!.next).toBe(1);
    expect(eventNames(h)).toContain('GC_SEGMENT_CLOSE_WAITING');
  });

  it('C2 · derives next_chunk_index from GC_QUEUE, not from append order', async () => {
    // Segment 1 lands LAST even though its index is not the highest, which is
    // exactly the case where a persisted last-writer-wins counter would be
    // wrong: it would end at 2, not 3.
    h.adopt.delayByIndex.set(1, 8);
    h.recorder.emitSegment(segEvent(0));
    h.recorder.emitSegment(segEvent(1));
    h.recorder.emitSegment(segEvent(2));
    await flush();

    expect(h.queue.entries[0]!.chunks.map((c) => c.chunk_index)).toEqual([0, 2, 1]);

    h.recorder.emitReleased(releasedEvent());
    await flush();

    const report = await h.session.stop();
    expect(h.queue.markCalls).toHaveLength(1);
    expect(h.queue.markCalls[0]!.next).toBe(3);
    expect(h.queue.markCalls[0]!.finalUri).toBe('');
    expect(report.outcome).toBe('closed');
    expect(report.durableChunks).toBe(3);
    expect(report.nextChunkIndex).toBe(3);
  });

  it('C3 · no segment at all removes the local entry and never marks it closed', async () => {
    h.recorder.emitReleased(releasedEvent());
    await flush();
    const report = await h.session.stop();

    expect(report.outcome).toBe('no_capture');
    expect(h.queue.dropCalls).toEqual([SID]);
    expect(h.queue.markCalls).toHaveLength(0);
    expect(report.nextChunkIndex).toBeNull();
    expect(eventNames(h)).toContain('GC_SEGMENT_CLOSE_NO_CAPTURE');
  });

  it('C4 · segments with no durable chunk close INCOMPLETE at max(observed)+1', async () => {
    h.adopt.outcome = 'failed';
    // A duplicate index must not inflate the expectation: the derivation
    // deduplicates rather than counting events.
    h.recorder.emitSegment(segEvent(0));
    h.recorder.emitSegment(segEvent(1));
    h.recorder.emitSegment(segEvent(1));
    await flush();
    expect(h.queue.entries[0]!.chunks).toHaveLength(0);

    h.recorder.emitReleased(releasedEvent());
    await flush();
    const report = await h.session.stop();

    expect(report.outcome).toBe('adoption_failed');
    expect(report.segmentsObserved).toBe(2);
    expect(report.observedIndexes).toEqual([0, 1]);
    expect(report.observedContiguousFromZero).toBe(true);
    expect(h.queue.markCalls).toHaveLength(1);
    // Closed, and demonstrably incomplete: the completion gate will block on
    // missing indexes 0 and 1 and never call completeSession.
    expect(h.queue.markCalls[0]!.next).toBe(2);
    expect(h.queue.dropCalls).toHaveLength(0);
    expect(h.queue.drainCalls).toBe(0);
    expect(eventNames(h)).toContain('GC_SEGMENT_CLOSE_ADOPTION_FAILED');
  });

  it('C5 · an entry missing from GC_QUEUE writes nothing', async () => {
    h.queue.entries = [];
    h.recorder.emitReleased(releasedEvent());
    await flush();
    const report = await h.session.stop();

    expect(report.outcome).toBe('no_entry');
    expect(h.queue.markCalls).toHaveLength(0);
    expect(h.queue.dropCalls).toHaveLength(0);
    expect(eventNames(h)).toContain('GC_SEGMENT_CLOSE_NO_ENTRY');
  });

  it('C6 · a missed release writes nothing, and a late one still closes', async () => {
    h.recorder.emitSegment(segEvent(0));
    await flush();

    const stopped = h.session.stop();
    await flush();
    h.clock.advance(15_001);
    const report = await stopped;

    expect(report.outcome).toBe('timeout');
    expect(report.nextChunkIndex).toBeNull();
    expect(report.durableChunks).toBeNull();
    expect(h.queue.markCalls).toHaveLength(0);
    expect(h.queue.dropCalls).toHaveLength(0);
    expect(eventNames(h)).toContain('GC_SEGMENT_RELEASE_TIMEOUT');

    // Listeners stay armed on purpose.
    h.recorder.emitReleased(releasedEvent());
    await flush();
    expect(h.queue.markCalls).toHaveLength(1);
    expect(h.queue.markCalls[0]!.next).toBe(1);
    expect(eventNames(h)).toContain('GC_SEGMENT_RELEASE_LATE_RECOVERED');
  });
});

describe('nativeSegmentedSession · ownership of the stop', () => {
  it('O1 · the abort is the caller of stop(), and it stops the recorder once', async () => {
    const h = makeHarness();
    await startSession(h);
    h.recorder.emitSegment(segEvent(0));
    await flush();

    h.rejectRemote(new Error('HTTP 422'));
    await flush();
    expect(h.recorder.stopCalls).toBe(0);

    const stopped = h.session.stop();
    await flush();
    h.recorder.emitReleased(releasedEvent());
    const report = await stopped;

    expect(h.recorder.stopCalls).toBe(1);
    expect(report.outcome).toBe('closed');
    // The backend refused the session, so waking the worker would be pointless.
    expect(h.queue.drainCalls).toBe(0);
  });

  it('O2 · a rejection racing a manual PARAR stops once and closes at most once', async () => {
    const h = makeHarness();
    await startSession(h);
    h.resolveRemote();
    await flush();
    h.recorder.emitSegment(segEvent(0));
    await flush();

    // Both callers in the same tick: the abort handler and the PARAR tap.
    const first = h.session.stop();
    const second = h.session.stop();
    await flush();
    h.recorder.emitReleased(releasedEvent());
    // A duplicate release must not close twice either.
    h.recorder.emitReleased(releasedEvent());
    const [a, b] = await Promise.all([first, second]);

    expect(h.recorder.stopCalls).toBe(1);
    expect(h.queue.markCalls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a.outcome).toBe('closed');
    expect(eventNames(h)).toContain('GC_SEGMENT_RELEASE_DUPLICATE');
  });

  it('O3 · stop() after settling returns the memoised report with no new effects', async () => {
    const h = makeHarness();
    await startSession(h);
    h.resolveRemote();
    await flush();
    h.recorder.emitSegment(segEvent(0));
    await flush();

    const stopped = h.session.stop();
    await flush();
    h.recorder.emitReleased(releasedEvent());
    const first: CloseReport = await stopped;

    const again = await h.session.stop();

    expect(again).toBe(first);
    expect(h.recorder.stopCalls).toBe(1);
    expect(h.queue.markCalls).toHaveLength(1);
    expect(h.session.isActive()).toBe(false);
  });
});

describe('nativeSegmentedSession · listeners and session identity', () => {
  it('L1 · one adoption per event, and a foreign session is ignored', async () => {
    const h = makeHarness();
    await startSession(h);

    h.recorder.emitSegment(segEvent(0));
    h.recorder.emitSegment(segEvent(1));
    h.recorder.emitSegment(segEvent(0, OTHER_SID));
    await flush();

    expect(h.adopt.calls).toHaveLength(2);
    expect(h.adopt.calls.map((c) => c.ev.segmentIndex)).toEqual([0, 1]);
    expect(eventNames(h)).toContain('GC_SEGMENT_FOREIGN_IGNORED');
  });

  it('L2 · a segment after the release is preserved, never queued', async () => {
    const h = makeHarness();
    await startSession(h);
    h.resolveRemote();
    await flush();
    h.recorder.emitSegment(segEvent(0));
    await flush();
    h.recorder.emitReleased(releasedEvent());
    await flush();
    await h.session.stop();

    const marksBefore = h.queue.markCalls.length;
    const chunksBefore = h.queue.entries[0]!.chunks.length;
    const productionBefore = h.production.calls;

    h.recorder.emitSegment(segEvent(1));
    await flush();

    expect(h.preservation.calls).toEqual([1]);
    expect(h.production.calls).toBe(productionBefore);
    expect(h.queue.entries[0]!.chunks).toHaveLength(chunksBefore);
    expect(h.queue.markCalls).toHaveLength(marksBefore);
    expect(eventNames(h)).toContain('GC_SEGMENT_AFTER_RELEASE');
  });

  it('L3 · a new start disposes the previous listeners, leaking none', async () => {
    const h = makeHarness();
    await startSession(h);
    expect(h.recorder.listenerCount).toBe(3);

    await h.session.start(SID, OPTIONS, h.remote);

    expect(h.recorder.removeCalls).toBe(3);
    expect(h.recorder.listenerCount).toBe(3);

    h.recorder.emitSegment(segEvent(0));
    await flush();
    // Exactly one adoption: the stale subscription is gone, not merely inert.
    expect(h.adopt.calls).toHaveLength(1);

    h.session.dispose();
    expect(h.recorder.listenerCount).toBe(0);
    expect(h.session.isActive()).toBe(false);
  });
});

describe('deriveIndexes', () => {
  it('deduplicates, rejects non-integers and reports contiguity', () => {
    expect(deriveIndexes([0, 1, 2])).toMatchObject({
      indexes: [0, 1, 2],
      next: 3,
      contiguousFromZero: true,
      rejected: 0,
    });
    expect(deriveIndexes([2, 0, 2])).toMatchObject({
      indexes: [0, 2],
      next: 3,
      contiguousFromZero: false,
    });
    expect(deriveIndexes([])).toMatchObject({ next: 0, contiguousFromZero: true });
    expect(deriveIndexes([-1, 1.5, Number.NaN, 3])).toMatchObject({
      indexes: [3],
      next: 4,
      rejected: 3,
    });
  });
});
