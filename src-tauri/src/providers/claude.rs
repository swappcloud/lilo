//! Automatic "Sign in with Claude" flow.
//!
//! Same idea as the ChatGPT path, with one important difference: claude.ai
//! keeps its session in HttpOnly cookies, so there is no token to read and
//! nothing secret ever reaches Rust. The injected script only reports what the
//! frontend needs — the organization UUID and a display identity — after the
//! cookie-backed endpoints answer from the same origin.
//!
//! The window is kept hidden afterwards: the voice WebSocket must run on the
//! claude.ai origin (cookies + Cloudflare clearance), so this is the window the
//! future voice bridge will use.

use serde::Deserialize;

use crate::providers::phone_form::PhoneForm;
use crate::providers::web_login::{self, LoginWindow};

pub const WINDOW_LABEL: &str = "claude";
pub const WINDOW_TITLE: &str = "Sign in with Claude";
pub const LOGIN_URL: &str = "https://claude.ai/login";
pub const HOME_URL: &str = "https://claude.ai/";

/// claude.ai/login opens on the e-mail field and always mails a code.
pub const PHONE_FORM: PhoneForm<'static> = PhoneForm {
    code_needs_focus: false,
    entry_text: "",
    entry: "",
    code_switch: "",
    phone_switch: "",
    code_inputs: "",
};

pub const SPEC: LoginWindow = LoginWindow {
    label: WINDOW_LABEL,
    title: WINDOW_TITLE,
    login_url: LOGIN_URL,
};

/// Injected into every page of the Claude window. `lastActiveOrg` is a normal
/// cookie (the web app itself reads it), so its presence marks a signed-in
/// session; the account endpoints then fill in the identity, tolerantly.
pub const LOGIN_SCRIPT: &str = r#"
(() => {
  if (window.top !== window.self) return;
  let reported = false;

  const report = (obj) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    window.location.href = 'tauri-voice://claude-session#' + btoa(bin);
  };

  const cookie = (name) => {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  };

  const pick = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  // The organization says what the subscription is, in words that have
  // changed over time: a tier string or a list of capabilities. Anything
  // unrecognized stays unknown rather than guessed.
  const planOf = (org) => {
    const tier = typeof org.rate_limit_tier === 'string' ? org.rate_limit_tier.toLowerCase() : '';
    const caps = Array.isArray(org.capabilities) ? org.capabilities.map(String) : [];
    const has = (word) => tier.includes(word) || caps.some((c) => c.includes(word));
    if (has('max')) return 'max';
    if (has('enterprise')) return 'enterprise';
    if (has('raven') || has('team')) return 'team';
    if (has('pro')) return 'pro';
    if (tier || caps.length) return 'free';
    return '';
  };

  const identity = async () => {
    let email = '';
    let name = '';
    let plan = '';
    try {
      const res = await fetch('/api/account', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        email = pick(data, ['email_address', 'email', 'emailAddress']);
        name = pick(data, ['full_name', 'name', 'display_name']);
      }
    } catch (_) {}
    {
      try {
        const res = await fetch('/api/organizations', {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data) ? data : (data && data.organizations) || [];
          const org = cookie('lastActiveOrg');
          const hit = list.find((o) => o && (o.uuid === org || o.id === org)) || list[0] || {};
          name = name || pick(hit, ['name', 'display_name']);
          email = email || pick(hit, ['email_address', 'email']);
          plan = planOf(hit);
        }
      } catch (_) {}
    }
    return { email, name, plan };
  };

  const probe = async () => {
    if (reported) return;
    const org = cookie('lastActiveOrg');
    if (org) {
      reported = true;
      const { email, name, plan } = await identity();
      report({ orgUuid: org, email: email || 'claude-account', name, plan });
      return;
    }
    setTimeout(probe, 1500);
  };

  setTimeout(probe, 700);
})();
"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPayload {
    /// The organization that scopes every claude.ai API path.
    pub org_uuid: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    /// `free`, `pro`, `max`, `team`, `enterprise`, or empty when unknown.
    #[serde(default)]
    pub plan: String,
}

/// `tauri-voice://claude-session#<base64(json)>`
pub fn decode_login_payload(url: &tauri::Url) -> Option<LoginPayload> {
    if url.host_str()? != "claude-session" {
        return None;
    }
    web_login::decode_base64_json::<LoginPayload>(url.fragment()?)
}

/// The account this backend's injected script reported, if this url is its
/// session callback.
pub fn account_from(url: &tauri::Url) -> Option<Result<crate::accounts::Account, String>> {
    let payload = decode_login_payload(url)?;
    let email = if payload.email.trim().is_empty() {
        "claude-account".to_string()
    } else {
        payload.email
    };
    let mut account = crate::accounts::Account::claude(email, payload.name, payload.org_uuid);
    account.plan = payload.plan;
    Some(Ok(account))
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
        let payload = serde_json::json!({ "orgUuid": "org-1", "email": "a@b.com", "name": "Ada" });
        let link = format!("tauri-voice://claude-session#{}", b64(&payload.to_string()));
        let decoded = decode_login_payload(&url(&link)).unwrap();
        assert_eq!(decoded.org_uuid, "org-1");
        assert_eq!(decoded.email, "a@b.com");
        assert_eq!(decoded.name, "Ada");
    }

    #[test]
    fn ignores_other_hosts() {
        assert!(decode_login_payload(&url("tauri-voice://wm-result#x")).is_none());
    }
}
