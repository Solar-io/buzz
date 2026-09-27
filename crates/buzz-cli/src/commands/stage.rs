//! `buzz stage` — Agent Stage Mode, the agent side.
//!
//! A deck is a PALETTE of frames (image + optional default paragraph +
//! optional local label). A session is a SEQUENCE OF SHOWINGS: each showing
//! is one ordinary kind-9 message: paragraph, `![image](url)`, one `imeta`
//! and one `["stage", …]` tag. A frame may be shown any number of times, in
//! any order. Design: `~/.buzz/PLANS/AGENT_STAGE_MODE_DESIGN_2026-09-26.md`
//! (§15 supersedes §9).
//!
//! Invariants this module owns:
//! - **Nothing is published until every image exists on the relay** — local
//!   files are uploaded and relay-URL images are HEAD-verified first. Any
//!   failure there exits non-zero with zero events.
//! - Every event goes through `messages::send_message`, so the send-path hold
//!   gate, mention preflight, tag ordering and session stamp are exactly
//!   `buzz messages send`'s. Showings carry no `e` tag (a reply would hide
//!   them from the main timeline).
//! - Labels live only in the local state file (`<base>/<openId>.json`,
//!   written atomically after every publish), never on the wire.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::{BlobDescriptor, BuzzClient, MediaHead};
use crate::commands::messages::{send_message, SendMessageParams, StageAttachment};
use crate::commands::stage_tag::{
    build_stage_tag, PaletteEntry, StageTag, STAGE_MAX_PARTS, STAGE_MAX_TITLE_CHARS,
};
use crate::error::CliError;

const STATE_VERSION: u32 = 1;
const MAX_LABEL_CHARS: usize = 200;

// ---------------------------------------------------------------------------
// I/O seam
// ---------------------------------------------------------------------------

/// Everything `buzz stage` does over the network. `BuzzClient` is the real
/// one; tests inject a fake that counts calls and fails on demand.
#[allow(async_fn_in_trait)]
pub(crate) trait StageBackend {
    fn relay_url(&self) -> &str;
    async fn resolve_channel(&self, channel: &str) -> Result<String, CliError>;
    async fn upload(&self, path: &Path) -> Result<BlobDescriptor, CliError>;
    async fn head_media(&self, url: &str) -> Result<Option<MediaHead>, CliError>;
    async fn send(&self, params: SendMessageParams) -> Result<Value, CliError>;
}

