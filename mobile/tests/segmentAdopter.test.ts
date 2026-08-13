/**
 * Unit tests for the segment adopter.
 *
 * The adopter is now free of any `app/` import, so it can be exercised with a
 * fake queue sink and an in-memory filesystem. Two rules shape these tests:
 *
 *   - the digest mock computes a REAL sha256 over the bytes it receives. A
 *     constant would make every integrity assertion vacuous, which is the
 *     opposite of what this module exists to guarantee.
 *   - failures are asserted as returned `AdoptionRecord`s, never as throws.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------- in-memory filesystem

/** uri → bytes. The only storage these tests know about. */
const disk = new Map<string, Buffer>();

/** Swappable copy behaviour so a test can break the copy on purpose. */
type CopyArgs = { from: string; to: string };
let copyImpl: (args: CopyArgs) => Promise<void>;

const realCopy = async ({ from, to }: CopyArgs): Promise<void> => {
  const bytes = disk.get(from);
  if (bytes) disk.set(to, Buffer.from(bytes));
};

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  makeDirectoryAsync: vi.fn(async () => undefined),
  copyAsync: vi.fn((args: CopyArgs) => copyImpl(args)),
  getInfoAsync: vi.fn(async (uri: string) => {
    const bytes = disk.get(uri);
    return bytes ? { exists: true, size: bytes.length } : { exists: false };
  }),
  readAsStringAsync: vi.fn(async (uri: string) => {
    const bytes = disk.get(uri);
    if (!bytes) throw new Error(`ENOENT ${uri}`);
    return bytes.toString('base64');
  }),
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: vi.fn(async (_alg: string, bytes: Uint8Array) => {
    const h = createHash('sha256').update(Buffer.from(bytes)).digest();
    return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
  }),
}));

import {
  adoptSegment,
  stableSegmentUri,
  type AdoptableChunk,
  type ClosedSegment,
  type QueueSink,
} from '@/video/segmentAdopter';

// ----------------------------------------------------------------- fixtures

const SID = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'file:///cache/gc-p2-gate/seg_000.mp4';
const A = Buffer.from('AAAAAAAAAAAAAAAA');
const B = Buffer.from('BBBBBBBBBBBBBBBBBBBBBBBB');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function makeSink(): QueueSink & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    appendChunk: vi.fn(async (...args: unknown[]) => {
      calls.push(args);
    }) as unknown as QueueSink['appendChunk'],
  };
}

function ev(index = 0, path = SOURCE, sizeBytes = A.length): ClosedSegment {
  return { sessionId: SID, segmentIndex: index, path, sizeBytes };
}

/** Every assertion that must hold no matter which branch was taken. */
function expectSourceIntact(bytes: Buffer): void {
  expect(disk.has(SOURCE)).toBe(true);
  expect(disk.get(SOURCE)!.equals(bytes)).toBe(true);
}

function expectContract(call: unknown[], index: number, bytes: Buffer): void {
  const [sessionId, chunk, emitted, next] = call as [
    string,
    AdoptableChunk,
    number | null,
    number,
  ];
  expect(sessionId).toBe(SID);
  expect(emitted).toBeNull();
  expect(next).toBe(index + 1);
  expect(Object.keys(chunk).sort()).toEqual([
    'attempts',
    'chunk_index',
    'hash',
    'local_uri',
    'size',
    'status',
  ]);
  expect(chunk.chunk_index).toBe(index);
  expect(chunk.status).toBe('pending');
  expect(chunk.attempts).toBe(0);
  expect(chunk.size).toBe(bytes.length);
  expect(chunk.hash).toBe(sha(bytes));
  expect(chunk.local_uri).toBe(stableSegmentUri(SID, index));
}

beforeEach(() => {
  disk.clear();
  copyImpl = realCopy;
  vi.clearAllMocks();
});

// -------------------------------------------------------------------- cases

