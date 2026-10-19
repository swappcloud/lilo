//! A browser is an optional host port, not a provider's vendor implementation.
use super::manifest::PluginManifest;
use super::provider::BoxFuture;
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Vendor selectors for the host's shared real-form phone sign-in driver.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneFormSpec {
    #[serde(default)]
    pub entry: String,
    #[serde(default)]
    pub entry_text: String,
    #[serde(default)]
    pub code_switch: String,
    #[serde(default)]
    pub code_inputs: String,
    #[serde(default)]
    pub phone_switch: String,
    #[serde(default)]
    pub code_needs_focus: bool,
}
impl PhoneFormSpec {
    fn valid(&self) -> bool {
        [
            &self.entry,
            &self.entry_text,
            &self.code_switch,
            &self.code_inputs,
            &self.phone_switch,
        ]
        .iter()
        .all(|value| value.len() <= 1024 && !value.chars().any(char::is_control))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSpec {
    pub login_url: String,
    pub home_url: String,
    pub allowed_hosts: Vec<String>,
    /// A JavaScript function returning {ready, name?}; it never returns credentials.
    pub session_probe: String,
    /// Reserved custom-driver declaration; current phone sign-in uses `phone_form`.
    #[serde(default)]
    pub phone_driver: Option<String>,
    #[serde(default)]
    pub phone_form: Option<PhoneFormSpec>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_browser_adapter_requires_exact_declared_origins_and_bounded_scripts() {
        let manifest = PluginManifest::new("com.fixture.voice", "Fixture", "1")
            .with_capabilities(&["provider:voice", "web:chat.qwen.ai"]);
        let mut spec = BrowserSpec {
            login_url: "https://chat.qwen.ai/auth".into(),
            home_url: "https://chat.qwen.ai/".into(),
            allowed_hosts: vec!["chat.qwen.ai".into()],
            session_probe: "async () => ({ready:false})".into(),
            phone_driver: None,
            phone_form: None,
        };
        assert!(spec.validate(&manifest).is_ok());
        spec.login_url = "https://foreign.example/auth".into();
        assert!(spec.validate(&manifest).is_err());
        spec.login_url = "https://chat.qwen.ai/auth".into();
        spec.session_probe = "x".repeat(70000);
        assert!(spec.validate(&manifest).is_err());
        spec.session_probe = "async () => ({ready:false})".into();
        spec.home_url = "https://user:password@chat.qwen.ai/".into();
        assert!(spec.validate(&manifest).is_err());
    }
    #[test]
    fn phone_form_declarations_are_optional_bounded_and_permission_checked() {
        let manifest = PluginManifest::new("com.fixture.voice", "Fixture", "1")
            .with_capabilities(&["provider:voice", "web:fixture.example"]);
        let mut spec: BrowserSpec = serde_json::from_value(serde_json::json!({
            "loginUrl":"https://fixture.example/auth", "homeUrl":"https://fixture.example/",
            "allowedHosts":["fixture.example"], "sessionProbe":"() => ({ready:false})",
            "phoneForm":{"entryText":"^log in$", "codeInputs":"input[autocomplete=one-time-code]"}
        }))
        .unwrap();
        assert!(spec.validate(&manifest).is_ok());
        spec.phone_form.as_mut().unwrap().entry_text = "x".repeat(1025);
        assert!(spec.validate(&manifest).is_err());
        spec.phone_form.as_mut().unwrap().entry_text = "line\nbreak".into();
        assert!(spec.validate(&manifest).is_err());
        spec.phone_form = None;
        assert!(spec.validate(&manifest).is_ok());
        assert!(spec
            .validate(&PluginManifest::new("com.fixture.voice", "Fixture", "1"))
            .is_err());
    }

    #[test]
    fn test_browser_calls_are_bounded_and_cannot_choose_another_owner() {
        assert!(BrowserRequest::new(
            "com.fixture.voice",
            "voice",
            "async () => ({})",
            serde_json::json!({})
        )
        .is_ok());
        assert!(BrowserRequest::new(
            "com.fixture.voice",
            "../voice",
            "async () => ({})",
            serde_json::json!({})
        )
        .is_err());
        assert!(BrowserRequest::new(
            "com.fixture.voice",
            "voice",
            "async () => ({})",
            serde_json::json!({"x":"a".repeat(600000)})
        )
        .is_err());
    }
    #[tokio::test]
    async fn test_browser_port_receives_the_publishers_authenticated_owner() {
        struct Fixture;
        impl BrowserPort for Fixture {
            fn evaluate<'a>(&'a self, request: BrowserRequest) -> BoxFuture<'a, Result<Value>> {
                Box::pin(async move {
                    Ok(serde_json::json!({"owner":request.owner,"provider":request.provider_id}))
                })
            }
        }
        let (bus, _) = super::super::bus::EventBus::new();
        let publisher = bus.publisher("com.fixture.voice");
        assert!(publisher
            .browser_evaluate("voice", "async () => ({})", serde_json::json!({}))
            .await
            .is_err());
        bus.set_browser_port(std::sync::Arc::new(Fixture));
        let result = publisher
            .browser_evaluate("voice", "async () => ({})", serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(result["owner"], "com.fixture.voice");
        assert_eq!(result["provider"], "voice");
    }
    #[tokio::test]
    async fn test_quickjs_adapter_can_negotiate_through_the_browser_port() {
        use super::super::provider::ToolProvider;
        struct Fixture;
        impl BrowserPort for Fixture {
            fn evaluate<'a>(&'a self, request: BrowserRequest) -> BoxFuture<'a, Result<Value>> {
                Box::pin(async move { Ok(serde_json::json!({"sdp":"v=0","owner":request.owner})) })
            }
        }
        let dir = std::env::temp_dir().join(format!("lilo-browser-port-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("provider.js"),r#"
            function describe(){return {voiceProviders:[{id:'voice',label:'Fixture',transport:{kind:'webrtc'},browser:{loginUrl:'https://fixture.example/auth',homeUrl:'https://fixture.example/',allowedHosts:['fixture.example'],sessionProbe:'async () => ({ready:false})'}}]};}
            function voice(request){return lilo.browser.call(request.providerId,'async () => ({})',request.args);}
        "#).unwrap();
        let manifest = PluginManifest::new("com.fixture.browser", "Fixture", "1")
            .with_capabilities(&["provider:voice", "web:fixture.example"]);
        let plugin =
            super::super::quickjs::QuickJsPlugin::start(&dir, manifest, "provider.js", &[])
                .unwrap();
        let (bus, _) = super::super::bus::EventBus::new();
        bus.set_browser_port(std::sync::Arc::new(Fixture));
        plugin.set_publisher(bus.publisher(&plugin.manifest().id));
        let request=super::super::voice::VoiceRequest::parse(serde_json::json!({"providerId":"voice","sessionId":"fixture-session","operation":"connect","args":{}})).unwrap();
        let result = plugin.invoke_voice(&request).await.unwrap();
        assert_eq!(result["owner"], "com.fixture.browser");
        assert_eq!(result["sdp"], "v=0");
        plugin.shutdown().await;
        drop(plugin);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

impl BrowserSpec {
    pub fn validate(&self, manifest: &PluginManifest) -> Result<()> {
        if self.phone_form.as_ref().is_some_and(|form| !form.valid())
            || self.allowed_hosts.is_empty()
            || self.allowed_hosts.len() > 8
            || self.session_probe.is_empty()
            || self.session_probe.len() > 65536
            || self
                .phone_driver
                .as_ref()
                .is_some_and(|script| script.is_empty() || script.len() > 65536)
        {
            return Err(AppError::other("Invalid provider browser declaration."));
        }
        for host in &self.allowed_hosts {
            if host.is_empty()
                || host.len() > 253
                || !host
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
                || !manifest
                    .capabilities
                    .iter()
                    .any(|cap| cap == &format!("web:{host}"))
            {
                return Err(AppError::other(
                    "Provider browser origins need explicit web permissions.",
                ));
            }
        }
        for value in [&self.login_url, &self.home_url] {
            let url = reqwest::Url::parse(value)
                .map_err(|_| AppError::other("Invalid provider browser URL."))?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || !url
                    .host_str()
                    .is_some_and(|host| self.allowed_hosts.iter().any(|allowed| allowed == host))
            {
                return Err(AppError::other(
                    "Provider browser URL is outside its declared origins.",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct BrowserRequest {
    pub owner: String,
    pub provider_id: String,
    pub script: String,
    pub args: Value,
}
impl BrowserRequest {
    pub fn new(owner: &str, provider: &str, script: &str, args: Value) -> Result<Self> {
        if provider.is_empty()
            || provider.len() > 64
            || !provider
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || script.is_empty()
            || script.len() > 65536
            || !args.is_object()
            || serde_json::to_vec(&args).map_or(true, |bytes| bytes.len() > 512 * 1024)
        {
            return Err(AppError::other("Invalid provider browser request."));
        }
        Ok(Self {
            owner: owner.into(),
            provider_id: provider.into(),
            script: script.into(),
            args,
        })
    }
}

/// A desktop webview adapter or a future headless browser adapter implements this port.
/// The plugin owns the protocol and login scripts; the host owns isolation and delivery.
pub trait BrowserPort: Send + Sync {
    fn evaluate<'a>(&'a self, request: BrowserRequest) -> BoxFuture<'a, Result<Value>>;
}
