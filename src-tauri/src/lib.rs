//! Tauri backend for LILO.
//!
//! The gateway (account pool + SDP proxy + session binding) lives here in Rust,
//! invoked from the React frontend over Tauri IPC. That means:
//!   * no CORS problems (IPC, not HTTP),
//!   * the ChatGPT access token never reaches JavaScript.

mod audio;
mod diagnostics;
mod gateway;
mod image_export;
mod logging;
mod phone_network;
mod phonelogin;
mod playback;
mod plugin_browser;
mod providers;
mod resources;
mod satellite;
mod shell;
mod statusbar;
mod updater;
mod vision;
mod wake;

// The command protocol, tool registry, settings and account store live in
// `lilo-core` so the headless headless Linux device daemon can reuse them verbatim.
// Re-exported under `crate::` so the modules below keep their existing paths.
pub use lilo_core::{accounts, error, settings, tools};

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use lilo_core::commands::manifest;
use lilo_core::commands::registry::CommandManifestEntry;
use lilo_core::commands::router::{CommandOutcome, Router, Speaker, Utterance};
use lilo_core::location::LocationPlugin;
use lilo_core::media::service::MediaService;
use lilo_core::plugins::marketplace::{self as market, CatalogEntry};
use lilo_core::plugins::{bus as plugin_bus, Event, EventBus};
use lilo_core::plugins::{store as plugin_store, PluginView, ToolProvider, ToolRegistry};
use lilo_core::tools::BuiltinTools;
use lilo_core::weather::WeatherPlugin;

use crate::accounts::AccountStore;
use crate::audio::NativeCapture;
use crate::error::AppError;
use crate::gateway::{Gateway, SessionBindings};
use crate::phonelogin::PhoneLogin;
use crate::providers::chatgpt::Bridge;
use crate::settings::SettingsStore;
use crate::wake::WakeWatcher;

pub struct AppState {
    accounts: AccountStore,
    settings: SettingsStore,
    bindings: SessionBindings,
    gateway: Gateway,
    native: NativeCapture,
    bridge: Bridge,
    wake: WakeWatcher,
    phone_login: PhoneLogin,
    /// The Claude voice engine's event sink, owned by the hidden window's
    /// transport (see `claude_voice`).
    claude_voice: providers::claude_voice::VoiceBridge,
    grok_voice: providers::grok_voice::VoiceBridge,
    /// The command protocol. Lives in `lilo-core` so the headless headless Linux device
    /// daemon runs exactly the same matching.
    router: std::sync::Mutex<Router>,
    media: Arc<MediaService>,
    /// Every tool the host can run, by provider. The host itself knows no tool
    /// names — this is the seam a plugin architecture hangs off.
    ///
    /// Behind an async lock because plugins are registered at runtime: the
    /// startup scan today, a marketplace install tomorrow.
    plugins: tokio::sync::RwLock<ToolRegistry>,
    /// Plugin-to-plugin events. The receiving end is drained by one task
    /// started in `setup`, which retains, delivers and mirrors to the UI.
    bus: Arc<EventBus>,
    bus_receiver: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Event>>>,
    startup: std::sync::Mutex<StartupState>,
    /// The no-microphone seam a headless client drives (see `satellite`).
    satellite: satellite::Satellite,
}

impl AppState {
    fn new(data_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);
        let settings = SettingsStore::load(data_dir.join("settings.json"));
        let media_settings = settings.get().media;
        let gateway = Gateway::new();
        let http = gateway.http().clone();
        let media = Arc::new(MediaService::new(
            media_settings,
            http.clone(),
            data_dir.clone(),
        ));
        logging::log(
            "media",
            &format!("mpv log: {}", media.mpv_log_path().display()),
        );

        // Built-ins first: their ids are compile-time constants, so a clash
        // here is a programming error we want loud, not a silent shadow.
        let (bus, bus_receiver) = EventBus::new();
        let mut plugins = ToolRegistry::new();
        if let Err(error) = plugins.register(Arc::new(lilo_core::plugins::ComputerApps::new())) {
            logging::log(
                "plugin",
                &format!("lilo.computer registration failed: {error}"),
            );
        }
        if let Err(error) = plugins.register(Arc::new(BuiltinTools::new(http.clone()))) {
            logging::log(
                "plugin",
                &format!("core.tools registration failed: {error}"),
            );
        }
        media.set_publisher(bus.publisher(&media.manifest().id));
        if let Err(error) = plugins.register(media.clone()) {
            logging::log(
                "plugin",
                &format!("core.media registration failed: {error}"),
            );
        }
        let location =
            LocationPlugin::new(http.clone(), bus.publisher(lilo_core::location::PLUGIN_ID));
        if let Err(error) = plugins.register(Arc::new(location)) {
            logging::log(
                "plugin",
                &format!("lilo.location registration failed: {error}"),
            );
        }
        if let Err(error) = plugins.register(Arc::new(WeatherPlugin::new(http))) {
            logging::log(
                "plugin",
                &format!("lilo.weather registration failed: {error}"),
            );
        }

        Self {
            accounts: AccountStore::load(data_dir.join("accounts.json")),
            settings,
            bindings: SessionBindings::default(),
            gateway,
            native: NativeCapture::new(),
            bridge: Bridge::default(),
            wake: WakeWatcher::new(),
            phone_login: PhoneLogin::new(),
            claude_voice: providers::claude_voice::VoiceBridge::new(),
            grok_voice: providers::grok_voice::VoiceBridge::default(),
            router: std::sync::Mutex::new(Router::new(DEFAULT_ASSISTANT_NAME)),
            media,
            plugins: tokio::sync::RwLock::new(plugins),
            bus,
            bus_receiver: std::sync::Mutex::new(Some(bus_receiver)),
            startup: std::sync::Mutex::new(StartupState::default()),
            satellite: satellite::Satellite::new(satellite::Config::from_env()),
        }
    }
}

/// Label of the primary window (Tauri's default when none is configured).
pub(crate) const MAIN_WINDOW: &str = "main";

use providers::idle::touch_host_use;

/// Stop everything this app spawned.
///
/// Idempotent, synchronous and safe from the main thread: it runs on window
/// destruction *and* on process exit, because neither alone is reliable —
/// a window event can be skipped on quit, and `Drop` never runs on a kill.
fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    state.wake.stop();
    state.claude_voice.stop();
    state.grok_voice.stop();
    state.media.stop_playback();
    // Belt and braces: anything that escaped the handle above.
    let reaped = state.media.reap_orphans();
    if reaped > 0 {
        logging::log("app", &format!("shutdown reaped {reaped} stray player(s)"));
    }
}

/// Fallback until the frontend reports the configured wake phrase. Commands
/// address the assistant by the last word of that phrase.
const DEFAULT_ASSISTANT_NAME: &str = "lilo";

/// How often settled slot commands are released. Short enough to feel
/// immediate, long enough to cost nothing on a small board.
const ROUTER_TICK_MS: u64 = 250;

/// Monotonic-enough milliseconds for the router's debounce bookkeeping.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvInfo {
    platform: String,
    webview: String,
    app_version: String,
    native_audio_available: bool,
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> settings::Settings {
    state.settings.get()
}

#[tauri::command]
async fn set_settings(
    state: State<'_, AppState>,
    settings: settings::Settings,
) -> Result<(), AppError> {
    // Re-locate mpv/yt-dlp too: installing them should not require a restart.
    // Async on purpose: `apply_settings` touches the player mutex, which
    // `media_play` holds for seconds while a stream opens — a sync command
    // would run that wait on the main thread and freeze the window.
    state.media.apply_settings(settings.media.clone()).await?;
    state.settings.set(settings)
}

// ---------------------------------------------------------------------------
// Account pool
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_accounts(state: State<'_, AppState>) -> Vec<accounts::AccountView> {
    state.accounts.list()
}

#[tauri::command]
fn add_account(
    state: State<'_, AppState>,
    email: String,
    access_token: String,
    device_id: Option<String>,
    proxy: Option<String>,
) -> Result<(), AppError> {
    // Users paste the whole session object, not a bare token — and the display
    // name only exists in that envelope, never in the JWT. Accept both.
    let parsed = accounts::parse_session_paste(&access_token)
        .ok_or_else(|| AppError::other("that is not a session object or an access token"))?;

    let email = match email.trim() {
        "" => parsed.email.clone(),
        given => given.to_string(),
    };
    let email = if email.is_empty() {
        "chatgpt-account".to_string()
    } else {
        email
    };

    let mut account = accounts::Account::chatgpt(email, parsed.name, parsed.access_token);
    account.device_id = device_id.unwrap_or_default();
    account.proxy = proxy.unwrap_or_default();
    state.accounts.add(account)
}

