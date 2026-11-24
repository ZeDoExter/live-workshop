/**
 * Tier 3 (@tier3): Cross-feature pairwise combinatorial integration tests (6 multi-context tests).
 * Exercises multi-actor WS sync, late-joiner + lock/unlock, reconnect + upsert + persistence, revocation, concurrency, and session isolation.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  authenticateContext,
  authHeaders,
  connectWs,
  createSession,
  getConfig,
  getPollCounts,
  getRatingMean,
  getUrls,
  newMobileContext,
  openFacilitatorSession,
  patchSessionState,
  setDemoAccess,
  submitAndWait,
} from './helpers.js';

/** Joins a mobile participant at /join/[code] without an account. */
async function joinOnMobile(page: Page, code: string, nickname: string): Promise<void> {
  await page.goto(`/join/${code}`);
  await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill(nickname);
  await page.getByRole('button', { name: /join|enter/i }).first().click();
}

test('T3-01 Facilitator (1280x800) + 3 Mobile (390x844) across poll/rating/open_answer -> HR Dashboard @tier3', async ({
  browser,
  request,
}) => {
  const { code, activities } = await createSession(request, {
    activities: [
      { kind: 'poll', dimension: 'general', prompt: 'Pairwise Poll', options: ['Delegation', 'Coaching'] },
      { kind: 'rating', dimension: 'strength', prompt: 'Pairwise Strength Rating' },
      { kind: 'open_answer', dimension: 'blocker', prompt: 'Pairwise Org Blocker' },
    ],
  });

  const facCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const mobCtxs = await Promise.all([newMobileContext(browser), newMobileContext(browser), newMobileContext(browser)]);
  try {
    await authenticateContext(facCtx, 'facilitator');
    await Promise.all(mobCtxs.map((ctx) => authenticateContext(ctx, 'demo')));

    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);

    const mobPages = await Promise.all(mobCtxs.map((ctx) => ctx.newPage()));
    await Promise.all(mobPages.map((p, idx) => joinOnMobile(p, code, `Mgr-${idx + 1}`)));
    await expect(
      facPage.getByText(/\b3\s*(participants?|joined)\b|(participants?|joined)\s*[:\-]?\s*3\b/i).first(),
    ).toBeVisible();

    // Activity 1: Poll
    await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
    for (const p of mobPages) {
      await expect(p.getByText('Pairwise Poll')).toBeVisible();
      await submitAndWait(p, code, async () => {
        await p.getByRole('button', { name: /Delegation/i }).or(p.getByRole('radio', { name: /Delegation/i })).first().click();
        const sub = p.getByRole('button', { name: /submit|vote|send/i });
        if (await sub.isVisible().catch(() => false)) await sub.click();
      });
    }
    await expect(facPage.getByText(/\b100(\.0)?%/).first()).toBeVisible();

    // Activity 2: Rating (strength)
    await patchSessionState(request, code, { current_activity_id: activities[1].id });
    for (const [idx, p] of mobPages.entries()) {
      await expect(p.getByText('Pairwise Strength Rating')).toBeVisible();
      const val = idx === 0 ? 3 : 5;
      await submitAndWait(p, code, async () => {
        const re = new RegExp(`^${val}(\\b|\\s|$)`);
        await p.getByRole('button', { name: re }).or(p.getByRole('radio', { name: re })).first().click();
        const sub = p.getByRole('button', { name: /submit|send|rate/i });
        if (await sub.isVisible().catch(() => false)) await sub.click();
      });
    }

    // Activity 3: Open Answer (blocker)
    await patchSessionState(request, code, { current_activity_id: activities[2].id });
    for (const [idx, p] of mobPages.entries()) {
      await expect(p.getByText('Pairwise Org Blocker')).toBeVisible();
      await submitAndWait(p, code, async () => {
        await p.getByRole('textbox').first().fill(`Blocker note ${idx + 1}`);
        await p.getByRole('button', { name: /submit|send/i }).click();
      });
    }
    await expect(facPage.getByText('Blocker note 3')).toBeVisible();

    await patchSessionState(request, code, { status: 'ended' });
    await facPage.goto(`/dashboard/${code}`);
    await expect(facPage.getByText(/strength/i).first()).toBeVisible();
    await expect(facPage.getByText(/blocker/i).first()).toBeVisible();
    await expect(facPage.getByText('Blocker note 1')).toBeVisible();
  } finally {
    await Promise.all(mobCtxs.map((ctx) => ctx.close()));
    await facCtx.close();
  }
});

