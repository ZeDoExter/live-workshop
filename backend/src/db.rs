use std::collections::{HashMap, HashSet};
use std::fmt;

use chrono::{DateTime, Utc};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::models::{
    normalize_session_code, Activity, ActivityKind, ActivityTally, CreateActivityInput,
    CreateSessionInput, DimensionSummary, HrDimension, HrInsights, JoinSessionInput,
    OpenAnswerQuote, Participant, RoomSnapshot, Session, SessionStatus, SessionSummary,
    SubmitResponseInput, UpdateSessionStateInput, ValidationError,
};

/// Unambiguous 32-character alphabet used to generate 6-character join codes.
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Database and domain error variants mapped cleanly to HTTP status codes in routes.
#[derive(Debug)]
pub enum DbError {
    NotFound(&'static str),
    Validation(String),
    Conflict(String),
    Sqlx(sqlx::Error),
}

impl fmt::Display for DbError {
    /// Formats the database error for logs and diagnostics.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(entity) => write!(f, "{entity} not found"),
            Self::Validation(msg) | Self::Conflict(msg) => f.write_str(msg),
            Self::Sqlx(err) => write!(f, "database error: {err}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<ValidationError> for DbError {
    /// Converts a model validation error into a database layer validation error.
    fn from(err: ValidationError) -> Self {
        Self::Validation(err.0)
    }
}

impl From<sqlx::Error> for DbError {
    /// Wraps an underlying SQLx error into DbError.
    fn from(err: sqlx::Error) -> Self {
        Self::Sqlx(err)
    }
}

/// Internal SQLx row representation for sessions.
#[derive(sqlx::FromRow)]
struct SessionRow {
    id: Uuid,
    code: String,
    title: String,
    client_label: String,
    status: String,
    current_activity_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
}

impl TryFrom<SessionRow> for Session {
    type Error = DbError;

    /// Converts a database session row into a typed Session struct.
    fn try_from(row: SessionRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            code: row.code,
            title: row.title,
            client_label: row.client_label,
            status: row.status.parse()?,
            current_activity_id: row.current_activity_id,
            created_at: row.created_at,
            ended_at: row.ended_at,
        })
    }
}

/// Internal SQLx row representation for session overview summaries.
#[derive(sqlx::FromRow)]
struct SessionSummaryRow {
    id: Uuid,
    code: String,
    title: String,
    client_label: String,
    status: String,
    participant_count: i64,
    activity_count: i64,
    created_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
}

impl TryFrom<SessionSummaryRow> for SessionSummary {
    type Error = DbError;

    /// Converts a database session summary row into a typed SessionSummary struct.
    fn try_from(row: SessionSummaryRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            code: row.code,
            title: row.title,
            client_label: row.client_label,
            status: row.status.parse()?,
            participant_count: row.participant_count,
            activity_count: row.activity_count,
            created_at: row.created_at,
            ended_at: row.ended_at,
        })
    }
}

/// Internal SQLx row representation for activities.
#[derive(sqlx::FromRow)]
struct ActivityRow {
    id: Uuid,
    session_id: Uuid,
    position: i32,
    kind: String,
    dimension: String,
    prompt: String,
    options: sqlx::types::Json<Vec<String>>,
    is_open: bool,
    created_at: DateTime<Utc>,
}

impl TryFrom<ActivityRow> for Activity {
    type Error = DbError;

    /// Converts a database activity row into a typed Activity struct.
    fn try_from(row: ActivityRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            session_id: row.session_id,
            position: row.position,
            kind: row.kind.parse()?,
            dimension: row.dimension.parse()?,
            prompt: row.prompt,
            options: row.options.0,
            is_open: row.is_open,
            created_at: row.created_at,
        })
    }
}

/// Internal SQLx row representation for participants.
#[derive(sqlx::FromRow)]
struct ParticipantRow {
    id: Uuid,
    session_id: Uuid,
    nickname: String,
    joined_at: DateTime<Utc>,
}

impl From<ParticipantRow> for Participant {
    /// Converts a database participant row into a domain Participant struct.
    fn from(row: ParticipantRow) -> Self {
        Self {
            id: row.id,
            session_id: row.session_id,
            nickname: row.nickname,
            joined_at: row.joined_at,
        }
    }
}

