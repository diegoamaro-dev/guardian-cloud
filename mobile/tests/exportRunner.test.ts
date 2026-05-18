/**
 * Unit tests for the export-runner singleton.
 *
 * Coverage:
 *   - fresh state is `idle`
 *   - subscribe replays the current status synchronously
 *   - startExport happy path → running → progress → done
 *   - second startExport while running is rejected (anti double-export)
 *   - cancelExport for matching sessionId aborts the controller and
 *     resolves to `cancelled` via `result.stopReason === 'cancelled'`
 *   - cancelExport for wrong sessionId returns false, no state change
 *   - exportSession reject is folded into `error` state (defence in depth)
 *   - clearExport works on terminal states, no-op on running
 *   - stale callback filter: cancel + restart drops the first run's
 *     late progress/result
 *
 * `exportSession` is mocked at module level so each test controls its
 * resolve/reject and onProgress timing precisely. The runner is reset
 * to a pristine state before every test via `__resetExportRunnerForTests`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExportProgress, ExportResult } from '../src/api/export';

// Hoisted mock state. Each test installs its own controlled
// `exportSession` implementation via `mockExportSession`.
const exportSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../src/api/export', () => ({
  exportSession: exportSessionMock,
}));

import {
  __resetExportRunnerForTests,
  cancelExport,
  clearExport,
  getExportStatus,
  isExportActive,
  startExport,
  subscribeExport,
  type ExportRunnerStatus,
} from '../src/api/exportRunner';

/**
 * Flush microtasks AND one macrotask cycle so any pending async/await
 * chain in `startExport`'s IIFE has resolved before we assert on state.
 *
 * `await Promise.resolve()` alone is not enough: the export mock returns
 * `new Promise(...)` from inside an `async` wrapper, so the IIFE must
 * advance through TWO awaits (the outer wrapper's implicit await, then
 * the inner promise) before the post-await setStatus runs. A single
 * setTimeout(0) macrotask covers both with margin.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// --- Helpers -----------------------------------------------------------

function completeResult(overrides: Partial<ExportResult> = {}): ExportResult {
  return {
    status: 'complete',
    filePath: '/mock/file.aac',
    totalChunks: 3,
    validChunks: 3,
    missingIndexes: [],
    corruptIndexes: [],
    extension: '.aac',
    stoppedAt: -1,
    stopReason: null,
    ...overrides,
  };
}

function cancelledResult(): ExportResult {
  return {
    status: 'failed',
    filePath: null,
    totalChunks: 0,
    validChunks: 0,
    missingIndexes: [],
    corruptIndexes: [],
    extension: null,
    stoppedAt: null,
    stopReason: 'cancelled',
  };
}

/**
 * Install a controlled `exportSession` mock that:
 *   - records each invocation's args (sessionId, onProgress, mode, signal);
 *   - exposes manual `fireProgress`, `resolve`, `reject` helpers so the
 *     test can drive the export's lifecycle without timing flake.
 */
function installControllableExportSession() {
  let onProgressCb: ((p: ExportProgress) => void) | undefined;
  let receivedSignal: AbortSignal | undefined;
  let resolveFn: (r: ExportResult) => void = () => {};
  let rejectFn: (err: unknown) => void = () => {};

  exportSessionMock.mockImplementation(
    async (
      _sessionId: string,
      onProgress?: (p: ExportProgress) => void,
      _mode?: unknown,
      signal?: AbortSignal,
    ) => {
      onProgressCb = onProgress;
      receivedSignal = signal;
      return new Promise<ExportResult>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
        // If the test ABORTS the signal AFTER installation but BEFORE
        // resolving manually, fold the abort into a cancelled result.
        signal?.addEventListener('abort', () => {
          res(cancelledResult());
        });
      });
    },
  );

  return {
    fireProgress: (p: ExportProgress) => onProgressCb?.(p),
    resolveWith: (r: ExportResult) => resolveFn(r),
    rejectWith: (err: unknown) => rejectFn(err),
    getSignal: () => receivedSignal,
  };
}

