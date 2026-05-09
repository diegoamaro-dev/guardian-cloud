/**
 * Single-claim guard for the Drive OAuth exchange code.
 *
 * Why this exists:
 *   The deep link `guardiancloud://oauth/drive?code=...&state=...` is
 *   received by TWO handlers in the same JS runtime when the app is
 *   already in the foreground:
 *     1. The dedicated route screen `app/oauth/drive.tsx` mounts
 *        because Expo Router matches the URL.
 *     2. The Settings screen (if mounted) fires its own
 *        `Linking.addEventListener('url', ...)` handler.
 *   Both used to call `exchangeDriveCode(code)` independently. Google
 *   OAuth codes are single-use, so the second POST returned
 *   `invalid_grant` and the user briefly saw an error before a fallback
 *   path (`getConnectedDrive`) recovered the UI. The duplicate HTTP
 *   request was real; its only mitigation was log noise.
 *
 * Strategy:
 *   Module-scope `Set<string>` — survives screen unmounts within the
 *   same JS process, which is exactly the scope we need to coordinate
 *   between two unrelated screens. JavaScript is single-threaded and
 *   `Set.has` + `Set.add` together complete in one synchronous step
 *   between awaits, so two concurrent callers see a deterministic
 *   winner regardless of arrival order.
 *
 * Strict isolation contract:
 *   - In-memory only. No persistence, no network, no AsyncStorage.
 *   - Never logged. The OAuth code is short-lived but still credential-
 *     adjacent — we only ever record presence (boolean), not value.
 *   - No reset between screen mounts. A second deep-link delivery of
 *     the same code (e.g. a user clicking the auth link twice) is
 *     correctly suppressed even after the original screens are gone.
 *   - Bounded growth: codes are short-lived; the Set in practice holds
 *     at most a handful per session. We do not implement explicit
 *     eviction — the next process restart is sufficient cleanup for
 *     the OAuth use case.
 *
 * NOT used by:
 *   - GC_QUEUE / upload worker / chunking / recovery — this module is
 *     purely an OAuth coordination primitive and has no awareness of
 *     evidence-flow state.
 */

const seenCodes = new Set<string>();

/**
 * Returns `true` the first time `code` is offered, `false` on every
 * subsequent offer.
 *
 * Callers MUST treat `false` as "another handler already owns this
 * exchange — do NOT call `exchangeDriveCode`." The losing handler
 * should fall back to verifying connection state (e.g. via
 * `getConnectedDrive` / `refreshState`) instead of starting a duplicate
 * POST.
 *
 * Synchronous on purpose: the has/add pair must complete in one tick
 * to be race-safe across the dedicated-screen mount and the Settings
 * listener firing on the same URL event.
 */
export function claimDriveOAuthCode(code: string): boolean {
  if (!code) return false;
  if (seenCodes.has(code)) return false;
  seenCodes.add(code);
  return true;
}

/**
 * Test-only seam: clear the in-memory Set so each test sees a fresh
 * coordination surface. Intentionally NOT used by production code.
 */
export function _resetDriveOAuthCodesForTests(): void {
  seenCodes.clear();
}
