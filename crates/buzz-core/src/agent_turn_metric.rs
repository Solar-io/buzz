//! NIP-AM: Agent Turn Metric — payload type and encrypt/decrypt helpers.
//!
//! One `kind:44200` event is published per completed agent turn. Its content
//! is a NIP-44 v2 ciphertext (agent key → owner pubkey) that decodes to an
//! [`AgentTurnMetricPayload`] JSON object.
//!
//! See `docs/nips/NIP-AM.md` for the full specification.

use nostr::{Event, Keys, PublicKey};
use serde::{Deserialize, Serialize};

use crate::observer::{decrypt_observer_payload, encrypt_observer_payload, ObserverPayloadError};

// Re-export for callers that only need the error type.
pub use crate::observer::ObserverPayloadError as AgentTurnMetricError;

/// Token-usage counters for a single measurement window (one turn or cumulative).
///
/// All token fields are nullable — `None` means the harness did not report them,
/// NOT that the count was zero. See NIP-AM §Numeric validity and token semantics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    /// Input tokens (inclusive of cache reads/writes where applicable).
    pub input_tokens: Option<u64>,

    /// Output tokens.
    pub output_tokens: Option<u64>,

    /// Provider-reported total — NOT derived by summing input + output.
    /// `None` when the provider did not report a total.
    pub total_tokens: Option<u64>,

    /// Estimated cost in USD. Must be finite and non-negative when present.
    pub cost_usd: Option<f64>,

    /// Informational: cache-read tokens included in `input_tokens`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,

    /// Informational: cache-write tokens included in `input_tokens`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

/// Why a turn ended.
///
/// NIP-AM: consumers MUST treat unrecognized `stopReason` values as `Unknown`
/// and keep the token counts valid. Custom deserialization maps any unrecognized
/// string to `Unknown` instead of failing the whole payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// Model reached a natural end-of-turn.
    EndTurn,
    /// Model hit the max-tokens limit.
    MaxTokens,
    /// Turn was cancelled by the owner or harness.
    Cancelled,
    /// Turn ended with an error.
    Error,
    /// Stop reason is unknown or unrecognized.
    Unknown,
}

impl<'de> Deserialize<'de> for StopReason {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "end_turn" => StopReason::EndTurn,
            "max_tokens" => StopReason::MaxTokens,
            "cancelled" => StopReason::Cancelled,
            "error" => StopReason::Error,
            "unknown" => StopReason::Unknown,
            _ => StopReason::Unknown,
        })
    }
}

/// Billing identity for a turn — present only when the publisher can prove
/// applicability from the actual endpoint and actually-requested model.
///
/// NIP-AM: this is OPTIONAL but NOT nullable. When present, `authority` and
/// `model` MUST be non-null strings; `cache_class` is omitted (not null) when
/// not applicable.
///
/// Consumers MUST treat omission as "price unknown" and MUST NOT infer a price
/// from the session `model` field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingIdentity {
    /// Registered billing-namespace identifier: exact lowercase hostname, no
    /// scheme, no path, no trailing slash. Registered values: `api.anthropic.com`,
    /// `api.openai.com`, `openrouter.ai`. Set extends only by NIP amendment.
    pub authority: String,

    /// The billable model identifier as resolved at request time — the
    /// actually-requested model, not the configured/session model alias.
    pub model: String,

    /// Cache-write class (e.g. `"ephemeral"`). Omitted when not applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_class: Option<String>,
}

/// Explicit, non-secret usage attribution. Never derived from a model name.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAttribution {
    /// Observed or explicitly configured provider identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Owner-defined stable account identifier, never a credential.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Private display label for that account.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    /// Observed service tier, not inferred from model or account.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
}

/// One observed provider call, subordinate to (never additive to) turn totals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestObservation {
    /// Unique, turn-local observation identifier for deduplication.
    pub id: String,
    /// Actual requested model, when available.
    pub model: Option<String>,
    /// Explicit route/account/tier attribution.
    #[serde(default)]
    pub attribution: UsageAttribution,
    /// Provider-reported counters; absence is unknown.
    pub usage: TokenCounts,
    /// `wire-reported`, `manifest-estimated`, or absent/unknown.
    pub cost_source: Option<String>,
    /// Elapsed request time in milliseconds, when observed.
    pub latency_ms: Option<u64>,
    /// Whether this was a fallback request, when observed.
    pub fallback: Option<bool>,
}

