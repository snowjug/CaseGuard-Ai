/* eslint-disable @typescript-eslint/no-unsafe-return -- response bodies are parsed JSON, typed `Json` by the harness */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTemporalViewBeforeEvent,
  futureOnlyTokens,
  getCompiledPack,
  packStaticTokens,
} from '@caseguard/domain';
import type { CounterfactualScenario } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS, withFaultInjection } from '../src/db/testing';
import type { AiPort } from '../src/services/ports';
import { buildFork, buildIngestInput, buildSnapshot } from './builders';
import {
  CONTOSO,
  FABRIKAM,
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
  type TestApi,
} from './skills-support';

const ONE = 'case_cf_one';
const SYNTH = 'case_cf_synth';
const SYNTH_FORK = `fork_${SYNTH}_1`;
const INELIGIBLE_FORK = 'fork_cf_ineligible';
const REASON = 'MARKER-REVIEW-4d1c the path respects what was known at the decision';

let database: Database;
let h: Harness;
let api: TestApi;
let earliest: { forkId: string; scenarios: Json[] };
let secondaryForkId = '';

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  api = apiOf(h);
  await ingestAndAnalyse(h, { one: ONE, two: 'unused' }, 'one');
  earliest = await earliestForkScenarios(h, api, ONE);
  const forks = await h.repos(CONTOSO).analysis.listForks(ONE);
  secondaryForkId = forks.find((f) => !f.isEarliestMeaningful && f.eligibility.eligible)?.id ?? '';

  // A synthetic case with one eligible and one ineligible fork, for the refusal paths.
  const input = buildIngestInput({ tenantId: CONTOSO, caseId: SYNTH });
  await h.repos(CONTOSO).cases.ingest(input);
  const snapshot = buildSnapshot(input);
  const boundary = snapshot.forks[0]?.timestamp ?? '2026-01-01T00:00:00.000Z';
  await h.repos(CONTOSO).analysis.saveSnapshot({
    ...snapshot,
    forks: [
      ...snapshot.forks,
      buildFork({
        tenantId: CONTOSO,
        caseId: SYNTH,
        analysisRunId: snapshot.run.id,
        id: INELIGIBLE_FORK,
        sequence: 1,
        isEarliestMeaningful: false,
        eventId: snapshot.forks[0]?.eventId ?? 'evt_06',
        timestamp: boundary,
        eligibility: {
          eligible: false,
          boundary,
          checks: [
            { id: 'impact-meaningful', passed: false, detail: 'Impact 0.1 versus threshold 0.3.' },
          ],
          reasons: ['Impact 0.1 versus threshold 0.3.'],
        },
      }),
    ],
  });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

const audits = (tenantId = CONTOSO) => allAuditEvents(h, tenantId);
const runUrl = (caseId: string, forkId: string) =>
  `/cases/${caseId}/forks/${forkId}/counterfactuals`;
const scenarioUrl = (id: string, caseId = ONE) => `/cases/${caseId}/counterfactuals/${id}`;

async function scenariosOf(forkId: string): Promise<Json[]> {
  return (await api.get(PERSONAS.engineer, `/cases/${ONE}/counterfactuals?forkId=${forkId}`)).data
    .items;
}

