//! Same-origin Grok voice socket with bounded, session-authenticated IPC reports.
use crate::error::AppError;
use crate::providers::{self, grok};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Webview};

const ENGINE: &str = include_str!("../../assets/grok-voice-engine.js");
const EVENT: &str = "grok-voice";
type Reports = tokio::sync::mpsc::UnboundedSender<serde_json::Value>;

#[derive(Default)]
pub struct VoiceBridge {
    session: Mutex<Option<Session>>,
}
struct Session {
    token: String,
    starting: Option<Reports>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    voice: Option<String>,
    language: Option<String>,
    instructions: Option<String>,
    conversation_id: Option<String>,
}

impl VoiceBridge {
    pub fn active(&self) -> bool {
        self.session
            .lock()
            .map(|session| session.is_some())
            .unwrap_or(true)
    }

    fn finish_start(&self, token: &str, success: bool) -> bool {
        let Ok(mut guard) = self.session.lock() else {
            return false;
        };
        if !guard.as_ref().is_some_and(|session| session.token == token) {
            return false;
        }
        if success {
            if let Some(session) = guard.as_mut() {
                session.starting = None;
            }
        } else {
            *guard = None;
        }
        true
    }
    pub fn stop(&self) {
        if let Ok(mut session) = self.session.lock() {
            *session = None;
        }
    }

    fn accept(&self, token: &str, batch: &serde_json::Value) -> bool {
        let Some(events) = batch.as_array() else {
            return false;
        };
        if events.len() > 128 || batch.to_string().len() > 512 * 1024 {
            return false;
        }
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
            let _ = tx.send(batch.clone());
        }
        true
    }

    async fn start(&self, app: &AppHandle, options: StartOptions) -> Result<String, AppError> {
        let state = app.state::<crate::AppState>();
        if state
            .accounts
            .pick(crate::accounts::PROVIDER_GROK, None)
            .is_none()
        {
            return Err(AppError::other("Sign in with Grok first."));
        }
        let backend = providers::backend(crate::accounts::PROVIDER_GROK)
            .ok_or_else(|| AppError::other("Grok login backend is unavailable."))?;
        backend.ensure_host(app)?;
        let window = app
            .get_webview_window(grok::WINDOW_LABEL)
            .ok_or_else(|| AppError::other("The Grok login window is unavailable."))?;
        stop_engine(app);
        self.stop();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        *self
            .session
            .lock()
            .map_err(|_| AppError::other("Grok bridge is unavailable."))? = Some(Session {
            token: token.clone(),
            starting: Some(tx),
        });
        let config = serde_json::json!({
            "token": token.clone(), "voice": options.voice, "language": options.language,
            "instructions": options.instructions, "conversationId": options.conversation_id,
        });
        let script = format!("window.__liloGrokVoiceCfg = {config};\n{ENGINE}");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        let outcome = async {
            loop {
                window.eval(&script).map_err(|_| AppError::other("Could not start the Grok voice engine."))?;
                let wake = (tokio::time::Instant::now() + Duration::from_millis(400)).min(deadline);
                loop {
                    match tokio::time::timeout_at(wake, rx.recv()).await {
                        Ok(Some(batch)) => if let Some(result) = start_outcome(&batch) {
                            return result.map_err(AppError::other);
                        },
                        Ok(None) => return Err(AppError::other("Grok voice start was cancelled.")),
                        Err(_) => break,
                    }
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(AppError::other("Grok voice did not become ready. Open Grok sign-in and check your account's voice access."));
                }
            }
        }.await;
        if self.finish_start(&token, outcome.is_ok()) && outcome.is_err() {
            stop_engine(app);
        }
        outcome
    }
}

fn start_outcome(batch: &serde_json::Value) -> Option<Result<String, String>> {
    let events = batch.as_array()?;
    for event in events {
        if event.get("type").and_then(|value| value.as_str()) == Some("closed") {
            return Some(Err(
                "Grok closed the connection before startup completed.".into()
            ));
        }
        if event.get("type").and_then(|value| value.as_str()) == Some("error") {
            return Some(Err(event
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Grok voice failed.")
                .into()));
        }
    }
    events.iter().find_map(|event| {
        (event.get("type")?.as_str()? == "ready")
            .then(|| {
                event
                    .get("conversationId")?
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(|id| Ok(id.into()))
            })
            .flatten()
    })
}

