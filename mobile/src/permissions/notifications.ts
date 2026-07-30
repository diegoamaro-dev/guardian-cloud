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
 * Returns null when the constant is unavailable. On Android 13+ that is a
 * NOT-VERIFIABLE state, never a grant: both callers short-circuit to the
 * pessimistic value (`'unknown'` for the status checker, `false` for the
 * requester). Claiming "granted" here would silently hide the contextual
 * ask on exactly the devices where the permission is required.
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
  // An Android build whose version we cannot read is NOT provably
  // pre-13, so it cannot be dismissed as 'not_applicable' — that would
  // be an implicit grant. Report it as unverifiable instead.
  if (typeof Platform.Version !== 'number') return 'unknown';
  if (Platform.Version < 33) return 'not_applicable';
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
 * ONLY when the permission is effectively in place:
 *   - it does not apply on this platform/version (iOS, Android < 13), OR
 *   - it is already granted, OR
 *   - the user grants it through the system dialog this call surfaces.
 *
 * Returns `false` in every other case — the user denies via the system
 * dialog, the platform API throws, the Android version cannot be read,
 * or the POST_NOTIFICATIONS constant is missing from the bundle on an
 * Android 13+ device. The last two are "not verifiable", and an
 * unverifiable permission is reported as NOT granted, never as granted:
 * a false positive would hide the contextual ask on precisely the
 * devices that need it, and the user would lose the foreground-service
 * notification with no way to notice.
 *
 * `false` is an informational result, not an error: recording and
 * upload never consult it. The only consumer is the reliability card,
 * which uses it to decide whether to keep showing its button.
 *
 * Idempotent: calling twice when already granted skips the dialog.
 * Caller-friendly: never throws, never logs OEM-diagnostic side effects
 * (that telemetry is owned by the FG-service path's
 * `ensureNotificationPermission`, not by this contextual ask).
 */
export async function requestPostNotifications(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  // Unreadable Android version — see `getPostNotificationsStatus`.
  if (typeof Platform.Version !== 'number') return false;
  if (Platform.Version < 33) return true;
  const perm = resolvePostNotificationsPerm();
  if (!perm) return false;
  try {
    const already = await PermissionsAndroid.check(perm);
    if (already) return true;
    const result = await PermissionsAndroid.request(perm);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}
