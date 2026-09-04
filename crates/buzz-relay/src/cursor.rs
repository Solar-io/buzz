//! The composite `(until, before_id)` pagination cursor shared by every read
//! transport.
//!
//! `created_at` alone cannot page a relay whose events are not unique in time:
//! `until = oldest` re-reads the whole boundary second and never advances once
//! that second exceeds one page, while `until = oldest - 1` silently drops
//! every unread event tied inside it. The keyset
//! `created_at < until OR (created_at = until AND id > before_id)` — resolved
//! by the `(created_at DESC, id ASC)` ordering in [`buzz_db::EventQuery`] —
//! makes each page resume exactly where the last ended.
//!
//! `before_id` is an extension field on the filter object. `nostr::Filter`'s
//! deserializer drops unknown fields, so it has to be read from the raw JSON
//! before that conversion, on every transport that accepts a filter. The
//! parsing lives here rather than in one transport so the websocket REQ path
//! and the HTTP bridge cannot drift: a cursor that pages over HTTP must page
//! over the websocket, and a cursor either transport cannot honour must be
//! refused there too.
//!
//! # Grammar
//!
//! - Both halves or neither. `before_id` without `until` is not a cursor, and
//!   answering it as a head request would hand the client a page it did not
//!   ask for while looking like success.
//! - A present-but-malformed `before_id` is an error, never a demotion to a
//!   half cursor or a head request. This is why "absent" and "malformed" are
//!   distinct variants rather than both collapsing to `None`: the difference
//!   between them is the difference between a valid request and a silent
//!   wrong answer.

use serde_json::Value;

/// A `before_id` extension field as it appeared on the wire.
///
/// [`BeforeId::Malformed`] is deliberately distinct from [`BeforeId::Absent`]
/// — see the module docs.
#[derive(Debug)]
pub(crate) enum BeforeId {
    /// No `before_id` key on the filter object.
    Absent,
    /// A well-formed 64-character hex event id, decoded to its 32 bytes.
    Valid(Vec<u8>),
    /// Present but not a 64-character hex string. Callers MUST reject.
    Malformed,
}

/// Read the `before_id` extension field out of a raw filter object.
pub(crate) fn extract_before_id(raw: &Value) -> BeforeId {
    let Some(value) = raw.get("before_id") else {
        return BeforeId::Absent;
    };
    match value
        .as_str()
        .filter(|hex_str| hex_str.len() == 64)
        .and_then(|hex_str| hex::decode(hex_str).ok())
    {
        Some(id) => BeforeId::Valid(id),
        None => BeforeId::Malformed,
    }
}

/// Why a filter's cursor could not be applied, as a client-facing reason.
///
/// Both transports render this in their own idiom — an HTTP 400 body, or a
/// NIP-01 `CLOSED` reason — but the text is shared so the two cannot describe
/// the same mistake differently.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CursorError {
    /// `before_id` was present but not a 64-character hex event id.
    Malformed,
    /// `before_id` was valid but `until` was absent, so there is no keyset.
    MissingUntil,
}

impl CursorError {
    /// The client-facing explanation for this rejection.
    pub(crate) fn message(&self) -> &'static str {
        match self {
            CursorError::Malformed => "before_id must be a 64-char hex event id",
            CursorError::MissingUntil => "before_id requires until to be set",
        }
    }
}

/// Resolve a filter's cursor against the `until` the filter carries.
///
/// Returns the cursor bytes to apply (`None` when the filter has no cursor),
/// or the reason the request must be refused.
pub(crate) fn resolve_before_id(
    raw: &Value,
    until_is_set: bool,
) -> Result<Option<Vec<u8>>, CursorError> {
    match extract_before_id(raw) {
        BeforeId::Absent => Ok(None),
        BeforeId::Malformed => Err(CursorError::Malformed),
        BeforeId::Valid(id) => {
            if until_is_set {
                Ok(Some(id))
            } else {
                Err(CursorError::MissingUntil)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_before_id_valid_hex() {
        let hex = "a".repeat(64);
        let raw = serde_json::json!({ "before_id": hex });
        match extract_before_id(&raw) {
            BeforeId::Valid(id) => assert_eq!(id.len(), 32),
            _ => panic!("64-char hex must parse as Valid"),
        }
    }

    #[test]
    fn extract_before_id_short_hex() {
        let raw = serde_json::json!({ "before_id": "a".repeat(63) });
        assert!(matches!(extract_before_id(&raw), BeforeId::Malformed));
    }

    #[test]
    fn extract_before_id_long_hex() {
        let raw = serde_json::json!({ "before_id": "a".repeat(65) });
        assert!(matches!(extract_before_id(&raw), BeforeId::Malformed));
    }

    #[test]
    fn extract_before_id_invalid_hex_chars() {
        let raw = serde_json::json!({ "before_id": "z".repeat(64) });
        assert!(matches!(extract_before_id(&raw), BeforeId::Malformed));
    }

    #[test]
    fn extract_before_id_absent() {
        let raw = serde_json::json!({});
        assert!(matches!(extract_before_id(&raw), BeforeId::Absent));
    }

    #[test]
    fn extract_before_id_non_string() {
        let raw = serde_json::json!({ "before_id": 12345 });
        assert!(matches!(extract_before_id(&raw), BeforeId::Malformed));
    }

    #[test]
    fn resolve_requires_both_halves_of_the_cursor() {
        let with_cursor = serde_json::json!({ "before_id": "a".repeat(64) });

        assert_eq!(
            resolve_before_id(&with_cursor, true)
                .expect("a complete cursor resolves")
                .map(|id| id.len()),
            Some(32),
        );
        assert_eq!(
            resolve_before_id(&with_cursor, false),
            Err(CursorError::MissingUntil),
            "half a cursor must be refused, not demoted to a head request"
        );

        // `until` alone is a plain time bound, not a cursor, and stays valid.
        assert_eq!(
            resolve_before_id(&serde_json::json!({}), true),
            Ok(None),
            "until without before_id is an ordinary bounded query"
        );
        assert_eq!(resolve_before_id(&serde_json::json!({}), false), Ok(None));
    }

    #[test]
    fn resolve_rejects_a_malformed_cursor_on_either_side_of_until() {
        let bad = serde_json::json!({ "before_id": "nope" });
        assert_eq!(resolve_before_id(&bad, true), Err(CursorError::Malformed));
        assert_eq!(resolve_before_id(&bad, false), Err(CursorError::Malformed));
    }

    #[test]
    fn cursor_error_messages_name_the_offending_field() {
        // The websocket asserts on these strings in its CLOSED reason and the
        // bridge in its 400 body; both must name `before_id`, and the
        // missing-half case must name both halves.
        assert!(CursorError::Malformed.message().contains("before_id"));
        assert!(CursorError::MissingUntil.message().contains("before_id"));
        assert!(CursorError::MissingUntil.message().contains("until"));
    }
}
