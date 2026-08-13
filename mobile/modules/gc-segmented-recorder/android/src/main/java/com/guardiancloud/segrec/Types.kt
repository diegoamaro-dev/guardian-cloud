package com.guardiancloud.segrec

/**
 * SPIKE — P2 early gate. Shared types and error codes.
 *
 * Not production code. Lives only on `spike/video-p2-early-gate`.
 */

/**
 * Coordinator state machine. Mutated ONLY on the coordinator thread.
 *
 * [CUT_KNOWN_WAITING_AUDIO] exists because a keyframe fixes `cutPtsUs` but
 * does NOT authorise closing segment 1: audio with `pts < cutPtsUs` may still
 * be in flight. Closing at keyframe arrival would silently drop it.
 */
enum class GateState {
  IDLE,
  STARTING,
  PREROLL,
  RECORDING,
  KEYFRAME_REQUESTED,
  CUT_KNOWN_WAITING_AUDIO,
  ROTATING,
  RECORDING_SECOND,

  /**
   * Stop arrived while a rotation was mid-flight (KEYFRAME_REQUESTED,
   * CUT_KNOWN_WAITING_AUDIO or ROTATING), so `retained` still holds samples
   * older than anything arriving now.
   *
   * New samples keep being RETAINED here, never written through: writing them
   * straight to the muxer would place them ahead of older retained samples and
   * break per-track ordering. The boundary is resolved at EOS.
   */
  STOPPING_PENDING_BOUNDARY,

  /**
   * Stop arrived before the first muxer existed. Formats and samples keep
   * accumulating in `preroll` throughout the EOS drain, and the final EOS pass
   * still gets a chance to open segment 0 if both formats and a first keyframe
   * turned up.
   *
   * Distinct from [STOPPING] because in STOPPING a muxer is already open and
   * write-through is legal; here `muxer == null`, and writing would discard
   * the sample.
   */
  STOPPING_PREROLL,

  STOPPING,
  COMPLETED,
  FAILED,

  /**
   * `MediaMuxer.stop()` was entered and has not returned. Android offers no
   * cancellation for it. Terminal and honest: session lost, segment not
   * emitted, capture blocked.
   */
  FAILED_PENDING_NATIVE_RETURN,
}

/** Every terminal failure the gate can report. No silent recovery anywhere. */
object ErrorCode {
  // Refusals raised before a session is accepted: the id is not a canonical
  // UUID, or its output directory cannot be used without destroying evidence.
  const val SESSION_ID_INVALID = "SESSION_ID_INVALID"
  const val SESSION_DIR_NOT_EMPTY = "SESSION_DIR_NOT_EMPTY"
  const val SESSION_DIR_UNAVAILABLE = "SESSION_DIR_UNAVAILABLE"

  const val AUDIO_TIMESTAMP_UNAVAILABLE = "AUDIO_TIMESTAMP_UNAVAILABLE"
  const val VIDEO_PTS_REORDERING_DETECTED = "VIDEO_PTS_REORDERING_DETECTED"
  const val AUDIO_PTS_REORDERING_DETECTED = "AUDIO_PTS_REORDERING_DETECTED"
  const val ROTATION_KEYFRAME_TIMEOUT = "ROTATION_KEYFRAME_TIMEOUT"
  const val ROTATION_AUDIO_WATERMARK_TIMEOUT = "ROTATION_AUDIO_WATERMARK_TIMEOUT"
  const val PREROLL_KEYFRAME_TIMEOUT = "PREROLL_KEYFRAME_TIMEOUT"
  const val PREROLL_QUEUE_OVERFLOW = "PREROLL_QUEUE_OVERFLOW"
  const val ROTATION_QUEUE_OVERFLOW = "ROTATION_QUEUE_OVERFLOW"
  const val STABILITY_BACKLOG_OVERFLOW = "STABILITY_BACKLOG_OVERFLOW"
  const val PCM_QUEUE_OVERFLOW = "PCM_QUEUE_OVERFLOW"
  const val INTAKE_QUEUE_OVERFLOW = "INTAKE_QUEUE_OVERFLOW"
  const val CLOCK_ALIGNMENT_UNRESOLVED = "CLOCK_ALIGNMENT_UNRESOLVED"
  const val EOS_DRAIN_TIMEOUT = "EOS_DRAIN_TIMEOUT"
  const val STABILITY_CHECK_THREW = "STABILITY_CHECK_THREW"
  const val MUXER_STOP_TIMEOUT = "MUXER_STOP_TIMEOUT"
  const val MUXER_STOP_THREW = "MUXER_STOP_THREW"
  const val MUXER_STOP_NO_RETURN = "MUXER_STOP_NO_RETURN"
  const val SEGMENT_UNSTABLE_AFTER_CLOSE = "SEGMENT_UNSTABLE_AFTER_CLOSE"
  const val CODEC_FORMAT_CHANGED_MIDSESSION = "CODEC_FORMAT_CHANGED_MIDSESSION"
  const val REBASE_NEGATIVE_PTS = "REBASE_NEGATIVE_PTS"
  const val CAMERA_LOST = "CAMERA_LOST"
  const val CAMERA_OPEN_FAILED = "CAMERA_OPEN_FAILED"
  const val ENCODER_FAILED = "ENCODER_FAILED"
  const val SURFACE_LOST = "SURFACE_LOST"
  const val INVALID_STATE = "INVALID_STATE"
}

