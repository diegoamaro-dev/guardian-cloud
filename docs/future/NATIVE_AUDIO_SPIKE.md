# Native Audio Spike

Status: planned, not active  
Decision: do not migrate before OEM beta data

## Summary

Guardian Cloud currently uses `expo-audio` through a thin wrapper:

`mobile/src/audio/audioEngine.ts`

This file is intentionally the only point that depends on Expo audio APIs.  
The rest of the app consumes a small stable interface:

- `requestAudioPermissions()`
- `configureAudioMode()`
- `startAudioRecording()`
- `stopAudioRecording()`
- `cleanupDirtyAudioState()`
- `hasActiveAudioRecording()`

This means a future native Android audio module can replace the current engine without touching:

- GC_QUEUE
- worker
- chunking
- export
- recovery
- backend
- Drive/OAuth

## Current decision

Do not migrate to native audio yet.

Reason:

The current audio pipeline already preserves evidence through:

- live chunking
- disk-backed audio chunks
- persistent queue
- orphan recovery
- incremental manifests
- cross-device partial recovery

A native audio module may improve lifecycle and OEM behavior, but it does not currently solve a confirmed survival failure.

The correct next step is OEM beta testing, not migration.

## What native audio could improve

Potential benefits:

- better control over Android `MediaRecorder`
- better handling of activity destroy/recreate
- clearer recorder state ownership
- possible reduction of orphan recorder cases
- better diagnostics through native error callbacks
- less dependency on Expo audio lifecycle behavior

## What native audio would not automatically fix

Native audio does not magically solve:

- Xiaomi/Oppo/Samsung battery killers
- foreground service restrictions
- Android notification permission issues
- user denying microphone permissions
- Drive/network failures
- recovery/export logic
- app uninstall after zero chunks were uploaded

## Required native module contract

A native audio module must preserve the existing JS interface:

```ts
export type AudioEngineRecording = { uri: string };

export async function requestAudioPermissions(): Promise<boolean>;
export async function configureAudioMode(): Promise<void>;
export async function startAudioRecording(): Promise<AudioEngineRecording>;
export async function stopAudioRecording(): Promise<string | null>;
export async function cleanupDirtyAudioState(): Promise<void>;
export function hasActiveAudioRecording(): boolean;