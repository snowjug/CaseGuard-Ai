import { vi, type Mock } from 'vitest';
import {
  createFullView,
  extractSkillCandidates,
  generateCounterfactuals,
  getCompiledPack,
  impactPrecedentOf,
  runDeterministicAnalysis,
  type EngineContext,
  type MatchableSkill,
} from '@caseguard/domain';
import {
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  type AnalysisRun,
  type SkillDna,
  type SkillMatch,
} from '@caseguard/schemas';
import { VersionConflictError } from '../src/errors';
import type { AuditEventInput, RequestContext } from '../src/http/request-context';
import type { AnalysisInputs } from '../src/services/analysis';
import { ReplayLoader, type CaseReplay } from '../src/services/counterfactuals/replay';
import { SkillApplier } from '../src/services/skills/application';
import type { CaseMatcher } from '../src/services/skills/matching';
import { SAMPLE_FILES, normalizeSample } from './support/samples';

/*
 * Fixtures for the unit tests of skill application and of the recorded path of a skill's origin: the
 * real synthetic cases run through the real engine, a skill extracted from Case One, and a small
 * in-memory world (fake repositories, the real services) in which many applications of one skill can
 * be recorded, interleaved and metered without a database.
 */

export const TENANT = 'tenant_unit';
const compiled = getCompiledPack('teams-authentication');
if (compiled === null) throw new Error('the teams-authentication pack is missing');
export const pack = compiled;

export const one = normalizeSample(SAMPLE_FILES.caseOne, {
  tenantId: TENANT,
  caseId: 'case_unit_one',
});
export const two = normalizeSample(SAMPLE_FILES.caseTwo, {
  tenantId: TENANT,
  caseId: 'case_unit_two',
});
export const engineCtx = (caseId: string, runId: string): EngineContext => ({
  tenantId: TENANT,
  caseId,
  runId,
  now: '2026-01-15T09:00:00.000Z',
  createdBy: 'user_ava_engineer',
  seed: `seed-${caseId}`,
});
export const ctxOne = engineCtx('case_unit_one', 'run_unit_1');
export const ctxTwo = engineCtx('case_unit_two', 'run_unit_2');
const analyse = (normalized: typeof one, ctx: EngineContext) =>
  runDeterministicAnalysis({
    view: createFullView(normalized.events, normalized.resolution),
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx,
  });
export const analysisOne = analyse(one, ctxOne);
export const analysisTwo = analyse(two, ctxTwo);

const fork = analysisOne.forks.find((f) => f.isEarliestMeaningful) ?? analysisOne.forks[0];
if (fork === undefined) throw new Error('Case One has no fork');
const pending = generateCounterfactuals({
  analysis: analysisOne,
  fork,
  strategies: ['balanced'],
  events: one.events,
  resolution: one.resolution,
  pack,
  config: DEFAULT_ACTION_VALUE_CONFIG,
  ctx: ctxOne,
}).scenarios[0];
if (pending === undefined) throw new Error('no scenario');
const candidate = extractSkillCandidates({
  analysis: analysisOne,
  fork,
  scenarios: [{ ...pending, reviewState: 'confirmed' }],
  events: one.events,
  resolution: one.resolution,
  pack,
  config: DEFAULT_ACTION_VALUE_CONFIG,
  ctx: ctxOne,
  caseInfo: { workload: one.case.workload, product: one.case.product },
  caseReference: one.case.reference,
  synthetic: true,
}).candidates[0];
if (candidate === undefined) throw new Error('no draft skill');
export const draft = candidate;
export const entry: MatchableSkill = {
  skill: { ...draft.skill, lifecycle: 'published' },
  version: draft.version,
};

export const runOf = (ctx: EngineContext, id = ctx.runId): AnalysisRun => ({
  tenantId: TENANT,
  createdAt: ctx.now,
  updatedAt: ctx.now,
  createdBy: 'system:analysis',
  version: 1,
  id,
  caseId: ctx.caseId,
  status: 'succeeded',
  provider: 'deterministic',
  model: 'deterministic-knowledge-pack',
  simulated: true,
  knowledgePackId: pack.pack.id,
  knowledgePackVersion: pack.pack.version,
  qualityConfigVersion: '1',
  actionValueConfigVersion: '1',
  inputHash: 'hash',
  startedAt: ctx.now,
  completedAt: ctx.now,
  counts: {
    events: 0,
    evidence: 0,
    claims: 0,
    hypotheses: 0,
    actions: 0,
    forks: 0,
    warnings: 0,
    modelExecutions: 0,
  },
  error: null,
});
export const inputsOf = (normalized: typeof one): AnalysisInputs => ({
  caseRecord: normalized.case,
  source: normalized.source,
  events: normalized.events,
  resolution: normalized.resolution,
  pack,
  actionConfig: DEFAULT_ACTION_VALUE_CONFIG,
  qualityConfig: DEFAULT_QUALITY_CONFIG,
  skills: [entry],
  unitPrices: { inputPer1kUsd: null, outputPer1kUsd: null, cachedInputPer1kUsd: null },
});
export const replayOf = (
  normalized: typeof one,
  ctx: EngineContext,
  analysis: typeof analysisOne,
): CaseReplay => ({
  run: runOf(ctx),
  inputs: inputsOf(normalized),
  engineCtx: ctx,
  analysis,
});
export const replayOne = replayOf(one, ctxOne, analysisOne);
export const replayTwo = replayOf(two, ctxTwo, analysisTwo);

