//! Bundled application opening through the platform-neutral tool registry.

use super::{aliases, DesktopHost};
use crate::commands::registry::{CommandDescriptor, CommandScope};
use crate::error::{AppError, Result};
use crate::plugins::{BoxFuture, PluginManifest, PluginUi, ToolProvider};
use crate::tools::ToolDescriptor;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

pub struct ComputerApps {
    host: Arc<Mutex<DesktopHost>>,
    enabled: Arc<AtomicBool>,
}

impl Default for ComputerApps {
    fn default() -> Self {
        Self::new()
    }
}

impl ComputerApps {
    pub fn new() -> Self {
        Self {
            host: Arc::new(Mutex::new(DesktopHost::new())),
            enabled: Arc::new(AtomicBool::new(true)),
        }
    }
}

impl ToolProvider for ComputerApps {
    fn manifest(&self) -> &PluginManifest {
        static MANIFEST: OnceLock<PluginManifest> = OnceLock::new();
        MANIFEST.get_or_init(|| {
            let mut manifest = PluginManifest::new("lilo.computer", "Computer control", env!("CARGO_PKG_VERSION"))
                .with_capabilities(&["desktop:apps"]);
            manifest.description = "Open common installed applications by voice, without configuring application paths.".into();
            manifest
        })
    }

    fn descriptors(&self) -> Vec<ToolDescriptor> {
        vec![
            ToolDescriptor {
                name: "computer_apps".into(),
                description: "List locally discovered installed application names without exposing installation paths.".into(),
                parameters: json!({"type":"object","properties":{}}),
            },
            ToolDescriptor {
                name: "computer_open".into(),
                description: "Request opening an installed application by its name or common alias. Does not create or edit files.".into(),
                parameters: json!({"type":"object","properties":{"app":{"type":"string"}},"required":["app"]}),
            },
        ]
    }

    fn handles(&self, tool: &str) -> bool {
        matches!(tool, "computer_apps" | "computer_open")
    }

