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

export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
