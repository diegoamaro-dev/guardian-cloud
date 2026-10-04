/**
 * G-R1 — the durable identity anchor and the ownership continuity gate.
 *
 * The hole this closes: `gc.identity.v1` proved that an identity had
 * existed, and nothing proved WHICH one. A recovered session was therefore
 * indistinguishable from the historical identity, so a wrong-but-valid
 * session could have created remote ownership over somebody else's
 * evidence — or orphaned the device's own.
 *
 * The rule pinned here:
 *
 *   An `OwnershipToken` exists only when the live session's `user.id` is
 *   byte-for-byte the anchored one. Absence of an anchor is NOT a match.
 *
 * Two properties get their own tests because they are the ones a future
 * refactor is most likely to break:
 *
 *   · `sub_prefix` cannot rescue a mismatching anchor. It is diagnostic,
 *     and a correlation aid that decides nothing.
 *   · continuity is re-decided from disk on every issuance, never cached.
 *     A durable marker cannot revert; continuity can, inside one process.
 *
 * What is NOT proven here: anything about recovery itself. `signInWithOtp`
 * and `verifyOtp` do not exist yet. These tests exercise the gate that must
 * already be closed before they do.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

// The factory is hoisted above the `const getSession` above it, so the
// reference has to be dereferenced LAZILY — at call time, not at factory
// time. Same shape `ownershipGate.test.ts` uses, for the same reason.
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

// `tests/setup.ts` mocks `@/auth/store` globally so screen tests get an open
// gate for free. This file is testing the real authority, so it takes the
// real module — same escape hatch `ownershipGate.test.ts` uses.
vi.mock('@/auth/store', async () => await vi.importActual('@/auth/store'));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  IDENTITY_KEY,
  RECOVERY_ENTRY_IMPLEMENTED,
  backfillIdentityAnchor,
  checkIdentityContinuity,
  markIdentityInitialized,
  readIdentityMarker,
  readIdentityMarkerState,
} from '@/auth/identityMarker';
import {
  __resetOwnershipLatchForTests,
  getOwnershipToken,
} from '@/auth/store';

const HISTORICAL = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

/** Same first 8 characters as HISTORICAL, different identity. */
const SAME_PREFIX_OTHER = '11111111-ffff-ffff-ffff-ffffffffffff';

type MockedStorage = typeof AsyncStorage & {
  __store__: Map<string, string>;
  __failWrites__: Set<string>;
};
const storage = AsyncStorage as MockedStorage;

function withSession(userId: string | null): void {
  getSession.mockResolvedValue({
    data: {
      session: userId
        ? { access_token: 'tok', user: { id: userId } }
        : null,
    },
    error: null,
  });
}

async function writeMarker(marker: Record<string, unknown>): Promise<void> {
  storage.__store__.set(IDENTITY_KEY, JSON.stringify(marker));
}

beforeEach(() => {
  storage.__store__.clear();
  storage.__failWrites__.clear();
  getSession.mockReset();
  __resetOwnershipLatchForTests();
});

describe('G-R1 · creación de identidad nueva', () => {
  it('una identidad nueva guarda el UUID COMPLETO como ancla', async () => {
    const { marker, persisted } = await markIdentityInitialized(HISTORICAL);

    expect(persisted).toBe(true);
    expect(marker.user_id).toBe(HISTORICAL);
    // Y el diagnóstico sigue siendo el diagnóstico.
    expect(marker.sub_prefix).toBe('11111111');
    expect(marker.version).toBe(1);
  });

  it('sin id disponible no inventa un ancla', async () => {
    const { marker } = await markIdentityInitialized(null);
    expect(marker.user_id).toBeUndefined();
    expect(marker.sub_prefix).toBeNull();
  });
});

