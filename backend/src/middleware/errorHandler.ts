/**
 * Centralized error handler.
 *
 * Converts any thrown error into the project's uniform response shape:
 *   { "error": { "code": "STRING_CONSTANT", "message": "human-readable" } }
 *
 * - `AppError` subclasses are emitted with their own `status` and `code`.
 * - Everything else is logged at `error` level and returned as 500.
 *
 * This must be registered as the LAST middleware in the app.
 */

import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {

  // ✅ CASO CONTROLADO (LO IMPORTANTE)
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  // ❌ ERROR REAL (LOG)
  logger.error(
    {
      err,
      path: req.path,
      method: req.method,
    },
    'Unhandled error',
  );

  // ❌ RESPUESTA GENÉRICA
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
}