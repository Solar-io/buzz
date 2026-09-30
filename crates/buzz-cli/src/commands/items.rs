//! `buzz items` — bug and backlog items (kind 30623).
//!
//! Items are multi-writer: every editor publishes their own addressable head
//! and readers fold heads by `(h, d)` (see `buzz_core::item`). Two rules
//! follow from that and are load-bearing here:
//!
//! - **Fold before filter.** Relay queries only narrow by `kinds`, `#h` and
//!   `#d`, never by a mutable field (owner, status, type): a `#p` query would
//!   miss the newer head that reassigned an item and report stale ownership.
//! - **Read-modify-write copies identity forward.** A mutation folds the
//!   current heads, patches the winner, and publishes a new head that keeps
//!   `h`, `created`, `reporter` and `e`, with `created_at` strictly after the
//!   winner's so it supersedes what was read.

use buzz_core::item::{fold_items, ItemHead, ITEM_STATUSES};
use buzz_core::kind::{KIND_ITEM, KIND_PROJECT};
use buzz_sdk::{build_item, new_item_id, next_created_at, ItemDraft};
use nostr::{Event, Timestamp};
use uuid::Uuid;

use crate::channel_ref::resolve_channel_uuid;
use crate::client::BuzzClient;
use crate::commands::messages::{fetch_event, fetch_member_pubkeys, resolve_author};
use crate::commands::parse_write_response;
use crate::error::CliError;
use crate::validate::{read_or_stdin, sdk_err};
use crate::ItemsCmd;

/// Minimum id-prefix length accepted on the command line.
const MIN_PREFIX_LEN: usize = 4;
/// Length of the display id (`short` in JSON output).
const SHORT_ID_LEN: usize = 5;

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/// Owner filter for `items list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OwnerFilter {
    /// Items owned by this pubkey (hex).
    Pubkey(String),
    /// Items with no owner.
    Unassigned,
}

/// Post-fold filter for `items list`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ListFilter {
    /// Allowed statuses; `None` means every status.
    pub statuses: Option<Vec<String>>,
    pub item_type: Option<String>,
    pub owner: Option<OwnerFilter>,
    pub channel: Option<String>,
    pub project: Option<String>,
    pub limit: Option<usize>,
}

fn project_matches(head: &ItemHead, needle: &str) -> bool {
    let needle_lc = needle.to_lowercase();
    head.project_coordinate.as_deref() == Some(needle)
        || head
            .project_name
            .as_deref()
            .is_some_and(|n| n.to_lowercase() == needle_lc)
        || head
            .project_coordinate
            .as_deref()
            .and_then(|c| c.splitn(3, ':').nth(2))
            .is_some_and(|d| d == needle)
}

/// Fold `events`, then filter and limit. Folding first is the point: a filter
/// on a mutable field must see only the current head of each item.
pub(crate) fn select_items(events: &[Event], filter: &ListFilter) -> Vec<ItemHead> {
    let mut items: Vec<ItemHead> = fold_items(events)
        .into_iter()
        .filter(|h| {
            filter
                .statuses
                .as_ref()
                .is_none_or(|s| s.iter().any(|v| v == &h.status))
        })
        .filter(|h| filter.item_type.as_ref().is_none_or(|t| t == &h.item_type))
        .filter(|h| match &filter.owner {
            None => true,
            Some(OwnerFilter::Unassigned) => h.owner.is_none(),
            Some(OwnerFilter::Pubkey(pk)) => h.owner.as_deref() == Some(pk.as_str()),
        })
        .filter(|h| {
            filter
                .channel
                .as_ref()
                .is_none_or(|c| h.channel_id.as_deref() == Some(c.as_str()))
        })
        .filter(|h| {
            filter
                .project
                .as_ref()
                .is_none_or(|p| project_matches(h, p))
        })
        .collect();
    // fold_items already sorts newest updated_at first.
    if let Some(limit) = filter.limit {
        items.truncate(limit);
    }
    items
}

