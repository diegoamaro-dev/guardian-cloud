/**
 * Local-evidence read-only helper.
 *
 * Reads the persisted upload queue (PENDING_RETRY_KEY in app/index.tsx)
 * to locate the local recording file URI for a given session_id, so the
 * session detail screen can offer an offline export fallback.
 *
 * MUST mirror the same AsyncStorage key the queue uses in app/index.tsx
 * (`PENDING_RETRY_KEY = 'test.pending_retry'`). The key is duplicated
 * here on purpose: the rule is "do not modify GC_QUEUE", so we read
 * its persisted shape WITHOUT importing or touching the queue helpers.
 * This is a read-only side-channel — no mutation, no setItem, no schema
 * coupling beyond `{ session_id: string, uri: string }`.
 *
 * Lifecycle: a queue entry's `uri` points at a durable file under
 * `documentDirectory/guardian_recording_<ts><ext>` from `stopRecording`.
 * The entry is reaped (and the file deleted) only AFTER all chunks
 * upload AND `completeSession` succeeds — i.e. exactly when the cloud
 * export already works. If we are in this fallback path the entry has
 * not been reaped yet, so the file is still on disk.
 *
 * Strictly read-only:
 *   - only `AsyncStorage.getItem`
 *   - only `JSON.parse`
 *   - only `FileSystem.getInfoAsync`
 *   - zero `setItem`, zero mutation
 */

import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PENDING_RETRY_KEY = 'test.pending_retry';

/**
 * Returns the local recording URI for `sessionId` if:
 *  - the queue entry exists in AsyncStorage,
 *  - it has a non-empty `uri`,
 *  - and the file still exists on disk.
 *
 * Returns null on any other condition (no queue, parse error, no match,
 * empty uri, missing file). Never throws.
 */
export async function findLocalRecordingUri(
  sessionId: string,
): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        (entry as { session_id?: unknown }).session_id !== sessionId
      ) {
        continue;
      }
      const uri = (entry as { uri?: unknown }).uri;
      if (typeof uri !== 'string' || uri.length === 0) continue;
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) return uri;
      return null;
    }
    return null;
  } catch (err) {
    console.log('LOCAL EXPORT lookup failed', err);
    return null;
  }
}

/**
 * Authoritative count of chunks the local chunker emitted for this
 * session, regardless of how many of those have actually reached the
 * backend. Used by the export screen to detect false-positive
 * "complete" verdicts: if backend says 7 chunks and the local chunker
 * emitted 32, the export is partial — period.
 *
 * Source: same persisted queue entry as `findLocalRecordingUri`.
 *   - prefers `next_chunk_index` (the chunker's monotonically-incremented
 *     emission counter, set authoritatively by `queueMarkRecordingClosed`
 *     once the recorder stops + final pass runs);
 *   - falls back to `chunks.length` if that field is missing.
 *
 * Returns null when:
 *   - the queue is empty / corrupt / not parseable;
 *   - no entry matches `sessionId` (already reaped after a successful
 *     full upload — in that case backend's totalChunks IS the truth,
 *     and the caller correctly falls back to it);
 *   - both `next_chunk_index` and `chunks.length` are zero/absent.
 *
 * Strictly read-only — same constraints as `findLocalRecordingUri`.
 */
export async function findLocalExpectedChunkCount(
  sessionId: string,
): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        (entry as { session_id?: unknown }).session_id !== sessionId
      ) {
        continue;
      }
      const nextIdx = (entry as { next_chunk_index?: unknown }).next_chunk_index;
      if (typeof nextIdx === 'number' && Number.isFinite(nextIdx) && nextIdx > 0) {
        return nextIdx;
      }
      const chunks = (entry as { chunks?: unknown }).chunks;
      if (Array.isArray(chunks) && chunks.length > 0) {
        return chunks.length;
      }
      return null;
    }
    return null;
  } catch (err) {
    console.log('LOCAL EXPECTED CHUNKS lookup failed', err);
    return null;
  }
}
