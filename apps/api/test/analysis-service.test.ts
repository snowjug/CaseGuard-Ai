import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFullView,
  getCompiledPack,
  runDeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import { DEFAULT_ACTION_VALUE_CONFIG } from '@caseguard/schemas';
import type { AiPort } from '../src/services/ports';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { buildIngestInput } from './builders';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, ingestSample, normalizeSample } from './support/samples';

const ONE = 'case_analysis_one';
const TWO = 'case_analysis_two';

let database: Database;
let h: Harness;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  await ingestSample(h.repos(CONTOSO), SAMPLE_FILES.caseOne, { tenantId: CONTOSO, caseId: ONE });
  await ingestSample(h.repos(CONTOSO), SAMPLE_FILES.caseTwo, { tenantId: CONTOSO, caseId: TWO });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

const start = (
  caseId: string,
  body: object = {},
  persona: string = PERSONAS.engineer,
  harness = h,
) =>
  harness.call(persona, { method: 'POST', url: `/api/v1/cases/${caseId}/analysis`, payload: body });

/** What the engine itself produces for a sample: the reference the stored results must agree with. */
function engineReference(file: (typeof SAMPLE_FILES)[keyof typeof SAMPLE_FILES], caseId: string) {
  const normalized = normalizeSample(file, { tenantId: CONTOSO, caseId });
  const pack = getCompiledPack(normalized.case.workload);
  if (pack === null) throw new Error('missing pack');
  const ctx: EngineContext = {
    tenantId: CONTOSO,
    caseId,
    runId: 'run_reference',
    now: '2026-10-29T00:00:00.000Z',
    createdBy: 'system:test',
    seed: 'reference',
  };
  const view = createFullView(normalized.events, normalized.resolution);
  return runDeterministicAnalysis({ view, pack, config: DEFAULT_ACTION_VALUE_CONFIG, ctx });
}

describe('analysis pipeline', () => {
  it('analyses the costly case end to end and stores every artefact', async () => {
    const started = Date.now();
    const res = await start(ONE);
    expect(res.statusCode).toBe(202);
    expect(res.data.reused).toBe(false);
    expect(res.data.job.kind).toBe('case_analysis');
    await h.infra.services.jobs.idle();
    const elapsedMs = Date.now() - started;

    const job = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `/api/v1/jobs/${res.data.job.id}`,
    });
    expect(job.statusCode).toBe(200);
    expect(job.data.status, JSON.stringify(job.data.error)).toBe('succeeded');
    expect(job.data.progress.percent).toBe(100);
    expect(job.data.progress.stages.map((stage: { status: string }) => stage.status)).not.toContain(
      'failed',
    );
    expect(job.data.resultRef.type).toBe('analysis_run');

    const latest = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `/api/v1/cases/${ONE}/analysis`,
    });
    const run = latest.data.run;
    expect(run.id).toBe(job.data.resultRef.id);
    expect(run.status).toBe('succeeded');
    expect(run.simulated).toBe(true);
    expect(run.provider).toBe('deterministic');

    // The stored results agree with what the engine produces on its own for this case.
    const reference = engineReference(SAMPLE_FILES.caseOne, ONE);
    expect(run.counts).toMatchObject({
      events: reference.view.events.length,
      evidence: reference.evidence.length,
      claims: reference.claims.length,
      hypotheses: reference.hypotheses.length,
      actions: reference.actions.length,
      forks: reference.forks.length,
    });
    expect(run.counts.forks).toBeGreaterThan(0);
    expect(run.counts.modelExecutions).toBe(6);

    const repos = h.repos(CONTOSO);
    expect((await repos.analysis.listForks(ONE)).map((fork) => fork.id).sort()).toEqual(
      reference.forks.map((fork) => fork.id).sort(),
    );
    const quality = await repos.analysis.getQuality(ONE);
    expect(quality?.compositeScore).toBeLessThan(60);
    expect((await repos.analysis.listMetrics(ONE)).length).toBeGreaterThan(0);
    expect((await repos.analysis.getCoaching(ONE)) !== null).toBe(true);
    expect((await repos.analysis.listWarnings(ONE)).length).toBeGreaterThan(0);
    expect((await repos.cases.get(ONE))?.analysisState).toBe('analyzed');

    // The earliest meaningful fork got every strategy; counterfactual scenarios were stored with it.
    const scenarios = await repos.counterfactuals.list(ONE);
    const earliest = reference.forks.find((fork) => fork.isEarliestMeaningful);
    expect(earliest).toBeDefined();
    expect(scenarios.filter((scenario) => scenario.forkId === earliest?.id).length).toBe(3);

    const executions = await repos.telemetry.listExecutions({ caseId: ONE, limit: 50 });
    expect(executions.items).toHaveLength(6);
    expect(executions.items.every((item) => item.simulated)).toBe(true);
    expect(elapsedMs).toBeLessThan(60_000);
  });

  it('finds the efficient case clean: no decision forks, strong quality', async () => {
    const res = await start(TWO);
    expect(res.statusCode).toBe(202);
    await h.infra.services.jobs.idle();
    const repos = h.repos(CONTOSO);
    expect(await repos.analysis.listForks(TWO)).toHaveLength(0);
    expect((await repos.analysis.getQuality(TWO))?.compositeScore).toBeGreaterThan(85);
    expect((await repos.cases.get(TWO))?.analysisState).toBe('analyzed');
  });

  it('reuses an identical analysis instead of re-running it, unless forced', async () => {
    const before = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `/api/v1/cases/${ONE}/analysis`,
    });
    const again = await start(ONE);
    expect(again.statusCode).toBe(202);
    expect(again.data.reused).toBe(true);
    expect(again.data.runId).toBe(before.data.run.id);
    expect(again.data.job.status).toBe('succeeded');

    const forced = await start(ONE, { force: true });
    expect(forced.statusCode, JSON.stringify(forced.data)).toBe(202);
    expect(forced.data.reused).toBe(false);
    await h.infra.services.jobs.idle();
    const after = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `/api/v1/cases/${ONE}/analysis`,
    });
    expect(after.data.run.id).not.toBe(before.data.run.id);
    expect(after.data.run.inputHash).toBe(before.data.run.inputHash);
    expect(after.data.run.counts).toEqual(before.data.run.counts);
  });

  it('is deterministic: a forced re-run reproduces the same artefact ids and scores', async () => {
    const repos = h.repos(CONTOSO);
    const forksBefore = (await repos.analysis.listForks(ONE)).map((fork) => fork.id);
    const qualityBefore = (await repos.analysis.getQuality(ONE))?.compositeScore;
    await start(ONE, { force: true });
    await h.infra.services.jobs.idle();
    expect((await repos.analysis.listForks(ONE)).map((fork) => fork.id)).toEqual(forksBefore);
    expect((await repos.analysis.getQuality(ONE))?.compositeScore).toBe(qualityBefore);
  });

  it('audits the analysis without putting case content in the record', async () => {
    const events = (await h.repos(CONTOSO).audit.list({ limit: 200 })).items.filter(
      (event) => event.action === 'analysis.completed' && event.caseId === ONE,
    );
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events[0]?.details);
    expect(events[0]?.details).toMatchObject({ provider: 'deterministic', simulated: true });
    expect(serialized).not.toMatch(/sign-in|dns|teams/i);
  });

  it('keeps tenants apart: another tenant cannot analyse or even see the case', async () => {
    const other = await start(ONE, {}, PERSONAS.otherTenantEngineer);
    expect(other.statusCode).toBe(404);
    const latest = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: `/api/v1/cases/${ONE}/analysis`,
    });
    expect(latest.statusCode).toBe(404);
    expect((await h.repos(FABRIKAM).cases.get(ONE)) === null).toBe(true);
  });

  it('refuses read-only roles and unauthenticated callers', async () => {
    expect((await start(ONE, {}, PERSONAS.manager)).statusCode).toBe(403);
    expect(
      (await h.call(null, { method: 'POST', url: `/api/v1/cases/${ONE}/analysis`, payload: {} }))
        .statusCode,
    ).toBe(401);
  });

  it('answers an unknown case with 404 and an unsupported workload with a clear 422', async () => {
    expect((await start('case_does_not_exist')).statusCode).toBe(404);
    const input = buildIngestInput({ tenantId: CONTOSO, caseId: 'case_odd_workload' });
    await h
      .repos(CONTOSO)
      .cases.ingest({ ...input, case: { ...input.case, workload: 'quantum-routing' } });
    const res = await start('case_odd_workload');
    expect(res.statusCode).toBe(422);
    expect(res.data.detail).toContain('quantum-routing');
  });
});

