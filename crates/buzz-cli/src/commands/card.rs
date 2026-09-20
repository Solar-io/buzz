//! D-035 decision cards: the authoring half of the `["card", …]` wire format.
//!
//! A card is an ordinary kind 9 whose CONTENT is human-readable fallback text
//! (every plain nostr client, including Buzz Desktop, renders that on its own)
//! plus one author tag carrying the structure. This module validates the
//! `--card` payload and builds both halves.
//!
//! Two wire versions, one builder:
//!
//! * **v1** — a single question: `{"v":1,"title":…,"body"?:…,"options":[…]}`
//! * **v2** — an interview of up to [`CARD_MAX_QUESTIONS`] questions:
//!   `{"v":2,"title"?:…,"body"?:…,"questions":[{"question":…,"header"?:…,
//!   "body"?:…,"multiSelect"?:…,"options":[…]}]}`
//!
//! `v` is optional on input (every shipped `--card` invocation omits it) and
//! always present on output; a `questions` key is what makes an unversioned
//! payload a v2 one.
//!
//! ## Why this file mirrors TypeScript line for line
//!
//! The web client has its own validator in
//! `web/src/features/channels/lib/decisionCard.ts`. Two validators of one wire
//! format drift, and a drifted pair means the CLI emits cards the web renders
//! as plain text. v1 guarded against that with a comment. This file instead
//! shares a fixture corpus with the web suite —
//! `test-fixtures/decision-cards/{limits,cases}.json`, executed by
//! [`card_fixture_corpus`] here and by `decisionCardFixtures.test.mjs` there.
//! Change a bound or an error message on one side only and exactly one suite
//! goes red.
//!
//! Authoring is deliberately STRICTER than the web parse (which tolerates
//! e.g. two recommended options by keeping the first, or an over-long body by
//! dropping it): this side refuses the send, so self-contradicting cards never
//! reach the wire. The corpus's `parseRaw` field records each of those
//! asymmetries as a tested fact.
//!
//! ## Resolved ids are UNIQUE
//!
//! One rule both sides enforce IDENTICALLY, rather than an asymmetry. Ids are
//! filled positionally when the author omits them (`"0"`, `"1"`, …) and taken
//! verbatim when supplied, so question 1 declaring `id:"1"` collides with
//! question 2's positional id. The answer format keys on those ids, and two
//! questions called `"1"` produce two `{"q":"1"}` entries no reader can tell
//! apart — an undefined structured answer, not a cosmetic flaw. So after
//! positional fill, any two questions, or any two options within one
//! question, that resolve to the same id are a refusal here and a `null` from
//! `parseCardTags` there. Applies to v1 too: the ID SCHEME is shared, so a
//! version-dependent uniqueness rule would be a second contract to keep in
//! step for no gain.

use crate::error::CliError;
use serde_json::{Map, Value};

// Hard bounds. Every one of these is mirrored by
// `test-fixtures/decision-cards/limits.json`, which `card_limits_match_manifest`
// asserts against — and which the web client's `CARD_LIMITS` is asserted
// against by its own suite.
pub(crate) const CARD_MAX_TAG_UNITS: usize = 16384;
pub(crate) const CARD_MAX_TITLE_CHARS: usize = 120;
pub(crate) const CARD_MAX_BODY_CHARS: usize = 4000;
pub(crate) const CARD_MAX_QUESTIONS: usize = 6;
pub(crate) const CARD_MAX_QUESTION_CHARS: usize = 300;
pub(crate) const CARD_MAX_QUESTION_BODY_CHARS: usize = 1000;
pub(crate) const CARD_MAX_HEADER_CHARS: usize = 12;
pub(crate) const CARD_MAX_OPTIONS: usize = 8;
pub(crate) const CARD_MAX_LABEL_CHARS: usize = 200;
pub(crate) const CARD_MAX_DESCRIPTION_CHARS: usize = 200;
pub(crate) const CARD_MAX_ID_CHARS: usize = 40;

/// JS `.length` parity: the web validator bounds every string by UTF-16
/// code units, so this side measures the same way. A Rust `chars().count()`
/// is smaller for astral characters (emoji count 1 there, 2 here), which
/// would let the CLI emit a card the web parser then rejects — the exact
/// drift this builder exists to prevent.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The ONE trim set for a card string field: Unicode `White_Space` ∪ U+FEFF.
///
/// Neither language's built-in trim is that set, and the two disagree in BOTH
/// directions: `str::trim` (Unicode `White_Space`) strips U+0085 and leaves
/// U+FEFF, while JavaScript's `String.prototype.trim` strips U+FEFF and
/// leaves U+0085. Every card field is trimmed on both sides, so calling
/// either built-in makes the two validators disagree about what the field
/// even IS — this builder accepted `{"label":"\u{FEFF}"}`, emitted the tag,
/// and the web parser returned null for it: a published card that renders as
/// plain text.
///
/// The mirror is `CARD_TRIM_CHARS` in
/// `web/src/features/channels/lib/decisionCard.ts` — the same code points in
/// the same order. Do not call `.trim()` on a card field; use [`card_trim`].
const CARD_TRIM_CHARS: &[char] = &[
    // Unicode White_Space …
    '\u{0009}', '\u{000A}', '\u{000B}', '\u{000C}', '\u{000D}', '\u{0020}', '\u{0085}', '\u{00A0}',
    '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}',
    '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}',
    '\u{3000}',
    // … ∪ U+FEFF (ZERO WIDTH NO-BREAK SPACE / BOM), which is NOT White_Space.
    '\u{FEFF}',
];

/// `str::trim` over [`CARD_TRIM_CHARS`] instead of Unicode `White_Space`.
fn card_trim(value: &str) -> &str {
    value.trim_matches(CARD_TRIM_CHARS)
}

fn usage(message: String) -> CliError {
    CliError::Usage(format!("--card: {message}"))
}

