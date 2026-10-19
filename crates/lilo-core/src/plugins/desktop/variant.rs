//! Small parser for bounded GVariant command output, without a shell or regex.
pub(super) fn quote(text: &str) -> String {
    let mut result = String::from("'");
    for c in text.chars() {
        match c {
            '\\' => result.push_str("\\\\"),
            '\'' => result.push_str("\\'"),
            '\n' => result.push_str("\\n"),
            '\t' => result.push_str("\\t"),
            _ => result.push(c),
        }
    }
    result.push('\'');
    result
}
pub(super) fn strings(text: &str) -> Result<Vec<String>, ()> {
    let mut values = Vec::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\'' && c != '"' {
            continue;
        }
        let delim = c;
        let mut value = String::new();
        let mut closed = false;
        while let Some(c) = chars.next() {
            if c == delim {
                closed = true;
                break;
            }
            if c == '\\' {
                match chars.next().ok_or(())? {
                    '\\' => value.push('\\'),
                    '\'' => value.push('\''),
                    '"' => value.push('"'),
                    'n' => value.push('\n'),
                    't' => value.push('\t'),
                    'r' => value.push('\r'),
                    _ => return Err(()),
                }
            } else {
                value.push(c);
            }
        }
        if !closed {
            return Err(());
        }
        values.push(value);
    }
    Ok(values)
}
pub(super) fn numbers(text: &str) -> Vec<u32> {
    text.split(|c: char| c.is_whitespace() || "()[]<>,@".contains(c))
        .filter_map(|s| s.parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_gvariant_escaping_preserves_literal_unicode_and_quotes() {
        assert_eq!(
            quote("Hello 'world'\\\n你好"),
            "'Hello \\'world\\'\\\\\\n你好'"
        );
        assert_eq!(
            strings("([(':1.2', objectpath '/org/a11y/item')],)").unwrap(),
            [":1.2", "/org/a11y/item"]
        );
        assert_eq!(strings("('a\\'b\\n',)").unwrap(), ["a'b\n"]);
        assert!(strings("('unfinished").is_err());
    }
    #[test]
    fn test_state_parser_ignores_gvariant_type_numbers() {
        assert_eq!(numbers("([uint32 4096, 128],)"), [4096, 128]);
        assert_eq!(numbers("(<int32 12>,)"), [12]);
        assert!(numbers("(<int32 -1>,)").is_empty());
    }
}
