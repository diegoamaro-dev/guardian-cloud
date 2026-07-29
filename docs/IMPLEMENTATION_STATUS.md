# IMPLEMENTATION_STATUS.md

⛔ NO APTO — auditoría 2026-07-28; validación anterior retirada; vídeo no protege durante la grabación

Este documento conserva afirmaciones históricas que ya no constituyen evidencia de validación.
Hasta completar la reconciliación documental de la fase H, prevalecen estos informes:

* [Auditoría integral](./audits/GUARDIAN_CLOUD_FULL_AUDIT_2026-07-28.md)
* [Matriz de trazabilidad](./audits/GUARDIAN_CLOUD_TRACEABILITY_2026-07-28.md)
* [Plan de remediación](./audits/GUARDIAN_CLOUD_REMEDIATION_PLAN_2026-07-28.md)

Veredicto vigente: NO APTO. Las afirmaciones de validación contenidas más abajo no deben utilizarse como prueba de funcionamiento real.

## Current MVP status

The MVP currently supports:

- Google Drive OAuth connection
- Backend callback to mobile deep link
- Session creation
- Audio recording
- Chunk generation
- Real chunk upload to Google Drive
- Chunk metadata registration
- Persistent pending recovery state
- Recovery after app kill
- Recovery after device reboot
- Session completion
- Local cleanup after success
- Evidence export from a given session (download chunks via backend proxy, verify sha256, concatenate in order, write .m4a to documentDirectory, produce partial result when some chunks are missing/corrupt)

## Current validated criterion

The system can record, generate chunks, upload them to Drive, recover pending chunks after failure, complete the session, clean local state, and export the session's evidence back as a single .m4a file from the recorded chunks.

## Product status

The system is no longer a prototype.

It has been validated under:

* app kill
* network loss
* background execution
* recovery after restart

This confirms:

> Guardian Cloud fulfills its core promise: evidence survival under real conditions

---

## Current focus

* usability under stress
* fast activation
* user validation

Not:

* new features
* advanced security
* system expansion
---

## Audio pipeline updates (v0.3.3)

### Audio chunk persistence migration

Audio chunks no longer persist inline `base64Slice` payloads inside GC_QUEUE.

Current behavior:
- audio chunks are written to disk under:
  `documentDirectory/chunks/{sessionId}/{chunk_index}.b64`
- GC_QUEUE stores metadata + `local_uri`
- upload worker rehydrates payloads from disk

Reason:
Long audio sessions (~200+ chunks) exceeded the Android SQLite
CursorWindow per-row limit when chunk payloads accumulated directly
inside AsyncStorage.

Result:
- stable queue performance during long recordings
- recovery preserved
- export preserved
- upload worker unchanged
- legacy queue entries remain compatible

Validated:
- long recordings (300+ chunks)
- backend crash + restart
- app restart during drain
- recovery after interruption
- export reconstruction

### Audio chunk size

Audio chunk size increased:

- previous: 16 KB
- current: 32 KB

Reason:
Reduce request overhead and improve sustained upload throughput during
long-running recordings.

Tradeoff accepted:
- first protected chunk slightly slower
  (~3 s → ~4.5 s)
- lower request count
- better sustained draining stability

Compatibility safeguard:
Legacy rehydration fallback now derives stride from `chunk.size`
instead of the global chunk constant to avoid HASH_MISMATCH risks after
the migration.

## Cross-device recovery

Estado: VALIDADO EN CONDICIONES REALES

Capacidades:
- discovery cross-device
- reconstruction from manifest
- partial recovery
- export from recovered evidence

---

## Incremental manifests and partial cross-device recovery (v0.3.4)

Status: ✅ validated on real device

Guardian Cloud now writes incremental Drive manifests during recording/upload, not only after session completion.

### What changed

Partial manifests are generated:
- after the first uploaded chunk
- every 10 uploaded chunks
- once more as final manifest when the session completes

The manifest keeps the same deterministic filename:

`{sessionId}_manifest.json`

and is overwritten as the session progresses.

### Why

Previously, chunks could survive in Google Drive while the session was still undiscoverable from another device.

Failure case fixed:
1. start recording
2. upload some chunks
3. lose connection / enable airplane mode
4. uninstall the app
5. reinstall on another device
6. open recovery

Before this change:
- uploaded chunks existed in Drive
- but no manifest existed yet
- recovery only showed older completed sessions

Now:
- partial manifests make interrupted sessions discoverable
- recovery can show them as partial
- uploaded evidence can be exported even if the original app install is gone

### Architecture

- Backend writes partial manifests fire-and-forget after chunk upload registration.
- Chunk upload response is not blocked by manifest generation.
- `GC_QUEUE` is unchanged.
- Mobile worker is unchanged.
- Export pipeline is unchanged.
- Drive OAuth is unchanged.
- Final complete manifest still overwrites the partial manifest on `/complete`.

### Partial recovery behavior

Audio:
- partial `.aac` recovery is usable because AAC ADTS frames are self-framing.

Video:
- partial `.mp4` recovery may not be directly playable if the MP4 metadata/moov atom was not written yet.
- It is still preserved as forensic partial evidence.

### Validated scenario

Real-device test passed:

- started recording
- waited for chunks + partial manifest
- enabled airplane mode
- uninstalled app
- reinstalled APK
- opened recovery
- partial session appeared
- partial recovery/export worked

This closes the gap where evidence chunks survived remotely but were not discoverable after local state loss.

### Video upload pipeline optimization (validated)

Status: ✅ validated on real device

Changes:
- Increased `VIDEO_FILE_CHUNK_SIZE` from 32 KB → 128 KB.
- Reduced POST/upload request count ~4× for typical MVP-sized videos.
- Preserved:
  - disk-backed queue
  - recovery flow
  - export compatibility
  - completion gate
  - cleanup/reap behaviour
  - background draining

Why:
The previous 32 KB strategy generated excessive request overhead for
video uploads (~150-160 chunks for ~5 MB recordings). Real-device
testing showed the bottleneck was request count, not local disk IO.

Result:
- Faster drain throughput.
- Smaller queue metadata pressure.
- Less post-stop waiting time before protection completes.
- Stable exports and playback after upload.

Real-device validation completed:
- short recording
- near-MVP-cap recording
- upload completion
- export playback
- recovery after restart

Important:
This optimization only affects the post-stop video chunking pipeline.
Audio live-stream chunking remains independent and optimized separately
(32 KB disk-backed audio chunks).