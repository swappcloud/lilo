//! The daemon's own file.
//!
//! The desktop app keeps the wake phrase and the languages to recognise in its
//! web UI; a headless box has no UI, so they live here. Everything else —
//! voices, media paths, accounts — stays in `lilo-core`'s own stores under the
//! data directory this config points at, which is why the app and the daemon
//! agree when they share a machine.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Spoken phrase that starts a session, when the config does not say.
pub const DEFAULT_WAKE_PHRASE: &str = "lilo";
/// Assistant name used by command templates, when the phrase has no word.
pub const DEFAULT_ASSISTANT_NAME: &str = "lilo";

/// The setup window, while the box has no network and no account.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupSection {
    /// Name of the access point the box brings up while unconfigured.
    #[serde(default = "default_ap_ssid")]
    pub ap_ssid: String,
    /// Port the setup page listens on: 80 is what a captive portal expects.
    #[serde(default = "default_setup_port")]
    pub port: u16,
    /// UDP port answering every name with the box, so a phone shows the sheet
    /// by itself; 0 turns it off.
    #[serde(default = "default_dns_port")]
    pub dns_port: u16,
    /// The address the box has on its own access point.
    #[serde(default = "default_ap_ip")]
    pub ap_ip: Ipv4Addr,
    /// Which radio backend to use: `nmcli` (NetworkManager, what headless Linux device
    /// OS ships) or `fake`, which pretends — for demos, tests and machines
    /// without a radio.
    #[serde(default = "default_wifi_backend")]
    pub wifi: String,
}

fn default_ap_ssid() -> String {
    "lilo-setup".to_string()
}

fn default_setup_port() -> u16 {
    80
}

fn default_dns_port() -> u16 {
    53
}

fn default_ap_ip() -> Ipv4Addr {
    Ipv4Addr::new(192, 168, 4, 1)
}

fn default_wifi_backend() -> String {
    "nmcli".to_string()
}

impl Default for SetupSection {
    fn default() -> Self {
        Self {
            ap_ssid: default_ap_ssid(),
            port: default_setup_port(),
            dns_port: default_dns_port(),
            ap_ip: default_ap_ip(),
            wifi: default_wifi_backend(),
        }
    }
}

/// The `lilo.toml` a box is configured with.
///
/// A typo is an error, never silence: a config that says `wake_pharse` must not
/// leave the box listening for the wrong thing without saying so.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Spoken phrase that starts a session. Empty means the default.
    #[serde(default)]
    pub wake_phrase: String,
    /// Languages to recognise. Empty means every locale the registry knows.
    #[serde(default)]
    pub locales: Vec<String>,
    /// Where `settings.json`, `accounts.json` and `plugins/` live. Defaults to
    /// the desktop app's data directory for this user.
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
    /// The setup window: what a fresh box shows the phone that configures it.
    #[serde(default)]
    pub setup: SetupSection,
}

impl Config {
    /// Read a config file that must exist.
    pub fn read(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| anyhow::anyhow!("could not read {}: {error}", path.display()))?;
        Self::parse(&text).map_err(|error| anyhow::anyhow!("{}: {error}", path.display()))
    }

    /// Read a config file, falling back to defaults when it does not exist yet:
    /// a freshly flashed box with no file still has to start.
    pub fn read_or_default(path: &Path) -> anyhow::Result<Self> {
        if path.exists() {
            Self::read(path)
        } else {
            Ok(Self::default())
        }
    }

    pub fn parse(text: &str) -> anyhow::Result<Self> {
        toml::from_str(text).map_err(|error| anyhow::anyhow!("invalid config: {error}"))
    }

    /// The phrase the box listens for; never empty.
    pub fn wake_phrase(&self) -> &str {
        let trimmed = self.wake_phrase.trim();
        if trimmed.is_empty() {
            DEFAULT_WAKE_PHRASE
        } else {
            trimmed
        }
    }

    /// The name command templates use: the phrase's last word, exactly as the
    /// desktop derives it when the user edits the wake phrase.
    pub fn assistant_name(&self) -> &str {
        self.wake_phrase()
            .split_whitespace()
            .next_back()
            .unwrap_or(DEFAULT_ASSISTANT_NAME)
    }

    /// Where the stores live: the config's own `data_dir`, else the desktop
    /// app's directory for this user, so a desktop install configures the
    /// daemon on the same machine.
    pub fn data_dir(&self) -> anyhow::Result<PathBuf> {
        if let Some(dir) = &self.data_dir {
            return Ok(dir.clone());
        }
        let base =
            dirs::data_dir().ok_or_else(|| anyhow::anyhow!("no data directory for this user"))?;
        Ok(base.join("com.lilo.app"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minimal_file_only_says_the_wake_phrase() {
        let config = Config::parse("wake_phrase = \"oi lilo\"\n").unwrap();
        assert_eq!(config.wake_phrase(), "oi lilo");
        assert_eq!(config.assistant_name(), "lilo");
        assert!(config.locales.is_empty());
        assert!(config.data_dir.is_none());
    }

    #[test]
    fn an_unknown_key_is_an_error_not_silence() {
        let error = Config::parse("wake_pharse = \"hello lilo\"\n").unwrap_err();
        assert!(error.to_string().contains("wake_pharse"), "{error}");
    }

    #[test]
    fn an_empty_phrase_falls_back_to_the_default_name() {
        let config = Config::parse("wake_phrase = \"  \"\n").unwrap();
        assert_eq!(config.wake_phrase(), DEFAULT_WAKE_PHRASE);
        assert_eq!(config.assistant_name(), DEFAULT_ASSISTANT_NAME);
    }

    #[test]
    fn the_assistant_name_is_the_last_word_of_the_phrase() {
        let config = Config::parse("wake_phrase = \"ei lilo\"\n").unwrap();
        assert_eq!(config.assistant_name(), "lilo");
    }

    #[test]
    fn locales_and_data_dir_pass_through() {
        let config =
            Config::parse("locales = [\"pt\", \"en\"]\ndata_dir = \"/var/lib/lilo\"\n").unwrap();
        assert_eq!(config.locales, vec!["pt".to_string(), "en".to_string()]);
        assert_eq!(config.data_dir().unwrap(), PathBuf::from("/var/lib/lilo"));
    }

    #[test]
    fn without_a_data_dir_it_uses_the_app_directory() {
        let dir = Config::default().data_dir().unwrap();
        assert!(dir.ends_with("com.lilo.app"), "{}", dir.display());
    }

    #[test]
    fn a_missing_file_is_defaults_and_an_invalid_one_is_an_error() {
        let dir = std::env::temp_dir().join(format!("lilo-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("lilo.toml");
        assert!(Config::read_or_default(&path).is_ok(), "missing = defaults");

        std::fs::write(&path, "not toml at all").unwrap();
        assert!(Config::read_or_default(&path).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
