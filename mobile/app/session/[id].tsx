/**
 * Session detail screen (export-only).
 *
 * Route: /session/[id]
 *
 * Minimal UI for the MVP — one action ("Exportar evidencia"), a progress
 * line while it runs, and a result block when it finishes. No player, no
 * waveform, no scrub bar, no chunk inspector. The screen's only job is
 * to drive `exportSession` and surface its outcome.
 *
 * Entry point for this route is deliberately NOT wired from the home
 * screen yet (per scope decision). Navigation happens programmatically
 * via `router.push('/session/<id>')` from debug builds or future
 * Historial brick.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

import {
  downloadChunk,
  exportSession,
  getSessionDetail,
  listSessionChunks,
  type ChunkMeta,
  type ExportProgress,
  type ExportResult,
} from '@/api/export';
import {
  type SessionMode,
  type SessionStatusSummary,
  deriveSessionStatus,
  readHistory,
} from '@/api/history';
import {
  findLocalRecordingUri,
  findLocalExpectedChunkCount,
} from '@/recording/localEvidence';

// Single-flight lock for `Sharing.shareAsync`. Native iOS/Android
// rejects a second share request while one is mid-flight with
// "Another share request is being processed now"; the lock turns a
// double-tap into a no-op instead of a console error.
let isSharing = false;
async function handleShare(filePath: string) {
  if (isSharing) return;
  isSharing = true;
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) return;

    await Sharing.shareAsync(filePath);
  } catch (e) {
    console.log('SHARE ERROR', e);
  } finally {
    isSharing = false;
  }
}

// Local copy of the same chunked-base64 encoder used inside
// `exportSession`. Duplicated on purpose so this UI feature does NOT
// import a non-exported internal from `src/api/export.ts` and does NOT
// modify that module. ~32 KiB stride keeps `String.fromCharCode.apply`
// well under the JS arg-count limit on Hermes/V8.
function bytesToBase64Local(bytes: Uint8Array): string {
  let binary = '';
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + stride)),
    );
  }
  return btoa(binary);
}

// Per-mode extension for individual chunk files. Audio chunks are raw
// AAC ADTS frames (`.aac`); video chunks are already MP4 fragments
// (`.mp4`). When `mode` is unknown we keep `.bin` — same conservative
// fallback `exportSession` uses when its sniff cannot confirm a
// container. Each chunk is a self-contained fragment, NOT a
// reproducible standalone media file (especially video chunks
// without the moov atom). The UI never claims otherwise.
function chunkExtensionForMode(mode: SessionMode | undefined): string {
  if (mode === 'video') return '.mp4';
  if (mode === 'audio') return '.aac';
  return '.bin';
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ExportProgress | null }
  | { kind: 'localExport' }
  | { kind: 'localFallback'; filePath: string }
  | { kind: 'done'; result: ExportResult }
  | { kind: 'error'; message: string };

/**
 * Independent state machine for the "Descargar fragmentos disponibles"
 * affordance. Lives alongside the export `Phase` because the two flows
 * are orthogonal: the user can re-trigger fragment download on a
 * already-shown partial result without resetting the export verdict.
 *
 *   idle      — never tapped, or finished and ready to retry
 *   running   — actively downloading (done/total drives the progress UI)
 *   ready     — every chunk that could be fetched has been written; the
 *               files array is sorted by chunk_index. `failedIndexes`
 *               lists chunks the backend exposed but whose download or
 *               write failed; ready is shown even when failedIndexes is
 *               non-empty (we offer what we have).
 *   error     — fatal pre-flight failure (e.g. listSessionChunks threw);
 *               nothing was written.
 */
type FragmentsPhase =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number }
  | {
      kind: 'ready';
      files: { index: number; path: string }[];
      manifestPath: string;
      failedIndexes: number[];
    }
  | { kind: 'error'; message: string };

