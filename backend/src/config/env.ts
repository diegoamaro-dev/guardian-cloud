/**
 * Environment configuration.
 *
 * Loads variables from `.env` once, validates them with zod, and exports a
 * frozen, typed `env` object. If validation fails, the process exits before
 * anything else boots. This guarantees the rest of the app never sees an
 * invalid or partial config.
 */

import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  // Optional: legacy HS256 JWT secret for this Supabase project. Present
  // on every Supabase project (dashboard → Project Settings → API → JWT
  // Secret). Required ONLY when the project is still issuing HS256-
  // signed user access tokens — asymmetric (ES256/RS256) projects can
  // omit it and the verifier falls through to JWKS.
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),

  MAX_CHUNK_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),

  // --- Google Drive (optional on boot).
  // Kept optional so existing tests and dev bootstraps never break when
  // Drive isn't configured yet. The `/destinations/drive/connect` route
  // explicitly checks for these and returns a clean 503 if absent — it
  // never silently falls through.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  // Must match the redirect URI registered on the Google Cloud OAuth
  // client. Mobile uses the app scheme, e.g. `guardiancloud://oauth/drive`.
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // Deep link the OAuth callback redirects to after Google's redirect
  // lands on this backend. In production this is the app's custom
  // scheme (`guardiancloud://oauth/drive`); in Expo Dev Client it can
  // be the dev-server URL (`exp://<lan-ip>:8081/--/oauth/drive`).
  //
  // Required — no default on purpose. A wrong value silently routes
  // OAuth callbacks to a dead URL and testers get a stuck connecting
  // screen with no recovery. Better to fail boot than to ship a
  // personal LAN address baked in as fallback.
  MOBILE_OAUTH_REDIRECT: z.string().min(1),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Use stderr directly so this fails loudly even before the logger is ready.
  // Do NOT log the values themselves — only which keys are invalid.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`[env] Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;
