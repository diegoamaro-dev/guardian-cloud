/**
 * Export runner — module-scoped singleton state for the cloud export flow.
 *
 * Purpose:
 *   - Survive React component unmount so a user that navigates away from
 *     `/session/[id]` during an export sees the same in-flight progress
 *     when they navigate back.
 *   - Guarantee at most one export is in flight at a time across the
 *     whole app (anti double-export).
 *   - Expose a cancellation primitive that flows an AbortSignal through
 *     `exportSession` → `exportFromChunkRefs` → `downloadChunkSharedToken`
 *     without forcing UI surfaces to exist yet.
 *
 * Strict isolation contract:
 *   - NEVER touches GC_QUEUE, the upload worker, recovery, chunking,
 *     OAuth, the backend, or the foreground service. The only API it
 *     reaches into is `exportSession`, which is itself read-only against
 *     the backend.
 *   - NEVER persists anything (no AsyncStorage, no disk). State lives
 *     in module-scoped vars and dies with the JS context.
 *   - NEVER touches the AndroidManifest or `app.config.ts`. No new
 *     permissions, no new notifications, no FG service interaction.
 *
 * Lifecycle:
 *   idle
 *     │ startExport(sid, mode)  → controller created, status → running
 *     ▼
 *   running
 *     │ onProgress              → status → running (new progress)
 *     │ result.stopReason==='cancelled' → status → cancelled
 *     │ result other            → status → done
 *     │ exportSession throws    → status → error (defence in depth)
 *     ▼
 *   done | cancelled | error
 *     │ clearExport()           → status → idle
 *     │ startExport(sid, mode)  → controller created, status → running
 *
 * `cancelExport(sid)` only acts in `running`. It calls `controller.abort()`
 * which propagates through `exportSession`'s plumbing and resolves the
 * IIFE into one of the terminal states above.
 *
 * `subscribeExport(listener)` replays the current status synchronously on
 * subscribe — this is the rehydration primitive consumed by
 * `app/session/[id].tsx` on remount.
 *
 * This file does NOT change foreground export behaviour. The current
 * limitation "if the app is minimised during export, Android may pause
 * the download loop; on foreground return it resumes" is preserved
 * verbatim — no foreground service involvement. Background export with
 * notification + progress is explicitly deferred per project policy.
 */

import type { ExportProgress, ExportResult } from './export';
import type { SessionMode } from './history';
import { exportSession } from './export';

export type ExportRunnerStatus =
  | { kind: 'idle' }
  | {
      kind: 'running';
      sessionId: string;
      mode: SessionMode | undefined;
      progress: ExportProgress | null;
    }
  | {
      kind: 'done';
      sessionId: string;
      mode: SessionMode | undefined;
      result: ExportResult;
    }
  | {
      kind: 'cancelled';
      sessionId: string;
      mode: SessionMode | undefined;
    }
  | {
      kind: 'error';
      sessionId: string;
      mode: SessionMode | undefined;
      message: string;
    };

type Listener = (status: ExportRunnerStatus) => void;

/**
 * Current runner status. Mutated only via `setStatus`. Reads outside
 * `setStatus` go through `getExportStatus` so future tooling (e.g.
 * structured logging) can be added in one place.
 */
let currentStatus: ExportRunnerStatus = { kind: 'idle' };

/**
 * Active AbortController for the in-flight export, if any. Pinned at
 * `startExport` time and cleared on resolution. Stale closures captured
 * by `onProgress` and the IIFE's then/catch compare against this ref to
 * filter out callbacks from a previously-cancelled run (the IIFE may
 * still complete after `cancelExport` returns).
 */
let currentController: AbortController | null = null;

/**
 * Subscriber set. `subscribeExport` adds the listener and returns the
 * matching `delete` cleanup. Listeners are invoked synchronously inside
 * `setStatus`; a throw from one listener never breaks the runner or
 * the other listeners.
 */
const listeners = new Set<Listener>();

function setStatus(next: ExportRunnerStatus): void {
  currentStatus = next;
  // Snapshot the set into an array before notifying so a listener that
  // unsubscribes itself during the callback (e.g., a screen that
  // unmounts on `done`) does not perturb the iteration order.
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch {
      // A listener must not break the runner or the other listeners.
      // The screen subscriber is the only consumer today; a throw here
      // would indicate a programmer bug, not a runtime failure.
    }
  }
}

/** Read-only snapshot of the current runner status. */
export function getExportStatus(): ExportRunnerStatus {
  return currentStatus;
}

/** True iff there is an export in flight (`running`). */
export function isExportActive(): boolean {
  return currentStatus.kind === 'running';
}

