//! Tests for the link-preview unfurl.
//!
//! The refusals are the feature, so they are what is tested. Two layers:
//!
//! * The address gate is tested against [`Egress::public`] — the exact policy
//!   a production build uses, with the real resolver and the real
//!   `is_private_ip` predicate. Nothing is stubbed, and a "public" control
//!   case proves the gate is not blanket-deny.
//! * The fetch pipeline (redirect loop, size caps, content-type checks, image
//!   sanitizer) is tested end to end against local servers through an
//!   [`Egress`] whose resolver and address predicate are injected. The code
//!   under test is the shipped code; only DNS and the "is this address
//!   private" question are supplied by the test, so a redirect into blocked
//!   space is a real refusal by the real loop.

use super::*;
use axum::{
    body::Body,
    http::{header, Response as HttpResponse, StatusCode as AxumStatus},
    routing::get,
    Router,
};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// Hostname → addresses, supplied by the test instead of DNS.
#[derive(Debug, Default)]
struct StaticResolver {
    map: HashMap<String, Vec<IpAddr>>,
}

#[async_trait::async_trait]
impl HostResolver for StaticResolver {
    async fn resolve(&self, host: &str, _port: u16) -> Result<Vec<IpAddr>, PreviewError> {
        self.map.get(host).cloned().ok_or(PreviewError::Blocked(
            "link preview host could not be resolved",
        ))
    }
}

/// The stand-in for "this address is private": 127.0.0.2 is the blocked one,
/// 127.0.0.1 (where the test servers live) is not. Both are loopback, so the
/// *real* predicate would reject both and nothing would discriminate; this one
/// splits them, which is what makes a redirect refusal observable.
fn test_blocked(ip: &IpAddr) -> bool {
    ip == &IpAddr::from([127, 0, 0, 2])
}

impl Egress {
    /// Test-only weakened policy. `#[cfg(test)]` by construction: a production
    /// build has no way to build an `Egress` that permits plaintext,
    /// non-default ports, or a substituted address predicate.
    fn for_tests(map: &[(&str, IpAddr)]) -> Self {
        let mut resolver = StaticResolver::default();
        for (host, ip) in map {
            resolver
                .map
                .entry((*host).to_string())
                .or_default()
                .push(*ip);
        }
        Self {
            resolver: Arc::new(resolver),
            blocked: test_blocked,
            require_tls: false,
        }
    }
}

const LOOPBACK: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1));
const BLOCKED: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 2));

/// Serve `router` on an ephemeral loopback port and return its port.
async fn serve(router: Router) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test server");
    let port = listener.local_addr().expect("test server address").port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    port
}

fn html_response(body: &'static str) -> HttpResponse<Body> {
    HttpResponse::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(body))
        .expect("html response")
}

fn redirect_response(location: String) -> HttpResponse<Body> {
    HttpResponse::builder()
        .status(AxumStatus::FOUND)
        .header(header::LOCATION, location)
        .body(Body::empty())
        .expect("redirect response")
}

// ---------------------------------------------------------------------------
// Image fixtures
// ---------------------------------------------------------------------------

fn encode(image: &image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
    let mut out = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut out), format)
        .expect("encode fixture");
    out
}

fn solid_rgb(width: u32, height: u32) -> image::DynamicImage {
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([32, 64, 128]),
    ))
}

fn solid_rgba(width: u32, height: u32) -> image::DynamicImage {
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        width,
        height,
        image::Rgba([32, 64, 128, 128]),
    ))
}

fn jpeg_fixture(width: u32, height: u32) -> Vec<u8> {
    encode(&solid_rgb(width, height), image::ImageFormat::Jpeg)
}

fn png_fixture(width: u32, height: u32) -> Vec<u8> {
    encode(&solid_rgb(width, height), image::ImageFormat::Png)
}

/// A JPEG carrying an APP1 `Exif` segment — the shape the media store's
/// metadata-free contract exists to reject.
fn jpeg_with_exif() -> Vec<u8> {
    let base = jpeg_fixture(16, 16);
    let payload = b"Exif\0\0some-camera-and-gps-metadata";
    let length = (payload.len() + 2) as u16;
    let mut out = Vec::new();
    out.extend_from_slice(&base[..2]); // SOI
    out.extend_from_slice(&[0xff, 0xe1]);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&base[2..]);
    out
}

