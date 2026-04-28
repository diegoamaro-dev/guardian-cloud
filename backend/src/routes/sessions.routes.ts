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
import { AppError, UnauthorizedError } from '../errors/AppError.js';
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
import { getDestinationWithSecretForUser } from '../services/destinations.service.js';
import { downloadFile, getAccessToken } from '../services/drive.service.js';
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

/**
 * GET /sessions/:id/chunks/:index/download
 *
 * Streams the bytes of a single uploaded chunk back to the caller. This
 * is the read-side counterpart of the upload pipeline (POST
 * /destinations/drive/chunks): the client never gets a Drive access
 * token, the backend proxies the download.
 *
 * Steps:
 *   1. Ownership: `listChunksForSession` already enforces it (collapsed
 *      404 if the session does not belong to the caller).
 *   2. Look up the chunk row by chunk_index in the returned list.
 *      Reusing the existing service avoids touching chunks.service.ts.
 *   3. Require status='uploaded' AND a non-null remote_reference. Any
 *      other state means the bytes were never persisted to Drive.
 *   4. Resolve the user's Drive destination + mint a fresh access_token
 *      via `getAccessToken(refresh_token)` (refresh handled inside).
 *   5. `downloadFile` fetches the bytes from Drive.
 *   6. Stream raw bytes back with Content-Type=application/octet-stream
 *      and X-Chunk-Hash so the client can verify sha256 locally.
 *
 * The response shape matches what the export client in
 * mobile/src/api/export.ts already expects (see `downloadChunk` there).
 * No content negotiation, no JSON envelope.
 */
router.get(
  '/:id/chunks/:index/download',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = req.params.id as string;
      const indexRaw = req.params.index as string;
      const chunkIndex = Number.parseInt(indexRaw, 10);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        throw new AppError(400, 'INVALID_CHUNK_INDEX', 'Invalid chunk index');
      }

      // Ownership + chunk metadata in one call. `listChunksForSession`
      // throws 404 SESSION_NOT_FOUND on either "not yours" or "doesn't
      // exist" — same collapsed semantics as the rest of the API.
      const chunks = await listChunksForSession(req.user.id, sessionId);
      const chunk = chunks.find((c) => c.chunk_index === chunkIndex);
      if (!chunk) {
        throw new AppError(404, 'CHUNK_NOT_FOUND', 'Chunk not found');
      }
      if (chunk.status !== 'uploaded' || !chunk.remote_reference) {
        throw new AppError(
          409,
          'CHUNK_NOT_UPLOADED',
          'Chunk is not in uploaded state or has no remote reference',
        );
      }

      // Drive handshake. Mirrors the upload route — same source of truth
      // for the destination, same refresh flow.
      const dest = await getDestinationWithSecretForUser(req.user.id, 'drive');
      if (!dest || !dest.refresh_token) {
        throw new AppError(
          409,
          'DRIVE_NOT_CONNECTED',
          'No connected Google Drive destination for this user',
        );
      }
      const accessToken = await getAccessToken(dest.refresh_token);

      const bytes = await downloadFile(accessToken, chunk.remote_reference);

      logger.info(
        {
          op: 'sessions.chunks.download',
          session_id: sessionId,
          chunk_index: chunkIndex,
          size: bytes.length,
        },
        'chunk download served',
      );

      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Chunk-Hash', chunk.hash);
      res.setHeader('Content-Length', bytes.length.toString());
      res.end(bytes);
    } catch (err) {
      next(err);
    }
  },
);

export { router as sessionsRouter };