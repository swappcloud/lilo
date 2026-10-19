//! Finding plugins on disk and starting them.
//!
//! One directory per plugin, under `<app data>/plugins/<id>/`:
//!
//! ```text
//! plugins/hello/
//!   plugin.json     id, name, version, api, capabilities, entry, args
//!   hello.sh        the executable (any language)
//! ```
//!
//! `entries` overrides `entry` per platform (`windows`, `macos`, `linux`, or
//! `unix` for both of the last two): a shell script does not start on Windows,
//! and Windows is the primary desktop target.
//!
//! The manifest is authoritative for *install-time* facts (identity, version,
//! api, entry). What the plugin can actually do is asked at the handshake, so
//! tool schemas live with the code that implements them instead of being
//! duplicated in JSON and drifting.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;

use crate::error::{AppError, Result};

use super::manifest::PluginPresentation;
use super::manifest::{Capability, PluginManifest};
use super::provider::ToolProvider;
use super::quickjs::QuickJsPlugin;
use super::sidecar::SidecarPlugin;

/// `plugin.json`, as written by a publisher.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFile {
    pub id: String,
    /// Defaults to the id: a plugin whose name is its id is not worth arguing
    /// about, and it keeps the manifest minimal.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub localized: BTreeMap<String, PluginPresentation>,
    #[serde(default)]
    pub languages: Vec<super::manifest::PluginLanguage>,
    pub version: String,
    pub api: u32,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
    /// Executable path relative to the plugin directory.
    pub entry: String,
    /// How `entry` runs: `"process"` (the default — a sidecar speaking JSON
    /// over stdio) or `"quickjs"` (the embedded engine; one `.js` file for
    /// every OS).
    #[serde(default)]
    pub runtime: String,
    /// Per-platform executable, overriding `entry`.
    #[serde(default)]
    pub entries: BTreeMap<String, String>,
    /// Operating systems this plugin runs on: `windows`, `macos`, `linux`
    /// (`unix` covers both of the last two). Empty means every platform.
    #[serde(default)]
    pub platforms: Vec<String>,
    /// Runtime hosts this plugin supports. Omitted manifests remain desktop-only.
    #[serde(default = "desktop_host")]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub args: Vec<String>,
}

fn desktop_host() -> Vec<String> {
    vec!["desktop".to_string()]
}

impl PluginFile {
    pub fn supports_host(&self, host: &str) -> bool {
        self.hosts.iter().any(|target| target == host)
    }

    /// The executable for this machine.
    pub fn entry_for_this_platform(&self) -> &str {
        entry_for(self, std::env::consts::OS)
    }

    /// Whether this plugin runs on `os`. Empty `platforms` means all of them.
    ///
    /// A plugin that only works on one OS must say so instead of failing to
    /// start everywhere else (a macOS-only helper has no Windows port, and a
    /// half-working port is worse than an honest skip).
    pub fn supports(&self, os: &str) -> bool {
        supports_platforms(&self.platforms, os)
    }

    /// The manifest facts the registry and the settings list need.
    pub fn manifest(&self) -> PluginManifest {
        let name = if self.name.trim().is_empty() {
            self.id.clone()
        } else {
            self.name.clone()
        };
        PluginManifest {
            id: self.id.clone(),
            name,
            description: self.description.clone(),
            localized: self.localized.clone(),
            languages: self.languages.clone(),
            version: self.version.clone(),
            api: self.api,
            capabilities: self.capabilities.clone(),
            hosts: self.hosts.clone(),
        }
    }
}

fn entry_for<'a>(file: &'a PluginFile, os: &str) -> &'a str {
    let family = if os == "windows" { "windows" } else { "unix" };
    file.entries
        .get(os)
        .or_else(|| file.entries.get(family))
        .map(String::as_str)
        .unwrap_or(&file.entry)
}

/// Shared by the installed manifest and the marketplace index, so a plugin
/// cannot be offered on a platform the host would then refuse to start it on.
pub fn supports_platforms(platforms: &[String], os: &str) -> bool {
    if platforms.is_empty() {
        return true;
    }
    let family = if os == "windows" { "windows" } else { "unix" };
    platforms
        .iter()
        .any(|platform| platform.eq_ignore_ascii_case(os) || platform.eq_ignore_ascii_case(family))
}

/// What a scan of the plugins directory produced.
///
/// Every started plugin is behind the same trait, so the host does not know —
/// or care — whether it is a process or a script in the embedded engine.
#[derive(Default)]
pub struct LoadOutcome {
    pub plugins: Vec<Arc<dyn ToolProvider>>,
    /// `(path, reason)` for everything that was found but refused. Reported
    /// instead of swallowed: a plugin that silently fails to load is the worst
    /// possible behaviour for the user.
    pub failed: Vec<(String, String)>,
    /// Ids installed here but not meant for this OS (`platforms` in the
    /// manifest). Not an error — the host just does not start them.
    pub skipped: Vec<String>,
}

