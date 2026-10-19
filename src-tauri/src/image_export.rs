//! Export a plugin's stored picture into the desktop user's Downloads folder.

use std::path::{Path, PathBuf};

use base64::Engine as _;

use crate::error::{AppError, Result};

pub fn save(
    root: &Path,
    plugin: &str,
    file: &str,
    mime: &str,
    downloads: &Path,
) -> Result<PathBuf> {
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err(AppError::other("unsupported image type")),
    };
    let url = lilo_core::plugins::images::data_url(root, plugin, file, mime)?;
    let (_, encoded) = url
        .split_once(',')
        .ok_or_else(|| AppError::other("invalid image"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| AppError::other("invalid image base64"))?;
    let stem: String = Path::new(file)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("picture")
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(64)
        .collect();
    let stem = if stem.is_empty() { "picture" } else { &stem };
    std::fs::create_dir_all(downloads)?;
    for index in 0..1_000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("-{index}")
        };
        let destination = downloads.join(format!("lilo-{stem}{suffix}.{extension}"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(mut output) => {
                use std::io::Write;
                if let Err(error) = output.write_all(&bytes) {
                    drop(output);
                    let _ = std::fs::remove_file(&destination);
                    return Err(error.into());
                }
                return Ok(destination);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(AppError::other(
        "too many copies of this picture in Downloads",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../.tmp")
                .join(format!("image-export-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("plugins/gallery/data/img")).unwrap();
            std::fs::write(
                root.join("plugins/gallery/data/img/picture.b64"),
                "aGVsbG8=",
            )
            .unwrap();
            Self(root)
        }

        fn save(&self, file: &str, mime: &str) -> Result<PathBuf> {
            save(
                &self.0.join("plugins"),
                "gallery",
                file,
                mime,
                &self.0.join("downloads"),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_save_decodes_supported_formats_and_uses_the_right_extension() {
        let fixture = Fixture::new();
        for (mime, extension) in [
            ("image/png", "png"),
            ("image/jpeg", "jpg"),
            ("image/webp", "webp"),
            ("image/gif", "gif"),
        ] {
            let saved = fixture.save("img/picture.b64", mime).unwrap();
            assert_eq!(saved.parent().unwrap(), fixture.0.join("downloads"));
            assert_eq!(saved.extension().unwrap(), extension);
            assert_eq!(std::fs::read(saved).unwrap(), b"hello");
        }
    }

    #[test]
    fn test_save_preserves_existing_downloads() {
        let fixture = Fixture::new();
        let first = fixture.save("img/picture.b64", "image/png").unwrap();
        std::fs::write(&first, b"existing picture").unwrap();
        let second = fixture.save("img/picture.b64", "image/png").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), b"existing picture");
        assert_eq!(std::fs::read(second).unwrap(), b"hello");
    }

    #[test]
    fn test_save_rejects_unsafe_sources_and_invalid_base64_before_writing() {
        let fixture = Fixture::new();
        std::fs::write(
            fixture.0.join("plugins/gallery/data/img/invalid.b64"),
            "A===",
        )
        .unwrap();
        assert!(fixture.save("../settings.json", "image/png").is_err());
        assert!(fixture.save("img/picture.b64", "image/svg+xml").is_err());
        assert!(fixture.save("img/invalid.b64", "image/png").is_err());
        assert!(!fixture.0.join("downloads").exists());
    }
}
