//! Precedence, debouncing and idempotence around the registry.
//!
//! The router is deliberately synchronous and takes the clock as a parameter:
//! it has to be exercised in tests without sleeping, and it has to run
//! identically inside the desktop app and inside the headless daemon.
//!
//! Effects are *data*, never UI calls. The React store turns them into toasts
//! and transcript turns; the Pi daemon turns them into chimes. That is what
//! lets one core serve both hosts.

use std::collections::HashMap;

use serde::Serialize;

use super::registry::{CommandDescriptor, CommandScope, Intent, Registry};
use crate::error::Result;

/// A matched command waits this long for the caption to stop growing before it
/// fires, unless the caption is already marked final. Captions stream as
/// growing deltas ("toca" -> "toca bohemian" -> "toca bohemian rhapsody"), so
/// acting on a partial would play the wrong song.
pub const SLOT_SETTLE_MS: u64 = 900;

/// The same command cannot fire twice within this window. The web path
/// re-delivers captions, and a burst of deltas must not queue five songs.
pub const COOLDOWN_MS: u64 = 2_500;

/// Words that never name anything on their own. A slot holding only these is
/// the beginning of a sentence, not an answer.
const DANGLING_WORDS: &[&str] = &[
    "the", "a", "an", "my", "some", "that", "this", "and", "of", "to", "for", "o", "os", "as",
    "um", "uma", "uns", "umas", "meu", "minha", "de", "do", "da", "dos", "das", "e", "essa",
    "esse", "aquela", "aquele",
];

/// Whether a filled slot is only a dangling function word.
///
/// `SLOT_SETTLE_MS` assumes a caption that stopped growing is a finished
/// sentence, but a person hesitating mid-phrase looks identical: "play the…"
/// settled and searched for a track named "the". A timer cannot tell the two
/// apart; the slot's own content can.
fn dangling_slot(intent: &Intent) -> bool {
    if !intent.has_slot {
        return false;
    }
    intent.args.values().any(|value| {
        let value = value.trim();
        !value.is_empty() && value.split(' ').all(|word| DANGLING_WORDS.contains(&word))
    })
}

/// Bookkeeping older than this is dropped, so a daemon running for weeks does
/// not grow a map per conversation turn.
const PRUNE_AFTER_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    User,
    Assistant,
    System,
}

/// Short non-speech cue for hosts without a screen. TTS stays out of scope, so
/// the Pi answers with a chime and with the music actually starting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cue {
    Ack,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Effect {
    /// Barge-in: stop the assistant mid-utterance.
    Interrupt,
    EndCall,
    SetMuted {
        muted: bool,
    },
    /// Hidden turn telling the model what LILO just did, so it narrates the
    /// result instead of claiming it cannot do it.
    SendHidden {
        text: String,
    },
    SystemTurn {
        text: String,
    },
    Toast {
        text: String,
    },
    Earcon {
        cue: Cue,
    },
    /// The command needs the user's go-ahead before it runs. The host asks,
    /// then calls `Router::resolve_confirmation` with the answer. Nothing has
    /// been executed at this point.
    Confirm {
        command: String,
    },
    /// Clear a confirmation answered by voice without requiring the UI.
    ClearConfirm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    pub command: String,
    pub scope: CommandScope,
    /// Tool the host must run for `scope = tool`, with `args`.
    pub tool: Option<String>,
    pub args: serde_json::Value,
    /// The utterance was a command: do not treat it as conversation.
    pub consume: bool,
    /// Applied immediately, before any tool runs.
    pub effects: Vec<Effect>,
}

#[derive(Debug, Clone, Copy)]
pub struct Utterance<'a> {
    pub text: &'a str,
    pub speaker: Speaker,
    /// Stable id of the transcript turn this caption belongs to.
    pub turn_id: &'a str,
    pub is_final: bool,
}

#[derive(Debug, Clone)]
struct Pending {
    intent: Intent,
    normalized: String,
    updated_ms: u64,
}

