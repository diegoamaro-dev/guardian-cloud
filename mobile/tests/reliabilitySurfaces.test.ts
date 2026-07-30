/**
 * Single-surface guard for the reliability recommendations.
 *
 * Requirement: Home must expose exactly ONE battery control and ONE
 * notifications control, and Settings must keep a permanent battery
 * access — through the ReliabilityCard in both cases. Two equivalent
 * controls for the same system page is the defect this locks down.
 *
 * This is a SOURCE-LEVEL assertion, deliberately. The project ships no
 * React renderer in its test environment (vitest runs in `node`, with
 * no @testing-library/react-native and no react-test-renderer), and
 * adding one is out of scope — no new dependencies. Reading the screen
 * sources is the only way to assert "there is no second button" without
 * a renderer. The assertions are kept coarse on purpose: they check
 * which module owns each entry point, not markup or copy, so ordinary
 * styling and wording edits cannot break them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Strip comments so the assertions below see CODE only.
 *
 * Without this, a comment explaining that a control was removed would
 * itself match the "is it gone?" check. Only `/* … *\/` blocks (which
 * covers JSX `{/* … *\/}`) and whole-line `//` comments are removed —
 * trailing `//` is left alone so URLs inside string literals survive.
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function source(relative: string): string {
  // `.href` rather than the URL object: the project's lib includes DOM,
  // so `new URL()` resolves to the DOM type and does not match the
  // node:url overload. A string is unambiguous.
  const path = fileURLToPath(new URL(relative, import.meta.url).href);
  return stripComments(readFileSync(path, 'utf8'));
}

const homeScreen = source('../app/index.tsx');
const settingsScreen = source('../app/settings.tsx');
const card = source('../src/components/ReliabilityCard.tsx');

/** Count non-overlapping occurrences of a literal. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('battery optimisation has a single owner', () => {
  it('only the ReliabilityCard opens the battery settings page', () => {
    expect(count(card, 'openBatteryOptimizationSettings(')).toBeGreaterThan(0);
    expect(homeScreen).not.toContain('openBatteryOptimizationSettings');
    expect(settingsScreen).not.toContain('openBatteryOptimizationSettings');
  });

  it('the legacy "Batería ilimitada" button is gone from Settings', () => {
    expect(settingsScreen).not.toContain('Batería ilimitada');
  });

  it('Settings still mounts the card, so the access stays permanent', () => {
    expect(count(settingsScreen, '<ReliabilityCard')).toBe(1);
    expect(settingsScreen).toContain('mode="settings"');
  });
});

describe('notifications have a single surface on Home', () => {
  it('the legacy POST_NOTIFICATIONS pill is gone', () => {
    // The pill was the only consumer of Linking.openSettings() on the
    // home screen and the only reader of the notificationDenied flag.
    expect(homeScreen).not.toContain('Linking.openSettings()');
    expect(homeScreen).not.toContain('Sin notificación de fondo');
    expect(homeScreen).not.toContain('(s) => s.notificationDenied');
  });

  it('detection and storage of the denial are preserved', () => {
    // Only the redundant VISUAL surface was removed. The FG-service
    // result path must still record the denial.
    expect(homeScreen).toContain('setNotificationDenied');
    expect(count(homeScreen, 'setNotificationDenied(')).toBeGreaterThan(0);
  });

  it('the card remains a way to grant the permission', () => {
    expect(card).toContain('requestPostNotifications');
  });
});

describe('Home mounts exactly one reliability card', () => {
  it('has a single mount point', () => {
    expect(count(homeScreen, '<ReliabilityCard')).toBe(1);
  });

  it('gates it on the full capture window, not on showStop', () => {
    expect(homeScreen).toContain('recordingBusy={isRecordingBusy(');
    expect(homeScreen).toContain('isStarting, isRecording, isStopping');
    // The old prop is gone — it only covered isRecording || isStopping.
    expect(homeScreen).not.toContain('isRecording={showStop}');
  });
});

describe('the card makes no claim about the battery exemption', () => {
  it('never tells the user the optimisation is resolved', () => {
    // The app cannot read the exemption state without a native module,
    // so no copy may assert it. Guard against the obvious phrasings.
    for (const claim of [
      'desactivada',
      'desactivado',
      'ya está configurado',
      'configurado correctamente',
      'optimización desactivada',
      'resuelto',
    ]) {
      expect(card.toLowerCase()).not.toContain(claim);
    }
  });
});
