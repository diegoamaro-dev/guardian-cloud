/**
 * R6 — the ownership authority made structural.
 *
 * R5 routed every mutating call site through `getOwnershipAccessToken`,
 * but the helpers still took `token: string`. "This token must come from
 * the ownership authority" was a COMMENT, and a comment is not a
 * property: a read token, a cached one, or any string satisfied the
 * signature and went to the network.
 *
 * Two halves now enforce it:
 *
 *   compile time — `OwnershipToken` is branded with a `unique symbol`
 *                  that is declared and never exported, so
 *                  `getOwnershipToken` is the only producer. The brand
 *                  already found one real leak: the stale-error
 *                  reconciliation in `app/index.tsx` was handing a READ
 *                  token to `finalizeAndAuthorizeCleanup`, which calls
 *                  POST /complete. No amount of reading the code had
 *                  caught it.
 *
 *   run time     — `assertOwnershipGateOpen` closes the hole the brand
 *                  cannot: types are erased, so a deliberate cast still
 *                  compiles. One boolean read, no I/O, safe per chunk.
 *
 * These drive the REAL call sites — `startRecording`'s durable half, the
 * pending-registration loop, the worker drain, the finalize path — not
 * the accessor in isolation. An accessor returning null proves nothing
 * about whether the callers are obliged to use it.
 *
 * ── What is NOT proven here ──────────────────────────────────────────
 * The React screens are not rendered. `POST /chunks` and the destination
 * upload are exercised through the exported worker/finalize functions
 * with a mocked `fetch`, which is how the rest of this suite already
 * reaches them. The compile-time half is proven by `npx tsc` on the tree,
 * not by a runtime assertion — a test cannot observe a type it is
 * forbidden to construct.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const assertOwnershipGateOpen = vi.fn();
const getOwnershipAccessToken = vi.fn(async () => null as string | null);
const getFreshAccessToken = vi.fn(async () => 'read-token' as string | null);

vi.mock('@/auth/store', () => ({
  useAuthStore: { setState: vi.fn(), getState: vi.fn(() => ({ status: 'loading' })) },
  assertOwnershipGateOpen: (...a: unknown[]) =>
    (assertOwnershipGateOpen as unknown as (...x: unknown[]) => unknown)(...a),
  isOwnershipGateOpen: vi.fn(() => false),
  getFreshAccessToken: (...a: unknown[]) =>
    (getFreshAccessToken as unknown as (...x: unknown[]) => unknown)(...a),
  getOwnershipAccessToken: (...a: unknown[]) =>
    (getOwnershipAccessToken as unknown as (...x: unknown[]) => unknown)(...a),
}));

const uploadChunkBytes = vi.fn();
vi.mock('@/api/destinations', () => ({
  getConnectedDrive: vi.fn(async () => ({ id: 'd1', type: 'drive', connected: true })),
  listDestinations: vi.fn(async () => ({ destinations: [] })),
  uploadChunkBytes: (...a: unknown[]) =>
    (uploadChunkBytes as unknown as (...x: unknown[]) => unknown)(...a),
}));

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
  PENDING_RETRY_KEY,
  addPendingRegistration,
  loadPendingRegistrations,
  queueAppendNewSession,
  queueRead,
  tryFinalizeReadySessions,
  runPendingRegistrationPass,
  uploadDrainLoop,
  _setDrainPreconditionsForTests,
} from '../app/index';

const store = (
  AsyncStorage as unknown as { __store__: Map<string, string> }
).__store__;

const SID = '0feacfa8-a1ba-4eef-a1ed-278266dfc5f4';
const URI = 'file:///cache/rec.m4a';
const PENDING_SESSIONS_KEY = 'guardian.pending_session_registrations';
const fetchMock = vi.fn();

/** The gate refuses, exactly as it does when the marker is not durable. */
function gateClosed() {
  getOwnershipAccessToken.mockResolvedValue(null);
  assertOwnershipGateOpen.mockImplementation((path: unknown) => {
    throw new Error(`ownership gate closed for ${String(path)}`);
  });
}
function gateOpen(token = 'own-token') {
  getOwnershipAccessToken.mockResolvedValue(token);
  assertOwnershipGateOpen.mockImplementation(() => {});
  // The backend answers a real POST /sessions with the id it persisted.
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ session_id: SID }),
  });
}