enum class TrackKind { VIDEO, AUDIO }

/**
 * A sample already COPIED out of the MediaCodec output buffer.
 *
 * The originating buffer is released immediately after the copy: retaining
 * encoder buffers across a rotation would starve the encoder and stop it,
 * which breaks P2's central premise.
 */
class QueuedSample(
  val kind: TrackKind,
  val data: ByteArray,
  /** Session-clock PTS in microseconds — see [SessionClock]. */
  val ptsUs: Long,
  val flags: Int,
  val isKeyFrame: Boolean,
  /** Monotonic per-track counter; preserves delivery order for diagnostics. */
  val deliverySeq: Long,
) {
  val sizeBytes: Int get() = data.size
}

object Limits {
  const val KEYFRAME_WAIT_LIMIT_MS = 1000L
  /** After the cut is known, how long we wait for audio to cross it. */
  const val AUDIO_WATERMARK_LIMIT_MS = 1000L
  /** Preroll: how long we wait for both formats plus the first keyframe. */
  const val PREROLL_LIMIT_MS = 3000L

  const val QUEUE_MAX_ENTRIES = 256
  const val QUEUE_MAX_BYTES = 8 * 1024 * 1024
  const val PREROLL_MAX_ENTRIES = 256
  const val PREROLL_MAX_BYTES = 8 * 1024 * 1024
  /** Segments awaiting asynchronous stability verification. */
  const val STABILITY_MAX_PENDING = 8

  /**
   * Intake accounting: samples reserved BEFORE `handler.post`, so anything
   * sitting in the Handler's MessageQueue counts against the limit too.
   */
  const val INTAKE_MAX_ENTRIES = 512
  const val INTAKE_MAX_BYTES = 16 * 1024 * 1024

  /** PCM captured but not yet accepted by the audio encoder. */
  const val PCM_MAX_ENTRIES = 256
  const val PCM_MAX_BYTES = 4 * 1024 * 1024

  /** How long the EOS drain may take before it is a visible failure. */
  const val EOS_DRAIN_LIMIT_MS = 3000L

  /** Samples used to resolve the encoder↔audio clock relation. */
  const val CLOCK_RESOLVE_MIN_SAMPLES = 20
  /** Max spread of (observed − encoderPts) for the bases to count as stable. */
  const val CLOCK_RESOLVE_MAX_SPREAD_NS = 50_000_000L
  const val CLOCK_RESOLVE_LIMIT_MS = 2000L

  const val MUXER_STOP_WARN_MS = 500L
  const val MUXER_STOP_FAIL_MS = 2000L
  const val MUXER_STOP_WATCHDOG_MS = 5000L

  const val AUDIO_ANCHOR_WARMUP_MS = 500L
  const val STABILITY_CHECK_1_MS = 1000L
  const val STABILITY_CHECK_2_MS = 5000L
}

