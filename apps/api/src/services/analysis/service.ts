import type { StartAnalysisResponse } from '@caseguard/schemas';
import { sha256Hex } from '@caseguard/security';
import type { RequestContext } from '../../http/request-context';
import type { ServiceDeps } from '..';
import { planReviewCarry, recordReviewResets } from '../counterfactuals/carry';
import { runAnalysisAgents } from './agents';
import { carryApplications } from './carry';
import { computeAnalysis, type AnalysisComputation, type StageReporter } from './compute';
import { ENGINE_VERSION, computeInputHash, engineContextFor, loadAnalysisInputs } from './inputs';
import { buildSnapshot } from './snapshot';
import type { AnalysisOutcome, AnalysisPort, AnalyzeOptions, JobHandle, JobSpec } from '../ports';

const STAGES: JobSpec['stages'] = [
  { id: 'load', label: 'Load the case record' },
  { id: 'analyse', label: 'Classify evidence and rank hypotheses' },
  { id: 'counterfactuals', label: 'Simulate alternative paths' },
  { id: 'assess', label: 'Score quality, effort and efficiency' },
  { id: 'warnings', label: 'Replay live quality warnings' },
  { id: 'skills', label: 'Match SkillDNA' },
  { id: 'agents', label: 'Run and validate AI agents' },
  { id: 'save', label: 'Save results' },
];

const noStages: StageReporter = () => Promise.resolve();

const LIVE_JOB = new Set(['queued', 'running', 'succeeded']);

/** Job idempotency keys are capped at 120 characters, so the case id and input hash are folded into one digest. */
function jobKey(caseId: string, inputHash: string): string {
  return `analysis:${sha256Hex(`${caseId}:${inputHash}`).slice(0, 48)}`;
}

/**
 * Runs the whole analysis of a case and stores it. Identical input is never re-run (the input hash
 * covers the stored payload, pack, governed configuration, skill library, engine version and
 * provider), a repeat call reuses the stored run, and `force` re-runs it on purpose.
 */
export class AnalysisService implements AnalysisPort {
  constructor(private readonly deps: ServiceDeps) {}

  async analyzeCase(
    ctx: RequestContext,
    caseId: string,
    options: AnalyzeOptions = {},
  ): Promise<AnalysisOutcome> {
    return this.execute(ctx, caseId, options, noStages);
  }

  async startAnalysis(
    ctx: RequestContext,
    caseId: string,
    options: AnalyzeOptions = {},
  ): Promise<StartAnalysisResponse> {
    const inputs = await loadAnalysisInputs(ctx, caseId);
    const provider = await this.providerIdentity(ctx);
    const hash = computeInputHash(inputs, provider);
    const baseKey = jobKey(caseId, hash);
    const { jobs } = ctx.services;

    const existingRun = options.force
      ? null
      : await ctx.repos.analysis.findRunByInputHash(caseId, hash);
    const existingJob = await ctx.repos.jobs.findByIdempotencyKey('case_analysis', baseKey);

    if (existingRun !== null) {
      const job =
        existingJob ??
        (await jobs.runToCompletion(
          ctx,
          {
            kind: 'case_analysis',
            caseId,
            idempotencyKey: baseKey,
            stages: [{ id: 'reuse', label: 'Reuse the existing analysis' }],
          },
          async (handle) => {
            await handle.stage(
              'reuse',
              'The input is identical, so the stored analysis was reused',
            );
            return { resultRef: { type: 'analysis_run', id: existingRun.id } };
          },
        ));
      return { job, runId: existingRun.id, reused: true };
    }

    // A queued or running job for the same input is the answer; a failed one may be retried.
    if (!options.force && existingJob !== null && LIVE_JOB.has(existingJob.status)) {
      return { job: existingJob, runId: null, reused: false };
    }

    await ctx.repos.cases.setAnalysisState(caseId, 'queued');
    const idempotencyKey =
      existingJob === null && !options.force ? baseKey : `${baseKey}:${ctx.newId('try')}`;
    const job = await jobs.start(
      ctx,
      { kind: 'case_analysis', caseId, idempotencyKey, stages: STAGES },
      async (handle, jobCtx) => {
        const outcome = await this.execute(
          jobCtx,
          caseId,
          { force: true },
          handleReporter(handle),
          handle,
        );
        return { resultRef: { type: 'analysis_run', id: outcome.run.id } };
      },
    );
    return { job, runId: null, reused: false };
  }