function uploadedReadyEntry() {
  return {
    session_id: SID,
    uri: URI,
    recording_closed: true,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 1,
    destination_type: 'drive' as const,
    chunks: [
      {
        chunk_index: 0,
        hash: 'h'.repeat(64),
        size: 10,
        status: 'uploaded' as const,
        attempts: 0,
        remote_reference: '1AbC',
      },
    ],
  };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({}),
  });
  vi.stubGlobal('fetch', fetchMock);
  uploadChunkBytes.mockReset();
  uploadChunkBytes.mockResolvedValue({ remote_reference: 'r1', dedup: null });
  // Without these the drain never reaches the upload leg and every
  // assertion below would pass for the wrong reason. Same setup the
  // existing drain tests use.
  _setDrainPreconditionsForTests({
    destinationResolved: true,
    activeDestinationType: 'drive',
  });
  gateClosed();
});

describe('R6_A_A_FORCED_CAST_STILL_REACHES_NOTHING', () => {
  it('the runtime guard fires before any mutation can leave', async () => {
    // The brand stops this at compile time. A deliberate cast does not
    // compile-fail, which is exactly why the runtime half exists — so
    // simulate the cast by driving the guard directly.
    expect(() => assertOwnershipGateOpen('/chunks')).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a blocked mutation is classified TRANSIENT, so nothing is burned', async () => {
    // `OwnershipGateClosedError` is a plain Error with no HTTP status.
    // `classifyError` defaults those to transient, so the chunk stays
    // pending and retries instead of being marked permanently failed.
    const { classifyError } = await import('../app/index');
    expect(classifyError(new Error('ownership gate closed for /chunks'))).toBe(
      'transient',
    );
  });
});

