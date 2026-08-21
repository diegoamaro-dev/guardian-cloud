/**
 * R5 — the ownership gate.
 *
 * The defect this closes: `hasProvenIdentityEvidence` looked for proof of a
 * past identity inside GC_QUEUE, and `reapEntry` deletes the queue entry
 * once a session uploads and completes. The proof therefore vanished on the
 * HAPPY PATH — upload, /complete, reap, journal drop — leaving marker absent
 * + negative seal + no session, which mints a replacement identity and
 * orphans everything the first one owned.
 *
 * Rather than hunt for a proof that outlives cleanup, the gate inverts the
 * order: an identity may not acquire remote ownership until the device can
 * prove locally that the identity exists. The two states become mutually
 * exclusive, so `gc.identity.v1` — which no reap touches — is always
 * sufficient. No tombstone: a second key in the same AsyncStorage is not a
 * second durability domain.
 *
 * Properties pinned here:
 *
 *   P1  No authenticated remote ownership can be created for identity A
 *       before durable local proof of A exists.
 *   P2  Failure to persist that proof never prevents local capture.
 *   P3  Uncertainty after an observed identity never authorizes automatic
 *       replacement identity minting.
 *   P4  Successful queue reap and cleanup cannot remove the durable proof
 *       protecting ownership.
 *
 * ── What is NOT proven here ──────────────────────────────────────────
 * These exercise the real `store.ts` authority and the real `client.ts`
 * wiring against a mocked `fetch` and a mocked AsyncStorage. They do not
 * drive the React screens. R5-L is the negative inventory: it asserts that
 * NOTHING from the ownership list leaves the device while the marker is not
 * durable, and that reads are unaffected — which is the property that
 * matters even for call sites this file does not name individually.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSession = vi.fn(async () => ({
  data: { session: null as unknown },
  error: null as { name: string } | null,
}));

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  const failWrites = new Set<string>();
  return {
    default: {
      __store__: store,
      __failWrites__: failWrites,
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
      setItem: vi.fn(async (k: string, v: string) => {
        if (failWrites.has(k)) throw new Error('storage write failed');
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

vi.mock('@/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) =>
        (getSession as unknown as (...x: unknown[]) => unknown)(...a),
      signInAnonymously: vi.fn(),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signOut: vi.fn(),
    },
  },
}));

vi.mock('@/upload/pauseStore', () => ({ notifyClientAuth: vi.fn() }));

// `tests/setup.ts` stubs `@/auth/store` for every suite. This file is the
// one that must exercise the REAL ownership authority, so restore it here
// — a gate tested against a stub of itself proves nothing.
vi.mock('@/auth/store', async () => await vi.importActual('@/auth/store'));
// Same reason: the Drive client and the API client must be the real ones,
// because R5-J is about what they do or do not put on the wire.
vi.mock('@/api/destinations', async () => await vi.importActual('@/api/destinations'));
vi.mock('@/api/client', async () => await vi.importActual('@/api/client'));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  IDENTITY_KEY,
  readIdentityMarkerState,
} from '@/auth/identityMarker';
import {
  getAccessToken,
  getOwnershipToken,
  getOwnershipAccessToken,
  __resetOwnershipLatchForTests,
} from '@/auth/store';
import { uploadChunkBytes } from '@/api/destinations';
import {
  startDriveConnect,
  exchangeDriveCode,
  driveTestUpload,
  listDestinations,
} from '@/api/destinations';
import { ApiError } from '@/api/client';

const mock = AsyncStorage as unknown as {
  __store__: Map<string, string>;
  __failWrites__: Set<string>;
};
const store = mock.__store__;

const A_ID = 'a1a1a1a1-2222-4333-8444-555566667777';
const fetchMock = vi.fn();

function sessionAlive(userId = A_ID) {
  getSession.mockResolvedValue({
    data: { session: { access_token: 'tok-A', user: { id: userId } } },
    error: null,
  });
}
function sessionGone() {
  getSession.mockResolvedValue({ data: { session: null }, error: null });
}
function okJson(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

beforeEach(() => {
  store.clear();
  mock.__failWrites__.clear();
  vi.clearAllMocks();
  __resetOwnershipLatchForTests();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okJson());
  vi.stubGlobal('fetch', fetchMock);
  sessionAlive();
});

describe('R5_OWNERSHIP_TOKEN_IS_THE_SINGLE_AUTHORITY', () => {
  it('P1: a live session alone does not buy an ownership token', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);

    const read = await getAccessToken();
    const own = await getOwnershipToken();

    // The session is perfectly usable for READS...
    expect(read.ok).toBe(true);
    // ...and refused for anything that would create ownership.
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.reason).toBe('marker_not_durable');
  });

  it('the refusal names itself: not a missing session, not a sign-in problem', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    const own = await getOwnershipToken();
    expect(own.ok).toBe(false);
    if (!own.ok) {
      expect(own.reason).not.toBe('no_session');
      expect(own.reason).not.toBe('auth_non_retryable');
    }
  });

  it('writing the marker is what opens the gate, and it opens once', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    expect(await getOwnershipAccessToken()).toBeNull();

    mock.__failWrites__.clear();
    expect(await getOwnershipAccessToken()).toBe('tok-A');
    expect((await readIdentityMarkerState()).kind).toBe('present');

    // The in-memory latch makes later calls free — no extra storage churn.
    const before = (AsyncStorage.getItem as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length;
    await getOwnershipAccessToken();
    const after = (AsyncStorage.getItem as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length;
    expect(after).toBe(before);
  });

  it('no session means no ownership token either, for the ordinary reason', async () => {
    sessionGone();
    const own = await getOwnershipToken();
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.reason).toBe('no_session');
  });
});

describe('R5_J_DRIVE_OBEYS_THE_SAME_RULE', () => {
  it('marker not durable: connect start, exchange and test-upload send NOTHING', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);

    await expect(startDriveConnect('app://cb')).rejects.toBeInstanceOf(ApiError);
    await expect(exchangeDriveCode('code-123')).rejects.toBeInstanceOf(ApiError);
    await expect(driveTestUpload()).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the failure carries IDENTITY_NOT_READY so the screen can say "one moment"', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    await expect(startDriveConnect()).rejects.toMatchObject({
      code: 'IDENTITY_NOT_READY',
    });
  });

  it('once the marker is durable, an explicit user action runs normally', async () => {
    fetchMock.mockResolvedValue(okJson({ auth_url: 'https://accounts.google', state: null }));

    const res = await startDriveConnect('app://cb');

    expect(res.auth_url).toBe('https://accounts.google');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('NO OAuth is auto-replayed: the gate never retries a user action itself', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    await expect(driveTestUpload()).rejects.toBeInstanceOf(ApiError);

    // Storage recovers. Nothing fires on its own; the user must act again.
    mock.__failWrites__.clear();
    await new Promise(r => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads keep working while the gate is shut', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    fetchMock.mockResolvedValue(okJson({ destinations: [] }));

    await expect(listDestinations()).resolves.toEqual({ destinations: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('R5_L_NEGATIVE_INVENTORY', () => {
  /**
   * Every mutating endpoint found in the ownership audit, driven through
   * the real client while the marker cannot be persisted. None may reach
   * the network. The reads in the same inventory must still go through.
   */
  it('P1: not one authenticated mutation leaves the device', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);

    const mutations = [
      () => startDriveConnect('app://cb'),
      () => exchangeDriveCode('code-123', 'app://cb'),
      () => driveTestUpload(),
    ];
    for (const call of mutations) {
      await expect(call()).rejects.toBeInstanceOf(ApiError);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // The ownership token itself — the source every other mutating call
    // (POST /sessions, POST /chunks, destination chunk upload, /complete)
    // now draws from — is refused for the same reason.
    expect(await getOwnershipAccessToken()).toBeNull();
  });

  it('reads are untouched: the gate is about creating, not looking', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    fetchMock.mockResolvedValue(okJson({ destinations: [] }));

    await listDestinations();
    await listDestinations();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getAccessToken()).ok).toBe(true);
  });

  it('P4: once durable, the proof survives everything cleanup deletes', async () => {
    // Open the gate, then wipe every store reap and journal-drop touch.
    expect(await getOwnershipAccessToken()).toBe('tok-A');

    store.delete('test.pending_retry'); // reapEntry → queueDropEntry
    store.delete('guardian.segment_cleanup.v1'); // journal.drop
    store.delete('guardian.pending_session_registrations');
    store.delete('history.sessions');
    store.delete('export.last_session_id');

    // The marker is untouched by all of it — that is the whole point.
    expect((await readIdentityMarkerState()).kind).toBe('present');

    // And a later boot with the session gone still refuses to mint.
    sessionGone();
    __resetOwnershipLatchForTests();
    expect(await getOwnershipAccessToken()).toBeNull();
    expect((await readIdentityMarkerState()).kind).toBe('present');
  });
});

