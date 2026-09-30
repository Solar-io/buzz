//! Call transcript carried back to the parent channel when a huddle ends.
//!
//! A voice huddle runs in an EPHEMERAL (ttl) channel linked to its parent by a
//! creator-signed kind:48100. Spoken turns land there as kind:9 `"[voice] …"`
//! messages and agents reply as kind:9 in the same channel. When the relay
//! ends the huddle (the exactly-once kind:48103 path in
//! `handler::archive_empty_huddle`) nothing from the call used to reach the
//! parent, and the ephemeral channel then expired — taking the conversation
//! with it. This module posts ONE relay-signed kind:9 into the parent holding
//! the whole call as `Name: text` lines, oldest first.
//!
//! It fires on EVERY huddle end, each hooked right after the archive that
//! ended it: the relay's empty-room grace timer (`archive_empty_huddle`), a
//! client kind:9002 `archived=true` (desktop/mobile end their own huddles
//! this way, after which the grace timer only sees `AlreadyEnded`), and the
//! TTL reaper (`handlers::side_effects::run_ephemeral_reaper_tick`).
//!
//! Exactly-once rides on the archive: only the caller that won the
//! `archived_at IS NULL → NOW()` transition reaches its hook. As
//! belt-and-braces the event's `created_at` is pinned to the channel's
//! `archived_at`, so a replay over the same messages produces the same event
//! id and the insert dedupes.
//!
//! The message carries `["buzz-system", "call-transcript"]`
//! ([`buzz_core::kind::TAG_BUZZ_SYSTEM`]), which the agent harness
//! (`buzz-acp` `filter::match_event`) treats as never-trigger: a transcript is
//! a record of a conversation that already happened, not a new prompt.

use std::collections::HashMap;
use std::sync::Arc;

use buzz_core::kind::{BUZZ_SYSTEM_CALL_TRANSCRIPT, KIND_STREAM_MESSAGE, TAG_BUZZ_SYSTEM};
use buzz_core::tenant::TenantContext;
use nostr::{EventBuilder, Kind, Tag, ToBech32};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::state::AppState;

/// Newest kind:9 messages considered. A call longer than this keeps its most
/// recent turns and notes that earlier ones were omitted.
pub(crate) const TRANSCRIPT_MAX_MESSAGES: usize = 500;

/// Byte budget for the rendered transcript body (header + lines). Well under
/// any relay event-size ceiling; when exceeded the OLDEST lines are dropped
/// (the end of a call — conclusions, recommendations — is what gets lost
/// otherwise) and an omission note is written under the header.
pub(crate) const TRANSCRIPT_MAX_BYTES: usize = 32 * 1024;

/// Per-line cap so one giant pasted reply cannot evict the whole call.
pub(crate) const TRANSCRIPT_MAX_LINE_BYTES: usize = 4 * 1024;

/// Spoken-turn marker the web huddle voice mode prefixes onto user speech.
const VOICE_MARKER: &str = "[voice]";

/// Separator between transcript lines. A BLANK line, not "\n": clients render
/// kind:9 content as CommonMark, where a single newline is a soft break that
/// collapses to a space — every speaker would run together in one paragraph
/// (pinned by web `channels/ui/callTranscriptRow.test.mjs`).
const LINE_SEPARATOR: &str = "\n\n";

/// One transcript line: resolved speaker label plus message text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TranscriptLine {
    pub speaker: String,
    pub text: String,
}

/// Strip the leading `[voice] ` marker (and surrounding whitespace).
pub(crate) fn strip_voice_marker(content: &str) -> &str {
    let trimmed = content.trim();
    match trimmed.strip_prefix(VOICE_MARKER) {
        // The marker only counts as a whole word: `[voice]x` is left alone.
        Some(rest) if rest.is_empty() || rest.starts_with(char::is_whitespace) => rest.trim(),
        _ => trimmed,
    }
}

/// Cap on a speaker name or channel name inside the transcript.
const TRANSCRIPT_MAX_NAME_BYTES: usize = 128;

