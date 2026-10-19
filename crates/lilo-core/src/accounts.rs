use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

fn default_status() -> String {
    "ok".to_string()
}

/// Provider ids shared with the frontend (`ProviderId`).
pub const PROVIDER_CHATGPT: &str = "chatgpt-web";
pub const PROVIDER_CLAUDE: &str = "claude-web";
pub const PROVIDER_GROK: &str = "grok-web";

fn default_provider() -> String {
    PROVIDER_CHATGPT.to_string()
}

/// Decode a JWT payload without verifying the signature. Used only for display
/// (name, e-mail, expiry) — never for a trust decision.
fn jwt_claims(token: &str) -> Option<serde_json::Value> {
    use base64::Engine as _;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(payload))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// `exp` (unix seconds) of a token, for refresh decisions.
pub fn token_expiry(token: &str) -> Option<i64> {
    jwt_exp(token)
}

/// The subscription the token was issued for (`free`, `plus`, `pro`, …).
/// ChatGPT puts it under the namespaced auth claim; it only labels the
/// account, the voice budget itself always comes from the server.
fn jwt_plan(token: &str) -> Option<String> {
    let claims = jwt_claims(token)?;
    claim_str(&claims, &["chatgpt_plan_type", "plan_type"]).map(|plan| plan.to_lowercase())
}

/// `exp` (unix seconds), to warn the user before the web session expires.
fn jwt_exp(token: &str) -> Option<i64> {
    jwt_claims(token)?
        .get("exp")
        .and_then(serde_json::Value::as_i64)
}

/// Look a claim up at the top level, then one level down inside object claims.
///
/// ChatGPT namespaces most of what we want under keys like
/// `https://api.openai.com/profile`, and which of them carries the name varies
/// between token versions — so search rather than hard-code a path.
fn claim_str(claims: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let pick = |object: &serde_json::Value| -> Option<String> {
        keys.iter().find_map(|key| {
            object
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
    };

    if let Some(found) = pick(claims) {
        return Some(found);
    }
    claims
        .as_object()?
        .values()
        .filter(|value| value.is_object())
        .find_map(pick)
}

/// Display name carried by the token. The `/api/auth/session` payload does not
/// always include `user.name` — and a pasted-token or phone login never sees
/// that payload at all — but the access token itself usually carries it.
fn jwt_name(token: &str) -> Option<String> {
    let claims = jwt_claims(token)?;
    if let Some(name) = claim_str(&claims, &["name", "nickname", "preferred_username"]) {
        return Some(name);
    }
    // Some tokens only carry the parts.
    let given = claim_str(&claims, &["given_name"]);
    let family = claim_str(&claims, &["family_name"]);
    match (given, family) {
        (Some(given), Some(family)) => Some(format!("{given} {family}")),
        (Some(given), None) => Some(given),
        (None, Some(family)) => Some(family),
        (None, None) => None,
    }
}

/// What a pasted ChatGPT session yields.
///
/// The display name lives in the session *envelope* (`user.name`), not in the
/// access token — the JWT only carries the e-mail, under a namespaced profile
/// claim. Every paste path has to read the envelope or the name is lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPaste {
    pub access_token: String,
    pub email: String,
    pub name: String,
}

/// Parse what a user pastes during sign-in: either the whole session object
/// from `/api/auth/session`, or a bare `eyJ…` access token.
///
/// Tolerant by design — the paste comes from a human copying a browser tab.
pub fn parse_session_paste(raw: &str) -> Option<SessionPaste> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    // A bare JWT: no envelope, so the name can only come from the token.
    if !raw.starts_with('{') {
        let looks_like_jwt = raw.starts_with("eyJ") && raw.split('.').count() == 3;
        if !looks_like_jwt {
            return None;
        }
        let claims = jwt_claims(raw);
        return Some(SessionPaste {
            email: claims
                .as_ref()
                .and_then(|c| claim_str(c, &["email"]))
                .unwrap_or_default(),
            name: jwt_name(raw).unwrap_or_default(),
            access_token: raw.to_string(),
        });
    }

    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let token = value
        .get("accessToken")
        .or_else(|| value.get("access_token"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())?;

    let user = value.get("user");
    let from_user = |key: &str| {
        user.and_then(|u| u.get(key))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };

    let email = from_user("email")
        .or_else(|| {
            value
                .get("email")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            jwt_claims(token)
                .as_ref()
                .and_then(|c| claim_str(c, &["email"]))
        })
        .unwrap_or_default();

    let name = from_user("name")
        .or_else(|| {
            let given = from_user("given_name").or_else(|| from_user("first_name"));
            let family = from_user("family_name").or_else(|| from_user("last_name"));
            match (given, family) {
                (Some(g), Some(f)) => Some(format!("{g} {f}")),
                (Some(g), None) => Some(g),
                (None, Some(f)) => Some(f),
                (None, None) => None,
            }
        })
        .or_else(|| jwt_name(token))
        .unwrap_or_default();

    Some(SessionPaste {
        access_token: token.to_string(),
        email,
        name,
    })
}

/// The credential contract is independent of a vendor's provider id.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountAuthentication {
    #[default]
    Bearer,
    WebSession,
}

