import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { NOT_A_DEMO_TENANT } from '../src/services/demo/guard';
import { STORY_CASES } from '../src/services/demo/story-cases';
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
  STORY_TIMEOUT_MS,
  allAudit,
  apiOf,
  completedSteps,
  demoState,
  errorLines,
  settle,
  type TestApi,
} from './insights-support';

/*
 * The guided demo over HTTP: who may seed and reset, the base profile, a presenter performing the
 * first steps by hand (the guide follows the stored facts), a half-seeded tenant being finished by the
 * portfolio profile, the reset, and the refusal outside a synthetic demo tenant.
 */

let database: Database;
let h: Harness;
let api: TestApi;
const harnesses: Harness[] = [];

let caseOneId = '';
let acceptedScenarioId = '';
let skillId = '';

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  harnesses.push(h);
  api = apiOf(h);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  for (const created of harnesses) await created.close();
  await database.close();
});

const REASON = 'The path is realistic: every step uses only what was known before the decision.';
const SEEDERS = [
  PERSONAS.engineer,
  PERSONAS.reviewer,
  PERSONAS.manager,
  PERSONAS.curator,
  PERSONAS.otherTenantEngineer,
];

const seedEvents = async (action: string, tenantId = CONTOSO) =>
  (await allAudit(h, tenantId))
    .filter((event) => event.action === action)
    .sort((a, b) => a.sequence - b.sequence);

describe('[FR-DEMO-10] who may seed and reset', () => {
  it('refuses anonymous callers and every role but the administrator, changing nothing', async () => {
    for (const url of ['/demo/seed', '/demo/reset']) {
      expect((await api.post(null, url)).statusCode, url).toBe(401);
      for (const persona of SEEDERS)
        expect((await api.post(persona, url)).statusCode, `${persona} ${url}`).toBe(403);
    }
    expect((await h.repos(CONTOSO).cases.counts()).total).toBe(0);
    expect(await seedEvents('demo.seed')).toEqual([]);
    // Reading the guide only needs to read cases.
    for (const persona of [PERSONAS.manager, PERSONAS.curator, PERSONAS.admin]) {
      expect((await api.get(persona, '/demo/state')).statusCode).toBe(200);
    }
  });

  it('rejects an unknown profile with a 422', async () => {
    const res = await api.post(PERSONAS.admin, '/demo/seed', { profile: 'everything' });
    expect(res.statusCode).toBe(422);
  });

  it('refuses to seed when a persona of the story is disabled, before anything is created', async () => {
    const set = (status: string) =>
      database.query(
        "UPDATE users SET status = $3, data = jsonb_set(data, '{status}', to_jsonb($3::text)) WHERE tenant_id = $1 AND id = $2",
        [CONTOSO, PERSONAS.curator, status],
      );
    await set('disabled');
    try {
      for (const profile of ['base', 'portfolio']) {
        const res = await api.post(PERSONAS.admin, '/demo/seed', { profile });
        expect(res.statusCode, profile).toBe(409);
        expect(res.data.detail).toMatch(/Casey \(skill curator\) is disabled/);
      }
    } finally {
      await set('active');
    }
    expect((await h.repos(CONTOSO).cases.counts()).total).toBe(0);
    const denied = await seedEvents('demo.seed');
    expect(denied.map((e) => [e.outcome, e.details])).toEqual([
      ['denied', { profile: 'base', reason: 'personas_unavailable' }],
      ['denied', { profile: 'portfolio', reason: 'personas_unavailable' }],
    ]);
  });
});

describe('[FR-DEMO-11] the base profile', () => {
  it('leaves the story at step one with the seed marker set (the default profile)', async () => {
    const res = await api.post(PERSONAS.admin, '/demo/seed');
    expect(res.statusCode).toBe(200);
    const guide = await demoState(api);
    expect(completedSteps(guide)).toEqual([]);
    expect(guide.steps.filter((step) => step.isNextAction).map((step) => step.order)).toEqual([1]);
    expect(guide.seededAt).toBe(h.clock.now().toISOString());
    expect(await h.repos(CONTOSO).demo.getSeedMarker()).toEqual({
      seededAt: guide.seededAt,
      profile: 'base',
    });
    const [event] = (await seedEvents('demo.seed')).slice(-1);
    expect(event).toMatchObject({
      outcome: 'success',
      actorId: PERSONAS.admin,
      details: { profile: 'base', cases: 0, skills: 0 },
    });
    // Seeding it again is harmless: still a clean workspace at step one.
    expect((await api.post(PERSONAS.admin, '/demo/seed', { profile: 'base' })).statusCode).toBe(
      200,
    );
    expect(completedSteps(await demoState(api))).toEqual([]);
  });
});