/// A PNG carrying an `acTL` chunk marker, i.e. an APNG.
fn animated_png() -> Vec<u8> {
    let base = png_fixture(8, 8);
    let mut out = Vec::new();
    out.extend_from_slice(&base[..8]); // signature
    out.extend_from_slice(&[0, 0, 0, 8]);
    out.extend_from_slice(b"acTL");
    out.extend_from_slice(&[0, 0, 0, 2, 0, 0, 0, 0]);
    out.extend_from_slice(&[0, 0, 0, 0]); // (CRC never checked by our scan)
    out.extend_from_slice(&base[8..]);
    out
}

/// The media store's real validation config, so the sanitizer's output is
/// judged by the gate `process_upload` actually applies.
fn media_config() -> buzz_media::MediaConfig {
    buzz_media::MediaConfig {
        s3_endpoint: "http://127.0.0.1:9000".to_string(),
        s3_access_key: "test".to_string(),
        s3_secret_key: "test".to_string(),
        s3_bucket: "test".to_string(),
        s3_region: "us-east-1".to_string(),
        s3_addressing_style: buzz_media::S3AddressingStyle::default(),
        max_image_bytes: 50 * 1024 * 1024,
        max_gif_bytes: 10 * 1024 * 1024,
        max_video_bytes: 500 * 1024 * 1024,
        max_file_bytes: 100 * 1024 * 1024,
        public_base_url: "http://127.0.0.1/media".to_string(),
        upload_records_enabled: false,
        upload_ip_header: None,
        upload_port_header: None,
    }
}

// ---------------------------------------------------------------------------
// The production address gate
// ---------------------------------------------------------------------------

#[tokio::test]
async fn public_egress_admits_a_public_address() {
    // The control for every refusal below: the gate is not blanket-deny.
    let allowed = Egress::public()
        .validate(&Url::parse("https://8.8.8.8/page").expect("url"))
        .await;
    assert_eq!(
        allowed,
        Ok(vec![SocketAddr::new(IpAddr::from([8, 8, 8, 8]), 443)])
    );
}

#[tokio::test]
async fn public_egress_refuses_plaintext_and_odd_ports() {
    let egress = Egress::public();
    assert_eq!(
        egress
            .validate(&Url::parse("http://8.8.8.8/page").expect("url"))
            .await,
        Err(PreviewError::Blocked("link previews require an https URL"))
    );
    assert_eq!(
        egress
            .validate(&Url::parse("https://8.8.8.8:8443/page").expect("url"))
            .await,
        Err(PreviewError::Blocked(
            "link previews require the default https port"
        ))
    );
}

#[tokio::test]
async fn public_egress_refuses_embedded_credentials() {
    assert_eq!(
        Egress::public()
            .validate(&Url::parse("https://user:secret@8.8.8.8/page").expect("url"))
            .await,
        Err(PreviewError::Blocked(
            "link preview URLs must not carry credentials"
        ))
    );
}

#[tokio::test]
async fn public_egress_refuses_every_private_or_reserved_address() {
    let egress = Egress::public();
    // One entry per family the SSRF gate has to cover, including the
    // IPv4-mapped IPv6 spellings that a hostname-only check misses.
    let hosts = [
        "https://127.0.0.1/",
        "https://10.0.0.1/",
        "https://172.16.0.1/",
        "https://192.168.1.1/",
        "https://169.254.169.254/latest/meta-data/",
        "https://100.100.100.200/",
        "https://0.0.0.0/",
        "https://[::1]/",
        "https://[fd00::1]/",
        "https://[fe80::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:169.254.169.254]/",
        "https://[64:ff9b::7f00:1]/",
    ];
    let mut refused = 0;
    for host in hosts {
        let url = Url::parse(host).expect("url");
        assert_eq!(
            egress.validate(&url).await,
            Err(PreviewError::Blocked(
                "link preview host resolves to a private or reserved address"
            )),
            "{host} was not refused"
        );
        refused += 1;
    }
    assert_eq!(refused, hosts.len());
}

