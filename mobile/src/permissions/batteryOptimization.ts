/**
 * Battery-optimisation settings opener.
 *
 * Android's Doze mode throttles background work — including our
 * upload worker's network reads — for apps that are not whitelisted.
 * The exemption is granted via the system "Battery optimization"
 * settings page, not a per-permission dialog.
 *
 * We do not request the exemption programmatically (would require the
 * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` system dialog, which Google
 * Play flags for review unless your app meets specific criteria).
 * Instead we provide a one-tap path to the settings screen and let
 * the user decide.
 *
 * The intent we open lands on the global "Battery optimization" list
 * with the user's installed apps. If the OEM ROM has stripped that
 * intent (some Chinese ROMs do), we fall back to the per-app settings
 * page. iOS / web are no-ops — this lifecycle issue does not exist
 * there.
 *
 * Never throws. Cannot detect whether the user actually granted the
 * exemption; we trust the tap. If the user reports background uploads
 * stalling, the home-screen pill (post-F3) for failed chunks will
 * surface the symptom regardless.
 */

import { Linking, Platform } from 'react-native';

export async function openBatteryOptimizationSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    return;
  } catch {
    // Intent not handled by this ROM — fall through to the per-app page.
  }
  try {
    await Linking.openSettings();
  } catch {
    // Both paths failed. There is no recovery; the caller should not
    // surface anything to the user — if the system settings page
    // itself cannot be opened, an error toast adds noise without
    // helping.
  }
}
