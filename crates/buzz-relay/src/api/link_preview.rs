//! Relay-side link-preview unfurl for **sender-side** preview authoring.
//!
//! Buzz link previews are sender-authored, not recipient-unfurled: the sender
//! resolves a linked page once, at send time, and writes the result into the
//! event as `link-preview` snapshot tags (validated on ingest by
//! [`crate::handlers::ingest`]). Readers render those tags and never contact
//! the linked site, so opening a channel cannot fan out HTTP requests to every
//! domain anyone has ever linked.
//!
//! A native client does that work in-process. A browser cannot: a cross-origin
//! page it did not author is unreadable, and the snapshot's image and favicon
//! must end up as blobs in *this* relay's media store for the ingest check to
//! accept them. This endpoint is the missing half — it performs the fetch the
//! sender would have performed, and returns media references the caller can
//! put straight into a snapshot tag.
//!
//! ## Why an HTTP route and not an event kind
//!
//! Buzz prefers modelling new operations as Nostr events. This one does not
//! fit that mould: it is a synchronous, request-scoped RPC whose result is
//! consumed by exactly one caller before the message it describes exists.
//! There is nothing to fan out, nothing to store, and nothing another member
//! should ever receive — publishing an unfurl request as an event would put a
//! third-party URL, and the relay's answer about it, into a channel's durable
//! history for everyone. It is the same shape as the GIF metadata proxy
//! ([`crate::api::gifs`]): a credentialed side-effectful lookup the relay
//! performs on a member's behalf.
//!
//! ## Server-side request forgery
//!
//! Fetching an attacker-supplied URL from inside the relay's network is an
//! SSRF primitive, so the fetch is fenced:
//!
//! * `https` only, no embedded credentials, port 443 only.
//! * DNS is resolved *first* and every resolved address is checked against
//!   [`buzz_core::network::is_private_ip`] — loopback, private, link-local
//!   (including `169.254.169.254`), CGNAT, unique-local IPv6 and the
//!   IPv4-mapped/translated/NAT64 spellings of all of those.
//! * The addresses that passed are then pinned into the HTTP client with
//!   `resolve_to_addrs`, so the connection goes to an address that was
//!   actually validated. A second DNS answer cannot be substituted between
//!   the check and the connect (DNS rebinding).
//! * Redirects are never followed by the HTTP client. Each hop comes back to
//!   [`Egress::send`], which is the single gate every outbound request passes
//!   through, so a hop is validated exactly like a fresh URL. The hop count is
//!   capped.
//! * Response size, per-request time, whole-request time, and server-wide
//!   concurrency are all bounded, so this cannot be used to amplify traffic at
//!   a third party.
//! * Only `title`, `site_name`, `description`, `og:image` and the favicon are
//!   read out of the page, and every byte is treated as hostile input.
//! * Images are re-decoded and re-encoded before they are stored, which drops
//!   metadata, rejects decompression bombs and animation, and guarantees the
//!   bytes really are an image.
//!
//! The gate is reachable in tests through [`Egress`], whose weakened
//! constructor is `#[cfg(test)]`-only: a production build cannot construct an
//! `Egress` that permits plaintext, non-default ports, or private addresses.

use std::io::Cursor;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
};
use buzz_auth::LimitType;
use buzz_media::BlobDescriptor;
use futures_util::StreamExt;
use image::ImageDecoder;
use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::state::AppState;

use super::{api_error, bridge, internal_error, relay_members};

/// Relay-relative path of the authenticated unfurl endpoint.
pub const UNFURL_PATH: &str = "/link-preview/unfurl";

/// Maximum HTML prefix read from a linked page. Metadata lives in `<head>`;
/// anything past this cannot contribute to a preview.
const MAX_PAGE_BYTES: usize = 256 * 1024;
/// Maximum bytes accepted for a preview image before decoding.
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// Maximum bytes accepted for a favicon.
const MAX_FAVICON_BYTES: usize = 512 * 1024;
/// Reject an image whose declared geometry is larger than this on either axis.
const MAX_IMAGE_DIMENSION: u32 = 4096;
/// Reject an image with more pixels than this (decompression bomb).
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
/// Longest edge of the stored, re-encoded preview image.
const MAX_STORED_DIMENSION: u32 = 1200;
/// Per-request ceiling for a single upstream round trip.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Ceiling for the whole unfurl, including image fetches and storage.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
/// Redirect hops followed before giving up.
const MAX_REDIRECTS: usize = 3;
/// Longest URL accepted from a caller.
const MAX_URL_LENGTH: usize = 2048;

/// Ingest caps (`validate_link_preview_tags`) are byte lengths; these are the
/// character budgets applied first so a multi-byte title is trimmed on a
/// character boundary rather than truncated into invalid UTF-8.
const MAX_TITLE_CHARS: usize = 180;
const MAX_TITLE_BYTES: usize = 300;
const MAX_SITE_CHARS: usize = 60;
const MAX_SITE_BYTES: usize = 100;
const MAX_DESCRIPTION_CHARS: usize = 280;
const MAX_DESCRIPTION_BYTES: usize = 1000;

