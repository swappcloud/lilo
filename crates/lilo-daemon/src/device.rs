//! Persistent phone-managed device preferences, separate from desktop settings.
use crate::config::Config;
use anyhow::ensure;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevicePreferences {
    #[serde(default = "default_wake_word")]
    pub wake_word: bool,
    pub wake_phrase: String,
    pub language: String,
    pub locales: Vec<String>,
}
impl DevicePreferences {
    pub fn load(root: &Path, config: &Config) -> anyhow::Result<Self> {
        let path = root.join("device.json");
        let preferences = if path.exists() {
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            Self {
                wake_word: true,
                wake_phrase: config.wake_phrase().into(),
                language: "auto".into(),
                locales: config.locales.clone(),
            }
        };
        preferences.validate()?;
        Ok(preferences)
    }
    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            !self.wake_phrase.trim().is_empty()
                && self.wake_phrase.len() <= 80
                && !self.wake_phrase.chars().any(char::is_control),
            "Invalid wake phrase."
        );
        ensure!(
            !self.language.is_empty()
                && self.language.len() <= 35
                && self
                    .language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
            "Invalid language."
        );
        ensure!(
            self.locales.len() <= 16
                && self.locales.iter().all(|locale| !locale.is_empty()
                    && locale.len() <= 35
                    && locale
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')),
            "Invalid command locales."
        );
        Ok(())
    }
    pub fn save(&self, root: &Path) -> anyhow::Result<()> {
        self.validate()?;
        let temporary = root.join(format!("device-{}.tmp", uuid::Uuid::new_v4()));
        let destination = root.join("device.json");
        let result = (|| {
            std::fs::write(&temporary, serde_json::to_vec_pretty(self)?)?;
            std::fs::rename(&temporary, destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temporary);
        }
        result
    }
}
fn default_wake_word() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_preferences_and_preserves_the_saved_language() {
        let root = std::env::temp_dir().join(format!("lilo-device-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut preferences = DevicePreferences::load(&root, &Config::default()).unwrap();
        preferences.language = "pt-BR".into();
        preferences.save(&root).unwrap();
        assert_eq!(
            DevicePreferences::load(&root, &Config::default())
                .unwrap()
                .language,
            "pt-BR"
        );
        preferences.wake_phrase = "\n".into();
        assert!(preferences.save(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
