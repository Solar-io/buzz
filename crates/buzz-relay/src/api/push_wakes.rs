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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
    use tower::ServiceExt;

    fn signed_header(keys: &Keys, url: &str, method: &str) -> String {
        let event = EventBuilder::new(Kind::Custom(27235), Uuid::new_v4().to_string())
            .tags([
                Tag::parse(["u", url]).unwrap(),
                Tag::parse(["method", method]).unwrap(),
            ])
            .sign_with_keys(keys)
            .unwrap();
        format!("Nostr {}", STANDARD.encode(event.as_json()))
    }

    async fn request(
        state: Arc<AppState>,
        host: &str,
        path: &str,
        auth: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method("GET")
            .uri(path)
            .header(header::HOST, host);
        if let Some(auth) = auth {
            request = request.header(header::AUTHORIZATION, auth);
        }
        let response = crate::router::build_router(state)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    #[tokio::test]
    #[ignore = "requires isolated Postgres and Redis explicitly configured"]
    async fn wake_http_requires_fresh_author_auth_and_current_channel_membership() {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL").expect("explicit test DB");
        let redis_url = std::env::var("REDIS_URL").expect("explicit test Redis");
        let pool = sqlx::PgPool::connect(&database_url).await.unwrap();
        buzz_db::migration::run_migrations(&pool).await.unwrap();
        let db = buzz_db::Db::from_pool(pool.clone());
        let mut config = crate::config::Config::from_env().unwrap();
        config.database_url = database_url;
        config.redis_url = redis_url.clone();
        config.relay_url = "wss://wake-qa.invalid".into();
        config.require_auth_token = false;
        config.require_relay_membership = false;
        config.push_capacitor_enabled = true;
        config.push_gateway_delivery_url =
            Some("https://push-qa.invalid/v1/deliveries".parse().unwrap());
        let redis = deadpool_redis::Config::from_url(&redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .unwrap();
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&redis_url, redis.clone())
                .await
                .unwrap(),
        );
        let audit = buzz_audit::AuditService::new(pool.clone());
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflows = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media = buzz_media::MediaStorage::new(&config.media).unwrap();
        let (state, _shutdown) = AppState::new(
            config,
            db.clone(),
            redis,
            audit,
            pubsub,
            auth,
            search,
            workflows,
            Keys::generate(),
            media,
        );
        // Keep the production Redis replay/admission guards, not always-success stubs.
        let state = Arc::new(state);
        let tenant = Uuid::new_v4();
        let host = format!("wake-http-{tenant}.invalid");
        sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
            .bind(tenant)
            .bind(&host)
            .execute(&pool)
            .await
            .unwrap();
        let keys = Keys::generate();
        let stranger = Keys::generate();
        let channel = Uuid::new_v4();
        sqlx::query("INSERT INTO channels (id,community_id,name,channel_type,visibility,created_by) VALUES ($1,$2,'wake-qa','stream','open',$3)").bind(channel).bind(tenant).bind(keys.public_key().to_bytes()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO channel_members (community_id,channel_id,pubkey,role) VALUES ($1,$2,$3,'member')").bind(tenant).bind(channel).bind(keys.public_key().to_bytes()).execute(&pool).await.unwrap();
        let event = EventBuilder::new(Kind::Custom(9), "secret message body")
            .tag(Tag::parse(["h", &channel.to_string()]).unwrap())
            .sign_with_keys(&keys)
            .unwrap();
        db.insert_event(
            buzz_core::CommunityId::from_uuid(tenant),
            &event,
            Some(channel),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO push_leases (community_id,author,installation_id,source_event_id,source_created_at,generation,active,app_profile,endpoint_hash,endpoint_grant,max_class,subscriptions,expires_at) VALUES ($1,$2,'qa-install',$3,1,1,true,'buzz-capacitor-ios-sandbox',$4,'grant','default','[]',9223372036854775806)").bind(tenant).bind(keys.public_key().to_bytes()).bind([21_u8;32]).bind([22_u8;32]).execute(&pool).await.unwrap();
        let wake = Uuid::new_v4();
        sqlx::query("INSERT INTO push_wake_outbox (community_id,id,author,installation_id,lease_generation,endpoint_hash,event_id,class,expires_at,state) VALUES ($1,$2,$3,'qa-install',1,$4,$5,'default',1,'delivered')").bind(tenant).bind(wake).bind(keys.public_key().to_bytes()).bind([22_u8;32]).bind(event.id.to_bytes()).execute(&pool).await.unwrap();
        let path = format!("/api/push/wakes/{wake}");
        let url = format!("https://{host}{path}");
        assert_eq!(
            request(state.clone(), &host, &path, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        let wrong_method = signed_header(&keys, &url, "POST");
        assert_eq!(
            request(state.clone(), &host, &path, Some(&wrong_method))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let wrong_host = signed_header(&keys, &format!("https://other.invalid{path}"), "GET");
        assert_eq!(
            request(state.clone(), &host, &path, Some(&wrong_host))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let wrong_author = signed_header(&stranger, &url, "GET");
        assert_eq!(
            request(state.clone(), &host, &path, Some(&wrong_author))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let valid = signed_header(&keys, &url, "GET");
        let (status, target) = request(state.clone(), &host, &path, Some(&valid)).await;
        assert_eq!(status, StatusCode::OK, "{target}");
        assert_eq!(
            target,
            serde_json::json!({"v":1,"event_id":event.id.to_hex(),"channel_id":channel})
        );
        assert_eq!(
            request(state.clone(), &host, &path, Some(&valid)).await.0,
            StatusCode::UNAUTHORIZED,
            "replayed NIP-98 request"
        );
        sqlx::query(
            "DELETE FROM channel_members WHERE community_id=$1 AND channel_id=$2 AND pubkey=$3",
        )
        .bind(tenant)
        .bind(channel)
        .bind(keys.public_key().to_bytes())
        .execute(&pool)
        .await
        .unwrap();
        let removed = signed_header(&keys, &url, "GET");
        assert_eq!(
            request(state.clone(), &host, &path, Some(&removed)).await.0,
            StatusCode::NOT_FOUND,
            "a delivered wake cannot bypass removed membership"
        );
    }
}
