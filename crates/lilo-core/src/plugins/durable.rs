//! Atomic, versioned JSON records confined to one plugin's data directory.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_RECORDS: usize = 32;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format: u32,
    schema_version: u32,
    revision: u64,
    value: Value,
    deleted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub found: bool,
    pub value: Value,
    pub schema_version: u32,
    pub revision: u64,
    pub recovered: bool,
}

pub(crate) struct Store {
    root: PathBuf,
}
impl Store {
    pub(crate) fn request(&self, operation: &str, args: Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Options {
            key: String,
            #[serde(default)]
            value: Value,
            schema_version: Option<u32>,
            expected_revision: Option<u64>,
            #[serde(default)]
            purge_previous: bool,
        }
        let has_value = args.get("value").is_some();
        let args: Options =
            serde_json::from_value(args).map_err(|_| failure("Invalid memory options."))?;
        let result = match operation {
            "read" => self.read(&args.key)?,
            "write" if has_value => self.write(
                &args.key,
                args.value,
                args.schema_version
                    .ok_or_else(|| failure("Memory write requires schemaVersion."))?,
                args.expected_revision,
                args.purge_previous,
            )?,
            "delete" => self.delete(&args.key, args.expected_revision)?,
            _ => return Err(failure("Unknown memory operation or missing write value.")),
        };
        Ok(serde_json::to_value(result)?)
    }
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn for_plugin(data: &Path, namespace: &str) -> Result<Self> {
        safe_file(data)?;
        fs::create_dir_all(data).map_err(|_| failure("Memory directory is unavailable."))?;
        let mut root =
            fs::canonicalize(data).map_err(|_| failure("Memory directory is unavailable."))?;
        for part in [".lilo-state", namespace] {
            root.push(part);
            safe_file(&root)?;
            fs::create_dir_all(&root)
                .map_err(|_| failure("Memory directory could not be created."))?;
        }
        Ok(Self::new(root))
    }

    fn paths(&self, key: &str) -> Result<(PathBuf, PathBuf)> {
        if key.is_empty()
            || key.len() > 64
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err(failure(
                "Memory key must be 1–64 ASCII letters, digits, underscores or hyphens.",
            ));
        }
        safe_file(&self.root)?;
        let key = key.to_ascii_lowercase();
        let current = self.root.join(format!("{key}.json"));
        let backup = self.root.join(format!("{key}.backup"));
        safe_file(&current)?;
        safe_file(&backup)?;
        Ok((current, backup))
    }

    fn load(&self, key: &str) -> Result<(Option<Envelope>, bool)> {
        let (current, backup) = self.paths(key)?;
        let primary = snapshot(&current);
        match primary {
            Ok(Some(value)) => Ok((Some(value), false)),
            Err(error) if error.to_string().contains("Unsupported") => Err(error),
            other => match snapshot(&backup)? {
                Some(value) => Ok((Some(value), true)),
                None => other.map(|value| (value, false)),
            },
        }
    }

    pub(crate) fn read(&self, key: &str) -> Result<Record> {
        let (value, recovered) = self.load(key)?;
        Ok(match value {
            Some(value) => Record {
                found: !value.deleted,
                value: value.value,
                schema_version: value.schema_version,
                revision: value.revision,
                recovered,
            },
            None => Record {
                found: false,
                value: Value::Null,
                schema_version: 0,
                revision: 0,
                recovered: false,
            },
        })
    }

    pub(crate) fn write(
        &self,
        key: &str,
        value: Value,
        schema_version: u32,
        expected: Option<u64>,
        purge: bool,
    ) -> Result<Record> {
        if schema_version == 0 {
            return Err(failure("Memory schemaVersion must be positive."));
        }
        let (old, _) = self.load(key)?;
        let revision = old.as_ref().map(|value| value.revision).unwrap_or(0);
        if expected.is_some_and(|expected| expected != revision) {
            return Err(failure("Memory revision conflict; reload before writing."));
        }
        let envelope = Envelope {
            format: 1,
            schema_version,
            revision: revision
                .checked_add(1)
                .ok_or_else(|| failure("Memory revision exhausted."))?,
            value,
            deleted: false,
        };
        let bytes = encoded(&envelope)?;
        let (current, backup) = self.paths(key)?;
        fs::create_dir_all(&self.root)
            .map_err(|_| failure("Memory directory could not be created."))?;
        if old.is_none() {
            let count = fs::read_dir(&self.root)
                .map_err(|_| failure("Memory directory could not be read."))?
                .filter_map(std::result::Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .count();
            if count >= MAX_RECORDS {
                return Err(failure(
                    "Memory record limit reached; delete an unused record.",
                ));
            }
        }
        if purge {
            atomic_write(&backup, &bytes)?;
        } else if let Some(old) = old {
            atomic_write(&backup, &encoded(&old)?)?;
        }
        atomic_write(&current, &bytes)?;
        self.read(key)
    }

    pub(crate) fn delete(&self, key: &str, expected: Option<u64>) -> Result<Record> {
        let (old, _) = self.load(key)?;
        let revision = old.as_ref().map(|value| value.revision).unwrap_or(0);
        if expected.is_some_and(|expected| expected != revision) {
            return Err(failure("Memory revision conflict; reload before deleting."));
        }
        if let Some(old) = old {
            let tombstone = Envelope {
                format: 1,
                schema_version: old.schema_version,
                revision: old.revision,
                value: Value::Null,
                deleted: true,
            };
            let bytes = encoded(&tombstone)?;
            let (current, backup) = self.paths(key)?;
            // Recovery is sanitized first; a crash never leaves an old backup behind.
            atomic_write(&backup, &bytes)?;
            atomic_write(&current, &bytes)?;
            fs::remove_file(current).map_err(|_| failure("Memory deletion could not finish."))?;
            fs::remove_file(backup)
                .map_err(|_| failure("Memory recovery deletion could not finish."))?;
        }
        self.read(key)
    }
}

