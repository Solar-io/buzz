//! Harness-side writer for the `managed` section of the claims file — the
//! send-path gate's ground-truth half.
//!
//! The claims file (`~/.buzz/WORKING_STATE/<slug>.claims.json`, or the
//! `BUZZ_ACP_CLAIMS_FILE` override) is a shared coordination document. The
//! voluntary 9/9 convention keys (`watching`, `composing`, `convention`) and
//! the policy annex (`yielded`, `blackout_log`, …) belong to the agent
//! sessions; this writer owns exactly one key, `managed`, and preserves every
//! other key value-for-value on every write. A doc it cannot parse is never
//! destroyed: the raw text moves under `_unparseable_before` and the write
//! proceeds on top of it.
//!
//! `managed.turns` mirrors this process's `task_map`: one entry per in-flight
//! prompt task, keyed by a boot-id-scoped slot id (`<boot-id>:<agent_index>`)
//! that is also injected into the child session as `BUZZ_ACP_SESSION_ID`. The
//! `buzz` CLI's send-path gate reads the same document to answer "is another
//! session of me mid-turn in this channel?" — which is how two live pool
//! slots for one identity stop duetting in a DM.
//!
//! Entries from OTHER boots (a second live pool for the same identity — the
//! exact failure this guards against) are preserved while fresh and decay by
//! [`TURN_TTL_SECS`] when their writer dies; no mtime heuristics anywhere.
//!
//! Writes are read-modify-write under an advisory `flock` on a `<name>.lock`
//! sidecar, published via tmp-file + `rename` (atomic on macOS/Linux). The
//! CLI's `claims_gate` module implements the same protocol — one lock
//! discipline, both sides. All writes run on the main loop's thread of
//! control (`pool` is exclusively owned there); there is no side-thread
//! writer.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use nix::fcntl::{Flock, FlockArg};
use serde_json::{json, Value};
use uuid::Uuid;

/// How long a turn claim stays live after its `last_seen_at`. Mirrors the
/// reader-side `claims::COMPOSING_TTL_SECS` so a live turn restamped by the
/// pulse never decays mid-flight while a dead harness's claims do, on both
/// the writer and the CLI gate side, on the same clock.
pub(crate) const TURN_TTL_SECS: i64 = 10 * 60;

/// Cadence of the pulse that re-stamps `last_seen_at` for live turns. Short
/// enough that a live turn never approaches the TTL between pulses; long
/// enough to be noise next to the rest of the loop's timers.
pub(crate) const PULSE_SECS: u64 = 60;

/// Set to `0` to disable the writer entirely (ops escape hatch). Anything
/// else — including unset — leaves it on. The CLI gate keys on the file, not
/// on this flag.
const WRITER_ENABLED_ENV: &str = "BUZZ_ACP_CLAIMS_WRITER";

/// Env var carrying the per-slot identity injected into child sessions: the
/// boot-id-scoped slot id this module derives. Harness-owned — callers pin it
/// in the `extra_env` slice they build for [`crate::spawn_and_init`], which
/// wins over any fallback inside `AcpClient::spawn`.
pub(crate) const SESSION_ID_ENV: &str = "BUZZ_ACP_SESSION_ID";

/// Env override pointing at the claims file — the same contract the Guard B
/// reader in [`crate::claims`] honors.
const CLAIMS_FILE_ENV: &str = "BUZZ_ACP_CLAIMS_FILE";

/// Env var carrying the agent display name — the source of the claims-file
/// slug (same contract as [`crate::claims`]).
const DISPLAY_NAME_ENV: &str = "BUZZ_ACP_DISPLAY_NAME";

/// The boot-scoped pool id: generated once per harness process, stable for
/// its lifetime. Every slot id and the `managed.pool` field carry it, so a
/// restarted harness never mistakes a previous life's entries for its own.
pub(crate) fn boot_id() -> &'static str {
    static BOOT_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BOOT_ID.get_or_init(|| Uuid::new_v4().to_string())
}

/// The stable per-slot id written into turn claims and injected as
/// `BUZZ_ACP_SESSION_ID`: `<boot-id>:<agent_index>`.
pub(crate) fn slot_id(agent_index: usize) -> String {
    format!("{}:{}", boot_id(), agent_index)
}

