//! Channel reference resolution — the `#team` / name addressing layer.
//!
//! Every `--channel` argument on the read and send paths accepts BOTH the
//! canonical channel UUID (fast path — parsed locally, zero network) and a
//! human handle: `platform team`, `#platform-team`, and `Platform_Team` all
//! resolve to the same channel.
//!
//! Matching is **slug equality, never substring**: the handle and each
//! channel's name are normalized (see [`normalize_channel_slug`]) and must
//! match exactly. Zero matches is a usage error that lists the caller's
//! visible channels; two or more matches (e.g. several channels named "DM")
//! is a usage error that lists the colliding candidates with their UUIDs so
//! the caller can disambiguate in one retry. Uniqueness is enforced
//! best-effort at channel create time by [`assert_slug_available`]; the
//! resolution-side ambiguity refusal is the backstop for channels that
//! predate that check.
//!
//! Resolution is client-side by design: it reads the same kind:39000 group
//! metadata the relay already serves (visibility-scoped by its access
//! control) and requires no relay changes. The relay stays the source of
//! truth for what the caller may see and address.

use uuid::Uuid;

use crate::client::BuzzClient;
use crate::error::CliError;

/// How many visible channel names to include in a zero-match error before
/// truncating — enough to self-correct a typo, not a wall of text.
const CANDIDATE_LIST_CAP: usize = 20;

/// A channel's addressing-relevant projection from its kind:39000 metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChannelCandidate {
    pub(crate) channel_id: String,
    pub(crate) name: String,
    pub(crate) archived: bool,
}

/// Normalize a channel name or user-typed handle into its slug form.
///
/// One leading `#` is stripped; the rest is lowercased; every run of
/// non-alphanumeric characters (whitespace, `-`, `_`, punctuation) collapses
/// to a single `-`; leading/trailing `-` are trimmed. `Platform Team`,
/// `#platform-team`, and `platform_team` therefore all produce
/// `platform-team` — separator choice and case are style, not identity.
pub(crate) fn normalize_channel_slug(input: &str) -> String {
    let stripped = input.trim();
    let stripped = stripped.strip_prefix('#').unwrap_or(stripped);
    let mut slug = String::with_capacity(stripped.len());
    let mut pending_dash = false;
    for ch in stripped.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    slug
}

/// Project kind:39000 metadata events into [`ChannelCandidate`]s.
///
/// Events lacking a `d` (channel UUID) or `name` tag are skipped — they are
/// not addressable by name.
pub(crate) fn channel_candidates(events: &[serde_json::Value]) -> Vec<ChannelCandidate> {
    events
        .iter()
        .filter_map(|event| {
            let tags = event.get("tags")?.as_array()?;
            let mut channel_id: Option<String> = None;
            let mut name: Option<String> = None;
            let mut archived = false;
            for tag in tags {
                let Some(tag_arr) = tag.as_array() else {
                    continue;
                };
                let key = tag_arr.first().and_then(|v| v.as_str()).unwrap_or("");
                let val = tag_arr.get(1).and_then(|v| v.as_str());
                match key {
                    "d" => channel_id = val.map(str::to_string),
                    "name" => name = val.map(str::to_string),
                    "archived" => archived = val == Some("true"),
                    _ => {}
                }
            }
            Some(ChannelCandidate {
                channel_id: channel_id?,
                name: name?,
                archived,
            })
        })
        .collect()
}

/// Format the candidate list for a usage error, capped at
/// [`CANDIDATE_LIST_CAP`] entries with a truncation note.
fn format_candidates(candidates: &[ChannelCandidate]) -> serde_json::Value {
    let shown: Vec<serde_json::Value> = candidates
        .iter()
        .take(CANDIDATE_LIST_CAP)
        .map(|c| {
            serde_json::json!({
                "channel_id": c.channel_id,
                "name": c.name,
                "archived": c.archived,
            })
        })
        .collect();
    let mut list = serde_json::Value::Array(shown);
    if candidates.len() > CANDIDATE_LIST_CAP {
        list = serde_json::json!({
            "candidates": list,
            "truncated": true,
            "total": candidates.len(),
        });
    }
    list
}

