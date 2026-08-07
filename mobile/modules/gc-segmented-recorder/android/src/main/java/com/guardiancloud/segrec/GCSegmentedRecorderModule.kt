package com.guardiancloud.segrec

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * SPIKE — P2 early gate. JS-facing surface.
 *
 * Deliberately tiny. JavaScript starts, stops, shows state and receives closed
 * segment paths. It does NOT decide when to rotate, does not hash, does not
 * queue, does not upload. All policy lives in Kotlin.
 *
 * No integration with GC_QUEUE, the upload worker, retry, recovery, export or
 * the backend — none of those are referenced from this module.
 */
class GCSegmentedRecorderModule : Module() {

  private var camera: CameraSessionController? = null
  private var video: VideoEncoder? = null
  private var audio: AudioEncoder? = null
  private var coordinator: SegmentCoordinator? = null
  private var clock: SessionClock? = null
  private var characterisation: ClockCharacterisation? = null
  private var view: GCSegmentedCameraView? = null

  private val main = Handler(Looper.getMainLooper())
  private var sessionId: String = ""

  /**
   * Harness rotation scheduling — DIAGNOSTIC ONLY.
   *
   * `activeConfig` is the config the running session was accepted with, so a
   * chained rotation reads the same interval the session started with even if a
   * later start proposed a different one.
   *
   * `pendingRotation` holds the single armed runnable. Exactly one rotation is
   * ever pending: the first is armed on camera-open, and every later one is
   * armed from `onSegmentClosed`, which only fires once the previous rotation
   * has produced a closed, stability-verified segment. There is therefore no
   * path on which two rotations are in flight, and no timer keeps firing into a
   * session that stopped responding.
   */
  private var activeConfig: CaptureConfig = CaptureConfig()
  private var pendingRotation: Runnable? = null
  private var rotationsRequested = 0

  /** Ordered-close guards, reset on every valid start. */
  private var stopping = false
  private var eosSettled = false

  /**
   * True from the moment a teardown begins until the session has been
   * FINALISED — which now means both encoders confirmed their release, not
   * merely that a teardown was requested.
   */
  private var releasing = false

  /**
   * Set once a session ends with native resources deliberately leaked because
   * an encoder thread never terminated.
   *
   * Terminal for the whole module: the microphone, codec or input Surface are
   * demonstrably still held, so no further capture may be started in this
   * process. Never cleared.
   */
  @Volatile private var leakedSessionId: String? = null

  /**
   * Session generation. Every `postDelayed`, EOS callback and release callback
   * captures the value current at arming time and does nothing if it no longer
   * matches — so a callback from session N can never stop, release or emit
   * events under session N+1's `sessionId`.
   */
  private val sessionGen = AtomicLong(0)

  /**
   * Highest generation for which a failure has been REPORTED but whose
   * [emitError] may not have run yet.
   *
   * This latch exists because [startCapture] holds the monitor for its whole
   * body. A worker thread that fails milliseconds after being started calls
   * [reportError] on ITS OWN thread and then blocks on that monitor — so
   * `releasing` is still false, and `startCapture` would happily go on to build
   * the next resource on top of an encoder that is already dead.
   *
   * Written OUTSIDE the monitor, before the blocking call, so the holder of the
   * monitor can see it. That is the whole point: it is the only failure signal
   * that does not require acquiring the lock the reporter is waiting for.
   *
   * MONOTONIC. A plain `set()` was last-write-wins, so a straggler from an old
   * generation A, unblocking after B had already been latched, would lower the
   * latch back to A and erase B's failure — exactly when B is mid-start and
   * about to build its next resource. [raiseFailureLatch] therefore only ever
   * moves the value UP; the only downward writes are the session-boundary
   * resets, which run under the monitor and can only discard generations that
   * are already stale.
   */
  private val asyncFailureGen = AtomicLong(NO_GEN)

  /** True between a successful start and the release of that same session. */
  @Volatile private var sessionActive = false

  private fun genValid(gen: Long): Boolean = gen == sessionGen.get()

  /**
   * Operational guard: the generation must match AND the session must still be
   * live. `sessionActive` is cleared and the generation bumped the moment
   * release completes, so a timer armed by session A cannot act in the gap
   * before session B starts either.
   */
  private fun genActive(gen: Long): Boolean = gen == sessionGen.get() && sessionActive

