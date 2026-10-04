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
import { readdirSync, readFileSync } from 'node:fs';
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

  /**
   * Rutas que CREAN o RESTAURAN una sesión, y por tanto son entradas de
   * recovery. Se buscan desnudas porque ninguna es un nombre plausible de
   * variable local.
   *
   * `signInAnonymously` NO está: es el acuñado legítimo de la primera
   * identidad, no una recuperación.
   *
   * `signInWithPassword` tampoco. Existe en `store.ts` sin ningún caller, es
   * anterior a todo este trabajo, y una identidad anónima no tiene contraseña
   * que recuperar. Es una limitación conocida de un barrido de texto: no puede
   * razonar sobre alcanzabilidad, así que la decisión está aquí, escrita.
   */
  const SESSION_CREATING = [
    'signInWithOtp',
    'exchangeCodeForSession',
    'signInWithOAuth',
    'signInWithIdToken',
  ] as const;

  /**
   * `setSession` va aparte porque **es** un nombre de variable corriente: el
   * primer barrido recursivo lo encontró en `app/session/[id].tsx`, donde es el
   * setter de un `useState` —`setSessionMode`, `setSessionDestination`—. Un
   * `includes` sobre ese identificador es un falso positivo garantizado, así
   * que para éste se exige la llamada sobre un objeto `auth`.
   *
   * Límite conocido y escrito: un alias desestructurado
   * —`const { setSession } = supabase.auth`— se escaparía.
   */
  const AUTH_ANCHORED = ['auth.setSession('] as const;

  /**
   * `verifyOtp` no se puede clasificar por su nombre: depende del `type`.
   *
   * `email_change` y `phone_change` CONFIRMAN un cambio sobre la sesión que ya
   * está viva —es la Fase 1 de G-R3, vincular un email a la identidad actual—
   * y no pueden producir una sesión para otra identidad. Cualquier otro tipo
   * —`email`, `magiclink`, `recovery`, `sms`— sí devuelve sesión.
   *
   * Confundirlos haría que la barrera exigiera apagar el back-fill para poder
   * vincular un email, que es lo contrario de lo que protege.
   */
  const NON_RECOVERY_VERIFY_TYPES = ['email_change', 'phone_change'] as const;

  /** Comentarios fuera: un identificador citado en una explicación no es una
   *  ruta de sesión. Sólo bloques y líneas completas, para no comerse un
   *  `https://` dentro de una cadena. */
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  /**
   * LA FUNCIÓN QUE ARREGLA EL FALSO POSITIVO. Devuelve las rutas de recovery
   * presentes en un trozo de código. Es pura y determinista, así que los tests
   * de abajo la ejercitan con fragmentos sintéticos en lugar de confiar en que
   * el árbol real contenga el caso.
   *
   * FALLA CERRADO: un `verifyOtp` cuyo `type` no se puede leer cuenta como
   * recovery. Ante la duda, exigir la barrera.
   */
  function detectRecoveryRoutes(code: string): string[] {
    const src = stripComments(code);
    const squeezed = src.replace(/\s+/g, '');
    const found: string[] = [];

    for (const id of SESSION_CREATING) {
      if (src.includes(id)) found.push(id);
    }
    for (const needle of AUTH_ANCHORED) {
      if (squeezed.includes(needle)) found.push(needle);
    }

    const calls = /verifyOtp\s*\(([\s\S]{0,300}?)\)/g;
    let m: RegExpExecArray | null;
    while ((m = calls.exec(src)) !== null) {
      const typed = /type\s*:\s*['"`]([a-z_]+)['"`]/.exec(m[1] ?? '');
      const type = typed?.[1] ?? 'unknown';
      if (!(NON_RECOVERY_VERIFY_TYPES as readonly string[]).includes(type)) {
        found.push(`verifyOtp:${type}`);
      }
    }
    return found;
  }

  /**
   * LA FUNCIÓN QUE ARREGLA EL FALSO NEGATIVO. Recorre `mobile/src` y
   * `mobile/app` enteros en lugar de una lista escrita a mano que se queda
   * corta en cuanto alguien crea una pantalla — y el primer barrido ya demostró
   * que la lista anterior dejaba ficheros fuera. Sólo producción: los de test
   * quedan excluidos, porque este mismo fichero contiene fragmentos sintéticos
   * que no son rutas reales.
   *
   * `readdirSync` de `node:fs`: ni dependencia nueva, ni AST.
   */
  function productionFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name)
        ) {
          out.push(p);
        }
      }
    };
    walk(join(HERE, '..', 'src'));
    walk(join(HERE, '..', 'app'));
    return out;
  }

  function foundInTree(): string[] {
    return productionFiles().flatMap((f) =>
      detectRecoveryRoutes(readFileSync(f, 'utf8')).map((r) => `${f}: ${r}`),
    );
  }

  it('el barrido cubre el árbol de producción, no una lista escrita a mano', () => {
    const files = productionFiles();

    // Si el barrido se quedara en unos pocos ficheros el acoplamiento sería
    // decorativo. Y los sitios donde viviría una ruta de recovery tienen que
    // estar dentro — incluido el que la lista anterior no cubría.
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith(join('auth', 'store.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith('link-identity.tsx'))).toBe(true);
    expect(files.some((f) => f.includes('session'))).toBe(true);
    expect(files.every((f) => !/\.test\.tsx?$/.test(f))).toBe(true);
  });

  it('si existe una ruta de recovery, el flag DEBE ser true', () => {
    const found = foundInTree();
    const declaration = read('src/auth/recoveryEntry.ts');

    if (found.length > 0) {
      expect(
        declaration.includes('RECOVERY_ENTRY_IMPLEMENTED = true'),
        `rutas de recovery presentes con el flag en false:\n${found.join('\n')}`,
      ).toBe(true);
    } else {
      // El árbol de hoy: ninguna ruta, flag en false. G-R3 todavía no existe.
      expect(declaration).toContain('RECOVERY_ENTRY_IMPLEMENTED = false');
    }
  });

  it('el árbol ACTUAL no contiene ninguna ruta de recovery', () => {
    const found = foundInTree();
    expect(found, `inesperado:\n${found.join('\n')}`).toEqual([]);
  });

  it('TEETH · una ruta signInWithOtp sería detectada', () => {
    expect(
      detectRecoveryRoutes('await supabase.auth.signInWithOtp({ email });'),
    ).toEqual(['signInWithOtp']);
  });

  it("TEETH · verifyOtp type 'email' es recovery", () => {
    expect(
      detectRecoveryRoutes(
        "await supabase.auth.verifyOtp({ email, token, type: 'email' });",
      ),
    ).toEqual(['verifyOtp:email']);
  });

  it("verifyOtp type 'email_change' NO es recovery — es vincular un email", () => {
    expect(
      detectRecoveryRoutes(
        "await supabase.auth.verifyOtp({ email, token, type: 'email_change' });",
      ),
    ).toEqual([]);
  });

  it('un verifyOtp cuyo type no se puede leer cuenta como recovery', () => {
    expect(
      detectRecoveryRoutes(
        'await supabase.auth.verifyOtp({ email, token, type: someVar });',
      ),
    ).toEqual(['verifyOtp:unknown']);
  });

  it('un setter de useState NO es la API de auth', () => {
    // El caso real que el barrido recursivo destapó en app/session/[id].tsx.
    expect(
      detectRecoveryRoutes(
        'const [sessionMode, setSessionMode] = useState(null);',
      ),
    ).toEqual([]);
    expect(
      detectRecoveryRoutes('await supabase.auth.setSession(saved);'),
    ).toEqual(['auth.setSession(']);
  });

  it('signInAnonymously NO es recovery, y un comentario tampoco', () => {
    expect(
      detectRecoveryRoutes('await supabase.auth.signInAnonymously();'),
    ).toEqual([]);
    expect(
      detectRecoveryRoutes('// algún día usaremos signInWithOtp aquí'),
    ).toEqual([]);
    expect(detectRecoveryRoutes('/* setSession queda descartado */')).toEqual(
      [],
    );
  });

  it('la guarda sigue en el back-fill, y antes de cualquier escritura', () => {
    const src = read('src/auth/identityMarker.ts');
    const body = src.slice(
      src.indexOf('export async function backfillIdentityAnchor'),
    );
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
    for (const forbidden of [
      'process.env',
      'EXPO_PUBLIC',
      'let ',
      'function ',
    ]) {
      expect(declaration.includes(forbidden), `forbidden: ${forbidden}`).toBe(
        false,
      );
    }
  });
});
