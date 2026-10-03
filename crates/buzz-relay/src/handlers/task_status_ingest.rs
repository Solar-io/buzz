//! Kind-30624 (agent task status) ingest validation.
//!
//! The wire rules live in `buzz_core::task_status`; this module only maps a
//! rejection onto the ingest error taxonomy. `h` is required by the validator,
//! not by `requires_h_channel_scope`, so the rejection text stays
//! kind-specific (`invalid: task-status: <rule>`).

use nostr::Event;

use super::ingest::IngestError;

/// Validate a kind-30624 event, mapping any rule violation to
/// `IngestError::Rejected("invalid: task-status: <rule>")`.
pub(crate) fn validate(event: &Event) -> Result<(), IngestError> {
    buzz_core::task_status::validate_task_status_event(event)
        .map_err(|e| IngestError::Rejected(format!("invalid: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    #[test]
    fn rejection_is_prefixed_invalid_task_status() {
        let ch = "0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6";
        let event = EventBuilder::new(Kind::Custom(30624), "")
            .tags([
                Tag::parse(["d", &format!("detail:{ch}")]).unwrap(),
                Tag::parse(["h", ch]).unwrap(),
                Tag::parse(["turn", "t1"]).unwrap(),
            ])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        match validate(&event) {
            Err(IngestError::Rejected(msg)) => {
                assert!(msg.starts_with("invalid: task-status: "), "{msg}")
            }
            _ => panic!("expected a rejection"),
        }
    }
    fn job(id: &str) -> Event {
        let ch = "0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6";
        EventBuilder::new(Kind::Custom(30624), "")
            .tags([
                Tag::parse(["d", &format!("job:{ch}:{id}")]).unwrap(),
                Tag::parse(["h", ch]).unwrap(),
                Tag::parse(["role", "coder"]).unwrap(),
                Tag::parse(["state", "running"]).unwrap(),
                Tag::parse(["started", "1000"]).unwrap(),
            ])
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn accepts_job_head() {
        assert!(validate(&job("j1")).is_ok());
    }

    #[test]
    fn job_rejection_is_prefixed() {
        match validate(&job("bad id")) {
            Err(IngestError::Rejected(msg)) => {
                assert!(msg.starts_with("invalid: task-status: "), "{msg}")
            }
            _ => panic!("expected job rejection"),
        }
    }
}