test('T3-02 Late joiner x step forward x lock/unlock @tier3', async ({ browser, request }) => {
  const { code, activities } = await createSession(request, {
    activities: [
      { kind: 'poll', dimension: 'general', prompt: 'Early Poll', options: ['Yes', 'No'] },
      { kind: 'rating', dimension: 'weakness', prompt: 'Late Rating' },
    ],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const facCtx = await browser.newContext();
  const mobA = await newMobileContext(browser);
  const mobB = await newMobileContext(browser);
  try {
    await authenticateContext(facCtx, 'facilitator');
    await authenticateContext(mobA, 'demo');
    await authenticateContext(mobB, 'demo');

    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);

    const pageA = await mobA.newPage();
    await joinOnMobile(pageA, code, 'EarlyMgr');
    await expect(pageA.getByText('Early Poll')).toBeVisible();
    await submitAndWait(pageA, code, async () => {
      await pageA.getByRole('button', { name: /Yes/i }).or(pageA.getByRole('radio', { name: /Yes/i })).first().click();
      const sub1 = pageA.getByRole('button', { name: /submit|vote|send/i });
      if (await sub1.isVisible().catch(() => false)) await sub1.click();
    });

    // Step forward and lock Activity 2 before LateMgr joins
    await patchSessionState(request, code, { current_activity_id: activities[1].id, is_open: false });
    const pageB = await mobB.newPage();
    await joinOnMobile(pageB, code, 'LateMgr');

    await expect(pageB.getByText('Late Rating')).toBeVisible();
    await expect(pageB.getByText('Early Poll')).toHaveCount(0);
    await expect(pageB.getByText(/locked|closed|paused/i).first()).toBeVisible();

    // Unlock Activity 2 -> LateMgr submits 5
    await patchSessionState(request, code, { is_open: true });
    await submitAndWait(pageB, code, async () => {
      await pageB.getByRole('button', { name: /^5(\b|\s|$)/ }).or(pageB.getByRole('radio', { name: /^5(\b|\s|$)/ })).first().click();
      const sub2 = pageB.getByRole('button', { name: /submit|send|rate/i });
      if (await sub2.isVisible().catch(() => false)) await sub2.click();
    });

    await expect(facPage.getByText(/(mean|average|avg)[^0-9]*5(\.0+)?\b|\b5\.0+\b/i).first()).toBeVisible();
    const snapRes = await request.get(`${getUrls().apiUrl}/api/sessions/${code}`, { headers: authHeaders('facilitator') });
    expect(snapRes.status()).toBe(200);
    const snap = (await snapRes.json()) as { current_tally?: Record<string, unknown> };
    expect(getRatingMean(snap.current_tally)).toBe(5);
  } finally {
    await mobB.close();
    await mobA.close();
    await facCtx.close();
  }
});

test('T3-03 Reconnect (reload) x upsert x fresh BrowserContext PostgreSQL persistence @tier3', async ({
  browser,
  request,
}) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'poll', dimension: 'general', prompt: 'Upsert Reload Poll', options: ['OptionZero', 'OptionOne'] }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const mobCtx = await newMobileContext(browser);
  try {
    await authenticateContext(mobCtx, 'demo');
    const mobPage = await mobCtx.newPage();
    await joinOnMobile(mobPage, code, 'ReloadMgr');
    await expect(mobPage.getByText('Upsert Reload Poll')).toBeVisible();
    await submitAndWait(mobPage, code, async () => {
      await mobPage.getByRole('button', { name: /OptionZero/i }).or(mobPage.getByRole('radio', { name: /OptionZero/i })).first().click();
      const sub1 = mobPage.getByRole('button', { name: /submit|vote|send/i });
      if (await sub1.isVisible().catch(() => false)) await sub1.click();
    });

    await mobPage.reload();
    await expect(mobPage.getByText('Upsert Reload Poll')).toBeVisible();
    await submitAndWait(mobPage, code, async () => {
      await mobPage.getByRole('button', { name: /OptionOne/i }).or(mobPage.getByRole('radio', { name: /OptionOne/i })).first().click();
      const sub2 = mobPage.getByRole('button', { name: /submit|vote|send/i });
      if (await sub2.isVisible().catch(() => false)) await sub2.click();
    });
  } finally {
    await mobCtx.close();
  }

  // Brand-new BrowserContext verifies PostgreSQL state cleanly
  const freshFacCtx = await browser.newContext();
  try {
    await authenticateContext(freshFacCtx, 'facilitator');
    const insRes = await freshFacCtx.request.get(`${apiUrl}/api/sessions/${code}/insights`);
    expect(insRes.status()).toBe(200);
    const ins = (await insRes.json()) as {
      participant_count: number;
      activities: Array<Record<string, unknown>>;
    };
    expect(ins.participant_count).toBe(1);
    expect(getPollCounts(ins.activities[0])).toEqual([0, 1]);

    const dashPage = await freshFacCtx.newPage();
    await dashPage.goto(`/dashboard/${code}`);
    await expect(dashPage.getByText('OptionOne')).toBeVisible();
  } finally {
    await freshFacCtx.close();
  }
});

