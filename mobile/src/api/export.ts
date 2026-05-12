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

import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';

import { env } from '@/config/env';
import { getFreshAccessToken } from '@/auth/store';
import { apiFetch, ApiError } from './client';
import { type DestinationType } from './destinations';
import { type SessionMode } from './history';
import { log, error } from '@/utils/log';

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

  // --- Pasada A diagnostics (additive, optional). ---
  //
  // These three fields exist solely to let the caller (the session
  // detail screen) classify WHY an export landed in a partial state.
  // They never change export behaviour — `status`, `filePath`,
  // `validChunks`, `missingIndexes`, `corruptIndexes` remain the
  // authoritative surface. Treat them as logs that happen to ride in
  // the same envelope.
  //
  // All three are optional so callers that construct an `ExportResult`
  // literal for an early-failure branch (e.g. local-only fallback in
  // session/[id].tsx) don't have to be modified.

  /**
   * Container extension decided by the post-concat byte sniff:
   *   '.aac' — AAC ADTS sync word present (raw frames; self-framing,
   *            a contiguous prefix is decodable on its own).
   *   '.m4a' — MP4 'ftyp' box at offset 4 (legacy HIGH_QUALITY audio;
   *            the trailing moov atom is required for playback).
   *   '.mp4' — caller forced video; same MP4 caveat applies.
   *   '.bin' — neither sniff matched; forensic dump.
   *   null   — the concat loop never produced bytes (early-return
   *            failure before the sniff ran).
   *
   * Diagnostic only. The UI's "Reproducible" verdict is computed
   * elsewhere from `status` + this field + `expectedLocalChunks`.
   */
  extension?: '.aac' | '.m4a' | '.mp4' | '.bin' | null;
  /**
   * chunk_index where the concat loop stopped:
   *   -1   — the loop ran to `totalChunks` without bailing (every
   *           expected index was either fetched + verified or the
   *           result is fully consistent with `totalChunks=0`);
   *   N>=0 — the loop bailed at index N for the reason in
   *           `stopReason`; everything in [0, N) was concatenated;
   *   null — the early-return paths that never entered the loop
   *           (list error, no uploaded chunks, no document dir).
   */
  stoppedAt?: number | null;
  /**
   * Why the concat loop stopped, in the same situations as
   * `stoppedAt`:
   *   'missing'         — `meta` for that index was absent from the
   *                        backend listing (chunk not yet uploaded or
   *                        marked failed server-side);
   *   'hash_mismatch'   — bytes downloaded but sha256 disagreed with
   *                        the chunks row;
   *   'download_failed' — network / 4xx / 5xx prevented retrieval;
   *   null              — loop completed without bailing OR an
   *                        early-return path didn't run the loop.
   *
   * `missingIndexes` / `corruptIndexes` are still authoritative for
   * UI rendering and totals; `stopReason` only names the FIRST gap so
   * downstream code can categorise the export cleanly.
   */
  stopReason?: 'missing' | 'hash_mismatch' | 'download_failed' | null;
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
 * Subset of GET /sessions/:id we actually consume on the client today.
 *
 * Backend returns the full session row (status, mode, created_at,
 * completed_at, chunk_count, destination_type). We only declare the
 * fields the export screen reads — `destination_type` is the one that
 * matters here, because the per-chunk download endpoint is hardcoded
 * to Drive and a NAS session would otherwise hit "Drive file not
 * found" for every chunk and fold to `no_valid_chunks`.
 *
 * `destination_type` may legitimately be `null` for legacy sessions
 * that pre-date the per-session pinning column. The export screen
 * treats `null` as "unknown / try the existing Drive flow", same as
 * the pre-pinning behaviour.
 */
export interface SessionDetail {
  session_id: string;
  destination_type: DestinationType | null;
  mode?: SessionMode;
  status?: string;
  chunk_count?: number;
}

/**
 * GET /sessions/:id — session metadata, including `destination_type`.
 *
 * Read-only side-channel for the export screen so it can decide WHICH
 * download path is viable BEFORE iterating chunks. Does NOT touch the
 * upload pipeline, the queue, or the chunk download endpoint.
 *
 * Throws ApiError on network / non-2xx — callers should fold the
 * failure to "unknown destination" so a transient network blip does
 * not gate the existing Drive export path.
 */
