import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  View,
  Text,
  Pressable,
} from 'react-native';
// expo-audio is NOT imported directly here — all recorder lifecycle
// flows through the internal `AudioEngine` abstraction in
// `@/audio/audioEngine`. The engine encapsulates the active recorder
// handle, recording options, and audio-mode setup so a future swap to
// a custom native Android recorder only needs to re-implement that
// surface. See docs/KNOWN_LIMITS.md for the historical reason.
import {
  cleanupDirtyAudioState,
  configureAudioMode,
  hasActiveAudioRecording,
  requestAudioPermissions,
  startAudioRecording,
  stopAudioRecording,
} from '@/audio/audioEngine';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/auth/supabase';
import { env } from '@/config/env';
import {
  getConnectedDrive,
  listDestinations,
  uploadChunkBytes,
  type DestinationType,
  type PublicDestination,
} from '@/api/destinations';
import {
  getPreferredDestinationType,
  subscribePreferredDestinationChange,
} from '@/destinations/preference';
import { ApiError } from '@/api/client';
import { classifyFailure, type FailureDecision } from '@/upload/errorPolicy';
import {
  ensureReady as ensurePauseReady,
  getSnapshot as getPauseSnapshot,
  isDestinationBlocked,
  isGloballyBlocked,
  readState as readPauseState,
  registerAuthRestoreHandler,
  writeState as writePauseState,
  PAUSE_POLICY_VERSION,
  type GlobalPauseState,
} from '@/upload/pauseStore';
import { listSessionChunks } from '@/api/export';
import {
  useAuthStore,
  getFreshAccessToken,
  getOwnershipAccessToken,
  assertOwnershipGateOpen,
  type OwnershipToken,
} from '@/auth/store';
import {
  LEGACY_PROBE_VERSION,
  decideIdentityState,
  ensureMigrationBoundary,
  invalidateLegacyProbeSeal,
  markIdentityInitialized,
  resolveIdentityInitialized,
} from '@/auth/identityMarker';
import { appendHistoryEntry, type SessionMode } from '@/api/history';
import {
  describeResetRefusal,
  hardResetAppState,
  inspectPendingEvidence,
  inspectResetSafety,
  producerActiveRefusal,
  type ResetRefusal,
} from '@/dev/reset';
// GC-DEV-RESET-001 (third gap) — mutual exclusion between capture starts
// and destructive dev tools. Zero-import leaf; see the module docblock
// for why nothing existing could be reused.
import {
  acquireDestructiveExclusion,
  acquireProducerSlot,
  releaseDestructiveExclusion,
  releaseProducerSlot,
  type ProducerSlot,
} from '@/recording/evidenceExclusion';
import type { ChunkPayload } from '@/recording/chunkProducer';
import { RecordingController } from '@/recording/recordingController';
// Native segmented recorder. Imported eagerly (same shape the validated D_15S_2S
// harness used) because the preview view has to exist at render time; the module
// is autolinked from `mobile/modules/`, so a build that compiles the app also
// contains it.
import GCSegmentedRecorder, {
  GCSegmentedCameraView,
  type GateHarnessOptions,
} from '../modules/gc-segmented-recorder';
import { NATIVE_SEGMENTED_VIDEO } from '@/video/nativeSegmentedFlag';
import {
  selectVideoProducer,
  type VideoProducer,
} from '@/video/selectVideoProducer';
import {
  createNativeSegmentedSession,
  type NativeSegmentedSession,
} from '@/video/nativeSegmentedSession';
import {
  adoptSegment,
  stableSegmentDir,
  type AdoptableChunk,
  type QueueSink,
} from '@/video/segmentAdopter';
import {
  classifyCompletion,
  classifyCompletionFailure,
  createSessionCleanupJournal,
  type AuthorizationWriteResult,
  type CompletionFailureCode,
  type CompletionOutcome,
} from '@/video/sessionCleanupJournal';
import {
  createSessionCleanupRunner,
  type CleanupOutcome,
} from '@/video/sessionCleanupRunner';
import { createCleanupScheduler } from '@/video/sessionCleanupScheduler';
import {
  scanOrphans,
  formatAgeHuman,
  AUDIO_ORPHAN_MAX_BYTES,
  type OrphanFile,
} from '@/recording/orphanScan';
import {
  deriveGuardianStatus,
  deriveProtectionStatement,
  isChunkConfirmedOffDevice,
  isEntryFullyProtected,
} from '@/recording/deriveGuardianStatus';
import {
  startBackgroundProtection,
  stopBackgroundProtection,
  // OEM diagnostics — read-only helpers consumed by GC_OEM_BG_STATUS
  // and GC_OEM_BG_DELAYED_READY emissions below. None of these mutate
  // engine state, request permissions, or start services. They exist
  // so a Xiaomi / Samsung regression can be discriminated from logcat
  // without coupling app/index.tsx to platform-specific APIs.
  checkPostNotifications,
  getOemFingerprint,
  getBackgroundLibIsRunning,
  isBackgroundProtectionRunning,
} from '@/recording/backgroundService';
import { usePermissionsStore } from '@/permissions/permissionsStore';
// ReliabilityCard — contextual ask for POST_NOTIFICATIONS + battery
// optimisation, and the ONLY reliability recommendation on Home.
// Strictly additive: never reads or mutates GC_QUEUE, the upload
// worker, recovery, chunking, export, the FG service, the AudioEngine,
// or any module beyond the helpers in `src/permissions/*`.
import { ReliabilityCard } from '@/components/ReliabilityCard';
// Pure predicate; aggregates the screen's own isStarting/isRecording/
// isStopping flags so the card can hide across the whole capture
// window. Adds no recording state of its own.
import { isRecordingBusy } from '@/permissions/reliabilityVisibility';
import { humanizeFailure } from '@/errors/humanError';

/**
 * Real-audio + real-network-failure recovery test.
 *
 * PHASE 1 (manual — user-triggered via GRABAR/PARAR):
 *   - user taps GRABAR: permission → audio mode → Recording.start
 *   - user taps PARAR: Recording.stopAndUnload → URI
 *   - derive N real chunks from the file (N ≥ 1)
 *   - create a session
 *   - POST chunks[0] as 'uploaded' via the real backend
 *   - for each remaining chunk, POST 'uploaded'; on any fetch throw
 *     persist { session_id, remaining } to AsyncStorage and stop so
 *     Phase 2 can resume on next launch
 *   - POST /sessions/:id/complete once every chunk is uploaded
 *
 * PHASE 2 (automatic on app start when pending state exists):
 *   - load pending state
 *   - POST each remaining[i] as 'uploaded' via the real backend
 *   - GET the chunk list to verify
 *   - POST /sessions/:id/complete
 *   - clear AsyncStorage
 *
 * Phase 2 still runs automatically — recovery must not require user
 * interaction because the app may have been killed mid-upload. Phase 1,
 * by contrast, is manual: the app does nothing on its own.
 */

export const PENDING_RETRY_KEY = 'test.pending_retry';

/**
 * Last known session_id on this device. Persisted as a side observation
 * (never read by the upload pipeline, never gates recovery) purely so the
 * Settings screen can offer a "Exportar última sesión" shortcut without
 * maintaining a full session history yet.
 *
 * Unlike PENDING_RETRY_KEY, this key is NEVER cleared on completion — it
 * always points to the most recent session_id the app was aware of.
 */
const LAST_SESSION_ID_KEY = 'export.last_session_id';
/**
 * Persisted user preference for "Inicio rápido" (panic mode prep).
 *
 * When true, the home screen does two things on a returning-user
 * cold start:
 *   1. Surfaces the "Inicio rápido activado" pill near the GRABAR
 *      button so the user can confirm at a glance the panic flow is
 *      armed.
 *   2. Launches a short, visible countdown (`countdownSec`) that
 *      reaches 0 → calls the same `startRecording()` path as the
 *      manual button. The countdown can be cancelled by tapping
 *      Cancelar, navigating away from Home, or backgrounding the
 *      app. First-install (welcome modal still pending) blocks the
 *      auto-countdown so the very first contact with the app stays
 *      explicit.
 *
 * Play Store policy compliance is preserved through the visibility
 * + cancelability of the countdown and the first-install gate, not
 * by avoiding auto-record. The toggle lives in the Settings screen
 * (the only mutator).
 *
 * Lives in AsyncStorage alongside `LAST_SESSION_ID_KEY`. Same
 * literal duplicated verbatim in `app/settings.tsx` (precedent: the
 * existing LAST_SESSION_ID_KEY is duplicated the same way to avoid
 * a shared module for one constant).
 */
const QUICK_START_KEY = 'guardian.quick_start';
/**
 * One-shot beta welcome modal flag. Set to '1' the first time the user
 * dismisses the welcome modal; absent (or any other value) means the
 * modal hasn't been shown yet on this device.
 *
 * Pure UI state, scoped strictly to a Home overlay:
 *   - never read by the upload pipeline / queue / worker / recovery
 *   - never sent to the backend
 *   - reset only by a full app data wipe / reinstall
 *   - works fully offline (AsyncStorage = local SQLite on Android)
 *
 * Same naming convention as the other UI flags in this file
 * (`guardian.preferred_destination`, `guardian.quick_start`).
 */
const BETA_WELCOME_SEEN_KEY = 'guardian.beta_welcome_seen';

/**
 * Activation-perf instrumentation (TEMPORARY — beta hardening).
 *
 * Captures the wall-clock timestamps of the milestones between the user
 * tapping GRABAR and the first chunk landing server-side. Pure logging:
 *
 *   - never read by any decision path
 *   - never persisted
 *   - never sent to the backend
 *   - module-level so logs from the worker (which run outside the
 *     startRecording closure) can compute `since_tap_ms` consistently
 *
 * Limitation: `lastTapAtMs` is overwritten on every new tap. If the user
 * starts a second recording while a previous session's first chunk is
 * still in flight, the worker's GC_PERF_FIRST_CHUNK_* events for the
 * older session will reference the NEWER tap time. For one-recording-
 * at-a-time beta perf testing (the intended scenario) this is fine; the
 * `session_id` field on every log lets you correlate after the fact.
 *
 * Remove the perf logs once activation latency is measured and the
 * relevant cuts are applied.
 */
let lastTapAtMs: number | null = null;
function perfLog(name: string, extra: Record<string, unknown> = {}): void {
  const now = Date.now();
  console.log(name, {
    ts: now,
    since_tap_ms: lastTapAtMs !== null ? now - lastTapAtMs : null,
    ...extra,
  });
}
/**
 * DEBUG-only toggle for the multi-chunk recovery test.
 *
 *   true  → after chunk 0 uploads, chunk 1 is SIMULATED as failed (no real
 *           POST is issued). Pending state is persisted. Reload the app to
 *           exercise Phase 2 recovery deterministically. Use this for
 *           emulator testing — no manual WiFi toggling required.
 *
 *   false → after chunk 0 uploads, the multi-chunk test is skipped and the
 *           run ends cleanly. Use this once recovery has been validated and
 *           you want chunk 0 to be the only thing the test uploads.
 *
 * This flag is local to the test scaffold in this file. Production code
 * paths (postChunk, getChunks, Phase 2 recovery) do not read it.
 */
const DEBUG_INJECT_CHUNK1_FAILURE = false;

/**
 * Test-scope flag for the chunk idempotency probe.
 *
 *   true  → After chunks[0] uploads in Phase 1, immediately POST it
 *           again (same hash, same status). Then, inside the Phase 2
 *           resume loop, after chunk_index=1 uploads, POST it again.
 *           Each duplicate must return 200 with
 *           `idempotent_replay: true`; anything else is a regression in
 *           backend idempotency.
 *   false → Production behaviour: no duplicate POSTs are issued.
 *
 * Never read by postChunk/getChunks/deriveChunksFromFile/Phase 2 recovery
 * proper; it only gates two extra probes adjacent to those call sites.
 */
const DEBUG_DUPLICATE_SUBMISSION = false;

/**
 * Test-scope knob for TEST_SCENARIOS #D ("kill entre último chunk y
 * completeSession"). When > 0, Phase 1 multi-chunk waits this many ms
 * after the final chunk uploads and BEFORE calling completeSession.
 * That opens a deterministic window for an external `adb shell am
 * force-stop com.guariacloud.app` to hit the exact state the test
 * wants to cover: all chunks server-side, session still `active`,
 * client killed before completion. Phase 2 recovery on relaunch must
 * then see `remaining: []` and run completeSession alone.
 *
 * MUST be left at 0 for production. Only affects the multi-chunk
 * branch of Phase 1 — single-chunk flow and Phase 2 are untouched.
 */
const DEBUG_DELAY_BEFORE_COMPLETE_MS = 0;

/**
 * Verbose queue/worker tracing for diagnostics.
 *
 *   true  → Emit GC_DEBUG lines covering every drain-loop iteration,
 *           queueAppendChunk save, pickNext result, before/after
 *           uploadChunkBytes, sleep cycles, and any silent rejection
 *           caught by the fire-and-forget `.catch()` blocks. Use this
 *           when re-debugging "why isn't the worker draining" symptoms.
 *
 *   false → Production noise floor. Only the user-visible GC_QUEUE
 *           lifecycle logs (chunk emitted / uploading / uploaded /
 *           failed / recording closed / session completed) are emitted.
 *
 * The `.catch()` blocks themselves remain regardless of this flag so a
 * silent unhandled rejection cannot reappear undetected.
 */
const DEBUG_QUEUE = false;

/**
 * Kill switch for the chunk-bytes → Drive proxy path.
 *
 *   true  → Before each POST /chunks, the client sends the chunk's raw
 *           bytes to POST /destinations/drive/chunks and uses the
 *           returned `remote_reference` (Drive file_id) when registering
 *           the chunk. This is the MVP path that actually lands evidence
 *           in the user's Drive.
 *
 *   false → The Drive call is skipped entirely. POST /chunks registers
 *           metadata with `remote_reference: null`, matching the
 *           pre-Drive behaviour. Use this for instant rollback if the
 *           proxy route misbehaves — no git revert, no redeploy. The
 *           recovery / idempotency / completeSession paths are unchanged
 *           regardless of this flag.
 *
 * Read ONLY at Phase 1 call sites and at Phase 2 recovery (future
 * commit). Never read inside postChunk — the Drive call is always
 * orchestrated one level up so the metadata POST stays single-purpose.
 */
const DRIVE_CHUNK_UPLOAD_ENABLED = true;

// Audio chunk size is unchanged from the pre-video baseline (16 KB) — the
// audio pipeline is "fully stable" per the project doc and any change to
// this constant is out of scope. Video uses a larger chunk because a 3–5
// MB recording at 16 KB produces ~80–100 chunks → too many requests and a
// bad "Subiendo evidencia 4/98" UX. Video is now 256 KB: that size used
// to break AsyncStorage with "Row too big to fit into CursorWindow" and
// OOM on `FileSystem.readAsStringAsync`, but both blockers were removed
// when video switched to the partial-read architecture (chunks persist
// `byteOffset`/`byteLength` only — `base64Slice` is never written for
// video, and the chunker reads one chunk's bytes at a time instead of
// the whole growing file). At 256 KB a 3–5 MB clip is ~12–20 chunks.
// Mode-pick happens in the chunker only; queue/worker/retry/recovery
// shapes are untouched.
// Audio chunk size bump 16 KB → 32 KB (2026-05-18). Iguala el stride
// validado del path video y reduce ~2× la cuenta total de requests
// durante sesiones largas (a 64 kbps son ~30 chunks/min con 16 KB vs
// ~15 chunks/min con 32 KB). Time-to-first-chunk pasa de ~3 s a ~4.5 s
// (1.5 s extra de evidencia que vive sólo en el device antes del primer
// upload) — regresión aceptada bajo la invariante "subir > grabar
// perfecto". El path queue/worker/retry/recovery NO cambia: el cursor
// `emitted_base64_length` es char-count y resume con el stride nuevo
// sin migración. Entries legacy sin `local_uri` ni `base64Slice` rehy-
// dratan correctamente porque `base64SliceAt` deriva el stride desde
// `chunk.size`, no desde esta constante.
const CHUNK_SIZE_AUDIO = 32 * 1024;
const CHUNK_SIZE_VIDEO = 256 * 1024;
const CHUNK_SIZE_BASE64_AUDIO =
  Math.ceil(Math.ceil((CHUNK_SIZE_AUDIO * 4) / 3) / 4) * 4;
const CHUNK_SIZE_BASE64_VIDEO =
  Math.ceil(Math.ceil((CHUNK_SIZE_VIDEO * 4) / 3) / 4) * 4;

function chunkSizeBase64ForMode(mode: SessionMode): number {
  return mode === 'video' ? CHUNK_SIZE_BASE64_VIDEO : CHUNK_SIZE_BASE64_AUDIO;
}

/**
 * Recording options.
 *
 * Android is forced to AAC ADTS (raw AAC frames with self-framing sync
 * words) instead of the HIGH_QUALITY preset's MPEG_4 / M4A container.
 * The reason is partial-loss survival: MP4 stores its `moov` atom at the
 * END of the file, so if the last chunk never uploaded the concatenated
 * export is unplayable. AAC ADTS has no global header; every frame is
 * independently decodable, so a truncated concat still plays up to the
 * last frame we have. This trades a few percent of quality for the
 * "subir evidencia > grabar perfecto" priority of Guardian Cloud.
 *
 * iOS keeps the HIGH_QUALITY preset's ios branch — the MVP is validating
 * on Android only and we are not changing the iOS container until we
 * have a device to test it on.
 *
 * TODO(recording-format): guardar formato/extensión por sesión en el
 * backend para que el export no tenga que recurrir a sniff de firma
 * binaria. Sin esa columna, sesiones antiguas (.m4a) se distinguen de
 * sesiones nuevas (.aac) por los bytes del concat.
 *
 * The actual `RecordingOptions` object lives in `@/audio/audioEngine`
 * (alongside the rest of the expo-audio surface). It is intentionally
 * NOT re-exported — consumers in this file must go through the engine
 * functions (`startAudioRecording`, `configureAudioMode`, etc.) so the
 * dependency on `expo-audio` stays inside that one module.
 */

/**
 * Video recording bounds. The camera writes a single growing .mp4 file
 * to FileSystem.cacheDirectory while recordAsync() is in flight; the
 * existing chunker reads slices from that file every 1.5s exactly the
 * way it does for audio. We cap maxDuration to keep a runaway recording
 * from filling the device, but the value is generous (1h) so a normal
 * session is bounded only by the user pressing PARAR.
 */
const VIDEO_MAX_DURATION_S = 60 * 60;

/**
 * Capture-time quality settings.
 *
 * The MVP queue path keeps `VIDEO_MAX_SIZE_BYTES` at 5 MB (see
 * `videoFileProducer.ts`). At default camera quality (1080p, ~6–10
 * Mbps) a 2-second recording overshoots that cap immediately. Forcing
 * 480p with a low bitrate keeps even moderately-long clips inside the
 * cap — at 500 kbps a one-minute recording is ~3.8 MB.
 *
 * The `VideoQuality` cross-platform low option is `'480p'`. iOS also
 * accepts `'4:3'` (640×480) but it isn't available on Android, so we
 * stick with `'480p'` to stay portable. Bitrate is the prop that
 * actually drives file size; quality controls resolution.
 */
const VIDEO_RECORDING_QUALITY = '480p' as const;
const VIDEO_RECORDING_BITRATE_BPS = 500_000;

/**
 * How long startRecording polls FileSystem.cacheDirectory after invoking
 * recordAsync() before giving up on URI discovery. The pre-flight
 * diagnostic (app/debug-camera-probe/index.tsx) validated that the file
 * appears within ~1s on this device; 2s is a comfortable safety margin.
 * If discovery times out, the video session is aborted hard — silently
 * falling back to chunk-after-stop has a different reliability profile
 * than the audio path and was explicitly rejected.
 */
const VIDEO_URI_DISCOVERY_TIMEOUT_MS = 2000;

/**
 * Stabilization delay for the VIDEO chunker only. After `recordAsync`
 * starts, the underlying MediaRecorder spends a brief window writing the
 * MP4 prologue (`ftyp`, the `mdat` box header with placeholder size,
 * codec config) before steady-state mdat data begins flowing. Reads that
 * land inside that window can return bytes that are still being patched
 * — the chunker hashes them, the worker re-reads later, and the two
 * differ → HASH_MISMATCH on chunk 0.
 *
 * Holding the regular tick for `VIDEO_CHUNK_START_DELAY_MS` lets the
 * encoder pass that initialization phase before any chunk is emitted.
 * The first tick fires at +CHUNK_TICK_MS (1500ms); 2000ms here makes
 * that first tick a no-op and lets the second tick (at +3000ms) be the
 * first one that actually emits.
 *
 * This delay is bypassed on the FINAL pass at STOP — a recording shorter
 * than the delay window must still produce its chunks. By that point the
 * file lives in documentDirectory, the recorder has finalized, and the
 * bytes are stable.
 *
 * Audio is unaffected: the AAC ADTS pipeline is "fully stable" per the
 * project doc and has no analogous initialization race.
 */
const VIDEO_CHUNK_START_DELAY_MS = 2000;

interface CachedVideoFile {
  path: string;
  size: number;
  modificationTime: number;
}

/**
 * List candidate video files (.mp4, .mov) under FileSystem.cacheDirectory,
 * including the conventional `Camera/` subdirectory expo-camera writes to.
 *
 * URI-acquisition method validated by the pre-flight diagnostic: snapshot
 * the cache before recordAsync(), then diff after — the new file is the
 * one the recorder is writing to. expo-camera (16.x) does not surface the
 * in-flight URI on its public API; this listing diff is the documented
 * workaround.
 */
async function listCachedVideoFiles(): Promise<CachedVideoFile[]> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return [];
  const out: CachedVideoFile[] = [];

  async function scan(prefix: string) {
    let names: string[];
    try {
      names = await FileSystem.readDirectoryAsync(prefix);
    } catch {
      return;
    }
    for (const n of names) {
      const full = prefix + n;
      let info;
      try {
        info = await FileSystem.getInfoAsync(full);
      } catch {
        continue;
      }
      if (!info.exists) continue;
      if (info.isDirectory) {
        // Recurse one level into known camera dirs only — keeps this cheap.
        if (n === 'Camera' || n.startsWith('ExpoCamera') || n === 'CameraView') {
          await scan(full + '/');
        }
        continue;
      }
      const lower = n.toLowerCase();
      if (!lower.endsWith('.mp4') && !lower.endsWith('.mov')) continue;
      out.push({
        path: full,
        size: info.size ?? 0,
        modificationTime: info.modificationTime ?? 0,
      });
    }
  }

  await scan(dir);
  return out;
}

/**
 * Decode a base64 slice into its raw bytes.
 *
 * The hash and upload pipelines on both sides of the wire MUST agree
 * on the same representation. The backend recomputes sha256 over the
 * decoded bytes it receives on /destinations/drive/chunks, and the
 * Drive filename is derived from that same hash. So the client must
 * also hash the DECODED bytes, not the base64 text — otherwise the two
 * values diverge and HASH_MISMATCH fires at the proxy.
 *
 * `atob` is globally available in Expo SDK 50+ (Hermes). We decode to
 * Uint8Array by reading each binary char code; no Buffer polyfill.
 */
function sliceToBytes(b64Slice: string): Uint8Array {
  const binary = atob(b64Slice);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** ArrayBuffer → lowercase hex (canonical form for X-Hash / chunk.hash). */
function bytesDigestToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

interface RealChunk {
  chunk_index: number;
  hash: string;
  size: number;
}

interface PendingState {
  session_id: string;
  remaining: RealChunk[];
  /**
   * Absolute filesystem URI of the recording, moved into the app's
   * documentDirectory during Phase 1 so that a kill/reboot cannot have
   * the OS purge the cache before Phase 2 gets to re-upload the bytes.
   *
   * Optional for backward compatibility: any PENDING_RETRY_KEY written
   * by a previous build of the app won't have this field. Phase 2
   * treats that as "no bytes available" and degrades to the legacy
   * metadata-only flow (remote_reference stays null on /chunks).
   */
  uri?: string;
}

// =============================================================================
// CHUNKS-DURING-RECORDING (concurrent upload pipeline)
// -----------------------------------------------------------------------------
// Goal: emit and upload each chunk while the recorder is still writing,
// instead of doing all the slicing+uploading after STOP. The recorder must
// never block on the network; the upload worker runs as a fire-and-forget
// JS-event-loop task. Ports the existing PENDING_RETRY_KEY shape from a
// single-session object to an array so multiple sessions can be drained at
// app open. Backend, endpoints, and the export pipeline are untouched.
//
// Files referenced by this block:
//   - mobile/src/api/destinations.ts → uploadChunkBytes, base64ToBytes
//   - mobile/src/api/client.ts       → ApiError
//   - This file's own postChunk / completeSession / readRecordingBase64 /
//     base64SliceAt / sliceToBytes / bytesDigestToHex helpers.
//
// TODO(chunk-encryption): cipher each base64Slice client-side (Argon2 KDF +
//   AES-GCM, key sealed in keystore). Out of scope for this brick — chunks
//   are uploaded in clear today, same as before.
// TODO(queue-sqlite): migrate this AsyncStorage-backed array to expo-sqlite
//   before Play Store. AsyncStorage is single-key JSON and ~6 MB on Android;
//   long sessions with persisted base64Slices will hit it. Each chunk write
//   today is O(N) re-serialization of the whole queue. Mandatory cleanup.
// =============================================================================

export type ChunkStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface QueueChunk {
  chunk_index: number;
  hash: string;
  size: number;
  status: ChunkStatus;
  attempts: number;
  /**
   * Base64 of the decoded chunk bytes. Populated when the chunker emits
   * the slice; PRUNED (set to undefined) on 200 OK to keep AsyncStorage
   * small. Pre-Phase-2 entries (legacy migration) are inserted with
   * `base64Slice` undefined and rehydrated on the fly by reading the
   * full recording from `uri` and slicing with `base64SliceAt`.
   *
   * Declared as `string | undefined` (rather than `?: string`) so that
   * Object.assign'd patches can explicitly null this back out under
   * exactOptionalPropertyTypes — the poda step needs to clear the
   * field, not just omit it.
   */
  base64Slice?: string | undefined;
  /**
   * VIDEO path only. Byte offset of this chunk's bytes inside the source
   * recording at `entry.uri`. Set once at emit; NEVER pruned (eight-byte
   * integer — orders of magnitude smaller than a base64Slice and required
   * for retry/recovery to re-read the bytes from disk).
   *
   * Mutually exclusive with `base64Slice`: an audio chunk has only
   * `base64Slice` (until pruned), a video chunk has only `byteOffset` +
   * `byteLength`. The worker branches on field presence — see
   * `rehydrateChunkSlice`.
   *
   * Why bytes and not base64 chars: `FileSystem.readAsStringAsync` accepts
   * `{ encoding: Base64, position, length }` where both are byte counts
   * and returns base64 of just that range. Storing byte offsets lets the
   * worker do an O(chunk_size) read at upload time instead of an O(file)
   * whole-file read — the latter is exactly the OOM that drove this change.
   */
  byteOffset?: number | undefined;
  /**
   * VIDEO path only. Byte length of this chunk's bytes inside `entry.uri`.
   * Always equals `CHUNK_SIZE_VIDEO` for non-tail chunks; the final-pass
   * tail chunk carries the remainder.
   *
   * Same lifecycle as `byteOffset` (set once, never pruned). Same field
   * presence rule (audio chunks do not set this).
   */
  byteLength?: number | undefined;
  /**
   * Absolute filesystem URI of a file that holds this chunk's base64
   * (under `documentDirectory/chunks/{sessionId}/{chunk_index}.b64`).
   * Persisting the base64 OUT of AsyncStorage is how the queue avoids
   * the Android SQLite CursorWindow ~2 MB per-row limit — the
   * in-queue row stays metadata-only regardless of session length.
   *
   * Set at emit time by:
   *   - `videoChunkSink`  — video post-stop path (original caller).
   *   - `emitChunk`       — audio live-emit path (added post-2026-05-15
   *                          hotfix; previously stored `base64Slice`
   *                          inline, which tripped CursorWindow on
   *                          long audio sessions).
   *
   * Deleted after a successful upload (post-200-OK cleanup in
   * `uploadDrainLoop`) and as part of the `chunks/{sessionId}/`
   * directory wipe in `reapEntry`. Both paths apply to audio and
   * video without code branching.
   *
   * Mutually exclusive with `base64Slice` in practice: a chunk created
   * by the current code has either `base64Slice` (legacy queue entries
   * persisted before the hotfix) OR `local_uri` (new entries). The
   * worker tolerates both shapes — `rehydrateChunkSlice` short-circuits
   * on `base64Slice` first, then falls through to `local_uri`, so
   * legacy entries continue to upload without migration.
   */
  local_uri?: string | undefined;
  /** Set when the upload to Drive returned a file_id we should use as remote_reference on /chunks. */
  remote_reference?: string | null | undefined;
  last_error?: { status: number; code?: string; message: string } | undefined;
  /**
   * G3' — medium of THIS chunk's bytes.
   *
   * A property of the unit of evidence, never of the session: a
   * Protection Session will eventually carry chunks of both media, and
   * a session-level `mode` cannot describe that without lying.
   *
   * Written by exactly three producers, each medium-specific BY
   * CONSTRUCTION — no parameter, no derivation, no heuristic:
   *   · `segmentAdopter`  → 'video'  native segmented MP4 segments
   *   · `videoChunkSink`  → 'video'  legacy post-stop video slices
   *   · `emitChunk`       → 'audio'  called only by runAudioChunkerTick
   *
   * ── WHAT IT DOES NOT GUARANTEE ─────────────────────────────────────
   * `'video'` does NOT mean "self-contained MP4 segment exportable by
   * D3". `videoChunkSink` writes `'video'` for base64 slices living
   * under `chunks/<sid>/N.b64`, which are NOT segments. Any consumer
   * that wants to treat a chunk as a native segment must ALSO verify the
   * structural signature `segments/<sid>/segment_NNNNNN.mp4`.
   *
   * Absence means "metadata unavailable" — never "video", never "audio".
   * Entries written before G3' carry no key; the D3 fallback treats them
   * by structural evidence alone and fails closed on any ambiguity.
   *
   * Optional and additive, like `destination_type`, `paused` and
   * `evidence_closed`: making it required would break every inline chunk
   * literal across the test suite.
   */
  media?: 'video' | 'audio' | undefined;
}

export interface PendingQueueEntry {
  session_id: string;
  /**
   * Absolute filesystem URI of the recording. During recording this
   * still points at the cacheDirectory copy; after STOP it is updated
   * to the documentDirectory copy. Used by the rehydration path for
   * legacy chunks lacking a persisted `base64Slice`.
   */
  uri: string;
  /** false while recorder is active; true after STOP + final pass have completed. */
  recording_closed: boolean;
  /** Server-side completion state. Drives whether to call POST /sessions/:id/complete. */
  session_completed: boolean;
  complete_attempts: number;
  /** Bookkeeping for the chunker so it can resume on app re-open mid-recording. */
  emitted_base64_length: number;
  next_chunk_index: number;
  chunks: QueueChunk[];
  /**
   * Destination this session was bound to at the moment recording
   * started. Snapshot of `activeDestinationType` taken inside
   * `queueAppendNewSession`'s caller. Once set, it MUST NOT be mutated
   * — every chunk of this session uploads to this destination, even if
   * the user changes the preference in Settings while we are still
   * draining. This is the rule that prevents "Drive-then-NAS" mixed
   * sessions.
   *
   * Optional for backward compatibility: pre-existing queue entries
   * (written before this field existed) will be missing it. The worker
   * falls back to the current `activeDestinationType` so legacy
   * recoveries still drain — the trade-off there is that a legacy
   * session that crosses a preference change might mix destinations,
   * but that window is bounded by the legacy entries on disk and
   * disappears as they finalize. We do NOT migrate to backfill — the
   * absence of the field is a meaningful "wasn't bound" signal.
   */
  destination_type?: DestinationType | undefined;
  /**
   * PHASE 1A — entry-scoped upload block.
   *
   * Set when a failure is unrepairable by repeating the same request
   * but affects only this session (`409 SESSION_NOT_ACTIVE`) or is not
   * recognised at all (`UNCLASSIFIED_PAUSE`). While present, the worker
   * skips this entry entirely.
   *
   * This is a SELECTION filter, not a terminal state: the chunks stay
   * `pending` and keep their bytes, hash and index, so the entry
   * resumes intact the moment the pause is lifted. Nothing about the
   * chunk format changes — the flag lives on the entry, never on
   * `QueueChunk`.
   *
   * Optional for backward compatibility: entries written before this
   * field existed simply have no pause, which is the correct default.
   */
  paused?:
    | {
        reason: 'SESSION_STATE_PAUSE' | 'UNCLASSIFIED_PAUSE';
        at: number;
        code?: string | undefined;
      }
    | undefined;
  /**
   * G1 — durable terminality state of the Protection Session.
   *
   * `true` means: this Protection Session no longer accepts new evidence
   * and may advance toward terminality.
   *
   * It does NOT encode the CAUSE of that closure. It does not mean the
   * user tapped PARAR, it is not equivalent to `session_completed`, and
   * it does not assert that `/complete` has happened.
   *
   * ── INERT DURING G1 ────────────────────────────────────────────────
   * `recording_closed` remains the SOLE operational authority. Nothing
   * reads this field: not `tryFinalizeReadySessions`, not `pickNext`,
   * not cleanup, not recovery. It is written in parallel with
   * `recording_closed`, carrying the same value, so the schema is on
   * disk and proven before G2 changes WHO writes it and WHO reads it.
   *
   * Absence means ONLY "metadata unavailable" — never "closed", never
   * "open". Entries written before G1, and those produced by
   * `migrateLegacyPendingState` (deliberately untouched), have no key at
   * all. The operational fallback policy for a missing value belongs to
   * G2, once cross-version compatibility has been audited; defining one
   * here would decide G2 in advance.
   *
   * Optional and additive: the same pattern as `destination_type` and
   * `paused`. Making it required would break every inline entry literal
   * across the test suite, which is precisely the destructive migration
   * this shape avoids.
   */
  evidence_closed?: boolean | undefined;
}

const CHUNK_TICK_MS = 1500;
/** Cap retries for completeSession so a permanently-broken session does not hold a queue entry forever. */
export const MAX_COMPLETE_ATTEMPTS = 5;
/**
 * Outer per-chunk upload timeout. `uploadChunkBytes` already has a 30s
 * AbortController internally, but a chunk can stuck in 'uploading' for
 * other reasons (postChunk has no timeout, AsyncStorage stalls, JS
 * bridge hangs, AbortController not respected on a particular RN
 * version). This is the belt-and-suspenders cap: if the entire
 * uploadChunkBytes → postChunk → queueUpdateChunk('uploaded') sequence
 * doesn't complete within this window, we fire a synthetic transient
 * error so the existing catch path resets the chunk to 'pending' with
 * backoff. Without this, a hung HTTP write was leaving 1/N chunks in
 * 'uploading' forever and freezing the completion gate at N-1/N.
 */
const CHUNK_UPLOAD_TIMEOUT_MS = 60_000;

// ----- queue state (module-scope so it survives re-renders) -----

let writeChain: Promise<void> = Promise.resolve();

/**
 * Last `GC_QUEUE_PERSIST_OK` payload, deduped so the log only emits
 * when something meaningful changed. Without this dedup the log fires
 * on every `queueMutate` call (chunk append, status update, requeue,
 * mark-closed, ...) — easily many per second during recording — and
 * floods logcat with identical "entries:0, size_bytes:2" lines from
 * background reads of an empty queue.
 *
 * Emit policy (see queueMutate):
 *   - first persist ever (lastQueuePersistLog === null)
 *   - entries count changed
 *   - size_bytes changed
 *   - size_bytes > GC_QUEUE_PERSIST_HIGH_WATER_BYTES — always logged
 *     so an approaching CursorWindow trip cannot be missed in
 *     logcat noise filtering
 *
 * Diagnostic-only mutation. Never read by the queue / worker /
 * recovery / chunking / export pipelines.
 */
let lastQueuePersistLog: { entries: number; size_bytes: number } | null =
  null;

/**
 * Above this serialized queue size, log every persist regardless of
 * dedup. 500 KB is well below the Android SQLite CursorWindow ~2 MB
 * per-row limit but high enough that idle steady-state operation
 * never hits it. The threshold gives the operator a "this is the
 * danger zone" signal in logcat even when payload size oscillates
 * around a constant.
 */
const GC_QUEUE_PERSIST_HIGH_WATER_BYTES = 500_000;

export async function queueMutate<T>(
  fn: (queue: PendingQueueEntry[]) => T | Promise<T>,
): Promise<T> {
  let result!: T;
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      let raw: string | null;
      try {
        raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
      } catch (err) {
        // Android SQLite CursorWindow has a per-row hard limit (~2 MB
        // on stock devices). If an active session's accumulated,
        // un-pruned base64Slices push the queue value past that limit,
        // every subsequent getItem throws.
        //
        // We log the corruption signal and SURFACE the error (re-throw)
        // — we do NOT auto-clear the queue. A previous version cleared
        // PENDING_RETRY_KEY here; that destroyed evidence mid-emission
        // (chunks 0..K already on disk, chunk K+1 trips the limit, and
        // the clear wiped the entry — subsequent queueAppendChunk calls
        // silently no-oped because `e = q.find(...)` returned undefined,
        // leaving `next_chunk_index = 0` even after 58 chunks emitted).
        //
        // Failing safely is better than corrupting the in-flight
        // session. Surgical "clear only the broken entry" recovery is
        // a future task — for MVP, the size guard in
        // VideoFileChunkProducer is the primary defence.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Row too big') || msg.includes('CursorWindow')) {
          console.log('GC_QUEUE_CORRUPT_TOO_LARGE', { err: msg });
        }
        throw err;
      }
      let queue: PendingQueueEntry[];
      if (!raw) {
        queue = [];
      } else {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            queue = parsed as PendingQueueEntry[];
          } else {
            // Legacy single-session shape — migrate inline so callers always
            // see an array. The deeper migration (filling chunk fields) runs
            // separately in `migrateLegacyPendingState` so this hot path
            // stays a one-liner.
            queue = [parsed as unknown as PendingQueueEntry];
          }
        } catch {
          queue = [];
        }
      }
      result = await fn(queue);
      const serialized = JSON.stringify(queue);
      await AsyncStorage.setItem(PENDING_RETRY_KEY, serialized);
      // Diagnostic: surfaces the size of every queue write so a future
      // "queue empty after restart" symptom can be correlated against the
      // last known persist size. `size_bytes` also gives early warning of
      // approach to the Android SQLite CursorWindow per-row limit (~2 MB):
      // values trending above ~1.5 MB mean a subsequent getItem may start
      // throwing CursorWindow on this row.
      //
      // Dedup against `lastQueuePersistLog` so logcat is not flooded by
      // identical lines when queueMutate runs many times per second on
      // an unchanged queue (idle reads, status updates that do not
      // touch the entry count, etc.). We always log:
      //   - the first persist ever (no previous baseline)
      //   - any change in entry count (sessions appended / reaped)
      //   - any change in serialized byte size (chunk added /
      //     uploaded / pruned)
      //   - any persist above the high-water threshold, dedup
      //     bypassed, so an approaching CursorWindow trip stays
      //     visible even if the size oscillates around a constant
      // Read-only — no schema change, no behavioural change. The
      // setItem above already ran; the log only governs whether we
      // emit a line.
      const nextEntries = queue.length;
      const nextBytes = serialized.length;
      const shouldLog =
        !lastQueuePersistLog ||
        lastQueuePersistLog.entries !== nextEntries ||
        lastQueuePersistLog.size_bytes !== nextBytes ||
        nextBytes > GC_QUEUE_PERSIST_HIGH_WATER_BYTES;
      if (shouldLog) {
        console.log('GC_QUEUE_PERSIST_OK', {
          size_bytes: nextBytes,
          entries: nextEntries,
        });
        lastQueuePersistLog = {
          entries: nextEntries,
          size_bytes: nextBytes,
        };
      }
    });
  await writeChain;
  return result;
}

export async function queueRead(): Promise<PendingQueueEntry[]> {
  return queueMutate(q => q.map(entry => ({ ...entry })));
}

/**
 * Read-only predicate for the foreground-service lifecycle gate.
 *
 * Returns true when ANY queued entry has at least one chunk in
 * `pending` or `uploading` state — i.e. there is work the upload
 * worker still needs to do. `failed` chunks do NOT count: they are
 * terminal and will not transition further on their own. Sessions
 * whose chunks are all `uploaded` also don't count: the worker reaps
 * those entries on the next drain tick.
 *
 * Used by the foreground service tick to decide whether to keep the
 * notification alive; also called from `stopRecording`'s finally to
 * decide whether to stop the service immediately or let the tick
 * handle it. Pure read — no mutations, no setItem, no schema knowledge
 * beyond the existing PendingQueueEntry shape.
 */
export async function hasPendingUploadWork(): Promise<boolean> {
  const q = await queueRead();
  let pendingCount = 0;
  let uploadingCount = 0;
  for (const entry of q) {
    for (const c of entry.chunks) {
      if (c.status === 'pending') pendingCount += 1;
      else if (c.status === 'uploading') uploadingCount += 1;
    }
  }
  const result = pendingCount > 0 || uploadingCount > 0;
  // Diagnostic: lets the operator correlate KEEPALIVE / STOP decisions
  // with the actual chunk counts the helper observed. Counts are tiny
  // numbers so the log stays readable across many ticks.
  console.log('HAS_PENDING_UPLOAD_WORK', {
    result,
    pending: pendingCount,
    uploading: uploadingCount,
    entries: q.length,
  });
  return result;
}

export async function queueAppendNewSession(
  entry: PendingQueueEntry,
): Promise<void> {
  await queueMutate(q => {
    const existing = q.findIndex(e => e.session_id === entry.session_id);
    if (existing >= 0) q[existing] = entry;
    else q.push(entry);
  });
}

export async function queueAppendChunk(
  sessionId: string,
  chunk: QueueChunk,
  /**
   * AUDIO: number of base64 chars chunked so far — what the audio chunker
   *        reads back on the next tick to know where to resume.
   * VIDEO: pass `null`. Video doesn't use this field; its chunker derives
   *        the resume offset from `sum(chunks[*].byteLength)` so the bookkeeping
   *        stays accurate even if a tail chunk shortened a previous run.
   */
  emittedBase64Length: number | null,
  nextChunkIndex: number,
): Promise<void> {
  await queueMutate(q => {
    const e = q.find(x => x.session_id === sessionId);
    if (!e) {
      // Diagnostic: surfaces a silent blind-spot. Today the caller
      // (`emitChunk`) logs `GC_QUEUE chunk emitted` unconditionally
      // AFTER the await on this function, so a no-op return here is
      // invisible — the system appears to be emitting chunks while
      // nothing actually persists. This log catches the gap.
      //
      // We keep the early return (no behavioural change) so a missing
      // session entry never throws into the recording path; the log is
      // pure observability. Investigated case where this could fire:
      //   - queueAppendNewSession never ran for this session
      //   - the queue entry was reaped (e.g. session_completed=true)
      //     before the chunker's final pass landed
      //   - the queue was externally wiped between session create and
      //     this append (Clear Data / OS / dev reset)
      // The `queue_session_ids` array is bounded by the in-memory queue
      // size (typically <10 entries) so the log stays readable.
      console.log('GC_QUEUE_APPEND_CHUNK_NO_SESSION', {
        sessionId,
        chunk_index: chunk.chunk_index,
        queue_entries: q.length,
        queue_session_ids: q.map(x => x.session_id),
      });
      return;
    }
    // Idempotent guard: if a chunk with this index already exists in the
    // queue, do NOT push a second one. This is the last-line defence
    // against a race window we just patched (in-flight regular tick + final
    // pass both emitting the same chunk_index). Whichever queueAppendChunk
    // commits first wins; the loser bails here, leaving emitted/next
    // unchanged so the offsets stay consistent with the winning chunk.
    if (e.chunks.some(c => c.chunk_index === chunk.chunk_index)) {
      console.log('GC_QUEUE chunk dedup skipped', {
        sessionId,
        chunk_index: chunk.chunk_index,
        hash_short: chunk.hash.substring(0, 12),
      });
      return;
    }
    e.chunks.push(chunk);
    if (emittedBase64Length !== null) {
      e.emitted_base64_length = emittedBase64Length;
    }
    e.next_chunk_index = nextChunkIndex;
  });
}

export async function queueUpdateChunk(
  sessionId: string,
  chunk_index: number,
  patch: Partial<QueueChunk>,
): Promise<void> {
  await queueMutate(q => {
    const e = q.find(x => x.session_id === sessionId);
    if (!e) return;
    const c = e.chunks.find(x => x.chunk_index === chunk_index);
    if (!c) return;
    Object.assign(c, patch);
    // Defensive: when a chunk is marked uploaded, collapse any residual
    // duplicates of the same chunk_index. Both queueAppendChunk's
    // idempotent guard and the recovery normalization should already
    // prevent duplicates; this is the last guard for any straggler from
    // legacy contaminated state. We keep the chunk we just patched and
    // drop the others (regardless of their hash — the patched one is the
    // authoritative record once it has reached `uploaded`).
    if (patch.status === 'uploaded') {
      const collisions = e.chunks.filter(
        x => x.chunk_index === chunk_index && x !== c,
      );
      if (collisions.length > 0) {
        const divergentHash = collisions.some(x => x.hash !== c.hash);
        console.log('GC_QUEUE chunk update dedup', {
          sessionId,
          chunk_index,
          kept_hash_short: c.hash.substring(0, 12),
          dropped: collisions.length,
          hash_divergent: divergentHash,
        });
        e.chunks = e.chunks.filter(
          x => x === c || x.chunk_index !== chunk_index,
        );
      }
    }
  });
}

export async function queueMarkRecordingClosed(
  sessionId: string,
  finalUri: string,
  emittedBase64Length: number,
  nextChunkIndex: number,
): Promise<void> {
  await queueMutate(q => {
    const e = q.find(x => x.session_id === sessionId);
    if (!e) return;
    e.recording_closed = true;
    // G1 — parallel write, same value, same moment. `recording_closed`
    // stays the operational authority; this only records the durable
    // terminality state of the Protection Session. Inert during G1.
    e.evidence_closed = true;
    e.uri = finalUri;
    e.emitted_base64_length = emittedBase64Length;
    e.next_chunk_index = nextChunkIndex;
  });
}

/**
 * Flip every chunk currently at `failed` back to `pending` so the
 * upload worker re-attempts them on its next tick. Clears `last_error`
 * and resets `attempts` so the backoff starts at the floor.
 *
 * Behavioural contract:
 *   - The worker is unchanged. It already drains `pending` chunks via
 *     `uploadDrainLoop`; flipping the status is the only state change
 *     needed to wake it up.
 *   - Bytes survive: AUDIO chunks pruned their `base64Slice` on
 *     permanent failure but their source recording at `entry.uri` is
 *     still on disk (the entry has not been reaped because at least
 *     one chunk is failed) — `rehydrateChunkSlice` re-reads from disk.
 *     VIDEO chunks keep `byteOffset` / `byteLength` / `local_uri`
 *     across the failure, so the rehydration path does not touch them.
 *   - The home screen surfaces this only when the human-readable
 *     failure category is recoverable (see `humanizeFailure`). Codes
 *     where retry would fail the same way (HASH_MISMATCH, BODY_TOO_LARGE,
 *     SESSION_NOT_ACTIVE, INVALID_HEADERS) hide the button.
 *
 * Single AsyncStorage write — `queueMutate` re-serialises the queue
 * once even when N chunks are flipped.
 */
export async function requeueFailedChunks(): Promise<void> {
  let flipped = 0;
  await queueMutate(q => {
    for (const entry of q) {
      for (const c of entry.chunks) {
        if (c.status === 'failed') {
          c.status = 'pending';
          c.last_error = undefined;
          c.attempts = 0;
          flipped += 1;
        }
      }
    }
  });
  console.log('GC_QUEUE requeue_failed', { flipped });
}

export async function queueMarkSessionCompleted(sessionId: string): Promise<void> {
  await queueMutate(q => {
    const e = q.find(x => x.session_id === sessionId);
    if (!e) return;
    e.session_completed = true;
  });
}

export async function queueBumpCompleteAttempts(sessionId: string): Promise<number> {
  return queueMutate(q => {
    const e = q.find(x => x.session_id === sessionId);
    if (!e) return 0;
    e.complete_attempts += 1;
    return e.complete_attempts;
  });
}

export async function queueDropEntry(sessionId: string): Promise<void> {
  await queueMutate(q => {
    const i = q.findIndex(x => x.session_id === sessionId);
    if (i >= 0) q.splice(i, 1);
  });
}

// ----- legacy migration (one-shot at app open) -----

/**
 * Convert any pre-array `PENDING_RETRY_KEY` value (single PendingState
 * object) into the new array shape. Idempotent: if already an array,
 * does nothing. Legacy chunks have no `base64Slice` — they are inserted
 * with `recording_closed: true` (legacy state was always written after
 * STOP) and the worker rehydrates the slice from `uri` on first need.
 */
export async function migrateLegacyPendingState(): Promise<void> {
  await queueMutate(q => {
    // queueMutate already lifted a legacy object into [obj]. Detect that
    // case by the presence of the legacy `remaining` field on entries.
    for (let i = 0; i < q.length; i++) {
      const e = q[i] as unknown as PendingState & Partial<PendingQueueEntry>;
      if (Array.isArray(e.chunks)) continue; // already migrated
      const remaining = (e as { remaining?: RealChunk[] }).remaining ?? [];
      const sessionId = e.session_id;
      const uri = e.uri ?? '';
      const migrated: PendingQueueEntry = {
        session_id: sessionId,
        uri,
        recording_closed: true,
        session_completed: false,
        complete_attempts: 0,
        emitted_base64_length: 0,
        next_chunk_index:
          remaining.length > 0
            ? Math.max(...remaining.map(c => c.chunk_index)) + 1
            : 0,
        chunks: remaining.map(c => ({
          chunk_index: c.chunk_index,
          hash: c.hash,
          size: c.size,
          status: 'pending' as const,
          attempts: 0,
        })),
      };
      q[i] = migrated;
    }
  });
}

export interface NormalizationReport {
  /** Multiple queue entries sharing one session_id were merged into one. */
  entries_collapsed: number;
  /** Exact (same chunk_index AND same hash) duplicate chunks dropped. */
  exact_duplicates_dropped: number;
  /** Sessions where same chunk_index appeared with different hashes. */
  sessions_marked_corrupt: number;
  /** Total chunks across corrupt sessions that were forced to status=failed. */
  chunks_marked_failed: number;
}

/**
 * One-shot post-migration pass that normalises the persisted queue:
 *
 *   1. Multiple entries with the same session_id → merged into the first
 *      (chunks concatenated, then deduped in step 2; offsets / closed /
 *      completed flags merged with max/OR).
 *   2. Within each entry, chunks with the same chunk_index AND the same
 *      hash → keep ONE (prefer status='uploaded', else first); drop the
 *      rest.
 *   3. Within each entry, chunks with the same chunk_index but DIFFERENT
 *      hash → the recorded bytes diverged. We cannot guess which is
 *      right, so we mark EVERY chunk in that entry as `failed` with code
 *      `CORRUPT_HASH_DIVERGENCE` and let the worker finalise the session
 *      via the existing all-settled path. Nothing is uploaded blindly.
 *
 * Idempotent: running it again on a clean queue is a no-op.
 *
 * The report is logged once at boot so the operator can see whether the
 * queue arrived in a healthy state or was patched up.
 */
export async function normalizeQueueOnRecovery(): Promise<NormalizationReport> {
  return queueMutate(q => {
    const report: NormalizationReport = {
      entries_collapsed: 0,
      exact_duplicates_dropped: 0,
      sessions_marked_corrupt: 0,
      chunks_marked_failed: 0,
    };

    // Step 1: collapse duplicate session_id entries.
    const firstIdxBySession = new Map<string, number>();
    for (let i = 0; i < q.length; i++) {
      const sid = q[i]!.session_id;
      const firstIdx = firstIdxBySession.get(sid);
      if (firstIdx === undefined) {
        firstIdxBySession.set(sid, i);
        continue;
      }
      const target = q[firstIdx]!;
      const dup = q[i]!;
      target.chunks.push(...dup.chunks);
      target.emitted_base64_length = Math.max(
        target.emitted_base64_length,
        dup.emitted_base64_length,
      );
      target.next_chunk_index = Math.max(
        target.next_chunk_index,
        dup.next_chunk_index,
      );
      // G2' — capture each side's OWN `recording_closed` BEFORE the merge
      // below overwrites the target's. Each operand must fall back to its
      // own standing contract; using the already-combined value as the
      // fallback for both would let one side's closure leak into the
      // other's effective value.
      const targetRecordingClosed = target.recording_closed;
      const dupRecordingClosed = dup.recording_closed;
      target.recording_closed =
        target.recording_closed || dup.recording_closed;
      // G2' — merge the EFFECTIVE terminality of each side, not the raw
      // field. The G1 rule (three-valued OR over `evidence_closed` alone)
      // was safe only while the field was inert: collapsing a legacy
      // entry (key absent, `recording_closed = true`) with a G1 open one
      // (`false`/`false`) produced `evidence_closed = false` alongside
      // `recording_closed = true` — a divergence no writer can produce,
      // and one that `canAdvanceToTerminality` would now read as BLOCKED
      // on a session that completes today.
      //
      // Two absences still stay absent: with no new metadata on either
      // side, `recording_closed` remains the authority and materialising
      // the key would assert knowledge we do not have.
      if (
        target.evidence_closed === undefined &&
        dup.evidence_closed === undefined
      ) {
        delete target.evidence_closed;
      } else {
        target.evidence_closed =
          (target.evidence_closed ?? targetRecordingClosed) ||
          (dup.evidence_closed ?? dupRecordingClosed);
      }
      target.session_completed =
        target.session_completed || dup.session_completed;
      target.complete_attempts = Math.max(
        target.complete_attempts,
        dup.complete_attempts,
      );
      // Mark for removal — splice after the loop to keep indices stable.
      (q[i] as PendingQueueEntry & { __collapse?: true }).__collapse = true;
      report.entries_collapsed++;
    }
    for (let i = q.length - 1; i >= 0; i--) {
      if ((q[i] as PendingQueueEntry & { __collapse?: true }).__collapse) {
        q.splice(i, 1);
      }
    }

    // Step 2 + 3: per-entry chunk dedup / corruption check.
    for (const entry of q) {
      const groups = new Map<number, QueueChunk[]>();
      for (const c of entry.chunks) {
        const arr = groups.get(c.chunk_index) ?? [];
        arr.push(c);
        groups.set(c.chunk_index, arr);
      }

      // Detect hash divergence at any chunk_index → corrupt the whole entry.
      let entryCorrupt = false;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const hashes = new Set(group.map(c => c.hash));
        if (hashes.size > 1) {
          entryCorrupt = true;
          break;
        }
      }

      if (entryCorrupt) {
        // Mark divergent UNuploaded chunks failed with
        // CORRUPT_HASH_DIVERGENCE so the worker's gate makes the
        // missing-upload signal explicit. We do NOT delete the entry
        // — chunks already uploaded remain server-side.
        //
        // Critical preservation rule: any chunk whose pre-normalize
        // status was 'uploaded' AND carries a non-null
        // remote_reference is kept verbatim. The backend has those
        // bytes; downgrading them to 'failed' would force a re-upload
        // attempt (worker can't anyway because failed is terminal) and
        // — more importantly — would block the completion gate
        // forever for evidence we could otherwise still export. The
        // hash-divergence signal still gets surfaced via the
        // sessions_marked_corrupt counter and the failed siblings.
        const finalChunks: QueueChunk[] = [];
        let failedAddedThisEntry = 0;
        for (const group of groups.values()) {
          const uploadedKept = group.find(
            c => c.status === 'uploaded' && !!c.remote_reference,
          );
          if (uploadedKept) {
            finalChunks.push(uploadedKept);
            continue;
          }
          // No surviving upload for this chunk_index — mark divergent
          // siblings failed so the gate sees them as missing.
          const seenHashes = new Set<string>();
          for (const c of group) {
            if (seenHashes.has(c.hash)) continue;
            seenHashes.add(c.hash);
            // PHASE 1A: `base64Slice` is deliberately NOT cleared here.
            // This branch runs on chunks the loop above has already
            // confirmed have NO surviving upload (the `uploadedKept`
            // check took the confirmed ones out). Pruning them meant
            // recovery itself destroyed evidence that never reached the
            // backend — the exact opposite of what recovery is for.
            // Bytes, hash, index and size are all retained; only the
            // status and the diagnostic error are set.
            finalChunks.push({
              ...c,
              status: 'failed',
              last_error: {
                status: 0,
                code: 'CORRUPT_HASH_DIVERGENCE',
                message:
                  `chunk_index ${c.chunk_index} appeared with multiple hashes ` +
                  `in persisted queue; entire session marked corrupt`,
              },
            });
            failedAddedThisEntry += 1;
          }
        }
        finalChunks.sort((a, b) => a.chunk_index - b.chunk_index);
        const droppedNow = entry.chunks.length - finalChunks.length;
        if (droppedNow > 0) report.exact_duplicates_dropped += droppedNow;
        entry.chunks = finalChunks;
        report.sessions_marked_corrupt++;
        report.chunks_marked_failed += failedAddedThisEntry;
        continue;
      }

      // No divergence — just dedup exact duplicates per chunk_index.
      let entryChanged = false;
      const cleaned: QueueChunk[] = [];
      for (const group of groups.values()) {
        if (group.length === 1) {
          cleaned.push(group[0]!);
          continue;
        }
        // Same chunk_index, same hash (already established above).
        // Prefer an 'uploaded' chunk so we keep the remote_reference;
        // otherwise the first occurrence wins.
        const kept = group.find(c => c.status === 'uploaded') ?? group[0]!;
        cleaned.push(kept);
        report.exact_duplicates_dropped += group.length - 1;
        entryChanged = true;
      }
      if (entryChanged) {
        cleaned.sort((a, b) => a.chunk_index - b.chunk_index);
        entry.chunks = cleaned;
      }
    }

    return report;
  });
}

/**
 * DEV-only helper: wipes Guardian Cloud's persisted queue + last-session
 * pointer from AsyncStorage. Auth tokens (sb-*), Drive connection state
 * and any other unrelated keys are NOT touched.
 *
 * Exposed via the Settings screen "DEV — limpiar cola" button. Also
 * attached to globalThis for one-off invocation from the React Native
 * debugger console:  `await clearGuardianQueueDev()`.
 *
 * Module-level rather than behind `__DEV__` so a release build could
 * surface it if we ever ship a recovery tool.
 *
 * GC-DEV-RESET-001 — the previous version of this docblock claimed "the
 * Settings UI gate is what enforces DEV-only today". That was FALSE:
 * `app/settings.tsx` contained no `__DEV__` at all, so a single tap in a
 * shipped build could drop the queue. The screen is gated now, and this
 * function no longer relies on a caller to be careful — it applies the
 * same refusal policy as `hardResetAppState`, from the same module, so
 * the two destructive dev tools cannot disagree about what "pending"
 * means.
 *
 * Removing `test.pending_retry` orphans every chunk on disk: the files
 * survive but nothing references them, which is unrecoverable from
 * inside the app. That is why this refuses rather than confirms.
 */
export async function clearGuardianQueueDev(): Promise<{
  removed: string[];
  refused?: ResetRefusal;
}> {
  // Same TOCTOU as `hardResetAppState`, and this one does not go through
  // `queueMutate` either — it removes the key underneath the chain. The
  // lease makes check-and-drop atomic against a capture start.
  const lease = acquireDestructiveExclusion('clearGuardianQueueDev');
  if (lease === null) {
    console.log('GC_QUEUE clearGuardianQueueDev refused', {
      reason: 'producer_active',
    });
    return { removed: [], refused: producerActiveRefusal() };
  }

  try {
    const refusal = await inspectPendingEvidence();
    if (refusal) {
      console.log('GC_QUEUE clearGuardianQueueDev refused — pending evidence', {
        sessions: refusal.sessions,
        unconfirmed_chunks: refusal.unconfirmed_chunks,
      });
      return { removed: [], refused: refusal };
    }

    const keys = [PENDING_RETRY_KEY, LAST_SESSION_ID_KEY];
    const removed: string[] = [];
    for (const k of keys) {
      try {
        await AsyncStorage.removeItem(k);
        removed.push(k);
      } catch (err) {
        console.log('GC_QUEUE clearGuardianQueueDev failed', { key: k, err });
      }
    }
    // Reset module-level rehydration cache too — otherwise a stale base64
    // copy could outlive the queue wipe.
    rehydrationCache.clear();
    console.log('GC_QUEUE clearGuardianQueueDev done', { removed });
    return { removed };
  } finally {
    releaseDestructiveExclusion(lease);
  }
}

/**
 * Pre-recovery reap. The worker's `tryFinalizeReadySessions` already
 * drops any entry whose `session_completed` flag is true, but it only
 * runs once the drain loop spins up. That timing makes the recovery
 * banner show "entries=1 pending_chunks=0" for a fully-finished session
 * just because the worker had not had a chance to reap it yet.
 *
 * This helper runs the same drop synchronously at boot, BEFORE the
 * `recovery start` log, so the banner only mentions entries with real
 * outstanding work. Entries that still need a network call (uploads
 * pending OR `session_completed=false`) are left untouched — the worker
 * is still the sole owner of those.
 */
export async function reapAlreadyDoneEntries(): Promise<{ reaped: number }> {
  const queue = await queueRead();
  let reaped = 0;
  for (const entry of queue) {
    const pending = entry.chunks.filter(c => c.status === 'pending').length;
    // Strictly: server-side session is done AND nothing left to upload.
    // Both conditions are required — a session_completed=true with a
    // straggling pending chunk would be an invariant violation we'd
    // rather see in logs than silently sweep away.
    if (entry.session_completed && pending === 0) {
      await reapEntry(entry.session_id, entry.uri);
      reaped++;
    }
  }
  return { reaped };
}

/**
 * Boot-time reconciliation against the backend's view of each stuck
 * session.
 *
 * Closes a real beta-observable hole: a chunk can end up `status='failed'`
 * locally (4xx classified as permanent — typical reasons: HASH_MISMATCH
 * on a transient race, postChunk parsing hiccup, DRIVE_NOT_CONNECTED
 * mid-flight) WHILE the same chunk's bytes are already on Drive/NAS via
 * a sibling retry / dedup path. The local queue then carries `failed`
 * forever, `tryFinalizeReadySessions`'s gate refuses to call
 * completeSession, and Home shows "Error" indefinitely even though the
 * evidence IS complete server-side and exportable.
 *
 * This helper consults the backend's `GET /sessions/:id/chunks` once
 * per stuck entry and reaps **only when the backend explicitly confirms
 * the session is whole**. The criterion is strict:
 *
 *   backend_uploaded_count >= entry.next_chunk_index
 *
 * If the backend has FEWER chunks than we expected to emit, the partial
 * is real and we leave the entry alone (Home keeps showing Error — the
 * user sees an honest signal). If the backend has all (or more), we
 * still try to mark the session completed via POST /complete; only on
 * 200 OR 409 SESSION_ALREADY_COMPLETED do we mark + reap. Any other
 * failure (5xx, NETWORK_ERROR, unrecognised 4xx) leaves the entry
 * untouched and is logged for the operator.
 *
 * Strict isolation:
 *   - never touches GC_QUEUE contract — uses the public helpers only
 *   - never touches the upload worker, chunking, recovery normalize
 *   - never modifies a single chunk's status (entire entry is reaped
 *     atomically once backend confirms; the failed/pending chunks are
 *     dropped together with the rest of the entry)
 *   - never converts a real partial into "protegido" — backend must
 *     unambiguously confirm completeness first
 *
 * Best-effort: any I/O failure (network, parse, auth) folds to
 * `not_reconciled` and the entry stays for the next boot to retry.
 *
 * Logs:
 *   GC_QUEUE_STALE_LOCAL_ERROR_RECONCILED     — entry reaped after
 *                                                backend confirmed.
 *   GC_QUEUE_STALE_LOCAL_ERROR_NOT_RECONCILED — entry left untouched
 *                                                (carries `reason`).
 */
export async function reconcileStaleSessionsWithBackend(): Promise<{
  reconciled: number;
  not_reconciled: number;
}> {
  const queue = await queueRead();
  let reconciled = 0;
  let not_reconciled = 0;

  // Token is checked per entry rather than once up-front so a refresh
  // race during the loop doesn't strand otherwise-reconcilable
  // entries. `getFreshAccessToken` is cheap (cache-backed unless the
  // persisted token actually expired).
  for (const entry of queue) {
    // Only consider entries that LOOK stuck/errored locally. A healthy
    // entry (all uploaded, session_completed=true) is handled by
    // `reapAlreadyDoneEntries` which ran just before us.
    const hasFailed = entry.chunks.some(c => c.status === 'failed');
    const hasIncompleteUpload = entry.chunks.some(
      c => c.status !== 'uploaded' || !c.remote_reference,
    );
    if (!hasFailed && !hasIncompleteUpload) continue;

    // Reconciliation is meaningful only when we know how many chunks
    // were SUPPOSED to be emitted. A zero `next_chunk_index` means the
    // recorder never produced a chunk — `tryFinalizeReadySessions`
    // already handles that path; skip here.
    const expected = entry.next_chunk_index;
    if (expected === 0) continue;

    // R6 — OWNERSHIP TOKEN. This block reads backend chunk state (a GET)
    // but then hands the same token to `finalizeAndAuthorizeCleanup`,
    // which calls POST /complete and authorises deleting local evidence.
    // It used to take a plain read token, which is a genuine ownership
    // leak — found by the branded type, not by reading the code. The
    // ownership token satisfies the GET too, so nothing else changes.
    const token = await getOwnershipAccessToken();
    if (!token) {
      console.log('GC_QUEUE_STALE_LOCAL_ERROR_NOT_RECONCILED', {
        session_id: entry.session_id,
        reason: 'no_access_token',
      });
      not_reconciled += 1;
      continue;
    }

    let backendChunks;
    try {
      backendChunks = await listSessionChunks(entry.session_id);
    } catch (err) {
      console.log('GC_QUEUE_STALE_LOCAL_ERROR_NOT_RECONCILED', {
        session_id: entry.session_id,
        reason: 'list_chunks_failed',
        err: err instanceof Error ? err.message : String(err),
      });
      not_reconciled += 1;
      continue;
    }

    const backendUploaded = backendChunks.filter(
      c => c.status === 'uploaded' && !!c.remote_reference,
    ).length;

    // Strict criterion: backend must have AT LEAST as many uploaded
    // chunks as the local queue expected to emit. Less than that is a
    // real partial — leave the entry alone so Home shows the honest
    // failed/error state. The user can still export whatever the
    // backend has; we won't pretend the local error doesn't exist.
    if (backendUploaded < expected) {
      console.log('GC_QUEUE_STALE_LOCAL_ERROR_NOT_RECONCILED', {
        session_id: entry.session_id,
        expected,
        backend_uploaded: backendUploaded,
        reason: 'backend_count_below_expected',
      });
      not_reconciled += 1;
      continue;
    }

    // Backend has at least all the chunks we expected. Try to mark the
    // session completed server-side. 200 OK or 409 SESSION_ALREADY_-
    // COMPLETED both mean "backend agrees we're done" and trigger reap.
    // Any other error → don't reap; the entry stays for next boot.
    //
    // Same helper as the finalize loop, so this path cannot drift out of the
    // ordering that keeps the cleanup journal safe. `reapEntry` still drops the
    // queue entry, the rehydration cache, the completion-gate log map, the
    // local recording file (if any) and the chunks/<sid>/ directory; the local
    // 'failed' chunks die WITH the entry — they were stale.
    const finalized = await finalizeAndAuthorizeCleanup(
      token,
      entry.session_id,
      entry.uri,
    );
    if (finalized.kind === 'failed') {
      console.log('GC_QUEUE_STALE_LOCAL_ERROR_NOT_RECONCILED', {
        session_id: entry.session_id,
        expected,
        backend_uploaded: backendUploaded,
        reason: 'complete_session_failed',
        detail: finalized.reason,
      });
      not_reconciled += 1;
      continue;
    }

    console.log('GC_QUEUE_STALE_LOCAL_ERROR_RECONCILED', {
      session_id: entry.session_id,
      expected,
      backend_uploaded: backendUploaded,
    });
    reconciled += 1;
  }

  // This loop can create authorizations that the boot pass — which runs before
  // it — could not have seen. Asking here is what stops them from waiting until
  // the next launch. Coalesced into a single extra pass by the scheduler, no
  // matter how many sessions this reconciliation confirmed.
  if (reconciled > 0) {
    sessionCleanupScheduler.requestCleanup('stale_reconciled');
  }

  return { reconciled, not_reconciled };
}

// ----- error classification (HC: never retry 4xx forever) -----

export function classifyError(err: unknown): 'transient' | 'permanent' {
  if (err instanceof ApiError) {
    // Network / timeout / abort
    if (err.status === 0 || err.code === 'NETWORK_ERROR') return 'transient';
    // Auth refresh covers 401 — getFreshAccessToken will refresh inline
    if (err.status === 401 || err.code === 'NO_TOKEN') return 'transient';
    // Rate limit / overload
    if (err.status === 408 || err.status === 429) return 'transient';
    // 5xx server
    if (err.status >= 500 && err.status < 600) return 'transient';
    // Offline-first: a chunk uploaded for a session whose POST /sessions
    // has not been replayed yet (recording started with no network)
    // returns 404 SESSION_NOT_FOUND. The bootstrap re-registers pending
    // sessions in the background, so this MUST be transient — otherwise
    // the chunk would be marked failed-permanent and its base64Slice
    // purged before the session even exists on the backend, losing
    // evidence we already have on disk.
    if (err.code === 'SESSION_NOT_FOUND') return 'transient';
    // 4xx client (incl. HASH_MISMATCH, 400, 403, 409, 422) — permanent.
    // 404 falls here too, except for SESSION_NOT_FOUND handled above.
    if (err.status >= 400 && err.status < 500) return 'permanent';
    return 'transient';
  }
  // Non-ApiError throws (postChunk uses raw fetch and throws plain Error
  // on non-2xx). Treat HTTP-status-bearing messages from postChunk as 4xx
  // permanent if we can parse them; otherwise default to transient.
  if (err instanceof Error) {
    const m = err.message.match(/HTTP (\d{3})/);
    if (m) {
      const status = Number(m[1]);
      if (status === 401 || status === 408 || status === 429) return 'transient';
      if (status >= 500 && status < 600) return 'transient';
      if (status >= 400 && status < 500) return 'permanent';
    }
  }
  return 'transient';
}

export function shapeError(
  err: unknown,
): { status: number; code?: string; message: string } {
  if (err instanceof ApiError) {
    const out: { status: number; code?: string; message: string } = {
      status: err.status,
      message: err.message,
    };
    if (err.code) out.code = err.code;
    return out;
  }
  if (err instanceof Error) {
    const m = err.message.match(/HTTP (\d{3})/);
    return {
      status: m ? Number(m[1]) : 0,
      message: err.message,
    };
  }
  return { status: 0, message: String(err) };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ----- pending remote-session registrations (offline-first) -----
//
// When the user starts a recording with no network, POST /sessions
// cannot reach the backend. The recorder still starts, the chunker
// still emits, and chunks queue locally under a client-generated UUID.
// This module owns the small "register this id with the backend later"
// retry loop. It is INTENTIONALLY decoupled from `GC_QUEUE`:
//   - GC_QUEUE format is unchanged; no new fields on PendingQueueEntry.
//   - The worker is unchanged; SESSION_NOT_FOUND now classifies as
//     transient (one line in `classifyError` above) so chunks survive
//     until this loop registers the session.
// Persistence uses a SEPARATE AsyncStorage key so a queue read/write
// path that pre-dates this feature never has to know about it.

const PENDING_SESSIONS_KEY = 'guardian.pending_session_registrations';
const PENDING_SESSIONS_RETRY_INTERVAL_MS = 5_000;

interface PendingSessionRegistration {
  session_id: string;
  mode: SessionMode;
  /**
   * Per-session upload destination, captured at GRABAR time. Optional
   * because entries persisted by builds before the destination-truth
   * fix carry no value — those replay through the loop with the
   * legacy `'drive'` default to preserve idempotency. New entries
   * always carry the actual pinned destination.
   */
  destination_type?: DestinationType;
}

export async function loadPendingRegistrations(): Promise<PendingSessionRegistration[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_SESSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive — drop malformed entries silently rather than crash.
    return (parsed as unknown[]).filter(
      (e): e is PendingSessionRegistration =>
        !!e &&
        typeof (e as PendingSessionRegistration).session_id === 'string' &&
        ((e as PendingSessionRegistration).mode === 'audio' ||
          (e as PendingSessionRegistration).mode === 'video'),
    );
  } catch {
    return [];
  }
}

async function savePendingRegistrations(
  list: PendingSessionRegistration[],
): Promise<void> {
  await AsyncStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify(list));
}

export async function addPendingRegistration(
  session_id: string,
  mode: SessionMode,
  destination_type?: DestinationType,
): Promise<void> {
  const list = await loadPendingRegistrations();
  if (!list.find(p => p.session_id === session_id)) {
    list.push({
      session_id,
      mode,
      ...(destination_type ? { destination_type } : {}),
    });
    await savePendingRegistrations(list);
  }
}

async function removePendingRegistration(session_id: string): Promise<void> {
  const list = await loadPendingRegistrations();
  const next = list.filter(p => p.session_id !== session_id);
  if (next.length !== list.length) {
    await savePendingRegistrations(next);
  }
}

let pendingRegistrationLoopRunning = false;

/**
 * Periodically retry POST /sessions for any session that was started
 * offline. Backend is idempotent on (id, user_id) so retries are safe.
 *
 * Self-terminating: exits cleanly when the pending list is empty.
 * Single-flight: a second caller while the loop is already running is
 * a no-op (the running instance covers their entry too once persisted).
 */
/**
 * ONE pass of the deferred-registration replay: read the list, try to
 * register every entry, report how many are still pending.
 *
 * Extracted from `runPendingRegistrationLoop` so a test can drive the
 * REAL replay mechanism without waiting out the retry interval or
 * reimplementing it. The loop below is now nothing but "run a pass, sleep
 * if work remains" — cadence, interval and backoff are untouched and
 * still live exclusively there. Production and tests execute the same
 * code, which is the entire point: an earlier version of the R6 test
 * drove `uploadDrainLoop` instead, which never touches this path at all,
 * so it asserted "no request was sent" about a mechanism it never ran.
 *
 * Returns the number of registrations still outstanding afterwards.
 */
export async function runPendingRegistrationPass(): Promise<number> {
  const list = await loadPendingRegistrations();
  if (list.length === 0) return 0;

  // R5 — OWNERSHIP TOKEN. This replay's whole job is `POST /sessions`, so
  // it waits for a durable marker exactly as it already waits for a
  // token. Only the authority that answers "may I?" has changed.
  const token = await getOwnershipAccessToken();
  if (token) {
    for (const item of list) {
      try {
        // `destination_type` is optional on legacy entries persisted
        // before the destination-truth fix — those fall back to the
        // historical `'drive'` default so the backend insert still
        // succeeds (the schema accepts both). New entries always
        // carry the actual pinned destination from GRABAR time, so
        // the backend record matches where chunks physically went.
        const destinationType: DestinationType =
          item.destination_type ?? 'drive';
        await createSessionRequest(
          token,
          item.mode,
          item.session_id,
          destinationType,
        );
        console.log('GC_LOCAL_FIRST session registered', {
          session_id: item.session_id,
          mode: item.mode,
          destination_type: destinationType,
          legacyFallback: item.destination_type === undefined,
        });
        await removePendingRegistration(item.session_id);
      } catch (err) {
        console.log('GC_LOCAL_FIRST register retry failed', {
          session_id: item.session_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    console.log('GC_LOCAL_FIRST register loop — no token yet');
  }

  return (await loadPendingRegistrations()).length;
}

async function runPendingRegistrationLoop(): Promise<void> {
  if (pendingRegistrationLoopRunning) return;
  pendingRegistrationLoopRunning = true;
  try {
    while (true) {
      const remaining = await runPendingRegistrationPass();
      if (remaining === 0) return;
      await sleep(PENDING_SESSIONS_RETRY_INTERVAL_MS);
    }
  } finally {
    pendingRegistrationLoopRunning = false;
  }
}

/**
 * GC-AUTH-MIGRATION-001 — an identity is established but `gc.identity.v1`
 * could not be written.
 *
 * The dangerous shape is durable `legacy_identity_evidence: false` sitting
 * next to an absent marker. On a later boot with the session gone that
 * reads as FIRST_IDENTITY and mints a SECOND identity, silently orphaning
 * everything the first one uploaded. The marker is what normally prevents
 * it, and the marker is exactly what just failed to land.
 *
 * So we stop trusting the seal. Dropping it makes the next boot re-decide
 * the boundary, and any trace the established identity left — a queue
 * entry, a history row — makes the probe answer "yes", which yields
 * IDENTITY_DEGRADED and keeps ownership. On a device that genuinely left
 * no trace the probe answers "no" again and re-seals; nothing is lost.
 *
 * What this deliberately does NOT do: sign out, mint again, drop the
 * session, or touch a single byte of evidence. The identity we have is
 * the one we keep, uploads under it stay valid, and the recording path is
 * untouched. The only thing withdrawn is a stale claim that the migration
 * question is settled.
 *
 * R4 — THIS IS THE FIRST LINE OF DEFENCE, NOT THE ONLY ONE. Removing the
 * seal is itself a storage write and can fail too, and a protection that
 * assumes "delete usually works" is not a protection. When both writes
 * fail, `resolveIdentityInitialized` falls back to
 * `hasProvenIdentityEvidence()`, which needs no write to have succeeded:
 * it reads what the upload path already wrote. That is why this function
 * is allowed to log a failure and carry on.
 */
async function guardUndurableIdentity(
  persisted: boolean,
  how: 'minted' | 'observed',
): Promise<void> {
  if (persisted) return;
  const sealDropped = await invalidateLegacyProbeSeal();
  console.log('GC_IDENTITY_MARKER_NOT_DURABLE', {
    how,
    seal_invalidated: sealDropped,
  });
}

async function schedulePendingSessionRegistration(
  session_id: string,
  mode: SessionMode,
  destination_type?: DestinationType,
): Promise<void> {
  await addPendingRegistration(session_id, mode, destination_type);
  // Fire-and-forget. The loop self-terminates when the list is empty.
  runPendingRegistrationLoop().catch(err => {
    console.log('GC_LOCAL_FIRST register loop rejected', err);
  });
}

/**
 * Detect errors from `createSessionRequest` that warrant local-first
 * fallback (retry in background) rather than aborting the recording.
 *
 * Retryable: any failure that did NOT come back as a STRUCTURAL 4xx.
 * That covers offline (TypeError "Network request failed"), DNS errors,
 * AbortError on timeout, 5xx/408/429 — and 401.
 *
 * Not retryable: 400 / 403 / 409 / 422 — the request itself is wrong,
 * and no amount of retrying will make it right. Those still abort.
 *
 * GC-AUTH-001: 401 used to sit with the structural 4xx, and that
 * conflated two different statements. A 400 says "this request is
 * invalid"; a 401 says "I do not know who you are RIGHT NOW". The
 * second is a property of the session, not of the capture — the
 * identity may be mid-refresh, or degraded and recovering — and
 * answering it by throwing away a recording in progress destroys
 * evidence over a condition that routinely resolves itself. Deferred
 * registration is exactly the mechanism for "cannot register yet", and
 * the backend is idempotent on (id, user_id), so replaying the same
 * `localSessionId` once identity returns produces one row, not two.
 *
 * The 4xx block is deliberately NOT widened any further: turning every
 * client error into an unbounded retry would hide real defects behind
 * a loop that never ends.
 */
export function isRetryableSessionCreateError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.match(/HTTP (\d{3})/);
  if (!m) return true; // no HTTP status → network/abort
  const status = Number(m[1]);
  if (status === 401) return true; // identity, not input
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

// ----- upload worker (single-flight, multi-session) -----

let isDraining = false;
/**
 * Destination type the drain loop should upload to. Updated by
 * `refreshDestination` whenever the component resolves the active
 * destination. Defaults to 'drive' so all existing behaviour is
 * preserved if the component hasn't resolved yet.
 *
 * NAS wins only when Drive is absent and a connected NAS exists.
 * A UI selector (phase 2) will refine this further.
 */
let activeDestinationType: DestinationType = 'drive';

/**
 * Race guard: the drain loop must NOT route chunks until the active
 * destination has been resolved at least once. Without this, on cold
 * boot / recovery the worker happily picks up pending chunks and ships
 * them to the default 'drive' endpoint before `refreshDestination()`
 * has had a chance to switch the routing target — producing chunks
 * uploaded to the wrong destination, which is a product-correctness
 * bug, not just a perf hiccup.
 *
 * Set to true inside `refreshDestination()` once `activeDestinationType`
 * has been assigned. Stays true for the rest of the process lifetime;
 * subsequent destination changes only update `activeDestinationType`.
 *
 * Intentionally does NOT mark chunks as failed, mutate queue state, or
 * trigger retries — it is a pure deferral. The drain loop will be
 * re-kicked by the existing call sites the moment the destination
 * resolves.
 */
let destinationResolved = false;
/**
 * Cache of base64 contents per `uri` for the rehydration path. Keyed by
 * uri; cleared when the corresponding queue entry is reaped. Avoids
 * re-reading a multi-MB file once per chunk during legacy recovery.
 */
const rehydrationCache = new Map<string, string>();

async function rehydrateChunkSlice(
  entry: PendingQueueEntry,
  chunk: QueueChunk,
): Promise<string | null> {
  // Audio path: in-memory base64 attached at emit, pruned on 200 OK.
  // Always preferred when present — short-circuits before any disk I/O.
  if (chunk.base64Slice) return chunk.base64Slice;

  // Video post-stop path: payload lives on disk under
  // `documentDirectory/chunks/{sessionId}/{chunk_index}.b64`. We
  // wrote it with EncodingType.Base64, so reading with the same
  // encoding gives back the original base64 string. Missing file
  // returns null → pickNext promotes the chunk to permanent failure
  // with REHYDRATE_FAILED, exactly as for a missing legacy recording.
  if (chunk.local_uri) {
    try {
      return await FileSystem.readAsStringAsync(chunk.local_uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } catch (err) {
      console.log('GC_QUEUE local_uri rehydrate read failed', {
        local_uri: chunk.local_uri,
        chunk_index: chunk.chunk_index,
        err,
      });
      return null;
    }
  }

  if (!entry.uri) return null;

  // Legacy video real-time path: do an O(chunk_size) partial read
  // against the recording file. The whole-file read used by the audio
  // legacy fallback below would re-introduce the OutOfMemoryError that
  // motivated this design, so this arm MUST run for any chunk carrying
  // `byteOffset`/`byteLength` even if the file would also be cacheable.
  if (chunk.byteOffset !== undefined && chunk.byteLength !== undefined) {
    try {
      return await FileSystem.readAsStringAsync(entry.uri, {
        encoding: FileSystem.EncodingType.Base64,
        position: chunk.byteOffset,
        length: chunk.byteLength,
      });
    } catch (err) {
      console.log('GC_QUEUE video rehydrate read failed', {
        uri: entry.uri,
        byteOffset: chunk.byteOffset,
        byteLength: chunk.byteLength,
        err,
      });
      return null;
    }
  }

  // Audio legacy fallback: pre-Phase-2 entries (and post-200-OK entries
  // for which we deliberately keep the legacy chunkSize math) read the
  // whole file once and slice the resulting base64 string. Audio is
  // small enough that the whole-file read is safe; only legacy/audio
  // entries reach this branch because new video chunks always carry
  // byteOffset/byteLength.
  let base64 = rehydrationCache.get(entry.uri);
  if (base64 === undefined) {
    try {
      base64 = await readRecordingBase64(entry.uri);
      rehydrationCache.set(entry.uri, base64);
    } catch (err) {
      console.log('GC_QUEUE rehydrate read failed', { uri: entry.uri, err });
      return null;
    }
  }
  return base64SliceAt(base64, chunk, entry);
}

interface NextPick {
  sessionId: string;
  chunk: QueueChunk;
  rehydratedSlice: string;
  /**
   * Destination this session was bound to when recording started.
   * Undefined for legacy entries (no `destination_type`) — the worker
   * then falls back to the current `activeDestinationType`. Carried
   * here so the worker doesn't have to re-read the queue for routing.
   */
  destinationType?: DestinationType | undefined;
}

export async function pickNext(
  queue: PendingQueueEntry[],
  pause: GlobalPauseState,
): Promise<NextPick | null> {
  for (const entry of queue) {
    // PHASE 1A: pause filters live in SELECTION, not in chunk status.
    // A paused entry keeps every chunk `pending` with its bytes intact
    // — we simply do not choose it. That is what makes a pause fully
    // reversible with no reconstruction when it is lifted.
    if (entry.paused) continue;
    if (isDestinationBlocked(pause, entry.destination_type ?? activeDestinationType)) {
      continue;
    }
    const candidate = entry.chunks
      .filter(c => c.status === 'pending')
      .sort((a, b) => a.chunk_index - b.chunk_index)[0];
    if (!candidate) continue;
    const slice =
      candidate.base64Slice ?? (await rehydrateChunkSlice(entry, candidate));
    if (!slice) {
      // Cannot rehydrate (file gone). Mark failed permanent so we don't
      // loop forever on the same chunk.
      await queueUpdateChunk(entry.session_id, candidate.chunk_index, {
        status: 'failed',
        last_error: {
          status: 0,
          code: 'REHYDRATE_FAILED',
          message: 'Recording file missing — cannot recover chunk bytes',
        },
      });
      continue;
    }
    return {
      sessionId: entry.session_id,
      chunk: candidate,
      rehydratedSlice: slice,
      destinationType: entry.destination_type,
    };
  }
  return null;
}

/**
 * PHASE 1A — persist a pause decision, plus the diagnostic error that
 * caused it, in ONE serialized mutation.
 *
 * Everything runs inside `queueMutate` so the pause key and `GC_QUEUE`
 * are written under the same `writeChain`. That is what makes "a new
 * entry cannot slip past an existing global pause" true by
 * construction: an append and a pause write can never interleave.
 *
 * Note what this function never does: it never clears `base64Slice`,
 * never clears `local_uri`, never changes `hash` / `chunk_index` /
 * `size`, and never moves a chunk out of `pending`. A pause is a
 * selection filter, not a terminal state.
 */
async function persistFailurePause(
  sessionId: string,
  chunkIndex: number,
  destinationType: DestinationType,
  failure: Extract<FailureDecision, { kind: 'pause' }>,
): Promise<void> {
  await queueMutate(async (queue) => {
    const entry = queue.find(e => e.session_id === sessionId);

    // The worker flips the chunk to 'uploading' before the attempt. A
    // pause must hand it back as 'pending', otherwise the chunk is
    // stranded in the stuck-uploading state that boot recovery has to
    // repair — and it would not be picked up when the pause lifts.
    // `attempts` is deliberately NOT incremented: a pause is not a
    // failed try, and letting it drive backoff would reintroduce the
    // escalation we are removing.
    const chunk = entry?.chunks.find(c => c.chunk_index === chunkIndex);
    if (chunk && chunk.status === 'uploading') {
      chunk.status = 'pending';
    }

    if (failure.scope === 'ENTRY') {
      if (entry) {
        entry.paused = {
          reason:
            failure.reason === 'SESSION_STATE_PAUSE'
              ? 'SESSION_STATE_PAUSE'
              : 'UNCLASSIFIED_PAUSE',
          at: Date.now(),
          code: failure.code,
        };
      }
      return;
    }

    const current = await readPauseState();
    const next: GlobalPauseState = {
      ...current,
      destinations: { ...current.destinations },
    };
    if (failure.scope === 'DESTINATION') {
      next.destinations[destinationType] = {
        at: Date.now(),
        code: failure.code,
      };
    } else if (failure.reason === 'SYSTEMIC_CONFIG_PAUSE') {
      next.systemic = {
        at: Date.now(),
        code: failure.code,
        policy_version: PAUSE_POLICY_VERSION,
      };
    } else {
      next.client_auth = { at: Date.now(), code: failure.code };
    }
    await writePauseState(next);
  });
}

/**
 * Test-only seam. `destinationResolved` / `activeDestinationType` are
 * normally assigned by the component's `refreshDestination`, which
 * cannot run headless. Exposed so the worker's pause behaviour can be
 * exercised past the destination race-guard. Never called by
 * production code.
 */
export function _setDrainPreconditionsForTests(opts: {
  destinationResolved?: boolean;
  activeDestinationType?: DestinationType;
}): void {
  if (opts.destinationResolved !== undefined) {
    destinationResolved = opts.destinationResolved;
  }
  if (opts.activeDestinationType !== undefined) {
    activeDestinationType = opts.activeDestinationType;
  }
}

export async function uploadDrainLoop(): Promise<void> {
  if (DEBUG_QUEUE) console.log('GC_DEBUG drain called', { isDraining });
  if (isDraining) {
    if (DEBUG_QUEUE) console.log('GC_DEBUG drain skipped — isDraining=true');
    return;
  }
  // Single-flight claim MUST stay synchronous with the check above.
  // PHASE 1A introduces an `await` (pause hydration) before any network
  // work; taking the flag first is what keeps two concurrent callers
  // from both entering. Everything from here is wrapped so the flag is
  // always released — see the outer `finally`.
  isDraining = true;
  try {
    return await drainWithPauseGuard();
  } finally {
    isDraining = false;
  }
}

/**
 * PHASE 1A gate in front of the historical drain body.
 *
 * Nothing in this function may issue a network request before the
 * persisted pause state has been read from disk. On a cold start the
 * previous process may have paused for `NO_TOKEN` or `BODY_TOO_LARGE`;
 * firing a request before hydrating would re-open the retry storm on
 * every app launch. The background drain enters through the same
 * `uploadDrainLoop`, so it inherits this gate — no separate wiring.
 */
async function drainWithPauseGuard(): Promise<void> {
  const pause = await ensurePauseReady();
  if (isGloballyBlocked(pause)) {
    console.log('GC_QUEUE blocked: global pause', {
      client_auth: pause.client_auth?.code ?? null,
      systemic: pause.systemic?.code ?? null,
    });
    return;
  }
  return drainBody(pause);
}

async function drainBody(pause: GlobalPauseState): Promise<void> {
  // Hard race-guard: refuse to route any chunk until `refreshDestination`
  // has resolved the active destination at least once. Without this,
  // boot/recovery would happily drain pending chunks against the default
  // 'drive' endpoint before NAS routing has been applied — uploading
  // bytes to the wrong destination is a product-correctness bug. We
  // intentionally do NOT mutate queue state, mark chunks failed, or
  // bump retry counters — this is a pure deferral. `refreshDestination`
  // re-kicks the drain after flipping the flag so no chunk is starved.
  if (!destinationResolved) {
    console.log('GC_QUEUE blocked: destination not resolved');
    return;
  }
  // `isDraining` is claimed by `uploadDrainLoop` before it awaits, and
  // released in its `finally`. This body must not touch it.
  if (DEBUG_QUEUE) console.log('GC_DEBUG drain entered loop');
  try {
    while (true) {
      // GC_PERF_DRAIN_PICK measures how long it takes to determine the next
      // chunk to send (queueRead + pickNext + base64 rehydrate where
      // applicable). Pure observation; no behavior change.
      const t_pickStart = Date.now();
      const queue = await queueRead();
      const pick = await pickNext(queue, pause);
      perfLog('GC_PERF_DRAIN_PICK', {
        ms: Date.now() - t_pickStart,
        found: pick !== null,
        ...(pick
          ? {
              session_id: pick.sessionId,
              chunk_index: pick.chunk.chunk_index,
            }
          : {}),
      });
      if (!pick) {
        // PHASE 1A: distinguish "nothing left to do" from "everything
        // left is paused". Without this the idle branch below sees a
        // non-empty queue, concludes there is residual work, and spins
        // on a 150ms sleep forever — a wakeup/battery hot loop standing
        // in for the network one we just removed. If every remaining
        // entry is blocked, there is nothing this pass can ever pick:
        // exit and wait for a restoration event.
        const blockedCheck = await queueRead();
        const allBlocked =
          blockedCheck.length > 0 &&
          blockedCheck.every(
            e =>
              e.paused !== undefined ||
              isDestinationBlocked(
                pause,
                e.destination_type ?? activeDestinationType,
              ),
          );
        if (allBlocked) {
          console.log('GC_QUEUE drain exit — all remaining entries paused', {
            entries: blockedCheck.length,
          });
          return;
        }
        // Nothing pending. Try to finalize any closed session whose chunks
        // are all done, then check if any session is still recording.
        const finalized = await tryFinalizeReadySessions();
        const remaining = await queueRead();
        const anyOpen = remaining.some(e => !e.recording_closed);
        const anyResidual = remaining.length > 0 && !finalized;
        if (!anyOpen && !anyResidual) {
          if (DEBUG_QUEUE) console.log('GC_DEBUG drain exit — nothing open, nothing residual');
          return;
        }
        if (DEBUG_QUEUE) {
          console.log('GC_DEBUG drain sleeping — queue empty but session(s) open', {
            anyOpen,
            anyResidual,
            queueSize: remaining.length,
            openSessions: remaining
              .filter(e => !e.recording_closed)
              .map(e => ({
                sid: e.session_id,
                chunks: e.chunks.length,
                statuses: e.chunks.map(c => c.status),
              })),
          });
        }
        // GC_PERF_DRAIN_IDLE_SLEEP fires every time the worker enters its
        // inter-chunk wait window — i.e. nothing pending in the queue, but
        // at least one session is still open or has residual entries the
        // worker may need to reap. The reason + counts are useful when
        // tracing the gap between chunk N uploaded and chunk N+1 uploading.
        //
        // Tuned 500ms → 150ms so the audio cadence (one chunk every ~2s
        // at 64 kbps with 16 KB chunks) is picked up within ~150ms of
        // emit instead of up to 500ms. Single-flight (`isDraining`),
        // retry/backoff, and recovery semantics are intentionally
        // unchanged — backoff sleeps live in the catch branch below
        // with their own `await sleep(backoff)` and are not affected.
        perfLog('GC_PERF_DRAIN_IDLE_SLEEP', {
          ms: 150,
          reason: 'queue_empty_session_open',
          any_open: anyOpen,
          any_residual: anyResidual,
          queue_size: remaining.length,
        });
        await sleep(150);
        continue;
      }

      const { sessionId, chunk, rehydratedSlice } = pick;
      // Per-session pinning: if this session was bound to a destination
      // when recording started, ALL its chunks must use that
      // destination. Settings changes during a recording only affect
      // FUTURE sessions; in-flight sessions keep their original target.
      // Legacy entries (no `destination_type`) fall back to the current
      // `activeDestinationType` so existing pending uploads still drain.
      const sessionDestinationType: DestinationType =
        pick.destinationType ?? activeDestinationType;
      if (DEBUG_QUEUE) {
        console.log('GC_DEBUG drain pending found', {
          sessionId,
          chunk_index: chunk.chunk_index,
          slice_len: rehydratedSlice.length,
          sessionDestinationType,
          legacyFallback: pick.destinationType === undefined,
        });
      }
      await queueUpdateChunk(sessionId, chunk.chunk_index, { status: 'uploading' });
      // Log the EFFECTIVE destination for this chunk (per-session value
      // when present, global fallback otherwise) so logcat grep matches
      // the actual outgoing endpoint.
      console.log('GC_QUEUE chunk uploading', {
        sessionId,
        chunk_index: chunk.chunk_index,
        destinationType: sessionDestinationType,
        pinned: pick.destinationType !== undefined,
      });

      // Outer per-chunk timeout. Wraps the entire upload attempt
      // (uploadChunkBytes + postChunk + queueUpdateChunk('uploaded')) so
      // a hang in any of those layers cannot leave the chunk in
      // 'uploading' forever. The synthetic Error('CHUNK_UPLOAD_TIMEOUT')
      // is a non-ApiError throw, which `classifyError` maps to
      // 'transient' — the existing catch branch then resets the chunk
      // to 'pending' with attempts++ and backoff. Backend dedup means a
      // double-upload (timer fired but original eventually completed)
      // is harmless.
      const uploadStartedAt = Date.now();
      let stuckTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const uploadAttempt = (async () => {
          if (DEBUG_QUEUE) {
            console.log('GC_DEBUG before uploadChunkBytes', {
              sessionId,
              chunk_index: chunk.chunk_index,
            });
          }
          if (chunk.chunk_index === 0) {
            perfLog('GC_PERF_FIRST_CHUNK_UPLOAD_START', {
              session_id: sessionId,
              destination_type: sessionDestinationType,
              size: chunk.size,
            });
          }
          // Single token fetch per chunk: reused for both
          // /destinations/<dest>/chunks AND /chunks. supabase-js caches
          // its session in memory and only hits the network when the
          // access token has expired, so the second internal lookup the
          // worker used to do was almost always a no-op — but this
          // collapses it down to a guaranteed one-call-per-chunk path
          // and avoids the rare race where supabase-js races a refresh
          // with our outgoing request. If the token expires DURING
          // `uploadChunkBytes`, `postChunk` will see a 401 → classifyError
          // marks transient → retry on the next drain pass picks up a
          // fresh token. Same self-healing as before, fewer get-session
          // round-trips on the steady-state path.
          // R5 — OWNERSHIP TOKEN. This is the worker's hot-path cache,
          // reused for `uploadChunkBytes` AND the subsequent `POST /chunks`.
          // Both create remote state, so the cache must be filled from the
          // ownership authority; a plain token here would be the one way a
          // `remote_reference` could appear under a non-durable identity.
          // A null answer produces the same 401 the worker already treats
          // as transient, so the chunk stays `pending` and nothing is lost.
          const accessToken = await getOwnershipAccessToken();
          if (!accessToken) {
            throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
          }
          // GC_PERF_DRAIN_UPLOAD_BYTES isolates the bytes-to-destination leg
          // (mobile → ngrok → backend → Drive/NAS, including the backend's
          // own Google token refresh + uploadFile when destinationType is
          // 'drive'). Compared against GC_PERF_DRAIN_POST_CHUNKS below this
          // tells us whether the bottleneck is the proxy upload or the
          // metadata-only POST /chunks.
          const t_uploadStart = Date.now();
          const drive = await uploadChunkBytes(
            sessionId,
            chunk.chunk_index,
            chunk.hash,
            rehydratedSlice,
            30_000,
            sessionDestinationType,
            accessToken,
          );
          perfLog('GC_PERF_DRAIN_UPLOAD_BYTES', {
            ms: Date.now() - t_uploadStart,
            session_id: sessionId,
            chunk_index: chunk.chunk_index,
            destination_type: sessionDestinationType,
            size: chunk.size,
          });
          // PHASE 1A — runtime validation of the confirmation token.
          //
          // `uploadChunkBytes` ends in `return parsed as
          // DriveChunkUploadResponse` (src/api/destinations.ts) — a bare
          // TypeScript cast over whatever the response body parsed to.
          // There is NO runtime check there, so a 2xx carrying `{}`,
          // `null`, or `remote_reference: ""` reaches us as a
          // structurally invalid confirmation. Without this guard the
          // worker would mark the chunk uploaded, drop `base64Slice`,
          // delete `local_uri`, and leave the completion gate stuck
          // forever on a chunk with no reference — evidence destroyed
          // in exchange for nothing.
          //
          // A 2xx is necessary but NOT sufficient. The reference itself
          // must be a non-empty string before anything local is
          // released. Anything else is treated as a failed attempt:
          // UNCLASSIFIED_PAUSE at entry scope, bytes untouched, and
          // `postChunk` is never told the chunk is uploaded.
          const remoteRef = (
            drive as { remote_reference?: unknown } | null | undefined
          )?.remote_reference;
          if (typeof remoteRef !== 'string' || remoteRef.trim().length === 0) {
            throw new ApiError(
              0,
              'REMOTE_REFERENCE_INVALID',
              'Upload returned 2xx without a usable remote_reference',
              null,
            );
          }
          if (DEBUG_QUEUE) {
            console.log('GC_DEBUG after uploadChunkBytes', {
              sessionId,
              chunk_index: chunk.chunk_index,
              remote_reference: remoteRef,
            });
          }
          // GC_PERF_DRAIN_POST_CHUNKS isolates the metadata leg (mobile →
          // ngrok → backend → DB INSERT). Should be small in steady state
          // but a multi-hundred-ms value here points at ngrok or DB latency.
          const t_postStart = Date.now();
          await postChunk(
            accessToken,
            sessionId,
            { chunk_index: chunk.chunk_index, hash: chunk.hash, size: chunk.size },
            'uploaded',
            // The validated value, not the raw response field, so the
            // guard above cannot be bypassed by a later edit.
            remoteRef,
          );
          perfLog('GC_PERF_DRAIN_POST_CHUNKS', {
            ms: Date.now() - t_postStart,
            session_id: sessionId,
            chunk_index: chunk.chunk_index,
          });
          // PHASE 1A — the ONLY legal place in the codebase where local
          // bytes may be released. Ordering is a hard requirement, not
          // an optimisation:
          //
          //   2xx received
          //     → remote_reference present
          //       → 'uploaded' + remote_reference DURABLY persisted
          //         → and only then may bytes/files be dropped.
          //
          // If this write throws (CursorWindow, storage full, ...) the
          // remote copy exists but we have no durable record of it. We
          // must NOT delete anything: the queue on disk still says
          // pending, so the chunk will be retried and the backend's
          // dedup will absorb it. Deleting here would strand evidence
          // that our own queue no longer knows is safe.
          let confirmationPersisted = false;
          try {
            await queueUpdateChunk(sessionId, chunk.chunk_index, {
              status: 'uploaded',
              base64Slice: undefined,         // released: confirmed remote
              remote_reference: remoteRef,
              last_error: undefined,
            });
            confirmationPersisted = true;
          } catch (persistErr) {
            console.log('GC_QUEUE_CONFIRMED_PERSIST_FAILED', {
              sessionId,
              chunk_index: chunk.chunk_index,
              remote_reference: remoteRef,
              err:
                persistErr instanceof Error
                  ? persistErr.message
                  : String(persistErr),
            });
            // Surface to the outer catch so the chunk is re-attempted.
            // Local bytes and local_uri are untouched.
            throw persistErr;
          }
          if (chunk.chunk_index === 0) {
            perfLog('GC_PERF_FIRST_CHUNK_UPLOADED', {
              session_id: sessionId,
              destination_type: sessionDestinationType,
              remote_reference: remoteRef,
            });
          }
          // Best-effort cleanup of the on-disk video payload. The file
          // is no longer needed once the chunk is acknowledged on the
          // backend AND in Drive; leaving it would just consume disk
          // until the session reaps. Audio chunks have no local_uri,
          // so this is a no-op for them.
          // `confirmationPersisted` is the gate. A local delete failure
          // is still best-effort and never reverts the remote
          // confirmation — the queue already records it as uploaded.
          if (confirmationPersisted && chunk.local_uri) {
            try {
              await FileSystem.deleteAsync(chunk.local_uri, { idempotent: true });
            } catch (cleanupErr) {
              console.log('GC_QUEUE local_uri cleanup failed', {
                sessionId,
                chunk_index: chunk.chunk_index,
                local_uri: chunk.local_uri,
                err: cleanupErr,
              });
            }
          }
          console.log('GC_QUEUE chunk uploaded', {
            sessionId,
            chunk_index: chunk.chunk_index,
            remote_reference: remoteRef,
          });
        })();
        // Suppress unhandled-rejection if the timer wins and the upload
        // eventually rejects after the catch has already moved on.
        // Promise.race below is what propagates the rejection while the
        // race is still pending.
        uploadAttempt.catch(() => {});

        const stuckSentinel = new Promise<never>((_, reject) => {
          stuckTimer = setTimeout(() => {
            console.log('GC_QUEUE upload stuck detected', {
              sessionId,
              chunk_index: chunk.chunk_index,
              ageMs: Date.now() - uploadStartedAt,
            });
            reject(new Error('CHUNK_UPLOAD_TIMEOUT'));
          }, CHUNK_UPLOAD_TIMEOUT_MS);
        });

        await Promise.race([uploadAttempt, stuckSentinel]);
      } catch (err) {
        const decision = classifyError(err);
        const errShape = shapeError(err);
        // Server-side reasons (DRIVE_NOT_CONNECTED, HASH_MISMATCH,
        // SESSION_NOT_FOUND, etc.) and Google API errors are carried
        // on `ApiError.body`. Surface that whole object alongside the
        // shaped status/code/message so the operator does not have to
        // tail the backend logs to know why a chunk failed. The shape
        // persisted to the queue (`last_error`) stays compact — only
        // the diagnostic console.log carries the body.
        const errorDetail = {
          sessionId,
          chunk_index: chunk.chunk_index,
          status: errShape.status,
          code: errShape.code,
          message: errShape.message,
          body: err instanceof ApiError ? err.body : undefined,
        };
        // Single canonical diagnostic line emitted for every failure
        // (transient OR permanent) so the operator never has to guess
        // whether the chunk gave up or will retry. The legacy
        // `chunk transient — backoff` line earlier in the log hid the
        // real reason; this one carries it inline.
        console.log('GC_QUEUE chunk upload failed detail', {
          ...errorDetail,
          classification: decision,
        });

        // PHASE 1A — pause policy runs BEFORE the legacy
        // transient/permanent split. `classifyFailure` uses a closed
        // allow-list: only failures it positively recognises as
        // transport faults fall through to the historical backoff. Any
        // pause decision exits the loop immediately — no attempts++, no
        // backoff sleep, no `continue`, and above all no pruning. The
        // chunk stays `pending` with its bytes so it resumes intact.
        const failure = classifyFailure(err);
        if (failure.kind === 'pause') {
          // The write is awaited before we return so the worker can
          // never hand control back with the pause only in memory.
          await persistFailurePause(
            sessionId,
            chunk.chunk_index,
            sessionDestinationType,
            failure,
          );
          console.log('GC_QUEUE chunk paused', {
            ...errorDetail,
            pause_reason: failure.reason,
            pause_scope: failure.scope,
          });
          return;
        }

        if (decision === 'permanent') {
          // Unreachable in practice: every status that `classifyError`
          // calls permanent is a pause above. Kept as a defensive
          // branch, but it no longer prunes — nothing that was not
          // confirmed off-device may lose its bytes.
          await queueUpdateChunk(sessionId, chunk.chunk_index, {
            status: 'failed',
            last_error: errShape,
          });
          console.log('GC_QUEUE chunk failed (permanent)', errorDetail);
        } else {
          const attempts = chunk.attempts + 1;
          await queueUpdateChunk(sessionId, chunk.chunk_index, {
            status: 'pending',
            attempts,
            last_error: errShape,
          });
          const backoff = Math.min(2 ** attempts * 1000, 30_000);
          // Two lines on purpose: detail first (the real reason), then
          // the throttling decision (attempts + sleep). Earlier builds
          // emitted only the second line, hiding why the chunk failed.
          console.log('GC_QUEUE chunk transient — error detail', errorDetail);
          console.log('GC_QUEUE chunk transient — backoff', {
            sessionId,
            chunk_index: chunk.chunk_index,
            attempts,
            backoff,
          });
          await sleep(backoff);
        }
      } finally {
        if (stuckTimer !== null) clearTimeout(stuckTimer);
      }
    }
  } finally {
    if (DEBUG_QUEUE) console.log('GC_DEBUG drain body exited');
  }
}

/**
 * PHASE 1A — the only event that may lift `CLIENT_SESSION_EXPIRED`.
 *
 * Registered at module scope, so it exists from the moment this module
 * is imported. `auth/store.ts` may fire before that (supabase-js
 * restores a persisted session during its own init); `pauseStore`
 * retains that notification and delivers it here exactly once on
 * registration. The event cannot be lost, and it cannot be applied
 * twice.
 *
 * Idempotence is what keeps repeated `TOKEN_REFRESHED` events from
 * requesting repeated drains: if no client-auth pause is set, this is a
 * no-op and no drain is requested. A valid login therefore requests
 * exactly one drain.
 *
 * Scope discipline: this clears `client_auth` and nothing else. A
 * Supabase login must not lift a Drive pause, a systemic pause, or any
 * entry pause.
 */
registerAuthRestoreHandler((usable: boolean) => {
  if (!usable) return;
  void (async () => {
    try {
      // Cheap fast path: skip the write chain entirely for the common
      // TOKEN_REFRESHED case where no pause is in force. This is an
      // optimisation, NOT the decision point — see below.
      const state = await ensurePauseReady();
      if (!state.client_auth) return;

      // The decision to request a drain must depend on THIS invocation
      // having actually performed the `client_auth: value → null`
      // transition. A burst of simultaneous events (init() + a
      // subsequent INITIAL_SESSION, or several TOKEN_REFRESHED in one
      // tick) all pass the check above while the pause still exists;
      // they then serialize here, and only one of them finds a pause
      // left to clear. Deciding on the pre-check instead would have
      // every member of the burst request its own drain.
      let clearedByThisInvocation = false;
      await queueMutate(async () => {
        const current = await readPauseState();
        if (!current.client_auth) return;
        await writePauseState({ ...current, client_auth: null });
        clearedByThisInvocation = true;
      });
      if (!clearedByThisInvocation) return;

      console.log('GC_QUEUE client auth pause cleared');
      await uploadDrainLoop();
    } catch (err) {
      console.log('GC_QUEUE client auth restore failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

/**
 * GC-DEST-PAUSE-001 — retire a destination pause whose cause is provably
 * gone.
 *
 * The defect: `destinations[type]` could be written and never removed.
 * `client_auth` got a recovery signal (`notifyClientAuth` from the
 * Supabase lifecycle) and a handler to act on it; `destinations` got
 * neither. So a Drive pause survived reconnecting Drive, survived a cold
 * start, and blocked the drain forever. Evidence stayed durable and
 * local — nothing was ever lost — but it could not leave the device.
 * Observed on hardware: 54 chunks pending, 0 uploading, indefinitely.
 *
 * ## What counts as proof, and what does NOT
 *
 * The ONLY accepted signal is the backend confirming this specific
 * destination: `listDestinations()` returning a row with
 * `type === T && status === 'connected'`. That is the direct negation of
 * the 409 `DRIVE_NOT_CONNECTED` ("No connected Google Drive destination
 * for this user") that created the pause.
 *
 * `destinationResolved` is NOT proof and must never be used here. It is
 * a race guard meaning "routing is known", and `refreshDestination` sets
 * it to `true` even when NOTHING is connected — the routing line falls
 * back to `'drive'` with zero destinations. On hardware we observed
 * `destinationResolved: true` coexisting with an active Drive pause and
 * a disconnected Drive. Clearing on it would unblock a broken
 * destination.
 *
 * Elapsed time is NOT proof either. `at` is never read.
 *
 * ## Scope discipline
 *
 * Clears `destinations[T]` for the confirmed T and nothing else. A Drive
 * reconnection must not lift a NAS pause, a `client_auth` pause, a
 * `systemic` pause, or any entry pause. Touches no queue entry and no
 * chunk: it only grants permission, never discards evidence.
 *
 * ## Atomicity
 *
 * The decision to report a transition depends on THIS invocation having
 * performed `paused → unpaused` inside the `queueMutate` chain. Two
 * concurrent `refreshDestination` calls can both observe `connected`;
 * only the one that still finds the pause present may claim it and ask
 * for a drain. Same rule the `client_auth` restore handler already uses,
 * and for the same reason.
 *
 * Returns the destination types this invocation actually unblocked.
 */
export async function clearRecoveredDestinationPauses(
  connected: Partial<Record<DestinationType, boolean>>,
): Promise<DestinationType[]> {
  const confirmed = (Object.keys(connected) as DestinationType[]).filter(
    (type) => connected[type] === true,
  );
  if (confirmed.length === 0) return [];

  // Cheap fast path: skip the write chain when nothing is paused. An
  // optimisation, NOT the decision point — the decision is made below,
  // under the chain, against a fresh read.
  const snapshot = await ensurePauseReady();
  const candidates = confirmed.filter(
    (type) => snapshot.destinations[type] !== undefined,
  );
  if (candidates.length === 0) return [];

  const cleared: DestinationType[] = [];
  await queueMutate(async () => {
    const current = await readPauseState();
    const next: GlobalPauseState = {
      ...current,
      destinations: { ...current.destinations },
    };
    let changed = false;
    for (const type of candidates) {
      // Re-checked inside the chain: a concurrent invocation may have
      // won this transition already. Only the winner reports it.
      if (next.destinations[type] === undefined) continue;
      delete next.destinations[type];
      cleared.push(type);
      changed = true;
    }
    if (changed) await writePauseState(next);
  });

  if (cleared.length > 0) {
    console.log('GC_QUEUE destination pause cleared', { destinations: cleared });
  }
  return cleared;
}

/**
 * For each entry whose recording is closed and whose chunks are all
 * resolved (uploaded or failed), call POST /sessions/:id/complete and
 * then drop the entry. Returns true if any entry was finalized in this
 * pass (used to decide whether the drain loop should keep spinning).
 */
/**
 * Per-session log throttle for `GC_QUEUE completion gate`. The drain
 * loop calls `tryFinalizeReadySessions` every ~500ms; without this the
 * same `missingUploadedIndexes` line floods the console while the user
 * stares at a blocked session.
 *
 * Re-emit rule: only log when the missing-set signature changes OR when
 * `COMPLETION_GATE_LOG_TTL_MS` has elapsed since the last emission for
 * this session. The companion `GC_QUEUE missing chunk states` line is
 * emitted on the same trigger so the two are always read together.
 *
 * Cleanup: `reapEntry` deletes the per-session record so the Map cannot
 * grow without bound across long-running app sessions.
 */
interface CompletionGateLogState {
  signature: string;
  lastLoggedAt: number;
}
const completionGateLogState = new Map<string, CompletionGateLogState>();
const COMPLETION_GATE_LOG_TTL_MS = 10_000;

/** Canonical lowercase UUID — the only shape a session directory may carry. */
const CANONICAL_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Removes `documentDirectory/segments/<sid>/` — the verified stable copies.
 *
 * Deliberately NOT part of `reapEntry`. That runs on paths with no durable
 * confirmation at all, including the give-up after MAX_COMPLETE_ATTEMPTS, and
 * deleting evidence there would destroy bytes whose remote existence was never
 * proven. This only ever runs from a journal entry.
 *
 * Idempotent, and reports partial progress instead of claiming success: the
 * runner keeps the resource pending and the next pass finishes the job.
 */
async function cleanStableSegmentsDir(sessionId: string): Promise<CleanupOutcome> {
  if (!CANONICAL_SESSION_ID.test(sessionId)) {
    return { result: 'SESSION_ID_INVALID', removed: 0, remaining: 0 };
  }
  const dir = stableSegmentDir(sessionId);
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return { result: 'ALREADY_ABSENT', removed: 0, remaining: 0 };
    const before = await FileSystem.readDirectoryAsync(dir);
    await FileSystem.deleteAsync(dir, { idempotent: true });
    const after = await FileSystem.getInfoAsync(dir);
    if (!after.exists) {
      return { result: 'CLEANED', removed: before.length, remaining: 0 };
    }
    const rest = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
    return {
      result: 'PARTIAL',
      removed: Math.max(0, before.length - rest.length),
      remaining: rest.length,
    };
  } catch {
    return { result: 'DIR_UNAVAILABLE', removed: 0, remaining: -1 };
  }
}

/**
 * The durable authorization record for deleting a completed session's local
 * evidence. Its own AsyncStorage key — never GC_QUEUE, never the history index.
 */
const sessionCleanupJournal = createSessionCleanupJournal({
  storage: {
    getItem: (k) => AsyncStorage.getItem(k),
    setItem: (k, v) => AsyncStorage.setItem(k, v),
  },
  clock: { now: () => Date.now() },
  logger: {
    log: (event, fields) => {
      console.log(event, fields);
    },
  },
});

const sessionCleanupRunner = createSessionCleanupRunner({
  journal: sessionCleanupJournal,
  cleanNativeCache: (sid) => GCSegmentedRecorder.cleanupCompletedSession(sid),
  cleanStableSegments: cleanStableSegmentsDir,
  logger: {
    log: (event, fields) => {
      console.log(event, fields);
    },
  },
});

/**
 * Single-flight front door to the cleanup runner.
 *
 * Every trigger goes through here and none of them waits: cleanup is durable
 * maintenance, so it must never delay recovery, network reconciliation or the
 * user's ability to start recording. A request arriving while a pass is running
 * produces exactly one more pass, which is what keeps a session finalized
 * mid-pass from waiting until the next launch.
 */
const sessionCleanupScheduler = createCleanupScheduler({
  runner: sessionCleanupRunner,
  logger: {
    log: (event, fields) => {
      console.log(event, fields);
    },
  },
});

/**
 * THE single place where a session's local evidence becomes deletable.
 *
 * Calls `completeSession`, classifies what actually happened, and only for a
 * real 200 or 409 performs the four durable steps, in this order:
 *
 *   1. journal.authorize   — persistent proof the backend confirmed
 *   2. queueMarkSessionCompleted
 *   3. reapEntry
 *
 * Step 1 must precede step 2, not merely step 3. `session_completed = true` is
 * on its own enough to reap — `reapAlreadyDoneEntries` and the branch at the
 * top of the finalize loop both do it without asking the backend again — and
 * reaping destroys the last reference to the session id. Writing the journal
 * after step 2 would leave a window where a process death produces a completed,
 * reaped session with no authorization, and its directory would then be
 * indistinguishable from an interrupted capture: unreachable forever.
 *
 * The backend and AsyncStorage are not one transaction. What covers the gap
 * between the 200 and step 1 is the queue entry itself: it is still there, so
 * the next drain retries, the backend answers 409, and that is an equally
 * durable authorization.
 *
 * Anything that is not a 200 or a 409 returns `failed` and writes NOTHING. The
 * caller decides how to report it; no caller may authorize a cleanup by itself,
 * because `authorize` takes a branded value only `classifyCompletion` produces.
 */
/**
 * Every failure reason is a closed literal. Nothing derived from an exception
 * message reaches a caller, and therefore no log.
 */
type FinalizeFailureReason =
  | CompletionFailureCode
  | 'session_id_invalid'
  | 'journal_unusable'
  | 'authorization_conflict'
  | 'clock_invalid'
  | 'authorization_threw';

type FinalizeOutcome =
  | { kind: 'completed' }
  | { kind: 'already_completed' }
  | { kind: 'confirmed_reap_pending' }
  | { kind: 'failed'; reason: FinalizeFailureReason };

async function finalizeAndAuthorizeCleanup(
  token: OwnershipToken,
  sessionId: string,
  uri: string,
): Promise<FinalizeOutcome> {
  let outcome: CompletionOutcome;
  try {
    await completeSession(token, sessionId);
    outcome = { kind: 'resolved' };
  } catch (err) {
    outcome = {
      kind: 'threw',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const authorization = classifyCompletion(outcome);
  if (!authorization) {
    // Not confirmed. Nothing local changes, and the queue entry stays so the
    // next drain retries. The message itself never leaves this function.
    return { kind: 'failed', reason: classifyCompletionFailure(outcome) };
  }

  // The authorization must be ON DISK before anything downstream runs. A write
  // that refused — invalid id, unusable journal, conflicting entry — or that
  // threw leaves the queue entry exactly where it is: reaping on the strength
  // of an authorization that was never recorded is precisely how a directory
  // becomes unreachable forever.
  let written: AuthorizationWriteResult;
  try {
    written = await sessionCleanupJournal.authorize(sessionId, authorization);
  } catch {
    return { kind: 'failed', reason: 'authorization_threw' };
  }
  if (!written.ok) {
    return { kind: 'failed', reason: written.reason };
  }

  await queueMarkSessionCompleted(sessionId);
  try {
    await reapEntry(sessionId, uri);
  } catch {
    // Completion and its cleanup authorization are already durable, and the
    // queue entry is already marked completed. Reaping is local maintenance:
    // leave the entry for the next pass without turning the confirmed remote
    // completion into a failed attempt or calling completeSession again.
    return { kind: 'confirmed_reap_pending' };
  }

  // Only here, once the authorization is on disk and both the mark and the reap
  // have finished. Every earlier return path — an unconfirmed completion, a
  // refused or thrown authorization — leaves without asking for cleanup,
  // because there is nothing the runner would be allowed to delete yet.
  //
  // Non-blocking and unawaited on purpose: the backend has confirmed and
  // GC_QUEUE is already gone, so a cleanup failure must not become a
  // finalization failure, must not bump complete_attempts, and must not send
  // this session back through completeSession.
  sessionCleanupScheduler.requestCleanup('finalized');

  return authorization.code === 'http_200'
    ? { kind: 'completed' }
    : { kind: 'already_completed' };
}

/**
 * G2' — compatibility authority for ONE decision, and only one:
 * whether `tryFinalizeReadySessions` may advance a Protection Session
 * towards `POST /complete`.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────
 * This is NOT "the reader of terminality" for the system. Other places
 * read `recording_closed` under DIFFERENT, still-valid semantics —
 * "the evidence set is final" for D3 and the protection banner, "the
 * session is still open, keep spinning" for the drain loop. G2' does
 * not reinterpret, own, or modify any of them.
 *
 * ── SEMANTICS ──────────────────────────────────────────────────────
 *   `evidence_closed === true`   → may advance
 *   `evidence_closed === false`  → BLOCKED, whatever `recording_closed`
 *                                  says. In an entry written by a later
 *                                  gate this means "Protection Session
 *                                  still open" even though the producer
 *                                  is closed — the whole point of the
 *                                  decoupling.
 *   `evidence_closed` absent     → metadata unavailable, neither open
 *                                  nor closed; defer to the standing
 *                                  contract, `recording_closed`.
 *
 * `??` and not `||`: only ABSENCE delegates. A `||` would let a stale
 * `recording_closed = true` override an explicit `false` and complete a
 * session that is still accepting evidence.
 *
 * Behaviour today is unchanged: every product writer stamps
 * `evidence_closed === recording_closed`, so this returns exactly what
 * the previous `!entry.recording_closed` test returned for every entry
 * reachable at 8983bad — including pre-G1 and migrated entries, which
 * carry no key and fall through to `recording_closed`.
 */
export function canAdvanceToTerminality(
  entry: Pick<PendingQueueEntry, 'evidence_closed' | 'recording_closed'>,
): boolean {
  return entry.evidence_closed ?? entry.recording_closed;
}

export async function tryFinalizeReadySessions(): Promise<boolean> {
  const queue = await queueRead();
  let anyFinalized = false;
  for (const entry of queue) {
    if (!canAdvanceToTerminality(entry)) continue;

    // Skip if anything is still in motion — the worker will process
    // those and we will re-evaluate on the next drain pass.
    const anyInMotion = entry.chunks.some(
      c => c.status === 'pending' || c.status === 'uploading',
    );
    if (anyInMotion) continue;

    // Completion gate. The previous logic accepted `failed` chunks as
    // "settled" and called completeSession with gaps in Drive — the
    // backend then marked the session done while chunks 2..8 (or any
    // permanently-failed range) were missing, producing partial,
    // unplayable exports. The gate now requires every chunk_index in
    // 0..next_chunk_index-1 to be `status='uploaded'` AND carry a
    // truthy `remote_reference`. Missing indexes block completion;
    // the entry stays in the queue (no reap, no completeSession call)
    // for the user to resolve manually.
    const expectedChunks = entry.next_chunk_index;
    const uploadedIndexes = new Set(
      entry.chunks
        .filter(c => c.status === 'uploaded' && !!c.remote_reference)
        .map(c => c.chunk_index),
    );
    const missingUploadedIndexes: number[] = [];
    for (let i = 0; i < expectedChunks; i++) {
      if (!uploadedIndexes.has(i)) missingUploadedIndexes.push(i);
    }

    // Throttled gate log. Re-emit on signature change OR after the TTL
    // has elapsed, never on every drain tick.
    const signature = missingUploadedIndexes.join(',');
    const prevLog = completionGateLogState.get(entry.session_id);
    const nowMs = Date.now();
    const shouldLog =
      !prevLog ||
      prevLog.signature !== signature ||
      nowMs - prevLog.lastLoggedAt >= COMPLETION_GATE_LOG_TTL_MS;
    if (shouldLog) {
      console.log('GC_QUEUE completion gate', {
        sessionId: entry.session_id,
        expectedChunks,
        uploadedChunks: uploadedIndexes.size,
        missingUploadedIndexes,
      });
      if (missingUploadedIndexes.length > 0) {
        // Compact diagnostic for blocked sessions: per-missing-index
        // status snapshot so the operator can see at a glance whether
        // the chunks are absent from the queue, sitting in `failed`,
        // missing their `base64Slice`, or missing `remote_reference`.
        const missingSet = new Set(missingUploadedIndexes);
        const presentByIndex = new Map<number, QueueChunk>();
        for (const c of entry.chunks) {
          if (missingSet.has(c.chunk_index)) presentByIndex.set(c.chunk_index, c);
        }
        const missing = missingUploadedIndexes.map(idx => {
          const c = presentByIndex.get(idx);
          if (!c) {
            // Chunk index expected (< next_chunk_index) but no entry in
            // the queue at all — this is the "never emitted / lost in
            // migration" case, distinct from `failed`.
            return {
              chunk_index: idx,
              status: 'absent' as const,
              hasBase64Slice: false,
              hasRemoteReference: false,
              attempts: 0,
              last_error: undefined,
            };
          }
          return {
            chunk_index: c.chunk_index,
            status: c.status,
            hasBase64Slice: !!c.base64Slice,
            hasRemoteReference: !!c.remote_reference,
            attempts: c.attempts,
            last_error: c.last_error,
          };
        });
        console.log('GC_QUEUE missing chunk states', {
          sessionId: entry.session_id,
          missing,
        });
      }
      completionGateLogState.set(entry.session_id, {
        signature,
        lastLoggedAt: nowMs,
      });
    }

    // GC-AUTH-001 — the vacuous-gate guard.
    //
    // The gate asks "is every index in 0..expectedChunks-1 uploaded?".
    // For an entry whose chunker never ran, that range is EMPTY, so the
    // answer is trivially yes and the entry sails through: `/complete`
    // fires against a session that may not even exist server-side, and
    // `reapEntry` then deletes the recording the entry points at.
    //
    // "The empty set is fully uploaded" is true arithmetic and a
    // catastrophic operational rule. A zero-chunk entry is not proof of
    // complete remote evidence — it is proof of nothing at all, and the
    // file on disk may be a real capture the chunker had not reached yet.
    //
    // So: never complete, never reap. Deciding how these entries are
    // eventually cleaned up is deliberately left open; keeping a useless
    // entry costs a few bytes, and deleting a potential capture costs
    // the evidence.
    if (expectedChunks === 0) {
      console.log('GC_QUEUE completion gate — zero-chunk entry held', {
        sessionId: entry.session_id,
        recording_closed: entry.recording_closed,
        uri: entry.uri,
      });
      continue;
    }

    if (missingUploadedIndexes.length > 0) {
      // Observability-only diagnostic — does NOT change behaviour.
      // Detect the "stuck forever" shape: the missing indexes are NOT
      // pending/uploading (worker cannot make progress on them) AND at
      // least one chunk did upload. This is qualitatively different
      // from "still uploading", and the operator needs to see it
      // explicitly so beta logs distinguish "blocked by permanent
      // failure" from "in flight".
      //
      // Throttled to the same shouldLog cadence as the gate log so we
      // never flood logcat. The session stays in the queue (existing
      // behaviour preserved); a future iteration may decide whether to
      // give-up-and-reap based on these signals from the field.
      if (shouldLog) {
        const missingSet = new Set(missingUploadedIndexes);
        const allFailedOrAbsent = missingUploadedIndexes.every(idx => {
          const c = entry.chunks.find(x => x.chunk_index === idx);
          // Absent = chunk_index expected but no entry at all.
          // Failed  = terminal, worker won't retry.
          // Both are "permanently stuck" from the worker's POV.
          return !c || c.status === 'failed';
        });
        if (allFailedOrAbsent && uploadedIndexes.size > 0) {
          console.log('GC_QUEUE_STUCK_PERMANENT_FAILURE', {
            sessionId: entry.session_id,
            expectedChunks,
            uploadedCount: uploadedIndexes.size,
            missingCount: missingSet.size,
            missingIndexes: missingUploadedIndexes,
          });
        }
      }
      // Do NOT call completeSession. Keeping the session row as `active`
      // on the backend is the correct outcome — anything else would
      // mark a session "complete" with permanent gaps.
      continue;
    }

    if (entry.session_completed) {
      await reapEntry(entry.session_id, entry.uri);
      sessionCleanupScheduler.requestCleanup('finalized');
      anyFinalized = true;
      continue;
    }
    if (entry.complete_attempts >= MAX_COMPLETE_ATTEMPTS) {
      // Give up on completion. Chunks are server-safe; the session row
      // is left as `active` for manual reconciliation.
      console.log('GC_QUEUE session complete give-up', {
        sessionId: entry.session_id,
        attempts: entry.complete_attempts,
      });
      await reapEntry(entry.session_id, entry.uri);
      anyFinalized = true;
      continue;
    }
    try {
      // R5 — OWNERSHIP TOKEN. `POST /sessions/:id/complete` mutates a row
      // this user owns and authorises deleting local evidence. Both are
      // ownership operations.
      const token = await getOwnershipAccessToken();
      if (!token) throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
      // Both the fresh-200 and the already-completed-409 branches now go
      // through one helper, so the ordering that makes the cleanup journal
      // safe cannot drift between them. A 409 is recognised because a
      // previous attempt's response may have been lost (network blip, app
      // kill between the 200 and the local write) and the backend answers
      // it on retry — the same terminal fact, reached later.
      const finalized = await finalizeAndAuthorizeCleanup(
        token,
        entry.session_id,
        entry.uri,
      );
      if (finalized.kind === 'failed') {
        const attempts = await queueBumpCompleteAttempts(entry.session_id);
        console.log('GC_QUEUE session complete failed', {
          sessionId: entry.session_id,
          attempts,
          reason: finalized.reason,
        });
        continue;
      }
      if (finalized.kind === 'confirmed_reap_pending') {
        console.log('GC_QUEUE_SESSION_REAP_DEFERRED', {
          sid_prefix: entry.session_id.slice(0, 8),
          reason: 'reap_threw',
        });
        continue;
      }
      anyFinalized = true;
      console.log(
        finalized.kind === 'completed'
          ? 'GC_QUEUE session completed'
          : 'GC_QUEUE session already completed (server) — reaping',
        { sessionId: entry.session_id },
      );
    } catch {
      // Only reachable from the token lookup above; the helper never throws.
      // Closed reason, so nothing from the exception is logged.
      const attempts = await queueBumpCompleteAttempts(entry.session_id);
      console.log('GC_QUEUE session complete failed', {
        sessionId: entry.session_id,
        attempts,
        reason: 'token_or_unexpected',
      });
    }
  }
  return anyFinalized;
}

export async function reapEntry(sessionId: string, uri: string): Promise<void> {
  await queueDropEntry(sessionId);
  rehydrationCache.delete(uri);
  completionGateLogState.delete(sessionId);
  await deleteRecordingBestEffort(uri);
  // Catch-all cleanup of the per-session chunks directory used by the
  // video post-stop path. Successful uploads delete files one by one;
  // permanent-failure / give-up paths leave files behind. Removing the
  // whole directory at reap time keeps disk usage bounded regardless
  // of which terminal path the session took.
  const docDir = FileSystem.documentDirectory;
  if (docDir) {
    const sessionDir = `${docDir}chunks/${sessionId}/`;
    try {
      await FileSystem.deleteAsync(sessionDir, { idempotent: true });
    } catch (err) {
      console.log('GC_QUEUE chunks dir cleanup failed', { sessionId, err });
    }
  }
}

/**
 * Closes a live recorder so its bytes are flushed and its FINAL uri is
 * known, for the abandon path (GC-AUTH-001, 4A).
 *
 * Mirrors the closing half of `stopRecording`, and must keep mirroring
 * it: the uri a recorder ends up with is NOT the one the caller started
 * with. For audio the engine reports the uri it captured before `stop()`
 * flushed; for video `recordAsync` resolves with the camera's own
 * authoritative uri, which is the only one guaranteed to point at the
 * finished file. Promoting a stale `cacheUri` instead can move a
 * placeholder, or nothing at all, and call it preserved evidence.
 *
 * Precedence for video matches `stopRecording`: camera uri first, then
 * the uri the chunker has been reading (still real bytes on disk, just
 * partial) when `recordAsync` rejected.
 *
 * Dependencies are injected rather than read from component refs so the
 * ordering guarantee this function exists to provide is testable.
 * Returns null when nothing usable could be closed.
 */
export async function closeRecorderForAbandon(deps: {
  hadAudio: boolean;
  stopAudio: () => Promise<string | null>;
  stopCamera: () => void;
  videoPromise: Promise<{ uri?: string } | null | undefined> | null;
  chunkedUri: string | null;
}): Promise<string | null> {
  if (deps.hadAudio) {
    try {
      return await deps.stopAudio();
    } catch (err) {
      console.log('GC_LOCAL_FIRST abandon audio stop failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  try {
    deps.stopCamera();
  } catch (err) {
    console.log('GC_LOCAL_FIRST abandon camera stop threw', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let cameraUri: string | null = null;
  if (deps.videoPromise) {
    try {
      const result = await deps.videoPromise;
      cameraUri = result?.uri ?? null;
    } catch (err) {
      console.log('GC_LOCAL_FIRST abandon recordAsync rejected', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return cameraUri ?? deps.chunkedUri;
}

/**
 * Terminal path for a capture that became durable in GC_QUEUE but whose
 * backend registration failed non-retryably (GC-AUTH-001, 4A).
 *
 * MUST be called with a recorder that is already closed and with the
 * uri that closing actually produced — see `closeRecorderForAbandon`.
 * Moving a file out from under a live recorder is not preservation.
 *
 * Why the entry cannot simply be left in place: with the chunker never
 * started, `next_chunk_index` is 0, and the completion gate iterates an
 * empty range. That vacuous pass is now blocked by an explicit guard in
 * `tryFinalizeReadySessions`, but the entry is still useless as it
 * stands, so a confirmed promotion supersedes it.
 *
 * Why the file cannot simply be abandoned either: it lives in
 * `cacheDirectory` under the recorder's own name. `orphanScan` only
 * sweeps `documentDirectory` for `guardian_recording_*`, and the move
 * that produces that name happens in `stopRecording`, which never runs
 * on this path. The bytes would be invisible to every recovery route
 * and would disappear with the next cache reclaim.
 *
 * THE RULE, and it is one-directional:
 *
 *   promotion confirmed      → the entry may be dropped
 *   promotion NOT confirmed  → GC_QUEUE MUST survive
 *
 * A dropped entry after a failed move would leave the bytes referenced
 * by nothing durable at all — the precise loss 4A exists to close. So
 * the entry is only ever retired once something else is holding the
 * evidence, and the move happens first so that a process death between
 * the two steps errs towards a redundant reference rather than none.
 */
export async function abandonUnregisteredSession(
  sessionId: string,
  finalUri: string | null,
): Promise<{ moved_to: string | null; entry_dropped: boolean }> {
  let movedTo: string | null = null;

  const docDir = FileSystem.documentDirectory;
  if (docDir && finalUri) {
    const extMatch = finalUri.match(/\.[A-Za-z0-9]{1,8}$/);
    const ext = extMatch ? extMatch[0] : '.m4a';
    const target = `${docDir}guardian_recording_${Date.now()}${ext}`;
    try {
      await FileSystem.moveAsync({ from: finalUri, to: target });
      movedTo = target;
    } catch (err) {
      console.log('GC_LOCAL_FIRST abandon move failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (movedTo === null) {
    // Nothing else is holding these bytes. The entry stays, whatever it
    // costs in tidiness — it is the only durable reference left.
    console.log('GC_LOCAL_FIRST session abandoned — entry RETAINED', {
      sessionId,
      promoted_to_orphan: false,
      reason: finalUri ? 'move_failed' : 'no_final_uri',
    });
    return { moved_to: null, entry_dropped: false };
  }

  let dropped = false;
  try {
    await queueDropEntry(sessionId);
    dropped = true;
  } catch (err) {
    console.log('GC_LOCAL_FIRST abandon drop failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  console.log('GC_LOCAL_FIRST session abandoned', {
    sessionId,
    promoted_to_orphan: true,
    entry_dropped: dropped,
  });
  return { moved_to: movedTo, entry_dropped: dropped };
}

// ----- chunker (incremental slicer driven by setTimeout) -----

interface ChunkerState {
  sessionId: string;
  /** Filesystem URI the chunker reads on each tick. Cache during recording, doc dir after move. */
  fileUri: string;
  /**
   * Recording mode captured at start. Drives the slice size on every tick
   * (and the final pass) via `chunkSizeBase64ForMode`. Stored in-memory
   * only — the persisted queue entry is intentionally untouched so the
   * upload worker / retry / recovery flows remain identical for both
   * modes.
   */
  mode: SessionMode;
  /**
   * Wall-clock timestamp (Date.now()) of when the chunker was started.
   * Read ONLY by the video tick to gate emits during the
   * VIDEO_CHUNK_START_DELAY_MS stabilization window. Audio ignores this
   * field. In-memory only.
   */
  startedAt: number;
  active: boolean;
  tickHandle: ReturnType<typeof setTimeout> | null;
  /**
   * Promise of the currently-executing tick body, if any. Awaited by
   * stopChunkerForSession before the final pass runs so a tick that
   * fired just before STOP cannot race the final pass and emit the same
   * chunk_index from a stale queue snapshot.
   */
  inflight: Promise<void> | null;
  /**
   * True from the moment stopChunkerForSession is invoked until it
   * returns. Belt-and-suspenders alongside `active=false`: a setTimeout
   * callback that won the race against clearTimeout still early-returns
   * if it sees finalizing=true.
   */
  finalizing: boolean;
}

const chunkerStates = new Map<string, ChunkerState>();

// The active `AudioRecorder` handle is owned by `@/audio/audioEngine`
// (module-scoped there so it survives a remount of the Home component,
// which is needed for the swipe-close + activity-recreate case
// documented in docs/KNOWN_LIMITS.md). This file interacts with it
// only through `startAudioRecording` / `stopAudioRecording` /
// `cleanupDirtyAudioState` / `hasActiveAudioRecording`.

function startChunkerForSession(
  sessionId: string,
  cacheUri: string,
  mode: SessionMode,
): void {
  const state: ChunkerState = {
    sessionId,
    fileUri: cacheUri,
    mode,
    startedAt: Date.now(),
    active: true,
    tickHandle: null,
    inflight: null,
    finalizing: false,
  };
  chunkerStates.set(sessionId, state);
  scheduleNextChunkerTick(state);
}

function scheduleNextChunkerTick(state: ChunkerState): void {
  state.tickHandle = setTimeout(() => {
    // Re-check both flags: state may have flipped between the setTimeout
    // arming and now. `finalizing` is the strict gate — if STOP started
    // between schedule and fire, we must not enter emitChunk.
    if (!state.active || state.finalizing) return;
    const body = (async () => {
      try {
        await runChunkerTick(
          state.sessionId,
          state.fileUri,
          /*finalPass*/ false,
          state.mode,
        );
      } catch (err) {
        // HC1: a chunker error MUST NEVER stop the recorder. Swallow and
        // reschedule. The recorder is a separate native object — this code
        // path only consumes the file it writes.
        console.log('GC_QUEUE chunker tick error', err);
      } finally {
        // Clear the inflight handle BEFORE rescheduling so the next tick
        // starts with a clean slate. stopChunkerForSession may be awaiting
        // this promise; once it resolves, finalizing flips and the if
        // below blocks the next schedule.
        state.inflight = null;
        if (state.active && !state.finalizing) scheduleNextChunkerTick(state);
      }
    })();
    state.inflight = body;
  }, CHUNK_TICK_MS);
}

/**
 * Cancels the running chunker for a session and runs ONE final pass on
 * `finalUri` (which after STOP is the documentDirectory copy, not the
 * cache uri). Per the user's correction, we read explicitly from
 * `finalUri` because `recording.getURI()` after stopAndUnload+move does
 * not necessarily point at the live file.
 */
async function stopChunkerForSession(
  sessionId: string,
  finalUri: string,
): Promise<void> {
  const state = chunkerStates.get(sessionId);
  // Mode is captured here so the final pass slices with the same size the
  // recording was being chunked with all along. If state is missing (very
  // unlikely — caller just ran the chunker), fall back to 'audio': that is
  // the historical default and a safe choice because the only code path
  // that would reach this without a state has, by definition, never set a
  // video chunker up.
  const mode: SessionMode = state?.mode ?? 'audio';
  if (state) {
    // Order is intentional and must not be reordered:
    //   1. finalizing=true   — blocks any setTimeout body that fires next.
    //   2. active=false      — also blocks the same body via the older guard.
    //   3. clearTimeout      — cancels any pending (not-yet-fired) timer.
    //   4. await inflight    — wait for a body that already started.
    //   5. fileUri = finalUri — only safe to swap after the running tick is
    //                           done (it captured the old uri at call time).
    // After this block, no regular tick body can run concurrently with
    // the final pass below — so the queue read inside the final pass is
    // guaranteed fresh and the chunk_index it emits cannot collide.
    state.finalizing = true;
    state.active = false;
    if (state.tickHandle) clearTimeout(state.tickHandle);
    if (state.inflight) {
      try {
        await state.inflight;
      } catch {
        // Errors inside the tick are already logged by its own try/catch.
      }
    }
    state.fileUri = finalUri;
  }
  try {
    await runChunkerTick(sessionId, finalUri, /*finalPass*/ true, mode);
  } catch (err) {
    console.log('GC_QUEUE chunker final pass error', err);
  } finally {
    chunkerStates.delete(sessionId);
  }
}

/**
 * Top-level chunker tick. Routes to the audio or video implementation
 * based on the recording mode captured at start. The two paths differ in
 * how they READ the file (audio: whole file as base64; video: partial
 * byte-range reads) and what they PERSIST (audio: `base64Slice`; video:
 * `byteOffset`/`byteLength`). Everything downstream of `emitChunk` —
 * dedup, drain wakeup, hash semantics — is identical.
 */
/**
 * Background-emission observability log. Fires only when a chunk was
 * produced while the app was NOT in the 'active' AppState. Lets the
 * operator confirm Tier 2 (foreground service) is keeping the chunker
 * alive in background. Pure side-channel — adds nothing to the queue,
 * gates nothing, never throws.
 */
function logBackgroundChunkEmittedIfApplicable(
  sessionId: string,
  chunkIndex: number,
): void {
  if (AppState.currentState !== 'active') {
    console.log('GC_BACKGROUND_CHUNK_EMITTED', {
      sessionId,
      chunk_index: chunkIndex,
      app_state: AppState.currentState,
    });
  }
}

async function runChunkerTick(
  sessionId: string,
  fileUri: string,
  finalPass: boolean,
  mode: SessionMode,
): Promise<void> {
  if (mode === 'video') {
    await runVideoChunkerTick(sessionId, fileUri, finalPass);
    return;
  }
  await runAudioChunkerTick(sessionId, fileUri, finalPass);
}

/**
 * Audio chunker tick — UNCHANGED behavior from the pre-video baseline.
 * Reads the whole file as base64 (small enough — audio ADTS at 64 kbps is
 * ~8 KB/s) and slices the resulting string in 16 KB-equivalent steps. The
 * `base64Slice` is persisted into the queue at emit and pruned on 200 OK.
 * Keeping this body verbatim is a hard constraint: the audio pipeline is
 * "fully stable" per the project doc.
 */
async function runAudioChunkerTick(
  sessionId: string,
  fileUri: string,
  finalPass: boolean,
): Promise<void> {
  const base64 = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Read the entry to know how far we already emitted. The chunker's
  // local refs would be faster but persistence is the source of truth
  // (survives app kill mid-recording).
  const queue = await queueRead();
  const entry = queue.find(e => e.session_id === sessionId);
  if (!entry) return;

  let emitted = entry.emitted_base64_length;
  let nextIndex = entry.next_chunk_index;
  const chunkSizeBase64 = chunkSizeBase64ForMode('audio');

  while (base64.length - emitted >= chunkSizeBase64) {
    const slice = base64.substring(emitted, emitted + chunkSizeBase64);
    await emitChunk(sessionId, slice, nextIndex, emitted + chunkSizeBase64);
    emitted += chunkSizeBase64;
    nextIndex += 1;
  }

  if (finalPass && emitted < base64.length) {
    const tail = base64.substring(emitted);
    await emitChunk(sessionId, tail, nextIndex, base64.length);
    emitted = base64.length;
    nextIndex += 1;
  }
}

/**
 * Video chunker tick — partial-read architecture.
 *
 * Differences vs. audio:
 *   1. Never reads the whole file. `getInfoAsync` returns the current
 *      byte size of the growing recording; we partial-read just one
 *      chunk's bytes per emit. This avoids the OOM in
 *      `FileSystem.readAsStringAsync` that a multi-MB whole-file base64
 *      read produces.
 *   2. Resume offset is derived from `sum(chunks[*].byteLength)`, NOT
 *      from `entry.emitted_base64_length`. The latter is irrelevant for
 *      the video path; we leave it at its initial 0 to avoid a queue-
 *      shape change. Summing is robust against a tail chunk shortening
 *      a previous run (post-kill resume).
 *   3. Persists `byteOffset`/`byteLength` per chunk; does NOT persist
 *      `base64Slice`. The worker re-reads the bytes on demand at upload
 *      time via the same partial-read API.
 *
 * Hash is computed at emit time against the same bytes the worker will
 * read at upload time (same uri, same byteOffset, same byteLength), so
 * the wire-side hash check never sees a mismatch as long as the file is
 * untouched after the chunk is emitted (which it is — recordings only
 * grow during recording, and stay frozen post-STOP in documentDirectory).
 */
async function runVideoChunkerTick(
  sessionId: string,
  fileUri: string,
  finalPass: boolean,
): Promise<void> {
  // Stabilization gate (regular ticks only). Skip emits until the
  // encoder has had `VIDEO_CHUNK_START_DELAY_MS` to write the MP4
  // prologue and start producing stable mdat bytes. Without this gate,
  // chunk 0 occasionally hashes against bytes the recorder is still
  // patching (placeholder mdat size, codec config) — the worker re-reads
  // later, the bytes have changed, and HASH_MISMATCH fires at the proxy.
  //
  // Final pass bypasses the gate: by STOP the file is finalized in
  // documentDirectory, every byte is stable, and a recording shorter
  // than the delay window must still produce its chunks.
  if (!finalPass) {
    const state = chunkerStates.get(sessionId);
    if (state) {
      const elapsed = Date.now() - state.startedAt;
      if (elapsed < VIDEO_CHUNK_START_DELAY_MS) {
        console.log('GC_QUEUE video chunker stabilization wait', {
          sessionId,
          elapsed_ms: elapsed,
          required_ms: VIDEO_CHUNK_START_DELAY_MS,
        });
        return;
      }
    }
  }

  const info = await FileSystem.getInfoAsync(fileUri);
  if (!info.exists) return;
  const fileBytes = info.size ?? 0;

  const queue = await queueRead();
  const entry = queue.find(e => e.session_id === sessionId);
  if (!entry) return;

  // Derive resume offset from already-emitted chunks. See the function
  // header for why we do not use `entry.emitted_base64_length` here.
  let emittedBytes = 0;
  for (const c of entry.chunks) {
    if (typeof c.byteLength === 'number') emittedBytes += c.byteLength;
  }
  let nextIndex = entry.next_chunk_index;

  while (fileBytes - emittedBytes >= CHUNK_SIZE_VIDEO) {
    await emitVideoChunk(
      sessionId,
      fileUri,
      emittedBytes,
      CHUNK_SIZE_VIDEO,
      nextIndex,
    );
    emittedBytes += CHUNK_SIZE_VIDEO;
    nextIndex += 1;
  }

  if (finalPass && emittedBytes < fileBytes) {
    const tailLength = fileBytes - emittedBytes;
    await emitVideoChunk(
      sessionId,
      fileUri,
      emittedBytes,
      tailLength,
      nextIndex,
    );
    emittedBytes += tailLength;
    nextIndex += 1;
  }
}

// Exported for tests only — G3' pins that this writer, and only this
// writer, stamps `media: 'audio'`. Follows the same convention as
// `queueMutate` / `pickNext` / `tryFinalizeReadySessions`.
export async function emitChunk(
  sessionId: string,
  base64Slice: string,
  chunk_index: number,
  emittedAfter: number,
): Promise<void> {
  const bytes = sliceToBytes(base64Slice);
  const hash = bytesDigestToHex(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  );
  // -----------------------------------------------------------------
  // Disk-backed payload (post-2026-05-15 hotfix).
  //
  // Previously this function persisted `base64Slice` inline in the
  // queue JSON. On a long audio session (~200 chunks at ~22 KB base64
  // each) the accumulated payload pushed the GC_QUEUE row past the
  // Android SQLite CursorWindow ~2 MB per-row limit. Once that
  // happened, every `queueRead`/`queueMutate` started taking >80 s to
  // return (verified via GC_PERF_DRAIN_PICK at chunk_index 105/199),
  // which manifested as "the upload worker froze" — but the worker
  // itself was healthy, AsyncStorage was the bottleneck.
  //
  // The fix mirrors the video post-stop path:
  //   1. Write base64 to a per-chunk file under
  //      `documentDirectory/chunks/{sessionId}/{chunk_index}.b64`.
  //   2. Persist ONLY `local_uri` (plus chunk_index/hash/size/status/
  //      attempts) in the queue row. The queue stays tiny regardless
  //      of session length.
  //   3. `rehydrateChunkSlice` already reads from `local_uri` for the
  //      video post-stop path — audio inherits that behaviour for
  //      free with no worker change.
  //   4. Post-200-OK already deletes the `local_uri` file. Reap
  //      already deletes the whole `chunks/{sessionId}/` directory.
  //      Both apply to audio now with zero new code.
  //
  // Legacy queue entries persisted BEFORE this hotfix still carry
  // `base64Slice`; rehydrateChunkSlice short-circuits on that field
  // before reading from disk, so old entries continue to upload
  // exactly as before — no migration needed.
  //
  // Write order is intentional: disk first, queue row second. A throw
  // from `writeAsStringAsync` propagates out of this function without
  // creating a metadata row that points at a file that does not
  // exist. The chunker's tick body catches the throw and the same
  // chunk_index will be re-emitted on the next tick (idempotent
  // dedup in queueAppendChunk handles the re-emit race).
  // -----------------------------------------------------------------
  const local_uri = videoChunkLocalUri(sessionId, chunk_index);
  const sessionDir = `${FileSystem.documentDirectory}chunks/${sessionId}/`;
  try {
    await FileSystem.makeDirectoryAsync(sessionDir, { intermediates: true });
  } catch {
    // Directory may already exist — best-effort create. Subsequent
    // writeAsStringAsync will throw if the directory genuinely is not
    // writable, and that throw surfaces to the chunker.
  }
  await FileSystem.writeAsStringAsync(local_uri, base64Slice, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const chunk: QueueChunk = {
    chunk_index,
    hash,
    size: bytes.length,
    status: 'pending',
    attempts: 0,
    local_uri,
    // G3' — `emitChunk` is called only from `runAudioChunkerTick`; the
    // video tick delegates to `videoChunkSink` and never reaches here.
    // The medium is therefore known statically. Literal, not derived.
    media: 'audio',
  };
  await queueAppendChunk(sessionId, chunk, emittedAfter, chunk_index + 1);
  if (DEBUG_QUEUE) {
    console.log('GC_DEBUG queueAppendChunk saved', {
      sessionId,
      chunk_index,
      status: chunk.status,
    });
  }
  console.log('GC_QUEUE chunk emitted', {
    sessionId,
    chunk_index,
    size: bytes.length,
    hash_short: hash.substring(0, 12),
    local_uri,
  });
  if (chunk_index === 0) {
    perfLog('GC_PERF_FIRST_CHUNK_EMITTED', {
      session_id: sessionId,
      mode: 'audio',
      size: bytes.length,
    });
  }
  logBackgroundChunkEmittedIfApplicable(sessionId, chunk_index);
  // Wake the worker (single-flight; no-op if already draining).
  // The .catch keeps unhandled rejections from being silently swallowed
  // — that pattern was exactly the failure mode we just debugged. Log is
  // gated by DEBUG_QUEUE; the catch itself runs unconditionally.
  uploadDrainLoop().catch(err => {
    if (DEBUG_QUEUE) {
      console.log('GC_DEBUG drain rejected (from emit)', {
        sessionId,
        chunk_index,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Video-mode chunk emit. Reads JUST the chunk's bytes from the recording
 * file via a base64 partial read, hashes them, and persists ONLY the
 * metadata (no `base64Slice`). The worker re-reads the same byte range
 * at upload time via the symmetrical partial read in
 * `rehydrateChunkSlice`.
 *
 * Why this shape:
 *   - `base64Slice` for video would put hundreds of KB per chunk into
 *     AsyncStorage, blowing CursorWindow at queue read time.
 *   - The hash MUST be computed against the same bytes the upload sends.
 *     We hash the partial-read result here; the worker re-reads the same
 *     `(uri, byteOffset, byteLength)` later. The recording file is
 *     append-only during recording and immutable after STOP, so the two
 *     reads produce identical bytes by construction.
 */
async function emitVideoChunk(
  sessionId: string,
  fileUri: string,
  byteOffset: number,
  byteLength: number,
  chunk_index: number,
): Promise<void> {
  const base64Slice = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
    position: byteOffset,
    length: byteLength,
  });
  const bytes = sliceToBytes(base64Slice);
  const hash = bytesDigestToHex(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  );
  const chunk: QueueChunk = {
    chunk_index,
    hash,
    size: bytes.length,
    status: 'pending',
    attempts: 0,
    byteOffset,
    byteLength,
  };
  // Pass `null` for emittedBase64Length: the video path tracks bookkeeping
  // via `sum(chunks[*].byteLength)` instead, so the audio-only field
  // stays untouched on this entry.
  await queueAppendChunk(sessionId, chunk, /*emittedBase64Length*/ null, chunk_index + 1);
  if (DEBUG_QUEUE) {
    console.log('GC_DEBUG queueAppendChunk saved (video)', {
      sessionId,
      chunk_index,
      status: chunk.status,
      byteOffset,
      byteLength,
    });
  }
  console.log('GC_QUEUE chunk emitted (video)', {
    sessionId,
    chunk_index,
    size: bytes.length,
    byteOffset,
    byteLength,
    hash_short: hash.substring(0, 12),
  });
  if (chunk_index === 0) {
    perfLog('GC_PERF_FIRST_CHUNK_EMITTED', {
      session_id: sessionId,
      mode: 'video_realtime',
      size: bytes.length,
    });
  }
  logBackgroundChunkEmittedIfApplicable(sessionId, chunk_index);
  uploadDrainLoop().catch(err => {
    if (DEBUG_QUEUE) {
      console.log('GC_DEBUG drain rejected (from emitVideoChunk)', {
        sessionId,
        chunk_index,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Build the per-chunk file path under `documentDirectory/chunks/...`.
 *
 * Used by BOTH paths that persist chunk payloads to disk instead of
 * inside the AsyncStorage JSON blob:
 *
 *   - Video post-stop (`videoChunkSink`) — the original caller.
 *   - Audio live-emit (`emitChunk`) — added after the 2026-05-15
 *     incident where a ~200-chunk audio session pushed the inline
 *     `base64Slice` accumulation past the SQLite CursorWindow ~2 MB
 *     per-row limit and froze `queueRead` at 84 s per call, stalling
 *     the upload worker at chunk_index 105/199. Audio now mirrors the
 *     video shape: write each chunk's base64 to its own file, persist
 *     only `local_uri` in the queue row.
 *
 * `rehydrateChunkSlice` already reads from `local_uri` (it was wired
 * for the video post-stop path) so the upload worker needs no change
 * to consume audio chunks emitted this way. `reapEntry` already
 * deletes the whole `chunks/{sessionId}/` directory at session close,
 * and the post-200-OK path already deletes each `local_uri` file as
 * soon as the chunk is acknowledged — both behaviours apply to audio
 * chunks now too, again with no code change.
 *
 * The function name retains the historical `video` prefix to keep the
 * diff for this hotfix surgical; it is otherwise mode-agnostic.
 */
function videoChunkLocalUri(sessionId: string, chunk_index: number): string {
  const docDir = FileSystem.documentDirectory;
  if (!docDir) {
    throw new Error('videoChunkLocalUri: documentDirectory unavailable');
  }
  return `${docDir}chunks/${sessionId}/${chunk_index}.b64`;
}

/**
 * Sink wired into `RecordingController` for the video post-stop path.
 * Receives a `ChunkPayload` from `VideoFileChunkProducer.chunkFile`,
 * writes the base64 to a per-chunk file on disk, and persists ONLY
 * metadata (`local_uri`) into the queue. The upload worker will read
 * the file at upload time via `rehydrateChunkSlice`, and the
 * post-200-OK path deletes the file.
 *
 * `emittedBase64Length` is passed as `null`: the video path tracks
 * progress by `chunks[*]` count, not by the audio-only resume cursor.
 */
// Exported for tests only — G3' pins that this writer stamps
// `media: 'video'` while producing NON-segment paths, which is exactly
// why D3 cannot trust the medium alone.
export async function videoChunkSink(payload: ChunkPayload): Promise<void> {
  const bytes = sliceToBytes(payload.base64Slice);
  const hash = bytesDigestToHex(
    await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  );
  // Write base64 to disk BEFORE adding the queue entry. If the write
  // fails, we never insert a metadata row that points at a file that
  // does not exist. Encoding=Base64 round-trip lets the file hold the
  // raw bytes (33% smaller than utf8-encoded base64 text); on read we
  // ask for Base64 back out and get the exact same string.
  const local_uri = videoChunkLocalUri(payload.sessionId, payload.chunk_index);
  const sessionDir = `${FileSystem.documentDirectory}chunks/${payload.sessionId}/`;
  try {
    await FileSystem.makeDirectoryAsync(sessionDir, { intermediates: true });
  } catch {
    // Directory may already exist — best-effort create.
  }
  await FileSystem.writeAsStringAsync(local_uri, payload.base64Slice, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const chunk: QueueChunk = {
    chunk_index: payload.chunk_index,
    hash,
    size: bytes.length,
    status: 'pending',
    attempts: 0,
    local_uri,
    // G3' — this sink is wired only to `VideoFileChunkProducer` (legacy
    // post-stop video), so the medium is known statically. NOTE: these
    // are base64 slices under `chunks/<sid>/`, NOT native MP4 segments —
    // `media: 'video'` alone must never let them into D3.
    media: 'video',
  };
  await queueAppendChunk(
    payload.sessionId,
    chunk,
    /*emittedBase64Length*/ null,
    payload.chunk_index + 1,
  );
  console.log('GC_QUEUE chunk emitted (video post-stop)', {
    sessionId: payload.sessionId,
    chunk_index: payload.chunk_index,
    size: bytes.length,
    hash_short: hash.substring(0, 12),
    local_uri,
    isFinal: payload.isFinal === true,
  });
  if (payload.chunk_index === 0) {
    perfLog('GC_PERF_FIRST_CHUNK_EMITTED', {
      session_id: payload.sessionId,
      mode: 'video_post_stop',
      size: bytes.length,
    });
  }
  logBackgroundChunkEmittedIfApplicable(payload.sessionId, payload.chunk_index);
  uploadDrainLoop().catch(err => {
    if (DEBUG_QUEUE) {
      console.log('GC_DEBUG drain rejected (from videoChunkSink)', {
        sessionId: payload.sessionId,
        chunk_index: payload.chunk_index,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Capture parameters for the native segmented producer.
 *
 * The 6 s cadence is what the S2b cost model supports: at ~70 KB/s a segment is
 * ~0.41 MiB, so `t_request = 2.64 s + 0.41/0.35 ≈ 3.8 s` per 6 s produced — a
 * ~64 % duty cycle, which is why the backlog stayed flat in that run. The 2 s
 * cadence of D_15S_2S produced faster than the uploader could drain.
 *
 * `sessionMs` is the module's ceiling (`HarnessBounds.MAX_SESSION_MS`) and
 * matches `VIDEO_MAX_DURATION_S` exactly, so the native path inherits the same
 * one-hour cap the expo-camera path already had rather than introducing a new
 * one.
 *
 * DEBT: these travel through `GateHarnessOptions`, which the module documents as
 * diagnostic-only. Without them a session would stop itself after 7 s with a
 * single rotation. Promoting this to a real capture config is pending and blocks
 * the merge to main, not this branch's validation.
 */
const NATIVE_SEGMENT_OPTIONS: GateHarnessOptions = {
  rotateAtMs: 3_000,
  rotationIntervalMs: 6_000,
  sessionMs: 3_600_000,
};

/**
 * The ONLY queue write the native segmented path performs.
 *
 * Deliberately does not wake the worker: every drain kick raised by this wiring
 * is gated on `remoteSessionReady` inside `nativeSegmentedSession`, so keeping
 * the kick out of the sink leaves one place that decides when the worker runs.
 */
const nativeSegmentProductionSink: QueueSink = {
  appendChunk: async (sessionId, chunk, emittedBase64Length, nextChunkIndex) => {
    await queueAppendChunk(sessionId, chunk, emittedBase64Length, nextChunkIndex);
  },
};

/**
 * Sink for segments that arrive AFTER `onCaptureReleased` — a native contract
 * violation. The adopter still copies and verifies the bytes into
 * `segments/<sid>/`; this sink is where its step 7 lands, and it writes nothing.
 *
 * The log deliberately carries no path and no hash, not even a truncated one: a
 * stable path contains the session id and a hash prefix is still an identifier.
 * `queue_write: false` is the point of the record.
 */
const nativeSegmentPreservationSink: QueueSink = {
  appendChunk: async (sessionId, chunk: AdoptableChunk) => {
    console.log('GC_SEGMENT_PRESERVED_ONLY', {
      sid_prefix: sessionId.slice(0, 8),
      idx: chunk.chunk_index,
      size: chunk.size,
      queue_write: false,
    });
  },
};

async function deriveChunksFromFile(uri: string): Promise<RealChunk[]> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Legacy/audio-mode rehydration path: this helper currently has no
  // live caller and is kept as backup for audio-era flows. Video uses
  // the active chunker (`runChunkerTick`) which picks size by mode.
  const chunks: RealChunk[] = [];
  for (
    let index = 0, offset = 0;
    offset < base64.length;
    index++, offset += CHUNK_SIZE_BASE64_AUDIO
  ) {
    const slice = base64.substring(offset, offset + CHUNK_SIZE_BASE64_AUDIO);

    // SINGLE SOURCE OF HASH TRUTH (see module header on hashes):
    // hash the DECODED bytes, not the base64 text. This is the same
    // value the backend will recompute over the request body when the
    // bytes reach /destinations/drive/chunks, and the same value that
    // is embedded in the Drive filename for idempotent dedup.
    const bytes = sliceToBytes(slice);
    const hash = bytesDigestToHex(
      await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
    );

    // `size` is the exact length of the decoded payload. Used only for
    // UI/logging totals; computing it from `bytes.length` is precise
    // regardless of padding in the terminal slice.
    const size = bytes.length;

    chunks.push({ chunk_index: index, hash, size });
  }

  return chunks;
}

/**
 * Read the full recording as a single base64 string.
 *
 * Kept SEPARATE from `deriveChunksFromFile` by design: the derive path
 * is the hot, validated Phase 1 logic and its contract — one file in,
 * RealChunk[] out — must not grow side exits. This helper exists so the
 * bytes-to-Drive path can re-read the file independently (Phase 1 hot
 * path + Phase 2 recovery after relaunch) without contaminating the
 * derive flow.
 *
 * Intentionally a thin wrapper over `FileSystem.readAsStringAsync` —
 * base64 is what the rest of the pipeline (slicing + hashing) expects.
 */
async function readRecordingBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/**
 * Return the base64 substring for `chunk_index` using the SAME slicing
 * rule `deriveChunksFromFile` applies. Both sides MUST agree byte-for-
 * byte: the sha256 the backend recomputes over the decoded bytes is
 * compared to the `hash` we derived from this exact substring. Any
 * divergence produces HASH_MISMATCH at the proxy.
 *
 * Pure (no I/O) — the caller reads base64 once via
 * `readRecordingBase64` and slices per chunk from memory.
 */
function base64SliceAt(
  base64: string,
  chunk: QueueChunk,
  entry: PendingQueueEntry,
): string {
  // Rehydration only triggers for legacy entries that lack a persisted
  // base64Slice and a local_uri. Pre-Phase-2 entries were all audio
  // (video did not exist at the time), and any post-Phase-2 entry —
  // audio or video — keeps its bytes off-queue (local_uri or
  // byteOffset/byteLength) until upload succeeds. So this path only
  // fires for pre-hotfix audio entries persisted under an older value
  // of CHUNK_SIZE_AUDIO.
  //
  // Stride is derived from `chunk.size` of a non-tail chunk inside the
  // same entry, NOT from the current global constant. Reason: bumping
  // CHUNK_SIZE_AUDIO would otherwise re-slice legacy entries with the
  // new stride against bytes hashed under the old stride →
  // HASH_MISMATCH. Reading the original stride back from a sibling
  // chunk's `size` preserves byte-for-byte correctness across constant
  // bumps. The current chunk is itself a valid reference when it isn't
  // the tail; the find() falls back to scanning when it is.
  const lastIndex = Math.max(...entry.chunks.map(c => c.chunk_index));
  const reference = chunk.chunk_index < lastIndex
    ? chunk
    : entry.chunks.find(c => c.chunk_index < lastIndex);
  const referenceSize = reference?.size ?? chunk.size;
  const strideBase64 = Math.ceil(Math.ceil((referenceSize * 4) / 3) / 4) * 4;
  const offset = chunk.chunk_index * strideBase64;
  return base64.substring(offset, offset + strideBase64);
}

/**
 * Delete a moved recording file from documentDirectory after it has
 * served its purpose (session completed successfully).
 *
 * Safety gates:
 *   - No-op when `uri` is empty/null (nothing to clean).
 *   - No-op when `uri` does NOT live under `documentDirectory`. Some
 *     callers (pre-Phase-4 pending state, or the fallback when the
 *     move failed in stopRecording) hold a cacheDirectory uri. The OS
 *     manages cacheDir on its own — we must not delete those.
 *   - Uses `idempotent: true` so a missing file is not an error.
 *   - Wrapped in try/catch: cleanup failure is logged but NEVER
 *     surfaces to the user or rolls back PENDING_RETRY_KEY clearing —
 *     the session is already completed, the evidence is already in
 *     Drive, and one stranded file is a disk-space nuisance at worst.
 */
async function deleteRecordingBestEffort(
  uri: string | undefined | null,
): Promise<void> {
  if (!uri) return;
  const docDir = FileSystem.documentDirectory;
  if (!docDir || !uri.startsWith(docDir)) {
    console.log(
      'RECORDING CLEANUP SKIPPED: uri not in documentDirectory',
      { uri },
    );
    return;
  }
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    console.log('RECORDING CLEANED:', uri);
    console.log('GC_VALIDATION: RECORDING_CLEANED', { uri });
  } catch (error) {
    console.log('RECORDING CLEANUP WARN:', error);
  }
}

/**
 * Inner timeout for POST /chunks. Mirrors the 30s ceiling that
 * `uploadChunkBytes` already applies to the `/destinations/<dest>/chunks`
 * proxy upload, so a hung metadata write does not eat the full outer 60s
 * `CHUNK_UPLOAD_TIMEOUT_MS` budget before the worker gives up.
 *
 * AbortError surfaces as a non-`ApiError` throw whose message lacks any
 * `HTTP NNN` token — `classifyError` falls through to its `'transient'`
 * default, so the existing retry/backoff machinery handles it identically
 * to a network failure.
 */
const POST_CHUNKS_TIMEOUT_MS = 30_000;

async function postChunk(
  token: OwnershipToken,
  sessionId: string,
  chunk: RealChunk,
  status: 'pending' | 'uploaded' | 'failed',
  remoteReference?: string | null,
): Promise<unknown> {
  // R6 — last moment before a mutation can leave the device. The brand
  // stops a plain string at compile time; this stops a forced cast at run
  // time. One boolean, no I/O.
  assertOwnershipGateOpen('/chunks');
  // Only include `remote_reference` in the body when the caller has
  // actually obtained one (i.e. the Drive proxy returned a file_id).
  // Omitting the field keeps the POST shape identical to the pre-Drive
  // behaviour so the zod schema on the backend treats it as absent
  // rather than explicitly null. `null` is still accepted — used on
  // purpose by the DRIVE_CHUNK_UPLOAD_ENABLED=false rollback path.
  const body: Record<string, unknown> = { session_id: sessionId, ...chunk, status };
  if (remoteReference !== undefined) {
    body.remote_reference = remoteReference;
  }
  const url = `${env.apiUrl}/chunks`;
  if (!token) console.log('AUTH MISSING', { path: '/chunks' });
  console.log('API CALL', { method: 'POST', url, authed: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_CHUNKS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const contentType = res.headers.get('content-type') ?? '<none>';
  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(
      `POST /chunks HTTP ${res.status} content-type=${contentType} body=${rawText.substring(0, 200)}`,
    );
  }
  try {
    return JSON.parse(rawText);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `POST /chunks non-JSON 2xx content-type=${contentType} body=${rawText.substring(0, 200)} parse=${msg}`,
    );
  }
}

async function getChunks(token: string, sessionId: string): Promise<unknown> {
  const url = `${env.apiUrl}/sessions/${sessionId}/chunks`;
  if (!token) console.log('AUTH MISSING', { path: `/sessions/${sessionId}/chunks` });
  console.log('API CALL', { method: 'GET', url, authed: true });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

/**
 * The backend sets `idempotent_replay: true` on POST /chunks when the
 * incoming (session_id, chunk_index) row already exists with the same
 * hash and status — i.e. the POST is a duplicate that collapsed onto
 * the existing row at the DB level (UNIQUE(session_id, chunk_index)).
 * The client treats a duplicate as success, NOT as an error: the chunk
 * is known-safe server-side, so we just surface visibility and move on.
 */
function isIdempotentReplay(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { idempotent_replay?: unknown }).idempotent_replay === true
  );
}

/**
 * POST /sessions/:id/complete — transitions a session from `active` to
 * `completed` once every chunk has been uploaded. Called from two places:
 *   • Phase 1, single-chunk recording (chunks[0] uploaded, no recovery)
 *   • Phase 2, after all remaining chunks are uploaded on relaunch
 * Never called while chunks are still pending. Caller wraps this in
 * try/catch so a failed completion surfaces as SESSION COMPLETE ERROR
 * without losing the evidence (the chunks themselves are already safe).
 */
async function completeSession(
  token: OwnershipToken,
  sessionId: string,
): Promise<unknown> {
  // R6 — see `postChunk`. Same authority, same last moment.
  assertOwnershipGateOpen(`/sessions/${sessionId}/complete`);
  const url = `${env.apiUrl}/sessions/${sessionId}/complete`;
  if (!token) console.log('AUTH MISSING', { path: `/sessions/${sessionId}/complete` });
  console.log('API CALL', { method: 'POST', url, authed: true });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * POST /sessions — create a new active session and return its id.
 *
 * Called at GRABAR time (not at PARAR like the legacy flow) so the
 * concurrent chunker can start emitting chunks against a known
 * session_id from the very first tick.
 *
 * If the recorder fails to start AFTER this returns, the session row
 * is orphaned in `active`; the worker's completeSession path will
 * eventually reap it (chunks list is empty → all-settled → complete).
 */
async function createSessionRequest(
  token: OwnershipToken,
  mode: SessionMode = 'audio',
  /**
   * Optional client-provided session id. The backend treats POST
   * /sessions idempotently when this is present: same (id, user_id) →
   * existing row returned, new id → row inserted with that id. Used by
   * the offline-first path so a recording started with no network can
   * be re-registered later under the same UUID it was emitted with.
   */
  clientId?: string,
  /**
   * Per-session upload destination, captured ONCE at GRABAR time from
   * the module-level `activeDestinationType` resolver and passed in by
   * the caller. The backend persists this value on the `sessions` row
   * so downstream consumers (export gate, audit, future per-destination
   * metrics) read the truth rather than a hardcoded 'drive'.
   *
   * Default 'drive' covers two cases:
   *   1. Pre-pinning legacy entries replaying through the offline
   *      retry loop (their persisted `PendingSessionRegistration`
   *      shape may not carry destination_type yet).
   *   2. Any future call site that has no destination context.
   *
   * The default is intentionally NOT taken from `activeDestinationType`
   * here — that read must happen at the GRABAR call site so the value
   * is stable across the createSession + queueAppendNewSession pair.
   * Reading it here would risk a Settings-toggle race between the two
   * calls and re-introduce the trace divergence this fix removes.
   */
  destinationType: DestinationType = 'drive',
): Promise<string> {
  // R6 — see `postChunk`. A `sessions` row keyed by (id, user_id) is the
  // first ownership a capture creates, so this is the most important of
  // the three raw guards.
  assertOwnershipGateOpen('/sessions');
  const sessionBody = JSON.stringify({
    user_id: 'test_user',
    mode,
    destination_type: destinationType,
    ...(clientId ? { id: clientId } : {}),
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const url = `${env.apiUrl}/sessions`;
  if (!token) console.log('AUTH MISSING', { path: '/sessions' });
  console.log('API CALL', { method: 'POST', url, authed: true });
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: sessionBody,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`POST /sessions HTTP ${res.status} ${text}`);
  }
  let data: { session_id?: string };
  try {
    data = (await res.json()) as { session_id?: string };
  } catch (err) {
    throw new Error(
      `POST /sessions bad JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!data.session_id) throw new Error('POST /sessions returned no session_id');
  return data.session_id;
}

export default function Index() {
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  // POST_NOTIFICATIONS denial flag, written by `startBackgroundProtection`
  // through the `onPostNotificationsResult` callback. Detection and the
  // diagnostic breadcrumbs below still depend on it; the home screen no
  // longer subscribes to read it, because the ReliabilityCard is now the
  // single notifications surface there (the old duplicate pill is gone).
  const setNotificationDenied = usePermissionsStore(
    (s) => s.setNotificationDenied,
  );
  // The audio `AudioRecorder` handle lives inside `@/audio/audioEngine`
  // (module scope there) so a remount of `Index` — which happens when
  // Android re-creates the activity after a swipe-close while the
  // engine's foreground service keeps the JS process alive — can still
  // reach the native recorder and stop it during boot dirty-state
  // cleanup. Video refs below stay component-local — they are
  // unaffected by that lifecycle issue and out of scope.
  // Video-mode counterparts of the audio recorder handle. The CameraView is mounted
  // only during a video session (see render); cameraRef is wired through
  // its ref callback. videoRecordPromiseRef holds the recordAsync()
  // promise — it resolves only when stopRecording() is called and gives
  // the authoritative final URI. videoRecordingUriRef remembers the URI
  // we discovered via cacheDirectory listing at start, used at stop to
  // verify it matches the camera's authoritative URI.
  const cameraRef = useRef<CameraView | null>(null);
  const videoRecordPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const videoRecordingUriRef = useRef<string | null>(null);
  /**
   * "Post-stop chunking is in flight" flag.
   *
   * Closes the foreground-service race that hit video sessions:
   *   - camera stops → `videoRecordPromiseRef.current = null`
   *   - file move runs (can take seconds)
   *   - `chunkVideoFile` runs (can take more seconds, emits all chunks)
   *   - only after that do chunks reach the queue
   *
   * If the service tick fires anywhere in that window, both predicates
   * read false (recorder ref nulled, queue still empty) and the tick
   * stops the service with `no_pending_work` — exactly when the user
   * needs it alive most. This ref is set true at the start of the
   * post-stop processing block and cleared in the finally; it is read
   * by the `isRecordingActive` callback so the service treats the
   * post-stop window as "still recording" for lifecycle purposes.
   *
   * UI-screen-local ref: never persisted, never sent to backend, never
   * mutates queue/worker. Pure observability of an in-flight async.
   */
  const postStopChunkingInFlightRef = useRef(false);
  // Camera permission hook. Permission is requested at GRABAR-time when
  // mode === 'video', not on screen mount, so audio sessions never
  // surface a camera prompt.
  const [, requestCameraPermission] = useCameraPermissions();
  /**
   * Session id of the currently-active recording. Set when GRABAR fires
   * `createSessionRequest`, cleared when stopRecording finishes (or on
   * an early start failure). Read by stopRecording to drive the final
   * chunker pass + queue close. Module-scope `chunkerStates` keys off
   * the same id, so this is the single client-side identity for the
   * recording in flight.
   */
  const sessionIdRef = useRef<string | null>(null);
  /**
   * Mode of the currently-active recording. Mirrors `recordingMode`
   * captured at GRABAR but lives across the start/stop boundary so
   * `stopRecording` knows which producer path to take WITHOUT depending
   * on the in-memory chunkerStates Map (which is empty for video under
   * the post-stop producer flow).
   */
  const recordingModeRef = useRef<SessionMode | null>(null);
  /**
   * Lazy-initialized RecordingController. The controller dispatches
   * chunk-producer choice on mode and exposes start/stop + the video
   * post-stop entry point. The audio path is a no-op shim through the
   * controller so the legacy real-time chunker (`startChunkerForSession`
   * / `stopChunkerForSession`) keeps driving audio unchanged.
   */
  const controllerRef = useRef<RecordingController | null>(null);
  function getController(): RecordingController {
    if (!controllerRef.current) {
      const c = new RecordingController();
      c.setChunkSink(videoChunkSink);
      controllerRef.current = c;
    }
    return controllerRef.current;
  }
  /**
   * Producer that actually started THIS recording, captured at GRABAR time.
   *
   * The stop path dispatches on this rather than on `NATIVE_SEGMENTED_VIDEO`,
   * so a flag that changed across a hot reload cannot strand a live capture
   * with the wrong teardown.
   */
  const videoProducerRef = useRef<VideoProducer | null>(null);
  /**
   * The single native-session instance for this screen. Held in a ref rather
   * than in module scope so consecutive sessions, hot reload and tests never
   * share hidden state, and so `dispose()` on unmount is unambiguous.
   */
  const nativeSessionRef = useRef<NativeSegmentedSession | null>(null);
  function getNativeSession(): NativeSegmentedSession {
    if (!nativeSessionRef.current) {
      nativeSessionRef.current = createNativeSegmentedSession({
        recorder: GCSegmentedRecorder,
        adopt: adoptSegment,
        productionSink: nativeSegmentProductionSink,
        preservationSink: nativeSegmentPreservationSink,
        queue: {
          read: queueRead,
          markRecordingClosed: queueMarkRecordingClosed,
          dropEntry: queueDropEntry,
          drain: () => {
            uploadDrainLoop().catch(err => {
              if (DEBUG_QUEUE) {
                console.log('GC_DEBUG drain rejected (from native segments)', {
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            });
          },
        },
        clock: {
          now: () => Date.now(),
          schedule: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            return () => clearTimeout(handle);
          },
        },
        logger: {
          log: (event, fields) => {
            console.log(event, fields);
          },
        },
      });
    }
    return nativeSessionRef.current;
  }
  /**
   * "A video producer is live." Single definition, substituted at every site
   * that used to test `videoRecordPromiseRef.current !== null` — that ref is
   * only ever set by the expo-camera path, so without this a native session
   * would be invisible to PARAR, to the foreground-service predicate and to the
   * background shutdown.
   */
  function videoProducerLive(): boolean {
    return (
      videoRecordPromiseRef.current !== null ||
      nativeSessionRef.current?.isActive() === true
    );
  }
  // Safety net: a screen unmount must not leave native listeners subscribed.
  // Writes nothing — an in-flight close is owned by stopRecording, not by this.
  useEffect(() => {
    return () => {
      nativeSessionRef.current?.dispose();
    };
  }, []);
  // Synchronous re-entrancy lock for startRecording. Closes the gap
  // between the user tap and setIsRecording(true) during which GRABAR is
  // still visible and re-tappable. Refs are read/written atomically on
  // the JS thread, so this is race-free without needing a state update.
  const isStartingRef = useRef(false);
  // UI-only mirrors of the in-flight lifecycle. The authoritative race
  // guard for start is still isStartingRef above; these states exist so
  // the buttons can render as disabled and the phase label can read
  // "Procesando" instead of "Listo" while work is happening. They do
  // NOT gate the real logic — they only feed the JSX.
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);

  // Recording mode selected via the Audio/Video toggle on the home screen.
  // Step 2 wires only the state + UI; the recording branches still always
  // produce audio. The toggle is locked while a session is in flight so
  // mode cannot flip mid-recording.
  const [mode, setMode] = useState<SessionMode>('audio');

  /**
   * Deep-link / launcher-shortcut params.
   *
   * The Android app shortcut (long-press launcher → "Grabar evidencia")
   * fires `guardiancloud:///?panic=1` which lands here as
   * `params.panic === '1'`. We use it ONLY to render a small "Listo
   * para grabar" line — the user must still tap the GRABAR AHORA
   * button. Critically, this hook is read-only: nothing in this file
   * calls `startRecording` based on the param. Play Store policy +
   * project rule: no auto-record, no hidden capture.
   *
   * `useLocalSearchParams` re-runs when the URL changes, so a warm
   * launch via the shortcut also flips this on without remounting.
   */
  const params = useLocalSearchParams<{ panic?: string }>();
  const panicLaunch = params.panic === '1';

  /**
   * Destination gate state.
   *
   * `null`          → still checking (or check failed transiently)
   * `PublicDest.`   → connected Drive, ready to record
   * `undefined`     → confirmed NO destination → GRABAR is disabled
   *
   * Note: recovery (Phase 2) does NOT wait for this check. If the app
   * relaunches with pending uploads, we MUST still flush them even when
   * we haven't confirmed the destination state yet. Recovery only POSTs
   * chunk metadata to our backend — it never talks to Drive. The gate
   * only blocks NEW recordings (GRABAR button).
   */
  const [drive, setDrive] = useState<PublicDestination | null | undefined>(null);
  /**
   * Mirror of the module-level `activeDestinationType` so the home can
   * render a passive "Protegiendo en: <destino>" label without taking
   * any decision before recording. Updated only inside
   * `refreshDestination`. The worker keeps reading the module-level
   * variable — this state is purely cosmetic.
   */
  const [activeDest, setActiveDest] = useState<DestinationType>('drive');
  /**
   * True iff the user currently has a connected NAS destination. Used
   * solely to gate the "Protegiendo en …" label so it stays empty when
   * nothing is connected at all (avoids saying "Drive" while the user
   * is actually unconfigured). Mirrors `refreshDestination`'s `nas` —
   * no extra network call.
   */
  const [hasNas, setHasNas] = useState<boolean>(false);

  /**
   * X / N progress counters, maintained by the 500ms GC_QUEUE poll.
   * Purely additive UI — never gates logic. We never show 0 / 0; the
   * UI only renders a denominator when total > 0 AND the capture is
   * closed.
   *
   * Chunks of the current session PROVEN to exist off the device —
   * `isChunkConfirmedOffDevice`, i.e. `uploaded` AND carrying a real
   * `remote_reference`. Named for the proof rather than the queue
   * status on purpose: this is the only counter allowed to feed a
   * visible protection claim, and a bare `status === 'uploaded'` tally
   * is not proof — the `DRIVE_CHUNK_UPLOAD_ENABLED=false` rollback
   * records `remote_reference: null`, and legacy entries predate the
   * field.
   *
   * `totalCount` below stays the FULL chunk count of the entry, so an
   * uploaded-but-unreferenced chunk shows up as a gap in the
   * denominator instead of vanishing.
   */
  const [confirmedOffDeviceCount, setConfirmedOffDeviceCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  /**
   * `recording_closed` of the current GC_QUEUE entry, mirrored into
   * render state by the same 500ms poll that maintains the counters
   * above. GC_QUEUE stays the single source of truth — this is one
   * extra field read from the entry the tick already has in hand, not
   * a second store.
   *
   * Needed because `totalCount` is only a trustworthy denominator once
   * no further chunk can join the session. Video emits every chunk
   * AFTER the recorder stops (`chunkVideoFile` runs post-`stop()`), so
   * the phase is already `subiendo` while the total is still climbing
   * from 0 — the phase alone cannot gate the denominator.
   */
  const [recordingClosed, setRecordingClosed] = useState(false);
  /**
   * Chunks still in motion: status='pending' (waiting for the worker)
   * or status='uploading' (in flight). Drives the "Subiendo evidencia"
   * gate so a session that is fully settled — every chunk is `uploaded`
   * or terminally `failed` — does NOT keep the banner up while
   * `tryFinalizeReadySessions` works through `completeSession`.
   */
  const [activeCount, setActiveCount] = useState(0);
  /**
   * Chunks at terminal `failed` status. Same data source and lifecycle
   * as `activeCount` / `confirmedOffDeviceCount` — the polling tick
   * already walks the queue, this is one extra branch in the existing
   * for-loop. Used
   * by `deriveGuardianStatus` to flip the pill to `error` so a chunk
   * that the worker has given up on does not silently sit at the bottom
   * of `Subiendo evidencia (N-1 / N)` forever.
   */
  const [failedCount, setFailedCount] = useState(0);
  /**
   * Most recent permanent-failure shape from the current session's
   * queue, kept so the home screen can render a human-readable line
   * under the red `error` pill via `humanizeFailure`. Set in the same
   * 500ms poll tick that drives `failedCount`. `null` whenever
   * `failedCount === 0`. Capturing only the FIRST failed chunk keeps
   * the UI deterministic — multiple chunks failing the same way show
   * one message; mixed failures (rare) show the earliest.
   */
  const [lastFailedError, setLastFailedError] = useState<
    QueueChunk['last_error'] | null
  >(null);
  /**
   * Older sessions still draining in the queue while the user looks at
   * the most recent one. Derived from `queue.length - 1` — the queue
   * is appended in creation order by `queueAppendNewSession`'s
   * `q.push(entry)`, so anything before the last element is a session
   * that finished recording earlier and is still uploading or waiting
   * to finalize. No new field, no timestamp, no persistence.
   */
  const [backgroundSessions, setBackgroundSessions] = useState(0);
  /**
   * Aggregate of chunks across the older queue entries (q[0..n-2]) that
   * still have at least one `pending` / `uploading` chunk. Lets the home
   * screen render `+N sesiones subiendo (X / Y)` instead of just the
   * count, so the user can see WHY background sessions are still
   * lingering. Derived strictly from the queue on each poll tick — no
   * new persistence, no new model.
   */
  const [bgActiveSessions, setBgActiveSessions] = useState(0);
  const [bgUploaded, setBgUploaded] = useState(0);
  const [bgTotal, setBgTotal] = useState(0);
  /**
   * Per-session "I have already shown the protected banner for this
   * session_id" memo. Refs (not state) on purpose: writing here MUST
   * NOT trigger re-renders. Lifetime is the component mount; not
   * persisted, not exported, not part of any contract.
   *
   * `firstPollTickRef` ensures a recovered queue at boot — entries
   * whose chunks were already 100% uploaded before the app reopened —
   * silently seeds the seen set without firing the banner. Otherwise
   * the user would see a stale "Evidencia protegida ✅" flash on every
   * cold start that happened to have a finished but un-reaped entry.
   */
  const seenProtectedSessionIdsRef = useRef<Set<string>>(new Set());
  const firstPollTickRef = useRef(true);
  /**
   * Sticky-visual marker for the "Evidencia protegida" moment.
   *
   * Purpose: the underlying `guardianStatus === 'protegido'` window can
   * be very brief — the worker reaps a closed entry soon after the last
   * 200 OK, so the user may not see it. We remember WHEN we last saw
   * `protegido` and keep the green banner visible for a few seconds
   * afterwards, even if the system has already returned to `listo`.
   *
   * This is PURELY a UI affordance:
   *   - never written to the queue
   *   - never sent to the backend
   *   - never gates recording, upload, recovery, or export
   *   - never read by `deriveGuardianStatus` (which is untouched)
   * The single source of truth for the system stays `guardianStatus`.
   */
  const [protectedShownAt, setProtectedShownAt] = useState<number | null>(null);
  /**
   * "El vídeo se detuvo porque la aplicación dejó de estar visible" sticky
   * notice timestamp.
   *
   * Stamped by `stopVideoForBackground` (AppState 'background' branch in
   * the lifecycle effect below) AFTER the existing `stopRecording()`
   * sequence has finished its clean shutdown. The paired auto-dismiss
   * effect clears it after VIDEO_BG_BANNER_MS, mirroring the
   * `protectedShownAt` pattern next door.
   *
   * Pure UI state — never read by `deriveGuardianStatus`, never gates
   * upload / recovery / export / chunking / queue. The single source of
   * truth for system status stays `guardianStatus`. This banner only
   * tells the user *why* the recording stopped (honest mode: video is
   * foreground-only). Audio is unaffected — `configureAudioMode` keeps
   * `shouldPlayInBackground` + `allowsBackgroundRecording` true and the
   * audio path survives the same transition unchanged.
   */
  const [videoBackgroundStopAt, setVideoBackgroundStopAt] = useState<
    number | null
  >(null);
  /**
   * Orphan recovery state — populated by `scanOrphans()` at boot. An
   * "orphan" is a `guardian_recording_*.{aac,m4a,mp4}` file in
   * `documentDirectory` with no matching entry in GC_QUEUE. The 2026-05-15
   * incident (verified `.aac` of 3,760,704 bytes on disk while
   * `entries: 0` in queue after AsyncStorage was wiped) is the
   * canonical failure mode this state closes.
   *
   *   - `orphanRecoverable`     — files the user can recover via the
   *                                banner CTA. Drained one-at-a-time
   *                                by `handleRecoverOrphans`.
   *   - `orphanOversizedCount`  — separate counter for audio files
   *                                exceeding `AUDIO_ORPHAN_MAX_BYTES`.
   *                                Surfaced in the banner copy but
   *                                NEVER recovered (the existing audio
   *                                chunker stores base64 inline and
   *                                large files re-trip CursorWindow,
   *                                which is the very corruption that
   *                                produced the orphan in the first
   *                                place).
   *   - `orphanBusy`            — re-entrancy guard for the recover
   *                                handler. Mirrors the
   *                                `isStarting`/`isStopping` pattern.
   *   - `orphanProgress`        — { current, total } shown in the
   *                                banner during serial recovery so
   *                                the user sees "Recuperando
   *                                evidencia 2/3…". null when idle.
   *
   * All four are UI-only mirrors. None gate the queue, worker,
   * recovery cross-device, export, manifests, AudioEngine, chunking,
   * or backgroundService. The single source of truth for the system
   * remains `guardianStatus` + GC_QUEUE.
   */
  const [orphanRecoverable, setOrphanRecoverable] = useState<OrphanFile[]>([]);
  const [orphanOversizedCount, setOrphanOversizedCount] = useState(0);
  const [orphanBusy, setOrphanBusy] = useState(false);
  const [orphanProgress, setOrphanProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  /**
   * Persisted UI preference: "Inicio rápido" (panic mode prep).
   *
   * When true:
   *   - The home screen renders the "Inicio rápido activado" pill near
   *     the main button so the user knows the panic flow is armed.
   *   - On a returning-user cold start the screen launches a short
   *     visual countdown (`countdownSec`) that the user can cancel.
   *     Reaching 0 calls the same `startRecording()` path that the
   *     GRABAR button uses — no duplicated start logic, no background
   *     auto-start, no widget/intent shortcut. SOLO apertura normal.
   *   - First install (welcome modal active or unseen this session)
   *     blocks the auto-countdown so the user's first contact with
   *     the app stays explicit.
   */
  const [quickStartEnabled, setQuickStartEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(QUICK_START_KEY)
      .then(raw => {
        if (cancelled) return;
        setQuickStartEnabled(raw === '1');
      })
      .catch(() => {
        /* default false, ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * One-shot beta welcome modal. Shown the first time the user opens
   * the app on this device; persisted-dismissed forever afterwards via
   * `BETA_WELCOME_SEEN_KEY`. Defaults to false so a read failure (rare,
   * AsyncStorage error) silently skips the modal rather than blocking
   * the user from reaching Home — the welcome is informational, not
   * gating. Lifecycle is independent from every other piece of state on
   * this screen: the modal is a transparent overlay that never blocks
   * recording, recovery, or upload.
   */
  const [showBetaWelcome, setShowBetaWelcome] = useState(false);
  /**
   * Welcome flow status — separate from `showBetaWelcome` (which only
   * tracks modal visibility) so the auto-countdown trigger can gate on
   * "returning user, never first install in this session". Three values:
   *   - `loading`: AsyncStorage read still pending.
   *   - `first-install-this-session`: BETA_WELCOME_SEEN_KEY was unset
   *     when we read it; the welcome modal is showing or was dismissed.
   *     Even after dismissal, this stays sticky for the rest of the
   *     session so the auto-countdown never fires on first contact.
   *   - `returning-user`: BETA_WELCOME_SEEN_KEY was '1' on this device.
   *     Auto-countdown is allowed (subject to the other gates).
   */
  const [welcomeStatus, setWelcomeStatus] = useState<
    'loading' | 'first-install-this-session' | 'returning-user'
  >('loading');
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(BETA_WELCOME_SEEN_KEY)
      .then(raw => {
        if (cancelled) return;
        if (raw !== '1') {
          setShowBetaWelcome(true);
          setWelcomeStatus('first-install-this-session');
        } else {
          setWelcomeStatus('returning-user');
        }
      })
      .catch(() => {
        /* default false (no modal). Treat as returning user — the
           welcome is informational and we never want a transient
           AsyncStorage failure to permanently disable quick-start. */
        if (!cancelled) setWelcomeStatus('returning-user');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Dismiss the beta welcome modal and persist the "seen" flag so it
   * never appears again on this device. Best-effort persistence —
   * matches the QUICK_START_KEY pattern: a write failure means the
   * modal will reappear on the next launch, which is annoying but
   * never affects recording or upload integrity.
   */
  function dismissBetaWelcome() {
    setShowBetaWelcome(false);
    AsyncStorage.setItem(BETA_WELCOME_SEEN_KEY, '1').catch(() => {
      /* best-effort, ignore */
    });
  }

  // ----- Quick-start countdown (panic-mode auto-record) -----
  //
  // Visible 3 → 2 → 1 ticking before the canonical `startRecording()`
  // is invoked — same function the GRABAR button calls, so the queue,
  // worker, recorder and recovery code paths see ZERO change. Local
  // state, local refs, single file. No persistence, no global store.
  /**
   * Visible countdown number, or `null` when no countdown is running.
   * Drives the modal's visibility (`countdownSec !== null`) and the
   * big number rendered inside it.
   */
  const [countdownSec, setCountdownSec] = useState<number | null>(null);
  /**
   * Single-shot guard. Set to `true` the first time the trigger effect
   * fires the countdown in this mount, NEVER reset. A user who cancels
   * (or whose countdown is killed by background / blur) keeps the flag
   * — re-firing the auto-countdown after an explicit cancel would feel
   * harassing.
   */
  const countdownDispatchedRef = useRef(false);
  /**
   * Handle of the in-flight `setTimeout`. Held so cancel paths
   * (button, blur, background, unmount) can clear it deterministically.
   */
  const countdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelCountdown(): void {
    if (countdownTimerRef.current !== null) {
      clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownSec(null);
  }

  function startCountdown(): void {
    countdownDispatchedRef.current = true;
    setCountdownSec(3);
    // One soft haptic at appearance — confirms to the user that the
    // panic flow has armed without competing with the Heavy haptic
    // that fires when `startRecording()` actually starts at 0.
    Haptics.selectionAsync().catch(() => {
      /* haptics not available — ignore */
    });
    let value = 3;
    const tick = (): void => {
      value -= 1;
      if (value > 0) {
        setCountdownSec(value);
        countdownTimerRef.current = setTimeout(tick, 1000);
      } else {
        // Reached zero. Clear timer ref + visible state BEFORE
        // calling startRecording so the function reads a clean state.
        // `startRecording` has its own `isStartingRef` guard
        // (line ~3931) that fail-safes against any race where the
        // GRABAR button might have been double-tapped through a
        // race window we haven't anticipated.
        countdownTimerRef.current = null;
        setCountdownSec(null);
        startRecording();
      }
    };
    countdownTimerRef.current = setTimeout(tick, 1000);
  }

  // Cancel countdown when the user navigates away from Home (Settings,
  // Historial, deep-link route, etc.). The blur callback fires on
  // navigation; the focus side is intentionally a no-op so we do NOT
  // re-arm the countdown when the user returns — once dispatched, that
  // session's auto-countdown is done.
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (countdownTimerRef.current !== null) cancelCountdown();
      };
    }, []),
  );

  // Cancel countdown when the app goes to background. Mirrors the
  // navigation-blur behaviour: the user's intent has shifted away
  // from "I am about to record". Cleanup also clears any timer that
  // outlived the unmount cycle.
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next !== 'active' && countdownTimerRef.current !== null) {
        cancelCountdown();
      }
    });
    return () => {
      sub.remove();
      if (countdownTimerRef.current !== null) {
        clearTimeout(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, []);

  function resetProgress() {
    setConfirmedOffDeviceCount(0);
    setTotalCount(0);
    setActiveCount(0);
    setFailedCount(0);
    // A fresh session starts open; resetting to false keeps the
    // denominator suppressed until the poll observes a real
    // `recording_closed` on the new entry.
    setRecordingClosed(false);
    setLastFailedError(null);
    setBackgroundSessions(0);
  }

  async function refreshDestination() {
    try {
      const { destinations } = await listDestinations();
      const drive = destinations.find(
        (d) => d.type === 'drive' && d.status === 'connected',
      ) ?? null;
      const nas = destinations.find(
        (d) => d.type === 'nas' && d.status === 'connected',
      ) ?? null;
      // UI gate: GRABAR button requires a Drive destination (UI selector
      // for NAS comes in a later phase — do not change this yet).
      setDrive(drive ?? undefined);
      // Worker routing rules (Settings owns the choice, never `__DEV__`):
      //   - Only Drive connected         → 'drive'
      //   - Only NAS connected           → 'nas'
      //   - Both connected               → user's persisted preference;
      //                                    if none / stale, Drive wins
      //   - Neither connected            → safe default 'drive' (the
      //                                    drain-loop race-guard keeps
      //                                    chunks pending until a real
      //                                    destination is configured;
      //                                    recovery is unaffected)
      const preferred = await getPreferredDestinationType();
      const preferredIsValid =
        (preferred === 'drive' && drive) || (preferred === 'nas' && nas);
      if (preferredIsValid && preferred) {
        activeDestinationType = preferred;
      } else {
        activeDestinationType = drive ? 'drive' : nas ? 'nas' : 'drive';
      }
      // Mirror the resolved value into a React state so the home can
      // render "Protegiendo en: Drive/NAS" without re-resolving. The
      // module-level `activeDestinationType` remains the source of truth
      // for the worker.
      setActiveDest(activeDestinationType);
      // Mirror the per-type connection booleans for the home label so
      // the "Protegiendo en …" line can hide itself when nothing is
      // connected — same data already used above, no extra fetch.
      setHasNas(Boolean(nas));
      // Release the drain-loop race guard. Once true, the worker is free
      // to route chunks; before this, it deferred every tick.
      const wasBlocked = !destinationResolved;
      destinationResolved = true;
      console.log('DEST_TYPE', { activeDestinationType, destinationResolved });

      // GC-DEST-PAUSE-001 — the backend has just told us which
      // destinations are connected. That is the one signal that can
      // retire a destination pause, and this is the only place in the
      // app that holds it.
      //
      // NOTE THE INPUT: `drive` / `nas` are the rows filtered on
      // `status === 'connected'` above — NOT `destinationResolved`,
      // which is true even with nothing connected and would unblock a
      // broken destination.
      //
      // This function does not own uploading. It removes a block that is
      // provably stale and then asks the EXISTING drain to run.
      const unblocked = await clearRecoveredDestinationPauses({
        drive: Boolean(drive),
        nas: Boolean(nas),
      });

      // Re-kick the drain: any tick that early-returned while we were
      // resolving needs a fresh entry point now that routing is known,
      // and a pause we just retired leaves chunks that were parked on
      // it. uploadDrainLoop is single-flight (`isDraining`), so a
      // redundant kick while already draining is a harmless no-op.
      if (wasBlocked || unblocked.length > 0) {
        uploadDrainLoop().catch((err) => {
          if (DEBUG_QUEUE) {
            console.log('GC_DEBUG drain rejected (from refreshDestination)', {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
    } catch (error) {
      // Transient check failure (network, 401) → leave as `null` so the
      // button remains disabled but no hard block. The user can retry
      // via the Settings screen. Recovery is independent of this.
      console.log('DEST CHECK ERROR:', error);
      setDrive(null);
      // Survival-software diagnostic (observability ONLY — does not
      // change pinning, fallback, or worker behaviour). Surfaces a
      // narrow but high-consequence beta scenario:
      //   - User has a persisted destination preference (e.g. NAS-only)
      //   - Cold-boot is offline so `refreshDestination` fails
      //   - `destinationResolved` stays false; module-level
      //     `activeDestinationType` stays at its hardcoded default 'drive'
      //   - User starts a recording before any successful refresh — the
      //     pinning capture writes `entry.destination_type = 'drive'`
      //   - When the network returns the worker uploads to Drive, which
      //     for NAS-only users surfaces as DRIVE_NOT_CONNECTED 409 →
      //     permanent failure → the session gets stuck (R3).
      // Logging here lets the operator measure how often this divergence
      // happens in beta logs before any behaviour change. Wrapped in
      // try/catch so a preference read failure (rare, AsyncStorage error)
      // never escapes the destination check path.
      if (!destinationResolved) {
        try {
          const preferred = await getPreferredDestinationType();
          if (preferred && preferred !== activeDestinationType) {
            console.log('GC_DEST_OFFLINE_FALLBACK_DIVERGENCE', {
              persisted_preference: preferred,
              module_active: activeDestinationType,
              warning:
                'recordings started now would pin to module_active, ' +
                'not persisted_preference',
            });
          }
        } catch {
          // Preference read failure has no diagnostic value — ignore.
        }
      }
    }
  }

  // Live preference sync: when Settings persists a new Drive/NAS choice
  // (Settings sub-tree → cross-route, same JS runtime) the in-process
  // pub/sub fires here and we re-resolve immediately. Without this the
  // module-level `activeDestinationType` and the React state mirror
  // `activeDest` stay stale until the next cold boot — observable as
  // "I changed destination in Settings, Home still says the old one,
  // and my next recording pins to the wrong destination".
  //
  // Active sessions are NOT retargeted: the queue entry's
  // `destination_type` (per-session pin) was captured at GRABAR time
  // and the worker reads `pick.destinationType ?? activeDestinationType`
  // — pinned values always win. Only FUTURE recordings observe the new
  // resolver result.
  useEffect(() => {
    return subscribePreferredDestinationChange(() => {
      refreshDestination();
    });
    // refreshDestination is a stable component-scoped function that
    // only writes via stable React setters and reads fresh values from
    // AsyncStorage / the network on each call, so the captured closure
    // does not cause stale reads. Single subscription per mount.
  }, []);

  // Re-resolve destinations whenever Home regains focus. The trigger
  // path that motivates this: the user opens Settings, runs the Drive
  // OAuth dance, returns to Home — without a focus refresh the home
  // would still render "Sin destino conectado" and refuse to record
  // until a cold start. The Settings → Home navigation does NOT
  // remount this screen, so the bootstrap useEffect below does NOT
  // re-fire on its own.
  //
  // First-focus skip: the bootstrap useEffect already calls
  // `refreshDestination()` once after auth + recovery, and that focus
  // also fires on initial mount. Skipping the first focus avoids a
  // redundant network round-trip on cold start. The function is
  // idempotent so a double-fire would be safe — the skip is purely a
  // performance hygiene choice.
  //
  // Cross-tab updates of `preferred` are handled by the in-process
  // subscription right above; this focus path is the safety net for
  // Drive/NAS row arrival (a different state class than preference
  // change), and also catches the case where Settings refreshed the
  // backend while Home was blurred but no preference event fired.
  const firstDestFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstDestFocusRef.current) {
        firstDestFocusRef.current = false;
        return;
      }
      refreshDestination();
    }, []),
  );

  useEffect(() => {
    (async () => {
      try {
        // GC-AUTH-MIGRATION-001 — start resolving the migration boundary
        // FIRST, so it is settled as early as this effect can make it.
        //
        // It used to sit after `init()` and two `getSession()` calls,
        // behind ~550ms of diagnostic sleeps. Every one of those can block
        // for seconds on a hostile network — and 4C no longer refuses a
        // capture without a token, so a recording started meanwhile would
        // write a queue entry and a history row BEFORE the probe had
        // looked, and the probe would then read the app's own fresh traces
        // as proof of an identity that never existed.
        //
        // THIS HOIST ALONE DOES NOT CLOSE THE RACE, and an earlier version
        // of this comment wrongly claimed it ran "before anything can be
        // rendered or tapped". It does not: React commits the render — and
        // paints an enabled GRABAR AHORA — before effects run. The
        // structural guarantee lives in `startRecording`, which awaits
        // `ensureMigrationBoundary()` before its first durable write. Both
        // callers share one single-flight execution, so whichever arrives
        // first does the work and the other joins it. The hoist is what
        // makes that join almost always free.
        const {
          initialized,
          fromLegacyProbe,
          source: identitySource,
          boundaryUnsealed,
        } = await resolveIdentityInitialized();

        // DEBUG: unmistakable build sentinel. If this string does NOT appear
        // on screen at boot, the emulator is running a stale JS bundle and
        // none of the ZZ_HEALTH_PROBE_* / ZZ_FETCH_POST_START / enhanced
        // ZZ_ERROR_SESSION diagnostics added later in the flow will fire.
        // 500ms dwell so it is legible to a human eye even on fast boots.
        setTestStatus('ZZ_DEBUG_BUILD_V2');
        await new Promise(r => setTimeout(r, 500));
        setTestStatus(`API URL: ${env.apiUrl}`);
        await new Promise(r => setTimeout(r, 50));
        // GC-AUTH-001 — bring the auth store to life, exactly once.
        //
        // `init()` had no callers at all. Two things were dead as a
        // result: `onAuthStateChange` was never subscribed, so
        // TOKEN_REFRESHED and SIGNED_OUT went unobserved; and
        // `notifyClientAuth` — the only thing that lifts the Phase 1A
        // `client_auth` queue pause — could never fire. The queue could
        // enter that pause and never leave it.
        //
        // Called here, at the top of the mount-once bootstrap effect and
        // BEFORE the identity state machine, so the subscription is
        // already live when a first-boot `signInAnonymously()` emits
        // SIGNED_IN. `store.ts` guards the subscription with a
        // module-level latch, so a second invocation (React StrictMode
        // double-invokes effects in dev) cannot register a second
        // listener.
        await useAuthStore.getState().init();

        // Auth bootstrap — anonymous Supabase user per device. Each
        // install gets its own distinct auth.users.id, so the existing
        // server-side `user_id` filters on destinations / sessions /
        // chunks isolate every user cleanly. No literal credentials in
        // the bundle.
        //
        // Sentinel cleanup: APKs shipped before this fix auto-logged
        // in as a hardcoded creator account. If we still see that
        // session persisted in AsyncStorage, force a signOut so the
        // anon branch below creates a fresh per-device user and the
        // device stops impersonating the creator. The email literal is
        // NOT a secret — it was already public in older bundles — but
        // it is the only reliable signal we can pivot off to detect
        // and purge those legacy sessions on app update.
        const HARDCODED_LEGACY_EMAIL = 'diego@hotmail.com';
        const existingProbe = await supabase.auth.getSession();
        const existingSession = existingProbe.data.session;
        if (existingSession?.user?.email === HARDCODED_LEGACY_EMAIL) {
          console.log('AUTH PURGE legacy hardcoded session');
          await supabase.auth.signOut();
        }

        // GC-AUTH-001 — identity state machine.
        //
        // This used to read `!session` as "no identity has ever existed
        // here" and answer it by minting a new anonymous user. Because a
        // new sign-in overwrites the persisted session and this app has
        // no login, that made every transient failure — a dropped
        // packet, a refresh that could not complete — permanently orphan
        // the identity that owned everything already uploaded.
        //
        // Now the decision needs two inputs: whether a session came back,
        // AND durable proof about whether an identity ever existed.
        // `error` is read too, and it never opens the minting gate: a
        // `getSession()` that failed cannot prove absence, it only proves
        // we could not find out.
        const bootstrapProbe = await supabase.auth.getSession();
        let bootstrapSession = bootstrapProbe.data.session;
        // `initialized` / `fromLegacyProbe` / `identitySource` were resolved
        // at the very top of this effect — see the GC-AUTH-MIGRATION-001
        // note there for why they cannot wait until here.
        const decision = decideIdentityState({
          hasSession: !!bootstrapSession,
          hasError: !!bootstrapProbe.error,
          initialized,
          boundaryUnsealed,
        });
        console.log('GC_IDENTITY_STATE', {
          state: decision.state,
          reason: decision.reason,
          initialized,
          from_legacy_probe: fromLegacyProbe,
          // GC-AUTH-MIGRATION-001: which durable record decided it.
          // 'seal' / 'probe' distinguishes a boundary crossing from every
          // boot after it; 'marker_malformed' is the conservative refusal.
          identity_source: identitySource,
          probe_version: LEGACY_PROBE_VERSION,
          // True only when the probe said "no prior identity" and that
          // answer could not be written down. Minting stays closed.
          boundary_unsealed: boundaryUnsealed,
          had_error: !!bootstrapProbe.error,
          error_name: bootstrapProbe.error?.name ?? null,
        });

        if (decision.state === 'IDENTITY_DEGRADED') {
          // Deliberately NOT minting. The device keeps whatever identity
          // it has (or had); recovery is retried on foreground resume by
          // the AppState handler. Capture and the queue are unaffected —
          // evidence is never held hostage to the backend.
          setTestStatus('Sin sesión — reintentando');
          return;
        }

        if (decision.state === 'FIRST_IDENTITY') {
          const { data: anonData, error: anonError } =
            await supabase.auth.signInAnonymously();
          console.log('GC_ANON_SIGNIN', {
            new_sub_prefix: anonData?.user?.id?.slice(0, 8) ?? null,
            error: anonError ? anonError.name : null,
          });
          if (anonError || !anonData.session) {
            // No marker is written: a sign-in that failed did not create
            // an identity, and pretending otherwise would wall the device
            // off permanently on its very first boot.
            setTestStatus('No se pudo iniciar sesión anónima');
            console.log('AUTH ANON_SIGNIN_FAIL', {
              message: anonError?.name ?? 'no session returned',
            });
            return;
          }
          bootstrapSession = anonData.session;
          const mint = await markIdentityInitialized(anonData.user?.id ?? null);
          await guardUndurableIdentity(mint.persisted, 'minted');
          console.log('AUTH ANON_SIGNIN_OK', {
            sub_prefix: anonData.user?.id?.slice(0, 8) ?? null,
            marker_durable: mint.persisted,
          });
        } else {
          // IDENTITY_OK. Back-fill the marker for devices that already
          // had a live identity before this shipped. Idempotent.
          const backfill = await markIdentityInitialized(
            bootstrapSession?.user?.id ?? null,
          );
          await guardUndurableIdentity(backfill.persisted, 'observed');
        }

        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token ?? null;
        if (!token) {
          setTestStatus('Necesitas iniciar sesión');
          console.log('ERROR: missing access_token');
          return;
        }
        // Make the token visible to `apiFetch` (via useAuthStore) so the
        // destinations client and the Settings screen can issue
        // authenticated calls without re-running the login flow. This is
        // a pure store update — nothing in the chunk/recovery path reads
        // from the store, so it cannot alter upload behaviour.
        useAuthStore.setState({
          status: 'signed-in',
          user: session?.user ?? null,
          accessToken: token,
        });
        setTestStatus('ZZ_TOKEN_OK');
        await new Promise(r => setTimeout(r, 50));
        // Safe fingerprint only — no content, no prefix, no signing material.
        console.log('TOKEN:', {
          length: token.length,
          looks_like_jwt: token.split('.').length === 3,
        });
        console.log('API URL:', env.apiUrl);

        // Kick off the destination check in the background. MUST NOT be
        // awaited here — a slow /destinations call MUST NOT delay Phase
        // 2 recovery. Recovery is the priority when pending state exists.
        refreshDestination();

        // Gate GRABAR for the "closing prior session" window. The
        // recording invariant of Guardian Cloud is "subir evidencia >
        // grabar perfecto" — a new recording MUST be allowed while old
        // chunks finish uploading. So `isRecovering` (which feeds
        // `isBusy` → `buttonDisabled`) must ONLY be set while the
        // previous session has not yet been logically closed: three
        // signals indicate that state, and any one of them is enough to
        // bring the gate up.
        //
        //   1. `chunkerStates.size > 0`        — chunker JS loop still
        //                                         alive from the previous
        //                                         mount (foreground-service
        //                                         kept process alive case).
        //   2. `hasActiveAudioRecording()`     — MediaRecorder handle
        //                                         still in memory (owned by
        //                                         `@/audio/audioEngine`).
        //   3. some queue entry has            — persisted state from a
        //      `recording_closed === false`      cold-start kill that never
        //                                         got the final flip.
        //
        // After the `queueMutate` further down flips every entry to
        // `recording_closed=true` (and the dirty-cleanup block below
        // clears the in-memory state), the window is over and we lower
        // the gate immediately so the rest of recovery (drain, reap,
        // reconcile, worker) runs WITHOUT blocking GRABAR.
        const dirtyInMemory =
          chunkerStates.size > 0 || hasActiveAudioRecording();
        let dirtyPersisted = false;
        try {
          const qDetect = await queueRead();
          dirtyPersisted = qDetect.some(e => !e.recording_closed);
        } catch {
          /* best effort — assume nothing persisted to close */
        }
        const closingPriorSession = dirtyInMemory || dirtyPersisted;
        if (closingPriorSession) {
          setIsRecovering(true);
        }

        // Dirty-state cleanup: when the user swipe-closes while audio is
        // recording, expo-audio's foreground service elevates the JS
        // process priority enough that Android does NOT kill it. The
        // activity is destroyed and re-created — so this boot effect
        // runs again — but `chunkerStates` (module-scoped in this file)
        // and the audio recorder handle (module-scoped inside
        // `@/audio/audioEngine`) still hold the previous session. The
        // chunker keeps emitting and the MediaRecorder keeps writing,
        // which the user perceives as "fragments forever after I
        // closed the app". Product rule for beta: a swipe-close should
        // finalize the recording and upload what we have, not extend
        // it.
        //
        // Cold start (process actually died) is a no-op here because
        // `chunkerStates.size === 0` and `hasActiveAudioRecording()`
        // returns false on a fresh JS context. The gate is what makes
        // that safe.
        if (chunkerStates.size > 0 || hasActiveAudioRecording()) {
          console.log('GC_BOOT_DIRTY_STATE_DETECTED', {
            chunker_state_ids: Array.from(chunkerStates.keys()),
            has_active_recorder: hasActiveAudioRecording(),
          });
          // 1. Stop the native MediaRecorder FIRST so the file stops
          //    growing. Without this, the chunker's final pass below
          //    would race against an open writer and the queue would
          //    keep getting new chunks while we try to close it. The
          //    engine swallows stop() errors and emits the existing
          //    `GC_BOOT_DIRTY_STATE_RECORDER_STOP_FAILED` log with the
          //    same shape as before — behaviour is byte-equivalent.
          await cleanupDirtyAudioState();
          // 2. For each live chunker, run its final pass (captures the
          //    tail of whatever the recorder wrote up to the stop) and
          //    mark the session closed. The worker further down picks
          //    them up and drains the queue. `stopChunkerForSession`
          //    handles its own internal gating (finalizing flag, await
          //    inflight) and deletes the entry from `chunkerStates`.
          //    `queueMarkRecordingClosed` is idempotent and just sets
          //    the persisted flag; we read `emitted_base64_length` /
          //    `next_chunk_index` from the queue entry so the worker
          //    has the same view it would after a normal stopRecording.
          for (const sid of Array.from(chunkerStates.keys())) {
            const state = chunkerStates.get(sid);
            if (!state) continue;
            try {
              await stopChunkerForSession(sid, state.fileUri);
              // Pull the post-final-pass counters so the persisted
              // close mirrors what `stopRecording` writes after the
              // user taps PARAR. Best-effort: if the entry vanished
              // we just skip the persistence step (the worker will
              // reap on its own).
              const q = await queueRead();
              const entry = q.find(e => e.session_id === sid);
              if (entry) {
                await queueMarkRecordingClosed(
                  sid,
                  state.fileUri,
                  entry.emitted_base64_length,
                  entry.next_chunk_index,
                );
              }
              console.log('GC_BOOT_DIRTY_STATE_SESSION_CLOSED', {
                session_id: sid,
              });
            } catch (err) {
              console.log('GC_BOOT_DIRTY_STATE_CHUNKER_STOP_FAILED', {
                session_id: sid,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        // Recovery on app open. The legacy single-session PENDING_RETRY_KEY
        // (PendingState shape) is migrated in place to the new array shape
        // (PendingQueueEntry[]). Then the worker drains every entry —
        // legacy entries (no `base64Slice`) rehydrate from `uri` via
        // `rehydrateChunkSlice`. The worker also calls completeSession
        // when an entry's recording_closed flag is true and all chunks
        // have settled (uploaded or failed-permanent), then reaps it.
        //
        // Worker is fire-and-forget: we await for UI feedback only when
        // there is actually pending work; a short await with the worker
        // running in the background is acceptable so the screen renders
        // "RECOVERING N chunks" while it drains the obvious cases.
        console.log('GC_BOOT_RECOVERY_START', { ts: Date.now() });

        // -----------------------------------------------------------
        // Diagnostic boot snapshots (read-only, no mutation).
        //
        // These three logs answer "did AsyncStorage / docDir survive
        // the previous run, or was something wiped externally?". Each
        // is wrapped in its own try/catch so a single failure does not
        // block recovery; the existing flow continues regardless.
        //
        // They were added after a long-audio session lost evidence
        // post-restart with `entries: 0` in GC_BOOT_QUEUE_PENDING. The
        // hypothesis to confirm is "all of AsyncStorage was cleared at
        // OS level"; these snapshots give that question definitive
        // answers in logcat instead of requiring debug builds. None of
        // them touch backend, recovery cross-device, export, manifests,
        // AudioEngine, the worker, or the queue shape.
        // -----------------------------------------------------------

        // GC_BOOT_STORAGE_KEYS — enumerate every key currently in
        // AsyncStorage. If `sb-*-auth-token` is missing AND
        // `test.pending_retry` is missing → app data was wiped (Clear
        // Data, OS storage-pressure cleanup, uninstall/reinstall). If
        // only `test.pending_retry` is missing while `sb-*` survived
        // → something inside Guardian Cloud wiped the queue. The
        // distinction matters: external wipe is "user/OS action",
        // internal wipe is "our bug".
        try {
          const keys = await AsyncStorage.getAllKeys();
          console.log('GC_BOOT_STORAGE_KEYS', {
            count: keys.length,
            keys,
          });
        } catch (err) {
          console.log('GC_BOOT_STORAGE_KEYS', {
            err: err instanceof Error ? err.message : String(err),
          });
        }

        // GC_BOOT_RAW_QUEUE_LEN — raw getItem result of the queue key
        // BEFORE any parse / migrate. Distinguishes three boot-time
        // queue states:
        //   raw_null=true                   → key never written or
        //                                     externally removed
        //   raw_null=false, raw_len=2       → JSON `[]` — queue was
        //                                     reset to empty by code
        //   raw_null=false, raw_len > 2     → real queue data exists,
        //                                     and `entries: 0` from
        //                                     GC_BOOT_QUEUE_PENDING
        //                                     would point to a parse
        //                                     issue, not a wipe
        try {
          const raw = await AsyncStorage.getItem(PENDING_RETRY_KEY);
          console.log('GC_BOOT_RAW_QUEUE_LEN', {
            raw_null: raw === null,
            raw_len: raw === null ? null : raw.length,
          });
        } catch (err) {
          console.log('GC_BOOT_RAW_QUEUE_LEN', {
            err: err instanceof Error ? err.message : String(err),
          });
        }

        // GC_BOOT_DOCDIR_FILES — list any `guardian_recording_*` /
        // `guardian_recovered_*` / `guardian_export_*` files currently
        // sitting in `documentDirectory`. A file present here with NO
        // corresponding queue entry is an "orphan" — evidence the user
        // captured that the upload pipeline never finished and recovery
        // can no longer see. Today recovery only reads the queue, so
        // these files are invisible to the system. The orphan-recovery
        // pre-task (Capa 1) is the follow-up that uses this data; for
        // now we just surface it for diagnosis.
        //
        // We `getInfoAsync` each candidate so the log carries the byte
        // size — a 0-byte file is a different signal (encoder crashed
        // before any write) than a 3 MB file (real evidence).
        try {
          const docDir = FileSystem.documentDirectory;
          if (docDir) {
            const all = await FileSystem.readDirectoryAsync(docDir);
            const candidates = all.filter(
              f =>
                f.startsWith('guardian_recording_') ||
                f.startsWith('guardian_recovered_') ||
                f.startsWith('guardian_export_'),
            );
            const recording_files: {
              name: string;
              size: number | null;
            }[] = [];
            for (const f of candidates) {
              try {
                const info = await FileSystem.getInfoAsync(docDir + f);
                recording_files.push({
                  name: f,
                  size: info.exists
                    ? (info as { size?: number }).size ?? null
                    : null,
                });
              } catch {
                recording_files.push({ name: f, size: null });
              }
            }
            console.log('GC_BOOT_DOCDIR_FILES', {
              total: all.length,
              recording_files,
            });
          } else {
            console.log('GC_BOOT_DOCDIR_FILES', {
              skipped: 'no documentDirectory',
            });
          }
        } catch (err) {
          console.log('GC_BOOT_DOCDIR_FILES', {
            err: err instanceof Error ? err.message : String(err),
          });
        }

        // Pre-normalisation snapshot of the persisted queue. Captures
        // the state Android left behind after the kill — the
        // `uploading` count here is the number of chunks that were
        // mid-flight when the app died and that the stuck-reset step
        // below will flip back to `pending`.
        try {
          const qBoot = await queueRead();
          let bootPending = 0;
          let bootUploading = 0;
          let bootFailed = 0;
          for (const e of qBoot) {
            for (const c of e.chunks) {
              if (c.status === 'pending') bootPending += 1;
              else if (c.status === 'uploading') bootUploading += 1;
              else if (c.status === 'failed') bootFailed += 1;
            }
          }
          console.log('GC_BOOT_QUEUE_PENDING', {
            entries: qBoot.length,
            pending: bootPending,
            uploading: bootUploading,
            failed: bootFailed,
          });
        } catch (err) {
          console.log('GC_BOOT_QUEUE_PENDING', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          await migrateLegacyPendingState();
        } catch (err) {
          console.log('GC_QUEUE migrate legacy failed', err);
        }

        // Post-migration normalisation: collapse duplicate session_id
        // entries, drop exact-duplicate chunks, mark hash-divergent
        // sessions as corrupt-and-failed. Idempotent — a clean queue
        // produces an all-zero report. Runs AFTER legacy migration so
        // both legacy-shape and new-shape entries are normalised.
        try {
          const report = await normalizeQueueOnRecovery();
          const anyChange =
            report.entries_collapsed > 0 ||
            report.exact_duplicates_dropped > 0 ||
            report.sessions_marked_corrupt > 0;
          if (anyChange) {
            console.log('GC_QUEUE normalize report', report);
          }
        } catch (err) {
          console.log('GC_QUEUE normalize failed', err);
        }

        // Mid-upload recovery normalisation. At app open `chunkerStates`
        // is empty (it is in-memory, rebuilt only on a fresh GRABAR), so
        // any persisted entry belongs to a session that is no longer
        // being recorded. Two stuck-state fixes that without this would
        // leave the worker spinning forever after the last upload:
        //   1. status='uploading' chunks were already in flight when the
        //      previous run died. `pickNext` filters strictly on
        //      status='pending', so without this reset the drain never
        //      retries them — UI stays at "Subiendo evidencia (N-1 / N)".
        //   2. recording_closed=false on a recovered entry blocks
        //      `tryFinalizeReadySessions`. Even after every chunk lands,
        //      the session never completes and the entry is never reaped.
        try {
          let stuckUploading = 0;
          let entriesClosed = 0;
          await queueMutate(q => {
            for (const e of q) {
              if (!e.recording_closed) {
                e.recording_closed = true;
                // G1 — parallel write. This route force-closes every
                // persisted entry on a cold boot; see finding S2, which
                // records that ADR-CONTINUOUS-PROTECTION §6 will require
                // revisiting it in G7. G1 changes neither the condition
                // nor the behaviour: it only mirrors the value.
                e.evidence_closed = true;
                entriesClosed += 1;
              }
              for (const c of e.chunks) {
                if (c.status === 'uploading') {
                  c.status = 'pending';
                  stuckUploading += 1;
                }
              }
            }
          });
          if (stuckUploading > 0 || entriesClosed > 0) {
            console.log('GC_QUEUE recovery finalize-prep', {
              stuck_uploading_reset: stuckUploading,
              entries_marked_closed: entriesClosed,
            });
          }
          // Canonical recovery log: stuck-uploading count after reset.
          // Always emitted (including 0) so the operator can confirm
          // the reset step ran on this boot.
          console.log('GC_BOOT_STUCK_UPLOAD_RESET', {
            count: stuckUploading,
            entries_marked_closed: entriesClosed,
          });
        } catch (err) {
          console.log('GC_QUEUE recovery finalize-prep failed', err);
        }

        // Closing window over. Every prior session is now
        // `recording_closed=true` (the queueMutate above is the
        // authoritative flip) and the in-memory dirty state was cleared
        // by the dirty-cleanup block. The rest of recovery — reap,
        // reconcile, register loop, drain, foreground-service start —
        // operates on a sane queue and MUST NOT block GRABAR per the
        // product rule "subir en paralelo, no hacer esperar al usuario
        // por red lenta". The `finally` below remains as a safety net
        // for an unexpected throw between Edit A and here.
        if (closingPriorSession) {
          setIsRecovering(false);
        }

        // Reap entries that already finished (session_completed=true,
        // no pending chunks) so the recovery banner does not advertise
        // work that does not exist. Worker would do this anyway on its
        // first drain — running it now keeps boot UX honest.
        try {
          const { reaped } = await reapAlreadyDoneEntries();
          if (reaped > 0) {
            console.log('GC_QUEUE recovery reaped done entries', { reaped });
          }
        } catch (err) {
          console.log('GC_QUEUE recovery reap failed', err);
        }

        // Finish any cleanup a previous run authorized but did not complete.
        //
        // Runs unguarded against a concurrent GRABAR, and it does not need a
        // gate: a journal entry only exists for a session the backend already
        // confirmed as finished, and a finished session is by definition not
        // the one a new capture is about to start. The native side refuses
        // SESSION_ACTIVE anyway, so even a same-id collision — which cannot
        // happen, the id is a fresh UUID — would be declined rather than
        // destroy anything.
        //
        // Directories with no journal entry are invisible here. That is the
        // whole design: age, emptiness and absence from GC_QUEUE never
        // authorize a deletion.
        //
        // Requested, not awaited. Cleanup is durable maintenance that survives
        // in the journal, so it must not delay the recovery steps below, the
        // backend reconciliation that follows them, or the moment GRABAR
        // becomes usable. A slow or retrying pass would otherwise hold all of
        // that behind it. `reconcileStaleSessionsWithBackend` further down asks
        // again once it has created new authorizations, and the scheduler
        // collapses both requests into the passes actually needed.
        sessionCleanupScheduler.requestCleanup('boot');

        // Backend reconciliation: for entries that locally still look
        // failed/incomplete (typically `status='failed'` chunks left
        // over from a 4xx-classified-permanent race), consult
        // `GET /sessions/:id/chunks` and reap ONLY when the backend
        // explicitly confirms the session is whole. Without this step a
        // single locally-failed chunk freezes Home on "Error" forever
        // even though the evidence IS complete server-side. The helper
        // is strict about its criterion (backend uploaded count must
        // be >= our `next_chunk_index` AND completeSession must
        // succeed or already be completed) so partial sessions are NOT
        // silently swept away. Best-effort: any I/O failure leaves the
        // entry alone for the next boot to retry.
        try {
          const { reconciled, not_reconciled } =
            await reconcileStaleSessionsWithBackend();
          if (reconciled > 0 || not_reconciled > 0) {
            console.log('GC_QUEUE recovery reconcile report', {
              reconciled,
              not_reconciled,
            });
          }
        } catch (err) {
          console.log('GC_QUEUE recovery reconcile failed', err);
        }

        // Orphan recovery scan. Detects recording files in
        // `documentDirectory` that no longer have a matching queue
        // entry — the failure mode the 2026-05-15 incident verified
        // (AsyncStorage wiped while documentDirectory survived). The
        // scan itself is read-only; any actual recovery happens later
        // when the user taps the banner CTA. Filters applied inside
        // `scanOrphans`:
        //   - prefix `guardian_recording_`
        //   - extension .aac / .m4a / .mp4 (others logged
        //     `unknown_extension`)
        //   - size > 0
        //   - age <= 7 days
        //   - not already referenced by a queue entry
        //   - audio > AUDIO_ORPHAN_MAX_BYTES surfaces as oversized
        //     (banner mentions but never recovers — protects against
        //     re-tripping CursorWindow which is the corruption that
        //     produced the orphan in the first place).
        //
        // The scan runs AFTER queue normalisation + reap + reconcile
        // so the URI comparison sees the post-recovery queue state, not
        // a transient mid-recovery view. Best-effort: scan failures are
        // logged and recovery boot continues normally.
        try {
          const orphanResult = await scanOrphans();
          if (orphanResult.orphans.length > 0) {
            setOrphanRecoverable(orphanResult.orphans);
          }
          if (orphanResult.oversized.length > 0) {
            setOrphanOversizedCount(orphanResult.oversized.length);
            for (const big of orphanResult.oversized) {
              console.log('GC_ORPHAN_RECOVERY_SKIPPED', {
                uri: big.uri,
                reason: 'too_large',
                size: big.size,
                limit: AUDIO_ORPHAN_MAX_BYTES,
              });
            }
          }
        } catch (err) {
          console.log('GC_ORPHAN_SCAN_DONE', {
            err: err instanceof Error ? err.message : String(err),
          });
        }

        // Local-first recovery: re-fire the pending-registration loop in
        // case the previous app instance died with sessions still
        // unregistered remotely. Idempotent — empty list is a no-op.
        console.log('GC_BOOT_PENDING_SESSION_REGISTRATION_START');
        runPendingRegistrationLoop().catch(err => {
          console.log('GC_LOCAL_FIRST register loop rejected (boot)', err);
        });

        const queueAtBoot = await queueRead();
        if (queueAtBoot.length > 0) {
          // NOTE: this branch USED to call `setIsRecovering(true)` here.
          // That was wrong — it blocked GRABAR during the upload drain
          // of already-closed sessions, violating the parallel-upload
          // product rule. The closing window is now gated by the
          // `closingPriorSession` flag set in Edit A and cleared in
          // Edit B above; this stretch runs AFTER the flip and may
          // overlap with a new recording the user starts in parallel.
          const pendingChunks = queueAtBoot.reduce(
            (sum, e) =>
              sum + e.chunks.filter(c => c.status === 'pending').length,
            0,
          );
          console.log('GC_QUEUE recovery start', {
            entries: queueAtBoot.length,
            pending_chunks: pendingChunks,
          });
          if (queueAtBoot[0]?.session_id) {
            AsyncStorage.setItem(
              LAST_SESSION_ID_KEY,
              queueAtBoot[0].session_id,
            ).catch(() => {});
          }
          setTestStatus(
            pendingChunks > 0
              ? `RECOVERING ${pendingChunks} chunks`
              : 'FINALIZING SESSIONS',
          );
          // Fire the worker. It self-terminates when all entries are
          // either reaped (closed + completed) or are still recording.
          console.log('GC_BOOT_UPLOAD_DRAIN_START', {
            entries: queueAtBoot.length,
            pending_chunks: pendingChunks,
          });
          uploadDrainLoop().catch(err => {
            if (DEBUG_QUEUE) {
              console.log('GC_DEBUG drain rejected (from recovery)', {
                err: err instanceof Error ? err.message : String(err),
              });
            }
          });

          // Boot-time foreground service start: if the cold boot found
          // a non-empty queue with actual pending work (chunks in
          // pending/uploading), arm the service so a subsequent
          // minimise keeps the drain alive. The service's own tick will
          // stop it via 'no_pending_work' once the queue empties.
          // Idempotent and decoupled from the recording lifecycle.
          if (pendingChunks > 0) {
            console.log('GC_BOOT_BACKGROUND_SERVICE_START', {
              pending_chunks: pendingChunks,
            });
            startBackgroundProtection({
              drain: () => uploadDrainLoop(),
              isRecordingActive: () =>
                hasActiveAudioRecording() ||
                videoProducerLive() ||
                postStopChunkingInFlightRef.current,
              hasPendingWork: hasPendingUploadWork,
              onPostNotificationsResult: (granted) =>
                setNotificationDenied(!granted),
            }).catch(err => {
              console.log('GC_BACKGROUND_UPLOAD_ERROR', {
                phase: 'boot_recovery',
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }

        // No pending state — ready for a manual Phase 1 trigger.
        setTestStatus('READY');

        // OEM diagnostics — boot-end snapshot. Read-only: captures
        // device fingerprint, the current POST_NOTIFICATIONS state,
        // both the FG-service "is alive" views (library + wrapper),
        // and what the React permissions store currently thinks. The
        // operator correlates this against the
        // `GC_BOOT_BACKGROUND_SERVICE_START` log emitted just above
        // (when boot decided to start the FG service for pending
        // chunks). Fire-and-forget IIFE so the await on
        // `checkPostNotifications` cannot delay `setIsRecovering(false)`
        // in the finally below.
        (async () => {
          try {
            console.log('GC_OEM_BG_STATUS', {
              ts: Date.now(),
              where: 'boot_end',
              post_notifications: await checkPostNotifications(),
              bg_lib_isRunning: getBackgroundLibIsRunning(),
              bg_wrapper_isRunning: isBackgroundProtectionRunning(),
              notificationDenied_store:
                usePermissionsStore.getState().notificationDenied,
              ...getOemFingerprint(),
            });
          } catch {
            /* diagnostics must never break boot */
          }
        })();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setTestStatus(`ZZ_ERROR_CATCHALL: ${message || '<no message>'}`);
        console.log('ZZ_ERROR_CATCHALL:', error);
      } finally {
        setIsRecovering(false);
      }
    })();
  }, []);

  async function startRecording() {
    perfLog('GC_PERF_START_RECORDING_ENTER');
    if (
      isStartingRef.current ||
      hasActiveAudioRecording() ||
      videoRecordPromiseRef.current
    ) {
      console.log('REC START ignored — already starting or recording');
      return;
    }
    // Haptic feedback at the moment the user commits to start. Heavy
    // impact = decisive "now" feel. Fire-and-forget; we never want
    // a vibrator stub error to block the recording flow.
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {
      /* haptics not available — ignore */
    });
    isStartingRef.current = true;

    // GC-DEV-RESET-001 (third gap) — THE DOOR.
    //
    // This is the commit point, and it sits before every irreversible
    // effect on every path: before the recorder opens (audio/legacy
    // video reach `startAudioRecording` / `recordAsync` first) and
    // before the 4A durable write (native segmented video reaches
    // `queueAppendNewSession` first). Neither ordering can slip past it.
    //
    // Returning null means a destructive dev tool currently holds
    // exclusion. Aborting HERE costs nothing — not a byte has been
    // written — which is the only reason it is acceptable to refuse a
    // capture at all. One acquire, one door; anywhere later and the
    // refusal would be destroying evidence rather than declining to
    // create it.
    //
    // The slot's lifetime is exactly `isStartingRef`'s, released in the
    // same `finally`, so it covers the window in which the capture's
    // evidence is not yet visible to `inspectResetSafety`. After 4A the
    // queue entry itself blocks a reset.
    const producerSlot: ProducerSlot | null = acquireProducerSlot('startRecording');
    if (producerSlot === null) {
      isStartingRef.current = false;
      console.log('REC START ignored — destructive operation holds exclusion');
      setTestStatus('REC START bloqueado — reset en curso');
      return;
    }

    setIsStarting(true);
    resetProgress();

    // GC-AUTH-MIGRATION-001 — the migration boundary must be decided
    // before this function writes ANYTHING durable.
    //
    // Everything below leaves signals the legacy probe reads as proof of
    // a historical identity: the GC_QUEUE entry, the history row, the
    // pending registration, the last-session id. Since 4C a capture can
    // start with no identity at all, so a fresh install whose first mint
    // failed can manufacture its own false "prior identity" — unless the
    // probe has already answered.
    //
    // The bootstrap effect starts this resolution, but React commits the
    // render before effects run, so GRABAR AHORA is tappable first. That
    // is why the guarantee lives HERE and not in the effect, and why it
    // is structural rather than a matter of timing: both callers share
    // one single-flight execution, so whichever arrives first performs
    // the probe and the seal while the other awaits the same promise.
    //
    // Local storage only — no network, no session, no token — so this
    // costs a few milliseconds and usually zero, and it can never hold a
    // recording behind a dead network.
    //
    // The property, stated exactly: before this capture creates a legacy
    // signal, migration-boundary RESOLUTION HAS RUN. It does NOT gate on
    // that resolution reaching disk — if the seal cannot be persisted
    // even after a retry, the recording proceeds anyway, because evidence
    // outranks migration hygiene. What protects the install in that case
    // is that the minting gate stays closed, not that the capture waited.
    await ensureMigrationBoundary();

    // Capture mode synchronously so it cannot change mid-flight if the
    // user somehow flips the toggle (the UI locks it, but defense in
    // depth keeps createSessionRequest, appendHistoryEntry, and the
    // recorder branch all using the same value).
    const recordingMode: SessionMode = mode;

    // Local-first: generate the UUID synchronously so EVERY downstream
    // piece (queue entry, chunker, worker) can use it from the first
    // millisecond — no waiting for the backend round-trip. Backend is
    // idempotent on (id, user_id), so the eventual POST /sessions echoes
    // the same id back; `sessionId === localSessionId` always.
    const localSessionId = Crypto.randomUUID();
    // Single-source capture of the pinned destination for THIS session.
    // See createSessionRequest's docblock for the full rationale; the
    // value flows into:
    //   1. POST /sessions (eventual)
    //   2. queueAppendNewSession (immediate)
    //   3. schedulePendingSessionRegistration on the deferred branch
    const pinnedDestinationType: DestinationType = activeDestinationType;

    // GC-AUTH-001 (4C) — a missing token no longer refuses the capture.
    //
    // This used to abort with TOKEN_MISSING_AT_START, which meant that a
    // device in IDENTITY_DEGRADED — one whose Supabase session had died
    // and which, correctly, refuses to mint a replacement identity —
    // could not record at all. Guardian Cloud's whole purpose is to get
    // evidence off the device; refusing to capture because the backend
    // cannot be reached inverts that. The backend is where evidence
    // GOES, not permission to gather it.
    //
    // Nothing is improvised to make this safe. The path was built by the
    // two preceding commits and is simply used here:
    //   4A — the recorder going live writes a durable GC_QUEUE entry
    //        before anything depends on the backend, and a zero-chunk
    //        entry can never complete or be reaped;
    //   4B — no token routes to `schedulePendingSessionRegistration`
    //        under this same `localSessionId`, with no doomed HTTP call,
    //        and the backend is idempotent on (id, user_id) so the
    //        replay after identity returns yields one row.
    // Chunks accumulate locally and the worker retries them; 401 and
    // SESSION_NOT_FOUND are both already classified transient.
    // GC-START-LATENCY-001 — THE OWNERSHIP TOKEN IS NOT READ HERE.
    //
    // It used to be, and that `await` sat on the critical path between the
    // tap and the first byte. `getOwnershipAccessToken()` goes through
    // `supabase.auth.getSession()`, which refreshes over the network once
    // the access token has expired, and NOTHING on that path carries a
    // timeout: auth-js sets none, and the fetch wrapper adds none. (Our
    // own backend client defaults to 10 s — see `src/api/client.ts`. The
    // asymmetry was the defect.) With the remote unreachable, the recorder
    // waited on a request the platform alone decided when to fail.
    //
    // The value was never needed here. Its only consumers live inside
    // `sessionCreatePromise` below, which is deliberately NOT awaited
    // before the recorder starts. Reading it there costs nothing and
    // removes an entire class of "the network decides when you may begin
    // gathering evidence" — which inverts the product.
    //
    // R5 is unaffected and travels with the read; see its docblock at the
    // new site. Nothing else moves: `ensureMigrationBoundary()` still runs
    // before any durable write, `queueAppendNewSession` still precedes the
    // producer, and the deferral path is the one 4B already built.

    // ----- KICK in PARALLEL (do NOT await — recorder doesn't need them) -----

    // (P1) Foreground service: kept idempotent and self-stabilising via
    // its predicate gate (`hasPendingWork` / `isRecordingActive`).
    //
    // Critical: the FG service's task body fires its FIRST iteration
    // immediately after `BackgroundActions.start()` resolves (the
    // `await sleep` is at the END of the loop, not the start). With
    // Phase 1 parallelization, that first tick can fall in the window
    // BEFORE the recorder is live and BEFORE `queueAppendNewSession`
    // has run — i.e. with `hasActiveAudioRecording()`/`videoRecordPromiseRef`
    // both false/null AND queue empty. Without `isStartingRef`, the
    // predicate would return false, `hasPendingWork` would return
    // false, and the service would auto-STOP via `no_pending_work`
    // before the recorder ever needs it. Including
    // `isStartingRef.current` keeps the service alive until
    // startRecording's finally block (success or error path) flips it
    // false; by then `hasActiveAudioRecording()` is either true
    // (success) or the queue / cleanup correctly indicate no work, so
    // the auto-stop semantics outside the start window are
    // byte-identical to the previous behaviour.
    console.log('GC_BACKGROUND_CALL_START_BEGIN', {
      site: 'startRecording',
      mode: recordingMode,
    });
    startBackgroundProtection({
      drain: () => uploadDrainLoop(),
      isRecordingActive: () =>
        isStartingRef.current ||
        hasActiveAudioRecording() ||
        videoProducerLive() ||
        postStopChunkingInFlightRef.current,
      hasPendingWork: hasPendingUploadWork,
      onPostNotificationsResult: (granted) =>
        setNotificationDenied(!granted),
    })
      .then(ok => {
        console.log('GC_BACKGROUND_CALL_START_RESULT', {
          site: 'startRecording',
          ok,
        });
        perfLog('GC_PERF_BACKGROUND_START_DONE', { ok });
      })
      .catch(err => {
        console.log('GC_BACKGROUND_UPLOAD_ERROR', {
          phase: 'start_recording_parallel',
          err: err instanceof Error ? err.message : String(err),
        });
        perfLog('GC_PERF_BACKGROUND_START_DONE', { ok: false });
      });

    // (P2) Backend session create: the worker's chunk POSTs need this
    // row to exist server-side, but the recorder + queue + chunker can
    // all run with `localSessionId` while we wait. The worker treats
    // SESSION_NOT_FOUND as transient (classifyError), so any chunk
    // POSTed before this resolves just back-offs and retries.
    //
    // We capture the promise so we can await it ONCE — strictly to
    // detect non-retryable errors (which today abort the start). The
    // await happens BELOW, AFTER the recorder is live, so the user
    // never waits on this network round-trip to see "Grabando".
    perfLog('GC_PERF_SESSION_CREATE_START', {
      local_session_id: localSessionId,
      destination_type: pinnedDestinationType,
    });
    const sessionCreatePromise: Promise<string> = (async () => {
      // R5 — OWNERSHIP TOKEN. `POST /sessions` creates a `sessions` row
      // keyed by (id, user_id): that is remote ownership, and it may not
      // be created before `gc.identity.v1` is durable. The gate lives
      // INSIDE `getOwnershipAccessToken`, which returns null unless the
      // marker is durable — so reading the token here leaves R5 exactly as
      // it was. The gate still closes in front of the POST, which is the
      // only thing it ever guarded; it never guarded the capture.
      //
      // GC-START-LATENCY-001 — this is the read that used to block the
      // critical path. It NEVER rejects (see its docblock): auth, storage
      // or network failure all resolve to null, which routes to the same
      // deferral below. Awaiting it here delays only the remote row.
      const token = await getOwnershipAccessToken();
      if (!token) {
        console.log('GC_LOCAL_FIRST capture without identity', {
          session_id: localSessionId,
          mode: recordingMode,
        });
      }

      // GC-AUTH-001 (4B) — do not send a request we already know will
      // come back 401. With no token there is nothing to authenticate
      // with, so the round-trip buys nothing but latency, a log line
      // and an error to re-classify. Skip straight to the durable
      // mechanism and say so plainly.
      //
      // Live since 4C removed the TOKEN_MISSING_AT_START abort: this is
      // now the ordinary path for a capture started in
      // IDENTITY_DEGRADED.
      if (!token) {
        await schedulePendingSessionRegistration(
          localSessionId,
          recordingMode,
          pinnedDestinationType,
        );
        console.log('GC_LOCAL_FIRST session deferred', {
          session_id: localSessionId,
          reason: 'no_token',
        });
        perfLog('GC_PERF_SESSION_CREATED', {
          session_id: localSessionId,
          deferred_offline: true,
        });
        return localSessionId;
      }
      try {
        const sid = await createSessionRequest(
          token,
          recordingMode,
          localSessionId,
          pinnedDestinationType,
        );
        perfLog('GC_PERF_SESSION_CREATED', {
          session_id: sid,
          deferred_offline: false,
        });
        return sid;
      } catch (err) {
        if (isRetryableSessionCreateError(err)) {
          await schedulePendingSessionRegistration(
            localSessionId,
            recordingMode,
            pinnedDestinationType,
          );
          console.log('GC_LOCAL_FIRST session deferred', {
            session_id: localSessionId,
            reason: err instanceof Error ? err.message : String(err),
          });
          perfLog('GC_PERF_SESSION_CREATED', {
            session_id: localSessionId,
            deferred_offline: true,
          });
          return localSessionId;
        }
        // Non-retryable — re-throw so the await site below can abort
        // the start cleanly (this matches today's behaviour where a
        // hard 4xx from POST /sessions prevents recording).
        throw err;
      }
    })();
    // Suppress unhandled-rejection if the recorder path errors out
    // before we ever await `sessionCreatePromise`. The actual handling
    // happens at the explicit `await sessionCreatePromise` below.
    sessionCreatePromise.catch(() => undefined);

    try {
      // ----- CRITICAL PATH — only what the recorder strictly needs -----
      console.log('REC START — manual trigger', { mode: recordingMode });

      if (!(await requestAudioPermissions())) {
        throw new Error('RECORD_AUDIO permission denied');
      }

      if (recordingMode === 'video') {
        // Camera permission is requested at GRABAR-time, not on screen
        // mount, so audio sessions never trigger this prompt.
        const cam = await requestCameraPermission();
        if (!cam.granted) throw new Error('CAMERA permission denied');
      }

      // Configure the platform audio session for recording. The full
      // set of flags (background recording, silent mode, etc.) lives
      // inside the engine — `configureAudioMode` is intentionally
      // parameter-less so the call site never needs to know which
      // platform-specific knobs are being flipped.
      await configureAudioMode();

      // Producer selection happens ONCE, here, and is remembered for the whole
      // recording. `null` for audio — audio has no video producer at all.
      const videoProducer = selectVideoProducer(
        recordingMode,
        NATIVE_SEGMENTED_VIDEO,
      );
      videoProducerRef.current = videoProducer;

      if (videoProducer === 'native-segmented') {
        // === Native segmented video: a different start ORDER ===
        //
        // Local-first, and nothing here waits on the network. Every field the
        // queue entry needs was resolved synchronously long before this point —
        // `localSessionId` at GRABAR time and `pinnedDestinationType` one line
        // later — so the entry is committed BEFORE the camera opens. That
        // ordering is not cosmetic: with `rotateAtMs` at 3 s a segment can close
        // ~4 s in, and a segment closing into a session that has no queue entry
        // yet would hit `GC_QUEUE_APPEND_CHUNK_NO_SESSION` and leave its bytes
        // outside the pipeline.
        //
        // `sessionCreatePromise` keeps running in parallel and is awaited by
        // nobody on this path; it is handed to the session module as a signal
        // and consumed once more below, purely to detect a non-retryable
        // refusal.
        sessionIdRef.current = localSessionId;
        recordingModeRef.current = recordingMode;
        AsyncStorage.setItem(LAST_SESSION_ID_KEY, localSessionId).catch(() => {});
        appendHistoryEntry({
          session_id: localSessionId,
          created_at: new Date().toISOString(),
          mode: recordingMode,
        });
        console.log('GC_QUEUE session destination pinned', {
          sessionId: localSessionId,
          destinationType: pinnedDestinationType,
        });
        await queueAppendNewSession({
          session_id: localSessionId,
          // No single growing file exists on this path: each segment is a
          // self-contained MP4 carried by its chunk's `local_uri`. Empty is
          // safe — `deleteRecordingBestEffort` returns on a falsy uri and
          // `rehydrateChunkSlice` never reads `entry.uri` for a chunk that has
          // `local_uri`.
          uri: '',
          recording_closed: false,
          // G1 — written in parallel with `recording_closed`, same value.
          // Inert: nothing reads it. See the field's docblock.
          evidence_closed: false,
          session_completed: false,
          complete_attempts: 0,
          emitted_base64_length: 0,
          next_chunk_index: 0,
          chunks: [],
          destination_type: pinnedDestinationType,
        });
        console.log('PRODUCER_SELECTED', {
          mode: recordingMode,
          producer: videoProducer,
        });

        perfLog('GC_PERF_RECORDER_START_START', { mode: 'video' });
        // Registers the three listeners and only then opens the camera.
        await getNativeSession().start(
          localSessionId,
          NATIVE_SEGMENT_OPTIONS,
          sessionCreatePromise,
        );
        perfLog('GC_PERF_RECORDER_STARTED', { mode: 'video' });
        console.log('GC_VALIDATION: SESSION_CREATED', {
          session_id: localSessionId,
          phase: 1,
          mode: recordingMode,
        });

        // The capture is live and the entry is committed, so "Grabando" is a
        // true statement about both. The remote row may still be in flight —
        // waiting for it here would hold the UI on a slow network while bytes
        // are already being captured and adopted.
        setIsRecording(true);
        perfLog('GC_PERF_UI_RECORDING_VISIBLE', {
          session_id: localSessionId,
          mode: recordingMode,
        });
        setTestStatus('REC STARTED');

        // SOLE owner of the non-retryable refusal. The session module only
        // suppresses its own drain kicks when this rejects; it never stops the
        // recorder on its own initiative. `stopRecording` is single-flight
        // through the session module, so a refusal racing a manual PARAR still
        // stops the recorder once and closes the queue at most once.
        sessionCreatePromise.catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          console.log('SESSION_CREATE_NON_RETRYABLE_ABORT', { err: message });
          setTestStatus(`ERROR REC: ${message}`);
          void stopRecording();
        });
        return;
      }

      let cacheUri: string;
      if (recordingMode === 'audio') {
        // Engine-owned: constructor + prepareToRecordAsync + record()
        // + uri capture all happen inside `startAudioRecording`. The
        // perfLog book-ends stay here because they measure the wall
        // clock of the call from the app's point of view and shouldn't
        // bleed into the engine's API surface.
        perfLog('GC_PERF_RECORDER_START_START', { mode: 'audio' });
        const recording = await startAudioRecording();
        perfLog('GC_PERF_RECORDER_STARTED', { mode: 'audio' });
        cacheUri = recording.uri;
      } else {
        // === Video branch ===
        // The CameraView is mounted by the JSX condition `mode==='video'
        // && (isStarting||isRecording)`; setIsStarting(true) above has
        // already triggered the commit, and the `await` points between
        // here and the start of startRecording have given React time to
        // run the ref callback. Poll defensively in case the mount is
        // slow (low-end devices, cold camera init).
        const tMount = Date.now();
        while (!cameraRef.current && Date.now() - tMount < 5000) {
          await new Promise(r => setTimeout(r, 50));
        }
        if (!cameraRef.current) {
          throw new Error('CAMERA_REF_NOT_READY');
        }
        // Camera hardware needs a beat to initialize before recordAsync
        // will succeed. Without this delay expo-camera silently resolves
        // recordAsync to undefined. 800ms matches the pre-flight probe.
        // (Phase 1 keeps this; reducing it requires expo-camera's
        // `onCameraReady` callback wiring — separate change.)
        await new Promise(r => setTimeout(r, 800));

        // Kick off recording. DO NOT await — the promise resolves only
        // when stopRecording() is called (returns the authoritative URI).
        console.log('VIDEO_RECORDING_OPTIONS', {
          quality: VIDEO_RECORDING_QUALITY,
          bitrate_bps: VIDEO_RECORDING_BITRATE_BPS,
          maxDuration: VIDEO_MAX_DURATION_S,
        });
        perfLog('GC_PERF_RECORDER_START_START', { mode: 'video' });
        const recordPromise = cameraRef.current.recordAsync({
          maxDuration: VIDEO_MAX_DURATION_S,
        }) as Promise<{ uri: string } | undefined>;
        videoRecordPromiseRef.current = recordPromise;
        perfLog('GC_PERF_RECORDER_STARTED', { mode: 'video' });

        // Phase 1: skip the URI discovery loop entirely. It was purely
        // diagnostic — the post-stop chunker reads from the URI the
        // recordPromise resolves with at stop, NOT from any cache scan.
        // The empty placeholder is overwritten by `queueMarkRecordingClosed`
        // at stop with the authoritative URI; this matches the existing
        // "URI discovery timed out" branch we used to fall back to.
        videoRecordingUriRef.current = null;
        cacheUri = '';
      }

      // ----- RECORDER LIVE -----
      // The native recorder is now writing samples. We do NOT flip the
      // user-visible "Grabando" yet: a throw between here and the chunker
      // setup would otherwise leave the user looking at "Grabando" while
      // the catch block tears the recorder down (regression seen in the
      // Phase-1-only ordering). Resolution: keep the recorder + queue +
      // chunker setup atomic w.r.t. the catch boundary, and only commit
      // the UI once they have all succeeded. The `await sessionCreatePromise`
      // below is typically already resolved (parallel kick at startRecording
      // entry), so the user-visible cost is dominated by the AsyncStorage
      // write of `queueAppendNewSession` (~10–30ms).

      // ----- DURABILITY BEFORE THE BACKEND (GC-AUTH-001, 4A) -----
      //
      // The queue entry used to be written only AFTER
      // `await sessionCreatePromise`. That left a window in which the
      // recorder was live, bytes were accumulating in the cache file,
      // and NOTHING durable referenced them. A non-retryable POST
      // /sessions failure aborted the start, and the capture became
      // unreachable: no queue entry, so neither the worker nor the
      // export nor `findLocalRecordingUri` could see it; and the move
      // to `documentDirectory/guardian_recording_*` — the only thing
      // `orphanScan` looks for — happens in `stopRecording`, which
      // never ran. The bytes sat in `cacheDirectory` under the
      // recorder's own name until the OS reclaimed them.
      //
      // Now the local session becomes durable the moment the recorder
      // is live. `sessionId` is `localSessionId` on every success path
      // (the deferred branch returns it verbatim, the online branch
      // echoes it back), so writing the entry with `localSessionId`
      // before the await is equivalent on the happy path — it only
      // changes what survives on the failure paths.
      sessionIdRef.current = localSessionId;
      // Pinning log — `pinnedDestinationType` was captured ONCE earlier
      // in this function so the backend `sessions.destination_type`
      // and the queue entry's `destination_type` cannot diverge under
      // a Settings race.
      console.log('GC_QUEUE session destination pinned', {
        sessionId: localSessionId,
        destinationType: pinnedDestinationType,
      });
      await queueAppendNewSession({
        session_id: localSessionId,
        uri: cacheUri,
        recording_closed: false,
        // G1 — written in parallel with `recording_closed`, same value.
        // Inert: nothing reads it. See the field's docblock.
        evidence_closed: false,
        session_completed: false,
        complete_attempts: 0,
        emitted_base64_length: 0,
        next_chunk_index: 0,
        chunks: [],
        destination_type: pinnedDestinationType,
      });
      AsyncStorage.setItem(LAST_SESSION_ID_KEY, localSessionId).catch(() => {});
      // Append to local history index (best-effort, never blocks the
      // recording flow). The index is the only source the History
      // screen has to enumerate past sessions; per-row real status is
      // still fetched live from GET /sessions/:id/chunks.
      appendHistoryEntry({
        session_id: localSessionId,
        created_at: new Date().toISOString(),
        mode: recordingMode,
      });

      // Now — and only now — resolve the backend registration.
      // Retryable failures were already converted to a deferred
      // registration inside the promise body and resolve with
      // `localSessionId`. A non-retryable 4xx still aborts the capture
      // (4A does not change that policy), but the abort has to hand the
      // bytes to the orphan route rather than walk away from them.
      //
      // Order is not negotiable here: CLOSE the recorder, THEN read the
      // uri closing produced, THEN promote, and only retire the queue
      // entry if that promotion is confirmed. Promoting while the
      // recorder is still writing would move a file out from under it.
      let sessionId: string;
      try {
        sessionId = await sessionCreatePromise;
      } catch (err) {
        console.log('SESSION_CREATE_NON_RETRYABLE_ABORT', {
          err: err instanceof Error ? err.message : String(err),
        });
        const finalUri = await closeRecorderForAbandon({
          hadAudio: recordingMode === 'audio',
          stopAudio: stopAudioRecording,
          stopCamera: () => cameraRef.current?.stopRecording(),
          videoPromise: videoRecordPromiseRef.current,
          chunkedUri: videoRecordingUriRef.current ?? cacheUri,
        });
        // The outer catch also tears the recorder down; both paths are
        // idempotent (the audio engine nulls its handle, and the video
        // branch is guarded on a ref we clear here), so the duplicate
        // teardown is a no-op rather than a double-stop.
        videoRecordPromiseRef.current = null;
        videoRecordingUriRef.current = null;
        await abandonUnregisteredSession(localSessionId, finalUri);
        throw err;
      }
      console.log('GC_VALIDATION: SESSION_CREATED', {
        session_id: sessionId,
        phase: 1,
        mode: recordingMode,
      });

      // Capture the mode for stopRecording's dispatch. Stays in a ref
      // so the value survives across the user-tap boundary without
      // relying on chunkerStates (which is empty for video under the
      // post-stop producer flow).
      recordingModeRef.current = recordingMode;

      // Producer dispatch. Logs PRODUCER_SELECTED. For audio this is a
      // no-op shim — the legacy real-time chunker below keeps driving
      // emission. For video this installs VideoFileChunkProducer and
      // wires its onChunk to the module-level videoChunkSink.
      await getController().start(recordingMode, sessionId);

      // Kick off the incremental chunker and wake the worker. Both run
      // on the JS event loop, never on the recorder thread — HC1
      // (recorder must NEVER stop because of upload failure) and HC2
      // (upload must be asynchronous) are enforced by isolation.
      //
      // Gate on audio: video uses post-stop chunking (see stopRecording
      // → controller.chunkVideoFile) and intentionally has NO live
      // chunker. The audio path is byte-identical to before this
      // milestone — same call, same arguments, same timing.
      if (recordingMode === 'audio') {
        startChunkerForSession(sessionId, cacheUri, recordingMode);
      }

      // ----- COMMIT UI: "Grabando" -----
      // Every side effect required for chunk production + queue
      // persistence is in place. The invariant we restore here is:
      // "if the user sees 'Grabando', the chunker is scheduled and the
      // session is committed to GC_QUEUE." Anything that throws above
      // unwinds via the catch BEFORE the UI was ever committed, so the
      // user sees a clean error instead of a half-started "Grabando"
      // pill that disappears.
      setIsRecording(true);
      perfLog('GC_PERF_UI_RECORDING_VISIBLE', {
        session_id: sessionId,
        mode: recordingMode,
      });
      setTestStatus('REC STARTED');

      uploadDrainLoop().catch(err => {
        if (DEBUG_QUEUE) {
          console.log('GC_DEBUG drain rejected (from startRecording)', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      setTestStatus(`ERROR REC: ${message}`);
      console.log('ERROR REC:', error);
      sessionIdRef.current = null;
      // Defensive UI reset. With the Phase-1.1 ordering, `setIsRecording(true)`
      // only runs AFTER queueAppendNewSession + chunker setup have succeeded,
      // so reaching this catch implies `isRecording` is still false — this
      // call is a no-op in the common path. We keep it as belt-and-braces
      // for any future reordering that pushes the UI commit earlier again.
      setIsRecording(false);
      // Stop and unload the audio recorder if it managed to start before
      // the error. With session create now awaited BEFORE queue/chunker
      // setup, a non-retryable POST /sessions failure can hit this branch
      // with a live audio recorder (the recorder is started on every
      // path, including offline/deferred). Cleanup keeps the OS-level
      // audio session from leaking and matches the pre-Phase-1 catch
      // semantics now that the user-visible "Grabando" was never shown.
      // `stopAudioRecording` nulls the engine handle BEFORE awaiting
      // stop(), so a throw here still leaves the engine in a clean
      // "no active recording" state — we wrap it in a best-effort
      // try/catch to match the previous swallow-and-continue semantics.
      try {
        await stopAudioRecording();
      } catch {
        /* ignore — best effort */
      }
      // Make sure no half-started video state leaks if we threw after
      // recordAsync was invoked.
      if (videoRecordPromiseRef.current) {
        try {
          cameraRef.current?.stopRecording();
        } catch {
          /* ignore */
        }
        await videoRecordPromiseRef.current.catch(() => {});
        videoRecordPromiseRef.current = null;
      }
      videoRecordingUriRef.current = null;
    } finally {
      isStartingRef.current = false;
      // Released here and only here — success, early return on the
      // native-segmented path, or a throw. By this point the 4A entry is
      // durable on every success path, so `inspectResetSafety` can see
      // the capture and takes over the protection.
      releaseProducerSlot(producerSlot);
      setIsStarting(false);
    }
  }

  async function stopRecording() {
    // Snapshot "did we have audio active" BEFORE issuing stop. The
    // engine nulls its internal handle inside `stopAudioRecording`,
    // so we cannot read `hasActiveAudioRecording()` post-stop to
    // decide which branch we were on — capture the bool up front.
    const hadAudio = hasActiveAudioRecording();
    const videoPromise = videoRecordPromiseRef.current;
    // `videoProducerLive()` rather than `videoPromise` alone: the native
    // producer never sets that ref, so without this a native session would
    // report "no active recording" and PARAR would silently do nothing.
    if (!hadAudio && !videoProducerLive()) {
      setTestStatus('ERROR REC: no active recording');
      console.log('ERROR REC: no active recording on stop');
      return;
    }
    // Success-tone haptic at the instant the user commits to stop.
    // Fire-and-forget; harmless if vibrator unavailable.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {
        /* haptics not available — ignore */
      },
    );
    const sessionId = sessionIdRef.current;

    setIsStopping(true);
    // Cover the entire post-stop window for the foreground-service
    // lifecycle predicate. Cleared in the finally below. Set BEFORE we
    // null the recorder refs so there is no observable instant where
    // both `isRecordingActive` and `hasPendingWork` are simultaneously
    // false-but-temporarily — which is what was killing the service
    // mid-`chunkVideoFile` for video sessions.
    postStopChunkingInFlightRef.current = true;

    if (videoProducerRef.current === 'native-segmented') {
      // === Native segmented stop ===
      //
      // The session module owns the entire close: it asks the recorder to stop
      // exactly once (single-flight, so a PARAR racing the non-retryable-refusal
      // abort still stops it once), waits for `onCaptureReleased` or its
      // deadline, drains every adoption registered before that event, and only
      // then reads GC_QUEUE to decide what — if anything — to persist.
      //
      // Nothing from the expo-camera tail applies: there is no single growing
      // file to move out of the cache and nothing to chunk after the fact, so
      // this path deliberately does not reach `chunkVideoFile` or the
      // `queueMarkRecordingClosed` call further down.
      try {
        setTestStatus('REC STOPPING');
        const report = await getNativeSession().stop();
        setIsRecording(false);
        console.log('GC_SEGMENT_STOP_REPORT', {
          sid_prefix: report.sessionId.slice(0, 8),
          outcome: report.outcome,
          segments_observed: report.segmentsObserved,
          observed_contiguous_from_zero: report.observedContiguousFromZero,
          adoptions_settled: report.adoptionsSettled,
          durable_chunks: report.durableChunks,
          next_chunk_index: report.nextChunkIndex,
        });
        switch (report.outcome) {
          case 'closed':
            setTestStatus(null);
            break;
          case 'no_capture':
            // Reachable by a normal user: GRABAR and PARAR in quick succession
            // ends below the preroll and no segment is ever produced.
            setTestStatus(
              'La grabación fue demasiado corta. No se guardó ninguna evidencia.',
            );
            break;
          case 'adoption_failed':
            setTestStatus('No se pudo guardar la evidencia de esta grabación.');
            break;
          case 'timeout':
            setTestStatus(
              'ERROR REC STOP: la cámara no confirmó el cierre. La evidencia se conserva y se reintenta al abrir la app.',
            );
            break;
          case 'no_entry':
            setTestStatus('ERROR REC STOP: la sesión ya no estaba en la cola.');
            break;
        }
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        setIsRecording(false);
        setTestStatus(`ERROR REC STOP: ${message}`);
        console.log('ERROR REC STOP (native):', error);
      } finally {
        sessionIdRef.current = null;
        recordingModeRef.current = null;
        videoProducerRef.current = null;
        setIsStopping(false);
        postStopChunkingInFlightRef.current = false;
        // Same conditional shutdown the expo-camera tail performs: stop the
        // service now only when both predicates are already clean, otherwise
        // leave it to its own tick, which stops on `no_pending_work`.
        (async () => {
          try {
            const stillRecording =
              hasActiveAudioRecording() ||
              videoProducerLive() ||
              postStopChunkingInFlightRef.current;
            const pending = await hasPendingUploadWork();
            if (!stillRecording && !pending) {
              await stopBackgroundProtection('rec_stopped_no_pending_work');
            }
          } catch (err) {
            console.log('GC_BACKGROUND_UPLOAD_ERROR', {
              phase: 'native_stop_in_finally',
              err: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }
      return;
    }

    let preMoveSize: number | null = null;
    let finalUri: string | null = null;
    try {
      setTestStatus('REC STOPPING');
      await new Promise(r => setTimeout(r, 50));

      let maybeUri: string | null;
      if (hadAudio) {
        // expo-audio renames `stopAndUnloadAsync` to `stop`. The native
        // implementation still flushes the file to disk before resolving,
        // so the chunker's final pass can read the completed bytes.
        // The engine returns the URI captured pre-stop and nulls its
        // own handle; any throw from native stop() propagates and is
        // caught by the outer try/catch below, exactly as before.
        maybeUri = await stopAudioRecording();
        console.log('GC_DIAG: STOP_AND_UNLOAD_RETURNED');
      } else {
        // === Video stop ===
        // 1. Tell camera to stop. recordAsync resolves with the final URI.
        try {
          cameraRef.current?.stopRecording();
        } catch (e) {
          console.log('VIDEO STOP_RECORDING THREW', e);
        }
        console.log('GC_DIAG: VIDEO_STOP_RECORDING_CALLED');

        // 2. Await the in-flight promise to capture the authoritative URI.
        let videoFinalUri: string | null = null;
        try {
          const result = await videoPromise!;
          videoFinalUri = result?.uri ?? null;
        } catch (e) {
          console.log('VIDEO RECORDASYNC REJECTED', e);
        }
        videoRecordPromiseRef.current = null;

        // 3. Cross-check against the URI the chunker has been reading.
        // The pre-flight diagnostic verified these are the same file on
        // this device. A mismatch means the chunker has been pointing at
        // a different file than the camera was writing to — surface as
        // a hard error rather than ship a corrupted session silently.
        const chunkedUri = videoRecordingUriRef.current;
        videoRecordingUriRef.current = null;
        if (videoFinalUri && chunkedUri && videoFinalUri !== chunkedUri) {
          console.log('VIDEO URI MISMATCH', { chunkedUri, videoFinalUri });
          throw new Error(
            `VIDEO_URI_MISMATCH chunker=${chunkedUri} cam=${videoFinalUri}`,
          );
        }
        // Prefer the camera's authoritative URI; fall back to the chunked
        // URI if recordAsync rejected (file is still on disk, chunker has
        // been reading partial data — better than losing the session).
        maybeUri = videoFinalUri ?? chunkedUri;
      }

      setIsRecording(false);
      if (!maybeUri) throw new Error('Recording URI is null');
      finalUri = maybeUri;

      try {
        const preInfo = await FileSystem.getInfoAsync(maybeUri);
        preMoveSize = preInfo.exists
          ? (preInfo as { size?: number }).size ?? null
          : null;
      } catch (err) {
        console.log('GC_DIAG: PRE_MOVE_INFO_FAILED', err);
      }
      console.log('GC_DIAG: REC_FILE_BEFORE_MOVE', {
        uri: maybeUri,
        exists: preMoveSize !== null,
        size: preMoveSize,
      });

      // Move the recording from cacheDirectory (volatile) to
      // documentDirectory (durable) so a kill/reboot does not let the
      // OS purge it while the worker is still draining. Best-effort:
      // any move failure leaves us reading from cache uri instead.
      if (FileSystem.documentDirectory) {
        const extMatch = maybeUri.match(/\.[A-Za-z0-9]{1,8}$/);
        const ext = extMatch ? extMatch[0] : '.m4a';
        const movedUri = `${FileSystem.documentDirectory}guardian_recording_${Date.now()}${ext}`;
        try {
          await FileSystem.moveAsync({ from: maybeUri, to: movedUri });
          finalUri = movedUri;
          console.log('REC MOVED TO DOCDIR:', finalUri);
        } catch (moveError) {
          console.log(
            'REC MOVE WARN — keeping original cacheDir uri; recovery may not survive OS purge:',
            moveError,
          );
        }
      }

      let postMoveSize: number | null = null;
      try {
        const postInfo = await FileSystem.getInfoAsync(finalUri);
        postMoveSize = postInfo.exists
          ? (postInfo as { size?: number }).size ?? null
          : null;
      } catch (err) {
        console.log('GC_DIAG: POST_MOVE_INFO_FAILED', err);
      }
      console.log('GC_DIAG: REC_FILE_READY_FOR_CHUNKING', {
        uri: finalUri,
        size: postMoveSize,
        pre_move_size: preMoveSize,
        size_matches_pre_move: postMoveSize === preMoveSize,
      });
    } catch (error) {
      // The audio engine has already nulled its handle inside
      // `stopAudioRecording` (which runs before any throw that lands
      // here), so no defensive audio cleanup is needed in this catch
      // — the engine is in a clean "no active recording" state. The
      // video refs still need resetting because the video path does
      // not have an equivalent abstraction yet.
      videoRecordPromiseRef.current = null;
      videoRecordingUriRef.current = null;
      setIsRecording(false);
      setIsStopping(false);
      const message = (error as Error).message ?? String(error);
      setTestStatus(`ERROR REC: ${message}`);
      console.log('ERROR REC:', error);
      return;
    }

    if (!sessionId) {
      setTestStatus('REC DONE — no session');
      setIsStopping(false);
      return;
    }

    try {
      // Mode dispatch for stop:
      //   - audio: legacy real-time chunker — final pass via
      //     stopChunkerForSession (UNCHANGED).
      //   - video: post-stop producer — read finalized file and emit
      //     all chunks via the registered onChunk sink. No live
      //     chunker was started in startRecording for video, so there
      //     is nothing to "stop" on that side.
      // Per the user's correction we read explicitly from `finalUri`
      // (the documentDirectory copy when the move succeeded, the
      // cache uri otherwise); `recording.getURI()` after stopAndUnload
      // + move is not reliable.
      const stopMode = recordingModeRef.current ?? 'audio';
      // Authoritative chunk count for the video path. Captured directly
      // from chunkFile's return value so a mid-emission storage error
      // (GC_QUEUE_CORRUPT_TOO_LARGE) cannot silently leave
      // next_chunk_index at 0 even after 58 chunks were really emitted.
      // null for audio, where the legacy chunker's tally in the queue
      // entry is still the source of truth.
      let videoEmittedCount: number | null = null;
      if (stopMode === 'video') {
        await getController().stop();
        videoEmittedCount = await getController().chunkVideoFile(finalUri!);
        // Diagnostic: confirms post-stop chunking finished and how many
        // chunks landed in the queue. Read by the operator alongside
        // GC_BACKGROUND_SERVICE_KEEPALIVE to verify the predicate sees
        // pending work right after this point.
        console.log('VIDEO_CHUNKS_ENQUEUED', {
          sessionId,
          count: videoEmittedCount,
        });
      } else {
        await stopChunkerForSession(sessionId, finalUri!);
        await getController().stop();
      }

      // Read the latest offsets the final pass produced and persist
      // recording_closed=true. The worker uses recording_closed +
      // chunks-all-settled to decide when to call completeSession.
      const queue = await queueRead();
      const entry = queue.find(e => e.session_id === sessionId);
      const emitted = entry?.emitted_base64_length ?? 0;
      // Audio: trust the queue (legacy chunker mutates next_chunk_index
      // through queueAppendChunk on each tick). Video: trust the count
      // returned by chunkFile — see comment above.
      const next =
        videoEmittedCount !== null
          ? videoEmittedCount
          : entry?.next_chunk_index ?? 0;
      await queueMarkRecordingClosed(sessionId, finalUri!, emitted, next);

      uploadDrainLoop().catch(err => {
        if (DEBUG_QUEUE) {
          console.log('GC_DEBUG drain rejected (from stopRecording)', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      });

      setTestStatus(null);
      console.log('GC_QUEUE recording closed', {
        sessionId,
        emitted,
        next,
        finalUri,
      });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      setTestStatus(`ERROR REC STOP: ${message}`);
      console.log('ERROR REC STOP:', error);
    } finally {
      sessionIdRef.current = null;
      recordingModeRef.current = null;
      setIsStopping(false);
      // Post-stop chunking is now done (either successfully or via the
      // catch). Drop the flag so the service-lifecycle predicate falls
      // back to its real signals: recorder refs (null by now) and the
      // queue. Chunks emitted by chunkVideoFile are already enqueued at
      // this point, so `hasPendingWork()` will correctly return true
      // and the service stays alive on KEEPALIVE 'pending_uploads'.
      postStopChunkingInFlightRef.current = false;
      // Conditional service shutdown. The foreground service must NOT
      // unconditionally stop on rec stop — chunks may still be queued
      // and the user could minimise immediately. Only stop NOW if both
      // predicates are already clean (recording inactive and queue has
      // nothing pending). Otherwise leave the service running and let
      // its own tick body stop it once the queue drains. The recorder
      // refs are nulled inside the try block above before this finally
      // runs, so isRecordingActive correctly reads false here.
      (async () => {
        try {
          const stillRecording =
            hasActiveAudioRecording() ||
            videoProducerLive() ||
            postStopChunkingInFlightRef.current;
          const pending = await hasPendingUploadWork();
          if (!stillRecording && !pending) {
            await stopBackgroundProtection('rec_stopped_no_pending_work');
          }
          // else: tick body keeps the service alive on KEEPALIVE
          // 'pending_uploads' until the queue drains, then stops with
          // 'no_pending_work'. No action needed here.
        } catch (err) {
          console.log('GC_BACKGROUND_UPLOAD_ERROR', {
            phase: 'stop_in_finally',
            err: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }
  }

  /**
   * "Video is foreground-only" clean shutdown.
   *
   * Invoked from the AppState listener when the app transitions to
   * `'background'` while a video session is live. Reuses the existing
   * `stopRecording()` pipeline — does NOT touch the recording / queue /
   * worker / recovery internals.
   *
   * Guard rails (all read via refs so the closure captured by the
   * listener at mount time always sees fresh values; mirrors how the
   * existing listener reads `videoRecordPromiseRef.current` and
   * `recordingModeRef.current`):
   *
   *   - mode must be 'video' — audio path is untouched
   *     (`configureAudioMode` allows audio in background)
   *   - `videoRecordPromiseRef.current` must be non-null — no live
   *     recording means nothing to stop (also rules out the catch
   *     path inside startRecording, which nulls the ref before the
   *     finally clears isStartingRef)
   *   - `isStartingRef.current` must be false — per the design
   *     decision we defer rather than racing the start sequence
   *   - `postStopChunkingInFlightRef.current` must be false — a
   *     user-tap-stop already in flight handles teardown itself; we
   *     skip to avoid a double-stop race
   *
   * stopRecording() is itself idempotent (`if (!hadAudio && !videoPromise)
   * return;` at top) so even if guards lapse the second call is a no-op,
   * but the explicit guards keep the log story clean: we emit
   * `VIDEO_BACKGROUND_DETECTED` only when we actually act.
   *
   * Logs (matches the spec):
   *   - VIDEO_BACKGROUND_DETECTED        — guards passed, about to stop
   *   - VIDEO_RECORDING_STOPPED_BACKGROUND — stopRecording returned
   *     (whether cleanly or via its own caught error)
   *   - VIDEO_RECORDING_CLEAN_SHUTDOWN   — UI notice set, helper done
   *
   * Sticky banner is set unconditionally on shutdown so the user always
   * gets the honest message; the auto-dismiss timer clears it after
   * VIDEO_BG_BANNER_MS.
   */
  async function stopVideoForBackground(): Promise<void> {
    // Guard 1: only fire for video sessions. Audio path is intentionally
    // untouched — `configureAudioMode` configures the audio session to
    // survive background, and `shouldPlayInBackground=true` keeps the
    // OS-level recorder alive across this same transition.
    if (recordingModeRef.current !== 'video') return;
    // Guard 2: there must actually be a live recording. The ref is the
    // single source of truth that startRecording succeeded past
    // `recordAsync()` and stopRecording has not yet captured the promise.
    if (!videoProducerLive()) return;
    // Guard 3: defer if start is still in flight. Two outcomes are both
    // acceptable per the design decision:
    //   - start succeeds → user can stop manually, OR a later background
    //     event re-fires this helper with isStartingRef false
    //   - start fails → catch path nulls the ref and the next background
    //     event sees `videoRecordPromiseRef.current === null` (Guard 2)
    //     and skips
    if (isStartingRef.current) {
      console.log('VIDEO_BACKGROUND_DETECTED', {
        deferred: true,
        reason: 'is_starting',
        ts: Date.now(),
      });
      return;
    }
    // Guard 4: skip if a user-tap-stop is already in flight. The
    // post-stop chunking flag is set at the very top of stopRecording
    // (before any await), so this guard wins the race when both a user
    // tap and a background event arrive in the same tick.
    if (postStopChunkingInFlightRef.current) return;

    // Capture session id BEFORE stopRecording's finally clears it, so
    // the post-stop logs can still correlate against the session.
    const sid = sessionIdRef.current;
    console.log('VIDEO_BACKGROUND_DETECTED', {
      session_id: sid,
      ts: Date.now(),
    });

    try {
      // Reuse the existing teardown:
      //   - cameraRef.current?.stopRecording()      → releases camera
      //   - await videoRecordPromiseRef.current     → final URI
      //   - moveAsync (cache → docDir)              → durability
      //   - getController().chunkVideoFile(uri)     → emit whatever
      //     bytes were captured before background
      //   - queueMarkRecordingClosed                → close the entry
      //     (the worker finalises the session — recovery is happy)
      //
      // The pipeline owns its own try/catch and writes any user-visible
      // error to `testStatus` via the inner catch block. If the file is
      // corrupted past chunkFile's tolerance, chunkFile throws, the
      // inner catch logs ERROR REC STOP, and the queue entry is left
      // with whatever chunks (possibly zero) reached the queue — the
      // worker / recovery still finalise the session.
      await stopRecording();
      console.log('VIDEO_RECORDING_STOPPED_BACKGROUND', {
        session_id: sid,
        ts: Date.now(),
      });
    } catch (err) {
      // Defensive: stopRecording handles its own errors internally, so
      // reaching this catch implies a throw from an unexpected layer
      // (e.g. a setState-after-unmount race on the host component
      // tearing down). Mark the marker log so the operator can
      // distinguish a clean shutdown from this rare exceptional path.
      console.log('VIDEO_RECORDING_STOPPED_BACKGROUND', {
        session_id: sid,
        ts: Date.now(),
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Surface the honest message to the user. The banner auto-dismisses
    // after VIDEO_BG_BANNER_MS via the paired effect above.
    setVideoBackgroundStopAt(Date.now());
    console.log('VIDEO_RECORDING_CLEAN_SHUTDOWN', {
      session_id: sid,
      ts: Date.now(),
    });
  }

  /**
   * Orphan recovery — one file at a time.
   *
   * Reconstructs the minimal queue entry the worker needs to drain a
   * recording file that lost its row when AsyncStorage was wiped
   * externally. The flow is byte-equivalent to the post-stop tail of
   * `stopRecording`:
   *
   *   1. queueAppendNewSession  — inject the entry with a fresh
   *                                synthetic session_id, the
   *                                orphan's URI, and the currently
   *                                pinned destination
   *   2. appendHistoryEntry     — surface the recovered session in
   *                                the History screen
   *   3. createSessionRequest   — register the session backend-side.
   *                                On retryable failure (offline,
   *                                5xx, abort) defer via
   *                                `schedulePendingSessionRegistration`
   *                                — the same offline-first path
   *                                normal recordings already use
   *   4. runChunkerTick (final) — dispatch on mode:
   *                                  audio → runAudioChunkerTick
   *                                  video → runVideoChunkerTick
   *                                Both read the finalized file and
   *                                emit chunks via queueAppendChunk
   *   5. queueMarkRecordingClosed — flip recording_closed=true with
   *                                the chunker's authoritative count
   *   6. uploadDrainLoop        — kick the worker (single-flight,
   *                                no-op if already running)
   *
   * Zero new pipeline: every step reuses an existing entry-point. The
   * worker, recovery cross-device, export, manifests, AudioEngine and
   * backgroundService are untouched.
   *
   * The original session_id from when the file was first written is
   * UNRECOVERABLE — it lived in the queue row that was wiped. We
   * generate a fresh UUID. Backend sees a brand-new session, not a
   * continuation. Server-side chunks from the lost session (if any
   * reached the backend before the wipe) are orphaned under the old
   * session_id but that is an accepted tradeoff per the
   * "evidencia fuera del dispositivo ASAP" invariant — better a
   * second copy than no copy.
   */
  async function recoverOneOrphan(orphan: OrphanFile): Promise<void> {
    // Defensive: re-check duplicate at handler time. The scan already
    // filtered against the queue at boot, but a parallel session could
    // have created an entry pointing at the same URI in the
    // milliseconds between scan and tap (unlikely but free to guard).
    const existing = await queueRead();
    if (existing.some(e => e.uri === orphan.uri)) {
      console.log('GC_ORPHAN_RECOVERY_SKIPPED', {
        uri: orphan.uri,
        reason: 'already_in_queue_race',
      });
      return;
    }

    const sessionId = Crypto.randomUUID();
    // Snapshot the destination AT TAP TIME. Same single-source-capture
    // rule `startRecording` follows (see `pinnedDestinationType` at
    // GRABAR-time): once the entry is created, every chunk for this
    // session uploads to this destination, even if the user flips the
    // Settings preference mid-recovery.
    const pinnedDestinationType: DestinationType = activeDestinationType;

    // Step 1: inject queue entry with `recording_closed=false` so the
    // chunker (called below) treats it as a live session and emits
    // chunks. We flip the flag to true in step 5 once chunking finished.
    await queueAppendNewSession({
      session_id: sessionId,
      uri: orphan.uri,
      recording_closed: false,
      // G1 — written in parallel with `recording_closed`, same value.
      // Inert: nothing reads it. See the field's docblock.
      evidence_closed: false,
      session_completed: false,
      complete_attempts: 0,
      emitted_base64_length: 0,
      next_chunk_index: 0,
      chunks: [],
      destination_type: pinnedDestinationType,
    });

    // Step 2: local history index. The History screen enumerates
    // sessions from this index, so an orphan that successfully recovers
    // should appear there alongside normal recordings. Created-at is
    // "now" — we deliberately do NOT use the file's mtime because
    // History sorts by created_at and an old orphan would push to the
    // bottom; the user just tapped Recover, they expect the session
    // near the top.
    appendHistoryEntry({
      session_id: sessionId,
      created_at: new Date().toISOString(),
      mode: orphan.mode,
    });

    // Step 3: backend registration. Reuses the existing
    // createSessionRequest helper; on retryable failure (offline /
    // 5xx / abort) we defer via schedulePendingSessionRegistration,
    // identical to startRecording's deferred-registration branch.
    // Non-retryable 4xx errors propagate to the catch below — recovery
    // for that orphan is abandoned and the file stays on disk for a
    // future attempt.
    //
    // R5 — OWNERSHIP TOKEN, for the same reason as startRecording: this
    // path also ends in `createSessionRequest`. A null answer takes the
    // deferral branch immediately below, which already exists.
    const token = await getOwnershipAccessToken();
    try {
      if (!token) {
        // GC-AUTH-001 (4B) — this used to be a sentinel
        // `throw new Error('no_token')`, which reached the deferred
        // branch only because that string happens not to match the
        // `HTTP (\d{3})` probe in `isRetryableSessionCreateError`.
        // Correct behaviour resting on a regex miss is a trap for
        // whoever edits that classifier next, so state it directly —
        // and skip a request that could only ever come back 401.
        await schedulePendingSessionRegistration(
          sessionId,
          orphan.mode,
          pinnedDestinationType,
        );
        console.log('GC_LOCAL_FIRST session deferred', {
          session_id: sessionId,
          reason: 'no_token',
        });
      } else {
        await createSessionRequest(
          token,
          orphan.mode,
          sessionId,
          pinnedDestinationType,
        );
      }
    } catch (err) {
      if (isRetryableSessionCreateError(err)) {
        await schedulePendingSessionRegistration(
          sessionId,
          orphan.mode,
          pinnedDestinationType,
        );
        // Recovery still proceeds — the worker will retry registration
        // via the pending-registration loop once the network is back.
      } else {
        // Non-retryable: abandon this orphan. Leave the queue entry in
        // place — the worker may eventually time it out — but more
        // importantly leave the file on disk so the next boot can
        // try again.
        console.log('GC_ORPHAN_RECOVERY_SKIPPED', {
          uri: orphan.uri,
          reason: 'session_create_failed',
          err: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    // Step 4: chunk the file. runChunkerTick dispatches on mode and
    // both branches (audio + video) emit chunks for the entire file
    // when `finalPass=true` against a fresh entry (chunks=[],
    // next_chunk_index=0). This is identical to what stopRecording
    // runs at the end of every normal recording.
    try {
      await runChunkerTick(sessionId, orphan.uri, /*finalPass*/ true, orphan.mode);
    } catch (err) {
      console.log('GC_ORPHAN_RECOVERY_SKIPPED', {
        uri: orphan.uri,
        reason: 'chunk_error',
        err: err instanceof Error ? err.message : String(err),
      });
      // The queue entry exists but is empty/partial. The worker will
      // still try to upload whatever chunks landed (could be zero) and
      // either complete the session as zero-chunk or fail-permanent.
      // Either way the file stays on disk and the next boot may
      // re-surface it as an orphan — best-effort survival.
      return;
    }

    // Step 5: flip recording_closed=true with the authoritative
    // emission tally read straight from the queue (the chunker
    // mutated `next_chunk_index` and `emitted_base64_length` during
    // step 4).
    const finalQueue = await queueRead();
    const entry = finalQueue.find(e => e.session_id === sessionId);
    const emitted = entry?.emitted_base64_length ?? 0;
    const next = entry?.next_chunk_index ?? 0;
    await queueMarkRecordingClosed(sessionId, orphan.uri, emitted, next);

    console.log('GC_ORPHAN_RECOVERY_ENQUEUED', {
      uri: orphan.uri,
      new_session_id: sessionId,
      mode: orphan.mode,
      chunks_emitted: next,
    });

    // Step 6: kick the worker. Fire-and-forget; uploadDrainLoop is
    // single-flight so a redundant call while already draining is a
    // harmless no-op. The catch keeps unhandled rejections from being
    // silently swallowed.
    uploadDrainLoop().catch(err => {
      if (DEBUG_QUEUE) {
        console.log('GC_DEBUG drain rejected (from orphan recovery)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * Orphan recovery — serial driver.
   *
   * Iterates `orphanRecoverable` one entry at a time. The serial mode
   * is intentional: the audio chunker stores `base64Slice` inline in
   * the queue JSON, so two orphans recovering in parallel could push
   * the persisted value past SQLite CursorWindow (~2 MB per row) and
   * trip the very corruption this whole feature was built to mitigate.
   * Single-flight also avoids race conditions on `queueMutate`'s
   * write-chain and respects the project's single-flight architecture
   * (`uploadDrainLoop`, `writeChain`, etc.).
   *
   * `orphanBusy` blocks re-entrancy from double-taps on the banner
   * CTA. `orphanProgress` drives the banner copy
   * ("Recuperando evidencia 2/3…") so the user has feedback that
   * something is happening on a multi-orphan recovery.
   *
   * Banner state is cleared at the end whether or not every orphan
   * succeeded — the per-orphan logs in `recoverOneOrphan` carry the
   * detail, and the user has no actionable choice for a failed
   * orphan (the file stays on disk; next boot's scan re-surfaces it).
   */
  async function handleRecoverOrphans(): Promise<void> {
    if (orphanBusy) return;
    if (orphanRecoverable.length === 0) return;

    setOrphanBusy(true);
    const list = orphanRecoverable;
    setOrphanProgress({ current: 0, total: list.length });

    try {
      for (let i = 0; i < list.length; i++) {
        // `noUncheckedIndexedAccess` treats `list[i]` as possibly
        // undefined. The loop bound guarantees a value; the explicit
        // guard preserves that invariant without a non-null assertion
        // and bails defensively if the array was mutated underneath
        // (which it should not be — `list` is a local snapshot).
        const orphan = list[i];
        if (!orphan) continue;
        setOrphanProgress({ current: i + 1, total: list.length });
        await recoverOneOrphan(orphan);
      }
    } finally {
      setOrphanProgress(null);
      setOrphanBusy(false);
      // Clear the banner. Oversized count is cleared too because the
      // user already saw the notice; surfacing it again on every
      // subsequent screen entry would be noisy. The next cold boot
      // re-scans and re-surfaces any orphans still present (including
      // oversized) so nothing is lost.
      setOrphanRecoverable([]);
      setOrphanOversizedCount(0);
    }
  }

  // UI-only mirror of the upload queue progress. Polls every 500ms while
  // the user-perceived flow is active (recording, recovering, or stopping
  // — the worker may still be draining after STOP). The worker itself is
  // module-scope and never touches React state, so polling is the cheapest
  // way to keep "N / M chunks uploaded" honest without adding an event bus.
  //
  // Runs continuously while the screen is mounted — NOT gated on
  // isRecording/isStopping/isRecovering. Previously the gate caused a
  // real bug: when stopRecording's `finally` flipped isStopping=false,
  // the effect cleanup killed polling while the worker was still
  // draining in background, so the counter froze mid-progress (e.g.
  // "5/10" while the queue was already at 10/10 and reaped). Always-on
  // polling makes the UI strictly derived from the persisted queue, so
  // recovery, app restart, network loss and post-stop background drain
  // are all reflected without extra coordination.
  //
  // Cost: one AsyncStorage.getItem every 500 ms — sub-millisecond on
  // the native side, no measurable impact when truly idle.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const q = await queueRead();
        // Drive the visible counters from the MOST RECENT session only
        // (last element appended to the queue). Older sessions still
        // draining are surfaced separately via `backgroundSessions` so
        // their progress does not leak into "Subiendo evidencia (X / Y)"
        // and confuse the user about which clip they just recorded.
        // `queueAppendNewSession` is `q.push(entry)` (or in-place
        // replace), so insertion order = creation order; the last
        // element is the authoritative "current" session.
        const current = q.length > 0 ? q[q.length - 1] : null;
        let total = 0;
        let confirmedOffDevice = 0;
        let active = 0;
        let failed = 0;
        let firstFailedError: QueueChunk['last_error'] | null = null;
        // Defaults to false: with no current entry there is no closed
        // capture to report, and false is the branch that refuses to
        // print a denominator.
        let closed = false;
        if (current) {
          closed = current.recording_closed;
          total = current.chunks.length;
          for (const c of current.chunks) {
            // PROOF, not queue status. `isChunkConfirmedOffDevice`
            // also requires a real `remote_reference`, so a chunk left
            // at `uploaded` with none — the
            // `DRIVE_CHUNK_UPLOAD_ENABLED=false` rollback, or a legacy
            // entry — is never counted towards a protection claim.
            // `total` stays the full chunk count, so such a chunk
            // shows as a gap in the denominator rather than vanishing.
            if (isChunkConfirmedOffDevice(c)) confirmedOffDevice += 1;
            // Deliberately a separate `if`, not `else if`: an
            // `uploaded` chunk without a reference is neither
            // confirmed nor active nor failed. It is simply not
            // counted anywhere — A-2 only suppresses unprovable
            // claims, it never reclassifies a chunk or touches the
            // error surface.
            if (c.status === 'pending' || c.status === 'uploading') active += 1;
            else if (c.status === 'failed') {
              failed += 1;
              if (firstFailedError === null && c.last_error) {
                firstFailedError = c.last_error;
              }
            }
          }
        }
        const background = Math.max(0, q.length - 1);

        // Background-session aggregates. Walk q[0..n-2] (everything
        // except the "current" session) and count chunks of entries
        // that still have at least one `pending` / `uploading` chunk.
        // Sessions whose chunks are 100% uploaded but not yet reaped
        // are NOT counted here — they are already announced via the
        // per-session detection below as a protected event.
        let bgActiveSessions_ = 0;
        let bgUploaded_ = 0;
        let bgTotal_ = 0;
        for (let i = 0; i < q.length - 1; i++) {
          const entry = q[i];
          if (!entry) continue;
          const t = entry.chunks.length;
          if (t === 0) continue;
          let u = 0;
          let hasActive = false;
          for (const c of entry.chunks) {
            // Same proof standard as the current session: this count
            // is rendered to the user as "(X / Y)" on the background
            // pill, so it may not be built from queue status alone.
            if (isChunkConfirmedOffDevice(c)) u += 1;
            if (c.status === 'pending' || c.status === 'uploading') hasActive = true;
          }
          if (hasActive) {
            bgActiveSessions_ += 1;
            bgUploaded_ += u;
            bgTotal_ += t;
          }
        }

        // Per-session protected detection. Walk the WHOLE queue and
        // stamp `protectedShownAt` once for every entry that is CLOSED
        // and fully confirmed off-device — guarded by a Set so we never
        // re-stamp the same session_id. The first poll tick seeds the
        // set silently so a recovered queue with already-finished
        // entries does not flash a stale banner at boot.
        //
        // Two conditions beyond "all known chunks uploaded", both
        // required, neither implied by the other:
        //
        //   - `recording_closed` — an OPEN session can still emit more
        //     chunks. During an audio capture the worker routinely
        //     catches up with the producer for a tick or two, and
        //     without this gate that transient tie fired the green
        //     "Evidencia protegida / Guardada fuera de tu móvil"
        //     banner mid-recording.
        //   - a real `remote_reference` on every chunk — the proof the
        //     bytes exist somewhere that is not this phone. Same test
        //     the export path already applies.
        //
        // Both live in `isEntryFullyProtected`, which delegates the
        // closed-and-complete arithmetic to the same `isProtectedTally`
        // that `deriveGuardianStatus` uses, so the banner and the main
        // status cannot drift apart.
        const newlyProtected: string[] = [];
        for (const entry of q) {
          if (!isEntryFullyProtected(entry)) continue;
          if (seenProtectedSessionIdsRef.current.has(entry.session_id)) continue;
          seenProtectedSessionIdsRef.current.add(entry.session_id);
          if (!firstPollTickRef.current) newlyProtected.push(entry.session_id);
        }
        firstPollTickRef.current = false;

        if (!cancelled) {
          setTotalCount(total);
          setConfirmedOffDeviceCount(confirmedOffDevice);
          setActiveCount(active);
          setFailedCount(failed);
          setRecordingClosed(closed);
          // Stable-update guard so the 500ms tick does not allocate a
          // fresh state reference (and force a re-render) when the
          // underlying error has not changed. Two values are equal when
          // they have the same status + code; the `message` field is
          // operator detail and may vary token-by-token between retries.
          setLastFailedError(prev => {
            if (failed === 0 || !firstFailedError) return null;
            if (
              prev &&
              prev.status === firstFailedError.status &&
              prev.code === firstFailedError.code
            ) {
              return prev;
            }
            return firstFailedError;
          });
          setBackgroundSessions(background);
          setBgActiveSessions(bgActiveSessions_);
          setBgUploaded(bgUploaded_);
          setBgTotal(bgTotal_);
          if (newlyProtected.length > 0) {
            // One stamp per tick is enough — the banner is generic, so
            // detecting any number of completions in this tick collapses
            // to a single sticky moment.
            setProtectedShownAt(Date.now());
            console.log('GC_LOCAL_FIRST per-session protected', {
              session_ids: newlyProtected,
            });
          }
          // Operator/debug line. Uses the same confirmed count as every
          // user-facing claim so the two can never tell the operator
          // different stories about the same session.
          if (total > 0 && confirmedOffDevice === total) {
            setTestStatus(prev =>
              prev !== null &&
              (prev.startsWith('PHASE 1 DONE') || prev.startsWith('READY'))
                ? prev
                : `UPLOADED ${confirmedOffDevice} / ${total}`,
            );
          }
        }
      } catch (err) {
        console.log('GC_QUEUE poll error', err);
      }
    };
    tick();
    const id = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ----- Background lifecycle observability -----
  //
  // Pure observation + a single corrective action: when the app returns
  // to foreground, kick the upload worker explicitly so any backlog the
  // OS may have left behind starts draining immediately. The listener
  // does NOT stop the foreground service: that lifecycle is owned by
  // `backgroundService.ts` and gated on real work (recording active or
  // pending uploads), NOT on app foreground/background transitions.
  // Stopping the service here would break the
  //   start → minimise → restore → minimise
  // pattern: the second minimise would have no protection at all.
  //
  // Logs:
  //   GC_BACKGROUND_STATE_CHANGE       — every transition
  //   GC_BACKGROUND_RECORDING_CONTINUE — going to bg with recorder live
  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      const wasRecording =
        hasActiveAudioRecording() || videoProducerLive();
      console.log('GC_BACKGROUND_STATE_CHANGE', {
        next: nextState,
        recording: wasRecording,
      });
      if (nextState !== 'active' && wasRecording) {
        console.log('GC_BACKGROUND_RECORDING_CONTINUE', {
          mode: recordingModeRef.current,
          session_id: sessionIdRef.current,
        });
      }

      // GC-AUTH-001 — auth-js expects React Native hosts to drive the
      // refresh ticker from AppState; on this platform it starts it
      // itself only via `document.visibilityState`, which does not
      // exist here. `autoRefreshToken: true` alone therefore never
      // started a ticker at all, leaving every refresh to happen lazily
      // inside whichever `getSession()` happened to notice the token had
      // aged past the 90s expiry margin.
      //
      // Reusing this listener rather than adding one: it is already
      // mount-once (`[]` deps) with `sub.remove()` on unmount, so no
      // duplicate registration is possible. `_startAutoRefresh()` also
      // stops any existing ticker before creating one, so repeated
      // 'active' transitions cannot leave two timers running.
      void (nextState === 'active'
        ? supabase.auth.startAutoRefresh()
        : supabase.auth.stopAutoRefresh()
      ).catch(() => {
        /* refresh scheduling is best-effort; never break the handler */
      });

      // A device that booted into IDENTITY_DEGRADED has no session and
      // will not mint one. Coming back to the foreground is the natural
      // moment to ask again — a `getSession()` that failed on a dead
      // network may well succeed now. No minting happens here either:
      // this only observes, and `onAuthStateChange` does the rest.
      if (nextState === 'active') {
        void supabase.auth
          .getSession()
          .then(({ data, error }) => {
            if (!data.session) {
              console.log('GC_IDENTITY_RESUME_PROBE', {
                recovered: false,
                error_name: error?.name ?? null,
              });
            }
          })
          .catch(() => {
            /* diagnostics must never break the AppState handler */
          });
      }
      // Video is foreground-only (honest mode). If the app went to
      // background during a video session, run a clean shutdown so the
      // user gets a real verdict instead of a "Grabando" pill on a dead
      // recorder. Strict `nextState === 'background'` (NOT 'inactive')
      // to avoid stopping on transient interruptions — system picker,
      // control center, brief permission prompts — which only push us
      // to 'inactive' and back. 'background' is the durable signal.
      //
      // Audio path is intentionally untouched here. The audio engine
      // configures `shouldPlayInBackground=true` /
      // `allowsBackgroundRecording=true`; the foreground service keeps
      // the JS runtime alive; the queue keeps draining. Nothing changes
      // for audio across this transition.
      //
      // The helper has its own guards (mode/recording/starting/stopping)
      // and falls through silently when they fail. Errors are logged
      // inside the helper; this top-level catch defends only against an
      // unrelated throw from the promise chain itself (e.g. setState
      // after unmount during shutdown).
      if (nextState === 'background') {
        stopVideoForBackground().catch(err => {
          console.log('VIDEO_BACKGROUND_STOP_FAILED', {
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      if (nextState === 'active') {
        // Recovery-first: if the cold-boot destinations check failed
        // (offline at app open) `destinationResolved` stays false and
        // `uploadDrainLoop` short-circuits at its race-guard. Without
        // a retry trigger, the only escapes are a full app restart or
        // a Settings toggle (which fires the preference subscription).
        // Foreground entry is the natural moment to re-attempt — the
        // user is back on the device and the network is likely back
        // too. `refreshDestination` is idempotent: a healthy boot
        // makes this a cheap no-op (it just re-confirms the same
        // value that's already resolved). When the retry succeeds it
        // re-kicks the drain itself, so we still call drain below to
        // cover the common already-resolved case in one branch.
        if (!destinationResolved) {
          refreshDestination();
        }
        // Foreground kick: drain anything that piled up while we were
        // paused. uploadDrainLoop is single-flight, so a redundant call
        // while already draining is a harmless no-op.
        uploadDrainLoop().catch(err => {
          if (DEBUG_QUEUE) {
            console.log('GC_DEBUG drain rejected (foreground kick)', {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        });

        // OEM diagnostics — foreground-resume snapshot. Same payload
        // shape as the boot-end variant; lets the operator see whether
        // the POST_NOTIFICATIONS state has shifted between cold boot
        // and the user coming back to the app (hypothesis A: user
        // granted the permission in system Settings while the app was
        // backgrounded; hypothesis B: OEM permission propagation
        // delay). Fire-and-forget IIFE — must not block the AppState
        // handler or the drain kick above.
        //
        // If the React store still reports the notification as denied
        // but the runtime check now says granted, also emit
        // GC_OEM_BG_DELAYED_READY. That second log is the smoking gun
        // for "store stale after Settings grant" (hypothesis A). We
        // do NOT call setNotificationDenied here — the rule is
        // diagnose-only. The fix lands in a separate pass once we
        // have device evidence.
        (async () => {
          try {
            const postNotif = await checkPostNotifications();
            const storeBlocked =
              usePermissionsStore.getState().notificationDenied;
            console.log('GC_OEM_BG_STATUS', {
              ts: Date.now(),
              where: 'foreground_resume',
              post_notifications: postNotif,
              bg_lib_isRunning: getBackgroundLibIsRunning(),
              bg_wrapper_isRunning: isBackgroundProtectionRunning(),
              notificationDenied_store: storeBlocked,
              ...getOemFingerprint(),
            });
            if (storeBlocked && postNotif === 'granted') {
              console.log('GC_OEM_BG_DELAYED_READY', {
                ts: Date.now(),
                reason: 'store_says_blocked_but_perm_granted',
                notificationDenied_store: true,
                post_notifications: 'granted',
                ...getOemFingerprint(),
              });
            }
          } catch {
            /* diagnostics must never break the AppState handler */
          }
        })();
      }
    });
    return () => sub.remove();
  }, []);

  const isBusy = isStarting || isStopping || isRecovering;
  // Mutually-exclusive phase, derived strictly from queue + recorder
  // state. Order matters: a live recording dominates everything; pending
  // upload work dominates "Listo"; only with an empty/settled queue do
  // we show "Listo". This guarantees "Listo" can never coexist with a
  // visible "Subiendo evidencia (X/Y)" — the contradiction the user saw.
  // Single source of truth for the visible status — derived purely from
  // the same queue counters and recorder flags above. The UI does NOT
  // own this decision; it only renders the result. See
  // `deriveGuardianStatus` for the precedence rules.
  const guardianStatus = deriveGuardianStatus({
    isRecording,
    isRecovering,
    isStarting,
    isStopping,
    totalCount,
    confirmedOffDeviceCount,
    activeCount,
    failedCount,
    recordingClosed,
  });
  const hasPendingUploads = guardianStatus === 'subiendo';

  // ----- "Evidencia protegida" sticky banner (UI-only) -----
  //
  // When the derived status enters 'protegido', stamp the moment and
  // schedule a clear after PROTECTED_BANNER_MS so the visual lingers
  // even after the system has reaped the entry and returned to 'listo'.
  // We deliberately do NOT change `guardianStatus`, `phaseLabel` or
  // `phaseColor` — the system's truth is unchanged. Only the banner
  // below reads `protectedShownAt`.
  const PROTECTED_BANNER_MS = 4_000;
  useEffect(() => {
    if (guardianStatus === 'protegido') {
      setProtectedShownAt(Date.now());
    }
  }, [guardianStatus]);
  // Warning haptic on entering the `error` phase. Mirrors the Heavy
  // impact on start (line 3932) and the Success notification on stop
  // (line 4325) so the user feels a consistent triple — start, stop,
  // problem — without having to look at the screen. Fires once per
  // transition: the effect only re-runs when `guardianStatus` actually
  // changes, so a long-lived error pill stays haptic-silent. No queue,
  // worker, recovery or chunking touched.
  useEffect(() => {
    if (guardianStatus === 'error') {
      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Warning,
      ).catch(() => {
        /* haptics not available — ignore */
      });
    }
  }, [guardianStatus]);
  useEffect(() => {
    if (protectedShownAt === null) return;
    const elapsed = Date.now() - protectedShownAt;
    const remaining = Math.max(0, PROTECTED_BANNER_MS - elapsed);
    const timer = setTimeout(() => {
      // Guard against a newer 'protegido' restamp racing with this fire.
      setProtectedShownAt(prev => (prev === protectedShownAt ? null : prev));
    }, remaining);
    return () => clearTimeout(timer);
  }, [protectedShownAt]);
  // Auto-dismiss for the "video se detuvo por background" notice. Same
  // shape as the `protectedShownAt` timer above. 5_000ms gives the user
  // one extra second over the protected banner to register the message
  // (it carries information the user may not have expected). The guard
  // against a newer stamp racing with the timer fires is identical.
  const VIDEO_BG_BANNER_MS = 5_000;
  useEffect(() => {
    if (videoBackgroundStopAt === null) return;
    const elapsed = Date.now() - videoBackgroundStopAt;
    const remaining = Math.max(0, VIDEO_BG_BANNER_MS - elapsed);
    const timer = setTimeout(() => {
      setVideoBackgroundStopAt(prev =>
        prev === videoBackgroundStopAt ? null : prev,
      );
    }, remaining);
    return () => clearTimeout(timer);
  }, [videoBackgroundStopAt]);
  // The banner is independent of the current session's status: when
  // ANY session completes (current OR background) we want the user to
  // see the protected moment, even if other sessions are still
  // uploading. The 4-second sticky timer is the only thing that hides
  // it; concurrent "Subiendo evidencia (X / Y)" on the dot/label below
  // is fine because they describe DIFFERENT sessions. Visibility is
  // strictly time-bounded, never reads back into any logic, and never
  // contradicts the system's truth — `guardianStatus` keeps its meaning
  // and `deriveGuardianStatus` is unchanged.
  const showProtectedBanner = protectedShownAt !== null;
  const showVideoBackgroundStop = videoBackgroundStopAt !== null;
  // The main label states the PHASE only — it makes no claim about how
  // much evidence is outside the device. That claim is a separate fact
  // and lives on its own line below (`phaseSubLabel`), derived by
  // `deriveProtectionStatement`. Collapsing the two is GC-AUD-004: the
  // previous `subiendoLabel` said "Protegiendo evidencia" while
  // `confirmedOffDeviceCount === 0`, i.e. while nothing was protected
  // at all.
  const phaseLabel =
    guardianStatus === 'grabando'
      ? 'Grabando'
      : guardianStatus === 'iniciando'
        ? 'Iniciando grabación…'
        : guardianStatus === 'subiendo'
          ? 'Subiendo evidencia'
          : guardianStatus === 'recuperando'
            ? 'Cerrando grabación anterior…'
            : guardianStatus === 'protegido'
              ? 'Protegido'
              : guardianStatus === 'error'
                ? 'Error'
                : 'Listo';
  // Secondary line: how much evidence is CONFIRMED outside the device.
  // Rendered as its own centred Text beneath the main label so the
  // dot/label row never has to wrap a long string. All the semantics
  // live in the pure function — the screen only renders what it
  // returns, and renders nothing when it returns null.
  const phaseSubLabel: string | null = deriveProtectionStatement({
    status: guardianStatus,
    confirmedOffDeviceCount,
    totalCount,
    recordingClosed,
  });
  const phaseColor =
    guardianStatus === 'grabando'
      ? '#ff4d4d'
      : guardianStatus === 'iniciando'
        ? '#58a6ff'
        : guardianStatus === 'subiendo' || guardianStatus === 'recuperando'
          ? '#f0b400'
          : guardianStatus === 'error'
            ? '#f85149'
            : '#3ddc84';

  // Destination gate. We never block a STOP — even with no destination,
  // a running recording must always be stoppable. The block only applies
  // to starting a new recording.
  const hasDrive = drive !== null && drive !== undefined;
  const driveCheckLoading = drive === null;
  // Local-first product rule: lack of network MUST NOT block recording
  // start — only `drive === undefined` (the destinations check returned
  // an empty list, i.e. the user really has no destination configured)
  // disables GRABAR. `drive === null` (transient/offline/loading) lets
  // the user record; chunks queue locally and the worker uploads when
  // the network returns.
  const driveConfirmedMissing = drive === undefined;
  const showStop = isRecording || isStopping;
  // Disable GRABAR when destinations check confirms the user has none.
  // Never disable PARAR.
  const buttonDisabled = showStop
    ? isStopping
    : isStarting || isBusy || driveConfirmedMissing;
  // "GRABAR AHORA" replaces the prior "GRABAR" copy: the panic-flow
  // language reduces friction at start by signalling immediacy. The
  // underlying handler is unchanged — same `startRecording` path.
  const buttonLabel = showStop ? 'PARAR' : 'GRABAR AHORA';
  const buttonBg = showStop ? '#d73a49' : '#1f6feb';

  // Auto-trigger the quick-start countdown on a returning-user cold
  // start when the panic preference is armed and nothing else is
  // running. Placed AFTER `showStop` / `buttonDisabled` /
  // `guardianStatus` are defined so the deps array is in scope. Fires
  // exactly once per mount: `countdownDispatchedRef` blocks re-runs
  // even if the dependency array oscillates while loading.
  useEffect(() => {
    if (countdownDispatchedRef.current) return;
    if (!quickStartEnabled) return;
    if (welcomeStatus !== 'returning-user') return; // first install / loading
    if (showBetaWelcome) return; // modal currently visible
    if (showStop) return; // already recording / stopping
    if (buttonDisabled) return; // isStarting / isBusy / no destination
    if (guardianStatus === 'error') return;
    startCountdown();
  }, [
    quickStartEnabled,
    welcomeStatus,
    showBetaWelcome,
    showStop,
    buttonDisabled,
    guardianStatus,
  ]);

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: '#0d1117',
      }}
    >
      {/* Hide Expo Router's default header for the home route. Other
          routes (settings, session/[id]) keep their default header so
          the back button continues to work. Per-screen override is the
          documented Expo Router pattern. */}
      <Stack.Screen options={{ headerShown: false }} />

      {/* Hidden CameraView — mounted ONLY during a video session so
          audio recordings never spin up the camera. The recordAsync()
          call in startRecording writes to a growing .mp4 in
          cacheDirectory; the chunker reads slices from it the same way
          it reads the audio cache file.

          Why the wrapper View (and not inline styles on CameraView):

          On release APK builds, the Android `TextureView` that backs
          expo-camera's CameraView allocates its drawing Surface at the
          camera's preferred preview size (full-width × ~16:9) before
          the React Native layout pass commits the inline `width: 1`
          /`height: 1` styles. The Surface renders black until the first
          camera frame arrives, leaving a visible black band at the
          bottom of the screen. In dev / Expo Go this is intermittent
          because additional layout passes re-apply the inline style;
          in release with Hermes + RN optimizations the native Surface
          wins and the band stays.

          The standard fix is to clip the native Surface via a wrapper
          with `overflow: 'hidden'`. The Surface is still allocated at
          its preferred size by Camera2, but the parent ViewGroup clips
          its drawing to the wrapper's 1×1 bounds. Belt-and-braces:
              - `top: -1000, left: -1000` pushes the wrapper off-screen
                so even if a future expo-camera version stops honoring
                overflow:hidden the Surface lands outside the viewport
              - `opacity: 0` keeps the JS-side composite hidden
              - `pointerEvents="none"` makes the invisible region inert
          CameraView inner style stays minimal (1×1) — the wrapper
          handles all positioning / clipping / hiding.

          Strictly visual — no change to mount condition, ref wiring,
          props (mode / videoQuality / videoBitrate), recordAsync flow,
          queue, worker, recovery, export, or AudioEngine. Pure
          presentation layer. */}
      {mode === 'video' && (isStarting || isRecording) ? (
        NATIVE_SEGMENTED_VIDEO ? (
          /* VISIBLE_NATIVE_PREVIEW = TEST_CONFIGURATION.
             HIDDEN_OR_LOCKED_CAPTURE_UX = NOT_VALIDATED.

             `GCSegmentedCameraView` is a SurfaceView and the module refuses to
             start without it (`SURFACE_LOST — preview view not mounted`). The
             only configuration ever exercised on a device is the one the
             D_15S_2S harness used: laid out, visible, ~170 px tall. The 1×1
             off-screen trick below is validated for expo-camera's TextureView
             and NOT for a SurfaceView, so it is deliberately not reused here.

             This is a validation surface, not a UX decision. Whether Guardian
             Cloud should show a preview, hide it, or replace it with another
             screen during capture is undecided and blocks the merge to main. */
          <View
            style={{
              position: 'absolute',
              top: 96,
              left: 16,
              right: 16,
              height: 170,
              backgroundColor: '#000',
              overflow: 'hidden',
            }}
          >
            <GCSegmentedCameraView style={{ flex: 1 }} />
          </View>
        ) : (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: -1000,
              left: -1000,
              width: 1,
              height: 1,
              overflow: 'hidden',
              opacity: 0,
            }}
          >
            <CameraView
              ref={(r) => {
                cameraRef.current = r;
              }}
              mode="video"
              videoQuality={VIDEO_RECORDING_QUALITY}
              videoBitrate={VIDEO_RECORDING_BITRATE_BPS}
              style={{ width: 1, height: 1 }}
            />
          </View>
        )
      ) : null}

      {/* Top shortcuts — Configuración (right) and Historial (left).
          Always available, never block any recording / recovery logic.
          Same visual weight as each other; both deliberately small so
          they never compete with the central GRABAR/PARAR button. */}
      <Pressable
        onPress={() => router.push('/history')}
        hitSlop={16}
        style={{
          position: 'absolute',
          top: 48,
          left: 20,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 6,
          backgroundColor: '#161b22',
        }}
      >
        <Text style={{ color: '#c9d1d9', fontSize: 12 }}>Historial</Text>
      </Pressable>

      <Pressable
        onPress={() => router.push('/settings')}
        hitSlop={16}
        style={{
          position: 'absolute',
          top: 48,
          right: 20,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 6,
          backgroundColor: '#161b22',
        }}
      >
        <Text style={{ color: '#c9d1d9', fontSize: 12 }}>Configuración</Text>
      </Pressable>

      <Text
        style={{
          fontSize: 16,
          color: '#8b949e',
          marginBottom: 8,
          letterSpacing: 1,
        }}
      >
        GUARDIAN CLOUD
      </Text>

      {showProtectedBanner ? (
        // UI-only emphasis for any "Evidencia protegida" moment (current
        // session or a background session that just finished). Rendered
        // ABOVE the dot/label, not as a replacement — so a second session
        // still uploading remains visible to the user via the dot/label
        // below. Strictly visual; never gates logic, never read by
        // `deriveGuardianStatus`.
        <View
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderRadius: 10,
            backgroundColor: '#0a2a14',
            borderWidth: 1,
            borderColor: '#3ddc84',
            marginBottom: 12,
            alignSelf: 'stretch',
          }}
        >
          <Text
            style={{
              color: '#3ddc84',
              fontSize: 18,
              fontWeight: '700',
              letterSpacing: 0.5,
            }}
          >
            🟢 Evidencia protegida
          </Text>
          <Text
            style={{
              color: '#8ee6a8',
              fontSize: 13,
              fontWeight: '400',
              marginTop: 4,
            }}
          >
            Guardada fuera de tu móvil
          </Text>
        </View>
      ) : null}

      {/* Honest-mode notice when video stopped because the app left the
          foreground. Amber palette to read as a non-fatal warning (not
          green / success, not red / error). Time-bounded by the
          `videoBackgroundStopAt` auto-dismiss effect — the visual lives
          for VIDEO_BG_BANNER_MS then clears. Strictly UI: never gates
          logic, never read by `deriveGuardianStatus`, never touches the
          upload / recovery / export / queue pipelines.

          Can render alongside `showProtectedBanner` and the dot/label
          below — they describe different facts (this session was cut
          short by background; chunks already uploaded remain protected;
          new sessions can start normally). */}
      {showVideoBackgroundStop ? (
        <View
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderRadius: 10,
            backgroundColor: '#2d2204',
            borderWidth: 1,
            borderColor: '#d29922',
            marginBottom: 12,
            alignSelf: 'stretch',
          }}
        >
          <Text
            style={{
              color: '#d29922',
              fontSize: 15,
              fontWeight: '700',
              letterSpacing: 0.3,
              textAlign: 'center',
            }}
          >
            El vídeo se detuvo
          </Text>
          <Text
            style={{
              color: '#e8c97a',
              fontSize: 13,
              fontWeight: '400',
              marginTop: 4,
              textAlign: 'center',
              lineHeight: 18,
            }}
          >
            La aplicación dejó de estar visible.
          </Text>
        </View>
      ) : null}

      {/* Orphan recovery banner — surfaces when boot's `scanOrphans()`
          found recording files in `documentDirectory` with no matching
          queue entry. Closes the 2026-05-15 evidence-loss window:
          AsyncStorage wiped, `documentDirectory` survives, scanner
          notices the gap, banner offers the user a single-tap recovery
          via the existing chunking + upload pipeline.

          UX rules (locked):
            - non-blocking — never hides GRABAR or any other control
            - single CTA "Recuperar" (no Ignore, no Delete, no Details)
            - copy carries ONLY count + human age (no IDs, no
              filenames, no URIs, no hashes, no sizes)
            - sticky until the user taps OR `handleRecoverOrphans`
              clears state on completion
            - serial progress feedback during recovery
              ("Recuperando evidencia 2/3…")
            - amber palette (same as the video-background-stop banner)
              to read as a non-fatal notice rather than success/error

          Strictly UI — never gates logic, never read by
          `deriveGuardianStatus`, never touches the queue / worker /
          recovery cross-device / export / manifests / AudioEngine /
          backgroundService directly. */}
      {orphanRecoverable.length > 0 || orphanOversizedCount > 0 ? (
        <View
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 14,
            paddingHorizontal: 18,
            borderRadius: 10,
            backgroundColor: '#2d2204',
            borderWidth: 1,
            borderColor: '#d29922',
            marginBottom: 12,
            alignSelf: 'stretch',
          }}
        >
          <Text
            style={{
              color: '#d29922',
              fontSize: 15,
              fontWeight: '700',
              letterSpacing: 0.3,
              textAlign: 'center',
            }}
          >
            Evidencia local sin terminar de proteger
          </Text>
          {orphanRecoverable.length > 0 ? (
            <Text
              style={{
                color: '#e8c97a',
                fontSize: 13,
                fontWeight: '400',
                marginTop: 4,
                textAlign: 'center',
                lineHeight: 18,
              }}
            >
              {(() => {
                // Pre-compute the most-recent mtime once. The `[0]` is
                // guaranteed by `length > 0` (the outer branch) but
                // `noUncheckedIndexedAccess` still requires a guard.
                // The `.reduce` form on length-1 arrays just returns
                // that single mtime; on N-element arrays it returns
                // the latest. Either way the banner copy reads
                // "se encontró 1 evidencia hace X" /
                // "se encontraron N evidencias. La más reciente, hace X".
                const latestMtime = orphanRecoverable
                  .map(o => o.mtime_ms)
                  .reduce((a, b) => Math.max(a, b), 0);
                return orphanRecoverable.length === 1
                  ? `Se encontró 1 evidencia ${formatAgeHuman(latestMtime)}.`
                  : `Se encontraron ${orphanRecoverable.length} evidencias. La más reciente, ${formatAgeHuman(latestMtime)}.`;
              })()}
            </Text>
          ) : null}
          {orphanOversizedCount > 0 ? (
            <Text
              style={{
                color: '#c2956a',
                fontSize: 12,
                fontWeight: '400',
                marginTop: 6,
                textAlign: 'center',
                lineHeight: 17,
                fontStyle: 'italic',
              }}
            >
              {orphanOversizedCount === 1
                ? 'Hay 1 archivo demasiado grande para esta versión.'
                : `Hay ${orphanOversizedCount} archivos demasiado grandes para esta versión.`}
            </Text>
          ) : null}
          {orphanProgress !== null ? (
            <Text
              style={{
                color: '#e8c97a',
                fontSize: 13,
                fontWeight: '600',
                marginTop: 10,
                textAlign: 'center',
              }}
            >
              Recuperando evidencia {orphanProgress.current}/
              {orphanProgress.total}…
            </Text>
          ) : orphanRecoverable.length > 0 ? (
            <Pressable
              onPress={handleRecoverOrphans}
              disabled={orphanBusy}
              hitSlop={8}
              style={{
                marginTop: 12,
                paddingVertical: 10,
                paddingHorizontal: 24,
                borderRadius: 6,
                backgroundColor: '#1f6feb',
                opacity: orphanBusy ? 0.5 : 1,
              }}
            >
              <Text
                style={{
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: '700',
                  letterSpacing: 0.3,
                }}
              >
                Recuperar
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Status block: column with an inner row (dot + label) and an
          optional centred sub-label below for numeric progress. The
          column stretches to the parent's cross-axis so the inner Text
          can `flexShrink` and wrap centred on small screens / long
          translations without needing magic widths or absolute
          positioning. The dot stays anchored to the FIRST line of the
          label by virtue of being a row peer. */}
      <View
        style={{
          alignItems: 'center',
          alignSelf: 'stretch',
          marginBottom: 16,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* While `iniciando`, swap the static dot for a small spinner
              so the user has a visible sign that work is happening
              between tap and the recorder going live. Same colour as
              the label, same horizontal slot — no layout shift, no new
              row, no animation library. The `iniciando` window is
              typically <2s; the spinner removes the "dead state" feel
              without otherwise touching the status pill. */}
          {guardianStatus === 'iniciando' ? (
            <ActivityIndicator
              size="small"
              color={phaseColor}
              style={{ marginRight: 8 }}
            />
          ) : (
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: phaseColor,
                marginRight: 8,
              }}
            />
          )}
          <Text
            style={{
              color: phaseColor,
              fontSize: 16,
              fontWeight: '600',
              textAlign: 'center',
              flexShrink: 1,
            }}
          >
            {phaseLabel}
          </Text>
        </View>
        {phaseSubLabel !== null ? (
          // Neutral secondary colour rather than `phaseColor`. This
          // line now carries protection facts, not phase, and the two
          // must not be confused: inheriting the phase palette would
          // paint "3 partes protegidas fuera del dispositivo" in the
          // red of `grabando` (good news as alarm) and "Todavía no
          // protegido fuera del dispositivo" in the amber of
          // `subiendo`. Same slot, same layout — colour only.
          <Text
            style={{
              color: '#8b949e',
              fontSize: 14,
              fontWeight: '500',
              textAlign: 'center',
              marginTop: 4,
            }}
          >
            {phaseSubLabel}
          </Text>
        ) : null}
      </View>

      {/* Human translation of the most recent permanent failure on
          the current session. Visible only while `guardianStatus`
          is `error` AND a `last_error` was captured by the polling
          tick — both conditions are derived state, not new
          persistence. The mapping lives in `humanizeFailure`; this
          block contributes copy + the optional Reintentar button.
          Worker-internal vocabulary (codes, statuses) never leaves
          the queue. */}
      {guardianStatus === 'error' && lastFailedError ? (() => {
        const failureView = humanizeFailure(lastFailedError);
        return (
          <View
            style={{
              marginTop: 4,
              marginBottom: 16,
              paddingHorizontal: 24,
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: '#f85149',
                fontSize: 14,
                fontWeight: '600',
                textAlign: 'center',
                lineHeight: 18,
              }}
            >
              {failureView.message}
            </Text>
            <Text
              style={{
                color: '#8b949e',
                fontSize: 12,
                textAlign: 'center',
                marginTop: 6,
                lineHeight: 16,
              }}
            >
              {failureView.evidence}
            </Text>
            {failureView.recoverable ? (
              <Pressable
                onPress={() => {
                  // Best-effort. The mutation is single-AsyncStorage-write
                  // and we don't surface its result to the user — the
                  // 500ms poll tick will reflect the new status (failed
                  // → pending → uploading → uploaded) on its own.
                  requeueFailedChunks().catch(() => {
                    /* swallow — next tick reflects state regardless */
                  });
                }}
                style={({ pressed }) => ({
                  marginTop: 10,
                  paddingHorizontal: 18,
                  paddingVertical: 8,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: '#3ddc84',
                  backgroundColor: pressed ? '#0a2a14' : 'transparent',
                })}
              >
                <Text
                  style={{ color: '#3ddc84', fontSize: 13, fontWeight: '600' }}
                >
                  Reintentar
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })() : null}

      {/* Older sessions still draining behind the current one. Two
          shapes, both derived from the queue on the same poll tick:
          - `bgActiveSessions > 0`: at least one background session is
            still uploading. Show aggregate chunk progress so the user
            can see WHY background sessions are not done yet.
            "+N sesión(es) subiendo (uploaded / total)"
          - else if `backgroundSessions > 0`: background entries exist
            but their chunks are all settled (e.g. the just-finished
            session in its brief pre-reap window). Fall back to the
            count-only line. Never shown when q.length <= 1. */}
      {bgActiveSessions > 0 ? (
        <Text
          style={{
            color: '#8b949e',
            fontSize: 12,
            marginTop: -8,
            marginBottom: 16,
          }}
        >
          {bgActiveSessions === 1
            ? `Otra evidencia guardándose (${bgUploaded} / ${bgTotal})`
            : `+${bgActiveSessions} evidencias guardándose (${bgUploaded} / ${bgTotal})`}
        </Text>
      ) : backgroundSessions > 0 ? (
        <Text
          style={{
            color: '#8b949e',
            fontSize: 12,
            marginTop: -8,
            marginBottom: 16,
          }}
        >
          {backgroundSessions === 1
            ? 'Otra evidencia guardándose'
            : `+${backgroundSessions} evidencias guardándose`}
        </Text>
      ) : null}

      {/* Destination indicator. Single source of truth for what the
          home screen tells the user about evidence routing. Now reads
          `activeDest` so the displayed destination matches the one the
          worker will actually use for the next recording — Drive when
          only Drive is connected, NAS when only NAS is connected, and
          the user-selected target (Settings) when both are connected.
          The previous separate "Protegiendo en …" line is gone — there
          is only one place that says where evidence lands. */}
      <DestinationIndicator
        drive={drive}
        hasNas={hasNas}
        activeDest={activeDest}
        loading={driveCheckLoading}
      />

      {/* Audio / Video mode toggle. Cosmetic in step 2 — flipping the
          state has no effect on what gets recorded yet. Locked while a
          session is starting, recording, or stopping so the chosen mode
          cannot change mid-flight. */}
      <ModeToggle
        mode={mode}
        onChange={setMode}
        disabled={isRecording || isStarting || isStopping}
      />

      {/* Reliability card — proactive contextual ask shown after Drive
          connect and dismissed permanently after the user taps "Ahora
          no". Strictly additive UI; the card's helpers do not touch the
          FG service, the queue, the worker, or recovery.

          Hidden for the WHOLE capture window via `isRecordingBusy`, not
          via `showStop`: `showStop` is `isRecording || isStopping` and
          would leave the card on screen throughout `isStarting`.

          This card is the single reliability recommendation on Home.
          The former POST_NOTIFICATIONS pill that used to sit below was
          removed — it duplicated the card's notifications action. The
          denial is still detected and still stored (see
          `setNotificationDenied` on the FG-service result path); the
          user grants the permission from this card or from Settings. */}
      <ReliabilityCard
        mode="home"
        driveConnected={Boolean(drive)}
        recordingBusy={isRecordingBusy({ isStarting, isRecording, isStopping })}
      />

      {/* Discreet "Inicio rápido activado" pill. Surfaces the panic
          preference so the user can confirm at a glance that the home
          screen is primed. UI-only — the toggle in Settings is the
          ONLY mutator; this just reflects state. */}
      {!showStop && quickStartEnabled ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderWidth: 1,
            borderColor: '#3ddc84',
            borderRadius: 999,
            marginTop: 8,
            marginBottom: -4,
            backgroundColor: '#0a2a14',
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: '#3ddc84',
              marginRight: 6,
            }}
          />
          <Text style={{ color: '#3ddc84', fontSize: 11, fontWeight: '600' }}>
            Inicio rápido activado
          </Text>
        </View>
      ) : null}

      {/* Launcher-shortcut affordance. Shown when the app was opened
          via the Android app shortcut ("Grabar evidencia") so the user
          knows the panic flow is one tap away. Strictly cosmetic — does
          not call into any recording flow. */}
      {!showStop && !buttonDisabled && panicLaunch ? (
        <Text
          style={{
            color: '#3ddc84',
            fontSize: 13,
            fontWeight: '600',
            marginTop: 6,
            marginBottom: -4,
            textAlign: 'center',
          }}
        >
          Listo para grabar
        </Text>
      ) : null}

      <Pressable
        onPress={
          showStop
            ? stopRecording
            : () => {
                // PERF instrumentation tap-anchor — sets the timing
                // origin all subsequent GC_PERF_* events compute their
                // `since_tap_ms` against. Synchronous, fire-and-forget
                // call into startRecording (matches the previous
                // direct-reference behaviour).
                lastTapAtMs = Date.now();
                perfLog('GC_PERF_TAP_RECORD');
                startRecording();
              }
        }
        disabled={buttonDisabled}
        style={{
          backgroundColor: buttonBg,
          opacity: buttonDisabled ? 0.5 : 1,
          width: 200,
          height: 200,
          borderRadius: 100,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 24,
          marginTop: 24,
          elevation: 4,
        }}
      >
        <Text
          style={{
            color: '#fff',
            fontSize: 24,
            fontWeight: '700',
            letterSpacing: 2,
            textAlign: 'center',
            paddingHorizontal: 4,
          }}
        >
          {buttonLabel}
        </Text>
      </Pressable>

      {/* Reassurance line shown only while actively recording — same
          guardianStatus value the dot/label above already reads. No new
          state, no new derivation. */}
      {guardianStatus === 'grabando' ? (
        <Text
          style={{
            color: '#8b949e',
            fontSize: 13,
            marginTop: -12,
            marginBottom: 16,
            textAlign: 'center',
          }}
        >
          Se está guardando automáticamente
        </Text>
      ) : null}

      {!hasDrive && !driveCheckLoading && !showStop && (
        <Text
          style={{
            color: '#f85149',
            fontSize: 12,
            textAlign: 'center',
            marginBottom: 14,
            paddingHorizontal: 12,
          }}
        >
          No puedes grabar sin un destino conectado. Pulsa Configuración para
          conectar tu Google Drive.
        </Text>
      )}

      {/* GC-DEV-RESET-001 — DEV-only hard reset.
        *
        * This control destroyed a validation run on 2026-08-21: an
        * accidental long-press wiped 54 chunks and 1 776 751 bytes of
        * audio whose `remote_reference` was 0 of 54 — none of it had ever
        * left the device. An 800 ms press on a 10 px target executed
        * immediately, with no confirmation and no evidence check.
        *
        * Two things changed. The press no longer executes anything: it
        * asks first. And `hardResetAppState` REFUSES outright while any
        * chunk is unconfirmed — there is no "delete anyway", because a
        * dev convenience may not be what loses someone's evidence.
        */}
      {__DEV__ ? (
        <Pressable
          onLongPress={async () => {
            if (isRecording || isStarting || isStopping) {
              Alert.alert('Reset bloqueado', 'Stop recording before reset.');
              return;
            }
            // Check BEFORE showing a dialog, so the refusal is what the
            // user sees rather than a confirm prompt for something that
            // was never going to run. GLOBAL check: this control deletes
            // documentDirectory, where evidence survives with no queue
            // entry by design (`abandonUnregisteredSession`).
            const pending = await inspectResetSafety();
            if (pending) {
              Alert.alert('Reset bloqueado', describeResetRefusal(pending));
              return;
            }
            Alert.alert(
              'Reset de estado (DEV)',
              'Borra cola, historial y ficheros locales. No toca tu ' +
                'identidad ni tu sesión de Google. ¿Continuar?',
              [
                { text: 'Cancelar', style: 'cancel' },
                {
                  text: 'Resetear',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      // Re-checked inside the tool: the dialog may have
                      // been open while a capture wrote new chunks.
                      const outcome = await hardResetAppState();
                      Alert.alert(
                        outcome.ok ? 'Reset hecho' : 'Reset bloqueado',
                        outcome.ok
                          ? 'App state cleared.'
                          : describeResetRefusal(outcome),
                      );
                    } catch (err) {
                      Alert.alert(
                        'Reset error',
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  },
                },
              ],
            );
          }}
          delayLongPress={800}
          hitSlop={20}
          style={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            padding: 6,
            opacity: 0.15,
          }}
        >
          <Text style={{ color: '#8b949e', fontSize: 10 }}>reset</Text>
        </Pressable>
      ) : null}

      {/* One-shot beta welcome modal. Transparent overlay rendered as a
          sibling of the rest of the Home screen — React Native's Modal
          uses a native portal so position in the JSX tree does not
          affect layering. Visible only when `showBetaWelcome=true`,
          which is only ever set to true once per device (cleared by
          `dismissBetaWelcome` writing `BETA_WELCOME_SEEN_KEY='1'`).
          `onRequestClose` handles the Android hardware back button by
          dismissing the modal rather than letting it bubble up to exit
          the app — matches the user's tap on "Entendido". */}
      <Modal
        visible={showBetaWelcome}
        transparent
        animationType="fade"
        onRequestClose={dismissBetaWelcome}
        statusBarTranslucent
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              backgroundColor: '#161b22',
              borderWidth: 1,
              borderColor: '#30363d',
              borderRadius: 10,
              padding: 22,
            }}
          >
            <Text
              style={{
                color: '#c9d1d9',
                fontSize: 17,
                fontWeight: '700',
                marginBottom: 12,
              }}
            >
              Gracias por probar Guardian Cloud Beta
            </Text>
            <Text
              style={{
                color: '#c9d1d9',
                fontSize: 13,
                lineHeight: 19,
                marginBottom: 10,
              }}
            >
              Guardian Cloud intenta proteger tu evidencia en tiempo
              real mientras grabas, incluso si algo le ocurre al
              dispositivo.
            </Text>
            <Text
              style={{
                color: '#c9d1d9',
                fontSize: 13,
                lineHeight: 19,
                marginBottom: 10,
              }}
            >
              Tu feedback ayuda a mejorar la estabilidad, recuperación
              y confianza del sistema.
            </Text>
            <Text
              style={{
                color: '#8b949e',
                fontSize: 12,
                lineHeight: 17,
                marginBottom: 18,
              }}
            >
              Puedes enviar opiniones desde Configuración → Enviar
              opinión beta.
            </Text>
            <Pressable
              onPress={dismissBetaWelcome}
              style={{
                backgroundColor: '#1f6feb',
                borderRadius: 6,
                paddingVertical: 12,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
                Entendido
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Quick-start countdown modal. Visibility tied to `countdownSec`:
          while non-null the user sees a big number ticking down with a
          single primary "Cancelar" action. Tapping Cancelar (or Android
          back via `onRequestClose`) calls `cancelCountdown()` which
          clears the timer ref and the state. Hitting 0 inside the tick
          callback calls `startRecording()` directly — same path as the
          GRABAR button, no duplicated logic, no extra state machine.
          The Modal blocks the underlying GRABAR button visually so a
          double-tap race is impossible. Style mirrors the beta-welcome
          card above for consistency. */}
      <Modal
        visible={countdownSec !== null}
        transparent
        animationType="fade"
        onRequestClose={cancelCountdown}
        statusBarTranslucent
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              backgroundColor: '#161b22',
              borderWidth: 1,
              borderColor: '#30363d',
              borderRadius: 10,
              padding: 22,
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: '#c9d1d9',
                fontSize: 16,
                fontWeight: '600',
                marginBottom: 12,
                textAlign: 'center',
              }}
            >
              Grabación automática en…
            </Text>
            <Text
              style={{
                color: '#3ddc84',
                fontSize: 72,
                fontWeight: '700',
                marginBottom: 18,
                textAlign: 'center',
                fontVariant: ['tabular-nums'],
              }}
            >
              {countdownSec ?? ''}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={cancelCountdown}
              style={({ pressed }) => ({
                alignSelf: 'stretch',
                backgroundColor: pressed ? '#a82a36' : '#d73a49',
                borderRadius: 6,
                paddingVertical: 14,
                alignItems: 'center',
              })}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                Cancelar
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

    </View>
  );
}

function DestinationIndicator({
  drive,
  hasNas,
  activeDest,
  loading,
}: {
  drive: PublicDestination | null | undefined;
  hasNas: boolean;
  activeDest: DestinationType;
  loading: boolean;
}) {
  // Effective destination = the one the worker is actually going to
  // hit for the next recording. Reflects activeDest when its target is
  // connected, falls back to "drive" when activeDest='drive' or to
  // "nas" when only NAS is connected, and to null when nothing is
  // connected at all (fallback label below).
  const showingNas = activeDest === 'nas' && hasNas;
  const showingDrive = activeDest === 'drive' && Boolean(drive);
  const anyConnected = Boolean(drive) || hasNas;
  // Dot is green iff the active destination is actually connected;
  // gray during the destination resolve roundtrip; red when nothing
  // is reachable.
  const dotColor = loading
    ? '#8b949e'
    : showingNas || showingDrive
    ? '#3ddc84'
    : '#f85149';
  const fallbackLabel = loading
    ? 'Comprobando destino…'
    : anyConnected
    ? 'Sin destino activo'
    : 'Sin destino conectado';

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: '#30363d',
        borderRadius: 6,
        backgroundColor: '#161b22',
        maxWidth: '100%',
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: dotColor,
          marginRight: 8,
        }}
      />
      {!loading && showingNas ? (
        <View style={{ flexShrink: 1 }}>
          <Text style={{ color: '#c9d1d9', fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
            🔒 Guardado en tu NAS
          </Text>
        </View>
      ) : !loading && showingDrive && drive ? (
        <View style={{ flexShrink: 1 }}>
          <Text style={{ color: '#c9d1d9', fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
            🔒 Guardado en tu Google Drive
          </Text>
          {drive.account_email ? (
            <Text style={{ color: '#8b949e', fontSize: 11, marginTop: 2 }} numberOfLines={1}>
              {drive.account_email}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text style={{ color: '#c9d1d9', fontSize: 12 }} numberOfLines={1}>
          {fallbackLabel}
        </Text>
      )}
    </View>
  );
}

/**
 * Audio / Video mode toggle. Two segmented Pressables; the active mode
 * is highlighted. Disabled while a session is starting, recording, or
 * stopping so the user can't flip mode mid-flight.
 *
 * Step 2 wires only the state + UI — `mode` is not yet read by the
 * recording branches, so flipping this toggle has no effect on what
 * gets captured. The video branch lands in step 3.
 */
function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: SessionMode;
  onChange: (next: SessionMode) => void;
  disabled: boolean;
}) {
  const segment = (value: SessionMode, label: string) => {
    const active = mode === value;
    return (
      <Pressable
        key={value}
        onPress={() => onChange(value)}
        disabled={disabled}
        hitSlop={4}
        style={{
          paddingHorizontal: 18,
          paddingVertical: 8,
          backgroundColor: active ? '#1f6feb' : '#161b22',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text
          style={{
            color: active ? '#fff' : '#8b949e',
            fontSize: 12,
            fontWeight: '600',
            letterSpacing: 0.5,
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        marginTop: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#30363d',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {segment('audio', 'Audio')}
      {segment('video', 'Video')}
    </View>
  );
}
