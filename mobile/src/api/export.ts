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
import { supabase } from '@/auth/supabase';
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
   *   'auth_failed'     — authentication unavailable mid-export
   *                        (getFreshAccessToken returned null twice, or
   *                        the server returned 401 twice in a row).
   *                        Crucially distinct from `download_failed`:
   *                        the chunk's BYTES were never even attempted
   *                        against the server, so there is nothing to
   *                        call "corrupt". The UI surfaces this as a
   *                        retry prompt instead of an integrity damaged
   *                        verdict;
   *   null              — loop completed without bailing OR an
   *                        early-return path didn't run the loop.
   *
   * `missingIndexes` / `corruptIndexes` are still authoritative for
   * UI rendering and totals; `stopReason` only names the FIRST gap so
   * downstream code can categorise the export cleanly. Note that an
   * `auth_failed` stop NEVER adds to `corruptIndexes` — that array is
   * reserved for byte-level integrity problems only.
   */
  stopReason?:
    | 'missing'
    | 'hash_mismatch'
    | 'download_failed'
    | 'auth_failed'
    | 'cancelled'
    | null;
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

/**
 * GET /sessions/:id/chunks — metadata only.
 *
 * Auth-retry contract (mirrors `downloadChunk`):
 *   - If `apiFetch` throws `ApiError(401, 'NO_TOKEN', ...)` (the gate
 *     `apiFetch` raises when `getFreshAccessToken` returned null), we
 *     pause 500 ms and retry ONCE. Same pattern for an actual server
 *     401 (e.g. the access token expired between resolution and
 *     receipt). The pause covers the typical transient: supabase-js's
 *     inline refresh hit a momentary network blip mid-export.
 *   - If the second attempt is also auth-failing, we throw
 *     `ApiError(401, 'AUTH_FAILED', ...)`. The export wrapper above
 *     detects that distinct code and surfaces `stopReason: 'auth_failed'`
 *     so the UI renders the "Sesión caducada / Vuelve a intentarlo"
 *     block instead of the generic `list_failed` verdict.
 *   - Any other failure (5xx, 404 SESSION_NOT_FOUND, network throw,
 *     etc.) propagates unchanged — behaviour-identical to the
 *     pre-retry version.
 *
 * The retry is single-shot by design; beyond two attempts a session
 * is genuinely lost and the user needs to re-authenticate.
 */
