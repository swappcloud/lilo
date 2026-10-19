//! Public, read-only session metadata shared with explicitly authorized plugins.

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    #[default]
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InboundCapabilities {
    pub user_text: bool,
    pub assistant_text: bool,
    pub native_tool_calls: bool,
    pub images: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboundCapabilities {
    pub text: bool,
    pub stop_speaking: bool,
    pub system_prompt: bool,
    pub tool_result: bool,
    pub image: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolCapabilities {
    pub inbound: InboundCapabilities,
    pub outbound: OutboundCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionContext {
    #[serde(default)]
    pub support_language: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub state: SessionState,
    #[serde(default)]
    pub provider: Option<ProtocolCapabilities>,
    #[serde(default = "platform")]
    pub platform: String,
}
fn platform() -> String {
    std::env::consts::OS.into()
}
impl Default for SessionContext {
    fn default() -> Self {
        Self {
            support_language: None,
            session_id: None,
            state: SessionState::Idle,
            provider: None,
            platform: platform(),
        }
    }
}
impl SessionContext {
    pub fn parse(value: Value) -> Result<Self> {
        let mut context: Self = serde_json::from_value(value)
            .map_err(|_| AppError::other("Invalid public session context."))?;
        if context.support_language.as_ref().is_some_and(|language| {
            language.is_empty()
                || language.len() > 64
                || !language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        }) || context.session_id.as_ref().is_some_and(|id| {
            id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        }) {
            return Err(AppError::other("Invalid public session identifiers."));
        }
        context.platform = platform();
        Ok(context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_snapshot_validates_public_fields_and_rejects_private_data() {
        let value = serde_json::json!({"supportLanguage":"pt-BR","sessionId":"voice-123","state":"connected",
            "provider":{"inbound":{"userText":true,"assistantText":true,"nativeToolCalls":false,"images":false},
            "outbound":{"text":true,"stopSpeaking":true,"systemPrompt":true,"toolResult":false,"image":false}}});
        let context = SessionContext::parse(value.clone()).unwrap();
        assert_eq!(context.support_language.as_deref(), Some("pt-BR"));
        assert_eq!(context.platform, std::env::consts::OS);
        let mut private = value;
        private["token"] = serde_json::json!("secret");
        assert!(SessionContext::parse(private).is_err());
        assert!(SessionContext::parse(
            serde_json::json!({"state":"connected","supportLanguage":"x".repeat(65)})
        )
        .is_err());
        assert_eq!(SessionContext::default().state, SessionState::Idle);
        assert!(SessionContext::default().provider.is_none());
    }
}
