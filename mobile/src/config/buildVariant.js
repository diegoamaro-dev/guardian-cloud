/**
 * E1 — how a BENCH build differs from a PRODUCTION build, in one place.
 *
 * ## Why this file is JavaScript and not TypeScript
 *
 * `app.config.ts` is transpiled by Expo's own config loader, which
 * compiles THAT file and nothing else: a relative import of a `.ts`
 * module fails at require time with "Cannot find module". Written as
 * CommonJS JavaScript, the same module is loadable by Expo's loader,
 * by Node, and by the test runner — so the rule exists exactly once
 * instead of being duplicated inside the config where no test can see
 * it. `allowJs` is already on in the Expo base tsconfig, so the typed
 * side of the app keeps its types through the JSDoc annotations below.
 *
 * ## What the bench variant changes, and why each one
 *
 *   name     → visible on the launcher and in the task switcher. An
 *              operator holding the device must be able to tell which
 *              build is running WITHOUT opening it.
 *   package  → a different Android application id, so bench and
 *              production coexist instead of overwriting each other.
 *              An overwrite is the worst case: same icon, same name,
 *              different project, no trace of the swap.
 *
 * ## KNOWN LIMIT, stated rather than papered over
 *
 * `android/` is committed, and `android/app/build.gradle` carries the
 * production `applicationId` literally. A build invoked straight through
 * Gradle, skipping Expo's config entirely, therefore keeps the
 * production id regardless of this module — nothing here can reach it.
 * Every path that DOES evaluate `app.config.ts` (`expo prebuild`,
 * `expo run:android`, EAS) refuses to continue without a declared
 * environment, and `src/config/env.ts` refuses to boot one at runtime.
 * Those two are the guarantees; the Gradle-only path is the gap, and it
 * is named here rather than assumed away.
 */

const PRODUCTION_APP_NAME = 'Guardian Cloud';
const PRODUCTION_ANDROID_PACKAGE = 'com.guariacloud.app';

/** The only two accepted declarations. There is no third, and no empty. */
const BUILD_ENVIRONMENTS = /** @type {const} */ (['production', 'bench']);

class UndeclaredBuildEnvironmentError extends Error {
  /** @param {unknown} received */
  constructor(received) {
    super(
      "EXPO_PUBLIC_GC_ENV must be declared as exactly 'production' or " +
        `'bench' before building. Received: ${JSON.stringify(received)}`,
    );
    this.name = 'UndeclaredBuildEnvironmentError';
  }
}

/**
 * Resolves the variant from the DECLARED environment, or REFUSES.
 *
 * Why this throws instead of defaulting to production: a previous version
 * treated anything that was not the literal `'bench'` as production, so
 * `undefined`, `''`, `'Bench'` or a typo produced a native identity
 * indistinguishable from the real app. `env.ts` failing later, at JS
 * startup, does not help — by then the APK already exists, already
 * carries the production application id, and can already be installed
 * over the real one.
 *
 * The guarantee is that a build cannot be produced at all without
 * declaring which environment it belongs to, so this refusal happens
 * during `app.config.ts` evaluation: before prebuild writes a single
 * native file.
 *
 * @param {string | undefined} gcEnv
 * @returns {{ name: string, androidPackage: string, isBench: boolean }}
 */
function resolveBuildVariant(gcEnv) {
  if (
    typeof gcEnv !== 'string' ||
    !/** @type {readonly string[]} */ (BUILD_ENVIRONMENTS).includes(gcEnv)
  ) {
    throw new UndeclaredBuildEnvironmentError(gcEnv);
  }
  const isBench = gcEnv === 'bench';
  return {
    isBench,
    name: isBench ? `${PRODUCTION_APP_NAME} BANCO` : PRODUCTION_APP_NAME,
    androidPackage: isBench
      ? `${PRODUCTION_ANDROID_PACKAGE}.bench`
      : PRODUCTION_ANDROID_PACKAGE,
  };
}

module.exports = {
  PRODUCTION_APP_NAME,
  PRODUCTION_ANDROID_PACKAGE,
  BUILD_ENVIRONMENTS,
  UndeclaredBuildEnvironmentError,
  resolveBuildVariant,
};