export async function listSessionChunks(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ChunkMeta[]> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/chunks`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { chunks } = await apiFetch<ListChunksResponse>(path, {
        method: 'GET',
        ...(signal ? { signal } : {}),
      });
      return chunks;
    } catch (err) {
      const isAuth =
        err instanceof ApiError &&
        (err.status === 401 || err.code === 'NO_TOKEN');
      if (!isAuth) throw err;
      if (attempt === 2) {
        throw new ApiError(
          401,
          'AUTH_FAILED',
          'Authentication unavailable; please retry',
          null,
        );
      }
      log('AUTH RETRY', { path, attempt });
      await sleep(500);
    }
  }

  // Unreachable — the loop returns or throws on every path. Defensive
  // throw kept so TypeScript can prove the function always exits.
  throw new ApiError(
    401,
    'AUTH_FAILED',
    'Authentication unavailable; please retry',
    null,
  );
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
 * Wait helper used by `downloadChunk`'s single auth retry. Kept inline to
 * avoid pulling a timer utility into this file.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abortable sleep used by the shared-token 401 refresh backoff. Resolves
 * after `ms` OR rejects with ApiError(0, 'EXPORT_CANCELLED', ...) if
 * `signal` fires first. When `signal` is undefined the behaviour is
 * identical to the plain `sleep(ms)` above (path equivalence preserved
 * for callers that do not pass a signal).
 *
 * The abort listener is removed inside both the timer callback and the
 * abort handler so no listener leaks across consecutive backoff cycles
 * when the same signal services multiple chunks.
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      reject(new ApiError(0, 'EXPORT_CANCELLED', 'aborted', null));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ApiError(0, 'EXPORT_CANCELLED', 'aborted', null));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * Resolve a fresh Supabase access token, retrying ONCE after a short
 * pause if the first attempt comes back null.
 *
 * Why this exists: `getFreshAccessToken` calls `supabase.auth.getSession()`
 * which performs an inline refresh against Supabase using the persisted
 * refresh_token when the access token has expired. During a long export
 * (~200 chunks, ~1-2 min) it is realistic for that refresh's HTTP call
 * to land on a transient network blip — `getSession()` then returns
 * `{ session: null }` and we get null here. Retrying once after 500 ms
 * usually picks the network back up and unblocks the chunk download.
 *
 * Pre-refactor, a null here threw `ApiError(401, 'NO_TOKEN', ...)` on
 * the first miss, which the export loop catch then misclassified as a
 * chunk integrity failure. The retry + the distinct `AUTH_FAILED` code
 * below break that misclassification.
 */
async function getFreshAccessTokenWithRetry(): Promise<string | null> {
  const first = await getFreshAccessToken();
  if (first) return first;
  await sleep(500);
  return await getFreshAccessToken();
}

/**
 * GET /sessions/:id/chunks/:index/download — raw bytes.
 *
 * Returns the decoded bytes and the hash the backend advertised in the
 * X-Chunk-Hash header (useful for debug logging; the caller still
 * verifies against the per-chunk metadata hash from the chunks listing,
 * which is the source of truth).
 *
 * Auth retry contract:
 *   - If `getFreshAccessToken()` returns null we retry ONCE after 500 ms
 *     (via `getFreshAccessTokenWithRetry`). If still null, we throw a
 *     distinct `ApiError(401, 'AUTH_FAILED', ...)` so the caller can
 *     recognise the failure as "no auth available", NOT "the bytes
 *     went bad". The export loop relies on this code to skip the
 *     corruptIndexes path.
 *   - If the server responds 401, we invalidate, fetch a fresh token,
 *     and retry the request ONCE. If the second attempt is still 401,
 *     we throw the same `AUTH_FAILED` code.
 *   - Any other failure (network, 404, 5xx, content-type) keeps its
 *     historical behaviour: `ApiError(status, code, message, parsed)`.
 *
 * The retry is single-shot by design — `getFreshAccessToken` already
 * does its own inline refresh on every call; this wrapper only covers
 * a transient blip during that refresh's outbound HTTP request.
 */
export async function downloadChunk(
  sessionId: string,
  chunkIndex: number,
  timeoutMs = 30_000,
): Promise<{ bytes: Uint8Array; headerHash: string }> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/chunks/${chunkIndex}/download`;
  const url = `${env.apiUrl}${path}`;

  // Two attempts max. First attempt uses whatever token is currently
  // valid; if the server responds 401, the second attempt forces a
  // fresh refresh + retries the request body exactly once. We never
  // attempt 3+ — beyond two an auth failure is permanent enough to
  // surface, not loop on.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const token = await getFreshAccessTokenWithRetry();
    if (!token) {
      log('AUTH MISSING', { path, attempt });
      if (attempt === 2) {
        throw new ApiError(
          401,
          'AUTH_FAILED',
          'Authentication unavailable; please retry',
          null,
        );
      }
      // First attempt: pause briefly and re-loop so the
      // getFreshAccessTokenWithRetry on attempt 2 sees a different
      // network window.
      await sleep(500);
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    log('API CALL', { method: 'GET', url, authed: true, attempt });
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        e instanceof Error ? e.message : 'Network request failed',
        null,
      );
    }
    clearTimeout(timer);

    if (response.ok) {
      const headerHash =
        response.headers.get('x-chunk-hash') ??
        response.headers.get('X-Chunk-Hash') ??
        '';
      const ab = await response.arrayBuffer();
      return { bytes: new Uint8Array(ab), headerHash };
    }

    // Non-2xx. If it's a 401 on attempt 1, loop once with a fresh
    // token — supabase-js may have rotated it by now. On attempt 2 a
    // 401 means auth is genuinely unavailable; surface as AUTH_FAILED.
    if (response.status === 401) {
      if (attempt === 1) {
        log('AUTH 401 RETRY', { path, attempt });
        await sleep(500);
        continue;
      }
      // Drain body for log fidelity (best-effort).
      const ct = response.headers.get('content-type') ?? '';
      let parsed: unknown = null;
      if (ct.includes('application/json')) {
        parsed = await response.json().catch(() => null);
      }
      throw new ApiError(
        401,
        'AUTH_FAILED',
        'Authentication unavailable; please retry',
        parsed,
      );
    }

    // Any other non-2xx is propagated unchanged — same shape as
    // before this refactor so downstream classification of network /
    // 4xx / 5xx failures is byte-identical.
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

  // Unreachable: the loop either returns or throws on every path. The
  // explicit throw here keeps TypeScript happy without disabling the
  // exhaustive check on the loop body.
  throw new ApiError(
    401,
    'AUTH_FAILED',
    'Authentication unavailable; please retry',
    null,
  );
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
 * Minimal shape the shared exporter needs to identify each chunk: index,
 * expected sha256, expected size. The data source for chunk metadata is
 * caller-specific (DB-backed `ChunkMeta` for normal export, manifest for
 * cross-device recovery export); both collapse to this small struct
 * before entering `exportFromChunkRefs`.
 *
 * Exposed for the recovery exporter — see `mobile/src/api/recoveryExport.ts`.
 */
