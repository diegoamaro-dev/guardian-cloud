/**
 * Single-flight scheduler for the cleanup runner.
 *
 * Cleanup is durable, recoverable maintenance. It must happen soon after a
 * session is confirmed finished — otherwise an app left open across many
 * captures accumulates session directories and journal entries until the next
 * launch — but it must never sit in the path of anything the user is waiting
 * for, and it must never be able to turn a confirmed remote completion into a
 * failure.
 *
 * So `requestCleanup` returns `void`, not a promise. There is deliberately
 * nothing for a production caller to await and nothing for it to catch: every
 * error is handled inside.
 *
 * THE INVARIANT, and the only subtle thing in this file:
 *
 *     pending is cleared BEFORE reconcile(), never after.
 *
 * The runner takes a snapshot of journal candidates when it starts. A request
 * arriving mid-pass refers to work that snapshot may not contain — a session
 * authorized a millisecond after it was taken. Clearing the flag first means
 * such a request re-raises it and the loop runs exactly one more pass. Clearing
 * it afterwards would swallow that request and the new work would wait for the
 * next launch, which is the very bug this scheduler exists to fix.
 *
 * Requests that arrive while a pass is running collapse into ONE additional
 * pass, not one per request: the flag is a boolean, not a counter, and a second
 * pass sees whatever the first one missed.
 */

/**
 * Why cleanup was asked for. Closed set — a caller cannot pass arbitrary text,
 * so the reason can be logged without becoming a channel for one.
 */
export type CleanupTriggerReason = 'finalized' | 'boot' | 'stale_reconciled';

export interface CleanupSchedulerLogger {
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface CleanupSchedulerRunner {
  reconcile(): Promise<unknown>;
}

export interface CleanupSchedulerDeps {
  runner: CleanupSchedulerRunner;
  logger: CleanupSchedulerLogger;
}

export interface CleanupScheduler {
  /**
   * Ask for a cleanup pass. Non-blocking, never throws, returns nothing.
   *
   * Safe to call from a finalization path: by the time anyone calls this the
   * backend has already confirmed completion and the queue entry is gone, so a
   * cleanup failure is not a finalization failure. It must never lead to
   * another `completeSession`, another `complete_attempts` bump, or a completed
   * session returning to the queue.
   */
  requestCleanup(reason: CleanupTriggerReason): void;
  /**
   * Resolves when no pass is running and none is pending.
   *
   * For tests and diagnostics only. Production code must not await cleanup.
   */
  whenIdle(): Promise<void>;
}

export function createCleanupScheduler(
  deps: CleanupSchedulerDeps,
): CleanupScheduler {
  let pending = false;
  let running: Promise<void> | null = null;

  async function drain(): Promise<void> {
    // Yield once before the first pass so requests raised in the SAME
    // synchronous tick share it. Two requests with no await between them cannot
    // refer to different work — nothing can have been authorized in between —
    // so starting the runner before the second one is even seen would spend a
    // whole extra pass on nothing. A request arriving after any await still
    // lands mid-pass and still earns its own extra pass, which is the case the
    // pending flag exists for.
    await Promise.resolve();

    while (pending) {
      // BEFORE reconcile, always. See the invariant at the top of the file.
      pending = false;
      try {
        await deps.runner.reconcile();
      } catch {
        // Swallowed on purpose, and swallowed WITHOUT reading the exception: a
        // storage or bridge failure can carry a path, a session id or a
        // filename in its message. The journal still holds the work, so the
        // next request or the next launch picks it up.
        deps.logger.log('GC_CLEANUP_SCHEDULER_FAILED', {
          reason: 'reconcile_threw',
        });
      }
    }
    running = null;
  }

  return {
    requestCleanup(reason) {
      pending = true;
      if (running) {
        // A pass is already in flight and will see the flag we just raised.
        deps.logger.log('GC_CLEANUP_REQUEST_COALESCED', { reason });
        return;
      }
      deps.logger.log('GC_CLEANUP_REQUESTED', { reason });
      // `drain` handles its own errors, so this promise never rejects. The
      // `catch` is belt-and-braces against an unhandled rejection warning if a
      // future edit introduces a throw outside the loop's try.
      running = drain().catch(() => undefined);
    },

    async whenIdle() {
      // A pass can raise `pending` again, so wait until the chain settles
      // rather than awaiting a single promise.
      while (running) {
        await running;
      }
    },
  };
}
