//! No native wake engine on this platform.
//!
//! The frontend keeps the browser recognizer for platforms where it works
//! (Chromium), and hides the wake word where it does not (see `useWakeWord`).

use tauri::AppHandle;

pub struct WakeWatcher;

impl WakeWatcher {
    pub fn new() -> Self {
        Self
    }

    /// Whether a native wake-word engine exists on this platform.
    pub fn supported() -> bool {
        false
    }

    pub fn is_running(&self) -> bool {
        false
    }

    pub fn start(&self, _app: &AppHandle, _phrase: &str) -> Result<(), String> {
        Err("no native wake engine on this platform".to_string())
    }

    pub fn stop(&self) {}
}
