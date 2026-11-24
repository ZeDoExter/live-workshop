/**
 * Tier 1 (@tier1): Opaque-box feature coverage tests (33 tests across 6 areas).
 * Covers surfaces/auth, session & activity creation, state machine, mobile join, WS visuals, and HR dashboard.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  authenticateContext,
  authHeaders,
  connectWs,
  createSession,
  getConfig,
  getRatingMean,
  getUrls,
  joinParticipant,
  newMobileContext,
  openFacilitatorSession,
  patchSessionState,
  runId,
  submitAndWait,
} from './helpers.js';

/** Submits a poll choice on the participant mobile page using semantic role fallbacks. */
async function submitPollChoice(page: Page, optionPattern: RegExp): Promise<void> {
  const choice = page
    .getByRole('button', { name: optionPattern })
    .or(page.getByRole('radio', { name: optionPattern }))
    .or(page.getByLabel(optionPattern))
    .first();
  await expect(choice).toBeVisible();
  await choice.click();
  const submit = page.getByRole('button', { name: /submit|vote|send/i });
  if (await submit.isVisible().catch(() => false)) await submit.click();
}

/** Submits a 1-5 rating on the participant mobile page using semantic controls. */
async function submitRating(page: Page, value: number): Promise<void> {
  const re = new RegExp(`^${value}(\\b|\\s|$)`);
  const option = page
    .getByRole('button', { name: re })
    .or(page.getByRole('radio', { name: re }))
    .or(page.getByLabel(re))
    .first();
  await expect(option).toBeVisible();
  await option.click();
  const submit = page.getByRole('button', { name: /submit|send|rate/i });
  if (await submit.isVisible().catch(() => false)) await submit.click();
}

/** Submits an open-answer text response on the participant mobile page. */
async function submitOpenAnswer(page: Page, text: string): Promise<void> {
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible();
  await input.fill(text);
  await page.getByRole('button', { name: /submit|send/i }).click();
}

// ============================================================================
// Area 1.1: Surfaces, Navigation & Auth Gate (6 tests)
// ============================================================================

