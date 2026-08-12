//! Production authorization-boundary tests for the `session/request_permission`
//! surface.
//!
//! These drive a real `buzz-agent` subprocess against a fake MCP server and a
//! capturing LLM, and prove the security invariant end to end: an LLM-issued
//! MCP tool call reaches the server IFF the client selected the offered
//! allow-once option, and every other outcome fails closed without invoking the
//! tool. `fake_mcp` appends each invoked *bare* tool name to `FAKE_MCP_CALL_LOG`
//! (fired for `_Stop`/`_PostCompact` too), so "reached the tool exactly once"
//! and "never reached the tool" are both directly observable from disk.
//!
//! Timeout/abort/multi-session-cap state invariants live in the broker-seam unit
//! tests (`src/permission.rs`), which use an injectable deadline and inspect the
//! private correlation map — neither of which a subprocess can do.
//!
//! The `Harness` is copied from `regressions.rs`: each integration test file is
//! its own binary, so a self-contained harness is the established convention.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

// ─────────────────────────────────────────────────────────────────────────────
// Capturing LLM
// ─────────────────────────────────────────────────────────────────────────────

struct CapturingLlm {
    url: String,
    #[allow(dead_code)]
    captured: Arc<Mutex<Vec<Value>>>,
}

async fn spawn_capturing_llm(responses: Vec<Value>) -> CapturingLlm {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let queue = Arc::new(Mutex::new(VecDeque::from(responses)));
    let captured: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let cap2 = captured.clone();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = match listener.accept().await {
                Ok(p) => p,
                Err(_) => return,
            };
            let queue = queue.clone();
            let captured = cap2.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 8192];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                    if buf.len() > 4_000_000 {
                        return;
                    }
                }
                let header_end = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
                let headers = &buf[..header_end];
                let mut body_len = 0usize;
                for line in headers.split(|b| *b == b'\n') {
                    let line = std::str::from_utf8(line).unwrap_or("");
                    if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        body_len = rest.trim().trim_end_matches('\r').parse().unwrap_or(0);
                    }
                }
                while buf.len() < header_end + body_len {
                    match sock.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                }
                if let Ok(req) = serde_json::from_slice::<Value>(&buf[header_end..]) {
                    captured.lock().await.push(req);
                }
                let body = queue
                    .lock()
                    .await
                    .pop_front()
                    .unwrap_or_else(|| json!({ "error": "no canned response" }));
                let body_s = serde_json::to_string(&body).unwrap();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body_s.len(),
                    body_s,
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    CapturingLlm { url, captured }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subprocess harness
// ─────────────────────────────────────────────────────────────────────────────

struct Harness {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    stderr: Arc<StdMutex<String>>,
    next_id: i64,
}

