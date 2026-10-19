//! How plugins talk to each other: topics, publish and subscribe.
//!
//! Chosen over direct calls between plugins because a publisher must not know
//! who listens: location publishes `location.changed`, and weather (or a future
//! plugin) subscribes without either depending on the other being installed.
//!
//! Topics are **retained**: the last event of each topic is kept, and a plugin
//! that subscribes later — installed after startup, restarted after a crash —
//! receives it at once instead of waiting for the next change.
//!
//! Delivery goes through the host, never plugin to plugin, so a sidecar in its
//! own process and an in-process plugin are reached the same way, and the host
//! can refuse a topic a plugin did not declare.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use super::provider::ToolProvider;
use super::registry::ToolRegistry;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// Dotted name, e.g. `location.changed`.
    pub topic: String,
    #[serde(default)]
    pub payload: Value,
    /// Id of the plugin (or `host`) that published it.
    #[serde(default)]
    pub source: String,
}

/// `location.*` matches `location.changed`; `*` matches everything.
pub fn topic_matches(pattern: &str, topic: &str) -> bool {
    if pattern == "*" || pattern == topic {
        return true;
    }
    pattern
        .strip_suffix(".*")
        .is_some_and(|prefix| topic.starts_with(prefix) && topic[prefix.len()..].starts_with('.'))
}

/// A handle to publish with. Cheap to clone; publishing never blocks.
#[derive(Clone)]
pub struct Publisher {
    source: String,
    sender: mpsc::UnboundedSender<Event>,
    context: Arc<Mutex<super::session::SessionContext>>,
    interactions: Arc<Mutex<super::interactions::Manager>>,
    voices: Arc<super::voice::VoiceHub>,
    browser_port: Arc<Mutex<Option<Arc<dyn super::browser::BrowserPort>>>>,
}

impl Publisher {
    pub async fn browser_evaluate(
        &self,
        provider: &str,
        script: &str,
        args: Value,
    ) -> crate::error::Result<Value> {
        let port = self
            .browser_port
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .ok_or_else(|| {
                crate::error::AppError::other(
                    "No provider browser adapter is installed on this host.",
                )
            })?;
        let request = super::browser::BrowserRequest::new(&self.source, provider, script, args)?;
        port.evaluate(request).await
    }

    pub fn voice_output(&self, output: Value) -> crate::error::Result<()> {
        self.voices.emit(&self.source, output)
    }
    pub fn cancel_voices(&self) {
        self.voices.close_owner(&self.source);
    }

    pub fn publish(&self, topic: &str, payload: Value) {
        let _ = self.sender.send(Event {
            topic: topic.to_string(),
            payload,
            source: self.source.clone(),
        });
    }

    /// The same channel, publishing as someone else.
    pub fn as_source(&self, source: &str) -> Publisher {
        Publisher {
            source: source.to_string(),
            sender: self.sender.clone(),
            context: self.context.clone(),
            interactions: self.interactions.clone(),
            voices: self.voices.clone(),
            browser_port: self.browser_port.clone(),
        }
    }

    pub fn session_context(&self) -> super::session::SessionContext {
        self.context
            .lock()
            .map(|context| context.clone())
            .unwrap_or_default()
    }

    pub fn interaction(&self, operation: &str, args: Value) -> crate::error::Result<Value> {
        let context = self.session_context();
        let mut manager = self
            .interactions
            .lock()
            .map_err(|_| crate::error::AppError::other("Interactions are unavailable."))?;
        let result = manager.request(
            &self.source,
            operation,
            args,
            &context,
            super::interactions::now_ms(),
        );
        let events = manager.take_events();
        drop(manager);
        for event in events {
            self.as_source("host").publish(event.topic, event.payload);
        }
        result
    }
    pub fn cancel_interactions(&self) {
        if let Ok(mut manager) = self.interactions.lock() {
            manager.cancel_owner(&self.source);
            let events = manager.take_events();
            drop(manager);
            for event in events {
                self.as_source("host").publish(event.topic, event.payload);
            }
        }
    }
}