describe('G-R1 · back-fill — sólo donde es justificable', () => {
  it('marker antiguo válido + sesión viva: ancla', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
    });

    const result = await backfillIdentityAnchor(HISTORICAL);

    expect(result).toEqual({ anchored: true, source: 'written' });
    expect((await readIdentityMarker())?.user_id).toBe(HISTORICAL);
  });

  it('el back-fill NO modifica ningún campo histórico', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 987654321,
      sub_prefix: 'deadbeef',
      migrated_from_legacy: false,
    });

    await backfillIdentityAnchor(HISTORICAL);
    const after = await readIdentityMarker();

    expect(after?.initialized_at).toBe(987654321);
    // Un prefijo que NO corresponde al ancla se conserva tal cual: es un
    // dato histórico, no una afirmación que el back-fill deba "corregir".
    expect(after?.sub_prefix).toBe('deadbeef');
    expect(after?.migrated_from_legacy).toBe(false);
    expect(after?.version).toBe(1);
  });

  it('un marker del legacy probe NO permite back-fill', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: null,
      migrated_from_legacy: true,
    });

    const result = await backfillIdentityAnchor(HISTORICAL);

    expect(result).toEqual({
      anchored: false,
      reason: 'migrated_from_legacy',
    });
    expect((await readIdentityMarker())?.user_id).toBeUndefined();
  });

  it('un marker malformed NO permite back-fill', async () => {
    storage.__store__.set(IDENTITY_KEY, '{not json');

    expect(await backfillIdentityAnchor(HISTORICAL)).toEqual({
      anchored: false,
      reason: 'marker_malformed',
    });
  });

  it('sin marker no hay nada que anclar', async () => {
    expect(await backfillIdentityAnchor(HISTORICAL)).toEqual({
      anchored: false,
      reason: 'no_marker',
    });
  });

  it('el ancla NUNCA se sobrescribe, ni con otra identidad', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });

    const result = await backfillIdentityAnchor(OTHER);

    expect(result).toEqual({ anchored: true, source: 'already_present' });
    // Esto es el corazón del diseño: un desacuerdo se resuelve rechazando
    // la sesión, nunca moviendo el ancla hacia ella.
    expect((await readIdentityMarker())?.user_id).toBe(HISTORICAL);
  });

  it('este build no implementa entrada de recuperación', () => {
    // Si alguien lo pone a true sin resolver `recovery_attempted`, el
    // back-fill se apaga y este test documenta por qué.
    expect(RECOVERY_ENTRY_IMPLEMENTED).toBe(false);
  });
});

describe('G-R1 · la puerta de ownership', () => {
  it('UUID igual → emite OwnershipToken', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    withSession(HISTORICAL);

    const result = await getOwnershipToken();

    expect(result.ok).toBe(true);
  });

  it('UUID distinto → continuity_mismatch, sin token', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    withSession(OTHER);

    const result = await getOwnershipToken();

    expect(result).toEqual({
      ok: false,
      reason: 'continuity_mismatch',
      name: null,
    });
  });

  it('ancla ausente → continuity_unverifiable', async () => {
    // Legacy probe: ni ancla, ni back-fill posible.
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: null,
      migrated_from_legacy: true,
    });
    withSession(HISTORICAL);

    const result = await getOwnershipToken();

    expect(result).toEqual({
      ok: false,
      reason: 'continuity_unverifiable',
      name: null,
    });
  });

  it('un sub_prefix coincidente NO salva un user_id distinto', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      // El prefijo coincide con la sesión…
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      // …y el ancla no.
      user_id: HISTORICAL,
    });
    withSession(SAME_PREFIX_OTHER);

    expect(await getOwnershipToken()).toEqual({
      ok: false,
      reason: 'continuity_mismatch',
      name: null,
    });
    // Y la política pura dice lo mismo, sin pasar por la puerta.
    expect(await checkIdentityContinuity(SAME_PREFIX_OTHER)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('un fallo de escritura del back-fill NO abre la puerta', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
    });
    storage.__failWrites__.add(IDENTITY_KEY);
    withSession(HISTORICAL);

    const result = await getOwnershipToken();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Fail closed: sin ancla en disco, no verificable. Jamás un match.
      expect(result.reason).toBe('continuity_unverifiable');
    }
  });
});

describe('G-R1 · compatibilidad y ausencia de latch', () => {
  it('un marker v1 anterior a G-R1 sigue parseándose', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 42,
      sub_prefix: 'abcdefff',
      migrated_from_legacy: false,
    });

    const marker = await readIdentityMarker();

    expect(marker).not.toBeNull();
    expect(marker?.initialized_at).toBe(42);
    expect(marker?.user_id).toBeUndefined();
    // Ausencia significa NO VERIFICABLE, nunca coincidencia.
    expect(await checkIdentityContinuity('cualquiera')).toEqual({
      ok: false,
      reason: 'unverifiable',
    });
  });

  it('la continuidad se vuelve a decidir desde el marker, sin latch', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });

    // Primera emisión: la identidad anclada. Abre el latch de marker.
    withSession(HISTORICAL);
    expect((await getOwnershipToken()).ok).toBe(true);

    // Misma ejecución, otra identidad: el veredicto anterior NO se hereda.
    withSession(OTHER);
    expect(await getOwnershipToken()).toEqual({
      ok: false,
      reason: 'continuity_mismatch',
      name: null,
    });

    // Y al volver la anclada, vuelve a conceder: la decisión es por lectura
    // del marker durable, no un estado de proceso que se pega.
    withSession(HISTORICAL);
    expect((await getOwnershipToken()).ok).toBe(true);
  });

  it('sin sesión la razón sigue siendo no_session, no continuidad', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    withSession(null);

    expect(await getOwnershipToken()).toEqual({
      ok: false,
      reason: 'no_session',
      name: null,
    });
  });
});

