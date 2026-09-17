use buzz_sdk::{DeleteMessageOptions, DiffMeta, ThreadRef, VoteDirection};
use nostr::PublicKey;
use uuid::Uuid;

use crate::client::{normalize_events, normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::{
    infer_language, parse_event_id, read_or_stdin, truncate_diff, validate_content_size,
    validate_hex64, MAX_DIFF_BYTES,
};
use buzz_sdk::mentions::{
    extract_at_mentions_with_known, extract_nostr_uris, strip_code_regions, MENTION_CAP,
};

/// Extract the thread root event ID from a Nostr tag array.
///
/// Delegates marker parsing and collapse to [`buzz_core::nip10`] (shared with
/// relay ingest and ACP) so id-validity, marker selection, and top-level
/// classification cannot drift:
/// - A `root`+`reply` parent returns its root event ID.
/// - A `reply`-only parent returns the reply target (a direct reply's parent IS
///   the root).
/// - A root-only or marker-less parent returns `None` (it is top-level and its
///   own root).
fn find_root_from_tags(tags: &serde_json::Value) -> Option<String> {
    let parts: Vec<Vec<String>> = tags
        .as_array()?
        .iter()
        .filter_map(|tag| {
            tag.as_array().map(|a| {
                a.iter()
                    .map(|v| v.as_str().unwrap_or("").to_string())
                    .collect()
            })
        })
        .collect();
    buzz_core::nip10::parse_thread_markers_from_parts(parts.iter().map(Vec::as_slice))
        .resolve()
        .map(|(root, _)| root)
}

fn thread_ref_from_parent_tags(
    parent_eid: nostr::EventId,
    parent_event_id: &str,
    tags: &serde_json::Value,
) -> Result<ThreadRef, CliError> {
    let root_eid = match find_root_from_tags(tags) {
        Some(root_hex) if root_hex != parent_event_id => parse_event_id(&root_hex)?,
        _ => parent_eid,
    };

    Ok(ThreadRef {
        root_event_id: root_eid,
        parent_event_id: parent_eid,
    })
}

/// Build a `ThreadRef` for a reply, given the immediate parent's event ID.
///
/// Fetches the parent event from the relay and inspects its NIP-10 `e` tags to
/// determine the thread root:
/// - Direct reply (parent is top-level): `root == parent`.
/// - Nested reply: `root` is the parent's own root marker; `parent` is unchanged.
///
/// Ensures CLI-sent replies thread correctly using the same NIP-10 logic.
async fn fetch_event(client: &BuzzClient, event_id: &str) -> Result<serde_json::Value, CliError> {
    let filter = serde_json::json!({ "ids": [event_id], "limit": 1 });
    let raw = client.query(&filter).await?;
    let events: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("failed to parse query response: {e}")))?;
    events
        .as_array()
        .and_then(|events| events.first())
        .cloned()
        .ok_or_else(|| CliError::NotFound(format!("event {event_id} not found")))
}

async fn resolve_thread_ref(
    client: &BuzzClient,
    parent_event_id: &str,
) -> Result<ThreadRef, CliError> {
    let event = fetch_event(client, parent_event_id).await?;
    thread_ref_from_event(parent_event_id, &event)
}

fn thread_ref_from_event(event_id: &str, event: &serde_json::Value) -> Result<ThreadRef, CliError> {
    let parent_eid = parse_event_id(event_id)?;
    let tags = event
        .get("tags")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    thread_ref_from_parent_tags(parent_eid, event_id, &tags)
}

/// Resolve the channel UUID for an event by querying for it via POST /query.
/// Extracts the `h` tag value from the returned event's tags.
fn channel_id_from_event(event_id: &str, event: &serde_json::Value) -> Result<Uuid, CliError> {
    let tags = event
        .get("tags")
        .and_then(|tags| tags.as_array())
        .ok_or_else(|| CliError::Other("event missing 'tags' field".into()))?;
    tags.iter()
        .filter_map(|tag| tag.as_array())
        .find(|tag| tag.first().and_then(|value| value.as_str()) == Some("h"))
        .and_then(|tag| tag.get(1))
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            CliError::Other(format!(
                "event {event_id} has no h-tag — cannot determine channel"
            ))
        })
        .and_then(|channel_id| {
            Uuid::parse_str(channel_id).map_err(|_| {
                CliError::Other(format!("event h-tag is not a valid UUID: {channel_id}"))
            })
        })
}

async fn resolve_channel_id(client: &BuzzClient, event_id: &str) -> Result<Uuid, CliError> {
    let event = fetch_event(client, event_id).await?;
    channel_id_from_event(event_id, &event)
}

fn resolve_names_to_pubkeys(
    names: &[String],
    name_to_pubkeys: &std::collections::HashMap<String, Vec<String>>,
    has_explicit_mentions: bool,
) -> Result<Vec<String>, CliError> {
    let mut resolved = Vec::new();
    for name in names {
        match name_to_pubkeys
            .get(name)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            [pubkey] => resolved.push(pubkey.clone()),
            [] if has_explicit_mentions => {}
            [] => {
                return Err(CliError::Usage(format!(
                    "mention '@{name}' does not match a current channel member; retry with --mention <pubkey>"
                )))
            }
            _ if has_explicit_mentions => {}
            candidates => {
                return Err(CliError::Usage(format!(
                    "mention '@{name}' is ambiguous; candidates: {}. Retry with --mention <pubkey>",
                    candidates.join(", ")
                )))
            }
        }
    }
    Ok(resolved)
}

/// Resolve mention text against the channel membership snapshot.
///
/// Returns both the current member set and uniquely name-resolved pubkeys.
/// Lookup failures are fatal when mention processing is requested: publishing
/// visible mention text without its intended `p` tag is worse than not sending.
async fn resolve_content_mentions(
    client: &BuzzClient,
    channel_id: &str,
    content: &str,
    has_explicit_mentions: bool,
) -> Result<(Vec<String>, Vec<String>), CliError> {
    let stripped = strip_code_regions(content);
    if !stripped.contains('@') && !has_explicit_mentions {
        return Ok((vec![], vec![]));
    }

    let members_filter = serde_json::json!({
        "kinds": [39002],
        "#d": [channel_id],
        "limit": 1,
    });
    let member_pubkeys = fetch_member_pubkeys(client, &members_filter)
        .await
        .ok_or_else(|| {
            CliError::Indeterminate("could not load channel membership for mention preflight — the read failed or came back empty; retry before concluding the channel is gone".into())
        })?;

    if !stripped.contains('@') {
        return Ok((member_pubkeys, vec![]));
    }

    let profiles_filter = serde_json::json!({
        "kinds": [0],
        "authors": member_pubkeys,
        "limit": member_pubkeys.len(),
    });
    let profile_events = fetch_events(client, &profiles_filter)
        .await
        .ok_or_else(|| {
            CliError::Other("could not load member profiles for mention resolution".into())
        })?;

    let mut name_to_pubkeys: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut display_names = Vec::new();
    for e in &profile_events {
        let Some(pubkey) = e.get("pubkey").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(content_json) = e.get("content").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(content_json) else {
            continue;
        };
        let Some(name) = v
            .get("display_name")
            .or_else(|| v.get("name"))
            .and_then(|n| n.as_str())
            .filter(|n| !n.is_empty())
        else {
            continue;
        };
        name_to_pubkeys
            .entry(name.to_ascii_lowercase())
            .or_default()
            .push(pubkey.to_string());
        display_names.push(name.to_string());
    }

    let known_refs: Vec<&str> = display_names.iter().map(String::as_str).collect();
    let names = extract_at_mentions_with_known(&stripped, &known_refs);
    let resolved = resolve_names_to_pubkeys(&names, &name_to_pubkeys, has_explicit_mentions)?;
    Ok((member_pubkeys, resolved))
}

fn normalize_explicit_mentions(values: &[String]) -> Result<Vec<String>, CliError> {
    let mut normalized = Vec::new();
    for value in values {
        let pubkey = PublicKey::parse(value.trim())
            .map_err(|_| CliError::Usage(format!("invalid --mention pubkey: {value}")))?;
        let hex = pubkey.to_hex();
        if !normalized.contains(&hex) {
            normalized.push(hex);
        }
    }
    if normalized.len() > MENTION_CAP {
        return Err(CliError::Usage(format!(
            "too many --mention values (max {MENTION_CAP})"
        )));
    }
    Ok(normalized)
}

fn merge_message_mentions(
    explicit: &[String],
    uri_pubkeys: &[String],
    auto_resolved: &[String],
) -> Result<Vec<String>, CliError> {
    let mut mentions = Vec::new();
    for pubkey in explicit
        .iter()
        .chain(uri_pubkeys.iter())
        .chain(auto_resolved.iter())
    {
        if !mentions.contains(pubkey) {
            mentions.push(pubkey.clone());
        }
    }
    if mentions.len() > MENTION_CAP {
        return Err(CliError::Usage(format!(
            "too many unique message mentions (max {MENTION_CAP})"
        )));
    }
    Ok(mentions)
}

