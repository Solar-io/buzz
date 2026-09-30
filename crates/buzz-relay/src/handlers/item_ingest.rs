//! Kind 30623 (item) ingest validation.
//!
//! A thin wrapper over [`buzz_core::item::validate_item_event`], the single
//! item validator shared with `buzz-sdk`. Kept out of `ingest.rs` so the item
//! hunks there stay small.

use nostr::Event;

use super::ingest::IngestError;

/// Validate an item event, mapping a rejection to `invalid: item: <rule>`.
pub(crate) fn validate(event: &Event) -> Result<(), IngestError> {
    buzz_core::item::validate_item_event(event)
        .map_err(|e| IngestError::Rejected(format!("invalid: item: {e}")))
}
