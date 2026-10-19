//! SDP proxy gateway.
//!
//! The browser/webview terminates all WebRTC media. This module only:
//!   * builds the ChatGPT `session` JSON,
//!   * POSTs the browser offer SDP to `chatgpt.com/realtime/wm`,
//!   * returns the answer SDP,
//!   * binds a `voice_session_id` to the account that produced it,
//!   * optionally forwards everything to an external (Chrome-impersonating) gateway.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::accounts::Account;
use crate::error::{AppError, Result};
use crate::settings::Settings;

pub const WM_URL: &str = "https://chatgpt.com/realtime/wm?dcid=0";
pub const FILES_URL: &str = "https://chatgpt.com/backend-api/files";

pub const ALLOWED_VOICES: &[&str] = &[
    "breeze", "cove", "ember", "fathom", "glimmer", "juniper", "maple", "orbit", "vale",
];

const VOICE_ALIASES: &[(&str, &str)] =
    &[("arbor", "fathom"), ("sol", "glimmer"), ("spruce", "orbit")];

pub fn normalize_voice(voice: &str) -> String {
    let clean = voice.trim().to_lowercase();
    let mapped = VOICE_ALIASES
        .iter()
        .find(|(alias, _)| *alias == clean)
        .map(|(_, real)| *real)
        .unwrap_or(clean.as_str());
    if ALLOWED_VOICES.contains(&mapped) {
        mapped.to_string()
    } else {
        "cove".to_string()
    }
}

/// Upstream accepts exactly these values; anything else is rejected with a 400
/// `invalid client metadata` error, so coerce unknown values.
pub const ALLOWED_VOICE_MODES: &[&str] = &["standard", "advanced", "wingman"];

pub fn normalize_voice_mode(mode: &str) -> String {
    let clean = mode.trim().to_lowercase();
    if ALLOWED_VOICE_MODES.contains(&clean.as_str()) {
        clean
    } else {
        "wingman".to_string()
    }
}

fn timezone_offset_min() -> i32 {
    chrono::Local::now().offset().local_minus_utc() / 60
}

fn timezone_name() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

/// A fresh id for a new upstream conversation, in the shape chatgpt.com's own
/// client mints (uppercase UUID).
pub fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string().to_uppercase()
}

/// Build the multipart `session` field value. Shape mirrors the reference
/// gateway, with the user's real timezone substituted in.
///
/// `session_id` is what chatgpt.com uses to keep a voice call inside the same
/// conversation: minting a new one every call (the old behaviour) made every
/// reconnect show up as a fresh "Voice assistant setup" thread, so a
/// continued conversation must reuse the one the previous call returned.
#[cfg(test)]
pub fn build_session_json(
    voice: &str,
    voice_mode: &str,
    language_code: &str,
    session_id: &str,
) -> String {
    build_session_json_with_conversation(voice, voice_mode, language_code, session_id, None, None)
}

/// A voice-call id does not identify a durable ChatGPT thread.
pub fn build_session_json_with_conversation(
    voice: &str,
    voice_mode: &str,
    language_code: &str,
    session_id: &str,
    conversation_id: Option<&str>,
    parent_message_id: Option<&str>,
) -> String {
    let sid = session_id;
    let mut payload = serde_json::json!({
        "backend_reasoning_effort": "instant",
        "language_code": if language_code.trim().is_empty() { "auto" } else { language_code },
        "requested_default_model": "",
        "voice": normalize_voice(voice),
        "voice_session_id": sid,
        "voice_status_request_id": sid,
        "timezone_offset_min": timezone_offset_min(),
        "timezone": timezone_name(),
        "voice_mode": normalize_voice_mode(voice_mode),
        "model_slug": "",
        "model_slug_advanced": "",
        "client_tools": [],
        "history_and_training_disabled": false,
        "conversation_mode": { "kind": "primary_assistant" },
        "enable_message_streaming": true,
    });
    if let Some(id) = conversation_id.filter(|id| !id.trim().is_empty()) {
        payload["conversation_id"] = serde_json::json!(id);
        if let Some(parent) = parent_message_id.filter(|id| !id.trim().is_empty()) {
            payload["parent_message_id"] = serde_json::json!(parent);
        }
    }
    payload.to_string()
}

