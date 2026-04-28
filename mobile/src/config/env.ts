/**
 * Runtime env validation for the mobile app.
 *
 * Only `EXPO_PUBLIC_*` variables reach the JS bundle — we read them from
 * `process.env` directly (Metro inlines them at build time).
 *
 * If required values are missing, we fail LOUDLY at startup instead of
 * crashing later with a confusing Supabase or fetch error.
 */

import { z } from 'zod';

const EnvSchema = z.object({
  EXPO_PUBLIC_API_URL: z
    .string()
    .url('EXPO_PUBLIC_API_URL must be a valid URL'),
  EXPO_PUBLIC_SUPABASE_URL: z
    .string()
    .url('EXPO_PUBLIC_SUPABASE_URL must be a valid URL'),
  EXPO_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, 'EXPO_PUBLIC_SUPABASE_ANON_KEY looks too short'),
});

const parsed = EnvSchema.safeParse({
  EXPO_PUBLIC_API_URL: 'http://192.168.178.21:3000',
  EXPO_PUBLIC_SUPABASE_URL: 'https://nahksdkcvhveoctpjrea.supabase.co',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5haGtzZGtjdmh2ZW9jdHBqcmVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMzY5OTcsImV4cCI6MjA5MTgxMjk5N30.mAAF3FZppADN6nbDr5mxIVlJsmzjFmJxeH6HPA9MpTw',
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(
    `[env] Invalid EXPO_PUBLIC_* configuration:\n${issues}\n` +
      `Copy .env.example to .env and fill it in, then rebuild the Dev Client.`,
  );
}

export const env = Object.freeze({
  apiUrl: parsed.data.EXPO_PUBLIC_API_URL.replace(/\/$/, ''),
  supabaseUrl: parsed.data.EXPO_PUBLIC_SUPABASE_URL.replace(/\/$/, ''),
  supabaseAnonKey: parsed.data.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});

export type Env = typeof env;