impl Harness {
    async fn spawn_with_env(base_url: &str, extra: &[(&str, &str)]) -> Self {
        let bin = env!("CARGO_BIN_EXE_buzz-agent");
        let mut cmd = tokio::process::Command::new(bin);
        cmd.env("BUZZ_AGENT_PROVIDER", "openai")
            .env("OPENAI_COMPAT_API_KEY", "test")
            .env("OPENAI_COMPAT_MODEL", "fake-model")
            .env("OPENAI_COMPAT_BASE_URL", base_url)
            .env("BUZZ_AGENT_LLM_TIMEOUT_SECS", "5")
            .env("BUZZ_AGENT_TOOL_TIMEOUT_SECS", "5")
            .env("BUZZ_AGENT_MAX_ROUNDS", "8")
            .env("BUZZ_AGENT_MCP_INIT_TIMEOUT_SECS", "2");
        for (k, v) in extra {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn buzz-agent");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let stderr = child.stderr.take().unwrap();
        let stderr_buf = Arc::new(StdMutex::new(String::new()));
        let stderr_out = Arc::clone(&stderr_buf);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                let n = match reader.read_line(&mut line).await {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break;
                }
                if let Ok(mut out) = stderr_out.lock() {
                    out.push_str(&line);
                }
            }
        });
        Self {
            child,
            stdin,
            stdout,
            stderr: stderr_buf,
            next_id: 1,
        }
    }

    async fn spawn(base_url: &str) -> Self {
        Self::spawn_with_env(base_url, &[]).await
    }

    async fn send(&mut self, method: &str, params: Value) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        id
    }

    async fn notify(&mut self, method: &str, params: Value) {
        self.write(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await;
    }

    async fn write(&mut self, msg: Value) {
        let mut s = serde_json::to_string(&msg).unwrap();
        s.push('\n');
        self.stdin.write_all(s.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn recv(&mut self) -> Value {
        let mut line = String::new();
        let n = tokio::time::timeout(Duration::from_secs(15), self.stdout.read_line(&mut line))
            .await
            .expect("recv timeout")
            .expect("read line");
        assert!(n > 0, "agent EOF; stderr={}", self.stderr_text());
        serde_json::from_str(&line).expect("non-JSON line")
    }

    async fn recv_until<F: FnMut(&Value) -> bool>(&mut self, mut pred: F) -> Value {
        loop {
            let v = self.recv().await;
            if pred(&v) {
                return v;
            }
        }
    }

    async fn shutdown(mut self) {
        drop(self.stdin);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        let _ = self.child.start_kill();
    }

    fn stderr_text(&self) -> String {
        self.stderr.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM response builders
// ─────────────────────────────────────────────────────────────────────────────

fn openai_text(content: &str) -> Value {
    json!({
        "id": "cc-1", "object": "chat.completion", "model": "fake-model",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": "stop",
        }],
    })
}

/// One assistant turn issuing `calls`, each `(id, qualified_name, arguments)`.
fn openai_tool_calls(calls: &[(&str, &str, Value)]) -> Value {
    let tool_calls: Vec<Value> = calls
        .iter()
        .map(|(id, name, args)| {
            json!({
                "id": id, "type": "function",
                "function": { "name": name, "arguments": args.to_string() },
            })
        })
        .collect();
    json!({
        "id": "cc-tc", "object": "chat.completion", "model": "fake-model",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": null, "tool_calls": tool_calls },
            "finish_reason": "tool_calls",
        }],
    })
}

fn shell_call(id: &str) -> Value {
    openai_tool_calls(&[(id, "fake__shell", json!({ "command": "ls" }))])
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission-response builders + drivers
// ─────────────────────────────────────────────────────────────────────────────

/// Answer a permission request by selecting the offered option whose
/// `kind == "allow_once"` — mirroring buzz-acp's answering side, never a
/// hardcoded `optionId`. A future option-id rename can't silently deny.
fn approve(req: &Value) -> Value {
    let option_id = req["params"]["options"]
        .as_array()
        .and_then(|opts| opts.iter().find(|o| o["kind"] == "allow_once"))
        .and_then(|o| o["optionId"].as_str())
        .expect("request must offer an allow_once option");
    resp_selected(&req["id"], option_id)
}

/// Bare JSON-RPC response selecting `option_id`.
fn resp_selected(id: &Value, option_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.clone(),
        "result": { "outcome": { "outcome": "selected", "optionId": option_id } },
    })
}

/// Bare JSON-RPC response carrying an arbitrary `result` shape.
fn resp_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.clone(), "result": result })
}

/// Bare JSON-RPC *error* response (id present, `error`, no `result`).
fn resp_error(id: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.clone(),
        "error": { "code": -32601, "message": "method not found" },
    })
}

/// The tool title carried by a permission request, across both wire shapes.
fn perm_title(req: &Value) -> String {
    let p = &req["params"];
    p["title"]
        .as_str()
        .or_else(|| p["toolCall"]["title"].as_str())
        .or_else(|| p["subject"]["toolCall"]["title"].as_str())
        .unwrap_or("")
        .to_owned()
}

