package com.guardiancloud.segrec

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.roundToLong

/**
 * EXPORT-MP4 · REMUX — assembles N closed segments into ONE playable `.mp4`.
 *
 * Compressed samples are copied, never re-encoded: same H.264 and same AAC
 * bytes, moved into a single container with their presentation times mapped
 * onto one timeline.
 *
 * ── Why a remux and not a concatenation ─────────────────────────────────
 * Each segment is a COMPLETE MP4 — its own `ftyp`, `moov` and `mdat`. Joining
 * them byte by byte yields a file a player reads only up to the first `moov`:
 * measured on a real export on 2026-10-04, 3,18 s reachable out of 25,17 s
 * captured, with every byte intact and nothing corrupt. There is no byte-level
 * repair for that; the only correct assembly is this one.
 *
 * ── The timeline contract ───────────────────────────────────────────────
 * `SegmentCoordinator` partitions the session at `cutPtsUs`: everything below
 * the cut closes the previous segment, the boundary keyframe opens the next
 * one, and the new segment's origin IS that cut. So the segments tile the
 * session exactly — no sample is dropped at a boundary — but each one is
 * rebased to its own origin and `cutPtsUs` is never persisted.
 *
 * The origin is recovered from the audio instead, which is a single
 * uninterrupted AAC frame sequence derived from one anchor and the PCM frame
 * counter:
 *
 *     span_k       = a_k + n_k * aacFrameUs - a_(k+1)
 *     offset_(k+1) = offset_k + span_k
 *     out_pts      = offset_k + pts_in_segment
 *
 * where `a_k` is the first audio sample time inside segment `k` (`audioLead`,
 * bounded by one AAC frame) and `n_k` its audio sample count. Summing
 * container durations instead is WRONG: a container's duration is
 * `last - first` PTS, so it double-counts every lead. On the 2026-08-24 run
 * that error was 98 ms over 11 boundaries.
 *
 * Verified on device before this existed: `MediaExtractor` on OnePlus A6000 /
 * Android 11 reports `a_k` unnormalised for 17 real segments, and the chain
 * reproduces 25 170 431 µs and 66 664 490 µs — the two independently measured
 * totals. See `ExtractorPtsProbeTest`.
 *
 * ── Integrity ───────────────────────────────────────────────────────────
 * Inputs are opened READ ONLY and never written, moved or deleted. The output
 * is a DERIVED artifact: it is not byte-identical to any source and its hash
 * matches none of them. Whoever presents it must say so.
 *
 * Anything inconsistent REFUSES. A partial output is deleted rather than
 * handed over: a file that claims to be the whole recording and is not is a
 * worse outcome than no file.
 *
 * This class never touches capture. It reads files that are already closed.
 */
object SegmentRemuxer {

  /**
   * Fail-closed refusal. `reason` is a stable code for the caller to branch
   * on; the message carries the detail for the log.
   */
  class RemuxRefused(val reason: String, detail: String) :
    Exception("$reason — $detail")

  /** What the scan pass learns about one segment, before anything is written. */
  private class Scan(
    val path: String,
    val videoTrack: Int,
    val audioTrack: Int,
    val videoFormat: MediaFormat,
    val audioFormat: MediaFormat,
    val audioFirstUs: Long,
    val audioSamples: Int,
    val sampleRate: Int,
    val maxInputSize: Int,
  )

