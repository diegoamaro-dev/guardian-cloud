/**
 * Minimal structured logger (pino).
 *
 * Policy:
 *   - Structured JSON logs in production.
 *   - Human-readable in development (pino-pretty optional, not bundled).
 *   - Never log JWTs, service keys, chunk hashes, or request bodies.
 */

import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'guardian-cloud-backend',
    env: env.NODE_ENV,
  },
  redact: {
    // Defense-in-depth: redact keys if they ever leak into a log payload.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.access_token',
      '*.refresh_token',
      '*.service_role_key',
      '*.jwt_secret',
    ],
    remove: true,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