fn missing_members(mentions: &[String], members: &[String]) -> Vec<String> {
    let members: std::collections::HashSet<&str> = members.iter().map(String::as_str).collect();
    mentions
        .iter()
        .filter(|pk| !members.contains(pk.as_str()))
        .cloned()
        .collect()
}

fn event_mention_pubkeys(event: &nostr::Event) -> Vec<String> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts.first().map(String::as_str) == Some("p"))
                .then(|| parts.get(1).cloned())
                .flatten()
        })
        .collect()
}

/// Fetch raw events for `filter` via the relay's `/query` endpoint.
/// Returns `None` on any I/O or parse failure.
async fn fetch_events(
    client: &BuzzClient,
    filter: &serde_json::Value,
) -> Option<Vec<serde_json::Value>> {
    let raw = client.query(filter).await.ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed.as_array().cloned()
}

/// Extract member pubkeys (the `p` tag values) from a single 39002 event.
async fn fetch_member_pubkeys(
    client: &BuzzClient,
    filter: &serde_json::Value,
) -> Option<Vec<String>> {
    let events = fetch_events(client, filter).await?;
    Some(parse_member_pubkeys(events.first()?))
}

/// Parse member pubkeys from a kind 39002 event JSON value.
///
/// Filters and canonicalizes via `nostr::PublicKey::from_hex` — matching
/// MCP's typed-Nostr behavior so both surfaces accept exactly the same
/// pubkeys. Pure helper, split out for testing.
fn parse_member_pubkeys(event: &serde_json::Value) -> Vec<String> {
    let Some(tags) = event.get("tags").and_then(|t| t.as_array()) else {
        return vec![];
    };
    tags.iter()
        .filter_map(|t| {
            let arr = t.as_array()?;
            if arr.first()?.as_str()? != "p" {
                return None;
            }
            let pk = arr.get(1)?.as_str()?;
            PublicKey::from_hex(pk).ok().map(|k| k.to_hex())
        })
        .collect()
}

fn format_events(normalized: &str, format: &crate::OutputFormat) -> String {
    match format {
        crate::OutputFormat::Compact => {
            let events: Vec<serde_json::Value> =
                serde_json::from_str(normalized).unwrap_or_default();
            let compact: Vec<serde_json::Value> = events
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "id": e.get("id").cloned().unwrap_or_default(),
                        "content": e.get("content").cloned().unwrap_or_default(),
                        "created_at": e.get("created_at").cloned().unwrap_or_default(),
                    })
                })
                .collect();
            serde_json::to_string(&compact).unwrap_or_default()
        }
        crate::OutputFormat::Json => normalized.to_string(),
    }
}

pub async fn cmd_get_messages(
    client: &BuzzClient,
    channel_id: &str,
    limit: Option<u32>,
    before: Option<i64>,
    since: Option<i64>,
    kinds: Option<&str>,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    let channel_id = crate::channel_ref::resolve_channel_uuid(client, channel_id)
        .await?
        .to_string();
    let limit = limit.unwrap_or(50).min(200);

    let mut filter = serde_json::json!({
        "kinds": [9, 40002, 40008, 45001, 45003],
        "#h": [channel_id],
        "limit": limit
    });

    // If specific kinds requested, override
    if let Some(k) = kinds {
        let kind_list: Vec<u64> = k.split(',').filter_map(|s| s.trim().parse().ok()).collect();
        if !kind_list.is_empty() {
            filter["kinds"] = serde_json::json!(kind_list);
        }
    }

    if let Some(b) = before {
        filter["until"] = serde_json::json!(b);
    }
    if let Some(s) = since {
        filter["since"] = serde_json::json!(s);
    }

    let resp = client.query(&filter).await?;
    let mut events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
    events.sort_by_key(|e| e.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0));
    let normalized = normalize_events(&events);
    println!("{}", format_events(&normalized, format));
    Ok(())
}

pub fn resolve_thread_target(
    expected_channel_id: Uuid,
    event_id: &str,
    expected_root_id: Option<&str>,
    selected_event: &serde_json::Value,
) -> Result<String, CliError> {
    let actual_channel_id = channel_id_from_event(event_id, selected_event)?;
    if actual_channel_id != expected_channel_id {
        return Err(CliError::Usage(format!(
            "event {event_id} does not belong to channel {expected_channel_id}"
        )));
    }
    let root_event_id = thread_ref_from_event(event_id, selected_event)?
        .root_event_id
        .to_hex();
    if expected_root_id.is_some_and(|expected| expected != root_event_id) {
        return Err(CliError::Usage(
            "Buzz message link thread root does not match the selected message".into(),
        ));
    }
    Ok(root_event_id)
}

pub async fn cmd_get_thread(
    client: &BuzzClient,
    channel_id: &str,
    event_id: &str,
    expected_root_id: Option<&str>,
    limit: Option<u32>,
    depth_limit: Option<u32>,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    let expected_channel_id = crate::channel_ref::resolve_channel_uuid(client, channel_id).await?;
    let channel_id = expected_channel_id.to_string();
    validate_hex64(event_id)?;
    let selected_event = fetch_event(client, event_id).await?;
    let root_event_id = resolve_thread_target(
        expected_channel_id,
        event_id,
        expected_root_id,
        &selected_event,
    )?;
    let limit = limit.unwrap_or(100).min(500);

    let mut reply_filter = serde_json::json!({
        "kinds": [9, 40002, 40003, 40008, 45003],
        "#h": [channel_id],
        "#e": [root_event_id.as_str()],
        "limit": limit
    });
    if let Some(d) = depth_limit {
        reply_filter["depth_limit"] = serde_json::json!(d);
    }
    let root_filter = serde_json::json!({
        "ids": [root_event_id.as_str()],
        "#h": [channel_id],
        "limit": 1
    });
    let resp = client.query_multi(&[reply_filter, root_filter]).await?;
    let mut events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
    events.sort_by_key(|event| {
        event
            .get("created_at")
            .and_then(|value| value.as_u64())
            .unwrap_or(0)
    });
    let normalized = normalize_events(&events);
    println!("{}", format_events(&normalized, format));
    Ok(())
}

pub async fn cmd_search(
    client: &BuzzClient,
    query: Option<&str>,
    author: Option<&str>,
    since: Option<i64>,
    limit: Option<u32>,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    if query.is_none() && author.is_none() {
        return Err(CliError::Usage(
            "at least one of --query or --author is required".into(),
        ));
    }
    let limit = limit.unwrap_or(20).min(100);

    let author_hex = match author {
        Some(a) => Some(resolve_author(client, a).await?),
        None => None,
    };

    let mut filter = serde_json::json!({
        "kinds": [9, 40002, 45001, 45003],
        "limit": limit
    });
    if let Some(q) = query {
        filter["search"] = serde_json::json!(q);
    }
    if let Some(ref pk) = author_hex {
        filter["authors"] = serde_json::json!([pk]);
    }
    if let Some(s) = since {
        filter["since"] = serde_json::json!(s);
    }
    let resp = client.query(&filter).await?;
    let mut events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
    // The full-text path returns relevance order; a pure author/time query has
    // no relevance, so present newest-first like `messages get`.
    if query.is_none() {
        events.sort_by_key(|e| {
            std::cmp::Reverse(e.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0))
        });
    }
    let normalized = normalize_events(&events);
    println!("{}", format_events(&normalized, format));
    Ok(())
}

/// Resolve an `--author` value to a 64-char hex pubkey.
///
/// Accepts, in order of precedence: 64-char hex (validated), an `npub1…`
/// bech32 key, or a display name resolved via NIP-50 profile search. A name
/// must match exactly one user (case-insensitive, on `display_name` or
/// `name`) — ambiguity is an error listing the candidates rather than a
/// silent mix of authors.
async fn resolve_author(client: &BuzzClient, author: &str) -> Result<String, CliError> {
    let author = author.trim();
    if author.len() == 64 && author.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(author.to_ascii_lowercase());
    }
    if author.starts_with("npub1") {
        return nostr::PublicKey::parse(author)
            .map(|pk| pk.to_hex())
            .map_err(|_| CliError::Usage(format!("invalid npub: {author}")));
    }

    // Display name → NIP-50 search on kind:0, exact case-insensitive match.
    let filter = serde_json::json!({
        "kinds": [0],
        "search": author,
        "limit": 100
    });
    let raw = client.query(&filter).await?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap_or_default();
    let mut matches = match_profiles_by_name(&events, author);
    match matches.len() {
        0 => Err(CliError::Usage(format!(
            "no user found with name '{author}' — pass a hex pubkey or npub instead"
        ))),
        1 => Ok(matches.remove(0).0),
        _ => {
            // Cap the candidate listing — some names are shared by dozens of
            // users, and an unbounded list turns the error into a wall of text.
            let shown = 5.min(matches.len());
            let mut listing: Vec<String> = matches[..shown]
                .iter()
                .map(|(pk, name)| format!("{name} ({pk})"))
                .collect();
            if matches.len() > shown {
                listing.push(format!("… and {} more", matches.len() - shown));
            }
            Err(CliError::Usage(format!(
                "name '{author}' is ambiguous — matches: {}. Pass a pubkey instead",
                listing.join(", ")
            )))
        }
    }
}

