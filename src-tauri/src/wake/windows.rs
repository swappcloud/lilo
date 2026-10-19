//! Windows wake engine: WinRT `SpeechRecognizer` with a phrase list constraint.
//!
//! WebView2 ships no speech service, so `webkitSpeechRecognition` there only
//! ever fails with `error:network` — the in-page engine cannot work on
//! Windows. The OS recognizer can: offline, keyless, and it takes an arbitrary
//! phrase list, which keeps the user-configurable wake phrase.
//!
//! A worker thread owns the recognizer (WinRT apartment + blocking awaits) and
//! re-arms the continuous session whenever Windows ends it, the same way the
//! browser path restarts on `onend`. `stop` only flips a flag; the thread
//! releases the microphone on its own, quickly.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};
use windows::core::HSTRING;
use windows::Foundation::TypedEventHandler;
use windows::Globalization::{ApplicationLanguages, Language};
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs,
    SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
    SpeechRecognitionListConstraint, SpeechRecognitionResultStatus, SpeechRecognizer,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows_collections::IIterable;

use super::{BLOCKED_EVENT, EVENT_NAME};
use crate::logging::log;

/// Ignore repeats of the same phrase within this window (seconds of overlap
/// between two recognition tasks would otherwise fire twice).
const COOLDOWN_MS: u64 = 2000;

/// `E_ACCESSDENIED`, the HRESULT Windows returns when the microphone is
/// blocked by privacy settings.
const E_ACCESSDENIED: u32 = 0x8007_0005;

pub struct WakeWatcher {
    inner: Mutex<WinState>,
}

#[derive(Default)]
struct WinState {
    stop: Option<Arc<AtomicBool>>,
    running: Option<Arc<AtomicBool>>,
    phrase: Option<String>,
}

impl WakeWatcher {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(WinState::default()),
        }
    }

    /// Whether a native wake-word engine exists on this platform.
    pub fn supported() -> bool {
        true
    }

    pub fn is_running(&self) -> bool {
        let state = self.inner.lock().expect("wake mutex");
        state
            .running
            .as_ref()
            .map(|flag| flag.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    pub fn start(&self, app: &AppHandle, phrase: &str) -> Result<(), String> {
        let phrase = phrase.trim().to_string();
        if phrase.is_empty() {
            return Err("wake phrase is empty".to_string());
        }
        {
            let state = self.inner.lock().expect("wake mutex");
            let live = state
                .running
                .as_ref()
                .map(|flag| flag.load(Ordering::Relaxed))
                .unwrap_or(false);
            if live && state.phrase.as_deref() == Some(phrase.as_str()) {
                log(
                    "wake",
                    "winrt recognizer already listening; ignoring duplicate start",
                );
                return Ok(());
            }
        }
        self.stop();

        let stop = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicBool::new(true));
        {
            let mut state = self.inner.lock().expect("wake mutex");
            state.stop = Some(stop.clone());
            state.running = Some(running.clone());
            state.phrase = Some(phrase.clone());
        }

        let handle = app.clone();
        std::thread::Builder::new()
            .name("lilo-wake-winrt".to_string())
            .spawn(move || run(handle, phrase, stop, running))
            .map_err(|e| format!("wake worker failed: {e}"))?;
        Ok(())
    }

    pub fn stop(&self) {
        let (stop, running) = {
            let mut state = self.inner.lock().expect("wake mutex");
            state.phrase = None;
            (state.stop.take(), state.running.take())
        };
        if let Some(flag) = stop {
            flag.store(true, Ordering::Relaxed);
        }
        if let Some(flag) = running {
            flag.store(false, Ordering::Relaxed);
        }
    }
}

/// Why the engine could not listen, in the OS-independent `wake-blocked`
/// vocabulary the UI knows.
struct EngineError {
    reason: &'static str,
    detail: String,
}

impl EngineError {
    fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }
}

fn run(app: AppHandle, phrase: String, stop: Arc<AtomicBool>, running: Arc<AtomicBool>) {
    // An MTA apartment is all WinRT needs; `get()` on the async operations then
    // blocks this thread without pumping messages.
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let result = if initialized {
        listen(&app, &phrase, &stop)
    } else {
        Err(EngineError::new(
            "recognizer-error",
            "COM/WinRT could not be initialized on the wake thread",
        ))
    };
    if let Err(error) = result {
        if !stop.load(Ordering::Relaxed) {
            log("wake", &format!("winrt engine stopped: {}", error.detail));
            let _ = app.emit(
                BLOCKED_EVENT,
                serde_json::json!({ "reason": error.reason, "detail": error.detail }),
            );
        }
    }
    if initialized {
        unsafe { CoUninitialize() };
    }
    running.store(false, Ordering::Relaxed);
    log("wake", "winrt engine thread exited");
}

