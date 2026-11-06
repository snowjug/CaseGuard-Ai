import { expect, test } from './support/fixtures';
import { asPersona, listCases, waitForJob, type ApiResponse, type Job } from './support/api';
import { freePort } from './support/echo-server';
import { startWebInstance, type RunningWeb } from './support/servers';
import { mainRegion, settle } from './support/ui';
import { storageStateFor } from './support/fixtures';

const unique = (): string =>
  `CG-E2E-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1_000)}`;

const PROBLEMS = [
  { status: 401, code: 'unauthenticated', retry: false },
  { status: 403, code: 'forbidden', retry: false },
  { status: 404, code: 'not_found', retry: true },
  { status: 409, code: 'conflict', retry: true },
  { status: 422, code: 'validation_failed', retry: true },
  { status: 500, code: 'internal', retry: true },
  { status: 503, code: 'provider_unavailable', retry: true },
] as const;

test.describe('[NFR-REL-01] every problem answer is shown in words, with its code and its request id', () => {
  for (const problem of PROBLEMS) {
    test(`${problem.status} ${problem.code}: an alert with the status, the code and the correlation id${problem.retry ? ', and Retry, which recovers' : ', and no Retry'}`, async ({
      page,
      diagnostics,
    }) => {
      diagnostics.allow(/Failed to load resource/);
      let failing = true;
      await page.route('**/api/v1/cases?*', async (route) => {
        if (!failing) return route.fallback();
        return route.fulfill({
          status: problem.status,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: `urn:caseguard:problem:${problem.code}`,
            title: 'A problem the test made up',
            status: problem.status,
            code: problem.code,
            detail: `The server said ${problem.status}.`,
            correlationId: `req_E2E${problem.status}`,
          }),
        });
      });
      await page.goto('/cases');
      const alert = mainRegion(page).getByRole('alert');
      await expect(alert).toBeVisible({ timeout: 60_000 });
      await expect(alert).toContainText(`HTTP ${problem.status}`);
      await expect(alert).toContainText(`Code ${problem.code}`);
      await expect(alert).toContainText(`Reference req_E2E${problem.status}`);
      await expect(alert.getByRole('button', { name: 'Copy reference' })).toBeVisible();
      await expect(
        mainRegion(page).getByRole('heading', { level: 1, name: 'Cases' }),
        'never a blank page',
      ).toBeVisible();

      const retry = alert.getByRole('button', { name: 'Retry' });
      if (!problem.retry) {
        await expect(retry).toHaveCount(0);
        return;
      }
      failing = false;
      await retry.click();
      await expect(page.getByRole('table', { name: 'Cases' })).toBeVisible({ timeout: 60_000 });
      await expect(mainRegion(page).getByRole('alert')).toHaveCount(0);
    });
  }

  test('429 rate_limited: the page waits for Retry-After and tries again by itself, then offers Retry', async ({
    page,
    diagnostics,
  }) => {
    diagnostics.allow(/Failed to load resource/);
    let calls = 0;
    await page.route('**/api/v1/cases?*', async (route) => {
      calls += 1;
      return route.fulfill({
        status: 429,
        contentType: 'application/problem+json',
        headers: { 'retry-after': '1' },
        body: JSON.stringify({
          type: 'urn:caseguard:problem:rate_limited',
          title: 'Too many requests',
          status: 429,
          code: 'rate_limited',
          detail: 'Slow down.',
          correlationId: 'req_E2E429',
        }),
      });
    });
    await page.goto('/cases');
    const alert = mainRegion(page).getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 90_000 });
    await expect(alert).toContainText('HTTP 429');
    await expect(alert).toContainText('Reference req_E2E429');
    expect(calls, 'the page honoured Retry-After and tried again before giving up').toBeGreaterThan(
      1,
    );
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('a problem on an earlier-view read names the engine budget instead of a generic error, with a countdown and a Retry', async ({
    page,
    demo,
    diagnostics,
  }) => {
    diagnostics.allow(/Failed to load resource/);
    await page.route('**/api/v1/cases/*/timeline?*asOf=*', async (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/problem+json',
        headers: { 'retry-after': '9' },
        body: JSON.stringify({
          type: 'urn:caseguard:problem:rate_limited',
          title: 'Too many earlier views',
          status: 429,
          code: 'rate_limited',
          reason: 'engine_budget',
          detail: 'The budget of earlier views is empty.',
          correlationId: 'req_E2EBUDGET',
        }),
      }),
    );
    await page.goto(`/cases/${demo.caseOneId}/timeline?asOf=2026-03-09T09%3A41%3A00Z`);
    await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
    const main = mainRegion(page);
    // The visible notice is a note; the sentence that announces it to a screen reader is a separate, hidden status.
    const limited = main.getByRole('note').filter({ hasText: /^Earlier views are limited/ });
    await expect(limited).toBeVisible({ timeout: 60_000 });
    await expect(limited).toContainText('the timeline could not be computed for this moment');
    await expect(
      main.getByRole('status').filter({
        hasText: /^(Earlier views are limited\. Try again in 9 seconds\.|You can retry now\.)$/,
      }),
    ).toHaveCount(1);
    await expect(limited.getByRole('button', { name: 'Show the whole record' })).toBeVisible();
    // The wait the server asked for counts down in the button, and the button is usable once it is over.
    await expect(limited.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled({
      timeout: 30_000,
    });
  });
});

