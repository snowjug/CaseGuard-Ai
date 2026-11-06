import { SYNTHETIC_EFFECTIVENESS_NOTICE, type Permission } from '@caseguard/schemas';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { finishedJob } from '../../../test/case-fixtures';
import { caseSummary, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeApi,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo, setNavigationLatency } from '../../../test/next-navigation';
import {
  OTHER_CASE_ID,
  PRECEDENT_BASIS,
  SKILL_ID,
  TWO_BASES_NOTE,
  proposedVersion,
  skillApproval,
  skillDetail,
  skillDiff,
  skillDna,
  skillEffectiveness,
  skillMatch,
  skillPrecedent,
  skillValidation,
  skillVersion,
  transitionOption,
  versionSummary,
} from '../../../test/u3-fixtures';
import { ApiError } from '../../lib/api/errors';
import { AS_OF_STALE_MS } from '../../components/case/as-of';
import { CaseSkillMatches } from './CaseSkillMatches';
import { latestFor, restorableVersions } from './ChangesPanels';
import { furthestReached } from './LifecycleStepper';
import { presentApproval } from './labels';
import { joinReferences, precedentHeadline, precedentTitle } from './precedent';
import { SkillDetailPage } from './SkillDetailPage';
import { SkillLibraryPage } from './SkillLibraryPage';
import { timeComparison, tokenSavingsText } from './UsageTab';
import { scopeOf } from './ValidationTab';
import { sectionLabel } from './VersionsTab';

const NAME = 'Isolate a pre-authentication failure before pursuing identity policy';

// A busy machine can take several seconds to settle a chain of requests; assertions stay exact, only the wait is longer.
configure({ asyncUtilTimeout: 5000 });
const AXE_TIMEOUT = 120_000;

const CURATOR: readonly Permission[] = [
  'case:read',
  'skill:read',
  'skill:extract',
  'skill:mutate',
  'skill:validate',
  'skill:review',
  'skill:approve',
  'skill:publish',
  'skill:retire',
  'skill:rollback',
  'skill:apply',
];
const READER: readonly Permission[] = ['case:read', 'skill:read'];

function api(overrides: FakeHandlers = {}, permissions: readonly Permission[] = CURATOR) {
  return fakeApi({
    'session.me': () => session('skill_curator', permissions),
    'cases.list': () => ({
      items: [
        caseSummary({ id: 'case_1', reference: 'CG-SYN-1001', title: 'Teams sign-in failures' }),
        caseSummary({ id: OTHER_CASE_ID, reference: 'CG-SYN-1002', title: 'Rotterdam site' }),
        caseSummary({
          id: 'case_3',
          reference: 'CG-SYN-1003',
          title: 'Not analysed yet',
          analysisState: 'not_analyzed',
        }),
      ],
      nextCursor: null,
    }),
    'skills.list': () => ({ items: [skillDna()], nextCursor: null }),
    'skills.get': () => skillDetail({ approvals: lifecycleApprovals() }),
    'skills.diff': () => skillDiff(),
    ...overrides,
  });
}

/** The decisions that took a skill from Discovered to Published, by three different people. */
function lifecycleApprovals() {
  return [
    skillApproval({
      id: 'skp_1',
      fromState: 'discovered',
      toState: 'draft',
      approver: 'user_casey_curator',
    }),
    skillApproval({
      id: 'skp_2',
      fromState: 'expert_reviewed',
      toState: 'pilot',
      approver: 'user_riley_reviewer',
    }),
    skillApproval({
      id: 'skp_3',
      fromState: 'validated',
      toState: 'published',
      approver: 'user_alex_admin',
    }),
  ];
}

const callsOf = (fake: FakeApi, routeId: string): unknown[] =>
  fake.call.mock.calls.filter(([id]) => id === routeId).map(([, input]): unknown => input);

/** The search text of each library request, in order (undefined: no search). */
const searchesOf = (fake: FakeApi): (string | undefined)[] =>
  callsOf(fake, 'skills.list').map((input) => (input as { query: { q?: string } }).query.q);

async function openDialog(button: HTMLElement, title: string): Promise<HTMLElement> {
  await userEvent.click(button);
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText(title)).toBeInTheDocument();
  return dialog;
}

async function reasonAndConfirm(
  dialog: HTMLElement,
  reason: string,
  confirm: string,
): Promise<void> {
  await userEvent.type(within(dialog).getByRole('textbox'), reason);
  await userEvent.click(within(dialog).getByRole('button', { name: confirm }));
}

describe('[FR-SK-01] Skill presentation helpers', () => {
  it('presents withdrawing a skill as "Withdrawn", never as "Rejected"', () => {
    for (const toState of ['deprecated', 'retired'] as const) {
      const view = presentApproval({ decision: 'rejected', fromState: 'published', toState });
      expect(view.label).toBe(`Withdrawn (${toState})`);
      expect(view.sentence('Casey')).toBe(`Withdrawn (${toState}) by Casey`);
      expect(view.label).not.toMatch(/reject/i);
      expect(view.sentence('Casey')).not.toMatch(/reject/i);
    }
  });

  it('still calls the rejection of a proposed version a rejection', () => {
    const view = presentApproval({
      decision: 'rejected',
      fromState: 'published',
      toState: 'published',
    });
    expect(view.label).toBe('Rejected a proposed version');
    expect(view.sentence('Casey')).toBe('A proposed version was rejected by Casey');
  });

  it('describes approvals, changes requested and an approved proposal in words', () => {
    expect(
      presentApproval({ decision: 'approved', fromState: 'discovered', toState: 'draft' }).label,
    ).toBe('Approved: Draft');
    expect(
      presentApproval({
        decision: 'changes_requested',
        fromState: 'pilot',
        toState: 'draft',
      }).sentence('Riley'),
    ).toBe('Sent back to Draft by Riley (changes requested)');
    expect(
      presentApproval({
        decision: 'approved',
        fromState: 'expert_reviewed',
        toState: 'simulation_tested',
      }).sentence('Casey'),
    ).toContain('the skill went back to Simulation Tested so the new content is reviewed again');
  });

  it('shows how far a withdrawn skill got along the path', () => {
    const approvals = [
      { decision: 'approved', toState: 'draft' },
      { decision: 'approved', toState: 'pilot' },
      { decision: 'rejected', toState: 'deprecated' },
    ] as const;
    expect(furthestReached('deprecated', approvals)).toBe('pilot');
    expect(furthestReached('published', approvals)).toBe('published');
    expect(furthestReached('discovered', [])).toBe('discovered');
  });

  it('treats a validation without a scope as a full run', () => {
    expect(scopeOf({})).toBe('full');
    expect(scopeOf({ scope: 'full' })).toBe('full');
    expect(scopeOf({ scope: 'case' })).toBe('case');
  });

  it('finds the newest validation of a kind for one version', () => {
    const older = skillValidation({ id: 'a', executedAt: '2026-01-01T00:00:00Z' });
    const newer = skillValidation({
      id: 'b',
      executedAt: '2026-02-01T00:00:00Z',
      outcome: 'failed',
    });
    expect(latestFor([older, newer], 'skv_1', 'simulation_test')?.id).toBe('b');
    expect(latestFor([older, newer], 'skv_1', 'regression')).toBeUndefined();
    expect(latestFor([older, newer], 'skv_2', 'simulation_test')).toBeUndefined();
  });

  it('restores only versions the current one was built from', () => {
    const first = skillVersion({ id: 'skv_1', version: '1.0.0', sequence: 1, state: 'superseded' });
    const withdrawn = skillVersion({
      id: 'skv_2',
      version: '1.1.0',
      sequence: 2,
      parentVersionId: 'skv_1',
      state: 'rejected',
    });
    const third = skillVersion({
      id: 'skv_3',
      version: '1.2.0',
      sequence: 3,
      parentVersionId: 'skv_2',
      state: 'active',
    });
    const sideBranch = skillVersion({
      id: 'skv_9',
      version: '2.0.0',
      sequence: 4,
      state: 'superseded',
    });
    const detail = skillDetail({
      skill: skillDna({ currentVersionId: 'skv_3', currentVersion: '1.2.0' }),
      currentVersion: third,
      proposedVersion: null,
      versions: [first, withdrawn, third, sideBranch].map(versionSummary),
    });
    expect(restorableVersions(detail).map((version) => version.id)).toEqual(['skv_1']);
  });

  it('puts differences in plain words', () => {
    expect(sectionLabel('triggerConditions')).toBe('Trigger conditions');
    expect(sectionLabel('someNewSection')).toBe('Some new section');
    expect(tokenSavingsText(-830)).toBe('830% more tokens than the baseline');
    expect(tokenSavingsText(25)).toBe('25% fewer tokens than the baseline');
    expect(tokenSavingsText(0)).toBe('No difference from the baseline');
    expect(tokenSavingsText(null)).toBe('Not enough data');
    expect(timeComparison(skillDna().effectiveness)).toBe(
      '3 h 03 min with the skill, longer than the 2 h 02 min baseline',
    );
    expect(timeComparison({ ...skillDna().effectiveness, avgTimeToDiagnosisMinutes: null })).toBe(
      'Not enough data',
    );
  });

  it('headlines the comparison with the case the skill came from using only the figures the API sent', () => {
    const effectiveness = skillEffectiveness();
    expect(precedentHeadline(skillPrecedent(), effectiveness.applications)).toBe(
      'Compared with CG-SYN-1001: 183 min vs 2,994 min to diagnosis; tokens -79.5%; evidence unchanged; 1 application.',
    );
    // More tokens and more complete evidence keep their sign; fewer applications compared than were made say so.
    expect(
      precedentHeadline(
        skillPrecedent({ cases: 2, tokenChangePct: 12.34, evidenceCompletenessPoints: 5 }),
        3,
      ),
    ).toBe(
      'Compared with CG-SYN-1001: 183 min vs 2,994 min to diagnosis; tokens +12.3%; evidence +5 points; 2 of 3 applications.',
    );
    expect(
      precedentHeadline(skillPrecedent({ cases: 3, evidenceCompletenessPoints: -2.5 }), 3),
    ).toContain('evidence -2.5 points; 3 applications.');
  });

  it('never turns a figure the API could not measure into a number', () => {
    const headline = precedentHeadline(
      skillPrecedent({
        avgTimeToDiagnosisMinutes: null,
        precedentAvgTimeToDiagnosisMinutes: null,
        tokenChangePct: null,
        evidenceCompletenessPoints: null,
      }),
      1,
    );
    expect(headline).toBe(
      'Compared with CG-SYN-1001: time to diagnosis: Not measured; tokens: Not measured; evidence: Not measured; 1 application.',
    );
    // Half a pair is not a comparison.
    expect(
      precedentHeadline(skillPrecedent({ precedentAvgTimeToDiagnosisMinutes: null }), 1),
    ).toContain('time to diagnosis: Not measured');
    // A change that rounds to nothing at one decimal is "unchanged", not "-0%".
    expect(precedentHeadline(skillPrecedent({ tokenChangePct: -0.04 }), 1)).toContain(
      'tokens unchanged',
    );
  });

  it('names the cases the skill came from in one phrase', () => {
    expect(joinReferences([])).toBe('');
    expect(joinReferences(['CG-SYN-1001'])).toBe('CG-SYN-1001');
    expect(joinReferences(['CG-SYN-1001', 'CG-SYN-1002'])).toBe('CG-SYN-1001 and CG-SYN-1002');
    expect(joinReferences(['A', 'B', 'C'])).toBe('A, B and C');
    expect(precedentTitle(skillPrecedent())).toBe('Against the case the skill came from');
    expect(precedentTitle(skillPrecedent({ references: ['A', 'B'] }))).toBe(
      'Against the cases the skill came from',
    );
    expect(precedentHeadline(skillPrecedent({ references: [] }), 1)).toMatch(
      /^Compared with the case the skill came from: /,
    );
  });
});