/// Internal SQLx row representation for session, activity, and batch participant membership check.
#[derive(sqlx::FromRow)]
struct ResponseTargetRow {
    session_id: Uuid,
    session_status: String,
    current_activity_id: Option<Uuid>,
    activity_id: Uuid,
    position: i32,
    kind: String,
    dimension: String,
    prompt: String,
    options: sqlx::types::Json<Vec<String>>,
    is_open: bool,
    created_at: DateTime<Utc>,
    valid_pids: Vec<Uuid>,
}

/// Internal SQLx row representation for PostgreSQL HR dimension aggregations.
#[derive(sqlx::FromRow)]
struct DimensionAggRow {
    dimension: String,
    activity_count: i64,
    response_count: i64,
    avg_rating: Option<f64>,
}

/// Generates a 6-character uppercase workshop join code from a random UUID.
fn generate_session_code() -> String {
    let bytes = Uuid::new_v4().into_bytes();
    (0..6)
        .map(|i| CODE_ALPHABET[(bytes[i] as usize) % CODE_ALPHABET.len()] as char)
        .collect()
}

/// Connects to PostgreSQL with a pre-warmed connection pool and applies embedded SQLx migrations.
pub async fn connect_and_migrate(database_url: &str) -> Result<PgPool, DbError> {
    let pool = PgPoolOptions::new()
        .max_connections(32)
        .min_connections(16)
        .connect(database_url)
        .await?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| DbError::Sqlx(sqlx::Error::Migrate(Box::new(e))))?;
    let mut warm = Vec::with_capacity(16);
    for _ in 0..16 {
        if let Ok(conn) = pool.acquire().await {
            warm.push(conn);
        }
    }
    drop(warm);
    Ok(pool)
}

/// Validates and persists a new workshop session with a unique join code.
pub async fn create_session(pool: &PgPool, input: &CreateSessionInput) -> Result<Session, DbError> {
    create_session_for_owner(pool, input, None).await
}

/// Validates and persists a new workshop session scoped to an optional Better Auth owner user ID.
pub async fn create_session_for_owner(
    pool: &PgPool,
    input: &CreateSessionInput,
    owner_id: Option<&str>,
) -> Result<Session, DbError> {
    let clean = input.validate()?;

    for attempt in 0..5 {
        let code = generate_session_code();
        let res = sqlx::query_as::<_, SessionRow>(
            "INSERT INTO sessions (code, title, client_label, owner_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id, code, title, client_label, status, current_activity_id, created_at, ended_at",
        )
        .bind(&code)
        .bind(&clean.title)
        .bind(&clean.client_label)
        .bind(owner_id)
        .fetch_one(pool)
        .await;

        match res {
            Ok(row) => return Session::try_from(row),
            Err(sqlx::Error::Database(db_err))
                if db_err.code().as_deref() == Some("23505") && attempt < 4 =>
            {
                continue;
            }
            Err(err) => return Err(err.into()),
        }
    }

    Err(DbError::Conflict(
        "failed to allocate unique session code".into(),
    ))
}

/// Lists all workshop sessions newest-first with participant and activity counts.
pub async fn list_sessions(pool: &PgPool) -> Result<Vec<SessionSummary>, DbError> {
    list_sessions_for_owner(pool, None).await
}

/// Lists workshop sessions newest-first, filtered by Better Auth owner user ID when provided.
pub async fn list_sessions_for_owner(
    pool: &PgPool,
    owner_id: Option<&str>,
) -> Result<Vec<SessionSummary>, DbError> {
    let rows = sqlx::query_as::<_, SessionSummaryRow>(
        "SELECT s.id, s.code, s.title, s.client_label, s.status,
                COUNT(DISTINCT p.id) AS participant_count,
                COUNT(DISTINCT a.id) AS activity_count,
                s.created_at, s.ended_at
         FROM sessions s
         LEFT JOIN participants p ON p.session_id = s.id
         LEFT JOIN activities a ON a.session_id = s.id
         WHERE ($1::text IS NULL OR s.owner_id = $1)
         GROUP BY s.id
         ORDER BY s.created_at DESC",
    )
    .bind(owner_id)
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(SessionSummary::try_from).collect()
}