fn describe(head: &ItemHead) -> String {
    format!(
        "{} ({}, channel {})",
        head.id,
        head.title,
        head.channel_id.as_deref().unwrap_or("global")
    )
}

/// Resolve an id or unique id prefix (≥ 4 chars) against folded items.
/// Unknown or ambiguous prefixes are usage errors (exit 1) naming candidates.
pub(crate) fn resolve_prefix<'a>(
    items: &'a [ItemHead],
    prefix: &str,
) -> Result<&'a ItemHead, CliError> {
    let prefix = prefix.trim().trim_start_matches('#').to_lowercase();
    if prefix.len() < MIN_PREFIX_LEN {
        return Err(CliError::Usage(format!(
            "item id must be at least {MIN_PREFIX_LEN} characters"
        )));
    }
    let matches: Vec<&ItemHead> = items.iter().filter(|h| h.id.starts_with(&prefix)).collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] => Err(CliError::Usage(format!("no item matches id {prefix:?}"))),
        many => Err(CliError::Usage(format!(
            "item id {prefix:?} is ambiguous — matches: {}",
            many.iter()
                .map(|h| describe(h))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// A partial update to an item. `None` leaves a field unchanged.
#[derive(Debug, Clone, Default)]
pub(crate) struct ItemPatch {
    pub title: Option<String>,
    /// `Some(None)` clears the summary.
    pub summary: Option<Option<String>>,
    pub body: Option<String>,
    pub item_type: Option<String>,
    pub status: Option<String>,
    /// `Some(None)` clears the owner.
    pub owner: Option<Option<String>>,
    /// `Some((None, None))` clears the project.
    pub project: Option<(Option<String>, Option<String>)>,
}

/// Build the draft for a new head: the winner's state with `patch` applied.
/// Identity (`d`, `h`, `created`, `reporter`, `e`) is always copied forward.
pub(crate) fn patched_draft(head: &ItemHead, patch: &ItemPatch) -> Result<ItemDraft, CliError> {
    let channel = head
        .channel_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| CliError::Other(format!("item {} has a malformed h tag", head.id)))?;
    let (project_coord, project_name) = match &patch.project {
        Some(p) => p.clone(),
        None => (head.project_coordinate.clone(), head.project_name.clone()),
    };
    Ok(ItemDraft {
        d: head.id.clone(),
        channel,
        item_type: patch
            .item_type
            .clone()
            .unwrap_or_else(|| head.item_type.clone()),
        status: patch.status.clone().unwrap_or_else(|| head.status.clone()),
        title: patch.title.clone().unwrap_or_else(|| head.title.clone()),
        summary: patch
            .summary
            .clone()
            .unwrap_or_else(|| head.summary.clone()),
        body: patch.body.clone().unwrap_or_else(|| head.body.clone()),
        created: head.created,
        reporter: head.reporter.clone(),
        owner: patch.owner.clone().unwrap_or_else(|| head.owner.clone()),
        source_event: head.source_event_id.clone(),
        project_coord,
        project_name,
    })
}

/// JSON shape of one item (see phase-5.md "JSON output").
pub(crate) fn item_json(head: &ItemHead) -> serde_json::Value {
    serde_json::json!({
        "id": head.id,
        "short": head.id.chars().take(SHORT_ID_LEN).collect::<String>(),
        "type": head.item_type,
        "status": head.status,
        "title": head.title,
        "summary": head.summary,
        "body": head.body,
        "channel_id": head.channel_id,
        "source_event_id": head.source_event_id,
        "project": {
            "coordinate": head.project_coordinate,
            "name": head.project_name,
        },
        "owner": head.owner,
        "reporter": head.reporter,
        "created": head.created,
        "updated_at": head.updated_at,
        "updated_by": head.updated_by,
        "event_id": head.event_id,
        "coordinate": format!("{KIND_ITEM}:{}:{}", head.updated_by, head.id),
    })
}

fn parse_statuses(arg: Option<&str>) -> Result<Option<Vec<String>>, CliError> {
    match arg.map(str::trim) {
        None => Ok(Some(
            ITEM_STATUSES
                .iter()
                .filter(|s| **s != "done")
                .map(|s| s.to_string())
                .collect(),
        )),
        Some("all") => Ok(None),
        Some(csv) => {
            let mut out = Vec::new();
            for s in csv.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                if !ITEM_STATUSES.contains(&s) {
                    return Err(CliError::Usage(format!(
                        "unknown status {s:?} — use open, progress, needs-you, done or all"
                    )));
                }
                out.push(s.to_string());
            }
            if out.is_empty() {
                return Err(CliError::Usage("--status cannot be empty".into()));
            }
            Ok(Some(out))
        }
    }
}

// ── Relay I/O ─────────────────────────────────────────────────────────────────

fn parse_events(values: Vec<serde_json::Value>) -> Vec<Event> {
    values
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Event>(v).ok())
        .collect()
}

