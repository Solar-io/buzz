//! axum routers — app (WebSocket + REST), health (K8s probes), metrics (Prometheus).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{ConnectInfo, FromRequest, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode},
    middleware,
    response::{IntoResponse, Json, Redirect},
    routing::{get, post, put},
    Router,
};
use serde_json::json;
use tower::ServiceExt;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::ServeDir;
use tower_http::trace::{HttpMakeClassifier, TraceLayer};

use crate::api;
use crate::audio;
use crate::connection::handle_connection;
use crate::metrics::track_metrics;
use crate::nip11::{nip11_document, relay_info_handler};
use crate::state::AppState;

/// Build the axum [`Router`] with all relay routes, middleware, and CORS configuration.
///
/// Pure Nostr protocol: WebSocket (NIP-01), HTTP bridge (NIP-98), media (Blossom),
/// git (smart HTTP), NIP-05, and health probes.
pub fn build_router(state: Arc<AppState>) -> Router {
    let media_body_limit = state
        .config
        .media
        .max_image_bytes
        .max(state.config.media.max_video_bytes) as usize;
    let media_router = Router::new()
        .route("/upload", put(api::media::upload_blob))
        .route("/media/upload", put(api::media::upload_blob))
        .route(
            "/media/{sha256_ext}",
            get(api::media::get_blob).head(api::media::head_blob),
        )
        .layer(RequestBodyLimitLayer::new(media_body_limit))
        .with_state(state.clone());

    let git_router = api::git::git_router(state.clone());

    let git_policy_router = api::git::git_policy_router(state.clone());

    let admin_enabled = state.config.admin.is_some();
    let admin_web_dir = state
        .config
        .admin
        .as_ref()
        .and_then(|config| config.web_dir.clone());
    let admin_router = admin_enabled
        .then(|| Router::new().nest("/api/admin/v1", api::admin::router(state.clone())));

    let api_router = Router::new()
        // WebSocket + NIP-11
        .route("/", get(nip11_or_ws_handler))
        .route("/info", get(relay_info_handler))
        .route("/.well-known/nostr.json", get(api::nip05::nostr_nip05))
        // Health endpoints
        .route("/health", get(health_handler))
        .route("/_liveness", get(liveness_handler))
        .route("/_readiness", get(readiness_handler))
        // Nostr HTTP bridge (NIP-98 auth)
        .route("/events", post(api::bridge::submit_event))
        .route("/query", post(api::bridge::query_events))
        .route("/count", post(api::bridge::count_events))
        // Relay-owned third-party GIF metadata proxy (NIP-98 auth).
        .route(api::gifs::SEARCH_PATH, post(api::gifs::search))
        .route(api::gifs::SHARE_PATH, post(api::gifs::share))
        // Sender-side link-preview unfurl (NIP-98 auth). See
        // `api::link_preview` for the SSRF fence around the outbound fetch.
        .route(
            api::link_preview::UNFURL_PATH,
            post(api::link_preview::unfurl),
        )
        .route(
            "/workflows/{workflow_id}/runs",
            get(api::workflows::workflow_runs),
        )
        .route(
            "/workflows/{workflow_id}/runs/{run_id}/approvals",
            get(api::workflows::run_approvals),
        )
        .route(
            "/operator/communities",
            get(api::operator::list_owned_communities).post(api::operator::provision_community),
        )
        .route(
            "/operator/communities/archive",
            post(api::operator::archive_community),
        )
        .route(
            "/operator/communities/unarchive",
            post(api::operator::unarchive_community),
        )
        .route(
            "/operator/communities/availability",
            get(api::operator::community_availability),
        )
        .route(
            "/operator/communities/transfer",
            post(api::operator::transfer_community),
        )
        // Relay invites: mint + list (owner/admin) + claim (membership-gate exempt)
        .route(
            "/api/invites",
            post(api::invites::mint_invite).get(api::invites::list_invites),
        )
        .route("/api/join-policy", get(api::invites::join_policy))
        // Policy documents as standalone pages — desktop opens these in the
        // system browser instead of rendering the Markdown in-app.
        .route(
            "/api/join-policy/terms",
            get(api::invites::join_policy_terms),
        )
        .route(
            "/api/join-policy/privacy",
            get(api::invites::join_policy_privacy),
        )
        .route(
            "/api/invites/accept-policy",
            post(api::invites::accept_policy),
        )
        .route("/api/invites/claim", post(api::invites::claim_invite))
        // Moderation queue reads (NIP-98 auth + mod-authz gate, L6)
        .route("/moderation/reports", get(api::bridge::moderation_reports))
        .route("/moderation/audit", get(api::bridge::moderation_audit))
        .route(
            "/moderation/restricted",
            get(api::bridge::moderation_restricted),
        )
        // Webhook trigger (secret-authenticated, no NIP-98)
        .route("/hooks/{id}", post(api::bridge::workflow_webhook))
        // Mesh demo echo probe — testbed-only; 404 unless BUZZ_MESH=on and
        // BUZZ_MESH_DEMO_ECHO=on (see api::mesh_demo).
        .route("/_mesh/demo/echo", post(api::mesh_demo::demo_echo))
        // Huddle audio WebSocket route
        .route("/api/push/wakes/{wake_id}", get(api::push_wakes::resolve))
        .route(
            "/huddle/{channel_id}/audio",
            get(audio::handler::ws_audio_handler),
        )
        // Reject request bodies larger than 1 MB to prevent resource exhaustion.
        .layer(RequestBodyLimitLayer::new(1024 * 1024))
        .with_state(state.clone());

    // Merge — each sub-router carries its own body limit.
    // Metrics → Trace → CORS applied once over the combined router.
    let mut merged = api_router
        .merge(media_router)
        .merge(git_router)
        .merge(git_policy_router);
    if let Some(admin_router) = admin_router {
        merged = merged.merge(admin_router);
    }

    // Same-origin docs proxy (strict allowlist). Routes exist only when the
    // corresponding upstream is configured, like `admin_router` above — with
    // both unset the relay behaves exactly as before and those paths fall
    // through to the web-bundle fallback (404).
    if state.config.docs_changelog_upstream.is_some() {
        merged = merged.merge(
            Router::new()
                .route("/changelog", get(docs_proxy_handler))
                .route("/changelog.md", get(docs_proxy_handler))
                .route("/CHANGELOG.md", get(docs_proxy_handler))
                .route("/tracker", get(docs_proxy_handler))
                .route("/tracker.html", get(docs_proxy_handler))
                .route("/tracker.json", get(docs_proxy_handler))
                .route("/tracker/", get(docs_proxy_handler))
                .with_state(state.clone()),
        );
    }
    if state.config.docs_edition_upstream.is_some() {
        merged = merged.merge(
            Router::new()
                .route("/edition/{*rest}", get(docs_proxy_handler))
                .with_state(state.clone()),
        );
    }

    // Serve both bundles from one fallback. The admin host is checked first so
    // it can never fall through to the public web bundle.
    let web_dir = state.config.web_dir.clone();
    if admin_web_dir.is_some() || web_dir.is_some() {
        let admin_index = admin_web_dir.as_ref().map(|dir| dir.join("index.html"));
        let admin_files = admin_web_dir.map(ServeDir::new);
        let web_index = web_dir.as_ref().map(|dir| dir.join("index.html"));
        let web_files = web_dir.map(ServeDir::new);
        let serve_git_web_gui = state.config.serve_git_web_gui;
        let fallback_state = state.clone();
        let spa_fallback = tower::service_fn(move |req: axum::extract::Request| {
            let admin_index = admin_index.clone();
            let admin_files = admin_files.clone();
            let web_index = web_index.clone();
            let web_files = web_files.clone();
            let state = fallback_state.clone();
            async move {
                // Owned: the asset branch moves `req` into ServeDir while
                // still needing `path` for the worker-scope header stamp.
                let path = req.uri().path().to_owned();
                let admin_host = api::admin::is_admin_host(&state, req.headers());
                if admin_host {
                    if let (Some(index), Some(files)) = (admin_index, admin_files) {
                        if path.starts_with("/assets/") {
                            let served = files.oneshot(req).await;
                            return served
                                .map(IntoResponse::into_response)
                                .map(|response| with_cache_control(response, ASSET_CACHE_CONTROL));
                        }
                        if is_admin_spa_path(&path) {
                            return Ok(read_spa_index(&index).await);
                        }
                    }
                    return Ok(StatusCode::NOT_FOUND.into_response());
                }

                if let (Some(index), Some(files)) = (web_index, web_files) {
                    match classify_web_fallback(&path, serve_git_web_gui) {
                        WebFallback::Asset => {
                            let mut response = files
                                .oneshot(req)
                                .await
                                .map(IntoResponse::into_response)
                                .map(|response| {
                                    with_cache_control(response, ASSET_CACHE_CONTROL)
                                })?;
                            // The web client registers its service worker at
                            // root scope, but the script lives inside /assets/
                            // with the bundle. A browser caps a worker's scope
                            // at the script's own directory unless the response
                            // opts out with this header — without it the worker
                            // never controls the app page and its cache handler
                            // is dead code (live finding 2026-09-10).
                            if path == "/assets/sw.js" {
                                response.headers_mut().insert(
                                    HeaderName::from_static("service-worker-allowed"),
                                    HeaderValue::from_static("/"),
                                );
                            }
                            return Ok(response);
                        }
                        WebFallback::RedirectBareRepos => {
                            // Keep the query: the client reads ?view= from the
                            // URL, so a full-page load of /repos?view=inbox
                            // must land on the same view, not a bare /repos/.
                            let target = match req.uri().query() {
                                Some(query) => format!("/repos/?{query}"),
                                None => "/repos/".to_string(),
                            };
                            return Ok(Redirect::permanent(&target).into_response());
                        }
                        WebFallback::SpaIndex => {
                            return Ok(read_spa_index(&index).await);
                        }
                        WebFallback::NotFound => {}
                    }
                }
                Ok(StatusCode::NOT_FOUND.into_response())
            }
        });
        merged = merged.fallback_service(spa_fallback);
    }

    merged
        .layer(middleware::from_fn(track_metrics))
        .layer(http_trace_layer())
        .layer(build_cors_layer(&state.config.cors_origins))
}