#[tauri::command]
async fn remove_account(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    email: String,
) -> Result<bool, AppError> {
    if let Some((owner, _)) = provider
        .strip_prefix("plugin:")
        .and_then(|id| id.split_once('/'))
    {
        app.state::<Arc<plugin_browser::DesktopBrowser>>()
            .close_owner(owner, true);
    }
    state.accounts.remove(&provider, &email)
}

// ---------------------------------------------------------------------------
// Claude voice: the hidden window runs the transport, this side relays events
// ---------------------------------------------------------------------------

/// Starts the Claude voice engine in the hidden window. Resolves once the
/// engine has reported in, so a dead mic or socket fails loudly.
#[tauri::command]
async fn claude_voice_start(
    app: AppHandle,
    state: State<'_, AppState>,
    options: providers::claude_voice::StartOptions,
) -> Result<String, AppError> {
    state.claude_voice.start(&app, options).await
}

#[tauri::command]
fn claude_voice_stop(app: AppHandle, state: State<'_, AppState>) {
    touch_host_use();
    if let Some(window) = app.get_webview_window(providers::claude::WINDOW_LABEL) {
        let _ = window.eval("window.__liloClaudeVoice?.stop?.();");
    }
    state.claude_voice.stop();
}

/// One microphone chunk (16 kHz PCM16, base64) for the voice socket.
///
/// The microphone lives in the main window — WebKit holds capture back in a
/// hidden page — so every chunk is handed to the engine in the claude.ai window.
#[tauri::command]
fn claude_voice_audio(app: AppHandle, state: State<'_, AppState>, chunk: String) {
    if !state.claude_voice.active() || !providers::claude_voice::is_base64(&chunk) {
        return;
    }
    if let Some(window) = app.get_webview_window(providers::claude::WINDOW_LABEL) {
        let _ = window.eval(format!("window.__liloClaudeVoice?.sendPcm?.('{chunk}');"));
    }
}

/// Whether a voice session is running (the frontend asks before assuming state).
#[tauri::command]
fn claude_voice_active(state: State<'_, AppState>) -> bool {
    state.claude_voice.active()
}

// ---------------------------------------------------------------------------
// Phase 3 — voice session (SDP proxy)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn create_voice_session(
    app: AppHandle,
    state: State<'_, AppState>,
    offer_sdp: String,
    voice: Option<String>,
    voice_mode: Option<String>,
    language_code: Option<String>,
    resume: Option<gateway::VoiceResume>,
) -> Result<gateway::SessionOutcome, AppError> {
    let resume = resume.unwrap_or_default();
    let voice_session_id = resume.voice_session_id;
    let conversation_id = resume.conversation_id;
    let parent_message_id = resume.parent_message_id;
    let settings = state.settings.get();

    // Prefer the account already bound to a resumed session, if any.
    let preferred = voice_session_id
        .as_deref()
        .and_then(|sid| state.bindings.get(sid))
        .map(|b| b.access_token);
    let account = state
        .accounts
        .pick(accounts::PROVIDER_CHATGPT, preferred.as_deref())
        .ok_or(AppError::NoAccount)?;

    let voice = voice.unwrap_or_else(|| settings.default_voice.clone());
    let voice_mode = voice_mode.unwrap_or_else(|| settings.voice_mode.clone());
    let language_code = language_code.unwrap_or_else(|| "auto".to_string());

    // Normalize once so both the browser bridge and the direct client send an
    // SDP with CRLF line endings and a trailing newline (required upstream).
    let offer_sdp = gateway::normalize_sdp(&offer_sdp)?;

    // Preferred path: post the offer from inside the signed-in chatgpt.com
    // webview, so the browser's TLS fingerprint, cookies and Cloudflare
    // clearance are used. Falls back to the native Rust client on any error.
    //
    // The window is created on demand — it costs hundreds of MB, and nothing
    // but a voice session needs it (token refresh is HTTP-only now). A window
    // that has never reported cannot run the bridge yet: its page is still
    // loading, and evaluating the script into a navigation in flight loses it
    // silently. Waiting for that report used to cost a cold session a fixed
    // 15 seconds before falling back to the direct client, which connects in a
    // fraction of a second. So create the window, leave it loading for the
    // next session, and take the direct client now.
    let mut bridge_ready = false;
    if let Some(backend) = providers::backend(accounts::PROVIDER_CHATGPT) {
        if app
            .get_webview_window(providers::chatgpt::WINDOW_LABEL)
            .is_some()
        {
            bridge_ready = backend.host_ready();
            if !bridge_ready {
                logging::log(
                    "session",
                    "hidden transport still loading; using the direct client",
                );
            }
        } else {
            match backend.ensure_host(&app) {
                Ok(true) => logging::log(
                    "session",
                    "hidden transport created; using the direct client while it loads",
                ),
                Ok(false) => {}
                Err(error) => {
                    logging::log("session", &format!("hidden transport unavailable: {error}"));
                }
            }
        }
    }
    if bridge_ready {
        // Reusing the same id across reconnects is what keeps this inside the
        // same chatgpt.com conversation — a fresh one every call (the old
        // behaviour) filled the account's history with a "Voice assistant
        // setup" thread per wake word.
        let session_id = match voice_session_id.as_deref() {
            Some(existing) if !existing.trim().is_empty() => existing.trim().to_string(),
            _ => gateway::new_session_id(),
        };
        let session_json = gateway::build_session_json_with_conversation(
            &voice,
            &voice_mode,
            &language_code,
            &session_id,
            conversation_id.as_deref(),
            parent_message_id.as_deref(),
        );
        match providers::chatgpt::bridge_create_session(
            &app,
            &state.bridge,
            &session_json,
            &offer_sdp,
            &account.device_id,
        )
        .await
        {
            Ok(answer) => {
                // The offer was already accepted upstream — never retry it via
                // the direct path, or a second server-side session is created
                // (which can make the assistant audible twice).
                let answer_sdp = gateway::validate_answer_sdp(&answer)?;
                let bound = state.bindings.bind(Some(session_id.as_str()), &account);
                return Ok(gateway::SessionOutcome {
                    answer_sdp,
                    voice_session_id: bound,
                    voice: gateway::normalize_voice(&voice),
                    voice_mode,
                    device_id: account.device_id.clone(),
                    account_email: account.email.clone(),
                    proxy_source: "browser-bridge".to_string(),
                });
            }
            Err(err) => eprintln!("browser bridge unavailable, falling back to direct: {err}"),
        }
    }

    let request = gateway::SessionRequest {
        offer_sdp: &offer_sdp,
        voice: &voice,
        voice_mode: &voice_mode,
        language_code: &language_code,
        voice_session_id: voice_session_id.as_deref(),
        conversation_id: conversation_id.as_deref(),
        parent_message_id: parent_message_id.as_deref(),
    };

    let mut result = attempt_session(&state, &settings, &account, &request).await;
    let mut account = account;
    if matches!(&result, Err(AppError::Gateway(msg)) if msg.contains("401")) {
        // A 401 usually means the stored token aged out, not that the session
        // died: refresh over plain HTTP with the stored cookie and retry once.
        // Only a dead cookie ends in "sign in again".
        match refresh_chatgpt_account(&app, state.inner()).await {
            Ok(refreshed) => {
                logging::log(
                    "session",
                    &format!("token refreshed over http for {}", refreshed.email),
                );
                account = refreshed;
                result = attempt_session(&state, &settings, &account, &request).await;
            }
            Err(error) => {
                logging::log("session", &format!("http token refresh failed: {error}"));
            }
        }
    }

    match result {
        Ok(mut outcome) => {
            // Reuse the upstream session id when the gateway supplied one.
            let bind_id = if outcome.voice_session_id.is_empty() {
                voice_session_id.as_deref()
            } else {
                Some(outcome.voice_session_id.as_str())
            };
            let bound = state.bindings.bind(bind_id, &account);
            outcome.voice_session_id = bound;
            if outcome.device_id.is_empty() {
                outcome.device_id = account.device_id.clone();
            }
            if outcome.account_email.is_empty() {
                outcome.account_email = account.email.clone();
            }
            touch_host_use();
            Ok(outcome)
        }
        Err(err) => {
            if matches!(&err, AppError::Gateway(msg) if msg.contains("401")) {
                state.accounts.mark_invalid(&account.access_token);
                // The design is "prompt re-login, never retry silently": tell
                // the UI this backend needs signing in again, so the account
                // is shown as needing attention instead of vanishing and
                // leaving the next wake word with "no account configured".
                let _ = app.emit(
                    providers::LOGIN_EVENT,
                    providers::LoginStatus::error(accounts::PROVIDER_CHATGPT, err.to_string()),
                );
            }
            Err(err)
        }
    }
}

