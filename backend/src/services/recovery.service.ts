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

import { AppError } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';
import { getDestinationWithSecretForUser } from './destinations.service.js';
import {
  downloadFile,
  ensureRootFolder,
  findFileByName,
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
  /**
   * G3'' — optional because it is now DERIVED, not restated.
   *
   * v1 manifests state it; v2 manifests have it computed from their
   * chunks. It is absent only when a v2 session's chunks disagree, and
   * on this listing the medium drives nothing but an icon. Dropping the
   * session instead would hide evidence whose bytes exist, which is the
   * one outcome that must never happen here. The hard refusal lives in
   * `getManifestByFileId`, where a wrong medium would name a false
   * artifact rather than draw the wrong glyph.
   *
   * No observable change today: every session holds one producer, so
   * the value is always derivable and always present.
   */
  mode?: 'audio' | 'video';
  created_at: string;
  /**
   * Completion timestamp. ISO string for fully-completed sessions
   * (manifest written at /complete). `null` for partial manifests
   * (written during recording). Mobile UIs may render the "Parcial —
   * sesión interrumpida" copy when this is null.
   */
  completed_at: string | null;
  chunk_count: number;
  /**
   * Status of the recoverable session. 'partial' when the manifest was
   * written during recording (is_partial === true OR completed_at ===
   * null). 'complete' when /complete fired the final manifest.
   * Pre-incremental manifests are treated as 'complete' (chunk_count >
   * 0), preserving backward compatibility.
   */
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

const MANIFEST_SCHEMA_V1 = 'guardian-cloud.manifest.v1';
const MANIFEST_SCHEMA_V2 = 'guardian-cloud.manifest.v2';

/**
 * G3II - which contract a manifest document declares.
 *
 * v1 states one `mode` for the whole session and says nothing per chunk.
 * That was accurate while a session could only ever hold one producer,
 * and it stays accurate for every v1 document ever written: no client
 * able to mix media in one session has existed. So v1 is parsed
 * READ-ONLY and its `mode` is PROPAGATED to each chunk.
 *
 * v2 carries no session-level medium at all. Each chunk declares its
 * own, and nothing may infer it from the session.
 */
function manifestVersion(schema: unknown): 1 | 2 | null {
  if (schema === MANIFEST_SCHEMA_V1) return 1;
  if (schema === MANIFEST_SCHEMA_V2) return 2;
  return null;
}

/**
 * G3'' — the single medium of a chunk list, or `undefined` when there
 * isn't one.
 *
 * `undefined` covers three distinct situations on purpose, because all
 * three mean the same thing to a caller: no medium may be attributed to
 * the session as a whole. The list is empty, a chunk fails to declare
 * one, or the chunks disagree.
 *
 * Never falls back to `session.mode`. That is the whole point.
 */
function deriveHomogeneousMedia(
  rawChunks: unknown,
): 'audio' | 'video' | undefined {
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) return undefined;
  let seen: 'audio' | 'video' | undefined;
  for (const c of rawChunks) {
    if (!c || typeof c !== 'object') return undefined;
    const media = (c as Record<string, unknown>).media;
    if (media !== 'audio' && media !== 'video') return undefined;
    if (seen === undefined) seen = media;
    else if (seen !== media) return undefined;
  }
  return seen;
}
/**
 * Strict UUID v4-ish guard — the same shape Supabase issues for
 * `sessions.id`. Used both to filter manifest filenames in Drive and to
 * validate `session_id` inside a parsed manifest.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANIFEST_NAME_REGEX = /^[0-9a-f-]{36}_manifest\.json$/i;
/**
 * Deterministic chunk filename pattern. Must match the formula written
 * by `manifest.service.ts:chunkFileName` and `destinations.routes.ts`
 * (upload proxy). Used to defensively validate `file_name` fields inside
 * a manifest before trusting them as Drive lookup keys.
 */
const CHUNK_FILE_NAME_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[0-9]{6}_[0-9a-f]{12}\.chunk$/i;
/**
 * Hex sha256 guard (lowercase, 64 chars). Same shape `chunks.service.ts`
 * enforces server-side on upload, so any manifest with a hash outside
 * this shape is structurally invalid.
 */
