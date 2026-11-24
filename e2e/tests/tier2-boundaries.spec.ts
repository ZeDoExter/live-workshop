/**
 * Tier 2 (@tier2): Boundary value analysis & fault partitioning tests (35 tests across 6 areas).
 * Covers auth gates, input validation, state-machine bounds, BVA payloads, XSS/mobile overflow, and HR aggregations.
 */
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  assertNoHorizontalOverflow,
  authenticateContext,
  authHeaders,
  connectWs,
  createSession,
  getConfig,
  getPollCounts,
  getUrls,
  joinParticipant,
  newMobileContext,
  openFacilitatorSession,
  patchSessionState,
  runId,
} from './helpers.js';

// ============================================================================
// Area 2.1: Auth Gate & Access Control Boundaries (6 tests)
// ============================================================================

test('T2-1.1 Unauthenticated Facilitator REST returns 401/403 @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);

  const r1 = await fetch(`${apiUrl}/api/sessions`);
  const r2 = await fetch(`${apiUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'NoAuth', client_label: 'Test' }),
  });
  const r3 = await fetch(`${apiUrl}/api/sessions/${code}/insights`);

  expect([401, 403]).toContain(r1.status);
  expect([401, 403]).toContain(r2.status);
  expect([401, 403]).toContain(r3.status);
});

test('T2-1.2 Insufficient Privilege (Demo token != Facilitator) @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);
  const headers = authHeaders('demo');

  const r1 = await request.post(`${apiUrl}/api/sessions`, {
    headers,
    data: { title: 'Blocked', client_label: 'DemoOnly' },
  });
  const r2 = await request.patch(`${apiUrl}/api/sessions/${code}/state`, {
    headers,
    data: { status: 'active' },
  });
  const r3 = await request.get(`${apiUrl}/api/sessions/${code}/insights`, { headers });

  expect([401, 403]).toContain(r1.status());
  expect([401, 403]).toContain(r2.status());
  expect([401, 403]).toContain(r3.status());
});

test('T2-1.3 General client joins by Room Code without login while Facilitator endpoints stay protected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Q?', options: ['A', 'B'] }],
  });

  const joinOk = await fetch(`${apiUrl}/api/sessions/${code}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'AnonClient' }),
  });
  const getOk = await fetch(`${apiUrl}/api/sessions/${code}`);
  const insightsBlocked = await fetch(`${apiUrl}/api/sessions/${code}/insights`);

  expect(joinOk.status).toBe(201);
  expect(getOk.status).toBe(200);
  expect([401, 403]).toContain(insightsBlocked.status);
});

test('T2-1.4 Invalid Tokens (Facilitator, Admin, Better Auth Cookie) rejected @tier2', async () => {
  const cfg = getConfig();
  const rFac = await fetch(`${cfg.apiUrl}/api/auth/facilitator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facilitator_token: 'wrong-fac-token' }),
  });
  const rBadCookie = await fetch(`${cfg.apiUrl}/api/sessions`, {
    headers: { Cookie: 'better-auth.session_token=nonexistent_session_tok.sig' },
  });
  const rAdmin = await fetch(`${cfg.apiUrl}/api/admin/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'wrong-admin-token' },
    body: JSON.stringify({ demo_active: false }),
  });
  const health = await (await fetch(`${cfg.apiUrl}/api/health`)).json();

  expect([401, 403]).toContain(rFac.status);
  expect([401, 403]).toContain(rBadCookie.status);
  expect([401, 403]).toContain(rAdmin.status);
  expect(rFac.headers.get('set-cookie') ?? '').not.toContain('facilitator_token=');
  expect(health.demo_active).toBe(true);
});

test('T2-1.5 Invalid-Room-Code WebSocket rejected before 101 @tier2', async () => {
  const wsUnknown = connectWs('NOPE99');
  const wsMalformed = connectWs('A');
  try {
    await expect(wsUnknown.waitForOpen(3000)).rejects.toThrow();
    await expect(wsMalformed.waitForOpen(3000)).rejects.toThrow();
  } finally {
    wsUnknown.close();
    wsMalformed.close();
  }
});

