use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::auth::{
    build_auth_cookie, clear_auth_cookie, constant_time_eq, has_valid_admin_token,
    has_valid_facilitator_session, resolve_facilitator_user_id, BETTER_AUTH_COOKIE,
    FACILITATOR_COOKIE,
};
use crate::config::Config;
use crate::db::{self, DbError};
use crate::models::{
    CreateActivityInput, CreateSessionInput, JoinSessionInput, RoomSnapshot, SubmitResponseInput,
    UpdateSessionStateInput, WsServerMessage,
};
use crate::ws::{ws_session_handler, WsHub};

/// Shared application state accessible across all Axum HTTP and WebSocket handlers.
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub pool: PgPool,
    pub demo_active: Arc<AtomicBool>,
    pub ws_hub: WsHub,
}

impl AppState {
    /// Creates a new shared application state and synchronizes initial demo availability in PostgreSQL.
    pub async fn new(config: Config, pool: PgPool) -> Result<Self, DbError> {
        let initial = config.demo_enabled;
        db::set_control(&pool, "demo_active", if initial { "true" } else { "false" }).await?;
        Ok(Self {
            config,
            pool,
            demo_active: Arc::new(AtomicBool::new(initial)),
            ws_hub: WsHub::new(),
        })
    }

    /// Returns whether the live workshop service is currently active.
    pub fn is_demo_active(&self) -> bool {
        self.demo_active.load(Ordering::SeqCst)
    }

    /// Atomically updates the live workshop active flag in memory.
    pub fn set_demo_active(&self, active: bool) {
        self.demo_active.store(active, Ordering::SeqCst);
    }
}

/// Request payload for facilitator token authentication.
#[derive(Debug, Deserialize)]
pub struct FacilitatorAuthInput {
    pub facilitator_token: String,
}

/// Request payload for administrative access revocation or restoration.
#[derive(Debug, Deserialize)]
pub struct AdminAccessInput {
    pub demo_active: bool,
}

/// Response payload returned when a participant joins or reconnects to a workshop room.
#[derive(Debug, Serialize)]
pub struct JoinSessionOutput {
    pub participant_id: uuid::Uuid,
    pub snapshot: RoomSnapshot,
}

/// Builds the full Axum Router including REST routes, WebSocket endpoint, and CORS middleware.
pub fn build_router(state: AppState) -> Router {
    let origins: Vec<HeaderValue> = state
        .config
        .allowed_origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            header::COOKIE,
            HeaderName::from_static("x-facilitator-token"),
            HeaderName::from_static("x-admin-token"),
        ])
        .allow_credentials(true);

    Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/auth/facilitator", post(auth_facilitator_handler))
        .route("/api/auth/logout", post(auth_logout_handler))
        .route("/api/auth/status", get(auth_status_handler))
        .route("/api/admin/access", post(admin_access_handler))
        .route(
            "/api/sessions",
            get(list_sessions_handler).post(create_session_handler),
        )
        .route("/api/sessions/{code}", get(get_session_handler))
        .route(
            "/api/sessions/{code}/activities",
            post(create_activity_handler),
        )
        .route(
            "/api/sessions/{code}/state",
            patch(update_session_state_handler),
        )
        .route("/api/sessions/{code}/insights", get(get_insights_handler))
        .route("/api/sessions/{code}/join", post(join_session_handler))
        .route(
            "/api/sessions/{code}/responses",
            post(submit_response_handler),
        )
        .route("/ws/sessions/{code}", get(ws_session_handler))
        .layer(cors)
        .with_state(state)
}

/// Formats a consistent JSON error response with the specified HTTP status code.
pub fn api_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// Maps a database/domain error into the corresponding HTTP error response.
fn map_db_error(err: DbError) -> Response {
    match err {
        DbError::NotFound(msg) => api_error(StatusCode::NOT_FOUND, &format!("{msg} not found")),
        DbError::Validation(msg) => api_error(StatusCode::BAD_REQUEST, &msg),
        DbError::Conflict(msg) => api_error(StatusCode::CONFLICT, &msg),
        DbError::Sqlx(e) => {
            tracing::error!("database error: {e}");
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "internal database error")
        }
    }
}

