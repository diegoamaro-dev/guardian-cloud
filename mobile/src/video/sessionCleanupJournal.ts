/**
 * Durable authorization for deleting a completed session's local evidence.
 *
 * A directory of captured segments may only be deleted once the backend has
 * confirmed the session is finished. That confirmation is a remote fact; the
 * journal is its local, persistent proof, and it is the ONLY thing that
 * authorizes a deletion. Nothing else — not age, not absence from GC_QUEUE, not
 * an empty directory — ever counts.
 *
 * Three properties matter more than anything else here:
 *
 *   1. AUTHORIZATION CANNOT BE FORGED. `authorize` does not accept a string; it
 *      accepts a `CompletionAuthorization`, whose brand has no value a caller
 *      can write down. `classifyCompletion` is the only producer, and it derives
 *      the verdict from what `completeSession` actually did.
 *
 *   2. A FAILED WRITE IS NEVER SILENT. `authorize` returns a closed result. It
 *      reports `ok: true` only when a valid entry is genuinely on disk — either
 *      just persisted through a resolved `setItem`, or already present and
 *      structurally sound. Every other case is an explicit refusal, because the
 *      caller is about to drop the queue entry on the strength of this answer.
 *
 *   3. A DOCUMENT IS EITHER FULLY VALID OR UNUSABLE. Every entry is validated
 *      field by field on read. One malformed entry makes the whole journal
 *      unusable: the stored bytes are preserved untouched, no cleanup runs, and
 *      no new finalization may reap. Repairing it in place would mean guessing
 *      which authorizations were real.
 *
 * Storage and clock are injected, so the whole module loads and runs under
 * vitest with no Expo runtime.
 */

/** Its own key. Never GC_QUEUE, never the history index. */
export const SESSION_CLEANUP_KEY = 'guardian.segment_cleanup.v1';

/** Bumped only by a migration that knows how to read the older shape. */
export const SESSION_CLEANUP_VERSION = 1;

// ------------------------------------------------------------- authorization

declare const authorizationBrand: unique symbol;

/**
 * Proof that the backend confirmed completion.
 *
 * The brand field is a `unique symbol` declared but never exported and never
 * given a value, so no code outside this module can construct one. That is what
 * makes "only a real 200 or 409 authorizes a deletion" a property of the type
 * system rather than a claim about who calls what.
 */
export interface CompletionAuthorization {
  readonly [authorizationBrand]: true;
  readonly code: 'http_200' | 'http_409';
}

/** What `completeSession` did, as observed by the caller. */
export type CompletionOutcome =
  | { kind: 'resolved' }
  | { kind: 'threw'; message: string };

/**
 * The ONLY producer of a `CompletionAuthorization`.
 *
 * `null` for everything else, including 5xx, timeouts, 401 and any other 4xx: a
 * failure to complete is not evidence that the session is finished, and a
 * session that is not finished must keep its local copies.
 *
 * 409 counts because the backend is stating the session is already complete —
 * the same terminal fact a 200 asserts, reached after a lost response.
 */
export function classifyCompletion(
  outcome: CompletionOutcome,
): CompletionAuthorization | null {
  if (outcome.kind === 'resolved') {
    return { code: 'http_200' } as CompletionAuthorization;
  }
  if (
    outcome.message.includes('SESSION_ALREADY_COMPLETED') ||
    outcome.message.includes('HTTP 409')
  ) {
    return { code: 'http_409' } as CompletionAuthorization;
  }
  return null;
}

/**
 * Closed classification of a completion failure, for logging.
 *
 * Exists so no call site ever has to log `err.message`. Backend errors can
 * carry a response body, a URL or an identifier; the class is what an operator
 * can actually act on, and it is a fixed vocabulary.
 */
export type CompletionFailureCode =
  | 'http_4xx'
  | 'http_5xx'
  | 'no_token'
  | 'network_or_unknown';

export function classifyCompletionFailure(
  outcome: CompletionOutcome,
): CompletionFailureCode {
  if (outcome.kind === 'resolved') return 'network_or_unknown';
  const message = outcome.message;
  if (message.includes('NO_TOKEN')) return 'no_token';
  const status = /HTTP (\d{3})/.exec(message);
  if (status) {
    const code = Number(status[1]);
    if (code >= 500 && code < 600) return 'http_5xx';
    if (code >= 400 && code < 500) return 'http_4xx';
  }
  return 'network_or_unknown';
}

// -------------------------------------------------------------------- shapes

