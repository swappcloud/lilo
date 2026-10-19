//! Desktop adapter for the shared local Linux wake listener.
use lilo_core::wake::{Event, Options, WakeListener};
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

use super::{BLOCKED_EVENT, EVENT_NAME};

#[derive(Default)]
struct State {
    phrase: String,
    listener: Option<WakeListener>,
    events: Option<std::thread::JoinHandle<()>>,
}
pub struct WakeWatcher {
    state: Mutex<State>,
}

impl WakeWatcher {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
        }
    }
    pub fn supported() -> bool {
        true
    }
    pub fn is_running(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .listener
            .as_ref()
            .is_some_and(WakeListener::is_running)
    }
    pub fn start(&self, app: &AppHandle, phrase: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.phrase == phrase
            && state
                .listener
                .as_ref()
                .is_some_and(WakeListener::is_running)
        {
            return Ok(());
        }
        stop(&mut state);
        let data = app
            .path()
            .app_data_dir()
            .map_err(|_| "Linux wake storage is unavailable.")?;
        let mut options = Options::new(phrase, data.join("wake"));
        if let Ok(resources) = app.path().resource_dir() {
            let root = resources.join("wake/linux");
            if root.join("model/en-us").is_dir() {
                options.model_dir = root.join("model");
                options.library_dir = Some(root.join("lib"));
                options.capture_binary = root.join("bin/parec");
            }
        }
        let (send, receive) = mpsc::sync_channel(8);
        let listener = match WakeListener::start(options, send) {
            Ok(listener) => listener,
            Err(error) => {
                let _ = app.emit(
                    BLOCKED_EVENT,
                    serde_json::json!({"reason": "language-not-supported", "detail": error}),
                );
                return Err(error);
            }
        };
        let app = app.clone();
        let events = std::thread::spawn(move || {
            while let Ok(event) = receive.recv() {
                match event {
                    Event::Ready => {
                        let _ = app.emit(BLOCKED_EVENT, Option::<serde_json::Value>::None);
                    }
                    Event::Detected => {
                        let _ = app.emit(EVENT_NAME, ());
                    }
                    Event::Blocked { reason, detail } => {
                        let _ = app.emit(
                            BLOCKED_EVENT,
                            serde_json::json!({"reason": reason, "detail": detail}),
                        );
                    }
                }
            }
        });
        state.phrase = phrase.into();
        state.listener = Some(listener);
        state.events = Some(events);
        Ok(())
    }
    pub fn stop(&self) {
        stop(&mut self.state.lock().unwrap_or_else(|p| p.into_inner()));
    }
}
fn stop(state: &mut State) {
    if let Some(mut listener) = state.listener.take() {
        listener.stop();
    }
    if let Some(events) = state.events.take() {
        let _ = events.join();
    }
    state.phrase.clear();
}
impl Drop for WakeWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}