  /**
   * @param inputPaths segments in `chunk_index` order.
   *
   *   ORDER IS THE CALLER'S CONTRACT, AND THIS CLASS CANNOT CHECK IT. Every
   *   segment is rebased to its own origin, so none of them carries its
   *   position in the session — that is the same missing `cutPtsUs` the whole
   *   contract works around. `span_k` is dominated by the segment's own audio
   *   content, which is order-independent, so a reversed or shuffled set
   *   produces positive spans and is assembled without complaint. Pinned by
   *   `SegmentRemuxTest.cannotDetectReorderedInputByItself`.
   *
   *   The caller must therefore derive the order from `chunk_index` and refuse
   *   a set with holes BEFORE calling. This class does not sort and does not
   *   pretend to validate.
   * @param outputPath destination. An existing file there is replaced.
   */
  fun remux(inputPaths: List<String>, outputPath: String): Map<String, Any?> {
    if (inputPaths.isEmpty()) {
      throw RemuxRefused("no_inputs", "nothing to assemble")
    }

    for (p in inputPaths) {
      val f = File(p)
      if (!f.isFile) throw RemuxRefused("input_missing", p)
      if (f.length() <= 0L) throw RemuxRefused("input_empty", p)
    }

    val scans = inputPaths.map { scan(it) }
    requireUniformFormats(scans)

    val offsets = computeOffsets(scans)
    val last = scans.last()
    val totalUs =
      offsets.last() + last.audioFirstUs + framesToUs(last.audioSamples, last.sampleRate)

    val out = File(outputPath)
    if (out.exists() && !out.delete()) {
      throw RemuxRefused("output_not_writable", "could not replace $outputPath")
    }

    val bufferBytes = scans.maxOf { it.maxInputSize }.coerceIn(MIN_BUFFER, MAX_BUFFER)
    var videoWritten = 0
    var audioWritten = 0

    val muxer = try {
      MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    } catch (t: Throwable) {
      throw RemuxRefused("muxer_open_failed", "${t.javaClass.simpleName}: ${t.message}")
    }

    var started = false
    try {
      // Codec config travels through the FORMAT. The encoder never stops
      // during a session, so segment 0's formats describe every segment —
      // `requireUniformFormats` has already proved that holds here.
      val outVideo = muxer.addTrack(scans.first().videoFormat)
      val outAudio = muxer.addTrack(scans.first().audioFormat)
      muxer.start()
      started = true

      val buffer = ByteBuffer.allocate(bufferBytes)
      for ((k, s) in scans.withIndex()) {
        // Per-track monotonicity is what MediaMuxer requires, so each track
        // is copied whole, in order, and the offsets only ever grow.
        videoWritten += copyTrack(s.path, s.videoTrack, muxer, outVideo, offsets[k], buffer)
        audioWritten += copyTrack(s.path, s.audioTrack, muxer, outAudio, offsets[k], buffer)
      }
    } catch (t: Throwable) {
      safeRelease(muxer, started)
      out.delete()
      if (t is RemuxRefused) throw t
      throw RemuxRefused("write_failed", "${t.javaClass.simpleName}: ${t.message}")
    }

    try {
      muxer.stop()
    } catch (t: Throwable) {
      muxer.release()
      out.delete()
      throw RemuxRefused("muxer_stop_failed", "${t.javaClass.simpleName}: ${t.message}")
    }
    muxer.release()

    val expectedAudio = scans.sumOf { it.audioSamples }
    if (audioWritten != expectedAudio) {
      out.delete()
      throw RemuxRefused(
        "audio_sample_loss",
        "wrote $audioWritten of $expectedAudio audio samples",
      )
    }

    val size = out.length()
    if (size <= 0L) {
      out.delete()
      throw RemuxRefused("output_empty", outputPath)
    }

    Log.i(
      TAG,
      "GC_REMUX_DONE segments=${scans.size} total_us=$totalUs " +
        "video_samples=$videoWritten audio_samples=$audioWritten bytes=$size",
    )

    return mapOf(
      "segments" to scans.size,
      "durationUs" to totalUs,
      "videoSamples" to videoWritten,
      "audioSamples" to audioWritten,
      "sizeBytes" to size,
      "offsetsUs" to offsets,
      "method" to METHOD,
    )
  }

  // =====================================================================