describe('[FR-SK-02] SkillDNA Library', () => {
  it('shows a skeleton, then each skill with its lifecycle, version, estimated confidence and validation', async () => {
    renderApp(<SkillLibraryPage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 1, name: 'SkillDNA Library' })).toBeInTheDocument();

    const list = await screen.findByRole('list', { name: 'Skills' });
    const card = within(list)
      .getByRole('heading', { level: 2, name: NAME })
      .closest('li') as HTMLElement;
    expect(within(card).getByRole('link', { name: NAME })).toHaveAttribute(
      'href',
      `/skills/${SKILL_ID}`,
    );
    expect(within(card).getByText('Published')).toBeInTheDocument();
    expect(within(card).getByText('Change proposed')).toBeInTheDocument();
    expect(within(card).getByText('Demo data')).toBeInTheDocument();
    expect(within(card).getByText('version 1.0.0')).toBeInTheDocument();
    expect(within(card).getByText('Confidence (estimate)')).toBeInTheDocument();
    expect(within(card).getByText('60%')).toBeInTheDocument();
    expect(within(card).getByText('Validated')).toBeInTheDocument();
    expect(within(card).getByText('Microsoft Teams · teams-authentication')).toBeInTheDocument();
    expect(screen.getByText(/A skill is never published automatically/)).toBeInTheDocument();
  });

  it('filters on the server by lifecycle state and writes the choice to the address', async () => {
    const fake = api();
    renderApp(<SkillLibraryPage />, { api: fake });
    await screen.findByRole('list', { name: 'Skills' });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Lifecycle state' }),
      'draft',
    );
    await waitFor(() => expect(window.location.search).toContain('lifecycle=draft'));
    await waitFor(() =>
      expect(callsOf(fake, 'skills.list').at(-1)).toMatchObject({
        query: { lifecycle: 'draft', limit: 25 },
      }),
    );
  });

  it('searches by text after a short pause and keeps the words in the address', async () => {
    const fake = api();
    renderApp(<SkillLibraryPage />, { api: fake });
    await screen.findByRole('list', { name: 'Skills' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'dns');
    await waitFor(() => expect(window.location.search).toContain('q=dns'));
    await waitFor(
      () => expect(callsOf(fake, 'skills.list').at(-1)).toMatchObject({ query: { q: 'dns' } }),
      {
        timeout: 3000,
      },
    );
  });

  it('keeps every character typed with no pause, however late the address is reported back', async () => {
    setNavigationLatency(5);
    const user = userEvent.setup({ delay: null });
    const fake = api();
    renderApp(<SkillLibraryPage />, { api: fake });
    await screen.findByRole('list', { name: 'Skills' });
    const box = screen.getByRole('searchbox', { name: 'Search' });
    await user.click(box);
    for (const [index, char] of [...'xyz'].entries()) {
      await user.keyboard(char);
      expect(box).toHaveValue('xyz'.slice(0, index + 1));
    }
    await waitFor(() => expect(window.location.search).toBe('?q=xyz'));
    await waitFor(() => expect(searchesOf(fake)).toEqual([undefined, 'xyz']));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(box).toHaveValue('xyz');
    expect(window.location.search).toBe('?q=xyz');
  });

  it('empties the box with Clear filters, also before the typing was written', async () => {
    setNavigationLatency(5);
    const user = userEvent.setup({ delay: null });
    const fake = api();
    renderApp(<SkillLibraryPage />, { api: fake });
    await screen.findByRole('list', { name: 'Skills' });
    const box = screen.getByRole('searchbox', { name: 'Search' });
    await user.type(box, 'dns');
    await user.click(
      screen.getAllByRole('button', { name: 'Clear filters' }).at(-1) as HTMLElement,
    );
    expect(box).toHaveValue('');
    await waitFor(() => expect(window.location.search).toBe(''));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(box).toHaveValue('');
    expect(searchesOf(fake)).toEqual([undefined]);
  });

  it('neither searches nor changes the address for the partial text of an IME composition', async () => {
    const fake = api();
    renderApp(<SkillLibraryPage />, { api: fake });
    await screen.findByRole('list', { name: 'Skills' });
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'ni' } });
    expect(box).toHaveValue('ni');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(window.location.search).toBe('');
    expect(searchesOf(fake)).toEqual([undefined]);
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.compositionEnd(box);
    await waitFor(() => expect(searchesOf(fake)).toEqual([undefined, '你好']));
    expect(new URLSearchParams(window.location.search).get('q')).toBe('你好');
  });

  it('keeps the search box on screen while a search that found nothing is cleared and the full list is on its way', async () => {
    navigateTo('/skills?q=zzz');
    const user = userEvent.setup({ delay: null });
    const fake = api({
      'skills.list': (input) =>
        (input as { query: { q?: string } }).query.q === undefined
          ? new Promise<never>(() => undefined)
          : { items: [], nextCursor: null },
    });
    renderApp(<SkillLibraryPage />, { api: fake });
    expect(await screen.findByText('No skill matches the filters')).toBeInTheDocument();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    await user.clear(box);
    expect(box).toHaveValue('');
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBe(box);
    await waitFor(() => expect(searchesOf(fake)).toEqual(['zzz', undefined]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBe(box);
    expect(screen.queryByText('No skills yet')).toBeNull();
    await user.type(box, 'abc');
    expect(box).toHaveValue('abc');
  });

  it('opens with the filters of the address and offers to clear them when nothing matches', async () => {
    navigateTo('/skills?lifecycle=retired');
    const fake = api({ 'skills.list': () => ({ items: [], nextCursor: null }) });
    renderApp(<SkillLibraryPage />, { api: fake });
    expect(await screen.findByText('No skill matches the filters')).toBeInTheDocument();
    expect(callsOf(fake, 'skills.list')[0]).toMatchObject({ query: { lifecycle: 'retired' } });
    expect(screen.getByRole('combobox', { name: 'Lifecycle state' })).toHaveValue('retired');
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Clear filters' }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('loads the next page on request', async () => {
    const fake = api({
      'skills.list': (input) =>
        (input as { query: { cursor?: string } }).query.cursor === 'c2'
          ? {
              items: [skillDna({ id: 'skl_2', key: 'second', name: 'A second skill' })],
              nextCursor: null,
            }
          : { items: [skillDna()], nextCursor: 'c2' },
    });
    renderApp(<SkillLibraryPage />, { api: fake });
    expect(await screen.findByText('Showing 1 skill; more are available.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Showing 2 skills.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'A second skill' })).toBeInTheDocument();
    expect(callsOf(fake, 'skills.list').at(-1)).toMatchObject({ query: { cursor: 'c2' } });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says how skills come to exist when there are none, and offers the next step', async () => {
    renderApp(<SkillLibraryPage />, {
      api: api({ 'skills.list': () => ({ items: [], nextCursor: null }) }),
    });
    expect(await screen.findByText('No skills yet')).toBeInTheDocument();
    expect(screen.getByText(/accepted in the Counterfactual Lab/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Cases' })).toHaveAttribute('href', '/cases');
  });

  it('shows an error with Retry and recovers', async () => {
    let attempts = 0;
    renderApp(<SkillLibraryPage />, {
      api: api({
        'skills.list': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal',
              title: 'Internal error',
              message: 'Boom',
            });
          return { items: [skillDna()], nextCursor: null };
        },
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The skill library could not be loaded',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Skills' })).toBeInTheDocument();
  });

  it('explains a role without skill access and asks for nothing', async () => {
    const fake = api({}, ['case:read']);
    renderApp(<SkillLibraryPage />, { api: fake });
    expect(
      await screen.findByText('You do not have access to the SkillDNA Library'),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not include the "skill:read" permission/)).toBeInTheDocument();
    expect(callsOf(fake, 'skills.list')).toHaveLength(0);
  });

  it(
    'has no axe violations in light and dark mode',
    async () => {
      const light = renderApp(<SkillLibraryPage />, { api: api() });
      await screen.findByRole('list', { name: 'Skills' });
      await expectNoAxeViolations(light.container);
      light.unmount();
      const dark = renderApp(<SkillLibraryPage />, { api: api(), mode: 'dark' });
      await screen.findByRole('list', { name: 'Skills' });
      await expectNoAxeViolations(dark.container);
    },
    AXE_TIMEOUT,
  );
});

describe('[FR-SK-03] Skill detail: lifecycle and overview', () => {
  it('shows a skeleton, then the lifecycle with the current step said in words', async () => {
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { level: 1, name: NAME })).toBeInTheDocument();
    expect(screen.getAllByText('Estimated confidence').length).toBeGreaterThan(0);

    const steps = await screen.findByRole('list', { name: 'Skill lifecycle' });
    expect(steps).toHaveTextContent('Draft: reached');
    expect(steps).toHaveTextContent('Published: current step');
    expect(steps).toHaveTextContent('Deprecated: withdrawn path, not used');
    expect(steps.querySelector('[aria-current="step"]')).toHaveTextContent('Published');
    expect(
      screen.getByText(/Live for matching\. Publication is always a human decision/),
    ).toBeInTheDocument();
  });

  it('shows how far a withdrawn skill got and where it ended', async () => {
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({ lifecycle: 'deprecated' }),
            proposedVersion: null,
            approvals: [
              ...lifecycleApprovals(),
              skillApproval({
                id: 'skp_9',
                fromState: 'published',
                toState: 'deprecated',
                decision: 'rejected',
              }),
            ],
            transitions: [],
          }),
      }),
    });
    const steps = await screen.findByRole('list', { name: 'Skill lifecycle' });
    expect(steps).toHaveTextContent('Published: reached');
    expect(steps).toHaveTextContent('Deprecated: current step');
    expect(steps.querySelector('[aria-current="step"]')).toHaveTextContent('Deprecated');
  });

  it('announces a proposed change and takes the reviewer to it', async () => {
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    expect(await screen.findByText('A change is waiting for a decision')).toBeInTheDocument();
    expect(
      screen.getByText(/Version 1\.1\.0 was proposed\. It is never applied on its own\./),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review the proposed change' }));
    await waitFor(() => expect(window.location.search).toContain('tab=versions'));
    expect(
      await screen.findByRole('group', { name: 'Proposed version 1.1.0' }),
    ).toBeInTheDocument();
  });

  it('writes the tab to the address and opens the tab it names', async () => {
    navigateTo(`/skills/${SKILL_ID}?tab=governance`);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    expect(await screen.findByRole('group', { name: 'Next steps' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Governance' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Validation' }));
    await waitFor(() => expect(window.location.search).toContain('tab=validation'));
    expect(await screen.findByRole('group', { name: 'Recorded runs' })).toBeInTheDocument();
  });

  it('describes the skill, its estimated benefit and where it came from, with hindsight kept apart', async () => {
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const about = await screen.findByRole('group', { name: 'About this skill' });
    expect(within(about).getByText('60%')).toBeInTheDocument();
    expect(
      within(about).getByText(/Microsoft Teams: failures are intermittent/),
    ).toBeInTheDocument();

    const benefit = screen.getByRole('group', { name: 'Expected benefit' });
    expect(within(benefit).getByText('Estimated')).toBeInTheDocument();
    expect(within(benefit).getByText('Simulated')).toBeInTheDocument();

    const origin = screen.getByRole('group', { name: 'Where it came from' });
    const hindsight = within(origin).getByRole('group', { name: 'Derived with hindsight' });
    expect(
      within(hindsight).getByText(/derived with knowledge of the recorded resolution/),
    ).toBeInTheDocument();
    expect(within(hindsight).getByText('triggerConditions.trg-dns')).toBeInTheDocument();
    expect(within(origin).getByText('triggerConditions.trg-intermittent')).toBeInTheDocument();
    expect(screen.getAllByText(SYNTHETIC_EFFECTIVENESS_NOTICE).length).toBeGreaterThan(0);
  });

  it('shows the decision-time probability and the hindsight one in separate blocks', async () => {
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const detail = await screen.findByRole('group', { name: 'The skill in detail' });
    expect(
      within(detail).getByText(/Decision-time estimate: 20% that this outcome occurs/),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText('Hindsight estimate (uses the recorded cause)'),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(/87% given the recorded root cause of the source case/),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(
        /does not count towards a match or towards the steps the skill recommends/,
      ),
    ).toBeInTheDocument();
    expect(within(detail).queryByText(/never used to match/)).toBeNull();
    expect(within(detail).getAllByText('Learned with hindsight')).toHaveLength(1);
  });

  it('says so when the skill does not exist', async () => {
    renderApp(<SkillDetailPage skillId="skl_missing" />, {
      api: api({
        'skills.get': () => {
          throw new ApiError({
            status: 404,
            code: 'not_found',
            title: 'Not found',
            message: 'Skill not found',
          });
        },
      }),
    });
    expect(await screen.findByText('We could not find that skill')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the SkillDNA Library' })).toHaveAttribute(
      'href',
      '/skills',
    );
  });

  it('shows an error with Retry and recovers', async () => {
    let attempts = 0;
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal',
              title: 'Internal error',
              message: 'Boom',
            });
          return skillDetail();
        },
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('The skill could not be loaded');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Skill lifecycle' })).toBeInTheDocument();
  });

  it('explains a role without skill access and asks for nothing', async () => {
    const fake = api({}, ['case:read']);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    expect(
      await screen.findByText('You do not have access to the SkillDNA Library'),
    ).toBeInTheDocument();
    expect(callsOf(fake, 'skills.get')).toHaveLength(0);
  });
});

