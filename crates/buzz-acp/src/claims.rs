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
//! Everything here fails open: a missing, unreadable, or malformed claims
//! file must never wedge a DM — it reads as "no claim" and dispatch proceeds.

use std::path::{Path, PathBuf};

use uuid::Uuid;

/// A live `composing` claim folds dispatch for at most this many seconds
/// after its `at` timestamp. A slightly future `at` (clock skew between
/// sessions) still counts as live.
pub(crate) const COMPOSING_TTL_SECS: i64 = 10 * 60;

/// A `watching` claim folds dispatch for at most this many seconds after the
/// claims file's mtime. The mtime is the heartbeat: the holder rewrites the
/// file on each mark, so a dead session's claim goes stale and stops folding.
pub(crate) const WATCHING_TTL_SECS: u64 = 15 * 60;

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
    watching: Vec<Uuid>,
    #[serde(default)]
    composing: Option<ComposingClaim>,
}

#[derive(Debug, serde::Deserialize)]
struct ComposingClaim {
    channel: Uuid,
    at: String,
}

/// Whether a live claim in `path` holds `channel_id`.
///
/// Folds when either branch is live:
///
/// - `composing.channel` is `channel_id` and `composing.at` parsed within the
///   last [`COMPOSING_TTL_SECS`] seconds, or
/// - `watching` contains `channel_id` and the file's mtime is within the last
///   [`WATCHING_TTL_SECS`] seconds (a future mtime — skew — counts as fresh).
///
/// Fail-open by contract: a missing file, unreadable file, malformed JSON, an
/// unparseable timestamp, or any I/O error reads as "no claim" and is logged
/// at `debug` (this can be probed per dispatch, so never louder). A branch
/// that cannot be evaluated simply contributes nothing; the other branch is
/// still consulted. Stale claim = no claim.
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

    if doc.watching.contains(&channel_id) {
        match metadata_modified(path) {
            Ok(mtime) => match std::time::SystemTime::now().duration_since(mtime) {
                Ok(elapsed) => {
                    if elapsed.as_secs() <= WATCHING_TTL_SECS {
                        return true;
                    }
                }
                // mtime in the future (clock skew) counts as fresh.
                Err(_) => return true,
            },
            Err(error) => {
                tracing::debug!(
                    claims_file = %path.display(),
                    %error,
                    "claims file mtime unreadable — ignoring watching claim"
                );
            }
        }
    }

    false
}

/// mtime of `path`, or the I/O error that prevented reading it.
fn metadata_modified(path: &Path) -> std::io::Result<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|metadata| metadata.modified())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::Duration;

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

    /// Backdate a file's mtime by `age` using `File::set_times` (stable since
    /// Rust 1.75 — no extra dependency needed for mtime control).
    fn backdate_mtime(path: &Path, age: Duration) {
        let modified = std::time::SystemTime::now() - age;
        let file = File::options()
            .write(true)
            .open(path)
            .expect("open claims file for mtime");
        file.set_times(std::fs::FileTimes::new().set_modified(modified))
            .expect("backdate claims file mtime");
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
    /// between replies, `convention` prose. The router must parse this exact
    /// document — unknown keys ignored, null composing reading as no claim —
    /// and fold on the `watching` array while mtime is fresh. If either side
    /// of the 9/9 convention drifts, this test is what names it.
    #[test]
    fn live_writer_shape_parses_and_folds_on_watching() {
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
        // Fresh mtime (just written) + watching membership → both channels fold.
        assert!(claim_holds(&path, sam_dm), "live shape must fold a watched channel");
        assert!(claim_holds(&path, group_dm), "live shape must fold the second watched channel");
        // null composing contributes nothing; an unwatched channel never folds.
        let other = Uuid::new_v4();
        assert!(!claim_holds(&path, other), "unwatched channel must not fold");
        // And the doc deserializes with the expected fields.
        let doc: ClaimsDoc = serde_json::from_str(&body).expect("live shape must deserialize");
        assert_eq!(doc.watching, vec![sam_dm, group_dm]);
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

    #[test]
    fn watching_with_fresh_mtime_holds() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&watching_body(channel));
        assert!(
            claim_holds(&path, channel),
            "watching with a just-written file must fold"
        );
        cleanup(&path);
    }

    #[test]
    fn watching_with_stale_mtime_does_not_hold() {
        let channel = Uuid::new_v4();
        let path = temp_claims(&watching_body(channel));
        backdate_mtime(&path, Duration::from_secs(16 * 60));
        assert!(
            !claim_holds(&path, channel),
            "watching with a 16-minute-old file must not fold"
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
    fn unparseable_composing_at_does_not_kill_watching_branch() {
        let channel = Uuid::new_v4();
        let body = serde_json::json!({
            "watching": [channel.to_string()],
            "composing": {"channel": channel.to_string(), "at": "not-a-timestamp"}
        })
        .to_string();
        let path = temp_claims(&body);
        assert!(
            claim_holds(&path, channel),
            "bad composing.at must not mask a live watching claim"
        );
        cleanup(&path);
    }
}
