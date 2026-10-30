/* eslint-disable @typescript-eslint/no-unsafe-return -- response bodies are parsed JSON, typed `Json` by the harness */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, SkillMatch } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { ENGINE_BUDGET_WINDOW_MS, engineBudgetFor } from '../src/services/engine-budget';
import { CaseMatcher } from '../src/services/skills/matching';
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
import { buildIngestInput } from './builders';
import {
  acceptScenario,
  allAuditEvents,
  apiOf,
  earliestForkScenarios,
  ingestAndAnalyse,
  ingestIrrelevantCase,
  moveSkill,
  runValidation,
  settledJob,
  type TestApi,
} from './skills-support';

const ONE = 'case_sk_one';
const TWO = 'case_sk_two';
const IRR = 'case_sk_irrelevant';
const RAW = 'case_sk_raw';
const REASON = 'MARKER-SKILL-8e21 reviewed against the recorded steps';

let database: Database;
let h: Harness;
let api: TestApi;
let forkId = '';
let skillA = ''; // extracted by the engineer (Ava) from the balanced scenario; published below
let skillB = ''; // extracted by the curator (Casey) from the lowest-customer-effort scenario
let rejectedScenario: Json;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  api = apiOf(h);
  // Case data is dated April 2026, so "now" is after it, as it is for historical cases in real use.
  h.clock.set('2026-06-01T09:00:00.000Z');
  await ingestAndAnalyse(h, { one: ONE, two: TWO });
  await ingestIrrelevantCase(h, IRR);
  await h
    .repos(CONTOSO)
    .cases.ingest(buildIngestInput({ tenantId: CONTOSO, caseId: RAW, receivedSeed: 'raw' }));

  const found = await earliestForkScenarios(h, api, ONE);
  forkId = found.forkId;
  const pick = (strategy: string): Json => found.scenarios.find((s) => s.strategy === strategy);
  expect((await acceptScenario(api, ONE, pick('balanced'))).statusCode).toBe(200);
  expect((await acceptScenario(api, ONE, pick('lowest_customer_effort'))).statusCode).toBe(200);
  const rejected = await api.post(
    PERSONAS.reviewer,
    `/cases/${ONE}/counterfactuals/${pick('fastest_diagnosis').id}/review`,
    {
      decision: 'reject',
      reason: 'Unrealistic for this customer: the second request would not be answered in time.',
      expectedVersion: pick('fastest_diagnosis').version,
    },
  );
  rejectedScenario = rejected.data;

  const extractAs = async (persona: string, scenarioId: string): Promise<string> => {
    const res = await api.post(persona, `/cases/${ONE}/skills/extract`, { scenarioId });
    expect(res.statusCode).toBe(202);
    const job = await settledJob(h, api, res.data.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    return job.resultRef.id as string;
  };
  skillA = await extractAs(PERSONAS.engineer, pick('balanced').id);
  skillB = await extractAs(PERSONAS.curator, pick('lowest_customer_effort').id);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

const audits = (tenantId = CONTOSO) => allAuditEvents(h, tenantId);
const detailOf = async (skillId: string, persona: string = PERSONAS.engineer): Promise<Json> =>
  (await api.get(persona, `/skills/${skillId}`)).data;

describe('skills.list, skills.get, skills.versions and skills.diff', () => {
  it('lists the library for every reader, filters it and pages through it', async () => {
    expect((await api.get(null, '/skills')).statusCode).toBe(401);
    for (const persona of [
      PERSONAS.engineer,
      PERSONAS.reviewer,
      PERSONAS.manager,
      PERSONAS.curator,
      PERSONAS.admin,
    ]) {
      const res = await api.get(persona, '/skills');
      expect(res.statusCode, persona).toBe(200);
      expect(res.data.items.map((s: Json) => s.id).sort()).toEqual([skillA, skillB].sort());
    }
    expect(
      (await api.get(PERSONAS.engineer, '/skills?lifecycle=discovered')).data.items,
    ).toHaveLength(2);
    expect((await api.get(PERSONAS.engineer, '/skills?lifecycle=published')).data.items).toEqual(
      [],
    );
    expect(
      (await api.get(PERSONAS.engineer, '/skills?q=no-such-skill-anywhere')).data.items,
    ).toEqual([]);
    expect((await api.get(PERSONAS.engineer, '/skills?lifecycle=bogus')).statusCode).toBe(422);

    const first = await api.get(PERSONAS.engineer, '/skills?limit=1');
    expect(first.data.items).toHaveLength(1);
    expect(first.data.nextCursor).toEqual(expect.any(String));
    const second = await api.get(
      PERSONAS.engineer,
      `/skills?limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`,
    );
    expect(second.data.items).toHaveLength(1);
    expect(second.data.items[0].id).not.toBe(first.data.items[0].id);
  });

  it('shows one skill with its versions, history and the steps this caller may take', async () => {
    const asCreator = await detailOf(skillA);
    expect(asCreator.skill).toMatchObject({
      id: skillA,
      lifecycle: 'discovered',
      currentVersion: '1.0.0',
      createdBy: PERSONAS.engineer,
      owner: PERSONAS.engineer,
      hasProposedMutation: false,
      synthetic: true,
    });
    expect(asCreator.currentVersion.content.decisionSequence.length).toBeGreaterThan(0);
    expect(asCreator).toMatchObject({
      proposedVersion: null,
      validations: [],
      approvals: [],
      matches: [],
    });
    expect(asCreator.versions).toHaveLength(1);
    expect(asCreator.versions[0]).not.toHaveProperty('content');
    expect(asCreator.notices.join(' ')).toMatch(/never published automatically/);

    // The person who created a skill cannot record an approval for it: the option says so.
    const draftOption = asCreator.transitions.find((t: Json) => t.toState === 'draft');
    expect(draftOption).toMatchObject({ allowed: false, requiredPermission: 'skill:extract' });
    expect(draftOption.reason).toMatch(/created the skill cannot record an approval/);
    const retire = asCreator.transitions.find((t: Json) => t.toState === 'retired');
    expect(retire).toMatchObject({ allowed: false });
    expect(retire.reason).toMatch(/skill:retire/);

    const asCurator = await detailOf(skillA, PERSONAS.curator);
    expect(asCurator.transitions.find((t: Json) => t.toState === 'draft')).toMatchObject({
      allowed: true,
      reason: null,
    });
    expect(asCurator.transitions.find((t: Json) => t.toState === 'retired')).toMatchObject({
      allowed: true,
    });
  });

  it('404s on unknown skills and across tenants, and lists versions and diffs', async () => {
    const eve = PERSONAS.otherTenantEngineer;
    expect((await api.get(PERSONAS.engineer, '/skills/skl_missing')).statusCode).toBe(404);
    expect((await api.get(eve, `/skills/${skillA}`)).statusCode).toBe(404);
    expect((await api.get(eve, `/skills/${skillA}/versions`)).statusCode).toBe(404);

    const versions = await api.get(PERSONAS.manager, `/skills/${skillA}/versions`);
    expect(versions.statusCode).toBe(200);
    expect(versions.data.items).toHaveLength(1);
    const v1 = versions.data.items[0];
    expect(v1).toMatchObject({
      version: '1.0.0',
      state: 'active',
      changeType: 'initial',
      sequence: 1,
    });
    expect(v1.content.name).toEqual(expect.any(String));

    const same = await api.get(
      PERSONAS.engineer,
      `/skills/${skillA}/diff?fromVersionId=${v1.id}&toVersionId=${v1.id}`,
    );
    expect(same.statusCode).toBe(200);
    expect(same.data).toMatchObject({
      skillId: skillA,
      fromVersion: '1.0.0',
      toVersion: '1.0.0',
      changes: [],
    });
    expect(
      (
        await api.get(
          PERSONAS.engineer,
          `/skills/${skillA}/diff?fromVersionId=${v1.id}&toVersionId=nope`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await api.get(PERSONAS.engineer, `/skills/${skillA}/diff?fromVersionId=${v1.id}`))
        .statusCode,
    ).toBe(422);
    expect(
      (await api.get(eve, `/skills/${skillA}/diff?fromVersionId=${v1.id}&toVersionId=${v1.id}`))
        .statusCode,
    ).toBe(404);
  });
});

describe('skills.extract', () => {
  it('is for people who may extract, and refuses what is not accepted with every reason the engine gave', async () => {
    const url = `/cases/${ONE}/skills/extract`;
    expect((await api.post(null, url, { scenarioId: rejectedScenario.id })).statusCode).toBe(401);
    for (const persona of [PERSONAS.reviewer, PERSONAS.manager]) {
      expect(
        (await api.post(persona, url, { scenarioId: rejectedScenario.id })).statusCode,
        persona,
      ).toBe(403);
    }
    expect((await api.post(PERSONAS.engineer, url, {})).statusCode).toBe(422);
    expect((await api.post(PERSONAS.engineer, url, { scenarioId: 'scn_missing' })).statusCode).toBe(
      404,
    );
    expect(
      (await api.post(PERSONAS.engineer, `/cases/case_missing/skills/extract`, { scenarioId: 'x' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.post(PERSONAS.otherTenantEngineer, url, { scenarioId: rejectedScenario.id }))
        .statusCode,
    ).toBe(404);

    const refused = await api.post(PERSONAS.engineer, url, { scenarioId: rejectedScenario.id });
    expect(refused.statusCode).toBe(422);
    const reasons = refused.data.errors.map((e: Json) => e.message);
    expect(reasons).toContain('A reviewer rejected this scenario.');
    expect(reasons).toContain('The scenario has not been accepted by a reviewer yet.');
    expect(
      refused.data.errors.every((e: Json) => e.path === `scenario.${rejectedScenario.id}`),
    ).toBe(true);
    expect((await api.get(PERSONAS.engineer, '/skills')).data.items).toHaveLength(2);
  });

  it('is idempotent with and without an Idempotency-Key, and extractForCase uses every accepted scenario', async () => {
    const scenarios = (
      await api.get(PERSONAS.engineer, `/cases/${ONE}/counterfactuals?forkId=${forkId}`)
    ).data.items as Json[];
    const accepted = scenarios.find((s) => s.reviewState === 'confirmed');
    const url = `/cases/${ONE}/skills/extract`;
    const key = 'idem-skill-extract-0001';
    const first = await api.post(
      PERSONAS.engineer,
      url,
      { scenarioId: accepted.id },
      { 'idempotency-key': key },
    );
    expect(first.statusCode).toBe(202);
    const replay = await api.post(
      PERSONAS.engineer,
      url,
      { scenarioId: accepted.id },
      { 'idempotency-key': key },
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.data).toEqual(first.data);
    const clash = await api.post(
      PERSONAS.engineer,
      url,
      { scenarioId: scenarios.find((s) => s.id !== accepted.id)?.id },
      { 'idempotency-key': key },
    );
    expect(clash.statusCode).toBe(422);
    expect(clash.data.code).toBe('idempotency_conflict');
    await h.infra.services.jobs.idle();
    expect((await api.get(PERSONAS.engineer, '/skills')).data.items).toHaveLength(2);

    const ctx = contextFor(h, PERSONAS.engineer);
    const skills = await ctx.services.skills.extractForCase(ctx, ONE);
    expect(skills.map((s) => s.id).sort()).toEqual([skillA, skillB].sort());
    const twoCtx = contextFor(h, PERSONAS.engineer);
    await expect(twoCtx.services.skills.extractForCase(twoCtx, TWO)).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/No scenario of this case has been accepted/),
    });
  });

  it('audits the extraction with ids only', async () => {
    const extracted = (await audits()).filter((e) => e.action === 'skill.extracted');
    expect(extracted.map((e) => e.targetId).sort()).toEqual([skillA, skillB].sort());
    expect(extracted[0]).toMatchObject({ outcome: 'success', caseId: ONE });
    expect(Object.keys(extracted[0]?.details ?? {}).sort()).toEqual([
      'forkId',
      'lifecycle',
      'scenarioIds',
      'skillId',
      'version',
      'versionId',
    ]);
    expect(
      (await audits()).filter((e) => e.action === 'skill.extraction_requested').length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('skills.transition', () => {
  it('checks the body, the skill and the caller before anything changes', async () => {
    const url = `/skills/${skillB}/transition`;
    const ok = { toState: 'draft', reason: REASON, expectedVersion: 1 };
    expect((await api.post(null, url, ok)).statusCode).toBe(401);
    for (const persona of [PERSONAS.engineer, PERSONAS.manager]) {
      expect((await api.post(persona, url, ok)).statusCode, persona).toBe(403);
    }
    expect((await api.post(PERSONAS.curator, url, { ...ok, toState: 'frozen' })).statusCode).toBe(
      422,
    );
    expect((await api.post(PERSONAS.curator, url, { ...ok, reason: 'no' })).statusCode).toBe(422);
    expect((await api.post(PERSONAS.curator, url, { ...ok, expectedVersion: 0 })).statusCode).toBe(
      422,
    );
    expect(
      (await api.post(PERSONAS.curator, '/skills/skl_missing/transition', ok)).statusCode,
    ).toBe(404);
    expect((await api.post(PERSONAS.otherTenantEngineer, url, ok)).statusCode).toBe(403);
    expect((await detailOf(skillB)).skill).toMatchObject({ lifecycle: 'discovered', version: 1 });
  });

  it('refuses the creator’s own approval as a separation-of-duties denial, audited', async () => {
    const res = await moveSkill(api, PERSONAS.curator, skillB, 'draft', REASON);
    expect(res.statusCode).toBe(403);
    expect(res.data.code).toBe('forbidden');
    expect(res.data.reason).toBe('separation_of_duties');
    expect(res.data.detail).toMatch(/created the skill cannot record an approval/);
    const denied = (await audits()).filter(
      (e) => e.action === 'skill.transition_denied' && e.targetId === skillB,
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      outcome: 'denied',
      actorId: PERSONAS.curator,
      details: { code: 'separation_of_duties', fromState: 'discovered', toState: 'draft' },
    });
    expect((await detailOf(skillB, PERSONAS.curator)).skill.lifecycle).toBe('discovered');
  });

  it('a stale version or an unknown move changes nothing; withdrawing a skill is recorded as a rejection', async () => {
    const stale = await api.post(PERSONAS.curator, `/skills/${skillB}/transition`, {
      toState: 'retired',
      reason: REASON,
      expectedVersion: 9,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.data.code).toBe('version_conflict');
    expect((await detailOf(skillB)).skill.lifecycle).toBe('discovered');
    // The version the caller saw is the lock: two people acting on the same view cannot both succeed.
    const seen = (await detailOf(skillA)).skill.version as number;
    const results = await Promise.all([
      api.post(PERSONAS.curator, `/skills/${skillA}/transition`, {
        toState: 'draft',
        reason: REASON,
        expectedVersion: seen,
      }),
      api.post(PERSONAS.admin, `/skills/${skillA}/transition`, {
        toState: 'draft',
        reason: REASON,
        expectedVersion: seen,
      }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(['conflict', 'version_conflict']).toContain(
      results.find((r) => r.statusCode === 409)?.data.code,
    );
    expect((await detailOf(skillA)).skill).toMatchObject({ lifecycle: 'draft', version: seen + 1 });
    // A legal step taken on a stale view is a version conflict, audited as a failure.
    const late = await api.post(PERSONAS.reviewer, `/skills/${skillA}/transition`, {
      toState: 'simulation_tested',
      reason: REASON,
      expectedVersion: seen,
    });
    expect(late.statusCode).toBe(409);
    expect(late.data.code).toBe('version_conflict');
    expect((await detailOf(skillA)).skill.lifecycle).toBe('draft');
  });
});

describe('a published skill: matching, applying and effectiveness', () => {
  it('walks skill A to published through the real gates', { timeout: 120_000 }, async () => {
    // Skill A is already a draft (above); the helper continues from there with the required people.
    await publishAfterDraft();
    expect((await detailOf(skillA)).skill).toMatchObject({
      lifecycle: 'published',
      validationStatus: 'validated',
    });
  });

  async function publishAfterDraft(): Promise<void> {
    const drive = async (persona: string, toState: string): Promise<void> => {
      h.clock.advance(60_000);
      const res = await moveSkill(api, persona, skillA, toState);
      expect(res.statusCode, `${toState}: ${JSON.stringify(res.data)}`).toBe(200);
    };
    const check = async (persona: string, kind: string): Promise<void> => {
      h.clock.advance(60_000);
      expect((await runValidation(api, persona, skillA, { kind })).statusCode).toBe(200);
    };
    await check(PERSONAS.reviewer, 'simulation_test');
    await drive(PERSONAS.reviewer, 'simulation_tested');
    await drive(PERSONAS.reviewer, 'expert_reviewed');
    await drive(PERSONAS.curator, 'pilot');
    await check(PERSONAS.reviewer, 'regression');
    await drive(PERSONAS.reviewer, 'validated');
    await drive(PERSONAS.admin, 'published');
  }

  it('lists matches for the whole case and as of a moment, and a read never stores or audits anything', async () => {
    const url = `/cases/${TWO}/skill-matches`;
    expect((await api.get(null, url)).statusCode).toBe(401);
    expect((await api.get(PERSONAS.engineer, `/cases/case_missing/skill-matches`)).statusCode).toBe(
      404,
    );
    expect((await api.get(PERSONAS.otherTenantEngineer, url)).statusCode).toBe(404);
    expect((await api.get(PERSONAS.engineer, `${url}?asOf=yesterday`)).statusCode).toBe(422);
    expect((await api.get(PERSONAS.engineer, `/cases/${RAW}/skill-matches`)).data.items).toEqual(
      [],
    );

    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    const first = events[0]?.timestamp ?? '';
    const last = events[events.length - 1]?.timestamp ?? '';
    const storedBefore = await h.repos(CONTOSO).skills.listMatchesForCase(TWO);
    const auditsBefore = (await audits()).length;

    const whole = await api.get(PERSONAS.manager, url);
    expect(whole.statusCode).toBe(200);
    expect(whole.data.items).toHaveLength(1);
    expect(whole.data.items[0]).toMatchObject({
      skillId: skillA,
      lifecycle: 'published',
      applicability: 'applies',
      asOf: last,
      applied: false,
    });
    // The id is deterministic: the same read, by anyone, names the same match.
    const again = await api.get(PERSONAS.engineer, url);
    expect(again.data).toEqual(whole.data);

    const early = await api.get(PERSONAS.engineer, `${url}?asOf=${first}`);
    expect(early.data.items[0]).toMatchObject({ applicability: 'applies', asOf: first });
    expect(early.data.items[0].id).toBe(whole.data.items[0].id);
    // Before the first event nothing is known, so a skill with required triggers cannot apply.
    const before = await api.get(PERSONAS.engineer, `${url}?asOf=2000-01-01T00:00:00Z`);
    expect(before.data.items[0]).toMatchObject({ applicability: 'not_applicable', score: 0 });
    // Beyond the last event is the whole case again (and keeps the last event as its evidence cut).
    const beyond = await api.get(PERSONAS.engineer, `${url}?asOf=2099-01-01T00:00:00Z`);
    expect(beyond.data.items[0].asOf).toBe(last);

    // Reading is not a state change: nothing was stored (Case Two was analysed before the skill
    // existed) and nothing was audited, whoever read it.
    expect(await h.repos(CONTOSO).skills.listMatchesForCase(TWO)).toEqual(storedBefore);
    expect(storedBefore).toEqual([]);
    expect((await audits()).length).toBe(auditsBefore);
  });

  it('never shows a skill while time-travelling over the case it was extracted from', async () => {
    const url = `/cases/${ONE}/skill-matches`;
    const events = await h.repos(CONTOSO).cases.getAllEvents(ONE);
    const early = events[2]?.timestamp ?? ''; // three events in: the name-resolution failure is not known yet
    const res = await api.get(PERSONAS.engineer, `${url}?asOf=${early}`);
    expect(res.statusCode).toBe(200);
    // No match, and no trace of the skill: its triggers were learned partly from what came later.
    expect(res.data.items).toEqual([]);
    expect(res.body).not.toMatch(/hindsight-informed|name-resolution|DNS, proxy or filtering/);
    expect(JSON.stringify(res.data)).not.toContain(skillA);
    for (const at of [events[0]?.timestamp, events[events.length - 1]?.timestamp]) {
      expect((await api.get(PERSONAS.engineer, `${url}?asOf=${at}`)).data.items).toEqual([]);
    }
    // The whole case is not time travel: the skill is matched there like any other.
    const whole = await api.get(PERSONAS.engineer, url);
    expect(whole.data.items.map((m: Json) => m.skillId)).toEqual([skillA]);
    expect(whole.data.items[0].applicability).not.toBe('not_applicable');
    // Another case is unaffected: Case Two still matches as of its first email, at the engine's score.
    const twoEvents = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    const second = await api.get(
      PERSONAS.engineer,
      `/cases/${TWO}/skill-matches?asOf=${twoEvents[0]?.timestamp}`,
    );
    expect(second.data.items[0]).toMatchObject({ skillId: skillA, applicability: 'applies' });
    expect(second.data.items[0].score).toBeGreaterThan(0.7);
    expect(second.data.items[0].score).toBeLessThan(0.8);
  });

  it('answers every instant between two events with one matching pass, canonicalised to the last event seen', async () => {
    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    const [a, b] = [events[0]?.timestamp ?? '', events[1]?.timestamp ?? ''];
    const ms = (iso: string, delta: number) => new Date(Date.parse(iso) + delta).toISOString();
    expect(Date.parse(b) - Date.parse(a)).toBeGreaterThan(2_000);
    const matcher = new CaseMatcher();
    const ctx = contextFor(h, PERSONAS.engineer);
    // The same instant written three ways, and instants up to the next event.
    const exact = ms(a, 0);
    const asked = [
      exact,
      exact.replace('.000Z', 'Z'),
      exact.replace('.000Z', '.0000Z'),
      ms(a, 1),
      ms(a, 1_000),
      ms(b, -1),
    ];
    const results: SkillMatch[][] = [];
    for (const asOf of asked) results.push(await matcher.compute(ctx, TWO, { asOf }));
    expect(matcher.passes).toBe(1);
    for (const matches of results) {
      expect(matches).toEqual(results[0]);
      expect(matches[0]?.asOf).toBe(a);
    }
    // The next event is different evidence, so it is another pass; asking again is not.
    await matcher.compute(ctx, TWO, { asOf: b });
    await matcher.compute(ctx, TWO, { asOf: ms(b, 1) });
    expect(matcher.passes).toBe(2);
    expect((await matcher.compute(ctx, TWO, { asOf: b }))[0]?.asOf).toBe(b);
  });

  it('spends the caller’s engine budget on a matching pass no cache can serve, and refuses an empty budget before any work', async () => {
    const budget = engineBudgetFor(h.infra);
    const callerOf = (userId: string) => ({
      auth: { tenantId: CONTOSO, userId },
      now: () => h.clock.now(),
    });
    const [engineer, manager] = [callerOf(PERSONAS.engineer), callerOf(PERSONAS.manager)];
    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    const asOf = (index: number) => `/cases/${TWO}/skill-matches?asOf=${events[index]?.timestamp}`;
    h.clock.advance(ENGINE_BUDGET_WINDOW_MS); // every bucket is full again
    const wholeCase = `/cases/${TWO}/skill-matches`;
    const matchId = (await api.get(PERSONAS.engineer, wholeCase)).data.items[0].id as string;

    // A window nobody has computed costs the caller one unit; asking for it again is free.
    const start = budget.remaining(engineer);
    expect(start).toBeGreaterThan(budget.passes - 2);
    expect((await api.get(PERSONAS.engineer, asOf(3))).statusCode).toBe(200);
    expect(budget.remaining(engineer)).toBe(start - 1);
    expect((await api.get(PERSONAS.engineer, asOf(3))).statusCode).toBe(200);
    expect(budget.remaining(engineer)).toBe(start - 1);

    // Someone who has used their allowance up still gets what is cached, and what costs nothing.
    budget.charge(manager, budget.remaining(manager));
    const storedBefore = await h.repos(CONTOSO).skills.listMatchesForCase(TWO);
    const auditsBefore = (await audits()).length;
    expect((await api.get(PERSONAS.manager, asOf(3))).statusCode).toBe(200);
    const nothingKnown = `/cases/${TWO}/skill-matches?asOf=2000-01-01T00:00:00Z`;
    expect((await api.get(PERSONAS.manager, nothingKnown)).statusCode).toBe(200);
    expect(budget.remaining(manager)).toBe(0);

    // A new window is refused before the engine runs, as a problem that names nobody.
    const refused = await api.get(PERSONAS.manager, asOf(5));
    expect(refused.statusCode).toBe(429);
    expect(refused.data.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.body).not.toContain(PERSONAS.manager);
    expect(budget.remaining(manager)).toBe(0);
    // Nobody else is slowed down, and nothing was stored or audited by any of it.
    expect((await api.get(PERSONAS.engineer, asOf(5))).statusCode).toBe(200);
    expect(await h.repos(CONTOSO).skills.listMatchesForCase(TWO)).toEqual(storedBefore);
    expect((await audits()).length).toBe(auditsBefore);

    // Work the service does for itself (seeding, jobs) is not metered: it passes no hook.
    const ctx = contextFor(h, PERSONAS.manager);
    await expect(
      ctx.services.skills.matchForCase(ctx, TWO, { asOf: events[6]?.timestamp }),
    ).resolves.toHaveLength(1);
    expect(budget.remaining(manager)).toBe(0);

    // Measuring a first application replays the case, so it is metered too, and an empty budget
    // refuses it before anything is stored.
    budget.charge(engineer, budget.remaining(engineer));
    const apply = await api.post(PERSONAS.engineer, `/cases/${TWO}/skills/apply`, {
      skillId: skillA,
    });
    expect(apply.statusCode, JSON.stringify(apply.data)).toBe(429);
    expect(apply.data.code).toBe('rate_limited');
    const viaMatch = await api.post(
      PERSONAS.engineer,
      `/cases/${TWO}/skill-matches/${matchId}/apply`,
    );
    expect(viaMatch.statusCode, JSON.stringify(viaMatch.data)).toBe(429);
    expect(await h.repos(CONTOSO).skills.listMatchesForCase(TWO)).toEqual(storedBefore);
    expect((await audits()).filter((e) => e.action === 'skill.applied')).toEqual([]);

    h.clock.advance(ENGINE_BUDGET_WINDOW_MS);
    expect(budget.remaining(engineer)).toBe(budget.passes);
    expect(budget.remaining(manager)).toBe(budget.passes);
  });

  it('does not match what the skill has nothing to do with', async () => {
    const res = await api.get(PERSONAS.engineer, `/cases/${IRR}/skill-matches`);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0]).toMatchObject({ applicability: 'not_applicable' });
    // The read stored nothing. Analysing the case again (the library changed) is what stores the match.
    expect(await h.repos(CONTOSO).skills.listMatchesForCase(IRR)).toEqual([]);
    const ctx = contextFor(h, PERSONAS.engineer);
    await ctx.services.analysis.analyzeCase(ctx, IRR);
    const stored = await h.repos(CONTOSO).skills.listMatchesForCase(IRR);
    expect(stored.map((m) => [m.skillId, m.applicability])).toEqual([[skillA, 'not_applicable']]);
  });

  it('refuses to apply what cannot be applied: not analysed, not applicable, not yet piloted, no permission', async () => {
    const apply = (persona: string | null, caseId: string, skillId: string) =>
      api.post(persona, `/cases/${caseId}/skills/apply`, { skillId });
    expect((await apply(null, TWO, skillA)).statusCode).toBe(401);
    for (const persona of [PERSONAS.reviewer, PERSONAS.manager]) {
      expect((await apply(persona, TWO, skillA)).statusCode, persona).toBe(403);
    }
    expect((await api.post(PERSONAS.engineer, `/cases/${TWO}/skills/apply`, {})).statusCode).toBe(
      422,
    );
    expect((await apply(PERSONAS.engineer, TWO, 'skl_missing')).statusCode).toBe(404);
    expect((await apply(PERSONAS.engineer, 'case_missing', skillA)).statusCode).toBe(404);
    expect((await apply(PERSONAS.otherTenantEngineer, TWO, skillA)).statusCode).toBe(404);

    const draft = await apply(PERSONAS.engineer, TWO, skillB);
    expect(draft.statusCode).toBe(409);
    expect(draft.data.detail).toMatch(/Only pilot, validated or published skills/);
    const raw = await apply(PERSONAS.engineer, RAW, skillA);
    expect(raw.statusCode).toBe(409);
    expect(raw.data.detail).toMatch(/not been analysed/);
    const irrelevant = await apply(PERSONAS.engineer, IRR, skillA);
    expect(irrelevant.statusCode).toBe(409);
    expect(irrelevant.data.detail).toMatch(/does not apply/);
    expect((await audits()).filter((e) => e.action === 'skill.applied')).toEqual([]);
  });

  it('applies a skill to a case once, with conformance and effectiveness, and records who and when', async () => {
    h.clock.advance(60_000);
    const budget = engineBudgetFor(h.infra);
    const engineer = {
      auth: { tenantId: CONTOSO, userId: PERSONAS.engineer },
      now: () => h.clock.now(),
    };
    // Matching the case is cached from here on, so what the application spends is its own.
    await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`);
    const unitsBefore = budget.remaining(engineer);
    const res = await api.post(PERSONAS.engineer, `/cases/${TWO}/skills/apply`, {
      skillId: skillA,
    });
    expect(res.statusCode).toBe(200);
    // Two cold passes were announced to the caller's budget: measuring the case, and (once) the recorded
    // path of the case the skill came from, which its effectiveness is also compared with.
    expect(unitsBefore - budget.remaining(engineer)).toBe(2);
    expect(res.data).toMatchObject({
      caseId: TWO,
      skillId: skillA,
      applicability: 'applies',
      applied: true,
      appliedBy: PERSONAS.engineer,
    });
    expect(res.data.conformance).toMatchObject({
      stepsTotal: expect.any(Number),
      score: expect.any(Number),
    });
    expect(res.data.conformance.stepsFollowed).toBeLessThanOrEqual(res.data.conformance.stepsTotal);

    h.clock.advance(60_000);
    const again = await api.post(PERSONAS.curator, `/cases/${TWO}/skills/apply`, {
      skillId: skillA,
    });
    expect(again.statusCode).toBe(200);
    expect(again.data).toEqual(res.data);
    const viaMatch = await api.post(
      PERSONAS.admin,
      `/cases/${TWO}/skill-matches/${res.data.id}/apply`,
    );
    expect(viaMatch.statusCode).toBe(200);
    expect(viaMatch.data.appliedAt).toBe(res.data.appliedAt);
    const applications = (await audits()).filter(
      (e) => e.action === 'skill.applied' && e.caseId === TWO,
    );
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({ actorId: PERSONAS.engineer, outcome: 'success' });

    // Applying again is not a cold pass, so it is not refused when the caller's budget is empty.
    await api.get(PERSONAS.manager, `/cases/${TWO}/skill-matches`);
    budget.charge(engineer, budget.remaining(engineer));
    const free = await api.post(PERSONAS.engineer, `/cases/${TWO}/skills/apply`, {
      skillId: skillA,
    });
    expect(free.statusCode, JSON.stringify(free.data)).toBe(200);
    expect(free.data).toEqual(res.data);
    h.clock.advance(ENGINE_BUDGET_WINDOW_MS);
  });

  it('shows an application only from the moment it happened, and as applied for the whole case', async () => {
    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    const first = events[0]?.timestamp ?? '';
    const whole = (await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`)).data.items[0];
    expect(whole).toMatchObject({ applied: true, appliedBy: PERSONAS.engineer });
    expect(whole.conformance.score).toBeGreaterThanOrEqual(0.75);
    // On the case timeline the first email came before anyone applied the skill.
    const early = (await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches?asOf=${first}`))
      .data.items[0];
    expect(early).toMatchObject({ applied: false, appliedBy: null, conformance: null });
    // An instant after the application sees it, with conformance through that instant.
    const later = (
      await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches?asOf=2099-01-01T00:00:00Z`)
    ).data.items[0];
    expect(later).toMatchObject({ applied: true });
  });

  it('applies by match id: unknown matches are 404, other tenants see nothing, and it needs skill:apply', async () => {
    const matchId = (await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`)).data.items[0]
      .id as string;
    expect((await api.post(null, `/cases/${TWO}/skill-matches/${matchId}/apply`)).statusCode).toBe(
      401,
    );
    for (const persona of [PERSONAS.reviewer, PERSONAS.manager]) {
      expect(
        (await api.post(persona, `/cases/${TWO}/skill-matches/${matchId}/apply`)).statusCode,
        persona,
      ).toBe(403);
    }
    expect(
      (await api.post(PERSONAS.engineer, `/cases/${TWO}/skill-matches/smt_missing/apply`))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.post(PERSONAS.otherTenantEngineer, `/cases/${TWO}/skill-matches/${matchId}/apply`))
        .statusCode,
    ).toBe(404);
  });

  it('estimates effectiveness from the applications, labelled as an estimate and as synthetic', async () => {
    // A listed match is addressed by its id although listing stored nothing: applying stores it.
    const listed = (await api.get(PERSONAS.curator, `/cases/${ONE}/skill-matches`)).data.items;
    const matchOne = (listed as Json[]).find((m) => m.skillId === skillA);
    expect(matchOne).toMatchObject({ applied: false });
    expect(matchOne?.applicability).not.toBe('not_applicable');
    expect(await h.repos(CONTOSO).skills.listMatchesForCase(ONE)).toEqual([]);
    h.clock.advance(60_000);
    const budget = engineBudgetFor(h.infra);
    const curator = {
      auth: { tenantId: CONTOSO, userId: PERSONAS.curator },
      now: () => h.clock.now(),
    };
    const unitsBefore = budget.remaining(curator);
    const second = await api.post(
      PERSONAS.curator,
      `/cases/${ONE}/skill-matches/${matchOne?.id}/apply`,
    );
    expect(second.statusCode, JSON.stringify(second.data)).toBe(200);
    // The recorded path of this very case was measured for the first application and is shared: the
    // second application costs the caller one cold pass, not two.
    expect(unitsBefore - budget.remaining(curator)).toBe(1);
    expect(second.data).toMatchObject({
      id: matchOne?.id,
      skillId: skillA,
      applied: true,
      appliedBy: PERSONAS.curator,
    });
    const storedOne = await h.repos(CONTOSO).skills.listMatchesForCase(ONE);
    expect(storedOne.map((m) => [m.id, m.applied, m.version])).toEqual([[matchOne?.id, true, 1]]);

    const first = (await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`)).data.items[0];
    const detail = await detailOf(skillA);
    const mean =
      Math.round(((first.conformance.score + second.data.conformance.score) / 2) * 1000) / 1000;
    expect(detail.skill.effectiveness).toMatchObject({
      applications: 2,
      estimated: true,
      synthetic: true,
      conformanceAvg: mean,
    });
    expect(detail.skill.effectiveness.matchedCases).toBeGreaterThanOrEqual(2);
    expect(detail.skill.effectiveness.notes.join(' ')).toMatch(/estimate/i);

    // Case One is the case the skill came from, and the curator just applied it there: that application
    // is not compared with its own recorded path (and says so), while Case Two is compared with it.
    const effectiveness = detail.skill.effectiveness;
    expect(effectiveness.precedent).toMatchObject({ cases: 1, references: ['CG-SYN-1001'] });
    expect(effectiveness.precedent.avgTimeToDiagnosisMinutes).toBeLessThan(
      effectiveness.precedent.precedentAvgTimeToDiagnosisMinutes,
    );
    expect(effectiveness.notes).toContain(
      '1 application is on the case the skill came from and is not compared with that case’s own recorded path.',
    );
    const applied = (detail.matches as Json[]).filter((m) => m.applied).map((m) => m.caseId);
    expect(applied.sort()).toEqual([ONE, TWO].sort());
    // The case the skill does not apply to is listed as a match that was never applied.
    expect(detail.matches.find((m: Json) => m.caseId === IRR)).toMatchObject({
      applicability: 'not_applicable',
      applied: false,
    });
  });
});

describe('simulation tests and regression suites', () => {
  it('are for validators: engineers and managers are refused', async () => {
    const url = `/skills/${skillA}/simulation-test`;
    expect((await api.post(null, url, {})).statusCode).toBe(401);
    for (const persona of [PERSONAS.engineer, PERSONAS.manager]) {
      expect((await api.post(persona, url, {})).statusCode, persona).toBe(403);
    }
    expect((await api.post(PERSONAS.reviewer, url, { kind: 'chaos' })).statusCode).toBe(422);
    expect(
      (await api.post(PERSONAS.reviewer, '/skills/skl_missing/simulation-test', {})).statusCode,
    ).toBe(404);
    expect((await api.post(PERSONAS.reviewer, url, { versionId: 'skv_missing' })).statusCode).toBe(
      404,
    );
    expect((await api.post(PERSONAS.otherTenantEngineer, url, {})).statusCode).toBe(403);
  });

  it('replays on the source cases by default, or on the one case named, and records who ran it', async () => {
    h.clock.advance(60_000);
    const res = await runValidation(api, PERSONAS.curator, skillA, {});
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      skillId: skillA,
      kind: 'simulation_test',
      scope: 'full',
      outcome: 'passed',
      caseId: ONE,
      executedBy: PERSONAS.curator,
      synthetic: true,
    });
    const ids = (res.data.checks as Json[]).map((c) => c.id as string);
    expect(ids.every((id) => id.startsWith('CG-SYN-1001:'))).toBe(true);
    expect(ids).toEqual(
      expect.arrayContaining(['CG-SYN-1001:temporal-integrity', 'CG-SYN-1001:matches-at-decision']),
    );

    // A run that names a case covers that case only: it keeps its real checks but is inconclusive.
    h.clock.advance(60_000);
    const single = await runValidation(api, PERSONAS.reviewer, skillA, {
      kind: 'regression',
      caseId: TWO,
    });
    expect(single.data).toMatchObject({
      kind: 'regression',
      scope: 'case',
      outcome: 'inconclusive',
      caseId: TWO,
    });
    expect((single.data.checks as Json[]).length).toBeGreaterThan(0);
    expect((single.data.checks as Json[]).every((c) => c.passed === true)).toBe(true);
    expect(
      (await runValidation(api, PERSONAS.reviewer, skillA, { caseId: 'case_missing' })).statusCode,
    ).toBe(404);
    const raw = await runValidation(api, PERSONAS.reviewer, skillA, { caseId: RAW });
    expect(raw.statusCode).toBe(409);
    expect(raw.data.detail).toMatch(/not been analysed/);
  });

  it('runs the regression suite over the tenant’s resolved cases, including ones the skill must stay out of', async () => {
    h.clock.advance(60_000);
    const res = await runValidation(api, PERSONAS.reviewer, skillA, { kind: 'regression' });
    expect(res.statusCode).toBe(200);
    expect(res.data.outcome).toBe('passed');
    const ids = (res.data.checks as Json[]).map((c) => c.id as string);
    expect(ids).toEqual(
      expect.arrayContaining([
        'CG-SYN-1001:non-breaking',
        'CG-SYN-1002:matches-at-decision',
        'CG-SYN-9001:does-not-match',
      ]),
    );
    expect((res.data.checks as Json[]).every((c) => c.passed === true)).toBe(true);
    expect(res.data.caseId).toBeNull();
    const event = (await audits()).find(
      (e) => e.action === 'skill.validation_recorded' && e.details.validationId === res.data.id,
    );
    expect(event).toMatchObject({
      outcome: 'success',
      actorId: PERSONAS.reviewer,
      targetType: 'skill_version',
    });
    expect(Object.keys(event?.details ?? {}).sort()).toEqual([
      'cases',
      'casesPassed',
      'kind',
      'outcome',
      'scope',
      'skillId',
      'skillVersion',
      'validationId',
      'versionId',
    ]);
    expect(event?.details).toMatchObject({ scope: 'full', outcome: 'passed' });
    expect(res.data.scope).toBe('full');
  });
});

describe('mutations, version decisions and rollback', () => {
  let proposed: Json;
  let originalVersion: Json;

  it(
    'queues a proposal for a distinct case as a job, idempotently, and never applies it',
    { timeout: 120_000 },
    async () => {
      const url = `/skills/${skillA}/mutations`;
      expect((await api.post(null, url, { sourceCaseId: TWO })).statusCode).toBe(401);
      for (const persona of [PERSONAS.engineer, PERSONAS.reviewer, PERSONAS.manager]) {
        expect((await api.post(persona, url, { sourceCaseId: TWO })).statusCode, persona).toBe(403);
      }
      expect((await api.post(PERSONAS.curator, url, {})).statusCode).toBe(422);
      expect(
        (await api.post(PERSONAS.curator, url, { sourceCaseId: 'case_missing' })).statusCode,
      ).toBe(404);
      expect(
        (await api.post(PERSONAS.curator, '/skills/skl_missing/mutations', { sourceCaseId: TWO }))
          .statusCode,
      ).toBe(404);
      expect(
        (await api.post(PERSONAS.otherTenantEngineer, url, { sourceCaseId: TWO })).statusCode,
      ).toBe(403);

      originalVersion = (await detailOf(skillA)).currentVersion;
      h.clock.advance(60_000);
      const key = 'idem-skill-mutation-0001';
      const res = await api.post(
        PERSONAS.curator,
        url,
        { sourceCaseId: TWO },
        { 'idempotency-key': key },
      );
      expect(res.statusCode).toBe(202);
      const replay = await api.post(
        PERSONAS.curator,
        url,
        { sourceCaseId: TWO },
        { 'idempotency-key': key },
      );
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.data).toEqual(res.data);
      const job = await settledJob(h, api, res.data.job.id);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      expect(job.progress.stages.map((s: Json) => s.id)).toEqual(['load', 'propose', 'save']);
      expect((await api.post(PERSONAS.curator, url, { sourceCaseId: TWO })).data.job.id).toBe(
        res.data.job.id,
      );

      const detail = await detailOf(skillA);
      proposed = detail.proposedVersion;
      expect(proposed).toMatchObject({
        version: '1.1.0',
        state: 'proposed',
        changeType: 'mutation',
        createdBy: PERSONAS.curator,
      });
      expect(detail.skill).toMatchObject({
        currentVersion: '1.0.0',
        hasProposedMutation: true,
        lifecycle: 'published',
      });
      expect(detail.currentVersion.id).toBe(originalVersion.id);
      const event = (await audits()).find((e) => e.action === 'skill.mutation_proposed');
      expect(event).toMatchObject({ outcome: 'success', actorId: PERSONAS.curator, caseId: TWO });
      expect(event?.details).not.toHaveProperty('sourceCaseReference');
    },
  );

  it('says so when a case teaches the skill nothing new, and refuses what it cannot learn from', async () => {
    const same = await api.post(PERSONAS.curator, `/skills/${skillA}/mutations`, {
      sourceCaseId: ONE,
    });
    expect(same.statusCode).toBe(202);
    const job = await settledJob(h, api, same.data.job.id);
    expect(job.status).toBe('succeeded');
    expect(job.resultRef).toBeNull();
    expect(job.progress.stages.find((s: Json) => s.id === 'save')).toMatchObject({
      status: 'skipped',
    });
    expect(job.progress.stages.find((s: Json) => s.id === 'save').detail).toMatch(
      /already a source case/,
    );

    const raw = await api.post(PERSONAS.curator, `/skills/${skillA}/mutations`, {
      sourceCaseId: RAW,
    });
    const failed = await settledJob(h, api, raw.data.job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'conflict' });
    expect(failed.error.message).toMatch(/not been analysed/);
  });

  it('decides a proposed version only with a distinct approver and validated content', async () => {
    const decide = (persona: string | null, body: object) =>
      api.post(persona, `/skills/${skillA}/versions/${proposed.id}/decision`, body);
    const current = (await detailOf(skillA)).skill.version as number;
    const ok = { decision: 'approve', reason: REASON, expectedVersion: current };
    expect((await decide(PERSONAS.curator, ok)).statusCode).toBe(403); // the proposer
    expect((await decide(null, ok)).statusCode).toBe(401);
    for (const persona of [PERSONAS.engineer, PERSONAS.reviewer, PERSONAS.manager]) {
      expect((await decide(persona, ok)).statusCode, persona).toBe(403);
    }
    expect((await decide(PERSONAS.admin, { ...ok, decision: 'maybe' })).statusCode).toBe(422);
    expect((await decide(PERSONAS.admin, { ...ok, reason: 'no' })).statusCode).toBe(422);
    expect(
      (await api.post(PERSONAS.admin, `/skills/${skillA}/versions/skv_missing/decision`, ok))
        .statusCode,
    ).toBe(404);
    const stale = await decide(PERSONAS.admin, { ...ok, expectedVersion: current + 4 });
    expect(stale.statusCode).toBe(409);
    expect(stale.data.code).toBe('version_conflict');
    const unvalidated = await decide(PERSONAS.admin, ok);
    expect(unvalidated.statusCode).toBe(412);
    expect(unvalidated.data.detail).toMatch(/simulation test/i);
    expect((await detailOf(skillA)).skill.currentVersion).toBe('1.0.0');

    // Runs on one case do not count for the proposed content either.
    h.clock.advance(60_000);
    for (const kind of ['simulation_test', 'regression']) {
      const narrow = await runValidation(api, PERSONAS.reviewer, skillA, {
        kind,
        versionId: proposed.id,
        caseId: TWO,
      });
      expect(narrow.data).toMatchObject({
        versionId: proposed.id,
        scope: 'case',
        outcome: 'inconclusive',
      });
    }
    h.clock.advance(60_000);
    const stillNo = await decide(PERSONAS.admin, ok);
    expect(stillNo.statusCode).toBe(412);
    expect(stillNo.data.code).toBe('precondition_failed');
    expect(stillNo.data.detail).toMatch(/A full simulation test has not been run/);
    expect((await detailOf(skillA)).skill.currentVersion).toBe('1.0.0');
  });

  it(
    'approves it once simulation and regression passed on the proposed content; history is kept',
    { timeout: 120_000 },
    async () => {
      h.clock.advance(60_000);
      const sim = await runValidation(api, PERSONAS.reviewer, skillA, {
        kind: 'simulation_test',
        versionId: proposed.id,
      });
      expect(sim.data).toMatchObject({ outcome: 'passed', versionId: proposed.id });
      h.clock.advance(60_000);
      const reg = await runValidation(api, PERSONAS.reviewer, skillA, {
        kind: 'regression',
        versionId: proposed.id,
      });
      expect(reg.data).toMatchObject({ outcome: 'passed', versionId: proposed.id });

      h.clock.advance(60_000);
      const res = await api.post(
        PERSONAS.admin,
        `/skills/${skillA}/versions/${proposed.id}/decision`,
        {
          decision: 'approve',
          reason: REASON,
          expectedVersion: (await detailOf(skillA)).skill.version,
        },
      );
      expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
      expect(res.data.skill).toMatchObject({
        currentVersion: '1.1.0',
        lifecycle: 'published',
        hasProposedMutation: false,
      });
      expect(res.data.proposedVersion).toBeNull();
      expect(res.data.versions.map((v: Json) => [v.version, v.state])).toEqual([
        ['1.0.0', 'superseded'],
        ['1.1.0', 'active'],
      ]);
      const approval = (res.data.approvals as Json[]).find((a) => a.versionId === proposed.id);
      expect(approval).toMatchObject({
        decision: 'approved',
        approver: PERSONAS.admin,
        requestedBy: PERSONAS.curator,
      });
      const event = (await audits()).find((e) => e.action === 'skill.version_approved');
      expect(event).toMatchObject({ outcome: 'success', actorId: PERSONAS.admin });
      expect(JSON.stringify(event?.details)).not.toContain('MARKER-');
    },
  );

  it('follows the new version in matches, keeping the application of the case', async () => {
    const match = (await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches`)).data.items[0];
    expect(match).toMatchObject({
      skillVersion: '1.1.0',
      applied: true,
      appliedBy: PERSONAS.engineer,
    });
    expect(match.conformance).not.toBeNull();
  });

  it('rolls back by creating a new version with an earlier version’s content, never by rewriting history', async () => {
    const url = `/skills/${skillA}/rollback`;
    const detail = await detailOf(skillA);
    const body = {
      toVersionId: originalVersion.id,
      reason: REASON,
      expectedVersion: detail.skill.version,
    };
    expect((await api.post(null, url, body)).statusCode).toBe(401);
    for (const persona of [PERSONAS.engineer, PERSONAS.reviewer, PERSONAS.manager]) {
      expect((await api.post(persona, url, body)).statusCode, persona).toBe(403);
    }
    expect((await api.post(PERSONAS.curator, url, { ...body, reason: 'no' })).statusCode).toBe(422);
    expect(
      (await api.post(PERSONAS.curator, url, { ...body, toVersionId: 'skv_missing' })).statusCode,
    ).toBe(404);
    expect(
      (await api.post(PERSONAS.curator, url, { ...body, toVersionId: detail.currentVersion.id }))
        .statusCode,
    ).toBe(409);
    const stale = await api.post(PERSONAS.curator, url, {
      ...body,
      expectedVersion: body.expectedVersion + 3,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.data.code).toBe('version_conflict');

    h.clock.advance(60_000);
    const res = await api.post(PERSONAS.curator, url, body);
    expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
    expect(res.data.skill).toMatchObject({ currentVersion: '1.1.1', lifecycle: 'published' });
    expect(res.data.versions.map((v: Json) => [v.version, v.state, v.changeType])).toEqual([
      ['1.0.0', 'superseded', 'initial'],
      ['1.1.0', 'superseded', 'mutation'],
      ['1.1.1', 'active', 'rollback'],
    ]);
    expect(res.data.currentVersion).toMatchObject({
      parentVersionId: originalVersion.id,
      contentHash: originalVersion.contentHash,
    });
    expect(res.data.currentVersion.content).toEqual(originalVersion.content);
    const event = (await audits()).find((e) => e.action === 'skill.rolled_back');
    expect(event).toMatchObject({ outcome: 'success', actorId: PERSONAS.curator });
    expect(event?.details).toMatchObject({ restoredFromVersion: '1.0.0', newVersion: '1.1.1' });
    expect(JSON.stringify(event?.details)).not.toContain('MARKER-');

    const diff = await api.get(
      PERSONAS.engineer,
      `/skills/${skillA}/diff?fromVersionId=${originalVersion.id}&toVersionId=${res.data.currentVersion.id}`,
    );
    expect(diff.data.changes).toEqual([]);
  });

  it('refuses to restore a version that a rollback withdrew: bringing it back takes a new proposal', async () => {
    const detail = await detailOf(skillA);
    expect(detail.versions.map((v: Json) => [v.version, v.state])).toEqual([
      ['1.0.0', 'superseded'],
      ['1.1.0', 'superseded'],
      ['1.1.1', 'active'],
    ]);
    h.clock.advance(60_000);
    const res = await api.post(PERSONAS.curator, `/skills/${skillA}/rollback`, {
      toVersionId: proposed.id,
      reason: REASON,
      expectedVersion: detail.skill.version,
    });
    expect(res.statusCode, JSON.stringify(res.data)).toBe(412);
    expect(res.data.code).toBe('precondition_failed');
    expect(res.data.detail).toMatch(
      /not an earlier version of the current one \(a rollback withdrew it\)/,
    );
    expect(res.data.detail).toMatch(/Propose its content again as a new version/);
    // Nothing moved, and the refusal is on the record.
    expect((await detailOf(skillA)).skill).toMatchObject({
      currentVersion: '1.1.1',
      version: detail.skill.version,
    });
    const denied = (await audits()).find(
      (e) => e.action === 'skill.rollback_denied' && e.actorId === PERSONAS.curator,
    );
    expect(denied).toMatchObject({ targetId: skillA, outcome: 'denied' });
  });

  it(
    'rejecting a proposal needs no validation and leaves the skill as it was',
    { timeout: 120_000 },
    async () => {
      const res = await api.post(PERSONAS.curator, `/skills/${skillB}/mutations`, {
        sourceCaseId: TWO,
      });
      expect(res.statusCode).toBe(202);
      const job = await settledJob(h, api, res.data.job.id);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const detail = await detailOf(skillB);
      expect(detail.proposedVersion).toMatchObject({ state: 'proposed', version: '1.1.0' });

      const rejected = await api.post(
        PERSONAS.admin,
        `/skills/${skillB}/versions/${detail.proposedVersion.id}/decision`,
        {
          decision: 'reject',
          reason: 'Not convinced yet; collect one more case first.',
          expectedVersion: detail.skill.version,
        },
      );
      expect(rejected.statusCode).toBe(200);
      expect(rejected.data.skill).toMatchObject({
        currentVersion: '1.0.0',
        hasProposedMutation: false,
        lifecycle: 'discovered',
      });
      expect(rejected.data.versions.map((v: Json) => [v.version, v.state])).toEqual([
        ['1.0.0', 'active'],
        ['1.1.0', 'rejected'],
      ]);
      const again = await api.post(
        PERSONAS.admin,
        `/skills/${skillB}/versions/${detail.proposedVersion.id}/decision`,
        {
          decision: 'approve',
          reason: REASON,
          expectedVersion: rejected.data.skill.version,
        },
      );
      expect(again.statusCode).toBe(409); // only proposed versions can be decided

      // A rejected version was never approved, so it can never be restored by a rollback.
      h.clock.advance(60_000);
      const restore = await api.post(PERSONAS.curator, `/skills/${skillB}/rollback`, {
        toVersionId: detail.proposedVersion.id,
        reason: REASON,
        expectedVersion: rejected.data.skill.version,
      });
      expect(restore.statusCode).toBe(412);
    },
  );

  it('retires a skill that was never published (a rejection by the curator), and nothing moves it afterwards', async () => {
    h.clock.advance(60_000);
    const res = await moveSkill(api, PERSONAS.curator, skillB, 'retired', REASON);
    expect(res.statusCode, JSON.stringify(res.data)).toBe(200);
    expect(res.data.skill.lifecycle).toBe('retired');
    const approval = (res.data.approvals as Json[]).at(-1);
    expect(approval).toMatchObject({
      decision: 'rejected',
      toState: 'retired',
      approver: PERSONAS.curator,
    });
    expect(res.data.transitions).toEqual([]);
    expect((await moveSkill(api, PERSONAS.curator, skillB, 'draft', REASON)).statusCode).toBe(409);
    expect(
      (await audits()).find((e) => e.action === 'skill.retired' && e.targetId === skillB),
    ).toMatchObject({
      outcome: 'success',
    });
    // A retired skill never matches and cannot be applied.
    const apply = await api.post(PERSONAS.engineer, `/cases/${TWO}/skills/apply`, {
      skillId: skillB,
    });
    expect(apply.statusCode).toBe(409);
  });

  it('lets the creator withdraw a published skill, which is recorded as a rejection, not an approval', async () => {
    // Ava created skill A. Give her the permission to retire for the moment (roles are read per request).
    const user = await h.repos(CONTOSO).governance.getUser(PERSONAS.engineer);
    if (user === null) throw new Error('the engineer persona is missing');
    const withRoles = async (roles: Role[], version: number) =>
      (await h.repos(CONTOSO).governance.updateUserRoles(PERSONAS.engineer, roles, version))
        .version;
    const elevated = await withRoles(['engineer', 'skill_curator'], user.version);
    try {
      const before = await detailOf(skillA, PERSONAS.engineer);
      expect(before.skill.createdBy).toBe(PERSONAS.engineer);
      expect(before.transitions.find((t: Json) => t.toState === 'deprecated')).toMatchObject({
        allowed: true,
        requiresDistinctApprover: false,
      });

      h.clock.advance(60_000);
      const deprecated = await moveSkill(api, PERSONAS.engineer, skillA, 'deprecated', REASON);
      expect(deprecated.statusCode, JSON.stringify(deprecated.data)).toBe(200);
      expect(deprecated.data.skill.lifecycle).toBe('deprecated');
      expect((deprecated.data.approvals as Json[]).at(-1)).toMatchObject({
        toState: 'deprecated',
        decision: 'rejected',
        approver: PERSONAS.engineer,
        requestedBy: PERSONAS.engineer,
      });
      h.clock.advance(60_000);
      const retired = await moveSkill(api, PERSONAS.engineer, skillA, 'retired', REASON);
      expect(retired.statusCode, JSON.stringify(retired.data)).toBe(200);
      expect(retired.data.skill.lifecycle).toBe('retired');

      const events = (await audits()).filter(
        (e) => /^skill\.(deprecated|retired)$/.test(e.action) && e.targetId === skillA,
      );
      expect(events.map((e) => e.action).sort()).toEqual(['skill.deprecated', 'skill.retired']);
      for (const event of events) {
        expect(event).toMatchObject({ outcome: 'success', actorId: PERSONAS.engineer });
        expect(event.details).toMatchObject({ decision: 'rejected' });
        expect(JSON.stringify(event.details)).not.toContain('MARKER-');
      }
      // Nobody is refused for it: no denial was recorded for the creator withdrawing their skill.
      expect(
        (await audits()).filter(
          (e) => e.outcome === 'denied' && e.actorId === PERSONAS.engineer && e.targetId === skillA,
        ),
      ).toEqual([]);
    } finally {
      await withRoles(['engineer'], elevated);
    }
  });
});

describe('what stays on the record', () => {
  it('audits every refusal and change inside the tenant, with no free text, and never logs it', async () => {
    const events = await audits();
    const denied = events.filter((e) => e.outcome === 'denied');
    expect(denied.some((e) => e.action === 'access.denied')).toBe(true);
    expect(denied.some((e) => e.action === 'skill.transition_denied')).toBe(true);
    expect(denied.some((e) => e.action === 'skill.version_decision_denied')).toBe(true);
    const text = JSON.stringify(events.map((e) => e.details));
    expect(text).not.toContain('MARKER-');
    expect(text).not.toMatch(/sign-in|resolver|proxy node/i);
    expect(JSON.stringify(h.logs())).not.toContain('MARKER-SKILL');
    expect((await h.repos(CONTOSO).audit.verify()).valid).toBe(true);
    expect((await audits(FABRIKAM)).filter((e) => /^skill\./.test(e.action))).toEqual([]);
  });

  it('keeps the other tenant out of the whole library', async () => {
    const eve = PERSONAS.otherTenantEngineer;
    expect((await api.get(eve, '/skills')).data.items).toEqual([]);
    for (const url of [
      `/skills/${skillA}`,
      `/skills/${skillA}/versions`,
      `/cases/${TWO}/skill-matches`,
      `/cases/${ONE}/counterfactuals`,
    ]) {
      expect((await api.get(eve, url)).statusCode, url).toBe(404);
    }
    const other = contextFor(h, eve);
    await expect(other.services.skills.get(other, skillA)).rejects.toMatchObject({ status: 404 });
    await expect(other.services.skills.applyToCase(other, TWO, skillA)).rejects.toMatchObject({
      status: 404,
    });
  });
});