// --- Setup -------------------------------------------------------------

beforeEach(() => {
  __resetExportRunnerForTests();
  exportSessionMock.mockReset();
});

afterEach(() => {
  __resetExportRunnerForTests();
});

// --- Tests -------------------------------------------------------------

describe('exportRunner — initial state', () => {
  it('starts in idle', () => {
    expect(getExportStatus()).toEqual({ kind: 'idle' });
    expect(isExportActive()).toBe(false);
  });
});

describe('exportRunner — subscribe replay', () => {
  it('notifies the listener synchronously with the current status', () => {
    const listener = vi.fn();
    subscribeExport(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ kind: 'idle' });
  });

  it('replays the live state to a late subscriber', () => {
    installControllableExportSession();
    const accepted = startExport('sess-a', 'audio');
    expect(accepted).toBe(true);

    const lateListener = vi.fn();
    subscribeExport(lateListener);
    // Initial replay should be the current 'running' state, not the
    // 'idle' state at module load.
    expect(lateListener).toHaveBeenCalledTimes(1);
    const firstCall = lateListener.mock.calls[0]?.[0] as ExportRunnerStatus;
    expect(firstCall.kind).toBe('running');
    if (firstCall.kind === 'running') {
      expect(firstCall.sessionId).toBe('sess-a');
    }
  });
});

describe('exportRunner — happy path', () => {
  it('transitions idle → running → done', async () => {
    const ctrl = installControllableExportSession();
    const events: ExportRunnerStatus[] = [];
    subscribeExport((s) => events.push(s));

    const accepted = startExport('sess-1', 'audio');
    expect(accepted).toBe(true);
    expect(isExportActive()).toBe(true);

    // After the initial replay (idle) and the synchronous running
    // transition, the listener has seen exactly 2 states.
    expect(events.map((e) => e.kind)).toEqual(['idle', 'running']);

    ctrl.fireProgress({ total: 3, done: 1, currentIndex: 1 });
    const runningState = events[events.length - 1];
    expect(runningState?.kind).toBe('running');
    if (runningState?.kind === 'running') {
      expect(runningState.progress).toEqual({
        total: 3,
        done: 1,
        currentIndex: 1,
      });
    }

    const result = completeResult();
    ctrl.resolveWith(result);
    await flush();

    const finalState = getExportStatus();
    expect(finalState.kind).toBe('done');
    if (finalState.kind === 'done') {
      expect(finalState.result).toEqual(result);
      expect(finalState.sessionId).toBe('sess-1');
      expect(finalState.mode).toBe('audio');
    }
    expect(isExportActive()).toBe(false);
  });
});

describe('exportRunner — anti double-export', () => {
  it('rejects a second startExport while running', () => {
    installControllableExportSession();
    expect(startExport('sess-1')).toBe(true);
    // Second call while running must be rejected with no state change.
    const statusBefore = getExportStatus();
    expect(startExport('sess-2')).toBe(false);
    expect(getExportStatus()).toEqual(statusBefore);
  });

  it('allows startExport after the previous run reached a terminal state', async () => {
    const ctrl = installControllableExportSession();
    expect(startExport('sess-1')).toBe(true);
    ctrl.resolveWith(completeResult());
    await flush();
    expect(getExportStatus().kind).toBe('done');

    // Done → new startExport is accepted; runner replaces the state.
    const ctrl2 = installControllableExportSession();
    expect(startExport('sess-2')).toBe(true);
    expect(getExportStatus().kind).toBe('running');
    ctrl2.resolveWith(completeResult({ filePath: '/mock/other.aac' }));
    await flush();
    expect(getExportStatus().kind).toBe('done');
  });
});

