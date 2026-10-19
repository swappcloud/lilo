//! Claude voice transport.
//!
//! The voice WebSocket must run on the claude.ai origin (cookies + Cloudflare
//! clearance), so the hidden Claude window owns it — see
//! `docs/claude-voice-protocol.md`. This module is the other half of that
//! contract:
//!
//! * it injects the engine into the hidden window (`assets/claude-voice-engine.js`),
//! * it receives the engine's batched reports through the `claude-voice`
//!   plugin's `report` command — the only command that origin is granted, and
//!   only with the session's random token,
//! * it forwards those batches to the app as the `claude-voice` event.
//!
//! claude.ai's Content-Security-Policy blocks `fetch` to anything but itself,
//! which is why the reports ride Tauri IPC instead of a loopback HTTP sink.
//!
//! `start` only reports success once the engine says `ready`, so a blocked
//! microphone or a refused socket fails loudly instead of silently.

use std::sync::Mutex;
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::accounts;
use crate::error::AppError;
use crate::logging;
use crate::providers::{self, claude};

/// Batches of engine events, forwarded verbatim to the frontend provider.
pub const EVENT_NAME: &str = "claude-voice";
const ENGINE_JS: &str = include_str!("../../assets/claude-voice-engine.js");
/// Generous: sending the instructions waits for Claude's whole text reply.
const START_TIMEOUT: Duration = Duration::from_secs(60);
// claude.ai's own SPA sometimes hard-navigates ('/' -> '/new' or a chat URL)
// right as the engine is creating a conversation, discarding whatever was
// evaluated (see `start`'s doc comment). A short interval recovers from that
// in well under a second instead of losing multiple seconds waiting it out —
// the injection is a no-op if the engine on that page is already running.
const REINJECT_EVERY: Duration = Duration::from_millis(400);
/// A start that the app itself stopped (the user pressed stop while connecting).
const CANCELLED: &str = "Claude voice start cancelled";

type Reports = tokio::sync::mpsc::UnboundedSender<serde_json::Value>;

/// What the frontend asks a voice session to start with. Every field is
/// passed through to the engine, which fills in claude.ai's own defaults.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    pub voice: Option<String>,
    pub model: Option<String>,
    /// claude.ai's voice language code (`pt`, `en-US`, `it`).
    pub language: Option<String>,
    /// The conversation language as a BCP-47 tag (`pt-BR`), for the text turn.
    pub locale: Option<String>,
    /// `tts_speed` multiplier, as a string (`"0.8"`, `"1"`, `"1.2"`).
    pub speed: Option<String>,
    pub instructions: Option<String>,
    pub conversation_id: Option<String>,
}

struct Session {
    token: String,
    /// Batches go to `start` while it waits for `ready`.
    starting: Option<Reports>,
}

/// The current voice session's token, and who is waiting on its start.
#[derive(Default)]
pub struct VoiceBridge {
    session: Mutex<Option<Session>>,
}

impl VoiceBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn active(&self) -> bool {
        self.session.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn stop(&self) {
        let taken = self.session.lock().ok().and_then(|mut g| g.take());
        if taken.is_some() {
            logging::log("claude-voice", "session closed");
        }
    }

    /// A batch from the engine. Anything without the session's token is dropped.
    fn accept(&self, token: &str, batch: &serde_json::Value) -> bool {
        let Ok(mut guard) = self.session.lock() else {
            return false;
        };
        let Some(session) = guard.as_mut() else {
            return false;
        };
        if session.token != token {
            return false;
        }
        if let Some(tx) = &session.starting {
            if tx.send(batch.clone()).is_err() {
                session.starting = None;
            }
        }
        true
    }

