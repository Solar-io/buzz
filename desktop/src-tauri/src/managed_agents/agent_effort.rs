//! Display-only effort/context knobs published on kind:30177.
//!
//! # Security: named, validated tokens only
//!
//! kind:30177 is world-readable and its projection is an opt-IN allowlist
//! (see `agent_events`). This module never publishes `env_vars` wholesale: it
//! reads a fixed set of NAMED keys and publishes a value only when it is a
//! short lowercase token (`^[a-z]{1,16}$`) or, for the context size, a
//! positive decimal integer. Anything else is dropped, never published.
//!
//! The wire contract is shared with the web reader
//! (`web/src/features/agents/lib/agentRegistry.ts` `parseAgentEffort`) through
//! `test-fixtures/agent-effort/cases.json`. The trim rule is declared here
//! explicitly (ASCII space/tab/CR/LF only) rather than relying on `str::trim`,
//! whose character set differs from `String.prototype.trim`; the web side does
//! not trim at all and re-validates the published token with the same regex.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{env_vars::merged_user_env, spawn_snapshot, ManagedAgentRecord};

/// Text-turn effort env key. Mirrors `buzz_acp::voice_turn::ENV_TEXT_EFFORT`
/// (desktop does not depend on buzz-acp — keep the two in step).
pub(crate) const TEXT_TURN_EFFORT_ENV: &str = "BUZZ_TEXT_TURN_EFFORT";
/// Voice-turn effort env key. Mirrors `buzz_acp::voice_turn::ENV_EFFORT`.
pub(crate) const VOICE_TURN_EFFORT_ENV: &str = "BUZZ_VOICE_TURN_EFFORT";
/// Thinking effort env key read by the buzz-agent harness.
pub(crate) const THINKING_EFFORT_ENV: &str = "BUZZ_AGENT_THINKING_EFFORT";
/// Claude Code's own effort env key.
pub(crate) const CLAUDE_CODE_EFFORT_ENV: &str = "CLAUDE_CODE_EFFORT_LEVEL";
/// Max context window env key read by the buzz-agent harness.
pub(crate) const MAX_CONTEXT_TOKENS_ENV: &str = "BUZZ_AGENT_MAX_CONTEXT_TOKENS";

/// Largest context size published — `Number.MAX_SAFE_INTEGER`, so the web
/// reader (`Number.isSafeInteger`) accepts every value Rust publishes.
const MAX_PUBLISHED_CONTEXT_TOKENS: u64 = 9_007_199_254_740_991;

/// Display-only effort/context knobs published on kind:30177. Named fields
/// only — never `env_vars` wholesale. Values are validated tokens; anything
/// else is dropped, never published.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AgentEffortConfig {
    /// Startup ACP effort: `effort_level` wins over the env key
    /// [`super::claude_config::EFFORT_LEVEL_ENV_VAR`]
    /// (`spawn_snapshot::effective_effort`, the precedence spawn applies).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp: Option<String>,
    /// `BUZZ_TEXT_TURN_EFFORT`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_turn: Option<String>,
    /// `BUZZ_VOICE_TURN_EFFORT`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_turn: Option<String>,
    /// `BUZZ_AGENT_THINKING_EFFORT`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// `CLAUDE_CODE_EFFORT_LEVEL`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_code: Option<String>,
    /// `BUZZ_AGENT_MAX_CONTEXT_TOKENS`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<u64>,
}

impl AgentEffortConfig {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// Trim ASCII space/tab/CR/LF only — declared explicitly (see module docs).
fn trim_ascii_ws(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n'))
}

/// Publish a token only when it matches `^[a-z]{1,16}$` after the declared
/// trim; `unset` means "no value" (the harness reads it the same way).
fn effort_token(value: Option<&String>) -> Option<String> {
    let token = trim_ascii_ws(value?);
    let valid = (1..=16).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_lowercase());
    (valid && token != "unset").then(|| token.to_string())
}

/// Accept `^[0-9]{1,16}$` after the declared trim, > 0 and ≤ 2^53-1.
fn context_tokens(value: Option<&String>) -> Option<u64> {
    let digits = trim_ascii_ws(value?);
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && *n <= MAX_PUBLISHED_CONTEXT_TOKENS)
}

/// Resolve the published effort block for `record`: the definition env with
/// the agent env layered over it (the same merge spawn uses), then the named
/// keys validated. `None` when nothing is set.
pub(crate) fn resolve_agent_effort(
    record: &ManagedAgentRecord,
    definition_env: &BTreeMap<String, String>,
) -> Option<AgentEffortConfig> {
    let env = merged_user_env(definition_env, &record.env_vars);
    let acp = spawn_snapshot::effective_effort(record, &env);
    let config = AgentEffortConfig {
        acp: effort_token(acp.as_ref()),
        text_turn: effort_token(env.get(TEXT_TURN_EFFORT_ENV)),
        voice_turn: effort_token(env.get(VOICE_TURN_EFFORT_ENV)),
        thinking: effort_token(env.get(THINKING_EFFORT_ENV)),
        claude_code: effort_token(env.get(CLAUDE_CODE_EFFORT_ENV)),
        max_context_tokens: context_tokens(env.get(MAX_CONTEXT_TOKENS_ENV)),
    };
    (!config.is_empty()).then_some(config)
}

/// The live env of `record`'s linked definition within the unified store
/// (definitions are the key-less rows). Empty for standalone agents and for
/// links to a definition that no longer exists.
pub(crate) fn definition_env_for(
    record: &ManagedAgentRecord,
    store: &[ManagedAgentRecord],
) -> BTreeMap<String, String> {
    let Some(persona_id) = record.persona_id.as_deref() else {
        return BTreeMap::new();
    };
    store
        .iter()
        .filter(|row| row.pubkey.is_empty())
        .filter_map(ManagedAgentRecord::to_definition_view)
        .find(|definition| definition.id == persona_id)
        .map(|definition| definition.env_vars)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
