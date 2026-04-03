# Changelog

## 2026-03-09

### Added

- Project switching and session switching in Telegram
- Desktop/Web backend auto-discovery with fallback to `OPENCODE_SERVER_URL`
- Permission approval inline buttons
- OpenCode `question` event handling in Telegram
- Image and file input pipeline with local download cache
- Media-group aggregation for Telegram albums
- Single-instance lock to prevent Telegram polling conflicts
- Regression tests for backend discovery, media handling, rendering, and project-session helpers

### Changed

- Restored true streaming for Desktop sidecar mode through scoped SSE
- Added poll fallback for sidecar cases where unscoped event streams are insufficient
- Refactored the codebase so `index.ts` is now a thin orchestration layer
- Rewrote the README to document installation, configuration, backend modes, and troubleshooting

### Fixed

- Telegram draft cleanup noise caused by empty draft payloads
- Cases where Telegram only received reasoning but not the final answer
- Cases where typing status kept running after the response had already finished
- Permission polling on the wrong OpenCode project scope
- Session/backend mismatch after switching projects or backends