/// The two `serde_json` decode failures that mean "unpaired surrogate".
///
/// Both are raised ONLY by `parse_unicode_escape` (serde_json `src/read.rs`)
/// and only on the surrogate path: a trailing surrogate with no lead, or a
/// lead whose partner is missing or is another lead. A merely truncated
/// escape (`"\u12"`) is an *invalid escape*, a different code — so matching
/// these two texts does not over-claim. `serde_json::Error` does not expose
/// its `ErrorCode`, so the message is the only handle;
/// `card_normalizes_the_serde_surrogate_refusal` pins all three spellings, and
/// a serde upgrade that reworded them fails that test rather than silently
/// falling through to "invalid JSON".
const SERDE_UNPAIRED_SURROGATE: [&str; 2] = [
    "lone leading surrogate in hex escape",
    "unexpected end of hex escape",
];

/// A lone half of a surrogate pair is not valid UTF-8, so `serde_json`
/// refuses the payload while DECODING it — one layer earlier than the web
/// builder's explicit check, and with a message about hex escapes rather
/// than about the card. Normalized here to the web side's refusal, which is
/// the reason string the shared corpus pins for both implementations.
///
/// Rust cannot hold an unpaired surrogate in a `String` at all, so this
/// decode IS the enforcement point: there is no later field check to add.
fn json_error(error: &serde_json::Error) -> CliError {
    let detail = error.to_string();
    if SERDE_UNPAIRED_SURROGATE
        .iter()
        .any(|marker| detail.contains(marker))
    {
        usage(format!(
            "payload must not contain unpaired surrogates ({detail})"
        ))
    } else {
        usage(format!("invalid JSON: {detail}"))
    }
}

fn bounded_utf16(value: &str, max_chars: usize) -> Option<String> {
    let trimmed = card_trim(value);
    if trimmed.is_empty() || utf16_len(trimmed) > max_chars {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn require_bounded(
    value: Option<&Value>,
    max_chars: usize,
    message: String,
) -> Result<String, CliError> {
    bounded_utf16(value.and_then(Value::as_str).unwrap_or(""), max_chars)
        .ok_or_else(|| usage(message))
}

/// A body on the AUTHORING side: absent or blank is fine, over-length is a
/// refusal. The web parse degrades the same field to "no body" instead —
/// leniency runs render-side only, so an author never silently ships a card
/// whose context was truncated away.
fn strict_body(
    value: Option<&Value>,
    max_chars: usize,
    message: &str,
) -> Result<Option<String>, CliError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(raw) => {
            let text = card_trim(raw.as_str().ok_or_else(|| usage(message.to_string()))?);
            if text.is_empty() {
                Ok(None)
            } else if utf16_len(text) > max_chars {
                Err(usage(message.to_string()))
            } else {
                Ok(Some(text.to_string()))
            }
        }
    }
}

/// The stderr guidance for a decision card sent with no `--mention`.
///
/// The web Asks inbox (D-035 follow-on) treats a card as an ASK only when it
/// p-tags the viewer — outside a 2-party DM there is no leniency to infer the
/// askee. An unmentioned card is therefore invisible to every Asks inbox; the
/// agent-side author should know that at send time. A WARNING, not a refusal:
/// broadcast cards (channel polls) are legitimate and common.
pub(crate) fn card_without_mention_notice(has_card: bool, mention_count: usize) -> Option<String> {
    if has_card && mention_count == 0 {
        Some("note: card has no --mention; it will not appear in any Asks inbox".to_string())
    } else {
        None
    }
}

/// One validated option, in the shape the fallback text generator needs.
struct OptionView {
    label: String,
    description: Option<String>,
    recommended: bool,
}

/// A validated card: the wire payload plus everything the fallback text
/// generator needs. A named struct rather than a tuple because clippy's
/// `type_complexity` lint is an error under the repo's `-D warnings` gate.
struct BuiltCard {
    payload: Map<String, Value>,
    /// The title as DISPLAYED — a v2 payload may omit it, in which case it is
    /// the first question's text and is deliberately absent from `payload`.
    title: String,
    body: Option<String>,
    questions: Vec<QuestionView>,
}

/// One validated question. A v1 card produces exactly one of these, whose
/// text is the card's title — the same normalization the web parser applies,
/// so both sides generate the fallback from one shape.
struct QuestionView {
    text: String,
    body: Option<String>,
    multi_select: bool,
    options: Vec<OptionView>,
}

