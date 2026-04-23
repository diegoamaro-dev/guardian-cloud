/**
 * /destinations client.
 *
 * Wraps the three MVP endpoints from API_SPEC.md + the test-upload
 * plumbing probe used by the Settings screen. Each function is a thin
 * call over `apiFetch`, which already handles auth, JSON, timeouts and
 * uniform `ApiError` mapping.
 *
 * `uploadChunkBytes` is the sole exception: it sends raw bytes
 * (application/octet-stream) to the backend proxy, so it bypasses
 * `apiFetch` (which is JSON-only) and speaks to `fetch` directly while
 * still emitting `ApiError` for a consistent error story.
 *
 * We do NOT store refresh_tokens on the client — the backend owns them.
 * The client only ever sees public projections.
 */

import { env } from '@/config/env';
import { getFreshAccessToken } from '@/auth/store';
import { apiFetch, ApiError } from './client';

export type DestinationType = 'drive';
export type DestinationStatus = 'connected' | 'revoked' | 'error';

export interface PublicDestination {
  id: string;
  type: DestinationType;
  status: DestinationStatus;
  folder_id: string | null;
  account_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListDestinationsResponse {
  destinations: PublicDestination[];
}

export interface DriveConnectStartResponse {
  auth_url: string;
  state: string | null;
}

export interface DriveConnectExchangeResponse {
  destination: PublicDestination;
}

export interface DriveTestUploadResponse {
  ok: true;
  remote_reference: string;
  file: {
    file_id: string;
    name: string;
    size: number;
    web_view_link?: string;
  };
}

/** GET /destinations */
export function listDestinations(signal?: AbortSignal): Promise<ListDestinationsResponse> {
  return apiFetch<ListDestinationsResponse>('/destinations', {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}

/**
 * Convenience: returns the connected Drive destination, or null.
 * Used by the Home screen's destination gate and by Settings to
 * render the current status line.
 */
export async function getConnectedDrive(
  signal?: AbortSignal,
): Promise<PublicDestination | null> {
  const { destinations } = await listDestinations(signal);
  const drive = destinations.find(
    (d) => d.type === 'drive' && d.status === 'connected',
  );
  return drive ?? null;
}

/** Step 1 of OAuth — retrieve the Google authorisation URL. */
export function startDriveConnect(
  redirectUri?: string,
  state?: string,
  signal?: AbortSignal,
): Promise<DriveConnectStartResponse> {
  return apiFetch<DriveConnectStartResponse>('/destinations/drive/connect', {
    method: 'POST',
    body: {
      action: 'start',
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      ...(state ? { state } : {}),
    },
    ...(signal ? { signal } : {}),
  });
}

/** Step 2 of OAuth — exchange the authorisation code for stored tokens. */
export function exchangeDriveCode(
  code: string,
  redirectUri?: string,
  state?: string,
  signal?: AbortSignal,
): Promise<DriveConnectExchangeResponse> {
  return apiFetch<DriveConnectExchangeResponse>('/destinations/drive/connect', {
    method: 'POST',
    body: {
      action: 'exchange',
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      ...(state ? { state } : {}),
    },
    ...(signal ? { signal } : {}),
  });
}

/** Fire the test-upload. Success means a file exists in the user's Drive. */
export function driveTestUpload(
  signal?: AbortSignal,
): Promise<DriveTestUploadResponse> {
  return apiFetch<DriveTestUploadResponse>('/destinations/drive/test-upload', {
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
}

/**
 * Response from the backend proxy after forwarding a chunk's bytes to
 * Google Drive.
 *
 *   remote_reference: the Drive file_id to persist on the chunks row.
 *   dedup:            'db'    — a chunks row already existed with this
 *                               hash + remote_reference; no Drive call.
 *                     'drive' — same deterministic filename already in
 *                               Drive; no upload, existing id reused.
 *                     null    — fresh upload; bytes were forwarded to
 *                               Drive just now.
 */
export interface DriveChunkUploadResponse {
  remote_reference: string;
  dedup: 'db' | 'drive' | null;
}

/**
 * Decode a base64 string into a Uint8Array.
 *
 * We decode client-side because the backend expects the raw binary
 * content (application/octet-stream) — sending the base64 string itself
 * would double the payload and force the backend to decode + re-hash,
 * which defeats the integrity guardrail (it MUST recompute sha256 over
 * the same bytes the caller hashed).
 *
 * `atob` is available globally in Expo SDK 50+ (Hermes runtime). We do
 * NOT depend on a Buffer polyfill for this reason — fewer moving parts
 * in the hot path.
 */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * POST /destinations/drive/chunks — send one chunk's bytes to the
 * backend proxy, which forwards to Google Drive and returns the file_id
 * to use as `remote_reference` on the subsequent POST /chunks.
 *
 * Why not `apiFetch`: apiFetch is JSON-only. The proxy speaks
 * application/octet-stream and expects the body to be the raw bytes
 * whose sha256 equals the `hash` argument. The backend recomputes
 * sha256 server-side and rejects on mismatch (HASH_MISMATCH).
 *
 * Arguments:
 *   sessionId    — uuid of the active session the chunk belongs to.
 *   chunkIndex   — 0-based index within that session.
 *   hash         — lowercase hex sha256 of the decoded bytes. MUST be
 *                  the same hash the client will pass to /chunks, so
 *                  both rows agree on the identity of the chunk. This
 *                  is the single source of truth for chunk identity —
 *                  `deriveChunksFromFile` hashes the decoded bytes too,
 *                  so PENDING_RETRY_KEY, /chunks, and X-Hash all
 *                  carry the same value.
 *   base64Slice  — the chunk's content as base64 (the form the client
 *                  already has, from FileSystem.readAsStringAsync).
 *
 * Returns { remote_reference, dedup } on success.
 *
 * Throws ApiError for any failure, matching the rest of this module.
 */
export async function uploadChunkBytes(
  sessionId: string,
  chunkIndex: number,
  hash: string,
  base64Slice: string,
  timeoutMs = 30_000,
): Promise<DriveChunkUploadResponse> {
  // Same reasoning as apiFetch: read the latest token from supabase-js
  // so an expired snapshot in the Zustand store doesn't send us into a
  // 401. supabase-js will refresh inline if the persisted access token
  // has expired.
  const token = await getFreshAccessToken();
  if (!token) {
    throw new ApiError(401, 'NO_TOKEN', 'No access token in store', null);
  }

  const bytes = base64ToBytes(base64Slice);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${env.apiUrl}/destinations/drive/chunks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': sessionId,
        'X-Chunk-Index': String(chunkIndex),
        'X-Hash': hash,
      },
      body: bytes,
      signal: controller.signal,
    });
  } catch (e) {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      e instanceof Error ? e.message : 'Network request failed',
      null,
    );
  } finally {
    clearTimeout(timer);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const parsed: unknown = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : null;

  if (!response.ok) {
    const errBody = (parsed as { error?: { code?: string; message?: string } }) ?? {};
    throw new ApiError(
      response.status,
      errBody.error?.code,
      errBody.error?.message ?? `HTTP ${response.status}`,
      parsed,
    );
  }

  return parsed as DriveChunkUploadResponse;
}
