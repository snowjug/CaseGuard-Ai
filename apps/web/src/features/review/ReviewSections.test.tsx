import { COUNTERFACTUAL_STRATEGIES, type Job, type SkillMatch } from '@caseguard/schemas';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { job } from '../../../test/case-fixtures';
import { expectNoAxeViolations, renderApp } from '../../../test/harness';
import { installMatchMedia } from '../../../test/media';
import { router } from '../../../test/next-navigation';
import { CASE_ONE, CASE_TWO, OVERLAY_ONE } from '../../../test/review-fixtures';
import { calledRoutes, reviewApi, type ReviewApiOptions } from '../../../test/review-support';
import { EvidenceProvider } from './evidence/EvidenceProvider';
import { ActionsSection } from './sections/ActionsSection';
import { ChronologySection } from './sections/ChronologySection';
import { DecisionsSection } from './sections/DecisionsSection';
import { LearningSection } from './sections/LearningSection';
import { PathsSection } from './sections/PathsSection';

// A drawer opens through Fluent's motion and Tabster's focus handling, which take several seconds when the machine is
// busy (it opened in under a second alone and missed 5 s while two other test runs shared the CPU).
configure({ asyncUtilTimeout: 15_000 });

function renderSection(node: ReactNode, options: ReviewApiOptions = {}) {
  const fixture = options.fixture ?? CASE_ONE;
  const api = reviewApi(options);
  const view = renderApp(
    <EvidenceProvider caseId={fixture.detail.id}>
      <main>{node}</main>
    </EvidenceProvider>,
    { api },
  );
  return { api, ...view };
}

const CASE_ID = CASE_ONE.detail.id;
const MATCH = CASE_ONE.matches[0] as SkillMatch;

const running = (kind: Job['kind'], id: string): Job =>
  job({ id, kind, caseId: CASE_ID, status: 'running' });

