//! Generic voice-session adapter for the private browser/audio broker.
//!
//! Provider credentials enter this module from the Rust account store and only
//! leave through the daemon's private broker client. Management callers receive
//! the credential-free status and bounded caption events below.

use anyhow::{ensure, Context};
use lilo_core::accounts::Account;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::broker::BrokerClient;

const MAX_PROVIDERS: usize = 32;
const MAX_EVENTS: usize = 64;
const MAX_CAPTION_BYTES: usize = 4096;
const MAX_ID_BYTES: usize = 256;
const MAX_PROVIDER_BYTES: usize = 128;
const MAX_EMAIL_BYTES: usize = 320;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceState {
    Idle,
    Starting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceSpeaker {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceEvent {
    pub sequence: u64,
    pub speaker: VoiceSpeaker,
    pub text: String,
    #[serde(rename = "final")]
    pub final_: bool,
    #[serde(default)]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceStatus {
    pub state: VoiceState,
    pub muted: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub account_email: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub events: Vec<VoiceEvent>,
}

impl Default for VoiceStatus {
    fn default() -> Self {
        Self {
            state: VoiceState::Idle,
            muted: false,
            session_id: None,
            provider_id: None,
            account_email: None,
            error: None,
            events: Vec::new(),
        }
    }
}

/// The one active broker session owned by the daemon process.
pub struct VoiceSession {
    client: BrokerClient,
    providers: Vec<String>,
    status: VoiceStatus,
    last_sequence: u64,
    heartbeat: Option<tokio::task::JoinHandle<()>>,
}

impl VoiceSession {
    pub fn new(client: BrokerClient, providers: Vec<String>) -> Self {
        Self {
            client,
            providers,
            status: VoiceStatus::default(),
            last_sequence: 0,
            heartbeat: None,
        }
    }

    pub fn providers(&self) -> &[String] {
        &self.providers
    }

    pub fn status(&self) -> &VoiceStatus {
        &self.status
    }

    pub async fn start(
        &mut self,
        account: &Account,
        voice: &str,
        voice_mode: &str,
        language: &str,
        prompt: &str,
        directive: &str,
    ) -> anyhow::Result<VoiceStatus> {
        ensure!(
            self.providers.len() <= MAX_PROVIDERS
                && self.providers.iter().all(|provider| {
                    !provider.trim().is_empty() && provider.len() <= MAX_PROVIDER_BYTES
                }),
            "Voice provider list is invalid."
        );
        ensure!(
            self.providers
                .iter()
                .any(|provider| provider == &account.provider),
            "Voice provider is unavailable."
        );
        ensure!(account.status == "ok", "Selected account is unavailable.");
        ensure!(
            !account.email.trim().is_empty() && account.email.len() <= MAX_EMAIL_BYTES,
            "Invalid account identity."
        );
        ensure!(
            !account.access_token.is_empty() || !account.session_cookie.is_empty(),
            "Selected account has no voice credentials."
        );
        ensure!(
            !voice.trim().is_empty() && voice.len() <= 64,
            "Invalid voice option."
        );
        ensure!(
            !language.trim().is_empty() && language.len() <= 64,
            "Invalid voice language."
        );
        ensure!(prompt.len() <= 8192, "Voice instructions are too long.");
        ensure!(
            directive.len() <= 8192,
            "Voice language instructions are too long."
        );
        ensure!(
            prompt.len() + directive.len() <= 8192,
            "Combined voice instructions are too long."
        );

        self.last_sequence = 0;
        self.stop_heartbeat();
        self.status = VoiceStatus {
            state: VoiceState::Starting,
            muted: false,
            provider_id: Some(account.provider.clone()),
            account_email: Some(account.email.clone()),
            ..VoiceStatus::default()
        };
        // This is the only path carrying credentials. The mobile management
        // response is always decoded through the strict public VoiceStatus.
        let body = json!({
            "action": "start",
            "providerId": &account.provider,
            "account": {
                "accessToken": &account.access_token,
                "sessionCookie": &account.session_cookie,
                "deviceId": &account.device_id,
            },
            "options": {
                "voice": voice,
                "voiceMode": voice_mode,
                "languageCode": language,
                "prompt": prompt,
                "directive": directive,
            },
        });
        let value = match self.client.post("/voice", &body).await {
            Ok(value) => value,
            Err(error) => {
                self.status.state = VoiceState::Error;
                self.status.error = Some("Voice could not start on the device.".into());
                return Err(error).context("Could not start daemon voice.");
            }
        };
        self.accept_status(value)
    }

    pub async fn stop(&mut self) -> anyhow::Result<VoiceStatus> {
        self.stop_heartbeat();
        self.command("stop", json!({})).await
    }

    pub async fn mute(&mut self, muted: bool) -> anyhow::Result<VoiceStatus> {
        self.command("mute", json!({ "muted": muted })).await
    }

    pub async fn interrupt(&mut self) -> anyhow::Result<VoiceStatus> {
        self.command("interrupt", json!({})).await
    }

    pub async fn text(&mut self, text: &str) -> anyhow::Result<VoiceStatus> {
        ensure!(
            !text.trim().is_empty() && text.len() <= MAX_CAPTION_BYTES,
            "Invalid voice text."
        );
        self.command("text", json!({ "text": text })).await
    }

    pub(crate) async fn context(&mut self, text: &str) -> anyhow::Result<VoiceStatus> {
        ensure!(
            !text.trim().is_empty() && text.len() <= 65536,
            "Invalid voice context."
        );
        self.command("text", json!({ "text": text, "hidden": true }))
            .await
    }

    pub async fn poll(&mut self) -> anyhow::Result<Vec<VoiceEvent>> {
        if matches!(self.status.state, VoiceState::Idle | VoiceState::Error) {
            return Ok(Vec::new());
        }
        let result = async {
            let value = self
                .client
                .post("/voice", &json!({ "action": "status" }))
                .await?;
            let status = parse_status(value)?;
            ensure!(
                status.events.len() <= MAX_EVENTS,
                "Voice event batch is too large."
            );
            let events = filter_new_events(&mut self.last_sequence, status.events.clone());
            self.status = status;
            self.sync_heartbeat();
            Ok::<_, anyhow::Error>(events)
        }
        .await;
        match result {
            Ok(events) => Ok(events),
            Err(error) => {
                self.status.state = VoiceState::Error;
                self.status.error = Some("Voice status is unavailable on the device.".into());
                self.stop_heartbeat();
                Err(error).context("Could not read daemon voice status.")
            }
        }
    }

    async fn command(&mut self, action: &str, extra: Value) -> anyhow::Result<VoiceStatus> {
        let mut body = extra.as_object().cloned().unwrap_or_default();
        body.insert("action".into(), Value::String(action.into()));
        let value = self.client.post("/voice", &Value::Object(body)).await?;
        self.accept_status(value)
    }

    fn accept_status(&mut self, value: Value) -> anyhow::Result<VoiceStatus> {
        let mut status = parse_status(value)?;
        // Broker diagnostics can contain URLs or provider response text. Expose
        // a stable generic error to the phone, never broker response details.
        if status.error.is_some() {
            status.error = Some("Voice could not continue on the device.".into());
        }
        self.status = status.clone();
        self.sync_heartbeat();
        Ok(status)
    }

    /// Slow local tools must not expire the broker's microphone ownership lease.
    fn sync_heartbeat(&mut self) {
        if self.status.state != VoiceState::Connected {
            self.stop_heartbeat();
        } else if self.heartbeat.is_none() {
            let client = self.client.clone();
            self.heartbeat = Some(tokio::spawn(async move {
                let period = std::time::Duration::from_secs(5);
                let mut timer =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    timer.tick().await;
                    if client
                        .post("/voice", &json!({"action":"heartbeat"}))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }));
        }
    }

    fn stop_heartbeat(&mut self) {
        if let Some(task) = self.heartbeat.take() {
            task.abort();
        }
    }
}

impl Drop for VoiceSession {
    fn drop(&mut self) {
        self.stop_heartbeat();
    }
}

fn parse_status(value: Value) -> anyhow::Result<VoiceStatus> {
    let mut status: VoiceStatus = serde_json::from_value(value).context("Invalid voice status.")?;
    ensure!(
        status.events.len() <= MAX_EVENTS,
        "Voice event batch is too large."
    );
    if let Some(session_id) = &status.session_id {
        ensure!(
            !session_id.is_empty() && session_id.len() <= MAX_ID_BYTES,
            "Invalid voice session id."
        );
    }
    if let Some(provider_id) = &status.provider_id {
        ensure!(
            !provider_id.is_empty() && provider_id.len() <= MAX_PROVIDER_BYTES,
            "Invalid voice provider id."
        );
    }
    if let Some(email) = &status.account_email {
        ensure!(
            !email.is_empty() && email.len() <= MAX_EMAIL_BYTES,
            "Invalid voice account identity."
        );
    }
    if let Some(error) = &status.error {
        ensure!(error.len() <= 1024, "Voice error is too large.");
    }
    for event in &status.events {
        ensure!(event.sequence > 0, "Invalid voice event sequence.");
        ensure!(
            !event.text.trim().is_empty() && event.text.len() <= MAX_CAPTION_BYTES,
            "Invalid voice caption."
        );
        if let Some(turn_id) = &event.turn_id {
            ensure!(
                !turn_id.is_empty() && turn_id.len() <= MAX_ID_BYTES,
                "Invalid voice turn id."
            );
        }
    }
    // Keep the wire parser strict, then discard all raw broker error text.
    if status.error.is_some() {
        status.error = Some("Voice could not continue on the device.".into());
    }
    Ok(status)
}

fn filter_new_events(last_sequence: &mut u64, mut events: Vec<VoiceEvent>) -> Vec<VoiceEvent> {
    events.retain(|event| event.sequence > *last_sequence);
    events.sort_by_key(|event| event.sequence);
    events.dedup_by_key(|event| event.sequence);
    if let Some(last) = events.last() {
        *last_sequence = last.sequence;
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::thread;

    fn event(sequence: u64) -> VoiceEvent {
        VoiceEvent {
            sequence,
            speaker: VoiceSpeaker::User,
            text: format!("caption {sequence}"),
            final_: true,
            turn_id: Some(format!("turn-{sequence}")),
        }
    }

    #[test]
    fn status_contract_is_strict_and_never_forwards_broker_error_text() {
        let status = parse_status(json!({
            "state": "error", "muted": false, "error": "https://provider.invalid/private?token=secret", "events": []
        }))
        .unwrap();
        assert_eq!(
            status.error.as_deref(),
            Some("Voice could not continue on the device.")
        );
        assert!(serde_json::to_string(&status)
            .unwrap()
            .find("secret")
            .is_none());
        assert!(parse_status(
            json!({ "state": "connected", "muted": false, "events": [], "accessToken": "private" })
        )
        .is_err());
        assert!(
            parse_status(json!({ "state": "connecting", "muted": false, "events": [] })).is_err()
        );
    }

    #[test]
    fn voice_events_are_bounded_and_require_safe_public_fields() {
        assert!(parse_status(json!({
            "state": "connected", "muted": false,
            "events": [{"sequence":1,"speaker":"user","text":"","final":true}]
        }))
        .is_err());
        assert!(parse_status(json!({
            "state": "connected", "muted": false,
            "events": [{"sequence":1,"speaker":"system","text":"hidden","final":true}]
        }))
        .is_err());
        let events = (1..=MAX_EVENTS + 1)
            .map(|sequence| event(sequence as u64))
            .collect::<Vec<_>>();
        let value = serde_json::to_value(VoiceStatus {
            events,
            ..VoiceStatus::default()
        })
        .unwrap();
        assert!(parse_status(value).is_err());
    }

    #[test]
    fn event_cursor_sorts_and_discards_duplicate_or_old_sequences() {
        let mut cursor = 3;
        let events = filter_new_events(&mut cursor, vec![event(5), event(2), event(4), event(5)]);
        assert_eq!(
            events.iter().map(|item| item.sequence).collect::<Vec<_>>(),
            vec![4, 5]
        );
        assert_eq!(cursor, 5);
        assert!(filter_new_events(&mut cursor, vec![event(4), event(5)]).is_empty());
    }

    #[tokio::test]
    async fn private_http_voice_port_sends_only_broker_credentials_and_filters_replayed_captions() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let data_dir =
            std::env::temp_dir().join(format!("lilo-voice-broker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).unwrap();
        let token_path = data_dir.join("token");
        std::fs::write(&token_path, "a".repeat(64)).unwrap();
        let broker = BrokerClient::connect(&format!("http://{address}"), &token_path).unwrap();
        let worker = thread::spawn(move || {
            for index in 0..4 {
                let mut request = server.recv().unwrap();
                assert_eq!(request.url(), "/voice");
                assert_eq!(
                    request
                        .headers()
                        .iter()
                        .find(|header| header
                            .field
                            .as_str()
                            .as_str()
                            .eq_ignore_ascii_case("X-Lilo-Browser-Token"))
                        .unwrap()
                        .value
                        .as_str(),
                    "a".repeat(64)
                );
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                let body: Value = serde_json::from_str(&body).unwrap();
                if index == 0 {
                    assert_eq!(body["action"], "start");
                    assert_eq!(body["providerId"], "chatgpt-web");
                    assert_eq!(body["options"]["languageCode"], "en-US");
                    assert_eq!(body["options"]["prompt"], "private prompt");
                    assert_eq!(body["options"]["directive"], "private directive");
                    let mut keys = body["account"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>();
                    keys.sort();
                    assert_eq!(keys, vec!["accessToken", "deviceId", "sessionCookie"]);
                    assert!(body.get("email").is_none());
                } else if index == 1 {
                    assert_eq!(
                        body,
                        json!({ "action": "text", "text": "hidden context", "hidden": true })
                    );
                } else {
                    assert_eq!(body, json!({ "action": "status" }));
                }
                let events = match index {
                    0 | 1 => vec![event(1)],
                    2 => vec![event(1), event(2)],
                    3 => vec![event(1), event(2), event(3)],
                    _ => Vec::new(),
                };
                let status = VoiceStatus {
                    state: if index == 0 {
                        VoiceState::Starting
                    } else {
                        VoiceState::Connected
                    },
                    muted: false,
                    session_id: Some("session-1".into()),
                    provider_id: Some("chatgpt-web".into()),
                    account_email: Some("fixture@example.invalid".into()),
                    error: None,
                    events,
                };
                let response =
                    tiny_http::Response::from_string(serde_json::to_string(&status).unwrap());
                request.respond(response).unwrap();
            }
        });

        let mut voice = VoiceSession::new(broker, vec!["chatgpt-web".into()]);
        let mut account =
            Account::chatgpt("fixture@example.invalid", "Fixture", "private-access-token");
        account.session_cookie = "private-session-cookie".into();
        account.device_id = "private-device-id".into();
        voice
            .start(
                &account,
                "cove",
                "wingman",
                "en-US",
                "private prompt",
                "private directive",
            )
            .await
            .unwrap();
        assert_eq!(
            voice
                .status()
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1]
        );
        voice.context("hidden context").await.unwrap();
        assert_eq!(
            voice
                .status()
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(
            voice
                .poll()
                .await
                .unwrap()
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(
            voice
                .status()
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(
            voice
                .poll()
                .await
                .unwrap()
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![3]
        );
        assert_eq!(
            voice
                .status()
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(voice.status().state, VoiceState::Connected);
        worker.join().unwrap();
        std::fs::remove_dir_all(data_dir).unwrap();
    }
}
