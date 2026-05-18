/**
 * Cross-device recovery export client.
 *
 * COMMIT 3 — uses the manifest-driven endpoints introduced in
 * `backend/src/routes/recovery.routes.ts` to reconstruct evidence from
 * a Drive-resident manifest. Reuses the shared `exportFromChunkRefs`
 * helper in `./export.ts` for the verify / concat / sniff / write
 * pipeline, so survival rules and diagnostic logs stay aligned with
 * the normal export.
 *
 * Strict isolation:
 *   - calls only the new `/recovery/...` endpoints; never hits
 *     `/sessions/...`. The DB-backed path is untouched.
 *   - no Drive imports, no googleapis, no OAuth handling on the device
 *   - no GC_QUEUE / worker / chunking / recovery / export pipeline /
 *     background service / AudioEngine reads or writes
 *   - the on-disk file uses a distinct prefix (`guardian_recovered_`)
 *     so a recovered file does not overwrite a coexisting normal
 *     export (`guardian_export_`) of the same session_id.
 *
 * Never throws — failures from the backend / network are folded into
 * the returned `ExportResult` shape so the UI renders deterministic
 * states (success / partial / failed) just like for the normal export.
 */

import { env } from '@/config/env';
import { getFreshAccessToken } from '@/auth/store';
import { log, error } from '@/utils/log';

import { apiFetch, ApiError } from './client';
import {
  exportFromChunkRefs,
  type ChunkRef,
  type ExportProgress,
  type ExportResult,
} from './export';

/**
 * Wire-level chunk projection returned by the backend. Same shape as
 * `ManifestChunkRef` server-side; mirrored manually here (no shared
 * types package).
 */
export interface ManifestChunkRef {
  chunk_index: number;
  hash: string;
  size: number;
  file_name: string;
}

/**
 * Full manifest payload from `GET /recovery/manifests/:manifest_file_id`.
 * Mirrors `FullManifest` in the backend `recovery.service.ts`.
 *
 * `completed_at: string | null` — null when the manifest was written
 * incrementally during recording (the session never reached /complete).
 * The recovery exporter consumes the same `chunks` array either way
 * and produces a longest-prefix file via `exportFromChunkRefs`.
 */
export interface RecoveryFullManifest {
  manifest_file_id: string;
  session_id: string;
  mode: 'audio' | 'video';
  created_at: string;
  completed_at: string | null;
  chunk_count: number;
  chunks: ManifestChunkRef[];
}