/// `allow_description` mirrors the web parser: v1 has no per-option
/// `description`, so a v1 payload carrying that key has it DROPPED from the
/// canonical output rather than refused. Refusing would make this builder
/// stricter than the v1 format it is emitting, and the web parser ignores the
/// key on a v1 card for the same reason — v1 shipped without it, so an
/// unknown key there can never be a reason to reject the card. v2 validates
/// the same field strictly, because there it is part of the format.
fn build_options(
    raw: Option<&Value>,
    prefix: &str,
    allow_description: bool,
) -> Result<(Vec<Value>, Vec<OptionView>), CliError> {
    let raw_options = raw
        .and_then(Value::as_array)
        .ok_or_else(|| usage(format!("{prefix}options must be an array")))?;
    if raw_options.len() < 2 || raw_options.len() > CARD_MAX_OPTIONS {
        return Err(usage(format!(
            "{prefix}needs 2-{CARD_MAX_OPTIONS} options (got {})",
            raw_options.len()
        )));
    }
    let mut recommended_count = 0usize;
    // Resolved id -> the 1-based position that claimed it, so the refusal can
    // name BOTH colliding options rather than only the second one. Mirrors
    // `idOwner` in the web builder's `buildOptions`.
    let mut id_owner: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut wire: Vec<Value> = Vec::with_capacity(raw_options.len());
    let mut view: Vec<OptionView> = Vec::with_capacity(raw_options.len());
    for (index, candidate) in raw_options.iter().enumerate() {
        let option = candidate
            .as_object()
            .ok_or_else(|| usage(format!("{prefix}option {} must be an object", index + 1)))?;
        let label = require_bounded(
            option.get("label"),
            CARD_MAX_LABEL_CHARS,
            format!(
                "{prefix}option {} label must be 1-{CARD_MAX_LABEL_CHARS} characters",
                index + 1
            ),
        )?;
        // Mirror of the web builder: an explicit bounded id rides the wire,
        // an absent one is omitted entirely (the web parse derives
        // positional ids — ids are render keys, not identity promises).
        let mut entry = Map::new();
        if let Some(id_value) = option.get("id") {
            let id = card_trim(id_value.as_str().ok_or_else(|| {
                usage(format!("{prefix}option {} id must be a string", index + 1))
            })?);
            if utf16_len(id) > CARD_MAX_ID_CHARS {
                return Err(usage(format!(
                    "{prefix}option {} id must be at most {CARD_MAX_ID_CHARS} characters",
                    index + 1
                )));
            }
            if !id.is_empty() {
                entry.insert("id".to_string(), Value::String(id.to_string()));
            }
        }
        // The id the WEB PARSER will resolve for this option: an omitted or
        // blank explicit id is not written to the wire and becomes the
        // position.
        let resolved_id = match entry.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => index.to_string(),
        };
        if let Some(owner) = id_owner.get(&resolved_id) {
            return Err(usage(format!(
                "{prefix}options {owner} and {} resolve to the same id {}",
                index + 1,
                Value::String(resolved_id)
            )));
        }
        id_owner.insert(resolved_id, index + 1);
        entry.insert("label".to_string(), Value::String(label.clone()));
        let mut description = None;
        if allow_description && option.get("description").is_some() {
            let text = require_bounded(
                option.get("description"),
                CARD_MAX_DESCRIPTION_CHARS,
                format!(
                    "{prefix}option {} description must be 1-{CARD_MAX_DESCRIPTION_CHARS} characters",
                    index + 1
                ),
            )?;
            entry.insert("description".to_string(), Value::String(text.clone()));
            description = Some(text);
        }
        let recommended = option.get("recommended").and_then(Value::as_bool) == Some(true);
        if recommended {
            recommended_count += 1;
            entry.insert("recommended".to_string(), Value::Bool(true));
        }
        wire.push(Value::Object(entry));
        view.push(OptionView {
            label,
            description,
            recommended,
        });
    }
    if recommended_count > 1 {
        return Err(usage(format!(
            "{prefix}at most one option may be recommended ({recommended_count} marked)"
        )));
    }
    Ok((wire, view))
}

/// Which version is the author writing? An explicit `v` wins; with none, a
/// `questions` key means v2 and anything else means v1.
///
/// The version is matched by VALUE, not by serde's storage type. JSON has one
/// number type, so `1`, `1.0` and `1e0` are the same value and the web
/// parser (`parsed.v === 1`) cannot tell them apart even in principle —
/// matching on `as_u64` alone made this builder refuse `{"v":1.0,…}` payloads
/// the web client renders happily.
fn resolve_version(obj: &Map<String, Value>) -> Result<u8, CliError> {
    match obj.get("v") {
        None => Ok(if obj.contains_key("questions") { 2 } else { 1 }),
        Some(value) => match integral_number(value) {
            Some(1) => Ok(1),
            Some(2) => Ok(2),
            _ => Err(usage(format!(
                "unsupported version {value} (expected 1 or 2)"
            ))),
        },
    }
}

/// A JSON number whose value is a small non-negative integer, however it was
/// written. Non-numbers, fractions and out-of-range values are `None` — the
/// caller reports them all as an unsupported version.
fn integral_number(value: &Value) -> Option<u8> {
    let number = value.as_f64()?;
    if !number.is_finite() || number < 0.0 || number > f64::from(u8::MAX) {
        return None;
    }
    let truncated = number.trunc();
    // An exact float comparison on purpose: `1`, `1.0` and `1e0` all decode to
    // the bit pattern of 1.0 and are equal to their own truncation, while
    // `1.5` is not. Nothing here is arithmetic, so there is no rounding error
    // to tolerate.
    #[allow(clippy::float_cmp)]
    if truncated != number {
        return None;
    }
    Some(truncated as u8)
}

fn build_v1(obj: &Map<String, Value>) -> Result<BuiltCard, CliError> {
    let title = require_bounded(
        obj.get("title"),
        CARD_MAX_TITLE_CHARS,
        format!("title must be 1-{CARD_MAX_TITLE_CHARS} characters"),
    )?;
    let body = strict_body(
        obj.get("body"),
        CARD_MAX_BODY_CHARS,
        &format!("body must be at most {CARD_MAX_BODY_CHARS} characters"),
    )?;
    let (options_wire, options_view) = build_options(obj.get("options"), "", false)?;

    let mut payload = Map::new();
    payload.insert("v".to_string(), Value::Number(1.into()));
    payload.insert("title".to_string(), Value::String(title.clone()));
    if let Some(ref text) = body {
        payload.insert("body".to_string(), Value::String(text.clone()));
    }
    payload.insert("options".to_string(), Value::Array(options_wire));

    // A v1 card IS an interview of one question whose text is the title —
    // the same normalization `parseCardTags` performs, so the fallback text
    // generator below has one shape to render.
    let questions = vec![QuestionView {
        text: title.clone(),
        body: None,
        multi_select: false,
        options: options_view,
    }];
    Ok(BuiltCard {
        payload,
        title,
        body,
        questions,
    })
}

