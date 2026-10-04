/**
 * EXPORT-MP4 · REMUX — the client half of the single-`.mp4` export.
 *
 * Two responsibilities, deliberately separated:
 *
 *   1. [decideAssembly] — WHICH assembly a session needs. Pure, no I/O.
 *   2. [remuxPartsToMp4] — staging the verified segments as files and handing
 *      them to the native remuxer, which copies compressed samples into one
 *      container without re-encoding.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * `src/api/export.ts` concatenates the downloaded chunks byte by byte. For
 * audio that is CORRECT: those chunks are byte ranges of one recording, and
 * joining them restores the original file.
 *
 * Native segmented video breaks that premise. Each of its chunks is a COMPLETE
 * MP4 with its own `ftyp`, `moov` and `mdat`, so the same operation yields a
 * file a player reads only to the first `moov`. Measured on a real export on
 * 2026-10-04: 3,18 s reachable out of 25,17 s captured, every byte intact. The
 * artifact looked like the whole recording and was not — which is a false
 * statement on the user's screen, not a cosmetic defect.
 *
 * ── What decides it ─────────────────────────────────────────────────────
 * The per-chunk `media` field (G3''), which the backend already returns.
 * NOT the session mode, NOT the file extension, NOT the UI context. Absence
 * means "not declared" and never "video" — the contract says so explicitly,
 * and the manifest writer already refuses to guess a medium from the session.
 *
 * Inconsistent metadata fails closed. So does an undeclared set whose chunks
 * are visibly independent containers: that combination is the one where
 * concatenating would produce the misleading artifact, and refusing leaves the
 * user with the remote copy and the segment salvage, both intact, instead of a
 * file that lies.
 */

import * as FileSystem from 'expo-file-system/legacy';

import GCSegmentedRecorder from '../../modules/gc-segmented-recorder';

/** The medium of ONE chunk's bytes, as the backend reports it. */
export type ChunkMedium = 'video' | 'audio';

/** What the export path should do with a set of verified chunks. */
export type AssemblyDecision =
  /** Join the bytes. Correct when the chunks are ranges of one file. */
  | { kind: 'concat' }
  /** Rebuild one container from N independent ones. */
  | { kind: 'remux' }
  /** Produce nothing, and say why. */
  | { kind: 'refuse'; reason: AssemblyRefusal };

export type AssemblyRefusal =
  /**
   * The set does not agree on its medium: both media present, or some chunks
   * declared and others not. Assembling it either way would apply one
   * algorithm to bytes that need the other.
   */
  | 'media_inconsistent'
  /**
   * Nothing declares a medium, and the chunks are each a complete container.
   * Concatenating is provably wrong here, and the medium is not declared, so
   * there is nothing to decide from. This is the pre-G3'' video session.
   */
  | 'undeclared_multi_container';

export interface AssemblyInput {
  readonly chunk_index: number;
  readonly media?: ChunkMedium | null;
}

/**
 * True when `part` begins with an MP4 `ftyp` box.
 *
 * Used ONLY to refuse, never to claim a medium: a structural check is not
 * medium metadata and does not stand in for it. The box type sits at offset 4,
 * right after the box size, and the position is checked strictly — an `ftyp`
 * found anywhere else is not a container start.
 */
export function startsWithFtyp(part: Uint8Array): boolean {
  return (
    part.length >= 8 &&
    part[4] === 0x66 &&
    part[5] === 0x74 &&
    part[6] === 0x79 &&
    part[7] === 0x70
  );
}

/**
 * @param chunks the verified prefix, in `chunk_index` order.
 * @param independentContainers whether chunks AFTER the first each begin their
 *   own container. The caller computes it per chunk — not by scanning the
 *   joined bytes, where an `ftyp` could appear inside media data by chance.
 */
export function decideAssembly(
  chunks: readonly AssemblyInput[],
  independentContainers: boolean,
): AssemblyDecision {
  if (chunks.length === 0) return { kind: 'concat' };

  let video = 0;
  let audio = 0;
  let undeclared = 0;
  for (const c of chunks) {
    if (c.media === 'video') video += 1;
    else if (c.media === 'audio') audio += 1;
    else undeclared += 1;
  }

  // Heterogeneous metadata fails closed, including the "some declared, some
  // not" case: a partially declared set is not evidence of one medium.
  const kinds = [video, audio, undeclared].filter((n) => n > 0).length;
  if (kinds > 1) return { kind: 'refuse', reason: 'media_inconsistent' };

  if (video === chunks.length) return { kind: 'remux' };
  if (audio === chunks.length) return { kind: 'concat' };

  // Everything undeclared. Legacy data: keep the historical behaviour, which
  // is correct for the audio sessions that produced it — unless the bytes
  // themselves show it cannot be, and then refuse rather than mislead.
  return independentContainers
    ? { kind: 'refuse', reason: 'undeclared_multi_container' }
    : { kind: 'concat' };
}

