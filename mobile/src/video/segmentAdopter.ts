/**
 * S2 SPIKE — segment adoption. ISOLATED.
 *
 * Turns one `onSegmentClosed` event from the native P2 recorder into exactly
 * one GC_QUEUE chunk, and nothing else. It does not upload, retry, delete,
 * export, or keep any state of its own beyond an in-flight guard.
 *
 * The whole reason this file exists: the productive video path chunks ONE
 * growing MP4 by byte ranges (`byteOffset`/`byteLength` into `entry.uri`).
 * The P2 recorder produces N self-contained MP4s instead, so that model does
 * not apply. But GC_QUEUE already accepts a chunk whose `local_uri` is a
 * complete file — `rehydrateChunkSlice` reads it whole and the existing worker
 * uploads it unchanged. So one segment = one chunk, and no upload machinery
 * needs to be built, modified or duplicated.
 *
 * Durability rule for S2 (deliberately weaker than the S1 journal, which stays
 * frozen and unused here): COPY, VERIFY, KEEP BOTH. The native segment lives in
 * the app's private CACHE, which Android may reclaim; the queue must reference
 * something we own. A destructive move would create one more boundary at which
 * the only copy could be lost, and S2 has no journal or recovery behind it to
 * survive that. So nothing is ever deleted here — not the source, not the copy.
 *
 * Out of scope by contract: journal, recovery, repair, deletion, remux/export,
 * audio, productive UI, any change to GC_QUEUE, the worker or the recorder.
 */
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Contrato mínimo que este módulo consume. Se declara aquí, y no se importa
 * de la capa de rutas, para que el adoptador sea comprobable de forma aislada
 * y no invierta la dirección de dependencias.
 */
export interface AdoptableChunk {
  chunk_index: number;
  hash: string;
  size: number;
  status: 'pending';
  attempts: number;
  local_uri: string;
}

/** Destino de encolado. Se inyecta; nunca se resuelve por variable global. */
export interface QueueSink {
  appendChunk: (
    sessionId: string,
    chunk: AdoptableChunk,
    emittedBase64Length: number | null,
    nextChunkIndex: number,
  ) => Promise<void>;
}

/** Where a verified copy lives. Deterministic in (sessionId, segmentIndex). */
export function stableSegmentUri(sessionId: string, segmentIndex: number): string {
  return `${stableSegmentDir(sessionId)}segment_${String(segmentIndex).padStart(6, '0')}.mp4`;
}

export function stableSegmentDir(sessionId: string): string {
  // Deliberately NOT `documentDirectory/chunks/<sid>/`: that directory is
  // wiped wholesale by `reapEntry`, and these files must outlive the queue
  // entry so the evidence can still be hashed after the session completes.
  return `${FileSystem.documentDirectory}segments/${sessionId}/`;
}

export type AdoptionOutcome =
  /** Copied, verified byte-for-byte, and handed to GC_QUEUE. */
  | 'adopted'
  /** The same bytes were already adopted; the queue append is re-asserted. */
  | 'already_adopted'
  /** The stable path holds DIFFERENT bytes. Nothing was overwritten or queued. */
  | 'conflict'
  /** Copy or verification failed. Nothing was queued; both files are intact. */
  | 'failed';

export interface AdoptionTimings {
  /** sha256 of the source file, including the read. */
  hashSourceMs: number;
  copyMs: number;
  /** sha256 of the copy, including the read. */
  hashCopyMs: number;
  /** `queueAppendChunk` alone — the serialized AsyncStorage write. */
  enqueueMs: number;
  /** Native segment-closed timestamp → chunk visible in GC_QUEUE. */
  closedToEnqueueMs: number;
  totalMs: number;
}

export interface AdoptionRecord {
  outcome: AdoptionOutcome;
  sessionId: string;
  segmentIndex: number;
  sourcePath: string;
  sourceUri: string;
  stableUri: string;
  /** Size measured from the bytes, not taken from the event. */
  sizeBytes: number;
  /** sha256 of the DECODED bytes — the same convention the backend recomputes. */
  sha256: string | null;
  /** Size the native event advertised, for cross-checking only. */
  eventSizeBytes: number;
  closedAtMs: number;
  enqueuedAtMs: number | null;
  timings: AdoptionTimings;
  error?: string;
}