#[tokio::test]
async fn public_egress_refuses_a_hostname_that_resolves_into_private_space() {
    // The check that matters is on the *resolved* address, not the name:
    // `localhost` is a public-looking string that answers with 127.0.0.1.
    assert_eq!(
        Egress::public()
            .validate(&Url::parse("https://localhost/page").expect("url"))
            .await,
        Err(PreviewError::Blocked(
            "link preview host resolves to a private or reserved address"
        ))
    );
}

#[test]
fn redirect_locations_are_joined_against_the_current_url() {
    // Joining is lexical and trusts nothing: the hop it produces is gated by
    // `Egress::send` before it is dialled (see the end-to-end refusals below).
    let current = Url::parse("https://example.com/a/b").expect("url");
    assert_eq!(
        join_redirect(&current, "/elsewhere").map(|url| url.to_string()),
        Ok("https://example.com/elsewhere".to_string())
    );
    assert_eq!(
        join_redirect(&current, "  https://other.example/x  ").map(|url| url.to_string()),
        Ok("https://other.example/x".to_string())
    );
    assert_eq!(
        join_redirect(&current, "http:"),
        Err(PreviewError::Upstream(
            "link preview redirect was not a valid URL"
        ))
    );
}

#[test]
fn request_urls_must_be_https_and_bounded() {
    assert!(parse_request_url("https://example.com/a").is_ok());
    assert_eq!(
        parse_request_url("http://example.com/a"),
        Err(PreviewError::Blocked("link previews require an https URL"))
    );
    assert_eq!(
        parse_request_url("file:///etc/passwd"),
        Err(PreviewError::Blocked("link previews require an https URL"))
    );
    assert_eq!(
        parse_request_url("not a url"),
        Err(PreviewError::Blocked(
            "link preview URL could not be parsed"
        ))
    );
    assert_eq!(
        parse_request_url(""),
        Err(PreviewError::Blocked("link preview URL is not usable"))
    );
    let overlong = format!("https://example.com/{}", "a".repeat(MAX_URL_LENGTH));
    assert_eq!(
        parse_request_url(&overlong),
        Err(PreviewError::Blocked("link preview URL is not usable"))
    );
}

// ---------------------------------------------------------------------------
// The fetch loop, end to end
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_page_refuses_a_redirect_into_blocked_space() {
    // The server answers 302 to a host the policy blocks. The loop must refuse
    // on the *hop*, before any connection to it is attempted — remove the
    // re-validation and this surfaces as a transport failure instead.
    let port = serve(Router::new().route(
        "/start",
        get(|| async { redirect_response("http://blocked.test/admin".to_string()) }),
    ))
    .await;

    let egress = Egress::for_tests(&[("page.test", LOOPBACK), ("blocked.test", BLOCKED)]);
    let start = Url::parse(&format!("http://page.test:{port}/start")).expect("url");
    assert_eq!(
        fetch_page(&egress, start).await.err(),
        Some(PreviewError::Blocked(
            "link preview host resolves to a private or reserved address"
        ))
    );
}

#[tokio::test]
async fn fetch_page_follows_a_permitted_redirect() {
    // The discriminator for the test above: the same loop, one hop, allowed.
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let port = serve(
        Router::new()
            .route(
                "/start",
                get(|| async { redirect_response("/final".to_string()) }),
            )
            .route(
                "/final",
                get(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async { html_response("<html><head><title>Arrived</title></head></html>") }
                }),
            ),
    )
    .await;

    let egress = Egress::for_tests(&[("page.test", LOOPBACK)]);
    let start = Url::parse(&format!("http://page.test:{port}/start")).expect("url");
    let (final_url, html) = fetch_page(&egress, start).await.expect("page");
    assert_eq!(final_url.path(), "/final");
    assert!(html.contains("Arrived"));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn fetch_page_stops_at_the_redirect_cap() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let port = serve(Router::new().route(
        "/loop",
        get(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            async { redirect_response("/loop".to_string()) }
        }),
    ))
    .await;

    let egress = Egress::for_tests(&[("page.test", LOOPBACK)]);
    let start = Url::parse(&format!("http://page.test:{port}/loop")).expect("url");
    assert_eq!(
        fetch_page(&egress, start).await.err(),
        Some(PreviewError::Upstream(
            "link preview followed too many redirects"
        ))
    );
    // Hardcoded on purpose. Phrased as `MAX_REDIRECTS + 1` this assertion
    // would move with the constant it is meant to pin, and raising the cap
    // would still pass.
    assert_eq!(hits.load(Ordering::SeqCst), 4);
    assert_eq!(MAX_REDIRECTS, 3);
}