fn stop_engine(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(grok::WINDOW_LABEL) {
        let _ = window.eval("window.__liloGrokVoice?.stop();");
    }
}

#[tauri::command]
pub async fn grok_voice_start(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    options: StartOptions,
) -> Result<String, AppError> {
    state.grok_voice.start(&app, options).await
}

#[tauri::command]
pub fn grok_voice_stop(app: AppHandle, state: State<'_, crate::AppState>) {
    providers::idle::touch_host_use();
    stop_engine(&app);
    state.grok_voice.stop();
}

#[tauri::command]
pub fn grok_voice_send(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    event: serde_json::Value,
) -> Result<(), AppError> {
    if event.to_string().len() > 128 * 1024 || !event.is_object() {
        return Err(AppError::other("Invalid Grok voice event."));
    }
    let token = state
        .grok_voice
        .session
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|session| session.token.clone()))
        .ok_or_else(|| AppError::other("Grok voice is not connected."))?;
    let window = app
        .get_webview_window(grok::WINDOW_LABEL)
        .ok_or_else(|| AppError::other("Grok voice window is unavailable."))?;
    window
        .eval(format!(
            "window.__liloGrokVoice?.send({event}, {});",
            serde_json::to_string(&token)?
        ))
        .map_err(|_| AppError::other("Could not send a Grok voice event."))?;
    Ok(())
}

#[tauri::command]
fn report<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    token: String,
    events: serde_json::Value,
) -> Result<(), String> {
    if webview.label() != grok::WINDOW_LABEL {
        return Err("Invalid Grok report source.".into());
    }
    let accepted = app
        .try_state::<crate::AppState>()
        .is_some_and(|state| state.grok_voice.accept(&token, &events));
    if !accepted {
        return Err("No such Grok voice session.".into());
    }
    let _ = app.emit(EVENT, events);
    Ok(())
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("grok-voice")
        .invoke_handler(tauri::generate_handler![report])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_active_protects_starting_and_connected_sessions_until_stopped() {
        let bridge = VoiceBridge::default();
        assert!(!bridge.active());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        *bridge.session.lock().unwrap() = Some(Session {
            token: "current".into(),
            starting: Some(tx),
        });
        assert!(bridge.active());
        assert!(bridge.finish_start("current", true));
        assert!(bridge.active());
        bridge.stop();
        assert!(!bridge.active());
    }

    #[test]
    fn a_cancelled_start_cannot_finish_a_newer_session() {
        let bridge = VoiceBridge::default();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        *bridge.session.lock().unwrap() = Some(Session {
            token: "new".into(),
            starting: Some(tx),
        });
        assert!(!bridge.finish_start("old", false));
        assert!(bridge.session.lock().unwrap().is_some());
        assert!(bridge.finish_start("new", true));
        assert!(bridge
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .starting
            .is_none());
    }

    #[test]
    fn startup_requires_a_conversation_and_prioritizes_errors() {
        assert!(start_outcome(&serde_json::json!([{ "type": "ready" }])).is_none());
        assert_eq!(
            start_outcome(&serde_json::json!([{ "type": "ready", "conversationId": "c-1" }])),
            Some(Ok("c-1".into()))
        );
        assert_eq!(
            start_outcome(
                &serde_json::json!([{ "type": "ready", "conversationId": "c-1" }, { "type": "error", "message": "refused" }])
            ),
            Some(Err("refused".into()))
        );
        assert!(start_outcome(&serde_json::json!([
            { "type": "ready", "conversationId": "c-1" },
            { "type": "closed", "code": 1008 }
        ]))
        .unwrap()
        .is_err());
    }

    #[test]
    fn reports_reject_stale_tokens_and_oversized_batches() {
        let bridge = VoiceBridge::default();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        *bridge.session.lock().unwrap() = Some(Session {
            token: "current".into(),
            starting: Some(tx),
        });
        assert!(!bridge.accept("old", &serde_json::json!([])));
        assert!(!bridge.accept("current", &serde_json::json!({ "type": "ready" })));
        assert!(!bridge.accept(
            "current",
            &serde_json::json!(vec![serde_json::json!({}); 129])
        ));
        assert!(bridge.accept("current", &serde_json::json!([{ "type": "frame" }])));
        bridge.stop();
        assert!(!bridge.accept("current", &serde_json::json!([])));
    }
}