/// One attempt at opening a voice session with one account.
async fn attempt_session(
    state: &AppState,
    settings: &settings::Settings,
    account: &accounts::Account,
    request: &gateway::SessionRequest<'_>,
) -> Result<gateway::SessionOutcome, AppError> {
    if settings.use_external_gateway {
        state
            .gateway
            .create_session_external(settings, account, request)
            .await
    } else {
        state
            .gateway
            .create_session_direct(settings, account, request)
            .await
    }
}

/// Fetches a fresh access token over plain HTTP with the stored session
/// cookie — no webview, no login window. This is the light refresh the
/// browserless mode (and the Pi) depends on.
///
/// The cookie can be missing (an install from before it was stored) or
/// rotated by chatgpt.com since; the hidden ChatGPT window's cookie store
/// keeps the live one across restarts, the way a browser does, so that is the
/// fallback before anyone is asked to sign in again.
async fn refresh_chatgpt_account(
    app: &AppHandle,
    state: &AppState,
) -> Result<accounts::Account, AppError> {
    let account = state
        .accounts
        .first(accounts::PROVIDER_CHATGPT)
        .ok_or(AppError::NoAccount)?;
    let settings = state.settings.get();
    if !account.session_cookie.is_empty() {
        match lilo_core::refresh::fetch_session(
            state.gateway.http(),
            &account.session_cookie,
            &settings.user_agent,
        )
        .await
        {
            Ok(fresh) => return store_refreshed(state, account, fresh),
            Err(error) => logging::log(
                "account",
                &format!("stored session cookie refused ({error}) — reading it from the window"),
            ),
        }
    }
    let cookie = window_session_cookie(app)
        .await
        .filter(|cookie| *cookie != account.session_cookie)
        .ok_or_else(|| AppError::other("the ChatGPT session has ended — sign in again"))?;
    state
        .accounts
        .set_session_cookie(&account.provider, &account.email, &cookie);
    let fresh =
        lilo_core::refresh::fetch_session(state.gateway.http(), &cookie, &settings.user_agent)
            .await?;
    let mut account = account;
    account.session_cookie = cookie;
    store_refreshed(state, account, fresh)
}

