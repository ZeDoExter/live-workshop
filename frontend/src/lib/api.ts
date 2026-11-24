import type {
  Activity,
  ActivityKind,
  AuthStatus,
  HrDimension,
  HrInsights,
  RoomSnapshot,
  Session,
  SessionStatus,
  SessionSummary,
} from './types';

/** Error carrying an HTTP status code from backend REST responses. */
export class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Active Better Auth session token cached in memory/sessionStorage for cross-port API calls. */
let activeSessionToken: string | null = null;

/** Sets or clears the Better Auth session token used for Rust backend API requests. */
export function setActiveSessionToken(token: string | null): void {
  activeSessionToken = token;
  if (typeof window !== 'undefined') {
    if (token) {
      window.sessionStorage.setItem('ba_session_token', token);
    } else {
      window.sessionStorage.removeItem('ba_session_token');
    }
  }
}

/** Reads the cached Better Auth session token if available. */
function getActiveSessionToken(): string | null {
  if (activeSessionToken) return activeSessionToken;
  if (typeof window !== 'undefined') {
    return window.sessionStorage.getItem('ba_session_token');
  }
  return null;
}

/** Resolves the backend HTTP base URL matching the active browser hostname for SameSite cookies. */
export function getApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured && configured.trim().length > 0) {
    return configured.trim().replace(/\/$/, '');
  }
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }
  return 'http://localhost:3001';
}

/** Resolves the backend WebSocket base URL matching the active browser hostname. */
export function getWsBase(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured && configured.trim().length > 0) {
    return configured.trim().replace(/\/$/, '');
  }
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.hostname}:3001`;
  }
  return 'ws://localhost:3001';
}

/** Sends a JSON request with HttpOnly cookies and optional Better Auth Bearer token enabled. */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveSessionToken();
  const res = await fetch(`${getApiBase()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new ApiHttpError(res.status, msg);
  }
  return body as T;
}

/** Queries current service availability and facilitator authentication status. */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  return requestJson<AuthStatus>('/api/auth/status');
}

/** Clears authentication cookies on the backend. */
export async function logoutAuth(): Promise<void> {
  setActiveSessionToken(null);
  await requestJson('/api/auth/logout', { method: 'POST' });
}

/** Lists all workshop sessions for the Facilitator Console. */
export async function listSessions(): Promise<SessionSummary[]> {
  return requestJson<SessionSummary[]>('/api/sessions');
}

/** Creates a new workshop session. */
export async function createSession(title: string, clientLabel: string): Promise<Session> {
  return requestJson<Session>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, client_label: clientLabel }),
  });
}

/** Appends a poll, rating, or open_answer activity to a workshop session. */
export async function createActivity(
  code: string,
  input: { kind: ActivityKind; dimension: HrDimension; prompt: string; options: string[] },
): Promise<Activity> {
  return requestJson<Activity>(`/api/sessions/${encodeURIComponent(code)}/activities`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Updates session lifecycle status, active activity pointer, or submission lock flag. */
export async function updateSessionState(
  code: string,
  input: { status?: SessionStatus; current_activity_id?: string | null; is_open?: boolean },
): Promise<RoomSnapshot> {
  return requestJson<RoomSnapshot>(`/api/sessions/${encodeURIComponent(code)}/state`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** Fetches the current live room snapshot for a session code. */
export async function getRoomSnapshot(code: string): Promise<RoomSnapshot> {
  return requestJson<RoomSnapshot>(`/api/sessions/${encodeURIComponent(code)}`);
}

/** Joins or reconnects an accountless mobile participant to a workshop room by Room Code. */
export async function joinSession(
  code: string,
  nickname: string,
  participantId?: string | null,
): Promise<{ participant_id: string; snapshot: RoomSnapshot }> {
  return requestJson<{ participant_id: string; snapshot: RoomSnapshot }>(
    `/api/sessions/${encodeURIComponent(code)}/join`,
    {
      method: 'POST',
      body: JSON.stringify(
        participantId ? { nickname, participant_id: participantId } : { nickname },
      ),
    },
  );
}

/** Submits or updates a participant's response for the active workshop activity. */
export async function submitResponse(
  code: string,
  input: {
    participant_id: string;
    activity_id: string;
    choice_index?: number;
    rating_value?: number;
    text_value?: string;
  },
): Promise<{ accepted: boolean }> {
  return requestJson<{ accepted: boolean }>(`/api/sessions/${encodeURIComponent(code)}/responses`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Fetches deterministic PostgreSQL HR insights for a session. */
export async function getHrInsights(code: string): Promise<HrInsights> {
  return requestJson<HrInsights>(`/api/sessions/${encodeURIComponent(code)}/insights`);
}