test('T1-1.1 Landing page renders join & facilitator entry @tier1', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'demo');
    const page = await context.newPage();
    await page.goto('/');
    const codeInput = page.getByPlaceholder(/code/i).or(page.getByLabel(/code/i)).first();
    await expect(codeInput).toBeVisible();
    await expect(page.getByRole('button', { name: /join|enter/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /facilitator/i }).or(page.getByRole('button', { name: /facilitator/i })).first()).toBeVisible();
    await expect(page.getByText(/acme corp|fake workshop/i)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('T1-1.2 General client accesses landing & room join by Room Code without login @tier1', async ({ browser, request }) => {
  const { code } = await createSession(request);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/');
    const codeInput = page.getByPlaceholder(/code/i).or(page.getByLabel(/code/i)).first();
    await expect(codeInput).toBeVisible();
    await codeInput.fill(code);
    await page.getByRole('button', { name: /join/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/join/${code}`, 'i'));
    await expect(page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('T1-1.3 Facilitator Better Auth sign-up & login unlocks console @tier1', async ({ browser }) => {
  const cfg = getConfig();
  const id = runId();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/facilitator');
    await page.getByRole('button', { name: /create account/i }).first().click();
    await page.getByLabel(/name/i).first().fill(`Facilitator ${id}`);
    await page.getByLabel(/email/i).first().fill(`fac_${id}@example.com`);
    await page.getByLabel(/password/i).first().fill('SecurePass123!');
    await page.getByRole('button', { name: /create account & sign in/i }).click();
    await expect(page.getByRole('button', { name: /create session/i }).first()).toBeVisible();

    const cookies = await context.cookies(cfg.baseUrl);
    expect(cookies.some((c) => c.name.includes('better-auth'))).toBe(true);
  } finally {
    await context.close();
  }
});

test('T1-1.4 Logout clears auth state @tier1', async ({ browser }) => {
  const { apiUrl } = getUrls();
  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const logoutRes = await context.request.post(`${apiUrl}/api/auth/logout`);
    expect(logoutRes.status()).toBe(200);
    const statusRes = await context.request.get(`${apiUrl}/api/auth/status`);
    expect(statusRes.status()).toBe(200);
    expect(await statusRes.json()).toMatchObject({
      facilitator_authenticated: false,
    });
  } finally {
    await context.close();
  }
});

test('T1-1.5 Health check returns active status @tier1', async ({ request }) => {
  const { apiUrl } = getUrls();
  const res = await request.get(`${apiUrl}/api/health`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok', demo_active: true });
});

test('T1-1.6 Navigation between /, /join/[code], /facilitator, /dashboard/[code] @tier1', async ({ browser, request }) => {
  const { code, session } = await createSession(request);
  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading').first()).toBeVisible();

    await page.goto(`/join/${code}`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    await page.goto('/facilitator');
    await expect(page.getByText(session.title).first()).toBeVisible();

    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(/strength|weakness|blocker/i).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

// ============================================================================
// Area 1.2: Session & Activity Creation (6 tests)
// ============================================================================

test('T1-2.1 Create workshop session @tier1', async ({ browser }) => {
  const id = runId();
  const title = `First-Time Managers ${id}`;
  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const page = await context.newPage();
    await page.goto('/facilitator');
    await page.getByLabel(/title/i).or(page.getByPlaceholder(/title|workshop/i)).first().fill(title);
    const clientInput = page.getByLabel(/client|org|company|label/i).or(page.getByPlaceholder(/client|org|label/i)).first();
    if (await clientInput.isVisible().catch(() => false)) await clientInput.fill(`Acme ${id}`);
    await page.getByRole('button', { name: /create/i }).first().click();
    await expect(page.getByText(title).first()).toBeVisible();
    await expect(page.getByText(/lobby/i).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('T1-2.2 List sessions on Facilitator Console @tier1', async ({ browser, request }) => {
  const { code, session } = await createSession(request);
  const { apiUrl } = getUrls();
  const listRes = await request.get(`${apiUrl}/api/sessions`, { headers: authHeaders('facilitator') });
  expect(listRes.status()).toBe(200);
  const items = (await listRes.json()) as Array<{ code: string; title: string }>;
  expect(items.some((s) => s.code === code && s.title === session.title)).toBe(true);

  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const page = await context.newPage();
    await page.goto('/facilitator');
    await expect(page.getByText(session.title).first()).toBeVisible();
    await expect(page.getByText(code).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('T1-2.3 Add poll activity with options & general dimension @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);
  const res = await request.post(`${apiUrl}/api/sessions/${code}/activities`, {
    headers: authHeaders('facilitator'),
    data: {
      kind: 'poll',
      dimension: 'general',
      prompt: 'Top delegation challenge?',
      options: ['Trust', 'Time', 'Clarity'],
    },
  });
  expect(res.status()).toBe(201);
  const created = (await res.json()) as { kind: string; dimension: string; options: string[] };
  expect(created.kind).toBe('poll');
  expect(created.dimension).toBe('general');
  expect(created.options).toEqual(['Trust', 'Time', 'Clarity']);

  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const page = await context.newPage();
    await page.goto('/facilitator');
    await openFacilitatorSession(page, code);
    await expect(page.getByText('Top delegation challenge?')).toBeVisible();
    await expect(page.getByText('Trust').first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('T1-2.4 Add rating activity with strength dimension @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);
  const res = await request.post(`${apiUrl}/api/sessions/${code}/activities`, {
    headers: authHeaders('facilitator'),
    data: { kind: 'rating', dimension: 'strength', prompt: 'Confidence giving feedback', options: [] },
  });
  expect(res.status()).toBe(201);
  expect(await res.json()).toMatchObject({ kind: 'rating', dimension: 'strength' });

  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const page = await context.newPage();
    await page.goto('/facilitator');
    await openFacilitatorSession(page, code);
    await expect(page.getByText('Confidence giving feedback')).toBeVisible();
    await expect(page.getByText(/strength/i).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('T1-2.5 Add open_answer activity with blocker dimension @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request);
  const res = await request.post(`${apiUrl}/api/sessions/${code}/activities`, {
    headers: authHeaders('facilitator'),
    data: { kind: 'open_answer', dimension: 'blocker', prompt: 'What org process slows you down?', options: [] },
  });
  expect(res.status()).toBe(201);
  expect(await res.json()).toMatchObject({ kind: 'open_answer', dimension: 'blocker' });

  const context = await browser.newContext();
  try {
    await authenticateContext(context, 'facilitator');
    const page = await context.newPage();
    await page.goto('/facilitator');
    await openFacilitatorSession(page, code);
    await expect(page.getByText('What org process slows you down?')).toBeVisible();
    await expect(page.getByText(/blocker/i).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('T1-2.6 Ordered multi-activity agenda covers all 4 HR dimensions @tier1', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code } = await createSession(request, {
    activities: [
      { kind: 'rating', dimension: 'strength', prompt: 'P1 Strength' },
      { kind: 'rating', dimension: 'weakness', prompt: 'P2 Weakness' },
      { kind: 'open_answer', dimension: 'blocker', prompt: 'P3 Blocker' },
      { kind: 'poll', dimension: 'general', prompt: 'P4 General', options: ['A', 'B'] },
    ],
  });
  const res = await request.get(`${apiUrl}/api/sessions/${code}`, { headers: authHeaders('demo') });
  expect(res.status()).toBe(200);
  const snap = (await res.json()) as { activities: Array<{ position: number; dimension: string; prompt: string }> };
  expect(snap.activities.map((a) => a.dimension)).toEqual(['strength', 'weakness', 'blocker', 'general']);
  for (let i = 1; i < snap.activities.length; i++) {
    expect(snap.activities[i].position).toBeGreaterThan(snap.activities[i - 1].position);
  }
});

// ============================================================================
// Area 1.3: Session State Machine & Controls (5 tests)
// ============================================================================

test('T1-3.1 Transition lobby -> active @tier1', async ({ request }) => {
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Ready?', options: ['Yes', 'No'] }],
  });
  const ws = connectWs(code);
  try {
    await ws.waitForOpen();
    await ws.waitForMessage((m) => m.type === 'room_snapshot');
    const snap = await patchSessionState(request, code, {
      status: 'active',
      current_activity_id: activities[0].id,
    });
    expect(snap.session.status).toBe('active');
    expect(snap.session.current_activity_id).toBe(activities[0].id);
    const msg = await ws.waitForMessage(
      (m) => m.type === 'room_snapshot' && (m.snapshot as { session: { status: string } })?.session?.status === 'active',
    );
    expect(msg.type).toBe('room_snapshot');
  } finally {
    ws.close();
  }
});

test('T1-3.2 Step active activity forward @tier1', async ({ request }) => {
  const { code, activities } = await createSession(request, {
    activities: [
      { kind: 'poll', dimension: 'general', prompt: 'Step 1', options: ['A', 'B'] },
      { kind: 'rating', dimension: 'strength', prompt: 'Step 2' },
    ],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  const ws = connectWs(code);
  try {
    await ws.waitForOpen();
    const snap = await patchSessionState(request, code, { current_activity_id: activities[1].id });
    expect(snap.session.current_activity_id).toBe(activities[1].id);
    const msg = await ws.waitForMessage(
      (m) =>
        m.type === 'room_snapshot' &&
        (m.snapshot as { session: { current_activity_id: string } })?.session?.current_activity_id === activities[1].id,
    );
    expect(msg.type).toBe('room_snapshot');
  } finally {
    ws.close();
  }
});

test('T1-3.3 Lock active activity (is_open: false) @tier1', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Lockable', options: ['A', 'B'] }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  const { participant_id } = await joinParticipant(request, code, 'Alex');

  const locked = await patchSessionState(request, code, { is_open: false });
  expect(locked.activities[0].is_open).toBe(false);

  const subRes = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, choice_index: 0 },
  });
  expect([400, 403, 409, 422]).toContain(subRes.status());
});

test('T1-3.4 Unlock active activity (is_open: true) @tier1', async ({ request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Unlockable', options: ['A', 'B'] }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id, is_open: false });
  const { participant_id } = await joinParticipant(request, code, 'Alex');

  const unlocked = await patchSessionState(request, code, { is_open: true });
  expect(unlocked.activities[0].is_open).toBe(true);

  const subRes = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id, activity_id: activities[0].id, choice_index: 0 },
  });
  expect(subRes.status()).toBe(200);
  expect(await subRes.json()).toMatchObject({ accepted: true });
});

test('T1-3.5 End session (active -> ended) @tier1', async ({ request }) => {
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'rating', dimension: 'strength', prompt: 'Final rating' }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  const ended = await patchSessionState(request, code, { status: 'ended' });
  expect(ended.session.status).toBe('ended');
});

// ============================================================================
// Area 1.4: Accountless Mobile Join & sessionStorage Reconnect (5 tests)
// ============================================================================

test('T1-4.1 Accountless join from / on mobile (390x844) @tier1', async ({ browser, request }) => {
  const { code } = await createSession(request);
  const mobile = await newMobileContext(browser);
  try {
    await authenticateContext(mobile, 'demo');
    const page = await mobile.newPage();
    await page.goto('/');
    await page.getByPlaceholder(/code/i).or(page.getByLabel(/code/i)).first().fill(code);
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/join/${code}`, 'i'));
    await expect(page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first()).toBeVisible();
    await expect(page.getByLabel(/password|email|sign up/i)).toHaveCount(0);
  } finally {
    await mobile.close();
  }
});

