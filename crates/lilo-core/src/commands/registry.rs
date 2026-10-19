//! The single manifest: every command is declared once here and feeds the
//! router, the settings UI and the prompt injected into the model.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::error::{AppError, Result};

use super::matcher::Pattern;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandScope {
    /// UI-level: the host applies it (open transcript, mute).
    App,
    /// The live call itself (hang up).
    Session,
    /// Runs a tool in this crate.
    Tool,
    /// Falls through to the model.
    Prompt,
}

impl CommandScope {
    /// Lower is higher priority — `app`/`session` outrank `tool`, which
    /// outranks `prompt`. Only used to break a specificity tie.
    fn rank(self) -> u8 {
        match self {
            CommandScope::App | CommandScope::Session => 0,
            CommandScope::Tool => 1,
            CommandScope::Prompt => 2,
        }
    }
}

/// A command a provider contributes.
///
/// Owned rather than `'static` on purpose: `&'static` descriptors can only be
/// written in this file, which is exactly what a plugin cannot do. Built-ins
/// are built by [`builtin`]; a provider registers its own list at runtime.
#[derive(Debug, Clone)]
pub struct CommandDescriptor {
    /// Stable id, e.g. `media.play`.
    pub name: String,
    pub scope: CommandScope,
    /// Tool executed for `scope = Tool`.
    pub tool: Option<String>,
    /// `(locale, text)`. The first entry is the fallback for an unlisted
    /// language, so the help panel is never left blank.
    pub descriptions: Vec<(String, String)>,
    pub requires_confirm: bool,
    /// `(locale, template)`. Locale is metadata only: a bilingual user mixes
    /// languages mid-sentence, so every pattern is always live.
    pub templates: Vec<(String, String)>,
    /// `(slot, words)`: the slot only matches when it contains one of these
    /// words (compared normalized). Lets a broad phrase like "make it {mood}"
    /// claim "make it rain" without also claiming "make it louder".
    pub slot_words: Vec<(String, Vec<String>)>,
    /// Fixed tool args, merged *under* the matched slots. Lets a phrase that
    /// carries no free text still tell the tool what it means: "turn the
    /// effect off" is `weather_mood` with `mood = off`.
    pub args: Vec<(String, String)>,
}

/// The primary subtag, lowercased: `pt-BR` -> `pt`, `it_IT` -> `it`.
fn primary_locale(tag: &str) -> String {
    tag.split(['-', '_'])
        .next()
        .unwrap_or(tag)
        .to_ascii_lowercase()
}

/// Whether a declared locale serves a requested one. Region is ignored, so a
/// descriptor written for `it` answers `it-IT` as readily as `it` — a tag must
/// never silently fall back to English just because it carries a region.
pub fn locale_serves(declared: &str, requested: &str) -> bool {
    primary_locale(declared) == primary_locale(requested)
}

/// Pick the localized string for `locale`, falling back to the first entry.
pub fn localized<'a>(entries: &'a [(String, String)], locale: &str) -> &'a str {
    entries
        .iter()
        .find(|(entry_locale, _)| locale_serves(entry_locale, locale))
        .or_else(|| entries.first())
        .map(|(_, text)| text.as_str())
        .unwrap_or_default()
}

/// What the settings UI and the model prompt see.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandManifestEntry {
    pub name: String,
    pub scope: CommandScope,
    pub tool: Option<String>,
    pub description: String,
    pub requires_confirm: bool,
    pub examples: Vec<String>,
}

