//! The plugin marketplace: a public repository with one folder per plugin.
//!
//! No server of our own. The repository exposes an `index.json` at its root and
//! each plugin lives in its own folder, so a plain GitHub repository plus raw
//! URLs is the whole backend — and `marketplace_url` in settings is the only
//! thing production has to change.
//!
//! ```text
//! <marketplace_url>/index.json                 the catalog
//! <marketplace_url>/plugins/hello/plugin.json  a plugin's files
//! <marketplace_url>/plugins/hello/hello.sh
//! ```
//!
//! The same code path reads a local directory, which is how the whole flow is
//! developed and tested without a network round trip: a `marketplace_url` that
//! is a filesystem path (or `file://…`) is read directly.
//!
//! Trust model, stated plainly: the index carries each file's SHA-256 and every
//! download is verified against it, which makes a corrupted or truncated
//! transfer impossible to install. It does *not* make a hostile index
//! impossible — that needs publisher signatures, which is the next step and
//! why installs are refused when a digest is missing.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::manifest::PluginPresentation;
use crate::error::{AppError, Result};

/// One file a plugin ships, with the digest the host must verify.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
}

/// A plugin listed in the catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api: u32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub localized: std::collections::BTreeMap<String, PluginPresentation>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Operating systems this plugin runs on; empty means all of them. Kept in
    /// step with the manifest by the index builder.
    #[serde(default)]
    pub platforms: Vec<String>,
    /// Runtime hosts this plugin supports. Old catalog entries are desktop-only.
    #[serde(default = "desktop_hosts")]
    pub hosts: Vec<String>,
    /// Folder inside the marketplace, e.g. `plugins/hello`.
    pub path: String,
    /// Executable, relative to the plugin folder.
    pub entry: String,
    pub files: Vec<FileEntry>,
}

fn desktop_hosts() -> Vec<String> {
    vec!["desktop".to_string()]
}

#[derive(Debug, Clone, Deserialize)]
pub struct MarketplaceIndex {
    pub plugins: Vec<MarketplaceEntry>,
}

/// A catalog entry plus what this machine already has.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    #[serde(flatten)]
    pub entry: MarketplaceEntry,
    pub installed: bool,
    pub installed_version: Option<String>,
    /// Installed, and the catalog offers something newer.
    pub update_available: bool,
}

/// Where the catalog lives, resolved once so callers do not repeat the check.
enum Source {
    Http(String),
    Local(PathBuf),
}

/// User-owned state that belongs to the plugin, not to the package: an update
/// replaces the files but keeps these, so a notebook, a configuration and a
/// deliberate deactivation all survive.
const KEPT_ACROSS_UPDATE: [&str; 3] = [
    "data",
    "settings.json",
    crate::plugins::store::DISABLED_FILE,
];

fn source(marketplace_url: &str) -> Result<Source> {
    let trimmed = marketplace_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::other("marketplace URL is not configured"));
    }
    if let Some(rest) = trimmed.strip_prefix("file://") {
        return Ok(Source::Local(PathBuf::from(rest)));
    }
    if trimmed.starts_with("https://") || is_loopback_http(trimmed) {
        return Ok(Source::Http(trimmed.to_string()));
    }
    if trimmed.starts_with("http://") {
        // Digests travel with the index: over plain HTTP anyone on the network
        // can rewrite both the code and the digests that vouch for it.
        return Err(AppError::other(
            "marketplace URL must use https:// (plain http is only allowed for localhost)",
        ));
    }
    // Anything else is a path: the simulation path, used in development.
    Ok(Source::Local(PathBuf::from(trimmed)))
}

fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    if rest.starts_with("[::1]") {
        return true;
    }
    let host = rest.split(['/', ':']).next().unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1")
}

fn join(base: &str, relative: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        relative.trim_start_matches('/')
    )
}

