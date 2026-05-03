/**
 * Vitest global setup for mobile.
 *
 * Two responsibilities:
 *
 * 1. Silence the verbose `console.log` breadcrumbs the production code
 *    emits at runtime. Tests that need to assert on a specific log can
 *    re-spy on console.log explicitly.
 *
 * 2. Stub every native / Expo module that `mobile/app/index.tsx`
 *    imports at module load. Without these stubs the file cannot be
 *    evaluated in Node — `expo-av`, `expo-camera`, `react-native`, etc.
 *    all assume a React Native runtime. Test files that need real
 *    behavior from a specific stub (typically AsyncStorage to seed the
 *    queue) override these with their own per-file `vi.mock(...)`.
 *
 * The stubs deliberately return shapes that satisfy import-time access
 * (constants, `Platform.OS`, class shells) but do NOT pretend to be
 * the real module — calling into a method that we did not surface will
 * throw, which is the correct signal that a test is straying outside
 * the scope of the queue/worker subset.
 */

import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// --- React Native ---------------------------------------------------
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  AppState: {
    currentState: 'active' as const,
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Platform: { OS: 'android', Version: 33 },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
    check: vi.fn(async () => true),
    request: vi.fn(async () => 'granted'),
  },
}));

// --- Expo modules ---------------------------------------------------
vi.mock('expo-av', () => ({
  Audio: {
    Recording: class {
      prepareToRecordAsync = vi.fn();
      startAsync = vi.fn();
      stopAndUnloadAsync = vi.fn();
      getURI = vi.fn(() => null);
    },
    setAudioModeAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
    // Read at module-load time by `app/index.tsx` to spread into
    // RECORDING_OPTIONS. Empty object is fine — the spread just adds
    // no fields, and tests never exercise the actual recorder.
    RecordingOptionsPresets: {
      HIGH_QUALITY: {},
      LOW_QUALITY: {},
    },
    AndroidOutputFormat: {},
    AndroidAudioEncoder: {},
    IOSOutputFormat: {},
    IOSAudioQuality: {},
  },
}));

vi.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
}));

vi.mock('expo-file-system', () => ({
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  readAsStringAsync: vi.fn(async () => ''),
  writeAsStringAsync: vi.fn(),
  deleteAsync: vi.fn(),
  moveAsync: vi.fn(),
  readDirectoryAsync: vi.fn(async () => []),
  makeDirectoryAsync: vi.fn(),
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

vi.mock('expo-crypto', () => ({
  digest: vi.fn(async () => new ArrayBuffer(32)),
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
}));

// expo-haptics → no-op stubs. We never assert on the vibrations (they
// are fire-and-forget in production), so a minimal surface is enough.
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: {
    Success: 'Success',
    Warning: 'Warning',
    Error: 'Error',
  },
}));

vi.mock('expo-router', () => ({
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
  },
  Stack: { Screen: () => null },
}));

// --- AsyncStorage ---------------------------------------------------
// Default in-memory implementation. Test files that need to control
// behavior (most queue/finalize tests) override this with their own
// per-file vi.mock that exposes the underlying Map.
vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
      setItem: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      removeItem: vi.fn(async (k: string) => {
        store.delete(k);
      }),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const k of keys) store.delete(k);
      }),
      getAllKeys: vi.fn(async () => Array.from(store.keys())),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

// --- Internal aliases ------------------------------------------------
vi.mock('@/auth/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
      getSession: vi.fn(async () => ({ data: { session: null } })),
      signOut: vi.fn(),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

vi.mock('@/auth/store', () => ({
  useAuthStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({ status: 'loading' })),
  },
  getFreshAccessToken: vi.fn(async () => null),
}));

vi.mock('@/config/env', () => ({
  env: { apiUrl: 'http://test.local' },
}));

vi.mock('@/api/destinations', () => ({
  getConnectedDrive: vi.fn(async () => null),
  uploadChunkBytes: vi.fn(),
}));

vi.mock('@/api/client', async () => {
  // The real ApiError is small and pure; rebuild it locally so
  // classifyError tests can construct instances with realistic shape.
  class ApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    readonly body: unknown;
    constructor(
      status: number,
      code: string | undefined,
      message: string,
      body: unknown,
    ) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }
  return { ApiError };
});

vi.mock('@/api/history', () => ({
  appendHistoryEntry: vi.fn(),
}));

vi.mock('@/dev/reset', () => ({
  hardResetAppState: vi.fn(),
}));

vi.mock('@/recording/chunkProducer', () => ({}));

vi.mock('@/recording/recordingController', () => ({
  RecordingController: class {
    start = vi.fn();
    stop = vi.fn();
    chunkVideoFile = vi.fn(async () => 0);
  },
}));

// `@/recording/deriveGuardianStatus` is intentionally NOT mocked — it
// is pure JS, safe to load in node, and the dedicated test file
// imports it directly. Mocking it globally would intercept that
// import too (both specifiers resolve to the same physical file).
// `@/recording/localEvidence` is the same — pure, leave it alone so
// the dedicated test file gets the real implementation.

vi.mock('@/recording/backgroundService', () => ({
  startBackgroundProtection: vi.fn(async () => true),
  stopBackgroundProtection: vi.fn(async () => undefined),
  isBackgroundProtectionRunning: vi.fn(() => false),
}));

vi.mock('react-native-background-actions', () => ({
  default: {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => false),
  },
}));

// Global fetch stub. Tests that exercise tryFinalizeReadySessions /
// completeSession override this with vi.stubGlobal('fetch', ...).
if (typeof globalThis.fetch === 'undefined') {
  // @ts-expect-error — minimal stub for environments without fetch
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status: 0,
    json: async () => ({}),
    text: async () => '',
    headers: { get: () => null },
  }));
}
