//! Direct message channel persistence.
//!
//! DMs are channels with channel_type='dm' and visibility='private'.
//! Participant sets are immutable -- adding a member creates a NEW DM.

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::channel::ChannelRecord;
use crate::error::{DbError, Result};
use buzz_core::kind::{KIND_DM_VISIBILITY, KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2};
use buzz_core::CommunityId;

// -- Public structs -----------------------------------------------------------

/// A DM conversation with its participant list.
#[derive(Debug, Clone)]
pub struct DmRecord {
    /// The underlying channel ID.
    pub channel_id: Uuid,
    /// All active participants in this DM.
    pub participants: Vec<DmParticipant>,
    /// When the last message was sent (approximated by channel updated_at).
    pub last_message_at: Option<DateTime<Utc>>,
    /// When the DM was created.
    pub created_at: DateTime<Utc>,
}

/// A single participant in a DM.
#[derive(Debug, Clone)]
pub struct DmParticipant {
    /// Compressed public key bytes.
    pub pubkey: Vec<u8>,
    /// Optional display name from the users table.
    pub display_name: Option<String>,
    /// Member role string (always "member" for DMs).
    pub role: String,
}

/// A viewer whose DM hide state or published snapshot needs startup repair.
#[derive(Debug)]
pub struct DmVisibilityRepair {
    /// Community owning the membership and snapshot.
    pub community_id: CommunityId,
    /// Server-resolved host used to bind the repair's tenant.
    pub host: String,
    /// Viewer whose full NIP-DV snapshot must be refreshed.
    pub pubkey: Vec<u8>,
}

// -- Pure helpers -------------------------------------------------------------

/// Compute a stable SHA-256 fingerprint for a set of participant pubkeys.
///
/// Pubkeys are sorted lexicographically before hashing so that the same set
/// of participants always produces the same hash regardless of input order.
/// No separator is used because all pubkeys are fixed-width 32-byte values.
pub fn compute_participant_hash(pubkeys: &[&[u8]]) -> [u8; 32] {
    let mut sorted: Vec<&[u8]> = pubkeys.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    let mut hasher = Sha256::new();
    for pk in sorted {
        hasher.update(pk);
    }
    hasher.finalize().into()
}

// -- DB functions -------------------------------------------------------------

/// Find an existing DM by its participant hash.
///
/// Returns `None` if no matching DM exists or if it has been deleted.
pub async fn find_dm_by_participants(
    pool: &PgPool,
    community_id: CommunityId,
    participant_hash: &[u8],
) -> Result<Option<ChannelRecord>> {
    let row = sqlx::query(
        r#"
        SELECT id, name, channel_type::text AS channel_type, visibility::text AS visibility,
               description, canvas,
               created_by, created_at, updated_at, archived_at, deleted_at,
               nip29_group_id, topic_required, max_members,
               topic, topic_set_by, topic_set_at,
               purpose, purpose_set_by, purpose_set_at
        FROM channels
        WHERE community_id = $1
          AND participant_hash = $2
          AND channel_type = 'dm'
          AND deleted_at IS NULL
        LIMIT 1
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(participant_hash)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_channel_record).transpose()
}