#[tokio::test]
async fn fetch_page_refuses_a_non_html_document() {
    let port = serve(Router::new().route(
        "/blob",
        get(|| async {
            HttpResponse::builder()
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from("MZ\u{0}\u{0}"))
                .expect("response")
        }),
    ))
    .await;

    let egress = Egress::for_tests(&[("page.test", LOOPBACK)]);
    let start = Url::parse(&format!("http://page.test:{port}/blob")).expect("url");
    assert_eq!(
        fetch_page(&egress, start).await.err(),
        Some(PreviewError::Upstream("link preview target is not a page"))
    );
}

#[tokio::test]
async fn fetch_page_reads_only_the_capped_prefix() {
    // A title parked past the cap must be invisible; the same page's title
    // parked before it must be found. Offsets and the size assertion are
    // hardcoded, not derived from MAX_PAGE_BYTES — a fixture that grows with
    // the constant it pins can never detect the constant being raised.
    async fn title_at(offset: usize) -> (usize, Option<PageMetadata>) {
        let body = format!(
            "<html><head><!--{}--><title>Late</title></head></html>",
            "x".repeat(offset)
        );
        let leaked: &'static str = Box::leak(body.into_boxed_str());
        let port =
            serve(Router::new().route("/page", get(move || async move { html_response(leaked) })))
                .await;
        let egress = Egress::for_tests(&[("page.test", LOOPBACK)]);
        let start = Url::parse(&format!("http://page.test:{port}/page")).expect("url");
        let (_, html) = fetch_page(&egress, start).await.expect("page");
        (html.len(), extract_metadata(&html))
    }

    let (near_len, near) = title_at(1024).await;
    assert!(near.is_some());
    assert!(near_len < 262_144);

    let (far_len, far) = title_at(300 * 1024).await;
    assert!(far.is_none(), "a title past the cap must not be readable");
    assert_eq!(far_len, 262_144, "the body must be truncated at 256 KiB");
    assert_eq!(MAX_PAGE_BYTES, 262_144);
}

#[tokio::test]
async fn fetch_image_refuses_an_oversized_body() {
    // Chunked, so `content_length()` is absent and only the streaming counter
    // can stop it.
    let port = serve(Router::new().route(
        "/big.jpg",
        get(|| async {
            let chunk = bytes::Bytes::from(vec![0u8; 64 * 1024]);
            let stream = futures_util::stream::iter(
                (0..64).map(move |_| Ok::<_, std::io::Error>(chunk.clone())),
            );
            HttpResponse::builder()
                .header(header::CONTENT_TYPE, "image/jpeg")
                .body(Body::from_stream(stream))
                .expect("response")
        }),
    ))
    .await;

    let egress = Egress::for_tests(&[("cdn.test", LOOPBACK)]);
    let url = Url::parse(&format!("http://cdn.test:{port}/big.jpg")).expect("url");
    assert_eq!(
        fetch_image(&egress, url, MAX_IMAGE_BYTES, false)
            .await
            .err(),
        Some(PreviewError::Upstream(
            "link preview response was too large"
        ))
    );
}

#[tokio::test]
async fn fetch_image_refuses_a_declared_size_over_the_cap() {
    let port = serve(Router::new().route(
        "/big.jpg",
        get(|| async {
            HttpResponse::builder()
                .header(header::CONTENT_TYPE, "image/jpeg")
                .header(header::CONTENT_LENGTH, (MAX_IMAGE_BYTES + 1).to_string())
                .body(Body::from(vec![0u8; MAX_IMAGE_BYTES + 1]))
                .expect("response")
        }),
    ))
    .await;

    let egress = Egress::for_tests(&[("cdn.test", LOOPBACK)]);
    let url = Url::parse(&format!("http://cdn.test:{port}/big.jpg")).expect("url");
    assert_eq!(
        fetch_image(&egress, url, MAX_IMAGE_BYTES, false)
            .await
            .err(),
        Some(PreviewError::Upstream(
            "link preview response was too large"
        ))
    );
}