/// Optional additive analytics metadata. Older events remain valid unchanged.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTelemetry {
    /// Turn-wide attribution, only when common to all contributions.
    #[serde(default)]
    pub attribution: UsageAttribution,
    /// Cost provenance; unrecognized values remain unknown.
    pub cost_source: Option<String>,
    /// Total provider calls observed by the harness, including failures.
    pub request_count: Option<u64>,
    /// True only if every call is represented exactly once in `requests`.
    #[serde(default)]
    pub requests_complete: bool,
    /// Optional provider-call breakdown, metrics only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requests: Vec<RequestObservation>,
}

/// Decrypted payload of a `kind:44200` Agent Turn Metric event.
/// nullable unless constrained by the NIP (e.g. `session_id` + `turn_seq`
/// are required whenever `cumulative` is present).
///
/// Consumers MUST ignore unknown fields (forward compatibility).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnMetricPayload {
    /// Harness identifier (e.g. `"goose"`, `"buzz-agent"`). REQUIRED.
    pub harness: String,

    /// Model identifier as reported by the harness, or `None` if unknown.
    pub model: Option<String>,

    /// Channel UUID the turn served, encrypted inside the payload.
    pub channel_id: Option<String>,

    /// Session identifier. REQUIRED when `cumulative` is present.
    pub session_id: Option<String>,

    /// Turn identifier (harness-internal).
    pub turn_id: Option<String>,

    /// Monotonically increasing per-session sequence number.
    /// REQUIRED when `cumulative` is present; strictly increasing within one
    /// `session_id`. A publisher restart that loses the counter MUST start a
    /// new `session_id`.
    pub turn_seq: Option<u64>,

    /// RFC 3339 timestamp (end-of-turn). REQUIRED.
    pub timestamp: String,

    /// Usage for this turn (computed delta). Null fields mean not reported.
    pub turn: Option<TokenCounts>,

    /// Session-cumulative usage as reported at end of this turn.
    pub cumulative: Option<TokenCounts>,

    /// `false` when the publisher could not observe the previous cumulative
    /// baseline (e.g. harness restart mid-session), making `turn` unreliable.
    /// Defaults to `true` on the wire when not explicitly set.
    #[serde(default = "default_delta_reliable")]
    pub delta_reliable: bool,

    /// Why the turn ended. Unrecognized values MUST be treated as `Unknown`.
    pub stop_reason: Option<StopReason>,

    /// Billing identity, present only when the publisher can prove it from the
    /// actual endpoint (official provider API) and the actually-requested model.
    ///
    /// Omit (never null) when applicability cannot be proven. Consumers MUST
    /// treat omission as "price unknown".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing_identity: Option<PricingIdentity>,
    /// Optional private analytics metadata, never copied to event tags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<UsageTelemetry>,
}

fn default_delta_reliable() -> bool {
    true
}

