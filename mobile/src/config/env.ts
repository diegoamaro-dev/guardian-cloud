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

import { EXPECTED_PROJECT_REFS, verifyProjectRef } from './projectRefs';

/**
 * E1 — BENCH vs PRODUCTION, declared and never inferred.
 *
 * A build that talks to the throwaway Supabase project and a build that
 * talks to the real one must be impossible to confuse. The mechanism is
 * deliberately the dumbest one that cannot fail silently: every build
 * DECLARES which environment it is, and a build that declares nothing
 * does not boot.
 *
 * There is no default. A default would be exactly the silent confusion
 * this guards against — the wrong value would still produce a working
 * app pointed at the wrong project.
 *
 * This is not an environment ABSTRACTION: nothing branches on it inside
 * the product. It is a declaration the operator can see in the logs, in
 * the app name, and (after a prebuild) in the Android application id.
 */
export const GC_ENVIRONMENTS = ['production', 'bench'] as const;
export type GcEnvironment = (typeof GC_ENVIRONMENTS)[number];

/**
 * First label of the Supabase host — `<ref>.supabase.co`. Not a secret,
 * and the only value that says WHICH project a build actually reaches,
 * independently of what it claims to be.
 */
export function deriveProjectRef(supabaseUrl: string): string | null {
  try {
    const host = new URL(supabaseUrl).host;
    const label = host.split('.')[0] ?? '';
    return label.length > 0 ? label : null;
  } catch {
    return null;
  }
}

const EnvSchema = z.object({
  EXPO_PUBLIC_GC_ENV: z.enum(GC_ENVIRONMENTS, {
    errorMap: () => ({
      message:
        "EXPO_PUBLIC_GC_ENV must be declared as exactly 'production' or 'bench'",
    }),
  }),
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
  EXPO_PUBLIC_GC_ENV: process.env.EXPO_PUBLIC_GC_ENV,
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

const supabaseUrl = parsed.data.EXPO_PUBLIC_SUPABASE_URL.replace(/\/$/, '');
const projectRef = deriveProjectRef(supabaseUrl);

/**
 * E1-S — el entorno declarado y el proyecto alcanzado tienen que
 * corresponder, 1:1 y de fallo cerrado.
 *
 * Esto se comprueba aquí, en el límite de configuración, y no en Auth ni
 * en la UI: a partir de esta línea el resto del sistema ya puede dar por
 * hecho que el proyecto es el que toca. La regla y el porqué viven en
 * `projectRefs.ts`.
 *
 * El mensaje dice el entorno y la razón, y nada más: ni URL, ni ref, ni
 * clave. Quien diagnostica ya sabe qué build ha instalado.
 */
const projectVerdict = verifyProjectRef(
  parsed.data.EXPO_PUBLIC_GC_ENV,
  projectRef,
  EXPECTED_PROJECT_REFS,
);

if (!projectVerdict.ok) {
  console.log('GC_ENV_PROJECT_REFUSED', {
    gcEnv: parsed.data.EXPO_PUBLIC_GC_ENV,
    refusal: projectVerdict.refusal,
  });
  throw new Error(
    `[env] El proyecto Supabase alcanzado no corresponde al entorno ` +
      `declarado '${parsed.data.EXPO_PUBLIC_GC_ENV}': ` +
      `${projectVerdict.refusal}. Revisa EXPO_PUBLIC_SUPABASE_URL y ` +
      `EXPO_PUBLIC_GC_ENV del build, y la tabla de src/config/projectRefs.ts.`,
  );
}

export const env = Object.freeze({
  apiUrl: parsed.data.EXPO_PUBLIC_API_URL.replace(/\/$/, ''),
  supabaseUrl,
  supabaseAnonKey: parsed.data.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  /** Declared by the build. Never inferred, never defaulted. */
  gcEnv: parsed.data.EXPO_PUBLIC_GC_ENV,
  isBench: parsed.data.EXPO_PUBLIC_GC_ENV === 'bench',
  /** Which Supabase project this build actually reaches. */
  projectRef,
});

// Declared environment and reached project, side by side and on purpose:
// the pair is what lets an operator see a mismatch at a glance.
console.log('GC_ENV', { gcEnv: env.gcEnv, projectRef: env.projectRef });
console.log('ENV READY', { apiUrl: env.apiUrl });

export type Env = typeof env;
