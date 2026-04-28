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

async function handleShare(filePath: string) {
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) return;

    await Sharing.shareAsync(filePath);
  } catch (e) {
    console.log('SHARE ERROR', e);
  }
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ExportProgress | null }
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

  // Export is disabled while running, while the id is missing, while
  // status is still loading, OR when the live status proves there is
  // nothing useful to export (zero uploaded chunks). The latter rule
  // is what the spec calls "export option only if enough data exists".
  const exportDisabled =
    phase.kind === 'running' ||
    sessionId.length === 0 ||
    statusSummary === null ||
    statusSummary.uploaded === 0;

  async function handleExport() {
    if (!sessionId) return;
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

function ResultBlock({ result }: { result: ExportResult }) {
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
        <Text style={{ color: '#e3b341', fontSize: 13, fontWeight: '600' }}>
          Evidencia parcial
        </Text>
        <Text style={{ color: '#c9d1d9', fontSize: 12, marginTop: 6 }}>
          Algunos fragmentos no pudieron recuperarse.
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
  const palette =
    summary.status === 'complete'
      ? { color: '#56d364', bg: '#0a2a14', label: 'Completa' }
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
