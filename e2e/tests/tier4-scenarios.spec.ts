/**
 * Tier 4 (@tier4): Real-world Live WorkShop workload & compliance scenarios (5 scenarios).
 * Includes 3-hour workshop flow, 30+1 WS concurrency & p95 latency benchmark, offline recovery, anonymity/XSS, and serial revocation.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  authenticateContext,
  authHeaders,
  connectWs,
  createSession,
  getConfig,
  getPollCounts,
  getResponseCount,
  getUrls,
  joinParticipant,
  newMobileContext,
  openFacilitatorSession,
  patchSessionState,
  runId,
  setDemoAccess,
  submitAndWait,
  type WsHandle,
} from './helpers.js';

/** Joins a mobile participant at /join/[code] without an account. */
async function joinOnMobile(page: Page, code: string, nickname: string): Promise<void> {
  await page.goto(`/join/${code}`);
  await page.getByPlaceholder(/name|nickname/i).or(page.getByLabel(/name|nickname/i)).first().fill(nickname);
  await page.getByRole('button', { name: /join|enter/i }).first().click();
}

/** Computes the p95 percentile (in ms) for a non-empty array of numeric latency samples. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

test('T4.1 Full 3-hour first-time manager workshop (1 facilitator + 4 mobile -> HR dashboard) @tier4', async ({
  browser,
  request,
}) => {
  const id = runId();
  const { code, activities } = await createSession(request, {
    title: `First-Time Mgr Workshop ${id}`,
    clientLabel: `Live WorkShop ${id}`,
    activities: [
      {
        kind: 'poll',
        dimension: 'strength',
        prompt: 'Strongest leadership habit?',
        options: ['Listening', 'Delegation', 'Clarity', 'Recognition'],
      },
      { kind: 'rating', dimension: 'weakness', prompt: 'Confidence handling difficult 1:1s?' },
      { kind: 'open_answer', dimension: 'blocker', prompt: 'What in our org is holding you back?' },
    ],
  });

  const facCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const mobCtxs = await Promise.all(Array.from({ length: 4 }, () => newMobileContext(browser)));
  try {
    await authenticateContext(facCtx, 'facilitator');
    await Promise.all(mobCtxs.map((c) => authenticateContext(c, 'demo')));

    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code, `First-Time Mgr Workshop ${id}`);

    const mobPages = await Promise.all(mobCtxs.map((c) => c.newPage()));
    await Promise.all(mobPages.map((p, i) => joinOnMobile(p, code, `Mgr-${i + 1}-${id}`)));
    for (const p of mobPages) {
      await expect(p.getByText(/lobby|waiting/i).first()).toBeVisible();
    }
    await expect(
      facPage.getByText(/\b4\s*(participants?|joined|present|in room)\b|participants?\s*[:\-]?\s*4\b/i).first(),
    ).toBeVisible();

    // Activity 1: poll / strength
    await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });
    for (const [i, p] of mobPages.entries()) {
      await expect(p.getByText('Strongest leadership habit?')).toBeVisible();
      const opt = ['Listening', 'Delegation', 'Listening', 'Clarity'][i];
      await submitAndWait(p, code, async () => {
        await p.getByRole('button', { name: new RegExp(opt, 'i') }).or(p.getByRole('radio', { name: new RegExp(opt, 'i') })).first().click();
        const sub = p.getByRole('button', { name: /submit|vote|send/i });
        if (await sub.isVisible().catch(() => false)) await sub.click();
      });
    }
    await expect(facPage.getByText(/\b50(\.0)?%/).first()).toBeVisible();

    // Brief lock check before stepping
    await patchSessionState(request, code, { is_open: false });
    await expect(mobPages[0].getByText(/locked|closed|paused/i).first()).toBeVisible();

    // Activity 2: rating / weakness
    await patchSessionState(request, code, { current_activity_id: activities[1].id, is_open: true });
    const ratings = [2, 4, 2, 4];
    for (const [i, p] of mobPages.entries()) {
      await expect(p.getByText('Confidence handling difficult 1:1s?')).toBeVisible();
      const v = ratings[i];
      await submitAndWait(p, code, async () => {
        await p.getByRole('button', { name: new RegExp(`^${v}(\\b|\\s|$)`) }).or(p.getByRole('radio', { name: new RegExp(`^${v}(\\b|\\s|$)`) })).first().click();
        const sub = p.getByRole('button', { name: /submit|send|rate/i });
        if (await sub.isVisible().catch(() => false)) await sub.click();
      });
    }
    await expect(facPage.getByText(/(mean|average|avg)[^0-9]*3(\.0+)?\b|\b3\.0+\b/i).first()).toBeVisible();

    // Activity 3: open_answer / blocker
    await patchSessionState(request, code, { current_activity_id: activities[2].id });
    for (const [i, p] of mobPages.entries()) {
      await expect(p.getByText('What in our org is holding you back?')).toBeVisible();
      await submitAndWait(p, code, async () => {
        await p.getByRole('textbox').first().fill(`Blocker insight ${i + 1} (${id})`);
        await p.getByRole('button', { name: /submit|send/i }).click();
      });
    }
    await expect(facPage.getByText(`Blocker insight 4 (${id})`)).toBeVisible();

    // End session -> HR Dashboard + reload persistence
    await patchSessionState(request, code, { status: 'ended' });
    await expect(mobPages[0].getByText(/ended|closed|thank/i).first()).toBeVisible();

    await facPage.goto(`/dashboard/${code}`);
    await facPage.reload();
    await expect(facPage.getByText(/strength/i).first()).toBeVisible();
    await expect(facPage.getByText(/weakness/i).first()).toBeVisible();
    await expect(facPage.getByText(/blocker/i).first()).toBeVisible();
    await expect(facPage.getByText(/\b100(\.0)?%/).first()).toBeVisible();
    await expect(facPage.getByText(`Blocker insight 1 (${id})`)).toBeVisible();
  } finally {
    await Promise.all(mobCtxs.map((c) => c.close()));
    await facCtx.close();
  }
});

test('T4.2 ~30 concurrent participants + 1 facilitator WS load & latency (R2: 0 drops, p95 < 100ms) @tier4', async ({
  browser,
  request,
}) => {
  test.setTimeout(60_000);
  const N = Math.max(30, Number(process.env.E2E_WS_PARTICIPANTS ?? 30));
  const p95BudgetMs = Number(process.env.E2E_WS_P95_BUDGET_MS ?? 100);
  const cfg = getConfig();

  const { code, activities } = await createSession(request, {
    title: `WS Load Room ${runId()}`,
    activities: [
      { kind: 'poll', dimension: 'general', prompt: 'Concurrent load poll', options: ['A', 'B', 'C', 'D'] },
    ],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const participants = await Promise.all(
    Array.from({ length: N }, (_, i) => joinParticipant(request, code, `LoadMgr-${i + 1}`)),
  );

  const facCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const facWs = connectWs(code, { facilitatorToken: cfg.facilitatorToken });
  const partWss: WsHandle[] = [];

  try {
    await authenticateContext(facCtx, 'facilitator');
    const facPage = await facCtx.newPage();
    await facPage.goto('/facilitator');
    await openFacilitatorSession(facPage, code);

    for (let i = 0; i < N; i++) {
      partWss.push(connectWs(code));
    }
    await Promise.all([facWs.waitForOpen(10_000), ...partWss.map((w) => w.waitForOpen(10_000))]);

    // Integer client_ts mapped to performance.now() ensures Rust i64/u64/f64 compatibility + sub-ms RTT.
    let seq = 1;
    const baseEpochUs = Date.now() * 1000;
    const sentAt = new Map<number, number>();
    const nextTs = () => {
      const ts = baseEpochUs + seq++;
      sentAt.set(ts, performance.now());
      return ts;
    };

    // Burst A: 30 concurrent pings -> pongs using true arrival timestamp
    const pingLatencies = await Promise.all(
      partWss.map(async (w) => {
        const ts = nextTs();
        w.send({ type: 'ping', client_ts: ts });
        const pong = await w.waitForMessage((m) => m.type === 'pong' && m.echo_client_ts === ts, 10_000);
        return (pong.receivedAt ?? performance.now()) - (sentAt.get(ts) ?? performance.now());
      }),
    );

    // Burst B: 30 concurrent submit_response -> N activity_tally broadcasts & response_count === N
    const tallyTimestamps = partWss.map((w, i) => {
      const ts = nextTs();
      w.send({
        type: 'submit_response',
        participant_id: participants[i].participant_id,
        activity_id: activities[0].id,
        choice_index: i % 4,
        client_ts: ts,
      });
      return ts;
    });

    await Promise.all([
      facWs.waitForMessage(() => {
        const tallies = facWs.messages.filter((m) => m.type === 'activity_tally');
        const echoedCount = tallies.filter(
          (m) => typeof m.echo_client_ts === 'number' && sentAt.has(m.echo_client_ts),
        ).length;
        const reachedFull = tallies.some((m) => getResponseCount(m.tally as Record<string, unknown>) === N);
        return echoedCount === N && reachedFull;
      }, 10_000),
      ...partWss.map((w) =>
        w.waitForMessage(
          (m) => m.type === 'activity_tally' && getResponseCount(m.tally as Record<string, unknown>) === N,
          10_000,
        ),
      ),
    ]);

    const tallyLatencies: number[] = [];
    const seenEchoes = new Set<number>();
    for (const m of facWs.messages) {
      if (m.type === 'activity_tally' && typeof m.echo_client_ts === 'number') {
        const t0 = sentAt.get(m.echo_client_ts);
        if (t0 !== undefined && !seenEchoes.has(m.echo_client_ts)) {
          seenEchoes.add(m.echo_client_ts);
          expect(typeof m.receivedAt).toBe('number');
          tallyLatencies.push((m.receivedAt as number) - t0);
        }
      }
    }

    expect(tallyTimestamps).toHaveLength(N);
    expect(tallyLatencies).toHaveLength(N);
    expect(facWs.errors).toHaveLength(0);
    expect(partWss.every((w) => w.errors.length === 0 && !w.isClosed())).toBe(true);
    expect(facWs.messages.some((m) => m.type === 'error')).toBe(false);
    expect(partWss.some((w) => w.messages.some((m) => m.type === 'error'))).toBe(false);

    expect(p95(pingLatencies)).toBeLessThan(p95BudgetMs);
    expect(p95(tallyLatencies)).toBeLessThan(p95BudgetMs);

    const insRes = await request.get(`${cfg.apiUrl}/api/sessions/${code}/insights`, {
      headers: authHeaders('facilitator'),
    });
    expect(insRes.status()).toBe(200);
    const ins = (await insRes.json()) as {
      participant_count: number;
      activities: Array<Record<string, unknown>>;
    };
    expect(ins.participant_count).toBe(N);
    expect(getResponseCount(ins.activities[0])).toBe(N);
    expect(getPollCounts(ins.activities[0]).reduce((a, b) => a + b, 0)).toBe(N);
    await expect(
      facPage
        .getByText(
          new RegExp(`\\b${N}\\s*(participants?|joined|responses?|\\/\\s*${N})\\b|(participants?|responses?)\\s*[:\\-]?\\s*${N}\\b`, 'i'),
        )
        .first(),
    ).toBeVisible();
  } finally {
    facWs.close();
    partWss.forEach((w) => w.close());
    await facCtx.close();
  }
});

test('T4.3 Mid-workshop mobile refresh, network drop (setOffline), WS reconnect & late-joiner catch-up @tier4', async ({
  browser,
  request,
}) => {
  const { apiUrl } = getUrls();
  const { code, activities } = await createSession(request, {
    activities: [
      { kind: 'poll', dimension: 'general', prompt: 'Offline Activity A', options: ['Alpha', 'Beta'] },
      { kind: 'rating', dimension: 'strength', prompt: 'Recovery Activity B' },
    ],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const mobA = await newMobileContext(browser);
  const mobB = await newMobileContext(browser);
  const facCtx = await browser.newContext();
  try {
    await authenticateContext(mobA, 'demo');
    await authenticateContext(mobB, 'demo');
    await authenticateContext(facCtx, 'facilitator');

    const pageA = await mobA.newPage();
    await joinOnMobile(pageA, code, 'MgrA');
    await expect(pageA.getByText('Offline Activity A')).toBeVisible();
    await submitAndWait(pageA, code, async () => {
      await pageA.getByRole('button', { name: /Alpha/i }).or(pageA.getByRole('radio', { name: /Alpha/i })).first().click();
      const sub1 = pageA.getByRole('button', { name: /submit|vote|send/i });
      if (await sub1.isVisible().catch(() => false)) await sub1.click();
    });

    await pageA.reload();
    await expect(pageA.getByText('Offline Activity A')).toBeVisible();

    // Simulate mobile network drop while facilitator advances to Activity B
    await mobA.setOffline(true);
    await patchSessionState(request, code, { current_activity_id: activities[1].id });
    await mobA.setOffline(false);

    await expect(pageA.getByText('Recovery Activity B')).toBeVisible({ timeout: 15_000 });

    // Late joiner B arrives after Activity B is already active
    const pageB = await mobB.newPage();
    await joinOnMobile(pageB, code, 'MgrB');
    await expect(pageB.getByText('Recovery Activity B')).toBeVisible();
    await expect(pageB.getByText('Offline Activity A')).toHaveCount(0);

    for (const p of [pageA, pageB]) {
      await submitAndWait(p, code, async () => {
        await p.getByRole('button', { name: /^5(\b|\s|$)/ }).or(p.getByRole('radio', { name: /^5(\b|\s|$)/ })).first().click();
        const sub2 = p.getByRole('button', { name: /submit|send|rate/i });
        if (await sub2.isVisible().catch(() => false)) await sub2.click();
      });
    }

    const insRes = await request.get(`${apiUrl}/api/sessions/${code}/insights`, { headers: authHeaders('facilitator') });
    const ins = (await insRes.json()) as { participant_count: number };
    expect(ins.participant_count).toBe(2);

    const dashPage = await facCtx.newPage();
    await dashPage.goto(`/dashboard/${code}`);
    await expect(
      dashPage
        .getByText(/\b2\s*(participants?|joined|responses?)\b|(participants?|responses?)\s*[:\-]?\s*2\b|\b100(\.0+)?%/i)
        .first(),
    ).toBeVisible();
  } finally {
    await mobB.close();
    await mobA.close();
    await facCtx.close();
  }
});

test('T4.4 Psychological safety, candid blocker reporting, XSS escaping & anonymized HR dashboard @tier4', async ({
  browser,
  request,
}) => {
  const { apiUrl } = getUrls();
  const id = runId();
  const nicknames = [`Alice-Mgr-${id}`, `Bob-Mgr-${id}`, `Carol-Mgr-${id}`];
  const quotes = [
    '<script>window.__xss=1</script>Approval takes 3 weeks',
    '<img src=x onerror="window.__xss=2">No 1:1 coaching budget',
    'Blocked by <VP> & rigid KPIs',
  ];

  const { code, activities } = await createSession(request, {
    activities: [{ kind: 'open_answer', dimension: 'blocker', prompt: 'Candid org blockers?' }],
  });
  await patchSessionState(request, code, { status: 'active', current_activity_id: activities[0].id });

  const joined = await Promise.all(nicknames.map((n) => joinParticipant(request, code, n)));
  for (const [i, p] of joined.entries()) {
    const res = await request.post(`${apiUrl}/api/sessions/${code}/responses`, {
      headers: authHeaders('demo'),
      data: { participant_id: p.participant_id, activity_id: activities[0].id, text_value: quotes[i] },
    });
    expect(res.status()).toBe(200);
  }
  await patchSessionState(request, code, { status: 'ended' });

  const insRes = await request.get(`${apiUrl}/api/sessions/${code}/insights`, { headers: authHeaders('facilitator') });
  const insText = JSON.stringify(await insRes.json());
  for (const n of nicknames) expect(insText).not.toContain(n);
  for (const p of joined) expect(insText).not.toContain(p.participant_id);

  const facCtx = await browser.newContext();
  try {
    await authenticateContext(facCtx, 'facilitator');
    const page = await facCtx.newPage();
    let dialogCount = 0;
    page.on('dialog', (d) => {
      dialogCount++;
      void d.dismiss();
    });

    await page.goto('/facilitator');
    await openFacilitatorSession(page, code);
    await expect(page.getByText(quotes[0]).first()).toBeVisible();
    expect(dialogCount).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();

    await page.goto(`/dashboard/${code}`);
    for (const q of quotes) await expect(page.getByText(q)).toBeVisible();
    for (const n of nicknames) await expect(page.getByText(n)).toHaveCount(0);
    expect(dialogCount).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  } finally {
    await facCtx.close();
  }
});

test.describe.serial('Owner emergency revocation & recovery (R3)', () => {
  test('T4.5 Owner revokes demo mid-workshop and restores cleanly via finally @tier4', async ({ browser, request }) => {
    const cfg = getConfig();
    const { code } = await createSession(request);

    // Non-admin caller must be rejected
    const unauthAdmin = await fetch(`${cfg.apiUrl}/api/admin/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Token': cfg.demoToken },
      body: JSON.stringify({ demo_active: false }),
    });
    expect([401, 403]).toContain(unauthAdmin.status);

    const mobWs = connectWs(code);
    const facCtx = await browser.newContext();
    try {
      await authenticateContext(facCtx, 'facilitator');
      const facPage = await facCtx.newPage();
      await facPage.goto('/facilitator');
      await mobWs.waitForOpen();

      await setDemoAccess(request, false);

      const revokedMsg = await mobWs.waitForMessage((m) => m.type === 'access_revoked', 5000);
      expect(revokedMsg.type).toBe('access_revoked');
      await mobWs.waitForClose(5000);
      const healthOff = await (await request.get(`${cfg.apiUrl}/api/health`)).json();
      expect(healthOff).toMatchObject({ status: 'ok', demo_active: false });

      const blockedFac = await fetch(`${cfg.apiUrl}/api/auth/facilitator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilitator_token: cfg.facilitatorToken }),
      });
      const blockedSession = await fetch(`${cfg.apiUrl}/api/sessions/${code}`);
      expect([401, 403, 503]).toContain(blockedFac.status);
      expect([401, 403, 503]).toContain(blockedSession.status);

      const rejectedWs = connectWs(code);
      try {
        await expect(rejectedWs.waitForOpen(3000)).rejects.toThrow();
      } finally {
        rejectedWs.close();
      }
    } finally {
      mobWs.close();
      await facCtx.close();
      await setDemoAccess(request, true);
    }

    // Verify full recovery after restoration
    const healthOn = await (await request.get(`${cfg.apiUrl}/api/health`)).json();
    expect(healthOn).toMatchObject({ status: 'ok', demo_active: true });
    const recovered = await joinParticipant(request, code, 'RecoveredMgr');
    expect(recovered.participant_id).toBeTruthy();
  });
});
