//! Provider-independent local recognition ingress and bounded finite grammars.
//! Recognition supplies text, never tool names or execution authorization.
use serde::{Deserialize, Serialize};

pub const VERSION: u8 = 1;
pub const MAX_PHRASES: usize = 256;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transcript {
    pub version: u8,
    pub turn_id: String,
    pub text: String,
    pub is_final: bool,
}
impl Transcript {
    pub fn new(text: String, turn_id: String, is_final: bool) -> Self {
        Self {
            version: VERSION,
            text,
            turn_id,
            is_final,
        }
    }
    pub fn valid(&self) -> bool {
        self.version == VERSION
            && !self.turn_id.is_empty()
            && self.turn_id.len() <= 128
            && !self.text.trim().is_empty()
            && self.text.len() <= 8192
    }
}

/// Expand finite templates for keyword engines. Free dictation remains a
/// recognizer capability; inventing example slot values would change intent.
pub fn phrases(template: &str, name: &str) -> Vec<String> {
    let source = template.replace("<name>", name);
    if source.contains(['{', '}', '<', '>']) {
        return vec![];
    }
    let mut pending = vec![source];
    let mut output = Vec::new();
    while let Some(source) = pending.pop() {
        if let Some(start) = source.find(['[', '(']) {
            let close = if source.as_bytes()[start] == b'[' {
                ']'
            } else {
                ')'
            };
            let Some(end) = source[start..].find(close).map(|end| start + end) else {
                continue;
            };
            let body = &source[start + 1..end];
            if body.contains(['[', '(']) {
                continue;
            }
            let choices = body.split('|').chain((close == ']').then_some(""));
            for choice in choices.take(16) {
                if pending.len() + output.len() >= 32 {
                    break;
                }
                pending.push(format!(
                    "{}{}{}",
                    &source[..start],
                    choice,
                    &source[end + 1..]
                ));
            }
        } else {
            let phrase = super::matcher::normalize(&source);
            if !phrase.is_empty() && phrase.len() <= 160 && !output.contains(&phrase) {
                output.push(phrase);
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finite_grammar_preserves_alternatives_and_omissions() {
        let result = phrases("(stop|pause) [the] music", "lilo");
        for text in [
            "stop music",
            "pause music",
            "stop the music",
            "pause the music",
        ] {
            assert!(result.contains(&text.to_string()));
        }
        assert!(phrases("note {!text}", "lilo").is_empty());
        assert_eq!(phrases("close <name>", "lilo"), ["close lilo"]);
    }

    #[test]
    fn finite_grammar_keeps_completed_phrases_at_the_expansion_bound() {
        let result = phrases("[one] [two] [three] [four] [five]", "lilo");
        assert!(result.len() <= 32);
        assert!(!result.is_empty());
        assert!(result.contains(&"one two three four five".to_string()));
        assert!(!result.contains(&String::new()));
    }
    #[test]
    fn ingress_rejects_unknown_versions_and_unbounded_content() {
        let mut event = Transcript::new("stop music".into(), "turn-1".into(), true);
        assert!(event.valid());
        event.version = 2;
        assert!(!event.valid());
        event.version = VERSION;
        event.text = "x".repeat(8193);
        assert!(!event.valid());
    }
}