describe('counterfactuals.run', () => {
  it('needs a caller, and the counterfactual:run permission', async () => {
    const url = runUrl(ONE, earliest.forkId);
    expect((await api.post(null, url)).statusCode).toBe(401);
    for (const persona of [PERSONAS.reviewer, PERSONAS.manager, PERSONAS.curator]) {
      expect((await api.post(persona, url)).statusCode, persona).toBe(403);
    }
    const denied = (await audits()).filter((e) => e.action === 'access.denied');
    expect(denied.some((e) => e.actorId === PERSONAS.reviewer && e.outcome === 'denied')).toBe(
      true,
    );
  });

  it('rejects an invalid body and unknown things with the documented problems', async () => {
    const url = runUrl(ONE, earliest.forkId);
    expect((await api.post(PERSONAS.engineer, url, { strategies: [] })).statusCode).toBe(422);
    expect((await api.post(PERSONAS.engineer, url, { strategies: ['wishful'] })).statusCode).toBe(
      422,
    );
    expect((await api.post(PERSONAS.engineer, runUrl(ONE, 'fork_missing'))).statusCode).toBe(404);
    expect(
      (await api.post(PERSONAS.engineer, runUrl('case_missing', earliest.forkId))).statusCode,
    ).toBe(404);
    expect((await api.post(PERSONAS.engineer, runUrl(ONE, 'bad%20id'))).statusCode).toBe(422);
  });

  it('refuses an ineligible fork with the engine’s reasons (409)', async () => {
    const res = await api.post(PERSONAS.engineer, runUrl(SYNTH, INELIGIBLE_FORK));
    expect(res.statusCode).toBe(409);
    expect(res.data.code).toBe('conflict');
    expect(res.data.detail).toContain('not eligible');
    expect(res.data.detail).toContain('Impact 0.1 versus threshold 0.3.');
    const ctx = contextFor(h, PERSONAS.engineer);
    await expect(
      ctx.services.counterfactuals.runForFork(ctx, SYNTH, INELIGIBLE_FORK),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not trust a stored fork the engine no longer derives (the job fails with a clear 409)', async () => {
    const res = await api.post(PERSONAS.engineer, runUrl(SYNTH, SYNTH_FORK));
    expect(res.statusCode).toBe(202);
    const job = await settledJob(h, api, res.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'conflict' });
    expect(job.error.message).toMatch(/no longer matches the engine output/);
    expect(await h.repos(CONTOSO).counterfactuals.list(SYNTH)).toEqual([]);
  });

  it('generates the missing strategies for a fork as a job with real stages, and stores what the engine decided', async () => {
    expect(secondaryForkId).not.toBe('');
    expect(await scenariosOf(secondaryForkId)).toHaveLength(1); // the analysis stored the balanced path only
    const res = await api.post(PERSONAS.engineer, runUrl(ONE, secondaryForkId), {
      strategies: ['fastest_diagnosis', 'balanced', 'lowest_customer_effort'],
    });
    expect(res.statusCode).toBe(202);
    expect(res.data.job).toMatchObject({
      kind: 'counterfactual',
      caseId: ONE,
      targetId: secondaryForkId,
    });
    const job = await settledJob(h, api, res.data.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.progress.stages.map((s: Json) => [s.id, s.status])).toEqual([
      ['load', 'done'],
      ['simulate', 'done'],
      ['validate', 'done'],
      ['save', 'done'],
    ]);

    const stored = await scenariosOf(secondaryForkId);
    expect(stored.map((s) => s.strategy).sort()).toEqual([
      'balanced',
      'fastest_diagnosis',
      'lowest_customer_effort',
    ]);
    for (const scenario of stored) {
      expect(scenario.forkId).toBe(secondaryForkId);
      expect(['completed', 'rejected']).toContain(scenario.status);
      expect(scenario.status === 'completed').toBe(
        scenario.validity.valid && scenario.boundary.leakCheck.passed,
      );
      expect(scenario.labels).toEqual({ simulated: true, estimated: true });
    }
    // Each path went through the validated counterfactual simulator task: an execution record exists.
    const fresh = stored.filter((s) => s.strategy !== 'balanced');
    const executions = await h.repos(CONTOSO).telemetry.listExecutions({ caseId: ONE, limit: 100 });
    const simulator = executions.items.filter((e) => e.agent === 'counterfactual_simulator');
    for (const scenario of fresh) {
      expect(scenario.modelExecutionId).not.toBeNull();
      expect(simulator.some((e) => e.id === scenario.modelExecutionId && e.simulated)).toBe(true);
    }
  });

  it('is idempotent: the same request is answered by the same job, with or without an Idempotency-Key', async () => {
    const url = runUrl(ONE, secondaryForkId);
    const body = { strategies: ['balanced'] };
    const first = await api.post(PERSONAS.engineer, url, body);
    await settledJob(h, api, first.data.job.id);
    const second = await api.post(PERSONAS.engineer, url, body);
    expect(second.statusCode).toBe(202);
    expect(second.data.job.id).toBe(first.data.job.id);

    const key = 'idem-counterfactual-run-0001';
    const keyed = await api.post(
      PERSONAS.engineer,
      url,
      { strategies: ['fastest_diagnosis'] },
      { 'idempotency-key': key },
    );
    expect(keyed.statusCode).toBe(202);
    const replay = await api.post(
      PERSONAS.engineer,
      url,
      { strategies: ['fastest_diagnosis'] },
      { 'idempotency-key': key },
    );
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.data).toEqual(keyed.data);
    const clash = await api.post(
      PERSONAS.engineer,
      url,
      { strategies: ['balanced'] },
      { 'idempotency-key': key },
    );
    expect(clash.statusCode).toBe(422);
    expect(clash.data.code).toBe('idempotency_conflict');
    await h.infra.services.jobs.idle();
  });

  it('audits the request and the result with ids and counters only, inside the tenant', async () => {
    const events = await audits();
    const requested = events.filter((e) => e.action === 'counterfactual.run_requested');
    const generated = events.filter((e) => e.action === 'counterfactual.generated');
    expect(requested.length).toBeGreaterThan(0);
    expect(generated.length).toBeGreaterThan(0);
    expect(generated[0]).toMatchObject({
      outcome: 'success',
      targetType: 'fork',
      actorId: PERSONAS.engineer,
      caseId: ONE,
    });
    expect(generated[0]?.details).toMatchObject({ leakChecksFailed: 0 });
    expect(Object.keys(generated[0]?.details ?? {}).sort()).toEqual([
      'analysisRunId',
      'forkId',
      'leakChecksFailed',
      'modelExecutions',
      'rejected',
      'reviewsCarried',
      'reviewsReset',
      'scenarios',
      'strategies',
    ]);
    expect((await audits(FABRIKAM)).filter((e) => e.action.startsWith('counterfactual.'))).toEqual(
      [],
    );
  });

  it('keeps tenants apart: another tenant gets 404 for the fork', async () => {
    const res = await api.post(PERSONAS.otherTenantEngineer, runUrl(ONE, earliest.forkId));
    expect(res.statusCode).toBe(404);
  });
});

