//! Live isolated-relay proof for the Usage dashboard, end to end in one run.
//!
//! Covers the whole of the plan's delivery item — "live isolated-relay proof
//! from two agents through encrypted ingestion, archive restart and
//! one/many/all dashboard filtering" — against a relay that really speaks the
//! wire protocol, rather than against a fake relay response:
//!
//! 1. Two distinct agent keys publish NIP-44-encrypted kind-44200 usage to the
//!    relay, each p-tagged to the owner, over real NIP-42-authenticated
//!    sockets.
//! 2. The owner's `{kinds:[44200], #p:[owner]}` REQ returns both; the owner
//!    decrypts both; an outsider key gets nothing back from the relay for the
//!    owner's `#p` and cannot decrypt the ciphertexts it never should have.
//! 3. The events are ingested through the shipped archive path
//!    (`plan_archive` → `commit_archive`) into an on-disk archive, then the
//!    connection is dropped and the file REOPENED with the production
//!    `store::open_archive_db` — the restart — and the rows are still there
//!    and still queryable.
//! 4. `analytics::query` is driven for one agent, many (both) and all (empty
//!    selection), plus the cleared selection, and the three result sets are
//!    asserted to differ correctly and to reconcile.
//!
//! **This test is gated on `BUZZ_LIVE_USAGE_RELAY`** (the ws URL of an
//! isolated relay, e.g. `ws://localhost:3030` from
//! `scripts/start-isolated-test-relay.sh`). Without it the test prints
//! `LIVE_USAGE_SKIP` and returns, because the ordinary suite has no relay; it
//! is never silently green — a run that mattered prints `LIVE_USAGE_PASS` with
//! its counts. Never point it at a real relay: it publishes events.
//!
//! The one thing here that is not the shipped code path is how the bucket's
//! relay proof is obtained. Production `query_buckets` re-asks the relay over
//! the authed HTTP `/query` which needs an `AppState`; this test fills
//! `returned_ids` from the owner's own live REQ against the same relay. It is
//! the relay's own answer to "which of these events match this owner-scoped
//! filter", not a fixture asserting itself.

use super::*;
use futures_util::{SinkExt, StreamExt};
use nostr::{EventBuilder, JsonUtil, Keys, Kind, RelayUrl, Tag};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::protocol::Message;

use buzz_core_pkg::agent_turn_metric::{
    decrypt_agent_turn_metric, encrypt_agent_turn_metric, AgentTurnMetricPayload, StopReason,
    TokenCounts, UsageAttribution, UsageTelemetry,
};

/// Relay URL for the isolated relay this proof runs against.
const ENV_RELAY: &str = "BUZZ_LIVE_USAGE_RELAY";
/// Wall-clock ceiling on any single relay exchange.
const WIRE_TIMEOUT: Duration = Duration::from_secs(15);

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// One agent's published usage, with values chosen so every filtered total
/// below is distinguishable from every other (never "equal on both sides").
struct Publisher {
    keys: Keys,
    label: &'static str,
    input: u64,
    output: u64,
    total: u64,
    cost: f64,
    provider: &'static str,
    account: &'static str,
    model: &'static str,
}

impl Publisher {
    fn payload(&self, at: &str) -> AgentTurnMetricPayload {
        AgentTurnMetricPayload {
            harness: "live-proof".to_string(),
            model: Some(self.model.to_string()),
            channel_id: None,
            session_id: Some(format!("session-{}", self.label)),
            turn_id: Some(format!("turn-{}", self.label)),
            turn_seq: Some(1),
            timestamp: at.to_string(),
            turn: Some(TokenCounts {
                input_tokens: Some(self.input),
                output_tokens: Some(self.output),
                total_tokens: Some(self.total),
                cost_usd: Some(self.cost),
                cache_read_tokens: None,
                cache_write_tokens: None,
            }),
            cumulative: None,
            delta_reliable: true,
            stop_reason: Some(StopReason::EndTurn),
            pricing_identity: None,
            telemetry: Some(UsageTelemetry {
                attribution: UsageAttribution {
                    provider: Some(self.provider.to_string()),
                    account_id: Some(self.account.to_string()),
                    account_label: Some(format!("{} subscription", self.provider)),
                    account_confirmed: Some(true),
                    service_tier: None,
                },
                cost_source: Some("wire-reported".to_string()),
                request_count: Some(1),
                requests_complete: false,
                requests: Vec::new(),
            }),
        }
    }
}

