/**
 * POST /chunks integration tests.
 *
 * Supabase is mocked. DB-level integration tests against a real Supabase
 * project belong to a later brick (CI wiring).
 *
 * Covered here:
 *   - 400 on every meaningful shape violation
 *   - 404 SESSION_NOT_FOUND (session missing OR owned by another user)
 *   - 409 SESSION_NOT_ACTIVE (completed/failed session)
 *   - 201 on first register
 *   - 200 idempotent replay (same hash, same status, same remote_reference)
 *   - 200 valid state transition (pending → uploaded)
 *   - 409 CHUNK_HASH_MISMATCH (same index, different hash)
 *   - 409 CHUNK_TERMINAL (uploaded → pending)
 *   - 500 surfaces on supabase errors
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signTestJwt } from '../helpers/jwt.js';

// Hoisted mock handles so the module factory below can reference them.
const {
  sessionMaybeSingle,
  chunkInsertSingle,
  chunkSelectSingle,
  chunkUpdateSingle,
} = vi.hoisted(() => ({
  sessionMaybeSingle: vi.fn(),
  chunkInsertSingle: vi.fn(),
  chunkSelectSingle: vi.fn(),
  chunkUpdateSingle: vi.fn(),
}));

vi.mock('../../src/config/supabase.js', () => {
  // Each table gets its own chainable stub. The structure mirrors the real
  // calls performed by the service, so if the service grows a new call, the
  // test will break loudly instead of silently mis-mocking.
  const sessionsTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: sessionMaybeSingle }),
      }),
    }),
  };

  const chunksTable = {
    insert: () => ({ select: () => ({ single: chunkInsertSingle }) }),
    select: () => ({
      eq: () => ({
        eq: () => ({ single: chunkSelectSingle }),
      }),
    }),
    update: () => ({
      eq: () => ({ select: () => ({ single: chunkUpdateSingle }) }),
    }),
  };

  return {
    supabase: {
      from: (table: string) => {
        if (table === 'sessions') return sessionsTable;
        if (table === 'chunks') return chunksTable;
        throw new Error(`Unexpected table: ${table}`);
      },
    },
  };
});

// Decode-only stand-in for the JWKS verifier (same approach as sessions.test).
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

// Import AFTER vi.mock so the mock is in place.
const { createApp } = await import('../../src/app.js');

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const CHUNK_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION_ID,
    chunk_index: 0,
    hash: HASH_A,
    size: 1024,
    status: 'pending' as const,
    ...overrides,
  };
}

function chunkRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CHUNK_ID,
    session_id: SESSION_ID,
    chunk_index: 0,
    hash: HASH_A,
    size: 1024,
    status: 'pending',
    remote_reference: null,
    created_at: '2026-04-17T10:15:30.000Z',
    updated_at: '2026-04-17T10:15:30.000Z',
    ...overrides,
  };
}

function activeSession() {
  return { data: { id: SESSION_ID, status: 'active' }, error: null };
}

describe('POST /chunks', () => {
  const app = createApp();
  const bearer = () => `Bearer ${signTestJwt({ sub: 'user-1' })}`;

  beforeEach(() => {
    sessionMaybeSingle.mockReset();
    chunkInsertSingle.mockReset();
    chunkSelectSingle.mockReset();
    chunkUpdateSingle.mockReset();
  });

  // ── body validation ──────────────────────────────────────────────────────

  it('400 when session_id is missing', async () => {
    const { session_id: _omit, ...body } = validBody();

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('400 when hash is not 64 hex chars', async () => {
    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody({ hash: 'nothex' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('400 when hash contains uppercase', async () => {
    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody({ hash: 'A'.repeat(64) }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('400 when size exceeds 20 MiB', async () => {
    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody({ size: 20 * 1024 * 1024 + 1 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('400 when status is not in enum', async () => {
    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody({ status: 'done' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('400 when chunk_index is negative', async () => {
    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody({ chunk_index: -1 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  // ── ownership / state ────────────────────────────────────────────────────

  it('404 SESSION_NOT_FOUND when the session does not exist (or is not owned by the user)', async () => {
    sessionMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('409 SESSION_NOT_ACTIVE when the session is completed', async () => {
    sessionMaybeSingle.mockResolvedValueOnce({
      data: { id: SESSION_ID, status: 'completed' },
      error: null,
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_NOT_ACTIVE');
  });

  // ── happy path + idempotency ─────────────────────────────────────────────

  it('201 on first register', async () => {
    sessionMaybeSingle.mockResolvedValueOnce(activeSession());
    chunkInsertSingle.mockResolvedValueOnce({
      data: chunkRow(),
      error: null,
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      chunk_id: CHUNK_ID,
      session_id: SESSION_ID,
      chunk_index: 0,
      status: 'pending',
      hash: HASH_A,
      size: 1024,
      remote_reference: null,
    });
  });

  it('200 on idempotent replay (same hash, same status, same remote_reference)', async () => {
    sessionMaybeSingle.mockResolvedValueOnce(activeSession());
    // Unique violation → service re-reads existing.
    chunkInsertSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    });
    chunkSelectSingle.mockResolvedValueOnce({
      data: chunkRow(),
      error: null,
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody());

    expect(res.status).toBe(200);
    expect(res.body.chunk_id).toBe(CHUNK_ID);
    // No update should have been performed on pure replay.
    expect(chunkUpdateSingle).not.toHaveBeenCalled();
  });

  it('200 on valid state transition pending → uploaded', async () => {
    sessionMaybeSingle.mockResolvedValueOnce(activeSession());
    chunkInsertSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    });
    chunkSelectSingle.mockResolvedValueOnce({
      data: chunkRow({ status: 'pending' }),
      error: null,
    });
    chunkUpdateSingle.mockResolvedValueOnce({
      data: chunkRow({
        status: 'uploaded',
        remote_reference: 'drive:abc123',
      }),
      error: null,
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(
        validBody({
          status: 'uploaded',
          remote_reference: 'drive:abc123',
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('uploaded');
    expect(res.body.remote_reference).toBe('drive:abc123');
    expect(chunkUpdateSingle).toHaveBeenCalledTimes(1);
  });

  // ── conflict rules ───────────────────────────────────────────────────────

  it('409 CHUNK_HASH_MISMATCH when the same index exists with a different hash', async () => {
    sessionMaybeSingle.mockResolvedValueOnce(activeSession());
    chunkInsertSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    });
    chunkSelectSingle.mockResolvedValueOnce({
      data: chunkRow({ hash: HASH_B }),
      error: null,
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody({ hash: HASH_A }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHUNK_HASH_MISMATCH');
    expect(chunkUpdateSingle).not.toHaveBeenCalled();
  });

  it('409 CHUNK_TERMINAL when trying to regress from uploaded to pending', async () => {
    sessionMaybeSingle.mockResolvedValueOnce(activeSession());
    chunkInsertSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    });
    chunkSelectSingle.mockResolvedValueOnce({
      data: chunkRow({ status: 'uploaded' }),
      error: null,
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody({ status: 'pending' }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHUNK_TERMINAL');
    expect(chunkUpdateSingle).not.toHaveBeenCalled();
  });

  it('200 when re-sending uploaded for an already uploaded chunk (idempotent)', async () => {
    sessionMaybeSingle.mockResolvedValueOnce(activeSession());
    chunkInsertSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    });
    chunkSelectSingle.mockResolvedValueOnce({
      data: chunkRow({
        status: 'uploaded',
        remote_reference: 'drive:abc123',
      }),
      error: null,
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(
        validBody({ status: 'uploaded', remote_reference: 'drive:abc123' }),
      );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('uploaded');
    expect(chunkUpdateSingle).not.toHaveBeenCalled();
  });

  // ── error surfacing ──────────────────────────────────────────────────────

  it('500 SESSION_LOOKUP_FAILED when the sessions query errors', async () => {
    sessionMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'db down' },
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('SESSION_LOOKUP_FAILED');
  });

  it('500 CHUNK_CREATE_FAILED on a non-unique-violation insert error', async () => {
    sessionMaybeSingle.mockResolvedValueOnce(activeSession());
    chunkInsertSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '42P01', message: 'relation does not exist' },
    });

    const res = await request(app)
      .post('/chunks')
      .set('Authorization', bearer())
      .send(validBody());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('CHUNK_CREATE_FAILED');
  });
});
