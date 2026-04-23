/**
 * OAuth Drive callback — deep-link landing screen.
 *
 * Reached by the deep link `guardiancloud://oauth/drive?code=...&state=...`
 * that the backend's /auth/drive/callback HTML page hands off to the
 * native app after Google consent. Its only job is to complete the
 * OAuth handshake by calling POST /destinations/drive/connect with
 * { action: 'exchange', code } — the same helper Settings already uses —
 * and then bounce the user back to Settings so they see the updated
 * "Conectado" status without having to reopen the screen manually.
 *
 * Why a dedicated screen instead of letting Settings handle the URL:
 *   - Without a matching file under `app/`, Expo Router shows an
 *     "Unmatched Route" page for `/oauth/drive`. This file IS that
 *     match. The route simply has to exist for Expo Router to stop
 *     intercepting the deep link into an error page.
 *
 * Race safety with Settings:
 *   - Settings has its own Linking listener that fires on the same URL
 *     and calls `exchangeDriveCode`. If Settings wins the race, our
 *     call will fail (Google codes are single-use). We detect this by
 *     checking `getConnectedDrive()` — if the destination is now
 *     connected, treat the exchange as effectively done and show
 *     success. No touching Settings to "coordinate" — strict scope.
 *
 * Intentionally NOT imported or referenced by any other screen. Does
 * not mutate chunks/sessions/recovery state. Pure additive route.
 */

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  exchangeDriveCode,
  getConnectedDrive,
} from '@/api/destinations';

type CallbackStatus = 'idle' | 'exchanging' | 'success' | 'error';

export default function OAuthDriveCallback() {
  const params = useLocalSearchParams<{
    code?: string | string[];
    state?: string | string[];
  }>();
  const [status, setStatus] = useState<CallbackStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Guard against re-runs: the effect below reads `code`/`state`, and
  // React may re-render with the same params. A single attempt per
  // mount is all we want — Google codes are single-use.
  const attemptedRef = useRef(false);

  useEffect(() => {
    async function run() {
      if (attemptedRef.current) return;
      attemptedRef.current = true;

      const code = typeof params.code === 'string' ? params.code : '';
      const state =
        typeof params.state === 'string' && params.state.length > 0
          ? params.state
          : undefined;

      if (!code) {
        setErrorMsg('No se recibió el código de autorización de Google.');
        setStatus('error');
        return;
      }

      setStatus('exchanging');

      try {
        await exchangeDriveCode(code, undefined, state);
        setStatus('success');
        return;
      } catch (err) {
        // Settings screen may have already consumed this code via its
        // own Linking listener (race condition we don't try to
        // coordinate out-of-band). If the destination is now
        // connected, our side of the handshake is effectively done
        // and the user experience should reflect success.
        try {
          const drive = await getConnectedDrive();
          if (drive) {
            setStatus('success');
            return;
          }
        } catch {
          /* fall through to the real error below */
        }

        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(`No se pudo completar la conexión: ${msg}`);
        setStatus('error');
      }
    }
    run();
  }, [params.code, params.state]);

  // Auto-return to Settings after a brief success moment so the user
  // can confirm the new "Conectado" status without manually navigating.
  useEffect(() => {
    if (status !== 'success') return;
    const t = setTimeout(() => {
      router.replace('/settings');
    }, 900);
    return () => clearTimeout(t);
  }, [status]);

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
      {(status === 'idle' || status === 'exchanging') && (
        <View style={{ alignItems: 'center' }}>
          <ActivityIndicator color="#c9d1d9" size="large" />
          <Text
            style={{
              color: '#c9d1d9',
              marginTop: 14,
              fontSize: 15,
              fontWeight: '600',
            }}
          >
            Conectando Google Drive…
          </Text>
          <Text
            style={{
              color: '#8b949e',
              marginTop: 6,
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            Esto puede tardar unos segundos.
          </Text>
        </View>
      )}

      {status === 'success' && (
        <View style={{ alignItems: 'center' }}>
          <Text
            style={{
              color: '#3ddc84',
              fontSize: 18,
              fontWeight: '700',
            }}
          >
            Conexión completada
          </Text>
          <Text
            style={{
              color: '#8b949e',
              marginTop: 8,
              fontSize: 13,
            }}
          >
            Volviendo a Configuración…
          </Text>
        </View>
      )}

      {status === 'error' && (
        <View style={{ alignItems: 'center', width: '100%' }}>
          <Text
            style={{
              color: '#f85149',
              fontSize: 16,
              fontWeight: '700',
              marginBottom: 10,
            }}
          >
            No se pudo conectar
          </Text>
          {errorMsg && (
            <Text
              style={{
                color: '#c9d1d9',
                fontSize: 12,
                textAlign: 'center',
                marginBottom: 18,
                paddingHorizontal: 12,
              }}
            >
              {errorMsg}
            </Text>
          )}
          <Pressable
            onPress={() => router.replace('/settings')}
            style={{
              backgroundColor: '#1f6feb',
              paddingVertical: 12,
              paddingHorizontal: 20,
              borderRadius: 6,
              minWidth: 200,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>
              Volver a Configuración
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
