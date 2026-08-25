/**
 * D3 · LOCAL SEGMENT SALVAGE — the offline exit for stranded native video.
 *
 * `GC-AUTH-SESSION-RECOVERY-001` strands a device whose Supabase session
 * was destroyed: `client_auth` pauses the drain and `src/api/export.ts`
 * is a DOWNLOAD path that needs a token. Audio already has a local exit
 * (`localEvidence.findLocalRecordingUri`). Native segmented video does
 * not: its queue entry carries `uri: ''`, so that lookup returns null
 * and the capture has no route off the device at all.
 *
 * These tests drive `localAssembly.ts` through an injected dependency
 * surface — no native modules, no filesystem, no network reachable even
 * in principle. The final block asserts the same properties against the
 * source text, because "this module never calls the backend" is a claim
 * about what the file may CONTAIN, not about what one run happened to
 * do.
 *
 * Two properties get most of the attention here, because both were
 * wrong in earlier versions and neither is visible from a happy path:
 *
 *   · completeness is SET EQUALITY against the chunker's emission
 *     counter, never a length comparison and never the surviving rows;
 *   · integrity is verified where the bytes LANDED, not where they were
 *     sent from — a provider that truncates silently must be caught.
 *
 * Not a reconstructed video, not a final `.mp4`, not a complete
 * recording. Final `.mp4` export stays NOT IMPLEMENTED and
 * `GC-AUTH-SESSION-RECOVERY-001` stays OPEN.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_alg: string, bytes: Uint8Array) => {
    const h = createHash('sha256').update(Buffer.from(bytes)).digest();
    return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
  },
}));

vi.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: vi.fn(),
    makeDirectoryAsync: vi.fn(),
    createFileAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
    readAsStringAsync: vi.fn(),
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() },
}));

import {
  planLocalSegmentExport,
  exportLocalSegments,
  segmentFileName,
  isLocalSegmentExportRunning,
  __resetLocalSegmentLockForTests,
  MANIFEST_NAME,
  MANIFEST_COMPLETION_KEY,
  MANIFEST_SCHEMA_VERSION,
  MAX_EXPECTED_SEGMENTS,
  EXPORT_DIR_PREFIX,
  type LocalSegmentDeps,
  type LocalSegmentPlan,
} from '../src/recording/localAssembly';

const HERE = dirname(fileURLToPath(import.meta.url));
const SID = 'eb6c456b-7156-48e2-b232-79795d6e9c5f';

function segment(index: number, len = 8) {
  const bytes = new Uint8Array(len).map((_, i) => (index * 31 + i) % 251);
  return {
    bytes,
    hash: createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
    b64: Buffer.from(bytes).toString('base64'),
  };
}

interface World {
  files: Map<string, string>;
  written: Map<string, string>;
  createdNames: string[];
  deps: LocalSegmentDeps;
  queueBefore: string;
}

function makeWorld(
  opts: {
    recordingClosed?: boolean;
    /** rows present in `chunks[]`, may contain duplicates */
    rows?: number[];
    /** the emission counter; `undefined` omits the field entirely */
    nextChunkIndex?: number | undefined;
    omitCounter?: boolean;
    absent?: number[];
    badHash?: number[];
    badSize?: number[];
    vanishOnCopy?: number[];
    mutateOnCopy?: number[];
    /** destination read-back returns different bytes than were written */
    corruptOnReadBack?: number[];
    manifestWriteThrows?: boolean;
    /** destination holds truncated JSON although the write resolved */
    manifestTruncated?: boolean;
    manifestReadBackThrows?: boolean;
    /** mutate the manifest object just before it is persisted */
    tamperManifest?: ((m: Record<string, unknown>) => void) | undefined;
    /** transform the exact manifest text after write resolves */
    transformManifestText?: ((text: string) => string) | undefined;
    /** rows declaring `size: 0` with the genuine sha256 of zero bytes */
    emptyRows?: number[];
    /** G3' — per-index `media` value. A missing key means metadata absent. */
    media?: Record<number, unknown>;
    /** G3' — per-index override of the declared `local_uri`. */
    uriOverride?: Record<number, string>;
    /** these indexes all declare the FIRST listed index's `local_uri` */
    sharedUri?: number[];
    /** rows whose `local_uri` is the empty string */
    emptyUriRows?: number[];
    /** `createFile` hands back one single URI for every segment name */
    collideSegmentUris?: boolean;
    /** `createFile` hands back segment 0's URI when asked for the manifest */
    manifestUriCollides?: boolean;
    /** `createFile` hands back an empty string for this kind of file */
    emptyCreate?: 'segment' | 'manifest';
    /** destination verified on write, then clobbered before the manifest */
    clobberBeforeManifest?: number[];
    /** append a second row for this index, byte-identical */
    dupIdentical?: number;
    dupWithDifferentHash?: number;
    dupWithDifferentUri?: number;
    dupWithDifferentSize?: number;
    entryUri?: string;
    noEntry?: boolean;
    noQueue?: boolean;
    queueThrows?: boolean;
    infoThrows?: boolean;
    safThrows?: 'request' | 'mkdir' | 'create' | 'write' | null;
  } = {},
): World {
  const rows = opts.rows ?? [0, 1, 2];
  const files = new Map<string, string>();
  const sizes = new Map<string, number>();
  // G3' — the fixtures now model the REAL adopter layout,
  // `<docDir>segments/<sid>/segment_NNNNNN.mp4`. The previous synthetic
  // shape (`chunks/<sid>/seg0.mp4`) is one production never emits, and
  // D3 now refuses it on purpose: the path IS the signature that a chunk
  // is a native segment.
  const uriOf = (i: number) =>
    `file:///docs/segments/${SID}/segment_${String(i).padStart(6, '0')}.mp4`;

  const chunks = rows.map(i => {
    // `segment(i, 0)` is a genuinely empty file with the genuine sha256
    // of zero bytes — self-consistent in every field except usefulness.
    const s = opts.emptyRows?.includes(i) ? segment(i, 0) : segment(i);
    // A row may deliberately point at another index's file, or at none.
    const declaredUri = opts.emptyUriRows?.includes(i)
      ? ''
      : opts.uriOverride?.[i] !== undefined
        ? (opts.uriOverride[i] as string)
        : opts.sharedUri?.includes(i)
          ? uriOf(opts.sharedUri[0]!)
          : uriOf(i);
    if (!opts.absent?.includes(i)) {
      files.set(uriOf(i), s.b64);
      sizes.set(uriOf(i), s.bytes.length);
    }
    const row: Record<string, unknown> = {
      chunk_index: i,
      hash: opts.badHash?.includes(i) ? 'f'.repeat(64) : s.hash,
      size: opts.badSize?.includes(i) ? s.bytes.length + 7 : s.bytes.length,
      status: 'pending',
      attempts: 0,
      local_uri: declaredUri,
    };
    // G3' — the key is set ONLY when the fixture asks for it, so "absent"
    // means a genuinely missing key and never an explicit `undefined`.
    if (opts.media && i in opts.media) row.media = opts.media[i];
    return row;
  });

  const dupOf = (i: number, over: Partial<Record<string, unknown>>) => {
    const s = segment(i);
    return {
      chunk_index: i,
      hash: s.hash,
      size: s.bytes.length,
      status: 'pending',
      attempts: 0,
      local_uri: uriOf(i),
      ...over,
    };
  };
  if (opts.dupIdentical !== undefined) chunks.push(dupOf(opts.dupIdentical, {}));
  if (opts.dupWithDifferentHash !== undefined)
    chunks.push(dupOf(opts.dupWithDifferentHash, { hash: 'a'.repeat(64) }));
  if (opts.dupWithDifferentUri !== undefined)
    chunks.push(dupOf(opts.dupWithDifferentUri, { local_uri: 'file:///elsewhere.mp4' }));
  if (opts.dupWithDifferentSize !== undefined)
    chunks.push(dupOf(opts.dupWithDifferentSize, { size: 999 }));

  const entryBase: Record<string, unknown> = {
    session_id: SID,
    uri: opts.entryUri ?? '',
    recording_closed: opts.recordingClosed ?? true,
    session_completed: false,
    chunks,
  };
  if (!opts.omitCounter) {
    entryBase.next_chunk_index =
      opts.nextChunkIndex === undefined
        ? new Set(rows).size
        : opts.nextChunkIndex;
  }

  const queue = opts.noEntry
    ? [{ session_id: 'other', uri: '', recording_closed: true, chunks: [] }]
    : [entryBase];

  const queueText = JSON.stringify(queue);
  const written = new Map<string, string>();
  const createdNames: string[] = [];
  /** How many times each destination URI has been read back. */
  const readBackCounts = new Map<string, number>();
  let copyPass = false;

  // G3' — sources now use the real adopter naming, so this matches the
  // same shape as `idxFromTarget`. The two stay distinct because they are
  // applied to different maps (sources vs SAF destinations), not because
  // their filenames differ.
  const idxFromUri = (uri: string) =>
    Number(uri.match(/segment_(\d+)\.mp4$/)?.[1] ?? -1);
  const idxFromTarget = (uri: string) =>
    Number(uri.match(/segment_(\d+)\.mp4$/)?.[1] ?? -1);

  const deps: LocalSegmentDeps = {
    readQueueRaw: async () => {
      if (opts.queueThrows) throw new Error('AsyncStorage exploded');
      return opts.noQueue ? null : queueText;
    },
    fileInfo: async (
      uri,
    ): Promise<{ exists: boolean; size?: number | undefined }> => {
      if (opts.infoThrows) throw new Error('getInfoAsync exploded');
      return files.has(uri)
        ? { exists: true, size: sizes.get(uri) }
        : { exists: false };
    },
    readBase64: async uri => {
      const idx = idxFromUri(uri);
      if (copyPass && opts.vanishOnCopy?.includes(idx)) {
        throw new Error('ENOENT: source deleted by cleanup');
      }
      if (copyPass && opts.mutateOnCopy?.includes(idx)) {
        return Buffer.from(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])).toString(
          'base64',
        );
      }
      const v = files.get(uri);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    requestDirectory: async () => {
      copyPass = true;
      if (opts.safThrows === 'request') throw new Error('SAF request exploded');
      return 'content://tree/primary%3ADownload';
    },
    makeDirectory: async (parent, name) => {
      if (opts.safThrows === 'mkdir') throw new Error('SAF mkdir exploded');
      return `${parent}/${name}`;
    },
    createFile: async (parent, name) => {
      if (opts.safThrows === 'create') throw new Error('SAF createFile exploded');
      createdNames.push(name);
      const isManifest = name === MANIFEST_NAME;
      // A provider is free to hand back whatever URI it likes, including
      // an empty one or one it already gave out. None of that throws.
      if (opts.emptyCreate === (isManifest ? 'manifest' : 'segment')) return '';
      if (isManifest && opts.manifestUriCollides) {
        return `${parent}/${segmentFileName(0)}`;
      }
      if (!isManifest && opts.collideSegmentUris) {
        return `${parent}/segment_shared.mp4`;
      }
      return `${parent}/${name}`;
    },
    writeBase64: async (uri, b64) => {
      if (opts.safThrows === 'write') throw new Error('SAF write exploded');
      written.set(uri, b64);
    },
    writeText: async (uri, text) => {
      if (opts.manifestWriteThrows) throw new Error('SAF writeText exploded');
      if (opts.manifestTruncated) {
        // A provider that resolves while persisting garbage.
        written.set(uri, text.slice(0, 40));
        return;
      }
      if (opts.transformManifestText) {
        written.set(uri, opts.transformManifestText(text));
        return;
      }
      if (opts.tamperManifest) {
        const m = JSON.parse(text) as Record<string, unknown>;
        opts.tamperManifest(m);
        written.set(uri, JSON.stringify(m, null, 2));
        return;
      }
      written.set(uri, text);
    },
    readBackBase64: async uri => {
      const idx = idxFromTarget(uri);
      const nth = (readBackCounts.get(uri) ?? 0) + 1;
      readBackCounts.set(uri, nth);
      if (opts.corruptOnReadBack?.includes(idx)) {
        // Write resolved; what is actually stored is truncated.
        return Buffer.from(new Uint8Array([1, 2])).toString('base64');
      }
      // Correct on the read that follows the write, wrong on the final
      // pass — a destination overwritten later in the same run.
      if (nth > 1 && opts.clobberBeforeManifest?.includes(idx)) {
        return Buffer.from(new Uint8Array([7, 7, 7])).toString('base64');
      }
      const v = written.get(uri);
      if (v === undefined) throw new Error('ENOENT at destination');
      return v;
    },
    readBackText: async uri => {
      if (opts.manifestReadBackThrows) throw new Error('SAF readback exploded');
      const v = written.get(uri);
      if (v === undefined) throw new Error('ENOENT at destination');
      return v;
    },
    now: () => 1_700_000_000_000,
  };

  return { files, written, createdNames, deps, queueBefore: queueText };
}

