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
 *   5. subiendo    — chunks still in motion (activeCount > 0).
 *   6. protegido   — every emitted chunk is uploaded (totalCount > 0
 *                    AND uploadedCount === totalCount).
 *   7. listo       — fallback.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveGuardianStatus,
  type GuardianStatusInput,
} from '../src/recording/deriveGuardianStatus';

const baseInput: GuardianStatusInput = {
  isRecording: false,
  isRecovering: false,
  isStarting: false,
  totalCount: 0,
  uploadedCount: 0,
  activeCount: 0,
  failedCount: 0,
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
        uploadedCount: 10,
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
        uploadedCount: 10,
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
        uploadedCount: 6,
      }),
    ).toBe('error');
  });

  it('returns "subiendo" when chunks are still in motion (no failures, not recording, not recovering)', () => {
    expect(
      deriveGuardianStatus({
        ...baseInput,
        activeCount: 2,
        totalCount: 10,
        uploadedCount: 8,
      }),
    ).toBe('subiendo');
  });

  it('returns "protegido" when totalCount > 0 and every emitted chunk is uploaded', () => {
    expect(
      deriveGuardianStatus({
        ...baseInput,
        totalCount: 10,
        uploadedCount: 10,
      }),
    ).toBe('protegido');
  });

  it('returns "listo" when there is no work and no recording', () => {
    expect(deriveGuardianStatus({ ...baseInput })).toBe('listo');
  });

  it('does NOT collapse to "protegido" when totalCount is 0 even if uploadedCount equals it', () => {
    // Edge case from the spec: protegido requires totalCount > 0.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        totalCount: 0,
        uploadedCount: 0,
      }),
    ).toBe('listo');
  });

  it('treats activeCount > 0 as "subiendo" even if uploadedCount has already reached totalCount', () => {
    // Defensive: activeCount and uploadedCount could briefly disagree
    // mid-tick; the active signal must dominate so the UI never says
    // "protegido" while a chunk is still in flight.
    expect(
      deriveGuardianStatus({
        ...baseInput,
        activeCount: 1,
        totalCount: 5,
        uploadedCount: 5,
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
        uploadedCount: 4,
      }),
    ).toBe('error');
  });
});