#[derive(Debug)]
pub struct Router {
    registry: Registry,
    name: String,
    locales: Vec<String>,
    /// turn_id -> commands already fired for that turn.
    fired: HashMap<String, Vec<String>>,
    /// command -> last fire, for the cooldown.
    last_fire: HashMap<String, u64>,
    /// turn_id -> a match waiting for the caption to settle.
    pending: HashMap<String, Pending>,
    last_seen: HashMap<String, u64>,
    /// Commands contributed by plugins, with the id of the plugin that owns
    /// each. Kept here because `rebuild()` builds a fresh registry from the
    /// built-ins, and a locale or wake-phrase change must not silently drop a
    /// plugin's phrases. The owner is what lets one plugin be withdrawn without
    /// touching the others.
    contributed: Vec<(String, CommandDescriptor)>,
    /// Matches waiting for the user to confirm, with when they arrived so a
    /// prompt nobody answers cannot be approved an hour later.
    awaiting: HashMap<String, (Intent, u64)>,
}

impl Router {
    pub fn new(name: &str) -> Self {
        Router {
            registry: Registry::new(name),
            name: name.to_string(),
            locales: Vec::new(),
            fired: HashMap::new(),
            last_fire: HashMap::new(),
            pending: HashMap::new(),
            last_seen: HashMap::new(),
            contributed: Vec::new(),
            awaiting: HashMap::new(),
        }
    }

    /// Rebuild the registry after the wake phrase changed.
    pub fn set_name(&mut self, name: &str) {
        self.name = name.to_string();
        self.rebuild();
    }

    /// Restrict matching to these locales. Empty means every locale.
    pub fn set_locales(&mut self, locales: Vec<String>) {
        self.locales = locales;
        self.rebuild();
    }

    pub fn locales(&self) -> &[String] {
        &self.locales
    }

    /// Add the commands one plugin contributes. All or nothing: a name that is
    /// already taken — by a built-in, by another plugin, or twice in the same
    /// list — rejects the whole set, so a plugin never ends up half-reachable.
    pub fn register_plugin_commands(
        &mut self,
        owner: &str,
        descriptors: Vec<CommandDescriptor>,
    ) -> Result<()> {
        let builtin = super::registry::builtin();
        for (index, descriptor) in descriptors.iter().enumerate() {
            let taken = builtin.iter().any(|b| b.name == descriptor.name)
                || self
                    .contributed
                    .iter()
                    .any(|(_, existing)| existing.name == descriptor.name)
                || descriptors[..index]
                    .iter()
                    .any(|earlier| earlier.name == descriptor.name);
            if taken {
                return Err(crate::error::AppError::other(format!(
                    "command {} was already contributed",
                    descriptor.name
                )));
            }
        }
        self.contributed
            .extend(descriptors.into_iter().map(|d| (owner.to_string(), d)));
        self.rebuild();
        Ok(())
    }

    /// Withdraw one plugin's commands, leaving every other plugin's in place.
    /// Returns how many were removed.
    pub fn remove_plugin_commands(&mut self, owner: &str) -> usize {
        let before = self.contributed.len();
        self.contributed.retain(|(existing, _)| existing != owner);
        let removed = before - self.contributed.len();
        if removed > 0 {
            self.rebuild();
        }
        removed
    }

