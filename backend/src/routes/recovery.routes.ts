/**
 * GET /recovery/manifests
 *
 * Cross-device discovery endpoint. Lists session manifests this app
 * uploaded to the authenticated user's Google Drive and returns a
 * UI-friendly projection. Reconstruction / export from manifest is a
 * separate concern (COMMIT 3).
 *
 * Middleware chain:
 *   authMiddleware       — populates req.user from JWT
 *   userRateLimiter(10)  — bounded; discovery is on-demand, not a hot path
 *   handler              — delegates to `listDriveManifests`
 *
 * Failure shape:
 *   The endpoint NEVER returns 4xx/5xx for "Drive not connected" — the
 *   service surfaces that as `drive_not_connected: true` so the mobile
 *   UI can render a guided empty state instead of an error toast.
 *
 * Isolation: zero coupling to GC_QUEUE, the upload worker, chunking,
 * recovery, export, background service, AudioEngine, sessions/chunks
 * services, or anything mobile-side.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';

import { UnauthorizedError } from '../errors/AppError.js';
import { authMiddleware } from '../middleware/auth.js';
import { userRateLimiter } from '../middleware/rateLimit.js';
import { listDriveManifests } from '../services/recovery.service.js';

const router = Router();

router.get(
  '/manifests',
  authMiddleware,
  userRateLimiter(10),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new UnauthorizedError();
      const result = await listDriveManifests(req.user.id);
      res.status(200).json(result);
    } catch (err) {
      // `listDriveManifests` is documented as never-throwing, but the
      // route stays defensive: any unexpected throw goes through the
      // standard error pipeline (uniform error shape, no leak of
      // service-layer internals to the client).
      next(err);
    }
  },
);

export { router as recoveryRouter };
