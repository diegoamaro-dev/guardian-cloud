/**
 * GET /health
 *
 * Unauthenticated. Returns a minimal status payload for orchestrators
 * and for the mobile client to know whether the backend is up before
 * starting a session.
 *
 * Phase 1: only reports process liveness + uptime + version.
 * Phase 2+ will add a real DB reachability check against Supabase.
 */

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';

const router = Router();

// Basic IP-based protection. Generous so orchestrator probes never throttle.
const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120, // 2 req/s per IP, enough for any sane healthcheck cadence
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const startedAt = Date.now();

// Read version at boot to avoid reading package.json on every request.
// Defaults to '0.0.0' if env doesn't inject it.
const version = process.env.npm_package_version ?? '0.0.0';

router.get('/', healthLimiter, (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    version,
  });
});

export { router as healthRouter };
