//! Utterance -> intent matching.
//!
//! Deliberately hand-rolled instead of `regex`: the headless Linux device target runs
//! this on every caption delta, `regex` costs ~1 MB of binary, and a token
//! machine is far more predictable with accented Portuguese than a regex over
//! raw text.
//!
//! Template language:
//! * `play`: a literal word.
//! * `[a|the]`: an optional group; matching or skipping it is free.
//! * `(by|from)`: a required alternative; exactly one must match.
//!   This keeps `play {track} (by) {artist}` from becoming adjacent slots.
//! * `{track}`: a free-text slot, one or more tokens.
//! * `<name>`: the assistant's name, substituted before compiling.
//!   A custom wake phrase therefore keeps commands working.

use std::collections::BTreeMap;

/// How many tokens may be skipped before a pattern's first literal/alternative
/// is allowed to start matching. Some filler is expected ("ok, close lilo
/// please"), but an unbounded skip lets a command phrase fire from deep
/// inside an unrelated sentence just because it mentions the right words in
/// passing (e.g. a singer's name in small talk starting a `media.play` match
/// many tokens in).
const MAX_LEAD_TOKENS: usize = 4;

/// How many tokens a non-trailing free-text slot may span while hunting for
/// the literal/alternative that follows it. Real track names are short; an
/// unbounded search lets `{track} (do|da|de) {artist}` swallow a whole
/// sentence looking for a stray "do" or "de" far away from any actual
/// command.
const MAX_SLOT_SPAN: usize = 6;

