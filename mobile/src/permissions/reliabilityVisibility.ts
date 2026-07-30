/**
 * Reliability card visibility — pure decision logic.
 *
 * Extracted from the component on purpose. The card's "should I show
 * this?" rules are the part worth testing (they gate a surface that
 * must never appear mid-capture), and the project has no React renderer
 * in its test environment. Keeping the rules here means they are
 * exercised as plain functions, and the component stays a renderer with
 * no business logic in it.
 *
 * Every function in this file is pure: no I/O, no storage, no platform
 * access, no imports beyond a type. It is safe to call during render.
 */

import type { PostNotifStatus } from '@/permissions/notifications';

/**
 * The three live recording flags owned by the home screen. Passed in
 * rather than derived — this module must never re-implement recording
 * state, only read what the screen already tracks.
 */
export type RecordingActivity = {
  isStarting: boolean;
  isRecording: boolean;
  isStopping: boolean;
};

/**
 * Is a capture in flight in any sense?
 *
 * Covers the full critical window, not just the steady "recording"
 * state: `isStarting` (permission prompts, FG-service spin-up, first
 * chunk) and `isStopping` (flush, finalize) are exactly the moments
 * where a permissions card must not steal a tap or shift the layout
 * under the STOP button.
 *
 * The home screen's own `showStop` is deliberately NOT reused here:
 * `showStop` is `isRecording || isStopping`, which leaves `isStarting`
 * uncovered.
 */
export function isRecordingBusy(activity: RecordingActivity): boolean {
  return activity.isStarting || activity.isRecording || activity.isStopping;
}

/** Input for the home surface. */
export type ReliabilityHomeInput = {
  mode: 'home';
  /** True when a Drive destination is connected for this user. */
  driveConnected: boolean;
  /** Aggregate of the three recording flags — see `isRecordingBusy`. */
  recordingBusy: boolean;
  /** User tapped "Ahora no" in a previous session. */
  dismissed: boolean;
  /** Last known POST_NOTIFICATIONS state. */
  notifStatus: PostNotifStatus;
  /** User already opened the battery settings page from this card. */
  batteryGuidanceOpened: boolean;
};

/** Input for the permanent Settings surface. */
export type ReliabilitySettingsInput = {
  mode: 'settings';
  notifStatus: PostNotifStatus;
};

export type ReliabilityCardInput =
  | ReliabilityHomeInput
  | ReliabilitySettingsInput;

export type ReliabilityCardDecision = {
  /** Render the card at all. */
  visible: boolean;
  /** Render the "Activar notificaciones" action. */
  showNotificationsAction: boolean;
  /** Render the "Mejorar segundo plano" action. */
  showBatteryAction: boolean;
  /** Render the "Ahora no" dismiss affordance. */
  showDismiss: boolean;
};

/**
 * Should the notifications action be offered?
 *
 * Hidden when the permission is granted (nothing to ask) or genuinely
 * not applicable (iOS, Android < 13). Shown for `'denied'` AND for
 * `'unknown'` — an unverifiable permission is treated as missing, so
 * the user keeps a way to act. See `notifications.ts`.
 */
export function shouldShowNotificationsAction(
  status: PostNotifStatus,
): boolean {
  return status !== 'granted' && status !== 'not_applicable';
}

/**
 * Resolve the full render decision for the card.
 *
 * Settings is the permanent surface: always visible, both actions
 * always reachable (minus the notifications action when there is
 * nothing to ask), never dismissible. This is what guarantees the
 * battery settings page stays accessible forever, including after the
 * user hid the home recommendation.
 *
 * Home is the contextual surface and yields to the capture flow:
 *   - no Drive destination → nothing actionable yet
 *   - a capture is in flight → never compete with the STOP button
 *   - dismissed → the user said no
 *   - both recommendations already handled → nothing left to say, so
 *     the card would be an empty box; hide it instead
 *
 * `batteryGuidanceOpened` only suppresses the battery action on Home.
 * It records that the user was already sent to the system page — NOT
 * that the exemption was granted, which the app cannot know.
 */
export function decideReliabilityCard(
  input: ReliabilityCardInput,
): ReliabilityCardDecision {
  const showNotificationsAction = shouldShowNotificationsAction(
    input.notifStatus,
  );

  if (input.mode === 'settings') {
    return {
      visible: true,
      showNotificationsAction,
      showBatteryAction: true,
      showDismiss: false,
    };
  }

  const showBatteryAction = !input.batteryGuidanceOpened;
  const hasSomethingToSay = showNotificationsAction || showBatteryAction;

  const visible =
    input.driveConnected &&
    !input.recordingBusy &&
    !input.dismissed &&
    hasSomethingToSay;

  return {
    visible,
    showNotificationsAction,
    showBatteryAction,
    showDismiss: true,
  };
}