describe('[FR-SK-04] Skill detail: governance', () => {
  const GOVERNANCE = `/skills/${SKILL_ID}?tab=governance`;

  it('lists the people involved, the next steps and every decision so far', async () => {
    navigateTo(GOVERNANCE);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const people = await screen.findByRole('group', { name: 'Who is involved' });
    expect(within(people).getByText('Created by')).toBeInTheDocument();
    // The reviewer is also the one who approved the pilot.
    expect(within(people).getAllByText('user_riley_reviewer')).toHaveLength(2);
    expect(within(people).getByText('user_alex_admin')).toBeInTheDocument();

    const next = screen.getByRole('group', { name: 'Next steps' });
    expect(within(next).getByRole('heading', { name: 'Move to Deprecated' })).toBeInTheDocument();
    expect(within(next).getByText('Available to you')).toBeInTheDocument();
    expect(within(next).getByText('Needs the skill:retire permission.')).toBeInTheDocument();

    const decisions = screen.getByRole('list', { name: 'Decisions in order' });
    expect(within(decisions).getAllByRole('listitem')).toHaveLength(3);
    expect(within(decisions).getByText('Moved to Draft by user_casey_curator')).toBeInTheDocument();
  });

  it('shows withdrawing a skill as "Withdrawn", never as "Rejected"', async () => {
    navigateTo(GOVERNANCE);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({ lifecycle: 'deprecated' }),
            proposedVersion: null,
            approvals: [
              ...lifecycleApprovals(),
              skillApproval({
                id: 'skp_9',
                fromState: 'published',
                toState: 'deprecated',
                decision: 'rejected',
                approver: 'user_ava_engineer',
                reason: 'Replaced by a newer approach.',
              }),
            ],
            transitions: [transitionOption({ toState: 'retired' })],
          }),
      }),
    });
    const decisions = await screen.findByRole('list', { name: 'Decisions in order' });
    expect(
      within(decisions).getByText('Withdrawn (deprecated) by user_ava_engineer'),
    ).toBeInTheDocument();
    expect(within(decisions).getByText('Withdrawn (deprecated)')).toBeInTheDocument();
    expect(within(decisions).queryByText(/rejected/i)).toBeNull();
    expect(within(decisions).getByText('Replaced by a newer approach.')).toBeInTheDocument();
  });

  it('withdraws a skill only after a reason, and sends the version the person saw', async () => {
    navigateTo(GOVERNANCE);
    const fake = api({
      'skills.transition': () =>
        skillDetail({ skill: skillDna({ lifecycle: 'deprecated', version: 10 }) }),
    });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const button = await screen.findByRole('button', { name: 'Withdraw: Deprecated' });
    const dialog = await openDialog(button, 'Deprecate this skill?');
    expect(within(dialog).getByText(/no longer offered for new matches/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw as Deprecated' }));
    expect(within(dialog).getByText('Enter at least 5 characters.')).toBeInTheDocument();
    expect(callsOf(fake, 'skills.transition')).toHaveLength(0);

    await reasonAndConfirm(dialog, 'Replaced by a newer approach', 'Withdraw as Deprecated');
    await waitFor(() =>
      expect(callsOf(fake, 'skills.transition')[0]).toMatchObject({
        params: { skillId: SKILL_ID },
        body: { toState: 'deprecated', reason: 'Replaced by a newer approach', expectedVersion: 9 },
      }),
    );
    expect((await screen.findAllByText('Skill moved to Deprecated')).length).toBeGreaterThan(0);
  });

  it('explains why a step is not available and does not open the dialog', async () => {
    navigateTo(GOVERNANCE);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({ lifecycle: 'validated' }),
            transitions: [
              transitionOption({
                toState: 'published',
                allowed: false,
                reason: 'Publication needs someone other than the creator and the pilot approver.',
                requiresDistinctApprover: true,
                requiredPermission: 'skill:publish',
                gate: 'The current content needs a passed full simulation test and regression run.',
              }),
            ],
          }),
      }),
    });
    const next = await screen.findByRole('group', { name: 'Next steps' });
    expect(within(next).getByText('Not available')).toBeInTheDocument();
    expect(within(next).getByText('Needs a different person')).toBeInTheDocument();
    expect(
      within(next).getByText(/The current content needs a passed full simulation test/),
    ).toBeInTheDocument();
    expect(
      within(next).getByText(/Publication needs someone other than the creator/),
    ).toBeInTheDocument();
    const button = within(next).getByRole('button', { name: 'Move to Published' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('explains the four-eyes rule in plain words when the API refuses a step', async () => {
    navigateTo(GOVERNANCE);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({ lifecycle: 'validated' }),
            transitions: [
              transitionOption({
                toState: 'published',
                requiresDistinctApprover: true,
                requiredPermission: 'skill:publish',
              }),
            ],
          }),
        'skills.transition': () => {
          throw new ApiError({
            status: 403,
            code: 'forbidden',
            reason: 'separation_of_duties',
            title: 'Forbidden',
            message:
              'The approver must differ from the creator of the skill and the pilot approver.',
          });
        },
      }),
    });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Move to Published' }),
      'Move this skill to Published?',
    );
    expect(within(dialog).getByText(/always a human decision/)).toBeInTheDocument();
    await reasonAndConfirm(dialog, 'Ready for every case', 'Move to Published');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('the four-eyes rule');
    expect(alert).toHaveTextContent(
      'The approver must differ from the creator of the skill and the pilot approver.',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('does not take a 403 for a four-eyes refusal unless the API says so with its reason', async () => {
    navigateTo(GOVERNANCE);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.transition': () => {
          throw new ApiError({
            status: 403,
            code: 'forbidden',
            title: 'Forbidden',
            // The wording alone proves nothing: only the reason token marks a four-eyes refusal.
            message: 'The approver must differ from the creator of the skill.',
          });
        },
      }),
    });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Withdraw: Deprecated' }),
      'Deprecate this skill?',
    );
    await reasonAndConfirm(dialog, 'Replaced by a newer approach', 'Withdraw as Deprecated');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Your role does not include the permission this step needs');
    expect(alert).not.toHaveTextContent('four-eyes');
  });

  it('refreshes the page and explains an illegal step when the skill has already moved on', async () => {
    navigateTo(GOVERNANCE);
    const fake = api({
      'skills.transition': () => {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          reason: 'illegal_transition',
          title: 'Conflict',
          message: 'A published skill cannot move to Deprecated from here.',
        });
      },
    });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Withdraw: Deprecated' }),
      'Deprecate this skill?',
    );
    const before = callsOf(fake, 'skills.get').length;
    await reasonAndConfirm(dialog, 'Replaced by a newer approach', 'Withdraw as Deprecated');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('has already moved on');
    expect(alert).toHaveTextContent(
      'The API said: A published skill cannot move to Deprecated from here.',
    );
    await waitFor(() => expect(callsOf(fake, 'skills.get').length).toBeGreaterThan(before));
  });

  it('explains a refused gate with the rule about approvals and full runs', async () => {
    navigateTo(GOVERNANCE);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({ lifecycle: 'validated' }),
            transitions: [
              transitionOption({ toState: 'published', requiredPermission: 'skill:publish' }),
            ],
          }),
        'skills.transition': () => {
          throw new ApiError({
            status: 412,
            code: 'precondition_failed',
            reason: 'gate_failed',
            title: 'Precondition failed',
            message: 'A full regression suite has not been run for version 1.0.0.',
          });
        },
      }),
    });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Move to Published' }),
      'Move this skill to Published?',
    );
    await reasonAndConfirm(dialog, 'Ready for every case', 'Move to Published');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('The step is blocked until its requirement holds.');
    expect(alert).toHaveTextContent(
      'A run on one case does not satisfy the gate: only a full run counts.',
    );
    expect(alert).toHaveTextContent(
      'The API said: A full regression suite has not been run for version 1.0.0.',
    );
  });

  it('refreshes the page when someone else changed the skill first', async () => {
    navigateTo(GOVERNANCE);
    const fake = api({
      'skills.transition': () => {
        throw new ApiError({
          status: 409,
          code: 'version_conflict',
          title: 'Conflict',
          message: 'The record was changed by someone else.',
        });
      },
    });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Withdraw: Deprecated' }),
      'Deprecate this skill?',
    );
    const before = callsOf(fake, 'skills.get').length;
    await reasonAndConfirm(dialog, 'Replaced by a newer approach', 'Withdraw as Deprecated');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The record was changed after you opened it',
    );
    await waitFor(() => expect(callsOf(fake, 'skills.get').length).toBeGreaterThan(before));
  });

  it('disables every step, with the reason, for a role that cannot review skills', async () => {
    navigateTo(GOVERNANCE);
    const fake = api({}, READER);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const button = await screen.findByRole('button', { name: 'Withdraw: Deprecated' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(/does not include the "skill:review" permission/);
    await userEvent.click(button);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(callsOf(fake, 'skills.transition')).toHaveLength(0);
  });
});

