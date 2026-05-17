/**
 * Unit tests for the shared `exportFromChunkRefs` helper extracted in
 * COMMIT 3 from `mobile/src/api/export.ts`.
 *
 * Coverage:
 *   - happy path: all chunks valid → `complete`, file written
 *   - missing chunk (gap in input) → `partial`, stopReason='missing'
 *   - hash mismatch → `partial`, stopReason='hash_mismatch'
 *   - download failed → `partial`, stopReason='download_failed'
 *   - filename prefix `guardian_export_` for the normal path
 *   - filename prefix `guardian_recovered_` for the recovery path
 *
 * Drive, Supabase and `apiFetch` are out of scope: the helper does not
 * touch them. The `downloadFn` parameter is a per-test mock that returns
 * controlled bytes + headerHash.
 *
 * `expo-crypto.digest` is mocked deterministically so the test does not
 * compute real sha256: each call returns a 32-byte buffer filled with a
 * single octet, and the chunk's expected hash is `octet.repeat(32)`.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Mocks (must precede module import) ---------------------------------

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///mock/doc/',
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
  digest: vi.fn(),
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
}));

vi.mock('@/utils/log', () => ({
  log: vi.fn(),
  error: vi.fn(),
}));

// `@/config/env` is imported indirectly by the API client but the helper
// itself never reads it; stub a minimal env so module evaluation succeeds.
vi.mock('@/config/env', () => ({
  env: { apiUrl: 'http://mock' },
}));

// `@/auth/store` is imported by the API client; stub the single export
// the helper's import chain pulls in.
vi.mock('@/auth/store', () => ({
  getFreshAccessToken: vi.fn(),
  useAuthStore: { setState: vi.fn() },
}));

// Override the global `@/api/client` mock from `tests/setup.ts` (which
// only re-exports `ApiError`) so this file can drive `apiFetch` with
// controlled failures to exercise `listSessionChunks` auth retry. The
// `ApiError` class is mirrored locally with identical shape so the
// `instanceof` checks inside the helper under test still work.
vi.mock('@/api/client', () => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    readonly body: unknown;
    constructor(
      status: number,
      code: string | undefined,
      message: string,
      body: unknown,
    ) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }
  return { ApiError, apiFetch: vi.fn() };
});

import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';

import {
  exportFromChunkRefs,
  listSessionChunks,
  type ChunkRef,
  type ExportResult,
} from '../src/api/export';
import { ApiError, apiFetch } from '../src/api/client';

// --- Helpers ------------------------------------------------------------

/**
 * Build a 32-byte ArrayBuffer filled with `byte`. Used as the mocked
 * `Crypto.digest` return value: the hex encoding is the byte's 2-char
 * hex value repeated 32 times (= 64 hex chars = a valid sha256 string).
 */
function makeDigestBuffer(byte: number): ArrayBuffer {
  const arr = new Uint8Array(32);
  arr.fill(byte);
  return arr.buffer;
}

/** Hex sha256 that matches `makeDigestBuffer(byte)`. */
function hashOfByte(byte: number): string {
  return byte.toString(16).padStart(2, '0').repeat(32);
}

function refsFor(count: number, hashByte = 0xab): ChunkRef[] {
  const hash = hashOfByte(hashByte);
  return Array.from({ length: count }, (_, i) => ({
    chunk_index: i,
    hash,
    size: 16,
  }));
}

function mockDigestConstant(byte: number): void {
  vi.mocked(Crypto.digest).mockImplementation(async () =>
    makeDigestBuffer(byte),
  );
}

function mockDownloadOk(): (idx: number) => Promise<{
  bytes: Uint8Array;
  headerHash: string;
}> {
  return async (_idx: number) => ({
    bytes: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
    headerHash: '',
  });
}

beforeEach(() => {
  vi.mocked(FileSystem.writeAsStringAsync).mockReset();
  vi.mocked(FileSystem.writeAsStringAsync).mockResolvedValue(undefined);
  vi.mocked(Crypto.digest).mockReset();
});

// --- Happy path ---------------------------------------------------------

