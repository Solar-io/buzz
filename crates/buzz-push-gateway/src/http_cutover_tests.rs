use super::*;
use crate::{authority::MemoryAuthorityStore, grant::GrantKey, token::TokenKey};
use sha2::{Digest, Sha256};

struct NoProviderCalls;
#[async_trait::async_trait]
impl PushTransport for NoProviderCalls {
    async fn send(&self, _: DeliveryAttempt, _: AppProfile, _: &str) -> DeliveryOutcome {
        panic!("A retired profile must never reach APNs");
    }
}

#[tokio::test]
async fn retired_profile_is_indistinguishable_from_an_invalid_opaque_grant() {
    let signer = nostr::Keys::generate();
    let ring =
        Arc::new(GrantKeyring::new(vec![GrantKey::new("grant", &[1; 32]).unwrap()]).unwrap());
    let now = chrono::Utc::now().timestamp();
    let retired = ring
        .issue(&EndpointGrant {
            v: 1,
            delegation_id: uuid::Uuid::new_v4(),
            relay_pubkey: signer.public_key().to_hex(),
            app_profile: AppProfile::BuzzIosSandbox,
            endpoint_epoch: 1,
            generation: 1,
            expires_at: now + 300,
        })
        .unwrap();
    let url: url::Url = "https://push.buzz.xyz/v1/deliveries/apns".parse().unwrap();
    let state = AppState {
        grant_keyring: ring,
        app_attest: Arc::new(
            AppAttestVerifier::new(
                "TEAM.app".into(),
                include_bytes!("../../../test-fixtures/apple-app-attestation-root.pem").to_vec(),
            )
            .unwrap(),
        ),
        authority: Arc::new(MemoryAuthorityStore::default()),
        token_keyring: Arc::new(
            TokenKeyring::new(vec![TokenKey::new("token", &[2; 32]).unwrap()]).unwrap(),
        ),
        transport: Arc::new(NoProviderCalls),
        delivery_url: url.clone(),
        max_grant_lifetime_seconds: 300,
        max_installation_lifetime_seconds: 300,
        endpoint_quota_window_seconds: 10,
        endpoint_quota_max_deliveries: 10,
        enabled_profiles: HashSet::from([AppProfile::BuzzCapacitorIosSandbox]),
        now: || chrono::Utc::now().timestamp(),
        accepting: Arc::new(AtomicBool::new(true)),
    };
    for grant in [retired, "invalid-opaque-grant".into()] {
        let bytes = serde_json::to_vec(&DeliveryRequest {
            v: 1,
            endpoint_grant: grant,
            request_id: uuid::Uuid::new_v4(),
            expires_at: now + 60,
        })
        .unwrap();
        let digest = hex::encode(Sha256::digest(&bytes));
        let event = nostr::EventBuilder::new(nostr::Kind::HttpAuth, "")
            .tags([
                nostr::Tag::parse(["u", url.as_str()]).unwrap(),
                nostr::Tag::parse(["method", "POST"]).unwrap(),
                nostr::Tag::parse(["payload", digest.as_str()]).unwrap(),
            ])
            .sign_with_keys(&signer)
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Nostr {}", STANDARD.encode(event.as_json()))
                .parse()
                .unwrap(),
        );
        let response = deliver(State(state.clone()), headers, Bytes::from(bytes)).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"error":"invalid_grant"})
        );
    }
}