async function planOf(w: World): Promise<LocalSegmentPlan> {
  const p = await planLocalSegmentExport(SID, w.deps);
  expect('rejected' in p, `expected a plan, got ${JSON.stringify(p)}`).toBe(false);
  return p as LocalSegmentPlan;
}

beforeEach(() => __resetLocalSegmentLockForTests());

describe('D3 — the emission counter is the sole authority on completeness', () => {
  it('duplicate rows never fake a complete: [0,0,2] with counter 3 is partial, missing [1]', async () => {
    // Three rows, two distinct usable indexes, three expected. A length
    // comparison would call this complete. Set equality does not.
    const w = makeWorld({ rows: [0, 0, 2], nextChunkIndex: 3 });
    const p = await planOf(w);

    expect(p.expected_indexes).toEqual([0, 1, 2]);
    expect(p.usable.map(u => u.chunk_index)).toEqual([0, 2]);
    expect(p.status).toBe('partial');
    expect(p.missing_indexes).toEqual([1]);
  });

  it('an absent counter is a refusal, NOT a fallback to the row count', async () => {
    const w = makeWorld({ rows: [0, 1], omitCounter: true });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'bad_emission_counter',
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 2.5],
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['absurdly large', MAX_EXPECTED_SEGMENTS + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const)('a %s counter resolves to a refusal, never a throw or an OOM', async (_n, v) => {
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: v as number });
    await expect(planLocalSegmentExport(SID, w.deps)).resolves.toEqual({
      rejected: 'bad_emission_counter',
    });
  });

  /**
   * Each of these isolates the structural property: indexes 0 and 1 are
   * present, verifiable and would otherwise yield `complete`. The ONLY
   * thing wrong is the inconsistency being tested, so a pass here cannot
   * be explained by some other reason to downgrade the verdict.
   */
  describe('a structurally inconsistent queue forbids any verdict', () => {
    it('control: [0,1] with counter 2 IS complete — the baseline these mutate', async () => {
      expect((await planOf(makeWorld({ rows: [0, 1], nextChunkIndex: 2 }))).status).toBe(
        'complete',
      );
    });

    it('an index at or beyond the counter is a refusal, not a skipped row', async () => {
      expect(
        await planLocalSegmentExport(SID, makeWorld({ rows: [0, 1, 5], nextChunkIndex: 2 }).deps),
      ).toEqual({ rejected: 'inconsistent_queue' });
    });

    it('a fractional index is a refusal', async () => {
      expect(
        await planLocalSegmentExport(
          SID,
          makeWorld({ rows: [0, 1, 1.5], nextChunkIndex: 2 }).deps,
        ),
      ).toEqual({ rejected: 'inconsistent_queue' });
    });

    it('a negative index is a refusal', async () => {
      expect(
        await planLocalSegmentExport(SID, makeWorld({ rows: [0, 1, -1], nextChunkIndex: 2 }).deps),
      ).toEqual({ rejected: 'inconsistent_queue' });
    });

    it('a duplicate index whose HASH disagrees is a refusal, not a preference', async () => {
      const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, dupWithDifferentHash: 1 });
      expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
        rejected: 'inconsistent_queue',
      });
    });

    it('a duplicate index whose URI disagrees is a refusal', async () => {
      const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, dupWithDifferentUri: 1 });
      expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
        rejected: 'inconsistent_queue',
      });
    });

    it('a duplicate index whose SIZE disagrees is a refusal', async () => {
      const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, dupWithDifferentSize: 1 });
      expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
        rejected: 'inconsistent_queue',
      });
    });

    it('a byte-identical duplicate is tolerated and deduplicated', async () => {
      const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, dupIdentical: 1 });
      const p = await planOf(w);
      expect(p.status).toBe('complete');
      expect(p.usable.map(u => u.chunk_index)).toEqual([0, 1]);
    });
  });

  it('complete requires no missing, no corrupt, and set equality', async () => {
    const p = await planOf(makeWorld({ rows: [0, 1, 2], nextChunkIndex: 3 }));
    expect(p.status).toBe('complete');
    expect(p.missing_indexes).toEqual([]);
    expect(p.corrupt_indexes).toEqual([]);
  });

  it('one corrupt index prevents complete even with nothing missing', async () => {
    const p = await planOf(makeWorld({ rows: [0, 1, 2], nextChunkIndex: 3, badHash: [1] }));
    expect(p.status).toBe('partial');
    expect(p.corrupt_indexes).toEqual([1]);
  });
});

