/**
 * Phase 1A — failure policy for the upload worker.
 *
 * Why this module exists:
 *   The worker's historical decision point (`classifyError` in
 *   `app/index.tsx`) answers a binary question: "transient or
 *   permanent?". Both answers are wrong for the incident we are
 *   containing:
 *     - 'transient' for `401 NO_TOKEN` produced an identical request
 *       every ~30s forever, once per queue entry — the retry storm.
 *     - 'permanent' for `413` / `409` marked the chunk failed AND
 *       pruned its bytes, destroying evidence that was never confirmed
 *       off-device.
 *
 *   This module replaces that decision with a CLOSED ALLOW-LIST: a
 *   failure may be retried only if the code can positively recognise it
 *   as a transport-level fault. Everything else pauses and preserves.
 *
 * Strict isolation contract:
 *   - Pure. No I/O, no AsyncStorage, no network, no timers, no logging.
 *   - Imports nothing from `app/` and nothing from `@/api/*`. Errors are
 *     read STRUCTURALLY (duck-typed `status` / `code`) rather than with
 *     `instanceof ApiError`, so the policy cannot be defeated by an
 *     error crossing a module boundary, and so its unit tests need no
 *     mocks at all.
 *   - Decides nothing about WHERE state is stored. The caller persists.
 *
 * Deliberately absent: a 'terminal' decision. Under the phase-1A rule
 * (`LOCAL_BYTES_OR_REFERENCES_MAY_BE_REMOVED_ONLY_AFTER_REMOTE_UPLOAD_IS_
 * POSITIVELY_CONFIRMED`) no upload failure may ever make a chunk
 * terminal-with-prune. A chunk either uploads or waits.
 */

export type PauseReason =
  | 'CLIENT_SESSION_EXPIRED'
  | 'AUTH_RECONNECT_REQUIRED'
  | 'SYSTEMIC_CONFIG_PAUSE'
  | 'SESSION_STATE_PAUSE'
  | 'UNCLASSIFIED_PAUSE';

/**
 * GLOBAL      — no network for any entry, any destination.
 * DESTINATION — no network for entries bound to that destination.
 * ENTRY       — no network for that one session entry.
 */
export type PauseScope = 'GLOBAL' | 'DESTINATION' | 'ENTRY';

export type FailureDecision =
  | {
      kind: 'retry';
      /** Which allow-list rule matched. Diagnostics only. */
      signal: string;
    }
  | {
      kind: 'pause';
      reason: PauseReason;
      scope: PauseScope;
      /** Best-effort short code for the operator. Never a secret. */
      code: string;
    };

/**
 * The ONLY synthetic error message the worker itself raises for a
 * hung upload (see the stuck-sentinel in `uploadDrainLoop`). Matching
 * it exactly — rather than treating any unrecognised `Error` as a
 * network fault — is what keeps a programming exception (TypeError,
 * ReferenceError, a thrown string) out of the retry path.
 */
const TIMEOUT_SIGNAL = 'CHUNK_UPLOAD_TIMEOUT';

function readStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status)
    ? status
    : null;
}

function readCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * Decide what the worker does with a failed chunk upload.
 *
 * Recognised-retryable set (the closed allow-list). Everything here is
 * a transport fault where repeating the SAME request can legitimately
 * succeed later without any user action:
 *
 *   - `NETWORK_ERROR`      — the API client's own offline/transport code
 *   - `CHUNK_UPLOAD_TIMEOUT` — our own stuck-upload sentinel
 *   - HTTP 408 / 429       — request timeout / rate limit
 *   - HTTP 5xx             — server-side fault
 *   - `SESSION_NOT_FOUND`  — offline-first: the session exists locally
 *                            but its `POST /sessions` has not been
 *                            replayed yet. The re-registration loop in
 *                            `app/index.tsx` makes this genuinely
 *                            self-healing, which is why it stays
 *                            retryable (verified: the bootstrap loop
 *                            exists and `classifyError.test.ts` already
 *                            pins this behaviour).
 *
 * Everything else pauses. Notably:
 *   - `status: 0` alone is NOT enough to retry. Only `status: 0` WITH
 *     `code: 'NETWORK_ERROR'` is recognised. A zero status with no code
 *     is an unknown failure, not an assumed network blip.
 *   - A thrown value with no numeric `status` and no recognised message
 *     (TypeError, ReferenceError, a bare string) is a programming
 *     exception. Retrying it is a hot loop with no possible recovery.
 */