  override fun definition() = ModuleDefinition {
    Name("GCSegmentedRecorder")

    Events("onSegmentClosed", "onCaptureError", "onCaptureReleased", "onStateChanged")

    View(GCSegmentedCameraView::class) {
      OnViewDidUpdateProps { v -> setPreviewView(v) }
    }

    // `sessionId` is NOT touched here: the identity only changes once the
    // start has been accepted. Assigning it up front let a rejected second
    // start overwrite the running session's identifier.
    /**
     * `options` is a DIAGNOSTIC-ONLY harness override, reachable in practice
     * only from `/debug-p2-gate`, which is itself dead code in a release
     * bundle. Passing null — what every other caller does — reproduces the
     * historical 7 s / one-rotation session exactly.
     */
    AsyncFunction("startSegmentedCapture") { id: String, options: Map<String, Any?>? ->
      startCapture(id, options)
    }

    AsyncFunction("stopSegmentedCapture") {
      stopCapture()
    }

    /**
     * EXPLICIT DIAGNOSTIC EXCEPTION to the generation/monitor discipline.
     *
     * Reads the current coordinator's state without taking the lock and
     * without a generation token. It is safe precisely because it only READS
     * and never acts on behalf of a session: the worst outcome is reporting a
     * state one instant stale, which is what a diagnostic is for. Every other
     * path that touches a field is synchronized and generation-bound.
     */
    Function("getState") {
      coordinator?.state?.name ?: GateState.IDLE.name
    }

    OnDestroy { stopCapture() }
  }

  /**
   * `view` is written from the Expo view thread and read by `startCapture` on
   * the JS thread. Writing it under the common monitor gives that read a
   * happens-before edge; a plain field write had no visibility guarantee.
   */
  @Synchronized
  private fun setPreviewView(v: GCSegmentedCameraView) {
    view = v
  }

  private fun outputDir(): File {
    val base = appContext.reactContext?.cacheDir ?: error("no cache dir")
    return File(base, "gc-p2-gate").also { it.mkdirs() }
  }

  /**
   * Builds the capture config from a diagnostic override map.
   *
   * Returns null and REJECTS the start on any invalid value rather than
   * clamping: a harness run whose parameters were silently altered produces
   * evidence that does not match what the operator asked for, which is worse
   * than not running at all.
   */
  private fun harnessConfig(id: String, options: Map<String, Any?>?): CaptureConfig? {
    val base = CaptureConfig()
    if (options == null) return base

    fun longOf(key: String, fallback: Long): Long? = when (val v = options[key]) {
      null -> fallback
      is Number -> v.toLong()
      else -> null
    }

    val rotateAt = longOf("rotateAtMs", base.rotateAtMs)
    val interval = longOf("rotationIntervalMs", base.rotationIntervalMs)
    val session = longOf("sessionMs", base.sessionMs)

    fun reject(msg: String): CaptureConfig? {
      rejectStart(id, ErrorCode.INVALID_STATE, "invalid harness options: $msg")
      return null
    }

    if (rotateAt == null || interval == null || session == null) {
      return reject("rotateAtMs, rotationIntervalMs and sessionMs must be numbers")
    }
    if (rotateAt < HarnessBounds.MIN_ROTATE_AT_MS || rotateAt > HarnessBounds.MAX_ROTATE_AT_MS) {
      return reject(
        "rotateAtMs=$rotateAt outside " +
          "[${HarnessBounds.MIN_ROTATE_AT_MS}, ${HarnessBounds.MAX_ROTATE_AT_MS}]",
      )
    }
    // 0 is the historical "single rotation" value and stays legal.
    if (interval != 0L &&
      (interval < HarnessBounds.MIN_ROTATION_INTERVAL_MS ||
        interval > HarnessBounds.MAX_ROTATION_INTERVAL_MS)
    ) {
      return reject(
        "rotationIntervalMs=$interval must be 0 or within " +
          "[${HarnessBounds.MIN_ROTATION_INTERVAL_MS}, " +
          "${HarnessBounds.MAX_ROTATION_INTERVAL_MS}]",
      )
    }
    if (session < HarnessBounds.MIN_SESSION_MS || session > HarnessBounds.MAX_SESSION_MS) {
      return reject(
        "sessionMs=$session outside " +
          "[${HarnessBounds.MIN_SESSION_MS}, ${HarnessBounds.MAX_SESSION_MS}]",
      )
    }
    // Without a tail after the first rotation the session would stop mid-cut and
    // never produce the second segment the operator asked for.
    if (session - rotateAt < HarnessBounds.MIN_TAIL_AFTER_FIRST_ROTATION_MS) {
      return reject(
        "sessionMs=$session must exceed rotateAtMs=$rotateAt by at least " +
          "${HarnessBounds.MIN_TAIL_AFTER_FIRST_ROTATION_MS}ms",
      )
    }

    return base.copy(
      rotateAtMs = rotateAt,
      rotationIntervalMs = interval,
      sessionMs = session,
    )
  }

