/**
 * Supabase JWT verifier.
 *
 * Supabase projects can issue user access tokens in two shapes and a
 * single deployment may encounter both depending on project state:
 *
 *   - HS256 (legacy / still default on many projects): signed with the
 *     project's shared `SUPABASE_JWT_SECRET`. The JWKS endpoint may or
 *     may not be populated; the token is verified with HMAC using the
 *     shared secret.
 *
 *   - ES256 / RS256 (post asymmetric-signing rollout): signed with the
 *     project's rotating private key. Verified against the public JWKS
 *     served at `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
 *
 * We branch on the token's header `alg` so a single backend works
 * against either state without re-configuration. Issuer is pinned in
 * both paths so a token from another Supabase project cannot be
 * replayed here. `exp` / `nbf` are enforced by `jwtVerify`.
 *
 * `jose.createRemoteJWKSet` owns:
 *   - lazy first fetch (no network at import time)
 *   - in-memory caching
 *   - `cooldownDuration`: re-fetch cadence when an unknown `kid` shows
 *     up (covers key rotation)
 *   - `timeoutDuration`: hard cap on the JWKS HTTP request
 *
 * NOTE: network failures during JWKS fetch will surface here as
 * rejections. Callers (middleware) currently collapse all failures
 * into 401 UNAUTHORIZED. If we ever need to distinguish "bad token"
 * from "JWKS unreachable", this is the place to add it — not the
 * middleware.
 */

import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { env } from '../config/env.js';

const baseUrl = env.SUPABASE_URL.replace(/\/$/, '');

const JWKS_URL = new URL(`${baseUrl}/auth/v1/.well-known/jwks.json`);
const ISSUER = `${baseUrl}/auth/v1`;

const getKey = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30_000, // 30s between re-fetches on unknown kid
  timeoutDuration: 5_000, //  5s hard cap per JWKS HTTP request
});

// Pre-encode the HMAC secret once. `jose.jwtVerify` for HS* expects
// a `Uint8Array` key. If the project doesn't set the secret the value
// stays null and the HS256 branch rejects early with a clear message.
const hsSecret: Uint8Array | null = env.SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET)
  : null;

export interface VerifiedClaims {
  sub: string;
  email?: string;
}

function toClaims(payload: JWTPayload): VerifiedClaims {
  if (!payload.sub) {
    throw new Error('Token missing `sub` claim');
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}

/**
 * Verifies a Supabase-issued JWT and returns the claims we actually
 * use. Throws on any verification failure (bad signature, wrong
 * issuer, expired, missing `sub`, JWKS unreachable, unsupported alg,
 * missing HS256 secret when required, etc.).
 */
export async function verifySupabaseJwt(
  token: string,
): Promise<VerifiedClaims> {
  // Peek at the header (unverified) to pick the right verification
  // path. `decodeProtectedHeader` only parses base64url — no network,
  // no signature check.
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new Error('Malformed JWT header');
  }

  if (alg === 'HS256') {
    if (!hsSecret) {
      throw new Error(
        'Token is HS256 but SUPABASE_JWT_SECRET is not configured',
      );
    }
    const { payload } = await jwtVerify(token, hsSecret, {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
    return toClaims(payload);
  }

  if (alg === 'ES256' || alg === 'RS256') {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: ISSUER,
      algorithms: ['ES256', 'RS256'],
    });
    return toClaims(payload);
  }

  throw new Error(`Unsupported JWT alg: ${alg ?? 'unknown'}`);
}
