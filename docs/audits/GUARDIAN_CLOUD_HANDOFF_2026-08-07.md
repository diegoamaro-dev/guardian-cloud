# Guardian Cloud — P2 handoff, 2026-08-07

Closes the P2 long-rotation phase. Scope is the experimental P2 video recorder only.

---

## 1. Status

`P2_LONG_ROTATION_STRESS` — **INCONCLUSIVE**, formally closed 2026-08-07.
`P2_RESOURCE_OBSERVABILITY` — **INCONCLUSIVE**, formally closed 2026-08-07.

Neither is FAIL. The phase remains **open** in the sense that the blockers are unresolved;
the *capture* is closed and must not be repeated.

### Scope — P2 is not the MVP

**The P2 segmented recorder is an experimental spike**, living only on
`spike/video-p2-early-gate`. It is **NOT APTO for integration** and is not approved to
reach `main`. Nothing in this phase authorises `GC_QUEUE`, the upload worker, retry,
recovery or export.

**This result does not revoke any MVP capability.** The verdicts above are about the
experimental P2 video recorder and nothing else. The audio pipeline, chunking, background
upload, recovery and export of the existing MVP are a different code path, were not
exercised by this session, and keep whatever status the current documentation declares
for them. An INCONCLUSIVE verdict here is a statement about P2's observability, not a
regression of anything already shipped.

## 2. What the session produced

Session `p2gate-1786112857352`, preset `LONG_ROTATION` (3000 / 3000 / 600000).
Device OnePlus 6 `d8a378fb`, Android 11 / API 30, APK
`AE662523083E67FDF64ADBF1B743022EC17218EAD3FF77800459A3DA254EED45`, app PID 14925
unchanged from start to finish.

| | |
|---|---|
| Segments | 75, 42,820,786 B, **75/75 SHA-256 matching their native `segment_stable` hashes** |
| Counters | `R=74 X=0 C=74 S=75 T=75 A=0 B=0` |
| Fatal codes | 0 across all 25 `ErrorCode` values |
| Final state | `state=COMPLETED`, `release_complete segments=75`, `resources_freed=true` |
| Decode | 75/75 at exit 0 with empty stderr, `ffmpeg -xerror -v error -i <f> -f null -` |
| Structure | `gate-verify.js` G2/G3/G4/G6 pass 75/75; `X_noEditList` fails 75/75 (pre-existing) |
| Duration | **606.977 s on the device clock** |
| Cadence | median 8.10 s effective period for a nominal 3 s interval |
| `muxerStopMs` p95 | **508 ms exact** (nearest-rank, n=74, rank 71) |
| File descriptors | 181 → 129, −0.70 per rotation: **no net growth of descriptors was observed between start and end**. This is not a proof of absence of leaks. |
| Memory | PSS +23.5 %. **Not valid for a PASS**: the sampling window was wrong — see §5 — so the series does not cover the whole session and the figure is an observation only. |

## 3. Why INCONCLUSIVE

Both reasons are missing instrumentation. Neither is a recorder fault.

**A. Two boundaries logged `audio_tail_us == 0`** — n=62 (`cut_pts_us=499112841`,
`lead=82`) and n=65 (`cut_pts_us=523373961`, `lead=3814`). The `maxOf(0L, raw)` clamp at
`SegmentCoordinator.kt:462` makes CASE 2 (raw == 0, a perfect boundary) indistinguishable
from CASE 3 (raw < 0, or no AAC frame before the cut — a real gap). Section 10bis: one
such boundary prevents a full PASS. The other 72 boundaries are +1 or 0 µs, with zero
overlaps and zero `lead == -1`.

**B. 56 of 74 `fd_a` recovery samples returned too late.** `Start-Job` spawns a whole
PowerShell process (~2.4 s), so a sample scheduled at t+1 s ran at median t+3.245 s while
the next rotation fires at t+3.0 s. This is a harness defect, not a product defect.

## 4. Counter coverage — per stream, per counter

Verified by counting **write sites**, not declarations.