/// The NIP-OA `auth` tag by which the owner authorizes `agent` — the same
/// `compute_auth_tag` → `parse_auth_tag` bridge `commands/engrams.rs`'s tests
/// use. The relay requires it: a kind-44200 event whose `p` tag is not the
/// agent's *registered* owner is refused with
/// `restricted: agent-turn-metric \`p\` tag must be the registered owner of
/// this agent`, and the ws AUTH handler is where that registration is
/// materialized from a verified tag.
fn owner_auth_tag(owner: &Keys, agent: &Keys) -> Tag {
    let agent_compat =
        nostr::PublicKey::from_hex(&agent.public_key().to_hex()).expect("agent pubkey round-trips");
    let owner_compat = nostr::Keys::new(
        nostr::SecretKey::from_slice(owner.secret_key().as_secret_bytes())
            .expect("owner secret round-trips"),
    );
    let tag_json = buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_compat, &agent_compat, "")
        .expect("compute the NIP-OA auth tag");
    let compat_tag = buzz_sdk_pkg::nip_oa::parse_auth_tag(&tag_json).expect("parse the auth tag");
    Tag::parse(compat_tag.as_slice()).expect("auth tag converts")
}

/// Connect and complete the NIP-42 handshake, the same `EventBuilder::auth`
/// exchange `commands/pairing.rs` uses against a real relay.
async fn connect_authed(url: &str, keys: &Keys, auth_tag: Option<Tag>) -> Ws {
    let (mut ws, _response) = tokio::time::timeout(WIRE_TIMEOUT, async {
        tokio_tungstenite::connect_async(url).await
    })
    .await
    .expect("relay connect timed out")
    .expect("relay connect failed");

    let challenge = loop {
        let text = next_text(&mut ws).await.expect("relay closed before AUTH");
        let frame: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if frame[0] == "AUTH" {
            break frame[1]
                .as_str()
                .expect("AUTH challenge is a string")
                .to_string();
        }
    };

    let relay_url = RelayUrl::parse(url).expect("relay url parses");
    let builder = EventBuilder::auth(challenge, relay_url);
    let builder = match auth_tag {
        Some(tag) => builder.tags([tag]),
        None => builder,
    };
    let auth = builder.sign_with_keys(keys).expect("sign auth event");
    let auth_id = auth.id.to_hex();
    ws.send(Message::Text(
        format!("[\"AUTH\",{}]", auth.as_json()).into(),
    ))
    .await
    .expect("send AUTH");

    loop {
        let text = next_text(&mut ws)
            .await
            .expect("relay closed during AUTH OK");
        let frame: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if frame[0] == "OK" && frame[1] == auth_id.as_str() {
            assert_eq!(
                frame[2], true,
                "NIP-42 AUTH rejected by the relay: {text}. This proof needs an \
                 isolated relay started with BUZZ_REQUIRE_AUTH_TOKEN=false."
            );
            return ws;
        }
    }
}

async fn next_text(ws: &mut Ws) -> Option<String> {
    loop {
        let message = tokio::time::timeout(WIRE_TIMEOUT, ws.next())
            .await
            .expect("relay read timed out")?
            .expect("relay websocket error");
        match message {
            Message::Text(text) => return Some(text.to_string()),
            Message::Close(_) => return None,
            _ => continue,
        }
    }
}

/// Publish one signed event and require the relay's own OK.
async fn publish(ws: &mut Ws, event: &nostr::Event) {
    let id = event.id.to_hex();
    ws.send(Message::Text(
        format!("[\"EVENT\",{}]", event.as_json()).into(),
    ))
    .await
    .expect("send EVENT");
    loop {
        let text = next_text(ws).await.expect("relay closed before EVENT OK");
        let frame: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if frame[0] == "OK" && frame[1] == id.as_str() {
            assert_eq!(frame[2], true, "relay rejected kind-44200 event: {text}");
            return;
        }
    }
}