describe('[FR-DEMO-12] performing the story by hand moves the guide, from stored facts only', () => {
  it('import Case One: step 1 done, step 2 is next', async () => {
    const created = await api.post(PERSONAS.engineer, '/cases', {
      source: { type: 'sample', sampleId: STORY_CASES.one.sampleId },
      options: { analyze: false },
    });
    expect(created.statusCode).toBe(201);
    caseOneId = created.data.case.id;
    const guide = await demoState(api);
    expect(completedSteps(guide)).toEqual([1]);
    expect(guide.caseOneId).toBe(caseOneId);
    expect(guide.steps.find((step) => step.isNextAction)?.order).toBe(2);
    expect(guide.steps[1]?.route).toBe(`/cases/${caseOneId}/timeline`);
  });

  it(
    'analyse it: the timeline, ledger, hypotheses, forks and metrics are done; the review is next and unlocks the rest in order',
    { timeout: STORY_TIMEOUT_MS },
    async () => {
      const started = await api.post(PERSONAS.engineer, `/cases/${caseOneId}/analysis`, {});
      expect(started.statusCode).toBe(202);
      await settle(h);
      const guide = await demoState(api);
      expect(completedSteps(guide)).toEqual([1, 2, 3, 4, 5, 7]);
      expect(guide.steps.find((step) => step.isNextAction)?.id).toBe('accept-better-path');
      expect(guide.steps[6]).toMatchObject({ completed: true, enabled: true });
      for (const step of guide.steps.slice(7)) {
        expect(step, step.id).toMatchObject({
          enabled: false,
          lockedReason: 'Complete step 6 first: A better path simulated and accepted.',
        });
      }
    },
  );

  it('a reviewer accepting a path at a later fork does not complete step 6; the earliest fork does', async () => {
    const forks = await h.repos(CONTOSO).analysis.listForks(caseOneId);
    const earliest = forks.find((fork) => fork.isEarliestMeaningful);
    expect(earliest).toBeDefined();
    const all = await api.get(PERSONAS.reviewer, `/cases/${caseOneId}/counterfactuals`);
    const acceptable = (all.data.items as Json[]).filter(
      (item) =>
        item.reviewState === 'pending' &&
        item.status === 'completed' &&
        item.validity.valid &&
        item.boundary.leakCheck.passed,
    );
    const accept = async (scenario: Json) => {
      const res = await api.post(
        PERSONAS.reviewer,
        `/cases/${caseOneId}/counterfactuals/${scenario.id}/review`,
        { decision: 'accept', reason: REASON, expectedVersion: scenario.version },
      );
      expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
    };

    const elsewhere = acceptable.find((item) => item.forkId !== earliest?.id);
    if (elsewhere !== undefined) {
      await accept(elsewhere);
      expect(completedSteps(await demoState(api))).not.toContain(6);
    }
    const atEarliest = acceptable.filter((item) => item.forkId === earliest?.id);
    const chosen = atEarliest.find((item) => item.strategy === 'balanced') ?? atEarliest[0];
    expect(chosen).toBeDefined();
    await accept(chosen);
    acceptedScenarioId = chosen.id as string;
    const guide = await demoState(api);
    expect(completedSteps(guide)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(guide.steps.find((step) => step.isNextAction)?.id).toBe('generate-skill');
  });

  it(
    'extract the skill: step 8 is done, the skill id appears and the approval step is next',
    { timeout: STORY_TIMEOUT_MS },
    async () => {
      const extracted = await api.post(PERSONAS.engineer, `/cases/${caseOneId}/skills/extract`, {
        scenarioId: acceptedScenarioId,
      });
      expect(extracted.statusCode).toBe(202);
      await settle(h);
      const guide = await demoState(api);
      expect(completedSteps(guide)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(guide.skillId).not.toBeNull();
      skillId = guide.skillId ?? '';
      expect(guide.steps.find((step) => step.isNextAction)?.id).toBe('approve-skill');
      expect(guide.steps[8]?.route).toBe(`/skills/${skillId}`);
    },
  );
});

describe('[FR-DEMO-13] a half-seeded tenant is finished, never redone', () => {
  it('does not reset while a job is running, and says so (audited as denied)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = contextFor(h, PERSONAS.engineer);
    await h.infra.services.jobs.start(
      ctx,
      { kind: 'case_analysis', caseId: caseOneId, stages: [{ id: 'wait', label: 'Wait' }] },
      async (handle) => {
        await handle.stage('wait');
        await gate;
        return { resultRef: null };
      },
    );
    try {
      for (const [url, body] of [
        ['/demo/reset', {}],
        ['/demo/seed', { profile: 'base' }],
      ] as const) {
        const res = await api.post(PERSONAS.admin, url, body);
        expect(res.statusCode, url).toBe(409);
        expect(res.data.detail).toMatch(/job is still queued or running/);
      }
    } finally {
      release();
      await settle(h);
    }
    expect((await h.repos(CONTOSO).cases.counts()).total).toBe(1);
    expect((await seedEvents('demo.reset')).map((e) => [e.outcome, e.details])).toEqual([
      ['denied', { reason: 'job_active' }],
    ]);
  });

  it(
    'portfolio finishes the remaining steps as the story personas, reusing what exists',
    { timeout: STORY_TIMEOUT_MS },
    async () => {
      const res = await api.post(PERSONAS.admin, '/demo/seed', { profile: 'portfolio' });
      expect(res.statusCode, `${JSON.stringify(res.data)}\n${errorLines(h)}`).toBe(200);
      const guide = await demoState(api);
      expect(completedSteps(guide)).toEqual(guide.steps.map((step) => step.order));
      expect(guide.caseOneId).toBe(caseOneId);
      expect(guide.skillId).toBe(skillId);

      expect((await h.repos(CONTOSO).cases.counts()).total).toBe(2);
      expect((await h.repos(CONTOSO).skills.list({ limit: 10 })).items).toHaveLength(1);
      const [job] = (await api.get(PERSONAS.engineer, '/jobs?kind=demo_seed')).data.items as Json[];
      const status = (id: string): string | undefined =>
        (job.progress.stages as Json[]).find((stage) => stage.id === id)?.status as
          string | undefined;
      for (const reused of ['import-one', 'analyse-one', 'accept-path', 'extract-skill'])
        expect(status(reused), reused).toBe('skipped');
      for (const done of ['draft-skill', 'publish', 'import-two', 'analyse-two', 'apply-skill'])
        expect(status(done), done).toBe('done');

      const audit = await allAudit(h);
      const by = (action: string) =>
        audit.filter((event) => event.action === action).map((event) => event.actorId);
      expect(by('case.ingested')).toEqual([PERSONAS.engineer, PERSONAS.engineer]);
      expect(by('skill.published')).toEqual([PERSONAS.admin]);
      const [seed] = (await seedEvents('demo.seed')).slice(-1);
      expect(seed?.details).toMatchObject({ profile: 'portfolio', caseOneId, skillId });
      expect(Number((seed?.details as Json).skipped)).toBeGreaterThanOrEqual(4);
    },
  );
});

describe('[FR-DEMO-14] reset', () => {
  it('erases the case data, the marker and the stored payloads, and keeps users, settings and the audit trail', async () => {
    const repos = h.repos(CONTOSO);
    const users = (await repos.governance.listUsers()).map((user) => user.id).sort();
    const settings = await repos.governance.getSettings();
    const caseIds = (await repos.cases.list({ limit: 10 })).items.map((item) => item.id);
    const sources = await Promise.all(caseIds.map((id) => repos.cases.getSource(id)));
    const keys = sources.map((source) => source?.storageRef ?? '');
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(await h.infra.objects.exists(key), key).toBe(true);
    const auditBefore = (await allAudit(h)).length;

    const res = await api.post(PERSONAS.admin, '/demo/reset');
    expect(res.statusCode).toBe(200);
    const guide = await demoState(api);
    expect(completedSteps(guide)).toEqual([]);
    expect(guide).toMatchObject({
      seededAt: null,
      caseOneId: null,
      caseTwoId: null,
      skillId: null,
    });
    expect(guide.steps.filter((step) => step.isNextAction).map((step) => step.order)).toEqual([1]);

    expect((await repos.cases.counts()).total).toBe(0);
    expect((await repos.skills.list({ limit: 10 })).items).toEqual([]);
    expect((await repos.jobs.list({ limit: 10 })).items).toEqual([]);
    expect(await repos.demo.getSeedMarker()).toBeNull();
    for (const key of keys) expect(await h.infra.objects.exists(key), key).toBe(false);
    expect((await repos.governance.listUsers()).map((user) => user.id).sort()).toEqual(users);
    expect((await repos.governance.getSettings()).model.version).toBe(settings.model.version);

    const resets = await seedEvents('demo.reset');
    expect(resets.filter((e) => e.outcome === 'success').map((e) => e.details)).toEqual([
      { phase: 'started' },
      { phase: 'completed', cases: 2, skills: 1, payloadsRemoved: 2, payloadsKept: 0 },
    ]);
    expect((await allAudit(h)).length).toBeGreaterThan(auditBefore);
    expect((await repos.audit.verify()).valid).toBe(true);
  });

  it('is what the base profile does too: a seeded workspace goes back to step one', async () => {
    const created = await api.post(PERSONAS.engineer, '/cases', {
      source: { type: 'sample', sampleId: STORY_CASES.one.sampleId },
      options: { analyze: false },
    });
    expect(created.statusCode).toBe(201);
    expect(completedSteps(await demoState(api))).toEqual([1]);
    expect((await api.post(PERSONAS.admin, '/demo/seed', { profile: 'base' })).statusCode).toBe(
      200,
    );
    expect(completedSteps(await demoState(api))).toEqual([]);
    expect((await h.repos(CONTOSO).cases.counts()).total).toBe(0);
  });
});

describe('[FR-DEMO-15] only in a synthetic demo tenant', () => {
  const flag = (synthetic: boolean) =>
    database.query(
      "UPDATE tenants SET synthetic = $2, data = jsonb_set(data, '{synthetic}', to_jsonb($2::boolean)) WHERE id = $1",
      [CONTOSO, synthetic],
    );

  it('answers 409 and audits a denial when demo mode is off and the tenant is not flagged synthetic', async () => {
    const created = await api.post(PERSONAS.engineer, '/cases', {
      source: { type: 'sample', sampleId: STORY_CASES.two.sampleId },
      options: { analyze: false },
    });
    expect(created.statusCode).toBe(201);
    await flag(false);
    try {
      const strict = await createHarness({ database, env: { DEMO_MODE: 'false' } });
      harnesses.push(strict);
      const strictApi = apiOf(strict);

      for (const [url, body] of [
        ['/demo/seed', { profile: 'base' }],
        ['/demo/seed', { profile: 'portfolio' }],
        ['/demo/reset', {}],
      ] as const) {
        const res = await strictApi.post(PERSONAS.admin, url, body);
        expect(res.statusCode, `${url} ${JSON.stringify(body)}`).toBe(409);
        expect(res.data).toMatchObject({ code: 'conflict', detail: NOT_A_DEMO_TENANT });
      }
      expect((await h.repos(CONTOSO).cases.counts()).total).toBe(1);
      const denials = (await allAudit(h)).filter(
        (e) => e.outcome === 'denied' && e.details.reason === 'not_a_demo_tenant',
      );
      expect(denials.map((e) => [e.action, e.actorId]).sort()).toEqual([
        ['demo.reset', PERSONAS.admin],
        ['demo.seed', PERSONAS.admin],
        ['demo.seed', PERSONAS.admin],
      ]);

      // Demo mode on is enough on its own (configuration refuses it in production).
      const lenient = await createHarness({ database, env: { DEMO_MODE: 'true' } });
      harnesses.push(lenient);
      expect(
        (await apiOf(lenient).post(PERSONAS.admin, '/demo/seed', { profile: 'base' })).statusCode,
      ).toBe(200);
      expect((await h.repos(CONTOSO).cases.counts()).total).toBe(0);
    } finally {
      await flag(true);
    }
  });
});
