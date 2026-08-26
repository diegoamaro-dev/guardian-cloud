/**
 * GC-AUTH-MIGRATION-001 — the legacy probe seal and the migration boundary.
 *
 * The defect, demonstrated on hardware on 2026-08-21:
 *
 *   fresh install → FIRST_IDENTITY → the mint fails (hosts unresolvable)
 *   → 4C allows a local-first capture → a queue entry, a pending
 *   registration and a history row appear → kill/restart → the legacy
 *   probe reads the app's OWN capture traces as proof of a historical
 *   identity → writes `migrated_from_legacy: true` → IDENTITY_DEGRADED
 *   → the only minting gate is closed forever.
 *
 * The root cause was an asymmetry, not a bad signal set:
 * `resolveIdentityInitialized` sealed the POSITIVE verdict (by writing the
 * marker) and sealed nothing at all for the negative one, so the probe
 * re-ran on every boot until something showed up. Local-first capture made
 * something show up.
 *
 * Both verdicts are sealed now, in `gc.legacy_probe.v1`. The first
 * evaluation of that seal is the migration boundary: git archaeology shows
 * `TOKEN_MISSING_AT_START` present continuously from `22d3f5e` through
 * `45357c4` and in every release tag, covering audio and native video, and
 * removed only by `8615ba6` — which is in no tag and not on main. So every
 * trace present at the boundary was written by a build that required a
 * token, and the probe's implication holds exactly there.
 *
 * Three properties are pinned here, and they are the ones that matter:
 *
 *   A. No negative legacy verdict can open FIRST_IDENTITY unless its seal
 *      is durable.                                     (15/A, 15/B, 15/C)
 *
 *   B. Before a local-first capture creates a legacy signal,
 *      migration-boundary RESOLUTION HAS RUN. If the negative verdict
 *      cannot be made durable, capture may proceed and the minting gate
 *      stays closed.                                  (the RACE describe)
 *
 *      Stated this way on purpose. The shorter "before the boundary is
 *      durably decided" is NOT true of the case we consciously accept:
 *      when the seal cannot be persisted even after the retry, the
 *      recording starts anyway, because evidence outranks migration
 *      hygiene. What holds is that resolution ran and that FIRST_IDENTITY
 *      is shut — not that the decision reached disk.
 *
 *   C. No successfully established anonymous identity can later be
 *      replaced merely because persistence of `gc.identity.v1` failed —
 *      nor because the follow-up seal invalidation failed as well.
 *                                              (3/A … 3/D, R4-A … R4-E)
 *
 * ── What is NOT proven here ──────────────────────────────────────────
 * The bootstrap is a closure inside a React component wired to supabase-js,
 * the native recorder and Expo's filesystem. `bootstrapOnce`,
 * `guardUndurableIdentity` and `guardedCapture` below are faithful
 * transcriptions of app/index.tsx, not the functions themselves — kept
 * deliberately small so a reader can check them against the source by eye.
 *
 * The hoist of `resolveIdentityInitialized()` to the top of the bootstrap
 * effect is a source-order property and is NOT what makes property B hold:
 * React commits the render, and paints an enabled GRABAR AHORA, before any
 * effect runs. What makes B hold is the single-flight latch that
 * `startRecording` awaits before its first durable write, and that IS
 * exercised here — with storage frozen mid-flight, so the interleaving is
 * observed rather than inferred from timing. Nothing below is dressed up
 * as a PASS it is not.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const signInAnonymously = vi.fn(async () => ({
  data: { user: null as { id: string } | null, session: null as unknown },
  error: null as { name: string } | null,
}));

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  const failWrites = new Set<string>();
  const failReads = new Set<string>();
  const failRemoves = new Set<string>();
  // Lets a test freeze storage mid-flight so the ordering between the
  // migration boundary and the first durable capture write is observable
  // rather than inferred from timing.
  const state: { hold: Promise<void> | null } = { hold: null };
  return {
    default: {
      __store__: store,
      __failWrites__: failWrites,
      __failReads__: failReads,
      __failRemoves__: failRemoves,
      __state__: state,
      getItem: vi.fn(async (k: string) => {
        if (state.hold) await state.hold;
        if (failReads.has(k)) throw new Error('storage read failed');
        return store.get(k) ?? null;
      }),
      setItem: vi.fn(async (k: string, v: string) => {
        if (state.hold) await state.hold;
        if (failWrites.has(k)) throw new Error('storage write failed');
        store.set(k, v);
      }),
      removeItem: vi.fn(async (k: string) => {
        if (state.hold) await state.hold;
        // R4: deleting is a storage operation too, and a defence that
        // assumes deletion always works is not a defence.
        if (failRemoves.has(k)) throw new Error('storage remove failed');
        store.delete(k);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

vi.mock('@/auth/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      signInAnonymously: (...a: unknown[]) =>
        (signInAnonymously as unknown as (...x: unknown[]) => unknown)(...a),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signOut: vi.fn(),
    },
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/auth/supabase';
import {
  IDENTITY_KEY,
  LEGACY_PROBE_KEY,
  LEGACY_PROBE_VERSION,
  decideIdentityState,
  ensureMigrationBoundary,
  invalidateLegacyProbeSeal,
  markIdentityInitialized,
  readIdentityMarkerState,
  readLegacyProbeSeal,
  resolveIdentityInitialized,
  type IdentityReason,
  type IdentityState,
  type LegacyProbeSeal,
} from '../src/auth/identityMarker';

const mock = AsyncStorage as unknown as {
  __store__: Map<string, string>;
  __failWrites__: Set<string>;
  __failReads__: Set<string>;
  __failRemoves__: Set<string>;
  __state__: { hold: Promise<void> | null };
  getItem: { mock: { calls: unknown[][] } };
};
const store = mock.__store__;

const HISTORY_KEY = 'history.sessions';
const QUEUE_KEY = 'test.pending_retry';
const PENDING_SESSIONS_KEY = 'guardian.pending_session_registrations';
const LAST_EXPORT_KEY = 'export.last_session_id';

const AUDIO_SID = '0feacfa8-a1ba-4eef-a1ed-278266dfc5f4';
const VIDEO_SID = '85f66ac0-62dd-45e6-9e92-027b942c7f9e';

/**
 * The identity branch of the bootstrap effect, transcribed. Compare with
 * app/index.tsx: resolve → decide → degraded returns → first identity
 * mints and marks → otherwise back-fills the marker.
 */