/// Run one REQ to EOSE (or CLOSED) and return the events the relay served,
/// each paired with the exact raw JSON bytes it served them as.
///
/// Returns `(events, closed_reason)`. A relay that refuses the filter outright
/// answers CLOSED, which for the outsider case is a pass, not an error — so it
/// is reported rather than panicked on.
async fn fetch(
    ws: &mut Ws,
    sub: &str,
    filter: Value,
) -> (Vec<(nostr::Event, String)>, Option<String>) {
    ws.send(Message::Text(
        json!(["REQ", sub, filter]).to_string().into(),
    ))
    .await
    .expect("send REQ");

    let mut events = Vec::new();
    loop {
        let Some(text) = next_text(ws).await else {
            return (events, Some("relay closed the socket".to_string()));
        };
        let frame: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        match frame[0].as_str() {
            Some("EVENT") if frame[1] == sub => {
                let raw = frame[2].to_string();
                let event = nostr::Event::from_json(&raw).expect("relay served a valid event");
                events.push((event, raw));
            }
            Some("EOSE") if frame[1] == sub => return (events, None),
            Some("CLOSED") if frame[1] == sub => {
                return (
                    events,
                    Some(frame[2].as_str().unwrap_or("closed").to_string()),
                )
            }
            _ => continue,
        }
    }
}

/// A one-day UTC window around `now`, the shape the frontend sends.
fn window(now: chrono::DateTime<chrono::Utc>) -> analytics::AnalyticsRequest {
    let day_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("midnight exists")
        .and_utc()
        .timestamp();
    analytics::AnalyticsRequest {
        bucket_boundaries: vec![day_start, day_start + 86_400],
        day_boundaries: vec![day_start, day_start + 86_400],
        day_labels: vec![now.format("%Y-%m-%d").to_string()],
        agent_pubkeys: Vec::new(),
        select_none: false,
    }
}

fn input_of(group: &analytics::MetricGroup) -> u64 {
    group
        .usage
        .input_tokens
        .value
        .as_deref()
        .unwrap_or("0")
        .parse()
        .expect("input tokens parse")
}

