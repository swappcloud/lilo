//! Pictures a plugin keeps in its own `data/` folder, read back for the host
//! to draw (a `ui.list` row with an `image`).
//!
//! The plugin writes the picture as base64 text through `lilo.write`; the host
//! reads it here instead of through the plugin, so a gallery never has to hold
//! every picture in the plugin's bounded JavaScript heap. Same confinement as
//! `lilo.read`: a name under `data/`, nothing outside it.

use std::path::Path;

use super::{quickjs, store};
use crate::error::{AppError, Result};

/// A picture larger than this is not drawn (base64 text, about 9 MiB raw).
const MAX_IMAGE_TEXT: u64 = 12 * 1024 * 1024;

/// The formats a list may show. Anything else (an SVG, which can carry
/// script) is refused.
const MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// A `data:` URL for the picture `file` in plugin `id`'s `data/` folder.
pub fn data_url(root: &Path, id: &str, file: &str, mime: &str) -> Result<String> {
    if !MIMES.contains(&mime) {
        return Err(AppError::other(format!("unsupported image type: {mime}")));
    }
    let data = store::plugin_dir(root, id)?.join("data");
    let path = quickjs::data_path(&data, file)?;
    let size = std::fs::metadata(&path)
        .map_err(|_| AppError::other(format!("no such image: {file}")))?
        .len();
    if size == 0 || size > MAX_IMAGE_TEXT {
        return Err(AppError::other(format!(
            "image is empty or too large: {file}"
        )));
    }
    let text = std::fs::read_to_string(&path)?;
    let text = text.trim();
    // Base64 alphabet only, so the URL cannot be bent into something else.
    if !text
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
    {
        return Err(AppError::other(format!("image is not base64: {file}")));
    }
    Ok(format!("data:{mime};base64,{text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("lilo-images-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("gallery").join("data").join("img")).unwrap();
        root
    }

    #[test]
    fn a_kept_picture_comes_back_as_a_data_url() {
        let root = plugin("ok");
        std::fs::write(root.join("gallery/data/img/a.b64"), "iVBORw0KGgo=\n").unwrap();
        assert_eq!(
            data_url(&root, "gallery", "img/a.b64", "image/png").unwrap(),
            "data:image/png;base64,iVBORw0KGgo="
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn names_outside_data_types_and_non_base64_are_refused() {
        let root = plugin("refuse");
        std::fs::write(root.join("gallery/settings.json"), "{}").unwrap();
        std::fs::write(root.join("gallery/data/img/bad.b64"), "<script>").unwrap();
        std::fs::write(root.join("gallery/data/img/gone.b64"), "").unwrap();
        assert!(data_url(&root, "gallery", "../settings.json", "image/png").is_err());
        assert!(data_url(&root, "gallery", "img/a.b64", "image/svg+xml").is_err());
        assert!(data_url(&root, "gallery", "img/bad.b64", "image/png").is_err());
        assert!(data_url(&root, "gallery", "img/gone.b64", "image/png").is_err());
        assert!(data_url(&root, "../gallery", "img/a.b64", "image/png").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
