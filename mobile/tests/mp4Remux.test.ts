/**
 * EXPORT-MP4 · REMUX — the assembly decision and the staging of segments.
 *
 * Covers the client half of the single-`.mp4` export: WHICH assembly a set of
 * verified chunks needs, and how the segments reach the native remuxer. The
 * remux itself is native and is validated on device
 * (`SegmentRemuxTest`, `ExtractorPtsProbeTest`); nothing here pretends to
 * exercise `MediaExtractor`.
 *
 * ── What these tests are really defending ───────────────────────────────
 * The defect that opened this gate was not a crash. The export produced a
 * file that LOOKED like the whole recording and played only its first
 * container — 3,18 s of 25,17 s, with every byte intact. So the properties
 * under test are mostly about refusing to make a claim:
 *
 *   - the medium comes from per-chunk metadata, never from the session mode
 *     or the file extension;
 *   - absence of metadata is an absence, not "video";
 *   - a set that disagrees with itself produces nothing;
 *   - a refusal leaves no file behind.
 *
 * The last block asserts properties against the module's source text,
 * following the idiom already used by `ownershipBrand`, `localAssembly` and
 * `devResetGuard`: "this module never decides the medium from the session
 * mode" is a claim about what the file may CONTAIN, not about what one run
 * happened to do.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  type AssemblyInput,
  type ChunkMedium,
  type RemuxDeps,
  RemuxFailed,
  decideAssembly,
  remuxPartsToMp4,
  startsWithFtyp,
} from '@/recording/mp4Remux';

/** An MP4 container start: 4 size bytes then the `ftyp` box type. */
function ftypPart(extra = 0): Uint8Array {
  const head = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];
  return new Uint8Array([...head, ...new Array(extra).fill(0x41)]);
}

/** A continuation slice: real media bytes, no box header. */
function rawPart(len = 16): Uint8Array {
  return new Uint8Array(new Array(len).fill(0x42));
}

/**
 * `'absent'` omits the property entirely, which is what a chunk registered
 * before G3'' actually looks like. `null` is what the column holds once the
 * field exists and nothing declared it. Both must mean "not declared", and
 * `exactOptionalPropertyTypes` makes the difference expressible — so the
 * distinction is exercised rather than assumed away.
 */
function chunks(...media: (ChunkMedium | null | 'absent')[]): AssemblyInput[] {
  return media.map((m, i) =>
    m === 'absent' ? { chunk_index: i } : { chunk_index: i, media: m },
  );
}

describe('startsWithFtyp', () => {
  it('recognises an ftyp box at the box-type position', () => {
    expect(startsWithFtyp(ftypPart())).toBe(true);
  });

  it('rejects a part that merely contains the bytes elsewhere', () => {
    // `ftyp` at offset 0 instead of 4. A box type never sits there — the
    // first four bytes are the size — so this is not a container start.
    const misplaced = new Uint8Array([
      0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x18,
    ]);
    expect(startsWithFtyp(misplaced)).toBe(false);
  });

  it('rejects a part too short to hold a box header', () => {
    expect(startsWithFtyp(new Uint8Array([0x00, 0x00, 0x00]))).toBe(false);
  });
});