test('T1-4.2 Join room with nickname only @tier1', async ({ browser, request }) => {
  const { code } = await createSession(request);
  const mobile = await newMobileContext(browser);
  try {
    await authenticateContext(mobile, 'demo');
    const page = await mobile.newPage();
    await page.goto(`/join/${code}`);
    const joinPromise = page.waitForResponse((r) => r.url().includes(`/api/sessions/${code}/join`) && r.request().method() === 'POST');
    await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill('Alex');
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    const joinRes = await joinPromise;
    expect(joinRes.status()).toBe(201);
    const body = (await joinRes.json()) as { participant_id: string };
    expect(body.participant_id).toBeTruthy();
    await expect(page.getByText(/lobby|waiting/i).first()).toBeVisible();
  } finally {
    await mobile.close();
  }
});

test('T1-4.3 sessionStorage stores participant reconnect token @tier1', async ({ browser, request }) => {
  const { code } = await createSession(request);
  const mobile = await newMobileContext(browser);
  try {
    await authenticateContext(mobile, 'demo');
    const page = await mobile.newPage();
    await page.goto(`/join/${code}`);
    await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill('Alex');
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(page.getByText(/lobby|waiting/i).first()).toBeVisible();

    const storedValues = await page.evaluate(() => {
      const vals: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (k) vals.push(`${k}=${window.sessionStorage.getItem(k) ?? ''}`);
      }
      return vals;
    });
    expect(storedValues.some((entry) => entry.length > 0)).toBe(true);
  } finally {
    await mobile.close();
  }
});