fn http_trace_layer() -> TraceLayer<HttpMakeClassifier, fn(&Request<Body>) -> tracing::Span> {
    TraceLayer::new_for_http().make_span_with(make_http_span as fn(&Request<Body>) -> tracing::Span)
}

fn make_http_span(request: &Request<Body>) -> tracing::Span {
    tracing::info_span!(
        target: "buzz_relay",
        "http.request",
        otel.kind = "server",
        http.request.method = %request.method(),
    )
}

fn is_admin_spa_path(path: &str) -> bool {
    path == "/"
        || path == "/reports"
        || path.starts_with("/reports/")
        || path == "/feedback"
        || path.starts_with("/feedback/")
}

fn is_invite_landing_path(path: &str) -> bool {
    path.strip_prefix("/invite/")
        .is_some_and(|code| !code.is_empty() && !code.contains('/'))
}

fn should_serve_spa(path: &str, serve_git_web_gui: bool) -> bool {
    is_invite_landing_path(path) || (serve_git_web_gui && is_git_web_gui_path(path))
}

fn is_git_web_gui_path(path: &str) -> bool {
    path == "/" || path == "/repos" || path.starts_with("/repos/")
}

/// What the public web-bundle fallback does with a request the explicit routes
/// did not claim.
enum WebFallback {
    /// Serve the file from the bundle, stamped with the asset cache header
    /// (and the service-worker scope opt-out for the worker script).
    Asset,
    /// Canonicalize the bare `/repos` to its trailing-slash form. The web
    /// manifest scopes the installed app to `/repos/`; a page served at
    /// `/repos` renders but sits outside that scope, so the browser offers no
    /// install affordance on the exact URL people type (live finding
    /// 2026-09-10).
    RedirectBareRepos,
    /// Serve the SPA index for a route the client router owns.
    SpaIndex,
    /// Not ours — 404.
    NotFound,
}

