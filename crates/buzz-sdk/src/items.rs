//! Item (kind 30623) builders — bug and backlog entries.
//!
//! Every event built here is checked against
//! [`buzz_core::item::validate_item_parts`], the same validator the relay runs
//! at ingest, so the builder cannot emit a shape the relay would refuse.

use buzz_core::item::{
    validate_item_parts, ITEM_ID_ALPHABET, ITEM_ID_LEN, ITEM_ROLE_OWNER, ITEM_ROLE_REPORTER,
    ITEM_SOURCE_MARKER,
};
use buzz_core::kind::KIND_ITEM;
use nostr::{EventBuilder, Kind, Tag, Timestamp};
use uuid::Uuid;

use crate::SdkError;

/// Everything needed to publish one item head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemDraft {
    /// Item id (`d` tag) — see [`new_item_id`].
    pub d: String,
    /// Source channel (`h` tag); `None` makes the item community-global.
    pub channel: Option<Uuid>,
    /// `bug` or `backlog`.
    pub item_type: String,
    /// `open`, `progress`, `needs-you` or `done`.
    pub status: String,
    /// One-line title.
    pub title: String,
    /// Optional summary line.
    pub summary: Option<String>,
    /// Markdown body (event content).
    pub body: String,
    /// Unix seconds the item was first filed. Copied forward on every edit.
    pub created: u64,
    /// Reporter pubkey (hex). Copied forward on every edit.
    pub reporter: String,
    /// Owner pubkey (hex), if assigned.
    pub owner: Option<String>,
    /// Source message event id (hex). Copied forward on every edit.
    pub source_event: Option<String>,
    /// Project coordinate `30621:<pk>:<d>`.
    pub project_coord: Option<String>,
    /// Project display name.
    pub project_name: Option<String>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Build the raw tag list for `draft`, in wire order.
pub fn item_tags(draft: &ItemDraft) -> Vec<Vec<String>> {
    let s = |v: &str| v.to_string();
    let mut tags = vec![vec![s("d"), draft.d.clone()]];
    if let Some(ch) = draft.channel {
        tags.push(vec![s("h"), ch.hyphenated().to_string()]);
    }
    tags.push(vec![s("type"), draft.item_type.clone()]);
    tags.push(vec![s("status"), draft.status.clone()]);
    tags.push(vec![s("title"), draft.title.trim().to_string()]);
    if let Some(summary) = &draft.summary {
        tags.push(vec![s("summary"), summary.clone()]);
    }
    tags.push(vec![s("created"), draft.created.to_string()]);
    tags.push(vec![
        s("p"),
        draft.reporter.clone(),
        String::new(),
        s(ITEM_ROLE_REPORTER),
    ]);
    if let Some(owner) = &draft.owner {
        tags.push(vec![
            s("p"),
            owner.clone(),
            String::new(),
            s(ITEM_ROLE_OWNER),
        ]);
    }
    if let Some(source) = &draft.source_event {
        tags.push(vec![
            s("e"),
            source.clone(),
            String::new(),
            s(ITEM_SOURCE_MARKER),
        ]);
    }
    if let Some(coord) = &draft.project_coord {
        tags.push(vec![s("a"), coord.clone()]);
    }
    if let Some(name) = &draft.project_name {
        tags.push(vec![s("project"), name.clone()]);
    }
    tags
}

/// Build an item head (kind 30623) with `created_at` pinned.
///
/// The result is validated with the core item validator before it is
/// returned. Self-tagging is allowed: the reporter is usually the signer.
pub fn build_item(draft: &ItemDraft, created_at: Timestamp) -> Result<EventBuilder, SdkError> {
    let raw = item_tags(draft);
    validate_item_parts(KIND_ITEM, &draft.body, &raw, now_secs())
        .map_err(|e| SdkError::InvalidInput(format!("item: {e}")))?;
    let tags = raw
        .into_iter()
        .map(|t| Tag::parse(t).map_err(|e| SdkError::InvalidTag(e.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_ITEM as u16), &draft.body)
            .tags(tags)
            .allow_self_tagging()
            .custom_created_at(created_at),
    )
}