/** The two resource groups a completed session leaves behind. */
export type CleanupResource = 'native_cache' | 'stable_segments';

/**
 * `pending` → not attempted, or attempted and not finished
 * `done`    → removed by us
 * `absent`  → nothing was there; terminal, same as done
 * `blocked` → refused for a reason that may pass later (an active session, an
 *             unavailable directory). NEVER downgraded to done.
 */
export type ResourceState = 'pending' | 'done' | 'absent' | 'blocked';

/**
 * Values `last_result` may hold. A closed set on purpose: this field is written
 * from cleanup outcomes, and an open string would be a channel for a path or an
 * error message to reach persistent storage and then a diagnostic dump.
 */
export const LAST_RESULT_CODES = [
  'CLEANED',
  'ALREADY_ABSENT',
  'PARTIAL',
  'SESSION_ACTIVE',
  'SESSION_ID_INVALID',
  'DIR_UNAVAILABLE',
  'threw',
  /** The bridge returned something that is not a valid outcome. */
  'invalid_cleanup_result',
] as const;

export type LastResultCode = (typeof LAST_RESULT_CODES)[number];

export interface JournalEntry {
  session_id: string;
  authorized_at_ms: number;
  authorization: 'http_200' | 'http_409';
  resources: Record<CleanupResource, ResourceState>;
  /** Retry counter. Caps a cycle; never authorizes anything, never drops. */
  attempts: number;
  last_result: LastResultCode | null;
}

export interface JournalDocument {
  version: number;
  entries: JournalEntry[];
}

/** Closed outcome of an authorization write. The caller MUST inspect it. */
export type AuthorizationWriteResult =
  | { ok: true; status: 'created' | 'already_present' }
  | {
      ok: false;
      reason:
        | 'session_id_invalid'
        | 'journal_unusable'
        | 'authorization_conflict'
        | 'clock_invalid';
    };

export interface JournalStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface JournalClock {
  now(): number;
}

export interface JournalLogger {
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface SessionCleanupJournalDeps {
  storage: JournalStorage;
  clock: JournalClock;
  logger: JournalLogger;
}

export interface SessionCleanupJournal {
  /**
   * Records that this session may have its local evidence deleted.
   *
   * Idempotent: a repeat over an existing, structurally sound entry reports
   * `already_present` and leaves its resource progress untouched. Never
   * overwrites, never resets.
   */
  authorize(
    sessionId: string,
    auth: CompletionAuthorization,
  ): Promise<AuthorizationWriteResult>;
  markResource(
    sessionId: string,
    resource: CleanupResource,
    state: ResourceState,
    lastResult?: LastResultCode,
  ): Promise<void>;
  /**
   * EVERY valid entry, including those whose resources are all terminal.
   *
   * Deliberately not "entries with work left": an entry whose two resources are
   * done but which was never dropped — the process died between the second
   * `markResource` and `drop`, or the drop's write failed — still needs one
   * more action. Filtering it out here is what would make it invisible for the
   * rest of the installation's life, and the journal would grow tombstones
   * without bound. The runner decides what each entry needs.
   */
  listReconcileCandidates(): Promise<JournalEntry[]>;
  bumpAttempt(sessionId: string): Promise<number>;
  /** Removes an entry. Refuses while any resource is unfinished. */
  drop(sessionId: string): Promise<boolean>;
  /** Diagnostics and tests. Returns the raw document, unknown version included. */
  read(): Promise<JournalDocument | null>;
}

// ------------------------------------------------------------------ helpers

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RESOURCE_KEYS: readonly CleanupResource[] = ['native_cache', 'stable_segments'];
const RESOURCE_STATES: readonly ResourceState[] = ['pending', 'done', 'absent', 'blocked'];

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function isFinished(state: ResourceState): boolean {
  return state === 'done' || state === 'absent';
}

function emptyDocument(): JournalDocument {
  return { version: SESSION_CLEANUP_VERSION, entries: [] };
}

/**
 * Field-by-field validation of one entry.
 *
 * Exported so the authorization path can re-check the specific entry it found
 * rather than trusting that the document-level pass ran — the two are separated
 * on purpose, because `authorize` is the one call whose "yes" lets a caller drop
 * the queue entry.
 */
export function isValidJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;

  if (typeof e.session_id !== 'string' || !CANONICAL_UUID.test(e.session_id)) return false;
  if (
    typeof e.authorized_at_ms !== 'number' ||
    !Number.isFinite(e.authorized_at_ms) ||
    e.authorized_at_ms < 0
  ) {
    return false;
  }
  if (e.authorization !== 'http_200' && e.authorization !== 'http_409') return false;