impl StageBackend for BuzzClient {
    fn relay_url(&self) -> &str {
        BuzzClient::relay_url(self)
    }
    async fn resolve_channel(&self, channel: &str) -> Result<String, CliError> {
        Ok(crate::channel_ref::resolve_channel_uuid(self, channel)
            .await?
            .to_string())
    }
    async fn upload(&self, path: &Path) -> Result<BlobDescriptor, CliError> {
        let path = path.to_string_lossy();
        self.upload_file(&path)
            .await
            .map_err(|e| CliError::Other(format!("upload failed for {path}: {e}")))
    }
    async fn head_media(&self, url: &str) -> Result<Option<MediaHead>, CliError> {
        BuzzClient::head_media(self, url).await
    }
    async fn send(&self, params: SendMessageParams) -> Result<Value, CliError> {
        send_message(self, params).await
    }
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeckFile {
    title: String,
    #[serde(default)]
    voice: Option<bool>,
    parts: Vec<DeckPartFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeckPartFile {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    text: Option<String>,
    image: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ImageSource {
    Local(PathBuf),
    /// Content-addressed blob already on this relay.
    Relay {
        url: String,
        sha256: String,
        ext: String,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct DeckPart {
    pub label: Option<String>,
    pub text: Option<String>,
    pub image: ImageSource,
}

#[derive(Debug, Clone)]
pub(crate) struct Deck {
    pub title: String,
    pub voice: bool,
    pub parts: Vec<DeckPart>,
}

fn usage(msg: impl Into<String>) -> CliError {
    CliError::Usage(msg.into())
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn is_blank(value: &str) -> bool {
    // Same explicit set as the wire contract (stage_tag.rs / stageTag.ts).
    value.chars().all(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Accept an image URL only when it is on the configured relay's media host
/// and content-addressed: `<relay scheme://host[:port]>/media/<sha256>.<ext>`.
pub(crate) fn relay_image_source(relay_url: &str, input: &str) -> Result<ImageSource, CliError> {
    let refuse = || {
        usage(format!(
            "image URL {input:?} is not a content-addressed media URL on this relay \
             ({relay_url}/media/<sha256>.<ext>); use a local file or a relay media URL"
        ))
    };
    let parsed = url::Url::parse(input).map_err(|_| refuse())?;
    let relay = url::Url::parse(relay_url).map_err(|_| refuse())?;
    if parsed.scheme() != relay.scheme()
        || parsed.host_str() != relay.host_str()
        || parsed.port_or_known_default() != relay.port_or_known_default()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(refuse());
    }
    let name = parsed.path().strip_prefix("/media/").ok_or_else(refuse)?;
    let (sha256, ext) = name.split_once('.').ok_or_else(refuse)?;
    let ext_ok = !ext.is_empty()
        && ext.len() <= 8
        && ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if !is_hex64(sha256) || !ext_ok {
        return Err(refuse());
    }
    Ok(ImageSource::Relay {
        url: input.to_string(),
        sha256: sha256.to_string(),
        ext: ext.to_string(),
    })
}

/// Parse and validate a deck. Pure: no network, no filesystem reads beyond
/// nothing (image paths are resolved against `deck_dir` but not opened —
/// `upload` reports a missing file, still before any publish).
pub(crate) fn parse_deck(
    raw: &str,
    deck_dir: &Path,
    relay_url: &str,
    voice_override: Option<bool>,
) -> Result<Deck, CliError> {
    let file: DeckFile =
        serde_json::from_str(raw).map_err(|e| usage(format!("deck: invalid JSON: {e}")))?;
    if is_blank(&file.title) || utf16_len(&file.title) > STAGE_MAX_TITLE_CHARS {
        return Err(usage(format!(
            "deck: title must be 1-{STAGE_MAX_TITLE_CHARS} characters and not blank"
        )));
    }
    if file.parts.is_empty() || file.parts.len() > STAGE_MAX_PARTS {
        return Err(usage(format!(
            "deck: needs 1-{STAGE_MAX_PARTS} parts (got {})",
            file.parts.len()
        )));
    }
    let mut labels: Vec<&str> = Vec::new();
    let mut parts = Vec::with_capacity(file.parts.len());
    for (i, part) in file.parts.iter().enumerate() {
        if let Some(label) = &part.label {
            if is_blank(label) || utf16_len(label) > MAX_LABEL_CHARS {
                return Err(usage(format!(
                    "deck: parts[{i}].label must be 1-{MAX_LABEL_CHARS} characters and not blank"
                )));
            }
            if labels.contains(&label.as_str()) {
                return Err(usage(format!("deck: duplicate label {label:?}")));
            }
            labels.push(label);
        }
        let image = part.image.trim();
        if image.is_empty() {
            return Err(usage(format!("deck: parts[{i}].image is required")));
        }
        let source = if image.contains("://") {
            relay_image_source(relay_url, image)?
        } else {
            let path = Path::new(image);
            ImageSource::Local(if path.is_absolute() {
                path.to_path_buf()
            } else {
                deck_dir.join(path)
            })
        };
        let text = part.text.clone().filter(|t| !is_blank(t));
        parts.push(DeckPart {
            label: part.label.clone(),
            text,
            image: source,
        });
    }
    Ok(Deck {
        title: file.title,
        voice: voice_override.or(file.voice).unwrap_or(true),
        parts,
    })
}

fn mime_from_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Upload / verify every frame's image. Returns one descriptor per part, in
/// order, or the first error — and in that case NOTHING has been published.
async fn prepare_media<B: StageBackend>(
    backend: &B,
    deck: &Deck,
) -> Result<Vec<BlobDescriptor>, CliError> {
    let total = deck.parts.len();
    let mut out = Vec::with_capacity(total);
    for (i, part) in deck.parts.iter().enumerate() {
        let desc = match &part.image {
            ImageSource::Local(path) => {
                eprintln!("stage: uploading {}/{total} {}", i + 1, path.display());
                backend.upload(path).await?
            }
            ImageSource::Relay { url, sha256, ext } => {
                eprintln!("stage: verifying {}/{total} {url}", i + 1);
                let head = backend
                    .head_media(url)
                    .await?
                    .ok_or_else(|| usage(format!("image blob not found on the relay: {url}")))?;
                let mime = head
                    .mime
                    .filter(|m| m.starts_with("image/"))
                    .or_else(|| mime_from_ext(ext).map(str::to_string))
                    .ok_or_else(|| usage(format!("{url} is not an image")))?;
                BlobDescriptor {
                    url: url.clone(),
                    sha256: sha256.clone(),
                    size: head.size.unwrap_or(0),
                    mime_type: mime,
                    uploaded: 0,
                    dim: None,
                    blurhash: None,
                    thumb: None,
                    duration: None,
                }
            }
        };
        if !desc.mime_type.starts_with("image/") {
            return Err(usage(format!(
                "parts[{i}] is {} — stage frames must be images",
                desc.mime_type
            )));
        }
        out.push(desc);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FrameState {
    pub i: usize,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    pub media: BlobDescriptor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ShowingState {
    pub event_id: String,
    pub i: usize,
    pub hold: bool,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct StageState {
    pub version: u32,
    pub session: String,
    pub channel: String,
    pub title: String,
    pub voice: bool,
    pub palette: Vec<FrameState>,
    pub showings: Vec<ShowingState>,
    pub closed: bool,
}

/// `$BUZZ_STAGE_DIR`, else `$HOME/.buzz/stage`.
pub(crate) fn default_state_dir() -> Result<PathBuf, CliError> {
    if let Ok(dir) = std::env::var("BUZZ_STAGE_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let home = std::env::var("HOME").map_err(|_| usage("HOME is not set"))?;
    Ok(Path::new(&home).join(".buzz").join("stage"))
}

fn state_path(base: &Path, session: &str) -> Result<PathBuf, CliError> {
    // The id becomes a filename: only a real event id may reach the path.
    if !is_hex64(session) {
        return Err(usage(
            "--session must be a stage open event id (64 lowercase hex)",
        ));
    }
    Ok(base.join(format!("{session}.json")))
}

pub(crate) fn save_state(base: &Path, state: &StageState) -> Result<(), CliError> {
    std::fs::create_dir_all(base)
        .map_err(|e| CliError::Other(format!("cannot create {}: {e}", base.display())))?;
    let path = state_path(base, &state.session)?;
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| CliError::Other(format!("state serialize failed: {e}")))?;
    crate::claims_gate::atomic_write(&path, &body)
        .map_err(|e| CliError::Other(format!("cannot write {}: {e}", path.display())))
}

pub(crate) fn load_state(base: &Path, session: &str) -> Result<StageState, CliError> {
    let path = state_path(base, session)?;
    let body = std::fs::read_to_string(&path).map_err(|e| {
        usage(format!(
            "no local stage state for session {session} ({}): {e} — \
             `stage show/next/close` must run on the machine that ran `stage open`",
            path.display()
        ))
    })?;
    let state: StageState = serde_json::from_str(&body)
        .map_err(|e| CliError::Other(format!("corrupt state file {}: {e}", path.display())))?;
    if state.version != STATE_VERSION || state.session != session {
        return Err(CliError::Other(format!(
            "state file {} does not match session {session}",
            path.display()
        )));
    }
    Ok(state)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Which frame to show.
#[derive(Debug, Clone)]
pub(crate) enum FrameSelector {
    Index(usize),
    Label(String),
}

pub(crate) fn resolve_frame(
    state: &StageState,
    selector: &FrameSelector,
) -> Result<usize, CliError> {
    match selector {
        FrameSelector::Index(i) if *i < state.palette.len() => Ok(*i),
        FrameSelector::Index(i) => Err(usage(format!(
            "--index {i} is out of range (palette has {} frames: 0-{})",
            state.palette.len(),
            state.palette.len().saturating_sub(1)
        ))),
        FrameSelector::Label(label) => state
            .palette
            .iter()
            .find(|f| f.label.as_deref() == Some(label.as_str()))
            .map(|f| f.i)
            .ok_or_else(|| {
                let known: Vec<&str> = state
                    .palette
                    .iter()
                    .filter_map(|f| f.label.as_deref())
                    .collect();
                usage(format!(
                    "unknown --label {label:?}; known labels: {known:?}"
                ))
            }),
    }
}

/// The lowest palette index never shown yet (what `next` posts).
pub(crate) fn next_unshown(state: &StageState) -> Option<usize> {
    (0..state.palette.len()).find(|i| !state.showings.iter().any(|s| s.i == *i))
}

/// `--dwell` value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Dwell {
    Auto,
    Fixed(Duration),
}

pub(crate) fn parse_dwell(raw: &str) -> Result<Dwell, CliError> {
    if raw == "auto" {
        return Ok(Dwell::Auto);
    }
    let secs: f64 = raw
        .parse()
        .map_err(|_| usage(format!("--dwell must be 'auto' or seconds, got {raw:?}")))?;
    if !secs.is_finite() || !(0.0..=3600.0).contains(&secs) {
        return Err(usage("--dwell seconds must be between 0 and 3600"));
    }
    Ok(Dwell::Fixed(Duration::from_secs_f64(secs)))
}

/// `auto` = max(4 s, chars × 65 ms + 1.5 s): roughly the spoken length, so a
/// phone timeline does not receive the whole deck at once.
pub(crate) fn dwell_for(dwell: Dwell, text: &str) -> Duration {
    match dwell {
        Dwell::Fixed(d) => d,
        Dwell::Auto => {
            let chars = text.chars().count() as u64;
            Duration::from_millis((chars * 65 + 1500).max(4000))
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn accepted_event_id(output: &Value) -> Result<String, CliError> {
    let accepted = output.get("accepted").and_then(Value::as_bool) == Some(true);
    let id = output.get("event_id").and_then(Value::as_str).unwrap_or("");
    if !accepted || !is_hex64(id) {
        return Err(CliError::Other(format!(
            "relay did not accept the stage event: {output}"
        )));
    }
    Ok(id.to_string())
}

fn send_params(
    channel: &str,
    content: String,
    tag: Vec<String>,
    media: Option<BlobDescriptor>,
    mentions: Vec<String>,
) -> SendMessageParams {
    SendMessageParams {
        channel_id: channel.to_string(),
        content,
        kind: None,
        reply_to: None, // never an `e` tag: showings must stay top-level
        broadcast: false,
        files: Vec::new(),
        mentions,
        supersede: false,
        card: None,
        stage: Some(StageAttachment { tag, media }),
    }
}

// ---------------------------------------------------------------------------
// Operations (generic over the backend so tests can inject one)
// ---------------------------------------------------------------------------

pub(crate) struct OpenArgs {
    pub channel: String,
    pub deck_raw: String,
    pub deck_dir: PathBuf,
    pub voice: Option<bool>,
    pub mentions: Vec<String>,
}

pub(crate) async fn open_session<B: StageBackend>(
    backend: &B,
    base: &Path,
    args: OpenArgs,
) -> Result<StageState, CliError> {
    // 1. Validate (pure) — a bad deck costs no network at all.
    let deck = parse_deck(
        &args.deck_raw,
        &args.deck_dir,
        backend.relay_url(),
        args.voice,
    )?;
    let channel = backend.resolve_channel(&args.channel).await?;
    // 2. Every image onto / verified on the relay, before anything is sent.
    let media = prepare_media(backend, &deck).await?;
    // 3. The manifest — `build_stage_tag` enforces the 8192-unit cap, still
    //    before any publish.
    let palette: Vec<PaletteEntry> = media
        .iter()
        .map(|d| PaletteEntry {
            x: d.sha256.clone(),
            url: d.url.clone(),
            m: d.mime_type.clone(),
            dim: d.dim.clone(),
        })
        .collect();
    let tag = build_stage_tag(&StageTag::Open {
        title: deck.title.clone(),
        voice: deck.voice,
        parts: palette,
    })?;
    let content = format!(
        "\u{1f3ac} Stage: {} \u{2014} {} frame{}. Open in the Buzz web app to watch.",
        deck.title,
        deck.parts.len(),
        if deck.parts.len() == 1 { "" } else { "s" }
    );
    // 4. Publish the open event.
    let output = backend
        .send(send_params(&channel, content, tag, None, args.mentions))
        .await?;
    let session = accepted_event_id(&output)?;
    // 5. Local state (labels live only here).
    let state = StageState {
        version: STATE_VERSION,
        session,
        channel,
        title: deck.title,
        voice: deck.voice,
        palette: deck
            .parts
            .into_iter()
            .zip(media)
            .enumerate()
            .map(|(i, (part, media))| FrameState {
                i,
                label: part.label,
                text: part.text,
                media,
            })
            .collect(),
        showings: Vec::new(),
        closed: false,
    };
    save_state(base, &state)?;
    Ok(state)
}

/// Post one showing of frame `i` and persist it.
async fn post_showing<B: StageBackend>(
    backend: &B,
    base: &Path,
    state: &mut StageState,
    i: usize,
    text: Option<String>,
    hold: bool,
) -> Result<String, CliError> {
    if state.closed {
        return Err(usage(format!("stage session {} is closed", state.session)));
    }
    let frame = state
        .palette
        .get(i)
        .ok_or_else(|| usage(format!("frame {i} is not in the palette")))?;
    let tag = build_stage_tag(&StageTag::Part {
        s: state.session.clone(),
        i,
        hold,
    })?;
    let content = text
        .filter(|t| !is_blank(t))
        .or_else(|| frame.text.clone())
        .unwrap_or_default();
    let output = backend
        .send(send_params(
            &state.channel,
            content,
            tag,
            Some(frame.media.clone()),
            Vec::new(),
        ))
        .await?;
    let event_id = accepted_event_id(&output)?;
    state.showings.push(ShowingState {
        event_id: event_id.clone(),
        i,
        hold,
        at: now_secs(),
    });
    save_state(base, state)?;
    Ok(event_id)
}

pub(crate) async fn show_frame<B: StageBackend>(
    backend: &B,
    base: &Path,
    session: &str,
    selector: FrameSelector,
    text: Option<String>,
    hold: bool,
) -> Result<Value, CliError> {
    let mut state = load_state(base, session)?;
    // Resolved before any network I/O: an unknown label publishes nothing.
    let i = resolve_frame(&state, &selector)?;
    let event_id = post_showing(backend, base, &mut state, i, text, hold).await?;
    Ok(serde_json::json!({
        "session": session,
        "shown": i,
        "label": state.palette[i].label,
        "hold": hold,
        "event_id": event_id,
        "showings": state.showings.len(),
    }))
}

pub(crate) async fn next_frames<B: StageBackend>(
    backend: &B,
    base: &Path,
    session: &str,
    count: usize,
) -> Result<Value, CliError> {
    let mut state = load_state(base, session)?;
    let mut posted = Vec::new();
    for _ in 0..count.max(1) {
        let Some(i) = next_unshown(&state) else {
            break;
        };
        post_showing(backend, base, &mut state, i, None, true).await?;
        posted.push(i);
    }
    let remaining = (0..state.palette.len())
        .filter(|i| !state.showings.iter().any(|s| s.i == *i))
        .count();
    if posted.is_empty() {
        return Err(CliError::Exhausted(format!(
            "every frame of session {session} has been shown; use `stage show` to show one again, or `stage close`"
        )));
    }
    Ok(serde_json::json!({ "posted": posted, "remaining": remaining }))
}

pub(crate) fn status_json(state: &StageState) -> Value {
    let palette: Vec<Value> = state
        .palette
        .iter()
        .map(|f| {
            let preview: String = f.text.as_deref().unwrap_or("").chars().take(80).collect();
            serde_json::json!({
                "i": f.i,
                "label": f.label,
                "text_preview": preview,
                "shown_count": state.showings.iter().filter(|s| s.i == f.i).count(),
            })
        })
        .collect();
    serde_json::json!({
        "session": state.session,
        "title": state.title,
        "channel": state.channel,
        "voice": state.voice,
        "closed": state.closed,
        "palette": palette,
        "showings": state.showings,
        "next_unshown": next_unshown(state),
    })
}

pub(crate) async fn close_session<B: StageBackend>(
    backend: &B,
    base: &Path,
    session: &str,
) -> Result<Value, CliError> {
    let mut state = load_state(base, session)?;
    if state.closed {
        return Err(usage(format!("stage session {session} is already closed")));
    }
    let tag = build_stage_tag(&StageTag::Close {
        s: session.to_string(),
    })?;
    let content = format!("\u{2014} end of Stage: {} \u{2014}", state.title);
    let output = backend
        .send(send_params(&state.channel, content, tag, None, Vec::new()))
        .await?;
    let event_id = accepted_event_id(&output)?;
    state.closed = true;
    save_state(base, &state)?;
    Ok(serde_json::json!({ "session": session, "closed": true, "event_id": event_id }))
}

fn open_output(state: &StageState) -> Value {
    let palette: Vec<Value> = state
        .palette
        .iter()
        .map(|f| serde_json::json!({ "i": f.i, "label": f.label }))
        .collect();
    serde_json::json!({
        "session": state.session,
        "total": state.palette.len(),
        "palette": palette,
    })
}

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

fn parse_on_off(flag: &str, raw: Option<&str>) -> Result<Option<bool>, CliError> {
    match raw {
        None => Ok(None),
        Some("on") => Ok(Some(true)),
        Some("off") => Ok(Some(false)),
        Some(other) => Err(usage(format!("{flag} must be on or off, got {other:?}"))),
    }
}

fn read_deck(spec: &str) -> Result<(String, PathBuf), CliError> {
    if spec == "-" {
        let mut raw = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw)
            .map_err(|e| usage(format!("--deck: cannot read stdin: {e}")))?;
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        return Ok((raw, cwd));
    }
    let path = Path::new(spec);
    let raw = std::fs::read_to_string(path)
        .map_err(|e| usage(format!("--deck: cannot read {spec}: {e}")))?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    Ok((raw, dir))
}

pub async fn dispatch(cmd: crate::StageCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::StageCmd;
    let base = default_state_dir()?;
    let output = match cmd {
        StageCmd::Open {
            channel,
            deck,
            voice,
            mentions,
        } => {
            let (deck_raw, deck_dir) = read_deck(&deck)?;
            let state = open_session(
                client,
                &base,
                OpenArgs {
                    channel,
                    deck_raw,
                    deck_dir,
                    voice: parse_on_off("--voice", voice.as_deref())?,
                    mentions,
                },
            )
            .await?;
            open_output(&state)
        }
        StageCmd::Show {
            session,
            index,
            label,
            text,
            hold,
        } => {
            let selector = match (index, label) {
                (Some(i), None) => FrameSelector::Index(i),
                (None, Some(l)) => FrameSelector::Label(l),
                _ => return Err(usage("pass exactly one of --index or --label")),
            };
            let text = match text {
                Some(t) => Some(crate::validate::read_or_stdin(&t)?),
                None => None,
            };
            let hold = parse_on_off("--hold", hold.as_deref())?.unwrap_or(false);
            show_frame(client, &base, &session, selector, text, hold).await?
        }
        StageCmd::Next { session, count } => next_frames(client, &base, &session, count).await?,
        StageCmd::Run {
            channel,
            deck,
            dwell,
            voice,
        } => {
            let dwell = parse_dwell(&dwell)?;
            let (deck_raw, deck_dir) = read_deck(&deck)?;
            let state = open_session(
                client,
                &base,
                OpenArgs {
                    channel,
                    deck_raw,
                    deck_dir,
                    voice: parse_on_off("--voice", voice.as_deref())?,
                    mentions: Vec::new(),
                },
            )
            .await?;
            println!("{}", open_output(&state));
            let session = state.session.clone();
            let total = state.palette.len();
            let mut state = state;
            for i in 0..total {
                post_showing(client, &base, &mut state, i, None, true).await?;
                eprintln!("stage: posted {}/{total}", i + 1);
                if i + 1 < total {
                    let text = state.palette[i].text.clone().unwrap_or_default();
                    tokio::time::sleep(dwell_for(dwell, &text)).await;
                }
            }
            serde_json::json!({ "session": session, "posted": total, "remaining": 0 })
        }
        StageCmd::Status { session } => status_json(&load_state(&base, &session)?),
        StageCmd::Close { session } => close_session(client, &base, &session).await?,
    };
    println!("{output}");
    Ok(())
}

#[cfg(test)]
#[path = "stage_tests.rs"]
mod tests;
