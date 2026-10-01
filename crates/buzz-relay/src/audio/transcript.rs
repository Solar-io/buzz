//! Call lines carried, live, from a voice call into its parent channel.
//!
//! A voice huddle (channel huddle or DM voice call) runs in an EPHEMERAL (ttl)
//! channel linked to its parent by a creator-signed kind:48100. Spoken turns
//! land there as kind:9 `"[voice] …"` messages signed by the speaker's client,
//! and agents reply as kind:9 in the same channel. That channel expires, and
//! nobody looking at the parent channel / DM sees the conversation happen.
//!
//! This module mirrors EACH kind:9 of the call into the parent as it lands:
//! one relay-signed kind:9 per utterance, carrying the utterance text (the
//! `[voice]` marker stripped) and attributed to its speaker:
//!
//! ```text
//! ["h", <parent>]
//! ["actor", <speaker pubkey hex>]            // delegated authorship
//! ["buzz-system", "call-line"]               // never a trigger
//! ["buzz-call-source", <source id>, <call channel>]
//! ```
//!
//! **Authorship.** The copy must be relay-signed: the speaker's own event is
//! signed over its `h` tag (the call channel), so it cannot be re-homed. The
//! `actor` tag is the existing relay-signed delegated-authorship convention
//! (`ingest::effective_message_author`, desktop `authors.ts`): clients honour
//! it ONLY on the relay's NIP-11 `self` signature, and the relay only ever
//! writes the pubkey that SIGNED the source event — an agent cannot get a line
//! attributed to Sam, because the only way to produce one is for Sam's key to
//! sign the call-room message. The source id is carried for audit.
//!
//! **No trigger loops.** `buzz-system` is relay-only at ingest, keeps the line
//! out of workflows (`handlers::event::is_relay_non_trigger_message`), and the
//! agent harness drops it before rule matching (`buzz-acp`
//! `filter::match_event`). No `p` tags are copied, so nothing is mentioned.
//!
//! **Exactly once, no end-of-call duplicate.** A line's id is deterministic —
//! same content, tags, relay key and `created_at` (the SOURCE's) — so the live
//! mirror ([`spawn_live_call_line`], from ingest) and the end-of-call flush
//! ([`flush_call_lines`], on every huddle end) produce the SAME event and the
//! insert dedupes. The flush therefore posts only lines the live path missed
//! (relay restart mid-call, a dropped spawn); it replaced the single
//! end-of-call transcript message, which would now duplicate every line.

use std::sync::Arc;

use buzz_core::kind::{
    BUZZ_SYSTEM_CALL_LINE, KIND_STREAM_MESSAGE, TAG_BUZZ_CALL_SOURCE, TAG_BUZZ_SYSTEM,
};
use buzz_core::tenant::TenantContext;
use nostr::{EventBuilder, Kind, Tag};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::state::AppState;

/// Newest call messages the end-of-call flush considers.
pub(crate) const FLUSH_MAX_MESSAGES: usize = 500;

/// Spoken-turn marker the web huddle voice mode prefixes onto user speech.
const VOICE_MARKER: &str = "[voice]";

/// Strip the leading `[voice] ` marker (and surrounding whitespace).
pub(crate) fn strip_voice_marker(content: &str) -> &str {
    let trimmed = content.trim();
    match trimmed.strip_prefix(VOICE_MARKER) {
        // The marker only counts as a whole word: `[voice]x` is left alone.
        Some(rest) if rest.is_empty() || rest.starts_with(char::is_whitespace) => rest.trim(),
        _ => trimmed,
    }
}

/// The text a call message mirrors as, or `None` when it is not a mirrorable
/// utterance: not a kind:9, authored by the relay itself, already a
/// `buzz-system` record, or empty once the `[voice]` marker is stripped.
pub(crate) fn mirrorable_text<'a>(
    relay_pubkey: &nostr::PublicKey,
    source: &'a nostr::Event,
) -> Option<&'a str> {
    if u32::from(source.kind.as_u16()) != KIND_STREAM_MESSAGE
        || source.pubkey == *relay_pubkey
        || source
            .tags
            .iter()
            .any(|t| t.as_slice().first().map(String::as_str) == Some(TAG_BUZZ_SYSTEM))
    {
        return None;
    }
    let text = strip_voice_marker(&source.content);
    (!text.is_empty()).then_some(text)
}

