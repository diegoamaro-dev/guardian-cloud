# KNOWN_DEBT.md

## Known technical debt

- ngrok is temporary and not valid for production.
- Backend proxy Drive upload is acceptable for MVP, but should be reviewed before production.
- expo-av is deprecated and should later migrate to expo-audio / expo-video.
- Existing failing tests need review after the recovery flow is stabilized.
- Logs should be reduced before release.
- Export flow has no entry point from the home screen yet (reachable only via direct route `/session/:id`). A Historial brick should list past sessions and link in (see `TODO(export-history)`).
- Export accumulates the full session bytes in memory before writing. Acceptable for MVP-size recordings but will OOM on large files — switch to an incremental append (see `TODO(export-large)`).
- A partial export missing the last chunk loses the MP4 `moov` atom and the resulting .m4a is generally unplayable. File is still produced as forensic output; moov-patching is out of scope (see `TODO(export-headerless-partial)`).