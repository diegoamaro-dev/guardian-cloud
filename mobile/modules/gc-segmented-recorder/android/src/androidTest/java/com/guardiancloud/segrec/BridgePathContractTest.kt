package com.guardiancloud.segrec

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

// --- The JS→native path contract ----------------------------------------
//
// A real export failed because every path `expo-file-system` builds is a
// `file://` URI, while `SegmentRemuxer` consumes `java.io.File`. Both sides
// type the argument as `String`, so neither the compiler nor the Expo bridge
// could see it: `File("file:///data/…/seg_000000.mp4").isFile` read the URI as
// a RELATIVE path and the guard refused with `input_missing` — correct guard,
// misleading reason.
//
// The device tests that validated the remuxer all passed PLAIN paths from
// `/data/local/tmp`, which no production caller ever uses. That is the gap
// these tests close: the contract is now exercised in the form Expo actually
// produces, for inputs AND for the output.

class BridgePathContractTest {

  @Test
  fun absolutePathIsAcceptedUnchanged() {
    assertEquals("/data/local/tmp/gc-probe/d3_000.mp4",
      resolveBridgePath("/data/local/tmp/gc-probe/d3_000.mp4"))
  }

  @Test
  fun fileUriBecomesAnAbsolutePath() {
    assertEquals("/data/user/0/com.example/cache/remux/seg_000000.mp4",
      resolveBridgePath("file:///data/user/0/com.example/cache/remux/seg_000000.mp4"))
  }

  @Test
  fun percentEncodingIsDecoded() {
    // The case a hand-rolled prefix strip gets wrong: it would leave `%20`
    // in the path and open nothing, without saying why.
    assertEquals("/data/a b/seg ø.mp4",
      resolveBridgePath("file:///data/a%20b/seg%20%C3%B8.mp4"))
  }

  @Test
  fun contentUriIsRefused() {
    // Not openable with `File` at all. Refusing here names the real fault
    // instead of letting it surface as a missing file.
    assertNull(resolveBridgePath("content://media/external/video/media/42"))
  }

  @Test
  fun otherSchemesAreRefused() {
    assertNull(resolveBridgePath("http://example.com/seg.mp4"))
    assertNull(resolveBridgePath("https://example.com/seg.mp4"))
  }

  @Test
  fun unresolvableFileUriIsRefused() {
    assertNull(resolveBridgePath("file://"))
    assertNull(resolveBridgePath("file:///"))
    assertNull(resolveBridgePath("file:relative/seg.mp4"))
  }

  @Test
  fun fileUriNamingAHostIsRefused() {
    // `path` would be a path on THAT host; taking it as local opens the wrong
    // file or none.
    assertNull(resolveBridgePath("file://remote-host/share/seg.mp4"))
  }

  @Test
  fun relativeAndEmptyAreRefused() {
    assertNull(resolveBridgePath("gc-probe/d3_000.mp4"))
    assertNull(resolveBridgePath(""))
  }
}

// --- The boundary, over the real retained segments ----------------------

class BridgeRemuxIntegrationTest {

  private fun inputs(): List<File> =
    File(FIXTURE_DIR).listFiles { f: File -> f.name.startsWith("d3_") && f.name.endsWith(".mp4") }
      ?.sortedBy { it.name }
      ?: emptyList()

  private fun outDir(): File {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    return ctx.getExternalFilesDir(null) ?: ctx.cacheDir
  }

  /**
   * RED, pinned. Handing `SegmentRemuxer` the raw `file://` URIs — exactly
   * what the export did — must still refuse with `input_missing`.
   *
   * This is not a bug being preserved: it is the remuxer's guard doing its
   * job over a value outside its contract. The test exists so the reason the
   * fix is needed cannot quietly disappear.
   */
  @Test
  fun rawFileUrisAreStillRefusedBySegmentRemuxer() {
    val segments = inputs()
    assumeTrue("fixture absent — push real segments to $FIXTURE_DIR", segments.size >= 2)

    val out = File(outDir(), "out_bridge_red.mp4")
    out.delete()

    val refusal = try {
      SegmentRemuxer.remux(segments.map { "file://${it.absolutePath}" }, out.absolutePath)
      null
    } catch (e: SegmentRemuxer.RemuxRefused) {
      e
    }

    assertEquals("input_missing", refusal?.reason)
    assertTrue("a refusal must leave no output behind", !out.exists())
  }

  /**
   * GREEN. The same URIs, resolved at the boundary the way the module now
   * does, produce one playable container — and the OUTPUT is handed over as a
   * `file://` URI too, because that is the form `documentDirectory` yields and
   * the form the export actually passes.
   */
  @Test
  fun resolvedFileUrisRemuxWithUriInputsAndUriOutput() {
    val segments = inputs()
    assumeTrue("fixture absent — push real segments to $FIXTURE_DIR", segments.size >= 2)

    val before = segments.associate { it.absolutePath to sha256(it) }

    val outFile = File(outDir(), "out_bridge_green.mp4")
    outFile.delete()
    val outUri = "file://${outFile.absolutePath}"

    // Exactly what the module's AsyncFunction does, in the same order.
    val resolvedInputs = segments.map { seg ->
      resolveBridgePath("file://${seg.absolutePath}")
        ?: throw AssertionError("input URI did not resolve: ${seg.name}")
    }
    val resolvedOut = resolveBridgePath(outUri)
      ?: throw AssertionError("output URI did not resolve")

    val report = SegmentRemuxer.remux(resolvedInputs, resolvedOut)
    Log.i(TAG, "BRIDGE_GREEN $report")

    assertEquals(segments.size, report["segments"])
    assertTrue("the output must exist", outFile.exists())
    assertTrue("the output must not be empty", outFile.length() > 0)

    // One container, not N — the property the whole gate is about.
    val bytes = outFile.readBytes()
    assertEquals("exactly one ftyp", 1, countBox(bytes, "ftyp"))
    assertEquals("exactly one moov", 1, countBox(bytes, "moov"))

    // The sources are read-only, even through the URI path.
    for (seg in segments) {
      assertEquals("source modified: ${seg.name}", before[seg.absolutePath], sha256(seg))
    }

    outFile.delete()
  }

  private fun countBox(bytes: ByteArray, name: String): Int {
    val pat = name.toByteArray(Charsets.US_ASCII)
    var i = 0
    var n = 0
    while (i <= bytes.size - pat.size) {
      var hit = true
      for (j in pat.indices) if (bytes[i + j] != pat[j]) { hit = false; break }
      if (hit) { n++; i += pat.size } else i++
    }
    return n
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
    const val TAG = "GC_BRIDGE_TEST"
    const val FIXTURE_DIR = "/data/local/tmp/gc-probe"
  }
}