/// Fetches a workshop session by normalized join code.
pub async fn get_session_by_code(pool: &PgPool, code: &str) -> Result<Session, DbError> {
    let norm = normalize_session_code(code)?;
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT id, code, title, client_label, status, current_activity_id, created_at, ended_at
         FROM sessions WHERE code = $1",
    )
    .bind(&norm)
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound("session"))?;

    Session::try_from(row)
}

/// Fetches a workshop session by its primary UUID.
pub async fn get_session_by_id(pool: &PgPool, id: Uuid) -> Result<Session, DbError> {
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT id, code, title, client_label, status, current_activity_id, created_at, ended_at
         FROM sessions WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound("session"))?;

    Session::try_from(row)
}

/// Atomically updates session lifecycle state, active activity pointer, and open/locked flag.
pub async fn update_session_state(
    pool: &PgPool,
    code: &str,
    input: &UpdateSessionStateInput,
) -> Result<RoomSnapshot, DbError> {
    let norm = normalize_session_code(code)?;
    input.validate()?;

    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT id, code, title, client_label, status, current_activity_id, created_at, ended_at
         FROM sessions WHERE code = $1 FOR UPDATE",
    )
    .bind(&norm)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(DbError::NotFound("session"))?;

    let current = Session::try_from(row)?;
    if current.status == SessionStatus::Ended {
        return Err(DbError::Conflict("ended session cannot be modified".into()));
    }

    let next_status = input.status.unwrap_or(current.status);
    if next_status == SessionStatus::Ended && input.is_open == Some(true) {
        return Err(DbError::Validation(
            "cannot open an activity when ending a session".into(),
        ));
    }

    let next_activity_id = match input.current_activity_id {
        Some(Some(aid)) => {
            let belongs: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM activities WHERE id = $1 AND session_id = $2)",
            )
            .bind(aid)
            .bind(current.id)
            .fetch_one(&mut *tx)
            .await?;
            if !belongs {
                return Err(DbError::Validation(
                    "activity does not belong to this session".into(),
                ));
            }
            Some(aid)
        }
        Some(None) => None,
        None => current.current_activity_id,
    };

    sqlx::query(
        "UPDATE sessions
         SET status = $2,
             current_activity_id = $3,
             ended_at = CASE WHEN $2 = 'ended' THEN COALESCE(ended_at, clock_timestamp()) ELSE ended_at END
         WHERE id = $1",
    )
    .bind(current.id)
    .bind(next_status.as_str())
    .bind(next_activity_id)
    .execute(&mut *tx)
    .await?;

    if next_status == SessionStatus::Ended {
        sqlx::query("UPDATE activities SET is_open = false WHERE session_id = $1")
            .bind(current.id)
            .execute(&mut *tx)
            .await?;
    } else if let Some(is_open) = input.is_open {
        let target_aid = next_activity_id
            .ok_or_else(|| DbError::Validation("no current activity to open or lock".into()))?;
        sqlx::query("UPDATE activities SET is_open = $1 WHERE id = $2 AND session_id = $3")
            .bind(is_open)
            .bind(target_aid)
            .bind(current.id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    get_room_snapshot(pool, &norm, true).await
}

/// Validates and appends a sequentially positioned activity to a workshop session.
pub async fn create_activity(
    pool: &PgPool,
    code: &str,
    input: &CreateActivityInput,
) -> Result<Activity, DbError> {
    let norm = normalize_session_code(code)?;
    let clean = input.validate()?;

    let mut tx = pool.begin().await?;
    let (session_id, status): (Uuid, String) =
        sqlx::query_as("SELECT id, status FROM sessions WHERE code = $1 FOR UPDATE")
            .bind(&norm)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(DbError::NotFound("session"))?;
    if status == SessionStatus::Ended.as_str() {
        return Err(DbError::Conflict("ended session cannot be modified".into()));
    }

    let next_pos: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM activities WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await?;

    let row = sqlx::query_as::<_, ActivityRow>(
        "INSERT INTO activities (session_id, position, kind, dimension, prompt, options)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, session_id, position, kind, dimension, prompt, options, is_open, created_at",
    )
    .bind(session_id)
    .bind(next_pos)
    .bind(clean.kind.as_str())
    .bind(clean.dimension.as_str())
    .bind(&clean.prompt)
    .bind(sqlx::types::Json(&clean.options))
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Activity::try_from(row)
}

/// Lists all activities for a session ordered by position ascending.
pub async fn list_activities_by_session(
    pool: &PgPool,
    session_id: Uuid,
) -> Result<Vec<Activity>, DbError> {
    let rows = sqlx::query_as::<_, ActivityRow>(
        "SELECT id, session_id, position, kind, dimension, prompt, options, is_open, created_at
         FROM activities WHERE session_id = $1 ORDER BY position ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    rows.into_iter().map(Activity::try_from).collect()
}

/// Joins a new participant or reconnects an existing participant scoped to the session.
pub async fn join_participant(
    pool: &PgPool,
    code: &str,
    input: &JoinSessionInput,
) -> Result<(Participant, bool), DbError> {
    let norm = normalize_session_code(code)?;
    let clean = input.validate()?;

    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT id, code, title, client_label, status, current_activity_id, created_at, ended_at
         FROM sessions WHERE code = $1 FOR SHARE",
    )
    .bind(&norm)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(DbError::NotFound("session"))?;
    let session = Session::try_from(row)?;

    if let Some(pid) = clean.participant_id {
        if let Some(existing) = sqlx::query_as::<_, ParticipantRow>(
            "SELECT id, session_id, nickname, joined_at
             FROM participants WHERE id = $1 AND session_id = $2",
        )
        .bind(pid)
        .bind(session.id)
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.commit().await?;
            return Ok((existing.into(), false));
        }
    }

    if session.status == SessionStatus::Ended {
        return Err(DbError::Conflict("cannot join an ended session".into()));
    }

    let row = sqlx::query_as::<_, ParticipantRow>(
        "INSERT INTO participants (session_id, nickname)
         VALUES ($1, $2)
         RETURNING id, session_id, nickname, joined_at",
    )
    .bind(session.id)
    .bind(&clean.nickname)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok((row.into(), true))
}

