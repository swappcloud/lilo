use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

const GRACE: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_secs(5);
static LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);

pub(crate) fn touch_host_use() {
    if let Ok(mut last) = LAST_USE.lock() {
        *last = Some(Instant::now());
    }
}

fn idle_for() -> Duration {
    LAST_USE
        .lock()
        .ok()
        .and_then(|last| last.map(|at| at.elapsed()))
        .unwrap_or_default()
}

fn can_close(hosting: bool, visible: bool, idle_for: Duration, active: bool) -> bool {
    hosting && !visible && !active && idle_for >= GRACE
}

/// Keeps short pauses warm, then releases only hidden provider transports.
/// Persistent profiles and accounts are owned independently of these windows.
pub(crate) fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(POLL);
        loop {
            ticker.tick().await;
            let state = app.state::<crate::AppState>();
            let active = state.bindings.active() > 0
                || state.claude_voice.active()
                || state.grok_voice.active();
            if active {
                touch_host_use();
                continue;
            }
            if idle_for() < GRACE {
                continue;
            }
            for backend in super::BACKENDS {
                if !backend.hosting() {
                    continue;
                }
                let Some(window) = app.get_webview_window(backend.window.label) else {
                    continue;
                };
                if !can_close(
                    backend.hosting(),
                    window.is_visible().unwrap_or(true),
                    idle_for(),
                    active,
                ) {
                    continue;
                }
                if window.close().is_ok() {
                    backend.set_hosting(false);
                    backend
                        .ready
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                    crate::logging::log(
                        "session",
                        &format!("closed idle {} transport", backend.display_name),
                    );
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_close_releases_only_unused_hidden_transports_after_grace() {
        assert!(can_close(true, false, Duration::from_secs(120), false));
        assert!(!can_close(true, false, Duration::from_secs(119), false));
        assert!(!can_close(true, false, Duration::from_secs(300), true));
        assert!(!can_close(true, true, Duration::from_secs(300), false));
        assert!(!can_close(false, false, Duration::from_secs(300), false));
    }
}