/// A single web account, serialized in the existing snake_case disk format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    #[serde(default)]
    pub authentication: AccountAuthentication,
    pub email: String,
    /// Display name from the provider; may be empty.
    #[serde(default)]
    pub name: String,
    /// ChatGPT only: the web access token.
    #[serde(default)]
    pub access_token: String,
    /// Which backend this account belongs to. Files written before this field
    /// existed are ChatGPT accounts.
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Claude only: the organization UUID that scopes every claude.ai request.
    /// Claude has no bearer token — the webview keeps the session cookie.
    #[serde(default)]
    pub org: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub proxy: String,
    #[serde(default = "default_status")]
    pub status: String,
    /// ChatGPT only: the web session cookie (`__Secure-next-auth.session-token`,
    /// HttpOnly). What the browser would use to fetch a fresh access token;
    /// kept here so the token can be refreshed over plain HTTP, with no
    /// webview — which is what makes a browserless mode possible on the Pi.
    #[serde(default)]
    pub session_cookie: String,
    /// Claude only: the plan claude.ai reported at sign-in (`free`, `pro`,
    /// `max`, …). ChatGPT's travels in its token, so it is never stored.
    #[serde(default)]
    pub plan: String,
}

impl Account {
    /// A confirmed web session; credentials remain with the owning transport.
    pub fn web_session(provider: impl Into<String>, marker: impl Into<String>) -> Self {
        let mut account = Self::chatgpt(marker, "", "");
        account.provider = provider.into();
        account.authentication = AccountAuthentication::WebSession;
        account
    }

    /// A local marker; Grok credentials and identity stay in its webview.
    pub fn grok() -> Self {
        let mut account = Self::chatgpt("grok-account", "", "");
        account.provider = PROVIDER_GROK.to_string();
        account
    }
    /// A ChatGPT web account.
    pub fn chatgpt(
        email: impl Into<String>,
        name: impl Into<String>,
        access_token: impl Into<String>,
    ) -> Self {
        Self {
            authentication: AccountAuthentication::Bearer,
            email: email.into(),
            name: name.into(),
            access_token: access_token.into(),
            provider: PROVIDER_CHATGPT.to_string(),
            org: String::new(),
            device_id: String::new(),
            proxy: String::new(),
            status: "ok".to_string(),
            session_cookie: String::new(),
            plan: String::new(),
        }
    }

    /// A Claude web account: the session cookie lives in the webview, so the
    /// only things stored here are the identity and the organization.
    pub fn claude(
        email: impl Into<String>,
        name: impl Into<String>,
        org: impl Into<String>,
    ) -> Self {
        Self {
            authentication: AccountAuthentication::Bearer,
            email: email.into(),
            name: name.into(),
            access_token: String::new(),
            provider: PROVIDER_CLAUDE.to_string(),
            org: org.into(),
            device_id: String::new(),
            proxy: String::new(),
            status: "ok".to_string(),
            session_cookie: String::new(),
            plan: String::new(),
        }
    }