  /**
   * Arms THE rotation. Any previously armed one is removed first, so the
   * invariant "at most one pending rotation" holds even if this were ever
   * called twice for the same generation.
   */
  private fun scheduleRotation(gen: Long, delayMs: Long) {
    cancelPendingRotation()
    val r = Runnable {
      if (!genActive(gen)) return@Runnable
      val v = video ?: return@Runnable
      val c = coordinator ?: return@Runnable
      rotationsRequested++
      Log.i(
        TAG,
        "GC_P2_GATE harness_rotation_requested n=$rotationsRequested " +
          "delay_ms=$delayMs gen=$gen mono_ns=${SystemClock.elapsedRealtimeNanos()}",
      )
      v.requestSyncFrame()
      c.requestRotation()
    }
    pendingRotation = r
    main.postDelayed(r, delayMs)
  }

  /** Safe cancellation: used on stop, on failure and on release. */
  private fun cancelPendingRotation() {
    pendingRotation?.let { main.removeCallbacks(it) }
    pendingRotation = null
  }

  @Synchronized
  private fun startCapture(id: String, options: Map<String, Any?>? = null) {
    // TERMINAL GATE. A previous session ended holding native resources it
    // could not safely free. Starting again would stack a second AudioRecord
    // or codec on top of the leaked ones.
    val leaked = leakedSessionId
    if (leaked != null) {
      rejectStart(
        id,
        ErrorCode.ENCODER_FAILED,
        "session $leaked ended with encoder resources DELIBERATELY LEAKED: its " +
          "worker threads never terminated, so the microphone, codec or input " +
          "Surface are still held. This module refuses to start another capture " +
          "until the process is restarted.",
      )
      return
    }

    // A second start while a session is alive is rejected NON-TERMINALLY: it
    // reports the refusal and leaves the running session completely untouched
    // — camera, encoders, coordinator and `sessionId` all unchanged. Routing
    // this through `emitError` would have torn down the active capture.
    //
    // `releasing` is a DISTINCT refusal: session A is past its stop but its
    // encoders have not confirmed that their threads died, so nothing has been
    // freed yet. Starting B here would open a second microphone against the
    // first one's live capture thread.
    if (sessionActive) {
      val reason =
        if (releasing) {
          "session $sessionId is still releasing: its encoder threads have not " +
            "confirmed termination, so no native resource has been freed yet"
        } else {
          "capture already active (session=$sessionId); stop it before starting another"
        }
      rejectStart(
        id,
        ErrorCode.INVALID_STATE,
        "$reason. The running session was not affected.",
      )
      return
    }
    // Happens BEFORE any generation is accepted, so the terminal `emitError`
    // must not be used: it would finalise a session that was never started and
    // report under the PREVIOUS session's identity.
    val v = view ?: run {
      rejectStart(id, ErrorCode.SURFACE_LOST, "preview view not mounted")
      return
    }

    // Fresh generation and clean guards. Any callback still armed from the
    // previous session now fails its `genValid` check and does nothing.
    val gen = sessionGen.incrementAndGet()
    stopping = false
    eosSettled = false
    releasing = false
    // Safe downward write: held under the monitor, and every generation below
    // `gen` is by definition already finalised.
    asyncFailureGen.set(NO_GEN)
    sessionActive = true
    sessionId = id

    // Validated BEFORE any resource is built. On rejection the start is refused
    // and nothing has been allocated.
    val config = harnessConfig(id, options) ?: run {
      sessionActive = false
      sessionId = ""
      return
    }
    activeConfig = config
    cancelPendingRotation()
    rotationsRequested = 0
    Log.i(
      TAG,
      "GC_P2_GATE harness_config rotate_at_ms=${config.rotateAtMs} " +
        "rotation_interval_ms=${config.rotationIntervalMs} session_ms=${config.sessionMs}",
    )
    val dir = outputDir()
    dir.listFiles()?.forEach { it.delete() }

    // The characterisation must know the timestamp source, and the source is
    // only known after the camera is resolved. Resolve first with a temporary
    // controller, then build the real objects — no throwaway sink receives
    // real samples.
    val probe = CameraSessionController(
      appContext.reactContext!!, ClockCharacterisation(NO_SOURCE),
    ) { code, msg -> reportError(gen, code, msg) }
    val cameraId = probe.resolveCamera() ?: run {
      probe.close()
      // No manual `sessionActive = false` here: `emitError` routes into
      // `finalizeSession`, the single atomic place where ownership ends.
      reportError(gen, ErrorCode.CAMERA_OPEN_FAILED, "no camera available"); return
    }
    val source = probe.timestampSource
    probe.close()

    val ch = ClockCharacterisation(source)
    val ck = SessionClock(source)
    val cam = CameraSessionController(appContext.reactContext!!, ch) { code, msg ->
      reportError(gen, code, msg)
    }
    cam.resolveCamera()
    characterisation = ch
    clock = ck
    camera = cam

    Log.i(
      TAG,
      "GC_P2_GATE session_start id=$id alignment_quality=${ck.alignmentQuality} " +
        "audio_timebase=${ck.audioTimebase} mono_ns=${SystemClock.elapsedRealtimeNanos()}",
    )

    val coord = SegmentCoordinator(
      outputDir = dir,
      config = config,
      // `m` is an immutable frozen snapshot — two segment events never share
      // one mutable object.
      // The generation is checked SYNCHRONOUSLY, on the coordinator thread,
      // before anything is posted. Checking it inside the posted runnable was
      // a race: the coordinator calls this and then `maybeFinishRelease()`,
      // which can complete the release and bump the generation before the
      // runnable ever executes — silently dropping the last segment event.
      //
      // Once accepted here, the event is published unconditionally. Ordering is
      // guaranteed by the main Handler's FIFO: this post happens before the
      // one carrying `onCaptureReleased`.
      onSegmentClosed = segmentClosed@{ m, file ->
        if (!genValid(gen)) return@segmentClosed
        // Immutable snapshot captured HERE; the posted runnable touches no
        // field that a later session could have replaced.
        val path = file.absolutePath
        val size = file.length()
        main.post {
          sendEvent(
            "onSegmentClosed",
            mapOf(
              "sessionId" to id,
              "segmentIndex" to m.segmentIndex,
              "path" to path,
              "sizeBytes" to size,
              "originUs" to m.originUs,
              "cutPtsUs" to m.cutPtsUs,
              "audioTailUs" to m.audioTailUs,
              "audioLeadUs" to m.audioLeadUs,
              "keyframeWaitMs" to m.keyframeWaitMs,
              "audioWatermarkWaitMs" to m.audioWatermarkWaitMs,
              "muxerStopMs" to m.muxerStopMs,
              "queuePeakEntries" to m.queuePeakEntries,
              "queuePeakBytes" to m.queuePeakBytes,
              "audioFramesDropped" to m.audioFramesDropped,
              "audioFramesDuplicated" to m.audioFramesDuplicated,
              "videoFramesDropped" to m.videoFramesDropped,
              "rebaseNegativeCount" to m.rebaseNegativeCount,
              "videoStartOffsetUs" to m.videoStartOffsetUs,
              "videoSamples" to m.videoSamples,
              "audioSamples" to m.audioSamples,
            ),
          )
          // Chain the next rotation HERE and nowhere else. Reaching this point
          // means the previous rotation produced a segment that closed and
          // passed its stability check, which is the only evidence available
          // that it finished correctly. Scheduling from a free-running timer
          // instead would let a second rotation be armed while the first was
          // still draining its muxer.
          //
          // `genActive` is re-tested inside the post because the session may
          // have been stopped between the coordinator emitting and this
          // running; `stopping` is tested so a segment closing during teardown
          // does not arm a rotation nobody will service.
          val interval = activeConfig.rotationIntervalMs
          if (interval > 0L && genActive(gen) && !stopping && !releasing) {
            scheduleRotation(gen, interval)
          }
        }
      },
      onFailure = { code, msg -> reportError(gen, code, msg) },
    )
    coordinator = coord
    coord.markStarting()

    ch.begin()

    // Transactional startup: each resource is registered in the field BEFORE
    // it can fire a callback, and a synchronous failure aborts the rest
    // immediately — no camera is opened on top of a dead encoder.
    val vid = VideoEncoder(config, ck, ch, coord) { c, m -> reportError(gen, c, m) }
    vid.onEosDrained = { if (genActive(gen)) onEncoderEos(gen) }
    video = vid
    if (!vid.start()) {
      abortStart(gen, "video_encoder")
      return
    }

    // THE WINDOW BETWEEN VIDEO AND AUDIO.
    //
    // `vid.start()` returning true only means the drain thread was created and
    // started. That thread is ALREADY RUNNING and may have failed before we got
    // here — and its `emitError` is blocked on this very monitor, so
    // `releasing` cannot yet be true. Building an `AudioEncoder` on that basis
    // would open the microphone for a session that is already dead, and only
    // close it after the fact.
    //
    // The re-check is atomic with respect to a competing start because we still
    // hold the monitor, and it consults the latch, which is the one signal a
    // blocked reporter can raise without the lock.
    if (!startStillValid(gen, "post_video_encoder")) return

    val aud = AudioEncoder(config, ck, coord) { c, m -> reportError(gen, c, m) }
    aud.onEosDrained = { if (genActive(gen)) onEncoderEos(gen) }
    audio = aud
    if (!aud.start()) {
      abortStart(gen, "audio_encoder")
      return
    }

    // Same re-check before the camera is opened, for the same reason.
    if (!startStillValid(gen, "post_encoders")) return

    // Clock-resolution deadline INDEPENDENT of new buffers arriving: if the
    // encoder stops delivering, `emit()` never runs again and the deadline
    // would never fire on its own.
    main.postDelayed({
      if (genActive(gen)) vid.pollClockResolution()
    }, Limits.CLOCK_RESOLVE_LIMIT_MS + 100)

    v.onSurfaceLost = { if (genActive(gen)) beginOrderedStop(gen) }
    cam.open(cameraId, v.surfaceView.holder.surface, vid.inputSurface) {
      if (!genActive(gen)) return@open
      // Rotation is requested by the module, never by JavaScript. Later
      // rotations are chained from `onSegmentClosed`, not armed here.
      scheduleRotation(gen, config.rotateAtMs)
      main.postDelayed({ if (genActive(gen)) beginOrderedStop(gen) }, config.sessionMs)
    }
  }

