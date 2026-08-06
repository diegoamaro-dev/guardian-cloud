package com.guardiancloud.segrec

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * SPIKE — P2 early gate. AudioRecord → AAC-LC on the session clock.
 *
 * Zero silent PCM loss. Every read either reaches the encoder or triggers a
 * terminal overflow:
 *
 *   - PCM captured during the `AudioTimestamp` warm-up is RETAINED, not
 *     thrown away to advance the frame counter.
 *   - When `dequeueInputBuffer()` has no slot, the buffer is queued instead of
 *     dropped, and retried on the next pass.
 *   - The PCM queue is bounded by entries AND bytes; overflow is
 *     [ErrorCode.PCM_QUEUE_OVERFLOW], never a silent discard.
 *   - `audioFramesDropped` counts real losses only, and nothing is dropped
 *     without incrementing it.
 *
 * LIFETIME CONTRACT (identical in [VideoEncoder]):
 *
 *  - `start()` and `release()` are mutually exclusive; each worker thread is
 *    published into its field BEFORE it is started, so a concurrent release can
 *    never miss a thread that is about to run.
 *  - `AudioRecord.stop()` always precedes any join: the capture thread blocks
 *    inside `read()`, which only returns once recording stops.
 *  - Native resources are released in EXACTLY ONE place, and only once every
 *    thread that can still touch them has PROVABLY terminated. If a join does
 *    not prove that, the release is deferred — never performed anyway.
 *  - `release()` reports COMPLETION, not intent: its callback fires when the
 *    resources were actually freed, or when the deferred attempt gave up and
 *    the resources were deliberately leaked. Launching the reaper is not
 *    completion, and the caller must not treat it as such.
 */