/// Retained events plus the channel everyone publishes into.
pub struct EventBus {
    retained: Mutex<HashMap<String, Event>>,
    sender: mpsc::UnboundedSender<Event>,
    context: Arc<Mutex<super::session::SessionContext>>,
    interactions: Arc<Mutex<super::interactions::Manager>>,
    voices: Arc<super::voice::VoiceHub>,
    browser_port: Arc<Mutex<Option<Arc<dyn super::browser::BrowserPort>>>>,
}

impl EventBus {
    pub fn set_browser_port(&self, port: Arc<dyn super::browser::BrowserPort>) {
        if let Ok(mut slot) = self.browser_port.lock() {
            *slot = Some(port);
        }
    }

    pub fn voices(&self) -> Arc<super::voice::VoiceHub> {
        self.voices.clone()
    }

    /// The bus and the receiving end the host drains with [`EventBus::dispatch`].
    pub fn new() -> (Arc<EventBus>, mpsc::UnboundedReceiver<Event>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (
            Arc::new(EventBus {
                voices: Arc::new(super::voice::VoiceHub::default()),
                browser_port: Arc::new(Mutex::new(None)),
                retained: Mutex::new(HashMap::new()),
                sender,
                context: Arc::new(Mutex::new(super::session::SessionContext::default())),
                interactions: Arc::new(Mutex::new(super::interactions::Manager::default())),
            }),
            receiver,
        )
    }

    pub fn publisher(&self, source: &str) -> Publisher {
        Publisher {
            source: source.to_string(),
            sender: self.sender.clone(),
            context: self.context.clone(),
            interactions: self.interactions.clone(),
            voices: self.voices.clone(),
            browser_port: self.browser_port.clone(),
        }
    }

    pub fn context(&self) -> super::session::SessionContext {
        self.context
            .lock()
            .map(|context| context.clone())
            .unwrap_or_default()
    }

    /// Expire questions even when no captions or plugin callbacks arrive.
    pub fn interrupt_questions(&self, reason: &str) {
        if let Ok(mut manager) = self.interactions.lock() {
            manager.interrupt(reason);
            let events = manager.take_events();
            drop(manager);
            for event in events {
                self.publisher("host").publish(event.topic, event.payload);
            }
        }
    }

    /// Expire questions even when no captions or plugin callbacks arrive.
    pub fn tick(&self) {
        let context = self.context();
        if let Ok(mut manager) = self.interactions.lock() {
            manager.tick(&context, super::interactions::now_ms());
            let events = manager.take_events();
            drop(manager);
            for event in events {
                self.publisher("host").publish(event.topic, event.payload);
            }
        }
    }

    /// The last event of `topic`, if any.
    pub fn last(&self, topic: &str) -> Option<Event> {
        self.retained.lock().ok()?.get(topic).cloned()
    }

