/**
 * /recovery client.
 *
 * COMMIT 2 — discovery only. Calls `GET /recovery/manifests` once, returns
 * a normalized list to the UI. Reconstruction / export from manifest is
 * COMMIT 3.
 *
 * Strict isolation:
 *   - thin wrapper around `apiFetch`; no retries, no caching, no Drive
 *     primitives, no OAuth handling
 *   - no Drive imports, no googleapis, no Google scope checks — every
 *     piece of Drive logic lives behind the backend endpoint
 *   - the screen that consumes this MUST NOT add any client-side Drive
 *     fallback path: that would put Drive credentials on the device and
 *     defeat the proxy model
 *   - does NOT touch GC_QUEUE, the upload worker, chunking, recovery,
 *     export, background service, AudioEngine, or any mobile state outside
 *     its own component tree
 */

import { apiFetch } from './client';

export type ProtectionStatus = 'complete' | 'partial';
export type RecoverableMode = 'audio' | 'video';

/**
 * Mirrors `RecoverableSession` in `backend/src/services/recovery.service.ts`.
 * Kept as a manual copy (no shared types package) on purpose — the
 * boundary between mobile and backend stays explicit, and a future
 * schema change forces a deliberate edit on both sides.
 */
export interface RecoverableSession {
  session_id: string;
  mode: RecoverableMode;
  created_at: string;
  completed_at: string;
  chunk_count: number;
  protection_status: ProtectionStatus;
  /**
   * Drive file_id of the manifest. Opaque to the UI — kept for COMMIT 3
   * so a tap on "Recuperar" can deterministically address the manifest
   * that was vetted at discovery time, with no re-list race.
   */
  manifest_file_id: string;
}

export interface DiscoveryResponse {
  drive_not_connected: boolean;
  manifests: RecoverableSession[];
}

/**
 * One-shot fetch of the recoverable-sessions list.
 *
 * Returns `{ drive_not_connected: true, manifests: [] }` (NOT an error)
 * when the user has not connected Drive on this account — the screen
 * renders a guided empty state in that case.
 *
 * Throws `ApiError` only for network / 5xx / non-200 — the UI surfaces
 * those as a retry-able error block.
 */
export function getRecoverableManifests(
  signal?: AbortSignal,
): Promise<DiscoveryResponse> {
  return apiFetch<DiscoveryResponse>('/recovery/manifests', {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}