  /**
   * Reads one segment's shape without writing anything.
   *
   * The first audio sample time is taken WITHOUT seeking: a `seekTo` is the
   * one call that could mask a non-zero start by snapping to a sync sample.
   */
  private fun scan(path: String): Scan {
    val ex = MediaExtractor()
    try {
      ex.setDataSource(path)
    } catch (t: Throwable) {
      ex.release()
      throw RemuxRefused("unreadable_segment", "$path — ${t.javaClass.simpleName}: ${t.message}")
    }

    try {
      var videoTrack = -1
      var audioTrack = -1
      var videoFormat: MediaFormat? = null
      var audioFormat: MediaFormat? = null

      for (i in 0 until ex.trackCount) {
        val fmt = ex.getTrackFormat(i)
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
        if (videoTrack < 0 && mime.startsWith("video/")) {
          videoTrack = i
          videoFormat = fmt
        } else if (audioTrack < 0 && mime.startsWith("audio/")) {
          audioTrack = i
          audioFormat = fmt
        }
      }

      val vf = videoFormat ?: throw RemuxRefused("no_video_track", path)
      val af = audioFormat ?: throw RemuxRefused("no_audio_track", path)

      if (!af.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
        throw RemuxRefused("no_sample_rate", path)
      }
      val sampleRate = af.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      if (sampleRate <= 0) throw RemuxRefused("bad_sample_rate", "$path — $sampleRate")

      // Audio is walked in full because `n_k` is load-bearing: it is what
      // converts "this segment's audio content" into session time.
      ex.selectTrack(audioTrack)
      var first = -1L
      var count = 0
      while (true) {
        val t = ex.sampleTime
        if (t < 0) break
        if (first < 0) first = t
        count++
        if (!ex.advance()) break
      }
      ex.unselectTrack(audioTrack)

      if (first < 0 || count == 0) throw RemuxRefused("no_audio_samples", path)

      val maxInput =
        maxOf(
          if (vf.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
            vf.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
          } else {
            0
          },
          if (af.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
            af.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
          } else {
            0
          },
        )

      return Scan(
        path = path,
        videoTrack = videoTrack,
        audioTrack = audioTrack,
        videoFormat = vf,
        audioFormat = af,
        audioFirstUs = first,
        audioSamples = count,
        sampleRate = sampleRate,
        maxInputSize = maxInput,
      )
    } finally {
      ex.release()
    }
  }

  /**
   * One muxer track per medium means every segment must agree on the codec and
   * its geometry. They do, because one encoder produced all of them — so a
   * disagreement means the set is not one session, and that REFUSES rather
   * than producing a file that silently changes format halfway through.
   */
  private fun requireUniformFormats(scans: List<Scan>) {
    val head = scans.first()
    val vMime = head.videoFormat.getString(MediaFormat.KEY_MIME)
    val aMime = head.audioFormat.getString(MediaFormat.KEY_MIME)
    val w = intOrNull(head.videoFormat, MediaFormat.KEY_WIDTH)
    val h = intOrNull(head.videoFormat, MediaFormat.KEY_HEIGHT)
    val ch = intOrNull(head.audioFormat, MediaFormat.KEY_CHANNEL_COUNT)

    for (s in scans.drop(1)) {
      if (s.videoFormat.getString(MediaFormat.KEY_MIME) != vMime) {
        throw RemuxRefused("video_mime_mismatch", s.path)
      }
      if (s.audioFormat.getString(MediaFormat.KEY_MIME) != aMime) {
        throw RemuxRefused("audio_mime_mismatch", s.path)
      }
      if (intOrNull(s.videoFormat, MediaFormat.KEY_WIDTH) != w ||
        intOrNull(s.videoFormat, MediaFormat.KEY_HEIGHT) != h
      ) {
        throw RemuxRefused("resolution_mismatch", s.path)
      }
      if (s.sampleRate != head.sampleRate) {
        throw RemuxRefused("sample_rate_mismatch", "${s.path} — ${s.sampleRate}")
      }
      if (intOrNull(s.audioFormat, MediaFormat.KEY_CHANNEL_COUNT) != ch) {
        throw RemuxRefused("channel_count_mismatch", s.path)
      }
    }
  }

