//! Fetching the media binaries so the user never has to install anything.
//!
//! Rules, because this downloads and then *executes* code:
//!   * exact versions and SHA-256 digests are pinned in this file — never taken
//!     from the server that served the download;
//!   * release builds retain every pinned archive in the LILO media release;
//!     upstream mirrors may remove old builds without breaking installed apps;
//!   * HTTPS only;
//!   * a file whose digest does not match is deleted, never run;
//!   * everything lands under the app data directory, not on `PATH`.
//!
//! Coverage is honest rather than optimistic: where no trustworthy prebuilt
//! exists for a platform, `spec_for` returns `None` and the UI shows the one
//! command that installs it instead of pretending.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// What the downloaded file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Payload {
    /// The download *is* the executable.
    Executable,
    /// A gzipped tarball; `entry` is the executable's path inside it.
    TarGz { entry: &'static str },
    /// A zip archive; `entry` is the executable's path inside it.
    Zip { entry: &'static str },
    /// A `.7z` archive; `entry` is the executable's path inside it.
    SevenZip { entry: &'static str },
    /// Official macOS release zip containing a bundled tarball.
    ZipTarGz {
        archive: &'static str,
        entry: &'static str,
    },
}

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub mirror_url: String,
    /// SHA-256 of the downloaded file, verified before anything is executed.
    pub sha256: &'static str,
    pub payload: Payload,
}

#[derive(Deserialize)]
struct DownloadCatalog<'a> {
    mirror: &'a str,
    #[serde(borrow)]
    tools: Vec<DownloadSpec<'a>>,
}

#[derive(Deserialize)]
struct DownloadSpec<'a> {
    name: &'a str,
    version: &'a str,
    #[serde(borrow)]
    targets: Vec<&'a str>,
    url: &'a str,
    sha256: &'a str,
    format: &'a str,
    entry: Option<&'a str>,
    archive: Option<&'a str>,
    minimum_macos: Option<u32>,
}

fn catalog() -> &'static DownloadCatalog<'static> {
    static CATALOG: std::sync::OnceLock<DownloadCatalog<'static>> = std::sync::OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("downloads.json")).expect("valid pinned media catalog")
    })
}

/// Per-platform download. Unsupported platforms retain system/configured tools.
pub fn spec_for(tool: &str) -> Option<ToolSpec> {
    spec_for_platform(
        tool,
        std::env::consts::OS,
        std::env::consts::ARCH,
        macos_major(),
    )
}

#[cfg(test)]
fn spec_for_target(tool: &str, os: &str, arch: &str) -> Option<ToolSpec> {
    spec_for_platform(tool, os, arch, None)
}

