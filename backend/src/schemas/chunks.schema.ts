/**
 * Request schema for POST /chunks.
 *
 * Defined with zod so runtime validation and TypeScript types stay in sync.
 *
 * Contract (Phase 1, metadata-only):
 *   - `hash`: sha256 hex, lowercase, exactly 64 characters.
 *   - `size`: hard-capped at 20 MiB to match the DB CHECK constraint and
 *     env.MAX_CHUNK_SIZE_BYTES default.
 *   - `status`: client-reported state of the chunk at the destination.
 *   - `remote_reference`: opaque pointer to the destination artifact
 *     (e.g. Drive file id). Nullable because on first registration the
 *     client may not know it yet.
 */

import { z } from 'zod';

/** 20 MiB — matches 0002_init_chunks.sql and README. */
export const MAX_CHUNK_SIZE_BYTES = 20 * 1024 * 1024;

export const createChunkSchema = z.object({
  session_id: z.string().uuid(),
  chunk_index: z.number().int().nonnegative(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'must be lowercase sha256 hex (64 chars)'),
  size: z.number().int().positive().max(MAX_CHUNK_SIZE_BYTES),
  status: z.enum(['pending', 'uploaded', 'failed']),
  remote_reference: z.string().min(1).max(512).nullable().optional(),
});

export type CreateChunkInput = z.infer<typeof createChunkSchema>;
