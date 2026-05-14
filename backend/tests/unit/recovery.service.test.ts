/**
 * Unit tests for the pure helpers in `recovery.service.ts`:
 *   - parseManifest (strict JSON validator)
 *   - classifyProtection (chunk_count → status)
 *   - dedupAndSort (dedup by session_id + newest-modifiedTime wins,
 *     output sorted by completed_at desc)
 *
 * Drive, Supabase and the route layer are out of scope — those are
 * integration concerns. The unit surface here pins the discovery
 * contract: any change to the manifest shape, the protection rule, or
 * the dedup policy must come with a corresponding test edit.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyProtection,
  dedupAndSort,
  parseManifest,
} from '../../src/services/recovery.service.js';

const SID_A = '11111111-1111-1111-1111-111111111111';
const SID_B = '22222222-2222-2222-2222-222222222222';

function validManifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: 'guardian-cloud.manifest.v1',
    session_id: SID_A,
    mode: 'audio',
    destination_type: 'drive',
    created_at: '2026-05-14T10:00:00.000Z',
    completed_at: '2026-05-14T10:05:00.000Z',
    chunk_count: 3,
    chunks: [
      { chunk_index: 0, hash: 'a'.repeat(64), size: 16384, file_name: 'x' },
      { chunk_index: 1, hash: 'b'.repeat(64), size: 16384, file_name: 'x' },
      { chunk_index: 2, hash: 'c'.repeat(64), size: 16384, file_name: 'x' },
    ],
    ...overrides,
  };
}

describe('parseManifest', () => {
  it('accepts a valid v1 manifest and returns the discovery-facing subset', () => {
    const parsed = parseManifest(validManifest());
    expect(parsed).toEqual({
      session_id: SID_A,
      mode: 'audio',
      created_at: '2026-05-14T10:00:00.000Z',
      completed_at: '2026-05-14T10:05:00.000Z',
      chunk_count: 3,
    });
  });

  it('accepts video mode', () => {
    const parsed = parseManifest(validManifest({ mode: 'video' }));
    expect(parsed?.mode).toBe('video');
  });

  it('rejects unknown schema versions', () => {
    expect(parseManifest(validManifest({ schema: 'guardian-cloud.manifest.v2' }))).toBeNull();
    expect(parseManifest(validManifest({ schema: 'something-else' }))).toBeNull();
    expect(parseManifest(validManifest({ schema: undefined }))).toBeNull();
  });

  it('rejects non-object inputs', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest(undefined)).toBeNull();
    expect(parseManifest('not an object')).toBeNull();
    expect(parseManifest(42)).toBeNull();
    // Note: typeof [] === 'object', but the manifest shape requires fields
    // by name, so the schema check filters arrays out.
    expect(parseManifest([])).toBeNull();
  });

  it('rejects malformed session_id', () => {
    expect(parseManifest(validManifest({ session_id: 'not-a-uuid' }))).toBeNull();
    expect(parseManifest(validManifest({ session_id: '' }))).toBeNull();
    expect(parseManifest(validManifest({ session_id: 12345 }))).toBeNull();
  });

  it('rejects unknown mode values', () => {
    expect(parseManifest(validManifest({ mode: 'image' }))).toBeNull();
    expect(parseManifest(validManifest({ mode: '' }))).toBeNull();
    expect(parseManifest(validManifest({ mode: undefined }))).toBeNull();
  });

  it('rejects missing or non-string dates', () => {
    expect(parseManifest(validManifest({ created_at: undefined }))).toBeNull();
    expect(parseManifest(validManifest({ completed_at: 1234567890 }))).toBeNull();
    expect(parseManifest(validManifest({ created_at: 'short' }))).toBeNull();
  });

  it('rejects negative, non-finite, or non-numeric chunk_count', () => {
    expect(parseManifest(validManifest({ chunk_count: -1 }))).toBeNull();
    expect(parseManifest(validManifest({ chunk_count: 'three' }))).toBeNull();
    expect(parseManifest(validManifest({ chunk_count: Number.NaN }))).toBeNull();
    expect(parseManifest(validManifest({ chunk_count: Infinity }))).toBeNull();
  });

  it('accepts chunk_count === 0 (manifest exists but represents partial protection)', () => {
    // COMMIT 1 skips generation in this case, but the validator must not
    // reject it on its own — `classifyProtection` is the layer that
    // decides what 0 means downstream.
    const parsed = parseManifest(validManifest({ chunk_count: 0, chunks: [] }));
    expect(parsed?.chunk_count).toBe(0);
  });
});

describe('classifyProtection', () => {
  it("returns 'complete' when chunk_count > 0", () => {
    expect(classifyProtection(1)).toBe('complete');
    expect(classifyProtection(42)).toBe('complete');
  });

  it("returns 'partial' when chunk_count === 0", () => {
    expect(classifyProtection(0)).toBe('partial');
  });
});

describe('dedupAndSort', () => {
  function cand(
    sessionId: string,
    completedAt: string,
    modifiedTime: string,
    fileId: string,
  ) {
    return {
      parsed: {
        session_id: sessionId,
        mode: 'audio' as const,
        created_at: '2026-05-14T09:00:00.000Z',
        completed_at: completedAt,
        chunk_count: 3,
      },
      manifest_file_id: fileId,
      modifiedTime,
    };
  }

  it('returns a single RecoverableSession per session_id', () => {
    const out = dedupAndSort([
      cand(SID_A, '2026-05-14T10:00:00.000Z', '2026-05-14T10:00:01.000Z', 'A1'),
      cand(SID_A, '2026-05-14T10:00:00.000Z', '2026-05-14T10:00:05.000Z', 'A2'),
      cand(SID_B, '2026-05-14T11:00:00.000Z', '2026-05-14T11:00:00.500Z', 'B1'),
    ]);

    expect(out).toHaveLength(2);
    const a = out.find((e) => e.session_id === SID_A);
    const b = out.find((e) => e.session_id === SID_B);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it('keeps the manifest with the most recent modifiedTime when session_id collides', () => {
    const out = dedupAndSort([
      cand(SID_A, '2026-05-14T10:00:00.000Z', '2026-05-14T10:00:01.000Z', 'OLD'),
      cand(SID_A, '2026-05-14T10:00:00.000Z', '2026-05-14T10:00:09.000Z', 'NEW'),
      cand(SID_A, '2026-05-14T10:00:00.000Z', '2026-05-14T10:00:05.000Z', 'MID'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.manifest_file_id).toBe('NEW');
  });

  it('sorts the output by completed_at descending', () => {
    const out = dedupAndSort([
      cand(SID_A, '2026-05-14T10:00:00.000Z', 't1', 'A'),
      cand(SID_B, '2026-05-14T12:00:00.000Z', 't2', 'B'),
    ]);
    expect(out.map((e) => e.session_id)).toEqual([SID_B, SID_A]);
  });

  it('derives protection_status via classifyProtection', () => {
    const out = dedupAndSort([
      {
        parsed: {
          session_id: SID_A,
          mode: 'audio',
          created_at: '2026-05-14T09:00:00.000Z',
          completed_at: '2026-05-14T10:00:00.000Z',
          chunk_count: 5,
        },
        manifest_file_id: 'A',
        modifiedTime: 't1',
      },
      {
        parsed: {
          session_id: SID_B,
          mode: 'audio',
          created_at: '2026-05-14T09:00:00.000Z',
          completed_at: '2026-05-14T09:00:00.000Z',
          chunk_count: 0,
        },
        manifest_file_id: 'B',
        modifiedTime: 't2',
      },
    ]);
    const a = out.find((e) => e.session_id === SID_A);
    const b = out.find((e) => e.session_id === SID_B);
    expect(a?.protection_status).toBe('complete');
    expect(b?.protection_status).toBe('partial');
  });

  it('returns an empty array when given no candidates (empty discovery)', () => {
    expect(dedupAndSort([])).toEqual([]);
  });

  it('preserves manifest_file_id for downstream COMMIT 3 use', () => {
    const out = dedupAndSort([
      cand(SID_A, '2026-05-14T10:00:00.000Z', 't1', 'drive-file-id-AAA'),
    ]);
    expect(out[0]!.manifest_file_id).toBe('drive-file-id-AAA');
  });

  it('does not surface raw chunk hashes or any field outside RecoverableSession', () => {
    const out = dedupAndSort([
      cand(SID_A, '2026-05-14T10:00:00.000Z', 't1', 'A'),
    ]);
    expect(Object.keys(out[0]!).sort()).toEqual([
      'chunk_count',
      'completed_at',
      'created_at',
      'manifest_file_id',
      'mode',
      'protection_status',
      'session_id',
    ]);
  });
});
