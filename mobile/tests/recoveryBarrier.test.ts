/**
 * Precondición A — la barrera de recovery, ejercitada de verdad.
 *
 * Lo que protege: una build donde la recuperación ya pueda producir sesiones
 * mientras el back-fill pre-G-R1 sigue encendido. En ese estado una sesión
 * recuperada recibiría el ancla y la comprobación de continuidad compararía al
 * candidato contra sí mismo — una comprobación que siempre pasa y no prueba
 * nada.
 *
 * `RECOVERY_ENTRY_IMPLEMENTED` cierra esa ventana apagando el back-fill. Hasta
 * ahora la constante vivía dentro del módulo que la lee, así que su rama
 * `true` era **inejecutable**: un `const` leído en su propio módulo es un
 * binding directo y `vi.mock` no lo alcanza. Vive ahora en
 * `src/auth/recoveryEntry.ts`, cuya única responsabilidad es declararla, y por
 * eso este fichero puede ponerla en `true` y observar el comportamiento real.
 *
 * ESTE FICHERO MIENTE A PROPÓSITO, y sólo aquí: el mock de abajo simula la
 * build futura. En producción la constante sigue siendo `false`, y eso lo fija
 * `identityContinuity.test.ts`, no este fichero.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const getSession = vi.fn(async () => ({
  data: { session: null as unknown },
  error: null as { name: string } | null,
}));

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  const failWrites = new Set<string>();
  return {
    default: {
      __store__: store,
      __failWrites__: failWrites,
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
      setItem: vi.fn(async (k: string, v: string) => {
        if (failWrites.has(k)) throw new Error('storage write failed');
        store.set(k, v);
      }),
      removeItem: vi.fn(async (k: string) => {
        store.delete(k);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

// LA BUILD FUTURA. Es lo único que este fichero cambia respecto al resto de la
// suite, y es exactamente lo que el refactor de `recoveryEntry.ts` hizo
// posible.
vi.mock('@/auth/recoveryEntry', () => ({
  RECOVERY_ENTRY_IMPLEMENTED: true,
}));

vi.mock('@/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) =>
        (getSession as unknown as (...x: unknown[]) => unknown)(...a),
      signInAnonymously: vi.fn(),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

// `tests/setup.ts` mockea `@/auth/store` globalmente; aquí hace falta el real.
vi.mock('@/auth/store', async () => await vi.importActual('@/auth/store'));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  IDENTITY_KEY,
  backfillIdentityAnchor,
  checkIdentityContinuity,
  readIdentityMarker,
} from '@/auth/identityMarker';
import {
  __resetOwnershipLatchForTests,
  getOwnershipAccessToken,
  getOwnershipToken,
} from '@/auth/store';
import { supabase } from '@/auth/supabase';

const HISTORICAL = '11111111-2222-3333-4444-555555555555';
const CANDIDATE = '99999999-8888-7777-6666-555555555555';
const QUEUE_KEY = 'test.pending_retry';
const HISTORY_KEY = 'history.sessions';

type MockedStorage = typeof AsyncStorage & {
  __store__: Map<string, string>;
  __failWrites__: Set<string>;
};
const storage = AsyncStorage as MockedStorage;

function withSession(userId: string | null): void {
  getSession.mockResolvedValue({
    data: {
      session: userId ? { access_token: 'tok', user: { id: userId } } : null,
    },
    error: null,
  });
}

async function writeMarker(marker: Record<string, unknown>): Promise<void> {
  storage.__store__.set(IDENTITY_KEY, JSON.stringify(marker));
}

/** Evidencia local del dispositivo: cola con un chunk ya confirmado fuera, e
 *  historial. Ninguna de las dos lleva identidad: no hay nada que re-keyear. */
