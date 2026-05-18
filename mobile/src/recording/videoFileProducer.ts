import * as FileSystem from 'expo-file-system/legacy';

import type { ChunkPayload, ChunkProducer } from './chunkProducer';

/**
 * Video post-stop chunk size.
 *
 * History:
 *   - 16 KB matched the audio chunker but produced ~1300 chunks for a
 *     21 MB MP4 (HTTP fan-out hell, UI stuck around 5/100).
 *   - 256 KB (pre disk-backed era) cut chunk count ~16x but each
 *     base64Slice was ~352 KB and the GC_QUEUE row blew past Android
 *     SQLite's CursorWindow ~2 MB per-row limit after only a handful
 *     of un-pruned chunks. Symptoms were `OutOfMemoryError` reading
 *     the file as base64 (separate issue, addressed by the size guard
 *     below) AND `Row too big to fit into CursorWindow` on every
 *     queueRead afterwards.
 *   - 64 KB held briefly but the matching 2 MB max-video cap was too
 *     strict: ordinary tiny recordings (~3 MB) were rejected outright.
 *   - 32 KB was the disk-backed-era setting that traded request fan-out
 *     for a queue-row-size safety margin.
 *   - 128 KB is the CURRENT setting (2026-05-18 bump). Rationale:
 *       The CursorWindow constraint above no longer applies. The video
 *       post-stop pipeline persists base64 as a per-chunk file under
 *       `documentDirectory/chunks/{sid}/{idx}.b64` and the GC_QUEUE row
 *       carries ONLY metadata (`{chunk_index, hash, size, status,
 *       attempts, local_uri}`) — never `base64Slice` inline. Queue row
 *       size is therefore invariant to chunk size; only the per-chunk
 *       file size on disk scales (~172 KB at 128 KB chunks). Memory
 *       peak is dominated by the whole-file base64 read in `chunkFile`
 *       (~6.7 MB for a 5 MB MP4), which is independent of chunk size.
 *       Reducing chunk count 4x (5 MB / 32 KB = ~160 chunks → 5 MB /
 *       128 KB = ~40 chunks) cuts HTTP request fan-out by the same
 *       factor and shortens total upload wall-clock proportionally.
 *
 * `VIDEO_MAX_SIZE_BYTES` below is unchanged — the binding constraint
 * for that cap is the OOM ceiling on the whole-file base64 read, NOT
 * CursorWindow. Both apply independently.
 */
const VIDEO_FILE_CHUNK_SIZE_BYTES = 128 * 1024;

/** Base64-char count derived from the byte size — same formula audio uses. */
const VIDEO_FILE_CHUNK_SIZE_BASE64 =
  Math.ceil(Math.ceil((VIDEO_FILE_CHUNK_SIZE_BYTES * 4) / 3) / 4) * 4;

/**
 * Hard cap on input video size for MVP.
 *
 * History:
 *   - 50 MB → OOM on readAsStringAsync(base64) for files past ~30 MB.
 *   - 10 MB → (pre disk-backed era) CursorWindow blow-up: a 7.6 MB
 *     video produced 117 chunks (~16 MB peak base64 in queue, far over
 *     the ~2 MB SQLite per-row limit). Also corrupted the queue
 *     mid-emission. NOTE: this rationale no longer applies — chunks
 *     persist as per-file base64 on disk, not inline in the queue row.
 *   - 2 MB → over-correction: a normal short recording is ~3 MB and
 *     was rejected outright before any chunk could be emitted.
 *   - 5 MB is the current balance. The binding constraint TODAY is the
 *     OOM ceiling on the single `readAsStringAsync(uri, base64)` call
 *     inside `chunkFile`: a 5 MB MP4 becomes a ~6.7 MB JS string, well
 *     under the OOM threshold seen at ~30 MB. Chunk count for a 5 MB
 *     file at 128 KB chunks → ~40 chunks (~172 KB per-chunk file on
 *     disk under `chunks/{sid}/{idx}.b64`). Queue row size is now
 *     invariant to chunk size because base64 lives on disk, not inline.
 *
 * Above this cap we fail FAST (before any base64 read or queue
 * mutation). Long video is explicitly out of MVP scope until the
 * whole-file base64 read is replaced with a streaming or partial-read
 * implementation (the OOM ceiling — NOT CursorWindow — is what blocks
 * raising this cap further).
 */
