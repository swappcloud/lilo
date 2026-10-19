import assert from 'node:assert/strict';
import { selectPlatformTests } from './ci-platform-tests.mjs';

assert.deepEqual(selectPlatformTests(['README.md', 'app/src/App.tsx']), {
  windows: false,
  macos_intel: false,
});
assert.deepEqual(selectPlatformTests(['src-tauri/src/wake/windows.rs']), {
  windows: true,
  macos_intel: false,
});
assert.deepEqual(selectPlatformTests(['src-tauri/wake/lilo-wake.swift']), {
  windows: false,
  macos_intel: true,
});
assert.deepEqual(selectPlatformTests(['.github/workflows/ci.yml']), {
  windows: true,
  macos_intel: true,
});
assert.deepEqual(selectPlatformTests(['crates/lilo-core/src/plugins/http.rs']), {
  windows: true,
  macos_intel: true,
});
