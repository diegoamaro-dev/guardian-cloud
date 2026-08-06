/**
 * SPIKE ARTIFACT — P2 early gate structural verifier.
 *
 * Verifies, per track and per file:
 *   G2  video AND audio tracks present
 *   G3  codec configuration present (avcC for AVC, esds for AAC)
 *   G4  the FIRST video sample is a sync sample (stss[0] == 1)
 *   G6  per-track decode timestamps monotonic and duration plausible
 *   +   absence of `ctts`, whose presence would indicate composition
 *       reordering and contradict the no-B-frames configuration
 *
 * NOT verified here — they need a player and visual reading, and this tool
 * must never report them as passed:
 *   G1  opens in VLC and the Android native player
 *   G5  A/V sync offset at segment start and end
 *   G7  gap_ms / overlap_ms at the boundary
 *
 * Usage: node gate-verify.js seg_000.mp4 seg_001.mp4
 */
'use strict';

const fs = require('node:fs');

// ---- box walking -----------------------------------------------------

function boxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    const size32 = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let size = size32;
    let header = 8;
    if (size32 === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size32 === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) {
      out.push({ type, off, size, header, truncated: true });
      break;
    }
    out.push({ type, off, size, header });
    off += size;
  }
  return out;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

/** Collect boxes grouped by the `trak` they belong to. */
function parseTracks(buf) {
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return { top, tracks: [], mvhd: null };

  const moovChildren = boxes(buf, moov.off + moov.header, moov.off + moov.size);
  const mvhd = moovChildren.find((b) => b.type === 'mvhd') || null;
  const tracks = [];

  for (const trak of moovChildren.filter((b) => b.type === 'trak')) {
    const found = {};
    (function walk(start, end) {
      for (const b of boxes(buf, start, end)) {
        if (!found[b.type]) found[b.type] = b;
        if (!b.truncated && CONTAINERS.has(b.type)) walk(b.off + b.header, b.off + b.size);
      }
    })(trak.off + trak.header, trak.off + trak.size);
    tracks.push(found);
  }
  return { top, tracks, mvhd };
}

// ---- per-box readers -------------------------------------------------

/**
 * stsd → the first sample entry: its 4cc and its child boxes.
 *
 * The configuration boxes (`avcC`, `esds`) live INSIDE the sample entry, which
 * carries a fixed-size header before its children: 78 bytes for a
 * VisualSampleEntry, 28 for an AudioSampleEntry. Failing to descend here made
 * the first version report G3 FAIL on a perfectly valid file.
 */
function sampleEntry(buf, stsd) {
  const p = stsd.off + stsd.header + 8; // version/flags + entryCount
  if (p + 8 > buf.length) return null;
  const size = buf.readUInt32BE(p);
  const type = buf.toString('latin1', p + 4, p + 8);

  // Offsets are measured from the START of the sample entry box, so they
  // include its own 8-byte box header:
  //   VisualSampleEntry  8 (header) + 8 (SampleEntry) + 70 = 86
  //   AudioSampleEntry   8 (header) + 8 (SampleEntry) + 20 = 36
  // Using 78/28 — the sizes measured from AFTER the header — landed four
  // bytes short and read `depth`/`pre_defined` as a box type.
  const VISUAL = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v']);
  const AUDIO = new Set(['mp4a', 'ac-3', 'ec-3', 'opus']);
  let childOffset = null;
  if (VISUAL.has(type)) childOffset = 86;
  else if (AUDIO.has(type)) childOffset = 36;

  const children = {};
  if (childOffset !== null) {
    const start = p + childOffset;
    const end = Math.min(p + size, buf.length);
    if (start < end) {
      for (const b of boxes(buf, start, end)) {
        if (!children[b.type]) children[b.type] = b;
        // `esds` sits under `wave` on some encoders.
        if (b.type === 'wave' && !b.truncated) {
          for (const w of boxes(buf, b.off + b.header, b.off + b.size)) {
            if (!children[w.type]) children[w.type] = w;
          }
        }
      }
    }
  }
  return { type, children };
}

/** stss → list of sync sample numbers (1-based). */
function syncSamples(buf, stss) {
  const p = stss.off + stss.header;
  const count = buf.readUInt32BE(p + 4);
  const out = [];
  for (let i = 0; i < count && p + 8 + i * 4 + 4 <= buf.length; i++) {
    out.push(buf.readUInt32BE(p + 8 + i * 4));
  }
  return out;
}

/** stts → decode timestamps, in track timescale units. */
function decodeTimes(buf, stts) {
  const p = stts.off + stts.header;
  const entries = buf.readUInt32BE(p + 4);
  const times = [];
  let t = 0;
  for (let i = 0; i < entries; i++) {
    const q = p + 8 + i * 8;
    if (q + 8 > buf.length) break;
    const sampleCount = buf.readUInt32BE(q);
    const sampleDelta = buf.readUInt32BE(q + 4);
    for (let k = 0; k < sampleCount; k++) {
      times.push(t);
      t += sampleDelta;
    }
  }
  return times;
}

/** mdhd → { timescale, duration }. */
function mdhd(buf, box) {
  const p = box.off + box.header;
  const version = buf[p];
  if (version === 0) {
    return { timescale: buf.readUInt32BE(p + 12), duration: buf.readUInt32BE(p + 16) };
  }
  return {
    timescale: buf.readUInt32BE(p + 20),
    duration: Number(buf.readBigUInt64BE(p + 24)),
  };
}

// ---- verification ----------------------------------------------------

