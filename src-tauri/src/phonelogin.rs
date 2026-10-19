//! Phone login over the LAN ("Sign in with phone").
//!
//! The PC's own login window signs in, out of sight, and the phone page
//! answers what it asks — the e-mail, then the code the backend mails
//! (`providers::phone_form`). The sign-in ends like a desktop one, so ChatGPT's
//! session cookie — what its token refresh runs on — is captured too.
//!
//! ```text
//! phone: open the QR page -> POST /api/form/start  (hidden login opens)
//!        answer each ask  -> POST /api/form/answer (typed into that page)
//!        GET /api/status  -> what the page asks now / whether it is done
//! ```
//!
//! ChatGPT keeps its older fallback on `/paste`: sign in on the phone's own
//! browser, copy the session JSON, paste it (`POST /api/session`). That one
//! carries no session cookie, so its token cannot be refreshed.
//!
//! The pairing key `?k=` binds the page to this session so other LAN devices
//! cannot inject accounts.

use std::borrow::Cow;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::accounts::Account;
use crate::error::AppError;
use crate::logging::log;
use crate::providers::phone_form::{self, Field};

const FIRST_PORT: u16 = 1234;
const LAST_PORT: u16 = 1243;
const MAX_BODY: u64 = 64 * 1024;

/// What the UI needs to show the pairing sheet (QR code + URL).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneLoginInfo {
    pub url: String,
    pub port: u16,
    pub key: String,
    pub qr_svg: String,
    pub addresses: Vec<PhoneLoginAddress>,
    pub windows_firewall: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneLoginAddress {
    pub label: String,
    pub url: String,
    pub qr_svg: String,
}

/// The backend this pairing signs in to.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Pairing {
    provider: Cow<'static, str>,
    name: Cow<'static, str>,
    phones: bool,
    /// The user's palette (`--accent`, `--accent2`), so the phone page looks
    /// like the app.
    accent: Accent,
}

/// Two `#rrggbb` colours, kept as bytes so a `Pairing` stays `Copy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accent([u8; 3], [u8; 3]);

impl Accent {
    /// LILO's default indigo-to-violet.
    pub const DEFAULT: Accent = Accent([0x63, 0x66, 0xf1], [0xa8, 0x55, 0xf7]);

    /// Parses `#rrggbb` pairs; anything else falls back to the default.
    pub fn parse(from: &str, to: &str) -> Accent {
        match (hex(from), hex(to)) {
            (Some(a), Some(b)) => Accent(a, b),
            _ => Accent::DEFAULT,
        }
    }

    fn css(rgb: [u8; 3]) -> String {
        format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
    }
}

fn hex(text: &str) -> Option<[u8; 3]> {
    let digits = text.strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

impl Pairing {
    fn name(&self) -> &str {
        &self.name
    }

    /// Whether the paste-the-session fallback exists (ChatGPT only: Claude's
    /// session is HttpOnly).
    fn pastes(&self) -> bool {
        self.provider == crate::accounts::PROVIDER_CHATGPT
    }
}

/// Receives a validated phone session. Split out so the HTTP layer stays
/// testable without a Tauri runtime.
pub trait SessionSink: Send + Sync + 'static {
    fn submit(&self, email: &str, token: &str, name: &str) -> Result<(), String>;

    /// Opens `provider`'s hidden login for the phone to drive.
    fn start_form(&self, _provider: &str) -> Result<(), String> {
        Err("this pairing has no form sign-in".to_string())
    }

    /// Types one answer into the page the phone drives.
    fn answer(&self, _field: Field, _value: &str) -> Result<(), String> {
        Err("this pairing has no form sign-in".to_string())
    }

    /// Where the form sign-in stands, for the phone page.
    fn progress(&self) -> serde_json::Value {
        serde_json::Value::Null
    }
}

#[derive(Clone)]
struct AppSink {
    app: AppHandle,
}

