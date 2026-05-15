/**
 * Orphan recovery scanner.
 *
 * Read-only sweep of `documentDirectory` for recording files left
 * behind by previous app runs whose corresponding GC_QUEUE entries no
 * longer exist. Such files arise when:
 *
 *   - AsyncStorage is wiped externally (Clear Data, OS data pressure,
 *     uninstall+reinstall) while `documentDirectory` survives,
 *   - the queue entry was reaped (session_completed) but the file
 *     deletion in the reap path failed,
 *   - a future migration accidentally clears the queue without
 *     touching files (defence in depth).
 *
 * Without this scanner the surviving files are INVISIBLE to recovery:
 * the worker only reads GC_QUEUE, the export pipeline only reads
 * GC_QUEUE, and `findLocalRecordingUri` requires a queue entry too. A
 * real evidence-loss incident on 2026-05-15 verified this exact gap
 * (verified .aac of 3,760,704 bytes on disk, queue empty after
 * AsyncStorage was wiped between sessions).
 *
 * Strict isolation contract:
 *   - reads `AsyncStorage.getItem(PENDING_RETRY_KEY)` and
 *     `FileSystem.readDirectoryAsync / getInfoAsync` only — no
 *     `setItem`, no mutation, no recovery action,
 *   - returns metadata + classification; the caller (home screen)
 *     decides whether to surface a banner and what to do on tap,
 *   - does NOT touch backend, worker, chunking, recovery cross-device,
 *     manifests, export, AudioEngine, or backgroundService.
 *
 * Filters (in order):
 *   1. Filename prefix must be `guardian_recording_` (excludes Expo
 *      dev-launcher bundles, expo-router caches, expo-file-system
 *      scratch, etc.).
 *   2. Extension must be `.aac`, `.m4a`, or `.mp4` (case-insensitive);
 *      anything else logs `unknown_extension` via the per-file
 *      `GC_ORPHAN_RECOVERY_SKIPPED` line and is dropped.
 *   3. Size > 0 (skipped as `zero_size` — encoder crashed before any
 *      write).
 *   4. mtime within the last `ORPHAN_MAX_AGE_DAYS` days (skipped as
 *      `too_old` — the user will not recognise an old recording, and
 *      keeping ancient orphans alive forever inflates storage).
 *   5. URI must NOT match any existing queue entry's `uri` (skipped as
 *      `already_queued` — the entry will be drained by the worker via
 *      the normal recovery path).
 *   6. Audio files exceeding `AUDIO_ORPHAN_MAX_BYTES` are RETURNED with
 *      `oversized: true` rather than skipped — the caller surfaces a
 *      separate notice and never attempts recovery on them. The limit
 *      protects against re-tripping Android SQLite CursorWindow on
 *      large audio because the existing audio chunker stores
 *      `base64Slice` inline in AsyncStorage. Re-tripping CursorWindow
 *      is what produced the original 2026-05-15 evidence loss.
 *
 * The scanner logs `GC_ORPHAN_SCAN_START` on entry,
 * `GC_ORPHAN_FOUND` per recoverable candidate, and
 * `GC_ORPHAN_SCAN_DONE` with the aggregate report on exit. Failures
 * during recovery are logged separately by the caller via
 * `GC_ORPHAN_RECOVERY_SKIPPED` / `GC_ORPHAN_RECOVERY_ENQUEUED`.
 */

import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * MUST mirror the literal `PENDING_RETRY_KEY` in `mobile/app/index.tsx`
 * and `mobile/src/recording/localEvidence.ts`. The key is duplicated
 * here on purpose: the rule is "do not modify GC_QUEUE", so this
 * read-only side-channel never imports the queue helpers. Any future
 * change to the literal must update all three sites in lockstep.
 */
const PENDING_RETRY_KEY = 'test.pending_retry';

/**
 * Prefix every Guardian Cloud recording file written by `stopRecording`
 * carries (see `app/index.tsx` line ~4812: `guardian_recording_${Date.now()}${ext}`).
 * The scanner filters by this prefix so Expo dev-launcher bundles,
 * expo-router caches, expo-file-system scratch directories, etc. are
 * never considered as evidence.
 */
export const ORPHAN_FILENAME_PREFIX = 'guardian_recording_';

/**
 * Maximum age (in days) of an orphan file before the scanner ignores it
 * silently. A user who has not recovered evidence in over a week is
 * unlikely to recognise it; keeping ancient orphans visible would also
 * accumulate storage and noise. Files older than this remain on disk
 * but are not surfaced — manual cleanup (Settings or ADB) is the
 * recommended follow-up.
 */
export const ORPHAN_MAX_AGE_DAYS = 7;

