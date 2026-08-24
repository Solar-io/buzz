//! Video chat mode: Anam-rendered face and voice over an agent DM.
//!
//! The desktop app is the owner's authenticated client, so a turn relayed
//! through this module publishes as the logged-in user — exactly the
//! identity position huddles already use. Anam's custom-LLM slot calls the
//! loopback OpenAI-compatible SSE endpoint exposed here (reached from the
//! internet through the Tauri Funnel on 443 → [`DEFAULT_PORT`]).
//!
//! The endpoint is configured per DM by the video-chat panel
//! ([`video_chat_set_target`]); without a target the completion route
//! answers 400 with an explanatory message.

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
use std::sync::RwLock;
use tauri::Manager;
use tokio::net::TcpListener;

/// Fixed loopback port so the funnel wiring survives app restarts.
/// Registered as `buzz_video_chat` in infra/port-registry.json.
pub const DEFAULT_PORT: u16 = 6371;

/// Bearer token guarding the one POST route. Generated at spawn, exposed to
/// the frontend via [`video_chat_status`]; never logged.
#[derive(Clone)]
struct VideoChatState {
    token: Arc<String>,
    app_handle: tauri::AppHandle,
}

/// The DM the currently configured video-chat session relays into.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Target {
    pub channel_id: String,
    pub agent_pubkey: String,
    /// Display name for the panel; presentation only.
    pub agent_name: Option<String>,
}

static TARGET: RwLock<Option<Target>> = RwLock::new(None);
static TOKEN: RwLock<Option<String>> = RwLock::new(None);
static PORT: RwLock<Option<u16>> = RwLock::new(None);

fn current_target() -> Option<Target> {
    TARGET.read().ok().and_then(|t| t.clone())
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
    let token = state.token.as_str();
    if !authorized(&headers, token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": { "message": "unauthorized" } })),
        )
            .into_response();
    }
    match turn::handle_completion(state.app_handle.clone(), &body).await {
        Ok(stream) => axum::response::Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache")
            .body(axum::body::Body::from_stream(stream))
            .unwrap(),
        Err(turn::TurnError::Bad(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "message": msg } })),
        )
            .into_response(),
    }
}

/// Resolve the bearer token: `BUZZ_VIDEO_CHAT_TOKEN` wins (testing), else a
/// token persisted in the app config dir so Anam Lab wiring survives app
/// restarts, else a freshly generated (and persisted) one.
fn load_or_create_token(app_handle: &tauri::AppHandle) -> Option<String> {
    if let Ok(env_token) = std::env::var("BUZZ_VIDEO_CHAT_TOKEN") {
        if !env_token.trim().is_empty() {
            return Some(env_token.trim().to_string());
        }
    }
    let dir = app_handle.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("video-chat-token");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    std::fs::write(&path, &token).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(token)
}

/// Spawn the loopback server on [`DEFAULT_PORT`] (or `BUZZ_VIDEO_CHAT_PORT`).
/// Non-fatal: video chat is optional, so a bind failure logs and leaves the
/// port unset rather than blocking app startup.
pub async fn spawn(app_handle: tauri::AppHandle) -> Option<u16> {
    let port = std::env::var("BUZZ_VIDEO_CHAT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let token = load_or_create_token(&app_handle)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let state = VideoChatState {
        token: Arc::new(token.clone()),
        app_handle,
    };
    let app = Router::new()
        .route("/", get(base_probe))
        .route("/v1", get(base_probe))
        .route("/v1/models", get(models_probe))
        .route("/healthz", get(healthz))
        .route("/v1/chat/completions", post(completions))
        .route("/chat/completions", post(completions))
        .with_state(state);
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("video_chat: bind on {port} failed ({e}); video chat disabled this run");
            return None;
        }
    };
    if let Ok(mut slot) = TOKEN.write() {
        *slot = Some(token);
    }
    if let Ok(mut slot) = PORT.write() {
        *slot = Some(port);
    }
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Some(port)
}

/// Point the video-chat relay at a DM. Called by the panel when a video
/// session opens; cleared by the frontend when it closes.
#[tauri::command]
pub async fn video_chat_set_target(
    channel_id: String,
    agent_pubkey: String,
    agent_name: Option<String>,
) -> Result<(), String> {
    let target = Target {
        channel_id,
        agent_pubkey,
        agent_name,
    };
    TARGET
        .write()
        .map_err(|_| "video chat state poisoned".to_string())?
        .replace(target);
    Ok(())
}

/// Clear the relay target when the panel closes.
#[tauri::command]
pub async fn video_chat_clear_target() -> Result<(), String> {
    if let Ok(mut slot) = TARGET.write() {
        *slot = None;
    }
    Ok(())
}

/// Report the loopback endpoint + bearer token + configured target for the
/// panel and funnel wiring. The token is only ever handed to the app's own
/// frontend, which forwards it to Anam Lab out-of-band (once, by Sam).
#[tauri::command]
pub fn video_chat_status() -> serde_json::Value {
    let port = PORT.read().ok().and_then(|p| *p);
    json!({
        "port": port,
        "active": port.is_some(),
        "token": TOKEN.read().ok().and_then(|t| t.clone()),
        "target": current_target(),
    })
}