/// The session cookie from the hidden ChatGPT window, opening it if needed.
/// Runs off the main thread, as reading cookies requires.
async fn window_session_cookie(app: &AppHandle) -> Option<String> {
    let backend = providers::backend(accounts::PROVIDER_CHATGPT)?;
    if let Err(error) = backend.ensure_host(app) {
        logging::log(
            "account",
            &format!("opening the ChatGPT window failed: {error}"),
        );
        return None;
    }
    // A window created just now may need a moment before its store answers.
    for _ in 0..10 {
        if let Some(window) = app.get_webview_window(providers::chatgpt::WINDOW_LABEL) {
            if let Some(cookie) = providers::capture_session_cookie(&window) {
                return Some(cookie);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    None
}

fn store_refreshed(
    state: &AppState,
    account: accounts::Account,
    fresh: accounts::SessionPaste,
) -> Result<accounts::Account, AppError> {
    let mut updated = account;
    updated.access_token = fresh.access_token;
    if !fresh.name.trim().is_empty() {
        updated.name = fresh.name;
    }
    if !fresh.email.trim().is_empty() {
        updated.email = fresh.email;
    }
    updated.status = "ok".to_string();
    state.accounts.add(updated.clone())?;
    Ok(updated)
}

/// Refresh the ChatGPT token on demand, over HTTP. Returns the updated view.
#[tauri::command]
async fn refresh_account_token(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<accounts::AccountView, AppError> {
    let account = refresh_chatgpt_account(&app, state.inner()).await?;
    logging::log(
        "account",
        &format!("token refreshed over http for {}", account.email),
    );
    Ok(accounts::AccountView::from(&account))
}

#[tauri::command]
fn release_voice_session(state: State<'_, AppState>, voice_session_id: String) -> bool {
    touch_host_use();
    state.bindings.release(&voice_session_id)
}

#[tauri::command]
async fn upload_voice_image(
    state: State<'_, AppState>,
    voice_session_id: String,
    data_base64: String,
    mime: Option<String>,
    name: Option<String>,
) -> Result<gateway::UploadOutcome, AppError> {
    let settings = state.settings.get();
    let account = state
        .bindings
        .get(&voice_session_id)
        .and_then(|b| state.accounts.get_by_token(&b.access_token))
        .or_else(|| state.accounts.pick(accounts::PROVIDER_CHATGPT, None))
        .ok_or(AppError::NoAccount)?;

    let raw = data_base64.trim();
    let payload = raw
        .split_once(";base64,")
        .map(|(_, data)| data)
        .unwrap_or(raw);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| AppError::other(format!("invalid base64 image: {e}")))?;

    let mime = mime.unwrap_or_else(|| "image/png".to_string());
    let name = name.unwrap_or_else(|| "image.png".to_string());

    let file_id = state
        .gateway
        .upload_image(
            &settings,
            &account,
            &bytes,
            &name,
            &mime,
            vision::image_size(&bytes),
        )
        .await?;

    Ok(gateway::UploadOutcome {
        file_id,
        name,
        mime_type: mime,
        size: bytes.len(),
        voice_session_id,
    })
}

// ---------------------------------------------------------------------------
// Phase 6 — tools
// ---------------------------------------------------------------------------

/// The marketplace catalog, annotated with what is installed here.
#[tauri::command]
async fn marketplace_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<CatalogEntry>, AppError> {
    let (_, index) = marketplace_index(&app, &state, state.gateway.http()).await?;
    Ok(market::annotate(index, &plugins_dir(&state)?))
}

/// Install or update one plugin from the marketplace.
///
/// Installing and updating are the same operation: download, verify, replace.
/// After the swap the plugin is started and registered, so it works without a
/// restart.
#[tauri::command]
async fn plugin_install(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let http = state.gateway.http().clone();
    let root = plugins_dir(&state)?;
    // Files come from the source that served the index: their digests are in it.
    let (url, index) = marketplace_index(&app, &state, &http).await?;
    let entry = index
        .plugins
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| AppError::other(format!("{id} is not in the marketplace")))?;

    let _busy = PLUGIN_OPS.lock().await;
    // Stop the running copy *before* touching its folder: Windows keeps a
    // running program's files locked, and an update that swapped files under a
    // live process would leave it on the old code anyway.
    unload_plugin(&app, &id).await;
    let installed = market::install(&http, &url, &entry, &root).await;
    // Either way, start what is on disk: the new version, or the old one when
    // the install failed and left it untouched.
    reload_plugins(&app).await;
    installed?;
    logging::log("plugin", &format!("{id} installed ({})", entry.version));
    Ok(())
}

/// One install, update or uninstall at a time: two of them share the staging
/// folder and the registry, and a double click must not interleave them.
static PLUGIN_OPS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Activate or deactivate an installed plugin.
///
/// Deactivating takes it out of service — tools, voice commands and its
/// settings page — while keeping every file, its data and its settings;
/// activating brings back exactly the plugin the user had. First-party
/// in-process plugins have no folder and cannot be switched off.
#[tauri::command]
async fn set_plugin_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), AppError> {
    let root = plugins_dir(&state)?;
    let dir = plugin_store::plugin_dir(&root, &id)?;
    if !dir.join("plugin.json").is_file() {
        return Err(AppError::other(format!("{id} is not installed")));
    }
    let _busy = PLUGIN_OPS.lock().await;
    if enabled {
        plugin_store::set_enabled(&root, &id, true)?;
        reload_plugins(&app).await;
        logging::log("plugin", &format!("{id} activated"));
        return Ok(());
    }
    // Stopped first: on Windows a running plugin holds its files, and a marker
    // written under a live process would leave something the next reload has to
    // clean up.
    unload_plugin(&app, &id).await;
    if let Err(error) = plugin_store::set_enabled(&root, &id, false) {
        // Still on, still installed: bring it back rather than leave the list
        // claiming something that is not true.
        reload_plugins(&app).await;
        return Err(error);
    }
    logging::log("plugin", &format!("{id} deactivated"));
    Ok(())
}

#[tauri::command]
async fn plugin_uninstall(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let root = plugins_dir(&state)?;
    let _busy = PLUGIN_OPS.lock().await;
    // Stopped first, for the same reason as an update: its folder is locked
    // while it runs on Windows.
    unload_plugin(&app, &id).await;
    if let Err(error) = market::uninstall(&root, &id) {
        // Still on disk: bring it back rather than leave it silently stopped.
        reload_plugins(&app).await;
        return Err(error);
    }
    app.state::<Arc<plugin_browser::DesktopBrowser>>()
        .close_owner(&id, true);
    logging::log("plugin", &format!("{id} uninstalled"));
    Ok(())
}

/// Take a plugin out of service: withdraw its voice commands, drop it from the
/// registry and let it stop cleanly. Other plugins are not touched.
async fn unload_plugin(app: &AppHandle, id: &str) {
    app.state::<Arc<plugin_browser::DesktopBrowser>>()
        .close_owner(id, false);
    let state = app.state::<AppState>();
    state
        .router
        .lock()
        .expect("router poisoned")
        .remove_plugin_commands(id);
    let removed = state.plugins.write().await.remove(id);
    if let Some(provider) = removed {
        provider.shutdown().await;
        logging::log("plugin", &format!("{id} unloaded"));
    }
}

/// Every plugin the host knows about — running or not — with the UI each
/// running one asks for. A deactivated plugin is still listed: that is where
/// the switch to bring it back lives.
#[tauri::command]
async fn list_plugins(state: State<'_, AppState>) -> Result<Vec<PluginView>, AppError> {
    let root = plugins_dir(&state)?;
    let registry = state.plugins.read().await;
    Ok(lilo_core::plugins::installed_views(&root, &registry))
}

#[tauri::command]
async fn plugin_voice_call(
    state: State<'_, AppState>,
    id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let plugin = state
        .plugins
        .read()
        .await
        .provider(&id)
        .ok_or_else(|| AppError::other("Voice plugin is unavailable."))?;
    lilo_core::plugins::voice::call(&state.bus.voices(), plugin.as_ref(), request).await
}

#[tauri::command]
async fn plugin_settings(
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, AppError> {
    let root = plugins_dir(&state)?;
    Ok(plugin_store::load(&root, &id))
}

/// Persist a plugin's settings and hand them to the plugin, so a change takes
/// effect without a restart.
#[tauri::command]
async fn set_plugin_settings(
    state: State<'_, AppState>,
    id: String,
    settings: serde_json::Value,
) -> Result<(), AppError> {
    let root = plugins_dir(&state)?;
    plugin_store::save(&root, &id, &settings)?;
    // A plugin that cannot be reached is still saved: it reads the file on its
    // next call. Only a genuine plugin error is reported.
    let provider = state.plugins.read().await.provider(&id);
    let Some(provider) = provider else {
        return Ok(());
    };
    match provider.configure(settings).await {
        Ok(()) => Ok(()),
        Err(error) => {
            logging::log("plugin", &format!("configure {id} failed: {error}"));
            Err(error)
        }
    }
}

const BUNDLED_PLUGINS_DIR: &str = "plugins";

/// Development reads workspace examples; packaged apps resolve configured
/// repository sources with a bundled fallback (`settings::marketplace_sources`).
async fn marketplace_index(
    app: &AppHandle,
    state: &AppState,
    http: &reqwest::Client,
) -> Result<(String, market::MarketplaceIndex), AppError> {
    #[cfg(debug_assertions)]
    let development =
        Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins"));
    #[cfg(not(debug_assertions))]
    let development: Option<std::path::PathBuf> = None;
    let bundled = match &development {
        Some(directory) => directory.clone(),
        None => app
            .path()
            .resource_dir()
            .map_err(|error| AppError::other(format!("resource dir: {error}")))?
            .join(BUNDLED_PLUGINS_DIR),
    };
    let mut failure = None;
    for url in settings::marketplace_sources(
        &state.settings.get().marketplace_url,
        &bundled,
        development.as_deref(),
    ) {
        match market::fetch_index(http, &url).await {
            Ok(index) => return Ok((url, index)),
            Err(error) => {
                logging::log("plugin", &format!("marketplace {url} unavailable: {error}"));
                failure = Some(error);
            }
        }
    }
    Err(failure.unwrap_or_else(|| AppError::other("no marketplace configured")))
}

/// Where plugins live: `<app data>/plugins`.
fn plugins_dir(state: &AppState) -> Result<std::path::PathBuf, AppError> {
    let data_dir = state.media.data_dir();
    Ok(data_dir.join("plugins"))
}

#[tauri::command]
async fn list_tools(state: State<'_, AppState>) -> Result<Vec<tools::ToolDescriptor>, AppError> {
    // Whatever is registered, in registration order — a plugin shows up here
    // the moment it registers, with no change to the UI.
    Ok(state.plugins.read().await.descriptors())
}

#[tauri::command]
async fn run_tool(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    execute_tool(&app, &state, &name, &args).await
}

/// A plugin changed the background scene.
const EVENT_SCENE: &str = "lilo://scene";

/// A tool asked LILO's face to show (or drop) an expression.
const EVENT_MOOD: &str = "lilo://mood";
/// A tool asked the voice backend for a picture (`imagine: { prompt }`).
const EVENT_IMAGINE: &str = "lilo://imagine";

pub(crate) const EVENT_END_SESSION: &str = "lilo://end-session";

/// Tool dispatch, callable from the command router as well as from the UI.
///
/// Every call is logged: a tool invoked from a settings button used to leave no
/// trace at all, which made "I clicked and nothing happened" impossible to tell
/// apart from "the click never arrived".
async fn execute_tool(
    app: &AppHandle,
    state: &AppState,
    name: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    logging::log("tool", &format!("{name} {args}"));
    let mut value = match execute_tool_inner(state, name, args).await {
        Ok(value) => value,
        Err(error) => {
            logging::log("tool", &format!("{name} failed: {error}"));
            return Err(error);
        }
    };
    logging::log("tool", &format!("{name} ok"));
    // Any tool may change the background: a voice command, a settings
    // button or the scene poll all land here.
    if let Some(scene) = value.get("scene").filter(|scene| scene.is_object()) {
        let _ = app.emit(EVENT_SCENE, scene);
    }
    // Any tool may ask for a reaction: a voice command, a plugin, or a
    // settings button all land here, the same way a scene change does.
    if let Some(mood) = value.get("mood").filter(|mood| mood.is_object()) {
        let _ = app.emit(EVENT_MOOD, mood);
    }
    // A picture to make goes to the live session, which owns the backend; the
    // plugin that asked only names what to draw.
    if let Some(prompt) = value
        .get("imagine")
        .and_then(|imagine| imagine.get("prompt"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        let prompt: String = prompt.chars().take(500).collect();
        let _ = app.emit(EVENT_IMAGINE, serde_json::json!({ "prompt": prompt }));
    }
    if lilo_core::plugins::result_ends_session(&value) {
        let _ = app.emit(EVENT_END_SESSION, name);
    }
    // A picture in the result goes to the vision channel, which owns the
    // upload and the event; the bytes do not travel any further than here.
    vision::publish(app, &mut value)
        .await
        .map_err(|error| AppError::other(format!("could not share the screenshot: {error}")))?;
    // A song in the result goes to the player through the media service's own
    // search; the plugin that asked never touches the player.
    playback::publish(app, state, &mut value).await?;
    Ok(value)
}

pub(crate) async fn run_owned_tool(
    app: &AppHandle,
    source: &str,
    tool: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let state = app.state::<AppState>();
    let owned = state
        .plugins
        .read()
        .await
        .provider(source)
        .is_some_and(|provider| provider.handles(tool));
    if !owned {
        return Err(AppError::other(format!("{source} does not own {tool}")));
    }
    execute_tool(app, &state, tool, args).await
}

async fn execute_tool_inner(
    state: &AppState,
    name: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    // Look the owner up, release the lock, then run: a tool may take a minute,
    // and an install waiting for the write lock would otherwise block every
    // other tool call behind it.
    let provider = state.plugins.read().await.provider_for(name)?;
    provider.invoke(name, args).await
}

// ---------------------------------------------------------------------------
// Command protocol
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Startup progress
// ---------------------------------------------------------------------------

/// Startup progress, so the splash shows real work and can end.
const EVENT_STARTUP: &str = "lilo://startup";

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartupState {
    /// Short label for the current step.
    step: String,
    /// True once startup is finished; the splash removes itself on this.
    done: bool,
}

/// Record and broadcast a startup step. The state is kept so a frontend that
/// subscribes late can still catch up — otherwise a fast machine finishes
/// before React mounts and the splash would wait forever.
fn set_startup(app: &AppHandle, step: &str, done: bool) {
    let state = StartupState {
        step: step.to_string(),
        done,
    };
    if let Some(app_state) = app.try_state::<AppState>() {
        if let Ok(mut current) = app_state.startup.lock() {
            *current = state.clone();
        }
    }
    let _ = app.emit(EVENT_STARTUP, state);
}

#[tauri::command]
fn startup_state(state: State<'_, AppState>) -> StartupState {
    state.startup.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Outcomes the host must act on (barge-in, hang up, toast).
const EVENT_COMMAND: &str = "lilo://command";
/// The result of a tool a command triggered.
const EVENT_COMMAND_RESULT: &str = "lilo://command-result";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommandResultEvent {
    command: String,
    ok: bool,
    /// One line for the transcript.
    summary: String,
    /// Hidden turn for the model, so it narrates instead of refusing.
    hidden_note: String,
    /// A read tool returned selected data that should drive a spoken reply.
    follow_up: bool,
}

/// Emit outcomes, then run whatever tools they asked for.
///
/// Tools run here rather than in the frontend so the headless daemon can reuse
/// the identical path, and so the async work never blocks a caption.
fn dispatch_outcomes(app: &AppHandle, outcomes: Vec<CommandOutcome>) {
    if outcomes
        .iter()
        .flat_map(|outcome| &outcome.effects)
        .any(|effect| matches!(effect, lilo_core::commands::router::Effect::Confirm { .. }))
    {
        app.state::<AppState>()
            .bus
            .interrupt_questions("command-confirmation");
    }
    if outcomes.is_empty() {
        return;
    }
    let _ = app.emit(EVENT_COMMAND, &outcomes);

    for outcome in outcomes {
        run_tool_outcome(app, outcome);
    }
}

/// Run the tool an outcome asks for and report the result to the UI.
///
/// Split out of `dispatch_outcomes` because a confirmed command takes a second
/// path here: the router parked it, the user approved, and now it is exactly
/// the same work — same logging, same result event.
fn run_tool_outcome(app: &AppHandle, outcome: CommandOutcome) {
    let Some(tool) = outcome.tool.clone() else {
        return;
    };
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            let event = match execute_tool(&app, &state, &tool, &outcome.args).await {
                Ok(result) => {
                    let summary = manifest::describe(&outcome.command, &outcome.args, &result);
                    let follow_up = result
                        .get("context")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|context| !context.trim().is_empty());
                    logging::log("command", &format!("{} -> {summary}", outcome.command));
                    CommandResultEvent {
                        hidden_note: manifest::hidden_note_with_context(&summary, &result),
                        command: outcome.command,
                        ok: true,
                        summary,
                        follow_up,
                    }
                }
                Err(error) => {
                    let summary = manifest::describe_error(&outcome.command, &error.to_string());
                    logging::log("command", &summary);
                    CommandResultEvent {
                        hidden_note: manifest::hidden_note(&summary),
                        command: outcome.command,
                        ok: false,
                        summary,
                        follow_up: false,
                    }
                }
            };
            let _ = app.emit(EVENT_COMMAND_RESULT, event);
        });
    }
}

