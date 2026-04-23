/**
 * POST /chunks
 *
 * Registers chunk metadata for a session owned by the authenticated user.
 *
 * Middleware chain (order matters):
 *   authMiddleware         → populates req.user from JWT
 *   userRateLimiter(600)   → 600 req/min per user_id (per rateLimit.ts).
 *                             Sized for real multi-chunk uploads: at 16 KB
 *                             chunks a 1-minute HIGH_QUALITY recording can
 *                             produce ~60+ chunks, and Phase 1 + Phase 2
 *                             recovery in the same minute window stack on
 *                             top. 600/min = 10/s per user is still a sane
 *                             abuse ceiling.
 *   validateBody(schema)   → zod enforces request shape
 *   handler                → calls the service, returns 201 (create) or 200
 *                             (idempotent replay / valid state transition)
 *
 * `user_id` is taken from the JWT, never from the body.
 *
 * See `services/chunks.service.ts` for the full idempotency and state
 * transition rules.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { AppError } from '../errors/AppError.js';
import { authMiddleware } from '../middleware/auth.js';
import { userRateLimiter } from '../middleware/rateLimit.js';
import { registerChunk } from '../services/chunks.service.js';

const router = Router();

const chunkBodySchema = z.object({
  session_id: z.string().uuid(),
  chunk_index: z.number().int().min(0),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(20 * 1024 * 1024),
  status: z.enum(['pending', 'uploaded', 'failed']),
  remote_reference: z.string().nullable().optional(),
});

router.post(
  '/',
  authMiddleware,
  userRateLimiter(600),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.id) {
        throw new AppError(401, 'UNAUTHORIZED', 'Missing authenticated user');
      }

      const parsed = chunkBodySchema.safeParse(req.body);

      if (!parsed.success) {
        throw new AppError(400, 'INVALID_BODY', 'Invalid request body');
      }

      const result = await registerChunk(req.user.id, parsed.data);

      const statusCode = result.idempotent_replay ? 200 : 201;

      res.status(statusCode).json({
        chunk_id: result.id,
        session_id: result.session_id,
        chunk_index: result.chunk_index,
        status: result.status,
        hash: result.hash,
        size: result.size,
        remote_reference: result.remote_reference,
        created_at: result.created_at,
        updated_at: result.updated_at,
        idempotent_replay: result.idempotent_replay ?? false,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;