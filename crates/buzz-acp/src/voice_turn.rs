//! Turn-class routing: per-turn inference overrides for voice-shaped and
//! plain-text turns.
//!
//! A turn whose triggering content arrives prefixed `[video] ` (the desktop
//! video-chat bridge, `desktop/src-tauri/src/video_chat/turn.rs`) or
//! `[voice] ` (the web huddle voice mode) is a spoken turn: the person is
//! waiting on first audio, so paying full-effort thinking on every one is
//! latency the conversation cannot afford (spec:
//! `~/.buzz/PLANS/EVIE_VOICE_TURN_ROUTING_2026-09-12.md`). For marked turns
//! the pool may apply per-turn `thought_level` (reasoning effort) and —
//! behind a second, default-disabled knob — model overrides on the live
//! session, restoring the session's pre-turn config afterwards.
//!
//! The complementary TEXT knob (`BUZZ_TEXT_TURN_EFFORT`) does the same for
//! UNMARKED turns: typed messages and heartbeats are the other half of the
//! partition, and an operator who wants everyday turns at a different effort
//! than the model default sets it there. The two knobs never mix — a marked
//! turn consults only the voice sources, an unmarked turn only the text
//! sources — so a turn's desired effort is always exactly one knob's value.
//!
//! Knobs (read from the harness process environment, so they are per-worker
//! config rather than compiled constants):
//!
//! - `BUZZ_VOICE_TURN_EFFORT` = `low` | `medium` | `high` | `xhigh` | `max`
//!   | `default` — the effort a MARKED turn runs at, overriding whatever the
//!   session's config had. This is the adapter's own `thought_level`
//!   vocabulary (`supportedEffortLevels` in the SDK model catalog); `default`
//!   resolves to the model's default effort. `unset` (or unset/blank) means
//!   no override, which is the default: marked turns behave exactly as
//!   before.
//! - `BUZZ_TEXT_TURN_EFFORT` = same vocabulary — the effort an UNMARKED turn
//!   runs at. Unset/blank/`unset` means no override: unmarked turns run at
//!   the session config, byte-identical to the pre-routing behavior.
//! - `BUZZ_VOICE_TURN_MODEL` = `<model-id>` — optional per-turn engine swap
//!   for MARKED turns. Unset/blank/`unset` means never override (the
//!   default); a configured id that the agent's catalog does not list is
//!   ignored for that turn. There is deliberately no text model knob.
//!
//! Per-agent config file (a richer layer OVER both env knobs):
//! `~/.buzz/agent-effort.json` (path overridable via `BUZZ_AGENT_EFFORT_CONFIG`):
//!
//! ```json
//! {
//!   "*":    { "text": "max", "voice": "low" },
//!   "Evie": { "text": "medium" }
//! }
//! ```
//!
//! The agent key is the sidecar's own display name (`BUZZ_ACP_DISPLAY_NAME`),
//! matched case-insensitively; an explicit per-agent entry beats the `*`
//! wildcard, and a missing class key inside an entry falls through to the
//! next tier. Precedence per knob, voice and text independently: per-agent
//! file entry > `*` file entry > env var > unset. The file is read fresh at
//! each turn resolution so edits land on the next turn without a restart; a
//! missing, invalid-JSON, or non-object file behaves as absent (fail-soft).
//! A class value that is present but not in the vocabulary is `Invalid` —
//! warn and proceed at normal config, exactly like an invalid env value; it
//! does NOT silently fall through to the tier below it.
//!
//! The overriding itself lives in `pool` (`apply_voice_turn_overrides` /
//! `restore_voice_turn_overrides`); everything here is the deterministic,
//! side-effect-free half — detection and layered resolution — so it can be
//! unit-tested without a process or a session.
//!
//! Fallback posture (the spec's "retry once at normal config" is NOT built,
//! deliberately): the turn pipeline has no single-shot retry point. The
//! agent publishes its reply itself, mid-turn, through its send tool — so a
//! prompt re-run is a SECOND published reply in the channel, not a retry —
//! and `session_prompt_blocks_with_idle_timeout` resolves only at turn end,
//! with no first-output timestamp to gate a "took too long" decision on.
//! What IS in place, and covers the practical failure modes: an override
//! that fails or times out to apply is a warn-and-proceed at normal config
//! (the turn runs at the config it would have had before this feature), and
//! a failed turn goes through the queue's ordinary requeue/backoff path. A
//! mark-aware retry would need queue-level plumbing plus reply dedup — a
//! fragile build for the failure it guards, so per the spec's own risk
//! note it is left out until a real call shows it is needed.

/// Prefix the desktop video-chat bridge puts on relayed spoken turns.
pub const VIDEO_TURN_MARKER: &str = "[video] ";

/// Prefix the web huddle voice mode puts on published finals.
pub const VOICE_TURN_MARKER: &str = "[voice] ";

/// Env var selecting the per-turn reasoning effort for marked turns.
pub const ENV_EFFORT: &str = "BUZZ_VOICE_TURN_EFFORT";

/// Env var selecting the per-turn reasoning effort for unmarked (text)
/// turns.
pub const ENV_TEXT_EFFORT: &str = "BUZZ_TEXT_TURN_EFFORT";

/// Env var selecting the optional per-turn model for marked turns.
pub const ENV_MODEL: &str = "BUZZ_VOICE_TURN_MODEL";

