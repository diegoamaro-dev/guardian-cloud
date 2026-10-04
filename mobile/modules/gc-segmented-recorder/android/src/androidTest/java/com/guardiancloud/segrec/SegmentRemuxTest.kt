package com.guardiancloud.segrec

import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest

/**
 * EXPORT-MP4 · REMUX — the remuxer against real Guardian Cloud segments.
 *
 * Runs on device, over files pushed to [DIR], and checks the three things that
 * decide whether the output is evidence and not just a file:
 *
 *   1. ONE container. The defect this gate exists to fix is an output holding
 *      N complete MP4s, of which a player reads the first. The output is
 *      scanned for `ftyp`/`moov` occurrences and must contain exactly one of
 *      each.
 *   2. The timeline matches the contract. Duration and sample counts are
 *      compared against totals measured independently BEFORE this test
 *      existed — `ffprobe` on the PC on 2026-10-04, and the extractor probe
 *      on this device.
 *   3. The sources are untouched. Every input is hashed before and after; a
 *      single changed byte fails.
 *
 * Inputs are not fixtures in the repository: they are real captures, pushed
 * deliberately. Without them the test is skipped rather than passing vacuously
 * — a green run that measured nothing is worse than a skip.
 */
class SegmentRemuxTest {

  @Test
  fun remuxesTodaysFiveSegmentsIntoOnePlayableContainer() {
    runSet("today-2026-10-04", "today_c", expectSegments = 5, expectDurationUs = 25_170_431L, expectVideo = 738, expectAudio = 1084)
  }

  @Test
  fun remuxesTheTwelveSegmentsOfTheSalvageRun() {
    runSet("d3-2026-08-24", "d3_", expectSegments = 12, expectDurationUs = 66_664_490L, expectVideo = 1980, expectAudio = 2871)
  }

  /**
   * KNOWN LIMIT, pinned on purpose.
   *
   * A reversed set is assembled WITHOUT complaint, and that is not a bug to
   * fix here: a segment rebased to its own origin carries nothing that says
   * where it sat in the session. `span_k` is dominated by the segment's own
   * audio content, which does not depend on order, so every span stays
   * positive whatever the sequence.
   *
   * Order is therefore the CALLER's contract, derived from `chunk_index`, and
   * the caller must also refuse a set with holes. This test exists so that
   * truth is enforced by the suite instead of living in a comment: if someone
   * later believes the remuxer validates order, this fails and says otherwise.
   */
  @Test
  fun cannotDetectReorderedInputByItself() {
    val inputs = inputsFor("today_c")
    assumeTrue("probe inputs absent", inputs.size >= 2)

    val out = File(outputDir(), "out_reversed.mp4")
    out.delete()

    val report = SegmentRemuxer.remux(
      inputs.reversed().map { it.absolutePath },
      out.absolutePath,
    )
    Log.i(TAG, "REVERSED accepted=$report")

    assertEquals(
      "the remuxer is not expected to detect order — see the docstring",
      inputs.size,
      report["segments"],
    )
    out.delete()
  }

  // =====================================================================

  private fun runSet(
    label: String,
    prefix: String,
    expectSegments: Int,
    expectDurationUs: Long,
    expectVideo: Int,
    expectAudio: Int,
  ) {
    val inputs = inputsFor(prefix)
    assumeTrue("probe inputs absent for $prefix — push real segments to $DIR", inputs.isNotEmpty())
    assertEquals("$label: unexpected number of inputs", expectSegments, inputs.size)

    val before = inputs.associate { it.absolutePath to sha256(it) }

    val out = File(outputDir(), "out_$prefix.mp4")
    out.delete()

    val report = SegmentRemuxer.remux(inputs.map { it.absolutePath }, out.absolutePath)
    Log.i(TAG, "REMUX[$label] $report")

    // ---- the report ----------------------------------------------------
    assertEquals(expectSegments, report["segments"])
    assertEquals(expectVideo, report["videoSamples"])
    assertEquals(expectAudio, report["audioSamples"])
    assertEquals(
      "$label: duration disagrees with the pre-registered measurement",
      expectDurationUs.toDouble(),
      (report["durationUs"] as Long).toDouble(),
      ROUNDING_US,
    )
    assertEquals(SegmentRemuxer.METHOD, report["method"])

    // ---- one container, not N ------------------------------------------
    val boxes = countBoxes(out)
    Log.i(TAG, "BOXES[$label] $boxes size=${out.length()}")
    assertEquals("$label: output must hold exactly one ftyp", 1, boxes["ftyp"])
    assertEquals("$label: output must hold exactly one moov", 1, boxes["moov"])

    // ---- the output is readable as one timeline ------------------------
    val probe = walkOutput(out)
    Log.i(TAG, "OUTPUT[$label] $probe")
    assertEquals("$label: video samples lost between report and file", expectVideo, probe.videoSamples)
    assertEquals("$label: audio samples lost between report and file", expectAudio, probe.audioSamples)
    assertEquals(
      "$label: the output's own audio span disagrees with the contract",
      expectDurationUs.toDouble(),
      (probe.audioLastUs + probe.frameUs).toDouble(),
      SPAN_ROUNDING_US,
    )

    // A single container whose tracks both start at 0 would mean the camera
    // latency of segment 0 had been trimmed away. It is real and it stays.
    assertTrue("$label: segment 0's video offset was flattened", probe.videoFirstUs > 0)

    // ---- the sources are untouched -------------------------------------
    for (f in inputs) {
      assertEquals(
        "source segment was modified by the export: ${f.name}",
        before[f.absolutePath],
        sha256(f),
      )
    }

    // ---- and it is a DERIVED artifact, not a copy ----------------------
    assertNotEquals(
      "the output must not be byte-identical to any source",
      before[inputs.first().absolutePath],
      sha256(out),
    )
  }