    /// Injects the engine and waits until it is live.
    ///
    /// The hidden window may still be loading (just created, or claude.ai
    /// redirecting), and a navigation discards whatever was evaluated. So the
    /// engine is re-injected until it reports `ready` — it ignores a second
    /// injection on the same page — or fails with `error`.
    pub async fn start(&self, app: &AppHandle, options: StartOptions) -> Result<String, AppError> {
        self.stop();

        let org = {
            let state = app.state::<crate::AppState>();
            state
                .accounts
                .pick(accounts::PROVIDER_CLAUDE, None)
                .map(|account| account.org)
                .filter(|org| !org.is_empty())
                .ok_or_else(|| AppError::other("Sign in with Claude first."))?
        };
        providers::backend(accounts::PROVIDER_CLAUDE)
            .ok_or_else(|| AppError::other("the Claude backend is not registered"))?
            .ensure_host(app)?;
        let window = app
            .get_webview_window(claude::WINDOW_LABEL)
            .ok_or_else(|| AppError::other("The Claude window is not open — sign in again."))?;

        let had_conversation_id = options.conversation_id.is_some();
        let mut cfg_base = serde_json::json!({
            "org": org,
            "voice": options.voice,
            "model": options.model,
            "language": options.language,
            "locale": options.locale,
            "speed": options.speed,
            "instructions": options.instructions,
            "conversationId": options.conversation_id,
        });

        let mut outcome = self.run_attempt(&window, &cfg_base, START_TIMEOUT).await;
        // Resuming a conversation the app remembers can fail on its own — it
        // may have been deleted on claude.ai, or the session went stale — so
        // that is worth one fallback to a brand new conversation before the
        // reload-and-retry below, which only covers a stale session.
        if should_start_fresh(&outcome, had_conversation_id) {
            logging::log(
                "claude-voice",
                "resuming the stored conversation failed — starting a new one",
            );
            if let Some(map) = cfg_base.as_object_mut() {
                map.remove("conversationId");
            }
            outcome = self.run_attempt(&window, &cfg_base, START_TIMEOUT).await;
        }
        // A session that expired between logins fails the very first
        // "create conversation" call with a 401/403 — reloading the hidden
        // window re-lets claude.ai's own cookie jar prove itself (it may
        // just need a Cloudflare re-check, not a real sign-in), so this is
        // worth exactly one retry before asking the user to sign in again.
        if let Err(message) = &outcome {
            if is_stale_session(message) {
                logging::log(
                    "claude-voice",
                    "conversation create was refused — reloading the Claude window once before giving up",
                );
                if let Ok(url) = claude::HOME_URL.parse() {
                    let _ = window.navigate(url);
                }
                outcome = self.run_attempt(&window, &cfg_base, START_TIMEOUT).await;
            }
        }

        let conversation_id = match outcome {
            Ok(id) => id,
            Err(message) => {
                let _ = window.eval("window.__liloClaudeVoice?.stop?.();");
                self.stop();
                logging::log("claude-voice", &format!("start failed: {message}"));
                let message = if is_stale_session(&message) {
                    "Claude session expired — sign in again.".to_string()
                } else {
                    message
                };
                return Err(AppError::other(message));
            }
        };

        if let Ok(mut guard) = self.session.lock() {
            if let Some(session) = guard.as_mut() {
                session.starting = None;
            }
        }
        logging::log("claude-voice", "engine started");
        Ok(conversation_id)
    }

    /// One pass of inject-and-wait, with a fresh token and report channel
    /// (a retried attempt cannot reuse the previous one: its receiver was
    /// already consumed). Returns the conversation id once the engine
    /// reports `ready`, or fails with `error` or the deadline.
    async fn run_attempt(
        &self,
        window: &tauri::WebviewWindow,
        cfg_base: &serde_json::Value,
        timeout: Duration,
    ) -> Result<String, String> {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let (tx, mut reports) = tokio::sync::mpsc::unbounded_channel();
        if let Ok(mut guard) = self.session.lock() {
            *guard = Some(Session {
                token: token.clone(),
                starting: Some(tx),
            });
        }

        let mut cfg = cfg_base.clone();
        if let Some(map) = cfg.as_object_mut() {
            map.insert("token".to_string(), serde_json::Value::String(token));
        }
        let script = format!("window.__liloVoiceCfg = {cfg};\n{ENGINE_JS}");

        let deadline = tokio::time::Instant::now() + timeout;
        let mut booted = false;
        let mut last_stage: Option<String> = None;
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let page = window.url().map(|url| url.to_string()).unwrap_or_default();
            logging::log(
                "claude-voice",
                &format!("injecting engine (attempt {attempt}, page {page})"),
            );
            if let Err(error) = window.eval(&script) {
                return Err(format!("engine injection failed: {error}"));
            }
            let wake = (tokio::time::Instant::now() + REINJECT_EVERY).min(deadline);
            let mut decided = None;
            while decided.is_none() {
                match tokio::time::timeout_at(wake, reports.recv()).await {
                    Ok(Some(batch)) => {
                        if !booted && contains_type(&batch, "boot") {
                            logging::log("claude-voice", "engine reported in");
                        }
                        booted |= contains_type(&batch, "boot");
                        if let Some(stage) = last_stage_in(&batch) {
                            logging::log("claude-voice", &format!("engine stage: {stage}"));
                            last_stage = Some(stage);
                        }
                        decided = start_outcome(&batch);
                    }
                    Ok(None) => decided = Some(Err(CANCELLED.to_string())),
                    Err(_) => break,
                }
            }
            if let Some(outcome) = decided {
                return outcome;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(if booted {
                    format!(
                        "Claude voice did not start (stuck at: {}).",
                        last_stage.as_deref().unwrap_or("boot")
                    )
                } else {
                    "The Claude window never reported back (page not loaded, or IPC blocked)."
                        .to_string()
                });
            }
        }
    }
}

/// Whether `message` is the engine's "the session claude.ai gave us no
/// longer works" shape, worth one reload-and-retry rather than an immediate
/// failure.
fn is_stale_session(message: &str) -> bool {
    message.contains("conversation create: 401") || message.contains("conversation create: 403")
}