const HEX_SHA256_REGEX = /^[a-f0-9]{64}$/i;

/**
 * Parsed manifest shape — mirrors what `manifest.service.ts` emits but
 * declared independently here so a future schema bump cannot drag the
 * reader silently. Only the fields discovery actually consumes are
 * required; everything else is permissive.
 *
 * `completed_at` is `string | null`: null indicates a partial manifest
 * written during recording, before /complete fires. The classifier
 * below uses (`is_partial === true` OR `completed_at === null`) to
 * surface the recovery list's "parcial" badge. Old manifests written
 * before the incremental path existed always carry an ISO string in
 * `completed_at`, so backward compatibility is total.
 *
 * `is_partial`, `manifest_seq`, `last_updated_at` are NEW optional
 * fields. Missing values are valid and indicate a pre-incremental
 * manifest (treated as complete by `classifyProtection`).
 */
interface ParsedManifest {
  session_id: string;
  /**
   * G3'' — v1 states it at session level; v2 has it derived from the
   * chunks. `undefined` when v2 chunks disagree or fail to declare one:
   * the session still lists, it just carries no medium.
   */
  mode?: 'audio' | 'video';
  created_at: string;
  completed_at: string | null;
  chunk_count: number;
  is_partial?: boolean;
  manifest_seq?: number;
  last_updated_at?: string;
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

  const version = manifestVersion(m.schema);
  if (version === null) return null;
  if (typeof m.session_id !== 'string' || !UUID_REGEX.test(m.session_id)) {
    return null;
  }
  // G3'' — the medium of a DISCOVERY row is cosmetic: it drives an icon.
  //
  // v1 states it at session level and it is authoritative there.
  // v2 does not state it at all, so it is DERIVED from the chunks — and
  // when the chunks disagree it is simply left undefined. Refusing to
  // parse would drop the session from the listing, and a session whose
  // bytes exist must stay discoverable. The hard refusal belongs where a
  // wrong answer would produce a false ARTIFACT, not a wrong icon: see
  // `getManifestByFileId`.
  let mode: 'audio' | 'video' | undefined;
  if (version === 1) {
    if (m.mode !== 'audio' && m.mode !== 'video') return null;
    mode = m.mode;
  } else {
    mode = deriveHomogeneousMedia(m.chunks);
  }
  if (!isIsoLike(m.created_at)) return null;
  // completed_at: either an ISO-like string (complete manifest) or null
  // (partial manifest written during recording). Anything else rejects.
  if (m.completed_at !== null && !isIsoLike(m.completed_at)) return null;
  if (typeof m.chunk_count !== 'number' || !Number.isFinite(m.chunk_count) || m.chunk_count < 0) {
    return null;
  }

  // Optional new fields. Permissive: only validate shape if present.
  // Missing fields are treated as undefined and classify as complete.
  let isPartial: boolean | undefined;
  if (m.is_partial !== undefined) {
    if (typeof m.is_partial !== 'boolean') return null;
    isPartial = m.is_partial;
  }
  let manifestSeq: number | undefined;
  if (m.manifest_seq !== undefined) {
    if (
      typeof m.manifest_seq !== 'number' ||
      !Number.isFinite(m.manifest_seq) ||
      m.manifest_seq < 0
    ) {
      return null;
    }
    manifestSeq = m.manifest_seq;
  }
  let lastUpdatedAt: string | undefined;
  if (m.last_updated_at !== undefined) {
    if (!isIsoLike(m.last_updated_at)) return null;
    lastUpdatedAt = m.last_updated_at;
  }

  const parsed: ParsedManifest = {
    session_id: m.session_id,
    ...(mode !== undefined ? { mode } : {}),
    created_at: m.created_at,
    completed_at: m.completed_at as string | null,
    chunk_count: m.chunk_count,
  };
  if (isPartial !== undefined) parsed.is_partial = isPartial;
  if (manifestSeq !== undefined) parsed.manifest_seq = manifestSeq;
  if (lastUpdatedAt !== undefined) parsed.last_updated_at = lastUpdatedAt;
  return parsed;
}