/// Drive one prompt to completion. For each `session/request_permission`,
/// `decide(&req)` returns `Some(response)` to answer or `None` to leave it
/// unanswered. Returns the final prompt response and every request seen.
async fn drive(
    h: &mut Harness,
    sid: &str,
    prompt: &str,
    mut decide: impl FnMut(&Value) -> Option<Value>,
) -> (Value, Vec<Value>) {
    let p = h
        .send(
            "session/prompt",
            json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": prompt }] }),
        )
        .await;
    let mut requests: Vec<Value> = Vec::new();
    loop {
        let v = h.recv().await;
        if v.get("method") == Some(&json!("session/request_permission")) {
            requests.push(v.clone());
            if let Some(resp) = decide(&v) {
                h.write(resp).await;
            }
            continue;
        }
        if v["id"] == json!(p) {
            return (v, requests);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session init + call-log helpers
// ─────────────────────────────────────────────────────────────────────────────

fn call_log_path(tag: &str) -> String {
    let p = std::env::temp_dir().join(format!(
        "buzz_perm_calllog_{tag}_{}_{:x}.log",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let s = p.to_string_lossy().to_string();
    let _ = std::fs::remove_file(&s);
    s
}

/// Invoked tool names recorded by fake_mcp (bare names, one per `tools/call`).
/// A missing file means zero invocations.
fn call_log_lines(path: &str) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Initialize + create a session with a single fake MCP server named `fake`,
/// negotiating `protocol_version` and passing `mcp_env` to the server. `cwd`
/// controls skill discovery (`.agents/skills`).
async fn init(
    h: &mut Harness,
    protocol_version: u32,
    cwd: &str,
    mcp_env: &[(&str, &str)],
) -> String {
    let fake_mcp = env!("CARGO_BIN_EXE_fake-mcp");
    let env: Vec<Value> = mcp_env
        .iter()
        .map(|(k, v)| json!({ "name": k, "value": v }))
        .collect();
    h.send(
        "initialize",
        json!({ "protocolVersion": protocol_version, "clientCapabilities": {} }),
    )
    .await;
    let _ = h.recv().await;
    let servers = if mcp_env.is_empty() {
        json!([])
    } else {
        json!([{ "name": "fake", "command": fake_mcp, "args": [], "env": env }])
    };
    h.send("session/new", json!({ "cwd": cwd, "mcpServers": servers }))
        .await;
    let r = h
        .recv_until(|v| v.get("result").is_some() || v.get("error").is_some())
        .await;
    r["result"]["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("session/new failed: {r}, stderr={}", h.stderr_text()))
        .to_owned()
}

fn stop_reason(resp: &Value) -> String {
    resp["result"]["stopReason"]
        .as_str()
        .unwrap_or("")
        .to_owned()
}

// ═════════════════════════════════════════════════════════════════════════════
// The authorization boundary
// ═════════════════════════════════════════════════════════════════════════════

/// Exact allow reaches the tool exactly once — and never *before* approval.
/// The pre-approval check proves the gate precedes the MCP call, not just that
/// the tally ends at one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_allow_reaches_tool_exactly_once_and_not_before_approval() {
    let log = call_log_path("allow");
    let llm = spawn_capturing_llm(vec![shell_call("tc1"), openai_text("done")]).await;
    let mut h = Harness::spawn(&llm.url).await;
    let sid = init(
        &mut h,
        1,
        "/tmp",
        &[("FAKE_MCP_SHELL_TOOL", "1"), ("FAKE_MCP_CALL_LOG", &log)],
    )
    .await;

    let log_for_check = log.clone();
    let (resp, requests) = drive(&mut h, &sid, "go", |req| {
        // Before answering, the tool must not have run.
        assert!(
            call_log_lines(&log_for_check).is_empty(),
            "tool invoked BEFORE approval"
        );
        Some(approve(req))
    })
    .await;

    assert_eq!(stop_reason(&resp), "end_turn");
    assert_eq!(requests.len(), 1, "exactly one call → exactly one ask");
    assert_eq!(
        call_log_lines(&log),
        vec!["shell"],
        "approved tool reached MCP exactly once"
    );
    h.shutdown().await;
}

/// Selecting the offered reject option never invokes the tool, and the model
/// sees a permission-denied tool error (the turn continues to `end_turn`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_reject_option_never_invokes_tool() {
    let log = call_log_path("reject");
    let llm = spawn_capturing_llm(vec![shell_call("tc1"), openai_text("understood")]).await;
    let mut h = Harness::spawn(&llm.url).await;
    let sid = init(
        &mut h,
        1,
        "/tmp",
        &[("FAKE_MCP_SHELL_TOOL", "1"), ("FAKE_MCP_CALL_LOG", &log)],
    )
    .await;

    let (resp, requests) = drive(&mut h, &sid, "go", |req| {
        Some(resp_selected(&req["id"], "reject_once"))
    })
    .await;

    assert_eq!(stop_reason(&resp), "end_turn");
    assert_eq!(requests.len(), 1);
    assert!(
        call_log_lines(&log).is_empty(),
        "rejected tool must never reach MCP"
    );
    h.shutdown().await;
}

/// Every non-authorizing response shape fails closed: the tool never runs.
/// One subprocess per shape keeps the failure attributable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_adversarial_outcomes_never_invoke_tool() {
    // (tag, response-for-request builder) — the full fail-closed matrix.
    type Shape = (&'static str, fn(&Value) -> Value);
    let shapes: Vec<Shape> = vec![
        ("cancelled", |req| {
            resp_result(&req["id"], json!({ "outcome": { "outcome": "cancelled" } }))
        }),
        ("jsonrpc_error", |req| resp_error(&req["id"])),
        ("missing_outcome", |req| resp_result(&req["id"], json!({}))),
        ("empty_outcome", |req| {
            resp_result(&req["id"], json!({ "outcome": {} }))
        }),
        ("selected_no_option", |req| {
            resp_result(&req["id"], json!({ "outcome": { "outcome": "selected" } }))
        }),
        ("unknown_outcome", |req| {
            resp_result(
                &req["id"],
                json!({ "outcome": { "outcome": "banana", "optionId": "allow_once" } }),
            )
        }),
        ("wrong_option_id", |req| {
            resp_selected(&req["id"], "not_an_offered_option")
        }),
    ];

    for (tag, build) in shapes {
        let log = call_log_path(tag);
        let llm = spawn_capturing_llm(vec![shell_call("tc1"), openai_text("ok")]).await;
        let mut h = Harness::spawn(&llm.url).await;
        let sid = init(
            &mut h,
            1,
            "/tmp",
            &[("FAKE_MCP_SHELL_TOOL", "1"), ("FAKE_MCP_CALL_LOG", &log)],
        )
        .await;

        let (resp, requests) = drive(&mut h, &sid, "go", |req| Some(build(req))).await;

        assert_eq!(
            stop_reason(&resp),
            "end_turn",
            "shape {tag}: turn should continue"
        );
        assert_eq!(requests.len(), 1, "shape {tag}: exactly one ask");
        assert!(
            call_log_lines(&log).is_empty(),
            "shape {tag}: non-authorizing outcome must never reach MCP"
        );
        h.shutdown().await;
    }
}

/// A stale/unknown/foreign response id is ignored and does not unblock the live
/// waiter; the correct id then authorizes exactly once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_stale_id_ignored_then_real_id_authorizes() {
    let log = call_log_path("staleid");
    let llm = spawn_capturing_llm(vec![shell_call("tc1"), openai_text("done")]).await;
    let mut h = Harness::spawn(&llm.url).await;
    let sid = init(
        &mut h,
        1,
        "/tmp",
        &[("FAKE_MCP_SHELL_TOOL", "1"), ("FAKE_MCP_CALL_LOG", &log)],
    )
    .await;

    let p = h
        .send(
            "session/prompt",
            json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": "go" }] }),
        )
        .await;

    // Wait for the ask.
    let req = h
        .recv_until(|v| v.get("method") == Some(&json!("session/request_permission")))
        .await;

    // Feed several ignorable responses first: a minted-but-never-issued id, a
    // foreign numeric id, and a null id. None may unblock the real waiter.
    h.write(resp_selected(&json!("perm-9999"), "allow_once"))
        .await;
    h.write(resp_selected(&json!(7), "allow_once")).await;
    h.write(resp_selected(&Value::Null, "allow_once")).await;
    // Give the agent a beat to (wrongly) act on any of them.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        call_log_lines(&log).is_empty(),
        "stale/foreign ids must not authorize the pending call"
    );

    // The real id resolves it exactly once.
    h.write(approve(&req)).await;
    let resp = h.recv_until(|v| v["id"] == json!(p)).await;
    assert_eq!(stop_reason(&resp), "end_turn");
    assert_eq!(
        call_log_lines(&log),
        vec!["shell"],
        "only the correct id authorizes, exactly once"
    );
    h.shutdown().await;
}

/// `session/cancel` while a permission ask is outstanding terminates the turn
/// promptly, executes nothing, and needs no `cancelled` permission response —
/// a Buzz client always answers, but a non-Buzz ACP client may violate the spec
/// by staying silent, and cancellation must not depend on that answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_cancel_while_waiting_executes_nothing_without_client_answer() {
    let log = call_log_path("cancelwait");
    let llm = spawn_capturing_llm(vec![shell_call("tc1"), openai_text("done")]).await;
    let mut h = Harness::spawn(&llm.url).await;
    let sid = init(
        &mut h,
        1,
        "/tmp",
        &[("FAKE_MCP_SHELL_TOOL", "1"), ("FAKE_MCP_CALL_LOG", &log)],
    )
    .await;

    let p = h
        .send(
            "session/prompt",
            json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": "go" }] }),
        )
        .await;

    // Wait for the ask, then cancel WITHOUT ever answering the permission.
    let _req = h
        .recv_until(|v| v.get("method") == Some(&json!("session/request_permission")))
        .await;
    h.notify("session/cancel", json!({ "sessionId": sid }))
        .await;

    let resp = h.recv_until(|v| v["id"] == json!(p)).await;
    assert_eq!(
        stop_reason(&resp),
        "cancelled",
        "cancel resolves the turn without a client permission answer"
    );
    assert!(
        call_log_lines(&log).is_empty(),
        "a cancelled ask must never reach the tool"
    );
    h.shutdown().await;
}

/// Two parallel calls each get their own ask (distinct ids); crossed decisions —
/// deny the first-asked, allow the second-asked — authorize only the allowed
/// call. Serial admission (`max_parallel_tools=1`) serializes the asks: the
/// second ask fires only after the first resolves. Which tool is admitted first
/// is a tokio scheduling detail, so the test denies whichever is asked first and
/// proves only the allowed (second) call reached MCP — order-agnostic.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_crossed_parallel_decisions_authorize_only_matching_call() {
    let log = call_log_path("crossed");
    // Two distinct registered tools so the call log distinguishes them by name.
    let llm = spawn_capturing_llm(vec![
        openai_tool_calls(&[
            ("tc-alpha", "fake__alpha", json!({})),
            ("tc-bravo", "fake__bravo", json!({})),
        ]),
        openai_text("done"),
    ])
    .await;
    let mut h = Harness::spawn_with_env(&llm.url, &[("BUZZ_AGENT_MAX_PARALLEL_TOOLS", "1")]).await;
    let sid = init(
        &mut h,
        1,
        "/tmp",
        &[
            ("FAKE_MCP_NAMED_TOOLS", "alpha,bravo"),
            ("FAKE_MCP_CALL_LOG", &log),
        ],
    )
    .await;

    // Deny whichever tool is asked first; allow the second. Ids are distinct.
    let mut seen_ids: Vec<Value> = Vec::new();
    let mut allowed_title = String::new();
    let (resp, requests) = drive(&mut h, &sid, "go", |req| {
        assert!(
            !seen_ids.contains(&req["id"]),
            "each parallel call must get a distinct request id"
        );
        seen_ids.push(req["id"].clone());
        if seen_ids.len() == 1 {
            Some(resp_selected(&req["id"], "reject_once")) // deny the first-asked
        } else {
            allowed_title = perm_title(req);
            Some(approve(req)) // allow the second-asked
        }
    })
    .await;

    assert_eq!(stop_reason(&resp), "end_turn");
    assert_eq!(requests.len(), 2, "one ask per parallel call");
    // The call log records bare tool names; the title carries the qualified
    // `<server>__<name>`. Only the allowed (second-asked) call reached MCP.
    let allowed_bare = allowed_title
        .strip_prefix("fake__")
        .expect("qualified title")
        .to_owned();
    assert_eq!(
        call_log_lines(&log),
        vec![allowed_bare],
        "only the allowed (second-asked) call reached MCP; the denied one did not"
    );
    h.shutdown().await;
}

