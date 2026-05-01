/**
 * Auth store (Zustand).
 *
 * Single source of truth for "am I signed in?" in the app.
 * - `init()` reads any persisted session from AsyncStorage (via supabase-js)
 *   and subscribes to auth changes (SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED).
 * - `signIn` / `signOut` delegate to supabase-js; the subscription keeps
 *   the store in sync so UI re-renders automatically.
 * - `accessToken` is exposed so the API client can attach it as Bearer.
 *
 * We do NOT cache the token separately — supabase-js owns refresh. When
 * the API client needs a token, it reads it from here, which reflects
 * the latest refreshed value.
 */

import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  accessToken: string | null;

  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

function applySession(session: Session | null): Partial<AuthState> {
  if (!session) {
    return { status: 'signed-out', user: null, accessToken: null };
  }
  return {
    status: 'signed-in',
    user: session.user,
    accessToken: session.access_token,
  };
}

let subscribed = false;

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  user: null,
  accessToken: null,

  init: async () => {
    // getSession() pulls whatever supabase-js has already hydrated from
    // AsyncStorage (or null if this is a fresh install / signed-out user).
    const { data } = await supabase.auth.getSession();
    set(applySession(data.session));

    if (!subscribed) {
      supabase.auth.onAuthStateChange((_event, session) => {
        set(applySession(session));
      });
      subscribed = true;
    }
  },

  signIn: async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    set(applySession(data.session));
  },

  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    set({ status: 'signed-out', user: null, accessToken: null });
  },
}));

/**
 * Returns the currently-valid access token, refreshing it if the
 * persisted session has expired.
 *
 * Why not read `useAuthStore.getState().accessToken` directly: that
 * value is a snapshot updated only when supabase-js fires an auth
 * state change event (SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT).
 * supabase-js schedules the refresh ~60s before the JWT's `exp`, but
 * that timer is best-effort — if the app was backgrounded, the JS
 * thread was paused, or the device slept through the refresh window,
 * the store will keep the expired token until the next scheduled tick
 * lands.
 *
 * `supabase.auth.getSession()`, unlike a plain store read, checks
 * `expires_at` against the current time and performs an inline refresh
 * (using the persisted refresh_token) when the access token has
 * expired. On success the client emits `TOKEN_REFRESHED`, which our
 * existing `onAuthStateChange` listener catches to keep the store in
 * sync. On failure (no refresh_token, network error, revoked refresh
 * token) it returns `{ session: null }` and we propagate that as a
 * null token — callers then surface the 401 path.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  return error ? null : data.session?.access_token ?? null;
}
