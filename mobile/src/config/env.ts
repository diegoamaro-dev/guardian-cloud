/**
 * Runtime env validation for the mobile app.
 *
 * Only `EXPO_PUBLIC_*` variables reach the JS bundle — Metro inlines
 * them at build time from `mobile/.env` (or one of the standard Expo
 * env-file variants `.env.development`, `.env.production`, `.env.local`,
 * etc.). The double-extension files in this folder
 * (`.env.device.device`, `.env.emulator.emulator`) are NOT loaded by
 * Expo and are kept around as manual reference snapshots.
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

// Reading process.env directly. Metro must INLINE these at build time
// (the EXPO_PUBLIC_* prefix is what enables that). If a value is
// undefined here it means Metro did not pick up the .env entry — which
// is precisely the misconfiguration we want surfaced, not silently
// masked with a hard-coded fallback.
const apiUrlRaw = process.env.EXPO_PUBLIC_API_URL;
const supabaseUrlRaw = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKeyRaw = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

console.log('ENV LOAD', {
  // URL-shaped vars are not secrets — print the resolved value so the
  // operator can see at a glance whether the device is talking to the
  // right backend / project.
  apiUrl: apiUrlRaw ?? null,
  supabaseUrl: supabaseUrlRaw ?? null,
  // The anon key is technically public but huge; presence boolean is
  // enough for boot diagnosis.
  supabaseAnonKeyPresent: !!supabaseAnonKeyRaw,
});

if (!apiUrlRaw) {
  console.log('ENV ERROR: apiUrl missing');
}

const parsed = EnvSchema.safeParse({
  EXPO_PUBLIC_API_URL: apiUrlRaw,
  EXPO_PUBLIC_SUPABASE_URL: supabaseUrlRaw,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKeyRaw,
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.log('ENV ERROR', { issues: parsed.error.issues });
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

console.log('ENV READY', { apiUrl: env.apiUrl });

export type Env = typeof env;
