/**
 * Evidence export client.
 *
 * Downloads every `uploaded` chunk of a session from the backend, verifies
 * sha256 locally, concatenates the decoded bytes in chunk_index order, and
 * writes the result to `documentDirectory/guardian_export_{sessionId}.m4a`.
 *
 * Why this module is separate from `destinations.ts`:
 *   - Export is read-only. It never touches the upload/queue/recovery
 *     pipeline and must not share state with it.
 *   - `apiFetch` is JSON-only; the per-chunk download endpoint speaks
 *     `application/octet-stream`, so the download path uses raw `fetch`
 *     (same pattern as `uploadChunkBytes`).
 *
 * Partial export:
 *   Any chunk that fails to download OR fails hash verification is SKIPPED
 *   and recorded in the result. We still produce a file with the good
 *   chunks concatenated in order. The UI marks the result as "parcial" and
 *   lists the bad indexes so the user can decide what to do.
 *
 *   The .m4a file produced by a partial export will almost always be
 *   UNPLAYABLE: Android's MediaRecorder writes the MP4 `moov` atom at the
 *   very end of the file, so missing the last chunk removes it. We still
 *   produce the output on purpose — it is a forensic dump, not a media
 *   file. The user is told it's partial; recoverable playback is a
 *   separate future task (see TODO(export-headerless-partial)).
 *
 * Strict ownership is enforced server-side (GET
 * /sessions/:id/chunks/:index/download returns 404 SESSION_NOT_FOUND if
 * the session does not belong to the caller). The client does NOT need
 * to add an extra ownership check — the backend is the authority.
 */

import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';

import { env } from '@/config/env';
import { getFreshAccessToken } from '@/auth/store';
import { apiFetch, ApiError } from './client';

/**
 * DEBUG-only: simulate a corrupted download for the chunk whose
 * `chunk_index` equals this value. Set to a negative number (e.g. -1)
 * to disable. The corruption flips the first byte of the downloaded
 * payload AFTER `downloadChunk` returns and BEFORE `verifyHash` runs,
 * so the partial-export path (corruptIndexes / status='partial') is
 * exercised against real bytes from Drive.
 *
 * MUST be set to -1 (or removed) before any non-debug build. Backend,
 * upload, queue, recovery and Drive are NOT affected by this constant —
 * it lives entirely inside `exportSession`.
 */
const DEBUG_CORRUPT_EXPORT_CHUNK_INDEX = -1;

export interface ChunkMeta {
  chunk_index: number;
  hash: string;
  size: number;
  status: 'pending' | 'uploaded' | 'failed';
  remote_reference: string | null;
}

interface ListChunksResponse {
  chunks: ChunkMeta[];
}

export type ExportStatus = 'complete' | 'partial' | 'failed';

export interface ExportProgress {
  /** Total chunks the recording is expected to have. */
  total: number;
  /** Chunks processed so far (OK or skipped, whichever finished). */
  done: number;
  /** The chunk_index currently being fetched (-1 when finished). */
  currentIndex: number;
}

export interface ExportResult {
  status: ExportStatus;
  /** Absolute path to the written .m4a, or null when nothing was written. */
  filePath: string | null;
  /** last(uploaded).chunk_index + 1 — the expected length of the recording. */
  totalChunks: number;
  /** Number of chunks that were both downloaded AND hash-verified. */
  validChunks: number;
  /** chunk_index values that were not `uploaded` server-side at all. */
  missingIndexes: number[];
  /** chunk_index values that failed download or sha256 verification. */
  corruptIndexes: number[];
}

function bytesDigestToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Encode a Uint8Array to base64 for FileSystem.writeAsStringAsync with
 * `encoding: 'base64'`.
 *
 * We can't call `String.fromCharCode(...bytes)` directly — for a multi-MB
 * buffer that blows the JS call stack. We chunk the spread in 32 KiB
 * slices (well below the limit on both Hermes and V8).
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + stride)),
    );
  }
  return btoa(binary);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** GET /sessions/:id/chunks — metadata only. */