/// Build (and sign) the parent-channel copy of call message `source`, or
/// `None` when [`mirrorable_text`] rejects it.
///
/// Deterministic apart from the Schnorr signature: the event id depends only
/// on `(relay key, created_at = source.created_at, kind, tags, content)`.
pub(crate) fn call_line_event(
    relay_keys: &nostr::Keys,
    call_channel_id: Uuid,
    parent_channel_id: Uuid,
    source: &nostr::Event,
) -> Option<nostr::Event> {
    let text = mirrorable_text(&relay_keys.public_key(), source)?;
    let tags = [
        Tag::parse(["h", &parent_channel_id.to_string()]),
        Tag::parse(["actor", &source.pubkey.to_hex()]),
        Tag::parse([TAG_BUZZ_SYSTEM, BUZZ_SYSTEM_CALL_LINE]),
        Tag::parse([
            TAG_BUZZ_CALL_SOURCE,
            &source.id.to_hex(),
            &call_channel_id.to_string(),
        ]),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| warn!("call line: failed to build tags: {e}"))
    .ok()?;
    EventBuilder::new(Kind::from(KIND_STREAM_MESSAGE as u16), text)
        .tags(tags)
        .custom_created_at(source.created_at)
        .sign_with_keys(relay_keys)
        .map_err(|e| warn!("call line: failed to sign: {e}"))
        .ok()
}

/// Persist `event` as a top-level message of `parent_channel_id` and fan it
/// out. Returns true when it was newly inserted (false: already there, or the
/// write failed — logged).
async fn publish_call_line(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    parent_channel_id: Uuid,
    event: &nostr::Event,
) -> bool {
    let event_id_bytes = event.id.as_bytes().to_vec();
    let event_created_at = chrono::DateTime::from_timestamp(event.created_at.as_secs() as i64, 0)
        .unwrap_or_else(chrono::Utc::now);
    // Top-level (depth 0), matching the workflow SendMessage path so the
    // timeline treats it like any message.
    let thread_meta = buzz_db::event::ThreadMetadataParams {
        event_id: &event_id_bytes,
        event_created_at,
        channel_id: parent_channel_id,
        parent_event_id: None,
        parent_event_created_at: None,
        root_event_id: None,
        root_event_created_at: None,
        depth: 0,
        broadcast: false,
    };
    let (stored, inserted) = match state
        .db
        .insert_event_with_thread_metadata(
            tenant.community(),
            event,
            Some(parent_channel_id),
            Some(thread_meta),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            warn!(parent_channel_id = %parent_channel_id, "call line: persist failed: {e}");
            return false;
        }
    };
    if !inserted {
        return false;
    }
    let relay_hex = state.relay_keypair.public_key().to_hex();
    crate::handlers::event::dispatch_persistent_event(
        tenant,
        state,
        &stored,
        KIND_STREAM_MESSAGE,
        &relay_hex,
        None,
    )
    .await;
    true
}

/// Resolve the verified parent of call channel `channel` (ephemeral, linked
/// by a creator-signed kind:48100), or `None` for anything else.
async fn verified_parent(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    channel: &buzz_db::channel::ChannelRecord,
) -> Option<Uuid> {
    // Only ephemeral (ttl) huddle channels hold a call apart from the main
    // chat; a non-ephemeral huddle runs IN its channel.
    channel.ttl_seconds?;
    match state
        .db
        .find_huddle_parent_channel(tenant.community(), channel.id, &channel.created_by)
        .await
    {
        Ok(Some(parent)) if parent != channel.id => Some(parent),
        Ok(_) => None,
        Err(e) => {
            warn!(channel_id = %channel.id, "call line: parent lookup failed: {e}");
            None
        }
    }
}

