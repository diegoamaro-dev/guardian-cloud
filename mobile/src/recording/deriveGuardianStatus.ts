/**
 * Pure derivation of the user-facing Guardian Cloud status from
 * data the app already tracks. The function NEVER reads from
 * AsyncStorage, never fetches, never owns state — it only maps the
 * inputs it is given to one of the seven visible states.
 *
 * Inputs are all values the home screen already maintains:
 *   - `isRecording` / `isRecovering` / `isStarting` — existing
 *     component flags.
 *   - `totalCount` / `confirmedOffDeviceCount` / `activeCount` /
 *     `failedCount` —
 *     queue-derived counters the polling tick already updates every
 *     ~500 ms.
 *
 * Precedence (top wins):
 *   1. grabando    — recorder is live.
 *   2. iniciando   — `isStarting=true` AND not yet recording. Covers the
 *                    pre-recorder window (permissions → audio mode →
 *                    foreground service → POST /sessions → recorder
 *                    startAsync). On survival hardware this can be
 *                    1–4 seconds; without this state the UI says
 *                    "Listo" the whole time and the user has no
 *                    feedback that their tap was registered.
 *   3. recuperando — boot recovery is still draining the queue.
 *   4. error       — at least one chunk reached the terminal `failed`
 *                    status; the upload pipeline cannot finish on its
 *                    own.
 *   5. subiendo    — `isStopping` is true, OR chunks are still in
 *                    motion (`pending` / `uploading`). The
 *                    `isStopping` half matters because
 *                    `setIsRecording(false)` runs BEFORE post-stop
 *                    chunking and before `queueMarkRecordingClosed`:
 *                    without it, a video session shows "Listo" during
 *                    the window where its queue is still empty, and an
 *                    audio session whose worker has caught up shows
 *                    "Protegido" before the capture is closed.
 *   6. protegido   — the capture is CLOSED and every emitted chunk is
 *                    `uploaded`; the entry has not been reaped yet.
 *                    This is a brief observable window between the last
 *                    200 OK and `reapEntry`. `recordingClosed` is
 *                    mandatory: while the session is open more chunks
 *                    can still arrive, so "all known chunks uploaded"
 *                    proves nothing about the capture as a whole.
 *                    `totalCount > 0` keeps a fresh-launch app from
 *                    claiming to have protected anything.
 *   7. listo       — fallback. Used when no other condition holds.
 */

export type GuardianStatus =
  | 'listo'
  | 'iniciando'
  | 'grabando'
  | 'subiendo'
  | 'recuperando'
  | 'protegido'
  | 'error';

export interface GuardianStatusInput {
  isRecording: boolean;
  isRecovering: boolean;
  /**
   * True from the moment GRABAR is tapped until the recorder is
   * confirmed live (or the start path errors out). Drives the new
   * `iniciando` state so the UI surfaces immediate feedback instead of
   * staying on "Listo" for the duration of the start await chain.
   */
  isStarting: boolean;
  /**
   * True from the moment PARAR is tapped until the stop path finishes.
   * Required because `setIsRecording(false)` fires EARLY in that path —
   * before video post-stop chunking (`chunkVideoFile`) has produced a
   * single chunk, and before `queueMarkRecordingClosed` marks the
   * session closed. Without this flag the screen falls through to
   * `listo` (video, empty queue) or to `protegido` (audio, worker
   * momentarily caught up) during a window where neither is true.
   */
  isStopping: boolean;
  totalCount: number;
  /**
   * Chunks that pass `isChunkConfirmedOffDevice` — NOT the count of
   * chunks whose queue status happens to be `uploaded`. `protegido` is
   * a claim about evidence that survives losing the phone, so it may
   * only ever be derived from proof of remote existence.
   */
  confirmedOffDeviceCount: number;
  activeCount: number;
  failedCount: number;
  /**
   * `recording_closed` of the current GC_QUEUE entry — the first
   * instant at which no further chunk can join the session. Gates
   * `protegido`: "every known chunk is uploaded" is only a statement
   * about the whole capture once the capture is closed.
   */
  recordingClosed: boolean;
}

export interface ProtectedTallyInput {
  /** `recording_closed` of the entry being judged. */
  recordingClosed: boolean;
  /** Chunks known for the entry — every chunk, whatever its status. */
  totalCount: number;
  /**
   * Chunks that pass `isChunkConfirmedOffDevice`. Named for the proof,
   * not for the queue status, so a caller cannot pass a bare
   * `status === 'uploaded'` tally without noticing.
   */
  confirmedOffDeviceCount: number;
}

/**
 * The single closed-and-fully-protected predicate.
 *
 * Shared deliberately by `deriveGuardianStatus` (which decides the
 * `protegido` phase) and by the home screen's per-session banner
 * detection, so the green "Evidencia protegida" banner and the main
 * status can never disagree about what "protected" means.
 *
 * `confirmedOffDeviceCount` must always be built with
 * `isChunkConfirmedOffDevice`: `uploaded` AND a real
 * `remote_reference`. A chunk without a remote reference has no proof
 * of living anywhere but the phone.
 *
 * Counters are normalised conservatively, so an incoherent tick can
 * never resolve to `true`.
 */
