# IMPLEMENTATION_STATUS.md

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