fn listen(app: &AppHandle, phrase: &str, stop: &AtomicBool) -> Result<(), EngineError> {
    let recognizer = create_recognizer()?;

    let words: IIterable<HSTRING> = vec![HSTRING::from(phrase)].into();
    let constraint = SpeechRecognitionListConstraint::Create(&words)
        .map_err(|e| EngineError::new("recognizer-error", format!("wake phrase rejected: {e}")))?;
    recognizer
        .Constraints()
        .and_then(|list| list.Append(&constraint))
        .map_err(|e| {
            EngineError::new("recognizer-error", format!("wake constraint failed: {e}"))
        })?;
    let compiled = recognizer
        .CompileConstraintsAsync()
        .and_then(|op| op.get())
        .map_err(|e| {
            EngineError::new(
                "recognizer-error",
                format!("wake constraint compile failed: {e}"),
            )
        })?;
    let status = compiled
        .Status()
        .unwrap_or(SpeechRecognitionResultStatus::Unknown);
    if status != SpeechRecognitionResultStatus::Success {
        return Err(EngineError::new(
            "recognizer-error",
            format!("Windows rejected the wake phrase ({status:?})"),
        ));
    }

    let session = recognizer.ContinuousRecognitionSession().map_err(|e| {
        EngineError::new(
            "recognizer-error",
            format!("continuous session unavailable: {e}"),
        )
    })?;
    install_result_handler(app, phrase, &session)?;

    // Windows ends a continuous session on silence; the channel lets the loop
    // tell "session over" from "stop asked".
    let (tx, rx) = mpsc::channel::<()>();
    session
        .Completed(&TypedEventHandler::<
            SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionCompletedEventArgs,
        >::new(move |_, _| {
            let _ = tx.send(());
            Ok(())
        }))
        .map_err(|e| {
            EngineError::new("recognizer-error", format!("completed handler failed: {e}"))
        })?;

    log("wake", "winrt recognizer listening");
    let _ = app.emit(BLOCKED_EVENT, serde_json::Value::Null);

    while !stop.load(Ordering::Relaxed) {
        if let Err(e) = session.StartAsync().and_then(|op| op.get()) {
            return Err(EngineError::new(
                "recognizer-error",
                format!("session start failed: {e}"),
            ));
        }
        loop {
            if stop.load(Ordering::Relaxed) {
                let _ = session.StopAsync().and_then(|op| op.get());
                return Ok(());
            }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(()) => break,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
        // Re-arm for the next burst of speech. The pause keeps a session that
        // completes instantly (e.g. microphone gone) from spinning.
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(())
}

fn install_result_handler(
    app: &AppHandle,
    phrase: &str,
    session: &SpeechContinuousRecognitionSession,
) -> Result<(), EngineError> {
    let target = normalize(phrase);
    let last = Arc::new(AtomicU64::new(0));
    let handle = app.clone();
    session
        .ResultGenerated(&TypedEventHandler::<
            SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
        >::new(move |_, args| {
            let Some(args) = args.as_ref() else {
                return Ok(());
            };
            let Ok(result) = args.Result() else {
                return Ok(());
            };
            let Ok(text) = result.Text() else {
                return Ok(());
            };
            let text = text.to_string();
            if !normalize(&text).contains(&target) {
                return Ok(());
            }
            let now = millis();
            let previous = last.load(Ordering::Relaxed);
            if now.saturating_sub(previous) < COOLDOWN_MS {
                return Ok(());
            }
            last.store(now, Ordering::Relaxed);
            log(
                "wake",
                &format!(
                    "winrt phrase detected (\"{}\") -> emitting wake-word",
                    text.trim()
                ),
            );
            let _ = handle.emit(EVENT_NAME, ());
            Ok(())
        }))
        .map_err(|e| EngineError::new("recognizer-error", format!("result handler failed: {e}")))?;
    Ok(())
}

/// Pick the first speech language this machine actually has installed: the
/// app's languages, then the system speech language, then `en-US` (the wake
/// phrase default is English).
fn create_recognizer() -> Result<SpeechRecognizer, EngineError> {
    let mut tried: Vec<String> = Vec::new();
    for tag in speech_language_candidates() {
        if tried.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
            continue;
        }
        tried.push(tag.clone());
        let language = match Language::CreateLanguage(&HSTRING::from(&tag)) {
            Ok(language) => language,
            Err(e) => {
                log("wake", &format!("winrt language {tag} rejected: {e}"));
                continue;
            }
        };
        match SpeechRecognizer::Create(&language) {
            Ok(recognizer) => {
                log("wake", &format!("winrt recognizer ready (language={tag})"));
                return Ok(recognizer);
            }
            Err(e) if e.code().0 as u32 == E_ACCESSDENIED => {
                return Err(EngineError::new(
                    "not-allowed",
                    format!("Windows denied microphone access: {e}"),
                ));
            }
            Err(e) => log("wake", &format!("winrt language {tag} unavailable: {e}")),
        }
    }
    Err(EngineError::new(
        "speech-unavailable",
        format!(
            "No Windows speech language could be created (tried {}). Install a speech pack in Settings → Time & Language → Speech.",
            tried.join(", ")
        ),
    ))
}

fn speech_language_candidates() -> Vec<String> {
    let mut tags = Vec::new();
    if let Ok(languages) = ApplicationLanguages::Languages() {
        if let Ok(size) = languages.Size() {
            for index in 0..size {
                if let Ok(tag) = languages.GetAt(index) {
                    let tag = tag.to_string();
                    if !tag.is_empty() {
                        tags.push(tag);
                    }
                }
            }
        }
    }
    if let Ok(language) = SpeechRecognizer::SystemSpeechLanguage() {
        if let Ok(tag) = language.LanguageTag() {
            let tag = tag.to_string();
            if !tag.is_empty() {
                tags.push(tag);
            }
        }
    }
    tags.push("en-US".to_string());
    tags
}

fn normalize(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    out.trim().to_string()
}

fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