describe('counterfactuals.list and counterfactuals.get', () => {
  it('lists the case’s scenarios, filtered by fork, for every role that can read cases', async () => {
    for (const persona of [
      PERSONAS.engineer,
      PERSONAS.reviewer,
      PERSONAS.manager,
      PERSONAS.curator,
      PERSONAS.admin,
    ]) {
      const res = await api.get(persona, `/cases/${ONE}/counterfactuals`);
      expect(res.statusCode, persona).toBe(200);
      expect(res.data.items.length).toBeGreaterThanOrEqual(3);
    }
    const filtered = await scenariosOf(earliest.forkId);
    expect(filtered).toHaveLength(3);
    expect(filtered.every((s) => s.forkId === earliest.forkId)).toBe(true);
    expect(
      (await api.get(PERSONAS.engineer, `/cases/${ONE}/counterfactuals?forkId=fork_nope`)).data
        .items,
    ).toEqual([]);
    expect((await api.get(null, `/cases/${ONE}/counterfactuals`)).statusCode).toBe(401);
  });

  it('returns one scenario and 404s on unknown ids and across tenants', async () => {
    const scenario = earliest.scenarios[0];
    const res = await api.get(PERSONAS.manager, scenarioUrl(scenario.id));
    expect(res.statusCode).toBe(200);
    expect(res.data.id).toBe(scenario.id);
    expect((await api.get(PERSONAS.engineer, scenarioUrl('scn_missing'))).statusCode).toBe(404);
    expect((await api.get(PERSONAS.otherTenantEngineer, scenarioUrl(scenario.id))).statusCode).toBe(
      404,
    );
    expect(
      (await api.get(PERSONAS.otherTenantEngineer, `/cases/${ONE}/counterfactuals`)).statusCode,
    ).toBe(404);
    expect(
      (await api.get(PERSONAS.engineer, `/cases/case_missing/counterfactuals`)).statusCode,
    ).toBe(404);
  });
});

