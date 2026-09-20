//! Which credential a provider's readiness gate actually requires.
//!
//! One source, two readers. `readiness::buzz_agent_requirements` and
//! `readiness::goose_requirements` push an `EnvKey` requirement for the key
//! named here; `managed_agents::usage_attribution` uses the same name as an
//! *observed configuration* signal when it seeds usage attribution.
//!
//! The name is the only thing that is ever read. The credential's **value** is
//! never inspected, never compared, and never stored — NIP-AM forbids deriving
//! an identity from a credential, and a second copy of this table would be
//! exactly the drift that makes such a rule quietly untrue.

/// The credential key `provider`'s readiness check requires, or `None` when
/// Buzz knows of no credential requirement for it.
///
/// Deliberately exact, never fuzzy: `openai-compat` is absent because the
/// readiness gate does not require a credential for it (only `openai` does),
/// and inventing one here would both fail the gate differently and attribute
/// usage to a credential nobody configured. Databricks names `DATABRICKS_HOST`
/// rather than `DATABRICKS_TOKEN` because OAuth PKCE is the normal path and the
/// token is an escape hatch — see `buzz-agent/src/config.rs`.
pub(crate) fn provider_credential_key(provider: Option<&str>) -> Option<&'static str> {
    match provider {
        Some("anthropic") => Some("ANTHROPIC_API_KEY"),
        Some("openai") => Some("OPENAI_COMPAT_API_KEY"),
        Some("databricks") | Some("databricks_v2") | Some("databricks-v2") => {
            Some("DATABRICKS_HOST")
        }
        Some("openrouter") => Some("OPENROUTER_API_KEY"),
        _ => None,
    }
}

/// The credential store a harness authenticates against when it owns its own
/// login, rather than reading a credential out of the spawn environment.
///
/// These are the runtimes whose readiness is a CLI login probe
/// (`claude auth status`, `codex login status`), so "which credential does this
/// require" is answered by naming the CLI's own store. Returned as a stable
/// identifier, never a path and never a token.
pub(crate) fn runtime_login_authority(runtime_id: Option<&str>) -> Option<&'static str> {
    match runtime_id {
        Some("claude") => Some("claude-cli-login"),
        Some("codex") => Some("codex-cli-login"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_credential_key_is_exact_never_fuzzy() {
        assert_eq!(
            provider_credential_key(Some("anthropic")),
            Some("ANTHROPIC_API_KEY")
        );
        assert_eq!(
            provider_credential_key(Some("openai")),
            Some("OPENAI_COMPAT_API_KEY")
        );
        for spelling in ["databricks", "databricks_v2", "databricks-v2"] {
            assert_eq!(
                provider_credential_key(Some(spelling)),
                Some("DATABRICKS_HOST"),
                "{spelling} must resolve to the host requirement, not the token"
            );
        }
        assert_eq!(
            provider_credential_key(Some("openrouter")),
            Some("OPENROUTER_API_KEY")
        );
        // `openai-compat` has no credential requirement in the readiness gate.
        // Inventing one here would diverge from the gate it mirrors.
        assert_eq!(provider_credential_key(Some("openai-compat")), None);
        assert_eq!(provider_credential_key(Some("ANTHROPIC")), None);
        assert_eq!(provider_credential_key(Some("relay-mesh")), None);
        assert_eq!(provider_credential_key(None), None);
    }

    #[test]
    fn runtime_login_authority_names_only_cli_login_runtimes() {
        assert_eq!(
            runtime_login_authority(Some("claude")),
            Some("claude-cli-login")
        );
        assert_eq!(
            runtime_login_authority(Some("codex")),
            Some("codex-cli-login")
        );
        // A custom harness whose id merely starts with a known one is not that
        // harness: `claude-code-glm` is a user-defined profile with no known
        // credential store, and treating it as `claude` would be exactly the
        // name-shaped inference NIP-AM forbids.
        assert_eq!(runtime_login_authority(Some("claude-code-glm")), None);
        assert_eq!(runtime_login_authority(Some("buzz-agent")), None);
        assert_eq!(runtime_login_authority(Some("goose")), None);
        assert_eq!(runtime_login_authority(None), None);
    }
}
