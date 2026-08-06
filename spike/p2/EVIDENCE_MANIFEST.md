# P2 Early Gate — Evidence Manifest

Versionable index of the evidence produced by the P2 segmented-recorder spike.

**Only hashes are versioned. No video, log or binary is stored in the
repository.** `.gitignore:6` (`logs/`) already excludes `spike/p2/logs/`
entirely, so evidence cannot enter git by accident.

Two files make up this manifest:

| File | Role |
|---|---|
| `spike/p2/EVIDENCE_MANIFEST.md` | this document — what each artifact proves |
| `spike/p2/evidence.sha256` | the machine-checkable checksum list |

## Evidence store

Artifacts live **outside version control**, under an operator-local root:

```
$GC_EVIDENCE_ROOT/p2/
```

`GC_EVIDENCE_ROOT` is deliberately not recorded here, so this manifest carries
no machine-specific path. Each operator sets it on their own machine.

The layout under that root is fixed, and **is** the logical naming scheme —
every logical name in this document is the artifact's real relative path:

```
$GC_EVIDENCE_ROOT/p2/
├── builds/gradle-minimal-format.log
├── smoke-2/logcat-gate-smoke-2.log
├── smoke-3/logcat-gate-smoke-3.log
├── smoke-3/seg_000-smoke-3-incomplete.mp4
├── smoke-4/logcat-gate-smoke-4.log
├── smoke-4/metro-5.log
├── smoke-4/seg_000-smoke-4.mp4
└── smoke-4/seg_001-smoke-4.mp4
```

## Verification

`spike/p2/evidence.sha256` holds the checksums with exactly these relative
paths, so it verifies directly from the evidence root:

```bash
sha256sum -c "$GUARDIAN_CLOUD_REPO/spike/p2/evidence.sha256"
```

run with `$GC_EVIDENCE_ROOT/p2` as the working directory. On Windows without
`sha256sum`, the equivalent is `Get-FileHash -Algorithm SHA256` per file.

Any mismatch invalidates the corresponding test result. Artifacts are
append-only: a re-run never overwrites, it takes the next free ordinal.

**Current copy status.** The artifacts have been **copied** to the evidence
root and verified there (8/8 OK). The originals are still in `spike/p2/logs/`
inside the working tree, gitignored. They stay until a second independent
verified copy exists; only then is the in-tree copy removed.

## smoke-4 — first successful production of two segments (2026-08-06)

Session `p2gate-1786018126599`. Validates the fix for the
`REBASE_NEGATIVE_PTS` race between the two independent pre-t0 flushes.

| Artifact (relative path = logical name) | Size (B) | Represents |
|---|---|---|
| `smoke-4/logcat-gate-smoke-4.log` | 5 146 599 | Full logcat: the race caught live (`first_segment_waiting has_audio_sample=false`), `origin_us=0`, rotation, clean release. Zero errors in 36 832 lines. |
| `smoke-4/seg_000-smoke-4.mp4` | 196 743 | First segment. Carries the 403,4 ms video empty edit. Structural + FFmpeg validation passed; perceptual playback passed on one Windows player. |
| `smoke-4/seg_001-smoke-4.mp4` | 294 766 | Second segment, from hot rotation at `cut_pts_us=3212783`. Carries the 14,8 ms audio empty edit. Same validation. |
| `smoke-4/metro-5.log` | 4 479 | Metro session. Holds the five `TypeError: Network request failed` proven to precede the capture by 34 s and to be caused by a Wi-Fi AP roam. |

Both segment hashes are **identical to the originals still on the device** in
`cache/gc-p2-gate/`, and identical to the values the native layer reported in
its own `segment_stable` log lines. Three independent sources agree.

## smoke-3 — the failure that motivated the fix (2026-08-06)

| Artifact (relative path = logical name) | Size (B) | Represents |
|---|---|---|
| `smoke-3/logcat-gate-smoke-3.log` | 145 473 | `REBASE_NEGATIVE_PTS: 0 - 449108 = -449108`. Diagnostic baseline for the race. |
| `smoke-3/seg_000-smoke-3-incomplete.mp4` | 40 256 | Truncated MP4 left by the failed run: no `moov`, not playable. Preserved deliberately as the negative case — **never** confuse it with a smoke-4 segment. |

## smoke-2 — `MediaCodec.configure` failure (2026-08-05)

| Artifact (relative path = logical name) | Size (B) | Represents |
|---|---|---|
| `smoke-2/logcat-gate-smoke-2.log` | 197 628 | `video encoder failed at configure: Error 0x80001001` on `OMX.qcom.video.encoder.avc`. Establishes why only the minimal Surface format may be used. |

## Build

| Artifact (relative path = logical name) | Size (B) | Represents |
|---|---|---|
| `builds/gradle-minimal-format.log` | 41 884 | Gradle log of the build that introduced the minimal encoder format and the capability probe. |

## Test device

OnePlus 6 (`ONEPLUS_A6000`), Android 11 / API 30, arm64-v8a. Serial
deliberately omitted. `CAMERA` and `RECORD_AUDIO` granted, `USER_SET`, no
`ONE_TIME`.

## Not covered by this manifest

Other files in `spike/p2/logs/` (earlier logcat, gradle, metro and npm logs)
are working material with no test result attached. They are preserved but not
indexed: adding a checksum to `evidence.sha256` is what promotes an artifact
to evidence.