impl SessionSink for AppSink {
    fn submit(&self, email: &str, token: &str, name: &str) -> Result<(), String> {
        let state = self.app.state::<crate::AppState>();
        state
            .accounts
            .add(Account::chatgpt(
                email.to_string(),
                name.to_string(),
                token.to_string(),
            ))
            .map_err(|e| e.to_string())?;
        let _ = self.app.emit(
            crate::providers::LOGIN_EVENT,
            crate::providers::LoginStatus::ok(crate::accounts::PROVIDER_CHATGPT, email.to_string()),
        );
        Ok(())
    }

    fn start_form(&self, provider: &str) -> Result<(), String> {
        phone_form::start(&self.app, provider)
    }

    fn answer(&self, field: Field, value: &str) -> Result<(), String> {
        phone_form::answer(&self.app, field, value)
    }

    fn progress(&self) -> serde_json::Value {
        serde_json::to_value(phone_form::progress()).unwrap_or_default()
    }
}

struct Running {
    port: u16,
    shutdown: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Running {
    fn shutdown(mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        wakeup(self.port);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

/// Owns the helper server thread. `start` rotates the pairing key.
pub struct PhoneLogin {
    running: Mutex<Option<Running>>,
}

impl PhoneLogin {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
        }
    }

    pub fn start(
        &self,
        app: &AppHandle,
        provider: &str,
        accent: Accent,
    ) -> Result<PhoneLoginInfo, AppError> {
        self.stop();
        phone_form::abandon(app);
        let pairing = if let Some(backend) =
            crate::providers::backend(provider).filter(|backend| backend.phone.is_some())
        {
            Pairing {
                provider: Cow::Borrowed(backend.id),
                name: Cow::Borrowed(backend.display_name),
                phones: backend
                    .phone
                    .as_ref()
                    .is_some_and(|form| !form.phone_switch.is_empty()),
                accent,
            }
        } else {
            let config = crate::plugin_browser::phone_config(app, provider)?;
            Pairing {
                provider: Cow::Owned(provider.to_string()),
                name: Cow::Owned(config.name),
                phones: !config.form.phone_switch.is_empty(),
                accent,
            }
        };
        phone_form::reset();
        let key: String = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let sink: Arc<dyn SessionSink> = Arc::new(AppSink { app: app.clone() });
        // Snapshot account identities so /api/status can report the login the
        // moment a new (or renewed) account lands — without touching tokens.
        let seen = account_identities(app, provider);
        let status_provider = provider.to_owned();
        let status_app = app.clone();
        let status: StatusFn = Arc::new(move || {
            if phone_form::is_done(&status_provider) {
                let email = status_app
                    .state::<crate::AppState>()
                    .accounts
                    .list()
                    .into_iter()
                    .find(|account| account.provider == status_provider && account.status == "ok")
                    .map(|account| account.email);
                return (true, email);
            }
            for idn in account_identities(&status_app, &status_provider) {
                if seen.contains(&idn) {
                    continue;
                }
                let mut parts = idn.split('|');
                let email = parts.next().unwrap_or("").to_string();
                let status = parts.nth(1).unwrap_or("");
                if status == "ok" && !email.is_empty() {
                    return (true, Some(email));
                }
            }
            (false, None)
        });
        let networks = crate::phone_network::addresses().map_err(AppError::other)?;
        let running = spawn_server(key.clone(), pairing, sink, status)?;
        if let Err(error) = crate::phone_network::check_server(running.port) {
            running.shutdown();
            return Err(AppError::other(error));
        }
        let addresses: Vec<_> = networks
            .into_iter()
            .map(|(name, ip)| {
                let url = format!("http://{ip}:{}/?k={key}", running.port);
                PhoneLoginAddress {
                    label: format!("{name} · {ip}"),
                    qr_svg: qr_svg(&url).unwrap_or_default(),
                    url,
                }
            })
            .collect();
        let preferred = &addresses[0];
        let info = PhoneLoginInfo {
            url: preferred.url.clone(),
            port: running.port,
            key,
            qr_svg: preferred.qr_svg.clone(),
            addresses,
            windows_firewall: cfg!(windows),
        };
        match self.running.lock() {
            Ok(mut guard) => *guard = Some(running),
            Err(_) => {
                running.shutdown();
                return Err(AppError::other(
                    "Phone sign-in server state is unavailable.",
                ));
            }
        }
        log(
            "phonelogin",
            &format!("serving helper on port {}", info.port),
        );
        Ok(info)
    }

    pub fn stop(&self) {
        let taken = self.running.lock().ok().and_then(|mut g| g.take());
        if let Some(running) = taken {
            log("phonelogin", "stopping helper server");
            running.shutdown();
        }
    }

    /// The running helper's port, to tell one helper from the next.
    pub fn port(&self) -> Option<u16> {
        self.running
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|r| r.port))
    }

    /// Stops the helper only if it is still the one on `port`.
    pub fn stop_if(&self, port: Option<u16>) {
        if port.is_some() && self.port() == port {
            self.stop();
        }
    }
}

