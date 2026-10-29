import {
  counterfactualTask,
  projectScenario,
  type CounterfactualProposal,
  type ResultSource,
} from '@caseguard/ai';
import {
  createTemporalViewBeforeEvent,
  futureOnlyTokens,
  packStaticTokens,
  scanForLeaks,
  type CompiledPack,
} from '@caseguard/domain';
import type {
  CounterfactualScenario,
  CounterfactualStrategy,
  DecisionFork,
} from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import type { AnalysisInputs } from '../analysis';
import type { CaseReplay } from './replay';

/** What running the `counterfactual_simulator` task produced for one strategy. */
export interface SimulatorRun {
  readonly strategy: CounterfactualStrategy;
  /** The persisted, validated execution record (hashes and metadata only). Null when none exists. */
  readonly modelExecutionId: string | null;
  readonly source: ResultSource | null;
  readonly proposal: CounterfactualProposal | null;
}

/** Longest rationale a stored step holds (`CounterfactualStepSchema.rationale`). */
const MAX_RATIONALE_CHARS = 900;

/**
 * Runs the counterfactual task through the orchestrator ("LLM proposes, code disposes"): the model-
 * visible window is exactly the decision moment, the output is validated (schema, citations,
 * temporal boundary, safety policy, grounding, injection) and the execution record and token usage
 * are persisted. A task failure never blocks the scenario, which always comes from the engine; only
 * cancellation propagates.
 */
export async function runSimulatorTask(
  ctx: RequestContext,
  replay: CaseReplay,
  fork: DecisionFork,
  strategy: CounterfactualStrategy,
): Promise<SimulatorRun> {
  const { inputs, run, analysis, engineCtx } = replay;
  try {
    const task = counterfactualTask({
      tenantId: ctx.scope.tenantId,
      caseId: inputs.caseRecord.id,
      analysisRunId: run.id,
      analysis,
      fork,
      strategy,
      events: inputs.events,
      resolution: inputs.resolution,
      pack: inputs.pack,
      config: inputs.actionConfig,
      ctx: engineCtx,
    });
    const result = await ctx.services.ai.run(ctx, { task });
    return {
      strategy,
      modelExecutionId: result.modelExecution.id,
      source: result.source,
      proposal: result.result,
    };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.logger.warn(
      { err: error, agent: 'counterfactual_simulator', strategy },
      'the counterfactual task failed; the engine result is stored without a model execution',
    );
    return { strategy, modelExecutionId: null, source: null, proposal: null };
  }
}

/** Identifiers that first appear after the decision moment or in the resolution (hindsight only). */
export function futureTokensFor(
  inputs: Pick<AnalysisInputs, 'events' | 'resolution' | 'pack'>,
  fork: DecisionFork,
): Set<string> {
  const { events, resolution, pack } = inputs;
  const resolutionText = resolution
    ? `${resolution.summary} ${resolution.rootCause} ${resolution.workaround ?? ''} ${resolution.permanentFix ?? ''}`
    : '';
  return futureOnlyTokens(
    events,
    createTemporalViewBeforeEvent(events, fork.eventId),
    resolutionText,
    packStaticTokens(pack),
  );
}

export interface FinalizeInput {
  readonly scenario: CounterfactualScenario;
  readonly run: SimulatorRun;
  readonly fork: DecisionFork;
  readonly pack: CompiledPack;
  /** Computed lazily: only needed when a model proposal offers its own wording. */
  readonly futureTokens: () => ReadonlySet<string>;
}

/**
 * The scenario that is persisted: always the engine's, linked to the execution that validated it.
 * A proposal that came from a model (or its cache) may contribute wording only: the rationale of a
 * step the engine also produced (same position and action), and only when that wording differs from
 * the engine's own projection and mentions no identifier from after the decision moment. Numbers,
 * ids, evidence, outcomes, safety flags, status and the leak and validity checks are never replaced.
 */
export function finalizeScenario(input: FinalizeInput): CounterfactualScenario {
  const { scenario, run, fork, pack } = input;
  const linked: CounterfactualScenario = { ...scenario, modelExecutionId: run.modelExecutionId };
  const { proposal, source } = run;
  if (proposal === null || (source !== 'model' && source !== 'cache')) return linked;
  if (proposal.strategy !== scenario.strategy || proposal.forkEventId !== fork.eventId) {
    return linked;
  }

  const engineWording = projectScenario(scenario, { fork, strategy: scenario.strategy, pack });
  let future: ReadonlySet<string> | null = null;
  const steps = linked.steps.map((step) => {
    const offered = proposal.steps.find(
      (candidate) => candidate.order === step.index + 1 && candidate.actionKey === step.actionKey,
    );
    const text = offered?.rationale.trim() ?? '';
    if (offered === undefined || text.length === 0) return step;
    const own = engineWording.steps.find((candidate) => candidate.order === step.index + 1);
    if (own?.rationale === offered.rationale) return step;
    future ??= input.futureTokens();
    if (scanForLeaks([text], future).length > 0) return step;
    return { ...step, rationale: text.slice(0, MAX_RATIONALE_CHARS) };
  });
  return { ...linked, steps };
}
