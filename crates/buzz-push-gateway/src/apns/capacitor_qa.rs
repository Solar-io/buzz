use super::*;
use axum::{body::Bytes, extract::State, http::HeaderMap, routing::post, Router};
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use std::sync::Arc;

#[tokio::test]
async fn outbound_profiles_select_distinct_topics_and_payloads() {
    type Captures = Arc<Mutex<Vec<(String, serde_json::Value)>>>;
    async fn capture(State(rows): State<Captures>, headers: HeaderMap, body: Bytes) {
        rows.lock().unwrap().push((
            headers["apns-topic"].to_str().unwrap().to_owned(),
            serde_json::from_slice(&body).unwrap(),
        ));
    }
    let rows: Captures = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/3/device/{token}", post(capture))
        .with_state(rows.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let signing = SigningKey::from_slice(&[7; 32])
        .unwrap()
        .to_pkcs8_pem(LineEnding::LF)
        .unwrap();
    let transport = ApnsTransport::token_with_client(
        signing.as_bytes(),
        "qa-key",
        "qa-team",
        "legacy.flutter".into(),
        reqwest::Client::new(),
        origin.clone(),
        origin,
    )
    .unwrap()
    .with_capacitor_topic("native.capacitor".into());
    let wake = uuid::Uuid::parse_str("95e92937-f388-4f19-8663-c1e6ca913884").unwrap();
    for profile in [
        AppProfile::BuzzIosProduction,
        AppProfile::BuzzIosSandbox,
        AppProfile::BuzzCapacitorIosProduction,
        AppProfile::BuzzCapacitorIosSandbox,
    ] {
        assert_eq!(
            transport
                .send(
                    DeliveryAttempt {
                        request_id: wake,
                        expires_at: i64::MAX
                    },
                    profile,
                    &"aa".repeat(32)
                )
                .await,
            DeliveryOutcome::Accepted
        );
    }
    let captured = rows.lock().unwrap();
    assert_eq!(captured.len(), 4);
    for (index, (topic, body)) in captured.iter().enumerate() {
        if index < 2 {
            assert_eq!(topic, "legacy.flutter");
            assert_eq!(
                body,
                &serde_json::json!({"aps":{"alert":{"body":"Reconnect to your relay now"},"mutable-content":1}})
            );
        } else {
            assert_eq!(topic, "native.capacitor");
            assert_eq!(
                body,
                &serde_json::json!({"aps":{"alert":{"body":"Reconnect to your relay now"},"mutable-content":1},"buzz":{"v":2,"wake_id":"95e92937-f388-4f19-8663-c1e6ca913884"}})
            );
        }
    }
    server.abort();
}
