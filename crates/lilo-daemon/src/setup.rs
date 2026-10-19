//! The setup window: no monitor, no keyboard, so the phone is the UI.
//!
//! While the box has no network and no account it brings up its own open access
//! point, answers every DNS name with itself — that is what makes a phone show
//! the "sign in to network" sheet by itself, like an Echo does — and serves one
//! page with the endpoints below. The moment an account is stored the window
//! closes and the daemon gets on with its life.
//!
//! Plan: `docs/command-protocol.md` §9. The page is a static file, not a
//! frontend build: the board has a browser on the *other* side of the LAN.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lilo_core::accounts::{parse_session_paste, Account, AccountStore};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::config::SetupSection;
use crate::log;
use crate::wifi::Wifi;

/// The page. One file, no build step, no remote assets (the phone is behind a
/// captive portal: nothing else is reachable anyway).
const PAGE: &str = include_str!("setup.html");

/// Paths the operating systems probe to decide whether a network is captive.
/// Any of them answering something other than the expected body pops the sheet.
const PROBE_PATHS: &[&str] = &[
    "/generate_204",        // Android
    "/hotspot-detect.html", // Apple
    "/connecttest.txt",     // Windows
    "/ncsi.txt",            // Windows
    "/canonical.html",      // Firefox
];

/// The setup window while it is open.
pub struct Setup {
    inner: Arc<Inner>,
    server: Arc<Server>,
    dns_thread: Option<tokio::task::JoinHandle<()>>,
    /// Where the page is listening; a test binds port 0 and reads it back.
    pub addr: SocketAddr,
    /// The address the box has on its own access point: what a person types
    /// when the page is bound to every interface.
    ap_ip: Ipv4Addr,
    /// Whether *we* brought the access point up: only then may `stop` tear it
    /// down, and never on a box that was already on a network.
    ap_started: bool,
    /// The uplink address captured before the access point came up, so the
    /// logged URL is reachable from the phone.
    lan_ip: Option<String>,
}

struct Inner {
    wifi: Arc<dyn Wifi>,
    accounts: AccountStore,
    http: reqwest::Client,
    user_agent: String,
    handle: tokio::runtime::Handle,
    /// Network facts cached at `start`: shelling out to nmcli on every 3 s
    /// status poll would make the one page a phone is waiting on the slowest.
    online: bool,
    radio: bool,
}

/// The single definition of "the box is on a network it can use":
/// a joined Wi-Fi, an uplink that already exists (Ethernet or a LAN-only link),
/// or no radio at all — a wired-only board must never wait for a join it cannot
/// make. The box's own setup access point is never an uplink.
pub fn network_ok(wifi: &dyn Wifi) -> bool {
    wifi.current().is_some() || wifi.online() || !wifi.has_radio()
}

impl Inner {
    /// The same rule the page reports and the daemon waits on.
    fn configured(&self) -> bool {
        !self.accounts.list().is_empty() && network_ok(&*self.wifi)
    }
}

