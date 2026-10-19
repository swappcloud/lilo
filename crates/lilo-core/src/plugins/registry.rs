//! The dynamic tool registry.
//!
//! Replaces the hard-coded `match tool { … }` the host used to carry: the host
//! asks the registry, and the registry asks whichever provider claims the name.
//! Registration is where identity is enforced — a duplicate manifest id or a
//! tool name owned by two providers is an error at startup, not a coin flip at
//! runtime.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::tools::ToolDescriptor;

use super::manifest::PluginManifest;
use super::provider::ToolProvider;
use super::ui::PluginUi;

/// A plugin as the UI sees it: identity plus what it wants on screen.
///
/// A plugin can be installed without running: deactivated (the user turned it
/// off) or enabled but not loaded (it failed to start). Both still appear in
/// the settings list, which is why the state travels with the view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    #[serde(default, rename = "voiceProviders")]
    pub voice_providers: Vec<super::voice::VoiceProviderSpec>,
    pub manifest: PluginManifest,
    /// Tool names the active provider owns; UI row actions are checked against this list.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Empty unless the plugin is loaded: a stopped plugin cannot be asked
    /// what it wants to show.
    pub ui: PluginUi,
    /// Backed by a folder, so the host can deactivate, reactivate and
    /// uninstall it. First-party in-process plugins have no folder.
    pub manageable: bool,
    /// The user has it on. Always true while it is loaded.
    pub enabled: bool,
    /// Registered and running right now.
    pub loaded: bool,
}

#[derive(Default)]
pub struct ToolRegistry {
    providers: Vec<Arc<dyn ToolProvider>>,
}