export interface ChunkRef {
  chunk_index: number;
  hash: string;
  size: number;
}

/**
 * Shared exporter primitive. Walks the longest contiguous prefix of
 * `chunks`, downloads each via `downloadFn`, verifies sha256, concats,
 * sniffs the output container (or honours `mode='video'`), writes the
 * file as base64 under `${docDir}${filenamePrefix}_${sessionId}${ext}`,
 * and returns an `ExportResult` shaped exactly like the legacy
 * `exportSession` did before the refactor.
 *
 * Both callers — `exportSession` (DB-backed) and `exportRecoveredSession`
 * (manifest-backed) — funnel through this function so the survival
 * rules (longest valid prefix, stop at first gap) and the diagnostic
 * logs stay literally identical.
 *
 * The function does NOT do:
 *   - the upstream list/fetch (caller's job)
 *   - the empty-set early return (caller's job — exportSession needs to
 *     report `chunks.length` for the legacy "no_uploaded_chunks" branch,
 *     which is data-source-specific)
 *   - any persistence beyond the on-disk file
 *
 * Behaviour-preserving contract with the pre-refactor `exportSession`:
 *   - same log keys: `EXPORT STOPPED AT GAP`, `EXPORT CHUNK DOWNLOADED`,
 *     `EXPORT CHUNK CORRUPT`, `GC_EXPORT_HASH_MISMATCH`,
 *     `EXPORT PREFIX SUMMARY`, `EXPORT ERROR`, `EXPORT EXT SNIFF`,
 *     `EXPORT COMPLETE`, `EXPORT PARTIAL`, `GC_EXPORT_RESULT`,
 *     `GC_EXPORT_DIAG_RAW`, `GC_EXPORT_DEBUG_CORRUPTED_CHUNK`
 *   - same `ExportResult` shape, same status semantics
 *   - same byte-sniff (.aac / .m4a / .mp4 / .bin), same video override
 *   - same on-disk path: `${docDir}${filenamePrefix}_${sessionId}${ext}`
 *   - `filenamePrefix === 'guardian_export'` reproduces the legacy
 *     filename; recovery uses `'guardian_recovered'` to coexist without
 *     overwriting prior normal exports.
 *
 * Never throws — every failure mode is folded into the result.
 */