test('T1-4.4 Reload /join/[code] reconnects without duplicate participant @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Reload check?', options: ['Yes', 'No'] }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const mobile = await newMobileContext(browser);
  try {
    await authenticateContext(mobile, 'demo');
    const page = await mobile.newPage();
    await page.goto(`/join/${code}`);
    await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill('Alex');
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(page.getByText('Reload check?')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Reload check?')).toBeVisible();
    const snapRes = await request.get(`${apiUrl}/api/sessions/${code}`, { headers: authHeaders('demo') });
    expect(((await snapRes.json()) as { participant_count: number }).participant_count).toBe(1);
  } finally {
    await mobile.close();
  }
});

test('T1-4.5 API reconnect contract reuses participant_id @tier1', async ({ request }) => {
  const { code } = await createSession(request);
  const first = await joinParticipant(request, code, 'Alex');
  const second = await joinParticipant(request, code, 'Alex', first.participant_id);
  expect(second.participant_id).toBe(first.participant_id);
  expect(second.snapshot.participant_count).toBe(1);
});

// ============================================================================
// Area 1.5: Live WebSocket Sync, Submissions & Room Visuals (6 tests)
// ============================================================================

test('T1-5.1 WebSocket handshake & ping/pong @tier1', async ({ request }) => {
  const { code } = await createSession(request);
  const ws = connectWs(code);
  try {
    await ws.waitForOpen();
    await ws.waitForMessage((m) => m.type === 'room_snapshot');
    ws.send({ type: 'ping', client_ts: 12345 });
    const pong = await ws.waitForMessage((m) => m.type === 'pong' && m.echo_client_ts === 12345);
    expect(pong.echo_client_ts).toBe(12345);
  } finally {
    ws.close();
  }
});

test('T1-5.2 Mobile screen auto-tracks lobby -> active @tier1', async ({ browser, request }) => {
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Live transition prompt', options: ['Go', 'Wait'] }],
  });
  const mobile = await newMobileContext(browser);
  try {
    await authenticateContext(mobile, 'demo');
    const page = await mobile.newPage();
    await page.goto(`/join/${code}`);
    await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill('Sam');
    await page.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(page.getByText(/lobby|waiting/i).first()).toBeVisible();

    await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
    await expect(page.getByText('Live transition prompt')).toBeVisible();
  } finally {
    await mobile.close();
  }
});

