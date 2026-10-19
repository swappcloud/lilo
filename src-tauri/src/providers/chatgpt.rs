//! Automatic "Sign in with ChatGPT" flow + a same-origin network bridge.
//!
//! The user never copies a token. We open a real webview on `chatgpt.com`, they
//! sign in normally, and an injected user script reads the resulting session
//! from the same-origin `/api/auth/session` endpoint (the access token is an
//! HttpOnly-backed session value, so it cannot be read via `document.cookie`).
//!
//! The same window is then kept hidden and reused as a **bridge**: voice SDP
//! offers are posted to `/realtime/wm` *from inside the chatgpt.com origin*.
//! That means the browser's own TLS fingerprint, cookies, Origin/Referer and
//! Cloudflare clearance are used — so the Rust client's TLS fingerprint can
//! never get us blocked.
//!
//! Data flows back to Rust via navigation to a private `tauri-voice://` scheme,
//! which `on_navigation` intercepts and blocks before any network activity.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::providers::phone_form::PhoneForm;
use crate::providers::web_login::{self, LoginWindow};

pub const WINDOW_LABEL: &str = "chatgpt";
pub const WINDOW_TITLE: &str = "Sign in with ChatGPT";
pub const LOGIN_URL: &str = "https://chatgpt.com/auth/login";
pub const HOME_URL: &str = "https://chatgpt.com/";

/// chatgpt.com/auth/login starts on a landing screen; the form lives on
/// auth.openai.com, which offers a mailed code in place of the password.
pub const PHONE_FORM: PhoneForm<'static> = PhoneForm {
    code_needs_focus: false,
    entry_text: "",
    entry: "button[data-testid=\"login-button\"]",
    code_switch: "one-time code|c[oó]digo|codice",
    phone_switch: "continue with phone|continuar com (telefone|celular)|continua con (il )?(telefono|cellulare)|continuar con (tel[eé]fono|m[oó]vil)",
    code_inputs: "",
};

pub const SPEC: LoginWindow = LoginWindow {
    label: WINDOW_LABEL,
    title: WINDOW_TITLE,
    login_url: LOGIN_URL,
};

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(75);

/// Injected into every page of the login window. Polls the session endpoint
/// until the user finishes signing in, then hands the token back to Rust.
pub const LOGIN_SCRIPT: &str = r#"
(() => {
  if (window.top !== window.self) return;
  let reported = false;

  const report = (obj) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    window.location.href = 'tauri-voice://chatgpt-session#' + btoa(bin);
  };

  // Pull a display name out of whatever shape an endpoint returns.
  const pickName = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of ['name', 'full_name', 'display_name', 'nickname']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const parts = [obj.first_name || obj.given_name, obj.last_name || obj.family_name]
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim());
    return parts.join(' ');
  };

  // `/api/auth/session` often returns `user.name` empty. The account profile
  // endpoint is the reliable source, and we are already same-origin and signed
  // in, so it costs one request.
  const profileName = async (token) => {
    try {
      const res = await fetch('/backend-api/me', {
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
      });
      if (!res.ok) return '';
      const data = await res.json();
      return pickName(data) || pickName(data && data.account) || pickName(data && data.user);
    } catch (_) {
      return '';
    }
  };

  const probe = async () => {
    if (reported) return;
    try {
      const res = await fetch('/api/auth/session', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.accessToken) {
          reported = true;
          const user = data.user || {};
          // Never let the name lookup hold the login hostage: report without
          // it rather than hang on a slow or changed endpoint.
          let name = pickName(user);
          if (!name) {
            name = await Promise.race([
              profileName(data.accessToken),
              new Promise((resolve) => setTimeout(() => resolve(''), 2500)),
            ]);
          }
          report({
            accessToken: data.accessToken,
            email: user.email || user.name || 'chatgpt-account',
            name: name || '',
          });
          return;
        }
      }
    } catch (_) {}
    setTimeout(probe, 1500);
  };

  setTimeout(probe, 700);
})();
"#;

