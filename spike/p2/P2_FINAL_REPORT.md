# P2 Early Gate — Final Report

Closes the P2 segmented-recorder spike. Two device sessions were run; both are
classified **INCONCLUSIVE**. Neither is FAIL.

**Only hashes, metrics and custody paths are versioned here.** No video, log or
binary enters the repository, exactly as `EVIDENCE_MANIFEST.md` already
requires. The two evidence sets live outside version control and are separated
by directory and by `sessionId`.

## Scope, stated once

P2 measures **fine continuity between rotations** of an experimental video
recorder: whether a segment can be closed and the next opened without losing,
duplicating or overlapping audio and video at the boundary.

It does **not** measure survival off the device. It is not a regression of the
MVP, it says nothing about the current MVP audio recorder, `GC_QUEUE` or upload
pipeline, and nothing here changes the capabilities the current documentation
declares. The P2 recorder lives only on
`spike/video-p2-early-gate` and its descendant `spike/video-p2-observability`;
it is not integrated with `GC_QUEUE`, the upload worker, retry, recovery or
export, and it is not approved to reach `main`.

## The two sessions

| | Session 1 | Session 2 |
|---|---|---|
| `sessionId` | `p2gate-1786112857352` | `p2gate-1786154509260` |
| Date (UTC) | 2026-08-07 08:26 | 2026-08-07 20:00 |
| Preset | `LONG_ROTATION` 3000/3000/600000 | same |
| Duration | 606.977 s (device wall clock) | 606.349 s (device monotonic) |
| Segments | 75 | 75 |
| Rotations R / X / C | 74 / 0 / 74 | 74 / 0 / 74 |
| S / T | 75 / 75 | 75 / 75 |
| Invariants I1–I9 | PASS | PASS |
| Native hash match | 75/75 | 75/75 |
| Full decode `ffmpeg -xerror` | 75/75 exit 0 | 75/75 exit 0 |
| Fatal errors | 0 | 0 |
| `release_complete` / `resources_freed` | yes / true | yes / true |
| Boundaries | 74 = 72 PASS + 2 INCONCLUSIVE | 74 = 73 PASS + 1 INCONCLUSIVE |
| Classification | **INCONCLUSIVE** | **INCONCLUSIVE** |

### Boundary totals, reconciled

Mutually exclusive categories summing to exactly 74 per session, taken from the
preserved evidence — `BOUNDARIES.csv` for session 1, recomputed from the
preserved `logcat.log` for session 2.

```
Session 1:
74 total =
72 PASS (71 with gap +1 us + 1 with gap 0)
+ 2 INCONCLUSIVE (tail not evaluable)

Session 2:
74 total =
73 PASS (72 with gap +1 us + 1 with gap 0)
+ 1 INCONCLUSIVE (no_aac_before=true)
```

No boundary in either session fell into any other class: zero overlaps
(`gap < 0`), zero `lead == -1`, zero in the 2..23219 band of CASE 1, zero at or
above 23220.

### Session 1 — why INCONCLUSIVE

1. **Two boundaries logged `audio_tail_us == 0`** — n=62 (`cut_pts_us=499112841`,
   `lead=82`) and n=65 (`cut_pts_us=523373961`, `lead=3814`). At the time the
   instrumentation could not distinguish CASE 2 (raw == 0) from CASE 3 (no usable
   AAC frame before the cut): `maxOf(0L, raw)` collapses both to zero, so the
   boundary was **not evaluable** by this criterion.
2. **`P2_RESOURCE_OBSERVABILITY` also INCONCLUSIVE** — 56 of 74 `fd_a` recovery
   samples returned after the next rotation had been requested. A harness
   defect: `Start-Job` spawned a PowerShell process per take (~2.4 s), so a take
   scheduled at t+1 s ran at a median of t+3.245 s against a 3.0 s budget.

Other measurements: p95 of `muxerStopMs` = 508 ms exact (nearest-rank, n=74,
rank 71); file descriptors 181 → 129, no net growth observed; effective rotation
period median 8.10 s for a nominal 3 s.

### Session 2 — why INCONCLUSIVE

Run after the three observability commits and with corrected external samplers.

1. **Unbounded background interruption.** The operator minimised the app during
   the session. No lifecycle marker for that window exists in the captured log —
   the only `onWindowFocusChange` is at device time 22:17:35, almost six minutes
   *after* `session_released`. The window cannot be dated or bounded, so the run
   cannot be declared clean regardless of how good the functional data is.
2. **One boundary is CASE 3.** The new diagnostic resolved the ambiguity that
   blocked session 1:

   ```
   tail=0  lead=3741  gap=3741  raw_audio_tail_us=0  no_aac_before=true
   ```

   `no_aac_before=true` means `lastAacBefore == null`. Read precisely:

   > **No usable preceding AAC frame existed from which to compute the boundary.
   > The tail recorded as zero is a representation artefact. The boundary is not
   > evaluable by this criterion and is therefore INCONCLUSIVE. On its own it
   > does not demonstrate real audio loss.**

   Section 10 classifies `tail == 0` as INCONCLUSIVE, and section 10bis states
   one such boundary prevents a full PASS.