/// Env var carrying the sidecar's own display name — the per-agent key the
/// effort config file matches against. Present on every sidecar process.
pub const ENV_AGENT_NAME: &str = "BUZZ_ACP_DISPLAY_NAME";

/// Env var overriding the per-agent effort config file path (test seam).
pub const ENV_CONFIG_PATH: &str = "BUZZ_AGENT_EFFORT_CONFIG";

/// The wildcard agent key in the effort config file: matches every agent.
pub const WILDCARD_KEY: &str = "*";

/// The effort config file's default location, relative to `$HOME`.
pub const DEFAULT_CONFIG_RELATIVE: &str = ".buzz/agent-effort.json";

/// The default effort config file path: `$HOME/.buzz/agent-effort.json`.
///
/// `None` when `home` is missing or blank — the file layer is simply absent
/// then, and the env knobs stand alone.
fn default_config_path(home: Option<&str>) -> Option<std::path::PathBuf> {
    let home = home.map(str::trim).filter(|h| !h.is_empty())?;
    Some(std::path::Path::new(home).join(DEFAULT_CONFIG_RELATIVE))
}

/// True when `content` BEGINS with a voice-turn marker.
///
/// Prefix-only by design: a message that merely mentions "[voice]" mid-text
/// is not a voice turn, and conversation-context lines quoting an older
/// marked message must not mark the turn that quoted them.
pub fn is_voice_turn_content(content: &str) -> bool {
    content.starts_with(VIDEO_TURN_MARKER) || content.starts_with(VOICE_TURN_MARKER)
}

/// Outcome of resolving an effort knob (`BUZZ_VOICE_TURN_EFFORT`,
/// `BUZZ_TEXT_TURN_EFFORT`, or the config file's `text`/`voice` values).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffortOverride {
    /// No override — source unset, blank, or explicitly `unset`.
    Unset,
    /// Override the turn's `thought_level` option to this exact value.
    Apply(String),
    /// Source present but not a recognized value. The caller warns and
    /// proceeds at normal config; a typo'd knob must never degrade a turn.
    Invalid(String),
}

impl EffortOverride {
    /// The value to apply, if any.
    pub fn into_option(self) -> Option<String> {
        match self {
            EffortOverride::Apply(value) => Some(value),
            EffortOverride::Unset | EffortOverride::Invalid(_) => None,
        }
    }
}

/// Which turn class a knob configures. The marker partition is total: a
/// turn is either marked (`Voice`) or not (`Text`), never both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortClass {
    /// Unmarked turns — typed messages and heartbeats.
    Text,
    /// Turns marked `[video] `/`[voice] `.
    Voice,
}

impl EffortClass {
    /// The class's key inside a config-file entry.
    pub fn key(self) -> &'static str {
        match self {
            EffortClass::Text => "text",
            EffortClass::Voice => "voice",
        }
    }

    /// The class's env knob.
    pub fn env_var(self) -> &'static str {
        match self {
            EffortClass::Text => ENV_TEXT_EFFORT,
            EffortClass::Voice => ENV_EFFORT,
        }
    }
}

/// Resolve the effort override from a raw knob value.
///
/// Recognized values are the adapter's `thought_level` vocabulary — the
/// SDK model catalog's `supportedEffortLevels`: `low`, `medium`, `high`,
/// `xhigh`, `max`, plus `default` for the model default (case-insensitive;
/// the normalized lowercase form is what reaches the wire). Anything else
/// an operator types is a typo and must invalidate rather than guess — the
/// caller warns and the turn proceeds at normal config. `unset` — and unset
/// or blank — mean no override.
pub fn resolve_effort_override(value: Option<&str>) -> EffortOverride {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return EffortOverride::Unset;
    };
    if value.eq_ignore_ascii_case("unset") {
        return EffortOverride::Unset;
    }
    let normalized = value.to_ascii_lowercase();
    match normalized.as_str() {
        "low" | "medium" | "high" | "xhigh" | "max" | "default" => {
            EffortOverride::Apply(normalized)
        }
        _ => EffortOverride::Invalid(value.to_string()),
    }
}

/// Resolve the model override from an env value.
///
/// Model ids are adapter-defined strings, so there is no local validity
/// check beyond presence: any non-blank, non-`unset` value is passed through
/// and is matched against the agent's model catalog at apply time. `None`
/// (unset/blank/`unset`) never overrides — the model swap is disabled by
/// default per the spec, and is a MARKED-turn knob only.
pub fn resolve_model_override(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("unset"))
        .map(str::to_string)
}

/// One agent's (or the wildcard's) effort knobs from the config file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffortFileEntry {
    /// Effort for unmarked turns.
    pub text: Option<String>,
    /// Effort for marked turns.
    pub voice: Option<String>,
}

impl EffortFileEntry {
    /// The raw class value, if the entry carries it. A missing class key is
    /// `None` — the caller falls through to the next precedence tier.
    pub fn class_value(&self, class: EffortClass) -> Option<&str> {
        match class {
            EffortClass::Text => self.text.as_deref(),
            EffortClass::Voice => self.voice.as_deref(),
        }
    }
}

