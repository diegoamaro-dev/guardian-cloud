/**
 * Unit tests for the pure helpers in `manifest.service.ts`.
 *
 * Scope: `buildManifest` and `chunkFileName`. We do NOT exercise
 * `tryGenerateManifest` here — it touches Drive, Supabase and the
 * destinations table, all of which are integration concerns. The unit
 * surface is what matters for the manifest shape contract; an integration
 * test will follow only if a real regression demands it.
 *
 * Pinning value:
 *   - chunk_file_name format pins the formula shared with
 *     `routes/destinations.routes.ts` (chunk upload writer). Any divergence
 *     in either side trips this test and prevents discovery breaking
 *     silently.
 *   - shape pins `schema`, ordering, filtering and `chunk_count` semantics.
 */

import { describe, expect, it } from 'vitest';

import {
  buildManifest,
  chunkFileName,
  type SessionManifest,
} from '../../src/services/manifest.service.js';
import type { ChunkRow } from '../../src/services/chunks.service.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const CREATED_AT = '2026-05-14T10:00:00.000Z';
const COMPLETED_AT = '2026-05-14T10:05:00.000Z';

function mkChunk(overrides: Partial<ChunkRow>): ChunkRow {
  return {
    id: `chunk-${overrides.chunk_index ?? 0}`,
    session_id: SESSION_ID,
    chunk_index: 0,
    hash: 'a'.repeat(64),
    size: 16384,
    status: 'uploaded',
    remote_reference: 'drive-file-id-0',
    created_at: '2026-05-14T10:00:01.000Z',
    updated_at: '2026-05-14T10:00:02.000Z',
    ...overrides,
  };
}

describe('chunkFileName', () => {
  it('pads chunk_index to 6 digits and uses first 12 chars of hash', () => {
    // Pinned against destinations.routes.ts: `${sessionId}_${pad6}_${hash[:12]}.chunk`.
    const hash = 'abcdef0123456789' + '0'.repeat(48);
    expect(chunkFileName(SESSION_ID, 0, hash)).toBe(
      `${SESSION_ID}_000000_abcdef012345.chunk`,
    );
    expect(chunkFileName(SESSION_ID, 7, hash)).toBe(
      `${SESSION_ID}_000007_abcdef012345.chunk`,
    );
    expect(chunkFileName(SESSION_ID, 123456, hash)).toBe(
      `${SESSION_ID}_123456_abcdef012345.chunk`,
    );
  });
});