fn classify_web_fallback(path: &str, serve_git_web_gui: bool) -> WebFallback {
    if path.starts_with("/assets/") {
        // Assets ship regardless of the GUI flag: the bundle is what asked
        // for them, and withholding them only breaks partial deploys.
        return WebFallback::Asset;
    }
    if serve_git_web_gui && path == "/repos" {
        return WebFallback::RedirectBareRepos;
    }
    if should_serve_spa(path, serve_git_web_gui) {
        return WebFallback::SpaIndex;
    }
    WebFallback::NotFound
}

/// Which configured docs upstream a proxied path belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DocsUpstream {
    /// The changelog/tracker sidecar (`BUZZ_DOCS_CHANGELOG_UPSTREAM`).
    Changelog,
    /// The Daily Edition static server (`BUZZ_DOCS_EDITION_UPSTREAM`).
    Edition,
}

/// Exact-allowlist mapping from a relay path to its docs-upstream path.
///
/// `None` means "not ours" — there is deliberately NO generic prefix rule and
/// the upstream target is NEVER derived from raw request bytes beyond this
/// table, so the relay can only ever mirror the documents it names here.
/// Paths are mirrored 1:1 (the web client rewrites `scheme://host:6451/x` to
/// a same-origin `/x`), with two canonicalizations: the sidecar 404s the
/// extensionless `/changelog` today, so the relay maps it to `/changelog.md`,
/// and `/tracker/` trims to `/tracker`. `classify_web_fallback` stays
/// untouched — this mapping gates the explicit routes, not the fallback.
pub(crate) fn docs_proxy_target(path: &str) -> Option<(DocsUpstream, &str)> {
    match path {
        "/changelog" => Some((DocsUpstream::Changelog, "/changelog.md")),
        "/changelog.md" => Some((DocsUpstream::Changelog, "/changelog.md")),
        "/CHANGELOG.md" => Some((DocsUpstream::Changelog, "/CHANGELOG.md")),
        "/tracker" | "/tracker.html" | "/tracker.json" => Some((DocsUpstream::Changelog, path)),
        "/tracker/" => Some((DocsUpstream::Changelog, "/tracker")),
        _ => {
            if let Some(rest) = path.strip_prefix("/edition/") {
                if docs_edition_rest_is_safe(rest) {
                    return Some((DocsUpstream::Edition, path));
                }
            }
            None
        }
    }
}

/// `/edition/{rest}` accepts a non-empty, traversal-free, fully-segmented
/// remainder: at least one segment, no empty segment (`//`, trailing `/`),
/// and no `..` — the raw path is checked before any percent-decoding can
/// happen, so `..%2F` is caught by the same substring test as `../`, and
/// percent-encoded dots (`%2e`, either case) are rejected outright so the
/// guard never depends on the upstream re-decoding safely.
fn docs_edition_rest_is_safe(rest: &str) -> bool {
    !rest.is_empty()
        && !rest.contains("..")
        && !rest.to_ascii_lowercase().contains("%2e")
        && rest.split('/').all(|segment| !segment.is_empty())
}

/// `Cache-Control` for the docs proxy: always revalidate, matching the
/// sidecar's own `no-store` (changelog-server.ts) — these documents change
/// under fixed paths.
const DOCS_PROXY_CACHE_CONTROL: &str = "no-store";