/** GET /recovery/manifests/:manifest_file_id */
export function getRecoveryManifest(
  manifestFileId: string,
  signal?: AbortSignal,
): Promise<RecoveryFullManifest> {
  const encoded = encodeURIComponent(manifestFileId);
  return apiFetch<RecoveryFullManifest>(`/recovery/manifests/${encoded}`, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}

/**
 * GET /recovery/chunks/:manifest_file_id/:chunk_index/download — bytes.
 *
 * Mirrors `downloadChunk` in `./export.ts` (octet-stream + X-Chunk-Hash).
 * The route never appears under `/sessions/...`; that path stays for
 * the DB-backed export.
 */
export async function downloadRecoveryChunk(
  manifestFileId: string,
  chunkIndex: number,
  timeoutMs = 30_000,
): Promise<{ bytes: Uint8Array; headerHash: string }> {
  const encodedId = encodeURIComponent(manifestFileId);
  const path = `/recovery/chunks/${encodedId}/${chunkIndex}/download`;
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

/**
 * Discriminated failure surface for the recovery screen, BEFORE the
 * shared export helper takes over. When the upstream manifest fetch
 * fails for one of these well-known reasons, the screen needs to show
 * a clear human message ("Esta evidencia ya no está disponible.") that
 * the generic `ExportResult.status === 'failed'` cannot convey on its
 * own. We surface those failures here as a typed result; everything
 * else (mid-export gaps, hash mismatches, write failures) folds into
 * the standard `ExportResult` shape via the shared helper.
 */
export type RecoveryExportFailureReason =
  | 'manifest_not_found'
  | 'manifest_invalid'
  | 'drive_not_connected'
  | 'unknown';

export type RecoveryExportResult =
  | {
      kind: 'ok';
      sessionId: string;
      mode: 'audio' | 'video';
      result: ExportResult;
    }
  | {
      kind: 'manifest_failure';
      reason: RecoveryExportFailureReason;
      message: string;
    };

/**
 * Map a fetch failure on `getRecoveryManifest` to a stable
 * `RecoveryExportFailureReason`. The backend codes come from
 * `recovery.routes.ts`: MANIFEST_NOT_FOUND (404), MANIFEST_INVALID
 * (404), DRIVE_NOT_CONNECTED (503). Anything else collapses to
 * 'unknown' so the UI renders the generic retry CTA.
 */
function classifyManifestFailure(
  err: unknown,
): { reason: RecoveryExportFailureReason; message: string } {
  if (err instanceof ApiError) {
    if (err.code === 'MANIFEST_NOT_FOUND') {
      return {
        reason: 'manifest_not_found',
        message:
          'Esta evidencia ya no está disponible. Actualiza la lista.',
      };
    }
    if (err.code === 'MANIFEST_INVALID') {
      return {
        reason: 'manifest_invalid',
        message: 'El índice de la evidencia está dañado.',
      };
    }
    if (err.code === 'DRIVE_NOT_CONNECTED') {
      return {
        reason: 'drive_not_connected',
        message: 'Conecta Google Drive para recuperar esta evidencia.',
      };
    }
    return {
      reason: 'unknown',
      message: err.message,
    };
  }
  return {
    reason: 'unknown',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Orchestrator. Mirrors the shape of `exportSession` but pulls the
 * chunk list from the manifest endpoint and routes each chunk download
 * through `downloadRecoveryChunk`. Reuses `exportFromChunkRefs` so
 * verify/concat/sniff/write logic is byte-identical.
 *
 * On manifest failures (404 / invalid / Drive not connected) returns
 * `{ kind: 'manifest_failure', ... }` so the UI can render a precise
 * message. On all other paths (including partial / corrupt) returns
 * `{ kind: 'ok', result }` and the screen consumes `result.status`
 * exactly like session/[id].tsx does for normal exports.
 *
 * Never throws.
 */
export async function exportRecoveredSession(
  manifestFileId: string,
  onProgress?: (p: ExportProgress) => void,
): Promise<RecoveryExportResult> {
  log('GC_RECOVERY_EXPORT_START', { manifestFileId });

  let manifest: RecoveryFullManifest;
  try {
    manifest = await getRecoveryManifest(manifestFileId);
  } catch (err) {
    const classified = classifyManifestFailure(err);
    error('GC_RECOVERY_EXPORT_MANIFEST_FAILED', {
      manifestFileId,
      reason: classified.reason,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'manifest_failure',
      reason: classified.reason,
      message: classified.message,
    };
  }

  const sessionId = manifest.session_id;
  const mode = manifest.mode;

  // Manifest with zero chunks is structurally valid (parser allows it)
  // but cannot produce an exportable file. Fold to `result.status =
  // 'failed'` via the shared helper's downstream check by way of an
  // explicit early return: we cannot call exportFromChunkRefs with an
  // empty chunks array (it dereferences `chunks[chunks.length - 1]`).
  if (manifest.chunks.length === 0) {
    error('GC_RECOVERY_EXPORT_NO_CHUNKS', {
      manifestFileId,
      sessionId,
    });
    log('GC_EXPORT_DIAG_RAW', {
      sessionId,
      phase: 'no_uploaded_chunks',
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
      kind: 'ok',
      sessionId,
      mode,
      result: {
        status: 'failed',
        filePath: null,
        totalChunks: 0,
        validChunks: 0,
        missingIndexes: [],
        corruptIndexes: [],
        extension: null,
        stoppedAt: null,
        stopReason: null,
      },
    };
  }

  // Project ManifestChunkRef → ChunkRef (drop file_name; the helper
  // doesn't need it because downloadFn handles addressing). Already
  // sorted server-side by `parseManifestFull`, but resort defensively
  // in case a future schema change loosens that contract.
  const refs: ChunkRef[] = manifest.chunks
    .map((c) => ({
      chunk_index: c.chunk_index,
      hash: c.hash,
      size: c.size,
    }))
    .sort((a, b) => a.chunk_index - b.chunk_index);

  const result = await exportFromChunkRefs(
    sessionId,
    'guardian_recovered',
    refs,
    (idx) => downloadRecoveryChunk(manifestFileId, idx),
    onProgress,
    mode,
  );

  log('GC_RECOVERY_EXPORT_DONE', {
    manifestFileId,
    sessionId,
    status: result.status,
    validChunks: result.validChunks,
    totalChunks: result.totalChunks,
  });

  return { kind: 'ok', sessionId, mode, result };
}
