import { JobSchema } from '@caseguard/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, persona, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import { COMPARE_ROUTE, T0, demoState } from '../../../test/u4-fixtures';
import { expectToast } from '../../../test/u4-support';
import { ApiError } from '../../lib/api/errors';
import { DemoGuidePage } from './DemoGuidePage';

const admin = () => session('administrator', ALL_PERMISSIONS);
const engineer = () => session('engineer', ['case:read', 'case:ingest']);

const personas = () => ({
  enabled: true,
  notice: '',
  items: [
    { ...persona('user_fabi_engineer', 'engineer', 'Fabi Engineer'), tenantId: 'tenant_other' },
    persona('user_ava_engineer', 'engineer', 'Ava Engineer'),
    persona('user_riley_reviewer', 'reviewer', 'Riley Reviewer'),
    persona('user_alex_admin', 'administrator', 'Alex Admin'),
  ],
});

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': admin,
    'demo.state': () => demoState(3),
    'dev.personas': personas,
    ...overrides,
  });
}

const runningJob = JobSchema.parse({
  id: 'job_1',
  tenantId: 'tenant_demo',
  kind: 'demo_seed',
  status: 'running',
  caseId: null,
  targetId: null,
  progress: {
    percent: 40,
    stage: 'Importing Case Two',
    stages: [
      {
        id: 's1',
        label: 'Import Case One',
        status: 'done',
        startedAt: T0,
        completedAt: T0,
        detail: null,
      },
      {
        id: 's2',
        label: 'Import Case Two',
        status: 'running',
        startedAt: T0,
        completedAt: null,
        detail: null,
      },
    ],
  },
  error: null,
  resultRef: null,
  idempotencyKey: null,
  createdAt: T0,
  startedAt: T0,
  completedAt: null,
  createdBy: 'user_alex_admin',
  cancellable: false,
});

const stepItem = async (title: string): Promise<HTMLElement> => {
  const list = await screen.findByRole('list', { name: 'Demo steps' });
  const item = within(list)
    .getAllByRole('listitem')
    .find((candidate) => within(candidate).queryByRole('heading', { name: new RegExp(title) }));
  if (!item) throw new Error(`No step titled ${title}`);
  return item;
};

/** The seed controls enable once the session says the role may manage the demo (the page loads before it). */
const enabledButton = async (group: HTMLElement, name: string): Promise<HTMLElement> => {
  await waitFor(() =>
    expect(within(group).getByRole('button', { name })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    ),
  );
  return within(group).getByRole('button', { name });
};

