import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations, renderApp } from '../../../test/harness';
import { installMatchMedia } from '../../../test/media';
import { navigateTo } from '../../../test/next-navigation';
import { asRole, governanceApi as api } from '../../../test/u4-support';
import { governanceSettings } from '../../../test/u4-fixtures';
import { ApiError } from '../../lib/api/errors';
import { GovernancePage } from './GovernancePage';
import { GOVERNANCE_TABS } from './tabs';

// The Model section renders a large form and axe walks all of it: allow for a busy machine.
vi.setConfig({ testTimeout: 120_000 });

const wide = () => installMatchMedia((query) => query.includes('min-width: 900px'));

describe('[FR-GOV-10] Governance page navigation', () => {
  it('opens on the model section and offers every section in the chooser on a narrow screen', async () => {
    renderApp(<GovernancePage />, { api: api() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Governance' })).toBeVisible();
    const chooser = await screen.findByRole('combobox', { name: 'Section' });
    expect(chooser).toHaveValue('model');
    expect(within(chooser).getAllByRole('option')).toHaveLength(GOVERNANCE_TABS.length);
    expect(await screen.findByRole('group', { name: 'Model configuration' })).toBeVisible();
  });

  it('writes the chosen section to the URL and reads it back from a shared link', async () => {
    const user = userEvent.setup();
    navigateTo('/governance?tab=audit');
    renderApp(<GovernancePage />, { api: api() });
    const chooser = await screen.findByRole('combobox', { name: 'Section' });
    expect(chooser).toHaveValue('audit');
    expect(await screen.findByRole('group', { name: 'Audit events' })).toBeVisible();
    await user.selectOptions(chooser, 'roles');
    expect(window.location.search).toBe('?tab=roles');
    expect(await screen.findByRole('group', { name: 'Users and roles' })).toBeVisible();
    await user.selectOptions(chooser, 'model');
    expect(window.location.search).toBe('');
  });

  it('falls back to the model section for an unknown ?tab= value', async () => {
    navigateTo('/governance?tab=not-a-section');
    renderApp(<GovernancePage />, { api: api() });
    expect(await screen.findByRole('combobox', { name: 'Section' })).toHaveValue('model');
  });

  it('uses a vertical tab list on a wide screen, with the selected tab labelling the panel', async () => {
    wide();
    const user = userEvent.setup();
    renderApp(<GovernancePage />, { api: api() });
    const tablist = await screen.findByRole('tablist', { name: 'Governance sections' });
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
    expect(within(tablist).getAllByRole('tab')).toHaveLength(GOVERNANCE_TABS.length);
    expect(within(tablist).getByRole('tab', { name: 'Model' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(within(tablist).getByRole('tab', { name: 'Redaction' }));
    expect(window.location.search).toBe('?tab=redaction');
    const panel = await screen.findByRole('tabpanel');
    expect(panel).toHaveAccessibleName('Redaction');
    expect(await within(panel).findByRole('group', { name: 'Redaction' })).toBeVisible();
  });

  it('] and [ move to the next and previous section, wrapping around at both ends', async () => {
    const user = userEvent.setup();
    renderApp(<GovernancePage />, { api: api() });
    const chooser = await screen.findByRole('combobox', { name: 'Section' });
    expect(chooser).toHaveValue('model');
    await user.keyboard(']');
    await waitFor(() => expect(chooser).toHaveValue('prompts'));
    expect(window.location.search).toBe('?tab=prompts');
    // user-event reads "[" as the start of a key code, so a literal one is written "[[".
    await user.keyboard('[[');
    await waitFor(() => expect(chooser).toHaveValue('model'));
    await user.keyboard('[[');
    await waitFor(() => expect(chooser).toHaveValue(GOVERNANCE_TABS.at(-1)?.id));
    await user.keyboard(']');
    await waitFor(() => expect(chooser).toHaveValue('model'));
  });
});

describe('[FR-GOV-11] Governance permissions and states', () => {
  it('opens a reviewer on the audit log and explains the configuration sections without requesting them', async () => {
    const fake = api({
      'session.me': asRole('reviewer', ['case:read', 'audit:read', 'telemetry:read']),
    });
    renderApp(<GovernancePage />, { api: fake });
    expect(await screen.findByRole('combobox', { name: 'Section' })).toHaveValue('audit');
    expect(await screen.findByRole('group', { name: 'Audit events' })).toBeVisible();
    expect(fake.call.mock.calls.some((call) => call[0] === 'governance.get')).toBe(false);
  });

  it('explains a locked section for a role that can only read the audit log', async () => {
    navigateTo('/governance?tab=model');
    const fake = api({ 'session.me': asRole('reviewer', ['case:read', 'audit:read']) });
    renderApp(<GovernancePage />, { api: fake });
    expect(await screen.findByText('You do not have access to Model')).toBeInTheDocument();
    expect(
      screen.getByText(/does not include the "governance:read" permission/),
    ).toBeInTheDocument();
    expect(fake.call.mock.calls.some((call) => call[0] === 'governance.get')).toBe(false);
  });

  it('explains the whole page for a role with neither governance nor audit access', async () => {
    renderApp(<GovernancePage />, { api: api({ 'session.me': asRole('manager', ['case:read']) }) });
    expect(await screen.findByText('You do not have access to Governance')).toBeInTheDocument();
    expect(screen.getByText(/"governance:read" or "audit:read"/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Section' })).toBeNull();
  });

  it('asks for an identity when nobody is signed in', async () => {
    renderApp(<GovernancePage />, { api: api(), persona: null });
    expect(await screen.findByText('Choose who you are acting as')).toBeInTheDocument();
  });

  it('shows a skeleton while loading, then an error with Retry that recovers', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderApp(<GovernancePage />, {
      api: api({
        'governance.get': () => {
          calls += 1;
          if (calls === 1)
            throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
          return governanceSettings();
        },
      }),
    });
    expect(
      await screen.findByText('The governance settings could not be loaded'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Model configuration' })).toBeVisible();
    expect(calls).toBe(2);
  });

  it('has no accessibility violations (model section, narrow)', async () => {
    const { container } = renderApp(<GovernancePage />, { api: api() });
    await screen.findByRole('group', { name: 'Model configuration' });
    await expectNoAxeViolations(container);
  });

  it('has no accessibility violations (model section, wide)', async () => {
    wide();
    const { container } = renderApp(<GovernancePage />, { api: api() });
    await screen.findByRole('group', { name: 'Model configuration' });
    await waitFor(() => expect(screen.getByRole('tablist')).toBeVisible());
    await expectNoAxeViolations(container);
  });
});