test.describe('[NFR-REL-01] when the API is not there, the app says so and offers Retry; it never shows a blank page', () => {
  test.setTimeout(300_000);

  test('a web server whose API is down shows the failure state on Home and on Cases', async ({
    browser,
    diagnostics,
  }) => {
    diagnostics.allow(/Failed to load resource|ERR_|status of 5\d\d/);
    const dead = await freePort();
    let web: RunningWeb | null = null;
    try {
      web = await startWebInstance(`http://127.0.0.1:${dead}`);
      const context = await browser.newContext({
        storageState: storageStateFor('engineer', 'light', web.origin),
        baseURL: web.origin,
      });
      const page = await context.newPage();
      const probe = await page.request.get('/api/v1/me');
      expect(probe.status(), 'the web tier cannot reach the API').toBe(500);

      for (const route of ['/', '/cases']) {
        await page.goto(route);
        await expect(page.getByRole('main'), `${route} renders the shell`).toBeVisible();
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        const alert = page.getByRole('main').getByRole('alert');
        await expect(alert, `${route} shows a failure state`).toBeVisible({ timeout: 120_000 });
        await expect(alert).toContainText(
          /not reachable|could not be loaded|could not|unavailable/i,
        );
        await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
        const body = (await page.locator('body').innerText()).trim();
        expect(body.length, `${route} is not blank`).toBeGreaterThan(200);
      }
      await context.close();
    } finally {
      await web?.stop();
    }
  });

  test('on the shared stack, a network failure shows the failure state; Retry loads the data once the network is back', async ({
    page,
    diagnostics,
  }) => {
    diagnostics.allow(/Failed to load resource|ERR_/);
    let down = true;
    await page.route('**/api/v1/**', (route) =>
      down ? route.abort('connectionrefused') : route.fallback(),
    );
    await page.goto('/cases');
    const alert = mainRegion(page).getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 120_000 });
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(mainRegion(page).getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();

    down = false;
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('table', { name: 'Cases' })).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await expect(mainRegion(page).getByRole('alert')).toHaveCount(0);
  });
});

