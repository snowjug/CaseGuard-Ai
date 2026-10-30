import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CounterfactualScenario,
  DecisionFork,
  Role,
  SkillApproval,
  SkillMatch,
  User,
} from '@caseguard/schemas';
import { DEV_PERSONAS } from '../src/db';
import type { TenantRepositories } from '../src/db';
import { AppError } from '../src/errors';
import type { ContextInfrastructure } from '../src/http/context-factory';
import type { RequestContext } from '../src/http/request-context';
import { STORY_ACTORS, resolveStoryActors } from '../src/services/demo/actors';
import { loadFacts } from '../src/services/demo/facts';
import {
  NOT_A_DEMO_TENANT,
  assertDemoManageable,
  assertNoActiveJobs,
  demoManagementAllowed,
} from '../src/services/demo/guard';
import { STORY_CASES } from '../src/services/demo/story-cases';
import { listItem, skillOf } from './insights-fixtures';

/** Just the repository surface the code under test touches, as the tenant-bound repositories expose it. */
function ctxWith(repos: object, extra: object = {}): RequestContext {
  return { repos, ...extra } as unknown as RequestContext;
}

describe('[FR-DEMO-04] the story cases and the skill are found by their stored facts', () => {
  interface Data {
    cases: ReturnType<typeof listItem>[];
    forks: Pick<DecisionFork, 'id' | 'isEarliestMeaningful'>[];
    scenarios: Pick<CounterfactualScenario, 'id' | 'forkId' | 'reviewState'>[];
    skills: ReturnType<typeof skillOf>[];
    approvals: Pick<SkillApproval, 'toState' | 'decision' | 'approver'>[];
    matches: Partial<SkillMatch>[];
  }

  const ONE = listItem('case_one', { reference: STORY_CASES.one.reference });
  const TWO = listItem('case_two', { reference: STORY_CASES.two.reference });

  function facts(overrides: Partial<Data> = {}) {
    const data: Data = {
      cases: [ONE, TWO],
      forks: [
        { id: 'fork_early', isEarliestMeaningful: true },
        { id: 'fork_late', isEarliestMeaningful: false },
      ],
      scenarios: [],
      skills: [],
      approvals: [],
      matches: [],
      ...overrides,
    };
    const repos = {
      cases: {
        list: ({ q }: { q?: string }) =>
          Promise.resolve({
            items: data.cases.filter((c) => c.reference.includes(q ?? '')),
            nextCursor: null,
          }),
      },
      analysis: {
        countClaimsByCategory: () =>
          Promise.resolve({ confirmed_fact: 20, engineer_assumption: 5 }),
        listHypotheses: () => Promise.resolve([{}, {}, {}]),
        listForks: () => Promise.resolve(data.forks),
        getQuality: () => Promise.resolve({}),
        listMetrics: () => Promise.resolve([{}, {}]),
      },
      counterfactuals: {
        list: (_caseId: string, filter: { forkId?: string } = {}) =>
          Promise.resolve(
            data.scenarios.filter((s) => filter.forkId === undefined || s.forkId === filter.forkId),
          ),
      },
      skills: {
        list: () => Promise.resolve({ items: data.skills, nextCursor: null }),
        listApprovals: () => Promise.resolve(data.approvals),
        listMatchesForCase: () => Promise.resolve(data.matches),
      },
    };
    return loadFacts(ctxWith(repos));
  }

  it('recognises the ingested samples by their reference, in synthetic cases only', async () => {
    const found = await facts();
    expect(found.caseOne).toMatchObject({ id: 'case_one', claimCount: 25, hypothesisCount: 3 });
    expect(found.caseTwo?.id).toBe('case_two');

    const lookalike = await facts({ cases: [{ ...ONE, synthetic: false }, TWO] });
    expect(lookalike.caseOne).toBeNull();
    expect(lookalike.caseTwo?.id).toBe('case_two');
    expect((await facts({ cases: [] })).caseOne).toBeNull();
  });

  it('counts an accepted path only when it belongs to the earliest meaningful fork', async () => {
    const onLaterFork = await facts({
      scenarios: [
        { id: 's1', forkId: 'fork_late', reviewState: 'confirmed' },
        { id: 's2', forkId: 'fork_early', reviewState: 'pending' },
      ],
    });
    expect(onLaterFork.caseOne?.earliestForkId).toBe('fork_early');
    expect(onLaterFork.caseOne?.acceptedScenarioId).toBeNull();

    const accepted = await facts({
      scenarios: [{ id: 's2', forkId: 'fork_early', reviewState: 'confirmed' }],
    });
    expect(accepted.caseOne?.acceptedScenarioId).toBe('s2');
  });

  it('takes the oldest skill that lists Case One, and needs two different people for the governed approval', async () => {
    const older = skillOf('skill_old', {
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceCaseIds: ['case_one'],
    });
    const newer = skillOf('skill_new', {
      createdAt: '2026-02-01T00:00:00.000Z',
      sourceCaseIds: ['case_one'],
    });
    const unrelated = skillOf('skill_other', {
      createdAt: '2025-01-01T00:00:00.000Z',
      sourceCaseIds: ['case_x'],
    });
    const approvals = (
      pilot: string,
      publisher: string,
      decision: SkillApproval['decision'] = 'approved',
    ) => [
      { toState: 'pilot' as const, decision: 'approved' as const, approver: pilot },
      { toState: 'published' as const, decision, approver: publisher },
    ];

    const same = await facts({
      skills: [newer, unrelated, older],
      approvals: approvals('user_casey_curator', 'user_casey_curator'),
    });
    expect(same.skill).toEqual({
      id: 'skill_old',
      lifecycle: 'published',
      governedPublication: false,
    });
    const distinct = await facts({
      skills: [older],
      approvals: approvals('user_casey_curator', 'user_alex_admin'),
    });
    expect(distinct.skill?.governedPublication).toBe(true);
    const rejected = await facts({
      skills: [older],
      approvals: approvals('user_casey_curator', 'user_alex_admin', 'rejected'),
    });
    expect(rejected.skill?.governedPublication).toBe(false);
    expect((await facts({ skills: [unrelated] })).skill).toBeNull();
  });

  it('counts a match only once the skill was validated or published, and only when it applies', async () => {
    const skills = [skillOf('skill_1', { sourceCaseIds: ['case_one'] })];
    const match = (overrides: Partial<SkillMatch>): Partial<SkillMatch> => ({
      skillId: 'skill_1',
      lifecycle: 'published',
      applicability: 'applies',
      applied: false,
      conformance: null,
      ...overrides,
    });
    const read = async (overrides: Partial<SkillMatch>) =>
      (await facts({ skills, matches: [match(overrides)] })).followUpMatch;

    expect(await read({})).toEqual({ applies: true, applied: false, hasConformance: false });
    expect(await read({ lifecycle: 'pilot' })).toMatchObject({ applies: false });
    expect(await read({ applicability: 'partial' })).toMatchObject({ applies: false });
    expect(
      await read({ applied: true, conformance: { stepsFollowed: 3, stepsTotal: 4, score: 0.9 } }),
    ).toEqual({
      applies: true,
      applied: true,
      hasConformance: true,
    });
    expect(
      (await facts({ skills, matches: [match({ skillId: 'other' })] })).followUpMatch,
    ).toBeNull();
  });
});

