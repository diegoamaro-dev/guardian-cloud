/**
 * User-facing translation of the worker's `last_error` shape.
 *
 * The queue persists `{ status, code?, message }` so the operator can
 * read logs and reproduce failures. Testers should NEVER see those
 * fields: codes leak internal vocabulary, statuses leak HTTP, and the
 * `message` field is the raw backend text (often English).
 *
 * This module owns the mapping. Three rules for every entry:
 *   1. No codes, no statuses, no stack traces in the copy.
 *   2. Each entry answers, in plain Spanish: what happened, whether
 *      the rest of the evidence is safe, and what (if anything) the
 *      user can do.
 *   3. `recoverable` is `true` only when flipping the failed chunks
 *      back to `pending` and re-running the worker can actually
 *      succeed in a different way. For permanent corruptions
 *      (bad hash, oversize) or for terminal session states it is
 *      `false` — the home screen hides the "Reintentar" button so
 *      the user does not tap a placebo.
 *
 * The list of codes covered here is derived from the backend AppError
 * call sites that produce 4xx (everything else classifies as transient
 * in `classifyError` and never reaches `status: 'failed'` in the
 * queue). New permanent codes added on the backend should be added
 * here too — until then they fall through to the generic message.
 */

export interface FailureView {
  /** Main line under the red pill. Plain Spanish, no jargon. */
  message: string;
  /** One-line answer to "what's safe / what should I do". */
  evidence: string;
  /**
   * When true the home screen shows a "Reintentar" button that
   * flips failed chunks back to pending. False for codes where the
   * retry would fail the same way every time.
   */
  recoverable: boolean;
}

export function humanizeFailure(err: {
  status: number;
  code?: string;
  message: string;
}): FailureView {
  switch (err.code) {
    case 'HASH_MISMATCH':
      return {
        message: 'Un fragmento se dañó al subir.',
        evidence: 'El resto de la grabación está bien.',
        recoverable: false,
      };
    case 'BODY_TOO_LARGE':
      return {
        message: 'Un fragmento es demasiado grande para enviarse.',
        evidence: 'Los demás fragmentos siguen subiendo.',
        recoverable: false,
      };
    case 'SESSION_NOT_ACTIVE':
      return {
        message: 'La sesión se cerró antes de terminar.',
        evidence: 'Lo que ya se subió está protegido.',
        recoverable: false,
      };
    case 'INVALID_HEADERS':
      return {
        message: 'Un fragmento llegó incompleto.',
        evidence: 'Lo demás se sigue subiendo.',
        recoverable: false,
      };
    case 'NAS_NOT_CONFIGURED':
      return {
        message: 'Tu NAS está desconectado.',
        evidence: 'Reconéctalo en Configuración para que reciba las nuevas grabaciones.',
        recoverable: true,
      };
    case 'NAS_AUTH_FAILED':
      return {
        message: 'El NAS rechazó las credenciales.',
        evidence: 'Comprueba usuario y contraseña en Configuración.',
        recoverable: true,
      };
    default:
      return {
        message: 'No se pudo enviar un fragmento.',
        evidence: 'Lo demás se sigue intentando.',
        recoverable: true,
      };
  }
}
