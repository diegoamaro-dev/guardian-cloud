/**
 * Cleanup scheduler — coalescing, the pending invariant, and isolation.
 *
 * The property that matters most here is the one that is easiest to get wrong:
 * a request arriving WHILE a pass is running must produce exactly one more
 * pass. Not zero — that loses work authorized after the runner took its
 * snapshot, which is the bug this scheduler exists to fix. Not one per request
 * either — that would spin.
 *
 * The second property is that nothing escapes: a runner that throws must not
 * reach the caller, must not leave the scheduler wedged, and must not put
 * anything from the exception into a log.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createCleanupScheduler,
  type CleanupScheduler,
  type CleanupTriggerReason,
} from '@/video/sessionCleanupScheduler';

interface LoggedCall {
  event: string;
  fields?: Record<string, unknown>;
}

interface Harness {
  scheduler: CleanupScheduler;
  reconcile: ReturnType<typeof vi.fn>;
  logs: LoggedCall[];
  /** Resolves the currently blocked reconcile, if `gate()` was armed. */
  release: () => void;
  /** Blocks every reconcile until `release()` is called. */
  gate: () => void;
}

function makeHarness(): Harness {
  const logs: LoggedCall[] = [];
  let blocker: Promise<void> | null = null;
  let release!: () => void;

  const reconcile = vi.fn(async () => {
    if (blocker) await blocker;
  });

  const scheduler = createCleanupScheduler({
    runner: { reconcile: reconcile as unknown as () => Promise<unknown> },
    logger: {
      log: (event, fields) => {
        logs.push(fields === undefined ? { event } : { event, fields });
      },
    },
  });

  return {
    scheduler,
    reconcile,
    logs,
    gate: () => {
      blocker = new Promise<void>((r) => {
        release = () => {
          blocker = null;
          r();
        };
      });
    },
    release: () => release(),
  };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('cleanup scheduler', () => {
  it('runs one pass for a single request', async () => {
    const h = makeHarness();
    h.scheduler.requestCleanup('boot');
    await h.scheduler.whenIdle();

    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('returns void — nothing for a caller to await or catch', () => {
    const h = makeHarness();
    const returned: unknown = h.scheduler.requestCleanup('finalized');
    expect(returned).toBeUndefined();
  });

  it('collapses two simultaneous requests into a single execution', async () => {
    const h = makeHarness();
    h.gate();

    h.scheduler.requestCleanup('boot');
    h.scheduler.requestCleanup('finalized');
    await flush();

    // The second arrived before the first pass began its work; both are served
    // by that one pass.
    expect(h.reconcile).toHaveBeenCalledTimes(1);

    h.release();
    await h.scheduler.whenIdle();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('a request arriving DURING a pass produces exactly one more pass', async () => {
    const h = makeHarness();
    h.gate();

    h.scheduler.requestCleanup('boot');
    await flush();
    expect(h.reconcile).toHaveBeenCalledTimes(1);

    // Arrives after the flag was cleared and while reconcile is still running:
    // the case a snapshot taken at the start of that pass cannot cover.
    h.scheduler.requestCleanup('finalized');
    h.release();
    await h.scheduler.whenIdle();

    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('collapses MANY requests during one pass into exactly one more pass', async () => {
    const h = makeHarness();
    h.gate();

    h.scheduler.requestCleanup('boot');
    await flush();

    for (const reason of [
      'finalized',
      'finalized',
      'stale_reconciled',
      'finalized',
    ] as CleanupTriggerReason[]) {
      h.scheduler.requestCleanup(reason);
    }
    h.release();
    await h.scheduler.whenIdle();

    // Two passes total, not five: the flag is a boolean, not a counter.
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('does not keep running once no request is outstanding', async () => {
    const h = makeHarness();
    h.scheduler.requestCleanup('boot');
    await h.scheduler.whenIdle();
    await flush();
    await flush();

    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('swallows a runner throw and stays usable', async () => {
    const h = makeHarness();
    h.reconcile.mockRejectedValueOnce(new Error('runner exploded'));

    // No throw reaches here, and there is no rejected promise to handle.
    expect(() => h.scheduler.requestCleanup('finalized')).not.toThrow();
    await h.scheduler.whenIdle();
    expect(h.reconcile).toHaveBeenCalledTimes(1);

    // A later request still runs: the scheduler is not wedged.
    h.scheduler.requestCleanup('boot');
    await h.scheduler.whenIdle();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('still serves a request that arrived during a failing pass', async () => {
    const h = makeHarness();
    // No gate here: the failing implementation already yields, which is all
    // this case needs to land a request mid-pass. Gating as well would block
    // the second pass on a release that never comes.
    h.reconcile.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 0));
      throw new Error('runner exploded');
    });

    h.scheduler.requestCleanup('boot');
    await flush();
    h.scheduler.requestCleanup('finalized');
    await h.scheduler.whenIdle();

    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('logs only closed reasons, never anything from the exception', async () => {
    const h = makeHarness();
    const leaky =
      '/data/user/0/com.guardiancloud.app/cache/gc-segmented-recorder/11111111-1111-4111-8111-111111111111/seg_000.mp4';
    h.reconcile.mockRejectedValueOnce(new Error(`ENOENT deleting ${leaky}`));

    h.scheduler.requestCleanup('finalized');
    await h.scheduler.whenIdle();

    const dump = JSON.stringify(h.logs);
    expect(dump).not.toContain(leaky);
    expect(dump).not.toContain('ENOENT');
    expect(dump).not.toContain('seg_000.mp4');
    expect(dump).not.toContain('11111111-1111-4111-8111-111111111111');

    const failure = h.logs.find((l) => l.event === 'GC_CLEANUP_SCHEDULER_FAILED');
    expect(failure?.fields).toEqual({ reason: 'reconcile_threw' });
  });

  it('records the trigger reason from the closed set', async () => {
    const h = makeHarness();
    for (const reason of ['finalized', 'boot', 'stale_reconciled'] as const) {
      h.scheduler.requestCleanup(reason);
      await h.scheduler.whenIdle();
    }

    const reasons = h.logs
      .filter((l) => l.event === 'GC_CLEANUP_REQUESTED')
      .map((l) => l.fields?.reason);
    expect(reasons).toEqual(['finalized', 'boot', 'stale_reconciled']);
  });

  it('whenIdle resolves only after the extra pass has run', async () => {
    const h = makeHarness();
    h.gate();

    h.scheduler.requestCleanup('boot');
    await flush();
    h.scheduler.requestCleanup('finalized');

    let settled = false;
    const idle = h.scheduler.whenIdle().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    h.release();
    await idle;
    expect(settled).toBe(true);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it('never invents work: with no request, the runner is never called', async () => {
    const h = makeHarness();
    await h.scheduler.whenIdle();
    await flush();

    // A session with no journal entry stays invisible because nothing asks, and
    // because the runner itself only ever reads the journal.
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});