  /**
   * Is it still legitimate to build the NEXT resource for `gen`?
   *
   * Called only from [startCapture], which holds the monitor, so all four
   * conditions are read atomically with respect to any other synchronized path.
   *
   * The latch test is `>= gen`, not `== gen`: a latch ABOVE our generation
   * means a newer session has already failed, which can only happen if ours is
   * stale — so it is never safe to keep building either way.
   *
   * Returning false does NOT tear anything down: either a synchronous
   * `emitError` already did, or a reporter is blocked on the monitor and will
   * do it the instant [startCapture] returns. Releasing here as well would be a
   * double teardown.
   */
  private fun startStillValid(gen: Long, stage: String): Boolean {
    val latch = asyncFailureGen.get()
    val failed = latch >= gen
    if (genActive(gen) && !releasing && !failed) return true
    Log.w(
      TAG,
      "GC_P2_GATE start_aborted stage=$stage gen=$gen current=${sessionGen.get()} " +
        "active=$sessionActive releasing=$releasing failure_latch=$latch " +
        "— teardown is owned by the reporter, nothing built from here on",
    )
    return false
  }

  /**
   * Raises the failure latch MONOTONICALLY.
   *
   * `set()` would be last-write-wins: a straggler from generation A, blocked on
   * the monitor since before B existed, would lower the latch from B back to A
   * and silently clear B's failure. Only an upward move is ever applied, so an
   * old report can never mask a newer one.
   */
  private fun raiseFailureLatch(gen: Long) {
    asyncFailureGen.updateAndGet { current -> if (gen > current) gen else current }
  }

