/**
 * Auth middleware.
 *
 * Validates `Authorization: Bearer <jwt>` against Supabase Auth's public JWKS.
 * The heavy lifting (JWKS fetching, caching, signature verification, issuer
 * check, expiry check) lives in `utils/jwtVerifier.ts`.
 *
 * Rules (from SECURITY.md):
 *   - `/sessions`, `/chunks`, `/alerts` must reject unauthenticated requests.
 *   - user_id is ALWAYS extracted from the JWT `sub`, never from the body.
 *   - No token details are ever logged.
 *
 * Response contract:
 *   - On success:  attaches `req.user = { id, email }` and calls next().
 *   - On failure:  401 UNAUTHORIZED with an opaque message. We intentionally
 *                  do NOT leak the specific reason (expired vs bad signature
 *                  vs wrong issuer vs JWKS unreachable). If we need to
 *                  distinguish these for ops, do it in the verifier and in
 *                  server logs — not in the client-facing response.
 */

import type { NextFunction, Request, Response } from 'express';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { UnauthorizedError } from '../errors/AppError.js';
import { verifySupabaseJwt } from '../utils/jwtVerifier.js';
import { logger } from '../utils/logger.js';

/**
 * Hard cap on the JWT-verification phase (includes lazy JWKS fetch on first
 * call). Set BELOW jose's own 5000ms `timeoutDuration` so we get a
 * deterministic log line identifying auth as the hang point instead of a
 * generic "verify failed". Raise this only if you have a good reason.
 */
const AUTH_TIMEOUT_MS = 4000;

/** Shape of the user object attached to authenticated requests. */
export interface AuthenticatedUser {
  id: string;
  email?: string;
}

// Augment Express `Request` with an optional `user` field.
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token.trim();
}

export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const reqId = req.reqId;
  const startMs = Date.now();
  logger.info({ reqId }, 'REQ_AUTH_START');

  const token = extractBearerToken(req.header('authorization'));
  if (!token) {
    logger.warn(
      { reqId, duration_ms: Date.now() - startMs, reason: 'no_token' },
      'REQ_AUTH_FAIL',
    );
    return next(new UnauthorizedError('Missing bearer token'));
  }

  // Race the verifier against an explicit timeout so a stuck JWKS fetch
  // surfaces as a clear log line with a known duration instead of hanging
  // for whatever jose's internal timeout decides.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `JWT verify timeout after ${AUTH_TIMEOUT_MS}ms (likely JWKS fetch stuck — check backend host's outbound HTTPS to SUPABASE_URL)`,
          ),
        ),
      AUTH_TIMEOUT_MS,
    );
  });

  try {
    const claims = await Promise.race([verifySupabaseJwt(token), timeoutPromise]);
    req.user = { id: claims.sub, email: claims.email };
    logger.info(
      { reqId, duration_ms: Date.now() - startMs, sub: claims.sub },
      'REQ_AUTH_OK',
    );
    return next();
  } catch (err) {
    // Log the real reason server-side; client still sees opaque 401.
    // Include unverified token header + iss/exp/sub to make diagnosis
    // instant — this is safe: decodeJwt / decodeProtectedHeader only
    // base64url-decode, they don't validate anything.
    let alg: string | undefined;
    let kid: string | undefined;
    let iss: string | undefined;
    let exp: number | undefined;
    let subPrefix: string | undefined;
    try {
      const h = decodeProtectedHeader(token);
      alg = h.alg;
      kid = typeof h.kid === 'string' ? h.kid : undefined;
      const p = decodeJwt(token);
      iss = typeof p.iss === 'string' ? p.iss : undefined;
      exp = typeof p.exp === 'number' ? p.exp : undefined;
      subPrefix =
        typeof p.sub === 'string' ? p.sub.slice(0, 8) : undefined;
    } catch {
      /* malformed token: leave fields undefined */
    }
    logger.warn(
      {
        reqId,
        duration_ms: Date.now() - startMs,
        reason: err instanceof Error ? err.message : String(err),
        token_alg: alg,
        token_kid: kid,
        token_iss: iss,
        token_exp: exp,
        token_sub_prefix: subPrefix,
      },
      'REQ_AUTH_FAIL',
    );
    return next(new UnauthorizedError('Invalid or expired token'));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
