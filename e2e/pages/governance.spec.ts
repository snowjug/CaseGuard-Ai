import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { orFail, type Api } from '../support/api';
import { confirmDialog, toast } from '../support/flows';
import { openPage, settle } from '../support/ui';

interface Envelope<T = Record<string, unknown>> {
  value: T;
  version: number;
  changeNote: string;
}

const SECTIONS = [
  ['model', 'Model', 'Model configuration'],
  ['prompts', 'Prompts', null],
  ['scoring', 'Scoring', 'Quality scoring'],
  ['retention', 'Retention', 'Retention'],
  ['redaction', 'Redaction', 'Redaction'],
  ['flags', 'Feature flags', 'Feature flags'],
  ['export', 'Export', 'Export controls'],
  ['roles', 'Roles', 'Users and roles'],
  ['audit', 'Audit log', 'Audit events'],
  ['reviews', 'Reviewer decisions', 'Reviewer decisions'],
  ['operations', 'Provider and reset', 'AI provider'],
] as const;

const panelOf = (page: Page, label: string): Locator => page.getByRole('tabpanel', { name: label });

/** A retention write straight to the API, the way a second administrator's browser would make it. */
async function writeRetention(
  api: Api,
  expectedVersion: number,
  value: Record<string, unknown>,
  note: string,
): Promise<Envelope> {
  const response = await api.put<{ retention: Envelope }>('/governance/settings/retention', {
    value,
    expectedVersion,
    changeNote: note,
  });
  return orFail(response, 'PUT /governance/settings/retention').retention;
}

