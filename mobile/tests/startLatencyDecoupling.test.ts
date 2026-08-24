/**
 * GC-START-LATENCY-001 — the network does not decide when you may begin
 * gathering evidence.
 *
 * `startRecording` used to `await getOwnershipAccessToken()` before the
 * recorder opened. That call goes through `supabase.auth.getSession()`,
 * which refreshes over the network once the access token has expired, and
 * NOTHING on that path carries a timeout — auth-js sets none, and the
 * fetch wrapper adds none. (`src/api/client.ts` defaults to 10 s for our
 * own backend; the asymmetry was the defect.) With the remote unreachable
 * the recorder waited on a request whose duration the platform alone
 * decided, and the user stared at a dead button while nothing was being
 * captured.
 *
 * The awaited value was never needed there: its only consumers live inside
 * `sessionCreatePromise`, which is deliberately not awaited before the
 * producer. The fix moves the read into that promise. Nothing else moves.
 *
 * ── Why these tests are structural ───────────────────────────────────
 * The ordering lives inside a React component this suite cannot render,
 * so it is asserted against the source text. That is not a workaround
 * invented here: `devResetGuard.test.ts` already does exactly this, for
 * exactly this function, with the same justification — "reordering it
 * would be silent otherwise". A behavioural test that reimplemented the
 * ordering in the test file would prove only that the test file is
 * correct.
 *
 * ── What is already proven elsewhere, and NOT duplicated here ────────
 *   · a refused/failing token is an ordinary null, never a throw
 *     → `ownershipGate.test.ts` (R5_P2..., R6_H_P2...)
 *   · no token routes to the durable pending registration
 *     → `deferredRegistration.test.ts`, `ownershipBrand.test.ts:204`
 *   · once identity returns, the replay carries the ORIGINAL
 *     localSessionId and issues exactly one POST /sessions
 *     → `ownershipBrand.test.ts:217`
 * Those three are the behavioural half of this design. They passed before
 * this change and must keep passing after it; the change does not touch
 * the code they exercise, only when it runs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL(..., import.meta.url)` resolves to the DOM `URL` under this
// tsconfig's lib, which `readFileSync` will not accept. Same string form
// `devResetGuard.test.ts` uses.
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'app', 'index.tsx'), 'utf8');

/**
 * Comments in this file discuss the very calls being searched for — the
 * docblock above the moved read names `getOwnershipAccessToken()` twice.
 * Scanning raw text would match prose and pass no matter what the code
 * does, so every assertion below runs on code with comments removed.
 *
 * Replacing each comment with an equal-length run of spaces keeps every
 * offset identical to the original file, so indices remain comparable and
 * any failure message points at a real line.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
}

const CODE = stripComments(SOURCE);

/** Fails loudly rather than silently comparing -1 against -1. */
function at(needle: string): number {
  const i = CODE.indexOf(needle);
  expect(i, `anchor not found in code (comments stripped): ${needle}`).toBeGreaterThan(-1);
  return i;
}

const START = 'async function startRecording()';
const SCOPE_END = 'async function stopRecording()';

/**
 * The body of `startRecording`, and nothing else.
 *
 * Necessary because the anchors are NOT unique in this file: `await
 * queueAppendNewSession(` appears three times (start, the post-stop
 * chunking path, and the abandon path). A whole-file `indexOf` picked the
 * right one only by accident of ordering.
 */
function body(): string {
  const from = at(START);
  const to = CODE.indexOf(SCOPE_END, from);
  expect(to, 'stopRecording not found after startRecording').toBeGreaterThan(from);
  return CODE.slice(from, to);
}

/**
 * Offset of the FIRST occurrence inside `startRecording`, or -1.
 *
 * Writing "X comes after Y" as `indexOf(X, posOfY) > posOfY` is a
 * tautology: that search cannot return anything before `posOfY`, so the
 * assertion passes even when an X is planted ahead of Y and a later X
 * still exists. A mutation that moved a producer ahead of the durable
 * write passed against exactly that mistake before it was found. Every
 * ordering assertion below compares FIRST occurrences, which is the only
 * comparison capable of failing.
 */
function firstIn(needle: string): number {
  return body().indexOf(needle);
}

/** `earlier` must precede `later`, both taken as first occurrences. */
function mustPrecede(earlier: string, later: string): void {
  const a = firstIn(earlier);
  const b = firstIn(later);
  expect(a, `not found inside startRecording: ${earlier}`).toBeGreaterThan(-1);
  expect(b, `not found inside startRecording: ${later}`).toBeGreaterThan(-1);
  expect(b, `"${later}" must come AFTER "${earlier}"`).toBeGreaterThan(a);
}

