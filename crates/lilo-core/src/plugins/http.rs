//! Permission-scoped HTTP for every JavaScript plugin, independent of features.

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::{header, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};

pub(crate) const MAX_RESPONSE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub(crate) const MAX_TIMEOUT_MS: u64 = 10_000;
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Options {
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
    #[serde(default = "default_response_limit")]
    max_response_bytes: usize,
}

fn default_method() -> String {
    "GET".into()
}
fn default_timeout() -> u64 {
    5_000
}
fn default_response_limit() -> usize {
    128 * 1024
}

#[derive(Debug, Serialize)]
pub(crate) struct Response {
    pub status: u16,
    pub ok: bool,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

/// Reject before any client or connection is created. Errors never contain URLs.
fn permitted_url(permissions: &[String], input: &str) -> Result<Url> {
    if input.len() > 4096 {
        return Err(AppError::other("HTTP URL is too long."));
    }
    let url = Url::parse(input).map_err(|_| AppError::other("Invalid HTTP URL."))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::other(
            "HTTP credentials cannot be embedded in the URL.",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::other("HTTP URL needs a domain."))?;
    if !permissions.iter().any(|permission| {
        permission
            .strip_prefix("http:")
            .is_some_and(|domain| domain.eq_ignore_ascii_case(host))
    }) {
        return Err(AppError::other(
            "HTTP domain is not permitted by this plugin's manifest.",
        ));
    }
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(AppError::other(
            "HTTP requires HTTPS; plain HTTP is allowed only on loopback.",
        ));
    }
    Ok(url)
}

fn options(value: Value) -> Result<Options> {
    let value = if value.is_null() {
        serde_json::json!({})
    } else {
        value
    };
    let options: Options =
        serde_json::from_value(value).map_err(|_| AppError::other("Invalid HTTP options."))?;
    if !matches!(
        options.method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err(AppError::other("Unsupported HTTP method."));
    }
    if !(100..=MAX_TIMEOUT_MS).contains(&options.timeout_ms)
        || !(1..=MAX_RESPONSE_BYTES).contains(&options.max_response_bytes)
    {
        return Err(AppError::other(
            "HTTP timeout or response limit is outside host bounds.",
        ));
    }
    if options
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
    {
        return Err(AppError::other("HTTP request body is too large."));
    }
    if options.headers.len() > 32 {
        return Err(AppError::other("Too many HTTP headers."));
    }
    for (name, value) in &options.headers {
        let name = header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| AppError::other("Invalid HTTP header name."))?;
        if matches!(
            name.as_str(),
            "cookie" | "host" | "connection" | "content-length" | "transfer-encoding" | "te"
        ) || name.as_str().starts_with("proxy-")
        {
            return Err(AppError::other(
                "HTTP header is managed by the host or not permitted.",
            ));
        }
        if value.len() > 1024 || header::HeaderValue::from_str(value).is_err() {
            return Err(AppError::other("Invalid or oversized HTTP header value."));
        }
    }
    Ok(options)
}

/// Called on the plugin's dedicated worker thread, never a Tokio executor thread.
pub(crate) fn request(permissions: &[String], input: &str, value: Value) -> Result<Response> {
    let url = permitted_url(permissions, input)?;
    let options = options(value)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| AppError::other("HTTP runtime is unavailable."))?;
    let result = runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_millis(options.timeout_ms),
            send(permissions, url, options),
        )
        .await
        .map_err(|_| AppError::other("HTTP request timed out."))?
    });
    // DNS may use an OS blocking task; runtime teardown must not defeat timeout.
    runtime.shutdown_background();
    result
}

