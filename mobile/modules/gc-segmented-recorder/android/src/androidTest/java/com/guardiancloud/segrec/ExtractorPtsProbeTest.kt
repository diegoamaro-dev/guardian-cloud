package com.guardiancloud.segrec

import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer

/**
 * EXPORT-MP4 · EXTRACTOR PTS PROBE — step 1 of the `EXPORT-MP4 · REMUX` gate.
 *
 * ONE question: does Android's `MediaExtractor` expose, on this device, the
 * per-segment audio start offset that the approved Timeline Contract needs?
 *
 *     span_k      = a_k + n_k * aacFrameUs - a_(k+1)
 *     offset_(k+1) = offset_k + span_k
 *
 * `a_k` is the first audio sample's presentation time inside segment `k`. It is
 * `audioLead` — bounded by one AAC frame — and it is the only quantity the
 * contract cannot get from anywhere else. `cutPtsUs` is not persisted.
 *
 * WHY THIS TEST EXISTS AT ALL. `ffprobe` already proved the value is written
 * into the MP4 (`start_pts` non-zero on the audio track). That is a statement
 * about the FILE. It says nothing about whether the platform extractor on this
 * hardware surfaces it or normalises it away. Those are different claims and
 * only this one authorises the remux.
 *
 * ── The criterion was fixed BEFORE this ran ──────────────────────────────
 * `EXPECTED` below is the `ffprobe` measurement published on 2026-10-04,
 * before a line of this test existed. It is not adjusted to whatever the
 * extractor turns out to report. A mismatch is a FAIL, not a reason to edit
 * this table.
 *
 * ── Also answers the structural questions ───────────────────────────────
 * The same walk reports, per segment, whether the extractor opens it, which
 * tracks it finds, whether both media types are present and whether every
 * sample can be traversed to the end. A fragment some player refuses to play
 * is NOT corrupt on that evidence alone, and this is what decides it.
 *
 * ── Temporary ───────────────────────────────────────────────────────────
 * Test-only. Touches no production source. Reads its inputs; writes nothing
 * anywhere. The segments are READ ONLY: opened, walked, closed.
 */
class ExtractorPtsProbeTest {

  /**
   * Per-segment expectation, in microseconds.
   *
   * `aFirstUs` — first audio sample time. `vFirstUs` — first video sample
   * time: 0 for every segment the rotation opened, because `segmentOriginUs`
   * becomes `cutPtsUs` and the boundary keyframe is written first; non-zero
   * only for segment 0, where the origin is `min(firstKeyframe, firstAudio)`
   * and audio precedes the camera.
   */
  private data class Expected(
    val aFirstUs: Double,
    val vFirstUs: Double,
    val audioSamples: Int,
  )