fn failure(message: &str) -> AppError {
    AppError::other(message)
}
fn safe_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(failure("Memory paths cannot be symbolic links."))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(failure("Memory path could not be inspected.")),
    }
}
fn snapshot(path: &Path) -> Result<Option<Envelope>> {
    safe_file(path)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(failure("Memory snapshot could not be read.")),
    };
    let mut bytes = Vec::new();
    file.take((MAX_JSON_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("Memory snapshot could not be read."))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(failure("Memory snapshot exceeds the byte limit."));
    }
    let json: Value = serde_json::from_slice(&bytes)
        .map_err(|_| failure("Memory snapshot is corrupt; existing data was preserved."))?;
    if json.get("format").and_then(Value::as_u64) != Some(1) {
        return Err(failure(
            "Unsupported memory format; existing data was preserved.",
        ));
    }
    let value: Envelope = serde_json::from_value(json)
        .map_err(|_| failure("Memory snapshot is corrupt; existing data was preserved."))?;
    if value.schema_version == 0 || value.revision == 0 {
        return Err(failure("Memory snapshot metadata is invalid."));
    }
    Ok(Some(value))
}
fn encoded(value: &Envelope) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(failure("Memory snapshot exceeds the byte limit."));
    }
    Ok(bytes)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    safe_file(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| failure("Memory destination is invalid."))?;
    let staging = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|_| failure("Memory staging file could not be created."))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| failure("Memory staging file could not be flushed."))?;
        drop(file);
        fs::rename(&staging, path)
            .map_err(|_| failure("Memory snapshot could not be replaced."))?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| failure("Memory directory could not be flushed."))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_bounds_and_failed_writes_preserve_the_committed_record() {
        let root = root();
        let store = Store::new(root.clone());
        store
            .write(
                "existing",
                serde_json::json!({"cue":"Preserved"}),
                1,
                Some(0),
                false,
            )
            .unwrap();
        assert_eq!(store.read("EXISTING").unwrap().revision, 1);
        assert!(store
            .write(
                "existing",
                Value::String("x".repeat(MAX_JSON_BYTES)),
                1,
                Some(1),
                false
            )
            .is_err());
        assert_eq!(store.read("existing").unwrap().value["cue"], "Preserved");
        assert!(store
            .request(
                "write",
                serde_json::json!({"key":"existing","schemaVersion":1})
            )
            .is_err());
        assert!(store
            .write("existing", Value::Null, 0, None, false)
            .is_err());
        for index in 1..MAX_RECORDS {
            store
                .write(&format!("record{index}"), Value::Null, 1, Some(0), false)
                .unwrap();
        }
        assert!(store
            .write("overflow", Value::Null, 1, Some(0), false)
            .is_err());
        store.delete("existing", Some(1)).unwrap();
        store
            .write("overflow", Value::Null, 1, Some(0), false)
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_memory_rejects_a_symlinked_private_directory() {
        let outside = root();
        let root = root();
        std::os::unix::fs::symlink(&outside, root.join(".lilo-state")).unwrap();
        assert!(Store::for_plugin(&root, "memory").is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("lilo-memory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn test_memory_revisions_recovery_and_deletion_do_not_resurrect_data() {
        let root = root();
        let store = Store::new(root.clone());
        assert!(!store.read("learning").unwrap().found);
        store
            .write(
                "learning",
                serde_json::json!({"goal": "Conversation"}),
                1,
                Some(0),
                false,
            )
            .unwrap();
        store
            .write(
                "learning",
                serde_json::json!({"goal": "Meetings"}),
                2,
                Some(1),
                false,
            )
            .unwrap();
        assert!(store
            .write("learning", serde_json::json!({}), 2, Some(1), false)
            .is_err());
        std::fs::write(root.join("learning.json"), "{partial").unwrap();
        let recovered = store.read("learning").unwrap();
        assert!(recovered.recovered);
        assert_eq!(recovered.value["goal"], "Conversation");
        store.delete("learning", None).unwrap();
        assert!(!store.read("learning").unwrap().found);
        assert!(!root.join("learning.backup").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn test_memory_purges_previous_snapshots_and_preserves_unsupported_data() {
        let root = root();
        let store = Store::new(root.clone());
        store
            .write(
                "notes",
                serde_json::json!({"private": "old"}),
                1,
                None,
                false,
            )
            .unwrap();
        store
            .write(
                "notes",
                serde_json::json!({"private": "removed"}),
                1,
                None,
                true,
            )
            .unwrap();
        assert!(!std::fs::read_to_string(root.join("notes.backup"))
            .unwrap()
            .contains("old"));
        std::fs::write(root.join("notes.json"), "{\"format\":99}").unwrap();
        assert!(store.read("notes").is_err());
        assert!(store
            .write("../outside", serde_json::json!({}), 1, None, false)
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
