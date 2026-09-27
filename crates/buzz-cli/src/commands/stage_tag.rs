//! Agent Stage Mode wire contract — the `["stage", "<compact JSON>"]` tag on
//! kind-9 messages.
//!
//! The TypeScript mirror is `web/src/features/stage/lib/stageTag.ts`. Both
//! execute `test-fixtures/stage-mode/{limits,cases}.json` ([`tests`] here,
//! `stageTag.fixtures.test.mjs` there), so a rule changed on one side only
//! turns exactly one suite red.
//!
//! Type rules are declared explicitly rather than inherited from `serde_json`
//! (repo AGENTS.md: "the built-ins are the drift"):
//! - Numbers: every number literal ANYWHERE in the tag must be a plain
//!   non-negative integer (`0` or `[1-9][0-9]*`) — [`has_non_plain_number`],
//!   the same scanner as `hasNonPlainNumber` in stageTag.ts. `as_u64` alone
//!   would already refuse `1.0` here, but JS `JSON.parse` cannot, and an
//!   ignored key would otherwise be judged differently on each side.
//! - Booleans: `voice` / `hold` must be JSON booleans.
//! - Blank title: every char in ` \t\n\r` — explicit set, not `str::trim`.
//! - Lengths: UTF-16 code units (JS `.length` parity).
//! - Lone surrogates: `serde_json` refuses them; the web side refuses them
//!   explicitly under the same "invalid stage JSON" reason.

use crate::error::CliError;
use serde_json::{Map, Value};

