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
import { listChunksForSession } from '../services/chunks.service.js';
import {
  shouldEmitIncrementalManifest,
  tryGenerateIncrementalManifest,
} from '../services/manifest.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

const chunkBodySchema = z.object({
  session_id: z.string().uuid(),
  chunk_index: z.number().int().min(0),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(20 * 1024 * 1024),
  status: z.enum(['pending', 'uploaded', 'failed']),
  remote_reference: z.string().nullable().optional(),
  /**
   * G3'' — medium of THIS chunk's bytes.
   *
   * Optional so a client that predates the field keeps registering
   * chunks unchanged; absence persists as NULL and means "not
   * declared", never "video". The v2 manifest writer refuses to build a
   * document from a chunk whose medium is unknown rather than guessing
   * one from the session.
   */
  media: z.enum(['video', 'audio']).optional(),
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

      // Fire-and-forget incremental manifest write. Triggered ONLY when:
      //   - this was a fresh state transition (not an idempotent replay)
      //   - the chunk's new status is 'uploaded'
      //   - the resulting uploaded-chunks count matches the threshold
      //     (first chunk, then every 10 — see shouldEmitIncrementalManifest)
      //
      // The work is scheduled AFTER `res.status(...).json(...)` so the
      // response is sent before any Drive I/O begins. Errors inside the
      // async block are logged but never surfaced to the client and
      // never affect the chunk-upload's response shape. The chunk hot
      // path is therefore byte-identical to the pre-incremental-manifest
      // behaviour from the caller's point of view.
      //
      // Throughput impact: cost happens out-of-band on the server. No
      // Express middleware is blocked; no client-visible latency. The
      // Drive API quota used is documented in `manifest.service.ts`
      // (~5-6 calls per typical 5 MB video session, 1 findFileByName
      // + 1 PATCH/POST per call).
      if (!result.idempotent_replay && result.status === 'uploaded') {
        const userId = req.user.id;
        const sessionId = result.session_id;
        // setImmediate so the work runs on the next event-loop tick,
        // AFTER any in-progress response flush. `void` keeps the linter
        // happy about the unhandled-promise nature of fire-and-forget.
        setImmediate(() => {
          void (async () => {
            try {
              // Count uploaded chunks for this session. We use the
              // existing `listChunksForSession` rather than a SQL
              // COUNT(*) to keep the change additive — no new repository
              // method, no schema mutation. The N+1 cost is bounded by
              // the trigger frequency (this only runs after a real
              // state transition, ~6 times per session) and the chunk
              // list is small (40 for a 5 MB video, 450 for an audio).
              const chunks = await listChunksForSession(userId, sessionId);
              const uploadedCount = chunks.filter(
                (c) => c.status === 'uploaded' && !!c.remote_reference,
              ).length;

              if (!shouldEmitIncrementalManifest(uploadedCount)) {
                return;
              }

              logger.info(
                {
                  op: 'manifest.generate_incremental',
                  sessionId,
                  uploaded_count: uploadedCount,
                  triggered_by_chunk_index: result.chunk_index,
                },
                'GC_INCREMENTAL_MANIFEST_TRIGGERED',
              );

              await tryGenerateIncrementalManifest(userId, sessionId);
            } catch (err) {
              logger.warn(
                {
                  op: 'manifest.generate_incremental',
                  sessionId,
                  err: err instanceof Error ? err.message : String(err),
                },
                'GC_INCREMENTAL_MANIFEST_HOOK_FAILED',
              );
            }
          })();
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

export default router;