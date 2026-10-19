//! Scoped desktop operations for sandboxed plugins. Arguments never become shell code.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

mod aliases;
mod provider;
pub use provider::ComputerApps;
#[cfg(any(target_os = "linux", test))]
mod variant;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
#[path = "unsupported.rs"]
mod platform;

#[derive(Debug, Clone)]
struct App {
    id: String,
    name: String,
    path: PathBuf,
    #[cfg(any(windows, target_os = "linux"))]
    executable: Option<PathBuf>,
    aliases: Vec<String>,
}
impl App {
    fn new(name: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        let name = name.into();
        let path = path.into();
        let id = format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()));
        Self {
            id,
            aliases: aliases::for_name(&name),
            name,
            path,
            #[cfg(any(windows, target_os = "linux"))]
            executable: None,
        }
    }
}

#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: &'static str,
}
impl Failure {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
    fn unavailable() -> Self {
        Self::new(
            "desktop_unavailable",
            "Desktop control is unavailable in this session.",
        )
    }
    fn unsupported_field() -> Self {
        Self::new(
            "unsupported_field",
            "Select a supported text field in the target application and try again.",
        )
    }
}
trait Backend: Send {
    fn discover(&self) -> Result<Vec<App>, Failure>;
    fn open(&self, app: &App) -> Result<(), Failure>;
    fn type_text(&self, app: &App, text: &str) -> Result<(), Failure>;
}
struct Native;
impl Backend for Native {
    fn discover(&self) -> Result<Vec<App>, Failure> {
        platform::discover()
    }
    fn open(&self, app: &App) -> Result<(), Failure> {
        platform::open(app)
    }
    fn type_text(&self, app: &App, text: &str) -> Result<(), Failure> {
        platform::type_text(app, text)
    }
}

