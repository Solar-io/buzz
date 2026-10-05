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
//! Per-agent config file (a richer layer OVER all three env knobs):
//! `~/.buzz/agent-effort.json` (path overridable via `BUZZ_AGENT_EFFORT_CONFIG`):
//!
//! ```json
//! {
//!   "*":    { "text": "max", "voice": "low", "voiceModel": "unset" },
//!   "Evie": { "text": "medium", "voiceModel": "model-id" }
//! }
//! ```
//!
//! Agent keys are the sidecar's own lowercase pubkey hex (stable across
//! renames), or its display name (`BUZZ_ACP_DISPLAY_NAME`, matched
//! case-insensitively for backwards compatibility). Precedence for each of
//! `text`, `voice`, and `voiceModel` independently: exact lowercase pubkey
//! entry > name entry > `*` > env var > unset. A missing key falls through
//! to the next tier; explicit `unset` or blank masks all lower tiers.
//! `voiceModel` applies only to marked turns and keeps the existing catalog
//! validation and post-turn model restoration. `voiceStream` (`on`/`off`,
//! env fallback `BUZZ_VOICE_STREAM`, default off) switches streamed spoken
//! replies for `[voice]` turns — see [`crate::voice_stream`]; it follows the
//! same pubkey > name > `*` > env precedence. The file is read fresh at
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

/// Env var switching streamed voice replies (`on` | `off`) when the config
/// file does not decide it. Default off. See [`crate::voice_stream`].
pub const ENV_VOICE_STREAM: &str = "BUZZ_VOICE_STREAM";

/// Config-file key for the streamed-voice-reply switch.
pub const VOICE_STREAM_KEY: &str = "voiceStream";

/// Env var carrying the sidecar's own display name — the legacy agent key
/// the effort config file matches against. Present on every sidecar process.
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

/// Resolve the model override from a file or env value.
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
    /// Model for marked turns (`voiceModel` in the config file).
    pub voice_model: Option<String>,
    /// Streamed voice replies switch (`voiceStream` in the config file).
    pub voice_stream: Option<String>,
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
/// apply to ONE agent: its exact lowercase pubkey, its case-insensitive
/// display name, and the `*` wildcard.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentEffortFile {
    /// The `*` wildcard entry — applies to every agent.
    pub wildcard: EffortFileEntry,
    /// The matching per-agent entry, when the file has one.
    pub agent: EffortFileEntry,
    /// The matching lowercase pubkey entry, independent of display name.
    pub pubkey: EffortFileEntry,
}

impl AgentEffortFile {
    /// The raw value for `class`: pubkey > name > wildcard > absent.
    pub fn class_value(&self, class: EffortClass) -> Option<&str> {
        self.pubkey
            .class_value(class)
            .or_else(|| self.agent.class_value(class))
            .or_else(|| self.wildcard.class_value(class))
    }

    /// The raw marked-turn model: pubkey > name > wildcard > absent.
    pub fn voice_model_value(&self) -> Option<&str> {
        self.pubkey
            .voice_model
            .as_deref()
            .or(self.agent.voice_model.as_deref())
            .or(self.wildcard.voice_model.as_deref())
    }

