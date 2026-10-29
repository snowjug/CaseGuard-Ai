import {
  COUNTERFACTUAL_STRATEGIES,
  type CounterfactualScenario,
  type CounterfactualStrategy,
  type DecisionFork,
  type HindsightCheck,
  type Job,
  type ReviewCounterfactualBody,
} from '@caseguard/schemas';
import { sha256Hex } from '@caseguard/security';
import { ConflictError, NotFoundError, ValidationFailedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import type { ServiceDeps } from '..';
import type { CounterfactualPort, JobHandle, JobSpec } from '../ports';
import { LruCache } from './cache';
import {
  carryReview,
  defaultScenarioPlan,
  generateForFork,
  orderStrategies,
  sameSimulation,
} from './generate';
import { finalizeScenario, futureTokensFor, runSimulatorTask } from './narrative';
import { ReplayLoader } from './replay';
import { reviewScenario } from './review';

type StageReporter = (stageId: string, detail?: string) => Promise<void>;

const noStages: StageReporter = () => Promise.resolve();

const RUN_STAGES: JobSpec['stages'] = [
  { id: 'load', label: 'Load the analysis and the decision moment' },
  { id: 'simulate', label: 'Simulate alternative paths from the decision moment' },
  { id: 'validate', label: 'Validate the paths with the counterfactual simulator task' },
  { id: 'save', label: 'Save the scenarios' },
];

const LIVE_JOB = new Set(['queued', 'running', 'succeeded']);

const HINDSIGHT_TTL_MS = 60_000;
const HINDSIGHT_CACHE_ENTRIES = 64;

const MAX_REASON_CHARS = 600;

/** Job idempotency keys are capped at 120 characters, so the identity of a request is folded into a digest. */
function jobKey(
  caseId: string,
  forkId: string,
  strategies: readonly string[],
  runId: string,
): string {
  const digest = sha256Hex(`${caseId}:${forkId}:${strategies.join(',')}:${runId}`);
  return `counterfactual:${digest.slice(0, 48)}`;
}

function ineligibleMessage(fork: DecisionFork): string {
  const reasons =
    fork.eligibility.reasons.length > 0
      ? fork.eligibility.reasons
      : fork.eligibility.checks.filter((check) => !check.passed).map((check) => check.detail);
  const text = reasons.join(' ').slice(0, MAX_REASON_CHARS);
  return `The decision fork is not eligible for counterfactual simulation${text ? `: ${text}` : '.'}`;
}

/**
 * Counterfactual paths: generation (engine, validated through the AI orchestrator), review and the
 * post-hoc hindsight check. The persisted scenario always comes from the deterministic engine.
 */
export class CounterfactualService implements CounterfactualPort {
  private readonly replays = new ReplayLoader();
  private readonly hindsightChecks = new LruCache<HindsightCheck>(
    HINDSIGHT_CACHE_ENTRIES,
    HINDSIGHT_TTL_MS,
  );

  // ------------------------------------------------------------ generation

  async runForFork(
    ctx: RequestContext,
    caseId: string,
    forkId: string,
    strategies: readonly CounterfactualStrategy[] = COUNTERFACTUAL_STRATEGIES,
  ): Promise<CounterfactualScenario[]> {
    return this.execute(ctx, caseId, forkId, this.requireStrategies(strategies), noStages);
  }

  async startRun(
    ctx: RequestContext,
    caseId: string,
    forkId: string,
    strategies: readonly CounterfactualStrategy[] = COUNTERFACTUAL_STRATEGIES,
  ): Promise<Job> {
    const ordered = this.requireStrategies(strategies);
    await this.requireEligibleFork(ctx, caseId, forkId);
    const run = await ctx.repos.analysis.getLatestRun(caseId);
    if (run === null) throw new ConflictError('The case has not been analysed yet.');

    // The same request on the same analysis is answered by the job that already ran or is running.
    const baseKey = jobKey(caseId, forkId, ordered, run.id);
    const existing = await ctx.repos.jobs.findByIdempotencyKey('counterfactual', baseKey);
    if (existing !== null && LIVE_JOB.has(existing.status)) return existing;
    const idempotencyKey = existing === null ? baseKey : `${baseKey}:${ctx.newId('try')}`;

    await ctx.audit({
      action: 'counterfactual.run_requested',
      targetType: 'fork',
      targetId: forkId,
      caseId,
      outcome: 'success',
      details: { forkId, strategies: ordered, analysisRunId: run.id },
    });
    return ctx.services.jobs.start(
      ctx,
      { kind: 'counterfactual', caseId, targetId: forkId, idempotencyKey, stages: RUN_STAGES },
      async (handle, jobCtx) => {
        await this.execute(jobCtx, caseId, forkId, ordered, handleReporter(handle));
        return { resultRef: { type: 'fork', id: forkId } };
      },
    );
  }

  async ensureScenarios(ctx: RequestContext, caseId: string): Promise<CounterfactualScenario[]> {
    await this.requireCase(ctx, caseId);
    const stored = await ctx.repos.counterfactuals.list(caseId);
    if ((await ctx.repos.analysis.getLatestRun(caseId)) === null) return stored;

    const forks = await ctx.repos.analysis.listForks(caseId);
    let generated = false;
    for (const { fork, strategies } of defaultScenarioPlan(forks)) {
      const have = new Set(
        stored
          .filter((scenario) => scenario.forkId === fork.id)
          .map((scenario) => scenario.strategy),
      );
      const missing = strategies.filter((strategy) => !have.has(strategy));
      if (missing.length === 0) continue;
      await this.execute(ctx, caseId, fork.id, missing, noStages);
      generated = true;
    }
    return generated ? ctx.repos.counterfactuals.list(caseId) : stored;
  }

  // ------------------------------------------------------------ reads

  async list(
    ctx: RequestContext,
    caseId: string,
    filter: { readonly forkId?: string | undefined } = {},
  ): Promise<CounterfactualScenario[]> {
    await this.requireCase(ctx, caseId);
    return ctx.repos.counterfactuals.list(caseId, { forkId: filter.forkId });
  }

  async get(
    ctx: RequestContext,
    caseId: string,
    scenarioId: string,
  ): Promise<CounterfactualScenario> {
    const scenario = await ctx.repos.counterfactuals.get(caseId, scenarioId);
    if (scenario === null) throw new NotFoundError('Counterfactual scenario', scenarioId);
    return scenario;
  }

  // ------------------------------------------------------------ review and hindsight

  review(
    ctx: RequestContext,
    caseId: string,
    scenarioId: string,
    input: ReviewCounterfactualBody,
  ): Promise<CounterfactualScenario> {
    return reviewScenario(ctx, caseId, scenarioId, input);
  }

  /**
   * The hindsight comparison is a separate, clearly labelled result computed after generation from
   * the full record. The engine is deterministic, so it is recomputed on demand (and cached briefly)
   * rather than stored, and it is only offered for a scenario the engine still reproduces exactly.
   */
  async hindsight(
    ctx: RequestContext,
    caseId: string,
    scenarioId: string,
  ): Promise<HindsightCheck> {
    const scenario = await this.get(ctx, caseId, scenarioId);
    const key = [
      ctx.scope.tenantId,
      caseId,
      scenario.id,
      scenario.version,
      scenario.analysisRunId,
    ].join('|');
    const nowMs = ctx.now().getTime();
    const cached = this.hindsightChecks.get(key, nowMs);
    if (cached !== undefined) return cached;

    const replay = await this.replays.load(ctx, caseId);
    const fork = replay.analysis.forks.find((candidate) => candidate.id === scenario.forkId);
    const generated =
      fork === undefined ? null : generateForFork(replay, fork, [scenario.strategy]);
    const regenerated = generated?.scenarios[0];
    const check = generated?.hindsight[0];
    if (
      regenerated === undefined ||
      check === undefined ||
      !sameSimulation(regenerated, scenario)
    ) {
      throw new ConflictError(
        'The stored scenario no longer matches the engine output for the current analysis. Re-run the counterfactual before asking for hindsight.',
      );
    }
    const result: HindsightCheck = { ...check, computedAt: ctx.now().toISOString() };
    this.hindsightChecks.set(key, result, nowMs);
    return result;
  }

  // ------------------------------------------------------------ internals

  private requireStrategies(
    strategies: readonly CounterfactualStrategy[],
  ): CounterfactualStrategy[] {
    const ordered = orderStrategies(strategies);
    if (ordered.length === 0) {
      throw new ValidationFailedError('Choose at least one strategy', [
        { path: 'strategies', message: 'At least one counterfactual strategy is required' },
      ]);
    }
    return ordered;
  }

  private async requireCase(ctx: RequestContext, caseId: string): Promise<void> {
    if ((await ctx.repos.cases.get(caseId)) === null) throw new NotFoundError('Case', caseId);
  }

  /** 404 for an unknown case or fork (also across tenants), 409 with the engine's reasons when ineligible. */
  private async requireEligibleFork(
    ctx: RequestContext,
    caseId: string,
    forkId: string,
  ): Promise<DecisionFork> {
    await this.requireCase(ctx, caseId);
    const fork = await ctx.repos.analysis.getFork(caseId, forkId);
    if (fork === null) throw new NotFoundError('Decision fork', forkId);
    if (!fork.eligibility.eligible) throw new ConflictError(ineligibleMessage(fork));
    return fork;
  }

  private async execute(
    ctx: RequestContext,
    caseId: string,
    forkId: string,
    strategies: readonly CounterfactualStrategy[],
    report: StageReporter,
  ): Promise<CounterfactualScenario[]> {
    await report('load', 'Loading the stored analysis and the decision moment');
    const stored = await this.requireEligibleFork(ctx, caseId, forkId);
    const replay = await this.replays.load(ctx, caseId);
    // The engine is deterministic: the fork it derives now must be the stored one. A different fork
    // means the governed configuration changed after the analysis ran.
    const fork = replay.analysis.forks.find(
      (candidate) => candidate.id === forkId && candidate.eventId === stored.eventId,
    );
    if (fork === undefined) {
      throw new ConflictError(
        'The stored analysis no longer matches the engine output for this fork (the governed configuration changed). Run the analysis again first.',
      );
    }

    await report(
      'simulate',
      `Simulating ${strategies.length} strateg${strategies.length === 1 ? 'y' : 'ies'} from the decision moment`,
    );
    const generated = generateForFork(replay, fork, strategies);

    await report('validate', 'Validating each path with the counterfactual simulator task');
    const prepared: CounterfactualScenario[] = [];
    let tokens: ReadonlySet<string> | null = null;
    for (const scenario of generated.scenarios) {
      const run = await runSimulatorTask(ctx, replay, fork, scenario.strategy);
      prepared.push(
        finalizeScenario({
          scenario,
          run,
          fork,
          pack: replay.inputs.pack,
          futureTokens: () => (tokens ??= futureTokensFor(replay.inputs, fork)),
        }),
      );
    }

    await report('save', `Saving ${prepared.length} scenario${prepared.length === 1 ? '' : 's'}`);
    const existing = await ctx.repos.counterfactuals.list(caseId, { forkId });
    const toSave = prepared.map((scenario) => {
      const before = existing.find((candidate) => candidate.id === scenario.id);
      return before === undefined ? scenario : carryReview(before, scenario);
    });
    const leakFailures = toSave.filter((scenario) => !scenario.boundary.leakCheck.passed).length;
    await ctx.repos.transaction(async (tx) => {
      await tx.counterfactuals.saveScenarios(toSave);
      await ctx.audit(
        {
          action: 'counterfactual.generated',
          targetType: 'fork',
          targetId: forkId,
          caseId,
          outcome: 'success',
          details: {
            forkId,
            analysisRunId: replay.run.id,
            strategies,
            scenarios: toSave.length,
            rejected: toSave.filter((scenario) => scenario.status === 'rejected').length,
            leakChecksFailed: leakFailures,
            modelExecutions: toSave.filter((scenario) => scenario.modelExecutionId !== null).length,
          },
        },
        tx,
      );
    });
    if (leakFailures > 0) ctx.metrics.recordLeakCheckFailure(leakFailures);

    const ids = new Set(toSave.map((scenario) => scenario.id));
    const saved = await ctx.repos.counterfactuals.list(caseId, { forkId });
    return saved.filter((scenario) => ids.has(scenario.id));
  }
}

function handleReporter(handle: JobHandle): StageReporter {
  return (stageId, detail) => handle.stage(stageId, detail);
}

export function createCounterfactualService(_deps: ServiceDeps): CounterfactualPort {
  return new CounterfactualService();
}
