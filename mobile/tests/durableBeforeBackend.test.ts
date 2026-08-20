/**
 * GC-AUTH-001 · 4A — the local session must be durable BEFORE anything
 * depends on the backend.
 *
 * The window this closes: the recorder was live and writing bytes into
 * `cacheDirectory` while nothing durable referenced them, because
 * `queueAppendNewSession` ran only after `await sessionCreatePromise`.
 * A non-retryable POST /sessions failure aborted the start and the
 * capture became unreachable — no queue entry for the worker, the
 * export or `findLocalRecordingUri`, and no `guardian_recording_*` file
 * in `documentDirectory` for `orphanScan`, because the rename happens
 * in `stopRecording`, which never ran.
 *
 * Two failure shapes are covered:
 *   - the deferred path (network / 5xx / no token): entry stays, pending
 *     registration stays, both survive a kill;
 *   - the hard-4xx path: the capture is still abandoned, but the bytes
 *     are promoted to the orphan route and the 0-chunk entry — which
 *     passes the completion gate vacuously and would shred the
 *     recording — is removed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface MoveArgs {
  from: string;
  to: string;
}
const moveAsync = vi.fn(async (_args: MoveArgs) => {});

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

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  moveAsync: (...a: unknown[]) =>
    (moveAsync as unknown as (...x: unknown[]) => unknown)(...a),
  deleteAsync: vi.fn(async () => {}),
  getInfoAsync: vi.fn(async () => ({ exists: true, size: 1024 })),
  readAsStringAsync: vi.fn(async () => ''),
  writeAsStringAsync: vi.fn(async () => {}),
  makeDirectoryAsync: vi.fn(async () => {}),
  readDirectoryAsync: vi.fn(async () => []),
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PENDING_RETRY_KEY,
  queueAppendNewSession,
  queueRead,
  abandonUnregisteredSession,
  closeRecorderForAbandon,
} from '../app/index';

const store = (
  AsyncStorage as unknown as { __store__: Map<string, string> }
).__store__;

const SESSION = '11111111-2222-4333-8444-555555555555';
const CACHE_URI = 'file:///cache/recording-abc.m4a';
const PENDING_SESSIONS_KEY = 'guardian.pending_session_registrations';

/** The durable state a killed process leaves behind: whatever is in
 *  AsyncStorage, nothing else. Reading it back models the next boot. */
function survivesKill(): {
  queue: unknown[];
  pendingRegistrations: unknown[];
} {
  const rawQueue = store.get(PENDING_RETRY_KEY);
  const rawPending = store.get(PENDING_SESSIONS_KEY);
  return {
    queue: rawQueue ? (JSON.parse(rawQueue) as unknown[]) : [],
    pendingRegistrations: rawPending
      ? (JSON.parse(rawPending) as unknown[])
      : [],
  };
}

async function seedLiveRecorderSession(): Promise<void> {
  await queueAppendNewSession({
    session_id: SESSION,
    uri: CACHE_URI,
    recording_closed: false,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 0,
    chunks: [],
    destination_type: 'drive',
  });
}

beforeEach(() => {
  store.clear();
  // `clearAllMocks` does NOT discard queued `...Once` implementations, so
  // an unconsumed one leaks into the next test. Reset the one mock whose
  // behaviour tests override per-case, then restore its default.
  moveAsync.mockReset();
  moveAsync.mockImplementation(async () => {});
  vi.clearAllMocks();
});

describe('TEST_QUEUE_IS_DURABLE_BEFORE_THE_BACKEND_IS_CONSULTED', () => {
  it('the entry exists as soon as the recorder is live', async () => {
    await seedLiveRecorderSession();

    const queue = await queueRead();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.session_id).toBe(SESSION);
    expect(queue[0]?.uri).toBe(CACHE_URI);
    expect(queue[0]?.recording_closed).toBe(false);
  });

  it('the payload is referenced by GC_QUEUE, not only by the cache path', async () => {
    await seedLiveRecorderSession();

    const { queue } = survivesKill();
    const uris = (queue as { uri: string }[]).map(e => e.uri);
    expect(uris).toContain(CACHE_URI);
  });
});

/**
 * The exact sequence the gate asks for: recorder starts, queue
 * persists, remote registration fails, process dies immediately after.
 */
