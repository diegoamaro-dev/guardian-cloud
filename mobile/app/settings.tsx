import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import * as ExpoLinking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, Stack } from 'expo-router';

import { supabase } from '@/auth/supabase';
import { useAuthStore } from '@/auth/store';
import {
  driveTestUpload,
  exchangeDriveCode,
  getConnectedDrive,
  listDestinations,
  startDriveConnect,
  type DestinationType,
  type PublicDestination,
} from '@/api/destinations';
import {
  getPreferredDestinationType,
  setPreferredDestinationType,
} from '@/destinations/preference';
import { claimDriveOAuthCode } from '@/oauth/exchangeGuard';
import { openBatteryOptimizationSettings } from '@/permissions/batteryOptimization';
// DEV-only queue wipe — surfaced as a button at the bottom of this screen.
// Does NOT touch auth/Drive/anything else; only Guardian Cloud queue keys.
import { clearGuardianQueueDev } from '.';

// Mirror of the key written by the home screen after a session is created
// or recovered. See index.tsx LAST_SESSION_ID_KEY. Kept as a literal on
// purpose — introducing a shared module just for this would be premature.
const LAST_SESSION_ID_KEY = 'export.last_session_id';
// Mirror of the panic-mode preference key in app/index.tsx
// (QUICK_START_KEY). Same duplication policy as LAST_SESSION_ID_KEY:
// one literal in two files is cheaper than a shared module for one
// const. Both files MUST stay in sync.
const QUICK_START_KEY = 'guardian.quick_start';

/**
 * Settings screen — destination management.
 *
 * MVP scope (UI_SCREENS.md §6 "Configuración" + §7 "Conexión Drive"):
 *   - show current Drive connection status (connected / not connected)
 *   - "Conectar Google Drive" button that opens the Google consent URL
 *   - listen for the OAuth redirect (custom scheme) and exchange the
 *     authorisation code with the backend
 *   - "Enviar archivo de prueba" button (once connected) — proves an
 *     actual file reaches the user's Drive. This is the MVP acceptance
 *     handshake from the current brief.
 *
 * Nothing here touches chunks, sessions or the recovery flow. This
 * screen is purely additive.
 *
 * Deep-link contract:
 *   - Scheme: `guardiancloud://` (defined in app.config.ts).
 *   - OAuth redirect URI: `guardiancloud://oauth/drive` — the client
 *     ASKS the backend for the Google auth URL with THIS redirect_uri
 *     so the exchange step uses the same value (Google is strict about
 *     redirect_uri matching).
 *   - The backend's `GOOGLE_REDIRECT_URI` env var MUST also be set to
 *     the same URL and MUST be registered as an authorised redirect
 *     on the Google Cloud OAuth client.
 */

const OAUTH_REDIRECT_PATH = 'oauth/drive';

// External URL for the optional "support the creator" affordance shown
// at the bottom of this screen. Opened via `Linking.openURL`. Pure UI —
// touches no auth, no Drive flow, no queue.
const CREATOR_COFFEE_URL = 'https://app.guardiancloud.app/cafe.html';

// Temporary beta-feedback survey URL shown right above the creator
// coffee button. Same opener (`Linking.openURL`), same isolation: no
// analytics, no webview, no backend, no queue. Removed when the beta
// closes.
const BETA_FEEDBACK_URL = 'https://app.guardiancloud.app/encuesta.html';

type Screen =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'ready'; drive: PublicDestination | null };

function buildRedirectUri(): string {
  // `createURL` respects the scheme defined in app.config.ts and is safe
  // in Dev Client / managed / prebuilt builds.
  return ExpoLinking.createURL(OAUTH_REDIRECT_PATH);
}

function parseCodeFromUrl(url: string): string | null {
  try {
    const parsed = ExpoLinking.parse(url);
    const code =
      parsed.queryParams && typeof parsed.queryParams.code === 'string'
        ? parsed.queryParams.code
        : null;
    return code;
  } catch {
    return null;
  }
}