/// Proxy one allowlisted docs path to its configured upstream.
///
/// No auth is added here — deliberately. These routes mirror documents the
/// same tailnet can already read directly from the upstreams (:6451/:6450),
/// which sit on the same trust boundary as the relay itself; gating the
/// mirror would change nothing about who can read the bytes while breaking
/// every renderer that cannot attach NIP-98 headers (the PWA's `<iframe>`
/// viewer, installed-app navigation capture). Header hygiene runs in both
/// directions: the upstream request is built fresh (no client headers are
/// forwarded), and only `Content-Type` plus our own `Cache-Control` cross
/// back — no upstream cookies, hops, or server fingerprints.
async fn docs_proxy_handler(
    State(state): State<Arc<AppState>>,
    uri: axum::http::Uri,
) -> axum::response::Response {
    use DocsUpstream::{Changelog, Edition};

    // Re-check through the pure mapping instead of trusting the route that
    // matched: one allowlist authority, and the handler is unreachable for
    // anything it rejects (defense in depth over the wildcard route).
    let Some((upstream, upstream_path)) = docs_proxy_target(uri.path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let upstream_base = match (
        upstream,
        state.config.docs_changelog_upstream.as_ref(),
        state.config.docs_edition_upstream.as_ref(),
    ) {
        (Changelog, Some(base), _) => base,
        (Edition, _, Some(base)) => base,
        // Route exists but its upstream was not configured: not ours.
        _ => return StatusCode::NOT_FOUND.into_response(),
    };

    let mut target = format!(
        "{}{}",
        upstream_base.as_str().trim_end_matches('/'),
        upstream_path
    );
    if let Some(query) = uri.query() {
        target.push('?');
        target.push_str(query);
    }

    let upstream_response = match state.docs_http_client.get(&target).send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, target = %target, "docs proxy upstream unreachable");
            return (StatusCode::BAD_GATEWAY, "docs upstream unavailable").into_response();
        }
    };
    let content_type = upstream_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());

    let builder = axum::response::Response::builder()
        .status(upstream_response.status().as_u16())
        .header(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static(DOCS_PROXY_CACHE_CONTROL),
        );
    let builder = match content_type {
        Some(value) => builder.header(axum::http::header::CONTENT_TYPE, value),
        None => builder,
    };
    match builder.body(Body::from_stream(upstream_response.bytes_stream())) {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, "docs proxy response build failed");
            (StatusCode::BAD_GATEWAY, "docs upstream unavailable").into_response()
        }
    }
}

/// `Cache-Control` for the SPA index: always revalidate. The index names the
/// current content-hashed chunk files; a heuristically-cached stale index
/// references chunks a deploy just deleted, which loads as 404s and sends the
/// user into refresh roulette (live incident 2026-09-01 — reported minutes
/// after a bundle deploy). `no-cache` (revalidate every load) is correct even
/// without validators: the body is a few KB.
pub(crate) const SPA_INDEX_CACHE_CONTROL: &str = "no-cache";

/// `Cache-Control` for `/assets/*`: content-hashed filenames make the files
/// immutable by construction — a new build ships new hashes, so a year-long
/// immutable cache is safe and makes repeat loads instant.
pub(crate) const ASSET_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// Stamp a static-web response with the given `Cache-Control` value.
fn with_cache_control(
    response: axum::response::Response,
    value: &'static str,
) -> axum::response::Response {
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static(value),
    );
    axum::response::Response::from_parts(parts, body)
}

async fn read_spa_index(index: &std::path::Path) -> axum::response::Response {
    match tokio::fs::read(index).await {
        Ok(body) => {
            let response: axum::response::Response = axum::response::Html(body).into_response();
            with_cache_control(response, SPA_INDEX_CACHE_CONTROL)
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Build the health-only router for K8s probes (port 8080 in CAKE).
///
/// No metrics middleware, no auth, no CORS, no body limit.
pub fn build_health_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/_liveness", get(liveness_handler))
        .route("/_readiness", get(readiness_handler))
        .route("/_status", get(status_handler))
        .route("/_mesh", get(mesh_status_handler))
        .with_state(state)
}

/// Content-negotiated: NIP-11 JSON for plain HTTP, WebSocket upgrade otherwise.
async fn nip11_or_ws_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    req: axum::extract::Request,
) -> impl IntoResponse {
    let addr = req
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| ci.0)
        .unwrap_or_else(|| std::net::SocketAddr::from(([0, 0, 0, 0], 0)));

    let accept = headers
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // `/` is an explicit relay route, so it never reaches the SPA fallback.
    // Short-circuit the exact admin authority here and never let it serve the
    // public web bundle, NIP-11 document, or WebSocket endpoint.
    if api::admin::is_admin_host(&state, &headers) {
        if !accept.contains("text/html") {
            return StatusCode::NOT_FOUND.into_response();
        }
        let Some(index) = state
            .config
            .admin
            .as_ref()
            .and_then(|config| config.web_dir.as_ref())
            .map(|dir| dir.join("index.html"))
        else {
            return StatusCode::NOT_FOUND.into_response();
        };
        return read_spa_index(&index).await;
    }

    if accept.contains("application/nostr+json") {
        return Json(nip11_document(&state, raw_host).await).into_response();
    }

    // Row zero: bind the connection to its community from the request host
    // BEFORE the WebSocket upgrade, so no frame is ever read on an unbound
    // connection. The host is the authoritative selector; an unmapped host or a
    // lookup failure fails closed with a generic rejection — never a default
    // tenant. NIP-11 above is served before binding and stays fail-open: an
    // unmapped host still gets the document (with host-scoped fields like
    // `icon` simply absent), so the doc cannot leak which hosts are mapped.
    let tenant = match crate::tenant::bind_community(&state.db, raw_host).await {
        Ok(ctx) => ctx,
        Err(_) => {
            // Generic rejection: do not distinguish "unmapped" from "lookup
            // error", and never echo the host, so an unauthenticated caller
            // cannot probe which communities exist on this deployment.
            return (
                StatusCode::NOT_FOUND,
                "relay: no community is configured for this host",
            )
                .into_response();
        }
    };

    let max_frame_bytes = state.config.max_frame_bytes;
    match WebSocketUpgrade::from_request(req, &state).await {
        Ok(ws) => {
            // Shutting down: refuse new sockets instead of accepting a
            // connection onto a dying pod. Readiness already returns 503, but
            // that only stops K8s routing — direct and in-flight upgrades
            // still reach here during the pre-drain grace window. Clients
            // treat the refusal as a normal dial failure and retry, landing
            // on a healthy pod.
            if state.shutting_down.load(Ordering::Relaxed) {
                return (StatusCode::SERVICE_UNAVAILABLE, "relay restarting").into_response();
            }
            limit_relay_websocket(ws, max_frame_bytes)
                .on_upgrade(move |socket| handle_connection(socket, state, addr, tenant))
                .into_response()
        }
        Err(_) => {
            // Browser requesting HTML and Git web GUI is enabled → serve SPA.
            if state.config.serve_git_web_gui {
                if let Some(ref dir) = state.config.web_dir {
                    if accept.contains("text/html") {
                        let index = dir.join("index.html");
                        if let Ok(body) = tokio::fs::read(&index).await {
                            return axum::response::Html(body).into_response();
                        }
                    }
                }
            }
            // Not a WS request and not asking for nostr+json — serve NIP-11 as fallback.
            Json(nip11_document(&state, raw_host).await).into_response()
        }
    }
}

