/**
 * E1-S — un entorno declarado no puede alcanzar el proyecto Supabase del
 * otro.
 *
 * Dos niveles, a propósito:
 *
 *   · la REGLA se prueba sobre `verifyProjectRef`, que es pura y recibe la
 *     tabla, así que se pueden ejercitar todas las combinaciones sin
 *     depender de qué proyectos existan hoy;
 *   · la APLICACIÓN se prueba importando `@/config/env` de verdad, que es
 *     donde la regla tiene que impedir que la app opere.
 *
 * Lo que estos tests NO acreditan: nada sobre un proyecto Supabase real.
 * No hablan con la red. Acreditan que la configuración y el arranque
 * rechazan lo que deben rechazar.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EXPECTED_PROJECT_REFS,
  verifyProjectRef,
} from '@/config/projectRefs';

/**
 * Los dos proyectos autorizados, leídos de la tabla versionada: toda la
 * regla se ejercita contra la tabla REAL, no contra una ficticia.
 */
const PRODUCTION_REF = EXPECTED_PROJECT_REFS.production as string;
const BENCH_REF = EXPECTED_PROJECT_REFS.bench as string;

describe('E1-S · la regla, contra la tabla real', () => {
  it('production + proyecto de producción → ACEPTA', () => {
    expect(
      verifyProjectRef('production', PRODUCTION_REF, EXPECTED_PROJECT_REFS),
    ).toEqual({ ok: true });
  });

  it('bench + proyecto de banco autorizado → ACEPTA', () => {
    expect(
      verifyProjectRef('bench', BENCH_REF, EXPECTED_PROJECT_REFS),
    ).toEqual({ ok: true });
  });

  it('production + proyecto de banco → RECHAZA', () => {
    expect(
      verifyProjectRef('production', BENCH_REF, EXPECTED_PROJECT_REFS),
    ).toEqual({ ok: false, refusal: 'project_mismatch' });
  });

  it('bench + proyecto de producción → RECHAZA', () => {
    expect(
      verifyProjectRef('bench', PRODUCTION_REF, EXPECTED_PROJECT_REFS),
    ).toEqual({ ok: false, refusal: 'project_mismatch' });
  });

  it('un tercer proyecto cualquiera → RECHAZA en los dos entornos', () => {
    // Un proyecto no autorizado es tan inaceptable como el del otro
    // entorno: la relación es 1:1, no «cualquiera que no sea el otro».
    for (const env of ['production', 'bench'] as const) {
      expect(
        verifyProjectRef(env, 'otroproyectocualquiera', EXPECTED_PROJECT_REFS),
      ).toEqual({ ok: false, refusal: 'project_mismatch' });
    }
  });

  it('sin project ref → RECHAZA', () => {
    for (const env of ['production', 'bench'] as const) {
      expect(verifyProjectRef(env, null, EXPECTED_PROJECT_REFS)).toEqual({
        ok: false,
        refusal: 'no_project_ref',
      });
      expect(verifyProjectRef(env, '', EXPECTED_PROJECT_REFS)).toEqual({
        ok: false,
        refusal: 'no_project_ref',
      });
    }
  });

  it('los dos proyectos autorizados son distintos', () => {
    // Si alguien igualara los dos refs, todos los cruces de arriba
    // pasarían a aceptar y ningún test lo diría. Esto lo dice.
    expect(PRODUCTION_REF).not.toBe(BENCH_REF);
  });
});

describe('E1-S · ausencia de declaración NO es permiso', () => {
  it('un entorno sin proyecto autorizado rechaza cualquier proyecto', () => {
    // La tabla real está completa, así que esta rama se ejercita con una
    // tabla incompleta a propósito: es la única forma de cubrir el
    // `null`, que sigue existiendo en el código y que debe seguir siendo
    // un rechazo y no una puerta abierta.
    const incomplete = Object.freeze({
      production: PRODUCTION_REF,
      bench: null,
    });

    for (const ref of [PRODUCTION_REF, BENCH_REF, 'otro']) {
      expect(verifyProjectRef('bench', ref, incomplete)).toEqual({
        ok: false,
        refusal: 'env_has_no_declared_project',
      });
    }
  });

  it('la tabla real ancla los dos entornos a su proyecto', () => {
    // Si alguien cambia cualquiera de los dos refs, este test es lo que
    // lo detiene.
    expect(EXPECTED_PROJECT_REFS.production).toBe('nahksdkcvhveoctpjrea');
    expect(EXPECTED_PROJECT_REFS.bench).toBe('rgbsofvycynhabycetel');
  });
});

/**
 * Aplicación real: la guarda vive en el arranque de la configuración, así
 * que un desajuste impide que el módulo exista, no que una pantalla avise.
 */
describe('E1-S · aplicación en el arranque de la configuración', () => {
  const BASE = {
    EXPO_PUBLIC_API_URL: 'https://api.example.com',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'x'.repeat(40),
  };

  beforeEach(() => {
    vi.resetModules();
    vi.unmock('@/config/env');
    for (const [k, v] of Object.entries(BASE)) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('production contra el proyecto de producción arranca', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'production');
    vi.stubEnv(
      'EXPO_PUBLIC_SUPABASE_URL',
      `https://${PRODUCTION_REF}.supabase.co`,
    );

    const { env } = await import('@/config/env');
    expect(env.gcEnv).toBe('production');
    expect(env.projectRef).toBe(PRODUCTION_REF);
  });

  it('production contra otro proyecto NO arranca', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'production');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://otroproyecto.supabase.co');

    await expect(import('@/config/env')).rejects.toThrow(/project_mismatch/);
  });

  it('bench contra su propio proyecto arranca', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'bench');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', `https://${BENCH_REF}.supabase.co`);

    const { env } = await import('@/config/env');
    expect(env.gcEnv).toBe('bench');
    expect(env.isBench).toBe(true);
    expect(env.projectRef).toBe(BENCH_REF);
  });

  it('bench contra el proyecto de producción NO arranca', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'bench');
    vi.stubEnv(
      'EXPO_PUBLIC_SUPABASE_URL',
      `https://${PRODUCTION_REF}.supabase.co`,
    );

    await expect(import('@/config/env')).rejects.toThrow(/project_mismatch/);
  });

  it('el mensaje de rechazo no filtra URL, ref ni clave', async () => {
    vi.stubEnv('EXPO_PUBLIC_GC_ENV', 'production');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://otroproyecto.supabase.co');

    const error = await import('@/config/env').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeTruthy();
    const message = error?.message ?? '';
    expect(message).not.toContain('otroproyecto');
    expect(message).not.toContain('supabase.co');
    expect(message).not.toContain('https://');
    expect(message).not.toContain('x'.repeat(40));
  });
});
