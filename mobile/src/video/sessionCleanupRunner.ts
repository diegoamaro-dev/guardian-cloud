/**
 * Executes the cleanups the journal has authorized, and nothing else.
 *
 * The runner never decides that a session is safe to clean. It cannot: its only
 * input is `journal.listReconcileCandidates()`, and an entry exists there only
 * because `authorize` was reached with a `CompletionAuthorization`, which only a
 * real 200 or 409 produces. A directory with no journal entry is invisible to
 * this module — which is exactly why age, emptiness, or absence from GC_QUEUE
 * can never lead to a deletion.
 *
 * Both cleanups are idempotent and their progress is recorded SEPARATELY, so a
 * process death between them resumes without redoing the finished one and
 * without skipping the unfinished one.
 *
 * Candidates deliberately include entries whose resources are ALL terminal.
 * Those need no cleanup call — the bytes went in an earlier pass — only the
 * `drop` that the previous pass did not manage to persist. Filtering them out
 * is what would strand them in the journal for the life of the installation,
 * turning a bounded cleanup into unbounded tombstone growth.
 *
 * They are budgeted like everything else, but they are served LAST: a tombstone
 * whose drop keeps failing must never consume a small cap pass after pass while
 * a session that still holds bytes on disk waits behind it. See `reconcile`.
 */
import type {
  CleanupResource,
  JournalEntry,
  ResourceState,
  SessionCleanupJournal,
} from './sessionCleanupJournal';

/**
 * Closed result set shared by both cleanup surfaces. Mirrors the Kotlin side
 * exactly; a value outside this union is treated as an unknown failure and
 * leaves the resource `blocked`.
 */
export type CleanupResultCode =
  | 'CLEANED'
  | 'ALREADY_ABSENT'
  | 'PARTIAL'
  | 'SESSION_ACTIVE'
  | 'SESSION_ID_INVALID'
  | 'DIR_UNAVAILABLE';

export interface CleanupOutcome {
  result: CleanupResultCode;
  /** Files removed by this call. */
  removed: number;
  /** Files still present after this call. */
  remaining: number;
}

export type CleanupFn = (sessionId: string) => Promise<CleanupOutcome>;

export interface RunnerLogger {
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface SessionCleanupRunnerDeps {
  journal: SessionCleanupJournal;
  /** Removes cacheDir/gc-segmented-recorder/<sid>/ — the native originals. */
  cleanNativeCache: CleanupFn;
  /** Removes documentDirectory/segments/<sid>/ — the verified stable copies. */
  cleanStableSegments: CleanupFn;
  logger: RunnerLogger;
  /**
   * Caps how many entries one reconcile pass touches. It bounds THIS cycle
   * only: nothing is dropped, nothing is authorized, and whatever is left is
   * picked up by the next pass.
   */
  maxEntriesPerCycle?: number;
}

export interface RunnerReport {
  considered: number;
  cleaned: number;
  blocked: number;
  dropped: number;
  /** Entries that arrived with both resources already terminal, needing only a drop. */
  tombstones: number;
  skippedByCap: number;
}

const RESOURCE_KEYS: readonly CleanupResource[] = ['native_cache', 'stable_segments'];

function isTerminal(state: ResourceState): boolean {
  return state === 'done' || state === 'absent';
}

/** True while at least one resource still has bytes that may need deleting. */
function hasWorkLeft(entry: JournalEntry): boolean {
  return RESOURCE_KEYS.some((r) => !isTerminal(entry.resources[r]));
}

const DEFAULT_MAX_ENTRIES_PER_CYCLE = 8;

const CLEANUP_RESULT_CODES: readonly CleanupResultCode[] = [
  'CLEANED',
  'ALREADY_ABSENT',
  'PARTIAL',
  'SESSION_ACTIVE',
  'SESSION_ID_INVALID',
  'DIR_UNAVAILABLE',
];

/**
 * Results for which `remaining === -1` is a truthful answer.
 *
 * `-1` means "not determined", not "none left". The native side reports it when
 * it never looked (the session is live), could not look (no cache dir, an
 * unlistable directory) or lost the ability to look mid-delete. Substituting 0
 * there would assert that nothing remains, which is exactly the opposite of
 * what those branches know.
 */
const REMAINING_MAY_BE_UNKNOWN: readonly CleanupResultCode[] = [
  'SESSION_ACTIVE',
  'DIR_UNAVAILABLE',
  'PARTIAL',
];

/**
 * Runtime validation of whatever the bridge handed back.
 *
 * A TypeScript type is a compile-time promise about a value that crosses a
 * native bridge at runtime; it guarantees nothing about what actually arrives.
 * Without this check an unknown `result` would fall through `stateFor` as
 * `undefined`, `markResource` would persist it, and the next boot's strict
 * validation would declare the WHOLE journal unusable — taking every healthy
 * session's pending cleanup down with it. One malformed bridge response would
 * poison the subsystem.
 */
export function isValidCleanupOutcome(value: unknown): value is CleanupOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;