impl AgentTurnMetricPayload {
    /// Validate numeric constraints from NIP-AM §Numeric validity.
    ///
    /// Returns `Err` when any `cost_usd` field (in `turn` or `cumulative`) is
    /// present but negative or non-finite (NaN or infinity). Token counts are
    /// typed as `Option<u64>` and therefore cannot be negative by construction.
    pub fn validate(&self) -> Result<(), ObserverPayloadError> {
        fn metric_label(
            value: &str,
            field: &str,
            allow_unknown: bool,
        ) -> Result<(), ObserverPayloadError> {
            let trimmed = value.trim();
            if trimmed.is_empty()
                || trimmed != value
                || trimmed.len() > 256
                || trimmed.chars().any(|c| c.is_control())
                || (!allow_unknown && trimmed.eq_ignore_ascii_case("__unknown__"))
            {
                return Err(ObserverPayloadError::InvalidPayload(format!(
                    "{field} must be a nonblank label of at most 256 bytes without controls or reserved values"
                )));
            }
            Ok(())
        }
        fn attribution(value: &UsageAttribution, prefix: &str) -> Result<(), ObserverPayloadError> {
            for (name, field) in [
                ("provider", value.provider.as_deref()),
                ("accountId", value.account_id.as_deref()),
                ("accountLabel", value.account_label.as_deref()),
                ("serviceTier", value.service_tier.as_deref()),
            ] {
                if let Some(field) = field {
                    metric_label(field, &format!("{prefix}.{name}"), false)?;
                }
            }
            Ok(())
        }
        metric_label(&self.harness, "harness", false)?;
        if let Some(model) = &self.model {
            metric_label(model, "model", false)?;
        }
        fn check_cost(cost: Option<f64>, field: &str) -> Result<(), ObserverPayloadError> {
            if let Some(c) = cost {
                if !c.is_finite() || c < 0.0 {
                    return Err(ObserverPayloadError::InvalidPayload(format!(
                        "{field} must be finite and non-negative (got {c})"
                    )));
                }
            }
            Ok(())
        }
        if let Some(t) = &self.turn {
            check_cost(t.cost_usd, "turn.costUsd")?;
        }
        if let Some(c) = &self.cumulative {
            check_cost(c.cost_usd, "cumulative.costUsd")?;
        }
        if let Some(t) = &self.telemetry {
            attribution(&t.attribution, "telemetry.attribution")?;
            let mut ids = std::collections::HashSet::new();
            for request in &t.requests {
                metric_label(&request.id, "requests.id", true)?;
                if !ids.insert(&request.id) {
                    return Err(ObserverPayloadError::InvalidPayload(
                        "request ids must be unique and nonempty".into(),
                    ));
                }
                if let Some(model) = &request.model {
                    metric_label(model, "requests.model", false)?;
                }
                attribution(&request.attribution, "requests.attribution")?;
                check_cost(request.usage.cost_usd, "requests.usage.costUsd")?;
            }
            if (t.requests_complete && t.request_count != Some(t.requests.len() as u64))
                || t.request_count
                    .is_some_and(|count| count < t.requests.len() as u64)
            {
                return Err(ObserverPayloadError::InvalidPayload(
                    "complete requests must match requestCount".into(),
                ));
            }
        }
        Ok(())
    }
}

/// Encrypt an [`AgentTurnMetricPayload`] into a NIP-44 v2 ciphertext string
/// using the agent's key pair and the owner's public key.
///
/// Returns `Err(ObserverPayloadError::InvalidPayload)` if any `cost_usd` field
/// is negative or non-finite (NaN/inf), in accordance with NIP-AM §Numeric
/// validity.
///
/// This is the content field of a `kind:44200` event.
pub fn encrypt_agent_turn_metric(
    agent_keys: &Keys,
    owner_pubkey: &PublicKey,
    payload: &AgentTurnMetricPayload,
) -> Result<String, ObserverPayloadError> {
    payload.validate()?;
    encrypt_observer_payload(agent_keys, owner_pubkey, payload)
}

