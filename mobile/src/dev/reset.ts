/** DEV-only hard reset. Removes Guardian Cloud volatile testing keys and
 *  recreates documentDirectory and cacheDirectory. Preserves Supabase auth
 *  tokens (so the user stays signed in) and Drive config (server-side, not
 *  in AsyncStorage). Caller must ensure no recording is in flight.
 *  Best-effort: per-step failures are logged and execution continues. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

// Mirrors literals defined in:
//   mobile/app/index.tsx       PENDING_RETRY_KEY      'test.pending_retry'
//   mobile/app/index.tsx       LAST_SESSION_ID_KEY    'export.last_session_id'
//   mobile/src/api/history.ts  HISTORY_KEY            'history.sessions'
// Anything else in AsyncStorage (notably the Supabase `sb-*-auth-token`
// entries) is left untouched.
//
// DELIBERATELY ABSENT: `gc.identity.v1` (see src/auth/identityMarker.ts).
// This reset preserves the Supabase session on purpose, so it is not an
// identity reset — and the marker records a historical fact ("an identity
// has existed on this device") that wiping volatile state does not undo.
// Adding it here would mean a reset followed by a lost session mints a
// fresh anonymous user and silently orphans everything already uploaded,
// which is exactly the GC-AUTH-001 failure. Leave it out.
//
// ALSO DELIBERATELY ABSENT: `gc.legacy_probe.v1` (GC-AUTH-MIGRATION-001).
// Same reasoning, one step removed. The seal records the answer to a
// historical migration question — "did this install carry traces of an
// identity older than the migration boundary?" — and this reset is not a
// migration. Worse, it deletes three of the four signals the probe reads
// (they are the volatile keys below), so clearing the seal here would
// re-ask the question against a store this function just emptied and
// re-seal a negative that was never true.
//
// WHAT THIS MEANS FOR TESTING, AND IT MATTERS:
//
//   This reset does NOT produce a fresh install, and must never be used
//   to claim one. It leaves behind the marker, the seal and the Supabase
//   session. A "fresh install" run on hardware is `pm clear` (or an
//   uninstall) — nothing else. Even that is only fresh on the device:
//   the anonymous user still exists server-side.
//
//   Migration states (traces without a marker, a marker without a seal,
//   a corrupt seal) are constructed in the test fixtures, not by this
//   function. Do not grow a dev tool for them here.
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