/// The parsed per-agent effort config file, narrowed to the layers that can
/// apply to ONE agent: its own entry (case-insensitive exact match on the
/// display name) and the `*` wildcard.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentEffortFile {
    /// The `*` wildcard entry — applies to every agent.
    pub wildcard: EffortFileEntry,
    /// The matching per-agent entry, when the file has one.
    pub agent: EffortFileEntry,
}

impl AgentEffortFile {
    /// The config-file raw value for `class`: the per-agent entry when it
    /// carries the key, else the wildcard, else `None` (fall through to env).
    pub fn class_value(&self, class: EffortClass) -> Option<&str> {
        self.agent
            .class_value(class)
            .or_else(|| self.wildcard.class_value(class))
    }
}

/// Extract one class value from a config-file entry object.
///
/// A non-string value can never name a valid effort, but it is PRESENT — so
/// it is serialized as-is and fails the vocabulary check loudly (`Invalid`,
/// warn + proceed) rather than silently falling through to the next tier.
fn class_value_from(
    entry: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    entry.get(key).map(|v| match v.as_str() {
        Some(s) => s.to_string(),
        None => v.to_string(),
    })
}

/// Parse the per-agent effort config file content, narrowed to `agent_name`.
///
/// The agent key matches case-insensitively against `agent_name` (the
/// sidecar's display name); `*` is the wildcard. Per-entry failure is
/// fail-soft: an entry whose value is not an object is ignored with a warn
/// and the rest of the file still applies. File-level failure (invalid JSON,
/// non-object root) is an `Err` — the caller treats the whole file as
/// absent.
pub fn parse_agent_effort_file(
    raw: &str,
    agent_name: Option<&str>,
) -> Result<AgentEffortFile, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid JSON: {e}"))?;
    let root = parsed
        .as_object()
        .ok_or_else(|| "content is valid JSON but not an object".to_string())?;
    let mut file = AgentEffortFile::default();
    for (key, value) in root {
        let Some(entry_obj) = value.as_object() else {
            tracing::warn!(
                target: "pool::voice",
                key = %key,
                "agent-effort config: entry {key:?} is not an object — ignoring it"
            );
            continue;
        };
        let entry = EffortFileEntry {
            text: class_value_from(entry_obj, EffortClass::Text.key()),
            voice: class_value_from(entry_obj, EffortClass::Voice.key()),
        };
        if key == WILDCARD_KEY {
            file.wildcard = entry;
        } else if agent_name.is_some_and(|name| key.eq_ignore_ascii_case(name)) {
            file.agent = entry;
        }
        // Any other key is a different agent's entry — not ours to read.
    }
    Ok(file)
}

/// The layered knob sources for one turn, all injected — the pure seam lets
/// tests exercise the full precedence stack without touching process state.
#[derive(Debug, Clone, Default)]
pub struct TurnKnobs<'a> {
    /// `BUZZ_VOICE_TURN_EFFORT`.
    pub voice_env: Option<&'a str>,
    /// `BUZZ_TEXT_TURN_EFFORT`.
    pub text_env: Option<&'a str>,
    /// `BUZZ_VOICE_TURN_MODEL`.
    pub model_env: Option<&'a str>,
    /// `BUZZ_ACP_DISPLAY_NAME` — the config file's agent key.
    pub agent_name: Option<&'a str>,
    /// Raw config-file content; `None` = file absent (or unusable).
    pub file_content: Option<&'a str>,
}

/// Resolve one knob across its tiers: config file (per-agent > wildcard,
/// already narrowed by the parse) first, env second, unset last.
///
/// A present-but-invalid value poisons its tier — it yields `Invalid` (warn
/// and proceed at normal config) and does NOT fall through to the tier
/// below, mirroring how an invalid env value behaves. An explicitly
/// `unset`/blank file value is `Unset` for that class and masks the env
/// knob, because the vocabulary defines `unset` as a deliberate "no
/// override for this class".
fn layered_effort(file_value: Option<&str>, env_value: Option<&str>) -> EffortOverride {
    if let Some(raw) = file_value {
        return resolve_effort_override(Some(raw));
    }
    resolve_effort_override(env_value)
}

/// The per-turn overrides in force for one turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VoiceTurnOverrides {
    /// Effort to apply to the turn's `thought_level` option, if the turn is
    /// MARKED and the voice knob resolved.
    pub effort: Option<String>,
    /// Effort to apply when the turn is UNMARKED and the text knob resolved.
    /// Mutually exclusive with `effort` by the marker partition.
    pub text_effort: Option<String>,
    /// Model to switch the session to for the turn, if any (marked only).
    pub model: Option<String>,
}

impl VoiceTurnOverrides {
    /// True when applying these overrides would issue no ACP RPC at all.
    pub fn is_noop(&self) -> bool {
        self.effort.is_none() && self.text_effort.is_none() && self.model.is_none()
    }

    /// The single effort value this turn's class resolved, if any.
    ///
    /// Exactly one of `effort` / `text_effort` can be `Some` — the marker
    /// partition is total — so this is THE desired effort for the turn, the
    /// one value both the prompt-path apply and the steer-boundary machinery
    /// act on. `None` means the turn's class knob is unset and the session
    /// should sit at (or be restored to) its config baseline.
    pub fn effective_effort(&self) -> Option<&str> {
        self.effort.as_deref().or(self.text_effort.as_deref())
    }

