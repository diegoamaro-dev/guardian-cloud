/**
 * Recovery capability declaration — and nothing else.
 *
 * This module exists to answer ONE question: can this build bring a session
 * into existence by any route other than the single anonymous mint? Email +
 * OTP recovery is such a route. Today none exists.
 *
 * WHY IT IS ITS OWN MODULE. The flag used to live beside the code that reads
 * it, inside `identityMarker.ts`. A `const` exported and read within the same
 * module is a direct binding, not a property lookup, so the `true` branch of
 * the barrier it guards was **impossible to execute in a test**: `vi.mock`
 * replaces what importers see, never a module's own internal reference. The
 * barrier was therefore asserted only by its value, never by its behaviour.
 *
 * So the split is not a convenience for tests. It is what lets the barrier be
 * verified at all — and it is also where a future gate can COUPLE this
 * declaration to the real existence of a recovery route, so the two cannot
 * drift apart. That coupling is what `tests/recoveryBarrier.test.ts` enforces
 * today by scanning the source tree.
 *
 * ITS ONLY RESPONSIBILITY IS THIS DECLARATION. No configuration, no runtime
 * override, no environment variable, no injection. A capability that can be
 * switched at runtime is not a barrier — it is a setting, and a setting can
 * be wrong on a device we cannot inspect.
 */

/**
 * G-R1 — whether THIS BUILD can bring a session into existence by any route
 * other than the one anonymous mint: email + OTP recovery.
 *
 * It gates the anchor back-fill, and the reasoning is the whole point of the
 * flag. The back-fill trusts a live session to BE the historical identity.
 * That inference holds only while no other route can produce a session:
 * `IDENTITY_DEGRADED` never mints, and nothing else signs in. The moment a
 * recovery entry exists, a live session may be the candidate itself, and
 * anchoring it would make the continuity check compare the candidate against
 * itself — a check that always passes and proves nothing.
 *
 * G-R3 flips this to `true` and, by doing so, turns the back-fill off. A
 * device that reaches that build without an anchor is `RECOVERY_NOT_VERIFIABLE`
 * and stays that way: a durable `recovery_attempted` record, decided before
 * G-R3, is what will allow anything finer.
 *
 * IT MUST BE FLIPPED IN THE SAME COMMIT THAT INTRODUCES A RECOVERY ROUTE,
 * never later. A build where recovery can produce sessions while the
 * pre-G-R1 back-fill is still enabled is the window precondition A exists to
 * close.
 */
export const RECOVERY_ENTRY_IMPLEMENTED = false;