export function classifyFailure(err: unknown): FailureDecision {
  const code = readCode(err);

  // --- code-keyed rules first -----------------------------------------
  // These are checked before any status rule so that a coded error is
  // never swallowed by a broader status bucket (e.g. NO_TOKEN arrives
  // as 401, DRIVE_NOT_CONNECTED as 409).
  switch (code) {
    case 'NO_TOKEN':
      return {
        kind: 'pause',
        reason: 'CLIENT_SESSION_EXPIRED',
        scope: 'GLOBAL',
        code: 'NO_TOKEN',
      };
    case 'DRIVE_REFRESH_FAILED':
    case 'DRIVE_NOT_CONNECTED':
      return {
        kind: 'pause',
        reason: 'AUTH_RECONNECT_REQUIRED',
        scope: 'DESTINATION',
        code,
      };
    case 'BODY_TOO_LARGE':
      return {
        kind: 'pause',
        reason: 'SYSTEMIC_CONFIG_PAUSE',
        scope: 'GLOBAL',
        code,
      };
    case 'SESSION_NOT_ACTIVE':
      return {
        kind: 'pause',
        reason: 'SESSION_STATE_PAUSE',
        scope: 'ENTRY',
        code,
      };
    case 'SESSION_NOT_FOUND':
      return { kind: 'retry', signal: 'SESSION_NOT_FOUND' };
    case 'NETWORK_ERROR':
      return { kind: 'retry', signal: 'NETWORK_ERROR' };
    default:
      break;
  }

  // --- our own stuck-upload sentinel ----------------------------------
  if (err instanceof Error && err.message === TIMEOUT_SIGNAL) {
    return { kind: 'retry', signal: TIMEOUT_SIGNAL };
  }

  // --- status-keyed rules ---------------------------------------------
  // `status` is read structurally from ApiError-shaped throws; for the
  // raw-fetch paths that throw a plain Error we parse the `HTTP NNN`
  // token the message carries. An unparseable message yields null and
  // falls through to the default pause.
  let status = readStatus(err);
  if (status === null && err instanceof Error) {
    const m = err.message.match(/HTTP (\d{3})/);
    if (m?.[1]) status = Number(m[1]);
  }

  if (status !== null) {
    if (status === 413) {
      return {
        kind: 'pause',
        reason: 'SYSTEMIC_CONFIG_PAUSE',
        scope: 'GLOBAL',
        code: 'BODY_TOO_LARGE',
      };
    }
    if (status === 408 || status === 429) {
      return { kind: 'retry', signal: `HTTP_${status}` };
    }
    if (status >= 500 && status < 600) {
      return { kind: 'retry', signal: `HTTP_${status}` };
    }
    if (status === 401) {
      // A 401 with no recognised code is still unambiguously an
      // authentication failure — the request cannot succeed until the
      // user's session is valid again. We pause GLOBALLY rather than
      // per-entry: an entry-scoped pause would let every other entry
      // keep issuing the same doomed 401, which is the storm we are
      // removing. Conservative by design.
      return {
        kind: 'pause',
        reason: 'CLIENT_SESSION_EXPIRED',
        scope: 'GLOBAL',
        code: 'HTTP_401',
      };
    }
    // Every other status — 4xx (403, 404, 409, 422, HASH_MISMATCH, ...)
    // and anything exotic — is unrepairable by repetition. Pause the
    // entry, keep the bytes.
    return {
      kind: 'pause',
      reason: 'UNCLASSIFIED_PAUSE',
      scope: 'ENTRY',
      code: code ?? `HTTP_${status}`,
    };
  }

  // --- default ---------------------------------------------------------
  // No status, no recognised code, no recognised message. This is the
  // branch that used to say "probably a network error, retry forever".
  // It now pauses and preserves.
  return {
    kind: 'pause',
    reason: 'UNCLASSIFIED_PAUSE',
    scope: 'ENTRY',
    code: code ?? 'UNKNOWN',
  };
}
