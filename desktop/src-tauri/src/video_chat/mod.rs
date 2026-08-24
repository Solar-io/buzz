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
#[cfg(test)]
mod target_route_tests;

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
static LAST_FORWARD: RwLock<Option<String>> = RwLock::new(None);

/// Diagnostic log for the video-chat bridge. stderr is /dev/null for a
/// GUI-launched app, which blinded the 2026-08-24 investigation into a call
/// that ran half an hour on Anam's stock brain — every state change now
/// lands in `<app-config-dir>/video-chat.log` instead. Outcomes and timings
/// only; transcripts are deliberately never written.
static LOG_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
const LOG_MAX_BYTES: u64 = 256 * 1024;

fn init_log(app_handle: &tauri::AppHandle) {
    if let Some(dir) = app_handle.path().app_config_dir().ok() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = LOG_PATH.set(dir.join("video-chat.log"));
    }
}

/// Append one timestamped line, rotating to `.old` past the size cap.
pub fn vlog(msg: &str) {
    use std::io::Write;
    let Some(path) = LOG_PATH.get() else {
        return;
    };
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > LOG_MAX_BYTES {
            let _ = std::fs::rename(path, path.with_extension("log.old"));
        }
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "{ts} video_chat: {msg}");
}

fn current_target() -> Option<Target> {
    TARGET.read().ok().and_then(|t| t.clone())
}

/// A peer install whose bridge should receive target updates
/// (`video-chat-peers.json` next to the token file). The panel arms the
/// process it runs in, but Anam calls the one funnel URL configured in
/// Anam Lab — so an install whose panel is open forwards its arming to
/// the funnel-side install instead. Verified necessary 2026-08-24: a
/// panel open on aeryn armed only aeryn's loopback and every completion
/// through crichton's funnel answered 400 "no video-chat target".
#[derive(Clone, Debug, serde::Deserialize)]
struct Peer {
    url: String,
    token: String,
}

fn load_peers(app_handle: &tauri::AppHandle) -> Vec<Peer> {
    let Some(dir) = app_handle.path().app_config_dir().ok() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(dir.join("video-chat-peers.json")) else {
        return Vec::new();
    };
    match serde_json::from_str(&raw) {
        Ok(peers) => peers,
        Err(e) => {
            eprintln!("video_chat: video-chat-peers.json unreadable ({e}); skipping peers");
            Vec::new()
        }
    }
}

/// Best-effort POST of an arming payload to every configured peer bridge.
/// Fire-and-forget on purpose: the local arming already succeeded, and a
/// slow or down peer must not block the panel from opening.
fn forward_to_peers(app_handle: tauri::AppHandle, body: serde_json::Value) {
    let peers = load_peers(&app_handle);
    if peers.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("video_chat: peer forward client build failed ({e})");
                return;
            }
        };
        let mut results: Vec<String> = Vec::new();
        for peer in peers {
            let url = format!("{}/v1/internal/target", peer.url.trim_end_matches('/'));
            match client
                .post(&url)
                .bearer_auth(&peer.token)
                .json(&body)
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => results.push(format!("{url} ok")),
                Ok(r) => results.push(format!("{url} http {}", r.status())),
                Err(e) => results.push(format!("{url} unreachable ({e})")),
            }
        }
        let summary = results.join("; ");
        eprintln!("video_chat: peer forward: {summary}");
        vlog(&format!("peer forward: {summary}"));
        if let Ok(mut slot) = LAST_FORWARD.write() {
            *slot = Some(summary);
        }
    });
}

/// Apply a target payload — `{"clear": true}` or a [`Target`] — to the
/// local slot. Pure (no `AppHandle` / no HTTP) so the routing logic can
/// be tested without a live app.
fn apply_target_payload(payload: &serde_json::Value) -> Result<bool, String> {
    if payload.get("clear").and_then(|v| v.as_bool()) == Some(true) {
        if let Ok(mut slot) = TARGET.write() {
            *slot = None;
        }
        return Ok(true);
    }
    let target: Target = serde_json::from_value(payload.clone())
        .map_err(|e| format!("invalid target payload: {e}"))?;
    if let Ok(mut slot) = TARGET.write() {
        *slot = Some(target);
    }
    Ok(false)
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

/// Peer-forwarded arming: `{"clear": true}` or a `Target` body, accepted
/// only with the local bearer token. This is what makes a panel opened on
/// aeryn arm the relay inside crichton's app, whose funnel Anam calls.
async fn internal_target(
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
    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": { "message": format!("invalid JSON body: {e}") } })),
            )
                .into_response()
        }
    };
    match apply_target_payload(&parsed) {
        Ok(cleared) => {
            vlog(if cleared {
                "internal target: cleared (peer forward)"
            } else {
                "internal target: armed (peer forward)"
            });
            Json(json!({
                "ok": true,
                "cleared": cleared,
                "target": current_target(),
            }))
            .into_response()
        }
        Err(msg) => (
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
    init_log(&app_handle);
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
        .route("/v1/internal/target", post(internal_target))
        .with_state(state);
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("video_chat: bind on {port} failed ({e}); video chat disabled this run");
            vlog(&format!("bind on {port} FAILED ({e}); video chat disabled this run"));
            return None;
        }
    };
    if let Ok(mut slot) = TOKEN.write() {
        *slot = Some(token);
    }
    if let Ok(mut slot) = PORT.write() {
        *slot = Some(port);
    }
    vlog(&format!(
        "loopback server up on :{port} (target={})",
        if current_target().is_some() {
            "armed"
        } else {
            "none"
        }
    ));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Some(port)
}

/// Point the video-chat relay at a DM. Called by the panel when a video
/// session opens; cleared by the frontend when it closes. Any configured
/// peer installs receive the same arming — the funnel-side app is the one
/// Anam's custom LLM actually calls.
#[tauri::command]
pub async fn video_chat_set_target(
    app_handle: tauri::AppHandle,
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
        .replace(target.clone());
    vlog(&format!(
        "target armed: channel {} → {}",
        target.channel_id,
        target.agent_name.as_deref().unwrap_or("agent")
    ));
    if let Ok(payload) = serde_json::to_value(&target) {
        forward_to_peers(app_handle, payload);
    }
    Ok(())
}

/// Clear the relay target when the panel closes — locally and on peers.
#[tauri::command]
pub async fn video_chat_clear_target(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut slot) = TARGET.write() {
        *slot = None;
    }
    vlog("target cleared (panel closed)");
    forward_to_peers(app_handle, json!({ "clear": true }));
    Ok(())
}

/// Report the loopback endpoint + bearer token + configured target for the
/// panel and funnel wiring. The token is only ever handed to the app's own
/// frontend, which forwards it to Anam Lab out-of-band (once, by Sam).
#[tauri::command]
pub fn video_chat_status(app_handle: tauri::AppHandle) -> serde_json::Value {
    let port = PORT.read().ok().and_then(|p| *p);
    let peers: Vec<String> = load_peers(&app_handle)
        .into_iter()
        .map(|p| p.url)
        .collect();
    json!({
        "port": port,
        "active": port.is_some(),
        "token": TOKEN.read().ok().and_then(|t| t.clone()),
        "target": current_target(),
        "peers": peers,
        "lastForward": LAST_FORWARD.read().ok().and_then(|s| s.clone()),
    })
}
