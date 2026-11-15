# Changelog

Describe changes under **Unreleased** as they land. Version-specific notes are used by GitHub releases and the updater.

## [Unreleased]

### Fixed

- Retain verified media tool archives for all supported platforms so removed upstream releases cannot break installation.
- Upgrade app-managed media tools safely after app updates, preserving the previous executable on failure.

### Changed

- Refresh stable JavaScript and Rust dependencies and media tools, preserving OS and Windows ABI compatibility.
- Verify native media installation before publishing signed app updates.

## [0.1.0] - 2026-10-12

### Added

- Cross-platform desktop interface for realtime voice using the user's provider accounts.
- Shared command routing, local media playback, compatible plugins and configurable voice settings.
- Linux daemon with phone management, provider sign-in and standalone ChatGPT voice.
- Plugin marketplace, local histories and user-initiated diagnostic export.
- Linux installation scripts and desktop release tooling.
