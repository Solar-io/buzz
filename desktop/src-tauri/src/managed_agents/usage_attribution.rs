//! Owner-editable subscription/account attribution for NIP-AM usage reporting.
//!
//! # Why this is structured configuration and not free-text env vars
//!
//! `buzz-acp` already reads `BUZZ_USAGE_PROVIDER`, `BUZZ_USAGE_ACCOUNT_ID`,
//! `BUZZ_USAGE_ACCOUNT_LABEL` and `BUZZ_USAGE_ACCOUNT_CONFIRMED` from the spawn
//! environment, and `BUZZ_USAGE_*` is not reserved — so an owner could already
//! type them onto every agent by hand. That does not scale past a handful of
//! agents and it loses the one fact the dashboard needs most: whether a label
//! is something the owner *asserted* or something their client *guessed*.
//!
//! So attribution is a structured field on the agent record
//! ([`UsageAttributionConfig`]), and the four env vars are **derived** from it
//! at spawn — the same shape as `DERIVED_PROVIDER_MODEL_ENV_KEYS`, except that
//! these keys are deliberately *not* stripped from `env_vars`: an explicit
//! per-agent entry still wins, as the module header of `env_vars` promises for
//! every knob with a dedicated UI field.
//!
//! # The honesty rule
//!
//! NIP-AM: provider/account/tier MUST NOT be inferred from a model name,
//! pricing identity, credential, subscription quota, or URL. `harness_policy`
//! says the same thing about harness ids: they "are runtime profile
//! identifiers, not capability claims".
//!
//! Seeding therefore never concludes a provider from a name. It groups agents
//! by the configuration Buzz has actually *recorded* — the runtime profile id,
//! the structured `provider` field, an explicitly-configured gateway host, and
//! which credential the readiness gate requires — and stamps every seeded row
//! `confirmed: false`. `provider` is populated **only** from the structured
//! `provider` field, because that is a value the owner entered; it is left
//! absent for a harness whose provider Buzz has never been told (e.g. a custom
//! `claude-*` profile), rather than guessed from the harness id or the model.
//!
//! Where nothing is observable — no runtime, no provider, no gateway — the
//! result is [`None`]: attribution stays absent. Never a placeholder, never a
//! zero, never a guess.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::readiness::credentials::{provider_credential_key, runtime_login_authority};

/// Non-secret provider identifier forwarded to the harness.
pub const USAGE_PROVIDER_ENV_VAR: &str = "BUZZ_USAGE_PROVIDER";
/// Stable grouping key forwarded to the harness.
pub const USAGE_ACCOUNT_ID_ENV_VAR: &str = "BUZZ_USAGE_ACCOUNT_ID";
/// Private display label forwarded to the harness.
pub const USAGE_ACCOUNT_LABEL_ENV_VAR: &str = "BUZZ_USAGE_ACCOUNT_LABEL";
/// Whether the owner confirmed this identity, forwarded to the harness.
pub const USAGE_ACCOUNT_CONFIRMED_ENV_VAR: &str = "BUZZ_USAGE_ACCOUNT_CONFIRMED";

/// Every env key this module derives. Shared with `spawn_snapshot` so the
/// restart badge has exactly one representation of attribution.
pub const USAGE_ATTRIBUTION_ENV_KEYS: &[&str] = &[
    USAGE_PROVIDER_ENV_VAR,
    USAGE_ACCOUNT_ID_ENV_VAR,
    USAGE_ACCOUNT_LABEL_ENV_VAR,
    USAGE_ACCOUNT_CONFIRMED_ENV_VAR,
];

/// Per-value byte cap. Matches the reader in `buzz-acp::usage`
/// (`telemetry_with_configured_attribution`), which silently drops anything
/// longer — so a value that passes here is a value that will actually be
/// published rather than one that vanishes at the far end.
pub const MAX_ATTRIBUTION_VALUE_BYTES: usize = 128;

/// The `__unknown__` sentinel the analytics layer uses for an absent
/// dimension. An owner-supplied value must never collide with it, or a
/// confirmed account would render as the unknown bucket.
const UNKNOWN_SENTINEL: &str = "__unknown__";

/// Owner-editable usage attribution for one agent.
///
/// All three identity fields are optional and independently absent-able. A row
/// whose identity fields are all `None` but whose `confirmed` is `true` is the
/// owner saying "this agent has no subscription identity" — a real answer, and
/// the reason seeding only ever fills an *absent* field (see
/// [`seed_absent_attribution`]).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageAttributionConfig {
    /// Provider identifier. Only ever the structured `provider` the owner
    /// configured, or a value the owner typed here — never derived from a
    /// model, harness id, credential or URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Stable grouping key. Agents sharing an `account_id` are one
    /// subscription in the dashboard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Private display label for that account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    /// `false` for anything Buzz seeded from observed configuration; `true`
    /// only once the owner has edited it. Never reset by a respawn.
    #[serde(default)]
    pub confirmed: bool,
}

