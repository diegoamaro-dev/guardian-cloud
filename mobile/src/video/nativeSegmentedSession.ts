/**
 * Native segmented capture — productive wiring.
 *
 * Turns the native recorder's `onSegmentClosed` stream into GC_QUEUE chunks and
 * owns exactly one thing beyond that: WHEN the queue entry may be declared
 * closed, and with which `next_chunk_index`. Everything else — who records,
 * what the user sees, which producer was selected, permissions, the foreground
 * service — belongs to the host screen.
 *
 * Three rules shape this file:
 *
 *   1. NO MODULE STATE. `createNativeSegmentedSession` returns an instance
 *      holding private state. Consecutive sessions, hot reload and tests never
 *      share a hidden singleton, and `start()` disposes the previous session's
 *      listeners before registering its own, so subscriptions cannot leak.
 *
 *   2. NO RUNTIME IMPORTS. Every import below is `import type` and is erased at
 *      compile time. The native module, the adopter, the queue, the clock and
 *      the logger are injected, so this file loads under vitest with no Expo
 *      runtime and no filesystem.
 *
 *   3. GC_QUEUE IS THE SOURCE OF TRUTH. `next_chunk_index` is NEVER derived
 *      from the in-memory adoption records — those are observability only. It
 *      is read back from the queue after every registered adoption has settled.
 *      See `performClose` for why re-reading is mandatory rather than tidy.
 */
import type {
  CaptureErrorEvent,
  CaptureReleasedEvent,
  GateHarnessOptions,
  GCSegmentedRecorderEvents,
  SegmentClosedEvent,
} from '../../modules/gc-segmented-recorder/src/GCSegmentedRecorder.types';
import type { AdoptionRecord, ClosedSegment, QueueSink } from './segmentAdopter';

// --------------------------------------------------------------- dependencies

/** The slice of the native module this file consumes. Injected, never imported. */
export interface NativeRecorderApi {
  startSegmentedCapture(
    sessionId: string,
    options?: GateHarnessOptions,
  ): Promise<void>;
  stopSegmentedCapture(): Promise<void>;
  addListener<K extends keyof GCSegmentedRecorderEvents>(
    event: K,
    listener: GCSegmentedRecorderEvents[K],
  ): { remove(): void };
}

/**
 * Time and scheduling, injected so the release deadline is testable without
 * real time. `schedule` returns its own canceller instead of a handle, which
 * keeps the host's `setTimeout` type out of this module's surface.
 */
export interface Clock {
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
}

/** The only shape this module needs from a GC_QUEUE entry. */
export interface QueueEntrySnapshot {
  session_id: string;
  chunks: readonly { chunk_index: number }[];
}

/**
 * GC_QUEUE access, narrowed to the four operations the close protocol performs.
 * Every one of them maps to an existing exported primitive in the host — this
 * module introduces no new queue behaviour.
 */
export interface QueueGateway {
  read(): Promise<readonly QueueEntrySnapshot[]>;
  markRecordingClosed(
    sessionId: string,
    finalUri: string,
    emittedBase64Length: number,
    nextChunkIndex: number,
  ): Promise<void>;
  dropEntry(sessionId: string): Promise<void>;
  /** Wakes the upload worker. Fire-and-forget: never awaited, never throws. */
  drain(): void;
}

export interface SessionLogger {
  log(event: string, fields?: Record<string, unknown>): void;
}

export type AdoptFn = (
  ev: ClosedSegment,
  closedAtMs: number,
  sink: QueueSink,
) => Promise<AdoptionRecord>;