/// Create a new DM channel for the given participant pubkeys, or return the
/// existing one if a DM with the same participant set already exists.
///
/// Rules:
/// - `participants` must contain 2-9 entries (enforced here).
/// - `created_by` must be one of the participants.
/// - The operation is idempotent: same participant set -> same channel returned.
pub async fn create_dm(
    pool: &PgPool,
    community_id: CommunityId,
    participants: &[&[u8]],
    created_by: &[u8],
) -> Result<ChannelRecord> {
    if participants.len() < 2 {
        return Err(DbError::InvalidData(
            "DM requires at least 2 participants".to_string(),
        ));
    }
    if participants.len() > 9 {
        return Err(DbError::InvalidData(
            "DM supports at most 9 participants".to_string(),
        ));
    }
    for pk in participants {
        if pk.len() != 32 {
            return Err(DbError::InvalidData(format!(
                "pubkey must be 32 bytes, got {}",
                pk.len()
            )));
        }
    }

    let hash = compute_participant_hash(participants);

    let mut tx = pool.begin().await?;

    // Idempotency check inside the transaction.
    let existing = sqlx::query(
        r#"
        SELECT id, name, channel_type::text AS channel_type, visibility::text AS visibility,
               description, canvas,
               created_by, created_at, updated_at, archived_at, deleted_at,
               nip29_group_id, topic_required, max_members,
               topic, topic_set_by, topic_set_at,
               purpose, purpose_set_by, purpose_set_at
        FROM channels
        WHERE community_id = $1
          AND participant_hash = $2
          AND channel_type = 'dm'
          AND deleted_at IS NULL
        LIMIT 1
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(hash.as_slice())
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(row) = existing {
        tx.commit().await?;
        return row_to_channel_record(row);
    }

    // Name the DM based on participant count.
    let name = if participants.len() == 2 {
        "DM".to_string()
    } else {
        format!("Group DM ({})", participants.len())
    };

    let id = Uuid::new_v4();

    sqlx::query(
        r#"
        INSERT INTO channels
            (id, community_id, name, channel_type, visibility, created_by, participant_hash)
        VALUES ($1, $2, $3, 'dm', 'private', $4, $5)
        "#,
    )
    .bind(id)
    .bind(community_id.as_uuid())
    .bind(&name)
    .bind(created_by)
    .bind(hash.as_slice())
    .execute(&mut *tx)
    .await?;

    // Add all participants as members with role='member'.
    for pk in participants {
        sqlx::query(
            r#"
            INSERT INTO channel_members (community_id, channel_id, pubkey, role, invited_by)
            VALUES ($1, $2, $3, 'member', $4)
            ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
                removed_at = NULL,
                removed_by = NULL,
                role = EXCLUDED.role
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(id)
        .bind(*pk)
        .bind(created_by)
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query(
        r#"
        SELECT id, name, channel_type::text AS channel_type, visibility::text AS visibility,
               description, canvas,
               created_by, created_at, updated_at, archived_at, deleted_at,
               nip29_group_id, topic_required, max_members,
               topic, topic_set_by, topic_set_at,
               purpose, purpose_set_by, purpose_set_at
        FROM channels WHERE community_id = $1 AND id = $2
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    let record = row_to_channel_record(row)?;
    tx.commit().await?;
    Ok(record)
}

/// List all DM conversations for a given user, ordered by most recent activity.
///
/// Includes participant details for each DM. Supports cursor-based pagination
/// using `updated_at` ordering.
pub async fn list_dms_for_user(
    pool: &PgPool,
    community_id: CommunityId,
    pubkey: &[u8],
    limit: u32,
    cursor: Option<Uuid>,
) -> Result<Vec<DmRecord>> {
    let limit = limit.min(200) as i64;

    // Resolve cursor to a timestamp for keyset pagination.
    let cursor_ts: Option<DateTime<Utc>> = if let Some(cid) = cursor {
        let row =
            sqlx::query("SELECT updated_at FROM channels WHERE community_id = $1 AND id = $2")
                .bind(community_id.as_uuid())
                .bind(cid)
                .fetch_optional(pool)
                .await?;
        row.map(|r| r.try_get::<DateTime<Utc>, _>("updated_at"))
            .transpose()?
    } else {
        None
    };

    // Fetch DM channel IDs where this user is an active member.
    let channel_rows = if let Some(ts) = cursor_ts {
        sqlx::query(
            r#"
            SELECT c.id, c.created_at, c.updated_at
            FROM channels c
            JOIN channel_members cm
                ON c.community_id = cm.community_id
               AND c.id = cm.channel_id
               AND cm.pubkey = $2
               AND cm.removed_at IS NULL
               AND cm.hidden_at IS NULL
            WHERE c.community_id = $1
              AND c.channel_type = 'dm'
              AND c.deleted_at IS NULL
              AND c.updated_at < $3
            ORDER BY c.updated_at DESC
            LIMIT $4
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(pubkey)
        .bind(ts)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT c.id, c.created_at, c.updated_at
            FROM channels c
            JOIN channel_members cm
                ON c.community_id = cm.community_id
               AND c.id = cm.channel_id
               AND cm.pubkey = $2
               AND cm.removed_at IS NULL
               AND cm.hidden_at IS NULL
            WHERE c.community_id = $1
              AND c.channel_type = 'dm'
              AND c.deleted_at IS NULL
            ORDER BY c.updated_at DESC
            LIMIT $3
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(pubkey)
        .bind(limit)
        .fetch_all(pool)
        .await?
    };

    let mut results = Vec::with_capacity(channel_rows.len());

    for row in channel_rows {
        let channel_id: Uuid = row.try_get("id")?;
        let created_at: DateTime<Utc> = row.try_get("created_at")?;
        let updated_at: DateTime<Utc> = row.try_get("updated_at")?;

        // Fetch participants for this DM.
        let member_rows = sqlx::query(
            r#"
            SELECT cm.pubkey, cm.role::text AS role, u.display_name
            FROM channel_members cm
            LEFT JOIN users u
              ON u.community_id = cm.community_id
             AND u.pubkey = cm.pubkey
            WHERE cm.community_id = $1
              AND cm.channel_id = $2
              AND cm.removed_at IS NULL
            ORDER BY cm.joined_at ASC
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(channel_id)
        .fetch_all(pool)
        .await?;

        let participants: Vec<DmParticipant> = member_rows
            .into_iter()
            .map(|r| -> Result<DmParticipant> {
                Ok(DmParticipant {
                    pubkey: r.try_get("pubkey")?,
                    display_name: r.try_get("display_name")?,
                    role: r.try_get("role")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        results.push(DmRecord {
            channel_id,
            participants,
            last_message_at: Some(updated_at),
            created_at,
        });
    }

    Ok(results)
}

/// Open or retrieve a DM for the given set of participants.
///
/// `created_by` is automatically added to `pubkeys` if not already present,
/// ensuring the caller is always a participant in their own DM.
///
/// Returns `(channel, was_created)`:
/// - `was_created = true`  -- a new DM was created.
/// - `was_created = false` -- an existing DM was returned.
pub async fn open_dm(
    pool: &PgPool,
    community_id: CommunityId,
    pubkeys: &[&[u8]],
    created_by: &[u8],
) -> Result<(ChannelRecord, bool)> {
    // Merge created_by into the participant set (dedup handled by compute_participant_hash).
    let mut all: Vec<&[u8]> = pubkeys.to_vec();
    if !all.contains(&created_by) {
        all.push(created_by);
    }

    // Enforce max before hitting the DB.
    if all.len() > 9 {
        return Err(DbError::InvalidData(
            "DM supports at most 9 participants".to_string(),
        ));
    }

    let hash = compute_participant_hash(&all);

    // Check for existing DM first (fast path, no transaction).
    if let Some(existing) = find_dm_by_participants(pool, community_id, &hash).await? {
        // Clear hidden_at for the caller so the DM reappears in their sidebar.
        unhide_dm(pool, community_id, existing.id, created_by).await?;
        return Ok((existing, false));
    }

    // Create new DM.
    let channel = create_dm(pool, community_id, &all, created_by).await?;

    Ok((channel, true))
}

// -- Hide / unhide ------------------------------------------------------------

/// Clear hides for other active members of a non-deleted DM after a newly
/// accepted chat message. Return only changed viewers; preserve hides made
/// after acceptance, including while this background operation was queued.
pub async fn unhide_dm_recipients(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    sender: &[u8],
    accepted_at: DateTime<Utc>,
) -> Result<Vec<Vec<u8>>> {
    Ok(sqlx::query_scalar(
        r#"
        UPDATE channel_members cm SET hidden_at = NULL
        FROM channels ch
        WHERE cm.community_id = $1 AND cm.channel_id = $2
          AND ch.community_id = cm.community_id AND ch.id = cm.channel_id
          AND ch.channel_type = 'dm' AND ch.deleted_at IS NULL
          AND cm.pubkey <> $3 AND cm.removed_at IS NULL
          AND cm.hidden_at IS NOT NULL AND cm.hidden_at <= $4
        RETURNING cm.pubkey
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(sender)
    .bind(accepted_at)
    .fetch_all(pool)
    .await?)
}

/// Clear this viewer's active DM hides when another participant's stored chat
/// message was created strictly after the hide. Recheck the predicate at the
/// update, so a fresh hide racing startup is preserved. Returns changed IDs.
pub async fn unhide_dms_with_new_messages(
    pool: &PgPool,
    community_id: CommunityId,
    viewer: &[u8],
) -> Result<Vec<Uuid>> {
    Ok(sqlx::query_scalar(
        r#"
        UPDATE channel_members cm SET hidden_at = NULL
        FROM channels ch
        WHERE cm.community_id = $1 AND cm.pubkey = $2
          AND ch.community_id = cm.community_id AND ch.id = cm.channel_id
          AND ch.channel_type = 'dm' AND ch.deleted_at IS NULL
          AND cm.removed_at IS NULL AND cm.hidden_at IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM events e
              WHERE e.community_id = cm.community_id AND e.channel_id = cm.channel_id
                AND e.kind = ANY($3) AND e.pubkey <> cm.pubkey
                AND e.created_at > cm.hidden_at
          )
        RETURNING cm.channel_id
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(viewer)
    .bind([KIND_STREAM_MESSAGE as i32, KIND_STREAM_MESSAGE_V2 as i32].as_slice())
    .fetch_all(pool)
    .await?)
}

/// Page through viewers needing message-based unhide or a stale-snapshot
/// retry. The latter keeps publication failures repairable after the hide
/// has already been cleared. Only the latest snapshot by this relay counts;
/// archived/write-blocked communities and removed/deleted memberships do not.
pub async fn dm_visibility_repair_candidates(
    pool: &PgPool,
    relay_pubkey: &[u8],
    after: Option<(Uuid, Vec<u8>)>,
    limit: i64,
) -> Result<Vec<DmVisibilityRepair>> {
    let rows = sqlx::query(
        r#"
        SELECT DISTINCT cm.community_id, c.host, cm.pubkey
        FROM channel_members cm
        JOIN channels ch ON ch.community_id = cm.community_id AND ch.id = cm.channel_id
        JOIN communities c ON c.id = cm.community_id
        LEFT JOIN LATERAL (
            SELECT e.tags FROM events e
            WHERE e.community_id = cm.community_id AND e.kind = $1
              AND e.pubkey = $2 AND e.d_tag = encode(cm.pubkey, 'hex')
              AND e.deleted_at IS NULL
            ORDER BY e.created_at DESC, e.id ASC LIMIT 1
        ) latest ON true
        WHERE ch.channel_type = 'dm' AND ch.deleted_at IS NULL AND cm.removed_at IS NULL
          AND c.archived_at IS NULL AND community_write_allowed(cm.community_id)
          AND ($3::uuid IS NULL OR (cm.community_id, cm.pubkey) > ($3, $4::bytea))
          AND (
              (cm.hidden_at IS NOT NULL AND EXISTS (
                  SELECT 1 FROM events e
                  WHERE e.community_id = cm.community_id AND e.channel_id = cm.channel_id
                    AND e.kind = ANY($5) AND e.pubkey <> cm.pubkey
                    AND e.created_at > cm.hidden_at
              ))
              OR (cm.hidden_at IS NULL AND latest.tags @>
                  jsonb_build_array(jsonb_build_array('h', cm.channel_id::text)))
          )
        ORDER BY cm.community_id, cm.pubkey LIMIT $6
        "#,
    )
    .bind(KIND_DM_VISIBILITY as i32)
    .bind(relay_pubkey)
    .bind(after.as_ref().map(|cursor| cursor.0))
    .bind(after.as_ref().map(|cursor| cursor.1.as_slice()))
    .bind([KIND_STREAM_MESSAGE as i32, KIND_STREAM_MESSAGE_V2 as i32].as_slice())
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(DmVisibilityRepair {
                community_id: CommunityId::from_uuid(row.try_get("community_id")?),
                host: row.try_get("host")?,
                pubkey: row.try_get("pubkey")?,
            })
        })
        .collect()
}

/// Hide a DM for a specific user by setting `hidden_at = NOW()`.
///
/// The DM is not deleted — it can be restored by opening a new DM with the
/// same participants (which clears `hidden_at`). Returns an error if the user
/// is not an active member of the channel.
pub async fn hide_dm(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
) -> Result<()> {
    let result = sqlx::query(
        r#"
        UPDATE channel_members
        SET hidden_at = NOW()
        WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 AND removed_at IS NULL
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(DbError::NotFound(format!(
            "no active membership for channel {channel_id}"
        )));
    }

    Ok(())
}

/// Unhide a DM for a specific user by clearing `hidden_at`.
///
/// This is called automatically when a user re-opens a DM via [`open_dm`].
/// It is a no-op if the membership is not currently hidden.
pub async fn unhide_dm(
    pool: &PgPool,
    community_id: CommunityId,
    channel_id: Uuid,
    pubkey: &[u8],
) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE channel_members
        SET hidden_at = NULL
        WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 AND removed_at IS NULL
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(channel_id)
    .bind(pubkey)
    .execute(pool)
    .await?;

    Ok(())
}

/// Return the channel IDs of all DMs the given user currently has hidden
/// (`hidden_at IS NOT NULL`) while still being an active member. Used to build
/// the relay-signed NIP-DV visibility snapshot.
pub async fn list_hidden_dms(
    pool: &PgPool,
    community_id: CommunityId,
    pubkey: &[u8],
) -> Result<Vec<Uuid>> {
    let rows = sqlx::query(
        r#"
        SELECT cm.channel_id
        FROM channel_members cm
        JOIN channels c
          ON c.community_id = cm.community_id
         AND c.id = cm.channel_id
        WHERE cm.community_id = $1
          AND cm.pubkey = $2
          AND cm.removed_at IS NULL
          AND cm.hidden_at IS NOT NULL
          AND c.channel_type = 'dm'
          AND c.deleted_at IS NULL
        ORDER BY cm.channel_id
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(pubkey)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|r| r.try_get::<Uuid, _>("channel_id").map_err(Into::into))
        .collect()
}

// -- Row mapping --------------------------------------------------------------

fn row_to_channel_record(row: sqlx::postgres::PgRow) -> Result<ChannelRecord> {
    let id: Uuid = row.try_get("id")?;
    let topic_required: bool = row.try_get("topic_required")?;

    Ok(ChannelRecord {
        id,
        name: row.try_get("name")?,
        channel_type: row.try_get("channel_type")?,
        visibility: row.try_get("visibility")?,
        description: row.try_get("description")?,
        canvas: row.try_get("canvas")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        archived_at: row.try_get("archived_at")?,
        deleted_at: row.try_get("deleted_at")?,
        nip29_group_id: row.try_get("nip29_group_id")?,
        topic_required,
        max_members: row.try_get("max_members")?,
        topic: row.try_get("topic").unwrap_or(None),
        topic_set_by: row.try_get("topic_set_by").unwrap_or(None),
        topic_set_at: row.try_get("topic_set_at").unwrap_or(None),
        purpose: row.try_get("purpose").unwrap_or(None),
        purpose_set_by: row.try_get("purpose_set_by").unwrap_or(None),
        purpose_set_at: row.try_get("purpose_set_at").unwrap_or(None),
        ttl_seconds: row.try_get("ttl_seconds").unwrap_or(None),
        ttl_deadline: row.try_get("ttl_deadline").unwrap_or(None),
    })
}

// -- Tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn participant_hash_is_order_independent() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let h1 = compute_participant_hash(&[&a, &b]);
        let h2 = compute_participant_hash(&[&b, &a]);
        assert_eq!(h1, h2, "hash must be the same regardless of input order");
    }

    #[test]
    fn participant_hash_deduplicates() {
        let a = [1u8; 32];
        let h1 = compute_participant_hash(&[&a, &a]);
        let h2 = compute_participant_hash(&[&a]);
        assert_eq!(h1, h2, "duplicate pubkeys should be deduped before hashing");
    }

    #[test]
    fn participant_hash_differs_for_different_sets() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];
        let h_ab = compute_participant_hash(&[&a, &b]);
        let h_ac = compute_participant_hash(&[&a, &c]);
        assert_ne!(h_ab, h_ac);
    }

    #[test]
    fn participant_hash_returns_32_bytes() {
        let a = [0u8; 32];
        let b = [255u8; 32];
        let h = compute_participant_hash(&[&a, &b]);
        assert_eq!(h.len(), 32);
    }

    async fn test_community(pool: &PgPool) -> CommunityId {
        crate::migration::run_migrations(pool).await.unwrap();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("dm-db-{id}.example"))
            .execute(pool)
            .await
            .unwrap();
        CommunityId::from_uuid(id)
    }

    #[sqlx::test(migrations = false)]
    #[ignore = "requires Postgres"]
    async fn unhide_recipients_preserves_sender_removed_new_hides_streams_and_tenants(
        pool: PgPool,
    ) {
        let community = test_community(&pool).await;
        let sender = [1; 32];
        let peer = [2; 32];
        let removed = [3; 32];
        let later_hide = [4; 32];
        let dm = create_dm(
            &pool,
            community,
            &[&sender, &peer, &removed, &later_hide],
            &sender,
        )
        .await
        .unwrap();
        sqlx::query("UPDATE channel_members SET hidden_at = NOW() - INTERVAL '1 minute' WHERE community_id = $1 AND channel_id = $2")
            .bind(community.as_uuid()).bind(dm.id).execute(&pool).await.unwrap();
        sqlx::query("UPDATE channel_members SET removed_at = NOW() WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3")
            .bind(community.as_uuid()).bind(dm.id).bind(removed.as_slice()).execute(&pool).await.unwrap();
        let accepted_at = Utc::now();
        sqlx::query("UPDATE channel_members SET hidden_at = $4 WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3")
            .bind(community.as_uuid()).bind(dm.id).bind(later_hide.as_slice()).bind(accepted_at + chrono::Duration::seconds(1)).execute(&pool).await.unwrap();
        assert!(unhide_dm_recipients(
            &pool,
            CommunityId::from_uuid(Uuid::new_v4()),
            dm.id,
            &sender,
            accepted_at
        )
        .await
        .unwrap()
        .is_empty());
        assert_eq!(
            unhide_dm_recipients(&pool, community, dm.id, &sender, accepted_at)
                .await
                .unwrap(),
            vec![peer.to_vec()]
        );
        let remaining: Vec<Vec<u8>> = sqlx::query_scalar("SELECT pubkey FROM channel_members WHERE community_id = $1 AND channel_id = $2 AND hidden_at IS NOT NULL ORDER BY pubkey")
            .bind(community.as_uuid()).bind(dm.id).fetch_all(&pool).await.unwrap();
        assert_eq!(
            remaining,
            vec![sender.to_vec(), removed.to_vec(), later_hide.to_vec()]
        );
        assert!(
            unhide_dm_recipients(&pool, community, dm.id, &sender, accepted_at)
                .await
                .unwrap()
                .is_empty()
        );
        // The SQL itself must defend against a stale/wrong channel type hint.
        sqlx::query(
            "UPDATE channels SET channel_type = 'stream' WHERE community_id = $1 AND id = $2",
        )
        .bind(community.as_uuid())
        .bind(dm.id)
        .execute(&pool)
        .await
        .unwrap();
        assert!(unhide_dm_recipients(
            &pool,
            community,
            dm.id,
            &peer,
            Utc::now() + chrono::Duration::seconds(2)
        )
        .await
        .unwrap()
        .is_empty());
    }

    #[sqlx::test(migrations = false)]
    #[ignore = "requires Postgres"]
    async fn backfill_only_new_peer_chat_in_active_dms_and_is_idempotent(pool: PgPool) {
        use nostr::{EventBuilder, Keys, Kind, Timestamp};
        let community = test_community(&pool).await;
        let viewer = Keys::generate();
        let viewer_pk = viewer.public_key().to_bytes();
        let db = crate::Db::from_pool(pool.clone());
        let hide_secs = Timestamp::now().as_secs() - 120;
        let hidden_at = DateTime::from_timestamp(hide_secs as i64, 0).unwrap();
        let mut expected = Vec::new();
        let mut preserved = Vec::new();
        for (i, kind) in [
            9, 40002, 7, 40003, 9005, 5, 9000, 44100, 40099, 9, 9, 9, 9, 9, 9, 9,
        ]
        .into_iter()
        .enumerate()
        {
            let sender = Keys::generate();
            let dm = create_dm(
                &pool,
                community,
                &[&viewer_pk, &sender.public_key().to_bytes()],
                &viewer_pk,
            )
            .await
            .unwrap();
            sqlx::query("UPDATE channel_members SET hidden_at = $4 WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3")
                .bind(community.as_uuid()).bind(dm.id).bind(viewer_pk.as_slice()).bind(hidden_at).execute(&pool).await.unwrap();
            let signer = if i == 9 { &viewer } else { &sender };
            let secs = match i {
                10 => hide_secs - 1,
                11 => hide_secs,
                _ => hide_secs + 1,
            };
            let msg = EventBuilder::new(Kind::Custom(kind), "backfill fixture")
                .custom_created_at(Timestamp::from(secs))
                .sign_with_keys(signer)
                .unwrap();
            db.insert_event(community, &msg, Some(dm.id)).await.unwrap();
            match i {
                12 => {
                    sqlx::query("UPDATE channels SET channel_type = 'stream' WHERE community_id = $1 AND id = $2").bind(community.as_uuid()).bind(dm.id).execute(&pool).await.unwrap();
                }
                13 => {
                    sqlx::query("UPDATE channel_members SET removed_at = NOW() WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3").bind(community.as_uuid()).bind(dm.id).bind(viewer_pk.as_slice()).execute(&pool).await.unwrap();
                }
                14 => {
                    sqlx::query("UPDATE channels SET deleted_at = NOW() WHERE community_id = $1 AND id = $2").bind(community.as_uuid()).bind(dm.id).execute(&pool).await.unwrap();
                }
                15 => {
                    sqlx::query(
                        "UPDATE events SET deleted_at = NOW() WHERE community_id = $1 AND id = $2",
                    )
                    .bind(community.as_uuid())
                    .bind(msg.id.as_bytes().as_slice())
                    .execute(&pool)
                    .await
                    .unwrap();
                }
                _ => {}
            }
            if i < 2 || i == 15 {
                expected.push(dm.id);
            } else {
                preserved.push(dm.id);
            }
        }
        let relay = Keys::generate();
        let candidates =
            dm_visibility_repair_candidates(&pool, &relay.public_key().to_bytes(), None, 100)
                .await
                .unwrap();
        assert_eq!(candidates.len(), 1, "deduplicate viewers across DMs");
        assert_eq!(candidates[0].pubkey, viewer_pk);
        assert_eq!(candidates[0].community_id, community);
        let mut changed = unhide_dms_with_new_messages(&pool, community, &viewer_pk)
            .await
            .unwrap();
        changed.sort();
        expected.sort();
        assert_eq!(
            changed, expected,
            "only the two chat kinds after the hide qualify"
        );
        for dm in preserved {
            let hidden: bool = sqlx::query_scalar("SELECT hidden_at IS NOT NULL FROM channel_members WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3")
                .bind(community.as_uuid()).bind(dm).bind(viewer_pk.as_slice()).fetch_one(&pool).await.unwrap();
            assert!(hidden, "excluded fixture {dm} must keep its hide");
        }
        assert!(unhide_dms_with_new_messages(&pool, community, &viewer_pk)
            .await
            .unwrap()
            .is_empty());
        assert!(
            dm_visibility_repair_candidates(&pool, &relay.public_key().to_bytes(), None, 100)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