/// The built-in `load_skill` tool is not an MCP call and is exempt from the
/// permission boundary: it executes with no `session/request_permission`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_load_skill_emits_no_permission_request() {
    let tmp = tempfile::TempDir::new().unwrap();
    let cwd = tmp.path();
    let skill_dir = cwd.join(".agents/skills/my-skill");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: my-skill\ndescription: A skill\n---\nSKILL_BODY_77\n",
    )
    .unwrap();

    let llm = spawn_capturing_llm(vec![
        openai_tool_calls(&[("tc-ls", "load_skill", json!({ "name": "my-skill" }))]),
        openai_text("done"),
    ])
    .await;
    let mut h = Harness::spawn(&llm.url).await;
    // No MCP server: `load_skill` is a built-in, and skills come from `cwd`.
    let sid = init(&mut h, 1, cwd.to_str().unwrap(), &[]).await;

    let (resp, requests) = drive(&mut h, &sid, "use my-skill", |_| {
        panic!("load_skill must not trigger a permission request")
    })
    .await;

    assert_eq!(stop_reason(&resp), "end_turn");
    assert!(requests.is_empty(), "built-in load_skill is exempt");
    h.shutdown().await;
}

/// Lifecycle hooks (`_Stop`, `_PostCompact`) invoke MCP through `call_hooks`,
/// not the model-issued tool path, so they are exempt: the hook reaches the
/// server (call log records it) with no permission ask. Here the `_Stop` hook
/// objects once, forcing a hook invocation the test can observe.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_stop_hook_reaches_mcp_without_permission_ask() {
    let log = call_log_path("stophook");
    // Text turn triggers the _Stop gate → hook objects once → agent loops →
    // second text turn, hook silent → end_turn. No model-issued tool call.
    let llm = spawn_capturing_llm(vec![
        openai_text("premature"),
        openai_text("really done"),
        openai_text("unexpected"),
    ])
    .await;
    let mut h = Harness::spawn_with_env(
        &llm.url,
        &[
            ("MCP_HOOK_SERVERS", "fake"),
            ("BUZZ_AGENT_STOP_MAX_REJECTIONS", "10"),
        ],
    )
    .await;
    let sid = init(
        &mut h,
        1,
        "/tmp",
        &[
            ("FAKE_MCP_TOOL_COUNT", "1"),
            ("FAKE_MCP_STOP_HOOK", "1"),
            ("FAKE_MCP_STOP_TEXT", "you have open work"),
            ("FAKE_MCP_STOP_COUNT", "1"),
            ("FAKE_MCP_CALL_LOG", &log),
        ],
    )
    .await;

    let (resp, requests) = drive(&mut h, &sid, "go", |_| {
        panic!("a lifecycle hook must not trigger a permission request")
    })
    .await;

    assert_eq!(stop_reason(&resp), "end_turn");
    assert!(requests.is_empty(), "_Stop hook is exempt from the ask");
    assert!(
        call_log_lines(&log).contains(&"_Stop".to_owned()),
        "the _Stop hook still reached MCP without an ask; log={:?}",
        call_log_lines(&log)
    );
    h.shutdown().await;
}

