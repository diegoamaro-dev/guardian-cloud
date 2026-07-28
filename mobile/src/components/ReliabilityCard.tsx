/**
 * Reliability card — contextual ask for the two secondary Android
 * permissions that improve background protection without being
 * required for recording.
 *
 * Asks for, in this order:
 *   1. POST_NOTIFICATIONS (Android 13+ runtime permission) so the
 *      foreground-service notification "Guardian Cloud está
 *      protegiendo tu evidencia" is actually visible when the user
 *      backgrounds the app.
 *   2. Battery-optimisation exemption (system Settings page) so the
 *      upload worker is not throttled by Doze.
 *
 * Strict isolation contract:
 *   - never imports from `src/recording/*` or `src/audio/*`
 *   - never touches GC_QUEUE, the upload worker, recovery, chunking,
 *     export, the foreground service, AudioEngine, OAuth, or any
 *     module beyond the two new helpers in `src/permissions/*` and
 *     the existing `openBatteryOptimizationSettings` opener
 *   - never opens the battery-settings page automatically: the only
 *     trigger is the user tapping the "Mejorar segundo plano" button
 *   - never blocks recording: the card is a CTA, not a gate. A user
 *     who taps "Ahora no" can record normally; the foreground service
 *     start path still requests POST_NOTIFICATIONS when needed (via
 *     the FG-service module — untouched by this card)
 *
 * Visibility model (intentionally tiny):
 *   - `mode='home'` visible iff `driveConnected && !isRecording &&
 *     !dismissed`. Three booleans, ANDed together. Once `dismissed`
 *     flips true via "Ahora no", the home card is gone until the app
 *     is reinstalled.
 *   - `mode='settings'` always visible. No dismissed gate. No
 *     driveConnected gate. The Settings card is the Fiabilidad
 *     section and never goes away.
 *
 * Button visibility:
 *   - "Activar notificaciones": hidden iff status is `'granted'` or
 *     `'not_applicable'`. Shown otherwise (`'denied'`, `'unknown'`).
 *   - "Mejorar segundo plano": always shown. We cannot detect the
 *     current battery-exemption state without a native module, and
 *     retapping the button is harmless (just re-opens Settings).
 *   - "Ahora no": shown only in `mode='home'`. Hidden in Settings
 *     where the card is permanent.
 *
 * No mini state machine. Two `useState` slots, two `useEffect` blocks,
 * three handlers, one conditional render. If a future feature needs
 * more behaviour, it should live in a SEPARATE component, not by
 * extending this one.
 */

import { useEffect, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Pressable,
  Text,
  View,
} from 'react-native';

import {
  getPostNotificationsStatus,
  requestPostNotifications,
  type PostNotifStatus,
} from '@/permissions/notifications';
import {
  isReliabilityCardDismissed,
  markReliabilityCardDismissed,
} from '@/permissions/reliabilityDismissal';
import { openBatteryOptimizationSettings } from '@/permissions/batteryOptimization';

export type ReliabilityCardProps =
  | {
      mode: 'home';
      /** True when a Drive destination is connected for this user. */
      driveConnected: boolean;
      /** True when a recording session is currently active. */
      isRecording: boolean;
    }
  | { mode: 'settings' };

/**
 * Contextual reliability card. Renders the card markup or `null`.
 * Never throws. Never blocks the parent's render tree.
 *
 * Return type is inferred — the project does not use a single explicit
 * convention (`JSX.Element` vs `React.ReactNode`) and inference is
 * sufficient here.
 */