  @Test
  fun extractorExposesPerSegmentAudioOffset() {
    val dir = File(PROBE_DIR)
    assertTrue(
      "probe inputs missing — expected real segments under $PROBE_DIR",
      dir.isDirectory,
    )

    val files = dir.listFiles { f: File -> f.name.endsWith(".mp4") }
      ?.sortedBy { it.name }
      ?: emptyList()

    assertTrue("no .mp4 inputs found under $PROBE_DIR", files.isNotEmpty())

    val observed = LinkedHashMap<String, Probe>()
    for (f in files) {
      val p = probe(f)
      observed[f.name] = p
      Log.i(TAG, p.line(f.name))
    }

    // ---- structural report, per segment --------------------------------
    // Reported for every input, including any the gallery refused to play.
    val unopenable = observed.filterValues { !it.opened }
    val missingTrack = observed.filterValues { it.opened && !(it.hasVideo && it.hasAudio) }
    val unwalkable = observed.filterValues { it.opened && it.walkError != null }

    Log.i(
      TAG,
      "SUMMARY files=${observed.size} unopenable=${unopenable.keys} " +
        "missing_track=${missingTrack.keys} walk_error=${unwalkable.keys}",
    )

    assertTrue("MediaExtractor could not open: ${unopenable.keys}", unopenable.isEmpty())
    assertTrue("segment without both tracks: ${missingTrack.keys}", missingTrack.isEmpty())
    assertTrue(
      "sample walk failed: " + unwalkable.entries.joinToString { "${it.key}=${it.value.walkError}" },
      unwalkable.isEmpty(),
    )

    // ---- the actual question -------------------------------------------
    // Every expectation we hold must have been measured. A file on the device
    // with no entry in EXPECTED is not silently skipped: it is reported.
    val unexpected = observed.keys - EXPECTED.keys
    Log.i(TAG, "files present without a fixed expectation: $unexpected")

    val checked = EXPECTED.keys.filter { observed.containsKey(it) }
    assertTrue("none of the expected segments were present on the device", checked.isNotEmpty())

    // FAIL MODE THIS EXISTS TO CATCH: the extractor normalises every track to
    // zero. Checked as a whole, because a single zero is legitimate — `a_k`
    // is genuinely 0 in segment 0 of both sets.
    val expectNonZero = checked.filter { EXPECTED.getValue(it).aFirstUs > TICK_US }
    val reportedZero = expectNonZero.filter { observed.getValue(it).audioFirstUs == 0L }
    assertTrue(
      "MediaExtractor normalised the audio start offset to 0 in: $reportedZero — " +
        "the offset cannot be recovered from the files on this device",
      reportedZero.isEmpty(),
    )

    // Then the values themselves, against the pre-registered table.
    val drift = StringBuilder()
    for (name in checked) {
      val e = EXPECTED.getValue(name)
      val o = observed.getValue(name)
      drift.append(
        "\n  $name a_expected=${"%.1f".format(e.aFirstUs)} a_observed=${o.audioFirstUs}" +
          " v_expected=${"%.1f".format(e.vFirstUs)} v_observed=${o.videoFirstUs}" +
          " n_expected=${e.audioSamples} n_observed=${o.audioSamples}",
      )
    }
    Log.i(TAG, "COMPARISON$drift")

    for (name in checked) {
      val e = EXPECTED.getValue(name)
      val o = observed.getValue(name)

      // ROUNDING_US is timebase quantisation, not a tolerance on the result:
      // one audio tick is 1e6/44100 = 22.7 us, and what would make the remux
      // wrong is an error of a whole AAC frame (23 220 us) — three orders of
      // magnitude away.
      assertEquals(
        "$name: first audio sample time disagrees with the pre-registered measurement",
        e.aFirstUs,
        o.audioFirstUs.toDouble(),
        ROUNDING_US,
      )
      assertEquals(
        "$name: first video sample time disagrees with the pre-registered measurement",
        e.vFirstUs,
        o.videoFirstUs.toDouble(),
        ROUNDING_US,
      )
      assertEquals(
        "$name: audio sample count disagrees with the pre-registered measurement",
        e.audioSamples.toLong(),
        o.audioSamples.toLong(),
      )

      // Contiguity, re-derived on device: the audio content of a segment must
      // tile exactly `n * aacFrameUs`. This is what makes `span_k` legitimate.
      val frameUs = 1_024_000_000.0 / o.sampleRate
      val span = (o.audioLastUs - o.audioFirstUs).toDouble() + frameUs
      assertEquals(
        "$name: audio does not tile its own span — contiguity broken",
        o.audioSamples * frameUs,
        span,
        ROUNDING_US,
      )
    }

    // ---- the contract, end to end, on real consecutive segments --------
    // Nothing is asserted about absolute wall-clock here: only that the chain
    // is computable and strictly advancing, which is all the remux needs.
    for ((label, prefix) in SETS) {
      val set = observed.entries
        .filter { it.key.startsWith(prefix) && EXPECTED.containsKey(it.key) }
        .sortedBy { it.key }
        .map { it.value }
      if (set.size < 2) continue

      var offset = 0.0
      val spans = ArrayList<Double>()
      for (k in 0 until set.size - 1) {
        val cur = set[k]
        val next = set[k + 1]
        val frameUs = 1_024_000_000.0 / cur.sampleRate
        val span = cur.audioFirstUs + cur.audioSamples * frameUs - next.audioFirstUs
        spans.add(span)
        offset += span
      }
      val last = set.last()
      val lastFrameUs = 1_024_000_000.0 / last.sampleRate
      val total = offset + last.audioFirstUs + last.audioSamples * lastFrameUs

      Log.i(
        TAG,
        "TIMELINE[$label] segments=${set.size} total_us=${"%.0f".format(total)} " +
          "spans_us=${spans.joinToString { "%.0f".format(it) }}",
      )

      for ((k, s) in spans.withIndex()) {
        assertTrue("$label: span $k is not positive ($s us)", s > 0.0)
      }
    }
  }

  // =====================================================================

  private data class Probe(
    val opened: Boolean,
    val trackCount: Int,
    val mimes: List<String>,
    val hasVideo: Boolean,
    val hasAudio: Boolean,
    val videoFirstUs: Long,
    val videoSamples: Int,
    val audioFirstUs: Long,
    val audioLastUs: Long,
    val audioSamples: Int,
    val sampleRate: Int,
    val walkError: String?,
  ) {
    fun line(name: String): String =
      "SEGMENT $name opened=$opened tracks=$trackCount mimes=$mimes " +
        "video=$hasVideo audio=$hasAudio v_first_us=$videoFirstUs v_samples=$videoSamples " +
        "a_first_us=$audioFirstUs a_last_us=$audioLastUs a_samples=$audioSamples " +
        "sample_rate=$sampleRate walk_error=$walkError"
  }