fn qr_svg(url: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(220, 220)
        .build())
}

fn account_identities(app: &AppHandle, provider: &str) -> Vec<String> {
    app.state::<crate::AppState>()
        .accounts
        .list()
        .into_iter()
        .filter(|account| account.provider == provider)
        .map(|a| format!("{}|{}|{}", a.email, a.device_id, a.status))
        .collect()
}

/// Reports whether the phone login completed: `(done, email)`.
type StatusFn = Arc<dyn Fn() -> (bool, Option<String>) + Send + Sync>;

fn spawn_server(
    key: String,
    pairing: Pairing,
    sink: Arc<dyn SessionSink>,
    status: StatusFn,
) -> Result<Running, AppError> {
    for port in FIRST_PORT..=LAST_PORT {
        match tiny_http::Server::http(format!("0.0.0.0:{port}")) {
            Ok(server) => {
                let shutdown = Arc::new(AtomicBool::new(false));
                let flag = shutdown.clone();
                let thread = std::thread::Builder::new()
                    .name("lilo-phonelogin".to_string())
                    .spawn(move || serve(server, key, pairing, sink, status, &flag))
                    .map_err(|e| AppError::other(format!("phone login thread failed: {e}")))?;
                return Ok(Running {
                    port,
                    shutdown,
                    thread: Some(thread),
                });
            }
            Err(_) => continue,
        }
    }
    Err(AppError::other(format!(
        "no free port in {FIRST_PORT}–{LAST_PORT} for phone login"
    )))
}