/// Answer a pending confirmation. Approving runs the parked command; declining
/// drops it and says so, because a silent no-op reads like a broken button.
#[tauri::command]
fn confirm_command(
    app: AppHandle,
    state: State<'_, AppState>,
    command: String,
    approved: bool,
) -> Result<(), AppError> {
    let outcome = state
        .router
        .lock()
        .expect("router poisoned")
        .resolve_confirmation(&command, approved);
    match outcome {
        Some(outcome) => {
            logging::log("command", &format!("{command} confirmed"));
            let summary = if approved {
                "confirmed".to_string()
            } else {
                "cancelled".to_string()
            };
            let _ = app.emit(
                EVENT_COMMAND_RESULT,
                CommandResultEvent {
                    command,
                    ok: approved,
                    summary,
                    hidden_note: String::new(),
                    follow_up: false,
                },
            );
            run_tool_outcome(&app, outcome);
            Ok(())
        }
        None => Err(AppError::other(format!(
            "nothing is waiting for confirmation: {command}"
        ))),
    }
}

/// Feed one caption into the router. Slotless commands come back immediately;
/// commands carrying free text are released by the tick task once the caption
/// stops growing.
#[tauri::command]
fn handle_utterance(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    speaker: String,
    turn_id: String,
    is_final: bool,
) -> Vec<CommandOutcome> {
    let speaker = match speaker.as_str() {
        "user" => Speaker::User,
        "assistant" => Speaker::Assistant,
        _ => Speaker::System,
    };
    process_utterance(&app, &state, text, speaker, turn_id, is_final, false, true)
}

/// Local ingress shares the router, confirmation flow, and tool host while
/// keeping speech out of logs and excluding prompt-only intents.
#[tauri::command]
fn handle_local_utterance(
    app: AppHandle,
    state: State<'_, AppState>,
    transcript: lilo_core::commands::local::Transcript,
) -> Result<Vec<CommandOutcome>, AppError> {
    if !transcript.valid() {
        return Err(AppError::other("Invalid local voice transcript"));
    }
    if !state.wake.is_running() {
        return Ok(vec![]);
    }
    Ok(process_utterance(
        &app,
        &state,
        transcript.text,
        Speaker::User,
        format!("local:{}", transcript.turn_id),
        transcript.is_final,
        true,
        false,
    ))
}

fn process_utterance(
    app: &AppHandle,
    state: &AppState,
    text: String,
    speaker: Speaker,
    turn_id: String,
    is_final: bool,
    local_only: bool,
    log_text: bool,
) -> Vec<CommandOutcome> {
    let outcomes = {
        let mut router = state.router.lock().expect("router poisoned");
        let utterance = Utterance {
            text: &text,
            speaker,
            turn_id: &turn_id,
            is_final,
        };
        if local_only {
            router.handle_local(utterance, now_ms())
        } else {
            router.handle(utterance, now_ms())
        }
    };
    if log_text && speaker == Speaker::User && is_final {
        logging::log(
            "command",
            &match outcomes.first() {
                Some(outcome) => format!("\"{text}\" -> {}", outcome.command),
                None => format!("\"{text}\" -> no command"),
            },
        );
    }
    dispatch_outcomes(app, outcomes.clone());
    outcomes
}

#[tauri::command]
fn list_commands(state: State<'_, AppState>, locale: Option<String>) -> Vec<CommandManifestEntry> {
    let router = state.router.lock().expect("router poisoned");
    let registry = router.registry();
    registry.manifest_in(
        locale
            .as_deref()
            .unwrap_or_else(|| registry.preferred_locale()),
    )
}

/// The line appended to the hidden persona message so the model knows LILO
/// already executed the command.
///
/// Includes what each installed plugin says it adds, so "what can you do?"
/// covers plugins too.
#[tauri::command]
async fn command_prompt_line(
    state: State<'_, AppState>,
    has_follow_up: bool,
) -> Result<String, AppError> {
    let plugins = state.plugins.read().await;
    let notes = plugins.prompts();
    drop(plugins);
    let router = state.router.lock().expect("router poisoned");
    Ok(manifest::prompt_line(
        router.registry(),
        &notes,
        has_follow_up,
    ))
}

