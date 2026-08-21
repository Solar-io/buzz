//! Deployment-global relay operator/moderator roster persistence.
//!
//! Backs the `relay_operators` table from `migrations/0032_relay_operators.sql`.
//!
//! Config-backed operators (`RELAY_OPERATOR_PUBKEYS`, owner-fallback) are
//! resolved at request time in the relay — this module only handles DB rows.
//! Config outranks DB: a DB moderator row for a config-backed Operator is
//! never returned as authoritative; that check happens at the relay layer.
//!
//! Lane ownership: relay admin API (Duncan).

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row as _};

use crate::error::Result;

/// A row in `relay_operators`.
#[derive(Debug, Clone)]
pub struct RelayOperatorRecord {
    /// 32-byte pubkey (binary).
    pub pubkey: Vec<u8>,
    /// `"operator"` | `"moderator"`.
    pub role: String,
    /// Pubkey of the operator who added this entry (32 bytes binary).
    pub added_by: Vec<u8>,
    /// Row creation timestamp.
    pub created_at: DateTime<Utc>,
}

/// Insert or update a relay operator/moderator DB row, recording the mutation
/// in the append-only `relay_operator_audit` trail within the same transaction.
///
/// If the pubkey already exists, updates the role and added_by atomically. The
/// pre-image (`prev_role`) is read under the transaction so the audit row
/// captures the role the upsert overwrites.
pub async fn upsert(pool: &PgPool, pubkey: &[u8], role: &str, added_by: &[u8]) -> Result<()> {
    let mut tx = pool.begin().await?;

    // Pre-image read inside the transaction: the role the upsert overwrites,
    // or NULL when the target has no prior row.
    let prev_role: Option<String> =
        sqlx::query_scalar("SELECT role FROM relay_operators WHERE pubkey = $1 FOR UPDATE")
            .bind(pubkey)
            .fetch_optional(&mut *tx)
            .await?;

    sqlx::query(
        r#"
        INSERT INTO relay_operators (pubkey, role, added_by)
        VALUES ($1, $2, $3)
        ON CONFLICT (pubkey) DO UPDATE SET
            role = EXCLUDED.role,
            added_by = EXCLUDED.added_by
        "#,
    )
    .bind(pubkey)
    .bind(role)
    .bind(added_by)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO relay_operator_audit
            (actor_pubkey, target_pubkey, op, prev_role, new_role)
        VALUES ($1, $2, 'grant', $3, $4)
        "#,
    )
    .bind(added_by)
    .bind(pubkey)
    .bind(prev_role.as_deref())
    .bind(role)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Remove a relay operator/moderator DB row, recording the revocation in the