/// Runs inside the hidden chatgpt.com window to proxy a voice SDP offer.
/// `__RVP_*__` placeholders are replaced with JSON-encoded JS string literals.
const BRIDGE_TEMPLATE: &str = r#"
(async () => {
  const id = __RVP_ID__;
  const session = __RVP_SESSION__;
  const offerSdp = __RVP_SDP__;
  const deviceId = __RVP_DEVICE__;

  const done = (obj) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    window.location.href = 'tauri-voice://wm-result#' + id + ':' + btoa(bin);
  };

  try {
    const sessionRes = await fetch('/api/auth/session', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!sessionRes.ok) throw new Error('session endpoint status ' + sessionRes.status);
    const sessionData = await sessionRes.json();
    const token = sessionData && sessionData.accessToken;
    if (!token) throw new Error('not signed in to ChatGPT');

    const form = new FormData();
    form.append('sdp', offerSdp);
    form.append('session', session);

    const headers = { authorization: 'Bearer ' + token };
    if (deviceId) headers['oai-device-id'] = deviceId;

    const res = await fetch('/realtime/wm?dcid=0', {
      method: 'POST',
      headers,
      body: form,
      credentials: 'include',
    });
    const text = await res.text();
    if (!res.ok || !text.trim().startsWith('v=0')) {
      throw new Error('realtime/wm status ' + res.status + ' ' + text.slice(0, 300));
    }
    done({ ok: true, answerSdp: text, headers: Object.fromEntries(res.headers.entries()) });
  } catch (err) {
    done({ ok: false, error: String((err && err.message) || err) });
  }
})();
"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPayload {
    pub access_token: String,
    #[serde(default)]
    pub email: String,
    /// Display name from the session payload (`user.name`).
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResult {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    answer_sdp: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

/// `tauri-voice://chatgpt-session#<base64(json)>`
pub fn decode_login_payload(url: &tauri::Url) -> Option<LoginPayload> {
    if url.host_str()? != "chatgpt-session" {
        return None;
    }
    web_login::decode_base64_json::<LoginPayload>(url.fragment()?)
}

/// `tauri-voice://wm-result#<id>:<base64(json)>`
pub fn decode_bridge_result(url: &tauri::Url) -> Option<(String, Result<String, String>)> {
    if url.host_str()? != "wm-result" {
        return None;
    }
    let fragment = url.fragment()?;
    let (id, encoded) = fragment.split_once(':')?;
    let parsed: BridgeResult = web_login::decode_base64_json(encoded)?;
    if parsed.ok && !parsed.answer_sdp.is_empty() {
        if !parsed.headers.is_empty() {
            // Diagnostic only, see the matching note in gateway.rs::post_offer.
            let dump = parsed
                .headers
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(", ");
            crate::logging::log(
                "gateway",
                &format!("realtime/wm bridge response headers: {dump}"),
            );
        }
        Some((id.to_string(), Ok(parsed.answer_sdp)))
    } else {
        let message = if parsed.error.is_empty() {
            "bridge returned an unknown error".to_string()
        } else {
            parsed.error
        };
        Some((id.to_string(), Err(message)))
    }
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

pub fn build_bridge_script(
    id: &str,
    session_json: &str,
    offer_sdp: &str,
    device_id: &str,
) -> String {
    BRIDGE_TEMPLATE
        .replace("__RVP_ID__", &js_string(id))
        .replace("__RVP_SESSION__", &js_string(session_json))
        .replace("__RVP_SDP__", &js_string(offer_sdp))
        .replace("__RVP_DEVICE__", &js_string(device_id))
}

/// Correlates an outbound bridge request with its navigation-based reply.
#[derive(Default)]
pub struct Bridge {
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<String, String>>>>,
}

impl Bridge {
    pub(crate) fn register(
        &self,
        id: &str,
    ) -> tokio::sync::oneshot::Receiver<Result<String, String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(id.to_string(), tx);
        }
        rx
    }

    pub fn resolve(&self, id: &str, result: Result<String, String>) {
        if let Ok(mut map) = self.pending.lock() {
            if let Some(tx) = map.remove(id) {
                let _ = tx.send(result);
            }
        }
    }

    pub(crate) fn cancel(&self, id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(id);
        }
    }
}