const USER_AGENT_VALUE: &str = "Buzz Relay link preview";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Caller-supplied unfurl request.
#[derive(Debug, Deserialize)]
struct UnfurlRequest {
    /// The `https` URL to resolve. It must appear verbatim in the message the
    /// caller is about to send — the ingest check rejects a snapshot whose
    /// canonical URL is absent from the content — so it is echoed back
    /// unchanged rather than normalised.
    url: String,
}

/// A stored preview asset: a blob in this relay's media store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnfurlMedia {
    /// Absolute media URL on this community's host.
    pub url: String,
    /// Lowercase hex SHA-256 of the stored bytes.
    pub sha256: String,
}

/// Everything a caller needs to build a `link-preview` snapshot tag.
///
/// Field order matches tag positions 3..=10 so the mapping is obvious:
/// `["link-preview", "snapshot", "1", url, title, site, description,
/// image.url, image.sha256, favicon.url, favicon.sha256]`, with an absent
/// asset contributing two empty strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnfurlResponse {
    /// The requested URL, echoed byte-for-byte.
    pub url: String,
    /// Page title. Never empty — an untitled page yields no preview at all.
    pub title: String,
    /// `og:site_name`, or empty.
    pub site: String,
    /// `og:description`/`twitter:description`, or empty.
    pub description: String,
    /// Re-hosted preview image, absent when the page had none or it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<UnfurlMedia>,
    /// Re-hosted favicon, absent when the page had none or it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<UnfurlMedia>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why an unfurl stopped.
///
/// Deliberately coarse on the wire: a caller learns that its URL was refused,
/// never *which* internal address it resolved to. Refusal reasons are a probe
/// oracle if they are specific.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PreviewError {
    /// The URL, or a redirect hop, is not one this relay will fetch.
    Blocked(&'static str),
    /// The remote site failed, was too large, or answered with something
    /// unusable.
    Upstream(&'static str),
    /// Relay-side failure (storage, signing).
    Internal(&'static str),
}

impl PreviewError {
    fn into_response(self) -> (StatusCode, Json<Value>) {
        match self {
            Self::Blocked(message) => api_error(StatusCode::BAD_REQUEST, message),
            Self::Upstream(message) => api_error(StatusCode::BAD_GATEWAY, message),
            Self::Internal(message) => internal_error(message),
        }
    }

    /// Bounded metrics label — never the message, which is not a closed set.
    fn label(&self) -> &'static str {
        match self {
            Self::Blocked(_) => "blocked",
            Self::Upstream(_) => "upstream",
            Self::Internal(_) => "internal",
        }
    }
}

// ---------------------------------------------------------------------------
// Egress policy
// ---------------------------------------------------------------------------

/// Resolves a hostname to the addresses a request may be sent to.
///
/// Injected so tests can exercise the redirect loop, the size caps, and the
/// image pipeline against a local server without weakening the address gate
/// itself.
#[async_trait::async_trait]
pub(crate) trait HostResolver: Send + Sync + std::fmt::Debug {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, PreviewError>;
}

/// Production resolver: the system resolver, via Tokio's threadpool.
#[derive(Debug)]
struct SystemResolver;

#[async_trait::async_trait]
impl HostResolver for SystemResolver {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, PreviewError> {
        let addresses = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| PreviewError::Blocked("link preview host could not be resolved"))?
            .map(|address| address.ip())
            .collect::<Vec<_>>();
        Ok(addresses)
    }
}

/// The outbound-fetch policy: what may be dialled, and how a host becomes an
/// address.
///
/// [`Egress::public`] is the only constructor available to a production build.
#[derive(Clone, Debug)]
pub(crate) struct Egress {
    resolver: Arc<dyn HostResolver>,
    /// Address predicate. Production: [`buzz_core::network::is_private_ip`].
    blocked: fn(&IpAddr) -> bool,
    /// When set, only `https` on port 443 is dialled.
    require_tls: bool,
}

impl Egress {
    /// The production policy: system DNS, real private-address gate, TLS only.
    pub(crate) fn public() -> Self {
        Self {
            resolver: Arc::new(SystemResolver),
            blocked: buzz_core::network::is_private_ip,
            require_tls: true,
        }
    }

