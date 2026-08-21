-- Append-only audit trail for relay operator/moderator roster mutations
-- (Phase 2 admin auth: security-review fix).
--
-- PUT/DELETE /operators/{pubkey} mutate the deployment-wide root of trust in
-- place: the upsert overwrites the prior role and grantor, delete removes the
-- only row. Without an audit trail, a grant -> role-change -> revoke sequence
-- leaves the DB holding only the final state -- who granted, elevated, or
-- revoked a principal, and when, is unrecoverable. This table records every
-- roster mutation durably so privilege changes are as auditable as the
-- enforcement actions those principals perform.
--
-- Append-only by construction: written only inside the upsert/delete
-- transactions in crates/buzz-db/src/relay_operators.rs. No UPDATE/DELETE path.
--
-- Global (no community_id): mirrors relay_operators -- operators span all
-- tenants. Registered in _operator_global_tables and in the hardcoded parser
-- list in crates/buzz-db/src/migration.rs.

CREATE TABLE relay_operator_audit (
    id            UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Principal who performed the mutation (the authenticated operator).
    actor_pubkey  BYTEA NOT NULL CHECK (length(actor_pubkey) = 32),
    -- Principal whose roster entry changed.
    target_pubkey BYTEA NOT NULL CHECK (length(target_pubkey) = 32),
    -- 'grant' (PUT upsert) | 'revoke' (DELETE).
    op            TEXT NOT NULL CHECK (op IN ('grant', 'revoke')),
    -- Role before the mutation; NULL when the target had no prior row.
    prev_role     TEXT CHECK (prev_role IN ('operator', 'moderator')),
    -- Role after the mutation; NULL for a revoke.
    new_role      TEXT CHECK (new_role IN ('operator', 'moderator')),
    -- Insertion time, NOT transaction-start time. `now()` freezes at BEGIN, so
    -- an early-starting-but-late-committing txn would stamp a mutation with a
    -- timestamp that precedes an already-committed later one, letting
    -- `ORDER BY created_at` report an impossible privilege chain (e.g. revoke
    -- before grant). Every same-target mutation writes its audit row while
    -- holding the serializing lock (advisory lock in `upsert`, row lock via
    -- `DELETE ... RETURNING` in `remove`) and the competitor cannot proceed
    -- until commit, so insertion time under the lock is strictly monotonic with
    -- the true privilege chain.
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Structural total-order key. Wall-clock uniqueness is not a contract
    -- (clock_timestamp() can repeat), so ordered reads break ties on this
    -- lock-monotonic identity: `ORDER BY (created_at, seq)` is a strict total
    -- order matching the serialized mutation sequence.
    seq           BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE INDEX idx_relay_operator_audit_target
    ON relay_operator_audit (target_pubkey, created_at, seq);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('relay_operator_audit',
     'deployment-global append-only roster mutation audit trail; no community_id intentionally');