fn should_start_fresh(outcome: &Result<String, String>, had_conversation_id: bool) -> bool {
    had_conversation_id && outcome.as_ref().is_err_and(|message| message != CANCELLED)
}

/// `plugin:claude-voice|report` — the engine's only way back into the app.
#[tauri::command]
fn report<R: Runtime>(
    app: AppHandle<R>,
    token: String,
    events: serde_json::Value,
) -> Result<(), String> {
    let accepted = app
        .try_state::<crate::AppState>()
        .map(|state| state.claude_voice.accept(&token, &events))
        .unwrap_or(false);
    if !accepted {
        return Err("no such voice session".to_string());
    }
    let _ = app.emit(EVENT_NAME, events);
    Ok(())
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("claude-voice")
        .invoke_handler(tauri::generate_handler![report])
        .build()
}

/// Only base64 may be spliced into the engine's `eval`.
pub fn is_base64(chunk: &str) -> bool {
    !chunk.is_empty()
        && chunk
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

fn contains_type(batch: &serde_json::Value, kind: &str) -> bool {
    batch.as_array().is_some_and(|events| {
        events
            .iter()
            .any(|event| event.get("type").and_then(|t| t.as_str()) == Some(kind))
    })
}

/// The last `stage` the engine reached in a batch, for a useful timeout.
fn last_stage_in(batch: &serde_json::Value) -> Option<String> {
    batch.as_array()?.iter().rev().find_map(|event| {
        (event.get("type")?.as_str()? == "stage")
            .then(|| event.get("stage")?.as_str().map(str::to_string))
            .flatten()
    })
}

/// What a batch says about the start: `ready` succeeds with the engine's
/// conversation id, `error` fails with its message, anything else (boot,
/// levels) keeps waiting.
fn start_outcome(batch: &serde_json::Value) -> Option<Result<String, String>> {
    if let Some(message) = first_error(batch) {
        return Some(Err(message));
    }
    ready_conversation_id(batch).map(Ok)
}

/// The `conversationId` off a `ready` event in the batch, if any.
fn ready_conversation_id(batch: &serde_json::Value) -> Option<String> {
    batch.as_array()?.iter().find_map(|event| {
        if event.get("type")?.as_str()? != "ready" {
            return None;
        }
        event
            .get("conversationId")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    })
}

/// The first `error` event in a batch, if any.
fn first_error(value: &serde_json::Value) -> Option<String> {
    let batch = value.as_array()?;
    batch.iter().find_map(|event| {
        (event.get("type")?.as_str()? == "error").then(|| {
            event
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Claude voice failed to start")
                .to_string()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fresh_conversation_retry_never_revives_a_cancelled_start() {
        assert!(!should_start_fresh(&Err(CANCELLED.to_string()), true));
        assert!(!should_start_fresh(&Ok("ready".to_string()), true));
        assert!(!should_start_fresh(
            &Err("missing conversation".to_string()),
            false
        ));
        assert!(should_start_fresh(
            &Err("missing conversation".to_string()),
            true
        ));
    }

    #[test]
    fn finds_the_first_error_in_a_batch() {
        let batch = serde_json::json!([
            { "type": "boot" },
            { "type": "error", "message": "microphone denied" },
        ]);
        assert_eq!(first_error(&batch).as_deref(), Some("microphone denied"));
        assert!(first_error(&serde_json::json!([{ "type": "boot" }])).is_none());
        assert!(first_error(&serde_json::json!({ "type": "error" })).is_none());
    }

    #[test]
    fn a_start_waits_for_ready_and_fails_on_error() {
        let boot = serde_json::json!([{ "type": "boot" }]);
        let ready = serde_json::json!([
            { "type": "ws_open" },
            { "type": "ready", "conversationId": "conv-1" },
        ]);
        let failed =
            serde_json::json!([{ "type": "error", "message": "conversation create: 403" }]);
        assert!(start_outcome(&boot).is_none());
        assert_eq!(start_outcome(&ready), Some(Ok("conv-1".to_string())));
        assert_eq!(
            start_outcome(&failed),
            Some(Err("conversation create: 403".to_string()))
        );
    }

    #[test]
    fn only_base64_reaches_the_engine() {
        assert!(is_base64("AAECAw=="));
        assert!(!is_base64(""));
        assert!(!is_base64("AA');alert(1);//"));
    }

    #[test]
    fn only_the_current_session_token_is_accepted() {
        let bridge = VoiceBridge::new();
        let batch = serde_json::json!([{ "type": "boot" }]);
        assert!(!bridge.accept("abc", &batch));

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        *bridge.session.lock().unwrap() = Some(Session {
            token: "abc".to_string(),
            starting: Some(tx),
        });
        assert!(!bridge.accept("other", &batch));
        assert!(bridge.accept("abc", &batch));
        assert_eq!(rx.try_recv().unwrap(), batch);

        bridge.stop();
        assert!(!bridge.accept("abc", &batch));
    }
}
