/**
 * POST_NOTIFICATIONS contextual helper — `@/permissions/notifications`.
 *
 * The rule under test: on Android 13+, a permission we cannot verify is
 * NEVER reported as granted. A false "granted" would hide the
 * reliability card's action on exactly the devices that need it, and
 * the user would silently lose the foreground-service notification.
 *
 * `react-native` is re-mocked per file (overriding tests/setup.ts) with
 * a MUTABLE Platform + PermissionsAndroid so each case can pick an OS,
 * an API level, and whether the POST_NOTIFICATIONS constant exists in
 * the bundle.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const platform: { OS: string; Version: unknown } = {
    OS: 'android',
    Version: 33,
  };
  const permissionsAndroid = {
    PERMISSIONS: {
      POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
    } as Record<string, string | undefined>,
    RESULTS: {
      GRANTED: 'granted',
      DENIED: 'denied',
      NEVER_ASK_AGAIN: 'never_ask_again',
    },
    check: vi.fn(async () => true),
    request: vi.fn(async () => 'granted'),
  };
  return { platform, permissionsAndroid };
});

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  PermissionsAndroid: mocks.permissionsAndroid,
}));

import {
  getPostNotificationsStatus,
  requestPostNotifications,
} from '@/permissions/notifications';

/** Reset to the default happy path: Android 13, constant present. */
beforeEach(() => {
  mocks.platform.OS = 'android';
  mocks.platform.Version = 33;
  mocks.permissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS =
    'android.permission.POST_NOTIFICATIONS';
  mocks.permissionsAndroid.check.mockReset();
  mocks.permissionsAndroid.request.mockReset();
  mocks.permissionsAndroid.check.mockResolvedValue(true);
  mocks.permissionsAndroid.request.mockResolvedValue('granted');
});

describe('Android 13+ — permission granted', () => {
  it('reports granted', async () => {
    mocks.permissionsAndroid.check.mockResolvedValue(true);
    await expect(getPostNotificationsStatus()).resolves.toBe('granted');
  });

  it('request short-circuits to true without showing the dialog', async () => {
    mocks.permissionsAndroid.check.mockResolvedValue(true);
    await expect(requestPostNotifications()).resolves.toBe(true);
    expect(mocks.permissionsAndroid.request).not.toHaveBeenCalled();
  });
});

describe('Android 13+ — permission denied', () => {
  it('reports denied', async () => {
    mocks.permissionsAndroid.check.mockResolvedValue(false);
    await expect(getPostNotificationsStatus()).resolves.toBe('denied');
  });

  it('request returns false when the user denies the dialog', async () => {
    mocks.permissionsAndroid.check.mockResolvedValue(false);
    mocks.permissionsAndroid.request.mockResolvedValue('denied');
    await expect(requestPostNotifications()).resolves.toBe(false);
    expect(mocks.permissionsAndroid.request).toHaveBeenCalledTimes(1);
  });

  it('request returns true when the user grants the dialog', async () => {
    mocks.permissionsAndroid.check.mockResolvedValue(false);
    mocks.permissionsAndroid.request.mockResolvedValue('granted');
    await expect(requestPostNotifications()).resolves.toBe(true);
  });

  it('treats never_ask_again as not granted', async () => {
    mocks.permissionsAndroid.check.mockResolvedValue(false);
    mocks.permissionsAndroid.request.mockResolvedValue('never_ask_again');
    await expect(requestPostNotifications()).resolves.toBe(false);
  });
});

describe('Android 13+ — POST_NOTIFICATIONS constant missing (regression)', () => {
  beforeEach(() => {
    mocks.permissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS = undefined;
  });

  it('reports unknown, never not_applicable', async () => {
    const status = await getPostNotificationsStatus();
    expect(status).toBe('unknown');
    expect(status).not.toBe('not_applicable');
  });

  it('NEVER returns true from the requester', async () => {
    // The defect this test locks down: the helper used to return `true`
    // here, i.e. "granted", for a permission it could not even name.
    await expect(requestPostNotifications()).resolves.toBe(false);
  });

  it('does not touch the platform permission API at all', async () => {
    await requestPostNotifications();
    expect(mocks.permissionsAndroid.check).not.toHaveBeenCalled();
    expect(mocks.permissionsAndroid.request).not.toHaveBeenCalled();
  });
});

describe('Android 13+ — unreadable API level', () => {
  beforeEach(() => {
    mocks.platform.Version = undefined;
  });

  it('reports unknown rather than assuming a pre-13 device', async () => {
    await expect(getPostNotificationsStatus()).resolves.toBe('unknown');
  });

  it('never returns true from the requester', async () => {
    await expect(requestPostNotifications()).resolves.toBe(false);
  });
});

describe('Android older than 13', () => {
  beforeEach(() => {
    mocks.platform.Version = 32;
  });

  it('reports not_applicable — the permission does not exist there', async () => {
    await expect(getPostNotificationsStatus()).resolves.toBe('not_applicable');
  });

  it('request returns true without invoking the permission API', async () => {
    await expect(requestPostNotifications()).resolves.toBe(true);
    expect(mocks.permissionsAndroid.check).not.toHaveBeenCalled();
    expect(mocks.permissionsAndroid.request).not.toHaveBeenCalled();
  });
});

describe('non-Android platforms', () => {
  it('iOS reports not_applicable and requests nothing', async () => {
    mocks.platform.OS = 'ios';
    await expect(getPostNotificationsStatus()).resolves.toBe('not_applicable');
    await expect(requestPostNotifications()).resolves.toBe(true);
    expect(mocks.permissionsAndroid.check).not.toHaveBeenCalled();
  });
});

describe('platform errors are non-blocking', () => {
  it('a throwing check() surfaces as unknown, not as a rejection', async () => {
    mocks.permissionsAndroid.check.mockRejectedValue(
      new Error('permission service unavailable'),
    );
    await expect(getPostNotificationsStatus()).resolves.toBe('unknown');
  });

  it('a throwing check() makes the requester return false, not throw', async () => {
    mocks.permissionsAndroid.check.mockRejectedValue(new Error('boom'));
    await expect(requestPostNotifications()).resolves.toBe(false);
  });

  it('a throwing request() returns false, not a rejection', async () => {
    mocks.permissionsAndroid.check.mockResolvedValue(false);
    mocks.permissionsAndroid.request.mockRejectedValue(
      new Error('activity destroyed'),
    );
    await expect(requestPostNotifications()).resolves.toBe(false);
  });

  it('neither helper ever rejects, across every failure mode', async () => {
    // Capture-path safety: the reliability card awaits these helpers
    // during render effects. An unhandled rejection there must never be
    // able to bubble into the screen that owns the record button.
    mocks.permissionsAndroid.check.mockRejectedValue(new Error('x'));
    mocks.permissionsAndroid.request.mockRejectedValue(new Error('y'));
    const results = await Promise.allSettled([
      getPostNotificationsStatus(),
      requestPostNotifications(),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});
