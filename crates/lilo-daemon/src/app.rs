//! The headless box: stores, built-in tools, installed plugins and the command
//! router, wired the way a machine with no window needs them. Everything it
//! runs is `lilo-core`'s; what the daemon adds is the file and the loop.
//!
//! `docs/command-protocol.md` §9 is the plan this follows: the same registry
//! the desktop uses, no Tauri, no WebView, no UI — so a command that works in
//! the app works here.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use lilo_core::accounts::AccountStore;
use lilo_core::commands::manifest;
use lilo_core::commands::router::{CommandOutcome, Effect, Router, Speaker, Utterance};
use lilo_core::plugins::{self, EventBus, ToolProvider, ToolRegistry};
use lilo_core::settings::SettingsStore;

use crate::config::Config;
use crate::log;
#[path = "media.rs"]
mod media;
#[path = "voice_session.rs"]
mod voice_session;

/// How often the router is ticked. Captions arrive as partials once the audio
/// pipeline lands, and a free-text command only fires after its slot settles;
/// the desktop uses the same cadence, so both behave the same.
pub const TICK_MS: u64 = 250;

/// What one routed utterance produced.
pub struct Routed {
    pub command: String,
    pub tool: Option<String>,
    /// What the tool answered, already phrased for a transcript.
    pub summary: Option<String>,
    pub error: Option<String>,
}

/// A running LILO with no window.
pub struct Session {
    pub device: crate::device::DevicePreferences,
    pub browser_login: Option<crate::browser_login::BrowserLogin>,
    pub voice: Option<crate::voice::VoiceSession>,
    pub wake: crate::wake::WakeController,
    voice_turns: std::collections::VecDeque<(crate::voice::VoiceSpeaker, String)>,
    voice_seen: std::collections::VecDeque<(crate::voice::VoiceSpeaker, String, u64)>,
    pub data_dir: PathBuf,
    pub settings: SettingsStore,
    pub accounts: AccountStore,
    pub router: Router,
    plugins: Arc<tokio::sync::RwLock<ToolRegistry>>,
    bus: Arc<EventBus>,
    bus_task: tokio::task::AbortHandle,
    interaction_requests: tokio::sync::mpsc::Receiver<plugins::Event>,
    conversation_id: String,
    wake_phrase: String,
    assistant: String,
    locales: Vec<String>,
    tools_count: usize,
    plugins_loaded: usize,
    plugins_failed: Vec<String>,
    plugins_skipped: Vec<String>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.bus_task.abort();
    }
}