class AudioEncoder(
  private val config: CaptureConfig,
  private val clock: SessionClock,
  private val coordinator: SegmentCoordinator,
  private val onError: (String, String) -> Unit,
) {
  private class Raw(val data: ByteArray, val rawPtsNs: Long, val flags: Int)
  private class Pcm(val data: ByteArray, val length: Int, val ptsNs: Long)

  /** Guards start/release against each other. Never held across a join. */
  private val lifecycle = Any()

  /** Release runs exactly once, whoever gets there first. */
  private val released = AtomicBoolean(false)

  /**
   * Guards the release OUTCOME and its waiter list. Distinct from [lifecycle]:
   * the outcome can be published from the reaper thread long after every
   * lifecycle section has been left.
   */
  private val outcomeLock = Any()

  /** Null until the release has ACTUALLY finished. true = freed, false = leaked. */
  private var releaseOutcome: Boolean? = null
  private val releaseWaiters = ArrayList<(Boolean) -> Unit>()

  @Volatile private var recorder: AudioRecord? = null
  @Volatile private var codec: MediaCodec? = null
  @Volatile private var captureThread: Thread? = null
  @Volatile private var drainThread: Thread? = null

  private val running = AtomicBoolean(false)
  private val eosRequested = AtomicBoolean(false)
  private val eosSeen = AtomicBoolean(false)
  private val seq = AtomicLong(0)
  private var firstFrameReported = false

  /** PCM captured but not yet accepted by the encoder. Bounded. */
  private val pcmQueue = ArrayDeque<Pcm>()
  private var pcmBytes = 0

  /** Encoded output produced before `t0` exists. Bounded. */
  private val preT0 = ArrayList<Raw>()
  private var preT0Bytes = 0

  var requestedFormatDescription: String = ""
    private set
  var actualFormatDescription: String = ""
    private set

  /** Completes once the encoder has emitted BUFFER_FLAG_END_OF_STREAM. */
  @Volatile var onEosDrained: (() -> Unit)? = null

  /**
   * Returns false on a synchronous failure so startup can abort at once.
   *
   * Fully transactional: the ENTIRE body — `MediaFormat` creation included —
   * sits inside one try/catch, so no synchronous exception can escape. The
   * audio format is built BEFORE `AudioRecord` exists, so a format failure
   * cannot leak the microphone, and every failure hands what was built to the
   * single release path rather than freeing it inline.
   */
  fun start(): Boolean = synchronized(lifecycle) {
    if (released.get()) {
      onError(ErrorCode.ENCODER_FAILED, "audio start() after release()")
      return false
    }

    var rec: AudioRecord? = null
    var c: MediaCodec? = null
    var cap: Thread? = null
    var drn: Thread? = null
    var stage = "channelMask"
    try {
      val channelMask =
        if (config.audioChannels == 1) AudioFormat.CHANNEL_IN_MONO
        else AudioFormat.CHANNEL_IN_STEREO

      stage = "getMinBufferSize"
      val minBuf = AudioRecord.getMinBufferSize(
        config.audioSampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT,
      )
      if (minBuf <= 0) throw IllegalStateException("getMinBufferSize returned $minBuf")

      // Format FIRST: nothing native is held yet, so a throw here leaks nothing.
      stage = "createAudioFormat"
      val format = MediaFormat.createAudioFormat(
        MIME, config.audioSampleRate, config.audioChannels,
      ).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, config.audioBitrate)
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, minBuf * 4)
      }
      requestedFormatDescription = format.toString()
      Log.i(TAG, "GC_P2_GATE audio_format_requested $requestedFormatDescription")

      stage = "audioRecord"
      rec = AudioRecord(
        MediaRecorder.AudioSource.MIC, config.audioSampleRate, channelMask,
        AudioFormat.ENCODING_PCM_16BIT, minBuf * 4,
      )
      if (rec.state != AudioRecord.STATE_INITIALIZED) {
        throw IllegalStateException("AudioRecord not initialised (state=${rec.state})")
      }

      stage = "createEncoderByType"
      c = MediaCodec.createEncoderByType(MIME)
      stage = "configure"
      c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      stage = "codecStart"
      c.start()

      recorder = rec
      codec = c
      running.set(true)

      stage = "startRecording"
      rec.startRecording()
      if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        throw IllegalStateException("recordingState=${rec.recordingState}")
      }

      // PUBLISH BEFORE START, both threads. Writing the field only after
      // `start()` left a window in which a concurrent release read `null`,
      // joined nothing and freed resources under a thread about to use them.
      val recRef = rec
      val codecRef = c

      stage = "captureThread"
      cap = Thread({ captureLoop(recRef, codecRef) }, "gc-segrec-audio-cap")
      captureThread = cap
      cap.start()

      stage = "drainThread"
      drn = Thread({ drainLoop(codecRef) }, "gc-segrec-audio-drain")
      drainThread = drn
      drn.start()
    } catch (t: Throwable) {
      releaseWhenQuiescent(rec, c, listOfNotNull(cap, drn), "failed_start:$stage")
      onError(ErrorCode.ENCODER_FAILED, "audio encoder failed at $stage: ${t.message}")
      return false
    }
    return true
  }

  /** Ordered stop: stop capturing, then let the encoder flush through EOS. */
  fun signalEndOfStream() {
    eosRequested.set(true)
    Log.i(TAG, "GC_P2_GATE audio_eos_requested")
  }

  fun eosDrained(): Boolean = eosSeen.get()

  /**
   * Both handles arrive as PARAMETERS, never read from the fields: a release
   * that won the race has already nulled them, and the guard below is what
   * makes a late-started thread return without touching anything.
   */
  private fun captureLoop(rec: AudioRecord, c: MediaCodec) {
    if (!running.get()) {
      Log.w(TAG, "GC_P2_GATE audio_capture_start_skipped release_in_progress")
      return
    }

    val frameBytes = 2 * config.audioChannels
    val chunkFrames = 1024
    var framesRead = 0L

    // Warm-up. PCM read here is RETAINED — it is real audio, not throwaway
    // data used to advance a counter. Its PTS is computed once the anchor
    // exists, from the frame position recorded at read time.
    val pendingWarmup = ArrayList<Pair<ByteArray, Long>>()
    var warmupBytes = 0
    val warmupDeadline = SystemClock.elapsedRealtime() + Limits.AUDIO_ANCHOR_WARMUP_MS
    while (running.get() && !clock.hasAnchor()) {
      clock.tryAnchor(rec, config.audioSampleRate)
      val buf = ByteArray(chunkFrames * frameBytes)
      val n = rec.read(buf, 0, buf.size)
      if (n > 0) {
        pendingWarmup.add(buf.copyOf(n) to framesRead)
        warmupBytes += n
        framesRead += n / frameBytes
        if (pendingWarmup.size > Limits.PCM_MAX_ENTRIES || warmupBytes > Limits.PCM_MAX_BYTES) {
          onError(
            ErrorCode.PCM_QUEUE_OVERFLOW,
            "warm-up PCM overflow entries=${pendingWarmup.size} bytes=$warmupBytes",
          )
          return
        }
      }
      if (!clock.hasAnchor() && SystemClock.elapsedRealtime() > warmupDeadline) {
        onError(
          ErrorCode.AUDIO_TIMESTAMP_UNAVAILABLE,
          "no valid AudioRecord timestamp anchor within ${Limits.AUDIO_ANCHOR_WARMUP_MS}ms",
        )
        return
      }
    }
    if (!running.get()) return

    // `t0` must be built from the FIRST REAL sample retained, not from
    // whichever buffer happened to arrive later. The anchor now exists, so the
    // warm-up PCM can be timestamped — and its first buffer is offered as the
    // session's first audio BEFORE anything is enqueued.
    if (pendingWarmup.isNotEmpty()) {
      val firstStartFrame = pendingWarmup.first().second
      val firstPtsNs = clock.audioPtsNs(firstStartFrame, config.audioSampleRate)
      firstFrameReported = true
      clock.offerFirstAudioNs(firstPtsNs)
      Log.i(TAG, "GC_P2_GATE audio_first_pts_ns=$firstPtsNs source=warmup")
    }

    // Nothing captured during warm-up is lost: it is timestamped now and
    // enqueued in order, ahead of everything that follows.
    for ((data, startFrame) in pendingWarmup) {
      enqueuePcm(Pcm(data, data.size, clock.audioPtsNs(startFrame, config.audioSampleRate)))
    }
    Log.i(TAG, "GC_P2_GATE audio_warmup_retained buffers=${pendingWarmup.size} bytes=$warmupBytes")
    pendingWarmup.clear()

    var lastAnchorPollMs = SystemClock.elapsedRealtime()

    while (running.get()) {
      if (!eosRequested.get()) {
        val buf = ByteArray(chunkFrames * frameBytes)
        // PTS belongs to the FIRST frame of this buffer, captured BEFORE the
        // read advances the counter.
        val pcmStartFramePosition = framesRead
        val n = rec.read(buf, 0, buf.size)
        if (n > 0) {
          framesRead += n / frameBytes
          val ptsNs = clock.audioPtsNs(pcmStartFramePosition, config.audioSampleRate)
          // Only reached when there was no warm-up PCM at all: then the first
          // NORMAL buffer is the session's first audio.
          if (!firstFrameReported) {
            firstFrameReported = true
            clock.offerFirstAudioNs(ptsNs)
            Log.i(TAG, "GC_P2_GATE audio_first_pts_ns=$ptsNs source=normal")
          }
          if (!enqueuePcm(Pcm(buf, n, ptsNs))) return
        }
      }

      if (!feedEncoder(c)) return

      if (eosRequested.get() && pcmQueue.isEmpty()) {
        // All captured PCM has been accepted; now signal EOS exactly once.
        try {
          val idx = c.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
          if (idx >= 0) {
            c.queueInputBuffer(idx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            Log.i(TAG, "GC_P2_GATE audio_eos_queued")
            return
          }
        } catch (t: Throwable) {
          onError(ErrorCode.ENCODER_FAILED, "audio EOS queue failed: ${t.message}"); return
        }
      }

      val now = SystemClock.elapsedRealtime()
      if (now - lastAnchorPollMs >= ANCHOR_POLL_MS) {
        lastAnchorPollMs = now
        clock.tryAnchor(rec, config.audioSampleRate)
        clock.driftResidualNs()?.let { Log.i(TAG, "GC_P2_GATE audio_drift_residual_ns=$it") }
      }
    }
  }

  /** Bounded by entries AND bytes. Overflow is terminal, never a drop. */
  private fun enqueuePcm(p: Pcm): Boolean {
    pcmQueue.addLast(p)
    pcmBytes += p.length
    if (pcmQueue.size > Limits.PCM_MAX_ENTRIES || pcmBytes > Limits.PCM_MAX_BYTES) {
      onError(
        ErrorCode.PCM_QUEUE_OVERFLOW,
        "PCM queue overflow entries=${pcmQueue.size} bytes=$pcmBytes",
      )
      return false
    }
    return true
  }

  /** Drains the PCM queue into the encoder for as long as slots are free. */
  private fun feedEncoder(c: MediaCodec): Boolean {
    while (pcmQueue.isNotEmpty()) {
      val idx = try {
        c.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
      } catch (t: Throwable) {
        onError(ErrorCode.ENCODER_FAILED, "dequeueInputBuffer failed: ${t.message}"); return false
      }
      // No slot right now: keep the PCM queued and retry next pass.
      if (idx < 0) return true
      val p = pcmQueue.removeFirst()
      pcmBytes -= p.length
      try {
        val inBuf = c.getInputBuffer(idx)
        inBuf?.clear()
        inBuf?.put(p.data, 0, p.length)
        c.queueInputBuffer(idx, 0, p.length, p.ptsNs / 1000L, 0)
      } catch (t: Throwable) {
        onError(ErrorCode.ENCODER_FAILED, "queueInputBuffer failed: ${t.message}"); return false
      }
    }
    return true
  }

  private fun drainLoop(c: MediaCodec) {
    if (!running.get()) {
      Log.w(TAG, "GC_P2_GATE audio_drain_start_skipped release_in_progress")
      return
    }

    val info = MediaCodec.BufferInfo()
    while (running.get()) {
      val index = try {
        c.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)
      } catch (t: Throwable) {
        onError(ErrorCode.ENCODER_FAILED, "audio dequeue failed: ${t.message}"); return
      }

      when {
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val actual = c.outputFormat
          actualFormatDescription = actual.toString()
          Log.i(TAG, "GC_P2_GATE audio_format_actual $actualFormatDescription")
          coordinator.onAudioFormat(actual)
        }

        index >= 0 -> {
          val buf = c.getOutputBuffer(index)
          if (buf != null && info.size > 0) {
            val bytes = ByteArray(info.size)
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            buf.get(bytes)
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
              emit(Raw(bytes, info.presentationTimeUs * 1000L, info.flags))
            }
          }
          try { c.releaseOutputBuffer(index, false) } catch (_: Throwable) { }

          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            flushPreT0()
            eosSeen.set(true)
            Log.i(TAG, "GC_P2_GATE audio_eos_drained")
            onEosDrained?.invoke()
            return
          }
        }
      }
    }
  }

  private fun emit(raw: Raw) {
    if (!clock.t0Established()) {
      preT0.add(raw)
      preT0Bytes += raw.data.size
      if (preT0.size > Limits.PREROLL_MAX_ENTRIES || preT0Bytes > Limits.PREROLL_MAX_BYTES) {
        onError(
          ErrorCode.PREROLL_QUEUE_OVERFLOW,
          "audio pre-t0 overflow entries=${preT0.size} bytes=$preT0Bytes",
        )
      }
      return
    }
    flushPreT0()
    submit(raw)
  }

  /** Same rule as video: prove non-negative session PTS before flushing. */
  private fun flushPreT0() {
    if (preT0.isEmpty() || !clock.t0Established()) return

    var worst: Long = Long.MAX_VALUE
    for (p in preT0) {
      val pts = clock.toSessionPtsUs(p.rawPtsNs)
      if (pts < worst) worst = pts
    }
    if (worst < 0) {
      onError(
        ErrorCode.REBASE_NEGATIVE_PTS,
        "audio pre-t0 flush would emit negative session PTS (min=${worst}us over " +
          "${preT0.size} samples)",
      )
      return
    }

    val pending = ArrayList(preT0)
    preT0.clear(); preT0Bytes = 0
    Log.i(TAG, "GC_P2_GATE audio_pre_t0_flushed n=${pending.size} min_session_pts_us=$worst")
    for (p in pending) submit(p)
  }

  private fun submit(raw: Raw) {
    coordinator.submit(
      QueuedSample(
        kind = TrackKind.AUDIO,
        data = raw.data,
        ptsUs = clock.toSessionPtsUs(raw.rawPtsNs),
        flags = raw.flags,
        isKeyFrame = false,
        deliverySeq = seq.getAndIncrement(),
      ),
    )
  }

  /**
   * Hard teardown. Only after the EOS drain, or on terminal failure.
   *
   * @param onComplete invoked EXACTLY once, when the release has genuinely
   *   finished — on the caller's thread if both workers were already
   *   quiescent, otherwise on the reaper's. `freed = true` means every native
   *   resource was released; `freed = false` means a worker never terminated
   *   and the `AudioRecord` and codec were DELIBERATELY LEAKED. The callback is
   *   never fired merely because a reaper was launched.
   */
  fun release(onComplete: (freed: Boolean) -> Unit) {
    // Registered BEFORE the teardown starts, so a fully synchronous release
    // cannot publish its outcome into an empty waiter list.
    awaitOutcome(onComplete)

    val rec: AudioRecord?
    val c: MediaCodec?
    val threads: List<Thread>
    synchronized(lifecycle) {
      // Snapshot and clear under the lock so nothing else can reach these
      // objects; the joins happen OUTSIDE it, so a worker blocked on the module
      // monitor can never deadlock against a release holding this one.
      rec = recorder
      c = codec
      threads = listOfNotNull(captureThread, drainThread)
      running.set(false)
      recorder = null
      codec = null
      captureThread = null
      drainThread = null
    }
    releaseWhenQuiescent(rec, c, threads, "release")
  }

  // =====================================================================
  // Release outcome — completion, not intent
  // =====================================================================

  /** Fires [cb] now if the outcome is already known, otherwise queues it. */
  private fun awaitOutcome(cb: (Boolean) -> Unit) {
    val known: Boolean? = synchronized(outcomeLock) {
      val o = releaseOutcome
      if (o == null) { releaseWaiters.add(cb); null } else o
    }
    if (known != null) cb(known)
  }

  /** Publishes the terminal outcome exactly once and wakes every waiter. */
  private fun publishOutcome(freed: Boolean) {
    val waiters: List<(Boolean) -> Unit>
    synchronized(outcomeLock) {
      if (releaseOutcome != null) return    // exactly once
      releaseOutcome = freed
      waiters = ArrayList(releaseWaiters)
      releaseWaiters.clear()
    }
    // Invoked OUTSIDE the lock: a waiter runs `finalizeSession`, which takes
    // the module monitor, and must not do so while holding this one.
    for (w in waiters) w(freed)
  }

  // =====================================================================
  // Single release path
  // =====================================================================

  /**
   * The ONLY place audio native resources are freed.
   *
   * `AudioRecord.stop()` comes first: the capture thread blocks inside
   * `read()`, which only returns once recording stops, so joining before
   * stopping would burn the whole timeout against a thread that cannot move.
   *
   * Nothing is released until every thread that could still touch it has
   * PROVABLY terminated. If a join times out, is interrupted, or is a self-join
   * (the failing worker is the one running this teardown), the release is
   * handed to a detached reaper that keeps waiting — it is never performed
   * anyway. Freeing an `AudioRecord` or `MediaCodec` under a live consumer is a
   * use-after-free in native code: an immediate SIGSEGV, not a catchable
   * exception, so a bounded leak is strictly the safer failure.
   */
  private fun releaseWhenQuiescent(
    rec: AudioRecord?,
    c: MediaCodec?,
    threads: List<Thread>,
    reason: String,
  ) {
    if (!released.compareAndSet(false, true)) {
      // The first caller owns the teardown AND the outcome. Publishing
      // anything here would let a second caller report completion while the
      // first one's reaper is still waiting.
      Log.i(TAG, "GC_P2_GATE audio_release_ignored already_released reason=$reason")
      return
    }
    running.set(false)
    try { rec?.stop() } catch (_: Throwable) { }   // unblocks a pending read()

    if (pcmQueue.isNotEmpty()) {
      Log.e(TAG, "GC_P2_GATE audio_release_with_pending_pcm entries=${pcmQueue.size}")
    }

    val stuck = threads.filter { !joinTerminated(it) }
    if (stuck.isEmpty()) {
      // The OUTCOME is whatever the release calls actually did, not the fact
      // that they were attempted.
      publishOutcome(releaseNative(rec, c, reason))
      return
    }

    Log.e(
      TAG,
      "GC_P2_GATE audio_release_DEFERRED reason=$reason " +
        "stuck=${stuck.joinToString(",") { it.name }} — nothing freed yet",
    )
    try {
      Thread({ reap(rec, c, stuck, reason) }, "gc-segrec-audio-reaper")
        .apply { isDaemon = true }
        .start()
    } catch (t: Throwable) {
      // Without a reaper nobody will ever confirm termination. Leaving the
      // outcome unpublished would hang the module's release for good, and
      // freeing here would be a use-after-free. Declare the leak.
      Log.e(
        TAG,
        "GC_P2_GATE audio_reaper_start_failed reason=$reason: ${t.message} — declaring leak",
      )
      publishOutcome(false)
    }
  }

  /** Waits for the stragglers, then frees — or gives up and leaks, reported. */
  private fun reap(rec: AudioRecord?, c: MediaCodec?, stuck: List<Thread>, reason: String) {
    val deadline = SystemClock.elapsedRealtime() + DEFERRED_JOIN_LIMIT_MS
    var alive = stuck
    while (alive.isNotEmpty() && SystemClock.elapsedRealtime() < deadline) {
      for (t in alive) {
        try {
          t.join(DEFERRED_JOIN_POLL_MS)
        } catch (ie: InterruptedException) {
          // Waiting ENDS here. Restoring the flag and spinning on would just
          // make every later `join` throw immediately, burning the whole
          // budget in a busy loop and still proving nothing. Termination was
          // not proven, so the only honest outcome is a leak.
          Thread.currentThread().interrupt()
          Log.e(
            TAG,
            "GC_P2_GATE audio_reaper_interrupted reason=$reason " +
              "stuck=${alive.joinToString(",") { it.name }} — declaring leak",
          )
          publishOutcome(false)
          return
        }
      }
      alive = alive.filter { it.isAlive }
    }
    if (alive.isEmpty()) {
      Log.i(TAG, "GC_P2_GATE audio_deferred_release_ran reason=$reason")
      publishOutcome(releaseNative(rec, c, reason))
      return
    }
    // DELIBERATE LEAK. Reported through the OUTCOME, not through `onError`:
    // the module is already `releasing`, so an error raised here would be
    // suppressed as a follow-on failure and the leak would survive only in
    // Logcat. `freed = false` is the channel the module cannot ignore.
    Log.e(
      TAG,
      "GC_P2_GATE audio_deferred_release_ABANDONED_LEAKING reason=$reason " +
        "stuck=${alive.joinToString(",") { it.name }}",
    )
    publishOutcome(false)
  }

  /**
   * @return true ONLY when every call that actually frees a handle returned
   * without throwing.
   *
   * `stop()` is deliberately NOT decisive: a codec that never started, or that
   * is already in an error state, throws there while the subsequent `release()`
   * still frees the handle correctly. Treating that as a leak would block the
   * module for a condition that is not one. (`AudioRecord.stop()` already ran
   * in [releaseWhenQuiescent], before any join, and is likewise not decisive.)
   *
   * `release()` throwing IS decisive — for the recorder and for the codec
   * alike. The handle's fate is then unknown, and an unknown handle must be
   * reported as retained: the microphone may still be held.
   */
  private fun releaseNative(rec: AudioRecord?, c: MediaCodec?, reason: String): Boolean {
    var freed = true

    try {
      rec?.release()
    } catch (t: Throwable) {
      freed = false
      Log.e(TAG, "GC_P2_GATE audio_record_release_threw reason=$reason: ${t.message}")
    }

    // Best-effort only.
    try {
      c?.stop()
    } catch (t: Throwable) {
      Log.w(TAG, "GC_P2_GATE audio_codec_stop_threw reason=$reason: ${t.message} (not decisive)")
    }

    try {
      c?.release()
    } catch (t: Throwable) {
      freed = false
      Log.e(TAG, "GC_P2_GATE audio_codec_release_threw reason=$reason: ${t.message}")
    }

    if (freed) {
      Log.i(TAG, "GC_P2_GATE audio_native_released reason=$reason")
    } else {
      Log.e(TAG, "GC_P2_GATE audio_native_release_UNCONFIRMED reason=$reason — declaring leak")
    }
    return freed
  }

  /**
   * @return true ONLY when [t] is provably finished. A self-join and an
   * interrupted join that left the thread alive both return false: neither
   * proves termination, and the caller must not free anything on that basis.
   */
  private fun joinTerminated(t: Thread): Boolean {
    if (t === Thread.currentThread()) {
      // The failing worker is running this teardown. It cannot outlive itself
      // here, so termination is unprovable from the inside.
      Log.w(TAG, "GC_P2_GATE self_join_deferred thread=${t.name}")
      return false
    }
    if (!t.isAlive) return true
    try {
      t.join(JOIN_TIMEOUT_MS)
    } catch (ie: InterruptedException) {
      Thread.currentThread().interrupt()
      Log.w(TAG, "GC_P2_GATE join_interrupted thread=${t.name} alive=${t.isAlive}")
      return !t.isAlive
    }
    if (t.isAlive) {
      Log.e(TAG, "GC_P2_GATE join_timeout thread=${t.name}")
      return false
    }
    return true
  }

  companion object {
    private const val TAG = "GCSegRec"
    private const val MIME = MediaFormat.MIMETYPE_AUDIO_AAC
    private const val DEQUEUE_TIMEOUT_US = 10_000L
    private const val ANCHOR_POLL_MS = 500L
    private const val JOIN_TIMEOUT_MS = 1_000L
    private const val DEFERRED_JOIN_POLL_MS = 200L
    private const val DEFERRED_JOIN_LIMIT_MS = 10_000L
  }
}