/// Fetch every item head visible to the caller, optionally narrowed to one
/// channel (`#h`) or one id (`#d`). Never narrows by a mutable field.
async fn fetch_heads(
    client: &BuzzClient,
    channel: Option<&Uuid>,
    d: Option<&str>,
) -> Result<Vec<Event>, CliError> {
    let mut filter = serde_json::json!({ "kinds": [KIND_ITEM] });
    if let Some(ch) = channel {
        filter["#h"] = serde_json::json!([ch.to_string()]);
    }
    if let Some(d) = d {
        filter["#d"] = serde_json::json!([d]);
    }
    Ok(parse_events(client.query_all(filter).await?))
}

/// Resolve an id/prefix to the current folded head.
async fn resolve_item(client: &BuzzClient, id: &str) -> Result<ItemHead, CliError> {
    let id_lc = id.trim().trim_start_matches('#').to_lowercase();
    let exact = buzz_core::item::is_valid_item_id(&id_lc);
    let events = fetch_heads(client, None, exact.then_some(id_lc.as_str())).await?;
    let items = fold_items(&events);
    resolve_prefix(&items, &id_lc).cloned()
}

/// Resolve `me|hex|npub|name` to a hex pubkey.
async fn resolve_person(client: &BuzzClient, who: &str) -> Result<String, CliError> {
    if who.trim().eq_ignore_ascii_case("me") {
        return Ok(client.keys().public_key().to_hex());
    }
    resolve_author(client, who).await
}

/// `true` if kind:39000 channel metadata marks the channel open. The relay
/// tags every channel `["public"]` or `["private"]`; anything else (missing
/// metadata, a `private` tag) is treated as private so the check fails closed.
pub(crate) fn metadata_is_open(metadata: Option<&serde_json::Value>) -> bool {
    let Some(tags) = metadata
        .and_then(|m| m.get("tags"))
        .and_then(|t| t.as_array())
    else {
        return false;
    };
    let has = |name: &str| {
        tags.iter()
            .any(|t| t.get(0).and_then(|v| v.as_str()) == Some(name))
    };
    has("public") && !has("private")
}

/// The relay's read rule for an h-scoped item: an open channel is readable by
/// every relay member; a private channel (or DM) only by its members.
pub(crate) fn can_read_channel(open: bool, members: &[String], pubkey: &str) -> bool {
    open || members.iter().any(|m| m == pubkey)
}

