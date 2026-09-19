use buzz_push_gateway::{
    authority::{AuthorityStore, NewInstallation},
    model::AppProfile,
    postgres::PostgresAuthorityStore,
};
use sqlx::{postgres::PgPoolOptions, AssertSqlSafe};
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires isolated Postgres via BUZZ_TEST_DATABASE_URL"]
async fn postgres_capacitor_renewal_and_rotation_preserve_authority_boundaries() {
    let url = std::env::var("BUZZ_TEST_DATABASE_URL").expect("explicit test DB");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    let schema = format!("capacitor_qa_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(AssertSqlSafe(format!(
        "CREATE SCHEMA {schema}; SET search_path TO {schema}"
    )))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/0001_push_gateway_authority.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../migrations/0002_capacitor_profiles.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let store = PostgresAuthorityStore::new(pool.clone());
    let id = Uuid::new_v4();
    store
        .create_installation(NewInstallation {
            id,
            app_attest_key_id: vec![1; 32],
            app_attest_public_key: vec![2; 65],
            assertion_counter: 0,
            profile: AppProfile::BuzzCapacitorIosSandbox,
            token_ciphertext: vec![3; 32],
            token_fingerprint: [4; 32],
            endpoint_epoch: 1,
            expires_at: 2_000,
        })
        .await
        .unwrap();
    assert!(
        store.renew_installation(id, 2, 3_000, 1_000).await.is_err(),
        "wrong epoch"
    );
    assert!(
        store.renew_installation(id, 1, 1_999, 1_000).await.is_err(),
        "shortened expiry"
    );
    assert!(
        store.renew_installation(id, 1, 3_000, 2_001).await.is_err(),
        "expired installation"
    );
    store.renew_installation(id, 1, 3_000, 1_000).await.unwrap();
    assert_eq!(
        store.installation(id, 2_500).await.unwrap().expires_at,
        3_000
    );
    store
        .rotate_endpoint(id, 1, 2, vec![5; 32], [6; 32])
        .await
        .unwrap();
    store
        .rotate_endpoint(id, 1, 2, vec![7; 32], [6; 32])
        .await
        .unwrap();
    assert!(
        store
            .rotate_endpoint(id, 1, 2, vec![7; 32], [8; 32])
            .await
            .is_err(),
        "retry cannot substitute endpoint"
    );
    assert!(
        store
            .rotate_endpoint(id, 1, 3, vec![7; 32], [6; 32])
            .await
            .is_err(),
        "stale expected epoch"
    );
    assert!(store.renew_installation(id, 1, 4_000, 2_500).await.is_err());
    let actual = store.installation(id, 2_500).await.unwrap();
    assert_eq!(actual.endpoint_epoch, 2);
    assert_eq!(actual.token_fingerprint, [6; 32]);
    assert_eq!(actual.profile, AppProfile::BuzzCapacitorIosSandbox);
    store.revoke_installation(id, 2, 3).await.unwrap();
    assert!(
        store.renew_installation(id, 3, 4_000, 2_500).await.is_err(),
        "revocation cannot be renewed away"
    );
    assert!(
        store
            .rotate_endpoint(id, 3, 4, vec![9; 32], [9; 32])
            .await
            .is_err(),
        "revocation cannot be rotated away"
    );
    sqlx::raw_sql(AssertSqlSafe(format!(
        "SET search_path TO public; DROP SCHEMA {schema} CASCADE"
    )))
    .execute(&pool)
    .await
    .unwrap();
}
