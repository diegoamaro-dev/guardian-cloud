/**
 * DEV-only console wrapper for the beta APK.
 *
 * Two rules:
 *
 *   - `log` / `warn` are silenced in release builds. Keeps logcat
 *     clean for testers, stops dev-only diagnostic strings from
 *     reaching any future crash dashboard, and reduces battery /
 *     buffer churn for the noisiest call paths.
 *   - `error` ALWAYS reaches `console.error`. Real failures must
 *     stay visible in `adb logcat` even on the APK we ship — that
 *     is the only signal we have when a tester reports "it didn't
 *     work" without screenshots.
 *
 * Used surgically: only the noisiest call paths (export, foreground
 * service) import this wrapper. The rest of the app keeps raw
 * `console.*` for now. A mass migration is deliberately deferred —
 * touching every file would balloon the beta-hardening diff and
 * carry risk for net-zero benefit.
 *
 * `__DEV__` is React Native's compile-time constant. Hermes / Metro
 * tree-shake the dead branches, so the release bundle pays no
 * runtime cost for the dev paths.
 */

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

type ConsoleFn = (...args: unknown[]) => void;

const noop: ConsoleFn = () => undefined;

export const log: ConsoleFn = isDev ? console.log.bind(console) : noop;
export const warn: ConsoleFn = isDev ? console.warn.bind(console) : noop;
export const error: ConsoleFn = console.error.bind(console);

/**
 * Funnel uncaught JS errors through `console.error` so they reach
 * logcat in release builds. Does NOT suppress: chains to whatever
 * handler RN had installed previously so the platform default
 * (red-screen-in-dev / native-crash-reporter-in-release) still fires.
 *
 * Worker / chunking / recovery / export errors that already have
 * structured catch blocks remain untouched — those paths log with
 * `error()` directly. This handler is the safety net for the genuinely
 * unhandled (unawaited promise rejections, throws from background
 * timers without a try/catch).
 *
 * Idempotent. Calling twice during fast-refresh installs a chain that
 * still forwards correctly to the original platform handler.
 */
type RNErrorUtils = {
  getGlobalHandler?: () => ((err: Error, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (h: (err: Error, isFatal?: boolean) => void) => void;
};

export function installGlobalErrorHandler(): void {
  const utils = (globalThis as unknown as { ErrorUtils?: RNErrorUtils }).ErrorUtils;
  if (!utils || typeof utils.setGlobalHandler !== 'function') return;

  const previous =
    typeof utils.getGlobalHandler === 'function' ? utils.getGlobalHandler() : undefined;

  utils.setGlobalHandler((err, isFatal) => {
    error('GLOBAL_ERROR', {
      message: err?.message ?? String(err),
      stack: err?.stack,
      fatal: Boolean(isFatal),
    });

    if (previous) {
      try {
        previous(err, isFatal);
      } catch {
        // Defensive: never let our log path eat the original handler.
      }
    }
  });
}