/// Reject a path that could write outside the plugin folder. Both the index and
/// the plugin's own file list are untrusted input.
fn safe_relative(path: &str) -> Result<&str> {
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::other(format!(
            "marketplace path must stay inside the plugin folder: {path}"
        )));
    }
    Ok(path)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Checks `bytes` against the published digest and returns the bytes to
/// install. Digests are taken over LF contents, but a marketplace folder
/// checked out on Windows (core.autocrlf) or copied between machines can
/// carry CRLF: a file whose only difference is its line endings is accepted
/// and installed as the LF original.
fn verified_bytes(bytes: Vec<u8>, expected: &str) -> std::result::Result<Vec<u8>, String> {
    let expected = expected.trim();
    let digest = sha256_hex(&bytes);
    if digest.eq_ignore_ascii_case(expected) {
        return Ok(bytes);
    }
    if bytes.windows(2).any(|pair| pair == b"\r\n") {
        let mut lf = Vec::with_capacity(bytes.len());
        let mut iter = bytes.iter().peekable();
        while let Some(&byte) = iter.next() {
            if byte == b'\r' && iter.peek() == Some(&&b'\n') {
                continue;
            }
            lf.push(byte);
        }
        if sha256_hex(&lf).eq_ignore_ascii_case(expected) {
            return Ok(lf);
        }
    }
    Err(digest)
}

async fn fetch_bytes(http: &reqwest::Client, source: &Source, relative: &str) -> Result<Vec<u8>> {
    match source {
        Source::Http(base) => {
            let url = join(base, relative);
            let response = http
                .get(&url)
                .send()
                .await
                .map_err(|error| AppError::other(format!("could not reach {url}: {error}")))?;
            if !response.status().is_success() {
                return Err(AppError::other(format!(
                    "{url} returned {}",
                    response.status()
                )));
            }
            Ok(response.bytes().await?.to_vec())
        }
        Source::Local(root) => {
            let path = root.join(safe_relative(relative)?);
            std::fs::read(&path).map_err(|error| {
                AppError::other(format!("could not read {}: {error}", path.display()))
            })
        }
    }
}

/// The catalog, as published.
pub async fn fetch_index(
    http: &reqwest::Client,
    marketplace_url: &str,
) -> Result<MarketplaceIndex> {
    let source = source(marketplace_url)?;
    let bytes = fetch_bytes(http, &source, "index.json").await?;
    let index: MarketplaceIndex = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::other(format!("invalid marketplace index: {error}")))?;
    for entry in &index.plugins {
        safe_relative(&entry.path)?;
        if !entry.api_is_supported() {
            // Listed, but the UI marks it as needing a newer LILO.
        }
    }
    Ok(index)
}

impl MarketplaceEntry {
    pub fn api_is_supported(&self) -> bool {
        self.api == crate::plugins::PLUGIN_API_VERSION
    }

    /// Whether this plugin runs on `os` (empty `platforms` means all).
    pub fn supports(&self, os: &str) -> bool {
        crate::plugins::loader::supports_platforms(&self.platforms, os)
    }

    pub fn supports_host(&self, host: &str) -> bool {
        self.hosts.iter().any(|target| target == host)
    }
}

/// Installed version read from the plugin's own manifest, if any.
fn installed_version(plugins_root: &Path, id: &str) -> Option<String> {
    let value = crate::plugins::store::load_manifest_value(plugins_root, id)?;
    value.get("version")?.as_str().map(str::to_string)
}

fn installed_version_for_host(plugins_root: &Path, id: &str, host: &str) -> Option<String> {
    let value = crate::plugins::store::load_manifest_value(plugins_root, id)?;
    let file: crate::plugins::PluginFile = serde_json::from_value(value).ok()?;
    file.supports_host(host).then_some(file.version)
}