The other 73 boundaries: 72 with gap +1 µs and one with gap 0
(`tail=lead=20643`, CASE 1, exact contiguity). Zero overlaps, zero `lead == -1`.

**Supporting observation only** — cadence min 3.60 s, median 8.10 s, max 8.70 s,
with **no interval above 12 s** and no camera loss. If the app was in background
during recording it left no trace in the cadence or the counters. That is not
proof the backgrounding was harmless; it is the absence of a visible effect.

Corrected samplers performed as designed: `fd_b − fd_a` median 3986 ms against a
nominal 4000 ms, so the schedule is honoured to ~14 ms; the real budget measured
on the device monotonic clock is `segment_stable → next rotation` = min 3001 ms.
`fd_a` has 74 of 75 rows and `fd_b` 73 of 75 because the sampler exits on
`session_released` before the last takes fall due — by design, not a fault.

**PSS is an observation of memory during the window, never evidence of a leak.**
Session 2: 358,577 → 395,747 KiB, +10.4 %, 21 valid samples, 0 errors.

## Not measurable in either session

- **Frames duplicated**, in either stream. `audioFramesDuplicated` exists but has
  zero write sites, and there is no `videoFramesDuplicated` field at all.
  Measuring duplication needs a detector, which is logic, not instrumentation.
- **The §9.2 prediction interval.** `muxerStopMs` is logged only above
  `MUXER_STOP_WARN_MS`, so only a censored tail exists.

## Instrument defects found and recorded

| | |
|---|---|
| `actual_*_offset_s` biased −7200 s | `[datetime]::Parse` returns `Kind=Local` for a `Z` stamp |
| PSS window opened 148 s early, closed 86 s short | fixed 700 s timer, not bound to events |
| `dumpsys meminfo <package>` | returns the system-wide dump on this OxygenOS build; must be called with the pid (`rev6-PSS-hotfix1`) |
| `packager-status:running` | proves nothing; Metro answered it with a dead file watcher and served no bundle |
| Device wall clock ~6 h ahead of host, timezone `America/New_York` | `logcat -v threadtime` prints device local time; media timing unaffected, PTS come from `TIMEBASE_BOOTTIME` |
| Sampler exit codes | not captured by the launcher; derived from the `summary` row each sampler writes before exiting |

## Custody

Evidence lives outside version control, under the operator-local evidence root
(`$GC_EVIDENCE_ROOT`, see `EVIDENCE_MANIFEST.md`), in `p2/`:

| Set | Directory | Files | Manifest SHA-256 |
|---|---|---:|---|
| Session 1 | `p2/long-rotation/` | 274 | `0d5bfb8f522ec005e3cca4cbfd91f193417c12fa249a05d410305ffe180d8fac` |
| Session 2 | `p2/long-rotation-2/` | 165 | `e19a76d636e351c80c1996960eb3124197ca346324ea4ec33da27581d724288d` |
| `SHORT_CONTINUITY` | `p2/short-continuity/` | 7 | in-folder manifest |
| Supporting runs | `p2/supporting-runs/` | 9 | in-folder inventory |
| `DEFAULT` regression | `p2/default-observability/` | 5 | — |

Each manifest enumerates every file recursively with relative path, size and
SHA-256, excluding only itself. Coverage is verifiable: count the entries, add
one, compare against a recursive file count.

**The two sessions never mix.** Different directories, different `sessionId`,
and each set verified against its own native `segment_stable` hashes.

## Observability commits

Three atomic commits on `spike/video-p2-observability`, validated on device with
the `DEFAULT` preset (session `p2gate-1786148453633`) before session 2:

| Commit | Change |
|---|---|
| `9d43176` | monotonic device clock stamped on the five protocol events |
| `6364dcc` | coordinator discards, `pendingStability`, retention headroom |
| `05d34cf` | unclamped audio tail — `raw_audio_tail_us`, `no_aac_before` |

Commit `05d34cf` is what turned session 1's unanswerable boundary into session
2's answered one.

## Harness

The four external scripts used for session 2 are versioned alongside
`gate-verify.js` in this directory. They touch no product code and run entirely
on the host.

| Script | Role |
|---|---|
| `gc-preflight.ps1` | real bundle probe, absolute writable paths, pid, storage |
| `gc-logcat.ps1` | exactly one identifiable capture process |
| `gc-fd-sampler.ps1` | persistent fd sampler bound to real events |
| `gc-pss-sampler.ps1` | PSS window bound to `session_start` / `session_released` |

## Verdict

**P2 is closed as INCONCLUSIVE.**

No loss, overlap, corruption or decode failure was detected with the metrics
available. **Frame duplication could not be measured** — see "Not measurable"
above — so nothing is claimed about it in either direction. On that evidence it
is not FAIL, and neither session can be declared PASS.

The recorder is **not approved for integration**. Nothing in P2 authorises
`GC_QUEUE`, the upload worker, retry, recovery or export.
