/**
 * Cleanup journal — authorization, versioning, progress and serialized writes.
 *
 * The property this suite exists to defend: nothing but a real 200 or 409 can
 * ever produce an entry, and an entry is the only thing that authorizes a
 * deletion. Everything else here is about not losing that record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_CLEANUP_KEY,
  classifyCompletion,
  createSessionCleanupJournal,
  type JournalDocument,
  type JournalStorage,
  type SessionCleanupJournal,
} from '@/video/sessionCleanupJournal';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
/** Carries hex letters, so an uppercase variant is genuinely a different string. */
const SID_HEX = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeStorage(): JournalStorage & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>();
  const s = {
    map,
    writes: 0,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      s.writes += 1;
      // A real AsyncStorage write is not instantaneous; yielding here is what
      // makes an unserialized read-modify-write actually lose an update.
      await new Promise((r) => setTimeout(r, 0));
      map.set(k, v);
    },
  };
  return s;
}

function makeJournal(storage: JournalStorage, nowMs = 1_000): SessionCleanupJournal {
  return createSessionCleanupJournal({
    storage,
    clock: { now: () => nowMs },
    logger: { log: vi.fn() },
  });
}

/** The only legitimate way to obtain an authorization. */
const auth200 = () => classifyCompletion({ kind: 'resolved' })!;
const auth409 = () =>
  classifyCompletion({ kind: 'threw', message: 'HTTP 409 SESSION_ALREADY_COMPLETED' })!;

function readDoc(storage: JournalStorage & { map: Map<string, string> }): JournalDocument {
  return JSON.parse(storage.map.get(SESSION_CLEANUP_KEY)!) as JournalDocument;
}

describe('classifyCompletion', () => {
  it('authorizes a resolved completeSession as http_200', () => {
    expect(classifyCompletion({ kind: 'resolved' })?.code).toBe('http_200');
  });

  it('authorizes 409 / SESSION_ALREADY_COMPLETED as http_409', () => {
    expect(classifyCompletion({ kind: 'threw', message: 'HTTP 409' })?.code).toBe(
      'http_409',
    );
    expect(
      classifyCompletion({ kind: 'threw', message: 'SESSION_ALREADY_COMPLETED' })?.code,
    ).toBe('http_409');
  });

  it('authorizes NOTHING else', () => {
    for (const message of [
      'HTTP 500 internal',
      'HTTP 401 unauthorized',
      'HTTP 404 SESSION_NOT_FOUND',
      'HTTP 422 invalid',
      'Network request failed',
      'Aborted',
      '',
    ]) {
      expect(classifyCompletion({ kind: 'threw', message })).toBeNull();
    }
  });
});

