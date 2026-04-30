/**
 * Chunk producer abstraction.
 *
 * Provides a uniform start/stop/onChunk interface for the different
 * chunking strategies Guardian Cloud needs to support:
 *
 *   - Audio real-time chunker (legacy — lives in app/index.tsx and is
 *     intentionally not refactored as part of this milestone; see
 *     AudioChunkProducer for the rationale).
 *   - Video post-stop chunker (new — see VideoFileChunkProducer).
 *   - Future video streaming (NOT implemented now).
 *
 * The payload is the minimal "what was just produced" record. The host
 * wires `onChunk` to whatever queue path it wants; producers never
 * import the queue, the upload worker, or the backend.
 */

export type ChunkPayload = {
  sessionId: string;
  chunk_index: number;
  base64Slice: string;
  isFinal?: boolean;
};

export interface ChunkProducer {
  start(sessionId: string): Promise<void>;
  stop(): Promise<void>;
  onChunk(cb: (chunk: ChunkPayload) => void): void;
}