/// Refuse an owner who cannot read the item's channel. Global items and
/// items in open channels are readable by every relay member, so only a
/// private channel's membership is checked.
async fn ensure_can_see(
    client: &BuzzClient,
    channel: Option<&str>,
    pubkey: &str,
) -> Result<(), CliError> {
    let Some(channel) = channel else {
        return Ok(());
    };
    let meta_filter = serde_json::json!({ "kinds": [39000], "#d": [channel], "limit": 1 });
    let metadata = client
        .query(&meta_filter)
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok())
        .and_then(|events| events.into_iter().next());
    let open = metadata_is_open(metadata.as_ref());
    let members = if open {
        Vec::new()
    } else {
        let filter = serde_json::json!({ "kinds": [39002], "#d": [channel], "limit": 1 });
        fetch_member_pubkeys(client, &filter).await.ok_or_else(|| {
            CliError::Other(format!("could not load members of channel {channel}"))
        })?
    };
    if can_read_channel(open, &members, pubkey) {
        Ok(())
    } else {
        Err(CliError::Usage(format!(
            "assignee cannot see this item: {pubkey} is not a member of private channel {channel}"
        )))
    }
}

/// Resolve `--project` to `(coordinate, name)`. A visible 30621 head matched
/// by `d` or name sets both; anything else becomes a bare label.
async fn resolve_project(
    client: &BuzzClient,
    arg: &str,
) -> Result<(Option<String>, Option<String>), CliError> {
    let arg = arg.trim();
    if arg.eq_ignore_ascii_case("none") {
        return Ok((None, None));
    }
    let events = parse_events(
        client
            .query_all(serde_json::json!({ "kinds": [KIND_PROJECT] }))
            .await?,
    );
    let tag = |e: &Event, name: &str| {
        e.tags.iter().find_map(|t| {
            let s = t.as_slice();
            (s.first().map(String::as_str) == Some(name))
                .then(|| s.get(1).cloned())
                .flatten()
        })
    };
    let arg_lc = arg.to_lowercase();
    let mut matches: Vec<(String, String)> = Vec::new();
    for e in &events {
        let Some(d) = tag(e, "d") else { continue };
        let coord = format!("{KIND_PROJECT}:{}:{d}", e.pubkey.to_hex());
        let name = tag(e, "name").unwrap_or_else(|| d.clone());
        let hit = coord == arg || d == arg || name.to_lowercase() == arg_lc;
        if hit && !matches.iter().any(|(c, _)| c == &coord) {
            matches.push((coord, name));
        }
    }
    match matches.len() {
        1 => {
            let (coord, name) = matches.remove(0);
            Ok((Some(coord), Some(name)))
        }
        0 => {
            if arg.starts_with("30621:") {
                // A coordinate we cannot see is still a well-formed reference.
                return Ok((Some(arg.to_string()), None));
            }
            eprintln!("note: no project {arg:?} found — recording it as a label only");
            Ok((None, Some(arg.to_string())))
        }
        _ => Err(CliError::Usage(format!(
            "project {arg:?} is ambiguous — matches: {}",
            matches
                .iter()
                .map(|(c, n)| format!("{n} ({c})"))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// Sign, submit and print one head. A stale replacement (relay `duplicate:`)
/// is a conflict, exit 5.
async fn publish(
    client: &BuzzClient,
    draft: &ItemDraft,
    created_at: Timestamp,
) -> Result<(), CliError> {
    let builder = build_item(draft, created_at).map_err(sdk_err)?;
    let event = client.sign_event(builder)?;
    let head = ItemHead::from_event(&event)
        .ok_or_else(|| CliError::Other("built item failed validation".into()))?;
    let raw = client.submit_event(event).await?;
    let response = parse_write_response(
        &raw,
        "item changed concurrently (a newer head exists); re-read and retry",
    )?;
    let mut out = item_json(&head);
    if let Ok(serde_json::Value::Object(fields)) =
        serde_json::from_str::<serde_json::Value>(&response)
    {
        for (k, v) in fields {
            out[k] = v;
        }
    }
    println!("{out}");
    Ok(())
}

async fn mutate(client: &BuzzClient, id: &str, patch: ItemPatch) -> Result<(), CliError> {
    let head = resolve_item(client, id).await?;
    if let Some(Some(owner)) = &patch.owner {
        ensure_can_see(client, head.channel_id.as_deref(), owner).await?;
    }
    let draft = patched_draft(&head, &patch)?;
    let created_at = next_created_at(Some(Timestamp::from(head.updated_at)));
    publish(client, &draft, created_at).await
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/// Dispatch a `buzz items` subcommand.
pub async fn dispatch(cmd: ItemsCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        ItemsCmd::Add {
            item_type,
            title,
            summary,
            body,
            from_event,
            channel,
            project,
            owner,
            status,
        } => {
            let mut h: Option<Uuid> = None;
            let mut source_event = None;
            if let Some(ev_id) = from_event {
                let ev_id = ev_id.trim().to_lowercase();
                crate::validate::validate_hex64(&ev_id)?;
                let ev = fetch_event(client, &ev_id).await?;
                h = source_channel(&ev)?;
                source_event = Some(ev_id);
            }
            if let Some(ch) = channel {
                let ch = resolve_channel_uuid(client, &ch).await?;
                match h {
                    Some(existing) if existing != ch => {
                        return Err(CliError::Usage(format!(
                            "--channel {ch} differs from the --from-event message's channel \
                             {existing}; pass one or the other"
                        )))
                    }
                    Some(_) => {}
                    None if source_event.is_some() => {
                        return Err(CliError::Usage(
                            "--from-event message has no channel; drop --channel or pick \
                             a channel message"
                                .into(),
                        ))
                    }
                    None => h = Some(ch),
                }
            }
            let owner = match owner {
                Some(o) if o.trim().eq_ignore_ascii_case("none") => None,
                Some(o) => {
                    let pk = resolve_person(client, &o).await?;
                    ensure_can_see(client, h.map(|u| u.to_string()).as_deref(), &pk).await?;
                    Some(pk)
                }
                None => None,
            };
            let (project_coord, project_name) = match project {
                Some(p) => resolve_project(client, &p).await?,
                None => (None, None),
            };
            let now = Timestamp::now();
            let draft = ItemDraft {
                d: new_item_id(),
                channel: h,
                item_type,
                status,
                title,
                summary,
                body: body
                    .as_deref()
                    .map(read_or_stdin)
                    .transpose()?
                    .unwrap_or_default(),
                created: now.as_secs(),
                reporter: client.keys().public_key().to_hex(),
                owner,
                source_event,
                project_coord,
                project_name,
            };
            publish(client, &draft, now).await
        }
        ItemsCmd::List {
            status,
            item_type,
            owner,
            channel,
            project,
            limit,
        } => {
            let channel = match channel {
                Some(c) => Some(resolve_channel_uuid(client, &c).await?),
                None => None,
            };
            let owner = match owner {
                Some(o) if o.trim().eq_ignore_ascii_case("none") => Some(OwnerFilter::Unassigned),
                Some(o) => Some(OwnerFilter::Pubkey(resolve_person(client, &o).await?)),
                None => None,
            };
            let filter = ListFilter {
                statuses: parse_statuses(status.as_deref())?,
                item_type,
                owner,
                channel: channel.map(|c| c.to_string()),
                project,
                limit,
            };
            let events = fetch_heads(client, channel.as_ref(), None).await?;
            let items: Vec<serde_json::Value> = select_items(&events, &filter)
                .iter()
                .map(item_json)
                .collect();
            println!("{}", serde_json::Value::Array(items));
            Ok(())
        }
        ItemsCmd::Get { id } => {
            let head = resolve_item(client, &id).await?;
            println!("{}", item_json(&head));
            Ok(())
        }
        ItemsCmd::Update {
            id,
            title,
            summary,
            body,
            item_type,
            status,
            project,
        } => {
            let project = match project {
                Some(p) => Some(resolve_project(client, &p).await?),
                None => None,
            };
            let patch = ItemPatch {
                title,
                summary: summary.map(|s| (!s.trim().is_empty()).then_some(s)),
                body: body.as_deref().map(read_or_stdin).transpose()?,
                item_type,
                status,
                owner: None,
                project,
            };
            if patch.title.is_none()
                && patch.summary.is_none()
                && patch.body.is_none()
                && patch.item_type.is_none()
                && patch.status.is_none()
                && patch.project.is_none()
            {
                return Err(CliError::Usage("nothing to update".into()));
            }
            mutate(client, &id, patch).await
        }
        ItemsCmd::Assign { id, assignee } => {
            let owner = if assignee.trim().eq_ignore_ascii_case("none") {
                None
            } else {
                Some(resolve_person(client, &assignee).await?)
            };
            let patch = ItemPatch {
                owner: Some(owner),
                ..ItemPatch::default()
            };
            mutate(client, &id, patch).await
        }
        ItemsCmd::Done { id } => {
            let patch = ItemPatch {
                status: Some("done".into()),
                ..ItemPatch::default()
            };
            mutate(client, &id, patch).await
        }
    }
}

/// The source message's channel (`h`), if it has one.
fn source_channel(event: &serde_json::Value) -> Result<Option<Uuid>, CliError> {
    let h = event
        .get("tags")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_array())
        .find(|t| t.first().and_then(|v| v.as_str()) == Some("h"))
        .and_then(|t| t.get(1))
        .and_then(|v| v.as_str());
    match h {
        None => Ok(None),
        Some(h) => Uuid::parse_str(h)
            .map(Some)
            .map_err(|_| CliError::Other(format!("source message h tag is not a UUID: {h}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    const CH: &str = "9a1657ac-f7aa-4db0-b632-d8bbeb6dfb50";

    fn head_event(
        keys: &Keys,
        d: &str,
        owner: Option<&str>,
        status: &str,
        created_at: u64,
    ) -> Event {
        let draft = ItemDraft {
            d: d.into(),
            channel: Some(Uuid::parse_str(CH).unwrap()),
            item_type: "bug".into(),
            status: status.into(),
            title: format!("item {d}"),
            summary: None,
            body: String::new(),
            created: 1_759_190_400,
            reporter: "a".repeat(64),
            owner: owner.map(str::to_string),
            source_event: Some("c".repeat(64)),
            project_coord: None,
            project_name: None,
        };
        build_item(&draft, Timestamp::from(created_at))
            .unwrap()
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn list_folds_before_filtering_by_owner() {
        let a = Keys::generate();
        let b = Keys::generate();
        let pk_a = a.public_key().to_hex();
        let pk_b = b.public_key().to_hex();
        // A files it owning it; B later reassigns it to B.
        let events = vec![
            head_event(&a, "7f3k2m9qa1bc", Some(&pk_a), "open", 1_759_190_400),
            head_event(&b, "7f3k2m9qa1bc", Some(&pk_b), "open", 1_759_190_500),
        ];
        let by_a = ListFilter {
            owner: Some(OwnerFilter::Pubkey(pk_a.clone())),
            ..ListFilter::default()
        };
        assert!(select_items(&events, &by_a).is_empty());
        let by_b = ListFilter {
            owner: Some(OwnerFilter::Pubkey(pk_b.clone())),
            ..ListFilter::default()
        };
        let got = select_items(&events, &by_b);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].owner.as_deref(), Some(pk_b.as_str()));
    }

    #[test]
    fn list_default_status_hides_done() {
        let a = Keys::generate();
        let events = vec![
            head_event(&a, "7f3k2m9qa1bc", None, "done", 1_759_190_400),
            head_event(&a, "8f3k2m9qa1bc", None, "needs-you", 1_759_190_400),
        ];
        let filter = ListFilter {
            statuses: parse_statuses(None).unwrap(),
            ..ListFilter::default()
        };
        let got = select_items(&events, &filter);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].status, "needs-you");
        assert_eq!(parse_statuses(Some("all")).unwrap(), None);
        assert!(parse_statuses(Some("closed")).is_err());
    }

    #[test]
    fn update_copies_identity_tags_forward() {
        let a = Keys::generate();
        let b = Keys::generate();
        let original = head_event(&a, "7f3k2m9qa1bc", None, "open", 1_759_190_400);
        let head = ItemHead::from_event(&original).unwrap();
        let patch = ItemPatch {
            status: Some("progress".into()),
            title: Some("renamed".into()),
            ..ItemPatch::default()
        };
        let draft = patched_draft(&head, &patch).unwrap();
        let created_at = next_created_at(Some(Timestamp::from(head.updated_at)));
        let updated = build_item(&draft, created_at)
            .unwrap()
            .sign_with_keys(&b)
            .unwrap();
        let identity = |e: &Event| -> Vec<Vec<String>> {
            e.tags
                .iter()
                .map(|t| t.as_slice().to_vec())
                .filter(|t| {
                    matches!(t[0].as_str(), "d" | "h" | "created" | "e")
                        || (t[0] == "p" && t.get(3).map(String::as_str) == Some("reporter"))
                })
                .collect()
        };
        assert_eq!(identity(&updated), identity(&original));
        assert_eq!(identity(&updated).len(), 5);
        // Hardcoded, not derived from the fixture helper.
        assert!(identity(&updated).contains(&vec!["h".to_string(), CH.to_string()]));
        assert!(identity(&updated).contains(&vec!["created".to_string(), "1759190400".to_string()]));
        let new_head = ItemHead::from_event(&updated).unwrap();
        assert_eq!(new_head.status, "progress");
        assert_eq!(new_head.title, "renamed");
        assert_eq!(new_head.reporter, "a".repeat(64));
        assert!(updated.created_at > original.created_at);
        // The two heads fold to the update.
        let folded = fold_items(&[original, updated]);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].status, "progress");
    }

    #[test]
    fn id_prefix_ambiguous_is_usage_error() {
        let a = Keys::generate();
        let events = vec![
            head_event(&a, "7f3k2m9qa1bc", None, "open", 1_759_190_400),
            head_event(&a, "7f3k2zzzzzzz", None, "open", 1_759_190_400),
        ];
        let items = fold_items(&events);
        let err = resolve_prefix(&items, "7f3k2").unwrap_err();
        assert_eq!(crate::error::exit_code(&err), 1);
        let msg = err.to_string();
        assert!(
            msg.contains("7f3k2m9qa1bc") && msg.contains("7f3k2zzzzzzz"),
            "{msg}"
        );
        assert_eq!(resolve_prefix(&items, "7f3k2m").unwrap().id, "7f3k2m9qa1bc");
        assert!(resolve_prefix(&items, "7f3").is_err());
        assert!(resolve_prefix(&items, "zzzz").is_err());
    }

    #[test]
    fn open_channel_assignee_need_not_be_member() {
        let open_meta =
            serde_json::json!({ "tags": [["d", CH], ["name", "x"], ["public"], ["closed"]] });
        let private_meta = serde_json::json!({ "tags": [["d", CH], ["private"], ["closed"]] });
        assert!(metadata_is_open(Some(&open_meta)));
        assert!(!metadata_is_open(Some(&private_meta)));
        assert!(!metadata_is_open(None), "missing metadata fails closed");

        let member = "a".repeat(64);
        let outsider = "b".repeat(64);
        let members = vec![member.clone()];
        // Open channel: any relay member can read, so assignment is allowed.
        assert!(can_read_channel(true, &[], &outsider));
        // Private channel: only members.
        assert!(can_read_channel(false, &members, &member));
        assert!(!can_read_channel(false, &members, &outsider));
    }

    #[test]
    fn item_json_shape() {
        let a = Keys::generate();
        let ev = head_event(&a, "7f3k2m9qa1bc", None, "open", 1_759_190_400);
        let v = item_json(&ItemHead::from_event(&ev).unwrap());
        assert_eq!(v["short"], "7f3k2");
        assert_eq!(v["channel_id"], CH);
        assert_eq!(v["owner"], serde_json::Value::Null);
        assert_eq!(
            v["coordinate"],
            format!("30623:{}:7f3k2m9qa1bc", a.public_key().to_hex())
        );
    }
}