/// append-only `relay_operator_audit` trail within the same transaction.
///
/// Returns `true` if a row was deleted (and audited), `false` if the pubkey was
/// not found (idempotent no-op; no audit row is written).
pub async fn remove(pool: &PgPool, pubkey: &[u8], actor: &[u8]) -> Result<bool> {
    let mut tx = pool.begin().await?;

    // Capture the pre-image role the delete removes; also gates the audit row
    // so a no-op delete of an absent pubkey writes nothing.
    let prev_role: Option<String> =
        sqlx::query_scalar("DELETE FROM relay_operators WHERE pubkey = $1 RETURNING role")
            .bind(pubkey)
            .fetch_optional(&mut *tx)
            .await?;

    let removed = prev_role.is_some();
    if removed {
        sqlx::query(
            r#"
            INSERT INTO relay_operator_audit
                (actor_pubkey, target_pubkey, op, prev_role, new_role)
            VALUES ($1, $2, 'revoke', $3, NULL)
            "#,
        )
        .bind(actor)
        .bind(pubkey)
        .bind(prev_role.as_deref())
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(removed)
}

/// Fetch one relay operator/moderator row by pubkey.
pub async fn get(pool: &PgPool, pubkey: &[u8]) -> Result<Option<RelayOperatorRecord>> {
    let row = sqlx::query(
        "SELECT pubkey, role, added_by, created_at FROM relay_operators WHERE pubkey = $1",
    )
    .bind(pubkey)
    .fetch_optional(pool)
    .await?;

    row.map(
        |r| -> std::result::Result<RelayOperatorRecord, sqlx::Error> {
            Ok(RelayOperatorRecord {
                pubkey: r.try_get("pubkey")?,
                role: r.try_get("role")?,
                added_by: r.try_get("added_by")?,
                created_at: r.try_get("created_at")?,
            })
        },
    )
    .transpose()
    .map_err(crate::error::DbError::from)
}

/// List all relay operator/moderator rows, ordered by creation time.
pub async fn list(pool: &PgPool) -> Result<Vec<RelayOperatorRecord>> {
    let rows = sqlx::query(
        "SELECT pubkey, role, added_by, created_at FROM relay_operators ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(
            |r| -> std::result::Result<RelayOperatorRecord, sqlx::Error> {
                Ok(RelayOperatorRecord {
                    pubkey: r.try_get("pubkey")?,
                    role: r.try_get("role")?,
                    added_by: r.try_get("added_by")?,
                    created_at: r.try_get("created_at")?,
                })
            },
        )
        .collect::<std::result::Result<Vec<_>, sqlx::Error>>()
        .map_err(crate::error::DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1

    async fn setup_pool() -> PgPool {
        let url =
            std::env::var("BUZZ_TEST_DATABASE_URL").unwrap_or_else(|_| TEST_DB_URL.to_string());
        PgPool::connect(&url).await.expect("connect to test DB")
    }

    /// One audit row per mutation, capturing the pre-image role across a
    /// grant → role-change → revoke sequence — the history the in-place
    /// upsert/delete would otherwise destroy.
    #[tokio::test]
    #[ignore = "requires Postgres — roster audit trail across grant/change/revoke"]
    async fn roster_mutations_write_pre_image_audit_rows() {
        let pool = setup_pool().await;
        let actor = vec![7u8; 32];
        let target: Vec<u8> = {
            let id = uuid::Uuid::new_v4();
            id.as_bytes().iter().chain(id.as_bytes()).copied().collect()
        };

        async fn audit_rows(
            pool: &PgPool,
            target: &[u8],
        ) -> Vec<(String, Option<String>, Option<String>)> {
            sqlx::query_as(
                "SELECT op, prev_role, new_role FROM relay_operator_audit \
                 WHERE target_pubkey = $1 ORDER BY created_at ASC",
            )
            .bind(target)
            .fetch_all(pool)
            .await
            .expect("read audit rows")
        }

        // Grant moderator: no prior row → prev_role NULL, new_role moderator.
        upsert(&pool, &target, "moderator", &actor)
            .await
            .expect("grant");
        // Elevate to operator: prev_role moderator, new_role operator.
        upsert(&pool, &target, "operator", &actor)
            .await
            .expect("elevate");
        // Revoke: prev_role operator, new_role NULL.
        assert!(remove(&pool, &target, &actor).await.expect("revoke"));
        // Idempotent no-op revoke writes no audit row.
        assert!(!remove(&pool, &target, &actor).await.expect("no-op revoke"));

        let rows = audit_rows(&pool, &target).await;
        assert_eq!(
            rows,
            vec![
                ("grant".to_string(), None, Some("moderator".to_string())),
                (
                    "grant".to_string(),
                    Some("moderator".to_string()),
                    Some("operator".to_string())
                ),
                ("revoke".to_string(), Some("operator".to_string()), None),
            ],
            "audit trail must record pre-image on every mutation and nothing for the no-op delete"
        );

        // Cleanup: the audit trail is append-only, so remove test rows directly.
        sqlx::query("DELETE FROM relay_operator_audit WHERE target_pubkey = $1")
            .bind(&target)
            .execute(&pool)
            .await
            .expect("cleanup audit rows");
    }
}