/**
 * Derive `protection_status` from manifest data alone (no DB lookup —
 * deferred to a future commit).
 *
 *   is_partial === true OR completed_at === null → 'partial'
 *     ("Parcial" badge in UI; session was interrupted mid-recording)
 *   chunk_count === 0                            → 'partial'
 *     (defensive: a manifest with no chunks would be useless to recover)
 *   otherwise                                    → 'complete'
 *     ("Protegido" badge in UI; session reached /complete server-side)
 *
 * Backward compatibility: pre-incremental manifests carry an ISO
 * `completed_at` and no `is_partial` field. They land in the `otherwise`
 * branch and classify as 'complete' — identical to the previous
 * `chunkCount > 0 ? 'complete' : 'partial'` behaviour.
 *
 * Exposed for unit testing.
 */
export function classifyProtection(
  parsed: Pick<ParsedManifest, 'chunk_count' | 'is_partial' | 'completed_at'>,
): 'complete' | 'partial' {
  if (parsed.is_partial === true) return 'partial';
  if (parsed.completed_at === null) return 'partial';
  if (parsed.chunk_count === 0) return 'partial';
  return 'complete';
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
      ...(cand.parsed.mode !== undefined ? { mode: cand.parsed.mode } : {}),
      created_at: cand.parsed.created_at,
      completed_at: cand.parsed.completed_at,
      chunk_count: cand.parsed.chunk_count,
      protection_status: classifyProtection(cand.parsed),
      manifest_file_id: cand.manifest_file_id,
    });
  }

  // Newest first. For complete manifests the natural key is
  // `completed_at`; for partial manifests it is null, so fall back to
  // `last_updated_at` if present (incremental writes set it on every
  // update) and finally to `created_at`. ISO strings sort lexically.
  function sortKey(s: RecoverableSession): string {
    if (s.completed_at) return s.completed_at;
    // last_updated_at is not on RecoverableSession to keep the surface
    // small; reach back into the candidate map for it.
    const lastUpdated = bySession.get(s.session_id)?.parsed.last_updated_at;
    if (lastUpdated) return lastUpdated;
    return s.created_at;
  }
  out.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka < kb) return 1;
    if (ka > kb) return -1;
    return 0;
  });
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

// ===========================================================================
// COMMIT 3 — manifest-driven export support
// ===========================================================================
//
// `parseManifest` above is a discovery-only validator: it intentionally
// ignores the `chunks` array because the recovery LIST endpoint never
// surfaces chunk-level data to the UI. COMMIT 3 needs the chunks too —
// the mobile recovery exporter walks them in `chunk_index` order, asks
// the backend for each chunk's bytes, verifies sha256, concatenates,
// and writes a file.
//
// To avoid coupling the discovery code path to chunk validation we add
// a SECOND validator (`parseManifestFull`) and TWO new entry points
// (`getManifestByFileId`, `downloadManifestChunk`). The route layer
// owns HTTP-shaped errors via AppError; the service throws those when
// it cannot satisfy the caller. This is the ONLY place in recovery.*
// that throws — `listDriveManifests` above remains never-throwing per
// COMMIT 2 contract.

export interface ManifestChunkRef {
  chunk_index: number;
  hash: string;
  size: number;
  file_name: string;
  /**
   * G3'' — medium of THIS chunk. Always resolved: v2 declares it per
   * chunk, v1 propagates the session `mode`. Never absent, so no
   * consumer has to guess.
   */
  media: 'audio' | 'video';
}

export interface FullManifest {
  manifest_file_id: string;
  session_id: string;
  /**
   * G3'' — DERIVED from the chunks, never restated from the session.
   * `undefined` only when the chunks disagree, a response
   * `getManifestByFileId` refuses to serve.
   */
  mode?: 'audio' | 'video';
  created_at: string;
  /**
   * Completion timestamp. Same semantics as `ParsedManifest.completed_at`:
   * ISO string for complete manifests, `null` for partial manifests
   * written during recording. Recovery export consumers should treat
   * a partial manifest as a best-effort longest-prefix export — the
   * mobile `exportFromChunkRefs` already handles this case identically
   * to a "stopped at gap" complete export.
   */
  completed_at: string | null;
  chunk_count: number;
  chunks: ManifestChunkRef[];
  is_partial?: boolean;
  manifest_seq?: number;
  last_updated_at?: string;
}

