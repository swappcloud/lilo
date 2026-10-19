//! Bounded HTTP adapter for the management request port.

use std::io::{Read, Write};
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server};
use tokio::sync::{mpsc, oneshot};

use super::{Operation, Request};

const MAX_BODY: u64 = 64 * 1024;
const MAX_RESPONSE: usize = 512 * 1024;

pub struct ManagementServer {
    pub login_key: String,
    requests: mpsc::Receiver<Request>,
    stopping: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    pub access_file: PathBuf,
    pub address: SocketAddr,
}

impl ManagementServer {
    pub fn start(address: SocketAddr, data_dir: &Path, web_root: &Path) -> anyhow::Result<Self> {
        Self::start_with_pairing(address, data_dir, web_root, None)
    }

    pub fn start_with_pairing(
        address: SocketAddr,
        data_dir: &Path,
        web_root: &Path,
        pairing_file: Option<&Path>,
    ) -> anyhow::Result<Self> {
        let web_root = web_root.canonicalize().map_err(|_| {
            anyhow::anyhow!("Build the management frontend with npm run build:daemon first.")
        })?;
        anyhow::ensure!(
            web_root.join("daemon.html").is_file(),
            "Management frontend is missing daemon.html."
        );
        let server = Server::http(address)
            .map_err(|_| anyhow::anyhow!("Could not bind management address."))?;
        let address = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| anyhow::anyhow!("No management address."))?;
        let mut token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let host = if address.ip().is_unspecified() {
            UdpSocket::bind("0.0.0.0:0")
                .ok()
                .and_then(|socket| {
                    socket.connect("192.0.2.1:9").ok()?;
                    socket.local_addr().ok().map(|addr| addr.ip())
                })
                .unwrap_or(std::net::Ipv4Addr::LOCALHOST.into())
        } else {
            address.ip()
        };
        let mut login_key = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        if let Some(path) = pairing_file {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                anyhow::ensure!(
                    path.metadata()?.permissions().mode() & 0o077 == 0,
                    "Pairing file must be private."
                );
            }
            let keys = std::fs::read_to_string(path)?;
            let (stored_token, stored_key) = keys
                .trim()
                .split_once('.')
                .ok_or_else(|| anyhow::anyhow!("Invalid pairing file."))?;
            anyhow::ensure!(
                [stored_token, stored_key]
                    .iter()
                    .all(|key| key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())),
                "Invalid pairing file."
            );
            token = stored_token.into();
            login_key = stored_key.into();
        }
        let url = format!(
            "http://{}#{}.{}",
            SocketAddr::new(host, address.port()),
            token,
            login_key
        );
        let access_file = data_dir.join(format!("phone-access-{}.txt", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&access_file)?;
        writeln!(file, "{url}")?;
        let (sender, requests) = mpsc::channel(16);
        let stopping = Arc::new(AtomicBool::new(false));
        let signal = stopping.clone();
        let runtime = tokio::runtime::Handle::current();
        let worker = std::thread::spawn(move || {
            while !signal.load(Ordering::Relaxed) {
                if let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(200)) {
                    handle(request, &token, &sender, &runtime, &web_root);
                }
            }
        });
        Ok(Self {
            login_key,
            requests,
            stopping,
            worker: Some(worker),
            access_file,
            address,
        })
    }

    pub async fn receive(&mut self) -> Option<Request> {
        self.requests.recv().await
    }
}

impl Drop for ManagementServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Relaxed);
        self.requests.close();
        while self.requests.try_recv().is_ok() {}
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = std::fs::remove_file(&self.access_file);
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn header<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn same_origin(request: &tiny_http::Request) -> bool {
    let Some(origin) = header(request, "Origin") else {
        return true;
    };
    let Some(host) = header(request, "Host") else {
        return false;
    };
    let secure_proxy = header(request, "Cf-Visitor")
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
        .and_then(|visitor| {
            visitor
                .get("scheme")
                .and_then(serde_json::Value::as_str)
                .map(|scheme| scheme == "https")
        })
        .unwrap_or(false);
    let scheme = if secure_proxy { "https" } else { "http" };
    origin == format!("{scheme}://{host}")
}