export async function getSessionDetail(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(
    `/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'GET', ...(signal ? { signal } : {}) },
  );
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
  const path = `/sessions/${encodeURIComponent(sessionId)}/chunks/${chunkIndex}/download`;
  const token = await getFreshAccessToken();
  if (!token) {
    log('AUTH MISSING', { path });
    throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${env.apiUrl}${path}`;
  log('API CALL', { method: 'GET', url, authed: true });
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
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
  /**
   * Optional recording mode. When 'video', the output extension is forced
   * to '.mp4' regardless of what the byte-sniff would say (an MP4 video
   * starts with `ftyp`, which the sniff classifies as `.m4a` — wrong for
   * video). When 'audio' or undefined the existing sniff runs unchanged
   * (audio sessions are AAC ADTS or legacy MP4-audio; both are correctly
   * classified by `hasAacSync` / `hasFtyp`).
   *
   * Optional so existing audio-only callers do not need to change. The
   * caller (session detail screen) reads the mode from the local history
   * index, which records `mode` per session at creation time.
   */
  mode?: SessionMode,
): Promise<ExportResult> {
  log('EXPORT START', { sessionId, mode });

  let chunks: ChunkMeta[];
  try {
    chunks = await listSessionChunks(sessionId);
  } catch (err) {
    error('EXPORT ERROR', {
      sessionId,
      phase: 'list',
      err: err instanceof Error ? err.message : String(err),
    });
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'list_failed',
      status: 'failed',
      totalChunks: 0,
      validChunks: 0,
      missingCount: 0,
      corruptCount: 0,
      stoppedAt: null,
      stopReason: null,
      extension: null,
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks: 0,
      validChunks: 0,
      missingIndexes: [],
      corruptIndexes: [],
      extension: null,
      stoppedAt: null,
      stopReason: null,
    };
  }

  const uploaded = chunks
    .filter((c) => c.status === 'uploaded' && !!c.remote_reference)
    .sort((a, b) => a.chunk_index - b.chunk_index);

  if (uploaded.length === 0) {
    error('EXPORT ERROR', {
      sessionId,
      phase: 'filter',
      reason: 'no_uploaded_chunks',
      total: chunks.length,
    });
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'no_uploaded_chunks',
      status: 'failed',
      totalChunks: chunks.length,
      validChunks: 0,
      missingCount: chunks.length,
      corruptCount: 0,
      stoppedAt: null,
      stopReason: null,
      extension: null,
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks: chunks.length,
      validChunks: 0,
      missingIndexes: chunks.map((c) => c.chunk_index),
      corruptIndexes: [],
      extension: null,
      stoppedAt: null,
      stopReason: null,
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
    error('EXPORT ERROR', {
      sessionId,
      phase: 'filesystem',
      reason: 'no_document_directory',
    });
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'no_document_directory',
      status: 'failed',
      totalChunks,
      validChunks: 0,
      missingCount: missingIndexes.length,
      corruptCount: 0,
      stoppedAt: null,
      stopReason: null,
      extension: null,
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks,
      validChunks: 0,
      missingIndexes,
      corruptIndexes: [],
      extension: null,
      stoppedAt: null,
      stopReason: null,
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
  // The chunk_index where we stopped concatenating (first gap, or
  // -1 if we made it all the way through). Surfaced in logs so an
  // operator can see exactly where the cut happened.
  let stoppedAt = -1;
  // Pasada A diagnostics — mirror the in-loop bail so the caller can
  // classify why the export ended up partial. Populated in the same
  // three break branches that populate `stoppedAt`. Stays `null` if
  // the loop completes without bailing.
  let stopReason: 'missing' | 'hash_mismatch' | 'download_failed' | null =
    null;
  // Mirror of the container extension picked by the post-concat
  // sniff. Lives at function scope (instead of only inside the write
  // block) so every return path — success, partial, write_final
  // failure — can include it in the diagnostic payload. Stays `null`
  // on the early-return paths that never reach the sniff.
  let sniffedExtension: '.aac' | '.m4a' | '.mp4' | '.bin' | null = null;

  // Survival rule: the recoverable evidence is the LONGEST CONTIGUOUS
  // PREFIX of valid chunks starting at chunk_index 0. A "hole" is any
  // index that is either:
  //   (a) missing from the backend listing (not yet 'uploaded'), or
  //   (b) downloaded but failed sha256 verification, or
  //   (c) failed to download (network / 4xx / 5xx).
  // At the first hole we STOP the loop. We do NOT continue downloading
  // chunks past the gap — those bytes would only contribute to a sparse
  // file that no decoder can play, contradicting "subir evidencia >
  // archivo perfecto". The skipped indexes remain visible in the result
  // (`missingIndexes` was computed up-front; corrupt-at-cut goes into
  // `corruptIndexes` so the integrity report stays honest).
  const byIndex = new Map(uploaded.map((c) => [c.chunk_index, c]));
  for (let idx = 0; idx < totalChunks; idx++) {
    const meta = byIndex.get(idx);

    // (a) Missing from the listing — stop. The exact set of missing
    // indexes was already pre-populated in `missingIndexes` above;
    // this is just the boundary observation.
    if (!meta) {
      stoppedAt = idx;
      stopReason = 'missing';
      log('EXPORT STOPPED AT GAP', {
        sessionId,
        atIndex: idx,
        reason: 'missing',
      });
      break;
    }

    onProgress?.({ total: totalChunks, done: idx, currentIndex: idx });

    try {
      const { bytes, headerHash } = await downloadChunk(sessionId, idx);

      // DEBUG-only corruption — see DEBUG_CORRUPT_EXPORT_CHUNK_INDEX.
      // Flips byte 0 so verifyHash below trips and the chunk is treated
      // as the cut point. Disabled when the constant is < 0.
      if (
        DEBUG_CORRUPT_EXPORT_CHUNK_INDEX >= 0 &&
        idx === DEBUG_CORRUPT_EXPORT_CHUNK_INDEX &&
        bytes.length > 0
      ) {
        bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
        log('GC_EXPORT_DEBUG_CORRUPTED_CHUNK', {
          sessionId,
          chunkIndex: idx,
        });
      }

      const ok = await verifyHash(bytes, meta.hash);

      // (b) Hash mismatch — record this index as corrupt and stop.
      if (!ok) {
        error('EXPORT CHUNK CORRUPT', {
          sessionId,
          chunkIndex: idx,
          expected: meta.hash,
          headerHash,
          reason: 'hash_mismatch',
        });
        error('GC_EXPORT_HASH_MISMATCH', {
          sessionId,
          chunkIndex: idx,
          expected: meta.hash,
          headerHash,
          size: bytes.length,
        });
        corruptIndexes.push(idx);
        stoppedAt = idx;
        stopReason = 'hash_mismatch';
        log('EXPORT STOPPED AT GAP', {
          sessionId,
          atIndex: idx,
          reason: 'hash_mismatch',
        });
        break;
      }

      accumulated.push(bytes);
      validChunks += 1;

      log('EXPORT CHUNK DOWNLOADED', {
        sessionId,
        chunkIndex: idx,
        size: bytes.length,
      });
    } catch (err) {
      // (c) Download failure — record and stop.
      const msg = err instanceof Error ? err.message : String(err);
      error('EXPORT CHUNK CORRUPT', {
        sessionId,
        chunkIndex: idx,
        reason: 'download_failed',
        err: msg,
      });
      corruptIndexes.push(idx);
      stoppedAt = idx;
      stopReason = 'download_failed';
      log('EXPORT STOPPED AT GAP', {
        sessionId,
        atIndex: idx,
        reason: 'download_failed',
      });
      break;
    }
  }

  onProgress?.({ total: totalChunks, done: validChunks, currentIndex: -1 });

  log('EXPORT PREFIX SUMMARY', {
    sessionId,
    totalChunks,
    validChunks,
    stoppedAt,
    contiguous: validChunks === totalChunks,
  });

  if (validChunks === 0) {
    error('EXPORT ERROR', {
      sessionId,
      phase: 'concat',
      reason: 'no_valid_chunks',
    });
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'no_valid_chunks',
      status: 'failed',
      totalChunks,
      validChunks: 0,
      missingCount: missingIndexes.length,
      corruptCount: corruptIndexes.length,
      stoppedAt,
      stopReason,
      extension: sniffedExtension,
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks,
      validChunks: 0,
      missingIndexes,
      corruptIndexes,
      extension: sniffedExtension,
      stoppedAt,
      stopReason,
    };
  }

  try {
    // TODO(export-large): writing the whole file in one base64 blob holds
    // the recording fully in memory (bytes + base64). For multi-hundred-MB
    // sessions this will OOM. Move to an incremental append (e.g. the
    // modern `FileSystem.File.write` stream API) when sessions get bigger.
    const fullBytes = concatBytes(accumulated);

    // Decide the output extension. Two paths:
    //
    // (1) Video override: when the caller has told us this is a video
    //     session, force '.mp4'. The byte-sniff cannot distinguish video
    //     MP4 from audio M4A (both start with `ftyp`) and would otherwise
    //     misclassify video as `.m4a`. Mode is the authoritative signal
    //     for the container format; the sniff is only a fallback for when
    //     the caller does not supply it.
    //
    // (2) Sniff fallback (audio path, unchanged from pre-video baseline):
    //     - MP4/M4A: 'ftyp' FourCC at offset 4 (strict box-type position).
    //     - AAC ADTS: sync word 0xFFF in bits 0-11 of the first two bytes;
    //                 the mask `(byte[1] & 0xF6) === 0xF0` also asserts
    //                 the two zero layer bits.
    //     - Neither → '.bin' forensic dump, keeps the concat visible.
    let extension: string;
    let hasFtyp = false;
    let hasAacSync = false;
    if (mode === 'video') {
      extension = '.mp4';
    } else {
      hasFtyp =
        fullBytes.length >= 8 &&
        fullBytes[4] === 0x66 &&
        fullBytes[5] === 0x74 &&
        fullBytes[6] === 0x79 &&
        fullBytes[7] === 0x70;
      hasAacSync =
        fullBytes.length >= 2 &&
        fullBytes[0] === 0xff &&
        ((fullBytes[1] ?? 0) & 0xf6) === 0xf0;
      extension = hasFtyp ? '.m4a' : hasAacSync ? '.aac' : '.bin';
    }
    filePath = `${docDir}guardian_export_${sessionId}${extension}`;
    // Mirror to the function-scope variable so every return path
    // (including the write_final catch below) can include it in the
    // diagnostic payload. The narrowing is exhaustive — the assigns
    // above only ever produce one of these four literals.
    sniffedExtension = extension as '.aac' | '.m4a' | '.mp4' | '.bin';
    log('EXPORT EXT SNIFF', {
      sessionId,
      extension,
      mode,
      hasFtyp,
      hasAacSync,
    });

    const fullBase64 = bytesToBase64(fullBytes);
    await FileSystem.writeAsStringAsync(filePath, fullBase64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (err) {
    error('EXPORT ERROR', {
      sessionId,
      phase: 'write_final',
      err: err instanceof Error ? err.message : String(err),
    });
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'write_final_failed',
      status: 'failed',
      totalChunks,
      validChunks,
      missingCount: missingIndexes.length,
      corruptCount: corruptIndexes.length,
      stoppedAt,
      stopReason,
      extension: sniffedExtension,
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks,
      validChunks,
      missingIndexes,
      corruptIndexes,
      extension: sniffedExtension,
      stoppedAt,
      stopReason,
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

  log(isComplete ? 'EXPORT COMPLETE' : 'EXPORT PARTIAL', {
    sessionId,
    filePath,
    totalChunks,
    validChunks,
    missingIndexes,
    corruptIndexes,
  });

  log('GC_EXPORT_RESULT', {
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

  // Pasada A diagnostics. Separate log key from the legacy
  // `GC_EXPORT_RESULT` so a grep can isolate the structured-cause
  // payload without having to filter the older format. The downstream
  // verdict log (`GC_EXPORT_DIAG_VERDICT`) lives in the session detail
  // screen because it needs `expectedLocalChunks` (queue-derived) to
  // discriminate "pending upload" from "true gap".
  log('GC_EXPORT_DIAG_RAW', {
    sessionId,
    phase: status === 'complete' ? 'complete' : 'partial',
    status,
    totalChunks,
    validChunks,
    missingCount: missingIndexes.length,
    corruptCount: corruptIndexes.length,
    stoppedAt,
    stopReason,
    extension: sniffedExtension,
  });

  return {
    status,
    filePath,
    totalChunks,
    validChunks,
    missingIndexes,
    corruptIndexes,
    extension: sniffedExtension,
    stoppedAt,
    stopReason,
  };
}

// TODO(export-history): the entry point to reach this flow is only the
// direct route app/session/[id].tsx. A proper "Historial" screen listing
// the user's past sessions and linking into export lives outside the
// current scope and will be added in a later brick.