  if (typeof o.result !== 'string') return false;
  if (!CLEANUP_RESULT_CODES.includes(o.result as CleanupResultCode)) return false;

  if (typeof o.removed !== 'number' || !Number.isInteger(o.removed) || o.removed < 0) {
    return false;
  }
  if (typeof o.remaining !== 'number' || !Number.isInteger(o.remaining)) return false;
  if (o.remaining < 0) {
    if (o.remaining !== -1) return false;
    if (!REMAINING_MAY_BE_UNKNOWN.includes(o.result as CleanupResultCode)) return false;
  }
  return true;
}

/**
 * Maps a cleanup result to the state the journal should record.
 *
 * `PARTIAL` stays `pending` on purpose: some files went, some did not, and the
 * next pass must try again. `SESSION_ACTIVE` and `DIR_UNAVAILABLE` become
 * `blocked` — refusals that may pass later, never downgraded to done.
 */
function stateFor(result: CleanupResultCode): ResourceState {
  switch (result) {
    case 'CLEANED':
      return 'done';
    case 'ALREADY_ABSENT':
      return 'absent';
    case 'PARTIAL':
      return 'pending';
    case 'SESSION_ACTIVE':
    case 'DIR_UNAVAILABLE':
    case 'SESSION_ID_INVALID':
      return 'blocked';
  }
}

export interface SessionCleanupRunner {
  reconcile(): Promise<RunnerReport>;
}