async fn send(permissions: &[String], mut url: Url, options: Options) -> Result<Response> {
    // No browser account, inherited proxy credentials, cookie jar or implicit redirects.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AppError::other("HTTP client is unavailable."))?;
    let mut method = Method::from_bytes(options.method.as_bytes())
        .map_err(|_| AppError::other("Invalid HTTP method."))?;
    let mut body = options.body;
    let mut headers = options.headers;
    for hop in 0..=MAX_REDIRECTS {
        let mut request = client.request(method.clone(), url.clone());
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        if let Some(body) = &body {
            request = request.body(body.clone());
        }
        let mut response = request.send().await.map_err(|error| {
            AppError::other(if error.is_timeout() {
                "HTTP request timed out."
            } else {
                "HTTP request failed."
            })
        })?;
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
            && response.headers().contains_key(header::LOCATION)
        {
            if hop == MAX_REDIRECTS {
                return Err(AppError::other("HTTP redirect limit exceeded."));
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::other("Invalid HTTP redirect."))?;
            let next = url
                .join(location)
                .map_err(|_| AppError::other("Invalid HTTP redirect."))?;
            let next = permitted_url(permissions, next.as_str())?;
            let becomes_get = (status.as_u16() == 303 && method != Method::HEAD)
                || (matches!(status.as_u16(), 301 | 302) && method == Method::POST);
            if becomes_get {
                method = Method::GET;
                body = None;
            }
            if url.origin() != next.origin() {
                if body.is_some() {
                    return Err(AppError::other(
                        "HTTP redirects with a body cannot change origin.",
                    ));
                }
                // Do not forward even custom secret headers to a different origin.
                headers.clear();
            }
            url = next;
            continue;
        }
        if response
            .content_length()
            .is_some_and(|length| length > options.max_response_bytes as u64)
        {
            return Err(AppError::other("HTTP response exceeds the byte limit."));
        }
        let mut visible_headers = BTreeMap::new();
        for name in [
            "content-type",
            "cache-control",
            "etag",
            "last-modified",
            "retry-after",
        ] {
            if let Some(value) = response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
            {
                if value.len() <= 1024 {
                    visible_headers.insert(name.to_string(), value.to_string());
                }
            }
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AppError::other("HTTP response could not be read."))?
        {
            if chunk.len() > options.max_response_bytes.saturating_sub(bytes.len()) {
                return Err(AppError::other("HTTP response exceeds the byte limit."));
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(bytes)
            .map_err(|_| AppError::other("HTTP response is not UTF-8 text."))?;
        return Ok(Response {
            status: status.as_u16(),
            ok: status.is_success(),
            headers: visible_headers,
            body,
        });
    }
    Err(AppError::other("HTTP redirect limit exceeded."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;

    fn server(
        response: Vec<u8>,
        delay: Duration,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/data", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let thread = thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        let mut request = String::new();
                        loop {
                            let mut line = String::new();
                            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                                break;
                            }
                            request.push_str(&line);
                        }
                        let _ = tx.send(request);
                        thread::sleep(delay);
                        let _ = stream.write_all(&response);
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("test HTTP server failed: {error}"),
                }
            }
        });
        (url, rx, thread)
    }

    #[test]
    fn test_http_returns_bounded_text_and_http_error_status_without_cookies() {
        for status in ["200 OK", "404 Not Found"] {
            let response = format!("HTTP/1.1 {status}\r\nContent-Length: 2\r\nContent-Type: application/json\r\nSet-Cookie: hidden=value\r\nConnection: close\r\n\r\n{{}}").into_bytes();
            let (url, rx, worker) = server(response, Duration::ZERO);
            let result = request(&["http:127.0.0.1".into()], &url, serde_json::json!({})).unwrap();
            assert_eq!(result.ok, status.starts_with("200"));
            assert_eq!(result.body, "{}");
            assert!(!result.headers.contains_key("set-cookie"));
            assert!(!rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .to_lowercase()
                .contains("cookie:"));
            worker.join().unwrap();
        }
    }

    #[test]
    fn test_http_redirects_recheck_permissions_and_strip_cross_origin_headers() {
        let (target, rx, destination) = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(),
            Duration::ZERO,
        );
        let response = format!("HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes();
        let (url, _, source) = server(response, Duration::ZERO);
        request(&["http:127.0.0.1".into()], &url, serde_json::json!({"headers": {"Authorization": "Bearer private", "X-Private": "private"}})).unwrap();
        let request = rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .to_lowercase();
        assert!(!request.contains("private"));
        source.join().unwrap();
        destination.join().unwrap();

        let (url, _, worker) = server(b"HTTP/1.1 302 Found\r\nLocation: https://undeclared.invalid/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(), Duration::ZERO);
        let error = super::request(&["http:127.0.0.1".into()], &url, serde_json::json!({}))
            .unwrap_err()
            .to_string();
        assert!(error.contains("domain is not permitted"));
        assert!(!error.contains("secret"));
        worker.join().unwrap();
    }

    #[test]
    fn test_http_limits_apply_to_streams_and_timeout() {
        let (url, _, worker) = server(
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nlonger".to_vec(),
            Duration::ZERO,
        );
        assert!(request(
            &["http:127.0.0.1".into()],
            &url,
            serde_json::json!({"maxResponseBytes": 3})
        )
        .unwrap_err()
        .to_string()
        .contains("byte limit"));
        worker.join().unwrap();
        let (url, _, worker) = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(),
            Duration::from_millis(200),
        );
        assert!(request(
            &["http:127.0.0.1".into()],
            &url,
            serde_json::json!({"timeoutMs": 100})
        )
        .unwrap_err()
        .to_string()
        .contains("timed out"));
        worker.join().unwrap();
    }

    #[test]
    fn test_http_head_limits_actual_body_not_the_representation_size() {
        let (url, _, worker) = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n".to_vec(),
            Duration::ZERO,
        );
        let result = request(
            &["http:127.0.0.1".into()],
            &url,
            serde_json::json!({"method": "HEAD", "maxResponseBytes": 8}),
        )
        .unwrap();
        assert_eq!(result.body, "");
        worker.join().unwrap();
    }

    #[test]
    fn test_http_url_requires_an_exact_domain_and_secure_transport() {
        let permissions = vec!["http:example.org".into(), "http:localhost".into()];
        assert!(permitted_url(&permissions, "https://example.org/data").is_ok());
        assert!(permitted_url(&permissions, "https://other.example.org/data").is_err());
        assert!(permitted_url(&permissions, "http://example.org/data").is_err());
        assert!(permitted_url(&permissions, "http://localhost:8123/data").is_ok());
        assert!(permitted_url(&permissions, "https://user:secret@example.org/data").is_err());
    }

    #[test]
    fn test_http_options_reject_unbounded_and_privileged_inputs() {
        assert!(options(serde_json::json!({"timeoutMs": 10001})).is_err());
        assert!(options(serde_json::json!({"maxResponseBytes": 262145})).is_err());
        assert!(options(serde_json::json!({"headers": {"Cookie": "private"}})).is_err());
        assert!(options(serde_json::json!({"method": "CONNECT"})).is_err());
        assert!(options(serde_json::json!({"unexpected": true})).is_err());
    }
}