/**
 * One branch of `startRecording`, sliced so that an assertion about one
 * branch cannot reach an anchor belonging to the other.
 *
 * This exists because of a real defect, found by hardware and not by the
 * suite. The first version of this file asserted "GC_QUEUE is durable
 * before either producer" using the FIRST `queueAppendNewSession` — which
 * belongs to the native-segmented VIDEO branch — and compared it against
 * the AUDIO producer. It passed, and it meant nothing: those two anchors
 * live in branches that never run in the same capture. The 2026-08-24
 * hardware run then showed audio doing the opposite of what the test
 * appeared to promise — RECORDER_STARTED at 06:47:23.782,
 * GC_QUEUE_PERSIST_OK at 06:47:23.791, nine milliseconds LATER.
 *
 * Both orderings are correct, and they differ on purpose:
 *
 *   native-segmented video   4A durable  →  producer
 *   audio / legacy video     producer (this is what yields the cache URI)
 *                            →  4A durable  →  chunker
 *
 * Audio cannot write the entry first: the entry carries `cacheUri`, and
 * that path does not exist until the recorder has opened the file. So the
 * property that protects the evidence is NOT "durable before the
 * producer" — it is "durable before any chunk can exist". Measured twice
 * on hardware that day: 5.04 s of margin with the remote alive, 12.28 s
 * with it unreachable.
 */
function region(from: string, to: string): string {
  const b = body();
  const i = b.indexOf(from);
  expect(i, `region start not found: ${from}`).toBeGreaterThan(-1);
  const j = b.indexOf(to, i + 1);
  expect(j, `region end not found after its start: ${to}`).toBeGreaterThan(i);
  return b.slice(i, j);
}

/** Asserts the needles appear in this exact order inside `slice`. */
function orderedWithin(slice: string, label: string, needles: string[]): void {
  let prev = -1;
  let prevName = '(branch start)';
  for (const n of needles) {
    const at = slice.indexOf(n);
    expect(at, `${label}: NOT FOUND inside this branch — ${n}`).toBeGreaterThan(-1);
    expect(at, `${label}: "${n}" must come after "${prevName}"`).toBeGreaterThan(prev);
    prev = at;
    prevName = n;
  }
}

const IIFE = 'const sessionCreatePromise: Promise<string> = (async () => {';
const TOKEN_READ = 'const token = await getOwnershipAccessToken();';
const DURABLE = 'await queueAppendNewSession(';
const AUDIO_PRODUCER = 'await startAudioRecording()';
const VIDEO_PRODUCER = 'await getNativeSession().start(';
const MIGRATION = 'await ensureMigrationBoundary()';

// Branch delimiters. `VIDEO_BRANCH` opens the native-segmented path;
// `AUDIO_BRANCH` opens the audio path inside the legacy `else`; `CHUNKER`
// is the first point at which a chunk can exist at all.
const VIDEO_BRANCH = "if (videoProducer === 'native-segmented') {";
const AUDIO_BRANCH = "if (recordingMode === 'audio') {";
const CHUNKER = 'startChunkerForSession(';

const IIFE_CLOSE = '})();';

/**
 * The critical path: from entering `startRecording` to the durable 4A
 * write. The producer opens immediately after, on both branches, so
 * anything that blocks in this window blocks the first byte.
 *
 * The body of `sessionCreatePromise` sits textually inside that window
 * but is NOT on the critical path: it is an async IIFE nobody awaits
 * before the producer. Excising it is the entire point — what remains is
 * the code that actually runs, in order, before the first byte.
 *
 * That excision is only honest because a separate test proves the promise
 * is never awaited in this window. If someone ever adds that await, the
 * other test fails, and this one loses the right to ignore the body. The
 * two assertions hold each other up; neither is sufficient alone.
 */
function criticalPath(): string {
  const b = body();
  const to = b.indexOf(DURABLE);
  expect(to, 'queueAppendNewSession not found inside startRecording').toBeGreaterThan(-1);

  const iife = b.indexOf(IIFE);
  if (iife === -1 || iife >= to) return b.slice(0, to);

  const close = b.indexOf(IIFE_CLOSE, iife);
  expect(close, 'sessionCreatePromise IIFE close not found').toBeGreaterThan(iife);
  expect(close, 'IIFE must close before the durable write').toBeLessThan(to);
  return b.slice(0, iife) + b.slice(close + IIFE_CLOSE.length, to);
}

describe('GC-START-LATENCY-001 — no remote await before the first byte', () => {
  it('the ownership token is NOT read on the critical path', () => {
    expect(criticalPath()).not.toContain('getOwnershipAccessToken');
  });

  it('the token read lives inside sessionCreatePromise, and is the only one', () => {
    // FIRST occurrence, so a read planted earlier cannot hide behind the
    // legitimate one further down.
    mustPrecede(IIFE, TOKEN_READ);

    const b = body();
    expect(
      b.indexOf(TOKEN_READ, b.indexOf(TOKEN_READ) + 1),
      'startRecording must read the ownership token exactly once',
    ).toBe(-1);
  });

  it('sessionCreatePromise is never awaited before the producer', () => {
    expect(criticalPath()).not.toContain('await sessionCreatePromise');

    // Nor between the durable write and either producer.
    const b = body();
    const durable = b.indexOf(DURABLE);
    for (const producer of [AUDIO_PRODUCER, VIDEO_PRODUCER]) {
      const p = b.indexOf(producer);
      expect(p, `producer not found in startRecording: ${producer}`).toBeGreaterThan(durable);
      expect(b.slice(durable, p)).not.toContain('await sessionCreatePromise');
    }
  });

  /**
   * The denylist is the mutation test. Re-introducing ANY of these on the
   * critical path — the original defect, or a new one wearing a different
   * name — fails here. It is deliberately a list of remote entry points
   * rather than a single string: the defect was a category, not a typo.
   */
  it('no remote call of any kind sits on the critical path', () => {
    const path = criticalPath();
    const remote = [
      'getOwnershipAccessToken',
      'getFreshAccessToken',
      'createSessionRequest',
      'listDestinations',
      'getConnectedDrive',
      'supabase.auth',
      'apiFetch',
      'fetch(',
    ];
    const found = remote.filter(r => path.includes(r));
    expect(found, `remote work on the critical path: ${found.join(', ')}`).toEqual([]);
  });
});