/// Enforces that the workshop service is active for open participant room endpoints.
fn require_service_active(state: &AppState) -> Option<Response> {
    if !state.is_demo_active() {
        return Some(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "workshop access is currently disabled",
        ));
    }
    None
}

/// Enforces that the service is active and the caller holds a valid Better Auth session or facilitator token.
async fn require_facilitator_auth(state: &AppState, headers: &HeaderMap) -> Option<Response> {
    if !state.is_demo_active() {
        return Some(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "workshop access is currently disabled",
        ));
    }
    if !has_valid_facilitator_session(&state.pool, headers, &state.config).await {
        return Some(api_error(
            StatusCode::UNAUTHORIZED,
            "facilitator login required via Better Auth",
        ));
    }
    None
}

/// Reports service health and whether the live environment is currently enabled.
async fn health_handler(State(state): State<AppState>) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "demo_active": state.is_demo_active(),
        })),
    )
        .into_response()
}

/// Verifies a facilitator token and sets an HttpOnly cookie.
async fn auth_facilitator_handler(
    State(state): State<AppState>,
    Json(input): Json<FacilitatorAuthInput>,
) -> Response {
    if !state.is_demo_active() {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "workshop access is currently disabled",
        );
    }
    if !constant_time_eq(
        input.facilitator_token.trim(),
        &state.config.facilitator_token,
    ) {
        return api_error(StatusCode::UNAUTHORIZED, "invalid facilitator token");
    }

    let mut res = (StatusCode::OK, Json(json!({ "authenticated": true }))).into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        build_auth_cookie(FACILITATOR_COOKIE, &state.config.facilitator_token),
    );
    res
}

/// Clears facilitator authentication cookies.
async fn auth_logout_handler() -> Response {
    let mut res = (StatusCode::OK, Json(json!({ "authenticated": false }))).into_response();
    res.headers_mut()
        .append(header::SET_COOKIE, clear_auth_cookie(FACILITATOR_COOKIE));
    res.headers_mut()
        .append(header::SET_COOKIE, clear_auth_cookie(BETTER_AUTH_COOKIE));
    res
}

/// Returns current service availability and facilitator authentication status.
async fn auth_status_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let active = state.is_demo_active();
    let fac_auth =
        active && has_valid_facilitator_session(&state.pool, &headers, &state.config).await;
    (
        StatusCode::OK,
        Json(json!({
            "demo_active": active,
            "facilitator_authenticated": fac_auth,
        })),
    )
        .into_response()
}

/// Toggles runtime availability, persists control state, and disconnects active WebSockets on revocation.
async fn admin_access_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AdminAccessInput>,
) -> Response {
    if !has_valid_admin_token(&headers, &state.config) {
        return api_error(StatusCode::UNAUTHORIZED, "valid admin token required");
    }
    if let Err(e) = db::set_control(
        &state.pool,
        "demo_active",
        if input.demo_active { "true" } else { "false" },
    )
    .await
    {
        return map_db_error(e);
    }
    state.set_demo_active(input.demo_active);
    if !input.demo_active {
        state.ws_hub.revoke_all();
    }
    (
        StatusCode::OK,
        Json(json!({ "demo_active": input.demo_active })),
    )
        .into_response()
}

/// Lists workshop sessions owned by the authenticated Better Auth user.
async fn list_sessions_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(resp) = require_service_active(&state) {
        return resp;
    }
    let Some(owner_id) = resolve_facilitator_user_id(&state.pool, &headers, &state.config).await
    else {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "facilitator login required via Better Auth",
        );
    };
    match db::list_sessions_for_owner(&state.pool, Some(&owner_id)).await {
        Ok(sessions) => (StatusCode::OK, Json(sessions)).into_response(),
        Err(e) => map_db_error(e),
    }
}

/// Creates a new workshop session scoped to the authenticated Better Auth user.
async fn create_session_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateSessionInput>,
) -> Response {
    if let Some(resp) = require_service_active(&state) {
        return resp;
    }
    let Some(owner_id) = resolve_facilitator_user_id(&state.pool, &headers, &state.config).await
    else {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "facilitator login required via Better Auth",
        );
    };
    match db::create_session_for_owner(&state.pool, &input, Some(&owner_id)).await {
        Ok(session) => (StatusCode::CREATED, Json(session)).into_response(),
        Err(e) => map_db_error(e),
    }
}

