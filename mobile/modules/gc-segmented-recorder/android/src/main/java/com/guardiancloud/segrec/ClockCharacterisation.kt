package com.guardiancloud.segrec

import android.hardware.camera2.CameraCharacteristics
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * SPIKE — P2 early gate. Contract 2, second correction.
 *
 * What we must NOT assume:
 *
 *   - that `BufferInfo.presentationTimeUs` is expressed in BOOTTIME;
 *   - that it equals `CaptureResult.SENSOR_TIMESTAMP`. Android may compensate
 *     automatically when camera buffers reach the encoder through a Surface,
 *     so identity is a hypothesis, not a contract.
 *
 * So this class RESOLVES the relation empirically and the resolved offset is
 * APPLIED to every video PTS before `t0` is established. It is no longer a
 * report printed at the end.
 *
 * Resolution produces one of:
 *   DIRECT     — encoder PTS matches sensor timestamps by value and the sensor
 *                source is REALTIME, so the base is BOOTTIME and offset = 0.
 *   ESTIMATED  — the difference (observedBoottime − encoderPts) is stable, so
 *                the bases differ by a constant; that constant is adopted.
 *   UNRESOLVED — the difference is not stable. Terminal failure with
 *                [ErrorCode.CLOCK_ALIGNMENT_UNRESOLVED]; we do not guess.
 */
class ClockCharacterisation(private val timestampSource: Int) {

  enum class Resolution { PENDING, DIRECT, ESTIMATED, UNRESOLVED }

  private class Obs(val valueNs: Long, val observedBoottimeNs: Long)

  private val sensorSeries = ConcurrentLinkedQueue<Long>()
  private val encoderSeries = ConcurrentLinkedQueue<Obs>()
  private val resolving = AtomicBoolean(false)

  @Volatile private var startedAtMs: Long = 0
  @Volatile var resolution: Resolution = Resolution.PENDING
    private set

  /**
   * Nanoseconds to ADD to an encoder PTS to express it on the audio timebase
   * (BOOTTIME). Valid only once [resolution] is DIRECT or ESTIMATED.
   */
  @Volatile var encoderToBoottimeOffsetNs: Long = 0
    private set

  @Volatile private var matchRate: Double = -1.0
  @Volatile private var spreadNs: Long = -1

  fun begin() {
    startedAtMs = SystemClock.elapsedRealtime()
  }

  /** Its own series. Never paired with an encoder buffer by arrival instant. */
  fun onSensorTimestamp(sensorNs: Long) {
    if (sensorSeries.size < MAX_SERIES) sensorSeries.add(sensorNs)
  }

  /** Its own series, each entry stamped with the BOOTTIME of observation. */
  fun onEncoderSample(encoderPtsUs: Long) {
    if (encoderSeries.size < MAX_SERIES) {
      encoderSeries.add(Obs(encoderPtsUs * 1000L, SystemClock.elapsedRealtimeNanos()))
    }
  }

  fun ready(): Boolean =
    resolution == Resolution.DIRECT || resolution == Resolution.ESTIMATED

  /**
   * Attempt resolution. Returns true when a usable relation exists.
   *
   * Called repeatedly by the video encoder until it succeeds or the deadline
   * expires; `onUnresolved` fires exactly once.
   */
  fun tryResolve(onUnresolved: (String) -> Unit): Boolean {
    if (ready()) return true
    if (resolution == Resolution.UNRESOLVED) return false

    val enc = encoderSeries.toList()
    if (enc.size < Limits.CLOCK_RESOLVE_MIN_SAMPLES) {
      if (SystemClock.elapsedRealtime() - startedAtMs > Limits.CLOCK_RESOLVE_LIMIT_MS &&
        resolving.compareAndSet(false, true)
      ) {
        resolution = Resolution.UNRESOLVED
        onUnresolved(
          "only ${enc.size} encoder samples in ${Limits.CLOCK_RESOLVE_LIMIT_MS}ms; " +
            "cannot resolve encoder↔audio clock relation",
        )
      }
      return false
    }

    // Path A — value match against sensor timestamps on a REALTIME sensor.
    // If the encoder echoes camera timestamps unchanged, its base IS BOOTTIME.
    val sensors = sensorSeries.toList()
    if (sensors.isNotEmpty()) {
      var matched = 0
      for (e in enc) {
        if (sensors.any { kotlin.math.abs(e.valueNs - it) <= MATCH_TOLERANCE_NS }) matched++
      }
      matchRate = matched.toDouble() / enc.size
      if (matchRate >= MATCH_RATE_THRESHOLD &&
        timestampSource == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
      ) {
        encoderToBoottimeOffsetNs = 0
        resolution = Resolution.DIRECT
        Log.i(TAG, "GC_P2_GATE clock_resolved=DIRECT match_rate=$matchRate offset_ns=0")
        return true
      }
    }

    // Path B — is (observedBoottime − encoderPts) stable? A stable difference
    // means the two bases differ by a constant, which we can adopt. The low
    // percentile is the tightest estimate of that constant: larger values are
    // pipeline latency, which only adds.
    val diffs = enc.map { it.observedBoottimeNs - it.valueNs }.sorted()
    spreadNs = diffs.last() - diffs.first()
    if (spreadNs <= Limits.CLOCK_RESOLVE_MAX_SPREAD_NS) {
      encoderToBoottimeOffsetNs = diffs[(diffs.size * 5) / 100]
      resolution = Resolution.ESTIMATED
      Log.i(
        TAG,
        "GC_P2_GATE clock_resolved=ESTIMATED offset_ns=$encoderToBoottimeOffsetNs " +
          "spread_ns=$spreadNs match_rate=$matchRate",
      )
      return true
    }

    if (SystemClock.elapsedRealtime() - startedAtMs > Limits.CLOCK_RESOLVE_LIMIT_MS &&
      resolving.compareAndSet(false, true)
    ) {
      resolution = Resolution.UNRESOLVED
      onUnresolved(
        "encoder↔boottime difference not stable: spread_ns=$spreadNs " +
          "(limit ${Limits.CLOCK_RESOLVE_MAX_SPREAD_NS}) match_rate=$matchRate",
      )
    }
    return false
  }

  /**
   * Diagnostic only. The spread of (observedBoottime − encoderPts) is what the
   * resolution is BASED on, so it is not an independent validity measure — it
   * is reported as the evidence behind [resolution], nothing more.
   */
  fun report(): String =
    "resolution=$resolution offset_ns=$encoderToBoottimeOffsetNs " +
      "match_rate=%.3f spread_ns=%d encoder_n=%d sensor_n=%d source=%d".format(
        matchRate, spreadNs, encoderSeries.size, sensorSeries.size, timestampSource,
      )

  fun logSeriesHead() {
    sensorSeries.take(SERIES_LOG).forEachIndexed { i, v ->
      Log.i(TAG, "GC_P2_GATE series_sensor idx=$i value_ns=$v")
    }
    encoderSeries.take(SERIES_LOG).forEachIndexed { i, o ->
      Log.i(TAG, "GC_P2_GATE series_encoder idx=$i pts_ns=${o.valueNs} obs_boottime_ns=${o.observedBoottimeNs}")
    }
  }

  companion object {
    private const val TAG = "GCSegRec"
    private const val MAX_SERIES = 600
    private const val SERIES_LOG = 30
    private const val MATCH_TOLERANCE_NS = 2_000_000L
    private const val MATCH_RATE_THRESHOLD = 0.8
  }
}
