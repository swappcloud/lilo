//! Signed desktop updates discovered in this repository's GitHub releases.

use crate::error::AppError;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES: &str = "https://api.github.com/repos/swappcloud/lilo/releases?per_page=20";
const EVENT: &str = "app-update";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub status: String,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub progress: Option<u8>,
    pub error: Option<String>,
    pub installable: bool,
}
impl Default for UpdateInfo {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            current_version: env!("CARGO_PKG_VERSION").into(),
            version: None,
            notes: None,
            progress: None,
            error: None,
            installable: !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some(),
        }
    }
}

#[derive(Default)]
pub struct UpdateManager {
    status: Mutex<UpdateInfo>,
    update: tokio::sync::Mutex<Option<Update>>,
    installing: AtomicBool,
}
impl UpdateManager {
    fn publish(&self, app: &AppHandle, info: UpdateInfo) -> UpdateInfo {
        let previous = self.snapshot();
        if previous.status != info.status
            || previous.progress.map(|value| value / 10) != info.progress.map(|value| value / 10)
        {
            crate::logging::log(
                "updater",
                &format!(
                    "stage={} progress={}",
                    info.status,
                    info.progress
                        .map_or_else(|| "unknown".into(), |value| value.to_string())
                ),
            );
        }
        if let Ok(mut status) = self.status.lock() {
            *status = info.clone();
        }
        let _ = app.emit(EVENT, &info);
        info
    }
    fn snapshot(&self) -> UpdateInfo {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }
}

#[tauri::command]
pub async fn app_update_confirm(
    app: AppHandle,
    state: State<'_, UpdateManager>,
    version: String,
    title: String,
    message: String,
    confirm_label: String,
    cancel_label: String,
) -> Result<bool, AppError> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    if state.snapshot().version.as_deref() != Some(version.as_str()) {
        return Ok(false);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm_label,
            cancel_label,
        ))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });
    let accepted = rx.await.unwrap_or(false);
    crate::logging::log(
        "updater",
        if accepted {
            "confirmation=accepted"
        } else {
            "confirmation=deferred"
        },
    );
    Ok(accepted)
}

#[cfg(test)]
fn release_manifest(releases: &serde_json::Value, current: &str) -> Result<Option<String>, String> {
    release_manifest_for(releases, current, None)
}

fn release_manifest_for(
    releases: &serde_json::Value,
    current: &str,
    artifact: Option<&str>,
) -> Result<Option<String>, String> {
    let current = semver::Version::parse(current).map_err(|error| error.to_string())?;
    let releases = releases
        .as_array()
        .ok_or("GitHub returned an invalid release list")?;
    let mut latest: Option<(semver::Version, String)> = None;
    for release in releases {
        if release.get("draft").and_then(|value| value.as_bool()) == Some(true) {
            continue;
        }
        let Some(tag) = release.get("tag_name").and_then(|value| value.as_str()) else {
            continue;
        };
        let Ok(version) = semver::Version::parse(tag.trim_start_matches('v')) else {
            continue;
        };
        if version <= current
            || latest
                .as_ref()
                .is_some_and(|(latest, _)| *latest >= version)
        {
            continue;
        }
        let Some(assets) = release.get("assets").and_then(|value| value.as_array()) else {
            continue;
        };
        if let Some(artifact) = artifact {
            let name = format!("LILO_{version}_{artifact}");
            let expected =
                format!("https://github.com/swappcloud/lilo/releases/download/{tag}/{name}");
            if !assets.iter().any(|asset| {
                asset.get("name").and_then(|value| value.as_str()) == Some(&name)
                    && asset
                        .get("browser_download_url")
                        .and_then(|value| value.as_str())
                        == Some(&expected)
            }) {
                continue;
            }
        }
        let expected =
            format!("https://github.com/swappcloud/lilo/releases/download/{tag}/latest.json");
        if assets.iter().any(|asset| {
            asset.get("name").and_then(|value| value.as_str()) == Some("latest.json")
                && asset
                    .get("browser_download_url")
                    .and_then(|value| value.as_str())
                    == Some(&expected)
        }) {
            latest = Some((version, expected));
        }
    }
    Ok(latest.map(|(_, url)| url))
}

#[tauri::command]
pub fn app_update_status(state: State<'_, UpdateManager>) -> UpdateInfo {
    state.snapshot()
}

