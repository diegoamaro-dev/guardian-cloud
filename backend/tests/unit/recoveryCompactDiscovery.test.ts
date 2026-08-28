/**
 * GC-RECOVERY-COMPACT-DISCOVERY-001.
 *
 * Two properties this file exists to pin:
 *
 *   1. WITHOUT `?view`, the endpoint keeps its HISTORICAL contract —
 *      same seven fields, same partial/complete classification. APKs
 *      already in the field parse that shape.
 *   2. WITH `?view=compact`, discovery answers from Drive metadata alone
 *      and does NOT download a single manifest body.
 *
 * Drive and the destinations lookup are mocked. This is a unit test of
 * the two discovery contracts, not an integration test.
 *
 * On the 400 for an unknown `view`: the decision lives in
 * `parseDiscoveryView` and is unit-tested exhaustively below; the route
 * maps `null → 400`. An end-to-end assertion of that status would need a
 * VALID JWT, which makes `authMiddleware` fetch Supabase's JWKS over the
 * network — the very thing that makes the four pre-existing integration
 * failures time out in this environment. The 401 path needs no token and
 * no network, so auth is asserted end-to-end at the bottom of this file.
 */

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listFilesInFolder = vi.fn();
const downloadFile = vi.fn();
const withDriveRetry = vi.fn();
const getDestinationWithSecretForUser = vi.fn();

vi.mock('../../src/services/drive.service.js', () => ({
  listFilesInFolder: (...a: unknown[]) => listFilesInFolder(...a),
  downloadFile: (...a: unknown[]) => downloadFile(...a),
  withDriveRetry: (...a: unknown[]) => withDriveRetry(...a),
  ensureRootFolder: vi.fn(),
  findFileByName: vi.fn(),
}));

vi.mock('../../src/services/destinations.service.js', () => ({
  getDestinationWithSecretForUser: (...a: unknown[]) =>
    getDestinationWithSecretForUser(...a),
}));

const {
  listDriveManifests,
  listDriveManifestsCompact,
  parseDiscoveryView,
  dedupAndSortCompact,
} = await import('../../src/services/recovery.service.js');
const { createApp } = await import('../../src/app.js');

const USER = 'a1b40cd3-ef36-436f-a27d-9a54c1f81193';
const SID_A = '11111111-1111-1111-1111-111111111111';
const SID_B = '22222222-2222-2222-2222-222222222222';

function driveFile(sessionId: string, fileId: string, modifiedTime: string) {
  return { id: fileId, name: `${sessionId}_manifest.json`, modifiedTime };
}

function manifestBody(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 'guardian-cloud.manifest.v1',
      session_id: sessionId,
      mode: 'audio',
      destination_type: 'drive',
      created_at: '2026-05-14T10:00:00.000Z',
      completed_at: '2026-05-14T10:05:00.000Z',
      chunk_count: 3,
      chunks: [],
      ...overrides,
    }),
    'utf8',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getDestinationWithSecretForUser.mockResolvedValue({
    status: 'connected',
    refresh_token: 'rt',
    folder_id: 'folder-1',
  });
  withDriveRetry.mockImplementation(
    async (_rt: string, fn: (t: string) => Promise<unknown>) => fn('token'),
  );
});

describe('parseDiscoveryView', () => {
  it('absent → historical, so a client that predates the option is unaffected', () => {
    expect(parseDiscoveryView(undefined)).toBe('historical');
  });

  it("'compact' → compact", () => {
    expect(parseDiscoveryView('compact')).toBe('compact');
  });

  it('every other value → null, which the route answers as 400', () => {
    // No silent fallback: `?view=compat` must not quietly return the
    // historical shape to a client expecting the compact one.
    for (const bad of [
      'historical', // absence means historical; the word is not a value
      'compat',
      'COMPACT',
      '',
      'full',
      ['compact'],
      1,
      null,
      {},
    ]) {
      expect(parseDiscoveryView(bad)).toBeNull();
    }
  });
});