/// Compose the canonical voice prompt with caller-provided, surface-specific facts.
#[tauri::command]
fn build_opening_prompt(
    custom_persona: Option<String>,
    language_preference: String,
    resolved_language: String,
    preferred_language_name: String,
    resolved_language_name: String,
    command_context: String,
    surface_facts: String,
    recap: String,
) -> std::result::Result<lilo_core::persona::OpeningPrompt, AppError> {
    lilo_core::persona::build_opening_prompt(
        custom_persona.as_deref(),
        &language_preference,
        &resolved_language,
        &preferred_language_name,
        &resolved_language_name,
        &command_context,
        &surface_facts,
        &recap,
    )
}

/// Rebuild the registry for a new wake phrase, and forget per-call state.
#[tauri::command]
fn set_assistant_name(state: State<'_, AppState>, name: String) {
    let trimmed = name.trim();
    let name = trimmed
        .split_whitespace()
        .next_back()
        .unwrap_or(DEFAULT_ASSISTANT_NAME);
    let mut router = state.router.lock().expect("router poisoned");
    router.set_name(name);
}

/// Restrict which languages are recognised. An empty list means all of them.
#[tauri::command]
fn set_command_locales(state: State<'_, AppState>, locales: Vec<String>) {
    state
        .router
        .lock()
        .expect("router poisoned")
        .set_locales(locales);
}

/// Languages the built-in commands are written in, for the settings picker.
#[tauri::command]
fn command_locales() -> Vec<String> {
    // Already owned strings: locales now come from data, not from `'static`.
    lilo_core::commands::registry::Registry::available_locales()
}

/// Called when a conversation starts or ends, so the next call is not blocked
/// by the previous one's cooldowns.
#[tauri::command]
fn reset_commands(state: State<'_, AppState>) {
    state.router.lock().expect("router poisoned").reset();
}

/// Start every plugin found under `<app data>/plugins`.
///
/// A plugin that fails to load is logged and skipped: one broken third-party
/// plugin must never keep LILO from starting, and silence would leave the user
/// wondering why their tool is missing.
async fn load_plugins(app: &AppHandle) {
    start_builtin_plugins(app).await;
    reload_plugins(app).await;
}

/// Every event on the plugin bus, as the UI sees it.
const EVENT_PLUGIN: &str = "lilo://plugin-event";

/// Drain the bus: retain, deliver to subscribers, mirror to the UI. One task,
/// so events of a topic arrive in the order they were published.
fn start_event_bus(app: &AppHandle) {
    let mut voices = app.state::<AppState>().bus.voices().subscribe();
    let voice_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match voices.recv().await {
                Ok(output) => {
                    let _ = voice_app.emit_to("main", "lilo://plugin-voice", output);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = voice_app.emit_to("main", "lilo://plugin-voice-overflow", ());
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let state = app.state::<AppState>();
    let Some(mut receiver) = state
        .bus_receiver
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
    else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(250));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let event = tokio::select! {
                event = receiver.recv() => match event { Some(event) => event, None => break },
                _ = timer.tick() => { app.state::<AppState>().bus.tick(); continue; }
            };
            logging::log("bus", &format!("{} from {}", event.topic, event.source));
            if !event.topic.starts_with("conversation.") {
                let _ = app.emit(EVENT_PLUGIN, &event);
            }
            if event.topic == statusbar::TOPIC {
                statusbar::publish(&app, &event.source, &event.payload);
            }
            let state = app.state::<AppState>();
            plugin_bus::dispatch(&state.bus, &state.plugins, event).await;
        }
    });
}

/// Give a newly registered provider the current value of what it subscribes
/// to, then let it start its own work in the background.
async fn bring_up(app: &AppHandle, provider: Arc<dyn ToolProvider>) {
    let state = app.state::<AppState>();
    for event in state.bus.retained_for(provider.as_ref()) {
        provider.on_event(&event).await;
    }
    tauri::async_runtime::spawn(async move {
        provider.start().await;
    });
}

/// A picture a plugin keeps in its `data/` folder, as a `data:` URL for a list
/// row to draw (`plugins::images`).
#[tauri::command]
fn plugin_image(
    state: State<'_, AppState>,
    plugin: String,
    file: String,
    mime: String,
) -> Result<String, AppError> {
    lilo_core::plugins::images::data_url(&plugins_dir(&state)?, &plugin, &file, &mime)
}

/// Save a plugin's stored picture using the operating system's Downloads path.
#[tauri::command]
async fn plugin_image_download(
    state: State<'_, AppState>,
    plugin: String,
    file: String,
    mime: String,
) -> Result<String, AppError> {
    let root = plugins_dir(&state)?;
    let downloads =
        dirs::download_dir().ok_or_else(|| AppError::other("Downloads folder is unavailable"))?;
    tauri::async_runtime::spawn_blocking(move || {
        image_export::save(&root, &plugin, &file, &mime, &downloads)
            .map(|saved| saved.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| AppError::other(format!("could not save picture: {error}")))?
}

/// Publish from the UI (device sensors, user actions) onto the plugin bus.
#[tauri::command]
async fn publish_event(
    state: State<'_, AppState>,
    topic: String,
    payload: serde_json::Value,
) -> Result<(), AppError> {
    if topic == "session.changed" {
        lilo_core::plugins::session::SessionContext::parse(payload.clone())?;
    }
    if topic.starts_with("conversation.")
        || topic.starts_with("session.")
        || topic.starts_with("interaction.")
    {
        plugin_bus::dispatch(
            &state.bus,
            &state.plugins,
            plugin_bus::Event {
                topic,
                payload,
                source: "host".into(),
            },
        )
        .await;
    } else {
        state.bus.publisher("host").publish(&topic, payload);
    }
    Ok(())
}

/// In-process plugins get what a sidecar gets at load: their voice commands and
/// their stored settings.
async fn start_builtin_plugins(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(root) = plugins_dir(&state) else {
        return;
    };
    let providers: Vec<Arc<dyn ToolProvider>> = {
        let registry = state.plugins.read().await;
        registry
            .manifests()
            .iter()
            .filter_map(|manifest| registry.provider(&manifest.id))
            .collect()
    };
    for provider in providers {
        let id = provider.manifest().id.clone();
        let commands = provider.commands();
        if !commands.is_empty() {
            let registered = state
                .router
                .lock()
                .expect("router poisoned")
                .register_plugin_commands(&id, commands);
            if let Err(error) = registered {
                logging::log("plugin", &format!("{id} voice commands rejected: {error}"));
            }
        }
        if !provider.ui().settings.is_empty() {
            let stored = plugin_store::load(&root, &id);
            if stored.as_object().is_some_and(|fields| !fields.is_empty()) {
                if let Err(error) = provider.configure(stored).await {
                    logging::log("plugin", &format!("configure {id} failed: {error}"));
                }
            }
        }
        bring_up(app, provider).await;
    }
}

/// Start and register every plugin on disk that is not running yet. Safe to
/// call again after an install or an uninstall: plugins already registered are
/// not started a second time, and the caller unloads what it replaces.
async fn reload_plugins(app: &AppHandle) {
    let dir = match app.path().app_data_dir() {
        Ok(data_dir) => data_dir.join("plugins"),
        Err(error) => {
            logging::log("plugin", &format!("no app data directory: {error}"));
            return;
        }
    };
    let state = app.state::<AppState>();
    let running: std::collections::HashSet<String> = state
        .plugins
        .read()
        .await
        .manifests()
        .into_iter()
        .map(|manifest| manifest.id)
        .collect();
    let outcome = lilo_core::plugins::load_dir_except(&dir, |id| running.contains(id)).await;
    for (path, reason) in &outcome.failed {
        logging::log("plugin", &format!("{path} failed to load: {reason}"));
    }
    for id in &outcome.skipped {
        logging::log("plugin", &format!("{id} is for another platform — skipped"));
    }
    for plugin in outcome.plugins {
        let id = plugin.manifest().id.clone();
        let commands = plugin.commands();
        plugin.set_publisher(state.bus.publisher(&id));
        let registered = state.plugins.write().await.register(plugin.clone());
        if let Err(error) = registered {
            logging::log("plugin", &format!("{id} rejected: {error}"));
            plugin.shutdown().await;
            continue;
        }
        // Commands are per plugin: a clash rejects this plugin's phrases only,
        // and its tools and buttons keep working.
        let commands_result = state
            .router
            .lock()
            .expect("router poisoned")
            .register_plugin_commands(&id, commands);
        if let Err(error) = commands_result {
            logging::log("plugin", &format!("{id} voice commands rejected: {error}"));
        }
        // Settings live with the host; hand them over now, or a plugin would run
        // on its defaults until the user next touched its settings page.
        let stored = plugin_store::load(&dir, &id);
        if stored.as_object().is_some_and(|fields| !fields.is_empty()) {
            if let Err(error) = plugin.configure(stored).await {
                logging::log("plugin", &format!("configure {id} failed: {error}"));
            }
        }
        bring_up(app, plugin.clone()).await;
        logging::log("plugin", &format!("{id} loaded"));
    }
}

/// Loudness of the music mpv is playing, for the visualizer. Async so the IPC
/// round trip never runs on the main thread.
#[tauri::command]
async fn media_levels(
    state: State<'_, AppState>,
) -> Result<Option<lilo_core::media::player::AudioLevels>, AppError> {
    Ok(state.media.levels())
}

#[tauri::command]
async fn media_report(
    state: State<'_, AppState>,
) -> Result<lilo_core::media::service::MediaReport, AppError> {
    state.media.report().await
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Where each removable area lives. Kept next to the commands rather than in
/// `lilo-core` because the log directory is a desktop-app concern.
fn storage_paths(state: &AppState) -> lilo_core::storage::StoragePaths {
    let data_dir = state.media.data_dir();
    lilo_core::storage::StoragePaths {
        // Downloaded binaries: `<app data>/bin/<tool>/…`.
        media: data_dir.join("bin"),
        logs: logging::dir().unwrap_or_else(|| data_dir.join("logs")),
        cache: std::env::temp_dir(),
        plugins: data_dir.join("plugins"),
        webviews: data_dir.join("webview"),
    }
}

/// One installed plugin, for the Storage panel: what it is, whether it runs,
/// and what its folder costs. Enough to answer "is this plugin worth it?".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginUsage {
    id: String,
    name: String,
    version: String,
    /// `quickjs` or `process`, from the manifest.
    runtime: String,
    enabled: bool,
    loaded: bool,
    bytes: u64,
    files: u64,
}

/// Everything the Storage panel shows: disk by area and per installed plugin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageView {
    areas: Vec<lilo_core::storage::AreaUsage>,
    usage: Vec<lilo_core::storage::UsageEntry>,
    plugins: Vec<PluginUsage>,
    total_bytes: u64,
}

#[tauri::command]
async fn storage_report(state: State<'_, AppState>) -> Result<StorageView, AppError> {
    // Async for the same reason as `media_report`: reading sizes walks the
    // disk, and that must never run on the UI thread.
    let report = storage_paths(&state).report();
    let root = plugins_dir(&state)?;
    let loaded: std::collections::HashSet<String> = {
        let registry = state.plugins.read().await;
        registry
            .manifests()
            .into_iter()
            .map(|manifest| manifest.id)
            .collect()
    };
    let mut plugins = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if id.starts_with('.') {
                continue;
            }
            let manifest =
                lilo_core::plugins::store::load_manifest_value(&root, &id).and_then(|value| {
                    serde_json::from_value::<lilo_core::plugins::loader::PluginFile>(value).ok()
                });
            let (bytes, files) = lilo_core::storage::dir_usage(&dir);
            plugins.push(PluginUsage {
                id: id.clone(),
                name: manifest
                    .as_ref()
                    .map(|file| {
                        if file.name.trim().is_empty() {
                            file.id.clone()
                        } else {
                            file.name.clone()
                        }
                    })
                    .unwrap_or_else(|| id.clone()),
                version: manifest
                    .as_ref()
                    .map(|file| file.version.clone())
                    .unwrap_or_default(),
                runtime: manifest
                    .as_ref()
                    .map(|file| file.runtime.clone())
                    .unwrap_or_default(),
                enabled: lilo_core::plugins::store::is_enabled(&root, &id),
                loaded: loaded.contains(&id),
                bytes,
                files,
            });
        }
    }
    plugins.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.id.cmp(&b.id)));

    Ok(StorageView {
        areas: report.areas,
        usage: report.usage,
        plugins,
        total_bytes: report.total_bytes,
    })
}