// =====================================================================

export interface RemuxReport {
  segments: number;
  durationUs: number;
  videoSamples: number;
  audioSamples: number;
  sizeBytes: number;
  /** How the timeline was rebuilt. Belongs in the manifest, not just a log. */
  method: string;
}

export interface RemuxDeps {
  writePart(path: string, bytes: Uint8Array): Promise<void>;
  makeDir(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  remux(inputPaths: string[], outputPath: string): Promise<RemuxReport>;
  cacheDir: string;
}

/**
 * Encodes bytes as base64 for `writeAsStringAsync`.
 *
 * Chunked because `String.fromCharCode(...bytes)` blows the argument limit on
 * a multi-megabyte array. Mirrors the encoder already used by the export path;
 * it is duplicated rather than exported across modules so this file stays
 * independent of the export path's internals.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const STRIDE = 0x8000;
  for (let i = 0; i < bytes.length; i += STRIDE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STRIDE));
  }
  return global.btoa(binary);
}

export const defaultRemuxDeps: RemuxDeps = {
  /**
   * A getter, not a value: reading `FileSystem.cacheDirectory` at module
   * load would run the moment anything imports the export path, including a
   * test that never remuxes anything. Resolved on use instead.
   */
  get cacheDir(): string {
    return FileSystem.cacheDirectory ?? '';
  },
  async makeDir(path) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  },
  async removeDir(path) {
    await FileSystem.deleteAsync(path, { idempotent: true });
  },
  async writePart(path, bytes) {
    await FileSystem.writeAsStringAsync(path, bytesToBase64(bytes), {
      encoding: FileSystem.EncodingType.Base64,
    });
  },
  async remux(inputPaths, outputPath) {
    return (await GCSegmentedRecorder.remuxSegmentsToMp4(
      inputPaths,
      outputPath,
    )) as RemuxReport;
  },
};

/** A refusal from the native remuxer, or from staging its inputs. */
export class RemuxFailed extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemuxFailed';
  }
}

/**
 * Stages `parts` as files and remuxes them into `outputPath`.
 *
 * ORDER IS THIS FUNCTION'S CONTRACT AND IT CANNOT BE VERIFIED DOWNSTREAM. A
 * segment is rebased to its own origin, so it carries nothing that says where
 * it sat in the session; the native remuxer accepts a shuffled set without
 * complaint and says so in its own docstring. `parts` must therefore already
 * be the contiguous `chunk_index` prefix, in order — which is exactly what the
 * export path hands over, having verified every hash on the way.
 *
 * The staging directory is removed whether the remux succeeds or fails. The
 * output is left only on success: the native side deletes a partial file
 * before raising, so a refusal never leaves something that could be mistaken
 * for a finished export.
 */
export async function remuxPartsToMp4(
  sessionId: string,
  parts: readonly Uint8Array[],
  outputPath: string,
  deps: RemuxDeps = defaultRemuxDeps,
): Promise<RemuxReport> {
  if (parts.length === 0) {
    throw new RemuxFailed('no_parts', 'nothing to assemble');
  }

  const stagingDir = `${deps.cacheDir}remux/${sessionId}/`;
  const paths: string[] = [];

  try {
    await deps.makeDir(stagingDir);
    for (let i = 0; i < parts.length; i += 1) {
      // Zero-padded so the on-disk order is the array order even when read
      // back by something that sorts lexicographically.
      const path = `${stagingDir}seg_${String(i).padStart(6, '0')}.mp4`;
      await deps.writePart(path, parts[i] as Uint8Array);
      paths.push(path);
    }
    return await deps.remux(paths, outputPath);
  } catch (err) {
    if (err instanceof RemuxFailed) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // Expo rejects with a `code` carrying the native reason
    // (`ERR_REMUX_<REASON>`). Read without narrowing to `Error` first: the
    // property is not on that type, and the reason is what makes the refusal
    // actionable instead of generic.
    const raw = (err as { code?: unknown } | null | undefined)?.code;
    throw new RemuxFailed(typeof raw === 'string' ? raw : 'remux_failed', message);
  } finally {
    // Best effort: the staging copies are reproducible from the remote
    // evidence, so failing to delete them must not fail the export.
    try {
      await deps.removeDir(stagingDir);
    } catch {
      // Intentionally swallowed — see above.
    }
  }
}
