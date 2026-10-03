//! Message-driven DM resurfacing and a fork-local, one-shot startup repair.

use std::sync::Arc;

use buzz_core::kind::{event_kind_u32, KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2};
use buzz_core::tenant::TenantContext;
use buzz_db::channel::ChannelRecord;
use nostr::Event;
use tracing::{info, warn};

use super::side_effects::publish_dm_visibility_snapshot;
use crate::state::AppState;

/// Schedule resurface only for a newly stored chat message in a DM. The
/// caller must skip duplicates. No database work or publication delays the
/// accepted-message path; ordinary channels and non-message kinds are free.
pub fn spawn_dm_resurface(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    channel: Option<&ChannelRecord>,
    event: &Event,
) {
    if !matches!(
        event_kind_u32(event),
        KIND_STREAM_MESSAGE | KIND_STREAM_MESSAGE_V2
    ) {
        return;
    }
    let Some(channel) = channel.filter(|ch| ch.channel_type == "dm") else {
        return;
    };
    let channel_id = channel.id;
    let sender = event.pubkey.to_bytes();
    let accepted_at = chrono::Utc::now();
    let state = Arc::clone(state);
    let tenant = tenant.clone();
    tokio::spawn(async move {
        match state
            .db
            .unhide_dm_recipients(tenant.community(), channel_id, &sender, accepted_at)
            .await
        {
            Ok(viewers) => {
                for viewer in viewers {
                    if let Err(error) =
                        publish_dm_visibility_snapshot(&tenant, &state, &viewer).await
                    {
                        warn!(%channel_id, %error, "DM resurface snapshot publication failed");
                    }
                }
            }
            Err(error) => warn!(%channel_id, %error, "DM recipient resurface failed"),
        }
    });
}

/// Repair pre-fix hides and stale resurface snapshots in batches of at most
/// 100 viewers. Each viewer is attempted once per boot; errors never block
/// startup. Successful updates/publications no longer match on later boots.
pub async fn reconcile_dm_visibility(state: &Arc<AppState>) {
    let relay_pubkey = state.relay_keypair.public_key().to_bytes();
    let mut after = None;
    let mut repaired = 0;
    let mut failed = 0;
    loop {
        let batch = match state
            .db
            .dm_visibility_repair_candidates(&relay_pubkey, after.clone(), 100)
            .await
        {
            Ok(batch) => batch,
            Err(error) => {
                warn!(%error, "DM visibility reconciliation query failed");
                break;
            }
        };
        if batch.is_empty() {
            break;
        }
        for viewer in batch {
            after = Some((*viewer.community_id.as_uuid(), viewer.pubkey.clone()));
            let tenant = TenantContext::resolved(viewer.community_id, viewer.host);
            let result = async {
                state
                    .db
                    .unhide_dms_with_new_messages(viewer.community_id, &viewer.pubkey)
                    .await?;
                publish_dm_visibility_snapshot(&tenant, state, &viewer.pubkey).await
            }
            .await;
            match result {
                Ok(()) => repaired += 1,
                Err(error) => {
                    failed += 1;
                    warn!(%error, "DM visibility reconciliation refresh failed");
                }
            }
        }
    }
    info!(repaired, failed, "DM visibility reconciliation finished");
}

#[cfg(test)]
#[path = "dm_visibility_tests.rs"]
mod tests;
