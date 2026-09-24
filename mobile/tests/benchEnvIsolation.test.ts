/**
 * E1 — banco y producción no pueden confundirse en silencio.
 *
 * Dos garantías, y las dos son verificables sin construir nada:
 *
 *   1. un build que no DECLARA su entorno no arranca: `env.ts` lanza;
 *   2. declarar `bench` cambia el nombre visible y el application id,
 *      así que las dos instalaciones coexisten en vez de pisarse.
 *
 * La segunda se prueba contra `resolveBuildVariant`, que es donde vive la
 * regla; `app.config.ts` no la duplica, la llama.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveBuildVariant,
  UndeclaredBuildEnvironmentError,
  PRODUCTION_APP_NAME,
  PRODUCTION_ANDROID_PACKAGE,
} from '@/config/buildVariant';

describe('E1 · variante de build', () => {
  it('produce identidades de app distintas para banco y producción', () => {
    const prod = resolveBuildVariant('production');
    const bench = resolveBuildVariant('bench');

    expect(prod.androidPackage).toBe(PRODUCTION_ANDROID_PACKAGE);
    expect(prod.name).toBe(PRODUCTION_APP_NAME);
    expect(prod.isBench).toBe(false);

    expect(bench.isBench).toBe(true);
    expect(bench.androidPackage).not.toBe(prod.androidPackage);
    expect(bench.name).not.toBe(prod.name);
    expect(bench.name).toContain('BANCO');
  });

  /**
   * La corrección que importa: un entorno no declarado NO puede caer a
   * producción. Antes, cualquier valor distinto de 'bench' generaba la
   * identidad nativa de producción, y que `env.ts` fallara después, ya
   * en el arranque JS, no protege al prebuild: para entonces el APK
   * existe y lleva el applicationId real.
   */
  it('REHÚSA generar identidad nativa si el entorno no está declarado', () => {
    const rechazados: unknown[] = [
      undefined,
      '',
      ' ',
      'staging',
      'Bench',
      'BENCH',
      'benchh',
      'produccion',
      'prod',
      'banco',
      'PRODUCTION',
      'bench ',
      null,
      0,
    ];

    for (const value of rechazados) {
      expect(() => resolveBuildVariant(value as string | undefined)).toThrow(
        UndeclaredBuildEnvironmentError,
      );
    }
  });

  it('el rechazo ocurre ANTES de producir nombre o applicationId', () => {
    let variant: unknown = 'no asignado';
    try {
      variant = resolveBuildVariant(undefined);
    } catch {
      // esperado
    }
    // Nada se construyó: no hay objeto del que sacar una identidad nativa.
    expect(variant).toBe('no asignado');
  });

  it('solo los dos literales exactos resuelven', () => {
    expect(resolveBuildVariant('production').androidPackage).toBe(
      PRODUCTION_ANDROID_PACKAGE,
    );
    expect(resolveBuildVariant('bench').androidPackage).not.toBe(
      PRODUCTION_ANDROID_PACKAGE,
    );
  });
});

describe('E1 · env.ts exige declarar el entorno', () => {
  const VALID = {
    EXPO_PUBLIC_API_URL: 'https://api.example.com',
    EXPO_PUBLIC_SUPABASE_URL: 'https://benchref.supabase.co',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'x'.repeat(40),
  };

  beforeEach(() => {
    vi.resetModules();
    vi.unmock('@/config/env');
    for (const [k, v] of Object.entries(VALID)) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no arranca si el build no declara EXPO_PUBLIC_GC_ENV', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', '');
    await expect(import('@/config/env')).rejects.toThrow(
      /EXPO_PUBLIC_GC_ENV/,
    );
  });

  it('no arranca con un valor de entorno inventado', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'staging');
    await expect(import('@/config/env')).rejects.toThrow(
      /EXPO_PUBLIC_GC_ENV/,
    );
  });

  it('expone el entorno declarado y el proyecto realmente alcanzado', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'bench');
    const { env } = await import('@/config/env');

    expect(env.gcEnv).toBe('bench');
    expect(env.isBench).toBe(true);
    expect(env.projectRef).toBe('benchref');
  });

  it('producción declarada no queda marcada como banco', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'production');
    const { env } = await import('@/config/env');

    expect(env.gcEnv).toBe('production');
    expect(env.isBench).toBe(false);
  });

  /**
   * Dos guardas, un vocabulario: `env.ts` valida en arranque y
   * `buildVariant.js` valida en configuración. Si uno aceptara un valor
   * que el otro rechaza, volvería a existir una rendija.
   */
  it('runtime y config aceptan exactamente los mismos literales', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'production');
    const { GC_ENVIRONMENTS } = await import('@/config/env');
    const { BUILD_ENVIRONMENTS } = await import('@/config/buildVariant');

    expect([...GC_ENVIRONMENTS]).toEqual([...BUILD_ENVIRONMENTS]);
  });
});