    /// [`Self::resolve_for_turn`] over the env-only layer: the two env knobs
    /// the voice feature shipped with, no config file, no agent name. The
    /// production seam is [`Self::from_env_for_turn`] (which layers the
    /// config file on top), so this env-only shape now has no production
    /// caller — it is kept as the single-call, no-op-default resolution the
    /// env knobs document, and the pin for the unmarked no-op contract.
    #[allow(dead_code)]
    pub fn for_turn(
        content: Option<&str>,
        effort_env: Option<&str>,
        model_env: Option<&str>,
    ) -> Self {
        Self::resolve_for_turn(
            content,
            &TurnKnobs {
                voice_env: effort_env,
                model_env,
                ..TurnKnobs::default()
            },
        )
    }

    /// Pure resolution for one turn over the FULL layered stack.
    ///
    /// `content` is the LAST batch event's content (the event the turn
    /// answers — the same event `format_prompt` derives the turn's scope
    /// from); the knobs carry every source, injected so tests never mutate
    /// process state. The marker partition does the routing: a marked turn
    /// consults only the voice tiers (file `voice` > `BUZZ_VOICE_TURN_EFFORT`),
    /// an unmarked turn only the text tiers (file `text` >
    /// `BUZZ_TEXT_TURN_EFFORT`). The model swap stays a marked-turn knob.
    pub fn resolve_for_turn(content: Option<&str>, knobs: &TurnKnobs) -> Self {
        let marked = content.is_some_and(is_voice_turn_content);
        let class = if marked {
            EffortClass::Voice
        } else {
            EffortClass::Text
        };
        let file = knobs.file_content.and_then(|raw| {
            match parse_agent_effort_file(raw, knobs.agent_name) {
                Ok(file) => Some(file),
                Err(reason) => {
                    tracing::warn!(
                        target: "pool::voice",
                        reason = %reason,
                        "agent-effort config unusable — treating the file as absent"
                    );
                    None
                }
            }
        });
        let file_value = file.as_ref().and_then(|f| f.class_value(class));
        let env_value = knobs.class_env(class);
        let resolved = layered_effort(file_value, env_value);
        if let EffortOverride::Invalid(raw) = &resolved {
            tracing::warn!(
                target: "pool::voice",
                env = class.env_var(),
                value = %raw,
                "invalid effort value for a {} turn — proceeding at normal effort",
                class.key()
            );
        }
        let effort = resolved.into_option();
        if marked {
            Self {
                effort,
                text_effort: None,
                model: resolve_model_override(knobs.model_env),
            }
        } else {
            Self {
                effort: None,
                text_effort: effort,
                model: None,
            }
        }
    }

    /// [`Self::resolve_for_turn`] with every source read from the process
    /// environment and the config file. The single impure seam — pool calls
    /// this once per turn.
    pub fn from_env_for_turn(content: Option<&str>) -> Self {
        let voice_env = std::env::var(ENV_EFFORT).ok();
        let text_env = std::env::var(ENV_TEXT_EFFORT).ok();
        let model_env = std::env::var(ENV_MODEL).ok();
        let agent_name = std::env::var(ENV_AGENT_NAME).ok();
        let file_content = read_agent_effort_file();
        Self::resolve_for_turn(
            content,
            &TurnKnobs {
                voice_env: voice_env.as_deref(),
                text_env: text_env.as_deref(),
                model_env: model_env.as_deref(),
                agent_name: agent_name.as_deref(),
                file_content: file_content.as_deref(),
            },
        )
    }
}

impl TurnKnobs<'_> {
    /// The raw env value for `class`.
    fn class_env(&self, class: EffortClass) -> Option<&str> {
        match class {
            EffortClass::Text => self.text_env,
            EffortClass::Voice => self.voice_env,
        }
    }
}