/// Exact case-insensitive profile match on `display_name` or `name` across
/// kind:0 events. Returns deduped `(pubkey, shown name)` pairs. Pure so the
/// name-resolution semantics are unit-testable without a relay.
fn match_profiles_by_name(events: &[serde_json::Value], name: &str) -> Vec<(String, String)> {
    let lower = name.to_ascii_lowercase();
    let mut matches: Vec<(String, String)> = Vec::new();
    for e in events {
        let Some(pubkey) = e.get("pubkey").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(content) = e
            .get("content")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        else {
            continue;
        };
        let display_name = content
            .get("display_name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let plain_name = content.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if display_name.to_ascii_lowercase() == lower || plain_name.to_ascii_lowercase() == lower {
            let shown = if display_name.is_empty() {
                plain_name
            } else {
                display_name
            };
            matches.push((pubkey.to_string(), shown.to_string()));
        }
    }
    matches.sort();
    matches.dedup();
    matches
}

pub struct SendMessageParams {
    pub channel_id: String,
    pub content: String,
    pub kind: Option<u16>,
    pub reply_to: Option<String>,
    pub broadcast: bool,
    pub files: Vec<String>,
    pub mentions: Vec<String>,
    /// Skip the send-path hold check for THIS send and record the superseded
    /// holder in the claims file (dead-holder escape; unmanaged sends ignore
    /// it).
    pub supersede: bool,
    /// D-035 decision card payload spec: inline JSON, '@file.json', or '-' for
    /// stdin. When set, the outgoing kind 9 carries `["card", …]` for the web
    /// client's tappable rendering; empty content falls back to text generated
    /// from the card.
    pub card: Option<String>,
}

/// The message kinds the send-path hold gate and the identity stamp apply
/// to — exactly the kinds `cmd_send_message` can publish.
fn is_agent_message_kind(kind: Option<u16>) -> bool {
    matches!(kind, None | Some(9) | Some(45001) | Some(45003))
}

// D-035 decision card: limits and helpers. These MIRROR the web client's
// `web/src/features/channels/lib/decisionCard.ts` (CARD_LIMITS +
// buildCardTag/cardFallbackText) — the two validators were built in one
// head and reviewed together precisely so they cannot drift; changing one
// side without the other is a client contract break.
const CARD_MAX_TAG_UNITS: usize = 4096;
const CARD_MAX_TITLE_CHARS: usize = 120;
const CARD_MAX_BODY_CHARS: usize = 4000;
const CARD_MAX_OPTIONS: usize = 8;
const CARD_MAX_LABEL_CHARS: usize = 200;
const CARD_MAX_ID_CHARS: usize = 40;

/// JS `.length` parity: the web validator bounds every string by UTF-16
/// code units, so this side measures the same way. A Rust `chars().count()`
/// is smaller for astral characters (emoji count 1 there, 2 here), which
/// would let the CLI emit a card the web parser then rejects — the exact
/// drift this builder exists to prevent.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The stderr guidance for a decision card sent with no `--mention`.
///
/// The web Asks inbox (D-035 follow-on) treats a card as an ASK only when it
/// p-tags the viewer — outside a 2-party DM there is no leniency to infer the
/// askee. An unmentioned card is therefore invisible to every Asks inbox; the
/// agent-side author should know that at send time. A WARNING, not a refusal:
/// broadcast cards (channel polls) are legitimate and common.
fn card_without_mention_notice(has_card: bool, mention_count: usize) -> Option<String> {
    if has_card && mention_count == 0 {
        Some("note: card has no --mention; it will not appear in any Asks inbox".to_string())
    } else {
        None
    }
}

fn bounded_utf16(value: &str, max_chars: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || utf16_len(trimmed) > max_chars {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Validate a D-035 `--card` payload (JSON per the flag help) and build both
/// halves of the outgoing kind 9: the `["card", …]` tag the web client
/// renders as a tappable question, and the human-readable fallback content
/// every plain client (including the desktop app) shows on its own.
///
/// Authoring is deliberately STRICTER than the web parse (which tolerates
/// e.g. two recommended options by keeping the first): this side refuses the
/// send, so self-contradicting cards never reach the wire.
fn build_card_tag(raw: &str) -> Result<(Vec<String>, String), CliError> {
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| CliError::Usage(format!("--card: invalid JSON: {e}")))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| CliError::Usage("--card: payload must be a JSON object".into()))?;
    if let Some(v) = obj.get("v") {
        if v.as_u64() != Some(1) {
            return Err(CliError::Usage("--card: only v=1 is supported".into()));
        }
    }
    let title = bounded_utf16(
        obj.get("title").and_then(|t| t.as_str()).unwrap_or(""),
        CARD_MAX_TITLE_CHARS,
    )
    .ok_or_else(|| {
        CliError::Usage(format!(
            "--card: title must be 1-{CARD_MAX_TITLE_CHARS} characters"
        ))
    })?;
    let body = match obj.get("body") {
        None | Some(serde_json::Value::Null) => None,
        Some(b) => {
            let text = b
                .as_str()
                .ok_or_else(|| CliError::Usage("--card: body must be a string".into()))?;
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else if utf16_len(trimmed) > CARD_MAX_BODY_CHARS {
                return Err(CliError::Usage(format!(
                    "--card: body must be at most {CARD_MAX_BODY_CHARS} characters"
                )));
            } else {
                Some(trimmed.to_string())
            }
        }
    };
    let raw_options = obj
        .get("options")
        .and_then(|o| o.as_array())
        .ok_or_else(|| CliError::Usage("--card: options must be an array".into()))?;
    if raw_options.len() < 2 || raw_options.len() > CARD_MAX_OPTIONS {
        return Err(CliError::Usage(format!(
            "--card: needs 2-{CARD_MAX_OPTIONS} options (got {})",
            raw_options.len()
        )));
    }
    let mut recommended_count = 0usize;
    let mut options_out: Vec<serde_json::Value> = Vec::with_capacity(raw_options.len());
    for (index, candidate) in raw_options.iter().enumerate() {
        let option = candidate.as_object().ok_or_else(|| {
            CliError::Usage(format!("--card: option {} must be an object", index + 1))
        })?;
        let label = bounded_utf16(
            option.get("label").and_then(|l| l.as_str()).unwrap_or(""),
            CARD_MAX_LABEL_CHARS,
        )
        .ok_or_else(|| {
            CliError::Usage(format!(
                "--card: option {} label must be 1-{CARD_MAX_LABEL_CHARS} characters",
                index + 1
            ))
        })?;
        // Mirror of the web builder: an explicit bounded id rides the wire,
        // an absent one is omitted entirely (the web parse derives
        // positional ids — ids are render keys, not identity promises).
        let mut entry = serde_json::Map::new();
        if let Some(id_value) = option.get("id") {
            if let Some(id) = id_value.as_str() {
                let trimmed = id.trim();
                if !trimmed.is_empty() {
                    if utf16_len(trimmed) > CARD_MAX_ID_CHARS {
                        return Err(CliError::Usage(format!(
                            "--card: option {} id must be at most {CARD_MAX_ID_CHARS} characters",
                            index + 1
                        )));
                    }
                    entry.insert(
                        "id".to_string(),
                        serde_json::Value::String(trimmed.to_string()),
                    );
                }
            } else {
                return Err(CliError::Usage(format!(
                    "--card: option {} id must be a string",
                    index + 1
                )));
            }
        }
        entry.insert("label".to_string(), serde_json::Value::String(label));
        if option.get("recommended").and_then(|r| r.as_bool()) == Some(true) {
            recommended_count += 1;
            entry.insert("recommended".to_string(), serde_json::Value::Bool(true));
        }
        options_out.push(serde_json::Value::Object(entry));
    }
    if recommended_count > 1 {
        return Err(CliError::Usage(format!(
            "--card: at most one option may be recommended ({recommended_count} marked)"
        )));
    }

    let mut payload = serde_json::Map::new();
    payload.insert("v".to_string(), serde_json::Value::Number(1.into()));
    payload.insert(
        "title".to_string(),
        serde_json::Value::String(title.clone()),
    );
    if let Some(ref body_text) = body {
        payload.insert(
            "body".to_string(),
            serde_json::Value::String(body_text.clone()),
        );
    }
    payload.insert(
        "options".to_string(),
        serde_json::Value::Array(options_out.clone()),
    );
    let json = serde_json::to_string(&serde_json::Value::Object(payload))
        .map_err(|e| CliError::Other(format!("--card: serialization failed: {e}")))?;
    if utf16_len(&json) > CARD_MAX_TAG_UNITS {
        return Err(CliError::Usage(format!(
            "--card: payload exceeds {CARD_MAX_TAG_UNITS} characters after serialization"
        )));
    }
    let tag = vec!["card".to_string(), json];

    // Fallback content, mirroring the web's cardFallbackText so a plain
    // client and the web card render the SAME question, not two variants.
    let mut fallback = format!("**{title}**");
    if let Some(ref body_text) = body {
        fallback.push_str("\n\n");
        fallback.push_str(body_text);
    }
    fallback.push_str("\n");
    for option in &options_out {
        fallback.push_str("\n- ");
        fallback.push_str(option.get("label").and_then(|l| l.as_str()).unwrap_or(""));
        if option.get("recommended").and_then(|r| r.as_bool()) == Some(true) {
            fallback.push_str(" *(Recommended)*");
        }
    }
    fallback.push_str("\n\n_Reply with an option or your own answer._");
    Ok((tag, fallback))
}

