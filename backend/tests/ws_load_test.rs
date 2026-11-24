use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::sync::OnceCell;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use workshop_backend::config::Config;
use workshop_backend::db;
use workshop_backend::models::{
    ActivityKind, CreateActivityInput, CreateSessionInput, HrDimension, JoinSessionInput,
    SessionStatus, UpdateSessionStateInput,
};
use workshop_backend::routes::{build_router, AppState};

/// One-time migration guard across integration tests.
static MIGRATED: OnceCell<()> = OnceCell::const_new();

/// Loads DATABASE_URL from environment or ../.env without hardcoded fallbacks.
fn database_url_from_env() -> String {
    let _ = dotenvy::from_filename("../.env");
    let _ = dotenvy::dotenv();
    std::env::var("DATABASE_URL").expect("DATABASE_URL must be set")
}

/// Computes the 95th percentile latency in milliseconds from a slice of durations.
fn percentile_95_ms(samples: &[f64]) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = ((sorted.len() as f64) * 0.95).ceil() as usize;
    sorted[idx.saturating_sub(1).min(sorted.len() - 1)]
}

/// Simulates 30 concurrent participants + 1 facilitator over live WebSockets, asserting 0 drops and p95 < 100 ms.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_ws_30_participants_plus_facilitator_load_and_revocation() {
    let url = database_url_from_env();
    MIGRATED
        .get_or_init(|| async {
            let pool = db::connect_and_migrate(&url).await.unwrap();
            pool.close().await;
        })
        .await;

    let pool: PgPool = db::connect_and_migrate(&url).await.unwrap();

    // Pre-warm pooled connections so benchmark measures warm WS + SQLx query latency
    let mut conns = Vec::with_capacity(30);
    for _ in 0..30 {
        conns.push(pool.acquire().await.unwrap());
    }
    drop(conns);

    let demo_token = "ws-bench-demo-token-12345";
    let fac_token = "ws-bench-fac-token-67890";
    let admin_token = "ws-bench-admin-token-99999";

    let env = HashMap::from([
        ("DATABASE_URL", url.as_str()),
        ("DEMO_ACCESS_TOKEN", demo_token),
        ("FACILITATOR_TOKEN", fac_token),
        ("ADMIN_TOKEN", admin_token),
    ]);
    let config = Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).unwrap();
    let state = AppState::new(config, pool.clone()).await.unwrap();
    let app = build_router(state.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // Provision a session, poll activity, and 30 participants in PostgreSQL
    let session = db::create_session(
        &pool,
        &CreateSessionInput {
            title: "30-Participant WS Benchmark".into(),
            client_label: "Live WorkShop".into(),
        },
    )
    .await
    .unwrap();

    let activity = db::create_activity(
        &pool,
        &session.code,
        &CreateActivityInput {
            kind: ActivityKind::Poll,
            dimension: HrDimension::General,
            prompt: "Benchmark poll question?".into(),
            options: vec!["A".into(), "B".into(), "C".into(), "D".into()],
        },
    )
    .await
    .unwrap();

    db::update_session_state(
        &pool,
        &session.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Active),
            current_activity_id: Some(Some(activity.id)),
            is_open: Some(true),
        },
    )
    .await
    .unwrap();

    let participant_count = 30usize;
    let mut participants = Vec::with_capacity(participant_count);
    for i in 0..participant_count {
        let (p, _) = db::join_participant(
            &pool,
            &session.code,
            &JoinSessionInput {
                nickname: format!("Participant-{}", i + 1),
                participant_id: None,
            },
        )
        .await
        .unwrap();
        participants.push(p);
    }

    let ws_url = format!(
        "ws://{}/ws/sessions/{}?token={}",
        addr, session.code, demo_token
    );

    // Connect 1 facilitator + 30 concurrent participant WebSockets
    let (mut fac_ws, _) = connect_async(&ws_url).await.unwrap();
    let fac_init = fac_ws.next().await.unwrap().unwrap();
    let fac_init_json: Value = serde_json::from_str(fac_init.to_text().unwrap()).unwrap();
    assert_eq!(fac_init_json["type"], "room_snapshot");

    let mut client_sockets = Vec::with_capacity(participant_count);
    for _ in 0..participant_count {
        let (mut ws, _) = connect_async(&ws_url).await.unwrap();
        let init_msg = ws.next().await.unwrap().unwrap();
        let init_json: Value = serde_json::from_str(init_msg.to_text().unwrap()).unwrap();
        assert_eq!(init_json["type"], "room_snapshot");
        client_sockets.push(ws);
    }

    // 1. Measure 30 concurrent ping -> pong latencies
    let epoch = Instant::now();
    let mut ping_latencies_ms = Vec::with_capacity(participant_count);
    for (idx, ws) in client_sockets.iter_mut().enumerate() {
        let t0 = Instant::now();
        let ts = idx as i64 + 1;
        ws.send(Message::Text(
            json!({ "type": "ping", "client_ts": ts })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let parsed: Value = serde_json::from_str(reply.to_text().unwrap()).unwrap();
        assert_eq!(parsed["type"], "pong");
        assert_eq!(parsed["echo_client_ts"], ts);
        ping_latencies_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
    }

    // 2. Concurrent burst: all 30 participants submit responses over WebSocket
    let mut send_times = HashMap::new();
    let mut send_futures = Vec::with_capacity(participant_count);
    for (idx, (mut ws, participant)) in client_sockets
        .into_iter()
        .zip(participants.iter())
        .enumerate()
    {
        let ts = (idx as i64) + 10_000;
        let payload = json!({
            "type": "submit_response",
            "participant_id": participant.id,
            "activity_id": activity.id,
            "choice_index": (idx % 4) as i32,
            "client_ts": ts,
        })
        .to_string();
        send_times.insert(ts, epoch.elapsed());
        send_futures.push(tokio::spawn(async move {
            ws.send(Message::Text(payload.into())).await.unwrap();
            ws
        }));
    }

    let mut returned_sockets = Vec::with_capacity(participant_count);
    for handle in send_futures {
        returned_sockets.push(handle.await.unwrap());
    }

    // Facilitator receives all 30 activity_tally broadcasts with 0 drops
    let mut tally_latencies_ms = Vec::with_capacity(participant_count);
    let mut saw_full_count = false;
    while tally_latencies_ms.len() < participant_count {
        let frame = tokio::time::timeout(Duration::from_secs(10), fac_ws.next())
            .await
            .expect("timed out waiting for activity_tally on facilitator WS")
            .unwrap()
            .unwrap();
        let parsed: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
        assert_ne!(
            parsed["type"], "error",
            "unexpected ws error frame: {parsed}"
        );
        if parsed["type"] == "activity_tally" {
            if let Some(ts) = parsed["echo_client_ts"].as_i64() {
                if let Some(t0) = send_times.get(&ts) {
                    let elapsed_ms = (epoch.elapsed().saturating_sub(*t0)).as_secs_f64() * 1000.0;
                    tally_latencies_ms.push(elapsed_ms);
                }
            }
            if parsed["tally"]["response_count"].as_i64() == Some(participant_count as i64) {
                saw_full_count = true;
            }
        }
    }

    assert_eq!(tally_latencies_ms.len(), participant_count);
    assert!(saw_full_count, "expected final tally response_count == 30");

    let ping_p95 = percentile_95_ms(&ping_latencies_ms);
    let tally_p95 = percentile_95_ms(&tally_latencies_ms);
    println!(
        "WS Benchmark (30 participants + 1 facilitator): ping p95 = {:.2} ms, broadcast tally p95 = {:.2} ms",
        ping_p95, tally_p95
    );
    assert!(
        ping_p95 < 100.0,
        "ping p95 {:.2} ms exceeded 100 ms budget",
        ping_p95
    );
    assert!(
        tally_p95 < 100.0,
        "tally broadcast p95 {:.2} ms exceeded 100 ms budget",
        tally_p95
    );

    // 3. Verify emergency revocation pushes access_revoked to active sockets
    state.set_demo_active(false);
    state.ws_hub.revoke_all();

    let revoked_frame = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let msg = fac_ws.next().await.unwrap().unwrap();
            if let Ok(txt) = msg.to_text() {
                let val: Value = serde_json::from_str(txt).unwrap();
                if val["type"] == "access_revoked" {
                    return val;
                }
            }
        }
    })
    .await
    .expect("expected access_revoked frame on revocation");
    assert_eq!(revoked_frame["type"], "access_revoked");

    drop(returned_sockets);
}