describe('D3 — one session_id has exactly one GC_QUEUE authority', () => {
  const entryFrom = (w: World): Record<string, unknown> =>
    (JSON.parse(w.queueBefore) as Record<string, unknown>[])[0]!;

  const planFromEntries = async (
    w: World,
    entries: Record<string, unknown>[],
  ) =>
    planLocalSegmentExport(SID, {
      ...w.deps,
      readQueueRaw: async () => JSON.stringify(entries),
    });

  it('refuses complete-first then partial-second authorities for the same session', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1 });
    const complete = entryFrom(w);
    const partial = { ...complete, next_chunk_index: 2 };

    await expect(planFromEntries(w, [complete, partial])).resolves.toEqual({
      rejected: 'inconsistent_queue',
    });
  });

  it('refuses the same contradictory authorities in reverse order', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1 });
    const complete = entryFrom(w);
    const partial = { ...complete, next_chunk_index: 2 };

    await expect(planFromEntries(w, [partial, complete])).resolves.toEqual({
      rejected: 'inconsistent_queue',
    });
  });

  it('refuses two byte-identical entries for the same session', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1 });
    const first = entryFrom(w);
    const identical = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;

    await expect(planFromEntries(w, [first, identical])).resolves.toEqual({
      rejected: 'inconsistent_queue',
    });
  });
});

/**
 * P1.1 · A usable segment needs a source that exists, is non-empty, and
 * is ITS OWN. Both halves of that are invisible from a happy path and
 * both would produce a `complete` verdict over material nobody can use.
 */
describe('D3 — one source per index, and never an empty one', () => {
  it('a row declaring size 0 with the CORRECT sha256 of zero bytes never completes', async () => {
    // The trap: sha256 of the empty file is a perfectly valid digest, so
    // a hash check alone waves this through. Every field agrees with
    // every other field; the row is simply not a segment.
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, emptyRows: [1] });
    const p = await planOf(w);

    expect(p.status).not.toBe('complete');
    expect(p.status).toBe('partial');
    expect(p.corrupt_indexes).toEqual([1]);
    expect(p.usable.map(u => u.chunk_index)).toEqual([0]);

    // And it cannot be laundered into a complete through the export.
    const r = await exportLocalSegments(p, w.deps);
    expect(r.status).toBe('partial');
    expect(r.written_indexes).toEqual([0]);
  });

  it('a whole session of empty rows is a failure, not a complete', async () => {
    const p = await planOf(
      makeWorld({ rows: [0, 1], nextChunkIndex: 2, emptyRows: [0, 1] }),
    );
    expect(p.status).toBe('failed');
    expect(p.usable).toEqual([]);
  });

  it('a row with an empty local_uri is unusable', async () => {
    const p = await planOf(
      makeWorld({ rows: [0, 1], nextChunkIndex: 2, emptyUriRows: [1] }),
    );
    expect(p.status).toBe('partial');
    expect(p.corrupt_indexes).toEqual([1]);
  });

  it('two DIFFERENT indexes pointing at the same file is a refusal', async () => {
    // The queue is asserting that one file is two segments. Exporting it
    // would write those bytes twice under two names and certify both.
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, sharedUri: [0, 1] });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'inconsistent_queue',
    });
  });

  it('a distant pair sharing one file is refused just the same', async () => {
    const w = makeWorld({ rows: [0, 1, 2, 3], nextChunkIndex: 4, sharedUri: [1, 3] });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'inconsistent_queue',
    });
  });

  it('control: the SAME index twice on one file is still a harmless duplicate', async () => {
    // The boundary. Shared URI across indexes is a contradiction; a
    // repeated row for one index is not, and must keep deduplicating.
    const p = await planOf(makeWorld({ rows: [0, 1], nextChunkIndex: 2, dupIdentical: 0 }));
    expect(p.status).toBe('complete');
    expect(p.usable.map(u => u.chunk_index)).toEqual([0, 1]);
  });
});

describe('D3 — this route is for native segmented video and nothing else', () => {
  it('an audio/legacy entry is refused even though its chunks have local_uri', async () => {
    const w = makeWorld({ entryUri: 'file:///docs/guardian_recording_1.aac' });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'not_segmented_video',
    });
  });

  it('an ACTIVE recording is refused outright', async () => {
    expect(
      await planLocalSegmentExport(SID, makeWorld({ recordingClosed: false }).deps),
    ).toEqual({ rejected: 'recording_active' });
  });

  it('no queue and no entry are distinct refusals', async () => {
    expect(await planLocalSegmentExport(SID, makeWorld({ noQueue: true }).deps)).toEqual(
      { rejected: 'no_queue' },
    );
    expect(await planLocalSegmentExport(SID, makeWorld({ noEntry: true }).deps)).toEqual(
      { rejected: 'no_entry' },
    );
  });
});

