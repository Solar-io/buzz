//! Cross-process channel-claim folding — the router half of the 9/9 claims
//! convention.
//!
//! Agent sessions that live outside this process (e.g. a window-hours seat
//! holding a room) mark their claim in a JSON file under
//! `~/.buzz/WORKING_STATE/<agent-slug>.claims.json` before they speak. This
//! module is the other half of that convention: when the pool has no idle
//! session for a channel (an affinity miss in `dispatch_pending`),
//! [`claim_holds`](claim_holds) consults the file and folds dispatch back to
//! the queue while the claim is live, so a cold-boot slot never bifurcates a
//! conversation another seat is already in.
//!
//! Two keys are read. The live half is `managed.turns` (D-040, 2026-09-17):
//! the harness claims-writer publishes one entry per in-flight turn there
//! and pulses `last_seen_at` every 60s — since the 9/11 writer flip it is
//! the only key any writer emits, and until this rewrite the guard read
//! only the legacy `composing` shape, making it inert in production (the
//! "two of me" seam carried by the CLI send gate alone). The legacy half is
//! `composing` (the 9/9 voluntary convention for sessions outside this
//! harness): write-never since the flip, still read so a future voluntary
//! writer's claim folds without a router change.
//!
//! The convention's `watching` half is RETIRED here (2026-09-13): its
//! freshness carrier was the claims file's mtime, and once the harness
//! claims-writer took over the file the writer's own pulse kept that mtime
//! fresh on every live turn anywhere — so a stale `watching` entry could
//! fold its own channel forever across restarts, starving the first mention
//! until a full TTL of total pool idlety elapsed (the 2026-09-12 cbdb0795
//! incident). The voluntary writers that produced `watching` entries were
//! retired on 2026-09-11, making the key write-never legacy data; the
//! router no longer consults it, and the writer-side key-preservation
//! contract in `claims_writer` keeps old files round-tripping.
//!
//! Everything here fails open: a missing, unreadable, or malformed claims
//! file must never wedge a DM — it reads as "no claim" and dispatch proceeds.

use std::path::{Path, PathBuf};

use uuid::Uuid;

/// A live `composing` claim folds dispatch for at most this many seconds
/// after its `at` timestamp. A slightly future `at` (clock skew between
/// sessions) still counts as live.
pub(crate) const COMPOSING_TTL_SECS: i64 = 10 * 60;

/// A live `managed.turns` entry folds dispatch for at most this many seconds
/// after its `last_seen_at` pulse. This is the writer's own freshness window
/// — one window on all three sides (writer prune, CLI send gate, this fold)
/// so they cannot drift apart. See [`crate::claims_writer::STALE_HOLD_SECS`]
/// for the arithmetic: a 60s pulse, so 150s = two missed pulses plus margin,
/// and past it the foreign holder is dead or wedged.
use crate::claims_writer::STALE_HOLD_SECS;

/// Env override pointing at the claims file, bypassing the derived path.
/// Used verbatim when set — a missing file at the override simply reads as
/// no claim (fail-open).
const CLAIMS_FILE_ENV: &str = "BUZZ_ACP_CLAIMS_FILE";

/// Env var carrying the agent display name. Set by the desktop at spawn —
/// the same contract `build_mcp_servers` forwards for git attribution — and
/// the source of the claims-file slug.
const DISPLAY_NAME_ENV: &str = "BUZZ_ACP_DISPLAY_NAME";