/// Mirror one just-stored call message into the call's parent. Best-effort:
/// every failure is logged and swallowed. Returns the mirrored event id (hex)
/// when a NEW line was posted.
pub(crate) async fn mirror_call_line(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    channel: &buzz_db::channel::ChannelRecord,
    source: &nostr::Event,
) -> Option<String> {
    // Cheap rejection first: it needs no database read.
    mirrorable_text(&state.relay_keypair.public_key(), source)?;
    let parent = verified_parent(state, tenant, channel).await?;
    let event = call_line_event(&state.relay_keypair, channel.id, parent, source)?;
    let id = event.id.to_hex();
    publish_call_line(state, tenant, parent, &event)
        .await
        .then(|| {
            debug!(call = %channel.id, parent = %parent, event_id = %id, "call line mirrored");
            id
        })
}

/// Ingest hook: a kind:9 just landed in `channel`. When that channel is a call
/// room (ephemeral), mirror the message into the call's parent in the
/// background — the sender's OK never waits on it. Free for every other
/// channel (the row is already loaded by ingest).
pub(crate) fn spawn_live_call_line(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    channel: Option<&buzz_db::channel::ChannelRecord>,
    source: &nostr::Event,
) {
    let Some(channel) = channel else { return };
    if channel.ttl_seconds.is_none() || u32::from(source.kind.as_u16()) != KIND_STREAM_MESSAGE {
        return;
    }
    let state = Arc::clone(state);
    let tenant = tenant.clone();
    let channel = channel.clone();
    let source = source.clone();
    tokio::spawn(async move {
        mirror_call_line(&state, &tenant, &channel, &source).await;
    });
}

/// End-of-call flush: mirror every kind:9 of call channel `channel_id` into
/// `parent_channel_id` that is not there yet. Lines the live path already
/// posted dedupe on their deterministic id, so a call that flowed live posts
/// nothing here. Returns the number of NEW lines posted.
pub(crate) async fn flush_call_lines(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    channel_id: Uuid,
    parent_channel_id: Uuid,
) -> usize {
    if parent_channel_id == channel_id {
        return 0;
    }
    let query = buzz_db::EventQuery {
        channel_id: Some(channel_id),
        kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
        limit: Some(FLUSH_MAX_MESSAGES as i64),
        ..buzz_db::EventQuery::for_community(tenant.community())
    };
    let mut events = match state.db.query_events(&query).await {
        Ok(evs) => evs,
        Err(e) => {
            warn!(channel_id = %channel_id, "call flush: message query failed: {e}");
            return 0;
        }
    };
    // query_events is newest first; publish oldest first.
    events.reverse();
    let mut posted = 0usize;
    for stored in &events {
        let Some(line) = call_line_event(
            &state.relay_keypair,
            channel_id,
            parent_channel_id,
            &stored.event,
        ) else {
            continue;
        };
        if publish_call_line(state, tenant, parent_channel_id, &line).await {
            posted += 1;
        }
    }
    if posted > 0 {
        info!(
            channel_id = %channel_id,
            parent_channel_id = %parent_channel_id,
            posted,
            "huddle ended — flushed call lines the live mirror had missed"
        );
    }
    posted
}