impl Session {
    /// Public management state, without account credentials or host secrets.
    pub async fn management_state(&self) -> serde_json::Value {
        let registry = self.plugins.read().await;
        let mut accounts = self.accounts.list();
        for account in &mut accounts {
            account.proxy.clear();
        }
        serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "wakePhrase": self.wake_phrase,
            "wake": self.wake.status(),
            "locales": self.locales,
            "plugins": plugins::installed_views_for_host(&self.data_dir.join("plugins"), &registry, "daemon"),
            "voiceAvailable": self.voice.as_ref().is_some_and(|voice| !voice.providers().is_empty()),
            "phoneLoginAvailable": self.browser_login.is_some(),
            "loginProviders": self.browser_login.as_ref().map(|login| login.providers.clone()).unwrap_or_default(),
            "accounts": accounts,
            "device": self.device,
        })
    }

    /// Stop one changed plugin, then load newly enabled folders exactly once.
    pub async fn reload_plugin(&mut self, id: &str) -> anyhow::Result<()> {
        self.stop_plugin(id).await;
        self.load_new_plugins(id).await
    }

    pub async fn plugin_provider(&self, id: &str) -> Option<Arc<dyn ToolProvider>> {
        self.plugins.read().await.provider(id)
    }

    pub async fn stop_plugin(&mut self, id: &str) {
        let removed = self.plugins.write().await.remove(id);
        self.router.remove_plugin_commands(id);
        if let Some(provider) = removed {
            provider.shutdown().await;
        }
    }

    async fn load_new_plugins(&mut self, id: &str) -> anyhow::Result<()> {
        let root = self.data_dir.join("plugins");
        let known: Vec<_> = self
            .plugins
            .read()
            .await
            .manifests()
            .into_iter()
            .map(|manifest| manifest.id)
            .collect();
        let outcome = plugins::load_dir_except_for_host(
            &root,
            |id| known.iter().any(|known| known == id),
            "daemon",
        )
        .await;
        for provider in outcome.plugins {
            let id = provider.manifest().id.clone();
            provider.set_publisher(self.bus.publisher(&id));
            provider.configure(plugins::store::load(&root, &id)).await?;
            register_provider(
                &mut *self.plugins.write().await,
                &mut self.router,
                provider.clone(),
            )?;
            for event in self.bus.retained_for(provider.as_ref()) {
                provider.on_event(&event).await;
            }
            provider.start().await;
        }
        if let Some((_, reason)) = outcome.failed.iter().find(|(failed, _)| {
            Path::new(failed).file_name().and_then(|name| name.to_str()) == Some(id)
        }) {
            anyhow::bail!("plugin could not start: {reason}");
        }
        Ok(())
    }

    /// Bring the box up, in the order the desktop does it so the two cannot
    /// drift: stores, built-in tools, installed plugins, then the router.
    pub async fn start(config: &Config, data_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)
            .with_context(|| format!("could not create {}", data_dir.display()))?;

        let settings = SettingsStore::load(data_dir.join("settings.json"));
        let device = crate::device::DevicePreferences::load(data_dir, config)?;
        let mut config = config.clone();
        config.wake_phrase = device.wake_phrase.clone();
        config.locales = device.locales.clone();
        let accounts = AccountStore::load(data_dir.join("accounts.json"));
        let http = reqwest::Client::builder()
            .user_agent(settings.get().user_agent)
            .build()
            .context("could not build the HTTP client")?;

        let (bus, mut events) = EventBus::new();
        let conversation_id = format!("daemon-{}", uuid::Uuid::new_v4());
        let mut tools = ToolRegistry::new();
        // Keep startup idle until the owner explicitly starts a provider voice session.
        bus.accept(
            &plugins::Event {
                topic: "session.changed".into(),
                source: "host".into(),
                payload: serde_json::json!({"supportLanguage":null, "sessionId":conversation_id,
                "state":"idle","provider":null}),
            },
            &tools,
        );
        let mut router = Router::new(config.assistant_name());
        router.set_locales(config.locales.clone());

        register_provider(
            &mut tools,
            &mut router,
            Arc::new(lilo_core::tools::BuiltinTools::new(http.clone())),
        )?;

        let media_service = Arc::new(lilo_core::media::service::MediaService::new(
            settings.get().media,
            http,
            data_dir.to_path_buf(),
        ));
        media_service.reap_orphans();
        let media_provider: Arc<dyn ToolProvider> =
            Arc::new(media::DaemonMediaProvider::new(media_service));
        media_provider.set_publisher(bus.publisher(&media_provider.manifest().id));
        register_provider(&mut tools, &mut router, media_provider.clone())?;
        media_provider.start().await;

        // Installed plugins: the same folders the app installs into, so the
        // marketplace works on a box with no display.
        let plugins_dir = data_dir.join("plugins");
        let computer: Arc<dyn ToolProvider> = Arc::new(lilo_core::plugins::ComputerApps::new());
        let stored = lilo_core::plugins::store::load(&plugins_dir, &computer.manifest().id);
        computer.configure(stored).await?;
        register_provider(&mut tools, &mut router, computer)?;
        std::fs::create_dir_all(&plugins_dir)
            .with_context(|| format!("could not create {}", plugins_dir.display()))?;
        let outcome = plugins::load_dir_for_host(&plugins_dir, "daemon").await;
        let plugins_loaded = outcome.plugins.len();
        for plugin in outcome.plugins {
            let id = plugin.manifest().id.clone();
            plugin.set_publisher(bus.publisher(&id));
            register_provider(&mut tools, &mut router, plugin.clone())?;
            let stored = plugins::store::load(&plugins_dir, &id);
            if stored.as_object().is_some_and(|object| !object.is_empty()) {
                if let Err(error) = plugin.configure(stored).await {
                    log::warn(format!("{id}: stored settings were not applied: {error}"));
                }
            }
            for event in bus.retained_for(plugin.as_ref()) {
                plugin.on_event(&event).await;
            }
            plugin.start().await;
        }
        let plugins_failed = outcome
            .failed
            .iter()
            .map(|(name, reason)| format!("{name}: {reason}"))
            .collect();
        let plugins_skipped = outcome.skipped.clone();

        let tools_count = tools.descriptors().len();
        let plugins = Arc::new(tokio::sync::RwLock::new(tools));
        let (interaction_tx, interaction_requests) = tokio::sync::mpsc::channel(8);

        // Publishers block until somebody drains the bus, and subscribers never
        // hear retained events without it.
        let bus_task = {
            let bus = bus.clone();
            let plugins = plugins.clone();
            let task = tokio::spawn(async move {
                let mut timer = tokio::time::interval(std::time::Duration::from_millis(250));
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    let event = tokio::select! {
                        event = events.recv() => match event { Some(event) => event, None => break },
                        _ = timer.tick() => { bus.tick(); continue; }
                    };
                    if event.topic == "interaction.requested"
                        && event.source == "host"
                        && interaction_tx.send(event.clone()).await.is_err()
                    {
                        break;
                    }
                    plugins::bus::dispatch(&bus, &plugins, event).await;
                }
            });
            task.abort_handle()
        };

        Ok(Session {
            device,
            browser_login: None,
            voice: None,
            wake: crate::wake::WakeController::new(),
            voice_turns: std::collections::VecDeque::new(),
            voice_seen: std::collections::VecDeque::new(),
            data_dir: data_dir.to_path_buf(),
            settings,
            accounts,
            router,
            plugins,
            bus,
            bus_task,
            interaction_requests,
            conversation_id,
            wake_phrase: config.wake_phrase().to_string(),
            assistant: config.assistant_name().to_string(),
            locales: config.locales.clone(),
            tools_count,
            plugins_loaded,
            plugins_failed,
            plugins_skipped,
        })
    }

    pub fn set_device_preferences(
        &mut self,
        preferences: crate::device::DevicePreferences,
    ) -> anyhow::Result<()> {
        preferences.save(&self.data_dir)?;
        self.wake_phrase = preferences.wake_phrase.trim().into();
        self.assistant = self
            .wake_phrase
            .split_whitespace()
            .next_back()
            .unwrap_or("lilo")
            .into();
        self.locales = preferences.locales.clone();
        self.router.set_name(&self.assistant);
        self.router.set_locales(self.locales.clone());
        self.device = preferences;
        Ok(())
    }

    /// Route one finished utterance — what the wake-word pipeline will call once
    /// speech-to-text has something final.
    pub(super) async fn route_caption(
        &mut self,
        text: &str,
        turn_id: &str,
        is_final: bool,
    ) -> Vec<Routed> {
        let outcomes = self.router.handle(
            Utterance {
                text,
                speaker: Speaker::User,
                turn_id,
                is_final,
            },
            now_ms(),
        );
        self.dispatch(outcomes).await
    }

    pub async fn route(&mut self, text: &str, turn_id: &str) -> Vec<Routed> {
        let first_seen_at = now_ms();
        let routed = self.route_caption(text, turn_id, true).await;
        plugins::bus::dispatch(
            &self.bus,
            &self.plugins,
            plugins::bus::Event {
                topic: "conversation.turn".into(),
                source: "host".into(),
                payload: serde_json::json!({
                    "sessionId": self.conversation_id,
                "at": now_ms(),
                "firstSeenAt": first_seen_at,
                    "turn": {"id": turn_id, "speaker": "user", "text": text, "final": true}
                }),
            },
        )
        .await;
        routed
    }

    /// Let parked commands fire — a free-text slot has settled — and return what
    /// they produced. The daemon ticks this on its own clock.
    pub async fn tick(&mut self) -> Vec<Routed> {
        let outcomes = self.router.tick(now_ms());
        self.dispatch(outcomes).await
    }

    async fn dispatch(&mut self, outcomes: Vec<CommandOutcome>) -> Vec<Routed> {
        let mut routed = Vec::new();
        for outcome in outcomes {
            let mut tool_result = serde_json::Value::Null;
            let mut end_voice_session = false;
            self.apply_effects(&outcome).await;
            let mut entry = Routed {
                command: outcome.command.clone(),
                tool: outcome.tool.clone(),
                summary: None,
                error: None,
            };
            if let Some(tool) = &outcome.tool {
                if !self.plugins.read().await.handles(tool) {
                    // A media command with no media service, for example: say
                    // so, instead of looking like a command that did nothing.
                    entry.error = Some(format!("nothing provides {tool}"));
                } else {
                    let result = self.plugins.read().await.invoke(tool, &outcome.args).await;
                    match result {
                        Ok(value) => {
                            entry.summary =
                                Some(manifest::describe(&outcome.command, &outcome.args, &value));
                            end_voice_session = plugins::result_ends_session(&value);
                            tool_result = value;
                        }
                        Err(error) => {
                            entry.error = Some(manifest::describe_error(
                                &outcome.command,
                                &error.to_string(),
                            ));
                        }
                    }
                }
            }
            if end_voice_session {
                log::info("Daemon voice is ending after playback started.");
                if self.stop_voice().await.is_err() {
                    log::warn("Daemon voice stop failed after playback started.");
                }
            } else if let Some(summary) = entry.summary.as_ref().or(entry.error.as_ref()) {
                if let Some(voice) = self.voice.as_mut() {
                    if voice.status().state == crate::voice::VoiceState::Connected {
                        match voice
                            .context(&manifest::hidden_note_with_context(summary, &tool_result))
                            .await
                        {
                            Ok(_) => log::info("Daemon voice delivered a tool result context."),
                            Err(_) => {
                                log::warn("Daemon voice could not deliver a tool result context.")
                            }
                        }
                    }
                }
            }
            routed.push(entry);
        }
        routed
    }

    async fn apply_effects(&mut self, outcome: &CommandOutcome) {
        if outcome
            .effects
            .iter()
            .any(|effect| matches!(effect, Effect::Confirm { .. }))
        {
            self.bus.interrupt_questions("command-confirmation");
        }
        for effect in &outcome.effects {
            match effect {
                Effect::Earcon { cue } => log::info(format!("earcon {cue:?}")),
                Effect::Toast { text } => log::info(format!("toast: {text}")),
                Effect::Confirm { command } => {
                    log::info(format!(
                        "{command} needs confirmation: say confirm or cancel"
                    ));
                }
                Effect::ClearConfirm => {}
                Effect::EndCall => {
                    if self.stop_voice().await.is_err() {
                        log::warn("Voice stop failed.");
                    }
                }
                effect => {
                    if let Some(voice) = self.voice.as_mut() {
                        if voice.status().state == crate::voice::VoiceState::Connected {
                            let result = match effect {
                                Effect::Interrupt => voice.interrupt().await,
                                Effect::SetMuted { muted } => voice.mute(*muted).await,
                                Effect::SendHidden { text } | Effect::SystemTurn { text } => {
                                    voice.context(text).await
                                }
                                _ => continue,
                            };
                            if result.is_err() {
                                log::warn("Voice control failed.");
                            }
                        }
                    }
                }
            }
        }
    }

    /// Ask every plugin to stop and flush, so nothing is left running.
    pub async fn shutdown(&self) {
        let mut context = self.bus.context();
        context.state = plugins::session::SessionState::Disconnected;
        context.session_id = None;
        plugins::bus::dispatch(
            &self.bus,
            &self.plugins,
            plugins::Event {
                topic: "session.changed".into(),
                source: "host".into(),
                payload: serde_json::to_value(context).unwrap_or_default(),
            },
        )
        .await;
        plugins::bus::dispatch(
            &self.bus,
            &self.plugins,
            plugins::bus::Event {
                topic: "conversation.ended".into(),
                source: "host".into(),
                payload: serde_json::json!({"sessionId": self.conversation_id, "at": now_ms()}),
            },
        )
        .await;
        let providers = self.plugins.read().await.providers();
        for provider in providers {
            provider.shutdown().await;
        }
        self.bus_task.abort();
    }

    /// The startup lines: what this box is and what it found. Never a token.
    pub fn report(&self) -> Vec<String> {
        let settings = self.settings.get();
        let mut lines = vec![
            format!("data:    {}", self.data_dir.display()),
            format!(
                "wake:    \"{}\" (assistant \"{}\")",
                self.wake_phrase, self.assistant
            ),
            format!(
                "locales: {}",
                if self.locales.is_empty() {
                    "all".to_string()
                } else {
                    self.locales.join(", ")
                }
            ),
            format!("tools:   {}", self.tools_count),
            format!(
                "plugins: {} loaded, {} failed, {} skipped",
                self.plugins_loaded,
                self.plugins_failed.len(),
                self.plugins_skipped.len()
            ),
            format!(
                "talk:    provider \"{}\", voice \"{}\" (conversation needs the satellite)",
                settings.provider_id, settings.default_voice
            ),
        ];
        for view in self.accounts.list() {
            lines.push(format!(
                "account: {} {} ({}, token {})",
                view.provider,
                view.email,
                view.status,
                if view.has_token { "yes" } else { "no" }
            ));
        }
        if self.accounts.list().is_empty() {
            lines.push("account: none signed in".to_string());
        }
        for failure in &self.plugins_failed {
            lines.push(format!("plugin failed: {failure}"));
        }
        lines
    }
}