    fn rebuild(&mut self) {
        let mut registry = Registry::with_locales(&self.name, &self.locales);
        if !self.contributed.is_empty() {
            // The contributed list is re-validated when it is added, so a
            // failure here would mean the built-ins changed underneath it.
            let _ = registry.register(
                self.contributed
                    .iter()
                    .map(|(_, descriptor)| descriptor.clone())
                    .collect(),
            );
        }
        self.registry = registry;
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// Forget per-conversation state. Called when a call ends or a new
    /// conversation starts, so the next call is not blocked by the last one.
    pub fn reset(&mut self) {
        self.fired.clear();
        self.last_fire.clear();
        self.awaiting.clear();
        self.pending.clear();
        self.last_seen.clear();
    }

    pub fn handle(&mut self, utterance: Utterance<'_>, now_ms: u64) -> Vec<CommandOutcome> {
        self.handle_with_policy(utterance, now_ms, false)
    }

    /// Route an offline/local transcript. It shares confirmation, settle,
    /// cooldown, and tool policy with provider captions while excluding
    /// prompt-only intents before router state changes.
    pub fn handle_local(&mut self, utterance: Utterance<'_>, now_ms: u64) -> Vec<CommandOutcome> {
        self.handle_with_policy(utterance, now_ms, true)
    }

    fn handle_with_policy(
        &mut self,
        utterance: Utterance<'_>,
        now_ms: u64,
        local_only: bool,
    ) -> Vec<CommandOutcome> {
        self.prune(now_ms);

        // Only the user issues commands. Matching the assistant's own captions
        // would let the model hang up its own call by reading a phrase aloud.
        if utterance.speaker != Speaker::User || utterance.text.trim_start().starts_with("[LILO]") {
            return Vec::new();
        }
        if utterance.is_final && self.awaiting.len() == 1 {
            let answer = super::matcher::normalize(utterance.text);
            let approved = match answer.as_str() {
                "confirm" | "confirm command" => Some(true),
                "cancel" | "cancel command" => Some(false),
                _ => None,
            };
            if let Some(approved) = approved {
                let command = self.awaiting.keys().next().unwrap().clone();
                let mut outcome = self
                    .resolve_confirmation(&command, approved)
                    .unwrap_or_else(|| CommandOutcome {
                        command,
                        scope: CommandScope::Tool,
                        tool: None,
                        args: serde_json::json!({}),
                        consume: true,
                        effects: vec![Effect::Toast {
                            text: "Command cancelled.".into(),
                        }],
                    });
                outcome.effects.insert(0, Effect::ClearConfirm);
                return vec![outcome];
            }
        }

        let intent = if local_only {
            self.registry.match_local_utterance(utterance.text)
        } else {
            self.registry.match_utterance(utterance.text)
        };
        let Some(intent) = intent else {
            self.pending.remove(utterance.turn_id);
            return Vec::new();
        };

        let normalized = super::matcher::normalize(utterance.text);

        if intent.has_slot && !utterance.is_final {
            // Free text still growing: hold it and let `tick` release it.
            let entry = self.pending.entry(utterance.turn_id.to_string());
            match entry {
                std::collections::hash_map::Entry::Occupied(mut slot) => {
                    let existing = slot.get_mut();
                    // Only restart the timer when the words actually changed —
                    // a repeated identical delta must not defer forever.
                    if existing.normalized != normalized {
                        existing.normalized = normalized;
                        existing.intent = intent;
                        existing.updated_ms = now_ms;
                    }
                }
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(Pending {
                        intent,
                        normalized,
                        updated_ms: now_ms,
                    });
                }
            }
            self.last_seen.insert(utterance.turn_id.to_string(), now_ms);
            return Vec::new();
        }

        self.pending.remove(utterance.turn_id);
        self.last_seen.insert(utterance.turn_id.to_string(), now_ms);
        self.fire(utterance.turn_id, intent, now_ms)
            .into_iter()
            .collect()
    }

    /// Release matches whose caption has stopped growing. The host calls this
    /// on a short interval.
    pub fn tick(&mut self, now_ms: u64) -> Vec<CommandOutcome> {
        let ready: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| now_ms.saturating_sub(p.updated_ms) >= SLOT_SETTLE_MS)
            .map(|(turn, _)| turn.clone())
            .collect();

        let mut outcomes = Vec::new();
        for turn_id in ready {
            if let Some(pending) = self.pending.remove(&turn_id) {
                outcomes.extend(self.fire(&turn_id, pending.intent, now_ms));
            }
        }
        self.prune(now_ms);
        outcomes
    }

    fn fire(&mut self, turn_id: &str, intent: Intent, now_ms: u64) -> Option<CommandOutcome> {
        if dangling_slot(&intent) {
            return None;
        }
        let already = self
            .fired
            .get(turn_id)
            .is_some_and(|names| names.contains(&intent.command));
        if already {
            return None;
        }
        if let Some(previous) = self.last_fire.get(&intent.command) {
            if now_ms.saturating_sub(*previous) < COOLDOWN_MS {
                return None;
            }
        }

        self.fired
            .entry(turn_id.to_string())
            .or_default()
            .push(intent.command.clone());
        self.last_fire.insert(intent.command.clone(), now_ms);
        self.last_seen.insert(turn_id.to_string(), now_ms);

        if intent.requires_confirm {
            // Park the work and ask. Emitting the outcome with no tool is what
            // makes "nothing happens until you say yes" true by construction.
            let command = intent.command.clone();
            // A replacement prompt invalidates the previous request.
            self.awaiting.clear();
            self.awaiting.insert(command.clone(), (intent, now_ms));
            return Some(CommandOutcome {
                command: command.clone(),
                scope: CommandScope::Tool,
                tool: None,
                args: serde_json::Value::Object(serde_json::Map::new()),
                consume: true,
                effects: vec![
                    Effect::Interrupt,
                    Effect::Confirm { command },
                    Effect::SendHidden {
                        text: "[LILO] This action is waiting for confirmation. Ask me to say confirm to approve it or cancel to decline it. Nothing has run yet.".into(),
                    },
                ],
            });
        }

        Some(build_outcome(intent))
    }

    /// Answer a pending confirmation.
    ///
    /// `Some(outcome)` is the work to run now; `None` means there was nothing
    /// waiting, or the user declined — in both cases the host does nothing.
    pub fn resolve_confirmation(
        &mut self,
        command: &str,
        approved: bool,
    ) -> Option<CommandOutcome> {
        let (intent, _) = self.awaiting.remove(command)?;
        if approved {
            Some(build_outcome(intent))
        } else {
            None
        }
    }

    /// True while a confirmation is waiting. Used by tests and by hosts that
    /// want to grey out conflicting actions.
    pub fn awaiting_confirmation(&self) -> Option<&str> {
        self.awaiting.keys().next().map(String::as_str)
    }

    fn prune(&mut self, now_ms: u64) {
        let stale: Vec<String> = self
            .last_seen
            .iter()
            .filter(|(_, seen)| now_ms.saturating_sub(**seen) > PRUNE_AFTER_MS)
            .map(|(turn, _)| turn.clone())
            .collect();
        for turn in stale {
            self.fired.remove(&turn);
            self.pending.remove(&turn);
            self.last_seen.remove(&turn);
        }
        // A prompt nobody answered must expire with everything else, or an
        // accidental "yes" much later would still fire the old command.
        self.awaiting
            .retain(|_, (_, asked)| now_ms.saturating_sub(*asked) <= PRUNE_AFTER_MS);
    }
}

