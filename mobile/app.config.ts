import type { ExpoConfig, ConfigContext } from 'expo/config';
import { withAndroidManifest } from '@expo/config-plugins';

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
  icon: './assets/foreground.png',
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.guardiancloud.app',
  },
  android: {
    package: 'com.guardiancloud.app',
    adaptiveIcon: {
      foregroundImage: './assets/foreground.png',
      backgroundColor: '#000000',
    },
  },
  plugins: [
    /**
     * react-native-background-actions foreground service fix.
     *
     * RNBackgroundActionsTask starts with FOREGROUND_SERVICE_TYPE_MICROPHONE
     * (0x80). Android 14+ requires the <service> declaration to explicitly
     * list every type the code requests — a missing or zero-value
     * android:foregroundServiceType causes an immediate crash:
     *   "foregroundServiceType 0x00000080 is not a subset of
     *    foregroundServiceType attribute 0x00000000"
     *
     * This plugin ensures the fix survives `npx expo prebuild`.
     */
    (config): ExpoConfig =>
      withAndroidManifest(config, (mod) => {
        const app = mod.modResults.manifest.application?.[0];
        if (!app) return mod;

        // Ensure permissions
        const manifest = mod.modResults.manifest;
        const existingPerms: string[] = (manifest['uses-permission'] ?? []).map(
          (p: { $: { 'android:name': string } }) => p.$['android:name'],
        );
        const requiredPerms = [
          'android.permission.FOREGROUND_SERVICE',
          'android.permission.FOREGROUND_SERVICE_MICROPHONE',
          'android.permission.WAKE_LOCK',
        ];
        for (const perm of requiredPerms) {
          if (!existingPerms.includes(perm)) {
            manifest['uses-permission'] = manifest['uses-permission'] ?? [];
            manifest['uses-permission'].push({ $: { 'android:name': perm } });
          }
        }

        // Ensure service declaration with foregroundServiceType
        const services: { $: Record<string, string> }[] = app.service ?? [];
        const svcName = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';
        const existing = services.find((s) => s.$['android:name'] === svcName);
        if (existing) {
          existing.$['android:foregroundServiceType'] = 'microphone';
        } else {
          app.service = [
            ...services,
            {
              $: {
                'android:name': svcName,
                'android:foregroundServiceType': 'microphone',
              },
            },
          ];
        }
        return mod;
      }),
    'expo-router',
    [
      'expo-av',
      {
        microphonePermission:
          'Allow Guardian Cloud to access the microphone to record evidence.',
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission:
          'Allow Guardian Cloud to access the camera to record video evidence.',
        microphonePermission:
          'Allow Guardian Cloud to access the microphone to record video evidence.',
        recordAudioAndroid: true,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
});