  /**
   * The entry point for EVERY failure reported by a component.
   *
   * The latch is raised BEFORE [emitError] is called, and deliberately outside
   * the monitor: a worker thread reporting mid-start will block on the monitor
   * that [startCapture] is holding, and the latch is what lets the holder see
   * the failure without waiting for the reporter.
   */
  private fun reportError(gen: Long, code: String, message: String) {
    raiseFailureLatch(gen)
    emitError(gen, code, message)
  }

  // =====================================================================
  // Ordered close protocol
  // =====================================================================

  /**
   * Phase 1 — stop production in order, then signal EOS to both encoders.
   * Nothing is torn down here: samples keep flowing into the open muxer while
   * the encoders flush.
   */
  @Synchronized
  private fun beginOrderedStop(gen: Long) {
    if (!genValid(gen) || !sessionActive || releasing || stopping) return
    stopping = true
    // No further rotation may be armed once the close has begun, and any
    // rotation already armed is dropped rather than left to be filtered by its
    // generation check.
    cancelPendingRotation()
    Log.i(
      TAG,
      "GC_P2_GATE close_phase=1 stop_production_and_signal_eos gen=$gen " +
        "rotations_requested=$rotationsRequested",
    )

    // Captured under the lock: the deadline below must reason about THESE
    // encoders, never whichever objects the fields hold when it fires.
    val cam = camera
    val coord = coordinator
    val vid = video
    val aud = audio

    cam?.close()             // no new frames into the encoder surface
    coord?.beginStopping()
    vid?.signalEndOfStream()
    aud?.signalEndOfStream()

    // Phase 2 has a deadline: an encoder that never emits EOS must not hang
    // the session silently. The whole decision runs under the monitor — see
    // `onEosDeadline`.
    main.postDelayed({ onEosDeadline(gen, vid, aud) }, Limits.EOS_DRAIN_LIMIT_MS)
  }

