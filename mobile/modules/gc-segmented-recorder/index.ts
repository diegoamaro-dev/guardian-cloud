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