export const minimumEvidence = entry.version.content.minimumEvidence.map((m) => m.requirementId);
const measured = impactPrecedentOf({
  reference: one.case.reference,
  analysis: analysisOne,
  pack,
  minimumEvidence,
});
if (measured === null) throw new Error('Case One has no measurable recorded path');
export const measuredOne = measured;

/* ------------------------------------------------------------------------------------------ */
/* The in-memory world                                                                         */
/* ------------------------------------------------------------------------------------------ */

export const SKILL_ID = entry.skill.id;
/** The case the skill came from, which every world has. */
export const ORIGIN_ID = 'case_unit_one';
/** The id of the nth copy of Case Two in a world (the applications of the skill are on such copies). */
export const copyId = (n: number): string => `case_world_${String(n).padStart(2, '0')}`;

const START_MS = Date.parse('2026-05-01T09:00:00.000Z');
const NOW_MS = Date.parse('2026-06-01T09:00:00.000Z');

/** The real replay loader that records which cases it was asked for, and can pause or react to a load. */
export class CountingReplays extends ReplayLoader {
  readonly loaded: string[] = [];
  /** Runs when a load starts, before the engine does: where a test lets something else commit. */
  onLoad: ((caseId: string) => void | Promise<void>) | undefined;

  override async load(ctx: RequestContext, caseId: string): Promise<CaseReplay> {
    this.loaded.push(caseId);
    await this.onLoad?.(caseId);
    return super.load(ctx, caseId);
  }
}

export interface WorldHooks {
  /** Runs when a transaction is about to begin: where another writer can commit first. */
  beforeCommit: (() => void) | undefined;
  /** What the matcher says for a case (default: the stored match, else a fresh unapplied one). */
  computed: ((caseId: string) => SkillMatch) | undefined;
}

export interface World {
  readonly replays: CountingReplays;
  readonly applier: SkillApplier;
  readonly warn: Mock<(fields: Record<string, unknown>, message: string) => void>;
  readonly hooks: WorldHooks;
  /** Audit events, in the order they were written. */
  audits(): readonly AuditEventInput[];
  skill(): SkillDna;
  /** Stored matches of the skill, newest first. */
  matches(): readonly SkillMatch[];
  ctxFor(userId: string): RequestContext;
  /** A copy of Case Two, analysed, that the skill can be applied to. */
  addCase(caseId: string): void;
  /**
   * An application someone else recorded: the match is stored as applied. The skill moves to a new
   * version (an application commits its aggregate), unless `bumpVersion` is false.
   */
  commitApplication(caseId: string, options?: { userId?: string; bumpVersion?: boolean }): void;
  /** Any other change to the skill (a transition, an edit): it moves to a new version, nothing else. */
  touchSkill(patch?: Partial<SkillDna>): void;
  advance(ms: number): void;
}