/// [`flush_call_lines`] for `channel_id`, which the caller has JUST archived,
/// resolving its parent from the creator-signed kind:48100 link. The hook for
/// a client kind:9002 `archived=true` and the TTL reaper. A non-ephemeral
/// channel, or one with no verified huddle link, is a no-op.
pub async fn flush_call_lines_for_archived(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    channel_id: Uuid,
) -> usize {
    let channel = match state.db.get_channel(tenant.community(), channel_id).await {
        Ok(ch) => ch,
        Err(e) => {
            debug!(channel_id = %channel_id, "call flush: channel lookup failed: {e}");
            return 0;
        }
    };
    let Some(parent) = verified_parent(state, tenant, &channel).await else {
        return 0;
    };
    flush_call_lines(state, tenant, channel_id, parent).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag_value<'a>(event: &'a nostr::Event, name: &str) -> Option<&'a [String]> {
        event
            .tags
            .iter()
            .map(|t| t.as_slice())
            .find(|s| s.first().map(String::as_str) == Some(name))
    }

    fn call_msg(keys: &nostr::Keys, content: &str, secs: u64) -> nostr::Event {
        EventBuilder::new(Kind::from(9u16), content)
            .tags([Tag::parse(["h", &Uuid::new_v4().to_string()]).unwrap()])
            .custom_created_at(nostr::Timestamp::from_secs(secs))
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn strip_voice_marker_removes_only_the_leading_marker() {
        assert_eq!(strip_voice_marker("[voice] hello there"), "hello there");
        assert_eq!(strip_voice_marker("  [voice]   spaced  "), "spaced");
        assert_eq!(strip_voice_marker("plain reply"), "plain reply");
        assert_eq!(strip_voice_marker("say [voice] later"), "say [voice] later");
        assert_eq!(strip_voice_marker("[voice] "), "");
        assert_eq!(strip_voice_marker("[voice]x"), "[voice]x");
    }

    #[test]
    fn call_line_is_relay_signed_attributed_to_the_signer_and_tagged() {
        let relay = nostr::Keys::generate();
        let sam = nostr::Keys::generate();
        let (call, parent) = (Uuid::new_v4(), Uuid::new_v4());
        let src = call_msg(&sam, "[voice] which **drill**?\n\nand bits", 1_700_000_000);
        let line = call_line_event(&relay, call, parent, &src).expect("mirrored");

        line.verify().expect("valid signature");
        assert_eq!(line.pubkey, relay.public_key());
        assert_eq!(line.kind, Kind::from(9u16));
        // Same text the speaker sent (marker stripped, markdown and line
        // breaks kept — it renders like any message), same timestamp.
        assert_eq!(line.content, "which **drill**?\n\nand bits");
        assert_eq!(line.created_at, src.created_at);
        assert_eq!(tag_value(&line, "h").unwrap()[1], parent.to_string());
        assert_eq!(
            tag_value(&line, "actor").unwrap()[1],
            sam.public_key().to_hex()
        );
        assert_eq!(
            tag_value(&line, TAG_BUZZ_SYSTEM).unwrap()[1],
            BUZZ_SYSTEM_CALL_LINE
        );
        let source = tag_value(&line, TAG_BUZZ_CALL_SOURCE).unwrap();
        assert_eq!(source[1], src.id.to_hex());
        assert_eq!(source[2], call.to_string());
        assert!(tag_value(&line, "p").is_none(), "no mention is copied");
    }

    #[test]
    fn call_line_id_is_deterministic_so_live_and_flush_dedupe() {
        let relay = nostr::Keys::generate();
        let agent = nostr::Keys::generate();
        let (call, parent) = (Uuid::new_v4(), Uuid::new_v4());
        let src = call_msg(&agent, "The DeWalt 20V.", 1_700_000_001);
        let a = call_line_event(&relay, call, parent, &src).unwrap();
        let b = call_line_event(&relay, call, parent, &src).unwrap();
        assert_eq!(a.id, b.id);
    }

    #[test]
    fn call_line_skips_non_utterances() {
        let relay = nostr::Keys::generate();
        let sam = nostr::Keys::generate();
        let (call, parent) = (Uuid::new_v4(), Uuid::new_v4());
        // Empty once the marker is stripped.
        assert!(call_line_event(&relay, call, parent, &call_msg(&sam, "[voice]  ", 1)).is_none());
        // The relay's own messages are never mirrored.
        assert!(call_line_event(&relay, call, parent, &call_msg(&relay, "hi", 1)).is_none());
        // Not a kind:9.
        let reaction = EventBuilder::new(Kind::from(7u16), "+")
            .sign_with_keys(&sam)
            .unwrap();
        assert!(call_line_event(&relay, call, parent, &reaction).is_none());
        // Already a buzz-system record.
        let sys = EventBuilder::new(Kind::from(9u16), "x")
            .tags([Tag::parse([TAG_BUZZ_SYSTEM, BUZZ_SYSTEM_CALL_LINE]).unwrap()])
            .sign_with_keys(&sam)
            .unwrap();
        assert!(call_line_event(&relay, call, parent, &sys).is_none());
        // Control: an ordinary utterance IS mirrored.
        assert!(call_line_event(&relay, call, parent, &call_msg(&sam, "[voice] hi", 1)).is_some());
    }
}
