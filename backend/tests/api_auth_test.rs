use std::collections::HashMap;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::OnceCell;
use tower::ServiceExt;
use uuid::Uuid;

use workshop_backend::config::Config;
use workshop_backend::db;
use workshop_backend::routes::{build_router, AppState};

/// One-time migration guard across integration tests.
static MIGRATED: OnceCell<()> = OnceCell::const_new();

/// Loads DATABASE_URL from environment or ../.env without hardcoded fallbacks.
fn database_url_from_env() -> String {
    let _ = dotenvy::from_filename("../.env");
    let _ = dotenvy::dotenv();
    std::env::var("DATABASE_URL").expect("DATABASE_URL must be set")
}

/// Creates a test AppState with isolated runtime tokens and a live PostgreSQL pool.
async fn test_app_state() -> AppState {
    let url = database_url_from_env();
    MIGRATED
        .get_or_init(|| async {
            let pool = db::connect_and_migrate(&url).await.unwrap();
            pool.close().await;
        })
        .await;

    let pool: PgPool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .unwrap();

    let env = HashMap::from([
        ("DATABASE_URL", url.as_str()),
        ("FACILITATOR_TOKEN", "test-fac-secret-67890"),
        ("ADMIN_TOKEN", "test-admin-secret-99999"),
    ]);
    let config = Config::from_lookup(|k| env.get(k).map(|v| (*v).to_string())).unwrap();
    AppState::new(config, pool).await.unwrap()
}

/// Sends a JSON HTTP request through the Axum router and returns status, headers, and parsed JSON body.
async fn send_json(
    app: &axum::Router,
    method: Method,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    let req = if let Some(b) = body {
        builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&b).unwrap()))
            .unwrap()
    } else {
        builder.body(Body::empty()).unwrap()
    };

    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let res_headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json_val = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, res_headers, json_val)
}

/// Verifies Better Auth PostgreSQL session verification and privilege boundaries.
#[tokio::test]
async fn test_better_auth_session_and_privilege_boundaries() {
    let state = test_app_state().await;
    let pool = state.pool.clone();
    let app = build_router(state);

    let (status, _, health) = send_json(&app, Method::GET, "/api/health", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["demo_active"], true);

    // Unauthenticated facilitator endpoints are rejected with 401
    let (status_list, _, _) = send_json(&app, Method::GET, "/api/sessions", &[], None).await;
    assert_eq!(status_list, StatusCode::UNAUTHORIZED);

    let (status_create, _, _) = send_json(
        &app,
        Method::POST,
        "/api/sessions",
        &[],
        Some(json!({ "title": "Unauthorized Session", "client_label": "Lab" })),
    )
    .await;
    assert_eq!(status_create, StatusCode::UNAUTHORIZED);

    // Insert a Better Auth user and active session in PostgreSQL
    let user_id = format!("usr_{}", Uuid::new_v4());
    let session_id = format!("ses_{}", Uuid::new_v4());
    let ba_token = format!("ba_token_{}", Uuid::new_v4());
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, "emailVerified")
           VALUES ($1, 'Facilitator Jane', $2, true)"#,
    )
    .bind(&user_id)
    .bind(format!("jane_{}@example.com", Uuid::new_v4()))
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        r#"INSERT INTO "session" (id, "expiresAt", token, "userId")
           VALUES ($1, now() + interval '1 day', $2, $3)"#,
    )
    .bind(&session_id)
    .bind(&ba_token)
    .bind(&user_id)
    .execute(&pool)
    .await
    .unwrap();

    // Better Auth signed cookie (<token>.<signature>) unlocks facilitator endpoints
    let signed_cookie = format!("better-auth.session_token={ba_token}.hmac_sig_123");
    let (status_ba, _, status_body) = send_json(
        &app,
        Method::GET,
        "/api/auth/status",
        &[("cookie", &signed_cookie)],
        None,
    )
    .await;
    assert_eq!(status_ba, StatusCode::OK);
    assert_eq!(status_body["facilitator_authenticated"], true);

    let (status_create_ok, _, _) = send_json(
        &app,
        Method::POST,
        "/api/sessions",
        &[("cookie", &signed_cookie)],
        Some(json!({ "title": "Better Auth Session", "client_label": "Live WorkShop" })),
    )
    .await;
    assert_eq!(status_create_ok, StatusCode::CREATED);

    // A newly created second Better Auth user sees 0 sessions (isolated per owner_id)
    let user2_id = format!("usr_{}", Uuid::new_v4());
    let session2_id = format!("ses_{}", Uuid::new_v4());
    let ba2_token = format!("ba_token_{}", Uuid::new_v4());
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, "emailVerified")
           VALUES ($1, 'Facilitator Bob', $2, true)"#,
    )
    .bind(&user2_id)
    .bind(format!("bob_{}@example.com", Uuid::new_v4()))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO "session" (id, "expiresAt", token, "userId")
           VALUES ($1, now() + interval '1 day', $2, $3)"#,
    )
    .bind(&session2_id)
    .bind(&ba2_token)
    .bind(&user2_id)
    .execute(&pool)
    .await
    .unwrap();

    let signed_cookie2 = format!("better-auth.session_token={ba2_token}.hmac_sig_456");
    let (status_list2, _, list2_body) = send_json(
        &app,
        Method::GET,
        "/api/sessions",
        &[("cookie", &signed_cookie2)],
        None,
    )
    .await;
    assert_eq!(status_list2, StatusCode::OK);
    assert_eq!(list2_body.as_array().unwrap().len(), 0);

    // Logout clears cookies
    let (status, _, body) = send_json(&app, Method::POST, "/api/auth/logout", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["authenticated"], false);
}

