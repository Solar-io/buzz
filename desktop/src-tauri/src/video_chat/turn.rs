//! Turn relay: extract the newest user line from Anam's replayed history,
//! publish it as the logged-in user into the agent DM, await the agent's
//! reply, and stream it back as OpenAI SSE deltas.
//!
//! Publishing reuses the composer's exact machinery — `events::build_message`
//! (p-mention on the agent, kind 9), `state.signing_keys()`, and
//! `submit_event_at_created_at` — so the relayed turn is indistinguishable
//! from a typed message: same author (the owner), same signature path, same
//! relay admission. Reply detection polls `query_relay` with an
//! authors+since filter, mirroring the managed-agent marker search.

use futures_util::Stream;
use serde_json::json;
use std::time::Duration;
use tauri::Manager;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use super::sanitize::{chunk_for_speech, sanitize_for_speech};
use super::sse;
use super::Target;

/// How long to wait for the agent's reply before the avatar apologizes.
const REPLY_TIMEOUT_SECS: u64 = 90;
/// Poll cadence for the reply query.
const POLL_INTERVAL_MS: u64 = 1000;
/// Keepalive frames while waiting (the 10s-idle "terminated" lesson).
const KEEPALIVE_INTERVAL_MS: u64 = 4000;
/// Clock-skew grace when matching reply timestamps against the send.
const SKEW_GRACE_SECS: i64 = 2;
const FALLBACK_TEXT: &str = "(sorry — I could not reach the agent just then)";

/// What the avatar SPEAKS when a completion arrives with no armed target.
/// Returned as a normal 200 stream, never a 400: on an error status Anam's
/// engine silently falls back to the persona's built-in stock brain, which
/// is how a 2026-08-24 call carried on for half an hour as a stranger with
/// Evie's face (verified: zero relayed turns in the relay DB for the whole
/// call window). Speaking the failure keeps the face honest — either the
/// agent behind the DM answers, or the avatar says why it can't.
pub const NO_TARGET_SPOKEN: &str =
    "I can't reach the agent behind this face right now. Close and reopen my video chat panel, then call me again.";

/// SSE frames for the no-target case: role delta, one spoken content delta,
/// finish. Pure so the wire shape is unit-testable without an app handle.
pub fn no_target_stream_parts() -> Vec<String> {
    vec![
        sse::role_delta(),
        sse::content_delta(NO_TARGET_SPOKEN),
        sse::finish_delta(),
    ]
}

#[derive(Debug)]
pub enum TurnError {
    /// Request-shape problems — surfaced as HTTP 400.
    Bad(String),
}

type ByteStream = std::pin::Pin<Box<dyn Stream<Item = Result<Vec<u8>, std::io::Error>> + Send>>;
type FrameSink = mpsc::Sender<Result<Vec<u8>, std::io::Error>>;

