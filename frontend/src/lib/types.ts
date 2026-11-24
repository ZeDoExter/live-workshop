/** Domain types matching the Rust/Axum REST and WebSocket JSON payloads. */

export type SessionStatus = 'lobby' | 'active' | 'ended';
export type ActivityKind = 'poll' | 'rating' | 'open_answer';
export type HrDimension = 'strength' | 'weakness' | 'blocker' | 'general';

export interface Session {
  id: string;
  code: string;
  title: string;
  client_label: string;
  status: SessionStatus;
  current_activity_id: string | null;
  created_at: string;
  ended_at: string | null;
}

export interface SessionSummary {
  id: string;
  code: string;
  title: string;
  client_label: string;
  status: SessionStatus;
  participant_count: number;
  activity_count: number;
  created_at: string;
  ended_at: string | null;
}

export interface Activity {
  id: string;
  session_id: string;
  position: number;
  kind: ActivityKind;
  dimension: HrDimension;
  prompt: string;
  options: string[];
  is_open: boolean;
  created_at: string;
}

export interface OpenAnswerQuote {
  activity_id: string;
  prompt: string;
  dimension: HrDimension;
  text: string;
  submitted_at: string;
}

export interface ActivityTally {
  activity_id: string;
  kind: ActivityKind;
  dimension: HrDimension;
  prompt: string;
  response_count: number;
  poll_counts: number[];
  rating_histogram: [number, number, number, number, number];
  rating_mean: number | null;
  open_answers: OpenAnswerQuote[];
}

export interface RoomSnapshot {
  session: Session;
  activities: Activity[];
  participant_count: number;
  current_tally: ActivityTally | null;
}

export interface DimensionSummary {
  activity_count: number;
  response_count: number;
  average_rating: number | null;
  top_poll_findings: string[];
  quotes: OpenAnswerQuote[];
}

export interface HrInsights {
  session: Session;
  participant_count: number;
  response_rate: number;
  strengths: DimensionSummary;
  weaknesses: DimensionSummary;
  blockers: DimensionSummary;
  activities: ActivityTally[];
}

export interface AuthStatus {
  demo_active: boolean;
  demo_authenticated: boolean;
  facilitator_authenticated: boolean;
}

export type WsServerMessage =
  | { type: 'room_snapshot'; snapshot: RoomSnapshot }
  | { type: 'participant_count'; count: number }
  | { type: 'activity_tally'; tally: ActivityTally; echo_client_ts?: number }
  | { type: 'pong'; echo_client_ts?: number }
  | { type: 'access_revoked'; reason: string }
  | { type: 'error'; message: string };