/// Fold a character to its unaccented ASCII counterpart.
///
/// A small table avoids a Unicode-normalization dependency while keeping
/// accented and unaccented command words equivalent.
fn fold(ch: char) -> char {
    match ch {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

/// Lowercase, fold accents, drop punctuation, collapse whitespace.
///
/// Mirrors the `normalizeCommand` that used to live in `sessionStore.ts`.
pub fn normalize(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for ch in input.chars().flat_map(char::to_lowercase) {
        if ('\u{0300}'..='\u{036f}').contains(&ch) {
            continue;
        }
        let folded = fold(ch);
        if folded.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(folded);
        } else {
            pending_space = true;
        }
    }
    out
}

pub fn tokenize(input: &str) -> Vec<String> {
    normalize(input)
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Part {
    Lit(String),
    /// Alternatives, each a token sequence. The whole group may be skipped.
    Opt(Vec<Vec<String>>),
    /// Alternatives, exactly one of which must match.
    Alt(Vec<Vec<String>>),
    Slot(String),
}

#[derive(Debug, Clone)]
pub struct Pattern {
    parts: Vec<Part>,
    /// The template as written, kept for diagnostics and the settings UI.
    pub source: String,
    /// Registry locale this pattern was written for (e.g. `pt`).
    pub locale: String,
}

/// Longest edit distance still considered a match, by word length. Same shape
/// as the wake helper's windowing: recognition mangles short words badly, so
/// only words long enough to survive a typo are fuzzed at all.
fn allowed_distance(word: &str) -> usize {
    match word.chars().count() {
        0..=3 => 0,
        4..=7 => 1,
        _ => 2,
    }
}

/// Bounded Levenshtein. Returns `None` as soon as the distance exceeds `max`,
/// which keeps the common "not even close" case cheap.
fn within_distance(a: &str, b: &str, max: usize) -> bool {
    if a == b {
        return true;
    }
    if max == 0 {
        return false;
    }
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        let mut row_min = cur[0];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
            row_min = row_min.min(cur[j + 1]);
        }
        if row_min > max {
            return false;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()] <= max
}

fn token_eq(token: &str, literal: &str, fuzzy: bool) -> bool {
    if token == literal {
        return true;
    }
    if !fuzzy {
        return false;
    }
    // The first letter must survive. Without this guard "cara" fuzzy-matches
    // "para" at distance 1 and a mangled sentence silently stops the music —
    // which happened. Recognition mangles word endings far more often than it
    // changes the leading sound.
    if token.chars().next() != literal.chars().next() {
        return false;
    }
    within_distance(token, literal, allowed_distance(literal))
}

/// Parse a template into parts. Unbalanced brackets degrade to literals rather
/// than panicking — a malformed pattern must never take the app down.
fn parse_template(template: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut word = String::new();
    let mut chars = template.chars().peekable();

    fn flush(word: &mut String, parts: &mut Vec<Part>) {
        if !word.is_empty() {
            // A word may normalize to several tokens: an apostrophe is
            // punctuation, so "l'ora" is "l ora". Emit one literal per token or
            // the pattern compiles to a literal no token can ever equal.
            let normalized = normalize(word);
            for token in normalized.split(' ').filter(|token| !token.is_empty()) {
                parts.push(Part::Lit(token.to_string()));
            }
            word.clear();
        }
    }

    while let Some(ch) = chars.next() {
        match ch {
            ' ' => flush(&mut word, &mut parts),
            '[' | '(' => {
                flush(&mut word, &mut parts);
                let closing = if ch == '[' { ']' } else { ')' };
                let mut body = String::new();
                for inner in chars.by_ref() {
                    if inner == closing {
                        break;
                    }
                    body.push(inner);
                }
                let alts: Vec<Vec<String>> = body
                    .split('|')
                    .map(tokenize)
                    .filter(|alt| !alt.is_empty())
                    .collect();
                if !alts.is_empty() {
                    parts.push(if ch == '[' {
                        Part::Opt(alts)
                    } else {
                        Part::Alt(alts)
                    });
                }
            }
            '{' => {
                flush(&mut word, &mut parts);
                let mut name = String::new();
                for inner in chars.by_ref() {
                    if inner == '}' {
                        break;
                    }
                    name.push(inner);
                }
                let name = name.trim().to_string();
                if !name.is_empty() {
                    parts.push(Part::Slot(name));
                }
            }
            other => word.push(other),
        }
    }
    flush(&mut word, &mut parts);
    parts
}

/// Render a template as something a person can read: the first alternative of
/// each optional group, and slots as `<name>`.
///
/// The raw template ("play [the] {track}") is precise but unreadable
/// in a help panel.
pub fn humanize(template: &str) -> String {
    let mut out = String::new();
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '[' | '(' => {
                let closing = if ch == '[' { ']' } else { ')' };
                let mut body = String::new();
                for inner in chars.by_ref() {
                    if inner == closing {
                        break;
                    }
                    body.push(inner);
                }
                if let Some(first) = body.split('|').next() {
                    out.push_str(first.trim());
                }
            }
            '{' => {
                let mut name = String::new();
                for inner in chars.by_ref() {
                    if inner == '}' {
                        break;
                    }
                    name.push(inner);
                }
                out.push('<');
                out.push_str(name.trim().trim_start_matches('!'));
                out.push('>');
            }
            other => out.push(other),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl Pattern {
    /// Compile a template. `name` replaces every `<name>` placeholder, so
    /// "close <name>" follows the user's configured wake phrase.
    pub fn compile(locale: &str, template: &str, name: &str) -> Self {
        let source = template.replace("<name>", name);
        Pattern {
            parts: parse_template(&source),
            source,
            locale: locale.to_string(),
        }
    }

    /// True when the pattern captures free text, which is what forces the
    /// router to wait for the caption to settle before firing.
    pub fn has_slot(&self) -> bool {
        self.parts.iter().any(|p| matches!(p, Part::Slot(_)))
    }

    /// Try to match anywhere in `tokens`. Returns the filled slots and a
    /// specificity score = how many *literal* tokens the pattern consumed.
    pub fn match_tokens(&self, tokens: &[String], fuzzy: bool) -> Option<PatternMatch> {
        if self.parts.is_empty() {
            return None;
        }
        for start in 0..tokens.len().min(MAX_LEAD_TOKENS + 1) {
            let mut slots = BTreeMap::new();
            let mut spans = BTreeMap::new();
            if let Some(end) =
                self.match_parts(&self.parts, tokens, start, &mut slots, &mut spans, fuzzy)
            {
                let captured: usize = slots.values().map(|v: &String| v.split(' ').count()).sum();
                return Some(PatternMatch {
                    specificity: (end - start).saturating_sub(captured),
                    slots,
                    spans,
                });
            }
        }
        None
    }

    /// Restore explicitly literal slots from the original caption, never from
    /// the normalized tokens used for command recognition.
    pub fn restore_literals(&self, source: &str, found: &mut PatternMatch) {
        if !self
            .parts
            .iter()
            .any(|part| matches!(part, Part::Slot(name) if name.starts_with('!')))
        {
            return;
        }
        let mut offsets = Vec::new();
        let mut start = None;
        for (offset, ch) in source.char_indices() {
            if ch.is_alphanumeric() {
                start.get_or_insert(offset);
            } else if !('\u{0300}'..='\u{036f}').contains(&ch) {
                if let Some(begin) = start.take() {
                    offsets.push((begin, offset));
                }
            }
        }
        if let Some(begin) = start {
            offsets.push((begin, source.len()));
        }
        for part in &self.parts {
            let Part::Slot(name) = part else {
                continue;
            };
            let Some(key) = name.strip_prefix('!') else {
                continue;
            };
            let Some(&(start, end)) = found.spans.get(key) else {
                continue;
            };
            // Include punctuation within the slot boundaries, including quotes.
            let begin = if start == 0 { 0 } else { offsets[start - 1].1 };
            let finish = offsets.get(end).map_or(source.len(), |range| range.0);
            found
                .slots
                .insert(key.to_string(), source[begin..finish].trim().to_string());
        }
    }

    fn match_parts(
        &self,
        parts: &[Part],
        tokens: &[String],
        pos: usize,
        slots: &mut BTreeMap<String, String>,
        spans: &mut BTreeMap<String, (usize, usize)>,
        fuzzy: bool,
    ) -> Option<usize> {
        let Some((head, rest)) = parts.split_first() else {
            return Some(pos);
        };

        match head {
            Part::Lit(word) => {
                if pos < tokens.len() && token_eq(&tokens[pos], word, fuzzy) {
                    self.match_parts(rest, tokens, pos + 1, slots, spans, fuzzy)
                } else {
                    None
                }
            }
            Part::Opt(alts) => {
                for alt in alts {
                    if pos + alt.len() <= tokens.len()
                        && alt
                            .iter()
                            .enumerate()
                            .all(|(i, w)| token_eq(&tokens[pos + i], w, fuzzy))
                    {
                        if let Some(end) =
                            self.match_parts(rest, tokens, pos + alt.len(), slots, spans, fuzzy)
                        {
                            return Some(end);
                        }
                    }
                }
                // Skipping the group entirely is always allowed.
                self.match_parts(rest, tokens, pos, slots, spans, fuzzy)
            }
            Part::Alt(alts) => {
                for alt in alts {
                    if pos + alt.len() <= tokens.len()
                        && alt
                            .iter()
                            .enumerate()
                            .all(|(i, w)| token_eq(&tokens[pos + i], w, fuzzy))
                    {
                        if let Some(end) =
                            self.match_parts(rest, tokens, pos + alt.len(), slots, spans, fuzzy)
                        {
                            return Some(end);
                        }
                    }
                }
                None
            }
            Part::Slot(name) => {
                let name = name.trim_start_matches('!');
                if rest.is_empty() {
                    // Trailing slot is greedy: it takes the rest of the utterance.
                    if pos >= tokens.len() {
                        return None;
                    }
                    slots.insert(name.to_string(), tokens[pos..].join(" "));
                    spans.insert(name.to_string(), (pos, tokens.len()));
                    return Some(tokens.len());
                }
                // Prefer the longest capture that lets the rest match, so a
                // connector inside a song title does not become its artist. Capped
                // so the search cannot run off into unrelated words far down
                // the sentence — see MAX_SLOT_SPAN.
                for take in (1..=tokens.len().saturating_sub(pos).min(MAX_SLOT_SPAN)).rev() {
                    slots.insert(name.to_string(), tokens[pos..pos + take].join(" "));
                    spans.insert(name.to_string(), (pos, pos + take));
                    if let Some(end) =
                        self.match_parts(rest, tokens, pos + take, slots, spans, fuzzy)
                    {
                        return Some(end);
                    }
                    slots.remove(name);
                    spans.remove(name);
                }
                None
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternMatch {
    /// Literal tokens consumed. Higher wins: it is the "most specific pattern"
    /// rule that keeps `play {track} by {artist}` ahead of `play {track}`.
    pub specificity: usize,
    pub slots: BTreeMap<String, String>,
    spans: BTreeMap<String, (usize, usize)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_slot_preserves_caption_text_after_a_named_target() {
        let pattern = p("write in {app} text {!text}");
        let source = "write in Visual Studio Code text Hello, café!\nSecond line.";
        let mut found = pattern.match_tokens(&tokenize(source), false).unwrap();
        pattern.restore_literals(source, &mut found);
        assert_eq!(found.slots["app"], "visual studio code");
        assert_eq!(found.slots["text"], "Hello, café!\nSecond line.");
    }

    #[test]
    fn literal_slot_preserves_quotes_and_decomposed_unicode() {
        let pattern = p("write in {app} text {!text}");
        let source = "write in Editor text \"Cafe\u{301}\", don't change THIS.";
        let mut found = pattern.match_tokens(&tokenize(source), false).unwrap();
        pattern.restore_literals(source, &mut found);
        assert_eq!(found.slots["text"], "\"Cafe\u{301}\", don't change THIS.");
    }

    #[test]
    fn test_normalize_folds_uppercase_and_decomposed_accents() {
        assert_eq!(normalize("MÚSICA RAÇA NEGRA"), "musica raca negra");
        assert_eq!(
            normalize("mu\u{301}sica Rac\u{327}a Negra"),
            "musica raca negra"
        );
        assert_eq!(normalize("PERCHÉ È COSÌ"), "perche e cosi");
    }

    fn p(template: &str) -> Pattern {
        Pattern::compile("en", template, "lilo")
    }

    #[test]
    fn normalize_folds_accents_and_punctuation() {
        assert_eq!(normalize("Toca a música!"), "toca a musica");
        assert_eq!(normalize("  Olá,  LILO...  "), "ola lilo");
        assert_eq!(normalize("Coração & ação"), "coracao acao");
        assert_eq!(normalize(""), "");
        assert_eq!(normalize("!!!"), "");
    }

    #[test]
    fn normalize_keeps_digits() {
        assert_eq!(normalize("volume 30%"), "volume 30");
    }

    #[test]
    fn literal_pattern_matches_anywhere() {
        let pattern = p("close <name>");
        let m = pattern.match_tokens(&tokenize("ok now close lilo please"), false);
        assert_eq!(m.unwrap().specificity, 2);
    }

    #[test]
    fn name_placeholder_follows_the_wake_phrase() {
        let pattern = Pattern::compile("en", "close <name>", "jarvis");
        assert!(pattern
            .match_tokens(&tokenize("close jarvis"), false)
            .is_some());
        assert!(pattern
            .match_tokens(&tokenize("close lilo"), false)
            .is_none());
    }

    #[test]
    fn trailing_slot_is_greedy() {
        let pattern = p("play {track}");
        let m = pattern
            .match_tokens(&tokenize("play bohemian rhapsody"), false)
            .unwrap();
        assert_eq!(m.slots["track"], "bohemian rhapsody");
        assert_eq!(m.specificity, 1);
    }

    #[test]
    fn middle_slot_is_non_greedy() {
        let pattern = p("play {track} by {artist}");
        let m = pattern
            .match_tokens(&tokenize("play bohemian rhapsody by queen"), false)
            .unwrap();
        assert_eq!(m.slots["track"], "bohemian rhapsody");
        assert_eq!(m.slots["artist"], "queen");
        assert_eq!(m.specificity, 2);
    }

    #[test]
    fn optional_group_may_be_present_or_absent() {
        let pattern = Pattern::compile("pt", "toca [a|uma] musica {track}", "lilo");
        let with = pattern
            .match_tokens(&tokenize("toca a música Garota de Ipanema"), false)
            .unwrap();
        assert_eq!(with.slots["track"], "garota de ipanema");
        assert_eq!(with.specificity, 3, "toca + a + musica");

        let without = pattern
            .match_tokens(&tokenize("toca musica Garota de Ipanema"), false)
            .unwrap();
        assert_eq!(without.slots["track"], "garota de ipanema");
        assert_eq!(without.specificity, 2, "toca + musica");
    }

    #[test]
    fn portuguese_artist_pattern_splits_on_the_preposition() {
        let pattern = Pattern::compile("pt", "toca {track} (do|da|de) {artist}", "lilo");
        let m = pattern
            .match_tokens(&tokenize("toca Samurai do Djavan"), false)
            .unwrap();
        assert_eq!(m.slots["track"], "samurai");
        assert_eq!(m.slots["artist"], "djavan");
    }

    #[test]
    fn slot_requires_at_least_one_token() {
        assert!(p("play {track}")
            .match_tokens(&tokenize("play"), false)
            .is_none());
    }

    #[test]
    fn no_match_returns_none() {
        assert!(p("close <name>")
            .match_tokens(&tokenize("what is the weather"), false)
            .is_none());
    }

    #[test]
    fn fuzzy_tolerates_a_mangled_long_word() {
        let pattern = Pattern::compile("pt", "reproduzir {track}", "lilo");
        assert!(pattern
            .match_tokens(&tokenize("reproduzr bohemian"), true)
            .is_some());
        assert!(
            pattern
                .match_tokens(&tokenize("reproduzr bohemian"), false)
                .is_none(),
            "fuzzy must be opt-in"
        );
    }

    #[test]
    fn fuzzy_requires_the_first_letter_to_match() {
        // Real regression: a sound-alike query was misread and
        // fuzzy-matched, stopping playback nobody asked to stop.
        assert!(!token_eq("cara", "para", true));
        assert!(!token_eq("mais", "pais", true));
        // Endings may still drift, which is what fuzzy is for.
        assert!(token_eq("musicas", "musica", true));
    }

    #[test]
    fn fuzzy_never_collapses_short_words() {
        // "do" vs "da" must stay distinct, or every preposition matches.
        assert!(!token_eq("do", "da", true));
        assert_eq!(allowed_distance("do"), 0);
    }

    #[test]
    fn bounded_distance_rejects_far_words() {
        assert!(within_distance("musica", "musika", 1));
        assert!(!within_distance("musica", "cavalo", 2));
        assert!(!within_distance("play", "pause", 0));
    }

    #[test]
    fn unterminated_group_does_not_panic() {
        // A template bug must degrade, never take the app down. An unclosed
        // brace simply runs to the end of the template.
        let pattern = p("play {track");
        assert!(pattern
            .match_tokens(&tokenize("play something"), false)
            .is_some());
        assert!(pattern.match_tokens(&tokenize("play"), false).is_none());
        assert!(p("play [a|")
            .match_tokens(&tokenize("play a"), false)
            .is_some());
    }

    #[test]
    fn required_alternative_must_be_present() {
        let pattern = Pattern::compile("pt", "toca {track} (do|da|de) {artist}", "lilo");
        // Without the preposition the pattern must not collapse into two
        // adjacent slots — that was a real bug: "toca a musica Bohemian
        // Rhapsody" was split into track="bohemian", artist="rhapsody".
        assert!(pattern
            .match_tokens(&tokenize("toca bohemian rhapsody"), false)
            .is_none());
        let m = pattern
            .match_tokens(&tokenize("toca samurai do djavan"), false)
            .unwrap();
        assert_eq!(m.slots["track"], "samurai");
        assert_eq!(m.slots["artist"], "djavan");
    }

    #[test]
    fn required_alternative_counts_toward_specificity() {
        let pattern = Pattern::compile("en", "play {track} (by) {artist}", "lilo");
        let m = pattern
            .match_tokens(&tokenize("play creep by radiohead"), false)
            .unwrap();
        assert_eq!(m.specificity, 2, "play + by");
    }

    #[test]
    fn unterminated_required_group_does_not_panic() {
        assert!(p("play (a")
            .match_tokens(&tokenize("play a"), false)
            .is_some());
    }

    #[test]
    fn an_apostrophe_word_matches_its_normalized_tokens() {
        // "dimmi l'ora" normalizes to "dimmi l ora"; the compiler must split
        // the apostrophe word or the pattern silently never fires.
        let pattern = p("dimmi l'ora");
        assert!(pattern
            .match_tokens(&tokenize("dimmi l'ora"), false)
            .is_some());
        assert!(pattern
            .match_tokens(&tokenize("dimmi l ora"), false)
            .is_some());
        // Same behavior for a leading apostrophe in an Italian utterance.
        let pattern = Pattern::compile("it", "com'e il tempo", "lilo");
        assert!(pattern
            .match_tokens(&tokenize("com'è il tempo"), false)
            .is_some());
    }

    #[test]
    fn humanize_renders_a_readable_phrase() {
        assert_eq!(
            humanize("toca [a|uma|o] música {track}"),
            "toca a música <track>"
        );
        assert_eq!(
            humanize("toca {track} (do|da|de) {artist}"),
            "toca <track> do <artist>"
        );
        assert_eq!(humanize("pausa"), "pausa");
        assert_eq!(humanize("next [song|track]"), "next song");
    }

    #[test]
    fn has_slot_reports_free_text() {
        assert!(p("play {track}").has_slot());
        assert!(!p("close <name>").has_slot());
    }
}
