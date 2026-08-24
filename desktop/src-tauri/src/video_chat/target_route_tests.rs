//! Tests for the peer-forwarded target routing (`apply_target_payload`) —
//! the pure core of `POST /v1/internal/target`. Run serially in one test:
//! `TARGET` is a process-global slot.

use super::apply_target_payload;
use serde_json::json;

#[test]
fn target_payloads_set_clear_and_reject() {
    // Clear first so the test is independent of slot state.
    assert!(apply_target_payload(&json!({ "clear": true })).is_ok());
    assert!(super::current_target().is_none());

    // A full Target body arms the slot.
    let armed = json!({
        "channel_id": "6f05d127-b6c4-4369-bc69-0048f1706b79",
        "agent_pubkey": "63b861c2c6ec3a3168521e803a6a695376aa6edc951f1b52399c0df5c4625fe3",
        "agent_name": "Acid Burn",
    });
    let cleared = apply_target_payload(&armed).expect("full target should apply");
    assert!(!cleared);
    let target = super::current_target().expect("target should be armed");
    assert_eq!(target.channel_id, "6f05d127-b6c4-4369-bc69-0048f1706b79");
    assert_eq!(
        target.agent_pubkey,
        "63b861c2c6ec3a3168521e803a6a695376aa6edc951f1b52399c0df5c4625fe3"
    );
    assert_eq!(target.agent_name.as_deref(), Some("Acid Burn"));

    // A later clear payload (what a closing panel forwards) releases it.
    let cleared = apply_target_payload(&json!({ "clear": true })).expect("clear should apply");
    assert!(cleared);
    assert!(super::current_target().is_none());

    // Missing required fields are a request error, not a silent no-op.
    let bad = apply_target_payload(&json!({ "agent_pubkey": "abc" }));
    assert!(bad.is_err(), "payload without channel_id must be rejected");
}
