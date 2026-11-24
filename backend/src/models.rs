use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

/// Maximum allowed characters for a workshop session title.
pub const MAX_TITLE_LEN: usize = 160;
/// Maximum allowed characters for a client or cohort label.
pub const MAX_CLIENT_LABEL_LEN: usize = 120;
/// Maximum allowed characters for an activity prompt.
pub const MAX_PROMPT_LEN: usize = 500;
/// Minimum required choices for a poll activity.
pub const MIN_POLL_OPTIONS: usize = 2;
/// Maximum allowed choices for a poll activity.
pub const MAX_POLL_OPTIONS: usize = 12;
/// Maximum allowed characters for a single poll option.
pub const MAX_OPTION_LEN: usize = 160;
/// Maximum allowed characters for a participant nickname.
pub const MAX_NICKNAME_LEN: usize = 50;
/// Maximum allowed characters for an open-answer submission.
pub const MAX_OPEN_ANSWER_LEN: usize = 1000;
/// Minimum valid rating score on the Likert scale.
pub const MIN_RATING: i32 = 1;
/// Maximum valid rating score on the Likert scale.
pub const MAX_RATING: i32 = 5;

/// Error returned when an input payload fails domain validation rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError(pub String);

impl fmt::Display for ValidationError {
    /// Writes the domain validation failure message.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ValidationError {}

/// Lifecycle state of a live workshop session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Lobby,
    Active,
    Ended,
}

impl SessionStatus {
    /// Returns the canonical database string representation of the status.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lobby => "lobby",
            Self::Active => "active",
            Self::Ended => "ended",
        }
    }
}

impl FromStr for SessionStatus {
    type Err = ValidationError;

    /// Parses a session status string from external or database input.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "lobby" => Ok(Self::Lobby),
            "active" => Ok(Self::Active),
            "ended" => Ok(Self::Ended),
            other => Err(ValidationError(format!(
                "invalid session status: '{other}'"
            ))),
        }
    }
}

/// Supported workshop interaction activity formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    Poll,
    Rating,
    OpenAnswer,
}

impl ActivityKind {
    /// Returns the canonical database string representation of the activity kind.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Poll => "poll",
            Self::Rating => "rating",
            Self::OpenAnswer => "open_answer",
        }
    }
}

impl FromStr for ActivityKind {
    type Err = ValidationError;

    /// Parses an activity kind string from external or database input.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "poll" => Ok(Self::Poll),
            "rating" => Ok(Self::Rating),
            "open_answer" => Ok(Self::OpenAnswer),
            other => Err(ValidationError(format!("invalid activity kind: '{other}'"))),
        }
    }
}

/// HR insight category mapped to an activity for post-session reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HrDimension {
    Strength,
    Weakness,
    Blocker,
    #[default]
    General,
}

impl HrDimension {
    /// Returns the canonical database string representation of the HR dimension.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strength => "strength",
            Self::Weakness => "weakness",
            Self::Blocker => "blocker",
            Self::General => "general",
        }
    }
}

impl FromStr for HrDimension {
    type Err = ValidationError;

    /// Parses an HR dimension string from external or database input.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "strength" => Ok(Self::Strength),
            "weakness" => Ok(Self::Weakness),
            "blocker" => Ok(Self::Blocker),
            "general" => Ok(Self::General),
            other => Err(ValidationError(format!("invalid HR dimension: '{other}'"))),
        }
    }
}

/// Persisted workshop session metadata and pacing state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: Uuid,
    pub code: String,
    pub title: String,
    pub client_label: String,
    pub status: SessionStatus,
    pub current_activity_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

/// Lightweight session overview with participant and activity counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: Uuid,
    pub code: String,
    pub title: String,
    pub client_label: String,
    pub status: SessionStatus,
    pub participant_count: i64,
    pub activity_count: i64,
    pub created_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

/// Ordered facilitator activity configured within a workshop session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    pub id: Uuid,
    pub session_id: Uuid,
    pub position: i32,
    pub kind: ActivityKind,
    pub dimension: HrDimension,
    pub prompt: String,
    pub options: Vec<String>,
    pub is_open: bool,
    pub created_at: DateTime<Utc>,
}