describe('DEFAULT view — historical contract preserved', () => {
  it('returns the seven historical fields, unchanged', async () => {
    listFilesInFolder.mockResolvedValue([
      driveFile(SID_A, 'file-a', '2026-05-14T10:06:00.000Z'),
    ]);
    downloadFile.mockResolvedValue(manifestBody(SID_A));

    const res = await listDriveManifests(USER);

    expect(res.manifests).toHaveLength(1);
    expect(Object.keys(res.manifests[0]!).sort()).toEqual([
      'chunk_count',
      'completed_at',
      'created_at',
      'manifest_file_id',
      'mode',
      'protection_status',
      'session_id',
    ]);
  });

  it('still downloads bodies — that is what makes it the historical path', async () => {
    listFilesInFolder.mockResolvedValue([
      driveFile(SID_A, 'file-a', '2026-05-14T10:06:00.000Z'),
      driveFile(SID_B, 'file-b', '2026-05-14T10:07:00.000Z'),
    ]);
    downloadFile
      .mockResolvedValueOnce(manifestBody(SID_A))
      .mockResolvedValueOnce(manifestBody(SID_B));

    await listDriveManifests(USER);

    expect(downloadFile).toHaveBeenCalledTimes(2);
  });

  it('preserves the partial/complete classification', async () => {
    listFilesInFolder.mockResolvedValue([
      driveFile(SID_A, 'complete', '2026-05-14T10:06:00.000Z'),
      driveFile(SID_B, 'partial', '2026-05-14T10:07:00.000Z'),
    ]);
    downloadFile
      .mockResolvedValueOnce(manifestBody(SID_A))
      .mockResolvedValueOnce(
        manifestBody(SID_B, { completed_at: null, is_partial: true }),
      );

    const res = await listDriveManifests(USER);

    const a = res.manifests.find((m) => m.session_id === SID_A);
    const b = res.manifests.find((m) => m.session_id === SID_B);
    expect(a!.protection_status).toBe('complete');
    expect(b!.protection_status).toBe('partial');
  });

  it('still skips a manifest whose body is invalid', async () => {
    listFilesInFolder.mockResolvedValue([
      driveFile(SID_A, 'bad', '2026-05-14T10:06:00.000Z'),
    ]);
    downloadFile.mockResolvedValue(Buffer.from('not json', 'utf8'));

    const res = await listDriveManifests(USER);

    expect(res.manifests).toHaveLength(0);
  });
});