  const resources = e.resources;
  if (typeof resources !== 'object' || resources === null) return false;
  const keys = Object.keys(resources as Record<string, unknown>);
  // Exactly the two known keys: an extra one means a shape this build does not
  // understand, and a missing one means progress we cannot account for.
  if (keys.length !== RESOURCE_KEYS.length) return false;
  for (const key of RESOURCE_KEYS) {
    const state = (resources as Record<string, unknown>)[key];
    if (typeof state !== 'string') return false;
    if (!RESOURCE_STATES.includes(state as ResourceState)) return false;
  }

  if (typeof e.attempts !== 'number' || !Number.isInteger(e.attempts) || e.attempts < 0) {
    return false;
  }
  if (e.last_result !== null) {
    if (typeof e.last_result !== 'string') return false;
    if (!(LAST_RESULT_CODES as readonly string[]).includes(e.last_result)) return false;
  }
  return true;
}

/**
 * Parses whatever is on disk WITHOUT repairing it.
 *
 * A document is usable only when its version is known AND every entry passes
 * validation AND no session id repeats. Anything else is returned as unusable
 * and the stored bytes are left exactly as they are: a future shape might carry
 * authorizations this code cannot interpret, and a malformed one might be a
 * partially-written record whose meaning we would be guessing at. Either way,
 * inventing a repair could delete evidence or lose a pending cleanup.
 */