describe('D3 — integrity is verified where the bytes LANDED', () => {
  it('a destination that silently truncates fails the export', async () => {
    // `writeBase64` resolves. The read-back returns two bytes. Only a
    // destination-side check can catch this.
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, corruptOnReadBack: [1] });
    const r = await exportLocalSegments(await planOf(w), w.deps);

    expect(r.status).toBe('failed');
    expect(r.error).toBe('destination_verify_failed_at_index_1');
    expect(r.manifest_written).toBe(false);
    expect(r.written_indexes).toEqual([0]);
  });

  it('a source swapped between planning and copy fails before any write', async () => {
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, mutateOnCopy: [1] });
    const r = await exportLocalSegments(await planOf(w), w.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('source_verify_failed_at_index_1');
    expect(r.manifest_written).toBe(false);
  });

  it('every persisted segment matches its recorded sha256', async () => {
    const w = makeWorld({ rows: [0, 1, 2], nextChunkIndex: 3 });
    await exportLocalSegments(await planOf(w), w.deps);
    for (const i of [0, 1, 2]) {
      const target = [...w.written.keys()].find(k => k.endsWith(segmentFileName(i)))!;
      const bytes = Buffer.from(w.written.get(target)!, 'base64');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(segment(i).hash);
    }
  });

  it('nothing usable is an explicit failure, not an empty artifact', async () => {
    const p = await planOf(makeWorld({ rows: [0, 1], nextChunkIndex: 2, absent: [0, 1] }));
    expect(p.status).toBe('failed');
    const r = await exportLocalSegments(p, makeWorld().deps);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('no_usable_segments');
    expect(r.directory_uri).toBeNull();
  });
});

describe('D3 — the manifest accredits only after being read back', () => {
  it('a manifest write that throws after createFile is a failure', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1, manifestWriteThrows: true });
    const r = await exportLocalSegments(await planOf(w), w.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('manifest_write_failed');
    expect(r.manifest_written).toBe(false);
  });

  it('a manifest that persisted truncated JSON — though the write resolved — is a failure', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1, manifestTruncated: true });
    const r = await exportLocalSegments(await planOf(w), w.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_persisted_incoherent');
    expect(r.manifest_written).toBe(false);
  });

  it('a manifest that cannot be read back is a failure', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1, manifestReadBackThrows: true });
    const r = await exportLocalSegments(await planOf(w), w.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('manifest_readback_failed');
  });

  it('JSON null is an incoherent manifest result, never a rejected promise', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1 });
    const plan = await planOf(w);
    const stringify = vi.spyOn(JSON, 'stringify').mockReturnValueOnce('null');
    try {
      await expect(exportLocalSegments(plan, w.deps)).resolves.toMatchObject({
        status: 'failed',
        error: 'manifest_persisted_incoherent',
        manifest_written: false,
      });
      expect(isLocalSegmentExportRunning()).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it('the persisted manifest carries schema, marker and coherent index sets', async () => {
    const w = makeWorld({ rows: [0, 2], nextChunkIndex: 3 });
    const r = await exportLocalSegments(await planOf(w), w.deps);

    expect(r.status).toBe('partial');
    expect(r.manifest_written).toBe(true);
    const uri = [...w.written.keys()].find(k => k.endsWith(MANIFEST_NAME))!;
    const m = JSON.parse(w.written.get(uri)!);
    expect(m.schema_version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(m[MANIFEST_COMPLETION_KEY]).toBe(true);
    expect(m.session_id).toBe(SID);
    expect(m.status).toBe('partial');
    expect(m.expected_indexes).toEqual([0, 1, 2]);
    expect(m.written_indexes).toEqual([0, 2]);
    expect(m.missing_indexes).toEqual([1]);
    expect(w.createdNames[w.createdNames.length - 1]).toBe(MANIFEST_NAME);
  });

  it('the manifest never claims a reconstructed video', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1 });
    await exportLocalSegments(await planOf(w), w.deps);
    const uri = [...w.written.keys()].find(k => k.endsWith(MANIFEST_NAME))!;
    expect(w.written.get(uri)!.toLowerCase()).toContain('not a ');
  });

  /**
   * The manifest must be an EXACT description of the artifact, so each
   * of these is a lie about what is on disk. All start from a run that
   * would otherwise succeed, so only the tampering explains the failure.
   */
  describe('a manifest that misdescribes the export is rejected', () => {
    const tampered = async (
      tamper: (m: Record<string, unknown>) => void,
      rows = [0, 1],
    ) => {
      const w = makeWorld({ rows, nextChunkIndex: rows.length, tamperManifest: tamper });
      return exportLocalSegments(await planOf(w), w.deps);
    };

    it('control: untampered succeeds — the baseline these mutate', async () => {
      const r = await tampered(() => {});
      expect(r.manifest_written).toBe(true);
      expect(r.status).toBe('complete');
    });

    it('a duplicated written index is rejected — a Set would have hidden it', async () => {
      const r = await tampered(m => {
        m.written_indexes = [0, 0, 1];
      });
      expect(r.status).toBe('failed');
      expect(r.error).toBe('manifest_persisted_incoherent');
      expect(r.manifest_written).toBe(false);
    });

    it('an empty segments array is rejected', async () => {
      const r = await tampered(m => {
        m.segments = [];
      });
      expect(r.error).toBe('manifest_persisted_incoherent');
      expect(r.manifest_written).toBe(false);
    });

    it('an altered segment sha256 is rejected', async () => {
      const r = await tampered(m => {
        (m.segments as Record<string, unknown>[])[0]!.sha256 = 'b'.repeat(64);
      });
      expect(r.error).toBe('manifest_persisted_incoherent');
    });

    it('an altered segment size is rejected', async () => {
      const r = await tampered(m => {
        (m.segments as Record<string, unknown>[])[0]!.size = 4242;
      });
      expect(r.error).toBe('manifest_persisted_incoherent');
    });

    it('an altered filename is rejected', async () => {
      const r = await tampered(m => {
        (m.segments as Record<string, unknown>[])[0]!.file = 'segment_999999.mp4';
      });
      expect(r.error).toBe('manifest_persisted_incoherent');
    });

    it('an extra segment entry is rejected', async () => {
      const r = await tampered(m => {
        const segs = m.segments as Record<string, unknown>[];
        segs.push({ ...segs[0], chunk_index: 7, file: 'segment_000007.mp4' });
      });
      expect(r.error).toBe('manifest_persisted_incoherent');
    });

    it('a missing segment entry is rejected', async () => {
      const r = await tampered(m => {
        (m.segments as unknown[]).pop();
      });
      expect(r.error).toBe('manifest_persisted_incoherent');
    });

    it('an altered expected_indexes array is rejected', async () => {
      const r = await tampered(m => {
        m.expected_indexes = [0];
      });
      expect(r.error).toBe('manifest_persisted_incoherent');
    });
  });
});

/**
 * P1.2 · The manifest is the ONLY accreditation this export has, and it
 * is supposed to BE the bytes this run handed to the provider — not an
 * independently plausible description of them.
 *
 * Every case below persists JSON that is valid, complete, and contains
 * exactly the right members. A membership check accepts all of them.
 */
