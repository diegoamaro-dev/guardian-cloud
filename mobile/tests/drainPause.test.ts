/**
 * Phase 1A — the worker must not issue an identical request it cannot
 * repair, and must not issue ANY request before it has read the
 * persisted pause from disk.
 *
 * These tests drive the real `uploadDrainLoop` over an in-memory
 * AsyncStorage. The proxy for "a network request happened" is
 * `getFreshAccessToken`: the worker calls it once per chunk attempt,
 * before `uploadChunkBytes`, so a zero call count proves nothing left
 * the device.
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

const getFreshAccessToken = vi.fn(async (): Promise<string | null> => null);
vi.mock('@/auth/store', () => ({
  // R6: no-op = ownership gate open. Tests that need it SHUT override it.
  assertOwnershipGateOpen: vi.fn(),
  isOwnershipGateOpen: vi.fn(() => true),
  useAuthStore: { setState: vi.fn(), getState: vi.fn(() => ({ status: 'loading' })) },
  getFreshAccessToken: (...a: unknown[]) =>
    (getFreshAccessToken as unknown as (...x: unknown[]) => Promise<string | null>)(...a),
  // R5: ownership callers use a distinct accessor; same spy so existing
  // assertions about token attempts keep counting the same thing.
  getOwnershipAccessToken: (...a: unknown[]) =>
    (getFreshAccessToken as unknown as (...x: unknown[]) => Promise<string | null>)(...a),
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
  PENDING_RETRY_KEY,
  queueAppendNewSession,
  uploadDrainLoop,
  _setDrainPreconditionsForTests,
  type PendingQueueEntry,
  type QueueChunk,
} from '../app/index';
import {
  GLOBAL_PAUSE_KEY,
  emptyPauseState,
  ensureReady,
  readState,
  _resetPauseStoreForTests,
} from '../src/upload/pauseStore';

const storage = AsyncStorage as unknown as { __store__: Map<string, string> };

const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function chunk(idx: number): QueueChunk {
  return {
    chunk_index: idx,
    hash: String(idx).repeat(64).slice(0, 64),
    size: 4,
    status: 'pending',
    attempts: 0,
    base64Slice: 'AAAA',
  };
}

function entry(sid: string, overrides: Partial<PendingQueueEntry> = {}): PendingQueueEntry {
  return {
    session_id: sid,
    uri: `file:///doc/${sid}.m4a`,
    recording_closed: true,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 1,
    chunks: [chunk(0)],
    destination_type: 'drive',
    ...overrides,
  };
}

async function seed(entries: PendingQueueEntry[]): Promise<void> {
  storage.__store__.set(PENDING_RETRY_KEY, JSON.stringify(entries));
}

/** Drop in-process state; storage survives, exactly as on a cold start. */
function simulateRestart(): void {
  _resetPauseStoreForTests();
}

beforeEach(async () => {
  storage.__store__.clear();
  _resetPauseStoreForTests();
  vi.clearAllMocks();
  getFreshAccessToken.mockResolvedValue(null);
  _setDrainPreconditionsForTests({
    destinationResolved: true,
    activeDestinationType: 'drive',
  });
});

describe('TEST_NO_TOKEN_STOPS_ALL_NETWORK_RETRIES', () => {
  it('a NO_TOKEN failure pauses globally and the next drain sends nothing', async () => {
    await seed([entry(SID_A)]);

    await uploadDrainLoop();
    const afterFirst = getFreshAccessToken.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const state = await readState();
    expect(state.client_auth).not.toBeNull();

    // Every later drain is a no-op. This is the storm's exit condition.
    await uploadDrainLoop();
    await uploadDrainLoop();
    expect(getFreshAccessToken).toHaveBeenCalledTimes(afterFirst);
  });

  it('the paused chunk keeps its bytes and stays pending, not failed', async () => {
    await seed([entry(SID_A)]);
    await uploadDrainLoop();

    const q = JSON.parse(
      storage.__store__.get(PENDING_RETRY_KEY) as string,
    ) as PendingQueueEntry[];
    const c = q[0]?.chunks[0];
    expect(c?.base64Slice).toBe('AAAA');
    expect(c?.hash).toBe(chunk(0).hash);
    expect(c?.chunk_index).toBe(0);
    expect(c?.status).toBe('pending');
  });
});

