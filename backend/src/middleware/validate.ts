/**
 * Body validation middleware.
 *
 * Runs a zod schema against `req.body`. On success, the parsed (and
 * coerced/trimmed) value replaces `req.body`. On failure, raises 400
 * INVALID_BODY with a short path+message describing the first issue.
 *
 * Keep error messages terse and free of the actual rejected value — the
 * value may contain user data we don't want to echo back in logs.
 */

import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { InvalidBodyError } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const reqId = req.reqId;
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      const msg = first
        ? `${first.path.join('.') || 'body'}: ${first.message}`
        : 'Invalid body';
      logger.warn({ reqId, reason: msg }, 'REQ_BODY_FAIL');
      return next(new InvalidBodyError(msg));
    }
    req.body = result.data;
    logger.info({ reqId }, 'REQ_BODY_OK');
    return next();
  };
}
