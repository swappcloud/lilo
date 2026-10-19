//! Finding `mpv` and `yt-dlp` on the host.
//!
//! A GUI app launched from Finder inherits a minimal `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew's `/opt/homebrew/bin` is not
//! on it and a plain `which` lookup fails in the packaged app while working
//! fine in the terminal. Hence the explicit candidate list.

use std::path::{Path, PathBuf};

/// Directories probed in addition to `PATH`, in order.
pub const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // Apple Silicon Homebrew
    "/usr/local/bin",    // Intel Homebrew, manual installs
    "/usr/bin",          // Debian / headless Linux distribution
    "/bin",
    "/snap/bin",
];

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// First existing executable named `name` in `dirs`.
pub fn find_in<P: AsRef<Path>>(dirs: &[P], name: &str) -> Option<PathBuf> {
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in dirs {
        for candidate in &candidates {
            let path = dir.as_ref().join(candidate);
            if is_executable(&path) {
                return Some(path);
            }
        }
    }
    None
}

/// Resolve a binary: an explicit override wins, then `PATH`, then the extra
/// directories a packaged app cannot see.
pub fn locate(name: &str, override_path: &str) -> Option<PathBuf> {
    let trimmed = override_path.trim();
    if !trimmed.is_empty() {
        let path = PathBuf::from(trimmed);
        return is_executable(&path).then_some(path);
    }

    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    dirs.extend(EXTRA_DIRS.iter().map(PathBuf::from));
    find_in(&dirs, name)
}

/// What the settings UI shows, so a missing tool reads as an install hint
/// instead of a silent failure.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub name: String,
    pub path: Option<String>,
    pub found: bool,
    pub install_hint: String,
}

pub fn status(name: &str, override_path: &str) -> BinaryStatus {
    let path = locate(name, override_path);
    BinaryStatus {
        name: name.to_string(),
        found: path.is_some(),
        path: path.map(|p| p.display().to_string()),
        install_hint: install_hint(name),
    }
}

fn install_hint(name: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("brew install {name}")
    } else if cfg!(target_os = "windows") {
        format!("winget install {name}")
    } else {
        format!("sudo apt install {name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilo-bin-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn write_executable(dir: &Path, name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    #[cfg(unix)]
    fn find_in_returns_the_first_hit() {
        let first = scratch("first");
        let second = scratch("second");
        write_executable(&second, "mpv");
        let found = find_in(&[first.clone(), second.clone()], "mpv").unwrap();
        assert!(found.starts_with(&second));

        write_executable(&first, "mpv");
        let found = find_in(&[first.clone(), second], "mpv").unwrap();
        assert!(found.starts_with(&first), "earlier directories win");
    }

    #[test]
    #[cfg(unix)]
    fn a_non_executable_file_is_not_a_binary() {
        let dir = scratch("plain");
        std::fs::write(dir.join("yt-dlp"), "not executable").unwrap();
        assert!(find_in(&[dir], "yt-dlp").is_none());
    }

    #[test]
    #[cfg(unix)]
    fn an_override_must_still_exist() {
        let dir = scratch("override");
        let real = write_executable(&dir, "mpv");
        assert_eq!(locate("mpv", real.to_str().unwrap()), Some(real));
        assert_eq!(locate("mpv", "/nope/mpv"), None);
    }

    #[test]
    fn missing_binaries_report_an_install_hint() {
        let status = status("definitely-not-installed-xyz", "");
        assert!(!status.found);
        assert!(status.path.is_none());
        assert!(!status.install_hint.is_empty());
    }

    #[test]
    fn extra_dirs_cover_homebrew_and_debian() {
        assert!(EXTRA_DIRS.contains(&"/opt/homebrew/bin"));
        assert!(EXTRA_DIRS.contains(&"/usr/bin"));
    }
}