/// Whether the writer is enabled (default on; `BUZZ_ACP_CLAIMS_WRITER=0`
/// disables).
pub(crate) fn writer_enabled() -> bool {
    match std::env::var(WRITER_ENABLED_ENV) {
        Ok(value) => value.trim() != "0",
        Err(_) => true,
    }
}

/// Resolve the claims file for WRITING: the [`CLAIMS_FILE_ENV`] override wins,
/// else the conventional `$HOME/.buzz/WORKING_STATE/<slug>.claims.json` path
/// is derived without an existence check — the writer may create the file.
/// This is the one deliberate difference from the reader's
/// [`crate::claims::resolve_claims_file`], whose exists-check semantics are
/// pinned and untouched.
pub(crate) fn resolve_claims_file_for_write() -> Option<PathBuf> {
    if let Ok(overridden) = std::env::var(CLAIMS_FILE_ENV) {
        let overridden = overridden.trim();
        if !overridden.is_empty() {
            return Some(PathBuf::from(overridden));
        }
    }
    let display_name = std::env::var(DISPLAY_NAME_ENV).ok()?;
    let slug = crate::claims::agent_slug(&display_name);
    if slug.is_empty() {
        return None;
    }
    let home = std::env::var("HOME").ok()?;
    Some(
        PathBuf::from(home)
            .join(".buzz")
            .join("WORKING_STATE")
            .join(format!("{slug}.claims.json")),
    )
}

/// Append the harness-owned `BUZZ_ACP_SESSION_ID` slot pin to an `extra_env`
/// slice a spawn caller is building. Harness-owned key: set unconditionally
/// (the caller's pin wins over `AcpClient::spawn`'s fallback by construction;
/// this module does not touch `AcpClient::spawn`).
pub(crate) fn session_env(
    mut env: Vec<(String, String)>,
    agent_index: usize,
) -> Vec<(String, String)> {
    env.push((SESSION_ID_ENV.to_string(), slot_id(agent_index)));
    env
}

/// One in-flight turn as it lands in `managed.turns`. The change-detection
/// fingerprint is this whole struct — deliberately excluding `last_seen_at`,
/// which the pulse refreshes without the turn set changing.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TurnEntry {
    slot: String,
    channel: Uuid,
    started_at: SystemTime,
    acp_session: Option<String>,
}

impl TurnEntry {
    fn to_json(&self, last_seen_at: &str) -> Value {
        json!({
            "slot": self.slot,
            "channel": self.channel.to_string(),
            "started_at": rfc3339(self.started_at),
            "last_seen_at": last_seen_at,
            "acp_session": self.acp_session,
        })
    }
}

/// Snapshot this pool's in-flight channel tasks as [`TurnEntry`] material.
/// Heartbeat tasks (`channel_id: None`) have no channel to gate and are
/// skipped.
fn snapshot_from_pool(pool: &crate::pool::AgentPool) -> Vec<TurnEntry> {
    let mut snapshot: Vec<TurnEntry> = pool
        .task_map()
        .values()
        .filter_map(|meta| {
            Some(TurnEntry {
                slot: slot_id(meta.agent_index),
                channel: meta.channel_id?,
                started_at: meta.started_at,
                acp_session: meta.acp_session.clone(),
            })
        })
        .collect();
    snapshot.sort_by(|a, b| a.slot.cmp(&b.slot));
    snapshot
}

/// Change-detected claims sync state, held by the main loop.
///
/// The loop calls [`ClaimsSyncState::sync_on_change`] once per iteration —
/// every `task_map` mutation in the loop (dispatch insert, turn-end removal,
/// panic recovery) funnels through exactly one of the loop's arms, so a
/// fingerprint comparison at the top of the loop covers all of them without
/// touching the pinned dispatch/result functions. Writes happen only when the
/// own-turn snapshot actually changed, and never before this process has
/// anything to say (an idle boot must not create or churn the file).
#[derive(Default)]
pub(crate) struct ClaimsSyncState {
    last_snapshot: Option<Vec<TurnEntry>>,
    ever_wrote: bool,
}

