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
  // GC-AUTH-ANCHOR-MALFORMED-001 — a read that THROWS is its own state now,
  // so the harness has to be able to produce one. Same seam
  // `legacyProbeSeal.test.ts` already uses.
  const failReads = new Set<string>();
  return {
    default: {
      __store__: store,
      __failWrites__: failWrites,
      __failReads__: failReads,
      getItem: vi.fn(async (k: string) => {
        if (failReads.has(k)) throw new Error('storage read failed');
        return store.get(k) ?? null;
      }),
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
  backfillIdentityAnchor,
  checkIdentityContinuity,
  markIdentityInitialized,
  readIdentityMarker,
  readIdentityMarkerState,
} from '@/auth/identityMarker';
import { RECOVERY_ENTRY_IMPLEMENTED } from '@/auth/recoveryEntry';
import {
  __resetOwnershipLatchForTests,
  getOwnershipAccessToken,
  getOwnershipToken,
  isOwnershipGateOpen,
} from '@/auth/store';
import { supabase } from '@/auth/supabase';

const HISTORICAL = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

/** Same first 8 characters as HISTORICAL, different identity. */
const SAME_PREFIX_OTHER = '11111111-ffff-ffff-ffff-ffffffffffff';

type MockedStorage = typeof AsyncStorage & {
  __store__: Map<string, string>;
  __failWrites__: Set<string>;
  __failReads__: Set<string>;
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
  storage.__failReads__.clear();
  vi.clearAllMocks();
  getSession.mockReset();
  __resetOwnershipLatchForTests();
});

describe('G-R1 · creación de identidad nueva', () => {
  it('una identidad nueva guarda el UUID COMPLETO como ancla', async () => {
    const { marker, persisted } = await markIdentityInitialized(HISTORICAL);

    expect(persisted).toBe(true);
    expect(marker?.user_id).toBe(HISTORICAL);
    // Y el diagnóstico sigue siendo el diagnóstico.
    expect(marker?.sub_prefix).toBe('11111111');
    expect(marker?.version).toBe(1);
  });

  it('sin id disponible no inventa un ancla', async () => {
    const { marker } = await markIdentityInitialized(null);
    expect(marker?.user_id).toBeUndefined();
    expect(marker?.sub_prefix).toBeNull();
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

  it('un marker corrupt NO permite back-fill', async () => {
    storage.__store__.set(IDENTITY_KEY, '{not json');

    expect(await backfillIdentityAnchor(HISTORICAL)).toEqual({
      anchored: false,
      reason: 'marker_corrupt',
    });
  });

  it('un marker ilegible NO permite back-fill, y se dice por qué', async () => {
    storage.__failReads__.add(IDENTITY_KEY);

    expect(await backfillIdentityAnchor(HISTORICAL)).toEqual({
      anchored: false,
      reason: 'marker_unreadable',
    });
  });

  // El invariante de compatibilidad, en dos tests que van juntos: una
  // PROPIEDAD ausente es elegible; una propiedad presente e inválida no.
  it.each([
    ['cadena vacía', ''],
    ['null', null],
    ['un número', 42],
    ['un objeto', { nested: true }],
  ])('user_id inválido (%s) NO es elegible para back-fill', async (_l, bad) => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: bad,
    });
    const before = storage.__store__.get(IDENTITY_KEY);

    expect(await backfillIdentityAnchor(OTHER)).toEqual({
      anchored: false,
      reason: 'marker_corrupt',
    });
    // Y sobre todo: el valor inválido SOBREVIVE. No se sustituye por la
    // identidad de la sesión viva, que es justo la causa 2 de H1.
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(before);
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
 * GC-AUTH-ANCHOR-MALFORMED-001 — el marker ilegible ya no se sustituye.
 *
 * ESTOS TESTS DOCUMENTABAN EL DEFECTO. Ahora fijan la conducta corregida.
 *
 * Causa 1: `readIdentityMarker()` colapsaba `corrupt` y `unreadable` en el
 * mismo `null` que produce una ranura vacía, y `markIdentityInitialized()`
 * leía ese `null` como «aquí no hay nada» y SUSTITUÍA los bytes, fabricando
 * un `user_id` anclado a la sesión que hubiera viva.
 *
 * Causa 2: la guarda write-once del back-fill era «¿es una string no
 * vacía?», de modo que un `user_id` PRESENTE PERO INVÁLIDO no contaba como
 * ancla y caía directamente en la escritura.
 *
 * La regla ahora: la validez se decide en `readIdentityMarkerState()`, y
 * `setItem` sólo ocurre si el estado observado es exactamente `absent`.
 * Negarse a escribir ES la preservación: nada borra la clave.
 */
describe('GC-AUTH-ANCHOR-MALFORMED-001 · la tabla de lectura', () => {
  it('null es la ÚNICA ausencia', async () => {
    expect(await readIdentityMarkerState()).toEqual({ kind: 'absent' });
  });

  it('una lectura que lanza es unreadable, no una ausencia', async () => {
    storage.__failReads__.add(IDENTITY_KEY);
    expect(await readIdentityMarkerState()).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['cadena vacía', ''],
    ['JSON truncado', '{"version":1,"initialized_at":'],
    ['JSON basura', 'garbage'],
    ['no es un objeto', '"soy una cadena"'],
    ['null literal', 'null'],
    ['version futura', '{"version":2,"initialized_at":1}'],
    ['version desconocida', '{"version":99,"initialized_at":1}'],
    ['initialized_at no numérico', '{"version":1,"initialized_at":"ayer"}'],
    ['initialized_at ausente', '{"version":1}'],
    ['user_id vacío', '{"version":1,"initialized_at":1,"user_id":""}'],
    ['user_id null', '{"version":1,"initialized_at":1,"user_id":null}'],
    ['user_id numérico', '{"version":1,"initialized_at":1,"user_id":42}'],
  ])('%s es corrupt, nunca absent', async (_label, raw) => {
    storage.__store__.set(IDENTITY_KEY, raw);
    expect(await readIdentityMarkerState()).toEqual({ kind: 'corrupt' });
  });

  // El invariante de compatibilidad, leído desde la propia lectura.
  it('la PROPIEDAD user_id ausente sigue siendo un marker válido pre-G-R1', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: 'abcdefff',
      migrated_from_legacy: false,
    });
    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('present');
    if (read.kind !== 'present') throw new Error('unreachable');
    expect('user_id' in read.marker).toBe(false);
  });

  it('una user_id string no vacía es un marker anclado', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('present');
    if (read.kind !== 'present') throw new Error('unreachable');
    expect(read.marker.user_id).toBe(HISTORICAL);
  });
});

