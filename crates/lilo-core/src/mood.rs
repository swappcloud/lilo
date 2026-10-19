//! LILO's face on request: a spoken mood word maps to an expression the
//! frontend's character model reads, held briefly and faded back to normal.
//!
//! Momentary by design — unlike the weather mood, which persists until
//! changed, an expression is a reaction (a smile at a joke), not a backdrop.
//! The frontend owns how long it holds and how it fades; this only says which
//! one, or that none should show anymore.

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, Result};

/// An expression LILO's face can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MoodKind {
    Happy,
    Sad,
    Angry,
    Surprised,
}

impl MoodKind {
    fn label(self) -> &'static str {
        match self {
            MoodKind::Happy => "happy",
            MoodKind::Sad => "sad",
            MoodKind::Angry => "angry",
            MoodKind::Surprised => "surprised",
        }
    }
}

/// What a spoken mood word asks for: one of the expressions, or a return to
/// the resting face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MoodWord {
    Show(MoodKind),
    Neutral,
}

/// Every word that names a mood, English/Portuguese/Italian, compared already
/// normalized (lowercase, no accents) the same way the command matcher does.
const MOOD_WORDS: &[(&[&str], MoodWord)] = &[
    (
        &[
            "happy", "glad", "joyful", "cheerful", "feliz", "alegre", "contente", "felice",
            "allegro", "contento",
        ],
        MoodWord::Show(MoodKind::Happy),
    ),
    (
        &[
            "sad",
            "down",
            "blue",
            "triste",
            "chateado",
            "chateada",
            "abbattuto",
            "abbattuta",
        ],
        MoodWord::Show(MoodKind::Sad),
    ),
    (
        &[
            "angry",
            "mad",
            "furious",
            "bravo",
            "brava",
            "irritado",
            "irritada",
            "zangado",
            "zangada",
            "arrabbiato",
            "arrabbiata",
        ],
        MoodWord::Show(MoodKind::Angry),
    ),
    (
        &[
            "surprised",
            "shocked",
            "amazed",
            "surpreso",
            "surpresa",
            "espantado",
            "espantada",
            "sorpreso",
            "sorpresa",
        ],
        MoodWord::Show(MoodKind::Surprised),
    ),
    (
        &[
            "neutral", "normal", "calm", "neutro", "calmo", "calma", "normale",
        ],
        MoodWord::Neutral,
    ),
];

fn parse_mood_word(text: &str) -> Option<MoodWord> {
    let text = text.trim().to_lowercase();
    MOOD_WORDS
        .iter()
        .find(|(words, _)| words.iter().any(|word| *word == text))
        .map(|(_, mood)| *mood)
}

/// Every word that names a mood, for the command's slot constraint.
pub fn mood_words() -> Vec<String> {
    MOOD_WORDS
        .iter()
        .flat_map(|(words, _)| words.iter().map(|word| word.to_string()))
        .collect()
}

/// Runs `lilo_mood`: reads the `mood` arg and answers what the face should
/// show. A neutral word fades it back rather than showing an expression.
pub fn run(args: &Value) -> Result<Value> {
    let asked = args.get("mood").and_then(Value::as_str).unwrap_or_default();
    let word = parse_mood_word(asked).ok_or_else(|| {
        AppError::other(format!(
            "\"{asked}\" is not an expression LILO knows (try happy, sad, angry, surprised, or neutral)"
        ))
    })?;
    match word {
        MoodWord::Show(kind) => Ok(json!({
            "summary": format!("showing a {} expression", kind.label()),
            "mood": { "kind": kind },
        })),
        MoodWord::Neutral => Ok(json!({
            "summary": "back to a neutral expression",
            "mood": { "kind": "neutral" },
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_a_mood_in_any_of_the_three_languages() {
        assert_eq!(
            run(&json!({ "mood": "feliz" })).unwrap()["mood"]["kind"],
            "happy"
        );
        assert_eq!(
            run(&json!({ "mood": "arrabbiato" })).unwrap()["mood"]["kind"],
            "angry"
        );
        assert_eq!(
            run(&json!({ "mood": "surprised" })).unwrap()["mood"]["kind"],
            "surprised"
        );
    }

    #[test]
    fn is_case_insensitive() {
        assert_eq!(
            run(&json!({ "mood": "HAPPY" })).unwrap()["mood"]["kind"],
            "happy"
        );
    }

    #[test]
    fn neutral_asks_for_a_reset_not_a_kind() {
        let result = run(&json!({ "mood": "normal" })).unwrap();
        assert_eq!(result["mood"]["kind"], "neutral");
    }

    #[test]
    fn an_unknown_word_is_refused() {
        let error = run(&json!({ "mood": "banana" })).unwrap_err();
        assert!(error.to_string().contains("banana"));
    }

    #[test]
    fn every_word_round_trips_through_the_slot_list() {
        for word in mood_words() {
            assert!(parse_mood_word(&word).is_some(), "{word}");
        }
    }
}
