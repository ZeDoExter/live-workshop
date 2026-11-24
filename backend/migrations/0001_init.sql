-- Initial workshop persistence and runtime access-control schema.

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(12) UNIQUE NOT NULL CHECK (char_length(trim(code)) BETWEEN 4 AND 12),
    title TEXT NOT NULL CHECK (char_length(trim(title)) > 0),
    client_label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'active', 'ended')),
    current_activity_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ NULL
);

CREATE TABLE activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position INT NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('poll', 'rating', 'open_answer')),
    dimension TEXT NOT NULL DEFAULT 'general' CHECK (dimension IN ('strength', 'weakness', 'blocker', 'general')),
    prompt TEXT NOT NULL CHECK (char_length(trim(prompt)) > 0),
    options JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
    is_open BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, position)
);

CREATE TABLE participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL CHECK (char_length(trim(nickname)) > 0),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    choice_index INT NULL CHECK (choice_index IS NULL OR choice_index >= 0),
    rating_value INT NULL CHECK (rating_value IS NULL OR rating_value BETWEEN 1 AND 5),
    text_value TEXT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (activity_id, participant_id)
);

CREATE TABLE app_controls (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_created_at ON sessions (created_at DESC);
CREATE INDEX idx_participants_session_id ON participants (session_id);
CREATE INDEX idx_responses_session_id ON responses (session_id);