/// Under a v2-negotiated connection, the emitted `session/request_permission`
/// carries the v2 shape (`subject.toolCall`, top-level `title`), never the v1
/// legacy top-level `toolCall`. Complements the pure v1/v2 builder unit tests
/// with an end-to-end proof that the negotiated version reaches the wire.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_v2_negotiation_emits_v2_request_shape() {
    let log = call_log_path("v2shape");
    let llm = spawn_capturing_llm(vec![shell_call("tc1"), openai_text("done")]).await;
    let mut h = Harness::spawn(&llm.url).await;
    let sid = init(
        &mut h,
        2, // negotiate v2
        "/tmp",
        &[("FAKE_MCP_SHELL_TOOL", "1"), ("FAKE_MCP_CALL_LOG", &log)],
    )
    .await;

    let (resp, requests) = drive(&mut h, &sid, "go", |req| {
        let params = &req["params"];
        // v2: tool context under `subject.toolCall`, with top-level `title`.
        assert_eq!(params["subject"]["type"], "tool_call", "v2 uses subject");
        assert_eq!(params["subject"]["toolCall"]["title"], "fake__shell");
        assert_eq!(params["title"], "fake__shell", "v2 has top-level title");
        assert!(
            params.get("toolCall").is_none(),
            "v2 must not carry the v1 top-level toolCall"
        );
        Some(approve(req))
    })
    .await;

    assert_eq!(stop_reason(&resp), "end_turn");
    assert_eq!(requests.len(), 1);
    assert_eq!(call_log_lines(&log), vec!["shell"]);
    h.shutdown().await;
}
