//! Authenticated routing for the Capacitor-only opaque push wake extension.
//! No event identity is placed in an APNs payload; normal read authorization
//! is checked again here, after a tap, against the host-bound community.

use super::{api_error, bridge, internal_error, relay_members};
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    Json,
};
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn absent() -> (StatusCode, Json<Value>) {
    api_error(StatusCode::NOT_FOUND, "wake unavailable")
}

/// Resolve a caller-owned wake to a minimal navigation target. The opaque
/// UUID grants no authority: a fresh NIP-98 signature and current membership
/// are required even if the device already displayed the notification.
pub async fn resolve(
    State(state): State<Arc<AppState>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    if !state.config.push_capacitor_enabled || state.config.push_gateway_delivery_url.is_none() {
        return Err(absent());
    }
    let wake_id = Uuid::parse_str(&raw_id).map_err(|_| absent())?;
    if wake_id.to_string() != raw_id {
        return Err(absent());
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, host)
        .await
        .map_err(|_| absent())?;
    let path = format!("/api/push/wakes/{wake_id}");
    let url = bridge::nip98_expected_url(&state.config.relay_url, &tenant, &path);
    let (pubkey, auth_id) = bridge::verify_bridge_auth(&headers, "GET", &url, None, true)?;
    bridge::enforce_http_admission(&state, &tenant, &pubkey).await?;
    bridge::check_nip98_replay(&state, &tenant, auth_id).await?;
    relay_members::enforce_relay_membership(
        &state,
        tenant.community(),
        &pubkey.to_bytes(),
        headers.get("x-auth-tag").and_then(|v| v.to_str().ok()),
    )
    .await?;
    let target = state
        .db
        .resolve_push_wake(tenant.community(), &pubkey.to_bytes(), wake_id)
        .await
        .map_err(|_| internal_error("push wake lookup failed"))?
        .ok_or_else(absent)?;
    // Re-read through the standard event API so deletion between lookup and
    // authorization remains a miss rather than a stale navigation disclosure.
    let stored = state
        .db
        .get_event_by_id(tenant.community(), &target.event_id)
        .await
        .map_err(|_| internal_error("push event lookup failed"))?
        .ok_or_else(absent)?;
    let member = match stored.channel_id {
        Some(channel) => state
            .db
            .is_member(tenant.community(), channel, &pubkey.to_bytes())
            .await
            .map_err(|_| internal_error("push membership lookup failed"))?,
        None => true,
    };
    if !target_visible(&stored, &pubkey.to_hex(), member) {
        return Err(absent());
    }
    Ok(Json(serde_json::json!({
        "v":1,"event_id":stored.event.id.to_hex(),"channel_id":stored.channel_id,
    })))
}

fn target_visible(stored: &buzz_core::StoredEvent, reader: &str, member: bool) -> bool {
    member && buzz_core::filter::reader_authorized_for_event(&stored.event, reader)
}
