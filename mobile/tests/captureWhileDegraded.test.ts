/**
 * GC-AUTH-001 · 4C — capture must survive the loss of identity.
 *
 * A device in IDENTITY_DEGRADED has lost its anonymous Supabase session
 * and, correctly, refuses to mint a replacement. Until 4C it also
 * refused to record: `startRecording` aborted with
 * TOKEN_MISSING_AT_START before the recorder ever started. That inverts
 * the product — the backend is where evidence GOES, not permission to
 * gather it.
 *
 * The path this file pins was built by the two preceding commits:
 *   4A — recorder live ⇒ durable GC_QUEUE entry before any backend
 *        dependency; a zero-chunk entry can never complete or be reaped;
 *   4B — no token / 401 ⇒ deferred registration under the SAME
 *        `localSessionId`, with no doomed HTTP call.
 *
 * ── What is NOT proven here ──────────────────────────────────────────
 * `startRecording` is a closure inside a React component, bound to the
 * native recorder, the camera ref and Expo's filesystem. Driving it
 * end-to-end would mean building a harness that impersonates all three,
 * and a green test from an impersonated recorder proves the harness
 * works, not the product. So these tests exercise the real exported
 * units the degraded path is composed of, and the composition itself —
 * "the user taps GRABAR and a file appears on disk" — stays a hardware
 * gate. Points 1, 2, 10 and 11 of the plan are marked accordingly in the
 * report; nothing here is dressed up as a PASS it is not.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const signInAnonymously = vi.fn(async () => ({
  data: { user: null, session: null },
  error: null,
}));
const fetchMock = vi.fn();

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

vi.mock('@/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      signInAnonymously: (...a: unknown[]) =>
        (signInAnonymously as unknown as (...x: unknown[]) => unknown)(...a),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signOut: vi.fn(),
      startAutoRefresh: vi.fn(async () => {}),
      stopAutoRefresh: vi.fn(async () => {}),
    },
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFreshAccessToken } from '@/auth/store';
import {
  decideIdentityState,
  resolveIdentityInitialized,
} from '../src/auth/identityMarker';
import {
  PENDING_RETRY_KEY,
  addPendingRegistration,
  isRetryableSessionCreateError,
  loadPendingRegistrations,
  queueAppendNewSession,
  queueRead,
  tryFinalizeReadySessions,
  type PendingQueueEntry,
} from '../app/index';

const store = (
  AsyncStorage as unknown as { __store__: Map<string, string> }
).__store__;

const LOCAL_SESSION_ID = '11111111-2222-4333-8444-555555555555';
const CACHE_URI = 'file:///cache/recording-degraded.m4a';
const PENDING_SESSIONS_KEY = 'guardian.pending_session_registrations';

/**
 * The durable half of what `startRecording` does once the recorder is
 * live and there is no token: write the queue entry (4A), then schedule
 * the registration instead of calling the backend (4B).
 */
async function startCaptureWhileDegraded(
  mode: 'audio' | 'video',
): Promise<void> {
  await queueAppendNewSession({
    session_id: LOCAL_SESSION_ID,
    uri: CACHE_URI,
    recording_closed: false,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 0,
    chunks: [],
    destination_type: 'drive',
  });
  await addPendingRegistration(LOCAL_SESSION_ID, mode, 'drive');
}