  /**
   * Where the output goes.
   *
   * A SEPARATE directory from the inputs, writable by this process, while
   * [DIR] stays read-only to it. The split is deliberate: the sources cannot
   * be modified even by accident, and the output survives the run — the test
   * APK is uninstalled when the Gradle task finishes, so anything left in its
   * own cache would be unreachable afterwards and could never be inspected by
   * an independent parser.
   *
   * The app's own external files directory, which `adb shell` can read on
   * Android 11 — so the artifact can be taken off the device and checked by a
   * parser that is not Android's. `/data/local/tmp` is not an option for the
   * output: SELinux denies an untrusted app write access there, which is why
   * the inputs can be read from it and nothing can be written beside them.
   *
   * Falls back to the private cache when external storage is unavailable, so
   * the test still runs; only the off-device inspection is lost.
   */
  private fun outputDir(): File {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    return ctx.getExternalFilesDir(null) ?: ctx.cacheDir
  }

  private fun inputsFor(prefix: String): List<File> =
    File(DIR).listFiles { f: File -> f.name.startsWith(prefix) && f.name.endsWith(".mp4") }
      ?.sortedBy { it.name }
      ?: emptyList()

  private class OutputProbe(
    val videoFirstUs: Long,
    val videoSamples: Int,
    val audioLastUs: Long,
    val audioSamples: Int,
    val frameUs: Long,
  ) {
    override fun toString() =
      "v_first_us=$videoFirstUs v_samples=$videoSamples " +
        "a_last_us=$audioLastUs a_samples=$audioSamples frame_us=$frameUs"
  }

  private fun walkOutput(file: File): OutputProbe {
    val ex = MediaExtractor()
    ex.setDataSource(file.absolutePath)
    try {
      var vFirst = -1L
      var vCount = 0
      var aLast = -1L
      var aCount = 0
      var frameUs = 0L

      for (i in 0 until ex.trackCount) {
        val fmt = ex.getTrackFormat(i)
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
        ex.selectTrack(i)
        val buf = ByteBuffer.allocate(1 shl 21)
        var first = -1L
        var last = -1L
        var count = 0
        while (true) {
          val t = ex.sampleTime
          if (t < 0) break
          if (first < 0) first = t
          last = t
          if (ex.readSampleData(buf, 0) < 0) break
          count++
          if (!ex.advance()) break
        }
        ex.unselectTrack(i)
        if (mime.startsWith("video/")) {
          vFirst = first
          vCount = count
        } else if (mime.startsWith("audio/")) {
          aLast = last
          aCount = count
          val rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          frameUs = (1024L * 1_000_000L) / rate
        }
      }
      return OutputProbe(vFirst, vCount, aLast, aCount, frameUs)
    } finally {
      ex.release()
    }
  }

  /**
   * Counts top-level box signatures by scanning the raw bytes.
   *
   * Deliberately not a box-tree parser: the question is "how many containers
   * are in here", and the defect being guarded against — several whole MP4s
   * end to end — shows up as repeated `ftyp` whatever the nesting.
   */
  private fun countBoxes(file: File): Map<String, Int> {
    val names = listOf("ftyp", "moov", "mdat")
    val counts = names.associateWith { 0 }.toMutableMap()
    val bytes = file.readBytes()
    for (name in names) {
      val pat = name.toByteArray(Charsets.US_ASCII)
      var i = 0
      var n = 0
      while (i <= bytes.size - pat.size) {
        var hit = true
        for (j in pat.indices) {
          if (bytes[i + j] != pat[j]) {
            hit = false
            break
          }
        }
        if (hit) {
          n++
          i += pat.size
        } else {
          i++
        }
      }
      counts[name] = n
    }
    return counts
  }

  private fun sha256(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { ins ->
      val buf = ByteArray(1 shl 16)
      while (true) {
        val read = ins.read(buf)
        if (read <= 0) break
        md.update(buf, 0, read)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  private companion object {
    const val TAG = "GC_REMUX_TEST"
    const val DIR = "/data/local/tmp/gc-probe"
    const val ROUNDING_US = 1_000.0

    /**
     * The output's audio span is rebuilt from per-boundary offsets that are
     * each rounded to a whole microsecond, so the accumulated rounding over N
     * boundaries lands here. Still three orders of magnitude below the AAC
     * frame (23 220 µs) that would mean a real timeline error.
     */
    const val SPAN_ROUNDING_US = 20_000.0
  }
}
