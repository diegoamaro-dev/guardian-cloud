/**
 * GC-DEST-PAUSE-001 — retiring a destination pause whose cause is gone.
 *
 * The defect, observed on hardware 2026-08-21: `destinations[type]` could
 * be written and never removed. `client_auth` had a recovery signal and a
 * handler; `destinations` had neither. A Drive pause survived reconnecting
 * Drive AND survived a cold start, leaving 54 chunks pending and 0
 * uploading indefinitely. Evidence stayed durable and local — nothing was
 * ever lost — but it could not leave the device.
 *
 * The one accepted signal is the backend confirming THIS destination:
 * `listDestinations()` returning `type === T && status === 'connected'`.
 * That is the direct negation of the 409 `DRIVE_NOT_CONNECTED` that
 * created the pause.
 *
 * `destinationResolved` is explicitly NOT proof — it is a race guard that
 * `refreshDestination` sets to true even with nothing connected (the
 * routing line falls back to 'drive'). Test 13 pins that. Elapsed time is
 * not proof either: `at` is never read.
 *
 * ── What is NOT proven here ──────────────────────────────────────────
 * `refreshDestination` itself is a closure inside a React component, so
 * these drive `clearRecoveredDestinationPauses` — the exported unit the
 * component calls — plus the real queue and pause stores. That the
 * component calls it with the `status === 'connected'` rows rather than
 * with `destinationResolved` is a source-order property, checked by
 * reading the call site and by test 13's contract.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      __store__: store,
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
      setItem: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      removeItem: vi.fn(async (k: string) => {
        store.delete(k);
      }),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const k of keys) store.delete(k);
      }),
      getAllKeys: vi.fn(async () => Array.from(store.keys())),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

const getToken = vi.fn(async () => 'test-token' as string | null);
vi.mock('@/auth/store', () => ({
  // Identity and ownership are already valid in the modelled state.
  assertOwnershipGateOpen: vi.fn(),
  isOwnershipGateOpen: vi.fn(() => true),
  useAuthStore: { setState: vi.fn(), getState: vi.fn(() => ({ status: 'loading' })) },
  getFreshAccessToken: (...a: unknown[]) =>
    (getToken as unknown as (...x: unknown[]) => unknown)(...a),
  getOwnershipAccessToken: (...a: unknown[]) =>
    (getToken as unknown as (...x: unknown[]) => unknown)(...a),
}));

const uploadChunkBytes = vi.fn();
vi.mock('@/api/destinations', () => ({
  getConnectedDrive: vi.fn(async () => ({ id: 'd1', type: 'drive', connected: true })),
  listDestinations: vi.fn(async () => ({ destinations: [] })),
  uploadChunkBytes: (...a: unknown[]) =>
    (uploadChunkBytes as unknown as (...x: unknown[]) => unknown)(...a),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  GLOBAL_PAUSE_KEY,
  emptyPauseState,
  isDestinationBlocked,
  readState as readPauseState,
  writeState as writePauseState,
  _resetPauseStoreForTests,
  type GlobalPauseState,
} from '@/upload/pauseStore';
import {
  PENDING_RETRY_KEY,
  clearRecoveredDestinationPauses,
  queueAppendNewSession,
  queueRead,
  uploadDrainLoop,
  _setDrainPreconditionsForTests,
} from '../app/index';

const store = (
  AsyncStorage as unknown as { __store__: Map<string, string> }
).__store__;

const SID = 'aee2cd23-7320-44c2-86c8-0198f4eb47a5';

/** Seed a pause state directly, the way a failed upload would have. */
function seedPause(partial: Partial<GlobalPauseState>) {
  const state: GlobalPauseState = { ...emptyPauseState(), ...partial };
  store.set(GLOBAL_PAUSE_KEY, JSON.stringify(state));
}
const drivePaused = () => ({
  destinations: { drive: { at: 1787359989465, code: 'DRIVE_NOT_CONNECTED' } },
});

/** The hardware shape, with cardinality preserved but not 54 real payloads. */
function seedQueue(pendingCount: number) {
  const chunks = Array.from({ length: pendingCount }, (_, i) => ({
    chunk_index: i,
    hash: 'h'.repeat(64),
    size: 4,
    status: 'pending' as const,
    attempts: 0,
    base64Slice: 'AAAA',
  }));
  return queueAppendNewSession({
    session_id: SID,
    uri: `file:///cache/rec.aac`,
    recording_closed: true,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: pendingCount,
    destination_type: 'drive',
    chunks,
  });
}

beforeEach(async () => {
  store.clear();
  vi.clearAllMocks();
  _resetPauseStoreForTests();
  uploadChunkBytes.mockReset();
  _setDrainPreconditionsForTests({
    destinationResolved: true,
    activeDestinationType: 'drive',
  });
});

