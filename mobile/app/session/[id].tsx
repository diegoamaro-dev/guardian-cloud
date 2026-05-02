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

import {
  exportSession,
  listSessionChunks,
  type ExportProgress,
  type ExportResult,
} from '@/api/export';
import {
  type SessionMode,
  type SessionStatusSummary,
  deriveSessionStatus,
  readHistory,
} from '@/api/history';
import { findLocalRecordingUri } from '@/recording/localEvidence';

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

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ExportProgress | null }
  | { kind: 'localExport' }
  | { kind: 'localFallback'; filePath: string }
  | { kind: 'done'; result: ExportResult }
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
      // Look up this session's recording mode from the local history
      // index so `exportSession` can pick the correct extension. Only
      // 'video' has a behavioural effect inside `exportSession` (forces
      // '.mp4'); 'audio' and undefined both keep the sniff path. Any
      // failure to read history is treated as undefined → audio sniff.
      let mode: SessionMode | undefined;
      try {
        const list = await readHistory();
        const entry = list.find((e) => e.session_id === sessionId);
        mode = entry?.mode;
      } catch {
        mode = undefined;
      }
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

      {phase.kind === 'running' && <ProgressBlock progress={phase.progress} />}
      {phase.kind === 'localExport' && <LocalExportBlock />}
      {phase.kind === 'localFallback' && (
        <LocalFallbackBlock filePath={phase.filePath} />
      )}
      {phase.kind === 'done' && <ResultBlock result={phase.result} />}
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

function ResultBlock({ result }: { result: ExportResult }) {
  // Post-export integrity verdict. Computed from the data the export
  // pipeline already produced (missingIndexes / corruptIndexes) — no
  // new state, no new fetch. Decoupled from `summary.status` on
  // purpose: the session can be `Cerrada` (backend lifecycle terminal)
  // and STILL have an integrity gap if the completion gate let some
  // chunk through as failed. UI must never conflate the two.
  const integrityStatus: 'full' | 'partial' =
    result.missingIndexes.length === 0 && result.corruptIndexes.length === 0
      ? 'full'
      : 'partial';

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
        {integrityStatus === 'full' ? (
          result.filePath && (
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
          )
        ) : (
          // Safety guard: a session whose backend status is `complete`
          // can still surface integrity gaps if a chunk was lost between
          // upload and Drive (download/hash failure during export).
          // Reuse the same red warning block as the partial-MP4 path so
          // the user never gets a "share" button on a file that no
          // player can open.
          <View
            style={{
              marginTop: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: '#f85149',
              borderRadius: 4,
              backgroundColor: '#3d1518',
            }}
          >
            <Text
              style={{ color: '#f85149', fontSize: 12, fontWeight: '600' }}
            >
              Exportación parcial no reproducible. El vídeo tiene huecos y
              ningún reproductor podrá abrirlo. No se ofrece compartir.
            </Text>
          </View>
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
    // Video MP4 with any gap is unplayable — the moov atom and the
    // continuous mdat byte stream both require every chunk_index in
    // 0..lastIndex. Block the share button in this case so the user
    // does not hand over a file no media player can open. The audio
    // (.aac / .m4a) and forensic (.bin) branches keep their existing
    // share behaviour.
    const isMp4File = result.filePath?.endsWith('.mp4') ?? false;
    const hasGaps =
      result.missingIndexes.length > 0 || result.corruptIndexes.length > 0;
    const isPartialMp4 = isMp4File && hasGaps;

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
        <Text style={{ color: '#e3b341', fontSize: 13, fontWeight: '600' }}>
          Evidencia parcial
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
          Algunos fragmentos no pudieron recuperarse.
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
          Integridad: Parcial ⚠️
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 2 }}>
          Reproducible: No
        </Text>

        {/* Qualitative advisory: missing/corrupt chunk_index 0 makes
            the AAC stream unplayable in most decoders. Kept because it
            answers "can I use it?" — not a raw chunk count. */}
        {firstChunkAffected && (
          <View
            style={{
              marginTop: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: '#f85149',
              borderRadius: 4,
              backgroundColor: '#3d1518',
            }}
          >
            <Text style={{ color: '#f85149', fontSize: 12, fontWeight: '600' }}>
              El primer fragmento está perdido o corrupto. El archivo
              parcial puede no ser reproducible.
            </Text>
          </View>
        )}

        {isPartialMp4 ? (
          <View
            style={{
              marginTop: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: '#f85149',
              borderRadius: 4,
              backgroundColor: '#3d1518',
            }}
          >
            <Text
              style={{ color: '#f85149', fontSize: 12, fontWeight: '600' }}
            >
              Exportación parcial no reproducible. El vídeo tiene huecos y
              ningún reproductor podrá abrirlo. No se ofrece compartir.
            </Text>
          </View>
        ) : (
          result.filePath && (
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
          )
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
