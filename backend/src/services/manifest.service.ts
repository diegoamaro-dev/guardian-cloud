/**
 * Best-effort session manifest generator.
 *
 * After a Drive-backed session is marked completed, this module derives a
 * JSON manifest from the chunks that are already on Drive and uploads it
 * to the same Drive folder as the chunks. The manifest is a DERIVED
 * artifact:
 *
 *   - it is NOT the source of truth for the upload pipeline,
 *   - failure to generate or upload it MUST NOT fail completion,
 *   - missing manifests are tolerated by future discovery flows.
 *
 * Why a manifest? To enable cross-device recovery (see /docs roadmap):
 * when the user installs Guardian Cloud on a new phone and connects the
 * same Google Drive, the manifest is the small, self-describing index
 * that lets the new device know which sessions exist and what chunks
 * compose each one.
 *
 * Strict isolation contract:
 *   - never throws (no exception escapes `tryGenerateManifest`)
 *   - never modifies sessions/chunks rows
 *   - never touches the upload worker, queue, recovery, export, foreground
 *     service, AudioEngine or any mobile code
 *   - one Drive upload per session at completion time, nothing else
 *   - no Drive idempotency on the manifest itself: a retry that races
 *     past the SESSION_ALREADY_COMPLETED gate is structurally prevented
 *     by `sessions.service.ts` returning 409 before this is reached.
 *     If two manifests somehow land in Drive, discovery picks the most
 *     recent — handled in a later commit, not here.
 */

import { Buffer } from 'node:buffer';

import { logger } from '../utils/logger.js';
import {
  getOwnedSession,
  type CompleteSessionResult,
  type SessionMode,
  type SessionRow,
} from './sessions.service.js';
import { getDestinationWithSecretForUser } from './destinations.service.js';
import { listChunksForSession, type ChunkRow } from './chunks.service.js';
import {
  ensureRootFolder,
  uploadFile,
  withDriveRetry,
} from './drive.service.js';

const MANIFEST_SCHEMA = 'guardian-cloud.manifest.v1';

export interface ManifestChunk {
  chunk_index: number;
  hash: string;
  size: number;
  /**
   * Deterministic Drive filename of the chunk's bytes. Reconstructable
   * from (session_id, chunk_index, hash) — see `chunkFileName`. Discovery
   * on a different device uses this to locate chunks in Drive by name
   * without depending on Drive `file_id` (`remote_reference` is
   * intentionally NOT in the manifest to avoid coupling the manifest
   * shape to Drive internals).
   */
  file_name: string;
}

export interface SessionManifest {
  schema: typeof MANIFEST_SCHEMA;
  session_id: string;
  mode: SessionMode;
  destination_type: 'drive';
  created_at: string;
  completed_at: string;
  /**
   * Container format, only set when derivable safely from `mode`:
   *   - 'mp4' for mode='video' (video sessions always land as MP4)
   *   - omitted for mode='audio' (the client sniffs .aac vs .m4a at
   *     export time; we do not persist the format server-side, so
   *     guessing here would be unsound).
   */
  format?: 'mp4';
  chunk_count: number;
  chunks: ManifestChunk[];
}

/**
 * Deterministic chunk filename used by the upload proxy.
 *
 * MUST stay byte-for-byte identical to the formula in
 * `routes/destinations.routes.ts` (~line 731). If either side changes
 * independently the unit test in `tests/unit/manifest.service.test.ts`
 * fails — that pin is intentional. We intentionally do NOT import the
 * source side: the upload proxy is the canonical writer and this is the
 * read-side reconstruction, so duplication with a pinned test is safer
 * than a shared helper that drags the upload hot path into a new
 * dependency.
 */
export function chunkFileName(
  sessionId: string,
  chunkIndex: number,
  hash: string,
): string {
  const paddedIndex = String(chunkIndex).padStart(6, '0');
  const shortHash = hash.slice(0, 12);
  return `${sessionId}_${paddedIndex}_${shortHash}.chunk`;
}

/**
 * Subset of `SessionRow` the builder actually needs. Lets callers pass a
 * fixture without filling every column, and pins the contract tighter for
 * the unit test.
 */
interface SessionLite {
  id: string;
  mode: SessionMode;
  created_at: string;
}

/**
 * Pure builder. Filters chunks to those already on Drive (uploaded AND
 * carrying a non-null `remote_reference`) so the manifest only ever
 * describes evidence that actually exists in cloud storage. Sorts by
 * `chunk_index` ascending and reports `chunk_count` based on the
 * FILTERED set length, not the raw count from the chunks table.
 *
 * Side-effect free. Exposed for unit testing.
 */