/// Fetch the caller's visible channel metadata (kind:39000, all pages).
async fn visible_channels(client: &BuzzClient) -> Result<Vec<ChannelCandidate>, CliError> {
    let filter = serde_json::json!({ "kinds": [39000] });
    let events = client.query_all(filter).await?;
    Ok(channel_candidates(&events))
}

/// The resolver's matching rule, extracted so it is unit-testable without a
/// relay: slug equality against non-archived candidates — never substring.
pub(crate) fn match_slug<'a>(
    candidates: &'a [ChannelCandidate],
    needle: &str,
) -> Vec<&'a ChannelCandidate> {
    candidates
        .iter()
        .filter(|c| !c.archived && normalize_channel_slug(&c.name) == needle)
        .collect()
}

/// Resolve a `--channel` argument to a channel UUID.
///
/// UUID arguments parse locally with no network I/O. Name arguments are
/// slug-matched against the caller's visible, non-archived channels and must
/// match exactly one.
pub(crate) async fn resolve_channel_uuid(
    client: &BuzzClient,
    channel_arg: &str,
) -> Result<Uuid, CliError> {
    let trimmed = channel_arg.trim();
    if trimmed.is_empty() {
        return Err(CliError::Usage("--channel cannot be empty".into()));
    }
    // Fast path: a UUID never touches the network. This keeps scripted and
    // harness callers (which always have the canonical UUID) on the exact
    // same code path and I/O profile as before name addressing existed.
    if let Ok(uuid) = Uuid::parse_str(trimmed) {
        return Ok(uuid);
    }

    let needle = normalize_channel_slug(trimmed);
    if needle.is_empty() {
        return Err(CliError::Usage(format!(
            "--channel '{channel_arg}' is not a UUID and has no alphanumeric characters to match on"
        )));
    }

    let candidates = visible_channels(client).await?;
    let matches = match_slug(&candidates, &needle);

    match matches.as_slice() {
        [single] => Uuid::parse_str(&single.channel_id).map_err(|_| {
            CliError::Other(format!(
                "channel '{}' has a malformed id '{}' in its metadata",
                single.name, single.channel_id
            ))
        }),
        [] => {
            let names: Vec<ChannelCandidate> = candidates
                .iter()
                .filter(|c| !c.archived)
                .cloned()
                .collect();
            Err(CliError::Usage(
                serde_json::json!({
                    "message": format!("no visible channel matches '{trimmed}' (normalized '{needle}')"),
                    "candidates": format_candidates(&names),
                    "hint": "try 'buzz channels list' — or use the channel UUID directly",
                })
                .to_string(),
            ))
        }
        many => Err(CliError::Usage(
            serde_json::json!({
                "message": format!("'{}' is ambiguous — {} channels share the normalized name '{}'", trimmed, many.len(), needle),
                "candidates": format_candidates(
                    &many.iter().map(|c| (*c).clone()).collect::<Vec<_>>()
                ),
                "hint": "retry with the channel UUID of the channel you meant",
            })
            .to_string(),
        )),
    }
}