describe('[FR-SK-05] Skill detail: versions, proposals and rollback', () => {
  const VERSIONS = `/skills/${SKILL_ID}?tab=versions`;

  it('shows the proposed change with its checks and who may decide', async () => {
    navigateTo(VERSIONS);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const panel = await screen.findByRole('group', { name: 'Proposed version 1.1.0' });
    expect(within(panel).getByText('Waiting for a decision')).toBeInTheDocument();
    expect(within(panel).getByText(/Proposed from CG-SYN-1002/)).toBeInTheDocument();
    expect(within(panel).getByText(/Proposed by user_casey_curator/)).toBeInTheDocument();
    const checks = within(panel).getByRole('list', { name: 'Validations of the proposed version' });
    expect(checks).toHaveTextContent(/Simulation test:.*Inconclusive.*one case only/);
    expect(checks).toHaveTextContent(/Regression suite:.*Not run/);
    expect(
      within(panel).getByText(/Approval needs someone other than user_ava_engineer/),
    ).toBeInTheDocument();
  });

  it('approves the proposed version only after a reason', async () => {
    navigateTo(VERSIONS);
    const fake = api({ 'skills.versionDecision': () => skillDetail({ proposedVersion: null }) });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Approve version 1.1.0' }),
      'Approve version 1.1.0?',
    );
    expect(
      within(dialog).getByText(/previous version is kept in the history and can be restored/),
    ).toBeInTheDocument();
    await reasonAndConfirm(dialog, 'The new trigger is well supported', 'Approve');
    await waitFor(() =>
      expect(callsOf(fake, 'skills.versionDecision')[0]).toMatchObject({
        params: { skillId: SKILL_ID, versionId: 'skv_2' },
        body: {
          decision: 'approve',
          reason: 'The new trigger is well supported',
          expectedVersion: 9,
        },
      }),
    );
    expect((await screen.findAllByText('Version 1.1.0 approved')).length).toBeGreaterThan(0);
  });

  it('rejects the proposed version with a reason, leaving the current one', async () => {
    navigateTo(VERSIONS);
    const fake = api({ 'skills.versionDecision': () => skillDetail({ proposedVersion: null }) });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Reject version 1.1.0' }),
      'Reject version 1.1.0?',
    );
    await reasonAndConfirm(dialog, 'Not enough evidence yet', 'Reject');
    await waitFor(() =>
      expect(callsOf(fake, 'skills.versionDecision')[0]).toMatchObject({
        body: { decision: 'reject', reason: 'Not enough evidence yet', expectedVersion: 9 },
      }),
    );
  });

  it('does not let people approve a change they proposed, and says why', async () => {
    navigateTo(VERSIONS);
    const own = proposedVersion({ createdBy: 'user_skill_curator' });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            proposedVersion: own,
            versions: [versionSummary(skillVersion()), versionSummary(own)],
          }),
      }),
    });
    const approve = await screen.findByRole('button', { name: 'Approve version 1.1.0' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).toHaveAccessibleDescription(
      /someone else must approve it \(the four-eyes rule\)/,
    );
    // Rejecting a proposal needs only a reason.
    expect(screen.getByRole('button', { name: 'Reject version 1.1.0' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows the four-eyes refusal from the API in the dialog', async () => {
    navigateTo(VERSIONS);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.versionDecision': () => {
          throw new ApiError({
            status: 403,
            code: 'forbidden',
            reason: 'separation_of_duties',
            title: 'Forbidden',
            message:
              'The approver must differ from the creator of the skill and the author of the proposal.',
          });
        },
      }),
    });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Approve version 1.1.0' }),
      'Approve version 1.1.0?',
    );
    await reasonAndConfirm(dialog, 'Looks right to me', 'Approve');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /four-eyes rule.*The approver must differ/,
    );
  });

  it('shows a plain-language diff between the current and the proposed version', async () => {
    navigateTo(VERSIONS);
    const fake = api();
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const summary = await screen.findByRole('list', { name: 'Summary of the changes' });
    expect(within(summary).getByText('2 changes between 1.0.0 and 1.1.0.')).toBeInTheDocument();
    expect(callsOf(fake, 'skills.diff')[0]).toMatchObject({
      params: { skillId: SKILL_ID },
      query: { fromVersionId: 'skv_1', toVersionId: 'skv_2' },
    });
    const triggers = screen.getByRole('region', { name: 'Trigger conditions' });
    expect(within(triggers).getByText('Added')).toBeInTheDocument();
    const confidence = screen.getByRole('region', { name: 'Confidence' });
    expect(within(confidence).getByText('Changed')).toBeInTheDocument();
    expect(within(confidence).getByText('Before')).toBeInTheDocument();
    expect(within(confidence).getByText('0.7')).toBeInTheDocument();
  });

  it('compares the two versions named in the address', async () => {
    navigateTo(`${VERSIONS}&from=skv_2&to=skv_1`);
    const fake = api();
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    await screen.findByRole('list', { name: 'Summary of the changes' });
    expect(callsOf(fake, 'skills.diff')[0]).toMatchObject({
      query: { fromVersionId: 'skv_2', toVersionId: 'skv_1' },
    });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'To' }), 'skv_2');
    expect(
      await screen.findByText('Choose two different versions to compare.'),
    ).toBeInTheDocument();
  });

  it('says when two versions have the same content', async () => {
    navigateTo(VERSIONS);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({ 'skills.diff': () => skillDiff({ changes: [], summaryLines: [] }) }),
    });
    expect(
      await screen.findByText('These two versions have the same content.'),
    ).toBeInTheDocument();
  });

  it('lists every version, newest first, and marks the current one', async () => {
    navigateTo(VERSIONS);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const history = await screen.findByRole('list', { name: 'Versions' });
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Version 1.1.0');
    expect(items[0]).toHaveTextContent('Proposed');
    expect(items[1]).toHaveTextContent('Version 1.0.0');
    expect(items[1]).toHaveTextContent('Current');
    expect(within(history).getAllByText('Current')).toHaveLength(1);
  });

  it('starts a proposal from another analysed case as a background job', async () => {
    navigateTo(VERSIONS);
    const fake = api({
      'skills.proposeMutation': () => ({
        job: finishedJob({
          id: 'job_9',
          kind: 'skill_mutation',
          resultRef: null,
          targetId: SKILL_ID,
        }),
      }),
      'jobs.get': () =>
        finishedJob({ id: 'job_9', kind: 'skill_mutation', resultRef: null, targetId: SKILL_ID }),
    });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const panel = await screen.findByRole('group', { name: 'Propose a change from another case' });
    // Only analysed cases the skill was not built from can be learned from.
    const choices = within(panel).getByRole('combobox', { name: 'Learn from this case' });
    await waitFor(() => expect(within(choices).getAllByRole('option')).toHaveLength(1));
    expect(within(choices).getByRole('option', { name: /CG-SYN-1002/ })).toBeInTheDocument();

    const dialog = await openDialog(
      within(panel).getByRole('button', { name: 'Propose a change' }),
      'Propose a change from this case?',
    );
    expect(within(dialog).getByText(/The current version does not change/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start the proposal' }));
    await waitFor(() =>
      expect(callsOf(fake, 'skills.proposeMutation')[0]).toMatchObject({
        params: { skillId: SKILL_ID },
        body: { sourceCaseId: OTHER_CASE_ID },
      }),
    );
    expect(
      await screen.findByRole('group', { name: 'Drafting a proposed version' }),
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText('A proposed version is ready for review')).length,
    ).toBeGreaterThan(0);
  });

  it('offers a rollback only to a version the current one was built from', async () => {
    navigateTo(VERSIONS);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const panel = await screen.findByRole('group', { name: 'Roll back to an earlier version' });
    const button = within(panel).getByRole('button', { name: 'Roll back' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(panel).getByText(/only a version the current one was built from can come back/),
    ).toBeInTheDocument();
  });

  describe('with an earlier version to restore', () => {
    const first = skillVersion({ id: 'skv_1', version: '1.0.0', sequence: 1, state: 'superseded' });
    const second = skillVersion({
      id: 'skv_2',
      version: '1.1.0',
      sequence: 2,
      parentVersionId: 'skv_1',
      state: 'active',
      changeType: 'mutation',
      lifecycleAtCreation: 'pilot',
    });
    const rollbackDetail = () =>
      skillDetail({
        skill: skillDna({ currentVersionId: 'skv_2', currentVersion: '1.1.0' }),
        currentVersion: second,
        proposedVersion: null,
        versions: [versionSummary(first), versionSummary(second)],
      });

    it('restores it by adding a new version, after a reason', async () => {
      navigateTo(VERSIONS);
      const fake = api({ 'skills.get': rollbackDetail, 'skills.rollback': rollbackDetail });
      renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
      const panel = await screen.findByRole('group', { name: 'Roll back to an earlier version' });
      expect(
        within(panel).getByRole('option', { name: 'Version 1.0.0 (Discovered when created)' }),
      ).toBeInTheDocument();
      const dialog = await openDialog(
        within(panel).getByRole('button', { name: 'Roll back' }),
        'Roll back to version 1.0.0?',
      );
      expect(within(dialog).getByText(/version 1\.1\.0 is kept as superseded/)).toBeInTheDocument();
      await reasonAndConfirm(dialog, 'The new trigger caused false matches', 'Roll back');
      await waitFor(() =>
        expect(callsOf(fake, 'skills.rollback')[0]).toMatchObject({
          params: { skillId: SKILL_ID },
          body: {
            toVersionId: 'skv_1',
            reason: 'The new trigger caused false matches',
            expectedVersion: 9,
          },
        }),
      );
      expect((await screen.findAllByText('Rolled back')).length).toBeGreaterThan(0);
    });

    it('explains in plain words which version a rollback can restore when its gate refuses', async () => {
      navigateTo(VERSIONS);
      renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
        api: api({
          'skills.get': rollbackDetail,
          'skills.rollback': () => {
            throw new ApiError({
              status: 412,
              code: 'precondition_failed',
              reason: 'gate_failed',
              title: 'Precondition failed',
              message:
                'Version 1.0.0 is not an earlier version of the current one: a rollback withdrew it.',
            });
          },
        }),
      });
      const panel = await screen.findByRole('group', { name: 'Roll back to an earlier version' });
      const dialog = await openDialog(
        within(panel).getByRole('button', { name: 'Roll back' }),
        'Roll back to version 1.0.0?',
      );
      await reasonAndConfirm(dialog, 'Back to the first version', 'Roll back');
      const alert = await within(dialog).findByRole('alert');
      expect(alert).toHaveTextContent('can only restore a version that was once approved');
      expect(alert).toHaveTextContent('has to be proposed again as a new version');
      // The step is a rollback, so the explanation is about versions, not about full runs.
      expect(alert).not.toHaveTextContent('one case');
      expect(alert).toHaveTextContent('The API said: Version 1.0.0 is not an earlier version');
    });
  });

  it('does not offer a new version, a rollback or an approval for a withdrawn skill', async () => {
    navigateTo(VERSIONS);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({ skill: skillDna({ lifecycle: 'retired' }), transitions: [] }),
      }),
    });
    const approve = await screen.findByRole('button', { name: 'Approve version 1.1.0' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).toHaveAccessibleDescription('A retired skill cannot take a new version.');
    expect(screen.getByRole('button', { name: 'Propose a change' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Roll back' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('[FR-SK-06] Skill detail: validation', () => {
  const VALIDATION = `/skills/${SKILL_ID}?tab=validation`;

  it('shows every run with its scope and explains that one case does not satisfy the gate', async () => {
    navigateTo(VALIDATION);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const notice = await screen.findByText('Only a full run counts');
    expect(notice).toBeInTheDocument();
    const runs = screen.getByRole('list', { name: 'Validation runs' });
    expect(within(runs).getAllByRole('heading', { level: 3 })).toHaveLength(3);
    expect(within(runs).getAllByText('Full run')).toHaveLength(2);
    expect(within(runs).getAllByText('One case only')).toHaveLength(1);
    expect(within(runs).getByText('Inconclusive')).toBeInTheDocument();
    expect(
      within(runs).getByText(
        /A run on one case does not satisfy the gate: its checks below are real/,
      ),
    ).toBeInTheDocument();
    expect(
      within(runs).getAllByText('The replay reached a confirmed diagnosis.', { exact: false }),
    ).toHaveLength(3);
    expect(within(runs).getByText(/version 1\.1\.0 \(proposed\)/)).toBeInTheDocument();
    expect(within(runs).getByText(/every case in the set/)).toBeInTheDocument();
  });

  it('treats a run recorded before scopes existed as a full run', async () => {
    navigateTo(VALIDATION);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({ validations: [skillValidation({ id: 'skval_old', scope: undefined })] }),
      }),
    });
    const runs = await screen.findByRole('list', { name: 'Validation runs' });
    expect(within(runs).getByText('Full run')).toBeInTheDocument();
    expect(within(runs).queryByText('One case only')).toBeNull();
  });

  it('says what is missing when nothing was validated yet', async () => {
    navigateTo(VALIDATION);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({ 'skills.get': () => skillDetail({ validations: [] }) }),
    });
    expect(await screen.findByText('No validation has been run')).toBeInTheDocument();
  });

  it('runs a full simulation test on the whole set after a confirmation', async () => {
    navigateTo(VALIDATION);
    const fake = api({ 'skills.simulationTest': () => skillValidation({ id: 'skval_9' }) });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Run simulation test' }),
      'Run the simulation test?',
    );
    expect(within(dialog).getByText(/on every case in its set/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/A full run can open or fail a lifecycle gate/),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run simulation test' }));
    await waitFor(() =>
      expect(callsOf(fake, 'skills.simulationTest')[0]).toEqual(
        expect.objectContaining({
          params: { skillId: SKILL_ID },
          body: { kind: 'simulation_test' },
        }),
      ),
    );
    expect((await screen.findAllByText('Simulation test passed')).length).toBeGreaterThan(0);
  });

  it('runs on one case only as informational, and says it does not satisfy the gate', async () => {
    navigateTo(VALIDATION);
    const fake = api({
      'skills.simulationTest': () =>
        skillValidation({ id: 'skval_9', scope: 'case', outcome: 'inconclusive' }),
    });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const select = await screen.findByRole('combobox', { name: 'Cases' });
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
    await userEvent.selectOptions(select, OTHER_CASE_ID);
    const dialog = await openDialog(
      screen.getByRole('button', { name: 'Run simulation test' }),
      'Run the simulation test?',
    );
    expect(within(dialog).getByText(/on the chosen case only/)).toBeInTheDocument();
    expect(within(dialog).getByText(/it does not satisfy a lifecycle gate/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run simulation test' }));
    await waitFor(() =>
      expect(callsOf(fake, 'skills.simulationTest')[0]).toMatchObject({
        body: { kind: 'simulation_test', caseId: OTHER_CASE_ID },
      }),
    );
    expect((await screen.findAllByText('Simulation test inconclusive')).length).toBeGreaterThan(0);
    expect(
      (
        await screen.findAllByText(
          'A run on one case does not satisfy the gate: only a full run counts.',
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('tests the proposed version when it is chosen, and runs the regression suite', async () => {
    navigateTo(VALIDATION);
    const fake = api({
      'skills.simulationTest': () => skillValidation({ id: 'skval_9', kind: 'regression' }),
    });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Version' }),
      'skv_2',
    );
    const dialog = await openDialog(
      screen.getByRole('button', { name: 'Run regression suite' }),
      'Run the regression suite?',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run regression suite' }));
    await waitFor(() =>
      expect(callsOf(fake, 'skills.simulationTest')[0]).toMatchObject({
        body: { kind: 'regression', versionId: 'skv_2' },
      }),
    );
  });

  it('shows what the API said when it refuses a run', async () => {
    navigateTo(VALIDATION);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.simulationTest': () => {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            title: 'Conflict',
            message:
              'There is no analysed, resolved case to replay the skill on. Analyse the skill’s source cases first.',
          });
        },
      }),
    });
    const dialog = await openDialog(
      await screen.findByRole('button', { name: 'Run simulation test' }),
      'Run the simulation test?',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run simulation test' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('It cannot be done from the current state.');
    expect(alert).toHaveTextContent('Analyse the skill’s source cases first.');
  });

  it('does not let a role without validation rights run a check', async () => {
    navigateTo(VALIDATION);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api({}, READER) });
    expect(await screen.findByRole('button', { name: 'Run simulation test' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Run regression suite' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

describe('[FR-SK-07] Skill detail: cases, effectiveness and applying a skill', () => {
  const CASES = `/skills/${SKILL_ID}?tab=cases`;

  it('shows effectiveness honestly: estimated, synthetic and never a win it did not earn', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const panel = await screen.findByRole('group', { name: 'Effectiveness' });
    expect(within(panel).getAllByText('Estimated').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('Demo data').length).toBeGreaterThan(0);
    const tiles = within(panel).getByRole('list', { name: 'Effectiveness' });
    expect(tiles).toHaveTextContent('Applications1');
    expect(tiles).toHaveTextContent('Plan followed (average)100%');
    // The simulated baseline is still shown, as the secondary comparison, with the figures it always had.
    expect(
      within(panel).getByText('3 h 03 min with the skill, longer than the 2 h 02 min baseline', {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('830% more tokens than the baseline', { exact: false }),
    ).toBeInTheDocument();
    expect(within(panel).getByText(SYNTHETIC_EFFECTIVENESS_NOTICE)).toBeInTheDocument();
    expect(within(panel).getByText(/Estimated from 1 recorded application/)).toBeInTheDocument();
  });

  it('headlines the like-for-like comparison with the case the skill came from, estimated', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const headline = await screen.findByRole('group', {
      name: 'Against the case the skill came from',
    });
    expect(
      within(headline).getByText(
        'Compared with CG-SYN-1001: 183 min vs 2,994 min to diagnosis; tokens -79.5%; evidence unchanged; 1 application.',
      ),
    ).toBeInTheDocument();
    expect(within(headline).getByText('Estimated')).toBeInTheDocument();
    // The wording of the basis is the API's, word for word.
    expect(within(headline).getByText(PRECEDENT_BASIS)).toBeInTheDocument();
    expect(
      within(headline).getByText(/with the skill first, then on that case’s recorded path/),
    ).toBeInTheDocument();
  });

  it('keeps the simulated baseline secondary, after the headline, with its caveat', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const headline = await screen.findByRole('group', {
      name: 'Against the case the skill came from',
    });
    const secondary = screen.getByRole('group', {
      name: 'Secondary: against a simulated baseline',
    });
    expect(
      headline.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(secondary).getByText('Simulated')).toBeInTheDocument();
    expect(
      within(secondary).getByText(
        '3 h 03 min with the skill, longer than the 2 h 02 min baseline',
        {
          exact: false,
        },
      ),
    ).toBeInTheDocument();
    expect(
      within(secondary).getByText('830% more tokens than the baseline', { exact: false }),
    ).toBeInTheDocument();
    expect(
      within(secondary).getByText(/has no waiting between steps, so a recorded time reads longer/),
    ).toBeInTheDocument();
    expect(
      within(secondary).getByText(/The comparison above is the like-for-like one/),
    ).toBeInTheDocument();
    // The headline never carries the simulated figures, and the secondary block never carries the precedent's.
    expect(within(headline).queryByText(/baseline/i)).toBeNull();
    expect(within(secondary).queryByText(/2,994/)).toBeNull();
    // The API's own notes stay, including the one that names both bases.
    expect(screen.getByRole('list', { name: 'Notes on the figures' })).toHaveTextContent(
      TWO_BASES_NOTE,
    );
  });

  it('says "Not measured" for a precedent figure the API could not measure, and never invents one', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({
              effectiveness: skillEffectiveness({
                precedent: skillPrecedent({
                  avgTimeToDiagnosisMinutes: null,
                  precedentAvgTimeToDiagnosisMinutes: null,
                  tokenChangePct: null,
                  evidenceCompletenessPoints: null,
                }),
              }),
            }),
          }),
      }),
    });
    const headline = await screen.findByRole('group', {
      name: 'Against the case the skill came from',
    });
    expect(
      within(headline).getByText(
        'Compared with CG-SYN-1001: time to diagnosis: Not measured; tokens: Not measured; evidence: Not measured; 1 application.',
      ),
    ).toBeInTheDocument();
    expect(headline).not.toHaveTextContent(/\bNaN\b|\b0 min\b|\b0%/);
  });

  it('names every case the skill came from, and says when only some applications were compared', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({
              effectiveness: skillEffectiveness({
                applications: 3,
                precedent: skillPrecedent({
                  cases: 2,
                  references: ['CG-SYN-1001', 'CG-SYN-1004'],
                  tokenChangePct: 12.3,
                  evidenceCompletenessPoints: 5,
                }),
              }),
            }),
          }),
      }),
    });
    const headline = await screen.findByRole('group', {
      name: 'Against the cases the skill came from',
    });
    expect(
      within(headline).getByText(
        'Compared with CG-SYN-1001 and CG-SYN-1004: 183 min vs 2,994 min to diagnosis; tokens +12.3%; evidence +5 points; 2 of 3 applications.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps today’s presentation when the API sent no precedent, and still says the baseline has no waiting', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({
              effectiveness: skillEffectiveness({
                precedent: undefined,
                notes: [
                  'Estimated from 1 recorded application; figures are model estimates, not measurements.',
                  '1 application is on the case the skill came from and is not compared with that case’s own recorded path.',
                ],
              }),
            }),
          }),
      }),
    });
    const panel = await screen.findByRole('group', { name: 'Effectiveness' });
    expect(
      screen.queryByRole('group', { name: /Against the cases? the skill came from/ }),
    ).toBeNull();
    expect(
      screen.queryByRole('group', { name: /Secondary: against a simulated baseline/ }),
    ).toBeNull();
    expect(within(panel).queryByText(/Compared with CG-SYN/)).toBeNull();
    expect(
      within(panel).getByText('3 h 03 min with the skill, longer than the 2 h 02 min baseline', {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('830% more tokens than the baseline', { exact: false }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/has no waiting between steps, so a recorded time reads longer/),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/like-for-like/)).toBeNull();
    expect(
      within(panel).getByText(/is on the case the skill came from and is not compared/),
    ).toBeInTheDocument();
  });

  it('keeps today’s presentation when the precedent compared no application at all', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({
              effectiveness: skillEffectiveness({ precedent: skillPrecedent({ cases: 0 }) }),
            }),
          }),
      }),
    });
    await screen.findByRole('group', { name: 'Effectiveness' });
    expect(
      screen.queryByRole('group', { name: /Against the cases? the skill came from/ }),
    ).toBeNull();
  });

  it('does not caveat a baseline figure that does not exist', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({
            skill: skillDna({
              effectiveness: skillEffectiveness({
                applications: 0,
                matchedCases: 0,
                avgTimeToDiagnosisMinutes: null,
                baselineAvgTimeToDiagnosisMinutes: null,
                conformanceAvg: null,
                estimatedTokenSavingsPct: null,
                precedent: undefined,
                notes: ['No applications recorded yet.'],
              }),
            }),
          }),
      }),
    });
    const panel = await screen.findByRole('group', { name: 'Effectiveness' });
    expect(within(panel).getAllByText(/Not enough data/)).toHaveLength(2);
    expect(within(panel).queryByText(/has no waiting between steps/)).toBeNull();
  });

  it('lists the cases the skill matched, linking to their review', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
    const list = await screen.findByRole('list', { name: 'Matched cases' });
    expect(within(list).getByRole('link', { name: 'CG-SYN-1002' })).toHaveAttribute(
      'href',
      `/cases/${OTHER_CASE_ID}/quality?tab=skills`,
    );
    expect(within(list).getByText('Applied')).toBeInTheDocument();
    expect(within(list).getByText('Match score 75% (estimate)')).toBeInTheDocument();
  });

  it('applies the skill to a chosen analysed case after a confirmation', async () => {
    navigateTo(CASES);
    const fake = api({
      'skills.apply': () =>
        skillMatch({
          applied: true,
          appliedAt: '2026-04-15T09:00:00Z',
          appliedBy: 'user_skill_curator',
        }),
    });
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: fake });
    const panel = await screen.findByRole('group', { name: 'Apply to a case' });
    const select = within(panel).getByRole('combobox', { name: 'Case' });
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    expect(within(select).queryByRole('option', { name: /CG-SYN-1003/ })).toBeNull();
    await userEvent.selectOptions(select, OTHER_CASE_ID);

    const dialog = await openDialog(
      within(panel).getByRole('button', { name: 'Apply to this case' }),
      'Apply this skill to the case?',
    );
    expect(
      within(dialog).getByText(/does not run anything or change the case/),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply skill' }));
    await waitFor(() =>
      expect(callsOf(fake, 'skills.apply')[0]).toMatchObject({
        params: { caseId: OTHER_CASE_ID },
        body: { skillId: SKILL_ID },
      }),
    );
    const recorded = await screen.findByRole('list', { name: 'The match that was recorded' });
    expect(within(recorded).getByText(/Applied 15 Apr 2026, 09:00 UTC by you/)).toBeInTheDocument();
    expect(within(recorded).getByText('Estimated match')).toBeInTheDocument();
  });

  it('explains the recomputation limit and shows how long to wait when applying is throttled', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.apply': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            message:
              'Too many views were recomputed in a short time. Views already computed stay available; retry shortly.',
            retryAfterMs: 7000,
          });
        },
      }),
    });
    const panel = await screen.findByRole('group', { name: 'Apply to a case' });
    await waitFor(() => expect(within(panel).getAllByRole('option').length).toBeGreaterThan(0));
    const dialog = await openDialog(
      within(panel).getByRole('button', { name: 'Apply to this case' }),
      'Apply this skill to the case?',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply skill' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('limits how many of those it does in a short time');
    expect(alert).toHaveTextContent('Try again in 7 seconds');
  });

  it('says a withdrawn skill can no longer be applied', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({
        'skills.get': () =>
          skillDetail({ skill: skillDna({ lifecycle: 'deprecated' }), transitions: [] }),
      }),
    });
    const panel = await screen.findByRole('group', { name: 'Apply to a case' });
    expect(within(panel).getByRole('button', { name: 'Apply to this case' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      within(panel).getByText('A deprecated skill can no longer be applied.'),
    ).toBeInTheDocument();
  });

  it('says plainly when no case has matched yet', async () => {
    navigateTo(CASES);
    renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
      api: api({ 'skills.get': () => skillDetail({ matches: [] }) }),
    });
    expect(await screen.findByText('No case has matched this skill')).toBeInTheDocument();
  });
});