describe('R5_P2_LOCAL_CAPTURE_IS_NEVER_BLOCKED', () => {
  it('a refused ownership token is an ordinary null, never a throw', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    // `startRecording` and `runPendingRegistrationLoop` both branch on a
    // null token into the deferral that already exists. A throw here would
    // abort a capture, so the shape matters as much as the value.
    await expect(getOwnershipAccessToken()).resolves.toBeNull();
  });

  it('the gate performs no network call of its own', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    await getOwnershipAccessToken();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('R5_NO_NEW_DURABLE_KEY', () => {
  it('opening the gate writes gc.identity.v1 and nothing else', async () => {
    await getOwnershipAccessToken();

    expect([...store.keys()]).toEqual([IDENTITY_KEY]);
  });

  it('the marker still carries no credential material', async () => {
    await getOwnershipAccessToken();
    const raw = store.get(IDENTITY_KEY)!;

    expect(raw).not.toContain('tok-A');
    expect(raw).not.toContain(A_ID);
    expect(raw).not.toMatch(/eyJ|access_token|refresh_token/);
    expect(JSON.parse(raw).sub_prefix).toBe('a1a1a1a1');
  });
});

describe('R6_H_P2_THE_GATE_NEVER_THROWS_AT_THE_CAPTURE_PATH', () => {
  it('getSession REJECTING resolves to null, it does not reject', async () => {
    // Not `{ error }` — an actual rejected promise. R5 left this
    // unguarded, and `startRecording` awaits the accessor outside any
    // try/catch, so a rejection here aborted a recording.
    getSession.mockRejectedValue(new Error('network is down'));

    await expect(getOwnershipAccessToken()).resolves.toBeNull();
  });

  it('the classified result says refresh_failed rather than throwing', async () => {
    getSession.mockRejectedValue(new Error('network is down'));

    const r = await getOwnershipToken();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('refresh_failed');
  });

  it('a rejecting storage layer also resolves to null', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    (AsyncStorage.setItem as unknown as { mockImplementationOnce: (f: unknown) => void })
      .mockImplementationOnce(() => {
        throw new Error('storage exploded');
      });

    await expect(getOwnershipAccessToken()).resolves.toBeNull();
  });

  it('and the gate stays shut, so nothing mutating could have escaped', async () => {
    getSession.mockRejectedValue(new Error('network is down'));
    await getOwnershipAccessToken();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('R6_I_ONE_SESSION_SNAPSHOT', () => {
  it('a single getSession call answers both the token and the identity', async () => {
    sessionAlive(A_ID);

    const r = await getOwnershipToken();

    expect(r.ok).toBe(true);
    // ONE read. The previous version called getAccessToken() (which reads
    // the session) and then read it again for the user id.
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('the sub_prefix written comes from the same session as the token', async () => {
    sessionAlive(A_ID);

    const r = await getOwnershipToken();

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe('tok-A');
    expect(JSON.parse(store.get(IDENTITY_KEY)!).sub_prefix).toBe(
      A_ID.slice(0, 8),
    );
  });

  it('once the latch is closed, a call costs ONE session read and no storage', async () => {
    await getOwnershipAccessToken();
    getSession.mockClear();
    const writesBefore = (
      AsyncStorage.setItem as unknown as { mock: { calls: unknown[] } }
    ).mock.calls.length;

    await getOwnershipAccessToken();

    // One read, because a fresh token genuinely requires one. What the
    // latch removes is the SECOND read and every AsyncStorage touch —
    // which is what makes this safe to call per chunk.
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(
      (AsyncStorage.setItem as unknown as { mock: { calls: unknown[] } }).mock
        .calls.length,
    ).toBe(writesBefore);
  });
});

describe('R6_D_THE_DESTINATION_UPLOAD_ITSELF', () => {
  /**
   * The real `uploadChunkBytes`, not a double. This is the call that
   * produces a `remote_reference` — the most literal creation of remote
   * ownership in the app — and the one the worker reaches with a CACHED
   * token, which is precisely how a read token could have slipped past.
   */
  it('a forced cast still sends nothing while the gate is shut', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);
    // Simulates the one thing the brand cannot stop: a deliberate cast.
    const forged = 'read-token-or-anything' as unknown as Parameters<
      typeof uploadChunkBytes
    >[6];

    await expect(
      uploadChunkBytes('sid', 0, 'h'.repeat(64), 'AAAA', 30_000, 'drive', forged),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no cached token at all it is refused just the same', async () => {
    mock.__failWrites__.add(IDENTITY_KEY);

    await expect(
      uploadChunkBytes('sid', 0, 'h'.repeat(64), 'AAAA'),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('TEETH: once the gate is open the very same call does reach the network', async () => {
    // Guards the two assertions above against passing for the wrong
    // reason. If this ever fails, they prove nothing.
    expect(await getOwnershipAccessToken()).toBe('tok-A');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ remote_reference: 'r1', dedup: null }),
    });

    const res = await uploadChunkBytes(
      'sid',
      0,
      'h'.repeat(64),
      'AAAA',
      30_000,
      'drive',
    );

    expect(res.remote_reference).toBe('r1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
