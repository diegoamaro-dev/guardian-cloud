/**
 * Express application assembly.
 *
 * Kept separate from `index.ts` so it can be imported by tests (supertest)
 * without opening a network port.
 *
 * Middleware order (matters):
 *   1. helmet       — security headers
 *   2. cors         — controlled origins (locked down later)
 *   3. json         — body parser with a hard size cap
 *   4. pinoHttp     — structured request logging
 *   5. routes       — /health       (public)
 *                     /sessions     (auth + per-user rate limit)
 *                     /chunks       (auth + per-user rate limit)
 *                     /destinations (auth + per-user rate limit)
 *   6. 404 fallback — uniform "not found" response
 *   7. errorHandler — LAST. Converts anything thrown into our error shape.
 */

import { randomUUID } from 'node:crypto';
import cors from 'cors';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { errorHandler } from './middleware/errorHandler.js';
import chunksRoutes from './routes/chunks.routes.js';
import { destinationsRouter, oauthCallbackRouter } from './routes/destinations.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { sessionsRouter } from './routes/sessions.routes.js';
import { logger } from './utils/logger.js';

// Merge-augment Request with a correlation id populated by the very first
// middleware. This lets every downstream log line be grouped by request.
declare module 'express-serve-static-core' {
  interface Request {
    reqId?: string;
  }
}

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // required for correct IP behind reverse proxy

  // --- DIAG: request-id + entry log. MUST be the first middleware so we
  // see every request regardless of what fails downstream. Log shape is
  // stable so we can grep for REQ_INCOMING / REQ_HEADERS in the terminal.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const reqId = randomUUID();
    req.reqId = reqId;
    logger.info(
      { reqId, method: req.method, url: req.url, remote: req.ip },
      'REQ_INCOMING',
    );
    logger.info(
      {
        reqId,
        headers: {
          host: req.header('host'),
          'content-type': req.header('content-type'),
          'content-length': req.header('content-length'),
          'user-agent': req.header('user-agent'),
          authorization_present: Boolean(req.header('authorization')),
        },
      },
      'REQ_HEADERS',
    );
    next();
  });

  app.use(helmet());
  app.use(cors()); // TODO Phase 3: restrict origins
  app.use(express.json({ limit: '64kb' })); // chunk metadata is small; cap tight

  app.use(
    pinoHttp({
      logger,
      // Keep per-request logs minimal and free of sensitive data.
      serializers: {
        req(req: IncomingMessage) {
          return { method: req.method, url: req.url };
        },
        res(res: ServerResponse) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );

  // --- DEBUG ONLY: unauthenticated ping used to prove emulator → backend
  // reachability without exercising auth / Supabase / body validation.
  // If this does NOT respond from the emulator, the problem is purely
  // network-level (bind host, firewall, cleartext, or wrong URL in the
  // Metro bundle). Remove this route once connectivity is confirmed.
  app.get('/debug-ping', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // Public routes
  app.use('/health', healthRouter);

  // Authenticated routes (auth + rate-limit are applied inside each router)
  app.use('/sessions', sessionsRouter);
  app.use('/chunks', chunksRoutes);
  app.use('/destinations', destinationsRouter);

  // Google's registered redirect_uri is `/auth/drive/callback` at the
  // ROOT of the backend (see GOOGLE_REDIRECT_URI in backend/.env). The
  // handler itself lives in destinations.routes.ts next to /drive/connect
  // so all OAuth-related code stays co-located; it's just mounted here.
  // NO auth middleware: Google's user-agent cannot present a JWT.
  app.use('/', oauthCallbackRouter);

  // 404 fallback
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  // MUST be last
  app.use(errorHandler);

  return app;
}
