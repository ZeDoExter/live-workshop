/**
 * Opaque-box E2E helpers for REST, WebSocket, auth cookies, and mobile viewports.
 * Reads all URLs and tokens lazily from process.env with zero hardcoded secret fallbacks.
 */
import crypto from 'node:crypto';
import { expect, devices, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

export type ActivityKind = 'poll' | 'rating' | 'open_answer';
export type HrDimension = 'strength' | 'weakness' | 'blocker' | 'general';

export interface ActivityInput {
  kind: ActivityKind;
  dimension: HrDimension;
  prompt: string;
  options?: string[];
}

export interface SessionData {
  id: string;
  code: string;
  title: string;
  client_label: string;
  status: 'lobby' | 'active' | 'ended';
  current_activity_id: string | null;
  ended_at?: string | null;
}

export interface ActivityData {
  id: string;
  session_id: string;
  position: number;
  kind: ActivityKind;
  dimension: HrDimension;
  prompt: string;
  options: string[];
  is_open: boolean;
}

export interface RoomSnapshot {
  session: SessionData;
  activities: ActivityData[];
  participant_count: number;
  current_tally?: Record<string, unknown> | null;
}

export interface WsMessage {
  type: string;
  receivedAt?: number;
  [key: string]: unknown;
}

/** Returns a short unique ID per test run (32-bit random suffix) to isolate shared database state. */
export function runId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** Extracts poll choice counts from an ActivityTally or HrInsights activity object. */
export function getPollCounts(tally: Record<string, unknown> | null | undefined): number[] {
  const raw = tally?.poll_counts ?? tally?.counts ?? tally?.tallies;
  return Array.isArray(raw) ? raw.map((n) => Number(n)) : [];
}

/** Extracts total response count from an ActivityTally or HrInsights activity object. */
export function getResponseCount(tally: Record<string, unknown> | null | undefined): number {
  if (typeof tally?.response_count === 'number') return tally.response_count;
  if (typeof tally?.total === 'number') return tally.total;
  if (typeof tally?.total_responses === 'number') return tally.total_responses;
  return getPollCounts(tally).reduce((a, b) => a + b, 0);
}

/** Extracts rating mean from an ActivityTally or DimensionSummary object. */
export function getRatingMean(tally: Record<string, unknown> | null | undefined): number | null {
  const v =
    tally?.rating_mean ?? tally?.average_rating ?? tally?.mean ?? tally?.average ?? tally?.mean_rating ?? tally?.avg_rating;
  return typeof v === 'number' ? v : null;
}

/** Reads a required environment variable lazily without any fallback secret literal. */
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

/** Returns public frontend and backend base URLs without requiring auth tokens. */
export function getUrls(): { baseUrl: string; apiUrl: string } {
  return {
    baseUrl: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    apiUrl: process.env.E2E_API_URL ?? 'http://localhost:3001',
  };
}

/** Lazily loads runtime URLs and required access tokens from process.env. */
export function getConfig() {
  return {
    ...getUrls(),
    demoToken: process.env.DEMO_ACCESS_TOKEN ?? '',
    facilitatorToken: requireEnv('FACILITATOR_TOKEN'),
    adminToken: requireEnv('ADMIN_TOKEN'),
  };
}

/** Builds API/WS auth headers for the requested privilege level. */
export function authHeaders(role: 'demo' | 'facilitator' | 'admin'): Record<string, string> {
  const cfg = getConfig();
  if (role === 'admin') return { 'X-Admin-Token': cfg.adminToken };
  if (role === 'facilitator') {
    return { 'X-Facilitator-Token': cfg.facilitatorToken };
  }
  return {};
}

/** Authenticates a Playwright BrowserContext for facilitator access (participants need no login). */
export async function authenticateContext(context: BrowserContext, role: 'demo' | 'facilitator'): Promise<void> {
  if (role === 'demo') {
    return;
  }
  const cfg = getConfig();
  const res = await context.request.post(`${cfg.apiUrl}/api/auth/facilitator`, {
    data: { facilitator_token: cfg.facilitatorToken },
  });
  expect(res.status(), `authenticateContext(${role}) failed`).toBe(200);

  // Mirror cookies to baseUrl host if E2E_BASE_URL and E2E_API_URL differ (e.g. 127.0.0.1 vs localhost).
  const baseHost = new URL(cfg.baseUrl).hostname;
  const apiHost = new URL(cfg.apiUrl).hostname;
  if (baseHost !== apiHost) {
    const apiCookies = await context.cookies(cfg.apiUrl);
    if (apiCookies.length > 0) {
      await context.addCookies(
        apiCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: baseHost,
          path: c.path || '/',
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
          expires: c.expires,
        })),
      );
    }
  }
}