impl Setup {
    /// Bring the access point and the servers up. Does not wait for anything:
    /// `wait_configured` is what the daemon waits on, and `stop` closes it.
    pub async fn start(
        settings: SetupSection,
        wifi: Arc<dyn Wifi>,
        accounts: AccountStore,
        http: reqwest::Client,
        user_agent: String,
    ) -> anyhow::Result<Self> {
        // Decide the network facts *before* touching the radio: `online()` must
        // never see the hotspot we are about to start, and `local_ip()` must
        // read the uplink, not the AP's own address.
        let radio = wifi.has_radio();
        let online = wifi.online();
        let lan_ip = wifi.local_ip();

        // The access point is only for a box that could join a network but has
        // not got one. A radio-less board and a box already on the LAN get the
        // page over the network they already have.
        let ap_started = radio && !online;
        if ap_started {
            if let Err(error) = wifi.start_setup_ap(&settings.ap_ssid) {
                log::warn(format!("could not start the setup access point: {error}"));
            } else {
                log::info(format!(
                    "setup access point \"{}\" is up (open, LAN only)",
                    settings.ap_ssid
                ));
            }
        } else if !radio {
            log::info("no WiFi radio here: reach the setup page over the existing network");
        } else {
            log::info("no setup access point needed: already on a network");
        }

        let inner = Arc::new(Inner {
            wifi,
            accounts,
            http,
            user_agent,
            handle: tokio::runtime::Handle::current(),
            online,
            radio,
        });

        let server = Arc::new(
            Server::http(("0.0.0.0", settings.port))
                .map_err(|error| anyhow::anyhow!("could not serve the setup page: {error}"))?,
        );
        let addr = server
            .server_addr()
            .to_ip()
            .unwrap_or_else(|| SocketAddr::from((Ipv4Addr::UNSPECIFIED, settings.port)));
        // The page is served from its own thread: tiny_http is blocking, and a
        // request must never hold up the daemon's runtime.
        {
            let server = server.clone();
            let inner = inner.clone();
            std::thread::spawn(move || {
                while let Ok(request) = server.recv() {
                    handle(&inner, request);
                }
            })
        };

        let dns_thread = match bind_dns(settings.dns_port).await {
            Ok(socket) => {
                log::info(format!(
                    "setup DNS on port {}: every name answers {}",
                    settings.dns_port, settings.ap_ip
                ));
                Some(tokio::spawn(dns_loop(socket, settings.ap_ip)))
            }
            Err(error) => {
                // Port 53 needs privileges; the page still works when the phone
                // is pointed at the address by hand.
                log::warn(format!("setup DNS not started: {error}"));
                None
            }
        };

        Ok(Setup {
            inner,
            server,
            dns_thread,
            addr,
            ap_ip: settings.ap_ip,
            ap_started,
            lan_ip,
        })
    }

    /// Wait until the box is configured: an account, and a network when this
    /// machine can join one. The access point stays up until then — the phone
    /// is still on it to finish the second step.
    pub async fn wait_configured(&self) {
        loop {
            if self.inner.configured() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }

    /// Where to open the page. A box that is already on the LAN is reached at
    /// its own address — on the board the server is bound to every interface,
    /// so the access point's address is the phone's way in only while that AP
    /// is up; on a developer machine the loopback one is. When the configured
    /// port is 0 the OS picked a free one, and this is how anybody learns which.
    pub fn url(&self) -> String {
        let port = self.addr.port();
        if let Some(ip) = &self.lan_ip {
            return format!("http://{ip}:{port}/");
        }
        if self.addr.ip().is_unspecified() {
            format!(
                "http://{}:{port}/ (on this machine: http://127.0.0.1:{port}/)",
                self.ap_ip
            )
        } else {
            format!("http://{}:{port}/", self.addr.ip())
        }
    }

    /// Close the window: page, DNS and — only if we started it — the access
    /// point. A box that was already on a network must keep it.
    pub fn stop(&self) {
        self.server.unblock();
        if let Some(dns) = &self.dns_thread {
            dns.abort();
        }
        if self.ap_started {
            let _ = self.inner.wifi.stop_setup_ap();
        }
    }
}

/// Serve the setup window until an account is stored. The daemon calls this
/// once and gets its box back configured.
pub async fn run(
    settings: SetupSection,
    wifi: Arc<dyn Wifi>,
    accounts: AccountStore,
    http: reqwest::Client,
    user_agent: String,
    completion: Completion,
) -> anyhow::Result<()> {
    let setup = Setup::start(settings, wifi, accounts, http, user_agent).await?;
    log::info(format!("setup page on {}", setup.url()));
    log::info("setup: open it from the phone that will configure this box");
    setup.wait_configured().await;
    // Recorded before the window closes so a reboot cannot reopen it on a
    // momentarily-down network. A failure here must not undo a finished setup:
    // it only means the window could open again.
    if let Err(error) = completion.mark() {
        log::warn(format!("could not record setup completion: {error}"));
    }
    setup.stop();
    log::info("setup finished");
    Ok(())
}

/// Records that setup finished once, so a reboot does not reopen the window
/// because the network is momentarily down or a fake backend forgot the join.
/// Daemon-local: `<data_dir>/setup.json`, no `lilo-core` schema change.
pub struct Completion {
    path: PathBuf,
}

impl Completion {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("setup.json"),
        }
    }

    /// Whether a completed setup was recorded. A missing or unreadable file is
    /// "not complete" — setup may open again, never the other way round.
    pub fn is_complete(&self) -> bool {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| value.get("completed").and_then(|done| done.as_bool()))
            .unwrap_or(false)
    }

    /// Write the marker: `{"completed":true,"at":<unix_ms>}`, an object rather
    /// than a bare sentinel so it can carry a schema later.
    pub fn mark(&self) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        let payload = serde_json::json!({ "completed": true, "at": at });
        std::fs::write(&self.path, payload.to_string())?;
        Ok(())
    }
}