impl ClaimsSyncState {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Write when the pool's own turn snapshot changed since the last write.
    pub(crate) fn sync_on_change(&mut self, pool: &crate::pool::AgentPool) {
        let snapshot = snapshot_from_pool(pool);
        if self.last_snapshot.as_ref() == Some(&snapshot) {
            return;
        }
        if snapshot.is_empty() && !self.ever_wrote {
            // Idle boot with nothing to clear — stay silent (no churn on an
            // idle pool). The next real turn writes normally.
            self.last_snapshot = Some(snapshot);
            return;
        }
        if write_turn_snapshot(&snapshot).is_ok() {
            self.ever_wrote = true;
            self.last_snapshot = Some(snapshot);
        }
        // Write failures leave the state un-advanced so the next call retries.
    }

    /// The slow pulse: re-stamp `last_seen_at` for every live turn so a turn
    /// that outlives one TTL interval stays fresh. Only runs while
    /// `task_map` is non-empty — no churn on an idle pool.
    pub(crate) fn pulse(&mut self, pool: &crate::pool::AgentPool) {
        if pool.task_map().is_empty() {
            return;
        }
        let snapshot = snapshot_from_pool(pool);
        if write_turn_snapshot(&snapshot).is_ok() {
            self.ever_wrote = true;
            self.last_snapshot = Some(snapshot);
        }
    }
}

/// Publish the current turn snapshot into the claims file's `managed`
/// section. No-op (silently) when the writer is disabled or no claims path
/// can be derived; I/O failures are logged and otherwise swallowed — a wedged
/// claims file must never wedge the harness.
fn write_turn_snapshot(snapshot: &[TurnEntry]) -> std::io::Result<()> {
    if !writer_enabled() {
        return Ok(());
    }
    let Some(path) = resolve_claims_file_for_write() else {
        return Ok(());
    };
    let result = write_managed_turns(&path, snapshot);
    if let Err(error) = &result {
        tracing::warn!(
            claims_file = %path.display(),
            %error,
            "claims writer: failed to publish managed turn claims"
        );
    }
    result
}

/// Read-modify-write the `managed` key under the sidecar flock.
///
/// - Foreign-boot turns (slot not prefixed with this boot's id) survive while
///   fresh and are dropped once past [`TURN_TTL_SECS`] — a dead second pool's
///   claims decay without any mtime heuristics, while a live one keeps its
///   own entries fresh via its pulse.
/// - Own-boot turns are replaced by `snapshot` wholesale — this is what makes
///   a turn-end write clear the entry.
/// - `managed.superseded` (the CLI's arbitration annex) passes through
///   verbatim. The writer never prunes or edits it; pruning happens only in
///   the CLI at append time.
/// - Every other key in the document passes through untouched. An unparseable
///   document is preserved under `_unparseable_before` rather than destroyed.
fn write_managed_turns(path: &Path, snapshot: &[TurnEntry]) -> std::io::Result<()> {
    with_claims_lock(path, |raw| {
        let mut doc = match raw {
            Some(raw) => serde_json::from_str::<Value>(&raw)
                .unwrap_or_else(|_| json!({ "_unparseable_before": raw })),
            None => json!({}),
        };
        let now = chrono::Utc::now();
        let previous = doc.get("managed").cloned().unwrap_or(Value::Null);
        let foreign_fresh: Vec<Value> = previous
            .get("turns")
            .and_then(Value::as_array)
            .map(|turns| {
                turns
                    .iter()
                    .filter(|turn| foreign_turn_is_fresh(turn, now))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let mut turns = foreign_fresh;
        turns.extend(
            snapshot
                .iter()
                .map(|entry| entry.to_json(&rfc3339(now.into()))),
        );
        doc["managed"] = json!({
            "pool": boot_id(),
            "pid": std::process::id(),
            "updated_at": rfc3339(now.into()),
            "turns": turns,
            "superseded": previous
                .get("superseded")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
        });
        atomic_write(path, &serde_json::to_string(&doc)?)
    })
}

/// Whether a turn claim from the claims file belongs to another boot and is
/// still inside the TTL. Own-boot entries are never carried (the snapshot is
/// authoritative for this process); foreign entries that cannot prove
/// freshness (missing or unparseable `last_seen_at`) are dropped.
fn foreign_turn_is_fresh(turn: &Value, now: chrono::DateTime<chrono::Utc>) -> bool {
    let Some(slot) = turn.get("slot").and_then(Value::as_str) else {
        return false;
    };
    if slot.starts_with(&format!("{}:", boot_id())) {
        return false;
    }
    let Some(last_seen_at) = turn
        .get("last_seen_at")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
    else {
        return false;
    };
    (now - last_seen_at.with_timezone(&chrono::Utc)) <= chrono::Duration::seconds(TURN_TTL_SECS)
}

/// Run `f` while holding an exclusive advisory flock on the `<name>.lock`
/// sidecar of `path` (created if missing). The same protocol is implemented
/// by the CLI's `claims_gate` — one lock discipline, both sides.
///
/// Blocking `flock` is deliberate: the critical section is a read + tiny
/// write of a small JSON doc, the kernel releases the lock if the holder
/// dies, and the write cadence is per turn / 60 s pulse — contention is
/// effectively nil.
pub(crate) fn with_claims_lock<T>(
    path: &Path,
    f: impl FnOnce(Option<String>) -> std::io::Result<T>,
) -> std::io::Result<T> {
    let lock_path = lock_sidecar(path);
    #[cfg(unix)]
    {
        let lock_file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)?;
        let guard = Flock::lock(lock_file, FlockArg::LockExclusive)
            .map_err(|(_, errno)| std::io::Error::from(errno))?;
        let result = f(std::fs::read_to_string(path).ok());
        drop(guard); // unlock on drop
        result
    }
    #[cfg(not(unix))]
    {
        let _ = lock_path; // no advisory lock off unix; protocol degrades gracefully
        f(std::fs::read_to_string(path).ok())
    }
}

/// `<name>.lock` sibling of the claims file.
pub(crate) fn lock_sidecar(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".lock");
    path.with_file_name(name)
}

