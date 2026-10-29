import type {
  ActionValueConfig,
  CaseEvent,
  CaseResolution,
  CounterfactualStrategy,
  DecisionFork,
} from '@caseguard/schemas';
import {
  createTemporalViewBeforeEvent,
  type CompiledPack,
  type DeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import type { AgentTaskOf } from './tasks';

export interface CounterfactualTaskParams {
  tenantId: string;
  caseId: string | null;
  analysisRunId: string | null;
  analysis: DeterministicAnalysis;
  fork: DecisionFork;
  strategy: CounterfactualStrategy;
  /** Full event log and resolution: used by the deterministic domain call and the leak guard only. */
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  rolloutCount?: number;
}

/**
 * Builds a counterfactual task whose model-visible window is exactly the decision moment of the
 * fork: everything strictly before the fork event, never the resolution.
 */
export function counterfactualTask(
  params: CounterfactualTaskParams,
): AgentTaskOf<'counterfactual_simulator'> {
  const view = createTemporalViewBeforeEvent(params.events, params.fork.eventId);
  return {
    agent: 'counterfactual_simulator',
    input: {
      tenantId: params.tenantId,
      caseId: params.caseId,
      analysisRunId: params.analysisRunId,
      view,
      pack: params.pack,
      config: params.config,
      ctx: params.ctx,
      analysis: params.analysis,
      hindsight: { events: params.events, resolution: params.resolution },
      fork: params.fork,
      strategy: params.strategy,
      events: params.events,
      resolution: params.resolution,
      rolloutCount: params.rolloutCount,
    },
  };
}