test.describe('[NFR-REL-01] repeating a request does not repeat its effect', () => {
  test.setTimeout(300_000);
  const created: string[] = [];
  test.afterAll(async () => {
    for (const id of created) await asPersona('admin').delete(`/cases/${id}`);
  });

  const body = (reference: string) => ({
    source: {
      type: 'paste',
      text: [
        'Notice: SYNTHETIC DEMONSTRATION TRANSCRIPT. Every organisation, person and incident below is fictional.',
        'Title: Synthetic case for the idempotency check',
        `Reference: ${reference}`,
        'Product: Microsoft Teams',
        'Workload: teams-authentication',
        'Severity: C',
        '',
        '[2026-05-04 08:00 UTC] Customer: A few users cannot sign in to Teams since 07:50 UTC.',
        '[2026-05-04 08:30 UTC] Support Engineer: Looked at the sign-in logs for the affected users.',
      ].join('\n'),
    },
    options: { analyze: false },
  });

  test('two identical creates sent at once with one Idempotency-Key produce one case; the replay says so', async ({
    api,
  }) => {
    const reference = unique();
    const key = `e2e-key-${reference.toLowerCase()}`;
    const engineer = api('engineer');
    const [first, second] = await Promise.all([
      engineer.post<{ case: { id: string }; created: boolean }>('/cases', body(reference), {
        headers: { 'idempotency-key': key },
      }),
      engineer.post<{ case: { id: string }; created: boolean }>('/cases', body(reference), {
        headers: { 'idempotency-key': key },
      }),
    ]);
    const answers: ApiResponse<{ case: { id: string } }>[] = [first, second];
    for (const answer of answers) {
      if (answer.ok) created.push(answer.body.case.id);
    }
    expect(
      answers.filter((answer) => answer.status === 201).length,
      'at least one create succeeded',
    ).toBeGreaterThanOrEqual(1);
    for (const answer of answers) {
      if (!answer.ok)
        expect(answer.problem).toMatchObject({ code: 'conflict', reason: 'request_in_progress' });
    }
    const matching = (await listCases(engineer)).filter((item) => item.reference === reference);
    expect(matching, 'one case, however many requests').toHaveLength(1);

    // Once the first has finished, a retry gets the stored answer, byte for byte, marked as a replay.
    const original =
      answers.find(
        (answer) => answer.status === 201 && answer.headers.get('idempotent-replayed') === null,
      ) ?? answers.find((answer) => answer.ok)!;
    const retry = await engineer.post('/cases', body(reference), {
      headers: { 'idempotency-key': key },
    });
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(retry.text).toBe(original.text);
  });

  test('the same key with a different request is refused with idempotency_conflict, and nothing is created', async ({
    api,
  }) => {
    const reference = unique();
    const key = `e2e-key-${reference.toLowerCase()}`;
    const engineer = api('engineer');
    const first = await engineer.post<{ case: { id: string } }>('/cases', body(reference), {
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(201);
    created.push(first.body.case.id);
    const other = unique();
    const conflict = await engineer.post('/cases', body(other), {
      headers: { 'idempotency-key': key },
    });
    expect(conflict.status).toBe(422);
    expect(conflict.problem?.code).toBe('idempotency_conflict');
    expect((await listCases(engineer)).filter((item) => item.reference === other)).toHaveLength(0);
  });

  test('another user cannot replay or block a key: keys are private to the person who sent them', async ({
    api,
  }) => {
    const reference = unique();
    const key = `e2e-key-${reference.toLowerCase()}`;
    const mine = await api('engineer').post<{ case: { id: string } }>('/cases', body(reference), {
      headers: { 'idempotency-key': key },
    });
    expect(mine.status).toBe(201);
    created.push(mine.body.case.id);
    const theirs = await api('manager').post('/cases', body(reference), {
      headers: { 'idempotency-key': key },
    });
    expect(theirs.status, 'a manager may not ingest at all').toBe(403);
    expect(theirs.headers.get('idempotent-replayed')).toBeNull();
  });

  test('asking for the same analysis twice does not run it twice: the second answer reuses the first run', async ({
    api,
  }) => {
    const reference = unique();
    const engineer = api('engineer');
    const made = await engineer.post<{ case: { id: string } }>('/cases', {
      ...body(reference),
      options: { analyze: true },
    });
    expect(made.status).toBe(201);
    created.push(made.body.case.id);
    const caseId = made.body.case.id;
    const analysis = made.body as unknown as { analysisJob: Job | null };
    if (analysis.analysisJob) await waitForJob(engineer, analysis.analysisJob.id);
    const again = await engineer.post<{ reused: boolean; job: Job }>(
      `/cases/${caseId}/analysis`,
      {},
    );
    expect(again.status).toBe(202);
    expect(again.body.reused, 'identical input never re-runs').toBe(true);
  });

  test('a stale version is a 409 version_conflict, not a silent overwrite (optimistic locking)', async ({
    api,
    demo,
  }) => {
    const skill = await api('curator').getOk<{ skill: { version: number } }>(
      `/skills/${demo.skillId}`,
    );
    const stale = await api('curator').post(`/skills/${demo.skillId}/transition`, {
      toState: 'deprecated',
      reason: 'e2e probe with a stale version: must be refused',
      expectedVersion: skill.skill.version - 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.problem?.code).toBe('version_conflict');
    expect(
      (
        await api('curator').getOk<{ skill: { version: number; lifecycle: string } }>(
          `/skills/${demo.skillId}`,
        )
      ).skill.lifecycle,
    ).not.toBe('deprecated');
  });
});
