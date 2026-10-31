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

test.describe('[FR-SYS-01] System Health: what the environment is made of, and which parts are stand-ins', () => {
  test.use({ persona: 'admin' });

  test('the overall status, the service and its environment are the ones the API reports', async ({
    page,
    api,
  }) => {
    const health = await api('admin').getOk<Health>('/system/health');
    await openPage(page, '/system');
    await expect(page.getByRole('heading', { level: 1, name: 'System Health' })).toBeVisible();
    const overall = page.getByRole('group', { name: 'Overall status' });
    await expect(overall).toContainText(
      health.status === 'healthy' ? 'Healthy' : /Degraded|Down|Unknown/,
    );
    await expect(overall).toContainText(`${health.service} ${health.version}`);
    const details = overall.locator('dl[aria-label="Service details"]');
    await expect(details).toContainText(health.environment);
    await expect(details).toContainText(/Uptime/);
    await expect(details).toContainText(/Checked \d{1,2} \w{3} 2026|Checked/);
    await expect(page.getByText(/^Checked \d\d:\d\d:\d\d UTC$/)).toBeVisible();
  });

  test('every dependency is a row, and each says whether it is a configured service or a simulated stand-in', async ({
    page,
    api,
  }) => {
    const health = await api('admin').getOk<Health>('/system/health');
    await openPage(page, '/system');
    const table = page.getByRole('table', { name: 'Dependencies and their health' });
    await expect(table).toBeVisible();
    for (const column of [
      'Dependency',
      'Status',
      'Real or simulated',
      'Latency',
      'Detail',
      'Checked',
    ]) {
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
    const real = page.getByRole('group', { name: 'What is real here' });
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
    const provider = page.getByRole('group', { name: 'AI provider' });
    await expect(provider).toContainText(health.provider.validationNote);
    const details = provider.locator('dl[aria-label="AI provider details"]');
    await expect(details).toContainText(health.provider.model);
    await expect(details).toContainText('Max input tokens');
    await expect(details).toContainText('Max retries');
    await expect(provider.getByText('Simulated').first()).toBeVisible();

    const migrations = page.getByRole('group', { name: 'Migrations' });
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
    const requests = page.getByRole('group', { name: 'Requests' });
    await expect(requests).toContainText(
      "The counters live in this API instance's memory and reset when it restarts.",
    );
    await expect(requests.locator('dl[aria-label="Request totals and latency"]')).toContainText(
      'Median latency',
    );
    await expect(page.getByRole('group', { name: 'Security events' })).toContainText(
      'Authentication failures',
    );
    const checked = page.getByText(/^Checked \d\d:\d\d:\d\d UTC$/);
    const before = await checked.innerText();
    // The check time has a resolution of one second: press Refresh until it has moved on, rather than sleeping first.
    const refresh = page.getByRole('button', { name: 'Refresh' });
    await expect(async () => {
      await refresh.click();
      await expect(checked).not.toHaveText(before, { timeout: 2_000 });
    }, 'the check time moves on after Refresh').toPass({ timeout: 30_000 });
    await settle(page);
    await expect(mainRegion(page).getByRole('alert')).toHaveCount(0);
  });
});

test.describe('[FR-SYS-01] System Health needs the telemetry permission', () => {
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
        page.getByRole('heading', { level: 2, name: 'You do not have access to System Health' }),
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
