//! Provider extensions share one lifecycle contract without exposing controls as tools.
use super::manifest::PluginManifest;
use super::session::ProtocolCapabilities;
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub const MAX_VOICE_PAYLOAD: usize = 512 * 1024;
const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOutput {
    pub plugin_id: String,
    pub provider_id: String,
    pub session_id: String,
    pub events: Vec<Value>,
    pub closed: bool,
}

/// Private, bounded delivery: providers cannot subscribe to another owner's audio.
pub struct VoiceHub {
    sessions: std::sync::Mutex<std::collections::BTreeMap<String, (String, String)>>,
    sender: tokio::sync::broadcast::Sender<VoiceOutput>,
}
impl Default for VoiceHub {
    fn default() -> Self {
        let (sender, _) = tokio::sync::broadcast::channel(128);
        Self {
            sessions: Default::default(),
            sender,
        }
    }
}
fn valid_event(event: &Value) -> bool {
    let text = |key: &str, max: usize| {
        event
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.len() <= max)
    };
    match event.get("type").and_then(Value::as_str) {
        Some("caption") => {
            text("id", 128)
                && event
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.len() <= 32768)
                && matches!(
                    event.get("speaker").and_then(Value::as_str),
                    Some("user" | "assistant")
                )
                && event.get("final").is_some_and(Value::is_boolean)
        }
        Some("audio") => event
            .get("audio")
            .and_then(Value::as_str)
            .is_some_and(|audio| {
                !audio.is_empty()
                    && audio.len() <= 48000
                    && audio.len() % 4 == 0
                    && audio.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')
                    })
            }),
        Some("response_started" | "input_started") => true,
        Some("state") => event.get("state").and_then(Value::as_str) == Some("connected"),
        Some("usage") => event
            .get("remainingSeconds")
            .and_then(Value::as_f64)
            .is_some_and(|seconds| seconds.is_finite() && seconds >= 0.0),
        Some("quota") => {
            event.get("kind").and_then(Value::as_str) == Some("daily")
                && event.get("retryAt").map_or(true, |value| {
                    value
                        .as_f64()
                        .is_some_and(|deadline| deadline.is_finite() && deadline > 0.0)
                })
        }
        Some("error") => text("message", 800),
        Some("frames") => event
            .get("frames")
            .and_then(Value::as_array)
            .is_some_and(|frames| {
                frames.len() <= 32
                    && frames
                        .iter()
                        .all(|frame| frame.is_string() || frame.is_object())
            }),
        Some("tool_call") => {
            text("id", 128) && text("name", 128) && event.get("args").is_some_and(Value::is_object)
        }
        _ => false,
    }
}

