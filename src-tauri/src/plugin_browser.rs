//! Optional desktop browser port. Plugins own their vendor scripts; the host
//! checks declared origins, isolates profiles, and delivers bounded results.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::error::{AppError, Result};
use base64::Engine as _;
use lilo_core::plugins::browser::{BrowserPort, BrowserRequest, BrowserSpec};
use lilo_core::plugins::provider::BoxFuture;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const RESULT_HOST: &str = "plugin-browser-result";
const MAX_RESULT: usize = 128 * 1024;
type Reply = tokio::sync::oneshot::Sender<Result<Value>>;
struct Pending {
    owner: String,
    reply: Reply,
}
#[derive(Default)]
pub struct BrowserBridge {
    pending: Mutex<HashMap<String, Pending>>,
}
struct WindowState {
    owner: String,
    loaded: Arc<AtomicBool>,
    origin: Arc<Mutex<bool>>,
}
#[derive(Default)]
struct LoginAttempts {
    next: AtomicU64,
    live: Mutex<HashMap<String, (String, u64)>>,
}
impl LoginAttempts {
    fn begin(&self, owner: &str, label: &str) -> Result<u64> {
        let epoch = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.live
            .lock()
            .map_err(|_| AppError::other("Browser login state is unavailable."))?
            .insert(label.into(), (owner.into(), epoch));
        Ok(epoch)
    }
    fn current(&self, label: &str, epoch: u64) -> bool {
        self.live
            .lock()
            .ok()
            .and_then(|live| live.get(label).map(|entry| entry.1))
            == Some(epoch)
    }
    fn finish(&self, label: &str, epoch: u64) {
        if let Ok(mut live) = self.live.lock() {
            if live.get(label).is_some_and(|entry| entry.1 == epoch) {
                live.remove(label);
            }
        }
    }
    fn cancel(&self, label: &str) {
        if let Ok(mut live) = self.live.lock() {
            live.remove(label);
        }
    }
    fn close_owner(&self, owner: &str) {
        if let Ok(mut live) = self.live.lock() {
            live.retain(|_, entry| entry.0 != owner);
        }
    }
}
pub struct DesktopBrowser {
    app: AppHandle,
    windows: Mutex<HashMap<String, WindowState>>,
    logins: LoginAttempts,
}
impl DesktopBrowser {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            windows: Mutex::new(HashMap::new()),
            logins: LoginAttempts::default(),
        }
    }
    pub async fn login(
        self: &Arc<Self>,
        owner: String,
        provider: String,
        clear: bool,
    ) -> Result<()> {
        let (label, _) = profile(&owner, &provider);
        let epoch = self.logins.begin(&owner, &label)?;
        if clear {
            if let Some(window) = self.app.get_webview_window(&label) {
                window.clear_all_browsing_data().map_err(|_| {
                    AppError::other("Provider browser session could not be cleared.")
                })?;
            }
        }
        let identity = lilo_core::plugins::voice::provider_id(&owner, &provider);
        if crate::providers::phone_form::is_active(&identity) {
            if let Some(window) = self.app.get_webview_window(&label) {
                let config = phone_config(&self.app, &identity)?;
                window
                    .navigate(
                        config
                            .browser
                            .login_url
                            .parse()
                            .map_err(|_| AppError::other("Invalid provider phone sign-in URL."))?,
                    )
                    .map_err(|_| AppError::other("Provider phone sign-in could not open."))?;
                present_login(&window, &identity);
            }
        }
        let request = BrowserRequest::new(&owner, &provider, "() => ({})", serde_json::json!({}))?;
        if self.evaluate(request.clone()).await.is_ok() {
            self.logins.finish(&label, epoch);
            return Ok(());
        }
        let window = self
            .app
            .get_webview_window(&label)
            .ok_or_else(|| AppError::other("Provider sign-in window is unavailable."))?;
        present_login(
            &window,
            &lilo_core::plugins::voice::provider_id(&owner, &provider),
        );
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(360);
            while tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if !host.logins.current(&label, epoch)
                    || host.app.get_webview_window(&label).is_none()
                {
                    host.logins.finish(&label, epoch);
                    return;
                }
                if host.evaluate(request.clone()).await.is_ok() {
                    host.logins.finish(&label, epoch);
                    return;
                }
            }
            if !host.logins.current(&label, epoch) {
                return;
            }
            host.logins.finish(&label, epoch);
            let _ = host.app.emit_to(
                "main",
                crate::providers::LOGIN_EVENT,
                crate::providers::LoginStatus::error(
                    &lilo_core::plugins::voice::provider_id(&owner, &provider),
                    "Provider sign-in timed out.",
                ),
            );
        });
        Ok(())
    }
    pub fn close_owner(&self, owner: &str, clear: bool) {
        self.logins.close_owner(owner);
        let labels: Vec<_> = self
            .windows
            .lock()
            .map(|windows| {
                windows
                    .iter()
                    .filter(|(_, state)| state.owner == owner)
                    .map(|(label, _)| label.clone())
                    .collect()
            })
            .unwrap_or_default();
        for label in labels {
            if let Some(window) = self.app.get_webview_window(&label) {
                if clear {
                    let _ = window.clear_all_browsing_data();
                }
                let _ = window.close();
            }
            if let Ok(mut windows) = self.windows.lock() {
                windows.remove(&label);
            }
        }
        if let Ok(mut pending) = self.app.state::<BrowserBridge>().pending.lock() {
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, request)| request.owner == owner)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(pending) = pending.remove(&id) {
                    let _ = pending
                        .reply
                        .send(Err(AppError::other("Provider browser was closed.")));
                }
            }
        }
    }
    pub fn cancel(&self, owner: &str, provider: &str) {
        let (label, _) = profile(owner, provider);
        self.logins.cancel(&label);
        if let Some(window) = self.app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
}
pub(crate) struct PhoneConfig {
    pub label: String,
    pub name: String,
    pub form: lilo_core::plugins::browser::PhoneFormSpec,
    pub browser: BrowserSpec,
}
/// Resolve selectors and permissions from the installed plugin, never the phone.
pub(crate) fn phone_config(app: &AppHandle, provider: &str) -> Result<PhoneConfig> {
    let (owner, local) = crate::providers::plugin_identity(provider)
        .ok_or_else(|| AppError::other("Invalid plugin provider identity."))?;
    let state = app.state::<crate::AppState>();
    let plugin = state
        .plugins
        .try_read()
        .map_err(|_| AppError::other("Provider registry is busy. Try again."))?
        .provider(owner)
        .ok_or_else(|| AppError::other("Provider plugin is unavailable."))?;
    let declaration = plugin
        .voice_providers()
        .into_iter()
        .find(|spec| spec.id == local)
        .ok_or_else(|| AppError::other("Unknown plugin provider."))?;
    let browser = declaration
        .browser
        .ok_or_else(|| AppError::other("Provider has no browser."))?;
    browser.validate(plugin.manifest())?;
    let form = browser
        .phone_form
        .clone()
        .ok_or_else(|| AppError::other("Provider has no phone sign-in."))?;
    Ok(PhoneConfig {
        label: profile(owner, local).0,
        name: declaration.label,
        form,
        browser,
    })
}
pub(crate) fn phone_window_allowed(window: &tauri::WebviewWindow, spec: &BrowserSpec) -> bool {
    window.url().is_ok_and(|url| allowed(&url, spec))
}
fn present_login(window: &tauri::WebviewWindow, provider: &str) {
    if crate::providers::phone_form::is_active(provider)
        && crate::providers::phone_form::progress().step
            != crate::providers::phone_form::Step::Challenge
    {
        crate::providers::cloak::cloak(window);
    } else {
        crate::providers::cloak::uncloak(window);
        let _ = window.show();
        let _ = window.set_focus();
    }
}
fn profile(owner: &str, provider: &str) -> (String, [u8; 16]) {
    let digest = Sha256::digest(format!("{owner}/{provider}"));
    let mut identifier = [0; 16];
    identifier.copy_from_slice(&digest[..16]);
    let suffix = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    (format!("plugin-web-{}", &suffix[..32]), identifier)
}
fn allowed(url: &tauri::Url, spec: &BrowserSpec) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| spec.allowed_hosts.iter().any(|allowed| allowed == host))
}
fn result(url: &tauri::Url) -> Option<(String, Value)> {
    if url.scheme() != "tauri-voice" || url.host_str() != Some(RESULT_HOST) {
        return None;
    }
    let fragment = url.fragment()?;
    if fragment.len() > MAX_RESULT * 2 {
        return None;
    }
    let (id, data) = fragment.split_once(':')?;
    if uuid::Uuid::parse_str(id).is_err() {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    if bytes.len() > MAX_RESULT {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    Some((id.into(), value))
}
fn build_script(id: &str, spec: &BrowserSpec, script: &str, args: &Value) -> String {
    let id = serde_json::to_string(id).unwrap_or_default();
    let hosts = serde_json::to_string(&spec.allowed_hosts).unwrap_or_default();
    let probe = &spec.session_probe;
    format!(
        r#"(async () => {{
      const done = value => {{
        const text = JSON.stringify(value);
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > {MAX_RESULT}) return done({{ok:false,reason:'size'}});
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        location.href = 'tauri-voice://plugin-browser-result#' + {id} + ':' + btoa(binary);
      }};
      if (location.protocol !== 'https:' || (location.port && location.port !== '443') || !{hosts}.includes(location.hostname)) return;
      try {{
        const probe = ({probe}); const status = await probe();
        if (!status || status.ready !== true) return done({{ok:false,reason:'signin'}});
        const run = ({script}); const value = await run({args});
        done({{ok:true,value,identity:{{name:String(status.name || '').slice(0,320),email:String(status.email || '').slice(0,320)}}}});
      }} catch {{ done({{ok:false,reason:'request'}}); }}
    }})();"#
    )
}
impl BrowserPort for DesktopBrowser {
    fn evaluate<'a>(&'a self, request: BrowserRequest) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            // Resolve ownership from the live registry, never from plugin-supplied URLs.
            let plugin = self
                .app
                .state::<crate::AppState>()
                .plugins
                .read()
                .await
                .provider(&request.owner)
                .ok_or_else(|| AppError::other("Provider plugin is unavailable."))?;
            let declaration = plugin
                .voice_providers()
                .into_iter()
                .find(|provider| provider.id == request.provider_id)
                .ok_or_else(|| AppError::other("Unknown plugin browser owner."))?;
            let spec = declaration
                .browser
                .ok_or_else(|| AppError::other("Provider has no browser declaration."))?;
            spec.validate(plugin.manifest())?;
            let (label, identifier) = profile(&request.owner, &request.provider_id);
            let (loaded, origin) = {
                let mut windows = self
                    .windows
                    .lock()
                    .map_err(|_| AppError::other("Browser state is unavailable."))?;
                let state = windows.entry(label.clone()).or_insert_with(|| WindowState {
                    owner: request.owner.clone(),
                    loaded: Arc::new(AtomicBool::new(false)),
                    origin: Arc::new(Mutex::new(false)),
                });
                (state.loaded.clone(), state.origin.clone())
            };
            let window = if let Some(window) = self.app.get_webview_window(&label) {
                window
            } else {
                loaded.store(false, Ordering::SeqCst);
                let app = self.app.clone();
                let callback_owner = request.owner.clone();
                let callback_provider =
                    lilo_core::plugins::voice::provider_id(&request.owner, &request.provider_id);
                let callback_loaded = loaded.clone();
                let callback_spec = spec.clone();
                let navigation_origin = origin.clone();
                let dir = self
                    .app
                    .path()
                    .app_data_dir()
                    .map_err(|_| AppError::other("Browser profile directory is unavailable."))?
                    .join("webview")
                    .join(&label);
                std::fs::create_dir_all(&dir)
                    .map_err(|_| AppError::other("Browser profile could not be created."))?;
                WebviewWindowBuilder::new(
                    &self.app,
                    &label,
                    WebviewUrl::External(
                        (if crate::providers::phone_form::is_active(
                            &lilo_core::plugins::voice::provider_id(
                                &request.owner,
                                &request.provider_id,
                            ),
                        ) {
                            &spec.login_url
                        } else {
                            &spec.home_url
                        })
                        .parse()
                        .map_err(|_| AppError::other("Invalid provider home URL."))?,
                    ),
                )
                .title(format!("LILO — {} sign-in", declaration.label))
                .inner_size(960.0, 740.0)
                .visible(false)
                .data_directory(dir)
                .data_store_identifier(identifier)
                .on_page_load(move |_, payload| {
                    callback_loaded.store(
                        matches!(payload.event(), tauri::webview::PageLoadEvent::Finished),
                        Ordering::SeqCst,
                    );
                })
                .on_navigation(move |url| {
                    if url.scheme() == "tauri-voice" {
                        let permitted = navigation_origin
                            .lock()
                            .map(|origin| *origin)
                            .unwrap_or(false);
                        if permitted
                            && crate::providers::phone_form::is_active(&callback_provider)
                            && crate::providers::phone_form::resolve_navigation(&app, url)
                        {
                            return false;
                        }
                        if let Some((id, value)) = result(url) {
                            let permitted = navigation_origin
                                .lock()
                                .map(|origin| *origin)
                                .unwrap_or(false);
                            if permitted {
                                if let Ok(mut pending) = app.state::<BrowserBridge>().pending.lock()
                                {
                                    if pending
                                        .get(&id)
                                        .is_some_and(|pending| pending.owner == callback_owner)
                                    {
                                        if let Some(pending) = pending.remove(&id) {
                                            let _ = pending.reply.send(Ok(value));
                                        }
                                    }
                                }
                            }
                        }
                        return false;
                    }
                    if let Ok(mut origin) = navigation_origin.lock() {
                        *origin = allowed(url, &callback_spec);
                    }
                    // Real provider/SSO pages may navigate; scripts only run on declared origins.
                    matches!(url.scheme(), "https" | "about")
                })
                .build()
                .map_err(|_| AppError::other("Provider browser could not open."))?
            };
            for _ in 0..150 {
                if loaded.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if !loaded.load(Ordering::SeqCst) {
                return Err(AppError::other(
                    "Provider browser is still loading. Try again.",
                ));
            }
            if !window.url().is_ok_and(|url| allowed(&url, &spec)) {
                present_login(
                    &window,
                    &lilo_core::plugins::voice::provider_id(&request.owner, &request.provider_id),
                );
                return Err(AppError::other(
                    "Complete sign-in in the provider browser, then try again.",
                ));
            }
            if let Ok(mut origin) = origin.lock() {
                *origin = true;
            }
            let id = uuid::Uuid::new_v4().to_string();
            let (reply, receiver) = tokio::sync::oneshot::channel();
            {
                let bridge = self.app.state::<BrowserBridge>();
                let mut pending = bridge
                    .pending
                    .lock()
                    .map_err(|_| AppError::other("Browser requests are unavailable."))?;
                if pending.len() >= 4 {
                    return Err(AppError::other("Provider browser is busy."));
                }
                pending.insert(
                    id.clone(),
                    Pending {
                        owner: request.owner,
                        reply,
                    },
                );
            }
            let evaluation = window.eval(build_script(&id, &spec, &request.script, &request.args));
            let response = if evaluation.is_ok() {
                tokio::time::timeout(Duration::from_secs(45), receiver)
                    .await
                    .ok()
                    .and_then(|reply| reply.ok())
                    .unwrap_or_else(|| Err(AppError::other("Provider browser request timed out.")))
            } else {
                Err(AppError::other("Provider browser request could not start."))
            };
            if let Ok(mut pending) = self.app.state::<BrowserBridge>().pending.lock() {
                pending.remove(&id);
            }
            let response = response?;
            if response.get("ok").and_then(Value::as_bool) != Some(true) {
                if response.get("reason").and_then(Value::as_str) == Some("signin") {
                    let login: tauri::Url = spec
                        .login_url
                        .parse()
                        .map_err(|_| AppError::other("Invalid provider sign-in URL."))?;
                    let provider_identity = lilo_core::plugins::voice::provider_id(
                        &plugin.manifest().id,
                        &declaration.id,
                    );
                    if !crate::providers::phone_form::is_active(&provider_identity)
                        && window.url().is_ok_and(|url| url.path() != login.path())
                    {
                        let _ = window.navigate(login);
                    }
                    present_login(
                        &window,
                        &lilo_core::plugins::voice::provider_id(
                            &plugin.manifest().id,
                            &declaration.id,
                        ),
                    );
                    return Err(AppError::other(
                        "Complete sign-in in the provider browser, then try again.",
                    ));
                }
                return Err(AppError::other("Provider browser request failed."));
            }
            let identity = response.get("identity").cloned().unwrap_or_default();
            let name = identity
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            let email = identity
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if [name, email]
                .iter()
                .any(|value| value.len() > 320 || value.chars().any(char::is_control))
            {
                return Err(AppError::other("Invalid provider display identity."));
            }
            let provider =
                lilo_core::plugins::voice::provider_id(&plugin.manifest().id, &declaration.id);
            let mut account = crate::accounts::Account::web_session(
                &provider,
                if email.is_empty() {
                    "plugin-account"
                } else {
                    email
                },
            );
            account.name = name.into();
            self.app.state::<crate::AppState>().accounts.add(account)?;
            crate::providers::phone_form::finished(&provider);
            crate::providers::cloak::uncloak(&window);
            let _ = window.hide();
            let _ = self.app.emit_to(
                "main",
                crate::providers::LOGIN_EVENT,
                crate::providers::LoginStatus::ok(
                    &provider,
                    if email.is_empty() {
                        "plugin-account".into()
                    } else {
                        email.into()
                    },
                ),
            );
            let mut value = response
                .get("value")
                .cloned()
                .filter(Value::is_object)
                .ok_or_else(|| AppError::other("Invalid provider browser result."))?;
            value["accountKey"] = Value::String(if email.is_empty() {
                "plugin-account".into()
            } else {
                email.into()
            });
            Ok(value)
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_one_owner_or_profile_never_cancels_another_login() {
        let attempts = LoginAttempts::default();
        let first = attempts.begin("owner-a", "profile-a").unwrap();
        let second = attempts.begin("owner-b", "profile-b").unwrap();
        attempts.close_owner("owner-a");
        assert!(!attempts.current("profile-a", first));
        assert!(attempts.current("profile-b", second));
        let replacement = attempts.begin("owner-b", "profile-b").unwrap();
        attempts.finish("profile-b", second);
        assert!(attempts.current("profile-b", replacement));
        attempts.cancel("profile-a");
        assert!(attempts.current("profile-b", replacement));
        attempts.finish("profile-b", replacement);
        assert!(!attempts.current("profile-b", replacement));
    }

    #[test]
    fn profiles_and_callbacks_are_isolated_and_bounded() {
        assert_ne!(
            profile("com.fixture.a", "web"),
            profile("com.fixture.b", "web")
        );
        assert_ne!(
            profile("com.fixture.a", "web"),
            profile("com.fixture.a", "other")
        );
        let id = uuid::Uuid::new_v4().to_string();
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(br#"{"ok":true,"value":{"sdp":"v=0"}}"#);
        let url = format!("tauri-voice://plugin-browser-result#{id}:{encoded}")
            .parse()
            .unwrap();
        assert_eq!(result(&url).unwrap().1["value"]["sdp"], "v=0");
        assert!(result(&"https://fixture.example/".parse().unwrap()).is_none());
        assert!(result(
            &"tauri-voice://plugin-browser-result#invalid:e30="
                .parse()
                .unwrap()
        )
        .is_none());
    }
    #[test]
    fn browser_port_rejects_origin_credentials_and_nonstandard_ports() {
        let spec = BrowserSpec {
            login_url: "https://fixture.example/auth".into(),
            home_url: "https://fixture.example/".into(),
            allowed_hosts: vec!["fixture.example".into()],
            session_probe: "() => ({ready:false})".into(),
            phone_driver: None,
            phone_form: None,
        };
        assert!(allowed(&spec.home_url.parse().unwrap(), &spec));
        for url in [
            "https://fixture.example.evil.test/",
            "http://fixture.example/",
            "https://user:pass@fixture.example/",
            "https://fixture.example:8443/",
        ] {
            assert!(!allowed(&url.parse().unwrap(), &spec));
        }
    }
}
