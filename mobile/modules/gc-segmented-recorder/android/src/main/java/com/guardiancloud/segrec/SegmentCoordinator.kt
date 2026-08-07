package com.guardiancloud.segrec

import android.media.MediaCodec
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * SPIKE — P2 early gate. Contracts 3 and 4, plus the preroll and boundary
 * barriers demanded by static review.
 *
 * SOLE OWNER of every `MediaMuxer`. Encoder threads only copy their output and
 * post it here; only this class calls `addTrack`, `start`, `writeSampleData`,
 * `stop` and `release`, and only the coordinator thread mutates [state].
 */
class SegmentCoordinator(
  private val outputDir: File,
  private val config: CaptureConfig,
  private val onSegmentClosed: (BoundaryMetrics, File) -> Unit,
  private val onFailure: (code: String, message: String) -> Unit,
) {

  private val thread = HandlerThread("gc-segrec-coordinator").apply { start() }
  private val handler = Handler(thread.looper)

  /** Off the coordinator thread: stability checks and the stop() watchdog. */
  private val auxThread = HandlerThread("gc-segrec-aux").apply { start() }
  private val auxHandler = Handler(auxThread.looper)

  /**
   * Set by the watchdog from another thread. It NEVER writes [rawState] —
   * ownership of the state variable stays single-writer on the coordinator
   * thread. [state] folds the two honestly.
   */
  private val nativeStopStalled = AtomicBoolean(false)

  @Volatile private var rawState: GateState = GateState.IDLE

  val state: GateState
    get() = if (nativeStopStalled.get()) GateState.FAILED_PENDING_NATIVE_RETURN else rawState

  private fun setState(s: GateState) {
    rawState = s
    Log.i(TAG, "GC_P2_GATE state=$s")
  }

  // ---- conserved output formats ---------------------------------------

  private var videoFormat: MediaFormat? = null
  private var audioFormat: MediaFormat? = null

  private var muxer: MediaMuxer? = null
  private var muxerVideoTrack = -1
  private var muxerAudioTrack = -1
  private var muxerStarted = false
  private var segmentIndex = 0
  private var currentFile: File? = null
  private var segmentOriginUs = 0L
  private var metrics = BoundaryMetricsBuilder(0)

  // ---- queues ---------------------------------------------------------

  /** Preroll: everything before the first muxer exists. Bounded. */
  private val preroll = ArrayList<QueuedSample>()
  private var prerollBytes = 0

  /**
   * Last `first_segment_waiting` combination emitted, so that line is logged on
   * CHANGE only. `tryOpenFirstSegment()` is called once per incoming sample;
   * logging unconditionally would produce one entry per sample.
   */
  private var lastWaitingSignature: String? = null

  /** Retention across the rotation barrier. Bounded. */
  private val retained = ArrayList<QueuedSample>()
  private var retainedBytes = 0

  /** Segments whose stability is still being verified. Bounded. */
  private var pendingStability = 0

  // ---- rotation bookkeeping -------------------------------------------

  private var rotationGeneration = 0L
  private var keyframeRequestedAtMs = 0L
  private var cutKnownAtMs = 0L
  private var cutPtsUs = -1L
  private var cutKeyframe: QueuedSample? = null
  private var sessionStartedAtMs = 0L

  private var lastVideoPtsUs = Long.MIN_VALUE
  private var lastAudioPtsUs = Long.MIN_VALUE

  /** In-flight intake, reserved before `handler.post` — see [submit]. */
  private val intakeEntries = java.util.concurrent.atomic.AtomicInteger(0)
  private val intakeBytes = java.util.concurrent.atomic.AtomicLong(0)

  /** Signalled by the module once BOTH encoders have drained their EOS. */
  private var eosComplete = false
  private var releaseRequested = false
  private var onFullyReleased: (() -> Unit)? = null

  // =====================================================================
  // Lifecycle
  // =====================================================================

  fun markStarting() = handler.post {
    setState(GateState.STARTING)
    sessionStartedAtMs = SystemClock.elapsedRealtime()
    val gen = ++rotationGeneration
    // Preroll deadline fires even if NO sample ever arrives.
    handler.postDelayed({
      if (gen == rotationGeneration &&
        (rawState == GateState.STARTING || rawState == GateState.PREROLL)
      ) {
        fail(
          ErrorCode.PREROLL_KEYFRAME_TIMEOUT,
          "no first keyframe / formats within ${Limits.PREROLL_LIMIT_MS}ms " +
            "(video=${videoFormat != null} audio=${audioFormat != null} preroll=${preroll.size})",
        )
      }
    }, Limits.PREROLL_LIMIT_MS)
  }

  fun onVideoFormat(format: MediaFormat) = handler.post {
    if (videoFormat != null) {
      fail(ErrorCode.CODEC_FORMAT_CHANGED_MIDSESSION, "video format changed mid-session")
      return@post
    }
    videoFormat = format
    Log.i(TAG, "GC_P2_GATE video_format_conserved $format")
    tryOpenFirstSegment()
  }

  fun onAudioFormat(format: MediaFormat) = handler.post {
    if (audioFormat != null) {
      fail(ErrorCode.CODEC_FORMAT_CHANGED_MIDSESSION, "audio format changed mid-session")
      return@post
    }
    audioFormat = format
    Log.i(TAG, "GC_P2_GATE audio_format_conserved $format")
    tryOpenFirstSegment()
  }

  // =====================================================================
  // Sample intake — already COPIED by the encoder threads
  // =====================================================================

  /**
   * Intake accounting (point 5): the reservation happens on the CALLER thread,
   * BEFORE `handler.post`, so samples still sitting in the Handler's
   * MessageQueue count against the limit. The reservation is released when the
   * coordinator actually consumes the task.
   */
  fun submit(sample: QueuedSample) {
    val entries = intakeEntries.incrementAndGet()
    val bytes = intakeBytes.addAndGet(sample.sizeBytes.toLong())
    if (entries > Limits.INTAKE_MAX_ENTRIES || bytes > Limits.INTAKE_MAX_BYTES) {
      intakeEntries.decrementAndGet()
      intakeBytes.addAndGet(-sample.sizeBytes.toLong())
      handler.post {
        fail(
          ErrorCode.INTAKE_QUEUE_OVERFLOW,
          "intake overflow entries=$entries bytes=$bytes (in-flight incl. MessageQueue)",
        )
      }
      return
    }
    handler.post {
      intakeEntries.decrementAndGet()
      intakeBytes.addAndGet(-sample.sizeBytes.toLong())
      consume(sample)
    }
  }

  private fun consume(sample: QueuedSample) {
    if (!guardMonotonic(sample)) return

    when (rawState) {
      // Nothing is dropped before the first muxer exists — including while a
      // stop is draining: the final EOS pass may still open segment 0.
      GateState.STARTING, GateState.PREROLL, GateState.STOPPING_PREROLL -> {
        enqueuePreroll(sample)
        tryOpenFirstSegment()
      }

      GateState.RECORDING, GateState.RECORDING_SECOND -> writeToMuxer(sample)

      // Contract 3: from here nothing whose segment depends on cutPtsUs may be
      // written. Audio always depends on it; video is held too because a
      // reordering encoder could deliver a later-PTS sample before the keyframe.
      GateState.KEYFRAME_REQUESTED -> {
        if (sample.kind == TrackKind.VIDEO && sample.isKeyFrame) onCutFound(sample)
        else enqueueRetained(sample)
      }

      // The cut is known but audio has not crossed it yet. Keep retaining.
      GateState.CUT_KNOWN_WAITING_AUDIO -> {
        enqueueRetained(sample)
        maybeCompleteRotation()
      }

      GateState.ROTATING -> enqueueRetained(sample)

      // Plain STOPPING is only entered from RECORDING / RECORDING_SECOND /
      // STARTING / PREROLL, where `retained` is empty — so writing through
      // preserves order.
      GateState.STOPPING ->
        if (retained.isEmpty()) writeToMuxer(sample) else enqueueRetained(sample)

      // Rotation was in flight: keep retaining so nothing overtakes an older
      // sample still sitting in `retained`.
      GateState.STOPPING_PENDING_BOUNDARY -> enqueueRetained(sample)

      else -> countDrop(sample)
    }
  }

  /** Per-track delivery-order guard, with the right code per track. */
  private fun guardMonotonic(sample: QueuedSample): Boolean {
    val last = if (sample.kind == TrackKind.VIDEO) lastVideoPtsUs else lastAudioPtsUs
    if (last != Long.MIN_VALUE && sample.ptsUs < last) {
      val code =
        if (sample.kind == TrackKind.VIDEO) ErrorCode.VIDEO_PTS_REORDERING_DETECTED
        else ErrorCode.AUDIO_PTS_REORDERING_DETECTED
      fail(code, "${sample.kind} pts regression: ${sample.ptsUs} < $last seq=${sample.deliverySeq}")
      return false
    }
    if (sample.kind == TrackKind.VIDEO) lastVideoPtsUs = sample.ptsUs
    else lastAudioPtsUs = sample.ptsUs
    return true
  }

  private fun countDrop(sample: QueuedSample) {
    if (sample.kind == TrackKind.VIDEO) metrics.videoFramesDropped++
    else metrics.audioFramesDropped++
  }

  private fun enqueuePreroll(s: QueuedSample) {
    preroll.add(s)
    prerollBytes += s.sizeBytes
    if (preroll.size > Limits.PREROLL_MAX_ENTRIES || prerollBytes > Limits.PREROLL_MAX_BYTES) {
      fail(
        ErrorCode.PREROLL_QUEUE_OVERFLOW,
        "preroll overflow entries=${preroll.size} bytes=$prerollBytes",
      )
    }
  }

  private fun enqueueRetained(s: QueuedSample) {
    retained.add(s)
    retainedBytes += s.sizeBytes
    if (retained.size > metrics.queuePeakEntries) metrics.queuePeakEntries = retained.size
    if (retainedBytes > metrics.queuePeakBytes) metrics.queuePeakBytes = retainedBytes
    if (retained.size > Limits.QUEUE_MAX_ENTRIES || retainedBytes > Limits.QUEUE_MAX_BYTES) {
      fail(
        ErrorCode.ROTATION_QUEUE_OVERFLOW,
        "retention overflow entries=${retained.size} bytes=$retainedBytes",
      )
    }
  }

  // =====================================================================
  // Preroll → first segment.  G4 must hold for BOTH files.
  // =====================================================================

  /**
   * Opens segment 0 once we have both formats, the first video keyframe AND at
   * least one real sample of EACH track already in the preroll.
   *
   * Origin is `min(firstKeyframePts, firstAudioPts)` over the preroll, so both
   * tracks survive with non-negative PTS and nothing is discarded to make the
   * tracks start together. The first VIDEO sample written is the keyframe —
   * G4 — even though it may sit at a positive offset inside the segment when
   * audio started earlier. That offset is reported as `videoStartOffsetUs`.
   *
   * WHY WAITING FOR AUDIO IS PART OF THE CONDITION. The two encoders hold
   * INDEPENDENT pre-t0 buffers and flush them independently once `t0` exists.
   * Video flushed first, the keyframe opened the segment, and `firstAudio` was
   * still null — so the origin was frozen at the keyframe's PTS. The audio
   * flush landed one millisecond later, already in RECORDING, and its earliest
   * sample rebased to `0 - 449108`, failing with REBASE_NEGATIVE_PTS.
   *
   * Audio precedes video structurally on this hardware: AudioRecord captures
   * immediately while the camera needs ~449 ms to deliver its first encoded
   * frame, so that race was deterministic, not intermittent.
   *
   * Waiting does NOT remove the offset — it is real and stays reported in
   * `videoStartOffsetUs`. It only guarantees the origin is computed with both
   * candidates present, which is what the existing `minOf` always assumed.
   */
  private fun tryOpenFirstSegment() {
    // STOPPING_PREROLL is included on purpose: a stop must not prevent the
    // segment from opening if the formats and keyframe do turn up.
    if (rawState != GateState.STARTING &&
      rawState != GateState.PREROLL &&
      rawState != GateState.STOPPING_PREROLL
    ) return
    if (videoFormat == null || audioFormat == null) return
    if (rawState == GateState.STARTING) setState(GateState.PREROLL)

    val kfIndex = preroll.indexOfFirst { it.kind == TrackKind.VIDEO && it.isKeyFrame }

    // Presence is decided from samples ACTUALLY in the preroll — not from the
    // formats, which arrive from `onVideoFormat`/`onAudioFormat` long before
    // any media does, and not from the encoders having started.
    val hasKeyframe = kfIndex >= 0
    val hasVideoSample = preroll.any { it.kind == TrackKind.VIDEO }
    val firstAudio = preroll.firstOrNull { it.kind == TrackKind.AUDIO }
    val hasAudioSample = firstAudio != null

    // The null test is written against `firstAudio` itself, not against
    // `hasAudioSample`: only the direct form guarantees the smart-cast that
    // makes `firstAudio.ptsUs` legal below without `!!`.
    if (!hasKeyframe || !hasVideoSample || firstAudio == null) {
      // Logged on CHANGE only. `tryOpenFirstSegment()` runs on every incoming
      // sample, so an unconditional line here would be one entry per sample.
      val signature = "$hasVideoSample/$hasAudioSample/$hasKeyframe"
      if (signature != lastWaitingSignature) {
        lastWaitingSignature = signature
        Log.i(
          TAG,
          "GC_P2_GATE first_segment_waiting has_video_sample=$hasVideoSample " +
            "has_audio_sample=$hasAudioSample has_keyframe=$hasKeyframe",
        )
      }
      // Bounded by construction: the deadline armed in `markStarting()` fires
      // PREROLL_KEYFRAME_TIMEOUT regardless of what is missing, and
      // `onEosComplete()` fails the session if EOS arrives with no muxer. This
      // return can never park the session forever.
      return
    }

    val keyframe = preroll[kfIndex]
    val origin = minOf(keyframe.ptsUs, firstAudio.ptsUs)
    Log.i(
      TAG,
      "GC_P2_GATE first_segment_origin origin_us=$origin " +
        "first_video_us=${keyframe.ptsUs} first_audio_us=${firstAudio.ptsUs}",
    )

    // Video before the first keyframe cannot open a decodable segment. It is
    // excluded EXPLICITLY and counted — never silently.
    val excludedVideo = preroll.count {
      it.kind == TrackKind.VIDEO && it.ptsUs < keyframe.ptsUs
    }

    metrics = BoundaryMetricsBuilder(segmentIndex)
    metrics.originUs = origin
    metrics.videoFramesDropped = excludedVideo
    segmentOriginUs = origin

    if (!openSegment()) return

    val ordered = preroll
      .filter { !(it.kind == TrackKind.VIDEO && it.ptsUs < keyframe.ptsUs) }
      .sortedWith(orderWithin)
    for (s in ordered) writeToMuxer(s)

    Log.i(
      TAG,
      "GC_P2_GATE preroll_flushed origin_us=$origin kept=${ordered.size} " +
        "excluded_video=$excludedVideo video_start_offset_us=${metrics.videoStartOffsetUs}",
    )
    preroll.clear()
    prerollBytes = 0
    // A stop already in flight must not be undone by the segment finally
    // opening: it graduates to plain STOPPING, where a muxer now exists and
    // write-through is legal.
    setState(
      if (rawState == GateState.STOPPING_PREROLL) GateState.STOPPING else GateState.RECORDING,
    )
  }

  // =====================================================================
  // Rotation — with the full A/V boundary barrier
  // =====================================================================

  fun requestRotation() = handler.post {
    if (rawState != GateState.RECORDING) {
      Log.w(TAG, "GC_P2_GATE rotation requested in state=$rawState — ignored")
      return@post
    }
    setState(GateState.KEYFRAME_REQUESTED)
    keyframeRequestedAtMs = SystemClock.elapsedRealtime()
    val gen = ++rotationGeneration

    // Independent deadline: fires even if NO sample ever arrives. The
    // generation token stops a stale callback from touching a later session.
    handler.postDelayed({
      if (gen != rotationGeneration) return@postDelayed
      if (rawState == GateState.KEYFRAME_REQUESTED) {
        fail(
          ErrorCode.ROTATION_KEYFRAME_TIMEOUT,
          "no keyframe within ${Limits.KEYFRAME_WAIT_LIMIT_MS}ms",
        )
      }
    }, Limits.KEYFRAME_WAIT_LIMIT_MS)
  }

  /** The keyframe fixes the cut. It does NOT authorise closing segment 1. */
  private fun onCutFound(keyframe: QueuedSample) {
    cutPtsUs = keyframe.ptsUs
    cutKeyframe = keyframe
    cutKnownAtMs = SystemClock.elapsedRealtime()
    metrics.cutPtsUs = cutPtsUs
    metrics.keyframeWaitMs = cutKnownAtMs - keyframeRequestedAtMs
    enqueueRetained(keyframe)
    setState(GateState.CUT_KNOWN_WAITING_AUDIO)
    Log.i(
      TAG,
      "GC_P2_GATE cut_known pts_us=$cutPtsUs kf_wait_ms=${metrics.keyframeWaitMs} " +
        "— waiting for audio watermark",
    )

    val gen = ++rotationGeneration
    handler.postDelayed({
      if (gen != rotationGeneration) return@postDelayed
      if (rawState == GateState.CUT_KNOWN_WAITING_AUDIO) {
        fail(
          ErrorCode.ROTATION_AUDIO_WATERMARK_TIMEOUT,
          "audio never reached cutPtsUs=$cutPtsUs within ${Limits.AUDIO_WATERMARK_LIMIT_MS}ms",
        )
      }
    }, Limits.AUDIO_WATERMARK_LIMIT_MS)

    maybeCompleteRotation()
  }

  /**
   * The barrier. Because per-track PTS is monotonic, an audio sample with
   * `pts >= cutPtsUs` proves no earlier audio can still arrive. Only then is
   * the classification complete and segment 1 safe to close.
   */
  private fun maybeCompleteRotation() {
    if (rawState != GateState.CUT_KNOWN_WAITING_AUDIO) return
    val watermarkReached = retained.any { it.kind == TrackKind.AUDIO && it.ptsUs >= cutPtsUs }
    if (!watermarkReached) return

    rotationGeneration++ // invalidate the watermark deadline
    setState(GateState.ROTATING)
    metrics.audioWatermarkWaitMs = SystemClock.elapsedRealtime() - cutKnownAtMs

    val keyframe = cutKeyframe ?: run {
      fail(ErrorCode.INVALID_STATE, "cut keyframe missing"); return
    }

    val before = retained.filter { it.ptsUs < cutPtsUs }.sortedWith(orderWithin)
    val after = retained
      .filter { it.ptsUs >= cutPtsUs && it !== keyframe }
      .sortedWith(orderWithin)

    for (s in before) writeToMuxer(s)

    val aacFrameUs = 1024L * 1_000_000L / config.audioSampleRate
    val lastAacBefore = before.lastOrNull { it.kind == TrackKind.AUDIO }
    metrics.audioTailUs =
      if (lastAacBefore != null) maxOf(0L, lastAacBefore.ptsUs + aacFrameUs - cutPtsUs) else 0L

    // audioLead comes from the FIRST REAL AAC of segment 2, taken after the
    // barrier — not from whatever happened to be queued when the keyframe hit.
    val firstAacAfter = after.firstOrNull { it.kind == TrackKind.AUDIO }
    val pendingLead = firstAacAfter?.let { it.ptsUs - cutPtsUs } ?: -1L

    // Capture the closing segment's boundary numbers BEFORE the builder is
    // replaced. Logging them afterwards printed -1, because `metrics` already
    // pointed at the fresh builder for the next segment.
    val closingTailUs = metrics.audioTailUs
    val closingWatermarkMs = metrics.audioWatermarkWaitMs
    val closingKfWaitMs = metrics.keyframeWaitMs

    if (!closeCurrentSegment()) return

    segmentOriginUs = cutPtsUs
    metrics = BoundaryMetricsBuilder(segmentIndex)
    metrics.originUs = cutPtsUs
    metrics.cutPtsUs = cutPtsUs
    metrics.audioLeadUs = pendingLead

    if (!openSegment()) return

    writeToMuxer(keyframe)          // first video sample of segment 2 — G4
    for (s in after) writeToMuxer(s)

    retained.clear()
    retainedBytes = 0
    cutKeyframe = null
    setState(GateState.RECORDING)
    Log.i(
      TAG,
      "GC_P2_GATE rotation_complete cut_pts_us=$cutPtsUs " +
        "audio_tail_us=$closingTailUs audio_lead_us=$pendingLead " +
        "kf_wait_ms=$closingKfWaitMs watermark_wait_ms=$closingWatermarkMs " +
        "mono_ns=${SystemClock.elapsedRealtimeNanos()}",
    )
  }

  private val orderWithin =
    compareBy<QueuedSample> { it.ptsUs }.thenBy { it.kind.ordinal }.thenBy { it.deliverySeq }

  // =====================================================================
  // Muxer lifecycle
  // =====================================================================

  private fun openSegment(): Boolean {
    val vf = videoFormat ?: return failFalse(ErrorCode.INVALID_STATE, "no video format")
    val af = audioFormat ?: return failFalse(ErrorCode.INVALID_STATE, "no audio format")
    val file = File(outputDir, String.format("seg_%03d.mp4", segmentIndex))
    return try {
      val m = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      // Codec config travels through the FORMAT, never as a sample.
      muxerVideoTrack = m.addTrack(vf)
      muxerAudioTrack = m.addTrack(af)
      m.start()
      muxer = m
      muxerStarted = true
      currentFile = file
      Log.i(TAG, "GC_P2_GATE segment_open index=$segmentIndex path=${file.absolutePath}")
      true
    } catch (t: Throwable) {
      failFalse(ErrorCode.ENCODER_FAILED, "muxer open failed: ${t.message}")
    }
  }

  /**
   * Contract 4. `stop()` is synchronous with no cancellation in the public API,
   * so it is measured and reported honestly — never "interrupted".
   *
   * Stability verification does NOT run here: it is scheduled on the aux
   * thread so the coordinator returns immediately and the next segment opens
   * without a multi-second pause.
   */
  private fun closeCurrentSegment(): Boolean {
    val m = muxer ?: return failFalse(ErrorCode.INVALID_STATE, "no muxer to close")
    val file = currentFile ?: return failFalse(ErrorCode.INVALID_STATE, "no current file")

    val watchdog = Runnable {
      // Detection only: sets an atomic flag and reports. It does NOT write
      // rawState, does NOT call release(), does NOT retry stop().
      if (nativeStopStalled.compareAndSet(false, true)) {
        Log.e(TAG, "GC_P2_GATE ${ErrorCode.MUXER_STOP_NO_RETURN} segment=$segmentIndex")
        onFailure(
          ErrorCode.MUXER_STOP_NO_RETURN,
          "MediaMuxer.stop() has not returned after ${Limits.MUXER_STOP_WATCHDOG_MS}ms; " +
            "session lost, segment not emitted, capture blocked",
        )
      }
    }
    auxHandler.postDelayed(watchdog, Limits.MUXER_STOP_WATCHDOG_MS)

    val t0 = SystemClock.elapsedRealtime()
    try {
      m.stop()
    } catch (t: Throwable) {
      auxHandler.removeCallbacks(watchdog)
      safeRelease(m)
      muxer = null; muxerStarted = false
      return failFalse(ErrorCode.MUXER_STOP_THREW, "stop() threw: ${t.message}")
    }
    val dt = SystemClock.elapsedRealtime() - t0
    auxHandler.removeCallbacks(watchdog)
    metrics.muxerStopMs = dt

    safeRelease(m)
    muxer = null
    muxerStarted = false

    if (dt > Limits.MUXER_STOP_FAIL_MS) {
      return failFalse(ErrorCode.MUXER_STOP_TIMEOUT, "stop() returned late after ${dt}ms")
    }
    if (dt > Limits.MUXER_STOP_WARN_MS) {
      Log.w(TAG, "GC_P2_GATE muxer_stop_slow ms=$dt segment=$segmentIndex")
    }

    if (pendingStability >= Limits.STABILITY_MAX_PENDING) {
      return failFalse(
        ErrorCode.STABILITY_BACKLOG_OVERFLOW,
        "too many segments awaiting stability ($pendingStability)",
      )
    }
    pendingStability++
    scheduleStability(file, metrics.freeze())

    segmentIndex++
    return true
  }

  /**
   * Asynchronous stability verification: size and SHA-256 at close, +1s and
   * +5s. `onSegmentClosed` is emitted only when all three agree, so a segment
   * is never announced before it is provably final.
   */
  /**
   * The coordinator only REGISTERS the pending work and later receives the
   * result. Every `file.length()` and every SHA-256 — including the first —
   * runs on `gc-segrec-aux`. No full-file read ever executes on the thread
   * that owns the muxers.
   */
  private fun scheduleStability(file: File, snapshot: BoundaryMetrics) {
    auxHandler.post {
      val s0 = readStamp(file, 0, snapshot) ?: return@post
      auxHandler.postDelayed({
        val s1 = readStamp(file, 1, snapshot) ?: return@postDelayed
        auxHandler.postDelayed({
          val s2 = readStamp(file, 2, snapshot) ?: return@postDelayed
          val stable = s0 == s1 && s1 == s2
          handler.post {
            pendingStability--
            if (stable) {
              Log.i(
                TAG,
                // `coord_*_dropped` are samples the coordinator's state machine
                // REJECTED — they are not encoder drops and not muxer drops.
                // Duplication is deliberately absent: audioFramesDuplicated is
                // never incremented anywhere, so printing it would be a
                // structural zero, and there is no video equivalent.
                "GC_P2_GATE segment_stable index=${snapshot.segmentIndex} " +
                  "size=${s0.first} sha256=${s0.second} " +
                  "coord_audio_dropped=${snapshot.audioFramesDropped} " +
                  "coord_video_dropped=${snapshot.videoFramesDropped} " +
                  "pending_stability=$pendingStability " +
                  "queue_peak_entries=${snapshot.queuePeakEntries} " +
                  "queue_peak_bytes=${snapshot.queuePeakBytes} " +
                  "mono_ns=${SystemClock.elapsedRealtimeNanos()}",
              )
              onSegmentClosed(snapshot, file)
            } else {
              fail(
                ErrorCode.SEGMENT_UNSTABLE_AFTER_CLOSE,
                "segment ${snapshot.segmentIndex} changed after close: $s0 / $s1 / $s2",
              )
            }
            maybeFinishRelease()
          }
        }, Limits.STABILITY_CHECK_2_MS - Limits.STABILITY_CHECK_1_MS)
      }, Limits.STABILITY_CHECK_1_MS)
    }
  }

  /** Runs on aux. Any exception is a VISIBLE failure, never a swallowed check. */
  private fun readStamp(file: File, n: Int, snapshot: BoundaryMetrics): Pair<Long, String>? =
    try {
      file.length() to sha256(file)
    } catch (t: Throwable) {
      handler.post {
        pendingStability--
        fail(
          ErrorCode.STABILITY_CHECK_THREW,
          "stability read #$n on segment ${snapshot.segmentIndex} threw: ${t.message}",
        )
        maybeFinishRelease()
      }
      null
    }

  private fun safeRelease(m: MediaMuxer) = try { m.release() } catch (_: Throwable) { }

  private fun sha256(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { ins ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = ins.read(buf)
        if (n <= 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  // =====================================================================

  private fun writeToMuxer(sample: QueuedSample) {
    val m = muxer ?: return
    if (!muxerStarted) return

    // Codec-config buffers are NEVER media samples: the muxer already has csd
    // from addTrack(format). Writing them again yields files that look valid
    // and do not decode.
    if (sample.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) return

    val rebased = sample.ptsUs - segmentOriginUs
    if (rebased < 0) {
      metrics.rebaseNegativeCount++
      fail(
        ErrorCode.REBASE_NEGATIVE_PTS,
        "negative pts after rebase: ${sample.ptsUs} - $segmentOriginUs = $rebased",
      )
      return
    }

    val info = MediaCodec.BufferInfo().apply {
      offset = 0
      size = sample.data.size
      presentationTimeUs = rebased
      flags = sample.flags
    }
    val track = if (sample.kind == TrackKind.VIDEO) muxerVideoTrack else muxerAudioTrack
    try {
      m.writeSampleData(track, ByteBuffer.wrap(sample.data), info)
      if (sample.kind == TrackKind.VIDEO) {
        metrics.videoSamples++
        if (metrics.videoStartOffsetUs < 0) metrics.videoStartOffsetUs = rebased
      } else {
        metrics.audioSamples++
      }
    } catch (t: Throwable) {
      fail(ErrorCode.ENCODER_FAILED, "writeSampleData failed: ${t.message}")
    }
  }

  /**
   * Phase 1 of the close protocol: enter STOPPING. Samples keep flowing into
   * the open muxer while the encoders drain their EOS — nothing is cut off
   * here. The module signals [onEosComplete] when both have drained.
   */
  fun beginStopping() = handler.post {
    if (rawState == GateState.FAILED || nativeStopStalled.get()) return@post
    if (rawState == GateState.STOPPING || rawState == GateState.STOPPING_PENDING_BOUNDARY) return@post
    rotationGeneration++ // invalidate any armed deadline

    // A rotation in flight means `retained` holds samples older than anything
    // arriving now. Switching straight to STOPPING would write-through the new
    // ones ahead of the old ones and break per-track order.
    rawState = when (rawState) {
      GateState.KEYFRAME_REQUESTED,
      GateState.CUT_KNOWN_WAITING_AUDIO,
      GateState.ROTATING,
      -> GateState.STOPPING_PENDING_BOUNDARY

      // No muxer exists yet: formats and samples must keep accumulating in
      // `preroll`. Entering plain STOPPING here would send them to
      // `writeToMuxer()`, which returns early on a null muxer and would
      // discard them silently.
      GateState.STARTING, GateState.PREROLL -> GateState.STOPPING_PREROLL

      else -> GateState.STOPPING
    }
    Log.i(TAG, "GC_P2_GATE state=$rawState retained=${retained.size} preroll=${preroll.size}")
  }

  /**
   * Phase 2: both encoders reported END_OF_STREAM and every copied sample has
   * been consumed. Only now is the last muxer closed.
   */
  fun onEosComplete() = handler.post {
    if (rawState == GateState.FAILED || nativeStopStalled.get()) return@post
    if (eosComplete) return@post
    eosComplete = true

    // Final chance to open segment 0. Everything captured during the stop is
    // still in `preroll`, so a keyframe that arrived late still counts.
    if (rawState == GateState.STOPPING_PREROLL || muxer == null) {
      tryOpenFirstSegment()
      if (muxer == null) {
        fail(
          ErrorCode.PREROLL_KEYFRAME_TIMEOUT,
          "EOS with no segment open: video_format=${videoFormat != null} " +
            "audio_format=${audioFormat != null} preroll=${preroll.size} " +
            "keyframe=${preroll.any { it.kind == TrackKind.VIDEO && it.isKeyFrame }}",
        )
        maybeFinishRelease()
        return@post
      }
      Log.i(TAG, "GC_P2_GATE stop_preroll_recovered_segment0")
    }

    if (rawState == GateState.STOPPING_PENDING_BOUNDARY) {
      if (!resolvePendingBoundary()) { maybeFinishRelease(); return@post }
    }

    // Everything left goes out in chronological order within each track.
    for (s in (preroll + retained).sortedWith(orderWithin)) writeToMuxer(s)
    preroll.clear(); prerollBytes = 0
    retained.clear(); retainedBytes = 0

    Log.i(
      TAG,
      "GC_P2_GATE eos_complete intake_in_flight=${intakeEntries.get()} " +
        "video_samples=${metrics.videoSamples} audio_samples=${metrics.audioSamples}",
    )
    if (closeCurrentSegment()) setState(GateState.COMPLETED)
    maybeFinishRelease()
  }

  /**
   * Explicit policy for a rotation interrupted by stop.
   *
   * Route A — the cut is known AND audio crossed it: the boundary is valid, so
   *           complete the rotation normally. Two segments result.
   * Route B — the cut is known but audio never crossed it, or no keyframe ever
   *           arrived: NO valid boundary exists. Everything is merged, in
   *           order, into the CURRENT muxer. One segment results.
   *
   * Route B is a declared outcome, not a silent fallback: it is logged, and the
   * gate reports a single segment so the operator sees the rotation did not
   * complete. Writing samples out of order is never an option.
   */
  private fun resolvePendingBoundary(): Boolean {
    val keyframe = cutKeyframe
    val watermarkReached =
      keyframe != null && retained.any { it.kind == TrackKind.AUDIO && it.ptsUs >= cutPtsUs }

    if (keyframe != null && watermarkReached) {
      Log.i(TAG, "GC_P2_GATE stop_boundary=ROUTE_A completing rotation at cut_pts_us=$cutPtsUs")
      setState(GateState.CUT_KNOWN_WAITING_AUDIO)
      maybeCompleteRotation()
      if (rawState == GateState.FAILED) return false
      setState(GateState.STOPPING)
      return true
    }

    Log.w(
      TAG,
      "GC_P2_GATE stop_boundary=ROUTE_B no valid boundary " +
        "(keyframe=${keyframe != null} watermark=$watermarkReached); " +
        "merging ${retained.size} retained samples into the current segment in order",
    )
    cutKeyframe = null
    cutPtsUs = -1
    setState(GateState.STOPPING)
    return true
  }

  /** True once no sample is in flight anywhere between encoders and muxer. */
  fun intakeDrained(): Boolean = intakeEntries.get() == 0

  private fun fail(code: String, message: String) {
    if (rawState == GateState.FAILED || nativeStopStalled.get()) return
    setState(GateState.FAILED)
    Log.e(TAG, "GC_P2_GATE FAILED code=$code message=$message")
    onFailure(code, message)
  }

  private fun failFalse(code: String, message: String): Boolean {
    fail(code, message)
    return false
  }

  /**
   * Requests teardown. The threads are NOT killed on a fixed delay: they stay
   * alive until `pendingStability == 0`, so every `onSegmentClosed` — or a
   * terminal failure — is emitted before [onFullyReleased] fires. The module
   * only reports `onCaptureReleased` from that callback.
   */
  fun release(onReleased: () -> Unit) = handler.post {
    onFullyReleased = onReleased
    releaseRequested = true
    maybeFinishRelease()
  }

  private fun maybeFinishRelease() {
    if (!releaseRequested) return
    if (pendingStability > 0) {
      Log.i(TAG, "GC_P2_GATE release_waiting pending_stability=$pendingStability")
      return
    }
    muxer?.let { safeRelease(it) }
    muxer = null
    val cb = onFullyReleased
    onFullyReleased = null
    releaseRequested = false
    // pendingStability is printed here too so P5 is checkable at the close: it
    // must be 0 at this point, and until now that could only be inferred from
    // the fact that maybeFinishRelease() reached this line at all.
    Log.i(
      TAG,
      "GC_P2_GATE release_complete segments=$segmentIndex state=$rawState " +
        "pending_stability=$pendingStability",
    )
    cb?.invoke()
    handler.post { thread.quitSafely() }
    auxHandler.post { auxThread.quitSafely() }
  }

  companion object {
    private const val TAG = "GCSegRec"
  }
}