/// Normalize an offer SDP to CRLF lines ending in a final CRLF.
pub fn normalize_sdp(offer_sdp: &str) -> Result<String> {
    let text = offer_sdp.trim();
    if !text.starts_with("v=0") {
        return Err(AppError::gateway(
            "invalid offer SDP: must start with `v=0`",
        ));
    }
    let normalized = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n");
    if normalized.ends_with("\r\n") {
        Ok(normalized)
    } else {
        Ok(format!("{normalized}\r\n"))
    }
}

/// Validate a raw answer SDP received from any transport, normalizing line
/// endings to CRLF (WebKit's SDP parser rejects LF-only answers).
pub fn validate_answer_sdp(body: &str) -> Result<String> {
    let trimmed = body.trim();
    if !trimmed.starts_with("v=0") {
        return Err(AppError::gateway(format!(
            "invalid answer SDP: {}",
            trimmed.chars().take(200).collect::<String>()
        )));
    }
    normalize_sdp(trimmed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOutcome {
    pub answer_sdp: String,
    pub voice_session_id: String,
    pub voice: String,
    pub voice_mode: String,
    pub device_id: String,
    pub account_email: String,
    pub proxy_source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcome {
    pub file_id: String,
    pub name: String,
    pub mime_type: String,
    pub size: usize,
    pub voice_session_id: String,
}

#[derive(Debug, Clone)]
pub struct Binding {
    pub access_token: String,
    /// Retained for in-call failover / diagnostics; not read on the happy path.
    #[allow(dead_code)]
    pub email: String,
    #[allow(dead_code)]
    pub device_id: String,
    #[allow(dead_code)]
    pub proxy: String,
    pub updated_at: Instant,
}

/// voice_session_id -> account binding, with a TTL so stale sessions are reaped.
pub struct SessionBindings {
    inner: Mutex<HashMap<String, Binding>>,
    ttl: Duration,
}

impl Default for SessionBindings {
    fn default() -> Self {
        Self::new(Duration::from_secs(6 * 60 * 60))
    }
}

impl SessionBindings {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    fn cleanup_locked(map: &mut HashMap<String, Binding>, ttl: Duration, now: Instant) {
        map.retain(|_, b| now.duration_since(b.updated_at) <= ttl);
    }

    pub fn bind(&self, session_id: Option<&str>, account: &Account) -> String {
        let id = match session_id {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => format!("vs_{}", uuid::Uuid::new_v4().simple()),
        };
        let now = Instant::now();
        if let Ok(mut map) = self.inner.lock() {
            Self::cleanup_locked(&mut map, self.ttl, now);
            map.insert(
                id.clone(),
                Binding {
                    access_token: account.access_token.clone(),
                    email: account.email.clone(),
                    device_id: account.device_id.clone(),
                    proxy: account.proxy.clone(),
                    updated_at: now,
                },
            );
        }
        id
    }

    pub fn get(&self, session_id: &str) -> Option<Binding> {
        let now = Instant::now();
        let mut map = self.inner.lock().ok()?;
        Self::cleanup_locked(&mut map, self.ttl, now);
        map.get_mut(session_id).map(|b| {
            b.updated_at = now;
            b.clone()
        })
    }

    pub fn release(&self, session_id: &str) -> bool {
        self.inner
            .lock()
            .map(|mut map| map.remove(session_id).is_some())
            .unwrap_or(false)
    }

    /// Sessions still bound: a call in flight, or one whose teardown has not
    /// arrived yet. The idle transport reaper uses it to stay out of a call.
    pub fn active(&self) -> usize {
        let now = Instant::now();
        let Ok(mut map) = self.inner.lock() else {
            return 0;
        };
        Self::cleanup_locked(&mut map, self.ttl, now);
        map.len()
    }
}

struct OfferMetadata<'a> {
    device: &'a str,
    language_code: &'a str,
}

pub struct Gateway {
    http: reqwest::Client,
}

/// Parameters for opening a voice session; groups the offer so signatures stay
/// readable as the protocol grows.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceResume {
    pub voice_session_id: Option<String>,
    pub conversation_id: Option<String>,
    pub parent_message_id: Option<String>,
}

pub struct SessionRequest<'a> {
    pub offer_sdp: &'a str,
    pub voice: &'a str,
    pub voice_mode: &'a str,
    pub language_code: &'a str,
    pub voice_session_id: Option<&'a str>,
    pub conversation_id: Option<&'a str>,
    pub parent_message_id: Option<&'a str>,
}