  /**
   * EOS deadline, evaluated atomically.
   *
   * Nothing is read from the `postDelayed` body: between such a read and the
   * call into `emitError` the session can settle, be released and be replaced.
   * Ownership, liveness and `!releasing` are checked here under the common
   * monitor, then the encoders captured at arm time are asked the only
   * question this deadline is about — did they drain their EOS?
   */
  @Synchronized
  private fun onEosDeadline(gen: Long, vid: VideoEncoder?, aud: AudioEncoder?) {
    if (!genValid(gen) || !sessionActive || releasing) {
      Log.i(
        TAG,
        "GC_P2_GATE eos_deadline_ignored gen=$gen current=${sessionGen.get()} " +
          "active=$sessionActive releasing=$releasing",
      )
      return
    }

    // This deadline measures ONE thing: did both encoders drain their EOS?
    //
    // `eosSettled` is NOT that question — it also covers the coordinator's
    // later intake drain, so using it here would let a slow-but-healthy close
    // look like an encoder timeout. The timeout therefore stays independent of
    // `waitForIntakeThenClose()`: if the encoders finished, the deadline is
    // irrelevant no matter how long the rest of the close takes.
    val videoDone = vid?.eosDrained() ?: true
    val audioDone = aud?.eosDrained() ?: true
    if (videoDone && audioDone) {
      Log.i(TAG, "GC_P2_GATE eos_deadline_moot both_encoders_drained gen=$gen")
      return
    }

    emitError(
      gen,
      ErrorCode.EOS_DRAIN_TIMEOUT,
      "encoders did not drain EOS within ${Limits.EOS_DRAIN_LIMIT_MS}ms " +
        "(video=$videoDone audio=$audioDone)",
    )
  }

  /** Phase 2 — both encoders drained; wait for the intake to empty. */
  @Synchronized
  private fun onEncoderEos(gen: Long) {
    if (!genValid(gen) || !sessionActive || releasing) return
    val v = video ?: return
    val a = audio ?: return
    if (!v.eosDrained() || !a.eosDrained()) return
    Log.i(TAG, "GC_P2_GATE close_phase=2 both_encoders_drained gen=$gen")
    waitForIntakeThenClose(gen, 0)
  }

  /**
   * Phase 3 — every copied sample has been consumed by the coordinator, so the
   * last muxer can close. Polled off the coordinator thread; the coordinator
   * is never blocked.
   */
  @Synchronized
  private fun waitForIntakeThenClose(gen: Long, attempt: Int) {
    // Ownership is verified INSIDE the monitor and the coordinator captured
    // here. Checking `genValid` and then reading the `coordinator` field was a
    // check-then-act race: a stale poll from A could pick up B's instance and
    // drive B's close protocol.
    if (!genValid(gen) || !sessionActive || releasing) {
      Log.w(
        TAG,
        "GC_P2_GATE intake_poll_ignored gen=$gen current=${sessionGen.get()} " +
          "active=$sessionActive releasing=$releasing",
      )
      return
    }
    val coord = coordinator ?: return

    if (!coord.intakeDrained() && attempt < INTAKE_DRAIN_ATTEMPTS) {
      main.postDelayed({ waitForIntakeThenClose(gen, attempt + 1) }, INTAKE_DRAIN_POLL_MS)
      return
    }
    if (!coord.intakeDrained()) {
      emitError(gen, ErrorCode.EOS_DRAIN_TIMEOUT, "intake never drained before close")
      return
    }
    // Still the owner: safe to mutate the guards and drive THIS coordinator.
    eosSettled = true
    Log.i(TAG, "GC_P2_GATE close_phase=3 intake_drained_closing_last_muxer gen=$gen")
    coord.onEosComplete()
    finishRelease(gen)
  }

  /**
   * Phase 4 — release. The coordinator stays alive until every pending
   * stability check has resolved, so `onCaptureReleased` is only reported once
   * all `onSegmentClosed` events (or a terminal failure) have been emitted.
   */
  @Synchronized
  private fun finishRelease(gen: Long) {
    if (!genValid(gen) || releasing) return
    releasing = true

    // LOCAL references for this generation. The release callback must not read
    // the fields, which a later session could already have replaced.
    val ch = characterisation
    val coord = coordinator
    val vid = video
    val aud = audio
    val cam = camera
    val closingSessionId = sessionId

    val complete = {
      cam?.close()
      ch?.let {
        it.logSeriesHead()
        Log.i(TAG, "GC_P2_GATE clock_characterisation ${it.report()}")
      }
      Log.i(
        TAG,
        "GC_P2_GATE video_requested=${vid?.requestedFormatDescription} " +
          "video_actual=${vid?.actualFormatDescription} " +
          "audio_requested=${aud?.requestedFormatDescription}",
      )
      awaitEncoderRelease(gen, vid, aud, closingSessionId)
    }
    coord?.release { complete() } ?: complete()
  }