    /// The raw `voiceStream` switch: pubkey > name > wildcard > absent.
    pub fn voice_stream_value(&self) -> Option<&str> {
        self.pubkey
            .voice_stream
            .as_deref()
            .or(self.agent.voice_stream.as_deref())
            .or(self.wildcard.voice_stream.as_deref())
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

/// Parse the config file, narrowed to the agent's identity and display name.
///
/// Pubkeys match exact lowercase 64-character hex; legacy name keys match
/// case-insensitively against `agent_name`; `*` is the wildcard. Per-entry failure is
/// fail-soft: an entry whose value is not an object is ignored with a warn
/// and the rest of the file still applies. File-level failure (invalid JSON,
/// non-object root) is an `Err` — the caller treats the whole file as
/// absent.
pub fn parse_agent_effort_file(
    raw: &str,
    agent_name: Option<&str>,
    agent_pubkey: Option<&str>,
) -> Result<AgentEffortFile, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid JSON: {e}"))?;
    let root = parsed
        .as_object()
        .ok_or_else(|| "content is valid JSON but not an object".to_string())?;
    let mut file = AgentEffortFile::default();
    let agent_pubkey = agent_pubkey.filter(|pk| {
        pk.len() == 64
            && pk
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
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
            // A malformed model value masks lower tiers rather than turning
            // arbitrary JSON into an adapter-defined model id.
            voice_model: entry_obj.get("voiceModel").map(|value| {
                if let Some(model) = value.as_str() {
                    model.to_string()
                } else {
                    tracing::warn!(target: "pool::voice", "invalid voiceModel type — ignoring override");
                    String::new()
                }
            }),
            // Present-but-non-string is serialized as-is so it fails the
            // on/off check loudly (warn, stay off) instead of falling through.
            voice_stream: class_value_from(entry_obj, VOICE_STREAM_KEY),
        };
        if key == WILDCARD_KEY {
            file.wildcard = entry;
        } else if agent_pubkey.is_some_and(|pk| key == pk) {
            file.pubkey = entry;
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
    /// `BUZZ_ACP_DISPLAY_NAME` — the config file's legacy name key.
    pub agent_name: Option<&'a str>,
    /// The harness's own lowercase public key hex — stable across renames.
    pub agent_pubkey: Option<&'a str>,
    /// Raw config-file content; `None` = file absent (or unusable).
    pub file_content: Option<&'a str>,
}

/// Resolve one knob across its tiers: config file (pubkey > name > wildcard,
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
            match parse_agent_effort_file(raw, knobs.agent_name, knobs.agent_pubkey) {
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
                model: resolve_model_override(
                    file.as_ref()
                        .and_then(AgentEffortFile::voice_model_value)
                        .or(knobs.model_env),
                ),
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
    /// this once per turn, passing its own public key (never the sender's).
    pub fn from_env_for_turn(content: Option<&str>, agent_pubkey: Option<&str>) -> Self {
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
                agent_pubkey,
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

/// Outcome of resolving the streamed-voice-reply switch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceStreamSwitch {
    /// `on` — `[voice]` turns stream their reply.
    On,
    /// `off`, `unset`, blank, or absent at every tier — today's behaviour.
    Off,
    /// Present but not `on`/`off`. Treated as off with a warning: a typo
    /// must never turn streaming on.
    Invalid(String),
}

impl VoiceStreamSwitch {
    /// True only for an explicit `on`.
    pub fn is_on(&self) -> bool {
        matches!(self, VoiceStreamSwitch::On)
    }
}

/// Resolve one raw `voiceStream` / `BUZZ_VOICE_STREAM` value.
pub fn resolve_voice_stream_value(value: Option<&str>) -> VoiceStreamSwitch {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return VoiceStreamSwitch::Off;
    };
    if value.eq_ignore_ascii_case("on") {
        VoiceStreamSwitch::On
    } else if value.eq_ignore_ascii_case("off") || value.eq_ignore_ascii_case("unset") {
        VoiceStreamSwitch::Off
    } else {
        VoiceStreamSwitch::Invalid(value.to_string())
    }
}

/// The injected sources for the streamed-voice-reply switch (pure seam).
#[derive(Debug, Clone, Default)]
pub struct VoiceStreamKnobs<'a> {
    /// `BUZZ_VOICE_STREAM`.
    pub env: Option<&'a str>,
    /// `BUZZ_ACP_DISPLAY_NAME` — the config file's legacy name key.
    pub agent_name: Option<&'a str>,
    /// The harness's own lowercase public key hex.
    pub agent_pubkey: Option<&'a str>,
    /// Raw config-file content; `None` = file absent (or unusable).
    pub file_content: Option<&'a str>,
}

/// Resolve the streamed-voice-reply switch with the same precedence as the
/// effort knobs: pubkey > name > `*` > `BUZZ_VOICE_STREAM` > off. A file
/// value that is present (including `off`/blank) decides and masks the env.
pub fn resolve_voice_stream(knobs: &VoiceStreamKnobs) -> VoiceStreamSwitch {
    let file = knobs
        .file_content
        .and_then(|raw| parse_agent_effort_file(raw, knobs.agent_name, knobs.agent_pubkey).ok());
    let resolved = match file.as_ref().and_then(AgentEffortFile::voice_stream_value) {
        Some(raw) => resolve_voice_stream_value(Some(raw)),
        None => resolve_voice_stream_value(knobs.env),
    };
    if let VoiceStreamSwitch::Invalid(raw) = &resolved {
        tracing::warn!(
            target: "buzz_acp::voice_stream",
            value = %raw,
            "invalid voiceStream value (expected on/off) — streaming stays off"
        );
    }
    resolved
}

/// [`resolve_voice_stream`] over the process environment and the config
/// file, read fresh so a flip lands on the next turn without a restart.
pub fn voice_stream_from_env(agent_pubkey: Option<&str>) -> VoiceStreamSwitch {
    let env = std::env::var(ENV_VOICE_STREAM).ok();
    let agent_name = std::env::var(ENV_AGENT_NAME).ok();
    let file_content = read_agent_effort_file();
    resolve_voice_stream(&VoiceStreamKnobs {
        env: env.as_deref(),
        agent_name: agent_name.as_deref(),
        agent_pubkey,
        file_content: file_content.as_deref(),
    })
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
#[path = "voice_turn_tests.rs"]
mod tests;
