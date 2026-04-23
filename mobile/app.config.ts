import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Expo config.
 *
 * We use Expo Dev Client (not Managed) so we can drop in native modules
 * later for foreground services, background upload, SQLite, etc.
 *
 * Secrets live in `.env` and are exposed to the bundle via the standard
 * `EXPO_PUBLIC_*` prefix (read directly from `process.env`). Anything that
 * must NOT reach the client MUST NOT use that prefix.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Guardian Cloud',
  slug: 'guardian-cloud',
  scheme: 'guardiancloud',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.guardiancloud.app',
  },
  android: {
    package: 'com.guardiancloud.app',
  },
  plugins: [
    'expo-router',
    [
      'expo-av',
      {
        microphonePermission:
          'Allow Guardian Cloud to access the microphone to record evidence.',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
});