/// Best-effort create-time guard: refuse a new channel whose name collides
/// (after normalization) with a visible existing channel, so name addressing
/// stays trustworthy going forward. Scoped to the caller's visibility — the
/// relay remains the authority on what exists.
pub(crate) async fn assert_slug_available(client: &BuzzClient, name: &str) -> Result<(), CliError> {
    let needle = normalize_channel_slug(name);
    if needle.is_empty() {
        return Err(CliError::Usage(
            "channel name must contain alphanumeric characters".into(),
        ));
    }
    let candidates = visible_channels(client).await?;
    let collisions: Vec<ChannelCandidate> = match_slug(&candidates, &needle)
        .into_iter()
        .cloned()
        .collect();
    if collisions.is_empty() {
        return Ok(());
    }
    Err(CliError::Usage(
        serde_json::json!({
            "message": format!("channel name '{name}' collides with an existing channel after normalization ('{needle}')"),
            "candidates": format_candidates(&collisions),
            "hint": "channel names must be unique modulo case and separators — pick a distinct name",
        })
        .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta_event(d: &str, name: &str, archived: bool) -> serde_json::Value {
        let mut tags = vec![
            serde_json::json!(["d", d]),
            serde_json::json!(["name", name]),
        ];
        if archived {
            tags.push(serde_json::json!(["archived", "true"]));
        }
        serde_json::json!({ "kind": 39000, "tags": tags })
    }

    #[test]
    fn slug_normalization_folds_case_and_separators() {
        assert_eq!(normalize_channel_slug("Platform Team"), "platform-team");
        assert_eq!(normalize_channel_slug("#platform-team"), "platform-team");
        assert_eq!(normalize_channel_slug("platform_team"), "platform-team");
        assert_eq!(
            normalize_channel_slug("  PLATFORM   team  "),
            "platform-team"
        );
        assert_eq!(
            normalize_channel_slug("Platform!! Team---"),
            "platform-team"
        );
        assert_eq!(normalize_channel_slug("DM"), "dm");
    }

    #[test]
    fn slug_normalization_degenerates_to_empty() {
        assert_eq!(normalize_channel_slug("###"), "");
        assert_eq!(normalize_channel_slug(" - _ "), "");
    }

    #[test]
    fn candidates_skip_events_missing_required_tags() {
        let events = vec![
            meta_event("id-1", "Platform Team", false),
            serde_json::json!({ "kind": 39000, "tags": [["d", "id-2"]] }), // no name
            serde_json::json!({ "kind": 39000, "tags": [["name", "NoId"]] }), // no d
        ];
        let candidates = channel_candidates(&events);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].channel_id, "id-1");
    }

    #[test]
    fn exact_slug_match_distinguishes_prefixes() {
        // "platform" must NOT match "platform team" — substring matching is
        // the ambiguity trap this module exists to avoid.
        let candidates = channel_candidates(&[
            meta_event("id-1", "Platform Team", false),
            meta_event("id-2", "Platform", false),
        ]);
        let matches = match_slug(&candidates, "platform");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].channel_id, "id-2");
    }

    #[test]
    fn match_slug_accepts_all_handle_spellings() {
        let candidates = channel_candidates(&[meta_event("id-1", "Platform Team", false)]);
        for handle in [
            "Platform Team",
            "#platform-team",
            "platform_team",
            "PLATFORM  TEAM",
        ] {
            assert_eq!(
                match_slug(&candidates, &normalize_channel_slug(handle)).len(),
                1,
                "handle '{handle}' failed to resolve"
            );
        }
    }

    #[test]
    fn archived_channels_do_not_match() {
        let candidates = channel_candidates(&[
            meta_event("id-1", "Platform Team", true),
            meta_event("id-2", "Platform Team", false),
        ]);
        let matches = match_slug(&candidates, "platform-team");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].channel_id, "id-2");
    }

    #[test]
    fn duplicate_names_yield_two_matches_for_ambiguity_errors() {
        // The five-channels-named-DM reality: both survive projection so the
        // resolver can refuse with the full candidate list.
        let candidates = channel_candidates(&[
            meta_event("id-1", "DM", false),
            meta_event("id-2", "dm", false),
        ]);
        let matches = match_slug(&candidates, "dm");
        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn zero_matches_is_empty_not_error() {
        let candidates = channel_candidates(&[meta_event("id-1", "Platform Team", false)]);
        assert!(match_slug(&candidates, "devices").is_empty());
    }
}