describe('exportRunner — cancellation', () => {
  it('aborts the in-flight run and transitions to cancelled', async () => {
    const ctrl = installControllableExportSession();
    startExport('sess-1', 'audio');
    expect(ctrl.getSignal()).toBeDefined();
    expect(ctrl.getSignal()?.aborted).toBe(false);

    const cancelled = cancelExport('sess-1');
    expect(cancelled).toBe(true);
    expect(ctrl.getSignal()?.aborted).toBe(true);

    // The mock's signal listener resolves with a cancelled result; let
    // the IIFE pick that up.
    await flush();

    const finalState = getExportStatus();
    expect(finalState.kind).toBe('cancelled');
    if (finalState.kind === 'cancelled') {
      expect(finalState.sessionId).toBe('sess-1');
    }
    expect(isExportActive()).toBe(false);
  });

  it('returns false for a sessionId that does not match the in-flight run', () => {
    const ctrl = installControllableExportSession();
    startExport('sess-1');
    const statusBefore = getExportStatus();
    expect(cancelExport('sess-other')).toBe(false);
    expect(getExportStatus()).toEqual(statusBefore);
    expect(ctrl.getSignal()?.aborted).toBe(false);
  });

  it('returns false when no export is in flight', () => {
    expect(cancelExport('any-sid')).toBe(false);
    expect(getExportStatus()).toEqual({ kind: 'idle' });
  });
});

describe('exportRunner — error path', () => {
  it('folds a thrown exportSession into error status', async () => {
    const ctrl = installControllableExportSession();
    startExport('sess-err');
    ctrl.rejectWith(new Error('boom'));
    await flush();

    const finalState = getExportStatus();
    expect(finalState.kind).toBe('error');
    if (finalState.kind === 'error') {
      expect(finalState.sessionId).toBe('sess-err');
      expect(finalState.message).toBe('boom');
    }
    expect(isExportActive()).toBe(false);
  });
});

describe('exportRunner — clearExport', () => {
  it('resets done to idle', async () => {
    const ctrl = installControllableExportSession();
    startExport('sess-1');
    ctrl.resolveWith(completeResult());
    await flush();
    expect(getExportStatus().kind).toBe('done');

    clearExport();
    expect(getExportStatus()).toEqual({ kind: 'idle' });
  });

  it('is a no-op while running', () => {
    installControllableExportSession();
    startExport('sess-1');
    const before = getExportStatus();
    clearExport();
    expect(getExportStatus()).toEqual(before);
  });

  it('is a no-op when already idle', () => {
    const listener = vi.fn();
    subscribeExport(listener);
    listener.mockClear();
    clearExport();
    // No transition → no listener fire.
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('exportRunner — stale-callback filter', () => {
  it('drops late progress from a cancelled run', async () => {
    const ctrl = installControllableExportSession();
    startExport('sess-1');
    expect(getExportStatus().kind).toBe('running');

    // Cancel the first run; the mock resolves it with a cancelled
    // result via the signal listener.
    cancelExport('sess-1');
    await flush();
    expect(getExportStatus().kind).toBe('cancelled');

    // Start a fresh run; the OLD controller's progress callback fires
    // belatedly with a stale value. It MUST be dropped — the new run
    // is the only one allowed to update state.
    const ctrl2 = installControllableExportSession();
    startExport('sess-2');
    const beforeStaleFire = getExportStatus();
    ctrl.fireProgress({ total: 999, done: 999, currentIndex: 999 });
    expect(getExportStatus()).toEqual(beforeStaleFire);

    // Live progress from the NEW run still works.
    ctrl2.fireProgress({ total: 5, done: 1, currentIndex: 1 });
    const live = getExportStatus();
    expect(live.kind).toBe('running');
    if (live.kind === 'running') {
      expect(live.progress).toEqual({ total: 5, done: 1, currentIndex: 1 });
    }
  });
});

describe('exportRunner — unsubscribe', () => {
  it('stops delivering events after unsubscribe', () => {
    const listener = vi.fn();
    const unsub = subscribeExport(listener);
    listener.mockClear();
    unsub();

    installControllableExportSession();
    startExport('sess-1');
    expect(listener).not.toHaveBeenCalled();
  });
});
