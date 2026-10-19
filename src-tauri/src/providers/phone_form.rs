//! Signing in from the phone, for any web backend.
//!
//! The PC's own login window does the signing in, out of sight; the phone only
//! answers what that page asks for — the e-mail, the code the backend mails,
//! a password when there is no other way. The page reports each question on
//! `tauri-voice://phone-form#<base64(json)>` and the phone helper relays the
//! answers back (`phonelogin.rs`).
//!
//! The form is filled in, not bypassed: the vendors' pages mint their own
//! client attestation (invisible captchas) on submit, which a direct call to
//! their login endpoints could not. The sign-in then ends exactly like a
//! desktop one — the backend's login script reports the account, and ChatGPT's
//! session cookie, the credential its token refresh runs on, is captured.
//!
//! ```text
//! phone: start   -> hidden login page, entry button pressed -> asks "email"
//!        email   -> filled, submitted -> asks "code" (or "password")
//!        code    -> filled, submitted -> the backend's usual session report
//! ```

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::logging;
use crate::providers::{self, web_login};

/// How long one step may take, page loads and redirects included.
const STEP_ATTEMPTS: u32 = 45;
const STEP_INTERVAL: Duration = Duration::from_secs(1);
/// How long a check shown on the PC may take before the phone gives up.
const CHALLENGE_ATTEMPTS: u32 = 300;

/// What a backend's login page needs beyond the generic field detection.
pub struct PhoneForm<'a> {
    /// Code widgets may require a focused native window for browser editing.
    pub code_needs_focus: bool,
    /// CSS selector of the button that opens the login form, when the login
    /// page starts on a landing screen ("Log in" / "Sign up").
    pub entry: &'a str,
    /// Label pattern for providers whose entry button has no stable selector.
    pub entry_text: &'a str,
    /// Case-insensitive pattern of the link that trades a password for a
    /// mailed code. Followed whenever a password is asked: a code is the
    /// safer thing to send over the Wi-Fi.
    pub code_switch: &'a str,
    /// Optional selector for OTP widgets that split a code across inputs.
    pub code_inputs: &'a str,
    /// Case-insensitive pattern of the button that signs in with a phone
    /// number and a texted code, or `""` when the backend has none. Offered
    /// to accounts that have no password nor mailed code (social sign-ups).
    pub phone_switch: &'a str,
}

impl PhoneForm<'_> {
    fn needs_foreground(&self, field: Option<Field>) -> bool {
        self.code_needs_focus && field == Some(Field::Code)
    }
}

/// A question the login page asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Field {
    Email,
    Code,
    Password,
    /// A phone number, answered instead of the e-mail.
    Phone,
}