/** Minimal shape this module needs from the native event. */
export interface ClosedSegment {
  sessionId: string;
  segmentIndex: number;
  path: string;
  sizeBytes: number;
}

/**
 * In-flight adoptions keyed by `${sessionId}#${index}`.
 *
 * A repeated event for the same segment must converge to ONE queue entry. The
 * queue's own append is already idempotent by `chunk_index`, but two concurrent
 * adoptions would still race on the copy — both writing the same destination
 * path at the same time. Awaiting the first one removes the race entirely.
 */
const inFlight = new Map<string, Promise<AdoptionRecord>>();

function uriOf(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/**
 * base64 → raw bytes. Same decode the productive hash path uses.
 *
 * The explicit `Uint8Array<ArrayBuffer>` is not decoration: `Crypto.digest`
 * takes a `BufferSource`, which under this TypeScript version excludes the
 * default `Uint8Array<ArrayBufferLike>`. Pinning the buffer type here keeps
 * these two files free of casts. (`app/index.tsx:2804`, `src/api/export.ts`
 * and `src/api/destinations.ts` still carry that pre-existing error — see the
 * report; it is a lib-version artifact, not a runtime fault.)
 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function digestToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * sha256 of a file's DECODED bytes, as lowercase hex.
 *
 * Must stay identical to the productive convention: the backend recomputes
 * sha256 over the raw body it receives at `/destinations/drive/chunks`, and the
 * Drive filename is derived from that same value. Hashing the base64 text
 * instead would diverge and fire HASH_MISMATCH at the proxy.
 */
/**
 * sha256 of bytes already in memory — used to re-hash what came back down from
 * Drive. The copy is what makes the view's buffer a plain `ArrayBuffer` for
 * `Crypto.digest`; it costs one allocation on the verification path only,
 * never during recording.
 */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes);
  return digestToHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, owned));
}

export async function sha256OfFile(uri: string): Promise<{ hash: string; size: number }> {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = base64ToBytes(b64);
  const hash = digestToHex(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  );
  return { hash, size: bytes.length };
}

async function fileExists(uri: string): Promise<{ exists: boolean; size: number }> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return { exists: false, size: -1 };
  const size = 'size' in info && typeof info.size === 'number' ? info.size : -1;
  return { exists: true, size };
}

/**
 * COPY → VERIFY → ENQUEUE. Never moves, never deletes, never overwrites
 * different bytes.
 *
 *   1. hash the source in cache
 *   2. if the stable path is taken: same bytes → already adopted
 *                                   different bytes → conflict, stop
 *   3. copy to the stable path
 *   4. confirm it exists
 *   5. confirm its size
 *   6. confirm its sha256 equals the source's
 *   7. enqueue the COPY only
 *   8. leave the source where it is
 */
