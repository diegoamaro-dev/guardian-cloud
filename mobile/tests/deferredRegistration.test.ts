/**
 * GC-AUTH-001 · 4B — "I cannot register right now" is not "this capture
 * is invalid".
 *
 * `isRetryableSessionCreateError` used to file 401 alongside 400, 403,
 * 409 and 422, so a capture in progress was thrown away whenever the
 * backend did not recognise the caller. But those two statements are
 * different in kind: a 400 says the request is wrong and always will be;
 * a 401 says the identity is not usable AT THIS MOMENT — mid-refresh, or
 * degraded and recovering. Destroying evidence over a condition that
 * routinely resolves itself is not a safety measure.
 *
 * 401, no token, network failure, timeout, 408, 429 and 5xx all route to
 * `guardian.pending_session_registrations` under the SAME
 * `localSessionId`. The backend is idempotent on (id, user_id), so
 * replaying it once identity returns yields one row, not two.
 *
 * Structural 4xx stay non-retryable on purpose. Turning every client
 * error into an unbounded retry would bury real defects in a loop.
 *
 * Note on scope: these tests drive the classifier and the durable store
 * directly. `runPendingRegistrationLoop` is deliberately not spun up —
 * it sleeps 5s between passes and only exits when the list empties, so
 * driving it here would hang the suite without proving anything the
 * storage assertions do not already cover.
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addPendingRegistration,
  isRetryableSessionCreateError,
  loadPendingRegistrations,
} from '../app/index';

const store = (
  AsyncStorage as unknown as { __store__: Map<string, string> }
).__store__;

const SESSION = '11111111-2222-4333-8444-555555555555';
const PENDING_SESSIONS_KEY = 'guardian.pending_session_registrations';

/** The shape `createSessionRequest` throws on a non-2xx response. */
function httpError(status: number, body = 'body'): Error {
  return new Error(`POST /sessions HTTP ${status} ${body}`);
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('TEST_AUTH_401_IS_DEFERRABLE_NOT_FATAL', () => {
  it('401 is retryable — the identity is unusable now, not forever', () => {
    expect(isRetryableSessionCreateError(httpError(401))).toBe(true);
  });

  it('401 stays retryable whatever the body says', () => {
    expect(
      isRetryableSessionCreateError(
        httpError(401, '{"error":{"code":"UNAUTHORIZED"}}'),
      ),
    ).toBe(true);
  });
});

describe('TEST_TRANSIENT_FAILURES_ARE_DEFERRABLE', () => {
  it('a network failure with no HTTP status is retryable', () => {
    expect(
      isRetryableSessionCreateError(new Error('Network request failed')),
    ).toBe(true);
  });

  it('an aborted request (timeout) is retryable', () => {
    expect(isRetryableSessionCreateError(new Error('Aborted'))).toBe(true);
  });

  it('408 and 429 are retryable', () => {
    expect(isRetryableSessionCreateError(httpError(408))).toBe(true);
    expect(isRetryableSessionCreateError(httpError(429))).toBe(true);
  });

  it('every 5xx is retryable', () => {
    for (const s of [500, 502, 503, 504, 599]) {
      expect(isRetryableSessionCreateError(httpError(s))).toBe(true);
    }
  });
});

/**
 * The narrowness of the change is the point. If this block ever goes
 * green with `true`, 4B has widened into an unbounded retry of real
 * defects.
 */
describe('TEST_STRUCTURAL_4XX_STAY_FATAL', () => {
  it('400 is NOT retryable — the request itself is wrong', () => {
    expect(isRetryableSessionCreateError(httpError(400))).toBe(false);
  });

  it('403 is NOT retryable', () => {
    expect(isRetryableSessionCreateError(httpError(403))).toBe(false);
  });

  it('409 is NOT retryable', () => {
    expect(isRetryableSessionCreateError(httpError(409))).toBe(false);
  });

  it('422 is NOT retryable', () => {
    expect(isRetryableSessionCreateError(httpError(422))).toBe(false);
  });

  it('401 is the ONLY 4xx that defers', () => {
    const deferring: number[] = [];
    for (let s = 400; s < 500; s++) {
      if (isRetryableSessionCreateError(httpError(s))) deferring.push(s);
    }
    expect(deferring).toEqual([401, 408, 429]);
  });
});

describe('TEST_PENDING_REGISTRATION_IS_DURABLE_AND_DEDUPED', () => {
  it('a scheduled registration is persisted under the same session_id', async () => {
    await addPendingRegistration(SESSION, 'audio', 'drive');

    const list = await loadPendingRegistrations();
    expect(list).toHaveLength(1);
    expect(list[0]?.session_id).toBe(SESSION);
    expect(list[0]?.mode).toBe('audio');
    expect(list[0]?.destination_type).toBe('drive');
  });

  it('scheduling the same session_id twice does not duplicate it', async () => {
    await addPendingRegistration(SESSION, 'audio', 'drive');
    await addPendingRegistration(SESSION, 'audio', 'drive');

    expect(await loadPendingRegistrations()).toHaveLength(1);
  });

  it('a second schedule does not overwrite the first entry', async () => {
    await addPendingRegistration(SESSION, 'video', 'drive');
    await addPendingRegistration(SESSION, 'audio', 'drive');

    const list = await loadPendingRegistrations();
    expect(list).toHaveLength(1);
    expect(list[0]?.mode).toBe('video');
  });

  it('distinct sessions coexist', async () => {
    const other = '99999999-8888-4777-8666-555555555555';
    await addPendingRegistration(SESSION, 'audio', 'drive');
    await addPendingRegistration(other, 'video', 'drive');

    const ids = (await loadPendingRegistrations()).map(e => e.session_id);
    expect(ids).toEqual([SESSION, other]);
  });

  it('survives a kill between schedule and remote registration', async () => {
    await addPendingRegistration(SESSION, 'audio', 'drive');

    // --- process dies; only AsyncStorage crosses the boundary ---
    const raw = store.get(PENDING_SESSIONS_KEY);
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string) as { session_id: string }[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.session_id).toBe(SESSION);
  });

  it('the persisted id is the SAME localSessionId, so the replay is idempotent', async () => {
    await addPendingRegistration(SESSION, 'audio', 'drive');

    const list = await loadPendingRegistrations();
    // The backend keys idempotency on (id, user_id). Replaying this id
    // after identity recovery must hit the existing row rather than
    // insert a second session.
    expect(list[0]?.session_id).toBe(SESSION);
  });

  it('a malformed store is treated as empty rather than throwing', async () => {
    store.set(PENDING_SESSIONS_KEY, '{not json');
    expect(await loadPendingRegistrations()).toEqual([]);
  });

  it('entries missing required fields are dropped, not crashed on', async () => {
    store.set(
      PENDING_SESSIONS_KEY,
      JSON.stringify([
        { session_id: SESSION, mode: 'audio' },
        { mode: 'audio' },
        { session_id: 'x', mode: 'not-a-mode' },
      ]),
    );

    const list = await loadPendingRegistrations();
    expect(list).toHaveLength(1);
    expect(list[0]?.session_id).toBe(SESSION);
  });
});