  /**
   * The contract, applied. `offsets[k]` is where segment `k` starts on the
   * output timeline; `offsets[0]` is 0 by definition — segment 0 keeps its own
   * internal video offset, which is real (the camera delivers its first frame
   * hundreds of milliseconds after audio starts) and is NOT trimmed.
   *
   * Accumulation is in Double and rounded once per offset, so the rounding of
   * one boundary never feeds the next.
   */
  private fun computeOffsets(scans: List<Scan>): List<Long> {
    val offsets = ArrayList<Long>(scans.size)
    offsets.add(0L)
    var acc = 0.0
    for (k in 0 until scans.size - 1) {
      val cur = scans[k]
      val next = scans[k + 1]
      val span = cur.audioFirstUs + framesToUsExact(cur.audioSamples, cur.sampleRate) -
        next.audioFirstUs
      if (span <= 0.0) {
        throw RemuxRefused(
          "non_advancing_timeline",
          "span $k = $span us between ${cur.path} and ${next.path} — " +
            "segments out of order, or not from one session",
        )
      }
      acc += span
      offsets.add(acc.roundToLong())
    }
    return offsets
  }

  /**
   * Copies every sample of one track, shifted by `offsetUs`.
   *
   * A fresh extractor per track keeps the read position unambiguous and costs
   * one open per track per segment, which is irrelevant next to the copy.
   */
  private fun copyTrack(
    path: String,
    track: Int,
    muxer: MediaMuxer,
    outTrack: Int,
    offsetUs: Long,
    buffer: ByteBuffer,
  ): Int {
    val ex = MediaExtractor()
    ex.setDataSource(path)
    try {
      ex.selectTrack(track)
      val info = MediaCodec.BufferInfo()
      var written = 0
      var lastOut = Long.MIN_VALUE

      while (true) {
        val pts = ex.sampleTime
        if (pts < 0) break

        buffer.clear()
        val size = ex.readSampleData(buffer, 0)
        if (size < 0) break

        val outPts = offsetUs + pts
        if (outPts < 0) {
          throw RemuxRefused("negative_output_pts", "$path track=$track pts=$outPts")
        }
        if (outPts < lastOut) {
          throw RemuxRefused(
            "pts_regression",
            "$path track=$track $outPts < $lastOut",
          )
        }
        lastOut = outPts

        info.offset = 0
        info.size = size
        info.presentationTimeUs = outPts
        info.flags =
          if (ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
            MediaCodec.BUFFER_FLAG_KEY_FRAME
          } else {
            0
          }

        muxer.writeSampleData(outTrack, buffer, info)
        written++
        if (!ex.advance()) break
      }
      return written
    } finally {
      ex.release()
    }
  }

  private fun intOrNull(fmt: MediaFormat, key: String): Int? =
    if (fmt.containsKey(key)) fmt.getInteger(key) else null

  /** `n` AAC frames of 1024 samples, in microseconds. */
  private fun framesToUsExact(frames: Int, sampleRate: Int): Double =
    frames.toDouble() * AAC_FRAME_SAMPLES * 1_000_000.0 / sampleRate

  private fun framesToUs(frames: Int, sampleRate: Int): Long =
    framesToUsExact(frames, sampleRate).roundToLong()

  private fun safeRelease(muxer: MediaMuxer, started: Boolean) {
    try {
      if (started) muxer.stop()
    } catch (_: Throwable) {
      // Already failing; the output is about to be deleted either way.
    }
    try {
      muxer.release()
    } catch (_: Throwable) {
    }
  }

  private const val TAG = "GCSegRec"
  private const val AAC_FRAME_SAMPLES = 1024
  private const val MIN_BUFFER = 1 shl 20
  private const val MAX_BUFFER = 8 shl 20

  /**
   * Recorded in the output manifest so a later reader knows HOW the timeline
   * was rebuilt, not merely that it was.
   */
  const val METHOD = "audio_contiguity_v1"
}