/**
 * Hard cap on the size of an audio orphan that the scanner will mark
 * as recoverable. Audio chunks today carry their `base64Slice` inline
 * in the queue JSON; a 5 MB audio file produces ~170 chunks at ~22 KB
 * base64 each, which is roughly the SQLite CursorWindow per-row ceiling
 * (~2 MB on stock Android) once the chunks accumulate before the upload
 * worker drains them. Beyond this size, recovery itself would risk
 * re-tripping the very corruption that produced the orphan to begin
 * with.
 *
 * Files larger than this are NOT discarded — they are returned with
 * `oversized: true` so the banner can mention them. Recovery on
 * oversized files is intentionally NOT attempted; the file stays on
 * disk for a future version that addresses the audio storage path.
 *
 * Exported as a constant so a future tuning pass can adjust the limit
 * without searching for magic numbers.
 */
export const AUDIO_ORPHAN_MAX_BYTES = 5 * 1024 * 1024;

export type OrphanMode = 'audio' | 'video';

export type OrphanFile = {
  /** Filename only — e.g. `guardian_recording_1778857733344.aac`. */
  name: string;
  /** Absolute `file://` URI under `documentDirectory`. */
  uri: string;
  /** Size in bytes from `getInfoAsync`. Strictly > 0. */
  size: number;
  /** Modification time in milliseconds since epoch. */
  mtime_ms: number;
  /** Decimal days since modification (computed against scan time). */
  age_days: number;
  /** Derived from filename extension. */
  mode: OrphanMode;
  /**
   * True iff `mode === 'audio'` and `size > AUDIO_ORPHAN_MAX_BYTES`.
   * Recoverable orphans (`oversized=false`) get full pipeline
   * treatment; oversized orphans surface in the banner but never get
   * chunked. The flag stays on the orphan record (rather than being a
   * separate list) so the caller's logging keeps the file metadata.
   */
  oversized: boolean;
};

export type OrphanScanReport = {
  /** Total files matched by the prefix filter (pre-classification). */
  scanned: number;
  /** Recoverable + oversized — every file surfaced via `GC_ORPHAN_FOUND`. */
  found: number;
  skipped_too_old: number;
  skipped_zero_size: number;
  skipped_already_queued: number;
  skipped_unknown_ext: number;
};

export type OrphanScanResult = {
  /** Files the home screen should offer for recovery via the banner CTA. */
  orphans: OrphanFile[];
  /**
   * Files surfaced in the banner as "too large for this version" but
   * never auto-recovered. Kept separate so the recovery handler cannot
   * accidentally iterate over them.
   */
  oversized: OrphanFile[];
  report: OrphanScanReport;
};

/**
 * Map filename extension to recording mode. Returns null for any
 * extension outside the MVP set; callers log
 * `GC_ORPHAN_RECOVERY_SKIPPED reason: unknown_extension` on null. The
 * comparison is case-insensitive because some Android codecs have been
 * observed emitting capitalised extensions on certain OEMs.
 */
function modeFromExtension(filename: string): OrphanMode | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.aac')) return 'audio';
  if (lower.endsWith('.m4a')) return 'audio';
  if (lower.endsWith('.mp4')) return 'video';
  return null;
}

function ageDays(mtime_ms: number, now_ms: number = Date.now()): number {
  const elapsed_ms = Math.max(0, now_ms - mtime_ms);
  return elapsed_ms / (1000 * 60 * 60 * 24);
}

/**
 * Read all queue entry URIs into a Set for O(1) duplicate lookup.
 *
 * On corruption (CursorWindow trip, parse error, missing key) we
 * deliberately return an empty Set — the alternative is to hide every
 * surviving file behind a queue we cannot read, which is exactly the
 * failure mode this scanner exists to compensate for. If the queue is
 * genuinely empty, the empty Set is also correct.
 *
 * Cost: one `getItem` + JSON parse. Same exposure the legacy
 * `findLocalRecordingUri` helper has, on the same key.
 */
async function readQueueUriSet(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const set = new Set<string>();
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { uri?: unknown }).uri === 'string'
      ) {
        set.add((entry as { uri: string }).uri);
      }
    }
    return set;
  } catch {
    return new Set();
  }
}

/**
 * One-shot scan of `documentDirectory`. Intended to be called once at
 * boot, after the existing queue normalisation runs, before the home
 * screen renders. Idempotent — safe to call multiple times; each call
 * does its own fresh read of files + queue.
 *
 * Returns the classification immediately (no I/O is amortised across
 * calls). Caller is responsible for storing the result in state and
 * driving banner visibility.
 */
