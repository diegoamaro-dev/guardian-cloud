/**
 * SPIKE — P2 early gate. Public API of the native segmented recorder.
 *
 * Deliberately minimal: start, stop, a preview view and three events. The
 * rotation policy lives entirely in Kotlin — JavaScript never decides when a
 * segment closes.
 *
 * Not production code. Lives only on `spike/video-p2-early-gate`.
 */
import { requireNativeModule, requireNativeView } from 'expo';
import type * as React from 'react';
import type { ViewProps } from 'react-native';

import type {
  CaptureErrorEvent,
  CaptureReleasedEvent,
  GateHarnessOptions,
  GCSegmentedRecorderEvents,
  SegmentClosedEvent,
} from './src/GCSegmentedRecorder.types';

export type {
  CaptureErrorEvent,
  CaptureReleasedEvent,
  GateHarnessOptions,
  GCSegmentedRecorderEvents,
  SegmentClosedEvent,
};

/**
 * Closed result set for `cleanupCompletedSession`. Mirrors the Kotlin side
 * exactly — anything outside this union means the two got out of step, and the
 * caller must treat it as a failure rather than guess.
 *
 *   CLEANED             directory and its files removed
 *   ALREADY_ABSENT      nothing was there; terminal, same as done
 *   PARTIAL             some files went, some remain; retry converges
 *   SESSION_ACTIVE      that session is live or still releasing; refused
 *   SESSION_ID_INVALID  not a canonical lowercase UUID; nothing touched
 *   DIR_UNAVAILABLE     no cache dir, unlistable, not a directory, or the
 *                       canonical path fell outside the base directory
 */
export type NativeCleanupResult =
  | 'CLEANED'
  | 'ALREADY_ABSENT'
  | 'PARTIAL'
  | 'SESSION_ACTIVE'
  | 'SESSION_ID_INVALID'
  | 'DIR_UNAVAILABLE';

export type NativeCleanupOutcome = {
  result: NativeCleanupResult;
  /** Files removed by this call. */
  removed: number;
  /** Files still present afterwards; `-1` when it could not be determined. */
  remaining: number;
};

type GCSegmentedRecorderModuleType = {
  /**
   * Opens the camera, starts both encoders, and runs the gate session.
   *
   * `options` is a diagnostic harness override and must only be passed from
   * `/debug-p2-gate`, which does not exist in a release bundle. Called with the
   * session id alone it behaves exactly as it always has.
   */
  startSegmentedCapture(
    sessionId: string,
    options?: GateHarnessOptions,
  ): Promise<void>;
  /** Idempotent. Closes the active segment and releases the camera. */
  stopSegmentedCapture(): Promise<void>;
  /**
   * Deletes `cacheDir/gc-segmented-recorder/<sessionId>/`. Idempotent.
   *
   * The module does not know whether a session finished — that is a remote fact
   * the caller must have proven durably before asking. This only executes,
   * refuses, or reports that nothing was there.
   *
   * Never throws for an expected refusal: every outcome comes back as a code.
   */
  cleanupCompletedSession(sessionId: string): Promise<NativeCleanupOutcome>;
  /** Diagnostic read of the coordinator state machine. */
  getState(): string;
  addListener<K extends keyof GCSegmentedRecorderEvents>(
    event: K,
    listener: GCSegmentedRecorderEvents[K],
  ): { remove(): void };
};

const GCSegmentedRecorder =
  requireNativeModule<GCSegmentedRecorderModuleType>('GCSegmentedRecorder');

export default GCSegmentedRecorder;

export const GCSegmentedCameraView: React.ComponentType<ViewProps> =
  requireNativeView('GCSegmentedRecorder');