describe('D3 — the persisted manifest must BE the emitted manifest', () => {
  /** A partial run: usable [0, 5], missing [1, 2], corrupt [3, 4]. */
  const runRich = async (tamper?: (m: Record<string, unknown>) => void) => {
    const w = makeWorld({
      rows: [0, 1, 2, 3, 4, 5],
      nextChunkIndex: 6,
      absent: [1, 2],
      badHash: [3, 4],
      tamperManifest: tamper,
    });
    return exportLocalSegments(await planOf(w), w.deps);
  };

  it('control: untampered succeeds, with four non-trivial arrays', async () => {
    const w = makeWorld({
      rows: [0, 1, 2, 3, 4, 5],
      nextChunkIndex: 6,
      absent: [1, 2],
      badHash: [3, 4],
    });
    const r = await exportLocalSegments(await planOf(w), w.deps);

    expect(r.status).toBe('partial');
    expect(r.manifest_written).toBe(true);
    const uri = [...w.written.keys()].find(k => k.endsWith(MANIFEST_NAME))!;
    const m = JSON.parse(w.written.get(uri)!);
    // Every array has ≥ 2 elements, so reversing each is a real mutation.
    expect(m.expected_indexes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(m.written_indexes).toEqual([0, 5]);
    expect(m.missing_indexes).toEqual([1, 2]);
    expect(m.corrupt_indexes).toEqual([3, 4]);
    expect(m.segments).toHaveLength(2);
  });

  const arrayFields = [
    'expected_indexes',
    'written_indexes',
    'missing_indexes',
    'corrupt_indexes',
  ];

  it.each(arrayFields)(
    'a REVERSED %s is rejected — same members, different document',
    async field => {
      const r = await runRich(m => {
        m[field] = [...(m[field] as number[])].reverse();
      });
      expect(r.status).toBe('failed');
      expect(r.error).toBe('manifest_persisted_incoherent');
      expect(r.manifest_written).toBe(false);
    },
  );

  it('a REVERSED segments array is rejected', async () => {
    const r = await runRich(m => {
      m.segments = [...(m.segments as unknown[])].reverse();
    });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_persisted_incoherent');
    expect(r.manifest_written).toBe(false);
  });

  /**
   * The semantic fields. `artifact` and `note` are what tell a reader
   * months later that this folder is a segment salvage and NOT a
   * reconstructed video; `exported_at` is when it happened. A provider
   * that rewrote any of them persisted a different document.
   */
  const semanticFields: [string, unknown][] = [
    ['schema_version', 99],
    [MANIFEST_COMPLETION_KEY, false],
    ['artifact', 'guardian-cloud-full-video-export'],
    ['note', 'Complete reconstructed video of the session.'],
    ['exported_at', '1999-01-01T00:00:00.000Z'],
    ['session_id', '00000000-0000-0000-0000-000000000000'],
    ['status', 'complete'],
  ];

  it.each(semanticFields)('an altered %s is rejected', async (field, value) => {
    const r = await runRich(m => {
      m[field as string] = value;
    });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_persisted_incoherent');
    expect(r.manifest_written).toBe(false);
  });

  const runTextTransform = async (transformManifestText: (text: string) => string) => {
    const w = makeWorld({
      rows: [0, 1],
      nextChunkIndex: 2,
      transformManifestText,
    });
    return exportLocalSegments(await planOf(w), w.deps);
  };

  it('rejects an additional top-level field', async () => {
    const r = await runRich(m => {
      m.provider_added = 'not emitted';
    });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_persisted_incoherent');
    expect(r.manifest_written).toBe(false);
  });

  it('rejects an additional field inside segments[]', async () => {
    const r = await runRich(m => {
      (m.segments as Record<string, unknown>[])[0]!.provider_added = 'not emitted';
    });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_persisted_incoherent');
    expect(r.manifest_written).toBe(false);
  });

  it('rejects a duplicate semantic key even when JSON.parse would keep the emitted value', async () => {
    const r = await runTextTransform(text =>
      text.replace('{', '{\n  "status": "failed",'),
    );
    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_persisted_incoherent');
    expect(r.manifest_written).toBe(false);
  });

  it('rejects the same JSON object persisted in a different key order', async () => {
    const r = await runTextTransform(text => {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()), null, 2);
    });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_persisted_incoherent');
    expect(r.manifest_written).toBe(false);
  });

  it('rejects whitespace-only transformation of the emitted text', async () => {
    const r = await runTextTransform(text => `${text}\n`);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_persisted_incoherent');
    expect(r.manifest_written).toBe(false);
  });
});

/**
 * P1.3 · `createFile` is not a reliable source of distinct URIs, and a
 * read-back only proves what was there at that instant.
 */
describe('D3 — destination URIs are distinct, and re-verified at the end', () => {
  it('one URI handed back for two segments is a failure', async () => {
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, collideSegmentUris: true });
    const r = await exportLocalSegments(await planOf(w), w.deps);

    expect(r.status).toBe('failed');
    expect(r.error).toBe('duplicate_destination_uri_at_index_1');
    expect(r.manifest_written).toBe(false);
    expect(w.createdNames).not.toContain(MANIFEST_NAME);
  });

  it('an empty destination URI is a failure', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1, emptyCreate: 'segment' });
    const r = await exportLocalSegments(await planOf(w), w.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('empty_destination_uri_at_index_0');
    expect(r.manifest_written).toBe(false);
  });

  it('the manifest may not be handed a segment URI', async () => {
    // Writing the manifest there would destroy the very bytes it is
    // about to certify — and the certificate would still read as valid.
    const w = makeWorld({ rows: [0], nextChunkIndex: 1, manifestUriCollides: true });
    const r = await exportLocalSegments(await planOf(w), w.deps);

    expect(r.status).toBe('failed');
    expect(r.error).toBe('manifest_uri_collides_with_segment');
    expect(r.manifest_written).toBe(false);
    const seg = [...w.written.keys()].find(k => k.endsWith(segmentFileName(0)))!;
    expect(w.written.get(seg)).toBe(segment(0).b64);
  });

  it('an empty manifest URI is a failure', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1, emptyCreate: 'manifest' });
    const r = await exportLocalSegments(await planOf(w), w.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('empty_manifest_uri');
    expect(r.manifest_written).toBe(false);
  });

  it('a segment correct on write but clobbered before the manifest fails', async () => {
    // Verified when it was written, wrong by the time the manifest would
    // certify it. Only the final pass can see this.
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, clobberBeforeManifest: [0] });
    const r = await exportLocalSegments(await planOf(w), w.deps);

    expect(r.status).toBe('failed');
    expect(r.error).toBe('final_verify_failed_at_index_0');
    expect(r.manifest_written).toBe(false);
    expect(w.createdNames).not.toContain(MANIFEST_NAME);
  });

  it('a destination unreadable on the final pass fails, and never rejects', async () => {
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2 });
    let reads = 0;
    const r = await exportLocalSegments(await planOf(w), {
      ...w.deps,
      readBackBase64: async (uri: string) => {
        reads += 1;
        // Reads 1 and 2 are the per-segment ones; 3 is the final pass.
        if (reads > 2) throw new Error('SAF document vanished');
        return w.deps.readBackBase64(uri);
      },
    });

    expect(r.status).toBe('failed');
    expect(r.error).toContain('final_readback_failed_at_index_0');
    expect(r.manifest_written).toBe(false);
  });

  it('every destination is read back TWICE: on write, and before the manifest', async () => {
    const w = makeWorld({ rows: [0, 1, 2], nextChunkIndex: 3 });
    const seen = new Map<string, number>();
    const r = await exportLocalSegments(await planOf(w), {
      ...w.deps,
      readBackBase64: async (uri: string) => {
        seen.set(uri, (seen.get(uri) ?? 0) + 1);
        return w.deps.readBackBase64(uri);
      },
    });

    expect(r.status).toBe('complete');
    expect(r.manifest_written).toBe(true);
    expect(seen.size).toBe(3);
    for (const [uri, n] of seen) expect(n, `reads of ${uri}`).toBe(2);
  });
});