describe('analysis jobs', () => {
  it('cancels a running analysis at the next stage and keeps the previous results', async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const blocked = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    let entered = false;
    const slowAi: AiPort = {
      async run(ctx, request, options) {
        entered = true;
        await blocked;
        return h.infra.services.ai.run(ctx, request, options);
      },
      status: (ctx) => h.infra.services.ai.status(ctx),
      health: (ctx) => h.infra.services.ai.health(ctx),
    };
    const harness = await createHarness({ database, services: { ai: slowAi } });
    try {
      const repos = harness.repos(CONTOSO);
      const before = await repos.analysis.getLatestRun(TWO);
      const res = await start(TWO, { force: true }, PERSONAS.engineer, harness);
      expect(res.statusCode).toBe(202);
      while (!entered) await new Promise((resolve) => setTimeout(resolve, 20));

      const cancel = await harness.call(PERSONAS.engineer, {
        method: 'POST',
        url: `/api/v1/jobs/${res.data.job.id}/cancel`,
      });
      expect(cancel.statusCode).toBe(200);
      gate.release();
      await harness.infra.services.jobs.idle();

      const job = await harness.call(PERSONAS.engineer, {
        method: 'GET',
        url: `/api/v1/jobs/${res.data.job.id}`,
      });
      expect(job.data.status).toBe('cancelled');
      const after = await repos.analysis.getLatestRun(TWO);
      expect(after?.id).toBe(before?.id);
      expect((await repos.cases.get(TWO))?.analysisState).toBe('analyzed');
    } finally {
      await harness.close();
    }
  });

  it('lists jobs for a case with their stages', async () => {
    const res = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `/api/v1/jobs?caseId=${ONE}&kind=case_analysis`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.items.length).toBeGreaterThan(0);
    expect(res.data.items[0].progress.stages).toHaveLength(8);
  });

  it("refuses to cancel another tenant's job", async () => {
    const jobs = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `/api/v1/jobs?caseId=${ONE}`,
    });
    const id = jobs.data.items[0].id;
    const res = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'POST',
      url: `/api/v1/jobs/${id}/cancel`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('can be driven directly through the port, as seeding and tests do', async () => {
    const ctx = contextFor(h);
    const outcome = await ctx.services.analysis.analyzeCase(ctx, ONE);
    expect(outcome.reused).toBe(true);
    expect(outcome.run.caseId).toBe(ONE);
  });
});
