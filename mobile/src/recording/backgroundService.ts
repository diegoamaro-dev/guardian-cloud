/**
 * Foreground-service wrapper (Tier 2 background execution).
 *
 * Single responsibility: keep the React Native JS runtime alive while
 * Guardian Cloud has critical work to do. "Critical work" is decided
 * by the caller via two predicates:
 *
 *   - isRecordingActive(): synchronous check — recorder still capturing
 *   - hasPendingWork():    async check — queue still has chunks in
 *                          `pending` / `uploading`
 *
 * The lifecycle gate runs on every tick:
 *   1. drain (caller-supplied — already-existing upload worker)
 *   2. evaluate predicates
 *      - recording active        → KEEPALIVE { reason: 'recording_active' }
 *      - pending uploads (only)  → KEEPALIVE { reason: 'pending_uploads' }
 *      - neither                 → STOP      { reason: 'no_pending_work' }
 *
 * The service is therefore decoupled from app foreground/background and
 * from the explicit start/stop of recording. It self-terminates when
 * Guardian Cloud truly has nothing to protect — and stays alive across
 * minimise → restore → minimise cycles as long as recording continues
 * or the queue is non-empty.
 *
 * Strict isolation contract (matches the project rules):
 *   - never touches GC_QUEUE
 *   - never touches the upload worker (only INVOKES the caller-supplied
 *     drain callback so the worker can self-pace as usual)
 *   - never touches chunking, OAuth, backend, or export
 *   - never persists anything (no AsyncStorage)
 *   - reversible — if this file is removed and the call sites in
 *     startRecording / stopRecording / bootstrap are deleted, the rest
 *     of the app continues to work exactly as in Tier 1.
 *
 * Android-only meaningful behavior. iOS calls into the same library
 * primitives but the iOS background lifetime story is out of scope for
 * this task; the wrapper is safe to call there but won't keep the JS
 * runtime alive in the same way Android can.
 */

import { Platform } from 'react-native';
import BackgroundActions, {
  type BackgroundTaskOptions,
} from 'react-native-background-actions';

const TASK_NAME = 'guardian-cloud-evidence';
const NOTIFICATION_TITLE = 'Guardian Cloud';
const NOTIFICATION_TEXT = 'Guardian Cloud está protegiendo tu evidencia';
/**
 * Tick cadence for the background loop. Each tick: drain + lifecycle
 * gate. 5s balances responsiveness for newly-emitted chunks with not
 * burning CPU when idle.
 */
const TICK_INTERVAL_MS = 5_000;

let isRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface BackgroundProtectionCallbacks {
  /** Single drain invocation. Single-flight is enforced inside the worker. */
  drain: () => Promise<void>;
  /** Sync predicate — recorder still active right now. */
  isRecordingActive: () => boolean;
  /** Async predicate — queue still has chunks the worker can act on. */
  hasPendingWork: () => Promise<boolean>;
}

/**
 * Long-running task body. Runs until the lifecycle gate decides we're
 * done. Errors inside the drain are caught and logged so a single bad
 * tick does not prematurely kill the service.
 */
function makeTaskBody(
  cb: BackgroundProtectionCallbacks,
): () => Promise<void> {
  return async () => {
    while (BackgroundActions.isRunning()) {
      console.log('GC_BACKGROUND_UPLOAD_TICK', { ts: Date.now() });
      try {
        await cb.drain();
      } catch (err) {
        console.log('GC_BACKGROUND_UPLOAD_ERROR', {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // Lifecycle gate. Stays alive while there is critical work.
      // Order matters: a live recorder dominates the pending-work
      // signal (a recording with zero emitted chunks yet would
      // otherwise look like "no work" to the queue check).
      if (cb.isRecordingActive()) {
        console.log('GC_BACKGROUND_SERVICE_KEEPALIVE', {
          reason: 'recording_active',
        });
      } else {
        let pending = false;
        try {
          pending = await cb.hasPendingWork();
        } catch (err) {
          // Defensive: a queue-read failure should NOT silently kill
          // the service (we'd lose background lifetime over a transient
          // AsyncStorage hiccup). Treat as "still work" until proven
          // otherwise. The next tick will re-check.
          console.log('GC_BACKGROUND_UPLOAD_ERROR', {
            phase: 'pending_check',
            err: err instanceof Error ? err.message : String(err),
          });
          pending = true;
        }
        if (pending) {
          console.log('GC_BACKGROUND_SERVICE_KEEPALIVE', {
            reason: 'pending_uploads',
          });
        } else {
          console.log('GC_BACKGROUND_SERVICE_STOP', {
            reason: 'no_pending_work',
          });
          break;
        }
      }

      await sleep(TICK_INTERVAL_MS);
    }
    // Loop exited (either condition above broke out, or the library
    // was stopped externally). Make the local flag agree with reality
    // and ask the library to finalise the service. Idempotent.
    isRunning = false;
    try {
      await BackgroundActions.stop();
    } catch {
      /* already stopped */
    }
  };
}

const baseOptions: BackgroundTaskOptions = {
  taskName: TASK_NAME,
  taskTitle: NOTIFICATION_TITLE,
  taskDesc: NOTIFICATION_TEXT,
  taskIcon: {
    name: 'ic_launcher',
    type: 'mipmap',
  },
  // Calm green to match the protected-evidence palette in the home UI.
  color: '#3ddc84',
  linkingURI: 'guardiancloud://',
  // Android 14+ requires a typed foreground service. Microphone matches
  // the use case; the manifest declares the same type on the <service>
  // element so both layers agree.
  foregroundServiceType: ['microphone'],
};

/**
 * Start the foreground service. Idempotent — calling twice is a no-op.
 * Recording flow MUST NOT abort on a false return: the foreground app
 * stays functional, the user just loses background lifetime.
 */
export async function startBackgroundProtection(
  cb: BackgroundProtectionCallbacks,
): Promise<boolean> {
  if (isRunning) {
    console.log('GC_BACKGROUND_UPLOAD_START', { skipped: 'already_running' });
    return true;
  }
  console.log('GC_BACKGROUND_UPLOAD_START', {
    platform: Platform.OS,
    interval_ms: TICK_INTERVAL_MS,
  });
  try {
    await BackgroundActions.start(makeTaskBody(cb), baseOptions);
    isRunning = true;
    return true;
  } catch (err) {
    console.log('GC_BACKGROUND_UPLOAD_ERROR', {
      phase: 'start',
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * External stop. Caller is responsible for first verifying that there
 * is no pending work and no active recording — the wrapper does NOT
 * second-guess. Reasons documented:
 *   - 'rec_stopped_no_pending_work' — stopRecording finally observed
 *      both predicates false right away.
 *   - 'no_pending_work'             — usually emitted from inside the
 *      tick body; this external path is reserved for callers that
 *      already proved the same condition (e.g. tests).
 */
export async function stopBackgroundProtection(reason: string): Promise<void> {
  if (!isRunning) return;
  try {
    await BackgroundActions.stop();
  } catch (err) {
    console.log('GC_BACKGROUND_UPLOAD_ERROR', {
      phase: 'stop',
      err: err instanceof Error ? err.message : String(err),
    });
  } finally {
    isRunning = false;
    console.log('GC_BACKGROUND_SERVICE_STOP', { reason });
  }
}

/**
 * Read-only check for callers that want to know whether the service
 * is currently up (e.g. to render a small "background ON" indicator).
 */
export function isBackgroundProtectionRunning(): boolean {
  return isRunning;
}