describe('GC-AUTH-ANCHOR-MALFORMED-001 · la escritura sólo ocurre en absent', () => {
  it('absent crea el marker', async () => {
    const w = await markIdentityInitialized(HISTORICAL);
    expect(w).toMatchObject({ persisted: true, source: 'created' });
    expect(w.marker?.user_id).toBe(HISTORICAL);
  });

  it('present devuelve el existente sin reescribir', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    const before = storage.__store__.get(IDENTITY_KEY);

    const w = await markIdentityInitialized(OTHER);

    expect(w).toMatchObject({ persisted: true, source: 'existing' });
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(before);
  });

  it('corrupt RECHAZA, sin marker y sin reclamar durabilidad', async () => {
    const CORRUPT = '{"version":1,"initialized_at":';
    storage.__store__.set(IDENTITY_KEY, CORRUPT);

    expect(await markIdentityInitialized(OTHER)).toEqual({
      persisted: false,
      marker: null,
      reason: 'marker_corrupt',
    });
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(CORRUPT);
  });

  it('unreadable RECHAZA, y no escribe nada en la ranura', async () => {
    storage.__failReads__.add(IDENTITY_KEY);

    expect(await markIdentityInitialized(OTHER)).toEqual({
      persisted: false,
      marker: null,
      reason: 'marker_unreadable',
    });
    expect(storage.__store__.has(IDENTITY_KEY)).toBe(false);
  });
});