describe('buildManifest', () => {
  it('emits the v1 schema and core session metadata', () => {
    const manifest: SessionManifest = buildManifest(
      { id: SESSION_ID, mode: 'audio', created_at: CREATED_AT },
      COMPLETED_AT,
      [mkChunk({ chunk_index: 0 })],
    );

    expect(manifest.schema).toBe('guardian-cloud.manifest.v1');
    expect(manifest.session_id).toBe(SESSION_ID);
    expect(manifest.mode).toBe('audio');
    expect(manifest.destination_type).toBe('drive');
    expect(manifest.created_at).toBe(CREATED_AT);
    expect(manifest.completed_at).toBe(COMPLETED_AT);
  });

  it('sorts chunks by chunk_index ascending', () => {
    const chunks: ChunkRow[] = [
      mkChunk({ chunk_index: 2, hash: 'c'.repeat(64) }),
      mkChunk({ chunk_index: 0, hash: 'a'.repeat(64) }),
      mkChunk({ chunk_index: 1, hash: 'b'.repeat(64) }),
    ];

    const manifest = buildManifest(
      { id: SESSION_ID, mode: 'audio', created_at: CREATED_AT },
      COMPLETED_AT,
      chunks,
    );

    expect(manifest.chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2]);
  });

  it('filters out chunks not uploaded or missing remote_reference', () => {
    const chunks: ChunkRow[] = [
      mkChunk({ chunk_index: 0, status: 'uploaded', remote_reference: 'd0' }),
      mkChunk({ chunk_index: 1, status: 'pending', remote_reference: null }),
      mkChunk({ chunk_index: 2, status: 'failed', remote_reference: null }),
      mkChunk({ chunk_index: 3, status: 'uploaded', remote_reference: null }),
      mkChunk({ chunk_index: 4, status: 'uploaded', remote_reference: 'd4' }),
    ];

    const manifest = buildManifest(
      { id: SESSION_ID, mode: 'audio', created_at: CREATED_AT },
      COMPLETED_AT,
      chunks,
    );

    expect(manifest.chunks.map((c) => c.chunk_index)).toEqual([0, 4]);
  });

  it('reports chunk_count from the FILTERED set, not the raw rows', () => {
    const chunks: ChunkRow[] = [
      mkChunk({ chunk_index: 0, status: 'uploaded', remote_reference: 'd0' }),
      mkChunk({ chunk_index: 1, status: 'pending', remote_reference: null }),
      mkChunk({ chunk_index: 2, status: 'uploaded', remote_reference: 'd2' }),
    ];

    const manifest = buildManifest(
      { id: SESSION_ID, mode: 'audio', created_at: CREATED_AT },
      COMPLETED_AT,
      chunks,
    );

    expect(manifest.chunk_count).toBe(2);
    expect(manifest.chunks.length).toBe(2);
  });

  it('produces file_name with padded index and short hash for each chunk', () => {
    const hashA = 'aabbccddeeff' + '0'.repeat(52);
    const hashB = '112233445566' + '0'.repeat(52);
    const chunks: ChunkRow[] = [
      mkChunk({ chunk_index: 0, hash: hashA, remote_reference: 'd0' }),
      mkChunk({ chunk_index: 17, hash: hashB, remote_reference: 'd17' }),
    ];

    const manifest = buildManifest(
      { id: SESSION_ID, mode: 'audio', created_at: CREATED_AT },
      COMPLETED_AT,
      chunks,
    );

    expect(manifest.chunks[0]!.file_name).toBe(
      `${SESSION_ID}_000000_aabbccddeeff.chunk`,
    );
    expect(manifest.chunks[1]!.file_name).toBe(
      `${SESSION_ID}_000017_112233445566.chunk`,
    );
  });

  it('omits format for audio sessions', () => {
    const manifest = buildManifest(
      { id: SESSION_ID, mode: 'audio', created_at: CREATED_AT },
      COMPLETED_AT,
      [mkChunk({ chunk_index: 0 })],
    );
    expect(manifest.format).toBeUndefined();
  });

  it("sets format='mp4' for video sessions", () => {
    const manifest = buildManifest(
      { id: SESSION_ID, mode: 'video', created_at: CREATED_AT },
      COMPLETED_AT,
      [mkChunk({ chunk_index: 0 })],
    );
    expect(manifest.format).toBe('mp4');
  });

  it('returns an empty chunks array and chunk_count=0 when no chunks qualify', () => {
    const chunks: ChunkRow[] = [
      mkChunk({ chunk_index: 0, status: 'pending', remote_reference: null }),
      mkChunk({ chunk_index: 1, status: 'failed', remote_reference: null }),
    ];

    const manifest = buildManifest(
      { id: SESSION_ID, mode: 'audio', created_at: CREATED_AT },
      COMPLETED_AT,
      chunks,
    );

    expect(manifest.chunk_count).toBe(0);
    expect(manifest.chunks).toEqual([]);
  });

  it('does not include remote_reference or other Drive internals in chunk entries', () => {
    const manifest = buildManifest(
      { id: SESSION_ID, mode: 'audio', created_at: CREATED_AT },
      COMPLETED_AT,
      [mkChunk({ chunk_index: 0, remote_reference: 'drive-file-id-secret' })],
    );

    const chunk = manifest.chunks[0]!;
    expect(Object.keys(chunk).sort()).toEqual([
      'chunk_index',
      'file_name',
      'hash',
      'size',
    ]);
    expect(JSON.stringify(manifest)).not.toContain('drive-file-id-secret');
    expect(JSON.stringify(manifest)).not.toContain('remote_reference');
  });
});