describe('[FR-DEMO-05] demo data is only managed in a synthetic demo tenant', () => {
  const audits: { action: string; outcome: string; details: Record<string, unknown> }[] = [];
  const base = (overrides: { demoMode?: boolean; synthetic?: boolean; jobs?: boolean } = {}) =>
    ctxWith(
      {
        governance: {
          getTenant: () => Promise.resolve({ synthetic: overrides.synthetic ?? true }),
        },
        jobs: {
          list: ({ status }: { status: string }) =>
            Promise.resolve({ items: overrides.jobs && status === 'running' ? [{}] : [] }),
        },
      },
      {
        config: { demo: { mode: overrides.demoMode ?? true } },
        logger: { error: vi.fn() },
        audit: (event: { action: string; outcome: string; details: Record<string, unknown> }) => {
          audits.push(event);
          return Promise.resolve();
        },
        scope: { tenantId: 'tenant_x' },
      },
    );

  afterEach(() => {
    audits.length = 0;
  });

  it('allows demo mode or a synthetic tenant, and nothing else', () => {
    expect(demoManagementAllowed({ demoMode: true, tenantSynthetic: false })).toBe(true);
    expect(demoManagementAllowed({ demoMode: false, tenantSynthetic: true })).toBe(true);
    expect(demoManagementAllowed({ demoMode: false, tenantSynthetic: false })).toBe(false);
  });

  it('refuses with a 409 and audits the denial (ids and a reason code only)', async () => {
    const error = await assertDemoManageable(
      base({ demoMode: false, synthetic: false }),
      'demo.seed',
      { profile: 'base' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: 'conflict', message: NOT_A_DEMO_TENANT });
    expect(audits).toEqual([
      {
        action: 'demo.seed',
        targetType: 'tenant',
        targetId: 'tenant_x',
        caseId: null,
        outcome: 'denied',
        details: { profile: 'base', reason: 'not_a_demo_tenant' },
      },
    ]);
    await expect(
      assertDemoManageable(base({ demoMode: false, synthetic: true }), 'demo.reset'),
    ).resolves.toBeUndefined();
    await expect(
      assertDemoManageable(base({ demoMode: true, synthetic: false }), 'demo.reset'),
    ).resolves.toBeUndefined();
  });

  it('waits for running jobs instead of erasing or seeding underneath them', async () => {
    await expect(assertNoActiveJobs(base(), 'demo.reset')).resolves.toBeUndefined();
    await expect(assertNoActiveJobs(base({ jobs: true }), 'demo.reset')).rejects.toMatchObject({
      status: 409,
    });
    expect(audits.at(-1)).toMatchObject({
      action: 'demo.reset',
      outcome: 'denied',
      details: { reason: 'job_active' },
    });
  });
});