  /**
   * Releases both encoders and finalises the session ONLY once both have
   * genuinely finished.
   *
   * Launching a reaper is NOT completion. Until every encoder reports its
   * outcome, `releasing` and `sessionActive` stay set, so [startCapture]
   * refuses a new session and no `onCaptureReleased` is published — the
   * previous session may still own a live thread and unfreed native handles.
   *
   * The callbacks can arrive on a reaper thread; [finalizeSession] takes the
   * module monitor, which is why the encoders invoke waiters outside their own
   * locks.
   */
  private fun awaitEncoderRelease(
    gen: Long,
    vid: VideoEncoder?,
    aud: AudioEncoder?,
    closingSessionId: String,
  ) {
    val pending = AtomicInteger(2)
    val videoLeaked = AtomicBoolean(false)
    val audioLeaked = AtomicBoolean(false)

    val settle = {
      if (pending.decrementAndGet() == 0) {
        val leaks = ArrayList<String>()
        if (videoLeaked.get()) leaks.add("video")
        if (audioLeaked.get()) leaks.add("audio")
        finalizeSession(gen, closingSessionId, leaks)
      }
    }

    Log.i(TAG, "GC_P2_GATE awaiting_encoder_release gen=$gen id=$closingSessionId")

    if (vid != null) {
      vid.release { freed ->
        if (!freed) videoLeaked.set(true)
        Log.i(TAG, "GC_P2_GATE video_release_outcome freed=$freed gen=$gen")
        settle()
      }
    } else {
      settle()
    }

    if (aud != null) {
      aud.release { freed ->
        if (!freed) audioLeaked.set(true)
        Log.i(TAG, "GC_P2_GATE audio_release_outcome freed=$freed gen=$gen")
        settle()
      }
    } else {
      settle()
    }
  }

  /**
   * THE single place where a session's ownership ends — normal or terminal.
   *
   * Reached ONLY from [awaitEncoderRelease], i.e. only after both encoders have
   * reported a real outcome.
   *
   * `@Synchronized` on the same monitor as [startCapture], so a new start
   * cannot interleave with any part of this: the whole sequence
   * (verify ownership → clear fields → invalidate generation → drop
   * `sessionActive`) is atomic with respect to it.
   *
   * Order matters. `sessionActive = false` comes LAST: if it were cleared
   * first, a `startCapture` could slip in while this generation still owned
   * the fields, and this method would then wipe the NEW session's state.
   *
   * @param leaks components whose native resources could NOT be freed. A
   *   non-empty list is a terminal condition for the module: it is reported to
   *   JS as an error AND as `resourcesFreed = false`, never as a clean release.
   */
  @Synchronized
  private fun finalizeSession(gen: Long, closingSessionId: String, leaks: List<String>) {
    if (!genValid(gen)) {
      Log.w(TAG, "GC_P2_GATE finalize_ignored stale gen=$gen current=${sessionGen.get()}")
      return
    }
    // Drop any armed rotation before the objects it would touch are cleared.
    // The generation guard would already neutralise it, but leaving a runnable
    // queued against a released session is exactly the kind of state this
    // module refuses to keep.
    cancelPendingRotation()

    coordinator = null
    video = null
    audio = null
    camera = null
    characterisation = null
    clock = null

    // Invalidate the owning generation FIRST. Clearing `releasing` before this
    // would leave a window — inside the lock, but observable to any reentrant
    // path — where an old callback's `gen` still matched while the guards said
    // "idle", making it look operational.
    sessionGen.incrementAndGet()

    stopping = false
    eosSettled = false
    releasing = false
    // Safe downward write: under the monitor, and `gen` is now stale.
    asyncFailureGen.set(NO_GEN)

    if (leaks.isEmpty()) {
      // LAST: only now may a new start proceed.
      sessionActive = false
      Log.i(
        TAG,
        "GC_P2_GATE session_released gen=$gen id=$closingSessionId resources_freed=true " +
          "mono_ns=${SystemClock.elapsedRealtimeNanos()}",
      )
      main.post {
        sendEvent(
          "onCaptureReleased",
          mapOf(
            "sessionId" to closingSessionId,
            "resourcesFreed" to true,
            "leaked" to emptyList<String>(),
          ),
        )
      }
      return
    }

    // TERMINAL. The session is over, but its native resources are still held.
    // This is not a successful release and must never read as one: it reaches
    // JS as an error first, then as an explicitly unclean `onCaptureReleased`,
    // and it permanently bars a new capture in this process.
    leakedSessionId = closingSessionId
    sessionActive = false
    // The deferred-wait budget lives in each encoder and is reported by them in
    // Logcat; it is deliberately NOT quoted here rather than quoted wrongly.
    val detail =
      "session $closingSessionId ended WITHOUT freeing ${leaks.joinToString(" and ")} " +
        "resources: those encoder threads never terminated within the deferred-release " +
        "budget, so the handles were deliberately leaked rather than freed under a live " +
        "thread. No further capture can be started in this process."
    Log.e(TAG, "GC_P2_GATE session_released_WITH_LEAK gen=$gen $detail")
    main.post {
      sendEvent(
        "onCaptureError",
        mapOf(
          "sessionId" to closingSessionId,
          "code" to ErrorCode.ENCODER_FAILED,
          "message" to detail,
        ),
      )
      sendEvent(
        "onCaptureReleased",
        mapOf(
          "sessionId" to closingSessionId,
          "resourcesFreed" to false,
          "leaked" to leaks,
        ),
      )
    }
  }

