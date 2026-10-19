//! macOS wake engine: the `LiloWake.app` helper (AVAudioEngine + Speech).
//!
//! The helper is launched through LaunchServices (`open -n`) instead of
//! `Command::spawn`. A directly spawned child inherits the *responsible
//! process* of whoever launched the dev app (an IDE/terminal), and TCC checks
//! that process's Info.plist for usage strings — which it lacks, so macOS
//! aborts the helper on first Speech access. LaunchServices makes the helper
//! its own responsible process, so its own
//! `NSSpeechRecognitionUsageDescription` applies and the consent prompt shows.
//!
//! `open` detaches stdio, so events travel over a Unix domain socket created
//! here and handed to the helper as an argument.
//! (debug: helper lifecycle is logged as DBG lines. restart marker 10)

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use super::{BLOCKED_EVENT, EVENT_NAME};
use crate::logging::log;

/// Bundle-relative path of the helper app.
const HELPER_APP_REL: &str = "binaries/LiloWake.app";

pub struct WakeWatcher {
    inner: Mutex<MacState>,
}

impl WakeWatcher {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MacState::default()),
        }
    }

    /// Whether a native wake-word engine exists on this platform.
    pub fn supported() -> bool {
        true
    }

    /// True while the helper is actually listening. The reader thread clears
    /// this on EOF, so the UI never reports a stale "listening".
    pub fn is_running(&self) -> bool {
        self.inner.lock().expect("wake mutex").running
    }

    /// Locate the helper app bundle: app Resources in a bundled build, the
    /// src-tauri layout in dev, then cwd fallbacks.
    fn helper_app_path() -> Option<std::path::PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("../Resources").join(HELPER_APP_REL));
                candidates.push(dir.join("../../").join(HELPER_APP_REL));
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join(HELPER_APP_REL));
            candidates.push(cwd.join(format!("src-tauri/{HELPER_APP_REL}")));
        }
        candidates.into_iter().find(|p| p.is_dir())
    }

    /// Tear down the current helper: ask it to stop over the control socket and
    /// drop our end. We deliberately do **not** `pkill` by bundle path — that
    /// also kills the helper of another (e.g. just-restarted) app instance.
    /// Orphans are covered by the helper's own self-reap (it exits once the app
    /// pid it was handed is gone).
    fn teardown(&self) {
        let mut state = self.inner.lock().expect("wake mutex");
        state.running = false;
        state.phrase = None;
        let had_stream = state.stream.is_some();
        if let Some(mut stream) = state.stream.take() {
            log("wake", "stopping helper");
            let _ = std::io::Write::write_all(&mut stream, b"STOP\n");
        }
        if let Some(path) = state.sock.take() {
            let _ = std::fs::remove_file(&path);
        }
        drop(state);
        log("wake", &format!("teardown (had_stream={had_stream})"));
    }

    pub fn stop(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.desired = None;
        }
        self.teardown();
    }

    pub fn start(&self, app: &AppHandle, phrase: &str) -> Result<(), String> {
        {
            let state = self.inner.lock().expect("wake mutex");
            if state.running && state.phrase.as_deref() == Some(phrase) {
                log("wake", "helper already listening; ignoring duplicate start");
                return Ok(());
            }
        }
        self.teardown();

        let app_path = Self::helper_app_path()
            .ok_or_else(|| "wake helper not found (LiloWake.app)".to_string())?;

        let sock_path = std::env::temp_dir().join(format!(
            "lilo-wake-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_file(&sock_path);

        let listener = std::os::unix::net::UnixListener::bind(&sock_path)
            .map_err(|e| format!("wake socket bind failed: {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("wake socket config failed: {e}"))?;

        log(
            "wake",
            &format!(
                "starting helper (phrase=\"{phrase}\", sock={})",
                sock_path.display()
            ),
        );
        let status = std::process::Command::new("/usr/bin/open")
            .arg("-n")
            .arg("-g")
            .arg(&app_path)
            .arg("--args")
            .arg(phrase)
            .arg(sock_path.to_string_lossy().to_string())
            .arg(std::process::id().to_string())
            .status()
            .map_err(|e| format!("wake helper failed to launch: {e}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&sock_path);
            return Err(format!("wake helper launch failed (open exit {status})"));
        }

        {
            let mut state = self.inner.lock().expect("wake mutex");
            state.sock = Some(sock_path);
            state.phrase = Some(phrase.to_string());
            state.desired = Some(phrase.to_string());
            state.failures = 0;
            state.running = true;
        }

        let handle = app.clone();
        std::thread::Builder::new()
            .name("lilo-wake-io".to_string())
            .spawn(move || accept_and_read(listener, handle))
            .map_err(|e| format!("wake reader failed: {e}"))?;

        Ok(())
    }
}

/// macOS state: the control socket (to send STOP) and liveness flags.
#[derive(Default)]
struct MacState {
    stream: Option<std::os::unix::net::UnixStream>,
    sock: Option<std::path::PathBuf>,
    phrase: Option<String>,
    /// The phrase we want listened for right now (None = intentionally off).
    /// Used by the supervisor to relaunch the helper if it dies.
    desired: Option<String>,
    /// Consecutive unexpected helper exits, to bound restarts.
    failures: u32,
    running: bool,
}

fn accept_and_read(listener: std::os::unix::net::UnixListener, app: AppHandle) {
    use std::io::{BufRead, BufReader};
    use std::time::{Duration, Instant};

    let deadline = Instant::now() + Duration::from_secs(10);
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break Some(stream),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    log("wake", "helper never connected to wake socket");
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                log("wake", &format!("wake socket accept failed: {e}"));
                return;
            }
        }
    };
    let Some(stream) = stream else { return };
    // BSD/macOS: an accepted socket inherits O_NONBLOCK from the (nonblocking)
    // listener, which would make read_line fail with EWOULDBLOCK right after the
    // helper's first burst. Go back to blocking for the read loop.
    let _ = stream.set_nonblocking(false);
    log("wake", "helper connected to wake socket");

    if let Ok(write_half) = stream.try_clone() {
        if let Ok(mut state) = app.state::<crate::AppState>().wake.inner.lock() {
            state.stream = Some(write_half);
        }
    }

    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => {
                log("wake", "helper EOF");
                break;
            }
            Ok(_) => match line.trim() {
                "READY" => {
                    let app_state = app.state::<crate::AppState>();
                    if let Ok(mut state) = app_state.wake.inner.lock() {
                        state.failures = 0;
                    }
                    // A listener that is up again is not blocked any more; the
                    // helper re-reports its own block (Dictation, permission) if
                    // one still applies.
                    let _ = app.emit(BLOCKED_EVENT, serde_json::Value::Null);
                    log("wake", "helper READY (listening)");
                }
                "WAKE" => {
                    log("wake", "phrase detected -> emitting wake-word");
                    let _ = app.emit(EVENT_NAME, ());
                }
                "BYE" => log("wake", "helper acknowledged stop"),
                "DEAF" => {
                    // The helper is fed audio and its recognizer reacts to
                    // nothing: recycling tasks does not fix that, a fresh
                    // process does. Closing here lets the supervisor respawn.
                    log("wake", "helper deaf — respawning");
                    break;
                }
                "UNBLOCKED" => {
                    log("wake", "recognition recovered");
                    let _ = app.emit(BLOCKED_EVENT, serde_json::Value::Null);
                }
                "" => {}
                other => {
                    if let Some(rest) = other.strip_prefix("BLOCKED ") {
                        // `<reason>: <detail>` — the reason is a stable key the
                        // UI can branch on, the detail is for the human.
                        let (reason, detail) = rest.split_once(':').unwrap_or((rest, ""));
                        log("wake", &format!("blocked: {reason} — {}", detail.trim()));
                        let _ = app.emit(
                            BLOCKED_EVENT,
                            serde_json::json!({
                                "reason": reason.trim(),
                                "detail": detail.trim(),
                            }),
                        );
                    } else {
                        log("wake", &format!("helper: {other}"));
                    }
                }
            },
            Err(e) => {
                log("wake", &format!("helper read error: {e:?}"));
                break;
            }
        }
    }
    log("wake", "helper connection closed");

    // Supervisor: if we still want a listener (the app is idle and wake is
    // enabled) but the helper is gone, bring it back. This makes the listener
    // self-healing against dev rebuilds or anything that reaps the process.
    let mut notify: Option<serde_json::Value> = None;
    let restart_phrase = {
        let app_state = app.state::<crate::AppState>();
        let mut state = match app_state.wake.inner.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.running = false;
        state.phrase = None;
        state.stream = None;
        match state.desired.clone() {
            Some(phrase) if state.failures < 8 => {
                state.failures += 1;
                // A helper that dies again and again is a broken wake word the
                // user cannot see: say so instead of retrying in silence.
                if state.failures == 3 {
                    notify = Some(serde_json::json!({
                        "reason": "helper-unstable",
                        "detail": "The wake listener keeps exiting; retrying.",
                    }));
                }
                Some(phrase)
            }
            Some(_) => {
                log(
                    "wake",
                    "helper keeps dying; giving up until wake is re-armed",
                );
                state.desired = None;
                notify = Some(serde_json::json!({
                    "reason": "helper-unstable",
                    "detail": "The wake listener stopped after repeated failures — turn the wake word off and on to retry.",
                }));
                None
            }
            None => None,
        }
    };
    if let Some(block) = notify {
        let _ = app.emit(BLOCKED_EVENT, block);
    }

    if let Some(phrase) = restart_phrase {
        log("wake", "helper stopped; will restart shortly");
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            let app_state = app2.state::<crate::AppState>();
            let still_wanted = app_state
                .wake
                .inner
                .lock()
                .map(|state| state.desired.as_deref() == Some(phrase.as_str()))
                .unwrap_or(false);
            if still_wanted {
                let _ = app_state.wake.start(&app2, &phrase);
            }
        });
    }
}