fn respond(request: tiny_http::Request, status: u16, body: &str, content_type: &str) {
    let mut response = Response::from_string(body).with_status_code(status);
    for (name, value) in [
        ("Content-Type", content_type), ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
        ("X-Frame-Options", "DENY"),
        ("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data: blob: https://i.ytimg.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
    ] {
        if let Ok(header) = Header::from_bytes(name, value) { response.add_header(header); }
    }
    let _ = request.respond(response);
}

fn handle(
    mut request: tiny_http::Request,
    token: &str,
    sender: &mpsc::Sender<Request>,
    runtime: &tokio::runtime::Handle,
    web_root: &Path,
) {
    if request.method() == &Method::Get {
        let file = if request.url() == "/" {
            Some("daemon.html")
        } else {
            request
                .url()
                .strip_prefix("/assets/")
                .filter(|name| {
                    !name.starts_with('.')
                        && name
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                })
                .map(|_| &request.url()[1..])
        };
        let bytes = file
            .and_then(|file| web_root.join(file).canonicalize().ok())
            .filter(|path| path.starts_with(web_root))
            .and_then(|path| std::fs::read(path).ok());
        if let Some(bytes) = bytes {
            let mime = if request.url().ends_with(".js") {
                "text/javascript; charset=utf-8"
            } else if request.url().ends_with(".css") {
                "text/css; charset=utf-8"
            } else {
                "text/html; charset=utf-8"
            };
            if let Ok(body) = std::str::from_utf8(&bytes) {
                respond(request, 200, body, mime);
                return;
            }
        }
        respond(request, 404, "{}", "application/json");
        return;
    }
    if request.method() != &Method::Post || request.url() != "/api" {
        respond(request, 404, "{}", "application/json");
        return;
    }
    let authorized = header(&request, "X-Lilo-Token")
        .is_some_and(|value| constant_time_equal(value.as_bytes(), token.as_bytes()));
    if !authorized || !same_origin(&request) {
        respond(
            request,
            403,
            r#"{"error":"Open the pairing link supplied by this daemon."}"#,
            "application/json",
        );
        return;
    }
    if header(&request, "Content-Type") != Some("application/json")
        || request
            .body_length()
            .map_or(true, |size| size as u64 > MAX_BODY)
    {
        respond(
            request,
            400,
            r#"{"error":"Invalid request."}"#,
            "application/json",
        );
        return;
    }
    let mut body = Vec::new();
    if request
        .as_reader()
        .take(MAX_BODY + 1)
        .read_to_end(&mut body)
        .is_err()
        || body.len() as u64 > MAX_BODY
    {
        respond(
            request,
            413,
            r#"{"error":"Request is too large."}"#,
            "application/json",
        );
        return;
    }
    let Ok(operation) = serde_json::from_slice::<Operation>(&body) else {
        respond(
            request,
            400,
            r#"{"error":"Invalid operation."}"#,
            "application/json",
        );
        return;
    };
    if matches!(operation, Operation::NetworkJoin { .. }) && header(&request, "Origin").is_none() {
        respond(
            request,
            403,
            r#"{"error":"Open the pairing link supplied by this daemon."}"#,
            "application/json",
        );
        return;
    }
    let result = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(90), async {
            let (reply, receiver) = oneshot::channel();
            sender
                .send(Request { operation, reply })
                .await
                .map_err(|_| ())?;
            receiver.await.map_err(|_| ())
        })
        .await
    });
    match result {
        Ok(Ok(Ok(value))) => {
            let body = value.to_string();
            if body.len() > MAX_RESPONSE {
                respond(
                    request,
                    413,
                    r#"{"error":"Response is too large."}"#,
                    "application/json",
                );
            } else {
                respond(request, 200, &body, "application/json");
            }
        }
        _ => respond(
            request,
            422,
            r#"{"error":"Operation failed. Check plugin compatibility and settings."}"#,
            "application/json",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn network_boundary_rejects_unpaired_cross_origin_and_invalid_requests() {
        let root = std::env::temp_dir().join(format!("lilo-management-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("daemon.html"), "management page").unwrap();
        let mut server =
            ManagementServer::start("127.0.0.1:0".parse().unwrap(), &root, &root).unwrap();
        let url = format!("http://{}/api", server.address);
        let link = std::fs::read_to_string(&server.access_file).unwrap();
        let token = link
            .trim()
            .split_once('#')
            .unwrap()
            .1
            .split('.')
            .next()
            .unwrap();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        assert_eq!(
            client
                .post(&url)
                .json(&serde_json::json!({"operation":"state"}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .post(&url)
                .json(&serde_json::json!({"operation":"networkJoin","ssid":"home","password":"secret-pass"}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .post(&url)
                .header("X-Lilo-Token", token)
                .header("Origin", "http://other.example")
                .json(&serde_json::json!({"operation":"remove","id":"com.lilo.notes"}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .post(&url)
                .header("X-Lilo-Token", token)
                .header("Origin", "http://other.example")
                .json(&serde_json::json!({"operation":"networkJoin","ssid":"home","password":"secret-pass"}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .post(&url)
                .header("X-Lilo-Token", token)
                .json(&serde_json::json!({"operation":"networkJoin","ssid":"home","password":"secret-pass"}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let local_join = client
            .post(&url)
            .header("X-Lilo-Token", token)
            .header("Origin", format!("http://{}", server.address))
            .json(&serde_json::json!({"operation":"networkJoin","ssid":"home","password":"secret-pass"}));
        let local_join_reply = async {
            let request = server.receive().await.unwrap();
            assert!(matches!(
                request.operation,
                Operation::NetworkJoin { ref ssid, ref password }
                    if ssid == "home" && password == "secret-pass"
            ));
            request
                .reply
                .send(Ok(serde_json::json!({"currentSsid":"home"})))
                .unwrap();
        };
        let (response, _) = tokio::join!(local_join.send(), local_join_reply);
        let response = response.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap()["currentSsid"],
            "home"
        );
        let tunnel_call = client
            .post(&url)
            .header("Host", "device.trycloudflare.com")
            .header("Origin", "https://device.trycloudflare.com")
            .header("Cf-Visitor", r#"{"scheme":"https"}"#)
            .header("X-Lilo-Token", token)
            .json(&serde_json::json!({"operation":"state"}));
        let tunnel_reply = async {
            let request = server.receive().await.unwrap();
            assert!(matches!(request.operation, Operation::State {}));
            request
                .reply
                .send(Ok(serde_json::json!({"version":"tunnel"})))
                .unwrap();
        };
        let (response, _) = tokio::join!(tunnel_call.send(), tunnel_reply);
        assert_eq!(response.unwrap().status(), 200);
        assert_eq!(
            client
                .post(&url)
                .header("X-Lilo-Token", token)
                .json(&serde_json::json!({"operation":"state","unexpected":true}))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        let call = client
            .post(&url)
            .header("X-Lilo-Token", token)
            .json(&serde_json::json!({"operation":"state"}))
            .send();
        let reply = async {
            let request = server.receive().await.unwrap();
            assert!(matches!(request.operation, Operation::State {}));
            request
                .reply
                .send(Ok(serde_json::json!({"version":"test"})))
                .unwrap();
        };
        let (response, _) = tokio::join!(call, reply);
        assert_eq!(
            response.unwrap().json::<serde_json::Value>().await.unwrap()["version"],
            "test"
        );
        let traversal = client
            .get(format!(
                "http://{}/assets/%2e%2e/account.json",
                server.address
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(traversal.status(), 404);
        drop(server);
        std::fs::remove_dir_all(root).unwrap();
    }
}