/**
 * Strict JSON validator for the FULL manifest blob, including the
 * `chunks` array. Same rejection semantics as `parseManifest`: returns
 * null on ANY shape problem and never throws.
 *
 * Differences from `parseManifest`:
 *   - validates `chunks` is an array of `{chunk_index, hash, size,
 *     file_name}` each passing the same shape checks the upload proxy
 *     enforces server-side
 *   - cross-checks `chunks.length === chunk_count` (manifest builder
 *     guarantees this, so a divergence is a tampering signal)
 *   - cross-checks every chunk's `file_name` starts with the same
 *     `session_id` prefix as the manifest claims (defense against a
 *     manifest pointing at chunks of a different session)
 *
 * Exposed for unit testing.
 */
export function parseManifestFull(
  raw: unknown,
  manifestFileId: string,
): FullManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;

  const version = manifestVersion(m.schema);
  if (version === null) return null;
  if (typeof m.session_id !== 'string' || !UUID_REGEX.test(m.session_id)) {
    return null;
  }
  // G3'' — v1 states one medium for the session; it is authoritative
  // there and is PROPAGATED to every chunk below, because a v1 document
  // can only describe a session with a single producer. v2 states none:
  // each chunk carries its own and the parser demands it.
  let v1Mode: 'audio' | 'video' | undefined;
  if (version === 1) {
    if (m.mode !== 'audio' && m.mode !== 'video') return null;
    v1Mode = m.mode;
  }
  if (typeof m.created_at !== 'string' || m.created_at.length < 10) return null;
  // completed_at: ISO-like string for complete manifests, `null` for
  // partial manifests written during recording. Any other shape rejects.
  if (
    m.completed_at !== null &&
    (typeof m.completed_at !== 'string' || m.completed_at.length < 10)
  ) {
    return null;
  }
  if (
    typeof m.chunk_count !== 'number' ||
    !Number.isFinite(m.chunk_count) ||
    m.chunk_count < 0
  ) {
    return null;
  }
  if (!Array.isArray(m.chunks)) return null;

  // Optional new fields. Validate shape only if present.
  let isPartial: boolean | undefined;
  if (m.is_partial !== undefined) {
    if (typeof m.is_partial !== 'boolean') return null;
    isPartial = m.is_partial;
  }
  let manifestSeq: number | undefined;
  if (m.manifest_seq !== undefined) {
    if (
      typeof m.manifest_seq !== 'number' ||
      !Number.isFinite(m.manifest_seq) ||
      m.manifest_seq < 0
    ) {
      return null;
    }
    manifestSeq = m.manifest_seq;
  }
  let lastUpdatedAt: string | undefined;
  if (m.last_updated_at !== undefined) {
    if (typeof m.last_updated_at !== 'string' || m.last_updated_at.length < 10) {
      return null;
    }
    lastUpdatedAt = m.last_updated_at;
  }

  // Strict chunks validation. We do NOT accept any chunk that fails the
  // shape check — a partial parse would hide tampering. The session_id
  // prefix check defends against a manifest pointing at chunks of a
  // different session by name reuse (file_name starts with the
  // session_id UUID by construction in `manifest.service.ts`).
  const sessionId = m.session_id;
  const chunks: ManifestChunkRef[] = [];
  const seenIndexes = new Set<number>();
  for (const c of m.chunks) {
    if (!c || typeof c !== 'object') return null;
    const cc = c as Record<string, unknown>;
    if (
      typeof cc.chunk_index !== 'number' ||
      !Number.isInteger(cc.chunk_index) ||
      cc.chunk_index < 0
    ) {
      return null;
    }
    if (typeof cc.hash !== 'string' || !HEX_SHA256_REGEX.test(cc.hash)) {
      return null;
    }
    if (
      typeof cc.size !== 'number' ||
      !Number.isInteger(cc.size) ||
      cc.size <= 0
    ) {
      return null;
    }
    if (typeof cc.file_name !== 'string' || !CHUNK_FILE_NAME_REGEX.test(cc.file_name)) {
      return null;
    }
    if (!cc.file_name.startsWith(`${sessionId}_`)) return null;
    if (seenIndexes.has(cc.chunk_index)) return null; // duplicate index
    seenIndexes.add(cc.chunk_index);
    // G3'' — every chunk ends up with a declared medium, one way or the
    // other. v2 demands it in the document; v1 has none, so the session
    // `mode` is propagated. That propagation is sound for v1 and only
    // for v1: such a document cannot describe a session with more than
    // one producer, because no client able to produce one has existed.
    let media: 'audio' | 'video';
    if (version === 2) {
      if (cc.media !== 'audio' && cc.media !== 'video') return null;
      media = cc.media;
    } else {
      media = v1Mode as 'audio' | 'video';
    }
    chunks.push({
      chunk_index: cc.chunk_index,
      hash: cc.hash,
      size: cc.size,
      file_name: cc.file_name,
      media,
    });
  }

  if (chunks.length !== m.chunk_count) return null;

  // Sort ascending so callers (route response, chunk lookup) get a
  // deterministic order regardless of how Drive stored them.
  chunks.sort((a, b) => a.chunk_index - b.chunk_index);

  // G3'' — the response still carries a session-level `mode`, but it is
  // now DERIVED from the chunks rather than restated from the session.
  // Homogeneous chunks yield one; heterogeneous yield none, and
  // `getManifestByFileId` refuses to serve that case rather than
  // omitting a field whose absence a consumer would silently read as
  // "not video" and use to name a false artifact.
  const derived = deriveHomogeneousMedia(chunks);
  const out: FullManifest = {
    manifest_file_id: manifestFileId,
    session_id: sessionId,
    ...(derived !== undefined ? { mode: derived } : {}),
    created_at: m.created_at,
    completed_at: m.completed_at as string | null,
    chunk_count: m.chunk_count,
    chunks,
  };
  if (isPartial !== undefined) out.is_partial = isPartial;
  if (manifestSeq !== undefined) out.manifest_seq = manifestSeq;
  if (lastUpdatedAt !== undefined) out.last_updated_at = lastUpdatedAt;
  return out;
}