describe('counterfactuals.review', () => {
  let target: Json;

  it('needs a reviewer: engineers, managers and curators are refused, anonymous callers are not known', async () => {
    target = (await scenariosOf(earliest.forkId)).find(
      (s) => s.strategy === 'lowest_customer_effort',
    );
    const body = { decision: 'accept', reason: REASON, expectedVersion: target.version };
    expect((await api.post(null, `${scenarioUrl(target.id)}/review`, body)).statusCode).toBe(401);
    for (const persona of [PERSONAS.engineer, PERSONAS.manager, PERSONAS.curator]) {
      expect(
        (await api.post(persona, `${scenarioUrl(target.id)}/review`, body)).statusCode,
        persona,
      ).toBe(403);
    }
    expect((await api.get(PERSONAS.engineer, scenarioUrl(target.id))).data.reviewState).toBe(
      'pending',
    );
  });

  it('validates the body: decision, reason and expected version', async () => {
    const url = `${scenarioUrl(target.id)}/review`;
    const ok = { decision: 'accept', reason: REASON, expectedVersion: target.version };
    expect((await api.post(PERSONAS.reviewer, url, { ...ok, decision: 'maybe' })).statusCode).toBe(
      422,
    );
    expect((await api.post(PERSONAS.reviewer, url, { ...ok, reason: 'no' })).statusCode).toBe(422);
    expect(
      (await api.post(PERSONAS.reviewer, url, { ...ok, reason: '          ' })).statusCode,
    ).toBe(422);
    expect((await api.post(PERSONAS.reviewer, url, { ...ok, expectedVersion: 0 })).statusCode).toBe(
      422,
    );
    expect(
      (await api.post(PERSONAS.reviewer, url, { decision: 'reject', reason: REASON })).statusCode,
    ).toBe(422);
    expect(
      (await api.post(PERSONAS.reviewer, scenarioUrl('scn_missing') + '/review', ok)).statusCode,
    ).toBe(404);
  });

  it('answers a stale version with a 409 and changes nothing', async () => {
    const res = await api.post(PERSONAS.reviewer, `${scenarioUrl(target.id)}/review`, {
      decision: 'accept',
      reason: REASON,
      expectedVersion: target.version + 5,
    });
    expect(res.statusCode).toBe(409);
    expect(res.data.code).toBe('version_conflict');
    expect((await api.get(PERSONAS.engineer, scenarioUrl(target.id))).data.reviewState).toBe(
      'pending',
    );
  });

  it('accepts: the decision, the review record and the audit event commit together; the reason stays on the record', async () => {
    const res = await acceptScenario(api, ONE, target, REASON);
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      reviewState: 'confirmed',
      reviewReason: REASON,
      reviewedBy: PERSONAS.reviewer,
      version: target.version + 1,
    });
    const records = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 50 })).items;
    const record = records.find((r) => r.targetId === target.id);
    expect(record).toMatchObject({
      targetType: 'counterfactual',
      decision: 'confirm',
      reviewerId: PERSONAS.reviewer,
      reviewerRole: 'reviewer',
      reason: REASON,
      originalValue: {
        reviewState: 'pending',
        status: 'completed',
        strategy: 'lowest_customer_effort',
      },
      newValue: { reviewState: 'confirmed' },
    });
    const event = (await audits()).find(
      (e) => e.action === 'counterfactual.reviewed' && e.targetId === target.id,
    );
    expect(event).toMatchObject({ outcome: 'success', actorId: PERSONAS.reviewer, caseId: ONE });
    expect(event?.details).toMatchObject({
      decision: 'accept',
      fromState: 'pending',
      toState: 'confirmed',
      reasonRecorded: true,
    });
    expect(JSON.stringify(event?.details)).not.toContain('MARKER-');
    expect(JSON.stringify(h.logs())).not.toContain('MARKER-REVIEW');
  });

  it('may reject afterwards, with a reason; the new version must be the one the reviewer saw', async () => {
    const current = (await api.get(PERSONAS.engineer, scenarioUrl(target.id))).data;
    const stale = await api.post(PERSONAS.reviewer, `${scenarioUrl(target.id)}/review`, {
      decision: 'reject',
      reason: REASON,
      expectedVersion: target.version,
    });
    expect(stale.statusCode).toBe(409);
    const rejected = await api.post(PERSONAS.admin, `${scenarioUrl(target.id)}/review`, {
      decision: 'reject',
      reason: 'Unrealistic: the customer cannot run that check in the time given.',
      expectedVersion: current.version,
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.data).toMatchObject({ reviewState: 'rejected', reviewedBy: PERSONAS.admin });
    const latest = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 50 })).items.filter(
      (r) => r.targetId === target.id,
    );
    expect(latest.map((r) => r.decision).sort()).toEqual(['confirm', 'reject']);
  });

  it('keeps the decision when a re-run reproduces exactly the same simulation', async () => {
    const before = (await api.get(PERSONAS.engineer, scenarioUrl(target.id))).data;
    const ctx = contextFor(h, PERSONAS.engineer);
    const again = await ctx.services.counterfactuals.runForFork(ctx, ONE, earliest.forkId, [
      'lowest_customer_effort',
    ]);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      id: target.id,
      reviewState: 'rejected',
      reviewedBy: PERSONAS.admin,
      reviewReason: before.reviewReason,
    });
    expect(again[0]?.version).toBeGreaterThan(before.version);
  });

  it('never accepts a scenario the engine rejected, but lets a reviewer reject it', async () => {
    const source = earliest.scenarios[0] as CounterfactualScenario;
    const forced: CounterfactualScenario = {
      ...source,
      id: 'scn_forced_rejected',
      status: 'rejected',
      validity: {
        valid: false,
        checks: [{ id: 'steps-safe', passed: false, detail: 'A step is destructive.' }],
      },
      reviewState: 'pending',
      reviewReason: null,
      reviewedBy: null,
      reviewedAt: null,
      steps: source.steps.map((step) => ({
        ...step,
        scenarioId: 'scn_forced_rejected',
        id: `${step.id}_forced`,
      })),
    };
    await h.repos(CONTOSO).counterfactuals.saveScenarios([forced]);
    const shown = (await api.get(PERSONAS.engineer, scenarioUrl(forced.id))).data;
    expect(shown.status).toBe('rejected'); // stored and shown as rejected, never dropped or fixed

    const accept = await acceptScenario(api, ONE, shown, REASON);
    expect(accept.statusCode).toBe(409);
    expect(accept.data.detail).toMatch(/marked the scenario rejected/);
    expect(accept.data.detail).toMatch(/steps-safe/);
    const reject = await api.post(PERSONAS.reviewer, `${scenarioUrl(forced.id)}/review`, {
      decision: 'reject',
      reason: 'The engine already found it unsafe; confirming.',
      expectedVersion: shown.version,
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.data.reviewState).toBe('rejected');
  });

  it('is atomic: when the audit event cannot be written nothing of the review remains', async () => {
    const faulty = withFaultInjection(database);
    const harness = await createHarness({ database: faulty });
    try {
      const scenario = earliest.scenarios.find((s) => s.strategy === 'fastest_diagnosis');
      const fresh = (
        await harness.call(PERSONAS.engineer, {
          method: 'GET',
          url: `/api/v1${scenarioUrl(scenario.id)}`,
        })
      ).data;
      faulty.arm({
        match: /INSERT INTO audit_events/i,
        error: new Error('injected audit failure'),
      });
      const res = await harness.call(PERSONAS.reviewer, {
        method: 'POST',
        url: `/api/v1${scenarioUrl(scenario.id)}/review`,
        payload: { decision: 'accept', reason: REASON, expectedVersion: fresh.version },
      });
      faulty.disarm();
      expect(res.statusCode).toBe(500);
      const after = (
        await harness.call(PERSONAS.engineer, {
          method: 'GET',
          url: `/api/v1${scenarioUrl(scenario.id)}`,
        })
      ).data;
      expect(after).toMatchObject({ reviewState: 'pending', version: fresh.version });
      const records = (await h.repos(CONTOSO).reviews.list({ caseId: ONE, limit: 50 })).items;
      expect(records.some((r) => r.targetId === scenario.id)).toBe(false);
    } finally {
      await harness.close();
    }
  });
});