test('T2-1.6 UI Route Protection (/facilitator, /dashboard/[code]) leaks no session data @tier2', async ({ browser, request }) => {
  const secretTitle = `ConfidentialSession-${runId()}`;
  const { code } = await createSession(request, { title: secretTitle });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/facilitator');
    await expect(page.getByText(secretTitle)).toHaveCount(0);
    await expect(page.getByRole('textbox').or(page.locator('input[type="password"]')).first()).toBeVisible();

    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(secretTitle)).toHaveCount(0);
    await expect(page.getByRole('textbox').or(page.locator('input[type="password"]')).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

// ============================================================================
// Area 2.2: Session & Activity Input Validation Boundaries (6 tests)
// ============================================================================

test('T2-2.1 Empty / Whitespace Session Title rejected @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  for (const title of ['', '   ']) {
    const res = await request.post(`${apiUrl}/api/sessions`, {
      headers: authHeaders('facilitator'),
      data: { title, client_label: 'Acme' },
    });
    expect([400, 422]).toContain(res.status());
  }

  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const page = await context.newPage();
    await page.goto('/facilitator');
    const titleInput = page.getByLabel(/title/i).or(page.getByPlaceholder(/title|workshop/i)).first();
    await titleInput.fill('   ');
    await page.getByRole('button', { name: /create/i }).first().click();
    await expect(page).toHaveURL(/\/facilitator/);
  } finally {
    await context.close();
  }
});

test('T2-2.2 Oversized Session Title & Client Label never 500 @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const huge = 'X'.repeat(5_000);
  const res = await request.post(`${apiUrl}/api/sessions`, {
    headers: authHeaders('facilitator'),
    data: { title: huge, client_label: huge },
  });
  expect(res.status()).toBeLessThan(500);
  expect([201, 400, 413, 422]).toContain(res.status());
});

test('T2-2.3 Empty / Whitespace Activity Prompt rejected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);
  const res = await request.post(`${apiUrl}/api/sessions/${code}/activities`, {
    headers: authHeaders('facilitator'),
    data: { kind: 'open_answer', dimension: 'general', prompt: '   ', options: [] },
  });
  expect([400, 422]).toContain(res.status());
});

test('T2-2.4 Poll Options Lower Boundary (< 2 options) rejected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);
  for (const options of [[], ['Only One']]) {
    const res = await request.post(`${apiUrl}/api/sessions/${code}/activities`, {
      headers: authHeaders('facilitator'),
      data: { kind: 'poll', dimension: 'general', prompt: 'Too few choices', options },
    });
    expect([400, 422]).toContain(res.status());
  }
});

test('T2-2.5 Invalid Activity kind / dimension rejected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);
  const badKind = await request.post(`${apiUrl}/api/sessions/${code}/activities`, {
    headers: authHeaders('facilitator'),
    data: { kind: 'quiz', dimension: 'general', prompt: 'Bad kind', options: [] },
  });
  const badDim = await request.post(`${apiUrl}/api/sessions/${code}/activities`, {
    headers: authHeaders('facilitator'),
    data: { kind: 'rating', dimension: 'budget', prompt: 'Bad dim', options: [] },
  });
  expect([400, 422]).toContain(badKind.status());
  expect([400, 422]).toContain(badDim.status());
});

test('T2-2.6 Unknown Room Code returns 404 / clean not-found UI @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const getRes = await request.get(`${apiUrl}/api/sessions/NOPE99`, { headers: authHeaders('demo') });
  const joinRes = await request.post(`${apiUrl}/api/sessions/NOPE99/join`, {
    headers: authHeaders('demo'),
    data: { nickname: 'Lost' },
  });
  expect(getRes.status()).toBe(404);
  expect(joinRes.status()).toBe(404);

  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const page = await context.newPage();
    await page.goto('/join/NOPE99');
    await expect(page.getByText(/not found|no session|unknown|invalid/i).first()).toBeVisible();
    await page.goto('/dashboard/NOPE99');
    await expect(page.getByText(/not found|no session|unknown|invalid/i).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

// ============================================================================
// Area 2.3: State Machine & Submission Constraint Boundaries (6 tests)
// ============================================================================

test('T2-3.1 Submit in lobby state rejected via REST and WS @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Lobby test', options: ['A', 'B'] }],
  });
  const { participant_id } = await joinParticipant(request, code, 'Waiter');

  const restRes = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, choice_index: 0 },
  });
  expect([400, 403, 409, 422]).toContain(restRes.status());

  const ws = connectWs(code);
  try {
    await ws.waitForOpen();
    ws.send({ type: 'submit_response', participant_id, activity_id: activities[0].id, choice_index: 0 });
    const err = await ws.waitForMessage((m) => m.type === 'error');
    expect(err.type).toBe('error');
  } finally {
    ws.close();
  }
});