pub fn builtin() -> Vec<CommandDescriptor> {
    vec![
    CommandDescriptor {
        name: "end-call".to_string(),
        scope: CommandScope::Session,
        tool: None,
        descriptions: vec![
            ("en".to_string(), "End the live conversation.".to_string()),
            ("pt".to_string(), "Encerra a conversa ativa.".to_string()),
            ("it".to_string(), "Termina la conversazione attiva.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            // The bare verbs require the assistant's name, or ordinary speech
            // ("I had to stop") would hang up the call.
            ("en".to_string(), "stop <name>".to_string()),
            ("en".to_string(), "close <name>".to_string()),
            ("en".to_string(), "end <name>".to_string()),
            ("en".to_string(), "quit <name>".to_string()),
            ("en".to_string(), "goodbye <name>".to_string()),
            ("en".to_string(), "bye <name>".to_string()),
            ("en".to_string(), "hang up <name>".to_string()),
            ("en".to_string(), "hang up".to_string()),
            ("en".to_string(), "end [the] call".to_string()),
            ("pt".to_string(), "para <name>".to_string()),
            ("pt".to_string(), "fecha <name>".to_string()),
            ("pt".to_string(), "encerra <name>".to_string()),
            ("pt".to_string(), "desliga <name>".to_string()),
            ("pt".to_string(), "tchau <name>".to_string()),
            ("pt".to_string(), "encerra [a] chamada".to_string()),
            ("pt".to_string(), "desliga [a] chamada".to_string()),
            ("it".to_string(), "ferma <name>".to_string()),
            ("it".to_string(), "chiudi <name>".to_string()),
            ("it".to_string(), "termina <name>".to_string()),
            ("it".to_string(), "spegni <name>".to_string()),
            ("it".to_string(), "ciao <name>".to_string()),
            ("it".to_string(), "termina [la] chiamata".to_string()),
            ("it".to_string(), "chiudi [la] chiamata".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "media.play".to_string(),
        scope: CommandScope::Tool,
        tool: Some("media_play".to_string()),
        descriptions: vec![
            ("en".to_string(), "Play a song, or something by an artist.".to_string()),
            ("pt".to_string(), "Toca uma música, ou algo de um artista.".to_string()),
            ("it".to_string(), "Riproduci una canzone, o qualcosa di un artista.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "(toca|toque|tocar|coloca|coloque|põe|ponha|bota) [a|uma|o] música {track} (do|da|de) {artist}".to_string()),
            ("pt".to_string(), "(toca|toque|tocar|coloca|coloque|põe|ponha|bota) [a|uma|o] música {track}".to_string()),
            ("pt".to_string(), "(toca|toque|tocar|coloca|coloque|põe|ponha|bota) [uma] música (do|da|de) {artist}".to_string()),
            ("pt".to_string(), "(toca|toque|tocar|coloca|coloque|põe|ponha|bota) [alguma] coisa (do|da|de) {artist}".to_string()),
            ("pt".to_string(), "(toca|toque|tocar|coloca|coloque|põe|ponha|bota) {track} (do|da|de) {artist}".to_string()),
            ("pt".to_string(), "(toca|toque|tocar|coloca|coloque|põe|ponha|bota) {track}".to_string()),
            ("pt".to_string(), "tocar {track}".to_string()),
            ("pt".to_string(), "coloca [a|uma] música {track}".to_string()),
            ("pt".to_string(), "põe [a|uma] música {track}".to_string()),
            ("pt".to_string(), "manda [a|uma] música {track}".to_string()),
            ("pt".to_string(), "reproduzir {track}".to_string()),
            ("pt".to_string(), "reproduz {track}".to_string()),
            ("pt".to_string(), "(toca|coloca|põe|bota) [alguma|uma] (música|coisa)".to_string()),
            ("pt".to_string(), "quero (ouvir|escutar) [alguma|uma] música".to_string()),
            ("it".to_string(), "riproduci [la|una] canzone {track} (di) {artist}".to_string()),
            ("it".to_string(), "riproduci [la|una] canzone {track}".to_string()),
            ("it".to_string(), "riproduci [una] canzone (di) {artist}".to_string()),
            ("it".to_string(), "riproduci [qualcosa|qualche cosa] di {artist}".to_string()),
            ("it".to_string(), "(riproduci|metti|suona) {track} (di) {artist}".to_string()),
            ("it".to_string(), "riproduci {track}".to_string()),
            ("it".to_string(), "riprodurre {track}".to_string()),
            ("it".to_string(), "metti [la|una] canzone {track}".to_string()),
            ("it".to_string(), "metti [la|una] musica {track}".to_string()),
            ("it".to_string(), "metti su {track}".to_string()),
            ("it".to_string(), "manda [la|una] canzone {track}".to_string()),
            ("it".to_string(), "suona {track}".to_string()),
            ("it".to_string(), "(metti|suona|riproduci) [della|un po di] musica".to_string()),
            ("it".to_string(), "voglio (ascoltare|sentire) [della] musica".to_string()),
            ("en".to_string(), "play [the] song {track} (by) {artist}".to_string()),
            ("en".to_string(), "play [the] song {track}".to_string()),
            ("en".to_string(), "play something (by) {artist}".to_string()),
            ("en".to_string(), "play [some] music (by) {artist}".to_string()),
            ("en".to_string(), "play {track} (by) {artist}".to_string()),
            ("en".to_string(), "play {track}".to_string()),
            ("en".to_string(), "put on {track}".to_string()),
            ("en".to_string(), "play [some] music".to_string()),
            ("en".to_string(), "put on some music".to_string()),
            ("en".to_string(), "I want to hear [some] music".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "media.radio".to_string(),
        scope: CommandScope::Tool,
        tool: Some("media_radio".to_string()),
        descriptions: vec![
            ("en".to_string(), "Keep playing songs like the current one.".to_string()),
            ("pt".to_string(), "Continua tocando músicas parecidas com a atual.".to_string()),
            ("it".to_string(), "Continua con canzoni simili a quella attuale.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "(toca|coloca|põe) [umas|mais] músicas (parecidas|similares|relacionadas)".to_string()),
            ("pt".to_string(), "músicas (parecidas|similares|relacionadas)".to_string()),
            ("pt".to_string(), "(toca|coloca|põe) mais músicas assim".to_string()),
            ("pt".to_string(), "continua tocando".to_string()),
            ("pt".to_string(), "modo rádio".to_string()),
            ("it".to_string(), "(riproduci|metti) [delle|altre] canzoni (simili|correlate)".to_string()),
            ("it".to_string(), "canzoni (simili|correlate)".to_string()),
            ("it".to_string(), "continua a suonare".to_string()),
            ("en".to_string(), "play [some|more] (similar|related) (songs|music)".to_string()),
            ("en".to_string(), "(similar|related) (songs|music)".to_string()),
            ("en".to_string(), "play more like this".to_string()),
            ("en".to_string(), "keep [the] music going".to_string()),
            ("en".to_string(), "radio mode".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "media.pause".to_string(),
        scope: CommandScope::Tool,
        tool: Some("media_pause".to_string()),
        descriptions: vec![
            ("en".to_string(), "Pause playback.".to_string()),
            ("pt".to_string(), "Pausa a reprodução.".to_string()),
            ("it".to_string(), "Mette in pausa la riproduzione.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "pausa [a] música".to_string()),
            ("pt".to_string(), "pausar [a] música".to_string()),
            ("pt".to_string(), "pausa".to_string()),
            ("it".to_string(), "metti in pausa [la] musica".to_string()),
            ("it".to_string(), "metti in pausa".to_string()),
            ("it".to_string(), "pausa".to_string()),
            ("en".to_string(), "pause [the] music".to_string()),
            ("en".to_string(), "pause".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "media.resume".to_string(),
        scope: CommandScope::Tool,
        tool: Some("media_resume".to_string()),
        descriptions: vec![
            ("en".to_string(), "Resume playback.".to_string()),
            ("pt".to_string(), "Continua a reprodução.".to_string()),
            ("it".to_string(), "Riprende la riproduzione.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "continua [a] música".to_string()),
            ("pt".to_string(), "retoma [a] música".to_string()),
            ("pt".to_string(), "volta a tocar".to_string()),
            ("it".to_string(), "riprendi [la] musica".to_string()),
            ("it".to_string(), "continua [la] musica".to_string()),
            ("it".to_string(), "torna a suonare".to_string()),
            ("en".to_string(), "resume [the] music".to_string()),
            ("en".to_string(), "continue [the] music".to_string()),
            ("en".to_string(), "unpause".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "media.stop".to_string(),
        scope: CommandScope::Tool,
        tool: Some("media_stop".to_string()),
        descriptions: vec![
            ("en".to_string(), "Stop playback and clear the queue.".to_string()),
            ("pt".to_string(), "Para a reprodução e limpa a fila.".to_string()),
            ("it".to_string(), "Ferma la riproduzione e svuota la coda.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "para [a] música".to_string()),
            ("pt".to_string(), "parar [a] música".to_string()),
            ("pt".to_string(), "desliga [a] música".to_string()),
            ("pt".to_string(), "para de tocar".to_string()),
            ("it".to_string(), "ferma [la] musica".to_string()),
            ("it".to_string(), "fermare [la] musica".to_string()),
            ("it".to_string(), "spegni [la] musica".to_string()),
            ("it".to_string(), "smetti di suonare".to_string()),
            ("en".to_string(), "stop [the] music".to_string()),
            ("en".to_string(), "stop playing".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "media.next".to_string(),
        scope: CommandScope::Tool,
        tool: Some("media_next".to_string()),
        descriptions: vec![
            ("en".to_string(), "Skip to the next track.".to_string()),
            ("pt".to_string(), "Pula para a próxima faixa.".to_string()),
            ("it".to_string(), "Passa alla traccia successiva.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "próxima [música|faixa]".to_string()),
            ("pt".to_string(), "pula [essa|a] música".to_string()),
            ("it".to_string(), "prossima [musica|canzone|traccia]".to_string()),
            ("it".to_string(), "canzone successiva".to_string()),
            ("it".to_string(), "salta [questa|la] canzone".to_string()),
            ("en".to_string(), "next [song|track]".to_string()),
            ("en".to_string(), "skip [this] [song|track]".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "media.previous".to_string(),
        scope: CommandScope::Tool,
        tool: Some("media_previous".to_string()),
        descriptions: vec![
            ("en".to_string(), "Go back to the previous track.".to_string()),
            ("pt".to_string(), "Volta para a faixa anterior.".to_string()),
            ("it".to_string(), "Torna alla traccia precedente.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "música anterior".to_string()),
            ("pt".to_string(), "faixa anterior".to_string()),
            ("pt".to_string(), "volta [uma] música".to_string()),
            ("it".to_string(), "musica precedente".to_string()),
            ("it".to_string(), "canzone precedente".to_string()),
            ("it".to_string(), "traccia precedente".to_string()),
            ("en".to_string(), "previous [song|track]".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "media.volume".to_string(),
        scope: CommandScope::Tool,
        tool: Some("media_volume".to_string()),
        descriptions: vec![
            ("en".to_string(), "Set playback volume (0-100).".to_string()),
            ("pt".to_string(), "Define o volume da reprodução (0-100).".to_string()),
            ("it".to_string(), "Imposta il volume della riproduzione (0-100).".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "coloca o volume [em|no|para] {level}".to_string()),
            ("pt".to_string(), "põe o volume [em|no|para] {level}".to_string()),
            ("pt".to_string(), "volume {level}".to_string()),
            ("it".to_string(), "imposta il volume [a|al|su] {level}".to_string()),
            ("it".to_string(), "metti il volume [a|al|su] {level}".to_string()),
            ("it".to_string(), "volume {level}".to_string()),
            ("en".to_string(), "set [the] volume [to] {level}".to_string()),
            ("en".to_string(), "volume {level}".to_string()),
        ],
        slot_words: Vec::new(),
        args: Vec::new(),
    },
    CommandDescriptor {
        name: "time.now".to_string(),
        scope: CommandScope::Tool,
        tool: Some("get_current_time".to_string()),
        descriptions: vec![
            ("en".to_string(), "Tell the current time.".to_string()),
            ("pt".to_string(), "Diz as horas.".to_string()),
            ("it".to_string(), "Dice l'ora.".to_string()),
        ],
        requires_confirm: false,
        templates: vec![
            ("pt".to_string(), "que horas são".to_string()),
            ("pt".to_string(), "que hora é".to_string()),
            ("pt".to_string(), "me diz as horas".to_string()),
            ("it".to_string(), "che ore sono".to_string()),
            ("it".to_string(), "che ora e".to_string()),
            ("it".to_string(), "dimmi l'ora".to_string()),
            ("en".to_string(), "what time is it".to_string()),
            ("en".to_string(), "what is the time".to_string()),
            ("en".to_string(), "tell me the time".to_string()),
        ],
            slot_words: Vec::new(),
            args: Vec::new(),
        },
        CommandDescriptor {
            name: "lilo.mood".to_string(),
            scope: CommandScope::Tool,
            tool: Some("lilo_mood".to_string()),
            descriptions: vec![
                (
                    "en".to_string(),
                    "Show an expression on LILO's face: happy, sad, angry, surprised, or neutral.".to_string(),
                ),
                (
                    "pt".to_string(),
                    "Mostra uma expressão no rosto do LILO: feliz, triste, bravo, surpreso ou neutro.".to_string(),
                ),
                (
                    "it".to_string(),
                    "Mostra un'espressione sul viso di LILO: felice, triste, arrabbiato, sorpreso o neutro."
                        .to_string(),
                ),
            ],
            requires_confirm: false,
            templates: vec![
                ("en".to_string(), "look {mood}".to_string()),
                ("en".to_string(), "be {mood}".to_string()),
                ("en".to_string(), "seem {mood}".to_string()),
                ("en".to_string(), "make [a] {mood} face".to_string()),
                ("pt".to_string(), "fica {mood}".to_string()),
                ("pt".to_string(), "fique {mood}".to_string()),
                ("pt".to_string(), "fica com [uma] cara [de] {mood}".to_string()),
                ("pt".to_string(), "faz [uma] cara [de] {mood}".to_string()),
                ("it".to_string(), "sii {mood}".to_string()),
                ("it".to_string(), "sembra {mood}".to_string()),
                ("it".to_string(), "fai una faccia {mood}".to_string()),
            ],
            slot_words: vec![("mood".to_string(), crate::mood::mood_words())],
            args: Vec::new(),
        },
        CommandDescriptor {
            name: "lilo.smile".to_string(),
            scope: CommandScope::Tool,
            tool: Some("lilo_mood".to_string()),
            descriptions: vec![
                ("en".to_string(), "Smile.".to_string()),
                ("pt".to_string(), "Sorri.".to_string()),
                ("it".to_string(), "Sorridi.".to_string()),
            ],
            requires_confirm: false,
            templates: vec![
                ("en".to_string(), "smile".to_string()),
                ("pt".to_string(), "sorri".to_string()),
                ("pt".to_string(), "sorria".to_string()),
                ("pt".to_string(), "da [um] sorriso".to_string()),
                ("it".to_string(), "sorridi".to_string()),
            ],
            slot_words: Vec::new(),
            args: vec![("mood".to_string(), "happy".to_string())],
        },
    ]
}

#[derive(Debug, Clone)]
pub struct CompiledCommand {
    pub descriptor: CommandDescriptor,
    pub patterns: Vec<Pattern>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Intent {
    pub command: String,
    pub scope: CommandScope,
    pub tool: Option<String>,
    pub requires_confirm: bool,
    pub args: BTreeMap<String, String>,
    pub specificity: usize,
    /// The matched pattern captures free text, so the router must let the
    /// caption settle before acting on it.
    pub has_slot: bool,
}

/// Whether every constrained slot holds one of its allowed words.
fn slots_allowed(descriptor: &CommandDescriptor, slots: &BTreeMap<String, String>) -> bool {
    descriptor.slot_words.iter().all(|(slot, words)| {
        let Some(value) = slots.get(slot) else {
            return true;
        };
        super::matcher::tokenize(value).iter().any(|token| {
            words
                .iter()
                .any(|word| super::matcher::normalize(word) == *token)
        })
    })
}

fn is_question_about_playback(source: &str) -> bool {
    let normalized = super::matcher::normalize(source);
    [
        "why did you play",
        "why are you playing",
        "why would you play",
        "did you play",
        "what did you play",
        "por que voce tocou",
        "porque voce tocou",
        "o que voce tocou",
        "perche hai suonato",
        "perche hai riprodotto",
        "cosa hai suonato",
        "cosa hai riprodotto",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
}

#[derive(Debug, Clone)]
pub struct Registry {
    commands: Vec<CompiledCommand>,
    /// Active locale filter in preference order. Empty means every locale; the
    /// first entry also decides which language the help panel is written in.
    locales: Vec<String>,
    /// How the user addresses the assistant — needed to compile patterns for
    /// descriptors registered after construction.
    name: String,
}

impl Registry {
    /// `name` is how the user addresses the assistant — by default the last
    /// word of the wake phrase, so "hello lilo" yields "close lilo".
    pub fn new(name: &str) -> Self {
        Self::build(builtin(), name, &[])
    }

    /// Only the given locales are matched. An empty list means every locale,
    /// which is the right default before the user has expressed a preference.
    pub fn with_locales(name: &str, locales: &[String]) -> Self {
        Self::build(builtin(), name, locales)
    }

    /// Build from owned descriptors: the built-ins, or a plugin's list.
    pub fn build(descriptors: Vec<CommandDescriptor>, name: &str, locales: &[String]) -> Self {
        let mut registry = Registry {
            commands: Vec::new(),
            locales: locales.to_vec(),
            name: name.to_string(),
        };
        // Descriptors come from a known-good source here, so a duplicate would
        // be a programming error rather than user input.
        for descriptor in descriptors {
            registry.push(descriptor);
        }
        registry
    }

    /// Add commands after construction — how a plugin contributes phrases.
    ///
    /// Rejects a duplicate name instead of shadowing: two commands with the
    /// same id would make the cooldown and the transcript ambiguous.
    pub fn register(&mut self, descriptors: Vec<CommandDescriptor>) -> Result<()> {
        for descriptor in &descriptors {
            if self
                .commands
                .iter()
                .any(|c| c.descriptor.name == descriptor.name)
            {
                return Err(AppError::other(format!(
                    "command {} is already registered",
                    descriptor.name
                )));
            }
        }
        for descriptor in descriptors {
            self.push(descriptor);
        }
        Ok(())
    }

    fn push(&mut self, descriptor: CommandDescriptor) {
        let name = self.name.clone();
        let wanted = |locale: &str| {
            self.locales.is_empty() || self.locales.iter().any(|want| locale_serves(locale, want))
        };
        let patterns: Vec<Pattern> = descriptor
            .templates
            .iter()
            .filter(|(locale, _)| wanted(locale))
            .map(|(locale, template)| Pattern::compile(locale, template, &name))
            .collect();
        self.commands.push(CompiledCommand {
            descriptor,
            patterns,
        });
    }

    /// Locales any built-in command declares, for the settings picker.
    pub fn available_locales() -> Vec<String> {
        let mut locales: Vec<String> = builtin()
            .iter()
            .flat_map(|c| c.templates.iter().map(|(locale, _)| locale.clone()))
            .collect();
        locales.sort_unstable();
        locales.dedup();
        locales
    }

    /// Best matching intent, or `None` to pass the utterance to the model.
    ///
    /// Exact matching runs first across every command; fuzzy is only consulted
    /// when nothing matched exactly, so a near-miss can never outrank a real
    /// match.
    pub fn match_utterance(&self, text: &str) -> Option<Intent> {
        let tokens = super::matcher::tokenize(text);
        if tokens.is_empty() {
            return None;
        }
        self.best(&tokens, text, false)
            .or_else(|| self.best(&tokens, text, true))
    }

    fn best(&self, tokens: &[String], source: &str, fuzzy: bool) -> Option<Intent> {
        let mut best: Option<Intent> = None;
        for command in &self.commands {
            if command.descriptor.name == "media.play" && is_question_about_playback(source) {
                continue;
            }
            for pattern in &command.patterns {
                let Some(mut found) = pattern.match_tokens(tokens, fuzzy) else {
                    continue;
                };
                if !slots_allowed(&command.descriptor, &found.slots) {
                    continue;
                }
                pattern.restore_literals(source, &mut found);
                let candidate = Intent {
                    command: command.descriptor.name.clone(),
                    scope: command.descriptor.scope,
                    tool: command.descriptor.tool.clone(),
                    requires_confirm: command.descriptor.requires_confirm,
                    // Fixed args first: a matched slot of the same name wins.
                    args: command
                        .descriptor
                        .args
                        .iter()
                        .cloned()
                        .chain(found.slots)
                        .collect(),
                    specificity: found.specificity,
                    has_slot: pattern.has_slot(),
                };
                let better = match &best {
                    None => true,
                    Some(current) => {
                        // Most specific wins; a tie goes to the higher scope,
                        // then to registry order (which `>` preserves because
                        // we only replace on a strict improvement).
                        (candidate.specificity, current.scope.rank())
                            > (current.specificity, candidate.scope.rank())
                    }
                };
                if better {
                    best = Some(candidate);
                }
            }
        }
        best
    }

    /// The language the help panel should be written in: the first active
    /// locale, or English when the user has not chosen one.
    pub fn preferred_locale(&self) -> &str {
        self.locales.first().map(String::as_str).unwrap_or("en")
    }

    /// Localized help entries in the active language.
    pub fn manifest(&self) -> Vec<CommandManifestEntry> {
        self.manifest_in(self.preferred_locale())
    }

    /// Help entries in a specific language. `prompt_line` pins this to English
    /// so the persona instruction does not drift with the UI language.
    pub fn manifest_in(&self, locale: &str) -> Vec<CommandManifestEntry> {
        self.commands
            .iter()
            .map(|command| CommandManifestEntry {
                name: command.descriptor.name.clone(),
                scope: command.descriptor.scope,
                tool: command.descriptor.tool.clone(),
                description: localized(&command.descriptor.descriptions, locale).to_string(),
                requires_confirm: command.descriptor.requires_confirm,
                // Readable phrases, not raw templates: this list is what the
                // user reads in the help panel.
                examples: {
                    let mut seen: Vec<String> = Vec::new();
                    let templates = &command.descriptor.templates;
                    let display_locale = templates
                        .iter()
                        .find(|(declared, _)| locale_serves(declared, locale))
                        .or_else(|| {
                            templates
                                .iter()
                                .find(|(declared, _)| locale_serves(declared, "en"))
                        })
                        .or_else(|| templates.first())
                        .map(|(declared, _)| declared.as_str());
                    for (declared, template) in templates {
                        if Some(declared.as_str()) != display_locale {
                            continue;
                        }
                        let source = template.replace("<name>", &self.name);
                        let phrase = super::matcher::humanize(&source);
                        if !seen.contains(&phrase) {
                            seen.push(phrase);
                        }
                        if seen.len() == 4 {
                            break;
                        }
                    }
                    seen
                },
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Registry {
        Registry::new("lilo")
    }

    fn intent(text: &str) -> Option<Intent> {
        registry().match_utterance(text)
    }

    fn command_of(text: &str) -> Option<String> {
        intent(text).map(|i| i.command)
    }

    fn command_of_in(registry: &Registry, text: &str) -> Option<String> {
        registry.match_utterance(text).map(|i| i.command)
    }

    /// One command as a plugin would contribute it.
    fn plugin_command(name: &str, template: &str) -> CommandDescriptor {
        CommandDescriptor {
            name: name.to_string(),
            scope: CommandScope::Tool,
            tool: Some("acme_dance".to_string()),
            descriptions: vec![
                ("en".to_string(), "Start dancing.".to_string()),
                ("pt".to_string(), "Começa a dançar.".to_string()),
            ],
            requires_confirm: false,
            templates: vec![
                ("en".to_string(), template.to_string()),
                ("pt".to_string(), "começa a dançar".to_string()),
            ],
            slot_words: Vec::new(),
            args: Vec::new(),
        }
    }

    // --- end-call: the behaviour migrated from stopCommand.test.ts ----------

    #[test]
    fn hang_up_phrases_end_the_call() {
        for said in [
            "stop lilo",
            "close lilo",
            "end lilo",
            "quit lilo",
            "goodbye lilo",
            "bye lilo",
            "hang up lilo",
            "ok, close lilo please",
            "para lilo",
            "encerra a chamada",
            "desliga lilo",
            "ferma lilo",
            "chiudi lilo",
            "spegni lilo",
            "ciao lilo",
            "termina la chiamata",
            "chiudi la chiamata",
        ] {
            assert_eq!(command_of(said), Some("end-call".to_string()), "{said}");
        }
    }

    #[test]
    fn stop_the_music_does_not_end_the_call() {
        // The original regression: a media command must never hang up.
        assert_eq!(command_of("stop the music"), Some("media.stop".to_string()));
        assert_eq!(command_of("para a música"), Some("media.stop".to_string()));
    }

    #[test]
    fn media_beats_end_call_when_both_could_match() {
        // "stop the music lilo" is unambiguous to a human: the music stops.
        assert_eq!(
            command_of("stop the music lilo"),
            Some("media.stop".to_string())
        );
    }

    #[test]
    fn ordinary_speech_does_not_end_the_call() {
        for said in [
            "i had to stop working",
            "close the window for me",
            "what is the weather like",
            "me explica o que é isso",
            "ferma un attimo",
            "chiudi la porta",
        ] {
            assert_ne!(command_of(said), Some("end-call".to_string()), "{said}");
        }
    }

    #[test]
    fn the_name_follows_the_wake_phrase() {
        let custom = Registry::build(builtin(), "jarvis", &[]);
        assert_eq!(
            custom.match_utterance("close jarvis").map(|i| i.command),
            Some("end-call".to_string())
        );
        assert_ne!(
            custom.match_utterance("close lilo").map(|i| i.command),
            Some("end-call".to_string())
        );
    }

    // --- media.play slots --------------------------------------------------

    #[test]
    fn plays_a_named_track() {
        let found = intent("toca a música Bohemian Rhapsody").unwrap();
        assert_eq!(found.command, "media.play");
        assert_eq!(found.args["track"], "bohemian rhapsody");
        assert!(!found.args.contains_key("artist"));
        assert!(
            found.has_slot,
            "free text must defer until the caption settles"
        );
    }

    #[test]
    fn does_not_play_music_when_the_user_asks_why_it_played() {
        assert!(intent("Why did you play some some music without my my ask").is_none());
    }

    #[test]
    fn plays_something_by_an_artist() {
        let found = intent("toca uma música do Djavan").unwrap();
        assert_eq!(found.command, "media.play");
        assert_eq!(found.args["artist"], "djavan");
        assert!(!found.args.contains_key("track"));
    }

    #[test]
    fn plays_a_track_by_an_artist() {
        let found = intent("play bohemian rhapsody by queen").unwrap();
        assert_eq!(found.args["track"], "bohemian rhapsody");
        assert_eq!(found.args["artist"], "queen");
    }

    #[test]
    fn portuguese_track_and_artist() {
        let found = intent("toca Samurai do Djavan").unwrap();
        assert_eq!(found.command, "media.play");
        assert_eq!(found.args["track"], "samurai");
        assert_eq!(found.args["artist"], "djavan");
    }

    #[test]
    fn italian_plays_a_named_track() {
        let found = intent("metti su Bohemian Rhapsody").unwrap();
        assert_eq!(found.command, "media.play");
        assert_eq!(found.args["track"], "bohemian rhapsody");
        assert!(!found.args.contains_key("artist"));
        assert!(
            found.has_slot,
            "free text must defer until the caption settles"
        );
    }

    #[test]
    fn test_music_requests_separate_title_and_artist_across_languages() {
        for utterance in [
            "toca Cheia de Manias do Raça Negra",
            "toque Cheia de Manias do Raça Negra",
            "coloca Cheia de Manias do Raça Negra",
            "TOCA A MÚSICA CHEIA DE MANIAS DO RAÇA NEGRA",
            "play Cheia de Manias by Raça Negra",
            "metti Cheia de Manias di Raça Negra",
        ] {
            let found = intent(utterance).expect(utterance);
            assert_eq!(found.command, "media.play", "{utterance}");
            assert_eq!(found.args["track"], "cheia de manias", "{utterance}");
            assert_eq!(found.args["artist"], "raca negra", "{utterance}");
        }
    }

    #[test]
    fn italian_plays_a_track_by_an_artist() {
        let found = intent("riproduci Samurai di Djavan").unwrap();
        assert_eq!(found.command, "media.play");
        assert_eq!(found.args["track"], "samurai");
        assert_eq!(found.args["artist"], "djavan");
    }

    #[test]
    fn italian_plays_something_by_an_artist() {
        let found = intent("riproduci qualcosa di Vasco Rossi").unwrap();
        assert_eq!(found.command, "media.play");
        assert_eq!(found.args["artist"], "vasco rossi");
        assert!(!found.args.contains_key("track"));
    }

    #[test]
    fn english_something_by_artist() {
        let found = intent("play something by radiohead").unwrap();
        assert_eq!(found.args["artist"], "radiohead");
    }

    #[test]
    fn plays_bare_phrasing_with_no_track_or_artist() {
        for said in [
            "toca uma música",
            "toca alguma coisa",
            "coloca uma música",
            "bota uma música",
            "quero ouvir uma música",
            "play some music",
            "play music",
            "put on some music",
            "I want to hear some music",
            "metti un po di musica",
            "voglio ascoltare musica",
        ] {
            let found = intent(said).unwrap_or_else(|| panic!("no match for {said}"));
            assert_eq!(found.command, "media.play", "{said}");
            assert!(!found.args.contains_key("track"), "{said}");
            assert!(!found.args.contains_key("artist"), "{said}");
        }
    }

    #[test]
    fn does_not_play_when_an_artist_is_only_mentioned_in_passing() {
        // A singer's name coming up in conversation is not a command: the
        // words "toca"/"do" appearing far apart in an unrelated sentence must
        // not be stitched together into a media.play match.
        assert!(intent(
            "outro dia eu vi uma entrevista muito boa do Djavan falando sobre a vida dele"
        )
        .is_none());
        assert!(intent(
            "I was reading an old interview about the singer and I think it was published by a magazine"
        )
        .is_none());
    }

    // --- transport commands ------------------------------------------------

    #[test]
    fn transport_commands_have_no_free_slot() {
        for (said, expected) in [
            ("pausa a música", "media.pause"),
            ("pause the music", "media.pause"),
            ("metti in pausa la musica", "media.pause"),
            ("continua a música", "media.resume"),
            ("riprendi la musica", "media.resume"),
            ("próxima música", "media.next"),
            ("next track", "media.next"),
            ("prossima canzone", "media.next"),
            ("música anterior", "media.previous"),
            ("canzone precedente", "media.previous"),
            ("para de tocar", "media.stop"),
            ("toca músicas parecidas", "media.radio"),
            ("coloca mais músicas assim", "media.radio"),
            ("continua tocando", "media.radio"),
            ("play similar songs", "media.radio"),
            ("keep the music going", "media.radio"),
            ("riproduci canzoni simili", "media.radio"),
            ("ferma la musica", "media.stop"),
        ] {
            let found = intent(said).unwrap_or_else(|| panic!("no match for {said}"));
            assert_eq!(found.command, expected, "{said}");
            assert!(!found.has_slot, "{said} must fire immediately");
        }
    }

    #[test]
    fn volume_captures_its_level() {
        assert_eq!(intent("volume 30").unwrap().args["level"], "30");
        assert_eq!(intent("coloca o volume em 45").unwrap().args["level"], "45");
        assert_eq!(intent("set the volume to 80").unwrap().args["level"], "80");
        assert_eq!(
            intent("imposta il volume a 45").unwrap().args["level"],
            "45"
        );
        assert_eq!(intent("metti il volume su 30").unwrap().args["level"], "30");
    }

    #[test]
    fn time_is_a_tool_command() {
        let found = intent("que horas são").unwrap();
        assert_eq!(found.command, "time.now");
        assert_eq!(found.tool.as_deref(), Some("get_current_time"));
        assert_eq!(found.scope, CommandScope::Tool);

        let found = intent("che ore sono").unwrap();
        assert_eq!(found.command, "time.now");
        assert_eq!(found.tool.as_deref(), Some("get_current_time"));

        // The apostrophe must survive normalization ("l'ora" -> "l ora").
        assert_eq!(command_of("dimmi l'ora"), Some("time.now".to_string()));
    }

    // --- lilo.mood -----------------------------------------------------

    #[test]
    fn mood_phrases_carry_the_asked_word() {
        for (said, mood) in [
            ("look happy", "happy"),
            ("fica feliz", "feliz"),
            ("fica bravo", "bravo"),
            ("sii sorpreso", "sorpreso"),
            ("fica com uma cara de triste", "triste"),
        ] {
            let found = intent(said).unwrap_or_else(|| panic!("no match for {said}"));
            assert_eq!(found.command, "lilo.mood", "{said}");
            assert_eq!(found.tool.as_deref(), Some("lilo_mood"));
            assert_eq!(found.args["mood"], mood, "{said}");
        }
    }

    #[test]
    fn a_word_outside_the_mood_vocabulary_does_not_match() {
        assert_ne!(command_of("look tired"), Some("lilo.mood".to_string()));
    }

    #[test]
    fn smile_is_a_fixed_shortcut_for_happy() {
        for said in ["smile", "sorri", "sorria", "da um sorriso", "sorridi"] {
            let found = intent(said).unwrap_or_else(|| panic!("no match for {said}"));
            assert_eq!(found.command, "lilo.smile", "{said}");
            assert_eq!(found.args["mood"], "happy", "{said}");
        }
    }

    // --- selection rules ---------------------------------------------------

    #[test]
    fn the_more_specific_pattern_wins() {
        // "play {track}" also matches, but the by-artist form consumes more
        // literal tokens and must win.
        let found = intent("play creep by radiohead").unwrap();
        assert_eq!(found.args["artist"], "radiohead");
        assert_eq!(found.args["track"], "creep");
    }

    #[test]
    fn fuzzy_only_applies_when_nothing_matched_exactly() {
        // "tocar" is an exact command; a mangled "reproduzr" still resolves.
        assert_eq!(
            command_of("reproduzr alguma coisa"),
            Some("media.play".to_string())
        );
    }

    #[test]
    fn unmatched_speech_falls_through_to_the_model() {
        assert!(intent("me conta uma história sobre o mar").is_none());
        assert!(intent("").is_none());
        assert!(intent("...").is_none());
    }

    #[test]
    fn a_single_locale_stops_matching_the_other() {
        let only_en = Registry::with_locales("lilo", &["en".to_string()]);
        assert_eq!(
            only_en.match_utterance("play creep").map(|i| i.command),
            Some("media.play".to_string())
        );
        assert!(
            only_en.match_utterance("toca a música creep").is_none(),
            "a locale the user turned off must not match"
        );

        let only_pt = Registry::with_locales("lilo", &["pt".to_string()]);
        assert!(only_pt.match_utterance("toca a música creep").is_some());
        assert!(only_pt.match_utterance("play creep").is_none());
    }

    #[test]
    fn no_locale_selected_means_every_locale() {
        let all = Registry::with_locales("lilo", &[]);
        assert!(all.match_utterance("play creep").is_some());
        assert!(all.match_utterance("toca a música creep").is_some());
        assert!(all.match_utterance("riproduci Samurai").is_some());
    }

    #[test]
    fn a_regional_tag_matches_its_base_locale() {
        // The frontend sends a bare locale ("it"), but a caller passing a full
        // tag ("it-IT") must get Italian — never a silent English fallback.
        let it = Registry::with_locales("lilo", &["it-IT".to_string()]);
        assert_eq!(
            command_of_in(&it, "che ore sono"),
            Some("time.now".to_string())
        );
        assert!(
            it.match_utterance("what time is it").is_none(),
            "a tag must still restrict matching to its own locale"
        );
        let play = it
            .manifest()
            .into_iter()
            .find(|entry| entry.name == "media.play")
            .unwrap();
        assert!(
            play.description.contains("Riproduci"),
            "the help panel must be written in Italian for it-IT: {}",
            play.description
        );

        let pt = Registry::with_locales("lilo", &["pt-BR".to_string()]);
        assert_eq!(
            command_of_in(&pt, "toca a música creep"),
            Some("media.play".to_string())
        );
        let play = pt
            .manifest()
            .into_iter()
            .find(|entry| entry.name == "media.play")
            .unwrap();
        assert!(play.description.contains("Toca"), "{}", play.description);
    }

    #[test]
    fn a_plugin_can_contribute_commands_at_runtime() {
        // The point of owned descriptors: a plugin brings its own phrases and
        // they become matchable without recompiling the core.
        let mut registry = Registry::with_locales("lilo", &["en".to_string()]);
        let before = registry.manifest().len();
        registry
            .register(vec![plugin_command("acme.dance", "start dancing")])
            .expect("registration must succeed");

        assert_eq!(registry.manifest().len(), before + 1);
        assert_eq!(
            command_of_in(&registry, "please start dancing now"),
            Some("acme.dance".to_string())
        );
        // The active locale filter applies to plugin templates too.
        assert!(command_of_in(&registry, "começa a dançar").is_none());

        let play = registry
            .manifest()
            .into_iter()
            .find(|entry| entry.name == "acme.dance")
            .expect("the plugin command is listed");
        assert_eq!(play.tool.as_deref(), Some("acme_dance"));
    }

    #[test]
    fn a_plugin_command_cannot_shadow_an_existing_one() {
        let mut registry = Registry::new("lilo");
        let error = registry
            .register(vec![plugin_command("media.play", "start dancing")])
            .unwrap_err();
        assert!(error.to_string().contains("already registered"), "{error}");
    }

    #[test]
    fn an_unlisted_locale_falls_back_to_the_first_description() {
        let mut registry = Registry::with_locales("lilo", &["de".to_string()]);
        registry
            .register(vec![plugin_command("acme.dance", "start dancing")])
            .unwrap();
        let entry = registry
            .manifest()
            .into_iter()
            .find(|entry| entry.name == "acme.dance")
            .unwrap();
        assert_eq!(entry.description, "Start dancing.");
    }

    #[test]
    fn available_locales_are_what_the_picker_offers() {
        let locales = Registry::available_locales();
        assert!(locales.contains(&"pt".to_string()));
        assert!(locales.contains(&"en".to_string()));
        assert!(locales.contains(&"it".to_string()));
    }

    #[test]
    fn descriptions_follow_the_selected_language() {
        let pt = Registry::with_locales("lilo", &["pt".to_string()]);
        let play = pt
            .manifest()
            .into_iter()
            .find(|entry| entry.name == "media.play")
            .unwrap();
        assert!(
            play.description.contains("Toca"),
            "the help panel must be written in the language being matched: {}",
            play.description
        );

        let en = Registry::with_locales("lilo", &["en".to_string()]);
        let play = en
            .manifest()
            .into_iter()
            .find(|entry| entry.name == "media.play")
            .unwrap();
        assert!(play.description.contains("Play"));

        let it = Registry::with_locales("lilo", &["it".to_string()]);
        let play = it
            .manifest()
            .into_iter()
            .find(|entry| entry.name == "media.play")
            .unwrap();
        assert!(
            play.description.contains("Riproduci"),
            "Italian must not fall back to English: {}",
            play.description
        );
    }

    #[test]
    fn an_unlisted_language_falls_back_to_english_not_blank() {
        // A locale we ship no copy for must still render something readable.
        let manifest = Registry::with_locales("lilo", &["de".to_string()]).manifest();
        for entry in &manifest {
            assert!(
                !entry.description.is_empty(),
                "{} has no description for de",
                entry.name
            );
        }
    }

    #[test]
    fn the_model_briefing_stays_english_whatever_the_ui_language_is() {
        // The persona paragraph is one fixed instruction; switching the UI to
        // Portuguese must not make the model's briefing churn.
        let pt = Registry::with_locales("lilo", &["pt".to_string()]);
        let line = crate::commands::manifest::prompt_line(&pt, &[], true);
        assert!(line.contains("End the live conversation"), "{line}");
        assert!(!line.contains("Encerra"), "{line}");
    }

    #[test]
    fn help_examples_follow_requested_locale_without_changing_matching() {
        let registry = Registry::new("lilo");
        for (locale, prefix) in [("en-US", "play"), ("pt-BR", "toca"), ("it-IT", "riproduci")] {
            let manifest = registry.manifest_in(locale);
            let play = manifest
                .iter()
                .find(|entry| entry.name == "media.play")
                .unwrap();
            assert!(
                play.examples[0].starts_with(prefix),
                "{locale}: {:?}",
                play.examples
            );
            assert!(
                play.examples
                    .iter()
                    .all(|phrase| phrase.starts_with(prefix)),
                "{:?}",
                play.examples
            );
        }
        assert_eq!(
            command_of_in(&registry, "toca a música Imagine"),
            Some("media.play".into())
        );
        assert_eq!(
            command_of_in(&registry, "play the song Imagine"),
            Some("media.play".into())
        );
    }

    #[test]
    fn help_examples_use_english_fallback_even_when_matching_only_portuguese() {
        let registry = Registry::with_locales("lilo", &["pt".into()]);
        let manifest = registry.manifest_in("de");
        let play = manifest
            .iter()
            .find(|entry| entry.name == "media.play")
            .unwrap();
        assert!(play.examples[0].starts_with("play"), "{:?}", play.examples);
    }

    #[test]
    fn manifest_examples_are_readable_phrases() {
        // The help panel shows these; raw templates would be gibberish.
        let manifest = Registry::with_locales("lilo", &["pt".to_string()]).manifest();
        let play = manifest.iter().find(|e| e.name == "media.play").unwrap();
        assert!(play.examples.iter().any(|e| e.contains("<track>")));
        assert!(
            play.examples
                .iter()
                .all(|e| !e.contains('[') && !e.contains('{')),
            "{:?}",
            play.examples
        );
    }

    #[test]
    fn manifest_covers_every_command() {
        let manifest = registry().manifest();
        assert_eq!(manifest.len(), builtin().len());
        for entry in &manifest {
            assert!(!entry.name.is_empty());
            assert!(!entry.description.is_empty());
            assert!(!entry.examples.is_empty());
        }
        assert!(manifest.iter().any(|e| e.name == "media.play"));
    }

    #[test]
    fn every_command_tool_actually_exists() {
        // A command pointing at a tool nobody implements fails only at runtime,
        // in the user's ear. Catch it here instead. The full list is the union
        // of every provider the host registers.
        let tools: Vec<String> = crate::tools::BuiltinTools::describe()
            .into_iter()
            .map(|tool| tool.name)
            .chain(
                crate::media::service::TOOL_NAMES
                    .iter()
                    .map(|t| t.to_string()),
            )
            .collect();
        for command in builtin() {
            if let Some(tool) = &command.tool {
                assert!(
                    tools.iter().any(|t| t == tool),
                    "{} points at missing tool {tool}",
                    command.name
                );
            }
        }
    }

    #[test]
    fn every_builtin_template_compiles_to_something_matchable() {
        let registry = registry();
        for command in &registry.commands {
            for pattern in &command.patterns {
                assert!(
                    !pattern.source.is_empty(),
                    "{} has an empty pattern",
                    command.descriptor.name
                );
            }
        }
    }
}
