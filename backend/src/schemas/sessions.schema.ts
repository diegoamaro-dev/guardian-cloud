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
  // Optional client-provided session id. Lets the mobile app start a
  // recording offline (where POST /sessions cannot reach us) using a
  // locally-generated UUID, then register the same id with the backend
  // when the network returns. The handler is idempotent: re-posting the
  // same id+user_id returns the existing row instead of erroring.
  id: z.string().uuid().optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