describe('D3 — writing out', () => {
  it('names are six digits and ordered by chunk_index', async () => {
    const w = makeWorld({ rows: [2, 0, 1], nextChunkIndex: 3 });
    const r = await exportLocalSegments(await planOf(w), w.deps);
    expect(r.written_indexes).toEqual([0, 1, 2]);
    expect(w.createdNames.slice(0, 3)).toEqual([
      'segment_000000.mp4',
      'segment_000001.mp4',
      'segment_000002.mp4',
    ]);
    expect(segmentFileName(7)).toBe('segment_000007.mp4');
    expect(r.directory_uri).toContain(EXPORT_DIR_PREFIX);
  });
});

describe('D3 — single-flight', () => {
  it('a second call while one is running is refused', async () => {
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2 });
    const plan = await planOf(w);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const slow: LocalSegmentDeps = {
      ...w.deps,
      requestDirectory: async () => {
        await gate;
        return 'content://tree/primary%3ADownload';
      },
    };
    const first = exportLocalSegments(plan, slow);
    expect(isLocalSegmentExportRunning()).toBe(true);
    const second = await exportLocalSegments(plan, w.deps);
    expect(second.error).toBe('busy');
    release();
    expect((await first).manifest_written).toBe(true);
    expect(isLocalSegmentExportRunning()).toBe(false);
  });

  it('the lock is released even when the export fails', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1, safThrows: 'mkdir' });
    expect((await exportLocalSegments(await planOf(w), w.deps)).status).toBe('failed');
    expect(isLocalSegmentExportRunning()).toBe(false);
  });
});

describe('D3 — nothing rejects; every failure is a result', () => {
  it('a throwing queue read becomes a refusal', async () => {
    await expect(
      planLocalSegmentExport(SID, makeWorld({ queueThrows: true }).deps),
    ).resolves.toEqual({ rejected: 'no_queue' });
  });

  it('a throwing filesystem probe becomes a corrupt verdict', async () => {
    const p = await planOf(makeWorld({ rows: [0, 1], nextChunkIndex: 2, infoThrows: true }));
    expect(p.status).toBe('failed');
    expect(p.corrupt_indexes).toEqual([0, 1]);
  });

  it.each(['request', 'mkdir', 'create', 'write'] as const)(
    'a throwing SAF %s becomes an explicit error result',
    async stage => {
      const w = makeWorld({ rows: [0], nextChunkIndex: 1, safThrows: stage });
      const r = await exportLocalSegments(await planOf(w), w.deps);
      expect(r.status).toBe('failed');
      expect(r.manifest_written).toBe(false);
      expect(typeof r.error).toBe('string');
    },
  );

  it('permission denied is a clean failure', async () => {
    const w = makeWorld({ rows: [0], nextChunkIndex: 1 });
    const r = await exportLocalSegments(await planOf(w), {
      ...w.deps,
      requestDirectory: async () => null,
    });
    expect(r.error).toBe('permission_denied');
  });
});

describe('D3 — the race with cleanup is tolerated, never faked', () => {
  it('a source that disappears between planning and copy fails the export', async () => {
    const w = makeWorld({ rows: [0, 1, 2], nextChunkIndex: 3, vanishOnCopy: [1] });
    const plan = await planOf(w);
    expect(plan.status).toBe('complete');
    const r = await exportLocalSegments(plan, w.deps);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('read_failed_at_index_1');
    expect(w.createdNames).not.toContain(MANIFEST_NAME);
  });
});

describe('D3 — Guardian Cloud state is never touched', () => {
  it('GC_QUEUE is byte-identical after success and after failure', async () => {
    const ok = makeWorld({ rows: [0, 1, 2], nextChunkIndex: 3 });
    await exportLocalSegments(await planOf(ok), ok.deps);
    expect(await ok.deps.readQueueRaw()).toBe(ok.queueBefore);

    const bad = makeWorld({ rows: [0, 1], nextChunkIndex: 2, vanishOnCopy: [0] });
    await exportLocalSegments(await planOf(bad), bad.deps);
    expect(await bad.deps.readQueueRaw()).toBe(bad.queueBefore);
  });

  it('the source segments are left exactly as they were', async () => {
    const w = makeWorld({ rows: [0, 1, 2], nextChunkIndex: 3 });
    const before = new Map(w.files);
    await exportLocalSegments(await planOf(w), w.deps);
    expect(w.files.size).toBe(before.size);
    for (const [k, v] of before) expect(w.files.get(k)).toBe(v);
  });
});

/**
 * Structural teeth. The behavioural blocks prove what one run did; these
 * prove what the code is ALLOWED to do.
 */