#[tokio::test]
async fn live_two_agent_usage_survives_restart_and_filters_one_many_all() {
    let Ok(relay_url) = std::env::var(ENV_RELAY) else {
        eprintln!(
            "LIVE_USAGE_SKIP no {ENV_RELAY} in the environment. Start an isolated relay \
             (scripts/start-isolated-test-relay.sh) and re-run with \
             {ENV_RELAY}=ws://localhost:3030 to execute this proof."
        );
        return;
    };

    let owner = Keys::generate();
    let outsider = Keys::generate();
    let owner_pk = owner.public_key().to_hex();
    let publishers = [
        Publisher {
            keys: Keys::generate(),
            label: "a",
            input: 1_000,
            output: 100,
            total: 1_100,
            cost: 0.50,
            provider: "live-provider-a",
            account: "live-account-a",
            model: "live-model-a",
        },
        Publisher {
            keys: Keys::generate(),
            label: "b",
            input: 22,
            output: 3,
            total: 25,
            cost: 0.07,
            provider: "live-provider-b",
            account: "live-account-b",
            model: "live-model-b",
        },
    ];
    // Distinguishing values, asserted rather than assumed: a one-agent total
    // that happened to equal the other's would make every filter assertion
    // below pass without discriminating.
    assert_ne!(
        publishers[0].input, publishers[1].input,
        "the two agents must report different totals or the filters prove nothing"
    );

    // ── 1. Two agents publish encrypted kind-44200 through the relay ─────────
    let now = chrono::Utc::now();
    let reported_at = now.to_rfc3339();
    let mut published = Vec::new();
    for publisher in &publishers {
        let payload = publisher.payload(&reported_at);
        let ciphertext = encrypt_agent_turn_metric(&publisher.keys, &owner.public_key(), &payload)
            .expect("encrypt to the owner");
        assert!(
            !ciphertext.contains(publisher.provider) && !ciphertext.contains(publisher.account),
            "the private labels must not be readable in the event content"
        );
        let event = EventBuilder::new(Kind::Custom(super::KIND_AGENT_TURN_METRIC), &ciphertext)
            .tags([
                Tag::parse(["p", &owner_pk]).expect("p tag"),
                Tag::parse(["agent", &publisher.keys.public_key().to_hex()]).expect("agent tag"),
            ])
            .sign_with_keys(&publisher.keys)
            .expect("sign metric event");
        assert_eq!(
            event.tags.len(),
            2,
            "the envelope discloses only p and agent"
        );

        let mut ws = connect_authed(
            &relay_url,
            &publisher.keys,
            Some(owner_auth_tag(&owner, &publisher.keys)),
        )
        .await;
        publish(&mut ws, &event).await;
        let _ = ws.close(None).await;
        published.push(event);
    }

    // ── 2. Owner reads and decrypts both; an outsider gets neither ───────────
    let mut owner_ws = connect_authed(&relay_url, &owner, None).await;
    let (owner_rows, owner_closed) = fetch(
        &mut owner_ws,
        "live-usage-owner",
        json!({"kinds":[super::KIND_AGENT_TURN_METRIC],"#p":[owner_pk]}),
    )
    .await;
    assert_eq!(
        owner_closed, None,
        "the owner's own #p filter must not be refused"
    );
    assert_eq!(
        owner_rows.len(),
        publishers.len(),
        "the relay must serve the owner both agents' usage"
    );
    for (event, _) in &owner_rows {
        decrypt_agent_turn_metric(&owner, event).expect("the owner decrypts its own usage");
        assert!(
            decrypt_agent_turn_metric(&outsider, event).is_err(),
            "an outsider key must not decrypt owner-only usage"
        );
    }

    let mut outsider_ws = connect_authed(&relay_url, &outsider, None).await;
    let (outsider_rows, outsider_closed) = fetch(
        &mut outsider_ws,
        "live-usage-outsider",
        json!({"kinds":[super::KIND_AGENT_TURN_METRIC],"#p":[owner_pk]}),
    )
    .await;
    assert!(
        outsider_rows.is_empty(),
        "the relay served {} owner-scoped events to an outsider",
        outsider_rows.len()
    );
    let _ = owner_ws.close(None).await;
    let _ = outsider_ws.close(None).await;

    // ── 3. Ingest through the shipped archive path, then RESTART ─────────────
    let dir = tempfile::tempdir().expect("temp archive dir");
    let db_path = dir.path().join("live-usage-archive.db");
    let ingested = {
        let conn = store::open_archive_db(&db_path).expect("open archive");
        store::upsert_save_subscription(
            &conn,
            &owner_pk,
            &relay_url,
            "owner_p",
            &owner_pk,
            "[44200]",
            now.timestamp(),
        )
        .expect("subscribe to kind 44200");

        let candidates: Vec<ArchiveCandidate> = owner_rows
            .iter()
            .map(|(_, raw)| ArchiveCandidate {
                raw_event_json: raw.clone(),
                matched_scope: MatchedScope {
                    scope_type: ScopeType::OwnerP,
                    scope_value: owner_pk.clone(),
                },
            })
            .collect();
        let plan =
            plan_archive(candidates, &owner_pk, &relay_url, &conn).expect("plan the archive batch");
        assert_eq!(plan.buckets.len(), 1, "one owner_p bucket");
        assert!(plan.ephemeral.is_empty(), "kind 44200 is not ephemeral");

        // The relay's own answer for this scoped filter, from the owner REQ above.
        let returned_ids: std::collections::HashSet<String> = owner_rows
            .iter()
            .map(|(event, _)| event.id.to_hex())
            .collect();
        let bucket_results: Vec<pipeline::BucketWithResult> = plan
            .buckets
            .into_iter()
            .map(|bucket| pipeline::BucketWithResult {
                scope_type_str: bucket.scope_type_str,
                scope_value: bucket.scope_value,
                allowed_kinds: bucket.allowed_kinds,
                group: bucket.group,
                returned_ids: returned_ids.clone(),
                relay_failed: false,
            })
            .collect();
        let result = commit_archive(
            bucket_results,
            plan.ephemeral,
            plan.pre_dropped,
            &owner_pk,
            &relay_url,
            &owner,
            now.timestamp(),
            &conn,
        )
        .expect("commit the archive batch");
        assert_eq!(result.dropped, 0, "nothing was dropped");
        assert_eq!(
            result.persisted_agent_metrics, 2,
            "both agents' turns were indexed"
        );

        // Owner decryption happened at ingest: the stored row is plaintext, and
        // the private labels the ciphertext hid are now readable locally.
        let stored: String = conn
            .query_row(
                "SELECT raw_json FROM archived_events WHERE id=?1",
                rusqlite::params![published[0].id.to_hex()],
                |row| row.get(0),
            )
            .expect("read the stored row");
        assert!(
            stored.contains(publishers[0].provider),
            "kind-44200 content must be stored decrypted"
        );
        result.persisted
    };

    // The connection above is dropped here — the archive is closed. Reopen the
    // same file with the production opener: this is the restart.
    let conn = store::open_archive_db(&db_path).expect("reopen archive after restart");
    let surviving: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM archived_events WHERE identity_pubkey=?1 AND kind=?2",
            rusqlite::params![owner_pk, i64::from(super::KIND_AGENT_TURN_METRIC)],
            |row| row.get(0),
        )
        .expect("count rows after restart");
    assert_eq!(
        surviving, 2,
        "both rows must survive closing and reopening the archive"
    );

    // ── 4. one / many / all, over the restarted archive ──────────────────────
    let query_for = |agents: Vec<String>, select_none: bool| {
        let mut request = window(now);
        request.agent_pubkeys = agents;
        request.select_none = select_none;
        analytics::query(&conn, &owner_pk, &relay_url, &request).expect("analytics query")
    };
    let pk_a = publishers[0].keys.public_key().to_hex();
    let pk_b = publishers[1].keys.public_key().to_hex();

    let one_a = query_for(vec![pk_a.clone()], false);
    let one_b = query_for(vec![pk_b.clone()], false);
    let many = query_for(vec![pk_a.clone(), pk_b.clone()], false);
    let all = query_for(Vec::new(), false);
    let none = query_for(Vec::new(), true);

    assert_eq!(one_a.summary.report_count, 1, "one agent, one turn");
    assert_eq!(input_of(&one_a.summary), publishers[0].input);
    assert_eq!(one_a.agents.len(), 1, "one agent row");
    assert_eq!(one_a.providers.len(), 1, "one provider");
    assert_eq!(one_a.providers[0].key, publishers[0].provider);

    assert_eq!(one_b.summary.report_count, 1);
    assert_eq!(input_of(&one_b.summary), publishers[1].input);
    assert_eq!(one_b.providers[0].key, publishers[1].provider);
    assert_ne!(
        input_of(&one_a.summary),
        input_of(&one_b.summary),
        "the two single-agent selections must not agree"
    );

    assert_eq!(many.summary.report_count, 2, "both agents, both turns");
    assert_eq!(many.agents.len(), 2);
    assert_eq!(many.providers.len(), 2);
    assert_eq!(many.accounts.len(), 2);
    assert_eq!(
        input_of(&many.summary),
        input_of(&one_a.summary) + input_of(&one_b.summary),
        "many must reconcile to the sum of its parts"
    );

    assert_eq!(
        input_of(&all.summary),
        input_of(&many.summary),
        "an empty selection is all agents"
    );
    assert_eq!(all.summary.report_count, many.summary.report_count);
    assert_eq!(
        all.available_agents.len(),
        2,
        "both agents are offered by the filter"
    );

    assert_eq!(
        none.summary.report_count, 0,
        "a cleared selection has no metrics"
    );
    assert_eq!(
        none.available_agents.len(),
        2,
        "a cleared selection still offers both agents"
    );

    // Cost provenance survived the whole trip, still labelled wire-reported.
    let cost = many.summary.costs.wire_reported.value.expect("wire cost");
    assert!(
        (cost - (publishers[0].cost + publishers[1].cost)).abs() < 1e-9,
        "wire-reported cost must reconcile, got {cost}"
    );
    assert_eq!(many.summary.costs.manifest_estimated.value, None);

    println!(
        "LIVE_USAGE_PASS relay={relay_url} owner={owner_pk} agent_a={pk_a} agent_b={pk_b} \
         published=2 owner_served={} outsider_served={} outsider_closed={} \
         owner_decrypted=2 outsider_decrypted=0 persisted={ingested} \
         rows_after_restart={surviving} one_a_input={} one_b_input={} many_input={} \
         all_input={} none_reports={} available_agents={}",
        owner_rows.len(),
        outsider_rows.len(),
        outsider_closed.unwrap_or_else(|| "eose".to_string()),
        input_of(&one_a.summary),
        input_of(&one_b.summary),
        input_of(&many.summary),
        input_of(&all.summary),
        none.summary.report_count,
        all.available_agents.len(),
    );
}
