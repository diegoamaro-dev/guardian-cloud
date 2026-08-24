/**
 * D3 · LOCAL SEGMENT SALVAGE — an offline exit for stranded native video.
 *
 * GC-AUTH-SESSION-RECOVERY-001 leaves a device whose Supabase session was
 * destroyed with evidence it can neither upload nor export: `client_auth`
 * pauses the drain, and `src/api/export.ts` is a DOWNLOAD path that needs
 * a token. The session detail screen already offers a local fallback —
 * but only for audio/legacy, whose queue entry carries `uri: cacheUri`.
 * The native segmented video branch writes `uri: ''`, so
 * `findLocalRecordingUri` returns null and that capture has no exit.
 *
 * This module is that exit, and nothing more. It does NOT recover the
 * identity, does NOT resume ownership, and does NOT restore uploading.
 * `GC-AUTH-SESSION-RECOVERY-001` stays OPEN.
 *
 * ── What it produces ────────────────────────────────────────────────
 * The ORIGINAL MP4 segments, in `chunk_index` order, hash-verified at
 * the DESTINATION, copied out of the app sandbox into a folder the user
 * picks:
 *
 *     segment_000000.mp4, …, guardian-export-manifest.json
 *
 * Each segment is an independent, playable MP4. They are NOT
 * concatenated: byte-joining independent MP4 containers does not produce
 * a valid MP4. This is a salvage of segments — NOT a reconstructed
 * video, NOT a final `.mp4`, NOT a complete recording. Final `.mp4`
 * export remains NOT IMPLEMENTED.
 *
 * ── Native segmented video ONLY ─────────────────────────────────────
 * Audio chunks also carry `local_uri`, so "has local_uri" is NOT a
 * discriminator. The queue entry's `uri` is: the native segmented branch
 * writes `uri: ''`, audio/legacy writes `uri: cacheUri`. That is exactly
 * the branch difference at the two `queueAppendNewSession` call sites,
 * and it is why audio already has its own exit.
 *
 * ── Completeness is set equality, never a length comparison ─────────
 * `next_chunk_index` — the chunker's monotonic emission counter — is the
 * SOLE authority on what was emitted. There is deliberately no fallback
 * to `chunks.length`: the array is the set of rows that happen to
 * survive, and using it would let a queue that already dropped a row
 * report `complete` while a segment is plainly absent. A counter that is
 * missing, zero, negative, fractional or implausibly large is a refusal,
 * never a smaller expected set.
 *
 * Duplicate rows make length comparisons actively wrong: with
 * `next_chunk_index = 3` and rows `[0, 0, 2]`, three rows verify into
 * two distinct indexes and index 1 is missing. `complete` therefore
 * requires all of: no missing, no corrupt, and the exported index SET
 * equal to the expected index SET.
 *
 * ── The bytes are verified where they LANDED ────────────────────────
 * Verifying the buffer before writing proves what was sent, not what was
 * stored. A SAF provider that truncates or mangles silently would pass
 * that check. So every segment is read back FROM the destination URI and
 * re-hashed there, and only then counted as written. The manifest's
 * sha256 values describe persisted bytes.
 *
 * ── The manifest is verified where it LANDED too ────────────────────
 * An in-memory round-trip proves nothing about the file. The manifest is
 * written, read back from SAF, parsed, and compared to the manifest that
 * was emitted — every semantic field, and every array POSITION BY
 * POSITION, with no sorting, no normalising and no `Set`. A file merely
 * NAMED `guardian-export-manifest.json` accredits nothing, and neither
 * does one whose arrays happen to contain the right members.
 *
 * ── Destinations are distinct, and re-checked at the end ────────────
 * `createFile` is not a reliable source of distinct URIs. Every
 * destination is required to be non-empty and previously unseen, and the
 * manifest's URI must differ from all of them. Even so, a per-segment
 * read-back only proves what was there at that instant, so ALL segment
 * destinations are read and re-hashed once more immediately before the
 * manifest is created. Nothing is certified that was not just seen.
 *
 * ── Race with cleanup: tolerated, never fought ──────────────────────
 * The upload worker and the cleanup runner are left completely free. If
 * cleanup deletes a segment mid-flight the read or the hash fails and
 * the export is not successful. Cleanup only removes bytes it has
 * already confirmed off-device, so losing that race means the segment is
 * safe in the cloud.
 *
 * ── Strict read-only over Guardian Cloud state ──────────────────────
 * Reads the persisted queue through the same side-channel
 * `localEvidence.ts` uses — `AsyncStorage.getItem` on a duplicated key
 * literal, never the queue helpers. Zero writes to Guardian Cloud state,
 * never deletes or modifies a source segment, never touches identity,
 * marker or seal, and makes no network call of any kind.
 *
 * ── Nothing here may reject ─────────────────────────────────────────
 * Every entry point resolves. A rejected promise would strand the screen
 * on "Preparando…", which is the one outcome a survival path may not
 * produce.
 *
 * ── Memory ──────────────────────────────────────────────────────────
 * `expo-file-system` has NO native copy path into a SAF destination —
 * every branch of the native `copyAsync` calls `toUri.toFile()` on the
 * destination. Bytes therefore travel through JS as base64. This module
 * holds one segment at a time (plus its read-back) and releases it
 * before the next, so peak usage is bounded by the largest single
 * segment, not by the session.
 */

