/**
 * TEMPORARY — gating diagnostic for video support (step 0 only).
 *
 * Purpose: validate that while expo-camera's `recordAsync()` is in flight,
 * the local MP4 file is readable on disk and grows over time. The audio
 * pipeline relies on the chunker reading bytes from a growing file every
 * 1.5s; for video to reuse that same pipeline the same property must hold.
 *
 * Pass criteria (ALL must hold):
 *   1. A non-null local file URI is available within 2s of recordAsync()
 *      being invoked, OR the URI we discover from listing cacheDirectory
 *      exactly matches the URI returned by stopRecording's promise.
 *   2. FileSystem.getInfoAsync(uri).exists === true while recording.
 *   3. `size` is monotonically increasing across consecutive 1s reads.
 *   4. No EACCES / locked-file errors from getInfoAsync while recording.
 *
 * Delete this file (and the temporary entry button on app/index.tsx)
 * once results are reported.
 */

import { useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { Stack } from 'expo-router';

type LogLine = { t: number; line: string };

interface CacheFile {
  path: string;
  size: number;
  modificationTime: number;
}

/**
 * List candidate video files (.mp4, .mov) under FileSystem.cacheDirectory,
 * including the conventional `Camera/` subdirectory expo-camera writes to.
 * We use this to diff before/after recordAsync() and identify the file
 * that the in-flight recording is writing to.
 */
async function listCandidateFiles(): Promise<CacheFile[]> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return [];
  const out: CacheFile[] = [];

  async function scan(prefix: string) {
    let names: string[];
    try {
      names = await FileSystem.readDirectoryAsync(prefix);
    } catch {
      return;
    }
    for (const n of names) {
      const full = prefix + n;
      let info;
      try {
        info = await FileSystem.getInfoAsync(full);
      } catch {
        continue;
      }
      if (!info.exists) continue;
      if (info.isDirectory) {
        // Only recurse one level into well-known camera dir to keep
        // this cheap; expo-camera's known cache locations are flat.
        if (n === 'Camera' || n.startsWith('ExpoCamera') || n === 'CameraView') {
          await scan(full + '/');
        }
        continue;
      }
      const lower = n.toLowerCase();
      if (!lower.endsWith('.mp4') && !lower.endsWith('.mov')) continue;
      out.push({
        path: full,
        size: info.size ?? 0,
        modificationTime: info.modificationTime ?? 0,
      });
    }
  }

  await scan(dir);
  return out;
}

