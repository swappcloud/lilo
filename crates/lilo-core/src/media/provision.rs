//! Fetching the media binaries so the user never has to install anything.
//!
//! Rules, because this downloads and then *executes* code:
//!   * exact versions and SHA-256 digests are pinned in this file — never taken
//!     from the server that served the download;
//!   * HTTPS only;
//!   * a file whose digest does not match is deleted, never run;
//!   * everything lands under the app data directory, not on `PATH`.
//!
//! Coverage is honest rather than optimistic: where no trustworthy prebuilt
//! exists for a platform, `spec_for` returns `None` and the UI shows the one
//! command that installs it instead of pretending.

use std::path::{Path, PathBuf};

use serde::Serialize;

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
}

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    /// SHA-256 of the downloaded file, verified before anything is executed.
    pub sha256: &'static str,
    pub payload: Payload,
}

/// Pinned yt-dlp release. Digests come from that release's `SHA2-256SUMS`.
const YT_DLP_VERSION: &str = "2026.08.19";

/// Per-platform download. `None` means "we cannot do this safely here".
pub fn spec_for(tool: &str) -> Option<ToolSpec> {
    match tool {
        "yt-dlp" => yt_dlp_spec(),
        "mpv" => mpv_spec(),
        "deno" => deno_spec(),
        _ => None,
    }
}

fn deno_spec() -> Option<ToolSpec> {
    // Digests are pinned from GitHub's release asset metadata, independently
    // of the binary download. ARM headless targets keep the HTTP resolver.
    let (asset, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "deno-x86_64-pc-windows-msvc.zip",
            "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238",
        ),
        ("macos", "aarch64") => (
            "deno-aarch64-apple-darwin.zip",
            "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c",
        ),
        ("macos", "x86_64") => (
            "deno-x86_64-apple-darwin.zip",
            "95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a",
        ),
        ("linux", "x86_64") => (
            "deno-x86_64-unknown-linux-gnu.zip",
            "c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490",
        ),
        _ => return None,
    };
    Some(ToolSpec {
        name: "deno",
        version: "2.9.7",
        url: Box::leak(
            format!("https://github.com/denoland/deno/releases/download/v2.9.7/{asset}")
                .into_boxed_str(),
        ),
        sha256,
        payload: Payload::Zip {
            entry: if cfg!(windows) { "deno.exe" } else { "deno" },
        },
    })
}

fn yt_dlp_spec() -> Option<ToolSpec> {
    // macOS and Windows take the *onedir* build (a zip with the interpreter
    // unpacked beside the executable). The single-file build unpacks ~37 MB
    // into a temp folder on every launch, which Gatekeeper / Defender then
    // scan: measured 6 s per start on macOS against 0.2 s for onedir. Playing a
    // song runs yt-dlp twice (search, then mpv resolving the stream), so that
    // was ~15 s of waiting per request.
    let (asset, sha256, payload) = if cfg!(target_os = "macos") {
        // A universal2 build: one asset for both Apple architectures.
        (
            "yt-dlp_macos.zip",
            "07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8",
            Payload::Zip {
                entry: "yt-dlp_macos",
            },
        )
    } else if cfg!(target_os = "windows") {
        (
            "yt-dlp_win.zip",
            "30b4c14aafab6082becff7881e41b76df46dc43ea7633479410a91e29da492bf",
            Payload::Zip {
                entry: "yt-dlp.exe",
            },
        )
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        (
            "yt-dlp_linux",
            "58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a",
            Payload::Executable,
        )
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        (
            "yt-dlp_linux_aarch64",
            "b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc",
            Payload::Executable,
        )
    } else {
        // 32-bit ARM ships only as a zip, and the headless Linux device path uses the
        // HTTP resolver anyway — it needs no yt-dlp at all.
        return None;
    };

    Some(ToolSpec {
        name: "yt-dlp",
        version: YT_DLP_VERSION,
        url: Box::leak(
            format!("https://github.com/yt-dlp/yt-dlp/releases/download/{YT_DLP_VERSION}/{asset}")
                .into_boxed_str(),
        ),
        sha256,
        payload,
    })
}

fn mpv_spec() -> Option<ToolSpec> {
    // Windows takes the zhongfly build, a .7z mirror of the official one: the
    // upstream Windows builds are .7z only, and libarchive's bsdtar (which
    // ships with Windows and macOS) reads those. macOS is arm64 only for now;
    // Linux has no trustworthy prebuilt for ARM, where mpv comes from the
    // distribution package instead.
    if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        return Some(ToolSpec {
            name: "mpv",
            version: "20260917-git-0b7ed670f7",
            url: "https://github.com/zhongfly/mpv-winbuild/releases/download/2026-09-17-0b7ed670f7/mpv-x86_64-20260917-git-0b7ed670f7.7z",
            sha256: "69c86dd31243963cfac5f6cf98ccbb15ef1a298b6fe96cc318e31e143bff3f02",
            payload: Payload::SevenZip { entry: "mpv.exe" },
        });
    }
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        return Some(ToolSpec {
            name: "mpv",
            version: "0.40.0",
            url: "https://laboratory.stolendata.net/~djinn/mpv_osx/mpv-arm64-0.40.0.tar.gz",
            sha256: "3170fb709defebaba33e9755297d70dc3562220541de54fc3d494a8309ef1260",
            payload: Payload::TarGz {
                entry: "mpv-arm64-0.40.0/mpv.app/Contents/MacOS/mpv",
            },
        });
    }
    None
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
    let dir = install_dir(data_dir);
    match spec_for(tool).map(|spec| spec.payload) {
        // An archive keeps its layout so the bundled libraries stay next to
        // the executable; flattening it would break the build.
        Some(Payload::TarGz { entry } | Payload::Zip { entry } | Payload::SevenZip { entry }) => {
            dir.join(tool).join(entry)
        }
        _ if cfg!(windows) => dir.join(format!("{tool}.exe")),
        _ => dir.join(tool),
    }
}

