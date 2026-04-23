/**
 * Supabase admin client.
 *
 * Uses the service role key and therefore BYPASSES Row-Level Security.
 * Security guarantee is enforced by the backend:
 *   - user_id is taken from the validated JWT in `authMiddleware`
 *   - every query MUST constrain by that user_id (see services/*)
 *
 * The service role key must never reach the mobile app. It lives only in
 * the backend process.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

export const supabase: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      // Backend is stateless; it does not need Supabase to manage sessions.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { 'x-client-info': 'guardian-cloud-backend' },
    },
  },
);