describe('[REV-DEC-01] what went wrong', () => {
  it('explains the first decision points with what was known, not yet known, done and better, and the rest on request', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    const { container } = renderSection(<DecisionsSection caseId={CASE_ID} />);
    const list = await screen.findByRole('list', { name: 'Decision points' });
    expect(within(list).getAllByRole('article')).toHaveLength(3);
    const first = within(within(list).getAllByRole('article')[0] as HTMLElement);
    expect(
      first.getByRole('heading', {
        level: 3,
        name: 'Heavy customer request when a lighter ask was available',
      }),
    ).toBeVisible();
    expect(first.getByText('The earliest important one')).toBeVisible();
    for (const label of [
      'What was known then',
      'What was not yet known',
      'What was done',
      'A better-supported step',
    ]) {
      expect(first.getByRole('heading', { level: 4, name: label })).toBeVisible();
    }
    expect(first.getByText('Estimated')).toBeVisible();
    expect(screen.getAllByText('The earliest important one')).toHaveLength(1);

    const more = screen.getByRole('button', { name: 'Show 6 more decision points' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(within(list).getAllByRole('article')).toHaveLength(9);
    expect(screen.getByRole('button', { name: 'Show only the first 3' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expectNoAxeViolations(container);
  });

  it('opens the evidence of a decision point in the drawer and closes it with Escape, returning focus to the chip', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    renderSection(<DecisionsSection caseId={CASE_ID} />);
    const list = await screen.findByRole('list', { name: 'Decision points' });
    const chip = (await within(list).findAllByRole('button', { name: /^Message or event:/ }))[0];
    expect(chip).toBeDefined();
    await user.click(chip as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'Evidence', hidden: true })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Evidence', hidden: true })).toBeNull(),
    );
    await waitFor(() => expect(chip).toHaveFocus());
  });

  it('says that a case with no decision point is in good shape', async () => {
    installMatchMedia();
    renderSection(<DecisionsSection caseId={CASE_TWO.detail.id} />, { fixture: CASE_TWO });
    expect(await screen.findByText('No decision point stood out')).toBeVisible();
  });
});

describe('[REV-CHR-01] the chronology', () => {
  it('draws the strip with a text alternative and lists the key events and waits in words', async () => {
    installMatchMedia();
    const { container } = renderSection(<ChronologySection caseId={CASE_ID} />);
    const list = await screen.findByRole('list', { name: 'Key events and waits, 14 key events' });
    expect(screen.getByRole('img', { name: /^Chronology strip\./ })).toBeVisible();
    const links = within(list).getAllByRole('link', { name: /^Show in timeline:/ });
    expect(links).toHaveLength(14);
    expect(links[1]).toHaveAttribute('href', `/cases/${CASE_ID}/timeline?sel=e03`);
    expect(
      within(list).getByText('The customer waited 15 hours 10 minutes for a reply.'),
    ).toBeVisible();
    expect(
      within(list).getAllByText(
        /^(The customer waited|The engineer waited|Nothing was recorded for)/,
      ),
    ).toHaveLength(4);
    expect(within(list).getAllByText('Decision point 1').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Open the full timeline' })).toHaveAttribute(
      'href',
      `/cases/${CASE_ID}/timeline`,
    );
    await expectNoAxeViolations(container);
  });

  it('gives way to the list alone on a narrow screen, with the side named on every event', async () => {
    installMatchMedia((query) => query === '(max-width: 639px)');
    renderSection(<ChronologySection caseId={CASE_ID} />);
    const list = await screen.findByRole('list', { name: /Key events and waits/ });
    expect(screen.queryByRole('img', { name: /^Chronology strip\./ })).toBeNull();
    expect(within(list).getAllByText(/ lane · /).length).toBe(14);
  });

  it('keeps the chronology when the decision points cannot be read, and says they are not marked', async () => {
    installMatchMedia();
    renderSection(<ChronologySection caseId={CASE_ID} />, {
      handlers: {
        'forks.list': () => {
          throw new Error('down');
        },
      },
    });
    expect(await screen.findByText('Decision points not marked')).toBeVisible();
    expect(await screen.findByRole('list', { name: /Key events and waits/ })).toBeVisible();
  });
});

describe('[REV-PATH-03] what should have happened', () => {
  it('sets the recorded path beside the simulated one, labelled as a simulated estimate, with confidence and assumptions', async () => {
    installMatchMedia();
    const { container } = renderSection(<PathsSection caseId={CASE_ID} />);
    const table = await screen.findByRole('table', {
      name: 'The recorded path and the better-supported path (simulated estimate)',
    });
    expect(screen.getByText('Simulated estimate')).toBeVisible();
    expect(
      within(table).getByRole('columnheader', {
        name: 'Better-supported path (simulated estimate)',
      }),
    ).toBeVisible();
    const timeRow = within(table).getByRole('row', { name: /^Time to useful evidence/ });
    expect(within(timeRow).getByText('1 h 24 min')).toBeVisible();
    expect(within(timeRow).getByText('1 h 40 min (1 h 09 min to 2 h 23 min)')).toBeVisible();
    expect(within(timeRow).getByText('Within the simulation’s uncertainty')).toBeVisible();
    expect(screen.getByText(/^Low confidence \(/)).toBeVisible();
    expect(screen.getByText('All 8 validity checks passed')).toBeVisible();
    expect(screen.getByText('Used only what was known then')).toBeVisible();
    expect(screen.getByText('Accepted')).toBeVisible();
    expect(screen.getByText('Assumptions (5)')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open in the Counterfactual Lab' })).toHaveAttribute(
      'href',
      expect.stringContaining(`/cases/${CASE_ID}/counterfactual?sel=scn_`),
    );
    await expectNoAxeViolations(container);
  });

  it('says there is nothing to compare when no decision point stood out', async () => {
    installMatchMedia();
    renderSection(<PathsSection caseId={CASE_TWO.detail.id} />, { fixture: CASE_TWO });
    expect(await screen.findByText('Nothing to compare')).toBeVisible();
  });

  const unsimulated = { ...CASE_ONE, scenarios: [] };

  it('offers the existing simulation, behind a confirmation, and follows its job', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    const { api } = renderSection(<PathsSection caseId={CASE_ID} />, {
      fixture: unsimulated,
      handlers: {
        'counterfactuals.run': () => ({ job: running('counterfactual', 'job_sim') }),
        'jobs.get': () => running('counterfactual', 'job_sim'),
      },
    });
    expect(
      await screen.findByText('No better-supported path has been simulated yet'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Simulate a better-supported path' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Simulate a better-supported path',
      hidden: true,
    });
    expect(within(dialog).getByText(/Nothing is executed/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Simulate', hidden: true }));
    expect(await screen.findByText('Simulating better-supported paths')).toBeVisible();
    const call = api.call.mock.calls.find((entry) => entry[0] === 'counterfactuals.run');
    expect(call?.[1]).toMatchObject({
      params: { caseId: CASE_ID, forkId: CASE_ONE.forks.items[0]?.id },
      body: { strategies: [...COUNTERFACTUAL_STRATEGIES] },
    });
  });

  it('tells a manager who can run the simulation instead of offering a button that cannot work', async () => {
    installMatchMedia();
    renderSection(<PathsSection caseId={CASE_ID} />, { fixture: unsimulated, role: 'manager' });
    expect(
      await screen.findByText('No better-supported path has been simulated yet'),
    ).toBeVisible();
    expect(
      await screen.findByText(/cannot simulate paths\. Engineers and administrators can run it/),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Simulate a better-supported path' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('[REV-ACT-01] next actions', () => {
  it('lists the most urgent recommendations first with their evidence, and the rest on request', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    const { container } = renderSection(<ActionsSection caseId={CASE_ID} />);
    const list = await screen.findByRole('list', { name: 'Ranked recommendations' });
    const items = within(list).getAllByRole('article');
    expect(items).toHaveLength(5);
    expect(
      within(items[0] as HTMLElement).getByRole('heading', {
        level: 3,
        name: 'Write causes as hypotheses until evidence supports them',
      }),
    ).toBeVisible();
    expect(within(items[0] as HTMLElement).getByText('Critical')).toBeVisible();
    expect(within(items[0] as HTMLElement).getByText('Also the coach’s next action')).toBeVisible();
    expect(
      within(items[0] as HTMLElement).getAllByRole('button', {
        name: /^(Statement|Message or event):/,
      }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Warnings: 0 open, 14 resolved, 0 dismissed\./)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show 3 more recommendations' }));
    expect(within(list).getAllByRole('article')).toHaveLength(8);
    await expectNoAxeViolations(container);
  });

  it('goes from a recommendation to the checked source passage in two interactions', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    renderSection(<ActionsSection caseId={CASE_ID} />);
    const list = await screen.findByRole('list', { name: 'Ranked recommendations' });
    const first = within(within(list).getAllByRole('article')[0] as HTMLElement);
    await user.click(
      await first.findByRole('button', {
        name: /^Statement: Root cause is the Conditional Access policy/,
      }),
    );
    // jsdom has no real focus handling, so Fluent's focus manager hides the open dialog from role queries.
    const drawer = within(await screen.findByRole('dialog', { name: 'Evidence', hidden: true }));
    expect(await drawer.findAllByText('Checked against the stored message')).not.toHaveLength(0);
    expect(drawer.getByText('Root cause is', { selector: 'mark' })).toBeVisible();
    expect(
      (await drawer.findAllByRole('link', { name: 'Show in timeline', hidden: true }))[0],
    ).toHaveAttribute('href', `/cases/${CASE_ID}/timeline?sel=e07`);
  });

  it('says plainly when a recommendation is general guidance with no case-specific evidence', async () => {
    installMatchMedia();
    renderSection(<ActionsSection caseId={CASE_TWO.detail.id} />, { fixture: CASE_TWO });
    const list = await screen.findByRole('list', { name: 'Ranked recommendations' });
    expect(
      within(list).getByRole('heading', { level: 3, name: 'Share what worked' }),
    ).toBeVisible();
    expect(within(list).getByText('General guidance — no case-specific evidence')).toBeVisible();
    expect(
      within(list).queryByRole('button', { name: /^(Statement|Message or event):/ }),
    ).toBeNull();
  });

  it('explains a missing permission once, for the two sources that need it, and does not ask for them', async () => {
    installMatchMedia();
    const { api } = renderSection(<ActionsSection caseId={CASE_ID} />, { role: 'skill_curator' });
    expect(
      await screen.findByText(
        /so the quality improvements and the coach’s suggestion cannot be shown here/,
      ),
    ).toBeVisible();
    expect(screen.getAllByText('Not shown')).toHaveLength(1);
    const routes = calledRoutes(api);
    expect(routes).not.toContain('quality.get');
    expect(routes).not.toContain('coaching.get');
    expect(routes).toContain('warnings.list');
  });
});

describe('[REV-LRN-01] learning', () => {
  it('shows the skill match with the server’s recorded and with-skill figures exactly as given', async () => {
    installMatchMedia();
    const { container } = renderSection(<LearningSection caseId={CASE_ID} />);
    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: `This resembles ${MATCH.skillName}`,
      }),
    ).toBeVisible();
    expect(screen.getByText(/Match 100%/)).toBeVisible();
    const table = await screen.findByRole('table', {
      name: 'Recorded against with the skill (estimates worked out by the server)',
    });
    const first = OVERLAY_ONE.comparison[0];
    expect(first?.label).toBe('Time to useful evidence');
    const row = within(table).getByRole('row', { name: /^Time to useful evidence/ });
    expect(within(row).getByText('240 min (120 min to 480 min)')).toBeVisible();
    expect(within(row).getByText('150 min (0 min to 450 min)')).toBeVisible();
    expect(within(row).getByText('90 min (30 min to 150 min)')).toBeVisible();
    // A figure the server could not compute stays "Not available"; the screen never fills it in.
    const tokens = within(table).getByRole('row', { name: /^Estimated tokens/ });
    expect(within(tokens).getAllByText('Not available').length).toBeGreaterThanOrEqual(2);
    await expectNoAxeViolations(container);
  });

  it('adopts the plan only after a confirmation, once, and says what it records', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    const { api } = renderSection(<LearningSection caseId={CASE_ID} />, {
      handlers: {
        'skillMatches.apply': () => ({
          ...MATCH,
          applied: true,
          appliedAt: '2026-03-10T09:00:00.000Z',
          appliedBy: 'user_engineer',
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: /^Adopt this plan:/ }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Adopt this plan for the case?',
      hidden: true,
    });
    expect(within(dialog).getByText(/It does not change the case or run anything/)).toBeVisible();
    expect(calledRoutes(api)).not.toContain('skillMatches.apply');
    await user.click(within(dialog).getByRole('button', { name: 'Adopt the plan', hidden: true }));
    await waitFor(() => expect(calledRoutes(api)).toContain('skillMatches.apply'));
    const call = api.call.mock.calls.find((entry) => entry[0] === 'skillMatches.apply');
    expect(call?.[1]).toMatchObject({ params: { caseId: CASE_ID, matchId: MATCH.id } });
    expect(calledRoutes(api).filter((route) => route === 'skillMatches.apply')).toHaveLength(1);
  });

  it('shows an applied plan as applied, with how closely it was followed, and offers nothing to adopt', async () => {
    installMatchMedia();
    renderSection(<LearningSection caseId={CASE_TWO.detail.id} />, { fixture: CASE_TWO });
    expect(await screen.findByText(/This resembles/)).toBeVisible();
    expect(screen.getByText(/Plan adopted/)).toBeVisible();
    expect(screen.getByText(/4 of 4 steps followed/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Adopt this plan:/ })).toBeNull();
  });

  it('lets an engineer extract a reusable skill from the accepted path and follows the job', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    const { api } = renderSection(<LearningSection caseId={CASE_ID} />, {
      handlers: {
        'skills.extract': () => ({ job: running('skill_extraction', 'job_extract') }),
        'jobs.get': () => running('skill_extraction', 'job_extract'),
      },
    });
    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: 'Turn this case into a reusable skill',
      }),
    ).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Extract a reusable skill' }));
    expect(await screen.findByText('Extracting a reusable skill')).toBeVisible();
    const call = api.call.mock.calls.find((entry) => entry[0] === 'skills.extract');
    expect(call?.[1]).toMatchObject({
      params: { caseId: CASE_ID },
      body: { scenarioId: CASE_ONE.scenarios[0]?.id },
    });
    expect(router.push).not.toHaveBeenCalled();
  });

  it('keeps a manager from adopting or extracting, and says why', async () => {
    installMatchMedia();
    renderSection(<LearningSection caseId={CASE_ID} />, { role: 'manager' });
    const adopt = await screen.findByRole('button', { name: /^Adopt this plan:/ });
    expect(adopt).toHaveAttribute('aria-disabled', 'true');
    expect(
      await screen.findByText(
        /cannot extract skills; engineers, skill curators and administrators can/,
      ),
    ).toBeVisible();
  });
});