impl UsageAttributionConfig {
    /// `true` when nothing would be published for this row.
    pub fn is_empty(&self) -> bool {
        self.provider.is_none() && self.account_id.is_none() && self.account_label.is_none()
    }

    /// Validate every populated field against the publisher's own limits.
    ///
    /// Rejects (rather than trims or truncates) so the value the owner
    /// reviewed is the value that gets published — the same reasoning as the
    /// definition-validation boundary, which refuses to silently strip.
    pub fn validate(&self) -> Result<(), String> {
        for (field, value) in [
            ("provider", self.provider.as_deref()),
            ("accountId", self.account_id.as_deref()),
            ("accountLabel", self.account_label.as_deref()),
        ] {
            let Some(value) = value else { continue };
            if value.trim().is_empty() {
                return Err(format!(
                    "usage attribution {field} must not be blank; clear it instead"
                ));
            }
            if value.trim() != value {
                return Err(format!(
                    "usage attribution {field} must not have leading or trailing whitespace"
                ));
            }
            if value.len() > MAX_ATTRIBUTION_VALUE_BYTES {
                return Err(format!(
                    "usage attribution {field} is {} bytes; the limit is {MAX_ATTRIBUTION_VALUE_BYTES}",
                    value.len()
                ));
            }
            if value.chars().any(char::is_control) {
                return Err(format!(
                    "usage attribution {field} must not contain control characters"
                ));
            }
            if value.eq_ignore_ascii_case(UNKNOWN_SENTINEL) {
                return Err(format!(
                    "usage attribution {field} must not be the reserved value {UNKNOWN_SENTINEL}"
                ));
            }
        }
        if self.confirmed && self.account_id.is_none() && !self.is_empty() {
            return Err(
                "a confirmed usage attribution with a provider or label needs an accountId"
                    .to_string(),
            );
        }
        Ok(())
    }

    /// The env vars a spawn should export for this row.
    ///
    /// Absent fields export nothing at all — never an empty string, which the
    /// publisher would drop anyway and which would read as "reported blank"
    /// rather than "not reported". The confirmation flag rides only with an
    /// `account_id`, because NIP-AM rejects a confirmation with nothing to
    /// confirm.
    pub fn derived_env(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        if self.validate().is_err() {
            // A record hand-edited past the save-time validator must not be
            // able to poison the spawn env. Publishing nothing is the honest
            // outcome; the UI still shows the row so the owner can fix it.
            return env;
        }
        for (key, value) in [
            (USAGE_PROVIDER_ENV_VAR, self.provider.as_deref()),
            (USAGE_ACCOUNT_ID_ENV_VAR, self.account_id.as_deref()),
            (USAGE_ACCOUNT_LABEL_ENV_VAR, self.account_label.as_deref()),
        ] {
            if let Some(value) = value {
                env.insert(key.to_string(), value.to_string());
            }
        }
        if self.account_id.is_some() {
            env.insert(
                USAGE_ACCOUNT_CONFIRMED_ENV_VAR.to_string(),
                if self.confirmed { "true" } else { "false" }.to_string(),
            );
        }
        env
    }
}

/// The attribution variables a spawn will actually export: the derived row,
/// with an explicit entry from the layered user env winning over it.
///
/// That precedence is the power-user escape hatch the `env_vars` module header
/// promises for every knob that also has a dedicated UI field. (It is the
/// *opposite* of `apply_effort_env`, which is written after the user layer
/// because effort has a canonical authority. Attribution does not: a label the
/// owner typed into `env_vars` by hand is still the owner speaking.)
///
/// This function is the only place that precedence is decided. Both the spawn
/// ([`apply_user_and_attribution_env`]) and the spawn-config snapshot read it,
/// so the restart badge and the running process cannot disagree about which
/// labels are in force.
pub fn effective_usage_attribution(
    attribution: Option<&UsageAttributionConfig>,
    descriptor_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut resolved = attribution
        .map(UsageAttributionConfig::derived_env)
        .unwrap_or_default();
    for key in USAGE_ATTRIBUTION_ENV_KEYS {
        if let Some(value) = descriptor_env.get(*key) {
            resolved.insert((*key).to_string(), value.clone());
        }
    }
    resolved
}

