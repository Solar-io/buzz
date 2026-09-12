//! Voice-turn routing: per-turn inference overrides for voice-shaped turns.
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
//! Knobs (read from the harness process environment, so they are per-worker
//! config rather than compiled constants):
//!
//! - `BUZZ_VOICE_TURN_EFFORT` = `low` | `medium` | `high` | `xhigh` | `max`
//!   | `default` — the effort the marked turn runs at, overriding whatever
//!   the session's config had. This is the adapter's own `thought_level`
//!   vocabulary (`supportedEffortLevels` in the SDK model catalog); `default`
//!   resolves to the model's default effort. `unset` (or unset/blank) means
//!   no override, which is the default: unmarked AND marked turns behave
//!   exactly as before.
//! - `BUZZ_VOICE_TURN_MODEL` = `<model-id>` — optional per-turn engine swap.
//!   Unset/blank/`unset` means never override (the default); a configured id
//!   that the agent's catalog does not list is ignored for that turn.
//!
//! The overriding itself lives in `pool` (`apply_voice_turn_overrides` /
//! `restore_voice_turn_overrides`); everything here is the deterministic,
//! side-effect-free half — detection and env resolution — so it can be
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

/// Env var selecting the optional per-turn model for marked turns.
pub const ENV_MODEL: &str = "BUZZ_VOICE_TURN_MODEL";

/// True when `content` BEGINS with a voice-turn marker.
///
/// Prefix-only by design: a message that merely mentions "[voice]" mid-text
/// is not a voice turn, and conversation-context lines quoting an older
/// marked message must not mark the turn that quoted them.
pub fn is_voice_turn_content(content: &str) -> bool {
    content.starts_with(VIDEO_TURN_MARKER) || content.starts_with(VOICE_TURN_MARKER)
}

/// Outcome of resolving `BUZZ_VOICE_TURN_EFFORT`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffortOverride {
    /// No override — env unset, blank, or explicitly `unset`.
    Unset,
    /// Override the turn's `thought_level` option to this exact value.
    Apply(String),
    /// Env present but not a recognized value. The caller warns and proceeds
    /// at normal config; a typo'd knob must never degrade an unmarked turn.
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

/// Resolve the effort override from an env value.
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
/// default per the spec.
pub fn resolve_model_override(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("unset"))
        .map(str::to_string)
}

/// The per-turn overrides in force for one turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VoiceTurnOverrides {
    /// Effort to apply to the turn's `thought_level` option, if any.
    pub effort: Option<String>,
    /// Model to switch the session to for the turn, if any.
    pub model: Option<String>,
}

impl VoiceTurnOverrides {
    /// True when applying these overrides would issue no ACP RPC at all.
    pub fn is_noop(&self) -> bool {
        self.effort.is_none() && self.model.is_none()
    }

    /// Pure resolution for one turn: overrides only when the turn's
    /// triggering content carries a voice marker AND an env knob resolves.
    ///
    /// `content` is the LAST batch event's content (the event the turn
    /// answers — the same event `format_prompt` derives the turn's scope
    /// from); `effort_env`/`model_env` are the raw env values, injected so
    /// tests never mutate process state.
    pub fn for_turn(
        content: Option<&str>,
        effort_env: Option<&str>,
        model_env: Option<&str>,
    ) -> Self {
        let marked = content.is_some_and(is_voice_turn_content);
        if !marked {
            // The gate is the marker, not the env: a configured knob with no
            // marked turn in flight resolves to the no-op default, so the
            // unmarked path is byte-identical to the pre-routing behavior.
            return Self::default();
        }
        if let EffortOverride::Invalid(raw) = resolve_effort_override(effort_env) {
            tracing::warn!(
                target: "pool::voice",
                env = ENV_EFFORT,
                value = %raw,
                "invalid {ENV_EFFORT} value — voice turn proceeds at normal effort",
            );
        }
        Self {
            effort: resolve_effort_override(effort_env).into_option(),
            model: resolve_model_override(model_env),
        }
    }

    /// [`Self::for_turn`] with the values read from the process environment.
    /// The single impure seam — pool calls this once per turn.
    pub fn from_env_for_turn(content: Option<&str>) -> Self {
        let effort_env = std::env::var(ENV_EFFORT).ok();
        let model_env = std::env::var(ENV_MODEL).ok();
        Self::for_turn(content, effort_env.as_deref(), model_env.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_voice_turn_content, resolve_effort_override, resolve_model_override, EffortOverride,
        VoiceTurnOverrides, VIDEO_TURN_MARKER, VOICE_TURN_MARKER,
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

    #[test]
    fn unmarked_turn_resolves_to_noop_even_with_env_set() {
        // THE requirement: no marker → no override, whatever the knobs say.
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
}