/// Unblocks a server parked in `incoming_requests` so the thread can exit.
fn wakeup(port: u16) {
    if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{port}")) {
        let _ = stream.write_all(b"GET /__stop__ HTTP/1.0\r\nContent-Length: 0\r\n\r\n");
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

fn serve(
    server: tiny_http::Server,
    key: String,
    pairing: Pairing,
    sink: Arc<dyn SessionSink>,
    status: StatusFn,
    shutdown: &AtomicBool,
) {
    for request in server.incoming_requests() {
        handle_request(request, &key, &pairing, &sink, &status);
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
    }
    log("phonelogin", "helper server stopped");
}

fn request_origin(request: &tiny_http::Request) -> String {
    for header in request.headers() {
        if header
            .field
            .as_str()
            .as_str()
            .eq_ignore_ascii_case("origin")
        {
            let bytes: Vec<u8> = header
                .value
                .as_slice()
                .iter()
                .map(|ch| ch.as_byte())
                .collect();
            if let Ok(value) = std::str::from_utf8(&bytes) {
                let value = value.trim();
                if !value.is_empty() {
                    return value.to_string();
                }
            }
        }
    }
    "*".to_string()
}

fn respond(
    request: tiny_http::Request,
    status: u16,
    content_type: &str,
    body: String,
    origin: &str,
) {
    let mut response =
        tiny_http::Response::from_string(body).with_status_code(tiny_http::StatusCode(status));
    for (name, value) in [
        ("Content-Type", content_type),
        ("Access-Control-Allow-Origin", origin),
        ("Access-Control-Allow-Private-Network", "true"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
        ("Access-Control-Max-Age", "86400"),
        ("Cache-Control", "no-store"),
    ] {
        if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response = response.with_header(header);
        }
    }
    let _ = request.respond(response);
}

fn query_key(url: &str) -> String {
    url.split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| *name == "k")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

fn handle_request(
    mut request: tiny_http::Request,
    key: &str,
    pairing: &Pairing,
    sink: &Arc<dyn SessionSink>,
    status: &StatusFn,
) {
    use tiny_http::Method::{Get, Options, Post};
    let origin = request_origin(&request);
    let is_get = matches!(request.method(), Get);
    let is_post = matches!(request.method(), Post);
    let is_options = matches!(request.method(), Options);
    let url = request.url().to_string();
    let path = url.split(['?', '#']).next().unwrap_or("/");

    // CORS / Private-Network-Access preflight.
    if is_options {
        respond(request, 204, "text/plain", String::new(), &origin);
        return;
    }

    if is_get && path == "/api/health" {
        respond(
            request,
            200,
            "application/json",
            "{\"ok\":true}".into(),
            &origin,
        );
        return;
    }

    if is_get && path == "/" {
        respond(
            request,
            200,
            "text/html; charset=utf-8",
            form_page(pairing),
            &origin,
        );
        return;
    }

    if is_get && path == "/paste" && pairing.pastes() {
        respond(
            request,
            200,
            "text/html; charset=utf-8",
            helper_page(key),
            &origin,
        );
        return;
    }

    // Whether the phone login completed (the normal login event feeds this).
    if is_get && path == "/api/status" {
        if query_key(&url) != key {
            respond(
                request,
                403,
                json_type(),
                err_json("wrong pairing key"),
                &origin,
            );
            return;
        }
        let (done, email) = status();
        let body = serde_json::json!({ "done": done, "email": email, "progress": sink.progress() })
            .to_string();
        respond(request, 200, json_type(), body, &origin);
        return;
    }

    // The pasted session object brings the token to the PC.
    if is_post && path == "/api/session" {
        let mut body = Vec::new();
        let read = request.as_reader().take(MAX_BODY).read_to_end(&mut body);
        if read.is_err() {
            respond(
                request,
                400,
                json_type(),
                err_json("could not read request body"),
                &origin,
            );
            return;
        }
        match validate_post(key, &body) {
            Ok((email, token, name)) => match sink.submit(&email, &token, &name) {
                Ok(()) => {
                    log(
                        "phonelogin",
                        &format!("session pasted from phone ({email})"),
                    );
                    respond(
                        request,
                        200,
                        json_type(),
                        "{\"ok\":true}".to_string(),
                        &origin,
                    );
                }
                Err(message) => {
                    respond(request, 400, json_type(), err_json(&message), &origin);
                }
            },
            Err(message) => {
                let status = if message.starts_with("wrong pairing key") {
                    403
                } else {
                    400
                };
                respond(request, status, json_type(), err_json(&message), &origin);
            }
        }
        return;
    }

    // The form sign-in: open the hidden login, then relay each answer.
    if is_post && (path == "/api/form/start" || path == "/api/form/answer") {
        let mut body = Vec::new();
        if request
            .as_reader()
            .take(MAX_BODY)
            .read_to_end(&mut body)
            .is_err()
        {
            respond(
                request,
                400,
                json_type(),
                err_json("could not read request body"),
                &origin,
            );
            return;
        }
        let result = validate_form(key, &body).and_then(|post| {
            if path == "/api/form/start" {
                sink.start_form(&pairing.provider)
            } else {
                let field = post.field.ok_or_else(|| "missing field".to_string())?;
                sink.answer(field, &post.value)
            }
        });
        match result {
            Ok(()) => respond(
                request,
                200,
                json_type(),
                "{\"ok\":true}".to_string(),
                &origin,
            ),
            Err(message) => {
                let status = if message.starts_with("wrong pairing key") {
                    403
                } else {
                    400
                };
                respond(request, status, json_type(), err_json(&message), &origin);
            }
        }
        return;
    }

    respond(request, 404, "text/plain", "not found".to_string(), &origin);
}

fn json_type() -> &'static str {
    "application/json"
}