/// Counts all joined participants in a workshop session.
pub async fn count_participants(pool: &PgPool, session_id: Uuid) -> Result<i64, DbError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM participants WHERE session_id = $1")
        .bind(session_id)
        .fetch_one(pool)
        .await?;
    Ok(count)
}

/// Enqueued response write request for group-commit batch processing.
struct BatchUpsertReq {
    pool: PgPool,
    code: String,
    input: SubmitResponseInput,
    with_tally: bool,
    reply_tx: oneshot::Sender<Result<Option<ActivityTally>, DbError>>,
}

/// Spawns a persistent background group-commit batch processor for concurrent response submissions.
fn spawn_batch_worker() -> mpsc::UnboundedSender<BatchUpsertReq> {
    let (tx, mut rx) = mpsc::unbounded_channel::<BatchUpsertReq>();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("batch worker runtime");
        rt.block_on(async move {
            while let Some(first) = rx.recv().await {
                let mut batch = Vec::with_capacity(64);
                batch.push(first);
                for _ in 0..24 {
                    tokio::task::yield_now().await;
                    while batch.len() < 64 {
                        match rx.try_recv() {
                            Ok(req) => batch.push(req),
                            Err(_) => break,
                        }
                    }
                }
                process_upsert_batch(batch).await;
            }
        });
    });
    tx
}

