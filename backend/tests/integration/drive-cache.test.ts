/**
 * Unit tests for the in-memory Google access_token cache layered onto
 * `getAccessToken` / `invalidateAccessToken` / `withDriveRetry` in
 * `src/services/drive.service.ts`.
 *
 * Strategy:
 *   - Override `globalThis.fetch` so we can pretend to be Google's
 *     /token endpoint without making any real network call.
 *   - `vi.resetModules()` between tests so each test sees a fresh
 *     module-level cache (the `Map` lives at module scope).
 *
 * Out of scope here (covered by integration tests of /drive/chunks
 * and /sessions/:id/chunks/:index/download): full HTTP plumbing,
 * authMiddleware, DB. We only verify cache mechanics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // assertGoogleConfigured() (called by _refreshFromGoogle) requires
  // these to be set. They're optional in the env schema so defaults
  // from setup.ts don't help us — set per-test.
  process.env.GOOGLE_CLIENT_ID = 'test-cid';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://example.test/cb';
  // Drop the cached module so the in-memory token Map is fresh AND
  // env.ts re-reads env on next import.
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function googleTokenResponse(token: string, expires_in = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadDriveService() {
  // Both modules must be loaded AFTER `vi.resetModules()` so they share
  // the same module instance — otherwise drive.service.ts's internal
  // `err instanceof AppError` check fails against an `AppError` the test
  // imported from a stale module copy. Returning AppError alongside the
  // service surface lets each test create errors that drive.service
  // genuinely recognises.
  const driveModule = await import('../../src/services/drive.service.js');
  const { AppError } = await import('../../src/errors/AppError.js');
  return { ...driveModule, AppError };
}

describe('Google access_token cache', () => {
  it('cache hit reuses the access_token without hitting Google again', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(googleTokenResponse('tok-1'));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { getAccessToken } = await loadDriveService();
    const t1 = await getAccessToken('refresh-X');
    const t2 = await getAccessToken('refresh-X');

    expect(t1).toBe('tok-1');
    expect(t2).toBe('tok-1');
    // Single Google round-trip for two callers — exact cache-hit invariant.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('respects the TTL safety margin (expires_in below margin → entry expires immediately)', async () => {
    // 60s expires_in is well below the 5-minute (300s) safety margin,
    // so ttl_ms collapses to 0 and the entry is stale on first read.
    // The next call must trigger another Google round-trip.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(googleTokenResponse('tok-short-1', 60))
      .mockResolvedValueOnce(googleTokenResponse('tok-short-2', 60));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { getAccessToken } = await loadDriveService();
    const t1 = await getAccessToken('refresh-Y');
    const t2 = await getAccessToken('refresh-Y');

    expect(t1).toBe('tok-short-1');
    expect(t2).toBe('tok-short-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateAccessToken removes the entry; the next call refreshes from Google', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(googleTokenResponse('tok-A'))
      .mockResolvedValueOnce(googleTokenResponse('tok-B'));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { getAccessToken, invalidateAccessToken } = await loadDriveService();
    const a1 = await getAccessToken('refresh-Z');
    expect(a1).toBe('tok-A');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateAccessToken('refresh-Z');
    const a2 = await getAccessToken('refresh-Z');
    expect(a2).toBe('tok-B');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateAccessToken on an absent key is a silent no-op', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { invalidateAccessToken } = await loadDriveService();
    // Should not throw; should not trigger any fetch.
    expect(() => invalidateAccessToken('never-cached')).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('withDriveRetry retries the closure exactly once after a DRIVE_AUTH_EXPIRED', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(googleTokenResponse('tok-stale')) // initial
      .mockResolvedValueOnce(googleTokenResponse('tok-fresh')); // post-invalidate
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { withDriveRetry, AppError } = await loadDriveService();

    let calls = 0;
    const result = await withDriveRetry('refresh-W', async (accessToken) => {
      calls += 1;
      if (calls === 1) {
        // Mirrors what driveGet/drivePost/uploadFile/downloadFile throw
        // when Drive returns 401: AppError(401, 'DRIVE_AUTH_EXPIRED', ...).
        throw new AppError(
          401,
          'DRIVE_AUTH_EXPIRED',
          'simulated 401 from Drive',
        );
      }
      // Second invocation must see the freshly-refreshed token.
      expect(accessToken).toBe('tok-fresh');
      return 'OK';
    });

    expect(result).toBe('OK');
    expect(calls).toBe(2);
    // First call set tok-stale; invalidate; second call refreshed → 2 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('withDriveRetry does NOT retry a second time (propagates the second 401)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(googleTokenResponse('tok-1'))
      .mockResolvedValueOnce(googleTokenResponse('tok-2'));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { withDriveRetry, AppError } = await loadDriveService();

    let calls = 0;
    await expect(
      withDriveRetry('refresh-W2', async () => {
        calls += 1;
        throw new AppError(
          401,
          'DRIVE_AUTH_EXPIRED',
          `simulated 401 attempt ${calls}`,
        );
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_AUTH_EXPIRED' });

    // Exactly two attempts: original + post-invalidate retry. No third try.
    expect(calls).toBe(2);
  });

  it('withDriveRetry does not retry on non-401 errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(googleTokenResponse('tok-1'));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { withDriveRetry, AppError } = await loadDriveService();

    let calls = 0;
    await expect(
      withDriveRetry('refresh-W3', async () => {
        calls += 1;
        throw new AppError(502, 'DRIVE_API_FAILED', 'simulated upstream');
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_API_FAILED' });

    expect(calls).toBe(1);
    // Only the initial token fetch; no retry → no second token fetch either.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent miss collapses to a single Google round-trip (single-flight)', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn().mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { getAccessToken } = await loadDriveService();

    // Two concurrent callers race on a cold cache. The first one starts
    // the fetch and installs an in-flight Promise in the cache slot;
    // the second one finds that slot and awaits the same Promise
    // instead of calling fetch a second time.
    const p1 = getAccessToken('refresh-S');
    const p2 = getAccessToken('refresh-S');

    // Resolve the shared fetch once both callers are queued.
    resolveFetch(googleTokenResponse('tok-shared'));

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('tok-shared');
    expect(t2).toBe('tok-shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('failed in-flight refresh clears the slot so a later caller can retry', async () => {
    const fetchMock = vi
      .fn()
      // First call: 5xx three times so _refreshFromGoogle exhausts its
      // bounded retry and throws DRIVE_REFRESH_FAILED.
      .mockResolvedValue(
        new Response('upstream broke', { status: 503 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { getAccessToken } = await loadDriveService();

    await expect(getAccessToken('refresh-FAIL')).rejects.toMatchObject({
      code: 'DRIVE_REFRESH_FAILED',
    });

    // Subsequent call must NOT see a stale failed-promise in the slot —
    // it must start a fresh attempt. We re-program fetch to succeed
    // and check.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(googleTokenResponse('tok-recovered'));

    const recovered = await getAccessToken('refresh-FAIL');
    expect(recovered).toBe('tok-recovered');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