export function createSessionCleanupRunner(
  deps: SessionCleanupRunnerDeps,
): SessionCleanupRunner {
  const cap = deps.maxEntriesPerCycle ?? DEFAULT_MAX_ENTRIES_PER_CYCLE;

  async function runOne(
    entry: JournalEntry,
    resource: CleanupResource,
    fn: CleanupFn,
  ): Promise<ResourceState> {
    const current = entry.resources[resource];
    if (current === 'done' || current === 'absent') return current;

    let raw: unknown;
    try {
      raw = await fn(entry.session_id);
    } catch {
      // A throw is not evidence that anything was removed. Leave it blocked.
      //
      // NOTHING from the exception is logged — not the message, not a
      // stringified form. A filesystem or bridge error routinely carries an
      // absolute path, a full session id or a filename, and this log is exactly
      // where such a string would escape into a diagnostic dump that gets
      // pasted around. The closed `reason` carries everything an operator can
      // act on: which session prefix, which resource, and that it threw.
      deps.logger.log('GC_CLEANUP_THREW', {
        sid_prefix: entry.session_id.slice(0, 8),
        resource,
        reason: 'cleanup_threw',
      });
      await deps.journal.markResource(entry.session_id, resource, 'blocked', 'threw');
      return 'blocked';
    }

    if (!isValidCleanupOutcome(raw)) {
      // Nothing received is persisted or logged — not the object, not a
      // stringified form. The resource stays blocked and the journal keeps a
      // closed literal, so the document remains valid v1 and the next pass can
      // still retry this session and every other one.
      deps.logger.log('GC_CLEANUP_INVALID_RESULT', {
        sid_prefix: entry.session_id.slice(0, 8),
        resource,
        reason: 'invalid_cleanup_result',
      });
      await deps.journal.markResource(
        entry.session_id,
        resource,
        'blocked',
        'invalid_cleanup_result',
      );
      return 'blocked';
    }
    const outcome: CleanupOutcome = raw;

    const state = stateFor(outcome.result);
    await deps.journal.markResource(
      entry.session_id,
      resource,
      state,
      outcome.result,
    );
    deps.logger.log('GC_CLEANUP_RESULT', {
      sid_prefix: entry.session_id.slice(0, 8),
      resource,
      result: outcome.result,
      removed: outcome.removed,
      remaining: outcome.remaining,
    });
    return state;
  }

  return {
    async reconcile() {
      const candidates = await deps.journal.listReconcileCandidates();
      const report: RunnerReport = {
        considered: candidates.length,
        cleaned: 0,
        blocked: 0,
        dropped: 0,
        tombstones: 0,
        skippedByCap: Math.max(0, candidates.length - cap),
      };
      if (candidates.length === 0) return report;

      deps.logger.log('GC_CLEANUP_RECONCILE_START', {
        candidates: candidates.length,
        cap,
      });

      // Two rules that pull in opposite directions, so both are spelled out.
      //
      // The cap covers the WHOLE candidate set, tombstones included: they are
      // work, and letting them skip the budget would leave an unbounded backlog
      // unaccounted for.
      //
      // Budgeting alone is not enough, though. A tombstone whose drop keeps
      // failing sits wherever it sits in the stored order and, at a small cap,
      // would consume the budget pass after pass while a session that still
      // holds megabytes on disk never gets a turn. So entries with something
      // left to delete go first and terminal ones take what budget remains.
      //
      // INVARIANT: the cap accounts for all work, but safely freeing bytes
      // takes priority over removing terminal metadata.
      //
      // The partition is stable by construction — two filters over the stored
      // order, not a comparator — so entries keep their relative order within
      // each group. `authorized_at_ms` is never consulted here: it is
      // diagnostic, and ordering must not become an input to a delete decision.
      const withWork = candidates.filter(hasWorkLeft);
      const terminal = candidates.filter((e) => !hasWorkLeft(e));
      const ordered = [...withWork, ...terminal];

      for (const entry of ordered.slice(0, cap)) {
        // The attempt counter is diagnostics, not a decision input. A storage
        // hiccup while bumping it must not abort the pass for this entry, let
        // alone for the ones queued behind it.
        try {
          await deps.journal.bumpAttempt(entry.session_id);
        } catch {
          deps.logger.log('GC_CLEANUP_ATTEMPT_BUMP_FAILED', {
            sid_prefix: entry.session_id.slice(0, 8),
            reason: 'bump_threw',
          });
        }

        let finished: boolean;
        if (!hasWorkLeft(entry)) {
          // Nothing left to delete: the bytes went in an earlier pass and only
          // the drop is missing. Calling either cleanup here would be asking
          // the bridge to remove a directory we already know is gone.
          report.tombstones += 1;
          deps.logger.log('GC_CLEANUP_TOMBSTONE', {
            sid_prefix: entry.session_id.slice(0, 8),
          });
          finished = true;
        } else {
          // Native first: those are the original bytes and the larger cost. The
          // stable copies are usually already gone, deleted chunk by chunk as
          // each upload was confirmed. `runOne` returns early for a resource
          // that is already terminal, so a half-finished entry never re-asks
          // the bridge about the part that is done.
          const native = await runOne(entry, 'native_cache', deps.cleanNativeCache);
          const stable = await runOne(
            entry,
            'stable_segments',
            deps.cleanStableSegments,
          );
          finished = isTerminal(native) && isTerminal(stable);
        }

        if (!finished) {
          report.blocked += 1;
          continue;
        }

        // A drop that refuses or throws leaves the entry exactly where it is,
        // for another boot to retry. `dropped` is only ever claimed for a
        // persistence that actually completed.
        let gone = false;
        try {
          gone = await deps.journal.drop(entry.session_id);
        } catch {
          deps.logger.log('GC_CLEANUP_DROP_THREW', {
            sid_prefix: entry.session_id.slice(0, 8),
            reason: 'drop_threw',
          });
          gone = false;
        }
        if (gone) {
          report.dropped += 1;
          report.cleaned += 1;
        } else {
          report.blocked += 1;
        }
      }

      deps.logger.log('GC_CLEANUP_RECONCILE_DONE', { ...report });
      return report;
    },
  };
}
