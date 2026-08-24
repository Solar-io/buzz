//! Turn relay: extract the newest user line from Anam's replayed history,
//! publish it as the logged-in user into the agent DM, await the agent's
//! reply, and stream it back as OpenAI SSE deltas.
//!
//! Publish path reuses the `send_channel_message` machinery (signing keys,
//! `events::build_message`, p-mention on the agent, `KIND_STREAM_MESSAGE`)
//! and reply detection follows the channel-messages-since pattern. That
//! wiring lands with the phase-1 follow-up; until then completion requests
//! fail with [`TurnError::NotWired`] so nothing half-speaks.

use futures_util::Stream;

#[derive(Debug)]
pub enum TurnError {
    /// Relay wiring not implemented yet — surfaced as HTTP 503.
    NotWired,
    /// Request-shape problems — surfaced as HTTP 400.
    Bad(String),
}

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

/// Handle one completion request. Returns the SSE byte stream on success.
pub async fn handle_completion(
    _body: &str,
) -> Result<std::pin::Pin<Box<dyn Stream<Item = Result<Vec<u8>, std::io::Error>> + Send>>, TurnError>
{
    // Wired in the phase-1 follow-up:
    // 1. parse body → latest_user_message (validated below via tests)
    // 2. publish as the logged-in user into the configured agent DM
    // 3. poll the relay for the agent's reply (since send ts)
    // 4. stream: sse::role_delta → 4s keepalives → sanitize+chunk deltas →
    //    sse::finish_delta
    Err(TurnError::NotWired)
}

#[cfg(test)]
mod tests {
    use super::latest_user_message;
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
}
