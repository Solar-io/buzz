//! Items — bug and backlog entries (kind 30623).
//!
//! This module is the single validator and the single fold for the item wire
//! format. The relay calls [`validate_item_event`] at ingest; `buzz-sdk` calls
//! [`validate_item_parts`] on every event it builds, so the two cannot drift.
//!
//! # Identity and multi-writer fold
//!
//! An item is identified by `(h or "", d)`. Every editor publishes their own
//! addressable head at `(author, 30623, d)`, so one item may have several heads.
//! [`fold_items`] groups heads by `(h, d)` and keeps the newest `created_at`;
//! on a tie the lowest event id wins (NIP-01). `h` is part of the identity:
//! a head with a different `h` is a different item.
//!
//! See `docs/plans/2026-09-29-web-redesign/phase-5.md` for the design.

use std::collections::HashMap;
use std::fmt;

use nostr::Event;
use uuid::Uuid;

use crate::kind::KIND_ITEM;

/// Allowed values of the `type` tag.
pub const ITEM_TYPES: &[&str] = &["bug", "backlog"];
/// Allowed values of the `status` tag.
pub const ITEM_STATUSES: &[&str] = &["open", "progress", "needs-you", "done"];
/// Length of an item id (`d` tag), in Crockford base32 characters.
pub const ITEM_ID_LEN: usize = 12;
/// Alphabet of an item id: lowercase Crockford base32 (no `i`, `l`, `o`, `u`).
pub const ITEM_ID_ALPHABET: &str = "0123456789abcdefghjkmnpqrstvwxyz";
/// Maximum title length in characters (after trimming).
pub const ITEM_TITLE_MAX_CHARS: usize = 200;
/// Maximum summary length in characters.
pub const ITEM_SUMMARY_MAX_CHARS: usize = 500;
/// Maximum project display-name length in characters.
pub const ITEM_PROJECT_NAME_MAX_CHARS: usize = 80;
/// Maximum body (`content`) size in bytes.
pub const ITEM_BODY_MAX_BYTES: usize = 16 * 1024;
/// How far in the future the `created` tag may be, in seconds.
pub const ITEM_CREATED_MAX_SKEW_SECS: u64 = 600;
/// `p` tag role marking the reporter (exactly one per head).
pub const ITEM_ROLE_REPORTER: &str = "reporter";
/// `p` tag role marking the owner (at most one per head).
pub const ITEM_ROLE_OWNER: &str = "owner";
/// `e` tag marker for the source message.
pub const ITEM_SOURCE_MARKER: &str = "source";

/// Why an item event was rejected. `Display` renders the rule text the relay
/// sends after `invalid: item: `.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemRejection(pub String);

impl fmt::Display for ItemRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ItemRejection {}

fn reject(msg: impl Into<String>) -> ItemRejection {
    ItemRejection(msg.into())
}

/// Returns `true` if `s` is a well-formed item id (12 lowercase Crockford chars).
pub fn is_valid_item_id(s: &str) -> bool {
    s.len() == ITEM_ID_LEN && s.chars().all(|c| ITEM_ID_ALPHABET.contains(c))
}

fn is_lower_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Validate a signed item event against the kind-30623 wire format.
pub fn validate_item_event(event: &Event) -> Result<(), ItemRejection> {
    let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
    validate_item_parts(
        u32::from(event.kind.as_u16()),
        &event.content,
        &tags,
        now_secs(),
    )
}