import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Mirrored on purpose — same rule and same reason as `localEvidence.ts`:
 * "do not modify GC_QUEUE", so we read its persisted shape without
 * importing anything that could write it.
 */
const PENDING_RETRY_KEY = 'test.pending_retry';

/** Folder name written into the user's chosen tree. Unmistakably ours. */
export const EXPORT_DIR_PREFIX = 'guardian-cloud-segments';

/** Written LAST, and only accepted once read back and validated. */
export const MANIFEST_NAME = 'guardian-export-manifest.json';

/** The explicit completion marker. Presence of the file is not enough. */
export const MANIFEST_COMPLETION_KEY = 'export_completed';

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Upper bound on the emission counter, derived from the recorder's own
 * configuration rather than picked for looking safe:
 * `NATIVE_SEGMENT_OPTIONS` caps a session at `sessionMs: 3_600_000` with
 * `rotationIntervalMs: 6_000`, i.e. 600 segments by design. This allows
 * two orders of magnitude of headroom and still refuses a counter that
 * would allocate an absurd array — a corrupt `next_chunk_index` must be
 * an explicit refusal, never a `RangeError` or an OOM.
 */
export const MAX_EXPECTED_SEGMENTS = 60_000;

export type LocalSegmentStatus = 'complete' | 'partial' | 'failed';

/** Why a plan or an export could not proceed. Never a silent null. */
export type LocalSegmentRejection =
  | 'no_queue'
  | 'no_entry'
  | 'recording_active'
  | 'not_segmented_video'
  | 'bad_emission_counter'
  | 'inconsistent_queue'
  | 'no_segments'
  | 'busy';

export interface LocalSegmentSource {
  chunk_index: number;
  hash: string;
  size: number;
  local_uri: string;
}

export interface LocalSegmentPlan {
  session_id: string;
  expected_indexes: number[];
  usable: LocalSegmentSource[];
  /** Expected, but no readable local file. */
  missing_indexes: number[];
  /** Present locally but failed size or hash, or an unusable row. */
  corrupt_indexes: number[];
  status: LocalSegmentStatus;
}

export interface LocalSegmentExportResult {
  status: LocalSegmentStatus;
  directory_uri: string | null;
  written_indexes: number[];
  missing_indexes: number[];
  corrupt_indexes: number[];
  /** True ONLY when the manifest was read back from SAF and validated. */
  manifest_written: boolean;
  error?: string;
}

/**
 * The whole outside world this module is allowed to touch. Injected so a
 * test can drive it with no native modules — and so the surface is small
 * enough to confirm at a glance that nothing can reach the network.
 */