export default function DebugCameraProbe() {
  const [, requestCamPerm] = useCameraPermissions();
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const cameraRef = useRef<CameraView | null>(null);
  const recordPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(
    null
  );

  function log(line: string) {
    const entry: LogLine = { t: Date.now(), line };
    console.log('[CAM_PROBE]', line);
    setLogs((prev) => [...prev, entry]);
  }

  async function runProbe() {
    setLogs([]);
    setDone(false);
    log('=== probe start ===');

    // --- Permissions FIRST, before mounting CameraView ---
    log('requesting camera permission...');
    const cam = await requestCamPerm();
    log(
      `camera permission: granted=${cam.granted} status=${cam.status} canAskAgain=${cam.canAskAgain}`
    );
    if (!cam.granted) {
      log('ABORT: camera permission not granted');
      setDone(true);
      return;
    }

    log('requesting microphone permission...');
    const mic = await Audio.requestPermissionsAsync();
    log(`microphone permission: granted=${mic.granted} status=${mic.status}`);
    if (!mic.granted) {
      log('ABORT: microphone permission not granted');
      setDone(true);
      return;
    }

    // Match the audio mode used by the existing audio recording path so
    // the MP4 audio track captures correctly.
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      log('audio mode set');
    } catch (e: any) {
      log(`audio mode WARN: ${e?.message ?? String(e)}`);
    }

    // --- Mount the CameraView (this triggers running -> true) ---
    setRunning(true);

    // Wait for the camera ref to be populated by React after mount.
    const tMountStart = Date.now();
    while (!cameraRef.current && Date.now() - tMountStart < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!cameraRef.current) {
      log('ABORT: cameraRef did not populate within 5s of mount');
      setRunning(false);
      setDone(true);
      return;
    }
    log(`cameraRef ready ${Date.now() - tMountStart}ms after mount`);

    // Camera hardware needs a beat to initialize before recordAsync will
    // succeed. expo-camera silently fails (returns undefined immediately)
    // if recordAsync is called before the camera is ready.
    await new Promise((r) => setTimeout(r, 800));

    let discoveredPath: string | null = null;
    let discoveryAt = -1;
    let discoveryMethod = 'none';
    const sizeSamples: number[] = [];
    const errorsWhileGrowing: string[] = [];
    let finalUri: string | null = null;
    const cam2: CameraView = cameraRef.current;

    try {
      // --- Snapshot baseline candidate files ---
      const baseline = await listCandidateFiles();
      log(`baseline candidate files: ${baseline.length}`);
      for (const b of baseline) {
        log(`  baseline ${b.path} size=${b.size} mtime=${b.modificationTime}`);
      }

      // --- Start recordAsync (DO NOT await) ---
      log('calling recordAsync (NOT awaiting)...');
      const tCallStart = Date.now();
      try {
        recordPromiseRef.current = cam2.recordAsync({
          maxDuration: 60,
        }) as Promise<{ uri: string } | undefined>;
        log(`recordAsync invoked at t=0 (promise captured)`);
      } catch (e: any) {
        log(`recordAsync THREW synchronously: ${e?.message ?? String(e)}`);
        return;
      }

      // --- Try to discover the in-flight URI within 2s ---
      const discoveryDeadline = tCallStart + 2000;
      while (Date.now() < discoveryDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        const after = await listCandidateFiles();
        const novel = after.filter(
          (a) => !baseline.some((b) => b.path === a.path)
        );
        if (novel.length > 0) {
          novel.sort((a, b) => b.modificationTime - a.modificationTime);
          discoveredPath = novel[0]!.path;
          discoveryMethod = 'cacheDirectory listing';
          discoveryAt = Date.now() - tCallStart;
          log(
            `URI discovered (cacheDirectory listing) at t+${discoveryAt}ms: ${discoveredPath} size=${novel[0]!.size}`
          );
          break;
        }
      }
      if (!discoveredPath) {
        log('URI NOT discovered within first 2s of recordAsync');
      }

      // --- Poll size every 1s for 10 samples ---
      log('--- polling loop (10 samples, 1s apart) ---');
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const t = Date.now() - tCallStart;
        if (!discoveredPath) {
          // Late-discovery attempt
          const after = await listCandidateFiles();
          const novel = after.filter(
            (a) => !baseline.some((b) => b.path === a.path)
          );
          if (novel.length > 0) {
            novel.sort((a, b) => b.modificationTime - a.modificationTime);
            discoveredPath = novel[0]!.path;
            discoveryMethod = 'cacheDirectory listing (late)';
            discoveryAt = Date.now() - tCallStart;
            log(`URI late-discovered at t+${discoveryAt}ms: ${discoveredPath}`);
          } else {
            log(`t+${t}ms still no candidate file in cache`);
            continue;
          }
        }
        try {
          const info = await FileSystem.getInfoAsync(discoveredPath);
          if (info.exists && !info.isDirectory) {
            const sz = info.size ?? 0;
            sizeSamples.push(sz);
            log(
              `t+${t}ms exists=true size=${sz} mtime=${info.modificationTime}`
            );
          } else {
            log(`t+${t}ms exists=false (file vanished?)`);
          }
        } catch (e: any) {
          const msg = `${e?.code ?? ''} ${e?.message ?? String(e)}`;
          errorsWhileGrowing.push(msg);
          log(`t+${t}ms ERROR ${msg}`);
        }
      }

      // --- Stop recording and resolve the authoritative URI ---
      log('calling stopRecording()...');
      try {
        cam2.stopRecording();
      } catch (e: any) {
        log(`stopRecording threw: ${e?.message ?? String(e)}`);
      }
      log('awaiting recordAsync resolution...');
      try {
        const result = await recordPromiseRef.current;
        finalUri = result?.uri ?? null;
        log(`recordAsync resolved. final uri: ${finalUri ?? '(undefined)'}`);
      } catch (e: any) {
        log(`recordAsync rejected: ${e?.message ?? String(e)}`);
      }
    } finally {
      // Unmount the CameraView; release hardware.
      setRunning(false);
    }

    // --- Summary ---
    log('--- summary ---');
    log(`discovery method: ${discoveryMethod}`);
    log(
      `discovery time: ${discoveryAt < 0 ? 'NEVER (before stop)' : `t+${discoveryAt}ms`}`
    );
    log(`discovered path: ${discoveredPath ?? '(none)'}`);
    log(`final uri (from recordAsync): ${finalUri ?? '(none)'}`);

    const uriMatch = !!discoveredPath && !!finalUri && discoveredPath === finalUri;
    const uriPathContained =
      !!discoveredPath && !!finalUri && (finalUri.endsWith(discoveredPath) || discoveredPath.endsWith(finalUri));
    log(`URI exact match: ${uriMatch}`);
    if (!uriMatch) log(`URI path-suffix match: ${uriPathContained}`);

    log(`size samples: [${sizeSamples.join(', ')}]`);
    const monotonic =
      sizeSamples.length >= 2 &&
      sizeSamples.every((v, i) => i === 0 || v >= sizeSamples[i - 1]!);
    const strictlyIncreasing =
      sizeSamples.length >= 2 &&
      sizeSamples.every((v, i) => i === 0 || v > sizeSamples[i - 1]!);
    log(`size monotonic non-decreasing: ${monotonic}`);
    log(`size strictly increasing: ${strictlyIncreasing}`);
    log(`errors during growth: ${errorsWhileGrowing.length}`);

    // Pass criteria
    const c1 =
      (discoveryAt >= 0 && discoveryAt <= 2000) || uriMatch || uriPathContained;
    const c2 = sizeSamples.length > 0;
    const c3 = strictlyIncreasing;
    const c4 = errorsWhileGrowing.length === 0;
    log('--- pass criteria ---');
    log(`(1) URI in 2s OR matches final URI: ${c1 ? 'PASS' : 'FAIL'}`);
    log(`(2) exists=true while recording: ${c2 ? 'PASS' : 'FAIL'}`);
    log(`(3) size strictly increasing: ${c3 ? 'PASS' : 'FAIL'}`);
    log(`(4) no read errors while growing: ${c4 ? 'PASS' : 'FAIL'}`);
    log(`OVERALL: ${c1 && c2 && c3 && c4 ? 'PASS' : 'FAIL'}`);
    log('=== probe end ===');
    setDone(true);
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0d1117', padding: 12 }}>
      <Stack.Screen options={{ title: 'Camera probe (debug)' }} />

      {running ? (
        <CameraView
          ref={(r) => {
            cameraRef.current = r;
          }}
          mode="video"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            opacity: 0,
            top: 0,
            left: 0,
          }}
        />
      ) : null}

      <Text style={{ color: '#fff', fontSize: 14, marginBottom: 4 }}>
        Pre-flight: in-flight video file readability
      </Text>
      <Text style={{ color: '#8b949e', fontSize: 11, marginBottom: 12 }}>
        Records ~10s blind via expo-camera, polls file size each 1s, then stops. Reports pass/fail per criterion.
      </Text>

      <Pressable
        disabled={running}
        onPress={runProbe}
        style={{
          backgroundColor: running ? '#21262d' : '#1f6feb',
          padding: 12,
          borderRadius: 8,
          marginBottom: 12,
          opacity: running ? 0.6 : 1,
        }}
      >
        <Text
          style={{ color: '#fff', textAlign: 'center', fontWeight: '600' }}
        >
          {running ? 'Running…' : done ? 'Run again' : 'Run probe'}
        </Text>
      </Pressable>

      <ScrollView
        style={{
          flex: 1,
          backgroundColor: '#010409',
          borderRadius: 6,
          padding: 8,
          borderWidth: 1,
          borderColor: '#30363d',
        }}
      >
        {logs.map((l, i) => (
          <Text
            key={i}
            style={{
              color: '#9ad',
              fontFamily: 'monospace',
              fontSize: 10,
              marginBottom: 1,
            }}
            selectable
          >
            {l.line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}
