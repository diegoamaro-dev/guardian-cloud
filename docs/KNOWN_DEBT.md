# KNOWN_DEBT.md

## Known technical debt

- ngrok is temporary and not valid for production.
- Backend proxy Drive upload is acceptable for MVP, but should be reviewed before production.
- expo-av is deprecated and should later migrate to expo-audio / expo-video.
- Existing failing tests need review after the recovery flow is stabilized.
- Logs should be reduced before release.