describe('GC-START-LATENCY-001 — the orderings the fix must not disturb', () => {
  it('native-segmented video: 4A is durable BEFORE its producer', () => {
    orderedWithin(region(VIDEO_BRANCH, AUDIO_BRANCH), 'native-segmented video', [
      DURABLE,
      VIDEO_PRODUCER,
    ]);
  });

  it('audio/legacy: the producer runs FIRST — it is what yields the cache URI', () => {
    orderedWithin(region(AUDIO_BRANCH, CHUNKER), 'audio/legacy', [
      AUDIO_PRODUCER,
      DURABLE,
    ]);
  });

  it('audio/legacy: 4A is durable BEFORE any chunk can exist', () => {
    // The real evidence guarantee for this branch. A zero-chunk entry can
    // never complete or be reaped, so the window between the recorder
    // opening and the entry landing costs nothing — but the window
    // between the entry and the FIRST CHUNK must not exist at all.
    //
    // The region ENDS at the chunker, so finding the write inside it is
    // exactly the proof that the write precedes it. Deliberately NOT
    // written as `mustPrecede(DURABLE, CHUNKER)`: that helper takes first
    // occurrences, and the first `queueAppendNewSession` belongs to the
    // VIDEO branch — the very cross-branch comparison this file exists to
    // stop making.
    orderedWithin(region(AUDIO_BRANCH, CHUNKER), 'audio/legacy', [DURABLE]);
  });

  /**
   * The teeth for the defect itself: this fails if anyone reasons about
   * one branch using the other's durable write. Widening a region to
   * borrow the neighbour's anchor trips these.
   */
  it('the two branches keep their OWN durable write, and cannot borrow', () => {
    const video = region(VIDEO_BRANCH, AUDIO_BRANCH);
    const audio = region(AUDIO_BRANCH, CHUNKER);

    // Exactly one 4A write per branch...
    for (const [label, slice] of [['video', video], ['audio', audio]] as const) {
      expect(slice.indexOf(DURABLE), `${label}: no 4A write`).toBeGreaterThan(-1);
      expect(
        slice.indexOf(DURABLE, slice.indexOf(DURABLE) + 1),
        `${label}: more than one 4A write — the branch model is stale`,
      ).toBe(-1);
    }
    // ...and exactly two in the whole function, so a third would surface.
    const b = body();
    let n = 0;
    for (let i = b.indexOf(DURABLE); i > -1; i = b.indexOf(DURABLE, i + 1)) n++;
    expect(n, 'startRecording must contain exactly two 4A writes').toBe(2);

    // Neither branch may contain the other's producer.
    expect(video, 'video branch must not reach the audio producer').not.toContain(AUDIO_PRODUCER);
    expect(audio, 'audio branch must not reach the video producer').not.toContain(VIDEO_PRODUCER);
  });

  it('the migration boundary is resolved before BOTH durable writes', () => {
    // GC-AUTH-MIGRATION-001: the probe must answer before this capture
    // creates a legacy signal. `test.pending_retry` — written by 4A — is
    // one of those signals. Asserted against the FIRST write, which is
    // the strictest of the two, and it is also the earliest thing 4A can
    // touch on any branch.
    mustPrecede(MIGRATION, DURABLE);
    const b = body();
    const last = b.lastIndexOf(DURABLE);
    expect(last, 'second 4A write not found').toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(b.indexOf(MIGRATION));
  });

  it('the migration boundary is local-only, so it can never wait on the network', () => {
    // It stays on the critical path on purpose. That is only acceptable
    // while it touches storage and nothing else.
    const b = body();
    expect(b.slice(0, b.indexOf(MIGRATION))).not.toContain('getOwnershipAccessToken');
  });

  it('the dev-reset door still precedes the durable write and both producers', () => {
    // GC-DEV-RESET-001 — asserted in devResetGuard.test.ts too. Repeated
    // here because this change reorders the block the door opens onto,
    // and a door that stops covering the first irreversible effect is
    // worth two tests.
    const DOOR = "acquireProducerSlot('startRecording')";
    mustPrecede(DOOR, DURABLE);
    mustPrecede(DOOR, AUDIO_PRODUCER);
    mustPrecede(DOOR, VIDEO_PRODUCER);
  });
});
