import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { supabase } from '@/auth/supabase';
import { env } from '@/config/env';
import {
  getConnectedDrive,
  uploadChunkBytes,
  type PublicDestination,
} from '@/api/destinations';
import { useAuthStore } from '@/auth/store';

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

const CHUNK_SIZE_BYTES = 16 * 1024;
const CHUNK_SIZE_BASE64 =
  Math.ceil(Math.ceil((CHUNK_SIZE_BYTES * 4) / 3) / 4) * 4;

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

async function deriveChunksFromFile(uri: string): Promise<RealChunk[]> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const chunks: RealChunk[] = [];
  for (
    let index = 0, offset = 0;
    offset < base64.length;
    index++, offset += CHUNK_SIZE_BASE64
  ) {
    const slice = base64.substring(offset, offset + CHUNK_SIZE_BASE64);

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
  const offset = chunkIndex * CHUNK_SIZE_BASE64;
  return base64.substring(offset, offset + CHUNK_SIZE_BASE64);
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
  const res = await fetch(`${env.apiUrl}/chunks`, {
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
  const res = await fetch(`${env.apiUrl}/sessions/${sessionId}/chunks`, {
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
  const res = await fetch(`${env.apiUrl}/sessions/${sessionId}/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export default function Index() {
  const [testStatus, setTestStatus] = useState<string>('BOOT');
  const [isRecording, setIsRecording] = useState(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const tokenRef = useRef<string | null>(null);
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

  function resetProgress() {
    setUploadedCount(0);
    setTotalCount(0);
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
          setTestStatus('ERROR AUTH');
          console.log('ERROR:', authError);
          return;
        }

        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) {
          setTestStatus('TOKEN MISSING');
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

        const persistedRaw = await AsyncStorage.getItem(PENDING_RETRY_KEY);

        if (persistedRaw) {
          // ---------- PHASE 2: resumed after relaunch ----------
          setIsRecovering(true);
          const pending = JSON.parse(persistedRaw) as PendingState;
          setTestStatus('RECOVERED STATE');
          await new Promise(r => setTimeout(r, 50));
          console.log('RECOVERED STATE:', pending);
          console.log('GC_VALIDATION: PHASE2_ENTER', {
            session_id: pending.session_id,
            remaining_indexes: pending.remaining.map(c => c.chunk_index),
            has_uri: Boolean(pending.uri),
          });

          // X / N progress mirror for the remaining batch. Total is what
          // we need to re-send; we don't reconstruct "already uploaded"
          // from a remote lookup because recovery MUST work offline-first
          // for the metadata flow. The counter resets on entry so a
          // second Phase 2 run (rare) doesn't carry over stale numbers.
          setTotalCount(pending.remaining.length);
          setUploadedCount(0);

          // If the persisted state carries a `uri` AND the kill switch
          // is on AND the file still exists, read the base64 once so
          // every remaining chunk can be re-sliced and re-uploaded to
          // Drive. Failure to obtain bytes is NOT fatal — recovery
          // degrades to metadata-only (remote_reference=null on
          // /chunks), which still tracks the chunk in the DB but loses
          // the Drive linkage for any chunk that Phase 1 had not
          // already written to Drive.
          //
          // Legacy PENDING_RETRY_KEY entries from pre-Phase-4 builds
          // have no `uri` field — they fall into the degraded path.
          let recoveryBase64: string | null = null;
          let phase2ModeReason = 'kill_switch_off';
          if (DRIVE_CHUNK_UPLOAD_ENABLED && pending.uri) {
            try {
              const fileInfo = await FileSystem.getInfoAsync(pending.uri);
              if (fileInfo.exists) {
                recoveryBase64 = await readRecordingBase64(pending.uri);
                console.log('RECOVERY BASE64 READ OK:', {
                  length: recoveryBase64.length,
                });
                phase2ModeReason = 'uri_present_and_file_exists';
              } else {
                console.log(
                  'RECOVERY BASE64 SKIPPED: file not found at persisted uri — falling back to metadata-only',
                  { uri: pending.uri },
                );
                phase2ModeReason = 'file_missing';
              }
            } catch (error) {
              console.log(
                'RECOVERY BASE64 SKIPPED: read failed — falling back to metadata-only',
                error,
              );
              recoveryBase64 = null;
              phase2ModeReason = 'read_failed';
            }
          } else if (!DRIVE_CHUNK_UPLOAD_ENABLED) {
            phase2ModeReason = 'kill_switch_off';
          } else {
            phase2ModeReason = 'no_uri_in_pending';
          }
          console.log('GC_VALIDATION: PHASE2_MODE', {
            session_id: pending.session_id,
            mode: recoveryBase64 !== null ? 'drive-upload' : 'metadata-only',
            reason: phase2ModeReason,
          });

          let failed = false;
          for (const chunk of pending.remaining) {
            try {
              // If we have the bytes, re-slice, re-hash (guardrail) and
              // re-upload to Drive before registering. Hash MUST match
              // the value already in the pending plan — if it doesn't,
              // something has corrupted the recording or changed the
              // slicing rule since Phase 1, and silently proceeding
              // would let us upload the WRONG bytes under this chunk's
              // row. Break out of the loop and leave the pending state
              // intact so the next launch can retry or surface to the
              // user; do NOT advance.
              let recoveryRemoteRef: string | null = null;
              if (recoveryBase64 !== null) {
                const recoverySlice = base64SliceAt(
                  recoveryBase64,
                  chunk.chunk_index,
                );
                // Guardrail: re-hash MUST match the chunk.hash stored
                // in PENDING_RETRY_KEY. Both sides use the unified rule
                // — sha256 over the DECODED bytes (see sliceToBytes /
                // deriveChunksFromFile) — so any mismatch here means
                // the recording on disk has been corrupted or the
                // slicing rule drifted. Either way, abort and keep
                // pending state intact for the next launch.
                const recoveryBytes = sliceToBytes(recoverySlice);
                const recoveredHash = bytesDigestToHex(
                  await Crypto.digest(
                    Crypto.CryptoDigestAlgorithm.SHA256,
                    recoveryBytes,
                  ),
                );
                if (recoveredHash !== chunk.hash) {
                  setTestStatus(
                    `ERROR HASH MISMATCH index=${chunk.chunk_index}`,
                  );
                  console.log(
                    `ERROR HASH MISMATCH index=${chunk.chunk_index}: expected=${chunk.hash} got=${recoveredHash} — aborting Phase 2 with pending state intact`,
                  );
                  failed = true;
                  break;
                }
                setTestStatus(
                  `CHUNK RESUME UPLOAD BYTES index=${chunk.chunk_index}`,
                );
                await new Promise(r => setTimeout(r, 50));
                const upR = await uploadChunkBytes(
                  pending.session_id,
                  chunk.chunk_index,
                  chunk.hash,
                  recoverySlice,
                );
                recoveryRemoteRef = upR.remote_reference;
                console.log(
                  `CHUNK RESUME DRIVE OK index=${chunk.chunk_index}:`,
                  upR,
                );
                console.log('GC_VALIDATION: CHUNK_DRIVE_OK', {
                  phase: 2,
                  chunk_index: chunk.chunk_index,
                  hash_short: chunk.hash.substring(0, 12),
                  remote_reference: recoveryRemoteRef,
                  dedup: upR.dedup,
                });
              }

              const r = await postChunk(
                token,
                pending.session_id,
                chunk,
                'uploaded',
                recoveryRemoteRef,
              );
              setUploadedCount(u => u + 1);
              setTestStatus(`CHUNK RESUME index=${chunk.chunk_index}`);
              await new Promise(r => setTimeout(r, 50));
              console.log(
                `CHUNK RESUME index=${chunk.chunk_index}:`,
                r,
              );
              console.log('GC_VALIDATION: CHUNK_POSTED', {
                phase: 2,
                chunk_index: chunk.chunk_index,
                hash_short: chunk.hash.substring(0, 12),
                remote_reference: recoveryRemoteRef,
                idempotent_replay:
                  (r as { idempotent_replay?: boolean } | null)?.idempotent_replay ?? false,
              });

              // DEBUG-only idempotency probe, recovery variant. Fire
              // once for chunk_index=1 only — the chunk that the
              // failure-injection flow left pending on first launch.
              // The second POST must come back with
              // idempotent_replay: true; otherwise recovery would be
              // able to create duplicate rows under real retries.
              if (DEBUG_DUPLICATE_SUBMISSION && chunk.chunk_index === 1) {
                setTestStatus(
                  `CHUNK DUPLICATE DETECTED index=${chunk.chunk_index}`,
                );
                await new Promise(r => setTimeout(r, 50));
                console.log(
                  `CHUNK DUPLICATE DETECTED index=${chunk.chunk_index}: resending during recovery`,
                );
                try {
                  // Same pattern as the Phase 1 probe: reuse the
                  // remote_reference from the first recovery POST so
                  // we are testing backend metadata idempotency, not
                  // Drive dedupe. A null recoveryRemoteRef means the
                  // degraded path was active; the probe still works
                  // against metadata idempotency regardless.
                  const dup = (await postChunk(
                    token,
                    pending.session_id,
                    chunk,
                    'uploaded',
                    recoveryRemoteRef,
                  )) as { idempotent_replay?: boolean };
                  if (dup.idempotent_replay === true) {
                    setTestStatus(
                      `CHUNK IDEMPOTENT OK index=${chunk.chunk_index}`,
                    );
                    await new Promise(r => setTimeout(r, 50));
                    console.log(
                      `CHUNK IDEMPOTENT OK index=${chunk.chunk_index}:`,
                      dup,
                    );
                  } else {
                    setTestStatus(
                      `CHUNK IDEMPOTENT UNEXPECTED index=${chunk.chunk_index} replay=${dup.idempotent_replay}`,
                    );
                    await new Promise(r => setTimeout(r, 50));
                    console.log(
                      `CHUNK IDEMPOTENT UNEXPECTED index=${chunk.chunk_index}:`,
                      dup,
                    );
                  }
                } catch (error) {
                  setTestStatus(
                    `ERROR CHUNK DUPLICATE index=${chunk.chunk_index}`,
                  );
                  console.log(
                    `ERROR CHUNK DUPLICATE index=${chunk.chunk_index}:`,
                    error,
                  );
                }
              }
            } catch (error) {
              setTestStatus(
                `ERROR CHUNK RESUME index=${chunk.chunk_index}`,
              );
              console.log(
                `ERROR CHUNK RESUME index=${chunk.chunk_index}:`,
                error,
              );
              failed = true;
              break; // keep pending state; let user reload to try again
            }
          }

          if (failed) return;

          try {
            const listed = await getChunks(token, pending.session_id);
            setTestStatus('CHUNKS FETCHED');
            await new Promise(r => setTimeout(r, 50));
            console.log('CHUNKS FETCHED:', listed);
          } catch (error) {
            setTestStatus('ERROR CHUNKS FETCH');
            console.log('ERROR CHUNKS FETCH:', error);
          }

          // All remaining chunks have been uploaded — transition the
          // session to `completed`. Wrapped in its own try/catch so a
          // completion failure does NOT regress the already-working
          // recovery path: the chunks are safe on the server regardless.
          try {
            setTestStatus('SESSION COMPLETE START');
            await new Promise(r => setTimeout(r, 50));
            console.log('SESSION COMPLETE START:', pending.session_id);
            const completed = await completeSession(token, pending.session_id);
            setTestStatus('SESSION COMPLETE OK');
            await new Promise(r => setTimeout(r, 50));
            console.log('SESSION COMPLETE OK:', completed);
            console.log('GC_VALIDATION: SESSION_COMPLETED', {
              mode: 'phase2',
              session_id: pending.session_id,
            });
            // Only clear pending on confirmed completion. If the POST
            // /sessions/:id/complete call threw, leave PENDING_RETRY_KEY
            // intact so the next launch retries: Phase 2 re-enters with
            // remaining=[], the chunk loop is a no-op, and it retries
            // completeSession alone. Chunks are server-safe regardless.
            await AsyncStorage.removeItem(PENDING_RETRY_KEY);
            console.log('GC_VALIDATION: PENDING_CLEARED', {
              session_id: pending.session_id,
              mode: 'phase2',
            });
            // Best-effort cleanup of the moved recording file. Only
            // acts on docDir uris, so legacy cacheDir pending states
            // from pre-Phase-4 builds are untouched.
            await deleteRecordingBestEffort(pending.uri);
            setTestStatus('PHASE 2 DONE');
            console.log('PHASE 2 DONE — pending cleared');
          } catch (error) {
            setTestStatus('SESSION COMPLETE ERROR');
            await new Promise(r => setTimeout(r, 50));
            console.log('SESSION COMPLETE ERROR:', error);
          }

          // Clear the progress counter on Phase 2 completion so a fresh
          // Phase 1 start doesn't inherit 'N/N uploaded' from recovery.
          resetProgress();
          setIsRecovering(false);
          return;
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
    if (isStartingRef.current || recordingRef.current) {
      console.log('REC START ignored — already starting or recording');
      return;
    }
    isStartingRef.current = true;
    setIsStarting(true);
    try {
      setTestStatus('REC START');
      await new Promise(r => setTimeout(r, 50));
      console.log('REC START — manual trigger');

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) throw new Error('RECORD_AUDIO permission denied');
      setTestStatus('REC PERMISSION OK');
      await new Promise(r => setTimeout(r, 50));

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      setTestStatus('REC MODE SET');
      await new Promise(r => setTimeout(r, 50));

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
      setTestStatus('REC STARTED');
      await new Promise(r => setTimeout(r, 50));
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      setTestStatus(`ERROR REC: ${message}`);
      console.log('ERROR REC:', error);
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
    }
  }

  async function stopRecording() {
    const recording = recordingRef.current;
    if (!recording) {
      setTestStatus('ERROR REC: no active recording');
      console.log('ERROR REC: recordingRef is null on stop');
      return;
    }

    setIsStopping(true);
    let uri: string;
    try {
      setTestStatus('REC STOPPING');
      await new Promise(r => setTimeout(r, 50));
      await recording.stopAndUnloadAsync();
      const maybeUri = recording.getURI();
      recordingRef.current = null;
      setIsRecording(false);
      if (!maybeUri) throw new Error('Recording URI is null');
      uri = maybeUri;
      setTestStatus('REC DONE');
      await new Promise(r => setTimeout(r, 50));
      console.log('REC DONE — uri:', uri);

      // Move the recording out of cacheDirectory (where expo-av drops
      // it) into documentDirectory, so that a kill/reboot in the
      // middle of the upload loop cannot have the OS evict the file
      // before Phase 2 relaunches.
      //
      // documentDirectory is the expo-file-system location for data
      // the app explicitly wants to persist; it survives app kills,
      // device reboots, and low-storage reclaim events that
      // cacheDirectory is subject to.
      //
      // Best-effort: if the move fails (readonly partition, unusual
      // source URI, etc.) we log and fall through with the original
      // uri. Phase 1 then still works (the file is still readable
      // right now); recovery on next launch will degrade to metadata-
      // only for any chunk we can't re-read. Evidence that already
      // landed in Drive is unaffected.
      if (FileSystem.documentDirectory) {
        const extMatch = uri.match(/\.[A-Za-z0-9]{1,8}$/);
        const ext = extMatch ? extMatch[0] : '.m4a';
        const movedUri = `${FileSystem.documentDirectory}guardian_recording_${Date.now()}${ext}`;
        try {
          await FileSystem.moveAsync({ from: uri, to: movedUri });
          uri = movedUri;
          console.log('REC MOVED TO DOCDIR:', uri);
        } catch (moveError) {
          console.log(
            'REC MOVE WARN — keeping original cacheDir uri; recovery may degrade to metadata-only if the OS purges it:',
            moveError,
          );
        }
      }
    } catch (error) {
      recordingRef.current = null;
      setIsRecording(false);
      setIsStopping(false);
      const message = (error as Error).message ?? String(error);
      setTestStatus(`ERROR REC: ${message}`);
      console.log('ERROR REC:', error);
      return;
    }

    const token = tokenRef.current;
    if (!token) {
      setIsStopping(false);
      setTestStatus('TOKEN MISSING');
      console.log('ERROR: tokenRef empty at stopRecording');
      return;
    }

    try {
      await runPhase1Upload(token, uri);
    } finally {
      setIsStopping(false);
    }
  }

  async function runPhase1Upload(token: string, uri: string) {
    try {
      // ---------- PHASE 1: fresh run ----------
      setTestStatus('PHASE 1 START');
      await new Promise(r => setTimeout(r, 50));
      console.log('PHASE 1 START — no pending retry in storage');

      const info = await FileSystem.getInfoAsync(uri);
      console.log('FILE INFO:', {
        exists: info.exists,
        size: info.exists ? (info as { size?: number }).size : null,
      });

      let chunks: RealChunk[];
      try {
        chunks = await deriveChunksFromFile(uri);
        // Seed the X / N counter from the derived chunk set. uploaded
        // stays at 0 until the first POST /chunks succeeds. This is
        // purely additive UI; it never affects the upload path.
        setTotalCount(chunks.length);
        setUploadedCount(0);
        setTestStatus(`CHUNKS DERIVED: ${chunks.length}`);
        await new Promise(r => setTimeout(r, 50));
        console.log('CHUNKS DERIVED:', chunks.length);
        for (const c of chunks) {
          console.log(
            `  index=${c.chunk_index} size=${c.size} hash=${c.hash}`,
          );
        }
      } catch (error) {
        setTestStatus('ERROR DERIVE');
        console.log('ERROR DERIVE:', error);
        return;
      }

      // MVP rule (CLAUDE.md priority 1 — "subida fiable de chunks"):
      // accept any non-empty, well-formed chunk set. The only truly
      // invalid recording is one that produced zero chunks (no usable
      // evidence). Rejecting a valid single-chunk recording would throw
      // away evidence the system was built to preserve.
      setTestStatus('ZZ_BEFORE_CHUNK_COUNT_VALIDATION');
      await new Promise(r => setTimeout(r, 50));

      const totalBytes = chunks.reduce((sum, c) => sum + c.size, 0);
      console.log('CHUNK COUNT VALIDATION:', {
        chunk_count: chunks.length,
        total_bytes: totalBytes,
      });

      if (chunks.length < 1) {
        setTestStatus('ZZ_CHUNK_COUNT_VALIDATION_FAILED: no usable evidence');
        console.log(
          'ZZ_CHUNK_COUNT_VALIDATION_FAILED: 0 chunks derived — reason: recording produced no bytes. Nothing to upload.',
        );
        return;
      }

      console.log(
        `CHUNK COUNT VALIDATION ACCEPTED: ${chunks.length} chunk(s), ${totalBytes} bytes total — proceeding with upload`,
      );

      // Read the recording as base64 ONCE for the whole Phase 1 flow.
      // `deriveChunksFromFile` already read+hashed the file; we re-read
      // here (rather than reuse) because the user requires
      // `deriveChunksFromFile`'s signature to stay intact. The cost is
      // one extra FileSystem read per recording — acceptable for the
      // MVP, and the pre-chunk validation has already cleared "empty /
      // unreadable" outcomes.
      //
      // Only reached when the kill switch is on. When off, we skip the
      // read entirely and every chunk POSTs with remote_reference=null.
      // Failure here returns early BEFORE creating a session — the
      // recording is useless without bytes we can send to Drive, so
      // there's no point occupying a session_id.
      let base64Full: string | null = null;
      if (DRIVE_CHUNK_UPLOAD_ENABLED) {
        try {
          base64Full = await readRecordingBase64(uri);
          console.log(
            'BASE64 READ OK:',
            { length: base64Full.length },
          );
        } catch (error) {
          setTestStatus('ERROR BASE64 READ');
          console.log('ERROR BASE64 READ:', error);
          return;
        }
      }

      setTestStatus('ZZ_BEFORE_SESSION_REQUEST');
      await new Promise(r => setTimeout(r, 50));

      const sessionBody = JSON.stringify({
        user_id: 'test_user',
        mode: 'audio',
        destination_type: 'drive',
      });

      setTestStatus('ZZ_SESSION_REQUEST_BODY_READY');
      await new Promise(r => setTimeout(r, 50));

      // DEBUG: print the exact URL baked into the bundle at the moment of
      // fetch. If this does not match http://10.0.2.2:3000/sessions on the
      // emulator, Metro is serving a stale bundle built against a different
      // .env (e.g. .env.device). Removing this after diagnosis is fine.
      const sessionsUrl = `${env.apiUrl}/sessions`;
      setTestStatus(`ZZ_FETCH_URL: ${sessionsUrl}`);
      await new Promise(r => setTimeout(r, 50));
      console.log('ZZ_FETCH_URL:', sessionsUrl);

      // DEBUG: dump the full request shape so we can see whether POST
      // construction itself is malformed. Only headers KEYS are logged
      // (no secret values). Body preview capped at 200 chars. Remove once
      // POST /sessions succeeds end-to-end.
      console.log('ZZ_REQUEST_SHAPE:', {
        url: sessionsUrl,
        method: 'POST',
        headersKeys: ['Content-Type', 'Authorization'],
        authorizationPresent: Boolean(token),
        bodyLength: sessionBody.length,
        bodyPreview: sessionBody.substring(0, 200),
      });

      // DEBUG: sanity probe — hit /health with the SAME fetch API the POST
      // uses, from the SAME code path, moments before POST. If this GET
      // succeeds and the POST still produces no REQ_INCOMING on the
      // backend, the problem is in the POST request shape or fetch options
      // (not in base connectivity / bind / firewall / cleartext). Remove
      // once POST /sessions is confirmed working.
      const healthUrl = `${env.apiUrl}/health`;
      setTestStatus('ZZ_HEALTH_PROBE_START');
      await new Promise(r => setTimeout(r, 50));
      try {
        const healthRes = await fetch(healthUrl);
        setTestStatus(`ZZ_HEALTH_PROBE_OK status=${healthRes.status}`);
        await new Promise(r => setTimeout(r, 50));
        console.log('ZZ_HEALTH_PROBE_OK:', { status: healthRes.status });
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        const message = error instanceof Error ? error.message : String(error);
        setTestStatus(`ZZ_HEALTH_PROBE_FAIL name=${name} msg=${message}`);
        await new Promise(r => setTimeout(r, 50));
        console.log('ZZ_HEALTH_PROBE_FAIL:', { name, message, error });
      }

      setTestStatus('ZZ_FETCH_POST_START');
      await new Promise(r => setTimeout(r, 50));

      // Production-shape client timeout for POST /sessions. Sits above
      // the backend's own 4000ms auth race and 8000ms DB race only for
      // auth; a request that legitimately needs the full 8s DB budget on
      // cold Supabase will abort here and be retried on next launch —
      // acceptable for the MVP since /sessions is idempotent from the
      // client's perspective (no chunks have been uploaded yet).
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      let res!: Response;
      try {
        res = await fetch(`${env.apiUrl}/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: sessionBody,
          signal: controller.signal,
        });
      } catch (error) {
        // DEBUG: log error.name, error.message, String(error), and the
        // AbortController state SEPARATELY so we can tell a pre-dispatch
        // TypeError ("Network request failed" before any I/O) from a
        // client-side timeout abort from a server-side disconnect.
        const isAbort = controller.signal.aborted;
        const name = error instanceof Error ? error.name : 'unknown';
        const message = error instanceof Error ? error.message : String(error);
        const stringified = String(error);
        setTestStatus(
          `ZZ_ERROR_SESSION: name=${name} msg=${message} aborted=${isAbort}`,
        );
        await new Promise(r => setTimeout(r, 50));
        console.log('ZZ_ERROR_SESSION DETAILS:', {
          name,
          message,
          stringified,
          aborted: isAbort,
          errorObject: error,
        });
        return;
      } finally {
        clearTimeout(timeoutId);
      }

      setTestStatus(`ZZ_SESSION_RESPONSE_RECEIVED (status ${res.status})`);
      await new Promise(r => setTimeout(r, 50));

      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        setTestStatus(`ZZ_ERROR_SESSION: HTTP ${res.status} ${text}`);
        console.log('ZZ_ERROR_SESSION: HTTP', res.status, text);
        return;
      }

      let data!: { session_id?: string };
      try {
        data = await res.json();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setTestStatus(`ZZ_ERROR_SESSION: bad JSON (${message})`);
        console.log('ZZ_ERROR_SESSION: bad JSON:', error);
        return;
      }

      setTestStatus('ZZ_SESSION_RESPONSE_OK');
      await new Promise(r => setTimeout(r, 50));
      console.log('SESSION CREATED:', data);
      console.log('GC_VALIDATION: SESSION_CREATED', {
        session_id: data.session_id,
        phase: 1,
      });

      const sessionId = data.session_id;
      if (!sessionId) {
        setTestStatus('ZZ_ERROR_SESSION: no session_id in response');
        console.log('ZZ_ERROR_SESSION: no session_id in response');
        return;
      }
      setTestStatus('SESSION CREATED');
      await new Promise(r => setTimeout(r, 50));

      // Persist the full upload plan BEFORE any chunk POST so that a
      // force-close or device reboot between chunks still triggers
      // Phase 2 recovery on next launch. Without this, the existing
      // catch-only write only covers the narrow case of a caught
      // fetch exception — it misses real kill scenarios (TEST_SCENARIOS
      // #3 and #4). Same { session_id, remaining } schema Phase 2
      // already consumes.
      await AsyncStorage.setItem(
        PENDING_RETRY_KEY,
        JSON.stringify({ session_id: sessionId, remaining: chunks, uri }),
      );
      console.log('GC_VALIDATION: PENDING_PERSISTED', {
        event: 'initial',
        session_id: sessionId,
        remaining_indexes: chunks.map(c => c.chunk_index),
        has_uri: Boolean(uri),
      });

      // chunks[0] → bytes to Drive (proxy) → metadata to our backend.
      //
      // Order matters: Drive first, then /chunks with the returned
      // remote_reference. If Drive throws, we never register the chunk
      // — Phase 2 will retry both steps on next launch, and Drive
      // dedupe (filename lookup) collapses a re-upload onto the same
      // file_id so we never create duplicates in the user's Drive.
      //
      // The whole pair sits inside the same try/catch as before: any
      // failure (Drive OR /chunks) ends Phase 1, leaves the full
      // PENDING_RETRY_KEY plan in place, and lets Phase 2 take over.
      let remoteRef0: string | null = null;
      try {
        if (DRIVE_CHUNK_UPLOAD_ENABLED && base64Full !== null) {
          const chunk0 = chunks[0] as RealChunk;
          const slice0 = base64SliceAt(base64Full, chunk0.chunk_index);
          setTestStatus('CHUNK 0 UPLOAD BYTES');
          await new Promise(r => setTimeout(r, 50));
          const up0 = await uploadChunkBytes(
            sessionId,
            chunk0.chunk_index,
            chunk0.hash,
            slice0,
          );
          remoteRef0 = up0.remote_reference;
          console.log('CHUNK 0 DRIVE OK:', up0);
          console.log('GC_VALIDATION: CHUNK_DRIVE_OK', {
            phase: 1,
            chunk_index: (chunks[0] as RealChunk).chunk_index,
            hash_short: (chunks[0] as RealChunk).hash.substring(0, 12),
            remote_reference: remoteRef0,
            dedup: up0.dedup,
          });
        }
        const r0 = await postChunk(
          token,
          sessionId,
          chunks[0] as RealChunk,
          'uploaded',
          remoteRef0,
        );
        setUploadedCount(u => u + 1);
        setTestStatus('CHUNK 0 OK');
        await new Promise(r => setTimeout(r, 50));
        console.log('CHUNK POST index=0 status=uploaded:', r0);
        console.log('GC_VALIDATION: CHUNK_POSTED', {
          phase: 1,
          chunk_index: (chunks[0] as RealChunk).chunk_index,
          hash_short: (chunks[0] as RealChunk).hash.substring(0, 12),
          remote_reference: remoteRef0,
          idempotent_replay:
            (r0 as { idempotent_replay?: boolean } | null)?.idempotent_replay ?? false,
        });
        // Shrink the pending plan so a kill between here and chunks[1]
        // resumes from index 1, not from 0. Chunk 0 is server-safe; a
        // re-POST would still be idempotent but we avoid the wasted trip.
        await AsyncStorage.setItem(
          PENDING_RETRY_KEY,
          JSON.stringify({
            session_id: sessionId,
            remaining: chunks.slice(1),
            uri,
          }),
        );
        console.log('GC_VALIDATION: PENDING_PERSISTED', {
          event: 'shrink_after_index_0',
          session_id: sessionId,
          remaining_indexes: chunks.slice(1).map(c => c.chunk_index),
          has_uri: Boolean(uri),
        });
      } catch (error) {
        setTestStatus('ERROR CHUNK 0');
        console.log('ERROR CHUNK 0:', error);
        return;
      }

      // DEBUG-only idempotency probe for chunk 0. Session is still
      // `active` at this point (Phase 1 has not run completeSession
      // yet for multi-chunk recordings), so the backend must accept
      // the duplicate and return idempotent_replay: true. If a 409
      // SESSION_NOT_ACTIVE comes back, something completed the
      // session out from under us.
      if (DEBUG_DUPLICATE_SUBMISSION) {
        setTestStatus('CHUNK DUPLICATE DETECTED index=0');
        await new Promise(r => setTimeout(r, 50));
        console.log('CHUNK DUPLICATE DETECTED index=0: resending same hash/status');
        try {
          // Re-use the remote_reference captured from the first chunks[0]
          // upload. This probe is strictly for BACKEND metadata
          // idempotency — we are NOT exercising Drive dedupe here, so
          // no second uploadChunkBytes call. Sending the same
          // remote_reference keeps the POST shape bit-for-bit identical
          // between the original and the replay.
          const dup = (await postChunk(
            token,
            sessionId,
            chunks[0] as RealChunk,
            'uploaded',
            remoteRef0,
          )) as { idempotent_replay?: boolean; chunk_index?: number };
          if (dup.idempotent_replay === true) {
            setTestStatus('CHUNK IDEMPOTENT OK index=0');
            await new Promise(r => setTimeout(r, 50));
            console.log('CHUNK IDEMPOTENT OK index=0:', dup);
          } else {
            setTestStatus(
              `CHUNK IDEMPOTENT UNEXPECTED index=0 replay=${dup.idempotent_replay}`,
            );
            await new Promise(r => setTimeout(r, 50));
            console.log('CHUNK IDEMPOTENT UNEXPECTED index=0:', dup);
          }
        } catch (error) {
          setTestStatus('ERROR CHUNK DUPLICATE index=0');
          console.log('ERROR CHUNK DUPLICATE index=0:', error);
        }
      }

      // Single-chunk recording: chunks[0] is already uploaded, there is
      // no chunks[1] to exercise the network-failure path with, and there
      // is nothing pending to persist or recover. The session is already
      // in a consistent, complete state. Report Phase 1 done and exit —
      // MVP priority is evidence survival, not running every test branch.
      if (chunks.length < 2) {
        // Single-chunk session is fully uploaded — mark it completed
        // so it never lingers in `active`. Same try/catch contract as
        // Phase 2: completion failure is surfaced but does not void the
        // uploaded chunk.
        try {
          setTestStatus('SESSION COMPLETE START');
          await new Promise(r => setTimeout(r, 50));
          console.log('SESSION COMPLETE START:', sessionId);
          const completed = await completeSession(token, sessionId);
          setTestStatus('SESSION COMPLETE OK');
          await new Promise(r => setTimeout(r, 50));
          console.log('SESSION COMPLETE OK:', completed);
          console.log('GC_VALIDATION: SESSION_COMPLETED', {
            mode: 'single-chunk',
            session_id: sessionId,
          });
          // Only clear pending on confirmed completion. If completeSession
          // throws, leave PENDING_RETRY_KEY so the next launch retries via
          // Phase 2 (remaining=[] → chunk loop is a no-op → completeSession
          // retry only). Chunks are server-safe regardless.
          await AsyncStorage.removeItem(PENDING_RETRY_KEY);
          console.log('GC_VALIDATION: PENDING_CLEARED', {
            session_id: sessionId,
            mode: 'single-chunk',
          });
          // Best-effort cleanup of the moved recording. Docdir-only
          // guard inside the helper protects cache/legacy uris.
          await deleteRecordingBestEffort(uri);
        } catch (error) {
          setTestStatus('SESSION COMPLETE ERROR');
          await new Promise(r => setTimeout(r, 50));
          console.log('SESSION COMPLETE ERROR:', error);
        }

        setTestStatus(
          'PHASE 1 DONE — single-chunk recording (no recovery needed)',
        );
        console.log(
          'PHASE 1 DONE — single-chunk recording: chunks[0] already uploaded, no pending state persisted, no recovery needed',
        );
        // UI-only counter reset. The backend/session state is already
        // safe — clearing this just stops the UI from showing a stale
        // "1 / 1" the next time the user opens the screen.
        resetProgress();
        return;
      }

      // Real multi-chunk upload. Sequential POST of chunks[1..N-1].
      // On any fetch throw (radio drop, DNS fail, socket close, 5xx
      // parsed into a throw, etc.) we persist { session_id,
      // remaining: chunks[i..N-1] } and return; Phase 2 on the next
      // launch picks up from exactly that index. Server-side
      // idempotency (UNIQUE(session_id, chunk_index) + hash
      // reconciliation) makes resending any already-registered chunk
      // safe if the client believes a chunk failed that the server
      // actually stored.
      //
      // DEBUG_INJECT_CHUNK1_FAILURE, when true, short-circuits the
      // i=1 iteration so Phase 2 recovery can be exercised without
      // toggling the emulator radio. No effect when false — this is
      // the real production-shape loop.
      for (let i = 1; i < chunks.length; i++) {
        try {
          if (DEBUG_INJECT_CHUNK1_FAILURE && i === 1) {
            setTestStatus('DEBUG_CHUNK1_INJECTED_FAILURE');
            await new Promise(r => setTimeout(r, 50));
            console.log(
              'DEBUG_CHUNK1_INJECTED_FAILURE — simulated failure on chunk 1; no real POST. Remainder will be persisted for Phase 2.',
            );
            throw new Error('DEBUG_INJECT_CHUNK1_FAILURE');
          }

          // Same order as chunks[0]: Drive first, /chunks second.
          // Any throw here lands in the catch below, which persists
          // { remaining: chunks[i..N-1] } and returns. Phase 2 picks
          // up from exactly index i; Drive dedupe guarantees no
          // duplicate files if bytes landed before the crash.
          const chunkI = chunks[i] as RealChunk;
          let remoteRef: string | null = null;
          if (DRIVE_CHUNK_UPLOAD_ENABLED && base64Full !== null) {
            const sliceI = base64SliceAt(base64Full, chunkI.chunk_index);
            setTestStatus(`CHUNK ${i} UPLOAD BYTES`);
            await new Promise(r => setTimeout(r, 50));
            const upI = await uploadChunkBytes(
              sessionId,
              chunkI.chunk_index,
              chunkI.hash,
              sliceI,
            );
            remoteRef = upI.remote_reference;
            console.log(`CHUNK ${i} DRIVE OK:`, upI);
            console.log('GC_VALIDATION: CHUNK_DRIVE_OK', {
              phase: 1,
              chunk_index: chunkI.chunk_index,
              hash_short: chunkI.hash.substring(0, 12),
              remote_reference: remoteRef,
              dedup: upI.dedup,
            });
          }

          const r = await postChunk(
            token,
            sessionId,
            chunkI,
            'uploaded',
            remoteRef,
          );
          setUploadedCount(u => u + 1);
          setTestStatus(`CHUNK ${i} OK`);
          await new Promise(r => setTimeout(r, 50));
          console.log(
            `CHUNK POST index=${i} status=uploaded:`,
            r,
          );
          console.log('GC_VALIDATION: CHUNK_POSTED', {
            phase: 1,
            chunk_index: chunkI.chunk_index,
            hash_short: chunkI.hash.substring(0, 12),
            remote_reference: remoteRef,
            idempotent_replay:
              (r as { idempotent_replay?: boolean } | null)?.idempotent_replay ?? false,
          });
          // Shrink the pending plan so a kill between here and
          // chunks[i+1] resumes from i+1. If the app dies mid-write,
          // Phase 2 re-POSTs chunks[i] and server idempotency absorbs it.
          await AsyncStorage.setItem(
            PENDING_RETRY_KEY,
            JSON.stringify({
              session_id: sessionId,
              remaining: chunks.slice(i + 1),
              uri,
            }),
          );
          console.log('GC_VALIDATION: PENDING_PERSISTED', {
            event: `shrink_after_index_${i}`,
            session_id: sessionId,
            remaining_indexes: chunks.slice(i + 1).map(c => c.chunk_index),
            has_uri: Boolean(uri),
          });
        } catch (error) {
          const remaining = chunks.slice(i);
          await AsyncStorage.setItem(
            PENDING_RETRY_KEY,
            JSON.stringify({
              session_id: sessionId,
              remaining,
              uri,
            }),
          );
          console.log('GC_VALIDATION: PENDING_PERSISTED', {
            event: 'pause_on_error',
            session_id: sessionId,
            remaining_indexes: remaining.map(c => c.chunk_index),
            has_uri: Boolean(uri),
          });
          console.log('GC_VALIDATION: PHASE1_PAUSED', {
            session_id: sessionId,
            pending_count: remaining.length,
          });
          setTestStatus(
            `PHASE 1 PAUSED — pending=${remaining.length} chunk(s). Reload to retry.`,
          );
          await new Promise(r => setTimeout(r, 50));
          console.log(
            `PHASE 1 PAUSED — network failure on chunk ${i}, persisted ${remaining.length} remaining. Reload the app to trigger Phase 2.`,
            error,
          );
          return;
        }
      }

      // DEBUG-only pause to make TEST_SCENARIOS #D reproducible.
      // All chunks are server-safe at this point; the delay just
      // keeps the session in `active` long enough for a manual
      // force-stop to land between the last chunk and the completion
      // request. Leave at 0 for production runs.
      if (DEBUG_DELAY_BEFORE_COMPLETE_MS > 0) {
        setTestStatus(
          `DEBUG BEFORE COMPLETE ${DEBUG_DELAY_BEFORE_COMPLETE_MS}ms`,
        );
        console.log(
          `DEBUG BEFORE COMPLETE — sleeping ${DEBUG_DELAY_BEFORE_COMPLETE_MS}ms before completeSession to widen the kill window for TEST_SCENARIOS #D`,
        );
        await new Promise(r =>
          setTimeout(r, DEBUG_DELAY_BEFORE_COMPLETE_MS),
        );
      }

      // All chunks uploaded — complete the session. Same try/catch
      // contract as Phase 2: completion failure surfaces but does
      // not void the evidence (chunks are already server-side).
      try {
        setTestStatus('SESSION COMPLETE START');
        await new Promise(r => setTimeout(r, 50));
        console.log('SESSION COMPLETE START:', sessionId);
        const completed = await completeSession(token, sessionId);
        setTestStatus('SESSION COMPLETE OK');
        await new Promise(r => setTimeout(r, 50));
        console.log('SESSION COMPLETE OK:', completed);
        console.log('GC_VALIDATION: SESSION_COMPLETED', {
          mode: 'multi-chunk',
          session_id: sessionId,
        });
        // Only clear pending on confirmed completion. If completeSession
        // throws, leave PENDING_RETRY_KEY so the next launch retries via
        // Phase 2 (remaining=[] → chunk loop is a no-op → completeSession
        // retry only). Chunks are server-safe regardless.
        await AsyncStorage.removeItem(PENDING_RETRY_KEY);
        console.log('GC_VALIDATION: PENDING_CLEARED', {
          session_id: sessionId,
          mode: 'multi-chunk',
        });
        // Best-effort cleanup of the moved recording. Docdir-only
        // guard inside the helper protects cache/legacy uris.
        await deleteRecordingBestEffort(uri);
      } catch (error) {
        setTestStatus('SESSION COMPLETE ERROR');
        await new Promise(r => setTimeout(r, 50));
        console.log('SESSION COMPLETE ERROR:', error);
      }

      setTestStatus('PHASE 1 DONE — all chunks uploaded');
      console.log(
        'PHASE 1 DONE — all chunks uploaded, session completed',
      );
      // UI-only counter reset. Chunks are server-safe; this just clears
      // the stale "N / N" from the HOME card now that the work is done.
      resetProgress();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestStatus(`ZZ_ERROR_CATCHALL: ${message || '<no message>'}`);
      console.log('ZZ_ERROR_CATCHALL:', error);
    }
  }

  const isBusy = isStarting || isStopping || isRecovering;
  const phaseLabel = isBusy
    ? 'Procesando / subiendo'
    : isRecording
      ? 'Grabando'
      : 'Listo';
  const phaseColor = isBusy ? '#f0b400' : isRecording ? '#ff4d4d' : '#3ddc84';

  // Destination gate. We never block a STOP — even with no destination,
  // a running recording must always be stoppable. The block only applies
  // to starting a new recording.
  const hasDrive = drive !== null && drive !== undefined;
  const driveCheckLoading = drive === null;
  const showStop = isRecording || isStopping;
  // Disable GRABAR when no drive is connected (or we haven't finished
  // checking yet). Never disable PARAR.
  const buttonDisabled = showStop
    ? isStopping
    : isStarting || isBusy || !hasDrive;
  const buttonLabel = showStop ? 'PARAR' : 'GRABAR';
  const buttonBg = showStop ? '#d73a49' : '#1f6feb';

  // X / N progress. Shown only while work is actually in flight (total
  // > 0). Guarantees we never render "0 / 0" per the brief.
  const showProgress = totalCount > 0;
  const progressLabel = showProgress
    ? `Subiendo ${uploadedCount} / ${totalCount}`
    : null;

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
      {/* Settings shortcut — top-right of the screen. Always available,
          never blocks any recording / recovery logic. */}
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

      {/* Destination indicator. Shows the currently active destination so
          the user never has to guess where evidence will land. No
          destination → the indicator explains that recording is blocked
          and offers a shortcut to the Settings screen. */}
      <DestinationIndicator drive={drive} loading={driveCheckLoading} />

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

      {/* X / N progress counter — visible only while work is in flight.
          Drives off the same state as the upload loops, never duplicates
          logic. Covers Phase 1 and Phase 2 identically. */}
      {progressLabel && (
        <Text
          style={{
            color: '#f0b400',
            fontSize: 14,
            fontWeight: '600',
            marginBottom: 16,
          }}
        >
          {progressLabel}
        </Text>
      )}

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

      <Text
        style={{
          fontSize: 12,
          color: '#c9d1d9',
          textAlign: 'center',
          padding: 12,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 6,
          minWidth: '90%',
          backgroundColor: '#161b22',
        }}
      >
        {testStatus}
      </Text>
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
  const label = loading
    ? 'Comprobando destino…'
    : drive
      ? `Destino: Google Drive${drive.account_email ? ` · ${drive.account_email}` : ''}`
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
      <Text style={{ color: '#c9d1d9', fontSize: 12 }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