#[tokio::test]
async fn fetch_image_accepts_an_image_within_the_cap() {
    // Discriminator for both size tests: the same path, a small image.
    let bytes = jpeg_fixture(64, 48);
    let served = bytes.clone();
    let port = serve(Router::new().route(
        "/small.jpg",
        get(move || {
            let body = served.clone();
            async move {
                HttpResponse::builder()
                    .header(header::CONTENT_TYPE, "image/jpeg")
                    .body(Body::from(body))
                    .expect("response")
            }
        }),
    ))
    .await;

    let egress = Egress::for_tests(&[("cdn.test", LOOPBACK)]);
    let url = Url::parse(&format!("http://cdn.test:{port}/small.jpg")).expect("url");
    let image = fetch_image(&egress, url, MAX_IMAGE_BYTES, false)
        .await
        .expect("image");
    assert_eq!(image.ext, "jpg");
    assert!(!image.bytes.is_empty());
}

#[tokio::test]
async fn fetch_image_refuses_a_non_image_content_type() {
    let port = serve(Router::new().route(
        "/script",
        get(|| async {
            HttpResponse::builder()
                .header(header::CONTENT_TYPE, "text/html")
                .body(Body::from("<svg onload=alert(1)>"))
                .expect("response")
        }),
    ))
    .await;

    let egress = Egress::for_tests(&[("cdn.test", LOOPBACK)]);
    let url = Url::parse(&format!("http://cdn.test:{port}/script")).expect("url");
    assert_eq!(
        fetch_image(&egress, url, MAX_IMAGE_BYTES, false)
            .await
            .err(),
        // Deliberately NOT the sanitizer's "is not an image": with a shared
        // message this fixture would pass even with the header check deleted,
        // because the bytes fail the sniff a step later.
        Some(PreviewError::Upstream(
            "link preview image had an unsupported content type"
        ))
    );
}

#[tokio::test]
async fn fetch_image_refuses_a_redirect_into_blocked_space() {
    let port = serve(Router::new().route(
        "/logo.png",
        get(|| async { redirect_response("http://blocked.test/logo.png".to_string()) }),
    ))
    .await;

    let egress = Egress::for_tests(&[("cdn.test", LOOPBACK), ("blocked.test", BLOCKED)]);
    let url = Url::parse(&format!("http://cdn.test:{port}/logo.png")).expect("url");
    assert_eq!(
        fetch_image(&egress, url, MAX_IMAGE_BYTES, false)
            .await
            .err(),
        Some(PreviewError::Blocked(
            "link preview host resolves to a private or reserved address"
        ))
    );
}

// ---------------------------------------------------------------------------
// Image sanitizing
// ---------------------------------------------------------------------------

#[test]
fn sanitize_refuses_bytes_that_are_not_the_declared_type() {
    assert_eq!(
        sanitize_image(&png_fixture(8, 8), "image/jpeg", false),
        Err(PreviewError::Upstream(
            "link preview image content type does not match its bytes"
        ))
    );
    assert_eq!(
        sanitize_image(
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            "image/png",
            false
        ),
        Err(PreviewError::Upstream("link preview image is not an image"))
    );
}

#[test]
fn sanitize_refuses_animated_containers() {
    assert_eq!(
        sanitize_image(&animated_png(), "image/png", false),
        Err(PreviewError::Upstream(
            "animated link preview images are unsupported"
        ))
    );
    let gif = encode(&solid_rgb(8, 8), image::ImageFormat::Gif);
    assert_eq!(
        sanitize_image(&gif, "image/gif", false),
        Err(PreviewError::Upstream(
            "animated link preview images are unsupported"
        ))
    );
}

#[test]
fn sanitize_refuses_oversized_geometry() {
    let wide = encode(
        &solid_rgb(MAX_IMAGE_DIMENSION + 1, 2),
        image::ImageFormat::Png,
    );
    assert_eq!(
        sanitize_image(&wide, "image/png", false),
        Err(PreviewError::Upstream(
            "link preview image dimensions exceed safe limits"
        ))
    );
    // Discriminator: one pixel under the cap is accepted.
    let ok = encode(&solid_rgb(MAX_IMAGE_DIMENSION, 2), image::ImageFormat::Png);
    assert!(sanitize_image(&ok, "image/png", false).is_ok());
}