/**
 * Resolve the user's Drive destination + refresh token, or throw an
 * AppError the route layer can translate. Shared by `getManifestByFileId`
 * and `downloadManifestChunk`.
 *
 * Distinct from `listDriveManifests` which folds the same failure modes
 * into an in-band `drive_not_connected: true` payload — COMMIT 2 wanted
 * that for the LIST screen, COMMIT 3 wants explicit errors so the
 * detail screen can show "Esta evidencia ya no está disponible" rather
 * than silently rendering an empty state.
 */
async function resolveDriveContext(
  userId: string,
): Promise<{ refreshToken: string; folderId: string | null }> {
  const dest = await getDestinationWithSecretForUser(userId, 'drive');
  if (!dest || dest.status !== 'connected' || !dest.refresh_token) {
    throw new AppError(
      503,
      'DRIVE_NOT_CONNECTED',
      'No connected Google Drive destination for this user',
    );
  }
  return { refreshToken: dest.refresh_token, folderId: dest.folder_id };
}

/**
 * Download a manifest from Drive, validate it with `parseManifestFull`,
 * and return the structured projection. Throws:
 *   - 503 DRIVE_NOT_CONNECTED
 *   - 404 MANIFEST_NOT_FOUND     (Drive deleted the file)
 *   - 404 MANIFEST_INVALID       (schema check failed / corrupt JSON)
 *   - propagates withDriveRetry's underlying error otherwise
 *
 * Used by both new endpoints; the chunk download endpoint calls this
 * (re-validating each time) instead of trusting an open-ended cache —
 * keep the code simple, optimise if a real load profile demands it.
 */