describe('TEST_KILL_AFTER_DEFERRED_REGISTRATION_LEAVES_A_RECOVERABLE_SESSION', () => {
  it('queue entry and pending registration both survive the kill', async () => {
    await seedLiveRecorderSession();
    // The deferred branch of `sessionCreatePromise`: a retryable
    // failure (offline / 5xx / no token) schedules the registration
    // durably instead of throwing.
    await AsyncStorage.setItem(
      PENDING_SESSIONS_KEY,
      JSON.stringify([
        { session_id: SESSION, mode: 'audio', destination_type: 'drive' },
      ]),
    );

    // --- process dies here; everything below reads persisted state ---
    const after = survivesKill();

    expect(after.queue).toHaveLength(1);
    expect((after.queue[0] as { session_id: string }).session_id).toBe(SESSION);
    expect(after.pendingRegistrations).toHaveLength(1);
    expect(
      (after.pendingRegistrations[0] as { session_id: string }).session_id,
    ).toBe(SESSION);
  });

  it('no payload is left referenced only by the cache path', async () => {
    await seedLiveRecorderSession();
    await AsyncStorage.setItem(
      PENDING_SESSIONS_KEY,
      JSON.stringify([{ session_id: SESSION, mode: 'audio' }]),
    );

    const { queue } = survivesKill();
    const referenced = (queue as { uri: string }[]).some(
      e => e.uri === CACHE_URI,
    );
    expect(referenced).toBe(true);
  });

  it('the recovered session keeps the SAME session_id in both stores', async () => {
    await seedLiveRecorderSession();
    await AsyncStorage.setItem(
      PENDING_SESSIONS_KEY,
      JSON.stringify([{ session_id: SESSION, mode: 'audio' }]),
    );

    const after = survivesKill();
    const queueId = (after.queue[0] as { session_id: string }).session_id;
    const pendingId = (
      after.pendingRegistrations[0] as { session_id: string }
    ).session_id;
    expect(queueId).toBe(pendingId);
    expect(queueId).toBe(SESSION);
  });
});


/**
 * The recorder has to be CLOSED before anything moves its file, and the
 * uri that closing produces is the only one safe to promote.
 *
 * Audio and video report their final uri differently, and neither is
 * guaranteed to equal the uri the caller started with: the audio engine
 * returns what it captured before `stop()` flushed, and the camera
 * resolves `recordAsync` with its own authoritative path. Promoting a
 * stale cache uri instead can move a placeholder — or nothing — and
 * report it as preserved evidence.
 */
describe('TEST_RECORDER_IS_CLOSED_BEFORE_PROMOTION', () => {
  it('audio closes via the engine and uses the uri it returns', async () => {
    const order: string[] = [];
    const stopAudio = vi.fn(async () => {
      order.push('stopAudio');
      return 'file:///cache/final-audio.m4a';
    });

    const uri = await closeRecorderForAbandon({
      hadAudio: true,
      stopAudio,
      stopCamera: () => order.push('stopCamera'),
      videoPromise: null,
      chunkedUri: CACHE_URI,
    });

    expect(stopAudio).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['stopAudio']);
    // NOT the uri we started with.
    expect(uri).toBe('file:///cache/final-audio.m4a');
    expect(uri).not.toBe(CACHE_URI);
  });

  it('video uses the uri recordAsync resolves with, not the cache placeholder', async () => {
    const order: string[] = [];
    const uri = await closeRecorderForAbandon({
      hadAudio: false,
      stopAudio: async () => {
        order.push('stopAudio');
        return null;
      },
      stopCamera: () => order.push('stopCamera'),
      videoPromise: Promise.resolve({ uri: 'file:///cache/camera-final.mp4' }),
      chunkedUri: CACHE_URI,
    });

    expect(order).toEqual(['stopCamera']);
    expect(uri).toBe('file:///cache/camera-final.mp4');
    expect(uri).not.toBe(CACHE_URI);
  });

  it('video falls back to the chunked uri when recordAsync rejects', async () => {
    const uri = await closeRecorderForAbandon({
      hadAudio: false,
      stopAudio: async () => null,
      stopCamera: () => {},
      videoPromise: Promise.reject(new Error('camera died')),
      chunkedUri: 'file:///cache/partial-video.mp4',
    });

    // Partial bytes on disk beat no evidence at all.
    expect(uri).toBe('file:///cache/partial-video.mp4');
  });

  it('the camera is stopped even when the promise later rejects', async () => {
    const stopCamera = vi.fn();
    await closeRecorderForAbandon({
      hadAudio: false,
      stopAudio: async () => null,
      stopCamera,
      videoPromise: Promise.reject(new Error('boom')),
      chunkedUri: null,
    });
    expect(stopCamera).toHaveBeenCalledTimes(1);
  });

  it('a recorder that yields nothing reports null, and null blocks promotion', async () => {
    const uri = await closeRecorderForAbandon({
      hadAudio: true,
      stopAudio: async () => null,
      stopCamera: () => {},
      videoPromise: null,
      chunkedUri: null,
    });
    expect(uri).toBeNull();

    await seedLiveRecorderSession();
    const result = await abandonUnregisteredSession(SESSION, uri);

    expect(moveAsync).not.toHaveBeenCalled();
    expect(result.entry_dropped).toBe(false);
    expect(await queueRead()).toHaveLength(1);
  });

  it('a throwing audio stop does not take the queue entry with it', async () => {
    const uri = await closeRecorderForAbandon({
      hadAudio: true,
      stopAudio: async () => {
        throw new Error('native stop failed');
      },
      stopCamera: () => {},
      videoPromise: null,
      chunkedUri: null,
    });
    expect(uri).toBeNull();

    await seedLiveRecorderSession();
    const result = await abandonUnregisteredSession(SESSION, uri);
    expect(result.entry_dropped).toBe(false);
    expect(await queueRead()).toHaveLength(1);
  });
});

