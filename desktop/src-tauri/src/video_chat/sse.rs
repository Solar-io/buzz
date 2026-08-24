//! OpenAI-compatible SSE framing for Anam's custom-LLM slot.
//!
//! Anam requires streaming responses in the OpenAI chat-completions delta
//! format (https://anam.ai/docs/personas/llms/custom-llms); non-streaming
//! endpoints are rejected. Shapes ported from the standalone adapter and
//! verified against a live Anam Lab registration on 2026-08-24.

const MODEL: &str = "evie-buzz-bridge";

/// Model id surfaced by the `/v1/models` reachability probe.
pub const MODEL_LABEL: &str = MODEL;

fn chunk_frame(delta: &serde_json::Value, finish: Option<&str>) -> String {
    let mut delta_obj = serde_json::Map::new();
    match delta {
        serde_json::Value::Object(map) => delta_obj = map.clone(),
        serde_json::Value::Null => {}
        _ => unreachable!("delta frames are built from objects"),
    }
    let payload = serde_json::json!({
        "id": "buzz-video-chat",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": MODEL,
        "choices": [{
            "index": 0,
            "delta": serde_json::Value::Object(delta_obj),
            "finish_reason": finish,
        }],
    });
    format!("data: {payload}\n\n")
}

/// The role-only delta sent immediately to open the stream and keep it warm.
pub fn role_delta() -> String {
    chunk_frame(&serde_json::json!({ "role": "assistant" }), None)
}

/// A single content delta.
pub fn content_delta(text: &str) -> String {
    chunk_frame(&serde_json::json!({ "content": text }), None)
}

/// Terminal frame: finish_reason stop plus the OpenAI [DONE] sentinel.
pub fn finish_delta() -> String {
    format!(
        "{}data: [DONE]\n\n",
        chunk_frame(&serde_json::Value::Null, Some("stop"))
    )
}

/// SSE comment frame — ignored by clients, keeps idle connections alive
/// while the agent thinks (the 10s-idle "terminated" lesson).
pub fn keepalive() -> String {
    ": keepalive\n\n".to_string()
}
