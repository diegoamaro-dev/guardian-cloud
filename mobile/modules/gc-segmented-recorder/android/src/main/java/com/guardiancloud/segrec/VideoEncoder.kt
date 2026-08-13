package com.guardiancloud.segrec

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * SPIKE — P2 early gate. H.264 encoder with Surface input.
 *
 * The encoder NEVER stops during the session; only the muxer rotates. That is
 * what separates P2 from restarting a recording.
 *
 * PTS handling: the camera stamps buffers on the reference clock, so the raw
 * `presentationTimeUs` is NOT a session PTS. Every sample is converted through
 * [SessionClock.toSessionPtsUs] so video and audio reach the coordinator on the
 * SAME clock. Samples produced before `t0` exists are held in a bounded buffer
 * and flushed once it does — never dropped.
 *
 * LIFETIME CONTRACT (identical in [AudioEncoder]):
 *
 *  - `start()` and `release()` are mutually exclusive; the worker thread is
 *    published into its field BEFORE it is started, so a concurrent release can
 *    never miss a thread that is about to run.
 *  - Native resources are released in EXACTLY ONE place, and only once every
 *    thread that can still touch them has PROVABLY terminated. If a join does
 *    not prove that, the release is deferred — never performed anyway.
 *  - `release()` reports COMPLETION, not intent: its callback fires when the
 *    resources were actually freed, or when the deferred attempt gave up and
 *    the resources were deliberately leaked. Launching the reaper is not
 *    completion, and the caller must not treat it as such.
 */
