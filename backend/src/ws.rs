use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use tokio::sync::broadcast;

use crate::db::{self, DbError};
use crate::models::{
    normalize_session_code, SubmitResponseInput, WsClientMessage, WsServerMessage,
};
use crate::routes::{api_error, AppState};

/// Broadcast channel buffer capacity per workshop room.
const ROOM_CHANNEL_CAPACITY: usize = 512;

/// Per-session Tokio broadcast hub with global emergency revocation signaling.
/// shortcut: single-instance Tokio broadcast hub assumes 1 backend task for ~30-person workshops, upgrade to Redis pub/sub if scaling >1 backend instance
#[derive(Clone)]
pub struct WsHub {
    rooms: Arc<RwLock<HashMap<String, broadcast::Sender<WsServerMessage>>>>,
    revoke_tx: broadcast::Sender<()>,
}

impl Default for WsHub {
    /// Creates an empty WebSocket broadcast hub.
    fn default() -> Self {
        Self::new()
    }
}

impl WsHub {
    /// Initializes a new room broadcast registry and revocation channel.
    pub fn new() -> Self {
        let (revoke_tx, _) = broadcast::channel(64);
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            revoke_tx,
        }
    }

    /// Subscribes to the broadcast channel for a normalized room code.
    pub fn subscribe(&self, code: &str) -> broadcast::Receiver<WsServerMessage> {
        if let Ok(guard) = self.rooms.read() {
            if let Some(tx) = guard.get(code) {
                return tx.subscribe();
            }
        }
        let mut guard = self.rooms.write().expect("ws rooms lock poisoned");
        let tx = guard
            .entry(code.to_string())
            .or_insert_with(|| broadcast::channel(ROOM_CHANNEL_CAPACITY).0);
        tx.subscribe()
    }

    /// Subscribes to the global demo-access revocation signal.
    pub fn subscribe_revocation(&self) -> broadcast::Receiver<()> {
        self.revoke_tx.subscribe()
    }

    /// Broadcasts a message to all active WebSocket subscribers in a workshop room.
    pub fn broadcast(&self, code: &str, msg: WsServerMessage) {
        if let Ok(guard) = self.rooms.read() {
            if let Some(tx) = guard.get(code) {
                let _ = tx.send(msg);
            }
        }
    }

    /// Signals all active WebSocket connections across all rooms to notify and disconnect.
    pub fn revoke_all(&self) {
        let _ = self.revoke_tx.send(());
    }
}

/// Validates service availability and room code existence before upgrading to a WebSocket stream.
pub async fn ws_session_handler(
    State(state): State<AppState>,
    Path(raw_code): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    if !state.is_demo_active() {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "workshop access is disabled",
        );
    }

    let code = match normalize_session_code(&raw_code) {
        Ok(c) => c,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, &e.0),
    };

    let initial_snapshot = match db::get_room_snapshot(&state.pool, &code, true).await {
        Ok(snap) => snap,
        Err(DbError::NotFound(_)) => return api_error(StatusCode::NOT_FOUND, "session not found"),
        Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };

    ws.on_upgrade(move |socket| handle_ws_client(socket, state, code, initial_snapshot))
        .into_response()
}

/// Runs the per-client WebSocket event loop handling room broadcasts, submissions, pings, and revocation.
async fn handle_ws_client(
    mut socket: WebSocket,
    state: AppState,
    code: String,
    initial_snapshot: crate::models::RoomSnapshot,
) {
    let mut room_rx = state.ws_hub.subscribe(&code);
    let mut revoke_rx = state.ws_hub.subscribe_revocation();

    if send_ws_json(
        &mut socket,
        &WsServerMessage::RoomSnapshot {
            snapshot: initial_snapshot,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            biased;
            _ = revoke_rx.recv() => {
                let _ = send_ws_json(
                    &mut socket,
                    &WsServerMessage::AccessRevoked {
                        reason: "demo access revoked by administrator".into(),
                    },
                )
                .await;
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        if !state.is_demo_active() {
                            let _ = send_ws_json(
                                &mut socket,
                                &WsServerMessage::AccessRevoked {
                                    reason: "demo access disabled".into(),
                                },
                            )
                            .await;
                            let _ = socket.send(Message::Close(None)).await;
                            break;
                        }
                        if handle_inbound_text(&mut socket, &state, &code, &text).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            room_msg = room_rx.recv() => {
                match room_msg {
                    Ok(msg) => {
                        if send_ws_json(&mut socket, &msg).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

/// Processes an inbound client JSON text frame and replies or broadcasts accordingly.
async fn handle_inbound_text(
    socket: &mut WebSocket,
    state: &AppState,
    code: &str,
    raw: &str,
) -> Result<(), axum::Error> {
    let parsed: WsClientMessage = match serde_json::from_str(raw) {
        Ok(msg) => msg,
        Err(_) => {
            return send_ws_json(
                socket,
                &WsServerMessage::Error {
                    message: "invalid websocket message format".into(),
                },
            )
            .await;
        }
    };

    match parsed {
        WsClientMessage::Ping { client_ts } => {
            send_ws_json(
                socket,
                &WsServerMessage::Pong {
                    echo_client_ts: client_ts,
                },
            )
            .await
        }
        WsClientMessage::SubmitResponse {
            participant_id,
            activity_id,
            choice_index,
            rating_value,
            text_value,
            client_ts,
        } => {
            let input = SubmitResponseInput {
                participant_id,
                activity_id,
                choice_index,
                rating_value,
                text_value,
            };
            match db::upsert_response_with_tally(&state.pool, code, &input).await {
                Ok(tally) => {
                    state.ws_hub.broadcast(
                        code,
                        WsServerMessage::ActivityTally {
                            tally,
                            echo_client_ts: client_ts,
                        },
                    );
                    Ok(())
                }
                Err(e) => {
                    send_ws_json(
                        socket,
                        &WsServerMessage::Error {
                            message: e.to_string(),
                        },
                    )
                    .await
                }
            }
        }
    }
}

/// Serializes a server message to JSON and sends it as a WebSocket Text frame.
async fn send_ws_json(socket: &mut WebSocket, msg: &WsServerMessage) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(msg).expect("serializable ws server message");
    socket.send(Message::Text(payload.into())).await
}