/// Atomically validates and upserts a participant's response.
pub async fn upsert_response(
    pool: &PgPool,
    code: &str,
    input: &SubmitResponseInput,
) -> Result<(), DbError> {
    static TX: std::sync::OnceLock<
        std::sync::Mutex<Option<mpsc::UnboundedSender<BatchUpsertReq>>>,
    > = std::sync::OnceLock::new();
    let sender = {
        let mutex = TX.get_or_init(|| std::sync::Mutex::new(None));
        let mut guard = mutex.lock().expect("batch sender lock");
        match guard.as_ref() {
            Some(tx) if !tx.is_closed() => tx.clone(),
            _ => {
                let tx = spawn_batch_worker();
                *guard = Some(tx.clone());
                tx
            }
        }
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    sender
        .send(BatchUpsertReq {
            pool: pool.clone(),
            code: code.to_string(),
            input: input.clone(),
            with_tally: false,
            reply_tx,
        })
        .map_err(|_| DbError::Conflict("batch worker unavailable".into()))?;
    reply_rx
        .await
        .map_err(|_| DbError::Conflict("batch worker dropped".into()))??;
    Ok(())
}

/// Atomically validates and upserts a response and returns the post-commit ActivityTally.
pub async fn upsert_response_with_tally(
    pool: &PgPool,
    code: &str,
    input: &SubmitResponseInput,
) -> Result<ActivityTally, DbError> {
    static TX: std::sync::OnceLock<
        std::sync::Mutex<Option<mpsc::UnboundedSender<BatchUpsertReq>>>,
    > = std::sync::OnceLock::new();
    let sender = {
        let mutex = TX.get_or_init(|| std::sync::Mutex::new(None));
        let mut guard = mutex.lock().expect("batch sender lock");
        match guard.as_ref() {
            Some(tx) if !tx.is_closed() => tx.clone(),
            _ => {
                let tx = spawn_batch_worker();
                *guard = Some(tx.clone());
                tx
            }
        }
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    sender
        .send(BatchUpsertReq {
            pool: pool.clone(),
            code: code.to_string(),
            input: input.clone(),
            with_tally: true,
            reply_tx,
        })
        .map_err(|_| DbError::Conflict("batch worker unavailable".into()))?;
    let tally = reply_rx
        .await
        .map_err(|_| DbError::Conflict("batch worker dropped".into()))??
        .expect("tally requested");
    Ok(tally)
}

/// Processes a micro-batch of response submissions grouped by session code and activity ID.
async fn process_upsert_batch(batch: Vec<BatchUpsertReq>) {
    let mut groups: HashMap<(String, Uuid), Vec<BatchUpsertReq>> = HashMap::new();
    for req in batch {
        match normalize_session_code(&req.code) {
            Ok(norm) => {
                groups
                    .entry((norm, req.input.activity_id))
                    .or_default()
                    .push(req);
            }
            Err(e) => {
                let _ = req.reply_tx.send(Err(DbError::Validation(e.0)));
            }
        }
    }

    for ((norm_code, activity_id), reqs) in groups {
        let pool = reqs[0].pool.clone();
        process_group(&pool, &norm_code, activity_id, reqs).await;
    }
}

/// Validates and batch-upserts responses for a single (session_code, activity_id) group.
async fn process_group(
    pool: &PgPool,
    norm_code: &str,
    activity_id: Uuid,
    reqs: Vec<BatchUpsertReq>,
) {
    let candidate_pids: Vec<Uuid> = reqs.iter().map(|r| r.input.participant_id).collect();
    let target_res = sqlx::query_as::<_, ResponseTargetRow>(
        "SELECT s.id AS session_id, s.status AS session_status, s.current_activity_id,
                a.id AS activity_id, a.position, a.kind, a.dimension, a.prompt, a.options, a.is_open, a.created_at,
                ARRAY(SELECT p.id FROM participants p WHERE p.session_id = s.id AND p.id = ANY($3)) AS valid_pids
         FROM sessions s
         JOIN activities a ON a.session_id = s.id
         WHERE s.code = $1 AND a.id = $2",
    )
    .bind(norm_code)
    .bind(activity_id)
    .bind(&candidate_pids)
    .fetch_optional(pool)
    .await;

    let target = match target_res {
        Ok(Some(t)) => t,
        Ok(None) => {
            for r in reqs {
                let _ = r.reply_tx.send(Err(DbError::NotFound("activity")));
            }
            return;
        }
        Err(e) => {
            let msg = e.to_string();
            for r in reqs {
                let _ = r.reply_tx.send(Err(DbError::Validation(msg.clone())));
            }
            return;
        }
    };

    if target.session_status != SessionStatus::Active.as_str() {
        for r in reqs {
            let _ = r
                .reply_tx
                .send(Err(DbError::Conflict("session is not active".into())));
        }
        return;
    }
    if target.current_activity_id != Some(target.activity_id) {
        for r in reqs {
            let _ = r.reply_tx.send(Err(DbError::Conflict(
                "activity is not the active workshop item".into(),
            )));
        }
        return;
    }
    if !target.is_open {
        for r in reqs {
            let _ = r.reply_tx.send(Err(DbError::Conflict(
                "activity submissions are locked".into(),
            )));
        }
        return;
    }

    let valid_pids: HashSet<Uuid> = target.valid_pids.into_iter().collect();
    let activity = match (target.kind.parse(), target.dimension.parse()) {
        (Ok(kind), Ok(dimension)) => Activity {
            id: target.activity_id,
            session_id: target.session_id,
            position: target.position,
            kind,
            dimension,
            prompt: target.prompt,
            options: target.options.0,
            is_open: target.is_open,
            created_at: target.created_at,
        },
        _ => {
            for r in reqs {
                let _ = r
                    .reply_tx
                    .send(Err(DbError::Validation("invalid activity metadata".into())));
            }
            return;
        }
    };

    let mut accepted_waiters = Vec::with_capacity(reqs.len());
    let mut dedup_rows: HashMap<Uuid, crate::models::ValidatedResponse> = HashMap::new();
    let mut need_tally = false;

    for r in reqs {
        if !valid_pids.contains(&r.input.participant_id) {
            let _ = r.reply_tx.send(Err(DbError::Validation(
                "participant does not belong to this session".into(),
            )));
            continue;
        }
        match r.input.validate_for(&activity) {
            Ok(clean) => {
                if r.with_tally {
                    need_tally = true;
                }
                dedup_rows.insert(r.input.participant_id, clean);
                accepted_waiters.push((r.with_tally, r.reply_tx));
            }
            Err(ve) => {
                let _ = r.reply_tx.send(Err(DbError::Validation(ve.0)));
            }
        }
    }

    if accepted_waiters.is_empty() {
        return;
    }

    let mut pids = Vec::with_capacity(dedup_rows.len());
    let mut choices = Vec::with_capacity(dedup_rows.len());
    let mut ratings = Vec::with_capacity(dedup_rows.len());
    let mut texts = Vec::with_capacity(dedup_rows.len());

    for (pid, clean) in dedup_rows {
        pids.push(pid);
        choices.push(clean.choice_index);
        ratings.push(clean.rating_value);
        texts.push(clean.text_value);
    }

    let insert_res = sqlx::query(
        "INSERT INTO responses (session_id, activity_id, participant_id, choice_index, rating_value, text_value)
         SELECT $1, $2, u.participant_id, u.choice_index, u.rating_value, u.text_value
         FROM UNNEST($3::uuid[], $4::int4[], $5::int4[], $6::text[])
              AS u(participant_id, choice_index, rating_value, text_value)
         ON CONFLICT (activity_id, participant_id)
         DO UPDATE SET choice_index = EXCLUDED.choice_index,
                       rating_value = EXCLUDED.rating_value,
                       text_value = EXCLUDED.text_value,
                       submitted_at = now()",
    )
    .bind(target.session_id)
    .bind(activity.id)
    .bind(&pids)
    .bind(&choices)
    .bind(&ratings)
    .bind(&texts)
    .execute(pool)
    .await;

    if let Err(e) = insert_res {
        let msg = e.to_string();
        for (_, tx) in accepted_waiters {
            let _ = tx.send(Err(DbError::Validation(msg.clone())));
        }
        return;
    }

    let tally = if need_tally {
        match build_activity_tally(pool, &activity).await {
            Ok(t) => Some(t),
            Err(e) => {
                let msg = e.to_string();
                for (_, tx) in accepted_waiters {
                    let _ = tx.send(Err(DbError::Validation(msg.clone())));
                }
                return;
            }
        }
    } else {
        None
    };

    for (want_tally, tx) in accepted_waiters {
        let _ = tx.send(Ok(if want_tally { tally.clone() } else { None }));
    }
}

/// Computes aggregated response counts, rating stats, or anonymized quotes for one activity.
async fn build_activity_tally(
    pool: &PgPool,
    activity: &Activity,
) -> Result<ActivityTally, DbError> {
    let mut poll_counts = Vec::new();
    let mut rating_histogram = [0i64; 5];
    let mut rating_mean = None;
    let mut open_answers = Vec::new();
    let mut response_count = 0i64;

    match activity.kind {
        ActivityKind::Poll => {
            poll_counts = vec![0i64; activity.options.len()];
            let rows: Vec<(i32, i64)> = sqlx::query_as(
                "SELECT choice_index, COUNT(*) AS cnt
                 FROM responses
                 WHERE activity_id = $1 AND choice_index IS NOT NULL
                 GROUP BY choice_index",
            )
            .bind(activity.id)
            .fetch_all(pool)
            .await?;

            for (idx, cnt) in rows {
                if idx >= 0 && (idx as usize) < poll_counts.len() {
                    poll_counts[idx as usize] = cnt;
                    response_count += cnt;
                }
            }
        }
        ActivityKind::Rating => {
            let rows: Vec<(i32, i64)> = sqlx::query_as(
                "SELECT rating_value, COUNT(*) AS cnt
                 FROM responses
                 WHERE activity_id = $1 AND rating_value IS NOT NULL
                 GROUP BY rating_value",
            )
            .bind(activity.id)
            .fetch_all(pool)
            .await?;

            for (val, cnt) in rows {
                if (1..=5).contains(&val) {
                    rating_histogram[(val - 1) as usize] = cnt;
                }
            }

            let (cnt, mean): (i64, Option<f64>) = sqlx::query_as(
                "SELECT COUNT(rating_value), AVG(rating_value)::DOUBLE PRECISION
                 FROM responses
                 WHERE activity_id = $1 AND rating_value IS NOT NULL",
            )
            .bind(activity.id)
            .fetch_one(pool)
            .await?;
            response_count = cnt;
            rating_mean = mean;
        }
        ActivityKind::OpenAnswer => {
            let rows: Vec<(String, DateTime<Utc>)> = sqlx::query_as(
                "SELECT text_value, submitted_at
                 FROM responses
                 WHERE activity_id = $1 AND text_value IS NOT NULL
                 ORDER BY submitted_at DESC",
            )
            .bind(activity.id)
            .fetch_all(pool)
            .await?;

            response_count = rows.len() as i64;
            open_answers = rows
                .into_iter()
                .map(|(text, submitted_at)| OpenAnswerQuote {
                    activity_id: activity.id,
                    prompt: activity.prompt.clone(),
                    dimension: activity.dimension,
                    text,
                    submitted_at,
                })
                .collect();
        }
    }

    Ok(ActivityTally {
        activity_id: activity.id,
        kind: activity.kind,
        dimension: activity.dimension,
        prompt: activity.prompt.clone(),
        response_count,
        poll_counts,
        rating_histogram,
        rating_mean,
        open_answers,
    })
}

/// Fetches aggregated tally statistics for a single activity by ID.
pub async fn get_activity_tally(
    pool: &PgPool,
    activity_id: Uuid,
) -> Result<ActivityTally, DbError> {
    let row = sqlx::query_as::<_, ActivityRow>(
        "SELECT id, session_id, position, kind, dimension, prompt, options, is_open, created_at
         FROM activities WHERE id = $1",
    )
    .bind(activity_id)
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound("activity"))?;

    let activity = Activity::try_from(row)?;
    build_activity_tally(pool, &activity).await
}

/// Fetches the live room snapshot for a session, optionally including the active tally.
pub async fn get_room_snapshot(
    pool: &PgPool,
    code: &str,
    include_tally: bool,
) -> Result<RoomSnapshot, DbError> {
    let session = get_session_by_code(pool, code).await?;
    let activities = list_activities_by_session(pool, session.id).await?;
    let participant_count = count_participants(pool, session.id).await?;

    let current_tally = if include_tally {
        if let Some(aid) = session.current_activity_id {
            if let Some(act) = activities.iter().find(|a| a.id == aid) {
                Some(build_activity_tally(pool, act).await?)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    Ok(RoomSnapshot {
        session,
        activities,
        participant_count,
        current_tally,
    })
}

/// Builds a DimensionSummary from PostgreSQL dimension metrics and matching activity tallies.
fn build_dimension_summary(
    dim: HrDimension,
    agg: Option<&DimensionAggRow>,
    activities: &[Activity],
    tallies: &[ActivityTally],
) -> DimensionSummary {
    let mut top_poll_findings = Vec::new();
    let mut quotes = Vec::new();

    for (activity, tally) in activities.iter().zip(tallies.iter()) {
        if activity.dimension != dim {
            continue;
        }
        if activity.kind == ActivityKind::Poll && tally.response_count > 0 {
            if let Some((idx, &max_cnt)) = tally
                .poll_counts
                .iter()
                .enumerate()
                .max_by_key(|(_, cnt)| *cnt)
            {
                if max_cnt > 0 {
                    if let Some(opt) = activity.options.get(idx) {
                        top_poll_findings.push(format!(
                            "{}: {} ({}/{})",
                            activity.prompt, opt, max_cnt, tally.response_count
                        ));
                    }
                }
            }
        }
        quotes.extend(tally.open_answers.iter().cloned());
    }

    DimensionSummary {
        activity_count: agg.map_or(0, |r| r.activity_count),
        response_count: agg.map_or(0, |r| r.response_count),
        average_rating: agg.and_then(|r| r.avg_rating),
        top_poll_findings,
        quotes,
    }
}

/// Generates deterministic PostgreSQL post-session HR insights grouped by dimension.
pub async fn get_hr_insights(pool: &PgPool, code: &str) -> Result<HrInsights, DbError> {
    let session = get_session_by_code(pool, code).await?;
    let participant_count = count_participants(pool, session.id).await?;
    let activities = list_activities_by_session(pool, session.id).await?;

    let mut tallies = Vec::with_capacity(activities.len());
    for activity in &activities {
        tallies.push(build_activity_tally(pool, activity).await?);
    }

    let agg_rows = sqlx::query_as::<_, DimensionAggRow>(
        "SELECT a.dimension,
                COUNT(DISTINCT a.id) AS activity_count,
                COUNT(r.id) AS response_count,
                AVG(r.rating_value)::DOUBLE PRECISION AS avg_rating
         FROM activities a
         LEFT JOIN responses r ON r.activity_id = a.id
         WHERE a.session_id = $1
         GROUP BY a.dimension",
    )
    .bind(session.id)
    .fetch_all(pool)
    .await?;

    let mut agg_map = HashMap::new();
    for row in agg_rows {
        let dim: HrDimension = row.dimension.parse()?;
        agg_map.insert(dim.as_str(), row);
    }

    let total_responses: i64 = tallies.iter().map(|t| t.response_count).sum();
    let possible = participant_count * (activities.len() as i64);
    let response_rate = if possible == 0 {
        0.0
    } else {
        (total_responses as f64 / possible as f64) * 100.0
    };

    let strengths = build_dimension_summary(
        HrDimension::Strength,
        agg_map.get("strength"),
        &activities,
        &tallies,
    );
    let weaknesses = build_dimension_summary(
        HrDimension::Weakness,
        agg_map.get("weakness"),
        &activities,
        &tallies,
    );
    let blockers = build_dimension_summary(
        HrDimension::Blocker,
        agg_map.get("blocker"),
        &activities,
        &tallies,
    );

    Ok(HrInsights {
        session,
        participant_count,
        response_rate,
        strengths,
        weaknesses,
        blockers,
        activities: tallies,
    })
}

/// Reads a persisted runtime control value by key.
pub async fn get_control(pool: &PgPool, key: &str) -> Result<Option<String>, DbError> {
    let val = sqlx::query_scalar("SELECT value FROM app_controls WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(val)
}

/// Persists or updates a runtime control key-value entry.
pub async fn set_control(pool: &PgPool, key: &str, value: &str) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO app_controls (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}
