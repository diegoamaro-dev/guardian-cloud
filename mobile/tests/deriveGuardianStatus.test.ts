/**
 * Pure-logic tests for the user-facing status derivation.
 *
 * The function is the single source of truth that decides whether the
 * UI shows Grabando / Iniciando / Subiendo / Recuperando / Protegido /
 * Error / Listo. It must obey a strict precedence so two simultaneous
 * signals (e.g. recording + queued chunks from a previous session)
 * never contradict each other.
 *
 * Precedence (top wins) — copied verbatim from the function's doc:
 *   1. grabando    — recorder is live (isRecording).
 *   2. iniciando   — start path in flight (isStarting && !isRecording).
 *   3. recuperando — boot recovery is still draining (isRecovering).
 *   4. error       — at least one terminal-failed chunk (failedCount > 0).
 *   5. subiendo    — isStopping, OR chunks still in motion
 *                    (activeCount > 0).
 *   6. protegido   — the capture is CLOSED and every emitted chunk is
 *                    uploaded (recordingClosed AND totalCount > 0 AND
 *                    confirmedOffDeviceCount === totalCount).
 *   7. listo       — fallback.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveGuardianStatus,
  isProtectedTally,
  type GuardianStatusInput,
} from '../src/recording/deriveGuardianStatus';

const baseInput: GuardianStatusInput = {
  isRecording: false,
  isRecovering: false,
  isStarting: false,
  isStopping: false,
  totalCount: 0,
  confirmedOffDeviceCount: 0,
  activeCount: 0,
  failedCount: 0,
  recordingClosed: false,
};

describe('deriveGuardianStatus — precedence rules', () => {
  it('returns "grabando" while the recorder is live, dominating everything else', () => {
    expect(
      deriveGuardianStatus({
        ...baseInput,
        isRecording: true,
        isRecovering: true,
        isStarting: true,
        failedCount: 5,
        activeCount: 3,
        totalCount: 10,
        confirmedOffDeviceCount: 10,
      }),
    ).toBe('grabando');
  });

  it('returns "iniciando" while the start path is in flight (isStarting=true) and recorder not yet live', () => {
    // The pre-recorder window: tap → permissions → audio mode →
    // foreground service → POST /sessions → recorder.startAsync. On
    // survival hardware this can be 1–4 s; the UI must reflect it
    // immediately instead of staying on "Listo".
    expect(
      deriveGuardianStatus({
        ...baseInput,
        isStarting: true,
      }),
    ).toBe('iniciando');
  });

  it('"iniciando" dominates "recuperando" — active user intent beats background drain', () => {
    // A user tapping GRABAR while boot recovery is still draining must
    // see immediate feedback, not the recovery banner.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        isStarting: true,
        isRecovering: true,
      }),
    ).toBe('iniciando');
  });

  it('returns "recuperando" when not recording but boot recovery is in flight', () => {
    expect(
      deriveGuardianStatus({
        ...baseInput,
        isRecovering: true,
        failedCount: 5,
        activeCount: 3,
        totalCount: 10,
        confirmedOffDeviceCount: 10,
      }),
    ).toBe('recuperando');
  });

  it('returns "error" when neither recording nor recovering and any chunk is terminal-failed', () => {
    expect(
      deriveGuardianStatus({
        ...baseInput,
        failedCount: 1,
        activeCount: 3,
        totalCount: 10,
        confirmedOffDeviceCount: 6,
      }),
    ).toBe('error');
  });

  it('returns "subiendo" when chunks are still in motion (no failures, not recording, not recovering)', () => {
    expect(
      deriveGuardianStatus({
        ...baseInput,
        activeCount: 2,
        totalCount: 10,
        confirmedOffDeviceCount: 8,
      }),
    ).toBe('subiendo');
  });

  it('returns "protegido" when the capture is closed and every emitted chunk is uploaded', () => {
    expect(
      deriveGuardianStatus({
        ...baseInput,
        recordingClosed: true,
        totalCount: 10,
        confirmedOffDeviceCount: 10,
      }),
    ).toBe('protegido');
  });

  it('returns "listo" when there is no work and no recording', () => {
    expect(deriveGuardianStatus({ ...baseInput })).toBe('listo');
  });

  it('does NOT collapse to "protegido" when totalCount is 0 even if confirmedOffDeviceCount equals it', () => {
    // Edge case from the spec: protegido requires totalCount > 0.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        recordingClosed: true,
        totalCount: 0,
        confirmedOffDeviceCount: 0,
      }),
    ).toBe('listo');
  });

  it('treats activeCount > 0 as "subiendo" even if confirmedOffDeviceCount has already reached totalCount', () => {
    // Defensive: activeCount and confirmedOffDeviceCount could briefly disagree
    // mid-tick; the active signal must dominate so the UI never says
    // "protegido" while a chunk is still in flight.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        recordingClosed: true,
        activeCount: 1,
        totalCount: 5,
        confirmedOffDeviceCount: 5,
      }),
    ).toBe('subiendo');
  });

  it('flips to "error" the moment failedCount becomes positive, regardless of activity', () => {
    // failedCount dominates activeCount per precedence.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        failedCount: 1,
        activeCount: 5,
        totalCount: 10,
        confirmedOffDeviceCount: 4,
      }),
    ).toBe('error');
  });
});

describe('deriveGuardianStatus — an open capture can never read as safe', () => {
  it('regression 1 — recording live with every KNOWN chunk uploaded stays "grabando"', () => {
    // Audio: the worker routinely catches up with the producer for a
    // tick or two. That tie is not a finished recording.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        isRecording: true,
        totalCount: 4,
        confirmedOffDeviceCount: 4,
        activeCount: 0,
      }),
    ).toBe('grabando');
  });

  it('regression 3 — confirmedOffDeviceCount === totalCount > 0 but the capture is OPEN is never "protegido"', () => {
    const out = deriveGuardianStatus({
      ...baseInput,
      recordingClosed: false,
      totalCount: 6,
      confirmedOffDeviceCount: 6,
      activeCount: 0,
    });
    expect(out).not.toBe('protegido');
    expect(out).toBe('listo');
  });

  it('regression 4 — only a CLOSED capture with everything confirmed yields "protegido"', () => {
    // Same counters, single flag flipped.
    const open = { ...baseInput, totalCount: 6, confirmedOffDeviceCount: 6 };
    expect(deriveGuardianStatus({ ...open, recordingClosed: false })).not.toBe(
      'protegido',
    );
    expect(deriveGuardianStatus({ ...open, recordingClosed: true })).toBe(
      'protegido',
    );
  });
});

describe('deriveGuardianStatus — the post-PARAR window', () => {
  it('regression 2 — isStopping with an EMPTY queue is "subiendo", not "listo"', () => {
    // Video: `setIsRecording(false)` runs before `chunkVideoFile` has
    // emitted anything, so the queue is genuinely empty here. "Listo"
    // would tell the user the app is idle while their recording is
    // still being processed.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        isRecording: false,
        isStopping: true,
        recordingClosed: false,
        totalCount: 0,
        confirmedOffDeviceCount: 0,
        activeCount: 0,
      }),
    ).toBe('subiendo');
  });

  it('isStopping with all known chunks uploaded is "subiendo", not "protegido"', () => {
    // Audio: the last emitted chunk can be confirmed before
    // `queueMarkRecordingClosed` runs.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        isStopping: true,
        recordingClosed: false,
        totalCount: 7,
        confirmedOffDeviceCount: 7,
      }),
    ).toBe('subiendo');
  });

  it('isStopping does not outrank grabando, iniciando, recuperando or error', () => {
    const stopping = { ...baseInput, isStopping: true };
    expect(deriveGuardianStatus({ ...stopping, isRecording: true })).toBe(
      'grabando',
    );
    expect(deriveGuardianStatus({ ...stopping, isStarting: true })).toBe(
      'iniciando',
    );
    expect(deriveGuardianStatus({ ...stopping, isRecovering: true })).toBe(
      'recuperando',
    );
    expect(deriveGuardianStatus({ ...stopping, failedCount: 1 })).toBe('error');
  });
});

describe('isProtectedTally — the shared closed-and-complete predicate', () => {
  it('requires the capture to be closed', () => {
    expect(
      isProtectedTally({
        recordingClosed: false,
        totalCount: 3,
        confirmedOffDeviceCount: 3,
      }),
    ).toBe(false);
    expect(
      isProtectedTally({ recordingClosed: true, totalCount: 3, confirmedOffDeviceCount: 3 }),
    ).toBe(true);
  });

  it('requires at least one chunk', () => {
    expect(
      isProtectedTally({ recordingClosed: true, totalCount: 0, confirmedOffDeviceCount: 0 }),
    ).toBe(false);
  });

  it('requires every chunk to be confirmed', () => {
    expect(
      isProtectedTally({ recordingClosed: true, totalCount: 5, confirmedOffDeviceCount: 4 }),
    ).toBe(false);
  });

  it('regression 7 — fractional, negative and non-finite counters never assert protection', () => {
    const bad = [1.7, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const v of bad) {
      expect(
        isProtectedTally({
          recordingClosed: true,
          totalCount: v,
          confirmedOffDeviceCount: v,
        }),
      ).toBe(false);
      expect(
        isProtectedTally({
          recordingClosed: true,
          totalCount: 3,
          confirmedOffDeviceCount: v,
        }),
      ).toBe(false);
    }
  });

  it('is the same predicate deriveGuardianStatus uses for "protegido"', () => {
    // Guards against the two drifting apart: whenever the tally says
    // protected and nothing else is happening, the phase must agree.
    for (const recordingClosed of [false, true]) {
      for (const totalCount of [0, 1, 5]) {
        for (const confirmedOffDeviceCount of [0, 1, 5]) {
          const tally = isProtectedTally({
            recordingClosed,
            totalCount,
            confirmedOffDeviceCount,
          });
          const phase = deriveGuardianStatus({
            ...baseInput,
            recordingClosed,
            totalCount,
            confirmedOffDeviceCount,
          });
          expect(phase === 'protegido').toBe(tally);
        }
      }
    }
  });
});