fn limit_relay_websocket<F>(
    ws: WebSocketUpgrade<F>,
    max_frame_bytes: usize,
) -> WebSocketUpgrade<F> {
    // recv_loop keeps the application-level check as defense in depth, but
    // parser limits must be set before tungstenite assembles the message.
    ws.max_message_size(max_frame_bytes)
        .max_frame_size(max_frame_bytes)
}

async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn liveness_handler() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

/// Readiness probe — checks shutdown flag, Postgres, and Redis connectivity.
async fn readiness_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    use std::time::Duration;

    if state.shutting_down.load(Ordering::Relaxed) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status": "shutting_down"})),
        )
            .into_response();
    }

    let check = async {
        let (pg_ok, redis_ok, deletion_catalog_ok) = tokio::join!(
            state.db.ping(),
            async { state.redis_pool.get().await.is_ok() },
            async { state.db.validate_deletion_serving_catalog().await.is_ok() },
        );
        (pg_ok, redis_ok, deletion_catalog_ok)
    };

    let (pg_ok, redis_ok, deletion_catalog_ok) =
        tokio::time::timeout(Duration::from_secs(2), check)
            .await
            .unwrap_or((false, false, false));

    if pg_ok && redis_ok && deletion_catalog_ok {
        (StatusCode::OK, Json(json!({"status": "ready"}))).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status": "not_ready",
                "postgres": pg_ok,
                "redis": redis_ok,
                "deletion_catalog": deletion_catalog_ok
            })),
        )
            .into_response()
    }
}

fn status_payload(uptime_secs: u64) -> serde_json::Value {
    json!({
        "service": "buzz-relay",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": uptime_secs,
        "build": {
            "source_sha": crate::build_info::source_sha(),
            "id": crate::build_info::build_id(),
            "url": crate::build_info::build_url(),
        },
    })
}

/// Status endpoint — service name, version, uptime, and intrinsic build identity.
async fn status_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(status_payload(state.started_at.elapsed().as_secs()))
}

/// `/_mesh` — live mesh status: peer table, connection/phi state, per-peer
/// counters, fence-rejection totals. Mesh-off reports `{"enabled": false}` so
/// operators can distinguish "off" from "on with zero peers".
async fn mesh_status_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.mesh() {
        Some(handle) => Json(serde_json::to_value(handle.status()).unwrap_or_else(
            |e| json!({"enabled": true, "error": format!("status serialize: {e}")}),
        )),
        None => Json(json!({"enabled": false})),
    }
}

/// Build a CORS layer from the configured origins list.
fn build_cors_layer(cors_origins: &[String]) -> CorsLayer {
    if cors_origins.is_empty() {
        return CorsLayer::permissive();
    }

    let origins: Vec<axum::http::HeaderValue> = cors_origins
        .iter()
        .filter_map(|o| o.parse::<axum::http::HeaderValue>().ok())
        .collect();

    if origins.is_empty() {
        tracing::error!(
            "BUZZ_CORS_ORIGINS set but no valid origins could be parsed — \
             refusing to fall back to permissive CORS. Fix the origins or unset \
             the variable for development mode."
        );
        return CorsLayer::new();
    }

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
}

#[cfg(test)]
mod tests {
    use axum::{routing::get, Router};
    use futures_util::SinkExt;
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    use tower::ServiceBuilder;
    use tracing::Instrument as _;
    use tracing_subscriber::prelude::*;

    use super::*;