/// Decrypt and deserialize an [`AgentTurnMetricPayload`] from a `kind:44200` event.
///
/// `recipient_keys` is the owner's key pair.
///
/// Returns `Err(ObserverPayloadError::InvalidPayload)` if the decrypted payload
/// fails numeric validation (e.g. negative or non-finite `costUsd`), mirroring
/// the fail-closed contract of [`encrypt_agent_turn_metric`].
pub fn decrypt_agent_turn_metric(
    recipient_keys: &Keys,
    event: &Event,
) -> Result<AgentTurnMetricPayload, ObserverPayloadError> {
    let payload: AgentTurnMetricPayload = decrypt_observer_payload(recipient_keys, event)?;
    payload.validate()?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Kind, Tag};

    #[test]
    fn analytics_extensions_validate_completeness_duplicates_and_costs() {
        let mut p = sample_payload();
        let request = RequestObservation {
            id: "0".into(),
            model: None,
            attribution: Default::default(),
            usage: p.turn.clone().unwrap(),
            cost_source: None,
            latency_ms: Some(u64::MAX),
            fallback: None,
        };
        p.telemetry = Some(UsageTelemetry {
            request_count: Some(1),
            requests_complete: true,
            requests: vec![request.clone()],
            ..Default::default()
        });
        assert!(p.validate().is_ok());
        p.telemetry.as_mut().unwrap().requests.push(request);
        assert!(p.validate().is_err());
        p.telemetry.as_mut().unwrap().requests.pop();
        p.telemetry.as_mut().unwrap().request_count = Some(2);
        assert!(p.validate().is_err());
        p.telemetry.as_mut().unwrap().requests_complete = false;
        assert!(p.validate().is_ok());
        p.telemetry.as_mut().unwrap().request_count = Some(0);
        assert!(
            p.validate().is_err(),
            "observations cannot exceed requestCount"
        );
        p.telemetry.as_mut().unwrap().request_count = Some(1);
        p.telemetry.as_mut().unwrap().attribution.provider = Some("__unknown__".into());
        assert!(p.validate().is_err(), "reserved labels are rejected");
        p.telemetry.as_mut().unwrap().attribution.provider = Some("bad\nprovider".into());
        assert!(p.validate().is_err(), "control characters are rejected");
        p.telemetry.as_mut().unwrap().attribution.provider = Some("x".repeat(257));
        assert!(p.validate().is_err(), "oversized labels are rejected");
        p.telemetry.as_mut().unwrap().attribution.provider = None;
        p.telemetry.as_mut().unwrap().requests[0].usage.cost_usd = Some(-1.0);
        assert!(p.validate().is_err());
    }

    fn sample_payload() -> AgentTurnMetricPayload {
        AgentTurnMetricPayload {
            harness: "goose".to_string(),
            model: Some("claude-sonnet-4-5".to_string()),
            channel_id: Some("12345678-1234-1234-1234-123456789abc".to_string()),
            session_id: Some("sess-abc".to_string()),
            turn_id: Some("turn-1".to_string()),
            turn_seq: Some(1),
            timestamp: "2026-07-01T20:11:03.213Z".to_string(),
            turn: Some(TokenCounts {
                input_tokens: Some(1234),
                output_tokens: Some(567),
                total_tokens: Some(1801),
                cost_usd: Some(0.0123),
                cache_read_tokens: None,
                cache_write_tokens: None,
            }),
            cumulative: Some(TokenCounts {
                input_tokens: Some(45210),
                output_tokens: Some(9876),
                total_tokens: Some(55086),
                cost_usd: Some(0.41),
                cache_read_tokens: None,
                cache_write_tokens: None,
            }),
            delta_reliable: true,
            stop_reason: Some(StopReason::EndTurn),
            pricing_identity: None,
            telemetry: None,
        }
    }

    #[test]
    fn round_trip_encrypt_decrypt() {
        let agent_keys = Keys::generate();
        let owner_keys = Keys::generate();

        let payload = sample_payload();
        let ciphertext = encrypt_agent_turn_metric(&agent_keys, &owner_keys.public_key(), &payload)
            .expect("encrypt");

        // Build a minimal event envelope so decrypt_observer_payload can use event.pubkey.
        let event = EventBuilder::new(Kind::Custom(44200), ciphertext)
            .tags([
                Tag::parse(["p", &owner_keys.public_key().to_hex()]).unwrap(),
                Tag::parse(["agent", &agent_keys.public_key().to_hex()]).unwrap(),
            ])
            .sign_with_keys(&agent_keys)
            .expect("sign");

        let decoded = decrypt_agent_turn_metric(&owner_keys, &event).expect("decrypt");

        assert_eq!(decoded, payload);
    }

    #[test]
    fn wrong_key_decrypt_fails() {
        let agent_keys = Keys::generate();
        let owner_keys = Keys::generate();
        let wrong_keys = Keys::generate();

        let payload = sample_payload();
        let ciphertext = encrypt_agent_turn_metric(&agent_keys, &owner_keys.public_key(), &payload)
            .expect("encrypt");

        let event = EventBuilder::new(Kind::Custom(44200), ciphertext)
            .tags([
                Tag::parse(["p", &owner_keys.public_key().to_hex()]).unwrap(),
                Tag::parse(["agent", &agent_keys.public_key().to_hex()]).unwrap(),
            ])
            .sign_with_keys(&agent_keys)
            .expect("sign");

        let result = decrypt_agent_turn_metric(&wrong_keys, &event);
        assert!(result.is_err(), "expected decrypt error with wrong key");
    }

    #[test]
    fn delta_reliable_defaults_to_true_when_absent() {
        let json = r#"{"harness":"goose","timestamp":"2026-07-01T20:11:03Z"}"#;
        let payload: AgentTurnMetricPayload = serde_json::from_str(json).expect("parse");
        assert!(
            payload.delta_reliable,
            "deltaReliable should default to true"
        );
    }

    #[test]
    fn stop_reason_round_trips() {
        for (variant, json_val) in [
            (StopReason::EndTurn, "\"end_turn\""),
            (StopReason::MaxTokens, "\"max_tokens\""),
            (StopReason::Cancelled, "\"cancelled\""),
            (StopReason::Error, "\"error\""),
            (StopReason::Unknown, "\"unknown\""),
        ] {
            let serialized = serde_json::to_string(&variant).unwrap();
            assert_eq!(serialized, json_val);
            let deserialized: StopReason = serde_json::from_str(json_val).unwrap();
            assert_eq!(deserialized, variant);
        }
    }

    #[test]
    fn null_token_counts_round_trip() {
        // Verify that None fields serialize to `null` (not absent), as required
        // by the NIP — consumers must distinguish "not reported" from "zero".
        let counts = TokenCounts {
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cost_usd: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
        };
        let json = serde_json::to_string(&counts).unwrap();
        // cache_* are skip_serializing_if = None, others serialize as null
        assert!(json.contains("\"inputTokens\":null"));
        assert!(json.contains("\"outputTokens\":null"));
        let back: TokenCounts = serde_json::from_str(&json).unwrap();
        assert_eq!(back, counts);
    }

    #[test]
    fn unknown_stop_reason_maps_to_unknown_not_error() {
        // NIP-AM: consumers MUST treat unrecognized stopReason values as Unknown;
        // the token counts remain valid and the whole payload must not be rejected.
        let json = r#"{
            "harness": "goose",
            "timestamp": "2026-07-01T20:11:03Z",
            "stopReason": "tool_limit",
            "turn": {
                "inputTokens": 1234,
                "outputTokens": 567,
                "totalTokens": 1801,
                "costUsd": null
            }
        }"#;
        let payload: AgentTurnMetricPayload =
            serde_json::from_str(json).expect("payload with future stopReason must parse");
        assert_eq!(
            payload.stop_reason,
            Some(StopReason::Unknown),
            "unrecognized stopReason must map to Unknown"
        );
        // Token counts must be preserved.
        let turn = payload.turn.expect("turn must be present");
        assert_eq!(turn.input_tokens, Some(1234));
        assert_eq!(turn.output_tokens, Some(567));
        assert_eq!(turn.total_tokens, Some(1801));
    }

    // ── validate() — negative / non-finite costUsd ─────────────────────────

    fn make_payload_with_turn_cost(cost: Option<f64>) -> AgentTurnMetricPayload {
        AgentTurnMetricPayload {
            harness: "test".to_string(),
            model: None,
            channel_id: None,
            session_id: None,
            turn_id: None,
            turn_seq: None,
            timestamp: "2026-07-01T00:00:00Z".to_string(),
            turn: Some(TokenCounts {
                input_tokens: Some(100),
                output_tokens: Some(50),
                total_tokens: None,
                cost_usd: cost,
                cache_read_tokens: None,
                cache_write_tokens: None,
            }),
            cumulative: None,
            delta_reliable: true,
            stop_reason: None,
            pricing_identity: None,
            telemetry: None,
        }
    }

    fn make_payload_with_cumulative_cost(cost: Option<f64>) -> AgentTurnMetricPayload {
        AgentTurnMetricPayload {
            harness: "test".to_string(),
            model: None,
            channel_id: None,
            session_id: None,
            turn_id: None,
            turn_seq: None,
            timestamp: "2026-07-01T00:00:00Z".to_string(),
            turn: None,
            cumulative: Some(TokenCounts {
                input_tokens: Some(500),
                output_tokens: Some(200),
                total_tokens: None,
                cost_usd: cost,
                cache_read_tokens: None,
                cache_write_tokens: None,
            }),
            delta_reliable: true,
            stop_reason: None,
            pricing_identity: None,
            telemetry: None,
        }
    }

    #[test]
    fn validate_rejects_negative_turn_cost() {
        let payload = make_payload_with_turn_cost(Some(-0.001));
        assert!(
            matches!(
                payload.validate(),
                Err(ObserverPayloadError::InvalidPayload(_))
            ),
            "negative turn.costUsd must be rejected"
        );
    }

    #[test]
    fn validate_rejects_nan_turn_cost() {
        let payload = make_payload_with_turn_cost(Some(f64::NAN));
        assert!(
            matches!(
                payload.validate(),
                Err(ObserverPayloadError::InvalidPayload(_))
            ),
            "NaN turn.costUsd must be rejected"
        );
    }

    #[test]
    fn validate_rejects_infinite_turn_cost() {
        let payload = make_payload_with_turn_cost(Some(f64::INFINITY));
        assert!(
            matches!(
                payload.validate(),
                Err(ObserverPayloadError::InvalidPayload(_))
            ),
            "infinite turn.costUsd must be rejected"
        );
    }

    #[test]
    fn validate_rejects_negative_cumulative_cost() {
        let payload = make_payload_with_cumulative_cost(Some(-1.0));
        assert!(
            matches!(
                payload.validate(),
                Err(ObserverPayloadError::InvalidPayload(_))
            ),
            "negative cumulative.costUsd must be rejected"
        );
    }

    #[test]
    fn validate_accepts_finite_non_negative_cost() {
        // Zero, small, and larger values are all valid.
        for cost in [0.0_f64, 0.001, 1.0, 999.99] {
            let payload = make_payload_with_turn_cost(Some(cost));
            assert!(payload.validate().is_ok(), "cost {cost} should be accepted");
        }
    }

    #[test]
    fn validate_accepts_absent_cost() {
        let payload = make_payload_with_turn_cost(None);
        assert!(
            payload.validate().is_ok(),
            "absent costUsd must be accepted"
        );
    }

    #[test]
    fn encrypt_agent_turn_metric_rejects_negative_cost() {
        let agent_keys = Keys::generate();
        let owner_keys = Keys::generate();
        let payload = make_payload_with_turn_cost(Some(-0.5));
        let result = encrypt_agent_turn_metric(&agent_keys, &owner_keys.public_key(), &payload);
        assert!(
            matches!(result, Err(ObserverPayloadError::InvalidPayload(_))),
            "encrypt must reject payload with negative costUsd"
        );
    }

    #[test]
    fn decrypt_agent_turn_metric_rejects_negative_cost_bypassing_encrypt() {
        // Regression: a raw/misbehaving agent can persist a syntactically valid
        // NIP-44 payload with costUsd: -1 by calling encrypt_observer_payload
        // directly (bypassing the validating encrypt_agent_turn_metric helper).
        // decrypt_agent_turn_metric must reject it symmetrically.
        use crate::observer::encrypt_observer_payload;

        let agent_keys = Keys::generate();
        let owner_keys = Keys::generate();

        // Build a payload with negative costUsd and encrypt via the lower-level
        // path, bypassing encrypt_agent_turn_metric's validate() call.
        let bad_payload = make_payload_with_turn_cost(Some(-1.0));
        let ciphertext =
            encrypt_observer_payload(&agent_keys, &owner_keys.public_key(), &bad_payload)
                .expect("lower-level encrypt should succeed without validation");

        let event = EventBuilder::new(Kind::Custom(44200), ciphertext)
            .tags([
                Tag::parse(["p", &owner_keys.public_key().to_hex()]).unwrap(),
                Tag::parse(["agent", &agent_keys.public_key().to_hex()]).unwrap(),
            ])
            .sign_with_keys(&agent_keys)
            .expect("sign");

        let result = decrypt_agent_turn_metric(&owner_keys, &event);
        assert!(
            matches!(result, Err(ObserverPayloadError::InvalidPayload(_))),
            "decrypt must reject a payload with negative costUsd even when \
             encrypted via the lower-level path"
        );
    }
}