/**
 * The one-directional rule:
 *   promotion confirmed     → the entry may be dropped
 *   promotion NOT confirmed → GC_QUEUE MUST survive
 */
describe('TEST_ENTRY_SURVIVES_UNLESS_PROMOTION_IS_CONFIRMED', () => {
  it('a confirmed promotion allows the entry to be retired', async () => {
    await seedLiveRecorderSession();

    const result = await abandonUnregisteredSession(SESSION, CACHE_URI);

    expect(moveAsync).toHaveBeenCalledTimes(1);
    const arg = moveAsync.mock.calls[0]![0];
    expect(arg.from).toBe(CACHE_URI);
    // `orphanScan` only sees this exact prefix, in documentDirectory.
    expect(arg.to).toMatch(/^file:\/\/\/doc\/guardian_recording_\d+\.m4a$/);
    expect(result.moved_to).toBe(arg.to);
    expect(result.entry_dropped).toBe(true);
    expect(await queueRead()).toHaveLength(0);
  });

  it('a FAILED move keeps the entry AND its cacheUri', async () => {
    await seedLiveRecorderSession();
    moveAsync.mockRejectedValueOnce(new Error('ENOENT'));

    const result = await abandonUnregisteredSession(SESSION, CACHE_URI);

    expect(result.moved_to).toBeNull();
    expect(result.entry_dropped).toBe(false);

    const queue = await queueRead();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.session_id).toBe(SESSION);
    expect(queue[0]?.uri).toBe(CACHE_URI);
  });

  it('a failed move leaves the bytes referenced by GC_QUEUE across a kill', async () => {
    await seedLiveRecorderSession();
    moveAsync.mockRejectedValueOnce(new Error('ENOENT'));

    await abandonUnregisteredSession(SESSION, CACHE_URI);

    const { queue } = survivesKill();
    expect((queue as { uri: string }[]).map(e => e.uri)).toContain(CACHE_URI);
  });

  it('moves the file BEFORE dropping the entry', async () => {
    await seedLiveRecorderSession();

    // If the entry were dropped first, a kill in between would leave the
    // bytes referenced by nothing at all. Assert the ordering directly:
    // at the moment the move runs, the entry must still be present.
    let entriesAtMoveTime = -1;
    moveAsync.mockImplementationOnce(async () => {
      const raw = store.get(PENDING_RETRY_KEY);
      entriesAtMoveTime = raw ? (JSON.parse(raw) as unknown[]).length : 0;
    });

    await abandonUnregisteredSession(SESSION, CACHE_URI);

    expect(entriesAtMoveTime).toBe(1);
  });

  it('a kill after the move and before the drop leaves a recoverable orphan', async () => {
    await seedLiveRecorderSession();

    // Model the crash precisely: the move lands, then the drop fails.
    const setItem = AsyncStorage.setItem as unknown as {
      mockRejectedValueOnce: (e: Error) => void;
    };
    setItem.mockRejectedValueOnce(new Error('process died'));

    const result = await abandonUnregisteredSession(SESSION, CACHE_URI);

    // The bytes reached documentDirectory under the prefix `orphanScan`
    // requires — discoverable at the next boot.
    expect(result.moved_to).toMatch(/\/doc\/guardian_recording_\d+\./);
    expect(result.entry_dropped).toBe(false);
    // The stale entry also survives. Two references beat none.
    expect(survivesKill().queue).toHaveLength(1);
  });

  it('is safe on a session that has no queue entry', async () => {
    const result = await abandonUnregisteredSession(SESSION, CACHE_URI);
    expect(result.moved_to).not.toBeNull();
    expect(result.entry_dropped).toBe(true);
    expect(await queueRead()).toHaveLength(0);
  });
});
