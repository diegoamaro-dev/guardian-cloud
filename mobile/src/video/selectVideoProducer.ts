import type { SessionMode } from '@/api/history';

/**
 * The two video capture paths that can own a session.
 *
 * `native-segmented` — the native recorder emits N self-contained MP4s during
 *                      the capture; each one becomes a GC_QUEUE chunk while the
 *                      recording is still running.
 * `expo-camera`      — the historical path: one growing MP4, sliced into chunks
 *                      after the recorder stops.
 */
export type VideoProducer = 'native-segmented' | 'expo-camera';

/**
 * Picks THE producer for a session. Pure, total, and the single place where the
 * exclusivity rule lives.
 *
 * Returns `null` for audio: audio has no video producer at all, and collapsing
 * that into a default would let a caller mount a camera for an audio session.
 *
 * Selection is made once, at GRABAR time, and the result is stored for the
 * lifetime of the recording — the stop path dispatches on the stored value, not
 * on a fresh call, so a flag that changed across a hot reload cannot strand a
 * live capture with the wrong teardown.
 */
export function selectVideoProducer(
  mode: SessionMode,
  nativeEnabled: boolean,
): VideoProducer | null {
  if (mode !== 'video') return null;
  return nativeEnabled ? 'native-segmented' : 'expo-camera';
}
