/**
 * Pure derivation of the user-facing Guardian Cloud status from
 * data the app already tracks. The function NEVER reads from
 * AsyncStorage, never fetches, never owns state — it only maps the
 * inputs it is given to one of the seven visible states.
 *
 * Inputs are all values the home screen already maintains:
 *   - `isRecording` / `isRecovering` / `isStarting` — existing
 *     component flags.
 *   - `totalCount` / `uploadedCount` / `activeCount` / `failedCount` —
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
 *   5. subiendo    — chunks are still in motion (`pending` / `uploading`).
 *   6. protegido   — every emitted chunk is `uploaded`; the entry has
 *                    not been reaped yet. This is a brief observable
 *                    window between the last 200 OK and `reapEntry`.
 *                    Requires `totalCount > 0` so a fresh-launch app
 *                    never lies about having protected anything.
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
  totalCount: number;
  uploadedCount: number;
  activeCount: number;
  failedCount: number;
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
  if (input.activeCount > 0) return 'subiendo';
  if (input.totalCount > 0 && input.uploadedCount === input.totalCount) {
    return 'protegido';
  }
  return 'listo';
}
