/**
 * Which video producer this build uses.
 *
 * `true`  → the native segmented recorder (`gc-segmented-recorder`)
 * `false` → the historical `expo-camera` + post-stop chunker path
 *
 * Exclusive by construction: `selectVideoProducer` maps this to exactly one
 * producer, the home screen mounts exactly one preview, and `stopRecording`
 * dispatches on what actually started rather than on this value. Two capture
 * paths never coexist in one session.
 *
 * Build-time constant on purpose. A runtime toggle could flip mid-session and
 * leave a recording half-owned by each producer; a constant cannot. Rollback to
 * the previous producer is this one line.
 *
 * `true` on `feat/native-segmented-recording` so the APK under test is exactly
 * the committed tree. The default for `main` is a merge decision, not this
 * branch's — see the integration handoff for what still blocks that merge.
 */
export const NATIVE_SEGMENTED_VIDEO = true;
