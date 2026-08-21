/**
 * GC-AUTH-001 — the identity state machine and its migration probe.
 *
 * The defect: `session == null` was read as "no identity has ever existed
 * on this device" and answered by minting a new anonymous Supabase user,
 * which overwrites the persisted one. With no login to fall back on, every
 * transient failure permanently orphaned whatever the previous identity
 * had already uploaded.
 *
 * These tests pin the rule that replaces it:
 *
 *   A new anonymous identity may only be minted when Guardian Cloud can
 *   prove no identity has ever existed here.
 *
 * The transition table is exercised exhaustively — all eight combinations
 * of (session, error, initialized) — because the interesting cases are
 * exactly the ones the old code collapsed together.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  IDENTITY_KEY,
  decideIdentityState,
  markIdentityInitialized,
  probeLegacyIdentity,
  readIdentityMarker,
  resolveIdentityInitialized,
} from '../src/auth/identityMarker';

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.clearAllMocks();
});

describe('TEST_IDENTITY_STATE_TRANSITION_TABLE', () => {
  it('a session present is always IDENTITY_OK, whatever else is true', () => {
    for (const hasError of [false, true]) {
      for (const initialized of [false, true]) {
        expect(
          decideIdentityState({ hasSession: true, hasError, initialized }),
        ).toEqual({ state: 'IDENTITY_OK', reason: 'session_present' });
      }
    }
  });

  it('no session + no error + no prior identity is the ONLY minting gate', () => {
    expect(
      decideIdentityState({
        hasSession: false,
        hasError: false,
        initialized: false,
      }),
    ).toEqual({ state: 'FIRST_IDENTITY', reason: 'no_prior_identity' });
  });

  it('no session + a prior identity is degraded, never minting', () => {
    expect(
      decideIdentityState({
        hasSession: false,
        hasError: false,
        initialized: true,
      }),
    ).toEqual({
      state: 'IDENTITY_DEGRADED',
      reason: 'prior_identity_no_session',
    });
  });

  /**
   * The row the old code got wrong. An error is not evidence of absence.
   * If this ever flips back to FIRST_IDENTITY, GC-AUTH-001 is back.
   */
  it('an error NEVER opens the minting gate, even with no prior identity', () => {
    expect(
      decideIdentityState({
        hasSession: false,
        hasError: true,
        initialized: false,
      }),
    ).toEqual({ state: 'IDENTITY_DEGRADED', reason: 'session_error' });
  });

  it('an error with a prior identity is degraded too', () => {
    expect(
      decideIdentityState({
        hasSession: false,
        hasError: true,
        initialized: true,
      }),
    ).toEqual({ state: 'IDENTITY_DEGRADED', reason: 'session_error' });
  });

  it('FIRST_IDENTITY is reachable from exactly one input combination', () => {
    const minting: string[] = [];
    for (const hasSession of [false, true]) {
      for (const hasError of [false, true]) {
        for (const initialized of [false, true]) {
          const d = decideIdentityState({ hasSession, hasError, initialized });
          if (d.state === 'FIRST_IDENTITY') {
            minting.push(`${hasSession}/${hasError}/${initialized}`);
          }
        }
      }
    }
    expect(minting).toEqual(['false/false/false']);
  });
});

describe('TEST_IDENTITY_MARKER_IS_IDEMPOTENT', () => {
  it('writes a marker when none exists', async () => {
    // GC-AUTH-MIGRATION-001: the write now reports whether it landed, so
    // the caller can refuse to treat an unrecorded identity as settled.
    const { marker, persisted } = await markIdentityInitialized(
      '9095c9e7-9d19-48d4-a465-8b7',
    );
    expect(persisted).toBe(true);
    expect(marker.version).toBe(1);
    expect(marker.sub_prefix).toBe('9095c9e7');
    expect(marker.migrated_from_legacy).toBe(false);
    expect(await readIdentityMarker()).not.toBeNull();
  });

  it('never overwrites an existing marker', async () => {
    const first = await markIdentityInitialized('aaaaaaaa-1111');
    const second = await markIdentityInitialized('bbbbbbbb-2222');
    expect(second.marker.initialized_at).toBe(first.marker.initialized_at);
    expect(second.marker.sub_prefix).toBe('aaaaaaaa');
    // An already-durable marker reports as persisted without rewriting.
    expect(second.persisted).toBe(true);
  });

  it('stores no token material — only a version, a timestamp and 8 hex chars', async () => {
    await markIdentityInitialized('9095c9e7-9d19-48d4-a465-8b7e69171078');
    const raw = (await AsyncStorage.getItem(IDENTITY_KEY)) ?? '';
    expect(raw).not.toMatch(/eyJ/);
    expect(raw).not.toMatch(/access_token|refresh_token/);
    // The full user id must not survive either — prefix only.
    expect(raw).not.toContain('9095c9e7-9d19-48d4-a465-8b7e69171078');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'initialized_at',
      'migrated_from_legacy',
      'sub_prefix',
      'version',
    ]);
  });

  it('tolerates a missing user id', async () => {
    const { marker } = await markIdentityInitialized(null);
    expect(marker.sub_prefix).toBeNull();
  });
});