/// Extract the newest user message from the replayed OpenAI-style history.
///
/// Anam replays the full conversation every turn; only the newest user line
/// is relayed (the agent's own DM memory holds the rest). Content parts are
/// flattened and inner whitespace collapsed.
pub fn latest_user_message(body: &serde_json::Value) -> Option<String> {
    let messages = body.get("messages")?.as_array()?;
    for msg in messages.iter().rev() {
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let text = match msg.get("content")? {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(parts) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Handle one completion request: returns the SSE byte stream on success.
/// The stream opens with a role delta immediately, emits keepalive comment
/// frames while the agent thinks, then the sanitized reply and the finish
/// frame. Failures after the stream opens become spoken fallback text — a
/// hanging avatar is the one failure mode worse than an honest apology.
pub async fn handle_completion(
    app_handle: tauri::AppHandle,
    body: &str,
) -> Result<ByteStream, TurnError> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| TurnError::Bad(format!("invalid JSON body: {e}")))?;
    let user_text = latest_user_message(&parsed)
        .ok_or_else(|| TurnError::Bad("no user message found".to_string()))?;
    let Some(target) = super::current_target() else {
        // Spoken 200, not a silent 400 — see [NO_TARGET_SPOKEN].
        super::vlog("completion: NO TARGET armed — speaking fallback (stock-brain guard)");
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, std::io::Error>>(8);
        tauri::async_runtime::spawn(async move {
            for part in no_target_stream_parts() {
                if tx.send(Ok(part.into_bytes())).await.is_err() {
                    return; // client went away
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        return Ok(Box::pin(ReceiverStream::new(rx)));
    };
    super::vlog(&format!(
        "completion: {}-char turn for {}",
        user_text.len(),
        target.agent_name.as_deref().unwrap_or("agent")
    ));

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, std::io::Error>>(64);
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut tx = tx;
        let started = std::time::Instant::now();
        let _ = tx.send(Ok(sse::role_delta().into_bytes())).await;

        // Publish the turn as the logged-in user.
        let sent_at = match publish_turn(&handle, &target, &user_text).await {
            Ok(ts) => ts,
            Err(err) => {
                super::vlog(&format!("completion: publish FAILED ({err})"));
                eprintln!("video_chat: publish failed: {err}");
                let _ = tx
                    .send(Ok(sse::content_delta(FALLBACK_TEXT).into_bytes()))
                    .await;
                let _ = tx.send(Ok(sse::finish_delta().into_bytes())).await;
                return;
            }
        };

        // Await the reply, interleaving keepalives so no idle proxy kills us.
        let reply = await_reply(&handle, &target, sent_at, &mut tx).await;
        match reply {
            Ok(text) => {
                super::vlog(&format!(
                    "completion: reply in {}ms ({} chars)",
                    started.elapsed().as_millis(),
                    text.len()
                ));
                let spoken = sanitize_for_speech(&text);
                for chunk in chunk_for_speech(&spoken, 42) {
                    if tx
                        .send(Ok(sse::content_delta(&chunk).into_bytes()))
                        .await
                        .is_err()
                    {
                        return; // client went away
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            Err(err) => {
                super::vlog(&format!(
                    "completion: reply wait FAILED after {}ms ({err})",
                    started.elapsed().as_millis()
                ));
                eprintln!("video_chat: reply wait failed: {err}");
                let _ = tx
                    .send(Ok(sse::content_delta(FALLBACK_TEXT).into_bytes()))
                    .await;
            }
        }
        let _ = tx.send(Ok(sse::finish_delta().into_bytes())).await;
    });
    Ok(Box::pin(ReceiverStream::new(rx)))
}

/// Publish `text` as the logged-in user into the target DM, p-mentioning the
/// agent (the tag that wakes its harness). Returns the signed event's
/// Prefix marking a relayed turn as arriving from a live video call, so the
/// agent's prompt can route it to short spoken-style replies instead of its
/// usual long-form DM answers (2026-08-24: latency + awareness ask).
pub const VIDEO_TURN_MARKER: &str = "[video]";

/// Pure so the marker shape is unit-testable without an app handle.
pub(crate) fn mark_video_turn(text: &str) -> String {
    format!("{VIDEO_TURN_MARKER} {}", text.trim())
}

/// `created_at` second for reply matching.
async fn publish_turn(
    app_handle: &tauri::AppHandle,
    target: &Target,
    text: &str,
) -> Result<i64, String> {
    let state = app_handle.state::<crate::app_state::AppState>();
    let relay_base = crate::relay::relay_api_base_url_with_override(&state);
    let signing_keys = state.signing_keys()?;

    let channel_uuid = uuid::Uuid::parse_str(&target.channel_id)
        .map_err(|_| format!("invalid channel UUID: {}", target.channel_id))?;

    let builder = crate::events::build_message(
        channel_uuid,
        &mark_video_turn(text),
        None,
        &[target.agent_pubkey.as_str()],
        &[],
        &[],
        &[],
        &[],
        None,
        &relay_base,
    )?;
    let (_result, created_at) =
        crate::relay::submit_event_at_created_at(builder, &state, &relay_base, &signing_keys)
            .await?;
    Ok(created_at)
}

/// Poll the relay for the agent's reply, sending keepalive frames while
/// waiting. First non-empty kind 9 event from the agent at/after `sent_at`
/// (minus skew grace) wins — the harness may split long answers, and
/// speaking the first keeps the avatar responsive.
async fn await_reply(
    app_handle: &tauri::AppHandle,
    target: &Target,
    sent_at: i64,
    tx: &mut FrameSink,
) -> Result<String, String> {
    let state = app_handle.state::<crate::app_state::AppState>();
    let filter = json!({
        "kinds": [buzz_core_pkg::kind::KIND_STREAM_MESSAGE],
        "#h": [target.channel_id],
        "authors": [target.agent_pubkey],
        "since": (sent_at - SKEW_GRACE_SECS).max(0),
        "limit": 10,
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(REPLY_TIMEOUT_SECS);
    let mut next_keepalive =
        tokio::time::Instant::now() + Duration::from_millis(KEEPALIVE_INTERVAL_MS);
    loop {
        if let Ok(events) = crate::relay::query_relay(&state, &[filter.clone()]).await {
            let hit = events
                .iter()
                .filter(|e| (e.created_at.as_secs() as i64) >= sent_at - SKEW_GRACE_SECS)
                .filter(|e| !e.content.trim().is_empty())
                .min_by_key(|e| e.created_at);
            if let Some(event) = hit {
                return Ok(event.content.clone());
            }
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err("agent did not reply in time".to_string());
        }
        if now >= next_keepalive {
            if tx.send(Ok(sse::keepalive().into_bytes())).await.is_err() {
                return Err("client disconnected".to_string());
            }
            next_keepalive = now + Duration::from_millis(KEEPALIVE_INTERVAL_MS);
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{latest_user_message, no_target_stream_parts, NO_TARGET_SPOKEN};
    use serde_json::json;

    #[test]
    fn picks_only_the_newest_user_turn() {
        let body = json!({
            "model": "x",
            "messages": [
                { "role": "system", "content": "You are a persona." },
                { "role": "user", "content": "first turn" },
                { "role": "assistant", "content": "first reply" },
                { "role": "user", "content": "second turn" },
            ],
        });
        assert_eq!(latest_user_message(&body).as_deref(), Some("second turn"));
    }

    #[test]
    fn flattens_multipart_content_without_double_spaces() {
        let body = json!({
            "messages": [
                { "role": "user", "content": [
                    { "type": "text", "text": "spoken " },
                    { "type": "text", "text": " words" },
                ]},
            ],
        });
        assert_eq!(latest_user_message(&body).as_deref(), Some("spoken words"));
    }

    #[test]
    fn returns_none_without_user_messages() {
        let body = json!({ "messages": [ { "role": "system", "content": "x" } ] });
        assert!(latest_user_message(&body).is_none());
    }

    #[test]
    fn skips_empty_user_messages() {
        let body = json!({
            "messages": [
                { "role": "user", "content": "   " },
                { "role": "assistant", "content": "hm" },
            ],
        });
        assert!(latest_user_message(&body).is_none());
    }

    /// A missing target must produce a SPEAKABLE 200 stream — the frames are
    /// an OpenAI SSE conversation, not an error payload. This pins the
    /// 2026-08-24 fix: a 400 here is what let Anam swap in its stock brain.
    #[test]
    fn no_target_fallback_is_a_spoken_stream_not_an_error() {
        let parts = no_target_stream_parts();
        assert_eq!(parts.len(), 3, "role + content + finish");
        assert!(parts[0].contains("\"role\":\"assistant\""));
        assert!(
            parts[1].contains(NO_TARGET_SPOKEN),
            "content frame must carry the spoken line"
        );
        assert!(parts[2].contains("data: [DONE]"));
        for part in &parts {
            assert!(
                !part.contains("\"error\""),
                "no frame may be shaped like an API error"
            );
        }
    }

    /// The spoken line must tell Sam what to DO — a vague apology sends him
    /// debugging blind, which is the failure mode this guard exists to end.
    #[test]
    fn no_target_spoken_line_names_the_remedy() {
        let lower = NO_TARGET_SPOKEN.to_lowercase();
        assert!(lower.contains("panel"), "must mention the video panel");
        assert!(lower.contains("reopen") || lower.contains("again"));
    }
}