export function isProtectedTally(input: ProtectedTallyInput): boolean {
  // An open capture can still grow. "All known chunks uploaded" is
  // then a statement about a moving set, not about the recording.
  if (!input.recordingClosed) return false;
  const total = normalizeCount(input.totalCount);
  const confirmed = normalizeCount(input.confirmedOffDeviceCount);
  if (total === 0) return false;
  return confirmed === total;
}

/**
 * Minimal shape of a queue chunk this module needs to judge.
 *
 * `remote_reference` spells out `| undefined` to match `QueueChunk`'s
 * own declaration under `exactOptionalPropertyTypes`, so a real
 * `PendingQueueEntry` is structurally assignable with no cast.
 */
export interface ProtectedChunkLike {
  status: string;
  remote_reference?: string | null | undefined;
}

/** Minimal shape of a GC_QUEUE entry this module needs to judge. */
export interface ProtectedEntryLike {
  recording_closed: boolean;
  chunks: readonly ProtectedChunkLike[];
}

/**
 * THE definition of "this fragment is outside the device".
 *
 * Every visible protection claim in the app must be counted with this
 * predicate and nothing else. `status === 'uploaded'` on its own is a
 * QUEUE state, not proof: it says the worker finished with the chunk,
 * not that anything durable exists off the phone. A chunk can hold
 * that status with no reference at all —
 *
 *   - the `DRIVE_CHUNK_UPLOAD_ENABLED=false` rollback records
 *     `remote_reference: null` deliberately,
 *   - legacy entries predate the field,
 *
 * — and the finalize gate already treats such a chunk as incomplete.
 * A protection claim built on the bare status would therefore be
 * exactly the unprovable assertion A-2 exists to prevent.
 *
 * The reference must be a non-blank string: `''` and `'   '` are
 * absence wearing a string's clothes.
 */
export function isChunkConfirmedOffDevice(chunk: ProtectedChunkLike): boolean {
  if (chunk.status !== 'uploaded') return false;
  const ref = chunk.remote_reference;
  return typeof ref === 'string' && ref.trim().length > 0;
}

/**
 * Entry-level "this session is fully protected outside the device"
 * predicate, used by the home screen's green-banner detection.
 *
 * Stricter than a plain status count: a chunk only counts when it is
 * `uploaded` AND carries a real `remote_reference`. The remote
 * reference is the actual proof the bytes exist off the phone — the
 * same test the export and finalize paths already apply. A chunk
 * marked uploaded with no reference has nothing to point at.
 *
 * Delegates the closed-and-complete arithmetic to `isProtectedTally`
 * so the banner and `deriveGuardianStatus` cannot disagree.
 */
export function isEntryFullyProtected(entry: ProtectedEntryLike): boolean {
  const confirmed = entry.chunks.filter(isChunkConfirmedOffDevice).length;
  return isProtectedTally({
    recordingClosed: entry.recording_closed,
    totalCount: entry.chunks.length,
    confirmedOffDeviceCount: confirmed,
  });
}

export function deriveGuardianStatus(
  input: GuardianStatusInput,
): GuardianStatus {
  if (input.isRecording) return 'grabando';
  // `isStarting && !isRecording` — sits below grabando so a race where
  // both are briefly true (between recorder.startAsync resolving and
  // setIsStarting(false)) still surfaces as 'grabando'. Sits above
  // recuperando because boot recovery and a fresh GRABAR are not
  // mutually exclusive (recovery may still be draining when the user
  // taps GRABAR for a new session); the active user intent dominates.
  if (input.isStarting) return 'iniciando';
  if (input.isRecovering) return 'recuperando';
  if (input.failedCount > 0) return 'error';
  // `isStopping` counts as upload work even with an empty queue: the
  // video path has not emitted its chunks yet at this point, and
  // falling through to `listo`/`protegido` here is exactly how the
  // screen used to claim safety it could not prove.
  if (input.isStopping || input.activeCount > 0) return 'subiendo';
  if (
    isProtectedTally({
      recordingClosed: input.recordingClosed,
      totalCount: input.totalCount,
      confirmedOffDeviceCount: input.confirmedOffDeviceCount,
    })
  ) {
    return 'protegido';
  }
  return 'listo';
}

/**
 * Copy shown while NO fragment has been confirmed outside the device.
 *
 * Deliberately absolute: "todavía no protegido" is the only honest
 * thing to say when `confirmedOffDeviceCount === 0`, regardless of how much
 * evidence already exists locally. A fragment that only lives on the
 * phone is NOT protected — losing the device loses it. See
 * `docs/PROTECTION_MODEL.md` ("La evidencia está protegida cuando ya
 * no depende del dispositivo") and GC-AUD-004.
 */
export const NOT_PROTECTED_OFF_DEVICE =
  'Todavía no protegido fuera del dispositivo';

