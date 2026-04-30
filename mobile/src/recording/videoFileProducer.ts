import * as FileSystem from 'expo-file-system';

import type { ChunkPayload, ChunkProducer } from './chunkProducer';

/**
 * Video post-stop chunk size. Audio chunks are 16 KB because the
 * real-time chunker emits ~12 KB/s at 64 kbps and a 1.5s tick — anything
 * larger forces multi-tick latency. Video has no such cadence: chunking
 * is a single post-stop pass, and a 16 KB cap on a typical 21 MB MP4
 * yields ~1300 chunks (HTTP fan-out hell — UI appeared stuck at 5/100
 * because each Drive upload is a full round-trip). 256 KB brings a 21 MB
 * recording down to ~84 chunks while reusing the same queue/upload
 * pipeline. Audio is intentionally untouched.
 */
const VIDEO_FILE_CHUNK_SIZE_BYTES = 256 * 1024;

/** Base64-char count derived from the byte size — same formula audio uses. */
const VIDEO_FILE_CHUNK_SIZE_BASE64 =
  Math.ceil(Math.ceil((VIDEO_FILE_CHUNK_SIZE_BYTES * 4) / 3) / 4) * 4;

/**
 * Video post-stop producer.
 *
 * The recorder writes a single .mp4 file in `cacheDirectory` while
 * recording; THIS PRODUCER DOES NOT TOUCH THAT FILE DURING RECORDING.
 * After the host calls `stop()` and moves the finalized file into
 * `documentDirectory`, the host then calls `chunkFile(uri)` (a
 * non-interface method, since `ChunkProducer` has no slot for the
 * source URI). This producer reads the whole file as base64, slices
 * into chunks of the same size as the audio chunker (16 KB →
 * VIDEO_FILE_CHUNK_SIZE_BASE64 base64 chars), and emits each via the
 * registered `onChunk` callback in chunk_index order. The last chunk
 * carries `isFinal: true`.
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
   * Read the finalized video file, slice it into 16 KB-equivalent
   * chunks, and emit each via `onChunk` in order. The last emission
   * carries `isFinal: true`.
   *
   * Designed to be called AFTER the recorder has stopped and the file
   * has been moved into `documentDirectory`. Callers handle the
   * recording-closed bookkeeping (e.g. `queueMarkRecordingClosed`).
   */
  async chunkFile(uri: string): Promise<void> {
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
    if (info.exists && info.size > 50 * 1024 * 1024) {
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
    }
  }
}