/// Accountless mobile participant record scoped to one workshop session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Participant {
    pub id: Uuid,
    pub session_id: Uuid,
    pub nickname: String,
    pub joined_at: DateTime<Utc>,
}

/// Persisted participant response row for one activity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Response {
    pub id: Uuid,
    pub session_id: Uuid,
    pub activity_id: Uuid,
    pub participant_id: Uuid,
    pub choice_index: Option<i32>,
    pub rating_value: Option<i32>,
    pub text_value: Option<String>,
    pub submitted_at: DateTime<Utc>,
}

/// Strictly anonymized open-answer quote exposed to facilitators and HR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAnswerQuote {
    pub activity_id: Uuid,
    pub prompt: String,
    pub dimension: HrDimension,
    pub text: String,
    pub submitted_at: DateTime<Utc>,
}

/// Aggregated live or post-session response statistics for one activity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActivityTally {
    pub activity_id: Uuid,
    pub kind: ActivityKind,
    pub dimension: HrDimension,
    pub prompt: String,
    pub response_count: i64,
    pub poll_counts: Vec<i64>,
    pub rating_histogram: [i64; 5],
    pub rating_mean: Option<f64>,
    pub open_answers: Vec<OpenAnswerQuote>,
}

/// Complete live room state delivered over REST and WebSocket snapshots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoomSnapshot {
    pub session: Session,
    pub activities: Vec<Activity>,
    pub participant_count: i64,
    pub current_tally: Option<ActivityTally>,
}

/// Deterministic PostgreSQL aggregation for one HR insight dimension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DimensionSummary {
    pub activity_count: i64,
    pub response_count: i64,
    pub average_rating: Option<f64>,
    pub top_poll_findings: Vec<String>,
    pub quotes: Vec<OpenAnswerQuote>,
}

/// Post-session HR insight report derived strictly from persisted PostgreSQL data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HrInsights {
    pub session: Session,
    pub participant_count: i64,
    pub response_rate: f64,
    pub strengths: DimensionSummary,
    pub weaknesses: DimensionSummary,
    pub blockers: DimensionSummary,
    pub activities: Vec<ActivityTally>,
}

/// Input payload for creating a new workshop session.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateSessionInput {
    pub title: String,
    #[serde(default)]
    pub client_label: String,
}

impl CreateSessionInput {
    /// Trims and validates session creation fields against length bounds.
    pub fn validate(&self) -> Result<Self, ValidationError> {
        let title = self.title.trim().to_string();
        if title.is_empty() {
            return Err(ValidationError("session title cannot be empty".into()));
        }
        if title.chars().count() > MAX_TITLE_LEN {
            return Err(ValidationError(format!(
                "session title exceeds {MAX_TITLE_LEN} characters"
            )));
        }

        let client_label = self.client_label.trim().to_string();
        if client_label.chars().count() > MAX_CLIENT_LABEL_LEN {
            return Err(ValidationError(format!(
                "client_label exceeds {MAX_CLIENT_LABEL_LEN} characters"
            )));
        }

        Ok(Self {
            title,
            client_label,
        })
    }
}

/// Input payload for appending an activity to a workshop session.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateActivityInput {
    pub kind: ActivityKind,
    #[serde(default)]
    pub dimension: HrDimension,
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<String>,
}