#[test]
fn sanitize_strips_metadata_the_media_store_would_reject() {
    let config = media_config();
    let exif = jpeg_with_exif();
    // The raw bytes really would be refused by the store…
    assert!(buzz_media::validation::validate_content(&exif, &config).is_err());
    // …and the sanitizer's output is accepted by that same gate.
    let sanitized = sanitize_image(&exif, "image/jpeg", false).expect("sanitized");
    assert_eq!(sanitized.ext, "jpg");
    assert_eq!(
        buzz_media::validation::validate_content(&sanitized.bytes, &config)
            .expect("sanitized jpeg is storable"),
        "image/jpeg"
    );
}

#[test]
fn sanitize_keeps_transparency_for_favicons_only_when_asked() {
    let config = media_config();
    let rgba = encode(&solid_rgba(32, 32), image::ImageFormat::Png);
    let kept = sanitize_image(&rgba, "image/png", true).expect("png");
    assert_eq!(kept.ext, "png");
    assert_eq!(
        buzz_media::validation::validate_content(&kept.bytes, &config).expect("storable"),
        "image/png"
    );
    let flattened = sanitize_image(&rgba, "image/png", false).expect("jpeg");
    assert_eq!(flattened.ext, "jpg");
}

#[test]
fn sanitize_downscales_to_the_stored_ceiling() {
    let large = encode(&solid_rgb(2000, 1000), image::ImageFormat::Png);
    let sanitized = sanitize_image(&large, "image/png", false).expect("sanitized");
    let decoded = image::load_from_memory(&sanitized.bytes).expect("decode");
    assert!(decoded.width() <= MAX_STORED_DIMENSION);
    assert!(decoded.height() <= MAX_STORED_DIMENSION);
    assert_eq!(decoded.width(), MAX_STORED_DIMENSION);
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

#[test]
fn metadata_prefers_open_graph_then_twitter_then_the_title_tag() {
    let full = r#"<html><head>
        <meta property="og:title" content="OG title">
        <meta name="twitter:title" content="Twitter title">
        <meta property="og:site_name" content="Example">
        <meta property="og:description" content="A description">
        <title>Tag title</title></head></html>"#;
    let metadata = extract_metadata(full).expect("metadata");
    assert_eq!(metadata.title, "OG title");
    assert_eq!(metadata.site, "Example");
    assert_eq!(metadata.description, "A description");

    let twitter_only = r#"<html><head>
        <meta name="twitter:title" content="Twitter title">
        <title>Tag title</title></head></html>"#;
    assert_eq!(
        extract_metadata(twitter_only).expect("metadata").title,
        "Twitter title"
    );

    let tag_only = "<html><head><title>Tag title</title></head></html>";
    assert_eq!(
        extract_metadata(tag_only).expect("metadata").title,
        "Tag title"
    );
}

#[test]
fn a_blank_open_graph_title_falls_through_to_the_title_tag() {
    // Measured against rust-lang.org, which ships BOTH `og:title` and
    // `twitter:title` as `content=""`. Treating a blank as a value made the
    // fallback chain unreachable and the page unpreviewable — the endpoint
    // answered 204 for a page with a perfectly good <title>.
    let html = r#"<html><head>
        <meta property="og:title" content="">
        <meta name="twitter:title" content="">
        <meta property="og:description" content="">
        <title>
            Rust Programming Language
        </title></head></html>"#;
    let metadata = extract_metadata(html).expect("metadata");
    assert_eq!(metadata.title, "Rust Programming Language");
    assert_eq!(metadata.description, "");
}

#[test]
fn a_blank_key_does_not_shadow_a_later_one_of_the_same_name() {
    let html = r#"<html><head>
        <meta property="og:title" content="   ">
        <meta property="og:title" content="The real title">
        </head></html>"#;
    assert_eq!(
        extract_metadata(html).expect("metadata").title,
        "The real title"
    );
}

#[test]
fn metadata_is_none_without_a_usable_title() {
    assert!(extract_metadata("<html><head></head><body>hi</body></html>").is_none());
    assert!(extract_metadata(r#"<html><head><title>   </title></head></html>"#).is_none());
}

#[test]
fn metadata_satisfies_the_ingest_text_rules() {
    // Ingest rejects control characters (except `\n` in the description) and
    // caps the three text fields by BYTE length. Anything this endpoint emits
    // has to clear both, or the snapshot it enables is unsendable.
    let html = format!(
        r#"<html><head>
        <meta property="og:title" content="Title{tab}with{nul}controls {long}">
        <meta property="og:site_name" content="{long}">
        <meta property="og:description" content="First{crlf}{crlf}Second{vertical} {long}">
        </head></html>"#,
        tab = "\t",
        nul = "\u{0}",
        crlf = "\r\n",
        vertical = "\u{b}",
        long = "é".repeat(900),
    );
    let metadata = extract_metadata(&html).expect("metadata");

    assert!(metadata.title.len() <= MAX_TITLE_BYTES);
    assert!(metadata.site.len() <= MAX_SITE_BYTES);
    assert!(metadata.description.len() <= MAX_DESCRIPTION_BYTES);
    assert!(metadata.title.chars().count() <= MAX_TITLE_CHARS);
    assert!(metadata.description.chars().count() <= MAX_DESCRIPTION_CHARS);

    assert!(!metadata.title.chars().any(char::is_control));
    assert!(!metadata.site.chars().any(char::is_control));
    assert!(!metadata
        .description
        .chars()
        .any(|c| c.is_control() && c != '\n'));
    // The one control character ingest does allow survives, so the clamp is
    // not simply deleting everything.
    assert!(metadata.description.contains('\n'));
    assert!(metadata.title.starts_with("Title with controls"));
}

#[test]
fn metadata_decodes_entities_and_ignores_lookalike_attributes() {
    let html = r#"<html><head>
        <meta data-property="og:title" content="Decoy">
        <meta property="og:title" content="Ben &amp; Jerry&#39;s &#x2014; caf&#233;">
        </head></html>"#;
    assert_eq!(
        extract_metadata(html).expect("metadata").title,
        "Ben & Jerry's — café"
    );
}

#[test]
fn image_and_favicon_urls_resolve_against_the_page_url() {
    let page = Url::parse("https://example.com/articles/one").expect("url");
    let html = r#"<html><head>
        <meta property="og:image" content="../images/hero.png">
        <link rel="shortcut icon" href="/favicon.ico">
        <link rel="icon" type="image/png" href="/icon-192.png">
        </head></html>"#;
    assert_eq!(
        extract_image_url(html, &page).map(|url| url.to_string()),
        Some("https://example.com/images/hero.png".to_string())
    );
    // A raster icon wins over the `.ico` that appeared first — the media store
    // cannot keep an ICO.
    assert_eq!(
        extract_favicon_url(html, &page).map(|url| url.to_string()),
        Some("https://example.com/icon-192.png".to_string())
    );
}

#[test]
fn favicon_falls_back_to_a_non_raster_icon_when_that_is_all_there_is() {
    let page = Url::parse("https://example.com/").expect("url");
    let html = r#"<link rel="icon" href="/favicon.ico">"#;
    assert_eq!(
        extract_favicon_url(html, &page).map(|url| url.to_string()),
        Some("https://example.com/favicon.ico".to_string())
    );
    assert!(extract_favicon_url("<html></html>", &page).is_none());
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

#[test]
fn response_serializes_to_the_snapshot_tag_fields() {
    let response = UnfurlResponse {
        url: "https://example.com/a".to_string(),
        title: "Title".to_string(),
        site: "Example".to_string(),
        description: "Description".to_string(),
        image: Some(UnfurlMedia {
            url: "https://relay.example/media/abc.jpg".to_string(),
            sha256: "abc".to_string(),
        }),
        favicon: None,
    };
    let json = serde_json::to_value(&response).expect("json");
    assert_eq!(json["url"], "https://example.com/a");
    assert_eq!(json["image"]["sha256"], "abc");
    // An absent asset is absent, not null: the client maps "no image" to the
    // snapshot tag's empty url/hash pair, which ingest accepts.
    assert!(json.get("favicon").is_none());
}