/// `1.10.0` > `1.9.2`. Missing parts count as zero; anything after a `-` or `+`
/// (pre-release, build) is ignored. Not full semver on purpose: plugin
/// versions are plain dotted numbers, and a crate for this would be heavier
/// than the feature.
fn version_newer(candidate: &str, installed: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        version
            .trim()
            .trim_start_matches('v')
            .split(['-', '+'])
            .next()
            .unwrap_or("")
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(candidate), parts(installed));
    for index in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(index).copied().unwrap_or(0),
            b.get(index).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/// The catalog annotated with what is installed here.
///
/// Plugins for another OS are left out: offering a macOS-only helper on
/// Windows ends in a download that can never start.
pub fn annotate(index: MarketplaceIndex, plugins_root: &Path) -> Vec<CatalogEntry> {
    annotate_for_host(index, plugins_root, "desktop")
}

pub fn annotate_for_host(
    index: MarketplaceIndex,
    plugins_root: &Path,
    host: &str,
) -> Vec<CatalogEntry> {
    index
        .plugins
        .into_iter()
        .filter(|entry| {
            !super::loader::is_retired(&entry.id)
                && entry.supports(std::env::consts::OS)
                && entry.supports_host(host)
        })
        .map(|entry| {
            let installed = if host == "desktop" {
                installed_version(plugins_root, &entry.id)
            } else {
                installed_version_for_host(plugins_root, &entry.id, host)
            };
            CatalogEntry {
                // Only a newer version is an update: an older catalog (a mirror
                // lagging behind, a local build) must not offer a downgrade.
                update_available: installed
                    .as_deref()
                    .is_some_and(|version| version_newer(&entry.version, version)),
                installed: installed.is_some(),
                installed_version: installed,
                entry,
            }
        })
        .collect()
}

/// Download, verify and write a plugin into `<plugins_root>/<id>`.
///
/// Files land in a staging directory first and are moved into place only after
/// every digest matches: a half-installed plugin that the host would then try
/// to start is worse than no plugin at all.
pub async fn install(
    http: &reqwest::Client,
    marketplace_url: &str,
    entry: &MarketplaceEntry,
    plugins_root: &Path,
) -> Result<()> {
    if super::loader::is_retired(&entry.id) {
        return Err(AppError::other(
            "This application launcher was replaced by bundled Computer control.",
        ));
    }
    if !entry.supports(std::env::consts::OS) {
        return Err(AppError::other(format!(
            "{} does not run on this system",
            entry.name
        )));
    }
    if !entry.api_is_supported() {
        return Err(AppError::other(format!(
            "{} needs a newer LILO (api {} vs {})",
            entry.name,
            entry.api,
            crate::plugins::PLUGIN_API_VERSION
        )));
    }
    if entry.files.is_empty() {
        return Err(AppError::other(format!(
            "{} lists no files to install",
            entry.name
        )));
    }
    let source = source(marketplace_url)?;
    let id = crate::plugins::store::safe_segment(&entry.id)?;
    let staging = plugins_root.join(format!(".staging-{id}"));

    let result = stage_and_swap(http, &source, entry, &staging, plugins_root, id).await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

async fn stage_and_swap(
    http: &reqwest::Client,
    source: &Source,
    entry: &MarketplaceEntry,
    staging: &Path,
    plugins_root: &Path,
    id: &str,
) -> Result<()> {
    let _ = std::fs::remove_dir_all(staging);
    std::fs::create_dir_all(staging)
        .map_err(|error| AppError::other(format!("could not create staging dir: {error}")))?;

    for file in &entry.files {
        let relative = safe_relative(&file.path)?;
        let bytes = fetch_bytes(http, source, &join(&entry.path, relative)).await?;
        let bytes = verified_bytes(bytes, &file.sha256).map_err(|digest| {
            AppError::other(format!(
                "{} failed its checksum (expected {}, got {digest})",
                file.path, file.sha256
            ))
        })?;
        let destination = staging.join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&destination, &bytes)?;
        // Keep the executable bit: a plugin that cannot be started is not
        // installed. The entry, and any script (a per-platform entry is only
        // named in plugin.json).
        #[cfg(unix)]
        if relative == entry.entry || bytes.starts_with(b"#!") {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o755))?;
        }
    }

    verify_staged_manifest(staging, entry)?;

    let target = plugins_root.join(id);
    // Replace, not merge: an update must not leave files from the old version.
    // The plugin's data and settings are not part of the package, so they are
    // carried across *before* the swap — losing a notebook on upgrade would be
    // unforgivable, and silently losing settings is worse. The deactivation
    // marker travels too: an update must not switch a plugin back on.
    for kept in KEPT_ACROSS_UPDATE {
        let from = target.join(kept);
        if from.exists() {
            let to = staging.join(kept);
            let _ = std::fs::remove_dir_all(&to);
            let _ = std::fs::remove_file(&to);
            if std::fs::rename(&from, &to).is_err() {
                // A failed carry-over must fail the install: swapping now would
                // destroy the user's data.
                return Err(AppError::other(format!(
                    "could not preserve {kept} across the update"
                )));
            }
        }
    }
    let swapped = std::fs::remove_dir_all(&target)
        .or_else(|error| if target.exists() { Err(error) } else { Ok(()) })
        .and_then(|()| std::fs::rename(staging, &target));
    if let Err(error) = swapped {
        // The user's data sits in staging now, and the caller deletes staging
        // on failure: put it back first. (On Windows a running plugin keeps its
        // folder locked, which is exactly how this happens.)
        let _ = std::fs::create_dir_all(&target);
        for kept in KEPT_ACROSS_UPDATE {
            let from = staging.join(kept);
            if from.exists() {
                let _ = std::fs::rename(&from, target.join(kept));
            }
        }
        return Err(AppError::other(format!(
            "could not install plugin: {error}"
        )));
    }
    Ok(())
}