describe('exportFromChunkRefs — happy path', () => {
  it('returns status=complete when every chunk downloads and verifies', async () => {
    mockDigestConstant(0xab);
    const refs = refsFor(3);

    const result: ExportResult = await exportFromChunkRefs(
      'sess-1',
      'guardian_export',
      refs,
      mockDownloadOk(),
    );

    expect(result.status).toBe('complete');
    expect(result.validChunks).toBe(3);
    expect(result.totalChunks).toBe(3);
    expect(result.missingIndexes).toEqual([]);
    expect(result.corruptIndexes).toEqual([]);
    expect(result.stoppedAt).toBe(-1);
    expect(result.stopReason).toBeNull();
    expect(result.filePath).not.toBeNull();
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledTimes(1);
  });

  it("uses prefix 'guardian_export_' for the normal export path", async () => {
    mockDigestConstant(0xab);
    const refs = refsFor(1);

    const result = await exportFromChunkRefs(
      'sess-norm',
      'guardian_export',
      refs,
      mockDownloadOk(),
    );

    expect(result.filePath).toMatch(
      /^file:\/\/\/mock\/doc\/guardian_export_sess-norm\./,
    );
  });

  it("uses prefix 'guardian_recovered_' for the recovery export path", async () => {
    mockDigestConstant(0xab);
    const refs = refsFor(1);

    const result = await exportFromChunkRefs(
      'sess-rec',
      'guardian_recovered',
      refs,
      mockDownloadOk(),
    );

    expect(result.filePath).toMatch(
      /^file:\/\/\/mock\/doc\/guardian_recovered_sess-rec\./,
    );
  });

  it('honours mode=video and pins extension to .mp4 regardless of byte sniff', async () => {
    mockDigestConstant(0xab);
    const refs = refsFor(1);

    const result = await exportFromChunkRefs(
      'sess-vid',
      'guardian_recovered',
      refs,
      mockDownloadOk(),
      undefined,
      'video',
    );

    expect(result.extension).toBe('.mp4');
    expect(result.filePath).toMatch(/\.mp4$/);
  });

  it('drives onProgress through the export', async () => {
    mockDigestConstant(0xab);
    const refs = refsFor(2);
    const progress: { total: number; done: number; currentIndex: number }[] = [];

    await exportFromChunkRefs(
      'sess-progress',
      'guardian_export',
      refs,
      mockDownloadOk(),
      (p) => progress.push({ ...p }),
    );

    // First tick fires before downloading chunk 0; final tick after the
    // loop reports total/validChunks with currentIndex=-1.
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[progress.length - 1]!.currentIndex).toBe(-1);
  });
});

// --- Missing chunk ------------------------------------------------------

describe('exportFromChunkRefs — missing chunk in input', () => {
  it('stops at the first gap and reports status=partial with stopReason=missing', async () => {
    mockDigestConstant(0xab);
    // Chunks 0 and 2 — index 1 is missing.
    const refs: ChunkRef[] = [
      { chunk_index: 0, hash: hashOfByte(0xab), size: 16 },
      { chunk_index: 2, hash: hashOfByte(0xab), size: 16 },
    ];

    const result = await exportFromChunkRefs(
      'sess-missing',
      'guardian_export',
      refs,
      mockDownloadOk(),
    );

    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('missing');
    expect(result.stoppedAt).toBe(1);
    expect(result.missingIndexes).toContain(1);
    expect(result.validChunks).toBe(1); // only chunk 0 made it
    expect(result.totalChunks).toBe(3); // lastIndex (2) + 1
    expect(result.filePath).not.toBeNull(); // partial file still written
  });
});

// --- Hash mismatch ------------------------------------------------------

describe('exportFromChunkRefs — hash mismatch', () => {
  it('stops at the first mismatched chunk with stopReason=hash_mismatch', async () => {
    // Digest returns 0xab repeatedly. Chunk 0 declares hash for 0xab
    // (matches), chunk 1 declares hash for 0xcd (mismatches).
    mockDigestConstant(0xab);
    const refs: ChunkRef[] = [
      { chunk_index: 0, hash: hashOfByte(0xab), size: 16 },
      { chunk_index: 1, hash: hashOfByte(0xcd), size: 16 },
    ];

    const result = await exportFromChunkRefs(
      'sess-bad-hash',
      'guardian_export',
      refs,
      mockDownloadOk(),
    );

    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('hash_mismatch');
    expect(result.stoppedAt).toBe(1);
    expect(result.corruptIndexes).toContain(1);
    expect(result.validChunks).toBe(1);
  });
});

// --- Download failed ----------------------------------------------------

describe('exportFromChunkRefs — download failure', () => {
  it('stops at the first throwing downloadFn call with stopReason=download_failed', async () => {
    mockDigestConstant(0xab);
    const refs = refsFor(3);

    const downloadFn = vi.fn(async (idx: number) => {
      if (idx === 1) {
        throw new Error('synthetic network failure');
      }
      return { bytes: new Uint8Array([0x01, 0x02, 0x03, 0x04]), headerHash: '' };
    });

    const result = await exportFromChunkRefs(
      'sess-net-fail',
      'guardian_export',
      refs,
      downloadFn,
    );

    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('download_failed');
    expect(result.stoppedAt).toBe(1);
    expect(result.corruptIndexes).toContain(1);
    expect(result.validChunks).toBe(1); // chunk 0 succeeded; chunk 2 never attempted
    expect(downloadFn).toHaveBeenCalledTimes(2); // 0 and 1; 2 is skipped after the cut
  });
});