/// Write `body` to `.<name>.tmp` beside `path`, then rename over it — atomic
/// on macOS/Linux, so a concurrent reader never sees a torn document.
fn atomic_write(path: &Path, body: &str) -> std::io::Result<()> {
    let mut tmp_name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

/// RFC3339 UTC timestamp with millisecond precision (sub-second freshness so
/// the pulse's re-stamps are observable and claim ages are exact).
fn rfc3339(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pool::{AgentPool, TaskMeta};
    use std::collections::HashSet;

    /// Env vars are process-global; this module mutates `BUZZ_ACP_CLAIMS_FILE`
    /// and `BUZZ_ACP_CLAIMS_WRITER`, so it must serialize against the
    /// claim-router tests (which mutate `BUZZ_ACP_CLAIMS_FILE` under their
    /// own lock). One shared lock, no interleaving.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::CLAIMS_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A temp claims path (not created) unique per call.
    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "buzz-acp-claims-writer-{name}-{}.json",
            Uuid::new_v4()
        ))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(lock_sidecar(path));
        let _ = std::fs::remove_file(path.with_file_name(format!(
            ".{}.tmp",
            path.file_name().unwrap_or_default().to_string_lossy()
        )));
    }

    /// The live writer shape from `~/.buzz/WORKING_STATE/evie.claims.json`
    /// (2026-09-11 19:26) — the fixture the preservation contract is pinned
    /// against. Every key here is a convention key or policy annex the writer
    /// must carry through untouched.
    fn live_shape_fixture(channel: &str) -> String {
        json!({
            "watching": [channel],
            "watching_at": "2026-09-11T18:50:00-05:00",
            "watching_note": "9/11 18:50 YIELD: c183da8e (Sam DM) is HELD BY THE EVENING SESSION tonight",
            "composing": null,
            "convention": "9/9 split, my half",
            "yielded": {
                "channel": "c183da8e-b5e6-4521-8522-b45dac07e0ee",
                "at": "2026-09-11T19:19:00-05:00",
                "holder": "evening session",
                "reason": "duet fired twice despite yield"
            },
            "blackout_log": [
                "19:20 CT: Sam teased 'your two personalities are fighting.'"
            ]
        })
        .to_string()
    }

    /// A pool with one in-flight channel task on slot `agent_index`.
    fn pool_with_turn(agent_index: usize, channel: Uuid) -> AgentPool {
        let mut pool = AgentPool::from_slots(vec![None, None]);
        let handle = pool.join_set.spawn(std::future::pending::<()>());
        pool.task_map_mut().insert(
            handle.id(),
            TaskMeta {
                agent_index,
                channel_id: Some(channel),
                turn_id: Uuid::new_v4().to_string(),
                recoverable_batch: None,
                control_tx: None,
                steer_tx: None,
                successful_steer_deliveries: HashSet::new(),
                started_at: SystemTime::now(),
                acp_session: Some("session-1".to_string()),
            },
        );
        pool
    }

    /// Spec test 1: the writer preserves every pre-existing key
    /// value-for-value and adds `managed`. Mutation it detects: replacing the
    /// read-modify-write with a fresh-doc overwrite (the fixture's annex keys
    /// vanish).
    #[tokio::test]
    async fn writer_preserves_annex_keys_and_adds_managed() {
        let _guard = env_lock();
        let channel = Uuid::new_v4();
        let path = temp_path("preserve");
        std::fs::write(&path, live_shape_fixture(&channel.to_string()))
            .expect("seed live-shape fixture");
        std::env::set_var("BUZZ_ACP_CLAIMS_FILE", &path);

        let before: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read fixture"))
                .expect("fixture parses");

        let pool = pool_with_turn(0, channel);
        let mut state = ClaimsSyncState::new();
        state.sync_on_change(&pool);

        let after: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read after write"))
                .expect("post-write doc parses");

        // Every pre-existing key survives value-for-value.
        for key in [
            "watching",
            "watching_at",
            "watching_note",
            "composing",
            "convention",
            "yielded",
            "blackout_log",
        ] {
            assert_eq!(
                before.get(key),
                after.get(key),
                "key {key} must survive the write untouched"
            );
        }

        // `managed` is added with the documented shape and this boot's turn.
        let managed = after
            .get("managed")
            .expect("managed section added by the write");
        assert_eq!(managed["pool"].as_str(), Some(boot_id()));
        assert_eq!(managed["pid"].as_u64(), Some(u64::from(std::process::id())));
        assert!(managed["updated_at"].is_string(), "updated_at stamped");
        let turns = managed["turns"].as_array().expect("turns array");
        assert_eq!(turns.len(), 1, "exactly the pool's one live turn");
        assert_eq!(turns[0]["slot"].as_str(), Some(slot_id(0).as_str()));
        assert_eq!(
            turns[0]["channel"].as_str(),
            Some(channel.to_string().as_str())
        );
        assert_eq!(turns[0]["acp_session"].as_str(), Some("session-1"));
        assert!(turns[0]["started_at"].is_string());
        assert!(turns[0]["last_seen_at"].is_string());
        assert!(managed["superseded"].is_array(), "superseded array present");

        cleanup(&path);
        std::env::remove_var("BUZZ_ACP_CLAIMS_FILE");
    }

    /// Spec test 1 companion: an unparseable pre-existing doc is preserved
    /// under `_unparseable_before`, never destroyed.
    #[tokio::test]
    async fn writer_preserves_unparseable_predecessor() {
        let _guard = env_lock();
        let path = temp_path("unparseable");
        let raw = "{ this is not json ";
        std::fs::write(&path, raw).expect("seed malformed doc");
        std::env::set_var("BUZZ_ACP_CLAIMS_FILE", &path);

        let pool = pool_with_turn(0, Uuid::new_v4());
        let mut state = ClaimsSyncState::new();
        state.sync_on_change(&pool);

        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read after write"))
                .expect("post-write doc parses");
        assert_eq!(
            doc["_unparseable_before"].as_str(),
            Some(raw),
            "the original raw text must be preserved"
        );

        cleanup(&path);
        std::env::remove_var("BUZZ_ACP_CLAIMS_FILE");
    }

    /// Spec test 2b: a pre-seeded `managed.superseded` record survives at
    /// least three writer write-cycles — the writer must carry it forward
    /// verbatim (neither rebuild-without-carry nor writer-side pruning may
    /// eat it). Pruning is the CLI's job at append time only.
    #[tokio::test]
    async fn superseded_record_survives_three_writer_cycles() {
        let _guard = env_lock();
        let channel = Uuid::new_v4();
        let path = temp_path("superseded-carry");
        let supersede_record = json!({
            "channel": channel.to_string(),
            "holder": "dead-boot:0",
            "by": "other-boot:1",
            "at": "2026-09-11T19:30:00.000Z"
        });
        std::fs::write(
            &path,
            json!({
                "watching": [channel.to_string()],
                "managed": {"superseded": [supersede_record.clone()]}
            })
            .to_string(),
        )
        .expect("seed doc with superseded record");
        std::env::set_var("BUZZ_ACP_CLAIMS_FILE", &path);

        for cycle in 0..3 {
            let pool = pool_with_turn(cycle % 2, channel);
            let mut state = ClaimsSyncState::new();
            state.sync_on_change(&pool);

            let doc: Value = serde_json::from_str(
                &std::fs::read_to_string(&path).expect("read after write cycle"),
            )
            .expect("doc parses");
            let carried = doc["managed"]["superseded"].as_array().expect("array");
            assert_eq!(
                carried.len(),
                1,
                "cycle {cycle}: exactly the pre-seeded record"
            );
            assert_eq!(
                carried[0], supersede_record,
                "cycle {cycle}: record passes through verbatim"
            );
        }

        cleanup(&path);
        std::env::remove_var("BUZZ_ACP_CLAIMS_FILE");
    }

    /// Spec test 3: a turn claim is present while the task is live, its
    /// `last_seen_at` advances under the pulse, and the entry is gone after
    /// the turn ends. Mutations it detects: (a) the writer merging own-boot
    /// entries from the file instead of replacing them from the snapshot
    /// (stale claim persists after turn end); (b) the pulse not re-stamping.
    #[tokio::test]
    async fn turn_claim_lives_while_task_lives_and_clears_at_turn_end() {
        let _guard = env_lock();
        let channel = Uuid::new_v4();
        let path = temp_path("lifecycle");
        std::env::set_var("BUZZ_ACP_CLAIMS_FILE", &path);

        let mut pool = pool_with_turn(0, channel);
        let mut state = ClaimsSyncState::new();
        state.sync_on_change(&pool);

        let turns_of = |raw: String| -> Vec<Value> {
            serde_json::from_str::<Value>(&raw).expect("doc parses")["managed"]["turns"]
                .as_array()
                .expect("turns array")
                .clone()
        };

        let first = turns_of(std::fs::read_to_string(&path).expect("read"));
        assert_eq!(
            first.len(),
            1,
            "claim present while the task is in task_map"
        );
        assert_eq!(first[0]["slot"].as_str(), Some(slot_id(0).as_str()));

        // Pulse re-stamp: same snapshot, later timestamp.
        std::thread::sleep(std::time::Duration::from_millis(30));
        state.pulse(&pool);
        let second = turns_of(std::fs::read_to_string(&path).expect("read"));
        assert_eq!(second.len(), 1, "pulse keeps exactly the live turn");
        assert!(
            second[0]["last_seen_at"].as_str() > first[0]["last_seen_at"].as_str(),
            "pulse must advance last_seen_at"
        );

        // Turn over: task leaves task_map, next sync clears the claim.
        pool.task_map_mut().clear();
        state.sync_on_change(&pool);
        let third = turns_of(std::fs::read_to_string(&path).expect("read"));
        assert!(
            third.is_empty(),
            "claim must be gone after the turn ends, got: {third:?}"
        );

        cleanup(&path);
        std::env::remove_var("BUZZ_ACP_CLAIMS_FILE");
    }

    /// A foreign boot's FRESH turn survives this writer's sync (two live
    /// pools must see each other — that is the bug being guarded); a foreign
    /// STALE turn decays by TTL. Own-boot entries are always replaced by the
    /// snapshot.
    #[tokio::test]
    async fn foreign_fresh_turn_survives_and_stale_one_decays() {
        let _guard = env_lock();
        let channel = Uuid::new_v4();
        let path = temp_path("foreign");
        let fresh_seen = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let stale_seen = (chrono::Utc::now() - chrono::Duration::seconds(TURN_TTL_SECS + 60))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        std::fs::write(
            &path,
            json!({
                "managed": {"turns": [
                    {"slot": "other-boot:0", "channel": channel.to_string(),
                     "started_at": fresh_seen, "last_seen_at": fresh_seen,
                     "acp_session": null},
                    {"slot": "dead-boot:1", "channel": channel.to_string(),
                     "started_at": stale_seen, "last_seen_at": stale_seen,
                     "acp_session": null}
                ]}
            })
            .to_string(),
        )
        .expect("seed foreign turns");
        std::env::set_var("BUZZ_ACP_CLAIMS_FILE", &path);

        let pool = pool_with_turn(0, channel);
        let mut state = ClaimsSyncState::new();
        state.sync_on_change(&pool);

        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("parses");
        let turns = doc["managed"]["turns"].as_array().expect("turns");
        let slots: Vec<&str> = turns.iter().filter_map(|t| t["slot"].as_str()).collect();
        assert_eq!(
            slots.len(),
            2,
            "own turn + the foreign fresh turn; got {slots:?}"
        );
        assert!(slots.contains(&slot_id(0).as_str()), "own turn present");
        assert!(
            slots.contains(&"other-boot:0"),
            "foreign fresh turn must survive the merge"
        );
        assert!(
            !slots.iter().any(|s| s.starts_with("dead-boot:")),
            "foreign stale turn must decay by TTL"
        );

        cleanup(&path);
        std::env::remove_var("BUZZ_ACP_CLAIMS_FILE");
    }

    /// `BUZZ_ACP_CLAIMS_WRITER=0` disables the writer entirely — the file is
    /// left byte-identical. Mutation it detects: the kill-switch being
    /// ignored.
    #[tokio::test]
    async fn kill_switch_disables_the_writer() {
        let _guard = env_lock();
        let path = temp_path("kill-switch");
        let seeded = json!({"watching": ["x"]}).to_string();
        std::fs::write(&path, &seeded).expect("seed");
        std::env::set_var("BUZZ_ACP_CLAIMS_FILE", &path);
        std::env::set_var("BUZZ_ACP_CLAIMS_WRITER", "0");

        let pool = pool_with_turn(0, Uuid::new_v4());
        let mut state = ClaimsSyncState::new();
        state.sync_on_change(&pool);
        state.pulse(&pool);

        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            seeded,
            "disabled writer must not touch the file"
        );

        std::env::remove_var("BUZZ_ACP_CLAIMS_WRITER");
        cleanup(&path);
        std::env::remove_var("BUZZ_ACP_CLAIMS_FILE");
    }

    /// An idle boot never creates the file (no churn on an idle pool); once
    /// this process has written, the empty snapshot after turn-end IS
    /// written (to clear).
    #[tokio::test]
    async fn idle_boot_does_not_create_file_but_turn_end_clears() {
        let _guard = env_lock();
        let path = temp_path("idle");
        std::env::set_var("BUZZ_ACP_CLAIMS_FILE", &path);

        let mut state = ClaimsSyncState::new();
        let empty_pool = AgentPool::from_slots(vec![None]);
        state.sync_on_change(&empty_pool);
        assert!(
            !path.exists(),
            "an idle boot must not create the claims file"
        );

        let channel = Uuid::new_v4();
        let mut pool = pool_with_turn(0, channel);
        state.sync_on_change(&pool);
        assert!(path.exists(), "a real turn writes the file");

        pool.task_map_mut().clear();
        state.sync_on_change(&pool);
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("parses");
        assert!(
            doc["managed"]["turns"]
                .as_array()
                .expect("turns")
                .is_empty(),
            "turn-end write clears the claims even though the snapshot is empty"
        );

        cleanup(&path);
        std::env::remove_var("BUZZ_ACP_CLAIMS_FILE");
    }

    /// The slot pin helper: appends the harness-owned env pair without
    /// disturbing the caller's slice.
    #[test]
    fn session_env_appends_slot_pin() {
        let env = vec![("EXISTING".to_string(), "1".to_string())];
        let pinned = session_env(env, 2);
        assert_eq!(pinned.len(), 2);
        assert_eq!(pinned[0].0, "EXISTING");
        assert_eq!(pinned[1].0, SESSION_ID_ENV);
        assert_eq!(pinned[1].1, slot_id(2));
        assert!(slot_id(2).contains(':'), "slot id is boot-scoped");
        assert_ne!(slot_id(0), slot_id(1), "slots differ per agent index");
    }
}