describe('adoptSegment', () => {
  it('1 · copies, verifies and enqueues a valid source', async () => {
    disk.set(SOURCE, Buffer.from(A));
    const sink = makeSink();

    const rec = await adoptSegment(ev(), 1_000, sink);

    expect(rec.outcome).toBe('adopted');
    expect(rec.sha256).toBe(sha(A));
    expect(rec.sizeBytes).toBe(A.length);
    expect(disk.get(stableSegmentUri(SID, 0))!.equals(A)).toBe(true);
    expect(sink.calls).toHaveLength(1);
    expectContract(sink.calls[0]!, 0, A);
    expectSourceIntact(A);
  });

  it('2 · treats an identical stable copy as already adopted, idempotently', async () => {
    disk.set(SOURCE, Buffer.from(A));
    disk.set(stableSegmentUri(SID, 0), Buffer.from(A));
    const sink = makeSink();

    const rec = await adoptSegment(ev(), 1_000, sink);

    expect(rec.outcome).toBe('already_adopted');
    expect(rec.sha256).toBe(sha(A));
    expect(sink.calls).toHaveLength(1);
    expectContract(sink.calls[0]!, 0, A);
    expectSourceIntact(A);
  });

  it('3 · reports a conflict without enqueuing or overwriting', async () => {
    disk.set(SOURCE, Buffer.from(A));
    disk.set(stableSegmentUri(SID, 0), Buffer.from(B));
    const sink = makeSink();

    const rec = await adoptSegment(ev(), 1_000, sink);

    expect(rec.outcome).toBe('conflict');
    expect(rec.error).toContain('different bytes');
    expect(sink.calls).toHaveLength(0);
    expect(disk.get(stableSegmentUri(SID, 0))!.equals(B)).toBe(true);
    expectSourceIntact(A);
  });

  it('4 · fails when the copy never materialises', async () => {
    disk.set(SOURCE, Buffer.from(A));
    copyImpl = async () => undefined;
    const sink = makeSink();

    const rec = await adoptSegment(ev(), 1_000, sink);

    expect(rec.outcome).toBe('failed');
    expect(rec.error).toContain('copy not present');
    expect(sink.calls).toHaveLength(0);
    expectSourceIntact(A);
  });

  it('5 · fails when the copy has a different size', async () => {
    disk.set(SOURCE, Buffer.from(A));
    copyImpl = async ({ to }) => {
      disk.set(to, Buffer.concat([A, Buffer.from('EXTRA')]));
    };
    const sink = makeSink();

    const rec = await adoptSegment(ev(), 1_000, sink);

    expect(rec.outcome).toBe('failed');
    expect(rec.error).toContain('size');
    expect(sink.calls).toHaveLength(0);
    expectSourceIntact(A);
  });

  it('6 · fails when the copy has the same size but a different hash', async () => {
    disk.set(SOURCE, Buffer.from(A));
    const sameLengthOtherBytes = Buffer.alloc(A.length, 0x5a);
    copyImpl = async ({ to }) => {
      disk.set(to, sameLengthOtherBytes);
    };
    const sink = makeSink();

    const rec = await adoptSegment(ev(), 1_000, sink);

    expect(rec.outcome).toBe('failed');
    expect(rec.error).toContain('sha');
    expect(sink.calls).toHaveLength(0);
    expectSourceIntact(A);
  });

  it('7 · collapses two overlapping adoptions into one execution', async () => {
    disk.set(SOURCE, Buffer.from(A));
    const sink = makeSink();

    // Barrier: the copy blocks until both calls are in flight, so the second
    // one is guaranteed to hit the in-flight guard rather than run after the
    // first has finished. Two sequential awaits would not prove that.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    copyImpl = async (args) => {
      entered += 1;
      await gate;
      await realCopy(args);
    };

    const p1 = adoptSegment(ev(), 1_000, sink);
    const p2 = adoptSegment(ev(), 1_000, sink);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(entered).toBe(1);
    expect(r1).toBe(r2);
    expect(r1.outcome).toBe('adopted');
    expect(sink.calls).toHaveLength(1);
    expectContract(sink.calls[0]!, 0, A);
    expectSourceIntact(A);
  });

  it('never throws: every failure comes back as a record', async () => {
    disk.set(SOURCE, Buffer.from(A));
    copyImpl = async () => {
      throw new Error('disk on fire');
    };
    const sink = makeSink();

    const rec = await adoptSegment(ev(), 1_000, sink);

    expect(rec.outcome).toBe('failed');
    expect(rec.error).toContain('disk on fire');
    expect(sink.calls).toHaveLength(0);
    expectSourceIntact(A);
  });
});
