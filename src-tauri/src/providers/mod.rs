//! The voice backends, and the one generic way the app drives their sign-in.
//!
//! Each backend declares a [`WebBackend`]: its window, the script injected into
//! it, the event it reports on, and how to turn what that script reports into
//! an [`accounts::Account`]. Everything else — opening the window, storing the
//! account, keeping the window as a hidden transport, telling the frontend —
//! happens here, once, for all of them. Adding a backend is one entry in
//! [`BACKENDS`], not another copy of four commands.

pub mod chatgpt;
pub mod chatgpt_history;
pub mod chatgpt_images;
pub mod claude;
pub mod claude_voice;
pub mod cloak;
pub mod grok;
pub mod grok_voice;
pub(crate) mod idle;
pub mod phone_form;
mod web_identity;
pub mod web_login;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::accounts;
use crate::error::AppError;
use crate::logging;
use crate::providers::web_login::LoginWindow;

/// The one event every backend's sign-in reports on; `provider` says whose.
pub const LOGIN_EVENT: &str = "provider-login-status";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub provider: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl LoginStatus {
    pub fn ok(provider: &str, email: String) -> Self {
        Self {
            provider: provider.to_string(),
            status: "ok".to_string(),
            email: Some(email),
            message: None,
        }
    }

    pub fn error(provider: &str, message: impl Into<String>) -> Self {
        Self {
            provider: provider.to_string(),
            status: "error".to_string(),
            email: None,
            message: Some(message.into()),
        }
    }
}

/// What the injected script reported: an account, or why it cannot be one.
type AccountFrom = fn(&tauri::Url) -> Option<Result<accounts::Account, String>>;
/// A backend's own extra navigation (ChatGPT's request bridge). `true` when the
/// url was consumed.
type ExtraNavigation = fn(&AppHandle, &tauri::Url) -> bool;

/// One sign-in backend, declared as data.
pub struct WebBackend {
    /// Matches the provider id the frontend and the account store use.
    pub id: &'static str,
    /// Human-readable name used by generic sign-in surfaces.
    pub display_name: &'static str,
    pub window: LoginWindow,
    /// Where the window goes after sign-in, to serve as the hidden transport.
    pub home_url: &'static str,
    /// Some web login forms have a dedicated route that is more reliable for phone-driven sign-in.
    pub phone_login_url: Option<&'static str>,
    pub script: &'static str,
    pub account_from: AccountFrom,
    pub extra_navigation: Option<ExtraNavigation>,
    /// How the phone sign-in opens this backend's login form, if it has one.
    pub phone: Option<phone_form::PhoneForm<'static>>,
    /// Set once the window is the hidden transport: further session reports
    /// then refresh the account silently, instead of navigating (which would
    /// reload the page and kill the transport) and announcing a new sign-in.
    hosting: &'static AtomicBool,
    /// Whether the transport's page has reported since it was created. The
    /// bridge may only run on a page that is signed in and loaded: evaluating
    /// the script into a navigation still in flight loses it silently.
    ready: &'static AtomicBool,
}

static CHATGPT_HOSTING: AtomicBool = AtomicBool::new(false);
static CLAUDE_HOSTING: AtomicBool = AtomicBool::new(false);
static CHATGPT_READY: AtomicBool = AtomicBool::new(false);
static CLAUDE_READY: AtomicBool = AtomicBool::new(false);
static GROK_HOSTING: AtomicBool = AtomicBool::new(false);
static GROK_READY: AtomicBool = AtomicBool::new(false);

pub static BACKENDS: &[WebBackend] = &[
    WebBackend {
        id: accounts::PROVIDER_GROK,
        display_name: "Grok",
        window: grok::SPEC,
        home_url: grok::HOME_URL,
        phone_login_url: None,
        script: grok::LOGIN_SCRIPT,
        account_from: grok::account_from,
        extra_navigation: None,
        phone: Some(grok::PHONE_FORM),
        hosting: &GROK_HOSTING,
        ready: &GROK_READY,
    },
    WebBackend {
        id: accounts::PROVIDER_CHATGPT,
        display_name: "ChatGPT",
        window: chatgpt::SPEC,
        home_url: chatgpt::HOME_URL,
        phone_login_url: None,
        script: chatgpt::LOGIN_SCRIPT,
        account_from: chatgpt::account_from,
        extra_navigation: Some(chatgpt::resolve_bridge_navigation),
        phone: Some(chatgpt::PHONE_FORM),
        hosting: &CHATGPT_HOSTING,
        ready: &CHATGPT_READY,
    },
    WebBackend {
        id: accounts::PROVIDER_CLAUDE,
        display_name: "Claude",
        window: claude::SPEC,
        home_url: claude::HOME_URL,
        phone_login_url: None,
        script: claude::LOGIN_SCRIPT,
        account_from: claude::account_from,
        extra_navigation: None,
        phone: Some(claude::PHONE_FORM),
        hosting: &CLAUDE_HOSTING,
        ready: &CLAUDE_READY,
    },
];