export interface LocalSegmentDeps {
  readQueueRaw: () => Promise<string | null>;
  fileInfo: (uri: string) => Promise<{ exists: boolean; size?: number | undefined }>;
  readBase64: (uri: string) => Promise<string>;
  requestDirectory: () => Promise<string | null>;
  makeDirectory: (parentUri: string, name: string) => Promise<string>;
  createFile: (parentUri: string, name: string, mime: string) => Promise<string>;
  writeBase64: (uri: string, base64: string) => Promise<void>;
  writeText: (uri: string, text: string) => Promise<void>;
  /** Read a DESTINATION (SAF) uri back as base64. Proves what landed. */
  readBackBase64: (uri: string) => Promise<string>;
  /** Read a DESTINATION (SAF) uri back as text. Proves what landed. */
  readBackText: (uri: string) => Promise<string>;
  now: () => number;
}

/**
 * `atob` is global in Hermes on Expo SDK 50+. Same local helper idiom as
 * `src/api/destinations.ts` and `src/video/segmentAdopter.ts`.
 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesDigestToHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesDigestToHex(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  );
}

/** `segment_000000.mp4` — lexical order matches numeric order. */
export function segmentFileName(chunkIndex: number): string {
  return `segment_${String(chunkIndex).padStart(6, '0')}.mp4`;
}

/**
 * Verifies base64 against a recorded size and digest. Returns false
 * rather than throwing on undecodable input, so corruption is a verdict
 * and never an exception.
 */
async function verifiesAs(b64: string, size: number, hash: string): Promise<boolean> {
  try {
    const bytes = base64ToBytes(b64);
    if (bytes.length !== size) return false;
    return (await sha256Hex(bytes)) === hash;
  } catch {
    return false;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Exact validation of an index array read back from the destination.
 *
 * Set comparison is not enough here and was the hole this replaces: a
 * `Set` silently collapses `[0, 0, 1]` into `{0, 1}`, so a manifest
 * claiming a segment twice would validate against a plan that wrote it
 * once. This checks the array as an array — every element a safe
 * non-negative integer, no repeats, exact length, exact content — so
 * cardinality is part of the verdict rather than discarded before it.
 */
function exactIndexArray(v: unknown, expected: readonly number[]): boolean {
  if (!Array.isArray(v)) return false;
  if (v.length !== expected.length) return false;
  const seen = new Set<number>();
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) return false;
    if (seen.has(x)) return false;
    seen.add(x);
  }
  for (const e of expected) if (!seen.has(e)) return false;
  return true;
}

/**
 * ── Validating the PERSISTED manifest is a different question ───────
 *
 * `exactIndexArray` answers "same elements, same cardinality", and that
 * is the right question for the completeness verdict, where the two
 * arrays are built independently and their order carries no meaning.
 *
 * It is the WRONG question for the manifest read back from SAF. That
 * file is not an independently derived opinion about the export: it is
 * supposed to BE the bytes this run just wrote. A provider that
 * persisted `[2, 1, 0]` where `[0, 1, 2]` was emitted, or that reordered
 * `segments`, returned something other than what was handed to it —
 * which is precisely the failure mode the read-back exists to catch, and
 * a membership check waves it straight through.
 *
 * So the persisted object is compared POSITIONALLY, against the manifest
 * that was emitted, with no normalisation, no sorting and no `Set`
 * anywhere in the path.
 */
function samePositionalIndexes(v: unknown, emitted: readonly number[]): boolean {
  if (!Array.isArray(v)) return false;
  if (v.length !== emitted.length) return false;
  for (let i = 0; i < emitted.length; i++) {
    if (v[i] !== emitted[i]) return false;
  }
  return true;
}

/** One entry of the manifest's `segments` array. */
interface ManifestSegment {
  chunk_index: number;
  file: string;
  size: number;
  sha256: string;
}

/**
 * Same rule for `segments`: same length, same position, and every field
 * identical to the entry that was emitted for that position. A manifest
 * that lists the right indexes but a wrong hash, size or filename — or
 * the right entries in a different order — is describing a different
 * artifact than the one on disk.
 */