    pub fn normalize(mut self) -> Self {
        if self.device_id.trim().is_empty() {
            self.device_id = uuid::Uuid::new_v4().to_string();
        }
        if self.status.trim().is_empty() {
            self.status = "ok".to_string();
        }
        if self.provider.trim().is_empty() {
            self.provider = default_provider();
        }
        self.email = self.email.trim().to_string();
        self.name = self.name.trim().to_string();
        self.access_token = self.access_token.trim().to_string();
        self.provider = self.provider.trim().to_string();
        self.org = self.org.trim().to_string();
        self.session_cookie = self.session_cookie.trim().to_string();
        self.plan = self.plan.trim().to_lowercase();
        self
    }
}

/// Safe projection sent to the frontend — never contains the access token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub email: String,
    pub name: String,
    /// Which backend this account belongs to (see `PROVIDER_*`).
    pub provider: String,
    /// Claude only: organization UUID.
    pub org: String,
    pub device_id: String,
    pub status: String,
    pub proxy: String,
    pub has_token: bool,
    /// Unix seconds when the access token expires (from the JWT `exp`).
    pub expires_at: Option<i64>,
    /// The subscription, lowercase, when the provider says which one.
    pub plan: Option<String>,
}

impl From<&Account> for AccountView {
    fn from(a: &Account) -> Self {
        let name = if a.name.trim().is_empty() {
            jwt_name(&a.access_token).unwrap_or_default()
        } else {
            a.name.clone()
        };
        AccountView {
            email: a.email.clone(),
            name,
            provider: a.provider.clone(),
            org: a.org.clone(),
            device_id: a.device_id.clone(),
            status: a.status.clone(),
            proxy: a.proxy.clone(),
            has_token: !a.access_token.is_empty(),
            expires_at: jwt_exp(&a.access_token),
            plan: jwt_plan(&a.access_token)
                .or_else(|| Some(a.plan.clone()).filter(|plan| !plan.is_empty())),
        }
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct AccountsFile {
    #[serde(default)]
    accounts: Vec<Account>,
}

/// Thread-safe account pool persisted to disk. LILO deliberately does not
/// pool many accounts — but the structure supports it, and never shares tokens.
pub struct AccountStore {
    path: PathBuf,
    accounts: Mutex<Vec<Account>>,
}

impl AccountStore {
    pub fn load(path: PathBuf) -> Self {
        let accounts = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<AccountsFile>(&raw).ok())
            .map(|f| f.accounts)
            .unwrap_or_default();
        Self {
            path,
            accounts: Mutex::new(accounts),
        }
    }

    fn persist_locked(&self, accounts: &[Account]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = AccountsFile {
            accounts: accounts.to_vec(),
        };
        let raw = serde_json::to_string_pretty(&file)?;
        std::fs::write(&self.path, raw)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<AccountView> {
        self.accounts
            .lock()
            .map(|guard| guard.iter().map(AccountView::from).collect())
            .unwrap_or_default()
    }

    pub fn add(&self, account: Account) -> Result<()> {
        let mut account = account.normalize();
        if account.email.is_empty() {
            return Err(AppError::other("email is required"));
        }
        if account.provider == PROVIDER_CLAUDE {
            // No bearer token exists on this path: fail early when the captured
            // organization is missing, or every request would 404.
            if account.org.is_empty() {
                return Err(AppError::other("the Claude organization is required"));
            }
        } else if account.provider != PROVIDER_GROK
            && account.authentication != AccountAuthentication::WebSession
            && account.access_token.is_empty()
        {
            return Err(AppError::other("access token is required"));
        }
        let mut guard = self
            .accounts
            .lock()
            .map_err(|_| AppError::other("account store poisoned"))?;
        // A re-login that failed to read the display name must not erase one we
        // already have — refreshing the token is not a reason to lose the name.
        // Identity is (provider, email): the same address can be signed in to
        // both backends at once.
        if account.name.is_empty() {
            if let Some(previous) = guard
                .iter()
                .find(|a| a.email == account.email && a.provider == account.provider)
            {
                account.name = previous.name.clone();
            }
        }
        guard.retain(|a| !(a.email == account.email && a.provider == account.provider));
        // Most recently added account wins, so a re-login becomes the active one.
        guard.insert(0, account);
        self.persist_locked(&guard)
    }

    /// Fill in a display name captured later (e.g. from a profile refresh),
    /// without touching the token or status.
    pub fn set_name(&self, email: &str, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        if let Ok(mut guard) = self.accounts.lock() {
            let mut changed = false;
            for a in guard.iter_mut() {
                if a.email == email && a.name != name {
                    a.name = name.to_string();
                    changed = true;
                }
            }
            if changed {
                let _ = self.persist_locked(&guard);
            }
        }
    }

    pub fn remove(&self, provider: &str, email: &str) -> Result<bool> {
        let mut guard = self
            .accounts
            .lock()
            .map_err(|_| AppError::other("account store poisoned"))?;
        let before = guard.len();
        guard.retain(|a| !(a.email == email && a.provider == provider));
        let removed = guard.len() != before;
        if removed {
            self.persist_locked(&guard)?;
        }
        Ok(removed)
    }

    /// Remember the web session cookie, so the token can be refreshed later
    /// without a webview. An empty cookie is ignored: a failed capture must
    /// not erase the one that already works.
    pub fn set_session_cookie(&self, provider: &str, email: &str, cookie: &str) {
        let cookie = cookie.trim();
        if cookie.is_empty() {
            return;
        }
        if let Ok(mut guard) = self.accounts.lock() {
            let mut changed = false;
            for account in guard.iter_mut() {
                if account.provider == provider
                    && account.email == email
                    && account.session_cookie != cookie
                {
                    account.session_cookie = cookie.to_string();
                    changed = true;
                }
            }
            if changed {
                let _ = self.persist_locked(&guard);
            }
        }
    }

    pub fn mark_invalid(&self, access_token: &str) {
        if let Ok(mut guard) = self.accounts.lock() {
            let mut changed = false;
            for a in guard.iter_mut() {
                if a.access_token == access_token && a.status != "invalid" {
                    a.status = "invalid".to_string();
                    changed = true;
                }
            }
            if changed {
                let _ = self.persist_locked(&guard);
            }
        }
    }

    /// Pick the preferred account for a backend, else the first healthy one.
    pub fn pick(&self, provider: &str, preferred: Option<&str>) -> Option<Account> {
        let guard = self.accounts.lock().ok()?;
        let healthy = || {
            guard
                .iter()
                .filter(|a| a.provider == provider && a.status == "ok")
        };
        if let Some(pref) = preferred {
            if let Some(a) = healthy().find(|a| a.access_token == pref) {
                return Some(a.clone());
            }
        }
        healthy().next().cloned()
    }

    pub fn get_by_token(&self, token: &str) -> Option<Account> {
        let guard = self.accounts.lock().ok()?;
        guard.iter().find(|a| a.access_token == token).cloned()
    }

    /// Return only the exact healthy account selected by the caller.
    /// Unlike `pick`, this never falls back to another account for a provider.
    pub fn get_by_identity(&self, provider: &str, email: &str) -> Option<Account> {
        let guard = self.accounts.lock().ok()?;
        guard
            .iter()
            .find(|account| {
                account.provider == provider && account.email == email && account.status == "ok"
            })
            .cloned()
    }

    /// The first account for a backend, whatever its status.
    ///
    /// `pick` deliberately hides an invalidated account from voice; this one
    /// answers "has this backend ever signed in?" — which is what decides
    /// whether its hidden transport window is restored at startup. That window
    /// is also what turns a dead token back into a fresh one.
    pub fn first(&self, provider: &str) -> Option<Account> {
        let guard = self.accounts.lock().ok()?;
        guard.iter().find(|a| a.provider == provider).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_account_stores_only_a_local_session_marker() {
        let path = tmp_path("grok-marker");
        let store = AccountStore::load(path.clone());
        store.add(Account::grok()).unwrap();
        let account = store.pick("grok-web", None).unwrap();
        assert_eq!(account.email, "grok-account");
        assert!(account.name.is_empty());
        assert!(account.access_token.is_empty());
        assert!(account.session_cookie.is_empty());
        assert!(account.org.is_empty());
        let _ = std::fs::remove_file(path);
    }
    use std::path::PathBuf;

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "rvp-accounts-{}-{}.json",
            name,
            uuid::Uuid::new_v4()
        ))
    }

