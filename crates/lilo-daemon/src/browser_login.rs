//! Private HTTP adapter for the optional browser-host application port.

use anyhow::{ensure, Context};
use lilo_core::accounts::{Account, AccountStore, PROVIDER_CHATGPT};
use serde_json::{json, Value};
use std::path::Path;

pub struct BrowserLogin {
    pub broker: crate::broker::BrokerClient,
    key: String,
    pub providers: Vec<String>,
    saved: Option<String>,
}

impl BrowserLogin {
    pub async fn connect(endpoint: &str, token_file: &Path, key: &str) -> anyhow::Result<Self> {
        let mut login = Self {
            broker: crate::broker::BrokerClient::connect(endpoint, token_file)?,
            key: key.into(),
            providers: Vec::new(),
            saved: None,
        };
        let capabilities = login.broker.get("/capabilities").await?;
        // Only registered account decoders can claim daemon sign-in support.
        login.providers = capabilities
            .get("providers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| *id == PROVIDER_CHATGPT)
            .map(str::to_owned)
            .collect();
        ensure!(
            !login.providers.is_empty(),
            "Browser host has no supported provider."
        );
        Ok(login)
    }

    pub async fn exchange(
        &mut self,
        payload: Value,
        accounts: &AccountStore,
        data_dir: &Path,
    ) -> anyhow::Result<Value> {
        let result = self
            .broker
            .post("/exchange", &json!({"key": self.key, "payload": payload}))
            .await?;
        if let Some(captured) = result.get("account").filter(|value| !value.is_null()) {
            let account = decode_account(captured)?;
            let fingerprint = format!("{}:{}", account.email, account.access_token);
            if self.saved.as_ref() != Some(&fingerprint) {
                // Create private storage before the shared store writes credentials.
                let path = data_dir.join("accounts.json");
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create(true).truncate(false);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
                    options.mode(0o600);
                    if path.exists() {
                        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
                    }
                }
                options.open(path)?;
                accounts.add(account)?;
                self.saved = Some(fingerprint);
            }
        }
        // The private account envelope never crosses the management boundary.
        result
            .get("payload")
            .cloned()
            .context("Missing encrypted browser response.")
    }

    pub async fn forget(&mut self, provider: &str, email: &str) -> anyhow::Result<()> {
        self.broker
            .post("/forget", &json!({"provider": provider, "email": email}))
            .await?;
        self.saved = None;
        Ok(())
    }
}

fn decode_account(value: &Value) -> anyhow::Result<Account> {
    ensure!(
        value.get("provider").and_then(Value::as_str) == Some(PROVIDER_CHATGPT),
        "Unsupported provider account."
    );
    let session = value.get("session").context("Missing provider session.")?;
    let parsed = lilo_core::accounts::parse_session_paste(&session.to_string())
        .context("Invalid provider session.")?;
    ensure!(
        !parsed.email.trim().is_empty()
            && parsed.email.len() <= 320
            && !parsed.access_token.is_empty()
            && parsed.access_token.len() <= 32768,
        "Incomplete provider session."
    );
    let mut account = Account::chatgpt(parsed.email, parsed.name, parsed.access_token);
    let cookie = value
        .get("sessionCookie")
        .and_then(Value::as_str)
        .unwrap_or("");
    ensure!(cookie.len() <= 65536, "Provider cookie is too large.");
    account.session_cookie = cookie.into();
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_capture_requires_a_supported_confirmed_session() {
        assert!(decode_account(
            &json!({"provider": "unsupported", "session": {"accessToken":"fixture"}})
        )
        .is_err());
        assert!(decode_account(
            &json!({"provider": PROVIDER_CHATGPT, "session": {"user":{}, "accessToken":"fixture"}})
        )
        .is_err());
        let account = decode_account(&json!({"provider": PROVIDER_CHATGPT, "session": {"user":{"email":"fixture.invalid","name":"Fixture"}, "accessToken":"fixture-private"}, "sessionCookie":"fixture-cookie"})).unwrap();
        assert_eq!(account.email, "fixture.invalid");
        assert_eq!(account.session_cookie, "fixture-cookie");
    }
}