function samePositionalSegments(
  v: unknown,
  emitted: readonly ManifestSegment[],
): boolean {
  if (!Array.isArray(v)) return false;
  if (v.length !== emitted.length) return false;
  for (let i = 0; i < emitted.length; i++) {
    const raw = v[i];
    if (!raw || typeof raw !== 'object') return false;
    const o = raw as Record<string, unknown>;
    const e = emitted[i]!;
    if (o.chunk_index !== e.chunk_index) return false;
    if (o.file !== e.file) return false;
    if (o.size !== e.size) return false;
    if (o.sha256 !== e.sha256) return false;
  }
  return true;
}

export const defaultLocalSegmentDeps: LocalSegmentDeps = {
  readQueueRaw: () => AsyncStorage.getItem(PENDING_RETRY_KEY),
  fileInfo: async (
    uri: string,
  ): Promise<{ exists: boolean; size?: number | undefined }> => {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists
      ? { exists: true, size: (info as { size?: number }).size }
      : { exists: false };
  },
  readBase64: (uri: string) =>
    FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    }),
  requestDirectory: async () => {
    const p =
      await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    return p.granted ? p.directoryUri : null;
  },
  makeDirectory: (parentUri, name) =>
    FileSystem.StorageAccessFramework.makeDirectoryAsync(parentUri, name),
  createFile: (parentUri, name, mime) =>
    FileSystem.StorageAccessFramework.createFileAsync(parentUri, name, mime),
  writeBase64: (uri, base64) =>
    FileSystem.StorageAccessFramework.writeAsStringAsync(uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    }),
  writeText: (uri, text) =>
    FileSystem.StorageAccessFramework.writeAsStringAsync(uri, text, {
      encoding: FileSystem.EncodingType.UTF8,
    }),
  readBackBase64: (uri: string) =>
    FileSystem.StorageAccessFramework.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    }),
  readBackText: (uri: string) =>
    FileSystem.StorageAccessFramework.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    }),
  now: () => Date.now(),
};

interface RawChunk {
  chunk_index?: unknown;
  hash?: unknown;
  size?: unknown;
  local_uri?: unknown;
}

/**
 * Build the plan: what the chunker says it emitted, what survives on
 * disk, and what verifies. Read-only throughout, and never rejects.
 */