impl Field {
    fn as_str(self) -> &'static str {
        match self {
            Field::Email => "email",
            Field::Code => "code",
            Field::Password => "password",
            Field::Phone => "phone",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    Idle,
    /// The PC is loading the page or submitting an answer.
    Working,
    /// The page waits for `ask`.
    Ask,
    /// The page shows a visible check: it has to be finished on the PC.
    Challenge,
    /// The last answer was refused; `ask` can be answered again.
    Error,
    Done,
    /// What a page that is not moving shows; logged, never shown.
    Trace,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub step: Step,
    pub ask: Option<Field>,
    pub message: String,
    #[serde(skip)]
    provider: String,
}

const IDLE: Progress = Progress {
    step: Step::Idle,
    ask: None,
    message: String::new(),
    provider: String::new(),
};

static PROGRESS: Mutex<Progress> = Mutex::new(IDLE);
/// Each start and answer gets a new number; reports from an older one are
/// ignored.
static ATTEMPT: AtomicU64 = AtomicU64::new(0);

pub fn is_active(provider: &str) -> bool {
    let state = progress();
    state.provider == provider && !matches!(state.step, Step::Idle | Step::Done)
}
pub fn is_done(provider: &str) -> bool {
    let state = progress();
    state.provider == provider && state.step == Step::Done
}
pub fn progress() -> Progress {
    PROGRESS.lock().map(|p| p.clone()).unwrap_or(IDLE)
}

fn update(change: impl FnOnce(&mut Progress)) {
    if let Ok(mut progress) = PROGRESS.lock() {
        change(&mut progress);
    }
}

/// Forgets a previous pairing's progress.
pub fn reset() {
    ATTEMPT.fetch_add(1, Ordering::SeqCst);
    update(|p| *p = IDLE);
}

/// The pairing was cancelled mid-way: the half-filled login window goes, as
/// a cancelled desktop sign-in's does.
pub fn abandon(app: &AppHandle) {
    let progress = progress();
    reset();
    if matches!(progress.step, Step::Idle | Step::Done) {
        return;
    }
    if let Some((owner, local)) = providers::plugin_identity(&progress.provider) {
        app.state::<std::sync::Arc<crate::plugin_browser::DesktopBrowser>>()
            .cancel(owner, local);
        return;
    }
    if let Some(backend) = providers::backend(&progress.provider) {
        if let Some(window) = app.get_webview_window(backend.window.label) {
            let _ = window.close();
        }
    }
}

/// `provider`'s sign-in reported an account: the phone is done.
pub fn finished(provider: &str) {
    update(|p| {
        if p.provider == provider && p.step != Step::Idle {
            p.step = Step::Done;
            p.ask = None;
            p.message.clear();
        }
    });
}

/// Opens a clean, hidden login for `provider` and waits for its first question.
pub fn start(app: &AppHandle, provider: &str) -> Result<(), String> {
    if let Some((owner, local)) = providers::plugin_identity(provider) {
        crate::plugin_browser::phone_config(app, provider).map_err(|error| error.to_string())?;
        let attempt = ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
        update(|p| {
            *p = Progress {
                step: Step::Working,
                provider: provider.into(),
                ..IDLE
            }
        });
        let host = app
            .state::<std::sync::Arc<crate::plugin_browser::DesktopBrowser>>()
            .inner()
            .clone();
        let owner = owner.to_owned();
        let local = local.to_owned();
        tauri::async_runtime::spawn(async move {
            if ATTEMPT.load(Ordering::SeqCst) != attempt {
                return;
            }
            if let Err(error) = host.login(owner, local, true).await {
                if ATTEMPT.load(Ordering::SeqCst) == attempt {
                    update(|p| {
                        p.step = Step::Error;
                        p.message = error.to_string();
                    });
                }
            }
        });
        drive(app.clone(), attempt, None, String::new());
        return Ok(());
    }
    let backend = providers::backend(provider)
        .filter(|b| b.phone.is_some())
        .ok_or_else(|| format!("\"{provider}\" has no phone sign-in"))?;
    backend.open_hidden_login(app).map_err(|e| e.to_string())?;
    let attempt = ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
    update(|p| {
        *p = Progress {
            step: Step::Working,
            provider: backend.id.into(),
            ..IDLE
        }
    });
    logging::log(
        "phone-form",
        &format!("opening the {} login for the phone", backend.id),
    );
    drive(app.clone(), attempt, None, String::new());
    Ok(())
}

/// Types the phone's answer into the question the page is asking.
pub fn answer(app: &AppHandle, field: Field, value: &str) -> Result<(), String> {
    let value = clean(field, value)?;
    let progress = progress();
    // The phone number answers the e-mail question too: it is the other way in.
    // E-mail and phone number are two answers to the same first question; the
    // page is switched to the one the user picked.
    let first = |f: Option<Field>| matches!(f, Some(Field::Email | Field::Phone));
    let phones = form_of(&progress.provider).is_some_and(|f| !f.phone_switch.is_empty())
        || crate::plugin_browser::phone_config(app, &progress.provider)
            .is_ok_and(|config| !config.form.phone_switch.is_empty());
    let asked =
        progress.ask == Some(field) || (phones && first(Some(field)) && first(progress.ask));
    if !asked || !matches!(progress.step, Step::Ask | Step::Error) {
        return Err("the sign-in is not asking for that — reload the phone page".to_string());
    }
    let attempt = ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
    update(|p| {
        p.step = Step::Working;
        p.message.clear();
    });
    logging::log(
        "phone-form",
        &format!("submitting the {} from the phone", field.as_str()),
    );
    drive(app.clone(), attempt, Some(field), value);
    Ok(())
}

/// Re-evaluates the step script until the page reports: it may still be
/// loading or redirecting, and an evaluation into either is lost.
fn drive(app: AppHandle, attempt: u64, field: Option<Field>, value: String) {
    let progress = progress();
    let (label, script, foreground, browser) =
        if providers::plugin_identity(&progress.provider).is_some() {
            let Ok(config) = crate::plugin_browser::phone_config(&app, &progress.provider) else {
                return;
            };
            let form = PhoneForm {
                entry: &config.form.entry,
                entry_text: &config.form.entry_text,
                code_switch: &config.form.code_switch,
                code_inputs: &config.form.code_inputs,
                phone_switch: &config.form.phone_switch,
                code_needs_focus: config.form.code_needs_focus,
            };
            let script = drive_script(&form, field, &value, attempt);
            (
                config.label,
                script,
                form.needs_foreground(field),
                Some(config.browser),
            )
        } else {
            let Some(backend) = providers::backend(&progress.provider) else {
                return;
            };
            let Some(form) = backend.phone.as_ref() else {
                return;
            };
            (
                backend.window.label.to_string(),
                drive_script(form, field, &value, attempt),
                form.needs_foreground(field),
                None,
            )
        };
    // A check on the PC keeps the step alive: once it clears, the page asks
    // its question and the same script reports it.
    let step = move || (ATTEMPT.load(Ordering::SeqCst) == attempt).then(|| self::progress().step);
    let current = move || matches!(step(), Some(Step::Working | Step::Challenge));
    std::thread::spawn(move || {
        if foreground && ATTEMPT.load(Ordering::SeqCst) == attempt {
            if let Some(window) = app.get_webview_window(&label) {
                providers::cloak::uncloak(&window);
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        std::thread::sleep(STEP_INTERVAL);
        let (mut working, mut checking) = (0, 0);
        while working < STEP_ATTEMPTS && checking < CHALLENGE_ATTEMPTS {
            match step() {
                Some(Step::Working) => working += 1,
                Some(Step::Challenge) => checking += 1,
                _ => return,
            }
            if let Some(window) = app.get_webview_window(&label) {
                if browser.as_ref().map_or(true, |spec| {
                    crate::plugin_browser::phone_window_allowed(&window, spec)
                }) {
                    let _ = window.eval(&script);
                }
            }
            std::thread::sleep(STEP_INTERVAL);
        }
        if current() {
            logging::log("phone-form", "the login page did not answer");
            update(|p| {
                p.step = if p.ask.is_some() {
                    Step::Error
                } else {
                    Step::Idle
                };
                p.message = "the login page did not answer — try again".to_string();
            });
        }
    });
}

fn clean(field: Field, raw: &str) -> Result<String, String> {
    match field {
        Field::Email => clean_email(raw),
        Field::Phone => clean_phone(raw),
        Field::Code => clean_code(raw),
        Field::Password if !raw.is_empty() && raw.len() <= 256 => Ok(raw.to_string()),
        Field::Password => Err("enter the password".to_string()),
    }
}

fn clean_email(raw: &str) -> Result<String, String> {
    let email = raw.trim();
    let valid = email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && email
            .split_once('@')
            .is_some_and(|(user, domain)| !user.is_empty() && domain.contains('.'));
    if valid {
        Ok(email.to_string())
    } else {
        Err("that does not look like an e-mail address".to_string())
    }
}

fn clean_phone(raw: &str) -> Result<String, String> {
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    let international = raw.trim_start().starts_with('+');
    let only_number = raw
        .chars()
        .all(|c| c.is_ascii_digit() || " +-().".contains(c));
    if international && only_number && (8..=15).contains(&digits.len()) {
        Ok(format!("+{digits}"))
    } else {
        Err("enter the number with its country code, like +39 312 345 6789".to_string())
    }
}

fn form_of(provider: &str) -> Option<&'static PhoneForm<'static>> {
    providers::backend(provider).and_then(|backend| backend.phone.as_ref())
}

fn clean_code(raw: &str) -> Result<String, String> {
    let code: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if (4..=20).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(code)
    } else {
        Err("enter the code from the e-mail".to_string())
    }
}

/// Reports what the login page asks, or fills the answer in and watches what
/// the page does with it. Idempotent per attempt: a page evaluated twice
/// submits once, and one reached by a redirect only reports its question.
const DRIVE_SCRIPT: &str = include_str!("../../../packages/phone-login/driver.js");

fn drive_script(form: &PhoneForm<'_>, field: Option<Field>, value: &str, attempt: u64) -> String {
    let quote = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    DRIVE_SCRIPT
        .replace(
            "__FIELD__",
            &field.map_or("null".to_string(), |f| quote(f.as_str())),
        )
        .replace("__VALUE__", &quote(value))
        .replace("__ATTEMPT__", &attempt.to_string())
        .replace("__ENTRY__", &quote(form.entry))
        .replace("__ENTRY_TEXT__", &quote(form.entry_text))
        .replace("__CODE_SWITCH__", &quote(form.code_switch))
        .replace("__CODE_INPUTS__", &quote(form.code_inputs))
        .replace("__PHONE_SWITCH__", &quote(form.phone_switch))
}

#[derive(Debug, Deserialize)]
struct Report {
    attempt: u64,
    step: Step,
    #[serde(default)]
    ask: Option<Field>,
    #[serde(default)]
    message: String,
}

fn decode_report(url: &tauri::Url) -> Option<Report> {
    if url.host_str()? != "phone-form" {
        return None;
    }
    web_login::decode_base64_json::<Report>(url.fragment()?)
}

/// A step report from whichever login window the phone drives. `true` when
/// the url was one.
pub fn resolve_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    let Some(report) = decode_report(url) else {
        return false;
    };
    if report.step == Step::Trace {
        logging::log("phone-form", &format!("page: {}", report.message));
        return true;
    }
    if report.attempt != ATTEMPT.load(Ordering::SeqCst) || progress().step == Step::Done {
        return true;
    }
    let before = progress();
    let entering_challenge = report.step == Step::Challenge && before.step != Step::Challenge;
    if before.step != report.step || (report.ask.is_some() && before.ask != report.ask) {
        let detail = if report.message.is_empty() {
            String::new()
        } else {
            format!(": {}", report.message)
        };
        logging::log(
            "phone-form",
            &format!("step {:?} {:?}{detail}", report.step, report.ask),
        );
    }
    update(|p| {
        p.step = report.step;
        if report.ask.is_some() {
            p.ask = report.ask;
        }
        p.message = report.message;
    });
    if entering_challenge {
        // Never touch the webview from inside its navigation handler.
        let handle = app.clone();
        let provider = progress().provider;
        let label = providers::backend(&provider)
            .map(|b| b.window.label.to_string())
            .or_else(|| {
                crate::plugin_browser::phone_config(app, &provider)
                    .ok()
                    .map(|config| config.label)
            });
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            if let Some(window) = label.and_then(|label| handle.get_webview_window(&label)) {
                providers::cloak::uncloak(&window);
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_code_editing_needs_focus_without_changing_other_provider_steps() {
        assert!(super::super::grok::PHONE_FORM.needs_foreground(Some(Field::Code)));
        assert!(!super::super::grok::PHONE_FORM.needs_foreground(Some(Field::Password)));
        assert!(!super::super::grok::PHONE_FORM.needs_foreground(None));
        assert!(!super::super::chatgpt::PHONE_FORM.needs_foreground(Some(Field::Code)));
        assert!(!super::super::claude::PHONE_FORM.needs_foreground(Some(Field::Code)));
    }

    #[test]
    fn a_provider_can_open_its_email_form_by_button_label() {
        let form = PhoneForm {
            code_needs_focus: false,
            entry: "",
            entry_text: "^continue with email$",
            code_switch: "",
            code_inputs: "",
            phone_switch: "",
        };
        let script = drive_script(&form, None, "", 1);
        assert!(script.contains("const entryText = \"^continue with email$\""));
        assert!(!script.contains("__ENTRY_TEXT__"));
        assert!(script.contains("entryPattern.test"));
    }

    const FORM: PhoneForm = PhoneForm {
        code_needs_focus: false,
        entry: "button[data-testid=\"login-button\"]",
        entry_text: "",
        code_switch: "one-time code",
        code_inputs: "",
        phone_switch: "continue with phone",
    };

    #[test]
    fn phone_numbers_need_a_country_code() {
        assert_eq!(clean_phone(" +39 312 345-6789 ").unwrap(), "+393123456789");
        assert_eq!(clean_phone("+1 (415) 555-0100").unwrap(), "+14155550100");
        assert!(clean_phone("312 345 6789").is_err());
        assert!(clean_phone("+39 abc 345 6789").is_err());
        assert!(clean_phone("+123").is_err());
    }

    #[test]
    fn accepts_plain_emails_only() {
        assert_eq!(clean_email("  a@b.com ").unwrap(), "a@b.com");
        assert!(clean_email("a b@c.com").is_err());
        assert!(clean_email("@b.com").is_err());
        assert!(clean_email("a@b").is_err());
        assert!(clean_email("").is_err());
    }

    #[test]
    fn tidies_a_typed_code() {
        assert_eq!(clean_code(" 123 456 ").unwrap(), "123456");
        assert_eq!(clean_code("123-456").unwrap(), "123456");
        assert!(clean_code("12").is_err());
        assert!(clean_code("12;alert(1)").is_err());
    }

    #[test]
    fn keeps_a_password_as_typed() {
        assert_eq!(clean(Field::Password, " p a ss ").unwrap(), " p a ss ");
        assert!(clean(Field::Password, "").is_err());
    }

    #[test]
    fn the_script_carries_values_as_js_strings() {
        let script = drive_script(&FORM, Some(Field::Email), "a\"b@c.com", 7);
        assert!(script.contains(r#"const value = "a\"b@c.com";"#));
        assert!(script.contains(r#"const field = "email";"#));
        assert!(script.contains("const attempt = 7;"));
        for placeholder in [
            "__FIELD__",
            "__VALUE__",
            "__ATTEMPT__",
            "__ENTRY__",
            "__CODE_SWITCH__",
            "__PHONE_SWITCH__",
        ] {
            assert!(!script.contains(placeholder), "{placeholder} left in");
        }
        let probe = drive_script(&FORM, None, "", 8);
        assert!(probe.contains("const field = null;"));
    }

    #[test]
    fn decodes_step_reports() {
        use base64::Engine as _;
        let json = r#"{"attempt":3,"step":"ask","ask":"code"}"#;
        let raw = format!(
            "tauri-voice://phone-form#{}",
            base64::engine::general_purpose::STANDARD.encode(json)
        );
        let report = decode_report(&raw.parse().unwrap()).unwrap();
        assert_eq!(report.attempt, 3);
        assert_eq!(report.step, Step::Ask);
        assert_eq!(report.ask, Some(Field::Code));
        assert!(decode_report(&"tauri-voice://claude-session#x".parse().unwrap()).is_none());
    }
}