function verify(file) {
  const buf = fs.readFileSync(file);
  const { top, tracks, mvhd: mvhdBox } = parseTracks(buf);

  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass, detail });

  const entries = tracks.map((t) => (t.stsd ? sampleEntry(buf, t.stsd) : null));
  const kinds = entries.map((e) => (e ? e.type : null));
  const videoIdx = kinds.findIndex((k) => k === 'avc1');
  const audioIdx = kinds.findIndex((k) => k === 'mp4a');

  // G2 — both tracks present
  add('G2_tracks', videoIdx >= 0 && audioIdx >= 0, `entries=${JSON.stringify(kinds)}`);

  // G3 — codec configuration inside the SAMPLE ENTRY of each track
  const hasAvcC = videoIdx >= 0 && Boolean(entries[videoIdx].children.avcC);
  const hasEsds = audioIdx >= 0 && Boolean(entries[audioIdx].children.esds);
  add('G3_codecConfig', hasAvcC && hasEsds, `avcC=${hasAvcC} esds=${hasEsds}`);

  // G4 — the FIRST video sample must be a sync sample
  let g4pass = false;
  let g4detail = 'no video track';
  if (videoIdx >= 0) {
    const t = tracks[videoIdx];
    if (!t.stss) {
      // No stss means EVERY sample is a sync sample — also acceptable.
      g4pass = true;
      g4detail = 'no stss → all samples are sync samples';
    } else {
      const ss = syncSamples(buf, t.stss);
      g4pass = ss.length > 0 && ss[0] === 1;
      g4detail = `stss_count=${ss.length} first_entry=${ss[0]} (must be 1)`;
    }
  }
  add('G4_firstSampleIsKeyframe', g4pass, g4detail);

  // G6 — per-track DECODE timestamps + plausible duration.
  //
  // Honesty note: `stts` encodes DECODE times (DTS), not presentation times.
  // PTS = DTS + composition offset from `ctts`, and `elst` can further shift or
  // trim the presented timeline. So a monotonic `stts` proves the decode order
  // is sane — it is NOT a direct reading of the PTS values the encoder handed
  // to the muxer. When `ctts` or a non-trivial `elst` is present, this check
  // is reported as PARTIAL and the timeline must be read with them.
  //
  // Only media tracks are graded; a metadata track ('mett') carries no playable
  // duration and must not fail the gate.
  const graded = [videoIdx, audioIdx].filter((i) => i >= 0);
  const perTrack = [];
  let g6pass = graded.length > 0;
  for (const i of graded) {
    const t = tracks[i];
    if (!t.stts || !t.mdhd) { g6pass = false; perTrack.push(`${kinds[i]}: missing stts/mdhd`); continue; }
    const times = decodeTimes(buf, t.stts);
    let monotonic = true;
    for (let k = 1; k < times.length; k++) if (times[k] < times[k - 1]) { monotonic = false; break; }
    const { timescale, duration } = mdhd(buf, t.mdhd);
    const durS = timescale > 0 ? duration / timescale : null;
    if (!monotonic || !(durS > 0)) g6pass = false;
    const hasCtts = Boolean(t.ctts);
    const hasElst = Boolean(t.elst);
    perTrack.push(
      `${kinds[i]}: dts_samples=${times.length} dts_monotonic=${monotonic} ` +
      `timescale=${timescale} duration_s=${durS === null ? 'n/a' : durS.toFixed(3)}` +
      `${hasCtts ? ' [ctts present → PTS≠DTS]' : ''}` +
      `${hasElst ? ' [elst present → edited timeline]' : ''}`,
    );
  }
  const anyCtts = graded.some((i) => tracks[i].ctts);
  const anyElst = graded.some((i) => tracks[i].elst);
  add(
    'G6_decodeTimestamps',
    g6pass,
    perTrack.join(' | ') +
      (anyCtts || anyElst
        ? '  ** PARTIAL: stts is DTS only; ctts/elst must be applied to read PTS **'
        : '  (no ctts/elst → DTS equals PTS for these tracks)'),
  );

  // `ctts` means composition reordering, which contradicts the no-B-frames
  // configuration the encoder was asked for.
  const cttsTracks = graded.map((i) => (tracks[i].ctts ? kinds[i] : null)).filter(Boolean);
  add('X_noCompositionReordering', cttsTracks.length === 0, `ctts_in=${JSON.stringify(cttsTracks)}`);

  // A non-empty `elst` shifts or trims what a player actually presents, so any
  // A/V offset measured downstream must account for it.
  const elstTracks = graded.map((i) => (tracks[i].elst ? kinds[i] : null)).filter(Boolean);
  add('X_noEditList', elstTracks.length === 0, `elst_in=${JSON.stringify(elstTracks)}`);

  return {
    file,
    bytes: buf.length,
    topLevel: top.map((b) => b.type).join(' → '),
    hasMoov: top.some((b) => b.type === 'moov'),
    checks,
  };
}

// ---- report ----------------------------------------------------------

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('usage: node gate-verify.js <seg_000.mp4> [<seg_001.mp4> ...]');
  process.exit(1);
}

let allPass = true;
for (const f of files) {
  const r = verify(f);
  console.log('=== ' + r.file + ' ===');
  console.log('  bytes           : ' + r.bytes);
  console.log('  top-level boxes : ' + r.topLevel);
  console.log('  moov present    : ' + r.hasMoov);
  for (const c of r.checks) {
    if (!c.pass) allPass = false;
    console.log('  ' + c.id.padEnd(28) + (c.pass ? 'PASS' : 'FAIL') + '  ' + c.detail);
  }
  console.log('');
}

console.log('--- structural checks: ' + (allPass ? 'ALL PASS' : 'FAILURES PRESENT') + ' ---');
console.log('NOT verified by this tool (need a player / visual reading):');
console.log('  G1  opens in VLC and the Android native player');
console.log('  G5  A/V sync offset at segment start and end');
console.log('  G7  gap_ms / overlap_ms at the boundary');
process.exit(allPass ? 0 : 1);