export interface NativeSegmentedSessionDeps {
  recorder: NativeRecorderApi;
  adopt: AdoptFn;
  /** Writes to GC_QUEUE. Only for segments that arrive BEFORE the release. */
  productionSink: QueueSink;
  /**
   * Copies and verifies but NEVER writes to GC_QUEUE. Used for segments that
   * arrive after `onCaptureReleased` — a contract violation whose bytes are
   * still worth preserving, but which must not reopen a closed session.
   */
  preservationSink: QueueSink;
  queue: QueueGateway;
  clock: Clock;
  logger: SessionLogger;
  /** Default 15 000 ms: EOS drain 3 s + stability 5 s + margin. */
  releaseTimeoutMs?: number;
}

// -------------------------------------------------------------------- results

export type CloseOutcome =
  /** At least one durable chunk. Entry closed with `next = max(index) + 1`. */
  | 'closed'
  /** No segment was ever observed. Nothing to protect; local entry removed. */
  | 'no_capture'
  /** Segments existed but none reached GC_QUEUE. Entry closed and INCOMPLETE. */
  | 'adoption_failed'
  /** The entry was gone from GC_QUEUE by close time. Nothing was written. */
  | 'no_entry'
  /** `onCaptureReleased` never arrived. Nothing was written. */
  | 'timeout';

export interface CloseReport {
  outcome: CloseOutcome;
  sessionId: string;
  /** Segments accepted BEFORE the release. Post-release ones never count. */
  segmentsObserved: number;
  /** Sanitised, deduplicated, ascending. */
  observedIndexes: readonly number[];
  /** True iff the observed indexes are exactly `0..n-1`. */
  observedContiguousFromZero: boolean;
  adoptionsSettled: number;
  /** Chunks actually present in GC_QUEUE. `null` when it was never read. */
  durableChunks: number | null;
  /** Value persisted by this close. `null` when nothing was written. */
  nextChunkIndex: number | null;
  error?: string;
}

export interface NativeSegmentedSession {
  /**
   * Registers the three listeners and THEN opens the camera, so a segment that
   * closes early cannot arrive before anyone is listening.
   *
   * `remoteSessionReady` is the session-create promise, consumed as a signal:
   * it settles when the backend row exists OR when the deferred registration
   * has been accepted, and rejects only on a non-retryable refusal. Its
   * resolved VALUE is ignored, hence `Promise<unknown>` — the real promise
   * resolves with the session id, and declaring `Promise<void>` here would not
   * be assignable.
   */
  start(
    sessionId: string,
    options: GateHarnessOptions,
    remoteSessionReady: Promise<unknown>,
  ): Promise<void>;
  /**
   * Single-flight. Asks the recorder to stop exactly once, then waits for the
   * close barrier or the release deadline. Every caller — the PARAR tap and the
   * non-retryable-rejection abort — receives the same report.
   */
  stop(): Promise<CloseReport>;
  /** True while a native capture is running or its close is still in flight. */
  isActive(): boolean;
  /** Removes subscriptions. Writes nothing. For unmount and re-start. */
  dispose(): void;
}

// ------------------------------------------------------------------ internals

const DEFAULT_RELEASE_TIMEOUT_MS = 15_000;

/** How many missing indexes a gap log prints before it truncates. */
const GAP_LOG_LIMIT = 20;

interface IndexDerivation {
  /** Sanitised, deduplicated, ascending. */
  indexes: number[];
  /**
   * `max(indexes) + 1`, or 0 when empty. Computed from the last element of the
   * sorted array, which equals `Math.max(...indexes) + 1` without spreading a
   * potentially long array onto the call stack — an hour of capture at a 6 s
   * cadence is ~590 indexes.
   */
  next: number;
  /** True iff `indexes` is exactly `0..n-1`. */
  contiguousFromZero: boolean;
  /** Values dropped for not being non-negative safe integers. */
  rejected: number;
}

/**
 * The single derivation used for both durable and observed indexes.
 *
 * Deduplicates and validates rather than trusting a count: `segmentsObserved`
 * and `max + 1` coincide for a normal capture emitting 0..N-1, and that
 * equivalence must not become a silent assumption. A repeated event, a
 * non-integer crossing the bridge, or a gap all change the answer, and each one
 * is visible here instead of being averaged away.
 */