/// Replaced first-party plugins must not compete with their bundled successor.
pub(crate) fn is_retired(id: &str) -> bool {
    id == "com.lilo.macapps"
}

pub async fn load_dir(dir: &Path) -> LoadOutcome {
    load_dir_for_host(dir, "desktop").await
}

pub async fn load_dir_for_host(dir: &Path, host: &str) -> LoadOutcome {
    load_dir_except_for_host(dir, |_| false, host).await
}

/// Like `load_dir`, but never starts a plugin whose id `skip` accepts.
///
/// Reloading after an install used to start *every* plugin again just to have
/// the registry refuse the duplicates: each one paid a handshake, and anything a
/// plugin does on startup happened twice.
///
/// Plugins start concurrently, so one slow handshake does not add up with the
/// others while the app is starting.
pub async fn load_dir_except(dir: &Path, skip: impl Fn(&str) -> bool) -> LoadOutcome {
    load_dir_except_for_host(dir, skip, "desktop").await
}

pub async fn load_dir_except_for_host(
    dir: &Path,
    skip: impl Fn(&str) -> bool,
    host: &str,
) -> LoadOutcome {
    let mut outcome = LoadOutcome::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return outcome; // no directory yet is not an error
    };
    let mut starting = tokio::task::JoinSet::new();
    for entry in entries.flatten() {
        let plugin_dir = entry.path();
        // Dot-folders are the installer's staging area. A crash mid-install
        // must not leave a second copy that loads instead of the real one.
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        if hidden || !plugin_dir.is_dir() {
            continue;
        }
        let manifest_path = plugin_dir.join("plugin.json");
        if !manifest_path.is_file() {
            continue;
        }
        // A deactivated plugin is skipped, not reported as failed: it is
        // installed and the user turned it off on purpose.
        if plugin_dir.join(super::store::DISABLED_FILE).is_file() {
            continue;
        }
        let file = match read_manifest(&manifest_path) {
            Ok(file) => file,
            Err(error) => {
                outcome
                    .failed
                    .push((plugin_dir.display().to_string(), error.to_string()));
                continue;
            }
        };
        if is_retired(&file.id) || skip(&file.id) {
            continue;
        }
        // Supported elsewhere, not here: not a failure, just not for this OS.
        if !file.supports(std::env::consts::OS) || !file.supports_host(host) {
            outcome.skipped.push(file.id.clone());
            continue;
        }
        starting.spawn(async move {
            let entry = file.entry_for_this_platform();
            let started = match file.runtime.as_str() {
                "" | "process" => {
                    SidecarPlugin::start(&plugin_dir, file.manifest(), entry, &file.args)
                        .await
                        .map(|plugin| Arc::new(plugin) as Arc<dyn ToolProvider>)
                }
                "quickjs" | "javascript" | "js" => {
                    QuickJsPlugin::start(&plugin_dir, file.manifest(), entry, &file.args)
                        .map(|plugin| Arc::new(plugin) as Arc<dyn ToolProvider>)
                }
                other => Err(AppError::other(format!(
                    "unknown plugin runtime {other:?} (expected \"process\" or \"quickjs\")"
                ))),
            };
            (plugin_dir, started)
        });
    }
    while let Some(joined) = starting.join_next().await {
        match joined {
            Ok((_, Ok(plugin))) => outcome.plugins.push(plugin),
            Ok((plugin_dir, Err(error))) => outcome
                .failed
                .push((plugin_dir.display().to_string(), error.to_string())),
            Err(error) => outcome
                .failed
                .push(("<plugin task>".to_string(), error.to_string())),
        }
    }
    // Stable order, so the settings list does not reshuffle between launches.
    outcome
        .plugins
        .sort_by(|a, b| a.manifest().id.cmp(&b.manifest().id));
    outcome
}