describe('D3 — teeth', () => {
  const strip = (s: string) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => ' '.repeat(m.length))
      .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));

  const CODE = strip(
    readFileSync(join(HERE, '..', 'src', 'recording', 'localAssembly.ts'), 'utf8'),
  );
  const SCREEN = strip(
    readFileSync(join(HERE, '..', 'app', 'session', '[id].tsx'), 'utf8'),
  );

  it('no network, no token, no backend — anywhere in the module', () => {
    for (const f of [
      'apiFetch',
      'getOwnershipAccessToken',
      'getFreshAccessToken',
      'access_token',
      'supabase',
      'fetch(',
      'guardiancloud.app',
    ]) {
      expect(CODE.includes(f), `forbidden: ${f}`).toBe(false);
    }
  });

  it('no write of any kind to Guardian Cloud state', () => {
    for (const f of [
      'setItem',
      'removeItem',
      'multiRemove',
      'deleteAsync',
      'moveAsync',
      'queueMutate',
      'markIdentityInitialized',
    ]) {
      expect(CODE.includes(f), `forbidden: ${f}`).toBe(false);
    }
  });

  it('the emission counter has no fallback to the row count', () => {
    expect(CODE).toContain('Number.isSafeInteger(counter)');
    expect(CODE).toContain('MAX_EXPECTED_SEGMENTS');
    expect(CODE).toContain("rejected: 'bad_emission_counter'");
    // The old fallback. Its return would silently shrink the expected set.
    expect(CODE).not.toContain(': chunks.length');
  });

  it('completeness and persisted arrays use exact comparison, never a Set', () => {
    expect(CODE).toContain('exactIndexArray(');
    expect(CODE).not.toContain('usable.length === expected_indexes.length');
    // `sameSet` collapsed duplicates and is gone on purpose. Its return
    // would validate a manifest claiming [0,0,1] against a run that
    // wrote [0,1].
    expect(CODE).not.toContain('sameSet');
  });

  it('a structurally inconsistent queue is refused, never skipped', () => {
    expect(CODE).toContain("rejected: 'inconsistent_queue'");
    // The old silent skips. Either one would let a bad row disappear.
    expect(CODE).not.toContain('// out of range: ignored');
    expect(CODE).not.toContain('// duplicate row: first wins');
  });

  it('P1.4 · session lookup requires exactly one queue authority', () => {
    expect(CODE).not.toContain('parsed.find(');
    expect(CODE).toContain('parsed.filter(');
    expect(CODE).toContain('matchingEntries.length === 0');
    expect(CODE).toContain('matchingEntries.length > 1');
    expect(CODE).toContain("matchingEntries.length > 1) return { rejected: 'inconsistent_queue' }");
  });

  it('the persisted segments array is validated field by field', () => {
    expect(CODE).toContain('samePositionalSegments(');
    expect(CODE).toContain('o.chunk_index !== e.chunk_index');
    expect(CODE).toContain('o.file !== e.file');
    expect(CODE).toContain('o.size !== e.size');
    expect(CODE).toContain('o.sha256 !== e.sha256');
    expect(CODE).toContain('samePositionalSegments(persistedManifest.segments');
  });

  it('P1.1 · a file backs one index, and an empty row is not a segment', () => {
    expect(CODE).toContain('uriOwner.has(uri)');
    expect(CODE).toContain('uriOwner.set(uri, idx)');
    // Declaring the check without consulting it — the state this
    // replaces — leaves the module accepting one file as two segments.
    expect(CODE.indexOf('uriOwner.has(uri)')).toBeGreaterThan(
      CODE.indexOf('const uriOwner'),
    );
    expect(CODE).toContain('c.size > 0');
    // The sha256 of zero bytes is a valid digest; `>= 0` certifies it.
    expect(CODE).not.toContain('c.size >= 0');
  });

  it('P1.2 · the persisted manifest is compared positionally, never by membership', () => {
    expect(CODE).toContain('samePositionalIndexes(');
    // The order-insensitive comparators answer the completeness
    // question, not this one: both accept a reordered array.
    expect(CODE).not.toContain('exactIndexArray(round.');
    expect(CODE).not.toContain('exactSegments');
    for (const field of [
      'persistedManifest.schema_version !== manifest.schema_version',
      'persistedManifest.artifact !== manifest.artifact',
      'persistedManifest.note !== manifest.note',
      'persistedManifest.exported_at !== manifest.exported_at',
      'persistedManifest.session_id !== manifest.session_id',
      'persistedManifest.status !== manifest.status',
      'persistedManifest.expected_indexes',
      'persistedManifest.written_indexes',
      'persistedManifest.missing_indexes',
      'persistedManifest.corrupt_indexes',
    ]) {
      expect(CODE.includes(field), `unchecked manifest field: ${field}`).toBe(true);
    }
    expect(CODE).toContain(`persistedManifest[MANIFEST_COMPLETION_KEY] !==`);
  });

  it('P1.5 · persisted manifest text is byte-identical before parsing', () => {
    const exactText = CODE.indexOf('backText !== text');
    const parse = CODE.indexOf('JSON.parse(backText)', exactText);
    expect(exactText).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(exactText);
  });

  it('P2 · parsed JSON must be a non-null object before property access', () => {
    const parse = CODE.indexOf('JSON.parse(backText)');
    const nullGuard = CODE.indexOf('round === null', parse);
    const objectGuard = CODE.indexOf("typeof round !== 'object'", nullGuard);
    const arrayGuard = CODE.indexOf('Array.isArray(round)', objectGuard);
    const firstPropertyRead = CODE.indexOf('persistedManifest.schema_version', arrayGuard);
    expect(parse).toBeGreaterThan(-1);
    expect(nullGuard).toBeGreaterThan(parse);
    expect(objectGuard).toBeGreaterThan(nullGuard);
    expect(arrayGuard).toBeGreaterThan(objectGuard);
    expect(firstPropertyRead).toBeGreaterThan(arrayGuard);
  });

  it('P1.2 · the positional comparators normalise nothing', () => {
    const from = CODE.indexOf('function samePositionalIndexes');
    const to = CODE.indexOf('export const defaultLocalSegmentDeps');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = CODE.slice(from, to);
    for (const f of ['new Set', '.sort(', '.includes(', '.has(']) {
      expect(body.includes(f), `normalisation in the positional path: ${f}`).toBe(
        false,
      );
    }
  });

  it('P1.3 · destinations are unique and re-verified before the manifest exists', () => {
    expect(CODE).toContain('segmentDestinationUris.has(target)');
    expect(CODE).toContain('segmentDestinationUris.add(target)');
    expect(CODE).toContain('segmentDestinationUris.has(manifestUri)');
    expect(CODE).toContain('empty_destination_uri_at_index_');
    expect(CODE).toContain('empty_manifest_uri');

    // The final pass must sit AFTER the write loop and BEFORE the
    // manifest is created. Placed after, it would certify bytes it never
    // re-read; omitted, a clobbered segment is certified as intact.
    const loopEnd = CODE.indexOf("fail('written_set_mismatch')");
    const finalPass = CODE.indexOf(
      'for (const { source, target } of persisted)',
      loopEnd,
    );
    const finalRead = CODE.indexOf('readBackBase64(target)', finalPass);
    const finalVerify = CODE.indexOf('verifiesAs(again', finalRead);
    const manifestCreate = CODE.indexOf('createFile(dir, MANIFEST_NAME', finalVerify);
    expect(loopEnd).toBeGreaterThan(-1);
    expect(finalPass).toBeGreaterThan(loopEnd);
    expect(finalRead).toBeGreaterThan(finalPass);
    expect(finalVerify).toBeGreaterThan(finalRead);
    expect(manifestCreate).toBeGreaterThan(finalVerify);
  });

  it('the destination is read back and verified for every segment', () => {
    const loop = CODE.indexOf('for (const seg of plan.usable)');
    const readback = CODE.indexOf('readBackBase64(target', loop);
    const verify = CODE.indexOf('verifiesAs(back', readback);
    const push = CODE.indexOf('written_indexes.push', verify);
    expect(loop).toBeGreaterThan(-1);
    expect(readback).toBeGreaterThan(loop);
    expect(verify).toBeGreaterThan(readback);
    expect(push).toBeGreaterThan(verify);
  });

  it('the manifest is read back from the destination and validated', () => {
    const write = CODE.indexOf('writeText(manifestUri');
    const readback = CODE.indexOf('readBackText(manifestUri', write);
    const parse = CODE.indexOf('JSON.parse(backText', readback);
    expect(write).toBeGreaterThan(-1);
    expect(readback).toBeGreaterThan(write);
    expect(parse).toBeGreaterThan(readback);
    expect(CODE).toContain('manifest_persisted_incoherent');
  });

  it('every guard the earlier reviews accepted is still present', () => {
    expect(CODE).toContain('recording_closed !== true');
    expect(CODE).toContain("entry.uri !== ''");
    expect(CODE).toContain('exportInFlight');
    expect(CODE).toContain("padStart(6, '0')");
    expect(CODE).toContain("'test.pending_retry'");
  });

  /**
   * The cloud-first path must reach D3 on ANY failure, not only on zero
   * progress. Scoped to the fallback itself: `validChunks === 0` also
   * appears elsewhere in this screen as a pre-existing failure-reason
   * discriminator, and forbidding the substring globally would flag
   * unrelated code instead of the gate being removed.
   */
  it('the cloud fallback is not gated on validChunks === 0', () => {
    const fn = SCREEN.indexOf('async function tryLocalAfterCloud');
    const end = SCREEN.indexOf('const unsub = subscribeExport', fn);
    expect(fn).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(fn);
    expect(SCREEN.slice(fn, end)).not.toContain('validChunks === 0');
    // Reachable from the done-failed path AND from the runner error state.
    expect(SCREEN.split('tryLocalAfterCloud(').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('the local paths are wrapped so the screen can never hang', () => {
    const fn = SCREEN.indexOf('async function tryLocalAfterCloud');
    const end = SCREEN.indexOf('async function handleDone', fn);
    expect(fn).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(fn);
    const body = SCREEN.slice(fn, end);

    expect(body).toContain('} catch (err) {');
    expect(body).toContain("kind: 'error'");
    // A catch that exists but rethrows is not a catch. An earlier
    // version of this test only checked for the keyword, and a mutation
    // that added `throw err;` inside it passed unnoticed.
    expect(body, 'the catch must handle, not rethrow').not.toContain('throw ');
  });

  /**
   * Deliberately NOT asserted: `StorageAccessFramework` / `createFileAsync`.
   * The screen already used SAF before D3 existed, in `handleSaveToDevice`.
   * Forbidding those names would flag a pre-existing feature instead of
   * the property being protected — which is what an earlier version of
   * this test did.
   */
  it('the screen holds no assembly logic of its own', () => {
    for (const f of ['sha256', 'Crypto.digest', 'atob(', 'base64ToBytes', 'test.pending_retry']) {
      expect(SCREEN.includes(f), `logic leaked into screen: ${f}`).toBe(false);
    }
  });

  it('the local phases never claim the file is coming from Drive', () => {
    // The cloud blurb must be conditioned off on every local phase.
    const blurb = SCREEN.indexOf('Google');
    expect(blurb).toBeGreaterThan(-1);
    const guard = SCREEN.lastIndexOf("phase.kind !== 'localExport'", blurb);
    expect(guard, 'the Drive copy must be hidden on local phases').toBeGreaterThan(-1);
    expect(SCREEN).toContain('Preparando segmentos guardados en este dispositivo');

    // These phrases may appear ONLY as denials. The block says "Esto NO
    // es la grabación completa", which is exactly the honesty wanted;
    // banning the words outright would forbid saying so.
    for (const claim of ['vídeo reconstruido', 'MP4 final', 'grabación completa']) {
      for (let i = SCREEN.indexOf(claim); i > -1; i = SCREEN.indexOf(claim, i + 1)) {
        const before = SCREEN.slice(Math.max(0, i - 24), i);
        expect(
          /\bNO\b/.test(before),
          `claimed without a denial: ${claim} — "${before.trim()}"`,
        ).toBe(true);
      }
    }
  });
});

/**
 * G3' — media classification.
 *
 * `media` says what a chunk's bytes ARE. It does not say the chunk is a
 * native segment: `videoChunkSink` writes `media: 'video'` for legacy
 * post-stop base64 slices under `chunks/<sid>/N.b64`, which are not
 * segments. So D3 requires BOTH the medium and the structural signature
 * `segments/<sid>/segment_NNNNNN.mp4`, and fails closed on any ambiguity.
 */
describe("D3 — G3' media classification", () => {
  const legacyVideoUri = (i: number) => `file:///docs/chunks/${SID}/${i}.b64`;

  it('M1 — video + valid signature continues (the current production shape)', async () => {
    const p = await planOf(
      makeWorld({ rows: [0, 1], nextChunkIndex: 2, media: { 0: 'video', 1: 'video' } }),
    );
    expect(p.status).toBe('complete');
  });

  it("M2 — ★ media:'video' on a chunks/<sid>/N.b64 path NEVER enters D3", async () => {
    // The real `videoChunkSink` shape. Without this refusal, legacy video
    // slices would be written out as `segment_NNNNNN.mp4` and certified.
    const w = makeWorld({
      rows: [0, 1],
      nextChunkIndex: 2,
      media: { 0: 'video', 1: 'video' },
      uriOverride: { 1: legacyVideoUri(1) },
    });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'not_segmented_video',
    });
  });

  it('M3 — a single audio chunk refuses the whole export', async () => {
    const w = makeWorld({
      rows: [0, 1],
      nextChunkIndex: 2,
      media: { 0: 'video', 1: 'audio' },
    });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'mixed_session',
    });
  });

  it('M4 — an unrecognised media value fails closed', async () => {
    for (const bad of ['vídeo', 'VIDEO', 42, null, {}]) {
      const w = makeWorld({
        rows: [0, 1],
        nextChunkIndex: 2,
        media: { 0: 'video', 1: bad },
      });
      expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
        rejected: 'unknown_media_metadata',
      });
    }
  });

  it('M5 — mixed provenance (some rows with metadata, some without) fails closed', async () => {
    const w = makeWorld({ rows: [0, 1], nextChunkIndex: 2, media: { 0: 'video' } });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'inconsistent_media_metadata',
    });
  });

  it('M6 — legacy (no metadata anywhere) continues on the signature alone', async () => {
    // Every entry that exists on a device today. Verdict must be
    // bit-for-bit what it was before G3'.
    const p = await planOf(makeWorld({ rows: [0, 1, 2], nextChunkIndex: 3 }));
    expect(p.status).toBe('complete');
    expect(p.usable.map(u => u.chunk_index)).toEqual([0, 1, 2]);
  });

  it('M7 — legacy with ANY non-segment path fails closed, not "probably video"', async () => {
    // The case the fallback must not wave through: no metadata, and a
    // path that is not a native segment. `entry.uri === ''` alone must
    // never be enough to call these bytes video.
    const w = makeWorld({
      rows: [0, 1],
      nextChunkIndex: 2,
      uriOverride: { 1: legacyVideoUri(1) },
    });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'unverifiable_legacy_media',
    });
  });

  it('M8 — the signature is not a weak textual match', async () => {
    const lookalikes = [
      `file:///docs/segments/${SID}/segment_00001.mp4`, // five digits
      `file:///docs/segments/${SID}/segment_000001.mp4.tmp`, // suffix
      `file:///docs/segments/${SID}/xsegment_000001.mp4`, // prefix
      `file:///docs/segments/${SID}/nested/segment_000001.mp4`, // deeper
      `file:///docs/xsegments/${SID}/segment_000001.mp4`, // dir lookalike
      `file:///docs/segments/${SID}x/segment_000001.mp4`, // sid lookalike
      `file:///docs/segments/other-session/segment_000001.mp4`, // other sid
      `file:///docs/segments/${SID}/../segments/${SID}/segment_000001.mp4`,
    ];
    for (const uri of lookalikes) {
      const w = makeWorld({
        rows: [0, 1],
        nextChunkIndex: 2,
        media: { 0: 'video', 1: 'video' },
        uriOverride: { 1: uri },
      });
      expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
        rejected: 'not_segmented_video',
      });
    }
  });

  it('M9 — pre-existing refusals keep precedence over the media gate', async () => {
    // The gate only ADDS refusals. A queue that was `inconsistent_queue`
    // before G3' must still report `inconsistent_queue`, not a media
    // verdict, even when the media metadata is also wrong.
    const w = makeWorld({
      rows: [0, 1],
      nextChunkIndex: 2,
      media: { 0: 'audio', 1: 'audio' },
      dupWithDifferentHash: 0,
    });
    expect(await planLocalSegmentExport(SID, w.deps)).toEqual({
      rejected: 'inconsistent_queue',
    });
  });
});