  // ------------------------------------------------------------ internals

  private async providerIdentity(ctx: RequestContext): Promise<{ kind: string; model: string }> {
    const status = await ctx.services.ai.status(ctx);
    return { kind: status.kind, model: status.model };
  }

  private async execute(
    ctx: RequestContext,
    caseId: string,
    options: AnalyzeOptions,
    report: StageReporter,
    handle?: JobHandle,
  ): Promise<AnalysisOutcome> {
    await report('load', 'Reading the stored case record');
    const inputs = await loadAnalysisInputs(ctx, caseId);
    const status = await ctx.services.ai.status(ctx);
    const hash = computeInputHash(inputs, { kind: status.kind, model: status.model });

    if (options.force !== true) {
      const existing = await ctx.repos.analysis.findRunByInputHash(caseId, hash);
      if (existing !== null) return { run: existing, reused: true };
    }

    const startedAt = ctx.now().toISOString();
    await ctx.repos.cases.setAnalysisState(caseId, 'running');
    try {
      const runId = ctx.newId('run');
      const engineCtx = engineContextFor({
        tenantId: ctx.scope.tenantId,
        caseId,
        runId,
        startedAt,
        inputHash: hash,
      });

      const computation = await computeAnalysis(inputs, engineCtx, async (stageId, detail) => {
        handle?.throwIfCancelled();
        await report(stageId, detail);
        // Each stage is synchronous engine work: let queued requests run between them.
        await new Promise<void>((resolve) => setImmediate(resolve));
      });

      await report('agents', 'Running agents and validating their proposals');
      const executions = await runAnalysisAgents(ctx, inputs, computation, engineCtx);
      handle?.throwIfCancelled();

      await report('save', 'Saving the analysis');
      // What people recorded about the previous run is not recomputed: it is carried onto the new one.
      const previousMatches = await ctx.repos.skills.listMatchesForCase(caseId);
      const withApplications: AnalysisComputation = {
        ...computation,
        skillMatches: {
          ...computation.skillMatches,
          matches: carryApplications({
            fresh: computation.skillMatches.matches,
            previous: previousMatches,
            inputs,
            analysis: computation.analysis,
          }),
        },
      };
      const completedAt = ctx.now().toISOString();
      const snapshot = buildSnapshot({
        ctx,
        inputs,
        computation: withApplications,
        executions,
        runId,
        inputHash: hash,
        startedAt,
        completedAt,
        provider: status,
        engineVersion: ENGINE_VERSION,
      });
      await ctx.repos.transaction(async (tx) => {
        await tx.analysis.saveSnapshot(snapshot);
        // Read after the snapshot took the case lock, so a decision recorded a moment ago is the one
        // carried. A reviewer's decision survives when the regenerated simulation is the same and is
        // reset (and audited) when the engine or its inputs changed it.
        const plan = planReviewCarry(await tx.counterfactuals.list(caseId), computation.scenarios);
        await tx.counterfactuals.saveScenarios(plan.scenarios);
        await recordReviewResets(ctx, tx, { caseId, analysisRunId: runId, reset: plan.reset });
        await ctx.audit(
          {
            action: 'analysis.completed',
            targetType: 'case',
            targetId: caseId,
            caseId,
            outcome: 'success',
            details: {
              runId,
              forks: snapshot.run.counts.forks,
              claims: snapshot.run.counts.claims,
              scenarios: computation.scenarios.length,
              reviewsCarried: plan.carried.length,
              reviewsReset: plan.reset.length,
              provider: status.kind,
              simulated: status.simulated,
            },
          },
          tx,
        );
      });
      return { run: snapshot.run, reused: false };
    } catch (error) {
      // A cancelled or failed run leaves the previous results in place, so the case keeps showing them.
      const previous = await ctx.repos.analysis.getLatestRun(caseId).catch(() => null);
      await ctx.repos.cases
        .setAnalysisState(caseId, previous === null ? 'failed' : 'analyzed')
        .catch((stateError: unknown) =>
          ctx.logger.warn({ err: stateError }, 'could not record the analysis state'),
        );
      throw error;
    }
  }
}

function handleReporter(handle: JobHandle): StageReporter {
  return (stageId, detail) => handle.stage(stageId, detail);
}

export function createAnalysisService(deps: ServiceDeps): AnalysisPort {
  return new AnalysisService(deps);
}