/// Derive the claims-file slug from an agent display name: lowercase, each
/// whitespace run collapsed to a single dash, anything that is not
/// alphanumeric or a dash dropped (`"Evie"` → `"evie"`, `"Lord Nikon"` →
/// `"lord-nikon"`). Returns an empty string for names with nothing usable.
pub(crate) fn agent_slug(display_name: &str) -> String {
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

/// Resolve this process's claims file.
///
/// [`CLAIMS_FILE_ENV`] wins when set to a non-empty value. Otherwise the
/// conventional `$HOME/.buzz/WORKING_STATE/<agent-slug>.claims.json` is used
/// when it exists; when it does not (or no display name / home is available),
/// `None` disables the claims-file fold entirely — no error, nothing logged
/// above `debug`.
pub(crate) fn resolve_claims_file() -> Option<PathBuf> {
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

#[derive(Debug, serde::Deserialize)]
struct ClaimsDoc {
    #[serde(default)]
    composing: Option<ComposingClaim>,
    /// The harness claims-writer's live section (since the 9/11 flip, the
    /// only key any writer emits). Absent in old-convention files — reads as
    /// no managed claim, and the legacy `composing` half still applies.
    #[serde(default)]
    managed: Option<ManagedSection>,
}

#[derive(Debug, serde::Deserialize)]
struct ComposingClaim {
    channel: Uuid,
    at: String,
}

/// `managed.turns` — one entry per in-flight harness turn. Channels and
/// timestamps stay strings here and are parsed per-entry inside
/// [`claim_holds`], so one corrupt foreign entry contributes nothing without
/// blinding the guard to the others (or to `composing`).
///
/// `acp_session` is deliberately not a field. It is attribution-only, and
/// second-slot rows carry `null` (observed live 2026-09-16: a `null` slot-1
/// row and a stamped slot-0 row pulsing in the same file) — a real live
/// turn either way. Liveness is `last_seen_at` alone; leaving the field
/// undeclared makes a `Some`-filter on it impossible to write by accident.
/// The D-040 scope ruling: null-session rows fold.
#[derive(Debug, serde::Deserialize)]
struct ManagedSection {
    #[serde(default)]
    turns: Vec<ManagedTurn>,
}

#[derive(Debug, serde::Deserialize)]
struct ManagedTurn {
    /// Both fields default to empty when a foreign writer omits them, so a
    /// shape-corrupt entry parses as an entry and then fails per-entry
    /// (empty strings parse as neither uuid nor timestamp) — it must not
    /// fail the whole document and blind the guard to its siblings.
    #[serde(default)]
    channel: String,
    #[serde(default)]
    last_seen_at: String,
}

/// Whether a live claim in `path` holds `channel_id`.
///
/// Folds when a `managed.turns` entry's `channel` is `channel_id` and its
/// `last_seen_at` pulse parsed within the last [`STALE_HOLD_SECS`] seconds
/// (the live convention), or when `composing.channel` is `channel_id` and
/// `composing.at` parsed within the last [`COMPOSING_TTL_SECS`] seconds (the
/// legacy voluntary convention). The convention's `watching` key and the
/// `managed.superseded` annex are deliberately not consulted — watching for
/// the reasons in the module docs, superseded because arbitration is
/// enforced at the CLI send gate; this fold answers only "is a turn live,"
/// and a superseded holder's entry decays with its pulse.
///
/// Fail-open by contract: a missing file, unreadable file, malformed JSON, an
/// unparseable timestamp, or any I/O error reads as "no claim" and is logged
/// at `debug` (this can be probed per dispatch, so never louder). A branch
/// that cannot be evaluated simply contributes nothing. Stale claim = no
/// claim.
pub(crate) fn claim_holds(path: &Path, channel_id: Uuid) -> bool {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) => {
            tracing::debug!(
                claims_file = %path.display(),
                %error,
                "claims file unreadable — treating as no claim"
            );
            return false;
        }
    };
    let doc: ClaimsDoc = match serde_json::from_str(&raw) {
        Ok(doc) => doc,
        Err(error) => {
            tracing::debug!(
                claims_file = %path.display(),
                %error,
                "claims file malformed — treating as no claim"
            );
            return false;
        }
    };

    if let Some(managed) = &doc.managed {
        for turn in &managed.turns {
            let channel = match Uuid::parse_str(&turn.channel) {
                Ok(channel) => channel,
                Err(error) => {
                    tracing::debug!(
                        claims_file = %path.display(),
                        %error,
                        "managed turn channel unparseable — ignoring entry"
                    );
                    continue;
                }
            };
            if channel != channel_id {
                continue;
            }
            match chrono::DateTime::parse_from_rfc3339(&turn.last_seen_at) {
                Ok(last_seen) => {
                    let age = chrono::Utc::now() - last_seen.with_timezone(&chrono::Utc);
                    if age <= chrono::Duration::seconds(STALE_HOLD_SECS) {
                        return true;
                    }
                }
                Err(error) => {
                    tracing::debug!(
                        claims_file = %path.display(),
                        %error,
                        "managed turn last_seen_at unparseable — ignoring entry"
                    );
                }
            }
        }
    }

    if let Some(composing) = &doc.composing {
        if composing.channel == channel_id {
            match chrono::DateTime::parse_from_rfc3339(&composing.at) {
                Ok(at) => {
                    let age = chrono::Utc::now() - at.with_timezone(&chrono::Utc);
                    if age <= chrono::Duration::seconds(COMPOSING_TTL_SECS) {
                        return true;
                    }
                }
                Err(error) => {
                    tracing::debug!(
                        claims_file = %path.display(),
                        %error,
                        "composing.at unparseable — ignoring composing claim"
                    );
                }
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write `body` to a unique temp claims file and return its path.
    fn temp_claims(body: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("buzz-acp-claims-{}.json", Uuid::new_v4()));
        std::fs::write(&path, body).expect("write temp claims file");
        path
    }

    /// Best-effort temp-file cleanup.
    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
    }

    /// Claims-file body with a `composing` claim on `channel` stamped
    /// `age_secs` in the past, plus the live convention keys the router must
    /// ignore.
    fn composing_body(channel: Uuid, age_secs: i64) -> String {
        let at = (chrono::Utc::now() - chrono::Duration::seconds(age_secs)).to_rfc3339();
        serde_json::json!({
            "composing": {"channel": channel.to_string(), "at": at, "note": "x"},
            "convention": "9/9 split"
        })
        .to_string()
    }

    /// Claims-file body with `watching` containing `channel`.
    fn watching_body(channel: Uuid) -> String {
        serde_json::json!({"watching": [channel.to_string()]}).to_string()
    }

    #[test]
    fn agent_slug_lowercases_and_dashes_whitespace() {
        assert_eq!(agent_slug("Evie"), "evie");
        assert_eq!(agent_slug("Lord Nikon"), "lord-nikon");
        assert_eq!(agent_slug("  Acid   Burn "), "acid-burn");
        assert_eq!(agent_slug("Cereal Killer!"), "cereal-killer");
        assert_eq!(agent_slug(""), "");
        assert_eq!(agent_slug("   "), "");
    }

    /// Contract pin against the live writer shape (Evie's seat, 2026-09-10
    /// 19:18): `watching_at` / `watching_note` extra keys, `composing` null
    /// between replies, `convention` prose. The router must still parse this
    /// exact document — unknown keys ignored, null composing reading as no
    /// claim — but the `watching` fold itself is RETIRED (2026-09-13: a stale
    /// `watching` entry kept fresh by the claims writer's pulse folded its own
    /// channel across a restart and starved the first mention for 13 minutes).
    /// If either side of the 9/9 convention drifts, this test is what names it.
    #[test]
    fn live_writer_shape_parses_and_ignores_watching() {
        let sam_dm = Uuid::parse_str("c183da8e-b5e6-4521-8522-b45dac07e0ee").unwrap();
        let group_dm = Uuid::parse_str("cbdb0795-1cbe-4c36-9c1e-4e5833187b24").unwrap();
        let body = serde_json::json!({
            "watching": [sam_dm.to_string(), group_dm.to_string()],
            "watching_at": "2026-09-10T19:18:46-05:00",
            "watching_note": "evening window seat; re-stamped each watch round",
            "composing": null,
            "convention": "9/9 split, my half"
        })
        .to_string();
        let path = temp_claims(&body);
        // Fresh mtime + watching membership → NO channel folds: the watching
        // fold is retired, and the legacy keys must be inert.
        assert!(!claim_holds(&path, sam_dm), "retired watching claim must not fold");
        assert!(!claim_holds(&path, group_dm), "retired watching claim must not fold");
        // null composing contributes nothing; an unwatched channel never folds.
        let other = Uuid::new_v4();
        assert!(!claim_holds(&path, other), "unwatched channel must not fold");
        // And the doc still deserializes (unknown keys ignored, not an error).
        let doc: ClaimsDoc = serde_json::from_str(&body).expect("live shape must deserialize");
        assert!(doc.composing.is_none(), "null composing reads as no claim");
        cleanup(&path);
    }

    #[test]
    fn fresh_composing_claim_holds() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&composing_body(channel, 60));
        assert!(claim_holds(&path, channel), "fresh composing must fold");
        cleanup(&path);
    }

    #[test]
    fn stale_composing_claim_does_not_hold() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&composing_body(channel, 11 * 60));
        assert!(
            !claim_holds(&path, channel),
            "composing older than 10 minutes must not fold"
        );
        cleanup(&path);
    }

    #[test]
    fn composing_claim_for_other_channel_does_not_hold() {
        let claimed = Uuid::new_v4();
        let asked = Uuid::new_v4();
        let path = temp_claims(&composing_body(claimed, 0));
        assert!(
            !claim_holds(&path, asked),
            "a claim on another channel must not fold this one"
        );
        cleanup(&path);
    }

    /// Claims-file body with a `managed.turns` entry on `channel` stamped
    /// `age_secs` in the past, in the writer's real field shape.
    fn managed_body(channel: Uuid, age_secs: i64) -> String {
        let now = chrono::Utc::now();
        let stamp = |delta: i64| (now - chrono::Duration::seconds(delta)).to_rfc3339();
        serde_json::json!({
            "managed": {
                "pid": 4242,
                "pool": "11111111-2222-3333-4444-555555555555",
                "superseded": [{
                    "at": stamp(600),
                    "by": "11111111-2222-3333-4444-555555555555:0",
                    "channel": channel.to_string(),
                    "holder": "99999999-8888-7777-6666-555555555555:0"
                }],
                "turns": [{
                    "slot": "11111111-2222-3333-4444-555555555555:1",
                    "channel": channel.to_string(),
                    "started_at": stamp(age_secs + 30),
                    "last_seen_at": stamp(age_secs),
                    "acp_session": null
                }],
                "updated_at": stamp(age_secs)
            }
        })
        .to_string()
    }

    /// The D-040 rewrite's core: a fresh `managed.turns` pulse on the asked
    /// channel folds. `acp_session: null` is in the fixture on purpose — see
    /// `managed_turn_with_null_session_folds`.
    #[test]
    fn fresh_managed_turn_holds() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&managed_body(channel, 60));
        assert!(claim_holds(&path, channel), "fresh managed turn must fold");
        cleanup(&path);
    }

    /// Past the 150s window (two missed pulses plus margin) the foreign
    /// holder is dead or wedged and must not fold.
    #[test]
    fn stale_managed_turn_does_not_hold() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&managed_body(channel, 200));
        assert!(
            !claim_holds(&path, channel),
            "managed turn older than the 150s stale window must not fold"
        );
        cleanup(&path);
    }

    /// The null-scope ruling as a pin (D-040, Dwight's 2026-09-16 16:04
    /// live-row finding): second-slot rows carry `acp_session: null` and are
    /// real live turns — liveness is `last_seen_at` alone. If a future typed
    /// reintroduction grows a `Some`-filter on the session field, this is
    /// the test that names the regression: the fixture's entry is null and
    /// fresh, and it must fold.
    #[test]
    fn managed_turn_with_null_session_folds() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&managed_body(channel, 30));
        assert!(
            claim_holds(&path, channel),
            "a null-acp_session turn is a live turn and must fold"
        );
        cleanup(&path);
    }

    #[test]
    fn managed_turn_for_other_channel_does_not_hold() {
        let claimed = Uuid::new_v4();
        let asked = Uuid::new_v4();
        let path = temp_claims(&managed_body(claimed, 30));
        assert!(
            !claim_holds(&path, asked),
            "a managed turn on another channel must not fold this one"
        );
        cleanup(&path);
    }

    /// Per-entry tolerance: one corrupt channel uuid must blind the guard
    /// neither to a live sibling entry nor to the legacy composing half.
    #[test]
    fn corrupt_managed_entry_does_not_blind_the_rest() {
        let channel = Uuid::new_v4();
        let now = chrono::Utc::now();
        let at = (now - chrono::Duration::seconds(10)).to_rfc3339();
        let body = serde_json::json!({
            "managed": {"turns": [
                {"channel": "not-a-uuid", "last_seen_at": at, "slot": "x:0"},
                {"channel": channel.to_string(), "last_seen_at": at, "slot": "x:1"}
            ]}
        })
        .to_string();
        let path = temp_claims(&body);
        assert!(
            claim_holds(&path, channel),
            "a corrupt sibling entry must not hide the live one"
        );
        cleanup(&path);
    }

    #[test]
    fn unparseable_managed_last_seen_fails_open() {
        let channel = Uuid::new_v4();
        let body = serde_json::json!({
            "managed": {"turns": [
                {"channel": channel.to_string(), "last_seen_at": "not-a-timestamp", "slot": "x:0"}
            ]}
        })
        .to_string();
        let path = temp_claims(&body);
        assert!(
            !claim_holds(&path, channel),
            "bad managed last_seen_at must fail open"
        );
        cleanup(&path);
    }

    /// Contract pin against the live writer's full document (Cereal Killer's
    /// seat, 2026-09-17 12:17Z): `pid`/`pool`/`updated_at` keys alongside
    /// `turns`, a populated `superseded` annex, one pulsing turn. The turn's
    /// channel folds; a channel named only in `superseded` does NOT —
    /// arbitration belongs to the CLI send gate, this fold answers only "is
    /// a turn live."
    #[test]
    fn live_writer_managed_shape_parses_and_folds() {
        let turn_channel = Uuid::parse_str("d624b034-36a3-4a2f-b2e7-d170908d7e66").unwrap();
        let superseded_channel = Uuid::parse_str("c3309d9d-3ee5-52c1-8309-e6738b177a19").unwrap();
        let body = r#"{"managed":{"pid":57783,"pool":"2ce08fea-7145-4552-9e7e-4117f16f5afc","superseded":[{"at":"2026-09-12T23:10:36.069Z","by":"e3b5e133-1cb4-4f45-9f95-40d6fd7412f1:1","channel":"c3309d9d-3ee5-52c1-8309-e6738b177a19","holder":"2cd470ce-8131-4c20-9911-392afa372826:0"}],"turns":[{"acp_session":"140d4a20-cba2-4f8d-8ab2-051057f36911","channel":"d624b034-36a3-4a2f-b2e7-d170908d7e66","last_seen_at":"RECENT","slot":"2ce08fea-7145-4552-9e7e-4117f16f5afc:1","started_at":"2026-09-17T12:15:46.519Z"}],"updated_at":"2026-09-17T12:17:16.838Z"}}"#;
        let recent = (chrono::Utc::now() - chrono::Duration::seconds(45)).to_rfc3339();
        let body = body.replace("RECENT", &recent);
        let path = temp_claims(&body);
        assert!(
            claim_holds(&path, turn_channel),
            "the live turn's channel must fold"
        );
        assert!(
            !claim_holds(&path, superseded_channel),
            "a superseded-record channel is not a live turn and must not fold"
        );
        cleanup(&path);
    }

    /// Old-convention files (pre-writer, no `managed` key) keep their
    /// `composing` fold — the voluntary half regresses nothing.
    #[test]
    fn managed_absent_legacy_composing_still_holds() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&composing_body(channel, 60));
        assert!(
            claim_holds(&path, channel),
            "composing must still fold when managed is absent"
        );
        cleanup(&path);
    }

    /// Window pin for the two halves having DIFFERENT windows: 300s is stale
    /// for `managed.turns` (150s) but fresh for `composing` (600s). Catches
    /// the exact regression the first cut shipped and QA caught (2026-09-17):
    /// a broad text revert collapsed the composing window onto the managed
    /// one and nothing in the suite noticed — this test is the guard that
    /// would have.
    #[test]
    fn composing_between_the_two_windows_still_holds() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&composing_body(channel, 300));
        assert!(
            claim_holds(&path, channel),
            "a 300s-old composing claim is inside its own 600s window and must fold"
        );
        // And the mirror: 300s is past the managed window.
        let path = temp_claims(&managed_body(channel, 300));
        assert!(
            !claim_holds(&path, channel),
            "a 300s-old managed pulse is past the 150s window and must not fold"
        );
        cleanup(&path);
    }

    /// Shape-corrupt entry (keys missing entirely) is tolerated per-entry —
    /// it neither folds nor blinds the guard to a live sibling. Without the
    /// `#[serde(default)]` on the turn fields this shape fails the whole
    /// document's deserialization and kills the entire guard incl. composing.
    #[test]
    fn shape_corrupt_managed_entry_is_tolerated_per_entry() {
        let channel = Uuid::new_v4();
        let at = (chrono::Utc::now() - chrono::Duration::seconds(10)).to_rfc3339();
        let body = serde_json::json!({
            "managed": {"turns": [
                {"slot": "x:0", "channel": channel.to_string()},
                {"slot": "x:1", "channel": channel.to_string(), "last_seen_at": at}
            ]}
        })
        .to_string();
        let path = temp_claims(&body);
        assert!(
            claim_holds(&path, channel),
            "an entry with a missing last_seen_at must not hide the live sibling"
        );
        cleanup(&path);
    }

    #[test]
    fn watching_is_no_longer_read_even_with_a_fresh_mtime() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&watching_body(channel));
        assert!(
            !claim_holds(&path, channel),
            "watching is retired: even a just-written file must not fold"
        );
        cleanup(&path);
    }

    #[test]
    fn malformed_and_missing_files_fail_open() {
        let channel = Uuid::new_v4();
        let path = temp_claims("{ this is not json ");
        assert!(
            !claim_holds(&path, channel),
            "malformed JSON must read as no claim"
        );
        cleanup(&path);

        let missing =
            std::env::temp_dir().join(format!("buzz-acp-claims-missing-{}.json", Uuid::new_v4()));
        assert!(
            !claim_holds(&missing, channel),
            "missing file must read as no claim"
        );
    }

    #[test]
    fn unparseable_composing_at_reads_as_no_claim() {
        let channel = Uuid::new_v4();
        let body = serde_json::json!({
            "watching": [channel.to_string()],
            "composing": {"channel": channel.to_string(), "at": "not-a-timestamp"}
        })
        .to_string();
        let path = temp_claims(&body);
        assert!(
            !claim_holds(&path, channel),
            "bad composing.at must fail open (legacy watching key stays inert)"
        );
        cleanup(&path);
    }
}
