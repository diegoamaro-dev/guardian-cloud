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
 * Visibility is NOT decided here. Every rule lives in
 * `@/permissions/reliabilityVisibility` as pure functions, so it can be
 * unit-tested without a React renderer and so this file stays free of
 * business logic. This component reads state, hands it to
 * `decideReliabilityCard`, and renders the answer.
 *
 * The home surface hides itself during the whole capture window
 * (`isStarting || isRecording || isStopping`, aggregated by the caller
 * via `isRecordingBusy`) — it must never compete with the STOP button
 * or shift the layout mid-capture.
 *
 * The battery recommendation disappears from Home once the user has
 * opened the system settings page. That flag records a navigation, not
 * an outcome: we cannot read the exemption state without a native
 * module, so no copy in this file claims the optimisation is disabled
 * or resolved. Settings keeps the action permanently for exactly that
 * reason.
 *
 * No mini state machine. Three `useState` slots, two `useEffect`
 * blocks, three handlers, one conditional render. If a future feature
 * needs more behaviour, it should live in a SEPARATE component, not by
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
  hasOpenedBatteryGuidance,
  isReliabilityCardDismissed,
  markBatteryGuidanceOpened,
  markReliabilityCardDismissed,
} from '@/permissions/reliabilityDismissal';
import { openBatteryOptimizationSettings } from '@/permissions/batteryOptimization';
import { decideReliabilityCard } from '@/permissions/reliabilityVisibility';

export type ReliabilityCardProps =
  | {
      mode: 'home';
      /** True when a Drive destination is connected for this user. */
      driveConnected: boolean;
      /**
       * True while a capture is in flight in ANY phase — starting,
       * recording or stopping. Callers build this with
       * `isRecordingBusy()` from the screen's existing flags; this
       * component never derives recording state itself.
       */
      recordingBusy: boolean;
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
  const [batteryOpened, setBatteryOpened] = useState(false);

  // One-shot initial read: notification status + both persisted flags.
  // Every read is best-effort; on failure the helpers return a safe
  // default ('unknown' / false) so the card may simply appear. No
  // failure mode here affects recording or upload — this effect touches
  // nothing outside the card's own state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [status, isDismissed, batteryGuidanceOpened] = await Promise.all([
        getPostNotificationsStatus(),
        isReliabilityCardDismissed(),
        hasOpenedBatteryGuidance(),
      ]);
      if (cancelled) return;
      setNotifStatus(status);
      setDismissed(isDismissed);
      setBatteryOpened(batteryGuidanceOpened);
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

  // Every visibility rule lives in the pure module — see its docblock.
  const decision = decideReliabilityCard(
    props.mode === 'home'
      ? {
          mode: 'home',
          driveConnected: props.driveConnected,
          recordingBusy: props.recordingBusy,
          dismissed,
          notifStatus,
          batteryGuidanceOpened: batteryOpened,
        }
      : { mode: 'settings', notifStatus },
  );

  if (!decision.visible) return null;

  async function handleNotifications(): Promise<void> {
    await requestPostNotifications();
    // Re-read instead of trusting the request's boolean: `false` covers
    // both "user denied" and "not verifiable on this build", and the
    // status checker is the single source of truth for which one it
    // was. Recording is never gated on either outcome.
    const status = await getPostNotificationsStatus();
    setNotifStatus(status);
  }

  async function handleBattery(): Promise<void> {
    // Voluntary action only. Triggered exclusively from this onPress.
    // The opener never throws and never reports success — best-effort
    // by contract — so the .catch is purely defensive.
    await openBatteryOptimizationSettings().catch(() => {
      /* best-effort — see helper docblock */
    });
    // Record that we sent the user to the system page so Home stops
    // repeating the recommendation. This is a navigation receipt, NOT a
    // claim that the exemption was granted — the app cannot know that.
    // Storage failures are swallowed inside the helper and never reach
    // the UI or the capture path.
    await markBatteryGuidanceOpened();
    setBatteryOpened(true);
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

      {decision.showNotificationsAction ? (
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

      {decision.showBatteryAction ? (
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
            onPress={() => {
              void handleBattery();
            }}
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
      ) : null}

      <Text
        style={{
          color: '#6e7681',
          fontSize: 11,
          lineHeight: 15,
          marginTop: 4,
          marginBottom: decision.showDismiss ? 12 : 0,
        }}
      >
        Guardian Cloud solo graba cuando tú pulsas grabar.
      </Text>

      {decision.showDismiss ? (
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