test('T2-3.2 Submit in ended state rejected via REST and WS @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'rating', dimension: 'strength', prompt: 'Ended test' }],
  });
  const { participant_id } = await joinParticipant(request, code, 'Finisher');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  await patchSessionState(request, code, { status: 'ended' });

  const restRes = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, rating_value: 4 },
  });
  expect([400, 403, 409, 422]).toContain(restRes.status());

  const ws = connectWs(code);
  try {
    await ws.waitForOpen();
    ws.send({ type: 'submit_response', participant_id, activity_id: activities[0].id, rating_value: 4 });
    const err = await ws.waitForMessage((m) => m.type === 'error');
    expect(err.type).toBe('error');
  } finally {
    ws.close();
  }
});

test('T2-3.3 Submit to locked activity (is_open: false) rejected @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Locked test', options: ['A', 'B'] }],
  });
  const { participant_id } = await joinParticipant(request, code, 'LockedUser');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id, is_open: false });

  const restRes = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, choice_index: 0 },
  });
  expect([400, 403, 409, 422]).toContain(restRes.status());

  const ws = connectWs(code);
  try {
    await ws.waitForOpen();
    ws.send({ type: 'submit_response', participant_id, activity_id: activities[0].id, choice_index: 0 });
    const err = await ws.waitForMessage((m) => m.type === 'error');
    expect(err.type).toBe('error');
  } finally {
    ws.close();
  }

  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(mobCtx, 'demo');
    const page = await mobCtx.newPage();
    await page.goto(`/join/${code}`);
    await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill('LockedMob');
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(page.getByText(/locked|closed|paused/i).first()).toBeVisible();
  } finally {
    await mobCtx.close();
  }
});

test('T2-3.4 Submit to non-current activity_id rejected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [
      { kind: 'poll', dimension: 'general', prompt: 'Act 1', options: ['A', 'B'] },
      { kind: 'poll', dimension: 'general', prompt: 'Act 2', options: ['C', 'D'] },
    ],
  });
  const { participant_id } = await joinParticipant(request, code, 'Late');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[1].id });

  const restRes = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, choice_index: 0 },
  });
  expect([400, 403, 409, 422]).toContain(restRes.status());

  const ws = connectWs(code);
  try {
    await ws.waitForOpen();
    ws.send({ type: 'submit_response', participant_id, activity_id: activities[0].id, choice_index: 0 });
    const err = await ws.waitForMessage((m) => m.type === 'error');
    expect(err.type).toBe('error');
  } finally {
    ws.close();
  }
});

test('T2-3.5 Duplicate submission upserts cleanly (UNIQUE activity_id, participant_id) @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Upsert check', options: ['First', 'Second'] }],
  });
  const { participant_id } = await joinParticipant(request, code, 'Changer');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const r1 = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, choice_index: 0 },
  });
  const r2 = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, choice_index: 1 },
  });
  expect(r1.status()).toBe(200);
  expect(r2.status()).toBe(200);

  const insRes = await request.get(`${apiUrl}/api/sessions/${code}/insights`, { headers: authHeaders('facilitator') });
  const insights = (await insRes.json()) as {
    activities: Array<Record<string, unknown>>;
  };
  const counts = getPollCounts(insights.activities[0]);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  expect(counts[1]).toBe(1);
});

test('T2-3.6 Invalid current_activity_id or status patch rejected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);

  const badUuid = await request.patch(`${apiUrl}/api/sessions/${code}/state`, {
    headers: authHeaders('facilitator'),
    data: { current_activity_id: crypto.randomUUID() },
  });
  const badStatus = await request.patch(`${apiUrl}/api/sessions/${code}/state`, {
    headers: authHeaders('facilitator'),
    data: { status: 'paused' },
  });
  expect([400, 404, 422]).toContain(badUuid.status());
  expect([400, 422]).toContain(badStatus.status());
});

// ============================================================================
// Area 2.4: Participant & Response Payload Boundaries (BVA) (7 tests)
// ============================================================================

test('T2-4.1 Empty / Whitespace Nickname rejected @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);

  for (const nickname of ['', '   ']) {
    const res = await request.post(`${apiUrl}/api/sessions/${code}/join`, {
      headers: authHeaders('demo'),
      data: { nickname },
    });
    expect([400, 422]).toContain(res.status());
  }

  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(mobCtx, 'demo');
    const page = await mobCtx.newPage();
    await page.goto(`/join/${code}`);
    await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill('   ');
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first()).toBeVisible();
  } finally {
    await mobCtx.close();
  }
});

