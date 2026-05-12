/**
 * AudioEngine — internal abstraction over the platform audio recorder.
 *
 * Purpose:
 *   Isolate `expo-audio` from the rest of the app so a future swap to
 *   a custom native Android module (the path documented in
 *   docs/KNOWN_LIMITS.md as "Opción B — módulo nativo custom") only
 *   needs to re-implement this surface. `app/index.tsx` and any other
 *   consumer must never import `expo-audio` directly.
 *
 * Scope:
 *   - Permission request, audio session configuration, start, stop,
 *     and boot-time dirty cleanup. Nothing else.
 *   - Does NOT touch GC_QUEUE, the upload worker, recovery, chunking,
 *     or the export pipeline. Those layers consume the URI returned
 *     by `startAudioRecording` and do their own thing.
 *
 * Behaviour contract (must remain byte-equivalent to the pre-engine
 * inline implementation):
 *   - `.aac` extension, AAC ADTS container, AAC encoder, mono 44.1 kHz
 *     at 64 kbps (preset HIGH_QUALITY + the explicit fields below).
 *   - Audio session stays alive when the activity backgrounds
 *     (`shouldPlayInBackground=true`, `allowsBackgroundRecording=true`).
 *   - `uri` is filled by `prepareToRecordAsync` on Android and is
 *     readable both during recording AND after `stop()` resolves; the
 *     chunker uses it as its file source.
 *   - `activeAudioRecorder` is a single-slot resource; we never
 *     overwrite a non-null handle without stopping the previous one
 *     first.
 *
 * Threading / lifecycle notes:
 *   - The handle lives at module scope. A remount of the React tree
 *     (which happens when Android destroys + re-creates the activity
 *     after a swipe-close while expo-audio's foreground service has
 *     kept the JS process alive) does NOT lose it. The boot effect
 *     calls `cleanupDirtyAudioState()` to drain any leftover handle
 *     before the new session opens.
 */

import {
  AudioModule,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  RecordingPresets,
  type AudioRecorder,
  type RecordingOptions,
} from 'expo-audio';

/**
 * URI of an active recording. The shape is intentionally minimal —
 * downstream code (chunker, queue persistence) only needs the URI.
 * Other fields like `duration` or `sampleRate` are NOT exposed
 * because consumers must not depend on platform-specific recorder
 * metadata when the eventual native replacement lands.
 */
export type AudioEngineRecording = {
  uri: string;
};

/**
 * Recording configuration. Mirrors the prior expo-av options 1:1 on
 * Android: `.aac` extension, AAC ADTS container, AAC encoder, mono
 * 44.1 kHz at 64 kbps. The preserved choice of AAC ADTS over MPEG-4
 * keeps the existing chunk-concat export path playable as a prefix
 * (each ADTS frame is self-framing, so a contiguous prefix decodes
 * even if the tail is missing).
 *
 * The iOS branch is inherited from `RecordingPresets.HIGH_QUALITY`
 * (MPEG4AAC); the MVP is Android-only, so iOS values are not
 * exercised today.
 *
 * `numberOfChannels` and `bitRate` live at the top level of
 * `RecordingOptions` in expo-audio (the Android sub-type only takes
 * `extension`, `sampleRate`, `outputFormat`, `audioEncoder`,
 * `maxFileSize`, `audioSource`). expo-audio's `createRecordingOptions`
 * utility flattens top-level + platform-specific fields before passing
 * them to the native MediaRecorder, so setting them here matches the
 * prior expo-av configuration 1:1 (mono / 64 kbps).
 */
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64000,
  android: {
    extension: '.aac',
    outputFormat: 'aac_adts',
    audioEncoder: 'aac',
    sampleRate: 44100,
  },
};

/**
 * Active `AudioRecorder` JS handle, module-scoped so it survives a
 * remount of any React component that called us. Background: when the
 * user swipe-closes the app while audio is recording, Android keeps
 * the JS process alive because `expo-audio`'s foreground service has
 * elevated the process priority. The activity is destroyed and
 * re-created, which would lose a component-local `useRef` — but
 * recovery on the new mount needs to call `.stop()` on the native
 * recorder so the file stops growing. Module scope is the minimum
 * surface that lets the boot cleanup path reach the recorder.
 *
 * Lifecycle:
 *   - assigned in `startAudioRecording`;
 *   - nulled in `stopAudioRecording` BEFORE awaiting `.stop()` (so a
 *     throw from stop still leaves the engine in a clean "no active
 *     recording" state);
 *   - nulled in `cleanupDirtyAudioState` (boot path).
 *
 * Always treat as a single-slot resource — never overwrite a non-null
 * value without stopping the previous one first.
 */
let activeAudioRecorder: AudioRecorder | null = null;

/**
 * Request RECORD_AUDIO permission. Returns `true` iff granted. The
 * boolean form lets callers do `if (!(await requestAudioPermissions()))
 * throw new Error('RECORD_AUDIO permission denied')` without leaking
 * the platform-specific `{ granted, canAskAgain, … }` envelope.
 */