export async function getManifestByFileId(
  userId: string,
  manifestFileId: string,
): Promise<FullManifest> {
  const { refreshToken } = await resolveDriveContext(userId);

  let manifest: FullManifest | null = null;
  try {
    manifest = await withDriveRetry(refreshToken, async (accessToken) => {
      let bytes: Buffer;
      try {
        bytes = await downloadFile(accessToken, manifestFileId);
      } catch (err) {
        if (err instanceof AppError && err.code === 'DRIVE_FILE_NOT_FOUND') {
          throw new AppError(
            404,
            'MANIFEST_NOT_FOUND',
            'Manifest file no longer exists in Drive',
          );
        }
        throw err;
      }

      let json: unknown;
      try {
        json = JSON.parse(bytes.toString('utf8'));
      } catch (err) {
        logger.warn(
          {
            op: 'recovery.manifest_fetch',
            userId,
            manifest_file_id: manifestFileId,
            reason: 'invalid_json',
            err: err instanceof Error ? err.message : String(err),
          },
          'GC_RECOVERY_MANIFEST_INVALID',
        );
        throw new AppError(
          404,
          'MANIFEST_INVALID',
          'Manifest file is not valid JSON',
        );
      }

      const parsed = parseManifestFull(json, manifestFileId);
      if (!parsed) {
        logger.warn(
          {
            op: 'recovery.manifest_fetch',
            userId,
            manifest_file_id: manifestFileId,
            reason: 'schema_invalid_or_unknown',
          },
          'GC_RECOVERY_MANIFEST_INVALID',
        );
        throw new AppError(
          404,
          'MANIFEST_INVALID',
          'Manifest schema check failed',
        );
      }

      // G3'' — FAIL CLOSED on heterogeneous evidence.
      //
      // `parseManifestFull` leaves `mode` undefined when the chunks do
      // not share one medium. Serving that response would be worse than
      // an error: the client reads `mode !== 'video'`, falls through to
      // its byte-sniffing branch, finds an `ftyp` box at the head of the
      // first MP4 segment and names the concatenation `.m4a` — a false
      // artifact produced silently from true bytes.
      //
      // Refusing instead surfaces a typed failure the client already
      // handles (`classifyManifestFailure` → `manifest_failure`). The
      // bytes stay in Drive and the session stays discoverable; only the
      // single-file export is withheld, which is precisely the operation
      // that cannot be performed honestly.
      //
      // Unreachable while no producer can mix media in one session. It
      // exists so that the day one can, the failure is loud.
      if (parsed.mode === undefined) {
        logger.warn(
          {
            op: 'recovery.manifest_fetch',
            userId,
            manifest_file_id: manifestFileId,
            session_id: parsed.session_id,
            reason: 'heterogeneous_media',
          },
          'GC_RECOVERY_MANIFEST_HETEROGENEOUS',
        );
        throw new AppError(
          409,
          'MANIFEST_HETEROGENEOUS',
          'Session holds evidence of more than one medium and cannot be exported as a single file',
        );
      }

      return parsed;
    });
  } catch (err) {
    // AppError percolates up unchanged — the route handler translates
    // it to the proper HTTP response. Anything else is wrapped so we
    // never leak Drive internals.
    if (err instanceof AppError) throw err;
    logger.warn(
      {
        op: 'recovery.manifest_fetch',
        userId,
        manifest_file_id: manifestFileId,
        err: err instanceof Error ? err.message : String(err),
      },
      'GC_RECOVERY_MANIFEST_FETCH_FAILED',
    );
    throw new AppError(
      502,
      'DRIVE_API_FAILED',
      'Failed to read manifest from Drive',
    );
  }

  logger.info(
    {
      op: 'recovery.manifest_fetch',
      userId,
      manifest_file_id: manifestFileId,
      session_id: manifest.session_id,
      chunk_count: manifest.chunk_count,
    },
    'GC_RECOVERY_MANIFEST_OK',
  );
  return manifest;
}

/**
 * Result of `downloadManifestChunk` — raw bytes plus the chunk's
 * canonical hash so the route can stream both back to the client. The
 * client recomputes the sha256 over the bytes and compares against
 * `hash`; the hash itself is sourced from the manifest, which the user
 * already owns.
 */