/// Read the per-agent effort config file, fresh — the file is tiny and every
/// turn resolving it means an edit lands on the next turn without a restart.
///
/// Path: `BUZZ_AGENT_EFFORT_CONFIG` when set non-blank, else
/// `$HOME/.buzz/agent-effort.json` (and `None` when even `HOME` is unknown).
/// Fail-soft: any problem reading is a log and `None` — the turn then
/// resolves from the env knobs alone. An explicitly configured path that
/// cannot be read is a WARN (an operator asked for a file that is not
/// usable); the default path simply not existing is the normal
/// no-config deployment and only logs at debug.
fn read_agent_effort_file() -> Option<String> {
    let explicit = std::env::var(ENV_CONFIG_PATH)
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from);
    let (path, was_explicit) = match explicit {
        Some(path) => (path, true),
        None => (
            default_config_path(std::env::var("HOME").ok().as_deref())?,
            false,
        ),
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => Some(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if was_explicit {
                tracing::warn!(
                    target: "pool::voice",
                    path = %path.display(),
                    "{ENV_CONFIG_PATH} names a file that does not exist — treating as absent"
                );
            } else {
                tracing::debug!(
                    target: "pool::voice",
                    path = %path.display(),
                    "no agent-effort config file — env knobs stand alone"
                );
            }
            None
        }
        Err(e) => {
            tracing::warn!(
                target: "pool::voice",
                path = %path.display(),
                error = %e,
                "agent-effort config unreadable — treating as absent"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        default_config_path, is_voice_turn_content, parse_agent_effort_file,
        resolve_effort_override, resolve_model_override, AgentEffortFile, EffortClass,
        EffortFileEntry, EffortOverride, TurnKnobs, VoiceTurnOverrides, VIDEO_TURN_MARKER,
        VOICE_TURN_MARKER, WILDCARD_KEY,
    };

    #[test]
    fn markers_are_pinned() {
        // The desktop bridge emits exactly this shape (mark_video_turn);
        // the web voice mode must emit the matching one.
        assert_eq!(VIDEO_TURN_MARKER, "[video] ");
        assert_eq!(VOICE_TURN_MARKER, "[voice] ");
    }

    #[test]
    fn detects_both_markers() {
        assert!(is_voice_turn_content("[video] what's the weather"));
        assert!(is_voice_turn_content("[voice] what's the weather"));
    }

    #[test]
    fn no_marker_for_plain_or_mid_text_mentions() {
        // The hard requirement: an ordinary turn is not voice-shaped, and a
        // marker that arrives mid-text does not mark the turn.
        assert!(!is_voice_turn_content("what's the weather"));
        assert!(!is_voice_turn_content("hey [voice] are you there"));
        assert!(!is_voice_turn_content("read me [video] the thing"));
    }

    #[test]
    fn marker_without_trailing_space_is_not_a_marker() {
        assert!(!is_voice_turn_content("[video]news"));
        assert!(!is_voice_turn_content("[voice]news"));
        assert!(!is_voice_turn_content("[video]"));
    }

    #[test]
    fn effort_unset_when_env_missing_blank_or_unset() {
        assert_eq!(resolve_effort_override(None), EffortOverride::Unset);
        assert_eq!(resolve_effort_override(Some("")), EffortOverride::Unset);
        assert_eq!(resolve_effort_override(Some("  ")), EffortOverride::Unset);
        assert_eq!(
            resolve_effort_override(Some("unset")),
            EffortOverride::Unset
        );
        assert_eq!(
            resolve_effort_override(Some("UNSET")),
            EffortOverride::Unset
        );
    }

    #[test]
    fn effort_applies_recognized_values_normalized() {
        // The full adapter vocabulary (SDK supportedEffortLevels + default):
        // every level Sam can name must reach the wire normalized lowercase.
        assert_eq!(
            resolve_effort_override(Some("low")),
            EffortOverride::Apply("low".into())
        );
        assert_eq!(
            resolve_effort_override(Some("medium")),
            EffortOverride::Apply("medium".into())
        );
        assert_eq!(
            resolve_effort_override(Some("high")),
            EffortOverride::Apply("high".into())
        );
        assert_eq!(
            resolve_effort_override(Some("xhigh")),
            EffortOverride::Apply("xhigh".into())
        );
        assert_eq!(
            resolve_effort_override(Some("max")),
            EffortOverride::Apply("max".into())
        );
        assert_eq!(
            resolve_effort_override(Some("default")),
            EffortOverride::Apply("default".into())
        );
        assert_eq!(
            resolve_effort_override(Some(" LOW ")),
            EffortOverride::Apply("low".into())
        );
        assert_eq!(
            resolve_effort_override(Some("Max")),
            EffortOverride::Apply("max".into())
        );
    }

    #[test]
    fn effort_rejects_unrecognized_values() {
        // Values the adapter cannot honor (the SDK catalog has no "off" or
        // "minimal" effort) must invalidate rather than silently no-op — a
        // knob that looks set but does nothing is worse than a loud warning.
        assert_eq!(
            resolve_effort_override(Some("off")),
            EffortOverride::Invalid("off".into())
        );
        assert_eq!(
            resolve_effort_override(Some("minimal")),
            EffortOverride::Invalid("minimal".into())
        );
        assert_eq!(
            resolve_effort_override(Some("loww")),
            EffortOverride::Invalid("loww".into())
        );
        assert_eq!(
            resolve_effort_override(Some("maximum")),
            EffortOverride::Invalid("maximum".into())
        );
    }

    #[test]
    fn model_override_off_by_default_and_passthrough_when_set() {
        assert_eq!(resolve_model_override(None), None);
        assert_eq!(resolve_model_override(Some("")), None);
        assert_eq!(resolve_model_override(Some("unset")), None);
        assert_eq!(
            resolve_model_override(Some(" deepseek-v4-flash ")),
            Some("deepseek-v4-flash".to_string())
        );
    }

    // ---------------------------------------------------------------------
    // Text-turn knob + layered config file
    // ---------------------------------------------------------------------

    /// Shorthand: resolve with only the text env knob set.
    fn text_only(content: &str, text_env: Option<&str>) -> VoiceTurnOverrides {
        VoiceTurnOverrides::resolve_for_turn(
            Some(content),
            &TurnKnobs {
                text_env,
                ..TurnKnobs::default()
            },
        )
    }

    #[test]
    fn text_knob_resolves_on_unmarked_turn() {
        let overrides = text_only("ordinary typed message", Some("max"));
        assert_eq!(overrides.text_effort.as_deref(), Some("max"));
        assert_eq!(overrides.effort, None, "the voice knob stays untouched");
        assert_eq!(overrides.model, None, "no text model knob exists");
        assert!(!overrides.is_noop());
    }

    #[test]
    fn text_knob_unset_on_unmarked_turn_is_noop() {
        // THE byte-identical requirement for the default deployment: no
        // knobs, no file → the unmarked path resolves to the no-op default.
        let overrides = text_only("ordinary typed message", None);
        assert!(overrides.is_noop());
        assert_eq!(overrides, VoiceTurnOverrides::default());
    }

    #[test]
    fn text_knob_invalid_value_is_noop_on_effort() {
        let overrides = text_only("ordinary typed message", Some("banana"));
        assert_eq!(overrides.text_effort, None, "Invalid → warn + proceed");
        assert!(overrides.is_noop());
    }

    #[test]
    fn text_knob_on_marked_turn_is_ignored() {
        // Partition, env tier: a marked turn never consults the text knob.
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("[voice] what's the weather"),
            &TurnKnobs {
                text_env: Some("max"),
                ..TurnKnobs::default()
            },
        );
        assert!(overrides.is_noop());
        assert_eq!(overrides.text_effort, None);
    }

    #[test]
    fn voice_knob_on_unmarked_turn_is_ignored() {
        // Partition, the other half: an unmarked turn never consults the
        // voice knob (this is the env-only shape `for_turn` pins too).
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("ordinary typed message"),
            &TurnKnobs {
                voice_env: Some("low"),
                ..TurnKnobs::default()
            },
        );
        assert!(overrides.is_noop());
        assert_eq!(overrides.effort, None);
    }

    #[test]
    fn unmarked_turn_resolves_to_noop_even_with_env_set() {
        // THE original requirement, env-only shape: no marker → no voice
        // override, whatever the voice knobs say.
        let overrides = VoiceTurnOverrides::for_turn(
            Some("ordinary typed message"),
            Some("low"),
            Some("deepseek-v4-flash"),
        );
        assert!(overrides.is_noop());
        assert_eq!(overrides, VoiceTurnOverrides::default());
    }

    #[test]
    fn missing_content_is_never_a_voice_turn() {
        let overrides = VoiceTurnOverrides::for_turn(None, Some("low"), None);
        assert!(overrides.is_noop());
    }

    #[test]
    fn marked_turn_resolves_env_knobs() {
        let overrides = VoiceTurnOverrides::for_turn(
            Some("[voice] what's the weather"),
            Some("low"),
            Some("deepseek-v4-flash"),
        );
        assert_eq!(overrides.effort.as_deref(), Some("low"));
        assert_eq!(overrides.text_effort, None);
        assert_eq!(overrides.model.as_deref(), Some("deepseek-v4-flash"));
    }

    #[test]
    fn marked_turn_with_no_env_stays_noop() {
        // Marked but both knobs unset (the DEFAULT deployment): the turn
        // runs at normal config, identically to today.
        let overrides = VoiceTurnOverrides::for_turn(Some("[video] hello"), None, None);
        assert!(overrides.is_noop());
    }

    #[test]
    fn marked_turn_with_invalid_effort_is_noop_on_effort() {
        let overrides = VoiceTurnOverrides::for_turn(Some("[voice] hi"), Some("loww"), None);
        assert_eq!(overrides.effort, None);
    }

    // ----- config file parsing -----

    const FILE_BOTH: &str = r#"{
        "*":    { "text": "max", "voice": "low" },
        "Evie": { "text": "medium" }
    }"#;

    fn knobs_with_file<'a>(
        file: &'a str,
        agent: Option<&'a str>,
        text_env: Option<&'a str>,
        voice_env: Option<&'a str>,
    ) -> TurnKnobs<'a> {
        TurnKnobs {
            voice_env,
            text_env,
            agent_name: agent,
            file_content: Some(file),
            ..TurnKnobs::default()
        }
    }

    #[test]
    fn parse_narrows_to_agent_and_wildcard() {
        let file = parse_agent_effort_file(FILE_BOTH, Some("Evie")).expect("parses");
        assert_eq!(
            file.agent,
            EffortFileEntry {
                text: Some("medium".into()),
                voice: None,
            }
        );
        assert_eq!(
            file.wildcard,
            EffortFileEntry {
                text: Some("max".into()),
                voice: Some("low".into()),
            }
        );
    }

    #[test]
    fn parse_agent_key_is_case_insensitive() {
        let file = parse_agent_effort_file(FILE_BOTH, Some("eViE")).expect("parses");
        assert_eq!(
            file.agent.text.as_deref(),
            Some("medium"),
            "the per-agent entry must match regardless of case"
        );
    }

    #[test]
    fn parse_without_agent_name_reads_wildcard_only() {
        // A sidecar with no display name in its env gets exactly the
        // wildcard tiers, never someone else's entry.
        let file = parse_agent_effort_file(FILE_BOTH, None).expect("parses");
        assert_eq!(file.agent, EffortFileEntry::default());
        assert_eq!(file.wildcard.voice.as_deref(), Some("low"));
    }

    #[test]
    fn parse_ignores_other_agents_entries() {
        let file = parse_agent_effort_file(FILE_BOTH, Some("Duncan")).expect("parses");
        assert_eq!(file.agent, EffortFileEntry::default());
        assert_eq!(file.class_value(EffortClass::Text), Some("max"));
    }

    #[test]
    fn parse_rejects_invalid_json_and_non_object_root() {
        assert!(parse_agent_effort_file("not json {", Some("Evie")).is_err());
        assert!(parse_agent_effort_file("[]", Some("Evie")).is_err());
        assert!(parse_agent_effort_file("\"a string\"", Some("Evie")).is_err());
        assert!(parse_agent_effort_file("5", Some("Evie")).is_err());
    }

    #[test]
    fn parse_skips_non_object_entries() {
        // Per-entry fail-soft: a malformed entry is ignored with a warn, the
        // rest of the file still applies.
        let raw = r#"{ "Evie": "medium", "*": { "voice": "low" } }"#;
        let file = parse_agent_effort_file(raw, Some("Evie")).expect("parses");
        assert_eq!(file.agent, EffortFileEntry::default());
        assert_eq!(file.wildcard.voice.as_deref(), Some("low"));
    }

    #[test]
    fn parse_serializes_non_string_class_values_for_loud_failure() {
        // A non-string class value is PRESENT, so it must fail the
        // vocabulary check (Invalid) rather than fall through to env.
        let raw = r#"{ "*": { "text": 5 } }"#;
        let file = parse_agent_effort_file(raw, Some("Evie")).expect("parses");
        assert_eq!(file.wildcard.text.as_deref(), Some("5"));
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("plain text"),
            &TurnKnobs {
                text_env: Some("low"),
                agent_name: Some("Evie"),
                file_content: Some(raw),
                ..TurnKnobs::default()
            },
        );
        assert_eq!(
            overrides.text_effort, None,
            "invalid file value poisons its tier — no fallthrough to env"
        );
    }

    #[test]
    fn parse_ignores_unknown_keys_inside_entries() {
        let raw = r#"{ "*": { "text": "max", "model": "m-9", "bogus": true } }"#;
        let file = parse_agent_effort_file(raw, None).expect("parses");
        assert_eq!(file.wildcard.text.as_deref(), Some("max"));
        assert_eq!(file.wildcard.voice, None);
    }

    #[test]
    fn wildcard_key_is_pinned() {
        assert_eq!(WILDCARD_KEY, "*");
    }

    // ----- full precedence matrix -----

    #[test]
    fn precedence_matrix_voice_per_agent_beats_wildcard_beats_env_beats_unset() {
        let marked = Some("[voice] hello");

        // per-agent > wildcard
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            marked,
            &knobs_with_file(FILE_BOTH, Some("Evie"), None, None),
        );
        assert_eq!(
            overrides.effort.as_deref(),
            Some("low"),
            "Evie has no voice key → wildcard voice wins"
        );

        let file_agent_voice = r#"{
            "*":    { "voice": "low" },
            "Evie": { "voice": "high" }
        }"#;
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            marked,
            &knobs_with_file(file_agent_voice, Some("Evie"), None, None),
        );
        assert_eq!(
            overrides.effort.as_deref(),
            Some("high"),
            "per-agent entry must beat the wildcard"
        );

        // wildcard > env
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            marked,
            &knobs_with_file(FILE_BOTH, Some("Evie"), None, Some("xhigh")),
        );
        assert_eq!(
            overrides.effort.as_deref(),
            Some("low"),
            "wildcard file entry must beat the env knob"
        );

        // env > unset
        let overrides = VoiceTurnOverrides::for_turn(marked, Some("xhigh"), None);
        assert_eq!(overrides.effort.as_deref(), Some("xhigh"));

        // unset → no override
        let overrides = VoiceTurnOverrides::for_turn(marked, None, None);
        assert_eq!(overrides.effort, None);
    }

    #[test]
    fn precedence_matrix_text_per_agent_beats_wildcard_beats_env_beats_unset() {
        let plain = "ordinary typed message";

        // per-agent > wildcard
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some(plain),
            &knobs_with_file(FILE_BOTH, Some("Evie"), None, None),
        );
        assert_eq!(
            overrides.text_effort.as_deref(),
            Some("medium"),
            "per-agent text entry must beat the wildcard"
        );

        // wildcard > env
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some(plain),
            &knobs_with_file(FILE_BOTH, Some("Duncan"), Some("low"), None),
        );
        assert_eq!(
            overrides.text_effort.as_deref(),
            Some("max"),
            "wildcard text entry must beat the env knob"
        );

        // env > unset
        let overrides = text_only(plain, Some("low"));
        assert_eq!(overrides.text_effort.as_deref(), Some("low"));

        // unset → no override (byte-identical default)
        let overrides = text_only(plain, None);
        assert_eq!(overrides.text_effort, None);
    }

    #[test]
    fn missing_class_key_falls_through_tier_by_tier() {
        // Evie's entry has only `text`; her VOICE tier falls per-agent →
        // wildcard, while her TEXT tier stops at per-agent.
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("[voice] hello"),
            &knobs_with_file(FILE_BOTH, Some("Evie"), None, None),
        );
        assert_eq!(
            overrides.effort.as_deref(),
            Some("low"),
            "missing per-agent voice key → wildcard voice stands"
        );
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("typed message"),
            &knobs_with_file(FILE_BOTH, Some("Evie"), None, None),
        );
        assert_eq!(
            overrides.text_effort.as_deref(),
            Some("medium"),
            "present per-agent text key stops the fall-through"
        );

        // When NEITHER file tier carries the class, the env knob stands:
        // this file has no wildcard voice and Evie has no voice key.
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("[voice] hello"),
            &knobs_with_file(
                r#"{ "Evie": { "text": "medium" } }"#,
                Some("Evie"),
                None,
                Some("high"),
            ),
        );
        assert_eq!(
            overrides.effort.as_deref(),
            Some("high"),
            "class key missing at both file tiers → env knob stands"
        );

        // Duncan has no entry at all: his TEXT tier falls wildcard (absent)
        // → env.
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("typed message"),
            &knobs_with_file(
                r#"{ "Evie": { "text": "medium" } }"#,
                Some("Duncan"),
                Some("low"),
                None,
            ),
        );
        assert_eq!(
            overrides.text_effort.as_deref(),
            Some("low"),
            "no matching file entry → env knob stands"
        );
    }

    #[test]
    fn file_explicit_unset_masks_env() {
        // `unset` is part of the vocabulary: an explicit file "unset" is a
        // deliberate no-override for that class and masks the env knob.
        let raw = r#"{ "*": { "text": "unset", "voice": "" } }"#;
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("typed message"),
            &knobs_with_file(raw, None, Some("low"), None),
        );
        assert_eq!(overrides.text_effort, None);
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("[voice] hello"),
            &knobs_with_file(raw, None, None, Some("low")),
        );
        assert_eq!(overrides.effort, None);
    }

    #[test]
    fn invalid_file_value_does_not_fall_through_to_env() {
        // A present-but-invalid file value warns and proceeds at normal
        // config (same posture as an invalid env value) — it must not
        // silently degrade into the env tier, which would apply a DIFFERENT
        // config than the operator wrote.
        let raw = r#"{ "*": { "voice": "banana" } }"#;
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("[voice] hello"),
            &knobs_with_file(raw, None, None, Some("low")),
        );
        assert_eq!(overrides.effort, None);
    }

    #[test]
    fn missing_or_broken_file_falls_back_to_env() {
        // File absent: env knobs stand alone.
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("typed message"),
            &TurnKnobs {
                text_env: Some("low"),
                file_content: None,
                ..TurnKnobs::default()
            },
        );
        assert_eq!(overrides.text_effort.as_deref(), Some("low"));

        // Invalid JSON: warn + behave as absent.
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("typed message"),
            &knobs_with_file("{not json", None, Some("low"), None),
        );
        assert_eq!(overrides.text_effort.as_deref(), Some("low"));

        // Non-object root: same.
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("typed message"),
            &knobs_with_file("[1,2,3]", None, Some("low"), None),
        );
        assert_eq!(overrides.text_effort.as_deref(), Some("low"));
    }

    #[test]
    fn file_value_normalizes_like_env() {
        // Same resolver, same normalization: case and whitespace do not
        // reach the wire.
        let raw = r#"{ "*": { "text": "  MAX " } }"#;
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("typed message"),
            &knobs_with_file(raw, None, None, None),
        );
        assert_eq!(overrides.text_effort.as_deref(), Some("max"));
    }

    #[test]
    fn file_default_value_passes_through() {
        let raw = r#"{ "*": { "text": "default" } }"#;
        let overrides = VoiceTurnOverrides::resolve_for_turn(
            Some("typed message"),
            &knobs_with_file(raw, None, None, None),
        );
        assert_eq!(overrides.text_effort.as_deref(), Some("default"));
    }

    #[test]
    fn partition_holds_across_both_tiers() {
        // The full stack, both classes at once: the marked turn resolves
        // ONLY voice tiers, the unmarked turn ONLY text tiers — neither can
        // see the other's sources.
        let knobs = knobs_with_file(FILE_BOTH, Some("Evie"), Some("high"), Some("high"));
        let marked = VoiceTurnOverrides::resolve_for_turn(Some("[video] hi"), &knobs);
        assert_eq!(
            marked.effort.as_deref(),
            Some("low"),
            "marked: Evie has no voice key → wildcard voice"
        );
        assert_eq!(marked.text_effort, None, "marked turn ignores text tiers");
        assert_eq!(marked.effective_effort(), Some("low"));

        let unmarked = VoiceTurnOverrides::resolve_for_turn(Some("typed message"), &knobs);
        assert_eq!(
            unmarked.text_effort.as_deref(),
            Some("medium"),
            "unmarked: per-agent text entry"
        );
        assert_eq!(unmarked.effort, None, "unmarked turn ignores voice tiers");
        assert_eq!(unmarked.effective_effort(), Some("medium"));
    }

    #[test]
    fn effective_effort_merges_the_partition() {
        let mut overrides = VoiceTurnOverrides::default();
        assert_eq!(overrides.effective_effort(), None);
        overrides.effort = Some("low".into());
        assert_eq!(overrides.effective_effort(), Some("low"));
        overrides.effort = None;
        overrides.text_effort = Some("max".into());
        assert_eq!(overrides.effective_effort(), Some("max"));
    }

    #[test]
    fn default_config_path_joins_home_and_is_none_without_home() {
        assert_eq!(
            default_config_path(Some("/Users/sam")).as_deref(),
            Some(std::path::Path::new("/Users/sam/.buzz/agent-effort.json"))
        );
        assert_eq!(default_config_path(None), None);
        assert_eq!(default_config_path(Some("   ")), None);
    }

    #[test]
    fn agent_effort_file_default_is_empty() {
        // A default (absent-file) resolution must equal the no-file one.
        let file = AgentEffortFile::default();
        assert_eq!(file.class_value(EffortClass::Text), None);
        assert_eq!(file.class_value(EffortClass::Voice), None);
    }
}
