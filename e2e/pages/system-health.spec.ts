import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { mainRegion, openPage, settle } from '../support/ui';

interface Dependency {
  name: string;
  kind: string;
  status: string;
  simulated: boolean;
  detail: string;
}

interface Health {
  status: string;
  service: string;
  version: string;
  environment: string;
  dependencies: Dependency[];
  provider: { kind: string; model: string; simulated: boolean; validationNote: string };
  migrations: { applied: number; pending: number; latest: string | null };
}

/** `model_provider` → `Model provider`, the way the page names a dependency. */
const humanize = (name: string): string => {
  const text = name.replace(/[_-]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Opens a collapsed section of the page from its heading button and returns its content region. A closed section keeps
 * its content mounted but clipped, so Playwright would call it visible: what proves it is open is `aria-expanded`.
 */
async function openSection(page: Page, name: RegExp): Promise<Locator> {
  // The button inside the section's heading: a table in the section may have a sort button of the same name.
  const trigger = page.getByRole('heading', { name }).getByRole('button');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return page.getByRole('region', { name });
}

/** The moment of the health check: the page says "just now" and carries the exact UTC moment in the element. */
const checkedAt = (page: Page): Locator =>
  page
    .getByRole('group', { name: 'Overall status' })
    .locator('dl[aria-label="Service details"]')
    .locator('time');

test.describe('[FR-SYS-01] System status: what the environment is made of, and which parts are stand-ins', () => {
  test.use({ persona: 'admin' });

  test('the overall status, the service and its environment are the ones the API reports', async ({
    page,
    api,
  }) => {
    const health = await api('admin').getOk<Health>('/system/health');
    await openPage(page, '/system');
    await expect(page.getByRole('heading', { level: 1, name: 'System status' })).toBeVisible();
    const overall = page.getByRole('group', { name: 'Overall status' });
    await expect(overall).toContainText(
      health.status === 'healthy' ? 'Healthy' : /Degraded|Down|Unknown/,
    );
    await expect(overall).toContainText(`${health.service} ${health.version}`);
    const details = overall.locator('dl[aria-label="Service details"]');
    await expect(details).toContainText(health.environment);
    await expect(details).toContainText(/Uptime/);
    await expect(details).toContainText(/Checked \d{1,2} \w{3} 2026|Checked/);
    // The check time is relative text ("just now") with the exact UTC moment, to the second, in the element itself.
    await expect(checkedAt(page)).toBeVisible();
    await expect(checkedAt(page)).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    await expect(checkedAt(page)).toHaveAttribute('title', /^\d{1,2} \w{3} \d{4}, \d\d:\d\d UTC$/);
  });

  test('every dependency is a row, and each says whether it is a configured service or a simulated stand-in', async ({
    page,
    api,
  }) => {
    const health = await api('admin').getOk<Health>('/system/health');
    await openPage(page, '/system');
    // The dependencies are the section that is open when the page loads.
    await expect(
      page.getByRole('heading', { name: /^Dependencies/ }).getByRole('button'),
    ).toHaveAttribute('aria-expanded', 'true');
    const table = page.getByRole('table', { name: 'Dependencies and their health' });
    await expect(table).toBeVisible();
    for (const column of ['Dependency', 'Status', 'Source', 'Latency', 'Detail', 'Checked']) {
      await expect(table.getByRole('columnheader', { name: column }), column).toBeVisible();
    }
    for (const dependency of health.dependencies) {
      const row = table.getByRole('row').filter({
        has: page.getByRole('rowheader', { name: new RegExp(`^${humanize(dependency.name)}`) }),
      });
      await expect(row, dependency.name).toBeVisible();
      await expect(row, `${dependency.name}: real or simulated`).toContainText(
        dependency.simulated ? 'Simulated stand-in' : 'Configured service',
      );
      await expect(row, `${dependency.name}: detail`).toContainText(dependency.detail.slice(0, 40));
    }
    // Local runs are made of stand-ins; the page must say so and never present them as the cloud services.
    expect(
      health.dependencies.filter((dependency) => dependency.simulated).length,
    ).toBeGreaterThanOrEqual(4);
    await expect(table.getByText('Simulated stand-in').first()).toBeVisible();
  });

  test('"What is real here" lists the stand-ins and says no live Azure service was called', async ({
    page,
    api,
  }) => {
    const health = await api('admin').getOk<Health>('/system/health');
    await openPage(page, '/system');
    const real = await openSection(page, /^What is real here/);
    await expect(real).toBeVisible();
    await expect(
      real.getByText(
        'Azure OpenAI, Microsoft Entra ID sign-in, Azure Blob Storage, Azure AI Search and Azure Monitor are implemented, and were validated against mocks or locally generated test data only. No live Azure service was called to produce anything you see here.',
      ),
    ).toBeVisible();
    const standIns = real.getByRole('list', { name: 'Simulated stand-ins' });
    await expect(standIns.getByRole('listitem')).toHaveCount(
      health.dependencies.filter((dependency) => dependency.simulated).length,
    );
    await expect(real.getByRole('list', { name: 'Integrations not exercised live' })).toContainText(
      'PostgreSQL: local runs use PGlite',
    );
  });

  test('the AI provider is the deterministic offline one, with its validation note, limits and the migrations state', async ({
    page,
    api,
  }) => {
    const health = await api('admin').getOk<Health>('/system/health');
    expect(health.provider.kind).toBe('deterministic');
    await openPage(page, '/system');
    const provider = await openSection(page, /^AI provider/);
    await expect(provider).toContainText(health.provider.validationNote);
    const details = provider.locator('dl[aria-label="AI provider details"]');
    await expect(details).toContainText(health.provider.model);
    await expect(details).toContainText('Max input tokens');
    await expect(details).toContainText('Max retries');
    await expect(provider.getByText('Simulated').first()).toBeVisible();

    const migrations = await openSection(page, /^Migrations/);
    await expect(migrations).toContainText(
      health.migrations.pending === 0 ? 'Up to date' : `${health.migrations.pending} pending`,
    );
    await expect(migrations.locator('dl[aria-label="Migration details"]')).toContainText(
      health.migrations.latest ?? 'Not available',
    );
  });

  test('the counters of the API process are labelled as in-memory, and Refresh reads them again', async ({
    page,
  }) => {
    await openPage(page, '/system');
    const requests = await openSection(page, /^Requests/);
    await expect(requests).toContainText(
      "The counters live in this API instance's memory and reset when it restarts.",
    );
    await expect(requests.locator('dl[aria-label="Request totals and latency"]')).toContainText(
      'Median latency',
    );
    await expect(await openSection(page, /^Security events/)).toContainText(
      'Authentication failures',
    );
    const checked = checkedAt(page);
    const before = (await checked.getAttribute('datetime')) ?? '';
    expect(before, 'the page says when it checked').not.toBe('');
    // The check time has a resolution of one second: press Refresh until it has moved on, rather than sleeping first.
    const refresh = page.getByRole('button', { name: 'Refresh' });
    await expect(async () => {
      await refresh.click();
      await expect(checked).not.toHaveAttribute('datetime', before, { timeout: 2_000 });
    }, 'the check time moves on after Refresh').toPass({ timeout: 30_000 });
    await settle(page);
    await expect(mainRegion(page).getByRole('alert')).toHaveCount(0);
  });
});

test.describe('[FR-SYS-01] System status needs the telemetry permission', () => {
  test.describe('as a skill curator', () => {
    test.use({ persona: 'curator' });
    test('the page says which permission is missing and who has it, and requests nothing', async ({
      page,
    }) => {
      const requested: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/v1/system/'))
          requested.push(request.url());
      });
      await openPage(page, '/system');
      await expect(
        page.getByRole('heading', { level: 2, name: 'You do not have access to System status' }),
      ).toBeVisible();
      await expect(
        page.getByText(/does not include the "telemetry:read" permission/),
      ).toBeVisible();
      await expect(page.getByRole('table', { name: 'Dependencies and their health' })).toHaveCount(
        0,
      );
      expect(requested, 'no system request is made without the permission').toEqual([]);
    });
  });
});
