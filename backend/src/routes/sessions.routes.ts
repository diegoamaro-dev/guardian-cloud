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
import {
  downloadFileBytes,
  getAccessToken,
} from '../services/drive.service.js';
import { supabase } from '../config/supabase.js';
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

/**
 * GET /sessions/:id/chunks/:index/download
 *
 * Proxy read-only download of a single chunk's raw bytes from the user's
 * Google Drive. Used by the export-evidence flow in the mobile client,
 * which cannot call Drive directly (refresh_token stays on the backend).
 *
 * Ownership (strict — no leakage of other users' data):
 *   1. `getOwnedSession(userId, sessionId)` → throws 404 if the session
 *      does not exist OR does not belong to the caller. "Not yours" and
 *      "not found" are deliberately collapsed.
 *   2. The chunks row lookup is keyed by (session_id, chunk_index).
 *      Because step 1 already proved the session belongs to the caller,
 *      any chunk row under that session is owned by them by construction.
 *
 * Preconditions for a successful download:
 *   - chunk row exists                 → else 404 CHUNK_NOT_FOUND
 *   - chunk.status === 'uploaded'      → else 409 CHUNK_NOT_READY
 *   - chunk.remote_reference != null   → else 409 CHUNK_NO_REMOTE_REFERENCE
 *   - user has a connected Drive dest  → else 409 DRIVE_NOT_CONNECTED
 *
 * Response: 200 application/octet-stream with the Drive file bytes.
 *   Header `X-Chunk-Hash` carries the DB-recorded sha256 so the client
 *   can verify integrity locally without a second round-trip.
 *
 * Intentionally does NOT modify any row — read-only path.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(
  '/:id/chunks/:index/download',
  authMiddleware,
  userRateLimiter(60),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();

      const sessionId = (req.params.id ?? '').trim();
      const indexRaw = (req.params.index ?? '').trim();

      if (!UUID_RE.test(sessionId)) {
        throw new AppError(400, 'INVALID_SESSION_ID', 'Invalid session id');
      }
      const chunkIndex = Number.parseInt(indexRaw, 10);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        throw new AppError(400, 'INVALID_CHUNK_INDEX', 'Invalid chunk index');
      }

      // Strict ownership gate — throws 404 SESSION_NOT_FOUND if the
      // session is missing OR belongs to someone else. Must run BEFORE
      // any chunks.select so we never confirm existence of a chunk under
      // a foreign session.
      await getOwnedSession(req.user.id, sessionId);

      const { data, error } = await supabase
        .from('chunks')
        .select('chunk_index, hash, status, remote_reference')
        .eq('session_id', sessionId)
        .eq('chunk_index', chunkIndex)
        .maybeSingle();

      if (error) {
        logger.error(
          {
            op: 'chunks.download.lookup',
            sessionId,
            chunkIndex,
            supabase_error: {
              code: error.code,
              message: error.message,
              details: error.details,
              hint: error.hint,
            },
          },
          'chunks.select for download failed',
        );
        throw new AppError(500, 'CHUNK_LOOKUP_FAILED', 'Failed to lookup chunk');
      }
      if (!data) {
        throw new AppError(404, 'CHUNK_NOT_FOUND', 'Chunk not found');
      }
      const row = data as {
        chunk_index: number;
        hash: string;
        status: 'pending' | 'uploaded' | 'failed';
        remote_reference: string | null;
      };

      if (row.status !== 'uploaded') {
        throw new AppError(409, 'CHUNK_NOT_READY', 'Chunk is not uploaded');
      }
      if (!row.remote_reference) {
        throw new AppError(
          409,
          'CHUNK_NO_REMOTE_REFERENCE',
          'Chunk has no remote_reference in storage',
        );
      }

      const dest = await getDestinationWithSecretForUser(req.user.id, 'drive');
      if (!dest || !dest.refresh_token) {
        throw new AppError(
          409,
          'DRIVE_NOT_CONNECTED',
          'No connected Google Drive destination for this user',
        );
      }

      const accessToken = await getAccessToken(dest.refresh_token);
      const bytes = await downloadFileBytes(accessToken, row.remote_reference);

      logger.info(
        {
          op: 'chunks.download',
          sessionId,
          chunkIndex,
          size: bytes.length,
        },
        'chunk downloaded from Drive',
      );

      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('X-Chunk-Hash', row.hash);
      res.send(bytes);
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