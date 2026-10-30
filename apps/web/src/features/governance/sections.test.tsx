import { GovernanceSettingsSchema, type GovernanceSettings } from '@caseguard/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../../../test/fixtures';
import { expectNoAxeViolations, renderApp } from '../../../test/harness';
import { navigateTo } from '../../../test/next-navigation';
import { governanceSettings } from '../../../test/u4-fixtures';
import { governanceApi as api, expectToast } from '../../../test/u4-support';
import { ApiError } from '../../lib/api/errors';
import { GovernancePage } from './GovernancePage';

// The Model section renders a large form and axe walks all of it: allow for a busy machine.
vi.setConfig({ testTimeout: 120_000 });

interface UpdateInput {
  params: { section: keyof GovernanceSettings };
  body: { value: unknown; expectedVersion: number; changeNote: string };
}

/** A fake settings store: `governance.update` bumps the section's version like the API does. */
function store() {
  let current = governanceSettings();
  return {
    get: () => current,
    update: (input: unknown) => {
      const { params, body } = input as UpdateInput;
      current = GovernanceSettingsSchema.parse({
        ...current,
        [params.section]: {
          ...current[params.section],
          value: body.value,
          version: body.expectedVersion + 1,
          updatedBy: 'user_alex_admin',
          changeNote: body.changeNote,
        },
      });
      return current;
    },
    replace: (next: GovernanceSettings) => {
      current = next;
    },
  };
}

const open = (tab: string) => navigateTo(`/governance?tab=${tab}`);