test('T3-04 Active WS x runtime revocation (POST /api/admin/access) x clean restoration @tier3', async ({ request }) => {
  const cfg = getConfig();
  const { code } = await createSession(request);
  const { apiUrl } = getUrls();

  const facWs = connectWs(code, { facilitatorToken: cfg.facilitatorToken });
  const mobWs = connectWs(code);
  try {
    await Promise.all([facWs.waitForOpen(), mobWs.waitForOpen()]);

    await setDemoAccess(request, false);
    const [facRevoked, mobRevoked] = await Promise.all([
      facWs.waitForMessage((m) => m.type === 'access_revoked', 5000),
      mobWs.waitForMessage((m) => m.type === 'access_revoked', 5000),
    ]);
    expect(facRevoked.type).toBe('access_revoked');
    expect(mobRevoked.type).toBe('access_revoked');
    await Promise.all([facWs.waitForClose(5000), mobWs.waitForClose(5000)]);

    const healthRevoked = await request.get(`${apiUrl}/api/health`);
    expect(await healthRevoked.json()).toMatchObject({ status: 'ok', demo_active: false });

    const authBlocked = await fetch(`${apiUrl}/api/auth/facilitator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facilitator_token: cfg.facilitatorToken }),
    });
    const sessionBlocked = await fetch(`${apiUrl}/api/sessions/${code}`);
    expect([401, 403, 503]).toContain(authBlocked.status);
    expect([401, 403, 503]).toContain(sessionBlocked.status);

    const newWs = connectWs(code);
    try {
      await expect(newWs.waitForOpen(3000)).rejects.toThrow();
    } finally {
      newWs.close();
    }
  } finally {
    facWs.close();
    mobWs.close();
    await setDemoAccess(request, true);
  }

  const healthRestored = await request.get(`${apiUrl}/api/health`);
  expect(await healthRestored.json()).toMatchObject({ status: 'ok', demo_active: true });
  const reconnectWs = connectWs(code);
  try {
    await reconnectWs.waitForOpen();
  } finally {
    reconnectWs.close();
  }
});

test('T3-05 5 concurrent mobile contexts x all 3 HR dimensions @tier3', async ({ browser, request }) => {
  const { code, activities } = await createSession(request, {
    activities: [
      { kind: 'rating', dimension: 'strength', prompt: 'Concurrent Strength' },
      { kind: 'poll', dimension: 'weakness', prompt: 'Concurrent Weakness', options: ['Feedback', 'Priorities'] },
      { kind: 'open_answer', dimension: 'blocker', prompt: 'Concurrent Blocker' },
    ],
  });

  const mobCtxs = await Promise.all(Array.from({ length: 5 }, () => newMobileContext(browser)));
  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    await Promise.all(mobCtxs.map((ctx) => authenticateContext(ctx, 'demo')));
    const pages = await Promise.all(mobCtxs.map((ctx) => ctx.newPage()));

    await Promise.all(pages.map((p, i) => joinOnMobile(p, code, `Concurrent-${i + 1}`)));

    await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
    await Promise.all(
      pages.map(async (p) => {
        await expect(p.getByText('Concurrent Strength')).toBeVisible();
        await submitAndWait(p, code, async () => {
          await p.getByRole('button', { name: /^4(\b|\s|$)/ }).or(p.getByRole('radio', { name: /^4(\b|\s|$)/ })).first().click();
          const sub = p.getByRole('button', { name: /submit|send|rate/i });
          if (await sub.isVisible().catch(() => false)) await sub.click();
        });
      }),
    );

    await patchSessionState(request, code, { current_activity_id: activities[1].id });
    await Promise.all(
      pages.map(async (p) => {
        await expect(p.getByText('Concurrent Weakness')).toBeVisible();
        await submitAndWait(p, code, async () => {
          await p.getByRole('button', { name: /Feedback/i }).or(p.getByRole('radio', { name: /Feedback/i })).first().click();
          const sub = p.getByRole('button', { name: /submit|vote|send/i });
          if (await sub.isVisible().catch(() => false)) await sub.click();
        });
      }),
    );

    await patchSessionState(request, code, { current_activity_id: activities[2].id });
    await Promise.all(
      pages.map(async (p, i) => {
        await expect(p.getByText('Concurrent Blocker')).toBeVisible();
        await submitAndWait(p, code, async () => {
          await p.getByRole('textbox').first().fill(`Org friction item ${i + 1}`);
          await p.getByRole('button', { name: /submit|send/i }).click();
        });
      }),
    );

    await patchSessionState(request, code, { status: 'ended' });
    const dashPage = await facCtx.newPage();
    await dashPage.goto(`/dashboard/${code}`);
    await expect(dashPage.getByText(/\b100(\.0)?%/).first()).toBeVisible();
    for (let i = 1; i <= 5; i++) {
      await expect(dashPage.getByText(`Org friction item ${i}`)).toBeVisible();
    }
  } finally {
    await Promise.all(mobCtxs.map((ctx) => ctx.close()));
    await facCtx.close();
  }
});

test('T3-06 Multi-session isolation x cross-surface WS broadcasts @tier3', async ({ browser, request }) => {
  const sA = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'blocker', prompt: 'Prompt Only In A' }],
  });
  const sB = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'blocker', prompt: 'Prompt Only In B' }],
  });

  const mobA = await newMobileContext(browser);
  const mobB = await newMobileContext(browser);
  const facCtx = await browser.newContext();
  try {
    await authenticateContext(mobA, 'demo');
    await authenticateContext(mobB, 'demo');
    await authenticateContext(facCtx, 'facilitator');

    const pageA = await mobA.newPage();
    const pageB = await mobB.newPage();
    await joinOnMobile(pageA, sA.code, 'RoomAUser');
    await joinOnMobile(pageB, sB.code, 'RoomBUser');

    await patchSessionState(request, sA.code, { status: 'active', current_activity_id: sA.activities[0].id });
    await expect(pageA.getByText('Prompt Only In A')).toBeVisible();
    await expect(pageB.getByText(/lobby|waiting/i).first()).toBeVisible();
    await expect(pageB.getByText('Prompt Only In A')).toHaveCount(0);

    await pageA.getByRole('textbox').first().fill('Secret A blocker');
    await pageA.getByRole('button', { name: /submit|send/i }).click();

    const facPage = await facCtx.newPage();
    await facPage.goto(`/dashboard/${sB.code}`);
    await expect(facPage.getByText('Secret A blocker')).toHaveCount(0);
    await facPage.goto(`/dashboard/${sA.code}`);
    await expect(facPage.getByText('Secret A blocker')).toBeVisible();
  } finally {
    await mobB.close();
    await mobA.close();
    await facCtx.close();
  }
});