    #[test]
    fn invite_landing_path_requires_exactly_one_nonempty_code_segment() {
        assert!(is_invite_landing_path("/invite/payload.mac"));
        assert!(!is_invite_landing_path("/invite/"));
        assert!(!is_invite_landing_path("/invite/code/extra"));
        assert!(!is_invite_landing_path("/repos"));
        assert!(!is_invite_landing_path("/"));
    }

    #[test]
    fn git_web_gui_paths_are_explicit() {
        assert!(is_git_web_gui_path("/"));
        assert!(is_git_web_gui_path("/repos"));
        assert!(is_git_web_gui_path("/repos/example"));
        assert!(!is_git_web_gui_path("/repository"));
        assert!(!is_git_web_gui_path("/arbitrary"));
        assert!(!is_git_web_gui_path("/api/invites"));
    }

    #[test]
    fn invite_is_always_served_but_git_gui_requires_opt_in() {
        assert!(should_serve_spa("/invite/payload.mac", false));
        assert!(should_serve_spa("/invite/payload.mac", true));
        assert!(!should_serve_spa("/", false));
        assert!(!should_serve_spa("/repos/example", false));
        assert!(should_serve_spa("/", true));
        assert!(should_serve_spa("/repos/example", true));
        assert!(!should_serve_spa("/arbitrary", true));
    }

    #[test]
    fn web_fallback_classification_pins_the_pwa_contract() {
        use WebFallback::{Asset, NotFound, RedirectBareRepos, SpaIndex};

        // Bundle assets answer whether or not the GUI flag is on.
        assert!(matches!(
            classify_web_fallback("/assets/x.js", false),
            Asset
        ));
        assert!(matches!(classify_web_fallback("/assets/x.js", true), Asset));
        // The bare root canonicalizes to the manifest's scope; a page served
        // at /repos renders fine but sits outside scope, so the browser
        // offers no install affordance on the URL people actually type.
        assert!(matches!(
            classify_web_fallback("/repos", true),
            RedirectBareRepos
        ));
        // No trailing-slash churn anywhere else: deep links and the scoped
        // root serve the SPA as before.
        assert!(matches!(classify_web_fallback("/repos/", true), SpaIndex));
        assert!(matches!(
            classify_web_fallback("/repos/example", true),
            SpaIndex
        ));
        assert!(matches!(classify_web_fallback("/", true), SpaIndex));
        // GUI off keeps the old behavior: no SPA, no redirect, 404.
        assert!(matches!(classify_web_fallback("/repos", false), NotFound));
        assert!(matches!(classify_web_fallback("/", false), NotFound));
        assert!(matches!(
            classify_web_fallback("/arbitrary", true),
            NotFound
        ));
        // Invite landing is orthogonal to the GUI flag.
        assert!(matches!(
            classify_web_fallback("/invite/payload.mac", false),
            SpaIndex
        ));
    }

