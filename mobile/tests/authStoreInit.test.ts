/**
 * Phase 1A — the REAL auth store's `init()` must reach the restore
 * coordinator.
 *
 * Why this file exists separately: every other suite mocks
 * `@/auth/store`, so they prove what `notifyClientAuth` does once
 * called — not that a session restored by `getSession()` ever calls it.
 * A cold start with a valid persisted session is precisely the case
 * where a CLIENT_SESSION_EXPIRED pause from the previous process has to
 * be lifted, so that link has to be tested against the real module.
 *
 * We deliberately do NOT rely on supabase-js emitting INITIAL_SESSION
 * afterwards: that is an event we neither control nor have verified.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from '@supabase/supabase-js';

// The global setup mocks `@/auth/store`; this suite needs the real one.
vi.unmock('@/auth/store');

const notifyClientAuth = vi.fn();
vi.mock('@/upload/pauseStore', () => ({
  notifyClientAuth: (...a: unknown[]) =>
    (notifyClientAuth as unknown as (...x: unknown[]) => unknown)(...a),
  registerAuthRestoreHandler: vi.fn(),
  ensureReady: vi.fn(async () => ({})),
}));

const getSession = vi.fn();
/**
 * `store.ts` guards the subscription with a module-level `subscribed`
 * latch, so `onAuthStateChange` is called exactly once per process —
 * during whichever `init()` runs first. We stash the handler here
 * because it must survive the `vi.clearAllMocks()` in `beforeEach`.
 */
let authHandler: ((event: string, session: unknown) => void) | null = null;
const onAuthStateChange = vi.fn((cb: (event: string, session: unknown) => void) => {
  authHandler = cb;
  return { data: { subscription: { unsubscribe: vi.fn() } } };
});
const signOut = vi.fn(async () => ({ error: null }));

vi.mock('@/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) =>
        (getSession as unknown as (...x: unknown[]) => unknown)(...a),
      onAuthStateChange: (...a: unknown[]) =>
        (onAuthStateChange as unknown as (...x: unknown[]) => unknown)(...a),
      signOut: (...a: unknown[]) =>
        (signOut as unknown as (...x: unknown[]) => unknown)(...a),
      signInWithPassword: vi.fn(),
    },
  },
}));

import { useAuthStore, getAccessToken, getFreshAccessToken } from '../src/auth/store';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TEST_INIT_WITH_VALID_PERSISTED_SESSION_NOTIFIES_USABLE_AUTH', () => {
  it('a restored session with an access token notifies usable=true', async () => {
    getSession.mockResolvedValue({
      data: {
        session: { access_token: 'a-real-token', user: { id: 'u1' } },
      },
      error: null,
    });

    await useAuthStore.getState().init();

    expect(notifyClientAuth).toHaveBeenCalledWith(true);
  });

  it('the notification does not depend on any later auth event', async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: 'tok', user: { id: 'u1' } } },
      error: null,
    });

    await useAuthStore.getState().init();

    // Nothing has fired onAuthStateChange yet — init() alone was enough.
    expect(notifyClientAuth).toHaveBeenCalledTimes(1);
    expect(notifyClientAuth).toHaveBeenCalledWith(true);
  });
});

describe('TEST_INIT_WITH_NULL_SESSION_DOES_NOT_CLEAR_PAUSE', () => {
  it('no persisted session notifies usable=false', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    await useAuthStore.getState().init();

    expect(notifyClientAuth).toHaveBeenCalledWith(false);
    expect(notifyClientAuth).not.toHaveBeenCalledWith(true);
  });

  it('a session without an access token notifies usable=false', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: 'u1' } } },
      error: null,
    });

    await useAuthStore.getState().init();

    expect(notifyClientAuth).toHaveBeenCalledWith(false);
  });

  it('an invalid persisted refresh token notifies usable=false', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid Refresh Token' },
    });

    await useAuthStore.getState().init();

    expect(notifyClientAuth).toHaveBeenCalledWith(false);
    expect(notifyClientAuth).not.toHaveBeenCalledWith(true);
  });
});