// --- No valid chunks (all bail on chunk 0) ------------------------------

describe('exportFromChunkRefs — zero valid chunks', () => {
  it('returns status=failed and writes no file when chunk 0 fails verification', async () => {
    // Digest returns 0xab, chunk declares 0xcd — mismatch on chunk 0.
    mockDigestConstant(0xab);
    const refs: ChunkRef[] = [
      { chunk_index: 0, hash: hashOfByte(0xcd), size: 16 },
    ];

    const result = await exportFromChunkRefs(
      'sess-no-valid',
      'guardian_export',
      refs,
      mockDownloadOk(),
    );

    expect(result.status).toBe('failed');
    expect(result.validChunks).toBe(0);
    expect(result.filePath).toBeNull();
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });
});

// --- Auth failed --------------------------------------------------------

describe('exportFromChunkRefs — auth_failed', () => {
  it('bails with stopReason=auth_failed without marking the chunk corrupt', async () => {
    mockDigestConstant(0xab);
    const refs = refsFor(3);

    // Chunk 0 and 2 succeed; chunk 1 throws AUTH_FAILED (mirrors what
    // the real `downloadChunk` raises after its single auth retry
    // exhausts on a transient session loss mid-export). The helper
    // must:
    //   - NOT push idx=1 into corruptIndexes
    //   - NOT emit "EXPORT CHUNK CORRUPT"
    //   - return status='failed' with stopReason='auth_failed'
    //   - NOT write a file (corrupt evidence claim is the exact failure
    //     the user reported; partial-with-auth-loss is misleading)
    //   - preserve `validChunks=1` honestly so logs/diagnostics keep
    //     the truth without lying about what got through
    const downloadFn = vi.fn(async (idx: number) => {
      if (idx === 1) {
        throw new ApiError(
          401,
          'AUTH_FAILED',
          'Authentication unavailable; please retry',
          null,
        );
      }
      return { bytes: new Uint8Array([0x01, 0x02, 0x03, 0x04]), headerHash: '' };
    });

    const result = await exportFromChunkRefs(
      'sess-auth-loss',
      'guardian_export',
      refs,
      downloadFn,
    );

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('auth_failed');
    expect(result.stoppedAt).toBe(1);
    expect(result.corruptIndexes).toEqual([]); // critical: no corrupt mark
    expect(result.validChunks).toBe(1); // chunk 0 made it through honestly
    expect(result.filePath).toBeNull(); // no file written for auth_failed
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
    // Verify the loop did NOT keep attempting chunk 2 after the auth bail
    expect(downloadFn).toHaveBeenCalledTimes(2); // 0 (ok) and 1 (auth)
  });

  it('returns auth_failed cleanly even when chunk 0 is the one that fails', async () => {
    mockDigestConstant(0xab);
    const refs = refsFor(1);

    const downloadFn = vi.fn(async () => {
      throw new ApiError(
        401,
        'AUTH_FAILED',
        'Authentication unavailable; please retry',
        null,
      );
    });

    const result = await exportFromChunkRefs(
      'sess-auth-on-first',
      'guardian_export',
      refs,
      downloadFn,
    );

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('auth_failed');
    expect(result.corruptIndexes).toEqual([]);
    expect(result.validChunks).toBe(0);
    expect(result.filePath).toBeNull();
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });
});

// --- listSessionChunks auth retry --------------------------------------

describe('listSessionChunks — auth retry', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('retries once when apiFetch raises NO_TOKEN, then throws AUTH_FAILED', async () => {
    // Simulate the production failure: `apiFetch` raises
    // ApiError(401, 'NO_TOKEN') on every call because supabase-js's
    // inline refresh is failing. `listSessionChunks` must catch it,
    // pause briefly, retry ONE more time, and on the second failure
    // re-throw with the distinct AUTH_FAILED code so the export
    // wrapper can route to stopReason='auth_failed' rather than the
    // generic list_failed verdict.
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError(401, 'NO_TOKEN', 'No access token in store', null),
    );

    await expect(listSessionChunks('sess-auth')).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_FAILED',
    });

    // Two attempts inside listSessionChunks's loop. Bump deliberately
    // if the retry budget changes — this is the pinned contract.
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry non-auth failures (network / 5xx / 404)', async () => {
    // A 5xx from the backend is propagated immediately on the first
    // attempt: there is no benefit to retrying inside listSessionChunks
    // and doing so would hide real backend incidents behind extra
    // latency. The retry budget is strictly for transient auth blips.
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError(500, 'INTERNAL', 'Server error', null),
    );

    await expect(listSessionChunks('sess-5xx')).rejects.toMatchObject({
      status: 500,
      code: 'INTERNAL',
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
