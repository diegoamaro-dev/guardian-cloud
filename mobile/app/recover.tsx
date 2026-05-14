/**
 * "Recuperar evidencia" screen.
 *
 * COMMIT 2 — discovery only. Lists session manifests stored on the user's
 * connected Google Drive. Reconstruction / export from a manifest is
 * deferred to COMMIT 3 — the "Recuperar" button on each row currently
 * surfaces an explanatory Alert.
 *
 * Strict UI isolation:
 *   - no Drive imports, no googleapis, no OAuth handling on this screen
 *   - the only data source is `getRecoverableManifests()` from
 *     `@/api/recovery`, which calls the backend endpoint
 *   - no GC_QUEUE / worker / chunking / recovery / export / background /
 *     AudioEngine reads or writes
 *   - no technical fields (session_id, manifest_file_id, hashes) are
 *     rendered to the user
 *
 * UX states:
 *   loading              — initial fetch in flight
 *   error                — non-Drive error from the API (network, 5xx, etc.)
 *   drive_not_connected  — backend says no connected Drive on this account
 *   empty                — Drive connected, no manifests yet
 *   list                 — one row per recoverable session
 *
 * Pull-to-refresh re-runs the same fetch. The screen is on-demand: nothing
 * runs until the user navigates here, nothing keeps running after they
 * leave.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { router, Stack } from 'expo-router';

import {
  getRecoverableManifests,
  type RecoverableSession,
} from '@/api/recovery';
import { ApiError } from '@/api/client';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'drive_not_connected' }
  | { kind: 'empty' }
  | { kind: 'list'; sessions: RecoverableSession[] };

function formatDate(iso: string): string {
  // Locale-aware human format; fallback to the raw ISO if Date parsing
  // fails for any reason (corrupt manifest snuck past the validator,
  // exotic device locale config). Either way the screen does not throw.
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

function protectionLabel(
  status: 'complete' | 'partial',
): { label: string; color: string } {
  return status === 'complete'
    ? { label: 'Protegido', color: '#3ddc84' }
    : { label: 'Protección parcial', color: '#d29922' };
}

export default function RecoverScreen() {
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    if (!isRefresh) setState({ kind: 'loading' });
    try {
      const res = await getRecoverableManifests();
      if (res.drive_not_connected) {
        setState({ kind: 'drive_not_connected' });
        return;
      }
      if (res.manifests.length === 0) {
        setState({ kind: 'empty' });
        return;
      }
      setState({ kind: 'list', sessions: res.manifests });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: 'error', message });
    } finally {
      if (isRefresh) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(true);
  }, [load]);

  function handleRecover(manifestFileId: string) {
    // The route param is the Drive `file_id` of the manifest. We
    // URL-encode here so file_ids containing `-`, `_`, etc. survive
    // expo-router's path parsing — the detail screen does a defensive
    // `decodeURIComponent` on read. The detail screen is the only
    // consumer of this opaque id; it never reaches the UI.
    //
    // String-template form (not `{ pathname: '/recover/[id]', params }`)
    // because the object form requires typed routes to substitute the
    // `[id]` placeholder; without them expo-router fails to resolve and
    // falls back to the unmatched-route screen. Mirrors `/session/<id>`
    // navigation in history.tsx.
    router.push(`/recover/${encodeURIComponent(manifestFileId)}`);
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#0d1117' }}
      contentContainerStyle={{ padding: 20, paddingTop: 48 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#c9d1d9"
        />
      }
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
      <Text
        style={{
          color: '#8b949e',
          fontSize: 13,
          marginBottom: 20,
          lineHeight: 18,
        }}
      >
        Sesiones respaldadas en tu Google Drive. Aparecen aquí incluso si
        las grabaste desde otro dispositivo, siempre que sea la misma cuenta
        de Drive.
      </Text>

      {state.kind === 'loading' && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 40,
          }}
        >
          <ActivityIndicator color="#c9d1d9" />
          <Text style={{ color: '#c9d1d9', marginLeft: 10 }}>Buscando…</Text>
        </View>
      )}

      {state.kind === 'drive_not_connected' && (
        <View
          style={{
            padding: 16,
            borderWidth: 1,
            borderColor: '#30363d',
            borderRadius: 8,
            backgroundColor: '#161b22',
          }}
        >
          <Text style={{ color: '#c9d1d9', fontSize: 14, fontWeight: '600' }}>
            Conecta Google Drive primero
          </Text>
          <Text
            style={{
              color: '#8b949e',
              fontSize: 12,
              marginTop: 6,
              lineHeight: 17,
            }}
          >
            Para descubrir sesiones recuperables necesitas conectar el
            mismo Google Drive que usabas en el dispositivo anterior.
          </Text>
          <Pressable
            onPress={() => router.push('/settings')}
            style={{
              marginTop: 14,
              backgroundColor: '#1f6feb',
              padding: 12,
              borderRadius: 6,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>
              Ir a Configuración
            </Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'empty' && (
        <View
          style={{
            padding: 16,
            borderWidth: 1,
            borderColor: '#30363d',
            borderRadius: 8,
            backgroundColor: '#161b22',
          }}
        >
          <Text style={{ color: '#c9d1d9', fontSize: 14, fontWeight: '600' }}>
            No hay sesiones recuperables
          </Text>
          <Text
            style={{
              color: '#8b949e',
              fontSize: 12,
              marginTop: 6,
              lineHeight: 17,
            }}
          >
            Cuando completes una grabación con Drive conectado, aparecerá
            aquí para que puedas recuperarla desde otro dispositivo.
          </Text>
        </View>
      )}

      {state.kind === 'error' && (
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
            No se pudo cargar la lista
          </Text>
          <Text
            style={{
              color: '#c9d1d9',
              fontSize: 12,
              marginTop: 6,
              lineHeight: 17,
            }}
          >
            {state.message}
          </Text>
          <Pressable
            onPress={() => load(false)}
            style={{
              marginTop: 14,
              backgroundColor: '#30363d',
              padding: 12,
              borderRadius: 6,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#c9d1d9', fontWeight: '700' }}>
              Reintentar
            </Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'list' &&
        state.sessions.map((s) => {
          const protection = protectionLabel(s.protection_status);
          return (
            <View
              key={s.session_id}
              style={{
                padding: 14,
                borderWidth: 1,
                borderColor: '#30363d',
                borderRadius: 8,
                backgroundColor: '#161b22',
                marginBottom: 10,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <Text style={{ fontSize: 18, marginRight: 8 }}>
                  {modeIcon(s.mode)}
                </Text>
                <Text
                  style={{
                    color: '#c9d1d9',
                    fontSize: 14,
                    fontWeight: '600',
                    flexShrink: 1,
                  }}
                >
                  {formatDate(s.completed_at)}
                </Text>
              </View>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: 12,
                }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: protection.color,
                    marginRight: 8,
                  }}
                />
                <Text
                  style={{
                    color: protection.color,
                    fontSize: 12,
                    fontWeight: '600',
                  }}
                >
                  {protection.label}
                </Text>
              </View>
              <Pressable
                onPress={() => handleRecover(s.manifest_file_id)}
                style={{
                  backgroundColor: '#1f6feb',
                  padding: 12,
                  borderRadius: 6,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>
                  Recuperar
                </Text>
              </Pressable>
            </View>
          );
        })}
    </ScrollView>
  );
}
