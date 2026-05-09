/**
 * Permissions store (Zustand).
 *
 * Holds runtime-permission flags whose state we want the UI to surface
 * without each consumer re-checking the OS permission API. Currently
 * tracks only POST_NOTIFICATIONS denial (Android 13+) — the one signal
 * that has a silent failure mode (foreground-service notification
 * disappears) and so deserves explicit visibility on home.
 *
 * Battery-optimisation status is NOT tracked here on purpose: querying
 * `PowerManager.isIgnoringBatteryOptimizations` requires native code we
 * deliberately do not add for the beta. The Settings screen exposes a
 * button to open the system page; we treat the user's tap as
 * "configured" without trying to verify.
 *
 * NOT persisted. Notification permission state is asked on every
 * foreground-service start, so re-deriving it after a cold boot is
 * cheaper than storing it.
 */

import { create } from 'zustand';

interface PermissionsState {
  /**
   * True when the most recent POST_NOTIFICATIONS request was denied.
   * Set by `startBackgroundProtection`'s `onPostNotificationsResult`
   * callback. Default `false` — we assume granted until proven
   * otherwise so the home screen does not flash a warning during
   * cold start before the gate has run.
   */
  notificationDenied: boolean;
  setNotificationDenied: (value: boolean) => void;
}

export const usePermissionsStore = create<PermissionsState>((set) => ({
  notificationDenied: false,
  setNotificationDenied: (notificationDenied) => set({ notificationDenied }),
}));