export default function SettingsScreen() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [busy, setBusy] = useState<false | 'connecting' | 'exchanging' | 'uploading'>(
    false,
  );
  const [lastUploadRef, setLastUploadRef] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  /**
   * Connected NAS destination, if any. Filled alongside `drive` by
   * `refreshState`. Used solely to decide whether to render the
   * destination selector (selector is visible iff Drive AND NAS are
   * both connected).
   */
  const [nas, setNas] = useState<PublicDestination | null>(null);
  /**
   * Persisted user preference for the upload destination. Loaded from
   * AsyncStorage on mount and refreshed whenever the user picks an
   * option in the selector. `null` = no explicit choice → the resolver
   * in the home screen falls back to "Drive first, NAS second".
   */
  const [preferred, setPreferred] = useState<DestinationType | null>(null);
  // Persisted "Inicio rápido" panic-mode preference. When true, the
  // home screen renders the "Inicio rápido activado" pill AND, on a
  // returning-user cold start, launches a short visible countdown
  // that ends in `startRecording()` unless the user cancels (tap,
  // blur, background). First-install is gated, so the first contact
  // with the app stays explicit. See QUICK_START_KEY in app/index.tsx
  // for the full behaviour spec.
  const [quickStartEnabled, setQuickStartEnabled] = useState(false);
  const [quickStartBusy, setQuickStartBusy] = useState(false);

  // Guard against double-exchange: if a deep link fires twice or we pick
  // up the same URL via both `getInitialURL` and the `url` listener, the
  // code is single-use — hitting /exchange twice returns an error. This
  // ref lets us collapse duplicates into one.
  const exchangedCodesRef = useRef<Set<string>>(new Set());

  async function refreshState() {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? null;
      if (!token) {
        setScreen({ kind: 'signed-out' });
        return;
      }
      useAuthStore.setState({
        status: 'signed-in',
        user: data.session?.user ?? null,
        accessToken: token,
      });
      // One round-trip for both: same data already powers
      // `getConnectedDrive`. Lets us also detect NAS without a second
      // request, and keeps the existing home-screen contract intact.
      const { destinations } = await listDestinations();
      const driveDest = destinations.find(
        (d) => d.type === 'drive' && d.status === 'connected',
      ) ?? null;
      const nasDest = destinations.find(
        (d) => d.type === 'nas' && d.status === 'connected',
      ) ?? null;
      setNas(nasDest);
      // Load the persisted preference. The selector is rendered only
      // when both Drive and NAS are connected — for the single-
      // destination cases the resolver in the home screen picks the
      // only valid option automatically, so the preference is
      // informational at most.
      let pref = await getPreferredDestinationType();
      // Beta defensive guard: NAS has no mobile onboarding flow yet, so
      // a stale `preferred === 'nas'` would leave the home resolver
      // pointing at a destination the user cannot manage from mobile.
      // Normalize silently to 'drive' here — and persist the rewrite so
      // subsequent reads (home screen `refreshDestination`, next app
      // launch) see the corrected value too. Storage failure is
      // swallowed: local state still normalizes, next visit retries.
      // Remove this block when the NAS mobile flow ships.
      if (pref === 'nas') {
        try {
          await setPreferredDestinationType('drive');
        } catch {
          /* persistence failed — local state still corrected below */
        }
        pref = 'drive';
      }
      setPreferred(pref);
      setScreen({ kind: 'ready', drive: driveDest });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setNas(null);
      setScreen({ kind: 'ready', drive: null });
    }
  }

  useEffect(() => {
    refreshState();
  }, []);

  // Read-only lookup of the last session_id persisted by the home screen.
  // Feeds the temporary "Exportar última sesión" shortcut below.
  useEffect(() => {
    AsyncStorage.getItem(LAST_SESSION_ID_KEY)
      .then((value) => {
        if (value) setLastSessionId(value);
      })
      .catch(() => {
        /* ignore — shortcut simply stays hidden */
      });
  }, []);

  // Hydrate the Inicio-rápido toggle on mount. '1' means ON; anything
  // else (including null) means OFF. Defaults to OFF on first run so
  // the user opts in explicitly.
  useEffect(() => {
    AsyncStorage.getItem(QUICK_START_KEY)
      .then(raw => setQuickStartEnabled(raw === '1'))
      .catch(() => {
        /* default false, ignore */
      });
  }, []);

  async function toggleQuickStart() {
    const next = !quickStartEnabled;
    setQuickStartBusy(true);
    setQuickStartEnabled(next); // optimistic — revert on persistence error
    try {
      await AsyncStorage.setItem(QUICK_START_KEY, next ? '1' : '0');
    } catch (err) {
      // Persistence failed — roll back the toggle so what the UI shows
      // matches what the home screen will read on next mount.
      setQuickStartEnabled(!next);
      console.log('QUICK_START toggle persist failed', err);
    } finally {
      setQuickStartBusy(false);
    }
  }

  // --- Deep-link handling for the OAuth redirect.
  useEffect(() => {
    async function handleUrl(url: string | null) {
      if (!url) return;
      if (!url.includes(OAUTH_REDIRECT_PATH)) return;
      const code = parseCodeFromUrl(url);
      if (!code) return;
      if (exchangedCodesRef.current.has(code)) return;
      exchangedCodesRef.current.add(code);

      // Module-level claim coordinates with the dedicated
      // `app/oauth/drive.tsx` screen, which also reacts to this same
      // deep link via Expo Router mounting. First caller wins — the
      // loser MUST NOT call `exchangeDriveCode` (Google codes are
      // single-use, the duplicate POST returns invalid_grant). The
      // loser instead waits briefly for the winner to land the
      // connection, then refreshes the visible state.
      if (!claimDriveOAuthCode(code)) {
        try {
          setErrorMsg(null);
          setBusy('exchanging');
          // Short polling window: the dedicated screen's exchange is
          // typically a single round-trip, so a few hundred ms covers
          // the common case. We intentionally do NOT chain on a
          // promise the other screen owns — this is a UI refresh,
          // not coordination of the network call itself.
          for (let i = 0; i < 6; i++) {
            const drive = await getConnectedDrive();
            if (drive) {
              await refreshState();
              return;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          // The other handler did not finish in our window. Refresh
          // anyway so the user sees current truth — and surface a
          // generic message (no exchange-side detail to forward,
          // since we never started one ourselves).
          await refreshState();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setErrorMsg(`No se pudo completar la conexión: ${msg}`);
        } finally {
          setBusy(false);
        }
        return;
      }

      try {
        setErrorMsg(null);
        setBusy('exchanging');
        await exchangeDriveCode(code, buildRedirectUri());
        await refreshState();
        Alert.alert('Google Drive', 'Conexión completada correctamente.');
      } catch (err) {
        // We won the claim but the exchange itself failed (network /
        // Google / backend). Confirm against the backend in case the
        // row was created before the response surfaced an error; if
        // not, surface the original failure.
        try {
          const drive = await getConnectedDrive();
          if (drive) {
            await refreshState();
            return;
          }
        } catch {
          /* getConnectedDrive failed — fall through to real error */
        }
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(`No se pudo completar la conexión: ${msg}`);
      } finally {
        setBusy(false);
      }
    }

    // Cold-start path.
    ExpoLinking.getInitialURL()
      .then(handleUrl)
      .catch(() => {
        /* ignore */
      });

    // Foreground / background-to-foreground path.
    const sub = Linking.addEventListener('url', (event) => {
      handleUrl(event.url);
    });
    return () => sub.remove();
  }, []);

  /**
   * Persist the user's choice of upload destination. Only callable
   * while both Drive and NAS are connected (the selector is hidden
   * otherwise). The home screen reads the new value the next time it
   * runs `refreshDestination` (mount / focus / OAuth return), so the
   * effect on the worker is eventual rather than instant — by design,
   * to avoid in-flight retargeting during an active recording.
   */
  async function handleSelectPreferred(type: DestinationType) {
    setPreferred(type);
    await setPreferredDestinationType(type);
  }

  async function handleConnectDrive() {
    setErrorMsg(null);
    setBusy('connecting');
    try {
      const redirectUri = buildRedirectUri();
      const { auth_url } = await startDriveConnect(redirectUri);
      const supported = await Linking.canOpenURL(auth_url);
      if (!supported) {
        throw new Error('No se puede abrir el navegador para autorizar Google.');
      }
      await Linking.openURL(auth_url);
      // Control returns via the deep-link listener above. We leave `busy`
      // as 'connecting' until then; the listener will flip to 'exchanging'.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setBusy(false);
    }
  }

  async function handleTestUpload() {
    setErrorMsg(null);
    setLastUploadRef(null);
    setBusy('uploading');
    try {
      const res = await driveTestUpload();
      setLastUploadRef(res.remote_reference);
      Alert.alert(
        'Google Drive',
        `Archivo de prueba subido correctamente.\nID: ${res.remote_reference}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`No se pudo subir el archivo de prueba: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#0d1117' }}
      contentContainerStyle={{ padding: 20, paddingTop: 48 }}
    >
      {/* Hide Expo Router's default header so the screen renders only
          the Guardian Cloud custom dark header below. Without this the
          user sees two headers — the native "settings" bar plus our
          "← Volver / Configuración" pair — which looked inconsistent
          and added a duplicate back affordance. Same technique as the
          home route. */}
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
          marginBottom: 20,
        }}
      >
        Configuración
      </Text>

      <Text
        style={{
          color: '#8b949e',
          fontSize: 12,
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        DESTINO DE ALMACENAMIENTO
      </Text>

      <View
        style={{
          backgroundColor: '#161b22',
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 8,
          padding: 16,
          marginBottom: 20,
        }}
      >
        {screen.kind === 'loading' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <ActivityIndicator color="#c9d1d9" />
            <Text style={{ color: '#c9d1d9', marginLeft: 10 }}>Cargando…</Text>
          </View>
        ) : screen.kind === 'signed-out' ? (
          <Text style={{ color: '#f85149' }}>
            Necesitas iniciar sesión.
          </Text>
        ) : (
          <DriveStatusBlock drive={screen.drive} />
        )}
      </View>

      <Pressable
        onPress={handleConnectDrive}
        disabled={Boolean(busy) || screen.kind !== 'ready'}
        style={{
          backgroundColor:
            screen.kind === 'ready' && screen.drive ? '#30363d' : '#1f6feb',
          opacity: busy ? 0.6 : 1,
          padding: 14,
          borderRadius: 6,
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '700' }}>
          {screen.kind === 'ready' && screen.drive
            ? 'Reconectar Google Drive'
            : 'Conectar Google Drive'}
        </Text>
      </Pressable>

      {screen.kind === 'ready' && screen.drive && (
        <Pressable
          onPress={handleTestUpload}
          disabled={Boolean(busy)}
          style={{
            backgroundColor: '#238636',
            opacity: busy ? 0.6 : 1,
            padding: 14,
            borderRadius: 6,
            alignItems: 'center',
            marginBottom: 10,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>
            Enviar archivo de prueba
          </Text>
        </Pressable>
      )}

      {/* Destination selector — visible whenever Drive is connected.
          During the beta Drive is the only active option; the NAS
          button is rendered in a fully inert disabled state so the
          user can see the destination on the roadmap without being
          able to pick it (no onPress, opacity dimmed, never highlighted
          as selected). When the mobile NAS onboarding flow ships,
          re-enable NAS in the inner map and restore the original "both
          connected → user picks" semantics.

          Pure UI: writing the preference does NOT touch GC_QUEUE, the
          worker, recovery, or the backend. The home screen picks up
          the new value on its next `refreshDestination` tick. */}
      {screen.kind === 'ready' && screen.drive && (
        <View
          style={{
            marginBottom: 10,
            padding: 12,
            borderWidth: 1,
            borderColor: '#30363d',
            borderRadius: 6,
            backgroundColor: '#161b22',
          }}
        >
          <Text style={{ color: '#c9d1d9', fontSize: 13, fontWeight: '700' }}>
            Destino activo
          </Text>
          <Text style={{ color: '#8b949e', fontSize: 11, marginTop: 4 }}>
            La beta usa Google Drive. NAS personal llegará después.
          </Text>
          <View style={{ flexDirection: 'row', marginTop: 10 }}>
            {(['drive', 'nas'] as const).map((opt) => {
              // NAS is wired in the backend but the mobile onboarding
              // flow does not exist yet. We keep the button rendered so
              // users with a pre-existing NAS connection still see the
              // destination on the roadmap, but it is fully inert during
              // beta: no onPress, no `selected` highlight (even if a
              // stale `preferred === 'nas'` is persisted), opacity
              // dimmed, and `disabled` so RN swallows touches. Drive
              // remains the only pickable option. Restore original
              // logic when the mobile NAS flow ships.
              const isNas = opt === 'nas';
              const selected =
                !isNas &&
                (preferred === opt ||
                  (preferred === null && opt === 'drive'));
              return (
                <Pressable
                  key={opt}
                  onPress={
                    isNas ? undefined : () => handleSelectPreferred(opt)
                  }
                  disabled={isNas}
                  style={{
                    flex: 1,
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    marginRight: opt === 'drive' ? 8 : 0,
                    borderWidth: 1,
                    borderColor: selected ? '#1f6feb' : '#30363d',
                    borderRadius: 6,
                    backgroundColor: selected ? '#0b2240' : '#0d1117',
                    alignItems: 'center',
                    // Vertical centering matters because the NAS button
                    // wraps two lines (title + "Disponible…") while
                    // Drive has only one — without this the Drive label
                    // sticks to the top of its taller-by-sibling box.
                    justifyContent: 'center',
                    opacity: isNas ? 0.5 : 1,
                  }}
                >
                  <Text
                    style={{
                      color: selected ? '#58a6ff' : '#c9d1d9',
                      fontSize: 13,
                      fontWeight: '600',
                      textAlign: 'center',
                    }}
                  >
                    {isNas ? '🗄️ NAS personal' : 'Google Drive'}
                  </Text>
                  {isNas && (
                    <Text
                      style={{
                        color: '#6e7681',
                        fontSize: 10,
                        marginTop: 4,
                        textAlign: 'center',
                      }}
                    >
                      Disponible después de la beta
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {busy && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 8,
          }}
        >
          <ActivityIndicator color="#c9d1d9" />
          <Text style={{ color: '#c9d1d9', marginLeft: 10 }}>
            {busy === 'connecting'
              ? 'Abriendo Google…'
              : busy === 'exchanging'
                ? 'Completando conexión…'
                : 'Subiendo archivo de prueba…'}
          </Text>
        </View>
      )}

      {lastUploadRef && (
        <View
          style={{
            marginTop: 14,
            padding: 12,
            borderWidth: 1,
            borderColor: '#238636',
            borderRadius: 6,
            backgroundColor: '#0a2a14',
          }}
        >
          <Text style={{ color: '#56d364', fontSize: 12 }}>
            Última subida OK · file_id:
          </Text>
          <Text
            selectable
            style={{ color: '#c9d1d9', fontSize: 12, marginTop: 4 }}
          >
            {lastUploadRef}
          </Text>
        </View>
      )}

      {errorMsg && (
        <View
          style={{
            marginTop: 14,
            padding: 12,
            borderWidth: 1,
            borderColor: '#f85149',
            borderRadius: 6,
            backgroundColor: '#2d0d12',
          }}
        >
          <Text style={{ color: '#f85149', fontSize: 12 }}>{errorMsg}</Text>
        </View>
      )}

      <Text
        style={{
          color: '#6e7681',
          fontSize: 11,
          marginTop: 28,
          lineHeight: 16,
        }}
      >
        Guardian Cloud guarda la evidencia en TU Google Drive. El acceso se
        limita a una única carpeta (
        <Text style={{ color: '#c9d1d9' }}>/GuardianCloud</Text>). Puedes
        revocar el permiso en cualquier momento desde la configuración de tu
        cuenta de Google.
      </Text>

      {/* Cross-device recovery entry point — opens the "Recuperar
          evidencia" screen which discovers manifests stored on the
          connected Drive. Pure navigation: no Drive API calls happen
          here, no GC_QUEUE / worker / chunking / recovery / export /
          background / AudioEngine reads or writes from this row. The
          target screen is on-demand and isolated. */}
      <Text
        style={{
          color: '#8b949e',
          fontSize: 12,
          letterSpacing: 1,
          marginTop: 28,
          marginBottom: 8,
        }}
      >
        RECUPERACIÓN
      </Text>
      <Pressable
        onPress={() => router.push('/recover')}
        style={{
          padding: 14,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 8,
          backgroundColor: '#161b22',
        }}
      >
        <Text style={{ color: '#c9d1d9', fontSize: 14, fontWeight: '600' }}>
          Recuperar evidencia de otro dispositivo
        </Text>
        <Text
          style={{ color: '#6e7681', fontSize: 11, marginTop: 4, lineHeight: 15 }}
        >
          Si grabaste con Guardian Cloud en otro móvil y conectaste el
          mismo Google Drive, busca aquí las sesiones respaldadas.
        </Text>
        <Text
          style={{
            color: '#58a6ff',
            fontSize: 12,
            fontWeight: '600',
            marginTop: 10,
          }}
        >
          Abrir →
        </Text>
      </Pressable>

      {/* Modo pánico — persisted user preference. When ON, the home
          screen renders an "Inicio rápido activado" pill near the
          GRABAR AHORA button and, on a returning-user cold start,
          launches a visible cancelable countdown that ends in
          `startRecording()`. First-install is gated. Full behaviour
          spec in app/index.tsx near QUICK_START_KEY. */}
      <Text
        style={{
          color: '#8b949e',
          fontSize: 12,
          letterSpacing: 1,
          marginTop: 28,
          marginBottom: 8,
        }}
      >
        MODO PÁNICO
      </Text>
      <Pressable
        onPress={toggleQuickStart}
        disabled={quickStartBusy}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 14,
          borderWidth: 1,
          borderColor: quickStartEnabled ? '#3ddc84' : '#30363d',
          borderRadius: 8,
          backgroundColor: '#161b22',
          opacity: quickStartBusy ? 0.6 : 1,
        }}
      >
        <View style={{ flexShrink: 1, paddingRight: 12 }}>
          <Text style={{ color: '#c9d1d9', fontSize: 14, fontWeight: '600' }}>
            Inicio rápido
          </Text>
          <Text
            style={{ color: '#6e7681', fontSize: 11, marginTop: 4, lineHeight: 15 }}
          >
            Resalta el botón principal y, al abrir la app, puede iniciar
            la grabación tras una cuenta atrás. Puedes cancelarla antes
            de que empiece.
          </Text>
        </View>
        <View
          style={{
            width: 44,
            height: 26,
            borderRadius: 13,
            backgroundColor: quickStartEnabled ? '#3ddc84' : '#30363d',
            justifyContent: 'center',
            paddingHorizontal: 3,
          }}
        >
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: '#fff',
              alignSelf: quickStartEnabled ? 'flex-end' : 'flex-start',
            }}
          />
        </View>
      </Pressable>

      {/* Battery-optimisation exemption. Android Doze pauses background
          network reads for unwhitelisted apps; that throttles our upload
          worker when the screen is locked for long periods. We do not
          query exemption status (would require a native module) and we
          do not request the dialog programmatically (Play Store policy
          friction). Tapping the button opens the system "Battery
          optimisation" settings page so the user can grant the
          exemption manually. Recording is unaffected if they skip. */}
      <Text
        style={{
          color: '#8b949e',
          fontSize: 12,
          letterSpacing: 1,
          marginTop: 28,
          marginBottom: 8,
        }}
      >
        SUBIDA EN SEGUNDO PLANO
      </Text>
      <Pressable
        onPress={() => {
          openBatteryOptimizationSettings().catch(() => {
            /* helper already swallows; this catch is defensive */
          });
        }}
        style={{
          padding: 14,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 8,
          backgroundColor: '#161b22',
        }}
      >
        <Text style={{ color: '#c9d1d9', fontSize: 14, fontWeight: '600' }}>
          Batería ilimitada
        </Text>
        <Text
          style={{ color: '#6e7681', fontSize: 11, marginTop: 4, lineHeight: 15 }}
        >
          Para que la subida no se pause con la pantalla apagada, Android
          necesita una excepción de batería. Pulsa para abrir los ajustes
          del sistema y permitir Guardian Cloud.
        </Text>
        <Text
          style={{
            color: '#58a6ff',
            fontSize: 12,
            fontWeight: '600',
            marginTop: 10,
          }}
        >
          Abrir ajustes →
        </Text>
      </Pressable>

      {/* Beta-feedback CTA. Promoted from a discreet dark card to a
          solid blue button matching the primary action chrome
          ("Conectar Google Drive") so the survey link reads as a
          first-class call-to-action during the closed beta. Opens an
          external survey via the OS browser — no webview, no auth,
          no analytics, no queue interaction. Removed when beta ends. */}
      <Pressable
        onPress={() => {
          Linking.openURL(BETA_FEEDBACK_URL).catch((err) => {
            // Best-effort external open. Same pattern as the coffee
            // button: a rejection (no browser, malformed URL on custom
            // ROM, etc.) is logged but never throws — the user can
            // simply tap again.
            console.log('BETA FEEDBACK openURL failed', err);
          });
        }}
        style={{
          marginTop: 24,
          backgroundColor: '#1f6feb',
          borderRadius: 6,
          padding: 14,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
          Enviar opinión beta
        </Text>
        <Text
          style={{
            color: 'rgba(255,255,255,0.85)',
            fontSize: 11,
            marginTop: 4,
          }}
        >
          Ayúdanos a mejorar Guardian Cloud
        </Text>
      </Pressable>

      <Pressable
        onPress={() => {
          // Best-effort external open — no auth, no queue, no Drive flow.
          // A rejection (no browser available, malformed URL on a custom
          // ROM, etc.) is silenced so we never trip an unhandled-promise
          // warning; the user can simply tap again.
          Linking.openURL(CREATOR_COFFEE_URL).catch(() => {
            /* ignore */
          });
        }}
        style={{
          marginTop: 24,
          backgroundColor: '#9e7c2a',
          borderRadius: 6,
          padding: 14,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#0d1117', fontSize: 13, fontWeight: '600' }}>
          Invitar al creador a un café ☕
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function DevQueueWipeBlock() {
  const [busy, setBusy] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  async function handleWipe() {
    Alert.alert(
      'Limpiar cola (DEV)',
      'Borra la cola persistida y el puntero de última sesión. ' +
        'NO toca tu sesión de Google ni el Drive conectado. ' +
        '¿Continuar?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
          style: 'destructive',
          onPress: async () => {
            try {
              setBusy(true);
              setResultMsg(null);
              const { removed } = await clearGuardianQueueDev();
              setResultMsg(`OK · borradas ${removed.length} claves`);
            } catch (err) {
              setResultMsg(
                err instanceof Error ? err.message : String(err),
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <View
      style={{
        marginTop: 28,
        paddingTop: 20,
        borderTopWidth: 1,
        borderTopColor: '#30363d',
      }}
    >
      <Text
        style={{
          color: '#8b949e',
          fontSize: 12,
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        DEV
      </Text>
      <Pressable
        onPress={handleWipe}
        disabled={busy}
        style={{
          backgroundColor: '#3d1518',
          borderWidth: 1,
          borderColor: '#f85149',
          borderRadius: 6,
          padding: 14,
          opacity: busy ? 0.6 : 1,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#f85149', fontWeight: '700' }}>
          Limpiar cola (DEV)
        </Text>
      </Pressable>
      {resultMsg && (
        <Text
          style={{ color: '#c9d1d9', fontSize: 12, marginTop: 8 }}
          selectable
        >
          {resultMsg}
        </Text>
      )}
      <Text
        style={{
          color: '#6e7681',
          fontSize: 11,
          marginTop: 8,
          lineHeight: 16,
        }}
      >
        Borra solo las claves de Guardian Cloud en AsyncStorage
        (cola persistida + puntero de última sesión). Auth y Drive intactos.
      </Text>
    </View>
  );
}

function DriveStatusBlock({ drive }: { drive: PublicDestination | null }) {
  if (!drive) {
    return (
      <View>
        <StatusDot color="#f85149" label="No conectado" />
        <Text style={{ color: '#8b949e', fontSize: 12, marginTop: 6 }}>
          Conecta tu Google Drive antes de grabar.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <StatusDot color="#3ddc84" label="Conectado" />
      {drive.account_email && (
        <Text style={{ color: '#c9d1d9', fontSize: 13, marginTop: 6 }}>
          {drive.account_email}
        </Text>
      )}
      <Text style={{ color: '#6e7681', fontSize: 11, marginTop: 4 }}>
        Carpeta: /GuardianCloud
      </Text>
    </View>
  );
}

function StatusDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: color,
          marginRight: 8,
        }}
      />
      <Text style={{ color, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}