fn build_v2(obj: &Map<String, Value>) -> Result<BuiltCard, CliError> {
    let raw_questions = obj
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| usage("questions must be an array".to_string()))?;
    if raw_questions.is_empty() || raw_questions.len() > CARD_MAX_QUESTIONS {
        return Err(usage(format!(
            "needs 1-{CARD_MAX_QUESTIONS} questions (got {})",
            raw_questions.len()
        )));
    }
    let mut questions_wire: Vec<Value> = Vec::with_capacity(raw_questions.len());
    let mut questions_view: Vec<QuestionView> = Vec::with_capacity(raw_questions.len());
    // Same collision rule as the options one level down. See the module doc.
    let mut id_owner: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (index, candidate) in raw_questions.iter().enumerate() {
        let prefix = format!("question {} ", index + 1);
        let question = candidate
            .as_object()
            .ok_or_else(|| usage(format!("question {} must be an object", index + 1)))?;
        let text = require_bounded(
            question.get("question"),
            CARD_MAX_QUESTION_CHARS,
            format!("{prefix}text must be 1-{CARD_MAX_QUESTION_CHARS} characters"),
        )?;
        let mut entry = Map::new();
        if let Some(id_value) = question.get("id") {
            let id = card_trim(
                id_value
                    .as_str()
                    .ok_or_else(|| usage(format!("{prefix}id must be a string")))?,
            );
            if utf16_len(id) > CARD_MAX_ID_CHARS {
                return Err(usage(format!(
                    "{prefix}id must be at most {CARD_MAX_ID_CHARS} characters"
                )));
            }
            if !id.is_empty() {
                entry.insert("id".to_string(), Value::String(id.to_string()));
            }
        }
        let resolved_id = match entry.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => index.to_string(),
        };
        if let Some(owner) = id_owner.get(&resolved_id) {
            return Err(usage(format!(
                "questions {owner} and {} resolve to the same id {}",
                index + 1,
                Value::String(resolved_id)
            )));
        }
        id_owner.insert(resolved_id, index + 1);
        if question.get("header").is_some() {
            let header = require_bounded(
                question.get("header"),
                CARD_MAX_HEADER_CHARS,
                format!("{prefix}header must be 1-{CARD_MAX_HEADER_CHARS} characters"),
            )?;
            entry.insert("header".to_string(), Value::String(header));
        }
        entry.insert("question".to_string(), Value::String(text.clone()));
        let body = strict_body(
            question.get("body"),
            CARD_MAX_QUESTION_BODY_CHARS,
            &format!("{prefix}body must be at most {CARD_MAX_QUESTION_BODY_CHARS} characters"),
        )?;
        if let Some(ref text) = body {
            entry.insert("body".to_string(), Value::String(text.clone()));
        }
        let multi_select = question.get("multiSelect").and_then(Value::as_bool) == Some(true);
        if multi_select {
            entry.insert("multiSelect".to_string(), Value::Bool(true));
        }
        let (options_wire, options_view) = build_options(question.get("options"), &prefix, true)?;
        entry.insert("options".to_string(), Value::Array(options_wire));
        questions_wire.push(Value::Object(entry));
        questions_view.push(QuestionView {
            text,
            body,
            multi_select,
            options: options_view,
        });
    }

    let mut payload = Map::new();
    payload.insert("v".to_string(), Value::Number(2.into()));
    // One question may borrow its title from the question itself; more than
    // one must be named, or the interview reads as its own first question.
    // A borrowed title is never written to the wire, so it round-trips
    // through the web parser as a derivation rather than as data.
    let title = if obj.get("title").is_some() || questions_view.len() > 1 {
        let explicit = require_bounded(
            obj.get("title"),
            CARD_MAX_TITLE_CHARS,
            format!("title must be 1-{CARD_MAX_TITLE_CHARS} characters"),
        )?;
        payload.insert("title".to_string(), Value::String(explicit.clone()));
        explicit
    } else {
        questions_view[0].text.clone()
    };
    let body = strict_body(
        obj.get("body"),
        CARD_MAX_BODY_CHARS,
        &format!("body must be at most {CARD_MAX_BODY_CHARS} characters"),
    )?;
    if let Some(ref text) = body {
        payload.insert("body".to_string(), Value::String(text.clone()));
    }
    payload.insert("questions".to_string(), Value::Array(questions_wire));
    Ok(BuiltCard {
        payload,
        title,
        body,
        questions: questions_view,
    })
}

/// The human-readable content a card event carries alongside the tag.
///
/// Byte-identical to the web's `cardFallbackText` — pinned by the shared
/// corpus, whose every accept case records the exact expected text. The v1
/// shape is a special case of the v2 one rather than a branch: a lone
/// question whose text IS the title, with no body and no multi-select hint,
/// contributes no heading of its own, which is exactly the text v1 has
/// emitted since 9/16. A question's `header` is a progress-chip label and
/// deliberately never appears here.
fn fallback_text(title: &str, body: Option<&str>, questions: &[QuestionView]) -> String {
    let mut lines: Vec<String> = vec![format!("**{title}**")];
    if let Some(text) = body {
        lines.push(String::new());
        lines.push(text.to_string());
    }
    let count = questions.len();
    for (index, question) in questions.iter().enumerate() {
        let implicit = count == 1
            && question.text == title
            && question.body.is_none()
            && !question.multi_select;
        if !implicit {
            let number = if count > 1 {
                format!("{}. ", index + 1)
            } else {
                String::new()
            };
            let hint = if question.multi_select {
                " _(choose any that apply)_"
            } else {
                ""
            };
            lines.push(String::new());
            lines.push(format!("**{number}{}**{hint}", question.text));
            if let Some(ref text) = question.body {
                lines.push(String::new());
                lines.push(text.clone());
            }
        }
        lines.push(String::new());
        for option in &question.options {
            let marker = if option.recommended {
                " *(Recommended)*"
            } else {
                ""
            };
            let detail = match option.description {
                Some(ref text) => format!(" — {text}"),
                None => String::new(),
            };
            lines.push(format!("- {}{marker}{detail}", option.label));
        }
    }
    lines.push(String::new());
    lines.push("_Reply with an option or your own answer._".to_string());
    lines.join("\n")
}