/// Whether the daemon should open the setup window.
///
/// `configured` is account-plus-network; `complete` is a recorded completion
/// that still has an account behind it (deleting `accounts.json` must re-open
/// setup, while a down network after a finished setup must not).
pub fn setup_needed(forced: bool, backend_present: bool, configured: bool, complete: bool) -> bool {
    forced || (backend_present && !configured && !complete)
}

fn handle(inner: &Arc<Inner>, mut request: Request) {
    let method = request.method().clone();
    let url = request.url().split('?').next().unwrap_or("/").to_string();
    let mut body = String::new();
    if method == Method::Post {
        let _ = request.as_reader().read_to_string(&mut body);
    }

    let response = match (method, url.as_str()) {
        (Method::Get, "/") => html(PAGE),
        (Method::Get, "/api/status") => json(status_json(inner)),
        (Method::Get, "/api/scan") => match inner.wifi.scan() {
            Ok(networks) => json(scan_json(&networks)),
            Err(error) => json(error_json(&error.to_string())),
        },
        (Method::Post, "/api/wifi") => json(connect_wifi(inner, &body)),
        (Method::Post, "/api/account") => json(store_account(inner, &body)),
        (Method::Get, path) if PROBE_PATHS.contains(&path) => redirect(),
        _ => Response::from_string("not found").with_status_code(404),
    };
    let _ = request.respond(response);
}

fn status_json(inner: &Arc<Inner>) -> String {
    let account = inner.accounts.list().first().map(|view| view.email.clone());
    let wifi = inner.wifi.current();
    let done = inner.configured();
    serde_json::json!({
        "wifi": wifi,
        "account": account,
        "done": done,
        "online": inner.online,
        "radio": inner.radio,
    })
    .to_string()
}

fn scan_json(networks: &[crate::wifi::Network]) -> String {
    let list: Vec<serde_json::Value> = networks
        .iter()
        .map(|network| {
            serde_json::json!({
                "ssid": network.ssid,
                "signal": network.signal,
                "secured": network.secured,
                "security": network.security,
            })
        })
        .collect();
    serde_json::Value::Array(list).to_string()
}

fn connect_wifi(inner: &Arc<Inner>, body: &str) -> String {
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return error_json("the request was not JSON"),
    };
    let ssid = payload
        .get("ssid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let password = payload
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if ssid.is_empty() {
        return error_json("which network?");
    }
    if ssid.len() > 32
        || ssid.chars().any(char::is_control)
        || password.len() > 128
        || password.chars().any(char::is_control)
    {
        return error_json("invalid Wi-Fi details");
    }
    match inner.wifi.connect(ssid, password) {
        Ok(()) => {
            // The access point stays up: the phone is still on it for the
            // account step, and dropping it here is how a half-configured box
            // becomes unreachable. It closes when setup finishes.
            log::info(format!(
                "joined \"{ssid}\"; setup access point still up for the account step"
            ));
            serde_json::json!({ "ok": true }).to_string()
        }
        Err(error) => {
            let _ = error;
            log::warn(format!("could not join Wi-Fi network \"{ssid}\""));
            error_json("could not join that Wi-Fi network")
        }
    }
}

