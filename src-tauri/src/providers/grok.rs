//! Grok web login. Credentials stay in its cookie jar; only name and email reach LILO.
use crate::accounts;
use crate::providers::web_login::LoginWindow;

pub const WINDOW_LABEL: &str = "grok";
pub const HOME_URL: &str = "https://grok.com/";
pub const PHONE_FORM: super::phone_form::PhoneForm<'static> = super::phone_form::PhoneForm {
    code_needs_focus: true,
    entry: "",
    entry_text:
        "^((continue|login|log in|sign in) with e-?mail|continuar com (e-?mail|email)|entrar com (e-?mail|email)|continua con (e-?mail|email)|accedi con (e-?mail|email))$",
    code_switch: "^email sign-in code$",
    phone_switch: "",
    code_inputs: "",
};
pub const SPEC: LoginWindow = LoginWindow {
    label: WINDOW_LABEL,
    title: "Sign in with Grok",
    login_url: "https://grok.com/sign-in",
};
pub const LOGIN_SCRIPT: &str = include_str!("../../assets/grok-login.js");

pub fn account_from(url: &tauri::Url) -> Option<Result<accounts::Account, String>> {
    super::web_identity::account_from(url, "grok-session", "grok-web", "grok-account")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_login_maps_only_the_public_profile() {
        let url = "tauri-voice://grok-session#eyJuYW1lIjoiRml4dHVyZSBVc2VyIiwiZW1haWwiOiJmaXh0dXJlQGV4YW1wbGUuaW52YWxpZCJ9".parse().unwrap();
        let account = account_from(&url).unwrap().unwrap();
        assert_eq!(account.name, "Fixture User");
        assert_eq!(account.email, "fixture@example.invalid");
        assert!(account.access_token.is_empty());
    }

    #[test]
    fn login_callback_uses_a_local_marker_and_rejects_other_hosts() {
        let account = account_from(&"tauri-voice://grok-session#ready".parse().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(account.provider, "grok-web");
        assert_eq!(account.email, "grok-account");
        assert!(account.access_token.is_empty());
        assert!(account_from(&"tauri-voice://claude-session#ready".parse().unwrap()).is_none());
        assert!(account_from(&"tauri-voice://grok-session#no".parse().unwrap()).is_none());
    }
}
