use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::{Barrier, OnceCell};
use uuid::Uuid;

use workshop_backend::db::{self, DbError};
use workshop_backend::models::{
    ActivityKind, CreateActivityInput, CreateSessionInput, HrDimension, JoinSessionInput,
    SessionStatus, SubmitResponseInput, UpdateSessionStateInput,
};

/// One-time migration guard across parallel integration tests.
static MIGRATED: OnceCell<()> = OnceCell::const_new();

/// Loads DATABASE_URL from environment or ../.env without hardcoding credentials.
fn database_url_from_env() -> String {
    let _ = dotenvy::from_filename("../.env");
    let _ = dotenvy::dotenv();
    std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set in environment or ../.env to run integration tests")
}

/// Ensures migrations ran once and opens a runtime-local pool for the calling test.
async fn test_pool() -> PgPool {
    let url = database_url_from_env();
    MIGRATED
        .get_or_init(|| async {
            let pool = db::connect_and_migrate(&url)
                .await
                .expect("connect_and_migrate should succeed");
            pool.close().await;
        })
        .await;
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("test PgPool should connect")
}

/// Verifies migrations are idempotent and create all five core schema tables.
#[tokio::test]
async fn test_migrations_are_idempotent() {
    let url = database_url_from_env();
    let pool1 = db::connect_and_migrate(&url).await.unwrap();
    let pool2 = db::connect_and_migrate(&url).await.unwrap();

    for table in [
        "sessions",
        "activities",
        "participants",
        "responses",
        "app_controls",
    ] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = $1
            )",
        )
        .bind(table)
        .fetch_one(&pool2)
        .await
        .unwrap();
        assert!(exists, "expected table {table} to exist");
    }

    pool1.close().await;
    pool2.close().await;
}

/// Verifies session creation, listing, case-insensitive lookup, and state transitions.
#[tokio::test]
async fn test_session_lifecycle_and_state_transitions() {
    let pool = &test_pool().await;
    let created = db::create_session(
        pool,
        &CreateSessionInput {
            title: "First-Time Manager Cohort".into(),
            client_label: "Test Org".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(created.status, SessionStatus::Lobby);
    assert!(created.ended_at.is_none());

    let listed = db::list_sessions(pool).await.unwrap();
    assert!(listed.iter().any(|s| s.id == created.id));

    let fetched = db::get_session_by_code(pool, &created.code.to_lowercase())
        .await
        .unwrap();
    assert_eq!(fetched.id, created.id);
    assert_eq!(
        db::get_session_by_id(pool, created.id).await.unwrap().code,
        created.code
    );

    let act = db::create_activity(
        pool,
        &created.code,
        &CreateActivityInput {
            kind: ActivityKind::Poll,
            dimension: HrDimension::Strength,
            prompt: "Top skill?".into(),
            options: vec!["Listening".into(), "Delegating".into()],
        },
    )
    .await
    .unwrap();

    let active_snap = db::update_session_state(
        pool,
        &created.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Active),
            current_activity_id: Some(Some(act.id)),
            is_open: Some(false),
        },
    )
    .await
    .unwrap();
    assert_eq!(active_snap.session.status, SessionStatus::Active);
    assert_eq!(active_snap.session.current_activity_id, Some(act.id));
    assert!(!active_snap.activities[0].is_open);

    let ended_snap = db::update_session_state(
        pool,
        &created.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Ended),
            current_activity_id: Some(None),
            is_open: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(ended_snap.session.status, SessionStatus::Ended);
    assert!(ended_snap.session.ended_at.is_some());
    assert_eq!(ended_snap.session.current_activity_id, None);

    let reopen_err = db::update_session_state(
        pool,
        &created.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Active),
            current_activity_id: None,
            is_open: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(reopen_err, DbError::Conflict(_)));

    let missing_err = db::get_session_by_code(pool, "ZZZZ99").await.unwrap_err();
    assert!(matches!(missing_err, DbError::NotFound(_)));
}

