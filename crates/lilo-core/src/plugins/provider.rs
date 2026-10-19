//! What a provider must implement to own tools.
//!
//! `invoke` returns a boxed future instead of being an `async fn` in the trait:
//! object safety, no `async-trait` dependency, and one boxed allocation per
//! call is irrelevant next to a network request or a process spawn.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use crate::error::Result;
use crate::tools::ToolDescriptor;

use super::manifest::PluginManifest;
use super::ui::PluginUi;

/// A future that can cross an `&dyn` boundary.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait ToolProvider: Send + Sync {
    /// Identity and declared permissions. Fixed for the provider's lifetime.
    fn manifest(&self) -> &PluginManifest;

    /// Tools this provider owns. Drives the settings list and the model prompt,
    /// so a tool that is handled but never described is invisible to both.
    fn descriptors(&self) -> Vec<ToolDescriptor>;

    /// Cheap ownership test used for routing — no allocation, called per call.
    fn handles(&self, tool: &str) -> bool;

    /// Run one owned tool. Implementations must reject a tool they do not own
    /// rather than guessing, so a routing bug surfaces instead of misbehaving.
    fn invoke<'a>(&'a self, tool: &'a str, args: &'a Value) -> BoxFuture<'a, Result<Value>>;

    /// Voice lifecycle controls are private host RPCs, never model tools.
    fn voice_providers(&self) -> Vec<super::voice::VoiceProviderSpec> {
        Vec::new()
    }
    fn invoke_voice<'a>(
        &'a self,
        _request: &'a super::voice::VoiceRequest,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async {
            Err(crate::error::AppError::other(
                "This plugin has no voice transport.",
            ))
        })
    }

    /// What the plugin wants on screen. Empty for a provider with no UI — which
    /// is every built-in today, and is why this has a default.
    fn ui(&self) -> PluginUi {
        PluginUi::default()
    }

    /// Push settings down. The default accepts them: a provider that does not
    /// implement configuration simply reads them when it next runs.
    fn configure<'a>(&'a self, _settings: Value) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }

    /// One short paragraph for the model's briefing: what this provider lets
    /// the assistant do, in plain words. `None` when the tool list says enough.
    fn prompt(&self) -> Option<String> {
        None
    }
    /// Optional owned, read-only tool providing fresh context before a voice call.
    fn context_tool(&self) -> Option<String> {
        None
    }

    /// Voice commands this provider contributes. Built-in providers whose
    /// phrases live in the core registry return none.
    fn commands(&self) -> Vec<crate::commands::registry::CommandDescriptor> {
        Vec::new()
    }

    /// Where this provider's events go. Set by the host once the provider is
    /// registered; a provider that never publishes does not have to care.
    fn set_publisher(&self, _publisher: super::bus::Publisher) {}

    /// PIDs this provider runs, so the Storage panel can attribute memory and
    /// CPU to it. Empty for in-process providers, which are counted as the
    /// host.
    fn process_ids(&self) -> Vec<u32> {
        Vec::new()
    }

    /// Topics this provider listens to (`location.changed`, `location.*`).
    fn subscriptions(&self) -> Vec<String> {
        Vec::new()
    }

    /// One event on a subscribed topic. Never another provider's own event.
    fn on_event<'a>(&'a self, _event: &'a super::bus::Event) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    /// Called once the provider is registered, configured and has received the
    /// retained events it subscribes to: the place to do first work (resolve a
    /// location, open a connection) without blocking registration.
    fn start<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    /// Stop cleanly before the provider is dropped (flush files, close
    /// connections). The default has nothing to stop.
    fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}