/** Creates a uniquely named workshop session and optional ordered activities via REST. */
export async function createSession(
  request: APIRequestContext,
  opts?: { title?: string; clientLabel?: string; activities?: ActivityInput[] },
): Promise<{ code: string; session: SessionData; activities: ActivityData[] }> {
  const { apiUrl } = getUrls();
  const id = runId();
  const sessionRes = await request.post(`${apiUrl}/api/sessions`, {
    headers: authHeaders('facilitator'),
    data: {
      title: opts?.title ?? `Workshop ${id}`,
      client_label: opts?.clientLabel ?? `Live WorkShop ${id}`,
    },
  });
  expect(sessionRes.status(), 'POST /api/sessions').toBe(201);
  const session = (await sessionRes.json()) as SessionData;
  const activities: ActivityData[] = [];
  for (const act of opts?.activities ?? []) {
    const actRes = await request.post(`${apiUrl}/api/sessions/${session.code}/activities`, {
      headers: authHeaders('facilitator'),
      data: { kind: act.kind, dimension: act.dimension, prompt: act.prompt, options: act.options ?? [] },
    });
    expect(actRes.status(), `POST /api/sessions/${session.code}/activities`).toBe(201);
    activities.push((await actRes.json()) as ActivityData);
  }
  return { code: session.code, session, activities };
}

/** Transitions session status, active activity, or submission lock state via REST. */
export async function patchSessionState(
  request: APIRequestContext,
  code: string,
  body: { status?: 'lobby' | 'active' | 'ended'; current_activity_id?: string | null; is_open?: boolean },
): Promise<RoomSnapshot> {
  const { apiUrl } = getUrls();
  const res = await request.patch(`${apiUrl}/api/sessions/${code}/state`, {
    headers: authHeaders('facilitator'),
    data: body,
  });
  expect(res.status(), `PATCH /api/sessions/${code}/state`).toBe(200);
  return (await res.json()) as RoomSnapshot;
}

/** Joins (or reconnects) a participant in a room via REST without an account. */
export async function joinParticipant(
  request: APIRequestContext,
  code: string,
  nickname: string,
  participantId?: string,
): Promise<{ participant_id: string; snapshot: RoomSnapshot }> {
  const { apiUrl } = getUrls();
  const res = await request.post(`${apiUrl}/api/sessions/${code}/join`, {
    headers: authHeaders('demo'),
    data: participantId ? { nickname, participant_id: participantId } : { nickname },
  });
  expect(res.status(), `POST /api/sessions/${code}/join`).toBe(201);
  return (await res.json()) as { participant_id: string; snapshot: RoomSnapshot };
}

/** Toggles runtime demo availability via the admin control endpoint (use inside try/finally). */
export async function setDemoAccess(request: APIRequestContext, demoActive: boolean): Promise<{ demo_active: boolean }> {
  const { apiUrl } = getUrls();
  const res = await request.post(`${apiUrl}/api/admin/access`, {
    headers: authHeaders('admin'),
    data: { demo_active: demoActive },
  });
  expect(res.status(), `POST /api/admin/access (${demoActive})`).toBe(200);
  return (await res.json()) as { demo_active: boolean };
}

export interface WsHandle {
  ws: WebSocket;
  messages: WsMessage[];
  errors: Event[];
  isClosed: () => boolean;
  closeCode: () => number | null;
  waitForOpen: (timeoutMs?: number) => Promise<void>;
  waitForClose: (timeoutMs?: number) => Promise<number>;
  waitForMessage: (predicate: (m: WsMessage) => boolean, timeoutMs?: number) => Promise<WsMessage>;
  send: (payload: unknown) => void;
  close: () => void;
}