describe('TEST_NO_TOKEN_DOES_NOT_REPEAT_ONCE_PER_ENTRY', () => {
  it('three entries produce ONE token attempt, not three', async () => {
    await seed([entry(SID_A), entry(SID_B), entry('cccccccc-cccc-4ccc-8ccc-cccccccccccc')]);

    await uploadDrainLoop();

    // The old behaviour asked once per entry and then looped forever.
    expect(getFreshAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe('TEST_EXISTING_PAUSE_BLOCKS_FIRST_DRAIN_AFTER_RESTART', () => {
  it('a pause written by a previous process blocks the very first drain', async () => {
    // Previous process paused, then died.
    const s = emptyPauseState();
    s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    storage.__store__.set(GLOBAL_PAUSE_KEY, JSON.stringify(s));
    await seed([entry(SID_A)]);

    simulateRestart();
    getFreshAccessToken.mockResolvedValue('a-perfectly-good-token');

    await uploadDrainLoop();

    // Not a single request, even though a token was available: the
    // pause was read from disk before anything could be sent.
    expect(getFreshAccessToken).not.toHaveBeenCalled();
    expect(uploadChunkBytes).not.toHaveBeenCalled();
  });

  it('a systemic pause from a previous process also blocks the first drain', async () => {
    const s = emptyPauseState();
    s.systemic = { at: Date.now(), code: 'BODY_TOO_LARGE', policy_version: 1 };
    storage.__store__.set(GLOBAL_PAUSE_KEY, JSON.stringify(s));
    await seed([entry(SID_A)]);

    simulateRestart();
    getFreshAccessToken.mockResolvedValue('token');

    await uploadDrainLoop();
    expect(getFreshAccessToken).not.toHaveBeenCalled();
  });
});

describe('TEST_BACKGROUND_DRAIN_WAITS_FOR_PAUSE_HYDRATION', () => {
  it('the background drain closure hits the same gate with a cold cache', async () => {
    const s = emptyPauseState();
    s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    storage.__store__.set(GLOBAL_PAUSE_KEY, JSON.stringify(s));
    await seed([entry(SID_A)]);

    simulateRestart();
    getFreshAccessToken.mockResolvedValue('token');

    // This is byte-for-byte the closure `startBackgroundProtection`
    // receives in app/index.tsx: `drain: () => uploadDrainLoop()`.
    const backgroundDrain = () => uploadDrainLoop();
    await backgroundDrain();

    expect(getFreshAccessToken).not.toHaveBeenCalled();
  });

  it('the pause key is read before any token is requested', async () => {
    await seed([entry(SID_A)]);
    simulateRestart();

    const order: string[] = [];
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (k: string) => {
      if (k === GLOBAL_PAUSE_KEY) order.push('pause-read');
      return storage.__store__.get(k) ?? null;
    });
    getFreshAccessToken.mockImplementation(async () => {
      order.push('token-request');
      return null;
    });

    await uploadDrainLoop();

    expect(order[0]).toBe('pause-read');
    expect(order).toContain('token-request');
  });
});

describe('TEST_NEW_ENTRY_INHERITS_GLOBAL_PAUSE', () => {
  it('an entry appended while paused cannot bypass the pause', async () => {
    await seed([entry(SID_A)]);
    await uploadDrainLoop();
    expect((await readState()).client_auth).not.toBeNull();

    const callsBefore = getFreshAccessToken.mock.calls.length;

    // A brand-new recording starts while the pause is in force.
    await queueAppendNewSession(entry(SID_B));
    await uploadDrainLoop();

    // Nothing is inherited because nothing is copied — the worker
    // consults the global key, so a new entry is covered by default.
    expect(getFreshAccessToken).toHaveBeenCalledTimes(callsBefore);
  });

  it('the pause survives a restart taken between the two recordings', async () => {
    await seed([entry(SID_A)]);
    await uploadDrainLoop();

    simulateRestart();
    await queueAppendNewSession(entry(SID_B));
    getFreshAccessToken.mockResolvedValue('token');
    // Baseline: the first drain above legitimately asked for a token.
    // What must not happen is a NEW request after the restart.
    const callsBefore = getFreshAccessToken.mock.calls.length;

    await uploadDrainLoop();
    expect(getFreshAccessToken).toHaveBeenCalledTimes(callsBefore);
  });
});

describe('TEST_STALE_CONNECTED_DESTINATION_CANNOT_CLEAR_DRIVE_PAUSE', () => {
  it('a Drive pause is never lifted automatically, however many drains run', async () => {
    // `getConnectedDrive` is mocked to report a healthy, connected
    // Drive — the exact "stale connected state" that must NOT be
    // mistaken for a completed reconnection.
    const s = emptyPauseState();
    s.destinations['drive'] = { at: Date.now(), code: 'DRIVE_NOT_CONNECTED' };
    storage.__store__.set(GLOBAL_PAUSE_KEY, JSON.stringify(s));
    await seed([entry(SID_A)]);

    simulateRestart();
    getFreshAccessToken.mockResolvedValue('token');

    await uploadDrainLoop();
    await uploadDrainLoop();
    await uploadDrainLoop();

    const after = await readState();
    expect(after.destinations['drive']).toBeDefined();
    expect(uploadChunkBytes).not.toHaveBeenCalled();
  });

  it('a Drive pause does not block a non-Drive entry', async () => {
    const s = emptyPauseState();
    s.destinations['drive'] = { at: Date.now(), code: 'DRIVE_NOT_CONNECTED' };
    storage.__store__.set(GLOBAL_PAUSE_KEY, JSON.stringify(s));
    await seed([entry(SID_A, { destination_type: 'nas' })]);

    simulateRestart();
    getFreshAccessToken.mockResolvedValue(null);

    await uploadDrainLoop();

    // The NAS entry was selected (a token was requested for it), which
    // proves the destination pause is scoped, not global.
    expect(getFreshAccessToken).toHaveBeenCalled();
  });
});
