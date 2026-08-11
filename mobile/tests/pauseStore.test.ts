/**
 * Phase 1A — persistence of the global blocking state.
 *
 * The property that justifies a dedicated AsyncStorage key rather than
 * a field on the queue entries: a global pause must survive a restart
 * even when the queue holds ZERO entries. `test.pending_retry` stores
 * an array; with `[]` there is nowhere to record "we are blocked".
 *
 * "Restart" is simulated by resetting the module's in-memory cache and
 * re-hydrating from the same underlying storage Map — which is exactly
 * what a fresh process does.
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
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  GLOBAL_PAUSE_KEY,
  PAUSE_POLICY_VERSION,
  emptyPauseState,
  ensureReady,
  getSnapshot,
  isDestinationBlocked,
  isGloballyBlocked,
  notifyClientAuth,
  readState,
  registerAuthRestoreHandler,
  writeState,
  _resetPauseStoreForTests,
} from '../src/upload/pauseStore';

const storage = AsyncStorage as unknown as { __store__: Map<string, string> };

/** Drop in-memory state only — storage survives, as on a real restart. */
function simulateRestart(): void {
  _resetPauseStoreForTests();
}

beforeEach(async () => {
  storage.__store__.clear();
  _resetPauseStoreForTests();
  vi.clearAllMocks();
});

describe('TEST_GLOBAL_PAUSE_SURVIVES_ZERO_ENTRIES_AND_RESTART', () => {
  it('a client-auth pause persists with no queue entries at all', async () => {
    await ensureReady();
    const s = emptyPauseState();
    s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    await writeState(s);

    // Nothing was written to the queue key — the pause does not depend
    // on the existence of a single entry.
    expect(storage.__store__.has('test.pending_retry')).toBe(false);
    expect(storage.__store__.has(GLOBAL_PAUSE_KEY)).toBe(true);

    simulateRestart();
    const after = await ensureReady();
    expect(after.client_auth).not.toBeNull();
    expect(after.client_auth?.code).toBe('NO_TOKEN');
    expect(isGloballyBlocked(after)).toBe(true);
  });

  it('a systemic pause survives restart and keeps its policy version', async () => {
    await ensureReady();
    const s = emptyPauseState();
    s.systemic = {
      at: Date.now(),
      code: 'BODY_TOO_LARGE',
      policy_version: PAUSE_POLICY_VERSION,
    };
    await writeState(s);

    simulateRestart();
    const after = await ensureReady();
    expect(after.systemic?.code).toBe('BODY_TOO_LARGE');
    expect(after.systemic?.policy_version).toBe(PAUSE_POLICY_VERSION);
    expect(isGloballyBlocked(after)).toBe(true);
  });

  it('a destination pause survives restart and blocks only that destination', async () => {
    await ensureReady();
    const s = emptyPauseState();
    s.destinations['drive'] = { at: Date.now(), code: 'DRIVE_NOT_CONNECTED' };
    await writeState(s);

    simulateRestart();
    const after = await ensureReady();
    expect(isDestinationBlocked(after, 'drive')).toBe(true);
    expect(isDestinationBlocked(after, 'nas')).toBe(false);
    // A destination pause is NOT a global block.
    expect(isGloballyBlocked(after)).toBe(false);
  });
});

describe('pauseStore — hydration discipline', () => {
  it('getSnapshot() is null before hydration — callers must not read it as "no pause"', () => {
    expect(getSnapshot()).toBeNull();
  });

  it('ensureReady() is single-flight: concurrent callers cause one read', async () => {
    const [a, b, c] = await Promise.all([ensureReady(), ensureReady(), ensureReady()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
  });

  it('a fresh install hydrates to an empty, unblocked state', async () => {
    const s = await ensureReady();
    expect(isGloballyBlocked(s)).toBe(false);
    expect(s.version).toBe(1);
  });

  it('a corrupt value hydrates to empty rather than throwing', async () => {
    storage.__store__.set(GLOBAL_PAUSE_KEY, '{not json');
    const s = await ensureReady();
    expect(isGloballyBlocked(s)).toBe(false);
  });

  it('unknown fields are dropped; known ones survive', async () => {
    storage.__store__.set(
      GLOBAL_PAUSE_KEY,
      JSON.stringify({
        version: 1,
        client_auth: { at: 123, code: 'NO_TOKEN' },
        bogus: 'ignored',
      }),
    );
    const s = await ensureReady();
    expect(s.client_auth?.at).toBe(123);
    expect((s as unknown as Record<string, unknown>)['bogus']).toBeUndefined();
  });

  it('readState() hydrates on demand', async () => {
    storage.__store__.set(
      GLOBAL_PAUSE_KEY,
      JSON.stringify({ version: 1, client_auth: { at: 5, code: 'NO_TOKEN' } }),
    );
    const s = await readState();
    expect(s.client_auth?.code).toBe('NO_TOKEN');
  });
});

describe('TEST_AUTH_EVENT_BEFORE_HYDRATION_IS_PROCESSED_ONCE', () => {
  it('an auth event fired before registration is retained and delivered once', () => {
    const seen: boolean[] = [];
    // Event arrives with NO handler registered — the §13 race.
    notifyClientAuth(true);
    registerAuthRestoreHandler(u => seen.push(u));
    expect(seen).toEqual([true]);
  });

  it('the retained event is not replayed to a later registration', () => {
    notifyClientAuth(true);
    const first: boolean[] = [];
    registerAuthRestoreHandler(u => first.push(u));
    expect(first).toEqual([true]);

    const second: boolean[] = [];
    registerAuthRestoreHandler(u => second.push(u));
    expect(second).toEqual([]);
  });

  it('only the last pre-registration event is retained', () => {
    notifyClientAuth(false);
    notifyClientAuth(true);
    const seen: boolean[] = [];
    registerAuthRestoreHandler(u => seen.push(u));
    expect(seen).toEqual([true]);
  });

  it('events after registration pass straight through', () => {
    const seen: boolean[] = [];
    registerAuthRestoreHandler(u => seen.push(u));
    notifyClientAuth(true);
    notifyClientAuth(false);
    expect(seen).toEqual([true, false]);
  });

  it('no event before registration means no delivery', () => {
    const seen: boolean[] = [];
    registerAuthRestoreHandler(u => seen.push(u));
    expect(seen).toEqual([]);
  });
});

describe('pauseStore — write durability', () => {
  it('the in-memory cache is only updated after the write lands', async () => {
    await ensureReady();
    const s = emptyPauseState();
    s.client_auth = { at: 1, code: 'NO_TOKEN' };

    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(writeState(s)).rejects.toThrow('disk full');

    // A failed write must not leave the process believing it is paused
    // (or unpaused) contrary to what is on disk.
    expect(getSnapshot()?.client_auth ?? null).toBeNull();
  });
});
