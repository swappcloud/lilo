//! Bounded display identity for cookie-owned web sessions; no credentials.
use crate::accounts::Account;

#[derive(serde::Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Profile {
    name: String,
    email: String,
}

pub fn account_from(
    url: &tauri::Url,
    host: &str,
    provider: &str,
    marker: &str,
) -> Option<Result<Account, String>> {
    if url.scheme() != "tauri-voice" || url.host_str()? != host {
        return None;
    }
    let fragment = url.fragment()?;
    let profile = if fragment == "ready" {
        Profile::default()
    } else {
        if fragment.len() > 2048 {
            return None;
        }
        super::web_login::decode_base64_json::<Profile>(fragment)?
    };
    if [&profile.name, &profile.email]
        .iter()
        .any(|value| value.len() > 320 || value.chars().any(char::is_control))
    {
        return Some(Err("Invalid provider profile".into()));
    }
    let email = profile.email.trim();
    let mut account = Account::web_session(provider, if email.is_empty() { marker } else { email });
    account.name = profile.name.trim().to_string();
    Some(Ok(account))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn test_profile_rejects_foreign_callbacks_and_credential_fields() {
        let profile = STANDARD.encode(r#"{"name":"Fixture","email":"fixture@example.invalid"}"#);
        let foreign = format!("https://qwen-session#{profile}").parse().unwrap();
        assert!(account_from(&foreign, "qwen-session", "qwen-web", "qwen-account").is_none());
        let credentials =
            STANDARD.encode(r#"{"name":"Fixture","access_token":"fixture-private-token"}"#);
        let url = format!("tauri-voice://qwen-session#{credentials}")
            .parse()
            .unwrap();
        assert!(account_from(&url, "qwen-session", "qwen-web", "qwen-account").is_none());
    }
}