/// The downloaded `plugin.json` must describe what the index promised. The
/// folder is named after the index id while the host loads by the manifest id:
/// if they differ, settings, uninstall and updates would all point at the wrong
/// place.
fn verify_staged_manifest(staging: &Path, entry: &MarketplaceEntry) -> Result<()> {
    let raw = std::fs::read_to_string(staging.join("plugin.json"))
        .map_err(|_| AppError::other(format!("{} ships no plugin.json", entry.name)))?;
    let file: crate::plugins::PluginFile = serde_json::from_str(&raw).map_err(|error| {
        AppError::other(format!("{}: invalid plugin.json: {error}", entry.name))
    })?;
    let mismatch = |field: &str, index: &str, manifest: &str| {
        AppError::other(format!(
            "{}: plugin.json {field} is {manifest:?} but the marketplace lists {index:?}",
            entry.name
        ))
    };
    if file.id != entry.id {
        return Err(mismatch("id", &entry.id, &file.id));
    }
    if file.version != entry.version {
        return Err(mismatch("version", &entry.version, &file.version));
    }
    if file.api != entry.api {
        return Err(mismatch(
            "api",
            &entry.api.to_string(),
            &file.api.to_string(),
        ));
    }
    if file.hosts != entry.hosts {
        return Err(mismatch(
            "hosts",
            &entry.hosts.join(","),
            &file.hosts.join(","),
        ));
    }
    if file.platforms != entry.platforms {
        return Err(mismatch(
            "platforms",
            &entry.platforms.join(","),
            &file.platforms.join(","),
        ));
    }
    Ok(())
}