impl VoiceHub {
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<VoiceOutput> {
        self.sender.subscribe()
    }
    pub fn begin(
        &self,
        manifest: &PluginManifest,
        provider: &VoiceProviderSpec,
        session: &str,
    ) -> Result<()> {
        validate_specs(manifest, std::slice::from_ref(provider))?;
        if !local_id(session) {
            return Err(AppError::other("Invalid voice session identifier."));
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::other("Voice session lock unavailable."))?;
        if sessions.len() >= 8 || sessions.contains_key(session) {
            return Err(AppError::other(
                "Voice session already exists or capacity was reached.",
            ));
        }
        sessions.insert(session.into(), (manifest.id.clone(), provider.id.clone()));
        Ok(())
    }
    pub fn emit(&self, owner: &str, value: Value) -> Result<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Output {
            provider_id: String,
            session_id: String,
            events: Vec<Value>,
        }
        if serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_OUTPUT) {
            return Err(AppError::other("Voice output exceeds the host limit."));
        }
        let output: Output =
            serde_json::from_value(value).map_err(|_| AppError::other("Invalid voice output."))?;
        if output.events.is_empty()
            || output.events.len() > 64
            || output.events.iter().any(|event| !valid_event(event))
        {
            return Err(AppError::other("Invalid voice events."));
        }
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::other("Voice session lock unavailable."))?;
        if sessions.get(&output.session_id) != Some(&(owner.to_owned(), output.provider_id.clone()))
        {
            return Err(AppError::other(
                "Voice output does not belong to a live provider session.",
            ));
        }
        let _ = self.sender.send(VoiceOutput {
            plugin_id: owner.into(),
            provider_id: output.provider_id,
            session_id: output.session_id,
            events: output.events,
            closed: false,
        });
        Ok(())
    }
    pub fn check(&self, owner: &str, request: &VoiceRequest) -> Result<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::other("Voice session lock unavailable."))?;
        if sessions.get(&request.session_id)
            == Some(&(owner.to_owned(), request.provider_id.clone()))
        {
            Ok(())
        } else {
            Err(AppError::other(
                "Voice control requires an active owned session.",
            ))
        }
    }
    pub fn close(&self, owner: &str, session: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if sessions
                .get(session)
                .is_some_and(|(plugin, _)| plugin == owner)
            {
                if let Some((plugin_id, provider_id)) = sessions.remove(session) {
                    let _ = self.sender.send(VoiceOutput {
                        plugin_id,
                        provider_id,
                        session_id: session.into(),
                        events: vec![],
                        closed: true,
                    });
                }
            }
        }
    }
    pub fn close_owner(&self, owner: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|session, (plugin, provider)| {
                if plugin != owner {
                    return true;
                }
                let _ = self.sender.send(VoiceOutput {
                    plugin_id: plugin.clone(),
                    provider_id: provider.clone(),
                    session_id: session.clone(),
                    events: vec![],
                    closed: true,
                });
                false
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum VoiceTransport {
    /// The plugin owns the upstream protocol; the host captures and plays PCM16.
    Pcm {
        #[serde(default = "input_rate", rename = "inputSampleRate")]
        input_sample_rate: u32,
        #[serde(default = "output_rate", rename = "outputSampleRate")]
        output_sample_rate: u32,
    },
    /// The plugin negotiates SDP and translates its data-channel frames.
    Webrtc {
        #[serde(default = "default_channel", rename = "channelLabel")]
        channel_label: String,
        #[serde(default, rename = "remoteChannel")]
        remote_channel: bool,
    },
    /// Compatibility bridge for an adapter already installed by the host.
    Host { adapter: String },
}
fn default_channel() -> String {
    "oai-events".into()
}
fn input_rate() -> u32 {
    16000
}
fn output_rate() -> u32 {
    24000
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceSettingOption {
    pub value: String,
    pub label: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceSetting {
    pub key: String,
    pub label: String,
    pub default: String,
    pub options: Vec<VoiceSettingOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceProviderSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    pub transport: VoiceTransport,
    #[serde(default)]
    pub settings: Vec<VoiceSetting>,
    #[serde(default)]
    pub protocol: Option<ProtocolCapabilities>,
    #[serde(default)]
    pub browser: Option<super::browser::BrowserSpec>,
}

fn local_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn provider_id(owner: &str, local: &str) -> String {
    format!("plugin:{owner}/{local}")
}

pub fn validate_specs(manifest: &PluginManifest, providers: &[VoiceProviderSpec]) -> Result<()> {
    if providers.is_empty() {
        return Ok(());
    }
    if manifest.id.is_empty()
        || manifest.id.len() > 128
        || !manifest
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(AppError::other("Invalid voice provider owner identity."));
    }
    if providers.len() > 8
        || !manifest
            .capabilities
            .iter()
            .any(|scope| scope == "provider:voice")
    {
        return Err(AppError::other(
            "Voice providers need provider:voice permission and at most eight declarations.",
        ));
    }
    let mut ids = BTreeSet::new();
    for provider in providers {
        if !local_id(&provider.id)
            || !ids.insert(&provider.id)
            || provider.label.trim().is_empty()
            || provider.label.len() > 120
            || provider.description.len() > 800
        {
            return Err(AppError::other(
                "Invalid or duplicated plugin voice provider declaration.",
            ));
        }
        if !matches!(provider.transport, VoiceTransport::Host { .. })
            && provider
                .protocol
                .as_ref()
                .is_some_and(|protocol| protocol.inbound.images || protocol.outbound.image)
        {
            return Err(AppError::other(
                "Custom voice image transport is not implemented.",
            ));
        }
        let mut keys = BTreeSet::new();
        if provider.settings.len() > 16 {
            return Err(AppError::other("Too many provider settings."));
        }
        for setting in &provider.settings {
            let bounded = |value: &str, max: usize| {
                !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
            };
            let mut choices = BTreeSet::new();
            if !local_id(&setting.key)
                || !keys.insert(&setting.key)
                || !bounded(&setting.label, 120)
                || setting.options.is_empty()
                || setting.options.len() > 256
                || !setting.options.iter().all(|option| {
                    bounded(&option.value, 128)
                        && bounded(&option.label, 120)
                        && choices.insert(&option.value)
                })
                || !setting
                    .options
                    .iter()
                    .any(|option| option.value == setting.default)
            {
                return Err(AppError::other("Invalid provider settings declaration."));
            }
        }
        if let Some(browser) = &provider.browser {
            browser.validate(manifest)?;
        }
        match &provider.transport {
            VoiceTransport::Pcm {
                input_sample_rate,
                output_sample_rate,
            } => {
                if ![8000, 16000, 24000, 48000].contains(input_sample_rate)
                    || ![8000, 16000, 24000, 48000].contains(output_sample_rate)
                {
                    return Err(AppError::other("Unsupported PCM sample rate."));
                }
            }
            VoiceTransport::Webrtc { channel_label, .. } if !local_id(channel_label) => {
                return Err(AppError::other("Invalid provider data channel label."));
            }
            VoiceTransport::Host { adapter } if !local_id(adapter) => {
                return Err(AppError::other("Invalid host adapter identity."));
            }
            _ => {}
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceRequest {
    pub provider_id: String,
    pub operation: VoiceOperation,
    pub session_id: String,
    #[serde(default)]
    pub args: Value,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOperation {
    Connect,
    Disconnect,
    Audio,
    Text,
    Interrupt,
    Mute,
    Input,
    Output,
    Image,
    Event,
    ToolResult,
}
impl VoiceRequest {
    pub fn parse(value: Value) -> Result<Self> {
        if serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_VOICE_PAYLOAD) {
            return Err(AppError::other(
                "Plugin voice request exceeds the host limit.",
            ));
        }
        let request: Self = serde_json::from_value(value)
            .map_err(|_| AppError::other("Invalid plugin voice request."))?;
        if !local_id(&request.provider_id)
            || !local_id(&request.session_id)
            || !request.args.is_object()
        {
            return Err(AppError::other(
                "Invalid plugin voice request identifiers or arguments.",
            ));
        }
        Ok(request)
    }
    pub fn value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

pub fn validate_result(value: Value) -> Result<Value> {
    if !value.is_object()
        || serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_VOICE_PAYLOAD)
    {
        return Err(AppError::other(
            "Invalid or oversized plugin voice response.",
        ));
    }
    Ok(value)
}

/// Shared desktop/headless controller. Registry locks must be released before calling it.
pub async fn call(
    hub: &VoiceHub,
    plugin: &dyn super::provider::ToolProvider,
    value: Value,
) -> Result<Value> {
    let request = VoiceRequest::parse(value)?;
    let owner = &plugin.manifest().id;
    let provider = plugin
        .voice_providers()
        .into_iter()
        .find(|provider| provider.id == request.provider_id)
        .ok_or_else(|| AppError::other("Unknown plugin voice provider."))?;
    if matches!(provider.transport, VoiceTransport::Host { .. }) {
        return Err(AppError::other("Host adapters use their native lifecycle."));
    }
    if request.operation == VoiceOperation::Connect {
        hub.begin(plugin.manifest(), &provider, &request.session_id)?;
    } else {
        hub.check(owner, &request)?;
    }
    let result = plugin
        .invoke_voice(&request)
        .await
        .and_then(validate_result);
    if result.is_err() && request.operation != VoiceOperation::Disconnect {
        let cleanup = VoiceRequest {
            operation: VoiceOperation::Disconnect,
            args: serde_json::json!({}),
            ..request.clone()
        };
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            plugin.invoke_voice(&cleanup),
        )
        .await;
    }
    if request.operation == VoiceOperation::Disconnect || result.is_err() {
        hub.close(owner, &request.session_id);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::PluginManifest;

    #[test]
    fn test_voice_declarations_require_explicit_permission_and_unique_local_ids() {
        let declaration: VoiceProviderSpec = serde_json::from_value(serde_json::json!({
            "id":"voice", "label":"Example voice", "description":"Free web account voice",
            "transport":{"kind":"pcm"}
        }))
        .unwrap();
        let manifest = PluginManifest::new("com.example.voice", "Voice", "1");
        assert!(validate_specs(&manifest, std::slice::from_ref(&declaration)).is_err());
        let manifest = manifest.with_capabilities(&["provider:voice"]);
        assert!(validate_specs(&manifest, std::slice::from_ref(&declaration)).is_ok());
        assert!(validate_specs(&manifest, &[declaration.clone(), declaration]).is_err());
    }

    #[test]
    fn test_voice_settings_reject_unknown_defaults_and_duplicate_choices() {
        let manifest = PluginManifest::new("com.example.voice", "Voice", "1")
            .with_capabilities(&["provider:voice"]);
        let mut spec: VoiceProviderSpec = serde_json::from_value(serde_json::json!({
            "id":"voice", "label":"Fixture", "transport":{"kind":"pcm"},
            "settings":[{"key":"voice","label":"Voice","default":"one",
              "options":[{"value":"one","label":"One"},{"value":"two","label":"Two"}]}]
        }))
        .unwrap();
        assert!(validate_specs(&manifest, std::slice::from_ref(&spec)).is_ok());
        spec.settings[0].default = "missing".into();
        assert!(validate_specs(&manifest, std::slice::from_ref(&spec)).is_err());
        spec.settings[0].default = "one".into();
        spec.settings[0].options[1].value = "one".into();
        assert!(validate_specs(&manifest, std::slice::from_ref(&spec)).is_err());
        spec.settings[0].options[1].value = "two".into();
        spec.settings.push(spec.settings[0].clone());
        assert!(validate_specs(&manifest, &[spec]).is_err());
    }

    #[test]
    fn test_custom_voice_does_not_advertise_unimplemented_image_transport() {
        let manifest = PluginManifest::new("com.example.voice", "Voice", "1")
            .with_capabilities(&["provider:voice"]);
        let mut provider: VoiceProviderSpec = serde_json::from_value(
            serde_json::json!({"id":"voice","label":"Fixture","transport":{"kind":"pcm"}}),
        )
        .unwrap();
        let mut protocol = ProtocolCapabilities::default();
        protocol.outbound.image = true;
        provider.protocol = Some(protocol);
        assert!(validate_specs(&manifest, &[provider]).is_err());
    }

    #[test]
    fn test_voice_identity_is_namespaced_and_cannot_impersonate_core() {
        assert_eq!(
            provider_id("com.example.voice", "cloud"),
            "plugin:com.example.voice/cloud"
        );
        let manifest = PluginManifest::new("com.example.voice", "Voice", "1")
            .with_capabilities(&["provider:voice"]);
        let declaration: VoiceProviderSpec = serde_json::from_value(serde_json::json!({
            "id":"../chatgpt-web", "label":"Example", "transport":{"kind":"pcm"}
        }))
        .unwrap();
        assert!(validate_specs(&manifest, &[declaration]).is_err());
    }

    #[test]
    fn test_voice_control_request_is_bounded_and_has_an_explicit_operation() {
        assert!(VoiceRequest::parse(serde_json::json!({"providerId":"voice", "operation":"connect", "sessionId":"fixture-session", "args":{}})).is_ok());
        assert!(VoiceRequest::parse(serde_json::json!({"providerId":"voice", "operation":"execute", "sessionId":"fixture-session", "args":{}})).is_err());
        assert!(VoiceRequest::parse(serde_json::json!({"providerId":"voice", "operation":"audio", "sessionId":"fixture-session", "args":{"audio":"x".repeat(600000)}})).is_err());
    }
    #[test]
    fn test_voice_outputs_are_private_bounded_and_scoped_to_a_live_owner() {
        let manifest = PluginManifest::new("com.example.voice", "Voice", "1")
            .with_capabilities(&["provider:voice"]);
        let provider: VoiceProviderSpec = serde_json::from_value(serde_json::json!({
            "id":"voice", "label":"Example", "transport":{"kind":"pcm"}
        }))
        .unwrap();
        let hub = VoiceHub::default();
        let mut receiver = hub.subscribe();
        hub.begin(&manifest, &provider, "fixture-session").unwrap();
        let output = serde_json::json!({"providerId":"voice","sessionId":"fixture-session", "events":[{"type":"response_started"}]});
        assert!(hub.emit("foreign-plugin", output.clone()).is_err());
        hub.emit(&manifest.id, output.clone()).unwrap();
        let received = receiver.try_recv().unwrap();
        assert_eq!(received.plugin_id, manifest.id);
        assert_eq!(received.session_id, "fixture-session");
        assert!(hub.subscribe().try_recv().is_err());
        hub.close_owner(&manifest.id);
        assert!(receiver.try_recv().unwrap().closed);
        assert!(hub.emit(&manifest.id, output).is_err());
    }

    #[test]
    fn test_voice_output_rejects_malformed_audio_and_captions() {
        let manifest = PluginManifest::new("com.example.voice", "Voice", "1")
            .with_capabilities(&["provider:voice"]);
        let provider: VoiceProviderSpec = serde_json::from_value(
            serde_json::json!({"id":"voice","label":"Fixture","transport":{"kind":"pcm"}}),
        )
        .unwrap();
        let hub = VoiceHub::default();
        hub.begin(&manifest, &provider, "fixture-session").unwrap();
        for event in [
            serde_json::json!({"type":"caption","speaker":"system","text":"hidden"}),
            serde_json::json!({"type":"audio","audio":"invalid-base64!"}),
        ] {
            assert!(hub.emit(&manifest.id, serde_json::json!({"providerId":"voice","sessionId":"fixture-session","events":[event]})).is_err());
        }
    }

    #[tokio::test]
    async fn test_failed_connect_releases_plugin_upstream_resources() {
        use crate::plugins::provider::ToolProvider;
        let dir = std::env::temp_dir().join(format!("lilo-voice-cleanup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("provider.js"), r#"
            function describe() { return {voiceProviders:[{id:'voice',label:'Fixture',transport:{kind:'pcm'}}],publishes:['fixture.closed']}; }
            function voice(request) { if(request.operation==='connect') return null;
                if(request.operation==='disconnect') lilo.publish('fixture.closed',{sessionId:request.sessionId}); return {}; }
        "#).unwrap();
        let manifest = PluginManifest::new("com.fixture.cleanup", "Fixture", "1")
            .with_capabilities(&["provider:voice"]);
        let plugin =
            crate::plugins::quickjs::QuickJsPlugin::start(&dir, manifest, "provider.js", &[])
                .unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher(&plugin.manifest().id));
        let result=call(&bus.voices(),&plugin,serde_json::json!({"providerId":"voice","sessionId":"fixture-session","operation":"connect","args":{}})).await;
        assert!(result.is_err());
        assert_eq!(events.try_recv().unwrap().topic, "fixture.closed");
        plugin.shutdown().await;
        drop(plugin);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn test_plugin_voice_lifecycle_is_separate_from_model_tools() {
        use crate::plugins::provider::ToolProvider;
        let plugin_dir =
            std::env::temp_dir().join(format!("lilo-voice-contract-{}", std::process::id()));
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("provider.js"), r#"
            function describe() { return { voiceProviders: [{id: 'voice', label: 'Fixture', transport: {kind: 'pcm'}}] }; }
            function voice(request) { lilo.voice.publish({providerId: request.providerId, sessionId: request.sessionId, events: [{type: 'response_started'}]}); return {connected: true}; }
        "#).unwrap();
        let manifest = PluginManifest::new("com.example.voice", "Voice", "1")
            .with_capabilities(&["provider:voice"]);
        let plugin = crate::plugins::quickjs::QuickJsPlugin::start(
            &plugin_dir,
            manifest,
            "provider.js",
            &[],
        )
        .unwrap();
        assert!(plugin.descriptors().is_empty());
        assert_eq!(plugin.voice_providers().len(), 1);
        let (bus, mut public_events) = super::super::bus::EventBus::new();
        let mut output = bus.voices().subscribe();

        plugin.set_publisher(bus.publisher(&plugin.manifest().id));
        let request = VoiceRequest::parse(serde_json::json!({"providerId":"voice","sessionId":"fixture-session","operation":"connect","args":{}})).unwrap();
        assert_eq!(
            call(&bus.voices(), &plugin, request.value()).await.unwrap()["connected"],
            true
        );
        assert_eq!(
            output.try_recv().unwrap().events[0]["type"],
            "response_started"
        );
        assert!(public_events.try_recv().is_err());
        plugin.shutdown().await;
        assert!(output.try_recv().unwrap().closed);
        drop(plugin);
        std::fs::remove_dir_all(plugin_dir).unwrap();
    }

    #[test]
    fn test_voice_publisher_uses_authenticated_plugin_owner() {
        let (bus, mut public_events) = super::super::bus::EventBus::new();
        let manifest = PluginManifest::new("com.example.voice", "Voice", "1")
            .with_capabilities(&["provider:voice"]);
        let provider: VoiceProviderSpec = serde_json::from_value(
            serde_json::json!({"id":"voice","label":"Fixture","transport":{"kind":"pcm"}}),
        )
        .unwrap();
        bus.voices()
            .begin(&manifest, &provider, "fixture-session")
            .unwrap();
        let output = serde_json::json!({"providerId":"voice","sessionId":"fixture-session","events":[{"type":"response_started"}]});
        assert!(bus
            .publisher("foreign")
            .voice_output(output.clone())
            .is_err());
        assert!(bus.publisher(&manifest.id).voice_output(output).is_ok());
        assert!(public_events.try_recv().is_err());
    }
}