/// Validate a `--card` payload and build both halves of the outgoing kind 9:
/// the `["card", …]` tag the web client renders as a tappable question, and
/// the human-readable fallback content every plain client shows on its own.
pub(crate) fn build_card_tag(raw: &str) -> Result<(Vec<String>, String), CliError> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| json_error(&e))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| usage("payload must be a JSON object".to_string()))?;
    let card = match resolve_version(obj)? {
        1 => build_v1(obj)?,
        _ => build_v2(obj)?,
    };
    let json = serde_json::to_string(&Value::Object(card.payload))
        .map_err(|e| CliError::Other(format!("--card: serialization failed: {e}")))?;
    if utf16_len(&json) > CARD_MAX_TAG_UNITS {
        return Err(usage(format!(
            "payload exceeds {CARD_MAX_TAG_UNITS} characters after serialization"
        )));
    }
    let tag = vec!["card".to_string(), json];
    let fallback = fallback_text(&card.title, card.body.as_deref(), &card.questions);
    Ok((tag, fallback))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared wire corpus. `include_str!` registers a rebuild dependency,
    /// so editing a fixture re-runs these tests without a `cargo clean`.
    const LIMITS_JSON: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-fixtures/decision-cards/limits.json"
    ));
    const CASES_JSON: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-fixtures/decision-cards/cases.json"
    ));

    fn manifest(limits: &Value, key: &str) -> usize {
        limits
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or_else(|| panic!("limits.json has no numeric {key}")) as usize
    }

    #[test]
    fn card_limits_match_manifest() {
        // Every bound, against the file the web client's CARD_LIMITS is also
        // asserted against. Change one number on one side and exactly one of
        // the two suites fails.
        let limits: Value = serde_json::from_str(LIMITS_JSON).expect("limits.json parses");
        assert_eq!(manifest(&limits, "maxTagBytes"), CARD_MAX_TAG_UNITS);
        assert_eq!(manifest(&limits, "maxTitleChars"), CARD_MAX_TITLE_CHARS);
        assert_eq!(manifest(&limits, "maxBodyChars"), CARD_MAX_BODY_CHARS);
        assert_eq!(manifest(&limits, "maxQuestions"), CARD_MAX_QUESTIONS);
        assert_eq!(
            manifest(&limits, "maxQuestionChars"),
            CARD_MAX_QUESTION_CHARS
        );
        assert_eq!(
            manifest(&limits, "maxQuestionBodyChars"),
            CARD_MAX_QUESTION_BODY_CHARS
        );
        assert_eq!(manifest(&limits, "maxHeaderChars"), CARD_MAX_HEADER_CHARS);
        assert_eq!(manifest(&limits, "maxOptions"), CARD_MAX_OPTIONS);
        assert_eq!(manifest(&limits, "maxLabelChars"), CARD_MAX_LABEL_CHARS);
        assert_eq!(
            manifest(&limits, "maxDescriptionChars"),
            CARD_MAX_DESCRIPTION_CHARS
        );
        assert_eq!(manifest(&limits, "maxIdChars"), CARD_MAX_ID_CHARS);
    }

    #[test]
    fn card_fixture_corpus() {
        let limits: Value = serde_json::from_str(LIMITS_JSON).expect("limits.json parses");
        let cases: Vec<Value> = serde_json::from_str(CASES_JSON).expect("cases.json parses");
        // The harness self-check: a fixture path that silently resolved to an
        // empty list would run zero cases and report success.
        assert_eq!(
            cases.len(),
            manifest(&limits, "caseCount"),
            "corpus size disagrees with limits.json"
        );
        assert!(cases.len() >= 18, "corpus is too small ({})", cases.len());

        let mut accepted = 0usize;
        let mut rejected = 0usize;
        for case in &cases {
            let name = case["name"].as_str().expect("case has a name");
            // `payloadRaw` is the author payload as raw JSON TEXT and wins
            // when present: some inputs cannot survive a trip through a JSON
            // VALUE. A lone surrogate would make THIS FILE undecodable by
            // serde_json, and a numeric spelling (`1e0`) is normalized away by
            // both parsers. The web driver reads the same field, so neither
            // side gets an easier input than the other.
            let payload = match case.get("payloadRaw").and_then(Value::as_str) {
                Some(raw) => raw.to_string(),
                None => serde_json::to_string(&case["payload"]).expect("payload re-serializes"),
            };
            match case["expect"].as_str() {
                Some("accept") => {
                    let (tag, fallback) = build_card_tag(&payload)
                        .unwrap_or_else(|e| panic!("{name}: expected accept, got {e}"));
                    assert_eq!(tag[0], "card", "{name}: tag name");
                    let canonical: Value =
                        serde_json::from_str(&tag[1]).expect("canonical payload is JSON");
                    assert_eq!(canonical, case["canonical"], "{name}: canonical payload");
                    assert_eq!(
                        fallback,
                        case["fallback"].as_str().expect("accept case has fallback"),
                        "{name}: fallback text"
                    );
                    accepted += 1;
                }
                Some("reject") => {
                    let error = build_card_tag(&payload)
                        .expect_err(&format!("{name}: expected reject"))
                        .to_string();
                    let reason = case["reason"].as_str().expect("reject case has a reason");
                    assert!(
                        error.contains(reason),
                        "{name}: {error:?} does not contain {reason:?}"
                    );
                    rejected += 1;
                }
                other => panic!("{name}: unknown expect {other:?}"),
            }
        }
        assert_eq!(accepted, 17, "accept-case count moved");
        assert_eq!(rejected, 26, "reject-case count moved");
    }

    // ---- Asks inbox authoring guardrail (D-035 follow-on) ----

    #[test]
    fn send_card_without_mention_warns() {
        // A card with zero mentions never lands in an Asks inbox (the web's
        // askForMe requires the p-tag outside 2-party DMs) — the author must
        // hear that at send time. Warning, not refusal.
        let notice = card_without_mention_notice(true, 0)
            .expect("card without mention must produce a notice");
        assert!(notice.contains("note: card has no --mention"));
        assert!(notice.contains("Asks inbox"));
    }

    #[test]
    fn send_card_with_mention_or_without_card_does_not_warn() {
        // Any mention addresses the ask; no card means nothing to warn about.
        assert!(card_without_mention_notice(true, 1).is_none());
        assert!(card_without_mention_notice(false, 0).is_none());
    }

    #[test]
    fn card_builds_tag_and_fallback_content() {
        let (tag, fallback) = build_card_tag(
            r#"{"title":"Ship the claims fix?","body":"Second bounce needed.",
                "options":[{"id":"now","label":"Relaunch now"},{"label":"Let it ride","recommended":true}]}"#,
        )
        .expect("valid card builds");
        assert_eq!(tag[0], "card");
        let payload: Value = serde_json::from_str(&tag[1]).unwrap();
        assert_eq!(payload["v"], 1);
        assert_eq!(payload["title"], "Ship the claims fix?");
        assert_eq!(payload["body"], "Second bounce needed.");
        // Explicit id rides, absent id is omitted (web parse derives positional).
        assert_eq!(payload["options"][0]["id"], "now");
        assert!(payload["options"][1].get("id").is_none());
        assert_eq!(payload["options"][1]["recommended"], true);
        // Fallback mirrors the web generator byte-for-byte.
        assert_eq!(
            fallback,
            "**Ship the claims fix?**\n\nSecond bounce needed.\n\n- Relaunch now\n- Let it ride *(Recommended)*\n\n_Reply with an option or your own answer._"
        );
    }

    #[test]
    fn card_fallback_without_body_matches_web_shape() {
        let (_, fallback) =
            build_card_tag(r#"{"title":"Q","options":[{"label":"A"},{"label":"B"}]}"#).unwrap();
        assert_eq!(
            fallback,
            "**Q**\n\n- A\n- B\n\n_Reply with an option or your own answer._"
        );
    }

    #[test]
    fn card_rejects_two_recommended_options() {
        let err = build_card_tag(
            r#"{"title":"Q","options":[{"label":"A","recommended":true},{"label":"B","recommended":true}]}"#,
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("at most one option may be recommended"));
    }

    #[test]
    fn card_rejects_under_two_and_over_eight_options() {
        let one = build_card_tag(r#"{"title":"Q","options":[{"label":"A"}]}"#).unwrap_err();
        assert!(one.to_string().contains("needs 2-8 options (got 1)"));
        let labels: Vec<String> = (0..9).map(|i| format!("{{\"label\":\"o{i}\"}}")).collect();
        let nine = format!(r#"{{"title":"Q","options":[{}]}}"#, labels.join(","));
        let err = build_card_tag(&nine).unwrap_err();
        assert!(err.to_string().contains("needs 2-8 options (got 9)"));
    }

    #[test]
    fn card_accepts_v2() {
        // v2 is the interview format. Split out of the former
        // `card_rejects_unknown_version_and_oversized_title` when v2 landed:
        // the version this builder used to refuse is now the one it ships.
        let (tag, fallback) = build_card_tag(
            r#"{"v":2,"title":"Ship the claims fix","questions":[
                 {"id":"scope","header":"Scope","question":"Which surfaces?","multiSelect":true,
                  "options":[{"id":"web","label":"Web","description":"The SPA","recommended":true},
                             {"label":"Desktop"}]},
                 {"question":"When?","options":[{"label":"Now"},{"label":"Later"}]}]}"#,
        )
        .expect("a v2 card builds");
        let payload: Value = serde_json::from_str(&tag[1]).unwrap();
        assert_eq!(payload["v"], 2);
        assert_eq!(payload["questions"].as_array().unwrap().len(), 2);
        assert_eq!(payload["questions"][0]["header"], "Scope");
        assert_eq!(payload["questions"][0]["multiSelect"], true);
        assert_eq!(
            payload["questions"][0]["options"][0]["description"],
            "The SPA"
        );
        // Author order is preserved — a renderer must never re-sort it.
        assert_eq!(payload["questions"][1]["question"], "When?");
        assert_eq!(
            fallback,
            "**Ship the claims fix**\n\n**1. Which surfaces?** _(choose any that apply)_\n\n- Web *(Recommended)* — The SPA\n- Desktop\n\n**2. When?**\n\n- Now\n- Later\n\n_Reply with an option or your own answer._"
        );
    }

    #[test]
    fn card_rejects_v3() {
        // The other half of the split: an unknown FUTURE version is still a
        // refusal, so the version gate did not simply get deleted.
        let v3 = build_card_tag(r#"{"v":3,"title":"Q","options":[{"label":"A"},{"label":"B"}]}"#)
            .unwrap_err();
        assert!(v3.to_string().contains("unsupported version 3"));
        // A stringly-typed version is not version 2 either.
        let stringly =
            build_card_tag(r#"{"v":"2","title":"Q","options":[{"label":"A"},{"label":"B"}]}"#)
                .unwrap_err();
        assert!(stringly.to_string().contains("unsupported version"));
    }

    #[test]
    fn card_rejects_oversized_title() {
        let long = "x".repeat(121);
        let err = build_card_tag(&format!(
            r#"{{"title":"{long}","options":[{{"label":"A"}},{{"label":"B"}}]}}"#
        ))
        .unwrap_err();
        assert!(err.to_string().contains("title must be 1-120"));
    }

    #[test]
    fn card_rejects_more_than_six_questions() {
        let question = r#"{"question":"Fine?","options":[{"label":"A"},{"label":"B"}]}"#;
        let six: Vec<&str> = (0..6).map(|_| question).collect();
        assert!(build_card_tag(&format!(
            r#"{{"v":2,"title":"Q","questions":[{}]}}"#,
            six.join(",")
        ))
        .is_ok());
        let seven: Vec<&str> = (0..7).map(|_| question).collect();
        let err = build_card_tag(&format!(
            r#"{{"v":2,"title":"Q","questions":[{}]}}"#,
            seven.join(",")
        ))
        .unwrap_err();
        assert!(err.to_string().contains("needs 1-6 questions (got 7)"));
    }

    #[test]
    fn card_infers_v2_from_a_questions_key() {
        // Every shipped `--card` invocation omits `v`; a `questions` key is
        // the only thing that makes an unversioned payload a v2 one. The
        // builder always EMITS the version, which is why the web parser can
        // insist on it.
        let (tag, _) = build_card_tag(
            r#"{"questions":[{"question":"Ship tonight?","options":[{"label":"Yes"},{"label":"No"}]}]}"#,
        )
        .expect("an unversioned questions payload is v2");
        let payload: Value = serde_json::from_str(&tag[1]).unwrap();
        assert_eq!(payload["v"], 2);
        // A single question borrows its title, and the borrowed title is not
        // written to the wire — the web parser re-derives it.
        assert!(payload.get("title").is_none());
    }

    #[test]
    fn card_bounds_measure_utf16_units_not_rust_chars() {
        // The drift proof: 101 rocket emoji are 101 Rust chars (under a naive
        // 200 bound) but 202 UTF-16 units — the web's JS `.length` rejects
        // that label, so this side must too or the CLI ships cards the web
        // renders as fallback text.
        let emoji_ok: String = "🚀".repeat(99); // 198 UTF-16 units — passes
        let emoji_over: String = "🚀".repeat(101); // 202 UTF-16 units — rejects
        let ok = format!(r#"{{"title":"Q","options":[{{"label":"{emoji_ok}"}},{{"label":"B"}}]}}"#);
        assert!(build_card_tag(&ok).is_ok());
        let over =
            format!(r#"{{"title":"Q","options":[{{"label":"{emoji_over}"}},{{"label":"B"}}]}}"#);
        let err = build_card_tag(&over).unwrap_err();
        assert!(err.to_string().contains("label must be 1-200"));
    }

    #[test]
    fn card_rejects_oversized_serialized_payload() {
        // The reachable fat-tag path under the v2 cap: six questions, each
        // with a legal 1000-char body and eight fully described max-length
        // options, serialize past 16384 units. Every field is individually
        // legal — this is exactly the authoring mistake the tag cap catches.
        // (A v1 card can no longer reach it: its worst case is ~6 KB.)
        let label = "y".repeat(200);
        let description = "d".repeat(200);
        let options: Vec<String> = (0..8)
            .map(|_| format!(r#"{{"label":"{label}","description":"{description}"}}"#))
            .collect();
        let question = format!(
            r#"{{"question":"{}","body":"{}","options":[{}]}}"#,
            "q".repeat(300),
            "b".repeat(1000),
            options.join(",")
        );
        let questions: Vec<String> = (0..6).map(|_| question.clone()).collect();
        let fat = format!(
            r#"{{"v":2,"title":"Q","questions":[{}]}}"#,
            questions.join(",")
        );
        let err = build_card_tag(&fat).unwrap_err();
        assert!(err.to_string().contains("exceeds 16384"));
    }

    // ---- TS/Rust contract divergences found by QA on 2026-09-20 ----

    #[test]
    fn card_trims_the_shared_set_not_rust_whitespace() {
        // U+FEFF is NOT Unicode White_Space, so `str::trim` left it in place
        // and this builder happily emitted `{"label":"\u{FEFF}"}` — a card
        // whose label the web parser trims to empty, i.e. a published card
        // that degrades to plain text. U+0085 is the mirror case: Rust
        // trimmed it, JavaScript did not.
        let feff = build_card_tag(
            "{\"title\":\"Q\",\"options\":[{\"label\":\"\u{FEFF}\"},{\"label\":\"B\"}]}",
        )
        .unwrap_err();
        assert!(feff.to_string().contains("option 1 label must be 1-200"));
        let nel = build_card_tag(
            "{\"title\":\"Q\",\"options\":[{\"label\":\"\u{0085}\"},{\"label\":\"B\"}]}",
        )
        .unwrap_err();
        assert!(nel.to_string().contains("option 1 label must be 1-200"));

        // At the bound: 120 x's padded with one of each is 122 UTF-16 units
        // on the wire and exactly 120 after the shared trim.
        let padded = format!(
            "{{\"title\":\"\u{FEFF}{}\u{0085}\",\"options\":[{{\"label\":\"A\"}},{{\"label\":\"B\"}}]}}",
            "x".repeat(120)
        );
        let (tag, _) = build_card_tag(&padded).expect("a padded title trims to the bound");
        let payload: Value = serde_json::from_str(&tag[1]).unwrap();
        assert_eq!(payload["title"], "x".repeat(120));
    }

    #[test]
    fn card_accepts_any_numeric_spelling_of_the_version() {
        // JSON has one number type: `1`, `1.0` and `1e0` are the same value,
        // and the web parser (`parsed.v === 1`) cannot tell them apart. This
        // side used to match on serde's STORAGE type (`as_u64`) and refused
        // payloads the web client renders.
        for raw in [
            r#"{"v":1.0,"title":"Q","options":[{"label":"A"},{"label":"B"}]}"#,
            r#"{"v":1e0,"title":"Q","options":[{"label":"A"},{"label":"B"}]}"#,
        ] {
            let (tag, _) = build_card_tag(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
            let payload: Value = serde_json::from_str(&tag[1]).unwrap();
            assert_eq!(payload["v"], 1, "{raw}: canonical version");
        }
        let (tag, _) = build_card_tag(
            r#"{"v":2.0,"questions":[{"question":"Q","options":[{"label":"A"},{"label":"B"}]}]}"#,
        )
        .expect("2.0 is version 2");
        let payload: Value = serde_json::from_str(&tag[1]).unwrap();
        assert_eq!(payload["v"], 2);
        // A non-integral number is still not a version — this is by VALUE,
        // not a blanket "any number will do".
        let fractional =
            build_card_tag(r#"{"v":1.5,"title":"Q","options":[{"label":"A"},{"label":"B"}]}"#)
                .unwrap_err();
        assert!(fractional.to_string().contains("unsupported version 1.5"));
    }

    #[test]
    fn card_drops_a_v1_option_description_and_keeps_a_v2_one() {
        // v1 has no per-option description. Refusing the key would make this
        // builder stricter than the format it emits, and the web parser
        // ignores it on a v1 card for the same reason — a v1 card carrying
        // the key rendered before v2 existed and must keep rendering.
        let (tag, fallback) = build_card_tag(
            r#"{"v":1,"title":"Q","options":[{"label":"A","description":"ignored"},{"label":"B"}]}"#,
        )
        .expect("a v1 description is dropped, not refused");
        let payload: Value = serde_json::from_str(&tag[1]).unwrap();
        assert!(payload["options"][0].get("description").is_none());
        assert_eq!(
            fallback,
            "**Q**\n\n- A\n- B\n\n_Reply with an option or your own answer._"
        );
        // Junk in the same field is equally ignored, not a refusal.
        assert!(build_card_tag(
            r#"{"v":1,"title":"Q","options":[{"label":"A","description":123},{"label":"B"}]}"#
        )
        .is_ok());
        // v2 still validates it strictly.
        let over = "d".repeat(201);
        let err = build_card_tag(&format!(
            r#"{{"v":2,"questions":[{{"question":"Q","options":[{{"label":"A","description":"{over}"}},{{"label":"B"}}]}}]}}"#
        ))
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("option 1 description must be 1-200"));
    }

    #[test]
    fn card_rejects_ids_that_resolve_to_the_same_value() {
        // Positional fill makes an explicit `"1"` collide with the NEXT
        // item's derived id. The answer format keys on these, so the web
        // parser returns null for the same payloads and this side refuses
        // the send — one rule, both implementations, error text pinned by
        // the shared corpus.
        let questions_positional = build_card_tag(
            r#"{"v":2,"title":"Collide","questions":[
                 {"id":"1","question":"First?","options":[{"label":"a"},{"label":"b"}]},
                 {"question":"Second?","options":[{"label":"c"},{"label":"d"}]}]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(
            questions_positional.contains(r#"questions 1 and 2 resolve to the same id "1""#),
            "{questions_positional}"
        );
        let questions_explicit = build_card_tag(
            r#"{"v":2,"title":"Collide","questions":[
                 {"id":"s","question":"First?","options":[{"label":"a"},{"label":"b"}]},
                 {"id":"s","question":"Second?","options":[{"label":"c"},{"label":"d"}]}]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(
            questions_explicit.contains(r#"questions 1 and 2 resolve to the same id "s""#),
            "{questions_explicit}"
        );
        let options_v2 = build_card_tag(
            r#"{"v":2,"questions":[{"question":"First?",
                 "options":[{"id":"1","label":"a"},{"label":"b"}]}]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(
            options_v2.contains(r#"question 1 options 1 and 2 resolve to the same id "1""#),
            "{options_v2}"
        );
        // v1 shares the id scheme, so it shares the rule — and the refusal
        // carries no question prefix, because a v1 card has one question.
        let options_v1 = build_card_tag(
            r#"{"v":1,"title":"Q","options":[{"id":"1","label":"a"},{"label":"b"}]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(
            options_v1.contains(r#"options 1 and 2 resolve to the same id "1""#),
            "{options_v1}"
        );
        // A blank id is NOT an id: it is dropped from the wire and the
        // position fills in, so it can collide. The check runs on the
        // resolved id, not on whether the key was present.
        let blank = build_card_tag(
            r#"{"v":1,"title":"Q","options":[{"id":"1","label":"a"},{"id":"   ","label":"b"}]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(
            blank.contains(r#"options 1 and 2 resolve to the same id "1""#),
            "{blank}"
        );

        // The discriminating controls. Explicit numeric ids that line up with
        // the positions they occupy are LEGAL — a check that compared an id
        // against its own index would refuse these and still pass everything
        // above. And option ids are scoped per question, so reusing them in a
        // second question is ordinary.
        assert!(build_card_tag(
            r#"{"v":2,"title":"Fine","questions":[
                 {"id":"0","question":"First?","options":[{"id":"1","label":"a"},{"id":"0","label":"b"}]},
                 {"id":"1","question":"Second?","options":[{"id":"yes","label":"c"},{"id":"no","label":"d"}]}]}"#,
        )
        .is_ok());
        assert!(build_card_tag(
            r#"{"v":2,"title":"Fine","questions":[
                 {"question":"First?","options":[{"id":"yes","label":"a"},{"id":"no","label":"b"}]},
                 {"question":"Second?","options":[{"id":"yes","label":"c"},{"id":"no","label":"d"}]}]}"#,
        )
        .is_ok());
    }

    #[test]
    fn card_normalizes_the_serde_surrogate_refusal() {
        // Rust cannot hold an unpaired surrogate in a String, so serde_json
        // refuses these while DECODING — one layer earlier than the web
        // builder's explicit check. All three spellings must reach the same
        // message, which is the reason the shared corpus pins for both sides.
        for raw in [
            r#"{"v":1,"title":"Q","options":[{"label":"\ud800"},{"label":"B"}]}"#,
            r#"{"v":1,"title":"Q","options":[{"label":"\udc00"},{"label":"B"}]}"#,
            r#"{"v":1,"title":"Q","options":[{"label":"\ud800\ud800"},{"label":"B"}]}"#,
        ] {
            let err = build_card_tag(raw).unwrap_err().to_string();
            assert!(
                err.contains("payload must not contain unpaired surrogates"),
                "{raw}: {err}"
            );
        }
        // An ordinary syntax error still reads as one.
        let plain = build_card_tag("{\"v\":1,").unwrap_err().to_string();
        assert!(plain.contains("invalid JSON"), "{plain}");
        // A PAIRED surrogate is an astral character and rides through.
        let (tag, _) =
            build_card_tag(r#"{"v":1,"title":"Q","options":[{"label":"🚀"},{"label":"B"}]}"#)
                .expect("a paired surrogate is just an emoji");
        let payload: Value = serde_json::from_str(&tag[1]).unwrap();
        assert_eq!(payload["options"][0]["label"], "\u{1F680}");
    }
}