    /// Retain `event` and return the providers subscribed to it. The caller
    /// delivers *after* releasing its registry lock, like any other plugin
    /// call, so a slow subscriber never blocks the registry.
    pub fn accept(&self, event: &Event, registry: &ToolRegistry) -> Vec<Arc<dyn ToolProvider>> {
        if event.topic.starts_with("interaction.") && event.source != "host" {
            return Vec::new();
        }
        let validated = if event.topic.starts_with("session.") {
            if event.source != "host" || event.topic != "session.changed" {
                return Vec::new();
            }
            let Ok(context) = super::session::SessionContext::parse(event.payload.clone()) else {
                return Vec::new();
            };
            let Ok(mut snapshot) = self.context.lock() else {
                return Vec::new();
            };
            *snapshot = context.clone();
            Some(Event {
                payload: serde_json::to_value(context).unwrap_or(Value::Null),
                ..event.clone()
            })
        } else {
            None
        };
        let event = validated.as_ref().unwrap_or(event);
        if event.source == "host"
            && (event.topic.starts_with("conversation.")
                || event.topic.starts_with("session.")
                || event.topic == "interaction.delivery")
        {
            let context = self.context();
            if let Ok(mut manager) = self.interactions.lock() {
                manager.ingest(
                    &event.topic,
                    &event.payload,
                    &context,
                    super::interactions::now_ms(),
                );
                let events = manager.take_events();
                drop(manager);
                for event in events {
                    self.publisher("host").publish(event.topic, event.payload);
                }
            }
        }
        if !event.topic.starts_with("conversation.") && !event.topic.starts_with("interaction.") {
            if let Ok(mut retained) = self.retained.lock() {
                retained.insert(event.topic.clone(), event.clone());
            }
        }
        registry
            .providers()
            .into_iter()
            .filter(|provider| provider.manifest().id != event.source)
            .filter(|provider| {
                !event.topic.starts_with("interaction.")
                    || (provider
                        .manifest()
                        .capabilities
                        .iter()
                        .any(|cap| cap == "interaction:self")
                        && event.payload.get("pluginId").and_then(Value::as_str)
                            == Some(provider.manifest().id.as_str()))
            })
            .filter(|provider| {
                !event.topic.starts_with("session.")
                    || provider
                        .manifest()
                        .capabilities
                        .iter()
                        .any(|cap| cap == "session:read")
            })
            .filter(|provider| {
                !event.topic.starts_with("conversation.")
                    || (event.source == "host"
                        && provider
                            .manifest()
                            .capabilities
                            .iter()
                            .any(|cap| cap == "conversation:read"))
            })
            .filter(|provider| {
                provider
                    .subscriptions()
                    .iter()
                    .any(|pattern| topic_matches(pattern, &event.topic))
            })
            .collect()
    }

    /// Retained events a newly started provider subscribes to.
    pub fn retained_for(&self, provider: &dyn ToolProvider) -> Vec<Event> {
        let patterns = provider.subscriptions();
        let Ok(retained) = self.retained.lock() else {
            return Vec::new();
        };
        let mut events: Vec<Event> = retained
            .values()
            .filter(|event| event.source != provider.manifest().id)
            .filter(|event| {
                !event.topic.starts_with("session.")
                    || provider
                        .manifest()
                        .capabilities
                        .iter()
                        .any(|cap| cap == "session:read")
            })
            .filter(|event| {
                patterns
                    .iter()
                    .any(|pattern| topic_matches(pattern, &event.topic))
            })
            .cloned()
            .collect();
        events.sort_by(|a, b| a.topic.cmp(&b.topic));
        events
    }
}

