//! Disk usage of the app, and clearing what is safe to clear.
//!
//! Three separate areas, because the user's question is always "what is using
//! the space, and can I get rid of it?" — and the answers differ:
//!   * media    — the downloaded mpv/yt-dlp; deleting them costs a re-download;
//!   * logs     — diagnostic history, safe to drop;
//!   * cache    — sockets, watchdog scripts and heartbeat files, always safe.
//!
//! Sizes are computed by walking the directories. That is O(files) with a tiny
//! constant, and these trees hold a handful of files, not thousands — a
//! recursive walk is simpler and more honest than caching a number that can be
//! wrong.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, Result};

/// Which bucket a path belongs to. Serialized as the key the UI asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageArea {
    Media,
    Logs,
    Cache,
}

impl StorageArea {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "media" => Some(StorageArea::Media),
            "logs" => Some(StorageArea::Logs),
            "cache" => Some(StorageArea::Cache),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaUsage {
    pub area: StorageArea,
    pub bytes: u64,
    /// False when nothing in this area can be removed from the UI.
    pub clearable: bool,
}

/// Parts of LILO's footprint that are **not** offered for clearing here:
/// plugins carry the user's data, and a webview profile is a signed-in
/// session. Shown so the numbers add up, cleared where they belong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageKind {
    /// `<app data>/plugins`, every plugin folder and its data.
    Plugins,
    /// `<app data>/webview`, one WebView2/WKWebView profile per backend.
    Webviews,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub kind: UsageKind,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub areas: Vec<AreaUsage>,
    pub usage: Vec<UsageEntry>,
    pub total_bytes: u64,
}

/// Sum of every regular file under `path`. Missing paths are simply zero.
pub fn dir_size(path: &Path) -> u64 {
    dir_usage(path).0
}

/// Bytes and file count under `path`, in one walk: the settings panel shows
/// both, and walking twice for one screen would be silly.
pub fn dir_usage(path: &Path) -> (u64, u64) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return (0, 0);
    };
    let mut bytes = 0;
    let mut files = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            let (nested_bytes, nested_files) = dir_usage(&entry.path());
            bytes += nested_bytes;
            files += nested_files;
        } else {
            bytes += meta.len();
            files += 1;
        }
    }
    (bytes, files)
}

/// Everything LILO owns, grouped by what a user would recognise.
pub struct StoragePaths {
    /// Downloaded binaries live here (`<app data>/bin`).
    pub media: PathBuf,
    /// `lilo.log`'s directory.
    pub logs: PathBuf,
    /// Sockets, watchdog scripts and heartbeats from live/reaped players.
    pub cache: PathBuf,
    /// Installed plugins, each with its own data.
    pub plugins: PathBuf,
    /// One webview profile per backend (cookies and caches included).
    pub webviews: PathBuf,
}

impl StoragePaths {
    pub fn report(&self) -> StorageReport {
        let areas = vec![
            AreaUsage {
                area: StorageArea::Media,
                bytes: dir_size(&self.media),
                clearable: true,
            },
            AreaUsage {
                area: StorageArea::Logs,
                bytes: dir_size(&self.logs),
                clearable: true,
            },
            AreaUsage {
                area: StorageArea::Cache,
                bytes: cache_bytes(&self.cache),
                clearable: true,
            },
        ];
        let usage: Vec<UsageEntry> = [UsageKind::Plugins, UsageKind::Webviews]
            .into_iter()
            .map(|kind| {
                let (bytes, files) = dir_usage(match kind {
                    UsageKind::Plugins => &self.plugins,
                    UsageKind::Webviews => &self.webviews,
                });
                UsageEntry { kind, bytes, files }
            })
            .collect();
        let total_bytes =
            areas.iter().map(|a| a.bytes).sum::<u64>() + usage.iter().map(|u| u.bytes).sum::<u64>();
        StorageReport {
            areas,
            usage,
            total_bytes,
        }
    }
}

/// Marker every player-created temp file carries, so we only ever count and
/// delete our own. Mirrors `player::IPC_MARKER`, which is deliberately not
/// exported from there to keep this module independent of playback.
const CACHE_MARKER: &str = "lilo-mpv-";

/// Only our own files count: the temp directory belongs to the whole system.
fn cache_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().starts_with(CACHE_MARKER))
                .unwrap_or(false)
        })
        .collect()
}

fn cache_bytes(dir: &Path) -> u64 {
    cache_files(dir)
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .sum()
}

/// Remove one area and report how many bytes went away.
///
/// Media is deleted outright; LILO re-downloads it on the next start from the
/// pinned, checksummed specs. Logs and cache only ever touch our own files.
pub fn clear(paths: &StoragePaths, area: StorageArea) -> Result<u64> {
    let freed = match area {
        StorageArea::Media => {
            let bytes = dir_size(&paths.media);
            remove_dir(&paths.media)?;
            bytes
        }
        StorageArea::Logs => {
            let bytes = dir_size(&paths.logs);
            remove_dir(&paths.logs)?;
            bytes
        }
        StorageArea::Cache => {
            let bytes = cache_bytes(&paths.cache);
            for file in cache_files(&paths.cache) {
                let _ = std::fs::remove_file(file);
            }
            bytes
        }
    };
    Ok(freed)
}

