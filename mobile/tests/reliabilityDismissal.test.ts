/**
 * ReliabilityCard persistence — `@/permissions/reliabilityDismissal`.
 *
 * Two rules under test:
 *
 * 1. The dismissal flag ("Ahora no") and the battery-guidance flag are
 *    INDEPENDENT. Neither action may suppress the other's surface.
 * 2. Every storage failure is contained. These helpers run inside the
 *    home screen's render effects, so a rejection escaping them could
 *    reach the screen that owns the record button.
 *
 * AsyncStorage is re-mocked per file (overriding tests/setup.ts) with an
 * injectable failure switch and an inspectable backing map.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  const fail = { getItem: false, setItem: false };
  return { store, fail };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (mocks.fail.getItem) throw new Error('AsyncStorage unavailable');
      return mocks.store.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      if (mocks.fail.setItem) throw new Error('database or disk is full');
      mocks.store.set(key, value);
    }),
  },
}));

import {
  hasOpenedBatteryGuidance,
  isReliabilityCardDismissed,
  markBatteryGuidanceOpened,
  markReliabilityCardDismissed,
} from '@/permissions/reliabilityDismissal';

const DISMISS_KEY = 'gc.reliability.dismissed_at';
const BATTERY_KEY = 'gc.reliability.battery_guidance_opened_at';

beforeEach(() => {
  mocks.store.clear();
  mocks.fail.getItem = false;
  mocks.fail.setItem = false;
});

describe('"Ahora no" dismissal', () => {
  it('defaults to not dismissed on a fresh install', async () => {
    await expect(isReliabilityCardDismissed()).resolves.toBe(false);
  });

  it('is readable back after being marked', async () => {
    await markReliabilityCardDismissed();
    await expect(isReliabilityCardDismissed()).resolves.toBe(true);
  });

  it('survives a simulated app restart', async () => {
    await markReliabilityCardDismissed();
    // A restart drops all module state; the backing store is what
    // persists. Re-importing proves the answer comes from storage and
    // not from a module-level cache.
    vi.resetModules();
    const fresh = await import('@/permissions/reliabilityDismissal');
    await expect(fresh.isReliabilityCardDismissed()).resolves.toBe(true);
  });

  it('writes a parseable timestamp under its own key', async () => {
    const before = Date.now();
    await markReliabilityCardDismissed();
    const raw = mocks.store.get(DISMISS_KEY);
    expect(raw).toBeDefined();
    expect(Number(raw)).toBeGreaterThanOrEqual(before);
  });
});

describe('battery-guidance flag', () => {
  it('defaults to not opened', async () => {
    await expect(hasOpenedBatteryGuidance()).resolves.toBe(false);
  });

  it('is readable back after being marked', async () => {
    await markBatteryGuidanceOpened();
    await expect(hasOpenedBatteryGuidance()).resolves.toBe(true);
  });

  it('survives a simulated app restart', async () => {
    await markBatteryGuidanceOpened();
    vi.resetModules();
    const fresh = await import('@/permissions/reliabilityDismissal');
    await expect(fresh.hasOpenedBatteryGuidance()).resolves.toBe(true);
  });
});

describe('the two flags are independent', () => {
  it('dismissing the card does not mark the battery guidance as opened', async () => {
    await markReliabilityCardDismissed();
    await expect(hasOpenedBatteryGuidance()).resolves.toBe(false);
  });

  it('opening the battery guidance does not dismiss the card', async () => {
    await markBatteryGuidanceOpened();
    await expect(isReliabilityCardDismissed()).resolves.toBe(false);
  });

  it('uses two distinct, explicitly named keys', async () => {
    await markReliabilityCardDismissed();
    await markBatteryGuidanceOpened();
    expect(Array.from(mocks.store.keys()).sort()).toEqual(
      [BATTERY_KEY, DISMISS_KEY].sort(),
    );
  });

  it('neither key collides with the GC_QUEUE namespace', async () => {
    await markReliabilityCardDismissed();
    await markBatteryGuidanceOpened();
    for (const key of mocks.store.keys()) {
      expect(key.startsWith('gc.reliability.')).toBe(true);
      expect(key).not.toContain('GC_QUEUE');
      expect(key).not.toContain('pending_retry');
    }
  });
});

describe('AsyncStorage failures stay contained', () => {
  it('a failing read reports "not dismissed" instead of throwing', async () => {
    mocks.fail.getItem = true;
    await expect(isReliabilityCardDismissed()).resolves.toBe(false);
  });

  it('a failing read reports "not opened" instead of throwing', async () => {
    mocks.fail.getItem = true;
    await expect(hasOpenedBatteryGuidance()).resolves.toBe(false);
  });

  it('a failing write resolves silently for both flags', async () => {
    mocks.fail.setItem = true;
    await expect(markReliabilityCardDismissed()).resolves.toBeUndefined();
    await expect(markBatteryGuidanceOpened()).resolves.toBeUndefined();
  });

  it('no helper rejects when storage is entirely broken', async () => {
    // The capture path must be unreachable from a storage fault: these
    // four helpers are all the card ever calls.
    mocks.fail.getItem = true;
    mocks.fail.setItem = true;
    const results = await Promise.allSettled([
      isReliabilityCardDismissed(),
      hasOpenedBatteryGuidance(),
      markReliabilityCardDismissed(),
      markBatteryGuidanceOpened(),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('an empty stored value counts as unset', async () => {
    mocks.store.set(DISMISS_KEY, '');
    mocks.store.set(BATTERY_KEY, '');
    await expect(isReliabilityCardDismissed()).resolves.toBe(false);
    await expect(hasOpenedBatteryGuidance()).resolves.toBe(false);
  });
});