/**
 * H1 — KNOWN LIMIT / BLOCKER BEFORE RECOVERY ENTRY.
 *
 * ESTE BLOQUE NO DESCRIBE UN COMPORTAMIENTO DESEADO. Fija el que existe
 * HOY, para que nadie lo cambie —ni lo arregle— sin verlo, y para que la
 * deuda sea visible desde la suite y no sólo desde un documento.
 *
 * `readIdentityMarker()` colapsa `malformed` en `null` para los callers del
 * camino feliz, y `markIdentityInitialized()` sólo preserva lo existente
 * cuando ese valor es truthy. Un marker ilegible es por tanto
 * INDISTINGUIBLE de un slot vacío para esa función: lo SUSTITUYE, y desde
 * G-R1 la sustitución incluye un `user_id` nuevo anclado a la sesión del
 * momento. Convierte «existió una identidad y no podemos decir cuál» en un
 * ancla confiada.
 *
 * Por qué esto NO emite hoy un token para una identidad incorrecta: la
 * única ruta que instala una sesión en este build es
 * `signInAnonymously()`, y exige `FIRST_IDENTITY`, que exige un marker
 * `absent` —no `malformed`—. La sesión viva sólo puede ser la histórica.
 * Esa propiedad es de ESTE build y de ninguno posterior: deja de valer en
 * cuanto exista OTP o cualquier entrada de recuperación, y entonces esta
 * ruta ancla a quien esté firmado en ese instante.
 *
 * Registrado como `GC-AUTH-ANCHOR-MALFORMED-001` en KNOWN_LIMITS.md §5,
 * ligado a `GC-AUTH-SESSION-RECOVERY-001`. No se corrige en G-R1.
 */
describe('H1 · KNOWN LIMIT — marker ilegible y ancla fabricada', () => {
  it('BLOCKER BEFORE RECOVERY · un marker malformed se sustituye y la sesión viva pasa a ser el ancla', async () => {
    // Bytes presentes —algo escribió aquí una vez— pero JSON truncado:
    // `readIdentityMarkerState` lo lee como 'malformed', que significa
    // «existió una identidad y no podemos decir cuál».
    const CORRUPT = '{"version":1,"initialized_at":';
    storage.__store__.set(IDENTITY_KEY, CORRUPT);
    expect((await readIdentityMarkerState()).kind).toBe('malformed');

    // AISLADO, el back-fill SÍ rechaza, y no toca los bytes: inventar un
    // ancla aquí sería inventar la respuesta. Su docstring lo dice.
    expect(await backfillIdentityAnchor(OTHER)).toEqual({
      anchored: false,
      reason: 'marker_malformed',
    });
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(CORRUPT);

    // EN LA COMPOSICIÓN REAL ese rechazo llega tarde. Con el latch cerrado,
    // `getOwnershipToken` pasa primero por `ensureIdentityMarkerDurable`.
    withSession(OTHER);
    const own = await getOwnershipToken();

    // 1 · el marker malformed ha sido REEMPLAZADO.
    const raw = storage.__store__.get(IDENTITY_KEY)!;
    expect(raw).not.toBe(CORRUPT);
    // 2 · y aparece un `user_id` nuevo, anclado a la sesión del momento.
    expect(JSON.parse(raw).user_id).toBe(OTHER);
    // 3 · y la puerta concede token para esa sesión.
    //     Hoy correcto por lo dicho arriba; mañana, no garantizado.
    expect(own.ok).toBe(true);
  });

  it('BLOCKER BEFORE RECOVERY · el reemplazo pierde la marca legacy, que es una guarda', async () => {
    // `migrated_from_legacy: true` es precisamente lo que hace que el
    // back-fill se niegue: el probe INFIRIÓ la identidad y no sabe cuál es.
    // Si esos bytes se vuelven ilegibles, el reemplazo vuelve con la guarda
    // a `false` y con `initialized_at` reescrito.
    storage.__store__.set(
      IDENTITY_KEY,
      '{"version":1,"initialized_at":1,"sub_prefix":null,"migrated_from_legacy":true',
    );
    withSession(HISTORICAL);
    await getOwnershipToken();

    const marker = JSON.parse(storage.__store__.get(IDENTITY_KEY)!);
    expect(marker.migrated_from_legacy).toBe(false);
    expect(marker.user_id).toBe(HISTORICAL);
    expect(marker.initialized_at).toBeGreaterThan(1);
  });
});