export async function exportFromChunkRefs(
  sessionId: string,
  filenamePrefix: 'guardian_export' | 'guardian_recovered',
  chunks: ChunkRef[],
  downloadFn: (chunkIndex: number) => Promise<{
    bytes: Uint8Array;
    headerHash: string;
  }>,
  onProgress?: (p: ExportProgress) => void,
  mode?: SessionMode,
  // Optional cancellation signal. When omitted, behaviour is byte-
  // identical to the pre-signal implementation (no aborted checks fire,
  // no cancelled short-circuit runs). Callers that pass a signal can
  // abort the export at iteration boundaries OR mid-fetch (the latter
  // requires the `downloadFn` closure to honour the same signal — see
  // `downloadChunkSharedToken` for the active wiring).
  signal?: AbortSignal,
): Promise<ExportResult> {
  // Caller guarantees `chunks` is already filtered + sorted asc by
  // chunk_index. We re-derive lastIndex / totalChunks / missingIndexes
  // from the input so the helper has a single source of truth.
  const lastIndex = chunks[chunks.length - 1]!.chunk_index;
  const totalChunks = lastIndex + 1;

  const presentIndexes = new Set(chunks.map((c) => c.chunk_index));
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
  let filePath = `${docDir}${filenamePrefix}_${sessionId}.m4a`;

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
  let stopReason:
    | 'missing'
    | 'hash_mismatch'
    | 'download_failed'
    | 'auth_failed'
    | 'cancelled'
    | null =
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
  //   (a) missing from the input set (not yet 'uploaded' / not in
  //       manifest), or
  //   (b) downloaded but failed sha256 verification, or
  //   (c) failed to download (network / 4xx / 5xx).
  // At the first hole we STOP the loop. We do NOT continue downloading
  // chunks past the gap — those bytes would only contribute to a sparse
  // file that no decoder can play, contradicting "subir evidencia >
  // archivo perfecto". The skipped indexes remain visible in the result
  // (`missingIndexes` was computed up-front; corrupt-at-cut goes into
  // `corruptIndexes` so the integrity report stays honest).
  const byIndex = new Map(chunks.map((c) => [c.chunk_index, c]));
  for (let idx = 0; idx < totalChunks; idx++) {
    // Cancellation gate at iteration boundary. Fires when the caller's
    // AbortController has been aborted between (or before) downloads.
    // Mirrors the same "stopped at gap" structure used for missing /
    // hash_mismatch / download_failed: record the index, set the
    // stopReason, log, break. The bottom-of-function short-circuit
    // then collapses to `status='failed'` with no file written.
    //
    // When `signal` is undefined this branch is dead code — `signal?.aborted`
    // evaluates to `undefined` (falsy). Path equivalence with the
    // pre-signal implementation is preserved by construction.
    if (signal?.aborted) {
      stoppedAt = idx;
      stopReason = 'cancelled';
      log('EXPORT STOPPED AT GAP', {
        sessionId,
        atIndex: idx,
        reason: 'cancelled',
      });
      break;
    }

    const meta = byIndex.get(idx);

    // (a) Missing from the input set — stop. The exact set of missing
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
      const { bytes, headerHash } = await downloadFn(idx);

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
      //
      // Cancelled branch: `downloadChunkSharedToken` raises ApiError
      // with code `EXPORT_CANCELLED` when the caller's AbortSignal
      // fires mid-fetch (linked into the internal AbortController) or
      // during the 401 refresh backoff. Same survival rule as
      // `AUTH_FAILED`: bytes never reached the verifier, so calling it
      // "corrupt" would lie. Tag stopReason='cancelled' and do NOT
      // push to corruptIndexes. The bottom short-circuit below folds
      // this into `status='failed'` with no file written.
      if (err instanceof ApiError && err.code === 'EXPORT_CANCELLED') {
        stoppedAt = idx;
        stopReason = 'cancelled';
        log('EXPORT STOPPED AT GAP', {
          sessionId,
          atIndex: idx,
          reason: 'cancelled',
        });
        break;
      }

      // Auth-failed branch: `downloadChunk` raises ApiError with code
      // `AUTH_FAILED` after its single retry exhausts (null token twice
      // OR server 401 twice). That is structurally different from
      // download_failed: the chunk's BYTES were never even pitted
      // against the wire, so calling it "corrupt" would lie to the
      // user. Bail with stopReason='auth_failed' and DO NOT push to
      // corruptIndexes. The caller's UI maps this to a retry prompt
      // rather than an integrity-damaged verdict.
      if (err instanceof ApiError && err.code === 'AUTH_FAILED') {
        stoppedAt = idx;
        stopReason = 'auth_failed';
        error('EXPORT STOPPED AT AUTH', {
          sessionId,
          atIndex: idx,
          err: err.message,
        });
        break;
      }
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

  // Cancelled short-circuit. The user explicitly aborted via the
  // AbortSignal (either before any download, between chunks, or
  // mid-fetch). No file is written and no chunks are flagged corrupt
  // — cancellation is not an integrity event. The result preserves
  // `validChunks` (the number that downloaded + verified before the
  // abort landed) so callers can show "you got N/M before stopping"
  // if they want, but the authoritative shape is status='failed' with
  // stopReason='cancelled' and filePath=null. Mirrors the auth_failed
  // structure below — same "user-initiated, not corruption" semantics.
  if (stopReason === 'cancelled') {
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'cancelled',
      status: 'failed',
      totalChunks,
      validChunks,
      missingCount: missingIndexes.length,
      corruptCount: corruptIndexes.length,
      stoppedAt,
      stopReason,
      extension: null,
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks,
      validChunks,
      missingIndexes,
      corruptIndexes,
      extension: null,
      stoppedAt,
      stopReason,
    };
  }

  // Auth-failed short-circuit. Per the survival rule "no false claims
  // about evidence integrity", an export that bailed because the
  // device lost its session token must NOT be presented as partial
  // (even if validChunks > 0). The user's mental model is "I lost my
  // login; I should re-try", not "my evidence is damaged". We return
  // `status: 'failed'` with no file written; the UI maps this to a
  // retry CTA. `validChunks` is preserved in the result so logs and
  // any future diagnostic surface honest numbers without lying.
  if (stopReason === 'auth_failed') {
    error('EXPORT ERROR', {
      sessionId,
      phase: 'auth_failed',
      validChunks,
    });
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'auth_failed',
      status: 'failed',
      totalChunks,
      validChunks,
      missingCount: missingIndexes.length,
      corruptCount: corruptIndexes.length,
      stoppedAt,
      stopReason,
      extension: null,
    });
    return {
      status: 'failed',
      filePath: null,
      totalChunks,
      validChunks,
      missingIndexes,
      corruptIndexes,
      extension: null,
      stoppedAt,
      stopReason,
    };
  }

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
    filePath = `${docDir}${filenamePrefix}_${sessionId}${extension}`;
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

