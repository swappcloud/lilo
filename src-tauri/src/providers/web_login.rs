//! Shared plumbing for "sign in through an embedded webview".
//!
//! Each backend supplies what is genuinely its own — window labels, URLs, the
//! injected script and a navigation handler — while the mechanics (reuse the
//! window, optional session wipe, focus) live here once. Adding a third backend
//! is a new module with a `LoginWindow` spec, not another copy of this.

use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::AppError;
use crate::logging;
use crate::providers::cloak;

/// The private scheme every injected script reports back through. Navigating
/// to it is intercepted and blocked before any network request happens.
pub const SCHEME: &str = "tauri-voice";

/// Where this backend keeps its own webview profile.
///
/// WebView2 refuses to create a webview in a data directory that is already
/// bound to different browser arguments (`HRESULT(0x8007139F)`): the main
/// window ships its own arguments, so a backend window must not share its
/// directory or every sign-in window silently fails to be created. Isolating
/// them also means clearing a session clears only that backend's.
fn profile_dir(app: &AppHandle, label: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("webview").join(label);
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// WKWebView has no data directory; a data store identifier is its equivalent
/// (macOS 14+/iOS 17+). Other platforms ignore it.
fn store_identifier(label: &str) -> [u8; 16] {
    let mut id = [0u8; 16];
    for (slot, byte) in id.iter_mut().zip(label.bytes()) {
        *slot = byte;
    }
    id
}

/// Gives a builder its backend's private profile on every platform.
fn with_profile<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    app: &'a AppHandle,
    label: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let builder = match profile_dir(app, label) {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    };
    builder.data_store_identifier(store_identifier(label))
}

/// Everything a backend's sign-in window needs to look like itself.
pub struct LoginWindow {
    pub label: &'static str,
    pub title: &'static str,
    pub login_url: &'static str,
}

/// Opens (or reveals) the embedded sign-in window for `spec`.
///
/// When `clear_session` is set the webview session is wiped *before* the login
/// page loads: loading first would let the injected script read leftover
/// cookies, hand the session back, and hide the window — a confusing
/// one-second flash. So we open on `about:blank`, clear, then navigate.
/// Must be called off the main thread (i.e. from an async command): creating a
/// webview on Windows deadlocks when done inside a synchronous command, see
/// <https://github.com/tauri-apps/tauri/issues/10919>. `build` then returns a
/// handle immediately and the window appears moments later on the event loop,
/// so this uses the returned handle instead of looking the window up again.
/// `show` is off when someone else drives the page (the phone sign-in).
pub fn open<F>(
    app: &AppHandle,
    spec: &LoginWindow,
    script: &'static str,
    clear_session: bool,
    show: bool,
    on_navigation: F,
) -> Result<(), AppError>
where
    F: Fn(&tauri::Url) -> bool + Send + Sync + 'static,
{
    logging::log(
        "login",
        &format!(
            "opening the {} sign-in window (clear_session={clear_session})",
            spec.label
        ),
    );

    if let Some(window) = app.get_webview_window(spec.label) {
        // A window creation that failed after the handle was registered leaves
        // a window Tauri still hands out but the runtime no longer owns: show
        // and navigate are no-ops and sign-in silently does nothing. Say so
        // instead of looking like the page refuses to load.
        match window.url() {
            Ok(url) => logging::log(
                "login",
                &format!("reusing the {} window (page {url})", spec.label),
            ),
            Err(error) => logging::log(
                "login",
                &format!(
                    "the {} window is dead ({error}) — restart the app; this handle cannot be recreated",
                    spec.label
                ),
            ),
        }
        if show {
            cloak::uncloak(&window);
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            cloak::cloak(&window);
        }
        if clear_session {
            wipe_and_navigate(window, spec.login_url);
        } else if let Ok(url) = spec.login_url.parse() {
            let _ = window.navigate(url);
        }
        return Ok(());
    }

    let start_url = if clear_session {
        "about:blank".to_string()
    } else {
        spec.login_url.to_string()
    };
    let start_url = start_url
        .parse()
        .map_err(|e| AppError::other(format!("invalid login URL: {e}")))?;

    let builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::External(start_url))
        .title(spec.title)
        .inner_size(520.0, 760.0)
        .visible(show)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(include_str!("../../../packages/phone-login/observer.js"))
        .initialization_script(script)
        .on_navigation(on_navigation);
    let window = with_profile(builder, app, spec.label)
        .build()
        .map_err(|e| {
            AppError::other(format!(
                "failed to open the {} sign-in window: {e}",
                spec.label
            ))
        })?;

    logging::log(
        "login",
        &format!("created the {} sign-in window", spec.label),
    );
    if !show {
        cloak::cloak(&window);
    }
    if clear_session {
        wipe_and_navigate(window, spec.login_url);
    }

    Ok(())
}

/// Builds the backend's window hidden, on `url`, when it does not exist yet.
///
/// A signed-in backend whose transport lives on its web origin needs that
/// window after a restart too, without flashing a sign-in page at the user.
/// Returns whether the window had to be created (so its page is still loading).
pub fn ensure_hidden<F>(
    app: &AppHandle,
    spec: &LoginWindow,
    url: &'static str,
    script: &'static str,
    on_navigation: F,
) -> Result<bool, AppError>
where
    F: Fn(&tauri::Url) -> bool + Send + Sync + 'static,
{
    if app.get_webview_window(spec.label).is_some() {
        return Ok(false);
    }
    let url = url
        .parse()
        .map_err(|e| AppError::other(format!("invalid host URL: {e}")))?;
    let builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::External(url))
        .title(spec.title)
        .inner_size(520.0, 760.0)
        .visible(false)
        // A hidden page still has to stream audio and run its timers.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(script)
        .on_navigation(on_navigation);
    with_profile(builder, app, spec.label)
        .build()
        .map_err(|e| AppError::other(format!("failed to open the {} window: {e}", spec.label)))?;
    Ok(true)
}

/// Wipes this backend's own profile, then opens its login page.
///
/// Scoped by `profile_dir`: signing in to one backend must not sign the other
/// one out (the whole-profile wipe is what destroyed ChatGPT's session cookie —
/// the one that refreshes its access token — and the app's localStorage).
fn wipe_and_navigate(window: tauri::WebviewWindow, login_url: &'static str) {
    std::thread::spawn(move || {
        if let Err(error) = window.clear_all_browsing_data() {
            logging::log(
                "login",
                &format!("clearing the webview session failed: {error}"),
            );
        }
        std::thread::sleep(Duration::from_millis(300));
        if let Ok(url) = login_url.parse() {
            if let Err(error) = window.navigate(url) {
                logging::log(
                    "login",
                    &format!("navigating to {login_url} failed: {error}"),
                );
            }
        }
    });
}

pub fn decode_base64_json<T: for<'de> Deserialize<'de>>(encoded: &str) -> Option<T> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_backend_gets_its_own_store_identifier() {
        assert_eq!(store_identifier("chatgpt"), store_identifier("chatgpt"));
        assert_ne!(store_identifier("chatgpt"), store_identifier("claude"));
        // Any label becomes exactly the 16 bytes the identifier takes.
        assert_eq!(
            store_identifier("a"),
            [b'a', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
    }
}
