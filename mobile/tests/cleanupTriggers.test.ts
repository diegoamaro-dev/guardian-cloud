/**
 * When a finalization asks for cleanup — and when it must not.
 *
 * These exercise the real path through `tryFinalizeReadySessions`, not a
 * private helper, so the ordering under test is the one production runs:
 * authorize, then `queueMarkSessionCompleted`, then `reapEntry`, and only then
 * the request. `finalizeAndAuthorizeCleanup` stays unexported on purpose —
 * widening the module's surface to make it testable would be a worse trade than
 * driving it from the outside.
 *
 * The scheduler is mocked so each case can assert exactly whether a request was
 * made. Its own behaviour is covered in sessionCleanupScheduler.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Queue-key writes are counted so a specific one can be made to fail. */
const storeState = {
  map: new Map<string, string>(),
  /** Fail the Nth queue write that happens after the journal has an entry. */
  failQueueWriteAfterJournal: 0,
  queueWritesAfterJournal: 0,
  journalWritten: false,
};

const QUEUE_KEY = 'test.pending_retry';
const JOURNAL_KEY = 'guardian.segment_cleanup.v1';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => storeState.map.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      if (k === JOURNAL_KEY) storeState.journalWritten = true;
      if (k === QUEUE_KEY && storeState.journalWritten) {
        storeState.queueWritesAfterJournal += 1;
        if (
          storeState.failQueueWriteAfterJournal > 0 &&
          storeState.queueWritesAfterJournal ===
            storeState.failQueueWriteAfterJournal
        ) {
          throw new Error('queue write failed');
        }
      }
      storeState.map.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      storeState.map.delete(k);
    }),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const k of keys) storeState.map.delete(k);
    }),
    getAllKeys: vi.fn(async () => Array.from(storeState.map.keys())),
    clear: vi.fn(async () => storeState.map.clear()),
  },
}));

vi.mock('@/auth/store', () => ({
  // R6: no-op = ownership gate open. Tests that need it SHUT override it.
  assertOwnershipGateOpen: vi.fn(),
  isOwnershipGateOpen: vi.fn(() => true),
  useAuthStore: { setState: vi.fn(), getState: vi.fn(() => ({ status: 'loading' })) },
  getFreshAccessToken: vi.fn(async () => 'test-token'),
  getOwnershipAccessToken: vi.fn(async () => 'test-token'),
}));

// Hoisted: index.tsx builds the scheduler at module scope, so the factory runs
// during import — before a plain `const` here would be initialized.
const { requestCleanup } = vi.hoisted(() => ({ requestCleanup: vi.fn() }));
vi.mock('@/video/sessionCleanupScheduler', () => ({
  createCleanupScheduler: () => ({
    requestCleanup,
    whenIdle: async () => undefined,
  }),
}));

import {
  queueAppendNewSession,
  queueRead,
  tryFinalizeReadySessions,
  type PendingQueueEntry,
  type QueueChunk,
} from '../app/index';

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function uploadedChunk(i: number): QueueChunk {
  return {
    chunk_index: i,
    hash: 'h'.repeat(64),
    size: 10,
    status: 'uploaded',
    attempts: 1,
    remote_reference: `ref-${i}`,
  };
}

function readyEntry(overrides: Partial<PendingQueueEntry> = {}): PendingQueueEntry {
  return {
    session_id: SID,
    uri: '',
    recording_closed: true,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 1,
    chunks: [uploadedChunk(0)],
    destination_type: 'drive',
    ...overrides,
  };
}

/** Shapes what `completeSession` sees. */
function respondWith(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    })),
  );
}

beforeEach(() => {
  storeState.map.clear();
  storeState.failQueueWriteAfterJournal = 0;
  storeState.queueWritesAfterJournal = 0;
  storeState.journalWritten = false;
  requestCleanup.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});

