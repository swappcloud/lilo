//! Who a provider is, and what it is allowed to touch.
//!
//! Capabilities are declared, serialized and shown at install time. The public
//! HTTP, execution, desktop, screen and conversation APIs enforce their own
//! declared scopes; storage paths are always confined to the plugin. Convention:
//!
//!   * `http:<host>`      — network egress, host by host (never "the internet")
//!   * `exec:<binary>`    — may spawn a process
//!   * `storage:self`     — may write under its own data directory
//!   * `audio:out`        — may play audio
//!   * `accounts:read`    — may read the signed-in account (never the token)

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Human-readable plugin identity in one UI language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginPresentation {
    pub name: String,
    pub description: String,
}

/// An optional interface language contributed by a plugin, with English fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginLanguage {
    pub tag: String,
    pub name: String,
    #[serde(default)]
    pub messages: BTreeMap<String, String>,
}

/// Bumped when the host contract changes incompatibly. A provider whose `api`
/// does not match is refused, rather than failing later in a confusing way.
pub const PLUGIN_API_VERSION: u32 = 1;

/// A declared permission, e.g. `http:api.spotify.com` or `exec:mpv`.
pub type Capability = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// Stable, reverse-DNS-ish id: `core.media`, `com.acme.spotify`.
    pub id: String,
    pub name: String,
    pub description: String,
    pub localized: BTreeMap<String, PluginPresentation>,
    pub languages: Vec<PluginLanguage>,
    pub version: String,
    /// Host contract version this provider was written against.
    pub api: u32,
    pub capabilities: Vec<Capability>,
    /// Runtime hosts declared by the publisher; built-ins default to desktop.
    #[serde(default = "default_hosts")]
    pub hosts: Vec<String>,
}

fn default_hosts() -> Vec<String> {
    vec!["desktop".to_string()]
}

impl PluginManifest {
    pub fn new(id: &str, name: &str, version: &str) -> Self {
        PluginManifest {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            localized: BTreeMap::new(),
            languages: Vec::new(),
            version: version.to_string(),
            api: PLUGIN_API_VERSION,
            capabilities: Vec::new(),
            hosts: default_hosts(),
        }
    }

    /// Declare permissions. Chainable so a provider reads as its own manifest.
    pub fn with_capabilities(mut self, capabilities: &[&str]) -> Self {
        self.capabilities = capabilities.iter().map(|c| c.to_string()).collect();
        self
    }

    pub fn with_hosts(mut self, hosts: &[&str]) -> Self {
        self.hosts = hosts.iter().map(|host| host.to_string()).collect();
        self
    }

    pub fn supports_host(&self, host: &str) -> bool {
        self.hosts.iter().any(|target| target == host)
    }

    pub fn is_compatible(&self) -> bool {
        self.api == PLUGIN_API_VERSION
    }

    /// The event authority is reserved even when loading a local package.
    pub fn validate_identity(&self) -> crate::error::Result<()> {
        if self.id == "host" {
            return Err(crate::error::AppError::other(
                "Plugin identity `host` is reserved.",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_identity_cannot_impersonate_host_events() {
        assert!(PluginManifest::new("host", "Host", "1")
            .validate_identity()
            .is_err());
        assert!(
            PluginManifest::new("com.example.phrasebook", "Phrases", "1")
                .validate_identity()
                .is_ok()
        );
    }

    #[test]
    fn a_new_manifest_speaks_the_current_api() {
        let manifest = PluginManifest::new("core.test", "Test", "1.0.0");
        assert!(manifest.is_compatible());
        assert!(manifest.capabilities.is_empty());
    }

    #[test]
    fn capabilities_are_declared_explicitly() {
        let manifest = PluginManifest::new("core.media", "Media", "1.0.0")
            .with_capabilities(&["exec:mpv", "http:example.org"]);
        assert_eq!(manifest.capabilities.len(), 2);
        assert!(manifest.capabilities.iter().any(|c| c == "exec:mpv"));
    }

    #[test]
    fn an_unknown_api_version_is_incompatible() {
        let mut manifest = PluginManifest::new("core.test", "Test", "1.0.0");
        manifest.api = PLUGIN_API_VERSION + 1;
        assert!(!manifest.is_compatible());
    }
}
