import { expect, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import {
  completedSteps,
  demoState,
  ensurePortfolioDemo,
  listCases,
  resetToBaseDemo,
  type Api,
  type CaseSummary,
} from './support/api';
import { PERSONAS, shortName, type PersonaKey } from './support/personas';
import {
  accountButton,
  mainRegion,
  navLink,
  openPage,
  settle,
  switchPersonaInUi,
} from './support/ui';
import {
  confirmDialog,
  confirmWithReason,
  ingestBuiltInSample,
  toast,
  waitUntilAnalysed,
} from './support/flows';

/**
 * FR-UX-06 and the spec's demo story, played through the UI with the persona the story names for each step, from an
 * empty workspace: Case One is imported and analysed, a better path is accepted, a SkillDNA is extracted and walked
 * through the governed lifecycle by four different people, Case Two is imported, the skill applies, and the outcomes are
 * compared. Every figure on screen is checked against what the API says, and the honest labels are checked on the way.
 */
test.describe.configure({ mode: 'serial' });

const SKILL_TITLE = 'Isolate a pre-authentication failure before pursuing identity policy';

interface Story {
  caseOne: CaseSummary;
  caseTwo: CaseSummary;
  skillId: string;
}
const story: Partial<Story> = {};
/** The ids the story has produced so far; a getter fails only when a step asks for something that does not exist yet. */
const ids = (): {
  readonly caseOneId: string;
  readonly caseTwoId: string;
  readonly skillId: string;
} => ({
  get caseOneId() {
    return story.caseOne!.id;
  },
  get caseTwoId() {
    return story.caseTwo!.id;
  },
  get skillId() {
    return story.skillId!;
  },
});

test.describe('[FR-UX-06] the whole story, persona by persona', () => {
  test.setTimeout(420_000);

  test.beforeAll(async () => {
    // Setup is done through the API, never through clicks: an empty workspace with the story at step 1.
    const state = await resetToBaseDemo();
    expect(completedSteps(state)).toBe(0);
    expect(state.steps).toHaveLength(13);
  });

  test.afterAll(async () => {
    // Leave the known state (the seeded story) for the specs that run after this one. `E2E_KEEP_STATE=1` skips it while
    // developing a spec, to see what the story left behind.
    if (process.env.E2E_KEEP_STATE === '1') return;
    await resetToBaseDemo();
    await ensurePortfolioDemo();
  });

  test.describe('1. the presenter picks the engineer persona', () => {
    test.use({ persona: null });

    test('without an identity the shell asks for one; choosing Ava opens the workspace as an engineer', async ({
      page,
    }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose persona' })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Choose who you are acting as' }),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Choose persona' }).click();
      const dialog = page.getByRole('dialog', { name: 'Choose a development identity' });
      await expect(dialog.getByText(/synthetic and exist only for local demos/)).toBeVisible();
      for (const key of [
        'engineer',
        'reviewer',
        'manager',
        'curator',
        'admin',
        'otherTenant',
      ] as const) {
        await expect(
          dialog.getByRole('button', { name: new RegExp(`^${shortName(PERSONAS[key])}`) }),
        ).toBeVisible();
      }
      await dialog
        .getByRole('button', { name: new RegExp(`^${shortName(PERSONAS.engineer)}`) })
        .click();
      await expect(accountButton(page, PERSONAS.engineer)).toBeVisible();
      await settle(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
    });

    test('the honest labels are on every page from the start: synthetic data, development identity, model estimates', async ({
      page,
      api,
    }) => {
      await page.goto('/cases');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const banner = page.getByRole('banner');
      await expect(banner.getByText('Synthetic demo data').first()).toBeVisible();
      await expect(banner.getByText('Development identity').first()).toBeVisible();
      await expect(page.getByRole('contentinfo')).toContainText('model estimates');
      await expect(page.getByRole('contentinfo')).toContainText(
        'must not be used to rank, rate or discipline individual employees',
      );
      const state = await api('engineer').getOk<{
        provider: string;
        providerSimulated: boolean;
        notices: string[];
      }>('/demo/state');
      expect(state.provider).toBe('deterministic');
      expect(state.providerSimulated).toBe(true);
      expect(state.notices.join(' ')).toMatch(/deterministic offline engine/);
    });
  });

  test.describe('2. the engineer imports Case One and the timeline, ledger and hypotheses appear', () => {
    test.use({ persona: 'engineer' });

    test('Cases is empty; "Use a sample" opens the wizard; the sample is previewed, confirmed, created and analysed', async ({
      page,
    }) => {
      await openPage(page, '/cases');
      await expect(page.getByRole('heading', { name: 'No cases yet' })).toBeVisible();
      await page.getByRole('link', { name: 'Use a sample' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Ingest a case' })).toBeVisible();

      const caseOneId = await ingestBuiltInSample(page, 'CG-SYN-1001');
      story.caseOne = await waitUntilAnalysed(caseOneId);
      expect(story.caseOne.eventCount).toBe(31);
      expect(story.caseOne.qualityIndex).toBe(36);

      const state = await demoState();
      expect(state.caseOneId).toBe(caseOneId);
      expect(completedSteps(state), 'steps 1 to 5 are derived from the stored analysis').toBe(6);
    });

    test('the timeline reconstructs 31 events; the earliest meaningful fork is event e03; an event opens with its claims and evidence', async ({
      page,
    }) => {
      const { caseOneId } = ids();
      await openPage(page, `/cases/${caseOneId}/timeline`);
      await expect(page.getByText('Showing 31 of 31 events.')).toBeVisible();
      const events = page.getByRole('list', { name: /^Events, 31 shown/ });
      await expect(events).toBeVisible();
      // e03 is the first decision fork: the engineer's request for more information at 9 Mar 09:41 UTC.
      const detailsName = /^Details of Teams sign-in - information needed, 9 Mar 2026, 09:41 UTC/;
      const e03 = events
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: detailsName }) });
      await expect(e03).toHaveAttribute('aria-posinset', '3');
      await expect(e03).toContainText('Decision fork');
      await expect(e03).toContainText('Event e03');
      await e03.getByRole('button', { name: detailsName }).click();
      await settle(page);
      await expect(page).toHaveURL(/sel=e03/);
      await expect(mainRegion(page).getByText(/claim/i).first()).toBeVisible();
      // Time travel: the previous-event button moves the cursor and the page states what was withheld.
      await page.getByRole('button', { name: 'Previous event' }).click();
      await expect(page.getByText(/later events? (are )?withheld|withheld/i).first()).toBeVisible();
    });

    test('the evidence ledger classifies 61 claims into eight categories; a claim shows its classification and its source event', async ({
      page,
    }) => {
      const { caseOneId } = ids();
      await openPage(page, `/cases/${caseOneId}/evidence`);
      await expect(page.getByRole('button', { name: /^All categories 61/ })).toBeVisible();
      for (const category of [
        'Confirmed fact',
        'Customer-reported observation',
        'Engineer assumption',
        'Diagnostic evidence',
        'AI inference',
        'Conflicting evidence',
        'Missing evidence',
        'Simulated outcome',
      ]) {
        await expect(
          page.getByRole('button', { name: new RegExp(`^${category} \\d+`) }),
        ).toBeVisible();
      }
      const claims = page.getByRole('list', { name: /^Claims, 61 shown/ });
      // A claim that comes from an event cites it; a claim about missing evidence has no event to cite.
      const cited = claims
        .getByRole('article')
        .filter({ has: page.getByRole('link', { name: /^Event e\d+$/ }) })
        .first();
      await expect(cited).toBeVisible();
      await cited.getByRole('button', { name: /^Details of this claim/ }).click();
      await settle(page);
      await expect(page).toHaveURL(/sel=/);
      await expect(
        mainRegion(page)
          .getByText(/classif/i)
          .first(),
      ).toBeVisible();
    });

    test('the hypothesis arena shows nine competing hypotheses, the leading one as an estimate', async ({
      page,
    }) => {
      const { caseOneId } = ids();
      await openPage(page, `/cases/${caseOneId}/hypotheses`);
      const list = page.getByRole('list', { name: 'Hypotheses ranked by confidence' });
      await expect(list.getByRole('button')).toHaveCount(9);
      await expect(
        list.getByRole('button', { name: /^DNS resolution failure for sign-in endpoints/ }),
      ).toBeVisible();
      await expect(
        page
          .getByText(
            'Confidence values are model estimates produced from an authored knowledge pack. They are not statistical truth.',
          )
          .first(),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: /^Simulate a safer path from 9 Mar 2026, 09:41 UTC/ }),
      ).toBeVisible();
    });

    test('the counterfactual lab lists nine forks with the earliest meaningful one first, the temporal boundary and three simulated paths', async ({
      page,
    }) => {
      const { caseOneId } = ids();
      await openPage(page, `/cases/${caseOneId}/counterfactual`);
      const forks = page.getByRole('list', { name: 'Decision forks in time order' });
      await expect(forks.getByRole('button')).toHaveCount(9);
      await expect(forks.getByRole('button').first()).toContainText('Earliest meaningful');
      await expect(forks.getByRole('button').first()).toContainText('9 Mar 2026, 09:41 UTC');
      // The decision is judged on what was known then: later events are withheld, and the leak check says so.
      await expect(
        page.getByRole('img', {
          name: /events were known at the decision instant; \d+ later events were withheld/,
        }),
      ).toBeVisible();
      await expect(page.getByText(/Validity checks \(8 of 8 passed\)/)).toBeVisible();
      const strategies = page.getByRole('tablist', { name: 'Simulated path strategies' });
      await expect(strategies.getByRole('tab')).toHaveCount(3);
      await expect(strategies.getByRole('tab', { name: /^Balanced path/ })).toContainText(
        'Awaiting review',
      );
      // Actual and simulated paths are compared on one page, labelled as estimates.
      const compare = page.getByRole('tabpanel', { name: 'Compare paths' });
      await expect(compare.getByRole('heading', { name: 'What would have changed' })).toBeVisible();
      await expect(compare.getByText(/Simulated/).first()).toBeVisible();
      await expect(compare.getByText(/estimate/i).first()).toBeVisible();
      // Which evidence backs each step of the alternative is one tab away.
      await page.getByRole('tab', { name: 'Evidence behind each step' }).click();
      await settle(page);
      await expect(
        page
          .getByRole('tabpanel', { name: 'Evidence behind each step' })
          .getByText(/Simulated/)
          .first(),
      ).toBeVisible();
      // Hindsight stays in its own labelled panel, apart from the generated paths.
      await expect(
        page.getByRole('region', { name: 'Hindsight (not used to generate)' }),
      ).toBeVisible();
    });
  });

  test.describe('3. the reviewer accepts the better path; the engineer cannot', () => {
    test.describe('as the engineer', () => {
      test.use({ persona: 'engineer' });
      test('the accept and reject buttons are disabled, and extracting a skill waits for an accepted path', async ({
        page,
      }) => {
        const { caseOneId } = ids();
        await openPage(page, `/cases/${caseOneId}/counterfactual`);
        await page.getByRole('tab', { name: 'Review and SkillDNA' }).click();
        const panel = page.getByRole('tabpanel', { name: 'Review and SkillDNA' });
        await expect(panel.getByRole('button', { name: 'Accept this path' })).toBeDisabled();
        await expect(panel.getByRole('button', { name: 'Reject this path' })).toBeDisabled();
        await expect(panel.getByRole('button', { name: 'Extract SkillDNA' })).toBeDisabled();
      });
    });

    test.describe('as the reviewer', () => {
      test.use({ persona: 'reviewer' });
      test('accepting records the reviewer and the reason, and the API shows the scenario as confirmed', async ({
        page,
        api,
      }) => {
        const { caseOneId } = ids();
        await openPage(page, `/cases/${caseOneId}/counterfactual`);
        await page.getByRole('tab', { name: 'Review and SkillDNA' }).click();
        await page.getByRole('button', { name: 'Accept this path' }).click();
        await expect(
          confirmDialog(page).getByRole('heading', { name: 'Accept this simulated path?' }),
        ).toBeVisible();
        await confirmWithReason(
          page,
          'Accept path',
          'The balanced path asks for less and only uses what was known before the decision.',
        );
        await expect(toast(page, 'Path accepted')).toBeVisible();
        const panel = page.getByRole('tabpanel', { name: 'Review and SkillDNA' });
        await expect(panel.getByText(/Accepted/).first()).toBeVisible();
        await expect(panel.getByText(/The balanced path asks for less/)).toBeVisible();

        const scenarios = await api('reviewer').getOk<{
          items: { reviewState: string; strategy: string }[];
        }>(`/cases/${caseOneId}/counterfactuals`);
        expect(scenarios.items.filter((item) => item.reviewState === 'confirmed')).toHaveLength(1);
        expect(completedSteps(await demoState()), 'step 6 is now complete').toBe(7);
      });
    });
  });

  test.describe('4. the manager reads the quality score and the effort estimate', () => {
    test.use({ persona: 'manager' });
    test('the Case Quality Index and the avoidable support effort equal the API and carry their estimate labels', async ({
      page,
      api,
    }) => {
      const { caseOneId } = ids();
      const summary = (await listCases(api('manager'))).find((item) => item.id === caseOneId)!;
      expect(summary.qualityIndex).toBe(36);
      await openPage(page, `/cases/${caseOneId}/quality`);
      const panel = page.getByRole('tabpanel', { name: 'Quality index' });
      await expect(panel.getByRole('group', { name: 'Case Quality Index' })).toBeVisible();
      await expect(panel.getByText(/Model estimate from a rule-based analysis/)).toBeVisible();
      await expect(panel.getByRole('group', { name: 'Applied penalties' })).toBeVisible();

      await page.getByRole('tab', { name: 'Effort and metrics' }).click();
      await settle(page);
      const metrics = page.getByRole('tabpanel', { name: 'Effort and metrics' });
      await expect(metrics.getByText(/Avoidable Support Effort/i).first()).toBeVisible();
      await expect(metrics.getByText(/estimate/i).first()).toBeVisible();
      // The page says what the figure is not: a measurement.
      await expect(
        page
          .getByText(/not statistical truth|estimates?, not measurements|model estimate/i)
          .first(),
      ).toBeVisible();
      expect(summary.avoidableEffortPct).not.toBeNull();
      expect(summary.avoidableEffortPct!).toBeGreaterThan(0);
    });
  });

  test.describe('5. the engineer extracts a SkillDNA draft', () => {
    test.use({ persona: 'engineer' });
    test('extraction runs as a job and lands on the new skill, which starts as discovered and is not published', async ({
      page,
      api,
    }) => {
      const { caseOneId } = ids();
      await openPage(page, `/cases/${caseOneId}/counterfactual?tab=review`);
      await page.getByRole('button', { name: 'Extract SkillDNA' }).click();
      await page.waitForURL(/\/skills\/skl_/, { timeout: 120_000 });
      await settle(page);
      story.skillId = /\/skills\/(skl_[A-Za-z0-9]+)/.exec(page.url())![1];
      await expect(page.getByRole('heading', { level: 1, name: SKILL_TITLE })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Where this skill stands' })).toContainText(
        'Discovered',
      );
      await expect(page.getByRole('link', { name: 'CG-SYN-1001' }).first()).toBeVisible();

      const detail = await api('engineer').getOk<{
        skill: { lifecycle: string; createdBy: string };
      }>(`/skills/${story.skillId}`);
      expect(detail.skill.lifecycle).toBe('discovered');
      expect(detail.skill.createdBy).toBe(PERSONAS.engineer.id);
      expect(completedSteps(await demoState()), 'step 8 is complete').toBe(8);
    });
  });

  test.describe('6. the governed lifecycle: four different people, and nobody approves their own work', () => {
    const moveTo = async (page: Page, label: string, reason: string): Promise<void> => {
      const { skillId } = ids();
      await openPage(page, `/skills/${skillId}?tab=governance`);
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(
        confirmDialog(page).getByRole('heading', {
          name: new RegExp(`^${label.replace('Move to', 'Move this skill to')}\\?`),
        }),
      ).toBeVisible();
      await confirmWithReason(page, label, reason);
    };
    const runCheck = async (page: Page, button: string): Promise<void> => {
      const { skillId } = ids();
      await openPage(page, `/skills/${skillId}?tab=validation`);
      await page.getByRole('button', { name: button, exact: true }).click();
      await confirmWithReason(page, button);
      const runs = page.getByRole('group', { name: 'Recorded runs' });
      await expect(runs.getByText('Passed').first()).toBeVisible({ timeout: 120_000 });
      await expect(runs.getByText(/Full run/).first()).toBeVisible();
    };
    const lifecycleOf = async (api: (persona: PersonaKey) => Api): Promise<string> =>
      (await api('curator').getOk<{ skill: { lifecycle: string } }>(`/skills/${story.skillId}`))
        .skill.lifecycle;

    test.describe('the curator adopts the draft', () => {
      test.use({ persona: 'curator' });
      test('Move to Draft', async ({ page, api }) => {
        await moveTo(
          page,
          'Move to Draft',
          'Adopted as a draft after reading the extracted steps.',
        );
        await expect(toast(page, 'Skill moved to Draft')).toBeVisible();
        expect(await lifecycleOf(api)).toBe('draft');
      });
    });

    test.describe('the reviewer tests and reviews it', () => {
      test.use({ persona: 'reviewer' });
      test('a full simulation test passes, then Simulation Tested and Expert Reviewed', async ({
        page,
        api,
      }) => {
        await runCheck(page, 'Run simulation test');
        await moveTo(
          page,
          'Move to Simulation Tested',
          'The full simulation test passed on the source case.',
        );
        expect(await lifecycleOf(api)).toBe('simulation_tested');
        await moveTo(
          page,
          'Move to Expert Reviewed',
          'Reviewed the steps against the case and the evidence.',
        );
        expect(await lifecycleOf(api)).toBe('expert_reviewed');
      });
    });

    test.describe('the curator approves the pilot', () => {
      test.use({ persona: 'curator' });
      test('Move to Pilot', async ({ page, api }) => {
        await moveTo(page, 'Move to Pilot', 'Approved to be tried on a related case.');
        expect(await lifecycleOf(api)).toBe('pilot');
      });
    });

    test.describe('the reviewer validates', () => {
      test.use({ persona: 'reviewer' });
      test('a full regression run passes, then Validated', async ({ page, api }) => {
        await runCheck(page, 'Run regression suite');
        await moveTo(page, 'Move to Validated', 'The regression suite passed.');
        expect(await lifecycleOf(api)).toBe('validated');
      });
    });

    test('separation of duties: the creator, the pilot approver and the reviewer cannot publish (403), and the skill stays validated', async ({
      api,
    }) => {
      const detail = await api('admin').getOk<{ skill: { version: number } }>(
        `/skills/${story.skillId}`,
      );
      const publish = {
        toState: 'published',
        reason: 'e2e probe: must be refused',
        expectedVersion: detail.skill.version,
      };
      const curator = await api('curator').post(`/skills/${story.skillId}/transition`, publish);
      expect(curator.status).toBe(403);
      expect(curator.problem).toMatchObject({ code: 'forbidden', reason: 'separation_of_duties' });
      for (const persona of ['engineer', 'reviewer'] as const) {
        const refused = await api(persona).post(`/skills/${story.skillId}/transition`, publish);
        expect(refused.status, persona).toBe(403);
        expect(refused.problem?.code).toBe('forbidden');
      }
      expect(await lifecycleOf(api)).toBe('validated');
    });

    test.describe('a different administrator publishes', () => {
      test.use({ persona: 'admin' });
      test('Move to Published, with the decision recorded under the administrator’s name', async ({
        page,
        api,
      }) => {
        await moveTo(
          page,
          'Move to Published',
          'Published after the pilot and the regression run.',
        );
        await expect(toast(page, 'Skill published')).toBeVisible();
        expect(await lifecycleOf(api)).toBe('published');
        await expect(page.getByRole('group', { name: 'Where this skill stands' })).toContainText(
          'Published',
        );
        const detail = await api('admin').getOk<{
          approvals: { toState: string; approver: string }[];
          skill: { createdBy: string };
        }>(`/skills/${story.skillId}`);
        const decided = detail.approvals.filter((approval) =>
          ['expert_reviewed', 'pilot', 'published'].includes(approval.toState),
        );
        expect(
          new Set(decided.map((approval) => approval.approver)).size,
          'three different people',
        ).toBe(3);
        expect(decided.map((approval) => approval.approver)).not.toContain(detail.skill.createdBy);
        expect(completedSteps(await demoState()), 'step 9 is complete').toBe(9);
      });
    });
  });

  test.describe('7. the engineer imports Case Two and the published skill applies', () => {
    test.use({ persona: 'engineer' });

    test('Case Two is imported through the wizard and analysed', async ({ page }) => {
      const caseTwoId = await ingestBuiltInSample(page, 'CG-SYN-1002');
      story.caseTwo = await waitUntilAnalysed(caseTwoId);
      expect(story.caseTwo.eventCount).toBe(15);
      expect(story.caseTwo.qualityIndex).toBeCloseTo(99.1, 1);
      expect(story.caseTwo.avoidableEffortPct).toBe(0);
    });

    test('as of its first email the skill already applies, at about 0.75, and applying is offered only for the present', async ({
      page,
      api,
    }) => {
      const { caseTwoId } = ids();
      const timeline = await api('engineer').getOk<{ events: { timestamp: string }[] }>(
        `/cases/${caseTwoId}/timeline`,
        { query: { limit: 1 } },
      );
      const firstEmail = timeline.events[0]!.timestamp;
      const matches = await api('engineer').getOk<{
        items: { skillId: string; score: number; applicability: string }[];
      }>(`/cases/${caseTwoId}/skill-matches`, { query: { asOf: firstEmail } });
      const match = matches.items.find((item) => item.skillId === story.skillId);
      expect(match, 'the published skill matches as of the first email').toBeTruthy();
      expect(match!.applicability).toBe('applies');
      expect(match!.score).toBeGreaterThan(0.7);
      expect(match!.score).toBeLessThan(0.8);

      await openPage(
        page,
        `/cases/${caseTwoId}/quality?tab=skills&asOf=${encodeURIComponent(firstEmail)}`,
      );
      const card = page
        .getByRole('tabpanel', { name: 'SkillDNA' })
        .getByRole('listitem')
        .filter({ hasText: SKILL_TITLE });
      await expect(card).toContainText('Applies');
      await expect(card).toContainText(/Match score 7\d% \(model estimate\)/);
      await expect(card.getByRole('button', { name: /^Apply to this case/ })).toBeDisabled();
      await expect(card).toContainText('clear the time cursor first');
    });

    test('applying the skill to the whole record records the application', async ({
      page,
      api,
    }) => {
      const { caseTwoId } = ids();
      await openPage(page, `/cases/${caseTwoId}/quality?tab=skills`);
      const card = page
        .getByRole('tabpanel', { name: 'SkillDNA' })
        .getByRole('listitem')
        .filter({ hasText: SKILL_TITLE });
      await card.getByRole('button', { name: /^Apply to this case/ }).click();
      if (
        await confirmDialog(page)
          .isVisible()
          .catch(() => false)
      )
        await confirmWithReason(page, 'Apply skill');
      await settle(page);
      const matches = await api('engineer').getOk<{
        items: { skillId: string; applied: boolean }[];
      }>(`/cases/${caseTwoId}/skill-matches`);
      expect(matches.items.find((item) => item.skillId === story.skillId)?.applied).toBe(true);
    });
  });

  test.describe('8. the manager compares the outcomes, with estimate labels', () => {
    test.use({ persona: 'manager' });

    test('Case Two shows the stronger estimate on the compared metrics, and every figure says it is an estimate', async ({
      page,
      api,
    }) => {
      const { caseOneId, caseTwoId } = ids();
      const comparison = await api('manager').getOk<{ narrative: string[] }>('/compare', {
        query: { caseIds: `${caseOneId},${caseTwoId}` },
      });
      await openPage(page, `/cases/${caseTwoId}/quality?tab=compare`);
      const panel = page.getByRole('tabpanel', { name: 'Compare cases' });
      await expect(panel).toBeVisible();
      await expect(panel.getByText(/stronger estimate/).first()).toBeVisible();
      await expect(panel.getByText(/model estimates, not measurements/i).first()).toBeVisible();
      expect(comparison.narrative[0]).toMatch(
        /^CG-SYN-1002 shows the stronger estimate on \d+ of the \d+ metrics/,
      );
      await expect(panel).toContainText(comparison.narrative[0]!);
    });

    test('the efficiency monitor shows the token improvement as an estimate and a simulation, equal to the API', async ({
      page,
      api,
    }) => {
      const overview = await api('manager').getOk<{
        caseProcess?: { actualTokens?: number; counterfactualTokens?: number } | null;
      }>('/efficiency/overview');
      await openPage(page, '/efficiency');
      const process = page.getByRole('group', {
        name: 'Real process versus a simulated better path',
      });
      await expect(process).toBeVisible();
      await expect(process.getByText('Estimated').first()).toBeVisible();
      await expect(process.getByText('Simulated').first()).toBeVisible();
      await expect(process).toContainText(/Tokens used by the investigation/);
      await expect(process).toContainText(/better/);
      expect(JSON.stringify(overview)).toMatch(/counterfactual|simulated/i);
    });
  });

  test.describe('9. the Demo Guide ends at 13 of 13', () => {
    test.use({ persona: 'manager' });
    test('every step is derived from stored data and complete; the navigation says so', async ({
      page,
    }) => {
      const state = await demoState();
      expect(completedSteps(state)).toBe(13);
      expect(state.caseTwoId).toBe(story.caseTwo!.id);
      await openPage(page, '/demo');
      await expect(navLink(page, 'Demo Guide')).toContainText('13 of 13');
      await expect(mainRegion(page)).toContainText('13 of 13');
    });

    test('the persona switcher moves between the people of the story without a reload', async ({
      page,
    }) => {
      await openPage(page, '/');
      await switchPersonaInUi(page, 'curator');
      await expect(accountButton(page, PERSONAS.curator)).toBeVisible();
      await switchPersonaInUi(page, 'manager');
      await expect(accountButton(page, PERSONAS.manager)).toBeVisible();
    });
  });
});