/// Validate the parts of an item event (kind, content, raw tags) at time `now`.
///
/// Exposed so builders can check an event before it is signed. Unknown tags
/// are allowed for forward compatibility; every known tag is checked for
/// cardinality and shape.
pub fn validate_item_parts(
    kind: u32,
    content: &str,
    tags: &[Vec<String>],
    now: u64,
) -> Result<(), ItemRejection> {
    if kind != KIND_ITEM {
        return Err(reject(format!("wrong kind {kind}, expected {KIND_ITEM}")));
    }
    if content.len() > ITEM_BODY_MAX_BYTES {
        return Err(reject(format!(
            "body exceeds {ITEM_BODY_MAX_BYTES} bytes (got {})",
            content.len()
        )));
    }

    let mut single: HashMap<&str, &Vec<String>> = HashMap::new();
    let mut reporters = 0usize;
    let mut owners = 0usize;
    for tag in tags {
        let Some(name) = tag.first().map(String::as_str) else {
            continue;
        };
        let value = tag.get(1).map(String::as_str).unwrap_or("");
        const SINGLE_VALUED: &[&str] = &[
            "d", "h", "type", "status", "title", "summary", "created", "e", "a", "project",
        ];
        if SINGLE_VALUED.contains(&name) && single.insert(name, tag).is_some() {
            return Err(reject(format!("duplicate {name} tag")));
        }
        if name == "p" {
            if !is_lower_hex64(value) {
                return Err(reject("p tag must be a 64-char lowercase hex pubkey"));
            }
            match tag.get(3).map(String::as_str) {
                Some(ITEM_ROLE_REPORTER) => reporters += 1,
                Some(ITEM_ROLE_OWNER) => owners += 1,
                _ => return Err(reject("p tag must carry role reporter or owner")),
            }
        }
    }
    if reporters != 1 {
        return Err(reject(format!(
            "exactly one reporter p tag required (got {reporters})"
        )));
    }
    if owners > 1 {
        return Err(reject(format!("at most one owner p tag (got {owners})")));
    }

    let value_of = |name: &str| single.get(name).and_then(|t| t.get(1)).map(String::as_str);

    // d — required item id.
    match value_of("d") {
        Some(d) if is_valid_item_id(d) => {}
        Some(_) => return Err(reject("d must be 12 lowercase Crockford base32 characters")),
        None => return Err(reject("missing d tag")),
    }

    // h — optional, but when present it MUST be a canonical channel UUID. A
    // non-UUID h would be ignored by channel extraction and the item would
    // store as community-global (phase-5 risk R1).
    if let Some(h_tag) = single.get("h") {
        let h = h_tag.get(1).map(String::as_str).unwrap_or("");
        let canonical = Uuid::parse_str(h).ok().map(|u| u.hyphenated().to_string());
        if canonical.as_deref() != Some(h) {
            return Err(reject("h must be a lowercase hyphenated channel UUID"));
        }
    }

    match value_of("type") {
        Some(t) if ITEM_TYPES.contains(&t) => {}
        Some(t) => return Err(reject(format!("type must be bug or backlog (got {t:?})"))),
        None => return Err(reject("missing type tag")),
    }

    match value_of("status") {
        Some(s) if ITEM_STATUSES.contains(&s) => {}
        Some(s) => {
            return Err(reject(format!(
                "status must be open, progress, needs-you or done (got {s:?})"
            )))
        }
        None => return Err(reject("missing status tag")),
    }

    match value_of("title") {
        Some(title) => {
            let n = title.trim().chars().count();
            if n == 0 || n > ITEM_TITLE_MAX_CHARS {
                return Err(reject(format!(
                    "title must be 1..={ITEM_TITLE_MAX_CHARS} characters (got {n})"
                )));
            }
        }
        None => return Err(reject("missing title tag")),
    }

    if let Some(summary) = value_of("summary") {
        let n = summary.chars().count();
        if n > ITEM_SUMMARY_MAX_CHARS {
            return Err(reject(format!(
                "summary exceeds {ITEM_SUMMARY_MAX_CHARS} characters (got {n})"
            )));
        }
    }

    match value_of("created") {
        Some(c) => {
            let parsed = if !c.is_empty() && c.bytes().all(|b| b.is_ascii_digit()) {
                c.parse::<u64>().ok()
            } else {
                None
            };
            match parsed {
                Some(v) if v <= now.saturating_add(ITEM_CREATED_MAX_SKEW_SECS) => {}
                Some(_) => return Err(reject("created is too far in the future")),
                None => return Err(reject("created must be unix seconds")),
            }
        }
        None => return Err(reject("missing created tag")),
    }

    if let Some(e_tag) = single.get("e") {
        let id = e_tag.get(1).map(String::as_str).unwrap_or("");
        if !is_lower_hex64(id) {
            return Err(reject("e tag must be a 64-char lowercase hex event id"));
        }
        if e_tag.get(3).map(String::as_str) != Some(ITEM_SOURCE_MARKER) {
            return Err(reject("e tag must carry marker source"));
        }
    }

    if let Some(a) = value_of("a") {
        let mut parts = a.splitn(3, ':');
        let ok = parts.next() == Some("30621")
            && parts.next().is_some_and(is_lower_hex64)
            && parts.next().is_some_and(|d| !d.is_empty());
        if !ok {
            return Err(reject("a must be a 30621:<pubkey>:<d> project coordinate"));
        }
    }

    if let Some(project) = value_of("project") {
        let n = project.chars().count();
        if n > ITEM_PROJECT_NAME_MAX_CHARS {
            return Err(reject(format!(
                "project exceeds {ITEM_PROJECT_NAME_MAX_CHARS} characters (got {n})"
            )));
        }
    }

    Ok(())
}

