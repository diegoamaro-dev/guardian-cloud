/**
 * Phase 1A — only the matching event may lift a pause.
 *
 * Two properties are under test:
 *
 *   1. Scope discipline. A Supabase login clears CLIENT_SESSION_EXPIRED
 *      and nothing else. It must not lift a Drive pause, a systemic
 *      pause, or an entry pause — each has its own recovery event, and
 *      phase 1A deliberately ships no automatic recovery for Drive.
 *
 *   2. The restoration event cannot be lost. supabase-js can restore a
 *      persisted session before `app/index.tsx` has registered its
 *      handler; the retained notification must still be applied, and
 *      applied exactly once.
 *
 * The handler under test is the one `app/index.tsx` registers at module
 * scope, so importing the screen is what wires it up.
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
  useAuthStore: { setState: vi.fn(), getState: vi.fn(() => ({ status: 'loading' })) },
  getFreshAccessToken: (...a: unknown[]) =>
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
// Importing the screen registers the auth-restore handler at module scope.
import {
  PENDING_RETRY_KEY,
  _setDrainPreconditionsForTests,
  type PendingQueueEntry,
} from '../app/index';
import {
  GLOBAL_PAUSE_KEY,
  emptyPauseState,
  notifyClientAuth,
  readState,
  _resetPauseCacheForTests,
} from '../src/upload/pauseStore';

const storage = AsyncStorage as unknown as { __store__: Map<string, string> };
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function seedQueue(entries: PendingQueueEntry[] = []): void {
  storage.__store__.set(PENDING_RETRY_KEY, JSON.stringify(entries));
}

function seedPause(mutate: (s: ReturnType<typeof emptyPauseState>) => void): void {
  const s = emptyPauseState();
  mutate(s);
  storage.__store__.set(GLOBAL_PAUSE_KEY, JSON.stringify(s));
}

/** Wait for the fire-and-forget restore handler to settle. */
async function settle(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 5));
  }
}

beforeEach(() => {
  storage.__store__.clear();
  // Cache-only reset: a full reset would unregister the handler that
  // app/index.tsx installs at import time, which cannot be reinstalled.
  _resetPauseCacheForTests();
  vi.clearAllMocks();
  getFreshAccessToken.mockResolvedValue(null);
  _setDrainPreconditionsForTests({
    destinationResolved: true,
    activeDestinationType: 'drive',
  });
});

describe('TEST_LOGIN_CLEARS_ONLY_CLIENT_AUTH_PAUSE', () => {
  it('a usable session clears the client-auth pause', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });

    notifyClientAuth(true);
    await settle(async () => (await readState()).client_auth === null);

    expect((await readState()).client_auth).toBeNull();
  });

  it('it does NOT clear a Drive destination pause', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
      s.destinations['drive'] = { at: Date.now(), code: 'DRIVE_NOT_CONNECTED' };
    });

    notifyClientAuth(true);
    await settle(async () => (await readState()).client_auth === null);

    const after = await readState();
    expect(after.client_auth).toBeNull();
    expect(after.destinations['drive']).toBeDefined();
  });

  it('it does NOT clear a systemic pause', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
      s.systemic = { at: Date.now(), code: 'BODY_TOO_LARGE', policy_version: 1 };
    });

    notifyClientAuth(true);
    await settle(async () => (await readState()).client_auth === null);

    const after = await readState();
    expect(after.client_auth).toBeNull();
    expect(after.systemic).not.toBeNull();
  });

  it('it does NOT clear an entry-scoped pause', async () => {
    const entry: PendingQueueEntry = {
      session_id: SID,
      uri: 'file:///doc/rec.m4a',
      recording_closed: true,
      session_completed: false,
      complete_attempts: 0,
      emitted_base64_length: 0,
      next_chunk_index: 0,
      chunks: [],
      paused: { reason: 'SESSION_STATE_PAUSE', at: Date.now(), code: 'SESSION_NOT_ACTIVE' },
    };
    seedQueue([entry]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });

    notifyClientAuth(true);
    await settle(async () => (await readState()).client_auth === null);

    const q = JSON.parse(
      storage.__store__.get(PENDING_RETRY_KEY) as string,
    ) as PendingQueueEntry[];
    expect(q[0]?.paused?.reason).toBe('SESSION_STATE_PAUSE');
  });
});

describe('TEST_DRIVE_RECONNECT_DOES_NOT_CLEAR_CLIENT_AUTH_PAUSE', () => {
  it('a connected Drive leaves the Supabase pause in force', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });

    // `getConnectedDrive` reports a healthy Drive for the whole suite.
    // Nothing in phase 1A consumes that as a recovery signal, so the
    // client-auth pause must be untouched by it.
    await new Promise(r => setTimeout(r, 20));

    expect((await readState()).client_auth).not.toBeNull();
  });
});