data class CaptureConfig(
  val width: Int = 640,
  val height: Int = 480,
  val videoBitrate: Int = 500_000,
  val frameRate: Int = 30,
  val iFrameIntervalS: Int = 1,
  val audioSampleRate: Int = 44_100,
  val audioChannels: Int = 1,
  val audioBitrate: Int = 64_000,
  /** Delay from camera-open to the FIRST rotation. */
  val rotateAtMs: Long = 3_000,
  /**
   * Delay from a segment closing to the NEXT rotation.
   *
   * `0` means no further rotations, which is exactly the historical behaviour:
   * one rotation at [rotateAtMs] and two segments. Any positive value chains
   * rotations for as long as the session lasts.
   *
   * It is measured from the segment-closed callback, not from a wall clock, so
   * the effective period is this value plus however long the muxer stop and the
   * stability check took. That is deliberate: a closed, stability-verified
   * segment is the only evidence available that the previous rotation actually
   * finished, and chaining from it is what guarantees a single rotation in
   * flight.
   */
  val rotationIntervalMs: Long = 0,
  val sessionMs: Long = 7_000,
)

/**
 * Bounds for the harness parameters a diagnostic caller may override.
 *
 * These are NOT product limits. They exist so that a typo in the debug route
 * cannot arm a rotation every five milliseconds, or a twelve-hour session, on a
 * device that is holding evidence. Anything outside them is rejected before a
 * session is accepted, with no resource allocated.
 */
object HarnessBounds {
  const val MIN_ROTATE_AT_MS = 1_000L
  const val MAX_ROTATE_AT_MS = 600_000L

  /** 0 is legal and means "do not rotate again"; otherwise this floor applies. */
  const val MIN_ROTATION_INTERVAL_MS = 1_000L
  const val MAX_ROTATION_INTERVAL_MS = 600_000L

  const val MIN_SESSION_MS = 2_000L
  const val MAX_SESSION_MS = 3_600_000L

  /** The session must outlast its first rotation by at least this much. */
  const val MIN_TAIL_AFTER_FIRST_ROTATION_MS = 1_000L
}

/**
 * Immutable per-segment metrics snapshot.
 *
 * Built by [BoundaryMetricsBuilder] and frozen when the segment closes, so two
 * segment events never share one mutable object.
 */
data class BoundaryMetrics(
  val segmentIndex: Int,
  val originUs: Long,
  val cutPtsUs: Long,
  val audioTailUs: Long,
  val audioLeadUs: Long,
  val audioFramesDropped: Int,
  val audioFramesDuplicated: Int,
  val videoFramesDropped: Int,
  val rebaseNegativeCount: Int,
  val keyframeWaitMs: Long,
  val audioWatermarkWaitMs: Long,
  val muxerStopMs: Long,
  val queuePeakEntries: Int,
  val queuePeakBytes: Int,
  /** Offset of the first video sample inside the segment; 0 after a rotation. */
  val videoStartOffsetUs: Long,
  val videoSamples: Int,
  val audioSamples: Int,
)

/** Mutable accumulator; never handed to JS. */
class BoundaryMetricsBuilder(val segmentIndex: Int) {
  var originUs: Long = 0
  var cutPtsUs: Long = -1
  var audioTailUs: Long = -1
  var audioLeadUs: Long = -1
  var audioFramesDropped: Int = 0
  var audioFramesDuplicated: Int = 0
  var videoFramesDropped: Int = 0
  var rebaseNegativeCount: Int = 0
  var keyframeWaitMs: Long = -1
  var audioWatermarkWaitMs: Long = -1
  var muxerStopMs: Long = -1
  var queuePeakEntries: Int = 0
  var queuePeakBytes: Int = 0
  var videoStartOffsetUs: Long = -1
  var videoSamples: Int = 0
  var audioSamples: Int = 0

  fun freeze(): BoundaryMetrics = BoundaryMetrics(
    segmentIndex, originUs, cutPtsUs, audioTailUs, audioLeadUs,
    audioFramesDropped, audioFramesDuplicated, videoFramesDropped,
    rebaseNegativeCount, keyframeWaitMs, audioWatermarkWaitMs, muxerStopMs,
    queuePeakEntries, queuePeakBytes, videoStartOffsetUs,
    videoSamples, audioSamples,
  )
}
