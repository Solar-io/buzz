//! Rebuildable private telemetry projections. Raw archive rows remain canonical.
use std::collections::HashMap;

use buzz_core_pkg::agent_turn_metric::{AgentTurnMetricPayload, UsageTelemetry};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct Metadata {
    pub telemetry: UsageTelemetry,
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub expected_requests: usize,
}

/// Each additive DDL statement is atomic; the batch is safe to repeat after interruption.
pub(super) fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_usage_metadata (
      identity_pubkey TEXT NOT NULL, relay_url TEXT NOT NULL, id TEXT NOT NULL,
      metadata TEXT NOT NULL, PRIMARY KEY(identity_pubkey, relay_url, id));
      CREATE TABLE IF NOT EXISTS agent_request_index (
      identity_pubkey TEXT NOT NULL, relay_url TEXT NOT NULL, event_id TEXT NOT NULL,
      request_id TEXT NOT NULL, provider TEXT, account_id TEXT, model TEXT,
      observation TEXT NOT NULL,
      PRIMARY KEY(identity_pubkey, relay_url, event_id, request_id));
      CREATE INDEX IF NOT EXISTS idx_agent_request_provider ON agent_request_index
      (identity_pubkey, relay_url, provider, event_id);
      CREATE INDEX IF NOT EXISTS idx_agent_metric_agent_reported ON agent_metric_index
      (identity_pubkey, relay_url, agent_pubkey, reported_at);",
    )
    .map_err(|e| e.to_string())
}

/// Project one archived kind-44200 event into both analytics tables.
///
/// Runs entirely inside the caller's transaction — no nested `BEGIN`/`COMMIT` —
/// so the projection can be written in the SAME transaction as the canonical
/// `archived_events` insert at ingest (`pipeline.rs`), exactly as
/// `metric_store::insert_metric_index_row` already is. The request rows are
/// deleted first so a re-projection of the same event cannot leave stale
/// observations behind.
///
/// An event whose payload does not parse (or does not validate) still gets a
/// metadata row, carrying the default (empty) telemetry. That is deliberate:
/// the row records "this event has been projected and had nothing to give",
/// which is what keeps [`backfill`]'s missing-row query from re-reading it on
/// every dashboard open.
pub(super) fn project_event(
    tx: &Connection,
    identity: &str,
    relay: &str,
    id: &str,
    raw: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM agent_request_index WHERE identity_pubkey=?1 AND relay_url=?2 AND event_id=?3",
        params![identity, relay, id],
    )
    .map_err(|e| e.to_string())?;
    let payload = serde_json::from_str::<AgentTurnMetricPayload>(raw)
        .ok()
        .filter(|p| p.validate().is_ok());
    let mut metadata = Metadata::default();
    if let Some(payload) = payload {
        metadata.stop_reason = payload
            .stop_reason
            .and_then(|r| serde_json::to_value(r).ok())
            .and_then(|v| v.as_str().map(str::to_owned));
        metadata.telemetry = payload.telemetry.unwrap_or_default();
        metadata.expected_requests = metadata.telemetry.requests.len();
        for request in &metadata.telemetry.requests {
            tx.execute("INSERT OR REPLACE INTO agent_request_index
                      (identity_pubkey,relay_url,event_id,request_id,provider,account_id,model,observation)
                      VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![identity,relay,id,request.id,
                      request.attribution.provider,request.attribution.account_id,request.model,
                      serde_json::to_string(request).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        }
        // Requests have their own rebuildable projection.
        metadata.telemetry.requests.clear();
    }
    tx.execute(
        "INSERT OR REPLACE INTO agent_usage_metadata VALUES (?1,?2,?3,?4)",
        params![
            identity,
            relay,
            id,
            serde_json::to_string(&metadata).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every row and all its request observations commit together. Missing projections
/// resume from raw events; orphan removal never removes canonical archive data.
///
/// This is the read-time repair path, not the primary writer: ingest projects
/// each kind-44200 event as it is archived, and migration M5 projects everything
/// archived before that writer existed. Backfill stays as defense in depth for
/// rows either of those missed (e.g. events archived by a build that predates
/// the ingest writer).
pub(super) fn backfill(conn: &Connection, identity: &str, relay: &str) -> Result<(), String> {
    migrate(conn)?;
    let mut cursor = String::new();
    loop {
        let missing: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT a.id, a.raw_json FROM archived_events a
              WHERE a.identity_pubkey=?1 AND a.relay_url=?2 AND a.kind=44200 AND a.id>?3
              AND (NOT EXISTS (SELECT 1 FROM agent_usage_metadata m WHERE
              m.identity_pubkey=a.identity_pubkey AND m.relay_url=a.relay_url AND m.id=a.id)
              OR (SELECT COALESCE(json_extract(m.metadata,'$.expected_requests'),0)
              FROM agent_usage_metadata m WHERE m.identity_pubkey=a.identity_pubkey AND m.relay_url=a.relay_url AND m.id=a.id)
              != (SELECT COUNT(*) FROM agent_request_index r WHERE r.identity_pubkey=a.identity_pubkey AND r.relay_url=a.relay_url AND r.event_id=a.id))
              ORDER BY a.id LIMIT 500",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![identity, relay, cursor], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        if missing.is_empty() {
            break;
        }
        if let Some(last) = missing.last() {
            cursor = last.0.clone();
        }
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (id, raw) in missing {
            project_event(&tx, identity, relay, &id, &raw)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    conn.execute("DELETE FROM agent_usage_metadata WHERE identity_pubkey=?1 AND relay_url=?2
      AND NOT EXISTS (SELECT 1 FROM archived_events a WHERE a.identity_pubkey=?1 AND a.relay_url=?2 AND a.id=agent_usage_metadata.id)", params![identity,relay]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM agent_request_index WHERE identity_pubkey=?1 AND relay_url=?2
      AND NOT EXISTS (SELECT 1 FROM archived_events a WHERE a.identity_pubkey=?1 AND a.relay_url=?2 AND a.id=agent_request_index.event_id)", params![identity,relay]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn load(
    conn: &Connection,
    identity: &str,
    relay: &str,
    start: i64,
    end: i64,
) -> Result<HashMap<String, Metadata>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT m.id,m.metadata FROM agent_usage_metadata m JOIN agent_metric_index i
      ON i.identity_pubkey=m.identity_pubkey AND i.relay_url=m.relay_url AND i.id=m.id
      WHERE m.identity_pubkey=?1 AND m.relay_url=?2 AND i.reported_at>=?3 AND i.reported_at<?4",
        )
        .map_err(|e| e.to_string())?;
    let mut result: HashMap<String, Metadata> = HashMap::new();
    let rows = stmt
        .query_map(params![identity, relay, start, end], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, json) = row.map_err(|e| e.to_string())?;
        result.insert(id, serde_json::from_str(&json).map_err(|e| e.to_string())?);
    }
    let mut stmt = conn.prepare("SELECT r.event_id,r.observation FROM agent_request_index r JOIN agent_metric_index i
      ON i.identity_pubkey=r.identity_pubkey AND i.relay_url=r.relay_url AND i.id=r.event_id
      WHERE r.identity_pubkey=?1 AND r.relay_url=?2 AND i.reported_at>=?3 AND i.reported_at<?4 ORDER BY r.event_id,r.request_id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![identity, relay, start, end], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, json) = row.map_err(|e| e.to_string())?;
        if let Some(metadata) = result.get_mut(&id) {
            metadata
                .telemetry
                .requests
                .push(serde_json::from_str(&json).map_err(|e| e.to_string())?);
        }
    }
    Ok(result)
}
