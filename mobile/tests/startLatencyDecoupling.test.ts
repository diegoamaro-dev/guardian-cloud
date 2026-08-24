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
const IIFE = 'const sessionCreatePromise: Promise<string> = (async () => {';
const TOKEN_READ = 'const token = await getOwnershipAccessToken();';
const DURABLE = 'await queueAppendNewSession(';
const AUDIO_PRODUCER = 'await startAudioRecording()';
const VIDEO_PRODUCER = 'await getNativeSession().start(';
const MIGRATION = 'await ensureMigrationBoundary()';

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
  it('GC_QUEUE is durable before either producer opens', () => {
    mustPrecede(DURABLE, AUDIO_PRODUCER);
    mustPrecede(DURABLE, VIDEO_PRODUCER);
  });

  it('the migration boundary is resolved before the durable write', () => {
    // GC-AUTH-MIGRATION-001: the probe must answer before this capture
    // creates a legacy signal. `test.pending_retry` — written by 4A — is
    // one of those signals, so this ordering is the one that matters.
    mustPrecede(MIGRATION, DURABLE);
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