export async function listSessionChunks(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ChunkMeta[]> {
  const { chunks } = await apiFetch<ListChunksResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/chunks`,
    { method: 'GET', ...(signal ? { signal } : {}) },
  );
  return chunks;
}

/**
 * GET /sessions/:id/chunks/:index/download — raw bytes.
 *
 * Returns the decoded bytes and the hash the backend advertised in the
 * X-Chunk-Hash header (useful for debug logging; the caller still
 * verifies against the per-chunk metadata hash from the chunks listing,
 * which is the source of truth).
 */
export async function downloadChunk(
  sessionId: string,
  chunkIndex: number,
  timeoutMs = 30_000,
): Promise<{ bytes: Uint8Array; headerHash: string }> {
  const token = await getFreshAccessToken();
  if (!token) {
    throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(
      `${env.apiUrl}/sessions/${encodeURIComponent(sessionId)}/chunks/${chunkIndex}/download`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
  } catch (e) {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      e instanceof Error ? e.message : 'Network request failed',
      null,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let parsed: unknown = null;
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      parsed = await response.json().catch(() => null);
    }
    const errBody = (parsed as { error?: { code?: string; message?: string } }) ?? {};
    throw new ApiError(
      response.status,
      errBody.error?.code,
      errBody.error?.message ?? `HTTP ${response.status}`,
      parsed,
    );
  }

  const headerHash =
    response.headers.get('x-chunk-hash') ??
    response.headers.get('X-Chunk-Hash') ??
    '';
  const ab = await response.arrayBuffer();
  return { bytes: new Uint8Array(ab), headerHash };
}

/** sha256(bytes) === expected, as lowercase hex. */
export async function verifyHash(
  bytes: Uint8Array,
  expected: string,
): Promise<boolean> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    bytes,
  );
  return bytesDigestToHex(digest) === expected;
}

/**
 * Orchestrator. Never throws — any failure is folded into the result.
 *
 * The write-to-disk step happens ONCE at the end with the concatenated
 * bytes, not per-chunk. Per-chunk append would require either the
 * modern `FileSystem.File` API (different import) or a read-modify-write
 * loop, both of which are out of scope for the MVP.
 *
 * Memory: accumulates ~O(N) bytes for the session plus ~4N/3 for the
 * terminal base64 encoding. For MVP-size sessions (a few MB) this is
 * fine; large sessions are covered by TODO(export-large).
 */
export async function exportSession(
  sessionId: string,
  onProgress?: (p: ExportProgress) => void,
): Promise<ExportResult> {
  console.log('EXPORT START', { sessionId });

  let chunks: ChunkMeta[];
  try {
    chunks = await listSessionChunks(sessionId);
  } catch (err) {
    console.log('EXPORT ERROR', {
      sessionId,
      phase: 'list',
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks: 0,
      validChunks: 0,
      missingIndexes: [],
      corruptIndexes: [],
    };
  }

  const uploaded = chunks
    .filter((c) => c.status === 'uploaded' && !!c.remote_reference)
    .sort((a, b) => a.chunk_index - b.chunk_index);

  if (uploaded.length === 0) {
    console.log('EXPORT ERROR', {
      sessionId,
      phase: 'filter',
      reason: 'no_uploaded_chunks',
      total: chunks.length,
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks: chunks.length,
      validChunks: 0,
      missingIndexes: chunks.map((c) => c.chunk_index),
      corruptIndexes: [],
    };
  }

  const lastIndex = uploaded[uploaded.length - 1]!.chunk_index;
  const totalChunks = lastIndex + 1;

  const presentIndexes = new Set(uploaded.map((c) => c.chunk_index));
  const missingIndexes: number[] = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!presentIndexes.has(i)) missingIndexes.push(i);
  }

  const docDir = FileSystem.documentDirectory;
  if (!docDir) {
    console.log('EXPORT ERROR', {
      sessionId,
      phase: 'filesystem',
      reason: 'no_document_directory',
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks,
      validChunks: 0,
      missingIndexes,
      corruptIndexes: [],
    };
  }

  // Extension is decided post-concat by sniffing the reconstructed bytes:
  //   - 'ftyp' at offset 4 → MP4/M4A container (legacy HIGH_QUALITY)
  //   - 0xFFF ADTS sync + valid layer bits → raw AAC frames (new flow)
  //   - neither → '.bin' forensic dump
  // `.m4a` here is a placeholder only — the early-return paths below set
  // filePath: null and never read this value. Reassigned after concat.
  //
  // TODO(recording-format): guardar formato/extensión por sesión en el
  // backend para no depender de sniff binario al exportar.
  let filePath = `${docDir}guardian_export_${sessionId}.m4a`;

  const corruptIndexes: number[] = [];
  const accumulated: Uint8Array[] = [];
  let validChunks = 0;

  for (let i = 0; i < uploaded.length; i++) {
    const meta = uploaded[i]!;
    onProgress?.({
      total: totalChunks,
      done: i,
      currentIndex: meta.chunk_index,
    });

    try {
      const { bytes, headerHash } = await downloadChunk(
        sessionId,
        meta.chunk_index,
      );

      // DEBUG-only corruption — see DEBUG_CORRUPT_EXPORT_CHUNK_INDEX.
      // Flips byte 0 so verifyHash below trips and the chunk lands in
      // corruptIndexes via the existing partial-export path. No side
      // effects outside this loop iteration; a chunk we did NOT corrupt
      // here flows through unchanged. Disabled when the constant is < 0.
      if (
        DEBUG_CORRUPT_EXPORT_CHUNK_INDEX >= 0 &&
        meta.chunk_index === DEBUG_CORRUPT_EXPORT_CHUNK_INDEX &&
        bytes.length > 0
      ) {
        bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
        console.log('GC_EXPORT_DEBUG_CORRUPTED_CHUNK', {
          sessionId,
          chunkIndex: meta.chunk_index,
        });
      }

      const ok = await verifyHash(bytes, meta.hash);

      if (!ok) {
        console.log('EXPORT CHUNK CORRUPT', {
          sessionId,
          chunkIndex: meta.chunk_index,
          expected: meta.hash,
          headerHash,
          reason: 'hash_mismatch',
        });
        console.log('GC_EXPORT_HASH_MISMATCH', {
          sessionId,
          chunkIndex: meta.chunk_index,
          expected: meta.hash,
          headerHash,
          size: bytes.length,
        });
        corruptIndexes.push(meta.chunk_index);
        continue;
      }

      accumulated.push(bytes);
      validChunks += 1;

      console.log('EXPORT CHUNK DOWNLOADED', {
        sessionId,
        chunkIndex: meta.chunk_index,
        size: bytes.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('EXPORT CHUNK CORRUPT', {
        sessionId,
        chunkIndex: meta.chunk_index,
        reason: 'download_failed',
        err: msg,
      });
      corruptIndexes.push(meta.chunk_index);
    }
  }

  onProgress?.({ total: totalChunks, done: uploaded.length, currentIndex: -1 });

  if (validChunks === 0) {
    console.log('EXPORT ERROR', {
      sessionId,
      phase: 'concat',
      reason: 'no_valid_chunks',
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks,
      validChunks: 0,
      missingIndexes,
      corruptIndexes,
    };
  }

  try {
    // TODO(export-large): writing the whole file in one base64 blob holds
    // the recording fully in memory (bytes + base64). For multi-hundred-MB
    // sessions this will OOM. Move to an incremental append (e.g. the
    // modern `FileSystem.File.write` stream API) when sessions get bigger.
    const fullBytes = concatBytes(accumulated);

    // Decide the output extension from the first bytes of the concat.
    // MP4/M4A: 'ftyp' FourCC lives at offset 4 (box-type of the first
    //          MP4 box; strict location, not just "contains ftyp").
    // AAC ADTS: every frame starts with sync word 0xFFF in bits 0-11 of
    //          the first two bytes; bits 13-14 (layer) must be 0. The
    //          mask `(byte[1] & 0xF6) === 0xF0` checks both sync low
    //          nibble and the two zero layer bits.
    // Neither → '.bin' forensic dump, keeps the concat visible on disk.
    const hasFtyp =
      fullBytes.length >= 8 &&
      fullBytes[4] === 0x66 &&
      fullBytes[5] === 0x74 &&
      fullBytes[6] === 0x79 &&
      fullBytes[7] === 0x70;
    const hasAacSync =
      fullBytes.length >= 2 &&
      fullBytes[0] === 0xff &&
      ((fullBytes[1] ?? 0) & 0xf6) === 0xf0;
    const extension = hasFtyp ? '.m4a' : hasAacSync ? '.aac' : '.bin';
    filePath = `${docDir}guardian_export_${sessionId}${extension}`;
    console.log('EXPORT EXT SNIFF', {
      sessionId,
      extension,
      hasFtyp,
      hasAacSync,
    });

    const fullBase64 = bytesToBase64(fullBytes);
    await FileSystem.writeAsStringAsync(filePath, fullBase64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (err) {
    console.log('EXPORT ERROR', {
      sessionId,
      phase: 'write_final',
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks,
      validChunks,
      missingIndexes,
      corruptIndexes,
    };
  }

  const isComplete =
    missingIndexes.length === 0 && corruptIndexes.length === 0;
  const status: ExportStatus = isComplete ? 'complete' : 'partial';

  // TODO(export-headerless-partial): a partial export that is missing the
  // last chunk loses the MP4 `moov` atom (MediaRecorder writes it at the
  // tail), so the resulting .m4a is generally unplayable. We still write
  // the concatenated bytes as a forensic dump and surface "parcial" in
  // the UI. A future pass could reconstruct or patch the moov atom.

  console.log(isComplete ? 'EXPORT COMPLETE' : 'EXPORT PARTIAL', {
    sessionId,
    filePath,
    totalChunks,
    validChunks,
    missingIndexes,
    corruptIndexes,
  });

  console.log('GC_EXPORT_RESULT', {
    sessionId,
    status,
    filePath,
    totalChunks,
    validChunks,
    missingCount: missingIndexes.length,
    corruptCount: corruptIndexes.length,
    missingIndexes,
    corruptIndexes,
  });

  return {
    status,
    filePath,
    totalChunks,
    validChunks,
    missingIndexes,
    corruptIndexes,
  };
}

// TODO(export-history): the entry point to reach this flow is only the
// direct route app/session/[id].tsx. A proper "Historial" screen listing
// the user's past sessions and linking into export lives outside the
// current scope and will be added in a later brick.