/// Collapse every whitespace run (newlines included) to one space. Applied to
/// speaker names, the channel name and message text: all three are
/// user-controlled, and a line break in any of them would let one participant
/// forge extra `Name: text` paragraphs in the transcript.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Truncate `s` to at most `max` bytes on a char boundary, appending `…` when cut.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Render the transcript message body, or `None` when there is nothing to say.
///
/// `lines` are oldest first. `earlier_omitted` is true when the message query
/// itself hit [`TRANSCRIPT_MAX_MESSAGES`] (older turns were never fetched).
pub(crate) fn render_transcript(
    channel_name: &str,
    lines: &[TranscriptLine],
    earlier_omitted: bool,
) -> Option<String> {
    if lines.is_empty() {
        return None;
    }
    let header = format!(
        "📞 Call transcript — {}",
        truncate_bytes(&one_line(channel_name), TRANSCRIPT_MAX_NAME_BYTES)
    );
    let rendered: Vec<String> = lines
        .iter()
        .map(|l| {
            truncate_bytes(
                &format!(
                    "{}: {}",
                    truncate_bytes(&one_line(&l.speaker), TRANSCRIPT_MAX_NAME_BYTES),
                    one_line(&l.text)
                ),
                TRANSCRIPT_MAX_LINE_BYTES,
            )
        })
        .collect();

    // Keep the newest lines that fit, walking backwards. Reserve room for the
    // header and a worst-case omission note so the total stays in budget.
    let reserve = header.len() + 64;
    let budget = TRANSCRIPT_MAX_BYTES.saturating_sub(reserve);
    let mut used = 0usize;
    let mut first_kept = rendered.len();
    for (i, line) in rendered.iter().enumerate().rev() {
        let cost = line.len() + LINE_SEPARATOR.len();
        if used + cost > budget {
            break;
        }
        used += cost;
        first_kept = i;
    }
    let dropped = first_kept;

    let mut out = header;
    out.push_str(LINE_SEPARATOR);
    // When the message query itself was capped the true number of omitted
    // turns is unknown, so no count is claimed; otherwise it is exact.
    if earlier_omitted {
        out.push_str("(… earlier lines omitted)");
        out.push_str(LINE_SEPARATOR);
    } else if dropped > 0 {
        out.push_str(&format!("(… {dropped} earlier lines omitted)"));
        out.push_str(LINE_SEPARATOR);
    }
    out.push_str(&rendered[first_kept..].join(LINE_SEPARATOR));
    Some(out)
}

/// Short, human-scannable fallback label for a pubkey with no display name.
fn short_npub(pubkey: &nostr::PublicKey) -> String {
    match pubkey.to_bech32() {
        Ok(npub) => format!("{}…", &npub[..npub.len().min(12)]),
        Err(_) => {
            let hex = pubkey.to_hex();
            format!("{}…", &hex[..8])
        }
    }
}

