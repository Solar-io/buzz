//! Runs the actual publisher process against a local provider fixture.
mod common;
use common::{spawn_capturing_llm, Harness};
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_acp_publisher_emits_only_observed_private_request_metrics() {
    let response = |input| json!({"id":"fixture","choices":[{"message":{"role":"assistant","content":"PRIVATE RESPONSE TEXT"},"finish_reason":"stop"}],"usage":{"prompt_tokens":input,"completion_tokens":7,"total_tokens":input+7}});
    let provider = spawn_capturing_llm(vec![response(13), response(21)]).await;
    let mut harness = Harness::spawn(&provider.url).await;
    let init = harness
        .send(
            "initialize",
            json!({"protocolVersion":2,"clientCapabilities":{}}),
        )
        .await;
    harness.recv_until(|v| v["id"] == init).await;
    let new = harness
        .send("session/new", json!({"cwd":"/tmp","mcpServers":[]}))
        .await;
    let session = harness.recv_until(|v| v["id"] == new).await["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    for expected_input in [13, 21] {
        let prompt=harness.send("session/prompt",json!({"sessionId":session,"prompt":[{"type":"text","text":"PRIVATE PROMPT TEXT"}]})).await;
        let mut metrics = None;
        loop {
            let frame = harness.recv().await;
            if frame["params"]["update"]["sessionUpdate"] == "usage_update" {
                metrics = Some(frame["params"]["update"].clone());
            }
            if frame["id"] == prompt {
                assert_eq!(frame["result"]["stopReason"], "end_turn");
                break;
            }
        }
        let metrics = metrics.expect("real process must publish a usage update");
        let telemetry = &metrics["telemetry"];
        assert_eq!(telemetry["requestsComplete"], false);
        assert!(telemetry.get("requestCount").is_none());
        let calls = telemetry["requests"]
            .as_array()
            .expect("actual observations");
        assert_eq!(
            calls.len(),
            1,
            "previous turns must not leak into this turn"
        );
        assert_eq!(calls[0]["usage"]["inputTokens"], expected_input);
        assert_eq!(calls[0]["usage"]["outputTokens"], 7);
        assert_eq!(calls[0]["model"], "fake-model");
        assert!(calls[0]["latencyMs"].as_u64().is_some());
        assert!(calls[0]["attribution"].get("provider").is_none());
        assert!(calls[0]["usage"].get("cacheReadTokens").is_none());
        let serialized = telemetry.to_string();
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains(&provider.url));
    }
    assert_eq!(provider.captured.lock().await.len(), 2);
    harness.shutdown().await;
}