/// Write the resolved attribution variables and the layered user env onto a
/// spawn command, in that order.
///
/// `descriptor_env` is the caller's fully-layered, reserved-key-filtered user
/// env (floor→runtime→definition→global→persona→agent). It is written last, so
/// a user-explicit value wins over every Buzz-set variable — which is why
/// `spawn_agent_child` calls this instead of writing that env itself.
///
/// One function rather than two adjacent loops in `spawn_agent_child`, because
/// the ordering *is* the precedence contract and a test of two loops it had to
/// re-create would be testing a copy. Every attribution key is cleared first,
/// so an ambient value inherited from the desktop's own environment cannot
/// masquerade as this agent's identity: an absent row plus an absent env entry
/// exports nothing at all.
pub fn apply_user_and_attribution_env(
    command: &mut std::process::Command,
    attribution: Option<&UsageAttributionConfig>,
    descriptor_env: &BTreeMap<String, String>,
) {
    for key in USAGE_ATTRIBUTION_ENV_KEYS {
        command.env_remove(key);
    }
    for (key, value) in effective_usage_attribution(attribution, descriptor_env) {
        command.env(key, value);
    }
    // The rest of the layered user env. The four attribution keys resolved
    // above are re-written to the identical value here, which is a no-op.
    for (key, value) in descriptor_env {
        command.env(key, value);
    }
}

/// The configuration Buzz has actually recorded for one agent — the only
/// inputs seeding is allowed to look at.
///
/// Deliberately *not* included: the model identifier (name-shaped inference),
/// any credential value, the agent's display name, and the relay URL.
#[derive(Debug, Clone, Copy, Default)]
pub struct ObservedAgentConfig<'a> {
    /// The structured runtime profile identifier (`ManagedAgentRecord.runtime`
    /// / `AgentDefinition.runtime`). A profile id, not a capability claim.
    pub runtime_id: Option<&'a str>,
    /// The structured `provider` field, as recorded configuration.
    pub provider: Option<&'a str>,
    /// An explicitly-configured gateway endpoint from `env_vars`, e.g.
    /// `OPENAI_COMPAT_BASE_URL`. Only its host and port are ever read.
    pub gateway_base_url: Option<&'a str>,
}

/// Env keys that name an explicitly-configured inference gateway.
///
/// A gateway host is configuration the owner typed, which is why it is a legal
/// grouping signal. Its *value* is never read as an identity: only the host and
/// port survive [`gateway_authority`], and userinfo, path, query and fragment
/// are discarded precisely because a URL is a place credentials hide.
pub const GATEWAY_BASE_URL_ENV_KEYS: &[&str] = &[
    "OPENAI_COMPAT_BASE_URL",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "OPENROUTER_BASE_URL",
];

/// Find the explicitly-configured gateway URL in a layered env map, if any.
pub fn gateway_base_url_from_env(env: &BTreeMap<String, String>) -> Option<&str> {
    GATEWAY_BASE_URL_ENV_KEYS
        .iter()
        .find_map(|key| env.get(*key))
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
}