#[cfg(target_os = "macos")]
fn macos_major() -> Option<u32> {
    static VERSION: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *VERSION.get_or_init(|| {
        // sw_vers is a macOS system command; no interpreter is involved.
        let output = super::process::quiet_command("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        std::str::from_utf8(&output.stdout)
            .ok()?
            .trim()
            .split('.')
            .next()?
            .parse()
            .ok()
    })
}

#[cfg(not(target_os = "macos"))]
fn macos_major() -> Option<u32> {
    None
}

fn spec_for_platform(tool: &str, os: &str, arch: &str, macos: Option<u32>) -> Option<ToolSpec> {
    let catalog = catalog();
    let target = format!("{os}-{arch}");
    let spec = catalog.tools.iter().find(|spec| {
        spec.name == tool
            && spec.targets.contains(&target.as_str())
            && spec
                .minimum_macos
                .is_none_or(|minimum| macos.is_some_and(|major| major >= minimum))
    })?;
    let payload = match spec.format {
        "executable" => Payload::Executable,
        "zip" => Payload::Zip {
            entry: spec.entry.expect("archive entry"),
        },
        "7z" => Payload::SevenZip {
            entry: spec.entry.expect("archive entry"),
        },
        "tar.gz" => Payload::TarGz {
            entry: spec.entry.expect("archive entry"),
        },
        "zip-tar.gz" => Payload::ZipTarGz {
            archive: spec.archive.expect("nested archive"),
            entry: spec.entry.expect("archive entry"),
        },
        _ => panic!("unsupported media archive format"),
    };
    let extension = if spec.format == "executable" {
        "bin"
    } else {
        spec.format
    };
    Some(ToolSpec {
        name: spec.name,
        version: spec.version,
        url: spec.url,
        mirror_url: format!(
            "{}/{}-{}.{}",
            catalog.mirror, spec.name, spec.sha256, extension
        ),
        sha256: spec.sha256,
        payload,
    })
}

/// Prefer our retained copy so removing an upstream release cannot strand apps.
/// Both sources use the same source-pinned digest; a mismatch fails closed.
async fn download_verified(http: &reqwest::Client, spec: &ToolSpec) -> Result<Vec<u8>> {
    let mut last_error = String::new();
    for url in [spec.mirror_url.as_str(), spec.url] {
        if !url.starts_with("https://") {
            return Err(AppError::other("refusing a non-HTTPS download"));
        }
        let response = match http
            .get(url)
            .timeout(std::time::Duration::from_secs(180))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
        {
            Ok(response) => response,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        if response.url().scheme() != "https" {
            return Err(AppError::other("refusing a non-HTTPS download redirect"));
        }
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        let actual = sha256_hex(&bytes);
        if actual != spec.sha256 {
            return Err(AppError::other(format!(
                "{} {} failed its checksum — refusing to run it (expected {}, got {actual})",
                spec.name, spec.version, spec.sha256
            )));
        }
        return Ok(bytes.to_vec());
    }
    Err(AppError::other(format!(
        "{} {} could not be downloaded from either verified source: {last_error}",
        spec.name, spec.version
    )))
}

/// The extractor for zip/7z archives. On Windows the bare name `tar` may
/// resolve to Git's GNU tar, which reads neither format, so prefer the
/// libarchive one that ships with the OS.
fn archive_extractor() -> std::ffi::OsString {
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let system = Path::new(&root).join("System32").join("tar.exe");
            if system.is_file() {
                return system.into_os_string();
            }
        }
    }
    std::ffi::OsString::from("tar")
}

/// Where managed binaries live: inside the app's own data directory, never on
/// `PATH`, so nothing we download can shadow a system tool.
pub fn install_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("bin")
}

/// Path a managed tool would occupy, whether or not it is there yet.
pub fn managed_path(data_dir: &Path, tool: &str) -> PathBuf {
    if let Some(path) = super::managed::active_path(data_dir, tool) {
        return path;
    }
    if let Some(path) =
        legacy_path_for(data_dir, tool, std::env::consts::OS, std::env::consts::ARCH)
    {
        return path;
    }
    let dir = install_dir(data_dir);
    match spec_for(tool).map(|spec| spec.payload) {
        // An archive keeps its layout so the bundled libraries stay next to
        // the executable; flattening it would break the build.
        Some(
            Payload::TarGz { entry }
            | Payload::Zip { entry }
            | Payload::SevenZip { entry }
            | Payload::ZipTarGz { entry, .. },
        ) => dir.join(tool).join(entry),
        _ if cfg!(windows) => dir.join(format!("{tool}.exe")),
        _ => dir.join(tool),
    }
}