export function adoptSegment(
  ev: ClosedSegment,
  closedAtMs: number,
  queue: QueueSink,
): Promise<AdoptionRecord> {
  const key = `${ev.sessionId}#${ev.segmentIndex}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = adoptSegmentInner(ev, closedAtMs, queue).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

async function adoptSegmentInner(
  ev: ClosedSegment,
  closedAtMs: number,
  queue: QueueSink,
): Promise<AdoptionRecord> {
  const t0 = Date.now();
  const sourceUri = uriOf(ev.path);
  const stableUri = stableSegmentUri(ev.sessionId, ev.segmentIndex);
  const timings: AdoptionTimings = {
    hashSourceMs: 0, copyMs: 0, hashCopyMs: 0, enqueueMs: 0,
    closedToEnqueueMs: 0, totalMs: 0,
  };
  const base = {
    sessionId: ev.sessionId,
    segmentIndex: ev.segmentIndex,
    sourcePath: ev.path,
    sourceUri,
    stableUri,
    eventSizeBytes: ev.sizeBytes,
    closedAtMs,
  };

  try {
    await FileSystem.makeDirectoryAsync(stableSegmentDir(ev.sessionId), {
      intermediates: true,
    });

    // 1 — the source is the reference for everything that follows.
    const tHashSrc = Date.now();
    const src = await sha256OfFile(sourceUri);
    timings.hashSourceMs = Date.now() - tHashSrc;

    // 2 — a destination that already holds bytes is never overwritten.
    const existing = await fileExists(stableUri);
    if (existing.exists) {
      const prev = await sha256OfFile(stableUri);
      if (prev.hash === src.hash) {
        // Same segment offered twice. Re-assert the queue append (idempotent
        // by chunk_index) so a repeat cannot leave the queue short.
        const tq = Date.now();
        await enqueue(queue, ev, stableUri, src.hash, src.size);
        timings.enqueueMs = Date.now() - tq;
        timings.closedToEnqueueMs = Date.now() - closedAtMs;
        timings.totalMs = Date.now() - t0;
        return {
          ...base, outcome: 'already_adopted', sizeBytes: src.size,
          sha256: src.hash, enqueuedAtMs: Date.now(), timings,
        };
      }
      timings.totalMs = Date.now() - t0;
      return {
        ...base, outcome: 'conflict', sizeBytes: src.size, sha256: src.hash,
        enqueuedAtMs: null, timings,
        error:
          `stable path already holds different bytes: ` +
          `existing sha=${prev.hash.slice(0, 12)} size=${prev.size}, ` +
          `incoming sha=${src.hash.slice(0, 12)} size=${src.size}`,
      };
    }

    // 3 — copy. The source stays exactly where it is.
    const tCopy = Date.now();
    await FileSystem.copyAsync({ from: sourceUri, to: stableUri });
    timings.copyMs = Date.now() - tCopy;

    // 4, 5 — the copy must be there, with the right length.
    const after = await fileExists(stableUri);
    if (!after.exists) {
      timings.totalMs = Date.now() - t0;
      return {
        ...base, outcome: 'failed', sizeBytes: src.size, sha256: src.hash,
        enqueuedAtMs: null, timings, error: 'copy not present after copyAsync',
      };
    }
    if (after.size !== src.size) {
      timings.totalMs = Date.now() - t0;
      return {
        ...base, outcome: 'failed', sizeBytes: src.size, sha256: src.hash,
        enqueuedAtMs: null, timings,
        error: `copy size ${after.size} != source size ${src.size}`,
      };
    }

    // 6 — and it must be the same bytes, not merely the same length.
    const tHashCopy = Date.now();
    const copy = await sha256OfFile(stableUri);
    timings.hashCopyMs = Date.now() - tHashCopy;
    if (copy.hash !== src.hash) {
      timings.totalMs = Date.now() - t0;
      return {
        ...base, outcome: 'failed', sizeBytes: src.size, sha256: src.hash,
        enqueuedAtMs: null, timings,
        error: `copy sha ${copy.hash.slice(0, 12)} != source sha ${src.hash.slice(0, 12)}`,
      };
    }

    // 7 — only a verified copy is ever handed to GC_QUEUE.
    const tq = Date.now();
    await enqueue(queue, ev, stableUri, src.hash, src.size);
    timings.enqueueMs = Date.now() - tq;
    const enqueuedAtMs = Date.now();
    timings.closedToEnqueueMs = enqueuedAtMs - closedAtMs;
    timings.totalMs = enqueuedAtMs - t0;

    return {
      ...base, outcome: 'adopted', sizeBytes: src.size, sha256: src.hash,
      enqueuedAtMs, timings,
    };
  } catch (err) {
    timings.totalMs = Date.now() - t0;
    return {
      ...base, outcome: 'failed', sizeBytes: -1, sha256: null,
      enqueuedAtMs: null, timings,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The ONLY write this module performs on GC_QUEUE, through the existing
 * serialized primitive. `emittedBase64Length` is `null` because that field is
 * audio bookkeeping; `nextChunkIndex` follows the segment index because the
 * native recorder emits segments strictly in order.
 */
async function enqueue(
  queue: QueueSink,
  ev: ClosedSegment,
  stableUri: string,
  hash: string,
  size: number,
): Promise<void> {
  const chunk: AdoptableChunk = {
    chunk_index: ev.segmentIndex,
    hash,
    size,
    status: 'pending',
    attempts: 0,
    local_uri: stableUri,
  };
  await queue.appendChunk(ev.sessionId, chunk, null, ev.segmentIndex + 1);
}
