import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  aggregateSkillEffectiveness,
  createFullView,
  impactPrecedentOf,
  runDeterministicAnalysis,
  type MatchableSkill,
  type SkillImpactPrecedent,
} from '@caseguard/domain';
import { DEFAULT_ACTION_VALUE_CONFIG, type SkillContent } from '@caseguard/schemas';
import {
  AppError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationFailedError,
} from '../src/errors';
import type { RequestContext } from '../src/http/request-context';
import type { CaseReplay, ReplayLoader } from '../src/services/counterfactuals/replay';
import {
  PrecedentLoader,
  originCaseIdOf,
  precedentFor,
  type OriginPrecedent,
} from '../src/services/skills/precedent';
import { buildSkillUsage } from '../src/services/skills/usage';
import {
  TENANT,
  ctxOne,
  draft,
  entry,
  measuredOne,
  minimumEvidence,
  one,
  pack,
  replayOf,
  replayOne,
  replayTwo,
  runOf,
} from './skills-world';

/*
 * Pure unit tests of how an application is compared with the recorded path of the case the skill came
 * from: the loader that measures that path (with fakes for the case store and the replay), and the
 * records it puts on a usage. The engine runs on the real synthetic cases (`skills-world.ts`);
 * nothing touches a database.
 */

describe('which case a skill came from', () => {
  it('is the source case with the role origin, else the first case the skill names, else none', () => {
    expect(originCaseIdOf(entry)).toBe('case_unit_one');
    const withRoles = (sourceCases: SkillContent['sourceCases']): MatchableSkill => ({
      skill: entry.skill,
      version: { ...entry.version, content: { ...entry.version.content, sourceCases } },
    });
    const [origin] = entry.version.content.sourceCases;
    if (origin === undefined) throw new Error('the draft names no source case');
    expect(
      originCaseIdOf(
        withRoles([
          { caseId: 'case_unit_two', reference: 'CG-SYN-1002', role: 'mutation_source' },
          origin,
        ]),
      ),
    ).toBe('case_unit_one');
    expect(originCaseIdOf(withRoles([{ ...origin, role: 'validation' }]))).toBe(
      entry.skill.sourceCaseIds[0],
    );
    expect(
      originCaseIdOf({
        skill: { ...entry.skill, sourceCaseIds: [] },
        version: { ...entry.version, content: { ...entry.version.content, sourceCases: [] } },
      }),
    ).toBeNull();
  });
});

describe('what an application is compared with', () => {
  const measured: OriginPrecedent = {
    kind: 'measured',
    caseId: 'case_unit_one',
    key: 'measured-key',
    precedent: measuredOne,
  };
  const gone: OriginPrecedent = {
    kind: 'unavailable',
    caseId: 'case_unit_one',
    key: 'gone|case_unit_one',
  };

  it('never compares the origin case with its own recorded path', () => {
    expect(precedentFor(measured, 'case_unit_one')).toEqual({
      precedent: null,
      unavailable: 'origin_case',
    });
    expect(precedentFor(gone, 'case_unit_one')).toEqual({
      precedent: null,
      unavailable: 'origin_case',
    });
    expect(precedentFor(measured, 'case_unit_two')).toEqual({ precedent: measuredOne });
    expect(precedentFor(gone, 'case_unit_two')).toEqual({
      precedent: null,
      unavailable: 'origin_unavailable',
    });
    const nowhere: OriginPrecedent = { kind: 'unavailable', caseId: null, key: 'no-origin' };
    expect(precedentFor(nowhere, 'case_unit_two')).toEqual({
      precedent: null,
      unavailable: 'origin_unavailable',
    });
  });

  it('puts only the figures an aggregate needs on the usage record, and changes nothing else', () => {
    const plain = buildSkillUsage({ replay: replayTwo, entry, applied: true });
    expect('precedent' in plain.record).toBe(false);
    expect('precedentUnavailable' in plain.record).toBe(false);

    const withPrecedent = buildSkillUsage({
      replay: replayTwo,
      entry,
      applied: true,
      precedent: { precedent: measuredOne },
    });
    expect(withPrecedent.record.precedent).toEqual({
      reference: 'CG-SYN-1001',
      timeToDiagnosisMinutes: measuredOne.timeToDiagnosisMinutes,
      tokenEstimate: measuredOne.tokenEstimate,
      evidenceCompleteness: measuredOne.evidenceCompleteness,
    });
    expect(withPrecedent.record.precedentUnavailable).toBeUndefined();
    const { precedent: _precedent, ...rest } = withPrecedent.record;
    expect(rest).toEqual(plain.record);
    // The simulated baseline, the conformance and the impact estimate are exactly what they were.
    expect(withPrecedent.impact).toEqual(plain.impact);
    expect(withPrecedent.conformance).toEqual(plain.conformance);

    const skipped = buildSkillUsage({
      replay: replayTwo,
      entry,
      applied: true,
      precedent: { precedent: null, unavailable: 'origin_case' },
    });
    expect(skipped.record).toMatchObject({ precedent: null, precedentUnavailable: 'origin_case' });
    const { precedent: _none, precedentUnavailable: _why, ...bare } = skipped.record;
    expect(bare).toEqual(plain.record);
  });

  it('reads Case Two as faster and lighter than Case One, next to a simulated baseline that says the opposite', () => {
    const usage = buildSkillUsage({
      replay: replayTwo,
      entry,
      applied: true,
      precedent: { precedent: measuredOne },
    });
    const { effectiveness } = aggregateSkillEffectiveness([usage.record], {
      skillId: draft.skill.id,
    });
    const block = effectiveness.precedent;
    if (block === undefined) throw new Error('expected a precedent block');
    expect(block).toMatchObject({ cases: 1, references: ['CG-SYN-1001'] });
    expect(block.avgTimeToDiagnosisMinutes).toBe(usage.record.timeToDiagnosisMinutes);
    expect(block.precedentAvgTimeToDiagnosisMinutes).toBe(measuredOne.timeToDiagnosisMinutes);
    expect(block.avgTimeToDiagnosisMinutes ?? Infinity).toBeLessThan(
      block.precedentAvgTimeToDiagnosisMinutes ?? 0,
    );
    expect(block.tokenChangePct ?? Infinity).toBeLessThan(0);
    // The simulated figures keep their own, unflattering, reading: they are not the headline any more.
    expect(effectiveness.avgTimeToDiagnosisMinutes).toBe(usage.record.timeToDiagnosisMinutes);
    expect(effectiveness.baselineAvgTimeToDiagnosisMinutes).toBe(
      Math.round((usage.record.baselineTimeToDiagnosisMinutes ?? 0) * 100) / 100,
    );
  });
});