/// Appends an ordered activity to a workshop session and broadcasts the updated room snapshot.
async fn create_activity_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
    Json(input): Json<CreateActivityInput>,
) -> Response {
    if let Some(resp) = require_facilitator_auth(&state, &headers).await {
        return resp;
    }
    match db::create_activity(&state.pool, &code, &input).await {
        Ok(activity) => {
            if let Ok(snapshot) = db::get_room_snapshot(&state.pool, &code, true).await {
                let room_code = snapshot.session.code.clone();
                state
                    .ws_hub
                    .broadcast(&room_code, WsServerMessage::RoomSnapshot { snapshot });
            }
            (StatusCode::CREATED, Json(activity)).into_response()
        }
        Err(e) => map_db_error(e),
    }
}

/// Updates session status, active activity, or open/lock state and broadcasts the new room snapshot.
async fn update_session_state_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
    Json(input): Json<UpdateSessionStateInput>,
) -> Response {
    if let Some(resp) = require_facilitator_auth(&state, &headers).await {
        return resp;
    }
    match db::update_session_state(&state.pool, &code, &input).await {
        Ok(snapshot) => {
            state.ws_hub.broadcast(
                &snapshot.session.code,
                WsServerMessage::RoomSnapshot {
                    snapshot: snapshot.clone(),
                },
            );
            (StatusCode::OK, Json(snapshot)).into_response()
        }
        Err(e) => map_db_error(e),
    }
}

/// Computes and returns deterministic PostgreSQL HR insights for a workshop session.
async fn get_insights_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Response {
    if let Some(resp) = require_facilitator_auth(&state, &headers).await {
        return resp;
    }
    match db::get_hr_insights(&state.pool, &code).await {
        Ok(insights) => (StatusCode::OK, Json(insights)).into_response(),
        Err(e) => map_db_error(e),
    }
}

/// Joins or reconnects an accountless mobile participant by Room Code and broadcasts updated counts.
async fn join_session_handler(
    State(state): State<AppState>,
    Path(code): Path<String>,
    Json(input): Json<JoinSessionInput>,
) -> Response {
    if let Some(resp) = require_service_active(&state) {
        return resp;
    }
    match db::join_participant(&state.pool, &code, &input).await {
        Ok((participant, is_new)) => match db::get_room_snapshot(&state.pool, &code, true).await {
            Ok(snapshot) => {
                if is_new {
                    state.ws_hub.broadcast(
                        &snapshot.session.code,
                        WsServerMessage::ParticipantCount {
                            count: snapshot.participant_count,
                        },
                    );
                    state.ws_hub.broadcast(
                        &snapshot.session.code,
                        WsServerMessage::RoomSnapshot {
                            snapshot: snapshot.clone(),
                        },
                    );
                }
                (
                    StatusCode::CREATED,
                    Json(JoinSessionOutput {
                        participant_id: participant.id,
                        snapshot,
                    }),
                )
                    .into_response()
            }
            Err(e) => map_db_error(e),
        },
        Err(e) => map_db_error(e),
    }
}

/// Returns the live room snapshot for a participant or facilitator by Room Code.
async fn get_session_handler(State(state): State<AppState>, Path(code): Path<String>) -> Response {
    if let Some(resp) = require_service_active(&state) {
        return resp;
    }
    match db::get_room_snapshot(&state.pool, &code, true).await {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(e) => map_db_error(e),
    }
}

/// Upserts a participant response by Room Code and broadcasts the updated activity tally over WebSocket.
async fn submit_response_handler(
    State(state): State<AppState>,
    Path(code): Path<String>,
    Json(input): Json<SubmitResponseInput>,
) -> Response {
    if let Some(resp) = require_service_active(&state) {
        return resp;
    }
    match db::upsert_response_with_tally(&state.pool, &code, &input).await {
        Ok(tally) => {
            if let Ok(norm_code) = crate::models::normalize_session_code(&code) {
                state.ws_hub.broadcast(
                    &norm_code,
                    WsServerMessage::ActivityTally {
                        tally,
                        echo_client_ts: None,
                    },
                );
            }
            (StatusCode::OK, Json(json!({ "accepted": true }))).into_response()
        }
        Err(e) => map_db_error(e),
    }
}
