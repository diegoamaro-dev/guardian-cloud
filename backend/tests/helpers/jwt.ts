/**
 * Test helper: build an unsigned JWT-shaped token for integration tests.
 *
 * Production now verifies Supabase tokens against the project's JWKS (see
 * `src/utils/jwtVerifier.ts`). We don't want tests hitting that network path,
 * so each test file mocks `verifySupabaseJwt` and either:
 *   - decodes this fake token's payload to hand back `{ sub, email }`, or
 *   - ignores the token entirely and returns a canned result.
 *
 * The token is NOT signed. The header is `alg: "none"`. Never import this
 * from `src/`; it's test-only.
 */

export interface TestJwtPayload {
  sub: string;
  email?: string;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function signTestJwt(payload: TestJwtPayload): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}
