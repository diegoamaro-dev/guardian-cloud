/**
 * E1 — fronteras de la vinculación diferida de identidad.
 *
 * Esta suite no prueba que Supabase vincule un email: eso sólo lo puede
 * acreditar una corrida en dispositivo contra el proyecto de banco. Prueba
 * las fronteras que E1 declara y que sí son verificables aquí:
 *
 *   1. vincular no toca `GC_QUEUE` — ninguna escritura en AsyncStorage;
 *   2. un fallo de vinculación NO activa `client_auth` — `notifyClientAuth`
 *      no se llama, ni con éxito ni con error;
 *   3. el `user.id` se conserva, y si cambiara se reporta en vez de
 *      aceptarse en silencio;
 *   4. un email con forma inválida no llega a la red.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

// El setup global mockea `@/auth/store`; aquí hace falta el real.
vi.unmock('@/auth/store');

const notifyClientAuth = vi.fn();
vi.mock('@/upload/pauseStore', () => ({
  notifyClientAuth: (...a: unknown[]) =>
    (notifyClientAuth as unknown as (...x: unknown[]) => unknown)(...a),
  registerAuthRestoreHandler: vi.fn(),
  ensureReady: vi.fn(async () => ({})),
}));

const asyncSetItem = vi.fn(async () => undefined);
const asyncRemoveItem = vi.fn(async () => undefined);
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: (...a: unknown[]) =>
      (asyncSetItem as unknown as (...x: unknown[]) => unknown)(...a),
    removeItem: (...a: unknown[]) =>
      (asyncRemoveItem as unknown as (...x: unknown[]) => unknown)(...a),
    multiRemove: vi.fn(async () => undefined),
  },
}));

const markIdentityInitialized = vi.fn(async () => ({ persisted: true }));
vi.mock('@/auth/identityMarker', () => ({
  markIdentityInitialized: (...a: unknown[]) =>
    (markIdentityInitialized as unknown as (...x: unknown[]) => unknown)(...a),
}));

const getSession = vi.fn();
const updateUser = vi.fn();
vi.mock('@/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) =>
        (getSession as unknown as (...x: unknown[]) => unknown)(...a),
      updateUser: (...a: unknown[]) =>
        (updateUser as unknown as (...x: unknown[]) => unknown)(...a),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signOut: vi.fn(),
      signInWithPassword: vi.fn(),
    },
  },
}));

const SUB = 'ac20eed5-6cba-43ca-a186-eee779cb7223';
const OTHER_SUB = '11111111-2222-3333-4444-555555555555';

function sessionWith(userId: string) {
  return {
    data: {
      session: {
        access_token: 'token',
        user: { id: userId, is_anonymous: true, email: null },
      },
    },
    error: null,
  };
}

let linkEmail: typeof import('@/auth/store').linkEmail;
let deriveIdentityLinkState: typeof import('@/auth/store').deriveIdentityLinkState;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('@/auth/store');
  linkEmail = mod.linkEmail;
  deriveIdentityLinkState = mod.deriveIdentityLinkState;
});

describe('E1 · linkEmail — fronteras', () => {
  it('no escribe en AsyncStorage: GC_QUEUE queda intacta', async () => {
    getSession.mockResolvedValue(sessionWith(SUB));
    updateUser.mockResolvedValue({
      data: { user: { id: SUB, is_anonymous: true, new_email: 'a@b.com' } },
      error: null,
    });

    const result = await linkEmail('a@b.com');

    expect(result.ok).toBe(true);
    expect(asyncSetItem).not.toHaveBeenCalled();
    expect(asyncRemoveItem).not.toHaveBeenCalled();
  });

  it('nunca notifica a la pausa del worker, ni con éxito ni con error', async () => {
    getSession.mockResolvedValue(sessionWith(SUB));
    updateUser.mockResolvedValue({
      data: { user: { id: SUB, is_anonymous: true, new_email: 'a@b.com' } },
      error: null,
    });
    await linkEmail('a@b.com');
    expect(notifyClientAuth).not.toHaveBeenCalled();

    updateUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError('rejected', 400, 'email_exists'),
    });
    const failed = await linkEmail('a@b.com');

    expect(failed).toEqual({
      ok: false,
      reason: 'auth_non_retryable',
      name: 'AuthApiError',
    });
    expect(notifyClientAuth).not.toHaveBeenCalled();
    expect(asyncSetItem).not.toHaveBeenCalled();
  });

  it('clasifica un fallo de red como reintentable sin tocar nada', async () => {
    getSession.mockResolvedValue(sessionWith(SUB));
    updateUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError('offline', 0),
    });

    const result = await linkEmail('a@b.com');

    expect(result).toMatchObject({ ok: false, reason: 'network' });
    expect(notifyClientAuth).not.toHaveBeenCalled();
  });

  it('conserva el user.id y lo devuelve', async () => {
    getSession.mockResolvedValue(sessionWith(SUB));
    updateUser.mockResolvedValue({
      data: { user: { id: SUB, is_anonymous: true, new_email: 'a@b.com' } },
      error: null,
    });

    const result = await linkEmail('a@b.com');

    expect(result).toMatchObject({ ok: true, state: 'pending', userId: SUB });
  });

  /**
   * La ausencia de evidencia no es conservación. Si `updateUser` responde
   * sin error pero sin usuario, no hay nada que comparar con el id de
   * partida, así que el resultado NO puede ser un éxito.
   */
  it('sin usuario devuelto, la conservación del id queda sin acreditar', async () => {
    getSession.mockResolvedValue(sessionWith(SUB));
    updateUser.mockResolvedValue({ data: { user: null }, error: null });

    const result = await linkEmail('a@b.com');

    expect(result).toEqual({
      ok: false,
      reason: 'no_user_returned',
      name: null,
    });
    // Y no se intenta arreglarlo: ni getUser, ni una segunda llamada.
    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(notifyClientAuth).not.toHaveBeenCalled();
    expect(asyncSetItem).not.toHaveBeenCalled();
  });

  it('sin usuario devuelto tampoco cuando `data` viene vacío', async () => {
    getSession.mockResolvedValue(sessionWith(SUB));
    updateUser.mockResolvedValue({ data: {}, error: null });

    const result = await linkEmail('a@b.com');

    expect(result).toMatchObject({ ok: false, reason: 'no_user_returned' });
  });

  it('si el id cambiara, lo reporta en vez de aceptarlo', async () => {
    getSession.mockResolvedValue(sessionWith(SUB));
    updateUser.mockResolvedValue({
      data: { user: { id: OTHER_SUB, is_anonymous: false } },
      error: null,
    });

    const result = await linkEmail('a@b.com');

    expect(result).toEqual({
      ok: false,
      reason: 'identity_changed',
      name: null,
    });
  });

  it('un email con forma inválida no llega a la red', async () => {
    getSession.mockResolvedValue(sessionWith(SUB));

    const result = await linkEmail('no-es-un-email');

    expect(result).toEqual({ ok: false, reason: 'invalid_email', name: null });
    expect(updateUser).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('sin sesión no intenta vincular nada', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    const result = await linkEmail('a@b.com');

    expect(result).toEqual({ ok: false, reason: 'no_session', name: null });
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('E1 · deriveIdentityLinkState — la UI no puede afirmar de más', () => {
  it('pendiente mientras el correo no esté confirmado', () => {
    expect(
      deriveIdentityLinkState({
        id: SUB,
        is_anonymous: true,
        new_email: 'a@b.com',
      } as never),
    ).toBe('pending');
  });

  it('un email sin confirmar NO es una identidad vinculada', () => {
    expect(
      deriveIdentityLinkState({
        id: SUB,
        is_anonymous: false,
        email: 'a@b.com',
        email_confirmed_at: null,
      } as never),
    ).toBe('none');
  });

  it('vinculada sólo con email confirmado y usuario no anónimo', () => {
    expect(
      deriveIdentityLinkState({
        id: SUB,
        is_anonymous: false,
        email: 'a@b.com',
        email_confirmed_at: '2026-09-24T10:00:00Z',
      } as never),
    ).toBe('linked');
  });

  it('sin usuario no hay nada que afirmar', () => {
    expect(deriveIdentityLinkState(null)).toBe('none');
  });
});
