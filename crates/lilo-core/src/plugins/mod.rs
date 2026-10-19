//! Plugin surface for `lilo-core`.
//!
//! The host does not hard-code which tools exist or who answers them. A
//! provider is anything that declares a manifest, the tools it owns, and can
//! run one of them: the built-ins (time, web search, media) and sidecar
//! plugins loaded from disk (`loader`, `sidecar`) or installed from a
//! marketplace (`marketplace`). Contract: `docs/plugins.md`.
//!
//! Rules this module exists to keep:
//!   * no `tauri` — the headless headless Linux device daemon runs the same registry;
//!   * no `async-trait` — one boxed future per call is cheap next to the work
//!     these tools actually do (network, process spawn), and enum/boxed
//!     dispatch keeps the binary small on ARM;
//!   * identity is explicit, so duplicate ids and clashing tool names are
//!     rejected at registration instead of silently shadowing each other.

pub mod browser;
pub mod bus;
pub mod images;
pub mod loader;
pub mod manifest;
pub mod marketplace;
pub mod provider;
pub mod quickjs;
pub mod registry;
pub mod sidecar;
pub mod store;
pub mod ui;
pub mod voice;

mod desktop;
mod durable;
mod exec;
mod http;
mod interactions;
mod scheduler;
mod screen;
pub mod session;

/// Variables a plugin inherits. Everything else in the host environment stays
/// out: a user's shell may carry API keys, and a marketplace plugin has no
/// business reading them.
pub(crate) const INHERITED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    // Session services needed by desktop and screen plugins; never logged.
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "TZ",
    "TMPDIR",
    "TERM",
    // Windows cannot start most programs without these.
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "SystemDrive",
    "HOMEDRIVE",
    "HOMEPATH",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
];

pub use bus::{Event, EventBus, Publisher};
pub use desktop::ComputerApps;
pub use loader::{
    load_dir, load_dir_except, load_dir_except_for_host, load_dir_for_host, LoadOutcome, PluginFile,
};
pub use manifest::{Capability, PluginManifest, PLUGIN_API_VERSION};
pub use marketplace::{CatalogEntry, MarketplaceEntry, MarketplaceIndex};
pub use provider::{BoxFuture, ToolProvider};
pub use registry::{PluginView, ToolRegistry};
pub use sidecar::SidecarPlugin;
pub use ui::{PluginUi, SceneSource, SettingField, StatusRow, UiAction};