impl std::fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolRegistry")
            .field("providers", &self.providers.len())
            .finish()
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        ToolRegistry {
            providers: Vec::new(),
        }
    }

    /// Add a provider. Rejects an incompatible API version, a duplicate id, or
    /// a tool name someone else already owns.
    pub fn register(&mut self, provider: Arc<dyn ToolProvider>) -> Result<()> {
        let manifest = provider.manifest();
        manifest.validate_identity()?;
        if super::loader::is_retired(&manifest.id) {
            return Err(AppError::other(
                "This application launcher was replaced by bundled Computer control.",
            ));
        }
        if !manifest.is_compatible() {
            return Err(AppError::other(format!(
                "plugin {} speaks api {} but this host speaks {}",
                manifest.id,
                manifest.api,
                super::manifest::PLUGIN_API_VERSION
            )));
        }
        if self
            .providers
            .iter()
            .any(|p| p.manifest().id == manifest.id)
        {
            return Err(AppError::other(format!(
                "plugin {} is already registered",
                manifest.id
            )));
        }
        for tool in provider.descriptors() {
            if self.handles(&tool.name) {
                return Err(AppError::other(format!(
                    "tool {} is already provided by another plugin",
                    tool.name
                )));
            }
        }
        self.providers.push(provider);
        Ok(())
    }

    /// Every provider, in registration order.
    pub fn manifests(&self) -> Vec<PluginManifest> {
        self.providers
            .iter()
            .map(|p| p.manifest().clone())
            .collect()
    }

    /// Remove a provider. Returns it when it was registered, so the caller can
    /// let a sidecar's process die with it.
    pub fn remove(&mut self, id: &str) -> Option<Arc<dyn ToolProvider>> {
        let index = self
            .providers
            .iter()
            .position(|provider| provider.manifest().id == id)?;
        Some(self.providers.remove(index))
    }

    /// Push settings to the plugin that owns them.
    pub async fn configure(&self, id: &str, settings: Value) -> Result<()> {
        let provider = self
            .provider(id)
            .ok_or_else(|| AppError::other(format!("no such plugin: {id}")))?;
        provider.configure(settings).await
    }

    /// Every provider, in registration order.
    pub fn providers(&self) -> Vec<Arc<dyn ToolProvider>> {
        self.providers.clone()
    }

    /// The provider registered under `id`.
    pub fn provider(&self, id: &str) -> Option<Arc<dyn ToolProvider>> {
        self.providers
            .iter()
            .find(|provider| provider.manifest().id == id)
            .cloned()
    }

    /// The provider that owns `tool`. Callers run the tool on the returned
    /// handle *after* releasing any lock around the registry: a tool may take a
    /// minute, and holding the lock that long blocks installs and every other
    /// tool behind it.
    pub fn provider_for(&self, tool: &str) -> Result<Arc<dyn ToolProvider>> {
        self.providers
            .iter()
            .find(|provider| provider.handles(tool))
            .cloned()
            .ok_or_else(|| {
                AppError::other(format!(
                    "unknown tool: {tool} (known: {})",
                    self.tool_names().join(", ")
                ))
            })
    }

    /// Every provider's briefing paragraph, labelled with its name, in
    /// registration order.
    ///
    /// A plugin that wrote no paragraph is still described, from its tools'
    /// own descriptions, so the model can explain anything installed. The
    /// built-ins are already covered by the command list.
    pub fn prompts(&self) -> Vec<(String, String)> {
        self.providers
            .iter()
            .filter_map(|provider| {
                let manifest = provider.manifest();
                let text = provider.prompt().or_else(|| {
                    if BUILTIN_PREFIXES
                        .iter()
                        .any(|prefix| manifest.id.starts_with(prefix))
                    {
                        return None;
                    }
                    Some(described(&provider.descriptors()))
                })?;
                Some((manifest.name.clone(), text))
            })
            .collect()
    }

    /// Fresh, bounded memory from each provider's explicitly declared tool.
    /// Failures never prevent a voice call; context cannot invoke another owner.
    pub async fn context_notes(&self) -> Vec<(String, String)> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut notes = Vec::new();
        let mut remaining = 16_000usize;
        for provider in &self.providers {
            let Some(tool) = provider
                .context_tool()
                .filter(|tool| provider.handles(tool))
            else {
                continue;
            };
            if remaining == 0 || tokio::time::Instant::now() >= deadline {
                break;
            }
            let budget =
                deadline.min(tokio::time::Instant::now() + std::time::Duration::from_millis(500));
            let args = serde_json::json!({});
            if let Ok(Ok(value)) =
                tokio::time::timeout_at(budget, provider.invoke(&tool, &args)).await
            {
                if let Some(context) = value.get("context").and_then(Value::as_str) {
                    let text: String = context.chars().take(remaining.min(12_000)).collect();
                    if !text.trim().is_empty() {
                        remaining -= text.chars().count();
                        notes.push((provider.manifest().name.clone(), text));
                    }
                }
            }
        }
        notes
    }

    /// Every tool, in registration order — stable so the settings list does not
    /// jump around between runs.
    pub fn descriptors(&self) -> Vec<ToolDescriptor> {
        self.providers
            .iter()
            .flat_map(|provider| provider.descriptors())
            .collect()
    }

    pub fn handles(&self, tool: &str) -> bool {
        self.providers.iter().any(|provider| provider.handles(tool))
    }

    /// Route one call to its owner.
    pub async fn invoke(&self, tool: &str, args: &Value) -> Result<Value> {
        self.provider_for(tool)?.invoke(tool, args).await
    }

    fn tool_names(&self) -> Vec<String> {
        self.descriptors()
            .into_iter()
            .map(|tool| tool.name)
            .collect()
    }
}

/// Providers LILO ships itself; their abilities are in the command list.
const BUILTIN_PREFIXES: [&str; 2] = ["core.", "lilo."];

