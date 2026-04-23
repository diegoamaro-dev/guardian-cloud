/**
 * Request/response schemas for /sessions.
 *
 * Defined once with zod so runtime validation, TypeScript types, and the
 * contract documentation stay in sync.
 */

import { z } from 'zod';

export const createSessionSchema = z.object({
  mode: z.enum(['audio', 'video']),
  destination_type: z.enum(['drive', 'nas', 'none']),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
