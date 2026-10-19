//! User-initiated diagnostic exports with an allowlist of safe fields.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;

const SNAPSHOT_BYTES: u64 = 512 * 1024;
static EXPORTING: AtomicBool = AtomicBool::new(false);

struct ExportGuard;
impl Drop for ExportGuard {
    fn drop(&mut self) {
        EXPORTING.store(false, Ordering::SeqCst);
    }
}

fn approved_field(key: &str, value: &str) -> bool {
    match key {
        "state" => matches!(value, "loading" | "interactive" | "complete"),
        "hidden" | "focused" | "clear_session" | "trustedInput" => {
            matches!(value, "true" | "false")
        }
        "page" => matches!(value, "blank" | "provider" | "auth" | "other"),
        "stage" => matches!(
            value,
            "idle" | "checking" | "available" | "downloading" | "installing" | "error" | "current"
        ),
        "status" => value.parse::<u16>().is_ok_and(|code| code <= 599),
        "progress" => value.parse::<u8>().is_ok_and(|number| number <= 100),
        "writes" | "pending" | "failures" | "submits" | "invalid" | "inputs" | "buttons"
        | "frames" => {
            value.len() <= 6 && value.parse::<u32>().is_ok_and(|number| number <= 100_000)
        }
        _ => false,
    }
}

fn sanitized_line(line: &str) -> Option<String> {
    let (timestamp, rest) = line.strip_prefix('[')?.split_once("] [")?;
    chrono::NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%d %H:%M:%S%.3f").ok()?;
    let (scope, message) = rest.split_once("] ")?;
    let scope = match scope {
        "login" | "phone-form" | "phonelogin" | "chatgpt" | "claude" | "grok" | "wake"
        | "wake-word" | "media" | "mpv" | "yt-dlp" | "shell" | "updater" | "audio"
        | "bootstrap" | "gateway" | "tauri" | "wry" | "lilo" | "storage" | "plugins"
        | "plugin-host" | "menu" | "frontend" | "session" | "voice" | "diagnostics" => scope,
        _ => "other",
    };
    let mut fields = BTreeSet::new();
    for token in
        message.split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_' | '=' | '.'))
    {
        if let Some((key, value)) = token.split_once('=') {
            if approved_field(key, value) {
                fields.insert(format!("{key}={value}"));
            }
        } else {
            let event = token.to_ascii_lowercase();
            if matches!(
                event.as_str(),
                "opening"
                    | "created"
                    | "reusing"
                    | "clearing"
                    | "navigating"
                    | "ready"
                    | "working"
                    | "ask"
                    | "challenge"
                    | "idle"
                    | "done"
                    | "failed"
                    | "error"
                    | "timeout"
                    | "dead"
                    | "connected"
                    | "disconnected"
                    | "blocked"
                    | "stopped"
                    | "started"
                    | "denied"
            ) {
                fields.insert(format!("event={event}"));
            }
        }
    }
    for code in ["0x8007139F", "0x80070005", "0x80004005"] {
        if message.contains(code) {
            fields.insert(format!("hresult={code}"));
        }
    }
    if fields.is_empty() {
        fields.insert("event=recorded".into());
    }
    Some(format!(
        "[{timestamp}] [{scope}] {}",
        fields.into_iter().collect::<Vec<_>>().join(" ")
    ))
}

fn sanitize_snapshot(raw: &str) -> String {
    let header = format!(
        "LILO diagnostic report\nversion={}\nos={}\narchitecture={}\n\nOnly approved diagnostic fields are included. Account details, conversations, credentials, URLs and file paths are omitted.\n\n",
        env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH,
    );
    let events = raw
        .lines()
        .filter_map(sanitized_line)
        .collect::<Vec<_>>()
        .join("\n");
    format!("{header}{events}\n")
}

/// Saves a bounded, sanitized snapshot only after the user chooses a file.
#[tauri::command]
pub async fn export_logs(app: AppHandle, title: String) -> Result<bool, AppError> {
    if EXPORTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::other("A diagnostic export is already open"));
    }
    let _guard = ExportGuard;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(format!(
            "lilo-diagnostics-{}.txt",
            chrono::Utc::now().format("%Y%m%d-%H%M%S")
        ))
        .add_filter("Text", &["txt"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx
        .await
        .map_err(|_| AppError::other("The save dialog did not respond"))?
    else {
        return Ok(false);
    };
    let path = path
        .into_path()
        .map_err(|_| AppError::other("Choose a local file for the diagnostic export"))?;
    tokio::task::spawn_blocking(move || {
        let raw = crate::logging::snapshot(SNAPSHOT_BYTES)
            .map_err(|_| AppError::other("Could not read the diagnostic snapshot"))?;
        std::fs::write(path, sanitize_snapshot(&raw))
            .map_err(|_| AppError::other("Could not save the diagnostic report"))?;
        crate::logging::log("diagnostics", "export done");
        Ok(true)
    })
    .await
    .map_err(|_| AppError::other("The diagnostic export could not finish"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_state_without_credentials_addresses_or_conversations() {
        let raw = "[2026-10-04 12:34:56.789] [phone-form] page: auth.openai.com/login state=complete hidden=true focused=false writes=2 status=401 account=private@example.com token=secret-value\n[2026-10-04 12:34:57.789] [session] transcript: a private conversation\n[2026-10-04 12:34:58.789] [login] opening chatgpt window (clear_session=true) C:\\Users\\PersonalName\\profile https://example.com/?token=secret-value\n";
        let report = sanitize_snapshot(raw);
        assert!(report.contains("state=complete"));
        assert!(report.contains("hidden=true"));
        assert!(report.contains("status=401"));
        assert!(report.contains("clear_session=true"));
        for private in [
            "private@example.com",
            "secret-value",
            "auth.openai.com",
            "private conversation",
            "PersonalName",
            "https://",
            "token=",
        ] {
            assert!(
                !report.contains(private),
                "export retained private content: {private}"
            );
        }
    }

    #[test]
    fn rejects_unstructured_lines_and_sensitive_scope_names() {
        let raw = "an unstructured secret\n[2026-10-04 12:34:56.789] [private@example.com] error state=complete\n";
        let report = sanitize_snapshot(raw);
        assert!(!report.contains("secret"));
        assert!(!report.contains("private@example.com"));
        assert!(report.contains("[other]"));
    }

    #[test]
    fn rejects_unknown_values_in_approved_fields() {
        let raw = "[2026-10-04 12:34:56.789] [login] state=secret-value status=123456789 hidden=private@example.com progress=secret-value\n";
        let report = sanitize_snapshot(raw);
        assert!(!report.contains("secret-value"));
        assert!(!report.contains("123456789"));
        assert!(!report.contains("private@example.com"));
    }
}
