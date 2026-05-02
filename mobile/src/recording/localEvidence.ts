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