export default function SessionDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const sessionId = typeof params.id === 'string' ? params.id.trim() : '';

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Live status fetched from GET /sessions/:id/chunks. Null while
  // loading; resolves to a SessionStatusSummary (incl. 'unknown' on
  // fetch failure). Drives the header AND gates the export button so
  // we never offer "Exportar" for a session with zero uploaded chunks.
  const [statusSummary, setStatusSummary] =
    useState<SessionStatusSummary | null>(null);
  // Local-recording URI lookup, independent of the cloud status fetch.
  // Populated from the persisted queue (read-only) at mount and after
  // any phase transition that could have reaped the entry. Used both
  // to enable the export button when cloud is unavailable AND as the
  // fallback target inside `handleExport`. State only — never mutated
  // by anything outside this screen, never persisted.
  const [localRecordingUri, setLocalRecordingUri] = useState<string | null>(
    null,
  );
  // Authoritative emitted-chunk count for this session, read from the
  // persisted queue. Used to detect the "backend says 7/7 but the local
  // chunker emitted 32" false-positive integrity verdict. Null when the
  // queue entry is gone (already reaped after a fully successful upload),
  // in which case the backend's view is reliable on its own.
  const [expectedLocalChunks, setExpectedLocalChunks] = useState<number | null>(
    null,
  );
  // Recording mode for this session, read once from the local history
  // index. Used (a) by the existing cloud export (forces .mp4) and (b)
  // by the partial-fragments downloader to pick a per-chunk extension
  // (.mp4 / .aac / .bin). Null while loading; undefined once loaded if
  // the history entry is missing — both treated as "unknown" by the
  // fragment extension picker.
  const [sessionMode, setSessionMode] = useState<SessionMode | null>(null);
  // Per-session upload destination, fetched once on mount via
  // GET /sessions/:id (which the backend already exposes; no new
  // endpoint). Drives the export gating below: NAS sessions cannot
  // currently round-trip via the per-chunk Drive download endpoint
  // — that path would 404 with "Drive file not found" for every
  // chunk and fold the result to `no_valid_chunks`, which is both
  // misleading (the chunks are NOT corrupt) and noisy in logcat.
  //
  //   'drive'  → existing export flow runs unchanged
  //   'nas'    → export is hidden + a clear "pendiente" notice replaces
  //              the button; defense-in-depth in `handleExport` also
  //              short-circuits before any /chunks/:index/download call
  //   null     → unknown (legacy session, fetch failure, etc.) — falls
  //              through to the existing Drive flow exactly as before
  const [sessionDestination, setSessionDestination] = useState<
    'drive' | 'nas' | null
  >(null);
  // Partial-fragments downloader state. Independent of `phase` — see
  // FragmentsPhase docblock above.
  const [fragmentsPhase, setFragmentsPhase] = useState<FragmentsPhase>({
    kind: 'idle',
  });
  // Live "uploaded chunks" count, refreshed every time the user taps
  // "Exportar paquete técnico" (handleDownloadFragments re-fetches the
  // chunk listing). Drives the visible "Fragmentos disponibles: X / Y"
  // counter so it stays in sync with chunks that finished uploading
  // AFTER the export verdict was rendered. Null until the first refresh
  // — falls back to `result.validChunks` (the snapshot at export time).
  // UI only — never feeds into integrity calc, missing-chunk detection,
  // or any other derived state.
  const [availableFragmentCount, setAvailableFragmentCount] = useState<
    number | null
  >(null);

  // Fetch real status on mount and after every successful export (the
  // export itself can change perceived state — e.g. it confirms what
  // was already in Drive). Failures fold into status='unknown'; we
  // never throw out of the effect.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const chunks = await listSessionChunks(sessionId);
        if (!cancelled) setStatusSummary(deriveSessionStatus(chunks));
      } catch {
        if (!cancelled) setStatusSummary(deriveSessionStatus(null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, phase.kind === 'done']);

  // Independent local-recording lookup. Runs on mount AND after the
  // cloud export finishes (the queue entry — and the file — may have
  // been reaped by the worker after a successful upload). Read-only;
  // never writes to AsyncStorage or the queue.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      const uri = await findLocalRecordingUri(sessionId);
      if (!cancelled) setLocalRecordingUri(uri);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, phase.kind === 'done']);

  // Independent local emitted-chunk-count lookup. Same persistence
  // source as the URI lookup, same lifetime guarantees. Drives the
  // integrity recompute in ResultBlock so backend's partial chunk list
  // cannot pass as "Completa".
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      const expected = await findLocalExpectedChunkCount(sessionId);
      if (!cancelled) setExpectedLocalChunks(expected);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, phase.kind === 'done']);

  // One-shot session-destination lookup via GET /sessions/:id. Fires
  // once per sessionId; failures fold to `null` so the existing Drive
  // flow still runs (we never gate the user on a transient network
  // hiccup). Logs `EXPORT_BLOCKED_NAS_NOT_IMPLEMENTED` the first time
  // we observe a NAS session so logcat shows clearly WHY the export
  // button vanished — easier to diagnose than a missing affordance.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await getSessionDetail(sessionId);
        // TEMP DIAGNOSTIC: confirm what GET /sessions/:id actually
        // returns at runtime. To remove once the destination-tracking
        // bug is fixed.
        console.log('SESSION_DETAIL_FOR_EXPORT', {
          sessionId,
          destination_type: detail.destination_type,
          detail,
        });
        if (cancelled) return;
        const dt = detail.destination_type ?? null;
        setSessionDestination(dt);
        if (dt === 'nas') {
          console.log('EXPORT_BLOCKED_NAS_NOT_IMPLEMENTED', {
            sessionId,
            reason: 'nas_export_not_implemented_yet',
            phase: 'mount_lookup',
          });
        }
      } catch (err) {
        // TEMP DIAGNOSTIC: surface fetch failures so a silent network
        // error does not look like a "destination=drive" verdict.
        console.log('SESSION_DETAIL_FETCH_FAILED', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        // Network / 4xx / 5xx → leave as null so the existing Drive
        // flow runs. Recovery / upload pipelines are unaffected.
        if (!cancelled) setSessionDestination(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // One-shot mode lookup. Reads the history index, finds this session,
  // caches its mode for both the cloud export and the partial-fragments
  // downloader. Failures fold into `null` (treated as unknown). The
  // lookup never blocks UI — both consumers tolerate `null` / undefined.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await readHistory();
        const entry = list.find((e) => e.session_id === sessionId);
        if (!cancelled) setSessionMode(entry?.mode ?? null);
      } catch {
        if (!cancelled) setSessionMode(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Two independent enablers for the button. The user only needs ONE
  // to be true:
  //   - cloud has chunks → existing cloud export path is viable
  //   - localRecordingUri is set → offline / no-cloud-chunks fallback
  //                                 has a usable local file
  // Without the local OR-branch, an offline launch (where the network
  // call inside the cloud-status effect fails into uploaded=0) leaves
  // the button permanently disabled — exactly the bug being fixed.
  const canExportCloud =
    statusSummary !== null && statusSummary.uploaded > 0;
  const canExportLocal = localRecordingUri !== null;
  const exportDisabled =
    phase.kind === 'running' ||
    sessionId.length === 0 ||
    (!canExportCloud && !canExportLocal);

  async function handleExport() {
    if (!sessionId) return;

    // Defense-in-depth: even if the render guard below somehow lets the
    // user trigger this for a NAS session (race between the destination
    // fetch and a tap), bail BEFORE touching `exportSession`. Mirrors
    // the same log key emitted on mount so the operator sees both
    // observations correlated by sessionId.
    if (sessionDestination === 'nas') {
      console.log('EXPORT_BLOCKED_NAS_NOT_IMPLEMENTED', {
        sessionId,
        reason: 'nas_export_not_implemented_yet',
        phase: 'handle_export_guard',
      });
      return;
    }

    // Local-only path. When cloud has nothing to give (offline at boot
    // or the session never had any chunk uploaded) we skip the cloud
    // attempt entirely and serve the local file. Re-verify the URI
    // here in case the file was reaped between the mount-time lookup
    // and this tap.
    if (!canExportCloud && canExportLocal) {
      setPhase({ kind: 'localExport' });
      const verifiedUri = await findLocalRecordingUri(sessionId);
      if (verifiedUri) {
        console.log('LOCAL EXPORT direct (no cloud)', {
          sessionId,
          localUri: verifiedUri,
        });
        setPhase({ kind: 'localFallback', filePath: verifiedUri });
        return;
      }
      // The file disappeared between mount and tap. Drop the local
      // hint and fall through to the failed UI.
      setLocalRecordingUri(null);
      setPhase({
        kind: 'done',
        result: {
          status: 'failed',
          filePath: null,
          totalChunks: 0,
          validChunks: 0,
          missingIndexes: [],
          corruptIndexes: [],
        },
      });
      return;
    }

    // Cloud-first path with the original local fallback when cloud
    // export collapses to failed/0 (offline mid-flight, no uploaded
    // chunks server-side, etc.).
    setPhase({ kind: 'running', progress: null });
    try {
      // Mode is loaded by a dedicated useEffect into `sessionMode`
      // (cached so the partial-fragments downloader can reuse it
      // without a second history read). Only 'video' has a behavioural
      // effect inside `exportSession` (forces '.mp4'); 'audio' and
      // undefined both keep the sniff path.
      const mode: SessionMode | undefined = sessionMode ?? undefined;
      const result = await exportSession(
        sessionId,
        (progress) => {
          setPhase({ kind: 'running', progress });
        },
        mode,
      );

      // Local-export fallback. `exportSession` collapses every failure
      // path into `status='failed'` + `validChunks === 0`: that covers
      // the offline case (`listSessionChunks` threw NETWORK_ERROR) AND
      // the "no chunks uploaded yet" case. In both situations the
      // recording's local file is likely still on disk (the queue
      // entry has not been reaped because uploads never finished). If
      // we can find that local URI, surface it as the result instead
      // of the empty failure block. The cloud export logic is NOT
      // modified — we only react to its output.
      if (result.status === 'failed' && result.validChunks === 0) {
        setPhase({ kind: 'localExport' });
        const localUri =
          localRecordingUri ?? (await findLocalRecordingUri(sessionId));
        if (localUri) {
          console.log('LOCAL EXPORT fallback used', {
            sessionId,
            localUri,
          });
          setPhase({ kind: 'localFallback', filePath: localUri });
          return;
        }
        // No local file available either — fall through to the
        // existing failed UI which renders the cloud result.
      }

      setPhase({ kind: 'done', result });
    } catch (err) {
      // `exportSession` is supposed to never throw, but we defend in
      // depth — any escape gets surfaced as a controlled error state.
      const message = err instanceof Error ? err.message : String(err);
      setPhase({ kind: 'error', message });
    }
  }

  /**
   * Partial-fragment downloader.
   *
   * Goal: make the chunks that DID upload accessible to the user even
   * when the session is partial (missing tail chunks → unplayable MP4
   * → existing export blocks the share button). We fetch each uploaded
   * chunk via the same `downloadChunk` helper the cloud export uses,
   * write each one as a standalone file under
   * `documentDirectory/guardian_chunks_<sessionId>/`, and emit a
   * `manifest.txt` listing every fragment so the user can share them
   * one by one.
   *
   * Strict scope:
   *   - DOES NOT call exportSession.
   *   - DOES NOT touch the upload queue, the worker, or any backend
   *     endpoint other than the per-chunk download the export already
   *     uses.
   *   - DOES NOT verify hashes (the existing partial-export verdict
   *     already told the user the session is partial; we are not
   *     re-asserting integrity, only surfacing what the backend has).
   *   - NEVER promises playability.
   *
   * Failure model: per-chunk download failures land in `failedIndexes`
   * and the loop continues with the next chunk. The flow only enters
   * the `error` phase on a fatal pre-flight failure (e.g. the chunk
   * listing call throws). When at least one chunk landed on disk we
   * surface the `ready` phase with whatever we got.
   */
  async function handleDownloadFragments() {
    if (!sessionId) return;
    if (fragmentsPhase.kind === 'running') return;

    setFragmentsPhase({ kind: 'running', done: 0, total: 0 });

    let chunks: ChunkMeta[];
    try {
      chunks = await listSessionChunks(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log('FRAGMENTS LIST ERROR', { sessionId, err: message });
      setFragmentsPhase({ kind: 'error', message });
      return;
    }

    const uploaded = chunks
      .filter((c) => c.status === 'uploaded' && !!c.remote_reference)
      .sort((a, b) => a.chunk_index - b.chunk_index);
    // Sync the visible counter with the freshly-listed uploaded count.
    // Pure UI sync — does not affect download flow, integrity calc, or
    // expectedLocalChunks. Updated even when the count is 0 so a session
    // that just lost its only chunk reflects reality.
    setAvailableFragmentCount(uploaded.length);

    if (uploaded.length === 0) {
      setFragmentsPhase({
        kind: 'error',
        message: 'No hay fragmentos disponibles para descargar.',
      });
      return;
    }

    const docDir = FileSystem.documentDirectory;
    if (!docDir) {
      setFragmentsPhase({
        kind: 'error',
        message: 'No se pudo acceder al almacenamiento del dispositivo.',
      });
      return;
    }

    const dirPath = `${docDir}guardian_chunks_${sessionId}/`;
    try {
      const info = await FileSystem.getInfoAsync(dirPath);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log('FRAGMENTS MKDIR ERROR', { sessionId, err: message });
      setFragmentsPhase({ kind: 'error', message });
      return;
    }

    const ext = chunkExtensionForMode(sessionMode ?? undefined);
    const written: { index: number; path: string }[] = [];
    const failed: number[] = [];
    const total = uploaded.length;

    setFragmentsPhase({ kind: 'running', done: 0, total });

    for (let i = 0; i < uploaded.length; i++) {
      const meta = uploaded[i]!;
      try {
        const { bytes } = await downloadChunk(sessionId, meta.chunk_index);
        const name = `chunk_${String(meta.chunk_index).padStart(4, '0')}${ext}`;
        const path = `${dirPath}${name}`;
        const base64 = bytesToBase64Local(bytes);
        await FileSystem.writeAsStringAsync(path, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        written.push({ index: meta.chunk_index, path });
        console.log('FRAGMENT DOWNLOADED', {
          sessionId,
          chunkIndex: meta.chunk_index,
          size: bytes.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log('FRAGMENT DOWNLOAD ERROR', {
          sessionId,
          chunkIndex: meta.chunk_index,
          err: msg,
        });
        failed.push(meta.chunk_index);
      }
      setFragmentsPhase({ kind: 'running', done: i + 1, total });
    }

    if (written.length === 0) {
      setFragmentsPhase({
        kind: 'error',
        message: 'No se pudo descargar ningún fragmento. Reintenta más tarde.',
      });
      return;
    }

    // Manifest sits alongside the chunks and identifies the session +
    // every chunk file we managed to write. Plain text on purpose: any
    // viewer can read it and no library is needed to generate it.
    const manifestLines = [
      `Guardian Cloud — fragmentos disponibles`,
      `session_id: ${sessionId}`,
      `mode: ${sessionMode ?? 'unknown'}`,
      `generated_at: ${new Date().toISOString()}`,
      `total_disponibles: ${written.length}`,
      `total_intentados: ${total}`,
      `fallidos: ${failed.length}`,
      ``,
      `Estos son fragmentos individuales. NO forman un vídeo o audio reproducible por sí mismos.`,
      ``,
      `Archivos:`,
      ...written.map(
        (w) =>
          `  - chunk_${String(w.index).padStart(4, '0')}${ext}  (chunk_index=${w.index})`,
      ),
    ];
    if (failed.length > 0) {
      manifestLines.push(``, `Fragmentos no descargados:`);
      for (const idx of failed) {
        manifestLines.push(`  - chunk_index=${idx}`);
      }
    }
    const manifestPath = `${dirPath}manifest.txt`;
    try {
      await FileSystem.writeAsStringAsync(
        manifestPath,
        manifestLines.join('\n'),
      );
    } catch (err) {
      // Manifest write failure is non-fatal — chunks are still on disk.
      console.log('FRAGMENTS MANIFEST ERROR', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    console.log('FRAGMENTS READY', {
      sessionId,
      written: written.length,
      failed: failed.length,
      dir: dirPath,
    });

    setFragmentsPhase({
      kind: 'ready',
      files: written,
      manifestPath,
      failedIndexes: failed,
    });
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#0d1117' }}
      contentContainerStyle={{ padding: 20, paddingTop: 48 }}
    >
      <Pressable
        onPress={() => {
          // Deep links (guardiancloud://session/<id>) land here with no
          // history, so router.back() would be a no-op. Fall back to the
          // home screen in that case so the user never gets stuck.
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/');
          }
        }}
        style={{ marginBottom: 16, alignSelf: 'flex-start' }}
        hitSlop={12}
      >
        <Text style={{ color: '#8b949e', fontSize: 14 }}>← Volver</Text>
      </Pressable>

      <Text
        style={{
          color: '#c9d1d9',
          fontSize: 22,
          fontWeight: '700',
          marginBottom: 6,
        }}
      >
        Sesión
      </Text>
      <Text
        selectable
        style={{ color: '#6e7681', fontSize: 12, marginBottom: 20 }}
      >
        {sessionId || '(sin id)'}
      </Text>

      {/* Live status header. All fields derived strictly from the
          chunks list returned by the backend — never optimistic. */}
      <StatusHeader summary={statusSummary} />

      {/* Export gating by per-session destination. The "Exportar
          evidencia" button is intentionally HIDDEN for NAS sessions
          (rather than disabled) because the broken affordance would
          otherwise invite a tap that produces a misleading "chunks
          corruptos" verdict in logcat — see `handleExport`'s guard
          and the mount-time log. Drive sessions and unknown ones
          (legacy / fetch failure) keep the existing button. */}
      {sessionDestination === 'nas' ? (
        <NasExportPendingBlock />
      ) : (
        <Pressable
          onPress={handleExport}
          disabled={exportDisabled}
          style={{
            backgroundColor: exportDisabled ? '#1f2a36' : '#1f6feb',
            opacity: exportDisabled ? 0.7 : 1,
            padding: 14,
            borderRadius: 6,
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>
            Exportar evidencia
          </Text>
        </Pressable>
      )}

      {phase.kind === 'running' && <ProgressBlock progress={phase.progress} />}
      {phase.kind === 'localExport' && <LocalExportBlock />}
      {phase.kind === 'localFallback' && (
        <LocalFallbackBlock filePath={phase.filePath} />
      )}
      {phase.kind === 'done' && (
        <ResultBlock
          result={phase.result}
          expectedLocalChunks={expectedLocalChunks}
          availableFragmentCount={availableFragmentCount}
          fragmentsPhase={fragmentsPhase}
          onDownloadFragments={handleDownloadFragments}
        />
      )}
      {phase.kind === 'error' && <ErrorBlock message={phase.message} />}

      <Text
        style={{
          color: '#6e7681',
          fontSize: 11,
          marginTop: 28,
          lineHeight: 16,
        }}
      >
        La exportación descarga cada chunk desde tu Google Drive, verifica
        su integridad con sha256 y los concatena en orden. Si algún chunk
        falta o está corrupto, el archivo se marca como parcial.
      </Text>
    </ScrollView>
  );
}

/**
 * Replacement card shown instead of the export button when the
 * session was uploaded to NAS. The per-chunk download endpoint is
 * Drive-only today, so a NAS export would 404 every chunk and fold
 * to "no_valid_chunks" — misleading because the chunks ARE intact
 * on the NAS. Hiding the button is the honest interim state until
 * the WebDAV-side download is implemented (out of scope here).
 *
 * Pure presentation: takes no props, performs no I/O, never reads
 * back into any decision flow. The mount-time `useEffect` already
 * logged the block reason; this component never logs.
 */
function NasExportPendingBlock() {
  return (
    <View
      style={{
        marginBottom: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: '#d29922',
        borderRadius: 6,
        backgroundColor: '#2d1f06',
      }}
    >
      <Text style={{ color: '#e3b341', fontSize: 13, fontWeight: '700' }}>
        Exportación desde NAS pendiente
      </Text>
      <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
        La evidencia está guardada en tu NAS, pero la reconstrucción
        desde NAS aún no está implementada.
      </Text>
    </View>
  );
}

function ProgressBlock({ progress }: { progress: ExportProgress | null }) {
  const label = useMemo(() => {
    if (!progress) return 'Preparando…';
    if (progress.currentIndex < 0) {
      return `Finalizando… ${progress.done}/${progress.total}`;
    }
    return `Descargando chunk ${progress.currentIndex + 1}… ${progress.done}/${progress.total}`;
  }, [progress]);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#161b22',
        borderWidth: 1,
        borderColor: '#30363d',
        borderRadius: 6,
        padding: 12,
        marginTop: 4,
      }}
    >
      <ActivityIndicator color="#c9d1d9" />
      <Text style={{ color: '#c9d1d9', marginLeft: 10, fontSize: 13 }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Brief loader shown while we look up the local recording URI after a
 * cloud export failure. Same shape as ProgressBlock for visual
 * continuity. The lookup itself is fast (one AsyncStorage read + one
 * filesystem stat) so this is on screen for a tick or two.
 */
function LocalExportBlock() {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#161b22',
        borderWidth: 1,
        borderColor: '#30363d',
        borderRadius: 6,
        padding: 12,
        marginTop: 4,
      }}
    >
      <ActivityIndicator color="#c9d1d9" />
      <Text style={{ color: '#c9d1d9', marginLeft: 10, fontSize: 13 }}>
        Exportando desde el dispositivo…
      </Text>
    </View>
  );
}

/**
 * Result block for the local-export fallback path. Reuses the same
 * visual shape as the "complete" cloud result so the user sees a
 * familiar success affordance, but with explicit copy that this came
 * from the device (no Drive verification, no chunk concat). Shares the
 * file via `expo-sharing`, identical to the cloud success path.
 */
function LocalFallbackBlock({ filePath }: { filePath: string }) {
  return (
    <View
      style={{
        marginTop: 4,
        padding: 12,
        borderWidth: 1,
        borderColor: '#238636',
        borderRadius: 6,
        backgroundColor: '#0a2a14',
      }}
    >
      <Text style={{ color: '#56d364', fontSize: 13, fontWeight: '600' }}>
        Evidencia local lista
      </Text>
      <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
        Sin conexión: se ha exportado directamente desde el dispositivo.
      </Text>
      <Pressable
        onPress={() => handleShare(filePath)}
        style={{
          marginTop: 10,
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 6,
          backgroundColor: '#161b22',
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '500' }}>
          Compartir archivo
        </Text>
      </Pressable>
    </View>
  );
}

function ResultBlock({
  result,
  expectedLocalChunks,
  availableFragmentCount,
  fragmentsPhase,
  onDownloadFragments,
}: {
  result: ExportResult;
  expectedLocalChunks: number | null;
  availableFragmentCount: number | null;
  fragmentsPhase: FragmentsPhase;
  onDownloadFragments: () => void;
}) {
  // Real expected total. Backend-derived `result.totalChunks` is only
  // truthful when EVERY emitted chunk made it server-side. When uploads
  // are still pending, backend sees a prefix (e.g. 7) while the local
  // chunker emitted more (e.g. 32). The persisted queue entry remembers
  // the local emission count via `next_chunk_index` (or `chunks.length`
  // as fallback); we read that into `expectedLocalChunks`.
  //
  // Use the larger of the two — guards against edge cases where backend
  // somehow knows about a chunk we never emitted (shouldn't happen, but
  // avoids `realTotal < result.totalChunks` falsely shrinking the gap).
  const realTotal = Math.max(
    result.totalChunks,
    expectedLocalChunks ?? 0,
  );
  // Real "missing" count vs the local emission truth. Includes both the
  // chunks the backend has marked as `pending`/`failed` AND the chunks
  // the backend doesn't know about at all (uploads still in flight).
  // `result.missingIndexes` only covers the first category — that is
  // the source of the false-positive bug.
  const realMissing = Math.max(
    0,
    realTotal - result.validChunks - result.corruptIndexes.length,
  );
  // Post-export integrity verdict. Computed from the data the export
  // pipeline already produced (missingIndexes / corruptIndexes) PLUS
  // the local emission truth — no new state, no new fetch beyond the
  // already-loaded `expectedLocalChunks`. Decoupled from `summary.status`
  // on purpose: the session can be `Cerrada` (backend lifecycle terminal)
  // and STILL have an integrity gap if the completion gate let some
  // chunk through as failed. UI must never conflate the two.
  const integrityStatus: 'full' | 'partial' =
    result.missingIndexes.length === 0 &&
    result.corruptIndexes.length === 0 &&
    realMissing === 0
      ? 'full'
      : 'partial';

  // Survival principle ("subir evidencia > archivo perfecto"): we no
  // longer early-return / hide share for partial MP4 exports. The
  // export pipeline now always produces a contiguous valid prefix
  // (cut at the first gap), and that prefix — even if not playable
  // by every decoder — is forensically useful. The user MUST be able
  // to share it. The standard 'complete' / 'partial' branches below
  // own the rendering for every status; partial exports show a clear
  // "Evidencia parcial recuperada" banner alongside the share button.

  if (result.status === 'complete') {
    return (
      <View
        style={{
          marginTop: 4,
          padding: 12,
          borderWidth: 1,
          borderColor: '#238636',
          borderRadius: 6,
          backgroundColor: '#0a2a14',
        }}
      >
        <Text style={{ color: '#56d364', fontSize: 13, fontWeight: '600' }}>
          Evidencia lista
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
          Archivo generado correctamente.
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
          {integrityStatus === 'full'
            ? 'Integridad: Completa ✅'
            : 'Integridad: Parcial ⚠️'}
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 2 }}>
          {integrityStatus === 'full' ? 'Reproducible: Sí' : 'Reproducible: No'}
        </Text>
        {integrityStatus !== 'full' && (
          // Survival principle + honesty: we wrote the contiguous
          // valid prefix and let the user share it, but we DO NOT
          // claim it is guaranteed playable. Some MP4 decoders need
          // the trailing moov atom that a truncated export will not
          // contain; an audio (.aac / .m4a) prefix usually plays but
          // we still hedge so the user is not surprised. Yellow /
          // neutral tone — never red, never gating share.
          <View style={{ marginTop: 10 }}>
            <Text
              style={{
                color: '#e3b341',
                fontSize: 12,
                fontWeight: '600',
              }}
            >
              Evidencia parcial recuperada
            </Text>
            <Text
              style={{
                color: '#e3b341',
                fontSize: 11,
                marginTop: 2,
              }}
            >
              Puede requerir revisión técnica.
            </Text>
          </View>
        )}
        {result.filePath && (
          <Pressable
            onPress={() => handleShare(result.filePath as string)}
            style={{
              marginTop: 10,
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderWidth: 1,
              borderColor: '#30363d',
              borderRadius: 6,
              backgroundColor: '#161b22',
              alignItems: 'center',
            }}
          >
            <Text
              style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '500' }}
            >
              Compartir archivo
            </Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (result.status === 'partial') {
    // Two qualitative flags derived from the existing result — no raw
    // counts are surfaced. They answer the user's "can I use it?"
    // question without exposing chunk indexes.
    const firstChunkAffected =
      result.missingIndexes.includes(0) || result.corruptIndexes.includes(0);
    const isBinFile = result.filePath?.endsWith('.bin') ?? false;

    return (
      <View
        style={{
          marginTop: 4,
          padding: 12,
          borderWidth: 1,
          borderColor: '#d29922',
          borderRadius: 6,
          backgroundColor: '#2d1f06',
        }}
      >
        <Text style={{ color: '#e3b341', fontSize: 13, fontWeight: '700' }}>
          Evidencia parcial recuperada
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
          Se ha guardado el tramo continuo válido. Faltan algunos
          fragmentos posteriores; la parte recuperada es íntegra.
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
          Integridad: Parcial ⚠️
        </Text>

        {/* Qualitative advisory. Honesty without alarm: a partial
            export — and especially one missing chunk_index 0 — may
            not open in every player (MP4 needs the moov atom; some
            decoders refuse a truncated stream). We DO NOT block the
            share button; we just tell the user the file may need
            technical review. Yellow / neutral styling matches the
            "Evidencia parcial recuperada" frame so the user does not
            read this as a hard error. */}
        {firstChunkAffected && (
          <View
            style={{
              marginTop: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: '#d29922',
              borderRadius: 4,
              backgroundColor: '#2d1f06',
            }}
          >
            <Text style={{ color: '#e3b341', fontSize: 12, fontWeight: '600' }}>
              Archivo parcial recuperado. Puede requerir revisión técnica.
            </Text>
          </View>
        )}

        {/* Survival principle: never block share if there is a file.
            The pipeline now writes only the contiguous valid prefix —
            sharing it gives the user the recoverable evidence even
            when format-level reproducibility is uncertain (MP4 without
            moov atom, .bin forensic dump, etc.). */}
        {result.filePath && (
          <Pressable
            onPress={() => handleShare(result.filePath as string)}
            style={{
              marginTop: 10,
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderWidth: 1,
              borderColor: '#30363d',
              borderRadius: 6,
              backgroundColor: '#161b22',
              alignItems: 'center',
            }}
          >
            <Text
              style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '500' }}
            >
              Compartir archivo
            </Text>
          </Pressable>
        )}

        {/* Qualitative advisory: extension sniff fell back to .bin —
            we cannot guarantee the file plays as AAC. Same reason as
            above: answers "can I use it?", not a count. */}
        {isBinFile && (
          <Text
            style={{
              color: '#e3b341',
              fontSize: 11,
              marginTop: 8,
              fontStyle: 'italic',
            }}
          >
            Archivo técnico generado. No se ha podido confirmar como AAC
            reproducible.
          </Text>
        )}

        <PartialFragmentsBlock
          phase={fragmentsPhase}
          onDownload={onDownloadFragments}
        />
      </View>
    );
  }

  // "Soft" empty-evidence case. We reach this branch when status ===
  // 'failed' AND no chunk was valid — which is reliably the "nothing got
  // uploaded yet" path: list returned zero uploaded rows, or every
  // uploaded chunk failed hash/download. Write-failure after a good
  // concat always has validChunks > 0 (see exportSession's early return
  // at `if (validChunks === 0)`), so this block does NOT swallow real
  // technical failures — those fall through to the red block below.
  if (result.validChunks === 0) {
    return (
      <View
        style={{
          marginTop: 4,
          padding: 12,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 6,
          backgroundColor: '#161b22',
        }}
      >
        <Text style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '600' }}>
          No se pudo recuperar
        </Text>
        <Text style={{ color: '#8b949e', fontSize: 12, marginTop: 6 }}>
          Comprueba la conexión o reintenta la grabación.
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        marginTop: 4,
        padding: 12,
        borderWidth: 1,
        borderColor: '#f85149',
        borderRadius: 6,
        backgroundColor: '#2d0d12',
      }}
    >
      <Text style={{ color: '#f85149', fontSize: 13, fontWeight: '600' }}>
        No se pudo recuperar
      </Text>
      <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
        No hay fragmentos válidos para esta sesión.
      </Text>
    </View>
  );
}

/**
 * UI for the partial-fragments downloader. Lives INSIDE the partial
 * result cards (both the MP4-partial yellow card and the generic
 * `status === 'partial'` card). Pure presentation — every state
 * transition flows through `handleDownloadFragments` at the screen
 * level. The "Compartir" buttons hand each chunk file (and the
 * manifest) to `expo-sharing` one at a time, since `Sharing.shareAsync`
 * does not accept directories. Same single-flight lock as the existing
 * `Compartir archivo` button (`handleShare`).
 *
 * Copy is intentionally cautious: nothing here promises the fragments
 * are reproducible media — they are evidence, not playback.
 */
function PartialFragmentsBlock({
  phase,
  onDownload,
}: {
  phase: FragmentsPhase;
  onDownload: () => void;
}) {
  if (phase.kind === 'idle') {
    return (
      <View style={{ marginTop: 12 }}>
        <Pressable
          onPress={onDownload}
          style={{
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderWidth: 1,
            borderColor: '#30363d',
            borderRadius: 6,
            backgroundColor: '#161b22',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '500' }}>
            Exportar paquete técnico
          </Text>
        </Pressable>
        <Text
          style={{
            color: '#8b949e',
            fontSize: 11,
            marginTop: 6,
            fontStyle: 'italic',
          }}
        >
          Contiene fragmentos técnicos no reproducibles directamente
        </Text>
      </View>
    );
  }

  if (phase.kind === 'running') {
    const label =
      phase.total === 0
        ? 'Preparando descarga…'
        : `Descargando fragmentos ${phase.done} / ${phase.total}`;
    return (
      <View
        style={{
          marginTop: 12,
          padding: 10,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 6,
          backgroundColor: '#161b22',
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <ActivityIndicator color="#c9d1d9" />
        <Text style={{ color: '#c9d1d9', marginLeft: 10, fontSize: 13 }}>
          {label}
        </Text>
      </View>
    );
  }

  if (phase.kind === 'error') {
    return (
      <View
        style={{
          marginTop: 12,
          padding: 10,
          borderWidth: 1,
          borderColor: '#f85149',
          borderRadius: 4,
          backgroundColor: '#3d1518',
        }}
      >
        <Text style={{ color: '#f85149', fontSize: 12, fontWeight: '600' }}>
          {phase.message}
        </Text>
        <Pressable
          onPress={onDownload}
          style={{
            marginTop: 10,
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderWidth: 1,
            borderColor: '#30363d',
            borderRadius: 6,
            backgroundColor: '#161b22',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#c9d1d9', fontSize: 12, fontWeight: '500' }}>
            Reintentar
          </Text>
        </Pressable>
      </View>
    );
  }

  // phase.kind === 'ready'
  return (
    <View
      style={{
        marginTop: 12,
        padding: 10,
        borderWidth: 1,
        borderColor: '#30363d',
        borderRadius: 6,
        backgroundColor: '#161b22',
      }}
    >
      <Text style={{ color: '#56d364', fontSize: 13, fontWeight: '600' }}>
        Fragmentos descargados correctamente
      </Text>
      <Text style={{ color: '#8b949e', fontSize: 11, marginTop: 4 }}>
        {phase.files.length} fragmento{phase.files.length === 1 ? '' : 's'}{' '}
        guardado{phase.files.length === 1 ? '' : 's'} en el dispositivo.
        {phase.failedIndexes.length > 0
          ? ` ${phase.failedIndexes.length} no pudieron descargarse.`
          : ''}
      </Text>
      <Text
        style={{
          color: '#8b949e',
          fontSize: 11,
          marginTop: 4,
          fontStyle: 'italic',
        }}
      >
        Son fragmentos individuales, no un vídeo o audio reproducible.
      </Text>
      <Pressable
        onPress={() => handleShare(phase.manifestPath)}
        style={{
          marginTop: 10,
          paddingVertical: 9,
          paddingHorizontal: 12,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 6,
          backgroundColor: '#0d1117',
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#c9d1d9', fontSize: 12, fontWeight: '500' }}>
          Compartir índice (manifest.txt)
        </Text>
      </Pressable>
    </View>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <View
      style={{
        marginTop: 4,
        padding: 12,
        borderWidth: 1,
        borderColor: '#f85149',
        borderRadius: 6,
        backgroundColor: '#2d0d12',
      }}
    >
      <Text style={{ color: '#f85149', fontSize: 13, fontWeight: '600' }}>
        Error inesperado
      </Text>
      <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
        {message}
      </Text>
    </View>
  );
}

function StatusHeader({ summary }: { summary: SessionStatusSummary | null }) {
  if (summary === null) {
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: 12,
          marginBottom: 14,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 6,
          backgroundColor: '#161b22',
        }}
      >
        <ActivityIndicator color="#c9d1d9" />
        <Text style={{ color: '#c9d1d9', fontSize: 13, marginLeft: 10 }}>
          Cargando estado…
        </Text>
      </View>
    );
  }

  // Map status → presentation. Same palette as the History badge so
  // the user sees consistent semantics across screens. The `unknown`
  // case is now an explicit network error rather than a generic "Sin
  // datos" — matches the History badge.
  // "Cerrada" = backend-lifecycle terminal state (every chunk uploaded,
  // session row marked complete on the backend). It deliberately does
  // NOT imply that the evidence is intact or playable — that question
  // is answered post-export by `integrityStatus` in `ResultBlock`.
  const palette =
    summary.status === 'complete'
      ? { color: '#56d364', bg: '#0a2a14', label: 'Cerrada' }
      : summary.status === 'partial'
        ? { color: '#e3b341', bg: '#2d1f06', label: 'Parcial' }
        : summary.status === 'failed'
          ? { color: '#f85149', bg: '#2d0d12', label: 'Fallida' }
          : summary.status === 'empty'
            ? { color: '#8b949e', bg: '#161b22', label: 'Sin chunks' }
            : { color: '#f85149', bg: '#2d0d12', label: 'Error de conexión' };

  return (
    <View
      style={{
        padding: 12,
        marginBottom: 14,
        borderWidth: 1,
        borderColor: palette.color,
        borderRadius: 6,
        backgroundColor: palette.bg,
      }}
    >
      <Text style={{ color: palette.color, fontSize: 13, fontWeight: '700' }}>
        Estado: {palette.label}
      </Text>
      {/* The "exportar no funcionará" hint is a functional warning, not
          a raw count — kept because it answers the user's "can I use
          it?" question before they even tap Export. Raw chunk counts
          and Drive file counts have been removed: the badge already
          carries the truthful state and competing numbers were the
          source of the 64/64 vs 48/48 confusion the user reported. */}
      {summary.uploaded === 0 && summary.total > 0 && (
        <Text style={{ color: '#8b949e', fontSize: 11, marginTop: 4 }}>
          No hay datos subidos todavía. Exportar no producirá un archivo
          válido.
        </Text>
      )}
    </View>
  );
}
