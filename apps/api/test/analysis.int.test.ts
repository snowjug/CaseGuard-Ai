import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationFailedError, VersionConflictError } from '../src/errors';
import { DataIntegrityError } from '../src/db/errors';
import { createRepositories } from '../src/db/repositories';
import { encodeCursor } from '../src/db/cursor';
import {
  CONTOSO_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  withFaultInjection,
  type TestHarness,
} from '../src/db/testing';
import type { AnalysisSnapshot, IngestCaseInput } from '../src/db/repositories/types';
import {
  TENANT_B,
  at,
  buildClaim,
  buildIngestInput,
  buildScenario,
  buildSkill,
  buildSkillMatch,
  buildSkillVersion,
  buildSnapshot,
  buildWarning,
} from './builders';

let h: TestHarness;
let input: IngestCaseInput;
let snapshot: AnalysisSnapshot;

beforeAll(async () => {
  h = await createTestRepositories();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  input = buildIngestInput();
  snapshot = buildSnapshot(input);
  await h.contoso().cases.ingest(input);
});

async function count(table: string, where = 'TRUE'): Promise<number> {
  const result = await h.database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  );
  return result.rows[0]?.n ?? -1;
}

describe('analysis snapshot persistence', () => {
  it('stores every artefact, validates it on the way out and points the case at the run', async () => {
    const repos = h.contoso();
    await repos.analysis.saveSnapshot(snapshot);

    expect(await repos.analysis.getLatestRun('case_alpha')).toEqual(snapshot.run);
    expect(await repos.analysis.findRunByInputHash('case_alpha', snapshot.run.inputHash)).toEqual(
      snapshot.run,
    );
    expect(await repos.analysis.findRunByInputHash('case_alpha', 'unknown')).toBeNull();
    expect(await repos.analysis.getTwin('case_alpha')).toEqual(snapshot.twin);
    expect(await repos.analysis.listEvidence('case_alpha')).toEqual(snapshot.evidence);
    expect(await repos.analysis.listHypotheses('case_alpha')).toEqual(snapshot.hypotheses);
    expect(await repos.analysis.listLinks('case_alpha')).toHaveLength(snapshot.links.length);
    expect((await repos.analysis.listClaims('case_alpha', { limit: 50 })).items).toEqual(
      snapshot.claims,
    );
    expect(await repos.analysis.listMissing('case_alpha')).toEqual(snapshot.missing);
    expect(await repos.analysis.listActions('case_alpha')).toEqual(snapshot.actions);
    expect(await repos.analysis.listForks('case_alpha')).toEqual(snapshot.forks);
    expect(await repos.analysis.getQuality('case_alpha')).toEqual(snapshot.quality);
    expect(await repos.analysis.listMetrics('case_alpha')).toEqual(snapshot.metrics);
    expect(await repos.analysis.listWarnings('case_alpha')).toEqual(snapshot.warnings);
    expect(await repos.analysis.getCoaching('case_alpha')).toEqual(snapshot.coaching);
    expect(
      (await repos.telemetry.listExecutions({ limit: 10, caseId: 'case_alpha' })).items,
    ).toHaveLength(2);

    const stored = await repos.cases.get('case_alpha');
    expect(stored).toMatchObject({
      analysisState: 'analyzed',
      lastAnalysisRunId: snapshot.run.id,
      analyzedAt: snapshot.run.completedAt,
      version: 2,
    });
    expect(await count('quality_dimensions')).toBe(6);
  });

  it('replaces the previous artefacts as a set and keeps the run history', async () => {
    const repos = h.contoso();
    await repos.analysis.saveSnapshot(snapshot);
    const second = buildSnapshot(input, { runId: 'run_case_alpha_2' });
    const trimmed: AnalysisSnapshot = { ...second, claims: second.claims.slice(0, 2), forks: [] };
    await repos.analysis.saveSnapshot(trimmed);

    const claims = (await repos.analysis.listClaims('case_alpha', { limit: 50 })).items;
    expect(claims.map((c) => c.id)).toEqual(['clm_case_alpha_1', 'clm_case_alpha_2']);
    expect(claims.every((c) => c.analysisRunId === 'run_case_alpha_2')).toBe(true);
    expect(await repos.analysis.listForks('case_alpha')).toEqual([]);
    expect((await repos.analysis.getLatestRun('case_alpha'))?.id).toBe('run_case_alpha_2');
    expect(await count('analysis_runs')).toBe(2);
    expect(await count('claims')).toBe(2);
    expect(await count('hypothesis_evidence_links')).toBe(trimmed.links.length);
  });

  it('[NFR-REL-01] is all-or-nothing: a failure while writing leaves the previous snapshot intact', async () => {
    await h.contoso().analysis.saveSnapshot(snapshot);
    const faulty = withFaultInjection(h.database);
    const repos = createRepositories(faulty, { now: h.clock.now, newId: h.newId }).forTenant(
      CONTOSO_SCOPE,
    );
    faulty.arm({ match: /INSERT INTO case_warnings/ });
    await expect(
      repos.analysis.saveSnapshot(buildSnapshot(input, { runId: 'run_case_alpha_2' })),
    ).rejects.toThrow('injected');
    faulty.disarm();

    expect((await repos.analysis.getLatestRun('case_alpha'))?.id).toBe(snapshot.run.id);
    expect(
      (await repos.analysis.listClaims('case_alpha', { limit: 50 })).items.every(
        (c) => c.analysisRunId === snapshot.run.id,
      ),
    ).toBe(true);
    expect(await count('analysis_runs')).toBe(1);
    expect(await count('case_warnings')).toBe(2);
  });

  it('[NFR-SEC-05] rejects snapshots that cite events that do not exist', async () => {
    const forged: AnalysisSnapshot = {
      ...snapshot,
      evidence: snapshot.evidence.map((e, i) => (i === 0 ? { ...e, eventId: 'evt_forged' } : e)),
    };
    await expect(h.contoso().analysis.saveSnapshot(forged)).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringContaining('evt_forged') as string,
    });
    expect(await count('analysis_runs')).toBe(0);
  });

  it('rejects structurally inconsistent snapshots before touching the database', async () => {
    const repos = h.contoso();
    await expect(
      repos.analysis.saveSnapshot({
        ...snapshot,
        run: { ...snapshot.run, status: 'running', completedAt: null },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.analysis.saveSnapshot({
        ...snapshot,
        claims: [...snapshot.claims, snapshot.claims[0] ?? buildClaim()],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.analysis.saveSnapshot({
        ...snapshot,
        links: snapshot.links.map((l, i) => (i === 0 ? { ...l, evidenceId: 'ev_missing' } : l)),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.analysis.saveSnapshot({
        ...snapshot,
        claims: snapshot.claims.map((c) => ({ ...c, analysisRunId: 'run_other' })),
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.analysis.saveSnapshot({
        ...snapshot,
        hypotheses: Array.from({ length: 51 }, (_, i) => ({
          ...(snapshot.hypotheses[0] ?? buildClaim()),
          id: `h_${i}`,
          key: `k${i}`,
        })) as never,
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.analysis.saveSnapshot(
        buildSnapshot(buildIngestInput({ caseId: 'case_missing', receivedSeed: 'nope' })),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await count('analysis_runs')).toBe(0);
  });
});

describe('reviewer decisions survive re-analysis', () => {
  it('carries claim review, warning dismissal and fork review forward for rows that keep their id', async () => {
    const repos = h.contoso();
    await repos.analysis.saveSnapshot(snapshot);

    const reviewed = await repos.analysis.reviewClaim('case_alpha', 'clm_case_alpha_1', {
      reviewedCategory: 'confirmed_fact',
      reason: 'Verified in the sign-in logs',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: at(200),
      expectedVersion: 1,
    });
    expect(reviewed).toMatchObject({
      reviewState: 'corrected',
      category: 'confirmed_fact',
      aiCategory: 'customer_reported',
      version: 2,
    });
    await repos.analysis.dismissWarning('case_alpha', 'warn_case_alpha_scope', {
      by: 'user_riley_reviewer',
      at: at(201),
      reason: 'Scope was confirmed by phone',
      expectedVersion: 1,
    });
    await repos.analysis.updateForkReview('case_alpha', 'fork_case_alpha_1', {
      reviewState: 'rejected',
      reason: 'The alternative is not realistic',
      expectedVersion: 1,
    });

    // Re-analysis: same deterministic ids, fresh (pending) content, one flag fewer, one claim dropped.
    const second = buildSnapshot(input, { runId: 'run_case_alpha_2' });
    await repos.analysis.saveSnapshot({
      ...second,
      claims: second.claims
        .slice(0, 3)
        .map((c) => (c.id === 'clm_case_alpha_3' ? { ...c, flags: [] } : c)),
    });

    const claims = (await repos.analysis.listClaims('case_alpha', { limit: 50 })).items;
    const first = claims.find((c) => c.id === 'clm_case_alpha_1');
    expect(first).toMatchObject({
      reviewState: 'corrected',
      reviewedCategory: 'confirmed_fact',
      category: 'confirmed_fact',
      aiCategory: 'customer_reported',
      reviewReason: 'Verified in the sign-in logs',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: at(200),
      analysisRunId: 'run_case_alpha_2',
      version: 3,
    });
    expect(claims.find((c) => c.id === 'clm_case_alpha_2')).toMatchObject({
      reviewState: 'pending',
      version: 2,
    });
    // Flags only accumulate: the earlier assumption_as_fact concern is not silently dropped.
    expect(claims.find((c) => c.id === 'clm_case_alpha_3')?.flags).toEqual(['assumption_as_fact']);

    const warnings = await repos.analysis.listWarnings('case_alpha');
    expect(warnings.find((w) => w.id === 'warn_case_alpha_scope')).toMatchObject({
      state: 'dismissed',
      dismissal: { by: 'user_riley_reviewer', reason: 'Scope was confirmed by phone' },
      analysisRunId: 'run_case_alpha_2',
    });
    expect(warnings.find((w) => w.id === 'warn_case_alpha_logs')?.state).toBe('open');

    expect(await repos.analysis.listForks('case_alpha')).toMatchObject([
      {
        id: 'fork_case_alpha_1',
        reviewState: 'rejected',
        reviewReason: 'The alternative is not realistic',
        analysisRunId: 'run_case_alpha_2',
      },
    ]);

    // A UI that still holds the pre-analysis version is told to reload.
    await expect(
      repos.analysis.reviewClaim('case_alpha', 'clm_case_alpha_1', {
        reviewedCategory: 'confirmed_fact',
        reason: 'stale edit',
        reviewedBy: 'user_riley_reviewer',
        reviewedAt: at(300),
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: 'version_conflict', details: { expected: 2, actual: 3 } });
  });

  it('does not carry review state onto rows with a new id and drops rows that vanished', async () => {
    const repos = h.contoso();
    await repos.analysis.saveSnapshot(snapshot);
    await repos.analysis.reviewClaim('case_alpha', 'clm_case_alpha_2', {
      reviewedCategory: 'confirmed_fact',
      reason: 'verified',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: at(200),
      expectedVersion: 1,
    });
    const second = buildSnapshot(input, { runId: 'run_case_alpha_2' });
    const renamed = second.claims.map((c) =>
      c.id === 'clm_case_alpha_2' ? { ...c, id: 'clm_case_alpha_2b' } : c,
    );
    await repos.analysis.saveSnapshot({ ...second, claims: renamed });
    expect(await repos.analysis.getClaim('case_alpha', 'clm_case_alpha_2')).toBeNull();
    expect(await repos.analysis.getClaim('case_alpha', 'clm_case_alpha_2b')).toMatchObject({
      reviewState: 'pending',
      version: 1,
    });
  });

  it('keeps an applied skill match applied after re-analysis', async () => {
    const repos = h.contoso();
    await repos.skills.create({
      skill: buildSkill({ lifecycle: 'pilot' }),
      version: buildSkillVersion(),
    });
    const match = buildSkillMatch();
    await repos.analysis.saveSnapshot({ ...snapshot, skillMatches: [match] });
    await repos.skills.upsertMatch({
      ...match,
      applied: true,
      appliedAt: at(210),
      appliedBy: 'user_ava_engineer',
      version: 2,
    });

    await repos.analysis.saveSnapshot({
      ...buildSnapshot(input, { runId: 'run_case_alpha_2' }),
      skillMatches: [match],
    });
    expect(await repos.analysis.listSkillMatches('case_alpha')).toMatchObject([
      {
        id: match.id,
        applied: true,
        appliedBy: 'user_ava_engineer',
        appliedAt: at(210),
        version: 3,
      },
    ]);
  });
});

describe('[NFR-REL-01] optimistic locking on reviewable rows', () => {
  beforeEach(async () => {
    await h.contoso().analysis.saveSnapshot(snapshot);
  });

  const review = (
    expectedVersion: number,
    category: 'confirmed_fact' | 'customer_reported' = 'confirmed_fact',
  ) => ({
    reviewedCategory: category,
    reason: 'reviewer decision',
    reviewedBy: 'user_riley_reviewer',
    reviewedAt: at(250),
    expectedVersion,
  });

  it('a stale claim review is rejected and a fresh one increments the version', async () => {
    const repos = h.contoso();
    const first = await repos.analysis.reviewClaim('case_alpha', 'clm_case_alpha_1', review(1));
    expect(first.version).toBe(2);
    await expect(
      repos.analysis.reviewClaim('case_alpha', 'clm_case_alpha_1', review(1)),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const confirmed = await repos.analysis.reviewClaim(
      'case_alpha',
      'clm_case_alpha_1',
      review(2, 'customer_reported'),
    );
    expect(confirmed).toMatchObject({
      reviewState: 'confirmed',
      category: 'customer_reported',
      version: 3,
    });
    // The original AI classification is never overwritten (FR-EV-03).
    expect(confirmed.aiCategory).toBe('customer_reported');
    await expect(
      repos.analysis.reviewClaim('case_alpha', 'clm_missing', review(1)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('two concurrent reviews with the same expected version: exactly one wins', async () => {
    const repos = h.contoso();
    const results = await Promise.allSettled([
      repos.analysis.reviewClaim('case_alpha', 'clm_case_alpha_2', review(1)),
      repos.analysis.reviewClaim('case_alpha', 'clm_case_alpha_2', review(1, 'customer_reported')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected && 'reason' in rejected ? rejected.reason : null).toBeInstanceOf(
      VersionConflictError,
    );
    expect((await repos.analysis.getClaim('case_alpha', 'clm_case_alpha_2'))?.version).toBe(2);
  });

  it('warnings: dismissal needs the current version, an open warning and a real reason', async () => {
    const repos = h.contoso();
    const dismissal = {
      by: 'user_riley_reviewer',
      at: at(260),
      reason: 'Not applicable for this customer',
      expectedVersion: 1,
    };
    await expect(
      repos.analysis.dismissWarning('case_alpha', 'warn_case_alpha_scope', {
        ...dismissal,
        expectedVersion: 7,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      repos.analysis.dismissWarning('case_alpha', 'warn_case_alpha_scope', {
        ...dismissal,
        reason: 'no',
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    const dismissed = await repos.analysis.dismissWarning(
      'case_alpha',
      'warn_case_alpha_scope',
      dismissal,
    );
    expect(dismissed).toMatchObject({
      state: 'dismissed',
      version: 2,
      dismissal: { by: 'user_riley_reviewer', reason: dismissal.reason },
    });
    await expect(
      repos.analysis.dismissWarning('case_alpha', 'warn_case_alpha_scope', {
        ...dismissal,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      (await repos.analysis.listWarnings('case_alpha', { state: 'dismissed' })).map((w) => w.id),
    ).toEqual(['warn_case_alpha_scope']);
    expect(
      (await repos.analysis.listWarnings('case_alpha', { state: 'open' })).map((w) => w.id),
    ).toEqual(['warn_case_alpha_logs']);
  });

  it('forks and counterfactual scenarios: stale reviews conflict, fresh ones increment the version', async () => {
    const repos = h.contoso();
    await expect(
      repos.analysis.updateForkReview('case_alpha', 'fork_case_alpha_1', {
        reviewState: 'confirmed',
        reason: null,
        expectedVersion: 5,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(
      await repos.analysis.updateForkReview('case_alpha', 'fork_case_alpha_1', {
        reviewState: 'confirmed',
        reason: null,
        expectedVersion: 1,
      }),
    ).toMatchObject({ reviewState: 'confirmed', version: 2 });

    await repos.counterfactuals.saveScenarios([buildScenario()]);
    const scenarioReview = (expectedVersion: number) => ({
      reviewState: 'confirmed' as const,
      reason: 'Looks realistic',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: at(270),
      expectedVersion,
    });
    await expect(
      repos.counterfactuals.review(
        'case_alpha',
        'cf_case_alpha_fork_1_balanced',
        scenarioReview(3),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const accepted = await repos.counterfactuals.review(
      'case_alpha',
      'cf_case_alpha_fork_1_balanced',
      scenarioReview(1),
    );
    expect(accepted).toMatchObject({
      reviewState: 'confirmed',
      reviewedBy: 'user_riley_reviewer',
      version: 2,
    });
    await expect(
      repos.counterfactuals.review('case_alpha', 'cf_missing', scenarioReview(1)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('[FR-CF-02] temporal (asOf) filters are applied in SQL', () => {
  beforeEach(async () => {
    const repos = h.contoso();
    const claims = [0, 1, 2, 3, 4].map((i) =>
      buildClaim({
        id: `clm_t${i}`,
        caseId: 'case_alpha',
        analysisRunId: snapshot.run.id,
        eventId: `evt_0${i + 1}`,
        timestamp: at(i * 10),
        category: i % 2 === 0 ? 'customer_reported' : 'engineer_assumption',
        aiCategory: i % 2 === 0 ? 'customer_reported' : 'engineer_assumption',
      }),
    );
    const warnings = [
      buildWarning({
        id: 'warn_early',
        ruleId: 'rule.early',
        fingerprint: 'early',
        raisedAt: at(10),
        rank: 1,
        analysisRunId: snapshot.run.id,
        state: 'resolved',
        resolvedAt: at(40),
        resolvedReason: 'Logs arrived at minute 40',
      }),
      buildWarning({
        id: 'warn_late',
        ruleId: 'rule.late',
        fingerprint: 'late',
        raisedAt: at(30),
        rank: 2,
        analysisRunId: snapshot.run.id,
      }),
    ];
    await repos.analysis.saveSnapshot({ ...snapshot, claims, warnings });
  });

  it('claims, evidence, links, actions and category counters only include rows available at asOf', async () => {
    const repos = h.contoso();
    expect(
      (await repos.analysis.listClaims('case_alpha', { limit: 50, asOf: at(20) })).items.map(
        (c) => c.id,
      ),
    ).toEqual(['clm_t0', 'clm_t1', 'clm_t2']);
    expect(
      (await repos.analysis.listEvidence('case_alpha', { asOf: at(10) })).map((e) => e.id),
    ).toEqual(['ev_case_alpha_1']);
    expect(
      (await repos.analysis.listEvidence('case_alpha', { asOf: at(10) })).every(
        (e) => Date.parse(e.observedAt) <= Date.parse(at(10)),
      ),
    ).toBe(true);
    expect(await repos.analysis.listLinks('case_alpha', { asOf: at(10) })).toHaveLength(2);
    expect(
      await repos.analysis.listLinks('case_alpha', { hypothesisId: 'hyp_case_alpha_proxy' }),
    ).toHaveLength(3);
    expect((await repos.analysis.listActions('case_alpha', at(20))).map((a) => a.id)).toEqual([
      'act_case_alpha_1',
    ]);
    expect(await repos.analysis.listActions('case_alpha', at(-1))).toEqual([]);
    expect(await repos.analysis.countClaimsByCategory('case_alpha', at(20))).toMatchObject({
      customer_reported: 2,
      engineer_assumption: 1,
      confirmed_fact: 0,
    });
    expect(await repos.analysis.countClaimsByCategory('case_alpha')).toMatchObject({
      customer_reported: 3,
      engineer_assumption: 2,
    });
    expect(
      (await repos.analysis.listEvidence('case_alpha', { ids: ['ev_case_alpha_2', 'nope'] })).map(
        (e) => e.id,
      ),
    ).toEqual(['ev_case_alpha_2']);
    expect(await repos.analysis.listEvidence('case_alpha', { ids: [] })).toEqual([]);
  });

  it('warnings are cut at raised_at and never reveal a resolution that happens after asOf', async () => {
    const repos = h.contoso();
    expect(
      (await repos.analysis.listWarnings('case_alpha', { asOf: at(5) })).map((w) => w.id),
    ).toEqual([]);
    const midway = await repos.analysis.listWarnings('case_alpha', { asOf: at(35) });
    expect(midway.map((w) => w.id)).toEqual(['warn_early', 'warn_late']);
    // At minute 35 the early warning was still open: its resolution (minute 40) is in the future.
    expect(midway[0]).toMatchObject({ state: 'open', resolvedAt: null, resolvedReason: null });
    const later = await repos.analysis.listWarnings('case_alpha', { asOf: at(60) });
    expect(later[0]).toMatchObject({
      state: 'resolved',
      resolvedReason: 'Logs arrived at minute 40',
    });
    expect(
      await repos.analysis.listWarnings('case_alpha', { asOf: at(35), state: 'resolved' }),
    ).toEqual([]);
  });

  it('rejects a malformed asOf instead of ignoring it', async () => {
    await expect(
      h.contoso().analysis.listClaims('case_alpha', { limit: 10, asOf: 'yesterday' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      h.contoso().analysis.listEvidence('case_alpha', { asOf: '2026-01-01' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('[NFR-REL-01] claims ledger pagination and filters', () => {
  it('keyset pagination is stable across pages even when every claim has the same timestamp', async () => {
    const repos = h.contoso();
    const claims = Array.from({ length: 11 }, (_, i) =>
      buildClaim({
        id: `clm_same_${String(i).padStart(2, '0')}`,
        analysisRunId: snapshot.run.id,
        eventId: 'evt_01',
        timestamp: at(0),
        text: `Identical-instant claim ${i}`,
      }),
    );
    await repos.analysis.saveSnapshot({ ...snapshot, claims });

    const everything = (await repos.analysis.listClaims('case_alpha', { limit: 200 })).items.map(
      (c) => c.id,
    );
    expect(everything).toHaveLength(11);
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repos.analysis.listClaims('case_alpha', { limit: 4, cursor });
      paged.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(everything);
    expect(new Set(paged).size).toBe(11);
  });

  it('filters by category, review state, hypothesis and text', async () => {
    const repos = h.contoso();
    await repos.analysis.saveSnapshot(snapshot);
    await repos.analysis.reviewClaim('case_alpha', 'clm_case_alpha_1', {
      reviewedCategory: 'confirmed_fact',
      reason: 'verified',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: at(200),
      expectedVersion: 1,
    });
    const ids = async (query: Parameters<typeof repos.analysis.listClaims>[1]) =>
      (await repos.analysis.listClaims('case_alpha', query)).items.map((c) => c.id);
    expect(await ids({ limit: 50, category: 'confirmed_fact' })).toEqual(['clm_case_alpha_1']);
    expect(await ids({ limit: 50, category: 'engineer_assumption' })).toEqual(['clm_case_alpha_3']);
    expect(await ids({ limit: 50, reviewState: 'corrected' })).toEqual(['clm_case_alpha_1']);
    expect(await ids({ limit: 50, reviewState: 'pending' })).toEqual([
      'clm_case_alpha_2',
      'clm_case_alpha_3',
    ]);
    expect(await ids({ limit: 50, hypothesisId: 'hyp_case_alpha_proxy' })).toEqual([
      'clm_case_alpha_1',
    ]);
    expect(await ids({ limit: 50, q: 'CLAIM 2' })).toEqual(['clm_case_alpha_2']);
    expect(await ids({ limit: 50, q: 'affected_user' })).toHaveLength(3);
  });

  it('rejects tampered cursors and cursors issued for another list', async () => {
    const repos = h.contoso();
    await repos.analysis.saveSnapshot(snapshot);
    const page = await repos.analysis.listClaims('case_alpha', { limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    const cursor = page.nextCursor ?? '';
    const tampered = `${cursor.slice(0, 5)}${cursor[5] === 'A' ? 'B' : 'A'}${cursor.slice(6)}`;
    await expect(
      repos.analysis.listClaims('case_alpha', { limit: 1, cursor: tampered }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.analysis.listClaims('case_alpha', { limit: 1, cursor: 'garbage' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    const foreign = encodeCursor('cases', [at(0), 'case_alpha']);
    await expect(
      repos.analysis.listClaims('case_alpha', { limit: 1, cursor: foreign }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(repos.analysis.listClaims('case_alpha', { limit: 0 })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(repos.analysis.listClaims('case_alpha', { limit: 201 })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});

describe('counterfactual scenarios', () => {
  beforeEach(async () => {
    await h.contoso().analysis.saveSnapshot(snapshot);
  });

  it('stores scenarios with their steps and lists them per fork', async () => {
    const repos = h.contoso();
    const balanced = buildScenario();
    const fast = buildScenario({
      id: 'cf_case_alpha_fork_1_fast',
      strategy: 'fastest_diagnosis',
      label: 'Fastest path',
      steps: [],
    });
    await repos.counterfactuals.saveScenarios([balanced, fast]);

    expect(await repos.counterfactuals.get('case_alpha', balanced.id)).toEqual(balanced);
    expect((await repos.counterfactuals.list('case_alpha')).map((s) => s.id).sort()).toEqual(
      [balanced.id, fast.id].sort(),
    );
    expect(await repos.counterfactuals.list('case_alpha', { forkId: 'fork_other' })).toEqual([]);
    expect(await count('counterfactual_steps')).toBe(1);
    expect(await repos.counterfactuals.get('case_alpha', 'cf_missing')).toBeNull();
  });

  it("a re-run that reproduces identical content keeps the reviewer's decision; changed content resets it", async () => {
    const repos = h.contoso();
    await repos.counterfactuals.saveScenarios([buildScenario()]);
    await repos.counterfactuals.review('case_alpha', 'cf_case_alpha_fork_1_balanced', {
      reviewState: 'rejected',
      reason: 'Unrealistic customer effort',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: at(280),
      expectedVersion: 1,
    });

    await repos.counterfactuals.saveScenarios([buildScenario()]);
    expect(
      await repos.counterfactuals.get('case_alpha', 'cf_case_alpha_fork_1_balanced'),
    ).toMatchObject({ reviewState: 'rejected', version: 2 });

    await repos.counterfactuals.saveScenarios([
      buildScenario({ summary: 'A different simulated outcome.' }),
    ]);
    expect(
      await repos.counterfactuals.get('case_alpha', 'cf_case_alpha_fork_1_balanced'),
    ).toMatchObject({
      reviewState: 'pending',
      summary: 'A different simulated outcome.',
      version: 3,
    });
    expect(await count('counterfactual_steps')).toBe(1);
  });

  it('scenarios survive a re-analysis; steps are removed with their scenario when the case is erased', async () => {
    const repos = h.contoso();
    await repos.counterfactuals.saveScenarios([buildScenario()]);
    await repos.analysis.saveSnapshot(buildSnapshot(input, { runId: 'run_case_alpha_2' }));
    expect(await repos.counterfactuals.list('case_alpha')).toHaveLength(1);
    await repos.cases.delete('case_alpha');
    expect(await count('counterfactual_scenarios')).toBe(0);
    expect(await count('counterfactual_steps')).toBe(0);
  });

  it('validates scenarios, tenants and step ownership', async () => {
    const repos = h.contoso();
    await expect(
      repos.counterfactuals.saveScenarios([buildScenario({ tenantId: TENANT_B })]),
    ).rejects.toMatchObject({ code: 'tenant_violation' });
    const wrongStep = buildScenario();
    await expect(
      repos.counterfactuals.saveScenarios([
        { ...wrongStep, steps: wrongStep.steps.map((s) => ({ ...s, scenarioId: 'other' })) },
      ]),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      repos.counterfactuals.saveScenarios([buildScenario({ caseId: 'case_missing' })]),
    ).rejects.toBeInstanceOf(NotFoundError);
    await repos.counterfactuals.saveScenarios([]);
  });
});

describe('read-side validation', () => {
  it('[NFR-SEC-05] throws a clear internal error instead of returning data that fails validation', async () => {
    const repos = h.contoso();
    await repos.analysis.saveSnapshot(snapshot);
    await h.database.query(
      `UPDATE claims SET data = data || '{"confidence": 7}'::jsonb WHERE id = 'clm_case_alpha_1'`,
    );
    const failure = await repos.analysis.getClaim('case_alpha', 'clm_case_alpha_1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(DataIntegrityError);
    expect(failure).toMatchObject({ code: 'internal', status: 500 });
    expect((failure as Error).message).not.toContain('7');
    await expect(repos.analysis.listClaims('case_alpha', { limit: 10 })).rejects.toBeInstanceOf(
      DataIntegrityError,
    );
  });
});

describe('analytics read model', () => {
  it('collects a bounded, tenant-scoped read model from the stored artefacts', async () => {
    const repos = h.contoso();
    await repos.skills.create({
      skill: buildSkill({ lifecycle: 'pilot' }),
      version: buildSkillVersion(),
    });
    const match = buildSkillMatch();
    await repos.analysis.saveSnapshot({ ...snapshot, skillMatches: [match] });
    await repos.counterfactuals.saveScenarios([buildScenario()]);
    await h.fabrikam().cases.ingest(buildIngestInput({ tenantId: TENANT_B, caseId: 'case_b' }));

    const source = await repos.analytics.collect(10);
    expect(source.cases).toEqual([
      {
        id: 'case_alpha',
        reference: 'CG-1001',
        synthetic: true,
        analysisState: 'analyzed',
        openedAt: input.case.openedAt,
        workload: 'teams-authentication',
      },
    ]);
    expect(source.quality).toEqual([
      {
        caseId: 'case_alpha',
        analyzedAt: snapshot.run.completedAt,
        compositeScore: 72,
        evidenceIntegrity: 72,
      },
    ]);
    expect(source.forks).toEqual([{ caseId: 'case_alpha', category: 'low_value_action' }]);
    expect(source.missing).toEqual([
      {
        caseId: 'case_alpha',
        requirementId: 'req.proxy-logs',
        label: 'Proxy logs',
        resolved: false,
      },
    ]);
    expect(source.metrics.map((m) => m.key)).toEqual([
      'case_quality_index',
      'avoidable_support_effort',
    ]);
    expect(source.metrics[1]?.ase?.components).toEqual([
      { key: 'engineer_effort', label: 'Engineer effort', avoidablePct: 33 },
    ]);
    expect(source.metrics[0]?.ase).toBeNull();
    expect(source.assumptionFlags).toMatchObject([
      { caseId: 'case_alpha', subject: 'affected_user_count' },
    ]);
    expect(source.scenarios).toEqual([
      {
        caseId: 'case_alpha',
        reviewState: 'pending',
        counterfactualTokens: 1200,
        actualTokens: 2400,
      },
    ]);
    expect(source.skills.map((s) => s.id)).toEqual(['skill_proxy']);
    expect(source.matches).toEqual([
      { caseId: 'case_alpha', skillId: 'skill_proxy', applied: false },
    ]);

    await expect(repos.analytics.collect(0)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(repos.analytics.collect(501)).rejects.toBeInstanceOf(ValidationFailedError);
    const none = await h.fabrikam().analytics.collect(5);
    expect(none.cases).toHaveLength(1);
    expect(none.quality).toEqual([]);
  });
});