describe('TEST_LEGACY_PROBE_DETECTS_A_PRIOR_IDENTITY', () => {
  it('a non-empty history proves a prior identity', async () => {
    await AsyncStorage.setItem(
      'history.sessions',
      JSON.stringify([{ session_id: 'abc', created_at: 1, mode: 'audio' }]),
    );
    expect(await probeLegacyIdentity()).toBe(true);
  });

  it('a non-empty queue proves a prior identity', async () => {
    await AsyncStorage.setItem(
      'test.pending_retry',
      JSON.stringify([{ session_id: 'abc' }]),
    );
    expect(await probeLegacyIdentity()).toBe(true);
  });

  it('a pending session registration proves a prior identity', async () => {
    await AsyncStorage.setItem(
      'guardian.pending_session_registrations',
      JSON.stringify([{ session_id: 'abc' }]),
    );
    expect(await probeLegacyIdentity()).toBe(true);
  });

  it('a last export id proves a prior identity', async () => {
    await AsyncStorage.setItem('export.last_session_id', 'abc-def');
    expect(await probeLegacyIdentity()).toBe(true);
  });

  it('EMPTY arrays are not evidence', async () => {
    await AsyncStorage.setItem('history.sessions', '[]');
    await AsyncStorage.setItem('test.pending_retry', '[]');
    await AsyncStorage.setItem('guardian.pending_session_registrations', '[]');
    expect(await probeLegacyIdentity()).toBe(false);
  });

  it('an empty string last-session-id is not evidence', async () => {
    await AsyncStorage.setItem('export.last_session_id', '   ');
    expect(await probeLegacyIdentity()).toBe(false);
  });

  it('a genuinely fresh install has nothing to find', async () => {
    expect(await probeLegacyIdentity()).toBe(false);
  });

  it('malformed JSON proves nothing and does not throw', async () => {
    await AsyncStorage.setItem('history.sessions', '{not json');
    expect(await probeLegacyIdentity()).toBe(false);
  });
});

describe('TEST_MIGRATION_OF_AN_EXISTING_INSTALL', () => {
  /**
   * The device that motivated this work: 24 history entries, no marker,
   * and no Supabase auth row. It must NOT be treated as a fresh install.
   */
  it('an install with history but no marker resolves to initialized', async () => {
    await AsyncStorage.setItem(
      'history.sessions',
      JSON.stringify(
        Array.from({ length: 24 }, (_, i) => ({
          session_id: `s${i}`,
          created_at: i,
          mode: 'audio',
        })),
      ),
    );

    const resolved = await resolveIdentityInitialized();

    expect(resolved.initialized).toBe(true);
    expect(resolved.fromLegacyProbe).toBe(true);
    expect(resolved.marker?.migrated_from_legacy).toBe(true);
    // We do not know which identity it was, and we do not guess.
    expect(resolved.marker?.sub_prefix).toBeNull();
  });

  it('that install is then DEGRADED, so no third identity is minted', async () => {
    await AsyncStorage.setItem(
      'history.sessions',
      JSON.stringify([{ session_id: 's', created_at: 1, mode: 'video' }]),
    );

    const { initialized } = await resolveIdentityInitialized();
    const decision = decideIdentityState({
      hasSession: false,
      hasError: false,
      initialized,
    });

    expect(decision.state).toBe('IDENTITY_DEGRADED');
  });

  it('the probe is one-shot: the marker it writes short-circuits later boots', async () => {
    await AsyncStorage.setItem(
      'history.sessions',
      JSON.stringify([{ session_id: 's', created_at: 1, mode: 'audio' }]),
    );

    const first = await resolveIdentityInitialized();
    expect(first.fromLegacyProbe).toBe(true);

    // Even with every trace of evidence gone, the marker carries the fact.
    await AsyncStorage.removeItem('history.sessions');

    const second = await resolveIdentityInitialized();
    expect(second.initialized).toBe(true);
    expect(second.fromLegacyProbe).toBe(false);
  });

  it('a fresh install resolves to NOT initialized and may mint', async () => {
    const resolved = await resolveIdentityInitialized();
    expect(resolved.initialized).toBe(false);
    expect(resolved.marker).toBeNull();
    expect(
      decideIdentityState({
        hasSession: false,
        hasError: false,
        initialized: resolved.initialized,
      }).state,
    ).toBe('FIRST_IDENTITY');
  });

  it('resolving does not write a marker for a fresh install', async () => {
    await resolveIdentityInitialized();
    expect(await AsyncStorage.getItem(IDENTITY_KEY)).toBeNull();
  });
});