/// Post the call transcript of ephemeral huddle `channel_id` into its verified
/// parent `parent_channel_id`. Best-effort: every failure is logged and
/// swallowed — a missing transcript must never undo or delay the huddle end.
///
/// Returns the posted event id (hex) when a transcript was published.
pub(crate) async fn emit_call_transcript(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    channel_id: Uuid,
    parent_channel_id: Uuid,
) -> Option<String> {
    // Non-ephemeral huddles run in the channel itself (lifecycle parent ==
    // channel): their messages are already in the main chat.
    if parent_channel_id == channel_id {
        return None;
    }
    let channel = match state.db.get_channel(tenant.community(), channel_id).await {
        Ok(ch) => ch,
        Err(e) => {
            warn!(channel_id = %channel_id, "call transcript: channel lookup failed: {e}");
            return None;
        }
    };
    // Only ephemeral (ttl) huddle channels expire and lose their messages.
    channel.ttl_seconds?;

    let query = buzz_db::EventQuery {
        channel_id: Some(channel_id),
        kinds: Some(vec![KIND_STREAM_MESSAGE as i32]),
        limit: Some(TRANSCRIPT_MAX_MESSAGES as i64 + 1),
        ..buzz_db::EventQuery::for_community(tenant.community())
    };
    let mut events = match state.db.query_events(&query).await {
        Ok(evs) => evs,
        Err(e) => {
            warn!(channel_id = %channel_id, "call transcript: message query failed: {e}");
            return None;
        }
    };
    let earlier_omitted = events.len() > TRANSCRIPT_MAX_MESSAGES;
    events.truncate(TRANSCRIPT_MAX_MESSAGES);
    // query_events is newest first (created_at DESC, id ASC); flip to oldest
    // first with the same deterministic tiebreak.
    events.reverse();

    // Resolve display names in one bulk read of the users table (populated
    // from kind:0 profiles); fall back to a short npub.
    let mut authors: Vec<Vec<u8>> = events
        .iter()
        .map(|e| e.event.pubkey.to_bytes().to_vec())
        .collect();
    authors.sort();
    authors.dedup();
    let names: HashMap<Vec<u8>, String> =
        match state.db.get_users_bulk(tenant.community(), &authors).await {
            Ok(users) => users
                .into_iter()
                .filter_map(|u| {
                    let name = u.display_name?.trim().to_string();
                    (!name.is_empty()).then_some((u.pubkey, name))
                })
                .collect(),
            Err(e) => {
                debug!(channel_id = %channel_id, "call transcript: name lookup failed: {e}");
                HashMap::new()
            }
        };

    let lines: Vec<TranscriptLine> = events
        .iter()
        .filter_map(|e| {
            let text = strip_voice_marker(&e.event.content);
            if text.is_empty() {
                return None;
            }
            let key = e.event.pubkey.to_bytes().to_vec();
            let speaker = names
                .get(&key)
                .cloned()
                .unwrap_or_else(|| short_npub(&e.event.pubkey));
            Some(TranscriptLine {
                speaker,
                text: text.to_string(),
            })
        })
        .collect();

    let body = render_transcript(&channel.name, &lines, earlier_omitted)?;

    let tags = match (
        Tag::parse(["h", &parent_channel_id.to_string()]),
        Tag::parse([TAG_BUZZ_SYSTEM, BUZZ_SYSTEM_CALL_TRANSCRIPT]),
    ) {
        (Ok(h), Ok(sys)) => vec![h, sys],
        (Err(e), _) | (_, Err(e)) => {
            warn!("call transcript: failed to build tags: {e}");
            return None;
        }
    };
    let created_at = channel
        .archived_at
        .map(|t| t.timestamp().max(0) as u64)
        .unwrap_or_else(|| nostr::Timestamp::now().as_secs());
    let event = match EventBuilder::new(Kind::from(KIND_STREAM_MESSAGE as u16), body)
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from_secs(created_at))
        .sign_with_keys(&state.relay_keypair)
    {
        Ok(ev) => ev,
        Err(e) => {
            warn!("call transcript: failed to sign: {e}");
            return None;
        }
    };
    let event_id_bytes = event.id.as_bytes().to_vec();
    let event_created_at =
        chrono::DateTime::from_timestamp(created_at as i64, 0).unwrap_or_else(chrono::Utc::now);

    // Persist as a top-level (depth 0) channel message, matching the
    // workflow SendMessage path so the timeline treats it like any message.
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
            &event,
            Some(parent_channel_id),
            Some(thread_meta),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            warn!(
                channel_id = %channel_id,
                parent_channel_id = %parent_channel_id,
                "call transcript: persist failed: {e}"
            );
            return None;
        }
    };
    let event_id_hex = event.id.to_hex();
    if !inserted {
        debug!(event_id = %event_id_hex, "call transcript already persisted — skipping fan-out");
        return None;
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

    info!(
        channel_id = %channel_id,
        parent_channel_id = %parent_channel_id,
        event_id = %event_id_hex,
        lines = lines.len(),
        "huddle ended — call transcript posted to parent channel"
    );
    Some(event_id_hex)
}

