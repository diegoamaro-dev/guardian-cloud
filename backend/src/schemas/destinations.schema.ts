/**
 * Request schemas for /destinations.
 *
 * Defined with zod so runtime validation and TS types stay in sync.
 *
 * Two-step OAuth flow for Drive:
 *   1. Client POSTs `{ action: 'start' }` — backend returns a Google
 *      authorisation URL.
 *   2. Client opens that URL in a browser. User grants access. Google
 *      redirects to `guardiancloud://oauth/drive?code=...`.
 *   3. Client POSTs `{ action: 'exchange', code }` — backend swaps the
 *      code for tokens, creates the root folder, persists the row.
 *
 * `state` is an opaque CSRF nonce the client MAY echo back on exchange
 * (optional for MVP; we don't enforce it server-side yet).
 */

import { z } from 'zod';

export const driveConnectStartSchema = z.object({
  action: z.literal('start'),
  // Optional: override default redirect URI (e.g. for testing on web).
  redirect_uri: z.string().url().optional(),
  state: z.string().max(128).optional(),
});

export const driveConnectExchangeSchema = z.object({
  action: z.literal('exchange'),
  code: z.string().min(1).max(2048),
  redirect_uri: z.string().url().optional(),
  state: z.string().max(128).optional(),
});

export const driveConnectSchema = z.discriminatedUnion('action', [
  driveConnectStartSchema,
  driveConnectExchangeSchema,
]);

export type DriveConnectInput = z.infer<typeof driveConnectSchema>;

/**
 * Generic destination save (POST /destinations).
 *
 * Phase 1 only supports `type: 'drive'`. We keep the shape generic so
 * the NAS/S3 work later in the roadmap slots in without a migration.
 * `config` is an opaque JSON blob from the client's point of view.
 */
export const upsertDestinationSchema = z.object({
  type: z.literal('drive'),
  // Forward-compatible bag. Ignored today; the OAuth flow is the
  // authoritative path to store tokens. Present so the endpoint is
  // usable from a client that wants to, say, rename the folder later.
  config: z
    .object({
      folder_id: z.string().min(1).max(256).optional(),
      account_email: z.string().email().max(320).optional(),
    })
    .optional(),
});

export type UpsertDestinationInput = z.infer<typeof upsertDestinationSchema>;