/** Opens a native Node v25 WebSocket to /ws/sessions/:code and buffers incoming JSON messages. */
export function connectWs(
  code: string,
  opts?: { token?: string | null; facilitatorToken?: string; headers?: Record<string, string> },
): WsHandle {
  const { apiUrl } = getUrls();
  const wsBase = apiUrl.replace(/^http/, 'ws');
  const useExplicitHeaders = Boolean(opts?.headers || opts?.facilitatorToken);
  const demoToken = opts?.token === undefined ? getConfig().demoToken : opts.token;
  const url =
    !useExplicitHeaders && demoToken
      ? `${wsBase}/ws/sessions/${code}?token=${encodeURIComponent(demoToken)}`
      : `${wsBase}/ws/sessions/${code}`;
  const reqHeaders =
    opts?.headers ??
    (opts?.facilitatorToken
      ? { ...(demoToken ? { 'X-Demo-Token': demoToken } : {}), 'X-Facilitator-Token': opts.facilitatorToken }
      : undefined);
  // Node 25 undici WebSocket accepts { headers } at runtime; cast satisfies TS lib.dom.d.ts signature.
  const ws = reqHeaders ? new WebSocket(url, { headers: reqHeaders } as unknown as string[]) : new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  const messages: WsMessage[] = [];
  const errors: Event[] = [];
  let opened = false;
  let closed = false;
  let recordedCloseCode: number | null = null;
  const waiters: Array<() => void> = [];
  const notify = () => [...waiters].forEach((fn) => fn());
  const pushTextFrame = (text: string, receivedAt: number) => {
    try {
      const parsed = JSON.parse(text) as WsMessage;
      messages.push(parsed && typeof parsed === 'object' ? { ...parsed, receivedAt } : { type: 'raw', raw: text, receivedAt });
    } catch {
      messages.push({ type: 'raw', raw: text, receivedAt });
    }
    notify();
  };

  ws.addEventListener('open', () => {
    opened = true;
    notify();
  });
  ws.addEventListener('error', (ev) => {
    errors.push(ev);
    notify();
  });
  ws.addEventListener('close', (ev) => {
    closed = true;
    recordedCloseCode = (ev as CloseEvent).code ?? 1006;
    notify();
  });
  ws.addEventListener('message', (ev) => {
    const receivedAt = performance.now();
    const data = ev.data as unknown;
    if (typeof data === 'string') {
      pushTextFrame(data, receivedAt);
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      pushTextFrame(new TextDecoder().decode(data), receivedAt);
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.text().then((text) => pushTextFrame(text, receivedAt));
    } else {
      pushTextFrame(String(data), receivedAt);
    }
  });

  const waitUntil = (check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> =>
    new Promise((resolve, reject) => {
      if (check()) return resolve();
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = waiters.indexOf(poll);
        if (idx !== -1) waiters.splice(idx, 1);
      };
      const timer = setTimeout(() => {
        try {
          reject(new Error(`WebSocket timeout waiting for ${label}`));
        } finally {
          cleanup();
        }
      }, timeoutMs);
      const poll = () => {
        if (settled || !check()) return;
        cleanup();
        resolve();
      };
      waiters.push(poll);
    });

  return {
    ws,
    messages,
    errors,
    isClosed: () => closed,
    closeCode: () => recordedCloseCode,
    waitForOpen: (timeoutMs) =>
      waitUntil(() => opened || closed, 'open', timeoutMs).then(() => {
        if (!opened) throw new Error(`WebSocket closed before open (code=${recordedCloseCode})`);
      }),
    waitForClose: (timeoutMs) => waitUntil(() => closed, 'close', timeoutMs).then(() => recordedCloseCode ?? 1006),
    waitForMessage: async (predicate, timeoutMs) => {
      await waitUntil(() => messages.some(predicate) || closed, 'message', timeoutMs);
      const found = messages.find(predicate);
      if (!found) throw new Error(`WebSocket closed before matching message (code=${recordedCloseCode})`);
      return found;
    },
    send: (payload) => ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    close: () => {
      if (!closed) ws.close();
    },
  };
}

/** Creates a mobile-phone BrowserContext (Pixel 5 / 390x844, touch enabled) without accounts. */
export async function newMobileContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    ...devices['Pixel 5'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
}

/** Verifies mobile/desktop pages have zero horizontal overflow (scrollWidth <= innerWidth). */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(ok, 'Expected no horizontal overflow (scrollWidth <= innerWidth)').toBe(true);
}

/** Selects a session row/card on /facilitator whether code itself or an Open/Manage button opens it. */
export async function openFacilitatorSession(page: Page, code: string, title?: string): Promise<void> {
  const codeNode = page.getByText(code).first();
  await expect(codeNode).toBeVisible();
  const container = codeNode.locator(
    'xpath=ancestor::*[self::li or self::tr or self::article or self::button or self::a or (self::div and .//button)][1]',
  );
  const actionBtn = container.locator('button, a').filter({ hasText: /open|manage|select|view|control|live|resume/i }).first();
  if (await actionBtn.isVisible().catch(() => false)) {
    await actionBtn.click();
    return;
  }
  if (title) {
    const titleBtn = page.getByRole('button', { name: title }).or(page.getByRole('link', { name: title })).first();
    if (await titleBtn.isVisible().catch(() => false)) {
      await titleBtn.click();
      return;
    }
  }
  await codeNode.click();
}

/** Runs a UI submission click and awaits POST /responses (or UI confirmation if submitted over WS). */
export async function submitAndWait(page: Page, code: string, action: () => Promise<void>): Promise<void> {
  const respPromise = page
    .waitForResponse((r) => r.url().includes(`/api/sessions/${code}/responses`) && r.request().method() === 'POST', {
      timeout: 5_000,
    })
    .catch(() => null);
  await action();
  const res = await respPromise;
  if (res) {
    expect(res.status()).toBe(200);
  } else {
    await expect(page.getByText(/submitted|saved|recorded|updated|thank/i).first()).toBeVisible({ timeout: 5_000 });
  }
}