pub async fn cmd_send_message(
    client: &BuzzClient,
    mut p: SendMessageParams,
) -> Result<(), CliError> {
    // Allow '-' to read content from stdin. This keeps callers from having to
    // jam shell-metacharacter-heavy text (backticks, $vars, etc.) through argv
    // quoting — the source of countless self-inflicted command-substitution
    // bugs for agent and human users alike.
    p.content = read_or_stdin(&p.content)?;

    // D-035 decision card: resolve the payload spec ('@file.json' / '-' /
    // inline JSON), validate it strictly (the web parse tolerates, the
    // authoring path refuses), and derive the readable fallback content when
    // the caller did not supply one.
    let card_tag: Option<Vec<String>> = match p.card.take() {
        Some(spec) => {
            let raw = if let Some(path) = spec.strip_prefix('@') {
                std::fs::read_to_string(path)
                    .map_err(|e| CliError::Usage(format!("--card: cannot read {path}: {e}")))?
            } else {
                read_or_stdin(&spec)?
            };
            let (tag, fallback) = build_card_tag(&raw)?;
            if p.content.trim().is_empty() {
                p.content = fallback;
            }
            Some(tag)
        }
        None => None,
    };
    if card_tag.is_none() && p.content.trim().is_empty() {
        return Err(CliError::Usage(
            "--content is required (or pass --card, which generates it)".into(),
        ));
    }
    validate_content_size(&p.content)?;
    if let Some(ref r) = p.reply_to {
        validate_hex64(r)?;
    }
    // Channel addressing: UUID fast path (no network), else name/#slug
    // resolution against visible channel metadata. Rewriting p.channel_id to
    // the canonical UUID keeps every downstream consumer (hold gate, mention
    // preflight, error strings) on the resolved identity.
    let channel_uuid = crate::channel_ref::resolve_channel_uuid(client, &p.channel_id).await?;
    p.channel_id = channel_uuid.to_string();

    // Send-path hold gate (managed sessions only). Before ANY network I/O:
    // a held session must not burn mention preflights or uploads on a send
    // it is not allowed to make. With BUZZ_ACP_SESSION_ID absent this whole
    // block is skipped — humans and ad-hoc shells are never gated.
    let session_slot = crate::claims_gate::session_slot().filter(|_| is_agent_message_kind(p.kind));
    if let Some(slot) = &session_slot {
        if p.supersede {
            crate::claims_gate::record_supersedes(&channel_uuid, slot);
        } else if let Some(hold) = crate::claims_gate::check_hold(&channel_uuid, slot) {
            return Err(CliError::Held {
                holder: hold.holder_slot,
                channel: hold.channel.to_string(),
                age: hold.claim_age_secs,
                ttl: hold.ttl_secs,
            });
        }
    }

    let explicit_mentions = normalize_explicit_mentions(&p.mentions)?;
    let stripped = strip_code_regions(&p.content);
    let uri_pubkeys = extract_nostr_uris(&stripped);
    // Supplying any identity explicitly authorizes unresolved or ambiguous @Name text
    // as presentation-only, matching Desktop's separate visible-label and p-tag model.
    // Uniquely resolvable member names still add their own p-tags; callers must supply
    // every intended identity whose visible label cannot be resolved uniquely.
    let has_explicit_mentions = !explicit_mentions.is_empty() || !uri_pubkeys.is_empty();
    let (member_pubkeys, auto_resolved) =
        resolve_content_mentions(client, &p.channel_id, &p.content, has_explicit_mentions).await?;
    let mention_pubkeys = merge_message_mentions(&explicit_mentions, &uri_pubkeys, &auto_resolved)?;

    let missing = missing_members(&mention_pubkeys, &member_pubkeys);
    if !missing.is_empty() {
        return Err(CliError::Usage(
            serde_json::json!({
                "message": "mentioned pubkeys are not channel members; add them explicitly before retrying",
                "missing_member_pubkeys": missing,
                "add_member_command": format!("buzz channels add-member --channel {} --pubkey <pubkey> --role <member|bot>", p.channel_id),
            })
            .to_string(),
        ));
    }

    // D-035 asks inbox guardrail: only fires on the send path (after the
    // member check), so a doomed send is not double-noised. stderr keeps
    // stdout JSON-clean for `--format json` consumers.
    if let Some(notice) = card_without_mention_notice(card_tag.is_some(), mention_pubkeys.len()) {
        eprintln!("{notice}");
    }

    // Upload files and build imeta tags
    let mut media_tags: Vec<Vec<String>> = Vec::new();
    let mut media_content = String::new();
    for file_path in &p.files {
        let desc = client
            .upload_file(file_path)
            .await
            .map_err(|e| CliError::Other(format!("upload failed for {file_path}: {e}")))?;
        media_tags.push(crate::client::build_imeta_tag(&desc));
        if desc.mime_type.starts_with("video/") {
            media_content.push_str("\n![video](");
        } else {
            media_content.push_str("\n![image](");
        }
        media_content.push_str(&desc.url);
        media_content.push(')');
    }
    let final_content = if media_content.is_empty() {
        p.content.clone()
    } else {
        format!("{}{media_content}", p.content)
    };

    // D-035 card tag rides AFTER imeta attachments and BEFORE the session
    // stamp (send-gate review criterion, CK 9/16) — one validated extra
    // tag, no arbitrary passthrough opened alongside it.
    if let Some(tag) = card_tag {
        media_tags.push(tag);
    }

    // Identity stamp (managed sessions): `["session", "<slot>"]` rides the
    // outgoing event's tags for kinds 9 / 45001 / 45003, so any client can
    // tell which pool slot of the identity spoke. `build_message` (and the
    // forum builders) take `media_tags` as their last slice param and pass
    // raw tags through (`allow_self_tagging`; the relay's verify_event checks
    // id + signature only — arbitrary tags store fine), so the stamp is
    // appended here rather than by changing the SDK signatures.
    if let Some(slot) = &session_slot {
        media_tags.push(crate::claims_gate::session_tag(slot));
    }

    // Build thread ref if replying. `--reply-to` is the immediate parent; the
    // thread root is derived from the parent's NIP-10 tags via the relay.
    let thread_ref = if let Some(ref r) = p.reply_to {
        Some(resolve_thread_ref(client, r).await?)
    } else {
        None
    };

    let mention_refs: Vec<&str> = mention_pubkeys.iter().map(String::as_str).collect();

    let builder = match p.kind {
        Some(45001) => {
            buzz_sdk::build_forum_post(channel_uuid, &final_content, &mention_refs, &media_tags)
                .map_err(|e| CliError::Other(format!("build_forum_post failed: {e}")))?
        }
        Some(45003) => {
            let tr = thread_ref.as_ref().ok_or_else(|| {
                CliError::Usage("--reply-to is required for forum comments (kind 45003)".into())
            })?;
            buzz_sdk::build_forum_comment(
                channel_uuid,
                &final_content,
                tr,
                &mention_refs,
                &media_tags,
            )
            .map_err(|e| CliError::Other(format!("build_forum_comment failed: {e}")))?
        }
        None | Some(9) => buzz_sdk::build_message(
            channel_uuid,
            &final_content,
            thread_ref.as_ref(),
            &mention_refs,
            p.broadcast,
            &media_tags,
        )
        .map_err(|e| CliError::Other(format!("build_message failed: {e}")))?,
        Some(k) => {
            return Err(CliError::Usage(format!(
                "--kind {k} is not supported (use 9, 45001, or 45003)"
            )))
        }
    };

    let event = client.sign_event(builder)?;
    let emitted_mentions = event_mention_pubkeys(&event);
    let resp = client.submit_event(event).await?;
    let mut output: serde_json::Value = serde_json::from_str(&normalize_write_response(&resp))
        .unwrap_or_else(|_| serde_json::json!({ "response": resp }));
    if let Some(object) = output.as_object_mut() {
        object.insert(
            "mention_pubkeys".into(),
            serde_json::json!(emitted_mentions),
        );
        if let Some(slot) = &session_slot {
            object.insert("session_slot".into(), serde_json::json!(slot));
        }
    }
    println!("{output}");
    Ok(())
}