/// The folded, current state of one item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemHead {
    /// Item id (`d` tag).
    pub id: String,
    /// Source channel (`h` tag), or `None` for a community-global item.
    pub channel_id: Option<String>,
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
    /// Unix seconds the item was first filed (copied forward on every edit).
    pub created: u64,
    /// Reporter pubkey (hex).
    pub reporter: String,
    /// Owner pubkey (hex), if assigned.
    pub owner: Option<String>,
    /// Source message event id (hex), if any.
    pub source_event_id: Option<String>,
    /// Project coordinate `30621:<pk>:<d>`, if any.
    pub project_coordinate: Option<String>,
    /// Project display name, if any.
    pub project_name: Option<String>,
    /// `created_at` of the winning head.
    pub updated_at: u64,
    /// Author of the winning head.
    pub updated_by: String,
    /// Event id of the winning head.
    pub event_id: String,
}

impl ItemHead {
    /// Parse one item event into a head. Returns `None` if it is not a valid
    /// kind-30623 event.
    pub fn from_event(event: &Event) -> Option<Self> {
        validate_item_event(event).ok()?;
        Some(Self::from_valid_event(event))
    }

    /// Parse without re-validating. Callers must have validated `event`.
    fn from_valid_event(event: &Event) -> Self {
        let mut head = ItemHead {
            id: String::new(),
            channel_id: None,
            item_type: String::new(),
            status: String::new(),
            title: String::new(),
            summary: None,
            body: event.content.clone(),
            created: 0,
            reporter: String::new(),
            owner: None,
            source_event_id: None,
            project_coordinate: None,
            project_name: None,
            updated_at: event.created_at.as_secs(),
            updated_by: event.pubkey.to_hex(),
            event_id: event.id.to_hex(),
        };
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            let (Some(name), Some(value)) = (parts.first(), parts.get(1)) else {
                continue;
            };
            let value = value.clone();
            match name.as_str() {
                "d" => head.id = value,
                "h" => head.channel_id = Some(value),
                "type" => head.item_type = value,
                "status" => head.status = value,
                "title" => head.title = value,
                "summary" => head.summary = Some(value),
                "created" => head.created = value.parse().unwrap_or(0),
                "e" => head.source_event_id = Some(value),
                "a" => head.project_coordinate = Some(value),
                "project" => head.project_name = Some(value),
                "p" => match parts.get(3).map(String::as_str) {
                    Some(ITEM_ROLE_REPORTER) => head.reporter = value,
                    Some(ITEM_ROLE_OWNER) => head.owner = Some(value),
                    _ => {}
                },
                _ => {}
            }
        }
        head
    }

    /// The fold key: `(h or "", d)`.
    pub fn key(&self) -> (String, String) {
        (self.channel_id.clone().unwrap_or_default(), self.id.clone())
    }
}

/// Fold item heads into current items.
///
/// Groups valid kind-30623 events by `(h or "", d)`; the winner is the head
/// with the greatest `created_at`, ties broken by the lowest event id. Invalid
/// events are skipped. Output is sorted newest `updated_at` first, then by id.
pub fn fold_items(events: &[Event]) -> Vec<ItemHead> {
    let mut winners: HashMap<(String, String), &Event> = HashMap::new();
    for event in events {
        if validate_item_event(event).is_err() {
            continue;
        }
        let head_key = {
            let mut h = String::new();
            let mut d = String::new();
            for tag in event.tags.iter() {
                let parts = tag.as_slice();
                match (parts.first().map(String::as_str), parts.get(1)) {
                    (Some("h"), Some(v)) => h = v.clone(),
                    (Some("d"), Some(v)) => d = v.clone(),
                    _ => {}
                }
            }
            (h, d)
        };
        match winners.get(&head_key) {
            Some(current) if !supersedes(event, current) => {}
            _ => {
                winners.insert(head_key, event);
            }
        }
    }
    let mut out: Vec<ItemHead> = winners
        .into_values()
        .map(ItemHead::from_valid_event)
        .collect();
    out.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
            .then_with(|| a.channel_id.cmp(&b.channel_id))
    });
    out
}