const VIDEO_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Video post-stop producer.
 *
 * The recorder writes a single .mp4 file in `cacheDirectory` while
 * recording; THIS PRODUCER DOES NOT TOUCH THAT FILE DURING RECORDING.
 * After the host calls `stop()` and moves the finalized file into
 * `documentDirectory`, the host then calls `chunkFile(uri)` (a
 * non-interface method, since `ChunkProducer` has no slot for the
 * source URI). This producer reads the whole file as base64, slices
 * into `VIDEO_FILE_CHUNK_SIZE_BYTES`-equivalent base64 chars (128 KB
 * → `VIDEO_FILE_CHUNK_SIZE_BASE64` chars), and emits each via the
 * registered `onChunk` callback in chunk_index order. The last chunk
 * carries `isFinal: true`. Chunk size is sized for HTTP-request
 * fan-out — not for queue-row pressure, since the post-stop sink
 * persists base64 to disk via `local_uri` and the queue row carries
 * only metadata.
 *
 * The producer never talks to the queue, the upload worker, or the
 * backend. The host's `onChunk` callback is the single integration
 * surface.
 */
export class VideoFileChunkProducer implements ChunkProducer {
  private callback: ((chunk: ChunkPayload) => void) | null = null;
  private sessionId: string | null = null;

  async start(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
  }

  async stop(): Promise<void> {
    /* Video chunking is driven by `chunkFile(uri)` because the
     * interface does not pass the source URI. This stop exists only
     * to satisfy the `ChunkProducer` contract. */
  }

  onChunk(cb: (chunk: ChunkPayload) => void): void {
    this.callback = cb;
  }

  /**
   * Read the finalized video file, slice it into
   * `VIDEO_FILE_CHUNK_SIZE_BYTES`-equivalent chunks (128 KB at the
   * current setting), and emit each via `onChunk` in order. The last
   * emission carries `isFinal: true`.
   *
   * Designed to be called AFTER the recorder has stopped and the file
   * has been moved into `documentDirectory`. Callers handle the
   * recording-closed bookkeeping (e.g. `queueMarkRecordingClosed`).
   *
   * Returns the number of chunks actually emitted. The host uses this
   * value as the authoritative `next_chunk_index` when calling
   * `queueMarkRecordingClosed` — reading it back from the queue is
   * unsafe because a mid-emission storage corruption could have
   * dropped chunks silently and leave the queue's `next_chunk_index`
   * stuck at 0 even when 58 chunks were really emitted.
   */
  async chunkFile(uri: string): Promise<number> {
    if (!this.sessionId) {
      throw new Error(
        'VideoFileChunkProducer: chunkFile called before start',
      );
    }
    if (!this.callback) {
      throw new Error(
        'VideoFileChunkProducer: no onChunk callback registered',
      );
    }
    const sid = this.sessionId;
    const cb = this.callback;

    console.log('VIDEO_FILE_READY', { uri });
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && info.size > VIDEO_MAX_SIZE_BYTES) {
      // Fail BEFORE the base64 read and BEFORE any queue mutation. No
      // chunks have been emitted, no queue entry has been touched — the
      // throw propagates to the host's stopRecording path, which leaves
      // the session entry in its empty/just-created state for the
      // worker to finalize as a zero-chunk session.
      console.log('VIDEO_TOO_LARGE_FOR_MVP', {
        size: info.size,
        max: VIDEO_MAX_SIZE_BYTES,
      });
      throw new Error('VIDEO_TOO_LARGE_FOR_MVP');
    }
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const totalChunks = Math.max(
      1,
      Math.ceil(base64.length / VIDEO_FILE_CHUNK_SIZE_BASE64),
    );
    console.log('VIDEO_CHUNKS_GENERATED', { count: totalChunks });

    let emittedCount = 0;
    for (let i = 0; i < totalChunks; i++) {
      if (i % 5 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
      const start = i * VIDEO_FILE_CHUNK_SIZE_BASE64;
      const slice = base64.substring(
        start,
        start + VIDEO_FILE_CHUNK_SIZE_BASE64,
      );
      if (slice.length === 0) break;
      const isFinal = i === totalChunks - 1;
      console.log('VIDEO_CHUNK_EMIT', { index: i });
      const payload: ChunkPayload = isFinal
        ? {
            sessionId: sid,
            chunk_index: i,
            base64Slice: slice,
            isFinal: true,
          }
        : {
            sessionId: sid,
            chunk_index: i,
            base64Slice: slice,
          };
      // The interface types `cb` as returning void, but the host's
      // sink does async hashing + queueAppendChunk. Cast to unknown
      // and await if a Promise was returned so persistence stays
      // ordered relative to emission.
      await Promise.resolve(cb(payload));
      // Increment AFTER the await so that if the sink throws (e.g.
      // GC_QUEUE_CORRUPT_TOO_LARGE), we report the count of chunks
      // that actually reached the queue, not the count we attempted.
      emittedCount = i + 1;
    }
    return emittedCount;
  }
}