    fn invoke<'a>(&'a self, tool: &'a str, args: &'a Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let op = match tool {
                "computer_apps" => "apps",
                "computer_open" => "open",
                _ => return Err(AppError::other("Unknown computer-control tool.")),
            };
            let host = self.host.clone();
            let enabled = self.enabled.clone();
            let args = args.clone();
            tokio::task::spawn_blocking(move || {
                if !enabled.load(Ordering::Acquire) {
                    return Err(AppError::other(
                        "Application opening is disabled in Computer control settings.",
                    ));
                }
                let result = host
                    .lock()
                    .map_err(|_| AppError::other("Computer control is unavailable."))?
                    .request(&["desktop:apps".into()], op, args);
                if result["ok"] != true {
                    return Err(AppError::other(
                        result["error"]["message"]
                            .as_str()
                            .unwrap_or("Computer control is unavailable."),
                    ));
                }
                if op == "apps" {
                    let apps = result["apps"].as_array().ok_or_else(|| {
                        AppError::other("Application discovery returned an invalid result.")
                    })?;
                    let names: Vec<String> = apps
                        .iter()
                        .take(20)
                        .filter_map(|app| app["name"].as_str())
                        .map(|name| name.chars().take(160).collect())
                        .collect();
                    let mut summary = if names.is_empty() {
                        "No installed applications were found.".into()
                    } else {
                        format!("Installed applications include: {}.", names.join(", "))
                    };
                    if apps.len() > 20 {
                        summary.push_str(&format!(" There are {} more.", apps.len() - 20));
                    }
                    Ok(json!({"apps":result["apps"], "summary":summary}))
                } else {
                    Ok(json!({"summary":result["message"]}))
                }
            })
            .await
            .map_err(|_| AppError::other("Computer control could not finish the request."))?
        })
    }

    fn configure<'a>(&'a self, settings: Value) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if let Some(value) = settings.get("enabled") {
                let enabled = value.as_bool().ok_or_else(|| {
                    AppError::other("Application opening must be enabled or disabled.")
                })?;
                self.enabled.store(enabled, Ordering::Release);
            }
            Ok(())
        })
    }

    fn commands(&self) -> Vec<CommandDescriptor> {
        vec![
            CommandDescriptor {
                name: "computer.open".into(),
                scope: CommandScope::Tool,
                tool: Some("computer_open".into()),
                descriptions: vec![(
                    "en".into(),
                    "Open a common installed application by name.".into(),
                )],
                requires_confirm: false,
                templates: vec![
                    ("en".into(), "(open|launch|start) {app}".into()),
                    ("pt".into(), "(abre|abrir|abra) {app}".into()),
                    ("it".into(), "(apri|avvia) {app}".into()),
                ],
                slot_words: vec![("app".into(), aliases::words())],
                args: Vec::new(),
            },
            CommandDescriptor {
                name: "computer.apps".into(),
                scope: CommandScope::Tool,
                tool: Some("computer_apps".into()),
                descriptions: vec![("en".into(), "List installed applications.".into())],
                requires_confirm: false,
                templates: vec![
                    ("en".into(), "list [installed] (applications|apps)".into()),
                    (
                        "pt".into(),
                        "lista (aplicativos|programas) [instalados]".into(),
                    ),
                    (
                        "it".into(),
                        "elenca (applicazioni|programmi) [installati]".into(),
                    ),
                ],
                slot_words: Vec::new(),
                args: Vec::new(),
            },
        ]
    }

    fn ui(&self) -> PluginUi {
        serde_json::from_value(json!({
            "settings":[{"key":"enabled","kind":"switch","label":"Allow application opening","default":true}],
            "status":[{"label":"Available actions","value":"Say: LILO, open VS Code. Application opening only; file analysis and editing are not available yet.","state":"warn"}],
            "actions":[{"label":"List installed applications","tool":"computer_apps"}]
        })).expect("computer-control UI is valid")
    }

    fn prompt(&self) -> Option<String> {
        Some("Computer control is bundled with LILO. Users can request opening common installed applications by their ordinary names, without application-path configuration. Only report the actual tool result. This integration does not create files, inspect code, generate text, or apply corrections.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::registry::Registry;
    use crate::plugins::ToolRegistry;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn test_common_apps_register_without_marketplace_setup() {
        let provider = ComputerApps::new();
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(provider)).unwrap();
        assert!(tools.handles("computer_open"));
        assert!(!tools.handles("desktop_type"));
    }

    #[test]
    fn test_common_app_requests_need_no_desktop_prefix() {
        let provider = ComputerApps::new();
        let mut registry = Registry::new("lilo");
        registry.register(provider.commands()).unwrap();
        for utterance in [
            "open my vscode",
            "launch chrome",
            "open teams",
            "open word",
            "open calculator",
            "open vlc",
        ] {
            let intent = registry.match_utterance(utterance).unwrap();
            assert_eq!(intent.tool.as_deref(), Some("computer_open"));
            assert!(!intent.requires_confirm);
        }
        for utterance in ["open the door", "open my mind", "open README.md"] {
            assert!(registry.match_utterance(utterance).is_none());
        }
        assert_eq!(
            registry
                .match_utterance("list installed applications")
                .unwrap()
                .tool
                .as_deref(),
            Some("computer_apps")
        );
    }

    #[tokio::test]
    async fn test_disabled_computer_control_refuses_before_discovery() {
        let provider = ComputerApps::new();
        provider.configure(json!({"enabled":false})).await.unwrap();
        let error = provider
            .invoke("computer_open", &json!({"app":"chrome"}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("disabled"));
        assert!(provider.host.lock().unwrap().catalog.is_none());
        assert!(provider.configure(json!({"enabled":"yes"})).await.is_err());
    }

    #[tokio::test]
    async fn test_unknown_tools_are_not_executed() {
        let provider = ComputerApps::new();
        assert!(provider.invoke("run_shell", &json!({})).await.is_err());
        assert!(provider.host.lock().unwrap().catalog.is_none());
    }

    #[tokio::test]
    async fn test_voice_request_reaches_only_the_resolved_application_and_lists_real_names() {
        use super::super::{App, Backend, Failure};
        use std::sync::atomic::AtomicUsize;
        struct TestBackend(Arc<AtomicUsize>);
        impl Backend for TestBackend {
            fn discover(&self) -> std::result::Result<Vec<App>, Failure> {
                Ok(vec![App::new("Google Chrome", "private/chrome")])
            }
            fn open(&self, app: &App) -> std::result::Result<(), Failure> {
                assert_eq!(app.name, "Google Chrome");
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            fn type_text(&self, _: &App, _: &str) -> std::result::Result<(), Failure> {
                panic!("bundled application opening has no text-entry permission")
            }
        }
        let launches = Arc::new(AtomicUsize::new(0));
        let provider = ComputerApps {
            host: Arc::new(Mutex::new(DesktopHost::with_backend(Box::new(
                TestBackend(launches.clone()),
            )))),
            enabled: Arc::new(AtomicBool::new(true)),
        };
        let mut commands = Registry::new("lilo");
        commands.register(provider.commands()).unwrap();
        let intent = commands.match_utterance("LILO, open my Chrome").unwrap();
        let mut tools = ToolRegistry::new();
        tools.register(Arc::new(provider)).unwrap();
        let result = tools
            .invoke(
                intent.tool.as_deref().unwrap(),
                &serde_json::to_value(intent.args).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        assert!(!result.to_string().contains("private/"));
        let listed = tools.invoke("computer_apps", &json!({})).await.unwrap();
        assert!(listed["summary"]
            .as_str()
            .unwrap()
            .contains("Google Chrome"));
        assert!(!listed.to_string().contains("private/"));
    }
}
