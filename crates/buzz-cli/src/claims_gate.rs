//! Send-path hold gate — the CLI half of the managed turn-claims protocol.
//!
//! The ACP harness owns session lifecycle in-process and WRITES ground-truth
//! turn claims into the shared claims document
//! (`~/.buzz/WORKING_STATE/<slug>.claims.json`, or the `BUZZ_ACP_CLAIMS_FILE`
//! override) — see `buzz-acp`'s `claims_writer`. This module ENFORCES them on
//! the send path, the chokepoint every agent reply already passes through:
//! a managed session (`BUZZ_ACP_SESSION_ID` set) that tries to publish into a
//! channel where another of its slots is mid-turn gets bounced with
//! [`crate::error::CliError::Held`] (exit code 6) instead of duetting in a
//! DM.
//!
//! Contract points, in order of how badly breaking them hurts:
//!
//! - **Fail-open everywhere.** A missing, unreadable, or malformed claims
//!   file — a wedged claims file — must never wedge a DM. Anything that
//!   cannot be evaluated reads as "no hold" and the send proceeds.
//! - **Humans and ad-hoc shells are never gated.** The gate is active only
//!   when `BUZZ_ACP_SESSION_ID` is set AND a claims file resolves; with the
//!   env absent there is no file I/O beyond the existence check.
//! - **Composing, not watching.** Only `managed.turns` entries gate. The
//!   voluntary `watching` / `composing` / annex keys are coordination policy
//!   the gate never reads — the watcher+composer room-sharing pattern is
//!   preserved.
//! - **A hold is terminal, not transient.** It must not read as a retryable
//!   failure; standing down IS a complete reply.
//!
//! The lock/atomicity protocol (advisory `flock` on a `<name>.lock` sidecar
//! around the whole read-modify-write, published via tmp+rename) is the same
//! one the harness writer implements — one protocol, both sides.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use uuid::Uuid;

/// How long a turn claim stays live after its `last_seen_at`. Mirrors
/// buzz-acp's `claims::COMPOSING_TTL_SECS` (the Guard B dispatch-time reader)
/// so both gates answer "is a session of me active?" on the same clock.
pub(crate) const TURN_TTL_SECS: i64 = 10 * 60;

/// `managed.superseded` is pruned to this many most-recent records at append
/// time — the only place pruning ever happens (the harness writer carries the
/// array through verbatim).
pub(crate) const SUPERSEDED_CAP: usize = 20;

/// Env var carrying the boot-scoped slot id the harness injected into this
/// session. Its presence is what makes a CLI invocation "managed".
const SESSION_ID_ENV: &str = "BUZZ_ACP_SESSION_ID";

/// Env override pointing at the claims file (same contract as the harness).
const CLAIMS_FILE_ENV: &str = "BUZZ_ACP_CLAIMS_FILE";

/// Env var carrying the agent display name — the source of the claims-file
/// slug (same contract as the harness).
const DISPLAY_NAME_ENV: &str = "BUZZ_ACP_DISPLAY_NAME";

/// Agent-side convention, self-describing at the point of failure. Emitted in
/// the `Held` error's JSON as `advice`.
pub(crate) const HELD_ADVICE: &str = "This is a hold, not a failure. Another session of you is mid-turn in this channel. Stand down — a bounce answers 'should I speak?' and no is a complete reply.";

/// A surviving foreign turn claim: the reason a send would be held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hold {
    /// Channel the foreign claim gates.
    pub(crate) channel: Uuid,
    /// Boot-scoped slot id of the holding session (`<boot-id>:<index>`).
    pub(crate) holder_slot: String,
    /// Seconds since the claim's `last_seen_at` (clamped at zero — a slightly
    /// future stamp is clock skew, not a negative age).
    pub(crate) claim_age_secs: i64,
    /// The freshness window, for the agent's decision-making: [`TURN_TTL_SECS`].
    pub(crate) ttl_secs: i64,
}