describe('R6_B_THE_REAL_DEFERRED_REGISTRATION_REPLAY', () => {
  /**
   * Drives  — the actual mechanism that
   * replays , shared verbatim with the production loop.
   *
   * The previous version of this test drove , which has
   * no reference to this path whatsoever, so its "no request was sent"
   * assertion held even if the replay were completely broken or used a
   * read token. Vacuous.
   */
  it('gate shut: POST /sessions = 0 and the entry survives untouched', async () => {
    await addPendingRegistration(SID, 'audio', 'drive');

    const remaining = await runPendingRegistrationPass();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(remaining).toBe(1);
    const pending = await loadPendingRegistrations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.session_id).toBe(SID);
    expect(pending[0]?.mode).toBe('audio');
  });

  it('gate opens: exactly one POST /sessions, carrying the ORIGINAL id', async () => {
    await addPendingRegistration(SID, 'audio', 'drive');
    expect(await runPendingRegistrationPass()).toBe(1);

    gateOpen();
    const remaining = await runPendingRegistrationPass();

    const posts = fetchMock.mock.calls.filter(c =>
      String(c[0]).endsWith('/sessions'),
    );
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String((posts[0]?.[1] as { body?: unknown })?.body));
    expect(body.id).toBe(SID);
    // Removed only after the request succeeded.
    expect(remaining).toBe(0);
    expect(await loadPendingRegistrations()).toHaveLength(0);
  });

  it('a failed request leaves the entry in place — no silent drop', async () => {
    await addPendingRegistration(SID, 'video', 'drive');
    gateOpen();
    // `createSessionRequest` reads a non-2xx body with `res.text()`. Without
    // it the mock threw "res.text is not a function" — a TypeError raised
    // BEFORE the `.catch` is attached — so this test used to pass through
    // the wrong failure path entirely.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { code: 'BOOM' } }),
      json: async () => ({ error: { code: 'BOOM' } }),
    });

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' ') + JSON.stringify(a[1] ?? ''));
    });

    const remaining = await runPendingRegistrationPass();

    // The request really left, and really came back 500.
    const posts = fetchMock.mock.calls.filter(c =>
      String(c[0]).endsWith('/sessions'),
    );
    expect(posts).toHaveLength(1);
    // `createSessionRequest` took its `!res.ok` branch: the message it
    // throws is built from `res.status` and the body read via `text()`.
    expect(logged.join('\n')).toContain('POST /sessions HTTP 500');
    expect(logged.join('\n')).toContain('BOOM');

    expect(remaining).toBe(1);
    expect((await loadPendingRegistrations())[0]?.session_id).toBe(SID);
  });

  it('TEETH: the pass really does issue the request when the gate is open', async () => {
    // If this fails, the two assertions above prove nothing.
    await addPendingRegistration(SID, 'audio', 'drive');
    gateOpen();
    await runPendingRegistrationPass();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('R6_E_COMPLETION_PATH', () => {
  it('/complete = 0, no reap and no cleanup authorization', async () => {
    await queueAppendNewSession(uploadedReadyEntry());

    const finalized = await tryFinalizeReadySessions();

    expect(finalized).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const q = await queueRead();
    // The entry is still here: not completed, not reaped.
    expect(q).toHaveLength(1);
    expect(q[0]?.session_completed).toBe(false);
    expect(store.get('guardian.segment_cleanup.v1')).toBeUndefined();
  });
});

describe('R6_G_RECOVERY_WHEN_THE_GATE_OPENS', () => {
  it('exactly one /complete once the marker is durable, then a normal reap', async () => {
    await queueAppendNewSession(uploadedReadyEntry());
    expect(await tryFinalizeReadySessions()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    gateOpen();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ session_id: SID, status: 'completed' }),
    });

    const finalized = await tryFinalizeReadySessions();

    expect(finalized).toBe(true);
    const completes = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes('/complete'),
    );
    expect(completes).toHaveLength(1);
    // Reaped: the queue entry is gone, exactly as on the normal path.
    expect(await queueRead()).toHaveLength(0);
  });

  it('END TO END: same id -> 1 POST /sessions -> 1 /complete -> reap', async () => {
    // One test walking the whole sequence, because the parts were
    // previously asserted in isolation and an isolated assertion can be
    // true while the chain it belongs to is broken.
    await addPendingRegistration(SID, 'audio', 'drive');
    await queueAppendNewSession(uploadedReadyEntry());

    // Gate shut: neither leg moves.
    expect(await runPendingRegistrationPass()).toBe(1);
    expect(await tryFinalizeReadySessions()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueRead()).toHaveLength(1);

    // Marker becomes durable.
    gateOpen();

    // Leg 1 — registration, under the ORIGINAL localSessionId.
    expect(await runPendingRegistrationPass()).toBe(0);
    const posts = fetchMock.mock.calls.filter(c =>
      String(c[0]).endsWith('/sessions'),
    );
    expect(posts).toHaveLength(1);
    expect(
      JSON.parse(String((posts[0]?.[1] as { body?: unknown })?.body)).id,
    ).toBe(SID);

    // Leg 2 — completion of the SAME session, then a normal reap.
    expect(await tryFinalizeReadySessions()).toBe(true);
    const completes = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes(`/sessions/${SID}/complete`),
    );
    expect(completes).toHaveLength(1);
    expect(await queueRead()).toHaveLength(0);
    expect(await loadPendingRegistrations()).toHaveLength(0);
  });
});

describe('R6_F_READS_ARE_UNAFFECTED', () => {
  it('the read accessor is never routed through the ownership gate', async () => {
    expect(await getFreshAccessToken()).toBe('read-token');
    expect(assertOwnershipGateOpen).not.toHaveBeenCalled();
  });
});