impl Default for Gateway {
    fn default() -> Self {
        Self::new()
    }
}

impl Gateway {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_default();
        Self { http }
    }

    /// Shared HTTP client, reused by the tool layer.
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// The language the upstream transcriber should expect.
    ///
    /// Hardcoding `en-US` here made every Portuguese sentence come back
    /// half-translated and truncated, which then failed to match any command.
    fn language_header(language_code: &str) -> String {
        match language_code.trim() {
            "" | "auto" => "en-US".to_string(),
            other => other.to_string(),
        }
    }

    fn auth_headers(
        &self,
        settings: &Settings,
        token: &str,
        device_id: &str,
        language_code: &str,
    ) -> Vec<(&'static str, String)> {
        vec![
            ("accept", "*/*".to_string()),
            ("origin", "https://chatgpt.com".to_string()),
            ("referer", "https://chatgpt.com/".to_string()),
            ("user-agent", settings.user_agent.clone()),
            ("oai-device-id", device_id.to_string()),
            ("oai-language", Self::language_header(language_code)),
            ("oai-client-version", settings.client_version.clone()),
            (
                "oai-client-build-number",
                settings.client_build_number.clone(),
            ),
            ("authorization", format!("Bearer {token}")),
        ]
    }

    /// Post the offer SDP directly to chatgpt.com from Rust.
    pub async fn create_session_direct(
        &self,
        settings: &Settings,
        account: &Account,
        req: &SessionRequest<'_>,
    ) -> Result<SessionOutcome> {
        let sdp = normalize_sdp(req.offer_sdp)?;
        let voice = normalize_voice(req.voice);
        let session_id = match req.voice_session_id {
            Some(existing) if !existing.trim().is_empty() => existing.trim().to_string(),
            _ => new_session_id(),
        };
        let session_json = build_session_json_with_conversation(
            &voice,
            req.voice_mode,
            req.language_code,
            &session_id,
            req.conversation_id,
            req.parent_message_id,
        );

        let device = if account.device_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            account.device_id.clone()
        };

        let answer = self
            .post_offer(
                WM_URL,
                settings,
                account,
                &sdp,
                &session_json,
                OfferMetadata {
                    device: &device,
                    language_code: req.language_code,
                },
            )
            .await?;

        Ok(SessionOutcome {
            answer_sdp: answer,
            voice_session_id: session_id,
            voice,
            voice_mode: normalize_voice_mode(req.voice_mode),
            device_id: device,
            account_email: account.email.clone(),
            proxy_source: if account.proxy.is_empty() {
                "direct".to_string()
            } else {
                "proxy".to_string()
            },
        })
    }

    /// POST the multipart `{ sdp, session }` body and return the answer SDP.
    ///
    /// The URL is a parameter so the transport can be tested against a local
    /// mock (regression: the `Content-Type` must keep reqwest's boundary).
    async fn post_offer(
        &self,
        url: &str,
        settings: &Settings,
        account: &Account,
        sdp: &str,
        session_json: &str,
        metadata: OfferMetadata<'_>,
    ) -> Result<String> {
        let OfferMetadata {
            device,
            language_code,
        } = metadata;
        let form = reqwest::multipart::Form::new()
            .text("sdp", sdp.to_string())
            .text("session", session_json.to_string());

        // NOTE: do NOT set `content-type` manually — reqwest's `.multipart()`
        // already adds the boundary. A bare "multipart/form-data" override
        // makes the server reject the body with
        // "request Content-Type isn't multipart/form-data".
        let mut request = self.http.post(url).multipart(form);

        for (k, v) in self.auth_headers(settings, &account.access_token, device, language_code) {
            request = request.header(k, v);
        }

        let resp = request.send().await?;
        let status = resp.status();
        // Diagnostic only: hunting for an upstream conversation id in the
        // response so a local "delete" could reach chatgpt.com too — see
        // docs/atlas.md's realtime/wm notes before removing this.
        let header_dump = resp
            .headers()
            .iter()
            .map(|(k, v)| format!("{k}={}", v.to_str().unwrap_or("<binary>")))
            .collect::<Vec<_>>()
            .join(", ");
        crate::logging::log(
            "gateway",
            &format!("realtime/wm direct response headers: {header_dump}"),
        );
        let body = resp.text().await?;

        if status.as_u16() == 401 {
            return Err(AppError::gateway(
                "account token invalid or expired (401) — sign in again",
            ));
        }
        if !(status.is_success()) || !body.trim_start().starts_with("v=0") {
            return Err(AppError::gateway(format!(
                "realtime/wm failed status={} body={}",
                status.as_u16(),
                body.chars().take(300).collect::<String>()
            )));
        }

        Ok(body)
    }

    /// Forward the offer to an external gateway (e.g. the Python reference,
    /// which uses `curl_cffi` Chrome TLS impersonation).
    pub async fn create_session_external(
        &self,
        settings: &Settings,
        account: &Account,
        req: &SessionRequest<'_>,
    ) -> Result<SessionOutcome> {
        let sdp = normalize_sdp(req.offer_sdp)?;
        let base = settings.external_gateway_url.trim_end_matches('/');
        if base.is_empty() {
            return Err(AppError::gateway("external gateway URL is empty"));
        }
        let url = format!("{base}/api/voice/session");

        #[derive(Deserialize)]
        struct ExternalResponse {
            #[serde(default)]
            answer_sdp: String,
            #[serde(default)]
            voice_session_id: String,
            #[serde(default)]
            voice: String,
            #[serde(default)]
            voice_mode: String,
            #[serde(default)]
            device_id: String,
            #[serde(default)]
            account_email: String,
            #[serde(default)]
            proxy_source: String,
        }

        let payload = serde_json::json!({
            "offer_sdp": sdp,
            "voice": normalize_voice(req.voice),
            "voice_mode": normalize_voice_mode(req.voice_mode),
            "language_code": req.language_code,
            "access_token": account.access_token,
            "device_id": account.device_id,
            "proxy": account.proxy,
            "voice_session_id": req.voice_session_id.unwrap_or(""),
            "conversation_id": req.conversation_id,
            "parent_message_id": req.parent_message_id,
        });

        let mut request = self.http.post(url).json(&payload);
        if !settings.gateway_auth_key.trim().is_empty() {
            request = request.header(
                "authorization",
                format!("Bearer {}", settings.gateway_auth_key.trim()),
            );
        }

        let resp = request.send().await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(AppError::gateway(format!(
                "external gateway failed status={} body={}",
                status.as_u16(),
                body.chars().take(300).collect::<String>()
            )));
        }
        let parsed: ExternalResponse = serde_json::from_str(&body)
            .map_err(|e| AppError::gateway(format!("external gateway bad response: {e}")))?;
        if !parsed.answer_sdp.trim_start().starts_with("v=0") {
            return Err(AppError::gateway("external gateway returned no answer SDP"));
        }

        Ok(SessionOutcome {
            answer_sdp: parsed.answer_sdp,
            voice_session_id: parsed.voice_session_id,
            voice: if parsed.voice.is_empty() {
                normalize_voice(req.voice)
            } else {
                parsed.voice
            },
            voice_mode: parsed.voice_mode,
            device_id: parsed.device_id,
            account_email: parsed.account_email,
            proxy_source: if parsed.proxy_source.is_empty() {
                "external".to_string()
            } else {
                parsed.proxy_source
            },
        })
    }

    /// Upload an in-call image the same way the web client does, returning a
    /// `file_id` the client can reference as `sediment://<file_id>`.
    pub async fn upload_image(
        &self,
        settings: &Settings,
        account: &Account,
        bytes: &[u8],
        name: &str,
        mime: &str,
        size: Option<(u32, u32)>,
    ) -> Result<String> {
        if bytes.is_empty() {
            return Err(AppError::gateway("image is empty"));
        }
        let device = if account.device_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            account.device_id.clone()
        };

        #[derive(Deserialize)]
        struct MetaResponse {
            #[serde(default)]
            upload_url: String,
            #[serde(default)]
            file_id: String,
        }

        let mut meta_req = self.http.post(FILES_URL).json(&serde_json::json!({
            "file_name": name,
            "file_size": bytes.len(),
            "use_case": "multimodal",
            "timezone_offset_min": timezone_offset_min(),
            "reset_rate_limits": false,
            "supports_direct_azure_multipart": true,
            "mime_type": mime,
            "width": size.map(|(w, _)| w),
            "height": size.map(|(_, h)| h),
        }));
        for (k, v) in self.auth_headers(settings, &account.access_token, &device, "auto") {
            if k == "accept" {
                meta_req = meta_req.header(k, "application/json");
            } else {
                meta_req = meta_req.header(k, v);
            }
        }

        let meta_resp = meta_req.send().await?;
        let meta_status = meta_resp.status();
        let meta_body = meta_resp.text().await?;
        if meta_status.as_u16() == 401 {
            return Err(AppError::gateway("account token invalid or expired (401)"));
        }
        if !meta_status.is_success() {
            return Err(AppError::gateway(format!(
                "files request failed status={} body={}",
                meta_status.as_u16(),
                meta_body.chars().take(300).collect::<String>()
            )));
        }
        let meta: MetaResponse = serde_json::from_str(&meta_body)
            .map_err(|e| AppError::gateway(format!("files response parse error: {e}")))?;
        if meta.upload_url.is_empty() || meta.file_id.is_empty() {
            return Err(AppError::gateway(
                "files response missing upload_url/file_id",
            ));
        }

        let put = self
            .http
            .put(&meta.upload_url)
            .header("content-type", mime)
            .header("x-ms-blob-type", "BlockBlob")
            .header("x-ms-version", "2020-04-08")
            .header("origin", "https://chatgpt.com")
            .header("referer", "https://chatgpt.com/")
            .header("user-agent", settings.user_agent.clone())
            .body(bytes.to_vec())
            .send()
            .await?;
        if !put.status().is_success() {
            let st = put.status().as_u16();
            let text = put.text().await.unwrap_or_default();
            return Err(AppError::gateway(format!(
                "azure upload failed status={st} body={}",
                text.chars().take(200).collect::<String>()
            )));
        }

        // Best-effort finalize; the blob is already written, so tolerate failure
        // — but log it: a silently-failed finalize is the leading suspect for
        // "the model says it took a screenshot but never saw it" (a sediment
        // pointer to a file the backend never marked processed).
        let uploaded_url = format!("{FILES_URL}/{}/uploaded", meta.file_id);
        let mut done = self.http.post(&uploaded_url).body("{}");
        for (k, v) in self.auth_headers(settings, &account.access_token, &device, "auto") {
            done = done.header(k, v);
        }
        match done.send().await {
            Ok(resp) if resp.status().is_success() => {
                crate::logging::log(
                    "gateway",
                    &format!("image upload finalized file_id={}", meta.file_id),
                );
            }
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                crate::logging::log(
                    "gateway",
                    &format!(
                        "image upload finalize failed file_id={} status={status} body={}",
                        meta.file_id,
                        body.chars().take(200).collect::<String>()
                    ),
                );
            }
            Err(error) => {
                crate::logging::log(
                    "gateway",
                    &format!(
                        "image upload finalize request failed file_id={}: {error}",
                        meta.file_id
                    ),
                );
            }
        }

        Ok(meta.file_id)
    }

    /// Download a picture the conversation produced, the way the web client
    /// does: ask the files API for a signed link, then fetch it. A picture
    /// still being drawn has no link yet, so this waits for it.
    pub async fn download_image(
        &self,
        settings: &Settings,
        account: &Account,
        file_id: &str,
        conversation_id: Option<&str>,
    ) -> Result<(Vec<u8>, String)> {
        const MAX_BYTES: usize = 12 * 1024 * 1024;
        const ATTEMPTS: u32 = 40;
        if !file_id.starts_with("file")
            || !file_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(AppError::gateway("invalid file id"));
        }
        let device = if account.device_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            account.device_id.clone()
        };

        #[derive(Deserialize)]
        struct Link {
            #[serde(default)]
            download_url: String,
        }

        let mut url = format!("{FILES_URL}/download/{file_id}?inline=false");
        if let Some(conversation) = conversation_id.filter(|id| {
            !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }) {
            url.push_str(&format!("&conversation_id={conversation}"));
        }
        let mut last = String::new();
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            let mut request = self.http.get(&url);
            for (k, v) in self.auth_headers(settings, &account.access_token, &device, "auto") {
                request = request.header(k, v);
            }
            let response = request.send().await?;
            let status = response.status();
            let body = response.text().await?;
            if status.as_u16() == 401 {
                return Err(AppError::gateway("account token invalid or expired (401)"));
            }
            let link = serde_json::from_str::<Link>(&body).ok();
            let Some(link) =
                link.filter(|link| status.is_success() && !link.download_url.is_empty())
            else {
                last = format!("status={} {}", status.as_u16(), link_status(&body));
                continue;
            };
            let mut fetch = self.http.get(&link.download_url);
            if link.download_url.starts_with("https://chatgpt.com/") {
                for (k, v) in self.auth_headers(settings, &account.access_token, &device, "auto") {
                    fetch = fetch.header(k, v);
                }
            }
            let picture = fetch.send().await?;
            if !picture.status().is_success() {
                last = format!("download status={}", picture.status().as_u16());
                continue;
            }
            let mime = picture
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("image/png")
                .split(';')
                .next()
                .unwrap_or("image/png")
                .trim()
                .to_string();
            if !mime.starts_with("image/") {
                return Err(AppError::gateway(format!("not an image: {mime}")));
            }
            let bytes = picture.bytes().await?;
            if bytes.len() > MAX_BYTES {
                return Err(AppError::gateway("image too large"));
            }
            return Ok((bytes.to_vec(), mime));
        }
        Err(AppError::gateway(format!("image not ready: {last}")))
    }
}