/**
 * GC-AUTH-001 regression guard.
 *
 * Identity in this app is an anonymous Supabase user, so the persisted
 * session is the ONLY handle on every session the device has already
 * uploaded — there is no login to fall back on. `signOut()` clears that
 * storage unconditionally, which is why `init()` must never reach for it
 * on its own: a transient network blip during the inline refresh raises
 * an error here too, and answering that by wiping storage costs the user
 * access to their evidence.
 *
 * supabase-js already removes a session whose refresh fails with a
 * genuinely non-retryable auth error. Deciding that is its job, not ours.
 */
describe('TEST_INIT_NEVER_DESTROYS_THE_PERSISTED_SESSION', () => {
  it('an error from getSession() does not trigger signOut', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: { name: 'AuthApiError', message: 'Invalid Refresh Token' },
    });

    await useAuthStore.getState().init();

    expect(signOut).not.toHaveBeenCalled();
  });

  it('a transient network failure does not trigger signOut either', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: { name: 'AuthRetryableFetchError', message: 'Network request failed' },
    });

    await useAuthStore.getState().init();

    expect(signOut).not.toHaveBeenCalled();
    // The store still reports signed-out for this process — reporting the
    // state and destroying it are different things.
    expect(useAuthStore.getState().status).toBe('signed-out');
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('a clean "no session" result does not trigger signOut', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    await useAuthStore.getState().init();

    expect(signOut).not.toHaveBeenCalled();
  });
});

describe('the subscription still notifies on later transitions', () => {
  it('onAuthStateChange forwards a usable session', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await useAuthStore.getState().init();

    const handler = authHandler;
    expect(handler).toBeTypeOf('function');
    if (!handler) throw new Error('unreachable');

    notifyClientAuth.mockClear();
    handler('INITIAL_SESSION', { access_token: 'tok', user: { id: 'u1' } });
    expect(notifyClientAuth).toHaveBeenCalledWith(true);

    notifyClientAuth.mockClear();
    handler('SIGNED_OUT', null);
    expect(notifyClientAuth).toHaveBeenCalledWith(false);
  });
});

/**
 * GC-AUTH-001 — the four ways a token request can fail must stay
 * distinguishable.
 *
 * The original diagnosis cost a full log replay because every failure
 * produced the same opaque `AUTH MISSING` line: a device that had simply
 * never signed in, one whose refresh could not reach the network, and one
 * whose refresh the server had rejected outright were indistinguishable
 * after the fact. Only the last of those destroys the stored session, and
 * only the middle one is worth retrying — so collapsing them hid exactly
 * the distinction that mattered.
 */
describe('TEST_TOKEN_FAILURE_REASONS_ARE_DISTINGUISHABLE', () => {
  it('a clean absence of session reports no_session', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await getAccessToken()).toEqual({
      ok: false,
      reason: 'no_session',
      name: null,
    });
  });

  it('a session carrying no access token also reports no_session', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: 'u1' } } },
      error: null,
    });
    const result = await getAccessToken();
    expect(result).toEqual({ ok: false, reason: 'no_session', name: null });
  });

  it('an unreachable network reports network, which is retryable', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError('Network request failed', 0),
    });
    const result = await getAccessToken();
    expect(result).toEqual({
      ok: false,
      reason: 'network',
      name: 'AuthRetryableFetchError',
    });
  });

  it('a server-rejected refresh reports auth_non_retryable', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError('Invalid Refresh Token', 400, 'invalid_grant'),
    });
    const result = await getAccessToken();
    expect(result).toEqual({
      ok: false,
      reason: 'auth_non_retryable',
      name: 'AuthApiError',
    });
  });

  it('any other auth error falls back to refresh_failed', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthSessionMissingError(),
    });
    const result = await getAccessToken();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('refresh_failed');
  });

  it('a usable session reports the token', async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: 'tok', user: { id: 'u1' } } },
      error: null,
    });
    expect(await getAccessToken()).toEqual({ ok: true, token: 'tok' });
  });

  it('no failure path ever leaks a message — only a class name', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError('token eyJsecret.payload.sig', 400, 'invalid_grant'),
    });
    const result = await getAccessToken();
    expect(JSON.stringify(result)).not.toMatch(/eyJ/);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('getFreshAccessToken keeps its old contract for existing callers', async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: 'tok' } },
      error: null,
    });
    expect(await getFreshAccessToken()).toBe('tok');

    getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError('down', 0),
    });
    expect(await getFreshAccessToken()).toBeNull();
  });
});