pub struct SendDiffParams {
    pub channel_id: String,
    pub diff: String,
    pub repo_url: String,
    pub commit_sha: String,
    pub file_path: Option<String>,
    pub parent_commit_sha: Option<String>,
    pub source_branch: Option<String>,
    pub target_branch: Option<String>,
    pub pr_number: Option<u32>,
    pub language: Option<String>,
    pub description: Option<String>,
    pub reply_to: Option<String>,
}

pub async fn cmd_send_diff_message(
    client: &BuzzClient,
    mut p: SendDiffParams,
) -> Result<(), CliError> {
    if let Some(r) = &p.reply_to {
        validate_hex64(r)?;
    }

    // Branch pairing: both or neither
    match (&p.source_branch, &p.target_branch) {
        (Some(_), None) | (None, Some(_)) => {
            return Err(CliError::Usage(
                "--source-branch and --target-branch must both be provided or both omitted".into(),
            ));
        }
        _ => {}
    }

    let channel_uuid = crate::channel_ref::resolve_channel_uuid(client, &p.channel_id).await?;
    p.channel_id = channel_uuid.to_string();

    // Read diff from stdin if "--diff -"
    let diff_content = read_or_stdin(&p.diff)?;

    // Truncate at 60 KiB hunk boundary
    let (diff, truncated) = truncate_diff(&diff_content, MAX_DIFF_BYTES);

    // Language inference: explicit flag wins, then infer from file path
    let language = p
        .language
        .clone()
        .or_else(|| p.file_path.as_deref().and_then(infer_language));

    // NIP-31 alt tag
    let alt = match (&p.file_path, &p.description) {
        (Some(fp), Some(desc)) => format!("Diff: {} — {}", fp, desc),
        (Some(fp), None) => format!("Diff: {}", fp),
        _ => "Diff".to_string(),
    };

    // `--reply-to` is the immediate parent; the thread root is derived from
    // the parent's NIP-10 tags via the relay.
    let thread_ref = if let Some(r) = &p.reply_to {
        Some(resolve_thread_ref(client, r).await?)
    } else {
        None
    };

    let branch = match (&p.source_branch, &p.target_branch) {
        (Some(src), Some(tgt)) => Some((src.clone(), tgt.clone())),
        _ => None,
    };

    let diff_meta = DiffMeta {
        repo_url: p.repo_url.clone(),
        commit_sha: p.commit_sha.clone(),
        file_path: p.file_path.clone(),
        parent_commit: p.parent_commit_sha.clone(),
        branch,
        pr_number: p.pr_number,
        language,
        description: p.description.clone(),
        truncated,
        alt_text: Some(alt),
    };

    let builder =
        buzz_sdk::build_diff_message(channel_uuid, &diff, &diff_meta, thread_ref.as_ref())
            .map_err(|e| CliError::Other(format!("build_diff_message failed: {e}")))?;

    let event = client.sign_event(builder)?;

    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

pub async fn cmd_delete_message(
    client: &BuzzClient,
    event_id: &str,
    action_id: Option<Uuid>,
    reason_code: Option<&str>,
    public_reason: Option<&str>,
) -> Result<(), CliError> {
    validate_hex64(event_id)?;

    // Resolve channel_id from the event's h-tag
    let channel_uuid = resolve_channel_id(client, event_id).await?;
    let target_eid = parse_event_id(event_id)?;

    let builder = buzz_sdk::build_delete_message_with_options(
        channel_uuid,
        target_eid,
        DeleteMessageOptions {
            action_id,
            reason_code,
            public_reason,
        },
    )
    .map_err(|e| CliError::Other(format!("build_delete_message failed: {e}")))?;

    let event = client.sign_event(builder)?;

    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

/// Edit a message you previously sent.
/// The emoji that marks a work claim. A claim is a signed kind:7 reaction
/// with this content on the task event — visible in every client and owned
/// by the claiming key. Chosen to be unambiguous in normal channel traffic:
/// nobody locks a message to say "nice".
pub(crate) const CLAIM_EMOJI: &str = "🔒";

/// What the 🔒 reactions on an event say about its claim state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaimState {
    /// Unclaimed — no 🔒 reactions at all.
    Unclaimed,
    /// Claimed by the caller's own key (re-claiming is an idempotent no-op).
    Ours,
    /// Claimed by another key: holder's pubkey, and when the claim was made.
    Foreign { pubkey: String, created_at: u64 },
}

/// Classify the claim state of an event from its kind:7 reactions.
///
/// Pure function over the reaction query result so the arbitration logic is
/// unit-testable without a relay. When multiple 🔒 reactions exist, the
/// EARLIEST one wins — first writer wins, and a later lock from the same or
/// another key never displaces the original holder. Our own claim only
/// shields us when no earlier foreign claim exists.
pub(crate) fn classify_claim(reactions: &[serde_json::Value], my_pubkey: &str) -> ClaimState {
    let mut locks: Vec<(&str, u64)> = reactions
        .iter()
        // Only kind:7 events are reactions; anything else in the input
        // (e.g. a kind:9 message that happens to contain the emoji) is not
        // a claim and must not read as one.
        .filter(|r| r.get("kind").and_then(|k| k.as_u64()) == Some(7))
        .filter(|r| r.get("content").and_then(|c| c.as_str()) == Some(CLAIM_EMOJI))
        .filter_map(|r| {
            let pubkey = r.get("pubkey").and_then(|p| p.as_str())?;
            // A malformed/absent created_at reads as 0 — the reaction still
            // counts as a claim, conservatively the earliest.
            let created_at = r.get("created_at").and_then(|c| c.as_u64()).unwrap_or(0);
            Some((pubkey, created_at))
        })
        .collect();
    locks.sort_by_key(|(_, at)| *at);
    match locks.first() {
        None => ClaimState::Unclaimed,
        Some((pubkey, at)) if *pubkey == my_pubkey => ClaimState::Ours,
        Some((pubkey, at)) => ClaimState::Foreign {
            pubkey: pubkey.to_string(),
            created_at: *at,
        },
    }
}

/// Claim the work attached to a message — cross-agent, first writer wins.
///
/// Queries the event's reactions; a foreign 🔒 refuses with the holder named
/// (exit 1, `already_claimed`), our own 🔒 is an idempotent success, and no
/// 🔒 publishes one. The check-then-claim window is sub-second and
/// client-side — see the command docs for the honest limits.
pub async fn cmd_claim_work(client: &BuzzClient, event_id: &str) -> Result<(), CliError> {
    validate_hex64(event_id)?;
    let my_pubkey = client.keys().public_key().to_hex();

    let filter = serde_json::json!({ "kinds": [7], "#e": [event_id] });
    let raw = client.query(&filter).await?;
    let reactions: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("failed to parse reactions query: {e}")))?;

    match classify_claim(&reactions, &my_pubkey) {
        ClaimState::Foreign { pubkey, created_at } => Err(CliError::Usage(
            serde_json::json!({
                "message": "already claimed",
                "claimed_by": pubkey,
                "claimed_at": created_at,
                "advice": "First claim wins — stand down or coordinate with the holder. A stale claim can be checked with 'buzz reactions get --event' and released by its holder with 'buzz reactions remove --emoji 🔒'.",
            })
            .to_string(),
        )),
        ClaimState::Ours => {
            println!(
                "{}",
                serde_json::json!({
                    "claimed": true,
                    "already_claimed_by_you": true,
                    "event": event_id,
                })
            );
            Ok(())
        }
        ClaimState::Unclaimed => {
            let target_eid = nostr::EventId::parse(event_id)
                .map_err(|e| CliError::Usage(format!("invalid event ID: {e}")))?;
            let builder = buzz_sdk::build_reaction(target_eid, CLAIM_EMOJI)
                .map_err(|e| CliError::Other(format!("build_reaction failed: {e}")))?;
            let event = client.sign_event(builder)?;
            let resp = client.submit_event(event).await?;
            let mut out: serde_json::Value =
                serde_json::from_str(&normalize_write_response(&resp))
                    .unwrap_or_else(|_| serde_json::json!({}));
            out["claimed"] = serde_json::json!(true);
            out["claim_emoji"] = serde_json::json!(CLAIM_EMOJI);
            out["event"] = serde_json::json!(event_id);
            println!("{out}");
            Ok(())
        }
    }
}

