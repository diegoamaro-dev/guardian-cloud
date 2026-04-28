/** DEV-only hard reset. Clears AsyncStorage and recreates documentDirectory
 *  and cacheDirectory. Caller is responsible for ensuring no recording is in
 *  flight. Best-effort: per-step failures are logged and execution continues. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

export async function hardResetAppState(): Promise<void> {
  console.log('GC_RESET start');

  try {
    await AsyncStorage.clear();
  } catch (err) {
    console.log('GC_RESET asyncstorage clear failed', err);
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