export function ReliabilityCard(props: ReliabilityCardProps) {
  const [notifStatus, setNotifStatus] = useState<PostNotifStatus>('unknown');
  const [dismissed, setDismissed] = useState(false);

  // One-shot initial read: notification status + dismissed flag. Both
  // reads are best-effort; if either fails the helper returns a safe
  // default ('unknown' / false) so the card may simply appear. Neither
  // failure mode affects recording or upload.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [status, isDismissed] = await Promise.all([
        getPostNotificationsStatus(),
        isReliabilityCardDismissed(),
      ]);
      if (cancelled) return;
      setNotifStatus(status);
      setDismissed(isDismissed);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-check the notification status whenever the app returns to the
  // foreground. Covers the case where the user grants the permission
  // from the system Settings screen instead of via our button — when
  // they come back to Guardian Cloud the card should reflect the new
  // state and hide the "Activar notificaciones" button.
  //
  // We do NOT re-read `dismissed` here: dismissal is an in-app user
  // decision and the OS cannot change it; reading it again would just
  // be wasted I/O. We also do NOT open battery settings here — that
  // would violate the rule that battery settings only opens on an
  // explicit user tap.
  useEffect(() => {
    const sub = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next !== 'active') return;
        void (async () => {
          const status = await getPostNotificationsStatus();
          setNotifStatus(status);
        })();
      },
    );
    return () => sub.remove();
  }, []);

  // Visibility — home mode only. Settings mode renders unconditionally.
  if (props.mode === 'home') {
    if (!props.driveConnected) return null;
    if (props.isRecording) return null;
    if (dismissed) return null;
  }

  const showNotificationsButton =
    notifStatus !== 'granted' && notifStatus !== 'not_applicable';

  async function handleNotifications(): Promise<void> {
    const granted = await requestPostNotifications();
    setNotifStatus(granted ? 'granted' : 'denied');
  }

  function handleBattery(): void {
    // Voluntary action only. Triggered exclusively from this onPress.
    // The helper itself never throws; the .catch is defensive.
    openBatteryOptimizationSettings().catch(() => {
      /* best-effort — see helper docblock */
    });
  }

  async function handleDismiss(): Promise<void> {
    await markReliabilityCardDismissed();
    setDismissed(true);
  }

  return (
    <View
      style={{
        padding: 16,
        borderWidth: 1,
        borderColor: '#30363d',
        borderRadius: 8,
        backgroundColor: '#161b22',
        marginTop: 12,
        marginBottom: 4,
      }}
    >
      <Text
        style={{
          color: '#c9d1d9',
          fontSize: 15,
          fontWeight: '700',
          marginBottom: 8,
        }}
      >
        Mejorar protección en segundo plano
      </Text>
      <Text
        style={{
          color: '#8b949e',
          fontSize: 13,
          lineHeight: 18,
          marginBottom: 14,
        }}
      >
        Para proteger tu evidencia aunque salgas de la app, Guardian Cloud
        puede necesitar dos ajustes adicionales.
      </Text>

      {showNotificationsButton ? (
        <View style={{ marginBottom: 12 }}>
          <Text
            style={{
              color: '#8b949e',
              fontSize: 12,
              lineHeight: 16,
              marginBottom: 8,
            }}
          >
            Permite mostrar que Guardian Cloud sigue protegiendo tu evidencia
            si sales de la app.
          </Text>
          <Pressable
            onPress={() => {
              void handleNotifications();
            }}
            style={{
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderRadius: 6,
              backgroundColor: '#238636',
              alignItems: 'center',
            }}
          >
            <Text
              style={{ color: '#ffffff', fontSize: 14, fontWeight: '600' }}
            >
              Activar notificaciones
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View style={{ marginBottom: 12 }}>
        <Text
          style={{
            color: '#8b949e',
            fontSize: 12,
            lineHeight: 16,
            marginBottom: 8,
          }}
        >
          Algunos móviles cierran apps para ahorrar batería. Este ajuste
          ayuda a que la subida no se corte.
        </Text>
        <Pressable
          onPress={handleBattery}
          style={{
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 6,
            backgroundColor: '#1f6feb',
            alignItems: 'center',
          }}
        >
          <Text
            style={{ color: '#ffffff', fontSize: 14, fontWeight: '600' }}
          >
            Mejorar segundo plano
          </Text>
        </Pressable>
      </View>

      <Text
        style={{
          color: '#6e7681',
          fontSize: 11,
          lineHeight: 15,
          marginTop: 4,
          marginBottom: props.mode === 'home' ? 12 : 0,
        }}
      >
        Guardian Cloud solo graba cuando tú pulsas grabar.
      </Text>

      {props.mode === 'home' ? (
        <Pressable
          onPress={() => {
            void handleDismiss();
          }}
          style={{
            paddingVertical: 8,
            paddingHorizontal: 14,
            alignItems: 'center',
          }}
        >
          <Text
            style={{ color: '#8b949e', fontSize: 13, fontWeight: '500' }}
          >
            Ahora no
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