export interface ProtectionStatementInput {
  /** Phase already derived by `deriveGuardianStatus`. */
  status: GuardianStatus;
  /**
   * Chunks that pass `isChunkConfirmedOffDevice` — `uploaded` AND
   * carrying a real `remote_reference`. This is the ONLY counter that
   * may justify a protection claim; a bare queue-status tally is not
   * proof that anything left the phone.
   */
  confirmedOffDeviceCount: number;
  /**
   * Chunks currently known for the session. While the capture is still
   * open this only counts what has been emitted SO FAR — it is not the
   * total the recording will eventually produce.
   */
  totalCount: number;
  /**
   * `recording_closed` of the current GC_QUEUE entry. False until
   * `queueMarkRecordingClosed` runs, which is the first instant at
   * which no further chunk can join the session.
   */
  recordingClosed: boolean;
}

/**
 * Conservative counter normalisation.
 *
 * The counters arrive from a 500 ms poll over GC_QUEUE and can
 * momentarily disagree with each other. A chunk count is by
 * construction a non-negative safe integer, so anything else is
 * evidence that the value cannot be trusted — and an untrustworthy
 * counter must never be rounded INTO a protection claim. `1.7` is not
 * "1 protected fragment"; it is a number that should not exist, and it
 * collapses to 0, the branch that asserts nothing.
 *
 * Rejects: negatives, fractions, NaN, ±Infinity, and anything beyond
 * `Number.MAX_SAFE_INTEGER`.
 */
function normalizeCount(value: number): number {
  if (!Number.isSafeInteger(value)) return 0;
  return value > 0 ? value : 0;
}

/**
 * Pure derivation of the secondary "how much is actually protected
 * outside the device" line. Returns `null` when no protection
 * statement should be rendered at all.
 *
 * This is deliberately SEPARATE from `deriveGuardianStatus`: the phase
 * ("Grabando", "Subiendo evidencia") and the protection fact ("nothing
 * is off-device yet" / "3 fragments are") are two independent facts,
 * and collapsing them into one label is exactly the defect GC-AUD-004
 * and GC-AUD-033 share. The screen renders the phase on the main line
 * and this statement underneath.
 *
 * Two rules govern every branch:
 *
 *   1. Protection is asserted ONLY from
 *      `confirmedOffDeviceCount > 0`. Local,
 *      pending or in-flight evidence is never presented as protected.
 *
 *   2. A denominator is shown ONLY when `recordingClosed` is true.
 *      While the capture is open, `totalCount` is "fragments produced
 *      so far", not "fragments this recording will produce" — there is
 *      no signal anywhere that predicts the latter. Rendering `N/M`
 *      against a moving M would let the counter read `3/3` mid-capture
 *      and be understood as "everything is safe". The open-capture
 *      branch therefore states an absolute count and no total.
 *
 * `recordingClosed` is required because the phase alone cannot carry
 * this: video emits its chunks AFTER the recorder stops
 * (`chunkVideoFile` runs post-`stop()`), so the session is already in
 * `subiendo` while M is still climbing from 0.
 *
 * The function takes NO `mode` argument and never consults the
 * recording mode: audio and video with identical counters are
 * structurally guaranteed to produce identical copy.
 *
 * Pure: no I/O, no storage, no React, no Expo, no side effects.
 */
export function deriveProtectionStatement(
  input: ProtectionStatementInput,
): string | null {
  // Only the two phases where a capture/upload is genuinely in
  // progress carry this line. `protegido` already says "Protegido" on
  // the main label and shows the green banner; `error` owns the
  // failure surface; `listo`, `iniciando` and `recuperando` have
  // nothing confirmed to report. Returning null leaves all of them
  // exactly as they are today.
  if (input.status !== 'grabando' && input.status !== 'subiendo') {
    return null;
  }

  const confirmed = normalizeCount(input.confirmedOffDeviceCount);
  const total = normalizeCount(input.totalCount);

  // Rule 1. No confirmation outside the device ⇒ no protection claim.
  if (confirmed === 0) return NOT_PROTECTED_OFF_DEVICE;

  // Rule 2. The denominator needs all three of:
  //   - the recorder is no longer live (`status !== 'grabando'`),
  //   - GC_QUEUE reports the session closed, so no chunk can still
  //     join it,
  //   - coherent counters (`total >= confirmed`), so an incoherent
  //     pair falls through to the absolute form instead of rendering
  //     something like "5/3".
  // The phase and `recording_closed` are checked independently on
  // purpose: neither implies the other in a way this function should
  // trust, and the cost of the redundant check is one comparison.
  const denominatorIsTrustworthy =
    input.status === 'subiendo' && input.recordingClosed && total >= confirmed;

  if (denominatorIsTrustworthy) {
    // Numerator is the CONFIRMED count, denominator is every known
    // chunk — so a session whose chunks are all `uploaded` but some
    // without a reference reads "3/5", not "5/5". Never claims the
    // session is complete either; that verdict belongs to the
    // `protegido` phase alone, so `N === total` still renders here.
    return `${confirmed}/${total} protegidos`;
  }

  return confirmed === 1
    ? '1 parte protegida fuera del dispositivo'
    : `${confirmed} partes protegidas fuera del dispositivo`;
}
