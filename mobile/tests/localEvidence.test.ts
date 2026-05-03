/**
 * Tests for the local-evidence read-only helpers used by the offline
 * export fallback and the partial-video integrity recompute.
 *
 * Both helpers read the persisted upload queue (PENDING_RETRY_KEY in
 * app/index.tsx) and stat the on-disk recording file. They MUST never
 * mutate either source. We verify:
 *
 *   findLocalRecordingUri:
 *     - returns the URI when queue has the entry AND file exists
 *     - returns null when queue is empty
 *     - returns null when no entry matches the session_id
 *     - returns null when entry has no `uri`
 *     - returns null when file does not exist on disk
 *     - returns null on parse failure (corrupt AsyncStorage value)
 *
 *   findLocalExpectedChunkCount:
 *     - prefers next_chunk_index when positive
 *     - falls back to chunks.length when next_chunk_index is missing/0
 *     - returns null when both signals are absent
 *     - returns null when no entry matches the session_id
 *
 * AsyncStorage and expo-file-system are fully mocked. The production
 * helpers are imported directly — no behaviour is altered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks MUST be declared before importing the module under test so the
// helpers see the mocked modules at import time.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

vi.mock('expo-file-system', () => ({
  getInfoAsync: vi.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import {
  findLocalRecordingUri,
  findLocalExpectedChunkCount,
} from '../src/recording/localEvidence';

const PENDING_RETRY_KEY = 'test.pending_retry';

beforeEach(() => {
  vi.mocked(AsyncStorage.getItem).mockReset();
  vi.mocked(FileSystem.getInfoAsync).mockReset();
});

describe('findLocalRecordingUri', () => {
  it('returns the URI when the queue has the entry and the file exists', async () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const uri = 'file:///doc/guardian_recording_111.m4a';
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([{ session_id: sid, uri, chunks: [] }]),
    );
    // expo-file-system's getInfoAsync return shape is loose; cast to any
    // to satisfy the discriminated-union typing without rebuilding the
    // whole type tree.
    vi.mocked(FileSystem.getInfoAsync).mockResolvedValue({
      exists: true,
      uri,
      size: 1234,
      isDirectory: false,
      modificationTime: 0,
      md5: undefined,
    } as unknown as Awaited<ReturnType<typeof FileSystem.getInfoAsync>>);

    await expect(findLocalRecordingUri(sid)).resolves.toBe(uri);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(PENDING_RETRY_KEY);
  });

  it('returns null when the queue is empty (no key yet)', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    await expect(findLocalRecordingUri('whatever')).resolves.toBeNull();
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  });

  it('returns null when no entry matches the session id', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
        { session_id: 'other-sid', uri: 'file:///doc/x.m4a', chunks: [] },
      ]),
    );
    await expect(findLocalRecordingUri('not-in-queue')).resolves.toBeNull();
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  });

  it('returns null when the matched entry has no uri', async () => {
    const sid = 'no-uri-sid';
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([{ session_id: sid, uri: '', chunks: [] }]),
    );
    await expect(findLocalRecordingUri(sid)).resolves.toBeNull();
    expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  });

  it('returns null when the file no longer exists on disk', async () => {
    const sid = 'gone-from-disk';
    const uri = 'file:///doc/gone.m4a';
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([{ session_id: sid, uri, chunks: [] }]),
    );
    vi.mocked(FileSystem.getInfoAsync).mockResolvedValue({
      exists: false,
      uri,
      isDirectory: false,
    } as unknown as Awaited<ReturnType<typeof FileSystem.getInfoAsync>>);
    await expect(findLocalRecordingUri(sid)).resolves.toBeNull();
  });

  it('returns null on corrupt AsyncStorage payload (does not throw)', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('{not-json}');
    await expect(findLocalRecordingUri('any')).resolves.toBeNull();
  });

  it('returns null when AsyncStorage rejects (does not throw)', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(
      new Error('AsyncStorage exploded'),
    );
    await expect(findLocalRecordingUri('any')).resolves.toBeNull();
  });
});

describe('findLocalExpectedChunkCount', () => {
  it('prefers next_chunk_index when it is a positive number', async () => {
    const sid = 'with-nci';
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
        {
          session_id: sid,
          uri: 'file:///x',
          next_chunk_index: 32,
          chunks: [{ chunk_index: 0 }, { chunk_index: 1 }], // length=2 ignored
        },
      ]),
    );
    await expect(findLocalExpectedChunkCount(sid)).resolves.toBe(32);
  });

  it('falls back to chunks.length when next_chunk_index is missing', async () => {
    const sid = 'no-nci';
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
        {
          session_id: sid,
          uri: 'file:///x',
          chunks: [
            { chunk_index: 0 },
            { chunk_index: 1 },
            { chunk_index: 2 },
          ],
        },
      ]),
    );
    await expect(findLocalExpectedChunkCount(sid)).resolves.toBe(3);
  });

  it('falls back to chunks.length when next_chunk_index is 0', async () => {
    // 0 is treated as "not yet emitted" — same as missing.
    const sid = 'nci-zero';
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
        {
          session_id: sid,
          uri: 'file:///x',
          next_chunk_index: 0,
          chunks: [{ chunk_index: 0 }, { chunk_index: 1 }],
        },
      ]),
    );
    await expect(findLocalExpectedChunkCount(sid)).resolves.toBe(2);
  });

  it('returns null when both next_chunk_index and chunks are empty/absent', async () => {
    const sid = 'empty-entry';
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
        { session_id: sid, uri: 'file:///x', chunks: [] },
      ]),
    );
    await expect(findLocalExpectedChunkCount(sid)).resolves.toBeNull();
  });

  it('returns null when the queue has no entry for this session_id', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
        {
          session_id: 'other-sid',
          uri: 'file:///x',
          next_chunk_index: 5,
          chunks: [],
        },
      ]),
    );
    await expect(
      findLocalExpectedChunkCount('not-in-queue'),
    ).resolves.toBeNull();
  });

  it('returns null on corrupt AsyncStorage payload (does not throw)', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('{not-json}');
    await expect(findLocalExpectedChunkCount('any')).resolves.toBeNull();
  });
});
