/**
 * GET /sessions/:id/chunks/:index/download integration tests.
 *
 * Covers the per-session destination bifurcation added so NAS sessions
 * can be exported through the existing endpoint without rewriting the
 * mobile client. Supabase + Drive + WebDAV are all mocked — these tests
 * pin the *routing decision* and the SSRF guard, not real backend I/O.
 *
 * Three scenarios:
 *   1. session.destination_type === 'drive'  → Drive branch is taken,
 *      WebDAV adapter is NOT invoked.
 *   2. session.destination_type === 'nas' + matching remote_reference
 *      prefix → WebDAV adapter is invoked with the right URL +
 *      decrypted-credential payload.
 *   3. session.destination_type === 'nas' + remote_reference outside
 *      the user's connected NAS prefix → 409 NAS_REF_PREFIX_MISMATCH;
 *      WebDAV adapter is NOT invoked.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signTestJwt } from '../helpers/jwt.js';

const {
  sessionMaybeSingle,
  destinationMaybeSingle,
  chunksOrder,
  webdavDownloadMock,
  driveDownloadMock,
  driveAccessTokenMock,
} = vi.hoisted(() => ({
  sessionMaybeSingle: vi.fn(),
  destinationMaybeSingle: vi.fn(),
  chunksOrder: vi.fn(),
  webdavDownloadMock: vi.fn(),
  driveDownloadMock: vi.fn(),
  driveAccessTokenMock: vi.fn(),
}));

vi.mock('../../src/config/supabase.js', () => {
  // Each table chains differently; mirror exactly the calls the
  // services perform so a refactor breaks loudly instead of silently
  // mis-mocking. `sessions` is queried by both `getOwnedSession`
  // (chunks.service ownership preflight) and the route's own
  // `getOwnedSession` for `destination_type` — same maybeSingle stub
  // serves both calls (use `mockResolvedValue`, not `Once`).
  const sessionsTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: sessionMaybeSingle }),
      }),
    }),
  };
  const chunksTable = {
    select: () => ({
      eq: () => ({ order: chunksOrder }),
    }),
  };
  const destinationsTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: destinationMaybeSingle }),
      }),
    }),
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'sessions') return sessionsTable;
        if (table === 'chunks') return chunksTable;
        if (table === 'destinations') return destinationsTable;
        throw new Error(`Unexpected table: ${table}`);
      },
    },
  };
});

vi.mock('../../src/utils/jwtVerifier.js', () => ({
  verifySupabaseJwt: async (token: string) => {
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('bad token');
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    );
    if (!payload.sub) throw new Error('missing sub');
    return { sub: payload.sub, email: payload.email };
  },
}));

vi.mock('../../src/adapters/webdav.adapter.js', () => ({
  downloadChunk: webdavDownloadMock,
}));

vi.mock('../../src/services/drive.service.js', () => ({
  downloadFile: driveDownloadMock,
  getAccessToken: driveAccessTokenMock,
  // Thin pass-through stub for the retry wrapper added in the access-token
  // cache work. The route under test went from `getAccessToken` + direct
  // `downloadFile` to `withDriveRetry(refresh_token, fn)`; the wrapper
  // resolves the token via the cache and runs `fn(token)` once. The test
  // does not exercise the retry-after-401 path, so a no-retry pass-through
  // keeps the existing assertions on `driveAccessTokenMock` and
  // `driveDownloadMock` valid.
  withDriveRetry: async (
    refreshToken: string,
    fn: (token: string) => unknown,
  ) => {
    const token = await driveAccessTokenMock(refreshToken);
    return fn(token);
  },
}));

const { createApp } = await import('../../src/app.js');

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'user-test';

function ownedSessionRow(destination_type: 'drive' | 'nas') {
  return {
    id: SESSION_ID,
    user_id: USER_ID,
    mode: 'audio' as const,
    destination_type,
    status: 'completed' as const,
    chunk_count: 1,
    created_at: '2026-04-17T10:15:30.000Z',
    completed_at: '2026-04-17T10:16:00.000Z',
  };
}

describe('GET /sessions/:id/chunks/:index/download', () => {
  const app = createApp();

  beforeEach(() => {
    sessionMaybeSingle.mockReset();
    destinationMaybeSingle.mockReset();
    chunksOrder.mockReset();
    webdavDownloadMock.mockReset();
    driveDownloadMock.mockReset();
    driveAccessTokenMock.mockReset();
  });

  it('Drive sessions route through the Drive branch (WebDAV adapter never called)', async () => {
    sessionMaybeSingle.mockResolvedValue({
      data: ownedSessionRow('drive'),
      error: null,
    });
    chunksOrder.mockResolvedValue({
      data: [
        {
          chunk_index: 0,
          hash: 'a'.repeat(64),
          size: 11,
          status: 'uploaded',
          remote_reference: 'drive-file-id-abc',
        },
      ],
      error: null,
    });
    // The Drive branch reads the user's drive destination; the helper
    // narrows on `dest.refresh_token` so any non-null value is enough.
    destinationMaybeSingle.mockResolvedValue({
      data: {
        id: 'dest-drive',
        user_id: USER_ID,
        type: 'drive',
        status: 'connected',
        refresh_token: 'rt',
        folder_id: null,
        account_email: null,
        webdav_url: null,
        webdav_username: null,
        webdav_password_encrypted: null,
        webdav_base_path: null,
        created_at: '',
        updated_at: '',
      },
      error: null,
    });
    driveAccessTokenMock.mockResolvedValue('access-token-fake');
    driveDownloadMock.mockResolvedValue(Buffer.from('drive-bytes'));

    const token = signTestJwt({ sub: USER_ID });
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/chunks/0/download`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-chunk-hash']).toBe('a'.repeat(64));
    expect(res.body).toEqual(Buffer.from('drive-bytes'));
    expect(driveDownloadMock).toHaveBeenCalledTimes(1);
    expect(driveDownloadMock).toHaveBeenCalledWith(
      'access-token-fake',
      'drive-file-id-abc',
    );
    expect(webdavDownloadMock).not.toHaveBeenCalled();
  });

  it('NAS sessions route through the WebDAV adapter when remote_reference matches the connected NAS prefix', async () => {
    const webdavUrl = 'http://nas.local:8088';
    const basePath = '/dav';
    const validRef = `${webdavUrl}${basePath}/GuardianCloud/${SESSION_ID}/0.chunk`;

    sessionMaybeSingle.mockResolvedValue({
      data: ownedSessionRow('nas'),
      error: null,
    });
    chunksOrder.mockResolvedValue({
      data: [
        {
          chunk_index: 0,
          hash: 'b'.repeat(64),
          size: 9,
          status: 'uploaded',
          remote_reference: validRef,
        },
      ],
      error: null,
    });
    destinationMaybeSingle.mockResolvedValue({
      data: {
        id: 'dest-nas',
        user_id: USER_ID,
        type: 'nas',
        status: 'connected',
        refresh_token: null,
        folder_id: null,
        account_email: null,
        webdav_url: webdavUrl,
        webdav_username: 'guardian',
        webdav_password_encrypted: 'v1:iv:tag:cipher',
        webdav_base_path: basePath,
        created_at: '',
        updated_at: '',
      },
      error: null,
    });
    webdavDownloadMock.mockResolvedValue({ bytes: Buffer.from('nas-bytes') });

    const token = signTestJwt({ sub: USER_ID });
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/chunks/0/download`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-chunk-hash']).toBe('b'.repeat(64));
    expect(res.body).toEqual(Buffer.from('nas-bytes'));
    expect(webdavDownloadMock).toHaveBeenCalledTimes(1);
    expect(webdavDownloadMock).toHaveBeenCalledWith({
      url: validRef,
      destination: {
        username: 'guardian',
        encryptedPassword: 'v1:iv:tag:cipher',
      },
    });
    expect(driveDownloadMock).not.toHaveBeenCalled();
  });

  it('NAS sessions reject remote_reference outside the connected NAS prefix (NAS_REF_PREFIX_MISMATCH)', async () => {
    const webdavUrl = 'http://nas.local:8088';
    const basePath = '/dav';
    // Crafted to look NAS-like but live on a different host — this is
    // exactly the SSRF / DB-tampering scenario the prefix check exists
    // to reject. The path AFTER the host happens to match the
    // GuardianCloud convention, which makes the test sharper: only
    // the host prefix saves us.
    const evilRef = `http://attacker.example:8088/dav/GuardianCloud/${SESSION_ID}/0.chunk`;

    sessionMaybeSingle.mockResolvedValue({
      data: ownedSessionRow('nas'),
      error: null,
    });
    chunksOrder.mockResolvedValue({
      data: [
        {
          chunk_index: 0,
          hash: 'c'.repeat(64),
          size: 9,
          status: 'uploaded',
          remote_reference: evilRef,
        },
      ],
      error: null,
    });
    destinationMaybeSingle.mockResolvedValue({
      data: {
        id: 'dest-nas',
        user_id: USER_ID,
        type: 'nas',
        status: 'connected',
        refresh_token: null,
        folder_id: null,
        account_email: null,
        webdav_url: webdavUrl,
        webdav_username: 'guardian',
        webdav_password_encrypted: 'v1:iv:tag:cipher',
        webdav_base_path: basePath,
        created_at: '',
        updated_at: '',
      },
      error: null,
    });

    const token = signTestJwt({ sub: USER_ID });
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/chunks/0/download`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NAS_REF_PREFIX_MISMATCH');
    expect(webdavDownloadMock).not.toHaveBeenCalled();
    expect(driveDownloadMock).not.toHaveBeenCalled();
  });
});
