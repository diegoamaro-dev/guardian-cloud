/**
 * Destination preference helper.
 *
 * Persists the user's explicit choice of upload destination
 * ('drive' | 'nas' | null) in AsyncStorage. Only consumed when BOTH
 * Drive and NAS are connected — otherwise the resolver in
 * `refreshDestination` falls back to the only available connected
 * destination automatically (Drive first, NAS second).
 *
 * Why a dedicated tiny module instead of inlining in index.tsx:
 *   - Settings needs to set the preference; the home screen needs to
 *     read it. A shared helper keeps the AsyncStorage key in one place.
 *   - The module deliberately exposes only get/set — no resolver, no
 *     React state. The resolver lives in `refreshDestination` so the
 *     existing single source of truth (`activeDestinationType` at
 *     module scope of index.tsx) stays the only routing decision.
 *
 * Storage rules:
 *   - Key: `guardian.preferred_destination`
 *   - Value: literal `"drive"` | `"nas"` | (key absent → null)
 *   - Errors during read/write are swallowed and surface as `null`,
 *     because routing must NEVER throw on the upload path.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DestinationType } from '@/api/destinations';

const PREFERENCE_KEY = 'guardian.preferred_destination';

export async function getPreferredDestinationType(): Promise<DestinationType | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFERENCE_KEY);
    if (raw === 'drive' || raw === 'nas') return raw;
    return null;
  } catch {
    return null;
  }
}

export async function setPreferredDestinationType(
  type: DestinationType | null,
): Promise<void> {
  try {
    if (type === null) {
      await AsyncStorage.removeItem(PREFERENCE_KEY);
    } else {
      await AsyncStorage.setItem(PREFERENCE_KEY, type);
    }
  } catch {
    // Best-effort persistence. The next refreshDestination tick will
    // simply fall back to the auto-resolver if the value never landed.
  }
  // Notify in-process listeners (Home's `refreshDestination`) so the
  // active routing target reflects the user's choice without waiting
  // for a remount or cold boot. Fires AFTER the persistence attempt so
  // subscribers can re-read the canonical value from AsyncStorage if
  // they want — but the argument is the intent, so a transient
  // AsyncStorage failure still surfaces visually until the next
  // launch (matches the existing best-effort policy).
  notifyPreferenceChange(type);
}

/**
 * In-process pub/sub for preference changes.
 *
 * Closes the Settings → Home propagation hole: Settings writes
 * AsyncStorage and Home stays unaware until cold boot otherwise.
 * Listeners fire synchronously after the persistence attempt; Home
 * subscribes once at mount and calls its `refreshDestination` on
 * every notification, which re-reads AsyncStorage + the backend's
 * connected destinations and updates the module-level
 * `activeDestinationType` used to pin FUTURE sessions.
 *
 * Strict isolation:
 *   - in-memory only (no persistence, no cross-process delivery)
 *   - listener errors are swallowed — the upload path MUST NEVER
 *     break because of a UI subscriber, and the preference write
 *     itself has already succeeded by the time we notify
 *   - never touches GC_QUEUE, the worker, recovery, or any active
 *     session's pinned `destination_type`. The home resolver only
 *     updates the module-level `activeDestinationType` used for
 *     FUTURE recordings; in-flight sessions keep their pinning.
 */
type PreferenceListener = (next: DestinationType | null) => void;
const listeners = new Set<PreferenceListener>();

export function subscribePreferredDestinationChange(
  fn: PreferenceListener,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notifyPreferenceChange(next: DestinationType | null): void {
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      // Listener threw — never propagate. The preference itself is
      // already persisted; a failed listener just means one observer
      // missed this tick and will catch up on its next normal refresh
      // (foreground transition / next cold boot).
    }
  }
}