/** A world where the skill has been applied to `applications` copies of Case Two, oldest first. */
export function createWorld(options: { applications?: number } = {}): World {
  const cases = new Map<string, { normalized: typeof one; run: AnalysisRun }>();
  cases.set(ORIGIN_ID, { normalized: one, run: runOf(ctxOne) });
  const state = {
    skill: entry.skill,
    matches: [] as SkillMatch[],
    audits: [] as AuditEventInput[],
    sequence: 0,
    nowMs: NOW_MS,
  };
  const hooks: WorldHooks = { beforeCommit: undefined, computed: undefined };
  const warn: World['warn'] = vi.fn();
  const abort = new AbortController();

  const addCase = (caseId: string): void => {
    const normalized = normalizeSample(SAMPLE_FILES.caseTwo, { tenantId: TENANT, caseId });
    cases.set(caseId, { normalized, run: runOf(engineCtx(caseId, `run_${caseId}`)) });
  };
  const freshMatch = (caseId: string, extra: Partial<SkillMatch> = {}): SkillMatch => ({
    tenantId: TENANT,
    createdAt: new Date(START_MS).toISOString(),
    updatedAt: new Date(START_MS).toISOString(),
    createdBy: 'system:skill-matching',
    version: 1,
    id: `smt_${caseId}`,
    caseId,
    skillId: SKILL_ID,
    versionId: entry.version.id,
    skillName: entry.skill.name,
    skillVersion: entry.version.version,
    lifecycle: 'published',
    asOf: new Date(START_MS).toISOString(),
    score: 0.75,
    applicability: 'applies',
    matchedTriggers: [],
    unmatchedTriggers: [],
    exclusionsHit: [],
    rationale: 'The case shows the signs the skill looks for.',
    recommendedSteps: [],
    conformance: null,
    applied: false,
    appliedAt: null,
    appliedBy: null,
    ...extra,
  });
  const storedMatch = (caseId: string): SkillMatch | undefined =>
    state.matches.find((match) => match.caseId === caseId);
  const newestFirst = (a: SkillMatch, b: SkillMatch): number =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

  const commitApplication: World['commitApplication'] = (caseId, applied = {}) => {
    if (!cases.has(caseId)) addCase(caseId);
    state.sequence += 1;
    const at = new Date(START_MS + state.sequence * 60_000).toISOString();
    state.matches = [
      ...state.matches.filter((match) => match.caseId !== caseId),
      freshMatch(caseId, {
        applied: true,
        appliedAt: at,
        appliedBy: applied.userId ?? 'user_other',
        conformance: { stepsFollowed: 3, stepsTotal: 4, score: 0.75 },
        createdAt: at,
        updatedAt: at,
      }),
    ];
    if (applied.bumpVersion !== false) {
      state.skill = { ...state.skill, version: state.skill.version + 1 };
    }
  };

  const skills = {
    get: (id: string) => Promise.resolve(id === state.skill.id ? state.skill : null),
    // The content stays that of the skill's one version; a new current version id resolves to it.
    getVersion: (skillId: string, versionId: string) =>
      Promise.resolve(
        skillId === state.skill.id &&
          (versionId === entry.version.id || versionId === state.skill.currentVersionId)
          ? { ...entry.version, id: versionId }
          : null,
      ),
    getMatch: (caseId: string, matchId: string) =>
      Promise.resolve(
        state.matches.find((match) => match.caseId === caseId && match.id === matchId) ?? null,
      ),
    listMatchesForSkill: (skillId: string) =>
      Promise.resolve(state.matches.filter((match) => match.skillId === skillId).sort(newestFirst)),
    listMatchable: () => Promise.resolve([{ skill: state.skill, version: entry.version }]),
    upsertMatch: (match: SkillMatch) => {
      state.matches = [...state.matches.filter((stored) => stored.id !== match.id), match];
      return Promise.resolve(match);
    },
    update: (_skillId: string, patch: Partial<SkillDna>, expectedVersion: number) => {
      if (expectedVersion !== state.skill.version) {
        return Promise.reject(
          new VersionConflictError('Skill', expectedVersion, state.skill.version),
        );
      }
      state.skill = { ...state.skill, ...patch, version: state.skill.version + 1 };
      return Promise.resolve(state.skill);
    },
  };
  const repos = {
    cases: {
      get: (id: string) => Promise.resolve(cases.get(id)?.normalized.case ?? null),
      getSource: (id: string) => Promise.resolve(cases.get(id)?.normalized.source ?? null),
      getAllEvents: (id: string) => Promise.resolve(cases.get(id)?.normalized.events ?? []),
      getResolution: (id: string) => Promise.resolve(cases.get(id)?.normalized.resolution ?? null),
    },
    analysis: { getLatestRun: (id: string) => Promise.resolve(cases.get(id)?.run ?? null) },
    governance: {
      getSettings: () =>
        Promise.resolve({
          action_value: { value: DEFAULT_ACTION_VALUE_CONFIG, version: 1 },
          quality: { value: DEFAULT_QUALITY_CONFIG, version: 1 },
          model: {
            value: {
              unitPrices: { inputPer1kUsd: null, outputPer1kUsd: null, cachedInputPer1kUsd: null },
            },
            version: 1,
          },
        }),
    },
    skills,
    /** All-or-nothing, like the database: a transaction that throws leaves nothing behind. */
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      hooks.beforeCommit?.();
      const before = { skill: state.skill, matches: state.matches, audits: [...state.audits] };
      try {
        return await fn(repos);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    },
  };

  const ctxFor = (userId: string): RequestContext =>
    ({
      auth: { tenantId: TENANT, userId, roles: ['support_engineer'] },
      scope: { tenantId: TENANT },
      repos,
      logger: { warn },
      now: () => new Date(state.nowMs),
      signal: abort.signal,
      audit: (event: AuditEventInput) => {
        state.audits.push(event);
        return Promise.resolve();
      },
    }) as unknown as RequestContext;

  const matcher = {
    compute: (_ctx: RequestContext, caseId: string) =>
      Promise.resolve([hooks.computed?.(caseId) ?? storedMatch(caseId) ?? freshMatch(caseId)]),
  } as unknown as CaseMatcher;

  const replays = new CountingReplays();
  const world: World = {
    replays,
    applier: new SkillApplier(replays, matcher),
    warn,
    hooks,
    audits: () => state.audits,
    skill: () => state.skill,
    matches: () => [...state.matches].sort(newestFirst),
    ctxFor,
    addCase,
    commitApplication,
    touchSkill: (patch = {}) => {
      state.skill = { ...state.skill, ...patch, version: state.skill.version + 1 };
    },
    advance: (ms) => {
      state.nowMs += ms;
    },
  };
  for (let n = 1; n <= (options.applications ?? 0); n += 1) commitApplication(copyId(n));
  return world;
}