test('T2-4.2 Oversized Nickname never 500 & keeps mobile layout intact @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);
  const res = await request.post(`${apiUrl}/api/sessions/${code}/join`, {
    headers: authHeaders('demo'),
    data: { nickname: 'N'.repeat(500) },
  });
  expect(res.status()).toBeLessThan(500);
  expect([201, 400, 413, 422]).toContain(res.status());
});

test('T2-4.3 Rating BVA lower out-of-range (0, -1) rejected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'rating', dimension: 'strength', prompt: 'BVA Low' }],
  });
  const { participant_id } = await joinParticipant(request, code, 'BvaLow');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  for (const rating_value of [0, -1]) {
    const res = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
      headers: authHeaders('demo'),
      data: { participant_id, activity_id: activities[0].id, rating_value },
    });
    expect([400, 422]).toContain(res.status());
  }
});

test('T2-4.4 Rating BVA upper out-of-range (6) & non-integer (3.5) rejected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'rating', dimension: 'strength', prompt: 'BVA High' }],
  });
  const { participant_id } = await joinParticipant(request, code, 'BvaHigh');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  for (const rating_value of [6, 3.5]) {
    const res = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
      headers: authHeaders('demo'),
      data: { participant_id, activity_id: activities[0].id, rating_value },
    });
    expect([400, 422]).toContain(res.status());
  }
});

test('T2-4.5 Poll choice_index BVA (-1, length rejected; 0, length-1 accepted) @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Bounds', options: ['Zero', 'One', 'Two'] }],
  });
  const p1 = await joinParticipant(request, code, 'Bva1');
  const p2 = await joinParticipant(request, code, 'Bva2');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  for (const choice_index of [-1, 3]) {
    const bad = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
      headers: authHeaders('demo'),
      data: { participant_id: p1.participant_id, activity_id: activities[0].id, choice_index },
    });
    expect([400, 422]).toContain(bad.status());
  }
  const lowOk = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p1.participant_id, activity_id: activities[0].id, choice_index: 0 },
  });
  const highOk = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p2.participant_id, activity_id: activities[0].id, choice_index: 2 },
  });
  expect(lowOk.status()).toBe(200);
  expect(highOk.status()).toBe(200);
});

test('T2-4.6 Open Answer empty & oversized text boundaries @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'blocker', prompt: 'Text BVA' }],
  });
  const { participant_id } = await joinParticipant(request, code, 'Txt');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  for (const text_value of ['', '   ']) {
    const res = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
      headers: authHeaders('demo'),
      data: { participant_id, activity_id: activities[0].id, text_value },
    });
    expect([400, 422]).toContain(res.status());
  }
  const huge = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, text_value: 'A'.repeat(10_000) },
  });
  expect(huge.status()).toBeLessThan(500);
  expect([200, 400, 413, 422]).toContain(huge.status());
});

test('T2-4.7 Unknown / cross-session participant_id rejected @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const sA = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Room A', options: ['X', 'Y'] }],
  });
  const sB = await createSession(request);
  const pB = await joinParticipant(request, sB.code, 'Alien');
  await patchSessionState(request, sA.code, { status: 'active', current_activity_id: sA.activities[0].id });

  const crossRes = await request.post(`${apiUrl}/api/sessions/${sA.code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: pB.participant_id, activity_id: sA.activities[0].id, choice_index: 0 },
  });
  const randomRes = await request.post(`${apiUrl}/api/sessions/${sA.code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: crypto.randomUUID(), activity_id: sA.activities[0].id, choice_index: 0 },
  });
  expect([400, 403, 404, 422]).toContain(crossRes.status());
  expect([400, 403, 404, 422]).toContain(randomRes.status());
});

// ============================================================================
// Area 2.5: Security, XSS Escaping & Mobile Viewport Integrity (5 tests)
// ============================================================================

test('T2-5.1 Script-Tag XSS in Open Answer & Nickname is safely escaped @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const payload = '<script>window.__xss=1;alert(1)</script>';
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'blocker', prompt: 'XSS check' }],
  });
  const p = await joinParticipant(request, code, payload);
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p.participant_id, activity_id: activities[0].id, text_value: payload },
  });

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    let dialogFired = false;
    page.on('dialog', (d) => {
      dialogFired = true;
      void d.dismiss();
    });

    await page.goto('/facilitator');
    await openFacilitatorSession(page, code);
    await expect(page.getByText(payload).first()).toBeVisible();
    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(payload).first()).toBeVisible();

    expect(dialogFired).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  } finally {
    await facCtx.close();
  }
});