describe('GC_DEST_PAUSE_001_ONLY_A_CONFIRMED_DESTINATION_CLEARS', () => {
  it('1. Drive still broken → the pause REMAINS', async () => {
    seedPause(drivePaused());

    const cleared = await clearRecoveredDestinationPauses({ drive: false });

    expect(cleared).toEqual([]);
    expect(isDestinationBlocked(await readPauseState(), 'drive')).toBe(true);
  });

  it('2. Drive confirmed connected → the pause is RETIRED', async () => {
    seedPause(drivePaused());

    const cleared = await clearRecoveredDestinationPauses({ drive: true });

    expect(cleared).toEqual(['drive']);
    expect(isDestinationBlocked(await readPauseState(), 'drive')).toBe(false);
  });

  it('3. same, across a cold start — the store is rehydrated from disk', async () => {
    seedPause(drivePaused());
    // Models a new process: caches dropped, only AsyncStorage survives.
    _resetPauseStoreForTests();

    const cleared = await clearRecoveredDestinationPauses({ drive: true });

    expect(cleared).toEqual(['drive']);
    _resetPauseStoreForTests();
    expect(isDestinationBlocked(await readPauseState(), 'drive')).toBe(false);
  });

  it('7. a FAILED reconnection leaves the pause in place', async () => {
    seedPause(drivePaused());

    // `status: 'error'` / `'revoked'` never reaches this function as true.
    const cleared = await clearRecoveredDestinationPauses({ drive: false });

    expect(cleared).toEqual([]);
    expect((await readPauseState()).destinations.drive?.code).toBe(
      'DRIVE_NOT_CONNECTED',
    );
  });

  it('13. CONTRACT: a truthy destinationResolved is NOT an input here', async () => {
    // The function's only input is per-destination confirmation. There is
    // no parameter through which `destinationResolved` could leak in, and
    // "nothing connected" cannot clear anything — which is the exact
    // hardware state (destinationResolved:true + Drive disconnected).
    seedPause(drivePaused());

    const cleared = await clearRecoveredDestinationPauses({
      drive: false,
      nas: false,
    });

    expect(cleared).toEqual([]);
    expect(isDestinationBlocked(await readPauseState(), 'drive')).toBe(true);
  });

  it('elapsed time is never consulted: an ancient pause still needs proof', async () => {
    seedPause({
      destinations: { drive: { at: 1, code: 'DRIVE_NOT_CONNECTED' } },
    });

    expect(await clearRecoveredDestinationPauses({ drive: false })).toEqual([]);
    expect(isDestinationBlocked(await readPauseState(), 'drive')).toBe(true);
  });
});

describe('GC_DEST_PAUSE_001_SCOPE_DISCIPLINE', () => {
  it('4. a NAS pause is untouched when only Drive reconnects', async () => {
    seedPause({
      destinations: {
        drive: { at: 1, code: 'DRIVE_NOT_CONNECTED' },
        nas: { at: 2, code: 'DRIVE_REFRESH_FAILED' },
      },
    });

    const cleared = await clearRecoveredDestinationPauses({ drive: true });

    expect(cleared).toEqual(['drive']);
    const after = await readPauseState();
    expect(isDestinationBlocked(after, 'drive')).toBe(false);
    expect(isDestinationBlocked(after, 'nas')).toBe(true);
    expect(after.destinations.nas?.code).toBe('DRIVE_REFRESH_FAILED');
  });

  it('5. client_auth is never cleared by a destination recovery', async () => {
    seedPause({
      client_auth: { at: 1, code: 'NO_TOKEN' },
      ...drivePaused(),
    });

    await clearRecoveredDestinationPauses({ drive: true });

    const after = await readPauseState();
    expect(after.client_auth).toEqual({ at: 1, code: 'NO_TOKEN' });
    expect(isDestinationBlocked(after, 'drive')).toBe(false);
  });

  it('6. systemic is never cleared by a destination recovery', async () => {
    seedPause({
      systemic: { at: 1, code: 'BODY_TOO_LARGE', policy_version: 1 },
      ...drivePaused(),
    });

    await clearRecoveredDestinationPauses({ drive: true });

    const after = await readPauseState();
    expect(after.systemic).toEqual({
      at: 1,
      code: 'BODY_TOO_LARGE',
      policy_version: 1,
    });
  });

  it('a destination that was never paused is not "cleared"', async () => {
    seedPause(drivePaused());

    const cleared = await clearRecoveredDestinationPauses({
      drive: true,
      nas: true,
    });

    // NAS had no pause: it cannot be reported as a transition.
    expect(cleared).toEqual(['drive']);
  });
});

