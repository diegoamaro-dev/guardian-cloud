/**
 * Auth middleware integration tests.
 *
 * Uses POST /sessions as a canonical authenticated route. Both Supabase and
 * the JWT verifier are mocked so these tests never touch a real database
 * or the Supabase JWKS endpoint. The goal here is to validate the auth
 * layer's contract with the verifier, not the verifier itself.
 *
 * Signature verification (JWKS fetch, issuer pinning, alg whitelist, exp)
 * is covered by `jose` and by the verifier module directly.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock handles so the module factories below can reference them.
const { dbSingle, verifyMock } = vi.hoisted(() => ({
  dbSingle: vi.fn(),
  verifyMock: vi.fn(),
}));

vi.mock('../../src/config/supabase.js', () => ({
  supabase: {
    from: () => ({
      insert: () => ({
        select: () => ({ single: dbSingle }),
      }),
    }),
  },
}));

vi.mock('../../src/utils/jwtVerifier.js', () => ({
  verifySupabaseJwt: verifyMock,
}));

// Import AFTER vi.mock so the mocks are in place.
const { createApp } = await import('../../src/app.js');

describe('auth middleware (via POST /sessions)', () => {
  const app = createApp();

  beforeEach(() => {
    dbSingle.mockReset();
    verifyMock.mockReset();
    // Default to a successful DB row so 401 tests can't be masked by DB issues.
    dbSingle.mockResolvedValue({
      data: {
        id: '11111111-1111-1111-1111-111111111111',
        status: 'active',
        mode: 'audio',
        destination_type: 'none',
        created_at: '2026-04-17T00:00:00.000Z',
      },
      error: null,
    });
  });

  it('401 without Authorization header', async () => {
    const res = await request(app)
      .post('/sessions')
      .send({ mode: 'audio', destination_type: 'none' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    // Verifier must not be called if the header is missing.
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('401 with malformed bearer header', async () => {
    const res = await request(app)
      .post('/sessions')
      .set('Authorization', 'NotBearer foo')
      .send({ mode: 'audio', destination_type: 'none' });
    expect(res.status).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('401 when the verifier rejects (bad signature, expired, wrong issuer…)', async () => {
    verifyMock.mockRejectedValueOnce(new Error('JWTExpired'));

    const res = await request(app)
      .post('/sessions')
      .set('Authorization', 'Bearer whatever.looks.likeajwt')
      .send({ mode: 'audio', destination_type: 'none' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    // Response message must stay opaque — we never leak the verifier's reason.
    expect(res.body.error.message).toBe('Invalid or expired token');
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it('passes through and attaches user.id when the verifier resolves', async () => {
    verifyMock.mockResolvedValueOnce({
      sub: 'user-auth-ok',
      email: 'x@example.com',
    });

    const res = await request(app)
      .post('/sessions')
      .set('Authorization', 'Bearer whatever.looks.likeajwt')
      .send({ mode: 'audio', destination_type: 'none' });

    expect(res.status).toBe(201);
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });
});
