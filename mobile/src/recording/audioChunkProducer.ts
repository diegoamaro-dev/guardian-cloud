import type { ChunkPayload, ChunkProducer } from './chunkProducer';

/**
 * Audio producer — placeholder for the existing real-time audio
 * chunker.
 *
 * Audio's real-time chunking is owned by the legacy chunker in
 * `app/index.tsx` (`startChunkerForSession` / `stopChunkerForSession` /
 * `runAudioChunkerTick`). That path writes to `GC_QUEUE` directly via
 * `queueAppendChunk` and is INTENTIONALLY NOT routed through this
 * producer's `onChunk` callback — the milestone's hard "do not break"
 * rule (`STEP 6 — NON-BREAKING GUARANTEES`) requires audio to behave
 * identically to today, including same logs and same timing.
 *
 * This class exists so `RecordingController` can dispatch on mode
 * with a uniform interface; for audio every method is a no-op. Future
 * work that wants to channel audio chunks through `onChunk` can fill
 * these in without changing the controller's call sites.
 */
export class AudioChunkProducer implements ChunkProducer {
  async start(_sessionId: string): Promise<void> {
    /* No-op. Audio start path is owned by the host component
     * (Audio.Recording setup + startChunkerForSession). */
  }

  async stop(): Promise<void> {
    /* No-op. Audio stop path is owned by the host component
     * (stopChunkerForSession + queueMarkRecordingClosed). */
  }

  onChunk(_cb: (chunk: ChunkPayload) => void): void {
    /* Intentionally not stored — see class comment. */
  }
}
