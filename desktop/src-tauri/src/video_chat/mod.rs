//! Video chat mode: Anam-rendered face and voice over an agent DM.
//!
//! The desktop app is the owner's authenticated client, so a turn relayed
//! through this module publishes as the logged-in user — exactly the
//! identity position huddles already use. Anam's custom-LLM slot calls the
//! loopback OpenAI-compatible SSE endpoint exposed here (reached from the
//! internet through the Tailscale Funnel on 443).
//!
//! Status: phase 1 scaffold. `turn.rs` still answers `NotWired` — the
//! publish-as-user + await-reply relay lands next; until then the
//! completion route answers 503 so the endpoint can be wired and probed
//! safely.

pub mod sanitize;
#[cfg(test)]
mod sanitize_tests;
pub mod sse;
pub mod turn;

use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;
use tokio::net::TcpListener;

/// Bearer token guarding the one POST route. Generated at spawn, handed to
/// the caller (settings UI / funnel wiring); never logged.
#[derive(Clone)]
pub struct VideoChatState {
    token: Arc<String>,
}

/// GET / and /v1 — OpenAI-style base reachability probes (vendor wiring UIs
/// read a bare 404 as "could not connect"; verified against Anam Lab
/// 2026-08-24).
async fn base_probe() -> Response {
    Json(json!({
        "object": "list",
        "status": "ok",
        "service": "buzz-video-chat",
    }))
    .into_response()
}

async fn models_probe() -> Response {
    Json(json!({
        "object": "list",
        "data": [{ "id": sse::MODEL_LABEL, "object": "model", "owned_by": "buzz" }],
    }))
    .into_response()
}

async fn healthz() -> Response {
    (StatusCode::OK, "ok\n").into_response()
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let api_key = headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    (bearer == token || api_key == token) && !token.is_empty()
}

async fn completions(
    AxumState(state): AxumState<VideoChatState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authorized(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": { "message": "unauthorized" } })),
        )
            .into_response();
    }
    // Turn relay lands with turn.rs; fail explicitly rather than pretending.
    match turn::handle_completion(&body).await {
        Ok(body_stream) => axum::response::Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache")
            .body(axum::body::Body::from_stream(body_stream))
            .unwrap(),
        Err(turn::TurnError::NotWired) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": { "message": "video chat turn relay not yet wired" } })),
        )
            .into_response(),
        Err(turn::TurnError::Bad(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "message": msg } })),
        )
            .into_response(),
    }
}

/// Spawn the loopback server on an ephemeral port. Returns `(port, token)`
/// for the settings surface and funnel wiring.
pub async fn spawn() -> Result<(u16, String), String> {
    let token = uuid::Uuid::new_v4().to_string();
    let state = VideoChatState {
        token: Arc::new(token.clone()),
    };
    let app = Router::new()
        .route("/", get(base_probe))
        .route("/v1", get(base_probe))
        .route("/v1/models", get(models_probe))
        .route("/healthz", get(healthz))
        .route("/v1/chat/completions", post(completions))
        .route("/chat/completions", post(completions))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("video chat bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("video chat local_addr failed: {e}"))?
        .port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((port, token))
}
