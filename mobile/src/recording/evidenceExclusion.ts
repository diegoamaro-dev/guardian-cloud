/**
 * GC-DEV-RESET-001 (third gap) — mutual exclusion between evidence
 * PRODUCERS and DESTRUCTIVE operations.
 *
 * ## The race
 *
 * `hardResetAppState` inspected, then deleted. Between those two steps a
 * capture could start, and the delete took bytes the inspection had
 * never seen. `reset.ts` carried a comment saying "Caller must ensure no
 * recording is in flight" — a contract, enforced by nobody, guarding an
 * operation that destroys evidence.
 *
 * ## Why nothing existing could be reused
 *
 *   writeChain / queueMutate   serialises queue mutations, and every
 *                              producer funnels through it — but the
 *                              reset never enters the chain (raw
 *                              removeItem + deleteAsync), and on the
 *                              audio path the RECORDER starts before the
 *                              4A write, so the chain is not even the
 *                              first irreversible effect.
 *   isStartingRef              a component-scoped useRef. Invisible to
 *                              this module and to src/dev/reset.ts.
 *   hasActiveAudioRecording()  module-scoped and exported, but it only
 *                              reports the audio recorder, only AFTER it
 *                              is already live, and is blind to native
 *                              segmented video entirely.
 *   isDraining / ownership     single-flight latches for the upload
 *   latch / inFlightResolution worker and the identity layer. Different
 *                              subjects.
 *
 * So this module exists. It has ZERO imports, which is what lets both
 * `app/index.tsx` and `src/dev/reset.ts` depend on it without a cycle.
 *
 * ## The guarantee, and why it is structural rather than hopeful
 *
 * Every acquire is SYNCHRONOUS. There is no `await` between reading the
 * state and claiming it, so on the JS single thread no interleaving can
 * observe a half-claimed state. A promise-based lock would need extra
 * care to say the same thing.
 *
 *   Once a destructive operation holds the lease, no producer can start
 *   until it releases; and if any producer holds a slot, no destructive
 *   operation can obtain the lease.
 *
 * ## Priority when they collide: THE CAPTURE WINS
 *
 * `acquireDestructiveExclusion` returns null while any producer slot is
 * live. It never waits, never cancels, never preempts. A dev reset is
 * the thing that gets told no — the opposite would mean losing evidence
 * to a convenience.
 *
 * A leaked slot therefore fails in the SAFE direction: the reset refuses
 * forever, which costs a developer one `pm clear` over ADB. The inverse
 * failure costs someone their recording.
 *
 * ## What this covers, and what covers the rest
 *
 * The lock is deliberately NOT held for the duration of a recording. It
 * covers exactly the window in which a capture's evidence is not yet
 * visible to `inspectResetSafety` — from the commit point in
 * `startRecording` until the 4A queue entry is durable. After that the
 * entry itself blocks the reset (zero chunks is undecidable), and after
 * the capture ends the promoted `guardian_recording_*` file blocks it.
 * Lock and inspection are total only together.
 *
 * Brands follow the precedent of `CompletionAuthorization` and
 * `OwnershipToken`: a caller cannot write down a value of these types,
 * so exclusion cannot be faked by passing a plausible-looking object.
 */

declare const producerSlotBrand: unique symbol;
declare const destructiveLeaseBrand: unique symbol;

/** Held by a capture from its commit point until 4A is durable. */
export interface ProducerSlot {
  readonly [producerSlotBrand]: true;
  readonly label: string;
}

/** Held by a destructive tool across its whole check-then-delete pair. */
export interface DestructiveLease {
  readonly [destructiveLeaseBrand]: true;
  readonly label: string;
}

/**
 * Identity set, not a counter. A double release cannot decrement past
 * another producer's slot, and a stale slot from a previous attempt
 * cannot free a live one.
 */
const liveProducerSlots = new Set<ProducerSlot>();

/** At most one destructive operation at a time, process-wide. */
let liveLease: DestructiveLease | null = null;

/**
 * Claim the right to create evidence. Returns null when a destructive
 * operation currently holds exclusion — the caller must then abort
 * BEFORE its first irreversible effect (no recorder, no queue entry, no
 * bytes).
 *
 * Callers hold the slot until the evidence they create is visible to
 * `inspectResetSafety`, and release in a `finally`.
 */
export function acquireProducerSlot(label: string): ProducerSlot | null {
  if (liveLease !== null) return null;
  const slot = { label } as unknown as ProducerSlot;
  liveProducerSlots.add(slot);
  return slot;
}

/** Idempotent. A null slot (never acquired) is a no-op. */
export function releaseProducerSlot(slot: ProducerSlot | null): void {
  if (slot !== null) liveProducerSlots.delete(slot);
}

/**
 * Claim the right to destroy. Returns null when a capture is starting or
 * another destructive operation is already in flight.
 *
 * MUST be acquired BEFORE the safety inspection, not between the
 * inspection and the delete — the point is to make that pair atomic with
 * respect to producers.
 */
export function acquireDestructiveExclusion(label: string): DestructiveLease | null {
  // Another destructive operation. Two of these must never both proceed.
  if (liveLease !== null) return null;
  // A capture is starting. The capture wins; this one is told no.
  if (liveProducerSlots.size > 0) return null;
  liveLease = { label } as unknown as DestructiveLease;
  return liveLease;
}

/**
 * Idempotent, and only the holder can release. Called from a `finally`
 * so a failed delete still frees the lease.
 */
export function releaseDestructiveExclusion(lease: DestructiveLease | null): void {
  if (lease !== null && lease === liveLease) liveLease = null;
}

/** Diagnostics only. Never a decision input — read it and it is stale. */
export function evidenceExclusionSnapshot(): {
  producers: number;
  destructive: string | null;
} {
  return {
    producers: liveProducerSlots.size,
    destructive: liveLease === null ? null : liveLease.label,
  };
}

/** Test-only. Module state outlives a `beforeEach` otherwise. */
export function __resetEvidenceExclusionForTests(): void {
  liveProducerSlots.clear();
  liveLease = null;
}