/**
 * Subscribe to status changes. The listener is invoked once synchronously
 * with the current status before this function returns — this is the
 * rehydration primitive used by `app/session/[id].tsx` on remount: a
 * subscriber that mounts after an export started receives the current
 * state without missing it.
 *
 * Returns an unsubscribe function. Calling it more than once is a no-op.
 */
export function subscribeExport(listener: Listener): () => void {
  listeners.add(listener);
  try {
    listener(currentStatus);
  } catch {
    // Same rationale as setStatus: a throw from the initial replay
    // must not break the subscribe contract.
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Start an export for `sessionId`. Returns:
 *   - true  → the call was accepted and the export is now in flight.
 *   - false → an export was already in flight (anti double-export).
 *
 * The runner transitions to `running` synchronously before this function
 * returns. The IIFE awaits `exportSession(...)` and transitions to
 * `done` / `cancelled` / `error` when it resolves.
 *
 * Callers that need to know completion subscribe via `subscribeExport`.
 */
export function startExport(sessionId: string, mode?: SessionMode): boolean {
  if (isExportActive()) return false;

  const controller = new AbortController();
  currentController = controller;
  setStatus({ kind: 'running', sessionId, mode, progress: null });

  // Fire-and-forget. Failures are folded into terminal status; the
  // `exportSession` contract is "never throws" but we defend in depth.
  void (async () => {
    let result: ExportResult;
    try {
      result = await exportSession(
        sessionId,
        (progress) => {
          // Filter callbacks that arrive after this run was superseded
          // (cancel → start). The replacement controller would already
          // have set its own `running` status; we must not clobber it.
          if (currentController !== controller) return;
          // Defensive: only emit a `running` update when we are still
          // in `running`. If a parallel `cancelExport` flipped the
          // status to a terminal kind before this progress callback
          // ran, we leave the terminal state intact.
          if (currentStatus.kind !== 'running') return;
          setStatus({ kind: 'running', sessionId, mode, progress });
        },
        mode,
        controller.signal,
      );
    } catch (err) {
      // Defence in depth — `exportSession` is documented as never-throws.
      // If this branch ever fires we surface as `error` rather than
      // letting the unhandled rejection escape the IIFE.
      if (currentController === controller) {
        currentController = null;
        setStatus({
          kind: 'error',
          sessionId,
          mode,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Late-resolution filter: a cancel + restart between `await` and
    // here would have already swapped `currentController`. Drop this
    // stale result silently.
    if (currentController !== controller) return;
    currentController = null;

    if (result.stopReason === 'cancelled') {
      setStatus({ kind: 'cancelled', sessionId, mode });
    } else {
      setStatus({ kind: 'done', sessionId, mode, result });
    }
  })();

  return true;
}

/**
 * Cancel the in-flight export iff its `sessionId` matches the argument.
 * Returns:
 *   - true  → the abort signal was raised; the runner will transition
 *             to `cancelled` (or possibly `done`/`error` if the export
 *             had already resolved between the abort and the runner's
 *             observation — race-safe).
 *   - false → no in-flight export, or the in-flight export targets a
 *             different `sessionId`. Status is unchanged.
 *
 * Cancellation is observed inside `exportFromChunkRefs` at iteration
 * boundaries AND inside `downloadChunkSharedToken` at the fetch +
 * backoff-sleep layer. Worst-case latency is one in-flight HTTP request
 * (capped at 30s by the existing per-chunk timeout).
 */
export function cancelExport(sessionId: string): boolean {
  if (currentStatus.kind !== 'running') return false;
  if (currentStatus.sessionId !== sessionId) return false;
  currentController?.abort();
  return true;
}

/**
 * Reset the runner to `idle`. No-op while a run is in flight (the
 * caller must `cancelExport` first). Intended for UI flows that want
 * to dismiss a terminal state (`done` / `cancelled` / `error`) so a
 * subsequent `startExport` starts from a clean slate.
 *
 * Listeners are notified on the transition, mirroring every other
 * state change so subscribers do not have to special-case clear.
 */
export function clearExport(): void {
  if (currentStatus.kind === 'running') return;
  if (currentStatus.kind === 'idle') return;
  setStatus({ kind: 'idle' });
}

/**
 * Test-only reset. Re-enters the module's pristine state without
 * exercising the normal lifecycle gates. Production code MUST NOT
 * call this — it bypasses the anti-double-export guard and abandons
 * any in-flight AbortController. Exposed so vitest can isolate cases
 * without relying on import-order side effects.
 */
export function __resetExportRunnerForTests(): void {
  currentController = null;
  currentStatus = { kind: 'idle' };
  listeners.clear();
}