class VideoEncoder(
  private val config: CaptureConfig,
  private val clock: SessionClock,
  private val characterisation: ClockCharacterisation,
  private val coordinator: SegmentCoordinator,
  private val onError: (String, String) -> Unit,
) {
  private class Raw(val data: ByteArray, val rawPtsNs: Long, val flags: Int, val key: Boolean)

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

  @Volatile private var codec: MediaCodec? = null
  @Volatile private var surface: Surface? = null
  @Volatile private var thread: Thread? = null

  /** Valid only after [start] returned true. */
  val inputSurface: Surface
    get() = surface ?: error("inputSurface read before a successful start()")

  private val running = AtomicBoolean(false)
  private val eosSeen = AtomicBoolean(false)
  private val seq = AtomicLong(0)

  // =====================================================================
  // Pre-t0 buffer
  //
  // Reached from TWO threads: `gc-segrec-video` via `emit`, and the main
  // thread via `pollClockResolution` (armed with `postDelayed`). Both used to
  // append to, iterate and clear a bare ArrayList with no synchronisation.
  //
  // One monitor now guards every field below, and it is held ONLY for list
  // bookkeeping — never across a call into SessionClock, SegmentCoordinator or
  // `onError`.
  // =====================================================================

  /**
   * OPEN     — samples accumulate; nobody is submitting.
   * DRAINING — one thread owns the drain and is submitting; new samples STILL
   *            go into the buffer, because passing them through would let them
   *            overtake the batch that thread is still writing out.
   * CLOSED   — everything ever retained has been submitted and nothing is in
   *            flight, so a new sample may go straight through in order.
   *
   * The transition OPEN → DRAINING → CLOSED happens exactly once.
   */
  private enum class PreT0State { OPEN, DRAINING, CLOSED }

  private val preT0Lock = Any()

  /** Arrival order. @GuardedBy(preT0Lock) */
  private val preT0 = ArrayList<Raw>()
  /** @GuardedBy(preT0Lock) */
  private var preT0Bytes = 0
  /** @GuardedBy(preT0Lock) */
  private var preT0State = PreT0State.OPEN
  /** @GuardedBy(preT0Lock) */
  private var firstFrameReported = false

  /**
   * Raw PTS of the FIRST sample ever retained, captured when it is appended
   * and never cleared by a drain.
   *
   * `t0` must be built from that sample, and reading it back out of the list
   * made the offer depend on the list still holding it — a drain that had
   * already run left `firstOrNull()` null and the offer silently never
   * happened.
   *
   * @GuardedBy(preT0Lock)
   */
  private var firstRetainedRawPtsNs: Long? = null

  /** Completes once the encoder has emitted BUFFER_FLAG_END_OF_STREAM. */
  @Volatile var onEosDrained: (() -> Unit)? = null

  var requestedFormatDescription: String = ""
    private set
  var actualFormatDescription: String = ""
    private set

  /**
   * Returns false on a synchronous failure so startup can abort at once.
   *
   * Fully transactional: `MediaFormat` construction is inside the try, so no
   * synchronous exception can escape. Local references are held from the
   * moment each resource exists, so any failure hands EXACTLY what was built to
   * the single release path — no half-constructed encoder and no orphan Surface
   * survive, and none of it is freed while the drain thread might still run.
   */
  fun start(): Boolean = synchronized(lifecycle) {
    if (released.get()) {
      onError(ErrorCode.ENCODER_FAILED, "video start() after release()")
      return false
    }

    var c: MediaCodec? = null
    var s: Surface? = null
    var th: Thread? = null
    var stage = "createVideoFormat"
    try {
      // Format FIRST: nothing native is held yet, so a throw here leaks nothing.
      //
      // DIAGNOSTIC ITERATION: the minimal Surface-input format only. KEY_PROFILE,
      // KEY_LATENCY and KEY_MAX_B_FRAMES are deliberately absent — on this run we
      // are isolating whether the previous `configure` failure (OMX_ErrorUndefined,
      // preceded by "Unsupported eColorFormat 0x7f000789") comes from an optional
      // key or from the encoder's Surface/metadata input path itself.
      //
      // Consequence while they are gone: B-frame absence is no longer REQUESTED.
      // It is still ENFORCED — the coordinator aborts on non-monotonic PTS with
      // VIDEO_PTS_REORDERING_DETECTED — so the invariant holds, it is just checked
      // at runtime instead of declared up front.
      val format = MediaFormat.createVideoFormat(MIME, config.width, config.height).apply {
        setInteger(
          MediaFormat.KEY_COLOR_FORMAT,
          MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
        )
        setInteger(MediaFormat.KEY_BIT_RATE, config.videoBitrate)
        setInteger(MediaFormat.KEY_FRAME_RATE, config.frameRate)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.iFrameIntervalS)
      }
      requestedFormatDescription = format.toString()
      Log.i(TAG, "GC_P2_GATE video_format_requested $requestedFormatDescription")

      stage = "createEncoderByType"
      c = MediaCodec.createEncoderByType(MIME)

      // Read what the selected codec actually declares, BEFORE configure() gets a
      // chance to fail. Purely observational and fully contained: a throw here is
      // swallowed, so the capability probe can never abort a startup that would
      // otherwise have succeeded.
      logCodecCapabilities(c, format)

      stage = "configure"
      c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      stage = "createInputSurface"
      s = c.createInputSurface()
      stage = "codecStart"
      c.start()

      codec = c
      surface = s
      running.set(true)

      // PUBLISH BEFORE START. Writing the field only after `start()` left a
      // window in which a concurrent release read `thread == null`, joined
      // nothing and freed the codec under a thread that was about to use it.
      stage = "drainThread"
      val codecRef = c
      th = Thread({ drainLoop(codecRef) }, "gc-segrec-video")
      thread = th
      th.start()
    } catch (t: Throwable) {
      // Single release path: it lowers the loop flag, proves the thread is
      // gone (or defers) and only then frees anything. The outcome it
      // publishes is what a later `release()` will observe.
      releaseWhenQuiescent(c, s, listOfNotNull(th), "failed_start:$stage")
      onError(ErrorCode.ENCODER_FAILED, "video encoder failed at $stage: ${t.message}")
      return false
    }
    return true
  }

  /**
   * DIAGNOSTIC — dumps what the selected encoder declares, before `configure()`.
   *
   * Answers, from the codec itself rather than from `media_codecs*.xml`:
   *   - which codec `createEncoderByType` actually picked;
   *   - every colour format it advertises, and whether COLOR_FormatSurface is
   *     among them — the XML says nothing about this;
   *   - its profile/level pairs;
   *   - `isFormatSupported` for BOTH the format that failed on the previous run
   *     and the minimal one being configured now.
   *
   * Never throws outward: any failure here is logged and swallowed, so this
   * cannot turn a working startup into a failed one.
   */
  private fun logCodecCapabilities(codec: MediaCodec, minimalFormat: MediaFormat) {
    try {
      val info = codec.codecInfo
      Log.i(TAG, "GC_P2_GATE codec_selected name=${info.name} isEncoder=${info.isEncoder}")

      val caps = info.getCapabilitiesForType(MIME)

      val colors = caps.colorFormats
      Log.i(
        TAG,
        "GC_P2_GATE codec_color_formats n=${colors.size} " +
          colors.joinToString(",") { String.format("0x%08X", it) },
      )

      val surfaceValue = MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
      val surfaceDeclared = colors.any { it == surfaceValue }
      Log.i(
        TAG,
        "GC_P2_GATE codec_surface_declared=$surfaceDeclared " +
          "COLOR_FormatSurface=" + String.format("0x%08X", surfaceValue),
      )

      val pls = caps.profileLevels
      Log.i(
        TAG,
        "GC_P2_GATE codec_profile_levels n=${pls.size} " +
          pls.joinToString(",") { "p=${it.profile}/l=${it.level}" },
      )

      // The exact format that produced OMX_ErrorUndefined on the previous run.
      // Built ONLY to be probed — it is never handed to configure().
      val previousFormat = MediaFormat.createVideoFormat(MIME, config.width, config.height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, surfaceValue)
        setInteger(MediaFormat.KEY_BIT_RATE, config.videoBitrate)
        setInteger(MediaFormat.KEY_FRAME_RATE, config.frameRate)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.iFrameIntervalS)
        setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
        setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
        setInteger(MediaFormat.KEY_LATENCY, 1)
      }

      // Probed SEPARATELY, each with its own guard: `isFormatSupported` can throw
      // on a key the framework dislikes, and a shared try would let one format's
      // failure erase the other's answer — which is the whole point of the probe.
      //
      // `supported=true` proves only that the FRAMEWORK precheck accepted the
      // format. It is not evidence that the vendor OMX accepts every key: the
      // precheck ignores keys it does not model, and which ones those are varies
      // by Android version. Only `configure()` is authoritative.
      logFormatSupport(caps, "previous", previousFormat)
      logFormatSupport(caps, "minimal", minimalFormat)
    } catch (t: Throwable) {
      Log.w(TAG, "GC_P2_GATE capability_probe_failed ${t.javaClass.name}: ${t.message}")
    }
  }

  /** One `isFormatSupported` call, one guarded answer, one line. */
  private fun logFormatSupport(
    caps: MediaCodecInfo.CodecCapabilities,
    label: String,
    format: MediaFormat,
  ) {
    val result = try {
      if (caps.isFormatSupported(format)) "supported=true" else "supported=false"
    } catch (t: Throwable) {
      "probe_error=${t.javaClass.name}: ${t.message}"
    }
    Log.i(TAG, "GC_P2_GATE format_probe label=$label $result")
  }

  /**
   * Ask for a sync frame. It is a REQUEST: the coordinator waits for a buffer
   * actually flagged as a keyframe, and that buffer opens the next muxer.
   */
  fun requestSyncFrame() {
    val c = codec ?: return
    try {
      c.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
      Log.i(TAG, "GC_P2_GATE sync_frame_requested")
    } catch (t: Throwable) {
      onError(ErrorCode.ENCODER_FAILED, "requestSyncFrame failed: ${t.message}")
    }
  }

  /**
   * The codec arrives as a PARAMETER, never read from the field: a release that
   * won the race has already nulled the field, and the guard below is what
   * makes a late-started thread return without touching anything.
   */
  private fun drainLoop(c: MediaCodec) {
    // A thread published-then-started can be joined (trivially, not yet alive)
    // by a release that ran in between. `running` is the flag that release
    // lowers first, so seeing it false here means: do not touch `c`.
    if (!running.get()) {
      Log.w(TAG, "GC_P2_GATE video_drain_start_skipped release_in_progress")
      return
    }

    val info = MediaCodec.BufferInfo()
    while (running.get()) {
      val index = try {
        c.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)
      } catch (t: Throwable) {
        onError(ErrorCode.ENCODER_FAILED, "video dequeue failed: ${t.message}")
        return
      }

      when {
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val actual = c.outputFormat
          actualFormatDescription = actual.toString()
          Log.i(TAG, "GC_P2_GATE video_format_actual $actualFormatDescription")
          coordinator.onVideoFormat(actual)
        }

        index >= 0 -> {
          val buf = c.getOutputBuffer(index)
          if (buf != null && info.size > 0) {
            // COPY before releasing. Retaining a MediaCodec output buffer
            // across a rotation would starve the encoder and stop it.
            val bytes = ByteArray(info.size)
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            buf.get(bytes)

            val isConfig = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
            val isKey = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
            if (!isConfig) {
              // Two SEPARATE series. The encoder PTS base is NOT assumed to be
              // BOOTTIME, nor identical to SENSOR_TIMESTAMP: the relation is
              // resolved empirically and the resolved offset is applied below.
              characterisation.onEncoderSample(info.presentationTimeUs)
              emit(Raw(bytes, info.presentationTimeUs * 1000L, info.flags, isKey))
            }
          }
          // Released immediately, always.
          try { c.releaseOutputBuffer(index, false) } catch (_: Throwable) { }

          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            advance()
            eosSeen.set(true)
            Log.i(TAG, "GC_P2_GATE video_eos_drained")
            onEosDrained?.invoke()
            return
          }
        }
      }
    }
  }

  /**
   * Holds until the encoder↔audio clock relation is RESOLVED and `t0` exists,
   * then converts and submits. Nothing is dropped.
   *
   * The resolved offset is what makes `rawPtsNs` comparable with audio: the
   * encoder base is not assumed to be BOOTTIME.
   */
  private fun emit(raw: Raw) {
    // OUTWARD call, deliberately before any monitor is taken: `tryResolve` can
    // invoke `onError`.
    if (!characterisation.ready()) {
      characterisation.tryResolve { msg ->
        onError(ErrorCode.CLOCK_ALIGNMENT_UNRESOLVED, msg)
      }
    }

    // The "is the buffer still taking samples?" test and the append are ONE
    // step. Split apart, a concurrent drain could close the buffer in between
    // and strand this sample in it for good.
    var passThrough = false
    var overflowed = false
    var entries = 0
    var bytes = 0
    synchronized(preT0Lock) {
      if (preT0State == PreT0State.CLOSED) {
        passThrough = true
      } else {
        preT0.add(raw)
        preT0Bytes += raw.data.size
        if (firstRetainedRawPtsNs == null) firstRetainedRawPtsNs = raw.rawPtsNs
        entries = preT0.size
        bytes = preT0Bytes
        overflowed = entries > Limits.PREROLL_MAX_ENTRIES || bytes > Limits.PREROLL_MAX_BYTES
      }
    }

    // Everything below is OUTWARD, with the monitor released.
    if (overflowed) {
      onError(
        ErrorCode.PREROLL_QUEUE_OVERFLOW,
        "video pre-t0 overflow entries=$entries bytes=$bytes",
      )
      return
    }
    if (passThrough) {
      // Nothing is in flight — CLOSED is only reached once the drain found the
      // buffer empty — so this cannot overtake an older sample.
      submit(raw)
      return
    }
    advance()
  }

  /**
   * Drives the pre-t0 buffer forward.
   *
   * Callable from the encoder drain thread and from the main thread's clock
   * poll; whichever arrives first does the work and the other observes it
   * already done.
   *
   * Both readiness predicates are read OUTSIDE the monitor. They are monotonic
   * latches, so a stale `false` only postpones work to the next call and a
   * `true` can never turn back into `false`.
   */
  private fun advance() {
    val resolved = characterisation.ready()

    // ---- phase 1: install t0 from the FIRST sample ever retained, once ----
    var firstNs: Long? = null
    var retained = 0
    if (resolved) {
      synchronized(preT0Lock) {
        if (!firstFrameReported) {
          val first = firstRetainedRawPtsNs
          if (first != null) {
            firstFrameReported = true
            firstNs = first
            retained = preT0.size
          }
        }
      }
    }
    val offerNs = firstNs
    if (offerNs != null) {
      val ns = toBoottimeNs(offerNs)
      clock.offerFirstVideoNs(ns)                       // OUTWARD
      Log.i(TAG, "GC_P2_GATE video_first_pts_ns=$ns retained=$retained")
    }

    // `t0` may only be read after the offer above had its chance.
    if (!resolved || !clock.t0Established()) return

    // ---- phase 2: exactly one thread ever wins OPEN -> DRAINING ----
    synchronized(preT0Lock) {
      if (preT0State != PreT0State.OPEN) return
      preT0State = PreT0State.DRAINING
    }
    drainRetained()
  }

  /**
   * Submits everything retained, in arrival order, then closes the buffer.
   *
   * Runs on whichever thread won OPEN → DRAINING. It re-enters the monitor
   * between batches because [emit] keeps appending while the drain is in
   * flight; only when it finds the buffer empty does it flip to CLOSED, and
   * from that instant new samples may pass straight through without overtaking
   * anything.
   *
   * Every batch is PROVED to yield non-negative session PTS before it is
   * submitted. A negative one means `t0` was built wrong; that is reported,
   * never hidden.
   */
  private fun drainRetained() {
    var total = 0
    var worstOverall = Long.MAX_VALUE
    while (true) {
      var batch: List<Raw> = emptyList()
      synchronized(preT0Lock) {
        if (preT0.isEmpty()) {
          preT0State = PreT0State.CLOSED
        } else {
          batch = ArrayList(preT0)          // arrival order preserved
          preT0.clear()
          preT0Bytes = 0
        }
      }
      if (batch.isEmpty()) break

      // OUTWARD from here: the monitor is released.
      var worst: Long = Long.MAX_VALUE
      for (p in batch) {
        val pts = clock.toSessionPtsUs(toBoottimeNs(p.rawPtsNs))
        if (pts < worst) worst = pts
      }
      if (worst < 0) {
        // Terminal. Close the buffer so later samples are not piled up behind
        // a drain that will never resume.
        synchronized(preT0Lock) {
          preT0State = PreT0State.CLOSED
          preT0.clear()
          preT0Bytes = 0
        }
        onError(
          ErrorCode.REBASE_NEGATIVE_PTS,
          "video pre-t0 drain would emit negative session PTS (min=${worst}us over " +
            "${batch.size} samples, $total already submitted); t0 was established " +
            "after captured frames",
        )
        return
      }
      if (worst < worstOverall) worstOverall = worst
      for (p in batch) submit(p)
      total += batch.size
    }
    if (total > 0) {
      Log.i(TAG, "GC_P2_GATE video_pre_t0_flushed n=$total min_session_pts_us=$worstOverall")
    }
  }

  /**
   * Lets the resolution deadline expire even when the encoder has stopped
   * delivering buffers — [emit] alone would never fire again.
   */
  fun pollClockResolution() {
    if (characterisation.ready()) return
    characterisation.tryResolve { msg -> onError(ErrorCode.CLOCK_ALIGNMENT_UNRESOLVED, msg) }
    advance()
  }

  private fun toBoottimeNs(encoderPtsNs: Long): Long =
    encoderPtsNs + characterisation.encoderToBoottimeOffsetNs

  private fun submit(raw: Raw) {
    coordinator.submit(
      QueuedSample(
        kind = TrackKind.VIDEO,
        data = raw.data,
        ptsUs = clock.toSessionPtsUs(toBoottimeNs(raw.rawPtsNs)),
        flags = raw.flags,
        isKeyFrame = raw.key,
        deliverySeq = seq.getAndIncrement(),
      ),
    )
  }

  /** Ordered stop: tell the encoder no more input is coming. */
  fun signalEndOfStream() {
    try {
      codec?.signalEndOfInputStream()
      Log.i(TAG, "GC_P2_GATE video_eos_signalled")
    } catch (t: Throwable) {
      onError(ErrorCode.ENCODER_FAILED, "signalEndOfInputStream failed: ${t.message}")
    }
  }

  fun eosDrained(): Boolean = eosSeen.get()

  /**
   * Hard teardown. Only after the EOS drain, or on terminal failure.
   *
   * @param onComplete invoked EXACTLY once, when the release has genuinely
   *   finished — on the caller's thread if the drain thread was already
   *   quiescent, otherwise on the reaper's. `freed = true` means every native
   *   resource was released; `freed = false` means the drain thread never
   *   terminated and the codec and Surface were DELIBERATELY LEAKED. The
   *   callback is never fired merely because a reaper was launched.
   */
  fun release(onComplete: (freed: Boolean) -> Unit) {
    // Registered BEFORE the teardown starts, so a fully synchronous release
    // cannot publish its outcome into an empty waiter list.
    awaitOutcome(onComplete)

    val c: MediaCodec?
    val s: Surface?
    val th: Thread?
    synchronized(lifecycle) {
      // The snapshot is taken and the fields cleared under the lock so nothing
      // else can reach these objects; the joins happen OUTSIDE it, so a worker
      // blocked on the module monitor can never deadlock against a release
      // that is holding this one.
      c = codec
      s = surface
      th = thread
      running.set(false)
      codec = null
      surface = null
      thread = null
    }
    releaseWhenQuiescent(c, s, listOfNotNull(th), "release")
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
   * The ONLY place video native resources are freed.
   *
   * Nothing is released until every thread that could still touch it has
   * PROVABLY terminated. If a join times out, is interrupted, or is a self-join
   * (the failing drain thread is the one running this teardown), the release is
   * handed to a detached reaper that keeps waiting — it is never performed
   * anyway. Freeing a `MediaCodec` or `Surface` under a live consumer is a
   * use-after-free in native code: an immediate SIGSEGV, not a catchable
   * exception, so a bounded leak is strictly the safer failure.
   */
  private fun releaseWhenQuiescent(
    c: MediaCodec?,
    s: Surface?,
    threads: List<Thread>,
    reason: String,
  ) {
    if (!released.compareAndSet(false, true)) {
      // The first caller owns the teardown AND the outcome. Publishing
      // anything here would let a second caller report completion while the
      // first one's reaper is still waiting.
      Log.i(TAG, "GC_P2_GATE video_release_ignored already_released reason=$reason")
      return
    }
    running.set(false)

    val stuck = threads.filter { !joinTerminated(it) }
    if (stuck.isEmpty()) {
      // The OUTCOME is whatever the release calls actually did, not the fact
      // that they were attempted.
      publishOutcome(releaseNative(c, s, reason))
      return
    }

    Log.e(
      TAG,
      "GC_P2_GATE video_release_DEFERRED reason=$reason " +
        "stuck=${stuck.joinToString(",") { it.name }} — nothing freed yet",
    )
    try {
      Thread({ reap(c, s, stuck, reason) }, "gc-segrec-video-reaper")
        .apply { isDaemon = true }
        .start()
    } catch (t: Throwable) {
      // Without a reaper nobody will ever confirm termination. Leaving the
      // outcome unpublished would hang the module's release for good, and
      // freeing here would be a use-after-free. Declare the leak.
      Log.e(
        TAG,
        "GC_P2_GATE video_reaper_start_failed reason=$reason: ${t.message} — declaring leak",
      )
      publishOutcome(false)
    }
  }

  /** Waits for the stragglers, then frees — or gives up and leaks, reported. */
  private fun reap(c: MediaCodec?, s: Surface?, stuck: List<Thread>, reason: String) {
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
            "GC_P2_GATE video_reaper_interrupted reason=$reason " +
              "stuck=${alive.joinToString(",") { it.name }} — declaring leak",
          )
          publishOutcome(false)
          return
        }
      }
      alive = alive.filter { it.isAlive }
    }
    if (alive.isEmpty()) {
      Log.i(TAG, "GC_P2_GATE video_deferred_release_ran reason=$reason")
      publishOutcome(releaseNative(c, s, reason))
      return
    }
    // DELIBERATE LEAK. Reported through the OUTCOME, not through `onError`:
    // the module is already `releasing`, so an error raised here would be
    // suppressed as a follow-on failure and the leak would survive only in
    // Logcat. `freed = false` is the channel the module cannot ignore.
    Log.e(
      TAG,
      "GC_P2_GATE video_deferred_release_ABANDONED_LEAKING reason=$reason " +
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
   * module for a condition that is not one.
   *
   * `release()` throwing IS decisive. The handle's fate is then unknown, and an
   * unknown handle must be reported as retained — never as freed.
   */
  private fun releaseNative(c: MediaCodec?, s: Surface?, reason: String): Boolean {
    var freed = true

    // The input Surface is released too: it is owned by this encoder and
    // leaking it would keep a camera output target alive after teardown.
    try {
      s?.release()
    } catch (t: Throwable) {
      freed = false
      Log.e(TAG, "GC_P2_GATE video_surface_release_threw reason=$reason: ${t.message}")
    }

    // Best-effort only.
    try {
      c?.stop()
    } catch (t: Throwable) {
      Log.w(TAG, "GC_P2_GATE video_codec_stop_threw reason=$reason: ${t.message} (not decisive)")
    }

    try {
      c?.release()
    } catch (t: Throwable) {
      freed = false
      Log.e(TAG, "GC_P2_GATE video_codec_release_threw reason=$reason: ${t.message}")
    }

    if (freed) {
      Log.i(TAG, "GC_P2_GATE video_native_released reason=$reason")
    } else {
      Log.e(TAG, "GC_P2_GATE video_native_release_UNCONFIRMED reason=$reason — declaring leak")
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
      // The failing drain thread is running this teardown. It cannot outlive
      // itself here, so termination is unprovable from the inside.
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
    private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
    private const val DEQUEUE_TIMEOUT_US = 10_000L
    private const val JOIN_TIMEOUT_MS = 1_000L
    private const val DEFERRED_JOIN_POLL_MS = 200L
    private const val DEFERRED_JOIN_LIMIT_MS = 10_000L
  }
}
