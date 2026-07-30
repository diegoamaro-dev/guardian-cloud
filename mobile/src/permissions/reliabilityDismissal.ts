/**
 * ReliabilityCard persistence — two INDEPENDENT flags.
 *
 * 1. Dismissal ("Ahora no"): hides the whole card on the home screen.
 * 2. Battery-guidance opened: hides ONLY the battery recommendation on
 *    the home screen, after the user has opened the system settings
 *    page at least once.
 *
 * They are deliberately separate keys. Reusing the dismissal flag for
 * the battery recommendation would make one user action suppress an
 * unrelated one — tapping "Mejorar segundo plano" would silently bury
 * the notifications ask, and vice versa.
 *
 * The Settings screen ignores BOTH flags — the card lives there as a
 * permanent "Fiabilidad" section regardless of past dismissal, so the
 * battery settings page always stays reachable.
 *
 * Strict isolation contract:
 *   - never imports from `src/recording/*`, `src/audio/*`,
 *     `src/destinations/*`, or any module that owns recording / upload
 *     state
 *   - never touches `GC_QUEUE` (key prefix `gc.reliability.*` is
 *     deliberately distinct from the queue's `test.pending_retry`)
 *   - never mutates anything outside the single key declared below
 *
 * Failure behaviour: every read/write is wrapped in try/catch. A storage
 * failure on read returns `false` (card may appear); a storage failure
 * on write is swallowed (user may need to tap "Ahora no" again on a
 * subsequent session). Neither failure mode affects recording or upload.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Storage key for the dismissal timestamp. The literal value is
 * intentionally distinct from any GC_QUEUE / session / chunk key so a
 * future migration that walks the queue cannot accidentally clobber
 * this flag.
 */
const RELIABILITY_DISMISSED_KEY = 'gc.reliability.dismissed_at';

/**
 * Storage key recording that the user opened the battery-optimisation
 * settings page from the home card at least once.
 *
 * This records an IN-APP NAVIGATION EVENT, nothing more. It does NOT
 * mean the exemption was granted — Android exposes no way to read that
 * without a native module, and we add none. Copy that consumes this
 * flag must never claim the optimisation is disabled or resolved; the
 * flag only answers "have we already pointed this user at the setting?"
 * so Home stops repeating a recommendation they already acted on.
 */
const RELIABILITY_BATTERY_GUIDANCE_KEY =
  'gc.reliability.battery_guidance_opened_at';

/**
 * Has the user dismissed the contextual reliability card?
 *
 * Reads the AsyncStorage flag once. A non-null, non-empty value (any
 * value — we store a timestamp but the existence of the key is the
 * actual signal) means dismissed.
 *
 * Returns `false` on read failure: the card may then appear; the user
 * can dismiss again. This is the safer side of the read — losing the
 * flag once is a minor UX papercut compared to permanently hiding the
 * card after a transient storage hiccup.
 */
export async function isReliabilityCardDismissed(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(RELIABILITY_DISMISSED_KEY);
    return value !== null && value.length > 0;
  } catch {
    return false;
  }
}

/**
 * Mark the card as dismissed. Stores the current wall-clock timestamp
 * (milliseconds since epoch) as the value. The exact value is not
 * consumed by any reader today — only its presence — but a future
 * "show the card again after N days" rule could read it without a
 * schema change.
 *
 * Best-effort: write failures are swallowed.
 */
export async function markReliabilityCardDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(
      RELIABILITY_DISMISSED_KEY,
      String(Date.now()),
    );
  } catch {
    // Best-effort — see the function doc.
  }
}

/**
 * Has the user already opened the battery-optimisation settings page
 * from the home card?
 *
 * Returns `false` on read failure, matching
 * `isReliabilityCardDismissed`: the recommendation may reappear, which
 * is a papercut, versus permanently hiding useful guidance after a
 * transient storage hiccup.
 *
 * Never indicates whether the exemption itself was granted — see the
 * key's docblock.
 */
export async function hasOpenedBatteryGuidance(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(RELIABILITY_BATTERY_GUIDANCE_KEY);
    return value !== null && value.length > 0;
  } catch {
    return false;
  }
}

/**
 * Record that the user opened the battery-optimisation settings page.
 * Stores the wall-clock timestamp; as with the dismissal flag, only the
 * key's presence is read today.
 *
 * Best-effort: write failures are swallowed. A lost write only means
 * the home recommendation shows again on the next launch. Recording,
 * chunking, the queue and the upload worker never read this key and are
 * unaffected either way.
 */
export async function markBatteryGuidanceOpened(): Promise<void> {
  try {
    await AsyncStorage.setItem(
      RELIABILITY_BATTERY_GUIDANCE_KEY,
      String(Date.now()),
    );
  } catch {
    // Best-effort — see the function doc.
  }
}