describe('[FR-DEMO-01] Demo Guide', () => {
  it('shows progress derived from demo.state and the 13 steps in order with their state', async () => {
    renderApp(<DemoGuidePage />, { api: api() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Demo Guide' })).toBeVisible();
    expect(await screen.findByText('3 of 13 steps complete')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Demo progress: 3 of 13 steps complete' }),
    ).toBeInTheDocument();

    const list = screen.getByRole('list', { name: 'Demo steps' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(13);
    expect(within(items[0] as HTMLElement).getByText('Done')).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getByText('Done')).toBeInTheDocument();
    expect(within(items[3] as HTMLElement).getByText('Next')).toBeInTheDocument();
    expect(items[3]).toHaveAttribute('aria-current', 'step');
    expect(within(items[4] as HTMLElement).getByText('Locked')).toBeInTheDocument();
    expect(within(items[3] as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Step 4 of 13: Competing hypotheses shown',
    );
  });

  it('opens an unlocked step in the product through a real link, and explains a locked step', async () => {
    renderApp(<DemoGuidePage />, { api: api() });
    const done = await stepItem('Import Case One');
    expect(within(done).getByRole('link', { name: /Open Import Case One/ })).toHaveAttribute(
      'href',
      '/cases/case_1',
    );
    const locked = await stepItem('A better path simulated and accepted');
    expect(within(locked).getByText(/Complete "Decision forks found" first/)).toBeInTheDocument();
    expect(within(locked).queryByRole('link')).toBeNull();
    expect(within(locked).getByRole('button', { name: /Open A better path/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('puts the next step first with its role and a primary action', async () => {
    renderApp(<DemoGuidePage />, { api: api() });
    const next = await screen.findByRole('group', { name: 'Next step' });
    expect(within(next).getByText('Next: Competing hypotheses shown')).toBeInTheDocument();
    expect(within(next).getByText(/Present as Technical Support Engineer/)).toBeInTheDocument();
    expect(
      within(next).getByRole('link', { name: 'Open Competing hypotheses shown' }),
    ).toHaveAttribute('href', '/cases/case_1/hypotheses');
  });

  it('shows the dataset, provider and case links as the API reports them, with honest labels', async () => {
    renderApp(<DemoGuidePage />, { api: api() });
    const progress = await screen.findByRole('group', { name: 'Progress' });
    expect(within(progress).getByText('Synthetic demonstration data')).toBeInTheDocument();
    expect(within(progress).getByText('Simulated')).toBeInTheDocument();
    expect(within(progress).getByText('Deterministic provider')).toBeInTheDocument();
    expect(within(progress).getByRole('link', { name: 'Open Case One' })).toHaveAttribute(
      'href',
      '/cases/case_1',
    );
    expect(within(progress).getByText('Not imported yet')).toBeInTheDocument();
    expect(
      screen.getByText(/validated against mocks or locally generated test keys only/),
    ).toBeInTheDocument();
  });

  it('says plainly when nothing has been loaded yet', async () => {
    renderApp(<DemoGuidePage />, { api: api({ 'demo.state': () => demoState(0) }) });
    expect(await screen.findByText('Nothing has been loaded yet')).toBeInTheDocument();
    expect(screen.getByText('Not seeded')).toBeInTheDocument();
    expect(screen.getByText('0 of 13 steps complete')).toBeInTheDocument();
  });

  it('keeps the last step reachable once the story is complete, with the comparison of the two cases as its target', async () => {
    renderApp(<DemoGuidePage />, { api: api({ 'demo.state': () => demoState(13) }) });
    const next = await screen.findByRole('group', { name: 'Next step' });
    expect(
      within(next).getByText(/Every step is done\. Last step: Outcomes compared/),
    ).toBeInTheDocument();
    // The API's route carries a query string (`?tab=compare&with=`): it must reach the link whole.
    expect(within(next).getByRole('link', { name: 'Open Outcomes compared' })).toHaveAttribute(
      'href',
      COMPARE_ROUTE,
    );
    const last = await stepItem('Outcomes compared');
    expect(within(last).getByRole('link', { name: /Open Outcomes compared/ })).toHaveAttribute(
      'href',
      COMPARE_ROUTE,
    );
  });

  it('leads the last step to the Efficiency Monitor while the API has no two cases to compare', async () => {
    const complete = demoState(13);
    const steps = complete.steps.map((step) =>
      step.id === 'compare-outcomes' ? { ...step, route: '/efficiency' } : step,
    );
    renderApp(<DemoGuidePage />, { api: api({ 'demo.state': () => demoState(13, { steps }) }) });
    const next = await screen.findByRole('group', { name: 'Next step' });
    expect(within(next).getByRole('link', { name: 'Open Outcomes compared' })).toHaveAttribute(
      'href',
      '/efficiency',
    );
  });
});

describe('[FR-DEMO-02] persona per step and presentation mode', () => {
  it('offers the persona of this tenant that holds the role, never one of another tenant', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, { api: api() });
    const step = await stepItem('Competing hypotheses shown');
    // The persona list and the session load after the page itself.
    const button = await within(step).findByRole('button', { name: 'Switch to Ava Engineer' });
    expect(screen.queryByText(/Fabi Engineer/)).toBeNull();
    await user.click(button);
    expect(window.localStorage.getItem('cg-persona')).toBe('user_ava_engineer');
    await expectToast('Now acting as Ava Engineer');
  });

  it('does not offer a switch when the identity already holds the role', async () => {
    renderApp(<DemoGuidePage />, { api: api({ 'session.me': engineer }) });
    const step = await stepItem('Competing hypotheses shown');
    expect(await within(step).findByText(/you are acting as this role/)).toBeInTheDocument();
    expect(within(step).queryByRole('button', { name: /Switch to/ })).toBeNull();
  });

  it('starts and exits presentation mode, hiding seed and persona controls while presenting', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, { api: api() });
    await screen.findByRole('group', { name: 'Demo data' });
    await user.click(screen.getByRole('button', { name: 'Start presentation mode' }));
    await waitFor(() => expect(document.documentElement.dataset.cgPresent).toBe('true'));
    expect(screen.getByRole('button', { name: 'Exit presentation mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('group', { name: 'Demo data' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Switch to/ })).toBeNull();
    expect(
      screen.getByText(/Seeding and persona controls are hidden while presenting/),
    ).toBeInTheDocument();
    const next = screen.getByRole('group', { name: 'Next step' });
    expect(within(next).getByRole('link', { name: /Open Competing hypotheses/ })).toHaveClass(
      'cg-presenter-target',
    );
    await user.click(screen.getByRole('button', { name: 'Exit presentation mode' }));
    await waitFor(() => expect(document.documentElement.dataset.cgPresent).toBe('false'));
  });

  it('opens the next step with the n shortcut', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, { api: api() });
    await screen.findByText('3 of 13 steps complete');
    await user.keyboard('n');
    expect(router.push).toHaveBeenCalledWith('/cases/case_1/hypotheses');
  });
});

describe('[FR-DEMO-03] seed and reset controls', () => {
  it('resets the demo after a confirmation, refreshes the data and confirms with a toast', async () => {
    const user = userEvent.setup();
    let resets = 0;
    const fake = api({
      'demo.reset': () => {
        resets += 1;
        return demoState(0);
      },
    });
    renderApp(<DemoGuidePage />, { api: fake });
    const controls = await screen.findByRole('group', { name: 'Reset demo data' });
    await user.click(await enabledButton(controls, 'Reset demo data'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset the demo data?' });
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reset demo' }));
    await expectToast('Demo data reset');
    expect(resets).toBe(1);
    await waitFor(() =>
      expect(
        fake.call.mock.calls.filter((call) => call[0] === 'demo.state').length,
      ).toBeGreaterThan(1),
    );
  });

  it('explains the API refusal (409 not_a_demo_tenant) inside the dialog and changes nothing', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, {
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
    const controls = await screen.findByRole('group', { name: 'Reset demo data' });
    await user.click(await enabledButton(controls, 'Reset demo data'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset demo' }));
    expect(
      await within(dialog).findByText(/only be seeded or reset in a synthetic demo tenant/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Words the page must not depend on/)).toBeNull();
    expect(screen.queryByText('Demo data reset')).toBeNull();
  });

  it('says a job is still running (409 job_active) when seeding is refused, then lets you try again', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderApp(<DemoGuidePage />, {
      api: api({
        'demo.seed': () => {
          calls += 1;
          if (calls === 1)
            throw new ApiError({
              status: 409,
              code: 'conflict',
              reason: 'job_active',
              title: 'Conflict',
              message: 'x',
            });
          return demoState(13);
        },
        'jobs.list': () => ({ items: [], nextCursor: null }),
      }),
    });
    const controls = await screen.findByRole('group', { name: 'Play the whole story' });
    await user.click(await enabledButton(controls, 'Play the whole story'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Play the story' }));
    expect(
      await within(dialog).findByText(/A job is still queued or running in this workspace/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Play the story' }));
    await expectToast('The demo story was played');
    expect(calls).toBe(2);
  });

  it('says the demo personas are missing (409 personas_unavailable)', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, {
      api: api({
        'demo.seed': () => {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            reason: 'personas_unavailable',
            title: 'Conflict',
            message: 'x',
          });
        },
      }),
    });
    const controls = await screen.findByRole('group', { name: 'Start from step 1' });
    await user.click(await enabledButton(controls, 'Start from step 1'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Erase and start over' }));
    expect(await within(dialog).findByText(/needs its synthetic personas/)).toBeInTheDocument();
  });

  it('asks for a pause on a rate limit (429) with the delay the server gave', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, {
      api: api({
        'demo.reset': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            retryAfterMs: 7000,
          });
        },
      }),
    });
    const controls = await screen.findByRole('group', { name: 'Reset demo data' });
    await user.click(await enabledButton(controls, 'Reset demo data'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reset demo' }));
    expect(await within(dialog).findByText(/Try again in about 7 seconds\./)).toBeInTheDocument();
  });

  it('starts from step 1 with the base profile after a danger confirmation', async () => {
    const user = userEvent.setup();
    const fake = api({ 'demo.seed': () => demoState(0) });
    renderApp(<DemoGuidePage />, { api: fake });
    const controls = await screen.findByRole('group', { name: 'Start from step 1' });
    await user.click(await enabledButton(controls, 'Start from step 1'));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/All cases, analysis results, skills and jobs/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Erase and start over' }));
    await expectToast('Demo data reset to step 1');
    expect(fake.call).toHaveBeenCalledWith(
      'demo.seed',
      expect.objectContaining({ body: { profile: 'base' } }),
    );
  });

  it('plays the whole story and shows the real stage of the running job', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = api({
      'demo.seed': async () => {
        await gate;
        return demoState(13);
      },
      'jobs.list': () => ({ items: [runningJob], nextCursor: null }),
    });
    renderApp(<DemoGuidePage />, { api: fake });
    const controls = await screen.findByRole('group', { name: 'Play the whole story' });
    await user.click(await enabledButton(controls, 'Play the whole story'));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Play the story' }));
    // The dialog stays open and covers the page while the story plays, so the real stage is shown inside it.
    expect(
      await within(dialog).findByText('Playing the story: Importing Case Two (1 of 2 stages done)'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('progressbar', { name: 'Seeding progress' }),
    ).toBeInTheDocument();
    expect(fake.call).toHaveBeenCalledWith(
      'demo.seed',
      expect.objectContaining({ body: { profile: 'portfolio' } }),
    );
    release();
    await expectToast('The demo story was played');
  });

  it('disables the controls for a role without demo:manage and says why', async () => {
    renderApp(<DemoGuidePage />, { api: api({ 'session.me': engineer }) });
    const controls = await screen.findByRole('group', { name: 'Reset demo data' });
    expect(within(controls).getByRole('button', { name: 'Reset demo data' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('[FR-DEMO-04] URL state and page states', () => {
  it('opens the presenter notes of the step named in ?step= and keeps the URL in sync', async () => {
    const user = userEvent.setup();
    navigateTo('/demo?step=reconstruct-timeline');
    renderApp(<DemoGuidePage />, { api: api() });
    const step = await stepItem('Timeline reconstructed');
    expect(within(step).getByText(/Notes for "Timeline reconstructed"/)).toBeInTheDocument();
    const toggle = within(step).getByRole('button', { name: 'Presenter notes' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(window.location.search).toBe('');
    expect(within(step).queryByText(/Notes for "Timeline reconstructed"/)).toBeNull();

    const other = await stepItem('Evidence ledger built');
    await user.click(within(other).getByRole('button', { name: 'Presenter notes' }));
    expect(window.location.search).toBe('?step=build-evidence-ledger');
    expect(within(other).getByText(/Notes for "Evidence ledger built"/)).toBeInTheDocument();
  });

  it('always shows the presenter notes of the next step', async () => {
    renderApp(<DemoGuidePage />, { api: api() });
    const next = await stepItem('Competing hypotheses shown');
    expect(within(next).getByText(/Notes for "Competing hypotheses shown"/)).toBeInTheDocument();
    expect(within(next).queryByRole('button', { name: 'Presenter notes' })).toBeNull();
  });

  it('shows a loading skeleton first', async () => {
    renderApp(<DemoGuidePage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Loading the demo steps/).length).toBeGreaterThan(0);
    await screen.findByText('3 of 13 steps complete');
  });

  it('explains an empty guide and offers a reload', async () => {
    renderApp(<DemoGuidePage />, { api: api({ 'demo.state': () => demoState(0, { steps: [] }) }) });
    expect(await screen.findByText('The demo guide has no steps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('shows an error with Retry and recovers', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderApp(<DemoGuidePage />, {
      api: api({
        'demo.state': () => {
          calls += 1;
          if (calls === 1)
            throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
          return demoState(3);
        },
      }),
    });
    expect(await screen.findByText('The demo guide could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('3 of 13 steps complete')).toBeInTheDocument();
  });

  it('asks for an identity when nobody is signed in', async () => {
    renderApp(<DemoGuidePage />, { api: api(), persona: null });
    expect(await screen.findByText('Choose who you are acting as')).toBeInTheDocument();
  });

  it('has no accessibility violations (admin, loaded)', async () => {
    const { container } = renderApp(<DemoGuidePage />, { api: api() });
    await screen.findByText('3 of 13 steps complete');
    await expectNoAxeViolations(container);
  });

  it('has no accessibility violations (engineer, story complete, presenting)', async () => {
    navigateTo('/demo?present=1');
    const { container } = renderApp(<DemoGuidePage />, {
      api: api({ 'session.me': engineer, 'demo.state': () => demoState(13) }),
    });
    await screen.findByText('13 of 13 steps complete');
    await expectNoAxeViolations(container);
  });
});

describe('[FR-DEMO-05] keyboard', () => {
  it('N opens the next step of the story', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, { api: api() });
    await screen.findByText('3 of 13 steps complete');
    await user.keyboard('n');
    expect(router.push).toHaveBeenCalledWith('/cases/case_1/hypotheses');
  });

  it('N opens a step whose route has a query string exactly as the API gave it', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, { api: api({ 'demo.state': () => demoState(12) }) });
    await screen.findByText('12 of 13 steps complete');
    await user.keyboard('n');
    expect(router.push).toHaveBeenCalledWith(COMPARE_ROUTE);
  });

  it('does nothing while the guide has not loaded', async () => {
    const user = userEvent.setup();
    renderApp(<DemoGuidePage />, {
      api: api({
        'demo.state': () => {
          throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
        },
      }),
    });
    await screen.findByText('The demo guide could not be loaded');
    await user.keyboard('n');
    expect(router.push).not.toHaveBeenCalled();
  });
});
