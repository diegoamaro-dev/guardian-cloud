import type { SessionMode } from '@/api/history';

import { AudioChunkProducer } from './audioChunkProducer';
import type { ChunkPayload, ChunkProducer } from './chunkProducer';
import { VideoFileChunkProducer } from './videoFileProducer';

/**
 * Selects a `ChunkProducer` based on session mode and exposes a
 * uniform start/stop API.
 *
 * Audio: `AudioChunkProducer` is a no-op shim. The host's existing
 * real-time chunker (`startChunkerForSession` / `stopChunkerForSession`)
 * keeps driving audio chunk emission unchanged — required by the
 * "audio behaves identically" non-breaking guarantee for this
 * milestone.
 *
 * Video: installs `VideoFileChunkProducer` at start time. Recording
 * itself is still owned by the host (camera + recordAsync); after the
 * host stops the camera and moves the finalized file into
 * `documentDirectory`, it calls `chunkVideoFile(uri)` to fan the file
 * out into chunks via `onChunk`.
 */
export class RecordingController {
  private producer: ChunkProducer | null = null;
  private mode: SessionMode | null = null;
  private chunkSink:
    | ((chunk: ChunkPayload) => void | Promise<void>)
    | null = null;

  /**
   * Set the chunk handler. Called once by the host before the first
   * `start()`. The handler is responsible for hashing, persisting to
   * the queue, and waking the upload worker — the controller never
   * touches those concerns directly.
   */
  setChunkSink(sink: (chunk: ChunkPayload) => void | Promise<void>): void {
    this.chunkSink = sink;
  }

  async start(mode: SessionMode, sessionId: string): Promise<void> {
    this.mode = mode;
    this.producer =
      mode === 'video'
        ? new VideoFileChunkProducer()
        : new AudioChunkProducer();
    console.log('PRODUCER_SELECTED', { mode });
    if (this.chunkSink) {
      // Producer's `onChunk` types the callback as void-returning;
      // the sink may be async. The video producer awaits the
      // returned Promise internally so persistence order is kept.
      this.producer.onChunk(
        this.chunkSink as (chunk: ChunkPayload) => void,
      );
    }
    await this.producer.start(sessionId);
  }

  async stop(): Promise<void> {
    if (this.producer) {
      await this.producer.stop();
    }
  }

  /**
   * Video-only entry point. Hands the finalized recording's URI to
   * the video producer so it can slice and emit chunks. Returns the
   * number of chunks emitted — the host uses this value as the
   * authoritative `next_chunk_index` for `queueMarkRecordingClosed`
   * instead of reading it back from the queue (storage corruption
   * mid-emission can silently drop chunks and leave the queue's own
   * counter stuck at 0). Returns 0 for audio sessions or when start
   * has not been called.
   */
  async chunkVideoFile(uri: string): Promise<number> {
    if (this.mode !== 'video') return 0;
    if (!(this.producer instanceof VideoFileChunkProducer)) return 0;
    return await this.producer.chunkFile(uri);
  }
}