async function bootstrapOnce(opts: {
  hasSession?: boolean;
  hasError?: boolean;
  sessionUserId?: string;
}): Promise<{
  state: IdentityState;
  reason: IdentityReason;
  initialized: boolean;
  source: string;
  minted: boolean;
  markerDurable: boolean | null;
}> {
  const { initialized, source, boundaryUnsealed } =
    await resolveIdentityInitialized();
  const decision = decideIdentityState({
    hasSession: opts.hasSession === true,
    hasError: opts.hasError === true,
    initialized,
    boundaryUnsealed,
  });
  const base = {
    state: decision.state,
    reason: decision.reason,
    initialized,
    source,
  };

  if (decision.state === 'IDENTITY_DEGRADED') {
    return { ...base, minted: false, markerDurable: null };
  }
  if (decision.state === 'FIRST_IDENTITY') {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.session) {
      return { ...base, minted: false, markerDurable: null };
    }
    const mint = await markIdentityInitialized(data.user?.id ?? null);
    await guardUndurableIdentity(mint.persisted);
    return { ...base, minted: true, markerDurable: mint.persisted };
  }
  const backfill = await markIdentityInitialized(opts.sessionUserId ?? null);
  await guardUndurableIdentity(backfill.persisted);
  return { ...base, minted: false, markerDurable: backfill.persisted };
}

/** Transcribed from `guardUndurableIdentity` in app/index.tsx. */
async function guardUndurableIdentity(persisted: boolean): Promise<void> {
  if (persisted) return;
  await invalidateLegacyProbeSeal();
}

/**
 * The capture path's gate, transcribed from `startRecording`: await the
 * migration boundary, THEN perform the first durable write.
 */
async function guardedCapture(sessionId: string, mode: string): Promise<void> {
  await ensureMigrationBoundary();
  await localFirstCaptureTraces(sessionId, mode);
}

/** The durable footprint a local-first capture leaves. 4C writes all of
 *  this with no identity of any kind — that is the whole problem. */
async function localFirstCaptureTraces(sessionId: string, mode: string) {
  store.set(
    QUEUE_KEY,
    JSON.stringify([{ session_id: sessionId, recording_closed: false }]),
  );
  store.set(
    PENDING_SESSIONS_KEY,
    JSON.stringify([{ session_id: sessionId, mode, destination_type: 'drive' }]),
  );
  store.set(
    HISTORY_KEY,
    JSON.stringify([{ session_id: sessionId, mode, created_at: 'x' }]),
  );
  store.set(LAST_EXPORT_KEY, sessionId);
}

/**
 * What an ACTUAL upload leaves behind: a chunk confirmed off-device.
 * Unreachable without a token — `uploadChunkBytes` throws NO_TOKEN — so
 * this is the one local signal that proves an identity existed.
 */
function provenUpload(sessionId: string) {
  store.set(
    QUEUE_KEY,
    JSON.stringify([
      {
        session_id: sessionId,
        recording_closed: true,
        session_completed: false,
        chunks: [
          { chunk_index: 0, status: 'uploaded', remote_reference: '1AbCdEf' },
        ],
      },
    ]),
  );
}

function mintSucceeds(id = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111') {
  signInAnonymously.mockResolvedValue({
    data: { user: { id }, session: { access_token: 't' } },
    error: null,
  });
}
function mintFails(name = 'AuthRetryableFetchError') {
  signInAnonymously.mockResolvedValue({
    data: { user: null, session: null },
    error: { name },
  });
}
function probeReadCount(): number {
  return mock.getItem.mock.calls.filter(c => c[0] === HISTORY_KEY).length;
}

beforeEach(() => {
  store.clear();
  mock.__failWrites__.clear();
  mock.__failReads__.clear();
  mock.__failRemoves__.clear();
  vi.clearAllMocks();
  mintFails();
});

