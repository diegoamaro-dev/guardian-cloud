/**
 * Recovery detail screen — drives `exportRecoveredSession` for the
 * manifest selected in `app/recover/index.tsx`. The route param is the
 * manifest's Drive `file_id` (URL-encoded by the caller).
 *
 * Minimal UI for cross-device evidence reconstruction:
 *   - shows session date + mode while idle
 *   - one button "Reconstruir y exportar" → drives the manifest export
 *   - progress text while running
 *   - result block with an honest recovery verdict
 *   - "Guardar en el dispositivo" (Android SAF) + "Compartir archivo"
 *
 * No technical fields surfaced (no hashes, chunk lists, manifest_file_id,
 * remote_reference). The screen only reads `RecoveryFullManifest` for
 * the date/mode header; chunk-level details stay backend-side.
 *
 * Strict isolation:
 *   - no GC_QUEUE / worker / chunking / recovery / export pipeline /
 *     background service / AudioEngine reads or writes
 *   - no Drive imports, no googleapis on the device
 *   - the on-disk file uses prefix `guardian_recovered_` so it never
 *     overwrites the normal export's `guardian_export_` file for the
 *     same session_id; both can coexist
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

import {
  exportRecoveredSession,
  getRecoveryManifest,
  type RecoveryFullManifest,
} from '@/api/recoveryExport';
import { ApiError } from '@/api/client';
import { type ExportProgress, type ExportResult } from '@/api/export';
// Verdict copy lives in a pure module so it can be unit-tested without a
// React Native runtime — and so this screen and the recovery list cannot
// drift into contradicting each other about the same session.
import { recoveryDetailVerdict } from '@/recovery/recoveryVerdict';

// ---------------------------------------------------------------------------
// Save / Share helpers — intentionally duplicated from
// `app/session/[id].tsx` (limited surface). The user signed off on
// "duplicación mínima" for COMMIT 3 to keep the normal export screen
// untouched. If a third caller appears we extract; until then two copies
// is cheaper than a shared module.
// ---------------------------------------------------------------------------

let isSharing = false;
async function handleShare(filePath: string): Promise<void> {
  if (isSharing) return;
  isSharing = true;
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) return;
    await Sharing.shareAsync(filePath);
  } catch (e) {
    console.log('RECOVERY SHARE ERROR', e);
  } finally {
    isSharing = false;
  }
}

function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.aac':
      return 'audio/aac';
    case '.m4a':
      return 'audio/mp4';
    case '.mp4':
      return 'video/mp4';
    case '.bin':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

let isSavingToDevice = false;
async function handleSaveToDevice(
  filePath: string,
  extension: string,
): Promise<'saved' | 'cancelled' | 'unsupported' | 'error'> {
  if (Platform.OS !== 'android') return 'unsupported';
  if (isSavingToDevice) return 'cancelled';
  isSavingToDevice = true;
  try {
    const SAF = FileSystem.StorageAccessFramework;
    const perm = await SAF.requestDirectoryPermissionsAsync();
    if (!perm.granted || !perm.directoryUri) return 'cancelled';

    const lastSlash = filePath.lastIndexOf('/');
    const fileName =
      lastSlash >= 0 && lastSlash < filePath.length - 1
        ? filePath.substring(lastSlash + 1)
        : `guardian_recovered${extension}`;

    const mime = mimeForExtension(extension);
    const targetUri = await SAF.createFileAsync(perm.directoryUri, fileName, mime);
    const base64 = await FileSystem.readAsStringAsync(filePath, {
      encoding: FileSystem.EncodingType.Base64,
    });
    await FileSystem.writeAsStringAsync(targetUri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return 'saved';
  } catch (e) {
    console.log('RECOVERY SAVE ERROR', e);
    return 'error';
  } finally {
    isSavingToDevice = false;
  }
}

function SaveToDeviceButton({
  filePath,
  extension,
}: {
  filePath: string;
  extension: string;
}) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  if (Platform.OS !== 'android') return null;

  const labels: Record<typeof state, string> = {
    idle: 'Guardar en el dispositivo',
    saving: 'Guardando…',
    saved: 'Guardado ✓',
    error: 'No se pudo guardar',
  };

  const palette =
    state === 'saved'
      ? { border: '#238636', bg: '#0a2a14', color: '#56d364' }
      : state === 'error'
        ? { border: '#f85149', bg: '#2d0d12', color: '#f85149' }
        : { border: '#1f6feb', bg: '#0c1e3a', color: '#c9d1d9' };

  return (
    <Pressable
      onPress={async () => {
        if (state !== 'idle') return;
        setState('saving');
        const outcome = await handleSaveToDevice(filePath, extension);
        if (outcome === 'cancelled' || outcome === 'unsupported') {
          setState('idle');
          return;
        }
        setState(outcome === 'saved' ? 'saved' : 'error');
        const revertMs = outcome === 'saved' ? 2000 : 3000;
        setTimeout(() => setState('idle'), revertMs);
      }}
      disabled={state !== 'idle'}
      style={{
        marginTop: 10,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: palette.border,
        borderRadius: 6,
        backgroundColor: palette.bg,
        alignItems: 'center',
        opacity: state === 'saving' ? 0.85 : 1,
      }}
    >
      <Text style={{ color: palette.color, fontSize: 13, fontWeight: '600' }}>
        {labels[state]}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type Phase =
  | { kind: 'loading' }
  | { kind: 'idle'; manifest: RecoveryFullManifest }
  | {
      kind: 'running';
      manifest: RecoveryFullManifest;
      progress: ExportProgress | null;
    }
  | {
      kind: 'done';
      manifest: RecoveryFullManifest;
      result: ExportResult;
    }
  | { kind: 'error'; message: string };

function formatDate(iso: string | null): string {
  // Presentation only. Manifests written incrementally during recording
  // carry a null `completed_at`; render an em-dash so the row stays
  // structured. The recovery verdict is derived separately from
  // `result.status` — `completed_at` is never used as proof that the
  // capture ended cleanly.
  if (iso === null) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function modeIcon(mode: 'audio' | 'video'): string {
  return mode === 'video' ? '🎥' : '🎤';
}

export default function RecoverDetailScreen() {
  const params = useLocalSearchParams<{ id: string | string[] }>();
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  // Defensive decode — Expo Router gives us the segment already URL-decoded
  // in most cases, but encodeURIComponent on the caller side and a manual
  // decodeURIComponent here keeps the contract explicit. Falls back to the
  // raw value if decode throws (malformed param).
  let manifestFileId = '';
  if (typeof rawId === 'string') {
    try {
      manifestFileId = decodeURIComponent(rawId);
    } catch {
      manifestFileId = rawId;
    }
  }

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const loadManifest = useCallback(async () => {
    if (!manifestFileId) {
      setPhase({
        kind: 'error',
        message: 'Identificador de evidencia ausente.',
      });
      return;
    }
    setPhase({ kind: 'loading' });
    try {
      const m = await getRecoveryManifest(manifestFileId);
      setPhase({ kind: 'idle', manifest: m });
    } catch (err) {
      const message =
        err instanceof ApiError && err.code === 'MANIFEST_NOT_FOUND'
          ? 'Esta evidencia ya no está disponible. Actualiza la lista.'
          : err instanceof ApiError && err.code === 'MANIFEST_INVALID'
            ? 'El índice de la evidencia está dañado.'
            : err instanceof ApiError && err.code === 'DRIVE_NOT_CONNECTED'
              ? 'Conecta Google Drive para recuperar esta evidencia.'
              : err instanceof Error
                ? err.message
                : String(err);
      setPhase({ kind: 'error', message });
    }
  }, [manifestFileId]);

  useEffect(() => {
    loadManifest();
  }, [loadManifest]);

  async function handleRun() {
    if (phase.kind !== 'idle') return;
    const manifest = phase.manifest;
    setPhase({ kind: 'running', manifest, progress: null });

    const outcome = await exportRecoveredSession(
      manifestFileId,
      (progress) => {
        // setPhase ignores updates if user navigated away before this fires;
        // React handles that gracefully (state is just discarded).
        setPhase((prev) =>
          prev.kind === 'running' ? { ...prev, progress } : prev,
        );
      },
    );

    if (outcome.kind === 'manifest_failure') {
      setPhase({ kind: 'error', message: outcome.message });
      return;
    }

    setPhase({ kind: 'done', manifest, result: outcome.result });
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#0d1117' }}
      contentContainerStyle={{ padding: 20, paddingTop: 48 }}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <Pressable
        onPress={() => router.back()}
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
        Recuperar evidencia
      </Text>

      {phase.kind === 'loading' && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 32,
          }}
        >
          <ActivityIndicator color="#c9d1d9" />
          <Text style={{ color: '#c9d1d9', marginLeft: 10 }}>
            Buscando evidencia…
          </Text>
        </View>
      )}

      {phase.kind === 'error' && (
        <View
          style={{
            padding: 16,
            borderWidth: 1,
            borderColor: '#f85149',
            borderRadius: 8,
            backgroundColor: '#2d0d12',
          }}
        >
          <Text style={{ color: '#f85149', fontSize: 13, fontWeight: '700' }}>
            No se pudo abrir esta evidencia
          </Text>
          <Text
            style={{
              color: '#c9d1d9',
              fontSize: 12,
              marginTop: 6,
              lineHeight: 17,
            }}
          >
            {phase.message}
          </Text>
          <Pressable
            onPress={() => router.back()}
            style={{
              marginTop: 14,
              backgroundColor: '#30363d',
              padding: 12,
              borderRadius: 6,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#c9d1d9', fontWeight: '700' }}>
              Volver a la lista
            </Text>
          </Pressable>
        </View>
      )}

      {(phase.kind === 'idle' ||
        phase.kind === 'running' ||
        phase.kind === 'done') && (
        <>
          <View
            style={{
              padding: 14,
              borderWidth: 1,
              borderColor: '#30363d',
              borderRadius: 8,
              backgroundColor: '#161b22',
              marginBottom: 16,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginBottom: 4,
              }}
            >
              <Text style={{ fontSize: 18, marginRight: 8 }}>
                {modeIcon(phase.manifest.mode)}
              </Text>
              <Text style={{ color: '#c9d1d9', fontSize: 14, fontWeight: '600' }}>
                {formatDate(phase.manifest.completed_at)}
              </Text>
            </View>
            <Text style={{ color: '#8b949e', fontSize: 12, marginTop: 4 }}>
              {phase.manifest.mode === 'video' ? 'Vídeo' : 'Audio'}
            </Text>
          </View>

          {phase.kind === 'idle' && (
            <Pressable
              onPress={handleRun}
              style={{
                backgroundColor: '#1f6feb',
                padding: 14,
                borderRadius: 6,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>
                Reconstruir y exportar
              </Text>
            </Pressable>
          )}

          {phase.kind === 'running' && (
            <View
              style={{
                padding: 16,
                borderWidth: 1,
                borderColor: '#30363d',
                borderRadius: 8,
                backgroundColor: '#161b22',
              }}
            >
              <View
                style={{ flexDirection: 'row', alignItems: 'center' }}
              >
                <ActivityIndicator color="#c9d1d9" />
                <Text style={{ color: '#c9d1d9', marginLeft: 10, fontSize: 14 }}>
                  Recuperando evidencia…
                </Text>
              </View>
              {phase.progress && phase.progress.total > 0 && (
                <Text
                  style={{
                    color: '#8b949e',
                    fontSize: 12,
                    marginTop: 10,
                  }}
                >
                  {Math.min(
                    Math.round(
                      (Math.max(0, phase.progress.done) /
                        phase.progress.total) *
                        100,
                    ),
                    100,
                  )}
                  %
                </Text>
              )}
            </View>
          )}

          {phase.kind === 'done' && (
            <ResultBlock result={phase.result} />
          )}
        </>
      )}
    </ScrollView>
  );
}

function ResultBlock({ result }: { result: ExportResult }) {
  // Derived from `result.status` alone. Deliberately NOT from
  // `validChunks`, `totalChunks`, `completed_at` or `protection_status`:
  // none of them establishes that the recording itself ran to the end
  // (GC-AUD-033). See `@/recovery/recoveryVerdict`.
  const verdict = recoveryDetailVerdict(result.status);
  const frameBorder =
    result.status === 'complete'
      ? '#238636'
      : result.status === 'partial'
        ? '#d29922'
        : '#f85149';
  const frameBg =
    result.status === 'complete'
      ? '#0a2a14'
      : result.status === 'partial'
        ? '#2d2204'
        : '#2d0d12';

  return (
    <View
      style={{
        marginTop: 4,
        padding: 14,
        borderWidth: 1,
        borderColor: frameBorder,
        borderRadius: 8,
        backgroundColor: frameBg,
      }}
    >
      <Text style={{ color: verdict.color, fontSize: 14, fontWeight: '700' }}>
        {verdict.label}
      </Text>
      {verdict.hint && (
        <Text
          style={{
            color: '#c9d1d9',
            fontSize: 12,
            marginTop: 8,
            lineHeight: 17,
          }}
        >
          {verdict.hint}
        </Text>
      )}

      {/* Save / Share actions — shown whenever we wrote a file, which
          covers both complete and partial exports. The shared exporter
          enforces "survival > perfection": even a partial export is a
          forensic dump worth sharing, so the buttons are not gated on
          status === 'complete'. */}
      {result.filePath && (
        <>
          <SaveToDeviceButton
            filePath={result.filePath}
            extension={
              result.extension ??
              result.filePath.match(/\.[a-z0-9]+$/i)?.[0] ??
              '.bin'
            }
          />
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
            <Text style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '500' }}>
              Compartir archivo
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