/// Remove an installed plugin. Settings go with it — they belong to it.
pub fn uninstall(plugins_root: &Path, id: &str) -> Result<()> {
    let target = crate::plugins::store::plugin_dir(plugins_root, id)?;
    if !target.exists() {
        return Err(AppError::other(format!("{id} is not installed")));
    }
    std::fs::remove_dir_all(&target)
        .map_err(|error| AppError::other(format!("could not remove {id}: {error}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_retired_launcher_is_hidden_and_refused_before_installation() {
        let plugin = entry("com.lilo.macapps", "1", vec![]);
        let root = temp("retired");
        assert!(annotate(
            MarketplaceIndex {
                plugins: vec![plugin.clone()]
            },
            &root
        )
        .is_empty());
        let error = install(&reqwest::Client::new(), "invalid-source", &plugin, &root)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("replaced"));
        assert!(std::fs::read_dir(&root).unwrap().next().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    use serde_json::json;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilo-market-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(id: &str, version: &str, files: Vec<FileEntry>) -> MarketplaceEntry {
        MarketplaceEntry {
            id: id.to_string(),
            name: id.to_string(),
            version: version.to_string(),
            api: crate::plugins::PLUGIN_API_VERSION,
            description: String::new(),
            localized: std::collections::BTreeMap::new(),
            capabilities: Vec::new(),
            platforms: Vec::new(),
            hosts: vec!["desktop".to_string()],
            path: format!("plugins/{id}"),
            entry: "run.sh".to_string(),
            files,
        }
    }

    /// A marketplace on disk: the same shape as the repository.
    fn write_marketplace(root: &Path, id: &str, version: &str, body: &str) -> MarketplaceEntry {
        let dir = root.join("plugins").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = format!(
            r#"{{"id":"{id}","name":"{id}","version":"{version}","api":1,"entry":"run.sh"}}"#
        );
        std::fs::write(dir.join("plugin.json"), &manifest).unwrap();
        std::fs::write(dir.join("run.sh"), body).unwrap();
        let files = vec![
            FileEntry {
                path: "plugin.json".into(),
                sha256: sha256_hex(manifest.as_bytes()),
            },
            FileEntry {
                path: "run.sh".into(),
                sha256: sha256_hex(body.as_bytes()),
            },
        ];
        let entry = entry(id, version, files);
        let index = json!({ "plugins": [entry] });
        std::fs::write(
            root.join("index.json"),
            serde_json::to_string_pretty(&index).unwrap(),
        )
        .unwrap();
        entry
    }

    #[tokio::test]
    async fn a_local_marketplace_installs_after_verifying_every_file() {
        let market = temp("market");
        let plugins = temp("plugins");
        let entry = write_marketplace(&market, "com.acme.hello", "1.0.0", "#!/bin/sh\n");
        let http = reqwest::Client::new();

        let index = fetch_index(&http, market.to_str().unwrap()).await.unwrap();
        assert_eq!(index.plugins.len(), 1);
        install(&http, market.to_str().unwrap(), &entry, &plugins)
            .await
            .expect("install must succeed");

        assert!(plugins.join("com.acme.hello/run.sh").is_file());
        assert!(plugins.join("com.acme.hello/plugin.json").is_file());
        assert_eq!(
            installed_version(&plugins, "com.acme.hello").as_deref(),
            Some("1.0.0")
        );

        let _ = std::fs::remove_dir_all(market);
        let _ = std::fs::remove_dir_all(plugins);
    }

    #[tokio::test]
    async fn a_tampered_file_fails_its_checksum_and_nothing_is_installed() {
        let market = temp("tamper");
        let plugins = temp("plugins");
        let entry = write_marketplace(&market, "com.acme.bad", "1.0.0", "#!/bin/sh\n");
        // The file changes after the index was published.
        std::fs::write(
            market.join("plugins/com.acme.bad/run.sh"),
            "#!/bin/sh\nrm -rf /\n",
        )
        .unwrap();
        let http = reqwest::Client::new();

        let error = install(&http, market.to_str().unwrap(), &entry, &plugins)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("checksum"), "{error}");
        assert!(
            !plugins.join("com.acme.bad").exists(),
            "a failed install must leave nothing behind"
        );
        assert!(
            !plugins.join(".staging-com.acme.bad").exists(),
            "the staging directory must be cleaned up"
        );

        let _ = std::fs::remove_dir_all(market);
        let _ = std::fs::remove_dir_all(plugins);
    }

    #[test]
    fn daemon_catalog_omits_desktop_only_plugins() {
        let desktop = entry("com.example.desktop", "1", vec![]);
        let mut daemon = entry("com.example.daemon", "1", vec![]);
        daemon.hosts.push("daemon".into());
        let root = temp("hosts");
        let catalog = annotate_for_host(
            MarketplaceIndex {
                plugins: vec![desktop, daemon],
            },
            &root,
            "daemon",
        );
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].entry.id, "com.example.daemon");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn daemon_catalog_offers_reinstall_for_an_installed_desktop_only_plugin() {
        let root = temp("host-upgrade");
        let installed = root.join("com.example.daemon");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(
            installed.join("plugin.json"),
            r#"{"id":"com.example.daemon","version":"1","api":1,"entry":"plugin.js"}"#,
        )
        .unwrap();
        let mut daemon = entry("com.example.daemon", "1", vec![]);
        daemon.hosts.push("daemon".into());
        let catalog = annotate_for_host(
            MarketplaceIndex {
                plugins: vec![daemon],
            },
            &root,
            "daemon",
        );
        assert_eq!(catalog.len(), 1);
        assert!(!catalog[0].installed);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_marketplace_entries_default_to_desktop_only() {
        let value = serde_json::json!({
            "id": "com.example.old", "name": "Old", "version": "1", "api": 1,
            "path": "old", "entry": "old.js", "files": []
        });
        let parsed: MarketplaceEntry = serde_json::from_value(value).unwrap();
        assert!(parsed.supports_host("desktop"));
        assert!(!parsed.supports_host("daemon"));
    }

    #[test]
    fn catalog_entries_report_install_and_update_state() {
        let market = temp("annotate");
        let plugins = temp("plugins");
        let mut entry = write_marketplace(&market, "com.acme.x", "2.0.0", "#!/bin/sh\n");
        entry.version = "2.0.0".to_string();
        let index = MarketplaceIndex {
            plugins: vec![entry.clone()],
        };

        let fresh = annotate(index, &plugins);
        assert!(!fresh[0].installed);
        assert!(!fresh[0].update_available);

        // Same id on disk, older version: an update is available.
        let installed = plugins.join("com.acme.x");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(
            installed.join("plugin.json"),
            r#"{"id":"com.acme.x","version":"1.0.0"}"#,
        )
        .unwrap();
        let stale = annotate(
            MarketplaceIndex {
                plugins: vec![entry],
            },
            &plugins,
        );
        assert!(stale[0].installed);
        assert!(stale[0].update_available);
        assert_eq!(stale[0].installed_version.as_deref(), Some("1.0.0"));

        let _ = std::fs::remove_dir_all(market);
        let _ = std::fs::remove_dir_all(plugins);
    }

    #[test]
    fn an_index_path_may_not_escape() {
        assert!(safe_relative("plugins/hello").is_ok());
        assert!(safe_relative("../../etc").is_err());
        assert!(safe_relative("/etc/passwd").is_err());
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(version_newer("1.10.0", "1.9.2"));
        assert!(version_newer("2", "1.9"));
        assert!(version_newer("1.0.1", "1.0"));
        assert!(!version_newer("1.0.0", "1.0.0"));
        assert!(
            !version_newer("1.0.0", "1.2.0"),
            "a downgrade is not an update"
        );
        assert!(!version_newer("1.0.0-beta", "1.0.0"));
    }

    #[test]
    fn plain_http_is_refused_except_on_this_machine() {
        assert!(source("http://example.com/market").is_err());
        assert!(matches!(
            source("http://localhost:8080/m"),
            Ok(Source::Http(_))
        ));
        assert!(matches!(source("http://127.0.0.1/m"), Ok(Source::Http(_))));
        assert!(matches!(source("http://[::1]:9000/m"), Ok(Source::Http(_))));
        assert!(source("http://[2001:db8::1]/m").is_err());
        assert!(source("http://localhost.evil.example/m").is_err());
        assert!(source("http://localhost@evil.example/m").is_err());
    }

    #[tokio::test]
    async fn a_manifest_that_disagrees_with_the_index_is_not_installed() {
        let market = temp("mismatch");
        let plugins = temp("plugins");
        let mut entry = write_marketplace(&market, "com.acme.real", "1.0.0", "#!/bin/sh\n");
        // The index claims another identity than the files it points to.
        entry.id = "com.acme.other".to_string();
        let http = reqwest::Client::new();
        let error = install(&http, market.to_str().unwrap(), &entry, &plugins)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("plugin.json id"), "{error}");
        assert!(!plugins.join("com.acme.other").exists());
        let _ = std::fs::remove_dir_all(market);
        let _ = std::fs::remove_dir_all(plugins);
    }

    #[test]
    fn a_url_is_required() {
        assert!(source("   ").is_err());
        assert!(matches!(source("https://x/y"), Ok(Source::Http(_))));
        assert!(matches!(source("/tmp/market"), Ok(Source::Local(_))));
        assert!(matches!(source("file:///tmp/market"), Ok(Source::Local(_))));
    }

    /// A Windows checkout rewrites plugin files to CRLF; that alone must not
    /// fail the install, and the LF original is what gets installed.
    #[test]
    fn a_crlf_copy_passes_its_lf_digest() {
        let lf = b"let a = 1;\nlet b = 2;\n".to_vec();
        let crlf = b"let a = 1;\r\nlet b = 2;\r\n".to_vec();
        let digest = sha256_hex(&lf);
        assert_eq!(verified_bytes(crlf, &digest).unwrap(), lf);
        assert_eq!(verified_bytes(lf.clone(), &digest).unwrap(), lf);
        assert!(verified_bytes(b"let a = 2;\n".to_vec(), &digest).is_err());
    }

    /// The footgun that matters: edit a plugin, forget to run
    /// `scripts/build-marketplace.sh`, and publish a marketplace whose digests
    /// no longer match. It would fail for every user, at install time.
    #[test]
    fn the_shipped_marketplace_matches_its_digests() {
        // One copy of each plugin: the index lives beside the folders it
        // describes, and the app bundles that same folder as its marketplace.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins");
        let raw = std::fs::read_to_string(root.join("index.json"))
            .expect("examples/plugins/index.json — run scripts/build-marketplace.sh");
        let index: MarketplaceIndex = serde_json::from_str(&raw).expect("valid index");

        let ids: Vec<&str> = index.plugins.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"com.lilo.hello"), "{ids:?}");
        assert!(ids.contains(&"com.lilo.notes"), "{ids:?}");

        for plugin in &index.plugins {
            let manifest: super::super::loader::PluginFile = serde_json::from_str(
                &std::fs::read_to_string(root.join(&plugin.path).join("plugin.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                plugin.name, manifest.name,
                "catalog names come from the manifest"
            );
            assert_eq!(plugin.description, manifest.description);
            assert_eq!(plugin.localized, manifest.localized);
            assert_eq!(plugin.capabilities, manifest.capabilities);
            assert!(
                plugin.api_is_supported(),
                "{} is published for another api",
                plugin.id
            );
            for file in &plugin.files {
                let path = root.join(&plugin.path).join(&file.path);
                let bytes =
                    std::fs::read(&path).unwrap_or_else(|_| panic!("missing {}", path.display()));
                assert!(
                    verified_bytes(bytes, &file.sha256).is_ok(),
                    "{} is stale — run scripts/build-marketplace.sh",
                    path.display()
                );
            }
        }
    }

    /// A manifest without a `runtime` silently falls back to `process`, which
    /// is how the macOS apps example stopped saying how it runs. The bundled
    /// examples are the templates publishers copy, so each must declare it.
    #[test]
    fn every_shipped_plugin_declares_its_runtime() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins");
        let mut checked = 0;
        for entry in std::fs::read_dir(&root)
            .expect("examples/plugins")
            .flatten()
        {
            let manifest = entry.path().join("plugin.json");
            if !manifest.is_file() {
                continue;
            }
            let file: crate::plugins::loader::PluginFile =
                serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap())
                    .unwrap_or_else(|error| panic!("{}: {error}", manifest.display()));
            assert!(
                matches!(file.runtime.as_str(), "process" | "quickjs"),
                "{} must declare \"runtime\": \"process\" or \"quickjs\"",
                manifest.display()
            );
            checked += 1;
        }
        assert!(
            checked >= 4,
            "expected the bundled examples, found {checked}"
        );
    }

    #[tokio::test]
    async fn an_update_keeps_the_plugins_data_and_settings() {
        let market = temp("keep-market");
        let plugins = temp("keep-plugins");
        let entry = write_marketplace(
            &market,
            "com.acme.keep",
            "1.0.0",
            "#!/bin/sh
",
        );
        let http = reqwest::Client::new();
        install(&http, market.to_str().unwrap(), &entry, &plugins)
            .await
            .unwrap();

        // The plugin has been used: it owns data, and the user configured it.
        let installed = plugins.join("com.acme.keep");
        std::fs::create_dir_all(installed.join("data")).unwrap();
        std::fs::write(
            installed.join("data/notes.txt"),
            "buy milk
",
        )
        .unwrap();
        std::fs::write(installed.join("settings.json"), r#"{"max":50}"#).unwrap();

        // A newer version arrives.
        let updated = write_marketplace(
            &market,
            "com.acme.keep",
            "2.0.0",
            "#!/bin/sh
# v2
",
        );
        install(&http, market.to_str().unwrap(), &updated, &plugins)
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(installed.join("data/notes.txt")).unwrap(),
            "buy milk
",
            "an update must not destroy the plugin's data"
        );
        assert_eq!(
            std::fs::read_to_string(installed.join("settings.json")).unwrap(),
            r#"{"max":50}"#
        );
        assert_eq!(
            installed_version(&plugins, "com.acme.keep").as_deref(),
            Some("2.0.0")
        );

        let _ = std::fs::remove_dir_all(market);
        let _ = std::fs::remove_dir_all(plugins);
    }

    #[test]
    fn uninstalling_something_absent_says_so() {
        let plugins = temp("uninstall");
        let error = uninstall(&plugins, "com.acme.nope").unwrap_err();
        assert!(error.to_string().contains("not installed"), "{error}");
        let _ = std::fs::remove_dir_all(plugins);
    }

    #[tokio::test]
    async fn an_update_keeps_a_deactivated_plugin_deactivated() {
        let market = temp("off-market");
        let plugins = temp("off-plugins");
        let entry = write_marketplace(&market, "com.acme.off", "1.0.0", "#!/bin/sh\n");
        let http = reqwest::Client::new();
        install(&http, market.to_str().unwrap(), &entry, &plugins)
            .await
            .unwrap();

        let installed = plugins.join("com.acme.off");
        std::fs::write(installed.join(crate::plugins::store::DISABLED_FILE), "").unwrap();

        let updated = write_marketplace(&market, "com.acme.off", "2.0.0", "#!/bin/sh\n# v2\n");
        install(&http, market.to_str().unwrap(), &updated, &plugins)
            .await
            .unwrap();

        assert!(
            !crate::plugins::store::is_enabled(&plugins, "com.acme.off"),
            "an update must not switch a deactivated plugin back on"
        );
        assert_eq!(
            installed_version(&plugins, "com.acme.off").as_deref(),
            Some("2.0.0")
        );

        let _ = std::fs::remove_dir_all(market);
        let _ = std::fs::remove_dir_all(plugins);
    }
}