describe('decideAssembly · the medium decides, and only the medium', () => {
  it('remuxes a set whose every chunk declares video', () => {
    expect(decideAssembly(chunks('video', 'video', 'video'), true)).toEqual({
      kind: 'remux',
    });
  });

  it('remuxes declared video even when the chunks are NOT separate containers', () => {
    // The declaration is authoritative. The structural observation is only
    // ever allowed to refuse, so it must not be able to turn a declared
    // video set into a concatenation.
    expect(decideAssembly(chunks('video', 'video'), false)).toEqual({
      kind: 'remux',
    });
  });

  it('concatenates a set whose every chunk declares audio', () => {
    // The audio path is correct as it stands: those chunks are byte ranges
    // of one recording. This gate must not change it.
    expect(decideAssembly(chunks('audio', 'audio'), false)).toEqual({
      kind: 'concat',
    });
  });

  it('refuses a set mixing declared media', () => {
    expect(decideAssembly(chunks('video', 'audio'), false)).toEqual({
      kind: 'refuse',
      reason: 'media_inconsistent',
    });
  });

  it('refuses a set where only some chunks declare a medium', () => {
    // Partial declaration is not evidence of one medium. Picking the
    // majority, or trusting the first chunk, would be guessing.
    expect(decideAssembly(chunks('video', null), false)).toEqual({
      kind: 'refuse',
      reason: 'media_inconsistent',
    });
    expect(decideAssembly(chunks('audio', 'absent'), false)).toEqual({
      kind: 'refuse',
      reason: 'media_inconsistent',
    });
  });

  it('treats an undeclared set as the legacy audio path it has always been', () => {
    // Both shapes of "not declared" behave identically: the column holding
    // NULL, and the property never being there at all.
    expect(decideAssembly(chunks(null, null, null), false)).toEqual({
      kind: 'concat',
    });
    expect(decideAssembly(chunks('absent', 'absent'), false)).toEqual({
      kind: 'concat',
    });
    expect(decideAssembly(chunks('absent', null), false)).toEqual({
      kind: 'concat',
    });
  });

  it('refuses an undeclared multi-container set however the absence is spelled', () => {
    expect(decideAssembly(chunks('absent', 'absent'), true)).toEqual({
      kind: 'refuse',
      reason: 'undeclared_multi_container',
    });
  });

  it('refuses an undeclared set whose chunks are each a whole container', () => {
    // The pre-G3'' video session. Nothing declares a medium, so there is
    // nothing to decide from — but the bytes prove concatenation cannot be
    // right, and producing the misleading artifact is the one outcome worse
    // than producing none.
    expect(decideAssembly(chunks(null, null), true)).toEqual({
      kind: 'refuse',
      reason: 'undeclared_multi_container',
    });
  });

  it('never infers video from absence', () => {
    // The whole point of the G3'' semantics: NULL means "not declared".
    const decision = decideAssembly(chunks(null, null), false);
    expect(decision.kind).not.toBe('remux');
  });

  it('does not read anything but `media` off a chunk', () => {
    // A session mode, a filename or an extension smuggled onto the chunk
    // must not change the outcome.
    const decorated = [
      { chunk_index: 0, media: null, mode: 'video', ext: '.mp4' },
      { chunk_index: 1, media: null, mode: 'video', ext: '.mp4' },
    ] as unknown as AssemblyInput[];
    expect(decideAssembly(decorated, false)).toEqual({ kind: 'concat' });
  });

  it('does not crash on an empty set', () => {
    expect(decideAssembly([], false)).toEqual({ kind: 'concat' });
  });
});