describe('counterfactuals.hindsight', () => {
  it('is for reviewers and administrators only', async () => {
    const scenario = earliest.scenarios[0];
    const url = `${scenarioUrl(scenario.id)}/hindsight`;
    expect((await api.get(null, url)).statusCode).toBe(401);
    for (const persona of [PERSONAS.engineer, PERSONAS.manager, PERSONAS.curator]) {
      expect((await api.get(persona, url)).statusCode, persona).toBe(403);
    }
    for (const persona of [PERSONAS.reviewer, PERSONAS.admin]) {
      expect((await api.get(persona, url)).statusCode, persona).toBe(200);
    }
    expect(
      (await api.get(PERSONAS.reviewer, `${scenarioUrl('scn_missing')}/hindsight`)).statusCode,
    ).toBe(404);
    const fabi = contextFor(h, PERSONAS.otherTenantEngineer);
    await expect(
      fabi.services.counterfactuals.hindsight(fabi, ONE, scenario.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('is a labelled post-hoc comparison that uses the resolution and matches the engine’s own check', async () => {
    const scenario = earliest.scenarios.find((s) => s.strategy === 'balanced');
    const res = await api.get(PERSONAS.reviewer, `${scenarioUrl(scenario.id)}/hindsight`);
    expect(res.data).toMatchObject({
      scenarioId: scenario.id,
      caseId: ONE,
      usedFinalResolution: true,
    });
    expect(res.data.notice).toMatch(/Post-hoc evaluation/);
    expect(res.data.notice).toMatch(/never available when the counterfactual was generated/);
    expect(typeof res.data.explanation).toBe('string');

    // The scenario itself holds none of it, and fetching hindsight changes nothing about it.
    const stored = (await api.get(PERSONAS.reviewer, scenarioUrl(scenario.id))).data;
    expect(stored).toEqual(scenario);
    expect(JSON.stringify(stored)).not.toMatch(/usedFinalResolution|resolutionHypothesisKey/);

    // Recomputed on demand and cached briefly: the same answer, computed once.
    const again = await api.get(PERSONAS.reviewer, `${scenarioUrl(scenario.id)}/hindsight`);
    expect(again.data).toEqual(res.data);
  });

  it('refuses hindsight for a scenario the engine no longer reproduces', async () => {
    const source = earliest.scenarios.find(
      (s) => s.strategy === 'fastest_diagnosis',
    ) as CounterfactualScenario;
    const current = (await api.get(PERSONAS.engineer, scenarioUrl(source.id))).data;
    await h
      .repos(CONTOSO)
      .counterfactuals.saveScenarios([
        { ...current, summary: 'Edited after the fact: this is not what the engine produced.' },
      ]);
    const res = await api.get(PERSONAS.reviewer, `${scenarioUrl(source.id)}/hindsight`);
    expect(res.statusCode).toBe(409);
    expect(res.data.detail).toMatch(/no longer matches the engine output/);
  });
});

describe('ensureScenarios and runForFork (the ports the seeder drives)', () => {
  it('returns the stored scenarios when the defaults exist, and regenerates the ones that are missing', async () => {
    const ctx = contextFor(h, PERSONAS.engineer);
    const before = await ctx.services.counterfactuals.ensureScenarios(ctx, ONE);
    expect(before.length).toBeGreaterThanOrEqual(10);
    const generatedBefore = (await audits()).filter(
      (e) => e.action === 'counterfactual.generated',
    ).length;

    // Remove a default scenario the way erasure would (owner connection), then ensure it back.
    const victim = before.find((s) => s.forkId !== earliest.forkId && s.forkId !== secondaryForkId);
    expect(victim).toBeDefined();
    await database.query('DELETE FROM counterfactual_scenarios WHERE case_id = $1 AND id = $2', [
      ONE,
      victim?.id,
    ]);
    const after = await ctx.services.counterfactuals.ensureScenarios(ctx, ONE);
    expect(after.some((s) => s.id === victim?.id)).toBe(true);
    expect(after).toHaveLength(before.length);
    const regenerated = (await audits()).filter((e) => e.action === 'counterfactual.generated');
    expect(regenerated).toHaveLength(generatedBefore + 1);
    expect(regenerated[0]?.details).toMatchObject({
      forkId: victim?.forkId,
      strategies: ['balanced'],
    });
  });

  it('says nothing for a case that was never analysed, and 404s for a case that is not there', async () => {
    const ctx = contextFor(h, PERSONAS.engineer);
    const input = buildIngestInput({
      tenantId: CONTOSO,
      caseId: 'case_cf_raw',
      receivedSeed: 'raw',
    });
    await h.repos(CONTOSO).cases.ingest(input);
    expect(await ctx.services.counterfactuals.ensureScenarios(ctx, 'case_cf_raw')).toEqual([]);
    await expect(
      ctx.services.counterfactuals.ensureScenarios(ctx, 'case_missing'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      ctx.services.counterfactuals.runForFork(ctx, ONE, earliest.forkId, []),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('the counterfactual simulator task', () => {
  const delegating = (harness: Harness, alter: (real: Json) => Json): AiPort => ({
    async run(ctx, request, options) {
      const real: Json = await harness.infra.services.ai.run(ctx, request, options);
      return request.task.agent === 'counterfactual_simulator' ? alter(real) : real;
    },
    status: (ctx) => harness.infra.services.ai.status(ctx),
    health: (ctx) => harness.infra.services.ai.health(ctx),
  });

  async function secondaryBalanced(): Promise<Json> {
    return (await scenariosOf(secondaryForkId)).find((s) => s.strategy === 'balanced');
  }

  it('lets a validated model proposal contribute wording, never numbers, ids or checks', async () => {
    const before = await secondaryBalanced();
    const wording =
      'Model wording: ask for the three scoping items first, then compare the sign-in logs.';
    const model = await createHarness({
      database,
      services: {
        ai: delegating(h, (real) => ({
          ...real,
          source: 'model',
          result: {
            ...real.result,
            steps: real.result.steps.map((s: Json, i: number) =>
              i === 0 ? { ...s, rationale: wording } : s,
            ),
          },
        })),
      },
    });
    try {
      const ctx = contextFor(model, PERSONAS.engineer);
      const [saved] = await ctx.services.counterfactuals.runForFork(ctx, ONE, secondaryForkId, [
        'balanced',
      ]);
      expect(saved?.steps[0]?.rationale).toBe(wording);
      expect(saved?.steps.slice(1)).toEqual(before.steps.slice(1));
      expect({ ...saved, steps: [], modelExecutionId: null, version: 0, updatedAt: '' }).toEqual({
        ...before,
        steps: [],
        modelExecutionId: null,
        version: 0,
        updatedAt: '',
      });
      expect(saved?.modelExecutionId).not.toBe(before.modelExecutionId);
    } finally {
      await model.close();
    }
  });

  it('never stores model wording that names something only known after the decision', async () => {
    const forks = await h.repos(CONTOSO).analysis.listForks(ONE);
    const fork = forks.find((f) => f.id === secondaryForkId);
    const events = await h.repos(CONTOSO).cases.getAllEvents(ONE);
    const resolution = await h.repos(CONTOSO).cases.getResolution(ONE);
    const pack = getCompiledPack('teams-authentication');
    if (fork === undefined || pack === null) throw new Error('fixture missing');
    const tokens = futureOnlyTokens(
      events,
      createTemporalViewBeforeEvent(events, fork.eventId),
      resolution ? `${resolution.summary} ${resolution.rootCause}` : '',
      packStaticTokens(pack),
    );
    const [token] = [...tokens];
    expect(token).toBeDefined();

    const before = await secondaryBalanced();
    const leaking = await createHarness({
      database,
      services: {
        ai: delegating(h, (real) => ({
          ...real,
          source: 'model',
          result: {
            ...real.result,
            steps: real.result.steps.map((s: Json) => ({
              ...s,
              rationale: `Check ${token} immediately.`,
            })),
          },
        })),
      },
    });
    try {
      const ctx = contextFor(leaking, PERSONAS.engineer);
      const [saved] = await ctx.services.counterfactuals.runForFork(ctx, ONE, secondaryForkId, [
        'balanced',
      ]);
      // The engine's own wording is back (the earlier test stored model wording for step 1).
      expect(saved?.steps[0]?.rationale).toMatch(/^Rank 1 under/);
      expect(saved?.steps.slice(1)).toEqual(before.steps.slice(1));
      expect(JSON.stringify(saved)).not.toContain(token);
    } finally {
      await leaking.close();
    }
  });

  it('stores the engine’s scenarios, without a model execution, when the task itself fails', async () => {
    const failing = await createHarness({
      database,
      services: {
        ai: {
          async run(ctx, request, options) {
            if (request.task.agent === 'counterfactual_simulator')
              throw new Error('provider unavailable');
            return h.infra.services.ai.run(ctx, request, options);
          },
          status: (ctx) => h.infra.services.ai.status(ctx),
          health: (ctx) => h.infra.services.ai.health(ctx),
        },
      },
    });
    try {
      const ctx = contextFor(failing, PERSONAS.engineer);
      const saved = await ctx.services.counterfactuals.runForFork(ctx, ONE, secondaryForkId, [
        'fastest_diagnosis',
      ]);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        strategy: 'fastest_diagnosis',
        modelExecutionId: null,
        status: 'completed',
      });
      expect(saved[0]?.steps.length).toBeGreaterThan(0);
    } finally {
      await failing.close();
    }
  });
});
