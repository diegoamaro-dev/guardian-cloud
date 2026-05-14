/**
 * Cross-device recovery — manifest discovery service.
 *
 * Lists `{sessionId}_manifest.json` files that this app uploaded to the
 * user's Google Drive (the same root folder where chunks live) and
 * surfaces a small, normalized projection per session for the mobile
 * "Recuperar evidencia" screen.
 *
 * COMMIT 2 SCOPE — discovery only:
 *   - read the manifest list from Drive
 *   - parse + validate each manifest (best-effort; corrupt manifests are
 *     skipped, not fatal)
 *   - dedup by session_id, keeping the most recently modified
 *   - return a tiny, UI-friendly shape — no chunk hashes, no Drive
 *     internals (except `manifest_file_id` for COMMIT 3 to use)
 *
 * NOT in COMMIT 2:
 *   - reconstruction / export from manifest (COMMIT 3)
 *   - DB enrichment / `sessions` row join (deliberately deferred — see
 *     ajuste 5 from product brief; cross-device must depend on
 *     Drive/manifests, not on enriching with DB now)
 *
 * Isolation:
 *   - never touches GC_QUEUE, the upload worker, chunking, recovery,
 *     export, background service, AudioEngine, or anything mobile-side
 *   - reads Drive only via the existing `withDriveRetry` / `driveGet`
 *     helpers in `drive.service.ts`
 *   - reads `destinations` via the existing safe accessor
 *   - never modifies any row server-side
 *
 * Failure shape:
 *   - Drive not connected → returns `{ drive_not_connected: true,
 *     manifests: [] }` with NO error. The UI renders an explanatory
 *     state, not an error toast.
 *   - any other failure (Drive list, downloads, parse) is logged and
 *     surfaces as fewer/zero entries; the endpoint never throws.
 */

import { Buffer } from 'node:buffer';

import { logger } from '../utils/logger.js';
import { getDestinationWithSecretForUser } from './destinations.service.js';
import {
  downloadFile,
  listFilesInFolder,
  withDriveRetry,
} from './drive.service.js';

/**
 * Stable client-facing projection. Discovery must not leak Drive
 * internals beyond the minimum needed for COMMIT 3 (`manifest_file_id`)
 * — that field is opaque to the UI.
 */
export interface RecoverableSession {
  session_id: string;
  mode: 'audio' | 'video';
  created_at: string;
  completed_at: string;
  chunk_count: number;
  protection_status: 'complete' | 'partial';
  /**
   * Drive file_id of the manifest this entry was derived from. Opaque to
   * the UI. Future COMMIT 3 uses it to fetch the same manifest the
   * discovery pass already vetted, avoiding a re-list + re-pick race.
   */
  manifest_file_id: string;
}

export interface DiscoveryResult {
  drive_not_connected: boolean;
  manifests: RecoverableSession[];
}

const MANIFEST_SCHEMA = 'guardian-cloud.manifest.v1';
/**
 * Strict UUID v4-ish guard — the same shape Supabase issues for
 * `sessions.id`. Used both to filter manifest filenames in Drive and to
 * validate `session_id` inside a parsed manifest.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANIFEST_NAME_REGEX = /^[0-9a-f-]{36}_manifest\.json$/i;

/**
 * Parsed manifest shape — mirrors what `manifest.service.ts` emits but
 * declared independently here so a future schema bump cannot drag the
 * reader silently. Only the fields discovery actually consumes are
 * required; everything else is permissive.
 */
interface ParsedManifest {
  session_id: string;
  mode: 'audio' | 'video';
  created_at: string;
  completed_at: string;
  chunk_count: number;
}

function isIsoLike(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10;
}

/**
 * Strict JSON validator for a manifest blob. Returns null on any failure
 * (schema mismatch, missing field, bad type, unknown mode). Never throws.
 *
 * Exposed for unit testing — discovery uses it inline.
 */
export function parseManifest(raw: unknown): ParsedManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;

  if (m.schema !== MANIFEST_SCHEMA) return null;
  if (typeof m.session_id !== 'string' || !UUID_REGEX.test(m.session_id)) {
    return null;
  }
  if (m.mode !== 'audio' && m.mode !== 'video') return null;
  if (!isIsoLike(m.created_at)) return null;
  if (!isIsoLike(m.completed_at)) return null;
  if (typeof m.chunk_count !== 'number' || !Number.isFinite(m.chunk_count) || m.chunk_count < 0) {
    return null;
  }

  return {
    session_id: m.session_id,
    mode: m.mode,
    created_at: m.created_at,
    completed_at: m.completed_at,
    chunk_count: m.chunk_count,
  };
}

/**
 * Derive `protection_status` from manifest data alone (no DB lookup —
 * deferred to a future commit).
 *
 *   chunk_count > 0  → 'complete'   ("Protegido" in UI)
 *   chunk_count === 0 → 'partial'    (manifest exists but no chunks)
 *
 * Note: COMMIT 1's `manifest.service.ts` SKIPS generation when
 * `chunk_count === 0`, so the partial branch is mostly defensive — but a
 * future flow (e.g. a forced regeneration of empty manifests for audit)
 * could produce one, and this keeps the classifier honest.
 *
 * Exposed for unit testing.
 */
export function classifyProtection(chunkCount: number): 'complete' | 'partial' {
  return chunkCount > 0 ? 'complete' : 'partial';
}

interface DiscoveryCandidate {
  parsed: ParsedManifest;
  manifest_file_id: string;
  modifiedTime: string;
}

/**
 * Pure dedup-and-sort helper. Given a flat list of (parsed manifest,
 * drive file_id, modifiedTime) tuples, returns one entry per session_id
 * (the most recently modified wins) sorted by `completed_at` descending
 * — newest sessions appear first in the recovery list, which is what the
 * user expects.
 *
 * Exposed for unit testing.
 */
