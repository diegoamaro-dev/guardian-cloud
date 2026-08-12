/**
 * S2 SPIKE — adoption gate. Technical trigger only.
 *
 * Follows the precedent of `app/debug-p2-gate/`: a temporary diagnostic route
 * that does NOT touch production UI. `app/index.tsx` is not modified.
 *
 * What this screen proves: a segment closed by the native P2 recorder is
 * copied, verified, handed to GC_QUEUE and uploaded by the EXISTING worker
 * while the next segment is still being recorded. Nothing here uploads,
 * retries or deletes — the worker owns all of that, unchanged.
 *
 * One operational constraint, discovered on this base and NOT worked around in
 * code: `uploadDrainLoop` is module-private in `app/index.tsx` at 23d03a8, so
 * this screen cannot kick it. It does not need to: the loop stays alive at a
 * 150 ms poll for as long as any queue entry has `recording_closed === false`.
 * It only has to be ENTERED once, which the home screen does on its foreground
 * kick. Hence the operator sequence: ARMAR → background/foreground bounce →
 * INICIAR. The bounce uses a real productive code path instead of exporting a
 * new one.
 *
 * Delete this route once the gate has been executed and reported.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { Redirect } from 'expo-router';

import GCSegmentedRecorder, {
  GCSegmentedCameraView,
  type CaptureErrorEvent,
  type SegmentClosedEvent,
} from '../../modules/gc-segmented-recorder';
import {
  queueAppendNewSession,
  queueMarkRecordingClosed,
  queueRead,
} from '../index';
import { apiFetch } from '@/api/client';
import { uploadChunkBytes } from '@/api/destinations';
import { downloadChunk, listSessionChunks } from '@/api/export';
import { getFreshAccessToken } from '@/auth/store';
import {
  adoptSegment,
  sha256OfBytes,
  sha256OfFile,
  stableSegmentUri,
  type AdoptionRecord,
} from '@/video/segmentAdopter';

/**
 * Rotation cadence for the run. Every value is inside `HarnessBounds`
 * (rotationInterval 1_000…600_000, session 2_000…3_600_000), so these are
 * parameters of the existing recorder, not a change to it.
 */
const PRESETS = {
  A_90S_3S: { rotateAtMs: 3_000, rotationIntervalMs: 3_000, sessionMs: 90_000 },
  B_300S_3S: { rotateAtMs: 3_000, rotationIntervalMs: 3_000, sessionMs: 300_000 },
  C_300S_6S: { rotateAtMs: 3_000, rotationIntervalMs: 6_000, sessionMs: 300_000 },
  D_15S_2S: { rotateAtMs: 2_000, rotationIntervalMs: 2_000, sessionMs: 15_000 },
  CONTROL_60S: { rotateAtMs: 3_000, rotationIntervalMs: 3_000, sessionMs: 60_000 },
} as const;
type PresetName = keyof typeof PRESETS;

/** Experiment D. Same endpoint, auth, proxy and Drive destination as a real upload. */
const PROBE_SIZES = [220 * 1024, 440 * 1024, 880 * 1024];
const PROBE_REPS = 5;

/** Monotonic per-chunk view of GC_QUEUE. Poll gaps must never erase history. */
interface ChunkLedgerRow {
  chunk_index: number;
  firstSeenAtMs: number;
  status: string;
  uploadedAtMs: number | null;
  remote_reference: string | null;
  attempts: number;
  /** Every distinct status this chunk was ever observed in, in order. */
  statusTrail: string[];
}

interface VerificationRow {
  chunk_index: number;
  localSha256: string | null;
  /** Re-hash of the surviving cache original — proves what the recorder made. */
  sourceSha256: string | null;
  downloadedSha256: string | null;
  downloadedBytes: number;
  remote_reference: string | null;
  match: boolean;
  error?: string;
}