pub fn is_installed(data_dir: &Path, tool: &str) -> bool {
    managed_path(data_dir, tool).is_file()
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

/// Download, verify and install one tool. Returns the executable's path.
///
/// Already installed is a no-op, so callers may invoke this on every start.
pub async fn ensure(http: &reqwest::Client, data_dir: &Path, tool: &str) -> Result<PathBuf> {
    let target = managed_path(data_dir, tool);
    if target.is_file() {
        return Ok(target);
    }

    let spec = spec_for(tool).ok_or_else(|| {
        AppError::other(format!(
            "no automatic download of {tool} for this platform — install it with `{}`",
            super::binaries::status(tool, "").install_hint
        ))
    })?;

    if !spec.url.starts_with("https://") {
        return Err(AppError::other("refusing a non-HTTPS download"));
    }

    let bytes = http
        .get(spec.url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    let actual = sha256_hex(&bytes);
    if actual != spec.sha256 {
        return Err(AppError::other(format!(
            "{tool} {} failed its checksum — refusing to run it (expected {}, got {actual})",
            spec.version, spec.sha256
        )));
    }

    let dir = install_dir(data_dir);
    std::fs::create_dir_all(&dir)?;

    match spec.payload {
        Payload::Executable => {
            // Write beside the target and rename, so a crash mid-write can
            // never leave a half-file that looks installed.
            let staging = dir.join(format!(".{tool}.part"));
            std::fs::write(&staging, &bytes)?;
            make_executable(&staging)?;
            std::fs::rename(&staging, &target)?;
        }
        Payload::TarGz { .. } | Payload::Zip { .. } | Payload::SevenZip { .. } => {
            let (extension, tar_mode) = match spec.payload {
                Payload::TarGz { .. } => ("tar.gz", "-xzf"),
                Payload::Zip { .. } => ("zip", "-xf"),
                _ => ("7z", "-xf"),
            };
            let root = dir.join(tool);
            let archive = dir.join(format!(".{tool}.part.{extension}"));
            let unpacked = dir.join(format!(".{tool}.part"));
            std::fs::write(&archive, &bytes)?;
            let _ = std::fs::remove_dir_all(&unpacked);
            std::fs::create_dir_all(&unpacked)?;
            // libarchive's bsdtar reads zips and 7z archives; GNU tar does
            // not, hence `archive_extractor` on Windows.
            let mut command = if extension == "zip" && cfg!(target_os = "linux") {
                let mut unzip = super::process::quiet_command("unzip");
                unzip.arg("-oq").arg(&archive).arg("-d").arg(&unpacked);
                unzip
            } else {
                let mut tar = super::process::quiet_command(archive_extractor());
                tar.arg(tar_mode).arg(&archive).arg("-C").arg(&unpacked);
                tar
            };
            let status = command
                .status()
                .map_err(|e| AppError::other(format!("could not extract {tool}: {e}")));
            let _ = std::fs::remove_file(&archive);
            if !status?.success() {
                let _ = std::fs::remove_dir_all(&unpacked);
                return Err(AppError::other(format!("extracting {tool} failed")));
            }
            // Unpack beside, then swap: a crash mid-extract never leaves a
            // half-tree that looks installed.
            // The single-file build this replaces is dead weight, and on macOS
            // and Linux it is a *file* at the very path the folder moves to.
            let legacy = dir.join(if cfg!(windows) {
                format!("{tool}.exe")
            } else {
                tool.to_string()
            });
            if legacy.is_file() {
                std::fs::remove_file(&legacy)?;
            }
            let _ = std::fs::remove_dir_all(&root);
            std::fs::rename(&unpacked, &root)?;
            if !target.is_file() {
                return Err(AppError::other(format!(
                    "{tool} archive did not contain {}",
                    target.display()
                )));
            }
            make_executable(&target)?;
            if extension != "tar.gz" {
                // The first start of a fresh executable is scanned by the OS
                // (7 s measured on macOS). Pay that now, in the background,
                // instead of on the user's first song.
                let warm = target.clone();
                std::thread::spawn(move || {
                    let _ = super::process::quiet_command(warm)
                        .arg("--version")
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                });
            }
        }
    }

    Ok(target)
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
        path: path.map(|p| p.display().to_string()),
        can_install: spec.is_some(),
        install_hint: super::binaries::status(tool, "").install_hint,
        version: spec.map(|s| s.version.to_string()),
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
        for tool in ["yt-dlp", "mpv"] {
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

    #[test]
    fn unknown_tools_have_no_spec() {
        assert!(spec_for("ffmpeg").is_none());
        assert!(spec_for("").is_none());
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
    fn windows_mpv_is_the_7z_build() {
        if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
            let spec = spec_for("mpv").expect("windows x86_64 has a managed mpv");
            assert_eq!(spec.payload, Payload::SevenZip { entry: "mpv.exe" });
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
        let err = ensure(&reqwest::Client::new(), &data, "ffmpeg")
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
        let http = reqwest::Client::new();
        for tool in ["yt-dlp", "mpv"] {
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
        let target = managed_path(&data, "yt-dlp");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"pretend binary").unwrap();
        // No network client that could succeed: proves it short-circuits.
        let path = ensure(&reqwest::Client::new(), &data, "yt-dlp")
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
        let path = ensure(&reqwest::Client::new(), &data, "yt-dlp")
            .await
            .unwrap();
        assert!(path.ends_with("yt-dlp/yt-dlp_macos"), "{}", path.display());
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