/// Best-effort recursive removal: a file that cannot be deleted must not turn
/// a successful cleanup into an error, but a missing directory is fine too.
fn remove_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(path)
        .map_err(|error| AppError::other(format!("could not remove {}: {error}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilo-storage-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn area_parsing_is_forgiving() {
        assert_eq!(StorageArea::parse("media"), Some(StorageArea::Media));
        assert_eq!(StorageArea::parse(" LOGS "), Some(StorageArea::Logs));
        assert_eq!(StorageArea::parse("cache"), Some(StorageArea::Cache));
        assert_eq!(StorageArea::parse("secrets"), None);
    }

    #[test]
    fn sizes_add_up_recursively() {
        let dir = temp_dir("size");
        std::fs::write(dir.join("a"), vec![0u8; 10]).unwrap();
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested/b"), vec![0u8; 5]).unwrap();
        assert_eq!(dir_size(&dir), 15);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_directory_is_zero_not_an_error() {
        assert_eq!(dir_size(Path::new("/definitely/not/here")), 0);
    }

    #[test]
    fn the_cache_only_counts_our_own_files() {
        let cache = temp_dir("cache");
        std::fs::write(cache.join(format!("{CACHE_MARKER}one.sock")), vec![0u8; 7]).unwrap();
        std::fs::write(cache.join("someone-elses.sock"), vec![0u8; 100]).unwrap();
        let paths = StoragePaths {
            media: temp_dir("m"),
            logs: temp_dir("l"),
            cache: cache.clone(),
            plugins: temp_dir("p"),
            webviews: temp_dir("w"),
        };
        let report = paths.report();
        let used = report
            .areas
            .iter()
            .find(|a| a.area == StorageArea::Cache)
            .unwrap()
            .bytes;
        assert_eq!(used, 7, "a stray temp file belongs to somebody else");
        let _ = std::fs::remove_dir_all(cache);
    }

    #[test]
    fn plugins_and_webviews_count_toward_the_total_without_a_clear_button() {
        let plugins = temp_dir("usage-plugins");
        std::fs::create_dir_all(plugins.join("com.acme.notes/data")).unwrap();
        std::fs::write(plugins.join("com.acme.notes/plugin.json"), b"{}").unwrap();
        std::fs::write(plugins.join("com.acme.notes/data/notes.txt"), vec![0u8; 9]).unwrap();
        let webviews = temp_dir("usage-webviews");
        std::fs::write(webviews.join("Cookies"), vec![0u8; 5]).unwrap();

        let paths = StoragePaths {
            media: temp_dir("u-m"),
            logs: temp_dir("u-l"),
            cache: temp_dir("u-c"),
            plugins,
            webviews,
        };
        let report = paths.report();
        let plugins_usage = report
            .usage
            .iter()
            .find(|u| u.kind == UsageKind::Plugins)
            .unwrap();
        assert_eq!(plugins_usage.bytes, 11);
        assert_eq!(plugins_usage.files, 2, "the data file counts too");
        let webviews_usage = report
            .usage
            .iter()
            .find(|u| u.kind == UsageKind::Webviews)
            .unwrap();
        assert_eq!(webviews_usage.bytes, 5);
        assert_eq!(report.total_bytes, 16);
        assert!(report.areas.iter().all(|area| area.bytes == 0));
    }

    #[test]
    fn clearing_the_cache_removes_only_ours() {
        let cache = temp_dir("clearcache");
        let ours = cache.join(format!("{CACHE_MARKER}two.lua"));
        let theirs = cache.join("not-ours.txt");
        std::fs::write(&ours, b"x").unwrap();
        std::fs::write(&theirs, b"x").unwrap();
        let paths = StoragePaths {
            media: temp_dir("m2"),
            logs: temp_dir("l2"),
            cache: cache.clone(),
            plugins: temp_dir("p2"),
            webviews: temp_dir("w2"),
        };
        assert_eq!(clear(&paths, StorageArea::Cache).unwrap(), 1);
        assert!(!ours.exists());
        assert!(theirs.exists(), "only our own files may be deleted");
        let _ = std::fs::remove_dir_all(cache);
    }

    #[test]
    fn clearing_media_frees_its_bytes_and_is_idempotent() {
        let media = temp_dir("media");
        std::fs::write(media.join("mpv"), vec![0u8; 42]).unwrap();
        let paths = StoragePaths {
            media: media.clone(),
            logs: temp_dir("l3"),
            cache: temp_dir("c3"),
            plugins: temp_dir("p3"),
            webviews: temp_dir("w3"),
        };
        assert_eq!(clear(&paths, StorageArea::Media).unwrap(), 42);
        assert!(!media.exists());
        assert_eq!(clear(&paths, StorageArea::Media).unwrap(), 0);
    }
}
