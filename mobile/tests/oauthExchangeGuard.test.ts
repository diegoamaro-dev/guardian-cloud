import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetDriveOAuthCodesForTests,
  claimDriveOAuthCode,
} from '@/oauth/exchangeGuard';

afterEach(() => {
  // Pure isolation hygiene — the Set is module-scoped and tests share
  // a runtime, so a stale code from a previous test would mask a real
  // bug here.
  _resetDriveOAuthCodesForTests();
});

describe('claimDriveOAuthCode', () => {
  it('returns true the first time a code is offered', () => {
    expect(claimDriveOAuthCode('code-A')).toBe(true);
  });

  it('returns false on every subsequent offer of the same code', () => {
    expect(claimDriveOAuthCode('code-B')).toBe(true);
    expect(claimDriveOAuthCode('code-B')).toBe(false);
    expect(claimDriveOAuthCode('code-B')).toBe(false);
  });

  it('treats different codes independently', () => {
    expect(claimDriveOAuthCode('code-X')).toBe(true);
    expect(claimDriveOAuthCode('code-Y')).toBe(true);
    expect(claimDriveOAuthCode('code-X')).toBe(false);
  });

  it('rejects empty / falsy code without claiming a slot', () => {
    expect(claimDriveOAuthCode('')).toBe(false);
    // The empty string was rejected outright, so a real code that
    // happens to come right after still wins.
    expect(claimDriveOAuthCode('code-real')).toBe(true);
  });

  it('reset clears the in-memory state', () => {
    expect(claimDriveOAuthCode('code-R')).toBe(true);
    expect(claimDriveOAuthCode('code-R')).toBe(false);
    _resetDriveOAuthCodesForTests();
    expect(claimDriveOAuthCode('code-R')).toBe(true);
  });
});