/// `host[:port]` of a configured gateway, lowercased.
///
/// Userinfo is dropped, not masked: `https://someone:tok@host/v1` yields
/// `host`. Path, query and fragment are dropped too. `None` when the value is
/// not a parseable absolute URL with a host, so a typo becomes "not observed"
/// rather than a bogus account.
pub fn gateway_authority(base_url: &str) -> Option<String> {
    let parsed = url::Url::parse(base_url.trim()).ok()?;
    let host = parsed.host_str()?;
    if host.is_empty() {
        return None;
    }
    let host = host.to_ascii_lowercase();
    Some(match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// Seed attribution from observed configuration, or `None` when nothing is
/// observable.
///
/// The `credential` component is the credential the readiness gate requires for
/// this configuration — the *name*, never the value. With today's credential
/// table that name is a function of `(runtime_id, provider)`, so it cannot
/// currently split a group those two did not already split; it is carried
/// because it is the observed requirement and will discriminate the moment a
/// runtime's requirement stops being derivable from them.
pub fn seed_usage_attribution(observed: ObservedAgentConfig<'_>) -> Option<UsageAttributionConfig> {
    let runtime_id = trimmed(observed.runtime_id);
    let provider = trimmed(observed.provider);
    let gateway = observed.gateway_base_url.and_then(gateway_authority);
    let credential =
        provider_credential_key(provider).or_else(|| runtime_login_authority(runtime_id));

    if runtime_id.is_none() && provider.is_none() && gateway.is_none() {
        // Nothing was ever recorded for this agent. An account id built from
        // no signals would be the same string for every such agent, which is a
        // placeholder wearing a grouping key's clothes.
        return None;
    }

    let mut key_parts: Vec<String> = Vec::new();
    let mut label_parts: Vec<String> = Vec::new();
    if let Some(runtime_id) = runtime_id {
        key_parts.push(format!("harness={runtime_id}"));
        label_parts.push(format!("harness {runtime_id}"));
    }
    if let Some(provider) = provider {
        key_parts.push(format!("provider={provider}"));
        label_parts.push(format!("provider {provider}"));
    }
    if let Some(gateway) = &gateway {
        key_parts.push(format!("gateway={gateway}"));
        label_parts.push(format!("gateway {gateway}"));
    }
    if let Some(credential) = credential {
        key_parts.push(format!("credential={credential}"));
    }

    let config = UsageAttributionConfig {
        // Only the structured provider field, and only when it was recorded.
        provider: provider.map(str::to_owned),
        account_id: Some(bounded_account_id(&key_parts.join(";"))),
        account_label: Some(bounded_label(&format!(
            "Observed {}",
            label_parts.join(" · ")
        ))),
        confirmed: false,
    };
    debug_assert!(
        config.validate().is_ok(),
        "seeded attribution must satisfy its own validator: {config:?}"
    );
    Some(config)
}

/// The attribution a newly minted instance should inherit from its linked
/// definition, read straight out of the record store.
///
/// The store is the one authority: definitions are key-less records in the same
/// file (Phase-1A fold), so there is no definition-side copy of this field that
/// could drift from it. Deliberately *not* mirrored back on every start the way
/// `apply_persona_snapshot` mirrors model/provider — after mint, attribution is
/// instance-owned, so confirming one instance does not silently rewrite its
/// siblings.
///
/// `None` for a definition-less create; boot-time seeding then fills the new
/// record from its own observed configuration.
pub fn inherited_from_definition(
    records: &[super::types::ManagedAgentRecord],
    definition_slug: Option<&str>,
) -> Option<UsageAttributionConfig> {
    let slug = definition_slug?;
    records
        .iter()
        .find(|record| record.pubkey.is_empty() && record.slug.as_deref() == Some(slug))?
        .usage_attribution
        .clone()
}

/// Fill attribution only when it is absent.
///
/// Idempotent and non-destructive by construction, which is what lets this run
/// on every boot: an owner-confirmed row is never rewritten, and an owner who
/// deliberately cleared a row (leaving `confirmed: true` with empty identity
/// fields) does not get it resurrected on the next launch.
///
/// Returns `true` when it wrote something.
pub fn seed_absent_attribution(
    current: &mut Option<UsageAttributionConfig>,
    observed: ObservedAgentConfig<'_>,
) -> bool {
    if current.is_some() {
        return false;
    }
    match seed_usage_attribution(observed) {
        Some(seeded) => {
            *current = Some(seeded);
            true
        }
        None => false,
    }
}

/// Apply an owner edit, marking the row confirmed.
///
/// Confirmation is not a separate toggle the caller can forget: editing *is*
/// confirming, so there is no path that writes an owner value and leaves it
/// looking seeded. Clearing every field is also a confirmation — the owner has
/// said this agent has no subscription identity.
pub fn apply_owner_attribution(
    provider: Option<String>,
    account_id: Option<String>,
    account_label: Option<String>,
) -> Result<UsageAttributionConfig, String> {
    let config = UsageAttributionConfig {
        provider: trimmed_owned(provider),
        account_id: trimmed_owned(account_id),
        account_label: trimmed_owned(account_label),
        confirmed: true,
    };
    config.validate()?;
    Ok(config)
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn trimmed_owned(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Keep a derived key inside [`MAX_ATTRIBUTION_VALUE_BYTES`] without ever
/// producing the same key for two different observed configurations.
///
/// Truncation alone would collide (two long gateway hosts sharing a prefix), so
/// an over-long key collapses to a digest of the full key instead. Stable
/// across launches because it is a pure function of the observed config.
fn bounded_account_id(key: &str) -> String {
    if key.len() <= MAX_ATTRIBUTION_VALUE_BYTES {
        return key.to_string();
    }
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(key.as_bytes());
    format!("observed-{}", hex::encode(&digest[..16]))
}

/// Labels are display metadata, so a long one is truncated on a char boundary
/// with an ellipsis rather than digested into something unreadable.
fn bounded_label(label: &str) -> String {
    if label.len() <= MAX_ATTRIBUTION_VALUE_BYTES {
        return label.to_string();
    }
    const ELLIPSIS: char = '…';
    let budget = MAX_ATTRIBUTION_VALUE_BYTES - ELLIPSIS.len_utf8();
    let mut out = String::new();
    for ch in label.chars() {
        if out.len() + ch.len_utf8() > budget {
            break;
        }
        out.push(ch);
    }
    out.push(ELLIPSIS);
    out
}

#[cfg(test)]
#[path = "usage_attribution/tests.rs"]
mod tests;