describe('sessionCleanupJournal', () => {
  let storage: ReturnType<typeof makeStorage>;
  let journal: SessionCleanupJournal;

  beforeEach(() => {
    storage = makeStorage();
    journal = makeJournal(storage);
  });

  it('writes a v1 entry with both resources pending and reports created', async () => {
    const result = await journal.authorize(SID_A, auth200());
    expect(result).toEqual({ ok: true, status: 'created' });

    const doc = readDoc(storage);
    expect(doc.version).toBe(1);
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0]).toMatchObject({
      session_id: SID_A,
      authorization: 'http_200',
      resources: { native_cache: 'pending', stable_segments: 'pending' },
      attempts: 0,
      last_result: null,
    });
  });

  it('records a 409 authorization distinctly', async () => {
    expect(await journal.authorize(SID_A, auth409())).toEqual({
      ok: true,
      status: 'created',
    });
    expect(readDoc(storage).entries[0]!.authorization).toBe('http_409');
  });

  it('re-authorizing reports already_present and does not reset progress', async () => {
    await journal.authorize(SID_A, auth200());
    await journal.markResource(SID_A, 'native_cache', 'done');

    // A 200 first, a 409 on a later retry: the same terminal fact reached by a
    // different route, so it is compatible, not a conflict.
    expect(await journal.authorize(SID_A, auth409())).toEqual({
      ok: true,
      status: 'already_present',
    });

    const entry = readDoc(storage).entries[0]!;
    expect(entry.resources.native_cache).toBe('done');
    expect(entry.authorization).toBe('http_200');
    expect(readDoc(storage).entries).toHaveLength(1);
  });

  it('refuses a session id that is not a canonical uuid', async () => {
    expect(await journal.authorize('not-a-uuid', auth200())).toEqual({
      ok: false,
      reason: 'session_id_invalid',
    });
    expect(
      await journal.authorize('11111111-1111-4111-8111-11111111111Z', auth200()),
    ).toEqual({ ok: false, reason: 'session_id_invalid' });
    expect(
      await journal.authorize(SID_HEX.toUpperCase(), auth200()),
    ).toEqual({ ok: false, reason: 'session_id_invalid' });
    expect(storage.map.get(SESSION_CLEANUP_KEY)).toBeUndefined();
  });

  it('refuses an invalid clock instead of writing an entry it would later reject', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const s = makeStorage();
      const j = createSessionCleanupJournal({
        storage: s,
        clock: { now: () => bad },
        logger: { log: vi.fn() },
      });

      expect(await j.authorize(SID_A, auth200())).toEqual({
        ok: false,
        reason: 'clock_invalid',
      });
      expect(s.map.get(SESSION_CLEANUP_KEY)).toBeUndefined();
    }
  });

  it('refuses when the write itself throws, leaving nothing recorded', async () => {
    const boom = { ...storage, setItem: async () => { throw new Error('disk full'); } };
    const j = makeJournal(boom);
    await expect(j.authorize(SID_A, auth200())).rejects.toThrow();
    expect(storage.map.get(SESSION_CLEANUP_KEY)).toBeUndefined();
  });

  it('tracks the two resources independently', async () => {
    await journal.authorize(SID_A, auth200());
    await journal.markResource(SID_A, 'native_cache', 'done', 'CLEANED');
    const entry = readDoc(storage).entries[0]!;

    expect(entry.resources.native_cache).toBe('done');
    expect(entry.resources.stable_segments).toBe('pending');
    expect(entry.last_result).toBe('CLEANED');
  });

  it('keeps an entry a candidate even when both resources are terminal', async () => {
    await journal.authorize(SID_A, auth200());
    expect(await journal.listReconcileCandidates()).toHaveLength(1);

    await journal.markResource(SID_A, 'native_cache', 'done');
    expect(await journal.listReconcileCandidates()).toHaveLength(1);

    // Both terminal and still listed: the drop has not happened yet, and only
    // being listed keeps it reachable. Filtering here is exactly what would
    // leave a tombstone in the journal forever.
    await journal.markResource(SID_A, 'stable_segments', 'absent');
    expect(await journal.listReconcileCandidates()).toHaveLength(1);

    expect(await journal.drop(SID_A)).toBe(true);
    expect(await journal.listReconcileCandidates()).toHaveLength(0);
  });

  it('keeps blocked entries listed', async () => {
    await journal.authorize(SID_A, auth200());
    await journal.markResource(SID_A, 'native_cache', 'blocked', 'SESSION_ACTIVE');
    await journal.markResource(SID_A, 'stable_segments', 'done');
    expect(await journal.listReconcileCandidates()).toHaveLength(1);
  });

  it('refuses to drop an entry with unfinished work', async () => {
    await journal.authorize(SID_A, auth200());
    await journal.markResource(SID_A, 'native_cache', 'done');

    expect(await journal.drop(SID_A)).toBe(false);
    expect(readDoc(storage).entries).toHaveLength(1);

    await journal.markResource(SID_A, 'stable_segments', 'done');
    expect(await journal.drop(SID_A)).toBe(true);
    expect(readDoc(storage).entries).toHaveLength(0);
  });

  it('counts attempts without ever authorizing or dropping', async () => {
    await journal.authorize(SID_A, auth200());
    expect(await journal.bumpAttempt(SID_A)).toBe(1);
    expect(await journal.bumpAttempt(SID_A)).toBe(2);
    expect(readDoc(storage).entries).toHaveLength(1);
    expect(readDoc(storage).entries[0]!.resources.native_cache).toBe('pending');
  });

  it('serializes concurrent writes without losing an update', async () => {
    await Promise.all([
      journal.authorize(SID_A, auth200()),
      journal.authorize(SID_B, auth409()),
    ]);

    const ids = readDoc(storage).entries.map((e) => e.session_id).sort();
    expect(ids).toEqual([SID_A, SID_B].sort());
  });

  it('preserves an unknown version, refuses authorization and acts on nothing', async () => {
    const foreign = JSON.stringify({
      version: 99,
      entries: [{ session_id: SID_B, mystery: true }],
    });
    storage.map.set(SESSION_CLEANUP_KEY, foreign);

    expect(await journal.authorize(SID_A, auth200())).toEqual({
      ok: false,
      reason: 'journal_unusable',
    });
    await journal.markResource(SID_B, 'native_cache', 'done');
    expect(await journal.listReconcileCandidates()).toEqual([]);
    expect(await journal.drop(SID_B)).toBe(false);

    // Byte-for-byte untouched: a future shape may carry authorizations this
    // build cannot read, and guessing could delete evidence.
    expect(storage.map.get(SESSION_CLEANUP_KEY)).toBe(foreign);
  });

  it('preserves corrupt content, refuses authorization and acts on nothing', async () => {
    storage.map.set(SESSION_CLEANUP_KEY, '{ this is not json');
    expect(await journal.authorize(SID_A, auth200())).toEqual({
      ok: false,
      reason: 'journal_unusable',
    });
    expect(await journal.listReconcileCandidates()).toEqual([]);
    expect(storage.map.get(SESSION_CLEANUP_KEY)).toBe('{ this is not json');
  });

  it('rejects a v1 document with a malformed entry, field by field', async () => {
    const good = {
      session_id: SID_B,
      authorized_at_ms: 1_000,
      authorization: 'http_200',
      resources: { native_cache: 'pending', stable_segments: 'pending' },
      attempts: 0,
      last_result: null,
    };
    const broken: Record<string, unknown>[] = [
      { ...good, session_id: 'NOT-A-UUID' },
      { ...good, session_id: SID_HEX.toUpperCase() },
      { ...good, authorized_at_ms: -1 },
      { ...good, authorized_at_ms: Number.POSITIVE_INFINITY },
      { ...good, authorization: 'http_500' },
      { ...good, resources: { native_cache: 'pending' } },
      { ...good, resources: { ...good.resources, extra: 'pending' } },
      { ...good, resources: { ...good.resources, native_cache: 'weird' } },
      { ...good, attempts: -1 },
      { ...good, attempts: 1.5 },
      { ...good, last_result: '/data/user/0/leaked/path.mp4' },
    ];

    for (const entry of broken) {
      const raw = JSON.stringify({ version: 1, entries: [entry] });
      const s = makeStorage();
      s.map.set(SESSION_CLEANUP_KEY, raw);
      const j = makeJournal(s);

      expect(await j.authorize(SID_A, auth200())).toEqual({
        ok: false,
        reason: 'journal_unusable',
      });
      expect(await j.listReconcileCandidates()).toEqual([]);
      expect(s.map.get(SESSION_CLEANUP_KEY)).toBe(raw);
    }
  });

  it('rejects a v1 document with a duplicated session id', async () => {
    const entry = {
      session_id: SID_B,
      authorized_at_ms: 1_000,
      authorization: 'http_200',
      resources: { native_cache: 'pending', stable_segments: 'pending' },
      attempts: 0,
      last_result: null,
    };
    const raw = JSON.stringify({ version: 1, entries: [entry, { ...entry }] });
    storage.map.set(SESSION_CLEANUP_KEY, raw);

    expect(await journal.authorize(SID_A, auth200())).toEqual({
      ok: false,
      reason: 'journal_unusable',
    });
    expect(await journal.listReconcileCandidates()).toEqual([]);
    expect(storage.map.get(SESSION_CLEANUP_KEY)).toBe(raw);
  });

  it('never logs anything derived from stored content', async () => {
    const leaky = `/data/user/0/com.guariacloud.app/cache/${SID_B}/seg_000.mp4`;
    storage.map.set(
      SESSION_CLEANUP_KEY,
      JSON.stringify({ version: 1, entries: [{ session_id: SID_B, path: leaky }] }),
    );
    const logs: unknown[] = [];
    const j = createSessionCleanupJournal({
      storage,
      clock: { now: () => 1_000 },
      logger: { log: (event, fields) => logs.push({ event, fields }) },
    });

    await j.authorize(SID_A, auth200());
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(leaky);
    expect(dump).not.toContain(SID_B);
    expect(dump).not.toContain('seg_000.mp4');
  });

  it('reads back an empty journal as no work', async () => {
    expect(await journal.listReconcileCandidates()).toEqual([]);
    expect(await journal.read()).toBeNull();
  });
});