    #[test]
    fn static_web_cache_control_pins_the_load_reliability_contract() {
        // Hardcoded strings, not derived: the index MUST revalidate (a stale
        // index references chunks a deploy deleted), assets MUST be immutable
        // (content-hashed names change with every build).
        assert_eq!(SPA_INDEX_CACHE_CONTROL, "no-cache");
        assert_eq!(ASSET_CACHE_CONTROL, "public, max-age=31536000, immutable");

        // The stamping helper actually sets the header it is given.
        let base = axum::response::Html("<html>".to_string()).into_response();
        assert!(base
            .headers()
            .get(axum::http::header::CACHE_CONTROL)
            .is_none());
        let stamped = with_cache_control(base, SPA_INDEX_CACHE_CONTROL);
        assert_eq!(
            stamped
                .headers()
                .get(axum::http::header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );
    }

    #[test]
    fn docs_proxy_target_pins_the_exact_allowlist() {
        use DocsUpstream::{Changelog, Edition};

        // Every allowlisted changelog-sidecar path, with its upstream path.
        // The extensionless form canonicalizes (the sidecar 404s it today)
        // and the trailing-slash tracker form trims; everything else mirrors.
        assert_eq!(
            docs_proxy_target("/changelog"),
            Some((Changelog, "/changelog.md"))
        );
        assert_eq!(
            docs_proxy_target("/changelog.md"),
            Some((Changelog, "/changelog.md"))
        );
        assert_eq!(
            docs_proxy_target("/CHANGELOG.md"),
            Some((Changelog, "/CHANGELOG.md"))
        );
        assert_eq!(docs_proxy_target("/tracker"), Some((Changelog, "/tracker")));
        assert_eq!(
            docs_proxy_target("/tracker.html"),
            Some((Changelog, "/tracker.html"))
        );
        assert_eq!(
            docs_proxy_target("/tracker.json"),
            Some((Changelog, "/tracker.json"))
        );
        assert_eq!(
            docs_proxy_target("/tracker/"),
            Some((Changelog, "/tracker"))
        );

        // Edition paths mirror 1:1 onto the edition upstream.
        assert_eq!(
            docs_proxy_target("/edition/latest.html"),
            Some((Edition, "/edition/latest.html"))
        );
        assert_eq!(
            docs_proxy_target("/edition/2026/09/page.html"),
            Some((Edition, "/edition/2026/09/page.html"))
        );

        // Negatives — anything not in the table maps to nothing, forever.
        assert_eq!(docs_proxy_target("/arbitrary"), None);
        // Case-different extension: not the allowlisted document.
        assert_eq!(docs_proxy_target("/CHANGELOG.MD"), None);
        // Edition needs a non-empty remainder.
        assert_eq!(docs_proxy_target("/edition/"), None);
        assert_eq!(docs_proxy_target("/edition"), None);
        // Traversal is rejected in both raw and percent-encoded shapes.
        assert_eq!(docs_proxy_target("/edition/../secret"), None);
        assert_eq!(docs_proxy_target("/edition/..%2Fx"), None);
        assert_eq!(docs_proxy_target("/edition/%2e%2e/x"), None);
        assert_eq!(docs_proxy_target("/edition/%2E%2E/x"), None);
        // Empty segments (double slash, trailing slash) are not paths we mirror.
        assert_eq!(docs_proxy_target("/edition//x"), None);
        assert_eq!(docs_proxy_target("/edition/x/"), None);
        // Trailing slash on a changelog path is not the allowlisted spelling.
        assert_eq!(docs_proxy_target("/changelog/"), None);
        assert_eq!(docs_proxy_target("/tracker.json/extra"), None);
    }

    #[test]
    fn status_payload_exposes_source_and_build_identity() {
        let payload = status_payload(42);

        assert_eq!(payload["service"], "buzz-relay");
        assert_eq!(payload["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(payload["uptime_seconds"], 42);
        for field in ["source_sha", "id", "url"] {
            assert!(
                payload["build"][field]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()),
                "build.{field} must be a non-empty string"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn http_and_datastore_spans_are_exported_in_the_same_trace() {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let subscriber = tracing_subscriber::registry().with(
            tracing_opentelemetry::layer()
                .with_tracer(provider.tracer("test"))
                .with_filter(crate::telemetry::otel_env_filter(None)),
        );
        let _subscriber_guard = tracing::subscriber::set_default(subscriber);
        let service = ServiceBuilder::new()
            .layer(http_trace_layer())
            .service(tower::service_fn(
                |_: axum::http::Request<axum::body::Body>| async {
                    async {}
                        .instrument(tracing::info_span!(
                            target: "buzz_datastore",
                            "SELECT",
                            otel.kind = "client",
                            db.system.name = "postgresql",
                        ))
                        .await;
                    Ok::<_, std::convert::Infallible>(axum::response::Response::new(
                        axum::body::Body::empty(),
                    ))
                },
            ));

        service
            .oneshot(
                axum::http::Request::get("/")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        provider.force_flush().unwrap();
        let spans = exporter.get_finished_spans().unwrap();
        let http = spans
            .iter()
            .find(|span| span.name == "http.request")
            .unwrap();
        let datastore = spans.iter().find(|span| span.name == "SELECT").unwrap();

        assert_eq!(
            datastore.span_context.trace_id(),
            http.span_context.trace_id()
        );
        assert_eq!(datastore.parent_span_id, http.span_context.span_id());
    }

    async fn handler_receives_message_with_limit(limit: usize, size: usize) -> bool {
        let (received_tx, mut received_rx) = mpsc::unbounded_channel();
        let app = Router::new().route(
            "/",
            get(move |ws: WebSocketUpgrade| {
                let received_tx = received_tx.clone();
                async move {
                    limit_relay_websocket(ws, limit).on_upgrade(move |mut socket| async move {
                        let _ = received_tx.send(matches!(socket.recv().await, Some(Ok(_))));
                    })
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test WebSocket listener");
        let addr = listener.local_addr().expect("test listener address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("test WebSocket server");
        });

        let (mut client, _) = connect_async(format!("ws://{addr}/"))
            .await
            .expect("connect test WebSocket client");
        client
            .send(Message::Text("x".repeat(size).into()))
            .await
            .expect("send test WebSocket message");

        let received = tokio::time::timeout(std::time::Duration::from_secs(2), received_rx.recv())
            .await
            .expect("server should process the test message")
            .expect("server should report whether it received the message");

        server.abort();
        let _ = server.await;

        received
    }

    #[tokio::test]
    async fn relay_websocket_parser_rejects_oversized_messages_before_handler_reads_them() {
        let limit = 64;

        assert!(
            handler_receives_message_with_limit(limit, limit).await,
            "messages at the relay limit should still reach the handler"
        );
        assert!(
            !handler_receives_message_with_limit(limit, limit + 1).await,
            "oversized messages must be rejected by the WebSocket parser before the handler sees them"
        );
    }

    /// Lazy-infra AppState (dead DB/Redis, like `api::gifs`' test helper) with
    /// the docs proxy pointed at the given stub upstream origins.
    async fn docs_proxy_test_state(
        changelog_upstream: Option<String>,
        edition_upstream: Option<String>,
    ) -> Arc<AppState> {
        let mut config = crate::config::Config::from_env().expect("test config");
        config.redis_url = "redis://127.0.0.1:1".to_string();
        config.docs_changelog_upstream =
            changelog_upstream.map(|raw| url::Url::parse(&raw).expect("test upstream url"));
        config.docs_edition_upstream =
            edition_upstream.map(|raw| url::Url::parse(&raw).expect("test upstream url"));

        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://buzz:buzz_dev@127.0.0.1:1/buzz") // sadscan:disable np.postgres.1
            .expect("lazy test database pool");
        let db = buzz_db::Db::from_pool(pool.clone());
        let redis_pool = deadpool_redis::Config::from_url(&config.redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("lazy test Redis pool");
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&config.redis_url, redis_pool.clone())
                .await
                .expect("test pubsub"),
        );
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage =
            buzz_media::MediaStorage::new(&config.media).expect("test media storage config");
        let (state, _audit_shutdown) = crate::state::AppState::new(
            config,
            db,
            redis_pool,
            None::<buzz_audit::AuditService>,
            pubsub,
            auth,
            search,
            workflow_engine,
            nostr::Keys::generate(),
            media_storage,
        );
        Arc::new(state)
    }

    #[tokio::test]
    async fn docs_proxy_mirrors_allowlisted_paths_to_their_stub_upstreams() {
        async fn stub_server(
            body: &'static str,
            content_type: &'static str,
        ) -> (String, tokio::task::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind stub upstream");
            let addr = listener.local_addr().expect("stub upstream address");
            let app = Router::new().fallback(get(move || async move {
                ([(axum::http::header::CONTENT_TYPE, content_type)], body)
            }));
            let handle = tokio::spawn(async move {
                axum::serve(listener, app)
                    .await
                    .expect("serve stub upstream");
            });
            (format!("http://{addr}"), handle)
        }

        let (changelog_base, changelog_server) =
            stub_server("stub changelog", "text/markdown").await;
        let (edition_base, edition_server) = stub_server("stub edition", "text/html").await;

        let state =
            docs_proxy_test_state(Some(changelog_base.clone()), Some(edition_base.clone())).await;
        let relay_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind relay test listener");
        let relay_addr = relay_listener.local_addr().expect("relay test address");
        let relay_server = tokio::spawn(async move {
            // With ConnectInfo, like production's serve call — some layers
            // (git policy's localhost gate) read it.
            axum::serve(
                relay_listener,
                build_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .expect("serve relay test router");
        });
        let base = format!("http://{relay_addr}");

        // Allowlisted mirror: status, forwarded body, forwarded Content-Type.
        let response = reqwest::get(format!("{base}/changelog.md"))
            .await
            .expect("changelog.md request");
        assert_eq!(response.status(), 200);
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        let cache_control = response
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        assert_eq!(content_type.as_deref(), Some("text/markdown"));
        assert_eq!(cache_control.as_deref(), Some("no-store"));
        assert_eq!(response.text().await.expect("body"), "stub changelog");

        // Canonicalization: the extensionless form reaches the same document.
        let response = reqwest::get(format!("{base}/changelog"))
            .await
            .expect("changelog request");
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.expect("body"), "stub changelog");

        // Tracker sidecar JSON and the edition upstream's own path both mirror.
        let response = reqwest::get(format!("{base}/tracker.json"))
            .await
            .expect("tracker.json request");
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.expect("body"), "stub changelog");

        let response = reqwest::get(format!("{base}/edition/latest.html"))
            .await
            .expect("edition request");
        assert_eq!(response.status(), 200);
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        assert_eq!(content_type.as_deref(), Some("text/html"));
        assert_eq!(response.text().await.expect("body"), "stub edition");

        // Non-allowlisted paths stay 404 — including case-different and
        // traversal shapes that reach the handler through the wildcard.
        for path in [
            "/arbitrary",
            "/CHANGELOG.MD",
            "/edition/",
            "/edition/..%2Fx",
        ] {
            let response = reqwest::get(format!("{base}{path}"))
                .await
                .expect("negative request");
            assert_eq!(
                response.status(),
                404,
                "{path} must stay outside the allowlist"
            );
        }

        relay_server.abort();
        let _ = relay_server.await;
        changelog_server.abort();
        let _ = changelog_server.await;
        edition_server.abort();
        let _ = edition_server.await;
    }

    #[tokio::test]
    async fn docs_proxy_returns_502_when_the_upstream_is_dead() {
        let state = docs_proxy_test_state(Some("http://127.0.0.1:1".to_string()), None).await;
        let relay_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind relay test listener");
        let relay_addr = relay_listener.local_addr().expect("relay test address");
        let relay_server = tokio::spawn(async move {
            axum::serve(
                relay_listener,
                build_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .expect("serve relay test router");
        });

        let base = format!("http://{relay_addr}");
        let response = reqwest::get(format!("{base}/changelog.md"))
            .await
            .expect("changelog.md request against dead upstream");
        assert_eq!(response.status(), 502);

        relay_server.abort();
        let _ = relay_server.await;
    }

    #[tokio::test]
    async fn docs_proxy_routes_are_absent_when_upstreams_are_unconfigured() {
        let state = docs_proxy_test_state(None, None).await;
        let relay_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind relay test listener");
        let relay_addr = relay_listener.local_addr().expect("relay test address");
        let relay_server = tokio::spawn(async move {
            axum::serve(
                relay_listener,
                build_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .expect("serve relay test router");
        });

        let base = format!("http://{relay_addr}");
        for path in ["/changelog.md", "/tracker.json", "/edition/latest.html"] {
            let response = reqwest::get(format!("{base}{path}"))
                .await
                .expect("unconfigured request");
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            assert_eq!(
                status, 404,
                "{path} must not exist without its upstream configured (body: {body})"
            );
        }

        relay_server.abort();
        let _ = relay_server.await;
    }
}
