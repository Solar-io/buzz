//! Speech sanitization for video-chat turns.
//!
//! Agent replies are markdown; a spoken avatar must not read asterisks,
//! fences, or headings aloud. Ported from the standalone adapter
//! (`evie-anam-adapter/src/sanitize.ts`, battle-tested there 2026-08-24)
//! and unit-tested in `sanitize_tests.rs`.

/// Remove markdown constructs that would be misread aloud.
pub fn sanitize_for_speech(input: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;

    static FENCE: OnceLock<Regex> = OnceLock::new();
    static CODE: OnceLock<Regex> = OnceLock::new();
    static EMPHASIS: OnceLock<Regex> = OnceLock::new();
    static HEADING: OnceLock<Regex> = OnceLock::new();
    static QUOTE: OnceLock<Regex> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    static RULE: OnceLock<Regex> = OnceLock::new();
    static BULLET: OnceLock<Regex> = OnceLock::new();
    static BUZZ_URI: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    static NEWLINES: OnceLock<Regex> = OnceLock::new();

    let out = input;
    // fenced code blocks → short spoken placeholder
    let out = FENCE
        .get_or_init(|| Regex::new(r"(?s)```.*?```").unwrap())
        .replace_all(&out, " (code omitted) ");
    // inline code → keep the code text
    let out = CODE
        .get_or_init(|| Regex::new(r"`([^`]+)`").unwrap())
        .replace_all(&out, "$1");
    // emphasis / bold / strikethrough markers
    let out = EMPHASIS
        .get_or_init(|| Regex::new(r"(\*\*|__|\*|_|~~)").unwrap())
        .replace_all(&out, "");
    // heading markers and blockquotes
    let out = HEADING
        .get_or_init(|| Regex::new(r"(?m)^#{1,6}\s+").unwrap())
        .replace_all(&out, "");
    let out = QUOTE
        .get_or_init(|| Regex::new(r"(?m)^>\s?").unwrap())
        .replace_all(&out, "");
    // links: keep the label, drop the target
    let out = LINK
        .get_or_init(|| Regex::new(r"\[([^\]]+)\]\([^)]*\)").unwrap())
        .replace_all(&out, "$1");
    // horizontal rules → pause; bullets → nothing
    let out = RULE
        .get_or_init(|| Regex::new(r"(?m)^\s*[-*_]{3,}\s*$").unwrap())
        .replace_all(&out, " — ");
    let out = BULLET
        .get_or_init(|| Regex::new(r"(?m)^\s*[-*+]\s+").unwrap())
        .replace_all(&out, "");
    // buzz deep links carry no speech value
    let out = BUZZ_URI
        .get_or_init(|| Regex::new(r"buzz://\S+").unwrap())
        .replace_all(&out, "");
    let out = URL
        .get_or_init(|| Regex::new(r"https?://\S+").unwrap())
        .replace_all(&out, "(link)");
    // collapse whitespace artifacts
    let out = SPACES
        .get_or_init(|| Regex::new(r"[ \t]+").unwrap())
        .replace_all(&out, " ");
    let out = NEWLINES
        .get_or_init(|| Regex::new(r"\n{2,}").unwrap())
        .replace_all(&out, "\n");
    out.trim().to_string()
}

/// Split sanitized text into TTS-sized chunks on word boundaries.
pub fn chunk_for_speech(input: &str, size: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in input.split_whitespace() {
        if current.is_empty() {
            current = word.to_string();
        } else if current.len() + 1 + word.len() <= size {
            current.push(' ');
            current.push_str(word);
        } else {
            chunks.push(std::mem::take(&mut current));
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}