/// `true` if `candidate` beats `current`: newer `created_at`, or equal
/// `created_at` and a lower event id (NIP-01 tie-break).
fn supersedes(candidate: &Event, current: &Event) -> bool {
    match candidate.created_at.cmp(&current.created_at) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => candidate.id.to_hex() < current.id.to_hex(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kind::is_parameterized_replaceable;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    const CH_A: &str = "9a1657ac-f7aa-4db0-b632-d8bbeb6dfb50";
    const CH_B: &str = "1b2c3d4e-0000-4000-8000-000000000001";
    const ITEM_ID: &str = "7f3k2m9qa1bc";

    fn base_tags(reporter: &str) -> Vec<Vec<String>> {
        vec![
            vec!["d".into(), ITEM_ID.into()],
            vec!["type".into(), "bug".into()],
            vec!["status".into(), "open".into()],
            vec!["title".into(), "Composer drops the draft".into()],
            vec!["created".into(), "1759190400".into()],
            vec!["p".into(), reporter.into(), "".into(), "reporter".into()],
        ]
    }

    fn parts(tags: &[Vec<String>]) -> Result<(), ItemRejection> {
        validate_item_parts(30623, "", tags, 1_759_190_400)
    }

    fn reporter() -> String {
        "a".repeat(64)
    }

    fn with(mut tags: Vec<Vec<String>>, extra: &[&[&str]]) -> Vec<Vec<String>> {
        for t in extra {
            tags.push(t.iter().map(|s| s.to_string()).collect());
        }
        tags
    }

    fn replace(tags: Vec<Vec<String>>, name: &str, value: &str) -> Vec<Vec<String>> {
        tags.into_iter()
            .map(|mut t| {
                if t[0] == name {
                    t[1] = value.to_string();
                }
                t
            })
            .collect()
    }

    fn signed(keys: &Keys, channel: Option<&str>, status: &str, created_at: u64) -> nostr::Event {
        let mut tags = base_tags(&keys.public_key().to_hex());
        tags = replace(tags, "status", status);
        if let Some(ch) = channel {
            tags.push(vec!["h".into(), ch.into()]);
        }
        let tags: Vec<Tag> = tags
            .iter()
            .map(|t| Tag::parse(t.clone()).unwrap())
            .collect();
        EventBuilder::new(Kind::Custom(30623), "")
            .tags(tags)
            .allow_self_tagging()
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn item_kind_is_addressable_30623() {
        assert_eq!(KIND_ITEM, 30623);
        assert!(is_parameterized_replaceable(KIND_ITEM));
    }

    #[test]
    fn accepts_minimal_and_full_item() {
        assert_eq!(parts(&base_tags(&reporter())), Ok(()));
        let full = with(
            base_tags(&reporter()),
            &[
                &["h", CH_A],
                &["summary", "The draft is discarded"],
                &["p", &"b".repeat(64), "", "owner"],
                &["e", &"c".repeat(64), "", "source"],
                &["a", &format!("30621:{}:buzz-web", "d".repeat(64))],
                &["project", "Buzz web"],
                &["x-future", "ignored"],
            ],
        );
        assert_eq!(parts(&full), Ok(()));
    }

    #[test]
    fn rejects_non_uuid_h() {
        let tags = with(base_tags(&reporter()), &[&["h", "general"]]);
        assert!(parts(&tags).is_err());
        // Non-canonical spellings of a real UUID are refused too: h is part of
        // the fold identity, so one channel must have exactly one spelling.
        let upper = with(base_tags(&reporter()), &[&["h", &CH_A.to_uppercase()]]);
        assert!(parts(&upper).is_err());
    }

    #[test]
    fn rejects_second_h() {
        let tags = with(base_tags(&reporter()), &[&["h", CH_A], &["h", CH_B]]);
        assert!(parts(&tags).is_err());
    }

    #[test]
    fn rejects_second_status() {
        let tags = with(base_tags(&reporter()), &[&["status", "done"]]);
        assert!(parts(&tags).is_err());
    }

    #[test]
    fn rejects_unroled_p() {
        let tags = with(base_tags(&reporter()), &[&["p", &"b".repeat(64)]]);
        assert!(parts(&tags).is_err());
    }

    #[test]
    fn rejects_two_reporters() {
        let tags = with(
            base_tags(&reporter()),
            &[&["p", &"b".repeat(64), "", "reporter"]],
        );
        assert!(parts(&tags).is_err());
    }

    #[test]
    fn rejects_unknown_type_and_status() {
        assert!(parts(&replace(base_tags(&reporter()), "type", "task")).is_err());
        assert!(parts(&replace(base_tags(&reporter()), "status", "closed")).is_err());
    }

    #[test]
    fn title_bounds() {
        assert!(parts(&replace(base_tags(&reporter()), "title", "")).is_err());
        assert!(parts(&replace(base_tags(&reporter()), "title", "   ")).is_err());
        assert!(parts(&replace(base_tags(&reporter()), "title", &"t".repeat(201))).is_err());
        assert_eq!(
            parts(&replace(base_tags(&reporter()), "title", &"t".repeat(200))),
            Ok(())
        );
    }

    #[test]
    fn rejects_missing_required_tags() {
        for name in ["d", "type", "status", "title", "created"] {
            let tags: Vec<Vec<String>> = base_tags(&reporter())
                .into_iter()
                .filter(|t| t[0] != name)
                .collect();
            assert!(parts(&tags).is_err(), "missing {name} must be rejected");
        }
    }

    #[test]
    fn rejects_bad_d_created_e_a() {
        assert!(parts(&replace(base_tags(&reporter()), "d", "7f3k2m9qa1bI")).is_err());
        assert!(parts(&replace(base_tags(&reporter()), "d", "7f3k2")).is_err());
        assert!(parts(&replace(base_tags(&reporter()), "created", "1759191001")).is_err());
        assert_eq!(
            parts(&replace(base_tags(&reporter()), "created", "1759191000")),
            Ok(())
        );
        assert!(parts(&replace(base_tags(&reporter()), "created", "-1")).is_err());
        let e_no_marker = with(base_tags(&reporter()), &[&["e", &"c".repeat(64)]]);
        assert!(parts(&e_no_marker).is_err());
        let bad_a = with(base_tags(&reporter()), &[&["a", "30617:abc:repo"]]);
        assert!(parts(&bad_a).is_err());
    }

    #[test]
    fn fold_picks_newest_head_across_authors() {
        let a = Keys::generate();
        let b = Keys::generate();
        let heads = vec![
            signed(&a, Some(CH_A), "open", 1_759_190_400),
            signed(&b, Some(CH_A), "done", 1_759_190_500),
        ];
        let items = fold_items(&heads);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].status, "done");
        assert_eq!(items[0].updated_by, b.public_key().to_hex());
        assert_eq!(items[0].updated_at, 1_759_190_500);
    }

    #[test]
    fn fold_tie_breaks_on_lowest_id() {
        let a = Keys::generate();
        let b = Keys::generate();
        let x = signed(&a, None, "open", 1_759_190_400);
        let y = signed(&b, None, "done", 1_759_190_400);
        let lowest = if x.id.to_hex() < y.id.to_hex() {
            &x
        } else {
            &y
        };
        for order in [vec![x.clone(), y.clone()], vec![y.clone(), x.clone()]] {
            let items = fold_items(&order);
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].event_id, lowest.id.to_hex());
        }
    }

    #[test]
    fn fold_separates_same_d_in_different_channels() {
        let a = Keys::generate();
        let heads = vec![
            signed(&a, Some(CH_A), "open", 1_759_190_400),
            signed(&a, Some(CH_B), "done", 1_759_190_500),
        ];
        let items = fold_items(&heads);
        assert_eq!(items.len(), 2);
    }
}