test('T1-5.3 Quick Poll submit updates live counts & percentages @tier1', async ({ browser, request }) => {
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Pick priority', options: ['Focus', 'Speed'] }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const facCtx = await browser.newContext();
  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(facCtx, 'facilitator');
    await authenticateContext(mobCtx, 'demo');

    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);

    const mobPage = await mobCtx.newPage();
    await mobPage.goto(`/join/${code}`);
    await mobPage.getByPlaceholder(/name|nickname/i).or(mobPage.getByLabel(/name|nickname/i)).first().fill('Pat');
    await mobPage.getByRole('button', { name: /join|enter/i }).first().click();
    await submitAndWait(mobPage, code, () => submitPollChoice(mobPage, /Speed/i));

    await expect(facPage.getByText(/\b100(\.0)?%/).first()).toBeVisible();
  } finally {
    await mobCtx.close();
    await facCtx.close();
  }
});

test('T1-5.4 Rating (1-5) submit updates live mean & histogram @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'rating', dimension: 'strength', prompt: 'Team clarity 1-5' }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const facCtx = await browser.newContext();
  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(facCtx, 'facilitator');
    await authenticateContext(mobCtx, 'demo');

    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);

    const p1 = await joinParticipant(request, code, 'Mgr1');
    const r1 = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
      headers: authHeaders('demo'),
      data: { participant_id: p1.participant_id, activity_id: activities[0].id, rating_value: 2 },
    });
    expect(r1.status()).toBe(200);

    const mobPage = await mobCtx.newPage();
    await mobPage.goto(`/join/${code}`);
    await mobPage.getByPlaceholder(/name|nickname/i).or(mobPage.getByLabel(/name|nickname/i)).first().fill('Mgr2');
    await mobPage.getByRole('button', { name: /join|enter/i }).first().click();
    await submitAndWait(mobPage, code, () => submitRating(mobPage, 4));

    await expect(facPage.getByText(/(mean|average|avg)[^0-9]*3(\.0+)?\b|\b3\.0+\b/i).first()).toBeVisible();
    const snapRes = await request.get(`${apiUrl}/api/sessions/${code}`, { headers: authHeaders('facilitator') });
    expect(snapRes.status()).toBe(200);
    const snap = (await snapRes.json()) as { current_tally?: Record<string, unknown> };
    expect(getRatingMean(snap.current_tally)).toBe(3);
  } finally {
    await mobCtx.close();
    await facCtx.close();
  }
});

test('T1-5.5 Open Answer submit updates live anonymous feed @tier1', async ({ browser, request }) => {
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'blocker', prompt: 'What blocks you?' }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const facCtx = await browser.newContext();
  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(facCtx, 'facilitator');
    await authenticateContext(mobCtx, 'demo');

    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);

    const mobPage = await mobCtx.newPage();
    await mobPage.goto(`/join/${code}`);
    await mobPage.getByPlaceholder(/name|nickname/i).or(mobPage.getByLabel(/name|nickname/i)).first().fill('AlexSecretName');
    await mobPage.getByRole('button', { name: /join|enter/i }).first().click();
    await submitAndWait(mobPage, code, () => submitOpenAnswer(mobPage, 'Too many approval layers'));

    await expect(facPage.getByText('Too many approval layers')).toBeVisible();
    await expect(facPage.getByText('AlexSecretName')).toHaveCount(0);
  } finally {
    await mobCtx.close();
    await facCtx.close();
  }
});

test('T1-5.6 Live participant count & response completion counter @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Completion check', options: ['One', 'Two'] }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);

    const p1 = await joinParticipant(request, code, 'One');
    await joinParticipant(request, code, 'Two');
    await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
      headers: authHeaders('demo'),
      data: { participant_id: p1.participant_id, activity_id: activities[0].id, choice_index: 0 },
    });

    await expect(facPage.getByText(/2\s*(participants|joined)|1\s*\/\s*2/i).first()).toBeVisible();
  } finally {
    await facCtx.close();
  }
});

// ============================================================================
// Area 1.6: HR Post-Session Dashboard & PostgreSQL Persistence (5 tests)
// ============================================================================