describe('GC-AUTH-ANCHOR-MALFORMED-001 · la composición, que es el corazón', () => {
  it('corrupt + latch cerrado + sesión viva: ni sustituye bytes ni emite token', async () => {
    const CORRUPT = '{"version":1,"initialized_at":';
    storage.__store__.set(IDENTITY_KEY, CORRUPT);
    withSession(OTHER);

    const own = await getOwnershipToken();

    // 1 · los bytes originales sobreviven BYTE A BYTE.
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(CORRUPT);
    // 2 · no aparece ningún ancla fabricada.
    expect(await readIdentityMarkerState()).toEqual({ kind: 'corrupt' });
    // 3 · y la puerta NO concede.
    expect(own).toEqual({
      ok: false,
      reason: 'marker_not_durable',
      name: null,
    });
  });

  it('un marker legacy corrupto no pierde su guarda por sustitución', async () => {
    const LEGACY_CORRUPT =
      '{"version":1,"initialized_at":1,"sub_prefix":null,"migrated_from_legacy":true';
    storage.__store__.set(IDENTITY_KEY, LEGACY_CORRUPT);
    withSession(HISTORICAL);

    await getOwnershipToken();

    // `migrated_from_legacy: true` es una guarda del back-fill. Antes se
    // perdía silenciosamente al sustituir; ahora los bytes siguen ahí.
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(LEGACY_CORRUPT);
  });

  it('version futura + sesión viva: tampoco sustituye (rollback desde v2)', async () => {
    const V2 = '{"version":2,"initialized_at":999,"user_id":"quien-sea"}';
    storage.__store__.set(IDENTITY_KEY, V2);
    withSession(OTHER);

    expect((await getOwnershipToken()).ok).toBe(false);
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(V2);
  });

  it('un unreadable transitorio no deja secuela cuando la lectura vuelve', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    const before = storage.__store__.get(IDENTITY_KEY);
    withSession(HISTORICAL);

    // Fallo transitorio: se niega, sin escribir.
    storage.__failReads__.add(IDENTITY_KEY);
    expect((await getOwnershipToken()).ok).toBe(false);
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(before);

    // La lectura vuelve a funcionar y la puerta abre con el ancla ORIGINAL.
    storage.__failReads__.clear();
    expect((await getOwnershipToken()).ok).toBe(true);
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(before);
  });

  it('el marker anclado + la sesión correcta sigue funcionando igual', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    withSession(HISTORICAL);

    expect((await getOwnershipToken()).ok).toBe(true);
  });

  it('el marker pre-G-R1 sin la propiedad user_id sigue recibiendo back-fill', async () => {
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: 'abcdefff',
      migrated_from_legacy: false,
    });
    withSession(HISTORICAL);

    expect((await getOwnershipToken()).ok).toBe(true);
    expect((await readIdentityMarker())?.user_id).toBe(HISTORICAL);
    // Y lo histórico no se toca.
    expect((await readIdentityMarker())?.initialized_at).toBe(123);
  });

  it('ninguna de estas rutas borra gc.identity.v1', async () => {
    const CORRUPT = '{"version":1,"initialized_at":';
    for (const raw of [CORRUPT, '', 'garbage']) {
      storage.__store__.set(IDENTITY_KEY, raw);
      withSession(OTHER);
      await getOwnershipToken();
      expect(storage.__store__.get(IDENTITY_KEY)).toBe(raw);
    }
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it('la captura local no queda bloqueada: nunca lanza, sólo devuelve null', async () => {
    storage.__store__.set(IDENTITY_KEY, '{not json');
    withSession(OTHER);

    await expect(getOwnershipAccessToken()).resolves.toBeNull();
  });

  // El caso que faltaba: la corrupción llega DESPUÉS de que la puerta se
  // abriera legítimamente. `markerKnownDurable` cachea un hecho
  // irreversible y sigue abierto, así que es la continuidad —releída del
  // disco en cada emisión— la única cosa que puede negar aquí. Si la
  // autoridad anterior se pudiera reutilizar, este test pasaría token.
  it('corrupción TRAS abrir el latch: la autoridad anterior no se reutiliza', async () => {
    const GOOD = {
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    };
    await writeMarker(GOOD);
    withSession(HISTORICAL);

    // 1-3 · marker válido, sesión histórica coincidente, puerta abierta
    //       legítimamente.
    expect((await getOwnershipToken()).ok).toBe(true);
    expect(isOwnershipGateOpen()).toBe(true);

    // 4 · y AHORA se corrompe el almacenamiento.
    const CORRUPT = '{"version":1,"initialized_at":';
    storage.__store__.set(IDENTITY_KEY, CORRUPT);
    const writesBefore = (
      AsyncStorage.setItem as unknown as { mock: { calls: unknown[] } }
    ).mock.calls.length;

    // 5 · la llamada posterior.
    const own = await getOwnershipToken();

    // No se emite token, y el motivo es el fail-closed de continuidad:
    // con el latch abierto no se pasa por `ensureIdentityMarkerDurable`,
    // así que quien niega es `checkIdentityContinuity`.
    expect(own).toEqual({
      ok: false,
      reason: 'continuity_unverifiable',
      name: null,
    });

    // Los bytes corruptos NO se sustituyen, y no hubo back-fill: cero
    // escrituras nuevas en la ranura.
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(CORRUPT);
    expect(
      (AsyncStorage.setItem as unknown as { mock: { calls: unknown[] } })
        .mock.calls.length,
    ).toBe(writesBefore);
    expect(await backfillIdentityAnchor(HISTORICAL)).toEqual({
      anchored: false,
      reason: 'marker_corrupt',
    });
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(CORRUPT);

    // Ninguna identidad nueva y ningún borrado.
    expect(supabase.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();

    // Y el punto del test: el latch de DURABILIDAD sigue abierto —es un
    // hecho que no revierte— y aun así no hay token. La durabilidad por sí
    // sola dejó de ser autoridad suficiente.
    expect(isOwnershipGateOpen()).toBe(true);
  });
});

/**
 * R1 — un hueco vacío no siempre es una primera identidad.
 *
 * `markIdentityInitialized()` creaba un marker anclado a la sesión viva en
 * cuanto la ranura estaba vacía. Para una instalación limpia eso es
 * correcto: el mint acaba de crear ese id, no hay nada que contradecir.
 * Pero la ranura también puede estar vacía porque existió una identidad y
 * su marker nunca aterrizó, y ahí anclar la sesión del momento es una
 * conjetura vestida de hecho.
 *
 * `hasProvenIdentityEvidence()` distingue los dos casos **en un solo
 * sentido**: lee si alguna identidad ya consiguió un chunk confirmado fuera
 * del dispositivo desde este install, lo que no es falsificable en local
 * —esa escritura necesitó un `OwnershipToken`, que necesitó un marker
 * durable—. Es un VETO y sólo un veto: prueba que existió ALGUNA identidad,
 * jamás cuál, y nunca autoriza a la sesión actual.
 *
 * Hoy la identidad equivocada no es alcanzable —la única ruta que instala
 * sesión es el mint anónimo, que exige marker ausente—, pero eso es una
 * propiedad de este build y es justo lo que elimina una entrada de
 * recuperación. `BLOCKER BEFORE RECOVERY ENTRY`.
 */
describe('R1 · la evidencia previa veta el anclaje, y nada más', () => {
  const QUEUE_KEY = 'test.pending_retry';

  /** Un chunk confirmado fuera del dispositivo: necesitó un OwnershipToken. */
  async function writeProvenEvidence(): Promise<void> {
    storage.__store__.set(
      QUEUE_KEY,
      JSON.stringify([
        {
          session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          session_completed: false,
          chunks: [
            { chunk_index: 0, status: 'uploaded', remote_reference: '1AbCdEf' },
          ],
        },
      ]),
    );
  }

  /** Rastros de captura local-first: NO prueban que nada saliera del móvil. */
  async function writeUnprovenTraces(): Promise<void> {
    storage.__store__.set(
      QUEUE_KEY,
      JSON.stringify([
        {
          session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          session_completed: false,
          chunks: [
            { chunk_index: 0, status: 'pending', remote_reference: null },
          ],
        },
      ]),
    );
  }

  it('instalación limpia: sigue creando el ancla', async () => {
    const w = await markIdentityInitialized(HISTORICAL);

    expect(w).toMatchObject({ persisted: true, source: 'created' });
    expect(w.marker?.user_id).toBe(HISTORICAL);
  });

  it('una cola SIN confirmación remota no veta: sigue creando el ancla', async () => {
    await writeUnprovenTraces();

    const w = await markIdentityInitialized(HISTORICAL);

    expect(w).toMatchObject({ persisted: true, source: 'created' });
    expect(w.marker?.user_id).toBe(HISTORICAL);
  });

  it('absent + evidencia previa + sesión viva: NO fabrica ancla', async () => {
    await writeProvenEvidence();

    expect(await markIdentityInitialized(HISTORICAL)).toEqual({
      persisted: false,
      marker: null,
      reason: 'prior_identity_unverifiable',
    });
    expect(storage.__store__.has(IDENTITY_KEY)).toBe(false);
  });

  it('session_completed también cuenta como evidencia', async () => {
    storage.__store__.set(
      QUEUE_KEY,
      JSON.stringify([{ session_id: 'x', session_completed: true, chunks: [] }]),
    );

    expect((await markIdentityInitialized(HISTORICAL)).persisted).toBe(false);
    expect(storage.__store__.has(IDENTITY_KEY)).toBe(false);
  });

  it('la sesión candidata no se convierte en histórica, y no hay token', async () => {
    await writeProvenEvidence();
    const queueBefore = storage.__store__.get(QUEUE_KEY);
    withSession(OTHER);

    const own = await getOwnershipToken();

    // Sin token, y por la razón honesta: el marker no es durable.
    expect(own).toEqual({
      ok: false,
      reason: 'marker_not_durable',
      name: null,
    });
    // Y sobre todo: OTHER no aparece en ninguna parte del almacenamiento.
    expect(storage.__store__.has(IDENTITY_KEY)).toBe(false);
    for (const v of storage.__store__.values()) {
      expect(v).not.toContain(OTHER);
    }
    // La cola intacta, byte a byte, y nada borrado.
    expect(storage.__store__.get(QUEUE_KEY)).toBe(queueBefore);
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    // Ninguna segunda identidad anónima.
    expect(supabase.auth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('la captura local sigue disponible: devuelve null sin lanzar', async () => {
    await writeProvenEvidence();
    withSession(OTHER);

    await expect(getOwnershipAccessToken()).resolves.toBeNull();
  });

  it('reinicio tras un fallo de escritura: otra sesión no se adopta', async () => {
    // Proceso 1: la identidad histórica existe, su marker NO llega a disco.
    await writeProvenEvidence();
    storage.__failWrites__.add(IDENTITY_KEY);
    withSession(HISTORICAL);
    expect((await markIdentityInitialized(HISTORICAL)).persisted).toBe(false);
    expect(storage.__store__.has(IDENTITY_KEY)).toBe(false);

    // Proceso 2: almacenamiento sano otra vez, pero la sesión es OTRA.
    storage.__failWrites__.clear();
    __resetOwnershipLatchForTests();
    withSession(OTHER);

    expect((await getOwnershipToken()).ok).toBe(false);
    expect(storage.__store__.has(IDENTITY_KEY)).toBe(false);
  });

  it('P3 · el estampado legacy (userId null) NO se veta', async () => {
    await writeProvenEvidence();

    const w = await markIdentityInitialized(null, {
      migratedFromLegacy: true,
    });

    expect(w.persisted).toBe(true);
    expect(w.marker?.migrated_from_legacy).toBe(true);
    expect(w.marker?.user_id).toBeUndefined();
  });

  it('G-R1 · un marker pre-G-R1 present sigue recibiendo back-fill', async () => {
    // El veto vive en la rama `absent`. Un marker presente sin anclar no
    // cambia de comportamiento, haya evidencia o no.
    await writeProvenEvidence();
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: 'abcdefff',
      migrated_from_legacy: false,
    });
    withSession(HISTORICAL);

    expect((await getOwnershipToken()).ok).toBe(true);
    expect((await readIdentityMarker())?.user_id).toBe(HISTORICAL);
    expect((await readIdentityMarker())?.initialized_at).toBe(123);
  });

  it('H1 · corrupt se sigue rechazando como corrupt, no como R1', async () => {
    await writeProvenEvidence();
    storage.__store__.set(IDENTITY_KEY, '{not json');

    expect(await markIdentityInitialized(HISTORICAL)).toEqual({
      persisted: false,
      marker: null,
      reason: 'marker_corrupt',
    });
  });

  it('H1 · unreadable se sigue rechazando como unreadable', async () => {
    await writeProvenEvidence();
    storage.__failReads__.add(IDENTITY_KEY);

    expect(await markIdentityInitialized(HISTORICAL)).toEqual({
      persisted: false,
      marker: null,
      reason: 'marker_unreadable',
    });
  });

  it('un marker ya anclado conserva su write-once', async () => {
    await writeProvenEvidence();
    await writeMarker({
      version: 1,
      initialized_at: 123,
      sub_prefix: '11111111',
      migrated_from_legacy: false,
      user_id: HISTORICAL,
    });
    const before = storage.__store__.get(IDENTITY_KEY);

    const w = await markIdentityInitialized(OTHER);

    expect(w).toMatchObject({ persisted: true, source: 'existing' });
    expect(storage.__store__.get(IDENTITY_KEY)).toBe(before);
  });

  it('una cola ilegible no veta: el veto falla a favor de lo anterior', async () => {
    // `hasProvenIdentityEvidence()` devuelve false ante un JSON roto. Es un
    // falso negativo deliberado: degrada a la conducta previa, no inventa.
    storage.__store__.set(QUEUE_KEY, '{not json');

    expect((await markIdentityInitialized(HISTORICAL)).persisted).toBe(true);
  });
});