describe('cleanup is requested only after a confirmed, fully persisted finalization', () => {
  it('1 · a 200 completion requests cleanup', async () => {
    await queueAppendNewSession(readyEntry());
    respondWith(200);

    await tryFinalizeReadySessions();

    expect(requestCleanup).toHaveBeenCalledTimes(1);
    expect(requestCleanup).toHaveBeenCalledWith('finalized');
    expect(await queueRead()).toHaveLength(0);
  });

  it('2 · a 409 SESSION_ALREADY_COMPLETED requests cleanup', async () => {
    await queueAppendNewSession(readyEntry());
    respondWith(409, { code: 'SESSION_ALREADY_COMPLETED' });

    await tryFinalizeReadySessions();

    expect(requestCleanup).toHaveBeenCalledTimes(1);
    expect(requestCleanup).toHaveBeenCalledWith('finalized');
    expect(await queueRead()).toHaveLength(0);
  });

  it('3 · an unconfirmed completion requests nothing', async () => {
    for (const status of [500, 401, 404, 422]) {
      storeState.map.clear();
      storeState.journalWritten = false;
      requestCleanup.mockClear();

      await queueAppendNewSession(readyEntry());
      respondWith(status);
      await tryFinalizeReadySessions();

      expect(requestCleanup).not.toHaveBeenCalled();
      // The entry stays for a retry; nothing was authorized.
      expect(await queueRead()).toHaveLength(1);
      expect(storeState.map.get(JOURNAL_KEY)).toBeUndefined();
    }
  });

  it('4 · a refused authorization requests nothing', async () => {
    // An unusable journal makes `authorize` return ok:false. Its bytes must be
    // preserved and the entry must survive.
    storeState.map.set(JOURNAL_KEY, '{ not json at all');
    await queueAppendNewSession(readyEntry());
    respondWith(200);

    await tryFinalizeReadySessions();

    expect(requestCleanup).not.toHaveBeenCalled();
    expect(storeState.map.get(JOURNAL_KEY)).toBe('{ not json at all');
    expect(await queueRead()).toHaveLength(1);
  });

  it('5 · a failed queueMarkSessionCompleted requests nothing', async () => {
    await queueAppendNewSession(readyEntry());
    respondWith(200);
    // The first queue write after the journal entry exists is the mark.
    storeState.failQueueWriteAfterJournal = 1;

    await tryFinalizeReadySessions();

    expect(requestCleanup).not.toHaveBeenCalled();
  });

  it('6 · a failed reapEntry requests nothing prematurely', async () => {
    await queueAppendNewSession(readyEntry());
    respondWith(200);
    // Mark succeeds; the next queue write — the reap — fails.
    storeState.failQueueWriteAfterJournal = 2;

    await tryFinalizeReadySessions();

    expect(requestCleanup).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [afterFailedReap] = await queueRead();
    expect(afterFailedReap?.session_completed).toBe(true);
    expect(afterFailedReap?.complete_attempts).toBe(0);

    // The completed-entry branch performs only the pending reap. It must not
    // call completeSession again, and a successful reap must finally trigger
    // the already-durable cleanup without waiting for another boot.
    await tryFinalizeReadySessions();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestCleanup).toHaveBeenCalledTimes(1);
    expect(requestCleanup).toHaveBeenCalledWith('finalized');
    expect(await queueRead()).toHaveLength(0);
  });

  it('requests once per finalized session in a multi-session pass', async () => {
    // The finalize loop can complete several sessions in one pass; each one
    // that reaches the end of the helper asks, and the scheduler collapses
    // them. That collapsing is the scheduler's job, not this loop's.
    await queueAppendNewSession(readyEntry());
    await queueAppendNewSession(
      readyEntry({ session_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }),
    );
    respondWith(200);

    await tryFinalizeReadySessions();

    expect(requestCleanup).toHaveBeenCalledTimes(2);
    expect(requestCleanup).toHaveBeenCalledWith('finalized');
    expect(await queueRead()).toHaveLength(0);
  });

  it('an entry blocked by the completion gate requests nothing', async () => {
    // A hole in 0..next-1: the gate refuses, no completeSession, no
    // authorization, no cleanup.
    await queueAppendNewSession(
      readyEntry({ next_chunk_index: 3, chunks: [uploadedChunk(0), uploadedChunk(2)] }),
    );
    respondWith(200);

    await tryFinalizeReadySessions();

    expect(requestCleanup).not.toHaveBeenCalled();
    expect(await queueRead()).toHaveLength(1);
  });

  it('an already-completed entry requests cleanup only after its reap succeeds', async () => {
    // session_completed=true reaches reapEntry through the branch above the
    // helper, so it never authorizes or calls completeSession again. It asks
    // after the reap because a prior pass may have persisted authorization and
    // mark, then failed before it could remove GC_QUEUE and trigger cleanup.
    // A historical entry with no journal remains invisible to the runner.
    await queueAppendNewSession(readyEntry({ session_completed: true }));

    await tryFinalizeReadySessions();

    expect(requestCleanup).toHaveBeenCalledTimes(1);
    expect(requestCleanup).toHaveBeenCalledWith('finalized');
    expect(await queueRead()).toHaveLength(0);
  });
});