test.describe('[FR-GOV-01] Governance: eleven sections in the URL, each saying whether anything enforces it', () => {
  test.use({ persona: 'admin' });

  test('the sections are a vertical tab list; each opens its own panel and writes itself to the URL', async ({
    page,
  }) => {
    await openPage(page, '/governance');
    await expect(page.getByRole('heading', { level: 1, name: 'Governance' })).toBeVisible();
    const sections = page.getByRole('tablist', { name: 'Governance sections' });
    await expect(sections.getByRole('tab')).toHaveCount(SECTIONS.length);
    await expect(sections.getByRole('tab', { name: 'Model' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    for (const [id, label, heading] of SECTIONS) {
      await sections.getByRole('tab', { name: label, exact: true }).click();
      await settle(page);
      await expect(panelOf(page, label), label).toBeVisible();
      if (heading)
        await expect(
          panelOf(page, label).getByRole('heading', { level: 2, name: heading }).first(),
          `${label}: ${heading}`,
        ).toBeVisible();
      if (id === 'model') await expect(page).not.toHaveURL(/tab=/);
      else await expect(page).toHaveURL(new RegExp(`tab=${id}`));
    }
  });

  test('a section opens straight from its address, and "]" and "[" move to the next and the previous section', async ({
    page,
  }) => {
    await openPage(page, '/governance?tab=redaction');
    const sections = page.getByRole('tablist', { name: 'Governance sections' });
    await expect(sections.getByRole('tab', { name: 'Redaction' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press(']');
    await expect(sections.getByRole('tab', { name: 'Feature flags' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('[');
    // Each key press is a request for a section, answered after the address has changed: wait for the answer before
    // pressing again, as a person does.
    await expect(sections.getByRole('tab', { name: 'Redaction' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('[');
    await expect(sections.getByRole('tab', { name: 'Retention' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('every configuration section says plainly whether anything enforces it or it is recorded only', async ({
    page,
  }) => {
    const expectations: readonly (readonly [string, string, RegExp])[] = [
      ['model', 'Model', /Enforced/],
      ['scoring', 'Scoring', /Enforced/],
      ['retention', 'Retention', /Recorded only/],
      ['redaction', 'Redaction', /Enforced/],
      ['flags', 'Feature flags', /Recorded only/],
      ['export', 'Export', /Enforced/],
    ];
    for (const [id, label, effect] of expectations) {
      await openPage(page, `/governance?tab=${id}`);
      await expect(panelOf(page, label).getByRole('note').first(), label).toContainText(effect);
    }
    await openPage(page, '/governance?tab=retention');
    await expect(panelOf(page, 'Retention')).toContainText(
      'nothing is deleted when a period passes',
    );
    await openPage(page, '/governance?tab=flags');
    await expect(panelOf(page, 'Feature flags')).toContainText(
      'No part of the application reads these flags yet',
    );
  });

  test('prompts are read-only and traceable: every agent has its prompt, its hash and its full text one click away', async ({
    page,
    api,
  }) => {
    const listed = await api('admin').getOk<{ items: unknown[] }>('/governance/prompts');
    await openPage(page, '/governance?tab=prompts');
    const panel = panelOf(page, 'Prompts');
    await expect(panel.getByRole('note').first()).toContainText(
      'Prompt versions are defined in the application',
    );
    const prompts = panel.getByRole('list', { name: 'Prompt versions' });
    expect(listed.items.length).toBeGreaterThanOrEqual(9);
    await expect(prompts.getByRole('heading', { level: 2, name: /prompt$/ })).toHaveCount(
      listed.items.length,
    );
    await expect(
      prompts.getByRole('button', { name: /^Copy the full hash of the Timeline Analyzer prompt/ }),
    ).toBeVisible();
    await prompts
      .getByRole('button', { name: /^Show all [\d,]+ characters/ })
      .first()
      .click();
    await expect(
      prompts.getByRole('button', { name: /^Show less|^Collapse/ }).first(),
    ).toBeVisible();
  });

  test("redaction: credentials are always on and cannot be switched off; the personal-data choices are the administrator's", async ({
    page,
  }) => {
    await openPage(page, '/governance?tab=redaction');
    const panel = panelOf(page, 'Redaction');
    const credentials = panel.getByRole('group', { name: 'Credentials (always redacted)' });
    const switches = credentials.getByRole('switch');
    await expect(switches).toHaveCount(8);
    for (const toggle of await switches.all()) {
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeDisabled();
    }
    const personal = panel.getByRole('group', { name: 'Personal data (your choice)' });
    for (const name of ['Email addresses', 'IPv4 addresses', 'Phone numbers']) {
      await expect(personal.getByRole('switch', { name }), name).toBeEnabled();
    }
    await expect(
      panel.getByRole('group', { name: 'Custom patterns' }).getByRole('note'),
    ).toContainText('Custom patterns can be refused');
    await expect(panel.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  test("roles: the five people of this tenant are listed, the other tenant's are not, and the last administrator cannot be removed", async ({
    page,
    api,
    diagnostics,
  }) => {
    diagnostics.allow(/status of 409/);
    await openPage(page, '/governance?tab=roles');
    const table = page.getByRole('table', { name: 'Users and their roles' });
    await expect(table).toBeVisible();
    for (const name of [
      'Alex Admin (synthetic)',
      'Ava Engineer (synthetic)',
      'Casey Curator (synthetic)',
      'Morgan Manager (synthetic)',
      'Riley Reviewer (synthetic)',
    ]) {
      await expect(
        table.getByRole('rowheader', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) }),
        name,
      ).toBeVisible();
    }
    await expect(
      table.getByRole('rowheader', { name: /Fabi/ }),
      "another tenant's user is never listed",
    ).toHaveCount(0);
    await expect(table.getByRole('row').filter({ hasText: 'Alex Admin' })).toContainText(
      'Administrator',
    );

    await table.getByRole('button', { name: 'Change roles for Alex Admin (synthetic)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Change roles for Alex Admin (synthetic)' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Administrator' })).toBeChecked();
    await dialog.getByRole('checkbox', { name: 'Administrator' }).uncheck();
    await expect(dialog.getByRole('alert')).toContainText('Choose at least one role.');
    await dialog.getByRole('checkbox', { name: 'Support Manager' }).check();
    await dialog
      .getByRole('textbox', { name: /^Reason/ })
      .fill('End-to-end check that the last administrator is protected');
    await dialog.getByRole('button', { name: 'Save roles' }).click();
    await expect(dialog.getByText('Not changed')).toBeVisible();
    await expect(dialog).toContainText(/administrator/i);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    const users = await api('admin').getOk<{ items: { id: string; roles: string[] }[] }>(
      '/governance/users',
    );
    expect(
      users.items.find((user) => user.id === 'user_alex_admin')?.roles,
      'nothing was changed',
    ).toContain('administrator');
  });

  test('the provider is the deterministic offline one, with its validation note, and the reset is behind a confirmation', async ({
    page,
    api,
  }) => {
    await openPage(page, '/governance?tab=operations');
    const provider = page.getByRole('group', { name: 'AI provider' });
    await expect(provider).toContainText('Deterministic provider');
    await expect(provider).toContainText('Simulated');
    await expect(provider.getByRole('note')).toContainText('Validation note');
    await expect(provider.getByRole('note')).toContainText('fully offline, reproducible');
    await expect(provider.getByRole('term').filter({ hasText: 'Max input tokens' })).toBeVisible();
    await provider.getByRole('button', { name: 'Check again' }).click();
    await settle(page);

    const reset = page.getByRole('group', { name: 'Synthetic-data reset' });
    await reset.getByRole('button', { name: 'Reset demo data' }).click();
    await expect(
      confirmDialog(page).getByRole('heading', { name: 'Reset the demo data?' }),
    ).toBeVisible();
    await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog(page)).toBeHidden();
    await expect(reset.getByRole('link', { name: 'Open the Demo Guide' })).toHaveAttribute(
      'href',
      '/demo',
    );
    const state = await api('admin').getOk<{ steps: { completed: boolean }[] }>('/demo/state');
    expect(
      state.steps.filter((step) => step.completed),
      'cancelling erased nothing',
    ).toHaveLength(13);
  });
});

test.describe('[FR-GOV-02] a setting is saved with the version it started from, a change note, and an audit event', () => {
  test.use({ persona: 'admin' });
  test.setTimeout(240_000);

  test('saving needs a note; two people saving from the same version is a conflict, not a silent overwrite (on Retention, restored afterwards)', async ({
    page,
    api,
    diagnostics,
  }) => {
    diagnostics.allow(/status of 409/);
    const admin = api('admin');
    const initial = await admin.getOk<{
      retention: Envelope<Record<string, unknown> & { version: string }>;
    }>('/governance/settings');
    let latest: Envelope = initial.retention;
    const original = initial.retention.value;
    try {
      await openPage(page, '/governance?tab=retention');
      const panel = panelOf(page, 'Retention');
      await expect(panel.getByText(`Version ${latest.version}`, { exact: true })).toBeVisible();
      const label = panel.getByRole('textbox', { name: 'Version label' });
      const note = panel.getByRole('textbox', { name: 'Change note' });
      const save = panel.getByRole('button', { name: 'Save changes' });
      await expect(save).toBeDisabled();
      await expect(panel.getByRole('status')).toHaveText('No changes yet.');

      // 1. A change without a note is not saved, and says why.
      await label.fill(`e2e-${Date.now().toString(36)}`);
      await expect(panel.getByRole('status')).toHaveText('Unsaved changes.');
      await save.click();
      await expect(
        panel.getByText(/Describe the change in at least \d+ characters\./),
      ).toBeVisible();

      // 2. With a note it is saved as the next version, and the audit log has it.
      await note.fill('End-to-end check of the settings editor: first save');
      await save.click();
      await expect(toast(page, `Retention saved as version ${latest.version + 1}`)).toBeVisible();
      await expect(panel.getByText(`Version ${latest.version + 1}`, { exact: true })).toBeVisible();
      await expect(
        panel.getByText('Change note: End-to-end check of the settings editor: first save'),
      ).toBeVisible();
      const afterFirst = await admin.getOk<{ retention: Envelope }>('/governance/settings');
      expect(afterFirst.retention.version).toBe(latest.version + 1);
      latest = afterFirst.retention;
      const audit = await admin.getOk<{ items: { action: string; actorId: string }[] }>('/audit', {
        query: { limit: 20 },
      });
      expect(
        audit.items.some(
          (event) => /governance/i.test(event.action) && event.actorId === 'user_alex_admin',
        ),
        `the change is in the audit log (actions: ${audit.items.map((event) => event.action).join(', ')})`,
      ).toBe(true);

      // 3. Someone else saves while this form is open: the second save is refused, and nothing is lost silently.
      await label.fill('e2e-from-the-form');
      await note.fill('End-to-end check: the save that arrives second');
      latest = await writeRetention(
        admin,
        latest.version,
        { ...latest.value, version: 'e2e-from-the-api' },
        'Written while the form was open',
      );
      await save.click();
      const conflict = panel.getByRole('alert').filter({ hasText: 'Someone else saved first' });
      await expect(conflict).toBeVisible();
      await expect(conflict).toContainText(`You started from version ${latest.version - 1}.`);
      await expect(conflict).toContainText('Your changes were not saved');
      await conflict.getByRole('button', { name: 'Load the latest version' }).click();
      await expect(label).toHaveValue('e2e-from-the-api');
      await expect(panel.getByText(`Version ${latest.version}`, { exact: true })).toBeVisible();
      await expect(panel.getByRole('status')).toHaveText('No changes yet.');
    } finally {
      const current = await admin.getOk<{ retention: Envelope }>('/governance/settings');
      await writeRetention(
        admin,
        current.retention.version,
        original,
        'Restored after the end-to-end check',
      );
    }
  });

  test('export controls are enforced: with audit export switched off the button is disabled and says so; the API refuses it too (restored afterwards)', async ({
    page,
    api,
  }) => {
    const admin = api('admin');
    const initial = await admin.getOk<{ export_controls: Envelope<Record<string, unknown>> }>(
      '/governance/settings',
    );
    const original = initial.export_controls.value;
    try {
      const off = await admin.put<Envelope>('/governance/settings/export_controls', {
        value: { ...original, allowAuditExport: false },
        expectedVersion: initial.export_controls.version,
        changeNote: 'End-to-end check: audit export off',
      });
      orFail(off, 'PUT export_controls');
      await openPage(page, '/governance?tab=export');
      const panel = panelOf(page, 'Export');
      await expect(panel.getByRole('button', { name: 'Export the audit log' })).toBeDisabled();
      await expect(
        panel.getByText(
          'Audit-log export is switched off in the export controls above, so the API would refuse it.',
        ),
      ).toBeVisible();
      const refused = await admin.post('/governance/export', {
        scope: 'audit',
        reason: 'End-to-end check of the export switch',
      });
      expect(refused.status).toBe(403);
      expect(refused.problem?.reason).toBe('audit_export_disabled');
    } finally {
      const current = await admin.getOk<{ export_controls: Envelope }>('/governance/settings');
      orFail(
        await admin.put<Envelope>('/governance/settings/export_controls', {
          value: original,
          expectedVersion: current.export_controls.version,
          changeNote: 'Restored after the end-to-end check',
        }),
        'restore export_controls',
      );
    }
  });
});

test.describe('[FR-GOV-03] the audit log, its hash chain and the export of it', () => {
  test.use({ persona: 'admin' });
  test.setTimeout(240_000);

  test('the hash chain verifies, and the newest events are listed first with their hashes and correlation ids', async ({
    page,
    api,
  }) => {
    const before = await api('admin').getOk<{ items: { sequence: number }[] }>('/audit', {
      query: { limit: 1 },
    });
    await openPage(page, '/governance?tab=audit');
    const verification = page.getByRole('group', { name: 'Hash-chain verification' });
    await expect(verification.getByRole('status')).toContainText('Chain intact');
    await expect(verification.getByRole('status')).toContainText(
      /Verified \d+ audit events; the hash chain is intact/,
    );
    const verified = Number(
      /Verified (\d+) audit events/.exec(await verification.getByRole('status').innerText())![1],
    );
    expect(
      verified,
      'the chain covers at least every event that existed before the page was opened',
    ).toBeGreaterThanOrEqual(before.items[0]!.sequence);

    const events = page.getByRole('list', { name: /^Audit events, \d+ shown/ });
    await expect(events).toBeVisible();
    const first = events.getByRole('article').first();
    await expect(first).toContainText(/Success|Failure/);
    await expect(first.getByRole('button', { name: /^Copy the hash of event \d+/ })).toBeVisible();
    await expect(
      first.getByRole('button', { name: /^Copy the correlation id of event \d+/ }),
    ).toBeVisible();
    const sequences = await events
      .getByRole('article')
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          Number(/Audit event (\d+):/.exec(node.getAttribute('aria-label') ?? '')?.[1]),
        ),
      );
    expect(sequences.length).toBeGreaterThan(5);
    expect(sequences, 'newest first, no gaps').toEqual([...sequences].sort((a, b) => b - a));
    await expect(
      page.getByText(
        'Reading the audit log is itself recorded in the audit log, so this list does not refresh on its own.',
      ),
    ).toBeVisible();
  });

  test('filtering by action narrows the list, and the filter is in the URL', async ({ page }) => {
    await openPage(page, '/governance?tab=audit');
    const filter = page.getByRole('search', { name: 'Filter audit events' });
    const action = filter.getByRole('combobox', { name: 'Action' });
    await action.fill('analysis.completed');
    await expect(page).toHaveURL(/act=analysis\.completed/);
    const events = page.getByRole('list', { name: /^Audit events, \d+ shown/ });
    await expect(events).toBeVisible();
    // The list follows the filter once the narrower request has answered: until then it still shows the others.
    await expect
      .poll(
        () => events.getByRole('article').filter({ hasNotText: 'analysis.completed' }).count(),
        { message: 'only analysis.completed events remain' },
      )
      .toBe(0);
    await expect(events.getByRole('article').first()).toContainText('analysis.completed');
    await filter.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/act=/);
  });

  test('exporting the audit log asks for a reason, is audited first, and downloads the chain as JSON', async ({
    page,
    api,
  }) => {
    await openPage(page, '/governance?tab=export');
    const panel = panelOf(page, 'Export');
    await panel.getByRole('button', { name: 'Export the audit log' }).click();
    const dialog = confirmDialog(page);
    await expect(dialog.getByRole('heading', { name: 'Export the audit log?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(dialog.getByText('Enter at least 5 characters.')).toBeVisible();
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('textbox').fill('End-to-end check of the audit export');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^caseguard-audit-export-\d{4}-\d\d-\d\d\.json$/);
    const file = JSON.parse(readFileSync(await download.path(), 'utf8')) as {
      scope: string;
      recordCount: number;
      notice: string;
    };
    expect(file.scope).toBe('audit');
    expect(file.recordCount).toBeGreaterThan(50);
    await expect(toast(page, /^Exported \d+ records?$/)).toBeVisible();
    await expect(panel.getByRole('status').getByText('Last export')).toBeVisible();

    const audit = await api('admin').getOk<{ items: { action: string; actorId: string }[] }>(
      '/audit',
      { query: { limit: 10 } },
    );
    expect(
      audit.items.some(
        (event) => /export/i.test(event.action) && event.actorId === 'user_alex_admin',
      ),
      'the export is in the audit log',
    ).toBe(true);
  });

  test('reviewer decisions list every confirmation, correction and rejection with who made it and why', async ({
    page,
    api,
  }) => {
    const reviews = await api('admin').getOk<{ items: { id: string }[] }>('/governance/reviews', {
      query: { limit: 100 },
    });
    expect(
      reviews.items.length,
      'the story records the review of the accepted path',
    ).toBeGreaterThanOrEqual(1);
    await openPage(page, '/governance?tab=reviews');
    const panel = panelOf(page, 'Reviewer decisions');
    await expect(panel.getByRole('status').filter({ hasText: /^Showing/ })).toHaveText(
      new RegExp(`^Showing ${reviews.items.length} decisions?\\.`),
    );
    const list = panel.getByRole('list', {
      name: new RegExp(`^Reviewer decisions, ${reviews.items.length} shown`),
    });
    const first = list.getByRole('article').first();
    await expect(first).toContainText('Reason');
    await expect(first).toContainText('Before');
    await expect(first).toContainText('After');
    await expect(first.getByRole('link').first()).toHaveAttribute(
      'href',
      /^\/cases\/case_[^/]+\/counterfactual\?sel=scn_/,
    );
    await expect(panel.getByRole('note').first()).toContainText('Skill approvals');
  });
});

test.describe('[FR-GOV-04] Governance is for administrators, and reviewers read the audit log', () => {
  test.describe('as an engineer', () => {
    test.use({ persona: 'engineer' });
    test('the page says which permission is missing and who has it, and loads no configuration', async ({
      page,
    }) => {
      const requested: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/v1/governance') || path.startsWith('/api/v1/audit'))
          requested.push(path);
      });
      await openPage(page, '/governance');
      await expect(
        page.getByRole('heading', { level: 2, name: 'You do not have access to Governance' }),
      ).toBeVisible();
      await expect(
        page.getByText('Administrators, and reviewers for the audit log can open it.'),
      ).toBeVisible();
      expect(requested, 'nothing is requested without the permission').toEqual([]);
    });
  });

  test.describe('as a reviewer', () => {
    test.use({ persona: 'reviewer' });
    test('the page opens on the audit log; the configuration sections are explained, not failed', async ({
      page,
    }) => {
      await openPage(page, '/governance');
      const sections = page.getByRole('tablist', { name: 'Governance sections' });
      await expect(sections.getByRole('tab', { name: 'Audit log' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('group', { name: 'Hash-chain verification' })).toBeVisible();
      await sections.getByRole('tab', { name: 'Model' }).click();
      await expect(
        page.getByRole('heading', { level: 2, name: 'You do not have access to Model' }),
      ).toBeVisible();
      await expect(
        page.getByText(/does not include the "governance:read" permission/),
      ).toBeVisible();
    });
  });
});
