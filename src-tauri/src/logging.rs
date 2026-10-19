//! Tiny append-only logger shared by the backend and the UI.
//!
//! Everything goes to stderr (so `npm run dev` shows it live) *and* to a
//! `lilo.log` file so a session can be inspected afterwards.

use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Reads only the latest bytes for a user-requested diagnostic export.
pub fn snapshot(limit: u64) -> std::io::Result<String> {
    if let Some(writer) = LOG_FILE.get() {
        if let Ok(mut writer) = writer.lock() {
            if let Some(file) = writer.as_mut() {
                file.flush()?;
            }
        }
    }
    let Some(path) = LOG_PATH.get() else {
        return Ok(String::new());
    };
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error),
    };
    let length = file.metadata()?.len();
    let start = length.saturating_sub(limit);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(if start > 0 {
        text.split_once('\n')
            .map_or("", |(_, tail)| tail)
            .to_string()
    } else {
        text.into_owned()
    })
}

/// Directory used when the caller has no preference. In dev that is
/// `<project>/.tmp/logs`; in a bundled app it is `./logs`.
fn default_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let base = if cwd.ends_with("src-tauri") {
        cwd.parent().map(PathBuf::from).unwrap_or(cwd)
    } else {
        cwd
    };
    base.join(".tmp").join("logs")
}

pub fn init(preferred_dir: Option<PathBuf>) -> PathBuf {
    let dir = preferred_dir.unwrap_or_else(default_dir);
    let _ = create_dir_all(&dir);
    let path = dir.join("lilo.log");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok();
    let _ = LOG_FILE.set(Mutex::new(file));
    let _ = LOG_PATH.set(path.clone());
    let _ = log::set_boxed_logger(Box::new(LogBridge));
    log::set_max_level(log::LevelFilter::Info);
    path
}

/// Sends Tauri's and wry's own log records into lilo.log.
///
/// Window and webview creation failures are reported through `log::error!`
/// and then swallowed: without a logger the user sees a window that simply
/// never appears. This is what makes that visible.
struct LogBridge;

impl log::Log for LogBridge {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        log(
            record.target(),
            &format!("{}: {}", record.level(), record.args()),
        );
    }

    fn flush(&self) {}
}

/// Directory the log file lives in, so the storage panel can size and clear it.
pub fn dir() -> Option<PathBuf> {
    LOG_PATH
        .get()
        .and_then(|path| path.parent().map(PathBuf::from))
}

/// Re-open the log file after its directory was cleared, so logging continues
/// instead of writing to a deleted inode.
pub fn reopen() {
    let (Some(path), Some(file)) = (LOG_PATH.get(), LOG_FILE.get()) else {
        return;
    };
    if let Ok(mut handle) = file.lock() {
        *handle = OpenOptions::new().create(true).append(true).open(path).ok();
    }
}

fn now() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

pub fn log(scope: &str, message: &str) {
    let line = format!("[{}] [{scope}] {message}", now());
    eprintln!("{line}");
    if let Some(file) = LOG_FILE.get() {
        if let Ok(mut handle) = file.lock() {
            if let Some(handle) = handle.as_mut() {
                let _ = writeln!(handle, "{line}");
            }
        }
    }
}