// ===========================================================================
// Shared-token download path for long-running exports
// ===========================================================================
//
// Why this exists: pre-this-patch, the export loop called
// `downloadChunk` for every chunk, and `downloadChunk` re-resolved the
// access token via `getFreshAccessToken()` (which calls
// `supabase.auth.getSession()`) on every call. For a 200-chunk export
// that meant ~400-800 token resolutions, each one capable of doing an
// opportunistic inline refresh against Supabase. A single transient
// network blip during any of those refreshes returned null → the loop
// bailed with AUTH_FAILED even though the user's session was perfectly
// healthy.
//
// The fix shifts the model:
//   1. `exportSession` resolves the access token ONCE after
//      `listSessionChunks` succeeds, stores it in a `tokenRef`.
//   2. The chunk loop uses `downloadChunkSharedToken` which reads
//      `tokenRef.current` and NEVER calls `getFreshAccessToken`.
//   3. ONLY when the backend returns 401 do we explicitly refresh via
//      `supabase.auth.refreshSession()` with exponential backoff
//      (500/1000/2000/4000/8000 ms, max 5 attempts), update
//      `tokenRef.current`, and retry the same chunk. Following chunks
//      inherit the refreshed token automatically because they read
//      the same ref.
//
// What this DOES NOT touch:
//   - `downloadChunk` (the standalone export helper) stays intact for
//     the few solo callers like the session detail screen's fragment
//     downloader. The legacy retry-twice pattern there is unchanged.
//   - `listSessionChunks` keeps its own auth retry — it is one call
//     at the start of export, not per-chunk, so it is not the
//     bottleneck this patch addresses.
//   - `exportFromChunkRefs` is auth-agnostic by design; it consumes
//     the `downloadFn` callback the caller hands it, and that is
//     where the shared token gets injected.
//   - Recovery cross-device (`recoveryExport.ts`) — out of scope per
//     project policy.

const AUTH_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
const MAX_AUTH_REFRESH_ATTEMPTS = AUTH_BACKOFF_MS.length;

/**
 * Mutable holder for the access token shared across all chunk
 * downloads in one export run. Mutated by the 401-recovery path inside
 * `downloadChunkSharedToken` so the next chunk sees the refreshed
 * token without re-resolving via supabase-js.
 */
interface TokenRef {
  current: string;
}

/**
 * Build a uniform "cancelled" ExportResult. Used by `exportSession`
 * for the pre-flight cancellation checks (signal already aborted
 * before list / between list and token / between token and loop). The
 * loop's own cancellation lives inside `exportFromChunkRefs`'s short-
 * circuit and produces an equivalent shape.
 *
 * `totalChunks` is 0 here because the loop never ran; the result is
 * "we never even got to count". The UI's cancellation copy is keyed
 * off `stopReason === 'cancelled'`, not the chunk totals.
 */
function buildCancelledResult(): ExportResult {
  return {
    status: 'failed',
    filePath: null,
    totalChunks: 0,
    validChunks: 0,
    missingIndexes: [],
    corruptIndexes: [],
    extension: null,
    stoppedAt: null,
    stopReason: 'cancelled',
  };
}

