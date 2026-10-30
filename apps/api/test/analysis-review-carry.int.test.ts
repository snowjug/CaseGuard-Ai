import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CounterfactualScenario } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS, withFaultInjection } from '../src/db/testing';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
  type Json,
} from './support/app-harness';
import { contextFor } from './support/context';
import {
  acceptScenario,
  allAuditEvents,
  apiOf,
  earliestForkScenarios,
  ingestAndAnalyse,
  settledJob,
  walkToPilot,
  type TestApi,
} from './skills-support';

/*
 * A re-analysis regenerates every default scenario. What a person decided about a scenario must
 * survive when the regenerated simulation is the same one, and must be reset, visibly and in the same
 * transaction as the new snapshot, when the engine or its inputs changed it. The same holds for the
 * application of a skill to a case: the stored match keeps who applied it, when, and its conformance.
 */

const ONE = 'case_carry_one';
const TWO = 'case_carry_two';

// Free text typed by reviewers: it belongs on the review record only, never in audit details or logs.
const ACCEPT_REASON = 'MARKER-KEEP-41d7 the path only uses what was known before the decision';
const REJECT_REASON = 'MARKER-DROP-82ae this path skips the scoping questions';

let database: Database;
let h: Harness;
let api: TestApi;
let earliestForkId = '';
let skillId = '';

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  // After the sample cases' own timelines, so a recorded application lies after their events.
  h.clock.set('2026-06-01T09:00:00.000Z');
  api = apiOf(h);
  await ingestAndAnalyse(h, { one: ONE, two: TWO });
  earliestForkId = (await earliestForkScenarios(h, api, ONE)).forkId;
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

const repos = () => h.repos(CONTOSO);
const scenariosOf = (caseId: string): Promise<CounterfactualScenario[]> =>
  repos().counterfactuals.list(caseId);
const latestRunId = async (caseId: string): Promise<string> =>
  (await repos().analysis.getLatestRun(caseId))?.id ?? '';
const reviewUrl = (scenarioId: string) => `/cases/${ONE}/counterfactuals/${scenarioId}/review`;

/** Starts an analysis over HTTP, waits for its job and returns the run it produced. */
async function analyse(caseId: string, body: object = {}): Promise<string> {
  h.clock.advance(60_000);
  const res = await api.post(PERSONAS.engineer, `/cases/${caseId}/analysis`, body);
  expect(res.statusCode, JSON.stringify(res.data)).toBe(202);
  const job = await settledJob(h, api, res.data.job.id);
  expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
  return latestRunId(caseId);
}

/** The reviewer accepts the balanced path and rejects the fastest one; the third stays pending. */
async function decideTwo(): Promise<{ accepted: Json; rejected: Json }> {
  const current = (await scenariosOf(ONE)).filter((s) => s.forkId === earliestForkId);
  const balanced = current.find((s) => s.strategy === 'balanced');
  const fastest = current.find((s) => s.strategy === 'fastest_diagnosis');
  if (balanced === undefined || fastest === undefined) throw new Error('scenarios are missing');
  const accepted = await acceptScenario(api, ONE, balanced, ACCEPT_REASON);
  const rejected = await api.post(PERSONAS.reviewer, reviewUrl(fastest.id), {
    decision: 'reject',
    reason: REJECT_REASON,
    expectedVersion: fastest.version,
  });
  expect(accepted.statusCode, JSON.stringify(accepted.data)).toBe(200);
  expect(rejected.statusCode, JSON.stringify(rejected.data)).toBe(200);
  return { accepted: accepted.data, rejected: rejected.data };
}

/** Changes the governed action-value weights (an input of every analysis) a little further each time. */
async function tweakWeights(step: number): Promise<void> {
  const settings = await repos().governance.getSettings();
  const current = settings.action_value;
  await repos().governance.updateSection(
    'action_value',
    {
      ...current.value,
      version: `1.${step}.0`,
      weights: { time: 0.3 + 0.05 * step, token: 0.1, customer: 0.35 - 0.05 * step, risk: 0.25 },
    },
    {
      expectedVersion: current.version,
      changeNote: 'Weigh the time of a path a little more',
      by: PERSONAS.admin,
    },
  );
}

/** What a re-run that reproduces a scenario may legitimately change on it: its run, version and clocks. */
function reproduced(was: CounterfactualScenario, now: CounterfactualScenario) {
  return {
    ...was,
    analysisRunId: now.analysisRunId,
    version: now.version,
    updatedAt: now.updatedAt,
    boundary: {
      ...was.boundary,
      leakCheck: { ...was.boundary.leakCheck, checkedAt: now.boundary.leakCheck.checkedAt },
    },
  };
}

