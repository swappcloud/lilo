//! Wake-word watcher: one OS-independent contract, one engine per platform.
//!
//! The frontend owns the phrase and the on/off switch; this module owns the
//! listener. Contract (identical on every OS):
//!
//! - `wake-word` (no payload): the phrase was heard.
//! - `wake-blocked` (`{reason, detail}` or null): the engine cannot listen
//!   until the user changes something; null clears it.
//!
//! Engines:
//!
//! - **macOS** — the `LiloWake.app` Swift helper (WKWebView has no Web Speech
//!   API). See `macos.rs`.
//! - **Windows** — WinRT `SpeechRecognizer` with a phrase list constraint.
//!   WebView2 ships no speech service, so the in-page recognizer only ever
//!   answers `error:network` there. See `windows.rs`.
//! - **Linux** — local PocketSphinx keyword recognition and PulseAudio capture.
//! - **Other** — no native engine. The frontend falls back to the browser
//!   recognizer when one exists, and hides the feature otherwise.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::WakeWatcher;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::WakeWatcher;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::WakeWatcher;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use unsupported::WakeWatcher;

/// Emitted (with no payload) whenever the wake phrase is heard.
pub const EVENT_NAME: &str = "wake-word";

/// Emitted when the listener cannot work until the user changes something.
/// The payload is OS-independent on purpose: every platform's engine reports
/// its own failures, and the UI maps a reason to an action.
pub const BLOCKED_EVENT: &str = "wake-blocked";

/// Versioned transcripts from local engines; no provider connection is involved.
pub const TRANSCRIPT_EVENT: &str = "local-voice-transcript";
pub fn emit_transcript(app: &tauri::AppHandle, text: String, turn: String, final_result: bool) {
    use tauri::Emitter;
    let event = lilo_core::commands::local::Transcript::new(text, turn, final_result);
    if event.valid() {
        let _ = app.emit(TRANSCRIPT_EVENT, event);
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn command_phrases(app: &tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    app.state::<crate::AppState>()
        .router
        .lock()
        .expect("router poisoned")
        .registry()
        .local_voice_phrases("en")
}