export interface ManifestChunkBytes {
  bytes: Buffer;
  hash: string;
  size: number;
}

/**
 * Download a single chunk of a manifest from Drive. Composition:
 *
 *   1. Re-resolve Drive destination (auth)
 *   2. `getManifestByFileId` re-validates the manifest end-to-end
 *      (cheap; the file is small JSON)
 *   3. Look up `chunks[i]` by chunk_index
 *   4. Resolve the chunk's `file_name` to a Drive file_id via
 *      `findFileByName` against the user's GuardianCloud folder
 *   5. `downloadFile` returns the bytes
 *   6. Return bytes + hash for the route to stream
 *
 * Throws:
 *   - 503 DRIVE_NOT_CONNECTED         (auth gate)
 *   - 404 MANIFEST_NOT_FOUND          (manifest gone)
 *   - 404 MANIFEST_INVALID            (schema check failed)
 *   - 404 CHUNK_INDEX_NOT_IN_MANIFEST (i out of range)
 *   - 404 CHUNK_FILE_NOT_FOUND        (chunk file gone from Drive)
 *   - 502 DRIVE_API_FAILED            (anything else from Drive)
 *
 * The N+1 pattern (one manifest fetch per chunk download) mirrors the
 * existing `/sessions/:id/chunks/:idx/download` endpoint (which does a
 * `listChunksForSession` per call). Same cost profile as the export
 * path the mobile client already tolerates.
 */
export async function downloadManifestChunk(
  userId: string,
  manifestFileId: string,
  chunkIndex: number,
): Promise<ManifestChunkBytes> {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new AppError(400, 'INVALID_CHUNK_INDEX', 'Invalid chunk index');
  }

  // Re-validate the manifest. `getManifestByFileId` covers
  // DRIVE_NOT_CONNECTED / MANIFEST_NOT_FOUND / MANIFEST_INVALID and
  // the route handler turns those into proper HTTP errors.
  const manifest = await getManifestByFileId(userId, manifestFileId);

  const target = manifest.chunks.find((c) => c.chunk_index === chunkIndex);
  if (!target) {
    throw new AppError(
      404,
      'CHUNK_INDEX_NOT_IN_MANIFEST',
      'Manifest does not list a chunk with this index',
    );
  }

  // Resolve folder + token + lookup-by-name + download in one
  // withDriveRetry envelope. Same pattern as the manifest fetch.
  const { refreshToken, folderId: cachedFolderId } =
    await resolveDriveContext(userId);

  try {
    const bytes = await withDriveRetry(refreshToken, async (accessToken) => {
      // Self-heal: if `destinations.folder_id` is missing we resolve via
      // `ensureRootFolder` rather than failing. We do NOT persist here —
      // the chunk upload path owns that responsibility.
      const folderId =
        cachedFolderId ?? (await ensureRootFolder(accessToken));

      const driveFileId = await findFileByName(
        accessToken,
        folderId,
        target.file_name,
      );
      if (!driveFileId) {
        throw new AppError(
          404,
          'CHUNK_FILE_NOT_FOUND',
          'Chunk file referenced by the manifest is no longer in Drive',
        );
      }
      return await downloadFile(accessToken, driveFileId);
    });

    logger.info(
      {
        op: 'recovery.chunk_download',
        userId,
        manifest_file_id: manifestFileId,
        session_id: manifest.session_id,
        chunk_index: chunkIndex,
        size: bytes.length,
      },
      'GC_RECOVERY_CHUNK_OK',
    );

    return { bytes, hash: target.hash, size: target.size };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn(
      {
        op: 'recovery.chunk_download',
        userId,
        manifest_file_id: manifestFileId,
        session_id: manifest.session_id,
        chunk_index: chunkIndex,
        err: err instanceof Error ? err.message : String(err),
      },
      'GC_RECOVERY_CHUNK_FAILED',
    );
    throw new AppError(
      502,
      'DRIVE_API_FAILED',
      'Failed to download chunk from Drive',
    );
  }
}
