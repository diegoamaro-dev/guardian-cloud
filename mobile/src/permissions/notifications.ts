/**
 * POST_NOTIFICATIONS — contextual ask helper.
 *
 * Separate from `backgroundService.ts:ensureNotificationPermission` ON
 * PURPOSE: that function lives inside the foreground-service critical
 * path and is invoked at FG-service start (boot recovery / startRecording).
 * The contextual reliability card needs to ask for the same Android 13+
 * runtime permission BEFORE the user taps GRABAR, so the system dialog
 * does not appear at first recording with no in-app context.
 *
 * Strict isolation contract:
 *   - never imports from `src/recording/*` or `src/audio/*`
 *   - never touches GC_QUEUE, the upload worker, recovery, export, the
 *     foreground service, AudioEngine, or any module beyond
 *     `react-native/PermissionsAndroid`
 *   - never starts a service, never schedules background work, never
 *     persists anything
 *
 * Why a duplicate (not an export of the existing helper):
 *   - `ensureNotificationPermission` carries OEM-diagnostic side logs
 *     (`GC_OEM_BG_NOTIF_BLOCKED`, etc.) that only make sense when the
 *     ask is paired with an FG-service start. Triggering those logs
 *     from a contextual card would pollute the FG-service telemetry.
 *   - Keeping the FG-service module untouched satisfies the project
 *     rule "minimise changes in modules critical to foreground flow".
 *   - The two helpers can diverge naturally over time without
 *     coupling the contextual ask to the upload-worker lifecycle.
 *
 * Both helpers wrap exactly the same Android API
 * (`PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS`); a change in the
 * Android API would require updates in both places, which is the
 * cheapest maintenance cost we can pay for the isolation.
 */

import { PermissionsAndroid, Platform } from 'react-native';

export type PostNotifStatus =
  | 'granted'
  | 'denied'
  | 'not_applicable'
  | 'unknown';

/**
 * Resolve the Android-13+ POST_NOTIFICATIONS permission constant in a way
 * that survives older react-native bundles (where the key may be missing
 * because the bundle predates Android 13 support).
 *
 * Returns null when the constant is unavailable; callers treat that as
 * "permission infrastructure missing" and short-circuit to a safe value
 * (`true` for the requester, `'unknown'` for the status checker).
 */
function resolvePostNotificationsPerm():
  | Parameters<typeof PermissionsAndroid.check>[0]
  | null {
  type AndroidPermission = Parameters<typeof PermissionsAndroid.check>[0];
  const permsAny = PermissionsAndroid.PERMISSIONS as unknown as Record<
    string,
    AndroidPermission | undefined
  >;
  return permsAny.POST_NOTIFICATIONS ?? null;
}

/**
 * Read-only check of the current POST_NOTIFICATIONS state. Safe to call
 * from any context, including mount-time `useEffect` and `AppState`
 * 'active' handlers — never requests the permission, never mutates
 * anything.
 *
 * Mirrors the surface of `backgroundService.ts:checkPostNotifications`
 * intentionally (same return type) so callers reading both modules see
 * a familiar shape; the implementation is duplicated locally to keep
 * this file fully isolated from the FG-service module.
 */
export async function getPostNotificationsStatus(): Promise<PostNotifStatus> {
  if (Platform.OS !== 'android') return 'not_applicable';
  if (typeof Platform.Version !== 'number' || Platform.Version < 33) {
    return 'not_applicable';
  }
  const perm = resolvePostNotificationsPerm();
  if (!perm) return 'unknown';
  try {
    const granted = await PermissionsAndroid.check(perm);
    return granted ? 'granted' : 'denied';
  } catch {
    return 'unknown';
  }
}

/**
 * Request the POST_NOTIFICATIONS runtime permission. Returns `true`
 * when:
 *   - the permission is already granted, OR
 *   - it does not apply on this platform/version (iOS, Android < 13), OR
 *   - the user grants it through the system dialog this call surfaces.
 *
 * Returns `false` only when the user actively denies via the system
 * dialog, or when an exception is thrown by the platform API.
 *
 * Idempotent: calling twice when already granted skips the dialog.
 * Caller-friendly: never throws, never logs OEM-diagnostic side effects
 * (that telemetry is owned by the FG-service path's
 * `ensureNotificationPermission`, not by this contextual ask).
 */
export async function requestPostNotifications(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (typeof Platform.Version !== 'number' || Platform.Version < 33) {
    return true;
  }
  const perm = resolvePostNotificationsPerm();
  if (!perm) return true;
  try {
    const already = await PermissionsAndroid.check(perm);
    if (already) return true;
    const result = await PermissionsAndroid.request(perm);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}