/// The Process panel: the host and everything depending on it. Its own
/// command because it is its own question — "what does LILO cost?" — and
/// because it samples live numbers on a timer while Storage reads the disk.
#[tauri::command]
async fn process_report(state: State<'_, AppState>) -> Result<resources::ProcessUsage, AppError> {
    let plugin_pids: Vec<u32> = {
        let registry = state.plugins.read().await;
        registry
            .providers()
            .iter()
            .flat_map(|provider| provider.process_ids())
            .collect()
    };
    Ok(resources::sample(&plugin_pids))
}

#[tauri::command]
async fn storage_clear(state: State<'_, AppState>, area: String) -> Result<u64, AppError> {
    let area = lilo_core::storage::StorageArea::parse(&area)
        .ok_or_else(|| AppError::other(format!("unknown storage area: {area}")))?;
    let freed = lilo_core::storage::clear(&storage_paths(&state), area)?;
    // The logger holds an open handle; after its directory is gone it would
    // keep writing to a deleted inode, so reopen the file immediately.
    if area == lilo_core::storage::StorageArea::Logs {
        logging::reopen();
    }
    logging::log("storage", &format!("cleared {area:?}: {freed} bytes"));
    Ok(freed)
}

// ---------------------------------------------------------------------------
// Native audio (optional) + environment
// ---------------------------------------------------------------------------

#[tauri::command]
fn native_audio_available() -> bool {
    cfg!(feature = "native-audio")
}

#[tauri::command]
fn start_native_audio(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    state.native.start(app).map_err(AppError::other)
}

#[tauri::command]
fn stop_native_audio(state: State<'_, AppState>) {
    state.native.stop();
}

// ---------------------------------------------------------------------------
// Wake word (native macOS sidecar)
// ---------------------------------------------------------------------------

/// Open a URL with the OS handler. Used for deep links into system settings
/// (enabling Dictation, microphone permissions), which differ per platform.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::other(format!("could not open that link: {e}")))
}

#[tauri::command]
fn wake_word_supported() -> bool {
    wake::WakeWatcher::supported()
}

/// Frontend-to-file logging so UI decisions land in the same log as the backend.
#[tauri::command]
fn log_line(scope: String, message: String) {
    logging::log(&scope, &message);
}

#[tauri::command]
fn set_wake_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    phrase: String,
) -> Result<(), AppError> {
    if !wake::WakeWatcher::supported() {
        state.wake.stop();
        return Ok(());
    }
    if enabled {
        state.wake.start(&app, &phrase).map_err(AppError::other)?;
    } else {
        state.wake.stop();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Phone login over the LAN ("Sign in with phone")
// ---------------------------------------------------------------------------

/// Starts the LAN helper server and returns the pairing URL + QR code.
/// Stops any previous helper first (rotates the pairing key).
#[tauri::command]
fn start_phone_login(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    accent: Option<(String, String)>,
) -> Result<phonelogin::PhoneLoginInfo, AppError> {
    let accent = accent
        .map(|(from, to)| phonelogin::Accent::parse(&from, &to))
        .unwrap_or(phonelogin::Accent::DEFAULT);
    state.phone_login.start(&app, &provider, accent)
}

#[tauri::command]
fn stop_phone_login(app: AppHandle, state: State<'_, AppState>) {
    // After a sign-in: the phone polls about once a second and must see
    // "done" before its server goes, or it shows the PC as unreachable. A
    // helper started meanwhile (another sign-in) is left running.
    let port = state.phone_login.port();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        app.state::<AppState>().phone_login.stop_if(port);
    });
}

/// Cancel path: stops the helper server.
#[tauri::command]
fn cancel_phone_login(app: AppHandle, state: State<'_, AppState>) {
    state.phone_login.stop();
    providers::phone_form::abandon(&app);
}

#[tauri::command]
fn wake_watch_state(state: State<'_, AppState>) -> bool {
    state.wake.is_running()
}

