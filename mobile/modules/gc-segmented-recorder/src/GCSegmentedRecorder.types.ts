/**
 * SPIKE — P2 early gate. Types for the native segmented recorder.
 *
 * Not production code. Lives only on `spike/video-p2-early-gate`.
 */

/**
 * DIAGNOSTIC-ONLY harness overrides for `startSegmentedCapture`.
 *
 * Only `/debug-p2-gate` passes these, and that route renders nothing outside a
 * development build. Omitting the argument — what any other caller does —
 * reproduces the historical session exactly: one rotation at 3 s, stop at 7 s,
 * two segments.
 *
 * Every value is validated natively against `HarnessBounds` and an out-of-range
 * value REJECTS the start rather than being clamped, so a harness run can never
 * silently differ from what was asked for.
 */
export type GateHarnessOptions = {
  /** Delay from camera-open to the first rotation. Default 3000. */
  rotateAtMs?: number;
  /**
   * Delay from a segment closing to the next rotation. `0` (the default) means
   * no further rotations. Measured from the segment-closed callback, so the
   * effective period includes the muxer stop and the stability check.
   */
  rotationIntervalMs?: number;
  /** Total session duration before the ordered stop. Default 7000. */
  sessionMs?: number;
};

/** Emitted when a segment has been closed AND verified stable on disk. */
export type SegmentClosedEvent = {
  sessionId: string;
  segmentIndex: number;
  /** Absolute path inside the app's private cache. */
  path: string;
  sizeBytes: number;
  /** Session-clock PTS of the keyframe that defined the boundary. */
  cutPtsUs: number;
  /** How far segment 1's last AAC frame overruns the cut. 0…~23220 µs. */
  audioTailUs: number;
  /** Gap between the cut and segment 2's first AAC frame. >= 0 by design. */
  audioLeadUs: number;
  keyframeWaitMs: number;
  muxerStopMs: number;
  queuePeakEntries: number;
  queuePeakBytes: number;
  audioFramesDropped: number;
  audioFramesDuplicated: number;
  videoFramesDropped: number;
  rebaseNegativeCount: number;
};

export type CaptureErrorEvent = {
  sessionId: string;
  /** See `ErrorCode` in the Kotlin module — every failure is explicit. */
  code: string;
  message: string;
};

/**
 * Emitted once a session has been FINALISED — which means both encoders
 * reported a real release outcome, not merely that a teardown was requested.
 *
 * Emitted from exactly one place in Kotlin (`finalizeSession`), on two
 * mutually exclusive branches. Both send all three fields, always, so none of
 * them is optional:
 *
 *   clean  → `{ sessionId, resourcesFreed: true,  leaked: [] }`
 *   dirty  → `{ sessionId, resourcesFreed: false, leaked: [...] }`, preceded by
 *            an `onCaptureError` carrying the same session id
 *
 * Invariant held by the emitter: `resourcesFreed === (leaked.length === 0)`.
 * The two fields are both present because a receiver should be able to test
 * either one without inferring it from the other.
 */
export type CaptureReleasedEvent = {
  sessionId: string;
  /**
   * `false` means the full release could NOT be confirmed. It does not say
   * which way it failed, and callers must not assume one: the encoders reach
   * it both by deliberately leaving handles alone (a worker thread never
   * provably terminated, so freeing would have been a use-after-free) and by
   * attempting the release and having a `release()` call throw, leaving the
   * handle's fate unknown.
   *
   * Either way the outcome is the same and it is terminal: resources are
   * presumed still held, and no further capture can be started in the same
   * process. Never treat it as a clean release.
   */
  resourcesFreed: boolean;
  /**
   * Components whose native resources could not be freed. Empty on a clean
   * release. Kotlin only ever puts `'video'` and/or `'audio'` in it, in that
   * order, but the contract is left open because the emitter builds the list
   * from component names rather than from a closed set.
   */
  leaked: string[];
};

export type GCSegmentedRecorderEvents = {
  onSegmentClosed: (event: SegmentClosedEvent) => void;
  onCaptureError: (event: CaptureErrorEvent) => void;
  onCaptureReleased: (event: CaptureReleasedEvent) => void;
};
