/**
 * POST /sessions
 *
 * Creates a recording session for the authenticated user.
 *
 * Middleware chain (order matters):
 *   authMiddleware         → populates req.user from JWT
 *   userRateLimiter(10)    → 10 req/min per user_id
 *   validateBody(schema)   → zod schema enforces request shape
 *   handler                → calls the service, shapes the response
 *
 * `user_id` is taken from the JWT, never from the body.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { UnauthorizedError } from '../errors/AppError.js';
import { authMiddleware } from '../middleware/auth.js';
import { userRateLimiter } from '../middleware/rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import {
  createSessionSchema,
  type CreateSessionInput,
} from '../schemas/sessions.schema.js';
import {
  createSession,
  completeSession,
  getOwnedSession,
} from '../services/sessions.service.js';
import { listChunksForSession } from '../services/chunks.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.post(
  '/',
  authMiddleware,
  userRateLimiter(10),
  validateBody(createSessionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    const reqId = req.reqId;
    try {
      if (!req.user) throw new UnauthorizedError();

      logger.info({ reqId, userId: req.user.id }, 'REQ_HANDLER_START');
      const input = req.body as CreateSessionInput;
      const session = await createSession(req.user.id, input, reqId);

      res.status(201).json({
        session_id: session.id,
        status: session.status,
        mode: session.mode,
        destination_type: session.destination_type,
        created_at: session.created_at,
      });
      logger.info(
        { reqId, session_id: session.id, status: 201 },
        'REQ_RESPONSE_SENT',
      );
    } catch (err) {
      logger.error(
        { reqId, err: err instanceof Error ? err.message : String(err) },
        'REQ_HANDLER_ERROR',
      );
      next(err);
    }
  },
);

router.get(
  '/:id',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = req.params.id as string;
      const session = await getOwnedSession(req.user.id, sessionId);

      res.status(200).json({
        session_id: session.id,
        status: session.status,
        mode: session.mode,
        destination_type: session.destination_type,
        chunk_count: session.chunk_count,
        created_at: session.created_at,
        completed_at: session.completed_at,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:id/chunks',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = req.params.id as string;
      const chunks = await listChunksForSession(req.user.id, sessionId);

      res.status(200).json({ chunks });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/complete',
  authMiddleware,
  userRateLimiter(10),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = req.params.id as string;

const result = await completeSession(req.user.id, sessionId);

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as sessionsRouter };