#[tauri::command]
fn get_env_info() -> EnvInfo {
    let webview = if cfg!(target_os = "windows") {
        "WebView2 (Chromium)"
    } else if cfg!(target_os = "macos") {
        "WKWebView (WebKit)"
    } else {
        "WebKitGTK"
    };
    EnvInfo {
        platform: std::env::consts::OS.to_string(),
        webview: webview.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        native_audio_available: cfg!(feature = "native-audio"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(updater::UpdateManager::default())
        .manage(plugin_browser::BrowserBridge::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(providers::claude_voice::plugin())
        .plugin(providers::grok_voice::plugin())
        .setup(|app| {
            let log_path = logging::init(None);
            logging::log(
                "app",
                &format!("LILO starting — logging to {}", log_path.display()),
            );
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(data_dir.clone()));
            let browser = Arc::new(plugin_browser::DesktopBrowser::new(app.handle().clone()));
            app.state::<AppState>()
                .bus
                .set_browser_port(browser.clone());
            app.manage(browser);
            // The main window is built here, in the style the user chose
            // (classic window or desktop companion).
            shell::setup(app.handle(), data_dir)?;
            app.manage(statusbar::StatusBar::default());
            statusbar::start(app.handle());
            app.on_menu_event(statusbar::on_menu);

            // Fetch the media binaries once, in the background. Already
            // installed is a no-op, and a failure here must never block start:
            // the Media settings card reports it.
            // A previous run that was killed (a dev restart, a crash) leaves
            // mpv playing with nothing left to stop it.
            let reaped = lilo_core::media::player::reap_orphans();
            if reaped > 0 {
                logging::log(
                    "app",
                    &format!("reaped {reaped} player(s) from a previous run"),
                );
            }

            start_event_bus(app.handle());

            // The satellite link: a headless client on the LAN drives the
            // session. Only when the environment asked for it.
            {
                let (port, key) = {
                    let state = app.state::<AppState>();
                    (state.satellite.port(), state.satellite.key())
                };
                if let (Some(port), Some(key)) = (port, key) {
                    tauri::async_runtime::spawn(satellite::serve(app.handle().clone(), port, key));
                }
            }

            providers::idle::start(app.handle());

            // A stale token is renewed over plain HTTP with the stored session
            // cookie — no window, no login round trip. This is the path the
            // headless daemon uses, so it is exercised on every desktop start.
            let refresher = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = refresher.state::<AppState>();
                let Some(account) = state.accounts.first(accounts::PROVIDER_CHATGPT) else {
                    return;
                };
                let stale = account.status != "ok"
                    || accounts::token_expiry(&account.access_token)
                        .map(|expiry| expiry < chrono::Utc::now().timestamp() + 6 * 3600)
                        .unwrap_or(true);
                if !stale {
                    return;
                }
                match refresh_chatgpt_account(&refresher, state.inner()).await {
                    Ok(account) => logging::log(
                        "account",
                        &format!("token refreshed over http for {}", account.email),
                    ),
                    Err(error) => {
                        logging::log("account", &format!("http token refresh skipped: {error}"))
                    }
                }
            });
            // The window is created hidden so a white first frame never shows;
            // the frontend shows it the moment the splash is on screen. This
            // only covers a frontend that never gets that far.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    // Not over a user who hid LILO from a menu meanwhile.
                    if !window.app_handle().state::<shell::Shell>().hidden() {
                        let _ = window.show();
                    }
                });
            }
            let provisioner = app.handle().clone();
            set_startup(&provisioner, "Starting", false);
            tauri::async_runtime::spawn(async move {
                set_startup(&provisioner, "Checking media components", false);
                let result = {
                    let state = provisioner.state::<AppState>();
                    let reporter = provisioner.clone();
                    state
                        .media
                        .install_dependencies_with(|step| set_startup(&reporter, step, false))
                        .await
                };
                match result {
                    Ok(tools) => {
                        for tool in tools {
                            logging::log(
                                "media",
                                &format!(
                                    "{}: {} ({})",
                                    tool.name,
                                    if tool.found { "ready" } else { "missing" },
                                    tool.source
                                ),
                            );
                        }
                    }
                    Err(error) => logging::log("media", &format!("dependency install: {error}")),
                }
                // Plugins are loaded after the media components so a slow
                // plugin handshake cannot delay the window, and before the
                // splash clears so the tool list is complete on first paint.
                load_plugins(&provisioner).await;

                // Done either way: a missing optional component must not hold
                // the app behind a splash screen.
                set_startup(&provisioner, "Ready", true);
            });

            // Commands carrying free text ("play <song>") wait for the caption
            // to stop growing. This releases them.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_millis(ROUTER_TICK_MS));
                loop {
                    ticker.tick().await;
                    let outcomes = {
                        let state = handle.state::<AppState>();
                        let mut router = state.router.lock().expect("router poisoned");
                        router.tick(now_ms())
                    };
                    dispatch_outcomes(&handle, outcomes);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the main window ending means the app is going away. The
            // hidden backend windows are opened and closed during normal use,
            // and treating that as a shutdown killed the wake listener and the
            // music mid-session.
            if window.label() == MAIN_WINDOW && matches!(event, tauri::WindowEvent::Moved(_)) {
                shell::on_moved(window.app_handle());
            }
            if window.label() == MAIN_WINDOW && matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle();
                shutdown(app);
                // The hidden backend windows would otherwise keep the process
                // alive after its only visible window is gone: closing the app
                // has to take everything it started with it.
                logging::log("app", "main window closed — exiting");
                app.exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            diagnostics::export_logs,
            get_settings,
            set_settings,
            list_accounts,
            add_account,
            remove_account,
            providers::provider_login,
            providers::provider_login_cancel,
            providers::provider_profile_refresh,
            refresh_account_token,
            claude_voice_start,
            claude_voice_stop,
            claude_voice_audio,
            claude_voice_active,
            providers::grok_voice::grok_voice_start,
            updater::app_update_check,
            updater::app_update_install,
            updater::app_update_status,
            updater::app_update_confirm,
            providers::grok_voice::grok_voice_stop,
            providers::grok_voice::grok_voice_send,
            create_voice_session,
            release_voice_session,
            upload_voice_image,
            list_tools,
            list_plugins,
            plugin_voice_call,
            confirm_command,
            marketplace_list,
            plugin_install,
            plugin_uninstall,
            set_plugin_enabled,
            plugin_settings,
            set_plugin_settings,
            run_tool,
            handle_utterance,
            handle_local_utterance,
            list_commands,
            command_prompt_line,
            build_opening_prompt,
            set_assistant_name,
            set_command_locales,
            command_locales,
            reset_commands,
            media_report,
            media_levels,
            publish_event,
            plugin_image,
            plugin_image_download,
            providers::chatgpt_images::chatgpt_generated_image,
            providers::chatgpt_history::chatgpt_conversation_history,
            storage_report,
            process_report,
            storage_clear,
            native_audio_available,
            start_native_audio,
            stop_native_audio,
            wake_word_supported,
            open_external,
            startup_state,
            set_wake_watch,
            wake_watch_state,
            start_phone_login,
            stop_phone_login,
            cancel_phone_login,
            log_line,
            get_env_info,
            statusbar::statusbar_current,
            shell::shell_hit_regions,
            shell::shell_state,
            shell::shell_space,
            shell::shell_panel,
            shell::shell_style,
            shell::shell_theme,
            shell::shell_set_companion,
            shell::shell_popup_menu,
            satellite::satellite_config,
            satellite::satellite_activate,
            satellite::satellite_ready,
            satellite::satellite_start_input,
            satellite::satellite_audio_out,
            satellite::satellite_finish_output,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Quitting does not always destroy the window first, so the exit
            // path gets its own cleanup.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                shutdown(app);
            }
        });
}

#[cfg(test)]
mod bundled_plugins_tests {
    #[tokio::test]
    async fn development_catalog_lists_installable_workspace_plugins() {
        let development =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins");
        let sources = lilo_core::settings::marketplace_sources(
            "https://example.invalid/saved-marketplace",
            std::path::Path::new("unused-resources"),
            Some(&development),
        );
        assert_eq!(sources.len(), 1);
        let index =
            lilo_core::plugins::marketplace::fetch_index(&reqwest::Client::new(), &sources[0])
                .await
                .unwrap();
        assert!(index
            .plugins
            .iter()
            .any(|plugin| plugin.id == "com.lilo.provider.qwen"));
        assert!(index
            .plugins
            .iter()
            .any(|plugin| plugin.id == "com.lilo.notes"));
    }

    #[test]
    fn bundled_catalog_resource_uses_plugins_directory() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(super::BUNDLED_PLUGINS_DIR, "plugins");
        assert_eq!(
            config["bundle"]["resources"]["../examples/plugins/"],
            format!("{}/", super::BUNDLED_PLUGINS_DIR)
        );
    }
}