impl CreateActivityInput {
    /// Trims and validates prompt and kind-specific poll options.
    pub fn validate(&self) -> Result<Self, ValidationError> {
        let prompt = self.prompt.trim().to_string();
        if prompt.is_empty() {
            return Err(ValidationError("activity prompt cannot be empty".into()));
        }
        if prompt.chars().count() > MAX_PROMPT_LEN {
            return Err(ValidationError(format!(
                "activity prompt exceeds {MAX_PROMPT_LEN} characters"
            )));
        }

        let options = match self.kind {
            ActivityKind::Poll => {
                let mut cleaned = Vec::with_capacity(self.options.len());
                for opt in &self.options {
                    let trimmed = opt.trim().to_string();
                    if trimmed.is_empty() {
                        return Err(ValidationError("poll option cannot be empty".into()));
                    }
                    if trimmed.chars().count() > MAX_OPTION_LEN {
                        return Err(ValidationError(format!(
                            "poll option exceeds {MAX_OPTION_LEN} characters"
                        )));
                    }
                    cleaned.push(trimmed);
                }
                if !(MIN_POLL_OPTIONS..=MAX_POLL_OPTIONS).contains(&cleaned.len()) {
                    return Err(ValidationError(format!(
                        "poll requires between {MIN_POLL_OPTIONS} and {MAX_POLL_OPTIONS} options"
                    )));
                }
                cleaned
            }
            ActivityKind::Rating | ActivityKind::OpenAnswer => {
                if !self.options.is_empty() {
                    return Err(ValidationError(
                        "options are only allowed for poll activities".into(),
                    ));
                }
                Vec::new()
            }
        };

        Ok(Self {
            kind: self.kind,
            dimension: self.dimension,
            prompt,
            options,
        })
    }
}

/// Deserializes a JSON field distinguishing omitted (`None`), `null` (`Some(None)`), and a value.
fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

/// Partial state update payload for stepping or closing a workshop session.
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateSessionStateInput {
    pub status: Option<SessionStatus>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub current_activity_id: Option<Option<Uuid>>,
    pub is_open: Option<bool>,
}

impl UpdateSessionStateInput {
    /// Rejects an empty state patch where no fields were provided.
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.status.is_none() && self.current_activity_id.is_none() && self.is_open.is_none() {
            return Err(ValidationError(
                "at least one session state field must be provided".into(),
            ));
        }
        Ok(())
    }
}

/// Input payload for joining or reconnecting to a workshop session.
#[derive(Debug, Clone, Deserialize)]
pub struct JoinSessionInput {
    pub nickname: String,
    pub participant_id: Option<Uuid>,
}

impl JoinSessionInput {
    /// Trims and validates participant nickname bounds.
    pub fn validate(&self) -> Result<Self, ValidationError> {
        let nickname = self.nickname.trim().to_string();
        if nickname.is_empty() {
            return Err(ValidationError("nickname cannot be empty".into()));
        }
        if nickname.chars().count() > MAX_NICKNAME_LEN {
            return Err(ValidationError(format!(
                "nickname exceeds {MAX_NICKNAME_LEN} characters"
            )));
        }
        Ok(Self {
            nickname,
            participant_id: self.participant_id,
        })
    }
}

/// Canonicalized response fields validated against an activity's kind and bounds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedResponse {
    pub choice_index: Option<i32>,
    pub rating_value: Option<i32>,
    pub text_value: Option<String>,
}

/// Input payload for submitting or updating a participant response.
#[derive(Debug, Clone, Deserialize)]
pub struct SubmitResponseInput {
    pub participant_id: Uuid,
    pub activity_id: Uuid,
    pub choice_index: Option<i32>,
    pub rating_value: Option<i32>,
    pub text_value: Option<String>,
}