/// Verifies full REST workshop flow (facilitator creates session, general client joins by Room Code without login) and runtime revocation.
#[tokio::test]
async fn test_full_rest_workshop_flow_and_runtime_revocation() {
    let state = test_app_state().await;
    let app = build_router(state);

    let fac_headers = [("x-facilitator-token", "test-fac-secret-67890")];

    // 1. Create session (Facilitator)
    let (status, _, sess) = send_json(
        &app,
        Method::POST,
        "/api/sessions",
        &fac_headers,
        Some(json!({ "title": "Live WorkShop Cohort 1", "client_label": "Live WorkShop" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let code = sess["code"].as_str().unwrap().to_string();

    // 2. Add Poll activity (Facilitator)
    let (status, _, act_poll) = send_json(
        &app,
        Method::POST,
        &format!("/api/sessions/{code}/activities"),
        &fac_headers,
        Some(json!({
            "kind": "poll",
            "dimension": "strength",
            "prompt": "Strongest skill?",
            "options": ["Coaching", "Delegation"]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let poll_id = act_poll["id"].as_str().unwrap().to_string();

    // 3. General client joins participant room by Room Code alone (NO auth headers or demo token required!)
    let (status, _, joined) = send_json(
        &app,
        Method::POST,
        &format!("/api/sessions/{code}/join"),
        &[],
        Some(json!({ "nickname": "Maya" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let pid = joined["participant_id"].as_str().unwrap().to_string();

    // 4. Activate session and poll activity (Facilitator)
    let (status, _, snap) = send_json(
        &app,
        Method::PATCH,
        &format!("/api/sessions/{code}/state"),
        &fac_headers,
        Some(json!({ "status": "active", "current_activity_id": poll_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snap["session"]["status"], "active");

    // 5. General client submits poll response by Room Code alone (NO login required!)
    let (status, _, sub_res) = send_json(
        &app,
        Method::POST,
        &format!("/api/sessions/{code}/responses"),
        &[],
        Some(json!({
            "participant_id": pid,
            "activity_id": poll_id,
            "choice_index": 0
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sub_res["accepted"], true);

    // 6. Fetch HR insights (Facilitator/HR login required)
    let (status_unauth_ins, _, _) = send_json(
        &app,
        Method::GET,
        &format!("/api/sessions/{code}/insights"),
        &[],
        None,
    )
    .await;
    assert_eq!(status_unauth_ins, StatusCode::UNAUTHORIZED);

    let (status, _, insights) = send_json(
        &app,
        Method::GET,
        &format!("/api/sessions/{code}/insights"),
        &fac_headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(insights["participant_count"], 1);
    assert_eq!(insights["response_rate"], 100.0);

    // 7. Admin runtime revocation blocks access immediately
    let (status, _, rev) = send_json(
        &app,
        Method::POST,
        "/api/admin/access",
        &[("x-admin-token", "test-admin-secret-99999")],
        Some(json!({ "demo_active": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rev["demo_active"], false);

    let (status_blocked, _, _) = send_json(
        &app,
        Method::GET,
        &format!("/api/sessions/{code}"),
        &[],
        None,
    )
    .await;
    assert_eq!(status_blocked, StatusCode::SERVICE_UNAVAILABLE);

    // 8. Admin restores access
    let (status_restored, _, _) = send_json(
        &app,
        Method::POST,
        "/api/admin/access",
        &[("x-admin-token", "test-admin-secret-99999")],
        Some(json!({ "demo_active": true })),
    )
    .await;
    assert_eq!(status_restored, StatusCode::OK);
}
