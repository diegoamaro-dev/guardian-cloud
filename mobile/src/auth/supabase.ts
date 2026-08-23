/**
 * Supabase client for the mobile app.
 *
 * - Uses `AsyncStorage` so the session survives app kills and reboots
 *   (one of the scenarios in TEST_SCENARIOS.md).
 * - `persistSession: true` and `autoRefreshToken: true` delegate refresh
 *   to supabase-js. We never manually deal with refresh tokens.
 * - `detectSessionInUrl: false` because there's no URL flow on native.
 *
 * IMPORTANT: this client uses the anon key. Every authenticated API call
 * MUST attach the current user's access token as Bearer. The backend
 * verifies that token against the JWKS.
 */

import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/config/env';
import { authDebugLogger, instrumentAuthStorage } from './authDiagnostics';
import { instrumentRefreshFetch } from './refreshRateLimit';

/**
 * GC-AUTH-SESSION-RECOVERY-001 · D0 — OBSERVABILITY ONLY.
 *
 * Both additions below are diagnostic. Neither changes what the client
 * does: `debug` is a logger, not a policy, and the storage wrapper is
 * value- and effect-transparent — it adds exactly one operation, a
 * `getItem` before deleting the session key, so the log can record
 * whether the refresh token was still present. See `authDiagnostics.ts`.
 *
 * `debug` is a FUNCTION on purpose. Passing `true` sets the logger to
 * `console.log`, which in auth-js 2.103.3 receives whole session objects
 * (`#getSession() 'session from storage', maybeSession`, `#_saveSession()
 * session`, and two more), and `_callRefreshToken` names itself with five
 * characters of the live refresh token. Our logger forwards no argument
 * by value — see `authDiagnostics.ts`.
 */
/**
 * GC-AUTH-SESSION-RECOVERY-001 · D2-C — the refresh rate-limit classifier.
 *
 * `global.fetch` is the only extension point `GoTrueClientOptions` offers;
 * there is no retry or error-classification hook. The wrapper declines to
 * hand auth-js a `429 over_request_rate_limit` on the refresh endpoint,
 * because auth-js would read it as a fatal credential error and delete the
 * session — access and refresh token together, under one key. With an
 * anonymous identity that deletion is terminal.
 *
 * Everything else passes through untouched. See `refreshRateLimit.ts`.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    storage: instrumentAuthStorage(AsyncStorage),
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    debug: authDebugLogger,
  },
  global: { fetch: instrumentRefreshFetch(fetch) },
});
