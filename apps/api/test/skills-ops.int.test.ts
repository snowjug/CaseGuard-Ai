import type { TokenUsage } from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationFailedError, VersionConflictError } from '../src/errors';
import {
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import { DEV_PERSONAS, seedFoundation } from '../src/db/seed';
import { MAX_IDEMPOTENT_RESPONSE_BYTES } from '../src/db/repositories/idempotency-repository';
import {
  TENANT_B,
  at,
  buildExecution,
  buildIngestInput,
  buildJob,
  buildPromptVersion,
  buildReviewDecision,
  buildSkill,
  buildSkillApproval,
  buildSkillMatch,
  buildSkillValidation,
  buildSkillVersion,
} from './builders';

let h: TestHarness;

beforeAll(async () => {
  h = await createTestRepositories();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  h.clock.set('2026-01-15T09:00:00.000Z');
});

describe('skills', () => {
  const newSkill = async (
    id: string,
    key: string,
    overrides: Parameters<typeof buildSkill>[0] = {},
  ) => {
    const versionId = `${id}_v1`;
    await h.contoso().skills.create({
      skill: buildSkill({ id, key, currentVersionId: versionId, ...overrides }),
      version: buildSkillVersion({ id: versionId, skillId: id }),
    });
  };

  it('creates a skill with its initial version and reads both back', async () => {
    const repos = h.contoso();
    const skill = buildSkill();
    const version = buildSkillVersion();
    await repos.skills.create({ skill, version });
    expect(await repos.skills.get('skill_proxy')).toEqual(skill);
    expect(await repos.skills.getVersion('skill_proxy', 'skillv_proxy_1')).toEqual(version);
    expect(await repos.skills.listVersions('skill_proxy')).toEqual([version]);
    expect(await repos.skills.get('skill_missing')).toBeNull();
    expect(await repos.skills.getVersion('skill_proxy', 'nope')).toBeNull();
  });

  it('rejects inconsistent skill/version pairs and duplicate keys', async () => {
    const repos = h.contoso();
    await expect(
      repos.skills.create({
        skill: buildSkill(),
        version: buildSkillVersion({ skillId: 'other' }),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.skills.create({
        skill: buildSkill({ currentVersion: '2.0.0' }),
        version: buildSkillVersion(),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await newSkill('skill_a', 'proxy-a');
    await expect(
      repos.skills.create({
        skill: buildSkill({ id: 'skill_b', key: 'proxy-a', currentVersionId: 'skill_b_v1' }),
        version: buildSkillVersion({ id: 'skill_b_v1', skillId: 'skill_b' }),
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: 'A skill with this key already exists' });
    // The failed create left nothing behind (skill and version are written together).
    expect(await repos.skills.get('skill_b')).toBeNull();
  });

  it('[NFR-REL-01] lists newest change first with filters and a stable keyset cursor', async () => {
    const repos = h.contoso();
    for (let i = 1; i <= 7; i += 1) {
      await newSkill(`skill_${i}`, `key-${i}-skill`, {
        lifecycle: i % 2 === 0 ? 'published' : 'draft',
        name: `Synthetic skill number ${i}`,
        updatedAt: at(0), // identical sort key for every skill
      });
    }
    const all = await repos.skills.list({ limit: 200 });
    expect(all.items).toHaveLength(7);
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repos.skills.list({ limit: 3, cursor });
      paged.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(all.items.map((s) => s.id));
    expect(new Set(paged).size).toBe(7);
    expect(
      (await repos.skills.list({ limit: 50, lifecycle: 'published' })).items
        .map((s) => s.id)
        .sort(),
    ).toEqual(['skill_2', 'skill_4', 'skill_6']);
    expect((await repos.skills.list({ limit: 50, q: 'NUMBER 5' })).items.map((s) => s.id)).toEqual([
      'skill_5',
    ]);
    expect((await repos.skills.list({ limit: 50, q: 'key-3' })).items.map((s) => s.id)).toEqual([
      'skill_3',
    ]);
  });

  it('versions: add, order by sequence, change state, reject duplicates and unknown skills', async () => {
    const repos = h.contoso();
    await newSkill('skill_v', 'versioned-skill');
    const second = buildSkillVersion({
      id: 'skill_v_v2',
      skillId: 'skill_v',
      version: '1.1.0',
      sequence: 2,
      parentVersionId: 'skill_v_v1',
      changeType: 'mutation',
      state: 'proposed',
    });
    await repos.skills.addVersion(second);
    expect((await repos.skills.listVersions('skill_v')).map((v) => v.version)).toEqual([
      '1.0.0',
      '1.1.0',
    ]);
    await expect(
      repos.skills.addVersion({ ...second, id: 'skill_v_v3', sequence: 3 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      repos.skills.addVersion(buildSkillVersion({ skillId: 'ghost', id: 'ghost_v1' })),
    ).rejects.toBeInstanceOf(NotFoundError);

    await repos.skills.setVersionState('skill_v', 'skill_v_v2', 'active');
    await repos.skills.setVersionState('skill_v', 'skill_v_v1', 'superseded');
    expect((await repos.skills.getVersion('skill_v', 'skill_v_v2'))?.state).toBe('active');
    expect((await repos.skills.getVersion('skill_v', 'skill_v_v1'))?.state).toBe('superseded');
    await expect(repos.skills.setVersionState('skill_v', 'nope', 'active')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      repos.skills.setVersionState('skill_v', 'skill_v_v1', 'bogus' as never),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('[NFR-REL-01] update uses optimistic locking and validates the merged skill', async () => {
    const repos = h.contoso();
    await newSkill('skill_u', 'update-skill');
    h.clock.advance(60_000);
    const updated = await repos.skills.update(
      'skill_u',
      { lifecycle: 'simulation_tested', reviewer: 'user_riley_reviewer' },
      1,
    );
    expect(updated).toMatchObject({
      lifecycle: 'simulation_tested',
      reviewer: 'user_riley_reviewer',
      version: 2,
      updatedAt: '2026-01-15T09:01:00.000Z',
    });
    expect(await repos.skills.get('skill_u')).toEqual(updated);

    await expect(
      repos.skills.update('skill_u', { lifecycle: 'validated' }, 1),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      repos.skills.update('skill_u', { lifecycle: 'bogus' as never }, 2),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.skills.update('skill_missing', { lifecycle: 'validated' }, 1),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Identity and ownership fields cannot be patched, even through an untyped object.
    const sneaky = await repos.skills.update(
      'skill_u',
      { name: 'Renamed skill', id: 'other', tenantId: TENANT_B, version: 99 } as never,
      2,
    );
    expect(sneaky).toMatchObject({
      id: 'skill_u',
      tenantId: 'tenant_contoso_support',
      version: 3,
      name: 'Renamed skill',
    });

    // Re-pointing the current version requires an existing version whose number matches.
    await expect(
      repos.skills.update('skill_u', { currentVersionId: 'ghost', currentVersion: '9.9.9' }, 3),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await repos.skills.addVersion(
      buildSkillVersion({ id: 'skill_u_v2', skillId: 'skill_u', version: '1.1.0', sequence: 2 }),
    );
    expect(
      await repos.skills.update(
        'skill_u',
        { currentVersionId: 'skill_u_v2', currentVersion: '1.1.0' },
        3,
      ),
    ).toMatchObject({ currentVersion: '1.1.0', version: 4 });
  });

  it('records validations and approvals; an approval must come from someone else', async () => {
    const repos = h.contoso();
    await newSkill('skill_p', 'approval-skill');
    await repos.skills.addValidation(
      buildSkillValidation({
        id: 'val_1',
        skillId: 'skill_p',
        versionId: 'skill_p_v1',
        executedAt: at(10),
      }),
    );
    await repos.skills.addValidation(
      buildSkillValidation({
        id: 'val_2',
        skillId: 'skill_p',
        versionId: 'skill_p_v1',
        executedAt: at(20),
        outcome: 'failed',
      }),
    );
    expect((await repos.skills.listValidations('skill_p')).map((v) => v.id)).toEqual([
      'val_2',
      'val_1',
    ]);

    await repos.skills.addApproval(
      buildSkillApproval({ id: 'app_1', skillId: 'skill_p', versionId: 'skill_p_v1' }),
    );
    expect((await repos.skills.listApprovals('skill_p')).map((a) => a.id)).toEqual(['app_1']);
    await expect(
      repos.skills.addApproval(
        buildSkillApproval({
          id: 'app_self',
          skillId: 'skill_p',
          versionId: 'skill_p_v1',
          approver: 'user_casey_curator',
          requestedBy: 'user_casey_curator',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'An approval requires an approver other than the requester',
    });
    // A rejection by the requester is not an approval and is allowed.
    await repos.skills.addApproval(
      buildSkillApproval({
        id: 'app_withdrawn',
        skillId: 'skill_p',
        versionId: 'skill_p_v1',
        approver: 'user_casey_curator',
        requestedBy: 'user_casey_curator',
        decision: 'rejected',
      }),
    );
    await expect(
      repos.skills.addValidation(
        buildSkillValidation({ id: 'val_bad', skillId: 'skill_p', versionId: 'missing' }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('stores skill matches per case and lists only matchable skills for a workload', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(buildIngestInput());
    await newSkill('skill_pilot', 'pilot-skill', { lifecycle: 'pilot' });
    await newSkill('skill_draft', 'draft-skill', { lifecycle: 'draft' });
    await newSkill('skill_retired', 'retired-skill', { lifecycle: 'retired' });
    await newSkill('skill_other', 'other-workload', {
      lifecycle: 'published',
      workload: 'exchange-mailflow',
    });
    await newSkill('skill_pub', 'published-skill', { lifecycle: 'published' });

    const matchable = await repos.skills.listMatchable('teams-authentication');
    expect(matchable.map((m) => m.skill.id)).toEqual(['skill_pilot', 'skill_pub']);
    expect(matchable.every((m) => m.version.id === m.skill.currentVersionId)).toBe(true);
    expect(await repos.skills.listMatchable('no-such-workload')).toEqual([]);

    const match = buildSkillMatch({ skillId: 'skill_pilot', versionId: 'skill_pilot_v1' });
    await repos.skills.upsertMatch(match);
    await repos.skills.upsertMatch(
      buildSkillMatch({ skillId: 'skill_pub', versionId: 'skill_pub_v1', score: 0.4 }),
    );
    await repos.skills.upsertMatch({
      ...match,
      applied: true,
      appliedAt: at(5),
      appliedBy: 'user_ava_engineer',
      version: 2,
    });
    expect(await repos.skills.getMatch('case_alpha', match.id)).toMatchObject({
      applied: true,
      version: 2,
    });
    expect((await repos.skills.listMatchesForCase('case_alpha')).map((m) => m.skillId)).toEqual([
      'skill_pilot',
      'skill_pub',
    ]);
    expect((await repos.skills.listMatchesForSkill('skill_pilot')).map((m) => m.caseId)).toEqual([
      'case_alpha',
    ]);
    expect(await repos.skills.getMatch('case_alpha', 'nope')).toBeNull();
  });
});

describe('jobs', () => {
  it('creates, reads, updates and lists jobs with filters and keyset pagination', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(buildIngestInput());
    for (let i = 1; i <= 5; i += 1) {
      await repos.jobs.create(
        buildJob({
          id: `job_${i}`,
          kind: i % 2 ? 'case_analysis' : 'counterfactual',
          caseId: i <= 3 ? 'case_alpha' : null,
          createdAt: at(0),
        }),
      );
    }
    expect((await repos.jobs.list({ limit: 50 })).items).toHaveLength(5);
    expect(
      (await repos.jobs.list({ limit: 50, kind: 'counterfactual' })).items.map((j) => j.id).sort(),
    ).toEqual(['job_2', 'job_4']);
    expect((await repos.jobs.list({ limit: 50, caseId: 'case_alpha' })).items).toHaveLength(3);
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repos.jobs.list({ limit: 2, cursor });
      paged.push(...page.items.map((j) => j.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toHaveLength(5);
    expect(new Set(paged).size).toBe(5);

    const running = await repos.jobs.update('job_1', {
      status: 'running',
      startedAt: at(1),
      progress: { percent: 40, stage: 'analysis', stages: [] },
    });
    expect(running).toMatchObject({
      status: 'running',
      startedAt: at(1),
      progress: { percent: 40 },
    });
    expect(
      (await repos.jobs.list({ limit: 50, status: 'running' })).items.map((j) => j.id),
    ).toEqual(['job_1']);
    const done = await repos.jobs.update('job_1', {
      status: 'succeeded',
      completedAt: at(3),
      resultRef: { type: 'analysis_run', id: 'run_1' },
      cancellable: false,
    });
    expect(done).toMatchObject({
      status: 'succeeded',
      resultRef: { id: 'run_1' },
      cancellable: false,
    });
    expect(await repos.jobs.get('job_1')).toEqual(done);
    expect(await repos.jobs.get('job_missing')).toBeNull();
    await expect(repos.jobs.update('job_missing', { status: 'failed' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('a finished job cannot change its outcome', async () => {
    const repos = h.contoso();
    await repos.jobs.create(buildJob({ id: 'job_done' }));
    await repos.jobs.update('job_done', { status: 'cancelled', completedAt: at(2) });
    await expect(repos.jobs.update('job_done', { status: 'succeeded' })).rejects.toMatchObject({
      code: 'conflict',
    });
    // Re-asserting the same terminal status is harmless.
    expect(await repos.jobs.update('job_done', { status: 'cancelled' })).toMatchObject({
      status: 'cancelled',
    });
  });

  it('finds jobs by idempotency key per kind and refuses duplicates', async () => {
    const repos = h.contoso();
    await repos.jobs.create(
      buildJob({ id: 'job_a', kind: 'case_analysis', idempotencyKey: 'idem-1' }),
    );
    expect((await repos.jobs.findByIdempotencyKey('case_analysis', 'idem-1'))?.id).toBe('job_a');
    expect(await repos.jobs.findByIdempotencyKey('counterfactual', 'idem-1')).toBeNull();
    await expect(
      repos.jobs.create(buildJob({ id: 'job_b', kind: 'case_analysis', idempotencyKey: 'idem-1' })),
    ).rejects.toMatchObject({ code: 'conflict' });
    await repos.jobs.create(
      buildJob({ id: 'job_c', kind: 'counterfactual', idempotencyKey: 'idem-1' }),
    );
    await repos.jobs.create(buildJob({ id: 'job_d' }));
    await repos.jobs.create(buildJob({ id: 'job_e' }));
  });

  it('failOrphaned fails queued and running jobs left by a previous process and nothing else', async () => {
    const repos = h.contoso();
    await repos.jobs.create(buildJob({ id: 'job_queued', status: 'queued' }));
    await repos.jobs.create(buildJob({ id: 'job_running', status: 'running', startedAt: at(1) }));
    await repos.jobs.create(
      buildJob({ id: 'job_ok', status: 'succeeded', completedAt: at(2), cancellable: false }),
    );
    await repos.jobs.create(
      buildJob({
        id: 'job_failed',
        status: 'failed',
        completedAt: at(2),
        cancellable: false,
        error: { code: 'x', message: 'earlier failure' },
      }),
    );
    await h
      .fabrikam()
      .jobs.create(buildJob({ id: 'job_other', tenantId: TENANT_B, status: 'running' }));

    h.clock.set('2026-01-15T10:00:00.000Z');
    expect(await repos.jobs.failOrphaned('The API restarted while the job was running')).toBe(2);
    for (const id of ['job_queued', 'job_running']) {
      expect(await repos.jobs.get(id)).toMatchObject({
        status: 'failed',
        completedAt: '2026-01-15T10:00:00.000Z',
        cancellable: false,
        error: { code: 'orphaned', message: 'The API restarted while the job was running' },
      });
    }
    expect((await repos.jobs.get('job_ok'))?.status).toBe('succeeded');
    expect((await repos.jobs.get('job_failed'))?.error?.message).toBe('earlier failure');
    expect((await h.fabrikam().jobs.get('job_other'))?.status).toBe('running');
    expect(await repos.jobs.failOrphaned('again')).toBe(0);
  });
});

describe('idempotency keys', () => {
  it('reserves, detects in-progress duplicates and conflicts, replays, and releases', async () => {
    const repos = h.contoso();
    expect(await repos.idempotency.begin('key-1', 'ingest', 'hash-a')).toEqual({ state: 'new' });
    expect(await repos.idempotency.begin('key-1', 'ingest', 'hash-a')).toEqual({
      state: 'in_progress',
    });
    expect(await repos.idempotency.begin('key-1', 'ingest', 'hash-b')).toEqual({
      state: 'conflict',
    });
    // A different scope is a different reservation.
    expect(await repos.idempotency.begin('key-1', 'analyze', 'hash-b')).toEqual({ state: 'new' });

    await repos.idempotency.complete('key-1', 'ingest', 201, {
      caseId: 'case_alpha',
      created: true,
    });
    expect(await repos.idempotency.begin('key-1', 'ingest', 'hash-a')).toEqual({
      state: 'replay',
      status: 201,
      response: { caseId: 'case_alpha', created: true },
    });
    expect(await repos.idempotency.begin('key-1', 'ingest', 'hash-a')).toMatchObject({
      state: 'replay',
    });
    expect(await repos.idempotency.begin('key-1', 'ingest', 'hash-b')).toEqual({
      state: 'conflict',
    });

    await repos.idempotency.release('key-1', 'analyze');
    expect(await repos.idempotency.begin('key-1', 'analyze', 'hash-c')).toEqual({ state: 'new' });
    // Completed keys cannot be released: the stored response must keep being replayed.
    await repos.idempotency.release('key-1', 'ingest');
    expect(await repos.idempotency.begin('key-1', 'ingest', 'hash-a')).toMatchObject({
      state: 'replay',
    });
  });

  it('expires completed keys after the TTL and takes over abandoned reservations', async () => {
    const repos = h.contoso();
    await repos.idempotency.begin('key-ttl', 'ingest', 'hash-a');
    await repos.idempotency.complete('key-ttl', 'ingest', 200, { ok: true });
    await repos.idempotency.begin('key-crashed', 'ingest', 'hash-a');

    // Past the reservation window the abandoned key can be taken over; the completed one still replays.
    h.clock.advance(6 * 60 * 1000);
    expect(await repos.idempotency.begin('key-crashed', 'ingest', 'hash-a')).toEqual({
      state: 'new',
    });
    expect(await repos.idempotency.begin('key-ttl', 'ingest', 'hash-a')).toMatchObject({
      state: 'replay',
    });

    // Past the TTL everything expires and is cleaned up.
    h.clock.advance(25 * 60 * 60 * 1000);
    expect(await repos.idempotency.begin('key-ttl', 'ingest', 'hash-different')).toEqual({
      state: 'new',
    });
    const remaining = await h.database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM idempotency_keys WHERE tenant_id = 'tenant_contoso_support'",
    );
    expect(remaining.rows[0]?.n).toBe(1);
  });

  it('validates input and refuses to complete a key that was never reserved', async () => {
    const repos = h.contoso();
    await expect(repos.idempotency.complete('never', 'ingest', 200, {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(repos.idempotency.begin('', 'ingest', 'h')).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(repos.idempotency.begin('k'.repeat(256), 'ingest', 'h')).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await repos.idempotency.begin('key-big', 'ingest', 'h');
    await expect(repos.idempotency.complete('key-big', 'ingest', 99, {})).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(
      repos.idempotency.complete('key-big', 'ingest', 200, {
        blob: 'x'.repeat(MAX_IDEMPOTENT_RESPONSE_BYTES),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await repos.idempotency.complete('key-big', 'ingest', 200, undefined);
    expect(await repos.idempotency.begin('key-big', 'ingest', 'h')).toEqual({
      state: 'replay',
      status: 200,
      response: null,
    });
  });

  it('concurrent first requests with the same key: exactly one proceeds', async () => {
    const repos = h.contoso();
    const states = await Promise.all(
      Array.from({ length: 6 }, () => repos.idempotency.begin('key-race', 'ingest', 'hash')),
    );
    expect(states.filter((s) => s.state === 'new')).toHaveLength(1);
    expect(states.filter((s) => s.state === 'in_progress')).toHaveLength(5);
  });
});

describe('telemetry and prompt versions', () => {
  const usageOf = (
    execution: ReturnType<typeof buildExecution>,
    patch: Partial<TokenUsage>,
  ): TokenUsage => ({
    ...(execution.usage as TokenUsage),
    ...patch,
  });

  async function seedExecutions() {
    const repos = h.contoso();
    await repos.cases.ingest(buildIngestInput());
    const base = (id: string, agent: Parameters<typeof buildExecution>[0] = {}) =>
      buildExecution({ id, ...agent });
    const e1 = base('exe_1', { agent: 'evidence_classifier', startedAt: at(60), latencyMs: 100 });
    const e2 = base('exe_2', { agent: 'hypothesis_generator', startedAt: at(61), latencyMs: 300 });
    const e3 = base('exe_3', {
      agent: 'evidence_classifier',
      startedAt: at(62),
      latencyMs: 10,
      status: 'cache_hit',
    });
    const e4 = buildExecution({
      id: 'exe_4',
      agent: 'quality_judge',
      startedAt: at(63),
      latencyMs: 50,
      status: 'failed',
      error: 'timeout',
      tokenUsageId: null,
      usage: null,
    });
    const e5 = base('exe_5', {
      agent: 'communication_coach',
      startedAt: at(64),
      latencyMs: 20,
      caseId: null,
      analysisRunId: null,
    });
    const old = base('exe_old', {
      agent: 'evidence_classifier',
      startedAt: '2026-01-10T09:00:00.000Z',
      latencyMs: 40,
    });
    const items = [
      {
        ...e1,
        usage: usageOf(e1, {
          promptTokens: 1000,
          completionTokens: 200,
          cachedTokens: 0,
          totalTokens: 1200,
          contextTokensBefore: 1200,
          contextTokensAfter: 1000,
          estimatedCostUsd: 0.012,
        }),
      },
      {
        ...e2,
        usage: usageOf(e2, {
          promptTokens: 2000,
          completionTokens: 400,
          cachedTokens: 100,
          totalTokens: 2400,
          contextTokensBefore: 2400,
          contextTokensAfter: 2000,
          estimatedCostUsd: null,
        }),
      },
      {
        ...e3,
        usage: usageOf(e3, {
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 900,
          totalTokens: 0,
          cacheHit: true,
          estimatedSavingsTokens: 900,
          contextTokensBefore: 900,
          contextTokensAfter: 900,
          estimatedCostUsd: 0,
        }),
      },
      e4,
      {
        ...e5,
        usage: usageOf(e5, {
          promptTokens: 400,
          completionTokens: 100,
          totalTokens: 500,
          earlyStopped: true,
          estimatedSavingsTokens: 300,
          estimatedCostUsd: 0.003,
        }),
      },
      { ...old, usage: usageOf(old, { promptTokens: 50, completionTokens: 10, totalTokens: 60 }) },
    ];
    await repos.telemetry.saveExecutions(items);
    return { repos, items };
  }

  it('aggregates executions, tokens, failures, cache hits, savings and the daily total', async () => {
    const { repos } = await seedExecutions();
    const all = await repos.telemetry.aggregate({});
    expect(all.totals).toEqual({
      executions: 6,
      promptTokens: 1000 + 2000 + 0 + 400 + 50,
      completionTokens: 200 + 400 + 0 + 100 + 10,
      cachedTokens: 0 + 100 + 900 + 0 + 0,
      failures: 1,
      cacheHits: 1,
      avgLatencyMs: (100 + 300 + 10 + 50 + 20 + 40) / 6,
      estimatedCostUsd: 0.012 + 0 + 0.003,
    });
    // Compression counts only executions that were neither cache hits nor early stops
    // (exe_1: 200, exe_2: 400, exe_old: 200).
    expect(all.savings).toEqual({
      contextCompressionTokens: 200 + 400 + 200,
      duplicateRemovalTokens: 0,
      cacheHitTokens: 900,
      earlyStopTokens: 300,
    });
    expect(all.byAgent.map((a) => [a.agent, a.executions, a.failures, a.cacheHits])).toEqual([
      ['communication_coach', 1, 0, 0],
      ['evidence_classifier', 3, 0, 1],
      ['hypothesis_generator', 1, 0, 0],
      ['quality_judge', 1, 1, 0],
    ]);
    expect(all.byModel).toEqual([
      {
        model: 'deterministic-knowledge-pack',
        provider: 'deterministic',
        executions: 6,
        totalTokens: 1200 + 2400 + 0 + 500 + 60,
        avgLatencyMs: (100 + 300 + 10 + 50 + 20 + 40) / 6,
      },
    ]);
    // Today (the injected clock says 2026-01-15) excludes the execution from five days earlier.
    expect(all.tokensToday).toBe(1200 + 2400 + 0 + 500);

    const forCase = await repos.telemetry.aggregate({ caseId: 'case_alpha' });
    expect(forCase.totals.executions).toBe(5);
    const recent = await repos.telemetry.aggregate({ since: '2026-01-14T00:00:00.000Z' });
    expect(recent.totals.executions).toBe(5);
    expect(recent.tokensToday).toBe(all.tokensToday);
    const empty = await h.fabrikam().telemetry.aggregate({});
    expect(empty.totals).toMatchObject({ executions: 0, promptTokens: 0, estimatedCostUsd: null });
    expect(empty.byAgent).toEqual([]);
  });

  it('lists executions newest first with filters and a stable cursor, and upserts instead of duplicating', async () => {
    const { repos, items } = await seedExecutions();
    const all = await repos.telemetry.listExecutions({ limit: 50 });
    expect(all.items.map((e) => e.id)).toEqual([
      'exe_5',
      'exe_4',
      'exe_3',
      'exe_2',
      'exe_1',
      'exe_old',
    ]);
    expect(
      (await repos.telemetry.listExecutions({ limit: 50, agent: 'evidence_classifier' })).items.map(
        (e) => e.id,
      ),
    ).toEqual(['exe_3', 'exe_1', 'exe_old']);
    expect(
      (await repos.telemetry.listExecutions({ limit: 50, caseId: 'case_alpha' })).items,
    ).toHaveLength(5);
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repos.telemetry.listExecutions({ limit: 4, cursor });
      paged.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(all.items.map((e) => e.id));

    await repos.telemetry.saveExecutions(items.slice(0, 2));
    expect((await repos.telemetry.listExecutions({ limit: 50 })).items).toHaveLength(6);
    const usageRows = await h.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM token_usage',
    );
    expect(usageRows.rows[0]?.n).toBe(5);
  });

  it('upserts prompt versions idempotently and lists them by agent and numeric semver', async () => {
    const repos = h.contoso();
    const v9 = buildPromptVersion({ id: 'pv_a_1_9_0', version: '1.9.0' });
    const v10 = buildPromptVersion({ id: 'pv_a_1_10_0', version: '1.10.0' });
    const other = buildPromptVersion({
      id: 'pv_b_1_0_0',
      agent: 'quality_judge',
      version: '1.0.0',
    });
    await repos.telemetry.upsertPromptVersions([v10, v9, other]);
    await repos.telemetry.upsertPromptVersions([
      v9,
      { ...other, status: 'retired', changeNote: 'Retired for tests' },
    ]);
    const listed = await repos.telemetry.listPromptVersions();
    expect(listed.map((p) => p.id)).toEqual(['pv_a_1_9_0', 'pv_a_1_10_0', 'pv_b_1_0_0']);
    expect(listed[2]).toMatchObject({ status: 'retired', changeNote: 'Retired for tests' });
    await expect(
      repos.telemetry.upsertPromptVersions([
        buildPromptVersion({ id: 'pv_dup', version: '1.9.0' }),
      ]),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      repos.telemetry.upsertPromptVersions([{ ...v9, tenantId: TENANT_B }]),
    ).rejects.toMatchObject({ code: 'tenant_violation' });
    expect(await h.fabrikam().telemetry.listPromptVersions()).toEqual([]);
  });
});

describe('review decisions', () => {
  it('records decisions, lists them newest first and computes statistics from the latest decision per target', async () => {
    const repos = h.contoso();
    await repos.cases.ingest(buildIngestInput());
    const decide = (
      id: string,
      targetType: 'claim' | 'counterfactual',
      targetId: string,
      decision: 'correct' | 'confirm' | 'approve' | 'reject',
      minute: number,
    ) =>
      repos.reviews.record(
        buildReviewDecision({
          id,
          targetType,
          targetId,
          decision,
          decidedAt: at(minute),
          createdAt: at(minute),
          updatedAt: at(minute),
        }),
      );
    await decide('r1', 'claim', 'clm_1', 'correct', 1);
    await decide('r2', 'claim', 'clm_1', 'confirm', 2); // clm_1 reviewed twice: counts once, latest is confirm
    await decide('r3', 'claim', 'clm_2', 'correct', 3);
    await decide('r4', 'counterfactual', 'cf_1', 'approve', 4);
    await decide('r5', 'counterfactual', 'cf_1', 'reject', 5); // later rejected: counts as rejected only
    await decide('r6', 'counterfactual', 'cf_2', 'approve', 6);
    await decide('r7', 'counterfactual', 'cf_3', 'reject', 7);

    expect(await repos.reviews.stats()).toEqual({
      reviewedClaims: 2,
      correctedClaims: 1,
      counterfactualsReviewed: 3,
      counterfactualsAccepted: 1,
      counterfactualsRejected: 2,
    });
    expect((await repos.reviews.list({ limit: 3 })).items.map((r) => r.id)).toEqual([
      'r7',
      'r6',
      'r5',
    ]);
    const second = await repos.reviews.list({
      limit: 3,
      cursor: (await repos.reviews.list({ limit: 3 })).nextCursor ?? undefined,
    });
    expect(second.items.map((r) => r.id)).toEqual(['r4', 'r3', 'r2']);
    expect((await repos.reviews.list({ limit: 50, caseId: 'case_alpha' })).items).toHaveLength(7);
    expect((await repos.reviews.list({ limit: 50, caseId: 'other' })).items).toEqual([]);
    await expect(repos.reviews.record(buildReviewDecision({ id: 'r1' }))).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await h.fabrikam().reviews.stats()).toEqual({
      reviewedClaims: 0,
      correctedClaims: 0,
      counterfactualsReviewed: 0,
      counterfactualsAccepted: 0,
      counterfactualsRejected: 0,
    });
  });
});

describe('governance, users and seeding', () => {
  it('returns the tenant and creates default settings for any missing section', async () => {
    const repos = h.contoso();
    expect(await repos.governance.getTenant()).toMatchObject({
      id: 'tenant_contoso_support',
      name: 'Contoso Support (synthetic)',
      synthetic: true,
    });
    await h.database.query(
      "DELETE FROM governance_settings WHERE tenant_id = 'tenant_contoso_support' AND section IN ('model', 'quality')",
    );
    const settings = await repos.governance.getSettings();
    expect(Object.keys(settings).sort()).toEqual([
      'action_value',
      'export_controls',
      'feature_flags',
      'model',
      'quality',
      'redaction',
      'retention',
    ]);
    expect(settings.model).toMatchObject({
      version: 1,
      updatedBy: 'user_ava_engineer',
      changeNote: 'Default configuration',
    });
    expect(settings.model.value.provider).toBe('deterministic');
    expect(settings.retention.updatedBy).toBe('system:seed');
  });

  it('[NFR-REL-01] updates one section with optimistic locking and field-level validation errors', async () => {
    const repos = h.contoso();
    const current = await repos.governance.getSettings();
    const next = { ...current.retention.value, caseDataDays: 90, version: '1.1.0' };
    const updated = await repos.governance.updateSection('retention', next, {
      expectedVersion: 1,
      changeNote: 'Shorter retention for the pilot',
      by: 'user_alex_admin',
    });
    expect(updated.retention).toMatchObject({
      value: { caseDataDays: 90 },
      version: 2,
      updatedBy: 'user_alex_admin',
      changeNote: 'Shorter retention for the pilot',
    });
    expect(updated.model.version).toBe(1);

    await expect(
      repos.governance.updateSection('retention', next, {
        expectedVersion: 1,
        changeNote: 'stale edit here',
        by: 'user_alex_admin',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const invalid = await repos.governance
      .updateSection(
        'retention',
        { ...next, caseDataDays: 0 },
        { expectedVersion: 2, changeNote: 'invalid value attempt', by: 'user_alex_admin' },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(invalid).toBeInstanceOf(ValidationFailedError);
    expect((invalid as ValidationFailedError).issues.map((i) => i.path)).toContain('caseDataDays');
    await expect(
      repos.governance.updateSection(
        'bogus' as never,
        {},
        { expectedVersion: 1, changeNote: 'unknown section', by: 'x' },
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.governance.updateSection('retention', next, {
        expectedVersion: 2,
        changeNote: 'x',
        by: 'user_alex_admin',
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect((await repos.governance.getSettings()).retention.version).toBe(2);
  });

  it('lists the seeded users and updates roles with optimistic locking', async () => {
    const repos = h.contoso();
    const users = await repos.governance.listUsers();
    expect(users.map((u) => u.id).sort()).toEqual([
      'user_alex_admin',
      'user_ava_engineer',
      'user_casey_curator',
      'user_morgan_manager',
      'user_riley_reviewer',
    ]);
    expect(
      users.every(
        (u) => u.synthetic && u.email.endsWith('.invalid') && u.displayName.endsWith('(synthetic)'),
      ),
    ).toBe(true);
    expect((await repos.governance.getUser('user_ava_engineer'))?.roles).toEqual(['engineer']);
    expect(await repos.governance.getUser('user_fabi_engineer')).toBeNull();

    h.clock.advance(1000);
    const promoted = await repos.governance.updateUserRoles(
      'user_ava_engineer',
      ['engineer', 'reviewer', 'reviewer'],
      1,
    );
    expect(promoted).toMatchObject({
      roles: ['engineer', 'reviewer'],
      version: 2,
      updatedAt: '2026-01-15T09:00:01.000Z',
    });
    await expect(
      repos.governance.updateUserRoles('user_ava_engineer', ['manager'], 1),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      repos.governance.updateUserRoles('user_ava_engineer', [], 2),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.governance.updateUserRoles('user_ava_engineer', ['root' as never], 2),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.governance.updateUserRoles('user_missing', ['manager'], 1),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('seedFoundation is idempotent and never overwrites later changes; personas match the seeded users', async () => {
    const again = await seedFoundation(h.database);
    expect(again).toEqual({ tenantsCreated: 0, usersCreated: 0, settingsCreated: 0 });
    await h.contoso().governance.updateUserRoles('user_ava_engineer', ['manager'], 1);
    await seedFoundation(h.database);
    expect((await h.contoso().governance.getUser('user_ava_engineer'))?.roles).toEqual(['manager']);

    const users = [
      ...(await h.contoso().governance.listUsers()),
      ...(await h.fabrikam().governance.listUsers()),
    ];
    expect(DEV_PERSONAS.map((p) => p.id).sort()).toEqual(users.map((u) => u.id).sort());
    const ava = DEV_PERSONAS.find((p) => p.id === 'user_ava_engineer');
    expect(ava).toMatchObject({
      role: 'engineer',
      tenantId: 'tenant_contoso_support',
      displayName: 'Ava Engineer (synthetic)',
    });
    expect(DEV_PERSONAS.find((p) => p.id === 'user_fabi_engineer')?.tenantId).toBe(
      'tenant_fabrikam_lab',
    );
    expect(DEV_PERSONAS).toHaveLength(6);
  });
});