/// Deliver one event to its subscribers, concurrently. Used by hosts that keep
/// the registry behind an async lock.
pub async fn dispatch(bus: &EventBus, registry: &tokio::sync::RwLock<ToolRegistry>, event: Event) {
    let subscribers = bus.accept(&event, &*registry.read().await);
    if event.topic.starts_with("conversation.")
        || event.topic.starts_with("session.")
        || event.topic.starts_with("interaction.")
    {
        let mut deliveries = tokio::task::JoinSet::new();
        for provider in subscribers {
            let event = event.clone();
            deliveries.spawn(async move {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    provider.on_event(&event),
                )
                .await;
            });
        }
        while deliveries.join_next().await.is_some() {}
        return;
    }
    let deliveries = subscribers
        .iter()
        .map(|provider| provider.on_event(&event))
        .collect::<Vec<_>>();
    for delivery in deliveries {
        delivery.await;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_interaction_events_are_private_to_the_owner_and_never_retained() {
        let (bus, _) = super::EventBus::new();
        let mut registry = super::ToolRegistry::new();
        let mut owner = listener("owner", &["interaction.*"]);
        std::sync::Arc::get_mut(&mut owner)
            .unwrap()
            .manifest
            .capabilities
            .push("interaction:self".into());
        registry.register(owner).unwrap();
        let mut other = listener("other", &["*"]);
        std::sync::Arc::get_mut(&mut other)
            .unwrap()
            .manifest
            .capabilities
            .push("interaction:self".into());
        registry.register(other).unwrap();
        let event = super::Event {
            topic: "interaction.changed".into(),
            source: "host".into(),
            payload: serde_json::json!({"pluginId":"owner","id":"local","status":"confirmed","answer":15}),
        };
        let subscribers = bus.accept(&event, &registry);
        assert_eq!(subscribers.len(), 1);
        assert_eq!(subscribers[0].manifest().id, "owner");
        assert!(bus.last("interaction.changed").is_none());
        assert!(bus
            .accept(
                &super::Event {
                    source: "other".into(),
                    ..event
                },
                &registry
            )
            .is_empty());
        let publisher = bus.publisher("owner");
        assert!(publisher
            .interaction("list", serde_json::json!({}))
            .unwrap()["active"]
            .is_null());
    }
    #[test]
    fn test_public_session_events_are_host_owned_and_permission_scoped() {
        let (bus, _) = super::EventBus::new();
        let mut registry = super::ToolRegistry::new();
        registry.register(listener("denied", &["*"])).unwrap();
        let mut allowed = listener("allowed", &["session.*"]);
        std::sync::Arc::get_mut(&mut allowed)
            .unwrap()
            .manifest
            .capabilities
            .push("session:read".into());
        registry.register(allowed).unwrap();
        let event = super::Event {
            topic: "session.changed".into(),
            source: "host".into(),
            payload: serde_json::json!({"supportLanguage":"it-IT","state":"idle"}),
        };
        assert_eq!(bus.accept(&event, &registry).len(), 1);
        assert_eq!(bus.context().support_language.as_deref(), Some("it-IT"));
        assert_eq!(
            bus.publisher("allowed")
                .session_context()
                .support_language
                .as_deref(),
            Some("it-IT")
        );
        let forged = super::Event {
            source: "denied".into(),
            payload: serde_json::json!({"supportLanguage":"en-US"}),
            ..event
        };
        assert!(bus.accept(&forged, &registry).is_empty());
        assert_eq!(bus.context().support_language.as_deref(), Some("it-IT"));
        assert!(bus
            .retained_for(listener("late-denied", &["*"]).as_ref())
            .is_empty());
        let invalid = super::Event {
            topic: "session.changed".into(),
            source: "host".into(),
            payload: serde_json::json!({"account":"private"}),
        };
        assert!(bus.accept(&invalid, &registry).is_empty());
        assert_eq!(bus.context().support_language.as_deref(), Some("it-IT"));
        let mut late = listener("late-allowed", &["session.changed"]);
        std::sync::Arc::get_mut(&mut late)
            .unwrap()
            .manifest
            .capabilities
            .push("session:read".into());
        assert_eq!(
            bus.retained_for(late.as_ref())[0].payload["platform"],
            std::env::consts::OS
        );
    }
    use super::*;
    use crate::error::Result;
    use crate::plugins::{BoxFuture, PluginManifest};
    use crate::tools::ToolDescriptor;
    use serde_json::json;

    struct Listener {
        manifest: PluginManifest,
        topics: Vec<String>,
        seen: Mutex<Vec<Event>>,
        delay: std::time::Duration,
    }

    impl ToolProvider for Listener {
        fn manifest(&self) -> &PluginManifest {
            &self.manifest
        }
        fn descriptors(&self) -> Vec<ToolDescriptor> {
            Vec::new()
        }
        fn handles(&self, _tool: &str) -> bool {
            false
        }
        fn invoke<'a>(&'a self, _tool: &'a str, _args: &'a Value) -> BoxFuture<'a, Result<Value>> {
            Box::pin(async { Ok(Value::Null) })
        }
        fn subscriptions(&self) -> Vec<String> {
            self.topics.clone()
        }
        fn on_event<'a>(&'a self, event: &'a Event) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                self.seen.lock().unwrap().push(event.clone());
            })
        }
    }

    fn listener(id: &str, topics: &[&str]) -> Arc<Listener> {
        Arc::new(Listener {
            manifest: PluginManifest::new(id, id, "1"),
            topics: topics.iter().map(|t| t.to_string()).collect(),
            seen: Mutex::new(Vec::new()),
            delay: std::time::Duration::ZERO,
        })
    }

    #[test]
    fn topics_match_exactly_or_by_prefix() {
        assert!(topic_matches("location.changed", "location.changed"));
        assert!(topic_matches("location.*", "location.changed"));
        assert!(topic_matches("*", "anything"));
        assert!(!topic_matches("location.*", "locationx.changed"));
        assert!(!topic_matches("location.changed", "location.lost"));
    }

    #[test]
    fn test_conversation_events_require_permission_and_are_not_retained() {
        let (bus, _) = EventBus::new();
        let mut registry = ToolRegistry::new();
        registry.register(listener("untrusted", &["*"])).unwrap();
        let mut permitted = listener("study", &["conversation.*"]);
        Arc::get_mut(&mut permitted)
            .unwrap()
            .manifest
            .capabilities
            .push("conversation:read".into());
        registry.register(permitted).unwrap();
        let event = Event {
            topic: "conversation.turn".into(),
            source: "host".into(),
            payload: json!({"text": "private"}),
        };
        let recipients = bus.accept(&event, &registry);
        assert_eq!(recipients.len(), 1);
        assert_eq!(recipients[0].manifest().id, "study");
        assert!(bus.last("conversation.turn").is_none());
        let forged = Event {
            source: "another-plugin".into(),
            ..event
        };
        assert!(bus.accept(&forged, &registry).is_empty());
    }

    #[tokio::test]
    async fn test_conversation_delivery_does_not_wait_for_a_stalled_plugin() {
        let (bus, _) = EventBus::new();
        let mut registry = ToolRegistry::new();
        let mut slow = listener("slow", &["conversation.*"]);
        let provider = Arc::get_mut(&mut slow).unwrap();
        provider
            .manifest
            .capabilities
            .push("conversation:read".into());
        provider.delay = std::time::Duration::from_secs(3);
        registry.register(slow).unwrap();
        let registry = tokio::sync::RwLock::new(registry);
        let event = Event {
            topic: "conversation.turn".into(),
            source: "host".into(),
            payload: json!({}),
        };
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(1),
            dispatch(&bus, &registry, event)
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn subscribers_receive_and_late_ones_get_the_retained_event() {
        let (bus, mut receiver) = EventBus::new();
        let weather = listener("weather", &["location.*"]);
        let other = listener("other", &["music.*"]);
        let mut registry = ToolRegistry::new();
        registry.register(weather.clone()).unwrap();
        registry.register(other.clone()).unwrap();
        let registry = tokio::sync::RwLock::new(registry);

        bus.publisher("location")
            .publish("location.changed", json!({ "latitude": 47.4 }));
        let event = receiver.recv().await.unwrap();
        assert_eq!(event.source, "location");
        dispatch(&bus, &registry, event).await;

        assert_eq!(weather.seen.lock().unwrap().len(), 1);
        assert!(other.seen.lock().unwrap().is_empty());

        // Installed later: it still learns the current location.
        let late = listener("late", &["location.changed"]);
        let retained = bus.retained_for(late.as_ref());
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].payload["latitude"], 47.4);
    }

    #[tokio::test]
    async fn a_publisher_does_not_hear_itself() {
        let (bus, _receiver) = EventBus::new();
        let echo = listener("echo", &["*"]);
        let mut registry = ToolRegistry::new();
        registry.register(echo.clone()).unwrap();
        let subscribers = bus.accept(
            &Event {
                topic: "echo.said".into(),
                payload: Value::Null,
                source: "echo".into(),
            },
            &registry,
        );
        assert!(subscribers.is_empty());
    }
}