describe('remuxPartsToMp4 · staging', () => {
  function deps(overrides: Partial<RemuxDeps> = {}): RemuxDeps & {
    written: string[];
    removed: string[];
    handed: string[][];
  } {
    const written: string[] = [];
    const removed: string[] = [];
    const handed: string[][] = [];
    return {
      written,
      removed,
      handed,
      cacheDir: 'file:///cache/',
      makeDir: vi.fn(async () => undefined),
      removeDir: vi.fn(async (p: string) => {
        removed.push(p);
      }),
      writePart: vi.fn(async (p: string) => {
        written.push(p);
      }),
      remux: vi.fn(async (inputs: string[]) => {
        handed.push(inputs);
        return {
          segments: inputs.length,
          durationUs: 25_170_431,
          videoSamples: 738,
          audioSamples: 1084,
          sizeBytes: 1_751_712,
          method: 'audio_contiguity_v1',
        };
      }),
      ...overrides,
    };
  }

  it('stages one file per part and hands them over in array order', async () => {
    const d = deps();
    const report = await remuxPartsToMp4(
      'sid-1',
      [ftypPart(), ftypPart(), ftypPart()],
      'file:///docs/out.mp4',
      d,
    );

    expect(d.written).toEqual([
      'file:///cache/remux/sid-1/seg_000000.mp4',
      'file:///cache/remux/sid-1/seg_000001.mp4',
      'file:///cache/remux/sid-1/seg_000002.mp4',
    ]);
    // Zero-padded so a lexicographic reader sees the same order as the
    // array — the order is the whole contract, since a rebased segment
    // carries nothing that says where it belongs.
    expect(d.handed[0]).toEqual(d.written);
    expect(report.segments).toBe(3);
    expect(report.method).toBe('audio_contiguity_v1');
  });

  it('removes the staging directory after a success', async () => {
    const d = deps();
    await remuxPartsToMp4('sid-2', [ftypPart()], 'file:///docs/out.mp4', d);
    expect(d.removed).toEqual(['file:///cache/remux/sid-2/']);
  });

  it('removes the staging directory after a failure too', async () => {
    const d = deps({
      remux: vi.fn(async () => {
        throw Object.assign(new Error('boom'), { code: 'ERR_REMUX_NO_INPUTS' });
      }),
    });
    await expect(
      remuxPartsToMp4('sid-3', [ftypPart()], 'file:///docs/out.mp4', d),
    ).rejects.toBeInstanceOf(RemuxFailed);
    expect(d.removed).toEqual(['file:///cache/remux/sid-3/']);
  });

  it('surfaces the native reason code instead of a generic failure', async () => {
    const d = deps({
      remux: vi.fn(async () => {
        throw Object.assign(new Error('segments out of order'), {
          code: 'ERR_REMUX_NON_ADVANCING_TIMELINE',
        });
      }),
    });
    const err = await remuxPartsToMp4(
      'sid-4',
      [ftypPart()],
      'file:///docs/out.mp4',
      d,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemuxFailed);
    expect((err as RemuxFailed).reason).toBe('ERR_REMUX_NON_ADVANCING_TIMELINE');
  });

  it('refuses an empty set without touching the filesystem', async () => {
    const d = deps();
    await expect(
      remuxPartsToMp4('sid-5', [], 'file:///docs/out.mp4', d),
    ).rejects.toMatchObject({ reason: 'no_parts' });
    expect(d.makeDir).not.toHaveBeenCalled();
    expect(d.remux).not.toHaveBeenCalled();
  });

  it('does not fail the export when cleanup fails', async () => {
    // The staging copies are reproducible from the remote evidence. Losing
    // the cleanup must not lose the export.
    const d = deps({
      removeDir: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    });
    const report = await remuxPartsToMp4(
      'sid-6',
      [ftypPart()],
      'file:///docs/out.mp4',
      d,
    );
    expect(report.segments).toBe(1);
  });
});

describe('source properties · what this module may not contain', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'recording', 'mp4Remux.ts'),
    'utf8',
  );

  /** The file with comments and string literals stripped. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');

  it('never reads a session mode to decide the assembly', () => {
    // `mode === 'video'` is exactly how the pre-existing export path picked
    // the container, and exactly what the medium must NOT come from.
    expect(code).not.toMatch(/\bsession\s*\.\s*mode\b/);
    expect(code).not.toMatch(/\bmode\b\s*===/);
    expect(code).not.toMatch(/\bSessionMode\b/);
  });

  it('never decides anything from a file extension', () => {
    expect(code).not.toMatch(/\.endsWith\s*\(/);
    expect(code).not.toMatch(/\bextension\b/);
  });

  it('keeps the decision function free of I/O', () => {
    const decide = source.slice(
      source.indexOf('export function decideAssembly'),
      source.indexOf('export interface RemuxReport'),
    );
    expect(decide.length).toBeGreaterThan(0);
    for (const forbidden of ['await', 'FileSystem', 'fetch', 'GCSegmentedRecorder']) {
      expect(decide).not.toContain(forbidden);
    }
  });
});