pub fn backend(id: &str) -> Option<&'static WebBackend> {
    BACKENDS.iter().find(|backend| backend.id == id)
}

/// The web session cookie, as a ready-to-send `Cookie` header.
///
/// Must run off the main thread (reading cookies deadlocks on Windows
/// otherwise, wry#583); the caller already is.
pub(crate) fn capture_session_cookie(window: &tauri::WebviewWindow) -> Option<String> {
    let url: tauri::Url = lilo_core::refresh::SESSION_URL.parse().ok()?;
    let cookies = match window.cookies_for_url(url) {
        Ok(cookies) => cookies,
        Err(error) => {
            logging::log(
                "login",
                &format!("reading the session cookies failed: {error}"),
            );
            return None;
        }
    };
    let pairs = cookies
        .into_iter()
        .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()));
    let header = lilo_core::refresh::cookie_header(pairs);
    (!header.is_empty()).then_some(header)
}

fn require(id: &str) -> Result<&'static WebBackend, AppError> {
    backend(id).ok_or_else(|| AppError::other(format!("unknown provider \"{id}\"")))
}

impl WebBackend {
    pub fn hosting(&self) -> bool {
        self.hosting.load(Ordering::SeqCst)
    }

    pub fn set_hosting(&self, hosting: bool) {
        self.hosting.store(hosting, Ordering::SeqCst);
    }

    /// Whether the transport's page has reported since it was created. The
    /// bridge may only run once this is true: evaluating it into a page that
    /// is still navigating loses the script silently.
    pub fn host_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// Opens (or reveals) the sign-in window. `clear_session` starts fresh;
    /// otherwise the signed-in session is reused to re-read the identity.
    pub fn open_window(
        &'static self,
        app: &AppHandle,
        clear_session: bool,
    ) -> Result<(), AppError> {
        self.set_hosting(false);
        // The page is about to sign in again: until it reports, it is not a
        // usable transport.
        self.ready.store(false, Ordering::SeqCst);
        let handle = app.clone();
        web_login::open(
            app,
            &self.window,
            self.script,
            clear_session,
            true,
            move |url| handle_navigation(&handle, url),
        )
    }

    /// Opens the login page on a clean session, out of sight: the phone
    /// sign-in fills it in from the phone.
    pub fn open_hidden_login(&'static self, app: &AppHandle) -> Result<(), AppError> {
        self.set_hosting(false);
        self.ready.store(false, Ordering::SeqCst);
        let handle = app.clone();
        let phone_window = LoginWindow {
            label: self.window.label,
            title: self.window.title,
            login_url: self.phone_login_url.unwrap_or(self.window.login_url),
        };
        web_login::open(app, &phone_window, self.script, true, false, move |url| {
            handle_navigation(&handle, url)
        })
    }

    /// Makes sure the hidden window exists (e.g. after a restart) without
    /// showing anything. Returns whether it had to be created.
    pub fn ensure_host(&'static self, app: &AppHandle) -> Result<bool, AppError> {
        idle::touch_host_use();
        let handle = app.clone();
        let created =
            web_login::ensure_hidden(app, &self.window, self.home_url, self.script, move |url| {
                handle_navigation(&handle, url)
            })?;
        if created {
            self.ready.store(false, Ordering::SeqCst);
            self.set_hosting(true);
        }
        Ok(created)
    }
}

/// One `tauri-voice://` callback, dispatched to whichever backend owns it.
/// Returns `true` to let the navigation proceed.
pub fn handle_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    if url.scheme() != web_login::SCHEME {
        return true;
    }
    if phone_form::resolve_navigation(app, url) {
        return false;
    }
    for backend in BACKENDS {
        if let Some(result) = (backend.account_from)(url) {
            backend.accept(app, result);
            return false;
        }
        if let Some(extra) = backend.extra_navigation {
            if extra(app, url) {
                return false;
            }
        }
    }
    false
}