/// Read the shared tool-result flag requesting a voice-session handoff.
pub fn result_ends_session(result: &serde_json::Value) -> bool {
    result
        .get("endSession")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

use std::path::Path;

/// Every plugin the host knows about: what is registered — first-party
/// in-process plugins included — plus every folder on disk that is not
/// running. A deactivated plugin has no provider, but it still appears here
/// with its name and version: that is what lets the settings list offer to
/// turn it back on.
///
/// `manageable` marks the folder-backed plugins, the only ones that can be
/// deactivated, reactivated or uninstalled.
pub fn installed_views(root: &Path, registry: &ToolRegistry) -> Vec<PluginView> {
    installed_views_for_host(root, registry, "desktop")
}

pub fn installed_views_for_host(
    root: &Path,
    registry: &ToolRegistry,
    host: &str,
) -> Vec<PluginView> {
    let mut views = Vec::new();
    let mut known = std::collections::HashSet::new();
    for provider in registry.providers() {
        let manifest = provider.manifest().clone();
        known.insert(manifest.id.clone());
        if !manifest.supports_host(host) {
            continue;
        }
        views.push(PluginView {
            manageable: installed_manifest(root, &manifest.id).is_some(),
            tools: provider
                .descriptors()
                .into_iter()
                .map(|tool| tool.name)
                .collect(),
            manifest,
            voice_providers: provider.voice_providers(),
            ui: provider.ui(),
            enabled: true,
            loaded: true,
        });
    }
    for id in installed_ids(root) {
        if known.contains(&id) || loader::is_retired(&id) {
            continue;
        }
        let Some(value) = store::load_manifest_value(root, &id) else {
            continue;
        };
        let Ok(file) = serde_json::from_value::<PluginFile>(value) else {
            continue;
        };
        if file.id != id || !file.supports_host(host) {
            continue;
        }
        let manifest = file.manifest();
        views.push(PluginView {
            manageable: true,
            tools: Vec::new(),
            manifest,
            voice_providers: Vec::new(),
            ui: PluginUi::default(),
            enabled: store::is_enabled(root, &id),
            loaded: false,
        });
    }
    views
}

/// The manifest of the plugin installed under `id`, if any.
///
/// The folder name is the id: settings, the deactivation marker and uninstall
/// all address the plugin by it, so a folder whose `plugin.json` claims
/// another id is not something this host can manage.
fn installed_manifest(root: &Path, id: &str) -> Option<PluginManifest> {
    let value = store::load_manifest_value(root, id)?;
    let file: loader::PluginFile = serde_json::from_value(value).ok()?;
    (file.id == id).then(|| file.manifest())
}

/// Folder names of installed plugins, sorted so the settings list does not
/// reshuffle between launches. Same rules as the loader: dot-folders are the
/// installer's staging area, and a folder without a manifest is not a plugin.
fn installed_ids(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            (!name.starts_with('.') && dir.is_dir() && dir.join("plugin.json").is_file())
                .then_some(name)
        })
        .collect();
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_handoff_requires_an_explicit_boolean_flag() {
        assert!(result_ends_session(&json!({"endSession": true})));
        for value in [
            json!({}),
            json!({"endSession": false}),
            json!({"endSession": "true"}),
            json!({"endSession": null}),
        ] {
            assert!(!result_ends_session(&value));
        }
    }

    #[test]
    fn test_retired_launcher_is_not_shown_in_settings() {
        let dir = root("retired");
        write_plugin(&dir, "com.lilo.macapps", "Old launcher");
        assert!(installed_views(&dir, &ToolRegistry::new()).is_empty());
        assert!(dir.join("com.lilo.macapps/plugin.json").is_file());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn daemon_installed_views_hide_plugins_without_explicit_host_support() {
        let dir = root("daemon-hosts");
        write_plugin(&dir, "com.example.desktop", "Desktop");
        assert!(installed_views_for_host(&dir, &ToolRegistry::new(), "daemon").is_empty());
        std::fs::write(
            dir.join("com.example.desktop/plugin.json"),
            json!({"id":"com.example.desktop","name":"Desktop","version":"1","api":1,"entry":"run.sh","hosts":["desktop","daemon"]}).to_string(),
        )
        .unwrap();
        let views = installed_views_for_host(&dir, &ToolRegistry::new(), "daemon");
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].manifest.id, "com.example.desktop");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn daemon_views_filter_registered_providers_by_host() {
        let dir = root("registered-hosts");
        let mut registry = ToolRegistry::new();
        for manifest in [
            PluginManifest::new("core.desktop", "Desktop", "1"),
            PluginManifest::new("core.shared", "Shared", "1").with_hosts(&["desktop", "daemon"]),
        ] {
            registry
                .register(std::sync::Arc::new(InProcess { manifest }))
                .unwrap();
        }
        let views = installed_views_for_host(&dir, &registry, "daemon");
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].manifest.id, "core.shared");
        assert_eq!(installed_views(&dir, &registry).len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    struct InProcess {
        manifest: PluginManifest,
    }

    impl ToolProvider for InProcess {
        fn manifest(&self) -> &PluginManifest {
            &self.manifest
        }

        fn descriptors(&self) -> Vec<crate::tools::ToolDescriptor> {
            Vec::new()
        }

        fn handles(&self, _tool: &str) -> bool {
            false
        }

        fn invoke<'a>(
            &'a self,
            _tool: &'a str,
            _args: &'a serde_json::Value,
        ) -> BoxFuture<'a, crate::error::Result<serde_json::Value>> {
            Box::pin(async { Ok(json!(null)) })
        }
    }

    fn root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lilo-views-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_plugin(root: &Path, id: &str, name: &str) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("plugin.json"),
            json!({
                "id": id, "name": name, "version": "2.1.0", "api": 1, "entry": "run.sh"
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn installed_views_merge_running_and_deactivated_plugins() {
        let dir = root("merge");
        write_plugin(&dir, "com.acme.off", "Off");
        store::set_enabled(&dir, "com.acme.off", false).unwrap();

        let mut registry = ToolRegistry::new();
        registry
            .register(std::sync::Arc::new(InProcess {
                manifest: PluginManifest::new("core.thing", "Thing", "1.0.0"),
            }))
            .unwrap();

        let views = installed_views(&dir, &registry);
        assert_eq!(views.len(), 2, "{views:?}");

        let running = views
            .iter()
            .find(|view| view.manifest.id == "core.thing")
            .expect("the registered provider is listed");
        assert!(running.enabled && running.loaded);
        assert!(
            !running.manageable,
            "an in-process plugin has no folder to manage"
        );

        let off = views
            .iter()
            .find(|view| view.manifest.id == "com.acme.off")
            .expect("a deactivated plugin is still listed");
        assert_eq!(off.manifest.name, "Off");
        assert_eq!(off.manifest.version, "2.1.0");
        assert!(!off.enabled && !off.loaded && off.manageable);
        assert!(off.ui.is_empty(), "a stopped plugin declares no UI");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_whose_manifest_claims_another_id_is_not_listed() {
        let dir = root("mismatch");
        write_plugin(&dir, "com.acme.real", "Real");
        // The index names one id, the files inside claim another.
        std::fs::write(
            dir.join("com.acme.real/plugin.json"),
            json!({
                "id": "com.acme.other", "name": "Other", "version": "1", "api": 1, "entry": "run.sh"
            })
            .to_string(),
        )
        .unwrap();
        let views = installed_views(&dir, &ToolRegistry::new());
        assert!(views.is_empty(), "{views:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