describe('[FR-DEMO-06] the personas of the story', () => {
  const AUTH_ROLES: Record<string, Role> = {
    [STORY_ACTORS.engineer.userId]: 'engineer',
    [STORY_ACTORS.reviewer.userId]: 'reviewer',
    [STORY_ACTORS.curator.userId]: 'skill_curator',
    [STORY_ACTORS.administrator.userId]: 'administrator',
  };

  const userOf = (id: string, overrides: Partial<User> = {}): User => ({
    id,
    tenantId: 'tenant_x',
    displayName: `${id} (synthetic)`,
    email: `${id}@example.invalid`,
    roles: [AUTH_ROLES[id] ?? 'manager'],
    status: 'active',
    synthetic: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  });

  const infra: ContextInfrastructure = {
    config: {},
    metrics: {},
    now: () => new Date('2026-01-15T09:00:00.000Z'),
    newId: (prefix: string) => `${prefix}_1`,
    services: {},
    repos: {
      forTenant: (scope: { tenantId: string; actorId: string }) =>
        ({ scope }) as unknown as TenantRepositories,
    },
  } as unknown as ContextInfrastructure;

  const baseWith = (users: Record<string, User | null>) =>
    ctxWith(
      { governance: { getUser: (id: string) => Promise.resolve(users[id] ?? null) } },
      { requestId: 'req_1', signal: new AbortController().signal, logger: {} },
    );
  const everyone = (): Record<string, User | null> =>
    Object.fromEntries(Object.keys(AUTH_ROLES).map((id) => [id, userOf(id)]));

  it('are the same seeded users the development persona picker offers', () => {
    for (const [userId, role] of Object.entries(AUTH_ROLES)) {
      expect(
        DEV_PERSONAS.find((p) => p.id === userId && p.tenantId === 'tenant_contoso_support')?.role,
      ).toBe(role);
    }
  });

  it('get one context each, with the stored roles, the tenant actor and the caller correlation id', async () => {
    const actors = await resolveStoryActors(baseWith(everyone()), infra);
    expect(actors.reviewer.auth).toMatchObject({
      userId: STORY_ACTORS.reviewer.userId,
      roles: ['reviewer'],
      authMode: 'dev',
      synthetic: true,
    });
    expect(actors.reviewer.auth.permissions).toContain('counterfactual:review');
    expect(actors.reviewer.auth.permissions).not.toContain('demo:manage');
    expect(actors.administrator.auth.permissions).toContain('skill:publish');
    expect(actors.engineer.scope).toEqual({
      tenantId: 'tenant_x',
      actorId: STORY_ACTORS.engineer.userId,
    });
    expect(actors.curator.requestId).toBe('req_1');
  });

  it.each([
    [
      'is missing',
      (users: Record<string, User | null>) => ({ ...users, [STORY_ACTORS.engineer.userId]: null }),
      'Ava (engineer) does not exist',
    ],
    [
      'is not synthetic',
      (users: Record<string, User | null>) => ({
        ...users,
        [STORY_ACTORS.reviewer.userId]: userOf(STORY_ACTORS.reviewer.userId, { synthetic: false }),
      }),
      'Riley (reviewer) is not a synthetic user',
    ],
    [
      'is disabled',
      (users: Record<string, User | null>) => ({
        ...users,
        [STORY_ACTORS.curator.userId]: userOf(STORY_ACTORS.curator.userId, { status: 'disabled' }),
      }),
      'Casey (skill curator) is disabled',
    ],
    [
      'lost a permission',
      (users: Record<string, User | null>) => ({
        ...users,
        [STORY_ACTORS.reviewer.userId]: userOf(STORY_ACTORS.reviewer.userId, {
          roles: ['manager'],
        }),
      }),
      'Riley (reviewer) lacks counterfactual:review',
    ],
  ])('refuses with a 409 when a persona %s', async (_name, change, expected) => {
    const error = await resolveStoryActors(baseWith(change(everyone())), infra).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      status: 409,
      code: 'conflict',
      details: { reason: 'personas_unavailable' },
    });
    expect((error as Error).message).toContain(expected);
  });
});