fn build_outcome(intent: Intent) -> CommandOutcome {
    let args = serde_json::Value::Object(
        intent
            .args
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect(),
    );

    // The user's audio already reached the provider, so the model is about to
    // answer a command it cannot execute. Cutting it off is what keeps the
    // interaction from turning into "sorry, I can't play music".
    let mut effects = vec![Effect::Interrupt];

    match intent.scope {
        CommandScope::Session => {
            effects.push(Effect::EndCall);
            effects.push(Effect::Toast {
                text: "Conversation ended".to_string(),
            });
            effects.push(Effect::Earcon { cue: Cue::Ack });
        }
        CommandScope::Tool | CommandScope::App | CommandScope::Prompt => {
            // Tell the model to hold before it answers from imagination: the
            // tool result is seconds away, and it has already heard the request.
            effects.push(Effect::SendHidden {
                text: super::manifest::pending_note(&intent.command),
            });
            effects.push(Effect::Earcon { cue: Cue::Ack });
        }
    }

    CommandOutcome {
        command: intent.command.clone(),
        scope: intent.scope,
        tool: intent.tool.clone(),
        args,
        consume: true,
        effects,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user<'a>(text: &'a str, turn: &'a str, is_final: bool) -> Utterance<'a> {
        Utterance {
            text,
            speaker: Speaker::User,
            turn_id: turn,
            is_final,
        }
    }

    #[test]
    fn a_slotless_command_fires_immediately() {
        let mut router = Router::new("lilo");
        let out = router.handle(user("close lilo", "t1", false), 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command, "end-call");
        assert!(out[0].effects.contains(&Effect::EndCall));
        assert!(out[0].effects.contains(&Effect::Interrupt));
        assert!(out[0].consume);
    }

    #[test]
    fn a_free_text_command_waits_for_the_caption_to_settle() {
        let mut router = Router::new("lilo");

        // Growing deltas must not fire.
        assert!(router.handle(user("toca", "t1", false), 0).is_empty());
        assert!(router
            .handle(user("toca bohemian", "t1", false), 200)
            .is_empty());
        assert!(router
            .handle(user("toca bohemian rhapsody", "t1", false), 400)
            .is_empty());

        // Still growing at +800 ms: nothing yet.
        assert!(router.tick(800).is_empty());

        let out = router.tick(400 + SLOT_SETTLE_MS);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command, "media.play");
        assert_eq!(out[0].args["track"], "bohemian rhapsody");
    }

    #[test]
    fn a_hesitation_mid_sentence_is_not_a_command() {
        let mut router = Router::new("lilo");

        // "Play the…" then a pause longer than the settle window: the caption
        // stopped growing, but the sentence is not finished.
        assert!(router.handle(user("play the", "t1", false), 0).is_empty());
        assert!(
            router.tick(SLOT_SETTLE_MS).is_empty(),
            "a slot holding only \"the\" must not search for a track called \"the\""
        );

        // The rest of the sentence still works.
        assert!(router
            .handle(user("play the song bohemian rhapsody", "t1", false), 1_000)
            .is_empty());
        let out = router.tick(1_000 + SLOT_SETTLE_MS);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command, "media.play");
        assert_eq!(out[0].args["track"], "bohemian rhapsody");
    }

    #[test]
    fn a_final_caption_fires_without_waiting() {
        let mut router = Router::new("lilo");
        let out = router.handle(user("toca bohemian rhapsody", "t1", true), 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].args["track"], "bohemian rhapsody");
    }

    #[test]
    fn wake_prefixed_music_requests_route_to_the_media_tools() {
        let mut router = Router::new("lilo");
        let play = router.handle(user("lilo play the song Walk by Pantera", "play", true), 0);
        assert_eq!(play.len(), 1);
        assert_eq!(play[0].command, "media.play");
        assert_eq!(play[0].tool.as_deref(), Some("media_play"));
        assert_eq!(play[0].args["track"], "walk");
        assert_eq!(play[0].args["artist"], "pantera");

        let stop = router.handle(user("lilo stop music", "stop", true), 3_000);
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0].command, "media.stop");
        assert_eq!(stop[0].tool.as_deref(), Some("media_stop"));
    }

    #[test]
    fn repeated_identical_deltas_do_not_defer_forever() {
        let mut router = Router::new("lilo");
        router.handle(user("toca djavan", "t1", false), 0);
        // The same text redelivered must not restart the settle timer.
        router.handle(user("toca djavan", "t1", false), 300);
        router.handle(user("toca djavan", "t1", false), 600);
        let out = router.tick(SLOT_SETTLE_MS);
        assert_eq!(out.len(), 1, "identical redeliveries must still settle");
    }

    #[test]
    fn a_command_fires_once_per_turn() {
        let mut router = Router::new("lilo");
        let first = router.handle(user("close lilo", "t1", true), 0);
        let second = router.handle(user("close lilo", "t1", true), 10);
        assert_eq!(first.len(), 1);
        assert!(second.is_empty(), "same turn must not re-fire");
    }

    #[test]
    fn the_cooldown_blocks_an_immediate_repeat_on_a_new_turn() {
        let mut router = Router::new("lilo");
        assert_eq!(router.handle(user("pause", "t1", true), 0).len(), 1);
        assert!(
            router.handle(user("pause", "t2", true), 500).is_empty(),
            "a burst across turns must not double-fire"
        );
        assert_eq!(
            router
                .handle(user("pause", "t3", true), COOLDOWN_MS + 1)
                .len(),
            1,
            "after the cooldown it works again"
        );
    }

    #[test]
    fn the_assistant_cannot_issue_commands() {
        let mut router = Router::new("lilo");
        let out = router.handle(
            Utterance {
                text: "close lilo",
                speaker: Speaker::Assistant,
                turn_id: "t1",
                is_final: true,
            },
            0,
        );
        assert!(out.is_empty(), "reading a phrase aloud must not hang up");
    }

    #[test]
    fn unmatched_speech_produces_nothing() {
        let mut router = Router::new("lilo");
        assert!(router
            .handle(user("me conta uma história", "t1", true), 0)
            .is_empty());
    }

    #[test]
    fn a_pending_match_is_dropped_when_the_caption_stops_matching() {
        let mut router = Router::new("lilo");
        router.handle(user("toca alguma", "t1", false), 0);
        // The turn resolved into something that is not a command at all.
        router.handle(user("tocando aqui não importa o quê", "t1", false), 100);
        assert!(router.tick(2_000).is_empty());
    }

    #[test]
    fn tool_commands_carry_their_tool_and_args() {
        let mut router = Router::new("lilo");
        let out = router.handle(user("toca uma música do Djavan", "t1", true), 0);
        assert_eq!(out[0].tool.as_deref(), Some("media_play"));
        assert!(
            out[0].effects.iter().any(|e| matches!(
                e,
                Effect::SendHidden { text } if text.contains("wait")
            )),
            "the model must be told to wait rather than invent a result"
        );
        assert_eq!(out[0].args["artist"], "djavan");
        assert_eq!(out[0].scope, CommandScope::Tool);
    }

    #[test]
    fn reset_clears_per_conversation_state() {
        let mut router = Router::new("lilo");
        router.handle(user("pause", "t1", true), 0);
        router.reset();
        assert_eq!(
            router.handle(user("pause", "t1", true), 10).len(),
            1,
            "a fresh conversation starts clean"
        );
    }

    #[test]
    fn locales_can_be_narrowed_at_runtime() {
        let mut router = Router::new("lilo");
        router.set_locales(vec!["en".to_string()]);
        assert!(router
            .handle(user("toca a música creep", "t1", true), 0)
            .is_empty());
        assert_eq!(router.handle(user("play creep", "t2", true), 0).len(), 1);

        // Narrowing must survive a wake-phrase change.
        router.set_name("jarvis");
        assert!(router
            .handle(user("toca a música creep", "t3", true), 5_000)
            .is_empty());
    }

    #[test]
    fn set_name_follows_a_new_wake_phrase() {
        let mut router = Router::new("lilo");
        router.set_name("jarvis");
        assert!(router.handle(user("close lilo", "t1", true), 0).is_empty());
        assert_eq!(router.handle(user("close jarvis", "t2", true), 0).len(), 1);
    }

    #[test]
    fn stale_turns_are_pruned() {
        let mut router = Router::new("lilo");
        router.handle(user("close lilo", "t1", true), 0);
        router.tick(PRUNE_AFTER_MS + 1);
        assert!(router.fired.is_empty(), "bookkeeping must not grow forever");
    }

    #[test]
    fn effects_serialize_for_the_frontend() {
        let json = serde_json::to_string(&Effect::SendHidden {
            text: "playing".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"sendHidden","text":"playing"}"#);
    }

    fn plugin_command(name: &str, phrase: &str) -> CommandDescriptor {
        CommandDescriptor {
            name: name.to_string(),
            scope: CommandScope::Tool,
            tool: Some(format!("{name}_tool")),
            descriptions: vec![("en".into(), "Test.".into())],
            requires_confirm: false,
            templates: vec![("en".into(), phrase.to_string())],
            slot_words: Vec::new(),
            args: Vec::new(),
        }
    }

    #[test]
    fn desktop_dictation_keeps_literal_text_and_waits_for_confirmation() {
        let mut router = Router::new("lilo");
        let mut descriptor = plugin_command("desktop.type", "write in {app} text {!text}");
        descriptor.requires_confirm = true;
        router
            .register_plugin_commands("com.lilo.desktop", vec![descriptor])
            .unwrap();
        let source = "write in Editor text Hello, café!";
        assert!(router
            .handle(user(source, "dictation", false), 0)
            .is_empty());
        let outcomes = router.handle(user(source, "dictation", true), 100);
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].tool.is_none());
        assert_eq!(router.awaiting_confirmation(), Some("desktop.type"));
        let approved = router.resolve_confirmation("desktop.type", true).unwrap();
        assert_eq!(approved.args["app"], "editor");
        assert_eq!(approved.args["text"], "Hello, café!");
    }

    #[test]
    fn natural_editor_requests_capture_the_app_and_literal_text() {
        let mut router = Router::new("lilo");
        let mut open = plugin_command("desktop.openNatural", "(open|launch) {app}");
        open.slot_words = vec![(
            "app".into(),
            vec!["vs".into(), "vscode".into(), "code".into()],
        )];
        let mut write = plugin_command("desktop.type", "in {app} (write|type) {!text}");
        write.requires_confirm = true;
        router
            .register_plugin_commands("com.lilo.desktop", vec![open, write])
            .unwrap();
        let launched = router.handle(user("Lilo open my VS Code", "open", true), 0);
        assert_eq!(launched.len(), 1);
        assert_eq!(launched[0].args["app"], "my vs code");
        let pending = router.handle(
            user("Lilo in my VS Code write Hello, world!", "write", true),
            3000,
        );
        assert_eq!(pending.len(), 1);
        let approved = router.resolve_confirmation("desktop.type", true).unwrap();
        assert_eq!(approved.args["app"], "my vs code");
        assert_eq!(approved.args["text"], "Hello, world!");
        assert!(router
            .handle(
                user("Lilo in my VS Code create a new file", "create", true),
                6000
            )
            .is_empty());
        assert!(router
            .handle(
                user("Lilo correct the error in my VS Code", "correct", true),
                7000
            )
            .is_empty());
    }

    #[test]
    fn echoed_local_status_notes_are_not_user_commands() {
        let mut router = Router::new("lilo");
        router
            .register_plugin_commands(
                "com.lilo.desktop",
                vec![plugin_command("desktop.openNatural", "(open|launch) {app}")],
            )
            .unwrap();
        assert!(router
            .handle(user("[LILO] open my VS Code", "status", true), 0)
            .is_empty());
        assert!(router
            .handle(
                user(
                    "  [LILO] Application launch requested: Visual Studio Code",
                    "result",
                    true
                ),
                3000
            )
            .is_empty());
        assert_eq!(
            router
                .handle(user("LILO open my VS Code", "human", true), 6000)
                .len(),
            1
        );
    }

    #[test]
    fn voice_confirmation_uses_only_final_user_captions() {
        let mut router = Router::new("lilo");
        let mut descriptor = plugin_command("desktop.type", "write in {app} text {!text}");
        descriptor.requires_confirm = true;
        router
            .register_plugin_commands("com.lilo.desktop", vec![descriptor])
            .unwrap();
        router.handle(user("write in Editor text Hello!", "dictation", true), 0);
        assert!(router
            .handle(user("confirm", "answer", false), 100)
            .is_empty());
        assert!(router
            .handle(
                Utterance {
                    speaker: Speaker::Assistant,
                    ..user("confirm", "model", true)
                },
                200
            )
            .is_empty());
        let approved = router.handle(user("confirm", "answer", true), 300);
        assert_eq!(approved.len(), 1);
        assert_eq!(approved[0].args["text"], "Hello!");
        assert!(router.awaiting_confirmation().is_none());
        assert!(router
            .handle(user("confirm", "answer", true), 400)
            .is_empty());
    }

    #[test]
    fn voice_cancellation_clears_pending_work_without_executing() {
        let mut router = Router::new("lilo");
        let mut descriptor = plugin_command("desktop.type", "write in {app} text {!text}");
        descriptor.requires_confirm = true;
        router
            .register_plugin_commands("com.lilo.desktop", vec![descriptor])
            .unwrap();
        router.handle(user("write in Editor text Hello!", "dictation", true), 0);
        let cancelled = router.handle(user("cancel", "answer", true), 100);
        assert_eq!(cancelled.len(), 1);
        assert!(cancelled[0].tool.is_none());
        assert!(router.awaiting_confirmation().is_none());
        assert!(router.resolve_confirmation("desktop.type", true).is_none());
    }

    #[test]
    fn narrowing_locales_keeps_plugin_commands() {
        let mut router = Router::new("lilo");
        let mut command = plugin_command("a.ping", "ping alpha");
        command.templates.push(("pt".into(), "toca alpha".into()));
        command.descriptions.push(("pt".into(), "Teste.".into()));
        router
            .register_plugin_commands("com.a", vec![command])
            .unwrap();

        router.set_locales(vec!["pt".to_string()]);
        let out = router.handle(user("toca alpha", "t1", true), 0);
        assert_eq!(
            out.len(),
            1,
            "the plugin phrase must survive the locale change"
        );
        assert_eq!(out[0].command, "a.ping");
    }

    #[test]
    fn withdrawing_one_plugin_keeps_the_others_commands() {
        let mut router = Router::new("lilo");
        router
            .register_plugin_commands("com.a", vec![plugin_command("a.ping", "ping alpha")])
            .unwrap();
        router
            .register_plugin_commands("com.b", vec![plugin_command("b.ping", "ping bravo")])
            .unwrap();

        assert_eq!(router.remove_plugin_commands("com.a"), 1);
        assert!(router.handle(user("ping alpha", "t1", true), 0).is_empty());
        let out = router.handle(user("ping bravo", "t2", true), 10_000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].command, "b.ping");
    }

    #[test]
    fn a_plugin_cannot_take_a_builtin_name_or_repeat_itself() {
        let mut router = Router::new("lilo");
        let builtin = crate::commands::registry::builtin()[0].name.clone();
        assert!(router
            .register_plugin_commands("com.a", vec![plugin_command(&builtin, "zzz")])
            .is_err());
        assert!(router
            .register_plugin_commands(
                "com.a",
                vec![plugin_command("a.x", "one"), plugin_command("a.x", "two")]
            )
            .is_err());
        // A rejected set leaves nothing behind, and a later valid set still works.
        router
            .register_plugin_commands("com.a", vec![plugin_command("a.ok", "ping alpha")])
            .unwrap();
        assert_eq!(router.handle(user("ping alpha", "t1", true), 0).len(), 1);
    }
}