#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    state: State<'_, UpdateManager>,
) -> Result<UpdateInfo, AppError> {
    if state.installing.load(Ordering::SeqCst) {
        return Ok(state.snapshot());
    }
    let mut pending = state.update.lock().await;
    state.publish(
        &app,
        UpdateInfo {
            status: "checking".into(),
            ..state.snapshot()
        },
    );
    let check = async {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .user_agent(concat!("LILO/", env!("CARGO_PKG_VERSION")))
            .build()?;
        let releases: serde_json::Value = http
            .get(RELEASES)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let artifact = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => Some("Windows_x64-setup.exe"),
            ("macos", "aarch64") => Some("macOS_Apple-Silicon.app.tar.gz"),
            ("macos", "x86_64") => Some("macOS_Intel.app.tar.gz"),
            ("linux", "x86_64") => Some("Linux_x64.AppImage"),
            _ => {
                return Err(AppError::other(
                    "No desktop update package is available for this platform.",
                ))
            }
        };
        let url = release_manifest_for(&releases, env!("CARGO_PKG_VERSION"), artifact)
            .map_err(AppError::other)?;
        let Some(url) = url else {
            return Ok::<_, AppError>(None);
        };
        app.updater_builder()
            .endpoints(vec![url.parse().map_err(|error| {
                AppError::other(format!("Invalid update URL: {error}"))
            })?])
            .map_err(|error| AppError::other(error.to_string()))?
            .build()
            .map_err(|error| AppError::other(error.to_string()))?
            .check()
            .await
            .map_err(|error| AppError::other(error.to_string()))
    }
    .await;
    match check {
        Ok(update) => {
            let info = UpdateInfo {
                status: if update.is_some() {
                    "available"
                } else {
                    "upToDate"
                }
                .into(),
                version: update.as_ref().map(|update| update.version.clone()),
                notes: update.as_ref().and_then(|update| update.body.clone()),
                ..UpdateInfo::default()
            };
            *pending = update;
            Ok(state.publish(&app, info))
        }
        Err(error) => {
            state.publish(
                &app,
                UpdateInfo {
                    status: "error".into(),
                    error: Some(error.to_string()),
                    ..state.snapshot()
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, UpdateManager>,
    version: String,
) -> Result<(), AppError> {
    if !state.snapshot().installable {
        return Err(AppError::other(
            "Download the Linux package from LILO's GitHub release to update this installation.",
        ));
    }
    let sessions = app.state::<crate::AppState>();
    if sessions.bindings.active() > 0
        || sessions.claude_voice.active()
        || sessions.grok_voice.active()
    {
        return Err(AppError::other("End the voice call before updating LILO."));
    }
    let pending = state.update.lock().await;
    let update = pending
        .as_ref()
        .ok_or_else(|| AppError::other("Check for updates first."))?;
    if update.version != version {
        return Err(AppError::other(
            "The available update changed. Check for updates and confirm the new version.",
        ));
    }
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(AppError::other("An update is already installing."));
    }
    let info = state.snapshot();
    state.publish(
        &app,
        UpdateInfo {
            status: "downloading".into(),
            error: None,
            progress: Some(0),
            ..info.clone()
        },
    );
    let mut downloaded = 0u64;
    let outcome = update
        .download_and_install(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let progress = total
                    .filter(|total| *total > 0)
                    .map(|total| ((downloaded.saturating_mul(100) / total).min(100)) as u8);
                state.publish(
                    &app,
                    UpdateInfo {
                        status: "downloading".into(),
                        progress,
                        ..info.clone()
                    },
                );
            },
            || {
                state.publish(
                    &app,
                    UpdateInfo {
                        status: "installing".into(),
                        progress: Some(100),
                        ..info.clone()
                    },
                );
            },
        )
        .await;
    state.installing.store(false, Ordering::SeqCst);
    match outcome {
        Ok(()) => {
            crate::shutdown(&app);
            app.restart();
        }
        Err(error) => {
            state.publish(
                &app,
                UpdateInfo {
                    status: "error".into(),
                    error: Some(error.to_string()),
                    ..info
                },
            );
            Err(AppError::other(error.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_release_manifest_skips_updates_without_this_platform() {
        let releases = json!([
            { "tag_name": "0.3.0", "assets": [
                { "name": "latest.json", "browser_download_url": "https://github.com/swappcloud/lilo/releases/download/0.3.0/latest.json" },
                { "name": "LILO_0.3.0_macOS_Intel.app.tar.gz", "browser_download_url": "https://github.com/swappcloud/lilo/releases/download/0.3.0/LILO_0.3.0_macOS_Intel.app.tar.gz" }
            ] },
            { "tag_name": "0.2.0", "assets": [
                { "name": "latest.json", "browser_download_url": "https://github.com/swappcloud/lilo/releases/download/0.2.0/latest.json" },
                { "name": "LILO_0.2.0_Windows_x64-setup.exe", "browser_download_url": "https://github.com/swappcloud/lilo/releases/download/0.2.0/LILO_0.2.0_Windows_x64-setup.exe" }
            ] }
        ]);
        assert_eq!(
            release_manifest_for(&releases, "0.1.1", Some("Windows_x64-setup.exe")).unwrap(),
            Some("https://github.com/swappcloud/lilo/releases/download/0.2.0/latest.json".into())
        );
    }

    #[test]
    fn test_release_manifest_includes_prereleases_and_skips_drafts() {
        let releases = json!([
            { "draft": true, "tag_name": "0.3.0", "assets": [{ "name": "latest.json", "browser_download_url": "https://github.com/swappcloud/lilo/releases/download/0.3.0/latest.json" }] },
            { "draft": false, "prerelease": true, "tag_name": "0.2.0", "assets": [{ "name": "latest.json", "browser_download_url": "https://github.com/swappcloud/lilo/releases/download/0.2.0/latest.json" }] }
        ]);
        assert_eq!(
            release_manifest(&releases, "0.1.1").unwrap(),
            Some("https://github.com/swappcloud/lilo/releases/download/0.2.0/latest.json".into())
        );
    }

    #[test]
    fn test_release_manifest_checks_versions_and_repository() {
        let releases = json!([
            { "tag_name": "0.9.0", "assets": [{ "name": "latest.json", "browser_download_url": "https://example.com/installer" }] },
            { "tag_name": "0.1.2", "assets": [{ "name": "latest.json", "browser_download_url": "https://github.com/swappcloud/lilo/releases/download/0.1.2/latest.json" }] },
            { "tag_name": "0.1.10", "assets": [{ "name": "latest.json", "browser_download_url": "https://github.com/swappcloud/lilo/releases/download/0.1.10/latest.json" }] }
        ]);
        assert_eq!(
            release_manifest(&releases, "0.1.2").unwrap(),
            Some("https://github.com/swappcloud/lilo/releases/download/0.1.10/latest.json".into())
        );
        assert_eq!(release_manifest(&releases, "0.1.10").unwrap(), None);
        assert!(release_manifest(&json!({}), "0.1.0").is_err());
    }
}
