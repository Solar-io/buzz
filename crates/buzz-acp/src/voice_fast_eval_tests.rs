//! WP4 handoff eval (spec §9 AC4) — test tooling, not shipped.
//!
//! Replays the labelled set in `scripts/voice-fast-eval/cases.json` through
//! the REAL fast-lane prompt (`build_fast_request`, persona + rules), the
//! real client and the real `HandoffScanner`, against the live endpoint.
//! Ignored by default; run via `scripts/voice-fast-eval/run.sh`.
//!
//! Env: `BUZZ_VOICE_FAST_EVAL_PERSONA` (file with the agent's system
//! prompt; absent = rules only), `BUZZ_VOICE_FAST_BASE_URL` (default pilot
//! :6250), `BUZZ_VOICE_FAST_PROBE_AGENT` (key registry name, default
//! Kaiya), `BUZZ_VOICE_FAST_MODEL`.

use std::sync::Arc;

use crate::voice_fast::{build_fast_request, resolve_handoff, FastPromptParts, HandoffScanner};
use crate::voice_fast_client::{build_http_client, resolve_api_key_sync, FastCompletionStream};
use crate::voice_turn::VoiceFastSettings;

struct Outcome {
    needs_tools: bool,
    utterance: String,
    spoken: String,
    task: Option<String>,
    reasoning: usize,
}

async fn run_case(
    client: reqwest::Client,
    base: String,
    key: String,
    settings: Arc<VoiceFastSettings>,
    persona: Option<Arc<String>>,
    utterance: String,
    needs_tools: bool,
) -> Outcome {
    let body = build_fast_request(
        &settings,
        &FastPromptParts {
            persona: persona.as_deref().map(String::as_str),
            core_memory: None,
            history: &[],
            utterance: &utterance,
            call_state: "[call state: agent idle]",
        },
    );
    let mut scanner = HandoffScanner::new();
    let mut spoken = String::new();
    let mut reasoning = 0;
    match FastCompletionStream::open(&client, &base, &key, &body).await {
        Ok(mut s) => {
            while let Ok(Some(t)) = s.next_text().await {
                spoken.push_str(&scanner.push(&t));
                if scanner.is_closed() {
                    break;
                }
            }
            reasoning = s.reasoning_chars;
        }
        Err(e) => spoken = format!("<error {e}>"),
    }
    let marker_task = scanner.finish();
    let net = marker_task.is_none();
    // Same resolution the runner applies (marker, else bare-ack safety net).
    let task = resolve_handoff(&spoken, marker_task, &utterance);
    if net && task.is_some() {
        println!("(safety net: bare ack → handoff) {utterance}");
    }
    Outcome {
        needs_tools,
        utterance,
        spoken,
        task,
        reasoning,
    }
}

#[tokio::test]
#[ignore = "live eval against OmniRoute (WP4)"]
async fn voice_fast_handoff_eval() {
    let cases_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/voice-fast-eval/cases.json");
    let raw = std::fs::read_to_string(&cases_path).expect("cases.json");
    let cases: serde_json::Value = serde_json::from_str(&raw).expect("json");
    let list = |k: &str| -> Vec<String> {
        cases[k]
            .as_array()
            .expect("array")
            .iter()
            .map(|v| v.as_str().expect("str").to_string())
            .collect()
    };
    let tools = list("needs_tools");
    let talk = list("conversation");
    assert_eq!((tools.len(), talk.len()), (15, 15), "labelled set size");

    let base = std::env::var("BUZZ_VOICE_FAST_BASE_URL")
        .unwrap_or_else(|_| "https://pilot.tailb3d4b8.ts.net:6250".to_string());
    let agent = std::env::var("BUZZ_VOICE_FAST_PROBE_AGENT").unwrap_or_else(|_| "Kaiya".into());
    let key = resolve_api_key_sync(Some(&agent)).expect("api key");
    let mut settings = VoiceFastSettings {
        on: true,
        base_url: Some(base.clone()),
        ..VoiceFastSettings::default()
    };
    if let Ok(model) = std::env::var("BUZZ_VOICE_FAST_MODEL") {
        settings.model = model;
    }
    let settings = Arc::new(settings);
    let persona = std::env::var("BUZZ_VOICE_FAST_EVAL_PERSONA")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(Arc::new);
    println!(
        "eval model={} persona_chars={}",
        settings.model,
        persona.as_ref().map(|p| p.len()).unwrap_or(0)
    );

    let client = build_http_client();
    let mut handles = Vec::new();
    let sem = Arc::new(tokio::sync::Semaphore::new(5));
    for (utterance, needs) in tools
        .into_iter()
        .map(|u| (u, true))
        .chain(talk.into_iter().map(|u| (u, false)))
    {
        let permit = sem.clone().acquire_owned().await.expect("permit");
        let fut = run_case(
            client.clone(),
            base.clone(),
            key.clone(),
            settings.clone(),
            persona.clone(),
            utterance,
            needs,
        );
        handles.push(tokio::spawn(async move {
            let out = fut.await;
            drop(permit);
            out
        }));
    }
    let mut outcomes = Vec::new();
    for h in handles {
        outcomes.push(h.await.expect("join"));
    }
    let mut recall = 0;
    let mut false_handoffs = 0;
    let mut reasoning_total = 0;
    for o in &outcomes {
        reasoning_total += o.reasoning;
        let handed = o.task.is_some();
        let verdict = match (o.needs_tools, handed) {
            (true, true) => {
                recall += 1;
                "ok-handoff"
            }
            (true, false) => "MISS",
            (false, true) => {
                false_handoffs += 1;
                "FALSE-HANDOFF"
            }
            (false, false) => "ok-answer",
        };
        println!(
            "{verdict:14} | {} | spoken={:?} | task={:?}",
            o.utterance, o.spoken, o.task
        );
    }
    println!(
        "RESULT handoff_recall={recall}/15 false_handoffs={false_handoffs}/15 reasoning_chars={reasoning_total}"
    );
    assert!(recall >= 14, "handoff recall {recall}/15 < 14");
    assert!(
        false_handoffs <= 2,
        "false handoffs {false_handoffs}/15 > 2"
    );
}