/// The managed session slot for this invocation, or `None` when the CLI is
/// unmanaged (human, ad-hoc shell). A blank value reads as unset.
pub(crate) fn session_slot() -> Option<String> {
    std::env::var(SESSION_ID_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Derive the claims-file slug from an agent display name.
///
/// Mirror of buzz-acp's `claims::agent_slug` — one path protocol, both
/// sides; the two must stay in sync (lowercase, whitespace runs collapse to
/// a single dash, non-alphanumeric-or-dash dropped).
fn agent_slug(display_name: &str) -> String {
    display_name
        .trim()
        .to_lowercase()
        .split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect::<String>()
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Resolve the claims file the way the harness's Guard B reader does: the
/// `CLAIMS_FILE_ENV` override wins, else the conventional
/// `$HOME/.buzz/WORKING_STATE/<slug>.claims.json` — gated on existence, so an
/// unmanaged or never-written agent never touches the gate.
pub(crate) fn active_claims_path() -> Option<PathBuf> {
    if let Ok(overridden) = std::env::var(CLAIMS_FILE_ENV) {
        let overridden = overridden.trim();
        if !overridden.is_empty() {
            return Some(PathBuf::from(overridden));
        }
    }
    let display_name = std::env::var(DISPLAY_NAME_ENV).ok()?;
    let slug = agent_slug(&display_name);
    if slug.is_empty() {
        return None;
    }
    let home = std::env::var("HOME").ok()?;
    let path = PathBuf::from(home)
        .join(".buzz")
        .join("WORKING_STATE")
        .join(format!("{slug}.claims.json"));
    path.exists().then_some(path)
}

/// The hold check for one send: resolve the claims file, read it under the
/// sidecar flock, and report the first surviving foreign turn claim on
/// `channel`. Fail-open by contract — every failure mode (no session, no
/// resolvable file, unreadable file, malformed JSON, unparseable timestamps)
/// reads as "no hold".
pub(crate) fn check_hold(channel: &Uuid, self_slot: &str) -> Option<Hold> {
    let path = active_claims_path()?;
    let raw = read_claims(&path)?;
    evaluate_hold(&raw, channel, self_slot, Utc::now())
}

/// Pure hold evaluation over an already-read claims document — the testable
/// seam for the gate's decision rules (spec: prefer the pure function).
///
/// A claim survives — and produces a [`Hold`] — when it targets `channel`,
/// belongs to a different slot, has a parseable `last_seen_at` within
/// [`TURN_TTL_SECS`], and is not voided by a matching `managed.superseded`
/// record (same channel + holder, recorded at or after the claim started).
pub fn evaluate_hold(
    claims_json: &str,
    channel: &Uuid,
    self_slot: &str,
    now: DateTime<Utc>,
) -> Option<Hold> {
    surviving_claims(claims_json, channel, self_slot, now)
        .into_iter()
        .next()
}

/// All foreign turn claims on `channel` that survive the same rules
/// [`evaluate_hold`] applies — the supersede path needs every holder, not
/// just the first.
pub fn surviving_claims(
    claims_json: &str,
    channel: &Uuid,
    self_slot: &str,
    now: DateTime<Utc>,
) -> Vec<Hold> {
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(claims_json) else {
        return Vec::new();
    };
    let Some(managed) = doc.get("managed") else {
        return Vec::new();
    };
    let superseded = managed.get("superseded").and_then(|s| s.as_array());
    let mut holds = Vec::new();
    for turn in managed
        .get("turns")
        .and_then(|t| t.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(slot) = turn.get("slot").and_then(|s| s.as_str()) else {
            continue;
        };
        if slot == self_slot {
            continue;
        }
        let Some(turn_channel) = turn
            .get("channel")
            .and_then(|c| c.as_str())
            .and_then(|c| Uuid::parse_str(c).ok())
        else {
            continue;
        };
        if &turn_channel != channel {
            continue;
        }
        let Some(last_seen_at) = turn
            .get("last_seen_at")
            .and_then(|s| s.as_str())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|s| s.with_timezone(&Utc))
        else {
            continue;
        };
        // A slightly future stamp (clock skew between sessions) counts as
        // live, mirroring the harness reader's composing rule.
        let age_secs = (now - last_seen_at).num_seconds();
        if age_secs > TURN_TTL_SECS {
            continue;
        }
        if is_voided_by_supersede(superseded, channel, slot, turn.get("started_at"), now) {
            continue;
        }
        holds.push(Hold {
            channel: *channel,
            holder_slot: slot.to_string(),
            claim_age_secs: age_secs.max(0),
            ttl_secs: TURN_TTL_SECS,
        });
    }
    holds
}

/// Whether a `managed.superseded` record voids this claim: same channel, same
/// holder, recorded at or after the claim started. The started-at comparison
/// is what keeps an old supersede from permanently silencing a NEW turn by
/// the same slot; a record whose `at` (or the claim's `started_at`) cannot be
/// parsed never voids anything — fail-open, like every timestamp here.
fn is_voided_by_supersede(
    superseded: Option<&Vec<serde_json::Value>>,
    channel: &Uuid,
    holder_slot: &str,
    started_at: Option<&serde_json::Value>,
    now: DateTime<Utc>,
) -> bool {
    let Some(records) = superseded else {
        return false;
    };
    let started_at = started_at
        .and_then(|s| s.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|s| s.with_timezone(&Utc));
    records.iter().any(|record| {
        if record.get("holder").and_then(|h| h.as_str()) != Some(holder_slot) {
            return false;
        }
        let record_channel = record
            .get("channel")
            .and_then(|c| c.as_str())
            .and_then(|c| Uuid::parse_str(c).ok());
        if record_channel.as_ref() != Some(channel) {
            return false;
        }
        let Some(at) = record
            .get("at")
            .and_then(|a| a.as_str())
            .and_then(|a| DateTime::parse_from_rfc3339(a).ok())
            .map(|a| a.with_timezone(&Utc))
        else {
            return false;
        };
        match started_at {
            // Claim started before the supersede: it was live when the holder
            // was overridden — void it.
            Some(started) => at >= started,
            // No parseable start: the supersede still voids within its own
            // freshness window (a dead-holder escape works against a claim
            // whose harness died before stamping a parseable start).
            None => (now - at) <= chrono::Duration::seconds(TURN_TTL_SECS),
        }
    })
}

/// The identity stamp tag for a managed session: `["session", "<slot>"]`,
/// appended to the outgoing event's tags by the send path.
pub(crate) fn session_tag(slot: &str) -> Vec<String> {
    vec!["session".to_string(), slot.to_string()]
}

/// Record a `--supersede` for this send, best-effort: under the flock, append
/// `{channel, holder, by: self_slot, at}` for every surviving foreign claim
/// on the channel (pruned to the most recent [`SUPERSEDED_CAP`]), then let
/// the send proceed regardless. A dead or wedged claims file still allows the
/// supersede send — it is a CLI write, not a harness write, and failure to
/// record must never block the escape hatch.
pub(crate) fn record_supersedes(channel: &Uuid, self_slot: &str) {
    let Some(path) = active_claims_path() else {
        return;
    };
    if let Err(error) = append_superseded(&path, channel, self_slot, Utc::now()) {
        eprintln!(
            "{}",
            serde_json::json!({
                "error": "supersede_record_failed",
                "message": format!("could not record the supersede (send proceeds): {error}"),
            })
        );
    }
}

/// Read-modify-write `managed.superseded` under the sidecar flock: find the
/// surviving foreign claims on `channel` from the doc as read INSIDE the
/// lock, append a record per holder stamped `by: self_slot`, prune to the
/// most recent [`SUPERSEDED_CAP`], publish via tmp+rename. A malformed doc —
/// or one that parses but is not an object — is preserved under
/// `_unparseable_before`, never destroyed.
pub(crate) fn append_superseded(
    path: &std::path::Path,
    channel: &Uuid,
    self_slot: &str,
    now: DateTime<Utc>,
) -> std::io::Result<()> {
    with_claims_lock(path, |raw| {
        let mut doc: serde_json::Value = match raw {
            Some(raw) => serde_json::from_str(&raw)
                .unwrap_or_else(|_| serde_json::json!({ "_unparseable_before": raw })),
            None => serde_json::json!({}),
        };
        // A doc that parses but is not an object cannot host `managed`
        // without destroying it — preserve it instead, same as malformed.
        if !doc.is_object() {
            let preserved = raw_from_lock_value(&doc);
            doc = serde_json::json!({ "_unparseable_before": preserved });
        }
        // Holders as seen inside the lock — a record must name the claim that
        // actually survived, not one a concurrent writer already cleared.
        let holders: Vec<String> = surviving_claims(
            &serde_json::to_string(&doc).map_err(|e| std::io::Error::other(e.to_string()))?,
            channel,
            self_slot,
            now,
        )
        .into_iter()
        .map(|hold| hold.holder_slot)
        .collect();

        let Some(object) = doc.as_object_mut() else {
            return Ok(());
        };
        let managed = object
            .entry("managed")
            .or_insert_with(|| serde_json::json!({}));
        let Some(managed_object) = managed.as_object_mut() else {
            // `managed` exists but is not an object: leave the doc untouched
            // rather than overwrite foreign structure we do not understand.
            return Ok(());
        };
        let mut list = managed_object
            .get("superseded")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();
        for holder in &holders {
            list.push(serde_json::json!({
                "channel": channel.to_string(),
                "holder": holder,
                "by": self_slot,
                "at": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }));
        }
        managed_object.insert(
            "superseded".to_string(),
            serde_json::Value::Array(prune_superseded(&list, SUPERSEDED_CAP)),
        );
        atomic_write(path, &serde_json::to_string(&doc)?)
    })
}

/// Render a lock-read [`serde_json::Value`] back to the raw text used to
/// preserve it (a round-trip through `to_string` is lossless for JSON).
fn raw_from_lock_value(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

/// Keep the most recent `cap` records by `at` (unparseable timestamps sort
/// oldest, so they prune first); order-stable within equal keys.
pub(crate) fn prune_superseded(
    records: &[serde_json::Value],
    cap: usize,
) -> Vec<serde_json::Value> {
    if records.len() <= cap {
        return records.to_vec();
    }
    let mut indexed: Vec<(DateTime<Utc>, usize)> = records
        .iter()
        .enumerate()
        .map(|(index, record)| {
            let at = record
                .get("at")
                .and_then(|a| a.as_str())
                .and_then(|a| DateTime::parse_from_rfc3339(a).ok())
                .map(|a| a.with_timezone(&Utc))
                .unwrap_or(DateTime::<Utc>::MIN_UTC);
            (at, index)
        })
        .collect();
    indexed.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    indexed
        .into_iter()
        .take(cap)
        .map(|(_, index)| records[index].clone())
        .collect()
}

/// Read the claims document under the sidecar flock, or `None` when missing
/// (fail-open).
fn read_claims(path: &std::path::Path) -> Option<String> {
    with_claims_lock(path, Ok).ok().flatten()
}

/// Run `f` while holding an exclusive advisory flock on the `<name>.lock`
/// sidecar of `path` (created if missing) — the same protocol the harness
/// writer implements. Blocking is deliberate: the critical section is a tiny
/// read + write of a small JSON doc, and the kernel releases the lock if the
/// holder dies.
pub(crate) fn with_claims_lock<T>(
    path: &std::path::Path,
    f: impl FnOnce(Option<String>) -> std::io::Result<T>,
) -> std::io::Result<T> {
    #[cfg(unix)]
    {
        let lock_path = lock_sidecar(path);
        let lock_file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)?;
        let guard = nix::fcntl::Flock::lock(lock_file, nix::fcntl::FlockArg::LockExclusive)
            .map_err(|(_, errno)| std::io::Error::from(errno))?;
        let result = f(std::fs::read_to_string(path).ok());
        drop(guard); // unlock on drop
        result
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        f(std::fs::read_to_string(path).ok())
    }
}

/// `<name>.lock` sibling of the claims file (same derivation as the harness).
#[cfg(unix)]
fn lock_sidecar(path: &std::path::Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".lock");
    path.with_file_name(name)
}

/// Write `body` to `.<name>.tmp` beside `path`, then rename over it — atomic
/// on macOS/Linux, so a concurrent reader never sees a torn document.
fn atomic_write(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    let tmp = {
        let mut tmp_name = path
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_default();
        tmp_name.push(".tmp");
        path.with_file_name(tmp_name)
    };
    #[cfg(not(unix))]
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Env vars are process-global; these tests touch
    /// `BUZZ_ACP_SESSION_ID` / `BUZZ_ACP_CLAIMS_FILE` and must run serially.
    static GATE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        GATE_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "buzz-cli-claims-gate-{name}-{}.json",
            Uuid::new_v4()
        ))
    }

    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
        #[cfg(unix)]
        {
            let mut name = path.file_name().unwrap_or_default().to_os_string();
            name.push(".lock");
            let _ = std::fs::remove_file(path.with_file_name(name));
        }
    }

    fn channel_c() -> Uuid {
        Uuid::parse_str("c183da8e-b5e6-4521-8522-b45dac07e0ee").expect("fixed channel uuid")
    }

    /// A doc with one foreign turn claim on `channel`, `age_secs` old, plus
    /// the convention keys the gate must ignore.
    fn doc_with_turn(channel: &Uuid, age_secs: i64) -> String {
        let seen = (Utc::now() - chrono::Duration::seconds(age_secs))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        serde_json::json!({
            "watching": [channel.to_string()],
            "composing": null,
            "convention": "9/9 split",
            "managed": {
                "pool": "other-boot",
                "turns": [
                    {"slot": "other-boot:0", "channel": channel.to_string(),
                     "started_at": seen, "last_seen_at": seen, "acp_session": "s-1"}
                ],
                "superseded": []
            }
        })
        .to_string()
    }

    /// Spec test 4: a fresh foreign turn claim holds the send. Mutation it
    /// detects: disabling the check (evaluate_hold never returns a Hold).
    #[test]
    fn fresh_foreign_turn_claim_holds() {
        let channel = channel_c();
        let hold = evaluate_hold(
            &doc_with_turn(&channel, 42),
            &channel,
            "me-boot:7",
            Utc::now(),
        )
        .expect("a fresh foreign claim must hold");
        assert_eq!(hold.channel, channel);
        assert_eq!(hold.holder_slot, "other-boot:0");
        assert_eq!(hold.ttl_secs, 600);
        assert!(
            (30..=42).contains(&hold.claim_age_secs),
            "claim age ~42s, got {}",
            hold.claim_age_secs
        );
    }

    /// Spec test 5: a stale claim (11 minutes) does not bounce. Stale = no
    /// claim, same as the harness reader.
    #[test]
    fn stale_claim_does_not_hold() {
        let channel = channel_c();
        assert!(
            evaluate_hold(
                &doc_with_turn(&channel, 11 * 60),
                &channel,
                "me-boot:7",
                Utc::now()
            )
            .is_none(),
            "a claim 11 minutes stale must not hold"
        );
    }

    /// Spec test 6: the session's own claim never bounces itself.
    #[test]
    fn own_claim_does_not_hold() {
        let channel = channel_c();
        assert!(
            evaluate_hold(
                &doc_with_turn(&channel, 0),
                &channel,
                "other-boot:0",
                Utc::now()
            )
            .is_none(),
            "the holding session's own send must proceed"
        );
    }

    /// Spec test 7: a claim voided by a matching `managed.superseded` record
    /// (same channel + holder, recorded after the claim started) does not
    /// hold. A supersede recorded BEFORE the claim started must NOT void it —
    /// that would permanently silence a new turn by the same slot.
    #[test]
    fn superseded_claim_does_not_hold() {
        let channel = channel_c();
        let started = (Utc::now() - chrono::Duration::seconds(100))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let superseded_at = (Utc::now() - chrono::Duration::seconds(50))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut doc: serde_json::Value =
            serde_json::from_str(&doc_with_turn(&channel, 40)).expect("base doc parses");
        doc["managed"]["turns"][0]["started_at"] = serde_json::json!(started);
        doc["managed"]["superseded"] = serde_json::json!([
            {"channel": channel.to_string(), "holder": "other-boot:0",
             "by": "me-boot:7", "at": superseded_at}
        ]);
        assert!(
            evaluate_hold(&doc.to_string(), &channel, "me-boot:7", Utc::now()).is_none(),
            "a superseded claim must not hold"
        );

        // Supersede older than the claim's start: the claim is a NEW turn —
        // it holds again.
        doc["managed"]["superseded"][0]["at"] = serde_json::json!((Utc::now()
            - chrono::Duration::seconds(200))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        assert!(
            evaluate_hold(&doc.to_string(), &channel, "me-boot:7", Utc::now()).is_some(),
            "a supersede older than the claim's start must not void a new turn"
        );
    }

    /// Spec test 8: fail-open on malformed JSON, absent `managed`, unparseable
    /// timestamps — and the unmanaged split: with the env unset the gate is
    /// never even consulted.
    #[test]
    fn fail_open_and_unmanaged_paths() {
        let channel = channel_c();
        assert!(
            evaluate_hold("{ this is not json ", &channel, "me-boot:7", Utc::now()).is_none(),
            "malformed JSON must read as no hold"
        );
        assert!(
            evaluate_hold("{\"watching\": []}", &channel, "me-boot:7", Utc::now()).is_none(),
            "absent managed key must read as no hold (staged rollout: CLI no-ops before any writer)"
        );
        let doc = doc_with_turn(&channel, 10).replace("last_seen_at", "last_seen_AT");
        assert!(
            evaluate_hold(&doc, &channel, "me-boot:7", Utc::now()).is_none(),
            "unparseable last_seen_at must read as no hold"
        );

        let _guard = env_lock();
        std::env::remove_var(SESSION_ID_ENV);
        assert!(
            session_slot().is_none(),
            "env unset: unmanaged — the gate is not consulted at all"
        );
        std::env::set_var(SESSION_ID_ENV, "   ");
        assert!(session_slot().is_none(), "a blank slot id reads as unset");
        std::env::remove_var(SESSION_ID_ENV);
    }

    /// Spec test 8 (activation): the gate activates only when a claims file
    /// resolves; the override wins, the derived path is existence-gated.
    #[test]
    fn gate_activation_requires_resolvable_file() {
        let _guard = env_lock();
        let path = temp_path("activation");
        std::fs::write(&path, "{}").expect("create claims file");

        std::env::set_var(CLAIMS_FILE_ENV, &path);
        assert!(
            active_claims_path().is_some(),
            "override path resolves (the caller gates on session_slot before this)"
        );
        std::env::remove_var(CLAIMS_FILE_ENV);

        // Derived path: existence-gated, from the display name slug under a
        // redirected HOME so the test never touches the real one.
        let fake_home = std::env::temp_dir().join(format!("buzz-cli-gate-home-{}", Uuid::new_v4()));
        let derived = fake_home
            .join(".buzz")
            .join("WORKING_STATE")
            .join("gate-tester.claims.json");
        std::env::set_var(DISPLAY_NAME_ENV, "Gate Tester");
        std::env::set_var(HOME_VAR, &fake_home);
        assert!(
            active_claims_path().is_none(),
            "a non-existent derived claims file must not activate the gate"
        );
        std::fs::create_dir_all(derived.parent().expect("derived has a parent"))
            .expect("create WORKING_STATE dir");
        std::fs::write(&derived, "{}").expect("create derived claims file");
        assert_eq!(
            active_claims_path().as_deref(),
            Some(derived.as_path()),
            "an existing derived claims file resolves"
        );

        std::env::remove_var(DISPLAY_NAME_ENV);
        std::env::remove_var(HOME_VAR);
        cleanup(&path);
        let _ = std::fs::remove_dir_all(&fake_home);
    }

    const HOME_VAR: &str = "HOME";

    /// Spec test 9: the identity stamp tag. Present with a slot, and the
    /// helper emits exactly `["session", "<slot>"]`.
    #[test]
    fn session_tag_helper_appends_identity() {
        assert_eq!(
            session_tag("boot-1:0"),
            vec!["session".to_string(), "boot-1:0".to_string()],
            "the stamp is the [\"session\", slot] tag pair"
        );
    }

    /// Spec test 2 (lost-update): two concurrent read-modify-write cycles
    /// each append a DISTINCT superseded record — with the flock both
    /// survive; without it one vanishes. Also asserts the lock actually
    /// serializes: while an external holder owns the sidecar flock, an
    /// append waits instead of clobbering.
    #[test]
    fn concurrent_supersede_appends_do_not_lose_updates() {
        let channel = channel_c();
        let path = temp_path("lost-update");
        // One foreign claim: every append cycle adds exactly ONE record, so
        // 10 total appends must end as exactly 10 records — any fewer is a
        // lost update, and the 20-record prune cap is never reached (pruning
        // is intentional eviction, not a lost update, and must not mask one).
        let seen = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        std::fs::write(
            &path,
            serde_json::json!({
                "managed": {"turns": [
                    {"slot": "a-boot:0", "channel": channel.to_string(),
                     "started_at": seen, "last_seen_at": seen, "acp_session": null}
                ]}
            })
            .to_string(),
        )
        .expect("seed doc with one foreign claim");

        // Part 1 — the lock serializes: an external flock blocks an append.
        #[cfg(unix)]
        {
            let lock_file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(lock_sidecar(&path))
                .expect("open lock sidecar");
            let _external = nix::fcntl::Flock::lock(lock_file, nix::fcntl::FlockArg::LockExclusive)
                .expect("take external lock");
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let blocked_path = path.clone();
            std::thread::spawn(move || {
                let _ = append_superseded(&blocked_path, &channel, "me-boot:7", Utc::now());
                let _ = done_tx.send(());
            });
            std::thread::sleep(std::time::Duration::from_millis(300));
            assert!(
                done_rx
                    .recv_timeout(std::time::Duration::from_millis(1))
                    .is_err(),
                "append must block while the sidecar flock is held elsewhere — \
                 proceeding would be exactly the lost-update race"
            );
            drop(_external);
            done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("append completes once the lock is released");
        }

        // Part 2 — concurrent read-modify-write cycles, each appending a
        // DISTINCT superseded record. Six threads, six distinct channels
        // (one seeded foreign claim per channel), one append each, released
        // by a barrier so the RMWs truly overlap. Under the lock the cycles
        // serialize: all six records land. Without it the cycles are
        // whole-document last-writer-wins and five of the six vanish.
        //
        // (A single SHARED claim cannot discriminate: the first supersede
        // voids it, and the other threads then legitimately have nothing
        // left to record — that is gate semantics, not a lost update.)
        const LANES: usize = 6;
        let seen = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut turns = Vec::new();
        let mut lanes = Vec::new();
        for lane in 0..LANES {
            let channel = Uuid::new_v4();
            turns.push(serde_json::json!({
                "slot": format!("lane-boot:{lane}"), "channel": channel.to_string(),
                "started_at": seen, "last_seen_at": seen, "acp_session": null
            }));
            lanes.push(channel);
        }
        std::fs::write(
            &path,
            serde_json::json!({"managed": {"turns": turns}}).to_string(),
        )
        .expect("seed doc with one foreign claim per lane");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(LANES));
        let mut handles = Vec::new();
        for lane in 0..LANES {
            let path = path.clone();
            let target = lanes[lane];
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                append_superseded(&path, &target, "me-boot:7", Utc::now())
                    .expect("append under flock");
            }));
        }
        for handle in handles {
            handle.join().expect("append thread");
        }
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read final doc"))
                .expect("final doc parses");
        let records_out = doc["managed"]["superseded"]
            .as_array()
            .expect("superseded array");
        assert_eq!(
            records_out.len(),
            LANES,
            "every concurrent cycle's distinct record must survive — fewer is \
             a lost update (unserialized read-modify-write), got {}",
            records_out.len()
        );

        cleanup(&path);
    }

    /// Spec test 10: the supersede write appends, prunes to 20, preserves the
    /// annex keys, and records the superseded holder with the superseding
    /// slot. Mutation it detects: dropping the prune or the preservation.
    #[test]
    fn supersede_appends_prunes_and_preserves_annex() {
        let channel = channel_c();
        let path = temp_path("supersede");
        let mut old_records = Vec::new();
        for i in 0..25 {
            old_records.push(serde_json::json!({
                "channel": channel.to_string(),
                "holder": format!("old-boot:{i}"),
                "by": "escaper:0",
                "at": (Utc::now() - chrono::Duration::seconds(1000 - i))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }));
        }
        std::fs::write(
            &path,
            serde_json::json!({
                "watching": [channel.to_string()],
                "yielded": {"channel": channel.to_string(), "holder": "evening session"},
                "managed": {
                    "turns": [
                        {"slot": "old-boot:24", "channel": channel.to_string(),
                         "started_at": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                         "last_seen_at": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                         "acp_session": null}
                    ],
                    "superseded": old_records
                }
            })
            .to_string(),
        )
        .expect("seed 25 superseded records + one live foreign claim");

        append_superseded(&path, &channel, "me-boot:7", Utc::now()).expect("append succeeds");

        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("parses");
        let records = doc["managed"]["superseded"].as_array().expect("array");
        assert_eq!(
            records.len(),
            SUPERSEDED_CAP,
            "superseded pruned to the cap"
        );
        assert!(
            records
                .iter()
                .any(|r| r["by"].as_str() == Some("me-boot:7")),
            "the new record is among the kept (most recent) ones"
        );
        assert!(
            records
                .iter()
                .all(|r| r["holder"].as_str() != Some("old-boot:0")),
            "the OLDEST records prune first"
        );
        assert_eq!(
            doc["managed"]["turns"].as_array().expect("turns").len(),
            1,
            "the supersede append preserves managed.turns"
        );
        assert_eq!(
            doc["watching"].as_array().expect("watching").len(),
            1,
            "convention keys survive the CLI write"
        );
        assert!(
            doc.get("yielded").is_some(),
            "annex keys survive the CLI write"
        );

        // No surviving foreign claim → nothing is recorded, no error.
        let quiet = temp_path("supersede-quiet");
        std::fs::write(&quiet, serde_json::json!({"watching": []}).to_string())
            .expect("seed quiet doc");
        append_superseded(&quiet, &channel, "me-boot:7", Utc::now()).expect("quiet append");
        let quiet_doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&quiet).expect("read")).expect("parses");
        assert_eq!(
            quiet_doc["managed"]["superseded"]
                .as_array()
                .expect("array")
                .len(),
            0,
            "nothing to supersede → nothing recorded"
        );

        cleanup(&path);
        cleanup(&quiet);
    }

    /// The slug mirror stays behaviorally identical to the harness's.
    #[test]
    fn agent_slug_mirror_matches_harness_rules() {
        assert_eq!(agent_slug("Evie"), "evie");
        assert_eq!(agent_slug("Lord Nikon"), "lord-nikon");
        assert_eq!(agent_slug("  Acid   Burn "), "acid-burn");
        assert_eq!(agent_slug(""), "");
    }
}