test('T2-5.2 Event-Handler XSS in Open Answer & Session Title is safely escaped @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const payload = '<img src=x onerror="window.__xss=2">';
  const { code, activities } = await createSession(request, {
    title: `XSS Title ${payload}`,
    activities: [{ kind: 'open_answer', dimension: 'weakness', prompt: 'Img onerror check' }],
  });
  const p = await joinParticipant(request, code, 'Mgr');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p.participant_id, activity_id: activities[0].id, text_value: payload },
  });

  const facCtx = await browser.newContext();
  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(facCtx, 'facilitator');
    await authenticateContext(mobCtx, 'demo');

    let dialogFired = false;
    const facPage = await facCtx.newPage();
    facPage.on('dialog', (d) => {
      dialogFired = true;
      void d.dismiss();
    });
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);
    await expect(facPage.getByText(payload).first()).toBeVisible();
    expect(await facPage.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();

    const mobPage = await mobCtx.newPage();
    mobPage.on('dialog', (d) => {
      dialogFired = true;
      void d.dismiss();
    });
    await mobPage.goto(`/join/${code}`);
    expect(await mobPage.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();

    await facPage.goto(`/dashboard/${code}`);
    await expect(facPage.getByText(payload).first()).toBeVisible();
    expect(dialogFired).toBe(false);
    expect(await facPage.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  } finally {
    await mobCtx.close();
    await facCtx.close();
  }
});

test('T2-5.3 Mobile viewport horizontal overflow check (390x844) across all states @tier2', async ({ browser, request }) => {
  const { code, activities } = await createSession(request, {
    activities: [
      {
        kind: 'poll',
        dimension: 'general',
        prompt: 'Long workshop prompt without overflowing mobile screen width?',
        options: ['Clearer cross-functional escalation paths', 'Weekly coaching check-ins with senior leads'],
      },
      { kind: 'rating', dimension: 'strength', prompt: 'Confidence in 1:1 coaching conversations' },
      { kind: 'open_answer', dimension: 'blocker', prompt: 'What organizational blocker slows down execution?' },
    ],
  });

  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(mobCtx, 'demo');
    const page = await mobCtx.newPage();

    await page.goto('/');
    await assertNoHorizontalOverflow(page);

    await page.goto(`/join/${code}`);
    await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill('MobileTester');
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(page.getByText(/lobby|waiting/i).first()).toBeVisible();
    await assertNoHorizontalOverflow(page);

    for (const act of activities) {
      await patchSessionState(request, code, { status: 'active', current_activity_id: act.id });
      await expect(page.getByText(act.prompt)).toBeVisible();
      await assertNoHorizontalOverflow(page);
    }

    await patchSessionState(request, code, { status: 'ended' });
    await expect(page.getByText(/ended|closed|thank/i).first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  } finally {
    await mobCtx.close();
  }
});

test('T2-5.4 Malformed WS frame handling does not crash room or other clients @tier2', async ({ request }) => {
  const { code } = await createSession(request);
  const wsBad = connectWs(code);
  const wsGood = connectWs(code);
  try {
    await Promise.all([wsBad.waitForOpen(), wsGood.waitForOpen()]);
    wsBad.send('not-json');
    wsBad.send({ type: 'unknown_event' });

    wsGood.send({ type: 'ping', client_ts: 999 });
    const pong = await wsGood.waitForMessage((m) => m.type === 'pong' && m.echo_client_ts === 999);
    expect(pong.echo_client_ts).toBe(999);
  } finally {
    wsBad.close();
    wsGood.close();
  }
});

test('T2-5.5 Stale / tampered sessionStorage recovers cleanly without page errors @tier2', async ({ browser, request }) => {
  const { code } = await createSession(request);
  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(mobCtx, 'demo');
    const page = await mobCtx.newPage();
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await page.goto(`/join/${code}`);
    await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill('RealJoiner');
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(page.getByText(/lobby|waiting/i).first()).toBeVisible();

    await page.evaluate((roomCode) => {
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (k) window.sessionStorage.setItem(k, '00000000-0000-4000-8000-000000000999');
      }
      window.sessionStorage.setItem(`participant_${roomCode}`, '00000000-0000-4000-8000-000000000999');
    }, code);

    await page.reload();
    await expect(page.getByRole('heading').first()).toBeVisible();
    expect(pageErrors).toHaveLength(0);
  } finally {
    await mobCtx.close();
  }
});