describe('an unusable session must not clear the pause', () => {
  it('a null / token-less session is ignored', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });

    notifyClientAuth(false);
    await new Promise(r => setTimeout(r, 30));

    expect((await readState()).client_auth).not.toBeNull();
  });
});

describe('concurrent auth events', () => {
  /**
   * Counts actual drain REQUESTS. The restore handler emits this line
   * exactly once, immediately before its single `uploadDrainLoop()`
   * call, and only when its own invocation performed the
   * `client_auth: value → null` transition. So the count of this line
   * is the count of drains requested.
   */
  function countDrainRequests(spy: ReturnType<typeof vi.spyOn>): number {
    return spy.mock.calls.filter(
      c => String(c[0]) === 'GC_QUEUE client auth pause cleared',
    ).length;
  }

  it('TEST_CONCURRENT_AUTH_RESTORE_BURST_CLEARS_ONCE', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });
    const logSpy = vi.spyOn(console, 'log');

    // Fired simultaneously, with NO await between them, while the
    // pause still exists. Every one of them passes the cheap
    // pre-check before any of them reaches the write chain.
    notifyClientAuth(true);
    notifyClientAuth(true);
    notifyClientAuth(true);
    notifyClientAuth(true);

    await settle(async () => (await readState()).client_auth === null);
    await new Promise(r => setTimeout(r, 40));

    expect((await readState()).client_auth).toBeNull();
    expect(countDrainRequests(logSpy)).toBe(1);
  });

  it('TEST_CONCURRENT_AUTH_RESTORE_BURST_REQUESTS_ONE_DRAIN', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });
    const logSpy = vi.spyOn(console, 'log');

    await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => notifyClientAuth(true))),
    );
    await new Promise(r => setTimeout(r, 60));

    expect(countDrainRequests(logSpy)).toBe(1);
  });

  it('TEST_AUTH_EVENT_AFTER_CLEAR_REQUESTS_ZERO_DRAINS', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });
    const logSpy = vi.spyOn(console, 'log');

    notifyClientAuth(true);
    await settle(async () => (await readState()).client_auth === null);
    expect(countDrainRequests(logSpy)).toBe(1);

    // Everything after the clear must request zero further drains.
    notifyClientAuth(true);
    notifyClientAuth(true);
    notifyClientAuth(true);
    await new Promise(r => setTimeout(r, 40));

    expect(countDrainRequests(logSpy)).toBe(1);
  });

  it('TEST_INIT_SESSION_AND_INITIAL_SESSION_EVENT_STILL_DRAIN_ONCE', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });
    const logSpy = vi.spyOn(console, 'log');

    // The real pair: init() notifies the settled getSession() result,
    // then supabase-js emits INITIAL_SESSION for the same session.
    notifyClientAuth(true); // from init()
    notifyClientAuth(true); // from onAuthStateChange('INITIAL_SESSION')

    await settle(async () => (await readState()).client_auth === null);
    await new Promise(r => setTimeout(r, 40));

    expect(countDrainRequests(logSpy)).toBe(1);
  });
});

describe('TOKEN_REFRESH does not resume repeatedly', () => {
  it('repeated usable-session events request at most one drain', async () => {
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });

    notifyClientAuth(true);
    await settle(async () => (await readState()).client_auth === null);

    const writesAfterFirst = vi.mocked(AsyncStorage.setItem).mock.calls.length;

    // Simulate a burst of TOKEN_REFRESHED events with no pause in force.
    notifyClientAuth(true);
    notifyClientAuth(true);
    notifyClientAuth(true);
    await new Promise(r => setTimeout(r, 30));

    // Idempotent: with no client-auth pause set the handler short-
    // circuits before touching storage or kicking a drain.
    expect(vi.mocked(AsyncStorage.setItem).mock.calls.length).toBe(writesAfterFirst);
  });
});

describe('the restore event survives arriving before registration', () => {
  it('a pause set on disk is cleared by an event retained from init', async () => {
    // The handler is already registered (module import), so retention
    // itself is covered in pauseStore.test.ts. Here we assert the
    // end-to-end effect: an event delivered while the cache is cold
    // still hydrates and clears the persisted pause.
    seedQueue([]);
    seedPause(s => {
      s.client_auth = { at: Date.now(), code: 'NO_TOKEN' };
    });
    _resetPauseCacheForTests();

    notifyClientAuth(true);
    await settle(async () => (await readState()).client_auth === null);

    expect((await readState()).client_auth).toBeNull();
  });
});