describe('GC_DEST_PAUSE_001_TRANSITION_IS_ATOMIC', () => {
  it('14. two concurrent invocations produce exactly ONE transition', async () => {
    seedPause(drivePaused());

    const [a, b] = await Promise.all([
      clearRecoveredDestinationPauses({ drive: true }),
      clearRecoveredDestinationPauses({ drive: true }),
    ]);

    const winners = [...a, ...b];
    expect(winners).toEqual(['drive']);
    expect(isDestinationBlocked(await readPauseState(), 'drive')).toBe(false);
  });

  it('a repeat after the transition reports nothing — idempotent', async () => {
    seedPause(drivePaused());

    expect(await clearRecoveredDestinationPauses({ drive: true })).toEqual([
      'drive',
    ]);
    expect(await clearRecoveredDestinationPauses({ drive: true })).toEqual([]);
  });

  it('ORDER: no confirmation → 0 transitions; then confirmation → exactly 1', async () => {
    await seedQueue(3);
    seedPause(drivePaused());
    const before = await queueRead();

    // Backend does not yet confirm.
    expect(await clearRecoveredDestinationPauses({ drive: false })).toEqual([]);
    expect(isDestinationBlocked(await readPauseState(), 'drive')).toBe(true);

    // Backend confirms.
    expect(await clearRecoveredDestinationPauses({ drive: true })).toEqual([
      'drive',
    ]);
    expect(isDestinationBlocked(await readPauseState(), 'drive')).toBe(false);

    // Same session and chunk identities throughout.
    const after = await queueRead();
    expect(after[0]?.session_id).toBe(before[0]?.session_id);
    expect(after[0]?.chunks.map(c => c.chunk_index)).toEqual(
      before[0]?.chunks.map(c => c.chunk_index),
    );
  });
});

describe('GC_DEST_PAUSE_001_NEVER_TOUCHES_EVIDENCE', () => {
  it('11. no clear path may alter GC_QUEUE or its chunks', async () => {
    await seedQueue(54);
    seedPause(drivePaused());
    const raw = store.get(PENDING_RETRY_KEY);

    await clearRecoveredDestinationPauses({ drive: true });

    // Byte-identical: the pause store and the queue are separate keys and
    // the clear touches only the former.
    expect(store.get(PENDING_RETRY_KEY)).toBe(raw);
    const q = await queueRead();
    expect(q).toHaveLength(1);
    expect(q[0]?.chunks).toHaveLength(54);
    expect(q[0]?.chunks.every(c => c.status === 'pending')).toBe(true);
  });

  it('a clear on an empty queue is harmless', async () => {
    seedPause(drivePaused());

    await clearRecoveredDestinationPauses({ drive: true });

    expect(await queueRead()).toEqual([]);
  });
});

describe('GC_DEST_PAUSE_001_END_TO_END_HARDWARE_SHAPE', () => {
  /**
   * The state observed on hardware, with cardinality preserved: pending
   * chunks under one session, a durable Drive pause, identity and
   * ownership already valid. Drive starts disconnected.
   */
  it('12. paused → confirmed → drain resumes and a remote_reference appears', async () => {
    await seedQueue(3);
    seedPause(drivePaused());
    uploadChunkBytes.mockResolvedValue({
      remote_reference: '1AbCdEfGh',
      dedup: null,
    });
    const fetchMock = vi.fn(async (..._a: unknown[]) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{}',
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);

    // ── Drive still disconnected: the drain must send nothing.
    await uploadDrainLoop().catch(() => {});
    expect(uploadChunkBytes).not.toHaveBeenCalled();
    expect((await queueRead())[0]?.chunks.every(c => c.status === 'pending')).toBe(
      true,
    );

    // ── Drive genuinely becomes connected.
    const cleared = await clearRecoveredDestinationPauses({ drive: true });
    expect(cleared).toEqual(['drive']);

    // ── Only the Drive pause is gone; the queue is the same queue.
    const after = await readPauseState();
    expect(isDestinationBlocked(after, 'drive')).toBe(false);
    expect(after.client_auth).toBeNull();
    expect(after.systemic).toBeNull();
    const q = await queueRead();
    expect(q).toHaveLength(1);
    expect(q[0]?.session_id).toBe(SID);

    // ── The drain runs again and the chunks go through the real path.
    await uploadDrainLoop().catch(() => {});
    expect(uploadChunkBytes.mock.calls.length).toBeGreaterThan(0);

    // `remote_reference` is observed where it is actually carried: the
    // POST /chunks body. Asserting it on the queue entry would be wrong —
    // this session converges fully (upload → /complete → reap), so by the
    // time the drain returns the entry is legitimately gone. That is the
    // stronger result, and the assertion has to match it.
    const chunkPosts = fetchMock.mock.calls.filter(c =>
      String(c[0]).endsWith('/chunks'),
    );
    expect(chunkPosts.length).toBeGreaterThan(0);
    const bodies = chunkPosts.map(c =>
      JSON.parse(String((c[1] as { body?: unknown })?.body ?? '{}')),
    );
    expect(bodies.some(b => b.remote_reference === '1AbCdEfGh')).toBe(true);

    // Full convergence: the queue emptied because the session completed,
    // not because anything was discarded while still pending.
    expect(await queueRead()).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('TEETH: with the pause still in force the same drain uploads NOTHING', async () => {
    // Guards test 12 against passing for the wrong reason. If the drain
    // never reaches uploadChunkBytes even when unblocked, 12 proves
    // nothing — and if it uploads while paused, the pause is not enforced.
    await seedQueue(3);
    seedPause(drivePaused());
    uploadChunkBytes.mockResolvedValue({ remote_reference: 'x', dedup: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({}),
      })),
    );

    await uploadDrainLoop().catch(() => {});
    expect(uploadChunkBytes).not.toHaveBeenCalled();

    await clearRecoveredDestinationPauses({ drive: true });
    await uploadDrainLoop().catch(() => {});
    expect(uploadChunkBytes.mock.calls.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });
});
