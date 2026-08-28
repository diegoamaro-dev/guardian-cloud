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

/**
 * Mirrors `CompactRecoverableSession` in
 * `backend/src/services/recovery.service.ts`. Kept as a manual copy (no
 * shared types package) on purpose — the boundary between mobile and
 * backend stays explicit, and a future schema change forces a deliberate
 * edit on both sides.
 *
 * This app asks for `?view=compact` (see below), so it receives the
 * metadata-only shape: no medium, no chunk count, no completion time, no
 * protection status. Those live inside the manifest, which discovery
 * never reads — `getRecoveryManifest` fetches and validates it when the
 * user opens a session.
 *
 * A row means: "a manifest file exists for this session, last written at
 * `reference_date`." Nothing more, because nothing more was read.
 */
export interface RecoverableSession {
  session_id: string;
  /**
   * Drive file_id of the manifest. Opaque to the UI — a tap passes it to
   * `getRecoveryManifest`, so the detail addresses exactly the file
   * discovery saw, with no re-list race.
   */
  manifest_file_id: string;
  /**
   * When the manifest was last written, from Drive's `modifiedTime`.
   *
   * A REFERENCE date. It is NOT `completed_at` and must not be rendered
   * as one: for a session still recording it is the last incremental
   * write.
   */
  reference_date: string;
}

export interface DiscoveryResponse {
  drive_not_connected: boolean;
  manifests: RecoverableSession[];
}

/**
 * One-shot fetch of the recoverable-sessions list.
 *
 * Asks for `?view=compact` EXPLICITLY. Without it the endpoint returns
 * its historical shape, which is downloaded and parsed manifest by
 * manifest — the listing that stopped loading at ~10 s once the folder
 * grew past a dozen files (GC-RECOVERY-MANIFEST-LIST-LATENCY-001). The
 * parameter is opt-in precisely so APKs already in the field keep
 * receiving the shape they were written against.
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
  return apiFetch<DiscoveryResponse>('/recovery/manifests?view=compact', {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}
