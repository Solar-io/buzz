//! Voice fast lane: the OpenAI-compatible streaming client.
//!
//! Spec: `~/.buzz/PLANS/VOICE_FAST_PATH_2026-10-07.md` §3.2 (`OmniRouteStream`),
//! §6 (failure handling). One pooled `reqwest::Client` per harness so the
//! TLS connection to OmniRoute stays warm across turns; each turn opens a
//! `POST {base}/v1/chat/completions` with `stream: true` and reads the SSE
//! body chunk by chunk (`Response::chunk`, no extra crate features).
//!
//! Text deltas (`choices[0].delta.content`) are yielded; reasoning deltas
//! (`reasoning_content` / `reasoning`) are COUNTED and never yielded — a
//! non-zero count means the provider ignored `reasoning_effort: "none"`, the
//! regression alarm for assumption A2.

use std::collections::VecDeque;
use std::time::Duration;

/// Errors from one streamed completion.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FastClientError {
    /// The endpoint answered with a non-2xx status.
    #[error("http {status}")]
    Http {
        /// The status code.
        status: u16,
    },
    /// Connect, TLS or read failure.
    #[error("transport: {0}")]
    Transport(String),
    /// The stream ended early or carried an error payload.
    #[error("protocol: {0}")]
    Protocol(String),
}

impl FastClientError {
    /// Short reason for `fallback reason=…` log lines.
    pub fn reason(&self) -> String {
        match self {
            FastClientError::Http { status } => format!("http_{status}"),
            FastClientError::Transport(_) => "transport".to_string(),
            FastClientError::Protocol(_) => "protocol".to_string(),
        }
    }
}

/// The pooled HTTP client for fast-lane calls (keep-alive, short connect
/// timeout; no overall timeout — the runner enforces first-token time).
pub fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// `{base}/v1/chat/completions`, tolerating a base that already ends in `/v1`.
pub fn completions_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

/// One parsed `data:` payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    /// A text delta to speak.
    Text(String),
    /// A reasoning delta of this many chars (counted, never spoken).
    Reasoning(usize),
    /// `finish_reason` was set.
    Finish,
    /// `data: [DONE]`.
    Done,
    /// An `{"error": …}` payload.
    Error(String),
}

/// Parse one SSE `data:` payload into zero or more items.
pub fn parse_sse_data(data: &str) -> Vec<SseItem> {
    let data = data.trim();
    if data == "[DONE]" {
        return vec![SseItem::Done];
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return Vec::new();
    };
    if let Some(error) = value.get("error") {
        return vec![SseItem::Error(error.to_string())];
    }
    let mut out = Vec::new();
    let Some(choice) = value.get("choices").and_then(|c| c.get(0)) else {
        return out;
    };
    if let Some(delta) = choice.get("delta") {
        for key in ["reasoning_content", "reasoning"] {
            if let Some(r) = delta.get(key).and_then(|v| v.as_str()) {
                if !r.is_empty() {
                    out.push(SseItem::Reasoning(r.chars().count()));
                }
            }
        }
        if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                out.push(SseItem::Text(text.to_string()));
            }
        }
    }
    if choice
        .get("finish_reason")
        .is_some_and(|f| !f.is_null())
    {
        out.push(SseItem::Finish);
    }
    out
}

/// Incremental SSE line splitter: bytes in, `data:` payloads out. Lines may
/// be split across network chunks (and UTF-8 sequences with them), so bytes
/// are buffered until a full `\n`-terminated line is available.
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    /// Feed bytes; returns the complete `data:` payloads they finished.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if let Some(data) = line.strip_prefix("data:") {
                out.push(data.trim_start().to_string());
            }
        }
        out
    }
}

/// One streamed completion.
pub struct FastCompletionStream {
    response: reqwest::Response,
    parser: SseParser,
    pending: VecDeque<String>,
    done: bool,
    finish_seen: bool,
    /// Reasoning characters seen so far (should stay 0).
    pub reasoning_chars: usize,
}