    /// Validate a URL and return the addresses the request may be sent to.
    ///
    /// Called for the caller's URL *and again for every redirect hop*: a
    /// redirect to `127.0.0.1` is the classic bypass of a hostname-only check.
    async fn validate(&self, url: &Url) -> Result<Vec<SocketAddr>, PreviewError> {
        if self.require_tls {
            if url.scheme() != "https" {
                return Err(PreviewError::Blocked("link previews require an https URL"));
            }
            if url.port().is_some_and(|port| port != 443) {
                return Err(PreviewError::Blocked(
                    "link previews require the default https port",
                ));
            }
        } else if !matches!(url.scheme(), "http" | "https") {
            return Err(PreviewError::Blocked("link previews require an https URL"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(PreviewError::Blocked(
                "link preview URLs must not carry credentials",
            ));
        }
        let host = url
            .host()
            .ok_or(PreviewError::Blocked("link preview URL has no host"))?;
        let port = url.port_or_known_default().unwrap_or(443);

        // An address literal is already an address: resolving it would mean
        // handing `[::1]` — brackets and all — to the resolver, which fails
        // for the wrong reason and would leave IPv6 literals untested by the
        // predicate below.
        let addresses = match host {
            url::Host::Ipv4(address) => vec![IpAddr::V4(address)],
            url::Host::Ipv6(address) => vec![IpAddr::V6(address)],
            url::Host::Domain(name) => self.resolver.resolve(name, port).await?,
        };
        if addresses.is_empty() {
            return Err(PreviewError::Blocked(
                "link preview host could not be resolved",
            ));
        }
        if addresses.iter().any(self.blocked) {
            return Err(PreviewError::Blocked(
                "link preview host resolves to a private or reserved address",
            ));
        }
        Ok(addresses
            .into_iter()
            .map(|address| SocketAddr::new(address, port))
            .collect())
    }

    /// Send one request, pinned to addresses this policy just validated.
    ///
    /// **This is the single egress gate.** Every outbound request — the first
    /// one, every redirect hop, the image, the favicon — goes through here,
    /// and each one re-runs [`Egress::validate`] immediately before dialling.
    /// Validating in one place is deliberate: a second gate elsewhere would
    /// make each of them individually removable without any test noticing,
    /// which is precisely how a redirect-to-`127.0.0.1` bypass survives a
    /// green suite.
    ///
    /// A fresh client per request is deliberate too: the pin is per-host, and
    /// a shared pool could hand back a connection opened for a different
    /// (possibly since-repointed) answer.
    async fn send(&self, url: &Url, accept: &str) -> Result<reqwest::Response, PreviewError> {
        let socket_addresses = self.validate(url).await?;
        let host = url
            .host_str()
            .ok_or(PreviewError::Blocked("link preview URL has no host"))?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(0)
            .timeout(REQUEST_TIMEOUT)
            .resolve_to_addrs(host, &socket_addresses)
            .build()
            .map_err(|_| PreviewError::Internal("link preview client could not be built"))?;

        client
            .get(url.as_str())
            .header(ACCEPT, accept)
            .header(USER_AGENT, USER_AGENT_VALUE)
            .send()
            .await
            .map_err(|_| PreviewError::Upstream("link preview request failed"))
    }
}

/// Resolve a `Location` header against the URL it was returned from.
///
/// Purely lexical, and purely a convenience: the resulting URL is not trusted
/// and is not dialled until [`Egress::send`] has put it through the gate. A
/// relative `Location` is legal and common, so this cannot be skipped.
fn join_redirect(current: &Url, location: &str) -> Result<Url, PreviewError> {
    current
        .join(location.trim())
        .map_err(|_| PreviewError::Upstream("link preview redirect was not a valid URL"))
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

fn content_mime(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        })
}

fn is_html(response: &reqwest::Response) -> bool {
    content_mime(response).is_some_and(|mime| {
        mime.eq_ignore_ascii_case("text/html") || mime.eq_ignore_ascii_case("application/xhtml+xml")
    })
}

/// Read at most `limit` bytes and stop. Used for the page, where a truncated
/// `<head>` is still useful.
async fn read_prefix(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, PreviewError> {
    let mut stream = response.bytes_stream();
    let mut bytes: Vec<u8> = Vec::new();
    while bytes.len() < limit {
        let Some(chunk) = stream.next().await else {
            break;
        };
        let chunk =
            chunk.map_err(|_| PreviewError::Upstream("link preview response could not be read"))?;
        let remaining = limit - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    Ok(bytes)
}

/// Read a whole body, refusing it outright once it crosses `limit`. Used for
/// images, where a truncated body is not an image.
async fn read_capped(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, PreviewError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(PreviewError::Upstream(
            "link preview response was too large",
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| PreviewError::Upstream("link preview response could not be read"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(PreviewError::Upstream(
                "link preview response was too large",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Fetch a page, following (and re-validating) up to [`MAX_REDIRECTS`] hops.
///
/// Returns the HTML prefix and the URL it was finally read from — the latter
/// is the base for resolving relative image and icon references, never the
/// value returned to the caller.
pub(crate) async fn fetch_page(egress: &Egress, start: Url) -> Result<(Url, String), PreviewError> {
    let mut url = start;
    for hop in 0..=MAX_REDIRECTS {
        let response = egress
            .send(&url, "text/html,application/xhtml+xml;q=0.9")
            .await?;

        if response.status().is_redirection() {
            if hop == MAX_REDIRECTS {
                return Err(PreviewError::Upstream(
                    "link preview followed too many redirects",
                ));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(PreviewError::Upstream(
                    "link preview redirect had no location",
                ))?
                .to_string();
            url = join_redirect(&url, &location)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(PreviewError::Upstream(
                "link preview page was not available",
            ));
        }
        if !is_html(&response) {
            return Err(PreviewError::Upstream("link preview target is not a page"));
        }
        let body = read_prefix(response, MAX_PAGE_BYTES).await?;
        return Ok((url, String::from_utf8_lossy(&body).into_owned()));
    }
    Err(PreviewError::Upstream(
        "link preview followed too many redirects",
    ))
}

/// A re-encoded image, ready to be stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SanitizedImage {
    bytes: Vec<u8>,
    /// `"jpg"` or `"png"` — the only two this endpoint ever stores.
    ext: &'static str,
}

/// Fetch and sanitize one image, re-validating every redirect hop.
pub(crate) async fn fetch_image(
    egress: &Egress,
    start: Url,
    limit: usize,
    keep_alpha: bool,
) -> Result<SanitizedImage, PreviewError> {
    let mut url = start;
    for hop in 0..=MAX_REDIRECTS {
        let response = egress.send(&url, "image/jpeg,image/png,image/webp").await?;
        if response.status().is_redirection() {
            if hop == MAX_REDIRECTS {
                return Err(PreviewError::Upstream(
                    "link preview image followed too many redirects",
                ));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(PreviewError::Upstream(
                    "link preview image redirect had no location",
                ))?
                .to_string();
            url = join_redirect(&url, &location)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(PreviewError::Upstream(
                "link preview image was not available",
            ));
        }
        let declared = content_mime(&response).ok_or(PreviewError::Upstream(
            "link preview image had no content type",
        ))?;
        if !matches!(
            declared.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "image/gif"
        ) {
            // Distinct from the sanitizer's "is not an image": this is the
            // header check, and a shared message would make the two
            // indistinguishable to a test (and to an operator reading logs).
            return Err(PreviewError::Upstream(
                "link preview image had an unsupported content type",
            ));
        }
        let bytes = read_capped(response, limit).await?;
        // Decoding is CPU-bound and attacker-influenced; keep it off the
        // async worker.
        return tokio::task::spawn_blocking(move || sanitize_image(&bytes, &declared, keep_alpha))
            .await
            .map_err(|_| PreviewError::Internal("link preview image task failed"))?;
    }
    Err(PreviewError::Upstream(
        "link preview image followed too many redirects",
    ))
}

/// Whether the container declares animation. Animated images are refused
/// rather than silently flattened to their first frame.
fn declares_animation(bytes: &[u8], format: image::ImageFormat) -> bool {
    match format {
        image::ImageFormat::Png => bytes.windows(4).any(|chunk| chunk == b"acTL"),
        image::ImageFormat::Gif => true,
        image::ImageFormat::WebP => {
            bytes.len() >= 21
                && bytes.starts_with(b"RIFF")
                && &bytes[8..12] == b"WEBP"
                && ((&bytes[12..16] == b"VP8X" && bytes[20] & 0x02 != 0)
                    || bytes.windows(4).any(|chunk| chunk == b"ANIM"))
        }
        _ => false,
    }
}

/// Decode and re-encode an image.
///
/// This is the step that makes a third-party byte string safe to store: the
/// magic bytes must agree with the declared type, the geometry is checked
/// before a full decode, the decoder is given explicit allocation limits, and
/// the output is a freshly encoded JPEG (or PNG when transparency matters).
/// Re-encoding also drops EXIF/XMP/ICC wholesale, which is what the media
/// store's metadata-free contract requires.
pub(crate) fn sanitize_image(
    bytes: &[u8],
    declared_mime: &str,
    keep_alpha: bool,
) -> Result<SanitizedImage, PreviewError> {
    let sniffed = infer::get(bytes)
        .map(|kind| kind.mime_type())
        .ok_or(PreviewError::Upstream("link preview image is not an image"))?;
    if sniffed != declared_mime {
        return Err(PreviewError::Upstream(
            "link preview image content type does not match its bytes",
        ));
    }
    let format = match sniffed {
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/png" => image::ImageFormat::Png,
        "image/webp" => image::ImageFormat::WebP,
        "image/gif" => image::ImageFormat::Gif,
        _ => return Err(PreviewError::Upstream("link preview image is not an image")),
    };
    if declares_animation(bytes, format) {
        return Err(PreviewError::Upstream(
            "animated link preview images are unsupported",
        ));
    }

    let mut decoder = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_decoder()
        .map_err(|_| PreviewError::Upstream("link preview image is malformed"))?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(PreviewError::Upstream(
            "link preview image dimensions exceed safe limits",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_PIXELS * 4);
    decoder
        .set_limits(limits)
        .map_err(|_| PreviewError::Upstream("link preview image exceeds safe decoding limits"))?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| PreviewError::Upstream("link preview image could not be decoded"))?;
    decoded.apply_orientation(orientation);
    let decoded = decoded.thumbnail(MAX_STORED_DIMENSION, MAX_STORED_DIMENSION);

    let mut output = Vec::new();
    if keep_alpha && decoded.color().has_alpha() {
        decoded
            .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)
            .map_err(|_| PreviewError::Internal("link preview image could not be re-encoded"))?;
        return Ok(SanitizedImage {
            bytes: output,
            ext: "png",
        });
    }
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 82)
        .encode_image(&decoded.to_rgb8())
        .map_err(|_| PreviewError::Internal("link preview image could not be re-encoded"))?;
    Ok(SanitizedImage {
        bytes: output,
        ext: "jpg",
    })
}

// ---------------------------------------------------------------------------
// HTML metadata extraction
// ---------------------------------------------------------------------------

/// The text half of a preview, before any image work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PageMetadata {
    pub(crate) title: String,
    pub(crate) site: String,
    pub(crate) description: String,
}

/// Pull `og:`/`twitter:`/`<title>` metadata out of an HTML prefix.
///
/// Returns `None` when there is no usable title: a card with no title is not
/// a preview, and the caller turns that into `204 No Content`.
pub(crate) fn extract_metadata(html: &str) -> Option<PageMetadata> {
    let title = meta_content(html, "property", "og:title")
        .or_else(|| meta_content(html, "name", "twitter:title"))
        .or_else(|| title_tag(html))
        .map(|value| clamp_line(&value, MAX_TITLE_CHARS, MAX_TITLE_BYTES))
        .filter(|value| !value.is_empty())?;
    let site = meta_content(html, "property", "og:site_name")
        .map(|value| clamp_line(&value, MAX_SITE_CHARS, MAX_SITE_BYTES))
        .unwrap_or_default();
    let description = meta_content(html, "property", "og:description")
        .or_else(|| meta_content(html, "name", "twitter:description"))
        .map(|value| clamp_paragraph(&value, MAX_DESCRIPTION_CHARS, MAX_DESCRIPTION_BYTES))
        .unwrap_or_default();
    Some(PageMetadata {
        title,
        site,
        description,
    })
}

/// Absolute URL of the page's preview image, if it declares one.
pub(crate) fn extract_image_url(html: &str, page_url: &Url) -> Option<Url> {
    let raw = meta_content(html, "property", "og:image")
        .or_else(|| meta_content(html, "property", "og:image:secure_url"))
        .or_else(|| meta_content(html, "name", "twitter:image"))?;
    page_url.join(raw.trim()).ok()
}

/// Absolute URL of the page's favicon, preferring a raster format the media
/// store can actually keep (`.ico` decodes to nothing useful here).
pub(crate) fn extract_favicon_url(html: &str, page_url: &Url) -> Option<Url> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0usize;
    let mut fallback = None;

    while let Some(offset) = lower[cursor..].find("<link") {
        let start = cursor + offset;
        let Some(close) = lower[start..].find('>') else {
            break;
        };
        let end = start + close + 1;
        let tag = &html[start..end];
        let is_icon = attr_value(tag, "rel").is_some_and(|rel| {
            rel.split_ascii_whitespace().any(|token| {
                token.eq_ignore_ascii_case("icon") || token.eq_ignore_ascii_case("apple-touch-icon")
            })
        });
        if is_icon {
            if let Some(href) = attr_value(tag, "href") {
                if let Ok(url) = page_url.join(href.trim()) {
                    let declared_raster = attr_value(tag, "type").is_some_and(|value| {
                        matches!(
                            value.to_ascii_lowercase().as_str(),
                            "image/jpeg" | "image/png" | "image/webp"
                        )
                    });
                    let path_raster = matches!(
                        url.path()
                            .rsplit_once('.')
                            .map(|(_, ext)| ext.to_ascii_lowercase())
                            .as_deref(),
                        Some("jpg" | "jpeg" | "png" | "webp")
                    );
                    if declared_raster || path_raster {
                        return Some(url);
                    }
                    fallback.get_or_insert(url);
                }
            }
        }
        cursor = end;
    }
    fallback
}

/// Find the content of the first `<meta>` tag whose `key_attr` is `key_value`
/// **and whose content is not blank**.
///
/// The blank check is load-bearing, not tidiness. Real pages ship
/// `<meta property="og:title" content="">` — rust-lang.org does — and treating
/// that as a value makes an `or_else` fallback chain dead code: the empty
/// string wins over the `<title>` tag that follows it, and the page ends up
/// with no preview at all. A blank value is not information, so it is skipped
/// and the scan continues (a page may repeat a key, blank first).
fn meta_content(html: &str, key_attr: &str, key_value: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(offset) = lower[cursor..].find("<meta") {
        let start = cursor + offset;
        let Some(close) = lower[start..].find('>') else {
            break;
        };
        let end = start + close + 1;
        let tag = &html[start..end];
        if attr_value(tag, key_attr).is_some_and(|value| value.eq_ignore_ascii_case(key_value)) {
            if let Some(content) = attr_value(tag, "content") {
                if !content.trim().is_empty() {
                    return Some(content);
                }
            }
        }
        cursor = end;
    }
    None
}

fn title_tag(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let content_start = start + lower[start..].find('>')? + 1;
    let content_end = content_start + lower[content_start..].find("</title>")?;
    Some(decode_entities(&html[content_start..content_end]))
}

/// Read one attribute out of a single tag.
///
/// Deliberately not a general HTML parser: this only ever looks inside one
/// already-delimited `<meta>`/`<link>` tag, and a name boundary check stops
/// `property` from matching inside `data-property`.
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let attr = attr.to_ascii_lowercase();
    let mut cursor = 0usize;

    while let Some(offset) = lower[cursor..].find(&attr) {
        let name_start = cursor + offset;
        let name_end = name_start + attr.len();
        let before = lower[..name_start].chars().last();
        let after = lower[name_end..].chars().next();
        let bounded = !matches!(before, Some(c) if c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !matches!(after, Some(c) if c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if bounded {
            let rest = &tag[name_end..];
            let equals = rest.find('=')?;
            let value = rest[equals + 1..].trim_start();
            let quote = value.chars().next()?;
            if quote == '"' || quote == '\'' {
                let body = &value[quote.len_utf8()..];
                let close = body.find(quote)?;
                return Some(decode_entities(&body[..close]));
            }
            let close = value
                .find(|c: char| c.is_ascii_whitespace() || c == '>')
                .unwrap_or(value.len());
            return Some(decode_entities(&value[..close]));
        }
        cursor = name_end;
    }
    None
}

fn decode_entities(value: &str) -> String {
    let mut decoded = value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");

    let mut from = 0usize;
    while let Some(start) = decoded[from..].find("&#").map(|offset| from + offset) {
        let Some(close) = decoded[start..].find(';').map(|offset| start + offset + 1) else {
            break;
        };
        let entity = &decoded[start + 2..close - 1];
        let parsed = entity
            .strip_prefix(['x', 'X'])
            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
            .or_else(|| entity.parse::<u32>().ok());
        let Some(character) = parsed.and_then(char::from_u32) else {
            from = start + 2;
            continue;
        };
        let replacement = character.to_string();
        decoded.replace_range(start..close, &replacement);
        from = start + replacement.len();
    }
    decoded
}

/// Replace control characters with a space so they separate words rather than
/// silently welding them together — `"Title\0here"` must not become
/// `"Titlehere"`. `\n` survives when the caller keeps paragraphs.
fn scrub(raw: &str, keep_newlines: bool) -> String {
    raw.chars()
        .map(|character| {
            if character.is_control() && !(keep_newlines && character == '\n') {
                ' '
            } else {
                character
            }
        })
        .collect()
}

/// Collapse a value to a single line the ingest text check will accept, then
/// clamp it to the character and byte budgets.
fn clamp_line(raw: &str, max_chars: usize, max_bytes: usize) -> String {
    let collapsed = scrub(raw, false)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    clamp(&collapsed, max_chars, max_bytes)
}

/// As [`clamp_line`], but paragraph breaks survive — a description may carry
/// `\n`, which is the one control character ingest permits there.
fn clamp_paragraph(raw: &str, max_chars: usize, max_bytes: usize) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let collapsed = scrub(&normalized, true)
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n");
    clamp(collapsed.trim(), max_chars, max_bytes)
}

/// Trim to fit both budgets on a character boundary. Byte length is what
/// ingest measures; characters are what a reader perceives, so both are
/// enforced.
fn clamp(value: &str, max_chars: usize, max_bytes: usize) -> String {
    let mut out: String = value.chars().take(max_chars).collect();
    while out.len() > max_bytes {
        out.pop();
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// Media storage
// ---------------------------------------------------------------------------

/// Store a sanitized image in this community's media store.
///
/// The Blossom auth event is signed by the *relay*, because the relay is the
/// party that fetched these bytes; the requesting member never handled them.
/// Attribution to that member is recorded in the audit log by the caller, so
/// moderation can still reach the person who asked for the unfurl.
async fn store_image(
    state: &AppState,
    tenant: &buzz_core::TenantContext,
    image: &SanitizedImage,
) -> Result<UnfurlMedia, PreviewError> {
    use sha2::{Digest, Sha256};

    let sha256 = hex::encode(Sha256::digest(&image.bytes));
    let expiration = (chrono::Utc::now().timestamp() + 600).to_string();
    let auth_event = nostr::EventBuilder::new(nostr::Kind::from(24242u16), "Store link preview")
        .tags([
            nostr::Tag::parse(["t", "upload"])
                .map_err(|_| PreviewError::Internal("link preview auth tag"))?,
            nostr::Tag::parse(["x", sha256.as_str()])
                .map_err(|_| PreviewError::Internal("link preview auth tag"))?,
            nostr::Tag::parse(["expiration", expiration.as_str()])
                .map_err(|_| PreviewError::Internal("link preview auth tag"))?,
            nostr::Tag::parse(["server", tenant.host()])
                .map_err(|_| PreviewError::Internal("link preview auth tag"))?,
        ])
        .sign_with_keys(&state.relay_keypair)
        .map_err(|_| PreviewError::Internal("link preview auth event could not be signed"))?;

    let serving_write =
        buzz_deletion::acquire_serving_write(&state.db, tenant.community(), "link_preview_media")
            .await
            .map_err(|_| PreviewError::Internal("link preview media store is unavailable"))?;
    serving_write
        .verify()
        .await
        .map_err(|_| PreviewError::Internal("link preview media lease was lost"))?;

    let bytes = bytes::Bytes::from(image.bytes.clone());
    let descriptor: BlobDescriptor = serving_write
        .protect(buzz_media::process_upload(
            &state.media_storage,
            &state.config.media,
            tenant,
            &auth_event,
            bytes,
            None,
        ))
        .await
        .map_err(|_| PreviewError::Internal("link preview media lease was lost"))?
        .map_err(|error: buzz_media::MediaError| {
            tracing::warn!(%error, "link preview image was rejected by the media store");
            PreviewError::Upstream("link preview image could not be stored")
        })?;

    serving_write
        .finish()
        .await
        .map_err(|_| PreviewError::Internal("link preview media lease was lost"))?;

    // Same construction as the upload route's descriptor rewrite: the blob is
    // addressed on the *tenant's* host, which is the origin the ingest check
    // compares against.
    let base = super::media::media_base_url_for_tenant(&state.config.relay_url, tenant.host());
    Ok(UnfurlMedia {
        url: format!("{base}/{}.{}", descriptor.sha256, image.ext),
        sha256: descriptor.sha256,
    })
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/// NIP-98 + community membership, identical in shape to the GIF proxy's door.
///
/// Kept local rather than shared with [`crate::api::gifs`]: hoisting it would
/// mean editing that module, and these are the only two callers. If a third
/// appears, promote it to `api::bridge`.
async fn authenticate(
    state: &Arc<AppState>,
    headers: &HeaderMap,
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

    let expected_url = bridge::nip98_expected_url(&state.config.relay_url, &tenant, UNFURL_PATH);
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

/// Per-pubkey quota. An unfurl costs an outbound page fetch plus up to two
/// image fetches and two stored blobs, so it is metered separately from
/// ordinary API calls.
async fn enforce_unfurl_admission(
    state: &AppState,
    tenant: &buzz_core::TenantContext,
    pubkey: &nostr::PublicKey,
) -> Result<(), (StatusCode, Json<Value>)> {
    let limit = state.auth.config().rate_limits.link_previews_per_min;
    match crate::admission::check_principal(
        state.admission_rate_limiter.as_ref(),
        tenant,
        pubkey,
        LimitType::LinkPreviews,
        60,
        limit,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(crate::admission::AdmissionError::Exceeded { reset_in_secs }) => {
            metrics::counter!("buzz_link_preview_rejections_total", "reason" => "quota")
                .increment(1);
            Err(api_error(
                StatusCode::TOO_MANY_REQUESTS,
                &format!("rate-limited: link preview quota exceeded; retry in {reset_in_secs}s"),
            ))
        }
        Err(crate::admission::AdmissionError::Unavailable) => Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "rate-limited: link preview admission unavailable",
        )),
    }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Parse and gate the caller's URL before anything is dialled.
pub(crate) fn parse_request_url(raw: &str) -> Result<Url, PreviewError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_URL_LENGTH {
        return Err(PreviewError::Blocked("link preview URL is not usable"));
    }
    let parsed = Url::parse(trimmed)
        .map_err(|_| PreviewError::Blocked("link preview URL could not be parsed"))?;
    if parsed.scheme() != "https" {
        return Err(PreviewError::Blocked("link previews require an https URL"));
    }
    Ok(parsed)
}

/// Resolve one URL into a storable preview.
///
/// Split from the handler so the whole pipeline — fetch, parse, image fetch,
/// sanitize, store — is exercised by tests through an injected [`Egress`].
pub(crate) async fn unfurl_with_egress(
    state: &Arc<AppState>,
    tenant: &buzz_core::TenantContext,
    egress: &Egress,
    requested: &str,
    start: Url,
) -> Result<Option<UnfurlResponse>, PreviewError> {
    let (page_url, html) = fetch_page(egress, start).await?;
    let Some(metadata) = extract_metadata(&html) else {
        return Ok(None);
    };

    let image_url = extract_image_url(&html, &page_url);
    let favicon_url = extract_favicon_url(&html, &page_url);

    // A missing or hostile image must not lose the whole preview: the text
    // half is still a useful card, and the tag's media pair is allowed to be
    // empty. Failures are dropped, not surfaced.
    let image = match image_url {
        Some(url) => fetch_image(egress, url, MAX_IMAGE_BYTES, false).await.ok(),
        None => None,
    };
    let favicon = match favicon_url {
        Some(url) => fetch_image(egress, url, MAX_FAVICON_BYTES, true).await.ok(),
        None => None,
    };

    let stored_image = match image {
        Some(image) => store_image(state, tenant, &image).await.ok(),
        None => None,
    };
    let stored_favicon = match favicon {
        Some(favicon) => store_image(state, tenant, &favicon).await.ok(),
        None => None,
    };

    Ok(Some(UnfurlResponse {
        url: requested.to_string(),
        title: metadata.title,
        site: metadata.site,
        description: metadata.description,
        image: stored_image,
        favicon: stored_favicon,
    }))
}

/// `POST /link-preview/unfurl` — resolve a URL into snapshot-tag material.
///
/// Requires NIP-98 auth (with a body digest) and community membership, exactly
/// like the other bridge routes. Returns `204 No Content` when the page yields
/// no usable preview, so a caller can distinguish "nothing to show" from an
/// error and send the message with a bare link.
pub async fn unfurl(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let (tenant, pubkey) = authenticate(&state, &headers, &body).await?;
    let request: UnfurlRequest = serde_json::from_slice(&body)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid link preview JSON"))?;
    enforce_unfurl_admission(&state, &tenant, &pubkey).await?;

    // Server-wide ceiling on outbound unfurls. Without it, N members could
    // aim the relay at one third party at once — an amplifier, and a way to
    // exhaust the relay's own sockets.
    let Ok(_permit) = state
        .link_preview_semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            metrics::counter!("buzz_link_preview_rejections_total", "reason" => "concurrency")
                .increment(1);
        })
    else {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "link preview capacity is exhausted; retry shortly",
        ));
    };

    let requested = request.url.trim().to_string();
    let start = parse_request_url(&requested).map_err(|error| {
        metrics::counter!("buzz_link_preview_rejections_total", "reason" => error.label())
            .increment(1);
        error.into_response()
    })?;

    let egress = Egress::public();
    let outcome = tokio::time::timeout(
        TOTAL_TIMEOUT,
        unfurl_with_egress(&state, &tenant, &egress, &requested, start),
    )
    .await
    .unwrap_or(Err(PreviewError::Upstream("link preview timed out")));

    match outcome {
        Ok(Some(response)) => {
            metrics::counter!("buzz_link_preview_unfurls_total", "result" => "ok").increment(1);
            audit_unfurl(&state, &tenant, &pubkey, &response);
            Ok(Json(response).into_response())
        }
        Ok(None) => {
            metrics::counter!("buzz_link_preview_unfurls_total", "result" => "empty").increment(1);
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Err(error) => {
            metrics::counter!("buzz_link_preview_rejections_total", "reason" => error.label())
                .increment(1);
            Err(error.into_response())
        }
    }
}

/// Record who asked for an unfurl and what it stored.
///
/// The blobs are signed into the media store by the relay key, so this is the
/// only place the requesting member is bound to them. Best-effort, on the
/// audit channel the media route already uses.
fn audit_unfurl(
    state: &AppState,
    tenant: &buzz_core::TenantContext,
    pubkey: &nostr::PublicKey,
    response: &UnfurlResponse,
) {
    let Some(audit_tx) = &state.audit_tx else {
        return;
    };
    let entry = buzz_audit::NewAuditEntry {
        community_id: tenant.community(),
        action: buzz_audit::AuditAction::MediaUploaded,
        actor_pubkey: Some(pubkey.to_bytes().to_vec()),
        object_id: response.image.as_ref().map(|media| media.sha256.clone()),
        detail: serde_json::json!({
            "source": "link_preview",
            "url": response.url,
            "image_sha256": response.image.as_ref().map(|media| media.sha256.clone()),
            "favicon_sha256": response.favicon.as_ref().map(|media| media.sha256.clone()),
        }),
    };
    if audit_tx.try_send(entry).is_err() {
        metrics::counter!("buzz_audit_send_errors_total").increment(1);
    }
}

#[cfg(test)]
#[path = "link_preview_tests.rs"]
mod tests;
