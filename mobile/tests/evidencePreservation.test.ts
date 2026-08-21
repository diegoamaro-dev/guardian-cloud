/**
 * Phase 1A — the nuclear rule.
 *
 *   LOCAL_BYTES_OR_REFERENCES_MAY_BE_REMOVED_ONLY_AFTER_REMOTE_UPLOAD_IS
 *   _POSITIVELY_CONFIRMED
 *
 * "Positively confirmed" means all of: a 2xx, a non-null
 * `remote_reference`, AND that pair durably persisted to GC_QUEUE. Any
 * weaker condition — including an error the old code happened to call
 * `permanent` — must leave every byte, hash and index untouched.
 *
 * These tests drive the real worker so the assertion is about the
 * shipped code path, not a re-implementation of it.
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

const deleteAsync = vi.fn(async () => undefined);
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  getInfoAsync: vi.fn(async () => ({ exists: true, size: 4 })),
  // Non-empty: a video chunk's bytes really are on disk in these
  // fixtures. Returning '' would send the worker down the
  // REHYDRATE_FAILED path, which is a different scenario entirely.
  readAsStringAsync: vi.fn(async () => 'AAAA'),
  writeAsStringAsync: vi.fn(),
  deleteAsync: (...a: unknown[]) =>
    (deleteAsync as unknown as (...x: unknown[]) => unknown)(...a),
  moveAsync: vi.fn(),
  readDirectoryAsync: vi.fn(async () => []),
  makeDirectoryAsync: vi.fn(),
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

const getFreshAccessToken = vi.fn(async (): Promise<string | null> => 'tok');
vi.mock('@/auth/store', () => ({
  useAuthStore: { setState: vi.fn(), getState: vi.fn(() => ({ status: 'loading' })) },
  getFreshAccessToken: (...a: unknown[]) =>
    (getFreshAccessToken as unknown as (...x: unknown[]) => Promise<string | null>)(...a),
}));

const uploadChunkBytes = vi.fn();
vi.mock('@/api/destinations', () => ({
  getConnectedDrive: vi.fn(async () => null),
  listDestinations: vi.fn(async () => ({ destinations: [] })),
  uploadChunkBytes: (...a: unknown[]) =>
    (uploadChunkBytes as unknown as (...x: unknown[]) => unknown)(...a),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PENDING_RETRY_KEY,
  uploadDrainLoop,
  _setDrainPreconditionsForTests,
  type PendingQueueEntry,
  type QueueChunk,
} from '../app/index';
import { _resetPauseStoreForTests } from '../src/upload/pauseStore';

const storage = AsyncStorage as unknown as { __store__: Map<string, string> };
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HASH = 'a'.repeat(64);

function apiErr(status: number, code?: string): Error {
  const e = new Error(code ?? `HTTP ${status}`) as Error & {
    status: number;
    code?: string;
  };
  e.status = status;
  if (code) e.code = code;
  return e;
}

function seedEntry(chunkOverrides: Partial<QueueChunk> = {}): void {
  const e: PendingQueueEntry = {
    session_id: SID,
    uri: 'file:///doc/rec.m4a',
    recording_closed: true,
    session_completed: false,
    complete_attempts: 0,
    emitted_base64_length: 0,
    next_chunk_index: 1,
    destination_type: 'drive',
    chunks: [
      {
        chunk_index: 0,
        hash: HASH,
        size: 4,
        status: 'pending',
        attempts: 0,
        base64Slice: 'AAAA',
        ...chunkOverrides,
      },
    ],
  };
  storage.__store__.set(PENDING_RETRY_KEY, JSON.stringify([e]));
}

function readChunk(): QueueChunk | undefined {
  const raw = storage.__store__.get(PENDING_RETRY_KEY);
  if (!raw) return undefined;
  return (JSON.parse(raw) as PendingQueueEntry[])[0]?.chunks[0];
}

function okFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{}',
      json: async () => ({}),
    })),
  );
}

beforeEach(() => {
  storage.__store__.clear();
  _resetPauseStoreForTests();
  vi.clearAllMocks();
  deleteAsync.mockResolvedValue(undefined);
  getFreshAccessToken.mockResolvedValue('tok');
  _setDrainPreconditionsForTests({
    destinationResolved: true,
    activeDestinationType: 'drive',
  });
});

describe('unconfirmed evidence is never pruned', () => {
  const cases: Array<[string, Error]> = [
    ['TEST_BODY_TOO_LARGE_PRESERVES_BASE64_AND_METADATA', apiErr(413, 'BODY_TOO_LARGE')],
    [
      'TEST_SESSION_NOT_ACTIVE_PRESERVES_BASE64_AND_METADATA',
      apiErr(409, 'SESSION_NOT_ACTIVE'),
    ],
    ['TEST_UNCLASSIFIED_PRESERVES_BASE64_AND_METADATA', apiErr(403)],
  ];

  for (const [name, err] of cases) {
    it(name, async () => {
      seedEntry();
      uploadChunkBytes.mockRejectedValue(err);

      await uploadDrainLoop();

      const c = readChunk();
      expect(c?.base64Slice).toBe('AAAA');
      expect(c?.hash).toBe(HASH);
      expect(c?.chunk_index).toBe(0);
      expect(c?.size).toBe(4);
      // Paused, not terminal: still selectable when the pause lifts.
      expect(c?.status).toBe('pending');
    });
  }

  it('TEST_UNCONFIRMED_CHUNK_IS_NEVER_PRUNED — HASH_MISMATCH keeps its bytes', async () => {
    seedEntry();
    uploadChunkBytes.mockRejectedValue(apiErr(400, 'HASH_MISMATCH'));

    await uploadDrainLoop();

    const c = readChunk();
    expect(c?.base64Slice).toBe('AAAA');
    expect(c?.hash).toBe(HASH);
  });

  it('a video chunk keeps its local_uri when the upload fails', async () => {
    seedEntry({ base64Slice: undefined, local_uri: 'file:///doc/chunks/0.bin' });
    uploadChunkBytes.mockRejectedValue(apiErr(409, 'SESSION_NOT_ACTIVE'));

    await uploadDrainLoop();

    const c = readChunk();
    expect(c?.local_uri).toBe('file:///doc/chunks/0.bin');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('an unknown thrown error preserves evidence too', async () => {
    seedEntry();
    uploadChunkBytes.mockRejectedValue(new TypeError('x is not a function'));

    await uploadDrainLoop();

    const c = readChunk();
    expect(c?.base64Slice).toBe('AAAA');
    expect(c?.status).toBe('pending');
  });
});

describe('a 2xx is necessary but not sufficient — remote_reference must be valid', () => {
  // `uploadChunkBytes` ends in `return parsed as DriveChunkUploadResponse`
  // with no runtime check (src/api/destinations.ts). These cases are what
  // that cast lets through. Each must preserve every local byte.
  const invalid: Array<[string, unknown]> = [
    ['TEST_2XX_WITH_UNDEFINED_REMOTE_REFERENCE_PRESERVES_EVIDENCE', {}],
    ['TEST_2XX_WITH_NULL_REMOTE_REFERENCE_PRESERVES_EVIDENCE', { remote_reference: null }],
    ['TEST_2XX_WITH_EMPTY_REMOTE_REFERENCE_PRESERVES_EVIDENCE', { remote_reference: '' }],
  ];

  for (const [name, response] of invalid) {
    it(name, async () => {
      seedEntry({ local_uri: 'file:///doc/chunks/0.bin' });
      uploadChunkBytes.mockResolvedValue(response);
      okFetch();

      await uploadDrainLoop();

      const c = readChunk();
      expect(c?.base64Slice).toBe('AAAA');
      expect(c?.local_uri).toBe('file:///doc/chunks/0.bin');
      expect(c?.hash).toBe(HASH);
      expect(c?.chunk_index).toBe(0);
      expect(c?.status).toBe('pending');
      expect(c?.remote_reference).toBeUndefined();
      expect(deleteAsync).not.toHaveBeenCalled();
    });
  }

  it('whitespace-only remote_reference is rejected too', async () => {
    seedEntry();
    uploadChunkBytes.mockResolvedValue({ remote_reference: '   ' });
    okFetch();

    await uploadDrainLoop();

    expect(readChunk()?.base64Slice).toBe('AAAA');
    expect(readChunk()?.status).toBe('pending');
  });

  it('a null response body is rejected rather than dereferenced', async () => {
    seedEntry();
    uploadChunkBytes.mockResolvedValue(null);
    okFetch();

    await uploadDrainLoop();

    expect(readChunk()?.base64Slice).toBe('AAAA');
    expect(readChunk()?.status).toBe('pending');
  });

  it('TEST_INVALID_REMOTE_REFERENCE_IS_NOT_POSTED_AS_UPLOADED', async () => {
    seedEntry();
    uploadChunkBytes.mockResolvedValue({});
    const fetchSpy = vi.fn(async (url: string, init?: { body?: unknown }) => {
      void url;
      void init;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => '{}',
        json: async () => ({}),
      };
    });
    vi.stubGlobal('fetch', fetchSpy);

    await uploadDrainLoop();

    // POST /chunks must never be told this chunk is uploaded.
    const uploadedPosts = fetchSpy.mock.calls.filter(call => {
      const u = String(call[0]);
      const body = String(call[1]?.body ?? '');
      return u.endsWith('/chunks') && body.includes('"status":"uploaded"');
    });
    expect(uploadedPosts).toHaveLength(0);
  });

  it('the invalid-reference pause is entry-scoped, not global', async () => {
    seedEntry();
    uploadChunkBytes.mockResolvedValue({});
    okFetch();

    await uploadDrainLoop();

    const raw = storage.__store__.get('gc.pause.global.v1');
    const pause = raw ? (JSON.parse(raw) as { client_auth: unknown; systemic: unknown }) : null;
    expect(pause?.client_auth ?? null).toBeNull();
    expect(pause?.systemic ?? null).toBeNull();

    const q = JSON.parse(
      storage.__store__.get(PENDING_RETRY_KEY) as string,
    ) as PendingQueueEntry[];
    expect(q[0]?.paused?.reason).toBe('UNCLASSIFIED_PAUSE');
  });
});

describe('TEST_CONFIRMED_UPLOAD_CAN_STILL_CLEAN_LOCAL_BYTES', () => {
  it('a 2xx with a remote_reference releases the bytes and deletes the file', async () => {
    seedEntry({ local_uri: 'file:///doc/chunks/0.bin' });
    uploadChunkBytes.mockResolvedValue({ remote_reference: 'drive-file-1' });
    okFetch();

    await uploadDrainLoop();

    const c = readChunk();
    // Entry may already be reaped once complete; if present it must be
    // recorded as uploaded with its reference.
    if (c) {
      expect(c.status).toBe('uploaded');
      expect(c.remote_reference).toBe('drive-file-1');
      expect(c.base64Slice).toBeUndefined();
    }
    expect(deleteAsync).toHaveBeenCalledWith('file:///doc/chunks/0.bin', {
      idempotent: true,
    });
  });
});

describe('TEST_QUEUE_PERSISTENCE_FAILURE_PREVENTS_LOCAL_FILE_DELETE', () => {
  it('a failed confirmation write leaves the local file on disk', async () => {
    seedEntry({ local_uri: 'file:///doc/chunks/0.bin' });
    uploadChunkBytes.mockResolvedValue({ remote_reference: 'drive-file-1' });
    okFetch();

    // Break exactly one write: the one recording the confirmation,
    // identified by the remote_reference landing in the payload. The
    // remote copy exists but we hold no durable record of it, so
    // nothing local may be deleted.
    let broken = false;
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (k: string, v: string) => {
      if (!broken && v.includes('drive-file-1')) {
        broken = true;
        throw new Error('CursorWindow: Row too big');
      }
      storage.__store__.set(k, v);
    });

    await uploadDrainLoop();

    expect(broken).toBe(true);
    expect(deleteAsync).not.toHaveBeenCalled();

    // The chunk stays recoverable: bytes intact, not marked uploaded.
    const c = readChunk();
    expect(c?.base64Slice).toBe('AAAA');
    expect(c?.status).not.toBe('uploaded');
  });

  it('a local delete failure does not revert the remote confirmation', async () => {
    seedEntry({ local_uri: 'file:///doc/chunks/0.bin' });
    uploadChunkBytes.mockResolvedValue({ remote_reference: 'drive-file-1' });
    okFetch();
    deleteAsync.mockRejectedValue(new Error('EBUSY'));

    await uploadDrainLoop();

    const c = readChunk();
    if (c) {
      expect(c.status).toBe('uploaded');
      expect(c.remote_reference).toBe('drive-file-1');
    }
  });
});
