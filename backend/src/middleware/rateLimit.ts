/**
 * Per-user rate limiter.
 *
 * MUST be installed AFTER `authMiddleware` so `req.user.id` is populated.
 * Falls back to IP if for some reason the user is missing, but that path
 * should not be reachable behind `authMiddleware`.
 *
 * Phase 1 limits (confirmed):
 *   - POST /sessions                : 10 req/min per user
 *   - POST /chunks                  : 600 req/min per user
 *   - POST /sessions/:id/complete   : 10 req/min per user  (next brick)
 */

import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

export function userRateLimiter(maxPerMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    max: maxPerMinute,

    standardHeaders: true,
    legacyHeaders: false,

    keyGenerator: (req) => req.user?.id ?? req.ip,

    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later.',
        },
      });
    },
  });
}