fn store_account(inner: &Arc<Inner>, body: &str) -> String {
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return error_json("the request was not JSON"),
    };
    let session = payload
        .get("session")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cookie = payload
        .get("cookie")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let Some(paste) = parse_session_paste(session) else {
        return error_json("could not read a session in what was pasted");
    };
    if paste.email.trim().is_empty() {
        return error_json("the session has no e-mail in it");
    }

    let mut account = Account::chatgpt(&paste.email, &paste.name, &paste.access_token);
    if !cookie.is_empty() {
        account.session_cookie = cookie.to_string();
        // The cookie is the long-lived credential: exchange it once, here, so
        // the box holds a token that is fresh from the start (`docs/command-protocol.md` §9, onboarding step 3).
        match inner.handle.block_on(lilo_core::refresh::fetch_session(
            &inner.http,
            cookie,
            &inner.user_agent,
        )) {
            Ok(fresh) => {
                if !fresh.access_token.is_empty() {
                    account.access_token = fresh.access_token;
                }
                if account.name.is_empty() {
                    account.name = fresh.name;
                }
                log::info("session cookie accepted: the token can renew itself");
            }
            Err(error) => log::warn(format!(
                "the cookie was stored but not verified now: {error}"
            )),
        }
    }

    let email = account.email.clone();
    if let Err(error) = inner.accounts.add(account) {
        return error_json(&error.to_string());
    }
    log::info(format!("account {email} stored"));
    serde_json::json!({ "ok": true, "email": email }).to_string()
}

fn html(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body).with_header(header("Content-Type", "text/html; charset=utf-8"))
}

fn json(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_header(header("Content-Type", "application/json"))
        // A page full of session tokens must never sit in a cache.
        .with_header(header("Cache-Control", "no-store"))
}

fn redirect() -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string("")
        .with_status_code(302)
        .with_header(header("Location", "/"))
}

fn error_json(message: &str) -> String {
    serde_json::json!({ "ok": false, "error": message }).to_string()
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("a valid header")
}

/// A UDP socket on `port`, `0` meaning "any" — a test uses that so it never
/// needs port 53.
async fn bind_dns(port: u16) -> anyhow::Result<tokio::net::UdpSocket> {
    if port == 0 {
        anyhow::bail!("no DNS port configured");
    }
    let socket = tokio::net::UdpSocket::bind(("0.0.0.0", port))
        .await
        .map_err(|error| anyhow::anyhow!("could not bind UDP {port}: {error}"))?;
    Ok(socket)
}

/// Answer every A question with the box's own address, which is what turns a
/// phone's connectivity probe into "there is a sign-in page here".
async fn dns_loop(socket: tokio::net::UdpSocket, ip: Ipv4Addr) {
    let mut buffer = [0u8; 512];
    loop {
        let Ok((length, from)) = socket.recv_from(&mut buffer).await else {
            return;
        };
        if let Some(reply) = answer(&buffer[..length], ip) {
            let _ = socket.send_to(&reply, from).await;
        }
    }
}

/// Build the DNS reply for one query: header, the original question, and one A
/// record pointing at `ip`. `None` when the packet is not a DNS query we can
/// read. Pure, so the byte fiddling is testable without a socket.
pub fn answer(query: &[u8], ip: Ipv4Addr) -> Option<Vec<u8>> {
    if query.len() < 12 {
        return None;
    }
    let question_end = question_end(query)?;
    // QTYPE is the two bytes after the question name and QCLASS.
    let qtype = u16::from_be_bytes([query[question_end - 4], query[question_end - 3]]);

    let mut reply = Vec::with_capacity(question_end + 16);
    // ID, flags: response, recursion available, recursion desired as asked.
    reply.extend_from_slice(&query[0..2]);
    reply.push(0x81);
    reply.push(0x80 | (query[2] & 0x01));
    // QDCOUNT = 1, ANCOUNT = 1 for an A question, else 0.
    reply.extend_from_slice(&1u16.to_be_bytes());
    reply.extend_from_slice(&(if qtype == 1 { 1u16 } else { 0u16 }).to_be_bytes());
    reply.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT
    reply.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT
    reply.extend_from_slice(&query[12..question_end]);

    if qtype == 1 {
        reply.extend_from_slice(&[0xC0, 0x0C]); // the name we just echoed
        reply.extend_from_slice(&1u16.to_be_bytes()); // A
        reply.extend_from_slice(&1u16.to_be_bytes()); // IN
        reply.extend_from_slice(&60u32.to_be_bytes()); // TTL
        reply.extend_from_slice(&4u16.to_be_bytes()); // RDLENGTH
        reply.extend_from_slice(&ip.octets());
    }
    Some(reply)
}

