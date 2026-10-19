use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// Client identity headers captured from a working ChatGPT web build.
/// These drift over time — expose them in settings so a user can update them
/// without rebuilding when OpenAI rotates client versions.
pub const DEFAULT_CLIENT_VERSION: &str = "prod-fb4a8a2a751dfec391053cfd7b01c52699ccf78c";
pub const DEFAULT_CLIENT_BUILD_NUMBER: &str = "8370486";
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";

fn default_audio_quality() -> String {
    "high".to_string()
}

fn default_autoplay_related() -> bool {
    true
}

pub fn default_provider_id() -> String {
    "mock".to_string()
}

/// Stored empty: "the default", so a later default reaches existing users.
pub fn default_marketplace_url() -> String {
    String::new()
}

/// The default marketplace: `examples/plugins` in the app's own repository,
/// served raw by GitHub — no server of ours.
pub const REPO_MARKETPLACE_URL: &str =
    "https://raw.githubusercontent.com/swappcloud/lilo/main/examples/plugins";

const MISCONFIGURED_MARKETPLACE_URL: &str =
    "https://raw.githubusercontent.com/lilo/plugins/main";

/// Development uses only the workspace examples, even with a saved URL.
/// Packaged apps use the configured source, or the repository followed by the
/// bundled copy when the repository is unreachable (offline or still private).
pub fn marketplace_sources(
    configured: &str,
    bundled: &std::path::Path,
    development: Option<&std::path::Path>,
) -> Vec<String> {
    if let Some(directory) = development {
        return vec![directory.to_string_lossy().into_owned()];
    }
    let trimmed = configured.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed == MISCONFIGURED_MARKETPLACE_URL {
        vec![
            REPO_MARKETPLACE_URL.to_string(),
            bundled.to_string_lossy().into_owned(),
        ]
    } else {
        vec![trimmed.to_string()]
    }
}

/// Media playback. `#[serde(default)]` on the field in `Settings` keeps older
/// `settings.json` files loading unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSettings {
    /// Playback engine. Only `mpv` today; Spotify and friends slot in here.
    pub backend: String,
    /// `auto` | `yt-dlp` | `http`. `auto` prefers yt-dlp when installed and
    /// falls back to HTTP, which is the headless Linux device path (no Python).
    pub resolver: String,
    /// Explicit binary paths, for a packaged app whose PATH is minimal.
    pub mpv_path: String,
    pub yt_dlp_path: String,
    /// Piped-compatible instance used by the HTTP resolver.
    pub http_resolver_url: String,
    /// 0-100.
    pub volume: u8,
    /// Percentage of the current volume kept while the assistant speaks.
    pub duck_percent: u8,
    /// "high" (default) or "low" — only cap the bitrate when bandwidth or CPU
    /// actually demands it.
    #[serde(default = "default_audio_quality")]
    pub audio_quality: String,
    /// After a requested song, keep playing related ones — YouTube's autoplay.
    #[serde(default = "default_autoplay_related")]
    pub autoplay_related: bool,
}

