//! Light access-token refresh for ChatGPT: plain HTTP, no browser.
//!
//! What chatgpt.com's own page does is a `GET /api/auth/session` carrying the
//! session cookie (`__Secure-next-auth.session-token`, HttpOnly). We repeat
//! exactly that GET from here, with the headers a browser would send: the new
//! token replaces the old one without opening any webview. That is what makes a
//! browserless mode possible — and what keeps the Pi inside its memory budget.
//!
//! The cookie is the long-lived credential; it comes from the sign-in window
//! (the only part that truly needs a browser) and lives in `accounts.json`.

use crate::accounts::{parse_session_paste, SessionPaste};
use crate::error::{AppError, Result};

/// The chatgpt.com session cookie. NextAuth may split it into `.0`, `.1`…, so
/// what we store is the whole `Cookie` header, ready to send back.
pub const SESSION_COOKIE_PREFIX: &str = "__Secure-next-auth.session-token";

/// The endpoint the page itself uses to read the session.
pub const SESSION_URL: &str = "https://chatgpt.com/api/auth/session";

/// Fetches a fresh token using the session cookie.
///
/// An invalid cookie answers `200 {}` (no `accessToken`) or 401/403; both cases
/// become the same error, because to the user they mean one thing: sign in
/// again.
pub async fn fetch_session(
    http: &reqwest::Client,
    cookie: &str,
    user_agent: &str,
) -> Result<SessionPaste> {
    let cookie = cookie.trim();
    if cookie.is_empty() {
        return Err(AppError::gateway("no session cookie stored — sign in once"));
    }
    let response = http
        .get(SESSION_URL)
        .header("accept", "application/json")
        .header("user-agent", user_agent)
        .header("origin", "https://chatgpt.com")
        .header("referer", "https://chatgpt.com/")
        .header("cookie", cookie)
        .send()
        .await
        .map_err(|error| AppError::gateway(format!("session refresh failed: {error}")))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(AppError::gateway(
            "the stored session is no longer valid — sign in again",
        ));
    }
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::gateway(format!(
            "session endpoint status {} body={}",
            status.as_u16(),
            body.chars().take(160).collect::<String>()
        )));
    }
    parse_session_paste(&body)
        .ok_or_else(|| AppError::gateway("the session endpoint returned no access token"))
}

/// Builds the `Cookie` header from `name=value` pairs (one per cookie —
/// NextAuth splits large sessions into `.0`, `.1`, …).
pub fn cookie_header(pairs: impl IntoIterator<Item = (String, String)>) -> String {
    pairs
        .into_iter()
        .filter(|(name, _)| name.starts_with(SESSION_COOKIE_PREFIX))
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_session_cookie_goes_into_the_header() {
        let pairs = vec![
            (
                "__Secure-next-auth.session-token".to_string(),
                "abc".to_string(),
            ),
            (
                "__Secure-next-auth.session-token.0".to_string(),
                "part0".to_string(),
            ),
            ("_cfuvid".to_string(), "nope".to_string()),
            ("oai-did".to_string(), "device".to_string()),
        ];
        assert_eq!(
            cookie_header(pairs),
            "__Secure-next-auth.session-token=abc; __Secure-next-auth.session-token.0=part0"
        );
    }

    #[test]
    fn an_empty_cookie_is_refused_before_any_request() {
        let http = reqwest::Client::new();
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_session(&http, "  ", "test-agent"))
            .unwrap_err();
        assert!(error.to_string().contains("sign in once"), "{error}");
    }
}