impl FastCompletionStream {
    /// Open the stream. Non-2xx is [`FastClientError::Http`].
    pub async fn open(
        client: &reqwest::Client,
        base_url: &str,
        api_key: &str,
        body: &serde_json::Value,
    ) -> Result<Self, FastClientError> {
        let response = client
            .post(completions_url(base_url))
            .bearer_auth(api_key)
            .header("accept", "text/event-stream")
            .json(body)
            .send()
            .await
            .map_err(|e| FastClientError::Transport(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(FastClientError::Http {
                status: status.as_u16(),
            });
        }
        Ok(Self {
            response,
            parser: SseParser::default(),
            pending: VecDeque::new(),
            done: false,
            finish_seen: false,
            reasoning_chars: 0,
        })
    }

    /// The next text delta, `Ok(None)` at a clean end (`[DONE]`, or EOF after
    /// a `finish_reason`). EOF without either is a protocol error — the
    /// stream died mid-reply.
    pub async fn next_text(&mut self) -> Result<Option<String>, FastClientError> {
        loop {
            if let Some(text) = self.pending.pop_front() {
                return Ok(Some(text));
            }
            if self.done {
                return Ok(None);
            }
            let chunk = self
                .response
                .chunk()
                .await
                .map_err(|e| FastClientError::Transport(e.to_string()))?;
            let Some(bytes) = chunk else {
                self.done = true;
                if self.finish_seen {
                    return Ok(None);
                }
                return Err(FastClientError::Protocol(
                    "stream ended before [DONE]".to_string(),
                ));
            };
            for data in self.parser.feed(&bytes) {
                for item in parse_sse_data(&data) {
                    match item {
                        SseItem::Text(text) => self.pending.push_back(text),
                        SseItem::Reasoning(n) => self.reasoning_chars += n,
                        SseItem::Finish => self.finish_seen = true,
                        SseItem::Done => self.done = true,
                        SseItem::Error(e) => return Err(FastClientError::Protocol(e)),
                    }
                }
            }
        }
    }
}

/// Resolve the fast-lane API key (spec §7), never logged:
/// 1. env `BUZZ_VOICE_FAST_API_KEY`;
/// 2. `~/.buzz/config/omniroute-keys.json[<display name>]`, the registry the
///    harness wrapper (`glm-env.sh`) uses for per-agent attribution keys.
///
/// The Infisical tier is [`resolve_api_key_infisical`] — async, because the
/// CLI can block on keychain access.
pub fn resolve_api_key_sync(agent_name: Option<&str>) -> Option<String> {
    if let Some(key) = std::env::var("BUZZ_VOICE_FAST_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
    {
        return Some(key);
    }
    let name = agent_name?.trim();
    if name.is_empty() {
        return None;
    }
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home).join(".buzz/config/omniroute-keys.json");
    let raw = std::fs::read_to_string(path).ok()?;
    key_from_registry(&raw, name)
}

/// Look `name` up in the key registry JSON (exact match first, then
/// case-insensitive).
pub fn key_from_registry(raw: &str, name: &str) -> Option<String> {
    let map: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = map.as_object()?;
    let value = obj.get(name).or_else(|| {
        obj.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v)
    })?;
    value
        .as_str()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

/// Last-resort key tier: `infisical secrets get OMNIROUTE_KEY_<AGENT>` with a
/// 3 s cap. `None` on any failure (missing CLI, keychain, timeout).
pub async fn resolve_api_key_infisical(agent_name: &str) -> Option<String> {
    let suffix: String = agent_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    let mut cmd = tokio::process::Command::new("infisical");
    cmd.args([
        "secrets",
        "get",
        &format!("OMNIROUTE_KEY_{suffix}"),
        "--plain",
        "--env=dev",
    ])
    .stdin(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(3), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .last()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
#[path = "voice_fast_client_tests.rs"]
mod tests;