async function writeLocalEvidence(): Promise<void> {
  storage.__store__.set(
    QUEUE_KEY,
    JSON.stringify([
      {
        session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        session_completed: false,
        chunks: [
          { chunk_index: 0, status: 'uploaded', remote_reference: '1AbCdEf' },
          { chunk_index: 1, status: 'pending', remote_reference: null },
        ],
      },
    ]),
  );
  storage.__store__.set(
    HISTORY_KEY,
    JSON.stringify([
      { session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', mode: 'audio' },
    ]),
  );
}

/** Lo que un BLOCK NO puede hacer, en una sola aserción reutilizable. */
function expectEvidenceUntouched(snapshot: Map<string, string>): void {
  expect(storage.__store__.get(QUEUE_KEY)).toBe(snapshot.get(QUEUE_KEY));
  expect(storage.__store__.get(HISTORY_KEY)).toBe(snapshot.get(HISTORY_KEY));
  expect([...storage.__store__.keys()].sort()).toEqual(
    [...snapshot.keys()].sort(),
  );
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  expect(supabase.auth.signInAnonymously).not.toHaveBeenCalled();
}

beforeEach(() => {
  storage.__store__.clear();
  storage.__failWrites__.clear();
  getSession.mockReset();
  vi.clearAllMocks();
  __resetOwnershipLatchForTests();
});

describe('A · con recovery habilitada, el back-fill está apagado', () => {
  it('marker SIN user_id: el back-fill rechaza con recovery_entry_exists', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: 'abcdefff',
      migrated_from_legacy: false,
    });
    const before = storage.__store__.get(IDENTITY_KEY);

    expect(await backfillIdentityAnchor(CANDIDATE)).toEqual({
      anchored: false,
      reason: 'recovery_entry_exists',
    });

    // Ninguna escritura del candidato: los bytes siguen idénticos y la
    // propiedad `user_id` sigue sin existir.
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(before);
    expect((await readIdentityMarker())?.user_id).toBeUndefined();
  });

  it('y la continuidad posterior es unverifiable, sin OwnershipToken', async () => {
    await writeLocalEvidence();
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: 'abcdefff',
      migrated_from_legacy: false,
    });
    const snapshot = new Map(storage.__store__);
    withSession(CANDIDATE);

    expect(await checkIdentityContinuity(CANDIDATE)).toEqual({
      ok: false,
      reason: 'unverifiable',
    });
    expect(await getOwnershipToken()).toEqual({
      ok: false,
      reason: 'continuity_unverifiable',
      name: null,
    });

    // El candidato no aparece en ninguna parte del almacenamiento.
    for (const v of storage.__store__.values()) {
      expect(v).not.toContain(CANDIDATE);
    }
    expectEvidenceUntouched(snapshot);
  });

  it('legacy + recovery habilitada: BLOCK y ancla no escrita', async () => {
    await writeLocalEvidence();
    await writeMarker({
      version: 1,
      initialized_at: 1,
      sub_prefix: null,
      migrated_from_legacy: true,
    });
    const snapshot = new Map(storage.__store__);
    withSession(CANDIDATE);

    // La barrera se evalúa ANTES que la guarda legacy, así que el motivo es
    // el de la barrera. Lo que importa es que ninguna de las dos escribe.
    expect(await backfillIdentityAnchor(CANDIDATE)).toEqual({
      anchored: false,
      reason: 'recovery_entry_exists',
    });
    expect((await getOwnershipToken()).ok).toBe(false);
    expect((await readIdentityMarker())?.user_id).toBeUndefined();
    expectEvidenceUntouched(snapshot);
  });

  it('mismatch: BLOCK y el ancla intacta byte a byte', async () => {
    await writeLocalEvidence();
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    const snapshot = new Map(storage.__store__);
    const before = storage.__store__.get(IDENTITY_KEY);
    withSession(CANDIDATE);

    expect(await getOwnershipToken()).toEqual({
      ok: false,
      reason: 'continuity_mismatch',
      name: null,
    });

    // El ancla NO se mueve hacia el candidato.
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(before);
    expect((await readIdentityMarker())?.user_id).toBe(HISTORICAL);
    expectEvidenceUntouched(snapshot);
  });

  it('la identidad anclada sí pasa, incluso con recovery habilitada', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    withSession(HISTORICAL);

    // La barrera apaga el back-fill, no la puerta: una continuidad
    // demostrable sigue emitiendo token.
    expect((await getOwnershipToken()).ok).toBe(true);
  });

  it('la captura local no queda bloqueada en ninguno de los BLOCK', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: 'abcdefff',
      migrated_from_legacy: false,
    });
    withSession(CANDIDATE);

    await expect(getOwnershipAccessToken()).resolves.toBeNull();
  });
});

describe('A · acoplamiento: la barrera no puede divergir de la realidad', () => {
  const HERE = __dirname;
  const read = (rel: string): string =>
    readFileSync(join(HERE, '..', rel), 'utf8');

  /** Rutas capaces de traer una sesión a la existencia. Ampliar esta lista es
   *  un cambio visible, que es justo el punto. */
  const SESSION_ROUTES = [
    'signInWithOtp',
    'verifyOtp',
    'setSession',
    'exchangeCodeForSession',
    'signInWithOAuth',
    'signInWithIdToken',
  ] as const;

  /** Fuentes de producción, sin comentarios: un nombre citado en un comentario
   *  no es una ruta de sesión. */
  function productionCode(): string {
    const files = [
      'src/auth/store.ts',
      'src/auth/supabase.ts',
      'src/auth/identityMarker.ts',
      'src/auth/recoveryEntry.ts',
      'app/index.tsx',
      'app/settings.tsx',
      'app/_layout.tsx',
    ];
    return files
      .map((f) => read(f))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('si existe una ruta de sesión por recovery, el flag DEBE ser true', () => {
    const code = productionCode();
    const found = SESSION_ROUTES.filter((r) => code.includes(r));

    // Con el árbol actual `found` está vacío y la implicación se cumple de
    // forma vacua, documentando la obligación futura. En cuanto alguien añada
    // OTP sin voltear el flag, este test se pone rojo.
    const declaration = read('src/auth/recoveryEntry.ts');
    if (found.length > 0) {
      expect(
        declaration.includes('RECOVERY_ENTRY_IMPLEMENTED = true'),
        `rutas de sesión presentes (${found.join(', ')}) con el flag en false`,
      ).toBe(true);
    } else {
      expect(declaration).toContain('RECOVERY_ENTRY_IMPLEMENTED = false');
    }
  });

  it('la guarda sigue en el back-fill, y antes de cualquier escritura', () => {
    const src = read('src/auth/identityMarker.ts');
    const body = src.slice(src.indexOf('export async function backfillIdentityAnchor'));
    const guard = body.indexOf('if (RECOVERY_ENTRY_IMPLEMENTED)');
    const write = body.indexOf('AsyncStorage.setItem');

    expect(guard).toBeGreaterThan(-1);
    expect(body).toContain("reason: 'recovery_entry_exists'");
    expect(guard).toBeLessThan(write);
  });

  it('la declaración no admite configuración en runtime', () => {
    const declaration = read('src/auth/recoveryEntry.ts').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    for (const forbidden of ['process.env', 'EXPO_PUBLIC', 'let ', 'function ']) {
      expect(declaration.includes(forbidden), `forbidden: ${forbidden}`).toBe(
        false,
      );
    }
  });
});