export async function planLocalSegmentExport(
  sessionId: string,
  deps: LocalSegmentDeps = defaultLocalSegmentDeps,
): Promise<LocalSegmentPlan | { rejected: LocalSegmentRejection }> {
  let raw: string | null;
  try {
    raw = await deps.readQueueRaw();
  } catch {
    return { rejected: 'no_queue' };
  }
  if (!raw) return { rejected: 'no_queue' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rejected: 'no_queue' };
  }
  if (!Array.isArray(parsed)) return { rejected: 'no_queue' };

  // A durable session has exactly one queue authority. Multiple entries
  // for the same session are a structural contradiction even when they
  // are byte-identical: choosing one, merging them, or preferring the
  // largest counter would manufacture an authority that GC_QUEUE does
  // not actually have.
  const matchingEntries = parsed.filter(
    e =>
      e &&
      typeof e === 'object' &&
      (e as { session_id?: unknown }).session_id === sessionId,
  );
  if (matchingEntries.length === 0) return { rejected: 'no_entry' };
  if (matchingEntries.length > 1) return { rejected: 'inconsistent_queue' };
  const entry = matchingEntries[0] as {
    uri?: unknown;
    recording_closed?: unknown;
    next_chunk_index?: unknown;
    chunks?: unknown;
  };

  if (entry.recording_closed !== true) return { rejected: 'recording_active' };
  // Native segmented video only — see the docblock. Audio/legacy chunks
  // also carry `local_uri`, so this, not the presence of chunk files, is
  // what stops audio bytes being written out as `.mp4`.
  if (entry.uri !== '') return { rejected: 'not_segmented_video' };

  // The emission counter is the sole authority. No fallback: a counter
  // we cannot trust cannot yield a trustworthy expected set, and a
  // smaller set would silently manufacture a `complete`.
  const counter = entry.next_chunk_index;
  if (
    typeof counter !== 'number' ||
    !Number.isSafeInteger(counter) ||
    counter <= 0 ||
    counter > MAX_EXPECTED_SEGMENTS
  ) {
    return { rejected: 'bad_emission_counter' };
  }
  const expected_indexes = Array.from({ length: counter }, (_, i) => i);
  const expectedSet = new Set(expected_indexes);

  const chunks: RawChunk[] = Array.isArray(entry.chunks)
    ? (entry.chunks as RawChunk[])
    : [];

  /**
   * A structurally inconsistent queue forbids `complete` — and here it
   * forbids everything, which is the stronger and simpler answer.
   *
   * Silently skipping a bad row was the hole this replaces: a row whose
   * index sat outside the emission range, or was fractional, or
   * contradicted another row for the same index, used to be dropped on
   * the floor. The remaining rows could then satisfy set equality and
   * produce a `complete` verdict over a queue nobody should trust.
   *
   * A duplicate is tolerated ONLY when it is provably the same row —
   * same index, same `local_uri`, same `size`, same `hash`. Anything
   * else is a contradiction about which bytes belong at that index, and
   * picking one is guessing.
   */
  const byIndex = new Map<number, LocalSegmentSource>();
  /**
   * One file may back exactly one index. Two indexes pointing at the
   * same `local_uri` would export the same bytes twice under different
   * names and certify both — a queue that says that is contradicting
   * itself about what was recorded, and neither reading is safe to
   * pick.
   */
  const uriOwner = new Map<string, number>();
  const corrupt = new Set<number>();
  for (const c of chunks) {
    const idx = c?.chunk_index;
    if (
      typeof idx !== 'number' ||
      !Number.isSafeInteger(idx) ||
      idx < 0 ||
      !expectedSet.has(idx)
    ) {
      return { rejected: 'inconsistent_queue' };
    }

    // `size > 0`, not `>= 0`. A row declaring an empty segment is not a
    // segment: the sha256 of zero bytes is a perfectly valid digest, so
    // the hash check would wave it through and a session of empty files
    // could be certified `complete`. Emptiness has to be refused here or
    // nowhere.
    const shapeOk =
      typeof c.local_uri === 'string' &&
      c.local_uri.length > 0 &&
      typeof c.hash === 'string' &&
      c.hash.length > 0 &&
      typeof c.size === 'number' &&
      Number.isSafeInteger(c.size) &&
      c.size > 0;

    const prev = byIndex.get(idx);
    if (prev) {
      // Two rows for one index. Identical is a harmless duplicate;
      // anything else is a contradiction, not a preference.
      if (
        !shapeOk ||
        prev.local_uri !== c.local_uri ||
        prev.size !== c.size ||
        prev.hash !== c.hash
      ) {
        return { rejected: 'inconsistent_queue' };
      }
      continue;
    }
    if (corrupt.has(idx)) {
      // A second row for an index whose first row was unusable: the two
      // cannot be compared, so this is a contradiction too.
      return { rejected: 'inconsistent_queue' };
    }
    if (!shapeOk) {
      corrupt.add(idx);
      continue;
    }

    // One physical file backs exactly one index. Reaching here means
    // this index is not in `byIndex` yet, so an existing owner is
    // necessarily a DIFFERENT index: the queue is asserting that the
    // same bytes are two distinct segments. Exporting that would write
    // one file twice under two names and certify both as recorded
    // material, so there is no safe reading to pick.
    const uri = c.local_uri as string;
    if (uriOwner.has(uri)) {
      return { rejected: 'inconsistent_queue' };
    }
    uriOwner.set(uri, idx);

    byIndex.set(idx, {
      chunk_index: idx,
      hash: c.hash as string,
      size: c.size as number,
      local_uri: uri,
    });
  }

  const usable: LocalSegmentSource[] = [];
  // One segment in memory at a time; released before the next.
  for (const cand of [...byIndex.values()].sort(
    (a, b) => a.chunk_index - b.chunk_index,
  )) {
    let info: { exists: boolean; size?: number | undefined };
    try {
      info = await deps.fileInfo(cand.local_uri);
    } catch {
      corrupt.add(cand.chunk_index);
      continue;
    }
    if (!info.exists) continue; // missing, not corrupt
    if (typeof info.size === 'number' && info.size !== cand.size) {
      corrupt.add(cand.chunk_index);
      continue;
    }
    let ok = false;
    try {
      ok = await verifiesAs(await deps.readBase64(cand.local_uri), cand.size, cand.hash);
    } catch {
      ok = false;
    }
    if (ok) usable.push(cand);
    else corrupt.add(cand.chunk_index);
  }

  const usableSet = new Set(usable.map(u => u.chunk_index));
  const corrupt_indexes = [...corrupt].sort((a, b) => a - b);
  const missing_indexes = expected_indexes.filter(
    i => !usableSet.has(i) && !corrupt.has(i),
  );

  // Set equality, never a length comparison.
  const status: LocalSegmentStatus =
    usable.length === 0
      ? 'failed'
      : missing_indexes.length === 0 &&
          corrupt_indexes.length === 0 &&
          exactIndexArray([...usableSet], expected_indexes)
        ? 'complete'
        : 'partial';

  return {
    session_id: sessionId,
    expected_indexes,
    usable,
    missing_indexes,
    corrupt_indexes,
    status,
  };
}

