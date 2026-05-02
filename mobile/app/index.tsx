import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, View, Text, Pressable } from 'react-native';
import { Audio } from 'expo-av';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, Stack } from 'expo-router';
import { supabase } from '@/auth/supabase';
import { env } from '@/config/env';
import {
  getConnectedDrive,
  uploadChunkBytes,
  type PublicDestination,
} from '@/api/destinations';
import { ApiError } from '@/api/client';
import { useAuthStore, getFreshAccessToken } from '@/auth/store';
import { appendHistoryEntry, type SessionMode } from '@/api/history';
import { hardResetAppState } from '@/dev/reset';
import type { ChunkPayload } from '@/recording/chunkProducer';
import { RecordingController } from '@/recording/recordingController';
import { deriveGuardianStatus } from '@/recording/deriveGuardianStatus';

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

const PENDING_RETRY_KEY = 'test.pending_retry';

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
 * force-stop com.guardiancloud.app` to hit the exact state the test
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
const CHUNK_SIZE_AUDIO = 16 * 1024;
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
 */
// `as` cast is deliberate: the HIGH_QUALITY preset's TypeScript type in
// expo-av marks `ios`/`web` as optional while `RecordingOptions` requires
// them, which the project's `exactOptionalPropertyTypes: true` rejects
// on a plain spread. The runtime object is complete (preset ships with
// both branches); this is a pure type-level concession.
const RECORDING_OPTIONS = {
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  android: {
    extension: '.aac',
    outputFormat: Audio.AndroidOutputFormat.AAC_ADTS,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 64000,
  },
} as Audio.RecordingOptions;

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

type ChunkStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

interface QueueChunk {
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
   * VIDEO post-stop path only. Absolute filesystem URI of a file that
   * holds this chunk's base64 (under
   * `documentDirectory/chunks/{sessionId}/{chunk_index}.b64`). Set at
   * emit time by `videoChunkSink`; deleted after a successful upload
   * and on `reapEntry`. Persisting the base64 OUT of AsyncStorage is
   * how the queue avoids the SQLite CursorWindow ~2 MB per-row limit
   * for video sessions — the in-queue row stays metadata-only.
   *
   * Mutually exclusive with `base64Slice`: a chunk has either the
   * in-queue audio payload or the on-disk video payload, never both.
   * `rehydrateChunkSlice` branches on field presence.
   */
  local_uri?: string | undefined;
  /** Set when the upload to Drive returned a file_id we should use as remote_reference on /chunks. */
  remote_reference?: string | null | undefined;
  last_error?: { status: number; code?: string; message: string } | undefined;
}

interface PendingQueueEntry {
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
}

const CHUNK_TICK_MS = 1500;
/** Cap retries for completeSession so a permanently-broken session does not hold a queue entry forever. */
const MAX_COMPLETE_ATTEMPTS = 5;
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

async function queueMutate<T>(
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
      await AsyncStorage.setItem(PENDING_RETRY_KEY, JSON.stringify(queue));
    });
  await writeChain;
  return result;
}

async function queueRead(): Promise<PendingQueueEntry[]> {
  return queueMutate(q => q.map(entry => ({ ...entry })));
}

async function queueAppendNewSession(
  entry: PendingQueueEntry,
): Promise<void> {
  await queueMutate(q => {
    const existing = q.findIndex(e => e.session_id === entry.session_id);
    if (existing >= 0) q[existing] = entry;
    else q.push(entry);
  });
}

async function queueAppendChunk(
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
    if (!e) return;
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

async function queueUpdateChunk(
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

async function queueMarkRecordingClosed(
  sessionId: string,
  finalUri: string,
  emittedBase64Length: number,
  nextChunkIndex: number,
): Promise<void> {
  await queueMutate(q => {
    const e = q.find(x => x.session_id === sessionId);
    if (!e) return;
    e.recording_closed = true;
    e.uri = finalUri;
    e.emitted_base64_length = emittedBase64Length;
    e.next_chunk_index = nextChunkIndex;
  });
}

async function queueMarkSessionCompleted(sessionId: string): Promise<void> {
  await queueMutate(q => {
    const e = q.find(x => x.session_id === sessionId);
    if (!e) return;
    e.session_completed = true;
  });
}

async function queueBumpCompleteAttempts(sessionId: string): Promise<number> {
  return queueMutate(q => {
    const e = q.find(x => x.session_id === sessionId);
    if (!e) return 0;
    e.complete_attempts += 1;
    return e.complete_attempts;
  });
}

async function queueDropEntry(sessionId: string): Promise<void> {
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
async function migrateLegacyPendingState(): Promise<void> {
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

interface NormalizationReport {
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
async function normalizeQueueOnRecovery(): Promise<NormalizationReport> {
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
      target.recording_closed =
        target.recording_closed || dup.recording_closed;
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
        // Mark every chunk failed with CORRUPT_HASH_DIVERGENCE. The
        // worker's all-settled finaliser will then complete the session
        // (with failed chunks) via the existing path. We do NOT delete
        // the entry — chunks already uploaded remain server-side.
        const failedChunks: QueueChunk[] = [];
        for (const group of groups.values()) {
          // Within a corrupt entry, still collapse exact-hash duplicates
          // so we don't double-count failed chunks. Keep the canonical
          // (first) hash per group; mark it failed.
          const seenHashes = new Set<string>();
          for (const c of group) {
            if (seenHashes.has(c.hash)) continue;
            seenHashes.add(c.hash);
            failedChunks.push({
              ...c,
              status: 'failed',
              base64Slice: undefined,
              last_error: {
                status: 0,
                code: 'CORRUPT_HASH_DIVERGENCE',
                message:
                  `chunk_index ${c.chunk_index} appeared with multiple hashes ` +
                  `in persisted queue; entire session marked corrupt`,
              },
            });
          }
        }
        failedChunks.sort((a, b) => a.chunk_index - b.chunk_index);
        const droppedNow =
          entry.chunks.length - failedChunks.length;
        if (droppedNow > 0) report.exact_duplicates_dropped += droppedNow;
        entry.chunks = failedChunks;
        report.sessions_marked_corrupt++;
        report.chunks_marked_failed += failedChunks.length;
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
 * Intentionally module-level (not behind __DEV__) so a release-mode build
 * can still surface it if we ever ship a recovery tool. The Settings UI
 * gate is what enforces "DEV-only" today.
 */
export async function clearGuardianQueueDev(): Promise<{
  removed: string[];
}> {
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
async function reapAlreadyDoneEntries(): Promise<{ reaped: number }> {
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

// ----- error classification (HC: never retry 4xx forever) -----

function classifyError(err: unknown): 'transient' | 'permanent' {
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

function shapeError(
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
}

async function loadPendingRegistrations(): Promise<PendingSessionRegistration[]> {
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

async function addPendingRegistration(
  session_id: string,
  mode: SessionMode,
): Promise<void> {
  const list = await loadPendingRegistrations();
  if (!list.find(p => p.session_id === session_id)) {
    list.push({ session_id, mode });
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
async function runPendingRegistrationLoop(): Promise<void> {
  if (pendingRegistrationLoopRunning) return;
  pendingRegistrationLoopRunning = true;
  try {
    while (true) {
      const list = await loadPendingRegistrations();
      if (list.length === 0) return;

      const token = await getFreshAccessToken();
      if (token) {
        for (const item of list) {
          try {
            await createSessionRequest(token, item.mode, item.session_id);
            console.log('GC_LOCAL_FIRST session registered', {
              session_id: item.session_id,
              mode: item.mode,
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

      const remaining = await loadPendingRegistrations();
      if (remaining.length === 0) return;
      await sleep(PENDING_SESSIONS_RETRY_INTERVAL_MS);
    }
  } finally {
    pendingRegistrationLoopRunning = false;
  }
}

async function schedulePendingSessionRegistration(
  session_id: string,
  mode: SessionMode,
): Promise<void> {
  await addPendingRegistration(session_id, mode);
  // Fire-and-forget. The loop self-terminates when the list is empty.
  runPendingRegistrationLoop().catch(err => {
    console.log('GC_LOCAL_FIRST register loop rejected', err);
  });
}

/**
 * Detect errors from `createSessionRequest` that warrant local-first
 * fallback (retry in background) rather than aborting the recording.
 *
 * Retryable: any failure that did NOT come back as a 4xx HTTP response.
 * That covers offline (TypeError "Network request failed"), DNS errors,
 * AbortError on timeout, and 5xx/408/429.
 *
 * Not retryable: 4xx (validation/auth errors) — the user input is wrong
 * and recording should not start. The original `throw` path handles it.
 */
function isRetryableSessionCreateError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.match(/HTTP (\d{3})/);
  if (!m) return true; // no HTTP status → network/abort
  const status = Number(m[1]);
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

// ----- upload worker (single-flight, multi-session) -----

let isDraining = false;
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
  return base64SliceAt(base64, chunk.chunk_index);
}

interface NextPick {
  sessionId: string;
  chunk: QueueChunk;
  rehydratedSlice: string;
}

async function pickNext(queue: PendingQueueEntry[]): Promise<NextPick | null> {
  for (const entry of queue) {
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
    };
  }
  return null;
}

async function uploadDrainLoop(): Promise<void> {
  if (DEBUG_QUEUE) console.log('GC_DEBUG drain called', { isDraining });
  if (isDraining) {
    if (DEBUG_QUEUE) console.log('GC_DEBUG drain skipped — isDraining=true');
    return;
  }
  isDraining = true;
  if (DEBUG_QUEUE) console.log('GC_DEBUG drain entered loop');
  try {
    while (true) {
      const queue = await queueRead();
      const pick = await pickNext(queue);
      if (!pick) {
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
        await sleep(500);
        continue;
      }

      const { sessionId, chunk, rehydratedSlice } = pick;
      if (DEBUG_QUEUE) {
        console.log('GC_DEBUG drain pending found', {
          sessionId,
          chunk_index: chunk.chunk_index,
          slice_len: rehydratedSlice.length,
        });
      }
      await queueUpdateChunk(sessionId, chunk.chunk_index, { status: 'uploading' });
      console.log('GC_QUEUE chunk uploading', {
        sessionId,
        chunk_index: chunk.chunk_index,
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
          const drive = await uploadChunkBytes(
            sessionId,
            chunk.chunk_index,
            chunk.hash,
            rehydratedSlice,
          );
          if (DEBUG_QUEUE) {
            console.log('GC_DEBUG after uploadChunkBytes', {
              sessionId,
              chunk_index: chunk.chunk_index,
              remote_reference: drive.remote_reference,
            });
          }
          const token = await getFreshAccessToken();
          if (!token) throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
          await postChunk(
            token,
            sessionId,
            { chunk_index: chunk.chunk_index, hash: chunk.hash, size: chunk.size },
            'uploaded',
            drive.remote_reference,
          );
          await queueUpdateChunk(sessionId, chunk.chunk_index, {
            status: 'uploaded',
            base64Slice: undefined,           // poda
            remote_reference: drive.remote_reference,
            last_error: undefined,
          });
          // Best-effort cleanup of the on-disk video payload. The file
          // is no longer needed once the chunk is acknowledged on the
          // backend AND in Drive; leaving it would just consume disk
          // until the session reaps. Audio chunks have no local_uri,
          // so this is a no-op for them.
          if (chunk.local_uri) {
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
            remote_reference: drive.remote_reference,
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
        if (decision === 'permanent') {
          await queueUpdateChunk(sessionId, chunk.chunk_index, {
            status: 'failed',
            base64Slice: undefined,         // poda — no sirve reintentar
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
    isDraining = false;
  }
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

async function tryFinalizeReadySessions(): Promise<boolean> {
  const queue = await queueRead();
  let anyFinalized = false;
  for (const entry of queue) {
    if (!entry.recording_closed) continue;

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

    if (missingUploadedIndexes.length > 0) {
      // Do NOT call completeSession. Keeping the session row as `active`
      // on the backend is the correct outcome — anything else would
      // mark a session "complete" with permanent gaps.
      continue;
    }

    if (entry.session_completed) {
      await reapEntry(entry.session_id, entry.uri);
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
      const token = await getFreshAccessToken();
      if (!token) throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
      await completeSession(token, entry.session_id);
      await queueMarkSessionCompleted(entry.session_id);
      await reapEntry(entry.session_id, entry.uri);
      anyFinalized = true;
      console.log('GC_QUEUE session completed', { sessionId: entry.session_id });
    } catch (err) {
      const attempts = await queueBumpCompleteAttempts(entry.session_id);
      console.log('GC_QUEUE session complete failed', {
        sessionId: entry.session_id,
        attempts,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return anyFinalized;
}

async function reapEntry(sessionId: string, uri: string): Promise<void> {
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

async function emitChunk(
  sessionId: string,
  base64Slice: string,
  chunk_index: number,
  emittedAfter: number,
): Promise<void> {
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
    base64Slice,
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
  });
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
 * Used by the video post-stop path so chunk payloads live on disk
 * instead of inside the AsyncStorage JSON blob (which trips the SQLite
 * CursorWindow ~2 MB per-row limit for anything bigger than a couple
 * of chunks). Audio is unaffected — audio's `emitChunk` keeps writing
 * `base64Slice` straight into the queue exactly as before.
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
async function videoChunkSink(payload: ChunkPayload): Promise<void> {
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
function base64SliceAt(base64: string, chunkIndex: number): string {
  // Rehydration only triggers for legacy entries that lack a persisted
  // base64Slice. Pre-Phase-2 entries were all audio (video did not exist
  // at the time), and any post-Phase-2 entry — audio or video — keeps
  // its base64Slice in the queue until upload succeeds. Using the audio
  // base64 size here therefore matches every rehydration we can actually
  // hit; video chunks never need this path.
  const offset = chunkIndex * CHUNK_SIZE_BASE64_AUDIO;
  return base64.substring(offset, offset + CHUNK_SIZE_BASE64_AUDIO);
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

async function postChunk(
  token: string,
  sessionId: string,
  chunk: RealChunk,
  status: 'pending' | 'uploaded' | 'failed',
  remoteReference?: string | null,
): Promise<unknown> {
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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
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
  token: string,
  sessionId: string,
): Promise<unknown> {
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
  token: string,
  mode: SessionMode = 'audio',
  /**
   * Optional client-provided session id. The backend treats POST
   * /sessions idempotently when this is present: same (id, user_id) →
   * existing row returned, new id → row inserted with that id. Used by
   * the offline-first path so a recording started with no network can
   * be re-registered later under the same UUID it was emitted with.
   */
  clientId?: string,
): Promise<string> {
  const sessionBody = JSON.stringify({
    user_id: 'test_user',
    mode,
    destination_type: 'drive',
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
  const recordingRef = useRef<Audio.Recording | null>(null);
  // Video-mode counterparts of recordingRef. The CameraView is mounted
  // only during a video session (see render); cameraRef is wired through
  // its ref callback. videoRecordPromiseRef holds the recordAsync()
  // promise — it resolves only when stopRecording() is called and gives
  // the authoritative final URI. videoRecordingUriRef remembers the URI
  // we discovered via cacheDirectory listing at start, used at stop to
  // verify it matches the camera's authoritative URI.
  const cameraRef = useRef<CameraView | null>(null);
  const videoRecordPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const videoRecordingUriRef = useRef<string | null>(null);
  // Camera permission hook. Permission is requested at GRABAR-time when
  // mode === 'video', not on screen mount, so audio sessions never
  // surface a camera prompt.
  const [, requestCameraPermission] = useCameraPermissions();
  const tokenRef = useRef<string | null>(null);
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
   * X / N progress counter.
   *
   * Mirrors the in-flight chunk upload from existing state (Phase 1 total
   * comes from the derived chunk count; Phase 2 total comes from the
   * persisted `remaining` array). Purely additive UI — never gates logic.
   *
   * Lifecycle:
   *   - Phase 1 start → setTotal(chunks.length), setUploaded(0)
   *   - each successful POST /chunks → setUploaded(u => u + 1)
   *   - Phase 2 start → setTotal(pending.remaining.length), setUploaded(0)
   *   - each successful POST /chunks → setUploaded(u => u + 1)
   *   - final DONE → setTotal(0), setUploaded(0) so the UI resets
   *
   * We never show 0 / 0 — the UI only renders the counter when total > 0.
   */
  const [uploadedCount, setUploadedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
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
   * as `activeCount` / `uploadedCount` — the polling tick already walks
   * the queue, this is one extra branch in the existing for-loop. Used
   * by `deriveGuardianStatus` to flip the pill to `error` so a chunk
   * that the worker has given up on does not silently sit at the bottom
   * of `Subiendo evidencia (N-1 / N)` forever.
   */
  const [failedCount, setFailedCount] = useState(0);
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

  function resetProgress() {
    setUploadedCount(0);
    setTotalCount(0);
    setActiveCount(0);
    setFailedCount(0);
    setBackgroundSessions(0);
  }

  async function refreshDestination() {
    try {
      const d = await getConnectedDrive();
      setDrive(d ?? undefined);
    } catch (error) {
      // Transient check failure (network, 401) → leave as `null` so the
      // button remains disabled but no hard block. The user can retry
      // via the Settings screen. Recovery is independent of this.
      console.log('DEST CHECK ERROR:', error);
      setDrive(null);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        // DEBUG: unmistakable build sentinel. If this string does NOT appear
        // on screen at boot, the emulator is running a stale JS bundle and
        // none of the ZZ_HEALTH_PROBE_* / ZZ_FETCH_POST_START / enhanced
        // ZZ_ERROR_SESSION diagnostics added later in the flow will fire.
        // 500ms dwell so it is legible to a human eye even on fast boots.
        setTestStatus('ZZ_DEBUG_BUILD_V2');
        await new Promise(r => setTimeout(r, 500));
        setTestStatus(`API URL: ${env.apiUrl}`);
        await new Promise(r => setTimeout(r, 50));
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: 'diego@hotmail.com',
          password: 'Diegoou96.',
        });
        if (authError) {
          setTestStatus('Necesitas iniciar sesión');
          console.log('ERROR AUTH:', authError);
          return;
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
        tokenRef.current = token;
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
        // Never log the full JWT. Keep a size/prefix fingerprint so we can
        // still tell "token present and looks like a JWT" from "token empty
        // or wrong shape" without exposing the signing material.
        console.log('TOKEN:', {
          length: token.length,
          prefix: token.substring(0, 12),
          looks_like_jwt: token.split('.').length === 3,
        });
        console.log('API URL:', env.apiUrl);

        // Kick off the destination check in the background. MUST NOT be
        // awaited here — a slow /destinations call MUST NOT delay Phase
        // 2 recovery. Recovery is the priority when pending state exists.
        refreshDestination();

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
        } catch (err) {
          console.log('GC_QUEUE recovery finalize-prep failed', err);
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

        // Local-first recovery: re-fire the pending-registration loop in
        // case the previous app instance died with sessions still
        // unregistered remotely. Idempotent — empty list is a no-op.
        runPendingRegistrationLoop().catch(err => {
          console.log('GC_LOCAL_FIRST register loop rejected (boot)', err);
        });

        const queueAtBoot = await queueRead();
        if (queueAtBoot.length > 0) {
          setIsRecovering(true);
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
          uploadDrainLoop().catch(err => {
            if (DEBUG_QUEUE) {
              console.log('GC_DEBUG drain rejected (from recovery)', {
                err: err instanceof Error ? err.message : String(err),
              });
            }
          });
        }

        // No pending state — ready for a manual Phase 1 trigger.
        setTestStatus('READY');
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
    if (
      isStartingRef.current ||
      recordingRef.current ||
      videoRecordPromiseRef.current
    ) {
      console.log('REC START ignored — already starting or recording');
      return;
    }
    isStartingRef.current = true;
    setIsStarting(true);
    resetProgress();

    // Capture mode synchronously so it cannot change mid-flight if the
    // user somehow flips the toggle (the UI locks it, but defense in
    // depth keeps createSessionRequest, appendHistoryEntry, and the
    // recorder branch all using the same value).
    const recordingMode: SessionMode = mode;

    try {
      setTestStatus('REC START');
      await new Promise(r => setTimeout(r, 50));
      console.log('REC START — manual trigger', { mode: recordingMode });

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) throw new Error('RECORD_AUDIO permission denied');

      if (recordingMode === 'video') {
        // Camera permission is requested at GRABAR-time, not on screen
        // mount, so audio sessions never trigger this prompt.
        const cam = await requestCameraPermission();
        if (!cam.granted) throw new Error('CAMERA permission denied');
      }
      setTestStatus('REC PERMISSION OK');
      await new Promise(r => setTimeout(r, 50));

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        // Keep the audio session alive across activity backgrounding.
        // Without this flag both iOS and Android would treat a minimised
        // app as "stop capturing". With it, the OS-level audio session
        // continues; combined with the foreground service installed in
        // Tier 2, the recorder keeps writing samples while the user has
        // the app off-screen.
        staysActiveInBackground: true,
      });
      setTestStatus('REC MODE SET');
      await new Promise(r => setTimeout(r, 50));

      const token = tokenRef.current;
      if (!token) throw new Error('TOKEN_MISSING_AT_START');

      // Create the session BEFORE the recorder so the concurrent chunker
      // can attribute its first tick to a known session_id. If the POST
      // succeeds but recorder.startAsync fails below, the session is
      // orphan in `active` — the worker's tryFinalizeReadySessions
      // path will reap it (chunks=[] → all-settled → completeSession).
      //
      // Local-first: generate the UUID up front so we have a stable
      // session_id whether or not the backend is reachable. Backend is
      // idempotent on (id, user_id) — replaying the same id later (when
      // the network returns) returns the existing row instead of
      // creating a duplicate. If POST /sessions fails for a retryable
      // reason (offline, DNS, 5xx), we keep the local id, schedule a
      // background re-register loop, and let the recorder/chunker run
      // normally. The worker tolerates SESSION_NOT_FOUND as transient
      // (see classifyError) so chunks emitted before registration just
      // back off and retry — base64Slice is preserved on disk/queue.
      setTestStatus('REC SESSION CREATING');
      await new Promise(r => setTimeout(r, 50));
      const localSessionId = Crypto.randomUUID();
      let sessionId: string = localSessionId;
      try {
        sessionId = await createSessionRequest(
          token,
          recordingMode,
          localSessionId,
        );
      } catch (err) {
        if (isRetryableSessionCreateError(err)) {
          await schedulePendingSessionRegistration(
            localSessionId,
            recordingMode,
          );
          console.log('GC_LOCAL_FIRST session deferred', {
            session_id: localSessionId,
            reason: err instanceof Error ? err.message : String(err),
          });
          setTestStatus('REC SESSION DEFERRED — sin conexión');
          await new Promise(r => setTimeout(r, 50));
        } else {
          throw err;
        }
      }
      sessionIdRef.current = sessionId;
      AsyncStorage.setItem(LAST_SESSION_ID_KEY, sessionId).catch(() => {});
      // Append to local history index (best-effort, never blocks the
      // recording flow). The index is the only source the History
      // screen has to enumerate past sessions; per-row real status is
      // still fetched live from GET /sessions/:id/chunks.
      appendHistoryEntry({
        session_id: sessionId,
        created_at: new Date().toISOString(),
        mode: recordingMode,
      });
      console.log('GC_VALIDATION: SESSION_CREATED', {
        session_id: sessionId,
        phase: 1,
        mode: recordingMode,
      });
      setTestStatus('REC SESSION CREATED');
      await new Promise(r => setTimeout(r, 50));

      let cacheUri: string;
      if (recordingMode === 'audio') {
        const recording = new Audio.Recording();
        await recording.prepareToRecordAsync(RECORDING_OPTIONS);
        await recording.startAsync();
        recordingRef.current = recording;

        const audioUri = recording.getURI();
        if (!audioUri) throw new Error('Recording URI is null after startAsync');
        cacheUri = audioUri;
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
        await new Promise(r => setTimeout(r, 800));

        // Snapshot baseline candidate files BEFORE recordAsync so the
        // diff after start uniquely identifies the in-flight file.
        const baseline = await listCachedVideoFiles();

        // Kick off recording. DO NOT await — the promise resolves only
        // when stopRecording() is called (returns the authoritative URI).
        // Quality settings come from CameraView props (videoQuality,
        // videoBitrate) and are logged here so the file-size envelope
        // is visible at session start, not just inferred from the
        // resulting mp4.
        console.log('VIDEO_RECORDING_OPTIONS', {
          quality: VIDEO_RECORDING_QUALITY,
          bitrate_bps: VIDEO_RECORDING_BITRATE_BPS,
          maxDuration: VIDEO_MAX_DURATION_S,
        });
        const recordPromise = cameraRef.current.recordAsync({
          maxDuration: VIDEO_MAX_DURATION_S,
        }) as Promise<{ uri: string } | undefined>;
        videoRecordPromiseRef.current = recordPromise;

        // Best-effort early URI discovery via cache listing-diff. This
        // is DIAGNOSTIC ONLY under the post-stop chunker: the
        // authoritative URI comes from `recordPromise.then(({uri}) =>
        // ...)` at stop, and `controller.chunkVideoFile(uri)` consumes
        // THAT — not the cache scan. A missing or late file is no
        // longer a hard failure; we log it and let the recording
        // continue. Earlier builds tore the recording down here on the
        // assumption the live chunker needed `cacheUri` to read from,
        // but that path no longer runs for video.
        let inFlightUri: string | null = null;
        const tCallStart = Date.now();
        const deadline = tCallStart + VIDEO_URI_DISCOVERY_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 200));
          const after = await listCachedVideoFiles();
          const novel = after.filter(
            a => !baseline.some(b => b.path === a.path),
          );
          if (novel.length > 0) {
            novel.sort((a, b) => b.modificationTime - a.modificationTime);
            inFlightUri = novel[0]!.path;
            break;
          }
        }
        if (inFlightUri) {
          videoRecordingUriRef.current = inFlightUri;
          cacheUri = inFlightUri;
          console.log('GC_DIAG: VIDEO_URI_DISCOVERED', {
            uri: inFlightUri,
            discovered_at_ms: Date.now() - tCallStart,
          });
        } else {
          // No novel cache file appeared inside the diagnostic window.
          // The recording is still alive (recordPromise was not
          // rejected); we just don't have a URI yet. The post-stop
          // chunker reads from the URI returned by the camera promise
          // at stopRecording, so this is recoverable. Empty placeholder
          // for queueAppendNewSession — `queueMarkRecordingClosed`
          // overwrites `entry.uri` with the authoritative URI at stop.
          videoRecordingUriRef.current = null;
          cacheUri = '';
          console.log('VIDEO_URI_DISCOVERY_PENDING', {
            waited_ms: Date.now() - tCallStart,
            note: 'Authoritative URI will be taken from recordPromise at stop',
          });
        }
      }

      await queueAppendNewSession({
        session_id: sessionId,
        uri: cacheUri,
        recording_closed: false,
        session_completed: false,
        complete_attempts: 0,
        emitted_base64_length: 0,
        next_chunk_index: 0,
        chunks: [],
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
      uploadDrainLoop().catch(err => {
        if (DEBUG_QUEUE) {
          console.log('GC_DEBUG drain rejected (from startRecording)', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      });

      setIsRecording(true);
      setTestStatus('REC STARTED');
      await new Promise(r => setTimeout(r, 50));
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      setTestStatus(`ERROR REC: ${message}`);
      console.log('ERROR REC:', error);
      sessionIdRef.current = null;
      // Make sure no half-started video state leaks if we threw after
      // recordAsync was invoked. Audio's recordingRef is cleared
      // separately in the recorder block on success; on failure either
      // it never got set or the throw happens before assignment.
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
      setIsStarting(false);
    }
  }

  async function stopRecording() {
    const audioRecording = recordingRef.current;
    const videoPromise = videoRecordPromiseRef.current;
    if (!audioRecording && !videoPromise) {
      setTestStatus('ERROR REC: no active recording');
      console.log('ERROR REC: no active recording on stop');
      return;
    }
    const sessionId = sessionIdRef.current;

    setIsStopping(true);
    let preMoveSize: number | null = null;
    let finalUri: string | null = null;
    try {
      setTestStatus('REC STOPPING');
      await new Promise(r => setTimeout(r, 50));

      let maybeUri: string | null;
      if (audioRecording) {
        await audioRecording.stopAndUnloadAsync();
        console.log('GC_DIAG: STOP_AND_UNLOAD_RETURNED');
        maybeUri = audioRecording.getURI();
        recordingRef.current = null;
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
      recordingRef.current = null;
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
        let uploaded = 0;
        let active = 0;
        let failed = 0;
        if (current) {
          total = current.chunks.length;
          for (const c of current.chunks) {
            if (c.status === 'uploaded') uploaded += 1;
            else if (c.status === 'pending' || c.status === 'uploading') active += 1;
            else if (c.status === 'failed') failed += 1;
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
            if (c.status === 'uploaded') u += 1;
            else if (c.status === 'pending' || c.status === 'uploading') hasActive = true;
          }
          if (hasActive) {
            bgActiveSessions_ += 1;
            bgUploaded_ += u;
            bgTotal_ += t;
          }
        }

        // Per-session protected detection. Walk the WHOLE queue and
        // for every entry whose chunks are non-empty AND all uploaded,
        // stamp `protectedShownAt` once — guarded by a Set so we never
        // re-stamp the same session_id. The first poll tick seeds the
        // set silently so a recovered queue with already-finished
        // entries does not flash a stale banner at boot.
        const newlyProtected: string[] = [];
        for (const entry of q) {
          const t = entry.chunks.length;
          if (t === 0) continue;
          const u = entry.chunks.filter(c => c.status === 'uploaded').length;
          if (u !== t) continue;
          if (seenProtectedSessionIdsRef.current.has(entry.session_id)) continue;
          seenProtectedSessionIdsRef.current.add(entry.session_id);
          if (!firstPollTickRef.current) newlyProtected.push(entry.session_id);
        }
        firstPollTickRef.current = false;

        if (!cancelled) {
          setTotalCount(total);
          setUploadedCount(uploaded);
          setActiveCount(active);
          setFailedCount(failed);
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
          if (total > 0 && uploaded === total) {
            setTestStatus(prev =>
              prev !== null &&
              (prev.startsWith('PHASE 1 DONE') || prev.startsWith('READY'))
                ? prev
                : `UPLOADED ${uploaded} / ${total}`,
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
        recordingRef.current !== null ||
        videoRecordPromiseRef.current !== null;
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
      if (nextState === 'active') {
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
    totalCount,
    uploadedCount,
    activeCount,
    failedCount,
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
  const phaseLabel =
    guardianStatus === 'grabando'
      ? 'Grabando'
      : guardianStatus === 'subiendo'
        ? `Guardando evidencia (${uploadedCount} / ${totalCount})`
        : guardianStatus === 'recuperando'
          ? 'Recuperando'
          : guardianStatus === 'protegido'
            ? 'Protegido'
            : guardianStatus === 'error'
              ? 'Error'
              : 'Listo';
  const phaseColor =
    guardianStatus === 'grabando'
      ? '#ff4d4d'
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
  const buttonLabel = showStop ? 'PARAR' : 'GRABAR';
  const buttonBg = showStop ? '#d73a49' : '#1f6feb';

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
          audio recordings never spin up the camera. Positioned offscreen
          (1×1 px, opacity 0). The recordAsync() call in startRecording
          writes to a growing .mp4 in cacheDirectory; the chunker reads
          slices from it the same way it reads the audio cache file. */}
      {mode === 'video' && (isStarting || isRecording) ? (
        <CameraView
          ref={(r) => {
            cameraRef.current = r;
          }}
          mode="video"
          videoQuality={VIDEO_RECORDING_QUALITY}
          videoBitrate={VIDEO_RECORDING_BITRATE_BPS}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 1,
            height: 1,
            opacity: 0,
          }}
        />
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

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: phaseColor,
            marginRight: 8,
          }}
        />
        <Text style={{ color: phaseColor, fontSize: 16, fontWeight: '600' }}>
          {phaseLabel}
        </Text>
      </View>

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

      {/* Destination indicator. Shows the currently active destination so
          the user never has to guess where evidence will land. No
          destination → the indicator explains that recording is blocked
          and offers a shortcut to the Settings screen. */}
      <DestinationIndicator drive={drive} loading={driveCheckLoading} />

      {/* Audio / Video mode toggle. Cosmetic in step 2 — flipping the
          state has no effect on what gets recorded yet. Locked while a
          session is starting, recording, or stopping so the chosen mode
          cannot change mid-flight. */}
      <ModeToggle
        mode={mode}
        onChange={setMode}
        disabled={isRecording || isStarting || isStopping}
      />

      <Pressable
        onPress={showStop ? stopRecording : startRecording}
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
            fontSize: 28,
            fontWeight: '700',
            letterSpacing: 2,
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

      {/* DEV-only hard reset. Long-press, gated on __DEV__. */}
      {__DEV__ ? (
        <Pressable
          onLongPress={async () => {
            if (isRecording || isStarting || isStopping) {
              Alert.alert('Reset bloqueado', 'Stop recording before reset.');
              return;
            }
            try {
              await hardResetAppState();
              Alert.alert('Reset hecho', 'App state cleared.');
            } catch (err) {
              Alert.alert(
                'Reset error',
                err instanceof Error ? err.message : String(err),
              );
            }
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

    </View>
  );
}

function DestinationIndicator({
  drive,
  loading,
}: {
  drive: PublicDestination | null | undefined;
  loading: boolean;
}) {
  const dotColor = loading ? '#8b949e' : drive ? '#3ddc84' : '#f85149';
  // Connected case is rendered as two stacked lines (main + email);
  // loading / not-connected keep the original single-line shape. Same
  // data sources as before — `drive.account_email` is still read straight
  // from the destination row, no logic change.
  const fallbackLabel = loading ? 'Comprobando destino…' : 'Sin destino conectado';

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
      {drive && !loading ? (
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