/** Chunked so a ~900 KiB payload cannot blow the argument stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Unique high-entropy payload. `Crypto.getRandomBytes` refuses anything over
 * 1024 bytes per call, so a 64 KiB seed is drawn in 1 KiB pieces and then tiled
 * with a per-tile XOR. The point is only that no two probes share a hash — the
 * backend dedups by hash and would otherwise skip the real Drive upload.
 */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const SEED = 64 * 1024;
  const seed = new Uint8Array(Math.min(SEED, n));
  for (let off = 0; off < seed.length; off += 1024) {
    seed.set(Crypto.getRandomBytes(Math.min(1024, seed.length - off)), off);
  }
  const out = new Uint8Array(n);
  for (let off = 0, tile = 0; off < n; off += seed.length, tile++) {
    const take = Math.min(seed.length, n - off);
    for (let i = 0; i < take; i++) out[off + i] = seed[i]! ^ (tile & 0xff);
  }
  return out;
}

function DebugP2AdoptScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [preset, setPreset] = useState<PresetName>('A_90S_3S');
  const [adopting, setAdopting] = useState(true);
  const [sessionId, setSessionId] = useState<string>('');
  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [records, setRecords] = useState<AdoptionRecord[]>([]);
  const [ledger, setLedger] = useState<ChunkLedgerRow[]>([]);
  const [verification, setVerification] = useState<VerificationRow[]>([]);
  const [lines, setLines] = useState<string[]>([]);

  const sessionRef = useRef<string>('');
  const runningRef = useRef<boolean>(false);
  const adoptingRef = useRef<boolean>(true);
  const recordsRef = useRef<AdoptionRecord[]>([]);
  const ledgerRef = useRef<Map<number, ChunkLedgerRow>>(new Map());
  const pendingAdoptions = useRef<Set<Promise<unknown>>>(new Set());
  const startedAtRef = useRef<number>(0);

  const log = useCallback((s: string) => {
    const stamped = `${new Date().toISOString().slice(11, 23)}  ${s}`;
    console.log(`GC_S2 ${s}`);
    setLines((prev) => [...prev.slice(-400), stamped]);
  }, []);

  // ---------------------------------------------------------------- adoption

  useEffect(() => {
    const closed = GCSegmentedRecorder.addListener(
      'onSegmentClosed',
      (e: SegmentClosedEvent) => {
        const closedAt = Date.now();
        log(
          `segment_closed idx=${e.segmentIndex} bytes=${e.sizeBytes} ` +
            `t=+${closedAt - startedAtRef.current}ms drops=${e.videoFramesDropped}`,
        );
        if (!adoptingRef.current) return;
        if (e.sessionId !== sessionRef.current) {
          log(`IGNORED segment for foreign session ${e.sessionId}`);
          return;
        }
        const p = adoptSegment(
          {
            sessionId: e.sessionId,
            segmentIndex: e.segmentIndex,
            path: e.path,
            sizeBytes: e.sizeBytes,
          },
          closedAt,
        )
          .then((rec) => {
            recordsRef.current = [...recordsRef.current, rec];
            setRecords(recordsRef.current);
            // Absolute epochs are what lets the host analyser line this row up
            // against the worker's own GC_PERF_* timestamps. Without them the
            // queue-wait boundary cannot be computed from the log alone.
            log(
              `ADOPT ${rec.outcome} idx=${rec.segmentIndex} size=${rec.sizeBytes} ` +
                `sha=${rec.sha256?.slice(0, 12) ?? '-'} ` +
                `closedAt=${rec.closedAtMs} enqAt=${rec.enqueuedAtMs ?? -1} ` +
                `hashSrc=${rec.timings.hashSourceMs}ms copy=${rec.timings.copyMs}ms ` +
                `hashCopy=${rec.timings.hashCopyMs}ms enqueue=${rec.timings.enqueueMs}ms ` +
                `closed->queue=${rec.timings.closedToEnqueueMs}ms` +
                (rec.error ? ` ERR=${rec.error}` : ''),
            );
            return rec;
          })
          .catch((err: unknown) => {
            log(`ADOPT threw idx=${e.segmentIndex}: ${String(err)}`);
          });
        pendingAdoptions.current.add(p);
        void p.finally(() => pendingAdoptions.current.delete(p));
      },
    );

    const errored = GCSegmentedRecorder.addListener(
      'onCaptureError',
      (e: CaptureErrorEvent) => {
        log(`CAPTURE_ERROR ${e.code}: ${e.message}`);
        setRunning(false);
        runningRef.current = false;
      },
    );

    const released = GCSegmentedRecorder.addListener('onCaptureReleased', () => {
      log('capture_released');
      setRunning(false);
      runningRef.current = false;
      // Close the queue entry only once every adoption has settled. Marking it
      // closed earlier would let the worker finalise a session whose last
      // segment is still being copied.
      void (async () => {
        const inFlight = Array.from(pendingAdoptions.current);
        if (inFlight.length > 0) {
          log(`waiting for ${inFlight.length} adoption(s) before closing`);
          await Promise.allSettled(inFlight);
        }
        const next =
          recordsRef.current.reduce((m, r) => Math.max(m, r.segmentIndex + 1), 0);
        if (sessionRef.current) {
          await queueMarkRecordingClosed(sessionRef.current, '', 0, next);
          log(`recording_closed=true next_chunk_index=${next}`);
        }
      })();
    });

    return () => {
      closed.remove();
      errored.remove();
      released.remove();
    };
  }, [log]);

  // ------------------------------------------------------------ queue ledger

  useEffect(() => {
    if (!armed) return;
    const id = setInterval(() => {
      void (async () => {
        const q = await queueRead();
        const entry = q.find((e) => e.session_id === sessionRef.current);
        const now = Date.now();
        if (!entry) return; // reaped after completion; the ledger keeps history
        let changed = false;
        for (const c of entry.chunks) {
          const prev = ledgerRef.current.get(c.chunk_index);
          if (!prev) {
            ledgerRef.current.set(c.chunk_index, {
              chunk_index: c.chunk_index,
              firstSeenAtMs: now,
              status: c.status,
              uploadedAtMs: c.status === 'uploaded' ? now : null,
              remote_reference: c.remote_reference ?? null,
              attempts: c.attempts,
              statusTrail: [c.status],
            });
            changed = true;
            continue;
          }
          if (c.status !== prev.status) {
            prev.statusTrail.push(c.status);
            prev.status = c.status;
            if (c.status === 'uploaded' && prev.uploadedAtMs === null) {
              prev.uploadedAtMs = now;
              log(
                `UPLOADED idx=${c.chunk_index} while capture_running=${runningRef.current} ` +
                  `ref=${(c.remote_reference ?? '').slice(0, 24)}`,
              );
            }
            changed = true;
          }
          if (c.remote_reference && !prev.remote_reference) {
            prev.remote_reference = c.remote_reference;
            changed = true;
          }
          if (c.attempts !== prev.attempts) {
            prev.attempts = c.attempts;
            changed = true;
          }
        }
        if (changed) {
          setLedger(
            Array.from(ledgerRef.current.values()).sort(
              (a, b) => a.chunk_index - b.chunk_index,
            ),
          );
        }
      })();
    }, 500);
    return () => clearInterval(id);
  }, [armed, log]);

  // ------------------------------------------------------------- operations

  async function arm() {
    const sid = Crypto.randomUUID();
    sessionRef.current = sid;
    setSessionId(sid);
    recordsRef.current = [];
    setRecords([]);
    ledgerRef.current = new Map();
    setLedger([]);
    setVerification([]);
    setLines([]);
    log(`ARM session=${sid} preset=${preset} adopting=${adoptingRef.current}`);
    try {
      await apiFetch('/sessions', {
        method: 'POST',
        body: {
          user_id: 'test_user',
          mode: 'video',
          destination_type: 'drive',
          id: sid,
        },
      });
      log('backend session created');
    } catch (err) {
      log(`backend session create FAILED: ${String(err)} (worker will retry)`);
    }
    await queueAppendNewSession({
      session_id: sid,
      uri: '',
      recording_closed: false,
      session_completed: false,
      complete_attempts: 0,
      emitted_base64_length: 0,
      next_chunk_index: 0,
      chunks: [],
      destination_type: 'drive',
    });
    setArmed(true);
    log('GC_QUEUE entry created (recording_closed=false) — now bounce the app');
  }

  async function start() {
    if (!sessionRef.current) {
      log('not armed');
      return;
    }
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) return log('camera permission denied');
    }
    if (!micPermission?.granted) {
      const res = await requestMicPermission();
      if (!res.granted) return log('microphone permission denied');
    }
    const opts = PRESETS[preset];
    startedAtRef.current = Date.now();
    setRunning(true);
    runningRef.current = true;
    log(
      `START ${sessionRef.current} preset=${preset} rotateAt=${opts.rotateAtMs} ` +
        `interval=${opts.rotationIntervalMs} session=${opts.sessionMs}`,
    );
    try {
      await GCSegmentedRecorder.startSegmentedCapture(sessionRef.current, opts);
    } catch (err) {
      log(`start threw: ${String(err)}`);
      setRunning(false);
      runningRef.current = false;
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

  /**
   * End-to-end integrity. Not "the backend acknowledged a hash" — the bytes are
   * pulled back through the existing Drive/backend download path and hashed
   * again. The surviving cache original is re-hashed too, so the comparison
   * runs against what the recorder actually produced, not only against what
   * this screen recorded earlier.
   */
  async function verify() {
    const sid = sessionRef.current;
    if (!sid) return log('not armed');
    log('VERIFY start');
    try {
      const remote = await listSessionChunks(sid);
      log(`backend lists ${remote.length} chunk(s)`);
    } catch (err) {
      log(`listSessionChunks failed: ${String(err)}`);
    }
    const rows: VerificationRow[] = [];
    for (const rec of recordsRef.current) {
      if (rec.outcome !== 'adopted' && rec.outcome !== 'already_adopted') continue;
      const row: VerificationRow = {
        chunk_index: rec.segmentIndex,
        localSha256: rec.sha256,
        sourceSha256: null,
        downloadedSha256: null,
        downloadedBytes: -1,
        remote_reference:
          ledgerRef.current.get(rec.segmentIndex)?.remote_reference ?? null,
        match: false,
      };
      try {
        const src = await sha256OfFile(rec.sourceUri);
        row.sourceSha256 = src.hash;
      } catch (err) {
        row.error = `source re-hash failed: ${String(err)}`;
      }
      try {
        const { bytes } = await downloadChunk(sid, rec.segmentIndex);
        row.downloadedBytes = bytes.length;
        row.downloadedSha256 = await sha256OfBytes(bytes);
        row.match =
          row.downloadedSha256 === rec.sha256 &&
          row.downloadedSha256 === row.sourceSha256;
      } catch (err) {
        row.error = `${row.error ? row.error + ' · ' : ''}download failed: ${String(err)}`;
      }
      rows.push(row);
      log(
        `VERIFY idx=${row.chunk_index} local=${row.localSha256?.slice(0, 12)} ` +
          `source=${row.sourceSha256?.slice(0, 12)} remote=${row.downloadedSha256?.slice(0, 12)} ` +
          `match=${row.match}${row.error ? ' ERR=' + row.error : ''}`,
      );
      setVerification([...rows]);
    }
    log(`VERIFY done: ${rows.filter((r) => r.match).length}/${rows.length} match`);
  }

  // ------------------------------------------- criterio 10 · idempotencia

  /**
   * The recorder never re-emitted a segment during S2, so the guard was never
   * exercised on device. This drives the three cases directly and checks the
   * OUTCOME, GC_QUEUE and the files on disk — the return value alone proves
   * nothing about what was persisted.
   */
  async function idempotenceTest() {
    const sid = sessionRef.current;
    const dir = FileSystem.cacheDirectory;
    if (!sid) return log('IDEM aborted: not armed');
    if (!dir) return log('IDEM aborted: no cacheDirectory');
    const IDX_SEQ = 900;
    const IDX_CONC = 901;
    const A = new Uint8Array(1024).fill(0x41);
    const B = new Uint8Array(1024).fill(0x42);
    const pathA = `${dir}s2b-idem-A.mp4`;
    const pathB = `${dir}s2b-idem-B.mp4`;
    await FileSystem.writeAsStringAsync(pathA, bytesToBase64(A), {
      encoding: FileSystem.EncodingType.Base64,
    });
    await FileSystem.writeAsStringAsync(pathB, bytesToBase64(B), {
      encoding: FileSystem.EncodingType.Base64,
    });
    const shaA = await sha256OfBytes(A);
    const shaB = await sha256OfBytes(B);

    const queueFor = async (idx: number) => {
      const q = await queueRead();
      const e = q.find((x) => x.session_id === sid);
      return (e?.chunks ?? []).filter((c) => c.chunk_index === idx);
    };
    const stableSha = async (idx: number) => {
      const uri = stableSegmentUri(sid, idx);
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) return null;
      return (await sha256OfFile(uri)).hash;
    };
    const ev = (idx: number, p: string, n: number) => ({
      sessionId: sid, segmentIndex: idx, path: p, sizeBytes: n,
    });

    // 1 — dos adopciones secuenciales idénticas
    const r1a = await adoptSegment(ev(IDX_SEQ, pathA, A.length), Date.now());
    const r1b = await adoptSegment(ev(IDX_SEQ, pathA, A.length), Date.now());
    const q1 = await queueFor(IDX_SEQ);
    const f1 = await stableSha(IDX_SEQ);
    log(
      `IDEM secuenciales outcomes=${r1a.outcome},${r1b.outcome} entradas=${q1.length} ` +
        `hash_cola=${q1[0]?.hash?.slice(0, 12) ?? '-'} fichero=${f1?.slice(0, 12) ?? '-'} ` +
        `esperado=${shaA.slice(0, 12)} ok=${q1.length === 1 && f1 === shaA && q1[0]?.hash === shaA}`,
    );

    // 2 — dos adopciones concurrentes idénticas
    const [r2a, r2b] = await Promise.all([
      adoptSegment(ev(IDX_CONC, pathA, A.length), Date.now()),
      adoptSegment(ev(IDX_CONC, pathA, A.length), Date.now()),
    ]);
    const q2 = await queueFor(IDX_CONC);
    const f2 = await stableSha(IDX_CONC);
    log(
      `IDEM concurrentes outcomes=${r2a.outcome},${r2b.outcome} entradas=${q2.length} ` +
        `converge=${r2a.sha256 === r2b.sha256} fichero=${f2?.slice(0, 12) ?? '-'} ` +
        `ok=${q2.length === 1 && f2 === shaA}`,
    );

    // 3 — mismo índice, bytes distintos
    const r3 = await adoptSegment(ev(IDX_SEQ, pathB, B.length), Date.now());
    const q3 = await queueFor(IDX_SEQ);
    const f3 = await stableSha(IDX_SEQ);
    const bNotQueued = !q3.some((c) => c.hash === shaB);
    log(
      `IDEM conflicto outcome=${r3.outcome} entradas=${q3.length} fichero=${f3?.slice(0, 12) ?? '-'} ` +
        `bytes_A_intactos=${f3 === shaA} B_no_encolado=${bNotQueued} ` +
        `reporta_conflicto=${r3.outcome === 'conflict'} ` +
        `ok=${r3.outcome === 'conflict' && f3 === shaA && bNotQueued && q3.length === 1}`,
    );
  }

  // --------------------------------------------- experimento D · tamaños

  /**
   * Uploads known sizes through the SAME endpoint, auth, proxy and Drive
   * destination a productive chunk uses (`uploadChunkBytes`), so the timings
   * are directly comparable with `GC_PERF_DRAIN_UPLOAD_BYTES`. The bodies are
   * random so the backend's hash dedup cannot short-circuit a real upload.
   */
  async function sizeProbes() {
    const probeSid = Crypto.randomUUID();
    try {
      await apiFetch('/sessions', {
        method: 'POST',
        body: { user_id: 'test_user', mode: 'video', destination_type: 'drive', id: probeSid },
      });
    } catch (err) {
      return log(`SIZEPROBE aborted: session create failed ${String(err)}`);
    }
    const token = await getFreshAccessToken();
    if (!token) return log('SIZEPROBE aborted: no access token');
    log(`SIZEPROBE start session=${probeSid}`);

    // Authenticated round trip with no body. ORIENTATIVE only: it is a
    // different route and cannot be taken as the upload path's intercept.
    for (let r = 0; r < PROBE_REPS; r++) {
      const t = Date.now();
      let ok = true;
      try { await apiFetch('/destinations'); } catch { ok = false; }
      log(`SIZEPROBE kind=rtt bytes=0 rep=${r} ms=${Date.now() - t} ok=${ok}`);
    }

    let idx = 1000;
    for (const size of PROBE_SIZES) {
      for (let r = 0; r < PROBE_REPS; r++) {
        const bytes = randomBytes(size);
        const b64 = bytesToBase64(bytes);
        const hash = await sha256OfBytes(bytes);
        const t = Date.now();
        let ok = true;
        try {
          await uploadChunkBytes(probeSid, idx, hash, b64, 60_000, 'drive', token);
        } catch (err) {
          ok = false;
          log(`SIZEPROBE error bytes=${size} rep=${r}: ${String(err)}`);
        }
        log(`SIZEPROBE kind=upload bytes=${size} rep=${r} ms=${Date.now() - t} ok=${ok}`);
        idx++;
      }
    }
    log(`SIZEPROBE done session=${probeSid}`);
  }

  /** Freezes everything this run observed into a file for `adb pull`. */
  async function writeReport() {
    const sid = sessionRef.current;
    if (!sid) return log('not armed');
    const ledgerRows = Array.from(ledgerRef.current.values()).sort(
      (a, b) => a.chunk_index - b.chunk_index,
    );
    // Overlap proof: segment N uploaded before segment N+1 closed.
    const overlaps = recordsRef.current
      .map((rec) => {
        const next = recordsRef.current.find(
          (r) => r.segmentIndex === rec.segmentIndex + 1,
        );
        const up = ledgerRef.current.get(rec.segmentIndex)?.uploadedAtMs ?? null;
        return {
          chunk_index: rec.segmentIndex,
          uploadedAtMs: up,
          nextSegmentClosedAtMs: next?.closedAtMs ?? null,
          uploadedBeforeNextSegmentClosed:
            up !== null && next !== undefined ? up < next.closedAtMs : null,
        };
      })
      .filter((o) => o.uploadedAtMs !== null);
    const report = {
      gate: 'S2_SEGMENT_ADOPTION',
      session_id: sid,
      preset,
      adopting: adoptingRef.current,
      started_at_ms: startedAtRef.current,
      written_at: new Date().toISOString(),
      segments_closed: recordsRef.current.length,
      adoption: recordsRef.current,
      queue_ledger: ledgerRows,
      overlap: overlaps,
      verification,
      metrics: {
        max_segment_bytes: recordsRef.current.reduce(
          (m, r) => Math.max(m, r.sizeBytes), 0),
        max_copy_ms: recordsRef.current.reduce(
          (m, r) => Math.max(m, r.timings.copyMs), 0),
        max_hash_source_ms: recordsRef.current.reduce(
          (m, r) => Math.max(m, r.timings.hashSourceMs), 0),
        max_hash_copy_ms: recordsRef.current.reduce(
          (m, r) => Math.max(m, r.timings.hashCopyMs), 0),
        max_closed_to_enqueue_ms: recordsRef.current.reduce(
          (m, r) => Math.max(m, r.timings.closedToEnqueueMs), 0),
        max_closed_to_remote_ref_ms: recordsRef.current.reduce((m, r) => {
          const up = ledgerRef.current.get(r.segmentIndex)?.uploadedAtMs;
          return up ? Math.max(m, up - r.closedAtMs) : m;
        }, 0),
      },
      stable_paths: recordsRef.current.map((r) => ({
        chunk_index: r.segmentIndex,
        stable: stableSegmentUri(sid, r.segmentIndex),
        source: r.sourcePath,
      })),
    };
    const dir = `${FileSystem.documentDirectory}gc-s2/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const path = `${dir}report-${sid}.json`;
    await FileSystem.writeAsStringAsync(path, JSON.stringify(report, null, 2));
    console.log('GC_S2_REPORT', JSON.stringify(report));
    log(`report written: ${path}`);
  }

  const btn = (label: string, onPress: () => void, color: string, disabled = false) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        flex: 1, paddingVertical: 10, borderRadius: 6, alignItems: 'center',
        backgroundColor: disabled ? '#30363d' : color,
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>{label}</Text>
    </Pressable>
  );

  const uploaded = ledger.filter((l) => l.status === 'uploaded').length;

  return (
    <View style={{ flex: 1, backgroundColor: '#0d1117', padding: 10 }}>
      <Text style={{ color: '#c9d1d9', fontSize: 15, fontWeight: '700' }}>
        S2 — adopción de segmentos
      </Text>
      <Text style={{ color: '#8b949e', fontSize: 10, marginBottom: 6 }}>
        {sessionId || 'sin sesión'}
      </Text>

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
        {(Object.keys(PRESETS) as PresetName[]).map((p) => (
          <Pressable
            key={p}
            onPress={() => setPreset(p)}
            disabled={running}
            style={{
              flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: 'center',
              borderWidth: 1,
              borderColor: preset === p ? '#58a6ff' : '#30363d',
              backgroundColor: preset === p ? '#12263f' : 'transparent',
            }}
          >
            <Text style={{ color: preset === p ? '#58a6ff' : '#8b949e', fontSize: 10 }}>
              {p}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        onPress={() => {
          const v = !adopting;
          setAdopting(v);
          adoptingRef.current = v;
          log(`adopting=${v}`);
        }}
        disabled={running}
        style={{
          paddingVertical: 6, borderRadius: 6, alignItems: 'center', marginBottom: 6,
          borderWidth: 1, borderColor: adopting ? '#3fb950' : '#d29922',
        }}
      >
        <Text style={{ color: adopting ? '#3fb950' : '#d29922', fontSize: 11 }}>
          {adopting ? 'ADOPTADOR ENCENDIDO' : 'ADOPTADOR APAGADO (control)'}
        </Text>
      </Pressable>

      <View style={{ height: 170, backgroundColor: '#000', marginBottom: 6 }}>
        <GCSegmentedCameraView style={{ flex: 1 }} />
      </View>

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
        {btn('ARMAR', () => void arm(), '#1f6feb', running)}
        {btn('INICIAR', () => void start(), '#238636', running || !armed)}
        {btn('PARAR', () => void stop(), '#d73a49')}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
        {btn('VERIFICAR', () => void verify(), '#8957e5', running)}
        {btn('INFORME', () => void writeReport(), '#6e7681')}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 6 }}>
        {btn('IDEM 10', () => void idempotenceTest(), '#bf8700', running || !armed)}
        {btn('SONDAS D', () => void sizeProbes(), '#1f6feb', running)}
      </View>

      <Text style={{ color: '#8b949e', fontSize: 11, marginBottom: 4 }}>
        cerrados {records.length} · en cola {ledger.length} · subidos {uploaded} ·
        {' '}verificados {verification.filter((v) => v.match).length}/{verification.length}
        {running ? ' · GRABANDO' : ''}
      </Text>

      <ScrollView style={{ flex: 1 }}>
        {lines.map((l, i) => (
          <Text
            key={i}
            style={{ color: '#8b949e', fontSize: 10, fontFamily: 'monospace' }}
          >
            {l}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * Access wrapper — the actual route export. Same rule as `debug-p2-gate`:
 * everything under `app/` ships in the production bundle and is reachable by
 * deep link, so the screen (which mounts a real camera surface and starts a
 * capture) must never mount outside a development build. `__DEV__` is a
 * compile-time constant Metro replaces with `false`, making this dead code in
 * release. The wrapper holds no hooks, so its early return cannot produce a
 * conditional hook order.
 */
export default function DebugP2AdoptRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <DebugP2AdoptScreen />;
}
