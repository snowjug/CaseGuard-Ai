import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations, renderApp } from '../../../test/harness';
import { navigateTo, setNavigationLatency } from '../../../test/next-navigation';
import {
  T0,
  USER_ROSTER,
  auditEvent,
  auditPage,
  auditVerification,
  demoState,
  governanceSettings,
  promptVersion,
  userRecord,
} from '../../../test/u4-fixtures';
import {
  admin,
  asRole,
  entraAdmin,
  expectToast,
  governanceApi as api,
} from '../../../test/u4-support';
import { ApiError } from '../../lib/api/errors';
import { GovernancePage } from './GovernancePage';

// Governance pages are heavy to render and axe walks all of it: allow for a busy machine.
vi.setConfig({ testTimeout: 120_000 });

const open = (tab: string) => navigateTo(`/governance?tab=${tab}`);

const queryOf = (call: readonly unknown[] | undefined): Record<string, unknown> =>
  (call?.[1] as { query?: Record<string, unknown> } | undefined)?.query ?? {};

describe('[FR-GOV-30] roles', () => {
  it('lists users with their roles and changes roles with a reason, the user version and a toast', async () => {
    const user = userEvent.setup();
    open('roles');
    const fake = api({
      'governance.assignRoles': () =>
        userRecord({ id: 'user_riley_reviewer', roles: ['reviewer', 'manager'], version: 4 }),
    });
    renderApp(<GovernancePage />, { api: fake });
    const table = await screen.findByRole('table', { name: 'Users and their roles' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('Riley Reviewer (synthetic)')).toBeInTheDocument();
    expect(within(table).getAllByText('Demo data').length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole('button', { name: 'Change roles for Riley Reviewer (synthetic)' }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Change roles for Riley Reviewer/ });
    expect(
      within(dialog).getByRole('checkbox', { name: 'Support Quality Reviewer' }),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Support Manager' }));

    // A reason is mandatory.
    await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    expect(await within(dialog).findByText('Enter at least 5 characters.')).toBeInTheDocument();
    expect(fake.call.mock.calls.some((call) => call[0] === 'governance.assignRoles')).toBe(false);

    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Covers the rota this week',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    await expectToast('Roles updated for Riley Reviewer (synthetic)');
    expect(fake.call).toHaveBeenCalledWith('governance.assignRoles', {
      params: { userId: 'user_riley_reviewer' },
      body: {
        roles: ['reviewer', 'manager'],
        expectedVersion: 3,
        reason: 'Covers the rota this week',
      },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not allow a user with no role at all', async () => {
    const user = userEvent.setup();
    open('roles');
    renderApp(<GovernancePage />, { api: api() });
    await user.click(
      await screen.findByRole('button', { name: 'Change roles for Ava Engineer (synthetic)' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Technical Support Engineer' }));
    expect(await within(dialog).findByText('Choose at least one role.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save roles' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('explains the last-administrator refusal by its reason and a stale version by its code, and changes nothing', async () => {
    const user = userEvent.setup();
    open('roles');
    let attempt = 0;
    renderApp(<GovernancePage />, {
      api: api({
        'governance.assignRoles': () => {
          attempt += 1;
          if (attempt === 1)
            throw new ApiError({
              status: 409,
              code: 'conflict',
              reason: 'last_administrator',
              title: 'Conflict',
              message: 'Words the page must not depend on',
            });
          throw new ApiError({
            status: 409,
            code: 'version_conflict',
            title: 'Conflict',
            message:
              'User was modified by someone else (expected version 1, found 2). Reload and retry.',
          });
        },
      }),
    });
    await user.click(
      await screen.findByRole('button', { name: 'Change roles for Alex Admin (synthetic)' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Technical Support Engineer' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Administrator' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason/ }),
      'Handing over the keys',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    expect(
      await within(dialog).findByText(
        /A tenant must keep at least one active administrator, so this change was refused\..*Nothing was changed\./,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Words the page must not depend on/)).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    expect(await within(dialog).findByText(/expected version 1, found 2/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/open the user again to see the latest roles/),
    ).toBeInTheDocument();
  });

  it('switches to the Entra explanation when the API says roles are managed there (409 entra_managed)', async () => {
    const user = userEvent.setup();
    open('roles');
    let entra = false;
    renderApp(<GovernancePage />, {
      api: api({
        'session.me': () => (entra ? entraAdmin() : admin()),
        'governance.assignRoles': () => {
          entra = true;
          throw new ApiError({
            status: 409,
            code: 'conflict',
            reason: 'entra_managed',
            title: 'Conflict',
            message: 'Words the page must not depend on',
          });
        },
      }),
    });
    await user.click(
      await screen.findByRole('button', { name: 'Change roles for Riley Reviewer (synthetic)' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Support Manager' }));
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Covers the rota');
    await user.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    expect(
      await within(dialog).findByText(
        /Roles are managed in Microsoft Entra ID, so CaseGuard cannot/,
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // The session was reloaded, so the page itself now explains it and offers no change button.
    expect(await screen.findByText(/the API answers 409/)).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Change roles for Riley Reviewer (synthetic)' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('explains that roles are managed in Entra ID and offers no way to change them', async () => {
    open('roles');
    const fake = api({ 'session.me': entraAdmin });
    renderApp(<GovernancePage />, { api: fake });
    expect(
      (await screen.findAllByText('Roles are managed in Microsoft Entra ID')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/the API answers 409/)).toBeInTheDocument();
    const button = await screen.findByRole('button', {
      name: 'Change roles for Riley Reviewer (synthetic)',
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('gates the change button for a role without roles:manage', async () => {
    open('roles');
    renderApp(<GovernancePage />, {
      api: api({ 'session.me': asRole('administrator', ['case:read', 'governance:read']) }),
    });
    const button = await screen.findByRole('button', {
      name: 'Change roles for Riley Reviewer (synthetic)',
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows an error with Retry when the users cannot be loaded', async () => {
    const user = userEvent.setup();
    open('roles');
    let calls = 0;
    renderApp(<GovernancePage />, {
      api: api({
        'governance.users': () => {
          calls += 1;
          if (calls === 1)
            throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
          return { items: [...USER_ROSTER] };
        },
      }),
    });
    expect(await screen.findByText('The user list could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table', { name: 'Users and their roles' })).toBeVisible();
  });
});

describe('[FR-GOV-31] audit log', () => {
  it('shows the events newest first with actor, target, outcome and the hash chain', async () => {
    open('audit');
    renderApp(<GovernancePage />, { api: api() });
    const list = await screen.findByRole('list', { name: /Audit events, 2 shown/ });
    const articles = within(list).getAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(articles[0]).toHaveAccessibleName('Audit event 2: governance.settings.updated');
    expect(within(articles[0] as HTMLElement).getByText('Success')).toBeInTheDocument();
    expect(
      within(articles[0] as HTMLElement).getByText(/Actor: user_alex_admin \(Administrator\)/),
    ).toBeInTheDocument();
    expect(
      within(articles[0] as HTMLElement).getByText(/Target: governance_section · model/),
    ).toBeInTheDocument();
    expect(within(articles[0] as HTMLElement).getByText(/hash bbbbbbbbbb…/)).toBeInTheDocument();
    expect(
      screen.getByText(/Reading the audit log is itself recorded in the audit log/),
    ).toBeInTheDocument();
    expect(screen.getByText('Showing 2 events.')).toBeInTheDocument();
  });

  it('reports the chain verification: intact, then broken with the first bad sequence', async () => {
    const user = userEvent.setup();
    open('audit');
    let broken = false;
    renderApp(<GovernancePage />, {
      api: api({
        'governance.auditVerify': () =>
          broken
            ? auditVerification({
                valid: false,
                firstInvalidSequence: 7,
                detail: 'Hash mismatch at sequence 7',
              })
            : auditVerification(),
      }),
    });
    const panel = await screen.findByRole('group', { name: 'Hash-chain verification' });
    expect(await within(panel).findByText('Chain intact')).toBeInTheDocument();
    expect(
      within(panel).getByText(/Verified 19 audit events; the hash chain is intact/),
    ).toBeInTheDocument();
    broken = true;
    await user.click(within(panel).getByRole('button', { name: 'Verify again' }));
    expect(await within(panel).findByText('The audit chain is broken')).toBeInTheDocument();
    expect(
      within(panel).getByText(/The first event that does not match is #7\./),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/19 events were checked/)).toBeInTheDocument();
  });

  it('filters by outcome through the URL and sends only the filters that are set', async () => {
    const user = userEvent.setup();
    open('audit');
    const fake = api({
      'governance.audit': (input) =>
        queryOf([null, input]).outcome === 'denied'
          ? auditPage([auditEvent({ sequence: 5, outcome: 'denied', action: 'roles.assigned' })])
          : auditPage([auditEvent({ sequence: 2 }), auditEvent({ sequence: 1 })]),
    });
    renderApp(<GovernancePage />, { api: fake });
    await screen.findByRole('list', { name: /Audit events, 2 shown/ });
    const first = fake.call.mock.calls.find((call) => call[0] === 'governance.audit');
    expect(queryOf(first)).toEqual({ limit: 50 });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Outcome' }), 'denied');
    expect(window.location.search).toContain('aout=denied');
    const list = await screen.findByRole('list', { name: /Audit events, 1 shown/ });
    expect(within(list).getByText('Denied')).toBeInTheDocument();
    const calls = fake.call.mock.calls.filter((call) => call[0] === 'governance.audit');
    expect(queryOf(calls[calls.length - 1])).toEqual({ limit: 50, outcome: 'denied' });
    expect(screen.getByText(/1 filter on/)).toBeInTheDocument();
  });

  it('reads filters from a shared link, and offers to clear them when nothing matches', async () => {
    const user = userEvent.setup();
    navigateTo('/governance?tab=audit&aout=failure&afrom=2025-03-01');
    const fake = api({
      'governance.audit': (input) =>
        queryOf([null, input]).outcome === 'failure'
          ? auditPage([])
          : auditPage([auditEvent({ sequence: 1 })]),
    });
    renderApp(<GovernancePage />, { api: fake });
    expect(await screen.findByText('No audit events match these filters')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Outcome' })).toHaveValue('failure');
    expect(screen.getByLabelText('From (UTC date)')).toHaveValue('2025-03-01');
    const calls = fake.call.mock.calls.filter((call) => call[0] === 'governance.audit');
    expect(queryOf(calls[0])).toEqual({
      limit: 50,
      outcome: 'failure',
      from: '2025-03-01T00:00:00.000Z',
    });
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    expect(await screen.findByRole('list', { name: /Audit events, 1 shown/ })).toBeVisible();
    expect(window.location.search).toBe('?tab=audit');
  });

  describe('typing in the filters', () => {
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const auditQueries = (fake: ReturnType<typeof api>): Record<string, unknown>[] =>
      fake.call.mock.calls.filter((call) => call[0] === 'governance.audit').map(queryOf);
    const lastAuditQuery = (fake: ReturnType<typeof api>): Record<string, unknown> | undefined =>
      auditQueries(fake).at(-1);

    it('keeps every character typed with no pause, however late the address is reported back', async () => {
      const user = userEvent.setup({ delay: null });
      open('audit');
      setNavigationLatency(5);
      const fake = api({ 'governance.audit': () => auditPage([auditEvent()]) });
      renderApp(<GovernancePage />, { api: fake });
      await screen.findByRole('list', { name: /Audit events, 1 shown/ });
      const action = screen.getByLabelText('Action');
      await user.click(action);
      for (const [index, char] of [...'skill'].entries()) {
        await user.keyboard(char);
        expect(action).toHaveValue('skill'.slice(0, index + 1));
      }
      const actor = screen.getByLabelText('Actor id');
      await user.click(actor);
      for (const [index, char] of [...'user_a'].entries()) {
        await user.keyboard(char);
        expect(actor).toHaveValue('user_a'.slice(0, index + 1));
      }
      await waitFor(() => expect(window.location.search).toBe('?tab=audit&act=skill&actor=user_a'));
      await waitFor(
        () =>
          expect(lastAuditQuery(fake)).toEqual({ limit: 50, action: 'skill', actorId: 'user_a' }),
        { timeout: 5000 },
      );
      await pause(60);
      expect(action).toHaveValue('skill');
      expect(actor).toHaveValue('user_a');
    });

    it('keeps a date as it was entered while the address is reported back late', async () => {
      open('audit');
      setNavigationLatency(5);
      const fake = api({ 'governance.audit': () => auditPage([auditEvent()]) });
      renderApp(<GovernancePage />, { api: fake });
      await screen.findByRole('list', { name: /Audit events, 1 shown/ });
      const from = screen.getByLabelText('From (UTC date)');
      fireEvent.change(from, { target: { value: '2025-03-14' } });
      expect(from).toHaveValue('2025-03-14');
      await waitFor(() => expect(window.location.search).toContain('afrom=2025-03-14'));
      await pause(60);
      expect(from).toHaveValue('2025-03-14');
      await waitFor(
        () => expect(lastAuditQuery(fake)).toEqual({ limit: 50, from: '2025-03-14T00:00:00.000Z' }),
        { timeout: 5000 },
      );
    });

    it('empties every filter with Clear filters, also before the typing was written', async () => {
      const user = userEvent.setup({ delay: null });
      open('audit');
      setNavigationLatency(5);
      const fake = api({ 'governance.audit': () => auditPage([auditEvent()]) });
      renderApp(<GovernancePage />, { api: fake });
      await screen.findByRole('list', { name: /Audit events, 1 shown/ });
      await user.type(screen.getByLabelText('Actor id'), 'user_a');
      await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
      expect(screen.getByLabelText('Actor id')).toHaveValue('');
      await waitFor(() => expect(window.location.search).toBe('?tab=audit'));
      await pause(500);
      expect(screen.getByLabelText('Actor id')).toHaveValue('');
      expect(window.location.search).toBe('?tab=audit');
      expect(lastAuditQuery(fake)).toEqual({ limit: 50 });
    });

    it('neither queries nor changes the address for the partial text of an IME composition', async () => {
      open('audit');
      const fake = api({ 'governance.audit': () => auditPage([auditEvent()]) });
      renderApp(<GovernancePage />, { api: fake });
      await screen.findByRole('list', { name: /Audit events, 1 shown/ });
      const action = screen.getByLabelText('Action');
      fireEvent.compositionStart(action);
      fireEvent.change(action, { target: { value: 'ni' } });
      expect(action).toHaveValue('ni');
      await pause(700);
      expect(window.location.search).toBe('?tab=audit');
      expect(lastAuditQuery(fake)).toEqual({ limit: 50 });
      fireEvent.change(action, { target: { value: '你好' } });
      fireEvent.compositionEnd(action);
      await waitFor(() => expect(lastAuditQuery(fake)).toEqual({ limit: 50, action: '你好' }), {
        timeout: 5000,
      });
      expect(new URLSearchParams(window.location.search).get('act')).toBe('你好');
    });
  });

  it('loads the next page with the cursor the API returned', async () => {
    const user = userEvent.setup();
    open('audit');
    const fake = api({
      'governance.audit': (input) =>
        queryOf([null, input]).cursor === 'next-1'
          ? auditPage([auditEvent({ sequence: 1, action: 'case.ingested' })])
          : auditPage([auditEvent({ sequence: 3 }), auditEvent({ sequence: 2 })], 'next-1'),
    });
    renderApp(<GovernancePage />, { api: fake });
    await screen.findByRole('list', { name: /Audit events, 2 shown/ });
    expect(screen.getByText(/more load as you scroll/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more events' }));
    expect(await screen.findByRole('list', { name: /Audit events, 3 shown/ })).toBeVisible();
    const calls = fake.call.mock.calls.filter((call) => call[0] === 'governance.audit');
    expect(queryOf(calls[1])).toMatchObject({ cursor: 'next-1' });
    expect(screen.queryByRole('button', { name: 'Load more events' })).toBeNull();
  });

  it('windows a long log instead of rendering every row', async () => {
    open('audit');
    const events = Array.from({ length: 150 }, (_unused, index) =>
      auditEvent({ sequence: 150 - index }),
    );
    renderApp(<GovernancePage />, { api: api({ 'governance.audit': () => auditPage(events) }) });
    const list = await screen.findByRole('list', { name: /Audit events, 150 shown/ });
    const rendered = within(list).getAllByRole('article').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '150');
  });

  it('explains a failed list with Retry', async () => {
    const user = userEvent.setup();
    open('audit');
    let calls = 0;
    renderApp(<GovernancePage />, {
      api: api({
        'governance.audit': () => {
          calls += 1;
          if (calls === 1)
            throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
          return auditPage([auditEvent()]);
        },
      }),
    });
    expect(await screen.findByText('The audit log could not be loaded')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0] as HTMLElement);
    expect(await screen.findByRole('list', { name: /Audit events, 1 shown/ })).toBeVisible();
  });

  it('has no accessibility violations', async () => {
    open('audit');
    const { container } = renderApp(<GovernancePage />, { api: api() });
    await screen.findByRole('list', { name: /Audit events/ });
    await screen.findByText('Chain intact');
    await expectNoAxeViolations(container);
  });
});

describe('[FR-GOV-32] reviewer decisions and prompts', () => {
  it('lists a decision with its badge, a link to the decided item, the reason and the before and after values', async () => {
    open('reviews');
    renderApp(<GovernancePage />, { api: api() });
    const list = await screen.findByRole('list', { name: /Reviewer decisions, 1 shown/ });
    const article = within(list).getByRole('article');
    expect(within(article).getByText('Confirmed')).toBeInTheDocument();
    expect(
      within(article).getByRole('link', { name: 'Counterfactual path scn_1' }),
    ).toHaveAttribute('href', '/cases/case_1/counterfactual?sel=scn_1');
    expect(
      within(article).getByText(/every step uses only what was known before the decision/),
    ).toBeInTheDocument();
    expect(within(article).getByText(/"reviewState": "pending"/)).toBeInTheDocument();
    expect(within(article).getByText(/"reviewState": "confirmed"/)).toBeInTheDocument();
    expect(
      screen.getByText(/Skill approvals .* are recorded in the SkillDNA Library/),
    ).toBeInTheDocument();
  });

  it('filters decisions by case through the URL', async () => {
    const user = userEvent.setup();
    open('reviews');
    const fake = api();
    renderApp(<GovernancePage />, { api: fake });
    await screen.findByRole('list', { name: /Reviewer decisions/ });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Case' }), 'case_1');
    expect(window.location.search).toContain('rcase=case_1');
    await waitFor(() => {
      const calls = fake.call.mock.calls.filter((call) => call[0] === 'governance.reviews');
      expect(queryOf(calls[calls.length - 1])).toEqual({ limit: 50, caseId: 'case_1' });
    });
  });

  it('shows an empty state with a next action', async () => {
    open('reviews');
    renderApp(<GovernancePage />, {
      api: api({ 'governance.reviews': () => ({ items: [], nextCursor: null }) }),
    });
    expect(await screen.findByText('No reviewer decisions yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Cases' })).toHaveAttribute('href', '/cases');
  });

  it('shows prompt versions read-only with the hash, and expands a long template on request', async () => {
    const user = userEvent.setup();
    open('prompts');
    const template = `Role: Quality Judge. ${'Describe process quality, never people. '.repeat(40)}`;
    renderApp(<GovernancePage />, {
      api: api({ 'governance.prompts': () => ({ items: [promptVersion({ template })] }) }),
    });
    expect(await screen.findByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText(/cannot be edited here/)).toBeInTheDocument();
    const card = screen.getByRole('group', { name: 'Quality Judge prompt' });
    expect(within(card).getByText('Version 1.0.0')).toBeInTheDocument();
    expect(within(card).getByText('Active')).toBeInTheDocument();
    expect(within(card).getByText(/cccccccccccccccc…/)).toBeInTheDocument();
    const expand = within(card).getByRole('button', { name: /Show all .* characters/ });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await user.click(expand);
    expect(within(card).getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('[FR-GOV-33] export, provider and demo reset', () => {
  it('exports the audit log after a reason, downloads it and says what was exported', async () => {
    const user = userEvent.setup();
    open('export');
    const created = vi.fn(() => 'blob:caseguard');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const fake = api({
      'governance.export': () => ({
        exportedAt: T0,
        scope: 'audit',
        recordCount: 19,
        notice: 'Audit export includes the chain so it can be re-verified.',
        data: { events: [] },
      }),
    });
    renderApp(<GovernancePage />, { api: fake });
    await user.click(await screen.findByRole('button', { name: 'Export the audit log' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Export the audit log?' });
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(await within(dialog).findByText('Enter at least 5 characters.')).toBeInTheDocument();
    expect(fake.call.mock.calls.some((call) => call[0] === 'governance.export')).toBe(false);

    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for the export/ }),
      'Quarterly review',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));
    await expectToast('Exported 19 records');
    expect(fake.call).toHaveBeenCalledWith('governance.export', {
      body: { scope: 'audit', reason: 'Quarterly review' },
    });
    expect(created).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Audit export includes the chain/)).toBeInTheDocument();
    click.mockRestore();
  });

  it('needs a case for a case export and sends its id', async () => {
    const user = userEvent.setup();
    open('export');
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const fake = api({
      'governance.export': () => ({
        exportedAt: T0,
        scope: 'case',
        recordCount: 1,
        notice: 'ok',
        data: {},
      }),
    });
    renderApp(<GovernancePage />, { api: fake });
    await user.click(await screen.findByRole('radio', { name: 'One case' }));
    const button = screen.getByRole('button', { name: 'Export case data' });
    expect(button).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: /Case/ }), 'case_1');
    expect(button).toBeEnabled();
    await user.click(button);
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Support escalation');
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));
    await expectToast('Exported 1 record');
    expect(fake.call).toHaveBeenCalledWith('governance.export', {
      body: { scope: 'case', reason: 'Support escalation', caseId: 'case_1' },
    });
    click.mockRestore();
  });

  it('explains a too-large export (409 record_cap_exceeded) with the cap, inside the dialog', async () => {
    const user = userEvent.setup();
    open('export');
    renderApp(<GovernancePage />, {
      api: api({
        'governance.export': () => {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            reason: 'record_cap_exceeded',
            title: 'Conflict',
            message: 'Words the page must not depend on',
          });
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Export the audit log' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Quarterly review');
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(
      await within(dialog).findByText(/larger than the 5,000 records the export controls allow/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Words the page must not depend on/)).toBeNull();
  });

  it('explains an export the controls switched off in the meantime (403 audit_export_disabled), points to the Export controls card and reloads the controls', async () => {
    const user = userEvent.setup();
    open('export');
    let off = false;
    const fake = api({
      'governance.get': () =>
        governanceSettings(
          off
            ? {
                export_controls: {
                  value: { ...governanceSettings().export_controls.value, allowAuditExport: false },
                },
              }
            : {},
        ),
      'governance.export': () => {
        // Someone switched audit export off after this page loaded.
        off = true;
        throw new ApiError({
          status: 403,
          code: 'forbidden',
          reason: 'audit_export_disabled',
          title: 'Forbidden',
          message: 'Words the page must not depend on',
        });
      },
    });
    renderApp(<GovernancePage />, { api: fake });
    await user.click(await screen.findByRole('button', { name: 'Export the audit log' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Quarterly review');
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(
      await within(dialog).findByText(
        /Audit export is switched off in this workspace's export controls, so nothing was exported\. If it should be allowed, switch on "Allow audit-log export" in the Export controls card above\./,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Words the page must not depend on/)).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // The controls were reloaded, so the page itself now says it is switched off and the button is disabled.
    expect(
      await screen.findByText(/Audit-log export is switched off in the export controls above/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export the audit log' })).toBeDisabled(),
    );
    expect(
      fake.call.mock.calls.filter((call) => call[0] === 'governance.get').length,
    ).toBeGreaterThan(1);
  });

  it('sends a role that can export but not change the controls to an administrator (403 case_export_disabled)', async () => {
    const user = userEvent.setup();
    open('export');
    renderApp(<GovernancePage />, {
      api: api({
        'session.me': asRole('administrator', ['case:read', 'governance:read', 'export:data']),
        'governance.export': () => {
          throw new ApiError({
            status: 403,
            code: 'forbidden',
            reason: 'case_export_disabled',
            title: 'Forbidden',
            message: 'x',
          });
        },
      }),
    });
    await user.click(await screen.findByRole('radio', { name: 'One case' }));
    await user.selectOptions(screen.getByRole('combobox', { name: /Case/ }), 'case_1');
    await user.click(screen.getByRole('button', { name: 'Export case data' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Support escalation');
    await user.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(
      await within(dialog).findByText(
        /Case export is switched off in this workspace's export controls, so nothing was exported\. Ask an administrator, who can change the export controls\./,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Export controls card above/)).toBeNull();
  });

  it('disables an export the controls switch off and says why', async () => {
    open('export');
    renderApp(<GovernancePage />, {
      api: api({
        'governance.get': () =>
          governanceSettings({
            export_controls: {
              value: { ...governanceSettings().export_controls.value, allowAuditExport: false },
            },
          }),
      }),
    });
    expect(
      await screen.findByText(/Audit-log export is switched off in the export controls above/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export the audit log' })).toBeDisabled();
  });

  it('gates the export for a role without export:data', async () => {
    open('export');
    renderApp(<GovernancePage />, {
      api: api({ 'session.me': asRole('administrator', ['case:read', 'governance:read']) }),
    });
    const button = await screen.findByRole('button', { name: 'Export the audit log' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the provider status and resets the demo data after a confirmation', async () => {
    const user = userEvent.setup();
    open('operations');
    const fake = api({ 'demo.reset': () => demoState(0), 'demo.state': () => demoState(0) });
    renderApp(<GovernancePage />, { api: fake });
    const provider = await screen.findByRole('group', { name: 'AI provider' });
    expect(within(provider).getByText('Deterministic provider')).toBeInTheDocument();
    expect(within(provider).getByText(/fully offline, reproducible/)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Reset demo data' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset the demo data?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reset demo' }));
    await expectToast('Demo data reset');
    expect(fake.call.mock.calls.some((call) => call[0] === 'demo.reset')).toBe(true);
  });

  it('explains the refusal outside a synthetic demo tenant (409 not_a_demo_tenant) inside the reset dialog', async () => {
    const user = userEvent.setup();
    open('operations');
    renderApp(<GovernancePage />, {
      api: api({
        'demo.reset': () => {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            reason: 'not_a_demo_tenant',
            title: 'Conflict',
            message: 'Words the page must not depend on',
          });
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Reset demo data' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset demo' }));
    expect(
      await within(dialog).findByText(/only be seeded or reset in a synthetic demo tenant/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Words the page must not depend on/)).toBeNull();
  });

  it('gates the reset for a reviewer and explains the missing provider access for a role without telemetry', async () => {
    open('operations');
    renderApp(<GovernancePage />, {
      api: api({ 'session.me': asRole('reviewer', ['case:read', 'audit:read']) }),
    });
    const button = await screen.findByRole('button', { name: 'Reset demo data' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/cannot read system status/)).toBeInTheDocument();
  });

  it('has no accessibility violations (roles, reviews, export, operations)', async () => {
    for (const tab of ['roles', 'reviews', 'export', 'operations']) {
      open(tab);
      const view = renderApp(<GovernancePage />, { api: api() });
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Section' })).toHaveValue(tab),
      );
      await screen.findAllByRole('group');
      await waitFor(() => expect(screen.queryByText(/^Loading/)).toBeNull());
      await expectNoAxeViolations(view.container);
      view.unmount();
    }
  });
});
