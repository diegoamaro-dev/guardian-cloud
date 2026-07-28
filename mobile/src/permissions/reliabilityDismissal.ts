/**
 * ReliabilityCard dismissal flag.
 *
 * Single AsyncStorage key tracks whether the user has tapped "Ahora no"
 * on the contextual reliability card. When set, the card hides on the
 * home screen permanently (until the app is reinstalled or storage is
 * wiped). The Settings screen ignores this flag — the card lives there
 * as a permanent "Fiabilidad" section regardless of past dismissal.
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