export function buildManifest(
  session: SessionLite,
  completedAt: string,
  chunks: ChunkRow[],
): SessionManifest {
  const uploaded = chunks
    .filter((c) => c.status === 'uploaded' && !!c.remote_reference)
    .sort((a, b) => a.chunk_index - b.chunk_index)
    .map<ManifestChunk>((c) => ({
      chunk_index: c.chunk_index,
      hash: c.hash,
      size: c.size,
      file_name: chunkFileName(session.id, c.chunk_index, c.hash),
    }));

  const manifest: SessionManifest = {
    schema: MANIFEST_SCHEMA,
    session_id: session.id,
    mode: session.mode,
    destination_type: 'drive',
    created_at: session.created_at,
    completed_at: completedAt,
    chunk_count: uploaded.length,
    chunks: uploaded,
  };

  if (session.mode === 'video') {
    manifest.format = 'mp4';
  }

  return manifest;
}

/**
 * Best-effort manifest generation + upload to Drive. Never throws.
 *
 * Gates (skip on first failure, each logged with a stable reason):
 *   1. session row readable
 *   2. destination_type === 'drive'
 *   3. user has a connected Drive destination with a refresh_token
 *   4. chunks listing succeeds
 *   5. there is at least one uploaded chunk to manifest
 *
 * On success: `GC_MANIFEST_GENERATED` with size + chunk count + upload_ms.
 * On any failure: `GC_MANIFEST_FAILED` with a stable reason. The
 * completion path is untouched in both cases.
 */
export async function tryGenerateManifest(
  userId: string,
  sessionId: string,
  completed: CompleteSessionResult,
): Promise<void> {
  let session: SessionRow;
  try {
    session = await getOwnedSession(userId, sessionId);
  } catch (err) {
    logger.warn(
      {
        op: 'manifest.generate',
        sessionId,
        reason: 'session_lookup_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'GC_MANIFEST_FAILED',
    );
    return;
  }

  if (session.destination_type !== 'drive') {
    logger.info(
      {
        op: 'manifest.generate',
        sessionId,
        reason: 'not_drive',
        destination_type: session.destination_type,
      },
      'GC_MANIFEST_SKIPPED',
    );
    return;
  }

  let dest;
  try {
    dest = await getDestinationWithSecretForUser(userId, 'drive');
  } catch (err) {
    logger.warn(
      {
        op: 'manifest.generate',
        sessionId,
        reason: 'destination_lookup_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'GC_MANIFEST_FAILED',
    );
    return;
  }

  if (!dest) {
    logger.info(
      { op: 'manifest.generate', sessionId, reason: 'no_drive_destination' },
      'GC_MANIFEST_SKIPPED',
    );
    return;
  }
  if (dest.status !== 'connected') {
    logger.info(
      {
        op: 'manifest.generate',
        sessionId,
        reason: 'drive_not_connected',
        status: dest.status,
      },
      'GC_MANIFEST_SKIPPED',
    );
    return;
  }
  if (!dest.refresh_token) {
    logger.info(
      { op: 'manifest.generate', sessionId, reason: 'no_refresh_token' },
      'GC_MANIFEST_SKIPPED',
    );
    return;
  }

  let chunks: ChunkRow[];
  try {
    chunks = await listChunksForSession(userId, sessionId);
  } catch (err) {
    logger.warn(
      {
        op: 'manifest.generate',
        sessionId,
        reason: 'list_chunks_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'GC_MANIFEST_FAILED',
    );
    return;
  }

  const manifest = buildManifest(
    { id: session.id, mode: session.mode, created_at: session.created_at },
    completed.completed_at,
    chunks,
  );

  if (manifest.chunk_count === 0) {
    logger.info(
      { op: 'manifest.generate', sessionId, reason: 'no_uploaded_chunks' },
      'GC_MANIFEST_SKIPPED',
    );
    return;
  }

  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const fileName = `${session.id}_manifest.json`;
  const refreshToken = dest.refresh_token;
  const cachedFolderId = dest.folder_id;

  const t_start = Date.now();
  try {
    const result = await withDriveRetry(refreshToken, async (accessToken) => {
      // Self-heal: if folder_id is null (legacy destination row, or user
      // deleted the folder by hand), recreate the root folder. We do NOT
      // persist it back to `destinations` from this best-effort path —
      // the canonical upload route owns that responsibility and will fix
      // it on the next chunk upload.
      const folderId = cachedFolderId ?? (await ensureRootFolder(accessToken));
      return await uploadFile(
        accessToken,
        folderId,
        fileName,
        manifestBytes,
        'application/json',
      );
    });
    logger.info(
      {
        op: 'manifest.generate',
        sessionId,
        file_id: result.file_id,
        size: manifestBytes.length,
        chunk_count: manifest.chunk_count,
        upload_ms: Date.now() - t_start,
      },
      'GC_MANIFEST_GENERATED',
    );
  } catch (err) {
    logger.warn(
      {
        op: 'manifest.generate',
        sessionId,
        reason: 'drive_upload_failed',
        err: err instanceof Error ? err.message : String(err),
        upload_ms: Date.now() - t_start,
      },
      'GC_MANIFEST_FAILED',
    );
  }
}