/// Where the question (QNAME + QTYPE + QCLASS) ends in a DNS query.
fn question_end(query: &[u8]) -> Option<usize> {
    let mut index = 12;
    loop {
        let length = *query.get(index)? as usize;
        if length == 0 {
            // +1 for the root label, +2 QTYPE, +2 QCLASS.
            return Some(index + 5).filter(|end| *end <= query.len());
        }
        index += 1 + length;
        if index > query.len() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wifi::{Fake, Network};

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilo-setup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn account() -> Account {
        Account::chatgpt("ada@example.com", "Ada", "token")
    }

    async fn setup_with(wifi: Arc<dyn Wifi>) -> Setup {
        let dir = temp_dir();
        let accounts = AccountStore::load(dir.join("accounts.json"));
        let settings = SetupSection {
            port: 0,     // any free port: tests never need 80
            dns_port: 0, // ... nor privileges for 53
            ..SetupSection::default()
        };
        Setup::start(
            settings,
            wifi,
            accounts,
            reqwest::Client::new(),
            "lilo-test".to_string(),
        )
        .await
        .unwrap()
    }

    async fn setup_for_test() -> (Setup, Arc<Fake>) {
        let wifi = Arc::new(Fake::new());
        (setup_with(wifi.clone()).await, wifi)
    }

    /// An `Inner` (account store + backend) for the pure `configured` rule.
    /// Only valid inside a tokio test: it captures the current runtime handle.
    fn inner_for(wifi: Arc<dyn Wifi>, dir: &Path) -> Inner {
        Inner {
            wifi,
            accounts: AccountStore::load(dir.join("accounts.json")),
            http: reqwest::Client::new(),
            user_agent: "lilo-test".to_string(),
            handle: tokio::runtime::Handle::current(),
            online: false,
            radio: true,
        }
    }

    /// A backend whose radio is off, so `/api/scan` fails — the error the page
    /// must show instead of silently swallowing.
    struct NoScan;

    impl Wifi for NoScan {
        fn available(&self) -> bool {
            true
        }
        fn scan(&self) -> anyhow::Result<Vec<Network>> {
            anyhow::bail!("the radio is off")
        }
        fn connect(&self, _ssid: &str, _password: &str) -> anyhow::Result<()> {
            anyhow::bail!("the radio is off")
        }
        fn current(&self) -> Option<String> {
            None
        }
        fn start_setup_ap(&self, _ssid: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn stop_setup_ap(&self) -> anyhow::Result<()> {
            Ok(())
        }
        fn has_radio(&self) -> bool {
            true
        }
        fn online(&self) -> bool {
            false
        }
        fn local_ip(&self) -> Option<String> {
            None
        }
    }

    /// The server binds every interface; Windows refuses a connection to the
    /// unspecified address itself (WSAEADDRNOTAVAIL), so tests dial loopback.
    fn loopback(setup: &Setup) -> String {
        format!("http://127.0.0.1:{}", setup.addr.port())
    }

    #[tokio::test]
    async fn the_page_scan_and_status_answer() {
        let (setup, _wifi) = setup_for_test().await;
        let base = loopback(&setup);
        let client = reqwest::Client::new();

        let page = client
            .get(&base)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(page.contains("LILO"), "the page is served");
        assert!(page.contains("/api/wifi"), "and it knows its endpoints");

        let networks: serde_json::Value = client
            .get(format!("{base}/api/scan"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(networks[0]["ssid"], "casa");
        assert_eq!(networks[0]["secured"], true);

        let status: serde_json::Value = client
            .get(format!("{base}/api/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(status["wifi"].is_null(), "nothing joined yet");
        assert_eq!(status["done"], false);
        assert_eq!(status["radio"], true, "the default fake has a radio");
        assert_eq!(status["online"], false, "and no uplink yet");

        _wifi.connect("casa", "segredo").unwrap();
        let status: serde_json::Value = client
            .get(format!("{base}/api/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["wifi"], "casa");
        assert_eq!(status["account"], serde_json::Value::Null);

        setup.stop();
    }

    #[tokio::test]
    async fn a_network_that_cannot_be_joined_comes_back_as_an_error_not_a_500() {
        let (setup, _wifi) = setup_for_test().await;
        let base = loopback(&setup);
        let client = reqwest::Client::new();
        let reply: serde_json::Value = client
            .post(format!("{base}/api/wifi"))
            .json(&serde_json::json!({ "ssid": "rede-que-nao-existe", "password": "x" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "could not join that Wi-Fi network");
        setup.stop();
    }

    #[tokio::test]
    async fn a_pasted_session_is_stored_and_ends_setup() {
        let (setup, wifi) = setup_for_test().await;
        let base = loopback(&setup);
        let client = reqwest::Client::new();
        wifi.connect("casa", "segredo").unwrap();

        // The shape the page asks for: the JSON of /api/auth/session.
        let session = serde_json::json!({
            "accessToken": "eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFkYUBleGFtcGxlLmNvbSJ9.x",
            "user": { "email": "ada@example.com", "name": "Ada" }
        })
        .to_string();
        let reply: serde_json::Value = client
            .post(format!("{base}/api/account"))
            .json(&serde_json::json!({ "session": session, "cookie": "" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        assert_eq!(reply["email"], "ada@example.com");

        let status: serde_json::Value = client
            .get(format!("{base}/api/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["done"], true, "wifi + account is what ends setup");
        setup.stop();
    }

    #[tokio::test]
    async fn garbage_in_the_account_field_is_refused() {
        let (setup, _wifi) = setup_for_test().await;
        let base = loopback(&setup);
        let client = reqwest::Client::new();
        let reply: serde_json::Value = client
            .post(format!("{base}/api/account"))
            .json(&serde_json::json!({ "session": "nada disso", "cookie": "" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(reply["ok"], false);
        setup.stop();
    }

    #[test]
    fn a_dns_query_for_a_name_answers_with_our_address() {
        // Hand-built query: id 0x1234, RD, one question, A, IN, "example.com".
        let mut query = vec![0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
        for label in ["example", "com"] {
            query.push(label.len() as u8);
            query.extend_from_slice(label.as_bytes());
        }
        query.push(0);
        query.extend_from_slice(&1u16.to_be_bytes());
        query.extend_from_slice(&1u16.to_be_bytes());

        let reply = answer(&query, Ipv4Addr::new(192, 168, 4, 1)).expect("a reply");
        assert_eq!(&reply[0..2], &[0x12, 0x34], "the id comes back");
        assert_eq!(reply[2] & 0x80, 0x80, "this is a response");
        assert_eq!(u16::from_be_bytes([reply[6], reply[7]]), 1, "one answer");
        assert_eq!(&reply[reply.len() - 4..], &[192, 168, 4, 1]);

        assert!(
            answer(&[0x12, 0x34], Ipv4Addr::LOCALHOST).is_none(),
            "a stub is not a query"
        );
    }

    #[test]
    fn a_dns_query_for_something_else_gets_no_answer_record() {
        let mut query = vec![0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
        query.extend_from_slice(&[1, b'a', 0]);
        query.extend_from_slice(&28u16.to_be_bytes()); // AAAA
        query.extend_from_slice(&1u16.to_be_bytes());
        let reply = answer(&query, Ipv4Addr::new(192, 168, 4, 1)).expect("a reply");
        assert_eq!(u16::from_be_bytes([reply[6], reply[7]]), 0);
    }

    #[tokio::test]
    async fn a_radio_less_box_with_an_account_finishes_without_a_join() {
        let dir = temp_dir();
        let wifi: Arc<dyn Wifi> = Arc::new(Fake::new().radio_less());
        assert!(wifi.current().is_none(), "the board never joined anything");
        assert!(!wifi.has_radio());
        let inner = inner_for(wifi, &dir);
        inner.accounts.add(account()).unwrap();
        assert!(
            inner.configured(),
            "an account is enough when there is no radio"
        );
    }

    #[tokio::test]
    async fn an_online_box_never_has_to_join() {
        let dir = temp_dir();
        let wifi: Arc<dyn Wifi> = Arc::new(Fake::new().online());
        assert!(
            wifi.current().is_none(),
            "nothing joined: the uplink is not Wi-Fi"
        );
        let inner = inner_for(wifi, &dir);
        inner.accounts.add(account()).unwrap();
        assert!(inner.configured(), "an existing uplink is enough");
    }

    #[tokio::test]
    async fn a_radio_box_offline_still_must_join() {
        let dir = temp_dir();
        let wifi: Arc<dyn Wifi> = Arc::new(Fake::new().offline());
        let inner = inner_for(wifi.clone(), &dir);
        inner.accounts.add(account()).unwrap();
        assert!(
            !inner.configured(),
            "a radio with no uplink still needs a join"
        );
        wifi.connect("casa", "segredo").unwrap();
        assert!(inner.configured());
    }

    #[tokio::test]
    async fn the_setup_access_point_is_not_an_uplink() {
        // The box's own access point is the only "connection" while it is
        // unconfigured; a Fake never brings one up, and `parse_active_uplink`
        // ignores `Hotspot`, so an unjoined radio is never reported online.
        let wifi: Arc<dyn Wifi> = Arc::new(Fake::new());
        assert!(!wifi.online(), "our own access point is not an uplink");
        let dir = temp_dir();
        let inner = inner_for(wifi, &dir);
        inner.accounts.add(account()).unwrap();
        assert!(
            !inner.configured(),
            "an account alone is not enough while a radio is unjoined"
        );
    }

    #[test]
    fn setup_completion_survives_a_restart() {
        let dir = temp_dir();
        let completion = Completion::new(&dir);
        assert!(!completion.is_complete());
        completion.mark().unwrap();
        assert!(
            Completion::new(&dir).is_complete(),
            "a fresh Completion reads the marker"
        );

        // The whole point: after a finished setup the daemon does not reopen the
        // window just because the network is momentarily down.
        assert!(
            !setup_needed(false, true, false, true),
            "the marker wins over a transiently-down network"
        );
    }

    #[test]
    fn a_marker_does_not_override_a_missing_account() {
        let dir = temp_dir();
        let completion = Completion::new(&dir);
        completion.mark().unwrap();
        // `main` only counts the marker while the account it was completed for is
        // still there, so deleting accounts.json re-opens setup (AC8).
        let account_present = false;
        let complete = account_present && completion.is_complete();
        assert!(setup_needed(false, true, account_present, complete));
    }

    #[test]
    fn the_forced_flag_always_opens_setup() {
        for backend in [true, false] {
            for configured in [true, false] {
                for complete in [true, false] {
                    assert!(
                        setup_needed(true, backend, configured, complete),
                        "forced backend={backend} configured={configured} complete={complete}"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn the_url_prefers_the_lan_address() {
        let setup = setup_with(Arc::new(Fake::new().with_ip("192.168.1.4"))).await;
        let url = setup.url();
        assert!(url.contains("192.168.1.4"), "{url}");
        assert!(
            !url.contains("192.168.4.1"),
            "the AP address is not the way in: {url}"
        );
        setup.stop();
    }

    #[tokio::test]
    async fn the_scan_endpoint_surfaces_its_error() {
        let setup = setup_with(Arc::new(NoScan)).await;
        let base = loopback(&setup);
        let body: serde_json::Value = reqwest::Client::new()
            .get(format!("{base}/api/scan"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["ok"], false);
        assert!(body["error"].as_str().unwrap().contains("radio"), "{body}");
        let page = reqwest::get(&base).await.unwrap().text().await.unwrap();
        assert!(
            page.contains("Array.isArray"),
            "the page must not swallow a scan error"
        );
        setup.stop();
    }
}
