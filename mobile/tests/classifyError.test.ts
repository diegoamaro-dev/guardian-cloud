/**
 * Tests for `classifyError` — the single decision point that the
 * upload worker uses to decide whether a chunk failure should retry
 * (transient) or be marked terminal (permanent).
 *
 * Critical guarantee: anything classified `permanent` causes the
 * worker to drop `base64Slice` and lose the bytes. Anything misclassified
 * as permanent loses evidence. So the precedence rules really do matter.
 */

import { describe, it, expect } from 'vitest';
import { classifyError, shapeError } from '../app/index';
import { ApiError } from '@/api/client';

describe('classifyError — transient vs permanent', () => {
  describe('transient', () => {
    it('NETWORK_ERROR (status=0) is transient', () => {
      expect(
        classifyError(new ApiError(0, 'NETWORK_ERROR', 'Network failed', null)),
      ).toBe('transient');
    });

    it('401 / NO_TOKEN is transient (auth refresh covers it)', () => {
      expect(
        classifyError(new ApiError(401, 'NO_TOKEN', 'no token', null)),
      ).toBe('transient');
      expect(classifyError(new ApiError(401, undefined, '401', null))).toBe(
        'transient',
      );
    });

    it('408 (request timeout) and 429 (rate limit) are transient', () => {
      expect(classifyError(new ApiError(408, undefined, '408', null))).toBe(
        'transient',
      );
      expect(classifyError(new ApiError(429, undefined, '429', null))).toBe(
        'transient',
      );
    });

    it('5xx server errors are transient', () => {
      for (const status of [500, 502, 503, 504]) {
        expect(classifyError(new ApiError(status, undefined, 'x', null))).toBe(
          'transient',
        );
      }
    });

    it('SESSION_NOT_FOUND (404 with code) is transient — offline-first guarantee', () => {
      // Critical: chunks emitted under a locally-generated session id
      // hit 404 SESSION_NOT_FOUND until the bootstrap loop re-registers
      // the session remotely. Marking these permanent would lose
      // evidence we already have on disk.
      expect(
        classifyError(
          new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found', null),
        ),
      ).toBe('transient');
    });

    it('non-ApiError throws default to transient', () => {
      expect(classifyError(new Error('something weird'))).toBe('transient');
      expect(classifyError(new Error('CHUNK_UPLOAD_TIMEOUT'))).toBe(
        'transient',
      );
      expect(classifyError('plain string')).toBe('transient');
    });

    it('non-ApiError carrying HTTP 5xx in message is transient', () => {
      expect(classifyError(new Error('POST /sessions HTTP 503 boom'))).toBe(
        'transient',
      );
    });

    it('non-ApiError carrying HTTP 408 / 429 in message is transient', () => {
      expect(classifyError(new Error('HTTP 408 timeout'))).toBe('transient');
      expect(classifyError(new Error('HTTP 429 throttled'))).toBe('transient');
    });
  });

  describe('permanent', () => {
    it('400 / 403 / 409 / 422 are permanent (client error)', () => {
      for (const status of [400, 403, 409, 422]) {
        expect(classifyError(new ApiError(status, undefined, 'x', null))).toBe(
          'permanent',
        );
      }
    });

    it('404 WITHOUT SESSION_NOT_FOUND code is permanent (e.g. CHUNK_NOT_FOUND)', () => {
      // The transient SESSION_NOT_FOUND check is keyed on the code
      // string, not on status. Other 404s remain permanent.
      expect(
        classifyError(
          new ApiError(404, 'CHUNK_NOT_FOUND', 'chunk gone', null),
        ),
      ).toBe('permanent');
      expect(classifyError(new ApiError(404, undefined, '404', null))).toBe(
        'permanent',
      );
    });

    it('HASH_MISMATCH (400) is permanent', () => {
      expect(
        classifyError(
          new ApiError(400, 'HASH_MISMATCH', 'bytes do not match hash', null),
        ),
      ).toBe('permanent');
    });

    it('non-ApiError carrying HTTP 4xx in message is permanent', () => {
      expect(classifyError(new Error('HTTP 400 bad'))).toBe('permanent');
      expect(classifyError(new Error('HTTP 403 forbidden'))).toBe('permanent');
    });
  });
});

describe('shapeError — diagnostic projection', () => {
  it('flattens an ApiError into status/code/message', () => {
    const err = new ApiError(409, 'DRIVE_NOT_CONNECTED', 'no drive', {
      meta: 1,
    });
    expect(shapeError(err)).toEqual({
      status: 409,
      code: 'DRIVE_NOT_CONNECTED',
      message: 'no drive',
    });
  });

  it('omits the code field when ApiError.code is undefined', () => {
    const err = new ApiError(500, undefined, 'boom', null);
    expect(shapeError(err)).toEqual({ status: 500, message: 'boom' });
  });

  it('extracts HTTP status from a non-ApiError Error message', () => {
    expect(shapeError(new Error('HTTP 502 upstream'))).toEqual({
      status: 502,
      message: 'HTTP 502 upstream',
    });
  });

  it('uses status=0 when no HTTP code can be parsed', () => {
    expect(shapeError(new Error('weird'))).toEqual({
      status: 0,
      message: 'weird',
    });
  });

  it('coerces non-Error throws to a string message at status=0', () => {
    expect(shapeError('plain')).toEqual({ status: 0, message: 'plain' });
    expect(shapeError(42)).toEqual({ status: 0, message: '42' });
  });
});