describe('[FR-GOV-20] versioned section editor', () => {
  it('shows the version, who changed it and the change note, and says whether the section is enforced', async () => {
    open('model');
    renderApp(<GovernancePage />, { api: api() });
    const panel = await screen.findByRole('group', { name: 'Model configuration' });
    expect(within(panel).getByText('Version 1')).toBeInTheDocument();
    expect(within(panel).getByText(/by system:seed/)).toBeInTheDocument();
    expect(within(panel).getByText(/Change note: Default configuration/)).toBeInTheDocument();
    expect(within(panel).getByText('Enforced')).toBeInTheDocument();
    expect(within(panel).getByText(/The deployment's own limits always win/)).toBeInTheDocument();
  });

  it('says retention and feature flags are recorded only, so nobody assumes they do something', async () => {
    open('retention');
    const { unmount } = renderApp(<GovernancePage />, { api: api() });
    const retention = await screen.findByRole('group', { name: 'Retention' });
    expect(within(retention).getByText('Recorded only')).toBeInTheDocument();
    expect(within(retention).getByText(/no scheduled job enforces them yet/)).toBeInTheDocument();
    unmount();

    open('flags');
    renderApp(<GovernancePage />, { api: api() });
    const flags = await screen.findByRole('group', { name: 'Feature flags' });
    expect(within(flags).getByText('Recorded only')).toBeInTheDocument();
    expect(
      within(flags).getByText(/No part of the application reads these flags yet/),
    ).toBeInTheDocument();
    expect(within(flags).getByText(/come from the deployment's configuration/)).toBeInTheDocument();
  });

  it('says in one plain sentence, on each retention period and the legal hold, what is not enforced', async () => {
    open('retention');
    renderApp(<GovernancePage />, { api: api() });
    const retention = await screen.findByRole('group', { name: 'Retention' });
    const described: readonly [string, RegExp][] = [
      ['Case data', /^Recorded only: nothing deletes case data when this period ends\.$/],
      ['Audit trail', /^Recorded only: nothing deletes audit events when this period ends\.$/],
      [
        'Model executions',
        /^Recorded only: nothing deletes model execution records when this period ends\.$/,
      ],
      ['Analytics', /^Recorded only: nothing deletes analytics when this period ends\.$/],
    ];
    for (const [name, sentence] of described)
      expect(within(retention).getByRole('spinbutton', { name })).toHaveAccessibleDescription(
        sentence,
      );
    expect(
      within(retention).getByRole('switch', { name: 'Legal hold' }),
    ).toHaveAccessibleDescription(
      'Recorded only: nothing is deleted today, so a legal hold suspends nothing.',
    );
  });

  it('says in one plain sentence, on each feature flag, what the flag does not do', async () => {
    open('flags');
    renderApp(<GovernancePage />, { api: api() });
    const flags = await screen.findByRole('group', { name: 'Feature flags' });
    const switches = within(flags).getAllByRole('switch');
    expect(switches).toHaveLength(6);
    for (const toggle of switches) {
      const sentence = toggle.getAttribute('aria-describedby');
      const text = sentence ? (document.getElementById(sentence)?.textContent ?? '') : '';
      expect(text, toggle.getAttribute('id') ?? '').toMatch(/^Recorded only: this flag does not /);
      // One sentence: a single full stop (the Azure one has a semicolon, not a second sentence).
      expect(text.match(/\./g)).toHaveLength(1);
    }
    expect(
      within(flags).getByRole('switch', { name: 'Azure OpenAI provider' }),
    ).toHaveAccessibleDescription(/the deployment's configuration decides\.$/);
  });

  it('saves with the version the form started from and a change note, then shows the new version', async () => {
    const user = userEvent.setup();
    open('model');
    const settings = store();
    const fake = api({ 'governance.get': settings.get, 'governance.update': settings.update });
    renderApp(<GovernancePage />, { api: fake });
    const input = await screen.findByRole('spinbutton', { name: 'Max input tokens' });
    expect(input).toHaveValue(24000);
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '20000');
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();

    // A change note is mandatory: without it nothing is sent.
    await user.click(save);
    expect(
      await screen.findByText('Describe the change in at least 5 characters.'),
    ).toBeInTheDocument();
    expect(fake.call.mock.calls.some((call) => call[0] === 'governance.update')).toBe(false);

    await user.type(screen.getByRole('textbox', { name: /Change note/ }), 'Lower the input cap');
    await user.click(save);
    await expectToast('Model configuration saved as version 2');
    const update = fake.call.mock.calls.find((call) => call[0] === 'governance.update');
    const sent = update?.[1] as UpdateInput;
    expect(sent.params).toEqual({ section: 'model' });
    expect(sent.body.expectedVersion).toBe(1);
    expect(sent.body.changeNote).toBe('Lower the input cap');
    expect((sent.body.value as { maxInputTokens: number }).maxInputTokens).toBe(20000);
    const panel = await screen.findByRole('group', { name: 'Model configuration' });
    await waitFor(() => expect(within(panel).getByText('Version 2')).toBeInTheDocument());
    expect(within(panel).getByText(/Change note: Lower the input cap/)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Max input tokens' })).toHaveValue(20000);
  });

  it('blocks saving on a client-side validation error and names the limit', async () => {
    const user = userEvent.setup();
    open('model');
    const fake = api();
    renderApp(<GovernancePage />, { api: fake });
    const input = await screen.findByRole('spinbutton', { name: 'Max input tokens' });
    await user.clear(input);
    await user.type(input, '10');
    expect(await screen.findByText('Enter 256 or more.')).toBeInTheDocument();
    expect(screen.getByText('Fix the highlighted settings to save.')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    await user.click(save);
    expect(fake.call.mock.calls.some((call) => call[0] === 'governance.update')).toBe(false);
  });

  it('discards unsaved changes', async () => {
    const user = userEvent.setup();
    open('model');
    renderApp(<GovernancePage />, { api: api() });
    const input = await screen.findByRole('spinbutton', { name: 'Max input tokens' });
    await user.clear(input);
    await user.type(input, '20000');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('spinbutton', { name: 'Max input tokens' })).toHaveValue(24000);
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
  });

  it('shows the API validation problems on the right field, keeps the draft and clears a problem when it is edited', async () => {
    const user = userEvent.setup();
    open('redaction');
    const fake = api({
      'governance.update': () => {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          title: 'Unprocessable',
          message: 'Invalid redaction settings',
          issues: [
            {
              path: 'body.value.customPatterns.0.pattern',
              message: 'The pattern can backtrack catastrophically (nested repetition).',
            },
          ],
        });
      },
    });
    renderApp(<GovernancePage />, { api: fake });
    await user.click(await screen.findByRole('button', { name: 'Add a pattern' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Order id');
    const pattern = screen.getByRole('textbox', { name: 'Pattern' });
    await user.type(pattern, '(a+)+$');
    await user.type(screen.getByRole('textbox', { name: /Change note/ }), 'Try a custom pattern');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText(/The API refused these settings \(1 problem\)\. Nothing was saved\./),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/can backtrack catastrophically/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('list', { name: 'Problems reported by the API' })).toBeInTheDocument();
    expect(pattern).toHaveValue('(a+)+$');

    await user.type(pattern, 'x');
    await waitFor(() =>
      expect(screen.queryAllByText(/can backtrack catastrophically/)).toHaveLength(0),
    );
  });

  it('says plainly that someone else saved first on a 409 and offers the latest version', async () => {
    const user = userEvent.setup();
    open('model');
    const settings = store();
    const fake = api({
      'governance.get': settings.get,
      'governance.update': () => {
        // Someone else saves version 2 in the meantime.
        settings.replace(
          governanceSettings({
            model: {
              value: { ...settings.get().model.value, temperature: 0.7 },
              version: 2,
              updatedBy: 'user_other_admin',
              changeNote: 'Raised temperature',
            },
          }),
        );
        throw new ApiError({
          status: 409,
          code: 'version_conflict',
          title: 'Conflict',
          message:
            'Governance section model was modified by someone else (expected version 1, found 2). Reload and retry.',
        });
      },
    });
    renderApp(<GovernancePage />, { api: fake });
    const temperature = await screen.findByRole('spinbutton', { name: 'Temperature' });
    await user.clear(temperature);
    await user.type(temperature, '0.3');
    await user.type(screen.getByRole('textbox', { name: /Change note/ }), 'Make it more varied');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const alert = await screen.findByText('Someone else saved first');
    const notice = alert.closest('[role="note"]') as HTMLElement;
    expect(within(notice).getByText(/expected version 1, found 2/)).toBeInTheDocument();
    expect(within(notice).getByText(/Your changes were not saved/)).toBeInTheDocument();

    await user.click(within(notice).getByRole('button', { name: 'Load the latest version' }));
    await waitFor(() =>
      expect(screen.getByRole('spinbutton', { name: 'Temperature' })).toHaveValue(0.7),
    );
    const panel = screen.getByRole('group', { name: 'Model configuration' });
    expect(within(panel).getByText('Version 2')).toBeInTheDocument();
    expect(screen.queryByText('Someone else saved first')).toBeNull();
  });

  it('is view-only for a role that cannot write, with the fields disabled and an explanation', async () => {
    open('model');
    renderApp(<GovernancePage />, {
      api: api({
        'session.me': () => session('administrator', ['case:read', 'governance:read']),
      }),
    });
    const input = await screen.findByRole('spinbutton', { name: 'Max input tokens' });
    expect(input).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(
      screen.getByText(/Your role can read this section but not change it/),
    ).toBeInTheDocument();
  });
});

describe('[FR-GOV-21] model configuration', () => {
  it('never turns an unset cost limit or price into zero', async () => {
    open('model');
    renderApp(<GovernancePage />, { api: api() });
    await screen.findByRole('group', { name: 'Model configuration' });
    const limits = screen.getAllByPlaceholderText('No limit set');
    expect(limits).toHaveLength(3);
    for (const box of limits) expect(box).toHaveValue(null);
    const prices = screen.getAllByPlaceholderText('Not configured');
    expect(prices).toHaveLength(3);
    expect(screen.getByText(/cost is shown as unknown, never as zero/)).toBeInTheDocument();
  });

  it('says the provider is chosen by the deployment and lists every agent budget in order', async () => {
    open('model');
    renderApp(<GovernancePage />, { api: api() });
    expect(
      await screen.findByText(/The provider in use is chosen by the deployment/),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Per-agent budgets' });
    const names = within(table)
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent);
    expect(names).toEqual([
      'Timeline Analyzer',
      'Evidence Classifier',
      'Hypothesis Generator',
      'Decision-Fork Detector',
      'Counterfactual Simulator',
      'Quality Judge',
      'SkillDNA Extractor',
      'Communication Coach',
      'Token Governor',
      'Safety and Policy Validator',
    ]);
  });

  it('adds and removes a routing rule', async () => {
    const user = userEvent.setup();
    open('model');
    renderApp(<GovernancePage />, { api: api() });
    await user.click(await screen.findByRole('button', { name: 'Add a routing rule' }));
    const rules = screen.getByRole('list', { name: 'Model routing rules' });
    expect(within(rules).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove routing rule 1' }));
    expect(screen.queryByRole('list', { name: 'Model routing rules' })).toBeNull();
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
  });
});

describe('[FR-GOV-22] scoring, redaction and export controls', () => {
  it('refuses score bands that do not descend and says why', async () => {
    const user = userEvent.setup();
    open('scoring');
    renderApp(<GovernancePage />, { api: api() });
    const quality = await screen.findByRole('group', { name: 'Quality scoring' });
    const adequate = within(quality).getByRole('spinbutton', { name: 'Adequate from' });
    await user.clear(adequate);
    await user.type(adequate, '95');
    expect(
      await within(quality).findByText('Bands must descend: strong > adequate > needsAttention.'),
    ).toBeInTheDocument();
    expect(within(quality).getByRole('button', { name: 'Save changes' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // The weights are not forced to add up to 1; the page tells the person what they currently add up to.
    expect(within(quality).getByText(/dimension weights add up to 1\.00/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Action-value configuration' })).toBeInTheDocument();
  });

  it('keeps credential redaction on, lets personal data be chosen and keeps the canonical order', async () => {
    const user = userEvent.setup();
    open('redaction');
    renderApp(<GovernancePage />, { api: api() });
    const credentials = await screen.findByRole('group', { name: 'Credentials (always redacted)' });
    const locked = within(credentials).getAllByRole('switch');
    expect(locked).toHaveLength(8);
    for (const item of locked) {
      expect(item).toBeChecked();
      expect(item).toBeDisabled();
    }
    const personal = screen.getByRole('group', { name: 'Personal data (your choice)' });
    const phone = within(personal).getByRole('switch', { name: 'Phone numbers' });
    expect(phone).toBeChecked();
    await user.click(phone);
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
    await user.click(phone);
    // Back to the original selection: the order is canonical, so this is not reported as a change.
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
  });

  it('explains that custom patterns can be refused as unsafe or time out, and that an incomplete redaction refuses the payload', async () => {
    open('redaction');
    renderApp(<GovernancePage />, { api: api() });
    const caveat = (await screen.findByText('Custom patterns can be refused')).closest(
      '[role="note"]',
    ) as HTMLElement;
    expect(within(caveat).getByText(/backtrack/)).toBeInTheDocument();
    expect(
      within(caveat).getByText(/unsafe or too slow is refused with the reason/),
    ).toBeInTheDocument();
    expect(
      within(caveat).getByText(/runs out of time, means redaction would be incomplete/),
    ).toBeInTheDocument();
    expect(
      within(caveat).getByText(
        /the whole payload is refused instead of being stored partly redacted/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No custom patterns. The built-in categories above still apply.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Redact before model calls' }),
    ).toHaveAccessibleDescription(
      'Recorded only: nothing reads this switch, so turning it off does not change when text is redacted.',
    );
  });

  it('marks the export-control options that nothing enforces as recorded only', async () => {
    open('export');
    renderApp(<GovernancePage />, { api: api() });
    const controls = await screen.findByRole('group', { name: 'Export controls' });
    expect(within(controls).getByText(/Enforced on every export/)).toBeInTheDocument();
    expect(
      within(controls).getByText(/Recorded only: the API always requires a reason/),
    ).toBeInTheDocument();
    expect(
      within(controls).getByRole('spinbutton', { name: 'Most records per export' }),
    ).toHaveValue(5000);
  });

  it('has no accessibility violations (scoring and redaction)', async () => {
    open('scoring');
    const first = renderApp(<GovernancePage />, { api: api() });
    await screen.findByRole('group', { name: 'Action-value configuration' });
    await expectNoAxeViolations(first.container);
    first.unmount();
    open('redaction');
    const second = renderApp(<GovernancePage />, { api: api() });
    await screen.findByRole('group', { name: 'Redaction' });
    await expectNoAxeViolations(second.container);
  });
});