fn err_json(message: &str) -> String {
    serde_json::json!({ "ok": false, "error": message }).to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPost {
    #[serde(default)]
    key: String,
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    email: String,
    /// Display name from the session envelope (`user.name`). It exists nowhere
    /// else — the access token does not carry it.
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct FormPost {
    #[serde(default)]
    key: String,
    #[serde(default)]
    field: Option<Field>,
    #[serde(default)]
    value: String,
}

/// The pairing key check of a form step.
fn validate_form(key: &str, body: &[u8]) -> Result<FormPost, String> {
    let post: FormPost = serde_json::from_slice(body).map_err(|_| "invalid JSON".to_string())?;
    if post.key != key {
        return Err("wrong pairing key — reopen the phone page from the QR code".to_string());
    }
    Ok(post)
}

/// Pure validation so the HTTP layer stays thin and unit-testable.
///
/// Returns `(email, token, name)`.
fn validate_post(key: &str, body: &[u8]) -> Result<(String, String, String), String> {
    let post: SessionPost = serde_json::from_slice(body)
        .map_err(|_| "invalid JSON — paste the session object".to_string())?;
    if post.key != key {
        return Err("wrong pairing key — reopen the phone page from the QR code".to_string());
    }
    let token = post.access_token.trim().to_string();
    if token.is_empty() {
        return Err("empty access token".to_string());
    }
    let email = post.email.trim();
    Ok((
        if email.is_empty() {
            "phone".to_string()
        } else {
            email.to_string()
        },
        token,
        post.name.trim().to_string(),
    ))
}

/// Shared by both phone pages.
const PAGE_STYLE: &str = r#"  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 20px; background: #0b1220; color: #e8eef7; }
  main { max-width: 560px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
  h1 { font-size: 20px; margin: 4px 0 0; }
  .muted { color: #93a1b5; font-size: 13px; }
  ol { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 12px; font-size: 14px; line-height: 1.55; }
  a.btn { background: #6366f1; border: none; color: #fff; font-weight: 700; padding: 12px 16px; border-radius: 10px; font-size: 15px; cursor: pointer; text-decoration: none; display: inline-block; }
  textarea { width: 100%; min-height: 120px; border-radius: 10px; border: 1px solid #2b3a52; background: #111a2c; color: #e8eef7; padding: 10px; font-size: 12px; box-sizing: border-box; }
  button.send { background: #22c55e; border: none; color: #04120a; font-weight: 700; padding: 12px; border-radius: 10px; font-size: 15px; cursor: pointer; }
  #status { font-size: 14px; min-height: 20px; }
  #status.ok { color: #4ade80; }
  #status.err { color: #f87171; }
  input.field { width: 100%; border-radius: 10px; border: 1px solid #2b3a52; background: #111a2c; color: #e8eef7; padding: 12px; font-size: 16px; box-sizing: border-box; }
  form { display: flex; flex-direction: column; gap: 10px; }
  [hidden] { display: none !important; }
"#;

/// The phone helper page: log in on the phone, copy the session JSON, paste it.
/// The pairing key travels in `?k=`; nothing secret is baked into the page.
fn helper_page(_key: &str) -> String {
    format!(
        r###"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LILO — phone sign-in</title>
<style>
{PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>LILO phone sign-in</h1>
  <p class="muted">Phone and PC on the same Wi-Fi. Three steps — no extra apps.</p>
  <ol>
    <li>On this phone, sign in to ChatGPT.<br />
      <a class="btn" href="https://chatgpt.com/auth/login" target="_blank" rel="noopener">Open ChatGPT</a></li>
    <li>Open your session and copy everything:<br />
      <a class="btn" href="https://chatgpt.com/api/auth/session" target="_blank" rel="noopener">Open session JSON</a>
      <br /><span class="muted">A page of JSON appears — select all and copy.</span></li>
    <li>Paste it here (it sends automatically):</li>
  </ol>
  <textarea id="paste" placeholder='Paste the session JSON — {{"accessToken":"…","user":{{…}}}}'></textarea>
  <button class="send" id="send">Connect</button>
  <p id="status"></p>
</main>
<script>
(function () {{
  var Q = new URLSearchParams(location.search);
  var KEY = Q.get('k') || '';
  var status = function (msg, cls) {{
    var el = document.getElementById('status');
    el.textContent = msg;
    el.className = cls || '';
  }};
  var pasted = document.getElementById('paste');
  var sending = false;
  async function send() {{
    if (sending) return;
    var raw = pasted.value.trim();
    if (!raw) {{ status('Paste the session first.', 'err'); return; }}
    sending = true;
    try {{
      var token = '', email = 'phone', name = '';
      try {{
        var obj = JSON.parse(raw);
        token = (obj.accessToken || obj.access_token || '').trim();
        var who = obj.user || {{}};
        email = String(obj.email || who.email || who.name || 'phone').trim() || 'phone';
        // The display name lives here and nowhere else.
        name = String(who.name || [who.given_name || who.first_name, who.family_name || who.last_name]
          .filter(Boolean).join(' ') || '').trim();
      }} catch (e) {{
        if (/^eyJ/.test(raw)) {{ token = raw; }} else {{ status('That is not a session object.', 'err'); return; }}
      }}
      if (!token) {{ status('No accessToken found in that JSON.', 'err'); return; }}
      status('Sending…', '');
      try {{
        var res = await fetch('/api/session', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json' }},
          body: JSON.stringify({{ key: KEY, accessToken: token, email: email, name: name }})
        }});
        if (res.ok) {{ status('Connected — back to LILO on your PC.', 'ok'); }}
        else {{
          var data = await res.json().catch(function () {{ return {{}}; }});
          status('Rejected: ' + (data.error || res.status), 'err');
        }}
      }} catch (e) {{ status('Could not reach the PC: ' + e, 'err'); }}
    }} finally {{
      sending = false;
    }}
  }}
  document.getElementById('send').addEventListener('click', send);
  pasted.addEventListener('paste', function () {{ setTimeout(send, 350); }});
}})();
</script>
</body>
</html>"###
    )
}

/// The form sign-in page: shows the one question the PC's login page asks
/// (e-mail, code, or password) and relays the answer. Styled like the app,
/// in the user's palette.
fn form_page(pairing: &Pairing) -> String {
    let paste = if pairing.pastes() {
        r##"<a href="#" id="paste"></a>"##
    } else {
        ""
    };
    let phones = pairing.phones;
    include_str!("../assets/phone-login.html")
        .replace("__PHONES__", if phones { "true" } else { "false" })
        .replace(
            "__NAME_HTML__",
            &pairing
                .name()
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;"),
        )
        .replace(
            "__NAME_JSON__",
            &serde_json::to_string(pairing.name())
                .unwrap_or_default()
                .replace('<', "\\u003c")
                .replace('&', "\\u0026"),
        )
        .replace("__ACCENT__", &Accent::css(pairing.accent.0))
        .replace("__ACCENT2__", &Accent::css(pairing.accent.1))
        .replace("__PASTE_LINK__", paste)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_phone_page_uses_its_label_without_enabling_native_paste() {
        let pairing = Pairing {
            provider: Cow::Owned("plugin:com.fixture.voice/web".into()),
            name: Cow::Owned("Fixture </script><script>invalid()</script> 'voice'".into()),
            phones: false,
            accent: Accent::DEFAULT,
        };
        let page = form_page(&pairing);
        assert!(page.contains("Fixture &lt;/script&gt;"));
        assert!(page.contains("\\u003c/script>"));
        assert!(!page.contains("<script>invalid()"));
        assert!(page.contains("var PHONES = false"));
        assert!(!pairing.pastes());
        assert!(!page.contains("__NAME_"));
    }

    #[test]
    fn grok_phone_page_uses_the_registered_provider_name() {
        let pairing = Pairing {
            provider: Cow::Borrowed(crate::accounts::PROVIDER_GROK),
            name: Cow::Borrowed("Grok"),
            phones: false,
            accent: Accent::DEFAULT,
        };
        let page = form_page(&pairing);
        assert!(page.contains("var NAME = \"Grok\";"));
        assert!(!page.contains("ChatGPT"));
        assert!(!pairing.pastes());
    }

    fn body(key: &str, token: &str, email: &str) -> Vec<u8> {
        named_body(key, token, email, "")
    }

    fn named_body(key: &str, token: &str, email: &str, name: &str) -> Vec<u8> {
        serde_json::json!({ "key": key, "accessToken": token, "email": email, "name": name })
            .to_string()
            .into_bytes()
    }

    #[test]
    fn validate_accepts_good_payload() {
        let (email, token, name) =
            validate_post("abc123", &body("abc123", " tok ", "a@b.com")).unwrap();
        assert_eq!(email, "a@b.com");
        assert_eq!(token, "tok");
        assert_eq!(name, "");
    }

    #[test]
    fn validate_carries_the_display_name() {
        // The name only exists in the pasted session envelope; dropping it here
        // is what left the account showing an e-mail and initials from it.
        let (_, _, name) =
            validate_post("k", &named_body("k", "tok", "a@b.com", " Ada Lovelace ")).unwrap();
        assert_eq!(name, "Ada Lovelace");
    }

    #[test]
    fn validate_defaults_empty_email_to_phone() {
        let (email, _, _) = validate_post("k", &body("k", "tok", "")).unwrap();
        assert_eq!(email, "phone");
    }

    #[test]
    fn validate_rejects_wrong_key() {
        let err = validate_post("right", &body("wrong", "tok", "a@b.com")).unwrap_err();
        assert!(err.starts_with("wrong pairing key"));
    }

    #[test]
    fn validate_rejects_empty_token() {
        assert!(validate_post("k", &body("k", "  ", "a@b.com")).is_err());
    }

    #[test]
    fn validate_rejects_bad_json() {
        assert!(validate_post("k", b"not json").is_err());
    }

    #[test]
    fn qr_svg_renders() {
        let svg = qr_svg("http://192.168.1.13:1234/?k=abc").unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("</svg>"));
    }

    #[test]
    fn helper_page_has_hooks() {
        let page = helper_page("key123");
        assert!(page.contains("/api/auth/session"));
        assert!(page.contains("/api/session"));
        assert!(page.contains("accessToken"));
        assert!(!page.contains("/collect"));
        assert!(!page.contains("bookmarklet"));
        assert!(!page.contains("javascript:"));
    }

    const CHATGPT: Pairing = Pairing {
        provider: Cow::Borrowed(crate::accounts::PROVIDER_CHATGPT),
        name: Cow::Borrowed("ChatGPT"),
        phones: true,
        accent: Accent::DEFAULT,
    };
    const CLAUDE: Pairing = Pairing {
        provider: Cow::Borrowed(crate::accounts::PROVIDER_CLAUDE),
        name: Cow::Borrowed("Claude"),
        phones: false,
        accent: Accent([0x10, 0xb9, 0x81], [0x06, 0xb6, 0xd4]),
    };

    #[test]
    fn form_page_drives_the_pc_login() {
        let page = form_page(&CLAUDE);
        assert!(page.contains("/api/form/start"));
        assert!(page.contains("/api/form/answer"));
        assert!(page.contains("one-time-code"));
        assert!(page.contains("var NAME = \"Claude\""));
        assert!(page.contains("--accent: #10b981;"));
        assert!(page.contains("--accent2: #06b6d4;"));
        assert!(!page.contains("__"), "unfilled placeholder");
        assert!(!page.contains("id=\"paste\""));
    }

    #[test]
    fn accent_accepts_only_hex_pairs() {
        assert_eq!(
            Accent::parse("#10B981", "#06b6d4"),
            Accent([0x10, 0xb9, 0x81], [0x06, 0xb6, 0xd4])
        );
        assert_eq!(Accent::parse("red", "#06b6d4"), Accent::DEFAULT);
        assert_eq!(Accent::parse("#10b98", "#06b6d4"), Accent::DEFAULT);
        assert_eq!(Accent::parse("#10b981;}", "#06b6d4"), Accent::DEFAULT);
    }

    #[test]
    fn only_chatgpt_keeps_the_paste_fallback() {
        assert!(form_page(&CHATGPT).contains("id=\"paste\""));
        assert!(CHATGPT.pastes());
        assert!(form_page(&CHATGPT).contains("var PHONES = true"));
        assert!(form_page(&CLAUDE).contains("var PHONES = false"));
        assert!(!CLAUDE.pastes());
    }

    #[test]
    fn form_posts_need_the_pairing_key() {
        let post = validate_form("k", br#"{"key":"k","field":"code","value":"123456"}"#).unwrap();
        assert_eq!(post.field, Some(Field::Code));
        assert_eq!(post.value, "123456");
        assert!(validate_form("k", br#"{"key":"x"}"#)
            .unwrap_err()
            .starts_with("wrong pairing key"));
        assert!(validate_form("k", br#"{"key":"k","field":"pin"}"#).is_err());
        assert!(validate_form("k", b"nope").is_err());
    }

    #[test]
    fn query_key_extracts_pairing_key() {
        assert_eq!(query_key("/?k=abc123"), "abc123");
        assert_eq!(query_key("/?k=abc123&t=999"), "abc123");
        assert_eq!(query_key("/"), "");
    }

    struct RecordingSink {
        received: Mutex<Vec<(String, String, String)>>,
    }

    impl SessionSink for RecordingSink {
        fn submit(&self, email: &str, token: &str, name: &str) -> Result<(), String> {
            self.received
                .lock()
                .map_err(|_| "poisoned".to_string())?
                .push((email.to_string(), token.to_string(), name.to_string()));
            Ok(())
        }
    }

    fn http_roundtrip(port: u16, raw_request: &str) -> String {
        let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect");
        stream
            .write_all(raw_request.as_bytes())
            .expect("write request");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .expect("timeout");
        let mut out = Vec::new();
        let _ = stream.read_to_end(&mut out);
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn server_serves_page_and_accepts_session() {
        let sink = Arc::new(RecordingSink {
            received: Mutex::new(Vec::new()),
        });
        let status: StatusFn = Arc::new(|| (false, None));
        let running =
            spawn_server("testkey".to_string(), CHATGPT, sink.clone(), status).expect("spawn");
        let port = running.port;

        let health = http_roundtrip(port, "GET /api/health HTTP/1.0\r\n\r\n");
        assert!(health.contains("200 OK"), "{health}");
        assert!(health.contains("\"ok\":true"), "{health}");
        crate::phone_network::check_server(port)
            .expect("local server must answer before sharing the QR");

        let home = http_roundtrip(port, "GET /?k=testkey HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
        assert!(home.contains("200"), "home: {home}");
        assert!(home.contains("/api/form/start"));

        let paste = http_roundtrip(port, "GET /paste?k=testkey HTTP/1.0\r\n\r\n");
        assert!(paste.contains("/api/session"), "paste: {paste}");
        assert!(paste.contains("/api/auth/session"));

        let st = http_roundtrip(port, "GET /api/status?k=testkey HTTP/1.0\r\n\r\n");
        assert!(st.contains("200"), "status: {st}");
        assert!(st.contains("\"done\":false"), "status body: {st}");

        let post =
            r#"{"key":"testkey","accessToken":"tok-9","email":"c@d.com","name":"Ada Lovelace"}"#;
        let request = format!(
            "POST /api/session HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            post.len(),
            post
        );
        let pasted = http_roundtrip(port, &request);
        assert!(pasted.contains("200"), "paste: {pasted}");
        assert_eq!(
            sink.received.lock().unwrap().as_slice(),
            &[(
                "c@d.com".to_string(),
                "tok-9".to_string(),
                "Ada Lovelace".to_string()
            )]
        );

        let bad = http_roundtrip(
            port,
            "POST /api/session HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 6\r\n\r\nbad-js",
        );
        assert!(bad.contains("400"), "bad: {bad}");
    }
}
