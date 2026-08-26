/**
 * Phase 1A — `classifyFailure` closed allow-list.
 *
 * The property under test is the INVERSION of the old policy: instead
 * of "retry unless we recognise it as fatal", the rule is now "pause
 * unless we recognise it as a transport fault". Anything the code
 * cannot positively identify must pause and preserve, because an
 * identical request that cannot succeed is a hot loop.
 *
 * No mocks: the module is pure and reads errors structurally, so plain
 * objects stand in for ApiError.
 */

import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../src/upload/errorPolicy';

/** ApiError-shaped plain object — the policy duck-types, so this is faithful. */
function apiErr(status: number, code?: string): unknown {
  const e = new Error(code ?? `HTTP ${status}`) as Error & {
    status: number;
    code?: string;
  };
  e.status = status;
  if (code) e.code = code;
  return e;
}

describe('classifyFailure — pauses that stop the storm', () => {
  it('401 NO_TOKEN pauses CLIENT_SESSION_EXPIRED globally (was: retry forever)', () => {
    expect(classifyFailure(apiErr(401, 'NO_TOKEN'))).toEqual({
      kind: 'pause',
      reason: 'CLIENT_SESSION_EXPIRED',
      scope: 'GLOBAL',
      code: 'NO_TOKEN',
    });
  });

  it('a bare 401 with no code still pauses globally, never retries', () => {
    const d = classifyFailure(apiErr(401));
    expect(d.kind).toBe('pause');
    if (d.kind !== 'pause') throw new Error('unreachable');
    expect(d.reason).toBe('CLIENT_SESSION_EXPIRED');
    expect(d.scope).toBe('GLOBAL');
  });

  it('DRIVE_REFRESH_FAILED and DRIVE_NOT_CONNECTED pause the destination', () => {
    for (const code of ['DRIVE_REFRESH_FAILED', 'DRIVE_NOT_CONNECTED']) {
      const d = classifyFailure(apiErr(code === 'DRIVE_REFRESH_FAILED' ? 401 : 409, code));
      expect(d).toEqual({
        kind: 'pause',
        reason: 'AUTH_RECONNECT_REQUIRED',
        scope: 'DESTINATION',
        code,
      });
    }
  });

  it('413 pauses SYSTEMIC_CONFIG_PAUSE globally, by status or by code', () => {
    for (const err of [apiErr(413), apiErr(413, 'BODY_TOO_LARGE')]) {
      const d = classifyFailure(err);
      expect(d.kind).toBe('pause');
      if (d.kind !== 'pause') throw new Error('unreachable');
      expect(d.reason).toBe('SYSTEMIC_CONFIG_PAUSE');
      expect(d.scope).toBe('GLOBAL');
    }
  });

  it('409 SESSION_NOT_ACTIVE pauses only the affected entry', () => {
    expect(classifyFailure(apiErr(409, 'SESSION_NOT_ACTIVE'))).toEqual({
      kind: 'pause',
      reason: 'SESSION_STATE_PAUSE',
      scope: 'ENTRY',
      code: 'SESSION_NOT_ACTIVE',
    });
  });

  it('403 and HASH_MISMATCH pause the entry as UNCLASSIFIED', () => {
    for (const err of [apiErr(403), apiErr(400, 'HASH_MISMATCH')]) {
      const d = classifyFailure(err);
      expect(d.kind).toBe('pause');
      if (d.kind !== 'pause') throw new Error('unreachable');
      expect(d.reason).toBe('UNCLASSIFIED_PAUSE');
      expect(d.scope).toBe('ENTRY');
    }
  });
});

describe('classifyFailure — the closed allow-list for retries', () => {
  it('recognised transport faults still retry', () => {
    expect(classifyFailure(apiErr(0, 'NETWORK_ERROR')).kind).toBe('retry');
    expect(classifyFailure(apiErr(408)).kind).toBe('retry');
    expect(classifyFailure(apiErr(429)).kind).toBe('retry');
    for (const s of [500, 502, 503, 504]) {
      expect(classifyFailure(apiErr(s)).kind).toBe('retry');
    }
  });

  it('SESSION_NOT_FOUND retries — offline-first re-registration heals it', () => {
    expect(classifyFailure(apiErr(404, 'SESSION_NOT_FOUND')).kind).toBe('retry');
  });

  it('our own CHUNK_UPLOAD_TIMEOUT sentinel retries', () => {
    expect(classifyFailure(new Error('CHUNK_UPLOAD_TIMEOUT')).kind).toBe('retry');
  });

  it('plain Errors carrying an HTTP token are read as that status', () => {
    expect(classifyFailure(new Error('POST /chunks HTTP 503 boom')).kind).toBe('retry');
    const d = classifyFailure(new Error('HTTP 413 too big'));
    expect(d.kind).toBe('pause');
    if (d.kind !== 'pause') throw new Error('unreachable');
    expect(d.reason).toBe('SYSTEMIC_CONFIG_PAUSE');
  });
});

describe('classifyFailure — TEST_UNKNOWN_THROWN_ERROR_DEFAULTS_TO_UNCLASSIFIED_PAUSE', () => {
  it('an unparseable Error is NOT treated as a network fault', () => {
    const d = classifyFailure(new Error('something weird'));
    expect(d).toEqual({
      kind: 'pause',
      reason: 'UNCLASSIFIED_PAUSE',
      scope: 'ENTRY',
      code: 'UNKNOWN',
    });
  });

  it('a programming exception is NOT treated as a network fault', () => {
    for (const err of [
      new TypeError('x is not a function'),
      new ReferenceError('y is not defined'),
    ]) {
      const d = classifyFailure(err);
      expect(d.kind).toBe('pause');
      if (d.kind !== 'pause') throw new Error('unreachable');
      expect(d.reason).toBe('UNCLASSIFIED_PAUSE');
    }
  });

  it('a thrown string / null / undefined pauses rather than retries', () => {
    for (const err of ['boom', null, undefined, 42]) {
      expect(classifyFailure(err).kind).toBe('pause');
    }
  });

  it('status 0 WITHOUT NETWORK_ERROR does not automatically retry', () => {
    const d = classifyFailure(apiErr(0));
    expect(d.kind).toBe('pause');
    if (d.kind !== 'pause') throw new Error('unreachable');
    expect(d.reason).toBe('UNCLASSIFIED_PAUSE');
  });

  it('status 0 WITH NETWORK_ERROR is the only zero-status retry', () => {
    expect(classifyFailure(apiErr(0, 'NETWORK_ERROR')).kind).toBe('retry');
  });
});
