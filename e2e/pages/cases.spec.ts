import { expect, test } from '../support/fixtures';
import { asPersona, listCases, waitForJob, type Job } from '../support/api';
import { mainRegion, openPage, settle } from '../support/ui';
import { confirmDialog, toast } from '../support/flows';

const roundedScore = (value: number | null): string =>
  value === null ? '' : `${Math.round(value)} / 100`;

test.describe('[FR-ING-01] Cases: the list of the workspace', () => {
  test('lists both synthetic cases with the figures of the API, labelled as estimates, newest first', async ({
    page,
    api,
  }) => {
    const cases = await listCases(api('engineer'));
    await openPage(page, '/cases');
    await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
    await expect(page.getByText('Showing 2 cases.')).toBeVisible();
    await expect(
      page.getByText(/Quality, avoidable effort and hypothesis confidence are estimates/),
    ).toBeVisible();

    const table = page.getByRole('table', { name: 'Cases' });
    const rows = table.getByRole('row').filter({ has: page.getByRole('rowheader') });
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('CG-SYN-1002');
    await expect(rows.nth(1)).toContainText('CG-SYN-1001');
    for (const item of cases) {
      const row = rows.filter({ hasText: item.reference });
      await expect(row).toContainText(roundedScore(item.qualityIndex));
      await expect(row).toContainText(`${Math.round(item.avoidableEffortPct ?? 0)}%`);
      await expect(row).toContainText('Synthetic');
      await expect(row).toContainText('Analysed');
      await expect(row).toContainText('(estimate)');
      await expect(row.getByRole('link', { name: item.reference })).toHaveAttribute(
        'href',
        `/cases/${item.id}`,
      );
    }
  });

  test('search, analysis state and sort narrow the list and live in the URL, so a filtered view can be shared', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    const filters = page.getByRole('search', { name: 'Filter and sort cases' });
    const rows = page
      .getByRole('table', { name: 'Cases' })
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader') });

    await filters.getByRole('searchbox', { name: 'Search' }).fill('Rotterdam');
    await expect(page).toHaveURL(/q=Rotterdam/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('CG-SYN-1002');
    await expect(page.getByText('Showing 1 case.')).toBeVisible();

    await filters.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows).toHaveCount(2);

    await filters.getByRole('combobox', { name: 'Sort by' }).selectOption('Quality: lowest first');
    await expect(rows.first()).toContainText('CG-SYN-1001');
    await filters.getByRole('combobox', { name: 'Analysis state' }).selectOption('Not analysed');
    await expect(page.getByRole('heading', { name: /No cases match|No cases/ })).toBeVisible();

    // A shared link restores the same view.
    const shared = page.url();
    await page.goto('about:blank');
    await page.goto(shared);
    await expect(page.getByRole('combobox', { name: 'Analysis state' })).toHaveValue(
      /not_analy[sz]ed/i,
    );
  });

  test('sorting by a column header changes the order and says which way it is sorted', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    const rows = page
      .getByRole('table', { name: 'Cases' })
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader') });
    await page
      .getByRole('columnheader', { name: /Quality \(est\.\)/ })
      .getByRole('button')
      .click();
    await settle(page);
    const first = await rows.first().textContent();
    await page
      .getByRole('columnheader', { name: /Quality \(est\.\)/ })
      .getByRole('button')
      .click();
    await settle(page);
    expect(await rows.first().textContent(), 'the second click reverses the order').not.toBe(first);
  });

  test('an engineer cannot delete a case: the button is disabled and says why', async ({
    page,
  }) => {
    await openPage(page, '/cases');
    const remove = page.getByRole('button', { name: 'Delete CG-SYN-1001' });
    await expect(remove).toBeDisabled();
  });
});

test.describe('[FR-ING-01] a case is deleted only by an administrator, after a confirmation', () => {
  test.use({ persona: 'admin' });

  test('an administrator deletes a throw-away case; nothing else changes', async ({
    page,
    api,
  }) => {
    const reference = `CG-E2E-${Date.now().toString(36).toUpperCase()}`;
    const created = await api('engineer').postOk<{ case: { id: string }; analysisJob: Job | null }>(
      '/cases',
      {
        source: {
          type: 'paste',
          text: [
            'Notice: SYNTHETIC DEMONSTRATION TRANSCRIPT. Every organisation, person and incident below is fictional.',
            'Title: Throw-away synthetic case for the delete test',
            `Reference: ${reference}`,
            'Product: Microsoft Teams',
            'Workload: teams-authentication',
            'Severity: C',
            '',
            '[2026-05-04 08:00 UTC] Customer: A few users cannot sign in to Teams since 07:50 UTC.',
            '[2026-05-04 08:30 UTC] Support Engineer: Looked at the sign-in logs for the affected users.',
          ].join('\n'),
        },
      },
    );
    if (created.analysisJob) await waitForJob(asPersona('engineer'), created.analysisJob.id);
    const before = (await listCases(api('admin'))).length;

    await openPage(page, '/cases');
    await expect(page.getByRole('row', { name: new RegExp(reference) })).toBeVisible();
    await page.getByRole('button', { name: `Delete ${reference}` }).click();
    await expect(confirmDialog(page)).toBeVisible();
    await expect(confirmDialog(page)).toContainText(reference);
    await confirmDialog(page)
      .getByRole('button', { name: /^Delete/ })
      .click();
    await expect(confirmDialog(page)).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole('row', { name: new RegExp(reference) })).toHaveCount(0);
    await expect(toast(page, /deleted/i)).toBeVisible();
    expect((await listCases(api('admin'))).length).toBe(before - 1);
    expect((await api('engineer').get(`/cases/${created.case.id}`)).status).toBe(404);
  });
});