fn read_manifest(manifest_path: &Path) -> Result<PluginFile> {
    let raw = std::fs::read_to_string(manifest_path)
        .map_err(|error| AppError::other(format!("could not read plugin.json: {error}")))?;
    let file: PluginFile = serde_json::from_str(&raw)
        .map_err(|error| AppError::other(format!("invalid plugin.json: {error}")))?;
    crate::plugins::store::safe_segment(&file.id)
        .map_err(|_| AppError::other(format!("plugin.json has an invalid id: {:?}", file.id)))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    #[test]
    fn translation_packs_survive_the_installed_manifest_contract() {
        let file: super::PluginFile = serde_json::from_value(serde_json::json!({
            "id": "com.example.spanish", "version": "1.0.0", "api": 1,
            "runtime": "quickjs", "entry": "plugin.js",
            "languages": [{"tag": "es-ES", "name": "Español",
                "messages": {"language.title": "Idioma"}}]
        }))
        .unwrap();
        let value = serde_json::to_value(file.manifest()).unwrap();
        assert_eq!(
            value["languages"][0]["messages"]["language.title"],
            "Idioma"
        );
    }
    use super::*;

    #[tokio::test]
    async fn test_retired_launcher_is_not_started_and_keeps_user_data() {
        let root = std::env::temp_dir().join(format!("lilo-retired-{}", uuid::Uuid::new_v4()));
        let plugin = root.join("com.lilo.macapps");
        std::fs::create_dir_all(plugin.join("data")).unwrap();
        std::fs::write(plugin.join("plugin.json"), r#"{"id":"com.lilo.macapps","version":"1","api":1,"runtime":"quickjs","entry":"plugin.js"}"#).unwrap();
        std::fs::write(
            plugin.join("plugin.js"),
            "function describe(){return {tools:[]};} function invoke(){return {};}",
        )
        .unwrap();
        std::fs::write(plugin.join("data/state.json"), "preserved").unwrap();
        let loaded = load_dir(&root).await;
        assert!(loaded.plugins.is_empty());
        assert!(loaded.failed.is_empty());
        assert_eq!(
            std::fs::read_to_string(plugin.join("data/state.json")).unwrap(),
            "preserved"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn daemon_loader_starts_only_plugins_that_declare_daemon_support() {
        let root = std::env::temp_dir().join(format!("lilo-hosts-{}", uuid::Uuid::new_v4()));
        for (id, hosts) in [
            ("com.example.desktop", "[\"desktop\"]"),
            ("com.example.daemon", "[\"desktop\",\"daemon\"]"),
        ] {
            let plugin = root.join(id);
            std::fs::create_dir_all(&plugin).unwrap();
            std::fs::write(
                plugin.join("plugin.json"),
                format!("{{\"id\":\"{id}\",\"version\":\"1\",\"api\":1,\"runtime\":\"quickjs\",\"entry\":\"plugin.js\",\"hosts\":{hosts}}}"),
            )
            .unwrap();
            std::fs::write(
                plugin.join("plugin.js"),
                "function describe(){return {tools:[]};} function invoke(){return {};}",
            )
            .unwrap();
        }
        let loaded = load_dir_for_host(&root, "daemon").await;
        assert_eq!(loaded.plugins.len(), 1);
        assert_eq!(loaded.plugins[0].manifest().id, "com.example.daemon");
        assert!(loaded.skipped.contains(&"com.example.desktop".to_string()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_manifest_without_a_name_falls_back_to_its_id() {
        let file: PluginFile = serde_json::from_str(
            r#"{ "id": "com.acme.hello", "version": "1.0.0", "api": 1, "entry": "run.sh" }"#,
        )
        .unwrap();
        let manifest = file.manifest();
        assert_eq!(manifest.name, "com.acme.hello");
        assert_eq!(manifest.version, "1.0.0");
        assert!(manifest.capabilities.is_empty());
    }

    #[test]
    fn platforms_decide_where_a_plugin_runs() {
        let file: PluginFile = serde_json::from_str(
            r#"{ "id": "com.acme.mac", "version": "1.0.0", "api": 1, "entry": "run.sh",
                 "platforms": ["macos"] }"#,
        )
        .unwrap();
        assert!(file.supports("macos"));
        assert!(!file.supports("windows"));
        assert!(!file.supports("linux"));
    }

    #[test]
    fn no_platforms_means_every_platform() {
        let file: PluginFile = serde_json::from_str(
            r#"{ "id": "com.acme.all", "version": "1.0.0", "api": 1, "entry": "run" }"#,
        )
        .unwrap();
        for os in ["windows", "macos", "linux"] {
            assert!(file.supports(os), "{os}");
        }
    }

    #[test]
    fn unix_covers_both_unix_platforms() {
        let file: PluginFile = serde_json::from_str(
            r#"{ "id": "com.acme.unix", "version": "1.0.0", "api": 1, "entry": "run.sh",
                 "platforms": ["unix"] }"#,
        )
        .unwrap();
        assert!(file.supports("macos"));
        assert!(file.supports("linux"));
        assert!(!file.supports("windows"));
    }

    #[test]
    fn capabilities_and_args_round_trip() {
        let file: PluginFile = serde_json::from_str(
            r#"{
                "id": "com.acme.spotify",
                "name": "Spotify",
                "version": "2.1.0",
                "api": 1,
                "capabilities": ["http:api.spotify.com", "storage:self"],
                "entry": "bin/spotify",
                "args": ["--stdio"]
            }"#,
        )
        .unwrap();
        let manifest = file.manifest();
        assert_eq!(manifest.capabilities.len(), 2);
        assert_eq!(file.args, vec!["--stdio".to_string()]);
    }

    #[test]
    fn test_manifest_keeps_descriptions_and_localized_presentation() {
        let file: PluginFile = serde_json::from_str(
            r#"{
            "id": "com.lilo.history", "name": "Music history",
            "description": "Previously played songs.", "version": "1", "api": 1,
            "entry": "history.js", "runtime": "quickjs",
            "localized": {"pt": {"name": "Music archive", "description": "Saved songs."}}
        }"#,
        )
        .unwrap();
        let manifest = file.manifest();
        assert_eq!(manifest.description, "Previously played songs.");
        assert_eq!(manifest.localized["pt"].name, "Music archive");
        assert_eq!(manifest.localized["pt"].description, "Saved songs.");
    }

    #[test]
    fn a_missing_entry_field_is_rejected() {
        let parsed: std::result::Result<PluginFile, _> =
            serde_json::from_str(r#"{ "id": "x", "version": "1", "api": 1 }"#);
        assert!(parsed.is_err(), "entry is required");
    }

    #[test]
    fn the_platform_entry_wins_over_the_default() {
        let file: PluginFile = serde_json::from_str(
            r#"{ "id": "x", "version": "1", "api": 1, "entry": "run.sh",
                 "entries": { "windows": "run.exe", "macos": "run-mac" } }"#,
        )
        .unwrap();
        assert_eq!(entry_for(&file, "windows"), "run.exe");
        assert_eq!(entry_for(&file, "macos"), "run-mac");
        assert_eq!(entry_for(&file, "linux"), "run.sh");

        let unix: PluginFile = serde_json::from_str(
            r#"{ "id": "x", "version": "1", "api": 1, "entry": "run.cmd",
                 "entries": { "unix": "run.sh" } }"#,
        )
        .unwrap();
        assert_eq!(entry_for(&unix, "linux"), "run.sh");
        assert_eq!(entry_for(&unix, "windows"), "run.cmd");
    }

    #[tokio::test]
    async fn staging_folders_and_skipped_ids_are_not_started() {
        let dir = std::env::temp_dir().join(format!("lilo-plugins-{}", uuid::Uuid::new_v4()));
        for name in [".staging-com.acme.x", "skipped"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
            // A broken entry: starting it would be reported as a failure.
            std::fs::write(
                dir.join(name).join("plugin.json"),
                r#"{ "id": "com.acme.x", "version": "1", "api": 1, "entry": "missing.sh" }"#,
            )
            .unwrap();
        }
        let outcome = load_dir_except(&dir, |id| id == "com.acme.x").await;
        assert!(outcome.plugins.is_empty());
        assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_unsafe_id_is_refused_before_anything_starts() {
        let dir = std::env::temp_dir().join(format!("lilo-plugins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("evil")).unwrap();
        std::fs::write(
            dir.join("evil/plugin.json"),
            r#"{ "id": "../../evil", "version": "1", "api": 1, "entry": "run.sh" }"#,
        )
        .unwrap();
        let outcome = load_dir(&dir).await;
        assert_eq!(outcome.failed.len(), 1);
        assert!(
            outcome.failed[0].1.contains("invalid id"),
            "{:?}",
            outcome.failed
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_missing_plugins_directory_is_not_an_error() {
        let outcome = load_dir(Path::new("/definitely/not/here")).await;
        assert!(outcome.plugins.is_empty());
        assert!(outcome.failed.is_empty());
    }

    #[tokio::test]
    async fn a_directory_without_a_manifest_is_skipped() {
        let dir = std::env::temp_dir().join(format!("lilo-plugins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("not-a-plugin")).unwrap();
        let outcome = load_dir(&dir).await;
        assert!(outcome.plugins.is_empty());
        assert!(outcome.failed.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_deactivated_plugin_is_not_started_and_not_an_error() {
        let dir = std::env::temp_dir().join(format!("lilo-plugins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("com.acme.off")).unwrap();
        std::fs::write(
            dir.join("com.acme.off/plugin.json"),
            r#"{ "id": "com.acme.off", "version": "1", "api": 1, "entry": "run.sh" }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("com.acme.off")
                .join(crate::plugins::store::DISABLED_FILE),
            "",
        )
        .unwrap();
        let outcome = load_dir(&dir).await;
        assert!(
            outcome.plugins.is_empty(),
            "a deactivated plugin must stay stopped"
        );
        assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_broken_manifest_is_reported_not_swallowed() {
        let dir = std::env::temp_dir().join(format!("lilo-plugins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("broken")).unwrap();
        std::fs::write(dir.join("broken/plugin.json"), "{ not json").unwrap();
        let outcome = load_dir(&dir).await;
        assert!(outcome.plugins.is_empty());
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].1.contains("invalid plugin.json"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