/// A briefing line for a plugin that wrote none: what its tools say they do.
/// Tool descriptions are as untrusted as a prompt, so they get the same
/// flattening and cap.
fn described(tools: &[ToolDescriptor]) -> String {
    let abilities: Vec<&str> = tools
        .iter()
        .map(|tool| tool.description.trim().trim_end_matches('.'))
        .filter(|text| !text.is_empty())
        .collect();
    let text = if abilities.is_empty() {
        "installed, with no voice abilities of its own".to_string()
    } else {
        format!("lets LILO {}", abilities.join("; "))
    };
    super::sidecar::sanitize_prompt(Some(text)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::BoxFuture;
    use serde_json::json;

    #[test]
    fn test_retired_launcher_cannot_register_over_the_bundled_replacement() {
        let mut registry = ToolRegistry::new();
        let error = registry
            .register(Arc::new(FakeProvider::new(
                "com.lilo.macapps",
                &["legacy_open"],
            )))
            .unwrap_err();
        assert!(error.to_string().contains("replaced"));
    }

    struct FakeProvider {
        manifest: PluginManifest,
        tools: Vec<&'static str>,
    }

    impl FakeProvider {
        fn new(id: &str, tools: &[&'static str]) -> Self {
            FakeProvider {
                manifest: PluginManifest::new(id, id, "0.0.1"),
                tools: tools.to_vec(),
            }
        }
    }

    impl ToolProvider for FakeProvider {
        fn manifest(&self) -> &PluginManifest {
            &self.manifest
        }

        fn descriptors(&self) -> Vec<ToolDescriptor> {
            self.tools
                .iter()
                .map(|name| ToolDescriptor {
                    name: name.to_string(),
                    description: format!("{name} from {}", self.manifest.id),
                    parameters: json!({ "type": "object", "properties": {} }),
                })
                .collect()
        }

        fn handles(&self, tool: &str) -> bool {
            self.tools.contains(&tool)
        }

        fn invoke<'a>(&'a self, tool: &'a str, _args: &'a Value) -> BoxFuture<'a, Result<Value>> {
            Box::pin(async move { Ok(json!({ "provider": self.manifest.id, "tool": tool })) })
        }
    }

    fn registry(providers: Vec<FakeProvider>) -> ToolRegistry {
        let mut registry = ToolRegistry::new();
        for provider in providers {
            registry
                .register(Arc::new(provider))
                .expect("registration must succeed");
        }
        registry
    }

    #[tokio::test]
    async fn a_call_reaches_the_provider_that_owns_it() {
        let registry = registry(vec![
            FakeProvider::new("a", &["alpha"]),
            FakeProvider::new("b", &["beta"]),
        ]);
        let result = registry.invoke("beta", &json!({})).await.unwrap();
        assert_eq!(result["provider"], "b");
        assert_eq!(result["tool"], "beta");
    }

    #[tokio::test]
    async fn an_unknown_tool_names_what_is_known() {
        let registry = registry(vec![FakeProvider::new("a", &["alpha"])]);
        let error = registry.invoke("nope", &json!({})).await.unwrap_err();
        let message = error.to_string();
        assert!(message.contains("unknown tool: nope"), "{message}");
        assert!(message.contains("alpha"), "{message}");
    }

    #[test]
    fn descriptors_keep_registration_order() {
        let registry = registry(vec![
            FakeProvider::new("a", &["alpha", "second"]),
            FakeProvider::new("b", &["beta"]),
        ]);
        let names: Vec<_> = registry
            .descriptors()
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert_eq!(names, ["alpha", "second", "beta"]);
    }

    #[test]
    fn a_tool_owned_twice_is_rejected_at_registration() {
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(FakeProvider::new("a", &["shared"])))
            .unwrap();
        let error = registry
            .register(Arc::new(FakeProvider::new("b", &["shared"])))
            .unwrap_err();
        assert!(error.to_string().contains("already provided"), "{error}");
    }

    #[test]
    fn a_duplicate_plugin_id_is_rejected() {
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(FakeProvider::new("same", &["one"])))
            .unwrap();
        let error = registry
            .register(Arc::new(FakeProvider::new("same", &["two"])))
            .unwrap_err();
        assert!(error.to_string().contains("already registered"), "{error}");
    }

    #[test]
    fn an_incompatible_api_version_is_refused() {
        let mut provider = FakeProvider::new("future", &["thing"]);
        provider.manifest.api = crate::plugins::PLUGIN_API_VERSION + 1;
        let mut registry = ToolRegistry::new();
        let error = registry.register(Arc::new(provider)).unwrap_err();
        assert!(error.to_string().contains("speaks api"), "{error}");
    }

    #[test]
    fn manifests_are_reported_in_order() {
        let registry = registry(vec![
            FakeProvider::new("a", &["alpha"]),
            FakeProvider::new("b", &["beta"]),
        ]);
        let ids: Vec<_> = registry
            .manifests()
            .into_iter()
            .map(|manifest| manifest.id)
            .collect();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn a_plugin_without_a_prompt_is_described_by_its_tools() {
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(FakeProvider::new("com.acme.notes", &["note_add"])))
            .unwrap();
        registry
            .register(Arc::new(FakeProvider::new("core.tools", &["time_now"])))
            .unwrap();
        registry
            .register(Arc::new(FakeProvider::new("com.acme.quiet", &[])))
            .unwrap();
        let prompts = registry.prompts();
        assert_eq!(
            prompts,
            vec![
                (
                    "com.acme.notes".to_string(),
                    "lets LILO note_add from com.acme.notes".to_string()
                ),
                (
                    "com.acme.quiet".to_string(),
                    "installed, with no voice abilities of its own".to_string()
                ),
            ]
        );
    }
}