impl SubmitResponseInput {
    /// Validates and canonicalizes the response payload for the target activity.
    pub fn validate_for(&self, activity: &Activity) -> Result<ValidatedResponse, ValidationError> {
        if self.activity_id != activity.id {
            return Err(ValidationError(
                "response activity_id does not match target activity".into(),
            ));
        }

        let has_text = self
            .text_value
            .as_deref()
            .is_some_and(|t| !t.trim().is_empty());

        match activity.kind {
            ActivityKind::Poll => {
                if self.rating_value.is_some() || has_text {
                    return Err(ValidationError(
                        "poll responses only accept choice_index".into(),
                    ));
                }
                let idx = self
                    .choice_index
                    .ok_or_else(|| ValidationError("poll response requires choice_index".into()))?;
                if idx < 0 || (idx as usize) >= activity.options.len() {
                    return Err(ValidationError("poll choice_index is out of range".into()));
                }
                Ok(ValidatedResponse {
                    choice_index: Some(idx),
                    rating_value: None,
                    text_value: None,
                })
            }
            ActivityKind::Rating => {
                if self.choice_index.is_some() || has_text {
                    return Err(ValidationError(
                        "rating responses only accept rating_value".into(),
                    ));
                }
                let rating = self.rating_value.ok_or_else(|| {
                    ValidationError("rating response requires rating_value".into())
                })?;
                if !(MIN_RATING..=MAX_RATING).contains(&rating) {
                    return Err(ValidationError(format!(
                        "rating_value must be between {MIN_RATING} and {MAX_RATING}"
                    )));
                }
                Ok(ValidatedResponse {
                    choice_index: None,
                    rating_value: Some(rating),
                    text_value: None,
                })
            }
            ActivityKind::OpenAnswer => {
                if self.choice_index.is_some() || self.rating_value.is_some() {
                    return Err(ValidationError(
                        "open_answer responses only accept text_value".into(),
                    ));
                }
                let text = self
                    .text_value
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| {
                        ValidationError("open_answer response requires non-empty text_value".into())
                    })?
                    .to_string();
                if text.chars().count() > MAX_OPEN_ANSWER_LEN {
                    return Err(ValidationError(format!(
                        "open_answer text exceeds {MAX_OPEN_ANSWER_LEN} characters"
                    )));
                }
                Ok(ValidatedResponse {
                    choice_index: None,
                    rating_value: None,
                    text_value: Some(text),
                })
            }
        }
    }
}

/// Normalizes and validates a workshop join code to 4–12 uppercase ASCII alphanumeric chars.
pub fn normalize_session_code(raw: &str) -> Result<String, ValidationError> {
    let code = raw.trim().to_ascii_uppercase();
    if !(4..=12).contains(&code.len()) || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ValidationError(
            "session code must be 4 to 12 alphanumeric characters".into(),
        ));
    }
    Ok(code)
}

/// Inbound WebSocket message envelope from workshop clients.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsClientMessage {
    SubmitResponse {
        participant_id: Uuid,
        activity_id: Uuid,
        choice_index: Option<i32>,
        rating_value: Option<i32>,
        text_value: Option<String>,
        client_ts: Option<i64>,
    },
    Ping {
        client_ts: Option<i64>,
    },
}