export function deriveIndexes(raw: readonly number[]): IndexDerivation {
  const seen = new Set<number>();
  let rejected = 0;
  for (const value of raw) {
    if (!Number.isSafeInteger(value) || value < 0) {
      rejected += 1;
      continue;
    }
    seen.add(value);
  }
  const indexes = Array.from(seen).sort((a, b) => a - b);
  const next = indexes.length === 0 ? 0 : indexes[indexes.length - 1]! + 1;
  const contiguousFromZero =
    indexes.length === next && indexes.every((value, i) => value === i);
  return { indexes, next, contiguousFromZero, rejected };
}

/** Indexes in `[0, next)` that are absent from `present`. */
function missingBelow(next: number, present: readonly number[]): number[] {
  const set = new Set(present);
  const out: number[] = [];
  for (let i = 0; i < next; i++) {
    if (!set.has(i)) out.push(i);
  }
  return out;
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

// ------------------------------------------------------------------- factory

export function createNativeSegmentedSession(
  deps: NativeSegmentedSessionDeps,
): NativeSegmentedSession {
  const releaseTimeoutMs = deps.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;

  /**
   * Lifecycle:
   *
   *   idle → open → released → closed          normal
   *   idle → open → timed_out → released → closed   late recovery
   *
   * `open` is the only state in which a segment may reach GC_QUEUE. Everything
   * later routes to the preservation sink.
   */
  let state: 'idle' | 'open' | 'released' | 'timed_out' | 'closed' = 'idle';
  let sessionId: string | null = null;

  /**
   * Bumped by every `start()` and by `dispose()`. Each listener and each
   * `remoteSessionReady` handler captures the value current at registration and
   * does nothing once it is stale, so a straggler from session N can never
   * mutate session N+1.
   */
  let generation = 0;

  let subscriptions: { remove(): void }[] = [];
  let adoptions = new Set<Promise<unknown>>();
  let adoptionsSettled = 0;
  let observedIndexes: number[] = [];
  let startedAtMs = 0;

  /** Drain gate. See `requestDrain`. */
  let remoteReady: 'pending' | 'ready' | 'rejected' = 'pending';
  let drainDeferred = false;

  let closeInFlight: Promise<CloseReport> | null = null;
  let stopPromise: Promise<CloseReport> | null = null;
  let releaseWaiters: (() => void)[] = [];

  function log(event: string, fields?: Record<string, unknown>): void {
    deps.logger.log(event, fields);
  }

  /**
   * The drain gate.
   *
   * Chunks are persisted the instant they are adopted — that never waits for
   * anything. What waits is waking the WORKER: uploading before the backend row
   * exists costs a round trip and a backoff on every chunk. So kicks raised by
   * this wiring are held until `remoteSessionReady` settles, and exactly one
   * kick then collects everything accumulated.
   *
   * Scope is honest and deliberately narrow: this gate holds back OUR kicks
   * only. The foreground service ticks `uploadDrainLoop` unconditionally, and
   * the foreground and boot kicks drain the whole queue including entries
   * recovered from previous runs — blocking those to protect one new session
   * would delay evidence that is already waiting. Those unavoidable early POSTs
   * are already safe by construction: `classifyError` maps SESSION_NOT_FOUND to
   * `transient` precisely so a capture started offline never loses chunks.
   */
  function requestDrain(): void {
    if (remoteReady === 'ready') {
      deps.queue.drain();
      return;
    }
    if (remoteReady === 'pending') {
      drainDeferred = true;
      return;
    }
    // rejected — the backend refused this session; draining it is pointless.
  }

  function onSegmentClosed(event: SegmentClosedEvent): void {
    const closedAtMs = deps.clock.now();
    const sid = sessionId;
    if (sid === null) return;
    if (event.sessionId !== sid) {
      log('GC_SEGMENT_FOREIGN_IGNORED', {
        sid_prefix: shortId(sid),
        got_prefix: shortId(event.sessionId),
        idx: event.segmentIndex,
      });
      return;
    }

    // Anything at or after the release is a contract violation: the native
    // module publishes every segment before `onCaptureReleased` on the same
    // FIFO handler. Its bytes are still preserved, but they must not reopen a
    // session whose completeness contract has already been written.
    const afterRelease = state !== 'open';
    if (afterRelease) {
      log('GC_SEGMENT_AFTER_RELEASE', {
        sid_prefix: shortId(sid),
        idx: event.segmentIndex,
        close_state: state,
      });
    } else {
      observedIndexes.push(event.segmentIndex);
    }

    const segment: ClosedSegment = {
      sessionId: event.sessionId,
      segmentIndex: event.segmentIndex,
      path: event.path,
      sizeBytes: event.sizeBytes,
    };
    const sink = afterRelease ? deps.preservationSink : deps.productionSink;

    const tracked = deps
      .adopt(segment, closedAtMs, sink)
      .then((record) => {
        adoptionsSettled += 1;
        if (afterRelease) {
          // NEVER report this as `adopted`. The adopter returns that outcome
          // when its own steps succeeded, and step 7 handed the chunk to a sink
          // that deliberately wrote nothing. The bytes are verified; the queue
          // is untouched. Conflating the two would be a false durability claim.
          if (record.outcome === 'conflict' || record.outcome === 'failed') {
            log('GC_SEGMENT_PRESERVE_FAILED', {
              sid_prefix: shortId(sid),
              idx: event.segmentIndex,
              outcome: record.outcome,
            });
          }
          return;
        }
        log('GC_SEGMENT_ADOPT_RESULT', {
          sid_prefix: shortId(sid),
          idx: event.segmentIndex,
          result: record.outcome,
          size: record.sizeBytes,
          closed_to_queue_ms: record.timings.closedToEnqueueMs,
        });
        if (record.outcome === 'adopted' || record.outcome === 'already_adopted') {
          requestDrain();
        }
      })
      .catch((err: unknown) => {
        // Defensive: `adoptSegment` returns failures as records and does not
        // throw. Reaching here means an unexpected layer failed, and the
        // capture must not be affected by it.
        adoptionsSettled += 1;
        log('GC_SEGMENT_ADOPT_THREW', {
          sid_prefix: shortId(sid),
          idx: event.segmentIndex,
          err: err instanceof Error ? err.message : String(err),
        });
      });

    adoptions.add(tracked);
    void tracked.finally(() => {
      adoptions.delete(tracked);
    });
  }

  function onCaptureError(event: CaptureErrorEvent): void {
    // Never tears anything down from here. A native failure drives its own
    // ordered teardown and still ends in `onCaptureReleased`, so the barrier
    // below stays the single close path.
    log('GC_SEGMENT_CAPTURE_ERROR', {
      sid_prefix: shortId(event.sessionId),
      code: event.code,
      message: event.message,
    });
  }

  function onCaptureReleased(event: CaptureReleasedEvent): void {
    const sid = sessionId;
    if (sid === null) return;
    if (event.sessionId !== sid) {
      log('GC_SEGMENT_FOREIGN_RELEASE_IGNORED', {
        sid_prefix: shortId(sid),
        got_prefix: shortId(event.sessionId),
      });
      return;
    }
    if (state === 'released' || state === 'closed') {
      log('GC_SEGMENT_RELEASE_DUPLICATE', { sid_prefix: shortId(sid) });
      return;
    }
    const late = state === 'timed_out';
    log(late ? 'GC_SEGMENT_RELEASE_LATE_RECOVERED' : 'GC_SEGMENT_RELEASED', {
      sid_prefix: shortId(sid),
      resources_freed: event.resourcesFreed,
      leaked: event.leaked,
      capture_ms: deps.clock.now() - startedAtMs,
    });
    state = 'released';
    // Runs synchronously up to its first `await`, which is how the snapshot of
    // in-flight adoptions is taken inside this handler.
    closeInFlight = performClose();
    void closeInFlight.catch(() => undefined);
    notifyRelease();
  }

  function notifyRelease(): void {
    const waiters = releaseWaiters;
    releaseWaiters = [];
    for (const waiter of waiters) waiter();
  }

  function buildReport(
    outcome: CloseOutcome,
    observed: IndexDerivation,
    durableChunks: number | null,
    nextChunkIndex: number | null,
    error?: string,
  ): CloseReport {
    const report: CloseReport = {
      outcome,
      sessionId: sessionId ?? '',
      segmentsObserved: observed.indexes.length,
      observedIndexes: observed.indexes,
      observedContiguousFromZero: observed.contiguousFromZero,
      adoptionsSettled,
      durableChunks,
      nextChunkIndex,
    };
    return error === undefined ? report : { ...report, error };
  }

  function logGap(source: 'durable' | 'observed', derived: IndexDerivation): void {
    if (derived.contiguousFromZero || derived.indexes.length === 0) return;
    const missing = missingBelow(derived.next, derived.indexes);
    log('GC_SEGMENT_INDEX_GAP', {
      sid_prefix: shortId(sessionId ?? ''),
      source,
      present: derived.indexes.length,
      next: derived.next,
      missing_count: missing.length,
      missing: missing.slice(0, GAP_LOG_LIMIT),
      truncated: missing.length > GAP_LOG_LIMIT,
    });
  }

  /**
   * THE close barrier.
   *
   *   native FIFO → onCaptureReleased
   *               → snapshot of registered adoptions   (synchronous, below)
   *               → await allSettled(snapshot)
   *               → read state from GC_QUEUE
   *               → derive next_chunk_index
   *               → markRecordingClosed
   *               → drain
   *
   * Re-reading the queue is mandatory, not tidiness. `queueAppendChunk` assigns
   * `next_chunk_index` unconditionally on every append, so with adoptions
   * running concurrently the persisted value is last-writer-wins, not a
   * maximum: if segment 4's copy finishes after segment 5's, the stored value
   * ends at 5. It also returns silently without appending when the entry is
   * missing or the index already exists. The only order-independent truth is
   * the set of `chunk_index` values actually present, and this close is also
   * where that skew gets repaired.
   */
  async function performClose(): Promise<CloseReport> {
    const sid = sessionId;
    const snapshot = Array.from(adoptions);
    const observed = deriveIndexes(observedIndexes);

    if (sid === null) {
      state = 'closed';
      return buildReport('no_entry', observed, null, null, 'no active session');
    }

    if (snapshot.length > 0) {
      log('GC_SEGMENT_CLOSE_WAITING', {
        sid_prefix: shortId(sid),
        in_flight: snapshot.length,
      });
      await Promise.allSettled(snapshot);
    }
    if (observed.rejected > 0) {
      log('GC_SEGMENT_INDEX_REJECTED', {
        sid_prefix: shortId(sid),
        source: 'observed',
        rejected: observed.rejected,
      });
    }

    let entries: readonly QueueEntrySnapshot[];
    try {
      entries = await deps.queue.read();
    } catch (err) {
      state = 'closed';
      const message = err instanceof Error ? err.message : String(err);
      log('GC_SEGMENT_CLOSE_QUEUE_READ_FAILED', {
        sid_prefix: shortId(sid),
        err: message,
      });
      return buildReport('no_entry', observed, null, null, message);
    }

    const entry = entries.find((e) => e.session_id === sid);
    if (!entry) {
      // Wiped externally, or reaped from under us. Nothing to close, and
      // fabricating an entry would invent evidence.
      state = 'closed';
      log('GC_SEGMENT_CLOSE_NO_ENTRY', { sid_prefix: shortId(sid) });
      return buildReport('no_entry', observed, null, null, 'entry absent from GC_QUEUE');
    }

    const durable = deriveIndexes(entry.chunks.map((c) => c.chunk_index));
    if (durable.rejected > 0) {
      log('GC_SEGMENT_INDEX_REJECTED', {
        sid_prefix: shortId(sid),
        source: 'durable',
        rejected: durable.rejected,
      });
    }

    // ---- at least one durable chunk: the ordinary close -------------------
    if (durable.indexes.length > 0) {
      logGap('durable', durable);
      await deps.queue.markRecordingClosed(sid, '', 0, durable.next);
      state = 'closed';
      log('GC_SEGMENT_CLOSED', {
        sid_prefix: shortId(sid),
        durable_chunks: durable.indexes.length,
        next_chunk_index: durable.next,
        segments_observed: observed.indexes.length,
      });
      requestDrain();
      return buildReport('closed', observed, durable.indexes.length, durable.next);
    }

    // ---- nothing durable, and nothing was ever produced -------------------
    if (observed.indexes.length === 0) {
      // No segment ever closed — a capture below the preroll, which a user can
      // produce by tapping GRABAR and PARAR in quick succession. There is no
      // evidence anywhere: `segments/<sid>/` was never even created. Removing
      // the local entry is the honest outcome; completing it would declare a
      // successful capture that never happened. The remote row is deliberately
      // left `active` and never completed — the same outcome the worker already
      // treats as correct when it cannot prove completeness.
      await deps.queue.dropEntry(sid);
      state = 'closed';
      log('GC_SEGMENT_CLOSE_NO_CAPTURE', {
        sid_prefix: shortId(sid),
        capture_ms: deps.clock.now() - startedAtMs,
      });
      return buildReport('no_capture', observed, 0, null);
    }

    // ---- segments existed, none reached the queue -------------------------
    // Closed and demonstrably INCOMPLETE. `recording_closed = true` is simply
    // true — after the release no chunk can join this session. Completeness is
    // carried by `next_chunk_index`, and setting it to the highest observed
    // index + 1 with zero uploaded chunks makes the existing completion gate
    // block on `missing = [0..next-1]`, which does NOT call completeSession and
    // does NOT reap. The entry survives restarts for diagnosis, and the bytes
    // are still in the native cache directory.
    logGap('observed', observed);
    await deps.queue.markRecordingClosed(sid, '', 0, observed.next);
    state = 'closed';
    log('GC_SEGMENT_CLOSE_ADOPTION_FAILED', {
      sid_prefix: shortId(sid),
      segments_observed: observed.indexes.length,
      expected_next_chunk_index: observed.next,
      observed_contiguous_from_zero: observed.contiguousFromZero,
      adoptions_settled: adoptionsSettled,
    });
    return buildReport('adoption_failed', observed, 0, observed.next);
  }

  async function doStop(): Promise<CloseReport> {
    const sid = sessionId;
    if (sid === null) {
      return buildReport(
        'no_entry',
        deriveIndexes(observedIndexes),
        null,
        null,
        'no active session',
      );
    }

    // Exactly once, whichever caller got here first: the PARAR tap or the
    // non-retryable-rejection abort. Both await this same promise.
    try {
      await deps.recorder.stopSegmentedCapture();
    } catch (err) {
      // The ordered close may already be under way natively; the barrier below
      // still decides the outcome.
      log('GC_SEGMENT_STOP_THREW', {
        sid_prefix: shortId(sid),
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const raced = await new Promise<'released' | 'timeout'>((resolve) => {
      if (closeInFlight !== null) {
        resolve('released');
        return;
      }
      let settled = false;
      const cancel = deps.clock.schedule(() => {
        if (settled) return;
        settled = true;
        resolve('timeout');
      }, releaseTimeoutMs);
      releaseWaiters.push(() => {
        if (settled) return;
        settled = true;
        cancel();
        resolve('released');
      });
    });

    if (raced === 'timeout') {
      // NOTHING is written. No `recording_closed`, no partial
      // `next_chunk_index`, no dropped entry. The originals stay in the native
      // cache, the verified copies stay under `segments/<sid>/`, and the open
      // queue entry is handed to the next boot's recovery. Listeners stay armed
      // on purpose: a late `onCaptureReleased` still runs the full barrier.
      state = 'timed_out';
      const observed = deriveIndexes(observedIndexes);
      log('GC_SEGMENT_RELEASE_TIMEOUT', {
        sid_prefix: shortId(sid),
        waited_ms: releaseTimeoutMs,
        segments_observed: observed.indexes.length,
        adoptions_settled: adoptionsSettled,
        adoptions_in_flight: adoptions.size,
      });
      return buildReport(
        'timeout',
        observed,
        null,
        null,
        `onCaptureReleased did not arrive within ${releaseTimeoutMs}ms`,
      );
    }

    // The release handler installed the close before waking us.
    return closeInFlight ?? performClose();
  }

  function disposeSubscriptions(): void {
    for (const sub of subscriptions) {
      try {
        sub.remove();
      } catch {
        /* best effort — a removed listener must never break a teardown */
      }
    }
    subscriptions = [];
  }

  return {
    async start(sid, options, remoteSessionReady) {
      // Any previous session's listeners go first: two live subscriptions would
      // adopt every segment twice.
      disposeSubscriptions();
      const gen = ++generation;
      sessionId = sid;
      state = 'open';
      adoptions = new Set();
      adoptionsSettled = 0;
      observedIndexes = [];
      remoteReady = 'pending';
      drainDeferred = false;
      closeInFlight = null;
      stopPromise = null;
      releaseWaiters = [];
      startedAtMs = deps.clock.now();

      // Listeners BEFORE the camera: `rotateAtMs` is 3 s, but a failure path
      // can emit far sooner, and an event with nobody listening is a lost
      // segment.
      subscriptions = [
        deps.recorder.addListener('onSegmentClosed', (event) => {
          if (gen === generation) onSegmentClosed(event);
        }),
        deps.recorder.addListener('onCaptureError', (event) => {
          if (gen === generation) onCaptureError(event);
        }),
        deps.recorder.addListener('onCaptureReleased', (event) => {
          if (gen === generation) onCaptureReleased(event);
        }),
      ];

      remoteSessionReady.then(
        () => {
          if (gen !== generation) return;
          remoteReady = 'ready';
          if (!drainDeferred) return;
          drainDeferred = false;
          log('GC_SEGMENT_DRAIN_RELEASED', { sid_prefix: shortId(sid) });
          deps.queue.drain();
        },
        () => {
          if (gen !== generation) return;
          remoteReady = 'rejected';
          log('GC_SEGMENT_DRAIN_SUPPRESSED', {
            sid_prefix: shortId(sid),
            reason: 'remote_rejected',
          });
        },
      );

      log('GC_SEGMENT_SESSION_START', {
        sid_prefix: shortId(sid),
        rotate_at_ms: options.rotateAtMs,
        rotation_interval_ms: options.rotationIntervalMs,
        session_ms: options.sessionMs,
      });

      try {
        await deps.recorder.startSegmentedCapture(sid, options);
      } catch (err) {
        // The native module refused the start; no session exists to close.
        disposeSubscriptions();
        state = 'idle';
        sessionId = null;
        generation += 1;
        throw err;
      }
    },

    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = doStop();
      return stopPromise;
    },

    isActive() {
      return sessionId !== null && (state === 'open' || state === 'released');
    },

    dispose() {
      disposeSubscriptions();
      generation += 1;
      state = 'idle';
      sessionId = null;
      releaseWaiters = [];
    },
  };
}
