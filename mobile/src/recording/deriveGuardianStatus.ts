/**
 * Pure derivation of the user-facing Guardian Cloud status from
 * data the app already tracks. The function NEVER reads from
 * AsyncStorage, never fetches, never owns state — it only maps the
 * inputs it is given to one of the six visible states.
 *
 * Inputs are all values the home screen already maintains:
 *   - `isRecording` / `isRecovering` — existing component flags.
 *   - `totalCount` / `uploadedCount` / `activeCount` / `failedCount` —
 *     queue-derived counters the polling tick already updates every
 *     ~500 ms.
 *
 * Precedence (top wins):
 *   1. grabando    — recorder is live.
 *   2. recuperando — boot recovery is still draining the queue.
 *   3. error       — at least one chunk reached the terminal `failed`
 *                    status; the upload pipeline cannot finish on its
 *                    own.
 *   4. subiendo    — chunks are still in motion (`pending` / `uploading`).
 *   5. protegido   — every emitted chunk is `uploaded`; the entry has
 *                    not been reaped yet. This is a brief observable
 *                    window between the last 200 OK and `reapEntry`.
 *   6. listo       — fallback. Used when no other condition holds, and
 *                    explicitly returned for transient transitions
 *                    (e.g. `isStarting` / `isStopping`) where we have
 *                    no truthful information yet.
 */

export type GuardianStatus =
  | 'listo'
  | 'grabando'
  | 'subiendo'
  | 'recuperando'
  | 'protegido'
  | 'error';

export interface GuardianStatusInput {
  isRecording: boolean;
  isRecovering: boolean;
  totalCount: number;
  uploadedCount: number;
  activeCount: number;
  failedCount: number;
}

export function deriveGuardianStatus(
  input: GuardianStatusInput,
): GuardianStatus {
  if (input.isRecording) return 'grabando';
  if (input.isRecovering) return 'recuperando';
  if (input.failedCount > 0) return 'error';
  if (input.activeCount > 0) return 'subiendo';
  if (input.totalCount > 0 && input.uploadedCount === input.totalCount) {
    return 'protegido';
  }
  return 'listo';
}