function parse(raw: string | null): {
  doc: JournalDocument | null;
  usable: boolean;
  reason: 'ok' | 'empty' | 'not_json' | 'bad_version' | 'bad_entry' | 'duplicate_id';
} {
  if (raw === null || raw === '') return { doc: null, usable: true, reason: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { doc: null, usable: false, reason: 'not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { doc: null, usable: false, reason: 'not_json' };
  }

  const doc = parsed as Partial<JournalDocument>;
  if (doc.version !== SESSION_CLEANUP_VERSION) {
    return {
      doc: { version: Number(doc.version ?? -1), entries: [] },
      usable: false,
      reason: 'bad_version',
    };
  }
  if (!Array.isArray(doc.entries)) {
    return { doc: null, usable: false, reason: 'bad_entry' };
  }

  const seen = new Set<string>();
  for (const entry of doc.entries) {
    if (!isValidJournalEntry(entry)) {
      return { doc: null, usable: false, reason: 'bad_entry' };
    }
    if (seen.has(entry.session_id)) {
      return { doc: null, usable: false, reason: 'duplicate_id' };
    }
    seen.add(entry.session_id);
  }

  return {
    doc: { version: SESSION_CLEANUP_VERSION, entries: doc.entries },
    usable: true,
    reason: 'ok',
  };
}

// ------------------------------------------------------------------ factory

export function createSessionCleanupJournal(
  deps: SessionCleanupJournalDeps,
): SessionCleanupJournal {
  /**
   * Serialization chain. Every mutation appends to it, so a read-modify-write
   * never interleaves with another one — the same discipline `queueMutate`
   * applies to GC_QUEUE, and for the same reason.
   */
  let chain: Promise<unknown> = Promise.resolve();

  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = chain.then(op, op);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function loadUsable(): Promise<JournalDocument | null> {
    const raw = await deps.storage.getItem(SESSION_CLEANUP_KEY);
    const { doc, usable, reason } = parse(raw);
    if (!usable) {
      deps.logger.log('GC_CLEANUP_JOURNAL_UNUSABLE', {
        reason,
        version: doc?.version ?? null,
        action: 'preserved_untouched',
      });
      return null;
    }
    return doc ?? emptyDocument();
  }

  async function save(doc: JournalDocument): Promise<void> {
    await deps.storage.setItem(SESSION_CLEANUP_KEY, JSON.stringify(doc));
  }

  return {
    authorize(sessionId, auth) {
      return serialize<AuthorizationWriteResult>(async () => {
        if (!CANONICAL_UUID.test(sessionId)) {
          deps.logger.log('GC_CLEANUP_AUTHORIZE_REJECTED', {
            reason: 'session_id_invalid',
          });
          return { ok: false, reason: 'session_id_invalid' };
        }

        const doc = await loadUsable();
        if (!doc) {
          // The stored value was preserved by `loadUsable`. Reporting failure
          // here is what stops the caller from reaping a queue entry whose
          // cleanup could never be recorded.
          deps.logger.log('GC_CLEANUP_AUTHORIZE_REJECTED', {
            sid_prefix: shortId(sessionId),
            reason: 'journal_unusable',
          });
          return { ok: false, reason: 'journal_unusable' };
        }

        const existing = doc.entries.find((e) => e.session_id === sessionId);
        if (existing) {
          // Defence in depth: the document-level pass already validated every
          // entry, so this can only fire if that pass were bypassed. It is
          // cheap, and `authorize` is the one answer a caller acts on by
          // dropping durable state.
          if (!isValidJournalEntry(existing)) {
            deps.logger.log('GC_CLEANUP_AUTHORIZE_REJECTED', {
              sid_prefix: shortId(sessionId),
              reason: 'authorization_conflict',
            });
            return { ok: false, reason: 'authorization_conflict' };
          }
          // Idempotent: a repeat must not reset progress, or a retry after a
          // partial delete would redo work already recorded. Both codes assert
          // the same terminal fact, so a 200 followed by a 409 is not a
          // conflict — it is the same session confirmed twice.
          deps.logger.log('GC_CLEANUP_AUTHORIZE_REPEAT', {
            sid_prefix: shortId(sessionId),
            stored: existing.authorization,
            incoming: auth.code,
          });
          return { ok: true, status: 'already_present' };
        }

        // Captured ONCE and validated before anything is mutated. This function
        // is the durable barrier: writing an entry its own parser would later
        // reject, and still answering `ok: true`, would let the caller reap a
        // queue entry against an authorization that cannot survive a restart.
        const nowMs = deps.clock.now();
        if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) {
          deps.logger.log('GC_CLEANUP_AUTHORIZE_REJECTED', {
            sid_prefix: shortId(sessionId),
            reason: 'clock_invalid',
          });
          return { ok: false, reason: 'clock_invalid' };
        }

        doc.entries.push({
          session_id: sessionId,
          authorized_at_ms: nowMs,
          authorization: auth.code,
          resources: { native_cache: 'pending', stable_segments: 'pending' },
          attempts: 0,
          last_result: null,
        });
        // A throw here propagates to the caller, which treats it exactly like
        // `ok: false`: no mark, no reap, queue entry kept for the next attempt.
        await save(doc);
        deps.logger.log('GC_CLEANUP_AUTHORIZED', {
          sid_prefix: shortId(sessionId),
          authorization: auth.code,
        });
        return { ok: true, status: 'created' };
      });
    },

    markResource(sessionId, resource, state, lastResult) {
      return serialize(async () => {
        const doc = await loadUsable();
        if (!doc) return;
        const entry = doc.entries.find((e) => e.session_id === sessionId);
        if (!entry) return;
        entry.resources[resource] = state;
        entry.last_result = lastResult ?? entry.last_result;
        await save(doc);
        deps.logger.log('GC_CLEANUP_RESOURCE', {
          sid_prefix: shortId(sessionId),
          resource,
          state,
        });
      });
    },

    listReconcileCandidates() {
      return serialize(async () => {
        const doc = await loadUsable();
        if (!doc) return [];
        // No filtering. An entry with both resources terminal is still a
        // candidate — for its drop.
        return doc.entries.slice();
      });
    },

    bumpAttempt(sessionId) {
      return serialize(async () => {
        const doc = await loadUsable();
        if (!doc) return 0;
        const entry = doc.entries.find((e) => e.session_id === sessionId);
        if (!entry) return 0;
        entry.attempts += 1;
        await save(doc);
        return entry.attempts;
      });
    },

    drop(sessionId) {
      return serialize(async () => {
        const doc = await loadUsable();
        if (!doc) return false;
        const idx = doc.entries.findIndex((e) => e.session_id === sessionId);
        if (idx < 0) return false;
        const entry = doc.entries[idx]!;
        const unfinished = RESOURCE_KEYS.filter((r) => !isFinished(entry.resources[r]));
        if (unfinished.length > 0) {
          // Dropping here would erase the only record that these bytes are
          // still waiting to be removed, and nothing else in the system knows.
          deps.logger.log('GC_CLEANUP_DROP_REFUSED', {
            sid_prefix: shortId(sessionId),
            unfinished,
          });
          return false;
        }
        doc.entries.splice(idx, 1);
        await save(doc);
        deps.logger.log('GC_CLEANUP_DROPPED', { sid_prefix: shortId(sessionId) });
        return true;
      });
    },

    read() {
      return serialize(async () => {
        const raw = await deps.storage.getItem(SESSION_CLEANUP_KEY);
        return parse(raw).doc;
      });
    },
  };
}
