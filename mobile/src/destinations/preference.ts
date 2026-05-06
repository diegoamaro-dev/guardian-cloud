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
      return;
    }
    await AsyncStorage.setItem(PREFERENCE_KEY, type);
  } catch {
    // Best-effort persistence. The next refreshDestination tick will
    // simply fall back to the auto-resolver if the value never landed.
  }
}