/// The account this backend's injected script reported, if this url is its
/// session callback.
pub fn account_from(url: &tauri::Url) -> Option<Result<crate::accounts::Account, String>> {
    let payload = decode_login_payload(url)?;
    let email = if payload.email.trim().is_empty() {
        "chatgpt-account".to_string()
    } else {
        payload.email
    };
    Some(Ok(crate::accounts::Account::chatgpt(
        email,
        payload.name,
        payload.access_token,
    )))
}

/// The bridge's reply to a request this window made on our behalf.
pub fn resolve_bridge_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    match decode_bridge_result(url) {
        Some((id, result)) => {
            app.state::<crate::AppState>().bridge.resolve(&id, result);
            true
        }
        None => false,
    }
}

/// Ask the hidden chatgpt.com window to post an SDP offer to `/realtime/wm`.
pub async fn bridge_create_session(
    app: &AppHandle,
    bridge: &Bridge,
    session_json: &str,
    offer_sdp: &str,
    device_id: &str,
) -> Result<String, String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "ChatGPT login window is not open".to_string())?;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let rx = bridge.register(&id);
    let script = build_bridge_script(&id, session_json, offer_sdp, device_id);
    window.eval(&script).map_err(|e| e.to_string())?;

    match tokio::time::timeout(BRIDGE_TIMEOUT, rx).await {
        Ok(Ok(Ok(answer))) => Ok(answer),
        Ok(Ok(Err(message))) => Err(message),
        Ok(Err(_)) => Err("ChatGPT bridge channel closed unexpectedly".to_string()),
        Err(_) => {
            bridge.cancel(&id);
            Err("ChatGPT bridge timed out waiting for the voice session".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(value: &str) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(value)
    }

    fn url(raw: &str) -> tauri::Url {
        raw.parse().unwrap()
    }

    #[test]
    fn decodes_login_payload() {
        let payload = serde_json::json!({ "accessToken": "tok123", "email": "a@b.com" });
        let link = format!(
            "tauri-voice://chatgpt-session#{}",
            b64(&payload.to_string())
        );
        let decoded = decode_login_payload(&url(&link)).unwrap();
        assert_eq!(decoded.access_token, "tok123");
        assert_eq!(decoded.email, "a@b.com");
    }

    #[test]
    fn ignores_other_hosts() {
        let link = "tauri-voice://something-else#x";
        assert!(decode_login_payload(&url(link)).is_none());
    }

    #[test]
    fn decodes_bridge_success() {
        let payload = serde_json::json!({ "ok": true, "answerSdp": "v=0\r\n" });
        let link = format!("tauri-voice://wm-result#req1:{}", b64(&payload.to_string()));
        let (id, result) = decode_bridge_result(&url(&link)).unwrap();
        assert_eq!(id, "req1");
        assert_eq!(result.unwrap(), "v=0\r\n");
    }

    #[test]
    fn decodes_bridge_error() {
        let payload = serde_json::json!({ "ok": false, "error": "not signed in" });
        let link = format!("tauri-voice://wm-result#req2:{}", b64(&payload.to_string()));
        let (id, result) = decode_bridge_result(&url(&link)).unwrap();
        assert_eq!(id, "req2");
        assert_eq!(result.unwrap_err(), "not signed in");
    }

    #[test]
    fn bridge_script_embeds_json_escaped_values() {
        let script = build_bridge_script("id\"1", "line1\nline2", "v=0\r\n", "dev");
        assert!(!script.contains("__RVP_"));
        assert!(script.contains(r#"const id = "id\"1";"#));
        assert!(script.contains(r#"\n"#));
    }

    #[test]
    fn bridge_resolve_delivers_to_waiter() {
        let bridge = Bridge::default();
        let rx = bridge.register("abc");
        bridge.resolve("abc", Ok("v=0".to_string()));
        assert_eq!(rx.blocking_recv().unwrap().unwrap(), "v=0");
    }
}