    fn account(email: &str, token: &str) -> Account {
        Account::chatgpt(email, "", token)
    }

    #[test]
    fn add_normalizes_and_persists() {
        let path = tmp_path("add");
        let store = AccountStore::load(path.clone());
        store.add(account("a@b.com", " tok ")).unwrap();
        let views = store.list();
        assert_eq!(views.len(), 1);
        assert!(views[0].has_token);
        assert!(!views[0].device_id.is_empty());
        assert_eq!(views[0].status, "ok");
        assert!(views[0].expires_at.is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reads_the_plan_from_the_namespaced_auth_claim() {
        let token = token_with(serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_plan_type": "Plus" }
        }));
        let view = AccountView::from(&Account::chatgpt("a@b.c", "", token));
        assert_eq!(view.plan.as_deref(), Some("plus"));

        let mut claude = Account::claude("a@b.c", "", "org");
        assert_eq!(AccountView::from(&claude).plan, None);
        claude.plan = "max".into();
        assert_eq!(AccountView::from(&claude).plan.as_deref(), Some("max"));
    }

    #[test]
    fn reads_jwt_exp() {
        use base64::Engine as _;
        let payload = serde_json::json!({ "exp": 1_790_237_573_i64 });
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string());
        let token = format!("header.{enc}.sig");
        assert_eq!(jwt_exp(&token), Some(1_790_237_573));
        assert!(jwt_exp("not-a-jwt").is_none());
    }

    fn token_with(claims: serde_json::Value) -> String {
        use base64::Engine as _;
        let encode = |value: String| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value);
        // A real header, so the token starts with "eyJ" like any JWT does.
        let header = encode(r#"{"alg":"RS256","typ":"JWT"}"#.to_string());
        format!("{header}.{}.sig", encode(claims.to_string()))
    }

    #[test]
    fn name_comes_from_a_top_level_claim() {
        let token = token_with(serde_json::json!({ "name": "Ada Lovelace" }));
        assert_eq!(jwt_name(&token).as_deref(), Some("Ada Lovelace"));
    }

    #[test]
    fn name_comes_from_a_namespaced_claim() {
        // ChatGPT namespaces profile fields under a URL-shaped key, and which
        // one carries the name varies between token versions.
        let token = token_with(serde_json::json!({
            "https://api.openai.com/profile": {
                "email": "a@b.com",
                "name": "Ada Lovelace"
            }
        }));
        assert_eq!(jwt_name(&token).as_deref(), Some("Ada Lovelace"));
    }

    #[test]
    fn name_falls_back_to_the_given_and_family_parts() {
        let token = token_with(serde_json::json!({
            "given_name": "Ada",
            "family_name": "Lovelace"
        }));
        assert_eq!(jwt_name(&token).as_deref(), Some("Ada Lovelace"));

        let partial = token_with(serde_json::json!({ "given_name": "Ada" }));
        assert_eq!(jwt_name(&partial).as_deref(), Some("Ada"));
    }

    #[test]
    fn a_nameless_or_broken_token_yields_nothing() {
        assert_eq!(
            jwt_name(&token_with(serde_json::json!({ "sub": "x" }))),
            None
        );
        assert_eq!(jwt_name("not-a-jwt"), None);
        // Empty strings must not become a name made of whitespace.
        assert_eq!(
            jwt_name(&token_with(serde_json::json!({ "name": "  " }))),
            None
        );
    }

    #[test]
    fn the_view_uses_the_token_name_when_none_was_captured() {
        let path = tmp_path("tokenname");
        let store = AccountStore::load(path.clone());
        let token = token_with(serde_json::json!({ "name": "Ada Lovelace" }));
        store.add(account("a@b.com", &token)).unwrap();
        // Nothing stored the name — a pasted token never sees /api/auth/session.
        assert_eq!(store.list()[0].name, "Ada Lovelace");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_captured_name_still_wins_over_the_token() {
        let path = tmp_path("capturedname");
        let store = AccountStore::load(path.clone());
        let token = token_with(serde_json::json!({ "name": "Token Name" }));
        let mut acct = account("a@b.com", &token);
        acct.name = "Captured Name".to_string();
        store.add(acct).unwrap();
        assert_eq!(store.list()[0].name, "Captured Name");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn add_replaces_same_email() {
        let path = tmp_path("replace");
        let store = AccountStore::load(path.clone());
        store.add(account("a@b.com", "one")).unwrap();
        store.add(account("a@b.com", "two")).unwrap();
        assert_eq!(store.list().len(), 1);
        assert_eq!(
            store.pick(PROVIDER_CHATGPT, None).unwrap().access_token,
            "two"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_pasted_session_yields_token_email_and_name() {
        // Shape of what /api/auth/session returns, which is what users paste.
        let raw = r#"{
            "user": { "id": "user-x", "name": "Ada Lovelace", "email": "ada@b.com" },
            "expires": "2026-12-16T07:46:14.339Z",
            "accessToken": "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig",
            "authProvider": "openai"
        }"#;
        let parsed = parse_session_paste(raw).unwrap();
        assert_eq!(parsed.name, "Ada Lovelace");
        assert_eq!(parsed.email, "ada@b.com");
        assert!(parsed.access_token.starts_with("eyJ"));
    }

    #[test]
    fn a_pasted_session_falls_back_to_name_parts() {
        let raw = r#"{
            "user": { "given_name": "Ada", "family_name": "Lovelace", "email": "a@b.com" },
            "accessToken": "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig"
        }"#;
        assert_eq!(parse_session_paste(raw).unwrap().name, "Ada Lovelace");
    }

    #[test]
    fn a_bare_jwt_is_still_accepted() {
        let token = token_with(serde_json::json!({
            "https://api.openai.com/profile": { "email": "ada@b.com" }
        }));
        let parsed = parse_session_paste(&format!("  {token}  ")).unwrap();
        assert_eq!(parsed.access_token, token);
        assert_eq!(parsed.email, "ada@b.com");
        assert_eq!(parsed.name, "", "a real token carries no name");
    }

    #[test]
    fn junk_and_tokenless_objects_are_rejected() {
        assert!(parse_session_paste("").is_none());
        assert!(parse_session_paste("hello there").is_none());
        assert!(parse_session_paste(r#"{"user":{"name":"Ada"}}"#).is_none());
        assert!(parse_session_paste("{not json").is_none());
    }

    #[test]
    fn re_login_without_a_name_keeps_the_one_we_had() {
        let path = tmp_path("keepname");
        let store = AccountStore::load(path.clone());
        let mut first = account("a@b.com", "one");
        first.name = "Ada Lovelace".to_string();
        store.add(first).unwrap();
        // A token refresh that could not read the profile.
        store.add(account("a@b.com", "two")).unwrap();
        assert_eq!(store.list()[0].name, "Ada Lovelace");
        assert_eq!(
            store.pick(PROVIDER_CHATGPT, None).unwrap().access_token,
            "two"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn mark_invalid_removes_from_pick() {
        let path = tmp_path("invalid");
        let store = AccountStore::load(path.clone());
        store.add(account("a@b.com", "tok")).unwrap();
        store.mark_invalid("tok");
        assert_eq!(store.list()[0].status, "invalid");
        assert!(store.pick(PROVIDER_CHATGPT, None).is_none());
        // The account is still there to be refreshed — `first` sees it even
        // though `pick` refuses to hand it to a voice session.
        assert_eq!(store.first(PROVIDER_CHATGPT).unwrap().email, "a@b.com");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn first_is_scoped_to_its_provider() {
        let path = tmp_path("first-provider");
        let store = AccountStore::load(path.clone());
        assert!(store.first(PROVIDER_CHATGPT).is_none());
        store
            .add(Account::claude("a@b.com", "Ada", "org-1"))
            .unwrap();
        assert!(store.first(PROVIDER_CHATGPT).is_none());
        assert_eq!(store.first(PROVIDER_CLAUDE).unwrap().email, "a@b.com");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_same_email_can_sit_on_both_providers() {
        let path = tmp_path("dual");
        let store = AccountStore::load(path.clone());
        store.add(account("a@b.com", "tok")).unwrap();
        store
            .add(Account::claude("a@b.com", "Ada", "org-1"))
            .unwrap();
        assert_eq!(store.list().len(), 2);
        assert_eq!(
            store.pick(PROVIDER_CHATGPT, None).unwrap().access_token,
            "tok"
        );
        let claude = store.pick(PROVIDER_CLAUDE, None).unwrap();
        assert_eq!(claude.org, "org-1");
        assert!(store.remove(PROVIDER_CLAUDE, "a@b.com").unwrap());
        assert_eq!(store.list().len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn get_by_identity_requires_the_exact_healthy_provider_account() {
        let path = tmp_path("exact-identity");
        let store = AccountStore::load(path.clone());
        store.add(account("a@b.com", "chat-token")).unwrap();
        store
            .add(Account::claude("a@b.com", "Ada", "org-1"))
            .unwrap();
        store.add(account("other@b.com", "other-token")).unwrap();

        assert_eq!(
            store
                .get_by_identity(PROVIDER_CHATGPT, "a@b.com")
                .unwrap()
                .access_token,
            "chat-token"
        );
        assert!(store
            .get_by_identity(PROVIDER_CLAUDE, "missing@b.com")
            .is_none());
        assert!(store.get_by_identity(PROVIDER_CHATGPT, "A@b.com").is_none());

        store.mark_invalid("chat-token");
        assert!(store.get_by_identity(PROVIDER_CHATGPT, "a@b.com").is_none());
        assert_eq!(
            store.pick(PROVIDER_CHATGPT, None).unwrap().email,
            "other@b.com"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_claude_account_needs_an_organization() {
        let path = tmp_path("claude-org");
        let store = AccountStore::load(path.clone());
        assert!(store.add(Account::claude("a@b.com", "Ada", "")).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn files_without_a_provider_are_chatgpt_accounts() {
        let raw = r#"{"accounts":[{"email":"a@b.com","access_token":"tok"}]}"#;
        let file: AccountsFile = serde_json::from_str(raw).unwrap();
        assert_eq!(file.accounts[0].provider, PROVIDER_CHATGPT);
        assert!(file.accounts[0].org.is_empty());
    }

    #[test]
    fn remove_works() {
        let path = tmp_path("remove");
        let store = AccountStore::load(path.clone());
        store.add(account("a@b.com", "tok")).unwrap();
        assert!(store.remove(PROVIDER_CHATGPT, "a@b.com").unwrap());
        assert!(!store.remove(PROVIDER_CHATGPT, "a@b.com").unwrap());
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod web_session_tests {
    use super::*;
    #[test]
    fn test_web_session_account_does_not_require_exporting_a_bearer_token() {
        let path =
            std::env::temp_dir().join(format!("lilo-web-session-{}.json", std::process::id()));
        let store = AccountStore::load(path.clone());
        store
            .add(Account::web_session(
                "plugin:com.fixture.voice/web",
                "fixture-session",
            ))
            .unwrap();
        let view = store
            .list()
            .into_iter()
            .find(|account| account.provider == "plugin:com.fixture.voice/web")
            .unwrap();
        assert!(!view.has_token);
        assert_eq!(view.status, "ok");
        assert!(store
            .add(Account::chatgpt("fixture@example.invalid", "", ""))
            .is_err());
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
}
