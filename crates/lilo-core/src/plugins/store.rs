//! Settings a plugin owns.
//!
//! Stored next to the plugin, one file per plugin, so uninstalling is
//! `rm -rf` and there is no shared settings blob to migrate. The host is the
//! only writer: a plugin receives its settings over the protocol, which keeps
//! the sandbox story ("a plugin touches nothing it was not given") intact.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{AppError, Result};

/// Reject an id that could point outside the plugins directory. Ids come from
/// manifests and from the UI, so this is a boundary, not a formality.
///
/// An allow-list, not a deny-list: `.` would name the plugins root itself (and
/// uninstalling it would delete every plugin), and on Windows `C:` or a
/// reserved device name is a path of its own.
pub fn safe_segment(id: &str) -> Result<&str> {
    let trimmed = id.trim();
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_');
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed.chars().all(allowed)
        || trimmed.starts_with('.')
        || trimmed.contains("..")
    {
        return Err(AppError::other(format!("unsafe plugin id: {id}")));
    }
    Ok(trimmed)
}

pub fn plugin_dir(root: &Path, id: &str) -> Result<PathBuf> {
    Ok(root.join(safe_segment(id)?))
}

/// Marker inside a plugin folder: present means the user turned the plugin
/// off while keeping it installed.
pub const DISABLED_FILE: &str = ".disabled";

fn settings_path(root: &Path, id: &str) -> Result<PathBuf> {
    Ok(plugin_dir(root, id)?.join("settings.json"))
}

fn disabled_path(root: &Path, id: &str) -> Result<PathBuf> {
    Ok(plugin_dir(root, id)?.join(DISABLED_FILE))
}

/// Whether the plugin is active. A missing marker means enabled: installing a
/// plugin is enough to use it.
pub fn is_enabled(root: &Path, id: &str) -> bool {
    disabled_path(root, id).is_ok_and(|path| !path.exists())
}

/// Deactivate or reactivate an installed plugin. Deactivation only drops the
/// marker: the folder, its data and its settings are untouched, so activating
/// it again is the same plugin the user had.
pub fn set_enabled(root: &Path, id: &str, enabled: bool) -> Result<()> {
    let path = disabled_path(root, id)?;
    if enabled {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::other(format!("could not activate {id}: {error}"))),
        }
    } else {
        std::fs::write(&path, b"")
            .map_err(|error| AppError::other(format!("could not deactivate {id}: {error}")))
    }
}

/// The plugin's own `plugin.json`, if it is installed.
pub fn load_manifest_value(root: &Path, id: &str) -> Option<Value> {
    let path = plugin_dir(root, id).ok()?.join("plugin.json");
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The plugin's stored settings, or an empty object when it has none yet.
pub fn load(root: &Path, id: &str) -> Value {
    let Ok(path) = settings_path(root, id) else {
        return Value::Object(serde_json::Map::new());
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Value::Object(serde_json::Map::new());
    };
    serde_json::from_str(&raw).unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
}

/// Persist the plugin's settings. Written whole, because the UI always sends
/// the complete set — a partial write would leave the file in a state neither
/// side can reason about.
pub fn save(root: &Path, id: &str, settings: &Value) -> Result<()> {
    let path = settings_path(root, id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::other(format!("could not create plugin dir: {error}")))?;
    }
    let body = serde_json::to_string_pretty(settings)?;
    std::fs::write(&path, body)
        .map_err(|error| AppError::other(format!("could not write plugin settings: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilo-store-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn settings_round_trip() {
        let dir = root("round");
        assert_eq!(load(&dir, "com.acme.x"), json!({}));
        save(&dir, "com.acme.x", &json!({ "volume": 30 })).unwrap();
        assert_eq!(load(&dir, "com.acme.x")["volume"], 30);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_rather_than_failing() {
        let dir = root("corrupt");
        save(&dir, "com.acme.x", &json!({ "a": 1 })).unwrap();
        std::fs::write(
            plugin_dir(&dir, "com.acme.x")
                .unwrap()
                .join("settings.json"),
            "{",
        )
        .unwrap();
        assert_eq!(load(&dir, "com.acme.x"), json!({}));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_traversing_id_is_refused() {
        let dir = root("escape");
        assert!(save(&dir, "../../etc/passwd", &json!({})).is_err());
        assert!(save(&dir, "a/b", &json!({})).is_err());
        assert!(plugin_dir(&dir, "..").is_err());
        assert!(
            plugin_dir(&dir, ".").is_err(),
            "`.` is the plugins root itself"
        );
        assert!(plugin_dir(&dir, "C:").is_err());
        assert!(plugin_dir(&dir, ".staging-x").is_err());
        assert!(plugin_dir(&dir, "com.acme.spotify_2-beta").is_ok());
        assert!(set_enabled(&dir, "../x", false).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn activating_and_deactivating_round_trips() {
        let dir = root("enabled");
        std::fs::create_dir_all(plugin_dir(&dir, "com.acme.x").unwrap()).unwrap();
        assert!(
            is_enabled(&dir, "com.acme.x"),
            "installing is enough to have it on"
        );

        set_enabled(&dir, "com.acme.x", false).unwrap();
        assert!(!is_enabled(&dir, "com.acme.x"));
        assert!(plugin_dir(&dir, "com.acme.x")
            .unwrap()
            .join(DISABLED_FILE)
            .is_file());

        set_enabled(&dir, "com.acme.x", true).unwrap();
        assert!(is_enabled(&dir, "com.acme.x"));
        assert!(
            set_enabled(&dir, "com.acme.x", true).is_ok(),
            "activating twice is harmless"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