pub async fn cmd_edit_message(
    client: &BuzzClient,
    event_id: &str,
    content: &str,
) -> Result<(), CliError> {
    validate_hex64(event_id)?;
    validate_content_size(content)?;

    // Resolve channel_id from the event's h-tag
    let channel_uuid = resolve_channel_id(client, event_id).await?;
    let target_eid = parse_event_id(event_id)?;

    let builder = buzz_sdk::build_edit(channel_uuid, target_eid, content)
        .map_err(|e| CliError::Other(format!("build_edit failed: {e}")))?;

    let event = client.sign_event(builder)?;

    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

/// Vote on a forum post or comment.
pub async fn cmd_vote_on_post(
    client: &BuzzClient,
    event_id: &str,
    direction: &str,
) -> Result<(), CliError> {
    validate_hex64(event_id)?;
    let vote_dir = match direction {
        "up" => VoteDirection::Up,
        "down" => VoteDirection::Down,
        _ => {
            return Err(CliError::Usage(format!(
                "--direction must be 'up' or 'down' (got: {direction})"
            )))
        }
    };

    // Resolve channel_id from the event's h-tag
    let channel_uuid = resolve_channel_id(client, event_id).await?;
    let target_eid = parse_event_id(event_id)?;

    let builder = buzz_sdk::build_vote(channel_uuid, target_eid, vote_dir)
        .map_err(|e| CliError::Other(format!("build_vote failed: {e}")))?;

    let event = client.sign_event(builder)?;

    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

pub async fn dispatch(
    cmd: crate::MessagesCmd,
    client: &BuzzClient,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    use crate::MessagesCmd;
    match cmd {
        MessagesCmd::Send {
            channel,
            content,
            kind,
            reply_to,
            broadcast,
            files,
            mentions,
            supersede,
            card,
        } => {
            cmd_send_message(
                client,
                SendMessageParams {
                    channel_id: channel,
                    content: content.unwrap_or_default(),
                    kind,
                    reply_to,
                    broadcast,
                    files,
                    mentions,
                    supersede,
                    card,
                },
            )
            .await
        }
        MessagesCmd::SendDiff {
            channel,
            diff,
            repo,
            commit,
            file,
            parent_commit,
            source_branch,
            target_branch,
            pr,
            lang,
            description,
            reply_to,
        } => {
            cmd_send_diff_message(
                client,
                SendDiffParams {
                    channel_id: channel,
                    diff,
                    repo_url: repo,
                    commit_sha: commit,
                    file_path: file,
                    parent_commit_sha: parent_commit,
                    source_branch,
                    target_branch,
                    pr_number: pr,
                    language: lang,
                    description,
                    reply_to,
                },
            )
            .await
        }
        MessagesCmd::Claim { event } => cmd_claim_work(client, &event).await,
        MessagesCmd::Edit { event, content } => cmd_edit_message(client, &event, &content).await,
        MessagesCmd::Delete {
            event,
            action_id,
            reason_code,
            public_reason,
        } => {
            cmd_delete_message(
                client,
                &event,
                action_id,
                reason_code.as_deref(),
                public_reason.as_deref(),
            )
            .await
        }
        MessagesCmd::Get {
            channel,
            limit,
            before,
            since,
            kinds,
        } => {
            cmd_get_messages(
                client,
                &channel,
                limit,
                before,
                since,
                kinds.as_deref(),
                format,
            )
            .await
        }
        MessagesCmd::Thread {
            channel,
            event,
            link,
            limit,
            depth_limit,
        } => {
            let (channel, event, expected_root) =
                match link {
                    Some(link) => {
                        let parsed = crate::links::parse_message_link(&link)?;
                        (parsed.channel_id, parsed.message_id, parsed.thread_root_id)
                    }
                    None => match (channel, event) {
                        (Some(channel), Some(event)) => (channel, event, None),
                        _ => return Err(CliError::Usage(
                            "messages thread requires either --link or both --channel and --event"
                                .into(),
                        )),
                    },
                };
            cmd_get_thread(
                client,
                &channel,
                &event,
                expected_root.as_deref(),
                limit,
                depth_limit,
                format,
            )
            .await
        }
        MessagesCmd::Search {
            query,
            author,
            since,
            limit,
        } => {
            cmd_search(
                client,
                query.as_deref(),
                author.as_deref(),
                since,
                limit,
                format,
            )
            .await
        }
        MessagesCmd::Vote { event, direction } => {
            cmd_vote_on_post(client, &event, &direction).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_card_tag, card_without_mention_notice, channel_id_from_event, classify_claim,
        cmd_get_thread, event_mention_pubkeys, find_root_from_tags, match_profiles_by_name,
        merge_message_mentions, missing_members, normalize_explicit_mentions, parse_member_pubkeys,
        resolve_names_to_pubkeys, resolve_thread_target, thread_ref_from_event,
        thread_ref_from_parent_tags, BuzzClient, ClaimState, CliError, Uuid, CLAIM_EMOJI,
    };
    use buzz_sdk::mentions::{
        extract_at_mentions_with_known, extract_at_names, match_names_to_profiles, MentionProfile,
    };
    use nostr::Keys;
    use serde_json::json;

    const ID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const PUBKEY: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn lock_reaction(pubkey: &str, created_at: u64) -> serde_json::Value {
        json!({ "kind": 7, "pubkey": pubkey, "content": CLAIM_EMOJI, "created_at": created_at })
    }

    #[test]
    fn claim_unclaimed_when_no_lock_reactions() {
        // Other emoji reactions must NOT read as claims.
        let reactions = vec![
            json!({ "kind": 7, "pubkey": PUBKEY, "content": "👍", "created_at": 50 }),
            json!({ "kind": 9, "pubkey": PUBKEY, "content": CLAIM_EMOJI, "created_at": 60 }),
        ];
        assert_eq!(classify_claim(&reactions, "mykey"), ClaimState::Unclaimed);
    }

    #[test]
    fn claim_foreign_lock_blocks() {
        let reactions = vec![lock_reaction(PUBKEY, 100)];
        assert_eq!(
            classify_claim(&reactions, "mykey"),
            ClaimState::Foreign {
                pubkey: PUBKEY.to_string(),
                created_at: 100
            }
        );
    }

    #[test]
    fn claim_own_lock_is_idempotent_success() {
        let reactions = vec![lock_reaction("mykey", 100)];
        assert_eq!(classify_claim(&reactions, "mykey"), ClaimState::Ours);
    }

    #[test]
    fn claim_earliest_lock_wins_even_if_mine_is_earlier() {
        // Two agents raced and both published; the EARLIER one is the holder.
        // Here mine was later, so the event reads as foreign-held.
        let reactions = vec![lock_reaction("mykey", 200), lock_reaction(PUBKEY, 100)];
        assert_eq!(
            classify_claim(&reactions, "mykey"),
            ClaimState::Foreign {
                pubkey: PUBKEY.to_string(),
                created_at: 100
            }
        );
    }

    #[test]
    fn claim_earliest_lock_wins_when_mine_is_first() {
        // And symmetrically: my earlier lock makes a later foreign reaction
        // irrelevant — re-running claim reports Ours, not Foreign.
        let reactions = vec![lock_reaction(PUBKEY, 200), lock_reaction("mykey", 100)];
        assert_eq!(classify_claim(&reactions, "mykey"), ClaimState::Ours);
    }

    // ---- D-035 decision card builder ----

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
        let payload: serde_json::Value = serde_json::from_str(&tag[1]).unwrap();
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
    fn card_rejects_unknown_version_and_oversized_title() {
        let v2 = build_card_tag(r#"{"v":2,"title":"Q","options":[{"label":"A"},{"label":"B"}]}"#)
            .unwrap_err();
        assert!(v2.to_string().contains("only v=1"));
        let long = "x".repeat(121);
        let err = build_card_tag(&format!(
            r#"{{"title":"{long}","options":[{{"label":"A"}},{{"label":"B"}}]}}"#
        ))
        .unwrap_err();
        assert!(err.to_string().contains("title must be 1-120"));
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
        // The reachable fat-tag path: a legal 4000-char body plus 8
        // max-length labels serialize past the 4096-unit tag cap — this is
        // the authoring mistake the cap exists to catch (labels alone can
        // never reach it).
        let label = "y".repeat(200);
        let labels: Vec<String> = (0..8)
            .map(|_| format!("{{\"label\":\"{label}\"}}"))
            .collect();
        let fat = format!(
            r#"{{"title":"Q","body":"{}","options":[{}]}}"#,
            "b".repeat(4000),
            labels.join(",")
        );
        let err = build_card_tag(&fat).unwrap_err();
        assert!(err.to_string().contains("exceeds 4096"));
    }

    #[test]
    fn claim_missing_created_at_reads_as_epoch() {
        // A malformed reaction event still counts as a claim — the earliest
        // possible one — rather than being silently ignored.
        let reactions = vec![json!({ "kind": 7, "pubkey": PUBKEY, "content": CLAIM_EMOJI })];
        assert_eq!(
            classify_claim(&reactions, "mykey"),
            ClaimState::Foreign {
                pubkey: PUBKEY.to_string(),
                created_at: 0
            }
        );
    }

    // Three real pubkeys (lowercase 64-char hex) used by parse_member_pubkeys tests.
    // See the test's own comment on what `PublicKey::from_hex` actually validates.
    const PK_VALID_A: &str = "35c18ae273fccfaf80d629e20e7f8721b90499379addff533054acc2504c12b4";
    const PK_VALID_B: &str = "c6237ef84fa537c78dcee78efd2d4e59f728859c7f194da42ac51ededfa0be05";
    const PK_VALID_C: &str = "f4a42a97e594b77bdbd8ee35191c8b28a94a4cb871d96f32921558275421fb68";

    #[tokio::test]
    async fn contentless_channel_is_rejected_before_any_network() {
        // A channel ref with no alphanumeric content cannot be a UUID and
        // cannot be a name — rejected locally, no query burned.
        let client =
            BuzzClient::new("http://127.0.0.1:1".into(), Keys::generate(), None, None).unwrap();
        let error = cmd_get_thread(
            &client,
            "###",
            ID_A,
            None,
            None,
            None,
            &crate::OutputFormat::Json,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, CliError::Usage(_)));
        assert!(!error.to_string().contains("invalid UUID"));
    }

    #[tokio::test]
    async fn name_channel_resolves_before_thread_fetch() {
        // A plausible NAME (not a UUID) is resolved against channel metadata
        // first — one metadata query, never the thread/event fetch. Against
        // an unroutable relay that surfaces as a network error, not Usage.
        let client =
            BuzzClient::new("http://127.0.0.1:1".into(), Keys::generate(), None, None).unwrap();
        let error = cmd_get_thread(
            &client,
            "not-a-uuid",
            ID_A,
            None,
            None,
            None,
            &crate::OutputFormat::Json,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, CliError::Network(_)));
    }

    #[test]
    fn selected_event_derives_authoritative_channel_and_root() {
        let channel = "123e4567-e89b-12d3-a456-426614174000";
        let event = json!({
            "tags": [
                ["h", channel],
                ["e", ID_A, "", "root"],
                ["e", ID_B, "", "reply"],
            ]
        });

        assert_eq!(
            channel_id_from_event(ID_B, &event).unwrap().to_string(),
            channel
        );
        assert_eq!(
            thread_ref_from_event(ID_B, &event)
                .unwrap()
                .root_event_id
                .to_hex(),
            ID_A
        );
    }

    #[test]
    fn selected_event_requires_a_valid_channel_tag() {
        let missing = json!({"tags": []});
        let malformed = json!({"tags": [["h", "not-a-uuid"]]});
        assert!(channel_id_from_event(ID_A, &missing).is_err());
        assert!(channel_id_from_event(ID_A, &malformed).is_err());
    }

    #[test]
    fn thread_target_rejects_wrong_channel_or_root_hint() {
        let channel = "123e4567-e89b-12d3-a456-426614174000";
        let other_channel = "123e4567-e89b-12d3-a456-426614174001";
        let selected = json!({
            "tags": [["h", channel], ["e", ID_A, "", "root"], ["e", ID_B, "", "reply"]]
        });

        assert!(resolve_thread_target(
            Uuid::parse_str(other_channel).unwrap(),
            ID_B,
            Some(ID_A),
            &selected,
        )
        .is_err());
        assert!(resolve_thread_target(
            Uuid::parse_str(channel).unwrap(),
            ID_B,
            Some(ID_B),
            &selected,
        )
        .is_err());
        assert_eq!(
            resolve_thread_target(
                Uuid::parse_str(channel).unwrap(),
                ID_B,
                Some(ID_A),
                &selected,
            )
            .unwrap(),
            ID_A
        );
    }

    #[test]
    fn root_marker_wins_over_reply_marker() {
        let tags = json!([
            ["e", ID_A, "", "root"],
            ["e", ID_B, "", "reply"],
            ["p", PUBKEY],
        ]);
        assert_eq!(find_root_from_tags(&tags).as_deref(), Some(ID_A));
    }

    #[test]
    fn root_marker_without_reply_is_top_level() {
        let tags = json!([["e", ID_A, "", "root"], ["p", PUBKEY],]);
        assert!(find_root_from_tags(&tags).is_none());
    }

    #[test]
    fn root_only_parent_starts_cli_reply_thread_at_parent() {
        let tags = json!([["e", ID_A, "", "root"]]);
        let parent = nostr::EventId::from_hex(ID_B).expect("valid parent id");

        let thread_ref = thread_ref_from_parent_tags(parent, ID_B, &tags).expect("thread ref");

        assert_eq!(thread_ref.parent_event_id, parent);
        assert_eq!(thread_ref.root_event_id, parent);
    }

    #[test]
    fn reply_only_falls_back_to_reply_target() {
        // Direct reply to a top-level message — the parent's only e-tag is a
        // "reply" marker pointing at it; treat the reply target as the root.
        let tags = json!([["e", ID_B, "", "reply"], ["p", PUBKEY],]);
        assert_eq!(find_root_from_tags(&tags).as_deref(), Some(ID_B));
    }

    #[test]
    fn no_thread_markers_returns_none() {
        let tags = json!([["p", PUBKEY], ["h", "channel-uuid"],]);
        assert!(find_root_from_tags(&tags).is_none());
    }

    #[test]
    fn unmarked_e_tag_ignored() {
        // NIP-10 deprecated positional markers; ignore e-tags lacking an
        // explicit "root"/"reply" marker rather than guessing.
        let tags = json!([["e", ID_A], ["e", ID_B, ""],]);
        assert!(find_root_from_tags(&tags).is_none());
    }

    #[test]
    fn malformed_tags_are_skipped_and_root_only_is_top_level() {
        // Invalid entries are ignored, leaving a valid root-only marker; the
        // shared collapse rule still classifies that parent as top-level.
        let tags = json!([
            "not-an-array",
            ["e"],
            ["e", "short"],
            ["e", ID_A, "", "root"],
        ]);
        assert!(find_root_from_tags(&tags).is_none());
    }

    #[test]
    fn malformed_marker_id_is_ignored() {
        // Parent event has a "root" marker whose value isn't a valid 64-hex
        // event id (other-client bug, relay-accepted). Treat the marker as
        // absent so the caller falls back to root == parent rather than
        // failing to send the reply.
        let tags = json!([["e", "not-a-valid-id", "", "root"], ["p", PUBKEY],]);
        assert!(find_root_from_tags(&tags).is_none());
    }

    #[test]
    fn malformed_root_does_not_shadow_valid_reply() {
        // If "root" is malformed but "reply" is valid, fall back to "reply".
        let tags = json!([["e", "garbage", "", "root"], ["e", ID_B, "", "reply"],]);
        assert_eq!(find_root_from_tags(&tags).as_deref(), Some(ID_B));
    }

    #[test]
    fn non_array_input_returns_none() {
        assert!(find_root_from_tags(&json!({})).is_none());
        assert!(find_root_from_tags(&json!(null)).is_none());
    }

    //
    // These tests don't hit the network — they prove that *given* the
    // events the relay returns, the CLI's parse + match wiring produces
    // the right pubkeys. The async I/O wrapper around them is one
    // straight line; the pure stages it composes are exercised here and
    // in buzz-sdk.

    /// End-to-end (sans I/O): body text → extracted names → matched
    /// member pubkeys, using realistic 39002 + kind:0 event JSON.
    /// This is the regression guard for the previous stub that always
    /// returned `vec![]`.
    #[test]
    fn cli_pipeline_resolves_body_at_names_to_member_pubkeys() {
        // kind 39002 channel-members event with three members.
        let members_event = json!({
            "kind": 39002,
            "tags": [
                ["d", "00000000-0000-0000-0000-000000000000"],
                ["p", PK_VALID_A, "", "member"],
                ["p", PK_VALID_B, "", "member"],
                ["p", PK_VALID_C, "", "member"],
            ],
            "content": "",
        });
        assert_eq!(
            parse_member_pubkeys(&members_event),
            vec![PK_VALID_A, PK_VALID_B, PK_VALID_C]
        );

        // Three kind:0 profile events.
        let entries = vec![
            MentionProfile {
                pubkey: PK_VALID_A,
                content_json: r#"{"display_name":"Alice"}"#,
            },
            MentionProfile {
                pubkey: PK_VALID_B,
                content_json: r#"{"display_name":"Bob"}"#,
            },
            MentionProfile {
                pubkey: PK_VALID_C,
                content_json: r#"{"name":"Carol"}"#,
            },
        ];

        // Body mentions Alice and Carol (display_name fallback to `name`).
        let names = extract_at_names("hello @alice and @CAROL");
        let resolved = match_names_to_profiles(&names, &entries);
        assert_eq!(resolved, vec![PK_VALID_A, PK_VALID_C]);
    }

    #[test]
    fn cli_pipeline_resolves_multiword_display_names() {
        let profile_events: Vec<serde_json::Value> = vec![
            json!({
                "pubkey": PK_VALID_A,
                "content": r#"{"display_name":"Will Pfleger"}"#,
            }),
            json!({
                "pubkey": PK_VALID_B,
                "content": r#"{"display_name":"Alice"}"#,
            }),
        ];

        // Simulate the single-parse pipeline from resolve_content_mentions.
        let mut name_to_pubkeys: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let mut display_names: Vec<String> = Vec::new();
        for e in &profile_events {
            let pubkey = e.get("pubkey").unwrap().as_str().unwrap();
            let content_json = e.get("content").unwrap().as_str().unwrap();
            let v: serde_json::Value = serde_json::from_str(content_json).unwrap();
            let name = v
                .get("display_name")
                .or_else(|| v.get("name"))
                .and_then(|n| n.as_str())
                .filter(|n| !n.is_empty())
                .unwrap();
            let lower = name.to_ascii_lowercase();
            name_to_pubkeys
                .entry(lower)
                .or_default()
                .push(pubkey.to_string());
            display_names.push(name.to_string());
        }

        let known_refs: Vec<&str> = display_names.iter().map(|s| s.as_str()).collect();
        let names = extract_at_mentions_with_known("hey @Will Pfleger and @alice!", &known_refs);
        assert_eq!(names, vec!["will pfleger", "alice"]);

        let resolved: Vec<String> = names
            .iter()
            .flat_map(|n| name_to_pubkeys.get(n).into_iter().flatten())
            .cloned()
            .collect();
        assert_eq!(resolved, vec![PK_VALID_A, PK_VALID_B]);
    }

    #[test]
    fn cli_pipeline_returns_empty_when_no_at_names() {
        // Sanity: no `@names` in body → no profile match attempt needed.
        let names = extract_at_names("plain message, no mentions");
        assert!(names.is_empty());
    }

    #[test]
    fn parse_member_pubkeys_ignores_non_p_tags() {
        let event = json!({
            "tags": [
                ["d", "channel-id"],
                ["p", PK_VALID_A],
                ["h", "channel-id"],
                ["e", "some-event"],
                ["p", PK_VALID_B, "wss://relay", "member"],
            ],
        });
        assert_eq!(parse_member_pubkeys(&event), vec![PK_VALID_A, PK_VALID_B]);
    }

    #[test]
    fn parse_member_pubkeys_handles_malformed_event() {
        assert!(parse_member_pubkeys(&json!({})).is_empty());
        assert!(parse_member_pubkeys(&json!({"tags": "not an array"})).is_empty());
        assert!(parse_member_pubkeys(&json!({"tags": [["p"]]})).is_empty());
    }

    #[test]
    fn parse_member_pubkeys_filters_invalid_hex() {
        // `PublicKey::from_hex` rejects non-hex and wrong-length inputs and
        // canonicalizes hex case. (Note: it accepts any 64-char x-only hex
        // whose integer value is in field; it does not verify the point is
        // actually on the curve — same as MCP's behavior.)
        let pk_uppercase: String = PK_VALID_A.to_ascii_uppercase();
        let event = json!({
            "tags": [
                ["p", PK_VALID_A],       // valid, lowercase
                ["p", pk_uppercase],     // valid hex, canonicalized to lowercase
                ["p", "too-short"],      // length fail
                ["p", "z".repeat(64)],   // non-hex chars
                ["p", "a".repeat(63)],   // off-by-one length
            ],
        });
        assert_eq!(parse_member_pubkeys(&event), vec![PK_VALID_A, PK_VALID_A]);
    }

    #[test]
    fn explicit_mentions_accept_hex_and_npub_and_deduplicate() {
        use nostr::ToBech32;
        let npub = nostr::PublicKey::from_hex(PK_VALID_A)
            .unwrap()
            .to_bech32()
            .unwrap();
        assert_eq!(
            normalize_explicit_mentions(&[PK_VALID_A.into(), npub]).unwrap(),
            vec![PK_VALID_A]
        );
        assert!(normalize_explicit_mentions(&["not-a-key".into()]).is_err());
    }

    #[test]
    fn explicit_mentions_authorize_presentation_text_without_name_resolution() {
        let names = vec!["renamed user".into()];
        let profiles = std::collections::HashMap::new();
        assert_eq!(
            resolve_names_to_pubkeys(&names, &profiles, true).unwrap(),
            Vec::<String>::new()
        );
        assert!(resolve_names_to_pubkeys(&names, &profiles, false).is_err());
    }

    #[test]
    fn explicit_mentions_authorize_ambiguous_presentation_text() {
        let names = vec!["alice".into()];
        let profiles = std::collections::HashMap::from([(
            "alice".into(),
            vec![PK_VALID_A.into(), PK_VALID_B.into()],
        )]);
        assert_eq!(
            resolve_names_to_pubkeys(&names, &profiles, true).unwrap(),
            Vec::<String>::new()
        );
        let error = resolve_names_to_pubkeys(&names, &profiles, false).unwrap_err();
        assert!(error.to_string().contains(PK_VALID_A));
        assert!(error.to_string().contains(PK_VALID_B));
    }

    #[test]
    fn explicit_mentions_make_all_at_names_presentation_only() {
        let names = vec!["alice".into(), "bob".into()];
        let profiles = std::collections::HashMap::from([("alice".into(), vec![PK_VALID_A.into()])]);
        assert_eq!(
            resolve_names_to_pubkeys(&names, &profiles, true).unwrap(),
            vec![PK_VALID_A]
        );
        assert!(resolve_names_to_pubkeys(&names, &profiles, false).is_err());
    }

    #[test]
    fn combined_mention_union_errors_instead_of_truncating() {
        let explicit: Vec<String> = (0..50).map(|i| format!("explicit-{i}")).collect();
        assert!(merge_message_mentions(&explicit, &[], &["resolved-bob".into()]).is_err());

        let mut with_duplicate = explicit.clone();
        with_duplicate.push(explicit[0].clone());
        assert_eq!(
            merge_message_mentions(&with_duplicate, &[explicit[1].clone()], &[])
                .unwrap()
                .len(),
            50
        );
    }

    #[test]
    fn membership_preflight_lists_only_missing_mentions() {
        assert_eq!(
            missing_members(
                &[PK_VALID_A.into(), PK_VALID_B.into()],
                &[PK_VALID_A.into()]
            ),
            vec![PK_VALID_B]
        );
    }

    #[test]
    fn mention_evidence_comes_from_signed_event_tags() {
        use nostr::{EventBuilder, Keys, Tag};
        let event = EventBuilder::text_note("hello")
            .tags(vec![Tag::parse(["p", PK_VALID_A]).unwrap()])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(event_mention_pubkeys(&event), vec![PK_VALID_A]);
    }

    // ---- match_profiles_by_name (author resolution for `messages search --author`) ----

    fn profile_event(
        pubkey: &str,
        display_name: Option<&str>,
        name: Option<&str>,
    ) -> serde_json::Value {
        let mut content = serde_json::Map::new();
        if let Some(d) = display_name {
            content.insert("display_name".into(), json!(d));
        }
        if let Some(n) = name {
            content.insert("name".into(), json!(n));
        }
        json!({
            "pubkey": pubkey,
            "content": serde_json::Value::Object(content).to_string(),
        })
    }

    #[test]
    fn author_name_match_is_exact_case_insensitive() {
        let events = vec![
            profile_event(PK_VALID_A, Some("Aaron"), Some("aaron")),
            // Substring only — NIP-50 may return it, but it must not match.
            profile_event(PK_VALID_B, Some("Aaronson"), None),
        ];
        let matches = match_profiles_by_name(&events, "aArOn");
        assert_eq!(matches, vec![(PK_VALID_A.to_string(), "Aaron".to_string())]);
    }

    #[test]
    fn author_name_ambiguity_returns_all_candidates() {
        let events = vec![
            profile_event(PK_VALID_A, Some("Sam"), None),
            profile_event(PK_VALID_B, None, Some("sam")),
        ];
        let matches = match_profiles_by_name(&events, "sam");
        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn author_name_no_match_and_malformed_content() {
        let events = vec![
            profile_event(PK_VALID_A, Some("Aaron"), None),
            json!({"pubkey": PK_VALID_B, "content": "not-json"}),
            json!({"content": "{}"}), // missing pubkey
        ];
        assert!(match_profiles_by_name(&events, "Zoe").is_empty());
    }

    #[test]
    fn author_name_dedups_replaceable_event_copies() {
        // Same (pubkey, name) appearing twice (e.g. duplicate kind:0 rows)
        // must resolve unambiguously.
        let events = vec![
            profile_event(PK_VALID_A, Some("Aaron"), None),
            profile_event(PK_VALID_A, Some("Aaron"), None),
        ];
        assert_eq!(match_profiles_by_name(&events, "Aaron").len(), 1);
    }
}