describe('measuring the recorded path of the case a skill came from', () => {
  type Warn = Mock<(fields: Record<string, unknown>, message: string) => void>;
  interface Fakes {
    readonly ctx: RequestContext;
    readonly warn: Warn;
    readonly aborter: AbortController;
    /** What the case store answers for the origin: its run, or nothing when it is gone. */
    readonly origin: { exists: boolean; runId: string };
  }
  const fakes = (): Fakes => {
    const warn: Warn = vi.fn();
    const aborter = new AbortController();
    const origin = { exists: true, runId: 'run_unit_1' };
    const ctx = {
      repos: {
        cases: {
          get: (id: string) =>
            Promise.resolve(origin.exists && id === 'case_unit_one' ? one.case : null),
        },
        analysis: {
          getLatestRun: (id: string) =>
            Promise.resolve(
              origin.exists && id === 'case_unit_one' ? runOf(ctxOne, origin.runId) : null,
            ),
        },
        governance: {
          getSettings: () =>
            Promise.resolve({ action_value: { value: DEFAULT_ACTION_VALUE_CONFIG, version: 1 } }),
        },
      },
      scope: { tenantId: TENANT },
      now: () => new Date('2026-06-01T09:00:00.000Z'),
      signal: aborter.signal,
      logger: { warn },
    } as unknown as RequestContext;
    return { ctx, warn, aborter, origin };
  };
  const loaderOver = (load: () => Promise<CaseReplay>) => {
    const spy = vi.fn(load);
    return { loader: new PrecedentLoader({ load: spy } as unknown as ReplayLoader), load: spy };
  };

  it('measures the origin once per run and gives every later application the same figures for free', async () => {
    const { ctx } = fakes();
    const { loader, load } = loaderOver(() => Promise.resolve(replayOne));
    const hook = vi.fn();
    const first = await loader.resolve(ctx, entry, { beforeColdPass: hook });
    expect(first).toMatchObject({ kind: 'measured', caseId: 'case_unit_one' });
    if (first.kind !== 'measured') throw new Error('expected a measured precedent');
    expect(first.precedent).toEqual(measuredOne);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);

    const again = await loader.resolve(ctx, entry, { beforeColdPass: hook });
    expect(again).toEqual(first);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('measures again when the origin has a new run, and keeps the two measurements apart', async () => {
    const f = fakes();
    const { loader, load } = loaderOver(() => Promise.resolve(replayOne));
    const first = await loader.resolve(f.ctx, entry);
    f.origin.runId = 'run_unit_1b';
    const second = await loader.resolve(f.ctx, entry);
    expect(load).toHaveBeenCalledTimes(2);
    expect(second.key).not.toBe(first.key);
  });

  it('gives no precedent, and runs nothing, when the origin case is gone or was never analysed', async () => {
    const f = fakes();
    f.origin.exists = false;
    const { loader, load } = loaderOver(() => Promise.resolve(replayOne));
    const hook = vi.fn();
    const result = await loader.resolve(f.ctx, entry, { beforeColdPass: hook });
    expect(result).toEqual({
      kind: 'unavailable',
      caseId: 'case_unit_one',
      key: 'gone|case_unit_one',
    });
    expect(load).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
  });

  it('gives no precedent for a skill that names no origin at all', async () => {
    const { ctx } = fakes();
    const { loader, load } = loaderOver(() => Promise.resolve(replayOne));
    const nameless: MatchableSkill = {
      skill: { ...entry.skill, sourceCaseIds: [] },
      version: { ...entry.version, content: { ...entry.version.content, sourceCases: [] } },
    };
    expect(await loader.resolve(ctx, nameless)).toEqual({
      kind: 'unavailable',
      caseId: null,
      key: 'no-origin',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ['not found', () => new NotFoundError('Case', 'case_unit_one')],
    ['not analysed', () => new ConflictError('The case has not been analysed yet.')],
    ['an unsupported workload', () => new ValidationFailedError('No knowledge pack')],
  ])(
    'treats a replay that is refused (%s) as an origin that is not available, quietly',
    async (_, refusal) => {
      const f = fakes();
      const { loader } = loaderOver(() => Promise.reject(refusal()));
      const result = await loader.resolve(f.ctx, entry);
      expect(result.kind).toBe('unavailable');
      expect(f.warn).not.toHaveBeenCalled();
    },
  );

  it('survives a failure nobody expected, and logs only ids and the kind of error', async () => {
    const f = fakes();
    const { loader } = loaderOver(() =>
      Promise.reject(new TypeError('MARKER-CASE-TEXT leaked into an error message')),
    );
    const result = await loader.resolve(f.ctx, entry);
    expect(result.kind).toBe('unavailable');
    expect(f.warn).toHaveBeenCalledTimes(1);
    const [fields] = f.warn.mock.calls[0] ?? [];
    expect(fields).toEqual({
      skillId: entry.skill.id,
      originCaseId: 'case_unit_one',
      errorName: 'TypeError',
    });
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain('MARKER-CASE-TEXT');
  });

  it('never swallows an abort', async () => {
    const f = fakes();
    const { loader } = loaderOver(() => {
      f.aborter.abort();
      return Promise.reject(new Error('aborted'));
    });
    await expect(loader.resolve(f.ctx, entry)).rejects.toThrow('aborted');
  });

  it('lets the engine budget refuse before the origin is replayed, and caches nothing when it does', async () => {
    const { ctx } = fakes();
    const { loader, load } = loaderOver(() => Promise.resolve(replayOne));
    const refuse = () => {
      throw new RateLimitedError(7, 'Too many views were recomputed in a short time.');
    };
    const refused = loader.resolve(ctx, entry, { beforeColdPass: refuse });
    await expect(refused).rejects.toBeInstanceOf(RateLimitedError);
    await expect(refused).rejects.toBeInstanceOf(AppError);
    expect(load).not.toHaveBeenCalled();
    // Once the caller may spend again, the very same request is measured.
    const retried = await loader.resolve(ctx, entry);
    expect(retried.kind).toBe('measured');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('has no precedent for a path that never reached a diagnosis, and does not measure it twice', async () => {
    const { ctx } = fakes();
    // Case One as it stood after its first three events: some steps were taken, nothing was diagnosed.
    const early = runDeterministicAnalysis({
      view: createFullView(one.events.slice(0, 3), null),
      pack,
      config: DEFAULT_ACTION_VALUE_CONFIG,
      ctx: ctxOne,
    });
    const undiagnosed: SkillImpactPrecedent | null = impactPrecedentOf({
      reference: 'CG-SYN-1001',
      analysis: early,
      pack,
      minimumEvidence,
    });
    expect(undiagnosed === null || !undiagnosed.reachedDiagnosis).toBe(true);
    const { loader, load } = loaderOver(() => Promise.resolve(replayOf(one, ctxOne, early)));
    const first = await loader.resolve(ctx, entry);
    expect(first.kind).toBe('unavailable');
    expect(precedentFor(first, 'case_unit_two')).toEqual({
      precedent: null,
      unavailable: 'origin_unavailable',
    });
    await loader.resolve(ctx, entry);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