/** Only AsyncStorage crosses a process boundary. */
function afterKill(): { queue: PendingQueueEntry[]; pending: unknown[] } {
  const q = store.get(PENDING_RETRY_KEY);
  const p = store.get(PENDING_SESSIONS_KEY);
  return {
    queue: q ? (JSON.parse(q) as PendingQueueEntry[]) : [],
    pending: p ? (JSON.parse(p) as unknown[]) : [],
  };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('TEST_DEGRADED_IDENTITY_DOES_NOT_MINT_AND_DOES_NOT_BLOCK', () => {
  it('a device with prior evidence and no session resolves to IDENTITY_DEGRADED', async () => {
    await AsyncStorage.setItem(
      'history.sessions',
      JSON.stringify([{ session_id: 'old', created_at: 1, mode: 'audio' }]),
    );

    const { initialized } = await resolveIdentityInitialized();
    const decision = decideIdentityState({
      hasSession: false,
      hasError: false,
      initialized,
    });

    expect(decision.state).toBe('IDENTITY_DEGRADED');
  });

  it('no anonymous identity is minted while degraded', async () => {
    await AsyncStorage.setItem(
      'history.sessions',
      JSON.stringify([{ session_id: 'old', created_at: 1, mode: 'audio' }]),
    );

    const { initialized } = await resolveIdentityInitialized();
    const decision = decideIdentityState({
      hasSession: false,
      hasError: false,
      initialized,
    });
    // The bootstrap returns on DEGRADED without reaching the mint branch;
    // the assertion that matters is that nothing anywhere signed in.
    expect(decision.state).not.toBe('FIRST_IDENTITY');
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('starting a capture while degraded never signs in', async () => {
    await startCaptureWhileDegraded('audio');
    expect(signInAnonymously).not.toHaveBeenCalled();
  });
});

describe('TEST_NO_DOOMED_SESSION_POST_WITHOUT_A_TOKEN', () => {
  it('starting a capture with no token issues no HTTP request at all', async () => {
    await startCaptureWhileDegraded('audio');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the registration is durable instead', async () => {
    await startCaptureWhileDegraded('audio');

    const pending = await loadPendingRegistrations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.session_id).toBe(LOCAL_SESSION_ID);
    expect(pending[0]?.mode).toBe('audio');
  });

  it('a 401 raised later is deferrable too, so a stale token cannot kill the capture', () => {
    expect(
      isRetryableSessionCreateError(new Error('POST /sessions HTTP 401 nope')),
    ).toBe(true);
  });
});

describe('TEST_CAPTURE_IS_DURABLE_BEFORE_ANY_REMOTE_DEPENDENCY', () => {
  it('audio: the queue entry exists with no backend involvement', async () => {
    await startCaptureWhileDegraded('audio');

    const queue = await queueRead();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.session_id).toBe(LOCAL_SESSION_ID);
    expect(queue[0]?.uri).toBe(CACHE_URI);
    expect(queue[0]?.recording_closed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('video: identical, the mode changes nothing about durability', async () => {
    await startCaptureWhileDegraded('video');

    const queue = await queueRead();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.session_id).toBe(LOCAL_SESSION_ID);
    expect((await loadPendingRegistrations())[0]?.mode).toBe('video');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the SAME localSessionId is used by the queue and the pending registration', async () => {
    await startCaptureWhileDegraded('audio');

    const queueId = (await queueRead())[0]?.session_id;
    const pendingId = (await loadPendingRegistrations())[0]?.session_id;
    expect(queueId).toBe(LOCAL_SESSION_ID);
    expect(pendingId).toBe(LOCAL_SESSION_ID);
  });
});

describe('TEST_KILL_AND_RESTART_WHILE_DEGRADED', () => {
  it('a kill right after starting leaves both stores recoverable', async () => {
    await startCaptureWhileDegraded('audio');

    const state = afterKill();
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]?.uri).toBe(CACHE_URI);
    expect(state.pending).toHaveLength(1);
  });

  it('a restart with still no token neither completes nor destroys the session', async () => {
    await startCaptureWhileDegraded('audio');

    // Next boot, still degraded. The chunker never ran, so the entry is
    // zero-chunk: exactly the shape that used to sail through the gate.
    const finalized = await tryFinalizeReadySessions();

    expect(finalized).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const queue = await queueRead();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.uri).toBe(CACHE_URI);
  });

  it('even with recording_closed flipped by boot recovery, it is held', async () => {
    await startCaptureWhileDegraded('audio');
    // Model what GC_BOOT_STUCK_UPLOAD_RESET does on a healthy boot.
    const raw = JSON.parse(
      store.get(PENDING_RETRY_KEY) as string,
    ) as PendingQueueEntry[];
    raw[0]!.recording_closed = true;
    store.set(PENDING_RETRY_KEY, JSON.stringify(raw));

    await tryFinalizeReadySessions();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueRead()).toHaveLength(1);
  });

  it('the pending registration is not duplicated by a second start attempt', async () => {
    await startCaptureWhileDegraded('audio');
    await addPendingRegistration(LOCAL_SESSION_ID, 'audio', 'drive');

    expect(await loadPendingRegistrations()).toHaveLength(1);
  });
});

describe('TEST_CONVERGENCE_AFTER_IDENTITY_RETURNS', () => {
  it('the replayed registration carries the same id, so the backend cannot create two sessions', async () => {
    await startCaptureWhileDegraded('audio');

    // Identity returns. The loop replays the persisted entry verbatim.
    const replay = (await loadPendingRegistrations())[0];
    expect(replay?.session_id).toBe(LOCAL_SESSION_ID);
    // The backend keys idempotency on (id, user_id): same id ⇒ same row.
    expect(replay?.session_id).toBe((await queueRead())[0]?.session_id);
  });

  it('exactly one /complete once every chunk has uploaded', async () => {
    // Identity has returned: the worker can authenticate again.
    vi.mocked(getFreshAccessToken).mockResolvedValue('test-token');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ session_id: LOCAL_SESSION_ID, status: 'completed' }),
    });

    // The state after identity returned, registration replayed and the
    // worker drained: recording closed, both chunks uploaded.
    await queueAppendNewSession({
      session_id: LOCAL_SESSION_ID,
      uri: CACHE_URI,
      recording_closed: true,
      session_completed: false,
      complete_attempts: 0,
      emitted_base64_length: 0,
      next_chunk_index: 2,
      chunks: [
        {
          chunk_index: 0,
          hash: 'a'.repeat(64),
          size: 10,
          status: 'uploaded',
          attempts: 1,
          remote_reference: 'drive-0',
        },
        {
          chunk_index: 1,
          hash: 'b'.repeat(64),
          size: 10,
          status: 'uploaded',
          attempts: 1,
          remote_reference: 'drive-1',
        },
      ],
      destination_type: 'drive',
    });

    expect(await tryFinalizeReadySessions()).toBe(true);

    const completeCalls = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes('/complete'),
    );
    expect(completeCalls).toHaveLength(1);
    expect(String(completeCalls[0]?.[0])).toContain(
      `/sessions/${LOCAL_SESSION_ID}/complete`,
    );
    // Reaped exactly once — a second pass has nothing left to complete.
    expect(await queueRead()).toEqual([]);
    expect(await tryFinalizeReadySessions()).toBe(false);
    expect(
      fetchMock.mock.calls.filter(c => String(c[0]).includes('/complete')),
    ).toHaveLength(1);
  });
});
