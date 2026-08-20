//! Relay-owned KLIPY GIF metadata/search proxy.
//!
//! KLIPY requires a provider credential, but desktop applications cannot keep
//! build-time credentials secret. These narrow endpoints keep the key on the
//! operator's relay while returning only KLIPY-hosted media URLs and metadata;
//! GIF bytes are never downloaded, cached, or stored by Buzz.
//!
//! Search is intentionally the only relay endpoint. Sending a selected GIF is
//! a normal message containing its CDN URL, and clients render that URL through
//! the existing image path. A share or render proxy would add operator egress
//! cost and an open-proxy-shaped security surface without a demonstrated need.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::Json,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;

use crate::state::AppState;

use buzz_auth::LimitType;

use super::{api_error, bridge, internal_error, relay_members};

const KLIPY_API_ROOT: &str = "https://api.klipy.com/api/v1/";
const SEARCH_PATH: &str = "/gifs/search";
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_UPSTREAM_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const SEARCHES_PER_MINUTE_PER_PUBKEY: u64 = 30;

#[derive(Debug, Deserialize)]
/// Client-owned search context forwarded to KLIPY by the relay.
pub struct SearchRequest {
    /// Empty means trending; otherwise this is the user's search text.
    query: String,
    /// Stable anonymous installation identifier required by KLIPY.
    customer_id: String,
    /// Desktop locale used to localize provider results.
    locale: String,
}

fn validate_text(
    name: &str,
    value: &str,
    max_chars: usize,
    allow_empty: bool,
) -> Result<(), (StatusCode, Json<Value>)> {
    let count = value.chars().count();
    if (!allow_empty && value.trim().is_empty()) || count > max_chars {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            &format!(
                "{name} must be {} through {max_chars} characters",
                if allow_empty { 0 } else { 1 }
            ),
        ));
    }
    Ok(())
}

fn klipy_url(
    api_key: &str,
    path: &[&str],
    query: &[(&str, &str)],
) -> Result<url::Url, (StatusCode, Json<Value>)> {
    let mut url = url::Url::parse(KLIPY_API_ROOT)
        .map_err(|_| internal_error("invalid static KLIPY API root"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| internal_error("invalid static KLIPY API root"))?;
        segments.pop_if_empty().push(api_key);
        for segment in path {
            segments.push(segment);
        }
    }
    url.query_pairs_mut().extend_pairs(query.iter().copied());
    Ok(url)
}

async fn authenticate(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    path: &str,
    body: &[u8],
) -> Result<(buzz_core::TenantContext, nostr::PublicKey), (StatusCode, Json<Value>)> {
    let raw_host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
        })?;

    let expected_url = bridge::nip98_expected_url(&state.config.relay_url, &tenant, path);
    let (pubkey, event_id_bytes) = bridge::verify_bridge_auth_with_options(
        headers,
        "POST",
        &expected_url,
        Some(body),
        true,
        true,
    )?;
    bridge::enforce_http_admission(state, &tenant, &pubkey).await?;
    bridge::check_nip98_replay(state, &tenant, event_id_bytes).await?;
    relay_members::enforce_relay_membership(
        state,
        tenant.community(),
        &pubkey.to_bytes(),
        headers
            .get("x-auth-tag")
            .and_then(|value| value.to_str().ok()),
    )
    .await?;

    Ok((tenant, pubkey))
}

async fn send_upstream(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, (StatusCode, Json<Value>)> {
    request
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(
                timeout = error.is_timeout(),
                "KLIPY upstream request failed"
            );
            api_error(StatusCode::BAD_GATEWAY, "GIF provider is unavailable")
        })
}

async fn enforce_search_admission(
    state: &AppState,
    tenant: &buzz_core::TenantContext,
    pubkey: &nostr::PublicKey,
) -> Result<(), (StatusCode, Json<Value>)> {
    match crate::admission::check_principal(
        state.admission_rate_limiter.as_ref(),
        tenant,
        pubkey,
        LimitType::GifSearches,
        60,
        SEARCHES_PER_MINUTE_PER_PUBKEY,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(crate::admission::AdmissionError::Exceeded { reset_in_secs }) => {
            metrics::counter!("buzz_gif_search_rejections_total", "reason" => "quota").increment(1);
            Err(api_error(
                StatusCode::TOO_MANY_REQUESTS,
                &format!("rate-limited: GIF search quota exceeded; retry in {reset_in_secs}s"),
            ))
        }
        Err(crate::admission::AdmissionError::Unavailable) => Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "rate-limited: GIF search admission unavailable",
        )),
    }
}