| Counter | Field | Increment sites | Verdict |
|---|---|---|---|
| **coordinator audio frames dropped** | `audioFramesDropped` | 1, `SegmentCoordinator.kt:242` | **exists and is incremented** |
| **coordinator video frames dropped** | `videoFramesDropped` | 1, `SegmentCoordinator.kt:241` | **exists and is incremented** |
| **audio frames duplicated** | `audioFramesDuplicated` | **0** | field exists, never incremented — **NOT MEASURABLE** |
| **video frames duplicated** | — | — | **field does not exist** — **NOT MEASURABLE** |

**What "dropped" means here.** Both counters are fed by `countDrop()`, called from the
`else ->` branch of the state dispatch in `consume()` (`SegmentCoordinator.kt:221`). They
count **samples rejected by the coordinator's state machine** — samples arriving in a gate
state that neither writes nor retains them. They are **not** encoder drops and **not**
muxer drops. Neither the encoder nor the muxer reports a drop count at all.

Both dropped counters are currently invisible in logcat: they reach JS in the
`onSegmentClosed` payload (`GCSegmentedRecorderModule.kt:425-427`) and the gate screen
renders them on screen only. Making them observable is a log-only change.

**Duplication is not covered by this phase, in either stream.** Logging
`audioFramesDuplicated` would print a structural zero; `videoFramesDuplicated` does not
exist. Measuring duplication requires writing a detector over the sample path, which is
new logic, not instrumentation. Recorded as debt.

**Also NOT MEASURABLE:** the §9.2 prediction interval — `muxerStopMs` is logged only above
`MUXER_STOP_WARN_MS`, so only a censored tail of 6 values out of 74 exists.

## 5. Instrument defects recorded, none fixed

- `actual_*_offset_s` biased a constant −7200 s: `[datetime]::Parse` returns `Kind=Local`
  for a `Z` stamp. Raw ISO timestamps are correct; `true = recorded + 7200`.
- The PSS 700 s window opened 148 s before the press and closed 86 s early.
- `dumpsys meminfo <package>` returns the system-wide dump on this OxygenOS build. It must
  be called with the **pid** — recorded as `rev6-PSS-hotfix1`.
- The device wall clock runs ~6 h ahead of the host; device timezone is
  `America/New_York`; `logcat -v threadtime` prints device LOCAL time. Media timing is
  unaffected: PTS come from `TIMEBASE_BOOTTIME`.

## 6. Evidence package — frozen, do not modify

`C:\Users\diego\guardian-cloud-evidence\p2\long-rotation\`, 274 files, outside every
repository.

Authoritative manifest `EVIDENCE_MANIFEST_LONG_ROTATION_v6_FINAL.txt`, SHA-256
`0d5bfb8f522ec005e3cca4cbfd91f193417c12fa249a05d410305ffe180d8fac`, 273 entries,
coverage proven (`E = F − 1`, zero missing / extra / duplicate paths). v1–v5 kept for
lineage. Current report `POSTMORTEM_v3.txt`; instrument `tools/postmortem3.js` with six
live assertions, two of which pin the figures 2 and 56 and were verified by negative test.
Code dependencies frozen under `frozen/`.

`SHORT_CONTINUITY` is preserved separately at `…\p2\short-continuity\`; the two supporting
runs at `…\p2\supporting-runs\`.

## 7. Git state at handoff

```
CURRENT_BRANCH=spike/video-p2-early-gate
HEAD=b67e5924f9469287706a0080356d66445cde9126
ORIGIN_MAIN=1f581e42fe2c2e3d774cb481b39bb21dc533fc5d
AHEAD_BEHIND=behind=0,ahead=10
WORKTREE_STATUS= M mobile/app/debug-p2-gate/index.tsx
```

The branch has no upstream and has never been pushed. `merge-base` equals `origin/main`,
so it is a strict descendant with no divergence. The single uncommitted change is the
`LONG_ROTATION` preset line that produced this session.

## 8. Next phase — observability only

Proposed, not implemented. Six items: direct drop counters, overflow headroom,
`pendingStability` exposure, monotonic event timestamps, harness sampling that completes
before the next rotation, and a diagnosis for the two `audio_tail_us == 0` boundaries.

This phase improves observability and confidence. It does not integrate the P2 recorder
with `GC_QUEUE`, and it does not validate upload during recording, recovery, or survival
off the device. It also does **not** make duplicated frames measurable, in either stream.