// Mirrored by `test-fixtures/stage-mode/limits.json` (asserted below) and by
// `STAGE_LIMITS` in stageTag.ts (asserted by the web suite).
pub(crate) const STAGE_MAX_TAG_UNITS: usize = 16384;
pub(crate) const STAGE_MAX_TITLE_CHARS: usize = 120;
pub(crate) const STAGE_MAX_PARTS: usize = 50;
pub(crate) const STAGE_MAX_URL_CHARS: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PaletteEntry {
    /// sha256, 64 lowercase hex.
    pub x: String,
    pub url: String,
    /// `image/*` MIME type.
    pub m: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub dim: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageTag {
    Open {
        title: String,
        voice: bool,
        parts: Vec<PaletteEntry>,
    },
    Part {
        s: String,
        i: usize,
        /// Absent on the wire means `true`.
        hold: bool,
    },
    Close {
        s: String,
    },
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_blank(value: &str) -> bool {
    value.chars().all(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
}

fn is_dim(value: &str) -> bool {
    let Some((w, h)) = value.split_once('x') else {
        return false;
    };
    let ok = |n: &str| {
        !n.is_empty()
            && n.len() <= 6
            && n.bytes().all(|b| b.is_ascii_digit())
            && !n.starts_with('0')
    };
    ok(w) && ok(h)
}

/// True when any number literal outside a string is not a plain non-negative
/// integer. Character-for-character mirror of `hasNonPlainNumber` in
/// stageTag.ts. Only called on text `serde_json` already accepted.
pub(crate) fn has_non_plain_number(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut in_string = false;
    let mut index = 0;
    while index < bytes.len() {
        let ch = bytes[index];
        if in_string {
            if ch == b'\\' {
                index += 2;
            } else {
                if ch == b'"' {
                    in_string = false;
                }
                index += 1;
            }
            continue;
        }
        if ch == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if ch == b'-' || ch.is_ascii_digit() {
            let mut end = index;
            while end < bytes.len()
                && matches!(bytes[end], b'-' | b'+' | b'0'..=b'9' | b'.' | b'e' | b'E')
            {
                end += 1;
            }
            let token = &raw[index..end];
            let plain = token == "0"
                || (!token.is_empty()
                    && !token.starts_with('0')
                    && token.bytes().all(|b| b.is_ascii_digit()));
            if !plain {
                return true;
            }
            index = end;
            continue;
        }
        index += 1;
    }
    false
}

fn usage(reason: impl Into<String>) -> CliError {
    CliError::Usage(reason.into())
}

fn read_bool(obj: &Map<String, Value>, key: &str) -> Result<bool, CliError> {
    match obj.get(key) {
        None => Ok(true),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(usage(format!("{key} must be a boolean"))),
    }
}

fn read_session(obj: &Map<String, Value>) -> Result<String, CliError> {
    match obj.get("s").and_then(Value::as_str) {
        Some(s) if is_hex64(s) => Ok(s.to_string()),
        _ => Err(usage("s must be the open event id (64 lowercase hex)")),
    }
}

fn parse_palette(raw: Option<&Value>) -> Result<Vec<PaletteEntry>, CliError> {
    let Some(Value::Array(items)) = raw else {
        return Err(usage("parts must be an array"));
    };
    if items.is_empty() {
        return Err(usage("open needs at least one part"));
    }
    if items.len() > STAGE_MAX_PARTS {
        return Err(usage(format!("too many parts (max {STAGE_MAX_PARTS})")));
    }
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Value::Object(row) = item else {
            return Err(usage(format!("parts[{index}] must be an object")));
        };
        let x = match row.get("x").and_then(Value::as_str) {
            Some(x) if is_hex64(x) => x.to_string(),
            _ => return Err(usage(format!("parts[{index}].x must be 64 lowercase hex"))),
        };
        let url = match row.get("url").and_then(Value::as_str) {
            Some(u)
                if (u.starts_with("https://") || u.starts_with("http://"))
                    && utf16_len(u) <= STAGE_MAX_URL_CHARS =>
            {
                u.to_string()
            }
            _ => {
                return Err(usage(format!(
                "parts[{index}].url must be an http(s) URL of at most {STAGE_MAX_URL_CHARS} chars"
            )))
            }
        };
        let m = match row.get("m").and_then(Value::as_str) {
            Some(m) if m.starts_with("image/") && utf16_len(m) <= 100 => m.to_string(),
            _ => {
                return Err(usage(format!(
                    "parts[{index}].m must be an image/* MIME type"
                )))
            }
        };
        let dim = match row.get("dim") {
            None => None,
            Some(Value::String(d)) if is_dim(d) => Some(d.clone()),
            Some(_) => {
                return Err(usage(format!(
                    "parts[{index}].dim must be <width>x<height>"
                )))
            }
        };
        out.push(PaletteEntry { x, url, m, dim });
    }
    Ok(out)
}

/// Validate one raw `stage` tag value.
pub fn parse_stage_payload(raw: &str) -> Result<StageTag, CliError> {
    let units = utf16_len(raw);
    if units > STAGE_MAX_TAG_UNITS {
        return Err(usage(format!(
            "stage tag exceeds {STAGE_MAX_TAG_UNITS} UTF-16 units ({units})"
        )));
    }
    let parsed: Value =
        serde_json::from_str(raw).map_err(|e| usage(format!("invalid stage JSON: {e}")))?;
    if has_non_plain_number(raw) {
        return Err(usage("every number must be a plain non-negative integer"));
    }
    let Value::Object(obj) = parsed else {
        return Err(usage("stage tag must be a JSON object"));
    };
    if obj.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(usage("unsupported version (only v=1)"));
    }
    match obj.get("op").and_then(Value::as_str) {
        Some("open") => {
            let title = match obj.get("title").and_then(Value::as_str) {
                Some(t) if !is_blank(t) && utf16_len(t) <= STAGE_MAX_TITLE_CHARS => t.to_string(),
                _ => {
                    return Err(usage(format!(
                        "title must be 1-{STAGE_MAX_TITLE_CHARS} UTF-16 units and not blank"
                    )))
                }
            };
            let voice = read_bool(&obj, "voice")?;
            let parts = parse_palette(obj.get("parts"))?;
            Ok(StageTag::Open {
                title,
                voice,
                parts,
            })
        }
        Some("part") => {
            let s = read_session(&obj)?;
            let i = match obj.get("i").and_then(Value::as_u64) {
                Some(i) if (i as usize) < STAGE_MAX_PARTS => i as usize,
                _ => {
                    return Err(usage(format!(
                        "i must be an integer in [0, {STAGE_MAX_PARTS})"
                    )))
                }
            };
            let hold = read_bool(&obj, "hold")?;
            Ok(StageTag::Part { s, i, hold })
        }
        Some("close") => Ok(StageTag::Close {
            s: read_session(&obj)?,
        }),
        _ => Err(usage("unknown op (expected open, part or close)")),
    }
}

/// Canonical wire JSON: known keys only; `hold` omitted when true.
fn canonical_json(tag: &StageTag) -> Value {
    match tag {
        StageTag::Open {
            title,
            voice,
            parts,
        } => serde_json::json!({
            "v": 1, "op": "open", "title": title, "voice": voice, "parts": parts,
        }),
        StageTag::Part { s, i, hold } => {
            let mut v = serde_json::json!({ "v": 1, "op": "part", "s": s, "i": i });
            if !hold {
                v["hold"] = Value::Bool(false);
            }
            v
        }
        StageTag::Close { s } => serde_json::json!({ "v": 1, "op": "close", "s": s }),
    }
}

/// Build the `["stage", json]` tag. Refuses to emit anything the parser
/// (either side's) would refuse — so a too-big manifest fails here, before
/// any event is signed.
pub fn build_stage_tag(tag: &StageTag) -> Result<Vec<String>, CliError> {
    let json = canonical_json(tag).to_string();
    parse_stage_payload(&json)?;
    Ok(vec!["stage".to_string(), json])
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS_JSON: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-fixtures/stage-mode/limits.json"
    ));
    const CASES_JSON: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-fixtures/stage-mode/cases.json"
    ));

    fn manifest(limits: &Value, key: &str) -> usize {
        limits
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or_else(|| panic!("limits.json has no numeric {key}")) as usize
    }

    #[test]
    fn stage_limits_match_manifest() {
        let limits: Value = serde_json::from_str(LIMITS_JSON).expect("limits.json parses");
        assert_eq!(manifest(&limits, "maxTagUnits"), STAGE_MAX_TAG_UNITS);
        assert_eq!(manifest(&limits, "maxTitleChars"), STAGE_MAX_TITLE_CHARS);
        assert_eq!(manifest(&limits, "maxParts"), STAGE_MAX_PARTS);
        assert_eq!(manifest(&limits, "maxUrlChars"), STAGE_MAX_URL_CHARS);
        // Every key accounted for — a bound added to the file only fails here.
        assert_eq!(limits.as_object().map(Map::len), Some(5));
    }

    #[test]
    fn stage_fixture_corpus() {
        let limits: Value = serde_json::from_str(LIMITS_JSON).expect("limits.json parses");
        let cases: Vec<Value> = serde_json::from_str(CASES_JSON).expect("cases.json parses");
        // Harness self-check: an empty corpus must be a loud failure.
        assert_eq!(
            cases.len(),
            manifest(&limits, "cases"),
            "corpus size disagrees with limits.json"
        );
        assert!(cases.len() >= 30, "corpus is too small ({})", cases.len());

        let mut accepted = 0usize;
        let mut rejected = 0usize;
        for case in &cases {
            let name = case["name"].as_str().expect("case has a name");
            let raw = match case.get("payloadRaw").and_then(Value::as_str) {
                Some(raw) => raw.to_string(),
                None => serde_json::to_string(&case["payload"]).expect("payload re-serializes"),
            };
            match case["expect"].as_str() {
                Some("accept") => {
                    let tag = parse_stage_payload(&raw)
                        .unwrap_or_else(|e| panic!("{name}: expected accept, got {e}"));
                    let built = build_stage_tag(&tag)
                        .unwrap_or_else(|e| panic!("{name}: rebuild failed: {e}"));
                    assert_eq!(built[0], "stage", "{name}");
                    let canonical: Value = serde_json::from_str(&built[1]).expect("json");
                    assert_eq!(canonical, case["canonical"], "{name}: canonical");
                    accepted += 1;
                }
                Some("reject") => {
                    let error = parse_stage_payload(&raw)
                        .expect_err(&format!("{name}: expected reject"))
                        .to_string();
                    let reason = case["reason"].as_str().expect("reject case has reason");
                    assert!(
                        error.contains(reason),
                        "{name}: {error:?} does not contain {reason:?}"
                    );
                    rejected += 1;
                }
                other => panic!("{name}: unknown expect {other:?}"),
            }
        }
        assert_eq!(accepted, 12, "accept-case count moved");
        assert_eq!(rejected, 30, "reject-case count moved");
    }

    #[test]
    fn part_hold_absent_is_true_and_false_round_trips() {
        let s = "a".repeat(64);
        let tag = parse_stage_payload(&format!(r#"{{"v":1,"op":"part","s":"{s}","i":2}}"#))
            .expect("parses");
        assert_eq!(
            tag,
            StageTag::Part {
                s: s.clone(),
                i: 2,
                hold: true
            }
        );
        let off = StageTag::Part {
            s,
            i: 2,
            hold: false,
        };
        let built = build_stage_tag(&off).expect("builds");
        assert!(built[1].contains(r#""hold":false"#));
        assert_eq!(parse_stage_payload(&built[1]).expect("reparses"), off);
    }
}
