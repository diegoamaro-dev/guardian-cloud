package com.guardiancloud.segrec

import android.hardware.camera2.CameraCharacteristics
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.os.SystemClock
import android.util.Log

/**
 * SPIKE — P2 early gate. Contract 1: the common session clock.
 *
 * Audio and video PTS must already live on the SAME clock before any rebase.
 * Subtracting `cutPtsUs` from two tracks whose timestamps came from different
 * bases does not align them — it moves both by the same amount and preserves
 * the original offset.
 */
class SessionClock(timestampSource: Int) {

  enum class AlignmentQuality {
    /**
     * `SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME` — camera timestamps share the
     * base of `SystemClock.elapsedRealtimeNanos()`, so audio anchored on
     * `TIMEBASE_BOOTTIME` aligns directly.
     */
    DIRECT,

    /**
     * `UNKNOWN` — monotonic but not documented against any system clock, so
     * the relationship is characterised rather than contracted.
     *
     * NOT a claim that A/V sync is unachievable: Android treats this base as
     * precise enough for recording sync, and `MediaRecorder` relies on it.
     */
    ESTIMATED,
  }

  val alignmentQuality: AlignmentQuality =
    if (timestampSource == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME) {
      AlignmentQuality.DIRECT
    } else {
      AlignmentQuality.ESTIMATED
    }

  /**
   * `TIMEBASE_BOOTTIME` shares its base with `SystemClock.elapsedRealtimeNanos()`,
   * which is what a REALTIME camera stamps buffers with. `TIMEBASE_MONOTONIC`
   * maps to `System.nanoTime()` and would NOT justify claiming direct
   * alignment — using it here would be a silent clock mismatch.
   */
  val audioTimebase: Int = AudioTimestamp.TIMEBASE_BOOTTIME

  // ---- audio anchor ---------------------------------------------------

  private data class Anchor(val framePosition: Long, val nanoTime: Long)

  private val anchors = ArrayList<Anchor>()
  private var firstAnchor: Anchor? = null

  private var modelA: Double = 0.0
  private var modelB: Double = 0.0
  private var modelReady = false

  private val firstVideoNs = java.util.concurrent.atomic.AtomicLong(UNSET)
  private val firstAudioNs = java.util.concurrent.atomic.AtomicLong(UNSET)
  private val t0 = java.util.concurrent.atomic.AtomicLong(UNSET)

  /**
   * Contract 1: no valid anchor within the bounded warm-up is a visible
   * failure. We never fall back to counting frames from zero — that produces a
   * media clock that drifts against the camera while APPEARING synchronised.
   */
  fun tryAnchor(recorder: AudioRecord, sampleRate: Int): Boolean {
    val ts = AudioTimestamp()
    if (recorder.getTimestamp(ts, audioTimebase) != AudioRecord.SUCCESS) return false

    val a = Anchor(ts.framePosition, ts.nanoTime)
    anchors.add(a)
    if (firstAnchor == null) {
      firstAnchor = a
      Log.i(TAG, "GC_P2_GATE audio_anchor_first frame=${a.framePosition} nano=${a.nanoTime}")
    }
    if (!modelReady && anchors.size >= MODEL_ANCHORS) fitModel(sampleRate)
    return true
  }

  fun hasAnchor(): Boolean = firstAnchor != null

  /**
   * Contract 1, literal formula.
   *
   * `pcmStartFramePosition` is the position of the FIRST PCM frame of the
   * buffer handed to the encoder — not the counter after the read completes.
   * The post-read position would shift every buffer by its own duration.
   */
  fun audioPtsNs(pcmStartFramePosition: Long, sampleRate: Int): Long {
    val anchor = firstAnchor ?: error("audioPtsNs before anchor — guarded by caller")
    return anchor.nanoTime +
      (pcmStartFramePosition - anchor.framePosition) * 1_000_000_000L / sampleRate
  }

  // ---- drift ----------------------------------------------------------

  /**
   * Fit ns = a + b · framePosition over the first anchors. The measured `b`
   * versus nominal `1e9 / sampleRate` IS the audio clock error.
   */
  private fun fitModel(sampleRate: Int) {
    val n = anchors.size
    val meanF = anchors.sumOf { it.framePosition.toDouble() } / n
    val meanT = anchors.sumOf { it.nanoTime.toDouble() } / n
    var num = 0.0
    var den = 0.0
    for (a in anchors) {
      val df = a.framePosition - meanF
      num += df * (a.nanoTime - meanT)
      den += df * df
    }
    if (den == 0.0) return
    modelB = num / den
    modelA = meanT - modelB * meanF
    modelReady = true
    val nominalB = 1_000_000_000.0 / sampleRate
    val ppm = (modelB - nominalB) / nominalB * 1_000_000.0
    Log.i(TAG, "GC_P2_GATE audio_clock_model b=$modelB nominal=$nominalB error_ppm=$ppm")
  }

  /**
   * Residual of the LATEST anchor against the INITIAL model.
   *
   * Comparing an anchor with itself always yields zero — that was the flaw in
   * the first design. Drift only appears as a residual against a model fitted
   * earlier, or as the slope of those residuals over time.
   */
  fun driftResidualNs(): Long? {
    if (!modelReady) return null
    val last = anchors.lastOrNull() ?: return null
    return (last.nanoTime - (modelA + modelB * last.framePosition)).toLong()
  }

  // ---- session origin -------------------------------------------------

  fun referenceNowNs(): Long = SystemClock.elapsedRealtimeNanos()

  /**
   * Session t0 = the EARLIER of the two first timestamps.
   *
   * `maxOf` was wrong: it would place t0 after the earlier track's first
   * sample, making that sample's session PTS negative and forcing a silent
   * discard to hide it. `minOf` keeps BOTH tracks, with every session PTS
   * non-negative and nothing excluded to make the tracks start together.
   *
   * Trimming a leading header is not required here: the segment itself decides
   * its own origin, and G4 only asks that the first VIDEO sample be a keyframe
   * — not that it sit at PTS 0.
   */
  /**
   * Establishes `t0` exactly once, from both first timestamps.
   *
   * Concurrency: the two `first*` values are published through atomics and the
   * origin is installed with a single CAS, so no thread can observe a `t0`
   * derived from only one track, and two racing callers cannot install
   * different origins.
   *
   * Both inputs must already be on the SAME base — video PTS has the resolved
   * encoder→BOOTTIME offset applied before it gets here.
   */
  fun offerFirstVideoNs(ns: Long) {
    firstVideoNs.compareAndSet(UNSET, ns)
    tryInstallT0()
  }

  fun offerFirstAudioNs(ns: Long) {
    firstAudioNs.compareAndSet(UNSET, ns)
    tryInstallT0()
  }

  private fun tryInstallT0() {
    val v = firstVideoNs.get()
    val a = firstAudioNs.get()
    if (v == UNSET || a == UNSET) return
    val origin = minOf(v, a)
    if (t0.compareAndSet(UNSET, origin)) {
      Log.i(
        TAG,
        "GC_P2_GATE session_t0_ns=$origin quality=$alignmentQuality " +
          "first_video_ns=$v first_audio_ns=$a",
      )
    }
  }

  fun t0Established(): Boolean = t0.get() != UNSET

  fun toSessionPtsUs(clockNs: Long): Long = (clockNs - t0.get()) / 1000L

  companion object {
    private const val TAG = "GCSegRec"
    private const val MODEL_ANCHORS = 5
    private const val UNSET = Long.MIN_VALUE
  }
}
