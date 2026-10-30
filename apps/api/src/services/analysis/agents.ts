import { AiTaskError, type AgentTask, type TaskBase } from '@caseguard/ai';
import { createFullView, createTemporalView, type EngineContext } from '@caseguard/domain';
import type { ModelExecutionWithUsage } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import type { AnalysisComputation } from './compute';
import type { AnalysisInputs } from './inputs';

/**
 * The agents an analysis runs. They read the analysis and propose wording and judgements; the
 * orchestrator validates every proposal (schema, citations, temporal boundary, safety policy,
 * grounding, injection) and falls back to deterministic code when it is not acceptable. The numbers
 * and structures the product shows always come from the engine, so these runs add provenance and
 * token accounting; they never overwrite engine output.
 */
export async function runAnalysisAgents(
  ctx: RequestContext,
  inputs: AnalysisInputs,
  computation: AnalysisComputation,
  engineCtx: EngineContext,
): Promise<ModelExecutionWithUsage[]> {
  const { events, resolution, pack, actionConfig, caseRecord } = inputs;
  const lastEventAt = events[events.length - 1]?.timestamp ?? caseRecord.openedAt;

  const base = (view: TaskBase['view'], withHindsight: boolean): TaskBase => ({
    tenantId: ctx.scope.tenantId,
    caseId: caseRecord.id,
    analysisRunId: engineCtx.runId,
    view,
    pack,
    config: actionConfig,
    ctx: engineCtx,
    analysis: computation.analysis,
    hindsight: withHindsight ? { events, resolution } : undefined,
  });

  // Reasoning agents see the record up to the last event, never the resolution.
  const preResolution = createTemporalView(events, lastEventAt);
  // Review agents judge the finished case.
  const fullView = createFullView(events, resolution);

  const tasks: AgentTask[] = [
    { agent: 'timeline_analyzer', input: base(preResolution, true) },
    { agent: 'evidence_classifier', input: base(preResolution, true) },
    { agent: 'hypothesis_generator', input: base(preResolution, true) },
    { agent: 'decision_fork_detector', input: base(preResolution, true) },
    { agent: 'quality_judge', input: base(fullView, false) },
    { agent: 'communication_coach', input: base(fullView, false) },
  ];

  const executions: ModelExecutionWithUsage[] = [];
  for (const task of tasks) {
    try {
      const result = await ctx.services.ai.run(ctx, { task }, { persist: false });
      executions.push(result.modelExecution);
    } catch (error) {
      // A failed or cancelled attempt still cost tokens and time: its record travels with the error.
      if (error instanceof AiTaskError && error.execution !== null)
        executions.push(error.execution);
      // The deterministic analysis is the product; a failed proposal must not block it.
      ctx.logger.warn({ err: error, agent: task.agent }, 'agent run failed; analysis continues');
    }
  }
  return executions;
}