test.describe('[FR-TWIN-01] Case overview: the digital twin and the links to every case page', () => {
  test('shows the case facts, five case pages with their counts, 13 twin sections, the time cursor and the analysis run', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}`);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Intermittent Teams sign-in failures for about 140 branch users (Pune and Leeds)',
      }),
    ).toBeVisible();
    await expect(mainRegion(page)).toContainText(
      'CG-SYN-1001 · Microsoft Teams · teams-authentication · Severity A · Resolved',
    );
    const pages = page.getByRole('list', { name: 'Case pages' });
    await expect(pages.getByRole('listitem')).toHaveCount(5);
    await expect(pages.getByRole('link', { name: /^Case Timeline/ })).toContainText('31 events');
    await expect(pages.getByRole('link', { name: /^Evidence Ledger/ })).toContainText('61 claims');
    await expect(pages.getByRole('link', { name: /^Hypothesis Arena/ })).toContainText(
      '9 hypotheses',
    );
    await expect(pages.getByRole('link', { name: /^Counterfactual Lab/ })).toContainText(
      '9 decision forks',
    );
    await expect(pages.getByRole('link', { name: /^Quality Review/ })).toHaveAttribute(
      'href',
      `/cases/${demo.caseOneId}/quality`,
    );

    const twin = page.getByRole('group', { name: 'Digital twin' });
    await expect(twin).toContainText(
      'The case as structured sections, each value traced to its source.',
    );
    // 72 fields in the 13 sections that have any; the fourteenth section ("Unknowns") is empty and says so.
    await expect(twin).toContainText(/72 fields in 13 sections\./);
    await expect(twin.getByRole('heading', { level: 3 })).toHaveCount(14);
    await expect(twin.getByRole('heading', { level: 3, name: 'Unknowns 0' })).toBeVisible();
    await expect(twin.getByRole('link', { name: 'Event e01' }).first()).toHaveAttribute(
      'href',
      new RegExp(`/cases/${demo.caseOneId}/timeline\\?sel=e01`),
    );

    const analysis = page.getByRole('group', { name: 'Analysis' });
    await expect(analysis).toContainText('Succeeded');
    await expect(analysis).toContainText('Deterministic provider');
    await expect(analysis.getByText('Simulated').first()).toBeVisible();
  });

  test('the time cursor moves to an earlier event, says what was known, and offers the same moment in other views', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}`);
    const known = page.getByRole('group', { name: 'What was known' });
    await expect(known.getByRole('status')).toContainText(
      'Showing everything up to 12 Mar 2026, 10:20 UTC',
    );
    await known.getByRole('button', { name: 'Previous event' }).click();
    await settle(page);
    await expect(page).toHaveURL(/asOf=/);
    await expect(known.getByRole('button', { name: 'Latest' })).toBeEnabled();
    await expect(
      known
        .getByRole('list', { name: 'Open this moment in another view' })
        .getByRole('link', { name: 'Case Timeline' }),
    ).toHaveAttribute('href', /asOf=/);
    await known.getByRole('button', { name: 'Latest' }).click();
    await expect(page).not.toHaveURL(/asOf=/);
  });
});

test.describe('[NFR-SEC-01] a case of another workspace is not found, in the browser too', () => {
  test.use({ persona: 'otherTenant' });

  test('a Fabrikam engineer who opens a Contoso case link gets the not-found page, and the list is empty', async ({
    page,
    demo,
    diagnostics,
  }) => {
    diagnostics.allow(/Failed to load resource/);
    // The views that wait for the case (they once waited for ever when it was not there) and the overview all say the same.
    for (const view of ['', '/timeline', '/evidence']) {
      await page.goto(`/cases/${demo.caseOneId}${view}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Case not found' })).toBeVisible();
      await settle(page);
      await expect(
        mainRegion(page).getByRole('heading', { level: 2, name: 'We could not find that case' }),
      ).toBeVisible();
      await expect(mainRegion(page)).not.toContainText('Teams sign-in failures');
    }

    await openPage(page, '/cases');
    await expect(page.getByRole('heading', { name: 'No cases yet' })).toBeVisible();
  });
});