describe('COMPACT view — metadata only', () => {
  it('NEVER downloads a manifest body, however many files there are', async () => {
    listFilesInFolder.mockResolvedValue(
      Array.from({ length: 75 }, (_, i) =>
        driveFile(
          `${String(i).padStart(8, '0')}-1111-1111-1111-111111111111`,
          `file-${i}`,
          `2026-08-28T12:00:${String(i % 60).padStart(2, '0')}.000Z`,
        ),
      ),
    );

    const res = await listDriveManifestsCompact(USER);

    expect(downloadFile).not.toHaveBeenCalled();
    expect(listFilesInFolder).toHaveBeenCalledTimes(1);
    expect(res.manifests).toHaveLength(75);
  });

  it('returns exactly the three metadata-derived fields', async () => {
    listFilesInFolder.mockResolvedValue([
      driveFile(SID_A, 'file-a', '2026-05-14T10:00:00.000Z'),
    ]);

    const res = await listDriveManifestsCompact(USER);

    expect(res).toEqual({
      drive_not_connected: false,
      manifests: [
        {
          session_id: SID_A,
          manifest_file_id: 'file-a',
          reference_date: '2026-05-14T10:00:00.000Z',
        },
      ],
    });
  });

  it('accepts a candidate by name without asserting the body is valid', async () => {
    // The body is never read, so a corrupt document cannot be detected
    // here — and must not be. The row asserts only that a file exists.
    // `getManifestByFileId` answers 404 MANIFEST_INVALID on open.
    listFilesInFolder.mockResolvedValue([
      driveFile(SID_A, 'file-corrupt', '2026-05-14T10:00:00.000Z'),
    ]);
    downloadFile.mockResolvedValue(Buffer.from('not json', 'utf8'));

    const res = await listDriveManifestsCompact(USER);

    expect(downloadFile).not.toHaveBeenCalled();
    expect(res.manifests).toHaveLength(1);
    expect(Object.keys(res.manifests[0]!).sort()).toEqual([
      'manifest_file_id',
      'reference_date',
      'session_id',
    ]);
  });

  it('respects the EXISTING pagination limits — no new paging introduced', async () => {
    listFilesInFolder.mockResolvedValue([]);

    await listDriveManifestsCompact(USER);

    expect(listFilesInFolder).toHaveBeenCalledWith('token', 'folder-1', {
      nameContains: '_manifest.json',
      pageSize: 100,
      maxPages: 10,
    });
  });

  it('dedups two Drive files sharing a name, newest modifiedTime winning', async () => {
    listFilesInFolder.mockResolvedValue([
      driveFile(SID_A, 'older', '2026-08-27T18:53:17.000Z'),
      driveFile(SID_A, 'newer', '2026-08-27T18:53:18.000Z'),
      driveFile(SID_B, 'other', '2026-08-27T19:00:00.000Z'),
    ]);

    const res = await listDriveManifestsCompact(USER);

    expect(res.manifests).toHaveLength(2);
    expect(
      res.manifests.find((m) => m.session_id === SID_A)!.manifest_file_id,
    ).toBe('newer');
  });

  it('drops names that do not match the manifest filename pattern', async () => {
    listFilesInFolder.mockResolvedValue([
      driveFile(SID_A, 'good', '2026-05-14T10:00:00.000Z'),
      { id: 'bad-1', name: 'something_manifest.json_old', modifiedTime: 't' },
      { id: 'bad-2', name: 'not-a-uuid_manifest.json', modifiedTime: 't' },
    ]);

    const res = await listDriveManifestsCompact(USER);

    expect(res.manifests).toHaveLength(1);
    expect(res.manifests[0]!.session_id).toBe(SID_A);
  });

  it('keeps the pre-existing loose name acceptance, unchanged by this work', async () => {
    // The pattern has always been `[0-9a-f-]{36}`; only the capture group
    // is new. Narrowing it to a canonical UUID is a separate decision.
    const degenerate = '-'.repeat(36);
    listFilesInFolder.mockResolvedValue([
      { id: 'weird', name: `${degenerate}_manifest.json`, modifiedTime: 't' },
    ]);

    const res = await listDriveManifestsCompact(USER);

    expect(res.manifests).toHaveLength(1);
    expect(res.manifests[0]!.session_id).toBe(degenerate);
  });

  it('sorts newest first by reference_date', async () => {
    expect(
      dedupAndSortCompact([
        { session_id: SID_A, manifest_file_id: 'a', modifiedTime: '2026-01-01T00:00:00.000Z' },
        { session_id: SID_B, manifest_file_id: 'b', modifiedTime: '2026-06-01T00:00:00.000Z' },
      ]).map((m) => m.session_id),
    ).toEqual([SID_B, SID_A]);
  });

  it('reports drive_not_connected without touching Drive', async () => {
    getDestinationWithSecretForUser.mockResolvedValue(null);

    const res = await listDriveManifestsCompact(USER);

    expect(res).toEqual({ drive_not_connected: true, manifests: [] });
    expect(listFilesInFolder).not.toHaveBeenCalled();
  });

  it('returns empty when there is no folder_id, without creating one', async () => {
    getDestinationWithSecretForUser.mockResolvedValue({
      status: 'connected',
      refresh_token: 'rt',
      folder_id: null,
    });

    const res = await listDriveManifestsCompact(USER);

    expect(res).toEqual({ drive_not_connected: false, manifests: [] });
    expect(listFilesInFolder).not.toHaveBeenCalled();
  });

  it('folds a Drive failure into an empty list instead of throwing', async () => {
    withDriveRetry.mockRejectedValue(new Error('drive exploded'));

    const res = await listDriveManifestsCompact(USER);

    expect(res).toEqual({ drive_not_connected: false, manifests: [] });
  });
});

describe('auth is unchanged on the discovery route', () => {
  const app = createApp();

  it('rejects an unauthenticated request, with or without ?view', async () => {
    // No bearer token: `authMiddleware` refuses before the verifier runs,
    // so this needs no JWKS fetch and no network.
    for (const url of [
      '/recovery/manifests',
      '/recovery/manifests?view=compact',
      '/recovery/manifests?view=bogus',
    ]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(401);
    }
  });
});
