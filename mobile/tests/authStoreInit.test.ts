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

import { useAuthStore } from '../src/auth/store';

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
