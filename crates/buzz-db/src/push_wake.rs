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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires isolated Postgres via BUZZ_TEST_DATABASE_URL"]
    async fn wake_lookup_enforces_tenant_author_lease_delivery_and_deletion() {
        let url = std::env::var("BUZZ_TEST_DATABASE_URL").expect("explicit test database");
        let pool = sqlx::PgPool::connect(&url).await.expect("test database");
        crate::migration::run_migrations(&pool)
            .await
            .expect("migrations");
        let db = crate::Db::from_pool(pool.clone());
        let tenant = Uuid::new_v4();
        let other_tenant = Uuid::new_v4();
        for id in [tenant, other_tenant] {
            sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
                .bind(id)
                .bind(format!("wake-qa-{id}.invalid"))
                .execute(&pool)
                .await
                .expect("tenant");
        }
        let author = [17_u8; 32];
        let event_id = [18_u8; 32];
        let wake = Uuid::new_v4();
        sqlx::query("INSERT INTO events (community_id,id,pubkey,created_at,kind,tags,content,sig) VALUES ($1,$2,$3,now(),9,'[]','private content',$4)")
            .bind(tenant).bind(event_id).bind(author).bind([0_u8; 64]).execute(&pool).await.expect("event");
        sqlx::query("INSERT INTO push_leases (community_id,author,installation_id,source_event_id,source_created_at,generation,active,app_profile,endpoint_hash,endpoint_grant,max_class,subscriptions,expires_at) VALUES ($1,$2,'qa-install',$3,1,1,true,'buzz-capacitor-ios-sandbox',$4,'grant','default','[]',9223372036854775806)")
            .bind(tenant).bind(author).bind([19_u8; 32]).bind([20_u8; 32]).execute(&pool).await.expect("lease");
        // Delivery expiry is intentionally past: a delivered notification remains tappable.
        sqlx::query("INSERT INTO push_wake_outbox (community_id,id,author,installation_id,lease_generation,endpoint_hash,event_id,class,expires_at,state) VALUES ($1,$2,$3,'qa-install',1,$4,$5,'default',1,'delivered')")
            .bind(tenant).bind(wake).bind(author).bind([20_u8; 32]).bind(event_id).execute(&pool).await.expect("wake");
        let community = CommunityId::from_uuid(tenant);
        assert_eq!(
            db.resolve_push_wake(community, &author, wake)
                .await
                .unwrap(),
            Some(WakeTarget {
                event_id: event_id.to_vec(),
                channel_id: None
            })
        );
        assert_eq!(
            db.resolve_push_wake(community, &[99_u8; 32], wake)
                .await
                .unwrap(),
            None,
            "another author must not resolve a guessed wake"
        );
        assert_eq!(
            db.resolve_push_wake(CommunityId::from_uuid(other_tenant), &author, wake)
                .await
                .unwrap(),
            None,
            "another community must not resolve the wake"
        );
        assert_eq!(
            db.resolve_push_wake(community, &author, Uuid::new_v4())
                .await
                .unwrap(),
            None
        );
        for (state, visible) in [
            ("pending", false),
            ("sending", true),
            ("failed", false),
            ("delivered", true),
        ] {
            sqlx::query("UPDATE push_wake_outbox SET state=$1 WHERE community_id=$2 AND id=$3")
                .bind(state)
                .bind(tenant)
                .bind(wake)
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(
                db.resolve_push_wake(community, &author, wake)
                    .await
                    .unwrap()
                    .is_some(),
                visible,
                "delivery state {state}"
            );
        }
        sqlx::query("UPDATE push_leases SET endpoint_enabled=false WHERE community_id=$1")
            .bind(tenant)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            db.resolve_push_wake(community, &author, wake)
                .await
                .unwrap(),
            None,
            "disabled endpoint"
        );
        sqlx::query(
            "UPDATE push_leases SET endpoint_enabled=true,expires_at=1 WHERE community_id=$1",
        )
        .bind(tenant)
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            db.resolve_push_wake(community, &author, wake)
                .await
                .unwrap(),
            None,
            "expired lease"
        );
        sqlx::query("UPDATE push_leases SET expires_at=9223372036854775806 WHERE community_id=$1")
            .bind(tenant)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE events SET deleted_at=now() WHERE community_id=$1 AND id=$2")
            .bind(tenant)
            .bind(event_id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            db.resolve_push_wake(community, &author, wake)
                .await
                .unwrap(),
            None,
            "deleted source event"
        );
        sqlx::query("UPDATE events SET deleted_at=NULL WHERE community_id=$1 AND id=$2")
            .bind(tenant)
            .bind(event_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE push_leases SET active=false,app_profile=NULL,endpoint_hash=NULL,endpoint_grant=NULL,max_class=NULL,subscriptions=NULL WHERE community_id=$1").bind(tenant).execute(&pool).await.unwrap();
        assert_eq!(
            db.resolve_push_wake(community, &author, wake)
                .await
                .unwrap(),
            None,
            "revoked lease"
        );
    }
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