/// A fresh item id: 12 lowercase Crockford base32 characters (60 random bits).
pub fn new_item_id() -> String {
    let bytes = *Uuid::new_v4().as_bytes();
    // Bytes 0..8 of a v4 UUID are fully random except the version nibble in
    // byte 6; take 64 bits from bytes 8..16 instead (random except the 2-bit
    // variant at the top of byte 8), and use the low 60.
    let mut word = u64::from_be_bytes([
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    ]);
    let alphabet = ITEM_ID_ALPHABET.as_bytes();
    let mut out = vec![0u8; ITEM_ID_LEN];
    for slot in out.iter_mut().rev() {
        *slot = alphabet[(word & 0x1f) as usize];
        word >>= 5;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// `created_at` for a read-modify-write: `max(now, prev + 1)`, so an edit
/// always supersedes the head it read.
pub fn next_created_at(prev: Option<Timestamp>) -> Timestamp {
    next_created_at_from(now_secs(), prev.map(|t| t.as_secs()))
}

fn next_created_at_from(now: u64, prev: Option<u64>) -> Timestamp {
    let floor = prev.map(|p| p.saturating_add(1)).unwrap_or(0);
    Timestamp::from(now.max(floor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::item::{is_valid_item_id, validate_item_event};
    use nostr::Keys;

    fn draft(reporter: &str) -> ItemDraft {
        ItemDraft {
            d: new_item_id(),
            channel: Some(Uuid::parse_str("9a1657ac-f7aa-4db0-b632-d8bbeb6dfb50").unwrap()),
            item_type: "bug".into(),
            status: "open".into(),
            title: "Composer drops the draft".into(),
            summary: Some("The draft is discarded on channel switch".into()),
            body: "repro: switch channels".into(),
            created: now_secs(),
            reporter: reporter.into(),
            owner: Some("b".repeat(64)),
            source_event: Some("c".repeat(64)),
            project_coord: Some(format!("30621:{}:buzz-web", "d".repeat(64))),
            project_name: Some("Buzz web".into()),
        }
    }

    #[test]
    fn build_item_roundtrips_through_core_validator() {
        let keys = Keys::generate();
        let d = draft(&keys.public_key().to_hex());
        let event = build_item(&d, Timestamp::now())
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(event.kind.as_u16(), 30623);
        assert_eq!(validate_item_event(&event), Ok(()));
        // The self-reporter p tag survives signing (allow_self_tagging).
        let reporter_tags = event
            .tags
            .iter()
            .filter(|t| t.as_slice().get(3).map(String::as_str) == Some("reporter"))
            .count();
        assert_eq!(reporter_tags, 1);
        let head = buzz_core::item::ItemHead::from_event(&event).unwrap();
        assert_eq!(head.id, d.d);
        assert_eq!(head.owner.as_deref(), Some("b".repeat(64).as_str()));
        assert_eq!(head.project_name.as_deref(), Some("Buzz web"));
    }

    #[test]
    fn build_item_refuses_invalid_draft() {
        let mut d = draft(&"a".repeat(64));
        d.status = "closed".into();
        assert!(build_item(&d, Timestamp::now()).is_err());
    }

    #[test]
    fn new_item_id_is_valid_and_varies() {
        let a = new_item_id();
        let b = new_item_id();
        assert!(is_valid_item_id(&a), "{a}");
        assert!(is_valid_item_id(&b), "{b}");
        assert_ne!(a, b);
    }

    #[test]
    fn next_created_at_strictly_supersedes() {
        let now = 1_759_190_400u64;
        assert_eq!(
            next_created_at_from(now, Some(now + 5)).as_secs(),
            1_759_190_406
        );
        assert_eq!(next_created_at_from(now, Some(now - 50)).as_secs(), now);
        assert_eq!(next_created_at_from(now, None).as_secs(), now);
        // Public wrapper: a head from the future is still superseded.
        let future = Timestamp::from(now_secs() + 5);
        assert!(next_created_at(Some(future)) > future);
    }
}
