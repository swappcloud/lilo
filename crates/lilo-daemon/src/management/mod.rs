//! Phone management boundary. The daemon owns execution; HTTP is an adapter.

mod http;
mod service;

pub use http::ManagementServer;
pub use service::{execute, execute_network};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    VoiceStart {
        #[serde(rename = "providerId")]
        provider_id: String,
        email: String,
        #[serde(rename = "resolvedLanguage", default)]
        resolved_language: Option<String>,
    },
    VoiceStatus {},
    VoiceStop {},
    VoiceMute {
        muted: bool,
    },
    VoiceInterrupt {},
    VoiceText {
        text: String,
    },
    SetDevicePreferences {
        preferences: crate::device::DevicePreferences,
    },
    Browser {
        payload: Value,
    },
    State {},
    Catalog {},
    Settings {},
    NetworkStatus {},
    NetworkScan {},
    NetworkJoin {
        ssid: String,
        password: String,
    },
    SetPreferences {
        #[serde(rename = "providerId", default)]
        provider_id: Option<String>,
        #[serde(rename = "marketplaceUrl")]
        marketplace_url: String,
        media: lilo_core::settings::MediaSettings,
        #[serde(rename = "defaultVoice")]
        default_voice: String,
        #[serde(rename = "voiceMode")]
        voice_mode: String,
    },
    SetMarketplace {
        url: String,
    },
    Plugin {
        id: String,
    },
    Install {
        id: String,
    },
    Enable {
        id: String,
        enabled: bool,
    },
    Remove {
        id: String,
    },
    Configure {
        id: String,
        settings: Value,
    },
    Invoke {
        id: String,
        tool: String,
        args: Value,
    },
    RemoveAccount {
        provider: String,
        email: String,
    },
}

pub struct Request {
    pub operation: Operation,
    pub reply: oneshot::Sender<Result<Value, String>>,
}
