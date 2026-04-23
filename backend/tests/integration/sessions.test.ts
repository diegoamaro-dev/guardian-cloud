/**
 * POST /sessions integration tests.
 *
 * Supabase is mocked. DB-level integration tests against a real Supabase
 * test project will be added in a later brick, when we wire CI.
 *
 * Covered here:
 *   - happy path: valid JWT + valid body → 201, user_id sourced from JWT
 *   - invalid body shapes → 400 INVALID_BODY
 *   - supabase failure   → 500 SESSION_CREATE_FAILED
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signTestJwt } from '../helpers/jwt.js';

const { dbSingle, dbInsert } = vi.hoisted(() => ({
  dbSingle: vi.fn(),
  dbInsert: vi.fn(),
}));

vi.mock('../../src/config/supabase.js', () => ({
  supabase: {
    from: () => ({
      insert: (payload: unknown) => {
        dbInsert(payload);
        return {
          select: () => ({ single: dbSingle }),
        };
      },
    }),
  },
}));

// Decode-only stand-in for the real JWKS verifier. Tests build tokens with
// `signTestJwt` (unsigned, alg: "none"); this mock pulls `sub`/`email` out of
// the middle segment so route-level assertions can still depend on the user.
vi.mock('../../src/utils/jwtVerifier.js', () => ({
  verifySupabaseJwt: async (token: string) => {
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('bad token');
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    if (!payload.sub) throw new Error('missing sub');
    return { sub: payload.sub, email: payload.email };
  },
}));

const { createApp } = await import('../../src/app.js');

describe('POST /sessions', () => {
  const app = createApp();

  beforeEach(() => {
    dbSingle.mockReset();
    dbInsert.mockReset();
  });

  it('201 on valid body and JWT; user_id comes from the JWT', async () => {
    dbSingle.mockResolvedValueOnce({
      data: {
        id: '11111111-1111-1111-1111-111111111111',
        status: 'active',
        mode: 'video',
        destination_type: 'drive',
        created_at: '2026-04-17T10:15:30.000Z',
      },
      error: null,
    });

    const token = signTestJwt({ sub: 'user-happy' });
    const res = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'video', destination_type: 'drive' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      session_id: '11111111-1111-1111-1111-111111111111',
      status: 'active',
      mode: 'video',
      destination_type: 'drive',
    });
    expect(typeof res.body.created_at).toBe('string');

    // Service must have sent the user_id taken from the JWT `sub`,
    // never any value the client could have injected in the body.
    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(dbInsert).toHaveBeenCalledWith({
      user_id: 'user-happy',
      mode: 'video',
      destination_type: 'drive',
    });
  });

  it('ignores any user_id passed in the body', async () => {
    dbSingle.mockResolvedValueOnce({
      data: {
        id: '22222222-2222-2222-2222-222222222222',
        status: 'active',
        mode: 'audio',
        destination_type: 'none',
        created_at: '2026-04-17T10:15:30.000Z',
      },
      error: null,
    });

    const token = signTestJwt({ sub: 'user-real' });
    await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mode: 'audio',
        destination_type: 'none',
        // Attempted impersonation. zod should strip unknown fields, and
        // even if it didn't, the service never reads it.
        user_id: 'attacker',
      });

    expect(dbInsert).toHaveBeenCalledWith({
      user_id: 'user-real',
      mode: 'audio',
      destination_type: 'none',
    });
  });

  it('400 when mode is missing', async () => {
    const token = signTestJwt({ sub: 'user-1' });
    const res = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ destination_type: 'drive' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('400 when mode is not in enum', async () => {
    const token = signTestJwt({ sub: 'user-1' });
    const res = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'photo', destination_type: 'drive' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('400 when destination_type is not in enum', async () => {
    const token = signTestJwt({ sub: 'user-1' });
    const res = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'audio', destination_type: 's3' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('500 SESSION_CREATE_FAILED when Supabase returns an error', async () => {
    dbSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'db exploded' },
    });

    const token = signTestJwt({ sub: 'user-err' });
    const res = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'audio', destination_type: 'none' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('SESSION_CREATE_FAILED');
  });
});
