//! One-shot repair for archived channels left with live discovery metadata.

use std::sync::Arc;

use buzz_core::tenant::TenantContext;
use tracing::{info, warn};

use super::side_effects::emit_group_discovery_events;
use crate::state::AppState;

/// Reconcile archived channel discovery in batches of at most 100. Errors
/// are logged and never stop the relay; each candidate is attempted only once
/// per run, and successful repairs disappear from subsequent runs.
pub async fn reconcile_archived_channel_discovery(state: &Arc<AppState>) {
    let relay_pubkey = state.relay_keypair.public_key().to_bytes();
    let mut after = None;
    let mut repaired = 0;
    let mut failed = 0;
    loop {
        let batch = match state
            .db
            .archived_channels_missing_discovery(&relay_pubkey, after, 100)
            .await
        {
            Ok(batch) => batch,
            Err(error) => {
                warn!(%error, "Archived discovery reconciliation query failed");
                break;
            }
        };
        if batch.is_empty() {
            break;
        }
        for channel in batch {
            after = Some((*channel.community_id.as_uuid(), channel.channel_id));
            let tenant = TenantContext::resolved(channel.community_id, channel.host);
            match emit_group_discovery_events(&tenant, state, channel.channel_id).await {
                Ok(()) => repaired += 1,
                Err(error) => {
                    failed += 1;
                    warn!(channel = %channel.channel_id, %error,
                        "Archived discovery reconciliation refresh failed");
                }
            }
        }
    }
    info!(
        repaired,
        failed, "Archived discovery reconciliation finished"
    );
}
