/**
 * Domain error base class.
 *
 * All errors raised deliberately by the app extend this class. Unknown errors
 * are treated as 500 INTERNAL_ERROR by the error handler.
 *
 * `code` is a stable string constant (UPPER_SNAKE) used by clients to branch
 * on the error type.
 */
export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid credentials') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class InvalidBodyError extends AppError {
  constructor(message: string) {
    super(400, 'INVALID_BODY', message);
    this.name = 'InvalidBodyError';
  }
}