/// Outbound WebSocket message envelope broadcast to connected room clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsServerMessage {
    RoomSnapshot {
        snapshot: RoomSnapshot,
    },
    ParticipantCount {
        count: i64,
    },
    ActivityTally {
        tally: ActivityTally,
        #[serde(skip_serializing_if = "Option::is_none")]
        echo_client_ts: Option<i64>,
    },
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        echo_client_ts: Option<i64>,
    },
    AccessRevoked {
        reason: String,
    },
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper constructing a sample activity for response validation tests.
    fn sample_activity(kind: ActivityKind, options: Vec<&str>) -> Activity {
        Activity {
            id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            position: 1,
            kind,
            dimension: HrDimension::Strength,
            prompt: "Test prompt".into(),
            options: options.into_iter().map(String::from).collect(),
            is_open: true,
            created_at: Utc::now(),
        }
    }

    /// Verifies session code normalization and invalid format rejections.
    #[test]
    fn normalizes_and_validates_session_codes() {
        assert_eq!(normalize_session_code(" ab12cd ").unwrap(), "AB12CD");
        assert!(normalize_session_code("abc").is_err());
        assert!(normalize_session_code("ABCDEFGHIJKLM").is_err());
        assert!(normalize_session_code("AB-12").is_err());
    }

    /// Verifies UpdateSessionStateInput three-state deserialization and empty rejection.
    #[test]
    fn deserializes_double_option_patch_states() {
        let omitted: UpdateSessionStateInput = serde_json::from_str("{}").unwrap();
        assert_eq!(omitted.current_activity_id, None);
        assert!(omitted.validate().is_err());

        let cleared: UpdateSessionStateInput =
            serde_json::from_str(r#"{"current_activity_id":null}"#).unwrap();
        assert_eq!(cleared.current_activity_id, Some(None));
        assert!(cleared.validate().is_ok());

        let uid = Uuid::new_v4();
        let set: UpdateSessionStateInput =
            serde_json::from_str(&format!(r#"{{"current_activity_id":"{uid}"}}"#)).unwrap();
        assert_eq!(set.current_activity_id, Some(Some(uid)));
        assert!(set.validate().is_ok());
    }

    /// Verifies session, activity, and join input validation rules.
    #[test]
    fn validates_session_activity_and_join_inputs() {
        let valid_sess = CreateSessionInput {
            title: "  First-Time Managers  ".into(),
            client_label: "  Cohort A  ".into(),
        }
        .validate()
        .unwrap();
        assert_eq!(valid_sess.title, "First-Time Managers");
        assert_eq!(valid_sess.client_label, "Cohort A");

        assert!(CreateSessionInput {
            title: "   ".into(),
            client_label: String::new(),
        }
        .validate()
        .is_err());

        assert!(CreateActivityInput {
            kind: ActivityKind::Poll,
            dimension: HrDimension::Blocker,
            prompt: "Main blocker?".into(),
            options: vec!["A".into()],
        }
        .validate()
        .is_err());

        assert!(CreateActivityInput {
            kind: ActivityKind::Rating,
            dimension: HrDimension::General,
            prompt: "Confidence".into(),
            options: vec!["Unexpected".into()],
        }
        .validate()
        .is_err());

        let joined = JoinSessionInput {
            nickname: "  Maya  ".into(),
            participant_id: None,
        }
        .validate()
        .unwrap();
        assert_eq!(joined.nickname, "Maya");
    }

    /// Verifies response payload validation across poll, rating, and open_answer activities.
    #[test]
    fn validates_responses_per_activity_kind() {
        let poll = sample_activity(ActivityKind::Poll, vec!["One", "Two"]);
        let ok_poll = SubmitResponseInput {
            participant_id: Uuid::new_v4(),
            activity_id: poll.id,
            choice_index: Some(1),
            rating_value: None,
            text_value: None,
        }
        .validate_for(&poll)
        .unwrap();
        assert_eq!(ok_poll.choice_index, Some(1));

        assert!(SubmitResponseInput {
            participant_id: Uuid::new_v4(),
            activity_id: poll.id,
            choice_index: Some(2),
            rating_value: None,
            text_value: None,
        }
        .validate_for(&poll)
        .is_err());

        let rating = sample_activity(ActivityKind::Rating, vec![]);
        assert!(SubmitResponseInput {
            participant_id: Uuid::new_v4(),
            activity_id: rating.id,
            choice_index: None,
            rating_value: Some(5),
            text_value: None,
        }
        .validate_for(&rating)
        .is_ok());
        assert!(SubmitResponseInput {
            participant_id: Uuid::new_v4(),
            activity_id: rating.id,
            choice_index: None,
            rating_value: Some(6),
            text_value: None,
        }
        .validate_for(&rating)
        .is_err());

        let open = sample_activity(ActivityKind::OpenAnswer, vec![]);
        let ok_open = SubmitResponseInput {
            participant_id: Uuid::new_v4(),
            activity_id: open.id,
            choice_index: None,
            rating_value: None,
            text_value: Some("  Clearer feedback loops  ".into()),
        }
        .validate_for(&open)
        .unwrap();
        assert_eq!(
            ok_open.text_value.as_deref(),
            Some("Clearer feedback loops")
        );

        assert!(SubmitResponseInput {
            participant_id: Uuid::new_v4(),
            activity_id: open.id,
            choice_index: None,
            rating_value: None,
            text_value: Some("   ".into()),
        }
        .validate_for(&open)
        .is_err());
    }

    /// Verifies OpenAnswerQuote JSON never contains participant identity fields.
    #[test]
    fn open_answer_quote_omits_participant_identity() {
        let quote = OpenAnswerQuote {
            activity_id: Uuid::new_v4(),
            prompt: "What slows you down?".into(),
            dimension: HrDimension::Blocker,
            text: "Too many approval layers".into(),
            submitted_at: Utc::now(),
        };
        let json = serde_json::to_string(&quote).unwrap();
        assert!(!json.contains("participant_id"));
        assert!(!json.contains("nickname"));
    }
}