  /**
   * Public stop → the ordered protocol, never an abrupt teardown.
   *
   * Synchronized so the owning generation is read under the same lock that
   * `startCapture` and `finalizeSession` hold. Reading `sessionActive` and
   * `sessionGen` outside it meant a stop that began observing A could finish
   * stopping B.
   */
  @Synchronized
  private fun stopCapture() {
    if (!sessionActive) return
    val gen = sessionGen.get()   // captured under the lock
    beginOrderedStop(gen)
  }

  /**
   * A `start()` that returned false. Both encoders report through `onError`
   * before returning false, so the teardown is normally already running — in
   * that case this only logs, and the error is NOT emitted twice.
   *
   * The latch is consulted for the same reason [startStillValid] does: the
   * reporter may be a worker thread blocked on this monitor, in which case
   * `releasing` is still false but the teardown is already owned.
   *
   * If some future path ever returned false without reporting, this still
   * guarantees the teardown: no camera, encoder or coordinator is left holding
   * the device just because a callback was missed.
   */
  @Synchronized
  private fun abortStart(gen: Long, stage: String) {
    Log.e(TAG, "GC_P2_GATE start_aborted stage=$stage releasing=$releasing gen=$gen")
    if (!genValid(gen)) return
    if (releasing) return                        // synchronous onError already began teardown
    if (asyncFailureGen.get() >= gen) return     // a blocked reporter owns the teardown
    emitError(gen, ErrorCode.ENCODER_FAILED, "$stage start() returned false without reporting")
  }

  /**
   * Rejection for a start that was never accepted.
   *
   * Reports under the REQUESTED id, finalises nothing, and emits no
   * `onCaptureReleased` — there is no session to release. Never touches the
   * running session's resources, generation or identity.
   */
  private fun rejectStart(id: String, code: String, message: String) {
    Log.w(TAG, "GC_P2_GATE start_rejected requested=$id code=$code")
    main.post {
      sendEvent(
        "onCaptureError",
        mapOf("sessionId" to id, "code" to code, "message" to message),
      )
    }
  }

  /**
   * Terminal failure for a SPECIFIC generation. Reached through [reportError].
   *
   * The ownership check lives INSIDE the monitor, not at the call site. An
   * outer `if (genActive(gen)) emitError(...)` is a check-then-act race: the
   * callback can pass the guard, block on the monitor while
   * [finalizeSession] runs and a new session starts, and then tear down the
   * NEW session. Re-checking here, under the same lock as [startCapture] and
   * [finalizeSession], closes that window.
   *
   * Only resources and identity belonging to `gen` are captured.
   */
  @Synchronized
  private fun emitError(gen: Long, code: String, message: String) {
    if (!genValid(gen) || !sessionActive) {
      Log.w(
        TAG,
        "GC_P2_GATE error_ignored stale gen=$gen current=${sessionGen.get()} " +
          "active=$sessionActive code=$code",
      )
      return
    }
    // FIRST terminal error wins. Checking `releasing` before publishing stops
    // a cascade of follow-on failures — an encoder erroring because the camera
    // was already closed, say — from reaching JS as a second, misleading
    // `onCaptureError`.
    if (releasing) {
      Log.w(TAG, "GC_P2_GATE error_suppressed already_releasing code=$code message=$message")
      return
    }
    releasing = true

    Log.e(TAG, "GC_P2_GATE error gen=$gen code=$code message=$message")
    val failingSessionId = sessionId
    main.post {
      sendEvent(
        "onCaptureError",
        mapOf("sessionId" to failingSessionId, "code" to code, "message" to message),
      )
    }

    // Local references belonging to THIS generation, captured under the lock.
    val ch = characterisation
    val coord = coordinator
    val vid = video
    val aud = audio
    val cam = camera
    cam?.close()

    val releaseAll = {
      ch?.let { Log.i(TAG, "GC_P2_GATE clock_characterisation ${it.report()}") }
      // Same rule as the normal path: finalisation waits for real outcomes.
      // A component that was never constructed settles immediately; one that
      // was is only counted when its threads are provably gone or its
      // resources were deliberately leaked.
      awaitEncoderRelease(gen, vid, aud, failingSessionId)
    }
    coord?.release { releaseAll() } ?: releaseAll()
  }

  companion object {
    private const val TAG = "GCSegRec"
    /** Placeholder source for the resolve-only probe controller. */
    private const val NO_SOURCE = -1
    /** Sentinel for "no generation has reported a failure". */
    private const val NO_GEN = -1L
    private const val INTAKE_DRAIN_POLL_MS = 50L
    private const val INTAKE_DRAIN_ATTEMPTS = 40
  }
}
