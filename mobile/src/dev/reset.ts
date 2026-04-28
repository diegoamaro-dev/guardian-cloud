/** DEV-only hard reset. Removes Guardian Cloud volatile testing keys and
 *  recreates documentDirectory and cacheDirectory. Preserves Supabase auth
 *  tokens (so the user stays signed in) and Drive config (server-side, not
 *  in AsyncStorage). Caller must ensure no recording is in flight.
 *  Best-effort: per-step failures are logged and execution continues. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

// Mirrors literals defined in:
//   mobile/app/index.tsx       PENDING_RETRY_KEY      'test.pending_retry'
//   mobile/app/index.tsx       LAST_SESSION_ID_KEY    'export.last_session_id'
//   mobile/src/api/history.ts  HISTORY_KEY            'history.sessions'
// Anything else in AsyncStorage (notably the Supabase `sb-*-auth-token`
// entries) is left untouched.
const VOLATILE_KEYS = [
  'test.pending_retry',
  'export.last_session_id',
  'history.sessions',
];

export async function hardResetAppState(): Promise<void> {
  console.log('GC_RESET start');

  for (const key of VOLATILE_KEYS) {
    try {
      await AsyncStorage.removeItem(key);
    } catch (err) {
      console.log('GC_RESET asyncstorage remove failed', { key, err });
    }
  }

  const docDir = FileSystem.documentDirectory;
  if (docDir) {
    try {
      await FileSystem.deleteAsync(docDir, { idempotent: true });
    } catch (err) {
      console.log('GC_RESET docdir delete failed', err);
    }
    try {
      await FileSystem.makeDirectoryAsync(docDir, { intermediates: true });
    } catch (err) {
      console.log('GC_RESET docdir recreate failed', err);
    }
  }

  const cacheDir = FileSystem.cacheDirectory;
  if (cacheDir) {
    try {
      await FileSystem.deleteAsync(cacheDir, { idempotent: true });
    } catch (err) {
      console.log('GC_RESET cachedir delete failed', err);
    }
    try {
      await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
    } catch (err) {
      console.log('GC_RESET cachedir recreate failed', err);
    }
  }

  console.log('GC_RESET done');
}