/// Post the call transcript for `channel_id`, which the caller has JUST
/// archived, resolving its parent from the creator-signed kind:48100 link.
///
/// This is the hook for every huddle end that is not the relay's own grace
/// timer (which already knows the parent it verified at join): a client
/// kind:9002 `archived=true` (desktop/mobile "End huddle" and last-leave send
/// their own 48103 then archive this way) and the TTL reaper. A non-ephemeral
/// channel, or one with no verified huddle link, is a no-op — archiving an
/// ordinary channel never posts anything.
pub async fn emit_call_transcript_for_archived(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    channel_id: Uuid,
) -> Option<String> {
    let channel = match state.db.get_channel(tenant.community(), channel_id).await {
        Ok(ch) => ch,
        Err(e) => {
            debug!(channel_id = %channel_id, "call transcript: channel lookup failed: {e}");
            return None;
        }
    };
    channel.ttl_seconds?;
    let parent = match state
        .db
        .find_huddle_parent_channel(tenant.community(), channel_id, &channel.created_by)
        .await
    {
        Ok(Some(parent)) => parent,
        Ok(None) => return None,
        Err(e) => {
            warn!(channel_id = %channel_id, "call transcript: parent lookup failed: {e}");
            return None;
        }
    };
    emit_call_transcript(state, tenant, channel_id, parent).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(speaker: &str, text: &str) -> TranscriptLine {
        TranscriptLine {
            speaker: speaker.into(),
            text: text.into(),
        }
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
    fn render_transcript_is_none_without_lines() {
        assert_eq!(render_transcript("Jared Dunn call", &[], false), None);
    }

    #[test]
    fn render_transcript_formats_header_and_lines_in_order() {
        let out = render_transcript(
            "Jared Dunn call",
            &[
                line("Sam", "which drill?"),
                line("Jared", "The DeWalt 20V."),
            ],
            false,
        )
        .expect("rendered");
        assert_eq!(
            out,
            "📞 Call transcript — Jared Dunn call\n\nSam: which drill?\n\nJared: The DeWalt 20V."
        );
    }

    #[test]
    fn render_transcript_flattens_speaker_and_channel_names() {
        // A display name / channel name with line breaks must not be able to
        // forge an extra `Name: text` paragraph.
        let out = render_transcript(
            "Jared\n\nSam: forged",
            &[line("Eve\n\nSam", "real text")],
            false,
        )
        .expect("rendered");
        assert_eq!(
            out,
            "📞 Call transcript — Jared Sam: forged\n\nEve Sam: real text"
        );
    }

    #[test]
    fn render_transcript_omission_note_claims_no_count_when_both_caps_hit() {
        // Query cap hit (older turns never fetched) AND the byte budget drops
        // more: the true omitted count is unknown, so none is claimed.
        let lines: Vec<TranscriptLine> = (0..100)
            .map(|i| line("S", &format!("{i:03} {}", "x".repeat(1000))))
            .collect();
        let out = render_transcript("c", &lines, true).expect("rendered");
        assert!(
            out.starts_with("📞 Call transcript — c\n\n(… earlier lines omitted)\n\nS: "),
            "{}",
            &out[..80]
        );
    }

    #[test]
    fn render_transcript_flattens_a_messages_own_line_breaks() {
        let out =
            render_transcript("c", &[line("J", "one\n\ntwo\nthree")], false).expect("rendered");
        assert_eq!(out, "📞 Call transcript — c\n\nJ: one two three");
    }

    #[test]
    fn render_transcript_notes_query_level_omission() {
        let out = render_transcript("c", &[line("A", "x")], true).expect("rendered");
        assert_eq!(
            out,
            "📞 Call transcript — c\n\n(… earlier lines omitted)\n\nA: x"
        );
    }

    #[test]
    fn render_transcript_drops_oldest_lines_to_fit_budget() {
        // 100 lines of ~1 KiB each is ~100 KiB, far over the 32 KiB budget.
        let lines: Vec<TranscriptLine> = (0..100)
            .map(|i| line("S", &format!("{i:03} {}", "x".repeat(1000))))
            .collect();
        let out = render_transcript("c", &lines, false).expect("rendered");
        assert!(out.len() <= TRANSCRIPT_MAX_BYTES, "len {}", out.len());
        // Newest line is kept, oldest is dropped, and the drop is counted.
        assert!(out.contains("S: 099 "));
        assert!(!out.contains("S: 000 "));
        let kept = out.lines().filter(|l| l.starts_with("S: ")).count();
        assert!(kept > 0 && kept < 100);
        assert!(
            out.contains(&format!("(… {} earlier lines omitted)", 100 - kept)),
            "{}",
            &out[..120]
        );
    }

    #[test]
    fn render_transcript_caps_a_single_giant_line() {
        let giant = "y".repeat(TRANSCRIPT_MAX_LINE_BYTES * 3);
        let out = render_transcript("c", &[line("S", &giant)], false).expect("rendered");
        let body_line = out.lines().last().expect("line");
        assert!(body_line.len() <= TRANSCRIPT_MAX_LINE_BYTES);
        assert!(body_line.ends_with('…'));
    }

    #[test]
    fn truncate_bytes_respects_char_boundaries() {
        let s = "ééééé"; // 2 bytes each
        let t = truncate_bytes(s, 6);
        assert!(t.len() <= 6);
        assert!(t.ends_with('…'));
    }
}