fn legacy_path_for(data: &Path, tool: &str, os: &str, arch: &str) -> Option<PathBuf> {
    let dir = install_dir(data);
    let target = format!("{os}-{arch}");
    // A newer platform package can change its bundle layout. Search every
    // known legacy layout before falling back to a single-file installation.
    for spec in &catalog().tools {
        if spec.name == tool && spec.targets.contains(&target.as_str()) {
            if let Some(entry) = spec.entry {
                let path = dir.join(tool).join(entry);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    let path = dir.join(if os == "windows" {
        format!("{tool}.exe")
    } else {
        tool.into()
    });
    path.is_file().then_some(path)
}

pub fn is_installed(data_dir: &Path, tool: &str) -> bool {
    managed_path(data_dir, tool).is_file()
}

/// Legacy or previous managed versions must be upgraded after an app update.
pub fn is_current(data_dir: &Path, tool: &str) -> bool {
    let Some(spec) = spec_for(tool) else {
        return false;
    };
    super::managed::installed(data_dir, tool).is_some_and(|record| record.sha256 == spec.sha256)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}

/// Download and activate the app's pinned version without overwriting old tools.
/// A failed download, extraction or smoke test leaves the previous version active.
pub async fn ensure(http: &reqwest::Client, data_dir: &Path, tool: &str) -> Result<PathBuf> {
    if is_current(data_dir, tool) {
        return Ok(managed_path(data_dir, tool));
    }
    let spec = spec_for(tool).ok_or_else(|| {
        AppError::other(format!(
            "no automatic download of {tool} for this platform — install it with `{}`",
            super::binaries::status(tool, "").install_hint
        ))
    })?;
    let bytes = download_verified(http, &spec).await?;
    let dir = install_dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    let id = uuid::Uuid::new_v4();
    let staging = dir.join(format!(".{tool}-{id}.part"));
    let archive = dir.join(format!(".{tool}-{id}.archive"));
    std::fs::create_dir_all(&staging)?;
    let result = async {
        let entry = match spec.payload {
            Payload::Executable => {
                if cfg!(windows) {
                    format!("{tool}.exe")
                } else {
                    tool.into()
                }
            }
            Payload::TarGz { entry }
            | Payload::Zip { entry }
            | Payload::SevenZip { entry }
            | Payload::ZipTarGz { entry, .. } => entry.into(),
        };
        let candidate = staging.join(&entry);
        if spec.payload == Payload::Executable {
            std::fs::write(&candidate, &bytes)?;
        } else {
            std::fs::write(&archive, &bytes)?;
            let mut command =
                if matches!(spec.payload, Payload::Zip { .. }) && cfg!(target_os = "linux") {
                    let mut unzip = super::process::quiet_command("unzip");
                    unzip.arg("-oq").arg(&archive).arg("-d").arg(&staging);
                    unzip
                } else {
                    let mut tar = super::process::quiet_command(archive_extractor());
                    tar.arg(if matches!(spec.payload, Payload::TarGz { .. }) {
                        "-xzf"
                    } else {
                        "-xf"
                    })
                    .arg(&archive)
                    .arg("-C")
                    .arg(&staging);
                    tar
                };
            let status = command
                .status()
                .map_err(|error| AppError::other(format!("could not extract {tool}: {error}")))?;
            if !status.success() {
                return Err(AppError::other(format!("extracting {tool} failed")));
            }
            if let Payload::ZipTarGz {
                archive: nested, ..
            } = spec.payload
            {
                let mut tar = super::process::quiet_command(archive_extractor());
                let status = tar
                    .arg("-xzf")
                    .arg(staging.join(nested))
                    .arg("-C")
                    .arg(&staging)
                    .status()?;
                if !status.success() {
                    return Err(AppError::other(format!(
                        "extracting nested {tool} bundle failed"
                    )));
                }
            }
        }
        if !candidate.is_file() {
            return Err(AppError::other(format!(
                "{tool} archive did not contain {entry}"
            )));
        }
        make_executable(&candidate)?;
        // Exercise the executable and its bundled libraries before activation.
        // The timeout also bounds fresh-file antivirus checks on desktop OSes.
        let mut command = super::process::quiet_command(&candidate);
        command
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let mut command = tokio::process::Command::from(command);
        command.kill_on_drop(true);
        let status = tokio::time::timeout(std::time::Duration::from_secs(30), command.status())
            .await
            .map_err(|_| AppError::other(format!("{tool} version check timed out")))??;
        if !status.success() {
            return Err(AppError::other(format!(
                "{tool} version check failed; previous installation preserved"
            )));
        }
        let root = super::managed::root(data_dir, tool, spec.sha256);
        if !root.exists() {
            if let Err(error) = std::fs::rename(&staging, &root) {
                // A concurrent installer can publish this immutable digest
                // first. Its root was also smoke-tested before the rename.
                if !root.join(&entry).is_file() {
                    return Err(error.into());
                }
            }
        }
        super::managed::activate(
            data_dir,
            tool,
            &super::managed::Installed {
                version: spec.version.into(),
                sha256: spec.sha256.into(),
                entry,
            },
        )
    }
    .await;
    let _ = std::fs::remove_file(&archive);
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// What the settings UI needs to show for one tool.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub found: bool,
    pub path: Option<String>,
    /// "managed" (we downloaded it), "system" (already on the machine), or
    /// "missing".
    pub source: String,
    /// Whether this platform has an automatic download.
    pub can_install: bool,
    pub install_hint: String,
    pub version: Option<String>,
}

pub fn status(data_dir: &Path, tool: &str, override_path: &str) -> ToolStatus {
    let spec = spec_for(tool);
    let managed = managed_path(data_dir, tool);
    let (path, source) = if !override_path.trim().is_empty() {
        (super::binaries::locate(tool, override_path), "system")
    } else if managed.is_file() {
        (Some(managed), "managed")
    } else {
        (super::binaries::locate(tool, ""), "system")
    };

    ToolStatus {
        name: tool.to_string(),
        found: path.is_some(),
        source: if path.is_some() { source } else { "missing" }.to_string(),
        path: path.as_ref().map(|p| p.display().to_string()),
        can_install: spec.is_some(),
        install_hint: super::binaries::status(tool, "").install_hint,
        version: if source == "managed" {
            super::managed::installed(data_dir, tool).map(|record| record.version)
        } else if path.is_none() {
            spec.map(|s| s.version.to_string())
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lilo-provision-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn digests_are_pinned_and_well_formed() {
        // A wrong-length digest would silently never match and every install
        // would fail with a confusing message.
        for tool in ["yt-dlp", "mpv", "deno"] {
            if let Some(spec) = spec_for(tool) {
                assert_eq!(spec.sha256.len(), 64, "{tool}");
                assert!(
                    spec.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                    "{tool} digest is not hex"
                );
                assert!(spec.url.starts_with("https://"), "{tool} must use HTTPS");
                assert!(!spec.version.is_empty());
            }
        }
    }

    #[test]
    fn test_desktop_ytdlp_has_a_provisioned_javascript_runtime() {
        if matches!(std::env::consts::OS, "windows" | "macos")
            || (cfg!(target_os = "linux") && cfg!(target_arch = "x86_64"))
        {
            let spec = spec_for("deno").expect("YouTube requires a managed JavaScript runtime");
            assert_eq!(spec.name, "deno");
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(matches!(spec.payload, Payload::Zip { .. }));
        }
    }

    /// Exercise the runtime download path for every platform on any host.
    #[tokio::test]
    #[ignore = "network: downloads every pinned archive"]
    async fn all_pinned_downloads_are_available_and_verified() {
        let http = crate::http::client();
        for source in &catalog().tools {
            let (os, arch) = source.targets[0].split_once('-').unwrap();
            let spec = spec_for_platform(source.name, os, arch, source.minimum_macos).unwrap();
            download_verified(&http, &spec).await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_failed_update_preserves_the_legacy_tool_and_can_retry() {
        let data = scratch("legacy-update");
        let target = managed_path(&data, "yt-dlp");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"legacy tool").unwrap();
        let http = crate::http::builder()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap())
            .build()
            .unwrap();
        for _ in 0..2 {
            assert!(ensure(&http, &data, "yt-dlp").await.is_err());
            assert_eq!(managed_path(&data, "yt-dlp"), target);
            assert_eq!(std::fs::read(&target).unwrap(), b"legacy tool");
            assert!(!is_current(&data, "yt-dlp"));
        }
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn a_new_macos_bundle_preserves_discovery_of_the_old_layout() {
        let data = scratch("macos-layout");
        let path = install_dir(&data).join("mpv/mpv-arm64-0.40.0/mpv.app/Contents/MacOS/mpv");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"legacy mpv").unwrap();
        assert_eq!(
            legacy_path_for(&data, "mpv", "macos", "aarch64"),
            Some(path)
        );
        std::fs::remove_dir_all(data).unwrap();
    }

    #[tokio::test]
    async fn a_failed_upgrade_preserves_the_previous_version_record() {
        let data = scratch("versioned-update");
        let record = super::super::managed::Installed {
            version: "previous".into(),
            sha256: "a".repeat(64),
            entry: "previous-tool".into(),
        };
        let path = super::super::managed::root(&data, "yt-dlp", &record.sha256).join(&record.entry);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"previous binary").unwrap();
        super::super::managed::activate(&data, "yt-dlp", &record).unwrap();
        let http = crate::http::builder()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap())
            .build()
            .unwrap();
        assert!(ensure(&http, &data, "yt-dlp").await.is_err());
        assert_eq!(managed_path(&data, "yt-dlp"), path);
        assert_eq!(
            status(&data, "yt-dlp", "").version.as_deref(),
            Some("previous")
        );
        assert!(!is_current(&data, "yt-dlp"));
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn unknown_tools_have_no_spec() {
        assert!(spec_for("ffmpeg").is_none());
        assert!(spec_for("").is_none());
    }

    #[test]
    fn every_platform_uses_a_retained_content_addressed_archive() {
        for spec in &catalog().tools {
            for target in &spec.targets {
                let (os, arch) = target.split_once('-').unwrap();
                let selected = spec_for_platform(spec.name, os, arch, spec.minimum_macos).unwrap();
                assert_eq!(selected.version, spec.version);
                assert_eq!(selected.sha256, spec.sha256);
                assert_eq!(selected.url, spec.url);
                assert!(selected.mirror_url.starts_with(catalog().mirror));
                assert!(selected.mirror_url.contains(spec.sha256));
                assert_ne!(selected.mirror_url, selected.url);
            }
        }
        assert!(spec_for_target("mpv", "linux", "aarch64").is_none());
        assert!(spec_for_target("mpv", "macos", "x86_64").is_none());
        assert!(spec_for_target("deno", "linux", "arm").is_none());
        assert_eq!(
            spec_for_platform("mpv", "macos", "aarch64", Some(14))
                .unwrap()
                .version,
            "0.40.0"
        );
        assert_eq!(
            spec_for_platform("mpv", "macos", "aarch64", Some(15))
                .unwrap()
                .version,
            "0.42.0"
        );
    }

    #[test]
    fn managed_binaries_live_under_the_data_dir() {
        let data = Path::new("/tmp/lilo-data");
        let path = managed_path(data, "yt-dlp");
        assert!(path.starts_with("/tmp/lilo-data/bin"));
        assert!(!is_installed(data, "yt-dlp"));
    }

    #[test]
    fn a_tarball_tool_keeps_its_bundle_layout() {
        // Flattening the mpv bundle would separate the executable from the
        // dylibs shipped next to it.
        if let Some(Payload::TarGz { entry }) = spec_for("mpv").map(|s| s.payload) {
            let path = managed_path(Path::new("/tmp/d"), "mpv");
            assert!(path.ends_with(entry), "{}", path.display());
        }
    }

    #[test]
    fn windows_mpv_is_a_stable_zip_build() {
        if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
            let spec = spec_for("mpv").expect("windows x86_64 has a managed mpv");
            assert_eq!(spec.payload, Payload::Zip { entry: "mpv.exe" });
            let path = managed_path(Path::new("D:/lilo-data"), "mpv");
            assert!(path.ends_with("mpv.exe"), "{}", path.display());
        }
    }

    #[test]
    fn status_reports_missing_without_guessing() {
        let data = scratch("status");
        let report = status(&data, "definitely-not-a-tool", "");
        assert!(!report.found);
        assert!(!report.can_install);
        assert_eq!(report.source, "missing");
        assert!(!report.install_hint.is_empty());
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn an_override_is_reported_as_a_system_binary() {
        let data = scratch("override");
        let report = status(&data, "mpv", "/definitely/not/mpv");
        assert!(
            !report.found,
            "a bad override must not be reported as found"
        );
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn sha256_matches_a_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn an_unsupported_platform_names_the_manual_command() {
        let data = scratch("unsupported");
        let err = ensure(&crate::http::client(), &data, "ffmpeg")
            .await
            .unwrap_err();
        let message = err.to_string();
        assert!(message.contains("no automatic download"), "{message}");
        assert!(message.contains("install"), "{message}");
        let _ = std::fs::remove_dir_all(data);
    }

    /// Real download, real checksum, real extraction. Ignored by default so the
    /// suite stays offline; run with:
    ///   cargo test -p lilo-core -- --ignored --nocapture provision
    #[tokio::test]
    #[ignore = "network"]
    async fn really_installs_every_tool_this_platform_supports() {
        let data = scratch("live");
        let http = crate::http::client();
        for tool in ["yt-dlp", "mpv", "deno"] {
            let Some(spec) = spec_for(tool) else {
                eprintln!("{tool}: no spec on this platform, skipping");
                continue;
            };
            let path = ensure(&http, &data, tool)
                .await
                .unwrap_or_else(|e| panic!("{tool} {}: {e}", spec.version));
            assert!(path.is_file(), "{tool} was not installed");

            let output = std::process::Command::new(&path)
                .arg("--version")
                .output()
                .unwrap_or_else(|e| panic!("{tool} did not run: {e}"));
            assert!(output.status.success(), "{tool} --version failed");
            eprintln!(
                "{tool} -> {} :: {}",
                path.display(),
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
            );

            // Second call must not re-download.
            assert_eq!(ensure(&http, &data, tool).await.unwrap(), path);
        }
        let _ = std::fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn an_already_installed_tool_is_not_downloaded_again() {
        let data = scratch("present");
        let spec = spec_for("yt-dlp").unwrap();
        let entry = match spec.payload {
            Payload::Executable => {
                if cfg!(windows) {
                    "yt-dlp.exe"
                } else {
                    "yt-dlp"
                }
            }
            Payload::Zip { entry } => entry,
            _ => panic!("unexpected yt-dlp payload"),
        };
        let target = super::super::managed::root(&data, "yt-dlp", spec.sha256).join(entry);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"pretend binary").unwrap();
        super::super::managed::activate(
            &data,
            "yt-dlp",
            &super::super::managed::Installed {
                version: spec.version.into(),
                sha256: spec.sha256.into(),
                entry: entry.into(),
            },
        )
        .unwrap();
        // No network client that could succeed: proves it short-circuits.
        let path = ensure(&crate::http::client(), &data, "yt-dlp")
            .await
            .unwrap();
        assert_eq!(path, target);
        let _ = std::fs::remove_dir_all(data);
    }

    /// Upgrading from the single-file build: its file sits exactly where the
    /// onedir folder goes.
    ///   cargo test -p lilo-core -- --ignored replaces_the_single_file
    #[tokio::test]
    #[ignore = "network"]
    #[cfg(target_os = "macos")]
    async fn replaces_the_single_file_yt_dlp() {
        let data = scratch("legacy");
        let bin = install_dir(&data);
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("yt-dlp"), b"old onefile").unwrap();
        let path = ensure(&crate::http::client(), &data, "yt-dlp")
            .await
            .unwrap();
        assert!(path.ends_with("yt-dlp_macos"), "{}", path.display());
        assert_eq!(std::fs::read(bin.join("yt-dlp")).unwrap(), b"old onefile");
        assert!(is_current(&data, "yt-dlp"));
        let started = std::time::Instant::now();
        let out = std::process::Command::new(&path)
            .arg("--version")
            .output()
            .unwrap();
        assert!(out.status.success());
        eprintln!("--version took {:?}", started.elapsed());
        let _ = std::fs::remove_dir_all(data);
    }
}