const MOMENT = '2026-03-09T12:30:00Z';
const LATER_MOMENT = '2026-03-10T08:55:00Z';
const NEVER = (): Promise<never> => new Promise<never>(() => undefined);

/** A case's SkillDNA tab with buttons that move its boundary, as the case page's time cursor does. */
function Moments({
  initial = null,
  ready = true,
  onWholeRecord,
}: {
  initial?: string | null;
  ready?: boolean;
  onWholeRecord?: () => void;
}) {
  const [asOf, setAsOf] = useState<string | null>(initial);
  return (
    <>
      <button type="button" onClick={() => setAsOf(MOMENT)}>
        Choose an earlier moment
      </button>
      <button type="button" onClick={() => setAsOf(LATER_MOMENT)}>
        Choose a later moment
      </button>
      <button type="button" onClick={() => setAsOf(null)}>
        Choose the whole record
      </button>
      <CaseSkillMatches
        caseId="case_1"
        asOf={asOf}
        ready={ready}
        {...(onWholeRecord ? { onWholeRecord } : {})}
      />
    </>
  );
}

describe('[FR-SK-09] The skills that fit a case, at a moment', () => {
  it('shows none of the matches of the whole record while the matches of an earlier moment load', async () => {
    const fake = api({
      'skillMatches.list': (input) =>
        (input as { query: { asOf?: string } }).query.asOf ? NEVER() : { items: [skillMatch()] },
    });
    renderApp(<Moments />, { api: fake });
    expect(await screen.findByRole('heading', { name: NAME })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Choose an earlier moment' }));

    // The fit of a skill to the whole record says nothing about this moment: it is gone, and the panel is busy.
    await waitFor(() => expect(screen.queryByRole('heading', { name: NAME })).toBeNull());
    const loading = await screen.findByText('Loading SkillDNA matches…');
    expect(loading.closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText('Decision-time matching')).toBeInTheDocument();
    expect(screen.queryByText('No skill fits this case')).toBeNull();
  });

  it('shows none of the matches of one moment under another', async () => {
    const fake = api({
      'skillMatches.list': (input) =>
        (input as { query: { asOf?: string } }).query.asOf === MOMENT
          ? { items: [skillMatch()] }
          : NEVER(),
    });
    renderApp(<Moments initial={MOMENT} />, { api: fake });
    expect(await screen.findByRole('heading', { name: NAME })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Choose a later moment' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: NAME })).toBeNull());
    expect(await screen.findByText('Loading SkillDNA matches…')).toBeInTheDocument();

    // The moment that was already answered comes back from the cache at once.
    await userEvent.click(screen.getByRole('button', { name: 'Choose an earlier moment' }));
    expect(await screen.findByRole('heading', { name: NAME })).toBeInTheDocument();
  });

  it('asks for an earlier moment without hidden retries, and keeps its window fresh', async () => {
    const fake = api({ 'skillMatches.list': () => ({ items: [skillMatch()] }) });
    const { queryClient } = renderApp(<Moments initial={MOMENT} />, { api: fake });
    await screen.findByRole('heading', { name: NAME });

    const reads = callsOf(fake, 'skillMatches.list') as {
      query: { asOf?: string };
      maxRetries?: number;
    }[];
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ query: { asOf: MOMENT }, maxRetries: 0 });
    const cached = queryClient
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey[2] === 'skillMatches.list');
    expect(cached?.observers[0]?.options.staleTime).toBe(AS_OF_STALE_MS);
  });

  it('reads the whole record on the usual terms', async () => {
    const fake = api({ 'skillMatches.list': () => ({ items: [skillMatch()] }) });
    renderApp(<Moments />, { api: fake });
    await screen.findByRole('heading', { name: NAME });
    const reads = callsOf(fake, 'skillMatches.list') as { query: object; maxRetries?: number }[];
    expect(reads[0]?.maxRetries).toBeUndefined();
    expect(reads[0]?.query).toEqual({});
  });

  it('does not ask for an earlier moment before the cursor knows the case’s event instants', async () => {
    const fake = api({ 'skillMatches.list': () => ({ items: [skillMatch()] }) });
    renderApp(<Moments initial={MOMENT} ready={false} />, { api: fake });
    expect(await screen.findByText('Loading SkillDNA matches…')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(callsOf(fake, 'skillMatches.list')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: NAME })).toBeNull();
  });

  it('says calmly that an earlier moment could not be computed just now, with the wait and a way out', async () => {
    const onWholeRecord = vi.fn();
    renderApp(<Moments initial={MOMENT} onWholeRecord={onWholeRecord} />, {
      api: api({
        'skillMatches.list': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            message:
              'Too many views were recomputed in a short time. Views already computed stay available; retry shortly.',
            retryAfterMs: 30_000,
          });
        },
      }),
    });
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(
      screen.getByText(/so the SkillDNA matches could not be computed for this moment just now/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry in \d+ s/ })).toBeDisabled();
    expect(screen.queryByText('Too many requests right now')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show the whole record' }));
    expect(onWholeRecord).toHaveBeenCalledTimes(1);
  });

  it(
    'has no accessibility violations while it loads and when it is refused',
    async () => {
      const { container, unmount } = renderApp(<Moments initial={MOMENT} ready={false} />, {
        api: api(),
      });
      await screen.findByText('Loading SkillDNA matches…');
      await expectNoAxeViolations(container);
      unmount();

      const refused = renderApp(<Moments initial={MOMENT} onWholeRecord={() => undefined} />, {
        api: api({
          'skillMatches.list': () => {
            throw new ApiError({
              status: 429,
              code: 'rate_limited',
              reason: 'engine_budget',
              title: 'Too many requests',
              retryAfterMs: 30_000,
            });
          },
        }),
      });
      await screen.findByText('Earlier views are limited');
      await expectNoAxeViolations(refused.container);
    },
    AXE_TIMEOUT,
  );
});

describe('[FR-SK-08] Skill pages accessibility', () => {
  it.each(['overview', 'governance', 'versions', 'validation', 'cases'])(
    'has no axe violations on the %s tab in light mode',
    async (tab) => {
      navigateTo(`/skills/${SKILL_ID}?tab=${tab}`);
      const { container } = renderApp(<SkillDetailPage skillId={SKILL_ID} />, { api: api() });
      await screen.findByRole('tabpanel');
      await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
      await expectNoAxeViolations(container);
    },
    AXE_TIMEOUT,
  );

  it.each(['overview', 'versions', 'cases'])(
    'has no axe violations on the %s tab in dark mode',
    async (tab) => {
      navigateTo(`/skills/${SKILL_ID}?tab=${tab}`);
      const { container } = renderApp(<SkillDetailPage skillId={SKILL_ID} />, {
        api: api(),
        mode: 'dark',
      });
      await screen.findByRole('tabpanel');
      await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
      await expectNoAxeViolations(container);
    },
    AXE_TIMEOUT,
  );
});
