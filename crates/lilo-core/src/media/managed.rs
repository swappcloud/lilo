//! Versioned tool installations. Activation never overwrites a running binary.
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

#[derive(Deserialize, Serialize)]
pub(super) struct Installed {
    pub version: String,
    pub sha256: String,
    pub entry: String,
}

pub(super) fn root(data: &Path, tool: &str, digest: &str) -> PathBuf {
    super::provision::install_dir(data).join(format!("{tool}-{digest}"))
}

pub(super) fn installed(data: &Path, tool: &str) -> Option<Installed> {
    let path = super::provision::install_dir(data).join(format!("{tool}.installed.json"));
    if std::fs::metadata(&path).ok()?.len() > 8192 {
        return None;
    }
    let record: Installed = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    checked_path(data, tool, &record)?;
    Some(record)
}

fn checked_path(data: &Path, tool: &str, record: &Installed) -> Option<PathBuf> {
    if record.sha256.len() != 64
        || !record.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        || record.entry.is_empty()
        || record.entry.contains('\\')
        || !Path::new(&record.entry)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        || !root(data, tool, &record.sha256)
            .join(&record.entry)
            .is_file()
    {
        return None;
    }
    Some(root(data, tool, &record.sha256).join(&record.entry))
}

pub(super) fn active_path(data: &Path, tool: &str) -> Option<PathBuf> {
    let record = installed(data, tool)?;
    Some(root(data, tool, &record.sha256).join(record.entry))
}

pub(super) fn activate(data: &Path, tool: &str, record: &Installed) -> Result<PathBuf> {
    let target = checked_path(data, tool, record)
        .ok_or_else(|| AppError::other("cannot activate an incomplete media installation"))?;
    let dir = super::provision::install_dir(data);
    let staging = dir.join(format!(".{tool}-{}.installed.part", uuid::Uuid::new_v4()));
    std::fs::write(&staging, serde_json::to_vec(record)?)?;
    let result = std::fs::rename(&staging, dir.join(format!("{tool}.installed.json")));
    if result.is_err() {
        let _ = std::fs::remove_file(staging);
    }
    result?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_preserves_the_previous_version_and_rejects_unsafe_entries() {
        let data = std::env::temp_dir().join(format!("lilo-managed-{}", uuid::Uuid::new_v4()));
        let first = Installed {
            version: "old".into(),
            sha256: "a".repeat(64),
            entry: "bin/tool".into(),
        };
        let second = Installed {
            version: "new".into(),
            sha256: "b".repeat(64),
            entry: "bin/tool".into(),
        };
        for record in [&first, &second] {
            let path = root(&data, "tool", &record.sha256).join(&record.entry);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, record.version.as_bytes()).unwrap();
        }
        let old = activate(&data, "tool", &first).unwrap();
        assert_eq!(active_path(&data, "tool"), Some(old.clone()));
        let new = activate(&data, "tool", &second).unwrap();
        assert_eq!(active_path(&data, "tool"), Some(new));
        assert_eq!(std::fs::read(old).unwrap(), b"old");
        let unsafe_record = Installed {
            entry: "../../outside".into(),
            ..second
        };
        assert!(activate(&data, "tool", &unsafe_record).is_err());
        assert_eq!(installed(&data, "tool").unwrap().version, "new");
        std::fs::remove_dir_all(data).unwrap();
    }
}