test('T1-6.1 HR Dashboard renders Strengths, Weaknesses, Blockers @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [
      { kind: 'rating', dimension: 'strength', prompt: 'Coaching empathy' },
      { kind: 'rating', dimension: 'weakness', prompt: 'Giving tough feedback' },
      { kind: 'open_answer', dimension: 'blocker', prompt: 'Org blocker' },
    ],
  });
  const p = await joinParticipant(request, code, 'Manager1');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p.participant_id, activity_id: activities[0].id, rating_value: 5 },
  });
  await patchSessionState(request, code, { current_activity_id: activities[1].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p.participant_id, activity_id: activities[1].id, rating_value: 2 },
  });
  await patchSessionState(request, code, { current_activity_id: activities[2].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p.participant_id, activity_id: activities[2].id, text_value: 'Slow legal signoff' },
  });
  await patchSessionState(request, code, { status: 'ended' });

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(/strength/i).first()).toBeVisible();
    await expect(page.getByText(/weakness/i).first()).toBeVisible();
    await expect(page.getByText(/blocker/i).first()).toBeVisible();
    await expect(page.getByText('Slow legal signoff')).toBeVisible();
  } finally {
    await facCtx.close();
  }
});

test('T1-6.2 HR Dashboard renders metrics & per-activity tallies @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'strength', prompt: 'Poll metric', options: ['Alpha', 'Beta'] }],
  });
  const p1 = await joinParticipant(request, code, 'P1');
  await joinParticipant(request, code, 'P2');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p1.participant_id, activity_id: activities[0].id, choice_index: 0 },
  });
  await patchSessionState(request, code, { status: 'ended' });

  const insightsRes = await request.get(`${apiUrl}/api/sessions/${code}/insights`, { headers: authHeaders('facilitator') });
  expect(insightsRes.status()).toBe(200);
  const insights = (await insightsRes.json()) as { participant_count: number; response_rate: number };
  expect(insights.participant_count).toBe(2);
  expect(insights.response_rate).toBeGreaterThan(0);

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText(/\b50(\.0)?%/).first()).toBeVisible();
    await expect(page.getByText('Alpha')).toBeVisible();
  } finally {
    await facCtx.close();
  }
});

test('T1-6.3 HR Dashboard renders anonymized open-answer quotes @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'strength', prompt: 'Best habit?' }],
  });
  const p = await joinParticipant(request, code, 'JordanHiddenName');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p.participant_id, activity_id: activities[0].id, text_value: 'Clearer 1:1 coaching' },
  });
  await patchSessionState(request, code, { status: 'ended' });

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    await page.goto(`/dashboard/${code}`);
    await expect(page.getByText('Clearer 1:1 coaching')).toBeVisible();
    await expect(page.getByText('JordanHiddenName')).toHaveCount(0);
  } finally {
    await facCtx.close();
  }
});

test('T1-6.4 PostgreSQL persistence across facilitator & dashboard reloads @tier1', async ({ browser, request }) => {
  const { apiUrl } = getUrls();
  const { code, session, activities } = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'blocker', prompt: 'Persist blocker' }],
  });
  const p = await joinParticipant(request, code, 'Mgr');
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
  await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
    headers: authHeaders('demo'),
    data: { participant_id: p.participant_id, activity_id: activities[0].id, text_value: 'Persisted quote in PG' },
  });

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    await page.goto('/facilitator');
    await page.reload();
    await expect(page.getByText(session.title).first()).toBeVisible();

    await page.goto(`/dashboard/${code}`);
    await page.reload();
    await expect(page.getByText('Persisted quote in PG')).toBeVisible();
  } finally {
    await facCtx.close();
  }
});

test('T1-6.5 Ended session state persists across reload @tier1', async ({ browser, request }) => {
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'End check', options: ['Yes', 'No'] }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const facCtx = await browser.newContext();
  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(facCtx, 'facilitator');
    await authenticateContext(mobCtx, 'demo');

    const mobPage = await mobCtx.newPage();
    await mobPage.goto(`/join/${code}`);
    await mobPage.getByPlaceholder(/name|nickname/i).or(mobPage.getByLabel(/name|nickname/i)).first().fill('EndTester');
    await mobPage.getByRole('button', { name: /join|enter/i }).first().click();
    await expect(mobPage.getByText('End check')).toBeVisible();

    await patchSessionState(request, code, { status: 'ended' });

    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);
    await facPage.reload();
    await expect(facPage.getByText(/ended/i).first()).toBeVisible();

    await mobPage.reload();
    await expect(mobPage.getByText(/ended|closed|thank/i).first()).toBeVisible();

    await facPage.goto(`/dashboard/${code}`);
    await facPage.reload();
    await expect(facPage.getByText(/ended/i).first()).toBeVisible();
  } finally {
    await mobCtx.close();
    await facCtx.close();
  }
});