/**
 * Explicitly refresh the Supabase session and return the new access
 * token, or null if the refresh failed for any reason (revoked
 * refresh_token, network down, no persisted session, etc.).
 *
 * Distinct from `getFreshAccessToken`: that helper calls
 * `supabase.auth.getSession()` which only refreshes opportunistically
 * (i.e. when supabase-js considers the token expired). When the
 * backend rejects a token with 401 mid-export, supabase-js may not
 * agree it is expired yet (clock skew, server-side revocation we
 * don't know about). `refreshSession()` is the unambiguous "give me a
 * new token now" call.
 *
 * Never throws.
 */
async function refreshAccessTokenViaSupabase(): Promise<string | null> {
  try {
    const { data, error: err } = await supabase.auth.refreshSession();
    if (err) return null;
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Download one chunk using the export-scoped `tokenRef`. Mirrors the
 * external contract of `downloadChunk` (returns `{bytes, headerHash}`,
 * throws `ApiError` for failures) but uses the shared token model
 * instead of resolving auth per call.
 *
 * Failure semantics:
 *   - 2xx                            → bytes + headerHash
 *   - non-2xx and non-401            → throw ApiError(status, code, ...)
 *     (same shape as `downloadChunk` — propagated through the export
 *     loop into the standard `download_failed` stopReason path)
 *   - 401                            → enter the refresh backoff. Up to
 *     `MAX_AUTH_REFRESH_ATTEMPTS` cycles of "sleep, refreshSession,
 *     retry chunk". Each successful refresh mutates `tokenRef.current`
 *     so later chunks pick up the new token without re-entering this
 *     path. If all attempts exhaust → throw ApiError(401, 'AUTH_FAILED').
 *   - network throw                  → throw ApiError(0, 'NETWORK_ERROR', ...)
 *     (same as `downloadChunk`).
 *
 * This function does NOT mutate `tokenRef.current` outside the 401
 * branch — happy-path downloads leave the token untouched.
 */
async function downloadChunkSharedToken(
  sessionId: string,
  chunkIndex: number,
  tokenRef: TokenRef,
  timeoutMs = 30_000,
  // Optional cancellation signal. When provided, an abort fires the
  // internal AbortController (cancelling any in-flight fetch) AND
  // interrupts the 401 refresh backoff sleep. Aborts surface as
  // ApiError(0, 'EXPORT_CANCELLED', ...) so the caller in
  // `exportFromChunkRefs` can discriminate cancellation from
  // NETWORK_ERROR / AUTH_FAILED / generic download failures. When
  // omitted, every code path is byte-identical to the pre-signal
  // implementation.
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; headerHash: string }> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/chunks/${chunkIndex}/download`;
  const url = `${env.apiUrl}${path}`;

  async function fetchOnce(token: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // External signal → internal controller relay. Allows mid-fetch
    // cancellation while preserving the existing timeout semantics.
    // Listener is removed in the finally so a long-lived signal does
    // not accumulate handlers across consecutive chunk downloads.
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', onExternalAbort);
      }
    }
    try {
      return await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (e) {
      // Distinguish a fetch abort originating from `signal` (caller
      // cancelled) from a fetch abort originating from `timer`
      // (timeout) or a genuine network throw. The caller's loop maps
      // EXPORT_CANCELLED to `stopReason='cancelled'` and keeps the
      // chunk OFF corruptIndexes — see exportFromChunkRefs's catch.
      if (signal?.aborted) {
        throw new ApiError(0, 'EXPORT_CANCELLED', 'aborted', null);
      }
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        e instanceof Error ? e.message : 'Network request failed',
        null,
      );
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  function readHeaderHash(response: Response): string {
    return (
      response.headers.get('x-chunk-hash') ??
      response.headers.get('X-Chunk-Hash') ??
      ''
    );
  }

  async function throwHttpError(response: Response): Promise<never> {
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

  log('API CALL', { method: 'GET', url, authed: true, shared_token: true });
  let response = await fetchOnce(tokenRef.current);

  if (response.ok) {
    const ab = await response.arrayBuffer();
    return { bytes: new Uint8Array(ab), headerHash: readHeaderHash(response) };
  }
  if (response.status !== 401) {
    await throwHttpError(response);
  }

  // 401 path: try to recover by refreshing the session and retrying.
  // We do NOT propagate the original 401 immediately because the
  // primary symptom we're fixing is a transient that resolves with a
  // single refresh — but bound the work strictly with the documented
  // backoff schedule so a genuinely revoked session fails in a
  // predictable window (sum of backoffs ≈ 15.5s).
  log('AUTH_REFRESH_START', {
    sessionId,
    chunkIndex,
    reason: 'http_401_from_backend',
  });
  for (let attempt = 0; attempt < MAX_AUTH_REFRESH_ATTEMPTS; attempt++) {
    // Use the abortable sleep so a cancel during a long backoff
    // (up to 8s on the last attempt) does not stall the export. The
    // signal-less call is byte-identical to the plain sleep used
    // before this change.
    await sleepAbortable(AUTH_BACKOFF_MS[attempt]!, signal);
    const newToken = await refreshAccessTokenViaSupabase();
    if (!newToken) {
      log('AUTH_REFRESH_FAILED', {
        sessionId,
        chunkIndex,
        attempt: attempt + 1,
        backoff_ms: AUTH_BACKOFF_MS[attempt],
      });
      continue;
    }
    // Shared mutation. Subsequent chunks see this new token without
    // re-entering this 401 path themselves, so a single 401 incident
    // benefits the rest of the export in one shot.
    tokenRef.current = newToken;
    log('AUTH_REFRESH_OK', {
      sessionId,
      chunkIndex,
      attempt: attempt + 1,
    });
    response = await fetchOnce(newToken);
    if (response.ok) {
      const ab = await response.arrayBuffer();
      return { bytes: new Uint8Array(ab), headerHash: readHeaderHash(response) };
    }
    if (response.status !== 401) {
      // The refresh worked but the chunk request itself errored for
      // an unrelated reason (404, 5xx, etc.). Propagate that normally
      // — the export loop classifies it as `download_failed`, NOT
      // `auth_failed`.
      await throwHttpError(response);
    }
    // Still 401 — Supabase rotated tokens but the backend still
    // rejects. Keep retrying within the budget.
  }

  error('AUTH_REFRESH_EXHAUSTED', {
    sessionId,
    chunkIndex,
    attempts: MAX_AUTH_REFRESH_ATTEMPTS,
  });
  throw new ApiError(
    401,
    'AUTH_FAILED',
    'Authentication unavailable; please retry',
    null,
  );
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
 *
 * COMMIT 3 refactor: the body that walks chunks, verifies, concats,
 * sniffs and writes lives in `exportFromChunkRefs` so both this function
 * and the recovery exporter share it. This wrapper handles the data
 * source (backend chunks listing) + the source-specific empty-result
 * branch ("no_uploaded_chunks") that depends on the raw DB count rather
 * than the filtered set. Behaviour-preserving — no external observable
 * difference vs. the pre-refactor implementation.
 *
 * Shared-token patch: after listSessionChunks succeeds we resolve the
 * access token ONCE and bind it into a closure-scoped `tokenRef`. The
 * downloadFn handed to `exportFromChunkRefs` uses this ref instead of
 * re-resolving auth per chunk — see `downloadChunkSharedToken` for the
 * detailed rationale. The 401-only refresh path is the only place the
 * ref is mutated; the happy path does not touch auth at all.
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
  /**
   * Optional cancellation signal. Plumbed through `listSessionChunks`,
   * `exportFromChunkRefs`, and `downloadChunkSharedToken`. When the
   * signal fires, the run resolves with `status='failed'` and
   * `stopReason='cancelled'` — no throw, no file written, no chunks
   * marked corrupt. When omitted, behaviour is byte-identical to the
   * pre-signal implementation (the cancelled short-circuit never
   * fires, list and download paths see `signal: undefined` and skip
   * the abort hooks entirely).
   */
  signal?: AbortSignal,
): Promise<ExportResult> {
  log('EXPORT START', { sessionId, mode });

  // Pre-list cancellation check. Catches the "started then immediately
  // cancelled" race before any network or token I/O fires.
  if (signal?.aborted) {
    return buildCancelledResult();
  }

  let chunks: ChunkMeta[];
  try {
    chunks = await listSessionChunks(sessionId, signal);
  } catch (err) {
    // Discriminate the auth-loss case from a generic list failure.
    // `listSessionChunks` raises `ApiError(401, 'AUTH_FAILED', ...)`
    // after its single auth-retry exhausts; anything else (5xx, 404,
    // network) propagates with its original shape and we keep the
    // legacy `list_failed` diagnostic surface.
    //
    // The UI's `ResultBlock` auth_failed branch keys off
    // `result.stopReason === 'auth_failed'`, so propagating that here
    // is the one wire that makes "Sesión caducada / Vuelve a
    // intentarlo" appear instead of the generic empty-list verdict.
    const isAuthFailed =
      err instanceof ApiError && err.code === 'AUTH_FAILED';
    if (isAuthFailed) {
      error('EXPORT ERROR', {
        sessionId,
        phase: 'auth_failed_list',
        err: err.message,
      });
      log('GC_EXPORT_DIAG_RAW', {
        sessionId,
        phase: 'auth_failed',
        status: 'failed',
        totalChunks: 0,
        validChunks: 0,
        missingCount: 0,
        corruptCount: 0,
        stoppedAt: null,
        stopReason: 'auth_failed',
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
        stopReason: 'auth_failed',
      };
    }
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
    // Data-source-specific empty branch: the DB may carry chunks in
    // pending/failed state that the manifest path never sees, and the
    // legacy `GC_EXPORT_DIAG_RAW` payload reports the RAW count
    // (`chunks.length`) plus every raw chunk_index as missing. Keeping
    // this branch in the wrapper preserves byte-identical telemetry
    // for normal export consumers.
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

  // Project ChunkMeta → ChunkRef. The shared helper does not need
  // status / remote_reference (already filtered) and only consumes
  // chunk_index / hash / size.
  const refs: ChunkRef[] = uploaded.map((c) => ({
    chunk_index: c.chunk_index,
    hash: c.hash,
    size: c.size,
  }));

  // Post-list cancellation check. Lets a cancel that arrived during
  // `listSessionChunks` (or during the small window before the token
  // resolution starts) bail out cleanly before we read auth state.
  if (signal?.aborted) {
    return buildCancelledResult();
  }

  // Resolve the access token ONCE for the whole chunk loop.
  // `listSessionChunks` just succeeded so supabase-js definitely has a
  // valid token in hand; we read it and pin it. The chunk loop below
  // never calls `getFreshAccessToken` again — only the 401-recovery
  // branch inside `downloadChunkSharedToken` mutates this ref through
  // an explicit `supabase.auth.refreshSession()`. This eliminates the
  // ~400-800 token resolutions a 200-chunk export used to make and
  // the matching probability of a single transient failure aborting
  // the whole run.
  const initialToken = await getFreshAccessToken();
  if (!initialToken) {
    // Extremely rare: list just succeeded but the next token read came
    // back null. Treat as auth_failed and surface the same UI block
    // the rest of the auth path uses. NOT a corruption verdict.
    error('EXPORT ERROR', {
      sessionId,
      phase: 'auth_failed_initial_token',
    });
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'auth_failed',
      status: 'failed',
      totalChunks: 0,
      validChunks: 0,
      missingCount: 0,
      corruptCount: 0,
      stoppedAt: null,
      stopReason: 'auth_failed',
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
      stopReason: 'auth_failed',
    };
  }
  // Post-token cancellation check. Mirrors the pre-list and post-list
  // checks; together they ensure every awaited transition in this
  // function honours cancellation before the (potentially long) chunk
  // loop starts.
  if (signal?.aborted) {
    return buildCancelledResult();
  }

  const tokenRef: TokenRef = { current: initialToken };

  return exportFromChunkRefs(
    sessionId,
    'guardian_export',
    refs,
    // Closure captures `signal` so each per-chunk fetch + 401 backoff
    // sleep honours the same cancellation. The default-timeout argument
    // is preserved at its value (30_000) — only the new signal slot is
    // populated here. Path equivalence with the pre-signal call site
    // holds: when signal is undefined, downloadChunkSharedToken sees
    // signal=undefined and follows the legacy code path verbatim.
    (idx) => downloadChunkSharedToken(sessionId, idx, tokenRef, 30_000, signal),
    onProgress,
    mode,
    signal,
  );
}

// TODO(export-history): the entry point to reach this flow is only the
// direct route app/session/[id].tsx. A proper "Historial" screen listing
// the user's past sessions and linking into export lives outside the
// current scope and will be added in a later brick.