export async function requestAudioPermissions(): Promise<boolean> {
  const perm = await requestRecordingPermissionsAsync();
  return perm.granted;
}

/**
 * Configure the audio session for recording.
 *
 * Settings replicate the prior expo-av configuration:
 *   - iOS-only flags collapsed by expo-audio into the platform-neutral
 *     `allowsRecording` / `playsInSilentMode`. On Android both are
 *     no-ops, matching the previous behaviour.
 *   - `shouldPlayInBackground=true` is the 1:1 replacement for
 *     expo-av's `staysActiveInBackground: true`. Keeps the OS-level
 *     audio session alive while the activity is backgrounded.
 *   - `allowsBackgroundRecording=true` is expo-audio-specific. Without
 *     it the module's `OnActivityEntersBackground` lifecycle hook
 *     auto-pauses any active recorder, breaking the
 *     "subida durante grabación" invariant.
 */
export async function configureAudioMode(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    allowsBackgroundRecording: true,
  });
}

/**
 * Start a new audio recording. Returns the URI under which the file
 * is being written.
 *
 * expo-audio exposes the recorder class via the lazy
 * `AudioModule.AudioRecorder` (no `createAudioRecorder` helper is
 * exported at runtime — only the `useAudioRecorder` hook is).
 * Calling the constructor + `prepareToRecordAsync` here mirrors the
 * prior expo-av `new Audio.Recording(); prepareToRecordAsync()`
 * sequence. `record()` is synchronous in expo-audio — no `await`.
 *
 * `uri` is a property (was `getURI()` in expo-av). The Android
 * native side fills it during `prepareToRecordAsync`, so it is
 * safe to read here and hand to the live chunker.
 *
 * Errors:
 *   - throws "Recording URI is null after record()" if the native
 *     side fails to populate the uri property. Matches the legacy
 *     behaviour byte-for-byte.
 *   - any throw from `prepareToRecordAsync` / `record()` propagates
 *     unchanged to the caller. The catch path in `startRecording`
 *     wraps this call in its own try/catch and tears down the global
 *     state via `stopAudioRecording`.
 */
export async function startAudioRecording(): Promise<AudioEngineRecording> {
  const recording = new AudioModule.AudioRecorder(RECORDING_OPTIONS);
  await recording.prepareToRecordAsync(RECORDING_OPTIONS);
  recording.record();
  activeAudioRecorder = recording;
  const uri = recording.uri;
  if (!uri) throw new Error('Recording URI is null after record()');
  return { uri };
}

/**
 * Stop the active audio recording and clear the engine's handle.
 *
 * Order of operations:
 *   1. Capture the URI BEFORE stop — expo-audio sets `uri` during
 *      prepareToRecordAsync on Android, so it remains readable
 *      throughout the recording lifetime. Capturing pre-stop makes
 *      the error path simpler.
 *   2. Null the global handle BEFORE awaiting stop. If `.stop()`
 *      throws, the engine still ends in a clean state (no active
 *      recording) and the caller's catch block does not need a
 *      defensive `activeAudioRecorder = null;` reset of its own.
 *   3. Await `.stop()`. Errors PROPAGATE — `stopRecording` in
 *      `app/index.tsx` has an outer try/catch that handles the
 *      "stop failed" path; the start-catch wraps this call in its
 *      own best-effort try/catch.
 *   4. Return the URI (the caller persists it into the queue).
 *
 * Returns null when there was no active recording (idempotent: a
 * double-stop is a no-op).
 */
export async function stopAudioRecording(): Promise<string | null> {
  const recorder = activeAudioRecorder;
  if (!recorder) return null;
  const uri = recorder.uri ?? null;
  activeAudioRecorder = null;
  await recorder.stop();
  return uri;
}

/**
 * Boot-time cleanup of any audio recorder handle left over from a
 * previous JS context that survived a swipe-close. Symmetrical with
 * the pre-engine inline path: stop the recorder, swallow any error
 * (the recorder may already be in a terminal state and stop() can
 * reject), keep the global cleared either way.
 *
 * Preserves the existing log key
 * `GC_BOOT_DIRTY_STATE_RECORDER_STOP_FAILED` so log-based diagnostics
 * keep matching the same grep targets. Idempotent — safe to call
 * even when there is no active recording.
 */
export async function cleanupDirtyAudioState(): Promise<void> {
  const recorder = activeAudioRecorder;
  activeAudioRecorder = null;
  if (recorder === null) return;
  try {
    await recorder.stop();
  } catch (err) {
    console.log('GC_BOOT_DIRTY_STATE_RECORDER_STOP_FAILED', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Synchronous predicate: is there an active audio recorder handle?
 *
 * Consumed by the foreground-service `isRecordingActive` predicate
 * and by the `startRecording` early-exit guard. Returning a boolean
 * (rather than exposing the handle) keeps the engine's internal
 * state encapsulated.
 */
export function hasActiveAudioRecording(): boolean {
  return activeAudioRecorder !== null;
}