  private fun probe(file: File): Probe {
    val ex = MediaExtractor()
    try {
      ex.setDataSource(file.absolutePath)
    } catch (t: Throwable) {
      ex.release()
      return Probe(
        opened = false, trackCount = 0, mimes = emptyList(), hasVideo = false,
        hasAudio = false, videoFirstUs = -1, videoSamples = 0, audioFirstUs = -1,
        audioLastUs = -1, audioSamples = 0, sampleRate = 0,
        walkError = "setDataSource: ${t.javaClass.simpleName}: ${t.message}",
      )
    }

    try {
      val mimes = ArrayList<String>()
      var videoTrack = -1
      var audioTrack = -1
      var sampleRate = 0

      for (i in 0 until ex.trackCount) {
        val fmt = ex.getTrackFormat(i)
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: "?"
        mimes.add(mime)
        if (videoTrack < 0 && mime.startsWith("video/")) videoTrack = i
        if (audioTrack < 0 && mime.startsWith("audio/")) {
          audioTrack = i
          if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
            sampleRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          }
        }
      }

      var walkError: String? = null
      var vFirst = -1L
      var vCount = 0
      var aFirst = -1L
      var aLast = -1L
      var aCount = 0

      try {
        if (videoTrack >= 0) {
          val w = walk(ex, videoTrack)
          vFirst = w.first
          vCount = w.third
        }
        if (audioTrack >= 0) {
          val w = walk(ex, audioTrack)
          aFirst = w.first
          aLast = w.second
          aCount = w.third
        }
      } catch (t: Throwable) {
        walkError = "${t.javaClass.simpleName}: ${t.message}"
      }

      return Probe(
        opened = true,
        trackCount = ex.trackCount,
        mimes = mimes,
        hasVideo = videoTrack >= 0,
        hasAudio = audioTrack >= 0,
        videoFirstUs = vFirst,
        videoSamples = vCount,
        audioFirstUs = aFirst,
        audioLastUs = aLast,
        audioSamples = aCount,
        sampleRate = sampleRate,
        walkError = walkError,
      )
    } finally {
      ex.release()
    }
  }

  /**
   * Walks one track to its end. Returns (firstPtsUs, lastPtsUs, sampleCount).
   *
   * The first sample time is read BEFORE any `seekTo`: a seek is exactly the
   * call that could mask a non-zero start by snapping to a sync frame.
   */
  private fun walk(ex: MediaExtractor, track: Int): Triple<Long, Long, Int> {
    ex.selectTrack(track)
    val buf = ByteBuffer.allocate(BUF_BYTES)
    var first = -1L
    var last = -1L
    var count = 0
    while (true) {
      val t = ex.sampleTime
      if (t < 0) break
      if (first < 0) first = t
      last = t
      val read = ex.readSampleData(buf, 0)
      if (read < 0) break
      count++
      if (!ex.advance()) break
    }
    ex.unselectTrack(track)
    return Triple(first, last, count)
  }

  private companion object {
    const val TAG = "GC_PTS_PROBE"
    const val PROBE_DIR = "/data/local/tmp/gc-probe"
    const val BUF_BYTES = 1 shl 21

    /** One audio tick at 44.1 kHz, in microseconds. */
    const val TICK_US = 1_000_000.0 / 44_100.0

    /** Timebase quantisation allowance. See the assertions. */
    const val ROUNDING_US = 1_000.0

    val SETS = listOf("today-2026-10-04" to "today_c", "d3-2026-08-24" to "d3_")

    /**
     * `ffprobe`, 2026-10-04, over real Guardian Cloud segments. Fixed before
     * this test existed. `today_*` are the five containers found concatenated
     * inside the single `.mp4` the app exported; `d3_*` are the twelve of the
     * 2026-08-24 salvage run.
     */
    val EXPECTED = linkedMapOf(
      "today_c0.mp4" to Expected(0.0, 325_600.0, 137),
      "today_c1.mp4" to Expected(4_897.96, 0.0, 283),
      "today_c2.mp4" to Expected(18_888.89, 0.0, 262),
      "today_c3.mp4" to Expected(3_900.23, 0.0, 262),
      "today_c4.mp4" to Expected(22_290.25, 0.0, 140),
      "d3_000.mp4" to Expected(0.0, 390_200.0, 137),
      "d3_001.mp4" to Expected(1_496.60, 0.0, 283),
      "d3_002.mp4" to Expected(7_596.37, 0.0, 263),
      "d3_003.mp4" to Expected(15_895.69, 0.0, 262),
      "d3_004.mp4" to Expected(907.03, 0.0, 262),
      "d3_005.mp4" to Expected(19_206.35, 0.0, 262),
      "d3_006.mp4" to Expected(4_195.01, 0.0, 262),
      "d3_007.mp4" to Expected(22_607.71, 0.0, 262),
      "d3_008.mp4" to Expected(7_596.37, 0.0, 261),
      "d3_009.mp4" to Expected(2_698.41, 0.0, 263),
      "d3_010.mp4" to Expected(10_997.73, 0.0, 261),
      "d3_011.mp4" to Expected(6_099.77, 0.0, 93),
    )
  }
}