/**
 * Single-flight. A second tap while an export is running is refused
 * rather than starting a parallel run that would race for the same SAF
 * tree and produce two half-written folders.
 */
let exportInFlight = false;

/** Test seam. Never called by product code. */
export function __resetLocalSegmentLockForTests(): void {
  exportInFlight = false;
}

export function isLocalSegmentExportRunning(): boolean {
  return exportInFlight;
}

/**
 * Copy the verified segments into a folder the user picks, verifying
 * each one AT THE DESTINATION before counting it.
 *
 * The plan's `status` is the ceiling: this can only lower it, never
 * raise it. Never rejects — every failure is a result.
 */
export async function exportLocalSegments(
  plan: LocalSegmentPlan,
  deps: LocalSegmentDeps = defaultLocalSegmentDeps,
): Promise<LocalSegmentExportResult> {
  const base: Omit<LocalSegmentExportResult, 'status'> = {
    directory_uri: null,
    written_indexes: [],
    missing_indexes: plan.missing_indexes,
    corrupt_indexes: plan.corrupt_indexes,
    manifest_written: false,
  };

  if (plan.status === 'failed' || plan.usable.length === 0) {
    return { ...base, status: 'failed', error: 'no_usable_segments' };
  }
  if (exportInFlight) {
    return { ...base, status: 'failed', error: 'busy' };
  }
  exportInFlight = true;

  try {
    let tree: string | null;
    try {
      tree = await deps.requestDirectory();
    } catch (err) {
      return { ...base, status: 'failed', error: `permission_error: ${msg(err)}` };
    }
    if (!tree) return { ...base, status: 'failed', error: 'permission_denied' };

    let dir: string;
    try {
      dir = await deps.makeDirectory(
        tree,
        `${EXPORT_DIR_PREFIX}-${plan.session_id.slice(0, 8)}-${deps.now()}`,
      );
    } catch (err) {
      return { ...base, status: 'failed', error: `mkdir_failed: ${msg(err)}` };
    }

    const written_indexes: number[] = [];
    /**
     * Every destination URI handed back by `createFile`, so far.
     *
     * `createFile` is NOT a reliable source of distinct URIs. A provider
     * that returns the same document for two different names — or that
     * hands back the segment's URI again when asked for the manifest —
     * would have the second write silently clobber the first, and the
     * per-segment read-back would still pass because it runs before the
     * clobbering happens. Identity has to be asserted here.
     */
    const segmentDestinationUris = new Set<string>();
    /** Source paired with where it landed, for the final re-check. */
    const persisted: { source: LocalSegmentSource; target: string }[] = [];
    const fail = (why: string): LocalSegmentExportResult => ({
      ...base,
      status: 'failed',
      directory_uri: dir,
      written_indexes: [...written_indexes],
      error: why,
    });

    for (const seg of plan.usable) {
      let b64: string;
      try {
        b64 = await deps.readBase64(seg.local_uri);
      } catch (err) {
        return fail(`read_failed_at_index_${seg.chunk_index}: ${msg(err)}`);
      }
      if (!(await verifiesAs(b64, seg.size, seg.hash))) {
        return fail(`source_verify_failed_at_index_${seg.chunk_index}`);
      }

      let target: string;
      try {
        target = await deps.createFile(
          dir,
          segmentFileName(seg.chunk_index),
          'video/mp4',
        );
      } catch (err) {
        return fail(`create_failed_at_index_${seg.chunk_index}: ${msg(err)}`);
      }
      if (typeof target !== 'string' || target.length === 0) {
        return fail(`empty_destination_uri_at_index_${seg.chunk_index}`);
      }
      if (segmentDestinationUris.has(target)) {
        return fail(`duplicate_destination_uri_at_index_${seg.chunk_index}`);
      }
      segmentDestinationUris.add(target);

      try {
        await deps.writeBase64(target, b64);
      } catch (err) {
        return fail(`copy_failed_at_index_${seg.chunk_index}: ${msg(err)}`);
      }

      // What landed, not what was sent. A provider that truncates or
      // mangles silently is caught precisely here and nowhere else.
      let back: string;
      try {
        back = await deps.readBackBase64(target);
      } catch (err) {
        return fail(`readback_failed_at_index_${seg.chunk_index}: ${msg(err)}`);
      }
      if (!(await verifiesAs(back, seg.size, seg.hash))) {
        return fail(`destination_verify_failed_at_index_${seg.chunk_index}`);
      }

      written_indexes.push(seg.chunk_index);
      persisted.push({ source: seg, target });
    }

    // Coherence before claiming anything: the indexes verified at the
    // destination must be exactly the ones the plan intended.
    if (!exactIndexArray(written_indexes, plan.usable.map(s => s.chunk_index))) {
      return fail('written_set_mismatch');
    }

    /**
     * The per-segment read-back proves what landed AT THAT MOMENT. It
     * does not prove the file is still there, or still intact, once the
     * rest of the session has been written on top of the same tree.
     *
     * A provider that reused a URI, or that let a later write land on an
     * earlier document, produces exactly this shape: every segment
     * verified when it was written, and an early one wrong by the time
     * the manifest is created. The manifest is about to certify all N
     * segments at once, so all N are re-read and re-hashed here, right
     * before it exists. Nothing is certified that was not just seen.
     */
    for (const { source, target } of persisted) {
      let again: string;
      try {
        again = await deps.readBackBase64(target);
      } catch (err) {
        return fail(
          `final_readback_failed_at_index_${source.chunk_index}: ${msg(err)}`,
        );
      }
      if (!(await verifiesAs(again, source.size, source.hash))) {
        return fail(`final_verify_failed_at_index_${source.chunk_index}`);
      }
    }

    const manifest = {
      schema_version: MANIFEST_SCHEMA_VERSION,
      artifact: 'guardian-cloud-local-segment-salvage',
      note:
        'Independent MP4 segments recovered from device storage. NOT a ' +
        'reconstructed video and NOT a final .mp4 export.',
      [MANIFEST_COMPLETION_KEY]: true,
      session_id: plan.session_id,
      status: plan.status,
      exported_at: new Date(deps.now()).toISOString(),
      expected_indexes: plan.expected_indexes,
      written_indexes,
      missing_indexes: plan.missing_indexes,
      corrupt_indexes: plan.corrupt_indexes,
      // Built from what was persisted and re-verified, not from what was
      // planned, so the certificate describes the destination.
      segments: persisted.map(({ source }): ManifestSegment => ({
        chunk_index: source.chunk_index,
        file: segmentFileName(source.chunk_index),
        size: source.size,
        sha256: source.hash,
      })),
    };

    let text: string;
    try {
      text = JSON.stringify(manifest, null, 2);
    } catch (err) {
      return fail(`manifest_serialise_failed: ${msg(err)}`);
    }

    let manifestUri: string;
    try {
      manifestUri = await deps.createFile(dir, MANIFEST_NAME, 'application/json');
    } catch (err) {
      return fail(`manifest_create_failed: ${msg(err)}`);
    }
    if (typeof manifestUri !== 'string' || manifestUri.length === 0) {
      return fail('empty_manifest_uri');
    }
    // Writing the manifest over a segment would destroy the very bytes
    // it is about to certify, and the certificate would still read as
    // valid. The one URI that may not collide is this one.
    if (segmentDestinationUris.has(manifestUri)) {
      return fail('manifest_uri_collides_with_segment');
    }

    try {
      await deps.writeText(manifestUri, text);
    } catch (err) {
      return fail(`manifest_write_failed: ${msg(err)}`);
    }

    // The manifest accredits completion only once it has been read back
    // from the destination and validated. A file that merely carries the
    // right name proves nothing, and a write that resolved while
    // persisting truncated bytes must fail here.
    let backText: string;
    try {
      backText = await deps.readBackText(manifestUri);
    } catch (err) {
      return fail(`manifest_readback_failed: ${msg(err)}`);
    }
    // The provider must have persisted exactly the text it was handed.
    // Parsing first would normalise whitespace, object-key order, extra
    // fields and duplicate keys into a merely plausible object.
    if (backText !== text) {
      return fail('manifest_persisted_incoherent');
    }
    let round: unknown;
    try {
      round = JSON.parse(backText);
    } catch {
      return fail('manifest_persisted_unparseable');
    }
    if (round === null || typeof round !== 'object' || Array.isArray(round)) {
      return fail('manifest_persisted_incoherent');
    }
    const persistedManifest = round as Record<string, unknown>;
    // Identity with the emitted manifest, field by field and position by
    // position — every semantic field, not just the ones that look
    // load-bearing. `artifact`, `note` and `exported_at` are what tell a
    // reader months later what this folder is and is NOT; a provider
    // that altered them persisted a different document, and this file is
    // the only accreditation the export has.
    //
    // Nothing here normalises, sorts or builds a `Set`: a membership
    // check would accept reordered arrays or reordered `segments`, which
    // is exactly what "the provider did not store what we handed it"
    // looks like.
    if (
      persistedManifest.schema_version !== manifest.schema_version ||
      persistedManifest[MANIFEST_COMPLETION_KEY] !==
        manifest[MANIFEST_COMPLETION_KEY] ||
      persistedManifest.artifact !== manifest.artifact ||
      persistedManifest.note !== manifest.note ||
      persistedManifest.exported_at !== manifest.exported_at ||
      persistedManifest.session_id !== manifest.session_id ||
      persistedManifest.status !== manifest.status ||
      !samePositionalIndexes(
        persistedManifest.expected_indexes,
        manifest.expected_indexes,
      ) ||
      !samePositionalIndexes(
        persistedManifest.written_indexes,
        manifest.written_indexes,
      ) ||
      !samePositionalIndexes(
        persistedManifest.missing_indexes,
        manifest.missing_indexes,
      ) ||
      !samePositionalIndexes(
        persistedManifest.corrupt_indexes,
        manifest.corrupt_indexes,
      ) ||
      !samePositionalSegments(persistedManifest.segments, manifest.segments)
    ) {
      return fail('manifest_persisted_incoherent');
    }

    return {
      status: plan.status,
      directory_uri: dir,
      written_indexes,
      missing_indexes: plan.missing_indexes,
      corrupt_indexes: plan.corrupt_indexes,
      manifest_written: true,
    };
  } finally {
    exportInFlight = false;
  }
}