async fn limited_json(response: reqwest::Response) -> Result<Value, (StatusCode, Json<Value>)> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_UPSTREAM_RESPONSE_BYTES as u64)
    {
        return Err(api_error(
            StatusCode::BAD_GATEWAY,
            "GIF provider response was too large",
        ));
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            api_error(
                StatusCode::BAD_GATEWAY,
                "GIF provider response could not be read",
            )
        })?;
        if body.len().saturating_add(chunk.len()) > MAX_UPSTREAM_RESPONSE_BYTES {
            return Err(api_error(
                StatusCode::BAD_GATEWAY,
                "GIF provider response was too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body).map_err(|_| {
        api_error(
            StatusCode::BAD_GATEWAY,
            "GIF provider returned an invalid response",
        )
    })
}

fn successful_search_payload(upstream: &Value) -> Result<Value, (StatusCode, Json<Value>)> {
    if upstream.get("result").and_then(Value::as_bool) != Some(true) {
        tracing::warn!("KLIPY search returned an unsuccessful result");
        return Err(api_error(
            StatusCode::BAD_GATEWAY,
            "GIF provider rejected the search request",
        ));
    }
    let data = upstream.get("data").cloned().unwrap_or(Value::Null);
    Ok(serde_json::json!({ "result": true, "data": data }))
}

/// Search or browse trending KLIPY GIF metadata for an authenticated member.
pub async fn search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let Some(config) = state.config.klipy.as_ref() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "GIF search is not configured",
        ));
    };
    let (tenant, pubkey) = authenticate(&state, &headers, SEARCH_PATH, &body).await?;
    enforce_search_admission(&state, &tenant, &pubkey).await?;
    let request: SearchRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid GIF search JSON"))?;
    validate_text("query", &request.query, 200, true)?;
    validate_text("customer_id", &request.customer_id, 128, false)?;
    validate_text("locale", &request.locale, 32, false)?;

    let endpoint = if request.query.trim().is_empty() {
        "trending"
    } else {
        "search"
    };
    let mut query = vec![
        ("page", "1"),
        ("per_page", "24"),
        ("customer_id", request.customer_id.as_str()),
        ("locale", request.locale.as_str()),
    ];
    if !request.query.trim().is_empty() {
        query.push(("q", request.query.trim()));
    }
    let url = klipy_url(config.api_key(), &["gifs", endpoint], &query)?;
    let response = send_upstream(reqwest::Client::new().get(url)).await?;
    if !response.status().is_success() {
        tracing::warn!(status = response.status().as_u16(), "KLIPY search failed");
        return Err(api_error(
            StatusCode::BAD_GATEWAY,
            "GIF provider rejected the search request",
        ));
    }

    // Never forward the provider response wholesale. KLIPY may report an
    // application-level failure with HTTP 200 and include request details in
    // its error fields. Allowlist only successful result data so credentials
    // and provider diagnostics cannot cross the relay boundary.
    let upstream = limited_json(response).await?;
    Ok(Json(successful_search_payload(&upstream)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn klipy_url_encodes_credentials_as_a_path_segment() {
        let url = klipy_url(
            "key/with spaces",
            &["gifs", "search"],
            &[("customer_id", "customer")],
        )
        .expect("static URL is valid");

        assert_eq!(
            url.as_str(),
            "https://api.klipy.com/api/v1/key%2Fwith%20spaces/gifs/search?customer_id=customer"
        );
    }

    #[test]
    fn validation_bounds_provider_control_fields() {
        assert!(validate_text("query", "", 200, true).is_ok());
        assert!(validate_text("customer_id", "", 128, false).is_err());
        assert!(validate_text("query", &"x".repeat(201), 200, true).is_err());
    }

    #[test]
    fn successful_payload_strips_provider_errors_and_unknown_fields() {
        let payload = successful_search_payload(&serde_json::json!({
            "result": true,
            "data": { "data": [] },
            "errors": { "message": ["request used secret-key"] },
            "debug": "secret-key"
        }))
        .expect("successful payload");

        assert_eq!(
            payload,
            serde_json::json!({ "result": true, "data": { "data": [] } })
        );
    }

    #[test]
    fn unsuccessful_payload_is_rejected_without_provider_details() {
        let (status, body) = successful_search_payload(&serde_json::json!({
            "result": false,
            "errors": { "message": ["request used secret-key"] }
        }))
        .expect_err("unsuccessful provider payload must be rejected");

        assert_eq!(status, StatusCode::BAD_GATEWAY);
        let serialized = serde_json::to_string(&body.0).expect("serialize generic error");
        assert!(!serialized.contains("secret-key"));
    }
}