const resetEvents = async (runId?: string) =>
  (await allAuditEvents(h)).filter(
    (e) =>
      e.action === 'counterfactual.review_reset' &&
      (runId === undefined || e.details?.analysisRunId === runId),
  );

describe('a forced re-analysis keeps what a reviewer decided', () => {
  it(
    'keeps an accepted, a rejected and a pending scenario exactly as they were',
    { timeout: 120_000 },
    async () => {
      const { accepted, rejected } = await decideTwo();
      const before = await scenariosOf(ONE);
      expect(
        before
          .filter((s) => s.reviewState !== 'pending')
          .map((s) => s.reviewState)
          .sort(),
      ).toEqual(['confirmed', 'rejected']);
      const runBefore = await repos().analysis.getLatestRun(ONE);

      // Time passes between the runs, so every clock the engine stamps differs.
      h.clock.advance(60_000);
      const forced = await api.post(PERSONAS.engineer, `/cases/${ONE}/analysis`, { force: true });
      expect(forced.statusCode).toBe(202);
      expect(forced.data.reused).toBe(false);
      const job = await settledJob(h, api, forced.data.job.id);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const runAfter = await repos().analysis.getLatestRun(ONE);
      expect(runAfter?.id).not.toBe(runBefore?.id);
      expect(runAfter?.inputHash).toBe(runBefore?.inputHash);

      // Every scenario was regenerated for the new run, and is otherwise exactly what it was.
      const after = await scenariosOf(ONE);
      expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
      for (const was of before) {
        const now = after.find((s) => s.id === was.id);
        if (now === undefined) throw new Error(`scenario ${was.id} disappeared`);
        expect(now.analysisRunId).toBe(runAfter?.id);
        expect(now).toEqual(reproduced(was, now));
        // The row was rewritten for the new run, so its version moved: a client holding the old one reloads.
        expect(now.version).toBeGreaterThan(was.version);
      }

      // The decisions in particular: who, why and when.
      expect(after.find((s) => s.id === accepted.id)).toMatchObject({
        reviewState: 'confirmed',
        reviewedBy: PERSONAS.reviewer,
        reviewReason: ACCEPT_REASON,
        reviewedAt: accepted.reviewedAt,
      });
      expect(after.find((s) => s.id === rejected.id)).toMatchObject({
        reviewState: 'rejected',
        reviewedBy: PERSONAS.reviewer,
        reviewReason: REJECT_REASON,
        reviewedAt: rejected.reviewedAt,
      });
      const waiting = after.filter(
        (s) => s.forkId === earliestForkId && s.id !== accepted.id && s.id !== rejected.id,
      );
      expect(waiting.map((s) => s.reviewState)).toEqual(['pending']);

      // Nothing was reset, nothing was recorded as reset, and the review history is untouched.
      expect(await resetEvents()).toEqual([]);
      const completed = (await allAuditEvents(h)).find(
        (e) => e.action === 'analysis.completed' && e.caseId === ONE,
      );
      expect(completed?.details).toMatchObject({
        runId: runAfter?.id,
        reviewsCarried: 2,
        reviewsReset: 0,
      });
      const decisions = (await repos().reviews.list({ caseId: ONE, limit: 50 })).items.filter(
        (d) => d.targetType === 'counterfactual',
      );
      expect(decisions.map((d) => d.decision).sort()).toEqual(['confirm', 'reject']);
    },
  );

  it('still counts: a stale version is refused, and the carried acceptance can seed a skill', async () => {
    const accepted = (await scenariosOf(ONE)).find((s) => s.reviewState === 'confirmed');
    if (accepted === undefined) throw new Error('the accepted scenario is gone');
    const stale = await api.post(PERSONAS.reviewer, reviewUrl(accepted.id), {
      decision: 'reject',
      reason: 'MARKER-LATE-1c0e decided on a page that was opened before the re-run',
      expectedVersion: accepted.version - 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.data.code).toBe('version_conflict');
    expect((await scenariosOf(ONE)).find((s) => s.id === accepted.id)?.reviewState).toBe(
      'confirmed',
    );

    // Extraction takes only accepted scenarios: the decision that was carried is the one it sees.
    const res = await api.post(PERSONAS.engineer, `/cases/${ONE}/skills/extract`, {
      scenarioId: accepted.id,
    });
    expect(res.statusCode, JSON.stringify(res.data)).toBe(202);
    const job = await settledJob(h, api, res.data.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    skillId = job.resultRef.id;
    expect(skillId).not.toBe('');
  });
});

describe('an applied skill keeps its application and its conformance', () => {
  it(
    'is the same match whether it is read from storage or through skillMatches.list, after a forced re-analysis',
    { timeout: 180_000 },
    async () => {
      await walkToPilot(h, api, skillId);
      // The skill library is part of the analysis input, so Case Two is analysed again into a new run.
      const firstRun = await latestRunId(TWO);
      const skillRun = await analyse(TWO);
      expect(skillRun).not.toBe(firstRun);

      const listed = await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`);
      expect(listed.statusCode).toBe(200);
      const match = (listed.data.items as Json[]).find((m) => m.skillId === skillId);
      expect(match).toMatchObject({ lifecycle: 'pilot', applicability: 'applies', applied: false });
      h.clock.advance(60_000);
      const applied = await api.post(
        PERSONAS.engineer,
        `/cases/${TWO}/skill-matches/${match.id}/apply`,
      );
      expect(applied.statusCode, JSON.stringify(applied.data)).toBe(200);
      expect(applied.data).toMatchObject({ applied: true, appliedBy: PERSONAS.engineer });
      const conformance = applied.data.conformance;
      expect(conformance.stepsTotal).toBeGreaterThan(0);
      expect(conformance.score).toBeGreaterThan(0);
      const storedBefore = await repos().skills.getMatch(TWO, match.id);

      const forcedRun = await analyse(TWO, { force: true });
      expect(forcedRun).not.toBe(skillRun);

      // Straight from storage, before anything recomputes it on read: the application is still there.
      const stored = await repos().skills.getMatch(TWO, match.id);
      expect(stored).toMatchObject({
        applied: true,
        appliedAt: applied.data.appliedAt,
        appliedBy: PERSONAS.engineer,
        conformance,
        applicability: 'applies',
      });
      expect(stored?.version).toBeGreaterThan(storedBefore?.version ?? 0);

      // Reading it through the API gives the same match, and reading does not rewrite it.
      const again = await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`);
      expect((again.data.items as Json[]).find((m) => m.id === match.id)).toEqual(stored);
      expect(await repos().skills.getMatch(TWO, match.id)).toEqual(stored);

      // The skill's own view agrees: the case still counts as an application, with the same figure.
      const detail = await api.get(PERSONAS.engineer, `/skills/${skillId}`);
      expect((detail.data.matches as Json[]).find((m) => m.caseId === TWO)).toMatchObject({
        applied: true,
      });
      expect(detail.data.skill.effectiveness).toMatchObject({
        applications: 1,
        estimated: true,
        conformanceAvg: conformance.score,
      });

      // An earlier instant of the case is not the whole case: the application had not happened yet.
      const events = await repos().cases.getAllEvents(TWO);
      const first = events[0]?.timestamp ?? '';
      const early = await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches?asOf=${first}`);
      expect((early.data.items as Json[]).find((m) => m.id === match.id)).toMatchObject({
        applied: false,
        conformance: null,
      });
    },
  );
});

describe('a changed simulation comes back pending, and the reset is audited', () => {
  it(
    're-analysis with a changed input resets the decisions it can no longer vouch for',
    { timeout: 180_000 },
    async () => {
      const { accepted, rejected } = await decideTwo();
      const before = await scenariosOf(ONE);
      const runBefore = await latestRunId(ONE);
      await tweakWeights(1);

      const runAfter = await analyse(ONE);
      expect(runAfter).not.toBe(runBefore);
      const after = await scenariosOf(ONE);
      for (const id of [accepted.id, rejected.id]) {
        const was = before.find((s) => s.id === id);
        const now = after.find((s) => s.id === id);
        if (was === undefined || now === undefined) throw new Error(`scenario ${id} disappeared`);
        expect(now).toMatchObject({
          analysisRunId: runAfter,
          reviewState: 'pending',
          reviewReason: null,
          reviewedBy: null,
          reviewedAt: null,
        });
        // It is a different simulation: the engine reseeds its rollouts from the analysis input.
        expect(now.rollouts.seed).not.toBe(was.rollouts.seed);
        expect(now.version).toBeGreaterThan(was.version);
      }

      const resets = await resetEvents(runAfter);
      expect(resets.map((e) => e.targetId).sort()).toEqual([accepted.id, rejected.id].sort());
      for (const event of resets) {
        expect(event).toMatchObject({
          outcome: 'success',
          targetType: 'counterfactual',
          caseId: ONE,
          actorId: PERSONAS.engineer,
        });
        const was = before.find((s) => s.id === event.targetId);
        expect(event.details).toEqual({
          forkId: earliestForkId,
          strategy: was?.strategy,
          previousState: was?.reviewState,
          previousVersion: was?.version,
          previousAnalysisRunId: runBefore,
          analysisRunId: runAfter,
          cause: 'simulation_changed',
        });
      }
      const completed = (await allAuditEvents(h)).find(
        (e) => e.action === 'analysis.completed' && e.caseId === ONE,
      );
      expect(completed?.details).toMatchObject({
        runId: runAfter,
        reviewsCarried: 0,
        reviewsReset: 2,
      });

      // The history of what people decided stays; only the standing decision on the new path is gone.
      const decisions = (await repos().reviews.list({ caseId: ONE, limit: 50 })).items.filter(
        (d) => d.targetId === accepted.id || d.targetId === rejected.id,
      );
      expect(decisions).toHaveLength(4);

      // No reviewer text anywhere but the review records.
      expect(JSON.stringify(await allAuditEvents(h))).not.toMatch(/MARKER-/);
      expect(JSON.stringify(h.logs())).not.toMatch(/MARKER-/);

      // The new path can be judged again, by a person who sees its current version.
      const fresh = after.find((s) => s.id === accepted.id);
      const again = await acceptScenario(api, ONE, fresh, ACCEPT_REASON);
      expect(again.statusCode, JSON.stringify(again.data)).toBe(200);
      expect(again.data.reviewState).toBe('confirmed');
    },
  );

  it(
    'resets in the same transaction as the snapshot: a failure leaves the previous analysis and its decisions',
    { timeout: 180_000 },
    async () => {
      await decideTwo();
      await tweakWeights(2);
      const before = {
        run: await latestRunId(ONE),
        scenarios: await scenariosOf(ONE),
        audits: (await allAuditEvents(h)).length,
        resets: (await resetEvents()).length,
      };
      expect(before.scenarios.filter((s) => s.reviewState !== 'pending')).toHaveLength(2);

      const faulty = withFaultInjection(database);
      const harness = await createHarness({ database: faulty });
      harness.clock.set(h.clock.now().toISOString());
      try {
        const ctx = contextFor(harness, PERSONAS.engineer);
        faulty.arm({
          match: /INSERT INTO audit_events/i,
          error: new Error('injected audit failure'),
        });
        await expect(ctx.services.analysis.analyzeCase(ctx, ONE)).rejects.toThrow();
        faulty.disarm();

        expect(await latestRunId(ONE)).toBe(before.run);
        expect(await scenariosOf(ONE)).toEqual(before.scenarios);
        expect((await allAuditEvents(h)).length).toBe(before.audits);
        expect((await repos().cases.get(ONE))?.analysisState).toBe('analyzed');

        // The same analysis, once the audit trail can be written, resets them together with the snapshot.
        const outcome = await ctx.services.analysis.analyzeCase(ctx, ONE);
        expect(outcome.run.id).not.toBe(before.run);
        const resets = await resetEvents(outcome.run.id);
        expect(resets).toHaveLength(2);
        expect(
          (await allAuditEvents(h)).filter((e) => e.action === 'counterfactual.review_reset'),
        ).toHaveLength(before.resets + 2);
        expect((await scenariosOf(ONE)).filter((s) => s.reviewState !== 'pending')).toHaveLength(0);
      } finally {
        await harness.close();
      }
    },
  );

  it(
    'counterfactuals.run resets and audits the same way when the stored simulation is no longer the engine’s',
    { timeout: 180_000 },
    async () => {
      const { accepted, rejected } = await decideTwo();
      const runId = await latestRunId(ONE);
      const earlier = new Set((await resetEvents()).map((e) => e.id));
      // Decisions taken on numbers the engine does not reproduce now (as after an engine change).
      const decided = (await scenariosOf(ONE)).filter((s) => s.reviewState !== 'pending');
      expect(decided).toHaveLength(2);
      await repos().counterfactuals.saveScenarios(
        decided.map((s) => ({
          ...s,
          rollouts: { ...s.rollouts, seed: 'seed-of-an-older-engine' },
        })),
      );
      expect((await scenariosOf(ONE)).filter((s) => s.reviewState !== 'pending')).toHaveLength(2);

      const res = await api.post(
        PERSONAS.engineer,
        `/cases/${ONE}/forks/${earliestForkId}/counterfactuals`,
        {},
      );
      expect(res.statusCode, JSON.stringify(res.data)).toBe(202);
      const job = await settledJob(h, api, res.data.job.id);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');

      const now = await scenariosOf(ONE);
      for (const id of [accepted.id, rejected.id]) {
        expect(now.find((s) => s.id === id)).toMatchObject({
          reviewState: 'pending',
          reviewReason: null,
          reviewedBy: null,
        });
      }
      // Only the resets this run of the generator recorded: they name the run it replayed.
      const resets = (await resetEvents(runId)).filter((e) => !earlier.has(e.id));
      expect(resets.map((e) => e.targetId).sort()).toEqual([accepted.id, rejected.id].sort());
      const generated = (await allAuditEvents(h)).find(
        (e) => e.action === 'counterfactual.generated' && e.targetId === earliestForkId,
      );
      expect(generated?.details).toMatchObject({ reviewsCarried: 0, reviewsReset: 2 });
    },
  );
});