export async function scanOrphans(): Promise<OrphanScanResult> {
  console.log('GC_ORPHAN_SCAN_START', { ts: Date.now() });

  const docDir = FileSystem.documentDirectory;
  const report: OrphanScanReport = {
    scanned: 0,
    found: 0,
    skipped_too_old: 0,
    skipped_zero_size: 0,
    skipped_already_queued: 0,
    skipped_unknown_ext: 0,
  };
  const orphans: OrphanFile[] = [];
  const oversized: OrphanFile[] = [];

  if (!docDir) {
    console.log('GC_ORPHAN_SCAN_DONE', {
      ...report,
      err: 'no_documentDirectory',
    });
    return { orphans, oversized, report };
  }

  let entries: string[] = [];
  try {
    entries = await FileSystem.readDirectoryAsync(docDir);
  } catch (err) {
    console.log('GC_ORPHAN_SCAN_DONE', {
      ...report,
      err: err instanceof Error ? err.message : String(err),
    });
    return { orphans, oversized, report };
  }

  const candidates = entries.filter(f => f.startsWith(ORPHAN_FILENAME_PREFIX));
  report.scanned = candidates.length;

  if (candidates.length === 0) {
    console.log('GC_ORPHAN_SCAN_DONE', report);
    return { orphans, oversized, report };
  }

  const queuedUris = await readQueueUriSet();
  const now_ms = Date.now();

  for (const name of candidates) {
    const uri = docDir + name;

    // Extension dispatch — drops anything outside `.aac` / `.m4a` /
    // `.mp4` immediately, before any I/O on the file itself. Cheap.
    const mode = modeFromExtension(name);
    if (!mode) {
      report.skipped_unknown_ext += 1;
      console.log('GC_ORPHAN_RECOVERY_SKIPPED', {
        uri,
        reason: 'unknown_extension',
      });
      continue;
    }

    let info: FileSystem.FileInfo;
    try {
      info = await FileSystem.getInfoAsync(uri);
    } catch {
      // A stat failure is treated as a transient race (file vanished
      // between readDir and getInfo, or permissions hiccup). Counted as
      // zero-size for the report so the operator can correlate against
      // unexpected I/O failures.
      report.skipped_zero_size += 1;
      continue;
    }
    if (!info.exists) {
      continue;
    }
    const size = (info as { size?: number }).size ?? 0;
    if (size === 0) {
      report.skipped_zero_size += 1;
      continue;
    }

    // expo-file-system reports `modificationTime` as seconds-since-epoch
    // (Unix timestamp). Convert to ms for consistency with `Date.now()`
    // and with the `age_days` math. Fallback to "now" only when the
    // field is missing (some legacy expo versions); a missing mtime
    // means age_days ≈ 0 and the file is treated as fresh, which is
    // the safer side of the filter.
    const mtime_ms =
      typeof (info as { modificationTime?: number }).modificationTime ===
      'number'
        ? (info as { modificationTime: number }).modificationTime * 1000
        : now_ms;
    const age_days = ageDays(mtime_ms, now_ms);
    if (age_days > ORPHAN_MAX_AGE_DAYS) {
      report.skipped_too_old += 1;
      continue;
    }

    if (queuedUris.has(uri)) {
      report.skipped_already_queued += 1;
      continue;
    }

    const isOversized =
      mode === 'audio' && size > AUDIO_ORPHAN_MAX_BYTES;
    const orphan: OrphanFile = {
      name,
      uri,
      size,
      mtime_ms,
      age_days,
      mode,
      oversized: isOversized,
    };

    console.log('GC_ORPHAN_FOUND', {
      uri,
      size,
      mtime_ms,
      mode,
      age_days: Number(age_days.toFixed(2)),
      oversized: isOversized,
    });

    if (isOversized) {
      oversized.push(orphan);
    } else {
      orphans.push(orphan);
    }
    report.found += 1;
  }

  console.log('GC_ORPHAN_SCAN_DONE', report);
  return { orphans, oversized, report };
}

/**
 * Human-friendly Spanish age string for an orphan file's modification
 * time. Drives the banner copy — the user spec said "no IDs, no
 * filenames, no URIs, no hashes, no sizes". Date is the only honest,
 * recognisable signal: "sí, esa era mía".
 *
 *   < 1 minute     → "hace un momento"
 *   < 60 min       → "hace N minutos"
 *   < 24 h         → "hace N horas"
 *   1 day          → "ayer"
 *   < 7 d          → "hace N días"
 *   else           → "hace más de una semana"   (caller typically
 *                    filters these out via ORPHAN_MAX_AGE_DAYS so this
 *                    branch is a defensive default rather than a
 *                    rendered case)
 *
 * `now_ms` parameter is injected for deterministic testing; production
 * callers pass nothing and get `Date.now()`.
 */
export function formatAgeHuman(
  mtime_ms: number,
  now_ms: number = Date.now(),
): string {
  const elapsed = Math.max(0, now_ms - mtime_ms);
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) {
    return `hace ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  }
  if (hours < 24) {
    return `hace ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  }
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return 'hace más de una semana';
}