pub(crate) struct DesktopHost {
    backend: Box<dyn Backend>,
    catalog: Option<(Instant, Vec<App>)>,
}
impl DesktopHost {
    pub(crate) fn new() -> Self {
        Self {
            backend: Box::new(Native),
            catalog: None,
        }
    }
    #[cfg(test)]
    fn with_backend(backend: Box<dyn Backend>) -> Self {
        Self {
            backend,
            catalog: None,
        }
    }
    pub(crate) fn request(&mut self, capabilities: &[String], op: &str, args: Value) -> Value {
        match self.execute(capabilities, op, &args) {
            Ok(result) => result,
            Err(error) => json!({"ok":false, "error":{"code":error.code, "message":error.message}}),
        }
    }
    fn execute(
        &mut self,
        capabilities: &[String],
        op: &str,
        args: &Value,
    ) -> Result<Value, Failure> {
        if !["apps", "open", "type"].contains(&op) {
            return Err(Failure::new(
                "invalid_operation",
                "Unknown desktop operation.",
            ));
        }
        if !capabilities.iter().any(|cap| cap == "desktop:apps")
            || (op == "type" && !capabilities.iter().any(|cap| cap == "desktop:text"))
        {
            return Err(Failure::new(
                "permission_denied",
                "The plugin has not been granted this desktop capability.",
            ));
        }
        let text = args["text"].as_str().unwrap_or_default();
        if op == "type"
            && (text.is_empty()
                || text.chars().count() > 8192
                || text
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t'))
        {
            return Err(Failure::new(
                "invalid_text",
                "Dictation must contain between 1 and 8192 characters without control codes.",
            ));
        }
        let query = args["app"].as_str().unwrap_or_default();
        if op != "apps"
            && (query.is_empty()
                || query.chars().count() > 160
                || query.chars().any(char::is_control))
        {
            return Err(Failure::new(
                "invalid_target",
                "Choose an installed application by name.",
            ));
        }
        let reused = self
            .catalog
            .as_ref()
            .is_some_and(|(time, _)| time.elapsed() < Duration::from_secs(60));
        if !reused {
            self.refresh()?;
        }
        let apps = &self.catalog.as_ref().expect("catalog refreshed").1;
        if op == "apps" {
            return Ok(
                json!({"ok":true, "apps":apps.iter().map(|a| json!({"id":a.id,"name":a.name})).collect::<Vec<_>>() }),
            );
        }
        let resolved = resolve_app(apps, query).cloned();
        let app = match resolved {
            Err(error) if reused && error.code == "target_unknown" => {
                self.refresh()?;
                resolve_app(&self.catalog.as_ref().expect("catalog refreshed").1, query)?.clone()
            }
            result => result?,
        };
        if op == "type" {
            if normalize(&app.name) == "lilo" {
                return Err(Failure::new(
                    "invalid_target",
                    "Choose another application as the dictation target.",
                ));
            }
            self.backend.type_text(&app, text)?;
            Ok(json!({"ok":true,"message":"Text inserted into the target field."}))
        } else {
            if let Err(error) = self.backend.open(&app) {
                self.catalog = None;
                return Err(error);
            }
            Ok(json!({"ok":true,"message":"Application launch requested."}))
        }
    }

    fn refresh(&mut self) -> Result<(), Failure> {
        let mut apps = self.backend.discover()?;
        apps.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        apps.dedup_by(|a, b| a.id == b.id);
        self.catalog = Some((Instant::now(), apps));
        Ok(())
    }
}
fn normalize(value: &str) -> String {
    crate::commands::matcher::normalize(value)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}
fn resolve_app<'a>(apps: &'a [App], query: &str) -> Result<&'a App, Failure> {
    let mut candidate = query.trim();
    loop {
        let name = normalize(candidate);
        for exact in [true, false] {
            let found: Vec<_> = apps
                .iter()
                .filter(|app| {
                    if exact {
                        app.id == candidate || normalize(&app.name) == name
                    } else {
                        app.aliases.iter().any(|alias| normalize(alias) == name)
                    }
                })
                .collect();
            match found.as_slice() {
                [app] => return Ok(app),
                [] => {}
                _ => {
                    return Err(Failure::new(
                        "target_ambiguous",
                        "Several applications match. Choose a specific application.",
                    ))
                }
            }
        }
        let Some((prefix, rest)) = candidate.split_once(char::is_whitespace) else {
            break;
        };
        if !matches!(
            prefix.to_lowercase().as_str(),
            "my" | "the" | "meu" | "minha" | "o" | "a" | "il" | "la" | "mio" | "mia"
        ) {
            break;
        }
        candidate = rest.trim_start();
    }
    Err(Failure::new(
        "target_unknown",
        "No installed application matches that name.",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command(program: &str, args: &[String]) -> Result<String, Failure> {
    let output =
        super::exec::run(Path::new("."), program, args).map_err(|_| Failure::unavailable())?;
    if output.code != 0 {
        return Err(Failure::unavailable());
    }
    Ok(output.stdout)
}
fn read_apps(root: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten().take(2048) {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case(suffix))
            {
                paths.push(path);
            } else if path.is_dir() {
                if let Ok(children) = std::fs::read_dir(&path) {
                    for child in children.flatten().take(2048) {
                        let path = child.path();
                        if path
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case(suffix))
                        {
                            paths.push(path);
                        }
                    }
                }
            }
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct FakeBackend(Arc<AtomicUsize>);
    impl Backend for FakeBackend {
        fn discover(&self) -> Result<Vec<App>, Failure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(vec![
                App::new("Editor", "private/editor.app"),
                App::new("Browser", "private/browser.app"),
            ])
        }
        fn open(&self, _: &App) -> Result<(), Failure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn type_text(&self, _: &App, _: &str) -> Result<(), Failure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    fn host() -> (DesktopHost, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        (
            DesktopHost::with_backend(Box::new(FakeBackend(calls.clone()))),
            calls,
        )
    }
    fn caps() -> Vec<String> {
        vec!["desktop:apps".into(), "desktop:text".into()]
    }

    #[test]
    fn test_denied_capabilities_have_no_side_effects() {
        let (mut host, calls) = host();
        for op in ["apps", "open", "type"] {
            let result = host.request(&[], op, json!({"app":"Editor", "text":"hello"}));
            assert_eq!(result["error"]["code"], "permission_denied");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let result = host.request(
            &["desktop:apps".into()],
            "type",
            json!({"app":"Editor", "text":"hello"}),
        );
        assert_eq!(result["error"]["code"], "permission_denied");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_catalog_exposes_opaque_ids_without_machine_paths() {
        let (mut host, _) = host();
        let result = host.request(&caps(), "apps", json!({}));
        assert_eq!(result["apps"].as_array().unwrap().len(), 2);
        assert!(!result.to_string().contains("private/"));
        let id = result["apps"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(host.request(&caps(), "open", json!({"app":id}))["ok"], true);
    }

    #[test]
    fn test_invalid_text_and_unknown_apps_never_execute() {
        let (mut host, calls) = host();
        for text in ["", "\0", "hello\u{1b}", &"x".repeat(8193)] {
            assert_eq!(
                host.request(&caps(), "type", json!({"app":"Editor", "text":text}))["ok"],
                false
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            host.request(&caps(), "open", json!({"app":"missing"}))["error"]["code"],
            "target_unknown"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_text_result_contains_no_dictated_content() {
        let (mut host, _) = host();
        let result = host.request(
            &caps(),
            "type",
            json!({"app":"Editor", "text":"private dictated content"}),
        );
        assert_eq!(result["ok"], true);
        assert!(!result.to_string().contains("private dictated content"));
    }

    #[test]
    fn test_ambiguous_application_names_are_refused() {
        let apps = vec![App::new("Editor", "one"), App::new("Editor", "two")];
        assert_eq!(
            resolve_app(&apps, "Editor").unwrap_err().code,
            "target_ambiguous"
        );
    }

    #[test]
    fn natural_application_targets_resolve_possessives_and_editor_aliases() {
        let mut app = App::new("Visual Studio Code", "private/code.app");
        app.aliases.push("vscode".into());
        let apps = vec![app];
        for query in ["my VS Code", "the vscode", "meu VS Code", "il mio vscode"] {
            assert_eq!(
                resolve_app(&apps, query).unwrap().name,
                "Visual Studio Code"
            );
        }
        assert!(resolve_app(&apps, "my VS Code create a file").is_err());
    }

    #[test]
    fn a_literal_installed_app_name_wins_before_possessive_removal() {
        let apps = vec![
            App::new("My Editor", "private/one"),
            App::new("Editor", "private/two"),
        ];
        assert_eq!(resolve_app(&apps, "My Editor").unwrap().name, "My Editor");
    }

    #[test]
    fn test_common_application_aliases_need_no_user_configuration() {
        for (name, queries) in [
            ("Visual Studio Code", vec!["my vscode", "vs code", "code"]),
            ("Google Chrome", vec!["chrome", "my chrome"]),
            ("Microsoft Edge", vec!["edge"]),
            ("Microsoft Teams", vec!["teams"]),
            ("Mozilla Firefox", vec!["firefox"]),
            ("Microsoft Word", vec!["word"]),
            ("Windows Terminal", vec!["terminal"]),
            ("File Explorer", vec!["files", "explorer"]),
            ("Finder", vec!["files"]),
            ("VLC media player", vec!["vlc"]),
        ] {
            let apps = vec![App::new(name, "private/application")];
            for query in queries {
                assert_eq!(resolve_app(&apps, query).unwrap().name, name, "{query}");
            }
        }
    }

    #[test]
    fn test_exact_app_names_outrank_another_apps_alias() {
        let exact = App::new("Code", "private/code");
        let mut other = App::new("Another Editor", "private/other");
        other.aliases.push("code".into());
        assert_eq!(resolve_app(&[exact, other], "Code").unwrap().name, "Code");
    }

    #[test]
    fn test_application_catalog_is_reused_between_requests() {
        let (mut host, calls) = host();
        assert_eq!(host.request(&caps(), "apps", json!({}))["ok"], true);
        assert_eq!(
            host.request(&caps(), "open", json!({"app":"Editor"}))["ok"],
            true
        );
        assert_eq!(
            host.request(&caps(), "open", json!({"app":"Browser"}))["ok"],
            true
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn test_newly_installed_apps_are_found_without_restarting() {
        struct ChangingCatalog(Arc<AtomicUsize>);
        impl Backend for ChangingCatalog {
            fn discover(&self) -> Result<Vec<App>, Failure> {
                let generation = self.0.fetch_add(1, Ordering::SeqCst);
                let mut apps = vec![App::new("Google Chrome", "private/chrome")];
                if generation > 0 {
                    apps.push(App::new("Slack", "private/slack"));
                }
                Ok(apps)
            }
            fn open(&self, _: &App) -> Result<(), Failure> {
                Ok(())
            }
            fn type_text(&self, _: &App, _: &str) -> Result<(), Failure> {
                panic!("text capability was not requested")
            }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = DesktopHost::with_backend(Box::new(ChangingCatalog(calls.clone())));
        assert_eq!(
            host.request(&caps(), "open", json!({"app":"chrome"}))["ok"],
            true
        );
        assert_eq!(
            host.request(&caps(), "open", json!({"app":"slack"}))["ok"],
            true
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
