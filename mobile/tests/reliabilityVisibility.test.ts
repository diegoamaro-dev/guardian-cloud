/**
 * ReliabilityCard visibility rules — `@/permissions/reliabilityVisibility`.
 *
 * The invariant that matters most here: the card must be absent from
 * Home for the WHOLE capture window — `isStarting`, `isRecording` and
 * `isStopping` — so it can never steal a tap from the record/stop
 * button or reflow the layout mid-capture.
 *
 * Pure module: no mocks needed beyond the global setup.
 */

import { describe, expect, it } from 'vitest';

import type { PostNotifStatus } from '@/permissions/notifications';
import {
  decideReliabilityCard,
  isRecordingBusy,
  shouldShowNotificationsAction,
  type ReliabilityHomeInput,
} from '@/permissions/reliabilityVisibility';

/** Home input with everything set so the card WOULD be visible. */
function homeInput(
  overrides: Partial<Omit<ReliabilityHomeInput, 'mode'>> = {},
): ReliabilityHomeInput {
  return {
    mode: 'home',
    driveConnected: true,
    recordingBusy: false,
    dismissed: false,
    notifStatus: 'denied',
    batteryGuidanceOpened: false,
    ...overrides,
  };
}

describe('isRecordingBusy', () => {
  it('is false only when all three flags are false', () => {
    expect(
      isRecordingBusy({
        isStarting: false,
        isRecording: false,
        isStopping: false,
      }),
    ).toBe(false);
  });

  it('is true while starting', () => {
    expect(
      isRecordingBusy({
        isStarting: true,
        isRecording: false,
        isStopping: false,
      }),
    ).toBe(true);
  });

  it('is true while recording', () => {
    expect(
      isRecordingBusy({
        isStarting: false,
        isRecording: true,
        isStopping: false,
      }),
    ).toBe(true);
  });

  it('is true while stopping', () => {
    expect(
      isRecordingBusy({
        isStarting: false,
        isRecording: false,
        isStopping: true,
      }),
    ).toBe(true);
  });

  it('covers isStarting, which the old showStop gate did not', () => {
    // Regression lock: `showStop` was `isRecording || isStopping`, so a
    // start-in-progress left the card on screen.
    const starting = {
      isStarting: true,
      isRecording: false,
      isStopping: false,
    };
    const legacyShowStop = starting.isRecording || starting.isStopping;
    expect(legacyShowStop).toBe(false);
    expect(isRecordingBusy(starting)).toBe(true);
  });
});

describe('Home — hidden during every capture phase', () => {
  const phases: Array<[string, { isStarting: boolean; isRecording: boolean; isStopping: boolean }]> =
    [
      ['isStarting', { isStarting: true, isRecording: false, isStopping: false }],
      ['isRecording', { isStarting: false, isRecording: true, isStopping: false }],
      ['isStopping', { isStarting: false, isRecording: false, isStopping: true }],
      ['starting+recording', { isStarting: true, isRecording: true, isStopping: false }],
      ['recording+stopping', { isStarting: false, isRecording: true, isStopping: true }],
    ];

  for (const [label, activity] of phases) {
    it(`is hidden during ${label}`, () => {
      const decision = decideReliabilityCard(
        homeInput({ recordingBusy: isRecordingBusy(activity) }),
      );
      expect(decision.visible).toBe(false);
    });
  }

  it('is visible when idle with something to recommend', () => {
    expect(decideReliabilityCard(homeInput()).visible).toBe(true);
  });
});

describe('Home — other visibility gates', () => {
  it('is hidden without a Drive destination', () => {
    expect(
      decideReliabilityCard(homeInput({ driveConnected: false })).visible,
    ).toBe(false);
  });

  it('is hidden once dismissed', () => {
    expect(decideReliabilityCard(homeInput({ dismissed: true })).visible).toBe(
      false,
    );
  });

  it('offers the dismiss affordance', () => {
    expect(decideReliabilityCard(homeInput()).showDismiss).toBe(true);
  });
});

describe('Home — battery recommendation after the user opened it', () => {
  it('drops the battery action but keeps the card for notifications', () => {
    const decision = decideReliabilityCard(
      homeInput({ batteryGuidanceOpened: true, notifStatus: 'denied' }),
    );
    expect(decision.visible).toBe(true);
    expect(decision.showBatteryAction).toBe(false);
    expect(decision.showNotificationsAction).toBe(true);
  });

  it('hides the whole card when nothing is left to recommend', () => {
    const decision = decideReliabilityCard(
      homeInput({ batteryGuidanceOpened: true, notifStatus: 'granted' }),
    );
    expect(decision.visible).toBe(false);
  });

  it('keeps the battery action while the guidance has not been opened', () => {
    expect(decideReliabilityCard(homeInput()).showBatteryAction).toBe(true);
  });
});

describe('Settings — permanent surface', () => {
  it('is visible regardless of dismissal or battery-guidance state', () => {
    const decision = decideReliabilityCard({
      mode: 'settings',
      notifStatus: 'granted',
    });
    expect(decision.visible).toBe(true);
  });

  it('always keeps the battery action reachable', () => {
    for (const status of [
      'granted',
      'denied',
      'unknown',
      'not_applicable',
    ] as PostNotifStatus[]) {
      const decision = decideReliabilityCard({ mode: 'settings', notifStatus: status });
      expect(decision.showBatteryAction).toBe(true);
    }
  });

  it('never offers a dismiss affordance', () => {
    expect(
      decideReliabilityCard({ mode: 'settings', notifStatus: 'denied' })
        .showDismiss,
    ).toBe(false);
  });
});

describe('notifications action visibility', () => {
  it('is hidden when granted or not applicable', () => {
    expect(shouldShowNotificationsAction('granted')).toBe(false);
    expect(shouldShowNotificationsAction('not_applicable')).toBe(false);
  });

  it('is shown when denied or unverifiable', () => {
    // 'unknown' must keep the action reachable — an unverifiable
    // permission is treated as missing, never as granted.
    expect(shouldShowNotificationsAction('denied')).toBe(true);
    expect(shouldShowNotificationsAction('unknown')).toBe(true);
  });
});
