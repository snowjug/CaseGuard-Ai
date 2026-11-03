import type { AgentName } from '@caseguard/schemas';
import type { AgentOutputs } from '../../agents/outputs';
import type { AgentTask, AgentTaskOf, TaskInputs } from '../../agents/tasks';
import { ProviderError } from '../../errors';
import { DETERMINISTIC_MODEL, type TokenGovernor } from '../../governor/token-governor';
import {
  systemClock,
  type Clock,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderDescriptor,
} from '../../types';
import { estimateTokens } from '../../util/text';
import {
  runEvidenceClassifier,
  runForkDetector,
  runHypothesisGenerator,
  runTimelineAnalyzer,
} from './analysis-handlers';
import { runSafetyValidator, runTokenGovernor } from './control-handlers';
import { runCounterfactualSimulator } from './counterfactual-handler';
import { runCaseCritic, runCaseReasoner } from './reasoning-handlers';
import { runCommunicationCoach, runQualityJudge } from './review-handlers';
import { runSkillExtractor } from './skill-handler';

/** Lets the API layer plug in richer domain engines (quality, coaching, skills) as they land. */
export type HandlerOverrides = {
  [A in AgentName]?: (input: TaskInputs[A]) => AgentOutputs[A];
};

export interface DeterministicProviderOptions {
  clock?: Clock;
  /** Required only for `token_governor` tasks. */
  governor?: TokenGovernor | null;
  overrides?: HandlerOverrides;
}

export interface DeterministicRunOptions {
  governor?: TokenGovernor | null;
  overrides?: HandlerOverrides | undefined;
}

function dispatch(task: AgentTask, options: DeterministicRunOptions): unknown {
  const override = options.overrides?.[task.agent] as ((input: unknown) => unknown) | undefined;
  if (override) return override(task.input);
  switch (task.agent) {
    case 'timeline_analyzer':
      return runTimelineAnalyzer(task.input);
    case 'evidence_classifier':
      return runEvidenceClassifier(task.input);
    case 'hypothesis_generator':
      return runHypothesisGenerator(task.input);
    case 'decision_fork_detector':
      return runForkDetector(task.input);
    case 'counterfactual_simulator':
      return runCounterfactualSimulator(task.input);
    case 'quality_judge':
      return runQualityJudge(task.input);
    case 'skilldna_extractor':
      return runSkillExtractor(task.input);
    case 'communication_coach':
      return runCommunicationCoach(task.input);
    case 'token_governor':
      if (!options.governor) {
        throw new ProviderError(
          'not_configured',
          'The token governor task needs a governor instance.',
        );
      }
      return runTokenGovernor(task.input, options.governor);
    case 'safety_policy_validator':
      return runSafetyValidator(task.input);
    case 'case_reasoner':
      return runCaseReasoner(task.input);
    case 'case_critic':
      return runCaseCritic(task.input);
  }
}

/** Runs the domain-backed implementation of one agent task. Pure apart from the supplied governor. */
export function runDeterministicTask<A extends AgentName>(
  task: AgentTaskOf<A>,
  options: DeterministicRunOptions = {},
): AgentOutputs[A] {
  return dispatch(task as AgentTask, options) as AgentOutputs[A];
}

/**
 * The default provider: fully offline and reproducible. Every output comes from the real domain
 * engine (or deterministic code) and is labelled simulated, with token counts estimated from text
 * length (assumption A-07). It is also the graceful-degradation target for every remote failure.
 */
export class DeterministicProvider implements ModelProvider {
  readonly kind = 'deterministic' as const;
  readonly simulated = true;
  readonly defaultModel = DETERMINISTIC_MODEL;
  private readonly clock: Clock;

  constructor(private readonly options: DeterministicProviderOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  describe(): ProviderDescriptor {
    return {
      kind: 'deterministic',
      simulated: true,
      model: DETERMINISTIC_MODEL,
      configured: true,
      validationNote:
        'Deterministic knowledge-pack provider: fully offline, reproducible, and exercised by the automated tests. Outputs and token counts are simulated or estimated and labelled as such.',
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = this.clock.nowMs();
    if (request.signal?.aborted) {
      throw new ProviderError('cancelled', 'The request was cancelled.');
    }
    const output = dispatch(request.task, {
      governor: this.options.governor ?? null,
      overrides: this.options.overrides,
    });
    const completionTokens = estimateTokens(JSON.stringify(output));
    const promptTokens = estimateTokens(request.messages.map((m) => m.content).join('\n'));
    return {
      output,
      outputText: null,
      parseError: null,
      usage: {
        promptTokens,
        completionTokens,
        cachedTokens: 0,
        totalTokens: promptTokens + completionTokens,
        source: 'estimated',
      },
      model: DETERMINISTIC_MODEL,
      provider: 'deterministic',
      latencyMs: Math.max(0, this.clock.nowMs() - started),
      simulated: true,
      finishReason: 'stop',
      retries: 0,
      attempts: 1,
    };
  }
}