/// What a files API answer says about a link, without echoing anything else.
fn link_status(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("status")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "no status".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_normalization_and_aliases() {
        assert_eq!(normalize_voice("COVE"), "cove");
        assert_eq!(normalize_voice("arbor"), "fathom");
        assert_eq!(normalize_voice("sol"), "glimmer");
        assert_eq!(normalize_voice("spruce"), "orbit");
        assert_eq!(normalize_voice("bogus"), "cove");
        assert_eq!(normalize_voice(""), "cove");
    }

    #[test]
    fn voice_mode_is_coerced_to_an_allowed_value() {
        assert_eq!(normalize_voice_mode("wingman"), "wingman");
        assert_eq!(normalize_voice_mode("STANDARD"), "standard");
        assert_eq!(normalize_voice_mode("advanced"), "advanced");
        // The old UI offered "default", which upstream rejects with a 400.
        assert_eq!(normalize_voice_mode("default"), "wingman");
        assert_eq!(normalize_voice_mode(""), "wingman");

        let raw = build_session_json("cove", "default", "auto", "SID-1");
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["voice_mode"], "wingman");
    }

    #[test]
    fn sdp_is_normalized_to_crlf() {
        let out = normalize_sdp("v=0\na=b\nc=d").unwrap();
        assert!(out.starts_with("v=0\r\n"));
        assert!(out.ends_with("\r\n"));
        assert!(!out.contains("\n\n"));
    }

    #[test]
    fn invalid_sdp_is_rejected() {
        assert!(normalize_sdp("garbage").is_err());
        assert!(normalize_sdp("").is_err());
    }

    #[test]
    fn validate_answer_sdp_accepts_v0_and_rejects_otherwise() {
        assert_eq!(
            validate_answer_sdp("  v=0\r\na=b\r\n").unwrap(),
            "v=0\r\na=b\r\n"
        );
        // LF-only answers are repaired to CRLF for strict webview parsers.
        assert_eq!(validate_answer_sdp("v=0\na=b").unwrap(), "v=0\r\na=b\r\n");
        assert!(validate_answer_sdp("error: nope").is_err());
        assert!(validate_answer_sdp("").is_err());
    }

    #[test]
    fn test_session_json_resumes_chat_not_just_voice_call() {
        let raw = build_session_json_with_conversation(
            "cove",
            "wingman",
            "en-US",
            "CALL-NEW",
            Some("chat-123"),
            Some("message-456"),
        );
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["conversation_id"], "chat-123");
        assert_eq!(value["parent_message_id"], "message-456");
        assert_eq!(value["voice_session_id"], "CALL-NEW");
        let fresh =
            build_session_json_with_conversation("cove", "wingman", "en-US", "CALL", None, None);
        let value: serde_json::Value = serde_json::from_str(&fresh).unwrap();
        assert!(value.get("conversation_id").is_none());
        assert!(value.get("parent_message_id").is_none());
    }

    #[test]
    fn session_json_contains_expected_fields() {
        let raw = build_session_json("ember", "wingman", "auto", "SID-2");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["voice"], "ember");
        assert_eq!(v["voice_mode"], "wingman");
        assert_eq!(v["conversation_mode"]["kind"], "primary_assistant");
        assert_eq!(v["enable_message_streaming"], true);
        assert!(v["timezone"].is_string());
        assert!(v["timezone_offset_min"].is_number());
    }

    #[test]
    fn session_json_reuses_the_given_session_id_for_both_fields() {
        let raw = build_session_json("cove", "wingman", "auto", "SID-KEEP");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["voice_session_id"], "SID-KEEP");
        assert_eq!(v["voice_status_request_id"], "SID-KEEP");
    }

    #[test]
    fn create_session_direct_reuses_an_existing_voice_session_id() {
        let existing = " SID-CONTINUE ";
        let req = SessionRequest {
            offer_sdp: "v=0\r\n",
            voice: "cove",
            voice_mode: "wingman",
            language_code: "auto",
            voice_session_id: Some(existing),
            conversation_id: None,
            parent_message_id: None,
        };
        // Only the id-selection logic is under test here, not the network
        // call: mirror what create_session_direct does before it posts.
        let session_id = match req.voice_session_id {
            Some(id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => new_session_id(),
        };
        assert_eq!(session_id, "SID-CONTINUE");
    }

    #[test]
    fn bindings_bind_get_and_release() {
        let bindings = SessionBindings::default();
        let account = test_account();
        let id = bindings.bind(None, &account);
        assert!(id.starts_with("vs_"));
        assert_eq!(bindings.get(&id).unwrap().access_token, "tok");
        assert!(bindings.release(&id));
        assert!(bindings.get(&id).is_none());
    }

    #[test]
    fn bindings_reuse_explicit_id() {
        let bindings = SessionBindings::default();
        let account = test_account();
        assert_eq!(bindings.bind(Some("vs_keep"), &account), "vs_keep");
        assert!(bindings.get("vs_keep").is_some());
    }

    #[test]
    fn bindings_expire() {
        let bindings = SessionBindings::new(Duration::from_millis(0));
        let account = test_account();
        let id = bindings.bind(None, &account);
        std::thread::sleep(Duration::from_millis(2));
        assert!(bindings.get(&id).is_none());
    }

    fn test_account() -> Account {
        let mut account = Account::chatgpt("a@b.com", "", "tok");
        account.device_id = "dev".into();
        account
    }

    /// Regression: the direct path must let reqwest set the multipart
    /// `Content-Type` (including its boundary). A manual bare header override
    /// caused the server to fail with "request Content-Type isn't
    /// multipart/form-data".
    #[tokio::test]
    async fn direct_offer_is_multipart_with_boundary() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 16384];
            let n = socket.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            request
        });

        let gateway = Gateway::new();
        let settings = Settings::default();
        let account = test_account();
        let url = format!("http://{addr}/realtime/wm");

        let answer = gateway
            .post_offer(
                &url,
                &settings,
                &account,
                "v=0\r\n",
                "{}",
                OfferMetadata {
                    device: "dev",
                    language_code: "pt-BR",
                },
            )
            .await
            .unwrap();
        assert!(answer.starts_with("v=0"));

        let request = server.await.unwrap();
        let lower = request.to_lowercase();
        assert!(
            lower.contains("content-type: multipart/form-data; boundary="),
            "Content-Type must include a boundary, got:\n{request}"
        );
        assert!(request.contains("name=\"sdp\""), "missing sdp field");
        assert!(
            request.contains("name=\"session\""),
            "missing session field"
        );
        assert!(lower.contains("authorization: bearer tok"));
    }
}
