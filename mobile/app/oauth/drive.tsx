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
import { claimDriveOAuthCode } from '@/oauth/exchangeGuard';

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

      // Module-level claim prevents the duplicate exchange call that
      // would otherwise fire when Settings's `Linking` listener AND
      // this dedicated screen both react to the same deep-link URL in
      // the same JS runtime. First caller wins — the loser falls
      // through to the existing `getConnectedDrive` confirmation path
      // (which already covers the ex-race fallback semantics, and now
      // is also the canonical "the other handler is doing the work"
      // path). No HTTP exchange is started by the loser.
      if (!claimDriveOAuthCode(code)) {
        try {
          const drive = await getConnectedDrive();
          if (drive) {
            setStatus('success');
            return;
          }
          // The other handler claimed but Drive is not connected yet —
          // it is still in flight. Brief retry window: poll a couple
          // of times to catch the connection settling. We intentionally
          // keep this short; a hung handshake on the other side surfaces
          // as the existing "could not connect" error rather than an
          // infinite spinner.
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 250));
            const recheck = await getConnectedDrive();
            if (recheck) {
              setStatus('success');
              return;
            }
          }
          setErrorMsg(
            'No se pudo confirmar la conexión tras la autorización. Reintenta desde Configuración.',
          );
          setStatus('error');
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setErrorMsg(`No se pudo completar la conexión: ${msg}`);
          setStatus('error');
          return;
        }
      }

      try {
        await exchangeDriveCode(code, undefined, state);
        setStatus('success');
        return;
      } catch (err) {
        // We claimed the code but the exchange itself failed (network
        // / Google rejection / backend). Best-effort confirm via
        // `getConnectedDrive` in case the backend created the row
        // before the response surfaced an error; otherwise propagate.
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