describe('TEST_FRESH_INSTALL_REACHES_ITS_FIRST_IDENTITY', () => {
  it('1. fresh install with a working network mints legitimately', async () => {
    mintSucceeds('11112222-3333-4444-8555-666677778888');
    const r = await bootstrapOnce({});

    expect(r.state).toBe('FIRST_IDENTITY');
    expect(r.minted).toBe(true);
    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('present');
    if (read.kind === 'present') {
      expect(read.marker.migrated_from_legacy).toBe(false);
      expect(read.marker.sub_prefix).toBe('11112222');
    }
  });

  it('2. a mint that fails seals a negative verdict and writes NO marker', async () => {
    const r = await bootstrapOnce({});

    expect(r.state).toBe('FIRST_IDENTITY');
    expect(r.minted).toBe(false);
    expect(store.has(IDENTITY_KEY)).toBe(false);

    const seal = await readLegacyProbeSeal();
    expect(seal).not.toBeNull();
    expect(seal?.legacy_identity_evidence).toBe(false);
    expect(seal?.probe_version).toBe(LEGACY_PROBE_VERSION);
  });

  it('3. THE DEFECT: audio capture then restart still resolves FIRST_IDENTITY', async () => {
    await bootstrapOnce({});
    await localFirstCaptureTraces(AUDIO_SID, 'audio');

    const second = await bootstrapOnce({});

    expect(second.state).toBe('FIRST_IDENTITY');
    expect(second.source).toBe('seal');
    expect(second.initialized).toBe(false);
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('4. identical for native video capture', async () => {
    await bootstrapOnce({});
    await localFirstCaptureTraces(VIDEO_SID, 'video');

    const second = await bootstrapOnce({});

    expect(second.state).toBe('FIRST_IDENTITY');
    expect(second.source).toBe('seal');
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('5. once the network returns the mint finally succeeds', async () => {
    await bootstrapOnce({});
    await localFirstCaptureTraces(AUDIO_SID, 'audio');
    await bootstrapOnce({});

    mintSucceeds('99998888-7777-4666-8555-444433332222');
    const recovered = await bootstrapOnce({});

    expect(recovered.state).toBe('FIRST_IDENTITY');
    expect(recovered.minted).toBe(true);
    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('present');
    if (read.kind === 'present') {
      // A real identity, not a migrated guess.
      expect(read.marker.migrated_from_legacy).toBe(false);
      expect(read.marker.sub_prefix).toBe('99998888');
    }
    // The capture traces are untouched by any of this.
    expect(store.get(QUEUE_KEY)).toContain(AUDIO_SID);
    expect(store.get(PENDING_SESSIONS_KEY)).toContain(AUDIO_SID);
  });

  it('11. the localSessionId survives a kill between capture and mint', async () => {
    await bootstrapOnce({});
    await localFirstCaptureTraces(AUDIO_SID, 'audio');

    mintSucceeds();
    await bootstrapOnce({});

    expect(JSON.parse(store.get(QUEUE_KEY)!)[0].session_id).toBe(AUDIO_SID);
    expect(JSON.parse(store.get(PENDING_SESSIONS_KEY)!)[0].session_id).toBe(
      AUDIO_SID,
    );
  });
});

describe('TEST_ESTABLISHED_IDENTITY_IS_NEVER_REPLACED', () => {
  it('6. a live session is IDENTITY_OK and back-fills the marker', async () => {
    const r = await bootstrapOnce({
      hasSession: true,
      sessionUserId: 'deadbeef-0000-4111-8222-333344445555',
    });

    expect(r.state).toBe('IDENTITY_OK');
    expect(r.minted).toBe(false);
    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('present');
  });

  it('7. a valid marker with no session is DEGRADED and mints nothing', async () => {
    await markIdentityInitialized('cafebabe-1111-4222-8333-444455556666');

    const r = await bootstrapOnce({});

    expect(r.state).toBe('IDENTITY_DEGRADED');
    expect(r.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(r.source).toBe('marker');
  });

  it('14. ten offline boots on an established install mint nothing at all', async () => {
    await markIdentityInitialized('cafebabe-1111-4222-8333-444455556666');

    for (let i = 0; i < 10; i += 1) {
      const r = await bootstrapOnce({ hasError: i % 2 === 0 });
      expect(r.state).toBe('IDENTITY_DEGRADED');
    }

    expect(signInAnonymously).not.toHaveBeenCalled();
    // No seal was ever needed: the marker short-circuits before it.
    expect(store.has(LEGACY_PROBE_KEY)).toBe(false);
    expect(probeReadCount()).toBe(0);
  });
});

describe('TEST_THE_MIGRATION_BOUNDARY', () => {
  it('8. a genuine legacy install seals TRUE and gets a migrated marker', async () => {
    // Traces written by a gated (pre-8615ba6) build.
    store.set(
      HISTORY_KEY,
      JSON.stringify([{ session_id: AUDIO_SID, mode: 'audio' }]),
    );

    const r = await bootstrapOnce({});

    expect(r.state).toBe('IDENTITY_DEGRADED');
    expect(r.minted).toBe(false);
    expect(r.source).toBe('probe');

    const seal = await readLegacyProbeSeal();
    expect(seal?.legacy_identity_evidence).toBe(true);

    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('present');
    if (read.kind === 'present') {
      expect(read.marker.migrated_from_legacy).toBe(true);
      expect(read.marker.sub_prefix).toBeNull();
    }
  });

  it('19. every pre-boundary signal on its own is enough', async () => {
    for (const key of [
      HISTORY_KEY,
      QUEUE_KEY,
      PENDING_SESSIONS_KEY,
      LAST_EXPORT_KEY,
    ]) {
      store.clear();
      store.set(
        key,
        key === LAST_EXPORT_KEY ? AUDIO_SID : JSON.stringify([{ a: 1 }]),
      );

      await resolveIdentityInitialized();
      const seal = await readLegacyProbeSeal();
      expect(seal?.legacy_identity_evidence, `signal ${key}`).toBe(true);
    }
  });

  it('20. history alone still detects identity after the queue was reaped', async () => {
    // The case that makes narrowing the signal set unsafe: a device that
    // uploaded everything has no queue and no remote_reference left.
    store.set(
      HISTORY_KEY,
      JSON.stringify([{ session_id: AUDIO_SID, mode: 'audio' }]),
    );
    store.set(QUEUE_KEY, JSON.stringify([]));
    store.set(PENDING_SESSIONS_KEY, JSON.stringify([]));

    const r = await bootstrapOnce({});

    expect(r.initialized).toBe(true);
    expect(r.state).toBe('IDENTITY_DEGRADED');
    expect(r.minted).toBe(false);
  });

  it('9. post-boundary traces cannot overturn a sealed negative', async () => {
    await resolveIdentityInitialized();
    await localFirstCaptureTraces(VIDEO_SID, 'video');

    const again = await resolveIdentityInitialized();

    expect(again.initialized).toBe(false);
    expect(again.source).toBe('seal');
    expect(again.marker).toBeNull();
  });

  it('10. a pending registration appearing later does not move a decided seal', async () => {
    await resolveIdentityInitialized();
    store.set(
      PENDING_SESSIONS_KEY,
      JSON.stringify([{ session_id: VIDEO_SID, mode: 'video' }]),
    );

    const again = await resolveIdentityInitialized();
    const seal = await readLegacyProbeSeal();

    expect(again.initialized).toBe(false);
    expect(seal?.legacy_identity_evidence).toBe(false);
  });

  it('13. the probe runs exactly once across many offline boots', async () => {
    for (let i = 0; i < 5; i += 1) {
      await bootstrapOnce({});
      await localFirstCaptureTraces(AUDIO_SID, 'audio');
    }

    expect(probeReadCount()).toBe(1);
    expect(signInAnonymously).toHaveBeenCalledTimes(5);
  });

  it('21. the seal is durable the instant resolution returns', async () => {
    // The hoist exists so nothing can write a trace between the probe and
    // the seal. What is observable here is that no await separates them:
    // the moment the caller regains control, the answer is already on disk.
    const r = await resolveIdentityInitialized();

    expect(r.source).toBe('probe');
    expect(store.has(LEGACY_PROBE_KEY)).toBe(true);

    // A capture starting now is powerless over the verdict.
    await localFirstCaptureTraces(AUDIO_SID, 'audio');
    expect((await resolveIdentityInitialized()).initialized).toBe(false);
  });
});

describe('TEST_MARKER_ABSENT_IS_NOT_MARKER_MALFORMED', () => {
  it('12. a malformed marker is conservative: degraded, zero mints', async () => {
    store.set(IDENTITY_KEY, '{not valid json');

    const r = await bootstrapOnce({});

    expect(r.state).toBe('IDENTITY_DEGRADED');
    expect(r.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(r.source).toBe('marker_malformed');
  });

  it('16. a sealed negative NEVER waves a malformed marker through', async () => {
    // The ownership bug the seal would have introduced if `absent` and
    // `malformed` had stayed collapsed together.
    await resolveIdentityInitialized();
    expect((await readLegacyProbeSeal())?.legacy_identity_evidence).toBe(false);

    store.set(IDENTITY_KEY, 'garbage');
    const r = await bootstrapOnce({});

    expect(r.state).toBe('IDENTITY_DEGRADED');
    expect(r.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('16b. a marker of the wrong shape counts as malformed, not absent', async () => {
    store.set(IDENTITY_KEY, JSON.stringify({ version: 99, initialized_at: 1 }));

    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('malformed');
    expect((await bootstrapOnce({})).state).toBe('IDENTITY_DEGRADED');
  });

  it('16c. an unreadable marker slot is malformed, never absent', async () => {
    mock.__failReads__.add(IDENTITY_KEY);

    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('malformed');
    expect((await bootstrapOnce({})).minted).toBe(false);
  });

  it('17. a genuinely absent marker with a sealed negative may mint', async () => {
    await resolveIdentityInitialized();
    mintSucceeds();

    const r = await bootstrapOnce({});

    expect(r.state).toBe('FIRST_IDENTITY');
    expect(r.minted).toBe(true);
    expect((await readIdentityMarkerState()).kind).toBe('present');
  });
});

describe('TEST_SEAL_CORRUPTION_IS_CONSERVATIVE', () => {
  it('18. a malformed seal is re-asked, and a re-ask cannot mint over evidence', async () => {
    store.set(HISTORY_KEY, JSON.stringify([{ session_id: AUDIO_SID }]));
    store.set(LEGACY_PROBE_KEY, '{{{corrupt');

    const r = await bootstrapOnce({});

    expect(r.state).toBe('IDENTITY_DEGRADED');
    expect(r.minted).toBe(false);
    expect(r.source).toBe('probe');
    // Self-healing: the corrupt seal is replaced, not re-read forever.
    expect((await readLegacyProbeSeal())?.legacy_identity_evidence).toBe(true);
  });

  it('18b. a corrupt seal on an install with no evidence re-seals negative', async () => {
    store.set(LEGACY_PROBE_KEY, 'null');

    const r = await bootstrapOnce({});

    expect(r.state).toBe('FIRST_IDENTITY');
    expect((await readLegacyProbeSeal())?.legacy_identity_evidence).toBe(false);
  });

  it('22. a seal from another probe_version is re-asked, not reinterpreted', async () => {
    const alien: LegacyProbeSeal = {
      version: 1,
      probe_version: LEGACY_PROBE_VERSION + 1,
      evaluated_at: 1,
      legacy_identity_evidence: false,
    };
    store.set(LEGACY_PROBE_KEY, JSON.stringify(alien));
    store.set(HISTORY_KEY, JSON.stringify([{ session_id: AUDIO_SID }]));

    const r = await bootstrapOnce({});

    // The alien negative is NOT trusted; the probe answers again and this
    // install is correctly recognised as having had an identity.
    expect(r.state).toBe('IDENTITY_DEGRADED');
    expect(r.minted).toBe(false);
    expect((await readLegacyProbeSeal())?.probe_version).toBe(
      LEGACY_PROBE_VERSION,
    );
  });

  it('15/A. FAIL CLOSED: an unsealed negative must NOT open FIRST_IDENTITY', async () => {
    mock.__failWrites__.add(LEGACY_PROBE_KEY);

    const r = await bootstrapOnce({});

    // The probe genuinely found nothing — `initialized` stays honest...
    expect(r.initialized).toBe(false);
    // ...but the gate stays shut because the finding is not on disk.
    expect(r.state).toBe('IDENTITY_DEGRADED');
    expect(r.reason).toBe('boundary_unsealed');
    expect(r.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(store.has(LEGACY_PROBE_KEY)).toBe(false);
    expect(store.has(IDENTITY_KEY)).toBe(false);
  });

  it('15/B. once storage recovers, the seal lands and FIRST_IDENTITY opens', async () => {
    mock.__failWrites__.add(LEGACY_PROBE_KEY);
    expect((await bootstrapOnce({})).state).toBe('IDENTITY_DEGRADED');

    mock.__failWrites__.clear();
    mintSucceeds('44445555-6666-4777-8888-99990000aaaa');
    const recovered = await bootstrapOnce({});

    expect(recovered.state).toBe('FIRST_IDENTITY');
    expect(recovered.minted).toBe(true);
    expect((await readLegacyProbeSeal())?.legacy_identity_evidence).toBe(false);
  });

  it('15/C. seal failure + later traces never produces an unsafe mint', async () => {
    mock.__failWrites__.add(LEGACY_PROBE_KEY);
    await bootstrapOnce({});
    // Storage recovers for everything EXCEPT the seal, and a capture runs.
    await localFirstCaptureTraces(AUDIO_SID, 'audio');

    const second = await bootstrapOnce({});

    expect(second.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(second.state).toBe('IDENTITY_DEGRADED');
  });

  it('15/D. TRANSIENT storage failure: the boundary gate re-seals and the install recovers', async () => {
    // The realistic shape. One failed write, then storage comes back
    // before the user records.
    mock.__failWrites__.add(LEGACY_PROBE_KEY);
    mintSucceeds();

    const boot1 = await bootstrapOnce({});
    expect(boot1.state).toBe('IDENTITY_DEGRADED');
    expect(boot1.reason).toBe('boundary_unsealed');
    expect(boot1.minted).toBe(false);

    // Storage recovers. `ensureMigrationBoundary` retries the seal at the
    // capture gate, so the boundary is closed BEFORE the first trace.
    mock.__failWrites__.clear();
    await guardedCapture(AUDIO_SID, 'audio');
    expect((await readLegacyProbeSeal())?.legacy_identity_evidence).toBe(false);

    const boot2 = await bootstrapOnce({});
    expect(boot2.state).toBe('FIRST_IDENTITY');
    expect(boot2.minted).toBe(true);
  });

  it('15/E. PERSISTENT storage failure: conservative, and ownership is never abandoned', async () => {
    // Honest about the residual. If the seal can never be written, the
    // boundary can never be closed, and traces written meanwhile will be
    // read as a prior identity on a later boot. That outcome is
    // IDENTITY_DEGRADED — the install is held, not silently re-minted.
    // Evidence is intact and no identity is abandoned. In the field this
    // shape is largely self-limiting: a device that cannot write the seal
    // cannot write the queue entry either.
    mock.__failWrites__.add(LEGACY_PROBE_KEY);
    mintSucceeds();

    expect((await bootstrapOnce({})).minted).toBe(false);
    await guardedCapture(AUDIO_SID, 'audio');
    signInAnonymously.mockClear();

    const boot2 = await bootstrapOnce({});
    expect(boot2.state).toBe('IDENTITY_DEGRADED');
    expect(boot2.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
    expect(store.get(QUEUE_KEY)).toContain(AUDIO_SID);
  });
});

describe('TEST_CAPTURE_CANNOT_OUTRUN_THE_MIGRATION_BOUNDARY', () => {
  it('RACE: no legacy signal is written before the boundary is decided', async () => {
    // Freeze storage so the interleaving is real, not a matter of timing.
    let release!: () => void;
    mock.__state__.hold = new Promise<void>(r => {
      release = r;
    });

    // The bootstrap effect starts resolving...
    const bootstrapResolution = resolveIdentityInitialized();
    // ...and the user taps GRABAR AHORA immediately. React commits the
    // render before effects run, so this really can happen first.
    const capture = guardedCapture(AUDIO_SID, 'audio');

    // Storage is frozen: nothing at all can have been written.
    await Promise.resolve();
    await Promise.resolve();
    expect(store.has(QUEUE_KEY)).toBe(false);
    expect(store.has(HISTORY_KEY)).toBe(false);
    expect(store.has(PENDING_SESSIONS_KEY)).toBe(false);
    expect(store.has(LAST_EXPORT_KEY)).toBe(false);

    release();
    mock.__state__.hold = null;
    await bootstrapResolution;
    await capture;

    // The seal exists AND records the honest pre-capture answer.
    const seal = await readLegacyProbeSeal();
    expect(seal).not.toBeNull();
    expect(seal?.legacy_identity_evidence).toBe(false);
    // The capture's own traces did land — they were simply too late to
    // be mistaken for a historical identity.
    expect(store.has(QUEUE_KEY)).toBe(true);
    expect((await resolveIdentityInitialized()).initialized).toBe(false);
  });

  it('RACE: a capture that wins the race still performs the probe itself', async () => {
    // With no bootstrap running at all, the capture path is the one that
    // establishes the boundary. Single-flight means it is the same work.
    await guardedCapture(VIDEO_SID, 'video');

    expect(store.has(LEGACY_PROBE_KEY)).toBe(true);
    expect((await readLegacyProbeSeal())?.legacy_identity_evidence).toBe(false);
    expect((await resolveIdentityInitialized()).initialized).toBe(false);
  });

  it('SINGLE-FLIGHT: concurrent callers run exactly one probe', async () => {
    const [a, b, c] = await Promise.all([
      resolveIdentityInitialized(),
      resolveIdentityInitialized(),
      resolveIdentityInitialized(),
    ]);

    expect(probeReadCount()).toBe(1);
    expect(a.source).toBe('probe');
    expect(b.source).toBe('probe');
    expect(c.source).toBe('probe');
  });

  it('the boundary gate waits on local storage only, never on the network', async () => {
    // `ensureMigrationBoundary` resolves with no session, no token and no
    // fetch in existence: a dead network can never hold a recording.
    vi.stubGlobal('fetch', () => {
      throw new Error('the capture gate must not touch the network');
    });
    await expect(ensureMigrationBoundary()).resolves.toEqual({ sealed: true });
    vi.unstubAllGlobals();
  });
});

describe('TEST_AN_ESTABLISHED_IDENTITY_SURVIVES_A_FAILED_MARKER_WRITE', () => {
  it('3/A. mint succeeds but the marker cannot be written: no second mint', async () => {
    await resolveIdentityInitialized(); // seal false, durable
    mock.__failWrites__.add(IDENTITY_KEY);
    mintSucceeds('a1a1a1a1-2222-4333-8444-555566667777');

    const first = await bootstrapOnce({});
    expect(first.minted).toBe(true);
    expect(first.markerDurable).toBe(false);
    // The stale "no prior identity" answer is withdrawn, so the next boot
    // cannot read marker-absent + seal-false as a fresh install.
    expect(store.has(LEGACY_PROBE_KEY)).toBe(false);

    // Session lost afterwards — the exact shape that minted identity B.
    signInAnonymously.mockClear();
    mock.__failWrites__.clear();
    await localFirstCaptureTraces(AUDIO_SID, 'audio');
    const second = await bootstrapOnce({});

    expect(second.state).toBe('IDENTITY_DEGRADED');
    expect(second.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('3/B. when the marker finally persists, identity A simply continues', async () => {
    await resolveIdentityInitialized();
    mock.__failWrites__.add(IDENTITY_KEY);
    mintSucceeds('a1a1a1a1-2222-4333-8444-555566667777');
    await bootstrapOnce({});

    // Storage recovers and the session is still alive: the back-fill
    // records identity A, unchanged.
    mock.__failWrites__.clear();
    const r = await bootstrapOnce({
      hasSession: true,
      sessionUserId: 'a1a1a1a1-2222-4333-8444-555566667777',
    });

    expect(r.state).toBe('IDENTITY_OK');
    expect(r.markerDurable).toBe(true);
    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('present');
    if (read.kind === 'present') {
      expect(read.marker.sub_prefix).toBe('a1a1a1a1');
      expect(read.marker.migrated_from_legacy).toBe(false);
    }
  });

  it('3/C. evidence uploaded under A is never orphaned by a silent B', async () => {
    await resolveIdentityInitialized();
    mock.__failWrites__.add(IDENTITY_KEY);
    mintSucceeds('a1a1a1a1-2222-4333-8444-555566667777');
    await bootstrapOnce({});
    mock.__failWrites__.clear();

    // A recorded and queued something while it held the session.
    await localFirstCaptureTraces(AUDIO_SID, 'audio');
    signInAnonymously.mockClear();

    // Session dies. Ten boots. Not one of them may mint.
    for (let i = 0; i < 10; i += 1) {
      const r = await bootstrapOnce({});
      expect(r.state).toBe('IDENTITY_DEGRADED');
      expect(r.minted).toBe(false);
    }
    expect(signInAnonymously).not.toHaveBeenCalled();
    // The evidence itself was never touched.
    expect(store.get(QUEUE_KEY)).toContain(AUDIO_SID);
  });

  it('3/D. a failed back-fill is never later read as a fresh install', async () => {
    await resolveIdentityInitialized();
    mock.__failWrites__.add(IDENTITY_KEY);

    const r = await bootstrapOnce({
      hasSession: true,
      sessionUserId: 'bbbbcccc-1111-4222-8333-444455556666',
    });
    expect(r.state).toBe('IDENTITY_OK');
    expect(r.markerDurable).toBe(false);
    expect(store.has(LEGACY_PROBE_KEY)).toBe(false);

    mock.__failWrites__.clear();
    await localFirstCaptureTraces(AUDIO_SID, 'audio');
    signInAnonymously.mockClear();

    const later = await bootstrapOnce({});
    expect(later.state).toBe('IDENTITY_DEGRADED');
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('R4-A. marker write fails AND seal removal fails: no shape that permits B', async () => {
    await resolveIdentityInitialized(); // durable seal, legacy_evidence=false
    mock.__failWrites__.add(IDENTITY_KEY);
    mock.__failRemoves__.add(LEGACY_PROBE_KEY);
    mintSucceeds('a1a1a1a1-2222-4333-8444-555566667777');

    const first = await bootstrapOnce({});
    expect(first.minted).toBe(true);
    expect(first.markerDurable).toBe(false);
    // The marker is absent. The stale negative seal is no longer
    // ACTIONABLE — removal failed, so the poisoned-version fallback ran.
    // Either way, what matters is that nothing readable says "no prior
    // identity" any more.
    expect(store.has(IDENTITY_KEY)).toBe(false);
    expect(await readLegacyProbeSeal()).toBeNull();

    // A uploaded something before the session died. That upload is what
    // creates the ownership at risk — and it is what proves A existed.
    provenUpload(AUDIO_SID);
    mock.__failWrites__.clear();
    mock.__failRemoves__.clear();
    signInAnonymously.mockClear();

    const second = await bootstrapOnce({});
    // Route is an implementation detail (poisoned seal -> probe, or seal
    // -> proven evidence). The GUARANTEE is the same either way.
    expect(second.state).toBe('IDENTITY_DEGRADED');
    expect(second.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('R4-B. ten boots after both failures still mint nothing', async () => {
    await resolveIdentityInitialized();
    mock.__failWrites__.add(IDENTITY_KEY);
    mock.__failRemoves__.add(LEGACY_PROBE_KEY);
    mintSucceeds();
    await bootstrapOnce({});

    // A queue holding BOTH: the session A actually uploaded, and a later
    // local-first capture that proves nothing. The real device would have
    // exactly this mix; only the first entry is evidence of identity.
    await localFirstCaptureTraces(VIDEO_SID, 'video');
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        {
          session_id: AUDIO_SID,
          recording_closed: true,
          session_completed: false,
          chunks: [
            { chunk_index: 0, status: 'uploaded', remote_reference: '1AbCdEf' },
          ],
        },
        {
          session_id: VIDEO_SID,
          recording_closed: false,
          session_completed: false,
          chunks: [{ chunk_index: 0, status: 'pending' }],
        },
      ]),
    );
    mock.__failWrites__.clear();
    mock.__failRemoves__.clear();
    signInAnonymously.mockClear();

    for (let i = 0; i < 10; i += 1) {
      const r = await bootstrapOnce({ hasError: i % 3 === 0 });
      expect(r.state).toBe('IDENTITY_DEGRADED');
      expect(r.minted).toBe(false);
    }
    expect(signInAnonymously).toHaveBeenCalledTimes(0);
  });

  it('R4-C. a transient invalidation failure converges without losing A', async () => {
    await resolveIdentityInitialized();
    mock.__failWrites__.add(IDENTITY_KEY);
    mock.__failRemoves__.add(LEGACY_PROBE_KEY);
    mintSucceeds('a1a1a1a1-2222-4333-8444-555566667777');
    await bootstrapOnce({});

    // Storage recovers and A still holds its session.
    mock.__failWrites__.clear();
    mock.__failRemoves__.clear();
    const r = await bootstrapOnce({
      hasSession: true,
      sessionUserId: 'a1a1a1a1-2222-4333-8444-555566667777',
    });

    expect(r.state).toBe('IDENTITY_OK');
    expect(r.markerDurable).toBe(true);
    const read = await readIdentityMarkerState();
    expect(read.kind).toBe('present');
    if (read.kind === 'present') expect(read.marker.sub_prefix).toBe('a1a1a1a1');
  });

  it('R4-D. an existing session whose back-fill AND invalidation fail is never fresh', async () => {
    await resolveIdentityInitialized();
    mock.__failWrites__.add(IDENTITY_KEY);
    mock.__failRemoves__.add(LEGACY_PROBE_KEY);

    const r = await bootstrapOnce({
      hasSession: true,
      sessionUserId: 'bbbbcccc-1111-4222-8333-444455556666',
    });
    expect(r.state).toBe('IDENTITY_OK');
    expect(r.markerDurable).toBe(false);
    expect(store.has(LEGACY_PROBE_KEY)).toBe(true);

    provenUpload(AUDIO_SID);
    mock.__failWrites__.clear();
    mock.__failRemoves__.clear();
    signInAnonymously.mockClear();

    const later = await bootstrapOnce({});
    expect(later.state).toBe('IDENTITY_DEGRADED');
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('R4-E. nothing destroyed: no signOut, no evidence removed', async () => {
    await resolveIdentityInitialized();
    provenUpload(AUDIO_SID);
    mock.__failWrites__.add(IDENTITY_KEY);
    mock.__failRemoves__.add(LEGACY_PROBE_KEY);
    mintSucceeds();

    const before = store.get(QUEUE_KEY);
    await bootstrapOnce({});

    expect(supabase.auth.signOut).not.toHaveBeenCalled();
    expect(store.get(QUEUE_KEY)).toBe(before);
    expect(store.has(LEGACY_PROBE_KEY)).toBe(true);
  });

  it('R4-F. a completed session is proof too, even with the queue drained of refs', async () => {
    await resolveIdentityInitialized();
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        { session_id: AUDIO_SID, session_completed: true, chunks: [] },
      ]),
    );

    const r = await bootstrapOnce({});
    expect(r.source).toBe('proven_identity');
    expect(r.minted).toBe(false);
  });

  it('R4-G. THE REGRESSION GUARD: 4C traces are NOT proof and must still mint', async () => {
    // The whole point. A local-first capture leaves pending chunks with no
    // remote_reference — measured on hardware, 0 of 43. If this ever
    // starts counting as proof, GC-AUTH-MIGRATION-001 is back.
    await resolveIdentityInitialized();
    await localFirstCaptureTraces(AUDIO_SID, 'audio');
    mintSucceeds();

    const r = await bootstrapOnce({});

    expect(r.source).toBe('seal');
    expect(r.state).toBe('FIRST_IDENTITY');
    expect(r.minted).toBe(true);
  });

  it('R4-H. an uploaded chunk with a blank remote_reference is not proof', async () => {
    await resolveIdentityInitialized();
    store.set(
      QUEUE_KEY,
      JSON.stringify([
        {
          session_id: AUDIO_SID,
          session_completed: false,
          chunks: [{ status: 'uploaded', remote_reference: '   ' }],
        },
      ]),
    );
    mintSucceeds();

    const r = await bootstrapOnce({});
    expect(r.state).toBe('FIRST_IDENTITY');
  });

  it('nothing is destroyed on the undurable path: no signOut, no wipe', async () => {
    await resolveIdentityInitialized();
    await localFirstCaptureTraces(AUDIO_SID, 'audio');
    mock.__failWrites__.add(IDENTITY_KEY);
    mintSucceeds();

    await bootstrapOnce({});

    expect(supabase.auth.signOut).not.toHaveBeenCalled();
    expect(store.get(QUEUE_KEY)).toContain(AUDIO_SID);
    expect(store.get(HISTORY_KEY)).toContain(AUDIO_SID);
  });
});

describe('TEST_SEAL_IS_NOT_A_SECOND_SOURCE_OF_TRUTH', () => {
  it('the marker always wins over the seal, in both directions', async () => {
    store.set(
      LEGACY_PROBE_KEY,
      JSON.stringify({
        version: 1,
        probe_version: LEGACY_PROBE_VERSION,
        evaluated_at: 1,
        legacy_identity_evidence: false,
      }),
    );
    await markIdentityInitialized('feedface-2222-4333-8444-555566667777');

    const r = await resolveIdentityInitialized();

    expect(r.source).toBe('marker');
    expect(r.initialized).toBe(true);
  });

  it('the seal carries no identity material, only an answer', async () => {
    await resolveIdentityInitialized();
    const raw = store.get(LEGACY_PROBE_KEY)!;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual([
      'evaluated_at',
      'legacy_identity_evidence',
      'probe_version',
      'version',
    ]);
    expect(raw).not.toMatch(/token|jwt|sub|user|secret/i);
  });

  it('evaluated_at is diagnostic: no decision reads it', async () => {
    // A device clock 21 693 s off must not change any verdict.
    store.set(
      LEGACY_PROBE_KEY,
      JSON.stringify({
        version: 1,
        probe_version: LEGACY_PROBE_VERSION,
        evaluated_at: Date.now() + 21_693_000,
        legacy_identity_evidence: false,
      }),
    );

    const future = await resolveIdentityInitialized();

    store.set(
      LEGACY_PROBE_KEY,
      JSON.stringify({
        version: 1,
        probe_version: LEGACY_PROBE_VERSION,
        evaluated_at: 0,
        legacy_identity_evidence: false,
      }),
    );
    const epoch = await resolveIdentityInitialized();

    expect(future.initialized).toBe(epoch.initialized);
    expect(future.source).toBe(epoch.source);
  });
});

describe('R5_K_UNCERTAINTY_NEVER_AUTHORIZES_A_REPLACEMENT', () => {
  it('R5-K. removal fails but the poisoned seal still closes the gate', async () => {
    await resolveIdentityInitialized(); // durable negative seal
    mock.__failWrites__.add(IDENTITY_KEY);
    mock.__failRemoves__.add(LEGACY_PROBE_KEY);
    mintSucceeds('a1a1a1a1-2222-4333-8444-555566667777');

    const boot1 = await bootstrapOnce({});
    expect(boot1.minted).toBe(true);
    expect(boot1.markerDurable).toBe(false);

    // removeItem failed; the second door — an unusable probe_version —
    // was taken instead, so the negative seal is no longer actionable.
    expect(await readLegacyProbeSeal()).toBeNull();

    // A captured while it held the session. Session then dies. Restart.
    await localFirstCaptureTraces(AUDIO_SID, 'audio');
    mock.__failWrites__.clear();
    mock.__failRemoves__.clear();
    signInAnonymously.mockClear();

    const boot2 = await bootstrapOnce({});

    expect(boot2.state).toBe('IDENTITY_DEGRADED');
    expect(boot2.minted).toBe(false);
    expect(signInAnonymously).not.toHaveBeenCalled();
    // Local capture is untouched throughout.
    expect(store.get(QUEUE_KEY)).toContain(AUDIO_SID);
  });

  it('R5-K/bis. an unusable probe_version is never acted upon', async () => {
    store.set(
      LEGACY_PROBE_KEY,
      JSON.stringify({
        version: 1,
        probe_version: -1,
        evaluated_at: 1,
        legacy_identity_evidence: false,
      }),
    );

    expect(await readLegacyProbeSeal()).toBeNull();
  });

  it('R5-K. local capture stays permitted while the gate is shut', async () => {
    await resolveIdentityInitialized();
    mock.__failWrites__.add(IDENTITY_KEY);
    mock.__failRemoves__.add(LEGACY_PROBE_KEY);
    mintSucceeds();
    await bootstrapOnce({});

    // P2: the boundary gate never refuses a recording.
    await expect(ensureMigrationBoundary()).resolves.toBeDefined();
  });
});
