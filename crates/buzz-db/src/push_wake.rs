//! Resolve an opaque provider wake without exposing lease or delivery data.

use buzz_core::CommunityId;
use sqlx::Row;
use uuid::Uuid;

/// The only data a notification can resolve before normal event-read checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeTarget {
    /// The source event; content must be read through the usual authorization.
    pub event_id: Vec<u8>,
    /// Destination channel, absent for channel-less events.
    pub channel_id: Option<Uuid>,
}

impl crate::Db {
    /// Resolve only the caller's wake in the server-bound community. Revoked,
    /// disabled or expired leases and deleted events have the same absent result.
    /// Delivery expiry is deliberately not a read expiry: tapping an older
    /// delivered notification still works while the lease and event remain valid.
    pub async fn resolve_push_wake(
        &self,
        community: CommunityId,
        author: &[u8],
        wake_id: Uuid,
    ) -> crate::error::Result<Option<WakeTarget>> {
        let row = sqlx::query(
            "SELECT e.id AS event_id, e.channel_id \
             FROM push_wake_outbox o \
             JOIN push_leases l ON l.community_id=o.community_id \
               AND l.author=o.author AND l.installation_id=o.installation_id \
             JOIN events e ON e.community_id=o.community_id AND e.id=o.event_id \
             WHERE o.community_id=$1 AND o.author=$2 AND o.id=$3 \
               AND o.state IN ('sending','delivered') \
               AND l.active AND l.endpoint_enabled \
               AND l.expires_at > EXTRACT(EPOCH FROM now())::bigint \
               AND e.deleted_at IS NULL LIMIT 1",
        )
        .bind(community.as_uuid())
        .bind(author)
        .bind(wake_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(WakeTarget {
                event_id: row.try_get("event_id")?,
                channel_id: row.try_get("channel_id")?,
            })
        })
        .transpose()
    }
}
