/**
 * SPIKE — P2 early gate. Technical trigger only.
 *
 * Follows the precedent of `app/debug-camera-probe/`: a temporary diagnostic
 * route, reachable directly, that does NOT touch production UI. `app/index.tsx`
 * is not modified.
 *
 * This screen mounts the preview, calls start/stop, and lists the segment
 * paths it is handed. It does NOT hash, enqueue, upload, or decide when to
 * rotate — all of that lives in the native module, and none of it touches
 * GC_QUEUE, the worker, recovery or export.
 *
 * Delete this route once the gate has been executed and reported.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Redirect } from 'expo-router';

import GCSegmentedRecorder, {
  GCSegmentedCameraView,
  type CaptureErrorEvent,
  type SegmentClosedEvent,
} from '../../modules/gc-segmented-recorder';

/**
 * The gate screen itself. NOT the route export — see the wrapper at the bottom
 * of this file. It is deliberately not exported: mounting it is what creates
 * the native preview surface, so only the access wrapper may do so.
 */
function DebugP2GateScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [segments, setSegments] = useState<SegmentClosedEvent[]>([]);
  const sessionRef = useRef<string>('');

  // Monotonic per-press counter. Every line `start()` emits carries this id,
  // so one tap maps to exactly one run in the log — a re-entrant or duplicated
  // invocation would show two different ids interleaved.
  const runCounterRef = useRef<number>(0);

  const log = (s: string) =>
    setLines((prev) => [...prev, `${new Date().toISOString().slice(11, 23)}  ${s}`]);

  useEffect(() => {
    const closed = GCSegmentedRecorder.addListener(
      'onSegmentClosed',
      (e: SegmentClosedEvent) => {
        setSegments((prev) => [...prev, e]);
        log(
          `SEGMENT ${e.segmentIndex} closed · ${e.sizeBytes}B · ` +
            `cut=${e.cutPtsUs}us tail=${e.audioTailUs}us lead=${e.audioLeadUs}us ` +
            `kfWait=${e.keyframeWaitMs}ms stop=${e.muxerStopMs}ms`,
        );
      },
    );
    const errored = GCSegmentedRecorder.addListener(
      'onCaptureError',
      (e: CaptureErrorEvent) => {
        log(`ERROR ${e.code}: ${e.message}`);
        setRunning(false);
      },
    );
    const released = GCSegmentedRecorder.addListener('onCaptureReleased', () => {
      log('capture released');
      setRunning(false);
    });
    return () => {
      closed.remove();
      errored.remove();
      released.remove();
    };
  }, []);

  async function start() {
    const run = ++runCounterRef.current;
    log(`[run ${run}] start() entered`);

    // Both permissions are requested HERE and nowhere else: only after the
    // INICIAR PUERTA press. Camera first, then microphone. Each decision uses
    // the value the request returned, not the hook's state, which may still be
    // stale on this render.
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        log(`[run ${run}] camera permission denied`);
        return;
      }
    }
    // The native AudioEncoder opens AudioRecord(MediaRecorder.AudioSource.MIC),
    // so RECORD_AUDIO is mandatory. Without this the session would fail deep
    // inside the encoder instead of here.
    if (!micPermission?.granted) {
      const micRes = await requestMicPermission();
      if (!micRes.granted) {
        log(`[run ${run}] microphone permission denied`);
        return;
      }
    }

    const id = `p2gate-${Date.now()}`;
    sessionRef.current = id;
    setSegments([]);
    setLines([]);
    setRunning(true);
    // `setLines([])` above wipes the "[run N] start() entered" line, so the id
    // is restated here: on a run that reaches this point it is the first line
    // on screen, and on a denied run the "entered" line survives instead.
    log(`[run ${run}] start ${id}`);
    try {
      await GCSegmentedRecorder.startSegmentedCapture(id);
    } catch (err) {
      log(`[run ${run}] start threw: ${String(err)}`);
      setRunning(false);
    }
  }

  async function stop() {
    log('stop requested');
    try {
      await GCSegmentedRecorder.stopSegmentedCapture();
    } catch (err) {
      log(`stop threw: ${String(err)}`);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0d1117', padding: 12 }}>
      <Text style={{ color: '#c9d1d9', fontSize: 16, fontWeight: '700', marginBottom: 8 }}>
        P2 early gate — segmented capture
      </Text>

      <View style={{ height: 220, backgroundColor: '#000', marginBottom: 8 }}>
        <GCSegmentedCameraView style={{ flex: 1 }} />
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <Pressable
          onPress={() => void start()}
          disabled={running}
          style={{
            flex: 1,
            paddingVertical: 12,
            borderRadius: 6,
            alignItems: 'center',
            backgroundColor: running ? '#30363d' : '#238636',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>INICIAR PUERTA</Text>
        </Pressable>
        <Pressable
          onPress={() => void stop()}
          style={{
            flex: 1,
            paddingVertical: 12,
            borderRadius: 6,
            alignItems: 'center',
            backgroundColor: '#d73a49',
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>PARAR</Text>
        </Pressable>
      </View>

      <Text style={{ color: '#8b949e', fontSize: 12, marginBottom: 4 }}>
        segmentos cerrados: {segments.length} (se esperan 2)
      </Text>

      <ScrollView style={{ flex: 1 }}>
        {lines.map((l, i) => (
          <Text key={i} style={{ color: '#8b949e', fontSize: 11, fontFamily: 'monospace' }}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * Access wrapper — the actual route export.
 *
 * Everything under `app/` ships in the production bundle and stays reachable
 * by deep link (`guardiancloud://debug-p2-gate`). Without this gate a release
 * build would mount `GCSegmentedCameraView` — creating a real preview surface
 * — and expose a control that starts a native audio+video capture.
 *
 * The wrapper holds NO hooks, so its early return cannot produce a conditional
 * hook order. The gate component keeps its hooks unconditional and is simply
 * never mounted in release: `__DEV__` is a compile-time constant that Metro
 * replaces with `false`, so the branch is dead code there.
 */
export default function DebugP2GateRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <DebugP2GateScreen />;
}
