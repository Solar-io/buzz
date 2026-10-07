//! Test support: a fake OpenAI-compatible SSE server (plain tokio TCP).
//!
//! Each accepted connection consumes the next [`Script`] (the last one
//! repeats). Request bodies are captured so tests can assert what the
//! fast lane sent and HOW MANY requests it made.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// What the fake server does with one connection.
#[derive(Debug, Clone)]
pub enum Script {
    /// 200 + these `data:` payloads, each after its delay, then close.
    Stream(Vec<(Duration, String)>),
    /// Respond with this status and a short body.
    Status(u16),
    /// 200 headers, then nothing for a long time.
    Stall,
}

/// A running fake server.
pub struct FakeSse {
    /// `http://127.0.0.1:<port>`.
    pub base_url: String,
    requests: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl FakeSse {
    /// Requests received so far.
    pub fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    /// Captured JSON request bodies.
    pub fn bodies(&self) -> Vec<serde_json::Value> {
        self.bodies.lock().map(|b| b.clone()).unwrap_or_default()
    }
}

/// A `data:` payload carrying one text delta.
pub fn text_delta(text: &str) -> String {
    serde_json::json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})
        .to_string()
}

/// A `data:` payload carrying one reasoning delta.
pub fn reasoning_delta(text: &str) -> String {
    serde_json::json!({"choices":[{"index":0,"delta":{"reasoning_content":text},"finish_reason":null}]})
        .to_string()
}

/// The closing pair: a `finish_reason` chunk and `[DONE]`.
pub fn finish() -> Vec<(Duration, String)> {
    vec![
        (
            Duration::ZERO,
            serde_json::json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
                .to_string(),
        ),
        (Duration::ZERO, "[DONE]".to_string()),
    ]
}

/// A full streamed reply of `chunks`, `gap` apart, properly finished.
pub fn reply(chunks: &[&str], gap: Duration) -> Script {
    let mut items: Vec<(Duration, String)> =
        chunks.iter().map(|c| (gap, text_delta(c))).collect();
    items.extend(finish());
    Script::Stream(items)
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<serde_json::Value> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut req = httparse::Request::new(&mut headers);
        if let Ok(httparse::Status::Complete(head_len)) = req.parse(&buf) {
            let len = req
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("content-length"))
                .and_then(|h| std::str::from_utf8(h.value).ok())
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while buf.len() < head_len + len {
                let n = stream.read(&mut tmp).await.ok()?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            let end = (head_len + len).min(buf.len());
            return serde_json::from_slice(&buf[head_len..end]).ok();
        }
    }
}

/// Start a fake server running `scripts` in order (last repeats).
pub async fn spawn(scripts: Vec<Script>) -> FakeSse {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let requests = Arc::new(AtomicUsize::new(0));
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let (req_c, bodies_c) = (requests.clone(), bodies.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let n = req_c.fetch_add(1, Ordering::SeqCst);
            let script = scripts
                .get(n)
                .or_else(|| scripts.last())
                .cloned()
                .unwrap_or(Script::Status(500));
            let bodies = bodies_c.clone();
            tokio::spawn(async move {
                if let Some(body) = read_request(&mut stream).await {
                    if let Ok(mut b) = bodies.lock() {
                        b.push(body);
                    }
                }
                match script {
                    Script::Status(code) => {
                        let resp = format!(
                            "HTTP/1.1 {code} Err\r\ncontent-length: 5\r\nconnection: close\r\n\r\nerror"
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    }
                    Script::Stall => {
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
                            )
                            .await;
                        tokio::time::sleep(Duration::from_secs(120)).await;
                    }
                    Script::Stream(items) => {
                        if stream
                            .write_all(
                                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
                            )
                            .await
                            .is_err()
                        {
                            return;
                        }
                        for (delay, data) in items {
                            if !delay.is_zero() {
                                tokio::time::sleep(delay).await;
                            }
                            let frame = format!("data: {data}\n\n");
                            if stream.write_all(frame.as_bytes()).await.is_err() {
                                return;
                            }
                            let _ = stream.flush().await;
                        }
                    }
                }
                let _ = stream.shutdown().await;
            });
        }
    });
    FakeSse {
        base_url: format!("http://{addr}"),
        requests,
        bodies,
    }
}