/// Verifies sequential activity ordering and input validation enforcement.
#[tokio::test]
async fn test_activity_creation_ordering_and_validation() {
    let pool = &test_pool().await;
    let session = db::create_session(
        pool,
        &CreateSessionInput {
            title: "Ordering Check".into(),
            client_label: String::new(),
        },
    )
    .await
    .unwrap();

    let a1 = db::create_activity(
        pool,
        &session.code,
        &CreateActivityInput {
            kind: ActivityKind::Poll,
            dimension: HrDimension::Strength,
            prompt: "Poll Q".into(),
            options: vec!["A".into(), "B".into()],
        },
    )
    .await
    .unwrap();
    let a2 = db::create_activity(
        pool,
        &session.code,
        &CreateActivityInput {
            kind: ActivityKind::Rating,
            dimension: HrDimension::Weakness,
            prompt: "Rating Q".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();
    let a3 = db::create_activity(
        pool,
        &session.code,
        &CreateActivityInput {
            kind: ActivityKind::OpenAnswer,
            dimension: HrDimension::Blocker,
            prompt: "Open Q".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();

    assert_eq!((a1.position, a2.position, a3.position), (1, 2, 3));
    let listed = db::list_activities_by_session(pool, session.id)
        .await
        .unwrap();
    assert_eq!(listed.len(), 3);

    let bad_prompt = db::create_activity(
        pool,
        &session.code,
        &CreateActivityInput {
            kind: ActivityKind::OpenAnswer,
            dimension: HrDimension::General,
            prompt: "   ".into(),
            options: vec![],
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(bad_prompt, DbError::Validation(_)));

    let bad_poll = db::create_activity(
        pool,
        &session.code,
        &CreateActivityInput {
            kind: ActivityKind::Poll,
            dimension: HrDimension::General,
            prompt: "Need 2 choices".into(),
            options: vec!["Only one".into()],
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(bad_poll, DbError::Validation(_)));
}

/// Verifies participant join, same-session reconnect, and cross-session isolation.
#[tokio::test]
async fn test_participant_join_reconnect_and_session_isolation() {
    let pool = &test_pool().await;
    let sess_a = db::create_session(
        pool,
        &CreateSessionInput {
            title: "Session A".into(),
            client_label: String::new(),
        },
    )
    .await
    .unwrap();
    let sess_b = db::create_session(
        pool,
        &CreateSessionInput {
            title: "Session B".into(),
            client_label: String::new(),
        },
    )
    .await
    .unwrap();

    let (p1, is_new1) = db::join_participant(
        pool,
        &sess_a.code,
        &JoinSessionInput {
            nickname: "Alex".into(),
            participant_id: None,
        },
    )
    .await
    .unwrap();
    assert!(is_new1);

    let (p1_re, is_new_re) = db::join_participant(
        pool,
        &sess_a.code,
        &JoinSessionInput {
            nickname: "Alex".into(),
            participant_id: Some(p1.id),
        },
    )
    .await
    .unwrap();
    assert!(!is_new_re);
    assert_eq!(p1_re.id, p1.id);
    assert_eq!(db::count_participants(pool, sess_a.id).await.unwrap(), 1);

    let (p_b, is_new_b) = db::join_participant(
        pool,
        &sess_b.code,
        &JoinSessionInput {
            nickname: "Alex".into(),
            participant_id: Some(p1.id),
        },
    )
    .await
    .unwrap();
    assert!(is_new_b);
    assert_ne!(p_b.id, p1.id);
    assert_eq!(db::count_participants(pool, sess_a.id).await.unwrap(), 1);
    assert_eq!(db::count_participants(pool, sess_b.id).await.unwrap(), 1);
}

/// Verifies atomic response upserts and state/validation/cross-session rejections.
#[tokio::test]
async fn test_atomic_response_upsert_and_validation() {
    let pool = &test_pool().await;
    let sess = db::create_session(
        pool,
        &CreateSessionInput {
            title: "Upsert Session".into(),
            client_label: String::new(),
        },
    )
    .await
    .unwrap();
    let other_sess = db::create_session(
        pool,
        &CreateSessionInput {
            title: "Other Session".into(),
            client_label: String::new(),
        },
    )
    .await
    .unwrap();

    let poll = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::Poll,
            dimension: HrDimension::Strength,
            prompt: "Pick one".into(),
            options: vec!["Alpha".into(), "Beta".into()],
        },
    )
    .await
    .unwrap();
    let rating = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::Rating,
            dimension: HrDimension::Weakness,
            prompt: "Rate 1-5".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();

    let (p1, _) = db::join_participant(
        pool,
        &sess.code,
        &JoinSessionInput {
            nickname: "Sam".into(),
            participant_id: None,
        },
    )
    .await
    .unwrap();
    let (p_other, _) = db::join_participant(
        pool,
        &other_sess.code,
        &JoinSessionInput {
            nickname: "Intruder".into(),
            participant_id: None,
        },
    )
    .await
    .unwrap();

    let lobby_err = db::upsert_response(
        pool,
        &sess.code,
        &SubmitResponseInput {
            participant_id: p1.id,
            activity_id: poll.id,
            choice_index: Some(0),
            rating_value: None,
            text_value: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(lobby_err, DbError::Conflict(_)));

    db::update_session_state(
        pool,
        &sess.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Active),
            current_activity_id: Some(Some(poll.id)),
            is_open: Some(true),
        },
    )
    .await
    .unwrap();

    db::upsert_response(
        pool,
        &sess.code,
        &SubmitResponseInput {
            participant_id: p1.id,
            activity_id: poll.id,
            choice_index: Some(0),
            rating_value: None,
            text_value: None,
        },
    )
    .await
    .unwrap();
    db::upsert_response(
        pool,
        &sess.code,
        &SubmitResponseInput {
            participant_id: p1.id,
            activity_id: poll.id,
            choice_index: Some(1),
            rating_value: None,
            text_value: None,
        },
    )
    .await
    .unwrap();

    let tally = db::get_activity_tally(pool, poll.id).await.unwrap();
    assert_eq!(tally.response_count, 1);
    assert_eq!(tally.poll_counts, vec![0, 1]);

    let bad_idx = db::upsert_response(
        pool,
        &sess.code,
        &SubmitResponseInput {
            participant_id: p1.id,
            activity_id: poll.id,
            choice_index: Some(5),
            rating_value: None,
            text_value: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(bad_idx, DbError::Validation(_)));

    let spoof_err = db::upsert_response(
        pool,
        &sess.code,
        &SubmitResponseInput {
            participant_id: p_other.id,
            activity_id: poll.id,
            choice_index: Some(0),
            rating_value: None,
            text_value: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(spoof_err, DbError::Validation(_)));

    let wrong_act = db::upsert_response(
        pool,
        &sess.code,
        &SubmitResponseInput {
            participant_id: p1.id,
            activity_id: rating.id,
            choice_index: None,
            rating_value: Some(4),
            text_value: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(wrong_act, DbError::Conflict(_)));

    db::update_session_state(
        pool,
        &sess.code,
        &UpdateSessionStateInput {
            status: None,
            current_activity_id: None,
            is_open: Some(false),
        },
    )
    .await
    .unwrap();

    let locked_err = db::upsert_response(
        pool,
        &sess.code,
        &SubmitResponseInput {
            participant_id: p1.id,
            activity_id: poll.id,
            choice_index: Some(0),
            rating_value: None,
            text_value: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(locked_err, DbError::Conflict(_)));
}

/// Verifies poll, rating, and anonymized open-answer tallies plus zero-response safety.
#[tokio::test]
async fn test_activity_tallies_poll_rating_open_answer() {
    let pool = &test_pool().await;
    let sess = db::create_session(
        pool,
        &CreateSessionInput {
            title: "Tally Session".into(),
            client_label: String::new(),
        },
    )
    .await
    .unwrap();

    let poll = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::Poll,
            dimension: HrDimension::Strength,
            prompt: "Poll".into(),
            options: vec!["X".into(), "Y".into(), "Z".into()],
        },
    )
    .await
    .unwrap();
    let rating = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::Rating,
            dimension: HrDimension::Weakness,
            prompt: "Rate".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();
    let open = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::OpenAnswer,
            dimension: HrDimension::Blocker,
            prompt: "Share blocker".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();
    let empty_rating = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::Rating,
            dimension: HrDimension::General,
            prompt: "Unused".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();

    let mut pids = Vec::new();
    for name in ["P1", "P2", "P3"] {
        let (p, _) = db::join_participant(
            pool,
            &sess.code,
            &JoinSessionInput {
                nickname: name.into(),
                participant_id: None,
            },
        )
        .await
        .unwrap();
        pids.push(p.id);
    }

    db::update_session_state(
        pool,
        &sess.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Active),
            current_activity_id: Some(Some(poll.id)),
            is_open: Some(true),
        },
    )
    .await
    .unwrap();
    for (pid, idx) in [(pids[0], 0), (pids[1], 0), (pids[2], 1)] {
        db::upsert_response(
            pool,
            &sess.code,
            &SubmitResponseInput {
                participant_id: pid,
                activity_id: poll.id,
                choice_index: Some(idx),
                rating_value: None,
                text_value: None,
            },
        )
        .await
        .unwrap();
    }

    db::update_session_state(
        pool,
        &sess.code,
        &UpdateSessionStateInput {
            status: None,
            current_activity_id: Some(Some(rating.id)),
            is_open: Some(true),
        },
    )
    .await
    .unwrap();
    for (pid, score) in [(pids[0], 3), (pids[1], 4), (pids[2], 5)] {
        db::upsert_response(
            pool,
            &sess.code,
            &SubmitResponseInput {
                participant_id: pid,
                activity_id: rating.id,
                choice_index: None,
                rating_value: Some(score),
                text_value: None,
            },
        )
        .await
        .unwrap();
    }

    db::update_session_state(
        pool,
        &sess.code,
        &UpdateSessionStateInput {
            status: None,
            current_activity_id: Some(Some(open.id)),
            is_open: Some(true),
        },
    )
    .await
    .unwrap();
    db::upsert_response(
        pool,
        &sess.code,
        &SubmitResponseInput {
            participant_id: pids[0],
            activity_id: open.id,
            choice_index: None,
            rating_value: None,
            text_value: Some("Unclear expectations".into()),
        },
    )
    .await
    .unwrap();

    let poll_tally = db::get_activity_tally(pool, poll.id).await.unwrap();
    assert_eq!(poll_tally.poll_counts, vec![2, 1, 0]);
    assert_eq!(poll_tally.response_count, 3);

    let rating_tally = db::get_activity_tally(pool, rating.id).await.unwrap();
    assert_eq!(rating_tally.rating_histogram, [0, 0, 1, 1, 1]);
    assert_eq!(rating_tally.rating_mean, Some(4.0));

    let open_tally = db::get_activity_tally(pool, open.id).await.unwrap();
    assert_eq!(open_tally.open_answers.len(), 1);
    assert_eq!(open_tally.open_answers[0].text, "Unclear expectations");

    let empty_tally = db::get_activity_tally(pool, empty_rating.id).await.unwrap();
    assert_eq!(empty_tally.response_count, 0);
    assert_eq!(empty_tally.rating_mean, None);
    assert_eq!(empty_tally.rating_histogram, [0, 0, 0, 0, 0]);
}

/// Verifies HR dimension insights aggregation and zero-participant response rate safety.
#[tokio::test]
async fn test_hr_dimension_insights() {
    let pool = &test_pool().await;
    let empty_sess = db::create_session(
        pool,
        &CreateSessionInput {
            title: "Empty Insights".into(),
            client_label: String::new(),
        },
    )
    .await
    .unwrap();
    let empty_insights = db::get_hr_insights(pool, &empty_sess.code).await.unwrap();
    assert_eq!(empty_insights.participant_count, 0);
    assert_eq!(empty_insights.response_rate, 0.0);

    let sess = db::create_session(
        pool,
        &CreateSessionInput {
            title: "HR Insights Check".into(),
            client_label: "Cohort B".into(),
        },
    )
    .await
    .unwrap();
    let strength_poll = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::Poll,
            dimension: HrDimension::Strength,
            prompt: "Team strength".into(),
            options: vec!["Empathy".into(), "Speed".into()],
        },
    )
    .await
    .unwrap();
    let weakness_rate = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::Rating,
            dimension: HrDimension::Weakness,
            prompt: "Delegation comfort".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();
    let blocker_open = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::OpenAnswer,
            dimension: HrDimension::Blocker,
            prompt: "Biggest blocker".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();

    let (p1, _) = db::join_participant(
        pool,
        &sess.code,
        &JoinSessionInput {
            nickname: "Jordan".into(),
            participant_id: None,
        },
    )
    .await
    .unwrap();

    for (aid, choice, rate, txt) in [
        (strength_poll.id, Some(0), None, None),
        (weakness_rate.id, None, Some(2), None),
        (blocker_open.id, None, None, Some("Approval bottlenecks")),
    ] {
        db::update_session_state(
            pool,
            &sess.code,
            &UpdateSessionStateInput {
                status: Some(SessionStatus::Active),
                current_activity_id: Some(Some(aid)),
                is_open: Some(true),
            },
        )
        .await
        .unwrap();
        db::upsert_response(
            pool,
            &sess.code,
            &SubmitResponseInput {
                participant_id: p1.id,
                activity_id: aid,
                choice_index: choice,
                rating_value: rate,
                text_value: txt.map(String::from),
            },
        )
        .await
        .unwrap();
    }

    let insights = db::get_hr_insights(pool, &sess.code).await.unwrap();
    assert_eq!(insights.participant_count, 1);
    assert!((insights.response_rate - 100.0).abs() < 0.001);
    assert_eq!(insights.strengths.activity_count, 1);
    assert_eq!(insights.strengths.response_count, 1);
    assert_eq!(
        insights.strengths.top_poll_findings,
        vec!["Team strength: Empathy (1/1)"]
    );
    assert_eq!(insights.weaknesses.average_rating, Some(2.0));
    assert_eq!(insights.blockers.quotes.len(), 1);
    assert_eq!(insights.blockers.quotes[0].text, "Approval bottlenecks");
    assert_eq!(insights.activities.len(), 3);
}

/// Verifies app_controls key-value persistence and idempotent updates.
#[tokio::test]
async fn test_app_controls_read_write() {
    let pool = &test_pool().await;
    let key = format!("demo_active_test_{}", Uuid::new_v4());

    assert_eq!(db::get_control(pool, &key).await.unwrap(), None);
    db::set_control(pool, &key, "false").await.unwrap();
    assert_eq!(
        db::get_control(pool, &key).await.unwrap().as_deref(),
        Some("false")
    );
    db::set_control(pool, &key, "true").await.unwrap();
    assert_eq!(
        db::get_control(pool, &key).await.unwrap().as_deref(),
        Some("true")
    );
}

/// Verifies ended sessions reject new activities, reject is_open=true on end, and lock activities.
#[tokio::test]
async fn test_ended_session_rejects_new_activity_and_opening_activity() {
    let pool = &test_pool().await;
    let sess = db::create_session(
        pool,
        &CreateSessionInput {
            title: "End Guards".into(),
            client_label: String::new(),
        },
    )
    .await
    .unwrap();
    let act = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::Rating,
            dimension: HrDimension::Strength,
            prompt: "Clarity?".into(),
            options: vec![],
        },
    )
    .await
    .unwrap();

    db::update_session_state(
        pool,
        &sess.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Active),
            current_activity_id: Some(Some(act.id)),
            is_open: Some(true),
        },
    )
    .await
    .unwrap();

    let open_on_end_err = db::update_session_state(
        pool,
        &sess.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Ended),
            current_activity_id: None,
            is_open: Some(true),
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(open_on_end_err, DbError::Validation(_)));
    assert_eq!(
        db::get_session_by_id(pool, sess.id).await.unwrap().status,
        SessionStatus::Active
    );

    let ended_snap = db::update_session_state(
        pool,
        &sess.code,
        &UpdateSessionStateInput {
            status: Some(SessionStatus::Ended),
            current_activity_id: None,
            is_open: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(ended_snap.session.status, SessionStatus::Ended);
    assert!(ended_snap.activities.iter().all(|a| !a.is_open));

    let create_after_end_err = db::create_activity(
        pool,
        &sess.code,
        &CreateActivityInput {
            kind: ActivityKind::OpenAnswer,
            dimension: HrDimension::Blocker,
            prompt: "Late activity".into(),
            options: vec![],
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(create_after_end_err, DbError::Conflict(_)));
}

/// Verifies concurrent join_participant vs update_session_state(Ended) never produces joined_at > ended_at.
#[tokio::test]
async fn test_concurrent_join_vs_end_session_has_no_toctou_race() {
    let pool = test_pool().await;

    for round in 0..25 {
        let sess = db::create_session(
            &pool,
            &CreateSessionInput {
                title: format!("Race Round {round}"),
                client_label: String::new(),
            },
        )
        .await
        .unwrap();

        let barrier = Arc::new(Barrier::new(6));
        let end_pool = pool.clone();
        let end_code = sess.code.clone();
        let end_barrier = barrier.clone();
        let end_task = tokio::spawn(async move {
            end_barrier.wait().await;
            db::update_session_state(
                &end_pool,
                &end_code,
                &UpdateSessionStateInput {
                    status: Some(SessionStatus::Ended),
                    current_activity_id: None,
                    is_open: None,
                },
            )
            .await
        });

        let mut join_tasks = Vec::with_capacity(5);
        for idx in 0..5 {
            let j_pool = pool.clone();
            let j_code = sess.code.clone();
            let j_barrier = barrier.clone();
            join_tasks.push(tokio::spawn(async move {
                j_barrier.wait().await;
                db::join_participant(
                    &j_pool,
                    &j_code,
                    &JoinSessionInput {
                        nickname: format!("Runner{idx}"),
                        participant_id: None,
                    },
                )
                .await
            }));
        }

        end_task.await.unwrap().unwrap();
        let mut accepted = 0i64;
        for handle in join_tasks {
            match handle.await.unwrap() {
                Ok((_, is_new)) => {
                    assert!(is_new);
                    accepted += 1;
                }
                Err(DbError::Conflict(_)) => {}
                Err(other) => panic!("unexpected join error during end race: {other}"),
            }
        }

        let late_violations: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
             FROM participants p
             JOIN sessions s ON s.id = p.session_id
             WHERE s.id = $1 AND p.joined_at > s.ended_at",
        )
        .bind(sess.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            late_violations, 0,
            "round {round} produced participant with joined_at > ended_at"
        );
        assert_eq!(
            db::count_participants(&pool, sess.id).await.unwrap(),
            accepted
        );

        let post_end_err = db::join_participant(
            &pool,
            &sess.code,
            &JoinSessionInput {
                nickname: "AfterEnd".into(),
                participant_id: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(post_end_err, DbError::Conflict(_)));
    }
}