/// Register a provider and let it contribute voice commands: the two things a
/// plugin brings to a box.
fn register_provider(
    tools: &mut ToolRegistry,
    router: &mut Router,
    provider: Arc<dyn ToolProvider>,
) -> anyhow::Result<()> {
    let id = provider.manifest().id.clone();
    let commands = provider.commands();
    tools.register(provider)?;
    if !commands.is_empty() {
        router.register_plugin_commands(&id, commands)?;
    }
    Ok(())
}

/// Milliseconds since the Unix epoch, the clock the router reasons about.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilo-daemon-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The plugin examples ship in the repository, and an installed plugin is
    /// just a folder: this copies one in, which is exactly what the marketplace
    /// does over HTTP.
    fn install_example(dir: &Path, name: &str) {
        let from = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/plugins")
            .join(name);
        let to = dir.join("plugins").join(name);
        copy_dir(&from, &to).unwrap();
    }

    fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let target = to.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_dir(&entry.path(), &target)?;
            } else {
                std::fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_builtin_command_runs_with_no_plugin_installed() {
        let dir = temp_dir("builtin");
        let config = Config::parse("locales = [\"pt\"]\n").unwrap();
        let mut session = Session::start(&config, &dir).await.unwrap();

        let routed = session.route("que horas são", "turn-1").await;
        assert_eq!(routed.len(), 1);
        assert_eq!(routed[0].command, "time.now");
        assert_eq!(routed[0].tool.as_deref(), Some("get_current_time"));
        assert!(routed[0].error.is_none(), "{:?}", routed[0].error);
        assert!(routed[0].summary.is_some());

        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn partial_song_captions_settle_without_a_provider_final_and_do_not_replay() {
        let dir = temp_dir("partial-media");
        let config = Config::parse("locales = [\"en\"]\n").unwrap();
        let mut session = Session::start(&config, &dir).await.unwrap();
        assert!(session
            .route_caption("play the song Walk", "song-turn", false)
            .await
            .is_empty());
        assert!(session
            .route_caption("play the song Walk by Pantera", "song-turn", false)
            .await
            .is_empty());
        let outcomes = session
            .router
            .tick(now_ms() + lilo_core::commands::router::SLOT_SETTLE_MS);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].tool.as_deref(), Some("media_play"));
        let query = outcomes[0].args.to_string().to_ascii_lowercase();
        assert!(
            query.contains("walk") && query.contains("pantera"),
            "{query}"
        );
        assert!(session
            .route("play the song Walk by Pantera", "song-turn")
            .await
            .is_empty());
        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn named_stop_music_control_runs_on_a_partial_caption_only_once() {
        let dir = temp_dir("partial-stop-music");
        let mut session = Session::start(&Config::default(), &dir).await.unwrap();
        let routed = session
            .route_caption("lilo stop music", "stop-turn", false)
            .await;
        assert_eq!(routed.len(), 1);
        assert_eq!(routed[0].tool.as_deref(), Some("media_stop"));
        assert!(routed[0].error.is_none());
        assert!(session
            .route("lilo stop music", "stop-turn")
            .await
            .is_empty());
        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn test_drop_stops_event_bus_task() {
        let dir = temp_dir("bus-drop");
        let session = Session::start(&Config::default(), &dir).await.unwrap();
        let task = session.bus_task.clone();
        drop(session);
        tokio::time::timeout(std::time::Duration::from_millis(100), async {
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("event bus must stop when its owner is dropped");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn test_shutdown_stops_event_bus_task() {
        let dir = temp_dir("bus-shutdown");
        let config = Config::parse("locales = [\"en\"]\n").unwrap();
        let session = Session::start(&config, &dir).await.unwrap();
        assert!(!session.bus_task.is_finished());
        session.shutdown().await;
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !session.bus_task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("event bus must stop after shutdown");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn test_study_records_headless_transcriptions_after_explicit_start() {
        let dir = temp_dir("study");
        install_example(&dir, "study");
        let config = Config::parse("locales = [\"en\"]\n").unwrap();
        let mut session = Session::start(&config, &dir).await.unwrap();
        session.route("let's study", "start").await;
        session
            .route("I need Italian for everyday life", "goal")
            .await;
        let memory = session
            .plugins
            .read()
            .await
            .invoke("study_context", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(memory["context"]
            .as_str()
            .unwrap()
            .contains("everyday life"));
        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_installed_plugin_brings_its_command_and_its_answer() {
        let dir = temp_dir("plugin");
        install_example(&dir, "hello");
        let config =
            Config::parse("wake_phrase = \"hello lilo\"\nlocales = [\"pt\", \"en\"]\n").unwrap();
        let mut session = Session::start(&config, &dir).await.unwrap();

        let routed = session.route("diga olá para Ada", "turn-1").await;
        assert_eq!(routed.len(), 1, "the plugin's command must match");
        assert_eq!(routed[0].command, "hello.greet");
        assert_eq!(routed[0].tool.as_deref(), Some("hello_greet"));
        let summary = routed[0].summary.clone().expect("a summary");
        // Slots arrive as the matcher normalizes them, lowercased — the app
        // hands plugins the same thing, so the daemon must not differ here.
        assert!(summary.contains("hello, ada"), "{summary}");

        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_phrase_nobody_owns_routes_to_nothing() {
        let dir = temp_dir("nomatch");
        let mut session = Session::start(&Config::default(), &dir).await.unwrap();
        assert!(session
            .route("bom dia, tudo bem", "turn-1")
            .await
            .is_empty());
        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn media_commands_are_provided_by_the_shared_media_service() {
        let dir = temp_dir("media");
        let config = Config::parse("locales = [\"pt\"]\n").unwrap();
        let session = Session::start(&config, &dir).await.unwrap();

        let registry = session.plugins.read().await;
        assert!(registry.handles("media_play"));
        let status = registry
            .invoke("media_status", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(status.get("playerFound").is_some());
        drop(registry);

        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_report_names_the_box_without_ever_printing_a_token() {
        let dir = temp_dir("report");
        let config = Config::parse("locales = [\"pt\"]\n").unwrap();
        let session = Session::start(&config, &dir).await.unwrap();
        let report = session.report().join("\n");
        assert!(report.contains("locales: pt"), "{report}");
        assert!(report.contains("account: none signed in"), "{report}");
        session.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