impl Default for MediaSettings {
    fn default() -> Self {
        Self {
            backend: "mpv".to_string(),
            resolver: "auto".to_string(),
            mpv_path: String::new(),
            yt_dlp_path: String::new(),
            http_resolver_url: "https://pipedapi.kavin.rocks".to_string(),
            volume: 70,
            duck_percent: 45,
            audio_quality: default_audio_quality(),
            autoplay_related: default_autoplay_related(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// When true, the SDP offer is forwarded to an external (Chrome-impersonating)
    /// gateway instead of posting directly to chatgpt.com from Rust.
    pub use_external_gateway: bool,
    pub external_gateway_url: String,
    #[serde(default)]
    pub gateway_auth_key: String,
    /// Where the plugin marketplace lives. A public repository with one folder
    /// per plugin; production changes only this string. A filesystem path is
    /// accepted, which is how the flow is developed and tested offline.
    #[serde(default = "default_marketplace_url")]
    pub marketplace_url: String,
    /// Last selected voice backend, persisted so it survives a restart.
    #[serde(default = "default_provider_id")]
    pub provider_id: String,
    pub default_voice: String,
    pub voice_mode: String,
    pub client_version: String,
    pub client_build_number: String,
    pub user_agent: String,
    #[serde(default)]
    pub media: MediaSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            use_external_gateway: false,
            external_gateway_url: "http://127.0.0.1:8000".to_string(),
            gateway_auth_key: String::new(),
            marketplace_url: default_marketplace_url(),
            provider_id: default_provider_id(),
            default_voice: "cove".to_string(),
            voice_mode: "wingman".to_string(),
            client_version: DEFAULT_CLIENT_VERSION.to_string(),
            client_build_number: DEFAULT_CLIENT_BUILD_NUMBER.to_string(),
            user_agent: DEFAULT_USER_AGENT.to_string(),
            media: MediaSettings::default(),
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    value: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            value: Mutex::new(value),
        }
    }

    pub fn get(&self) -> Settings {
        self.value.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn set(&self, next: Settings) -> Result<()> {
        {
            let mut guard = self
                .value
                .lock()
                .map_err(|_| AppError::other("settings store poisoned"))?;
            *guard = next.clone();
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.path, serde_json::to_string_pretty(&next)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        let s = Settings::default();
        assert!(!s.use_external_gateway);
        assert_eq!(s.provider_id, "mock");
        assert_eq!(s.default_voice, "cove");
        assert_eq!(s.voice_mode, "wingman");
        assert!(s.external_gateway_url.starts_with("http"));
    }

    #[test]
    fn an_unset_marketplace_is_the_repository_then_the_bundled_copy() {
        let bundled = std::path::Path::new("/app/resources/marketplace");
        let default = vec![
            REPO_MARKETPLACE_URL.to_string(),
            "/app/resources/marketplace".to_string(),
        ];
        assert_eq!(Settings::default().marketplace_url, "");
        assert_eq!(marketplace_sources("", bundled, None), default);
        assert_eq!(marketplace_sources("  ", bundled, None), default);
        assert_eq!(
            marketplace_sources(
                "https://raw.githubusercontent.com/lilo/plugins/main/",
                bundled,
                None,
            ),
            default
        );
        assert_eq!(
            marketplace_sources("https://example.com/market/", bundled, None),
            vec!["https://example.com/market".to_string()]
        );
        assert!(REPO_MARKETPLACE_URL.ends_with("/examples/plugins"));
    }

    #[test]
    fn development_uses_only_workspace_examples_despite_saved_remote_urls() {
        let development = std::path::Path::new("workspace")
            .join("examples")
            .join("plugins");
        let bundled = std::path::Path::new("resources").join("plugins");
        for configured in [
            "",
            REPO_MARKETPLACE_URL,
            MISCONFIGURED_MARKETPLACE_URL,
            "https://example.com/market/",
        ] {
            assert_eq!(
                marketplace_sources(configured, &bundled, Some(&development)),
                vec![development.to_string_lossy().into_owned()]
            );
        }
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // Simulates an older settings.json without `providerId` / `gatewayAuthKey`.
        let raw = r#"{
            "useExternalGateway": false,
            "externalGatewayUrl": "http://127.0.0.1:8000",
            "defaultVoice": "ember",
            "voiceMode": "wingman",
            "clientVersion": "v",
            "clientBuildNumber": "1",
            "userAgent": "ua"
        }"#;
        let parsed: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.provider_id, "mock");
        assert_eq!(parsed.default_voice, "ember");
    }

    #[test]
    fn round_trips_to_disk() {
        let path = std::env::temp_dir().join(format!("rvp-settings-{}.json", uuid::Uuid::new_v4()));
        let store = SettingsStore::load(path.clone());
        let mut s = store.get();
        s.default_voice = "ember".into();
        s.use_external_gateway = true;
        store.set(s).unwrap();

        let reloaded = SettingsStore::load(path.clone()).get();
        assert_eq!(reloaded.default_voice, "ember");
        assert!(reloaded.use_external_gateway);
        let _ = std::fs::remove_file(path);
    }
}