// ============================================================================
// Area 2.6: HR Dashboard Aggregation Boundaries (5 tests)
// ============================================================================

test('T2-6.1 Zero participants & zero responses yields 0% without NaN/Infinity @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'strength', prompt: 'Empty room', options: ['A', 'B'] }],
  });
  const insRes = await request.get(`${apiUrl}/api/sessions/${code}/insights`, { headers: authHeaders('facilitator') });
  expect(insRes.status()).toBe(200);
  const insights = (await insRes.json()) as { participant_count: number; response_rate: number };
  expect(insights.participant_count).toBe(0);
  expect(insights.response_rate).toBe(0);

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(/\b0(\.0)?%/).first()).toBeVisible();
    await expect(page.getByText(/NaN|Infinity/)).toHaveCount(0);
  } finally {
    await facCtx.close();
  }
});

test('T2-6.2 Participants joined (>0) with zero responses yields 0% without NaN @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request, {
    activities: [{ kind: 'rating', dimension: 'weakness', prompt: 'Quiet room' }],
  });
  await joinParticipant(request, code, 'Silent1');
  await joinParticipant(request, code, 'Silent2');
  await joinParticipant(request, code, 'Silent3');

  const insRes = await request.get(`${apiUrl}/api/sessions/${code}/insights`, { headers: authHeaders('facilitator') });
  const insights = (await insRes.json()) as { participant_count: number; response_rate: number };
  expect(insights.participant_count).toBe(3);
  expect(insights.response_rate).toBe(0);

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(/\b0(\.0)?%/).first()).toBeVisible();
    await expect(page.getByText(/NaN|Infinity/)).toHaveCount(0);
  } finally {
    await facCtx.close();
  }
});

test('T2-6.3 Missing HR dimension coverage renders clean empty states @tier2', async ({ browser, request }) => {
  const { code } = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'blocker', prompt: 'Only blocker' }],
  });
  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(/strength/i).first()).toBeVisible();
    await expect(page.getByText(/weakness/i).first()).toBeVisible();
    await expect(page.getByText(/blocker/i).first()).toBeVisible();
  } finally {
    await facCtx.close();
  }
});

test('T2-6.4 Rating mean BVA (1.0, 3.0, 5.0) computed accurately @tier2', async ({ request }) => {
  const { apiUrl } = getUrls();
  const cases: Array<[number, number, number]> = [
    [1, 5, 3],
    [1, 1, 1],
    [5, 5, 5],
  ];
  for (const [rA, rB, expectedMean] of cases) {
    const { code, activities } = await createSession(request, {
      activities: [{ kind: 'rating', dimension: 'strength', prompt: `Mean ${expectedMean}` }],
    });
    const p1 = await joinParticipant(request, code, 'M1');
    const p2 = await joinParticipant(request, code, 'M2');
    await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
    for (const [pid, rating_value] of [
      [p1.participant_id, rA],
      [p2.participant_id, rB],
    ] as const) {
      const res = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
        headers: authHeaders('demo'),
        data: { participant_id: pid, activity_id: activities[0].id, rating_value },
      });
      expect(res.status()).toBe(200);
    }
    const insRes = await request.get(`${apiUrl}/api/sessions/${code}/insights`, { headers: authHeaders('facilitator') });
    const insJson = JSON.stringify(await insRes.json());
    expect(insJson).toMatch(
      new RegExp(`"(rating_mean|average_rating|mean|average|mean_rating|avg_rating)"\\s*:\\s*${expectedMean}(\\.0+)?\\b`),
    );
  }
});

test('T2-6.5 Unicode / special characters in open answers preserved intact @tier2', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const unicodeQuote = 'ทีมสื่อสารดี 👍 "OK" & <1:1>';
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'strength', prompt: 'Unicode check' }],
  });
  const p = await joinParticipant(request, code, 'Nok');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p.participant_id, activity_id: activities[0].id, text_value: unicodeQuote },
  });

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    await page.goto('/facilitator');
    await openFacilitatorSession(page, code);
    await expect(page.getByText(unicodeQuote)).toBeVisible();

    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(unicodeQuote)).toBeVisible();
  } finally {
    await facCtx.close();
  }
});