export function dedupAndSort(
  candidates: DiscoveryCandidate[],
): RecoverableSession[] {
  const bySession = new Map<string, DiscoveryCandidate>();
  for (const cand of candidates) {
    const existing = bySession.get(cand.parsed.session_id);
    if (!existing) {
      bySession.set(cand.parsed.session_id, cand);
      continue;
    }
    // Most recent modifiedTime wins. Falls back to lexicographic compare
    // (ISO timestamps sort correctly that way).
    if (cand.modifiedTime > existing.modifiedTime) {
      bySession.set(cand.parsed.session_id, cand);
    }
  }

  const out: RecoverableSession[] = [];
  for (const cand of bySession.values()) {
    out.push({
      session_id: cand.parsed.session_id,
      mode: cand.parsed.mode,
      created_at: cand.parsed.created_at,
      completed_at: cand.parsed.completed_at,
      chunk_count: cand.parsed.chunk_count,
      protection_status: classifyProtection(cand.parsed.chunk_count),
      manifest_file_id: cand.manifest_file_id,
    });
  }

  // Newest completed_at first. Falls back to lexicographic on ISO strings.
  out.sort((a, b) => (a.completed_at < b.completed_at ? 1 : a.completed_at > b.completed_at ? -1 : 0));
  return out;
}

/**
 * Main discovery entry point used by the route handler. Never throws —
 * any failure beyond the Drive-not-connected gate is logged and folded
 * into an empty manifest list, so the UI always renders a deterministic
 * state.
 */
export async function listDriveManifests(
  userId: string,
): Promise<DiscoveryResult> {
  let dest;
  try {
    dest = await getDestinationWithSecretForUser(userId, 'drive');
  } catch (err) {
    logger.warn(
      {
        op: 'recovery.discover',
        userId,
        reason: 'destination_lookup_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'GC_DISCOVERY_FAILED',
    );
    return { drive_not_connected: true, manifests: [] };
  }

  if (!dest || dest.status !== 'connected' || !dest.refresh_token) {
    logger.info(
      {
        op: 'recovery.discover',
        userId,
        reason: dest ? `drive_status_${dest.status}` : 'no_drive_destination',
      },
      'GC_DISCOVERY_DRIVE_NOT_CONNECTED',
    );
    return { drive_not_connected: true, manifests: [] };
  }

  const refreshToken = dest.refresh_token;
  const folderId = dest.folder_id;
  if (!folderId) {
    // No folder_id persisted → the user has never uploaded a chunk on
    // this connection. Treat as "nothing to discover" rather than an
    // error. We do NOT call `ensureRootFolder` here: discovery should
    // never create folders.
    logger.info(
      { op: 'recovery.discover', userId, reason: 'no_folder_id' },
      'GC_DISCOVERY_EMPTY',
    );
    return { drive_not_connected: false, manifests: [] };
  }

  // List + download manifests with a single `withDriveRetry` envelope so
  // a 401 mid-flight retries once with a fresh token. Any other failure
  // is logged and the empty list is returned.
  let candidates: DiscoveryCandidate[];
  try {
    candidates = await withDriveRetry(refreshToken, async (accessToken) => {
      const files = await listFilesInFolder(accessToken, folderId, {
        nameContains: '_manifest.json',
        pageSize: 100,
        maxPages: 10,
      });

      // Regex-tighten on top of the substring match Drive supports. A
      // file called `something_manifest.json_old` would match the
      // substring filter but is not a valid manifest of ours.
      const validNames = files.filter((f) => MANIFEST_NAME_REGEX.test(f.name));

      const out: DiscoveryCandidate[] = [];
      for (const f of validNames) {
        let bytes: Buffer;
        try {
          bytes = await downloadFile(accessToken, f.id);
        } catch (err) {
          logger.warn(
            {
              op: 'recovery.discover',
              userId,
              manifest_file_id: f.id,
              manifest_name: f.name,
              reason: 'download_failed',
              err: err instanceof Error ? err.message : String(err),
            },
            'GC_DISCOVERY_MANIFEST_SKIPPED',
          );
          continue;
        }

        let json: unknown;
        try {
          json = JSON.parse(bytes.toString('utf8'));
        } catch (err) {
          logger.warn(
            {
              op: 'recovery.discover',
              userId,
              manifest_file_id: f.id,
              manifest_name: f.name,
              reason: 'invalid_json',
              err: err instanceof Error ? err.message : String(err),
            },
            'GC_DISCOVERY_MANIFEST_SKIPPED',
          );
          continue;
        }

        const parsed = parseManifest(json);
        if (!parsed) {
          logger.warn(
            {
              op: 'recovery.discover',
              userId,
              manifest_file_id: f.id,
              manifest_name: f.name,
              reason: 'schema_invalid_or_unknown',
            },
            'GC_DISCOVERY_MANIFEST_SKIPPED',
          );
          continue;
        }

        out.push({
          parsed,
          manifest_file_id: f.id,
          modifiedTime: f.modifiedTime,
        });
      }

      return out;
    });
  } catch (err) {
    logger.warn(
      {
        op: 'recovery.discover',
        userId,
        reason: 'drive_list_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'GC_DISCOVERY_FAILED',
    );
    return { drive_not_connected: false, manifests: [] };
  }

  const manifests = dedupAndSort(candidates);

  logger.info(
    {
      op: 'recovery.discover',
      userId,
      raw: candidates.length,
      deduped: manifests.length,
    },
    'GC_DISCOVERY_OK',
  );

  return { drive_not_connected: false, manifests };
}