impl WebBackend {
    /// Stores a reported account and reports the outcome to the frontend.
    fn accept(&'static self, app: &AppHandle, account: Result<accounts::Account, String>) {
        // Signals a waiting voice session that the page is usable.
        if self.hosting() {
            self.ready.store(true, Ordering::SeqCst);
        }
        let state = app.state::<crate::AppState>();
        let result = account.and_then(|account| {
            let email = account.email.clone();
            state
                .accounts
                .add(account)
                .map(|()| email)
                .map_err(|e| e.to_string())
        });

        if self.hosting() {
            // The hidden transport reloaded: the account is refreshed, and the
            // page must stay exactly where it is.
            match result {
                Ok(_) => logging::log(self.id, "account refreshed from the web session"),
                Err(error) => {
                    logging::log(self.id, &format!("host session refresh failed: {error}"))
                }
            }
            return;
        }

        match result {
            Ok(email) => {
                phone_form::finished(self.id);
                // Never touch the webview synchronously from inside the
                // navigation handler; defer the UI work to a short thread.
                let handle = app.clone();
                let home = self.home_url;
                let stored = email.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if let Some(window) = handle.get_webview_window(self.window.label) {
                        // The session cookie is the long-lived credential. Take
                        // it now, while the window is here, so a later token
                        // refresh needs no webview at all.
                        if self.id == accounts::PROVIDER_CHATGPT {
                            match capture_session_cookie(&window) {
                                Some(cookie) => handle
                                    .state::<crate::AppState>()
                                    .accounts
                                    .set_session_cookie(self.id, &stored, &cookie),
                                None => logging::log(
                                    self.id,
                                    "no session cookie captured — token refresh will need the window",
                                ),
                            }
                        }
                        // Back to the backend's own origin, so the window can
                        // serve as the transport, then out of sight.
                        if let Ok(url) = home.parse() {
                            let _ = window.navigate(url);
                        }
                        let _ = window.hide();
                        cloak::uncloak(&window);
                        self.set_hosting(true);
                        idle::touch_host_use();
                    }
                    let _ = handle.emit(LOGIN_EVENT, LoginStatus::ok(self.id, email));
                });
            }
            Err(error) => {
                let _ = app.emit(LOGIN_EVENT, LoginStatus::error(self.id, error));
            }
        }
    }
}

// --- the generic commands ----------------------------------------------------

/// Opens a backend's sign-in window, starting from a clean session.
///
/// Async on purpose: a synchronous command runs on the main thread, where
/// creating a webview deadlocks on Windows (tauri-apps/tauri#10919) — and the
/// frozen main thread takes every other command down with it.
pub(crate) fn plugin_identity(id: &str) -> Option<(&str, &str)> {
    let (owner, local) = id.strip_prefix("plugin:")?.split_once('/')?;
    if owner.is_empty()
        || owner.len() > 128
        || local.is_empty()
        || local.len() > 64
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        || !local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some((owner, local))
}

#[tauri::command]
pub async fn provider_login(app: AppHandle, provider: String) -> Result<(), AppError> {
    if let Some((owner, local)) = plugin_identity(&provider) {
        return app
            .state::<std::sync::Arc<crate::plugin_browser::DesktopBrowser>>()
            .login(owner.into(), local.into(), true)
            .await;
    }
    require(&provider)?.open_window(&app, true)
}

/// Re-reads the signed-in identity without wiping the session.
///
/// Async for the same WebView2 reason as [`provider_login`].
#[tauri::command]
pub async fn provider_profile_refresh(app: AppHandle, provider: String) -> Result<(), AppError> {
    if let Some((owner, local)) = plugin_identity(&provider) {
        return app
            .state::<std::sync::Arc<crate::plugin_browser::DesktopBrowser>>()
            .login(owner.into(), local.into(), false)
            .await;
    }
    require(&provider)?.open_window(&app, false)
}

#[tauri::command]
pub fn provider_login_cancel(app: AppHandle, provider: String) {
    if let Some((owner, local)) = plugin_identity(&provider) {
        app.state::<std::sync::Arc<crate::plugin_browser::DesktopBrowser>>()
            .cancel(owner, local);
        return;
    }

    if let Some(backend) = backend(&provider) {
        if let Some(window) = app.get_webview_window(backend.window.label) {
            let _ = window.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_backend_is_addressable_by_its_provider_id() {
        for declared in BACKENDS {
            assert_eq!(backend(declared.id).map(|b| b.id), Some(declared.id));
        }
        assert!(backend("nope").is_none());
    }

    #[test]
    fn a_backend_starts_out_not_hosting() {
        let backend = backend(accounts::PROVIDER_CLAUDE).unwrap();
        backend.set_hosting(false);
        assert!(!backend.hosting());
        backend.set_hosting(true);
        assert!(backend.hosting());
        backend.set_hosting(false);
    }
}
